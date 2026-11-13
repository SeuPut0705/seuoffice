/**
 * Reads a drawing element of the ODF body (`draw:frame`, shapes, groups …)
 * from its source range: what it is (an editable picture, an object the
 * editor cannot change, or something another owner takes), its size and
 * placement, the picture that can stand for it, and the package entries it
 * references.
 */
import type { OdtDocument } from '../core/open'
import type { OdtStylePart } from '../core/styles'
import { type PrefixMap, attributeMap, decodeXmlEntities, walkElements } from '../core/xml'
import { type DrawingAnchor, EMU_PER_CM, lengthToEmu } from './geometry'
import { type ImageFormat, sniffImage } from './media'
import type { ObjectKind } from './model'

/** One element inside the analysed subtree. */
export interface SubElement {
  name: string
  start: number
  nameEnd: number
  openEnd: number
  closeStart: number
  end: number
  selfClosing: boolean
  /** 0 = direct child of the analysed element */
  depth: number
  attrs: Record<string, string>
}

/** Every element strictly inside `[from, to)`, in document order. */
export function subElements(
  xml: string,
  prefixes: PrefixMap,
  from: number,
  to: number,
): SubElement[] {
  const out: SubElement[] = []
  let depth = 0
  walkElements(
    xml,
    prefixes,
    {
      open(el) {
        const sub: SubElement = {
          name: el.name,
          start: el.start,
          nameEnd: el.nameEnd,
          openEnd: el.openEnd,
          closeStart: el.openEnd,
          end: el.openEnd,
          selfClosing: el.selfClosing,
          depth,
          attrs: attributeMap(xml, el.nameEnd, el.openEnd, prefixes),
        }
        out.push(sub)
        el.data = sub
        depth++
      },
      close(el) {
        depth--
        const sub = el.data as SubElement | undefined
        if (sub) {
          sub.closeStart = el.closeStart < 0 ? el.openEnd : el.closeStart
          sub.end = el.end < 0 ? to : el.end
        }
      },
    },
    from,
    to,
  )
  return out
}

/** Plain text content of a range (entities decoded, tags dropped). */
export function plainTextOf(xml: string, prefixes: PrefixMap, from: number, to: number): string {
  let out = ''
  walkElements(
    xml,
    prefixes,
    {
      open() {},
      other(kind, start, end) {
        if (kind === 'text') out += decodeXmlEntities(xml.slice(start, end))
      },
    },
    from,
    to,
  )
  return out
}

/** Names of the drawing elements that are objects in a paragraph. */
export const DRAW_OBJECT_NAMES: readonly string[] = [
  'draw:frame',
  'draw:a',
  'draw:rect',
  'draw:line',
  'draw:polyline',
  'draw:polygon',
  'draw:regular-polygon',
  'draw:path',
  'draw:circle',
  'draw:ellipse',
  'draw:g',
  'draw:page-thumbnail',
  'draw:connector',
  'draw:caption',
  'draw:measure',
  'draw:control',
  'draw:custom-shape',
  'dr3d:scene',
]

/** Elements whose `xlink:href` names a package entry (hyperlinks excluded). */
const ENTRY_HREF_ELEMENTS = new Set([
  'draw:image',
  'draw:object',
  'draw:object-ole',
  'draw:plugin',
  'draw:applet',
  'draw:floating-frame',
  'draw:fill-image',
])

/** A package path from an `xlink:href`, or null for external links. */
export function hrefPath(href: string): string | null {
  let h = href.trim()
  if (!h || h.startsWith('#') || h.startsWith('/')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h)) return null
  while (h.startsWith('./')) h = h.slice(2)
  return h
}

/** The package entries an href names: a file, or every entry of a directory (sorted). */
export function entriesOf(doc: Pick<OdtDocument, 'pkg'>, href: string): string[] {
  const raw = hrefPath(href)
  if (raw === null) return []
  const candidates = [raw]
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded !== raw) candidates.push(decoded)
  } catch {
    // not percent-encoded
  }
  for (const path of candidates) {
    const file = doc.pkg.get(path)
    if (file && !file.directory) return [path]
    const dir = path.endsWith('/') ? path : `${path}/`
    const inside = doc.pkg.entries.filter((e) => e.name.startsWith(dir)).map((e) => e.name)
    if (inside.length) return [...new Set(inside)].sort()
  }
  return []
}

