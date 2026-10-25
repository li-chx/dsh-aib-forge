/** Preserve the supported published DSH bundle and prebuilt Client entry. */
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { parseDocument } from 'yaml'
import { exports as resolveExports } from 'resolve.exports'
import { z } from 'zod'
import { ForgeError, packageName, relativePath } from './protocol.js'
import type { PackageMetadata } from './protocol.js'
import { applyClientCompatibility } from './client-compatibility.js'

const dshSchema = z.object({
  bundle: z.object({ patch: z.string() }).strict().optional(),
  client: z.object({ inject: z.array(packageName).default([]), platform: z.literal('web') }).strict().optional(),
}).strict()
/** Preserved files and the safe metadata that names them. */
export interface PublishedAssets { metadata: PackageMetadata; assets: Record<string, Uint8Array> }
/** Read only declared supported assets inside the installed package directory. */
export async function readPublishedAssets(directory: string, name: string, raw: Record<string, unknown>): Promise<PublishedAssets | undefined> {
  if (raw.dsh === undefined && raw.repository === undefined) return undefined
  const dsh = dshSchema.safeParse(raw.dsh ?? {})
  if (!dsh.success) throw new ForgeError('BUNDLE_UNSUPPORTED', `Unsupported dsh metadata for ${name}: ${dsh.error.message}`)
  const assets: Record<string, Uint8Array> = {}
  const exports: Record<string, string> = { '.': './index.js', './package.json': './package.json' }
  const metadata: PackageMetadata = { ...raw.dsh === undefined ? {} : { dsh: { ...dsh.data.bundle === undefined ? {} : { bundle: dsh.data.bundle }, ...dsh.data.client === undefined ? {} : { client: dsh.data.client } } }, exports }
  if (raw.repository !== undefined) {
    const repository = z.union([z.string().min(1), z.object({ url: z.string().min(1) })]).safeParse(raw.repository)
    if (!repository.success) throw new ForgeError('BUNDLE_UNSUPPORTED', `Invalid repository metadata for ${name}`)
    metadata.repository = repository.data
  }
  const load = async (value: string): Promise<{ path: string; bytes: Uint8Array }> => {
    const path = value.replace(/^\.\//, '')
    if (!relativePath.safeParse(path).success || path === 'package.json' || path === 'index.js') throw new ForgeError('BUNDLE_UNSUPPORTED', `Unsafe or reserved asset path ${value}`)
    let actual: string
    try { actual = await realpath(resolve(directory, path)) }
    catch (error) { throw new ForgeError('BUNDLE_ASSET_MISSING', `Cannot read published asset ${value}: ${error instanceof Error && 'code' in error ? String(error.code) : 'filesystem error'}`) }
    const offset = relative(directory, actual)
    if (offset.startsWith('..') || isAbsolute(offset)) throw new ForgeError('SOURCE_PATH_ESCAPE', `Asset ${value} escapes its package`)
    return { path, bytes: await readFile(actual) }
  }
  if (dsh.data.bundle) {
    const asset = await load(dsh.data.bundle.patch)
    const patch = parseDocument(new TextDecoder().decode(asset.bytes))
    const simple = z.array(z.object({ insert: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), name: z.literal(name) }).strict()).length(1) }).strict()).length(1)
    if (patch.errors.length || patch.warnings.length || !simple.safeParse(patch.toJSON()).success) throw new ForgeError('BUNDLE_UNSUPPORTED', `${name} must expose a single insert row naming its own package`)
    assets[asset.path] = asset.bytes
    metadata.dsh!.bundle = { patch: `./${asset.path}` }
    exports[`./${asset.path}`] = `./${asset.path}`
  }
  if (dsh.data.client) {
    let entry: string | undefined
    try { entry = resolveExports({ name, exports: raw.exports }, './client', { browser: true })?.[0] }
    catch (error) { throw new ForgeError('BUNDLE_UNSUPPORTED', `${name} has no compatible ./client export: ${error instanceof Error ? error.message : String(error)}`) }
    if (entry === undefined || !entry.startsWith('./')) throw new ForgeError('BUNDLE_UNSUPPORTED', `${name} needs a package-relative ./client export for browser/import/default conditions`)
    const asset = await load(entry)
    assets[asset.path] = applyClientCompatibility(name, raw.version, asset.bytes)
    exports['./client'] = `./${asset.path}`
  }
  return { metadata, assets }
}
