import type { AgentSegment } from '../../../studio-plugin/agent-plugin.mjs'

/**
 * The part of the document the user selected in the editor, as the AI panel
 * keeps it between reading it and sending a request about it.
 */
export interface SelectionScope {
  /** one run per selected paragraph, as the editor handed them out */
  segments: AgentSegment[]
  inTable: boolean
  /** the runs are one stretch of paragraphs: it can become more or fewer paragraphs */
  contiguous: boolean
  /** the same for the same selection: tells a new selection from the one already shown */
  key: string
}

/** How often the panel asks the editor what is selected (the editor does not announce it). */
export const SELECTION_POLL_MS = 700
/** longest selection excerpt echoed on a user bubble */
export const SCOPE_TEXT_MAX = 200

// Word-parity count (the docs editor's word count): Asian characters one by one + non-Asian words
const ASIAN_RE =
  /[ᄀ-ᇿ⺀-⿟、-〿぀-ヿ㄀-ㄯ㄰-㆏㇀-ㇿ㐀-䶿一-鿿가-힯豈-﫿！-｠￠-￦]|[\uD840-\uD87F][\uDC00-\uDFFF]/g
const NON_ASIAN_WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['-][A-Za-z0-9À-ɏ]+)*/g

export function countWords(text: string): number {
  return (text.match(ASIAN_RE) ?? []).length + (text.match(NON_ASIAN_WORD_RE) ?? []).length
}

/** The selected text as one string: a line per paragraph. */
export const scopeText = (scope: SelectionScope): string =>
  scope.segments.map((segment) => segment.text).join('\n')

export function scopeOf(
  segments: AgentSegment[],
  inTable: boolean,
  contiguous: boolean,
): SelectionScope {
  return { segments, inTable, contiguous, key: JSON.stringify(segments) }
}

/** The excerpt shown with a sent message: one line, cut when long. */
export function scopeExcerpt(scope: SelectionScope): string {
  const flat = scopeText(scope).replace(/\s+/g, ' ').trim()
  return flat.length > SCOPE_TEXT_MAX ? `${flat.slice(0, SCOPE_TEXT_MAX)}…` : flat
}
