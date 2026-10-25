/** Derive the fixed Forge target from the same packed image served to the browser. */
export function imageTarget(packed, generation) {
  if (!generation) throw new Error('Build DSH runtime artifacts with Forge support before preparing the preview')
  const hostPackages = {}
  for (const [path, bytes] of Object.entries(packed.files)) {
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path)) continue
    const manifest = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') hostPackages[manifest.name] = manifest.version
  }
  if (!Object.keys(hostPackages).length) throw new Error('No base-image package versions found')
  const manifest = JSON.parse(new TextDecoder().decode(packed.files['config/vfs-manifest.json']))
  if (!manifest.clientPackages || !Object.keys(manifest.clientPackages).length) throw new Error('Build the Client package roster before preparing the preview')
  return { protocol: 1, generation, hostPackages, clientPackages: manifest.clientPackages }
}
