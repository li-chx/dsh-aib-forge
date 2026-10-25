/** Per-package compilation targeting the matching DSH Worker module runtime. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'
import { parse } from 'acorn'
import { ancestor, simple } from 'acorn-walk'
import { build, transform } from 'esbuild'
import semver from 'semver'
import { ForgeError, parseBuildRequest, parsePackageBuildRequest } from './protocol.js'
import type { BuildExecutor, BuildManifest, BuildRequest, BuildTarget, PackageArtifact, PackageBuildRequest } from './protocol.js'
import type { ArtifactStore } from './store.js'
import { sha256 } from './store.js'
import type { PackageResolver, ResolvedPackage } from './resolver.js'
import { validateDependencies } from './resolver.js'

/** The actual image transformer, injected to keep the executor independently testable. */
export type ModuleLowerer = ((options: { filename: string; source: string }) => { code: string; moduleRequests: readonly string[]; metaResolveRequests: readonly string[] }) & {
  /** Implemented Node modules supplied by the same DSH runtime build as this transformer. */
  readonly implementedBuiltins?: readonly string[]
}
/** Load the transformer from the operator-selected DSH build, never from a request. */
export async function loadDshLowerer(modulePath: string): Promise<ModuleLowerer> {
  const module: Record<string, unknown> = await import(pathToFileURL(resolve(modulePath)).href)
  if (typeof module.lowerModuleSource !== 'function') throw new Error('Configured DSH module does not export lowerModuleSource')
  const proxies = module.MODULE_PROXIES
  if (proxies === null || typeof proxies !== 'object' || Array.isArray(proxies)) throw new Error('Configured DSH module does not export MODULE_PROXIES')
  const implementedBuiltins = Object.freeze(Object.entries(proxies)
    .filter(([name, path]) => name.startsWith('node:') && typeof path === 'string' && path.startsWith('./node/builtin_modules/implemented/'))
    .map(([name]) => name).sort())
  const lower = module.lowerModuleSource
  return Object.freeze(Object.assign((options: { filename: string; source: string }) => {
    const result: unknown = lower(options)
    if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string' || !('moduleRequests' in result) || !Array.isArray(result.moduleRequests) || !result.moduleRequests.every((request: unknown) => typeof request === 'string') || !('metaResolveRequests' in result) || !Array.isArray(result.metaResolveRequests) || !result.metaResolveRequests.every((request: unknown) => typeof request === 'string')) throw new Error('Configured DSH lowerer returned invalid fields')
    return { code: result.code, moduleRequests: result.moduleRequests, metaResolveRequests: result.metaResolveRequests }
  }, { implementedBuiltins }))
}
/** Server-selected limits and runtime target. */
export interface CompilerOptions {
  target: BuildTarget; resolver: PackageResolver; store: ArtifactStore; lowerModule: ModuleLowerer; temporaryRoot?: string
  /** Named host packages may satisfy an exact stable request with a newer patch in the same major/minor. */
  allowHostPatchUpgrade?: readonly string[]
}
const nativeModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const barePackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const isCore = (name: string): boolean => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-')

