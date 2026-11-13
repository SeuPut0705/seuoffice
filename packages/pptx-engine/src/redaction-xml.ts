/**
 * Reading and writing the "withheld from the model" marker.
 *
 * A span is a *mark over real words*, not a replacement for them: the deck and
 * the .pptx on disk keep the actual text, and only the model's view swaps it for
 * `{{label}}`. Losing the reader's own data to hide it from a model would be the
 * worse failure, so nothing here ever removes content.
 *
 * ## Why the marker has to be modelled
 *
 * The obvious idea is to leave the mark in the XML and let it ride along, the way
 * the engine already passes untouched `ByteAnchor.originalXml` through verbatim.
 * That works for a save that patches in place, and this engine was measured to
 * confirm it — but it breaks on the other path:
 *
 * - `patchTextElementXml` takes its **aligned** path when the model and the XML
 *   have the same number of runs, and patches each `<a:t>` in place. An
 *   `<a:extLst>` already inside `<a:rPr>` survives: the patcher rewrites the
 *   attributes it manages and keeps the rest of the node's inner XML.
 * - When the run count changes — splitting a run in half is exactly what marking
 *   half a word does — it falls through to `rebuildTxBody`, which regenerates
 *   `<a:txBody>` from the model. Anything the model does not carry is gone.
 *
 * So the mark is read into the model on parse and written back on save, in both
 * paths. The same measurement showed the visible half is not free either: the
 * patch path writes `u="none"` for a run whose model does not carry `underline`,
 * so the underline that shows the span has to be set by the caller as well.
 *
 * ## Where it lives
 *
 * `<a:extLst><a:ext uri="…"><go:redact label="…"/></a:ext></a:extLst>` inside
 * the run's `<a:rPr>`, or inside the element's `<p:spPr>` for a picture. `a:extLst`
 * is the OOXML extension list — the schema's own slot for things it does not
 * know — so PowerPoint round-trips the file without noticing, and fast-xml-parser
 * hands the label back on the way in (verified: no element whitelist, so the
 * node survives parsing).
 *
 * `w:bdr` in docx and an inline `<span data-redaction>` in markdown are the same
 * idea in their own formats; the underline here is the counterpart of the
 * character border there.
 */

import {
  asXmlNode,
  attributeOf,
  elementRange,
  escapeXmlAttr,
  xmlArray,
  type XmlNode,
} from './xml-utils'

/**
 * A fixed URI for our extension. Office's convention is that the `uri` is a
 * GUID identifying the extension's schema, so it must be stable: a deck that
 * round-trips through this engine has to land on the same value.
 */
export { REDACT_EL, REDACT_NS_WRITTEN, REDACT_PREFIX } from '@seuoffice/agent-core/redact-range'

import { REDACT_EL, REDACT_NS_WRITTEN, REDACT_PREFIX } from '@seuoffice/agent-core/redact-range'

export const REDACT_EXT_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'

/**
 * The whole extension node, for splicing into an `<a:extLst>`.
 *
 * The namespace is declared on the `a:ext` itself rather than on the part root:
 * `a:extLst` is OOXML's own extension point, and a consumer is required to skip
 * content in an `<a:ext>` whose `uri` it does not know, so no `mc:Ignorable` is
 * needed — only that the prefix resolves.
 */
export function redactExtXml(label: string): string {
  // `label` is deliberately unprefixed. A prefixed attribute lives in that
  // prefix's namespace, and this part is DrawingML: a `w:label` here would be a
  // second unbound prefix, the same parse error as the element's own.
  return (
    `<a:ext uri="${REDACT_EXT_URI}" xmlns:${REDACT_PREFIX}="${REDACT_NS_WRITTEN}">` +
    `<${REDACT_EL} label="${escapeXmlAttr(label)}"/></a:ext>`
  )
}

/** True when the fragment already carries our mark. */
export function hasRedactExtIn(xml: string): boolean {
  return ourExtRanges(xml).length > 0
}

/**
 * The label a SmartArt data part withholds its text under, or undefined when it
 * shows no trace of the mark. The shapes drawn for the diagram (its cached
 * drawing, or the layout made from the data) do not carry the data's marks, so
 * every word of the diagram is withheld under the first label the data names
 * (`private` when none can be read): a trace counts, whatever its spelling.
 */
