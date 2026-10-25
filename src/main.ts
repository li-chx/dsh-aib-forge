/** Long-running development service, configured for one immutable DSH target. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ForgeCompiler, loadDshLowerer, validateTarget } from './compiler.js'
import { FileArtifactStore } from './store.js'
import { PnpmPackageResolver } from './resolver.js'
import { createForgeHandler } from './http.js'
import { startForgeServer } from './node-server.js'

const { values } = parseArgs({ options: {
  target: { type: 'string' }, 'dsh-root': { type: 'string' }, transformer: { type: 'string' },
  port: { type: 'string', default: '36936' }, host: { type: 'string', default: '127.0.0.1' },
  storage: { type: 'string', default: '.data/artifacts' }, origin: { type: 'string', multiple: true, default: [] },
  'allow-host-patch-upgrade': { type: 'string', multiple: true, default: [] },
  pnpm: { type: 'string', default: 'pnpm' }, registry: { type: 'string', default: 'https://registry.npmjs.org/' },
  'install-timeout-ms': { type: 'string', default: '120000' }, 'max-request-bytes': { type: 'string', default: '2097152' }, 'max-builds': { type: 'string', default: '2' },
} })
if (!values.target || (!values.transformer && !values['dsh-root'])) throw new Error('Usage: pnpm dev --target target.json --dsh-root ../deepseek-harness --origin http://localhost:36935')
const target = z.object({ protocol: z.literal(1), generation: z.string(), hostPackages: z.record(z.string(), z.string()), clientPackages: z.record(z.string(), z.string()).default({}) }).strict().parse(JSON.parse(await readFile(values.target, 'utf8')))
validateTarget(target)
const number = (value: string, name: string): number => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}`); return parsed }
const port = number(values.port, 'port')
if (port > 65535) throw new Error('Port must be at most 65535')
const transformerPath = values.transformer ?? resolve(values['dsh-root']!, 'packages/experimental/webworker-runtime/lib/index.js')
const store = new FileArtifactStore(resolve(values.storage))
const executor = new ForgeCompiler({ target, store, allowHostPatchUpgrade: values['allow-host-patch-upgrade'], resolver: new PnpmPackageResolver({ executable: values.pnpm, registry: values.registry, timeoutMs: number(values['install-timeout-ms'], 'install timeout') }), lowerModule: await loadDshLowerer(transformerPath) })
const running = await startForgeServer(createForgeHandler({ target, executor, store, allowedOrigins: values.origin, maxRequestBytes: number(values['max-request-bytes'], 'request size'), maxConcurrentBuilds: number(values['max-builds'], 'concurrency'), onError: error => console.error(error) }), { hostname: values.host, port })
console.log(`DSH Forge ${target.generation} listening at ${running.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void running.close().catch(error => { console.error(error); process.exitCode = 1 }) })
