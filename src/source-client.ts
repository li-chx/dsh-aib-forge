/** Build explicit browser sources into one lazy Client factory without executing plugin code. */
import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { build, type Plugin } from 'esbuild'
import semver from 'semver'
import { ForgeError } from './protocol.js'
import type { BuildRequest, BuildTarget, PackageMetadata } from './protocol.js'
import { checkResourceBudget, resolveResourceLimits } from './package-resources.js'
import { validateDependencies } from './resolver.js'

/** The generated browser resource cannot also be selected as an author-provided source. */
export const SOURCE_CLIENT_FILE = 'forge-client.js'
const bare = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9_@.+/-]+)?$/
const systemModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const core = (name: string): boolean => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-')
const packageRoot = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
const within = (root: string, file: string): boolean => { const path = relative(root, file); return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path) }

/** Selected Host modules and the generated Client asset use independent module programs. */
export interface SourceClientResult {
  hostFiles: Record<string, string>
  asset: Uint8Array
  metadata: PackageMetadata
  hostPackages: Record<string, string>
  clientPackages: Record<string, string>
}

/** Validate the explicit Client-only selection before dependencies are installed.
 * @param plugin - Validated source descriptor.
 * @returns Client-only files; all other submitted files remain available to Host runtime requests.
 */
export function sourceClientFiles(plugin: BuildRequest['plugin']): ReadonlySet<string> {
  const client = plugin.client
  if (client === undefined) throw new Error('Client source selection requires a Client descriptor')
  if (!Object.hasOwn(plugin.files, client.entry) || !/\.[cm]?[jt]sx?$/.test(client.entry)) throw new ForgeError('INVALID_REQUEST', 'Client entry must name a submitted JS, TS, JSX or TSX module')
  if (Object.hasOwn(plugin.files, SOURCE_CLIENT_FILE)) throw new ForgeError('RESOURCE_ENTRY_COLLISION', `${SOURCE_CLIENT_FILE} is reserved for the generated Client bundle`)
  const exclusive = new Set(client.files ?? [client.entry])
  if (!exclusive.has(client.entry) || exclusive.has(plugin.entry) || [...exclusive].some(path => !Object.hasOwn(plugin.files, path))) throw new ForgeError('INVALID_REQUEST', 'client.files must include the Client entry, exclude the Host entry, and name only explicitly submitted files')
  return exclusive
}

/** Merge explicit source declarations without silently rebinding one face's dependency version.
 * @param plugin - Validated source descriptor.
 * @returns Shared and Client-only requirements authorized for browser imports.
 */
export function sourceClientDeclarations(plugin: BuildRequest['plugin']): Record<string, string> {
  validateDependencies(plugin.dependencies); validateDependencies(plugin.peerDependencies)
  const declarations: Record<string, string> = { ...plugin.dependencies, ...plugin.peerDependencies }
  for (const requirements of [plugin.client?.dependencies ?? {}, plugin.client?.peerDependencies ?? {}]) {
    validateDependencies(requirements)
    for (const [name, range] of Object.entries(requirements)) {
      if (declarations[name] !== undefined && declarations[name] !== range) throw new ForgeError('CLIENT_DEPENDENCY_CONFLICT', `Host and Client declarations for ${name} must use the same range in this generation`)
      declarations[name] = range
    }
  }
  return declarations
}

/**
 * Compile browser JS/TS/TSX and select the Host program from the explicitly submitted sources.
 * @param directory - Isolated build workspace populated with only the submitted source and installed dependencies.
 * @param plugin - Validated source descriptor and contents.
 * @param target - Operator-selected fixed frontend capabilities.
 * @returns Client factory bytes, manifest declarations and remaining Host source requirements.
 */
