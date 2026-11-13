import JSZip from 'jszip'
import { REDACT_NAMESPACES } from '@seuoffice/agent-core/redact-range'

/**
 * Whether a .docx holds content a person marked "hidden from AI", and a copy of
 * it with the marks taken off. For the writers of formats that cannot carry the
 * mark (an ODT written from a marked document reads as plain words to every
 * reader): they refuse, or write the copy without marks once the person agrees.
 *
 * A part is judged by the mark's traces in its XML, not by what the parser
 * makes of it: the namespace the mark is written in, or a `redact` element
 * under any prefix. A spelling the readers do not understand still counts, and
 * a trace inside a comment or CDATA is counted too: a false alarm asks the
 * person, a miss would write the words out.
 */

const WORD_PARTS = /^word\/.*\.xml$/
const NUMERIC_REFERENCE = /&#(?:x([0-9a-fA-F]+)|(\d+));/g
const MARK_ELEMENT = /<(?:[\w.-]+:)?redact[\s/>]/

function spelledOut(xml: string): string {
  if (!xml.includes('&#')) return xml
  return xml.replace(NUMERIC_REFERENCE, (all, hex: string | undefined, dec: string | undefined) => {
    const code = hex === undefined ? Number.parseInt(dec!, 10) : Number.parseInt(hex, 16)
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all
  })
}

/** a prefix bound to the mark's namespace: declared, and no sign of a mark by itself */
const NAMESPACE_DECLARATION = new RegExp(
  `\\sxmlns(?::[\\w.-]+)?\\s*=\\s*(?:"(?:${REDACT_NAMESPACES.map(escapeRegExp).join('|')})"|'(?:${REDACT_NAMESPACES.map(escapeRegExp).join('|')})')`,
  'g',
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function holdsMark(xml: string): boolean {
  const text = spelledOut(xml).replace(NAMESPACE_DECLARATION, '')
  return REDACT_NAMESPACES.some((ns) => text.includes(ns)) || MARK_ELEMENT.test(text)
}

async function wordParts(zip: JSZip): Promise<string[]> {
  return Object.keys(zip.files).filter((path) => WORD_PARTS.test(path) && !zip.files[path]!.dir)
}

/** Whether any part of the package (body, headers, footers, comments, notes) holds the mark. */
export async function docxHoldsHiddenContent(bytes: Uint8Array): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes)
  for (const path of await wordParts(zip)) {
    if (holdsMark(await zip.file(path)!.async('string'))) return true
  }
  return false
}

/** a mark element, self-closing or with an end tag, whose attribute values may hold `>` */
const MARK_TAG = new RegExp(
  '(?:<w:bdr\\s+w:val="single"\\s+w:sz="6"\\s+w:color="6B4FC0"\\s*/>\\s*)?' +
    '<(?:[\\w.-]+:)?redact(?:\\s(?:"[^"]*"|\'[^\']*\'|[^>"\'])*)?(?:/>|>\\s*</(?:[\\w.-]+:)?redact\\s*>)',
  'g',
)

/**
 * The package with every mark taken off: the words stay, readable by anyone.
 * The namespace declaration stays too (an ignorable prefix must stay declared).
 * The marks are cut out of each part as it is: the decoded copy only tells
 * whether a trace is left (a name never holds a reference, so every mark
 * element is found in the part's own bytes), and the rest of the part keeps
 * every byte, its character references included. Throws when a trace of the
 * mark is left in a part, so that a copy never claims to be clear when it is not.
 */
export async function clearHiddenMarks(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  for (const path of await wordParts(zip)) {
    const xml = await zip.file(path)!.async('string')
    if (!holdsMark(xml)) continue
    const cleared = xml.replace(MARK_TAG, '')
    if (holdsMark(cleared)) throw new Error(`could not clear the marks in ${path}`)
    zip.file(path, cleared)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
