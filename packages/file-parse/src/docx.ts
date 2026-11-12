import { callEngine } from './engine'

export interface DocxTextOptions {
  /** stop once this many characters have been collected (the caller slices anyway) */
  maxChars?: number
}

/**
 * Flatten a docx into readable text (structure markers preserved): headings as
 * `# `, list items as `- `, table rows as `a | b`, footnotes, endnotes, headers,
 * footers and comments under their own headings. Reads only the XML parts it
 * needs, behind the zip gate.
 */
export async function docxToText(bytes: Uint8Array, opts: DocxTextOptions = {}): Promise<string> {
  return callEngine<string>('docxToText', [bytes, opts])
}
