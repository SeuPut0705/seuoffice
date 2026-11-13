/**
 * Table style editing — surgically patches <a:tblPr> style attributes
 * (firstRow/bandRow/tableStyleId) and each cell's <a:tcPr> fill/borders.
 *
 * Design philosophy: reuse the existing anchor.originalXml surgical-patch pattern,
 * replacing only the <a:tblPr> and <a:tcPr> nodes and keeping all other bytes
 * intact. Tables are "modeled" in this app (not passthrough), so editing is allowed.
 */
import type { Slide } from './types'
import { call } from './engine'

/** Table style edit parameters (engine side of the IPC EditTableStyleOp) */
export interface TableStyleEdit {
  /** Whole-block tblPr XML replacement applied directly (used for styleName presets) */
  tblPrXml?: string
  /** Change only the firstRow flag */
  firstRow?: boolean
  /** Change only the bandRow flag */
  bandRow?: boolean
  lastRow?: boolean
  firstCol?: boolean
  lastCol?: boolean
  bandCol?: boolean
  /** Replace a:tableStyleId (a built-in GUID or a custom style id already in tableStyles.xml), keeping the rest of tblPr */
  styleId?: string
  /** Right-to-left table (tblPr rtl: mirrored grid); false removes the attribute */
  rtl?: boolean
  /** Shading color #RRGGBB or 'none' (<a:solidFill> / <a:noFill> per tc) */
  shadingColor?: string | null
  /** Border color + width (all = all borders; none = clear) */
  borderColor?: string | null
  borderWidthEmu?: number | null
  borderPreset?: 'all' | 'none' | null
  /** Clear all tcPr direct fills/borders (what PowerPoint does when applying a gallery preset; otherwise direct cell formatting hides the style) */
  clearDirectFormatting?: boolean
  /** Cells the shading/border edit applies to, as (row, tc index); undefined = whole table */
  cells?: Array<{ row: number; col: number }>
}
// ── Preset styles ────────────────────────────────────────────────────
// Color presets do not reference PowerPoint built-in style GUIDs (built-ins follow
// the file theme's accent colors, so a "dark blue header" would come out orange in
// an orange theme). Instead, fixed-color custom <a:tblStyle> definitions are
// written into ppt/tableStyles.xml — the button swatch, this app's rendering, and
// PowerPoint all agree.

const inLn = (tag: 'insideH' | 'insideV', color: string) =>
  `<a:${tag}><a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></a:${tag}>`
/** Style XML for one table region (wholeTbl/band1H/firstRow…). */
function partXml(
  tag: string,
  o: { fill?: string; text?: string; bold?: boolean; insideH?: string; insideV?: string },
): string {
  const tx =
    o.text || o.bold
      ? `<a:tcTxStyle${o.bold ? ' b="on"' : ''}>${o.text ? `<a:srgbClr val="${o.text}"/>` : ''}</a:tcTxStyle>`
      : ''
  const bdr =
    o.insideH || o.insideV
      ? `<a:tcBdr>${o.insideH ? inLn('insideH', o.insideH) : ''}${o.insideV ? inLn('insideV', o.insideV) : ''}</a:tcBdr>`
      : ''
  const fill = o.fill
    ? `<a:fill><a:solidFill><a:srgbClr val="${o.fill}"/></a:solidFill></a:fill>`
    : ''
  const tc = bdr || fill ? `<a:tcStyle>${bdr}${fill}</a:tcStyle>` : ''
  return `<a:${tag}>${tx}${tc}</a:${tag}>`
}
/** Fixed-color banded/header style (band = alternate-row shading; header = header fill). */
function customStyle(
  styleId: string,
  name: string,
  o: { band?: string; header?: { fill: string; text: string }; insideH?: string; whole?: string },
): string {
  // CT_TableStyle child order: wholeTbl → band1H → … → firstRow
  return (
    `<a:tblStyle styleId="${styleId}" styleName="${name}">` +
    partXml('wholeTbl', { text: '000000', fill: o.whole, insideH: o.insideH }) +
    (o.band ? partXml('band1H', { fill: o.band }) : '') +
    partXml('firstRow', {
      bold: true,
      ...(o.header ? { fill: o.header.fill, text: o.header.text } : {}),
    }) +
    '</a:tblStyle>'
  )
}
const ID_ZEBRA_BLUE = '{A10FF1CE-0000-4000-9000-000000000001}'
const ID_ZEBRA_GRAY = '{A10FF1CE-0000-4000-9000-000000000002}'
const ID_HEADER_DARKBLUE = '{A10FF1CE-0000-4000-9000-000000000003}'
const ID_HEADER_ORANGE = '{A10FF1CE-0000-4000-9000-000000000004}'
const ID_NO_BORDER = '{A10FF1CE-0000-4000-9000-000000000005}'
export interface TableStylePreset {
  tblPrXml: string
  description: string
  /** Custom style: must first be ensured into ppt/tableStyles.xml */
  styleId?: string
  styleDefXml?: string
  /** Grid presets: add border lines to every cell directly (incl. outer frame; the style mechanism only covers inner lines) */
  border?: { color: string; widthEmu: number }
}
const tblPr = (styleId: string, flags = '') =>
  `<a:tblPr${flags}><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>`
