/** Real application management UI over its Worker VFS, source compiler and persisted artifact history. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openAiw } from './aiw-page.mjs'

/** Exercise the actual sidebar panel; direct reads only verify the effects of user actions. */
export async function verifyAiw({ browser, origin, backendUrl, root, target, refreshSnapshot }) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 960 } })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  const logs = []
  page.on('console', message => { if (message.type() === 'error') logs.push(message.text()) })
  page.on('pageerror', error => logs.push(error.message))
  let hostWorkers = 0
  page.on('worker', worker => {
    void worker.evaluate(() => self.name).then(name => { if (name === 'dsh-host') hostWorkers++ }, () => {})
  })
  const url = `${origin}/preview.html?preview-fixture=none&forge=${encodeURIComponent(backendUrl)}`
  const project = '/dsh/workspace/aiw-proof'
  const pluginId = 'aiw-proof'
  const local = async (action, expectedStatus = 200) => {
    const result = await page.evaluate(async action => {
      const response = await fetch('/__aiw/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
      return { status: response.status, body: await response.json() }
    }, action)
    assert.equal(result.status, expectedStatus, JSON.stringify(result))
    return result.body
  }
  const rpc = async (method, args) => {
    const result = await page.evaluate(async ({ method, args }) => {
      const response = await window.__DSH_TRANSPORT__.fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } }) })
      return response.json()
    }, { method, args })
    assert.equal(result.result?.ok, true, JSON.stringify(result))
    return result.result.value
  }
  let panel
  const tab = async name => { await panel.getByRole('tab', { name, exact: true }).click() }
  const actionWaiters = new Map()
  await page.exposeFunction('recordAiwResponseForAcceptance', value => { actionWaiters.get(value.action)?.resolve(value) })
  const observeActions = () => page.evaluate(() => {
    const previous = window.fetch
    window.fetch = async (input, init) => {
      const response = await previous(input, init)
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname === '/__aiw/action' && init?.method === 'POST' && typeof init.body === 'string') {
        const action = JSON.parse(init.body).action
        await window.recordAiwResponseForAcceptance({ action, status: response.status, body: await response.clone().json() })
      }
      return response
    }
  })
  const perform = async (action, click, status = 200) => {
    assert(!actionWaiters.has(action), `Overlapping ${action} observation`)
    const pending = Promise.withResolvers()
    actionWaiters.set(action, pending)
    let timer
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`AIW action ${action} did not settle`)), 45000) })
    const settled = Promise.race([pending.promise, deadline])
    void settled.catch(() => {})
    try {
      await click()
      const result = await settled
      assert.equal(result.status, status, JSON.stringify(result.body))
      return result.body
    } finally { clearTimeout(timer); actionWaiters.delete(action) }
  }
  const read = path => local({ action: 'read', path })
  const edit = async (path, transform) => {
    await tab('Files')
    await panel.getByLabel('Path', { exact: true }).fill(path)
    const opened = await perform('read', () => panel.getByRole('button', { name: 'Read file', exact: true }).click())
    await page.waitForFunction(expected => document.querySelector('textarea[aria-label="File contents"]')?.value === expected, opened.text)
    const editor = panel.getByLabel('File contents', { exact: true })
    const original = await editor.inputValue()
    await editor.fill(transform(original))
    await perform('write', () => panel.getByRole('button', { name: 'Save file', exact: true }).click())
    assert.equal((await read(path)).text, transform(original))
  }
  const build = async () => {
    await tab('Plugins')
    await panel.getByLabel('Project directory', { exact: true }).fill(project)
    const result = await perform('build', () => panel.getByRole('button', { name: 'Build project', exact: true }).click())
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    return result
  }
  const settledAnimation = async (targetPage = page) => targetPage.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().iterations))
      .map(animation => animation.finished.catch(() => {})))
  })
  const flush = async () => {
    const received = Promise.withResolvers()
    await page.exposeFunction('recordAiwStorageSave', result => received.resolve(result))
    await page.evaluate(() => {
      const storage = window.__DSH_TRANSPORT__.storage
      const flush = storage.flush.bind(storage)
      storage.flush = async signal => {
        const result = await flush(signal)
        await window.recordAiwStorageSave(result)
        return result
      }
    })
    const timeout = setTimeout(() => received.reject(new Error('AIW save acknowledgement did not arrive')), 30000)
    try {
      await panel.getByRole('button', { name: 'Save now', exact: true }).click()
      const result = await received.promise
      assert.equal(result.kind, 'saved', JSON.stringify(result))
      await panel.locator('[data-aiw-storage="saved"]').waitFor()
    } finally { clearTimeout(timeout) }
  }
  try {
    console.log('AIW: opening application')
    await page.goto(url)
    panel = await openAiw(page, { fresh: true })
    await observeActions()
    console.log('AIW: sidebar page mounted')
    assert.equal(await page.getByRole('button', { name: 'DSH Forge', exact: true }).count(), 0)
    assert.equal(await page.locator('[data-worker-storage]').count(), 0)
    assert.equal(await panel.getByRole('button', { name: 'Save now', exact: true }).count(), 1)
    const positions = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      return { plugins: buttons.findIndex(button => button.textContent === 'Plugins'), aiw: buttons.findIndex(button => button.textContent === 'dsh-aiw'), tasks: buttons.findIndex(button => button.textContent === 'Automation tasks') }
    })
    assert(positions.plugins >= 0 && positions.aiw > positions.plugins && positions.tasks > positions.aiw, JSON.stringify(positions))
    const originBefore = await page.evaluate(() => performance.timeOrigin)
    for (const name of ['Plugins', 'Files', 'Command line', 'Backups', 'Settings']) assert.equal(await panel.getByRole('tab', { name, exact: true }).count(), 1)
    await tab('Settings')
    assert.equal(new URL(await panel.getByLabel('Forge server URL', { exact: true }).inputValue()).href, new URL(backendUrl).href)
    await perform('configure', () => panel.getByRole('button', { name: 'Save settings', exact: true }).click())

    console.log('AIW: sidebar, tabs and settings verified')
    await tab('Files')
    await panel.getByLabel('Path', { exact: true }).fill('/dsh/workspace/aiw-files')
    await perform('mkdir', () => panel.getByRole('button', { name: 'New folder', exact: true }).click())
    await panel.getByLabel('Path', { exact: true }).fill('/dsh/workspace/aiw-files/note.txt')
    await panel.getByRole('button', { name: 'New file', exact: true }).click()
    await panel.getByLabel('File contents', { exact: true }).fill('first note\n')
    await perform('write', () => panel.getByRole('button', { name: 'Save file', exact: true }).click())
    assert.equal((await read('/dsh/workspace/aiw-files/note.txt')).text, 'first note\n')
    await panel.getByLabel('File contents', { exact: true }).fill('unconfirmed note\n')
    await tab('Command line')
    const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })
    await discard.waitFor()
    await page.keyboard.press('Escape')
    await discard.waitFor({ state: 'hidden' })
    assert.equal(await panel.getByLabel('File contents', { exact: true }).inputValue(), 'unconfirmed note\n')
    await tab('Command line')
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
    assert.equal(await panel.getByLabel('File contents', { exact: true }).inputValue(), 'unconfirmed note\n')
    await perform('write', () => panel.getByRole('button', { name: 'Save file', exact: true }).click())
    assert.equal((await read('/dsh/workspace/aiw-files/note.txt')).text, 'unconfirmed note\n')

    await panel.getByLabel('Target path', { exact: true }).fill('/dsh/workspace/aiw-files/renamed.txt')
    await perform('rename', () => panel.getByRole('button', { name: 'Rename', exact: true }).click())
    assert.equal((await read('/dsh/workspace/aiw-files/renamed.txt')).text, 'unconfirmed note\n')
    await panel.getByLabel('File contents', { exact: true }).fill('discard this draft')
    await tab('Command line')
    await page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
    await panel.getByLabel('Command', { exact: true }).waitFor()
    await tab('Files')
    assert.equal(await panel.getByLabel('File contents', { exact: true }).inputValue(), 'unconfirmed note\n')

    await tab('Command line')
    await panel.getByLabel('Working directory', { exact: true }).fill('/dsh/workspace/aiw-files')
    await panel.getByLabel('Command', { exact: true }).fill('pwd && cat renamed.txt && printf temporary > remove.txt')
    const command = await perform('shell', () => panel.getByRole('button', { name: 'Run command', exact: true }).click())
    assert.equal(command.exitCode, 0)
    assert(command.stdout.includes('/dsh/workspace/aiw-files') && command.stdout.includes('unconfirmed note'))
    await panel.getByLabel('Command', { exact: true }).fill('not-an-aiw-command')
    const failed = await perform('shell', () => panel.getByRole('button', { name: 'Run command', exact: true }).click())
    assert.notEqual(failed.exitCode, 0)
    await page.waitForFunction(code => document.querySelector('[data-aiw-command-output]')?.textContent.includes(`[exit ${code}]`), failed.exitCode)

    await tab('Files')
    await panel.getByLabel('Path', { exact: true }).fill('/dsh/workspace/aiw-files/remove.txt')
    await perform('delete', async () => {
      await panel.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog', { name: 'Confirm operation', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click()
    })
    assert(!(await local({ action: 'list', path: '/dsh/workspace/aiw-files' })).entries.some(entry => entry.name === 'remove.txt'))

    console.log('AIW: file editing, navigation guard and virtual commands verified')
    await tab('Plugins')
    await panel.getByLabel('Project directory', { exact: true }).fill(project)
    await panel.getByLabel('Package name', { exact: true }).fill(pluginId)
    await panel.getByLabel('Include Client', { exact: true }).check()
    await perform('create-project', () => panel.getByRole('button', { name: 'Create project', exact: true }).click())
    await build()
    const workspaceId = (await rpc('workspace/create', { request: { path: '/dsh/workspace' } })).workspace.workspaceId
    const session = await rpc('session/create', { request: { workspaceId } })
    const commandResult = () => rpc('commands/execute', { agentId: session.sessionId, line: `/${pluginId}`, submittedAttachments: [] })
    assert.equal((await commandResult()).result.text, `${pluginId} v1`)
    const v1 = (await local({ action: 'history', pluginId })).versions[0]
    assert(v1?.hasSource)
    await edit(`${project}/index.ts`, text => text.replaceAll('v1', 'v2'))
    await edit(`${project}/client.tsx`, text => text.replaceAll('v1', 'v2'))
    await build()
    assert.equal((await commandResult()).result.text, `${pluginId} v2`)
    const history = (await local({ action: 'history', pluginId })).versions
    assert.equal(new Set(history.map(version => version.revision)).size, 2)
    assert.equal(hostWorkers, 1)
    assert.equal(await page.evaluate(() => performance.timeOrigin), originBefore)
    await page.screenshot({ path: resolve(root, '.data/aiw-plugins.png') })
    console.log('AIW: Host hot update and Client compilation verified')
    await page.route(`${backendUrl}/**`, route => route.abort('blockedbyclient'))
    const row = panel.locator(`[data-aiw-plugin="${pluginId}"]`)
    await perform('history', () => row.getByRole('button', { name: 'History', exact: true }).click())
    const version = panel.locator(`[data-aiw-version="${v1.revision}"]`)
    const restored = await perform('restore', async () => {
      await version.getByRole('button', { name: 'Restore version', exact: true }).click()
      await page.getByRole('dialog', { name: 'Confirm operation', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click()
    })
    assert.equal(restored.status, 'active', JSON.stringify(restored))
    assert.equal((await commandResult()).result.text, `${pluginId} v1`)
    assert((await read(`${project}/index.ts`)).text.includes('v1'))
    await flush()
    await page.reload()
    panel = await openAiw(page)
    await observeActions()
    assert.equal((await commandResult()).result.text, `${pluginId} v1`)
    assert.equal((await local({ action: 'history', pluginId })).versions.length, 2)

    console.log('AIW: offline history restore and reload verified')
    const retainedPlugin = panel.locator(`[data-aiw-plugin="${pluginId}"]`)
    const pluginDownloadPending = page.waitForEvent('download')
    await perform('plugin-export', () => retainedPlugin.getByRole('button', { name: 'Export plugin', exact: true }).click())
    const pluginDownload = await pluginDownloadPending
    const pluginChunks = []
    for await (const chunk of await pluginDownload.createReadStream()) pluginChunks.push(chunk)
    const pluginArchive = JSON.parse(Buffer.concat(pluginChunks).toString('utf8'))
    assert.equal(pluginArchive.kind, 'plugin')
    assert.equal(pluginArchive.manifest.plugin.id, pluginId)
    const archivedRoot = pluginArchive.manifest.packages.find(pkg => pkg.id === pluginArchive.manifest.plugin.packageId)
    assert.equal(archivedRoot.metadata.dsh.client.platform, 'web')
    const clientFile = archivedRoot.files.find(file => `./${file.path}` === archivedRoot.metadata.exports['./client'])
    assert(clientFile && pluginArchive.objects[clientFile.sha256], 'The offline archive retains the generated Client bytes')
    assert(Buffer.from(pluginArchive.objects[clientFile.sha256], 'base64').toString('utf8').includes('v1'))
    await perform('remove', async () => {
      await retainedPlugin.getByRole('button', { name: 'Remove', exact: true }).click()
      await page.getByRole('dialog', { name: 'Confirm operation', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click()
    })
    assert.equal(await commandResult(), undefined)
    await tab('Backups')
    await panel.getByLabel('Import file', { exact: true }).setInputFiles({ name: 'plugin.aiw.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pluginArchive)) })
    await panel.getByRole('button', { name: 'Preview import', exact: true }).click()
    await panel.locator('[data-aiw-import-preview]').waitFor()
    assert.equal(await commandResult(), undefined, 'Previewing a plugin archive does not activate it')
    await perform('plugin-import', async () => {
      await panel.getByRole('button', { name: 'Apply import', exact: true }).click()
      await page.getByRole('dialog', { name: 'Confirm operation', exact: true }).getByRole('button', { name: 'Completed', exact: true }).click()
    })
    assert.equal((await commandResult()).result.text, `${pluginId} v1`)

    await tab('Backups')
    console.log('AIW: offline plugin archive round trip verified')
    await panel.getByLabel('Export directory', { exact: true }).fill('/dsh/workspace/aiw-files')
    const downloaded = page.waitForEvent('download')
    await perform('export', () => panel.getByRole('button', { name: 'Export files', exact: true }).click())
    const download = await downloaded
    const stream = await download.createReadStream()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const archive = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(archive.kind, 'files')
    assert.equal(archive.files.length, 1)
    await panel.getByLabel('Import file', { exact: true }).setInputFiles({ name: 'aiw-files.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
    await panel.getByLabel('Import directory', { exact: true }).fill('/dsh/workspace/aiw-imported')
    const preview = await perform('import-preview', () => panel.getByRole('button', { name: 'Preview import', exact: true }).click())
    assert.equal(preview.fileCount, 1)
    assert.deepEqual(preview.conflicts, [])
    assert(!(await local({ action: 'list', path: '/dsh/workspace' })).entries.some(entry => entry.path === '/dsh/workspace/aiw-imported'))
    await perform('import', () => panel.getByRole('button', { name: 'Apply import', exact: true }).click())
    assert.equal((await read('/dsh/workspace/aiw-imported/renamed.txt')).text, 'unconfirmed note\n')
    const corrupt = structuredClone(archive)
    corrupt.files[0].path = '../aiw-escape.txt'
    await panel.getByLabel('Import file', { exact: true }).setInputFiles({ name: 'corrupt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(corrupt)) })
    await panel.getByLabel('Import directory', { exact: true }).fill('/dsh/workspace/aiw-invalid')
    await perform('import-preview', () => panel.getByRole('button', { name: 'Preview import', exact: true }).click(), 400)
    assert(!(await local({ action: 'list', path: '/dsh/workspace' })).entries.some(entry => /aiw-invalid|aiw-escape/.test(entry.name)))

    await tab('Files')
    await panel.getByLabel('Path', { exact: true }).fill('/dsh/workspace/aiw-imported')
    await perform('list', () => panel.getByRole('button', { name: 'Open directory', exact: true }).click())
    await page.screenshot({ path: resolve(root, '.data/aiw-files.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await settledAnimation()
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, panels: [...document.querySelectorAll('[data-aiw-panel]')].length, tabHeights: [...document.querySelectorAll('[data-aiw-panel] [role=tab]')].map(tab => tab.getBoundingClientRect().height) }))
    assert.equal(geometry.panels, 1)
    assert(geometry.scroll <= geometry.width, JSON.stringify(geometry))
    assert(geometry.tabHeights.every(height => height >= 28 && height <= 44), 'Mobile tabs retain single-line labels')
    const tabViewport = await panel.getByRole('tablist').evaluate(list => ({ height: list.parentElement.getBoundingClientRect().height, listHeight: list.getBoundingClientRect().height }))
    assert(tabViewport.height >= tabViewport.listHeight && tabViewport.listHeight >= 28, JSON.stringify(tabViewport))
    await tab('Settings')
    await panel.getByLabel('Forge server URL', { exact: true }).waitFor({ state: 'visible' })
    await perform('list', () => tab('Files'))
    await settledAnimation()
    await page.screenshot({ path: resolve(root, '.data/aiw-mobile.png') })
    await page.setViewportSize({ width: 1280, height: 960 })
    await settledAnimation()
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await page.screenshot({ path: resolve(root, '.data/aiw-dark.png') })
    const chineseContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 } })
    try {
      const chinesePage = await chineseContext.newPage()
      await chinesePage.goto(url)
      const chinesePanel = await openAiw(chinesePage, { chinese: true, fresh: true })
      for (const name of ['插件', '文件', '命令行', '备份', '设置']) assert.equal(await chinesePanel.getByRole('tab', { name, exact: true }).count(), 1)
      await chinesePanel.getByRole('tab', { name: '设置', exact: true }).click()
      await chinesePanel.getByLabel('Forge 服务地址', { exact: true }).waitFor()
      await settledAnimation(chinesePage)
      assert.equal(await chinesePage.locator('[data-slot-error]').count(), 0)
      const chineseGeometry = await chinesePage.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
      assert(chineseGeometry.scroll <= chineseGeometry.width, JSON.stringify(chineseGeometry))
      await chinesePage.screenshot({ path: resolve(root, '.data/aiw-chinese-mobile.png') })
    } finally { await chineseContext.close() }
    const observed = { storage: { saveInsideAiw: true, acknowledgedFlush: true, noRoutineToolbar: true }, sidebar: { label: 'dsh-aiw', belowPlugins: true, beforeAutomationTasks: true, noToolbarForgeButton: true }, tabs: ['Plugins', 'Files', 'Command line', 'Backups', 'Settings'], files: { create: true, read: true, edit: true, rename: true, delete: true, dirtyNavigationProtected: true, escapeKeepsDraft: true, explicitDiscard: true }, shell: { virtualCwdAndRead: true, nonzeroVisible: true }, projects: { hostAndClient: true, retainedClientArtifact: true, buildAndUpdate: true, historyAfterArtifactGc: true, offlineRestore: true, restoredSource: true, survivesReload: true }, backup: { actualDownload: true, previewDoesNotWrite: true, importIntoNewDirectory: true, traversalRejectedWithoutWrites: true, pluginRoundTripOffline: true, pluginPreviewDoesNotActivate: true }, responsive: { width: 390, horizontalOverflow: false, singleLineTabs: true, englishAndChinese: true, lightAndDark: true }, paidModelCalls: 0 }
    const text = JSON.stringify(observed, null, 2) + '\n'
    const golden = resolve(root, 'tests/expected/aiw.json')
    if (refreshSnapshot) await writeFile(golden, text); else assert.equal(text, await readFile(golden, 'utf8'))
    console.log(text)
  } catch (error) {
    await page.screenshot({ path: resolve(root, '.data/aiw-failure.png') }).catch(() => {})
    console.error(logs.join('\n'))
    throw error
  } finally { await context.close() }
}
