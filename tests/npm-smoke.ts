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
  const sources = new Map<string, string>()
  for (const pkg of manifest.packages) sources.set(pkg.id, new TextDecoder().decode(await store.get(pkg.files.find(file => file.path === pkg.entry)!.objectKey)))
  const cache = new Map<string, { exports: Record<string, unknown> }>()
  const load = (id: string): Record<string, unknown> => {
    const old = cache.get(id); if (old) return old.exports
    const pkg = manifest.packages.find(pkg => pkg.id === id)!
    const module = { exports: {} }; cache.set(id, module)
    new Function('module', 'exports', 'require', sources.get(id)!)(module, module.exports, (name: string) => load(pkg.dependencies[name]!))
    return module.exports
  }
  const plugin = load(manifest.plugin.packageId)
  assert.equal(typeof plugin.apply, 'function')
  if (typeof plugin.apply !== 'function') throw new Error('Missing plugin apply')
  assert.equal(plugin.apply(3), true); assert.equal(plugin.apply(4), false)
  console.log(JSON.stringify({ generation: manifest.generation, packages: manifest.packages.map(pkg => `${pkg.name}@${pkg.version}`), separateDependencies: true, execution: '3 odd; 4 even' }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
