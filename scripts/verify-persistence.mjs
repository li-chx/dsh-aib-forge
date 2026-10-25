/** Real IndexedDB cold starts, durable plugin lifecycle and visible failed writes in Chrome. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const name = 'forge-browser-persistence'
const initialConfig = { label: 'initial', nested: { count: 7, flags: [true, false] } }
const editedConfig = { label: 'edited', nested: { count: 19, flags: [false] } }

/** Published packages exercise native bundle selection and durable configuration. */
export function persistenceFixtures() {
  return ['1.0.0', '1.0.1'].map(version => ({
    manifest: { name, version, main: 'index.js', exports: {'.':'./index.js','./client':'./client.js'}, dsh: { bundle: { patch: './cordis.patch.yml' }, client: {inject:[],platform:'web'} } },
    patch: `- insert:\n    - id: ${name}\n      name: ${name}\n      config: ${JSON.stringify(initialConfig)}\n`,
    files: { 'client.js': `window.__ModuleLoader__.load({id:'${name}',factory:()=>({name:'${name}-client',apply:ctx=>{ctx.effect(()=>{const marker=document.createElement('output');marker.dataset.persistenceClient='${version}';marker.textContent='Persistent fixture ${version}';document.body.append(marker);return()=>marker.remove()})}})});` },
    source: `const fs = require('node:fs'); exports.name = '${name}'; exports.inject = ['commands']; exports.apply = (ctx, config) => {
      const file = '/dsh/workspace/persistence.txt';
      const register = (name, handler) => ctx.effect(() => ctx.commands.register({name, description:'Inspect durable browser data', handler}));
      register('forge-store-read', () => ({kind:'success',text:JSON.stringify({version:'${version}',config,content:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,fixture:fs.existsSync('/dsh/workspace/fixture.txt')?fs.readFileSync('/dsh/workspace/fixture.txt','utf8'):null})}));
      register('forge-store-write', () => { fs.writeFileSync(file, 'saved-' + (Number(fs.existsSync(file)?fs.readFileSync(file,'utf8').split('-')[1]:0)+1)); return {kind:'success',text:fs.readFileSync(file,'utf8')}; });
      register('forge-store-config', () => { fs.writeFileSync('/dsh/home/profiles/web/cordis.patch.yml', JSON.stringify([{id:'${name}',config:${JSON.stringify(editedConfig)}}])); return {kind:'success',text:'configuration written'}; });
    };\n`,
  }))
}

/** Source overlays are isolated in the temporary HTTP server, not in a public preview. */
export async function preparePersistenceSources({ images, temporary, packVfsOverlay }) {
  const directory = join(temporary, 'persistence-source')
  await mkdir(directory)
  await writeFile(join(directory, 'fixture.txt'), 'isolated source')
  images.set('/preview/persistence-source.tar.gz', packVfsOverlay([{ directory, mount: 'workspace' }]).image)
  images.set('/preview/fixtures.json', Buffer.from(JSON.stringify({ version: 1, defaultFixture: null, fixtures: [
    { id: 'persistence-source', label: 'Persistence source', description: 'Isolated browser acceptance data', overlays: ['persistence-source.tar.gz'] },
  ] })))
}

