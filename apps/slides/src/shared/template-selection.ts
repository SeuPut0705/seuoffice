/**
 * The design a deck is made with, as it is remembered per document: a built-in
 * template or one of the user's saved styles, plus the requests typed on top
 * of it ("mostly blue"). Shared by the main process (which stores it) and the
 * renderer (which shows and changes it). Pure: no Node, no Electron.
 */

export type TemplateSelectionKind = 'builtin' | 'saved'

export interface TemplateSelection {
  kind: TemplateSelectionKind
  /** The built-in template's id, or the saved style's name */
  key: string
  /** Requests added on top of the template, oldest first */
  adjustments: string[]
  /** When this record was written (ms since the epoch); stamped by the store */
  updatedAt: number
}

/** What a caller hands over to be remembered; the store validates it and stamps `updatedAt` */
export interface TemplateSelectionInput {
  kind: TemplateSelectionKind
  key: string
  adjustments?: string[]
}

export const TEMPLATE_SELECTION_GET_CHANNEL = 'slides:ai-template-selection-get'
export const TEMPLATE_SELECTION_SET_CHANNEL = 'slides:ai-template-selection-set'

/** A key longer than this is not a template id or a style name (tunable default) */
export const TEMPLATE_KEY_MAX_CHARS = 128
/** Total length of the added requests; beyond it the oldest are dropped (tunable default) */
export const TEMPLATE_ADJUSTMENTS_MAX_CHARS = 600

const KINDS: readonly string[] = ['builtin', 'saved'] satisfies TemplateSelectionKind[]

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair at the end */
function cutTo(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * The added requests as they are stored: trimmed, empty and non-string entries
 * dropped, and the oldest dropped until the total length fits the cap. The
 * newest request is never dropped: one that is longer than the cap by itself
 * is cut to it. Anything that is not a list is no request at all.
 */
export function normalizeTemplateAdjustments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const kept: string[] = []
  let total = 0
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry: unknown = raw[i]
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (!text) continue
    if (kept.length === 0) {
      const newest = cutTo(text, TEMPLATE_ADJUSTMENTS_MAX_CHARS)
      if (newest) kept.push(newest)
      total = newest.length
      continue
    }
    if (total + text.length > TEMPLATE_ADJUSTMENTS_MAX_CHARS) break
    kept.push(text)
    total += text.length
  }
  return kept.reverse()
}

/**
 * Validate what a caller wants remembered. Returns null for anything that is
 * not a selection (unknown kind, empty or over-long key, added requests that
 * are not a list) so a bad call is ignored instead of stored. The key is kept
 * exactly as given: a saved style is looked up by its exact name.
 */
export function normalizeTemplateSelection(input: unknown, now: number): TemplateSelection | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const { kind, key, adjustments } = input as Record<string, unknown>
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null
  if (typeof key !== 'string' || !key.trim() || key.length > TEMPLATE_KEY_MAX_CHARS) return null
  if (adjustments !== undefined && adjustments !== null && !Array.isArray(adjustments)) return null
  return {
    kind: kind as TemplateSelectionKind,
    key,
    adjustments: normalizeTemplateAdjustments(adjustments),
    updatedAt: now,
  }
}
