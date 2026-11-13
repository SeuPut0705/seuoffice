/**
 * The style table of an ODT: common styles, default styles, list styles,
 * page layouts and master pages from styles.xml, plus the automatic styles of
 * both styles.xml and content.xml — each with its source range, so a later
 * stage can copy a style verbatim or insert new automatic styles beside it.
 *
 * Names are kept as written (entity references decoded; the raw attribute
 * text is kept too). Hancom names contain spaces, non-ASCII and `+`, and
 * reference parents that are never defined (`Standard`, `Frame`); none of
 * that is an error here.
 *
 * Scopes: content.xml automatic styles are what the body references; styles.xml
 * automatic styles are what master pages (headers/footers) reference. The two
 * may reuse a name. Both fall back to common styles. In ODF an automatic style
 * is never the parent of another style, so parent lookups only consider common
 * styles.
 */
import {
  type ElementRange,
  type PrefixMap,
  attributeMap,
  readAttributes,
  readRoot,
  walkElements,
} from './xml'

export type OdtStylePart = 'styles.xml' | 'content.xml'
/** Which automatic styles a reference can see: the body's (`content`) or the master pages' (`styles`). */
export type OdtStyleScope = 'content' | 'styles'
export type OdtStyleKind =
  | 'style' // style:style
  | 'default-style' // style:default-style
  | 'list-style' // text:list-style
  | 'outline-style' // text:outline-style
  | 'page-layout' // style:page-layout
  | 'other' // data styles, notes configuration, gradients …

/**
 * Attribute bags of property elements keyed by their element path below the
 * style element: `style:paragraph-properties`,
 * `style:header-style/style:header-footer-properties`,
 * `style:list-level-properties/style:list-level-label-alignment`. Tab stops
 * are kept separately (`tabStops`) because a list cannot merge attribute-wise.
 */
export type OdtPropertyBag = Record<string, Record<string, string>>

export interface OdtListLevel extends ElementRange {
  /** `text:level` (1-based) */
  level: number
  kind: 'number' | 'bullet' | 'image' | 'outline' | 'other'
  /** canonical element name */
  elementName: string
  attrs: Record<string, string>
  properties: OdtPropertyBag
}

export interface OdtStyle extends ElementRange {
  kind: OdtStyleKind
  /** canonical element name (`style:style`) */
  elementName: string
  /** element name as written */
  tag: string
  /** decoded `style:name` ('' for default styles) */
  name: string
  /** `style:name` exactly as written (entity references intact), or null */
  rawName: string | null
  displayName: string | null
  /** `style:family`; null for list styles, outline styles and page layouts */
  family: string | null
  parentName: string | null
  masterPageName: string | null
  listStyleName: string | null
  nextStyleName: string | null
  /** an automatic style (office:automatic-styles) rather than a common one (office:styles) */
  automatic: boolean
  part: OdtStylePart
  /** decoded attributes of the style element */
  attrs: Record<string, string>
  /** this style's own properties (not inherited) */
  properties: OdtPropertyBag
  /** own tab stops (attribute maps of `style:tab-stop`); null when the style does not set them */
  tabStops: Array<Record<string, string>> | null
  /** levels of a list or outline style; empty otherwise */
  levels: OdtListLevel[]
}

export type OdtMasterPageRegionName =
  'header' | 'footer' | 'header-left' | 'footer-left' | 'header-first' | 'footer-first'

export interface OdtMasterPageRegion extends ElementRange {
  attrs: Record<string, string>
}

export interface OdtMasterPage extends ElementRange {
  name: string
  rawName: string | null
  displayName: string | null
  pageLayoutName: string | null
  nextStyleName: string | null
  tag: string
  attrs: Record<string, string>
  /** header/footer regions present, in document order */
  regions: Partial<Record<OdtMasterPageRegionName, OdtMasterPageRegion>>
  part: 'styles.xml'
}

export interface OdtStyleContainers {
  fontFaceDecls?: ElementRange
  styles?: ElementRange
  automaticStyles?: ElementRange
  masterStyles?: ElementRange
}

