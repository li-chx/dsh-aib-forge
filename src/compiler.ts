/** Per-package compilation targeting the matching DSH Worker module runtime. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { collectPackageFiles, checkResourceBudget, resolveResourceLimits, validateResourcePath, validateNestedPackageManifest } from './package-resources.js'
import semver from 'semver'
import { ForgeError, parseBuildRequest, parsePackageBuildRequest, relativePath } from './protocol.js'
import type { BuildExecutor, BuildManifest, BuildRequest, BuildTarget, PackageArtifact, PackageBuildRequest } from './protocol.js'
import type { ArtifactStore } from './store.js'
import { sha256 } from './store.js'
import type { PackageResolver, ResolvedPackage } from './resolver.js'
import { validateDependencies } from './resolver.js'
import { compileSourceClient, sourceClientDeclarations, sourceClientFiles, SOURCE_CLIENT_FILE, type SourceClientResult } from './source-client.js'

/** The actual image transformer, injected to keep the executor independently testable. */
export type ModuleLowerer = (options: { filename: string; source: string }) => { code: string; moduleRequests: readonly string[]; metaResolveRequests: readonly string[] }
/** Load the transformer from the operator-selected DSH build, never from a request. */
export async function loadDshLowerer(modulePath: string): Promise<ModuleLowerer> {
  const module: Record<string, unknown> = await import(pathToFileURL(resolve(modulePath)).href)
  if (typeof module.lowerModuleSource !== 'function') throw new Error('Configured DSH module does not export lowerModuleSource')
  const lower = module.lowerModuleSource
  return Object.freeze((options: { filename: string; source: string }) => {
    const result: unknown = lower(options)
    if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string' || !('moduleRequests' in result) || !Array.isArray(result.moduleRequests) || !result.moduleRequests.every((request: unknown) => typeof request === 'string') || !('metaResolveRequests' in result) || !Array.isArray(result.metaResolveRequests) || !result.metaResolveRequests.every((request: unknown) => typeof request === 'string')) throw new Error('Configured DSH lowerer returned invalid fields')
    return { code: result.code, moduleRequests: result.moduleRequests, metaResolveRequests: result.metaResolveRequests }
  })
}
/** Server-selected limits and runtime target. */
export interface CompilerOptions {
  target: BuildTarget; resolver: PackageResolver; store: ArtifactStore; lowerModule: ModuleLowerer; temporaryRoot?: string
  /** Named host packages may satisfy an exact stable request with a newer patch in the same major/minor. */
  allowHostPatchUpgrade?: readonly string[]
}
const barePackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const isCore = (name: string): boolean => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-')