export async function compileSourceClient(directory: string, plugin: BuildRequest['plugin'], target: BuildTarget): Promise<SourceClientResult> {
  const client = plugin.client
  if (client === undefined) throw new Error('Source Client compilation requires a Client descriptor')
  const exclusive = sourceClientFiles(plugin)
  const declarations = sourceClientDeclarations(plugin)
  const injected = new Set(client.inject)
  if (injected.has(plugin.name)) throw new ForgeError('CLIENT_DEPENDENCY_INVALID', 'Client inject cannot name its own package')
  const hostPackages: Record<string, string> = {}
  const clientPackages: Record<string, string> = {}
  for (const name of injected) {
    const version = target.hostPackages[name]
    if (version === undefined) throw new ForgeError('CLIENT_DEPENDENCY_MISSING', `Client inject ${name} is not supplied by the frontend target`)
    hostPackages[name] = version
  }
  const selectedFiles = new Set(Object.keys(plugin.files).map(path => resolve(directory, path)))
  const seedModules = new Set(target.clientModules ?? [])
  const manifests = new Map<string, Promise<Record<string, unknown>>>()
  const seenFiles = new Set<string>()
  let inputBytes = 0
  const limits = resolveResourceLimits({})
  const resolutionMarker = {}
  const dependencyOwner = async (importer: string): Promise<Record<string, unknown> | undefined> => {
    if (selectedFiles.has(importer)) return undefined
    let parent = dirname(await realpath(importer))
    while (within(directory, parent)) {
      const file = resolve(parent, 'package.json')
      try {
        let pending = manifests.get(file)
        if (pending === undefined) {
          pending = readFile(file, 'utf8').then(text => {
            const value: unknown = JSON.parse(text)
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeError('PACKAGE_INVALID', `Invalid browser dependency manifest`)
            return value as Record<string, unknown>
          })
          manifests.set(file, pending)
        }
        return await pending
      } catch (error) {
        manifests.delete(file)
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      parent = dirname(parent)
    }
    throw new ForgeError('PACKAGE_INVALID', 'Browser dependency has no manifest inside its installation workspace')
  }
  for (const [name, range] of Object.entries({ ...client.dependencies, ...client.peerDependencies })) {
    const supplied = target.clientPackages?.[name]
    if (supplied !== undefined) {
      if (!semver.satisfies(supplied, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client provides ${supplied}`)
      clientPackages[name] = supplied
      continue
    }
    if (injected.has(name)) {
      if (!semver.satisfies(target.hostPackages[name]!, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client graph provides ${target.hostPackages[name]}`)
      continue
    }
    let manifestPath: string
    try { manifestPath = await realpath(resolve(directory, 'node_modules', name, 'package.json')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new ForgeError('CLIENT_DEPENDENCY_MISSING', `Client dependency or peer ${name}@${range} has no installed provider`)
      throw error
    }
    if (!within(directory, manifestPath)) throw new ForgeError('SOURCE_PATH_ESCAPE', 'Client dependency escapes its installation workspace')
    const provider = await dependencyOwner(manifestPath)
    if (provider === undefined || provider.name !== name || typeof provider.version !== 'string' || !semver.satisfies(provider.version, range, { includePrerelease: true })) throw new ForgeError('DEPENDENCY_VERSION_MISMATCH', `Installed Client dependency ${name} does not satisfy ${range}`)
    if (typeof provider.scripts === 'object' && provider.scripts !== null && ['preinstall', 'install', 'postinstall'].some(key => Reflect.has(provider.scripts!, key))) throw new ForgeError('INSTALL_SCRIPT_UNSUPPORTED', `Client dependency ${name} declares installation scripts; Forge does not execute them`)
  }
  const clientResolver: Plugin = {
    name: 'forge-client-capabilities',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === resolutionMarker) return undefined
        if (args.kind === 'entry-point' || args.path.startsWith('.') || isAbsolute(args.path)) return undefined
        if (args.path.startsWith('node:') || systemModules.has(args.path) || !bare.test(args.path)) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `Client code cannot import ${args.path}`)
        const name = packageRoot(args.path)
        const owner = await dependencyOwner(args.importer)
        const declared = owner === undefined ? declarations : {
          ...(typeof owner.dependencies === 'object' && owner.dependencies !== null ? owner.dependencies : {}),
          ...(typeof owner.peerDependencies === 'object' && owner.peerDependencies !== null ? owner.peerDependencies : {}),
          ...(typeof owner.optionalDependencies === 'object' && owner.optionalDependencies !== null ? owner.optionalDependencies : {}),
        }
        const range: unknown = Reflect.get(declared, name)
        if (typeof range !== 'string' || !semver.validRange(range)) throw new ForgeError('CLIENT_DEPENDENCY_UNDECLARED', `Client import ${args.path} needs a declared dependency or peer dependency on ${name}`)
        if (target.clientPackages?.[name] !== undefined) {
          if (!seedModules.has(args.path)) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `The frontend module table does not provide ${args.path}`)
          const supplied = target.clientPackages[name]!
          if (!semver.satisfies(supplied, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend Client provides ${supplied}`)
          clientPackages[name] = supplied
          return { path: args.path, external: true }
        }
        if (injected.has(name)) {
          if (args.path !== name && args.path !== `${name}/client`) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `Injected Client package ${name} cannot provide subpath ${args.path}`)
          const supplied = target.hostPackages[name]!
          if (!semver.satisfies(supplied, range, { includePrerelease: true })) throw new ForgeError('CLIENT_VERSION_MISMATCH', `${name} requires ${range}; the frontend graph package provides ${supplied}`)
          return { path: args.path, external: true }
        }
        if (core(name) || target.sharedPackages.includes(name)) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `${args.path} is not a shared Client module; Client graph packages require client.inject`)
        const resolved = await builder.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: resolutionMarker })
        if (resolved.errors.length) return { errors: resolved.errors }
        if (resolved.external || resolved.namespace !== 'file') throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `Private Client import ${args.path} did not resolve to an installed file`)
        const actual = await realpath(resolved.path)
        if (!within(directory, actual)) throw new ForgeError('SOURCE_PATH_ESCAPE', 'Client dependency escapes its installation workspace')
        const provider = await dependencyOwner(actual)
        if (provider === undefined || provider.name !== name || typeof provider.version !== 'string' || !semver.satisfies(provider.version, range, { includePrerelease: true })) throw new ForgeError('DEPENDENCY_VERSION_MISMATCH', `Installed Client dependency ${name} does not satisfy ${range}`)
        return { path: resolved.path, namespace: resolved.namespace, suffix: resolved.suffix }
      })
      builder.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
        const actual = await realpath(args.path)
        if (!within(directory, actual)) throw new ForgeError('SOURCE_PATH_ESCAPE', 'Client import escapes its installation workspace')
        if (!relative(directory, actual).split('/').includes('node_modules') && !selectedFiles.has(actual)) throw new ForgeError('SOURCE_FILE_MISSING', `Client import ${relative(directory, actual)} was not listed in files`)
        if (!/\.(?:[cm]?[jt]sx?|json)$/.test(actual)) throw new ForgeError('CLIENT_IMPORT_UNSUPPORTED', `Client resource ${relative(directory, actual)} must be a JS, TS, JSX, TSX or JSON file`)
        const owner = await dependencyOwner(actual)
        if (owner !== undefined && typeof owner.scripts === 'object' && owner.scripts !== null && ['preinstall', 'install', 'postinstall'].some(key => Reflect.has(owner.scripts!, key))) throw new ForgeError('INSTALL_SCRIPT_UNSUPPORTED', 'Browser dependency declares installation scripts; Forge does not execute them')
        const contents = await readFile(actual)
        if (!seenFiles.has(actual)) { seenFiles.add(actual); inputBytes += contents.byteLength }
        checkResourceBudget(seenFiles.size, inputBytes, limits)
        const loader = /\.json$/.test(actual) ? 'json' : /\.[cm]?tsx?$/.test(actual) ? (actual.endsWith('x') ? 'tsx' : 'ts') : actual.endsWith('x') ? 'jsx' : 'js'
        return { contents, loader }
      })
    },
  }
  let browser
  try {
    browser = await build({ absWorkingDir: directory, entryPoints: [client.entry], bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic', write: false, logLevel: 'silent', plugins: [clientResolver] })
  } catch (error) { throw new ForgeError('CLIENT_COMPILE_FAILED', `${plugin.name}: ${error instanceof Error ? error.message : String(error)}`) }
  if (browser.warnings.length) throw new ForgeError('CLIENT_COMPILE_FAILED', browser.warnings.map(warning => warning.text).join('; '))
  const retained = Object.fromEntries(Object.entries(plugin.files).filter(([path]) => !exclusive.has(path)))
  const body = browser.outputFiles[0]?.text
  if (body === undefined || browser.outputFiles.length !== 1) throw new ForgeError('CLIENT_COMPILE_FAILED', 'Client build must produce exactly one JavaScript bundle')
  const asset = new TextEncoder().encode(`window.__ModuleLoader__.load({id:${JSON.stringify(plugin.name)},factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;\n}});\n`)
  checkResourceBudget(Object.keys(plugin.files).length, Object.values(plugin.files).reduce((sum, source) => sum + Buffer.byteLength(source), 0), limits)
  checkResourceBudget(1, asset.byteLength, limits)
  return { hostFiles: retained, asset, metadata: { dsh: { client: { platform: 'web', inject: client.inject } }, exports: { '.': `./${plugin.entry}`, './client': `./${SOURCE_CLIENT_FILE}` } }, hostPackages, clientPackages }
}
