/** Immutable object storage; local files simulate COS for development. */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ForgeError, validateObjectKey } from './protocol.js'
export { validateObjectKey } from './protocol.js'

/** Byte storage replaceable by an object-store adapter. */
export interface ArtifactStore {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
}
/** SHA-256 used for content addresses and revision identities. */
export function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
/** Local immutable objects, never arbitrary user-provided filesystem paths. */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}
  async put(key: string, bytes: Uint8Array): Promise<void> {
    validateObjectKey(key)
    if (!key.endsWith(`/${sha256(bytes)}`)) throw new ForgeError('ARTIFACT_HASH_MISMATCH', 'Object key does not match its bytes')
    const file = resolve(this.root, key)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, bytes, { flag: 'wx' })
    try {
      try { await link(temporary, file) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        const existing = await readFile(file)
        if (!existing.equals(Buffer.from(bytes))) throw new ForgeError('ARTIFACT_CORRUPT', 'Existing object content differs from its address', 500)
      }
    } finally { await unlink(temporary) }
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    validateObjectKey(key)
    try {
      const bytes = await readFile(resolve(this.root, key))
      if (!key.endsWith(`/${sha256(bytes)}`)) throw new ForgeError('ARTIFACT_CORRUPT', 'Stored object does not match its address', 500)
      return bytes
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }
}
