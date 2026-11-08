/**
 * Page geometry: an ODF page layout ↔ the docx page setup the editor shows.
 *
 * The two formats measure the top and bottom differently. ODF (and Hancom,
 * which reads `fo:margin-top` as its top margin and the header-style height
 * as its header length) puts the header INSIDE the page margins: the header
 * starts `fo:margin-top` from the edge, is `svg:height` (or `fo:min-height`)
 * tall, then `fo:margin-bottom` of spacing, then the body. Hancom reserves the
 * header length even when the master page has no header, so the body always
 * starts at margin + header length + spacing. OOXML measures the body from
 * the edge (`w:top`) and the header separately (`w:header`). So:
 *
 *   w:header = fo:margin-top
 *   w:top    = fo:margin-top + header height + header spacing
 *   (the bottom likewise with the footer)
 *
 * and back, an edited `w:top`/`w:header` keeps the spacing and splits the
 * rest into margin and header height. Only values that changed are written.
 */
import type { SectionSettings } from '@genoffice/docx-engine'
import type { OdtStyle } from '../core/styles'
import type { AttrOverrides } from '../text/props'
import { lengthToTwips, twipsToCm } from '../text/units'

/** Property paths of a page layout in the style table's property bags. */
export const LAYOUT_PROPS = 'style:page-layout-properties'
export const LAYOUT_COLUMNS = 'style:page-layout-properties/style:columns'
export const HEADER_PROPS = 'style:header-style/style:header-footer-properties'
export const FOOTER_PROPS = 'style:footer-style/style:header-footer-properties'

/**
 * Twips as centimetres. A value the editor shows as a round 0.1 mm (21 cm
 * reads back as 11906 twips = 21.0009 cm) is written round (`21.000cm`).
 */
export function twipsToLength(value: number): string {
  const round = Math.round(((value * 2.54) / 1440) * 100) / 100
  if (Math.round((round * 1440) / 2.54) === Math.round(value)) return `${round.toFixed(3)}cm`
  return twipsToCm(value)
}

/** A4 portrait with 1-inch margins: what an ODT without a page layout shows (as the core does). */
const DEFAULTS = { width: 11906, height: 16838, margin: 1440 }

/** The docx-side page setup of a page layout, in twips. */
export interface PageGeometry {
  width: number
  height: number
  landscape: boolean
  /** body edges (OOXML `w:pgMar`) */
  top: number
  bottom: number
  left: number
  right: number
  /** header / footer distance from the page edge */
  header: number
  footer: number
  columns: number
  columnGap: number
  /** `style:num-format` of the page layout (page number format), or null */
  numFormat: string | null
}

interface Band {
  /** the header-style / footer-style element exists */
  present: boolean
  height: number
  spacing: number
  /** attribute that holds the height */
  heightAttr: 'svg:height' | 'fo:min-height'
}

function band(layout: OdtStyle | undefined, kind: 'header' | 'footer'): Band {
  const props = layout?.properties[kind === 'header' ? HEADER_PROPS : FOOTER_PROPS]
  if (!props) return { present: false, height: 0, spacing: 0, heightAttr: 'svg:height' }
  const heightAttr = props['svg:height'] === undefined && props['fo:min-height'] !== undefined
  return {
    present: true,
    height: lengthToTwips(props[heightAttr ? 'fo:min-height' : 'svg:height']) ?? 0,
    spacing: lengthToTwips(props[kind === 'header' ? 'fo:margin-bottom' : 'fo:margin-top']) ?? 0,
    heightAttr: heightAttr ? 'fo:min-height' : 'svg:height',
  }
}

/** A page margin (individual attribute, else the `fo:margin` shorthand), unrounded twips. */
function margin(props: Record<string, string>, side: string): number | undefined {
  return lengthToTwips(props[`fo:margin-${side}`]) ?? lengthToTwips(props['fo:margin'])
}

export function layoutGeometry(layout: OdtStyle | undefined): PageGeometry {
  const p = layout?.properties[LAYOUT_PROPS] ?? {}
  const cols = layout?.properties[LAYOUT_COLUMNS]
  const top = margin(p, 'top') ?? DEFAULTS.margin
  const bottom = margin(p, 'bottom') ?? DEFAULTS.margin
  const h = band(layout, 'header')
  const f = band(layout, 'footer')
  return {
    width: Math.round(lengthToTwips(p['fo:page-width']) ?? DEFAULTS.width),
    height: Math.round(lengthToTwips(p['fo:page-height']) ?? DEFAULTS.height),
    landscape: p['style:print-orientation'] === 'landscape',
    top: Math.round(top + h.height + h.spacing),
    bottom: Math.round(bottom + f.height + f.spacing),
    left: Math.round(margin(p, 'left') ?? DEFAULTS.margin),
    right: Math.round(margin(p, 'right') ?? DEFAULTS.margin),
    header: Math.round(top),
    footer: Math.round(bottom),
    columns: columnsOf(cols).count,
    columnGap: columnsOf(cols).gap,
    numFormat: p['style:num-format'] ?? null,
  }
}

