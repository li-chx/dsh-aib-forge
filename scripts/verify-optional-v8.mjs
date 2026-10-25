/** Optional Node namespaces allow explicit fallback without pretending to implement native V8 heap inspection. */
import assert from 'node:assert/strict'

const fallbackName = 'forge-hub-v8-fallback'
const requiredName = 'forge-hub-v8-required'
const refusal = { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', message: 'web-preview: node:v8.getHeapStatistics is not available in the worker host' }

/** Build isolated packages for caught and uncaught V8 heap calls. */
export function v8Fixtures() {
  return [
    { name: fallbackName, source: `const { getHeapStatistics } = require('node:v8'); let fallback; try { getHeapStatistics(); } catch (error) { fallback = { code: error.code, message: error.message }; } exports.inject = ['commands']; exports.apply = ctx => { ctx.effect(() => ctx.commands.register({ name: 'forge-hub-v8', description: 'Inspect optional V8 fallback', handler: () => ({ kind: 'success', text: JSON.stringify(fallback) }) })); };` },
    { name: requiredName, source: `const { getHeapStatistics } = require('node:v8'); exports.apply = () => { getHeapStatistics(); };` },
  ].map(({ name, source }) => ({
    manifest: { name, version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } },
    patch: `- insert:\n    - id: ${name}\n      name: ${name}\n`, source,
  }))
}

/** Execute fallback, contain required-capability failure, without claiming native heap measurements. */
export async function verifyOptionalV8({ page, hub, waitTask, rpc, session }) {
  const command = line => rpc('commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  const install = async name => {
    const created = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', version: '1.0.0' })
    assert.equal(created.ok, true, JSON.stringify(created))
    return waitTask(created.task)
  }
  const fallback = await install(fallbackName)
  assert.equal(fallback.status, 'done', JSON.stringify(fallback))
  assert.deepEqual(JSON.parse((await command('/forge-hub-v8')).result.text), refusal)
  const required = await install(requiredName)
  assert.equal(required.status, 'failed', JSON.stringify(required))
  assert(required.lines.some(line => line.includes(refusal.message)), JSON.stringify(required))
  const installed = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert.equal(installed.plugins.find(plugin => plugin.name === requiredName)?.status, 'activation-failed', JSON.stringify(installed))
  assert.equal(installed.plugins.find(plugin => plugin.name === fallbackName)?.status, 'active', JSON.stringify(installed))
  assert.deepEqual(JSON.parse((await command('/forge-hub-v8')).result.text), refusal)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  for (const name of [requiredName, fallbackName]) {
    const removing = await hub('/uninstall', { name })
    assert.equal((await waitTask(removing.task)).status, 'done')
  }
  assert.equal(await command('/forge-hub-v8'), undefined)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  console.log('Optional V8 fallback executed; uncaught heap capability failure contained')
  return { imported: true, caughtCall: refusal, fallbackCommandExecuted: true, uncaughtStatus: 'activation-failed', existingPluginPreserved: true, removed: true }
}
