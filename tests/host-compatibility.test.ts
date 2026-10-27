/** Marketplace network prechecks retain failures while using npm's browser-readable metadata. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyHostCompatibility } from '../src/host-compatibility.js'
import { PnpmPackageResolver } from '../src/resolver.js'
import { ForgeCompiler } from '../src/compiler.js'
import { FileArtifactStore } from '../src/store.js'

// The probe call from MIT-licensed dsh-plugin 2.2.1, 2.2.2 and 2.2.3 publications.
const published = `async function check(candidate, effectiveProxy) {
  const net = await probeUrl(\`\${candidate}/\`, effectiveProxy, 6000);
  return net.ok;
}`
const path = 'lib/http/install.js'
const modules = { [path]: new TextEncoder().encode(published), 'lib/index.js': new TextEncoder().encode('export {}') }

test('supported marketplace versions probe npm metadata without changing private registries, proxy settings or deadlines', async () => {
  const calls: Array<{ url: string; proxy: string; timeout: number }> = []
  const run = (source: string, candidate: string, ok = true): Promise<boolean> => runInNewContext(source + '; check(candidate, "proxy-value")', {
    candidate,
    probeUrl: async (url: string, proxy: string, timeout: number) => {
      calls.push({ url, proxy, timeout })
      return { ok: ok && url !== 'https://registry.npmjs.org/' }
    },
  })
  assert.equal(await run(published, 'https://registry.npmjs.org'), false)
  for (const version of ['2.2.1', '2.2.2', '2.2.3']) {
    const repaired = applyHostCompatibility('dsh-plugin', version, modules)
    const source = new TextDecoder().decode(repaired[path])
    assert.equal(repaired['lib/index.js'], modules['lib/index.js'])
    for (const candidate of ['https://registry.npmjs.org', 'https://registry.npmjs.org/']) {
      assert.equal(await run(source, candidate), true)
      assert.deepEqual(calls.at(-1), { url: 'https://registry.npmjs.org/dsh-plugin/latest', proxy: 'proxy-value', timeout: 6000 })
    }
    assert.equal(await run(source, 'https://registry.npmjs.org', false), false)
    for (const candidate of ['https://private.example/npm', 'http://registry.npmjs.org', 'https://registry.npmjs.org/custom']) {
      assert.equal(await run(source, candidate), true)
      assert.equal(calls.at(-1)?.url, candidate + '/')
    }
  }
  assert.equal(new TextDecoder().decode(modules[path]), published)
})

test('other publications stay unchanged and missing, changed or duplicate repair sites fail explicitly', () => {
  assert.equal(applyHostCompatibility('another-plugin', '2.2.3', modules), modules)
  assert.equal(applyHostCompatibility('dsh-plugin', '2.2.4', modules), modules)
  for (const value of [{}, { [path]: new TextEncoder().encode('changed') }, { [path]: new TextEncoder().encode(published + published) }]) {
    assert.throws(() => applyHostCompatibility('dsh-plugin', '2.2.3', value), { code: 'HOST_COMPATIBILITY_MISMATCH' })
  }
})

test('published package resolution compiles the repaired module into content-addressed artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-host-compatibility-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'node_modules/dsh-plugin')
  await mkdir(join(directory, 'lib/http'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-plugin', version: '2.2.3', main: 'lib/index.js' }))
  await writeFile(join(directory, 'lib/index.js'), 'export { check } from "./http/install.js"')
  await writeFile(join(directory, path), published + '\nexport { check };')
  const resolver = new PnpmPackageResolver({ executable: 'pnpm', registry: 'https://registry.npmjs.org/', timeoutMs: 1000 })
  const store = new FileArtifactStore(join(root, 'objects'))
  const compiler = new ForgeCompiler({
    target: { protocol: 1, generation: 'host-compatibility', hostPackages: {}, sharedPackages: [] },
    resolver: { prepare: async () => {}, resolve: name => resolver.resolve(name, root, root) }, store,
    lowerModule: ({ source }) => ({ code: source, moduleRequests: [], metaResolveRequests: [] }),
  })
  const manifest = await compiler.buildPackage({ protocol: 1, generation: 'host-compatibility', pluginId: 'dsh-plugin', spec: 'dsh-plugin@2.2.3' })
  const file = manifest.packages[0]!.files.find(file => file.path === path)!
  const compiled = new TextDecoder().decode((await store.get(file.objectKey))!)
  assert.match(compiled, /https:\/\/registry\.npmjs\.org\/dsh-plugin\/latest/)
  await writeFile(join(directory, path), 'export const changed = true;')
  await assert.rejects(compiler.buildPackage({ protocol: 1, generation: 'host-compatibility', pluginId: 'dsh-plugin', spec: 'dsh-plugin@2.2.3' }), { code: 'HOST_COMPATIBILITY_MISMATCH' })
})