// Official "No Style, No Grid" GUID (we previously misused a made-up ...307D; the read side stays compatible with it)
const NO_STYLE = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'
/** The 8 preset styles (keys map to the ribbon style gallery). */
export const TABLE_STYLE_PRESETS: Record<string, TableStylePreset> = {
  none: { tblPrXml: tblPr(NO_STYLE), description: 'No style' },
  lightGrid: {
    tblPrXml: tblPr(NO_STYLE),
    description: 'Light grid',
    border: { color: '#BFBFBF', widthEmu: 12700 },
  },
  zebraBlue: {
    tblPrXml: tblPr(ID_ZEBRA_BLUE, ' firstRow="1" bandRow="1"'),
    description: 'Banded blue',
    styleId: ID_ZEBRA_BLUE,
    styleDefXml: customStyle(ID_ZEBRA_BLUE, 'Banded blue', {
      whole: 'FFFFFF',
      band: 'D6E4F0',
      header: { fill: '4472C4', text: 'FFFFFF' },
    }),
  },
  zebraGray: {
    tblPrXml: tblPr(ID_ZEBRA_GRAY, ' firstRow="1" bandRow="1"'),
    description: 'Banded gray',
    styleId: ID_ZEBRA_GRAY,
    styleDefXml: customStyle(ID_ZEBRA_GRAY, 'Banded gray', {
      whole: 'FFFFFF',
      band: 'EDEDED',
      header: { fill: '595959', text: 'FFFFFF' },
    }),
  },
  headerDarkBlue: {
    tblPrXml: tblPr(ID_HEADER_DARKBLUE, ' firstRow="1"'),
    description: 'Dark blue header',
    styleId: ID_HEADER_DARKBLUE,
    styleDefXml: customStyle(ID_HEADER_DARKBLUE, 'Dark blue header', {
      whole: 'FFFFFF',
      insideH: 'D9D9D9',
      band: 'E9EDF5',
      header: { fill: '1F3864', text: 'FFFFFF' },
    }),
  },
  headerOrange: {
    tblPrXml: tblPr(ID_HEADER_ORANGE, ' firstRow="1"'),
    description: 'Orange header',
    styleId: ID_HEADER_ORANGE,
    styleDefXml: customStyle(ID_HEADER_ORANGE, 'Orange header', {
      whole: 'FFFFFF',
      insideH: 'D9D9D9',
      band: 'FBE5D6',
      header: { fill: 'ED7D31', text: 'FFFFFF' },
    }),
  },
  noBorder: {
    tblPrXml: tblPr(ID_NO_BORDER, ' firstRow="1" bandRow="1"'),
    description: 'Minimal (no borders)',
    styleId: ID_NO_BORDER,
    styleDefXml: customStyle(ID_NO_BORDER, 'Minimal (no borders)', { band: 'F2F2F2' }),
  },
  fullBorder: {
    tblPrXml: tblPr(NO_STYLE),
    description: 'All borders',
    border: { color: '#000000', widthEmu: 12700 },
  },
}
/** Ensure the given style definition exists in tableStyles.xml; returned as-is if already present. */
export function ensureTableStyleXml(
  tableStylesXml: string | null | undefined,
  styleId: string,
  styleDefXml: string,
): string {
  return call('ensureTableStyleXml', [tableStylesXml, styleId, styleDefXml]) as never
}
/**
 * Surgically patch a table element's originalXml (graphicFrame fragment), applying
 * the style edit. Returns the patched XML; the caller writes it back to
 * anchor.originalXml and sets dirty = true.
 */
export function patchTableStyleXml(originalXml: string, edit: TableStyleEdit): string {
  return call('patchTableStyleXml', [originalXml, edit]) as never
}
/** Find the table element with the given sourceId in the slide; returns its anchor.originalXml location. */
export function findTableElementInSlide(
  slide: Slide,
  sourceId: string,
): import('./types').TableElement | null {
  const i = call('findTableElementInSlide', [slide, sourceId]) as never as number | null
  return i === null ? null : (slide.elements[i] as never)
}
