/** Real Chrome, HTTP compiler and Worker lifecycle acceptance without model API credentials. */
import { resolveDshRoot } from './dsh-path.mjs'
import { imageTarget } from './image-target.mjs'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { FileArtifactStore, ForgeCompiler, PnpmPackageResolver, createForgeHandler, loadDshLowerer, startForgeServer } from '../dist/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { 'dsh-root': { type: 'string' }, npm: { type: 'boolean', default: false }, 'refresh-snapshot': { type: 'boolean', default: false } } })
const dshRoot = resolveDshRoot(values['dsh-root'])
const { chromium } = await import(pathToFileURL(resolve(dshRoot, 'apps/web/node_modules/playwright/index.mjs')).href)
const site = resolve(root, '.data/preview/site')
const target = JSON.parse(await readFile(resolve(root, '.data/preview/target.json'), 'utf8'))
const { packRepositoryImage } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-packer/lib/index.js')).href)
const { IMAGE_FILE_NAME, FORGE_GENERATION, forgeSharedPackages } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')).href)
const packed = packRepositoryImage(dshRoot, 'web')
assert.deepEqual(packed.missing, [])
assert.deepEqual(target, imageTarget(packed, FORGE_GENERATION, forgeSharedPackages), 'Prepared target differs from selected DSH image; run preview:prepare for this checkout')
const images = new Map([[`/preview/${IMAGE_FILE_NAME}`, packed.image], ...packed.lazyArchives.map(archive => [`/preview/${archive.name}`, archive.image])])
const temporary = await mkdtemp(join(tmpdir(), 'dsh-forge-browser-'))
const logs = []
const frontend = createServer((request, response) => {
  void (async () => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      const image = images.get(path)
      if (image) { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(image); return }
      const filename = resolve(site, '.' + path)
      if (!filename.startsWith(site + sep)) throw new Error('Outside static root')
      const body = await readFile(filename)
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.woff2': 'font/woff2' }
      response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404); response.end()
    }
  })()
})
let backend
let browser
let corruptArtifact = false
try {
  frontend.listen(0, '127.0.0.1')
  await once(frontend, 'listening')
  const address = frontend.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const store = new FileArtifactStore(join(temporary, 'objects'))
  const executor = new ForgeCompiler({ target, store,
    resolver: new PnpmPackageResolver({ executable: 'pnpm', registry: 'https://registry.npmjs.org/', timeoutMs: 120000 }),
    lowerModule: await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')),
  })
  const handler = createForgeHandler({ target, executor, store, allowedOrigins: [origin], maxRequestBytes: 2 * 1024 * 1024, maxConcurrentBuilds: 1, onError: error => logs.push(String(error)) })
  backend = await startForgeServer(async request => {
    if (corruptArtifact && new URL(request.url).pathname.startsWith('/v1/artifacts/')) {
      return new Response('corrupted', { headers: { 'Access-Control-Allow-Origin': origin } })
    }
    return handler(request)
  }, { hostname: '127.0.0.1', port: 0 })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ locale: 'en-US' })
  page.setDefaultTimeout(120000)
  page.on('console', message => logs.push(message.text()))
  page.on('pageerror', error => logs.push(error.message))
  let workers = 0
  page.on('worker', () => { workers++ })
  await page.goto(`${origin}/preview.html?preview-fixture=none&forge=${encodeURIComponent(backend.url)}`)
  await page.getByRole('button', { name: 'DSH Forge', exact: true }).click()
  const panel = page.locator('[data-forge-preview]')
  const status = panel.locator('[role="status"]')
  await waitStatus('Ready')
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  const session = await rpc('session/create', { request: { cwd: '/dsh/workspace' } })
  const command = () => rpc('commands/execute', { agentId: session.sessionId, line: '/forge-test', submittedAttachments: [] })

  await build()
  assert.match(await status.textContent(), /^Active\n/)
  const first = await command()
  assert.equal(first.result.text, 'test v1')
  const source = panel.getByLabel('TypeScript source', { exact: true })
  await source.fill((await source.inputValue()).replace('test v1', 'test v2'))
  const secondManifest = await build()
  assert.match(await status.textContent(), /^Active\n/)
  logs.push('Installed v2: ' + JSON.stringify(await runtime('/__forge/installed')))
  const second = await command()
  assert.equal(second.result.text, 'test v2')
  const installed = await runtime('/__forge/installed')
  assert.equal(installed.plugins.length, 1)
  assert.equal(installed.plugins[0].status, 'active')
  assert(installed.batches.some(event => event.phase === 'activation' && event.paths.length > 0), JSON.stringify(installed.batches))

  await page.screenshot({ path: resolve(root, '.data/forge-chrome.png') })
  const dark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  await page.screenshot({ path: resolve(root, '.data/forge-chrome-dark.png') })
  await page.evaluate(wasDark => { document.body.toggleAttribute('data-ds-dark-theme', wasDark) }, dark)
  await build()
  assert.match(await status.textContent(), /Downloaded files: 0 · Written files: 0/)

  const negative = structuredClone(secondManifest)
  negative.generation = 'different-generation'
  await rejectedInstall(negative, 'generation-mismatch')
  const core = structuredClone(secondManifest)
  core.packages[0].name = '@deepseek-ai/dsh-core'
  await rejectedInstall(core, 'core-package')
  const damagedResponse = await fetch(`${backend.url}/v1/builds`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 1, generation: target.generation, plugin: {
      id: 'forge-test', name: 'local-forge-test', version: '0.0.1', entry: 'src/index.ts',
      files: { 'src/index.ts': (await source.inputValue()).replace('test v2', 'test v3') }, dependencies: {}, peerDependencies: {},
    } }),
  })
  assert.equal(damagedResponse.status, 200)
  corruptArtifact = true
  try { await rejectedInstall(await damagedResponse.json(), 'integrity-failed') }
  finally { corruptArtifact = false }
  assert.equal((await command()).result.text, 'test v2')

  let dependencyResult
  if (values.npm) {
    await panel.getByLabel('Dependencies (JSON)', { exact: true }).fill(JSON.stringify({ 'is-odd': '3.0.1' }))
    await source.fill(`import isOdd from 'is-odd'\n` + (await source.inputValue()).replace("text: 'test v2'", "text: isOdd(3) ? 'odd' : 'even'"))
    const manifest = await build()
    assert(manifest.packages.some(pkg => pkg.name === 'is-odd'))
    const result = await command()
    assert.equal(result.result.text, 'odd')
    dependencyResult = { command: result.result.text, packages: manifest.packages.map(pkg => pkg.name).sort() }
  }
  await panel.getByRole('button', { name: 'Remove plugin', exact: true }).click()
  await waitStatus('Removed')
  const removed = await command()
  assert.equal(removed, undefined)
  assert.equal((await runtime('/__forge/installed')).plugins.length, 0)
  assert.equal(workers, 1)
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
  const observed = { command: [first.result.text, second.result.text], repeatedInstall: { downloadedFiles: 0, writtenFiles: 0 }, removed: true, workerStarts: workers, documentPreserved: true, fileBatchReported: true, rejectedBeforeWrite: ['generation-mismatch', 'core-package', 'integrity-failed'] }
  const text = JSON.stringify(observed, null, 2) + '\n'
  const golden = resolve(root, 'tests/expected/browser-lifecycle.json')
  if (values['refresh-snapshot']) await writeFile(golden, text)
  else assert.equal(text, await readFile(golden, 'utf8'))
  console.log(JSON.stringify({ ...observed, ...(dependencyResult ? { npm: dependencyResult } : {}) }, null, 2))

  async function waitStatus(prefix) {
    await page.waitForFunction(expected => {
      const text = document.querySelector('[data-forge-preview] [role="status"]')?.textContent ?? ''
      return text.startsWith(expected)
    }, prefix)
  }
  async function build() {
    const response = page.waitForResponse(value => value.url() === `${backend.url}/v1/builds` && value.request().method() === 'POST')
    await panel.getByRole('button', { name: 'Build and install', exact: true }).click()
    const result = await response
    const manifest = await result.json()
    assert.equal(result.status(), 200, JSON.stringify(manifest))
    await page.waitForFunction(() => document.querySelector('[data-forge-preview] fieldset')?.disabled === false)
    assert.match(await status.textContent(), /^Active\n/, await status.textContent())
    return manifest
  }
  async function rejectedInstall(manifest, code) {
    const result = await page.evaluate(async ({ manifest, baseUrl }) => {
      const response = await window.__DSH_TRANSPORT__.fetch('/__forge/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest, baseUrl }) })
      return { status: response.status, body: await response.json() }
    }, { manifest, baseUrl: backend.url })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, code)
  }
  async function runtime(path, payload) {
    return page.evaluate(async ({ path, payload }) => {
      const response = await window.__DSH_TRANSPORT__.fetch(path, payload === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const value = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(value))
      return value
    }, { path, payload })
  }
  async function rpc(method, args) {
    const envelope = await runtime(`/api/${method}`, { type: 'client-request', rpcId: method, method, payload: { args } })
    assert.equal(envelope.result?.ok, true, JSON.stringify(envelope))
    return envelope.result.value
  }
} catch (error) {
  console.error(logs.join('\n'))
  throw error
} finally {
  await browser?.close()
  await backend?.close()
  frontend.closeAllConnections()
  if (frontend.listening) await new Promise((accept, reject) => frontend.close(error => error ? reject(error) : accept()))
  await rm(temporary, { recursive: true, force: true })
}
