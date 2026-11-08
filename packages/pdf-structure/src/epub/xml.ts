/** XML text helpers: every string that reaches an EPUB file goes through these. */

/**
 * characters XML 1.0 does not allow (C0 controls other than tab / LF / CR,
 * lone surrogates, U+FFFE / U+FFFF). PDF text can carry them; they are dropped.
 */
const NOT_XML_CHAR = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu

export const xmlClean = (s: string): string => s.replace(NOT_XML_CHAR, '')

/** element text */
export const escapeText = (s: string): string =>
  xmlClean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** double-quoted attribute value */
export const escapeAttr = (s: string): string =>
  escapeText(s)
    .replace(/"/g, '&quot;')
    .replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`)

/** text with runs of whitespace collapsed (titles, alt text, nav labels) */
export const plainText = (s: string): string => xmlClean(s).replace(/\s+/g, ' ').trim()

/**
 * canonical BCP 47 tag, or undefined when the input is not one. Accepts the
 * `pt_BR` spelling some UI language codes use.
 */
export function languageTag(tag: string | undefined): string | undefined {
  const trimmed = tag?.trim().replace(/_/g, '-')
  if (!trimmed) return undefined
  try {
    return Intl.getCanonicalLocales(trimmed)[0]
  } catch {
    return undefined
  }
}

/** ` lang="x" xml:lang="x"` (XHTML requires both to match), or '' */
export function langAttrs(tag: string | undefined): string {
  const lang = languageTag(tag)
  return lang ? ` lang="${escapeAttr(lang)}" xml:lang="${escapeAttr(lang)}"` : ''
}

export const XHTML_NS = 'http://www.w3.org/1999/xhtml'
export const OPS_NS = 'http://www.idpf.org/2007/ops'

/** a complete XHTML content document */
export function xhtmlDocument(title: string, lang: string, body: string): string {
  const l = escapeAttr(lang)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE html>\n' +
    `<html xmlns="${XHTML_NS}" xmlns:epub="${OPS_NS}" lang="${l}" xml:lang="${l}">\n` +
    '<head>\n' +
    '<meta charset="UTF-8"/>\n' +
    `<title>${escapeText(plainText(title))}</title>\n` +
    '<link rel="stylesheet" type="text/css" href="style.css"/>\n' +
    '</head>\n' +
    `<body>\n${body}</body>\n` +
    '</html>\n'
  )
}
