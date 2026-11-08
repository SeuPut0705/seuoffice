import { placeholderSource } from '@genoffice/agent-core/redact-core'
import { REDACT_EL, REDACT_NS } from '@genoffice/agent-core/redact-range'
import { RedactionMarkError } from './redaction-error'

/**
 * Withheld runs of a deck, read as another file's material.
 *
 * The deck engine stores the mark as
 * `<a:extLst><a:ext uri="…"><go:redact label="…"/></a:ext></a:extLst>` inside a
 * run's `<a:rPr>` (a field's too: it is parsed as a run), or inside a picture's
 * `<p:spPr>` (packages/pptx-engine `redaction-xml.ts`). The slide editor hands
 * its own model `{{label}}` for such a run and no reference at all for such a
 * picture. This package cannot import the engine, so the shape is restated here;
 * a test holds the extension id against the engine's own constant.
 *
 * The work is done on the part's XML before the text walker in pptx.ts parses
 * it: a withheld run is rewritten to a run holding only its marker, so nothing
 * the run carried can reach the output whatever the walker collects. A picture
 * has no words to rewrite; its mark only has to be one this reader understands.
 *
 * Every trace of the mark in a part has to be accounted for by a run or a
 * picture read that way. One that is not (no label, the wrong parent, markup
 * that does not close) throws, and the deck is not read.
 */

/** the engine's REDACT_EXT_URI: the `uri` of the `<a:ext>` that carries the mark */
export const PPTX_REDACT_EXT_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'

interface XmlElement {
  name: string
  attrs: Map<string, string>
  parent: XmlElement | null
  children: XmlElement[]
  /** offset of `<` */
  start: number
  /** offset just past the start tag's `>` */
  openEnd: number
  /** offset of the end tag's `<`; equals `openEnd` for a self-closing element */
  closeStart: number
  selfClosing: boolean
}

const malformed = () => new RedactionMarkError('the XML around a mark is not well-formed')

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g,
    (all, hex, dec, named) => {
      if (named) return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[named as string] ?? all
      const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16)
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all
    },
  )
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const NAME_END = /[\s/>=]/

/** one start tag: its name, its attributes and where it ends */
function readStartTag(
  xml: string,
  at: number,
): { name: string; attrs: Map<string, string>; end: number; selfClosing: boolean } {
  let i = at + 1
  while (i < xml.length && !NAME_END.test(xml[i]!)) i++
  const name = xml.slice(at + 1, i)
  if (!name) throw malformed()
  const attrs = new Map<string, string>()
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i]!)) i++
    if (i >= xml.length) throw malformed()
    if (xml[i] === '>') return { name, attrs, end: i + 1, selfClosing: false }
    if (xml[i] === '/') {
      if (xml[i + 1] !== '>') throw malformed()
      return { name, attrs, end: i + 2, selfClosing: true }
    }
    const nameStart = i
    while (i < xml.length && !NAME_END.test(xml[i]!)) i++
    const attr = xml.slice(nameStart, i)
    while (i < xml.length && /\s/.test(xml[i]!)) i++
    if (!attr || xml[i] !== '=') throw malformed()
    i++
    while (i < xml.length && /\s/.test(xml[i]!)) i++
    const quote = xml[i]
    if (quote !== '"' && quote !== "'") throw malformed()
    const close = xml.indexOf(quote, i + 1)
    if (close < 0) throw malformed()
    // a repeated attribute is not well-formed; the first one stands
    if (!attrs.has(attr)) attrs.set(attr, decodeEntities(xml.slice(i + 1, close)))
    i = close + 1
  }
}

function skipPast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from)
  if (end < 0) throw malformed()
  return end + terminator.length
}

