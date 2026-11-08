/**
 * In-answer page citations: the model links pages as [p.N](pdfnav://page/N),
 * or down to a paragraph as [p.N](pdfnav://page/N?q=<words copied verbatim
 * from that page, URL-encoded>) (reading-assist spec 4.7). Clicking one
 * scrolls the reading view to that page and, with a quote, flashes the
 * passage where the text layer has it.
 */

export const PDF_NAV_SCHEME = 'pdfnav://'

/** where a citation link points: an original 1-based page, and the quoted words when given */
export interface PdfNavTarget {
  page: number
  quote?: string
}

/** a quote longer than this is cut (the instruction asks for 8 to 20 words) */
export const PDF_NAV_QUOTE_MAX_CHARS = 600

/**
 * pdfnav://page/N → { page: N }; pdfnav://page/N?q=… → { page: N, quote }.
 * Null for anything else (another scheme, another path, more parameters).
 * A quote whose encoding is broken is dropped and the link still goes to the
 * page. `+` reads as a space, as in a form-encoded query.
 */
export function parsePdfNavHref(href: string): PdfNavTarget | null {
  const m = /^pdfnav:\/\/page\/(\d+)(?:\?q=([^&#]*))?$/.exec(href)
  if (!m) return null
  const page = Number(m[1])
  if (!Number.isSafeInteger(page)) return null
  const raw = m[2]
  if (raw === undefined || raw === '') return { page }
  let quote: string
  try {
    quote = decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return { page }
  }
  quote = quote.replace(/\s+/g, ' ').trim()
  if (!quote) return { page }
  return {
    page,
    quote: quote.length > PDF_NAV_QUOTE_MAX_CHARS ? quote.slice(0, PDF_NAV_QUOTE_MAX_CHARS) : quote,
  }
}
