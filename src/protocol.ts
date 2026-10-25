/** Versioned requests and immutable artifacts exchanged with a DSH Worker. */
import { z } from 'zod'

/** Package names cannot address files, registries or pnpm aliases. */
export const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
/** Files are relative POSIX paths with no traversal or URL encoding. */
export const relativePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('%') && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a relative path without traversal')
/** Build requests contain sources, never server filesystem locations. */
export const buildRequestSchema = z.object({
  protocol: z.literal(1),
  generation: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  plugin: z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    name: packageName,
    version: z.string().min(1),
    entry: relativePath,
    files: z.record(relativePath, z.string()).refine(files => Object.keys(files).length > 0 && Object.keys(files).length <= 1000, 'Expected 1–1000 source files'),
    dependencies: z.record(packageName, z.string()),
    peerDependencies: z.record(packageName, z.string()),
    peerDependenciesMeta: z.record(packageName, z.object({ optional: z.boolean().optional() }).strict()).optional(),
  }).strict(),
}).strict()
/** Validated plugin build request. */
export type BuildRequest = z.infer<typeof buildRequestSchema>
/** A fixed runtime and compiler generation configured by the operator. */
export interface BuildTarget { protocol: 1; generation: string; sharedPackages: string[]; hostPackages: Record<string, string>; clientPackages?: Record<string, string> }
/** One immutable artifact, addressed by its bytes. */
export interface ArtifactFile { path: string; sha256: string; size: number; objectKey: string }
/** One package instance and its exact runtime dependency mapping. */
export interface PackageArtifact { id: string; name: string; version: string; entry: string; dependencies: Record<string, string>; files: ArtifactFile[]; metadata?: PackageMetadata }
/** Complete installable plugin result; clients derive their own increment. */
export interface BuildManifest {
  protocol: 1; generation: string; revision: string;
  plugin: { id: string; name: string; version: string; packageId: string; entry: string };
  hostPackages: Record<string, string>; clientPackages?: Record<string, string>; packages: PackageArtifact[];
}
/** Expected build failure with a stable machine-readable code. */
export class ForgeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'ForgeError' }
}
/** Parse untrusted requests before invoking an executor. */
export function parseBuildRequest(value: unknown): BuildRequest {
  const result = buildRequestSchema.safeParse(value)
  if (!result.success) throw new ForgeError('INVALID_REQUEST', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return result.data
}
/** Build preparation, independent of HTTP transport. */
export interface BuildExecutor { build(request: BuildRequest): Promise<BuildManifest>; buildPackage?(request: PackageBuildRequest): Promise<BuildManifest> }

/** Validate the only public object-key format. */
export function validateObjectKey(key: string): void {
  if (!/^[a-zA-Z0-9_-]+\/objects\/[a-f0-9]{64}$/.test(key)) throw new ForgeError('INVALID_OBJECT_KEY', 'Expected generation/objects/sha256')
}

/** npm package input never addresses a server file or custom registry URL. */
export const packageBuildRequestSchema = z.object({
  protocol: z.literal(1), generation: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  pluginId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), spec: z.string().min(1),
}).strict()
/** Published package compilation request. */
export type PackageBuildRequest = z.infer<typeof packageBuildRequestSchema>
/** Parse a published-package build request before execution. */
export function parsePackageBuildRequest(value: unknown): PackageBuildRequest {
  const parsed = packageBuildRequestSchema.safeParse(value)
  if (!parsed.success) throw new ForgeError('INVALID_REQUEST', parsed.error.message)
  return parsed.data
}
/** Sanitized published metadata copied into the frontend's generated package.json. */
export interface PackageMetadata {
  repository?: string | { url: string }
  dsh?: { bundle?: { patch: string }; client?: { inject: string[]; platform: 'web' } }
  exports?: Record<string, string>
}