export interface ObjectAnchorFacts {
  /** `text:anchor-type` (null when absent) */
  type: string | null
  /** position relative to the anchor */
  xEmu: number | null
  yEmu: number | null
  z: number
  styleName: string | null
}

export interface ObjectAnalysis {
  /** `skip`: not ours (a text box holding a table belongs to the table owner) */
  type: 'skip' | 'picture' | 'placeholder'
  kind: ObjectKind
  widthEmu: number
  heightEmu: number
  anchor: ObjectAnchorFacts
  /** package entries referenced anywhere inside */
  entries: string[]
  /** picture: the `draw:image` and its bytes */
  image: {
    href: string
    entry: string
    start: number
    openEnd: number
    bytes: Uint8Array
    format: ImageFormat
  } | null
  /** placeholder: a picture stored in the file that shows the object, or null */
  preview: { bytes: Uint8Array; format: ImageFormat } | null
}

const DEFAULT_W = 2 * EMU_PER_CM
const DEFAULT_H = EMU_PER_CM
const MIN_SIZE = EMU_PER_CM / 10

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function boxOf(attrs: Record<string, string>): Box | null {
  if (attrs['svg:x1'] !== undefined || attrs['svg:x2'] !== undefined) {
    const x1 = lengthToEmu(attrs['svg:x1']) ?? 0
    const x2 = lengthToEmu(attrs['svg:x2']) ?? 0
    const y1 = lengthToEmu(attrs['svg:y1']) ?? 0
    const y2 = lengthToEmu(attrs['svg:y2']) ?? 0
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    }
  }
  const w = lengthToEmu(attrs['svg:width'])
  const h = lengthToEmu(attrs['svg:height'])
  if (w === null || h === null) return null
  return { x: lengthToEmu(attrs['svg:x']) ?? 0, y: lengthToEmu(attrs['svg:y']) ?? 0, w, h }
}

function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const btm = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: r - x, h: btm - y }
}

/** Own graphic-properties of a drawing's style (resolved through its parents). */
export function graphicProps(
  doc: OdtDocument,
  part: OdtStylePart,
  styleName: string | null,
): Record<string, string> {
  if (!styleName) return {}
  const scope = part === 'content.xml' ? 'content' : 'styles'
  return {
    ...(doc.styles.resolve(styleName, 'graphic', scope)?.properties['style:graphic-properties'] ??
      {}),
  }
}

/** The kind of an embedded object (`draw:object`) by its package media type or content. */
function embeddedKind(doc: OdtDocument, href: string): ObjectKind {
  const path = hrefPath(href)
  if (path === null) return 'object'
  const dir = path.endsWith('/') ? path : `${path}/`
  const media =
    doc.manifest.entries.find((e) => e.fullPath === dir || e.fullPath === path)?.mediaType ?? ''
  if (/formula/.test(media)) return 'equation'
  if (/chart/.test(media)) return 'chart'
  const content = doc.pkg.text(`${dir}content.xml`) ?? ''
  if (/<(?:[\w-]+:)?math[\s>]/.test(content)) return 'equation'
  if (/<[\w-]+:chart[\s>]/.test(content)) return 'chart'
  return 'object'
}

/** Formats the docx engine shows without converting them (metafiles need a canvas). */
const DIRECT_FORMATS = new Set(['png', 'jpeg', 'gif', 'bmp', 'svg'])

/**
 * Picture bytes for an href when the bridge docx can show them. A preview
 * standing for a locked object must be shown as it is (`direct`): a picture
 * the engine cannot convert would leave no run to carry the placeholder.
 */
function displayable(
  doc: OdtDocument,
  href: string,
  direct = false,
): { entry: string; bytes: Uint8Array; format: ImageFormat } | null {
  const entries = entriesOf(doc, href)
  if (entries.length !== 1) return null
  const entry = doc.pkg.get(entries[0])
  if (!entry || entry.directory) return null
  const format = sniffImage(entry.bytes)
  if (!format || (direct && !DIRECT_FORMATS.has(format.ext))) return null
  return { entry: entry.name, bytes: entry.bytes, format }
}

