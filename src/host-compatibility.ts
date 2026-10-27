/** Version-scoped repairs for published Host modules running in the browser Worker. */
import { ForgeError } from './protocol.js'

const HUB_VERSIONS = new Set(['2.2.1', '2.2.2', '2.2.3'])
const HUB_INSTALL_MODULE = 'lib/http/install.js'
const HUB_REGISTRY_PROBE = 'const net = await probeUrl(`${candidate}/`, effectiveProxy, 6000);'
const HUB_BROWSER_PROBE = `const forgeRegistryProbe = candidate.replace(/\\/+$/, "") === "https://registry.npmjs.org"
  ? "https://registry.npmjs.org/dsh-plugin/latest"
  : \`\${candidate}/\`;
const net = await probeUrl(forgeRegistryProbe, effectiveProxy, 6000);`

/**
 * Use npm's CORS-readable Hub metadata for the marketplace's installation precheck.
 * Other registry URLs, probe failures, deadlines and proxy settings retain their behavior.
 * @param name Published package name.
 * @param version Published manifest version.
 * @param modules Collected Host module bytes.
 * @returns Modules with the known marketplace probe repaired, or the original modules.
 * @throws When a supported publication no longer contains exactly one expected probe.
 */
export function applyHostCompatibility(name: string, version: string, modules: Record<string, Uint8Array>): Record<string, Uint8Array> {
  if (name !== 'dsh-plugin' || !HUB_VERSIONS.has(version)) return modules
  const bytes = modules[HUB_INSTALL_MODULE]
  const source = bytes === undefined ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (source.split(HUB_REGISTRY_PROBE).length !== 2) {
    throw new ForgeError('HOST_COMPATIBILITY_MISMATCH', `dsh-plugin@${version} Host install module does not match its Worker registry probe repair`)
  }
  return { ...modules, [HUB_INSTALL_MODULE]: new TextEncoder().encode(source.replace(HUB_REGISTRY_PROBE, HUB_BROWSER_PROBE)) }
}
