import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPublishedAssets } from '../src/package-assets.js'
import { ForgeError } from '../src/protocol.js'

const bundle = { bundle: { patch: './cordis.patch.yml' } }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'forge-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'client.js'), 'export {}')
  return root
}
function unsupported(message: RegExp) {
  return (error: unknown): boolean => {
    assert(error instanceof ForgeError)
    assert.equal(error.code, 'BUNDLE_UNSUPPORTED')
    assert.match(error.message, message)
    return true
  }
}

test('unconsumed package metadata is stripped without treating advisory compatibility as verified', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n  - { id: sample, name: sample }\n')
  const result = await readPublishedAssets(root, 'sample', {
    dsh: {
      compatibility: { dsh: '>=99.0.0', dshReleases: { '99.0.0': 'advisory-only' } },
      manifestVersion: 1, arbitraryExtension: { nested: true },
      bundle: { patch: './cordis.patch.yml', title: 'Example', compatibility: {} },
      client: { platform: 'web', description: 'Example', futureDecoration: ['value'] },
    },
    exports: { './client': './client.js' },
  })
  assert.deepEqual(result?.metadata.dsh, { bundle: { patch: './cordis.patch.yml' }, client: { inject: [], platform: 'web' } })
  assert.deepEqual((await readPublishedAssets(root, 'sample', { dsh: { futureDecoration: true } }))?.metadata.dsh, {})
})

test('metadata sanitization still validates consumed types and rejects unsupported Client loading controls', async t => {
  const root = await fixture(t)
  for (const dsh of [null, [], { bundle: {} }, { bundle: { patch: 2 } }, { client: { platform: 'desktop' } }, { client: { platform: 'web', inject: [3] } }]) {
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh }), unsupported(/metadata/))
  }
  for (const [field, value] of [['external', []], ['external', ['sample/client']], ['immediately', false], ['immediately', true]]) {
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh: { client: { platform: 'web', [String(field)]: value } } }), unsupported(new RegExp(`client\\.${String(field)}.*Unsupported Client loading field`)))
  }
})

test('single-package bundle preserves nested literal config and the original YAML bytes', async t => {
  const root = await fixture(t)
  const patch = '# package defaults\n- insert:\n    - id: sample\n      name: sample\n      config:\n        enabled: true\n        count: 0\n        ratio: 1.25\n        label: "sample"\n        empty: null\n        track:\n          scan: ["a", 2, false, null, { depth: 3 }]\n        webOverlay: false\n        clientTarget: auto\n'
  await writeFile(join(root, 'cordis.patch.yml'), patch)
  const result = await readPublishedAssets(root, 'sample', { dsh: bundle })
  assert.equal(new TextDecoder().decode(result?.assets['cordis.patch.yml']), patch)
  assert.deepEqual(result?.metadata.dsh, bundle)
})

test('bundle rejects executable rows, nonfinite values and unsupported state fields with precise diagnostics', async t => {
  const root = await fixture(t)
  for (const [extra, diagnostic] of [
    ['config: { nested: { value: .nan } }', /configuration numbers must be finite/],
    ['config: { value: .inf }', /configuration numbers must be finite/],
    ['disabled: false', /disabled/],
    ['disabled: true', /disabled/],
    ['disabled: null', /disabled/],
    ['isolate: { service: value }', /isolate/],
  ] as const) {
    await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n  - id: sample\n    name: sample\n    ${extra}\n`)
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(diagnostic))
  }
  for (const patch of [
    '- insert: [{id: sample, name: another}]',
    '- insert: [{id: sample, name: sample}, {id: other, name: sample}]',
    '- insert: [{id: sample, name: sample}]\n- insert: [{id: other, name: sample}]',
    '- insert: [{id: sample, name: sample}]\n  remove: [other]',
  ]) {
    await writeFile(join(root, 'cordis.patch.yml'), patch)
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(/sample bundle cordis.patch.yml/))
  }
})

test('bundle rejects YAML execution tags, non-JSON tags, aliases and malformed documents', async t => {
  const root = await fixture(t)
  for (const [value, diagnostic] of [
    ['!!js "() => 1"', /invalid YAML.*Unresolved tag/s],
    ['!js "() => 1"', /invalid YAML.*Unresolved tag/s],
    ['!!timestamp 2026-10-25', /invalid YAML|unsupported YAML tag/],
    ['!!set {a: null}', /invalid YAML|unsupported YAML tag/],
    ['{ 3: value }', /object keys must be strings/],
    ['&loop { self: *loop }', /YAML aliases are unsupported/],
    ['{ first: &value 1, second: *value }', /YAML aliases are unsupported/],
    ['{ first: 1, first: 2 }', /invalid YAML/],
  ] as const) {
    await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n  - id: sample\n    name: sample\n    config: { value: ${value} }\n`)
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(diagnostic))
  }
})

