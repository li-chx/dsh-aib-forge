/** Select the DSH checkout explicitly so validation never falls back to another worktree. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export function resolveDshRoot(value = process.env.DSH_ROOT) {
  if (!value) throw new Error('Select the DSH checkout with --dsh-root /absolute/path or DSH_ROOT')
  return realpathSync(resolve(value))
}
