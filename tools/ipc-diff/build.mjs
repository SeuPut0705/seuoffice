// Builds crates/ipc-probe where probe.ts runs it (crates/target/debug, or
// IPC_DIFF_PROBE). Debug: the cases are small, and fault injection rebuilds
// it once per fault.
//
// On macOS the build fails closed when the binary links the OS key store
// (SecItem*, SecKeychain*): a probe that reads the owner's login keychain
// prompts for its password on every run. The binary is deleted so that
// neither the gate, faults.mjs nor CI can run it.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const crates = resolve(dirname(fileURLToPath(import.meta.url)), '../../crates')
execFileSync('cargo', ['build', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'ipc-probe'], {
  stdio: 'inherit',
})

if (process.platform === 'darwin') {
  const binary = process.env.IPC_DIFF_PROBE ?? join(crates, 'target', 'debug', 'ipc-probe')
  const undefinedSymbols = execFileSync('nm', ['-u', binary], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const keyStore = undefinedSymbols.split('\n').filter((s) => /SecItem|SecKeychain/.test(s))
  if (keyStore.length > 0) {
    rmSync(binary, { force: true })
    console.error(
      `error: ipc-probe links the OS key store (${keyStore.length} symbols, ${keyStore[0].trim()}); deleted ${binary}`,
    )
    process.exit(90)
  }
}
