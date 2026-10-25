/** Package isolation, explicit peer providers, and fixed runtime identities. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FileArtifactStore, ForgeCompiler, ForgeError, loadDshLowerer } from '../src/index.js'
import { validateTarget } from '../src/compiler.js'
import type { BuildRequest, BuildTarget, PackageResolver, ResolvedPackage } from '../src/index.js'
import { dshRoot } from './dsh-root.js'

const target: BuildTarget = { protocol: 1, generation: 'policy-test', sharedPackages: ['fixed', 'react'], hostPackages: { ordinary: '2.0.0', fixed: '1.0.0' }, clientPackages: { react: '18.3.1' } }
const lowerModule = await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js'))
const input = (source = 'export const apply = () => true'): BuildRequest => ({ protocol: 1, generation: target.generation, plugin: { id: 'plugin', name: 'plugin', version: '1.0.0', entry: 'index.js', files: { 'index.js': source }, dependencies: {}, peerDependencies: {} } })

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-policy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const packages = new Map<string, ResolvedPackage>()
  const scopes = new Map<string, Map<string, ResolvedPackage>>()
  let installed: Record<string, string> = {}
  const resolver: PackageResolver = {
    async prepare(_root, dependencies) { installed = { ...dependencies } },
    async resolve(name, importer) {
      const pkg = scopes.get(importer)?.get(name) ?? packages.get(name)
      if (!pkg) throw new ForgeError('DEPENDENCY_MISSING', `Missing ${name}`)
      return pkg
    },
  }
  const compiler = new ForgeCompiler({ target, resolver, lowerModule, store: new FileArtifactStore(join(directory, 'objects')) })
  const add = async (name: string, version: string, source = 'export const value = 42', dependencies: Record<string, string> = {}, peers: Record<string, string> = {}) => {
    const root = join(directory, name + '-' + version); await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.js'), source)
    const pkg: ResolvedPackage = { directory: root, entry: join(root, 'index.js'), name, version, dependencies, peerDependencies: peers }
    packages.set(name, pkg)
    return pkg
  }
  return { compiler, add, scopes, installed: () => installed }
}

test('ordinary dependencies are private even when the image version satisfies the declaration', async t => {
  const f = await fixture(t)
  for (const version of ['1.0.0', '2.0.0']) {
    await f.add('ordinary', version)
    const request = input('import { value } from "ordinary"; export const apply = () => value')
    request.plugin.dependencies = { ordinary: version }
    const manifest = await f.compiler.build(request)
    const pkg = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)!
    assert.equal(manifest.hostPackages.ordinary, undefined)
    assert.equal(manifest.packages.find(child => child.id === pkg.dependencies.ordinary)?.version, version)
    assert.deepEqual(f.installed(), { ordinary: version })
  }
})

test('one plan can carry private versions and a separate explicit image peer', async t => {
  const f = await fixture(t)
  const first = await f.add('ordinary', '1.0.0')
  const second = await f.add('ordinary', '3.0.0')
  const left = await f.add('left', '1.0.0', 'export { value } from "ordinary"', { ordinary: '1.0.0' })
  const right = await f.add('right', '1.0.0', 'export { value } from "ordinary"', { ordinary: '3.0.0' })
  await f.add('peer-user', '1.0.0', 'export { value } from "ordinary"', {}, { ordinary: '2.0.0' })
  f.scopes.set(left.directory, new Map([['ordinary', first]]))
  f.scopes.set(right.directory, new Map([['ordinary', second]]))
  const request = input('import * as left from "left"; import * as right from "right"; import * as shared from "peer-user"; export const apply = () => [left,right,shared]')
  request.plugin.dependencies = { left: '1.0.0', right: '1.0.0', 'peer-user': '1.0.0' }
  const result = await f.compiler.build(request)
  assert.equal(result.hostPackages.ordinary, '2.0.0')
  assert.deepEqual(result.packages.filter(pkg => pkg.name === 'ordinary').map(pkg => pkg.version).sort(), ['1.0.0', '3.0.0'])
  const leftPackage = result.packages.find(pkg => pkg.name === 'left')!
  const rightPackage = result.packages.find(pkg => pkg.name === 'right')!
  assert.notEqual(leftPackage.dependencies.ordinary, rightPackage.dependencies.ordinary)
  assert.deepEqual(result.packages.find(pkg => pkg.name === 'peer-user')!.dependencies, {})
})

test('fixed packages remain shared and cannot be privately substituted or installed as plugins', async t => {
  const f = await fixture(t)
  const request = input('export { value } from "fixed"'); request.plugin.dependencies = { fixed: '1.0.0' }
  assert.deepEqual((await f.compiler.build(request)).hostPackages, { fixed: '1.0.0' })
  assert.deepEqual(f.installed(), {})
  request.plugin.dependencies.fixed = '2.0.0'
  await assert.rejects(f.compiler.build(request), { code: 'HOST_VERSION_MISMATCH' })
  request.plugin.dependencies = { react: '17.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'CLIENT_PACKAGE_HOST_IMPORT' })
  request.plugin.dependencies = {}; request.plugin.name = 'ordinary'
  await assert.rejects(f.compiler.build(request), { code: 'CORE_PACKAGE_PROTECTED' })
})

test('peers do not overwrite dependency ranges or trigger implicit installation', async t => {
  const f = await fixture(t)
  const request = input(); request.plugin.peerDependencies = { ordinary: '^1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'HOST_VERSION_MISMATCH' })
  assert.deepEqual(f.installed(), {})
  request.plugin.dependencies = { fixed: '1.0.0' }; request.plugin.peerDependencies = { fixed: '^2.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'HOST_VERSION_MISMATCH' })
  request.plugin.dependencies = { ordinary: '1.0.0' }; request.plugin.peerDependencies = { ordinary: '2.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'PEER_CONTEXT_UNSUPPORTED' })
  request.plugin.dependencies = {}; request.plugin.peerDependencies = { missing: '1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'PEER_MISSING' })
  assert.deepEqual(f.installed(), {})
})

test('non-image peers use an existing consumer provider and validate both declared ranges', async t => {
  const f = await fixture(t)
  await f.add('provider', '1.5.0')
  await f.add('consumer', '1.0.0', 'export { value } from "provider"', {}, { provider: '^1.0.0' })
  const request = input('import * as consumer from "consumer"; export const apply = () => consumer')
  request.plugin.dependencies = { provider: '^1.0.0', consumer: '1.0.0' }
  const result = await f.compiler.build(request)
  assert.equal(result.packages.filter(pkg => pkg.name === 'provider').length, 1)
  request.plugin.files['index.js'] = 'export { value } from "provider"'
  request.plugin.dependencies = { provider: '^2.0.0' }; request.plugin.peerDependencies = { provider: '^1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'DEPENDENCY_VERSION_MISMATCH' })
  request.plugin.dependencies = {}; request.plugin.peerDependencies = { provider: '^2.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'PEER_VERSION_MISMATCH' })
})

test('optional unused peers may be absent, but importing them requires an actual provider', async t => {
  const f = await fixture(t)
  const request = input(); request.plugin.peerDependencies = { missing: '^1.0.0' }; request.plugin.peerDependenciesMeta = { missing: { optional: true } }
  assert.equal((await f.compiler.build(request)).packages.length, 1)
  request.plugin.files['index.js'] = 'export { value } from "missing"'
  await assert.rejects(f.compiler.build(request), { code: 'PEER_MISSING' })
})

test('a target peer cannot silently replace its consumer private provider', async t => {
  const f = await fixture(t)
  await f.add('ordinary', '1.0.0')
  await f.add('consumer', '1.0.0', 'export { value } from "ordinary"', {}, { ordinary: '^2.0.0' })
  const request = input('export { value } from "consumer"')
  request.plugin.dependencies = { ordinary: '1.0.0', consumer: '1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'PEER_CONTEXT_UNSUPPORTED' })
})


test('target shared policy is required, protects unavailable replacements, and cycles still fail', async t => {
  assert.throws(() => validateTarget({ ...target, sharedPackages: [] }), /omits react/)
  assert.throws(() => validateTarget({ ...target, sharedPackages: ['react', 'react'] }), /Invalid configured shared/)
  const f = await fixture(t)
  await f.add('left', '1.0.0', 'export { value } from "right"', { right: '1.0.0' })
  await f.add('right', '1.0.0', 'export { value } from "left"', { left: '1.0.0' })
  const request = input('export { value } from "left"'); request.plugin.dependencies = { left: '1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'DEPENDENCY_CYCLE_UNSUPPORTED' })
  request.plugin.dependencies = { '@deepseek-ai/dsh-missing': '1.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'HOST_PACKAGE_UNAVAILABLE' })
})


test('optional peers supplied by the image or page retain version checks and manifest requirements', async t => {
  const f = await fixture(t)
  const request = input(); request.plugin.peerDependencies = { react: '^18.0.0' }; request.plugin.peerDependenciesMeta = { react: { optional: true } }
  assert.deepEqual((await f.compiler.build(request)).clientPackages, { react: '18.3.1' })
  request.plugin.peerDependencies.react = '^17.0.0'
  await assert.rejects(f.compiler.build(request), { code: 'CLIENT_VERSION_MISMATCH' })
  request.plugin.peerDependencies = { ordinary: '2.0.0' }; request.plugin.peerDependenciesMeta = { ordinary: { optional: true } }
  assert.equal((await f.compiler.build(request)).hostPackages.ordinary, '2.0.0')
  request.plugin.peerDependencies.ordinary = '1.0.0'
  await assert.rejects(f.compiler.build(request), { code: 'HOST_VERSION_MISMATCH' })
})


test('optional unused peers still validate installed providers and same-name dependency intersections', async t => {
  const f = await fixture(t)
  const request = input(); request.plugin.peerDependencies = { provider: '^1.0.0' }; request.plugin.peerDependenciesMeta = { provider: { optional: true } }
  await f.add('provider', '2.0.0')
  await assert.rejects(f.compiler.build(request), { code: 'PEER_VERSION_MISMATCH' })
  request.plugin.dependencies = { provider: '2.0.0' }
  await assert.rejects(f.compiler.build(request), { code: 'PEER_VERSION_MISMATCH' })
  await f.add('provider', '1.5.0')
  await assert.rejects(f.compiler.build(request), { code: 'DEPENDENCY_VERSION_MISMATCH' })
  request.plugin.dependencies = { provider: '^1.0.0' }
  assert.equal((await f.compiler.build(request)).packages.length, 1)
})
