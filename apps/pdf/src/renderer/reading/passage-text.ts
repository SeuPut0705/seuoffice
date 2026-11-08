/**
 * The text a passage card is built from (reading-assist spec 4.2): the dedup
 * hash of the selected passage and the text around it on the same page, as
 * the PDF.js text layer reads it. Pure.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { sha256Hex } from '../../../../../packages/pdf-structure/src/tree/hash'

/** characters of surrounding text sent with a passage, before and after together */
export const PASSAGE_CONTEXT_MAX_CHARS = 1500

/** the selected passage is cut to this many characters before it is sent */
export const PASSAGE_EXCERPT_MAX_CHARS = 4000

/** NFC, whitespace runs collapsed to one space, trimmed */
export function normalizePassage(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** SHA-256 hex of the normalized passage: the dedup key with page fingerprint, kind and language */
export function passageHash(text: string): string {
  return sha256Hex(normalizePassage(text))
}

/**
 * The page text before and after the passage, `max` characters at most in
 * total, split evenly; a side with less text leaves its share to the other.
 * Whitespace is compared collapsed, so a passage selected across line breaks
 * is found. A passage the page text does not contain gets the start of the
 * page as its context.
 */
export function passageContext(
  pageText: string,
  excerpt: string,
  max: number = PASSAGE_CONTEXT_MAX_CHARS,
): { before: string; after: string } {
  const page = normalizePassage(pageText)
  const needle = normalizePassage(excerpt)
  const at = needle ? page.indexOf(needle) : -1
  if (at < 0) return { before: page.slice(0, max).trim(), after: '' }
  const head = page.slice(0, at).trimEnd()
  const tail = page.slice(at + needle.length).trimStart()
  const half = Math.floor(max / 2)
  // each side gets half; the unused share of one side goes to the other
  const beforeLen = Math.min(head.length, max - Math.min(tail.length, max - half))
  const afterLen = Math.min(tail.length, max - beforeLen)
  return {
    before: beforeLen > 0 ? head.slice(head.length - beforeLen) : '',
    after: tail.slice(0, afterLen),
  }
}

/**
 * An original page's text as the PDF.js text layer reads it ('' when it
 * cannot be read). The page proxy is the one the view draws, so it is not
 * cleaned up here: that would drop a visible page's parsed resources.
 */
export async function readPageText(doc: PDFDocumentProxy, origIdx: number): Promise<string> {
  if (origIdx < 0 || origIdx >= doc.numPages) return ''
  const page = await doc.getPage(origIdx + 1)
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if ('str' in item) {
      text += item.str
      if (item.hasEOL) text += '\n'
    }
  }
  return text
}