/** Column count and gap (twips) of a `style:columns` attribute bag. */
export function columnsOf(cols: Record<string, string> | undefined): {
  count: number
  gap: number
} {
  return {
    count: Math.max(1, parseInt(cols?.['fo:column-count'] ?? '1', 10) || 1),
    gap: Math.round(lengthToTwips(cols?.['fo:column-gap']) ?? 0),
  }
}

/** Attribute overrides for one page layout, by the property element they belong to. */
export interface LayoutOverrides {
  page: AttrOverrides
  header: AttrOverrides
  footer: AttrOverrides
}

export const isEmptyOverrides = (o: LayoutOverrides): boolean =>
  !Object.keys(o.page).length && !Object.keys(o.header).length && !Object.keys(o.footer).length

/**
 * The ODF attributes to change so the layout shows `after` where the bridge
 * showed `before`. Values `before` and `after` agree on are left alone, so an
 * untouched margin keeps its exact original text.
 */
export function layoutOverrides(
  layout: OdtStyle | undefined,
  before: SectionSettings,
  after: SectionSettings,
): LayoutOverrides {
  const out: LayoutOverrides = { page: {}, header: {}, footer: {} }
  const p = layout?.properties[LAYOUT_PROPS] ?? {}
  if (after.pageWidth !== before.pageWidth)
    out.page['fo:page-width'] = twipsToLength(after.pageWidth)
  if (after.pageHeight !== before.pageHeight)
    out.page['fo:page-height'] = twipsToLength(after.pageHeight)
  if (after.orientation !== before.orientation)
    out.page['style:print-orientation'] = after.orientation
  if (after.marginLeft !== before.marginLeft)
    out.page['fo:margin-left'] = twipsToLength(after.marginLeft)
  if (after.marginRight !== before.marginRight)
    out.page['fo:margin-right'] = twipsToLength(after.marginRight)
  const vertical = (kind: 'header' | 'footer') => {
    const side = kind === 'header' ? 'top' : 'bottom'
    const edge = kind === 'header' ? 'marginTop' : 'marginBottom'
    const dist = kind === 'header' ? 'headerDist' : 'footerDist'
    if (after[edge] === before[edge] && after[dist] === before[dist]) return
    const b = band(layout, kind)
    const oldMargin = margin(p, side) ?? DEFAULTS.margin
    const body = after[edge]
    let newMargin: number
    let newHeight = 0
    if (b.present) {
      const distance = after[dist] ?? before[dist] ?? oldMargin
      newMargin = Math.max(0, Math.min(distance, body - b.spacing))
      newHeight = Math.max(0, body - b.spacing - newMargin)
    } else newMargin = Math.max(0, body)
    if (Math.abs(newMargin - oldMargin) >= 0.5)
      out.page[`fo:margin-${side}`] = twipsToLength(newMargin)
    if (b.present && Math.abs(newHeight - b.height) >= 0.5)
      out[kind][b.heightAttr] = twipsToLength(newHeight)
  }
  vertical('header')
  vertical('footer')
  return out
}

/** The ODF lengths (twips, unrounded) a geometry implies for a layout: for round-trip checks. */
export function odfLengths(
  layout: OdtStyle | undefined,
  settings: SectionSettings,
): { top: number; bottom: number; headerHeight: number; footerHeight: number } {
  const split = (kind: 'header' | 'footer') => {
    const b = band(layout, kind)
    const body = kind === 'header' ? settings.marginTop : settings.marginBottom
    const dist = (kind === 'header' ? settings.headerDist : settings.footerDist) ?? body
    if (!b.present) return { margin: body, height: 0 }
    const m = Math.max(0, Math.min(dist, body - b.spacing))
    return { margin: m, height: Math.max(0, body - b.spacing - m) }
  }
  const h = split('header')
  const f = split('footer')
  return { top: h.margin, bottom: f.margin, headerHeight: h.height, footerHeight: f.height }
}
