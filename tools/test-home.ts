import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { OLD_ENV_NAMES, OLD_ENV_PREFIX } from '../packages/i18n/src/old-names'

/**
 * Vitest setup file (`test.setupFiles` of a workspace): the test process gets a
 * home folder of its own, empty and inside the OS temp dir, removed when the
 * test file ends.
 *
 * Product code keeps per-user files under the home folder: the CLI's audit log
 * and launcher record in ~/.seuoffice, the app's userData, the config folders
 * of the agent tools. A test that runs such code with the environment it
 * inherited used to write into the folders of whoever ran the suite. With HOME
 * (USERPROFILE on Windows) replaced, os.homedir() and every default derived
 * from it land in the throwaway folder, in this process and in any child it
 * starts. A test that needs its own location still passes one explicitly.
 */

// The Rust toolchain stays where it is installed. A test that shells out to
// cargo (the third-party notice generator does) would otherwise have rustup
// download a whole toolchain into the throwaway home, on every run.
const installedHome = homedir()
process.env.CARGO_HOME ??= join(installedHome, '.cargo')
process.env.RUSTUP_HOME ??= join(installedHome, '.rustup')

// os.tmpdir() reads TMPDIR / TEMP, never HOME, so it stays the real temp dir
const home = mkdtempSync(join(tmpdir(), 'seuoffice-test-home-'))

process.env.HOME = home
process.env.USERPROFILE = home
if (process.platform === 'win32') {
  // on Windows the app-data folders are variables of their own
  process.env.APPDATA = join(home, 'AppData', 'Roaming')
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
}

// Variables that move a per-user location away from the home folder. One that
// the person running the suite has set would lead straight back to their real
// files, so none of them reaches a test; the defaults under the home apply.
for (const name of [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_BIN_HOME',
  'SEUOFFICE_HOME',
  'SEUOFFICE_AUTH_DIR',
  'SEUOFFICE_AUDIT_LOG',
  'SEUOFFICE_USER_DATA',
  'SEUOFFICE_AI_SETTINGS',
  // the spelling of an earlier version: product code under test takes these over
  ...OLD_ENV_NAMES.map((taken) => OLD_ENV_PREFIX + taken),
]) {
  delete process.env[name]
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
