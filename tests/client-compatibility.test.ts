/** Hub's published intermediate installation state must not retire its settings slot. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { applyClientCompatibility } from '../src/client-compatibility.js'

// The relevant function from the MIT-licensed dsh-plugin@2.2.1 Client publication.
const published = `function hasUpdateOf(plugin, installed, versions) {
  if (installedNameOf(plugin, installed, versions) === null) return false;
  const repo = plugin.source?.repo;
  if (!repo) return false;
  const rec = versions[repo.toLowerCase()];
  if (!rec) return false;
  if (plugin.version) return compareVersions(plugin.version, rec.version) > 0;
  const current = plugin.dates?.repoUpdatedAt;
  return Boolean(current && rec.updatedAt && current > rec.updatedAt);
}`
const reloadPaths = `
const zh = {
  reloadHint: "插件已加载，关闭本窗口后会自动刷新页面生效。",
  toastInstalledReload: "安装成功，正在自动刷新页面…",
};
const en = {
  reloadHint: "The plugin is loaded — closing this window will refresh the page automatically.",
  toastInstalledReload: "Installed — refreshing the page automatically…",
};
const scheduleAutoReload = () => {
  window.setTimeout(() => window.location.reload(), 1600);
};
function backgroundInstall(viaModal, reload) { if (!viaModal && reload) scheduleAutoReload(); }
function backgroundUninstall(viaModal, reload) { if (!viaModal && reload) scheduleAutoReload(); }
function closeCatalog(reload) { if (reload) window.location.reload(); }
function closeCustom(reload) { if (reload) window.location.reload(); }
function closeGlobal(reload) { if (reload) window.location.reload(); }
function closeUninstall(reload) { if (reload) window.location.reload(); }
function explicitRestart() { window.location.reload(); }
function retryCatalog() { window.retry(); }
`
const bundle = published + reloadPaths
const bytes = new TextEncoder().encode(bundle)

test('accepts the npm mapping before version sync, then compares the complete record', () => {
  const patched = new TextDecoder().decode(applyClientCompatibility('dsh-plugin', '2.2.1', bytes))
  const evaluate = (source: string, record: Record<string, string>): unknown => runInNewContext(
    `${source}; hasUpdateOf(plugin, installed, versions)`, {
      plugin: { source: { repo: 'owner/plugin' }, version: '3.2.1' },
      installed: { mobile: '3.2.1' }, versions: { 'owner/plugin': record },
      installedNameOf: () => 'mobile',
      compareVersions: (a: string, b: string) => a.localeCompare(b.split('+')[0]!, undefined, { numeric: true }),
    })
  assert.throws(() => evaluate(published, { npmPackage: 'mobile' }), /split/)
  assert.equal(evaluate(patched, { npmPackage: 'mobile' }), false)
  assert.equal(evaluate(patched, { npmPackage: 'mobile', version: '' }), false)
  assert.equal(evaluate(patched, { npmPackage: 'mobile', version: '3.2.0' }), true)
  assert.equal(evaluate(patched, { npmPackage: 'mobile', version: '3.2.1' }), false)
  assert.equal(evaluate(patched, { npmPackage: 'mobile', version: '3.2.2' }), false)
})

test('leaves other publications untouched and refuses an unexpected target bundle', () => {
  assert.equal(applyClientCompatibility('another-plugin', '2.2.1', bytes), bytes)
  assert.equal(applyClientCompatibility('dsh-plugin', '2.2.2', bytes), bytes)
  assert.throws(() => applyClientCompatibility('dsh-plugin', '2.2.1', new TextEncoder().encode('changed')), /does not match/)
  assert.throws(() => applyClientCompatibility('dsh-plugin', '2.2.1', new TextEncoder().encode(bundle + bundle)), /does not match/)
})


test('successful modal and background operations preserve the document while explicit restart and retry remain available', () => {
  const patched = new TextDecoder().decode(applyClientCompatibility('dsh-plugin', '2.2.1', bytes))
  const run = (source: string) => {
    const state = { reloads: 0, timers: 0, retries: 0 }
    const context = {
      window: {
        location: { reload: () => { state.reloads += 1 } },
        setTimeout: (callback: () => void) => { state.timers += 1; callback() },
        retry: () => { state.retries += 1 },
      },
    }
    runInNewContext(source + `;
      backgroundInstall(false, true); backgroundUninstall(false, true);
      closeCatalog(true); closeCustom(true); closeGlobal(true); closeUninstall(true);
    `, context)
    const successfulReloads = state.reloads
    runInNewContext(source + '; explicitRestart(); retryCatalog();', { ...context })
    return { ...state, successfulReloads }
  }
  assert.deepEqual(run(bundle), { reloads: 7, timers: 2, retries: 1, successfulReloads: 6 })
  assert.deepEqual(run(patched), { reloads: 1, timers: 0, retries: 1, successfulReloads: 0 })
  assert.match(patched, /插件变更已热加载生效，无需刷新页面/)
  assert.match(patched, /Plugin changes are active through hot loading/)
  assert.ok(!patched.includes('正在自动刷新页面'))
  assert.ok(!patched.includes('refreshing the page automatically'))
  assert.throws(() => applyClientCompatibility('dsh-plugin', '2.2.1', new TextEncoder().encode(bundle.replace('if (reload) window.location.reload();', ''))), /does not match/)
})