/**
 * Analyses the drawing element `el` (its source range in `xml`).
 * `name` is its canonical element name.
 */
export function analyzeObject(
  doc: OdtDocument,
  part: OdtStylePart,
  xml: string,
  prefixes: PrefixMap,
  el: { name: string; start: number; nameEnd: number; openEnd: number; closeStart: number },
): ObjectAnalysis {
  const attrs = attributeMap(xml, el.nameEnd, el.openEnd, prefixes)
  const subs =
    el.openEnd < el.closeStart ? subElements(xml, prefixes, el.openEnd, el.closeStart) : []
  const children = subs.filter((s) => s.depth === 0)
  const entries = new Set<string>()
  for (const s of subs) {
    const href = s.attrs['xlink:href']
    if (href !== undefined && ENTRY_HREF_ELEMENTS.has(s.name))
      for (const e of entriesOf(doc, href)) entries.add(e)
  }
  const styleName = attrs['draw:style-name'] ?? null
  const props = graphicProps(doc, part, styleName)

  // size: own box, else min sizes, else the union of the parts
  let box = boxOf(attrs)
  if (!box) {
    const textBox = children.find((c) => c.name === 'draw:text-box')
    const w =
      lengthToEmu(attrs['svg:width']) ??
      lengthToEmu(textBox?.attrs['fo:min-width']) ??
      lengthToEmu(props['fo:min-width'])
    const h =
      lengthToEmu(attrs['svg:height']) ??
      lengthToEmu(textBox?.attrs['fo:min-height']) ??
      lengthToEmu(props['fo:min-height'])
    if (w !== null || h !== null)
      box = {
        x: lengthToEmu(attrs['svg:x']) ?? 0,
        y: lengthToEmu(attrs['svg:y']) ?? 0,
        w: w ?? DEFAULT_W,
        h: h ?? DEFAULT_H,
      }
  }
  if (!box) {
    const parts = subs
      .filter((s) => /^(draw|dr3d):/.test(s.name))
      .map((s) => boxOf(s.attrs))
      .filter((b): b is Box => b !== null)
    box = union(parts)
  }
  const size = {
    w: Math.max(MIN_SIZE, box?.w ?? DEFAULT_W),
    h: Math.max(MIN_SIZE, box?.h ?? DEFAULT_H),
  }
  const z = parseInt(attrs['draw:z-index'] ?? '0', 10)
  const anchor: ObjectAnchorFacts = {
    type: attrs['text:anchor-type'] ?? null,
    xEmu: lengthToEmu(attrs['svg:x']) ?? box?.x ?? null,
    yEmu: lengthToEmu(attrs['svg:y']) ?? box?.y ?? null,
    z: Number.isFinite(z) ? z : 0,
    styleName,
  }
  const result: ObjectAnalysis = {
    type: 'placeholder',
    kind: 'object',
    widthEmu: size.w,
    heightEmu: size.h,
    anchor,
    entries: [...entries].sort(),
    image: null,
    preview: null,
  }

  if (el.name === 'draw:frame') {
    const textBox = children.find((c) => c.name === 'draw:text-box')
    const object = children.find((c) => c.name === 'draw:object' || c.name === 'draw:object-ole')
    const image = children.find((c) => c.name === 'draw:image')
    if (textBox) {
      const hasTable = subs.some(
        (s) => s.name === 'table:table' && s.start >= textBox.start && s.end <= textBox.end,
      )
      if (hasTable) return { ...result, type: 'skip' }
      return { ...result, kind: 'textbox' }
    }
    if (object) {
      const kind =
        object.name === 'draw:object'
          ? embeddedKind(doc, object.attrs['xlink:href'] ?? '')
          : 'object'
      const shown = image ? displayable(doc, image.attrs['xlink:href'] ?? '', true) : null
      return { ...result, kind, preview: shown && { bytes: shown.bytes, format: shown.format } }
    }
    if (image) {
      const href = image.attrs['xlink:href'] ?? ''
      const shown = displayable(doc, href)
      if (shown) {
        return {
          ...result,
          type: 'picture',
          image: {
            href,
            entry: shown.entry,
            start: image.start,
            openEnd: image.openEnd,
            bytes: shown.bytes,
            format: shown.format,
          },
        }
      }
      return result
    }
    return result
  }

  // shapes and groups: a picture covering (nearly) the whole object stands for it
  const kind: ObjectKind = el.name === 'draw:a' || el.name === 'draw:control' ? 'object' : 'shape'
  const area = size.w * size.h
  let best: { bytes: Uint8Array; format: ImageFormat; area: number } | null = null
  for (const s of subs) {
    if (s.name !== 'draw:frame') continue
    const img = subs.find(
      (c) =>
        c.name === 'draw:image' && c.depth === s.depth + 1 && c.start > s.start && c.end <= s.end,
    )
    const b = boxOf(s.attrs)
    if (!img || !b) continue
    const shown = displayable(doc, img.attrs['xlink:href'] ?? '', true)
    const a = b.w * b.h
    if (shown && a >= area * 0.9 && (!best || a > best.area))
      best = { bytes: shown.bytes, format: shown.format, area: a }
  }
  return { ...result, kind, preview: best && { bytes: best.bytes, format: best.format } }
}

