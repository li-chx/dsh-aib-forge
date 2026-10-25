/** Published marketplace acceptance through its real UI, HTTP routes and subprocess install queue. */
import { resolveDshRoot } from './dsh-path.mjs'
import { imageTarget } from './image-target.mjs'
import assert from 'node:assert/strict'
import { verifyHttpPort } from './verify-http-port.mjs'
import { verifyMobilePlugin } from './verify-mobile-plugin.mjs'
import { verifyExtraPlugins } from './verify-extra-plugins.mjs'
import { verifyIndustryPlugin } from './verify-industry-plugin.mjs'
import { overrideFixtureName, overrideFixtures, verifyBundleOverrides } from './verify-bundle-overrides.mjs'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { FileArtifactStore, ForgeCompiler, PnpmPackageResolver, createForgeHandler, loadDshLowerer, startForgeServer } from '../dist/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { 'dsh-root': { type: 'string' }, 'preview-root': { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, chinese: { type: 'boolean', default: false }, 'default-id': { type: 'boolean', default: false }, 'ui-install': { type: 'boolean', default: true }, 'native-enable': { type: 'boolean', default: true }, 'refresh-snapshot': { type: 'boolean', default: false } } })
let chinese = values.chinese
const zhCopy = { Ready: '就绪', Active: '已激活', 'Plugin ID': '插件 ID', 'Install npm package': '安装 npm 包', Close: '关闭', Continue: '继续', 'Get started': '开始使用', 'Add API Key': '添加 API Key', 'Configure later': '稍后配置', 'Account menu': '账号菜单', Settings: '设置', 'Plugin Hub': '插件市场' }
const copy = text => chinese ? zhCopy[text] ?? text : text
const dshRoot = resolveDshRoot(values['dsh-root'])
const { chromium } = await import(pathToFileURL(resolve(dshRoot, 'apps/web/node_modules/playwright/index.mjs')).href)
const previewRoot = resolve(values['preview-root'] ?? resolve(root, '.data/preview'))
const site = resolve(previewRoot, 'site')
const target = JSON.parse(await readFile(resolve(previewRoot, 'target.json'), 'utf8'))
const { packRepositoryImage } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-packer/lib/index.js')).href)
const { IMAGE_FILE_NAME, FORGE_GENERATION } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')).href)
const packed = packRepositoryImage(dshRoot, 'web')
assert.deepEqual(packed.missing, [])
assert.deepEqual(target, imageTarget(packed, FORGE_GENERATION), 'Prepared target differs from selected DSH image; run preview:prepare for this checkout')
const images = new Map([[`/preview/${IMAGE_FILE_NAME}`, packed.image], ...packed.lazyArchives.map(archive => [`/preview/${archive.name}`, archive.image])])
const temporary = await mkdtemp(join(tmpdir(), 'dsh-forge-hub-'))
const fixtureName = 'forge-hub-acceptance-plugin'
const fixtureConfig = { label: 'retained', enabled: true, nested: { count: 7, flags: [false, true], empty: null } }
let registry
const logs = []
const frontend = createServer((request, response) => {
  void (async () => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      if (path === '/__forge-http-test.html') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>HTTP transport acceptance</title>'); return
      }
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
let whaleBuildFailure
let browser
try {
  frontend.listen(0, values.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
  await once(frontend, 'listening')
  const address = frontend.address()
  assert(address && typeof address !== 'string')
  const origin = `http://${values.host}:${address.port}`
  registry = await startRegistry()
  const store = new FileArtifactStore(join(temporary, 'objects'))
  const executor = new ForgeCompiler({ target, store, allowHostPatchUpgrade: ['@deepseek-ai/cordis'],
    resolver: new PnpmPackageResolver({ executable: 'pnpm', registry: registry.url, timeoutMs: 120000 }),
    lowerModule: await loadDshLowerer(resolve(dshRoot, 'packages/experimental/webworker-runtime/lib/index.js')),
  })
  const handler = createForgeHandler({ target, executor, store, allowedOrigins: [origin], maxRequestBytes: 2 * 1024 * 1024, maxConcurrentBuilds: 1, onError: error => logs.push(String(error)) })
  backend = await startForgeServer(async request => {
    const isBuild = request.method === 'POST' && new URL(request.url).pathname === '/v1/packages/builds'
    const build = isBuild ? await request.clone().json() : undefined
    const response = await handler(request)
    if (build?.spec === 'dsh-whale-widget@0.4.2') whaleBuildFailure = { status: response.status, body: await response.clone().json() }
    return response
  }, { hostname: '127.0.0.1', port: 0 })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const httpPort = await verifyHttpPort(browser, origin, dshRoot)
  console.log('Dedicated Worker HTTP port streaming and cancellation passed')
  const page = await browser.newPage({ locale: chinese ? 'zh-CN' : 'en-US', viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(30000)
  page.on('console', message => {
    logs.push(message.text())
    if (message.type() === 'error') for (const arg of message.args()) {
      void arg.evaluate(value => value instanceof Error ? value.stack : undefined).then(stack => { if (stack) logs.push(stack) }).catch(() => {})
    }
  })
  page.on('pageerror', error => logs.push(error.message))
  let partialVersionObserved = false
  let workers = 0
  page.on('worker', () => { workers++ })
  await page.goto(`${origin}/preview.html?preview-fixture=none&forge=${encodeURIComponent(backend.url)}`)
  await page.getByRole('button', { name: 'DSH Forge', exact: true }).click()
  const panel = page.locator('[data-forge-preview]')
  const status = panel.locator('[role="status"]')
  await waitStatus(copy('Ready'))
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  if (!values['default-id']) await panel.getByLabel(copy('Plugin ID'), { exact: true }).fill('dsh-plugin')
  const built = page.waitForResponse(response => response.url() === `${backend.url}/v1/packages/builds` && response.request().method() === 'POST')
  await panel.getByRole('button', { name: copy('Install npm package'), exact: true }).click()
  const buildResponse = await built
  const manifest = await buildResponse.json()
  assert.equal(buildResponse.status(), 200, JSON.stringify(manifest))
  await page.waitForFunction(() => document.querySelector('[data-forge-preview] fieldset')?.disabled === false)
  assert((await status.textContent()).startsWith(copy('Active') + '\n'), await status.textContent())
  console.log('Hub Host activated')
  await page.locator('style[data-plugin="dsh-plugin"]').first().waitFor({ state: 'attached', timeout: 15000 })
  console.log('Hub Client factory materialized')
  const environment = await hub('/env')
  console.log('Hub environment route ready')
  assert.equal(typeof environment, 'object')
  const installedHub = await hub('/installed')
  console.log('Hub installed route ready')
  assert.equal(installedHub.installed['dsh-plugin'], '2.2.1')
  assert(installedHub.loaded.includes('dsh-plugin'), JSON.stringify(installedHub))
  await panel.getByRole('button', { name: copy('Close'), exact: true }).click()
  console.log('Forge panel closed')
  const welcome = page.getByRole('button', { name: copy('Continue'), exact: true })
  if (await welcome.isVisible()) await welcome.click()
  const setup = page.getByRole('dialog', { name: copy('Get started'), exact: true })
  await setup.getByRole('button', { name: copy('Add API Key'), exact: true }).click()
  await page.getByRole('button', { name: copy('Configure later'), exact: true }).click()
  await page.getByRole('button', { name: chinese ? '插件' : 'Plugins', exact: true }).click()
  console.log('Native Plugins page opened before marketplace')
  if (values['native-enable']) {
    const toggle = page.locator('[data-plugin-package="dsh-plugin"]').getByRole('switch')
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Installing a published bundle selects its native toggle')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-package="dsh-plugin"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
    const disabled = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(disabled.plugins.find(plugin => plugin.name === 'dsh-plugin')?.status, 'disabled', JSON.stringify(disabled))
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-plugin-package="dsh-plugin"] [role="switch"]')?.getAttribute('aria-checked') === 'true')
    await page.locator('style[data-plugin="dsh-plugin"]').first().waitFor({ state: 'attached' })
    const active = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(active.plugins.find(plugin => plugin.name === 'dsh-plugin')?.status, 'active', JSON.stringify(active))
    const entries = (await hub('/debug/loader-entries')).entries.filter(entry => entry.name === 'dsh-plugin')
    assert.equal(entries.length, 1, JSON.stringify(entries))
    console.log('Native Plugins toggle leaves exactly one Hub registration')
  }
  console.log('Opening account menu')
  await page.getByRole('button', { name: copy('Account menu'), exact: true }).click()
  await page.getByRole('menuitem', { name: copy('Settings'), exact: true }).click()
  await page.getByRole('button', { name: copy('Plugin Hub'), exact: true }).click()
  await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
  console.log('Hub settings UI visible')

  // These requests enter the published plugin's curl and node:https code paths.
  const catalog = await hub('/catalog?stats=1&refresh=1')
  assert.equal(typeof catalog.total, 'number')
  assert(catalog.total > 0)
  const listing = await hub(`/catalog?lang=${chinese ? 'zh' : 'en'}&refresh=1`)
  assert(Array.isArray(listing) && listing.length > 0)
  assert.equal(typeof listing[0].n, 'string')
  await page.getByText(listing[0].n, { exact: true }).first().waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(root, '.data/forge-plugin-hub.png') })
  if (values['ui-install']) {
    await page.exposeFunction('recordInstalledForAcceptance', value => {
      if (Object.values(value.versions ?? {}).some(record => record.npmPackage === 'dsh-web-mobile' && record.version === undefined)) partialVersionObserved = true
      if (value.installed?.['dsh-web-mobile']) console.log('UI installed response: ' + JSON.stringify(value))
    })
    await page.evaluate(() => {
      const previous = window.fetch
      window.fetch = async (...args) => {
        const response = await previous(...args)
        const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href)
        if (url.pathname === '/dsh-plugin-hub/installed') {
          void response.clone().json().then(value => window.recordInstalledForAcceptance(value))
        }
        return response
      }
    })
    const settings = await hub('/settings')
    console.log('Hub default install configuration: ' + JSON.stringify({ npmRegistry: settings.npmRegistry, enableNpmInstall: settings.enableNpmInstall, registryFallback: settings.registryFallback }))
    const mobileEntry = listing.find(item => JSON.stringify(item.r).includes('dsh-web-mobile'))
    assert(mobileEntry, 'Published catalog contains mobile plugin')
    console.log('UI install catalog target: ' + JSON.stringify(mobileEntry))
    await page.getByPlaceholder(chinese ? '搜索插件名称、描述、标签…' : 'Search plugins by name, description, tags…').fill(mobileEntry.n)
    const card = page.locator('div').filter({ has: page.getByText(mobileEntry.n, { exact: true }) }).filter({ has: page.getByRole('button', { name: chinese ? '安装' : 'Install', exact: true }) }).last()
    await card.getByRole('button', { name: chinese ? '安装' : 'Install', exact: true }).click()
    const installDialog = page.getByRole('dialog').last()
    await installDialog.getByRole('button', { name: chinese ? '直接安装' : 'Install', exact: true }).click()
    console.log('Clicked real marketplace Install confirmation')
    await page.waitForFunction(() => document.querySelector('[data-slot-error]') || [...document.querySelectorAll('button')].some(button => /^(Done|完成|Got it|知道了)$/.test(button.textContent ?? '')), undefined, { timeout: 90000 })
    console.log('UI result dialog: ' + await page.getByRole('dialog').last().innerText())
    console.log('Post-install slot errors: ' + await page.locator('[data-slot-error]').count())
    console.log('Post-install Host state: ' + JSON.stringify(await hub('/installed')))
    await page.screenshot({ path: resolve(root, '.data/forge-marketplace-ui-install.png') })
    assert.equal(await page.locator('[data-slot-error]').count(), 0, 'Marketplace must survive its own UI install completion')
    await page.getByRole('button', { name: chinese ? '完成' : 'Done', exact: true }).click()
    await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
    await page.getByPlaceholder(chinese ? '搜索插件名称、描述、标签…' : 'Search plugins by name, description, tags…').fill('')
    console.log('Real marketplace UI install completed and panel survived; partial version record observed: ' + partialVersionObserved)
  }

  for (let reopen = 0; reopen < 3; reopen++) {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: copy('Settings'), exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: copy('Account menu'), exact: true }).click()
    await page.getByRole('menuitem', { name: copy('Settings'), exact: true }).click()
    await page.getByRole('button', { name: copy('Plugin Hub'), exact: true }).click()
    await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
    await page.getByText(listing[0].n, { exact: true }).first().waitFor({ state: 'visible' })
    console.log(`Hub settings reopened ${reopen + 1}`)
  }
  const managerHub = (await rpc('pluginManager/listBundles', {})).find(bundle => bundle.name === 'dsh-plugin')
  assert.equal(managerHub?.availability, 'profile', JSON.stringify(managerHub))
  assert.equal(managerHub.error, undefined, JSON.stringify(managerHub))
  if (!chinese) {
    await page.getByText('General', { exact: true }).click()
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
  }
  await page.getByRole('button', { name: '插件市场', exact: true }).click()
  await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  console.log('Chinese Hub settings rendered')
  await page.getByText('通用设置', { exact: true }).click()
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()
  chinese = false
  await page.getByRole('button', { name: copy('Plugin Hub'), exact: true }).click()
  const release = await hub('/npm-release-age', { packages: ['dsh-plugin'] })
  assert.equal(typeof release.packages?.['dsh-plugin']?.version, 'string', JSON.stringify(release))
  console.log('Hub catalog and release metadata fetched')
  await hub('/settings', { enableNpmInstall: true, npmRegistry: registry.url, registryFallback: false, proxy: '' })
  const created = await hub('/install', { repo: fixtureName, source: 'custom', installChannel: 'npm', lang: 'en', version: '1.0.0' })
  assert.equal(created.ok, true)
  const installTask = await waitTask(created.task)
  assert.equal(installTask.status, 'done', JSON.stringify(installTask))
  assert.equal(installTask.exitCode, 0, JSON.stringify(installTask))
  const installedChild = await hub('/installed')
  assert.equal(installedChild.installed[fixtureName], '1.0.0')
  assert(installedChild.loaded.includes(fixtureName), JSON.stringify(installedChild))
  const session = await rpc('session/create', { request: { cwd: '/dsh/workspace' } })
  const command = () => rpc('commands/execute', { agentId: session.sessionId, line: '/forge-hub-child', submittedAttachments: [] })
  assert.equal((await command()).result.text, 'hub child active')
  const digest = await rpc('commands/execute', { agentId: session.sessionId, line: '/forge-hub-sha256', submittedAttachments: [] })
  assert.equal(digest.result.text, createHash('sha256').update('forge hub').digest('hex'))
  const configCommand = () => rpc('commands/execute', { agentId: session.sessionId, line: '/forge-hub-config', submittedAttachments: [] })
  assert.deepEqual(JSON.parse((await configCommand()).result.text), fixtureConfig)
  console.log('Hub fixture installed with annotation metadata and retained nested configuration')
  const updating = await hub('/install', { repo: fixtureName, source: 'custom', installChannel: 'npm', lang: 'en', mode: 'update' })
  const updateTask = await waitTask(updating.task)
  assert.equal(updateTask.status, 'done', JSON.stringify(updateTask))
  assert.equal((await command()).result.text, 'hub child active')
  const loaderEntries = await hub('/debug/loader-entries')
  assert.equal(loaderEntries.entries.filter(entry => entry.name === fixtureName).length, 1)
  assert.deepEqual(JSON.parse((await configCommand()).result.text), fixtureConfig)
  console.log('Hub fixture updated through @latest with configuration retained')
  const whaleCreated = await hub('/install', { repo: 'dsh-whale-widget', source: 'custom', installChannel: 'npm', lang: 'en', version: '0.4.2' })
  assert.equal(whaleCreated.ok, true)
  const whaleTask = await waitTask(whaleCreated.task)
  assert.equal(whaleTask.status, 'failed', JSON.stringify(whaleTask))
  assert(whaleBuildFailure && whaleBuildFailure.status >= 400)
  assert.equal(whaleBuildFailure.body.error.code, 'NODE_MODULE_UNSUPPORTED')
  assert.match(whaleTask.lines.join('\n'), /node:dns/)
  const afterWhale = await hub('/installed')
  assert.equal(afterWhale.installed['dsh-whale-widget'], undefined)
  assert(!afterWhale.loaded.includes('dsh-whale-widget'))
  assert.equal(await page.locator('.dshwv-root').count(), 0)
  assert.equal((await command()).result.text, 'hub child active')
  console.log('Whale DNS requirement rejected without activation; existing command preserved')
  const bundleOverrides = await verifyBundleOverrides({ page, hub, waitTask, rpc, session, fixtureConfig, fixtureName })
  const industry = await verifyIndustryPlugin({ page, hub, waitTask, rpc, session })
  const removing = await hub('/uninstall', { name: fixtureName })
  const removeTask = await waitTask(removing.task)
  assert.equal(removeTask.status, 'done', JSON.stringify(removeTask))
  assert.equal(removeTask.exitCode, 0)
  assert.equal((await hub('/installed')).installed[fixtureName], undefined)
  assert.equal(await command(), undefined)
  const mobile = await verifyMobilePlugin({ page, hub, waitTask, rpc, root, checkMarketplace })
  const extra = await verifyExtraPlugins({ page, hub, waitTask, rpc, root })
  assert.equal(workers, 1)
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
  const observed = {
    httpPort, mobile, industry, bundleOverrides, ...extra, package: 'dsh-plugin@2.2.1', hostRoutes: true, clientFactory: true, settingsSection: true,
    catalogThroughCurl: true, catalogListVisible: true, releaseAgeThroughHttps: true,
    marketplaceReopened: true, nativeManagerPackagesAvailable: true, marketplacePreservedAfterPluginInstall: true,
    marketplaceUiInstall: true, nativeToggleSingleRegistration: true,
    installQueue: { package: `${fixtureName}@1.0.0`, status: installTask.status, command: 'hub child active', sha256: digest.result.text, configuration: fixtureConfig, annotationMetadataAccepted: true },
    whale: { package: 'dsh-whale-widget@0.4.2', status: whaleTask.status, code: whaleBuildFailure.body.error.code, module: 'node:dns', activated: false },
    updateQueue: { status: updateTask.status, singleLoaderEntry: true },
    removeQueue: { status: removeTask.status, commandRemoved: true }, workerStarts: workers, documentPreserved: true,
  }
  const golden = resolve(root, 'tests/expected/plugin-hub.json')
  const text = JSON.stringify(observed, null, 2) + '\n'
  if (values['refresh-snapshot']) await writeFile(golden, text)
  else assert.equal(text, await readFile(golden, 'utf8'))
  console.log(text)

  async function checkMarketplace(name) {
    const bundle = (await rpc('pluginManager/listBundles', {})).find(bundle => bundle.name === name)
    assert.equal(bundle?.availability, 'profile', JSON.stringify(bundle))
    assert.equal(bundle.error, undefined, JSON.stringify(bundle))
    await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-slot-error]').count(), 0)
    await page.getByText('General', { exact: true }).click()
    await page.getByRole('button', { name: 'Plugin Hub', exact: true }).click()
    await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    if (await settings.isVisible()) { await page.keyboard.press('Escape'); await settings.waitFor({ state: 'hidden' }) }
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.locator('[data-plugin-panel][aria-busy="false"]').waitFor({ state: 'visible' })
    await page.getByText(name, { exact: true }).first().waitFor({ state: 'visible' })
    await page.getByText('Installed plugins', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(root, '.data/forge-native-plugin-manager.png') })
    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Plugin Hub', exact: true }).click()
    await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-slot-error]').count(), 0)
    console.log('Marketplace remained available after native Plugins with ' + name)
  }
  async function waitStatus(prefix) {
    await page.waitForFunction(expected => (document.querySelector('[data-forge-preview] [role="status"]')?.textContent ?? '').startsWith(expected), prefix)
  }
  async function waitTask(id) {
    return page.evaluate(async taskId => {
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        const response = await fetch(`/dsh-plugin-hub/status?task=${taskId}`, { signal: AbortSignal.timeout(30000) })
        const value = await response.json()
        if (!response.ok) throw new Error(JSON.stringify(value))
        if (value.task && !['pending', 'running'].includes(value.task.status)) return value.task
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Hub task ${taskId} did not complete within 180 seconds`)
    }, id)
  }
  async function hub(path, payload) {
    console.log(`Hub request ${path}`)
    return page.evaluate(async ({ path, payload }) => {
      const response = await fetch(`/dsh-plugin-hub${path}`, payload === undefined ? { signal: AbortSignal.timeout(30000) } : {
        signal: AbortSignal.timeout(30000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      const value = await response.json()
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`)
      return value
    }, { path, payload })
  }
  async function rpc(method, args) {
    const envelope = await page.evaluate(async ({ method, args }) => {
      const response = await window.__DSH_TRANSPORT__.fetch(`/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } }),
      })
      return response.json()
    }, { method, args })
    assert.equal(envelope.result?.ok, true, JSON.stringify(envelope))
    return envelope.result.value
  }
} catch (error) {
  if (browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      await page.screenshot({ path: resolve(root, '.data/forge-plugin-hub-failure.png') }).catch(() => {})
      logs.push((await page.locator('body').innerText()).slice(-12000))
    }
  }
  console.error(logs.join('\n'))
  throw error
} finally {
  await browser?.close()
  await backend?.close()
  await registry?.close()
  frontend.closeAllConnections()
  if (frontend.listening) await new Promise((accept, reject) => frontend.close(error => error ? reject(error) : accept()))
  await rm(temporary, { recursive: true, force: true })
}

async function startRegistry() {
  const directory = join(temporary, 'npm-fixture')
  await mkdir(join(directory, 'package'), { recursive: true })
  const fixture = { name: fixtureName, version: '1.0.0', main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' }, compatibility: { dshReleases: { '0.2.1-rc.2': 'compatible' } }, manifestVersion: 1 },
  }
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(fixture))
  await writeFile(join(directory, 'package/cordis.patch.yml'), `- insert:\n    - id: ${fixtureName}\n      name: ${fixtureName}\n      config: ${JSON.stringify(fixtureConfig)}\n`)
  await writeFile(join(directory, 'package/index.js'), `const { createHash } = require('node:crypto'); exports.name = '${fixtureName}'; exports.inject = ['commands', 'skills', 'tools']; exports.apply = (ctx, config) => {
    const { existsSync, readFileSync } = require('node:fs');
    const { dirname, join } = require('node:path');
    const observedResources = new Set();
    ctx.effect(() => ctx.commands.register({ name: 'forge-hub-industry', description: 'Inspect packaged industry skills and tools', handler: async () => {
      const summaries = (await ctx.skills.list({ cwd: '/dsh/workspace' })).filter(skill => ['company-research-method', 'industry-research-method'].includes(skill.name));
      const skills = await Promise.all(summaries.map(async summary => {
        const skill = await ctx.skills.get(summary.name, { cwd: '/dsh/workspace' });
        observedResources.add(skill.path);
        const referencePath = skill.name === 'industry-research-method' ? join(dirname(skill.path), 'references/frameworks.md') : undefined;
        if (referencePath) observedResources.add(referencePath);
        return { name: skill.name, provider: skill.provider, path: skill.path, content: skill.content, reference: referencePath ? readFileSync(referencePath, 'utf8') : null };
      }));
      const tools = ctx.tools.schemas().map(tool => tool.name).filter(name => ['industry_map', 'industry_track', 'company_scan', 'industry_report'].includes(name)).sort();
      return { kind: 'success', text: JSON.stringify({ skills, tools, resources: [...observedResources].map(path => ({ path, exists: existsSync(path) })) }) };
    } }));
    ctx.effect(() => ctx.commands.register({ name: 'forge-hub-child', description: 'Forge acceptance command', handler: () => ({ kind: 'success', text: 'hub child active' }) }));
    ctx.effect(() => ctx.commands.register({ name: 'forge-hub-config', description: 'Forge configuration acceptance command', handler: () => ({ kind: 'success', text: JSON.stringify(config) }) }));
    ctx.effect(() => ctx.commands.register({ name: 'forge-hub-sha256', description: 'Forge SHA-256 acceptance command', handler: () => ({ kind: 'success', text: createHash('sha256').update('forge hub').digest('hex') }) }));
  };\n`)
  const require = createRequire(resolve(dshRoot, 'package.json'))
  const tar = await import(pathToFileURL(require.resolve('tar')).href)
  const tarballPath = join(directory, 'fixture.tgz')
  await tar.c({ cwd: directory, file: tarballPath, gzip: true }, ['package'])
  const tarball = await readFile(tarballPath)
  const overlays = new Map()
  for (const fixture of overrideFixtures(fixtureName)) {
    const folder = join(temporary, `overlay-${fixture.manifest.version}`)
    await mkdir(join(folder, 'package'), { recursive: true })
    await writeFile(join(folder, 'package/package.json'), JSON.stringify(fixture.manifest))
    await writeFile(join(folder, 'package/cordis.patch.yml'), fixture.patch)
    await writeFile(join(folder, 'package/index.js'), fixture.source)
    const archive = join(folder, 'fixture.tgz')
    await tar.c({ cwd: folder, file: archive, gzip: true }, ['package'])
    overlays.set(fixture.manifest.version, { manifest: fixture.manifest, bytes: await readFile(archive) })
  }
  let registryUrl
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        response.setHeader('Access-Control-Allow-Origin', '*')
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' }); response.end(); return
        }
        if (path.startsWith(`/${overrideFixtureName}/-/`)) {
          const version = path.slice(`/${overrideFixtureName}/-/`.length).replace(/\.tgz$/, '')
          const fixture = overlays.get(version)
          response.writeHead(fixture ? 200 : 404, { 'content-type': 'application/octet-stream' }); response.end(fixture?.bytes); return
        }
        if (path === `/${overrideFixtureName}` || path.startsWith(`/${overrideFixtureName}/`)) {
          const versions = Object.fromEntries([...overlays].map(([version, fixture]) => [version, { ...fixture.manifest, dist: {
            tarball: `${registryUrl}/${overrideFixtureName}/-/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(fixture.bytes).digest('base64')}`,
          } }]))
          const version = path.slice(overrideFixtureName.length + 2)
          const metadata = { name: overrideFixtureName, 'dist-tags': { latest: '1.0.1' }, versions }
          const value = version ? versions[version === 'latest' ? '1.0.1' : version] : metadata
          response.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(value ?? { error: 'Version not found' })); return
        }
        if (path === '/fixture.tgz') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(tarball); return
        }
        if (path === '/' || path === `/${fixtureName}` || path === `/${fixtureName}/latest` || path === `/${fixtureName}/1.0.0`) {
          const metadata = path === '/' ? {} : { name: fixtureName, 'dist-tags': { latest: '1.0.0' },
            time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
            versions: { '1.0.0': { ...fixture, dist: { tarball: `${registryUrl}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` } } },
          }
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(path.endsWith('/latest') || path.endsWith('/1.0.0') ? metadata.versions['1.0.0'] : metadata)); return
        }
        const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
        response.end(new Uint8Array(await upstream.arrayBuffer()))
      } catch (error) {
        logs.push(`registry: ${String(error)}`)
        if (!response.headersSent) response.writeHead(502)
        response.end()
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  registryUrl = `http://127.0.0.1:${address.port}`
  return { url: registryUrl, close: async () => {
    server.closeAllConnections()
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
  } }
}
