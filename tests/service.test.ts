import { dshRoot } from './dsh-root.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FileArtifactStore, ForgeCompiler, ForgeError, createForgeHandler, loadDshLowerer, parseBuildRequest, sha256, startForgeServer,
} from '../src/index.js'
import type { BuildRequest, BuildTarget, PackageResolver } from '../src/index.js'

const target: BuildTarget = { protocol: 1, generation: 'dsh-worker-1', hostPackages: { '@deepseek-ai/cordis': '4.0.0' } }
const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
const request = (source = 'export const name = "fixture"; export const apply = () => "v1"'): BuildRequest => ({ protocol: 1, generation: target.generation, plugin: { id: 'fixture', name: 'fixture', version: '1.0.0', entry: 'src/index.ts', files: { 'src/index.ts': source }, dependencies: {}, peerDependencies: {} } })
const noDependencies: PackageResolver = { async prepare() {}, async resolve() { throw new Error('Unexpected dependency') } }

async function setup(t: { after(fn: () => Promise<void>): void }, resolver = noDependencies) {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new FileArtifactStore(join(root, 'objects'))
  const work = join(root, 'work'); await mkdir(work)
  const compiler = new ForgeCompiler({ target, resolver, store, lowerModule, temporaryRoot: work })
  return { root, work, store, compiler }
}

test('content-addressed store rejects traversal, mismatched writes and corrupt objects', async t => {
  const { root, store } = await setup(t)
  const data = new TextEncoder().encode('hello')
  const key = `${target.generation}/objects/${sha256(data)}`
  await Promise.all(Array.from({ length: 8 }, () => store.put(key, data)))
  assert.deepEqual(new Uint8Array((await store.get(key))!), data)
  assert.equal(await store.get(`${target.generation}/objects/${'0'.repeat(64)}`), undefined)
  await assert.rejects(store.get('../secrets'), { code: 'INVALID_OBJECT_KEY' })
  await assert.rejects(store.put(key, new Uint8Array([1])), { code: 'ARTIFACT_HASH_MISMATCH' })
  await writeFile(join(root, 'objects', key), 'corrupted')
  await assert.rejects(store.get(key), { code: 'ARTIFACT_CORRUPT' })
})

test('TS source compiles with the real Worker transformer, stable revisions, and temporary cleanup', async t => {
  const { compiler, store, work } = await setup(t)
  const input = request('const value: string = "v1"; export const apply = async () => { await Promise.resolve(); return value }')
  const built = await compiler.build(input)
  const again = await compiler.build(input)
  assert.deepEqual(built, again)
  assert.equal(built.packages.length, 1)
  const file = built.packages[0]!.files[0]!
  const text = new TextDecoder().decode(await store.get(file.objectKey))
  assert.ok(text.includes('__als'), 'Async code must use the actual Worker suspension transform')
  assert.ok(!text.includes(': string'))
  assert.deepEqual(await readdir(work), [])
  input.plugin.files['src/index.ts'] = 'export const apply = () => "v2"'
  assert.notEqual((await compiler.build(input)).revision, built.revision)
})

test('dependency packages remain external and are compiled once per actual package instance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-dependency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dependency = join(root, 'dependency'); await mkdir(dependency)
  await writeFile(join(dependency, 'index.js'), 'module.exports = value => value * 2')
  const resolver: PackageResolver = { async prepare() {}, async resolve(name) { return { directory: dependency, entry: join(dependency, 'index.js'), name, version: '1.0.0', dependencies: {}, peerDependencies: {} } } }
  const { compiler, store } = await setup(t, resolver)
  const input = request('import double from "double-fixture"; export const apply = () => double(4)')
  input.plugin.dependencies = { 'double-fixture': '^1.0.0' }
  const result = await compiler.build(input)
  assert.equal(result.packages.length, 2)
  const plugin = result.packages.find(pkg => pkg.id === result.plugin.packageId)!
  const dependencyPackage = result.packages.find(pkg => pkg.name === 'double-fixture')!
  assert.equal(plugin.dependencies['double-fixture'], dependencyPackage.id)
  const text = new TextDecoder().decode(await store.get(plugin.files[0]!.objectKey))
  assert.match(text, /require\("double-fixture"\)/)
  assert.ok(!text.includes('value * 2'))
})

