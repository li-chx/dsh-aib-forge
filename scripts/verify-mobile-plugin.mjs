/** Published mobile plugin lifecycle and touch viewport acceptance in the existing DSH document. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

/** Exercise published Host routes and Client effects without changing the plugin's code. */
export async function verifyMobilePlugin({ page, hub, waitTask, rpc, root, checkMarketplace }) {
  const name = 'dsh-web-mobile'
  const sheet = page.locator('style[data-plugin-css="dsh-web-mobile/mobile.css"]')
  const frame = page.locator('[data-mobile-nav="frame"]')
  const created = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', version: '3.2.0' })
  assert.equal(created.ok, true)
  const installedTask = await waitTask(created.task)
  assert.equal(installedTask.status, 'done', JSON.stringify(installedTask))
  await sheet.waitFor({ state: 'attached' })
  const installed = await hub('/installed')
  assert.equal(installed.installed[name], '3.2.0')
  assert(installed.loaded.includes(name))
  const route = await mobileRequest()
  assert.equal(route.status, 405, JSON.stringify(route))

  if (checkMarketplace) await checkMarketplace(name)
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => matchMedia('(max-width: 1023px) and (pointer: coarse)').matches)
    await frame.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-mobile-nav="frame"]')
      return frame?.hasAttribute('data-sidebar-collapsed') && frame.firstElementChild.getBoundingClientRect().right <= 1
    })
    const fab = page.locator('[data-mobile-nav="fab"]')
    await fab.waitFor({ state: 'visible' })
    if (await fab.getAttribute('data-mobile-nav-fab-mode') === 'exit-panel') {
      await fab.click()
      await page.locator('[data-mobile-nav="fab"][data-mobile-nav-fab-mode="open-drawer"]').waitFor({ state: 'visible' })
    }
    await fab.click()
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-mobile-nav="frame"]')
      const pane = frame?.firstElementChild
      return frame && !frame.hasAttribute('data-sidebar-collapsed') && pane.getBoundingClientRect().left >= -1
    })
    await page.getByRole('button', { name: 'New session', exact: true }).last().waitFor({ state: 'visible' })
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('[data-mobile-nav="frame"]').firstElementChild.getBoundingClientRect()
      return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, drawerWidth: pane.width, drawerRight: pane.right }
    })
    assert.equal(geometry.width, 390)
    assert(geometry.pageWidth <= 391, JSON.stringify(geometry))
    assert(geometry.drawerWidth > 200 && geometry.drawerRight <= 390, JSON.stringify(geometry))
    await page.screenshot({ path: resolve(root, '.data/forge-mobile-drawer.png') })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-mobile-nav="frame"]')?.hasAttribute('data-sidebar-collapsed'))
    await fab.click()
    await page.locator('[data-mobile-nav="backdrop"]').click({ position: { x: 370, y: 400 } })
    await page.waitForFunction(() => document.querySelector('[data-mobile-nav="frame"]')?.hasAttribute('data-sidebar-collapsed'))
    await page.screenshot({ path: resolve(root, '.data/forge-mobile.png') })
    console.log('Mobile Client drawer works at 390 CSS px with a coarse pointer')

    const oldSheet = await sheet.elementHandle()
    const updating = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', mode: 'update', version: '3.2.1' })
    const updatedTask = await waitTask(updating.task)
    assert.equal(updatedTask.status, 'done', JSON.stringify(updatedTask))
    await page.waitForFunction(old => !old.isConnected, oldSheet)
    await sheet.waitFor({ state: 'attached' })
    await fab.waitFor({ state: 'visible' })
    assert.equal(await sheet.count(), 1)
    assert.equal(await frame.count(), 1)
    assert.equal(await fab.count(), 1)
    assert.equal((await hub('/installed')).installed[name], '3.2.1')
    const entries = await hub('/debug/loader-entries')
    assert.equal(entries.entries.filter(entry => entry.name === name).length, 1)
    console.log('Mobile plugin updated from 3.2.0 to 3.2.1 through normal Client replacement')

    const invalid = await mobileRequest({ sessionId: '' })
    assert.equal(invalid.status, 400, JSON.stringify(invalid))
    assert.equal(invalid.body.error.code, 'invalid-session-id')
    const temporary = await rpc('session/create', { request: { cwd: '/dsh/workspace' } })
    const deleted = await mobileRequest({ sessionId: temporary.sessionId })
    assert.equal(deleted.status, 200, JSON.stringify(deleted))
    assert.equal(deleted.body.deleted, temporary.sessionId)
    const missing = await mobileRequest({ sessionId: temporary.sessionId })
    assert.equal(missing.status, 404, JSON.stringify(missing))
    assert.equal(missing.body.error.code, 'session-not-found')
    console.log('Mobile Host route forwards native fetch and deletes only its temporary test session')

    const removing = await hub('/uninstall', { name })
    const removedTask = await waitTask(removing.task)
    assert.equal(removedTask.status, 'done', JSON.stringify(removedTask))
    await sheet.waitFor({ state: 'detached' })
    await frame.waitFor({ state: 'detached' })
    await fab.waitFor({ state: 'detached' })
    const remaining = await hub('/installed')
    assert.equal(remaining.installed[name], undefined)
    assert(!remaining.loaded.includes(name))
    const absentRoute = await mobileRequest()
    assert.equal(absentRoute.status, 404, JSON.stringify(absentRoute))
    return { versions: ['3.2.0', '3.2.1'], clientReplaced: true, viewportWidth: geometry.width,
      drawerOpened: true, escapeClosed: true, backdropClosed: true, horizontalOverflow: false,
      nativeFetchRoute: true, temporarySessionDeleted: true, removedStylesAndControls: true, removedHostRoute: true }
  } catch (error) {
    await page.screenshot({ path: resolve(root, '.data/forge-mobile-failure.png') })
    console.error('Mobile layout state', await page.evaluate(() => {
      const frame = document.querySelector('[data-mobile-nav="frame"]')
      return { width: innerWidth, collapsed: frame?.hasAttribute('data-sidebar-collapsed'),
        pane: frame?.firstElementChild.getBoundingClientRect().toJSON(),
        errors: [...document.querySelectorAll('[data-slot-error]')].map(node => node.getAttribute('data-slot-error')) }
    }))
    throw error
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach()
    await page.setViewportSize({ width: 1440, height: 1000 })
  }

  async function mobileRequest(payload) {
    return page.evaluate(async payload => {
      const response = await fetch('/api/mobile-nav.session.delete', payload === undefined ? { signal: AbortSignal.timeout(30000) } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = text }
      return { status: response.status, body }
    }, payload)
  }
}
