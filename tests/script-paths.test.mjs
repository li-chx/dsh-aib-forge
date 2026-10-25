import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshRoot } from '../scripts/dsh-path.mjs'
import { imageTarget } from '../scripts/image-target.mjs'

const bytes = value => new TextEncoder().encode(JSON.stringify(value))
const packed = {
  files: {
    'node_modules/@deepseek-ai/cordis/package.json': bytes({ name: '@deepseek-ai/cordis', version: '4.0.5' }),
    'node_modules/@deepseek-ai/dsh-client-web/package.json': bytes({ name: '@deepseek-ai/dsh-client-web', version: '0.2.1-rc.2' }),
    'node_modules/outer/node_modules/inner/package.json': bytes({ name: 'inner', version: '1.0.0' }),
    'config/vfs-manifest.json': bytes({ clientPackages: { react: '18.3.1' } }),
  },
}

test('DSH checkout selection requires an explicit existing path and resolves symlinks', async t => {
  assert.throws(() => resolveDshRoot(''), /--dsh-root/)
  const root = await mkdtemp(join(tmpdir(), 'forge-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.throws(() => resolveDshRoot(join(root, 'missing')), { code: 'ENOENT' })
  await symlink(root, join(root, 'alias'))
  assert.equal(resolveDshRoot(join(root, 'alias')), root)
})

test('preview target uses selected image versions and runtime generation without transitive package entries', () => {
  assert.deepEqual(imageTarget(packed, 'dsh-worker-rc2-1'), {
    protocol: 1, generation: 'dsh-worker-rc2-1',
    hostPackages: { '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/dsh-client-web': '0.2.1-rc.2' },
    clientPackages: { react: '18.3.1' },
  })
})

test('incomplete migration artifacts fail target derivation before preview replacement', () => {
  assert.throws(() => imageTarget(packed, undefined), /Forge support/)
  assert.throws(() => imageTarget({ files: {} }, 'dsh-worker-rc2-1'), /No base-image/)
  assert.throws(() => imageTarget({ files: { ...packed.files, 'config/vfs-manifest.json': bytes({}) } }, 'dsh-worker-rc2-1'), /Client package roster/)
})
