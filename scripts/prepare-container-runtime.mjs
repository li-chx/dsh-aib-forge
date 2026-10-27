/** Build the fixed target and standalone compiler from the selected frontend checkout. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { resolveDshRoot } from './dsh-path.mjs'
import { imageTarget } from './image-target.mjs'

const { values } = parseArgs({ options: { 'dsh-root': { type: 'string' }, 'out-dir': { type: 'string' } } })
const dshRoot = resolveDshRoot(values['dsh-root'])
if (!values['out-dir']) throw new Error('--out-dir is required')
const output = resolve(values['out-dir'])
const runtimeRoot = resolve(dshRoot, 'packages/experimental/webworker-runtime')
const { packRepositoryImage } = await import(pathToFileURL(resolve(dshRoot, 'packages/experimental/webworker-packer/lib/index.js')).href)
const { FORGE_GENERATION, forgeSharedPackages } = await import(pathToFileURL(resolve(runtimeRoot, 'lib/index.js')).href)
const packed = packRepositoryImage(dshRoot, 'web')
if (packed.missing.length) throw new Error(`Incomplete frontend image: ${packed.missing.join(', ')}`)
const target = imageTarget(packed, FORGE_GENERATION, forgeSharedPackages)

await mkdir(output, { recursive: true })
await build({
  stdin: {
    contents: 'export { lowerModuleSource } from "./compile/transform.ts";\nexport { MODULE_PROXIES } from "./module-proxies.ts";',
    resolveDir: resolve(runtimeRoot, 'src'), sourcefile: 'forge-transformer.ts', loader: 'ts',
  },
  outfile: resolve(output, 'transformer.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
})
await writeFile(resolve(output, 'target.json'), JSON.stringify(target, null, 2) + '\n')
await copyFile(resolve(dshRoot, 'LICENSE'), resolve(output, 'LICENSE.DeepSeek'))
const requireRuntime = createRequire(resolve(runtimeRoot, 'package.json'))
await copyFile(resolve(requireRuntime.resolve('acorn/package.json'), '../LICENSE'), resolve(output, 'LICENSE.acorn'))
console.log(JSON.stringify({ output, generation: target.generation, hostPackages: Object.keys(target.hostPackages).length }))
