/** Real Worker resolution keeps ordinary dependency versions local to their importing package. */
import assert from 'node:assert/strict'

export const isolatedDependencyName = 'fast-deep-equal'
const wrapperName = 'forge-hub-private-reader'
const pluginA = 'forge-hub-dependency-a'
const pluginB = 'forge-hub-dependency-b'
const coreName = '@deepseek-ai/cordis'

/** Published packages exercise host peers and conflicting private versions in the same module graph. */
export function dependencyFixtures(target) {
  const versions = ['90.0.1', '90.0.2', '90.0.3']
  const dependencies = versions.map(version => ({
    manifest: { name: isolatedDependencyName, version, main: 'index.js' },
    source: `let count = 0; exports.read = () => ({ version: '${version}', count: ++count });`,
  }))
  const wrappers = versions.map((version, index) => ({
    manifest: { name: wrapperName, version: `1.0.${index}`, main: 'index.js', dependencies: { [isolatedDependencyName]: version } },
    source: `exports.read = require('${isolatedDependencyName}').read;`,
  }))
  const plugins = [[pluginA, '1.0.0', '1.0.0', 'a'], [pluginB, '1.0.0', '1.0.1', 'b'], [pluginA, '1.0.1', '1.0.2', 'a']].map(([name, version, wrapperVersion, command]) => ({
    manifest: { name, version, main: 'index.js',
      dependencies: { [wrapperName]: wrapperVersion },
      peerDependencies: { [isolatedDependencyName]: target.hostPackages[isolatedDependencyName], [coreName]: target.hostPackages[coreName] },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    patch: `- insert:\n    - id: ${name}\n      name: ${name}\n`,
    source: `const equal = require('${isolatedDependencyName}'); const { read } = require('${wrapperName}'); const { Context } = require('${coreName}'); exports.inject = ['commands']; exports.apply = ctx => { ctx.effect(() => ctx.commands.register({ name: 'forge-hub-dependency-${command}', description: 'Read private dependency and shared host peer', handler: () => ({ kind: 'success', text: JSON.stringify({ private: read(), hostEqual: equal({ nested: [1, 2] }, { nested: [1, 2] }), hostUnequal: equal({ nested: [1, 2] }, { nested: [1, 3] }), coreSameInstance: ctx instanceof Context }) }) })); };`,
  }))
  return [...dependencies, ...wrappers, ...plugins]
}

/** Install, update and remove private graphs while another plugin retains its module state. */
export async function verifyDependencyIsolation({ page, hub, waitTask, rpc, session, target, builds }) {
  const command = line => rpc('commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  const baseline = async () => JSON.parse((await command('/forge-hub-host-dependency')).result.text)
  const expectedHost = { hostEqual: true, hostUnequal: false, coreSameInstance: true }
  assert.equal(target.hostPackages[isolatedDependencyName], '3.1.3')
  assert(!target.sharedPackages.includes(isolatedDependencyName))
  assert.deepEqual(await baseline(), expectedHost)
  const install = async (name, version, mode = 'install') => {
    const created = await hub('/install', { repo: name, source: 'custom', installChannel: 'npm', lang: 'en', version, mode })
    assert.equal(created.ok, true, JSON.stringify(created))
    const task = await waitTask(created.task)
    assert.equal(task.status, 'done', JSON.stringify(task))
    const build = builds.get(`${name}@${version}`)
    assert.equal(build?.status, 200, JSON.stringify(build))
    const manifest = build.body
    assert.equal(manifest.hostPackages[isolatedDependencyName], '3.1.3')
    assert.equal(manifest.hostPackages[coreName], target.hostPackages[coreName])
    assert(!manifest.packages.some(pkg => pkg.name === coreName))
    const root = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
    const wrapper = manifest.packages.find(pkg => pkg.id === root.dependencies[wrapperName])
    const dependency = manifest.packages.find(pkg => pkg.id === wrapper.dependencies[isolatedDependencyName])
    assert.equal(dependency?.name, isolatedDependencyName)
    assert.equal(manifest.packages.filter(pkg => pkg.name === isolatedDependencyName).length, 1)
    const state = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert(state.batches.some(event => event.revision === manifest.revision && event.phase === 'activation' && event.paths.length > 0), JSON.stringify(state.batches))
    assert.equal(state.plugins.find(plugin => plugin.name === name)?.status, 'active')
    return dependency.version
  }
  const read = async (suffix, version, count) => {
    const observed = JSON.parse((await command(`/forge-hub-dependency-${suffix}`)).result.text)
    assert.deepEqual(observed, { private: { version, count }, ...expectedHost })
    return observed.private
  }
  assert.equal(await install(pluginA, '1.0.0'), '90.0.1')
  const initialA = await read('a', '90.0.1', 1)
  assert.equal(await install(pluginB, '1.0.0'), '90.0.2')
  const initialB = await read('b', '90.0.2', 1)
  await read('a', '90.0.1', 2)
  assert.equal(await install(pluginA, '1.0.1', 'update'), '90.0.3')
  const updatedA = await read('a', '90.0.3', 1)
  const retainedB = await read('b', '90.0.2', 2)
  for (const name of [pluginA, pluginB]) {
    const entries = (await hub('/debug/loader-entries')).entries
    assert.equal(entries.filter(entry => entry.name === name).length, 1)
    const removing = await hub('/uninstall', { name })
    assert.equal((await waitTask(removing.task)).status, 'done')
    assert.deepEqual(await baseline(), expectedHost)
    if (name === pluginA) await read('b', '90.0.2', 3)
  }
  assert.equal(await command('/forge-hub-dependency-a'), undefined)
  assert.equal(await command('/forge-hub-dependency-b'), undefined)
  const after = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert(!after.plugins.some(plugin => [pluginA, pluginB].includes(plugin.name)))
  console.log('Private dependency versions isolated; updating A preserved B module state and the real host peer')
  return { dependency: isolatedDependencyName, hostVersion: '3.1.3', initialA, initialB, updatedA, retainedB, hostAndPrivateInOneManifest: true, sharedCoreSameInstance: true, fileHooksObserved: true, hostPreservedAfterRemoval: true, removed: true }
}
