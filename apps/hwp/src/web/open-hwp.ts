import { reportError } from '@seuoffice/web-platform'
import type { WebDocument } from '@seuoffice/web-platform'
import { MAX_HWP_SAVE_BYTES } from '../shared/ipc'
import { fieldKindsOf } from '../main/field-kinds'
import type { SaveBase } from '../main/save-fixes'
import { bytesMatchFormat } from '../main/save-plan'
import { sectionTailsOf } from '../main/section-tails'
import { hasTrackedChanges, withoutTrackedChanges } from '../main/tracked-changes'

export interface OpenedHwp {
  bytes: Uint8Array
  /** the file had tracked changes and is given without them */
  trackingDropped: boolean
  /** the file has tracked changes that could not be left out: it is never saved */
  tracked: boolean
  /** what a save corrects against; empty unless the document was opened to be saved */
  base: SaveBase
}

/**
 * The open half of the desktop `readFile` handler (hwp-main.ts) without permission checks,
 * recovery and disk reads. `forSave` keeps the section tails and field kinds a save puts
 * back, read from the bytes the editor gets, as the desktop keeps them per view.
 */
export function openHwpFromBytes(doc: WebDocument, forSave: boolean): OpenedHwp | null {
  if (doc.bytes.byteLength > MAX_HWP_SAVE_BYTES) {
    reportError('too_large', 'hwp: file is too large to open')
    return null
  }
  let bytes: Uint8Array = doc.bytes
  let trackingDropped = false
  let tracked = false
  if (bytesMatchFormat(bytes, 'hwp') && hasTrackedChanges(bytes)) {
    // the editor gets the document as it reads now; one that cannot be had is not saved
    const current = withoutTrackedChanges(bytes)
    if (current) {
      bytes = current
      trackingDropped = true
    } else {
      tracked = true
    }
  }
  const base: SaveBase = {}
  if (forSave && bytesMatchFormat(bytes, 'hwp')) {
    base.tails = sectionTailsOf(bytes) ?? undefined
    base.kinds = fieldKindsOf(bytes) ?? undefined
  }
  return { bytes, trackingDropped, tracked, base }
}
