import { reportError } from '@seuoffice/web-platform'
import type { WebDocument } from '@seuoffice/web-platform'
import { MAX_HWP_SAVE_BYTES } from '../shared/ipc'
import { bytesMatchFormat } from '../main/save-plan'
import { hasTrackedChanges, withoutTrackedChanges } from '../main/tracked-changes'

export interface OpenedHwp {
  bytes: Uint8Array
  /** the file had tracked changes and is given without them */
  trackingDropped: boolean
}

/**
 * The open half of the desktop `readFile` handler (hwp-main.ts) without permission checks,
 * recovery and disk reads. Section tails and field kinds only feed saves, which the web lacks.
 */
export function openHwpFromBytes(doc: WebDocument): OpenedHwp | null {
  if (doc.bytes.byteLength > MAX_HWP_SAVE_BYTES) {
    reportError('too_large', 'hwp: file is too large to open')
    return null
  }
  let bytes: Uint8Array = doc.bytes
  let trackingDropped = false
  if (bytesMatchFormat(bytes, 'hwp') && hasTrackedChanges(bytes)) {
    // the editor gets the document as it reads now
    const current = withoutTrackedChanges(bytes)
    if (current) {
      bytes = current
      trackingDropped = true
    }
  }
  return { bytes, trackingDropped }
}
