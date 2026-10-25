/** Checkout passed explicitly by the test launcher. */
import { resolve } from 'node:path'

const configured = process.env.DSH_ROOT
if (!configured) throw new Error('Run tests with --dsh-root /absolute/path or DSH_ROOT')
export const dshRoot = resolve(configured)