test('bundle accepts root arrays, scalars, null and standard JSON-compatible YAML tags', async t => {
  const root = await fixture(t)
  for (const value of ['[]', '[1, "two", { nested: false }]', 'null', '42', 'true', '"text"', '!!str 1', '!!map {value: !!int 1}', '!!seq [!!null null, !!bool true, !!float 1.2]']) {
    const patch = `- insert:\n  - id: sample\n    name: sample\n    config: ${value}\n`
    await writeFile(join(root, 'cordis.patch.yml'), patch)
    const result = await readPublishedAssets(root, 'sample', { dsh: bundle })
    assert.equal(new TextDecoder().decode(result?.assets['cordis.patch.yml']), patch)
  }
})


test('literal overrides may surround one self insertion without rewriting the published patch', async t => {
  const root = await fixture(t)
  for (const disabled of ['true', 'false', 'null']) {
    const patch = `# replace the default strategy\n- id: compaction-basic\n  disabled: ${disabled}\n  config: { nested: [1, false, null] }\n- insert:\n  - id: compaction-custom\n    name: sample\n    config: ["one", 2]\n- id: existing-other\n  config: null\n`
    await writeFile(join(root, 'cordis.patch.yml'), patch)
    const result = await readPublishedAssets(root, 'sample', { dsh: bundle })
    assert.equal(new TextDecoder().decode(result?.assets['cordis.patch.yml']), patch)
  }
})

test('override admission rejects topology changes, ambiguous identities and invalid literal fields', async t => {
  const root = await fixture(t)
  const insertion = '- insert: [{id: self, name: sample}]\n'
  for (const [rows, diagnostic] of [
    ['- {id: existing}', /Override requires config or disabled/],
    ['- {id: existing, disabled: "true"}', /disabled/],
    ['- {id: existing, name: another, disabled: true}', /name/],
    ['- {id: existing, group: new, config: {}}', /group/],
    ['- {id: existing, remove: [other], config: {}}', /remove/],
    ['- {id: existing, disabled: true}\n- {id: existing, config: {}}', /duplicate override id existing/],
    ['- {id: self, disabled: true}', /override cannot target its own inserted id self/],
    ['- {id: "invalid/id", disabled: true}', /id/],
    ['- {id: existing, config: !!js "process.exit()"}', /invalid YAML/],
    ['- {id: existing, config: .inf}', /finite/],
    ['- {id: existing, config: {3: bad}}', /keys must be strings/],
    ['- {id: existing, config: {a: &v 1, b: *v}}', /aliases/],
  ] as const) {
    await writeFile(join(root, 'cordis.patch.yml'), insertion + rows + '\n')
    await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(diagnostic))
  }
  await writeFile(join(root, 'cordis.patch.yml'), '- {id: existing, disabled: true}\n')
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(/exactly one self-package insert row is required/))
  await writeFile(join(root, 'cordis.patch.yml'), '- {id: self, config: {}}\n' + insertion)
  await assert.rejects(readPublishedAssets(root, 'sample', { dsh: bundle }), unsupported(/override cannot target its own inserted id self/))
})