/** OOXML placement of a floating object, or null for an as-character (inline) one. */
export function anchorOf(
  doc: OdtDocument,
  part: OdtStylePart,
  facts: ObjectAnchorFacts,
): DrawingAnchor | null {
  const type = facts.type ?? 'paragraph'
  if (type === 'as-char') return null
  const props = graphicProps(doc, part, facts.styleName)
  const page = type === 'page'
  const hRel: Record<string, string> = {
    page: 'page',
    'page-content': 'margin',
    'page-start-margin': 'leftMargin',
    'page-end-margin': 'rightMargin',
    char: 'character',
  }
  const vRel: Record<string, string> = {
    page: 'page',
    'page-content': 'margin',
    line: 'line',
    char: 'line',
    text: 'line',
    baseline: 'line',
  }
  const hPos = props['style:horizontal-pos'] ?? 'from-left'
  const vPos = props['style:vertical-pos'] ?? 'from-top'
  const hAlign: Record<string, string> = {
    left: 'left',
    center: 'center',
    right: 'right',
    inside: 'inside',
    outside: 'outside',
  }
  const vAlign: Record<string, string> = {
    top: 'top',
    middle: 'center',
    bottom: 'bottom',
  }
  const wrapProp = props['style:wrap'] ?? 'none'
  return {
    h: {
      relativeFrom: page ? 'page' : (hRel[props['style:horizontal-rel'] ?? ''] ?? 'column'),
      offset: hAlign[hPos] ? null : (facts.xEmu ?? 0),
      align: hAlign[hPos] ?? null,
    },
    v: {
      relativeFrom: page ? 'page' : (vRel[props['style:vertical-rel'] ?? ''] ?? 'paragraph'),
      offset: vAlign[vPos] ? null : (facts.yEmu ?? 0),
      align: vAlign[vPos] ?? null,
    },
    wrap: wrapProp === 'run-through' ? 'none' : wrapProp === 'none' ? 'topAndBottom' : 'square',
    behind: wrapProp === 'run-through' && props['style:run-through'] === 'background',
    z: facts.z,
  }
}

/** Width of the text area of the default page (EMU), for block placeholders. */
export function textWidthEmu(doc: OdtDocument): number {
  const master = doc.styles.masterPage('Standard') ?? doc.styles.masterPages[0]
  const layout = master?.pageLayoutName ? doc.styles.pageLayout(master.pageLayoutName) : undefined
  const p = layout?.properties['style:page-layout-properties'] ?? {}
  const width = lengthToEmu(p['fo:page-width']) ?? Math.round(21 * EMU_PER_CM)
  const left = lengthToEmu(p['fo:margin-left']) ?? 2 * EMU_PER_CM
  const right = lengthToEmu(p['fo:margin-right']) ?? 2 * EMU_PER_CM
  return Math.max(2 * EMU_PER_CM, width - left - right)
}
