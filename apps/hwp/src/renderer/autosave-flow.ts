/**
 * Autosave to the document's own file (the ribbon toggle, or the shell-wide default).
 *
 * Exporting a HWP document serializes the whole document on the typing thread, so a
 * turn is only taken after the user has left the editor alone for a moment. A failed
 * or refused save skips a few turns instead of retrying every 30 seconds.
 */

/** Same cadence as the other editors' autosave */
export const AUTOSAVE_INTERVAL_MS = 30_000
/** How long the user must have left the editor alone (the document may be large) */
export const AUTOSAVE_IDLE_MS = 2_000
/** Turns skipped after a failed save (about five minutes at 30 s) */
export const AUTOSAVE_BACKOFF_TICKS = 10

export interface AutosaveOptions {
  /** cheap check just before an attempt: document open, changed, not busy, user idle */
  shouldSave(): boolean | Promise<boolean>
  /** one save; false when nothing was written (cancel, refusal, failure) */
  save(): Promise<boolean>
  intervalMs?: number
  backoffTicks?: number
}

export interface AutosaveHandle {
  stop(): void
  /** run one turn now (tests, and the window-blur path uses the same guard) */
  tick(): Promise<void>
}

export function startAutosave(options: AutosaveOptions): AutosaveHandle {
  const interval = options.intervalMs ?? AUTOSAVE_INTERVAL_MS
  const backoff = options.backoffTicks ?? AUTOSAVE_BACKOFF_TICKS
  let running = false
  let skip = 0

  const tick = async (): Promise<void> => {
    if (running) return
    if (skip > 0) {
      skip -= 1
      return
    }
    running = true
    try {
      if (!(await options.shouldSave())) return
      const saved = await options.save().catch(() => false)
      skip = saved ? 0 : backoff
    } catch {
      skip = backoff
    } finally {
      running = false
    }
  }

  const timer = window.setInterval(() => void tick(), interval)
  const onBlur = (): void => void tick()
  window.addEventListener('blur', onBlur)
  return {
    tick,
    stop() {
      window.clearInterval(timer)
      window.removeEventListener('blur', onBlur)
    },
  }
}
