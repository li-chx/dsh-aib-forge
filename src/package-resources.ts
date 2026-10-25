/** Copy non-module npm resources without changing their package-relative locations. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
/** Retain ordinary published files and explicitly selected Client code; never follow package symlinks. */
export async function collectPackageResources(directory: string, reserved: ReadonlySet<string>, declared: Record<string, Uint8Array>, limits: ResourceLimits): Promise<Record<string, Uint8Array>> {
  const assets = { ...declared }
  let count = Object.keys(assets).length
  let bytes = Object.values(assets).reduce((sum, value) => sum + value.byteLength, 0)
  checkResourceBudget(count, bytes, limits)
  for (const path of Object.keys(assets)) validateResourcePath(path)
  const walk = async (parent: string): Promise<void> => {
    const entries = await readdir(join(directory, parent), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules') continue
      const path = parent ? `${parent}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new ForgeError('RESOURCE_SYMLINK_UNSUPPORTED', `Package resource ${path} is a symbolic link`)
      if (entry.isDirectory()) { validateResourcePath(path); await walk(path); continue }
      if (!entry.isFile()) throw new ForgeError('RESOURCE_TYPE_UNSUPPORTED', `Package resource ${path} is not a regular file`)
      if (path === 'package.json' || reserved.has(path) || Object.hasOwn(assets, path)) continue
      // Host JS/TS belongs to the compiler; source maps and native addons are not runtime resources.
      if (/(?:\.[cm]?[jt]sx?|\.(?:map|node))$/i.test(path)) continue
      validateResourcePath(path)
      const filename = join(directory, path)
      const size = (await stat(filename)).size
      checkResourceBudget(count + 1, bytes + size, limits)
      const data = new Uint8Array(await readFile(filename))
      checkResourceBudget(count + 1, bytes + data.byteLength, limits)
      assets[path] = data
      count++; bytes += data.byteLength
    }
  }
  await walk('')
  return assets
}
