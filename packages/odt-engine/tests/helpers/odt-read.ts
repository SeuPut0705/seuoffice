/**
 * Reading a saved ODT without the engine's internals: the paragraphs of its
 * body come from re-opening it with the public API (the bridge map records
 * every paragraph's range, style and text), the style definitions are read
 * straight out of the XML.
 */
import { odtToDocx } from '../../src'

export interface WrittenParagraph {
  /** the paragraph's exact XML in content.xml */
  xml: string
  /** the text the docx engine reads from the bridge paragraph */
  text: string
  style: string | null
  /** `text:p` or `text:h` */
  name: string
}

/** Every body paragraph of a saved ODT in document order (notes, comments and headers aside). */
export async function paragraphsOf(saved: {
  odt: Uint8Array
  content: string
}): Promise<WrittenParagraph[]> {
  const { bridge } = await odtToDocx(saved.odt)
  return bridge.paragraphs
    .filter((p) => p.part === 'content.xml' && p.block !== null)
    .map((p) => ({
      xml: saved.content.slice(p.start, p.end),
      text: p.text,
      style: p.styleName,
      name: p.element,
    }))
}

const decode = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2])
  return out
}

export interface StyleRecord {
  name: string | null
  family: string | null
  parentName: string | null
  masterPageName: string | null
  /** attributes of each `style:*-properties` child, by element name */
  properties: Record<string, Record<string, string>>
  /** attributes of each `style:tab-stop`, null when the style has no `style:tab-stops` */
  tabStops: Array<Record<string, string>> | null
  /** the element's exact XML */
  xml: string
}

function record(xml: string, at: number, open: string, element: string): StyleRecord {
  const attrs = attributes(open)
  const end = open.endsWith('/>')
    ? at + open.length
    : xml.indexOf(`</${element}>`, at) + `</${element}>`.length
  const text = xml.slice(at, end)
  const properties: StyleRecord['properties'] = {}
  for (const m of text.matchAll(/<(style:[\w-]+-properties)\b[^>]*>/g))
    properties[m[1]] ??= attributes(m[0])
  return {
    name: attrs['style:name'] ?? null,
    family: attrs['style:family'] ?? null,
    parentName: attrs['style:parent-style-name'] ?? null,
    masterPageName: attrs['style:master-page-name'] ?? null,
    properties,
    tabStops: text.includes('<style:tab-stops')
      ? [...text.matchAll(/<style:tab-stop\b[^>]*>/g)].map((m) => attributes(m[0]))
      : null,
    xml: text,
  }
}

/** The first `style:style` of a part with this name (and family). */
export function findStyle(xml: string, name: string, family?: string): StyleRecord | undefined {
  for (const m of xml.matchAll(/<style:style\b[^>]*>/g)) {
    const attrs = attributes(m[0])
    if (attrs['style:name'] === name && (family === undefined || attrs['style:family'] === family))
      return record(xml, m.index, m[0], 'style:style')
  }
  return undefined
}

/** The `style:default-style` of a family. */
export function findDefaultStyle(xml: string, family: string): StyleRecord | undefined {
  for (const m of xml.matchAll(/<style:default-style\b[^>]*>/g))
    if (attributes(m[0])['style:family'] === family)
      return record(xml, m.index, m[0], 'style:default-style')
  return undefined
}

/** The levels of a `text:list-style`, or undefined when the part has none of that name. */
export function findListStyle(
  xml: string,
  name: string,
): Array<{ kind: 'number' | 'bullet' | 'image'; attrs: Record<string, string> }> | undefined {
  for (const m of xml.matchAll(/<text:list-style\b[^>]*>/g)) {
    if (attributes(m[0])['style:name'] !== name) continue
    const end = xml.indexOf('</text:list-style>', m.index)
    return [
      ...xml.slice(m.index, end).matchAll(/<text:list-level-style-(number|bullet|image)\b[^>]*>/g),
    ].map((l) => ({ kind: l[1] as 'number' | 'bullet' | 'image', attrs: attributes(l[0]) }))
  }
  return undefined
}
