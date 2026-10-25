/** Packaged research resources must remain readable across install, update and removal. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/** Inspect real skills and tools through public services without a model request or path override. */
export async function verifyIndustryPlugin({ page, hub, waitTask, rpc, session }) {
  const packageName = 'dsh-industry-research'
  const names = ['company-research-method', 'industry-research-method']
  const tools = ['company_scan', 'industry_map', 'industry_report', 'industry_track']
  const inspect = async () => {
    const result = await rpc('commands/execute', { agentId: session.sessionId, line: '/forge-hub-industry', submittedAttachments: [] })
    assert.equal(result?.result.kind, 'success', JSON.stringify(result))
    return JSON.parse(result.result.text)
  }
  const catalog = async () => (await rpc('skills/list', { request: { sessionId: session.sessionId } })).skills.filter(skill => names.includes(skill.name))
  const before = await inspect()
  assert.deepEqual(before.skills, [])
  assert.deepEqual(before.tools, [])
  assert.deepEqual(await catalog(), [])
  let first
  for (const mode of ['install', 'update', 'update']) {
    const created = await hub('/install', { repo: packageName, source: 'custom', installChannel: 'npm', lang: 'en', version: '0.3.23', mode })
    assert.equal(created.ok, true, JSON.stringify(created))
    const task = await waitTask(created.task)
    assert.equal(task.status, 'done', JSON.stringify(task))
    assert.equal(task.exitCode, 0, JSON.stringify(task))
    const installed = await hub('/installed')
    assert.equal(installed.installed[packageName], '0.3.23')
    assert(installed.loaded.includes(packageName), JSON.stringify(installed))
    const forge = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
    assert.equal(forge.plugins.find(plugin => plugin.name === packageName)?.status, 'active', JSON.stringify(forge))
    const entries = (await hub('/debug/loader-entries')).entries.filter(entry => entry.name === packageName)
    assert.equal(entries.length, 1, JSON.stringify(entries))
    const state = await inspect()
    assert.deepEqual(state.skills.map(skill => skill.name).sort(), names)
    assert.deepEqual(state.tools, tools)
    for (const skill of state.skills) {
      assert.equal(skill.provider, 'industry-research')
      assert(skill.path.endsWith(`/skills/${skill.name}/SKILL.md`), skill.path)
      assert.match(skill.content, skill.name === names[0] ? /# 公司研究方法论/ : /# 行业研究方法论/)
      assert(skill.content.length > 1000)
    }
    assert.match(state.skills.find(skill => skill.name === names[1]).reference, /# 行业研究框架参考/)
    assert.equal(state.resources.length, 3)
    assert(state.resources.every(resource => resource.exists), JSON.stringify(state.resources))
    assert.deepEqual((await catalog()).map(skill => skill.name).sort(), names)
    if (first) assert.deepEqual(state, first, 'Repeated update changed the skill provider view or resource content')
    else first = state
    console.log(`Industry ${mode}: two readable skills, relative reference and four tools; one Loader entry`)
  }
  const removing = await hub('/uninstall', { name: packageName })
  const removedTask = await waitTask(removing.task)
  assert.equal(removedTask.status, 'done', JSON.stringify(removedTask))
  const after = await inspect()
  assert.deepEqual(after.skills, [])
  assert.deepEqual(after.tools, [])
  assert.deepEqual(await catalog(), [])
  assert.equal(after.resources.length, 3)
  assert(after.resources.every(resource => !resource.exists), JSON.stringify(after.resources))
  assert.equal((await hub('/debug/loader-entries')).entries.filter(entry => entry.name === packageName).length, 0)
  const forgeAfter = await page.evaluate(async () => (await window.__DSH_TRANSPORT__.fetch('/__forge/installed')).json())
  assert(!forgeAfter.plugins.some(plugin => plugin.name === packageName))
  console.log('Industry removal cleared skills, tools, Loader entry and resource files')
  return {
    package: `${packageName}@0.3.23`, status: 'active',
    skills: first.skills.sort((a, b) => a.name.localeCompare(b.name)).map(skill => ({ name: skill.name, provider: skill.provider, bodySha256: createHash('sha256').update(skill.content).digest('hex') })),
    relativeReferenceReadable: true, tools, remoteCatalogVisible: true,
    repeatedUpdates: 2, singleLoaderEntry: true, configurationPathOverride: false,
    removedSkills: true, removedTools: true, removedResourceFiles: true,
  }
}
