/**
 * The id of one AI highlight run (reading-assist spec 4.6): the hash of the
 * preset id and the ordered label names. Changing a label, its place or the
 * preset makes a new run; the same choices find the run again (resume, done
 * blocks skipped). Pure.
 */
import { sha256Hex } from '../tree/hash'

/** hex characters of the run id (a path segment of the store and the job record name) */
export const HIGHLIGHT_RUN_ID_LENGTH = 32

/** a label name as it counts for the run id: NFC, whitespace collapsed, trimmed */
export function normalizeLabelName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function highlightRunId(presetId: string, labelNames: readonly string[]): string {
  const key = JSON.stringify([presetId, ...labelNames.map(normalizeLabelName)])
  return sha256Hex(key).slice(0, HIGHLIGHT_RUN_ID_LENGTH)
}
