import { hwpMemosOf } from '@genoffice/file-parse'
import type { HwpMemo } from '@genoffice/file-parse'
import type { MemoSnapshot } from '../shared/ipc'
import { hwpxMemoCountOf } from './tab-widths'

/**
 * What makes a memo the same memo across a save. Its anchor may move (the engine rewrites
 * paragraph indexes and character ranges), so the anchor is not part of this; the note and
 * who wrote it are.
 */
function identityOf(memo: {
  author?: string | null
  date?: string | null
  text?: string | null
  place?: string | null
}): string {
  return JSON.stringify([memo.author ?? '', memo.date ?? '', memo.text ?? '', memo.place ?? ''])
}

/** How many of `wanted` have no counterpart in `saved`, counting each memo once. */
function missingFrom(wanted: MemoSnapshot[], saved: HwpMemo[]): number {
  const left = new Map<string, number>()
  for (const memo of saved) {
    const key = identityOf(memo)
    left.set(key, (left.get(key) ?? 0) + 1)
  }
  let missing = 0
  for (const memo of wanted) {
    const key = identityOf(memo)
    const count = left.get(key) ?? 0
    if (count > 0) left.set(key, count - 1)
    else missing++
  }
  return missing
}

export interface MemoLossInput {
  /** the bytes that were just written */
  saved: Uint8Array
  /** the bytes of the file this save overwrote, when it was opened as HWPX */
  original: Uint8Array | null
  /** what the editor listed while its input was locked; null when the listing failed */
  memos: MemoSnapshot[] | null
}

/**
 * How many memos of a HWPX save did not make it into the written bytes. The engine lists
 * the memos it models, and the raw section XML can hold records it does not; a memo counts
 * as lost when a listed one has no counterpart in the saved file, or when the number of
 * unmodelled records fell. A save is not failed over this: the number is only a warning.
 *
 * Anchor coordinates are not compared: a legitimate edit can move them. Content, date,
 * author and place identify a memo. Re-reading the written bytes can fail; that reads as
 * "nothing lost" so a save is never reported as losing memos it cannot check.
 */
export async function lostMemoCountOf(input: MemoLossInput): Promise<number> {
  if ((input.memos?.length ?? 0) === 0 && !input.original) return 0
  try {
    const originalRaw = input.original ? hwpxMemoCountOf(input.original) : null
    // the usual document: the editor listed none and the opened file held none, so there is
    // nothing to lose and no reason to read either file with the engine
    if (input.memos?.length === 0 && originalRaw === 0) return 0
    const savedModel = await hwpMemosOf(input.saved)
    const modelLost = input.memos ? missingFrom(input.memos, savedModel) : 0
    if (!input.original) return modelLost
    const originalModel = await hwpMemosOf(input.original)
    const savedRaw = hwpxMemoCountOf(input.saved)
    if (originalRaw === null || savedRaw === null) return modelLost
    // records the engine does not model: compare how many the opened file had that the
    // engine could not list with how many the saved file has in the same situation
    const unmodelledBefore = Math.max(0, originalRaw - originalModel.length)
    const unmodelledAfter = Math.max(0, savedRaw - savedModel.length)
    return modelLost + Math.max(0, unmodelledBefore - unmodelledAfter)
  } catch {
    return 0
  }
}
