/** Browser source bundles share exact page modules and remain separate from Worker Host code. */
import { dshRoot } from './dsh-root.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { FileArtifactStore, ForgeCompiler, loadDshLowerer, parseBuildRequest, validateTarget } from '../src/index.js'
import type { BuildRequest, BuildTarget, PackageResolver } from '../src/index.js'

const target: BuildTarget = {
  protocol: 1, generation: 'client-source-test',
  sharedPackages: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-conversation'],
  hostPackages: { '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/dsh-client-ui-conversation': '0.2.1-rc.2' },
  clientPackages: { react: '18.3.1', '@deepseek-ai/cordis': '4.0.5' },
  clientModules: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
}
const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
const noDependencies: PackageResolver = { async prepare() {}, async resolve() { throw new Error('Unexpected dependency') } }
const input = (): BuildRequest => ({ protocol: 1, generation: target.generation, plugin: {
  id: 'counter', name: 'counter-plugin', version: '1.0.0', entry: 'index.ts',
  files: {
    'index.ts': 'import { message } from "./shared.ts"; export const name="counter"; export async function apply() { return await Promise.resolve(message) }',
    'shared.ts': 'export const message: string = "counter v1";',
    'client.tsx': 'import { message } from "./shared.ts"; export const inject = ["slots"]; export function apply(ctx) { return ctx.render(<span>{message}</span>); }',
  },
  dependencies: {}, peerDependencies: { react: '18.3.1' },
  client: { entry: 'client.tsx', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
} })
async function setup(t: { after(fn: () => Promise<void>): void }, resolver = noDependencies, selectedTarget = target) {
  const root = await mkdtemp(join(tmpdir(), 'forge-client-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new FileArtifactStore(join(root, 'objects'))
  const work = join(root, 'work'); await mkdir(work)
  const compiler = new ForgeCompiler({ target: selectedTarget, resolver, store, lowerModule, temporaryRoot: work })
  return { compiler, store, work }
}

test('TSX Client builds a lazy module-table factory while shared TS also uses the Worker transformer', async t => {
  const { compiler, store } = await setup(t)
  const source = input()
  const result = await compiler.build(source)
  const again = await compiler.build(source)
  assert.deepEqual(result, again)
  const root = result.packages.find(pkg => pkg.id === result.plugin.packageId)!
  assert.deepEqual(root.metadata, { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-conversation'] } }, exports: { '.': './index.ts', './client': './forge-client.js' } })
  assert.deepEqual(result.clientPackages, { react: '18.3.1' })
  assert.deepEqual(root.hostDependencies, [])
  assert.ok(root.files.some(file => file.path === 'shared.ts'))
  const host = new TextDecoder().decode(await store.get(root.files.find(file => file.path === 'index.ts')!.objectKey))
  assert.match(host, /__als/)
  const browser = new TextDecoder().decode(await store.get(root.files.find(file => file.path === 'forge-client.js')!.objectKey))
  assert.doesNotMatch(browser, /__als|react\.production/)
  let factory: ((require: (name: string) => unknown) => { apply(ctx: { render(value: unknown): unknown }): unknown }) | undefined
  const context = { window: { __ModuleLoader__: { load(value: { id: string; factory: typeof factory }) { assert.equal(value.id, 'counter-plugin'); factory = value.factory } } } }
  runInNewContext(browser, context)
  assert.ok(factory)
  const requests: string[] = []
  const exports = factory(name => { requests.push(name); return { jsx: (tag: string, props: unknown) => ({ tag, props }) } })
  const rendered = exports.apply({ render: value => value })
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)), { tag: 'span', props: { children: 'counter v1' } })
  assert.deepEqual(requests, ['react/jsx-runtime'])
  source.plugin.files['client.tsx'] = source.plugin.files['client.tsx']!.replace('<span>', '<strong>').replace('</span>', '</strong>')
  assert.notEqual((await compiler.build(source)).revision, result.revision)
})

test('Client metadata is optional and malformed declarations fail at the request parser', () => {
  for (const client of [{ entry: 'client.tsx', inject: ['slots', 'slots'] }, { entry: '../escape.js' }, { entry: 'client.tsx', immediately: true }]) {
    assert.throws(() => parseBuildRequest({ ...input(), plugin: { ...input().plugin, client } }), { code: 'INVALID_REQUEST' })
  }
  const source = input()
  delete source.plugin.client
  assert.equal(parseBuildRequest(source).plugin.client, undefined)
  assert.throws(() => validateTarget({ ...target, clientModules: ['react/not-supplied', 'not-a-package'] }), /Client module/)
  assert.throws(() => validateTarget({ ...target, clientModules: ['react/../private'] }), /exact Client module inventory/)
})

test('Client build rejects unavailable imports, undeclared imports and incompatible shared versions', async t => {
  const { compiler, work } = await setup(t)
  for (const [code, modify] of [
    ['import fs from "node:fs"; export const apply = () => fs;', undefined],
    ['import value from "react/unknown"; export const apply = () => value;', undefined],
    ['import value from "not-declared"; export const apply = () => value;', undefined],
    ['import value from "react"; export const apply = () => value;', (source: BuildRequest) => { source.plugin.peerDependencies.react = '^19.0.0' }],
    ['import value from "./not-listed.ts"; export const apply = () => value;', undefined],
    ['await Promise.resolve(); export const apply = () => {};', undefined],
  ] as const) {
    const source = input(); source.plugin.files['client.tsx'] = code; modify?.(source)
    await assert.rejects(compiler.build(source), { code: 'CLIENT_COMPILE_FAILED' })
  }
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(work)), [])
})

