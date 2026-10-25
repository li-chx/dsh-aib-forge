/** Preserve package export conditions without allowing targets outside the package. */
import { ForgeError } from './protocol.js'
import type { PackageExports } from './protocol.js'

/** Validate recursive export declarations; resolution and absent conditional files belong to the Worker. */
export function packageExports(value: unknown, subject: string, allowSubpaths = true): PackageExports {
  if (value === null) return null
  if (typeof value === 'string') {
    const path = value.startsWith('./') ? value.slice(2) : ''
    if (!path || !path.split('/').every(part => part !== '.' && part !== '..' && part !== 'node_modules' && /^[a-zA-Z0-9_@.+*-]+$/.test(part))) throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} export target must be a safe package-relative path: ${value}`)
    return value
  }
  if (Array.isArray(value)) return value.map(item => packageExports(item, subject, false))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const subpaths = entries.some(([key]) => key.startsWith('.'))
    if (subpaths && !allowSubpaths) throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} has a nested subpath map`)
    for (const [key] of entries) {
      if (subpaths) {
        if (key !== '.') packageExports(key, subject)
        if ((key.match(/\*/g)?.length ?? 0) > 1) throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} subpath keys support at most one wildcard`)
        if (!key.startsWith('.')) throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} mixes subpaths and conditions`)
      } else if (!key || /^\d+$/.test(key)) throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} has an unsupported export condition ${key}`)
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, packageExports(item, subject, false)]))
  }
  throw new ForgeError('PACKAGE_EXPORTS_UNSUPPORTED', `${subject} exports must contain paths, conditions, arrays, or null`)
}

/** Add explicit DSH asset subpaths while retaining the published root conditions. */
export function exportSubpaths(value: PackageExports | undefined, entry: string): Record<string, PackageExports> {
  if (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).some(key => key.startsWith('.'))) return { ...value }
  return { '.': value === undefined ? './' + entry : value }
}