export interface OdtResolvedStyle {
  style: OdtStyle
  /** the style, then its common ancestors, nearest first */
  chain: OdtStyle[]
  /** the default style of the family, if any */
  defaultStyle: OdtStyle | null
  /** effective properties: default style, then ancestors, then the style; nearest wins per attribute */
  properties: OdtPropertyBag
  /** effective tab stops: from the nearest style (or default style) that sets them */
  tabStops: Array<Record<string, string>> | null
  /** a parent name that could not be found among common styles (Hancom's `Standard`), else null */
  missingParent: string | null
}

const STYLE_KINDS: Record<string, OdtStyleKind> = {
  'style:style': 'style',
  'style:default-style': 'default-style',
  'text:list-style': 'list-style',
  'text:outline-style': 'outline-style',
  'style:page-layout': 'page-layout',
}

const REGION_NAMES = new Set<string>([
  'header',
  'footer',
  'header-left',
  'footer-left',
  'header-first',
  'footer-first',
])

const key = (family: string, name: string) => `${family}\u0000${name}`

export class OdtStyleTable {
  /** every style record (styles.xml first, then content.xml), document order */
  readonly all: OdtStyle[] = []
  readonly masterPages: OdtMasterPage[] = []
  readonly containers: { styles: OdtStyleContainers; content: OdtStyleContainers } = {
    styles: {},
    content: {},
  }
  private readonly commonByKey = new Map<string, OdtStyle>()
  private readonly autoByKey = {
    content: new Map<string, OdtStyle>(),
    styles: new Map<string, OdtStyle>(),
  }
  private readonly defaults = new Map<string, OdtStyle>()
  private readonly commonLists = new Map<string, OdtStyle>()
  private readonly autoLists = {
    content: new Map<string, OdtStyle>(),
    styles: new Map<string, OdtStyle>(),
  }
  private readonly layouts = new Map<string, OdtStyle>()
  private readonly masters = new Map<string, OdtMasterPage>()

  /** @internal */
  add(style: OdtStyle): void {
    this.all.push(style)
    const scope: OdtStyleScope = style.part === 'content.xml' ? 'content' : 'styles'
    const setOnce = <V>(map: Map<string, V>, k: string, v: V) => {
      if (!map.has(k)) map.set(k, v)
    }
    if (style.kind === 'style' && style.family !== null) {
      setOnce(
        style.automatic ? this.autoByKey[scope] : this.commonByKey,
        key(style.family, style.name),
        style,
      )
    } else if (style.kind === 'default-style' && style.family !== null) {
      setOnce(this.defaults, style.family, style)
    } else if (style.kind === 'list-style') {
      setOnce(style.automatic ? this.autoLists[scope] : this.commonLists, style.name, style)
    } else if (style.kind === 'page-layout') {
      setOnce(this.layouts, style.name, style)
    }
  }

  /** @internal */
  addMasterPage(page: OdtMasterPage): void {
    this.masterPages.push(page)
    if (!this.masters.has(page.name)) this.masters.set(page.name, page)
  }

  /** A style as a reference from `scope` sees it: that part's automatic styles, then common styles. */
  find(name: string, family: string, scope: OdtStyleScope): OdtStyle | undefined {
    const k = key(family, name)
    return this.autoByKey[scope].get(k) ?? this.commonByKey.get(k)
  }

  /** A common (office:styles) style. */
  common(name: string, family: string): OdtStyle | undefined {
    return this.commonByKey.get(key(family, name))
  }

  /** The `style:default-style` of a family. */
  defaultStyle(family: string): OdtStyle | undefined {
    return this.defaults.get(family)
  }

  /** A list style as seen from `scope`. */
  listStyle(name: string, scope: OdtStyleScope): OdtStyle | undefined {
    return this.autoLists[scope].get(name) ?? this.commonLists.get(name)
  }

  pageLayout(name: string): OdtStyle | undefined {
    return this.layouts.get(name)
  }

  masterPage(name: string): OdtMasterPage | undefined {
    return this.masters.get(name)
  }

