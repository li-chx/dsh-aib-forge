/** Real Worker execution of independent module artifacts and late dependency requests. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { FileArtifactStore, ForgeCompiler, PnpmPackageResolver, loadDshLowerer } from '../src/index.js'
import type { BuildRequest, PackageResolver } from '../src/index.js'
import { packageExports } from '../src/package-exports.js'
import { collectPackageFiles, resolveResourceLimits } from '../src/package-resources.js'
import { dshRoot } from './dsh-root.js'

const runtime = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')).href)
const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
const target = { protocol: 1 as const, generation: 'runtime-test', sharedPackages: [], hostPackages: {} }
const request = (files: Record<string, string>, dependencies: Record<string, string> = {}): BuildRequest => ({ protocol: 1, generation: target.generation, plugin: { id: 'fixture', name: 'fixture', version: '1.0.0', entry: 'index.ts', files, dependencies, peerDependencies: {} } })
async function folder(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'forge-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function put(root: string, path: string, text: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }

test('declared dynamic dependencies and relative modules are lazy, scoped, cached, and keep their original paths', async t => {
  const root = await folder(t)
  const npm = new PnpmPackageResolver({ executable: 'pnpm', timeoutMs: 1000, registry: 'https://registry.npmjs.org/' })
  const resolver: PackageResolver = {
    async prepare(directory, dependencies) {
      assert.deepEqual(dependencies, { lazy: '1.0.0', state: '1.0.0' })
      const lazy = join(directory, 'node_modules/lazy')
      await put(lazy, 'package.json', JSON.stringify({ name: 'lazy', version: '1.0.0', main: 'lib/index.cjs', dependencies: { state: '1.0.0' }, exports: { '.': './lib/index.cjs', './feature': { browser: './lib/feature.mjs', default: './wrong.js' }, './items/*': './lib/items/*.js', './blocked': null } }))
      await put(lazy, 'lib/index.cjs', 'require("state").calls.push("lazy"); module.exports = {value: 21}')
      await put(lazy, 'lib/feature.mjs', 'export const value = 9')
      await put(lazy, 'lib/items/a.js', 'module.exports = 5')
      await put(lazy, 'wrong.js', 'throw Error("unselected module executed")')
      await put(lazy, 'node-only.js', 'const net = require("node:net"); throw Error("unused Node-only file executed")')
      const state = join(directory, 'node_modules/state')
      await put(state, 'package.json', JSON.stringify({ name: 'state', version: '1.0.0', main: 'index.js' }))
      await put(state, 'index.js', 'module.exports = {calls: []}')
    },
    resolve: (...args) => npm.resolve(...args),
  }
  const store = new FileArtifactStore(join(root, 'objects'))
  const compiler = new ForgeCompiler({ target, resolver, store, lowerModule })
  const manifest = await compiler.build(request({
    'index.ts': `const load = require;
      export const status = () => load('state').calls.slice();
      export const locate = (name: string) => load.resolve(name);
      export const run = (name: string) => [load(name).value, load('./relative.cjs'), load('./typed').value, load(name + '/feature').value, load(name + '/items/a')];
      export const later = async (path: string) => (await import(path)).value;
      export const missing = () => { try { return load('undeclared') } catch (error) { return error.code } };`,
    'relative.cjs': 'module.exports = 7', 'typed.ts': 'export const value: number = 3',
    'async.mjs': 'export const value = 11',
  }, { lazy: '1.0.0', state: '1.0.0' }))
  assert.equal(manifest.plugin.entry, 'index.ts')
  const vfs = new runtime.MemoryVfs()
  const loader = new runtime.WorkerModuleLoader({ vfs, root: '/app', staticModules: {} })
  const scopes = new Map<string, Record<string, string>>()
  for (const pkg of manifest.packages) {
    const directory = `/app/packages/${pkg.id}`
    vfs.mkdirSync(directory, { recursive: true })
    vfs.writeFileSync(directory + '/package.json', JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.entry, ...pkg.metadata }))
    for (const file of pkg.files) { const path = directory + '/' + file.path; vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); vfs.writeFileSync(path, (await store.get(file.objectKey))!) }
    scopes.set(directory, Object.fromEntries([[pkg.name, directory], ...Object.entries(pkg.dependencies).map(([name, id]) => [name, `/app/packages/${id}`])]))
  }
  loader.setPackageScopes(scopes)
  const plugin = loader.createRequire('/app/main.js')(`/app/packages/${manifest.plugin.packageId}/${manifest.plugin.entry}`)
  assert.deepEqual(plugin.status(), [])
  assert.match(plugin.locate('lazy'), /\/lib\/index.cjs$/)
  assert.deepEqual(plugin.status(), [])
  assert.deepEqual(plugin.run('lazy'), [21, 7, 3, 9, 5])
  assert.deepEqual(plugin.run('lazy'), [21, 7, 3, 9, 5])
  assert.deepEqual(plugin.status(), ['lazy'])
  assert.equal(await plugin.later('./async.mjs'), 11)
  assert.equal(plugin.missing(), 'MODULE_NOT_FOUND')
  assert.throws(() => plugin.locate('lazy/blocked'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
})

test('entry-only changes create distinct package identities while reusing module object hashes', async t => {
  const root = await folder(t)
  const resolver: PackageResolver = { async prepare() {}, async resolve() { throw Error('Unexpected dependency') } }
  const compiler = new ForgeCompiler({ target, resolver, lowerModule, store: new FileArtifactStore(join(root, 'objects')) })
  const input = request({ 'index.ts': 'export const value = 1', 'other.cjs': 'module.exports = 2' })
  const first = await compiler.build(input)
  input.plugin.entry = 'other.cjs'
  const second = await compiler.build(input)
  assert.notEqual(first.plugin.packageId, second.plugin.packageId)
  assert.deepEqual(first.packages[0]!.files, second.packages[0]!.files)
})

test('exports preserve condition arrays, null blocks and patterns while rejecting unsafe declarations', () => {
  const exported = { '.': [{ browser: './browser.js', default: './index.cjs' }, null], './items/*': './lib/*.js', './blocked': null }
  assert.deepEqual(packageExports(exported, 'fixture'), exported)
  for (const value of ['./../escape.js', '/tmp/file.js', { browser: { './nested': './file.js' } }, { '0': './file.js' }, { './*/*': './file.js' }, { '.': './index.js', browser: './browser.js' }]) assert.throws(() => packageExports(value, 'fixture'), { code: 'PACKAGE_EXPORTS_UNSUPPORTED' })
})