/** Validate target versions once at startup. */
export function validateTarget(target: BuildTarget): void {
  if (target.protocol !== 1 || !/^[a-zA-Z0-9_-]+$/.test(target.generation)) throw new Error('Invalid configured build target')
  if (!Array.isArray(target.sharedPackages) || target.sharedPackages.some(name => !barePackage.test(name)) || new Set(target.sharedPackages).size !== target.sharedPackages.length) throw new Error('Invalid configured shared packages')
  for (const [face, packages] of Object.entries({ host: target.hostPackages, client: target.clientPackages ?? {} })) {
    for (const [name, version] of Object.entries(packages)) if (!barePackage.test(name) || !semver.valid(version)) throw new Error(`Invalid ${face} package ${name}@${version}`)
  }
  for (const name of [...Object.keys(target.clientPackages ?? {}), ...Object.keys(target.hostPackages).filter(isCore)]) if (!target.sharedPackages.includes(name)) throw new Error(`Shared package policy omits ${name}`)
  if (target.clientModules !== undefined) {
    if (!Array.isArray(target.clientModules) || new Set(target.clientModules).size !== target.clientModules.length) throw new Error('Invalid configured exact Client module inventory')
    for (const specifier of target.clientModules) {
      if (typeof specifier !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9_@.+-]+)*$/.test(specifier) || specifier.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid configured exact Client module inventory')
      const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
      if (target.clientPackages?.[name] === undefined) throw new Error(`Client module ${specifier} has no package version in the target`)
    }
  }
}
function permitsHostPatchUpgrade(name: string, range: string, host: string, allowed: ReadonlySet<string>): boolean {
  if (!allowed.has(name) || !/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(range)) return false
  const requested = semver.parse(range)
  const supplied = semver.parse(host)
  return requested !== null && supplied !== null && requested.prerelease.length === 0 && supplied.prerelease.length === 0
    && requested.major === supplied.major && requested.minor === supplied.minor && supplied.patch >= requested.patch
}
/** Select a fixed shared provider, an explicit target peer, or a private dependency. */
function runtimeDependency(name: string, range: string, target: BuildTarget, allowed: ReadonlySet<string>, peer = false): 'host' | 'client' | undefined {
  const shared = target.sharedPackages.includes(name) || isCore(name)
  const host = target.hostPackages[name]
  const client = target.clientPackages?.[name]
  if (!shared && !peer) return undefined
  if (host !== undefined) {
    if (semver.satisfies(host, range, { includePrerelease: true }) || permitsHostPatchUpgrade(name, range, host, allowed)) return 'host'
    if (peer || shared) throw new ForgeError('HOST_VERSION_MISMATCH', `${name} requires ${range}; the frontend provides ${host}`)
    return undefined
  }
  if (client !== undefined && peer) {
    if (!semver.satisfies(client, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client provides ${client}`)
    return 'client'
  }
  if (client !== undefined) throw new ForgeError('CLIENT_PACKAGE_HOST_IMPORT', `${name} is only available to Client code, not the Worker Host`)
  if (shared) throw new ForgeError('HOST_PACKAGE_UNAVAILABLE', `${name} is shared but not provided by this frontend generation`)
  return undefined
}
/** Compiles each package separately, sharing only declared host module instances. */
export class ForgeCompiler implements BuildExecutor {
  private readonly allowHostPatchUpgrade: ReadonlySet<string>
  constructor(private readonly options: CompilerOptions) {
    validateTarget(options.target)
    this.allowHostPatchUpgrade = new Set(options.allowHostPatchUpgrade)
    for (const name of this.allowHostPatchUpgrade) {
      if (!Object.hasOwn(options.target.hostPackages, name)) throw new Error(`Patch-upgrade policy names unavailable host package ${name}`)
    }
  }
  async build(input: BuildRequest): Promise<BuildManifest> {
    const request = parseBuildRequest(input)
    const { target, resolver, store, lowerModule } = this.options
    if (request.generation !== target.generation) throw new ForgeError('GENERATION_MISMATCH', `Expected generation ${target.generation}`, 409)
    const plugin = request.plugin
    if (!semver.valid(plugin.version)) throw new ForgeError('INVALID_REQUEST', 'Plugin version must be an exact semver version')
    if (target.hostPackages[plugin.name] !== undefined || target.clientPackages?.[plugin.name] !== undefined || target.sharedPackages.includes(plugin.name) || isCore(plugin.name)) throw new ForgeError('CORE_PACKAGE_PROTECTED', `Cannot replace host package ${plugin.name}`)
    if (!(plugin.entry in plugin.files)) throw new ForgeError('INVALID_REQUEST', 'Plugin entry must be present in files')
    for (const file of Object.keys(plugin.files)) {
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file) || file.split('/').includes('node_modules') || file === 'package.json') throw new ForgeError('SOURCE_FILE_UNSUPPORTED', `Unsupported source file ${file}; provide JS, TS or JSON source files outside node_modules`)
    }
    validateDependencies(plugin.dependencies); validateDependencies(plugin.peerDependencies)
    if (plugin.client !== undefined) { sourceClientFiles(plugin); sourceClientDeclarations(plugin) }
    const install: Record<string, string> = {}
    for (const [name, range] of Object.entries(plugin.dependencies)) {
      if (!runtimeDependency(name, range, target, this.allowHostPatchUpgrade)) install[name] = range
    }
    for (const [name, range] of Object.entries(plugin.client?.dependencies ?? {})) {
      if (target.clientPackages?.[name] !== undefined) {
        if (!semver.satisfies(target.clientPackages[name]!, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client provides ${target.clientPackages[name]}`)
      } else if (!plugin.client?.inject.includes(name)) {
        if (isCore(name) || target.sharedPackages.includes(name)) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `${name} is not provided by the shared Client module table or client.inject`)
        install[name] = range
      }
    }
    const directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), 'dsh-forge-'))
    try {
      for (const [file, contents] of Object.entries(plugin.files)) { const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents) }
      await resolver.prepare(directory, install)
      const client = plugin.client === undefined ? undefined : await compileSourceClient(directory, plugin, target)
      const files = client?.hostFiles ?? plugin.files
      return await this.compile(directory, { directory, entry: join(directory, plugin.entry), name: plugin.name, version: plugin.version, dependencies: plugin.dependencies, peerDependencies: plugin.peerDependencies, outputEntry: plugin.entry, modules: Object.fromEntries(Object.entries(files).filter(([path]) => !path.endsWith('.json')).map(([path, value]) => [path, new TextEncoder().encode(value)])), assets: { ...Object.fromEntries(Object.entries(files).filter(([path]) => path.endsWith('.json')).map(([path, value]) => [path, new TextEncoder().encode(value)])), ...client === undefined ? {} : { [SOURCE_CLIENT_FILE]: client.asset } }, ...client === undefined ? {} : { metadata: client.metadata }, ...(plugin.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: plugin.peerDependenciesMeta }) }, plugin.id, client)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  /** Resolve and compile a published registry package without executing its install scripts. */
  async buildPackage(input: PackageBuildRequest): Promise<BuildManifest> {
    const request = parsePackageBuildRequest(input)
    const { target, resolver } = this.options
    if (request.generation !== target.generation) throw new ForgeError('GENERATION_MISMATCH', `Expected generation ${target.generation}`, 409)
    const matched = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(request.spec)
    if (!matched) throw new ForgeError('UNSUPPORTED_DEPENDENCY_SPEC', 'Expected an npm package name with an optional semver version')
    const name = matched[1]!
    let range = matched[2] ?? '*'
    if (Object.hasOwn(target.hostPackages, name) || target.clientPackages?.[name] !== undefined || target.sharedPackages.includes(name) || isCore(name)) throw new ForgeError('CORE_PACKAGE_PROTECTED', `Cannot replace host package ${name}`)
    if (range === 'latest') {
      if (resolver.resolveTag === undefined) throw new ForgeError('PACKAGE_TAG_UNSUPPORTED', 'This resolver cannot resolve the latest registry tag')
      range = await resolver.resolveTag(name, 'latest')
    }
    validateDependencies({ [name]: range })
    const directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), 'dsh-forge-'))
    try {
      await resolver.prepare(directory, { [name]: range })
      const plugin = await resolver.resolve(name, directory, directory)
      return await this.compile(directory, plugin, request.pluginId)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  private async compile(directory: string, plugin: ResolvedPackage, pluginId: string, sourceClient?: SourceClientResult): Promise<BuildManifest> {
    const { target, resolver, store, lowerModule } = this.options
      const packages = new Map<string, PackageArtifact>()
      const completed = new Map<string, PackageArtifact>()
      const active = new Set<string>()
      const hostPackages: Record<string, string> = { ...sourceClient?.hostPackages }
      const clientPackages: Record<string, string> = { ...sourceClient?.clientPackages }
      const compilePackage = async (pkg: ResolvedPackage, inheritedPrivate: ReadonlySet<string> = new Set()): Promise<PackageArtifact> => {
        validateDependencies(pkg.dependencies); validateDependencies(pkg.peerDependencies)
        // A target peer cannot silently bind the image when its consumer supplies a private instance.
        for (const name of Object.keys(pkg.peerDependencies)) {
          if (inheritedPrivate.has(name) && target.hostPackages[name] !== undefined) throw new ForgeError('PEER_CONTEXT_UNSUPPORTED', `${pkg.name} requires peer ${name} from a private consumer context; target peers must use the shared frontend instance`)
        }
        const cached = completed.get(pkg.directory)
        if (cached) return cached
        if (active.has(pkg.directory)) throw new ForgeError('DEPENDENCY_CYCLE_UNSUPPORTED', `Dependency cycle involving ${pkg.name} is not supported by this generation`)
        active.add(pkg.directory)
        const selected = new Map<string, 'host' | 'client' | undefined>()
        const privateContext = new Set(inheritedPrivate)
        for (const [name, range] of Object.entries(pkg.dependencies)) {
          const face = runtimeDependency(name, range, target, this.allowHostPatchUpgrade)
          selected.set(name, face)
          if (face === 'host') { hostPackages[name] = target.hostPackages[name]!; privateContext.delete(name) }
          else privateContext.add(name)
        }
        const outputEntry = pkg.outputEntry ?? relative(pkg.directory, pkg.entry).replaceAll('\\', '/')
        if (!relativePath.safeParse(outputEntry).success || outputEntry.startsWith('index.js/') || outputEntry.split('/').includes('node_modules')) throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${pkg.name} has an invalid entry ${outputEntry}`)
        const limits = pkg.resourceLimits ?? resolveResourceLimits({})
        const collected = pkg.modules === undefined ? await collectPackageFiles(pkg.directory, pkg.assets ?? {}, limits) : { modules: pkg.modules, assets: pkg.assets ?? {} }
        const compiled: Record<string, Uint8Array> = { ...collected.assets }
        for (const [path, bytes] of Object.entries(collected.modules)) {
          if (/\.d\.[cm]?tsx?$/i.test(path)) continue
          validateResourcePath(path)
          if (Object.hasOwn(compiled, path)) throw new ForgeError('RESOURCE_ENTRY_COLLISION', `${pkg.name} has both code and a resource at ${path}`)
          const loader = /\.[cm]?tsx?$/i.test(path) ? (path.endsWith('x') ? 'tsx' : 'ts') : (path.endsWith('x') ? 'jsx' : 'js')
          let javascript: string
          try {
            const transformed = await transform(new TextDecoder().decode(bytes), { loader, target: 'es2022', sourcefile: path, jsx: 'automatic' })
            if (transformed.warnings.length) throw new Error(transformed.warnings.map(warning => warning.text).join('; '))
            javascript = transformed.code
          } catch (error) { throw new ForgeError('COMPILE_FAILED', `${pkg.name}/${path}: ${error instanceof Error ? error.message : String(error)}`) }
          try { compiled[path] = new TextEncoder().encode(lowerModule({ filename: `/${path}`, source: javascript }).code) }
          catch (error) { throw new ForgeError('LOWERING_FAILED', `${pkg.name}/${path}: ${error instanceof Error ? error.message : String(error)}`) }
        }
        const paths = Object.keys(compiled)
        for (const path of paths) {
          validateResourcePath(path)
          if (path.endsWith('/package.json')) validateNestedPackageManifest(path, compiled[path]!)
          if (path === 'package.json' || path.startsWith('package.json/') || path.startsWith('index.js/') || paths.some(other => other !== path && other.startsWith(path + '/')) || (path !== outputEntry && (path.startsWith(outputEntry + '/') || outputEntry.startsWith(path + '/')))) throw new ForgeError('RESOURCE_ENTRY_COLLISION', `${pkg.name} has conflicting or reserved path ${path}`)
        }
        if (Object.hasOwn(collected.assets, outputEntry) && !outputEntry.endsWith('.json')) throw new ForgeError('RESOURCE_ENTRY_COLLISION', `${pkg.name} entry ${outputEntry} is a non-module asset`)
        if (!Object.hasOwn(compiled, outputEntry)) throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${pkg.name} entry ${outputEntry} is not an included runtime file`)
        checkResourceBudget(paths.length, Object.values(compiled).reduce((sum, bytes) => sum + bytes.byteLength, 0), limits)
        const resolvedPeers = new Map<string, ResolvedPackage>()
        for (const [name, range] of Object.entries(pkg.peerDependencies)) {
          const mayBeAbsent = pkg.peerDependenciesMeta?.[name]?.optional === true && !Object.hasOwn(pkg.dependencies, name)
          if (mayBeAbsent && target.hostPackages[name] === undefined && target.clientPackages?.[name] === undefined && (target.sharedPackages.includes(name) || isCore(name))) continue
          if (inheritedPrivate.has(name) && target.hostPackages[name] !== undefined) throw new ForgeError('PEER_CONTEXT_UNSUPPORTED', `${pkg.name} cannot bind target peer ${name} to a private consumer instance`)
          const face = runtimeDependency(name, range, target, this.allowHostPatchUpgrade, true)
          if (Object.hasOwn(pkg.dependencies, name) && selected.get(name) !== face) throw new ForgeError('PEER_CONTEXT_UNSUPPORTED', `${pkg.name} declares ${name} as both a private dependency and a target peer`)
          if (face === 'host') hostPackages[name] = target.hostPackages[name]!
          if (face === 'client') clientPackages[name] = target.clientPackages![name]!
          selected.set(name, face)
          if (face === undefined) {
            let provider: ResolvedPackage
            try { provider = await resolver.resolve(name, pkg.directory, directory) }
            catch (error) {
              if (error instanceof ForgeError && error.code === 'DEPENDENCY_MISSING') {
                if (mayBeAbsent) continue
                throw new ForgeError('PEER_MISSING', `${pkg.name} requires peer ${name}@${range}; no provider is installed by its consumer`)
              }
              throw error
            }
            if (!semver.satisfies(provider.version, range, { includePrerelease: true })) throw new ForgeError('PEER_VERSION_MISMATCH', `${pkg.name} requires peer ${name}@${range}; its installed provider is ${provider.version}`)
            const dependency = pkg.dependencies[name]
            if (dependency !== undefined && !semver.satisfies(provider.version, dependency, { includePrerelease: true })) throw new ForgeError('DEPENDENCY_VERSION_MISMATCH', `${name}@${provider.version} does not satisfy dependency ${dependency}`)
            resolvedPeers.set(name, provider)
          }
        }
        const dependencies: Record<string, string> = {}
        for (const name of [...new Set([...Object.keys(pkg.dependencies), ...resolvedPeers.keys()])].sort()) {
          if (selected.get(name) === 'host' || selected.get(name) === 'client') continue
          const child = resolvedPeers.get(name) ?? await resolver.resolve(name, pkg.directory, directory)
          for (const range of [pkg.dependencies[name], pkg.peerDependencies[name]]) {
            if (range !== undefined && !semver.satisfies(child.version, range, { includePrerelease: true })) throw new ForgeError('DEPENDENCY_VERSION_MISMATCH', `${name}@${child.version} does not satisfy ${range}`)
          }
          dependencies[name] = (await compilePackage(child, privateContext)).id
        }
        const files = []
        for (const [path, bytes] of Object.entries(compiled).sort(([left], [right]) => left.localeCompare(right))) {
          const hash = sha256(bytes)
          const objectKey = `${target.generation}/objects/${hash}`
          await store.put(objectKey, bytes)
          files.push({ path, sha256: hash, size: bytes.length, objectKey })
        }
        const hostDependencies = [...selected].filter(([, face]) => face === 'host').map(([name]) => name).sort()
        const metadata = pkg.metadata === undefined ? {} : { metadata: pkg.metadata }
        const id = sha256(JSON.stringify({ name: pkg.name, version: pkg.version, entry: outputEntry, files, dependencies, hostDependencies, ...metadata }))
        const result: PackageArtifact = { id, name: pkg.name, version: pkg.version, entry: outputEntry, dependencies, hostDependencies, files, ...metadata }
        packages.set(id, result); completed.set(pkg.directory, result); active.delete(pkg.directory)
        return result
      }
      const root = await compilePackage(plugin)
      const result = { protocol: 1 as const, generation: target.generation, plugin: { id: pluginId, name: plugin.name, version: plugin.version, packageId: root.id, entry: root.entry }, hostPackages: Object.fromEntries(Object.entries(hostPackages).sort()), ...Object.keys(clientPackages).length ? { clientPackages: Object.fromEntries(Object.entries(clientPackages).sort()) } : {}, packages: [...packages.values()] }
      return { ...result, revision: sha256(JSON.stringify(result)) }
  }

}