test('host requirements use exact shared versions and cannot replace the core', async t => {
  const { compiler } = await setup(t)
  const input = request('import { Context } from "@deepseek-ai/cordis"; export const apply = () => Context')
  input.plugin.peerDependencies = { '@deepseek-ai/cordis': '^4.0.0' }
  const manifest = await compiler.build(input)
  assert.deepEqual(manifest.hostPackages, { '@deepseek-ai/cordis': '4.0.0' })
  assert.deepEqual(manifest.packages[0]!.dependencies, {})
  input.plugin.peerDependencies['@deepseek-ai/cordis'] = '^3.0.0'
  await assert.rejects(compiler.build(input), { code: 'HOST_VERSION_MISMATCH' })
  input.plugin.name = '@deepseek-ai/cordis'
  await assert.rejects(compiler.build(input), { code: 'CORE_PACKAGE_PROTECTED' })
})

test('invalid generation, paths, compiler failures, native and computed imports fail without leaving workspace files', async t => {
  const { compiler, work } = await setup(t)
  const wrongGeneration = request(); wrongGeneration.generation = 'other'
  await assert.rejects(compiler.build(wrongGeneration), { code: 'GENERATION_MISMATCH' })
  const traversal = request(); traversal.plugin.files['../escape.ts'] = 'evil'
  assert.throws(() => parseBuildRequest(traversal), { code: 'INVALID_REQUEST' })
  for (const [source, code] of [
    ['export function broken(', 'COMPILE_FAILED'],
    ['const net = require("node:net"); exports.apply = () => net', 'NODE_MODULE_UNSUPPORTED'],
    ['export const apply = name => require(name)', 'DYNAMIC_IMPORT_UNSUPPORTED'],
    ['const load = require; export const apply = name => load(name)', 'DYNAMIC_IMPORT_UNSUPPORTED'],
    ['export { x } from "dependency/subpath"', 'PACKAGE_SUBPATH_UNSUPPORTED'],
    ['export { x } from "undeclared"', 'UNDECLARED_DEPENDENCY'],
  ]) await assert.rejects(compiler.build(request(source)), { code })
  assert.deepEqual(await readdir(work), [])
})