test('Client resource and entry validation reject reserved output, missing entry and unknown graph requirements', async t => {
  const { compiler } = await setup(t)
  for (const [change, code] of [
    [(source: BuildRequest) => { source.plugin.files['forge-client.js'] = 'bad'; }, 'RESOURCE_ENTRY_COLLISION'],
    [(source: BuildRequest) => { source.plugin.client!.entry = 'missing.tsx'; }, 'INVALID_REQUEST'],
    [(source: BuildRequest) => { source.plugin.client!.inject = ['not-provided']; }, 'CLIENT_DEPENDENCY_MISSING'],
    [(source: BuildRequest) => { source.plugin.client!.inject = [source.plugin.name]; }, 'CLIENT_DEPENDENCY_INVALID'],
  ] as const) { const source = input(); change(source); await assert.rejects(compiler.build(source), { code }) }
})

test('Client peers do not grant the Host program a shared module capability', async t => {
  const { compiler } = await setup(t)
  const source = input(); source.plugin.files['index.ts'] = 'import React from "react"; export const apply = () => React'
  const result = await compiler.build(source)
  const pkg = result.packages.find(row => row.id === result.plugin.packageId)!
  assert.ok(!pkg.hostDependencies.includes('react'))
  assert.ok(!Object.hasOwn(pkg.dependencies, 'react'))
})

test('computed Host requests retain shared helpers used by the Client and all declared Host dependencies', async t => {
  const { compiler, store } = await setup(t)
  const source = input()
  source.plugin.files['index.ts'] = 'const name="./shared.ts"; export const apply = () => require(name).message;'
  const result = await compiler.build(source)
  const pkg = result.packages.find(row => row.id === result.plugin.packageId)!
  assert.ok(pkg.files.some(file => file.path === 'shared.ts'))
  const host = new TextDecoder().decode(await store.get(pkg.files.find(file => file.path === 'index.ts')!.objectKey))
  const helper = new TextDecoder().decode(await store.get(pkg.files.find(file => file.path === 'shared.ts')!.objectKey))
  const cached: Record<string, unknown> = {}
  const evaluate = (filename: string, body: string): unknown => {
    if (Object.hasOwn(cached, filename)) return cached[filename]
    const module = { exports: {} }
    const run = new Function('exports', 'require', 'module', '__filename', '__dirname', '__dsh$meta', '__als', body)
    run(module.exports, (name: string) => {
      assert.equal(name, './shared.ts')
      return evaluate('shared.ts', helper)
    }, module, filename, '/', {}, {})
    cached[filename] = module.exports
    return module.exports
  }
  const exported = evaluate('index.ts', host) as { apply(): string }
  assert.equal(exported.apply(), 'counter v1')
})

test('Client-exclusive helper selection is explicit and never removes a shared Host helper', async t => {
  const { compiler } = await setup(t)
  const source = input()
  source.plugin.files['browser-only.ts'] = 'export const label="browser-only";'
  source.plugin.files['client.tsx'] = 'import {label} from "./browser-only.ts"; export const apply = () => label;'
  source.plugin.client!.files = ['client.tsx', 'browser-only.ts']
  const result = await compiler.build(source)
  const pkg = result.packages.find(row => row.id === result.plugin.packageId)!
  assert.ok(!pkg.files.some(file => file.path === 'client.tsx' || file.path === 'browser-only.ts'))
  assert.ok(pkg.files.some(file => file.path === 'shared.ts'))
  for (const paths of [['browser-only.ts'], ['client.tsx', 'index.ts'], ['client.tsx', 'not-listed.ts']]) {
    source.plugin.client!.files = paths
    await assert.rejects(compiler.build(source), { code: 'INVALID_REQUEST' })
  }
})

