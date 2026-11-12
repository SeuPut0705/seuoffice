// Builds the Node-API addon of crates/main-node and puts it where rust.ts
// loads it (out/main_node.node).
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = dirname(fileURLToPath(import.meta.url))
const crates = resolve(tool, '../../crates')
execFileSync(
  'cargo',
  ['build', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'main-node', '--profile', 'node'],
  {
    stdio: 'inherit',
  },
)
const lib = {
  darwin: 'libmain_node.dylib',
  linux: 'libmain_node.so',
  win32: 'main_node.dll',
}[process.platform]
mkdirSync(join(tool, 'out'), { recursive: true })
copyFileSync(join(crates, 'target', 'node', lib), join(tool, 'out', 'main_node.node'))