test('nested package manifests cannot escape the package and final lowered bytes obey the resource budget', async t => {
  const root = await folder(t)
  await put(root, 'nested/package.json', '{"main":"../../escape.js"}')
  await assert.rejects(collectPackageFiles(root, {}, resolveResourceLimits({})), { code: 'SOURCE_PATH_ESCAPE' })
  await rm(join(root, 'nested'), { recursive: true })
  await put(root, 'index.js', 'export const value = 1')
  const resolver: PackageResolver = { async prepare() {}, async resolve() { return { directory: root, entry: join(root, 'index.js'), name: 'sample', version: '1.0.0', dependencies: {}, peerDependencies: {}, resourceLimits: { maxResourceFiles: 10, maxResourceBytes: 100 } } } }
  const compiler = new ForgeCompiler({ target, resolver, lowerModule, store: new FileArtifactStore(join(root, 'objects')) })
  await assert.rejects(compiler.buildPackage({ protocol: 1, generation: target.generation, pluginId: 'sample', spec: 'sample@1.0.0' }), { code: 'RESOURCE_LIMIT_EXCEEDED' })
})


test('host authorizations participate in package identity even when source bytes stay identical', async t => {
  const root = await folder(t)
  const resolver: PackageResolver = { async prepare() {}, async resolve() { throw Error('Unexpected dependency') } }
  const compiler = new ForgeCompiler({ target: { ...target, hostPackages: { peer: '1.0.0' } }, resolver, lowerModule, store: new FileArtifactStore(join(root, 'objects')) })
  const input = request({ 'index.ts': 'export const value = 1' })
  const first = await compiler.build(input)
  input.plugin.peerDependencies = { peer: '1.0.0' }
  const second = await compiler.build(input)
  assert.notEqual(first.plugin.packageId, second.plugin.packageId)
  assert.deepEqual(first.packages[0]!.files, second.packages[0]!.files)
  assert.deepEqual(first.packages[0]!.hostDependencies, [])
  assert.deepEqual(second.packages[0]!.hostDependencies, ['peer'])
})
