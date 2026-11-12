/**
 * Element insertion — synthesizes a raw <p:sp> fragment and hangs it on
 * slide.elements.
 *
 * Naturally compatible with patch-based saving: a new element's
 * anchor.originalXml is the generated XML, which patchSlideXml includes when
 * splicing elements together; deletion is removal from the array.
 * Both change the spTree structure, driving a full-slide rebuild via
 * slide.structureDirty.
 */
import type { EmuRect, Paragraph, PictureElement, Slide, SlideElement, TextElement } from './types'
import type { OpenedPptx } from './index'
import { call, slideIndex } from './engine'

/**
 * 'textbox' is a special value (plain text box without prstGeom); anything else is
 * an OOXML preset geometry name (rect/roundRect/ellipse/triangle/star5/rightArrow/
 * chevron…). Presets whose polygon approximation the render layer hasn't
 * implemented fall back to a rectangle; always correct in PowerPoint.
 */
export type NewShapeKind = 'textbox' | (string & {})
/**
 * Text-body geometry overrides for generated boxes (pdf2pptx P25): imported
 * absolutely-positioned text must not inherit PowerPoint's default insets
 * (0.1in/0.05in) or wrap defaults, or every box drifts off its measured spot.
 */
export interface NewElementBodyPr {
  /** wrap="none" lets a measured line overflow instead of re-wrapping */
  wrap?: 'square' | 'none'
  /** vertical anchor (default top) */
  anchor?: 't' | 'ctr' | 'b'
  /** lIns/tIns/rIns/bIns (EMU); absent keeps PowerPoint defaults */
  insetsEmu?: { l: number; t: number; r: number; b: number }
  /** <a:normAutofit/> (shrink text on overflow) or <a:spAutoFit/> (grow the shape) */
  autoFit?: 'shrink' | 'resize'
}
export interface NewElementOptions {
  kind: NewShapeKind
  offset: EmuRect
  paragraphs?: Paragraph[]
  /** Solid shape fill (#RRGGBB, or #RRGGBBAA for translucency); textbox has no fill by default */
  fillColor?: string
  /** Shape stroke (solid color, width in EMU) */
  stroke?: { color: string; widthEmu: number }
  /** body geometry overrides; absent = `wrap="square" rtlCol="0"` as before */
  bodyPr?: NewElementBodyPr
  /** prstGeom adjustment values (<a:avLst><a:gd name fmla="val N"/>), e.g. {adj: 25000} for roundRect radius */
  adjustments?: Record<string, number>
  /** Mirror horizontally (a:xfrm flipH="1") — a rightArrow points left */
  flipH?: boolean
  /** Mirror vertically (a:xfrm flipV="1") — a line runs bottom-left to top-right */
  flipV?: boolean
}
export function isLineKind(kind: string): boolean {
  return call('isLineKind', [kind]) as never
}
/** Max cNvPr id used in the slide (including new elements); new elements take max+1 */
export function nextCNvPrId(slide: Slide): number {
  return call('nextCNvPrId', [slide]) as never
}
export function buildSpXml(slide: Slide, opts: NewElementOptions): string {
  return call('buildSpXml', [slide, opts]) as never
}
/** Synthesize a new element and hang it on the slide; returns the model element (immediately usable by the render layer). */
export function addElement(slide: Slide, opts: NewElementOptions): TextElement {
  call('addElement', [slide, opts], { mut: { 0: 'json' } })
  return slide.elements.at(-1) as TextElement
}
// ── Table insertion (graphicFrame + a:tbl) ─────────────────────────────

/** Per-cell structural attributes for buildTableXml (merges + vertical anchor). */
export interface NewTableCellProps {
  gridSpan?: number
  rowSpan?: number
  hMerge?: boolean
  vMerge?: boolean
  anchor?: 't' | 'ctr' | 'b'
}
export interface NewTableOptions {
  rows: number
  cols: number
  offset: EmuRect
  /** explicit column widths / row heights (EMU); a length-matched list overrides the equal split */
  colWidthsEmu?: number[]
  rowHeightsEmu?: number[]
  /** row-major per-cell attributes; absent entries = plain cell */
  cellProps?: Array<Array<NewTableCellProps | undefined>>
}
/** Largest row/column count an inserted table may have (PowerPoint's Insert Table limit). */
export const MAX_INSERT_TABLE_DIM = 75
/**
 * Build the table graphicFrame fragment (equal-width columns / equal-height rows,
 * default built-in style, empty cells). Insertion goes through appendRawElements
 * (materialize+reparse), reusing the existing table parsing/rendering pipeline.
 */
export function buildTableXml(slide: Slide, opts: NewTableOptions): string {
  return call('buildTableXml', [slide, opts]) as never
}
// ── Grid table insertion (pdf2pptx P25): explicit widths/heights/merges ──

