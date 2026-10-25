/** Published plugin acceptance records activation and unavailable resources separately. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

/** Exercise Router registration and UI without running a model or a native CLI. */
export async function verifyExtraPlugins({ page, hub, waitTask, rpc, root }) {
  const routerName = '@ljwei-stak/dsh-model-router'
  const installing = await hub('/install', { repo: routerName, source: 'custom', installChannel: 'npm', lang: 'en', version: '0.25.1' })
  const installedTask = await waitTask(installing.task)
  assert.equal(installedTask.status, 'done', JSON.stringify(installedTask))
  const installed = await hub('/installed')
  assert.equal(installed.installed[routerName], '0.25.1')
  assert(installed.loaded.includes(routerName), JSON.stringify(installed))
  const entries = (await hub('/debug/loader-entries')).entries.filter(entry => entry.name === routerName)
  assert.equal(entries.length, 1, JSON.stringify(entries))
  const session = await rpc('session/create', { request: { cwd: '/dsh/workspace' } })
  const command = () => rpc('commands/execute', { agentId: session.sessionId, line: '/router', submittedAttachments: [] })
  assert.equal((await command()).result.text, '用法：/router <需要规划的任务>')
  await page.getByRole('button', { name: '模型路由', exact: true }).click()
  await page.locator('#mr-task').waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  const routerHostVersion = (await rpc('modelRouterOfficialTools/installSettings', {})).hostVersion
  console.log('Router Host reports version: ' + JSON.stringify(routerHostVersion))
  await page.screenshot({ path: resolve(root, '.data/forge-router.png') })
  console.log('Router Host command and Client workspace activated without a model request')

  const petInstalling = await hub('/install', { repo: 'whale-girl', source: 'custom', installChannel: 'npm', lang: 'en', version: '0.1.0' })
  const petTask = await waitTask(petInstalling.task)
  assert.equal(petTask.status, 'failed', JSON.stringify(petTask))
  assert(petTask.lines.some(line => line.includes('ctx.jobs.onJobDone is not a function')), JSON.stringify(petTask))
  const forgeInstalled = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert.equal(forgeInstalled.plugins.find(plugin => plugin.name === 'whale-girl')?.status, 'activation-failed', JSON.stringify(forgeInstalled))
  const partialClientMounted = await page.locator('[data-whale-girl]').count() > 0
  assert.equal((await command()).result.text, '用法：/router <需要规划的任务>')
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin Hub', exact: true }).click()
  await page.getByText('DSH Plugin Hub', { exact: true }).first().waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  const visibleCatalog = await hub('/catalog?lang=en')
  assert(visibleCatalog.length > 0)
  await page.getByText(visibleCatalog[0].n, { exact: true }).first().waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(root, '.data/forge-whale-girl-failure-contained.png') })
  await page.keyboard.press('Escape')
  console.log('Whale girl activation refused its unavailable jobs API; marketplace and Router remain usable')
  const petRemoving = await hub('/uninstall', { name: 'whale-girl' })
  assert.equal((await waitTask(petRemoving.task)).status, 'done')
  const removedGraph = await page.evaluate(async () => {
    const boot = await (await window.__DSH_TRANSPORT__.fetch('/__boot__')).json()
    return boot.injections.find(item => item.kind === 'global' && item.name === '__DSH_BOOT__').value.entries
  })
  assert(!removedGraph.some(entry => JSON.stringify(entry).includes('whale-girl')))
  const forgeAfterRemove = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert(!forgeAfterRemove.plugins.some(plugin => plugin.name === 'whale-girl'))
  const clientCleanupComplete = await page.locator('[data-whale-girl]').count() === 0
  console.log('Whale package removed; published Client cleanup completed: ' + clientCleanupComplete)

  const removing = await hub('/uninstall', { name: routerName })
  assert.equal((await waitTask(removing.task)).status, 'done')
  await page.getByRole('button', { name: '模型路由', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await command(), undefined)
  return {
    router: { package: `${routerName}@0.25.1`, hostCommand: true, clientWorkspace: true, hostVersion: routerHostVersion, singleRegistration: true, removed: true, modelRequest: false, nativeCli: false },
    whaleGirl: { package: 'whale-girl@0.1.0', status: 'activation-failed', missingApi: 'ctx.jobs.onJobDone', clientMounted: partialClientMounted, existingPluginPreserved: true, packageRemoved: true, clientCleanupComplete },
  }
}
