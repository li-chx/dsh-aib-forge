import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectPackageResources, resolveResourceLimits } from '../src/package-resources.js'
import { readPublishedAssets } from '../src/package-assets.js'
import { PnpmPackageResolver, type PackageResolver } from '../src/resolver.js'
import { ForgeCompiler, loadDshLowerer } from '../src/compiler.js'
import { FileArtifactStore } from '../src/store.js'
import { dshRoot } from './dsh-root.js'

const defaults = resolveResourceLimits({})
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-resources-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function put(directory: string, path: string, content: string | Uint8Array) {
  await mkdir(dirname(join(directory, path)), { recursive: true })
  await writeFile(join(directory, path), content)
}

test('published non-module data retains its paths and binary bytes without copying dependencies or source modules', async t => {
  const directory = await fixture(t)
  const binary = new Uint8Array([0, 255, 1, 128])
  for (const path of ['package.json', 'lib/index.js', 'lib/source.mjs', 'src/helper.ts', 'src/types.d.ts', 'lib/source.js.map', 'native/addon.node', 'node_modules/dep/data.json', 'deep/node_modules/dep/data.json']) await put(directory, path, '{}')
  await put(directory, 'skills/sample/SKILL.md', 'Read references/data.json')
  await put(directory, 'skills/sample/references/data.json', '{"answer":42}')
  await put(directory, 'assets/icon.png', binary)
  const result = await collectPackageResources(directory, new Set(['lib/index.js']), { 'client.js': new Uint8Array([1]) }, defaults)
  assert.deepEqual(Object.keys(result).sort(), ['assets/icon.png', 'client.js', 'skills/sample/SKILL.md', 'skills/sample/references/data.json'])
  assert.deepEqual(result['assets/icon.png'], binary)
})

test('resource caps include declared assets, enforce exact boundaries and reject unsafe configuration', async t => {
  const directory = await fixture(t)
  await put(directory, 'data.bin', new Uint8Array([1, 2, 3]))
  const declared = { 'client.js': new Uint8Array([4, 5]) }
  assert.equal(Object.keys(await collectPackageResources(directory, new Set(), declared, { maxResourceFiles: 2, maxResourceBytes: 5 })).length, 2)
  for (const limits of [{ maxResourceFiles: 1, maxResourceBytes: 5 }, { maxResourceFiles: 2, maxResourceBytes: 4 }]) {
    await assert.rejects(collectPackageResources(directory, new Set(), declared, limits), { code: 'RESOURCE_LIMIT_EXCEEDED' })
  }
  for (const maxResourceBytes of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new PnpmPackageResolver({ executable: 'pnpm', registry: 'https://registry.npmjs.org/', timeoutMs: 1000, maxResourceBytes }), /positive safe integer/)
  await put(directory, 'client.js', '123456')
  await assert.rejects(readPublishedAssets(directory, 'sample', { dsh: { client: { platform: 'web' } }, exports: { './client': './client.js' } }, 'lib/index.js', { maxResourceFiles: 2, maxResourceBytes: 5 }), { code: 'RESOURCE_LIMIT_EXCEEDED' })
})

test('resources refuse internal and escaping symlinks and unsupported Worker path characters', async t => {
  const directory = await fixture(t)
  await put(directory, 'data.bin', 'ok')
  for (const target of ['data.bin', '../outside']) {
    await symlink(target, join(directory, 'alias'))
    await assert.rejects(collectPackageResources(directory, new Set(), {}, defaults), { code: 'RESOURCE_SYMLINK_UNSUPPORTED' })
    await rm(join(directory, 'alias'))
  }
  await put(directory, '参考.md', 'unsupported path')
  await assert.rejects(collectPackageResources(directory, new Set(), {}, defaults), { code: 'RESOURCE_PATH_UNSUPPORTED' })
})

test('published nested entry resolves packaged resources from import.meta.url and updates resource identities', async t => {
  const directory = await fixture(t)
  const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
  const resolver = new PnpmPackageResolver({ executable: 'pnpm', registry: 'https://registry.npmjs.org/', timeoutMs: 1000 })
  let text = 'skill version one'
  const source: PackageResolver = {
    async prepare(workspace) {
      const pkg = join(workspace, 'node_modules', 'resource-fixture')
      await put(pkg, 'package.json', JSON.stringify({ name: 'resource-fixture', version: '1.0.0', main: './lib/index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await put(pkg, 'lib/index.mjs', 'import { readFileSync } from "node:fs"; export const readSkill = () => readFileSync(new URL("../skills/example/SKILL.md", import.meta.url), "utf8")')
      await put(pkg, 'cordis.patch.yml', '- insert: [{id: resource-fixture, name: resource-fixture}]')
      await put(pkg, 'skills/example/SKILL.md', text)
      await put(pkg, 'skills/example/references/table.json', '{"value":42}')
    },
    resolve: (...args) => resolver.resolve(...args),
  }
  const store = new FileArtifactStore(join(directory, 'store'))
  const compiler = new ForgeCompiler({ target: { protocol: 1, generation: 'test-resources', sharedPackages: [], hostPackages: {} }, resolver: source, store, lowerModule })
  const request = { protocol: 1 as const, generation: 'test-resources', pluginId: 'resource-fixture', spec: 'resource-fixture@1.0.0' }
  const first = await compiler.buildPackage(request)
  const pkg = first.packages[0]!
  assert.equal(pkg.entry, 'lib/index.js')
  assert.equal(first.plugin.entry, pkg.entry)
  assert.equal(pkg.metadata?.exports?.['.'], './lib/index.js')
  const mounted = join(directory, 'mounted')
  for (const file of pkg.files) await put(mounted, file.path, (await store.get(file.objectKey))!)
  const code = await readFile(join(mounted, pkg.entry), 'utf8')
  const exported: { readSkill?: () => string } = {}
  const module = { exports: exported }
  new Function('exports', 'require', 'module', '__dsh$meta', code)(exported, (name: string) => { assert.equal(name, 'node:fs'); return { readFileSync } }, module, { url: pathToFileURL(join(mounted, pkg.entry)).href })
  assert.equal(exported.readSkill?.(), text)
  text = 'skill version two'
  const second = await compiler.buildPackage(request)
  assert.notEqual(second.revision, first.revision)
  assert.notEqual(second.packages[0]!.id, pkg.id)
})

test('root index Client assets and resources conflicting with generated entry are rejected', async t => {
  const directory = await fixture(t)
  await put(directory, 'index.js', 'export {}')
  await assert.rejects(readPublishedAssets(directory, 'sample', { dsh: { client: { platform: 'web' } }, exports: { './client': './index.js' } }, 'lib/index.js'), { code: 'BUNDLE_UNSUPPORTED' })
  const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
  for (const resource of ['lib/index.js', 'lib/index.js/data.bin', 'lib', 'index.js/data.bin']) {
    const resolver: PackageResolver = {
      async prepare() {},
      async resolve() { return { directory, entry: join(directory, 'index.js'), outputEntry: 'lib/index.js', name: 'sample', version: '1.0.0', dependencies: {}, peerDependencies: {}, assets: { [resource]: new Uint8Array([1]) } } },
    }
    const compiler = new ForgeCompiler({ target: { protocol: 1, generation: 'test-resources', sharedPackages: [], hostPackages: {} }, resolver, store: new FileArtifactStore(join(directory, 'store')), lowerModule })
    await assert.rejects(compiler.buildPackage({ protocol: 1, generation: 'test-resources', pluginId: 'sample', spec: 'sample@1.0.0' }), { code: 'RESOURCE_ENTRY_COLLISION' })
  }
})
