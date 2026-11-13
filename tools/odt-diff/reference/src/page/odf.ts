/**
 * Small readers and narrow editors for the ODF side of the page layer: start
 * tag attributes at an offset, the children of a master page region, the
 * style that starts a page run, and string edits of page layouts and master
 * pages that keep every byte they do not name.
 */
import { applyTextPatches, type TextPatch } from '../core/convert'
import type { OdtMasterPage, OdtStyle, OdtStyleTable } from '../core/styles'
import {
  type ElementRange,
  type PrefixMap,
  attributeMap,
  escapeXmlAttr,
  walkElements,
} from '../core/xml'
import type { AttrOverrides } from '../text/props'
import { patchStartTag } from '../text/style-xml'
import { HF_REGIONS, type HfRegion } from './model'

/** Canonical name and decoded attributes of the start tag at `start`. */
export function startTagAt(
  xml: string,
  start: number,
  prefixes: PrefixMap,
): { name: string; attrs: Record<string, string>; end: number } | null {
  const m = /^<([^\s/>]+)/.exec(xml.slice(start, start + 200))
  if (!m) return null
  const end = xml.indexOf('>', start) + 1
  if (end <= 0) return null
  const nameEnd = start + m[0].length
  return {
    name: prefixes.canonical(m[1]),
    attrs: attributeMap(xml, nameEnd, end, prefixes),
    end,
  }
}

export interface RegionChild extends ElementRange {
  name: string
}

/** Direct child elements of `[from, to)` (a region's inner range). */
export function childElements(
  xml: string,
  prefixes: PrefixMap,
  from: number,
  to: number,
): RegionChild[] {
  const out: RegionChild[] = []
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

/** The master page a style switches to (`style:master-page-name`, empty = none). */
export function masterOf(style: OdtStyle | undefined): string | null {
  const name = style?.masterPageName
  return name ? name : null
}

/** `style:page-number` of a style that starts a page run, as a number (null: none / auto). */
export function pageNumberOf(
  styles: OdtStyleTable,
  name: string,
  family: 'paragraph' | 'table',
): number | null {
  const resolved = styles.resolve(name, family, 'content')
  const path = family === 'paragraph' ? 'style:paragraph-properties' : 'style:table-properties'
  const value = resolved?.properties[path]?.['style:page-number']
  if (value === undefined || !/^\d+$/.test(value.trim())) return null
  return parseInt(value, 10)
}

/** The header/footer regions a master page has. */
export const regionsOf = (master: OdtMasterPage | undefined): Set<HfRegion> =>
  new Set(master ? (Object.keys(master.regions) as HfRegion[]) : [])

export const titlePgOf = (master: OdtMasterPage | undefined): boolean =>
  !!master && (!!master.regions['header-first'] || !!master.regions['footer-first'])

export const evenOddOf = (master: OdtMasterPage | undefined): boolean =>
  !!master && (!!master.regions['header-left'] || !!master.regions['footer-left'])

const localPatch = (xml: string, edits: Array<{ start: number; end: number; xml: string }>) =>
  applyTextPatches(
    xml,
    edits.map((e) => ({ part: 'styles.xml', ...e }) as TextPatch),
  )

// ---------------------------------------------------------------------------
// Page layouts

/**
 * A page layout element with attribute overrides applied to its
 * `style:page-layout-properties` and the `style:header-footer-properties` of
 * its header and footer styles (`page`, `header`, `footer`), and optionally a
 * new name. Everything else keeps its bytes.
 */
export function editLayoutXml(
  xml: string,
  prefixes: PrefixMap,
  edit: { name?: string; page?: AttrOverrides; header?: AttrOverrides; footer?: AttrOverrides },
): string {
  const edits: Array<{ start: number; end: number; xml: string }> = []
  const rootEnd = xml.indexOf('>') + 1
  if (xml.slice(0, rootEnd).endsWith('/>')) {
    const open = xml.slice(0, rootEnd).replace(/\s*\/>$/, '>')
    const name = /^<([^\s/>]+)/.exec(open)?.[1] ?? 'style:page-layout'
    return editLayoutXml(`${open}</${name}>`, prefixes, edit)
  }
  if (edit.name !== undefined) {
    edits.push({
      start: 0,
      end: rootEnd,
      xml: patchStartTag(xml.slice(0, rootEnd), prefixes, {
        'style:name': edit.name,
        'style:display-name': null,
      }),
    })
  }
  const children = rootEnd < xml.length ? childElements(xml, prefixes, rootEnd, xml.length) : []
  const patchProps = (el: RegionChild | undefined, overrides: AttrOverrides | undefined) => {
    if (!el || !overrides || !Object.keys(overrides).length) return
    edits.push({
      start: el.start,
      end: el.openEnd,
      xml: patchStartTag(xml.slice(el.start, el.openEnd), prefixes, overrides),
    })
  }
  const pageProps = children.find((c) => c.name === 'style:page-layout-properties')
  if (pageProps) patchProps(pageProps, edit.page)
  else if (edit.page && Object.values(edit.page).some((v) => v !== null)) {
    const attrs = Object.entries(edit.page)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => ` ${k}="${escapeXmlAttr(v as string)}"`)
      .join('')
    edits.push({ start: rootEnd, end: rootEnd, xml: `<style:page-layout-properties${attrs}/>` })
  }
  for (const kind of ['header', 'footer'] as const) {
    const overrides = edit[kind]
    if (!overrides || !Object.keys(overrides).length) continue
    const host = children.find((c) => c.name === `style:${kind}-style`)
    if (!host || host.selfClosing) continue
    const inner = childElements(xml, prefixes, host.openEnd, host.closeStart)
    patchProps(
      inner.find((c) => c.name === 'style:header-footer-properties'),
      overrides,
    )
  }
  return edits.length ? localPatch(xml, edits) : xml
}

