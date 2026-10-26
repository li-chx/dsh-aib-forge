/** Model-tool source authoring through a private compatible HTTP provider and the real Agent loop. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const pluginId = 'source-authoring'
const packageName = 'local-source-authoring'
const directory = '/dsh/workspace/source-authoring'
const buildCommand = `dsh plugin --profile web build ${directory}`
const helper = version => `export const revision = '${version}'\nexport async function message(value: string): Promise<string> { return Promise.resolve('source ${version}: ' + value) }\n`
const entry = `import isOdd from 'is-odd'\nimport { message } from './message.ts'\nexport const name = '${packageName}'\nexport const inject = ['commands']\nexport function apply(ctx: any) {\n  ctx.effect(() => ctx.commands.register({ name: 'source-proof', description: 'Inspect a compiled source plugin', handler: async () => ({ kind: 'success', text: await message(isOdd(3) ? 'odd' : 'even') }) }))\n}\n`
const manifest = version => ({ id:pluginId,name:packageName,version,entry:'index.ts',files:['index.ts','message.ts'],dependencies:{'is-odd':'3.0.1'} })
const write = (path, content) => ({ name:'write',args:{file_path:`${directory}/${path}`,content} })
const read = path => ({name:'read',args:{file_path:`${directory}/${path}`}})
const bash = command => ({name:'bash',args:{description:'Build the source plugin using the configured Forge service',command,workdir:'/dsh/workspace',timeoutMs:120000}})
const plans = {
  install:[write('forge.json',JSON.stringify(manifest('1.0.0'))),write('index.ts',entry),write('message.ts',helper('v1')),bash(buildCommand)],
  update:[read('forge.json'),read('message.ts'),write('forge.json',JSON.stringify(manifest('1.0.1'))),write('message.ts',helper('v2')),bash(buildCommand)],
  broken:[read('message.ts'),write('message.ts','export const broken: = ;\n'),bash(buildCommand)],
  repair:[read('message.ts'),write('message.ts',helper('v2'))],
  retained:[read('index.ts'),read('message.ts'),read('forge.json')],
  remove:[bash(`dsh plugin --profile web remove ${packageName}`)],
}

const counterHost = `
  const fs = require('node:fs');
  const countFile = '/dsh/workspace/source-counter.txt';
  let count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  const readers = new Set<() => void>();
  const closers = new Set<() => void>();
  ctx.effect(() => () => { for (const close of [...closers]) close(); });
  ctx.connection.fetch.register({ path: '/api/source-authoring.counter', methods: ['GET'], requestBody: 'buffered', fetch: async (request: Request) => {
    if (new URL(request.url).searchParams.has('inspect')) return Response.json({ count, readers: readers.size });
    let release = (_close = true) => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        const emit = () => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ count }) + '\\n\\n'));
        const stop = () => release();
        release = (close = true) => {
          if (!active) return;
          active = false;
          readers.delete(emit); closers.delete(stop);
          request.signal.removeEventListener('abort', stop);
          if (close) controller.close();
        };
        readers.add(emit); closers.add(stop);
        request.signal.addEventListener('abort', stop, { once: true });
        if (request.signal.aborted) stop(); else emit();
      },
      cancel() { release(false); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  } });
  ctx.effect(() => ctx.commands.register({ name: 'test', description: 'Increment the on-page counter', handler: () => {
    count += 1; fs.writeFileSync(countFile, String(count));
    for (const emit of readers) emit();
    return { kind: 'success', text: 'counter = ' + count };
  } }));
`
const counterEntry = entry.replace("['commands']", "['commands', 'connection']").replace('export function apply(ctx: any) {\n', 'export function apply(ctx: any) {\n' + counterHost)
const clientEntry = `import { useEffect, useState } from 'react'
import { revision } from './message.ts'
export const name = '${packageName}-client'
export const inject = ['slots', 'locale']
export function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register('sourceAuthoringCounter', {
    en: { counter: 'Counter {version}: {count}', unavailable: 'Counter unavailable' },
    zh: { counter: '计数器 {version}：{count}', unavailable: '无法读取计数器' },
  }))
  function Counter({ t }: { t: (key: string, values?: Record<string, string | number>) => string }) {
    const [count, setCount] = useState<number | undefined>()
    const [failed, setFailed] = useState(false)
    useEffect(() => {
      const lifetime = new AbortController()
      async function follow() {
        const response = await fetch('/api/source-authoring.counter', { signal: lifetime.signal })
        if (!response.ok || !response.body) throw new Error('Counter request failed')
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let pending = ''
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) throw new Error('Counter stream ended')
            pending += part.value
            let newline
            while ((newline = pending.indexOf('\\n')) >= 0) {
              const line = pending.slice(0, newline)
              pending = pending.slice(newline + 1)
              if (!line.startsWith('data:')) continue
              const value = JSON.parse(line.slice(5))
              if (!Number.isSafeInteger(value.count) || value.count < 0) throw new Error('Invalid counter value')
              if (!lifetime.signal.aborted) setCount(value.count)
            }
          }
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
      }
      void follow().catch(() => { if (!lifetime.signal.aborted) setFailed(true) })
      return () => lifetime.abort()
    }, [])
    return <><style data-source-counter-style>{'[data-source-counter] { display:inline-flex; align-items:center; max-width:100%; flex-wrap:wrap; font:inherit; color:inherit; }'}</style><output role="status" data-source-counter={revision}>{failed ? t('unavailable') : t('counter', { version: revision, count: count ?? '…' })}</output></>
  }
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'source-authoring-counter', locale: 'sourceAuthoringCounter', order: 5 }, Counter))
}
`
const clientManifest = version => ({ ...manifest(version), files: ['index.ts', 'message.ts', 'client.tsx'], client: { entry: 'client.tsx', inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-locale'] }, peerDependencies: { react: '18.3.1' } })
const clientPlans = { ...plans,
  install: [write('forge.json', JSON.stringify(clientManifest('1.0.0'))), write('index.ts', counterEntry), write('message.ts', helper('v1')), write('client.tsx', clientEntry), bash(buildCommand)],
  update: [read('forge.json'), read('message.ts'), write('forge.json', JSON.stringify(clientManifest('1.0.1'))), write('message.ts', helper('v2')), bash(buildCommand)],
  retained: [...plans.retained, read('client.tsx')],
  clientbroken: [read('client.tsx'), write('client.tsx', 'export function apply() { return <broken\n'), bash(buildCommand)],
  clientrepair: [read('client.tsx'), write('client.tsx', clientEntry)],
}

async function startModel(origin, plans) {
  const captured = []
  const failures = []
  const completed = new Map()
  const server = createServer((request,response) => { void (async () => {
    response.setHeader('Access-Control-Allow-Origin',origin)
    response.setHeader('Access-Control-Allow-Headers',request.headers['access-control-request-headers']??'authorization,content-type')
    response.setHeader('Vary','Origin,Access-Control-Request-Headers')
    if(request.method==='OPTIONS') {response.writeHead(204,{'Access-Control-Allow-Methods':'POST,OPTIONS'});response.end();return}
    try {
      assert.equal(request.url,'/v1/messages')
      const chunks=[]
      for await(const chunk of request) chunks.push(chunk)
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const text = value => typeof value==='string'?value:(value??[]).filter(part=>part.type==='text').map(part=>part.text).join('')
      const marker=[...body.messages].reverse().find(message=>message.role==='user' && text(message.content).includes('FORGE_AUTHORING_PHASE:'))
      const phase=/FORGE_AUTHORING_PHASE:(\w+)/.exec(text(marker?.content))?.[1]
      assert(plans[phase],`Unexpected fixture model request phase: ${phase}`)
      const results=body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='tool_result' && part.tool_use_id?.startsWith(`source-${phase}-`))
      const tools=new Set((body.tools??[]).map(tool=>tool.name))
      const stage=results.length
      console.log(`Fixture model request ${phase} step ${stage}`)
      const call=plans[phase][stage]
      if(call) assert(tools.has(call.name),`Model tool ${call.name} is unavailable; declared tools: ${[...tools]}`)
      captured.push({phase,stage,system:[text(body.system)],results:results.map(message=>({id:message.tool_use_id,text:text(message.content)}))})
      const block=call?{type:'tool_use',id:`source-${phase}-${stage}`,name:call.name,input:call.args}:{type:'text',text:`SOURCE_AUTHORING_DONE:${phase}`}
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
      const events=[
        {type:'message_start',message:{id:`source-${phase}-${stage}`,model:'forge-model',usage:{input_tokens:10,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:block},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:call?'tool_use':'end_turn'},usage:{output_tokens:10}},
        {type:'message_stop'},
      ]
      response.end(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''))
      if(!call) completed.get(phase)?.resolve()
    } catch(error) {
      failures.push(String(error))
      for(const value of completed.values())value.reject(error)
      if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'})
      response.end(JSON.stringify({error:{message:String(error)}}))
    }
  })() })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const address=server.address();assert(address&&typeof address!=='string')
  return {url:`http://127.0.0.1:${address.port}`,captured,failures,
    expect(phase) {const value=Promise.withResolvers();completed.set(phase,value);return value.promise},
    async close() {server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))},
  }
}

/** Run real Agent source tools, optional TSX UI replacement and cold restoration without a paid model call. */
export async function verifySourceAuthoring({ browser,origin,backendUrl,root,dshRoot,refreshSnapshot,clientSource = false }) {
  const scenarioPlans = clientSource ? clientPlans : plans
  const model=await startModel(origin, scenarioPlans)
  const context=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}})
  const page=await context.newPage();page.setDefaultTimeout(45000)
  const logs=[];page.on('console',message=>{if(message.type()==='error')logs.push(message.text())});page.on('pageerror',error=>logs.push(error.message))
  const builds=[]
  page.on('response',response=>{if(response.url()===`${backendUrl}/v1/builds`&&response.request().method()==='POST') builds.push(response.json().then(body=>({status:response.status(),body})))})
  const require=createRequire(resolve(dshRoot,'packages/session-query/session-log-export/package.json'))
  const {unzipSync,strFromU8}=require('fflate')
  const rpc=async(method,args)=>{
    const value=await page.evaluate(async({method,args})=>{
      const response=await window.__DSH_TRANSPORT__.fetch(`/api/${method}`,{signal:AbortSignal.timeout(45000),method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:method,method,payload:{args}})})
      return response.json()
    },{method,args})
    assert.equal(value.result?.ok,true,JSON.stringify(value));return value.result.value
  }
  const local=async(path,body)=>page.evaluate(async({path,body})=>{
    const response=await window.__DSH_TRANSPORT__.fetch(path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value
  },{path,body})
  const ready=async()=>{
    await page.getByRole('button',{name:'DSH Forge',exact:true}).waitFor()
    await page.getByRole('button',{name:'Plugins',exact:true}).waitFor()
    const welcome=page.getByRole('button',{name:'Continue',exact:true});if(await welcome.isVisible())await welcome.click()
    const setup=page.getByRole('dialog',{name:'Get started',exact:true});if(await setup.isVisible()){await setup.getByRole('button',{name:'Add API Key',exact:true}).click();await page.getByRole('button',{name:'Configure later',exact:true}).click()}
  }
  let session
  let workspaceId
  const command=line=>rpc('commands/execute',{agentId:session.sessionId,line,submittedAttachments:[]})
  const counter = page.locator('[data-source-counter]')
  const sheet = page.locator('style[data-source-counter-style]')
  const counterState = () => page.evaluate(async () => {
    const response = await fetch('/api/source-authoring.counter?inspect=1',{signal:AbortSignal.timeout(5000)})
    return {status:response.status,body:response.ok?await response.json():undefined}
  })
  const selectSession = async () => {
    const title=page.getByText('Source authoring acceptance', {exact:true}).first()
    if(!await title.isVisible()) await page.locator(`[data-row-key="workspace:${workspaceId}"]`).click()
    await title.click()
  }
  const expectCounter = async (version,count) => {
    await counter.waitFor({state:'visible'})
    await page.waitForFunction(({version,count}) => {
      const nodes = [...document.querySelectorAll('[data-source-counter]')]
      return nodes.length===1 && nodes[0].dataset.sourceCounter===version && nodes[0].textContent===`Counter ${version}: ${count}`
    }, {version,count})
    assert.equal(await sheet.count(),1)
    assert.deepEqual(await counterState(),{status:200,body:{count,readers:1}})
  }
  const exportLog=async()=>{
    const bytes=await page.evaluate(async id=>{
      const response=await window.__DSH_TRANSPORT__.fetch(`/api/session.export?sessionId=${encodeURIComponent(id)}`)
      if(!response.ok)throw new Error(`Session export ${response.status}: ${await response.text()}`)
      return [...new Uint8Array(await response.arrayBuffer())]
    },session.sessionId)
    const files=unzipSync(Uint8Array.from(bytes));const log=Object.entries(files).find(([path])=>/^session(?:\.v\d+)?\.jsonl$/.test(path));assert(log,'Session export contains the canonical log')
    return strFromU8(log[1]).trim().split('\n').map(line=>JSON.parse(line))
  }
  const runPhase=async phase=>{
    let timer
    const expectedFailure = phase==='broken'||phase==='clientbroken'
    const completed=model.expect(phase)
    void completed.catch(()=>{})
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Model/tool phase ${phase} exceeded 180 seconds`)),180000)})
    try{
      await Promise.race([rpc('session/prompt',{request:{sessionId:session.sessionId,requestId:`source-request-${phase}`,mode:'queue',content:[{type:'text',text:`FORGE_AUTHORING_PHASE:${phase}. Follow the authored tool plan.`}]}}),deadline])
      await Promise.race([completed,deadline])
      await page.waitForFunction(async id=>{
        const response=await window.__DSH_TRANSPORT__.fetch('/api/session/list',{signal:AbortSignal.timeout(45000),method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'list',method:'session/list',payload:{args:{_request:{}}}})})
        const value=await response.json();return value.result?.value?.items.some(item=>item.sessionId===id&&!item.running)
      },session.sessionId)
      const events=await exportLog()
      const calls=events.filter(event=>event.type==='tool/call'&&event.data.callId.startsWith(`source-${phase}-`))
      assert.deepEqual(calls.map(event=>event.data.name),scenarioPlans[phase].map(call=>call.name))
      const results=events.filter(event=>event.type==='tool/result'&&event.data.message.toolCallId.startsWith(`source-${phase}-`))
      assert.equal(results.length,scenarioPlans[phase].length)
      for(const [index,result] of results.entries()) if(!expectedFailure||index!==scenarioPlans[phase].length-1) assert.equal(result.data.message.isError??false,false,JSON.stringify(result.data))
      const request=model.captured.findLast(value=>value.phase===phase)
      assert.equal(request.results.length,scenarioPlans[phase].length)
      for(const [index,call] of scenarioPlans[phase].entries()) if(call.name==='bash') {
        const output=request.results[index].text
        if(expectedFailure) assert.match(output,/\[exit code: [1-9]\d*\]/)
        else {assert.doesNotMatch(output,/\[exit code: [1-9]\d*\]/);assert(output.includes(`${phase==='remove'?'Removed':'Installed'} ${packageName}`),output)}
      }
      console.log(`Real Agent tools completed source phase ${phase}: ${calls.map(event=>event.data.name).join(', ')}`)
      return {events,request,results}
    }finally{clearTimeout(timer)}
  }
  try{
    await page.goto(`${origin}/preview.html?preview-fixture=none&forge=${encodeURIComponent(backendUrl)}`);await ready()
    const documentOrigin=await page.evaluate(()=>performance.timeOrigin)
    const hostWorker=page.workers()[0]
    assert(hostWorker)
    assert.equal(await hostWorker.evaluate(()=>self.name),'dsh-host')
    await rpc('credentials/set',{ref:'FORGE_SOURCE_FIXTURE_KEY',value:'fixture-only-not-a-real-key'})
    await rpc('settings/update',{ns:'llm-deepseek',patch:{baseURL:`${model.url}/v1`,apiKeyEnv:'FORGE_SOURCE_FIXTURE_KEY',thinking:'disabled',models:[{id:'forge-model',name:'Forge fixture'}]}})
    if(clientSource) workspaceId=(await rpc('workspace/create',{request:{path:'/dsh/workspace'}})).workspace.workspaceId
    session=await rpc('session/create',{request:workspaceId===undefined?{cwd:'/dsh/workspace'}:{workspaceId}})
    await rpc('session/rename',{request:{sessionId:session.sessionId,title:'Source authoring acceptance'}})
    await rpc('session/selectModel',{request:{sessionId:session.sessionId,provider:'deepseek-official',model:'forge-model'}})
    const installed=await runPhase('install')
    assert.equal((await command('/source-proof'))?.result.text,'source v1: odd',JSON.stringify(installed.request.results))
    const firstBuild=(await Promise.all(builds))[0]
    assert.equal(firstBuild?.status,200,JSON.stringify(firstBuild))
    assert(firstBuild.body.packages.some(pkg=>pkg.name==='is-odd'&&pkg.version==='3.0.1'),'The declared npm dependency is delivered as a private package')
    const sourcePackage=firstBuild.body.packages.find(pkg=>pkg.name===packageName)
    assert(sourcePackage.files.some(file=>file.path==='index.ts')&&sourcePackage.files.some(file=>file.path==='message.ts'))
    let oldCounter
    if(clientSource) {
      assert(sourcePackage.metadata?.dsh?.client,'The built package declares its Client module')
      assert(sourcePackage.metadata.exports['./client'],'The built package exports its Client artifact')
      assert(sourcePackage.files.some(file=>'./'+file.path===sourcePackage.metadata.exports['./client']),'The exported Client artifact is delivered')
      assert(!sourcePackage.files.some(file=>file.path==='client.tsx'),'Client-only TSX is not installed as a Host module')
      assert.equal(firstBuild.body.clientPackages.react,'18.3.1','React is reused from the fixed page inventory')
      await selectSession()
      await expectCounter('v1',0)
      assert.equal((await command('/test')).result.text,'counter = 1')
      await expectCounter('v1',1)
      assert.equal((await command('/test')).result.text,'counter = 2')
      await expectCounter('v1',2)
      oldCounter=await counter.elementHandle()
      await page.screenshot({path:resolve(root,'.data/forge-client-source-v1.png')})
    }
    const system=model.captured[0].system.find(text=>text.includes('dsh plugin --profile "web" build ./greeting-source'))
    assert(system,'Real model input contains the Worker source-build guidance')
    const logged=installed.events.filter(event=>event.type==='system/message').map(event=>event.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join(''))
    assert(logged.includes(system),'Exported Session log reconstructs the exact model-visible system prompt')
    await runPhase('update');assert.equal((await command('/source-proof')).result.text,'source v2: odd')
    if(clientSource) {
      await page.waitForFunction(old=>!old.isConnected,oldCounter)
      await expectCounter('v2',2)
      assert.equal((await command('/test')).result.text,'counter = 3')
      await expectCounter('v2',3)
      await page.setViewportSize({width:390,height:844})
      await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished))})
      const geometry=await counter.evaluate(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,width:innerWidth,pageWidth:document.documentElement.scrollWidth}))
      assert(geometry.left>=0&&geometry.right<=390&&geometry.pageWidth<=390,JSON.stringify(geometry))
      await page.screenshot({path:resolve(root,'.data/forge-client-source-mobile.png')})
      await page.setViewportSize({width:1280,height:900})
      await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished))})
      await page.screenshot({path:resolve(root,'.data/forge-client-source-v2.png')})
    }
    const active=await local('/__forge/installed');const revision=active.plugins.find(plugin=>plugin.pluginId===pluginId)?.revision
    assert(revision)
    assert(active.batches.some(batch=>batch.paths.length>0),'Source updates emit file-write observations')
    if(clientSource) {
      const failedClient=await runPhase('clientbroken')
      assert.match(failedClient.request.results.at(-1).text,/error|failed|unexpected/i)
      assert.equal((await local('/__forge/installed')).plugins.find(plugin=>plugin.pluginId===pluginId)?.revision,revision)
      await expectCounter('v2',3)
      assert.equal((await command('/source-proof')).result.text,'source v2: odd')
      await runPhase('clientrepair')
    }
    const broken=await runPhase('broken')
    assert.match(broken.request.results.at(-1).text,/error|failed|unexpected/i)
    assert.equal((await local('/__forge/installed')).plugins.find(plugin=>plugin.pluginId===pluginId)?.revision,revision)
    assert.equal((await command('/source-proof')).result.text,'source v2: odd')
    if(clientSource) await expectCounter('v2',3)
    await runPhase('repair')
    assert(page.workers().includes(hostWorker),'Source updates preserve the owning Host Worker; transient shell process Workers may exit')
    assert.equal(await page.evaluate(()=>performance.timeOrigin),documentOrigin)
    assert.equal((await local('/__storage/flush',{})).kind,'saved')
    await context.route(`${backendUrl}/**`,route=>route.abort())
    await page.reload();await ready()
    assert(!page.workers().includes(hostWorker),'Reload replaces the Host Worker')
    assert.notEqual(await page.evaluate(()=>performance.timeOrigin),documentOrigin)
    assert.equal((await command('/source-proof')).result.text,'source v2: odd')
    if(clientSource) {await selectSession();await expectCounter('v2',3)}
    const retained=await runPhase('retained')
    assert(retained.request.results[0].text.includes("import isOdd from 'is-odd'"))
    assert(retained.request.results[1].text.includes('source v2:'))
    assert(retained.request.results[2].text.includes('1.0.1'))
    if(clientSource) assert(retained.request.results[3].text.includes('data-source-counter'))
    await runPhase('remove')
    assert.equal((await local('/__forge/installed')).plugins.length,0)
    assert.equal(await command('/source-proof'),undefined)
    if(clientSource) {
      await counter.waitFor({state:'detached'})
      await sheet.waitFor({state:'detached'})
      assert.equal((await counterState()).status,404,'Uninstall removes the Host stream route')
      assert.equal(await command('/test'),undefined)
    }
    assert.equal((await local('/__storage/flush',{})).kind,'saved')
    await page.reload();await ready();assert.equal((await local('/__forge/installed')).plugins.length,0)
    if(clientSource) {assert.equal(await counter.count(),0);assert.equal(await sheet.count(),0);assert.equal((await counterState()).status,404)}
    assert.deepEqual(model.failures,[])
    const observed={model:'private compatible HTTP fixture',toolPath:'session/prompt → Agent policy and tools → virtual dsh → Forge',source:{language:'TypeScript',esm:true,async:true,files:['index.ts','message.ts'],privateDependency:'is-odd@3.0.1'},command:['source v1: odd','source v2: odd'],sameDocumentAndWorkerDuringUpdates:true,fileWriteHooks:true,buildFailurePreservedActiveRevision:true,prompt:{sourceBuildCliVisible:true,reconstructedFromSessionLog:true},coldRestore:{forgeOffline:true,command:true,sourceFiles:true},modelToolRemove:true,removalSurvivesReload:true}
    if(clientSource) {
      observed.source.files.push('client.tsx')
      observed.client={language:'TSX',esm:true,sharedReact:'18.3.1',slot:'conversation.composer.dock',counter:['Counter v1: 0','Counter v1: 1','Counter v1: 2','Counter v2: 2','Counter v2: 3'],hostStream:true,hotReplaced:true,singleComponentAndSubscription:true,failedBuildPreservesUi:true,clientCompilationFailurePreservesUi:true,viewportWidth:390,horizontalOverflow:false,coldRestoreWithForgeOffline:true,removedComponentStyleAndHostRoute:true}
    }
    const text=JSON.stringify(observed,null,2)+'\n';const expected=resolve(root,`tests/expected/${clientSource?'client-source-authoring':'source-authoring'}.json`)
    if(refreshSnapshot)await writeFile(expected,text);else assert.equal(text,await readFile(expected,'utf8'))
    await page.screenshot({path:resolve(root,clientSource?'.data/forge-client-source-removed.png':'.data/forge-source-authoring.png')})
    console.log(text)
  }catch(error){await page.screenshot({path:resolve(root,clientSource?'.data/forge-client-source-failure.png':'.data/forge-source-authoring-failure.png')}).catch(()=>{});console.error(logs.join('\n'));throw error}
  finally{await context.close();await model.close()}
}
