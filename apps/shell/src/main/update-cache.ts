import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * What an installed update leaves in electron-updater's cache folder
 * (`%LOCALAPPDATA%\seuoffice-updater`, `~/Library/Caches/seuoffice-updater`,
 * `~/.cache/seuoffice-updater`), and what a start of the app removes from it.
 *
 * - `pending/<installer>` and `pending/update-info.json`: the download.
 *   electron-updater empties `pending/` when the next download starts or one
 *   fails, never after an install, so the installer of the version that is
 *   now running stays until the next update (the Mac zip likewise).
 * - `installer.exe` (Windows): a copy the NSIS installer makes of itself at
 *   the end of every install, the base of electron-updater's differential
 *   download. This app always downloads the whole installer (updater.ts turns
 *   differential downloads off), so nothing ever reads the copy.
 *
 * A download of a version newer than the running one is an update on its way
 * (downloaded and not installed yet, or an install that did not take and gets
 * another try) and stays, as do a partial download (`pending/temp-*`) and the
 * resumable part beside it (`resume/`, update-resume.ts).
 *
 * No Electron here, so the rule is testable on its own (updater.ts wires it).
 */

const PENDING_DIR = 'pending'
const UPDATE_INFO_FILE = 'update-info.json'
const INSTALLER_COPY = 'installer.exe'

type Log = (...args: unknown[]) => void

/** True once `name` is not in `dir` (any more); a file that stays is logged, never thrown. */
function removed(dir: string, name: string, log: Log): boolean {
  const file = join(dir, name)
  try {
    if (!existsSync(file)) return true
    rmSync(file)
    log('removed', name, 'from the update cache')
    return true
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException)?.code ?? String(err)
    log('could not remove', name, 'from the update cache:', reason)
    return false
  }
}

/** The file a finished download is recorded under, or null without a readable record. */
function downloadedFileName(pendingDir: string): string | null {
  let info: unknown
  try {
    info = JSON.parse(readFileSync(join(pendingDir, UPDATE_INFO_FILE), 'utf8'))
  } catch {
    return null
  }
  const fileName = (info as { fileName?: unknown } | null)?.fileName
  // a bare name only: the record is a file on disk, and what it names is removed
  if (typeof fileName !== 'string' || basename(fileName) !== fileName) return null
  return fileName
}

function numbersOf(match: RegExpExecArray | null): number[] | null {
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * Whether the installer named `fileName` is of the running version or an older
 * one. Only the three numbers are compared (the names carry suffixes such as
 * `-arm64` and `-stable` that read like a pre-release tag), so where they are
 * equal and the running build is a pre-release the answer is no: a later
 * pre-release and the final version have the same numbers. A name without a
 * version is not judged at all.
 */
function installedOrOlder(fileName: string, runningVersion: string): boolean {
  const cached = numbersOf(/-(\d+)\.(\d+)\.(\d+)(?=[-.])/.exec(fileName))
  const running = numbersOf(/^(\d+)\.(\d+)\.(\d+)/.exec(runningVersion))
  if (!cached || !running) return false
  for (let i = 0; i < 3; i++) {
    if (cached[i] !== running[i]) return cached[i] < running[i]
  }
  return !runningVersion.includes('-')
}

/**
 * Removes the installer copies the running version no longer needs. Call it at
 * a start, before any download can run. Never throws; a file that cannot be
 * removed (the installer may still hold it) is logged and tried again at the
 * next start.
 */
export function pruneUpdateCache(options: {
  cacheDir: string
  runningVersion: string
  log: Log
}): void {
  const { cacheDir, runningVersion, log } = options
  try {
    removed(cacheDir, INSTALLER_COPY, log)
    const pendingDir = join(cacheDir, PENDING_DIR)
    const fileName = downloadedFileName(pendingDir)
    if (fileName === null || !installedOrOlder(fileName, runningVersion)) return
    // the record goes only with the file it names, so a failed removal is retried
    if (removed(pendingDir, fileName, log)) removed(pendingDir, UPDATE_INFO_FILE, log)
  } catch (err) {
    log('the update cache was not cleared:', err instanceof Error ? err.message : String(err))
  }
}
