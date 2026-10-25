/** Prepare a credential-free static Worker preview and its matching Forge target. */
import { resolveDshRoot } from './dsh-path.mjs'
import { imageTarget } from './image-target.mjs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const forgeRoot = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { 'dsh-root': { type: 'string' }, 'out-dir': { type: 'string' } } })
const dshRoot = resolveDshRoot(values['dsh-root'])
const runtimePath = resolve(dshRoot, 'packages/experimental/webworker-runtime/lib')
const { packRepositoryImage } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-packer/lib/index.js')).href)
const { FORGE_GENERATION, IMAGE_FILE_NAME, forgeSharedPackages } = await import(pathToFileURL(resolve(runtimePath, 'index.js')).href)
const packed = packRepositoryImage(dshRoot, 'web')
if (packed.missing.length) throw new Error(`Incomplete image: ${packed.missing.join(', ')}`)
const target = imageTarget(packed, FORGE_GENERATION, forgeSharedPackages)
const previewRoot = resolve(values['out-dir'] ?? resolve(forgeRoot, '.data/preview'))
const site = resolve(previewRoot, 'site')
await rm(previewRoot, { recursive: true, force: true })
await mkdir(previewRoot, { recursive: true })
await cp(resolve(dshRoot, 'apps/web/dist'), site, { recursive: true })
const preview = resolve(site, 'preview')
await mkdir(preview, { recursive: true })
await writeFile(resolve(preview, IMAGE_FILE_NAME), packed.image)
for (const archive of packed.lazyArchives) {
  const output = resolve(preview, archive.name)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, archive.image)
}
await writeFile(resolve(preview, 'fixtures.json'), JSON.stringify({ version: 1, defaultFixture: null, fixtures: [] }) + '\n')
await writeFile(resolve(previewRoot, 'target.json'), JSON.stringify(target, null, 2) + '\n')
console.log(JSON.stringify({ site, target: resolve(previewRoot, 'target.json'), generation: FORGE_GENERATION,
  hostPackages: Object.keys(target.hostPackages).length, imageBytes: packed.image.length }, null, 2))
