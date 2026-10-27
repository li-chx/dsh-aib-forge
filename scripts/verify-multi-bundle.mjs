/** Multi-entry package composition through real Forge builds and the browser's native Loader. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const name = 'forge-multi-bundle'
const parts = ['knowledge', 'tool-knowledge', 'ui-knowledge']

/** Published fixtures mirror a service, tool and UI bundle without native dependencies. */
export function multiBundleFixtures() {
  return ['1.0.0', '1.0.1', '1.0.2'].map(version => {
    const selected = version === '1.0.2' ? [parts[0], parts[2]] : parts
    const moduleName = part => part === 'ui-knowledge' ? name : `${name}/${part}`
    return {
      manifest: { name, version, main: 'lib/ui-knowledge.js', exports: { '.': './lib/ui-knowledge.js', './knowledge': './lib/knowledge.js', './tool-knowledge': './lib/tool-knowledge.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      patch: '# multi-entry package defaults\n- insert:\n' + selected.map(part => `  - id: ${part}\n    name: ${moduleName(part)}\n    config: {label: retained}\n`).join(''),
      files: Object.fromEntries(parts.map(part => [`lib/${part}.js`, `exports.inject = ['connection']; exports.apply = (ctx, config) => { ctx.effect(() => ctx.connection.fetch.register({ path: '/api/forge-multi/${part}', methods: ['GET'], requestBody: 'buffered', fetch: () => Response.json({ part: '${part}', version: '${version}', config }) })); };\n`])),
    }
  })
}

/** Verify activation, disabled updates, cold restoration and removal of every bundle member. */
export async function verifyMultiBundle({ browser, origin, backendUrl, target, root, refreshSnapshot }) {
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  const runtime = (path, body) => page.evaluate(async ({ path, body }) => {
    const response = await window.__DSH_TRANSPORT__.fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: response.ok ? await response.json() : await response.text() }
  }, { path, body })
  const ready = () => page.getByRole('textbox', { name: 'Choose workspace' }).waitFor()
  const state = async expected => {
    const result = await runtime('/__forge/installed')
    assert.equal(result.status, 200)
    assert.equal(result.body.plugins.find(plugin => plugin.name === name)?.status, expected, JSON.stringify(result))
  }
  const probe = async (version, selected = parts) => {
    for (const part of parts) {
      const result = await runtime(`/api/forge-multi/${part}`)
      if (selected.includes(part)) assert.deepEqual(result, { status: 200, body: { part, version, config: { label: 'retained' } } })
      else assert.equal(result.status, 404, JSON.stringify(result))
    }
  }
  const toggle = async enabled => {
    const method = 'pluginManager/setBundleEnabled'
    const result = await runtime(`/api/${method}`, { type: 'client-request', rpcId: method, method, payload: { args: { name, enabled } } })
    assert.equal(result.body.result?.ok, true, JSON.stringify(result))
    assert.equal(result.body.result.value.application, 'applied', JSON.stringify(result))
  }
  const install = async (version, expected = 'active') => {
    const response = await fetch(`${backendUrl}/v1/packages/builds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: name, spec: `${name}@${version}` }), signal: AbortSignal.timeout(120000) })
    const manifest = await response.json()
    assert.equal(response.status, 200, JSON.stringify(manifest))
    const result = await runtime('/__forge/install', { manifest, baseUrl: backendUrl })
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.equal(result.body.status, expected, JSON.stringify(result))
  }
  try {
    await page.goto(`${origin}/preview.html?preview-fixture=none&storage=indexeddb&forge=${encodeURIComponent(backendUrl)}`)
    await ready()
    await install('1.0.0')
    await state('active')
    await probe('1.0.0')
    await toggle(false)
    await state('disabled')
    await probe('1.0.0', [])
    await install('1.0.1', 'disabled')
    await state('disabled')
    await probe('1.0.1', [])
    await toggle(true)
    await state('active')
    await probe('1.0.1')
    const saved = await runtime('/__storage/flush', {})
    assert.equal(saved.body.kind, 'saved', JSON.stringify(saved))
    await page.reload()
    await ready()
    await state('active')
    await probe('1.0.1')
    await install('1.0.2')
    await probe('1.0.2', [parts[0], parts[2]])
    const removed = await runtime('/__forge/remove', { pluginId: name })
    assert.equal(removed.body.status, 'removed', JSON.stringify(removed))
    await probe('1.0.2', [])
    assert.equal((await runtime('/__forge/installed')).body.plugins.some(plugin => plugin.name === name), false)
    const flushed = await runtime('/__storage/flush', {})
    assert.equal(flushed.body.kind, 'saved')
    await page.reload()
    await ready()
    await probe('1.0.2', [])
    assert.equal((await runtime('/__forge/installed')).body.plugins.some(plugin => plugin.name === name), false)
    const observed = { package: name, entries: parts, configurationRetained: true, allEntriesActivated: true, disabledUpdatePreserved: true, coldRestore: true, obsoleteMemberUnloaded: true, allEntriesRemoved: true, removalRestored: true }
    const text = JSON.stringify(observed, null, 2) + '\n'
    const golden = resolve(root, 'tests/expected/multi-bundle.json')
    if (refreshSnapshot) await writeFile(golden, text)
    else assert.equal(text, await readFile(golden, 'utf8'))
    console.log(text)
  } finally { await context.close() }
}
