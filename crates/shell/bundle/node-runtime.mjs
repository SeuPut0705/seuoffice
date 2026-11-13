// The Node runtime the seuoffice command line runs on in the CEF build
// (packages/cli, decision of 2026-11-14: the CLI stays TypeScript, so the
// installer carries a Node of its own; the Electron build ran it on the app
// binary with ELECTRON_RUN_AS_NODE, which CEF does not have).
//
//   node crates/shell/bundle/node-runtime.mjs [--platform darwin|win32] [--arch arm64|x64]
//
// Downloads the pinned release for the target once into
// crates/shell/bundle/out/cache, checks its SHA-256 against the table below,
// and leaves `node` (or `node.exe`) and Node's LICENSE in
// crates/shell/bundle/out/node, where the bundle config picks them up
// (resources/cli/node). Prints the sizes the installer grows by.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** Node 22 as CI runs it (.nvmrc); bump the version and the four sums together */
export const NODE_VERSION = '22.23.5'
const SHA256 = {
  'darwin-arm64': 'd0c68c321161bb2c6483efea9a343010dea8e5e7f60d73c6a7eba140016d662f',
  'darwin-x64': 'd68bf234a07781141dfca61ae4461c24560f70bd53223d76a41529eb02e8554e',
  'win-arm64': 'c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13',
  'win-x64': '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3',
}

const here = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
  },
})
const os = values.platform === 'win32' ? 'win' : values.platform
const target = `${os}-${values.arch}`
const sum = SHA256[target]
if (!sum) throw new Error(`no pinned Node ${NODE_VERSION} for ${target}`)

const stem = `node-v${NODE_VERSION}-${target}`
const file = os === 'win' ? `${stem}.zip` : `${stem}.tar.xz`
const cache = join(here, 'out', 'cache')
const archive = join(cache, file)
mkdirSync(cache, { recursive: true })
if (!existsSync(archive) || sha256(archive) !== sum) {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
}
const got = sha256(archive)
if (got !== sum) throw new Error(`${file}: SHA-256 ${got}, pinned ${sum}`)

const unpacked = join(cache, stem)
rmSync(unpacked, { recursive: true, force: true })
// bsdtar (macOS, Windows' tar.exe) reads both the .tar.xz and the .zip
execFileSync('tar', ['-xf', archive, '-C', cache])
const out = join(here, 'out', 'node')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const binary = os === 'win' ? 'node.exe' : 'node'
copyFileSync(join(unpacked, os === 'win' ? 'node.exe' : join('bin', 'node')), join(out, binary))
copyFileSync(join(unpacked, 'LICENSE'), join(out, 'LICENSE'))
writeFileSync(join(out, 'VERSION'), `${NODE_VERSION} ${target}\n`)

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
console.log(
  `Node ${NODE_VERSION} ${target}: ${binary} ${mb(statSync(join(out, binary)).size)} unpacked, ` +
    `${mb(statSync(archive).size)} as downloaded (about what the installer grows by)`,
)

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
