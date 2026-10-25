/** Forward an explicit DSH checkout to Node test subprocesses and registry smokes. */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveDshRoot } from './dsh-path.mjs'

const [mode, ...args] = process.argv.slice(2)
const { values } = parseArgs({ args, options: { 'dsh-root': { type: 'string' } } })
const dshRoot = resolveDshRoot(values['dsh-root'])
const root = fileURLToPath(new URL('..', import.meta.url))
const files = mode === 'unit'
  ? ['--test', ...(await readdir(new URL('../tests/', import.meta.url))).filter(name => /\.test\.(?:ts|mjs)$/.test(name)).sort().map(name => `tests/${name}`)]
  : mode === 'npm' ? ['tests/npm-smoke.ts'] : mode === 'published' ? ['tests/published-smoke.ts'] : undefined
if (!files) throw new Error(`Unknown test mode: ${mode}`)
const child = spawn(process.execPath, ['--import', 'tsx', ...files], { cwd: root, env: { ...process.env, DSH_ROOT: dshRoot }, stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
