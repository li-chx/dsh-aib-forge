/** Published Context contributes Host projections/routes and Client insights without a model request. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

/** Exercise the real publication, repeated registration and UI removal in the existing Worker. */
export async function verifyContextPlugin({ page, hub, waitTask, rpc, session, root }) {
  const name = 'dsh-context'
  const detail = () => page.evaluate(async sessionId => {
    const response = await fetch('/api/dsh-context/detail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(30000) })
    return { status: response.status, body: await response.json() }
  }, session.sessionId)
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  if (await settings.isVisible()) { await page.keyboard.press('Escape'); await settings.waitFor({ state: 'hidden' }) }
  let styleCount
  for (const mode of ['install', 'update']) {
    const created = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', version: '0.76.0', mode })
    assert.equal(created.ok, true, JSON.stringify(created))
    const task = await waitTask(created.task)
    assert.equal(task.status, 'done', JSON.stringify(task))
    const forge = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(forge.plugins.find(plugin => plugin.name === name)?.status, 'active', JSON.stringify(forge))
    assert.equal((await hub('/debug/loader-entries')).entries.filter(entry => entry.name === name).length, 1)
    const response = await detail()
    assert.equal(response.status, 200, JSON.stringify(response))
    assert.equal(response.body.ok, true, JSON.stringify(response))
    assert(response.body.value !== null, 'Real Context detail route must read the private test session')
    const entry = page.getByRole('button', { name: 'Context Insights', exact: true })
    await entry.waitFor({ state: 'visible' })
    assert.equal(await entry.count(), 1)
    await entry.click()
    await page.locator('.lc-ov-page').waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-slot-error]').count(), 0)
    const styles = await page.locator('style[data-plugin="dsh-context"]').count()
    assert(styles > 0)
    if (styleCount !== undefined) assert.equal(styles, styleCount)
    styleCount = styles
    console.log(`Context ${mode}: Host detail route, one Loader entry and visible insights dashboard`)
  }
  await page.screenshot({ path: resolve(root, '.data/forge-context.png') })
  const removing = await hub('/uninstall', { name })
  assert.equal((await waitTask(removing.task)).status, 'done')
  await page.getByRole('button', { name: 'Context Insights', exact: true }).waitFor({ state: 'hidden' })
  await page.locator('.lc-ov-page').waitFor({ state: 'hidden' })
  const routeAfter = await page.evaluate(async () => (await fetch('/api/dsh-context/detail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status)
  assert.equal(routeAfter, 404)
  assert.equal((await hub('/debug/loader-entries')).entries.filter(entry => entry.name === name).length, 0)
  const residualStyles = await page.locator('style[data-plugin="dsh-context"]').count()
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin Hub', exact: true }).click()
  await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  return { package: `${name}@0.76.0`, hostDetail: true, clientDashboard: true, updates: 1, singleRegistration: true, removedHostRoute: true, removedDashboard: true, residualStyles, marketplacePreserved: true, modelRequest: false }
}
