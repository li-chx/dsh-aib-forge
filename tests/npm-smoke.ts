/** Explicit network smoke: is-odd and its transitive is-number stay separate. */
import { dshRoot } from './dsh-root.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileArtifactStore, ForgeCompiler, PnpmPackageResolver, loadDshLowerer } from '../src/index.js'

const runtime = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')).href)
const generation: unknown = runtime.FORGE_GENERATION
assert.equal(typeof generation, 'string', 'Selected DSH build must export FORGE_GENERATION')
if (typeof generation !== 'string') throw new Error('Missing runtime generation')

const root = await mkdtemp(join(tmpdir(), 'forge-npm-smoke-'))
try {
  const store = new FileArtifactStore(join(root, 'objects'))
  const compiler = new ForgeCompiler({ target: { protocol: 1, generation, sharedPackages: [], hostPackages: {} }, store,
    resolver: new PnpmPackageResolver({ executable: 'pnpm', timeoutMs: 120000, registry: 'https://registry.npmjs.org/' }),
    lowerModule: await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')),
  })
  const manifest = await compiler.build({ protocol: 1, generation, plugin: { id: 'npm-smoke', name: 'npm-smoke', version: '1.0.0', entry: 'index.ts', files: { 'index.ts': 'import isOdd from "is-odd"; export const apply = (value: number) => isOdd(value)' }, dependencies: { 'is-odd': '3.0.1' }, peerDependencies: {} } })
  assert.deepEqual(manifest.packages.map(pkg => pkg.name).sort(), ['is-number', 'is-odd', 'npm-smoke'])
  const vfs = new runtime.MemoryVfs()
  const modules = new runtime.WorkerModuleLoader({ vfs, root: '/app', staticModules: {} })
  const scopes = new Map<string, Record<string, string>>()
  for (const pkg of manifest.packages) {
    const directory = `/app/packages/${pkg.id}`
    vfs.mkdirSync(directory, { recursive: true })
    vfs.writeFileSync(`${directory}/package.json`, JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.entry, ...pkg.metadata }))
    for (const file of pkg.files) {
      const path = `${directory}/${file.path}`
      vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      vfs.writeFileSync(path, (await store.get(file.objectKey))!)
    }
    scopes.set(directory, Object.fromEntries([[pkg.name, directory], ...Object.entries(pkg.dependencies).map(([name, id]) => [name, `/app/packages/${id}`])]))
  }
  modules.setPackageScopes(scopes)
  const plugin = modules.createRequire('/app/main.js')(`/app/packages/${manifest.plugin.packageId}/${manifest.plugin.entry}`)
  assert.equal(typeof plugin.apply, 'function')
  if (typeof plugin.apply !== 'function') throw new Error('Missing plugin apply')
  assert.equal(plugin.apply(3), true); assert.equal(plugin.apply(4), false)
  console.log(JSON.stringify({ generation: manifest.generation, packages: manifest.packages.map(pkg => `${pkg.name}@${pkg.version}`), separateDependencies: true, execution: '3 odd; 4 even' }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
