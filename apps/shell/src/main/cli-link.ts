import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { HOME_DIR_NAME, installCliLink, launcherFileName } from '@seuoffice/cli/install'
import { readAppSettings, writeAppSetting } from './app-settings'

const SETTING_KEY = 'cliLink'

interface CliLinkRecord {
  version: string
  status: string
  location?: string
}

/**
 * Every launch: record where the seuoffice launcher lives so agents can find it
 * without a PATH (the `seuoffice` skill reads `~/.seuoffice/launcher`), then
 * try to expose it on the PATH. The dmg has no installer step to do that, so
 * macOS retries on each start until a writable directory turns up; Windows
 * gets its PATH entry from the installer and only re-checks once per version
 * (the check spawns PowerShell). Silent and best effort.
 */
export function installCliLinkBestEffort(settingsPath: string): void {
  if (!app.isPackaged) return
  try {
    if (isEphemeralInstall(process.resourcesPath, process.env)) {
      // a DMG under /Volumes or an AppImage FUSE mount vanishes on exit; linking
      // to it would leave a dead command, so wait for a real install
      console.log('[seuoffice] cli link skipped: app runs from a temporary mount')
      return
    }
    const dir = join(process.resourcesPath, 'cli')
    writeLauncherFile(launcherFilePath(process.env), dir)
    const version = app.getVersion()
    const previous = readAppSettings(settingsPath)[SETTING_KEY] as CliLinkRecord | undefined
    if (process.platform === 'win32' && previous?.version === version) return
    const launcher = join(dir, launcherFileName(process.platform))
    const outcome = installCliLink({ launcher })
    console.log(
      `[seuoffice] cli link: ${outcome.status}${outcome.location ? ` (${outcome.location})` : ''}` +
        (outcome.pathHint ? `; not on PATH, add it with: ${outcome.pathHint}` : ''),
    )
    const record: CliLinkRecord = { version, status: outcome.status }
    if (outcome.location) record.location = outcome.location
    writeAppSetting(settingsPath, SETTING_KEY, record)
  } catch (err) {
    console.warn('[seuoffice] cli link failed:', err instanceof Error ? err.message : err)
  }
}

export function isEphemeralInstall(resourcesPath: string, env: NodeJS.ProcessEnv): boolean {
  if (env.APPIMAGE) return true
  return /^\/Volumes\//.test(resourcesPath) || /\/\.mount_[^/]+\//.test(resourcesPath)
}

/** Same directory the seuoffice CLI uses for its audit log; never the upstream app's `~/.genoffice`. */
export function launcherFilePath(env: NodeJS.ProcessEnv): string {
  return join(env.SEUOFFICE_AUTH_DIR || join(homedir(), HOME_DIR_NAME), 'launcher')
}

/** One line, the directory holding seuoffice / seuoffice.cmd; rewritten only when it changed. */
export function writeLauncherFile(file: string, launcherDir: string): boolean {
  const content = `${launcherDir}\n`
  try {
    if (readFileSync(file, 'utf-8') === content) return false
  } catch {}
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
  return true
}
