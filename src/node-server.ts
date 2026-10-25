/** Node HTTP adapter for the Fetch handler, with explicit listener lifecycle. */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Readable } from 'node:stream'

/** Running listener returned to callers for coordinated teardown. */
export interface RunningServer { server: Server; url: string; close(): Promise<void> }
/** Start a listener; port zero allocates an isolated port for tests. */
export async function startForgeServer(handler: (request: Request) => Promise<Response>, options: { hostname: string; port: number }): Promise<RunningServer> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
      const init: RequestInit & { duplex?: 'half' } = { method: incoming.method ?? 'GET', headers }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') { init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>; init.duplex = 'half' }
      const response = await handler(new Request(`http://localhost${incoming.url ?? '/'}`, init))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const reader = response.body.getReader()
        try { while (true) { const part = await reader.read(); if (part.done) break; outgoing.write(part.value) } }
        finally { reader.releaseLock() }
      }
      outgoing.end()
    } catch (error) {
      // Request parsing/connection failures cannot enter the Fetch error mapper.
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { code: 'TRANSPORT_ERROR', message: 'HTTP transport failed' } }))
      if (error instanceof Error && error.name !== 'AbortError') server.emit('forge-transport-error', error)
    }
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port, options.hostname, () => { server.off('error', reject); accept() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return { server, url: `http://${options.hostname}:${address.port}`, close: () => new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeIdleConnections() }) }
}
