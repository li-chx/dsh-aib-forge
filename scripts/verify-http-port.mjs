/** Real Chrome stream transfer through the same HTTP carrier used by a dedicated DSH Worker. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'

/** Run one isolated browser page; no DSH boot or external HTTP provider is needed. */
export async function verifyHttpPort(browser, origin, dshRoot) {
  const bundled = await build({
    stdin: { contents: `export { PortHttpTransport, serveHttpTransport } from './http-port.ts'; export { WorkerHttpTransport } from './http-transport.ts';`,
      resolveDir: resolve(dshRoot, 'packages/experimental/webworker-runtime/src/transport'), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  })
  const source = bundled.outputFiles[0].text
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`${origin}/__forge-http-test.html`)
    const observed = await page.evaluate(async source => {
      const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      const workerUrl = URL.createObjectURL(new Blob([`import { PortHttpTransport, WorkerHttpTransport } from ${JSON.stringify(moduleUrl)};

let cancellation;
onmessage = async event => {
  if (event.data.type === 'abort') { cancellation.abort(); return; }
  if (event.data.type !== 'start') return;
  const provider = new PortHttpTransport(event.ports[0]);
  const http = new WorkerHttpTransport(provider);
  try {
    const response = await http.fetch(new Request('https://rpc.invalid/stream', {
      method: 'POST', headers: { 'x-http-proof': 'dedicated-worker' }, body: 'uploaded input',
    }));
    const reader = response.body.getReader();
    const first = await reader.read();
    postMessage({ type: 'first', chunk: new TextDecoder().decode(first.value), status: response.status, header: response.headers.get('x-provider') });
    const second = await reader.read();
    const end = await reader.read();
    postMessage({ type: 'completed', chunk: new TextDecoder().decode(second.value), done: end.done });
    cancellation = new AbortController();
    const cancelResponse = await http.fetch(new Request('https://rpc.invalid/abort', { signal: cancellation.signal }));
    const cancelReader = cancelResponse.body.getReader();
    await cancelReader.read();
    postMessage({ type: 'abort-ready' });
    try { await cancelReader.read(); throw new Error('Cancelled HTTP response completed instead of rejecting'); }
    catch (error) {
      if (!cancellation.signal.aborted) throw error;
      postMessage({ type: 'aborted', name: error.name });
    }
  } catch (error) { postMessage({ type: 'failure', message: error.stack || String(error) }); }
  finally { http.close(); provider.close(); }
};
`], { type: 'text/javascript' }))
      let worker
      let dispose
      const deadline = async (promise, stage) => {
        let timer
        try {
          return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`HTTP port timed out: ${stage}`)), 15000)
          })])
        } finally { clearTimeout(timer) }
      }
      try {
        const { serveHttpTransport } = await import(moduleUrl)
        worker = new Worker(workerUrl, { type: 'module' })
        const messages = []
        const waiting = new Set()
        let failure
        worker.addEventListener('message', event => {
          if (event.data.type === 'failure') failure = new Error(event.data.message)
          messages.push(event.data)
          for (const wake of waiting) wake()
        })
        worker.addEventListener('error', event => {
          failure = new Error(event.message)
          for (const wake of waiting) wake()
        })
        const message = type => deadline(new Promise((accept, reject) => {
          const check = () => {
            const value = messages.find(value => value.type === type)
            if (failure || value) { waiting.delete(check); if (failure) reject(failure); else accept(value) }
          }
          waiting.add(check)
          check()
        }), type)
        const channel = new MessageChannel()
        let request
        let stream
        let abortSignal
        let cancelStream
        const sawAbort = new Promise(accept => { abortSignal = accept })
        const sawCancel = new Promise(accept => { cancelStream = accept })
        dispose = serveHttpTransport(channel.port1, {
          async fetch(input) {
            if (new URL(input.url).pathname === '/stream') {
              request = { method: input.method, header: input.headers.get('x-http-proof'), body: await input.text() }
              return new Response(new ReadableStream({ start(controller) {
                stream = controller
                controller.enqueue(new TextEncoder().encode('first'))
              } }), { status: 207, headers: { 'x-provider': 'page' } })
            }
            if (new URL(input.url).pathname !== '/abort') throw new Error(`Unexpected HTTP request ${input.url}`)
            input.signal.addEventListener('abort', () => abortSignal(true), { once: true })
            return new Response(new ReadableStream({
              start(controller) { controller.enqueue(new TextEncoder().encode('pending')) },
              cancel() { cancelStream(true) },
            }))
          },
        })
        worker.postMessage({ type: 'start' }, [channel.port2])
        // The second chunk does not exist until the Worker acknowledges reading the first.
        const first = await message('first')
        stream.enqueue(new TextEncoder().encode('second'))
        stream.close()
        const completed = await message('completed')
        await message('abort-ready')
        worker.postMessage({ type: 'abort' })
        const aborted = await message('aborted')
        await deadline(Promise.all([sawAbort, sawCancel]), 'provider cancellation')
        return { request, first, completed, aborted, providerCancelled: true, dedicatedWorker: true }
      } finally {
        dispose?.()
        worker?.terminate()
        URL.revokeObjectURL(moduleUrl)
        URL.revokeObjectURL(workerUrl)
      }
    }, source)
    assert.deepEqual(observed.request, { method: 'POST', header: 'dedicated-worker', body: 'uploaded input' })
    assert.deepEqual(observed.first, { type: 'first', chunk: 'first', status: 207, header: 'page' })
    assert.deepEqual(observed.completed, { type: 'completed', chunk: 'second', done: true })
    assert.equal(observed.aborted.name, 'AbortError')
    assert.equal(observed.providerCancelled, true)
    assert.deepEqual(errors, [])
    return { dedicatedWorker: true, postFields: true, progressiveResponse: true, abortReachedProvider: true }
  } finally { await page.close() }
}
