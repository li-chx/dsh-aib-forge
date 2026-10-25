/** Copy non-module npm resources without changing their package-relative locations. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { packageExports } from './package-exports.js'
import { ForgeError } from './protocol.js'

/** Per-package limits include declared bundle patches and Client bundles. */
export interface ResourceLimits { maxResourceFiles: number; maxResourceBytes: number }
/** Resolve server-owned resource limits before reading package contents. */
export function resolveResourceLimits(options: Partial<ResourceLimits>): ResourceLimits {
  const limits = { maxResourceFiles: options.maxResourceFiles ?? 1000, maxResourceBytes: options.maxResourceBytes ?? 32 * 1024 * 1024 }
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return limits
}
/** Match the Worker's supported resource-path segments before returning a manifest. */
export function validateResourcePath(path: string): void {
  if (!path.split('/').every(part => part !== '.' && part !== '..' && /^[a-zA-Z0-9_@.+-]+$/.test(part))) {
    throw new ForgeError('RESOURCE_PATH_UNSUPPORTED', `Unsupported package resource path ${path}; use relative ASCII path segments`)
  }
}
/** Enforce aggregate bounds before loading another resource. */
export function checkResourceBudget(files: number, bytes: number, limits: ResourceLimits): void {
  if (files > limits.maxResourceFiles || bytes > limits.maxResourceBytes) {
    throw new ForgeError('RESOURCE_LIMIT_EXCEEDED', `Package resources exceed ${limits.maxResourceFiles} files or ${limits.maxResourceBytes} bytes (observed ${files} files, ${bytes} bytes)`)
  }
}
/** Published Host modules and ordinary resources share one server-owned aggregate budget. */
export interface PackageFiles { modules: Record<string, Uint8Array>; assets: Record<string, Uint8Array> }
/** Read all runtime modules without following symlinks or entering dependency installations. */
export async function collectPackageFiles(directory: string, declared: Record<string, Uint8Array>, limits: ResourceLimits): Promise<PackageFiles> {
  const assets = { ...declared }
  const modules: Record<string, Uint8Array> = {}
  let count = Object.keys(assets).length
  let bytes = Object.values(assets).reduce((sum, value) => sum + value.byteLength, 0)
  checkResourceBudget(count, bytes, limits)
  const walk = async (parent: string): Promise<void> => {
    for (const entry of (await readdir(join(directory, parent), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue
      const path = parent ? `${parent}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new ForgeError('RESOURCE_SYMLINK_UNSUPPORTED', `Package file ${path} is a symbolic link`)
      if (entry.isDirectory()) { validateResourcePath(path); await walk(path); continue }
      if (!entry.isFile()) throw new ForgeError('RESOURCE_TYPE_UNSUPPORTED', `Package file ${path} is not a regular file`)
      if (path === 'package.json' || Object.hasOwn(assets, path) || /(?:\.d\.[cm]?tsx?|\.(?:map|node))$/i.test(path)) continue
      validateResourcePath(path)
      const filename = join(directory, path)
      checkResourceBudget(count + 1, bytes + (await stat(filename)).size, limits)
      const data = new Uint8Array(await readFile(filename))
      checkResourceBudget(count + 1, bytes + data.byteLength, limits)
      if (entry.name === 'package.json') validateNestedPackageManifest(path, data)
      if (/\.[cm]?[jt]sx?$/i.test(path)) modules[path] = data
      else assets[path] = data
      count++; bytes += data.byteLength
    }
  }
  await walk('')
  return { modules, assets }
}


/** Validate nested resolver metadata without allowing main or export targets to escape the owning package. */
export function validateNestedPackageManifest(path: string, data: Uint8Array): void {
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder().decode(data)) } catch { throw new ForgeError('PACKAGE_INVALID', `Invalid nested manifest ${path}`) }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ForgeError('PACKAGE_INVALID', `Invalid nested manifest ${path}`)
  const main = Reflect.get(manifest, 'main')
  if (main !== undefined) {
    if (typeof main !== 'string' || isAbsolute(main) || main.includes('\\')) throw new ForgeError('SOURCE_PATH_ESCAPE', `Unsafe main in ${path}`)
    const offset = relative('/package', resolve('/package', dirname(path), main))
    if (offset.startsWith('..') || isAbsolute(offset) || offset.split('/').includes('node_modules')) throw new ForgeError('SOURCE_PATH_ESCAPE', `Unsafe main in ${path}`)
  }
  const exported = Reflect.get(manifest, 'exports')
  if (exported !== undefined) packageExports(exported, path)
}
