/** Native bundle overlays must update and restore only their declared test entry. */
import assert from 'node:assert/strict'

/** Local-registry package that owns only the acceptance overlay. */
export const overrideFixtureName = 'forge-hub-override-plugin'
const overriddenConfig = { label: 'overridden', enabled: true, nested: { count: 19, flags: [true], empty: null } }

/** Create published fixture versions that override an earlier native bundle. */
export function overrideFixtures(baseName) {
  return ['1.0.0', '1.0.1'].map(version => ({
    manifest: { name: overrideFixtureName, version, main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } },
    patch: `- id: ${baseName}\n  config: ${JSON.stringify(overriddenConfig)}\n  disabled: ${version === '1.0.1'}\n- insert:\n    - id: ${overrideFixtureName}\n      name: ${overrideFixtureName}\n`,
    source: `exports.name = '${overrideFixtureName}'; exports.inject = ['commands']; exports.apply = ctx => { ctx.effect(() => ctx.commands.register({ name: 'forge-hub-overlay', description: 'Inspect active overlay version', handler: () => ({ kind: 'success', text: '${version}' }) })); };\n`,
  }))
}

/** Check configuration replacement, disabled state and removal through real native bundle composition. */
export async function verifyBundleOverrides({ page, hub, waitTask, rpc, session, fixtureConfig, fixtureName }) {
  const command = line => rpc('commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  assert.deepEqual(JSON.parse((await command('/forge-hub-config')).result.text), fixtureConfig)
  for (const version of ['1.0.0', '1.0.1']) {
    const created = await hub('/install', { repo: overrideFixtureName, source: 'custom', installChannel: 'npm', lang: 'en', version, mode: version === '1.0.0' ? 'install' : 'update' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const task = await waitTask(created.task)
    assert.equal(task.status, 'done', JSON.stringify(task))
    assert.equal(task.exitCode, 0, JSON.stringify(task))
    assert.equal((await command('/forge-hub-overlay')).result.text, version)
    if (version === '1.0.0') assert.deepEqual(JSON.parse((await command('/forge-hub-config')).result.text), overriddenConfig)
    else {
      assert.equal(await command('/forge-hub-config'), undefined)
      assert.equal(await command('/forge-hub-child'), undefined)
    }
    const forge = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(forge.plugins.find(plugin => plugin.name === overrideFixtureName)?.status, 'active', JSON.stringify(forge))
    assert.equal(forge.plugins.find(plugin => plugin.name === fixtureName)?.status, version === '1.0.0' ? 'active' : 'disabled', JSON.stringify(forge))
    const entries = (await hub('/debug/loader-entries')).entries
    assert.equal(entries.filter(entry => entry.name === overrideFixtureName).length, 1)
    console.log(`Native overlay ${version}: ${version === '1.0.0' ? 'base configuration replaced' : 'base commands disabled'}; overlay remains active`)
  }
  const removing = await hub('/uninstall', { name: overrideFixtureName })
  assert.equal((await waitTask(removing.task)).status, 'done')
  assert.equal(await command('/forge-hub-overlay'), undefined)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  assert.deepEqual(JSON.parse((await command('/forge-hub-config')).result.text), fixtureConfig)
  const entries = (await hub('/debug/loader-entries')).entries
  assert.equal(entries.filter(entry => entry.name === overrideFixtureName).length, 0)
  assert.equal(entries.filter(entry => entry.name === fixtureName).length, 1)
  const forgeAfter = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert.equal(forgeAfter.plugins.find(plugin => plugin.name === fixtureName)?.status, 'active', JSON.stringify(forgeAfter))
  assert(!forgeAfter.plugins.some(plugin => plugin.name === overrideFixtureName))
  console.log('Overlay removal restored base commands and original nested configuration')
  return { package: overrideFixtureName, versions: ['1.0.0', '1.0.1'], configurationOverridden: true, baseDisabledOnUpdate: true, disabledStatusReported: true, overlayRemainedActive: true, baseRestoredOnRemoval: true, originalConfigurationRestored: true }
}