  /**
   * Effective properties of a style: its family's default style, then its
   * common ancestors (farthest first), then the style itself. Parents are
   * looked up among common styles only; a missing parent ends the chain and
   * is reported, and a cycle ends it silently.
   */
  resolve(name: string, family: string, scope: OdtStyleScope): OdtResolvedStyle | undefined {
    const style = this.find(name, family, scope)
    if (!style) return undefined
    const chain: OdtStyle[] = [style]
    const seen = new Set<OdtStyle>(chain)
    let missingParent: string | null = null
    let current = style
    while (current.parentName !== null) {
      const parent = this.common(current.parentName, family)
      if (!parent) {
        missingParent = current.parentName
        break
      }
      if (seen.has(parent)) break
      seen.add(parent)
      chain.push(parent)
      current = parent
    }
    const defaultStyle = this.defaults.get(family) ?? null
    const layers = defaultStyle ? [defaultStyle, ...[...chain].reverse()] : [...chain].reverse()
    const properties: OdtPropertyBag = {}
    for (const layer of layers) {
      for (const [path, bag] of Object.entries(layer.properties)) {
        properties[path] = { ...properties[path], ...bag }
      }
    }
    let tabStops: Array<Record<string, string>> | null = null
    for (const layer of defaultStyle ? [...chain, defaultStyle] : chain) {
      if (layer.tabStops) {
        tabStops = layer.tabStops
        break
      }
    }
    return { style, chain, defaultStyle, properties, tabStops, missingParent }
  }
}

/** A light element tree used for the style sections only. */
interface TreeElement extends ElementRange {
  name: string
  tag: string
  nameEnd: number
  children: TreeElement[]
}

function buildTree(xml: string, prefixes: PrefixMap, stopAt: string | null): TreeElement[] {
  const roots: TreeElement[] = []
  walkElements(xml, prefixes, {
    open(el, parent) {
      if (stopAt !== null && el.name === stopAt) return 'stop'
      const node: TreeElement = {
        name: el.name,
        tag: el.tag,
        start: el.start,
        openEnd: el.openEnd,
        nameEnd: el.nameEnd,
        closeStart: el.openEnd,
        end: el.openEnd,
        selfClosing: el.selfClosing,
        children: [],
      }
      el.data = node
      const owner = parent?.data as TreeElement | undefined
      if (owner) owner.children.push(node)
      else roots.push(node)
    },
    close(el) {
      const node = el.data as TreeElement
      node.closeStart = el.closeStart
      node.end = el.end
    },
  })
  return roots
}

const rangeOf = (el: TreeElement): ElementRange => ({
  start: el.start,
  openEnd: el.openEnd,
  closeStart: el.closeStart,
  end: el.end,
  selfClosing: el.selfClosing,
})

/**
 * Builds the style table from styles.xml (may be missing) and content.xml.
 * Never throws on malformed style markup.
 */
export function readOdtStyles(stylesXml: string | null, contentXml: string): OdtStyleTable {
  const table = new OdtStyleTable()
  if (stylesXml !== null) readPart(table, stylesXml, 'styles.xml')
  readPart(table, contentXml, 'content.xml')
  return table
}