/** One grid cell of buildTableGridXml. Covered cells (hMerge/vMerge) must still be listed. */
export interface NewTableCellSpec {
  paragraphs?: Paragraph[]
  /** columns this cell spans (a:tc gridSpan), default 1 */
  gridSpan?: number
  /** rows this cell spans (a:tc rowSpan), default 1 */
  rowSpan?: number
  /** covered by a gridSpan cell to the left */
  hMerge?: boolean
  /** covered by a rowSpan cell above */
  vMerge?: boolean
  /** solid cell shading (#RRGGBB) */
  fillColor?: string
  /** vertical content alignment (a:tcPr anchor), default top */
  anchor?: 't' | 'ctr' | 'b'
  /** cell margins (EMU); absent keeps PowerPoint defaults */
  marginsEmu?: { l: number; t: number; r: number; b: number }
}
export interface NewTableGridOptions {
  offset: EmuRect
  colWidthsEmu: number[]
  rowHeightsEmu: number[]
  /** row-major; every row lists one entry per GRID column (merged-covered cells flagged) */
  cells: NewTableCellSpec[][]
  /**
   * uniform cell borders; scope 'all' rules every edge, 'insideV' only the
   * verticals between columns (rule-separated zones); absent = borderless
   */
  border?: { color: string; widthEmu: number; scope?: 'all' | 'insideV' }
}
/**
 * Build a table graphicFrame with explicit column widths, row heights, merged
 * cells, per-cell shading/anchor/margins and uniform borders — what a measured
 * PDF table needs (buildTableXml only makes uniform empty grids). No
 * tableStyleId on purpose: styling is fully explicit, so the deck's theme
 * cannot repaint the imported table. Insert via appendRawElements.
 */
export function buildTableGridXml(slide: Slide, opts: NewTableGridOptions): string {
  return call('buildTableGridXml', [slide, opts]) as never
}
export interface NewPictureOptions {
  /** Image bytes */
  bytes: Uint8Array
  /** Lowercase extension (png/jpg/…) */
  ext: string
  offset: EmuRect
  /** cNvPr name (default Picture N; hand-drawn ink is marked with the aislides-ink prefix) */
  name?: string
  /** cNvPr descr: editor-specific payload (e.g. ink vector points), recoverable on reopen */
  descr?: string
}
export function addImageMediaAndRel(
  opened: OpenedPptx,
  slide: Slide,
  bytes: Uint8Array,
  extRaw: string,
): { rid: string; mediaPath: string } | null {
  return call('addImageMediaAndRel', [opened, slideIndex(opened, slide), bytes, extRaw], { mut: { 0: 'opened' } }) as never
}
export function addPicture(
  opened: OpenedPptx,
  slide: Slide,
  opts: NewPictureOptions,
): PictureElement | null {
  const at = slideIndex(opened, slide)
  return call('addPicture', [opened, at, opts], { mut: { 0: 'opened' }, names: ["opened","at","opts"] }) as never === null ? null : (opened.deck.slides[at]!.elements.at(-1) as PictureElement)
}
/**
 * Delete by element id and collect relationships/resources no longer used by any
 * retained package part. The OpenedPptx context is required because media may be
 * shared by other objects or slides.
 */
export function deleteElement(opened: OpenedPptx, slide: Slide, elementId: string): boolean {
  return call('deleteElement', [opened, slideIndex(opened, slide), elementId], { mut: { 0: 'opened' } }) as never
}
// ── Grouping (p:grpSp) ──────────────────────────────────────────────────────

/**
 * Compute the bounding box of a set of elements (slide coordinates, EMU).
 * Ignores rotation: uses the axis-aligned bounding box of each element's offset
 * rect.
 */
export function calcBoundingBox(elements: SlideElement[]): EmuRect {
  return call('calcBoundingBox', [elements]) as never
}
/**
 * Build the <p:grpSp> XML fragment.
 *
 * OOXML conventions (ECMA 376 §19.3.1.22):
 *  - grpSpPr/xfrm describes the group's position and size on the slide (<a:off>/<a:ext>)
 *  - grpSpPr/xfrm/chOff + chExt define the child coordinate system's origin and size
 *  - This implementation sets chOff == bbox.xy and chExt == bbox.cxcy, i.e. the child
 *    coordinate system is 1:1 with the slide's → child elements can reuse their
 *    original slide coordinates inside the group with no transform
 *  - childrenXml: concatenation of each child's raw XML fragment (passthrough
 *    children keep their original bytes)
 */
export function buildGrpSpXml(slide: Slide, bbox: EmuRect, childrenXml: string): string {
  return call('buildGrpSpXml', [slide, bbox, childrenXml]) as never
}