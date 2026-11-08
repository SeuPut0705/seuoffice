/**
 * Same-document save guard for the editor mains (sheets, slides, PDF, markdown,
 * HTML, mindmap, HWP).
 *
 * When the same document is open in two split panes, both copies edit it. A
 * save from one copy must not silently overwrite a change the other copy made
 * on disk since this copy last read or wrote the file. So before a manual save
 * the editor asks here whether the path is open in another pane AND the disk
 * moved past the recorded state; only then does a dialog ask whether to
 * overwrite ("proceed") or keep the disk copy ("cancel"; the pane stays dirty
 * and the caller skips the write). Autosave never raises the dialog: it defers
 * silently (the caller answers `{ ok: false, reason: 'external-modified' }`).
 *
 * The guard only judges copy pairs: when the path is open nowhere else, a save
 * behaves exactly as before, whatever the disk holds. Untitled documents have
 * no path and are never judged. Pairs never engage for a path with no recorded
 * state. This module decides whether to write; it never writes.
 *
 * The Word editor keeps its own, stricter external-change check (apps/docs);
 * this module serves the editors that only guard against a sibling pane.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { saveConflictLabels } from './save-conflict-labels'

/** Disk snapshot recorded when a copy last read or wrote a document path. */
export interface SaveDiskState {
  mtimeMs: number
  size: number
  hash: string
}

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** stat + content hash of the file, or null when it is not a readable file. */
export async function recordDiskState(path: string): Promise<SaveDiskState | null> {
  try {
    const info = await stat(path)
    const bytes = await readFile(path)
    return { mtimeMs: info.mtimeMs, size: info.size, hash: sha256Hex(bytes) }
  } catch {
    return null
  }
}

/**
 * True when the file on disk no longer matches the recorded state (same rule
 * as the Word editor's external-change check): no record or a missing file is
 * not a conflict, equal mtime+size skips the reread, and only a differing
 * mtime/size falls through to the hash comparison.
 */
export async function isModifiedSince(
  recorded: SaveDiskState | undefined,
  path: string,
): Promise<boolean> {
  if (!recorded) return false
  let current: { mtimeMs: number; size: number }
  try {
    current = await stat(path)
  } catch {
    return false
  }
  if (current.mtimeMs === recorded.mtimeMs && current.size === recorded.size) return false
  try {
    return sha256Hex(await readFile(path)) !== recorded.hash
  } catch {
    return false
  }
}

// Symbol.for: the probe survives multiple bundled copies of this module (one
// per editor), so the copy the shell fills is the one an editor main reads
const PROBE = Symbol.for('genoffice.open-path-probe')

type OpenPathProbe = (path: string) => boolean

function holder(): Record<symbol, OpenPathProbe | null | undefined> {
  return globalThis as unknown as Record<symbol, OpenPathProbe | null | undefined>
}

/** the shell's answer to "is this path open in another pane"; null removes it */
export function setOpenPathProbe(probe: OpenPathProbe | null): void {
  holder()[PROBE] = probe
}

/**
 * Whether the host says this path is open elsewhere in the app. Without a
 * probe (an editor running on its own) nothing is open elsewhere, and a broken
 * probe counts as "no sibling copy" so a normal save is never interrupted.
 */
export function isPathOpenElsewhere(path: string): boolean {
  const probe = holder()[PROBE]
  if (!probe) return false
  try {
    return probe(path) === true
  } catch {
    return false
  }
}

export interface SaveConflictOptions {
  /** the window the prompt should sit over; null shows it without a parent */
  parent: BrowserWindow | null
  path: string
  /** this copy's disk state, from its last read/write of the path */
  recorded: SaveDiskState | undefined
  lang: string
}

/**
 * Ask before a manual save overwrites a change made by the sibling pane.
 * Returns 'proceed' when nothing should stop the write — the path is open
 * nowhere else, the disk still matches the record, or the user chose to
 * overwrite — and 'cancel' when the user chose to keep the disk copy.
 */
export async function confirmOverwriteIfConflicted(
  options: SaveConflictOptions,
): Promise<'proceed' | 'cancel'> {
  if (!isPathOpenElsewhere(options.path)) return 'proceed'
  if (!(await isModifiedSince(options.recorded, options.path))) return 'proceed'
  const labels = saveConflictLabels(options.lang)
  const { dialog } = await import('electron')
  const box = {
    type: 'warning' as const,
    message: labels.message,
    detail: labels.detail,
    buttons: [labels.overwrite, labels.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const parent = options.parent
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, box)
      : await dialog.showMessageBox(box)
  return response === 0 ? 'proceed' : 'cancel'
}

/**
 * Whether a silent (auto) save must be skipped: true exactly when a manual
 * save would raise the prompt. Autosave never raises it — the caller leaves
 * the renderer dirty and answers `{ ok: false, reason: 'external-modified' }`.
 */
export async function shouldDeferAutoSave(
  path: string,
  recorded: SaveDiskState | undefined,
): Promise<boolean> {
  if (!isPathOpenElsewhere(path)) return false
  return isModifiedSince(recorded, path)
}
