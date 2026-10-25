/** Runtime module requests resolve delivered files without evaluating them during installation. */
import assert from 'node:assert/strict'

const pluginName = 'forge-hub-runtime-loading'
const stateName = 'forge-hub-runtime-state'
const lazyName = 'forge-hub-runtime-lazy'
const missingName = 'forge-hub-runtime-undeclared'
const hostReaderName = 'forge-hub-runtime-host-reader'
const hostPeerName = 'fast-deep-equal'

/** Package files preserve CommonJS, ESM, TypeScript, JSON and export-map requests. */
export function runtimeLoadingFixtures(target) {
  return ['1.0.0', '1.0.1'].flatMap(version => {
    const event = name => `${name}:${version}`
    const lazyFiles = {
      'lib/index.cjs': `require('${stateName}').add('${event('dependency')}'); exports.value = '${event('dependency')}';`,
      'lib/browser.cjs': `require('${stateName}').add('${event('browser')}'); exports.value = '${event('browser')}';`,
      'lib/default.cjs': `throw new Error('The default export must not replace the browser condition');`,
      'lib/items/detail.js': `require('${stateName}').add('${event('pattern')}'); exports.value = '${event('pattern')}';`,
      'lib/hidden.js': `throw new Error('An unexported file must not be executed');`,
    }
    return [
      { manifest: { name: hostReaderName, version, main: 'index.js', peerDependencies: { [hostPeerName]: target.hostPackages[hostPeerName] } },
        source: `const equal = require('${hostPeerName}'); exports.read = () => ({ equal: equal({ x: [1] }, { x: [1] }), unequal: equal({ x: [1] }, { x: [2] }) });` },
      { manifest: { name: stateName, version, main: 'index.js' },
        source: `const events = []; exports.add = event => { events.push(event); }; exports.snapshot = () => [...events];` },
      { manifest: { name: lazyName, version, main: 'lib/index.cjs', dependencies: { [stateName]: version },
        exports: { '.': './lib/index.cjs', './feature': { browser: './lib/browser.cjs', default: './lib/default.cjs' }, './items/*': './lib/items/*.js' } }, files: lazyFiles },
      { manifest: { name: pluginName, version, main: 'index.js', dependencies: { [stateName]: version, [lazyName]: version, [hostReaderName]: version }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
        patch: `- insert:\n    - id: ${pluginName}\n      name: ${pluginName}\n`,
        source: `const state = require('${stateName}');
const alias = require;
const original = typeof require === 'function' ? require : () => { throw new Error('A module loader is required'); };
const wrapped = new Proxy(function () { return original.apply(this, arguments); }, { get: (_target, key) => original[key] });
const packageName = ['forge', 'hub', 'runtime', 'lazy'].join('-');
const result = value => ({ kind: 'success', text: JSON.stringify(value) });
exports.inject = ['commands'];
exports.apply = ctx => {
  const register = (name, handler) => ctx.effect(() => ctx.commands.register({ name, description: 'Inspect runtime module loading', handler }));
  register('forge-runtime-status', () => result({ version: '${version}', events: state.snapshot() }));
  register('forge-runtime-resolve', () => result({ package: wrapped.resolve(packageName), relative: alias.resolve('./parts/' + 'typed'), events: state.snapshot() }));
  register('forge-runtime-load', async () => {
    const dependency = wrapped(packageName);
    const relative = alias('./parts/' + 'relative.cjs');
    const typed = alias('./parts/' + 'typed');
    const data = alias('./parts/' + 'data.json');
    const imported = await import('./parts/' + 'async.mjs');
    const importedPackage = await import(packageName);
    const subpath = alias(packageName + '/feature');
    const pattern = alias(packageName + '/items/' + 'detail');
    const hostPeer = alias('${hostReaderName}').read();
    return result({ dependency: dependency.value, relative: relative.value, typed: typed.value, data: data.version,
      imported: imported.value, importedPackage: importedPackage.value, subpath: subpath.value, pattern: pattern.value, hostPeer, events: state.snapshot() });
  });
  register('forge-runtime-missing', () => { alias(['forge', 'hub', 'runtime', 'undeclared'].join('-')); return result('unreachable'); });
  register('forge-runtime-host-leak', () => { alias(['fast', 'deep', 'equal'].join('-')); return result('unreachable'); });
  register('forge-runtime-unexported', () => { alias(packageName + '/lib/hidden.js'); return result('unreachable'); });
};`,
        files: {
          'parts/relative.cjs': `require('${stateName}').add('${event('relative')}'); exports.value = '${event('relative')}';`,
          'parts/typed.ts': `import { add } from '${stateName}'; const value: string = '${event('typed')}'; add(value); export { value };`,
          'parts/async.mjs': `import { add } from '${stateName}'; add('${event('async')}'); export const value = '${event('async')}';`,
          'parts/data.json': JSON.stringify({ version }),
        },
      },
    ]
  })
}

/** Check lazy evaluation, runtime errors, replacement and cleanup in the existing Worker. */
export async function verifyRuntimeLoading({ page, hub, waitTask, rpc, session, builds }) {
  const command = line => rpc('commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  const read = async line => JSON.parse((await command(line)).result.text)
  const failures = []
  let latestManifest
  for (const version of ['1.0.0', '1.0.1']) {
    const created = await hub('/install', { repo: pluginName, source: 'custom', installChannel: 'npm', lang: 'en', version, mode: version === '1.0.0' ? 'install' : 'update' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const task = await waitTask(created.task)
    assert.equal(task.status, 'done', JSON.stringify(task))
    const build = builds.get(`${pluginName}@${version}`)
    assert.equal(build?.status, 200, JSON.stringify(build))
    const manifest = build.body
    latestManifest = manifest
    const delivered = manifest.packages.find(pkg => pkg.name === lazyName && pkg.version === version)
    assert(delivered, 'A dependency referenced only by computed requests must be delivered')
    const plugin = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
    const hostReader = manifest.packages.find(pkg => pkg.name === hostReaderName)
    assert.equal(manifest.hostPackages[hostPeerName], '3.1.3')
    assert(hostReader.hostDependencies.includes(hostPeerName))
    assert(!plugin.hostDependencies.includes(hostPeerName))
    for (const path of ['index.js', 'parts/relative.cjs', 'parts/typed.ts', 'parts/async.mjs', 'parts/data.json']) assert(plugin.files.some(file => file.path === path), path)
    for (const path of ['lib/index.cjs', 'lib/browser.cjs', 'lib/default.cjs', 'lib/items/detail.js', 'lib/hidden.js']) assert(delivered.files.some(file => file.path === path), path)
    assert.deepEqual(await read('/forge-runtime-status'), { version, events: [] })
    const resolved = await read('/forge-runtime-resolve')
    assert(resolved.package.endsWith('/lib/index.cjs'), resolved.package)
    assert(resolved.relative.endsWith('/parts/typed.ts'), resolved.relative)
    assert.deepEqual(resolved.events, [])
    assert.deepEqual(await read('/forge-runtime-status'), { version, events: [] })
    const expectedEvents = ['dependency', 'relative', 'typed', 'async', 'browser', 'pattern'].map(name => `${name}:${version}`)
    const expected = { dependency: `dependency:${version}`, relative: `relative:${version}`, typed: `typed:${version}`, data: version,
      imported: `async:${version}`, importedPackage: `dependency:${version}`, subpath: `browser:${version}`, pattern: `pattern:${version}`, hostPeer: { equal: true, unequal: false }, events: expectedEvents }
    assert.deepEqual(await read('/forge-runtime-load'), expected)
    assert.deepEqual(await read('/forge-runtime-load'), expected)
    assert.deepEqual(await read('/forge-runtime-status'), { version, events: expectedEvents })
    for (const [line, diagnostic] of [['/forge-runtime-missing', `undeclared dependency "${missingName}"`], ['/forge-runtime-host-leak', `undeclared dependency "${hostPeerName}"`], ['/forge-runtime-unexported', 'does not export "./lib/hidden.js"']]) {
      const envelope = await page.evaluate(async ({ sessionId, line }) => {
        const method = 'commands/execute'
        const response = await window.__DSH_TRANSPORT__.fetch('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args: { agentId: sessionId, line, submittedAttachments: [] } } }) })
        return response.json()
      }, { sessionId: session.sessionId, line })
      assert.equal(envelope.result?.ok, false, JSON.stringify(envelope))
      assert(JSON.stringify(envelope).includes(JSON.stringify(diagnostic).slice(1, -1)), JSON.stringify(envelope))
      assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
      assert.deepEqual(await read('/forge-runtime-status'), { version, events: expectedEvents })
      if (version === '1.0.0') failures.push({ request: line, diagnostic })
    }
    const installed = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(installed.plugins.find(plugin => plugin.name === pluginName)?.status, 'active')
    assert(installed.batches.some(event => event.revision === manifest.revision && event.phase === 'activation' && event.paths.length > 0))
    assert.equal((await hub('/debug/loader-entries')).entries.filter(entry => entry.name === pluginName).length, 1)
    console.log(`Runtime loading ${version}: resolve did not evaluate; lazy modules executed once; undeclared and hidden imports failed without losing commands`)
  }
  const removing = await hub('/uninstall', { name: pluginName })
  assert.equal((await waitTask(removing.task)).status, 'done')
  assert.equal(await command('/forge-runtime-status'), undefined)
  assert.equal(await command('/forge-runtime-load'), undefined)
  const after = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert(!after.plugins.some(plugin => plugin.name === pluginName))
  assert(after.batches.some(event => event.pluginId === latestManifest.plugin.id && event.revision === latestManifest.revision && event.phase === 'activation' && event.status === 'removed' && event.paths.length > 0))
  assert.equal((await hub('/debug/loader-entries')).entries.filter(entry => entry.name === pluginName).length, 0)
  assert.equal((await command('/forge-hub-child')).result.text, 'hub child active')
  return { package: pluginName, versions: ['1.0.0', '1.0.1'], dynamicDependencyDelivered: true, aliasRequire: true, proxyLoaderWithApply: true, computedPackageName: true,
    resolutionWithoutEvaluation: true, dynamicRelativePath: true, extensionlessTypeScript: true, computedImport: true, computedPackageImport: true,
    conditionalSubpath: true, wildcardSubpath: true, hostPeerScopedToDeclaringPackage: true, modulesEvaluatedOnce: true, failures, priorCommandPreserved: true, updated: true, singleRegistration: true, writeHooks: true, removed: true }
}