test('real HTTP builds and downloads bytes, validates CORS, generation and body limits', async t => {
  const { compiler, store } = await setup(t)
  const running = await startForgeServer(createForgeHandler({ target, executor: compiler, store, allowedOrigins: ['http://localhost:36935'], maxRequestBytes: 8192, maxConcurrentBuilds: 1 }), { hostname: '127.0.0.1', port: 0 })
  t.after(() => running.close())
  assert.deepEqual(await (await fetch(`${running.url}/v1/target`)).json(), target)
  assert.equal((await fetch(`${running.url}/v1/target`, { headers: { Origin: 'http://evil.invalid' } })).status, 403)
  const response = await fetch(`${running.url}/v1/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:36935' }, body: JSON.stringify(request()) })
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:36935')
  const manifest = await response.json()
  const object = manifest.packages[0].files[0]
  const download = await fetch(`${running.url}/v1/artifacts/${object.objectKey}`)
  assert.equal(download.status, 200)
  assert.equal(sha256(new Uint8Array(await download.arrayBuffer())), object.sha256)
  assert.equal((await fetch(`${running.url}/v1/artifacts/not-an-object`)).status, 400)
  const wrong = request(); wrong.generation = 'other'
  assert.equal((await fetch(`${running.url}/v1/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wrong) })).status, 409)
  assert.equal((await fetch(`${running.url}/v1/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8193) })).status, 413)
})

test('build capacity is released on failure and internal errors do not expose server details', async t => {
  const { store } = await setup(t)
  let unblock: (() => void) | undefined
  const executor = { async build() { await new Promise<void>(resolve => { unblock = resolve }); throw new Error('private-server-path') } }
  const handler = createForgeHandler({ target, executor, store, allowedOrigins: [], maxRequestBytes: 8192, maxConcurrentBuilds: 1 })
  const make = () => new Request('http://localhost/v1/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })
  const first = handler(make())
  while (!unblock) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await handler(make())).status, 503)
  unblock()
  assert.deepEqual(await (await first).json(), { error: { code: 'INTERNAL_ERROR', message: 'Forge could not complete this request' } })
  unblock = undefined
  const next = handler(make())
  while (!unblock) await new Promise(resolve => setImmediate(resolve))
  const release: () => void = unblock; release()
  assert.equal((await next).status, 500)
})

test('equivalent package instances in different installation directories share one manifest identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-instances-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['left', 'right', 'leaf-left', 'leaf-right']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'index.js'), name.startsWith('leaf') ? 'module.exports = "shared"' : 'module.exports = require("leaf")')
  }
  const resolver: PackageResolver = { async prepare() {}, async resolve(name, importer) {
    const directory = join(root, name === 'leaf' ? `leaf-${importer.endsWith('/left') ? 'left' : 'right'}` : name)
    return { directory, entry: join(directory, 'index.js'), name, version: '1.0.0', dependencies: name === 'leaf' ? {} : { leaf: '1.0.0' }, peerDependencies: {} }
  } }
  const { compiler } = await setup(t, resolver)
  const input = request('export const apply = () => [require("left"), require("right")]')
  input.plugin.dependencies = { left: '1.0.0', right: '1.0.0' }
  const manifest = await compiler.build(input)
  assert.equal(manifest.packages.length, 4)
  assert.equal(new Set(manifest.packages.map(pkg => pkg.id)).size, manifest.packages.length)
  assert.equal(manifest.packages.find(pkg => pkg.name === 'left')?.dependencies.leaf, manifest.packages.find(pkg => pkg.name === 'right')?.dependencies.leaf)
})

test('fixed import entries support dual packages while incompatible CommonJS consumers fail explicitly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-conditional-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pkg = join(root, 'node_modules', 'dual'); await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'esm.js'), 'export default () => "value"')
  await writeFile(join(pkg, 'cjs.cjs'), 'module.exports = () => "value"')
  const { PnpmPackageResolver } = await import('../src/resolver.js')
  const resolver = new PnpmPackageResolver({ executable: 'pnpm', timeoutMs: 1000, registry: 'https://registry.npmjs.org/' })
  for (const entry of [
    { exports: { import: './esm.js', require: './cjs.cjs' } },
    { module: './esm.js', main: './cjs.cjs' },
  ]) {
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0', ...entry }))
    const dual = await resolver.resolve('dual', root, root)
    assert.equal(dual.entry, join(pkg, 'esm.js'))
    assert.equal(dual.requireCompatible, false)
    const { compiler } = await setup(t, { async prepare() {}, async resolve() { return dual } })
    const input = request('import value from "dual"; export const apply = value')
    input.plugin.dependencies = { dual: '1.0.0' }
    assert.equal((await compiler.build(input)).packages.length, 2)
    input.plugin.files['src/index.ts'] = 'import value from "dual"; export const apply = value; export const raw = require("dual")'
    await assert.rejects(compiler.build(input), { code: 'PACKAGE_ENTRY_UNSUPPORTED' })
  }
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0', exports: { import: './cjs.cjs', require: './cjs.cjs' } }))
  const shared = await resolver.resolve('dual', root, root)
  assert.equal(shared.entry, join(pkg, 'cjs.cjs'))
  assert.equal(shared.requireCompatible, true)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0', browser: './esm.js', module: './esm.js', main: './cjs.cjs' }))
  assert.equal((await resolver.resolve('dual', root, root)).entry, join(pkg, 'esm.js'))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0', exports: { import: '../outside.js', require: './cjs.cjs' } }))
  await assert.rejects(resolver.resolve('dual', root, root), { code: 'PACKAGE_ENTRY_UNSUPPORTED' })
})

test('Fetch handler can bundle without Node builtins for an edge adapter', async () => {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [resolve('src/http.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  assert.ok(bundle.outputFiles[0]!.text.includes('createForgeHandler'))
  assert.ok(!Object.keys(bundle.metafile.inputs).some(path => path.endsWith('/store.ts') || path.endsWith('/node-server.ts') || path.endsWith('/compiler.ts')))
})

test('opt-in host patch upgrades admit exact stable requests and record the actual fixed host version', async t => {
  const { store } = await setup(t)
  const configuredTarget: BuildTarget = { ...target, hostPackages: { '@deepseek-ai/cordis': '4.0.5' } }
  const options = { target: configuredTarget, store, resolver: noDependencies, lowerModule }
  const input = request('import { Context } from "@deepseek-ai/cordis"; export const apply = () => Context')
  input.plugin.peerDependencies = { '@deepseek-ai/cordis': '4.0.1' }
  await assert.rejects(new ForgeCompiler(options).build(input), { code: 'HOST_VERSION_MISMATCH' })
  const compiler = new ForgeCompiler({ ...options, allowHostPatchUpgrade: ['@deepseek-ai/cordis'] })
  const manifest = await compiler.build(input)
  assert.deepEqual(manifest.hostPackages, { '@deepseek-ai/cordis': '4.0.5' })
  assert.equal(manifest.packages.length, 1)
  assert.deepEqual(manifest.packages[0]!.dependencies, {})
  input.plugin.peerDependencies['@deepseek-ai/cordis'] = '4.0.5'
  assert.deepEqual((await compiler.build(input)).hostPackages, { '@deepseek-ai/cordis': '4.0.5' })
  input.generation = 'another-generation'
  await assert.rejects(compiler.build(input), { code: 'GENERATION_MISMATCH' })
  input.generation = target.generation; input.plugin.name = '@deepseek-ai/cordis'
  await assert.rejects(compiler.build(input), { code: 'CORE_PACKAGE_PROTECTED' })
  assert.throws(() => new ForgeCompiler({ ...options, allowHostPatchUpgrade: ['unavailable-package'] }), /unavailable host package/)
})

test('host patch opt-in preserves range constraints and refuses downgrade, cross-version and prerelease relaxation', async t => {
  const { store } = await setup(t)
  for (const [requested, supplied] of [
    ['4.0.6', '4.0.5'], ['4.0.1', '4.1.0'], ['4.0.1', '5.0.0'],
    ['4.0.1-beta.1', '4.0.5'], ['4.0.1', '4.0.5-beta.1'],
    ['>=4.0.1 <4.0.5', '4.0.5'], ['~4.0.6', '4.0.5'], ['^4.1.0', '4.0.5'], ['=4.0.1', '4.0.5'],
  ]) {
    const compiler = new ForgeCompiler({ target: { ...target, hostPackages: { '@deepseek-ai/cordis': supplied! } }, store, resolver: noDependencies, lowerModule, allowHostPatchUpgrade: ['@deepseek-ai/cordis'] })
    const input = request(); input.plugin.peerDependencies = { '@deepseek-ai/cordis': requested! }
    await assert.rejects(compiler.build(input), { code: 'HOST_VERSION_MISMATCH' }, `${requested} must not admit ${supplied}`)
  }
  const compiler = new ForgeCompiler({ target: { ...target, hostPackages: { '@deepseek-ai/cordis': '4.0.5', 'other-host': '1.0.5' } }, store, resolver: noDependencies, lowerModule, allowHostPatchUpgrade: ['@deepseek-ai/cordis'] })
  const input = request(); input.plugin.peerDependencies = { '@deepseek-ai/cordis': '>=4.0.1 <4.1.0' }
  assert.deepEqual((await compiler.build(input)).hostPackages, { '@deepseek-ai/cordis': '4.0.5' })
  input.plugin.peerDependencies = { 'other-host': '1.0.1' }
  await assert.rejects(compiler.build(input), { code: 'HOST_VERSION_MISMATCH' })
})

test('published package HTTP builds preserve the bundle patch and Client bytes with sanitized metadata', async t => {
  const { PnpmPackageResolver } = await import('../src/resolver.js')
  const actualResolver = new PnpmPackageResolver({ executable: 'pnpm', timeoutMs: 1000, registry: 'https://registry.npmjs.org/' })
  const patch = '# published patch\n- insert:\n    - id: published-plugin\n      name: published-plugin\n'
  const client = 'window.__ModuleLoader__.load({id:"published-plugin",factory:()=>({})})'
  const resolver: PackageResolver = {
    async prepare(directory, dependencies) {
      assert.deepEqual(dependencies, { 'published-plugin': '1.2.3' })
      const pkg = join(directory, 'node_modules', 'published-plugin')
      await mkdir(join(pkg, 'lib'), { recursive: true }); await mkdir(join(pkg, 'client'))
      await writeFile(join(pkg, 'lib/index.js'), 'import { join } from "node:path"; export const name="published-plugin"; export const apply=()=>join("a","b")')
      await writeFile(join(pkg, 'cordis.patch.yml'), patch); await writeFile(join(pkg, 'client/client.js'), client)
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'published-plugin', version: '1.2.3', type: 'module', scripts: { prepack: 'does-not-run' }, repository: { type: 'git', url: 'git+https://example.test/published.git', directory: 'ignored-field' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@deepseek-ai/dsh-client-locale'], platform: 'web' } },
        exports: { '.': { types: './types.d.ts', default: './lib/index.js' }, './client': './client/client.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
      }))
    }, resolve: (...args) => actualResolver.resolve(...args),
    async resolveTag(name, tag) { assert.equal(name, 'published-plugin'); assert.equal(tag, 'latest'); return '1.2.3' },
  }
  const { compiler, store, work } = await setup(t, resolver)
  const handler = createForgeHandler({ target, executor: compiler, store, allowedOrigins: [], maxRequestBytes: 8192, maxConcurrentBuilds: 1 })
  const result = await handler(new Request('http://localhost/v1/packages/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: 'my-plugin', spec: 'published-plugin@1.2.3' }) }))
  assert.equal(result.status, 200)
  const manifest = await result.json()
  const pkg = manifest.packages[0]
  assert.equal(manifest.plugin.id, 'my-plugin'); assert.equal(pkg.entry, 'lib/index.js')
  assert.deepEqual(pkg.metadata, { repository: { url: 'git+https://example.test/published.git' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@deepseek-ai/dsh-client-locale'], platform: 'web' } }, exports: { '.': './lib/index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml', './client': './client/client.js' } })
  assert.deepEqual(pkg.files.map((file: { path: string }) => file.path), ['client/client.js', 'cordis.patch.yml', 'lib/index.js'])
  for (const [path, expected] of [['client/client.js', client], ['cordis.patch.yml', patch]]) {
    const file = pkg.files.find((file: { path: string }) => file.path === path)
    assert.equal(new TextDecoder().decode(await store.get(file.objectKey)), expected)
  }
  const host = pkg.files.find((file: { path: string }) => file.path === pkg.entry)
  assert.match(new TextDecoder().decode(await store.get(host.objectKey)), /require\("node:path"\)/)
  assert.deepEqual(await readdir(work), [])
  const latest = await handler(new Request('http://localhost/v1/packages/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: 'my-plugin', spec: 'published-plugin@latest' }) }))
  assert.equal(latest.status, 200)
  assert.equal((await latest.json()).revision, manifest.revision)
})

test('published package requests reject external locations and protected hosts before installation', async t => {
  const resolver: PackageResolver = { async prepare() { throw new Error('Must reject before installation') }, async resolve() { throw new Error('Must reject before resolution') } }
  const { compiler } = await setup(t, resolver)
  for (const spec of ['../plugin', 'https://example.test/plugin.tgz', 'package@file:../plugin', 'package@npm:other@1.0.0']) {
    await assert.rejects(compiler.buildPackage({ protocol: 1, generation: target.generation, pluginId: 'test', spec }), { code: 'UNSUPPORTED_DEPENDENCY_SPEC' })
  }
  await assert.rejects(compiler.buildPackage({ protocol: 1, generation: 'other', pluginId: 'test', spec: 'ordinary@1.0.0' }), { code: 'GENERATION_MISMATCH' })
  await assert.rejects(compiler.buildPackage({ protocol: 1, generation: target.generation, pluginId: 'test', spec: '@deepseek-ai/cordis@4.0.0' }), { code: 'CORE_PACKAGE_PROTECTED' })
})

test('published bundle validation refuses multiple rows and unsafe asset references', async t => {
  const { readPublishedAssets } = await import('../src/package-assets.js')
  const root = await mkdtemp(join(tmpdir(), 'forge-bundle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n    - { id: one, name: sample }\n    - { id: two, name: sample }\n')
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh: { bundle: { patch: './cordis.patch.yml' } } }), { code: 'BUNDLE_UNSUPPORTED' })
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh: { bundle: { patch: '../outside.yml' } } }), { code: 'BUNDLE_UNSUPPORTED' })
})

test('implemented Worker builtin requests remain external while other system modules fail', async t => {
  const { compiler, store } = await setup(t)
  for (const name of ['child_process', 'fs', 'https', 'os', 'path', 'string_decoder']) {
    const manifest = await compiler.build(request(`export const apply = () => require("node:${name}")`))
    const file = manifest.packages[0]!.files[0]!
    assert.ok(new TextDecoder().decode(await store.get(file.objectKey)).includes(`require("node:${name}")`))
    assert.deepEqual(manifest.packages[0]!.dependencies, {})
  }
  await assert.rejects(compiler.build(request('export const apply = () => require("node:net")')), { code: 'NODE_MODULE_UNSUPPORTED' })
})

test('latest registry resolution pins the reported version and leaves source dependency rules strict', async t => {
  const { PnpmPackageResolver } = await import('../src/resolver.js')
  let metadata: unknown = { version: '2.2.1' }
  const server = await startForgeServer(async request => {
    assert.equal(new URL(request.url).pathname, '/sample/latest')
    return Response.json(metadata)
  }, { hostname: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const resolver = new PnpmPackageResolver({ executable: 'pnpm', registry: server.url + '/', timeoutMs: 1000 })
  assert.equal(await resolver.resolveTag('sample', 'latest'), '2.2.1')
  metadata = { version: 'latest' }
  await assert.rejects(resolver.resolveTag('sample', 'latest'), { code: 'PACKAGE_VERSION_INVALID' })
  const { compiler } = await setup(t)
  const input = request(); input.plugin.dependencies = { sample: 'latest' }
  await assert.rejects(compiler.build(input), { code: 'UNSUPPORTED_DEPENDENCY_SPEC' })
})

test('compiler capabilities follow the actual DSH implemented proxy roster, excluding mocks', async t => {
  assert.ok(lowerModule.implementedBuiltins?.includes('node:crypto'))
  assert.ok(lowerModule.implementedBuiltins?.includes('node:url'))
  assert.ok(!lowerModule.implementedBuiltins?.includes('node:net'))
  assert.ok(!lowerModule.implementedBuiltins?.includes('node:dns'))
  assert.ok(!lowerModule.implementedBuiltins?.includes('node:dns/promises'))
  const { compiler, store } = await setup(t)
  const manifest = await compiler.build(request('import { createHash } from "node:crypto"; export const apply = () => createHash("sha256").update("dsh-account:default").digest("hex")'))
  const file = manifest.packages[0]!.files[0]!
  const code = new TextDecoder().decode(await store.get(file.objectKey))
  assert.match(code, /require\("node:crypto"\)/)
  // Exercise the compiled plugin with the actual Worker crypto implementation, not Node's crypto.
  const workerCrypto: Record<string, unknown> = await import(resolve(dshRoot, 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/crypto.ts'))
  const module: { exports: Record<string, unknown> } = { exports: {} }
  new Function('module', 'exports', 'require', code)(module, module.exports, (name: string) => { assert.equal(name, 'node:crypto'); return workerCrypto })
  assert.equal(typeof module.exports.apply, 'function')
  if (typeof module.exports.apply !== 'function') throw new Error('Missing fixture apply')
  assert.equal(module.exports.apply(), sha256('dsh-account:default'))
  for (const name of ['node:net', 'node:dns', 'node:dns/promises']) await assert.rejects(compiler.build(request(`export const apply = () => require("${name}")`)), { code: 'NODE_MODULE_UNSUPPORTED' })
})

test('published Client exports resolve browser/import/default conditions without selecting types', async t => {
  const { readPublishedAssets } = await import('../src/package-assets.js')
  const root = await mkdtemp(join(tmpdir(), 'forge-client-exports-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'lib'))
  for (const name of ['client', 'browser', 'import']) await writeFile(join(root, 'lib', `${name}.js`), `// ${name} client`)
  const dsh = { client: { platform: 'web', inject: [] } }
  for (const [entry, expected] of [
    [{ types: './missing-types.d.ts', default: './lib/client.js' }, 'lib/client.js'],
    [{ types: './missing-types.d.ts', browser: { import: './lib/browser.js', default: './lib/client.js' }, default: './lib/client.js' }, 'lib/browser.js'],
    [{ require: './missing-require.cjs', import: './lib/import.js', default: './lib/client.js' }, 'lib/import.js'],
  ] as const) {
    const result = await readPublishedAssets(root, 'sample', { dsh, exports: { './client': entry } })
    assert.equal(result?.metadata.exports?.['./client'], `./${expected}`)
    assert.deepEqual(Object.keys(result!.assets), [expected])
    assert.equal(new TextDecoder().decode(result!.assets[expected]), await readFile(join(root, expected), 'utf8'))
  }
})

test('conditional Client resolution retains missing-file and path-isolation checks', async t => {
  const { readPublishedAssets } = await import('../src/package-assets.js')
  const root = await mkdtemp(join(tmpdir(), 'forge-client-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dsh = { client: { platform: 'web', inject: [] } }
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh, exports: { './client': { types: './client.d.ts' } } }), { code: 'BUNDLE_UNSUPPORTED' })
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh, exports: { './client': { default: './missing.js' } } }), { code: 'BUNDLE_ASSET_MISSING' })
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh, exports: { './client': { browser: './../outside.js' } } }), { code: 'BUNDLE_UNSUPPORTED' })
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh, exports: { './client': { default: '/tmp/outside.js' } } }), { code: 'BUNDLE_UNSUPPORTED' })
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh, exports: {} }), { code: 'BUNDLE_UNSUPPORTED' })
})

