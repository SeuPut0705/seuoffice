// The update feed of a CEF release, as electron-builder wrote it for the
// Electron build, so one release serves both and the updater
// (src/host/update/feed.rs) reads it the same way.
//
//   node crates/shell/bundle/release-feed.mjs app-update
//     before `tauri build`: bundle/out/app-update.yml, which the bundle
//     config puts in the resources (provider, channel, cache folder)
//
//   node crates/shell/bundle/release-feed.mjs feed --version 0.13.0 <file>...
//     after it: each file's `.blockmap` beside it and the channel file
//     (latest.yml / stable.yml, -mac on macOS) in the first file's folder.
//     The files are the Windows installer, or on macOS the update zip
//     (`ditto -c -k --keepParent SeuOffice.app SeuOffice-<v>-arm64-mac.zip`)
//     and the dmg.
//
// SEUOFFICE_UPDATE_CHANNEL picks the channel as for the Electron build
// (apps/shell/electron-builder.cjs): latest (default) or stable. The block
// map is app-builder's (buildBlockMap), the one electron-builder.seuoffice.cjs
// writes for the Electron installer.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const channel = process.env.SEUOFFICE_UPDATE_CHANNEL || 'latest'
if (channel !== 'latest' && channel !== 'stable') {
  throw new Error(`SEUOFFICE_UPDATE_CHANNEL must be "latest" or "stable", got "${channel}"`)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: 'string' },
    platform: { type: 'string', default: process.platform },
  },
})
const [command, ...files] = positionals

if (command === 'app-update') {
  const out = join(here, 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'app-update.yml'),
    `owner: SeuPut0705\nrepo: seuoffice\nprovider: github\nchannel: ${channel}\nupdaterCacheDirName: seuoffice-updater\n`,
  )
} else if (command === 'feed') {
  if (!values.version || files.length === 0) {
    throw new Error('feed needs --version and at least one file')
  }
  // app-builder-lib comes with electron-builder, a devDependency of apps/shell
  const require = createRequire(join(here, '../../../apps/shell/package.json'))
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
  const entries = []
  for (const file of files) {
    const { size, sha512, blockMapSize } = await buildBlockMap(file, 'gzip', `${file}.blockmap`)
    entries.push({ url: basename(file), sha512, size, blockMapSize })
  }
  const lines = [`version: ${values.version}`, 'files:']
  for (const e of entries) {
    lines.push(`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`)
    if (e.blockMapSize) lines.push(`    blockMapSize: ${e.blockMapSize}`)
  }
  const [first] = entries
  lines.push(
    `path: ${first.url}`,
    `sha512: ${first.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
  )
  const name = `${channel}${values.platform === 'darwin' ? '-mac' : ''}.yml`
  writeFileSync(join(dirname(files[0]), name), `${lines.join('\n')}\n`)
  console.log(`${name}: ${entries.map((e) => `${e.url} ${e.size} bytes`).join(', ')}`)
} else {
  throw new Error('usage: release-feed.mjs app-update | feed --version <v> <file>...')
}
