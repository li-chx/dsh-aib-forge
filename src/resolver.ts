/** Isolated pnpm installation without dependency lifecycle scripts. */
import { spawn } from 'node:child_process'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { exports as resolveExports } from 'resolve.exports'
import semver from 'semver'
import { z } from 'zod'
import { readPublishedAssets } from './package-assets.js'
import type { PublishedAssets } from './package-assets.js'
import { collectPackageFiles, resolveResourceLimits, validateResourcePath } from './package-resources.js'
import type { ResourceLimits } from './package-resources.js'
import { ForgeError, packageName } from './protocol.js'

const manifestSchema = z.object({
  name: packageName, version: z.string(), main: z.string().optional(), module: z.string().optional(),
  browser: z.union([z.string(), z.record(z.string(), z.union([z.string(), z.boolean()]))]).optional(),
  exports: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(), peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
}).passthrough()
/** Manifest and entry resolved for an installed npm package. */
export interface ResolvedPackage extends Partial<PublishedAssets> { directory: string; entry: string; outputEntry?: string; modules?: Record<string, Uint8Array>; resourceLimits?: ResourceLimits; name: string; version: string; dependencies: Record<string, string>; peerDependencies: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean | undefined }> }
/** Dependency installation and package lookup, replaceable independently. */
export interface PackageResolver {
  prepare(directory: string, dependencies: Record<string, string>): Promise<void>
  resolveTag?(name: string, tag: 'latest'): Promise<string>
  resolve(name: string, importerDirectory: string, workspaceDirectory: string): Promise<ResolvedPackage>
}
/** Restrict remote package specifications to registry semver ranges. */
export function validateDependencies(dependencies: Record<string, string>): void {
  for (const [name, range] of Object.entries(dependencies)) {
    if (!packageName.safeParse(name).success || !semver.validRange(range)) throw new ForgeError('UNSUPPORTED_DEPENDENCY_SPEC', `Dependency ${name} must use an npm semver range, received ${range}`)
  }
}
/** pnpm subprocess deadline, executable and registry are server-owned. */
export interface PnpmResolverOptions extends Partial<ResourceLimits> { executable: string; timeoutMs: number; registry: string }
/** Registry dependency resolver with lifecycle scripts and automatic peers disabled. */
export class PnpmPackageResolver implements PackageResolver {
  private readonly resourceLimits: ResourceLimits
  constructor(private readonly options: PnpmResolverOptions) { this.resourceLimits = resolveResourceLimits(options) }
  /** Resolve the published endpoint's supported tag to an exact registry version before installation. */
  async resolveTag(name: string, tag: 'latest'): Promise<string> {
    packageName.parse(name)
    const base = this.options.registry.endsWith('/') ? this.options.registry : this.options.registry + '/'
    let response: Response
    try { response = await fetch(new URL(`${encodeURIComponent(name)}/${tag}`, base), { signal: AbortSignal.timeout(this.options.timeoutMs), headers: { Accept: 'application/json' } }) }
    catch (error) { throw new ForgeError('REGISTRY_RESOLUTION_FAILED', `Cannot resolve ${name}@${tag}: ${error instanceof Error ? error.message : String(error)}`, 502) }
    if (!response.ok) throw new ForgeError('REGISTRY_RESOLUTION_FAILED', `Registry returned HTTP ${response.status} for ${name}@${tag}`, 502)
    let decoded: unknown
    try { decoded = await response.json() }
    catch (error) { throw new ForgeError('REGISTRY_RESOLUTION_FAILED', `Registry returned invalid metadata for ${name}@${tag}`, 502) }
    const metadata = z.object({ version: z.string() }).safeParse(decoded)
    if (!metadata.success || !semver.valid(metadata.data.version)) throw new ForgeError('PACKAGE_VERSION_INVALID', `Registry did not return an exact version for ${name}@${tag}`, 502)
    return metadata.data.version
  }
  async prepare(directory: string, dependencies: Record<string, string>): Promise<void> {
    validateDependencies(dependencies)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies }))
    if (Object.keys(dependencies).length === 0) return
    await writeFile(join(directory, '.npmrc'), `ignore-scripts=true\nauto-install-peers=false\nstrict-peer-dependencies=false\nregistry=${this.options.registry}\n`)
    await new Promise<void>((accept, reject) => {
      const child = spawn(this.options.executable, ['install', '--ignore-scripts', '--no-frozen-lockfile', '--reporter=append-only'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      let output = ''; let timedOut = false
      const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8192) }
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32') child.kill('SIGKILL')
        else if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) child.kill('SIGKILL') } }
      }, this.options.timeoutMs)
      child.once('error', error => { clearTimeout(timer); reject(new ForgeError('INSTALL_FAILED', `Cannot start pnpm: ${error.message}`, 503)) })
      child.once('close', code => {
        clearTimeout(timer)
        if (timedOut) reject(new ForgeError('INSTALL_TIMEOUT', 'Dependency installation exceeded its deadline', 504))
        else if (code !== 0) reject(new ForgeError('INSTALL_FAILED', `pnpm exited with ${code}: ${output}`))
        else accept()
      })
    })
  }
  async resolve(name: string, importerDirectory: string, workspaceDirectory: string): Promise<ResolvedPackage> {
    packageName.parse(name)
    const root = resolve(workspaceDirectory)
    if (importerDirectory !== root && !importerDirectory.startsWith(root + '/')) throw new ForgeError('SOURCE_PATH_ESCAPE', 'Dependency lookup must stay inside its installation workspace')
    let search = importerDirectory
    let directory: string | undefined
    while (true) {
      try { directory = await realpath(join(search, 'node_modules', name)); break }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      const parent = dirname(search)
      if (search === root || parent === search) break
      search = parent
    }
    if (directory && directory !== root && !directory.startsWith(root + '/')) throw new ForgeError('SOURCE_PATH_ESCAPE', `Installed package ${name} escapes its workspace`)
    if (!directory) throw new ForgeError('DEPENDENCY_MISSING', `Cannot resolve installed package ${name}`)
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))
    if (!parsed.success) throw new ForgeError('PACKAGE_INVALID', `Invalid manifest for ${name}: ${parsed.error.message}`)
    const manifest = parsed.data
    if (!semver.valid(manifest.version)) throw new ForgeError('PACKAGE_INVALID', `Invalid package version for ${name}`)
    if (['preinstall', 'install', 'postinstall'].some(key => manifest.scripts?.[key])) throw new ForgeError('INSTALL_SCRIPT_UNSUPPORTED', `${name} declares installation scripts; Forge does not execute them`)
    let entry: string | undefined
    if (manifest.exports !== undefined) {
      try {
        const spec = { name: manifest.name, exports: manifest.exports }
        const imported = resolveExports(spec, '.', { browser: true, conditions: ['require'] })?.[0]
        entry = imported
      }
      catch (error) { throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${name} does not expose a compatible root entry: ${error instanceof Error ? error.message : String(error)}`) }
    } else {
      if (manifest.browser && typeof manifest.browser !== 'string') throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${name} uses a browser remapping object, which this generation does not support`)
      entry = typeof manifest.browser === 'string' ? manifest.browser : manifest.module ?? manifest.main ?? 'index.js'
    }
    if (!entry || !resolve(directory, entry).startsWith(directory + '/')) throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${name} has no safe package entry`)
    const candidate = resolve(directory, entry)
    let file: string | undefined
    for (const suffix of ['', '.js', '.mjs', '.cjs', '.json', '/index.js']) {
      try { if ((await stat(candidate + suffix)).isFile()) { file = candidate + suffix; break } }
      catch (error) { if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error }
    }
    if (!file) throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `Cannot find entry for ${name}`)
    const actualEntry = await realpath(file)
    if (!actualEntry.startsWith(directory + '/')) throw new ForgeError('SOURCE_PATH_ESCAPE', `${name} entry escapes its package`)
    const sourceEntry = relative(directory, file).replaceAll('\\', '/')
    const outputEntry = sourceEntry
    validateResourcePath(outputEntry)
    const published = await readPublishedAssets(directory, manifest.name, manifest, outputEntry, this.resourceLimits)
    const { modules, assets } = await collectPackageFiles(directory, published?.assets ?? {}, this.resourceLimits)
    return { directory, entry: file, outputEntry, name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {}, ...(manifest.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: manifest.peerDependenciesMeta }), ...published, assets, modules, resourceLimits: this.resourceLimits }
  }
}
