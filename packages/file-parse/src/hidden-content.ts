import JSZip from 'jszip'
import { REDACT_NAMESPACES } from '@seuoffice/agent-core/redact-range'
import { PPTX_REDACT_EXT_URI } from './pptx-redaction'
import { RedactionMarkError } from './redaction-error'
import { xlsxWithheldCells } from './xlsx'

/**
 * Whether a file holds content a person hid from AI, read from its bytes only:
 * for a writer that would copy it into a form no placeholder can stand in for
 * (a printed page, a picture, a repackaged file), so that it refuses before it
 * starts. Only whether a mark is there is read, never what it hides. A part is
 * judged by the mark's traces in its text (the namespace the mark is written
 * in, a `redact` element, the deck extension's id), so a spelling the readers
 * do not understand still counts.
 */

const NUMERIC_REFERENCE = /&#(?:x([0-9a-fA-F]+)|(\d+));/g

/** the text with numeric references spelled out, so a reference cannot hide a namespace */
function spelledOut(xml: string): string {
  if (!xml.includes('&#')) return xml
  return xml.replace(NUMERIC_REFERENCE, (all, hex: string | undefined, dec: string | undefined) => {
    const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16)
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all
  })
}

/** Whether a package part's XML shows a trace of the mark (docx run mark, deck extension). */
export function xmlHoldsMark(xml: string): boolean {
  const text = spelledOut(xml)
  return (
    REDACT_NAMESPACES.some((ns) => text.includes(ns)) ||
    text.includes(PPTX_REDACT_EXT_URI) ||
    /<(?:[\w.-]+:)?redact[\s/>]/.test(text)
  )
}

/** the HTML app's three marks: an element, an attribute's value, a script literal (apps/html marked-html.ts) */
const HTML_MARK = /data-gx-redact|gx:redact:/i
/** the markdown app's persisted span (apps/markdown editor/Redaction.ts) */
const MARKDOWN_MARK = /<span\b[^>]*\bdata-redaction\b/i

/** Whether a Markdown file's text holds a span hidden from AI. */
export function markdownHoldsMark(text: string): boolean {
  return MARKDOWN_MARK.test(text)
}

/** Whether an HTML page's text holds any mark of the HTML app. */
export function htmlHoldsMark(text: string): boolean {
  return HTML_MARK.test(text)
}

/**
 * The text of a page or Markdown file as far as the marks need it: they are
 * ASCII, so any ASCII-compatible charset reads them as Latin-1 does; a UTF-16
 * file is decoded by its byte order mark.
 */
function markText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  return new TextDecoder('latin1').decode(bytes)
}

/** Whether any of a package's parts under `pattern` shows a trace of the mark. */
export async function packageHoldsMark(zip: JSZip, pattern: RegExp): Promise<boolean> {
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !pattern.test(path)) continue
    if (xmlHoldsMark(await entry.async('string'))) return true
  }
  return false
}

/** the formats whose files can hold the mark, by extension */
export const HIDDEN_CONTENT_EXTENSIONS: readonly string[] = [
  'docx',
  'pptx',
  'xlsx',
  'xlsm',
  'md',
  'markdown',
  'html',
  'htm',
]

/**
 * Whether a file with extension `ext` (no dot) holds content hidden from AI.
 * Every part a writer may copy counts (a document's comments and notes, every
 * part of a deck). A workbook whose record cannot be read counts as holding
 * some. A file that is not the package its extension says holds no mark: the
 * route that reads it fails as it always did.
 */
export async function fileHoldsHiddenContent(bytes: Uint8Array, ext: string): Promise<boolean> {
  const kind = ext.toLowerCase().replace(/^\./, '')
  if (!HIDDEN_CONTENT_EXTENSIONS.includes(kind)) return false
  if (kind === 'md' || kind === 'markdown') return markdownHoldsMark(markText(bytes))
  if (kind === 'html' || kind === 'htm') return htmlHoldsMark(markText(bytes))
  if (kind === 'xlsx' || kind === 'xlsm') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
    try {
      return (await xlsxWithheldCells(bytes)) !== null
    } catch (err) {
      if (err instanceof RedactionMarkError) return true
      throw err
    }
  }
  const zip = await JSZip.loadAsync(bytes).catch(() => null)
  if (!zip) return false
  return packageHoldsMark(zip, kind === 'docx' ? /^word\/.*\.xml$/ : /^ppt\/.*\.xml$/)
}
