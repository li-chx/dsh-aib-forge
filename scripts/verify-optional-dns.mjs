/** Optional Node namespaces allow explicit fallback without pretending to implement native DNS. */
import assert from 'node:assert/strict'

const fallbackName = 'forge-hub-dns-fallback'
const requiredName = 'forge-hub-dns-required'
/** Unsupported TCP import remains a compile-time refusal in the fixture registry. */
export const unsupportedNetName = 'forge-hub-net-required'
const refusal = { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', message: 'web-preview: node:dns.setDefaultResultOrder is not available in the worker host' }

/** Build isolated packages for caught DNS calls, uncaught calls and unsupported network imports. */
export function dnsFixtures() {
  return [
    { name: fallbackName, source: `const dns = require('node:dns'); let fallback; try { dns.setDefaultResultOrder('ipv4first'); } catch (error) { fallback = { code: error.code, message: error.message }; } exports.inject = ['commands']; exports.apply = ctx => { ctx.effect(() => ctx.commands.register({ name: 'forge-hub-dns', description: 'Inspect optional DNS fallback', handler: () => ({ kind: 'success', text: JSON.stringify(fallback) }) })); };` },
    { name: requiredName, source: `const dns = require('node:dns'); exports.apply = () => { dns.setDefaultResultOrder('ipv4first'); };` },
    { name: unsupportedNetName, source: `const net = require('node:net'); exports.apply = () => { net.createConnection(1); };` },
  ].map(({ name, source }) => ({
    manifest: { name, version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } },
    patch: `- insert:\n    - id: ${name}\n      name: ${name}\n`, source,
  }))
}

/** Execute fallback, contain required-capability failure, and retain rejection of unsupported TCP imports. */
export async function verifyOptionalDns({ page, hub, waitTask, rpc, session, netBuildFailure }) {
  const command = line => rpc('commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  const install = async name => {
    const created = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', version: '1.0.0' })
    assert.equal(created.ok, true, JSON.stringify(created))
    return waitTask(created.task)
  }
  const fallback = await install(fallbackName)
  assert.equal(fallback.status, 'done', JSON.stringify(fallback))
  assert.deepEqual(JSON.parse((await command('/forge-hub-dns')).result.text), refusal)
  const required = await install(requiredName)
  assert.equal(required.status, 'failed', JSON.stringify(required))
  assert(required.lines.some(line => line.includes(refusal.message)), JSON.stringify(required))
  const installed = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert.equal(installed.plugins.find(plugin => plugin.name === requiredName)?.status, 'activation-failed', JSON.stringify(installed))
  assert.equal(installed.plugins.find(plugin => plugin.name === fallbackName)?.status, 'active', JSON.stringify(installed))
  assert.deepEqual(JSON.parse((await command('/forge-hub-dns')).result.text), refusal)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  const unsupported = await install(unsupportedNetName)
  assert.equal(unsupported.status, 'failed', JSON.stringify(unsupported))
  const build = netBuildFailure()
  assert(build && build.status >= 400)
  assert.equal(build.body.error.code, 'NODE_MODULE_UNSUPPORTED')
  assert.match(build.body.error.message, /node:net/)
  for (const name of [requiredName, fallbackName]) {
    const removing = await hub('/uninstall', { name })
    assert.equal((await waitTask(removing.task)).status, 'done')
  }
  assert.equal(await command('/forge-hub-dns'), undefined)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  console.log('Optional DNS fallback executed; uncaught capability failure contained; node:net still rejected')
  return { imported: true, caughtCall: refusal, fallbackCommandExecuted: true, uncaughtStatus: 'activation-failed', existingPluginPreserved: true, unsupportedNetCode: build.body.error.code, removed: true }
}
