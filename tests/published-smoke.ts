/** Explicit registry smoke for the published dsh-plugin Host/bundle/Client artifacts. */
import { dshRoot } from './dsh-root.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ForgeCompiler, FileArtifactStore, PnpmPackageResolver, loadDshLowerer, createForgeHandler, startForgeServer } from '../src/index.js'

const runtime = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')).href)
const generation: unknown = runtime.FORGE_GENERATION
assert.equal(typeof generation, 'string', 'Selected DSH build must export FORGE_GENERATION')
if (typeof generation !== 'string') throw new Error('Missing runtime generation')

const cordis: { version: string } = JSON.parse(await readFile(resolve(dshRoot, 'vendor/cordis/package.json'), 'utf8'))
assert.equal(typeof cordis.version, 'string')

const directory = await mkdtemp(join(tmpdir(), 'forge-published-'))
try {
  const target = { protocol: 1 as const, generation, hostPackages: { '@deepseek-ai/cordis': cordis.version } }
  const store = new FileArtifactStore(join(directory, 'objects'))
  const executor = new ForgeCompiler({ target, store, resolver: new PnpmPackageResolver({ executable: 'pnpm', timeoutMs: 120000, registry: 'https://registry.npmjs.org/' }), lowerModule: await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')), allowHostPatchUpgrade: ['@deepseek-ai/cordis'] })
  const server = await startForgeServer(createForgeHandler({ target, executor, store, allowedOrigins: [], maxRequestBytes: 8192, maxConcurrentBuilds: 1 }), { hostname: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(server.url + '/v1/packages/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: 'dsh-plugin', spec: 'dsh-plugin@2.2.1' }) })
    const manifest = await response.json(); assert.equal(response.status, 200, JSON.stringify(manifest))
    assert.deepEqual(manifest.hostPackages, { '@deepseek-ai/cordis': cordis.version })
    const pkg = manifest.packages.find((pkg: { name: string }) => pkg.name === 'dsh-plugin')
    assert.equal(pkg.metadata.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.entry, 'lib/index.js')
    assert.equal(pkg.metadata.exports['.'], './' + pkg.entry)
    assert.deepEqual(pkg.metadata.repository, { url: 'git+https://github.com/dshplugin/dsh-plugin-hub.git' })
    const paths = pkg.files.map((file: { path: string }) => file.path)
    for (const path of ['client/client.js', 'cordis.patch.yml', 'lib/index.js']) assert(paths.includes(path))
    assert(!paths.includes('package.json'))
    assert(paths.includes('README.md'), 'Published resources accompany the compiled entry')
    for (const file of pkg.files) assert.equal((await fetch(server.url + '/v1/artifacts/' + file.objectKey)).status, 200)
    console.log(JSON.stringify({ generation: manifest.generation, name: pkg.name, version: pkg.version, hostPackages: manifest.hostPackages, files: pkg.files.map((file: { path: string; size: number }) => ({ path: file.path, size: file.size })), metadata: pkg.metadata }, null, 2))
  } finally { await server.close() }
} finally { await rm(directory, { recursive: true, force: true }) }