// ---------------------------------------------------------------------------
// Master pages

export interface MasterEdit {
  name?: string
  layout?: string
  /** region → new inner XML (null removes the region) */
  regions?: Partial<Record<HfRegion, string | null>>
}

/**
 * A master page element with a new name / page layout and replaced, removed
 * or added header/footer regions. A replaced region keeps its start tag; an
 * added region goes to its schema position (header, header-left,
 * header-first, footer, footer-left, footer-first).
 */
export function editMasterXml(
  xml: string,
  prefixes: PrefixMap,
  styleTag: string,
  edit: MasterEdit,
): string {
  let source = xml
  let rootEnd = source.indexOf('>') + 1
  let rootTag = source.slice(0, rootEnd)
  const rootName = /^<([^\s/>]+)/.exec(rootTag)?.[1] ?? 'style:master-page'
  if (rootTag.endsWith('/>')) {
    rootTag = rootTag.replace(/\s*\/>$/, '>')
    source = `${rootTag}</${rootName}>`
    rootEnd = rootTag.length
  }
  const tagOverrides: AttrOverrides = {}
  if (edit.name !== undefined) {
    tagOverrides['style:name'] = edit.name
    tagOverrides['style:display-name'] = null
    const next = attributeMap(rootTag, rootName.length + 1, rootTag.length, prefixes)[
      'style:next-style-name'
    ]
    const own = attributeMap(rootTag, rootName.length + 1, rootTag.length, prefixes)['style:name']
    if (next !== undefined && next === own) tagOverrides['style:next-style-name'] = edit.name
  }
  if (edit.layout !== undefined) tagOverrides['style:page-layout-name'] = edit.layout
  const edits: Array<{ start: number; end: number; xml: string }> = []
  if (Object.keys(tagOverrides).length)
    edits.push({ start: 0, end: rootEnd, xml: patchStartTag(rootTag, prefixes, tagOverrides) })
  const closeStart = source.length - `</${rootName}>`.length
  const children = childElements(source, prefixes, rootEnd, closeStart)
  const regionOf = (c: RegionChild) =>
    c.name.startsWith('style:') ? (c.name.slice(6) as HfRegion) : null
  const present = children.filter((c) => {
    const r = regionOf(c)
    return r !== null && HF_REGIONS.includes(r)
  })
  for (const region of HF_REGIONS) {
    if (!edit.regions || !(region in edit.regions)) continue
    const inner = edit.regions[region]
    const el = present.find((c) => regionOf(c) === region)
    if (el) {
      if (inner === null || inner === undefined) {
        edits.push({ start: el.start, end: el.end, xml: '' })
        continue
      }
      let open = source.slice(el.start, el.openEnd)
      const tagName = /^<([^\s/>]+)/.exec(open)?.[1] ?? `style:${region}`
      if (open.endsWith('/>')) open = open.replace(/\s*\/>$/, '>')
      edits.push({
        start: el.start,
        end: el.end,
        xml: inner === '' ? open.replace(/>$/, '/>') : `${open}${inner}</${tagName}>`,
      })
      continue
    }
    if (inner === null || inner === undefined) continue
    const rank = HF_REGIONS.indexOf(region)
    const after = present.find((c) => HF_REGIONS.indexOf(regionOf(c) as HfRegion) > rank)
    const before = [...present]
      .reverse()
      .find((c) => HF_REGIONS.indexOf(regionOf(c) as HfRegion) < rank)
    const at = after ? after.start : before ? before.end : rootEnd
    const tag = `${styleTag}:${region}`
    edits.push({
      start: at,
      end: at,
      xml: inner === '' ? `<${tag}/>` : `<${tag}>${inner}</${tag}>`,
    })
  }
  return edits.length ? localPatch(source, edits) : source
}
