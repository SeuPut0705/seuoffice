/**
 * "Restart & Install" was pressed and the app is on its way out. The updater
 * starts the installer only once the quit is certain (will-quit), so a save
 * prompt is never cut short by the installer closing the app. A close that is
 * cancelled at a prompt calls cancelUpdateRestart: the quit is off, and a later
 * ordinary quit must not restart the app into the installer.
 *
 * Its own module, without electron-updater, so the window close paths can
 * reach it without loading the updater.
 */

let restartRequested = false

export function requestUpdateRestart(): void {
  restartRequested = true
}

export function cancelUpdateRestart(): void {
  restartRequested = false
}

export function updateRestartRequested(): boolean {
  return restartRequested
}

/**
 * This launch is the installer reopening the app after an update: the NSIS
 * installer passes --updated to the app it starts (silent update with
 * --force-run, the update's own window, its finish page). A launch by the
 * user never carries it.
 */
export function reopenedByInstaller(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--updated')
}
