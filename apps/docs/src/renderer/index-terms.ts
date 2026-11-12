/**
 * The entries of a new index: each marked term once, blanks dropped, in the
 * alphabetical order of the document's language (Hangul in Korean order on a
 * Korean install, Han by the reading of a Japanese or Chinese one).
 */
export function indexTerms(terms: readonly string[], locale: string): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, locale),
  )
}