test('Client seed peers use their fixed versions without becoming Host imports or replaceable packages', async t => {
  const { store } = await setup(t)
  const clientTarget: BuildTarget = { ...target, clientPackages: { react: '18.3.1', '@deepseek-ai/dsh-client-ui-primitives': '0.2.1-rc.3' } }
  const resolver: PackageResolver = { ...noDependencies, async prepare(_directory, dependencies) { assert.deepEqual(dependencies, {}) } }
  const compiler = new ForgeCompiler({ target: clientTarget, resolver, store, lowerModule })
  const input = request()
  input.plugin.peerDependencies = { react: '^18.2.0', '@deepseek-ai/dsh-client-ui-primitives': '>=0.2.0-rc.1 <0.3.0-0', '@deepseek-ai/cordis': '^4.0.0' }
  const manifest = await compiler.build(input)
  assert.deepEqual(manifest.clientPackages, clientTarget.clientPackages)
  assert.deepEqual(manifest.hostPackages, target.hostPackages)
  assert.deepEqual(manifest.packages[0]!.dependencies, {})
  for (const range of ['^19.0.0', '18.3.0', '>=18.0.0 <18.3.1']) {
    input.plugin.peerDependencies.react = range
    await assert.rejects(compiler.build(input), { code: 'CLIENT_VERSION_MISMATCH' })
  }
  input.plugin.peerDependencies.react = '^18.2.0'
  for (const source of ['import React from "react"; export const apply = () => React', 'export const apply = () => require("react")']) {
    input.plugin.files['src/index.ts'] = source
    await assert.rejects(compiler.build(input), { code: 'CLIENT_PACKAGE_HOST_IMPORT' })
  }
  input.plugin.name = 'react'
  await assert.rejects(compiler.build(input), { code: 'CORE_PACKAGE_PROTECTED' })
  await assert.rejects(compiler.buildPackage({ protocol: 1, generation: target.generation, pluginId: 'react', spec: 'react@18.3.1' }), { code: 'CORE_PACKAGE_PROTECTED' })
  input.plugin.name = 'fixture'; input.generation = 'other'
  await assert.rejects(compiler.build(input), { code: 'GENERATION_MISMATCH' })
  assert.throws(() => new ForgeCompiler({ target: { ...target, clientPackages: { react: 'latest' } }, resolver, store, lowerModule }), /Invalid client package/)
})

