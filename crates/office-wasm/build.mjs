import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = resolve(here, '../Cargo.toml')

export const WASM_PATH = resolve(here, '../target/wasm32-wasip1/release/office_wasm.wasm')

// Homebrew rust has no wasm target: prefer rustup's toolchain where it is installed.
const rustupBin = '/opt/homebrew/opt/rustup/bin'
const env = { ...process.env }
if (existsSync(rustupBin)) env.PATH = `${rustupBin}${delimiter}${env.PATH ?? ''}`

// the hwp reader of file-parse compiles rhwp from its patched source (vendor/rhwp-core,
// decision 0050), a path dependency cargo resolves before it builds anything
if (!existsSync(resolve(here, '../.rhwp-source/v0.9.0/Cargo.toml'))) {
  const source = spawnSync(
    process.execPath,
    [resolve(here, '../../tools/build-rhwp-core.mjs'), '--source-only'],
    { env, stdio: 'inherit' },
  )
  if (source.status !== 0) {
    console.error('office-wasm: preparing the rhwp source failed')
    process.exit(source.status ?? 1)
  }
}

const build = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--target',
    'wasm32-wasip1',
    '--manifest-path',
    manifest,
    '-p',
    'office-wasm',
  ],
  { env, stdio: 'inherit' },
)
if (build.status !== 0) {
  console.error('office-wasm: cargo build failed')
  process.exit(build.status ?? 1)
}
console.log(`office-wasm: ${WASM_PATH} (${statSync(WASM_PATH).size} bytes)`)