function readPart(table: OdtStyleTable, xml: string, part: OdtStylePart): void {
  const root = readRoot(xml)
  if (!root) return
  const prefixes = root.prefixes
  const attrs = (el: TreeElement) => attributeMap(xml, el.nameEnd, el.openEnd, prefixes)
  const rawName = (el: TreeElement) =>
    readAttributes(xml, el.nameEnd, el.openEnd).find(
      (a) => prefixes.canonical(a.name) === 'style:name',
    )?.raw ?? null
  const containers = part === 'styles.xml' ? table.containers.styles : table.containers.content
  const [docElement] = buildTree(xml, prefixes, part === 'content.xml' ? 'office:body' : null)
  if (!docElement) return

  const collectProperties = (el: TreeElement): OdtPropertyBag => {
    const bag: OdtPropertyBag = {}
    const visit = (node: TreeElement, path: string, insideProperties: boolean) => {
      const counts = new Map<string, number>()
      for (const child of node.children) counts.set(child.name, (counts.get(child.name) ?? 0) + 1)
      for (const child of node.children) {
        if (child.name === 'style:tab-stops') continue
        const childPath = path ? `${path}/${child.name}` : child.name
        const isProperties = child.name.endsWith('-properties')
        const own = attrs(child)
        if (
          isProperties ||
          (insideProperties && counts.get(child.name) === 1 && Object.keys(own).length)
        ) {
          bag[childPath] = { ...bag[childPath], ...own }
        }
        visit(child, childPath, insideProperties || isProperties)
      }
    }
    visit(el, '', false)
    return bag
  }

  const tabStopsOf = (el: TreeElement): Array<Record<string, string>> | null => {
    const props = el.children.find((c) => c.name === 'style:paragraph-properties')
    const stops = props?.children.find((c) => c.name === 'style:tab-stops')
    if (!stops) return null
    return stops.children.filter((c) => c.name === 'style:tab-stop').map(attrs)
  }

  const record = (el: TreeElement, automatic: boolean): OdtStyle => {
    const a = attrs(el)
    const kind = STYLE_KINDS[el.name] ?? 'other'
    const levels: OdtListLevel[] = []
    if (kind === 'list-style' || kind === 'outline-style') {
      for (const child of el.children) {
        const local = child.name.slice(child.name.indexOf(':') + 1)
        if (!local.startsWith('list-level-style-') && local !== 'outline-level-style') continue
        const levelAttrs = attrs(child)
        const levelKind =
          local === 'outline-level-style'
            ? 'outline'
            : ((['number', 'bullet', 'image'] as const).find(
                (k) => local === `list-level-style-${k}`,
              ) ?? 'other')
        levels.push({
          ...rangeOf(child),
          level: parseInt(levelAttrs['text:level'] ?? '', 10) || 0,
          kind: levelKind,
          elementName: child.name,
          attrs: levelAttrs,
          properties: collectProperties(child),
        })
      }
    }
    return {
      ...rangeOf(el),
      kind,
      elementName: el.name,
      tag: el.tag,
      name: a['style:name'] ?? '',
      rawName: rawName(el),
      displayName: a['style:display-name'] ?? null,
      family: kind === 'style' || kind === 'default-style' ? (a['style:family'] ?? null) : null,
      parentName: a['style:parent-style-name'] ?? null,
      masterPageName: a['style:master-page-name'] ?? null,
      listStyleName: a['style:list-style-name'] ?? null,
      nextStyleName: a['style:next-style-name'] ?? null,
      automatic,
      part,
      attrs: a,
      properties: kind === 'list-style' || kind === 'outline-style' ? {} : collectProperties(el),
      tabStops: kind === 'style' || kind === 'default-style' ? tabStopsOf(el) : null,
      levels,
    }
  }

  for (const section of docElement.children) {
    switch (section.name) {
      case 'office:font-face-decls':
        containers.fontFaceDecls ??= rangeOf(section)
        break
      case 'office:styles':
        containers.styles ??= rangeOf(section)
        for (const el of section.children) table.add(record(el, false))
        break
      case 'office:automatic-styles':
        containers.automaticStyles ??= rangeOf(section)
        for (const el of section.children) table.add(record(el, true))
        break
      case 'office:master-styles':
        containers.masterStyles ??= rangeOf(section)
        if (part !== 'styles.xml') break
        for (const el of section.children) {
          if (el.name !== 'style:master-page') continue
          const a = attrs(el)
          const regions: OdtMasterPage['regions'] = {}
          for (const child of el.children) {
            const local = child.name.startsWith('style:') ? child.name.slice(6) : ''
            if (!REGION_NAMES.has(local)) continue
            const regionName = local as OdtMasterPageRegionName
            regions[regionName] ??= { ...rangeOf(child), attrs: attrs(child) }
          }
          table.addMasterPage({
            ...rangeOf(el),
            name: a['style:name'] ?? '',
            rawName: rawName(el),
            displayName: a['style:display-name'] ?? null,
            pageLayoutName: a['style:page-layout-name'] ?? null,
            nextStyleName: a['style:next-style-name'] ?? null,
            tag: el.tag,
            attrs: a,
            regions,
            part: 'styles.xml',
          })
        }
        break
    }
  }
}
