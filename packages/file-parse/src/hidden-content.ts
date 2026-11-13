import type JSZip from 'jszip'
import { callEngine } from './engine'

/**
 * Whether a file holds content a person hid from AI, read from its bytes only:
 * for a writer that would copy it into a form no placeholder can stand in for
 * (a printed page, a picture, a repackaged file), so that it refuses before it
 * starts. Only whether a mark is there is read, never what it hides. A part is
 * judged by the mark's traces in its text (the namespace the mark is written
 * in, a `redact` element, the deck extension's id), so a spelling the readers
 * do not understand still counts.
 */

/** Whether a package part's XML shows a trace of the mark (docx run mark, deck extension). */
export function xmlHoldsMark(xml: string): boolean {
  return callEngine<boolean>('xmlHoldsMark', [xml])
}

/** Whether a Markdown file's text holds a span hidden from AI. */
export function markdownHoldsMark(text: string): boolean {
  return callEngine<boolean>('markdownHoldsMark', [text])
}

/** Whether an HTML page's text holds any mark of the HTML app. */
export function htmlHoldsMark(text: string): boolean {
  return callEngine<boolean>('htmlHoldsMark', [text])
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
 * route that reads it fails as it always did. A package past the zip limits
 * throws.
 */
export async function fileHoldsHiddenContent(bytes: Uint8Array, ext: string): Promise<boolean> {
  return callEngine<boolean>('fileHoldsHiddenContent', [bytes, ext])
}
