// Builds the Node-API addon of crates/main-node and puts it where rust.ts
// loads it (out/main_node.node, or MAIN_DIFF_ADDON).
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = dirname(fileURLToPath(import.meta.url))
const crates = resolve(tool, '../../crates')
// MAIN_DIFF_PROFILE=node-faults builds unoptimized, for faults.mjs
const profile = process.env.MAIN_DIFF_PROFILE ?? 'node'
execFileSync(
  'cargo',
  ['build', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'main-node', '--profile', profile],
  {
    stdio: 'inherit',
  },
)
const lib = {
  darwin: 'libmain_node.dylib',
  linux: 'libmain_node.so',
  win32: 'main_node.dll',
}[process.platform]
// MAIN_DIFF_ADDON names another place for it, so two comparisons can run at
// once: overwriting an addon a running process has loaded can end that process
const addon = process.env.MAIN_DIFF_ADDON ?? join(tool, 'out', 'main_node.node')
mkdirSync(dirname(addon), { recursive: true })
copyFileSync(join(crates, 'target', profile === 'dev' ? 'debug' : profile, lib), addon)
