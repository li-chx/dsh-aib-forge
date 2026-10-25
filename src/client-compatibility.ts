/** Version-scoped repairs for published Client bundles with known runtime defects. */
import { ForgeError } from './protocol.js'

const HUB_VERSION_COMPARISON = 'if (plugin.version) return compareVersions(plugin.version, rec.version) > 0;'
const HUB_PENDING_VERSION = 'if (plugin.version) return typeof rec.version === "string" && rec.version.length > 0 && compareVersions(plugin.version, rec.version) > 0;'

function replaceExpected(source: string, needle: string | RegExp, count: number, replacement: string): string {
  const matches = typeof needle === 'string' ? source.split(needle).length - 1 : source.match(needle)?.length ?? 0
  if (matches !== count) throw new ForgeError('CLIENT_COMPATIBILITY_MISMATCH', 'dsh-plugin@2.2.1 Client bundle does not match its Worker compatibility patches')
  return typeof needle === 'string' ? source.replaceAll(needle, replacement) : source.replace(needle, replacement)
}

/**
 * Repair Hub 2.2.1's partial version records and automatic reload after successful Worker HMR.
 * Explicit restart and failed-request retry actions remain intact. Other publications are untouched.
 * @param name Published package name.
 * @param version Published manifest version.
 * @param bytes Original Client bundle.
 * @returns Bundle bytes with version-specific repairs, or the original bytes.
 * @throws When the known publication no longer contains the expected repair sites.
 */
export function applyClientCompatibility(name: string, version: unknown, bytes: Uint8Array): Uint8Array {
  if (name !== 'dsh-plugin' || version !== '2.2.1') return bytes
  let source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!source.includes('function hasUpdateOf(plugin, installed, versions)')) {
    throw new ForgeError('CLIENT_COMPATIBILITY_MISMATCH', 'dsh-plugin@2.2.1 Client bundle does not match its Worker compatibility patches')
  }
  source = replaceExpected(source, HUB_VERSION_COMPARISON, 1,
    '/* Forge: an npm-package mapping may precede its installed version. */\n' + HUB_PENDING_VERSION)
  source = replaceExpected(source, /const scheduleAutoReload = \(\) => \{\s*window\.setTimeout\(\(\) => window\.location\.reload\(\), 1600\);\s*\};/g, 1, '')
  source = replaceExpected(source, 'if (!viaModal && reload) scheduleAutoReload();', 2,
    '/* Forge completed the Worker and Client update without document navigation. */')
  source = replaceExpected(source, 'if (reload) window.location.reload();', 4,
    '/* Closing a successful Worker operation keeps its in-memory state. */')
  for (const [before, after] of [
    ['reloadHint: "插件已加载，关闭本窗口后会自动刷新页面生效。"', 'reloadHint: "插件变更已热加载生效，无需刷新页面。"'],
    ['reloadHint: "The plugin is loaded — closing this window will refresh the page automatically."', 'reloadHint: "Plugin changes are active through hot loading. No page refresh is needed."'],
    ['toastInstalledReload: "安装成功，正在自动刷新页面…"', 'toastInstalledReload: "安装成功，已热加载生效"'],
    ['toastInstalledReload: "Installed — refreshing the page automatically…"', 'toastInstalledReload: "Installed — active through hot loading"'],
  ]) source = replaceExpected(source, before!, 1, after!)
  return new TextEncoder().encode(source)
}