test('published Client metadata defaults omitted inject while retaining platform and member validation', async t => {
  const { root } = await setup(t)
  const { readPublishedAssets } = await import('../src/package-assets.js')
  await writeFile(join(root, 'client.js'), 'window.__ModuleLoader__.load({})')
  const metadata = { dsh: { client: { platform: 'web' } }, exports: { './client': './client.js' } }
  assert.deepEqual((await readPublishedAssets(root, 'whale-fixture', metadata))?.metadata.dsh?.client, { platform: 'web', inject: [] })
  for (const client of [{}, { platform: 'desktop' }, { platform: 'web', inject: null }, { platform: 'web', inject: [42] }]) {
    await assert.rejects(readPublishedAssets(root, 'whale-fixture', { ...metadata, dsh: { client } }), { code: 'BUNDLE_UNSUPPORTED' })
  }
})

test('mjs external defaults follow Worker ESM and CommonJS exports while CommonJS entries retain raw values', async t => {
  const { store } = await setup(t)
  const configured: BuildTarget = { ...target, hostPackages: { ...target.hostPackages, 'schema-fixture': '1.0.0' } }
  const compiler = new ForgeCompiler({ target: configured, store, resolver: noDependencies, lowerModule })
  const input = request()
  input.plugin.entry = 'index.mjs'
  input.plugin.files = { 'index.mjs': 'import Schema from "schema-fixture"; export const value = Schema.number(); export const same = Schema;' }
  input.plugin.peerDependencies = { 'schema-fixture': '1.0.0' }
  const manifest = await compiler.build(input)
  const file = manifest.packages[0]!.files.find(file => file.path === 'index.js')!
  const code = new TextDecoder().decode(await store.get(file.objectKey))
  const schema = Object.assign(() => 'schema', { number: () => 42 })
  const namespace = Object.defineProperty({ default: schema }, '__esModule', { value: true })
  for (const supplied of [schema, namespace]) {
    const module = { exports: {} as { value?: number; same?: unknown } }
    new Function('require', 'exports', 'module', code)((name: string) => { assert.equal(name, 'schema-fixture'); return supplied }, module.exports, module)
    assert.equal(module.exports.value, 42)
    assert.equal(module.exports.same, schema)
  }
  const cjs = request('module.exports = value => value * 2')
  const builtCjs = await compiler.build(cjs)
  const cjsFile = builtCjs.packages[0]!.files.find(file => file.path === 'index.js')!
  const raw: { exports: unknown } = { exports: {} }
  new Function('require', 'exports', 'module', new TextDecoder().decode(await store.get(cjsFile.objectKey)))(() => assert.fail('Unexpected dependency'), raw.exports, raw)
  assert.equal(typeof raw.exports, 'function')
  assert.equal((raw.exports as (value: number) => number)(4), 8)
})
