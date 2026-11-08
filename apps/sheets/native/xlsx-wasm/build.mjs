// Builds the xlsx engine for wasm32-wasip1 and copies it next to the sheets web entry.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = resolve(here, 'Cargo.toml')
const output = resolve(here, '../../src/web/generated/xlsx-wasm.wasm')

// Homebrew rust has no wasm target: prefer rustup's toolchain where it is installed, as on this Mac.
// CI already has rustup's cargo first on PATH.
const rustupBin = '/opt/homebrew/opt/rustup/bin'
const env = { ...process.env }
if (existsSync(rustupBin)) env.PATH = `${rustupBin}${delimiter}${env.PATH ?? ''}`

const build = spawnSync(
  'cargo',
  ['build', '--release', '--target', 'wasm32-wasip1', '--manifest-path', manifest],
  { env, stdio: 'inherit' },
)
if (build.status !== 0) {
  console.error('xlsx-wasm: cargo build failed')
  process.exit(build.status ?? 1)
}

mkdirSync(dirname(output), { recursive: true })
copyFileSync(resolve(here, 'target/wasm32-wasip1/release/xlsx_wasm.wasm'), output)
console.log(`xlsx-wasm: wrote ${output}`)