/** every element of the part with its source offsets; throws on markup that does not balance */
function scanElements(xml: string): XmlElement[] {
  const all: XmlElement[] = []
  const open: XmlElement[] = []
  let i = xml.indexOf('<')
  while (i >= 0) {
    if (xml.startsWith('<!--', i)) i = skipPast(xml, i + 4, '-->')
    else if (xml.startsWith('<![CDATA[', i)) i = skipPast(xml, i + 9, ']]>')
    else if (xml.startsWith('<?', i)) i = skipPast(xml, i + 2, '?>')
    else if (xml.startsWith('<!', i)) i = skipPast(xml, i + 2, '>')
    else if (xml[i + 1] === '/') {
      const end = xml.indexOf('>', i)
      const el = open.pop()
      if (end < 0 || !el || xml.slice(i + 2, end).trim() !== el.name) throw malformed()
      el.closeStart = i
      i = end + 1
    } else {
      const tag = readStartTag(xml, i)
      const parent = open[open.length - 1] ?? null
      const el: XmlElement = {
        name: tag.name,
        attrs: tag.attrs,
        parent,
        children: [],
        start: i,
        openEnd: tag.end,
        closeStart: tag.end,
        selfClosing: tag.selfClosing,
      }
      parent?.children.push(el)
      all.push(el)
      if (!tag.selfClosing) open.push(el)
      i = tag.end
    }
    i = xml.indexOf('<', i)
  }
  if (open.length > 0) throw malformed()
  return all
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The label a mark carries, read the way the engine reads it: the one label
 * element directly inside our extension, with a label that is not empty.
 */
function labelOf(ext: XmlElement): string {
  const marks = ext.children.filter((c) => c.name === REDACT_EL)
  const label = marks.length === 1 ? marks[0]!.attrs.get('label') : undefined
  if (ext.children.length !== 1 || !label) {
    throw new RedactionMarkError('a mark carries no label')
  }
  return label
}

/** the element whose properties hold this extension list entry, or null */
function propsOf(ext: XmlElement): XmlElement | null {
  return ext.parent?.name === 'a:extLst' ? ext.parent.parent : null
}

/**
 * One slide or notes part with every withheld run rewritten to its `{{label}}`
 * marker. A part with no trace of the mark is returned as it came, unparsed.
 */
export function redactPptxPartXml(xml: string): string {
  if (!xml.includes(PPTX_REDACT_EXT_URI) && !xml.includes(REDACT_EL) && !xml.includes(REDACT_NS)) {
    return xml
  }
  const runs = new Map<XmlElement, string>()
  let understood = 0
  for (const el of scanElements(xml)) {
    if (el.name !== 'a:ext' || el.attrs.get('uri') !== PPTX_REDACT_EXT_URI) continue
    const label = labelOf(el)
    const props = propsOf(el)
    const owner = props?.parent
    if (props?.name === 'a:rPr' && (owner?.name === 'a:r' || owner?.name === 'a:fld')) {
      // the first mark on a run names it, as it does for the engine
      if (!runs.has(owner)) runs.set(owner, label)
    } else if (
      // a picture has no words, and neither has the paragraph mark the engine
      // reads as an empty run: both are understood, with nothing to rewrite
      !(props?.name === 'p:spPr' && owner?.name === 'p:pic') &&
      !(props?.name === 'a:endParaRPr' && owner?.name === 'a:p')
    ) {
      throw new RedactionMarkError('a mark sits where no run or picture carries one')
    }
    understood++
  }
  // one extension, one label element, one namespace at most per mark: a trace
  // left over is a mark that was not read above (a label under someone else's
  // extension, the namespace under another prefix, a mark inside a comment)
  if (
    countOf(xml, PPTX_REDACT_EXT_URI) !== understood ||
    countOf(xml, `<${REDACT_EL}`) !== understood ||
    countOf(xml, REDACT_NS) > understood
  ) {
    throw new RedactionMarkError('a mark is written in a form that cannot be read')
  }
  const out: string[] = []
  let cursor = 0
  for (const [run, label] of [...runs].sort((a, b) => a[0].start - b[0].start)) {
    // a marked run inside another marked run (not valid DrawingML): rewriting
    // both would move backwards and leave the inner words in the part
    if (run.start < cursor) throw new RedactionMarkError('a marked run sits inside another')
    // the whole inside of the run goes: its properties are of no use to a text
    // reader, and anything else it holds is not this reader's to pass on
    out.push(xml.slice(cursor, run.openEnd), `<a:t>${escapeText(placeholderSource(label))}</a:t>`)
    cursor = run.closeStart
  }
  out.push(xml.slice(cursor))
  return out.join('')
}
