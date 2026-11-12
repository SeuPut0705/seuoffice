import { webContents as electronWebContents } from 'electron'

/**
 * Ends a closed docs tab or window: its renderer process first, then its
 * webContents.
 *
 * Closing or destroying the webContents of a closed docs view while its page
 * is live wedged the UI thread (see TabManager.removeTab), so the view was
 * detached and left alive: first with its whole renderer (about 170–190 MB
 * per closed document, plus GPU memory, until the app quit), later with the
 * renderer process ended and only the webContents left. That object still
 * stayed until the app quit, one per closed document, carrying the document's
 * title and showing as a page of its own. It is now destroyed once its
 * renderer process is gone: no page is left to unload by then, and closing
 * such a webContents does not wedge.
 *
 * Chromium may host several webContents in one process when it runs short of
 * processes; a process that still serves a live view is left running, and the
 * closed view in it is destroyed when that process ends.
 */

export interface ReleasableContents {
  id: number
  isDestroyed(): boolean
  getOSProcessId(): number
  forcefullyCrashRenderer(): void
  once(event: 'render-process-gone', listener: () => void): unknown
  close(): void
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

/** Destroy the closed view once it has no renderer process (now, if it has none) */
function destroyWhenRendererGone(target: ReleasableContents): void {
  const destroy = (): void => {
    // not inside Electron's own event dispatch for the webContents being destroyed
    setImmediate(() => {
      try {
        if (!target.isDestroyed()) target.close()
      } catch {
        // torn down meanwhile: nothing left to destroy
      }
    })
  }
  // no process id: the renderer never started, or it is already gone
  if (!target.getOSProcessId()) destroy()
  else target.once('render-process-gone', destroy)
}

/**
 * End the closed view's renderer process and destroy the view once that
 * process is gone. False when no process was ended here: it is already gone,
 * or still shared with an open view (it ends when the last of them closes).
 */
export function releaseClosedRenderer(
  target: ReleasableContents,
  peers: () => readonly ReleasableContents[] = () => electronWebContents.getAllWebContents(),
): boolean {
  if (closed.has(target.id)) return false
  closed.add(target.id)
  try {
    if (target.isDestroyed()) return false
    destroyWhenRendererGone(target)
    if (!canEndRendererProcess(target, peers())) return false
    target.forcefullyCrashRenderer()
    return true
  } catch {
    // a view torn down meanwhile: nothing left to free
    return false
  }
}
