/**
 * Translation block keys (spec §6). Pure: no Node APIs, so environment-free
 * callers (the job engine) can import this file directly.
 *
 * A block's key is the fingerprint of the page it starts on, the hash of its
 * normalized source text, and how many earlier blocks on that page had the
 * same hash. A block stitched across pages belongs to its start page. Running
 * again over a different page range yields the same keys for the same text;
 * a page whose text changed (AI-read) yields new keys.
 */
import { sha256Hex } from '../tree/hash'
import { runsText } from '../tree/inline'
import type { InlineRun } from '../tree/types'
import type { TextUnit } from '../tree/derive'

export interface TranslationBlockKey {
  /** fingerprint of the page the block starts on */
  pageFingerprint: string
  /** SHA-256 hex of normalizeSourceText(runs) */
  textHash: string
  /** 0-based index of this hash among the blocks of that page */
  occurrence: number
}

/** source text as hashed for the key: NFC, whitespace runs collapsed, trimmed */
export function normalizeSourceText(runs: readonly InlineRun[]): string {
  return runsText(runs).normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** one key per unit, in the given (reading) order */
export function translationBlockKeys(
  units: readonly Pick<TextUnit, 'runs' | 'pageFingerprint'>[],
): TranslationBlockKey[] {
  const seen = new Map<string, number>()
  return units.map((u) => {
    const textHash = sha256Hex(normalizeSourceText(u.runs))
    const slot = `${u.pageFingerprint}\u0000${textHash}`
    const occurrence = seen.get(slot) ?? 0
    seen.set(slot, occurrence + 1)
    return { pageFingerprint: u.pageFingerprint, textHash, occurrence }
  })
}

/** stable string form, used as the map key of StoredTranslation.blocks */
export function blockKeyString(key: TranslationBlockKey): string {
  return `${key.pageFingerprint}:${key.textHash}:${key.occurrence}`
}
