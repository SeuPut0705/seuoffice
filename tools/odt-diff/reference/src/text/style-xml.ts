/**
 * Narrow string edits of one ODF style element: rename, re-parent, set or
 * remove attributes of its property elements, replace its tab-stop list.
 * Everything the edit does not name keeps its exact bytes — this is how a new
 * automatic style "inherits" ALL properties of the original one (tab stops,
 * Hancom attributes, unknown children) and overrides only what changed.
 */
import { applyTextPatches, type TextPatch } from '../core/convert'
import { type PrefixMap, escapeXmlAttr, readAttributes, walkElements } from '../core/xml'
import type { AttrOverrides } from './props'

export interface StyleXmlEdit {
  /** new `style:name` */
  name?: string
  /** new `style:parent-style-name`; null removes it */
  parent?: string | null
  /** attributes of the style element to set (value) or remove (null) */
  attrs?: AttrOverrides
  /** property element (`style:paragraph-properties` …) → attribute overrides */
  props?: Record<string, AttrOverrides>
  /** new inner XML of `style:paragraph-properties/style:tab-stops` */
  tabStops?: string
}

/** Schema order of property elements inside `style:style`. */
const PROPERTY_ORDER = [
  'style:graphic-properties',
  'style:drawing-page-properties',
  'style:paragraph-properties',
  'style:text-properties',
  'style:ruby-properties',
  'style:section-properties',
  'style:table-properties',
  'style:table-column-properties',
  'style:table-row-properties',
  'style:table-cell-properties',
  'style:chart-properties',
]

const local = (xml: string, edits: Array<{ start: number; end: number; xml: string }>) =>
  applyTextPatches(
    xml,
    edits.map((e) => ({ part: 'content.xml', ...e }) as TextPatch),
  )

/** Applies attribute overrides to one start tag (`<x a="1" …>` or `<x …/>`). */
export function patchStartTag(tag: string, prefixes: PrefixMap, overrides: AttrOverrides): string {
  const nameEnd = (/^<[^\s/>]+/.exec(tag)?.[0].length ?? 1) as number
  const attrs = readAttributes(tag, nameEnd, tag.length)
  const edits: Array<{ start: number; end: number; xml: string }> = []
  const appended: string[] = []
  for (const [name, value] of Object.entries(overrides)) {
    const found = attrs.find((a) => prefixes.canonical(a.name) === name)
    if (found) {
      if (value === null) {
        let s = found.nameStart
        while (s > nameEnd && /\s/.test(tag[s - 1])) s--
        edits.push({ start: s, end: Math.min(tag.length, found.valueEnd + 1), xml: '' })
      } else edits.push({ start: found.valueStart, end: found.valueEnd, xml: escapeXmlAttr(value) })
    } else if (value !== null) appended.push(` ${name}="${escapeXmlAttr(value)}"`)
  }
  if (appended.length) {
    const close = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1
    let at = close
    while (at > nameEnd && /\s/.test(tag[at - 1])) at--
    edits.push({ start: at, end: at, xml: appended.join('') })
  }
  return edits.length ? local(tag, edits) : tag
}

interface Child {
  name: string
  tag: string
  start: number
  openEnd: number
  closeStart: number
  end: number
  selfClosing: boolean
}

function directChildren(xml: string, prefixes: PrefixMap, from: number, to: number): Child[] {
  const out: Child[] = []
  walkElements(
    xml,
    prefixes,
    {
      open(el, parent) {
        if (parent !== null) return 'skip'
        el.data = true
      },
      close(el, parent) {
        if (parent !== null || !el.data) return
        out.push({
          name: el.name,
          tag: el.tag,
          start: el.start,
          openEnd: el.openEnd,
          closeStart: el.closeStart,
          end: el.end,
          selfClosing: el.selfClosing,
        })
      },
    },
    from,
    to,
  )
  return out
}

/** Applies `edit` to the style element `xml` (the exact element source). */
export function editStyleXml(xml: string, prefixes: PrefixMap, edit: StyleXmlEdit): string {
  const rootTagEnd = xml.indexOf('>') + 1
  let rootTag = xml.slice(0, rootTagEnd)
  const rootName = /^<([^\s/>]+)/.exec(rootTag)?.[1] ?? 'style:style'
  let body = ''
  if (rootTag.endsWith('/>')) {
    rootTag = rootTag.replace(/\s*\/>$/, '>')
  } else {
    body = xml.slice(rootTagEnd, xml.length - `</${rootName}>`.length)
  }
  const tagOverrides: AttrOverrides = { ...(edit.attrs ?? {}) }
  if (edit.name !== undefined) tagOverrides['style:name'] = edit.name
  if (edit.parent !== undefined) tagOverrides['style:parent-style-name'] = edit.parent
  rootTag = patchStartTag(rootTag, prefixes, tagOverrides)

  const props = { ...(edit.props ?? {}) }
  if (edit.tabStops !== undefined) props['style:paragraph-properties'] ??= {}
  const children = directChildren(body, prefixes, 0, body.length)
  const edits: Array<{ start: number; end: number; xml: string }> = []
  for (const [propName, overrides] of Object.entries(props)) {
    const child = children.find((c) => c.name === propName)
    const tabs =
      propName === 'style:paragraph-properties' && edit.tabStops !== undefined
        ? edit.tabStops
        : undefined
    if (child) {
      let open = body.slice(child.start, child.openEnd)
      open = patchStartTag(open, prefixes, overrides)
      if (tabs === undefined) {
        edits.push({ start: child.start, end: child.openEnd, xml: open })
        continue
      }
      const tabsXml = tabs ? `<style:tab-stops>${tabs}</style:tab-stops>` : '<style:tab-stops/>'
      if (child.selfClosing) {
        edits.push({
          start: child.start,
          end: child.end,
          xml: `${open.replace(/\s*\/>$/, '>')}${tabsXml}</${child.tag}>`,
        })
        continue
      }
      edits.push({ start: child.start, end: child.openEnd, xml: open })
      const inner = directChildren(body, prefixes, child.openEnd, child.closeStart)
      const stops = inner.find((c) => c.name === 'style:tab-stops')
      if (stops) edits.push({ start: stops.start, end: stops.end, xml: tabsXml })
      else edits.push({ start: child.openEnd, end: child.openEnd, xml: tabsXml })
      continue
    }
    const attrs = Object.entries(overrides)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => ` ${k}="${escapeXmlAttr(v as string)}"`)
      .join('')
    if (!attrs && tabs === undefined) continue
    const created =
      tabs === undefined
        ? `<${propName}${attrs}/>`
        : `<${propName}${attrs}>${tabs ? `<style:tab-stops>${tabs}</style:tab-stops>` : ''}</${propName}>`
    const rank = PROPERTY_ORDER.indexOf(propName)
    const before = children.find((c) => {
      const r = PROPERTY_ORDER.indexOf(c.name)
      return r > rank || (r < 0 && !c.name.endsWith('-properties'))
    })
    const at = before ? before.start : body.length
    edits.push({ start: at, end: at, xml: created })
  }
  body = edits.length ? local(body, edits) : body
  return `${rootTag}${body}</${rootName}>`
}

/** A fresh automatic style element. */
export function newStyleXml(name: string, family: string, parent: string | null): string {
  const p = parent !== null ? ` style:parent-style-name="${escapeXmlAttr(parent)}"` : ''
  return `<style:style style:name="${escapeXmlAttr(name)}" style:family="${family}"${p}></style:style>`
}
