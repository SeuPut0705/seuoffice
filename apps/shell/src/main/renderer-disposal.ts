import { webContents as electronWebContents } from 'electron'

/**
 * Ends the renderer process of a closed docs tab or window.
 *
 * A closed docs view cannot have its webContents closed or destroyed: that
 * wedges the UI thread (see TabManager.removeTab), so the view is detached and
 * left alive. Left alone, each closed docs tab kept its whole renderer (about
 * 170–190 MB, plus GPU memory) until the app quit, and on an 8 GB PC enough
 * open-and-close cycles ran the machine out of memory. Ending only the process
 * frees that memory while the webContents object — the thing whose teardown
 * wedges — stays as it was.
 *
 * Chromium may host several webContents in one process when it runs short of
 * processes; a process that still serves a live view is left running.
 */

export interface ReleasableContents {
  id: number
  isDestroyed(): boolean
  getOSProcessId(): number
  forcefullyCrashRenderer(): void
}

/** webContents ids of closed views handed here: their process ends on purpose */
const closed = new Set<number>()

/** true for a view the shell closed (its renderer's exit is not a crash) */
export function wasReleasedRenderer(webContentsId: number): boolean {
  return closed.has(webContentsId)
}

/** whether ending the target's process would leave every open view untouched */
export function canEndRendererProcess(
  target: ReleasableContents,
  peers: readonly ReleasableContents[],
): boolean {
  if (target.isDestroyed()) return false
  const pid = target.getOSProcessId()
  if (!pid) return false
  return !peers.some(
    (peer) =>
      peer.id !== target.id &&
      !peer.isDestroyed() &&
      !closed.has(peer.id) &&
      peer.getOSProcessId() === pid,
  )
}

/** End the closed view's renderer process; false when it is already gone, or
 *  still shared with an open view (it ends when the last of them closes) */
export function releaseClosedRenderer(
  target: ReleasableContents,
  peers: () => readonly ReleasableContents[] = () => electronWebContents.getAllWebContents(),
): boolean {
  if (closed.has(target.id)) return false
  closed.add(target.id)
  try {
    if (!canEndRendererProcess(target, peers())) return false
    target.forcefullyCrashRenderer()
    return true
  } catch {
    // a view torn down meanwhile: nothing left to free
    return false
  }
}