/** Confirm real reloads restore committed bytes without a Forge connection. */
export async function verifyPersistence({ browser, origin, backendUrl, target, root, refreshSnapshot }) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  let workers = 0
  page.on('worker', () => { workers++ })
  const logs = []
  page.on('console', message => { if (message.type() === 'error') logs.push(message.text()) })
  const url = `${origin}/preview.html?preview-fixture=none&forge=${encodeURIComponent(backendUrl)}`
  const rpc = async (targetPage, method, args) => {
    const result = await targetPage.evaluate(async ({ method, args }) => {
      const response = await window.__DSH_TRANSPORT__.fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } }) })
      return response.json()
    }, { method, args })
    assert.equal(result.result?.ok, true, JSON.stringify(result))
    return result.result.value
  }
  const runtime = (targetPage, path, body) => targetPage.evaluate(async ({ path, body }) => {
    const response = await window.__DSH_TRANSPORT__.fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(value))
    return value
  }, { path, body })
  const flush = async targetPage => {
    const value = await runtime(targetPage, '/__storage/flush', {})
    assert.equal(value.kind, 'saved', JSON.stringify(value))
    await targetPage.locator('[data-worker-storage="saved"]').waitFor()
    return value
  }
  const ready = async targetPage => {
    await targetPage.waitForFunction(() => Boolean(window.__DSH_TRANSPORT__))
    await targetPage.getByRole('button', { name: 'DSH Forge', exact: true }).waitFor()
    await targetPage.getByRole('button', { name: 'Plugins', exact: true }).waitFor()
    const welcome = targetPage.getByRole('button', { name: 'Continue', exact: true })
    if (await welcome.isVisible()) await welcome.click()
    const setup = targetPage.getByRole('dialog', { name: 'Get started', exact: true })
    if (await setup.isVisible()) {
      await setup.getByRole('button', { name: 'Add API Key', exact: true }).click()
      await targetPage.getByRole('button', { name: 'Configure later', exact: true }).click()
    }
    const layout = await targetPage.evaluate(() => {
      const bar = document.querySelector('[data-worker-storage]')
      const root = document.getElementById('root')
      const launcher = [...bar.querySelectorAll('button')].find(button => button.textContent === 'DSH Forge')
      return {display:getComputedStyle(bar).display,position:getComputedStyle(launcher).position,barBottom:bar.getBoundingClientRect().bottom,appTop:root.getBoundingClientRect().top}
    })
    assert.equal(layout.display, 'flex', 'Persistence toolbar CSS must load with the preview bootstrap')
    assert.equal(layout.position, 'static', 'Forge launcher belongs in the toolbar rather than overlapping menus')
    assert(layout.appTop >= layout.barBottom, JSON.stringify(layout))
  }
  const install = async (version, targetPage = page) => {
    const response = await fetch(`${backendUrl}/v1/packages/builds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: name, spec: `${name}@${version}` }) })
    const manifest = await response.json()
    assert.equal(response.status, 200, JSON.stringify(manifest))
    const result = await runtime(targetPage, '/__forge/install', { manifest, baseUrl: backendUrl })
    assert.equal(result.status, 'active', JSON.stringify(result))
    return manifest
  }
  let session
  const command = (line, targetPage = page) => rpc(targetPage, 'commands/execute', { agentId: session.sessionId, line, submittedAttachments: [] })
  const read = async (targetPage = page) => JSON.parse((await command('/forge-store-read', targetPage)).result.text)
  const toggle = async enabled => {
    const result = await rpc(page, 'pluginManager/setBundleEnabled', { name, enabled })
    assert.equal(result.application, 'applied', JSON.stringify(result))
  }
  const reload = async () => {
    const before = await page.evaluate(() => performance.timeOrigin)
    await page.reload()
    await ready(page)
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), before)
  }
  try {
    const intercepted = Promise.withResolvers()
    const release = Promise.withResolvers()
    const continued = Promise.withResolvers()
    const storageModule = '**/assets/preview-storage-*.js'
    let held = false
    const holdStorageModule = async route => {
      held = true
      intercepted.resolve()
      await release.promise
      try { await route.continue() } finally { continued.resolve() }
    }
    await page.route(storageModule, holdStorageModule)
    try {
      const requested = page.waitForRequest(storageModule)
      await page.goto(url, { waitUntil: 'commit' })
      // AppWebEntry constructs this page before it awaits the startup barrier.
      await Promise.all([requested, page.locator('[data-dsh-boot]').waitFor()])
      await intercepted.promise
      const waiting = await page.evaluate(async () => {
        const barrier = window.__DSH_BOOT_READY__
        let settled = false
        barrier?.promise.then(() => { settled = true }, () => { settled = true })
        await Promise.resolve()
        return { barrierInstalled:Boolean(barrier),barrierSettled:settled,facadeInstalled:Boolean(window.__ModuleLoader__),bootText:document.querySelector('[data-dsh-boot]')?.textContent }
      })
      assert.equal(waiting.barrierInstalled, true, JSON.stringify(waiting))
      assert.equal(waiting.barrierSettled, false, JSON.stringify(waiting))
      assert.equal(waiting.facadeInstalled, false, JSON.stringify(waiting))
      assert(!waiting.bootText.includes('Failed to load plugins'), JSON.stringify(waiting))
      console.log('Built application waits behind the installed boot barrier while storage UI JavaScript is held')
    } finally {
      release.resolve()
      if (held) await continued.promise
      await page.unroute(storageModule, holdStorageModule)
    }
    await ready(page)
    console.log('Persistent Worker ready; installing fixture')
    await install('1.0.0')
    console.log('Persistent fixture active; writing session and workspace')
    session = await rpc(page, 'session/create', { request: { cwd: '/dsh/workspace' } })
    const renamed = await rpc(page, 'session/rename', { request: { sessionId: session.sessionId, title: 'Durable browser session' } })
    assert.equal((await command('/forge-store-write')).result.text, 'saved-1')
    assert.deepEqual((await read()).config, initialConfig)
    await command('/forge-store-config')
    await page.waitForFunction(async ({ id, expected }) => {
      const response = await window.__DSH_TRANSPORT__.fetch('/api/commands/execute', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId:'read',method:'commands/execute',payload:{args:{agentId:id,line:'/forge-store-read',submittedAttachments:[]}}}) })
      const value = await response.json()
      return value.result?.value?.result?.text && JSON.parse(value.result.value.result.text).config.label === expected
    }, { id: session.sessionId, expected: 'edited' })
    await page.locator('[data-persistence-client="1.0.0"]').waitFor()
    await flush(page)
    const beforeSessions = await rpc(page, 'session/list', { _request:{} })
    assert.equal(renamed.title, 'Durable browser session')
    assert(beforeSessions.items.some(item=>item.sessionId===session.sessionId && item.projections.values.title===renamed.title))
    const storedSession = await page.evaluate(async id => {
      const namespaces=await indexedDB.databases()
      const name=namespaces.find(item=>item.name.startsWith('dsh-vfs:')).name
      const database=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      const tx=database.transaction('chunks')
      const request=method=>new Promise((resolve,reject)=>{const request=tx.objectStore('chunks')[method]();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      const [keys,values]=await Promise.all([request('getAllKeys'),request('getAll')])
      database.close()
      return keys.flatMap((key,index)=>String(key[0]).includes(id) && String(key[0]).endsWith('/session.v4.jsonl')?[{bytes:values[index].length,title:new TextDecoder().decode(values[index]).includes('Durable browser session')}]:[])
    },session.sessionId)
    assert(storedSession.some(chunk=>chunk.title), `Storage flush acknowledged before the Session title reached IndexedDB: ${JSON.stringify(storedSession)}`)
    await context.route(`${backendUrl}/**`, route => route.abort())
    await reload()
    await page.locator('[data-persistence-client="1.0.0"]').waitFor()
    assert.deepEqual(await read(), { version:'1.0.0',config:editedConfig,content:'saved-1',fixture:null })
    const sessions = await rpc(page, 'session/list', { _request:{} })
    assert(sessions.items.some(item => item.sessionId === session.sessionId && item.projections.values.title === 'Durable browser session'), JSON.stringify({expectedSessionId:session.sessionId,...sessions}))
    assert.equal((await runtime(page, '/__forge/installed')).plugins.find(plugin => plugin.name === name)?.status, 'active')
    console.log('IndexedDB reload restored plugin, edited configuration, workspace and named session with Forge offline')
    await context.unroute(`${backendUrl}/**`)
    await toggle(false)
    await flush(page)
    await reload()
    assert.equal((await runtime(page, '/__forge/installed')).plugins.find(plugin => plugin.name === name)?.status, 'disabled')
    assert.equal(await command('/forge-store-read'), undefined)
    assert.equal(await page.locator('[data-persistence-client]').count(), 0)
    await toggle(true)
    assert.deepEqual((await read()).config, editedConfig)
    await install('1.0.1')
    await flush(page)
    await reload()
    await page.locator('[data-persistence-client="1.0.1"]').waitFor()
    assert.equal((await read()).version, '1.0.1')
    assert.deepEqual((await read()).config, editedConfig)
    console.log('Native disabled selection and updated artifacts survived separate Worker starts')

    const other = await context.newPage()
    other.setDefaultTimeout(30000)
    await other.goto(url.replace('preview-fixture=none', 'preview-fixture=persistence-source'))
    await ready(other)
    assert.equal((await runtime(other, '/__forge/installed')).plugins.length, 0)
    const isolatedSession = await rpc(other, 'session/create', { request:{cwd:'/dsh/workspace'} })
    await install('1.0.0', other)
    const isolated = await rpc(other, 'commands/execute', {agentId:isolatedSession.sessionId,line:'/forge-store-read',submittedAttachments:[]})
    assert.deepEqual(JSON.parse(isolated.result.text), {version:'1.0.0',config:initialConfig,content:null,fixture:'isolated source'})
    await flush(other)
    await other.close()
    console.log('Distinct source overlay retained an independent plugin catalog, configuration and workspace')

    await flush(page)
    const stale = await context.newPage()
    stale.setDefaultTimeout(30000)
    await stale.goto(url)
    await ready(stale)
    await flush(stale)
    // Boot may itself commit profile/session housekeeping. Choose the lower acknowledged revision as the stale writer.
    const before = [await runtime(page, '/__storage/status'), await runtime(stale, '/__storage/status')]
    const current = before[0].revision > before[1].revision ? page : stale
    const outdated = current === page ? stale : page
    await command('/forge-store-write', current)
    await flush(current)
    const winningContent = (await read(current)).content
    await command('/forge-store-write', outdated)
    const conflict = await runtime(outdated, '/__storage/flush', {})
    assert.equal(conflict.kind, 'failed', JSON.stringify(conflict))
    assert.equal(conflict.error.code, 'STORAGE_CONFLICT')
    await outdated.locator('[data-worker-storage="failed"]').waitFor()
    assert.match(await outdated.locator('[data-worker-storage]').innerText(), /Another tab saved changes/)
    await outdated.screenshot({path:resolve(root,'.data/forge-storage-conflict.png')})
    await stale.close()
    await reload()
    await flush(page)
    assert.equal((await read()).content, winningContent)
    console.log('A stale tab rejected its write visibly without overwriting the committed version')

    const committedBeforeAbort = await read()
    await page.workers()[0].evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction
      let injected = false
      IDBDatabase.prototype.transaction = function (...args) {
        const value = Reflect.apply(transaction, this, args)
        if (!injected && args[1] === 'readwrite') { injected = true; queueMicrotask(() => value.abort()) }
        return value
      }
    })
    await command('/forge-store-write')
    const rejected = await runtime(page, '/__storage/flush', {})
    assert.equal(rejected.kind, 'failed', JSON.stringify(rejected))
    assert.equal(rejected.error.code, 'STORAGE_FAILED', JSON.stringify(rejected))
    await page.locator('[data-worker-storage="failed"]').waitFor()
    assert.match(await page.locator('[data-worker-storage]').innerText(), /Local saving stopped/)
    await page.screenshot({path:resolve(root,'.data/forge-storage-aborted.png')})
    await reload()
    await flush(page)
    assert.deepEqual(await read(), committedBeforeAbort)
    console.log('An actual IndexedDB transaction abort remained visible; a fresh Worker reopened the last commit')

    const removed = await runtime(page, '/__forge/remove', { pluginId:name })
    assert.equal(removed.status, 'removed')
    await flush(page)
    await reload()
    assert.equal((await runtime(page, '/__forge/installed')).plugins.length, 0)
    assert.equal(await page.locator('[data-persistence-client]').count(), 0)
    assert.equal(await command('/forge-store-read'), undefined)
    await page.screenshot({path:resolve(root,'.data/forge-storage-saved.png')})
    await page.setViewportSize({width:390,height:844})
    const mobile = await page.locator('[data-worker-storage]').evaluate(bar => ({ left:bar.getBoundingClientRect().left,right:bar.getBoundingClientRect().right,width:innerWidth }))
    assert(mobile.left >= 0 && mobile.right <= mobile.width, JSON.stringify(mobile))
    await page.screenshot({path:resolve(root,'.data/forge-storage-mobile.png')})
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme',''))
    await page.screenshot({path:resolve(root,'.data/forge-storage-dark.png')})
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))

    // Corrupt only this acceptance namespace, retaining the invalid bytes across the failed boot.
    const corrupt = await page.evaluate(async () => {
      const databases = await indexedDB.databases()
      const name = databases.find(database => database.name?.startsWith('dsh-vfs:') && JSON.parse(JSON.parse(database.name.slice('dsh-vfs:'.length))[2]).overlays.length === 0)?.name
      if (!name) throw new Error('Acceptance database not found')
      const database = await new Promise((resolve,reject) => {const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      await new Promise((resolve,reject) => {const tx=database.transaction('metadata','readwrite');tx.objectStore('metadata').put('corrupt-revision','revision');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)})
      database.close()
      return name
    })
    await page.reload()
    await page.locator('[data-worker-storage="failed"]').waitFor()
    assert.match(await page.locator('[data-worker-storage]').innerText(), /Startup failed|Local saving stopped/)
    assert.equal(await page.evaluate(async name => {
      const database=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      const value=await new Promise((resolve,reject)=>{const request=database.transaction('metadata').objectStore('metadata').get('revision');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      database.close();return value
    }, corrupt), 'corrupt-revision')
    assert.equal(await page.evaluate(() => Boolean(window.__DSH_TRANSPORT__)), false)
    await page.screenshot({path:resolve(root,'.data/forge-storage-corrupt.png')})
    const observed = { storage:'IndexedDB', defaultEnabled:true,delayedStorageModule:{barrierInstalledBeforeApp:true,facadeAbsentWhileWaiting:true,noPrematureFailure:true},toolbar:{cssLoaded:true,normalFlow:true,narrowViewport:true}, committedReload:{plugin:true,client:true,editedConfiguration:true,workspace:true,namedSession:true}, forgeOfflineRestore:true, disabledSelectionRestored:true, updateRestored:true, uninstallRestored:true, sourceIsolated:true, staleTab:{code:'STORAGE_CONFLICT',visible:true}, abortedTransaction:{code:'STORAGE_FAILED',visible:true,recoveredByReload:true}, corruptedBoot:{rejected:true,bytesRetained:true}, coldWorkerStarts:workers }
    const text = JSON.stringify(observed,null,2)+'\n'
    const golden=resolve(root,'tests/expected/persistence.json')
    if(refreshSnapshot) await writeFile(golden,text)
    else assert.equal(text,await readFile(golden,'utf8'))
    console.log(text)
    return observed
  } catch(error) {
    await page.screenshot({path:resolve(root,'.data/forge-persistence-failure.png')}).catch(()=>{})
    console.error(logs.join('\n'))
    throw error
  } finally { await context.close() }
}
