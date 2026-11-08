/**
 * What the outline writer (`outline.ts`) and the outline reader
 * (`outline-parse.ts`) must agree on.
 */

/** The marks that say what an item is when it is not an ordinary branch. */
export const OUTLINE_KIND_MARKS = {
  summary: '(summary)',
  callout: '(callout)',
  floating: '(floating)',
  other: '(other)',
  boundary: '(boundary)',
  relationship: '(relationship)',
} as const

export type OutlineKind = keyof typeof OUTLINE_KIND_MARKS

/** Splits text into lines the way markdown does. */
export const LINE_BREAK = /\r\n|\r|\n/

const KIND_MARKS: readonly string[] = Object.values(OUTLINE_KIND_MARKS)

/**
 * How many characters at the start of a list item's text are a kind mark and
 * the blanks after it; 0 when the text does not start with one. A mark counts
 * only when a blank or the end of the text follows it.
 */
export function kindMarkLength(text: string): number {
  if (text[0] !== '(') return 0
  const mark = KIND_MARKS.find((candidate) => text.startsWith(candidate))
  if (mark === undefined) return 0
  let end = mark.length
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
  return end === mark.length && end < text.length ? 0 : end
}
