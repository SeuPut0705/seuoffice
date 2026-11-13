// Builds crates/ipc-probe where probe.ts runs it (crates/target/debug, or
// IPC_DIFF_PROBE). Debug: the cases are small, and fault injection rebuilds
// it once per fault.
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const crates = resolve(dirname(fileURLToPath(import.meta.url)), '../../crates')
execFileSync('cargo', ['build', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'ipc-probe'], {
  stdio: 'inherit',
})