/** Validate target versions once at startup. */
export function validateTarget(target: BuildTarget): void {
  if (target.protocol !== 1 || !/^[a-zA-Z0-9_-]+$/.test(target.generation)) throw new Error('Invalid configured build target')
  for (const [face, packages] of Object.entries({ host: target.hostPackages, client: target.clientPackages ?? {} })) {
    for (const [name, version] of Object.entries(packages)) if (!barePackage.test(name) || !semver.valid(version)) throw new Error(`Invalid ${face} package ${name}@${version}`)
  }
}
function permitsHostPatchUpgrade(name: string, range: string, host: string, allowed: ReadonlySet<string>): boolean {
  if (!allowed.has(name) || !/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(range)) return false
  const requested = semver.parse(range)
  const supplied = semver.parse(host)
  return requested !== null && supplied !== null && requested.prerelease.length === 0 && supplied.prerelease.length === 0
    && requested.major === supplied.major && requested.minor === supplied.minor && supplied.patch >= requested.patch
}
function runtimeDependency(name: string, range: string, target: BuildTarget, allowed: ReadonlySet<string>, clientPeer = false): 'host' | 'client' | undefined {
  const host = target.hostPackages[name]
  if (host !== undefined) {
    if (!semver.satisfies(host, range, { includePrerelease: true }) && !permitsHostPatchUpgrade(name, range, host, allowed)) throw new ForgeError('HOST_VERSION_MISMATCH', `${name} requires ${range}; the frontend provides ${host}`)
    return 'host'
  }
  const client = target.clientPackages?.[name]
  if (client !== undefined && clientPeer) {
    if (!semver.satisfies(client, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client provides ${client}`)
    return 'client'
  }
  if (client !== undefined) throw new ForgeError('CLIENT_PACKAGE_HOST_IMPORT', `${name} is only available to Client code, not the Worker Host`)
  if (isCore(name)) throw new ForgeError('HOST_PACKAGE_UNAVAILABLE', `${name} is not provided by this frontend generation`)
  return undefined
}
function assertStaticRequests(source: string): void {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  ancestor(ast, {
    Identifier(node, _state, ancestors) {
      if (node.name !== 'require' && node.name !== '__require') return
      const parent = ancestors.at(-2)
      if (parent?.type !== 'CallExpression' || parent.callee !== node) throw new ForgeError('DYNAMIC_IMPORT_UNSUPPORTED', 'Module loader aliases and require properties are not supported by this generation')
    },
  })
  simple(ast, {
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && (node.callee.name === 'require' || node.callee.name === '__require')) {
        if (node.arguments.length !== 1 || node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string') throw new ForgeError('DYNAMIC_IMPORT_UNSUPPORTED', 'Computed require() requests are not supported by this generation')
      }
    },
    ImportExpression(node) { if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') throw new ForgeError('DYNAMIC_IMPORT_UNSUPPORTED', 'Computed import() requests are not supported by this generation') },
  })
}

/** Compiles each package separately, sharing only declared host module instances. */
export class ForgeCompiler implements BuildExecutor {
  private readonly allowHostPatchUpgrade: ReadonlySet<string>
  private readonly workerBuiltins: ReadonlySet<string>
  constructor(private readonly options: CompilerOptions) {
    validateTarget(options.target)
    this.workerBuiltins = new Set(options.lowerModule.implementedBuiltins ?? [])
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
    if (target.hostPackages[plugin.name] !== undefined || target.clientPackages?.[plugin.name] !== undefined || isCore(plugin.name)) throw new ForgeError('CORE_PACKAGE_PROTECTED', `Cannot replace host package ${plugin.name}`)
    if (!(plugin.entry in plugin.files)) throw new ForgeError('INVALID_REQUEST', 'Plugin entry must be present in files')
    for (const file of Object.keys(plugin.files)) {
      if (!/\.(?:ts|js|mjs|cjs|json)$/.test(file) || file.split('/').includes('node_modules') || file === 'package.json') throw new ForgeError('SOURCE_FILE_UNSUPPORTED', `Unsupported source file ${file}; provide JS, TS or JSON source files outside node_modules`)
    }
    validateDependencies(plugin.dependencies); validateDependencies(plugin.peerDependencies)
    const install: Record<string, string> = {}
    for (const [name, range] of Object.entries({ ...plugin.dependencies, ...plugin.peerDependencies })) if (!runtimeDependency(name, range, target, this.allowHostPatchUpgrade, Object.hasOwn(plugin.peerDependencies, name))) install[name] = range
    const directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), 'dsh-forge-'))
    try {
      for (const [file, contents] of Object.entries(plugin.files)) { const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents) }
      await resolver.prepare(directory, install)
      return await this.compile(directory, { directory, entry: join(directory, plugin.entry), name: plugin.name, version: plugin.version, dependencies: plugin.dependencies, peerDependencies: plugin.peerDependencies }, plugin.id)
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
    if (Object.hasOwn(target.hostPackages, name) || target.clientPackages?.[name] !== undefined || isCore(name)) throw new ForgeError('CORE_PACKAGE_PROTECTED', `Cannot replace host package ${name}`)
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
  private async compile(directory: string, plugin: ResolvedPackage, pluginId: string): Promise<BuildManifest> {
    const { target, resolver, store, lowerModule } = this.options
    const workerBuiltins = this.workerBuiltins
      const packages = new Map<string, PackageArtifact>()
      const completed = new Map<string, PackageArtifact>()
      const active = new Set<string>()
      const hostPackages: Record<string, string> = {}
      const clientPackages: Record<string, string> = {}
      const compilePackage = async (pkg: ResolvedPackage): Promise<PackageArtifact> => {
        const cached = completed.get(pkg.directory)
        if (cached) return cached
        if (active.has(pkg.directory)) throw new ForgeError('DEPENDENCY_CYCLE_UNSUPPORTED', `Dependency cycle involving ${pkg.name} is not supported by this generation`)
        active.add(pkg.directory)
        const declared = { ...pkg.dependencies, ...pkg.peerDependencies }
        for (const [name, range] of Object.entries(declared)) {
          const face = runtimeDependency(name, range, target, this.allowHostPatchUpgrade, Object.hasOwn(pkg.peerDependencies, name))
          if (face === 'host') hostPackages[name] = target.hostPackages[name]!
          if (face === 'client') clientPackages[name] = target.clientPackages![name]!
        }
        const requests = new Set<string>()
        const commonJsRequests = new Set<string>()
        let built
        try {
          built = await build({
            absWorkingDir: pkg.directory, entryPoints: [pkg.entry], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', metafile: true,
            mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'import', 'default'], logLevel: 'silent', sourcemap: false,
            plugins: [{ name: 'forge-package-imports', setup(api) {
              api.onResolve({ filter: /.*/ }, args => {
                if (args.kind === 'entry-point' || args.path.startsWith('.')) return undefined
                const builtin = args.path.startsWith('node:') ? args.path : `node:${args.path}`
                if (workerBuiltins.has(builtin)) return { path: builtin, external: true }
                if (isAbsolute(args.path) || args.path.startsWith('node:') || nativeModules.has(args.path)) throw new ForgeError('NODE_MODULE_UNSUPPORTED', `${pkg.name} imports unsupported system module ${args.path}`)
                if (!barePackage.test(args.path)) throw new ForgeError('PACKAGE_SUBPATH_UNSUPPORTED', `${pkg.name} imports ${args.path}; only bare package roots are supported`)
                if (!(args.path in declared)) throw new ForgeError('UNDECLARED_DEPENDENCY', `${pkg.name} imports undeclared dependency ${args.path}`)
                if (target.clientPackages?.[args.path] !== undefined && target.hostPackages[args.path] === undefined) throw new ForgeError('CLIENT_PACKAGE_HOST_IMPORT', `${pkg.name} imports ${args.path}, which is only available to Client code, not the Worker Host`)
                requests.add(args.path)
                if (args.kind === 'require-call' || args.kind === 'require-resolve') commonJsRequests.add(args.path)
                return { path: args.path, external: true }
              })
              api.onLoad({ filter: /\.(?:[cm]?js|ts|json)$/ }, async args => {
                const path = await realpath(args.path)
                if (relative(pkg.directory, path).startsWith('..') || isAbsolute(relative(pkg.directory, path))) throw new ForgeError('SOURCE_PATH_ESCAPE', `${pkg.name} references a file outside its package`)
                const contents = await readFile(path, 'utf8')
                const loader = extname(path) === '.ts' ? 'ts' : extname(path) === '.json' ? 'json' : 'js'
                if (loader !== 'json') {
                  const javascript = await transform(contents, { loader, target: 'es2022', sourcefile: path })
                  assertStaticRequests(javascript.code)
                }
                return { contents, loader }
              })
            } }],
          })
        } catch (error) {
          // esbuild retains plugin failures in the diagnostic detail field.
          if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
            for (const diagnostic of error.errors) if (diagnostic && typeof diagnostic === 'object' && 'detail' in diagnostic && diagnostic.detail instanceof ForgeError) throw diagnostic.detail
          }
          throw new ForgeError('COMPILE_FAILED', error instanceof Error ? error.message : String(error))
        }
        if (built.warnings.length) throw new ForgeError('COMPILE_UNSUPPORTED', built.warnings.map(warning => warning.text).join('; '))
        const source = built.outputFiles[0]?.text
        if (source === undefined) throw new ForgeError('COMPILE_FAILED', 'Compiler did not produce JavaScript')
        const output = Object.values(built.metafile.outputs).find(item => item.entryPoint !== undefined)
        const entryFormat = output?.entryPoint === undefined ? undefined : built.metafile.inputs[output.entryPoint]?.format
        // ESM bundling wraps a CommonJS or JSON entry in a default export; require() must retain its raw value.
        const unwrapEntry = entryFormat === 'cjs' || extname(pkg.entry) === '.json'
        let code: string
        try { code = lowerModule({ filename: '/index.js', source }).code + (unwrapEntry ? '\nmodule.exports = exports.default;' : '') }
        catch (error) { throw new ForgeError('LOWERING_FAILED', error instanceof Error ? error.message : String(error)) }
        const dependencies: Record<string, string> = {}
        for (const name of [...requests].sort()) {
          if (runtimeDependency(name, declared[name]!, target, this.allowHostPatchUpgrade) === 'host') { hostPackages[name] = target.hostPackages[name]!; continue }
          const child = await resolver.resolve(name, pkg.directory, directory)
          if (commonJsRequests.has(name) && child.requireCompatible === false) throw new ForgeError('PACKAGE_ENTRY_UNSUPPORTED', `${pkg.name} requires ${name}, whose CommonJS entry differs from this target's shared import entry`)
          if (!semver.satisfies(child.version, declared[name]!, { includePrerelease: true })) throw new ForgeError('DEPENDENCY_VERSION_MISMATCH', `${name}@${child.version} does not satisfy ${declared[name]}`)
          dependencies[name] = (await compilePackage(child)).id
        }
        const files = []
        for (const [path, bytes] of Object.entries({ 'index.js': new TextEncoder().encode(code), ...pkg.assets }).sort(([left], [right]) => left.localeCompare(right))) {
          const hash = sha256(bytes)
          const objectKey = `${target.generation}/objects/${hash}`
          await store.put(objectKey, bytes)
          files.push({ path, sha256: hash, size: bytes.length, objectKey })
        }
        const metadata = pkg.metadata === undefined ? {} : { metadata: pkg.metadata }
        const id = sha256(JSON.stringify({ name: pkg.name, version: pkg.version, files, dependencies, ...metadata }))
        const result: PackageArtifact = { id, name: pkg.name, version: pkg.version, entry: 'index.js', dependencies, files, ...metadata }
        packages.set(id, result); completed.set(pkg.directory, result); active.delete(pkg.directory)
        return result
      }
      const root = await compilePackage(plugin)
      const result = { protocol: 1 as const, generation: target.generation, plugin: { id: pluginId, name: plugin.name, version: plugin.version, packageId: root.id, entry: root.entry }, hostPackages: Object.fromEntries(Object.entries(hostPackages).sort()), ...Object.keys(clientPackages).length ? { clientPackages: Object.fromEntries(Object.entries(clientPackages).sort()) } : {}, packages: [...packages.values()] }
      return { ...result, revision: sha256(JSON.stringify(result)) }
  }

}
