// Run-level wrapper elements the run model has no field for (w:sdt,
// w:smartTag, w:customXml, w:dir, w:bdo). The bytes of a wrapper that holds
// runs ride on those runs (Run.wrap), opaque to the model, so a rebuilt
// paragraph writes the wrapper back around them. A wrapper that holds no run
// and the text-less markers of a paragraph (w:permStart, the customXml range
// markers, w:subDoc) are not carried: bookmarks and comment ranges are kept on
// the block, move ranges are rebuilt from the move's name, proofing marks are
// Word's to recompute, and the rest stays out of the model as it always did.
import type { InlineWrap, Run } from './types'
import { type XNode } from './xml-utils'
import { invoke } from './engine'

// ---- which bytes may be carried: one strict, positive check ----
//
// The same check decides what the parser puts on a run and what the writer
// takes from one. A run list can come from a co-editing peer, so the writer
// cannot assume the parser made it; and what the parser carries must be
// writable, so it never carries bytes the writer would refuse.

/** prefix -> namespace URI, as the root element of a part declares them */
export type PartNamespaces = ReadonlyMap<string, string>
/** one element of the scanned xml: the byte ranges of its tags and its element children */
export interface RawElement {
  name: string
  start: number
  /** end of the opening tag */
  openEnd: number
  /** start of the closing tag (= end for a self-closing element) */
  closeStart: number
  end: number
  selfClosing: boolean
  children: RawElement[]
}
export function rawElements(xml: string, skipNonElements = false): RawElement[] {
  // Pairing a parse tree cannot skip these (its element children differ).
  // The save-time byte scanner may skip them without losing offsets.
  if (!skipNonElements && (xml.includes('<!') || xml.includes('<?'))) return []
  const roots: RawElement[] = []
  const stack: RawElement[] = []
  const tagRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[2] === undefined) continue
    const end = m.index + m[0].length
    if (m[1] === '/') {
      const el = stack.pop()
      if (!el || el.name !== m[2]) return []
      el.closeStart = m.index
      el.end = end
      continue
    }
    const selfClosing = m[3].endsWith('/')
    const el: RawElement = {
      name: m[2],
      start: m.index,
      openEnd: end,
      closeStart: end,
      end,
      selfClosing,
      children: [],
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else roots.push(el)
    if (!selfClosing) stack.push(el)
  }
  return stack.length === 0 ? roots : []
}
/**
 * The source text a parse tree came from, with the byte range of each of its
 * elements. Wrapper bytes are sliced from it; without one (or for
 * an element that does not line up with the text) the serialized parse tree
 * stands in, which keeps the meaning but not the exact bytes.
 */
export interface InlineRawSource {
  readonly xml: string
  of(node: XNode): RawElement | undefined
}
/** two runs sit in the same wrapper element */
export function sameInlineWrap(a: InlineWrap | undefined, b: InlineWrap | undefined): boolean {
  return invoke('sameInlineWrap', [a, b]) as never
}
/** two runs sit in the same chain of wrapper elements */
export function sameInlineWrapChain(
  a: readonly InlineWrap[] | undefined,
  b: readonly InlineWrap[] | undefined,
): boolean {
  return invoke('sameInlineWrapChain', [a, b]) as never
}
/**
 * The wrapper is a content control whose content may not be edited
 * (w:lock contentLocked / sdtContentLocked in its own w:sdtPr).
 */
export function inlineWrapContentLocked(wrap: InlineWrap): boolean {
  return invoke('inlineWrapContentLocked', [wrap]) as never
}
// ---- where a rebuilt paragraph writes each wrapper ----

/** the wrappers of one run by the depth they are written at: outside its
 *  revision element, inside it (outside the hyperlink), inside the hyperlink */
export type PlacedWraps = [InlineWrap[], InlineWrap[], InlineWrap[]]
// ---- runs copied out of their paragraph ----

/**
 * A run as it goes into ANOTHER paragraph or document (a mail-merge record
 * after the first, the other side of a comparison): a content control carries
 * an id that belongs to the original, so the copy goes without it.
 */
export function runCopiedElsewhere(run: Run): Run {
  return invoke('runCopiedElsewhere', [run]) as never
}