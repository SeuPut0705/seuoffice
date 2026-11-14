// Host steps of the pure editors of epub-engine (crates/epub-engine blocks, edits): what the position-tracking
// parser of xml-positions.ts gives them, until that parser is ported.
import {
  parseXml,
  resolveHtmlEntity,
  type XmlElement,
  type XmlNode,
} from '../../packages/epub-engine/src/xml-positions'

const units = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
const fromUnits = (codes: readonly number[]): string => {
  let text = ''
  for (let i = 0; i < codes.length; i += 8192)
    text += String.fromCharCode(...codes.slice(i, i + 8192))
  return text
}

type WireChild =
  | { element: number }
  | { type: 'text'; start: number; end: number; value: number[]; cdata: boolean }
  | { type: 'comment' | 'pi'; start: number; end: number }

/**
 * `parseXml` with its tree written flat, so that no nesting reaches JSON: the elements in document order, each
 * naming its parent and its children by position (crates/epub-engine xml_positions_types `parse_result_from_wire`).
 */
export function parseXmlPositions(input: unknown): unknown {
  const { source: codes } = input as { source: number[] }
  const parsed = parseXml(fromUnits(codes))
  if (!parsed.ok) return { ok: false, error: parsed.error, offset: parsed.offset }
  const ids = new Map<XmlElement, number>()
  const order: XmlElement[] = []
  const stack: XmlElement[] = [parsed.doc.root]
  while (stack.length > 0) {
    const el = stack.pop()!
    ids.set(el, order.length)
    order.push(el)
    for (let i = el.children.length - 1; i >= 0; i--) {
      const child = el.children[i]!
      if (child.type === 'element') stack.push(child)
    }
  }
  const wireChild = (node: XmlNode): WireChild =>
    node.type === 'element'
      ? { element: ids.get(node)! }
      : node.type === 'text'
        ? {
            type: 'text',
            start: node.start,
            end: node.end,
            value: units(node.value),
            cdata: node.cdata,
          }
        : { type: node.type, start: node.start, end: node.end }
  const elements = order.map((el) => ({
    name: el.name,
    local: el.local,
    attributes: el.attributes.map((a) => ({ name: a.name, value: a.value })),
    start: el.start,
    startTagEnd: el.startTagEnd,
    endTagStart: el.endTagStart,
    end: el.end,
    selfClosing: el.selfClosing,
    parent: el.parent === null ? null : ids.get(el.parent)!,
    children: el.children.map(wireChild),
  }))
  return { ok: true, hasDoctype: parsed.doc.hasDoctype, root: 0, elements }
}

export const EPUB_PURE_STEPS: Record<string, (input: unknown) => unknown> = {
  parseXmlPositions,
  resolveHtmlEntity: (input) => resolveHtmlEntity((input as { name: string }).name) ?? null,
}
