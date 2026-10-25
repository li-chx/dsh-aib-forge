/** Fetch transport usable independently of the Node listener. */
import type { ArtifactStore } from './store.js'
import { ForgeError, parseBuildRequest, parsePackageBuildRequest, validateObjectKey } from './protocol.js'
import type { BuildExecutor, BuildTarget } from './protocol.js'

/** Deployment-controlled origins, byte limit and build concurrency. */
export interface HandlerOptions { target: BuildTarget; executor: BuildExecutor; store: ArtifactStore; allowedOrigins: readonly string[]; maxRequestBytes: number; maxConcurrentBuilds: number; onError?: (error: unknown) => void }
/** Create a service handler; non-browser callers omit Origin. */
export function createForgeHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  let active = 0
  return async request => {
    const origin = request.headers.get('origin')
    const cors: Record<string, string> = { Vary: 'Origin' }
    if (origin && !options.allowedOrigins.includes(origin)) return Response.json({ error: { code: 'ORIGIN_DENIED', message: 'This frontend origin is not allowed' } }, { status: 403, headers: cors })
    if (origin) cors['Access-Control-Allow-Origin'] = origin
    cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; cors['Access-Control-Allow-Headers'] = 'Content-Type'
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/v1/target') return Response.json(options.target, { headers: { ...cors, 'Cache-Control': 'no-store' } })
      if (request.method === 'GET' && url.pathname.startsWith('/v1/artifacts/')) {
        const key = url.pathname.slice('/v1/artifacts/'.length)
        validateObjectKey(key)
        if (!key.startsWith(options.target.generation + '/')) throw new ForgeError('GENERATION_MISMATCH', 'Artifact belongs to a different generation', 409)
        const data = await options.store.get(key)
        if (!data) throw new ForgeError('ARTIFACT_NOT_FOUND', 'Artifact does not exist', 404)
        return new Response(new Uint8Array(data), { headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${key.split('/').at(-1)}"` } })
      }
      if (request.method !== 'POST' || !['/v1/builds', '/v1/packages/builds'].includes(url.pathname)) throw new ForgeError('NOT_FOUND', 'Unknown Forge endpoint', 404)
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ForgeError('INVALID_CONTENT_TYPE', 'Expected application/json', 415)
      if (active >= options.maxConcurrentBuilds) throw new ForgeError('BUILD_CAPACITY', 'Build service is busy; retry later', 503)
      const reader = request.body?.getReader()
      if (!reader) throw new ForgeError('INVALID_REQUEST', 'Expected a request body')
      let bytes = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > options.maxRequestBytes) { await reader.cancel(); throw new ForgeError('REQUEST_TOO_LARGE', 'Build request exceeds the configured byte limit', 413) }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      let value: unknown
      const body = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
      catch (error) { throw new ForgeError('INVALID_JSON', error instanceof Error ? error.message : 'Invalid JSON') }
      const build = url.pathname === '/v1/packages/builds'
        ? (() => {
            const input = parsePackageBuildRequest(value)
            if (options.executor.buildPackage === undefined) throw new ForgeError('PACKAGE_BUILD_UNAVAILABLE', 'This executor does not support npm package builds', 501)
            return { generation: input.generation, run: () => options.executor.buildPackage!(input) }
          })()
        : (() => { const input = parseBuildRequest(value); return { generation: input.generation, run: () => options.executor.build(input) } })()
      if (build.generation !== options.target.generation) throw new ForgeError('GENERATION_MISMATCH', `Expected generation ${options.target.generation}`, 409)
      // Recheck after reading because several clients may upload concurrently.
      if (active >= options.maxConcurrentBuilds) throw new ForgeError('BUILD_CAPACITY', 'Build service is busy; retry later', 503)
      active++
      try { return Response.json(await build.run(), { headers: { ...cors, 'Cache-Control': 'no-store' } }) }
      finally { active-- }
    } catch (error) {
      if (error instanceof ForgeError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: cors })
      options.onError?.(error)
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Forge could not complete this request' } }, { status: 500, headers: cors })
    }
  }
}
