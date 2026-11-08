import { MAX_HWP_SAVE_BYTES } from '../shared/ipc'
import type { HwpFormat, MeasuredTab, TabSpot } from '../shared/ipc'
import { applySaveFixes } from '../main/save-fixes'
import type { SaveBase } from '../main/save-fixes'
import { bytesMatchFormat } from '../main/save-plan'
import { newTabsOf } from '../main/tab-widths'

export type WebSaveBytes =
  { ok: true; bytes: Uint8Array; tailsLost: boolean } | { ok: false; error: string }

const isSaveSize = (data: unknown): data is Uint8Array =>
  data instanceof Uint8Array && data.length > 0 && data.length <= MAX_HWP_SAVE_BYTES

/** The desktop `newTabs` handler (hwp-main.ts) for a save in progress. */
export function newTabSpots(data: unknown, format: unknown): TabSpot[] {
  if (!isSaveSize(data)) return []
  if ((format !== 'hwp' && format !== 'hwpx') || !bytesMatchFormat(data, format)) return []
  return newTabsOf(data, format)
}

/**
 * What the desktop `commitSave` (hwp-main.ts) checks and corrects before it writes: the same
 * container check, then `applySaveFixes` with the measured tabs and the base kept at open.
 */
export function webSaveBytes(
  base: SaveBase,
  format: HwpFormat,
  data: unknown,
  tabs: unknown,
): WebSaveBytes {
  if (!isSaveSize(data)) return { ok: false, error: 'hwp: bad save request' }
  if (!bytesMatchFormat(data, format)) {
    return { ok: false, error: `hwp: exported bytes are not a ${format} file` }
  }
  const fixed = applySaveFixes(
    data,
    format,
    Array.isArray(tabs) ? (tabs as MeasuredTab[]) : undefined,
    base,
  )
  if (fixed.tailsSkipped !== undefined) {
    console.warn(`hwp: master pages or memos were not put back on save (${fixed.tailsSkipped})`)
  }
  return { ok: true, bytes: fixed.bytes, tailsLost: fixed.tailsSkipped !== undefined }
}