test('private browser dependencies bundle without gaining Host mappings and reuse their shared React peer', async t => {
  const resolver: PackageResolver = { async prepare(directory, dependencies) {
    assert.deepEqual(dependencies, { 'browser-helper': '1.0.0' })
    const pkg = join(directory, 'node_modules/browser-helper'); await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'browser-helper', version: '1.0.0', main: 'index.js', peerDependencies: { react: '18.3.1' } }))
    await writeFile(join(pkg, 'index.js'), 'const React=require("react"); module.exports=() => React.proof + ":private";')
  }, async resolve() { throw new Error('Client-only dependency must not become a Host package') } }
  const { compiler, store } = await setup(t, resolver)
  const source = input()
  source.plugin.client!.dependencies = { 'browser-helper': '1.0.0' }
  source.plugin.files['client.tsx'] = 'import value from "browser-helper"; export const apply = () => value();'
  const result = await compiler.build(source)
  assert.equal(result.packages.length, 1)
  const pkg = result.packages[0]!
  assert.deepEqual(pkg.dependencies, {})
  assert.deepEqual(pkg.hostDependencies, [])
  assert.deepEqual(result.clientPackages, { react: '18.3.1' })
  const code = new TextDecoder().decode(await store.get(pkg.files.find(file => file.path === 'forge-client.js')!.objectKey))
  let factory: ((require: (name: string) => unknown) => { apply(): string }) | undefined
  runInNewContext(code, { window: { __ModuleLoader__: { load(value: { factory: typeof factory }) { factory = value.factory } } } })
  assert.ok(factory)
  assert.equal(factory(name => { assert.equal(name, 'react'); return { proof: 'same-react' } }).apply(), 'same-react:private')
})

test('browser package entries cannot bypass version, script or per-importer declaration checks', async t => {
  for (const kind of ['version', 'script', 'undeclared'] as const) {
    const resolver: PackageResolver = { async prepare(directory) {
      const pkg = join(directory, 'node_modules/browser-helper'); await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'browser-helper', version: kind === 'version' ? '2.0.0' : '1.0.0', main: 'index.js', ...kind === 'script' ? { scripts: { install: 'never run' } } : {} }))
      await writeFile(join(pkg, 'index.js'), kind === 'undeclared' ? 'module.exports=require("react")' : 'module.exports=1')
    }, async resolve() { throw new Error('Client-only package should not be a Host dependency') } }
    const { compiler } = await setup(t, resolver)
    const source = input(); source.plugin.client!.dependencies = { 'browser-helper': '1.0.0' }
    source.plugin.files['client.tsx'] = 'import value from "browser-helper"; export const apply = () => value;'
    await assert.rejects(compiler.build(source), { code: kind === 'version' ? 'DEPENDENCY_VERSION_MISMATCH' : kind === 'script' ? 'INSTALL_SCRIPT_UNSUPPORTED' : 'CLIENT_COMPILE_FAILED' })
  }
})

test('conflicting Host and Client declarations fail before installing any dependencies', async t => {
  const { compiler } = await setup(t)
  const source = input(); source.plugin.client!.peerDependencies = { react: '^19.0.0' }
  await assert.rejects(compiler.build(source), { code: 'CLIENT_DEPENDENCY_CONFLICT' })
})


test('explicit Client peers validate even when unused and are never installed automatically', async t => {
  const { compiler } = await setup(t)
  const source = input()
  source.plugin.peerDependencies = {}
  source.plugin.files['client.tsx'] = 'export const apply = () => 1;'
  source.plugin.client!.peerDependencies = { react: '^19.0.0' }
  await assert.rejects(compiler.build(source), { code: 'CLIENT_VERSION_MISMATCH' })
  source.plugin.client!.peerDependencies = { 'not-installed': '1.0.0' }
  await assert.rejects(compiler.build(source), { code: 'CLIENT_DEPENDENCY_MISSING' })
  source.plugin.client!.peerDependencies = { react: '18.3.1' }
  assert.deepEqual((await compiler.build(source)).clientPackages, { react: '18.3.1' })
})