export function diagramDataRedactLabel(dataXml: string | undefined): string | undefined {
  if (!dataXml) return undefined
  const text = dataXml.replace(
    /&#(?:x([0-9a-fA-F]+)|(\d+));/g,
    (all, hex?: string, dec?: string) => {
      const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16)
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all
    },
  )
  if (!text.includes(REDACT_EXT_URI) && !/<(?:[\w.-]+:)?redact[\s/>]/.test(text)) return undefined
  const label = /<(?:[\w.-]+:)?redact\b[^>]*?\slabel\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text)
  const value = label?.[1] ?? label?.[2]
  return value ? value : 'private'
}

/**
 * Sync our mark on the element named `tag` inside `xml` — `a:rPr` for a run, the
 * picture's `p:spPr` for media. A `label` of undefined removes it.
 *
 * Both save paths call this: the aligned patch path, which would otherwise leave
 * a mark the model no longer claims, and the rebuild path, which has just
 * regenerated the node from the model and needs the mark put back.
 */
export function syncRedactExt(xml: string, tag: string, label?: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[^>]*?>[\\s\\S]*?</${tag}>`).exec(xml)
  if (!open) return xml
  const next = label ? setRedactExt(open[0], label) : stripRedactExt(open[0])
  if (next === open[0]) return xml
  return xml.slice(0, open.index) + next + xml.slice(open.index + open[0].length)
}

/**
 * One `<a:ext>` matching our URI among the node's own extension lists, or null. A node should
 * hold one list; a deck that holds two parses as an array, and reading it as a single node
 * would miss a mark in either and hand the words to the model.
 */
function ourExt(extLst: unknown): XmlNode | null {
  for (const list of xmlArray(extLst)) {
    for (const ext of xmlArray(list['a:ext'])) {
      if (ext['@_uri'] === REDACT_EXT_URI) return ext
    }
  }
  return null
}

/** The label, read out of an already-parsed `<a:rPr>` / `<p:spPr>` node. */
export function readRedactLabel(node: unknown): string | undefined {
  const ext = ourExt(asXmlNode(node)['a:extLst'])
  if (!ext) return undefined
  // the engine writes go:redact; another writer may use another prefix or none
  // (the namespace declared on the mark or around it). Our extension exists only
  // to carry the mark, so one whose label cannot be read still withholds.
  const key = Object.keys(ext).find((k) => k === REDACT_EL || /^(?:[\w.-]+:)?redact$/.test(k))
  const label = key === undefined ? undefined : asXmlNode(ext[key])['@_label']
  return typeof label === 'string' && label !== '' ? label : 'private'
}

const EXT_OPEN = /<a:ext\b(?:[^>"']|"[^"]*"|'[^']*')*>/g

/**
 * Where each of our `<a:ext>` lies in raw XML, self-closing or paired, in document order. An
 * extension is ours by its `uri` as XML reads it (`attributeOf`: any quotes, any white space
 * around `=`, references decoded), which is how the parser finds it on the way in: a writer
 * that looked for one spelling kept a mark the user cleared, or wrote a second one beside it.
 */
function ourExtRanges(xml: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const open of xml.matchAll(EXT_OPEN)) {
    if (open.index < (out.at(-1)?.end ?? 0)) continue
    if (attributeOf(open[0], 'uri') !== REDACT_EXT_URI) continue
    const ext = elementRange(xml, 'a:ext', open.index)
    if (ext) out.push({ start: ext.start, end: ext.end })
  }
  return out
}

/** `xml` without the ranges, which are in document order and do not overlap. */
function without(xml: string, ranges: { start: number; end: number }[]): string {
  let out = ''
  let at = 0
  for (const range of ranges) {
    out += xml.slice(at, range.start)
    at = range.end
  }
  return out + xml.slice(at)
}

/** Remove our extension from a raw `<a:rPr>` / `<p:spPr>` string, leaving everything else. */
export function stripRedactExt(xml: string): string {
  let out = xml
  // last first, so the offsets of the earlier ones stay valid
  for (const ours of ourExtRanges(xml).reverse()) {
    let start = ours.start
    let end = ours.end
    // The list goes with it only when our extension was all it held: an apply/unapply cycle
    // would otherwise leave an empty <a:extLst> behind, and they would accumulate in a deck
    // someone toggles marks in. A list that still holds another extension, and every list we
    // were never in, keeps its bytes, attributes included.
    const open = /<a:extLst\b[^>]*>\s*$/.exec(out.slice(0, start))
    const close = /^\s*<\/a:extLst\s*>/.exec(out.slice(end))
    if (open && close) {
      start = open.index
      end += close[0].length
    }
    out = out.slice(0, start) + out.slice(end)
  }
  return collapseEmptyProps(out)
}

/**
 * Adding the mark gives a self-closing `<a:rPr/>` the paired form it needs;
 * take it back once the mark is gone, so toggling leaves no trace. Only an
 * empty node is collapsed — one that still holds a child keeps its form.
 */
function collapseEmptyProps(xml: string): string {
  return xml.replace(
    /<([\w:]+)\b([^>]*?)>([\s\S]*?)<\/\1>/g,
    (all, tag: string, attrs: string, inner: string) =>
      inner.trim() ? all : `<${tag}${attrs.replace(/\s+$/, '')}/>`,
  )
}

/**
 * Put the mark in a raw `<a:rPr>` (or `<p:spPr>`) string, replacing any previous one.
 *
 * The `inner` of the node is preserved verbatim; only our own extension is added
 * or swapped. A self-closing `<a:rPr/>` gains a paired form because the mark
 * needs a child.
 */
export function setRedactExt(propsXml: string, label: string): string {
  const ext = redactExtXml(label)
  const open = /<([\w:]+)\b[^>]*?(\/?)>/.exec(propsXml)
  if (!open) return propsXml
  const [whole, tag, selfClose] = open
  const at = open.index
  if (selfClose === '/') {
    // self-closing: the mark needs a child, so it gains a paired form
    const head = whole.slice(0, -2) + '>'
    return (
      propsXml.slice(0, at) +
      `${head}<a:extLst>${ext}</a:extLst></${tag}>` +
      propsXml.slice(at + whole.length)
    )
  }
  const close = `</${tag}>`
  const closeAt = propsXml.lastIndexOf(close)
  if (closeAt === -1) return propsXml
  const inner = propsXml.slice(at + whole.length, closeAt)
  return (
    propsXml.slice(0, at) +
    whole +
    spliceExtLst(inner, ext) +
    close +
    propsXml.slice(closeAt + close.length)
  )
}

/**
 * The node's inner XML with the mark in the node's OWN extension list, replacing any mark already
 * in the node.
 *
 * The own list is the node's last child (both schemas put extLst last), and it is the only one
 * the reader looks in. A list earlier in the node belongs to a child: PowerPoint gives
 * <a:hlinkClick> one for the hyperlink colour, and an outline can carry one. Taking "the first
 * extLst in the node" put the mark there, where it was written and never read back, so the words
 * stopped being withheld once the deck was reopened.
 */
function spliceExtLst(inner: string, ext: string): string {
  // a mark already in the node goes first, wherever it sits, so a re-apply replaces it
  const kept = without(inner, ourExtRanges(inner))
  const body = kept.trimEnd()
  const tail = kept.slice(body.length)
  // the last thing in the node closes its last child, so a list ending here is the node's own
  const close = /<\/a:extLst\s*>$/.exec(body)
  if (close) return body.slice(0, close.index) + ext + body.slice(close.index) + tail
  const selfClosing = /<a:extLst\b[^>]*\/>$/.exec(body)
  if (selfClosing) {
    const head = selfClosing[0].slice(0, -2)
    return `${body.slice(0, selfClosing.index)}${head}>${ext}</a:extLst>${tail}`
  }
  // no list of its own: extLst is the last child both schemas allow here — prepending it
  // before a:solidFill/a:latin/a:xfrm is a strict-validation failure
  return `${kept}<a:extLst>${ext}</a:extLst>`
}
