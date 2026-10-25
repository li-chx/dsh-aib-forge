/** Preserve the supported published DSH bundle and prebuilt Client entry. */
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import { exports as resolveExports } from 'resolve.exports'
import { z } from 'zod'
import { ForgeError, packageName, relativePath } from './protocol.js'
import type { PackageMetadata } from './protocol.js'
import { applyClientCompatibility } from './client-compatibility.js'

// Unknown descriptive fields are stripped; only declarations consumed by this compiler are retained.
// Known Client loading controls must fail rather than silently losing their runtime semantics.
const unsupportedClientControl = z.never({ error: 'Unsupported Client loading field; Forge cannot preserve this behavior' }).optional()
const dshSchema = z.object({
  bundle: z.object({ patch: z.string() }).optional(),
  client: z.object({
    inject: z.array(packageName).default([]), platform: z.literal('web'),
    external: unsupportedClientControl, immediately: unsupportedClientControl,
  }).optional(),
})
const issueDetails = (error: z.ZodError): string => error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
/** Preserved files and the safe metadata that names them. */
export interface PublishedAssets { metadata: PackageMetadata; assets: Record<string, Uint8Array> }
/** Read only declared supported assets inside the installed package directory. */
export async function readPublishedAssets(directory: string, name: string, raw: Record<string, unknown>): Promise<PublishedAssets | undefined> {
  if (raw.dsh === undefined && raw.repository === undefined) return undefined
  const dsh = dshSchema.safeParse(raw.dsh === undefined ? {} : raw.dsh)
  if (!dsh.success) throw new ForgeError('BUNDLE_UNSUPPORTED', `Unsupported dsh metadata for ${name}: ${issueDetails(dsh.error)}`)
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
    const subject = `${name} bundle ${asset.path}`
    const diagnostics = [...patch.errors, ...patch.warnings]
    if (diagnostics.length) throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: invalid YAML: ${diagnostics.map(issue => issue.message).join('; ')}`)
    visit(patch, (_key, node) => {
      if (isAlias(node)) throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: YAML aliases are unsupported; use literal configuration values`)
      if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag !== undefined && !/^tag:yaml\.org,2002:(?:null|bool|int|float|str|map|seq)$/.test(node.tag)) {
        throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: unsupported YAML tag ${node.tag}`)
      }
      if (isMap(node) && node.items.some(item => !isScalar(item.key) || typeof item.key.value !== 'string')) {
        throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: object keys must be strings`)
      }
      if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) {
        throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: configuration numbers must be finite (YAML offset ${node.range?.[0] ?? 0})`)
      }
    })
    const entry = z.object({
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), name: z.literal(name),
      config: z.json().optional(),
    }).strict()
    const simple = z.array(z.object({ insert: z.array(entry).length(1) }).strict()).length(1)
    const result = simple.safeParse(patch.toJSON())
    if (!result.success) throw new ForgeError('BUNDLE_UNSUPPORTED', `${subject}: expected one insert row for its own package with only id/name and optional JSON literal config; ${issueDetails(result.error)}`)
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
