import { ContentControlPart } from './inline-control-ids'
import type { GeneratedBlock, ImageWrap, ParaFormat, Run, TableModel } from './types'
import { invoke } from './engine'

export interface GenerateContext {
  /** heading level -> styleId existing in the original styles.xml */
  headingStyleIds: Map<number, string>
  /** styleId for list paragraphs, if present in the original doc */
  listParagraphStyleId?: string
  /** allocate a new relationship id for a hyperlink target; returns rId */
  allocateHyperlinkRel: (href: string) => string
  /**
   * Mint the w:bookmarkStart/@w:id for a bookmark name. w:id must be unique in
   * the part, so a caller writing into an existing document supplies an
   * allocator seeded above that part's highest id. Without one (a fragment
   * rendered outside any document) ids come from a process counter, which
   * keeps them unique among themselves but is not coordinated with a part.
   */
  allocateBookmarkId?: (name: string) => number
  /** Mint w:id for a tracked change that has none; document-wide so two edited paragraphs never share ids */
  allocateRevisionId?: () => string
  /**
   * The part the block is written into. With it the run writer checks that
   * the part root declares the prefixes of the bytes a run carries, and marks
   * the controls it writes from runs so the part can let a repeated id give
   * way (ContentControlPart.finish, which the caller runs over the part).
   */
  part?: ContentControlPart
}
export interface ImagePatch {
  /** new display size in CSS px; rewrites wp:extent and pic a:ext */
  widthPx?: number
  heightPx?: number
  /** paragraph alignment; null/'left' removes w:jc, undefined keeps as-is */
  align?: 'left' | 'center' | 'right' | null
  /**
   * New horizontal/vertical posOffset (in EMU) for floating images. Rewrites
   * the <wp:posOffset> inside wp:positionH / wp:positionV.
   * Ignored when the anchor uses <wp:align> instead of <wp:posOffset>.
   */
  posOffsetX?: number
  posOffsetY?: number
  /** rotation in degrees clockwise; 0 removes the rot attribute; undefined keeps */
  rotDeg?: number
  /** mirror flips; false removes the attribute; undefined keeps */
  flipH?: boolean
  flipV?: boolean
}
/**
 * Rewrite the display size (wp:extent + a:xfrm a:ext) and/or paragraph
 * alignment (w:jc) of an image paragraph, leaving everything else untouched.
 */
export function patchImageParagraphXml(xml: string, patch: ImagePatch): string {
  return invoke('patchImageParagraphXml', [xml, patch]) as never
}
/**
 * Re-encode ONLY the stacking rank of an existing wp:anchor as Word's
 * base + rank relativeHeight. Everything else — position basis (relativeFrom),
 * wrap element, distances — keeps its original bytes, so a picture never
 * shifts from a pure reorder (or from the save-time harmonization of wild
 * producer values). No-op on inline images (no wp:anchor).
 */
export function applyImageZOrder(xml: string, zOrder?: number): string {
  return invoke('applyImageZOrder', [xml, zOrder]) as never
}
/**
 * Switch an image paragraph between inline (in line with text, wrap = null) and floating
 * (wp:anchor with the given wrap mode). Position/wrap elements are rebuilt;
 * extent, docPr and the pic graphic stay untouched.
 *
 * When `posOffset` is provided, the anchor's positionH/V use numeric
 * `<wp:posOffset>` instead of `<wp:align>`, enabling free-position drag.
 */
export function applyImageWrap(
  xml: string,
  wrap: ImageWrap | null,
  posOffset?: { x: number; y: number; relativeTo?: 'page' | 'margin' },
  marginAlign?: { h: 'left' | 'center' | 'right'; v: 'top' | 'center' | 'bottom' },
  zOrder?: number,
): string {
  return invoke('applyImageWrap', [xml, wrap, posOffset, marginAlign, zOrder]) as never
}
/** How a caller addresses one shape drawing: by its cNvPr id when known, else by box ordinal. */
export interface ShapeDrawingLocation {
  /** wps:cNvPr (or pic:cNvPr for a photo box) id of the owning shape (parsed boxes carry it) */
  shapeId?: string
  /** fallback ordinal among box drawings (generated shapes have no id) */
  boxIndex: number
}
/**
 * Re-encode ONLY the stacking rank of one shape drawing as Word's base + rank
 * relativeHeight. Everything else keeps its bytes, like applyImageZOrder.
 */
export function applyShapeZOrderAt(
  paragraphXml: string,
  location: ShapeDrawingLocation,
  zOrder: number,
): string {
  return invoke('applyShapeZOrderAt', [paragraphXml, location, zOrder]) as never
}
/**
 * Switch one shape drawing's wrap mode in place, preserving its positionH/V
 * bytes: only the anchor attributes, the wrap element and (when given)
 * relativeHeight change. `wrap === null` converts the anchor to inline.
 */
export function applyShapeWrapAt(
  paragraphXml: string,
  location: ShapeDrawingLocation,
  wrap: ImageWrap | null,
  zOrder?: number,
): string {
  return invoke('applyShapeWrapAt', [paragraphXml, location, wrap, zOrder]) as never
}
/**
 * Switch the wrap mode of an existing wp:anchor drawing in place: only the
 * wrap element, behindDoc and (when given) relativeHeight change, so the
 * positionH/V bytes keep the object where it was.
 */
export function swapAnchorWrap(drawingXml: string, wrap: ImageWrap, zOrder?: number): string {
  return invoke('swapAnchorWrap', [drawingXml, wrap, zOrder]) as never
}
export interface FieldTextPatch {
  left?: string
  right?: string
}
/**
 * Patch only cached visible w:t text in a field paragraph. Field instructions,
 * hyperlinks, tabs, run styling, and field boundaries remain byte-identical.
 */
export function patchFieldParagraphXml(xml: string, patch: FieldTextPatch): string {
  return invoke('patchFieldParagraphXml', [xml, patch]) as never
}
/**
 * Patch OMML leaf token text without rebuilding its structural math nodes.
 * Token count must stay unchanged so fractions, scripts, matrices, and styling
 * remain exactly as authored by Word.
 */
export function patchMathTokens(xml: string, tokens: readonly string[]): string {
  return invoke('patchMathTokens', [xml, tokens]) as never
}
// ---- table cell text patching ----

/** top-level segments of `tag` between [from, to), depth-aware for nesting */
export function xmlSegments(
  xml: string,
  tag: string,
  from: number,
  to: number,
): Array<{ start: number; end: number }> {
  const openPrefix = '<' + tag
  const closeTag = '</' + tag + '>'
  const segs: Array<{ start: number; end: number }> = []
  let depth = 0
  let segStart = -1
  let i = from
  while (i < to) {
    const o = xml.indexOf(openPrefix, i)
    const c = xml.indexOf(closeTag, i)
    const hasOpen = o !== -1 && o < to
    const hasClose = c !== -1 && c < to
    // a trailing self-closing element (Word's empty <w:p/>) has no close tag after it
    if (!hasOpen && !hasClose) break
    if (hasOpen && (!hasClose || o < c)) {
      const after = xml.charAt(o + openPrefix.length)
      if (after !== '>' && after !== ' ' && after !== '/') {
        i = o + openPrefix.length // prefix of a longer tag (w:tr vs w:trPr)
        continue
      }
      const gt = xml.indexOf('>', o)
      if (gt !== -1 && xml.charAt(gt - 1) === '/') {
        if (depth === 0) segs.push({ start: o, end: gt + 1 }) // self-closing
        i = gt + 1
        continue
      }
      if (depth === 0) segStart = o
      depth++
      i = o + openPrefix.length
    } else if (depth === 0) {
      break
    } else {
      depth--
      if (depth === 0) segs.push({ start: segStart, end: c + closeTag.length })
      if (depth < 0) break
      i = c + closeTag.length
    }
  }
  return segs
}
/** one cell paragraph: control-char text (legacy first-run-rPr rebuild), rich runs, or null = keep the original paragraph bytes */
export type CellParaPatch =
  | string
  | {
      runs: Run[]
      /** pre-rendered run XML (fields etc.) used instead of runsXml(runs) */
      xml?: string
      /** paragraph format: only the pPr groups that differ from `original` are rebuilt (mergeCellParaFormat) */
      format?: ParaFormat
      original?: ParaFormat
    }
  | null
/** per-cell patch: paragraph patches, or nested-table cell texts by nested index */
export type CellTextsPatch =
  | readonly CellParaPatch[]
  | {
      /** this cell's own text (optional; rewriting the outer text of a cell containing a nested table is not supported yet) */
      paras?: readonly string[] | null
      /** one cell grid per direct nested table (null = leave that nested table untouched) */
      nested?: ReadonlyArray<ReadonlyArray<
        ReadonlyArray<readonly CellParaPatch[] | null | undefined> | null | undefined
      > | null>
    }
/**
 * Replace cell texts inside a <w:tbl> fragment.
 * `texts[row][cell]` = new paragraph strings for that cell (or a CellTextsPatch
 * carrying nested-table cell texts), or null/undefined to leave the cell
 * untouched. Indexes follow document order of w:tr / w:tc (matching
 * TableModel.rows, which includes vMerge-continue cells).
 */
export function patchTableCellTexts(
  tableXml: string,
  texts: ReadonlyArray<ReadonlyArray<CellTextsPatch | null | undefined> | null | undefined>,
  _part?: ContentControlPart,
): string {
  return invoke('patchTableCellTexts', [tableXml, texts]) as never
}
// ---- textbox paragraph patching ----

/**
 * Replacement content for one textbox paragraph. `runs` carry the full rich
 * style (bold, color, size, ...) and are regenerated as fresh OOXML runs.
 * `align`: undefined keeps the original pPr untouched, null removes w:jc,
 * a value rewrites it.
 */
export interface TextboxParaPatch {
  runs: Run[]
  align?: 'left' | 'center' | 'right' | 'justify' | 'distribute' | null
  /** list membership write-back: sets or clears the paragraph's w:numPr.
   * Always explicit (null clears) so leaving a list lands in the file. */
  numPr?: { numId: string; ilvl: number } | null
  /** left indent in twips; null clears w:ind/@w:left, undefined keeps the original */
  indentLeft?: number | null
}
/**
 * Text patches for the anchored boxes of one paragraph fragment. `byIndex` is
 * sparse, indexed by TextboxDisplay.txbxIndex — the ordinal of the box's
 * w:txbxContent among all non-fallback segments, empty ones included, so the
 * mapping survives paragraphs that mix text-bearing boxes with ink-only
 * shapes. `inject` carries the first text of shapes that have no
 * w:txbxContent at all, addressed by their wps:cNvPr id.
 */
export interface TextboxParasPatchSet {
  byIndex?: ReadonlyArray<ReadonlyArray<TextboxParaPatch | null | undefined> | null | undefined>
  inject?: ReadonlyArray<{ shapeId: string; paras: TextboxParaPatch[] }>
}
/**
 * Replace textbox paragraphs inside a paragraph fragment that carries
 * anchored DrawingML textboxes. Word pairs every DrawingML shape with a VML
 * twin inside mc:Fallback whose w:txbxContent duplicates the content —
 * fallback copies are patched with the same paragraphs as the preceding
 * visible box so both renderings stay in sync.
 */
export function patchTextboxParas(paragraphXml: string, patches: TextboxParasPatchSet): string {
  return invoke('patchTextboxParas', [paragraphXml, patches]) as never
}
/** Resize fixed DrawingML textboxes while preserving their anchors and styling. */
export function patchTextboxHeights(
  paragraphXml: string,
  heightsPx: ReadonlyArray<number | null | undefined>,
): string {
  return invoke('patchTextboxHeights', [paragraphXml, heightsPx]) as never
}
export interface TextboxSizePatch {
  wPx?: number | null
  hPx?: number | null
}
/** Resize fixed DrawingML textboxes/shapes while preserving anchors and styling. */
export function patchTextboxSizes(
  paragraphXml: string,
  sizes: ReadonlyArray<TextboxSizePatch | null | undefined>,
): string {
  return invoke('patchTextboxSizes', [paragraphXml, sizes]) as never
}
export interface ShapeStylePatch {
  /** solid fill hex without '#'; null = a:noFill; undefined = keep */
  fillHex?: string | null
  /** outline color hex without '#'; null = no outline; undefined = keep */
  borderHex?: string | null
  /** rotation in degrees clockwise; null or 0 clears a:xfrm@rot; undefined = keep */
  rotDeg?: number | null
  /** outline width in CSS px (a:ln@w = px * 9525 EMU); null clears the attribute; undefined = keep */
  borderWidthPx?: number | null
}
/** Recolor floating shapes/textboxes/lines (same drawing set as extractTextboxes). */
export function patchShapeStyles(
  paragraphXml: string,
  styles: ReadonlyArray<ShapeStylePatch | null | undefined>,
): string {
  return invoke('patchShapeStyles', [paragraphXml, styles]) as never
}
/** Rewrite the first drawing's extent (chart/SmartArt graphicFrame paragraphs). */
export function patchDrawingExtent(paragraphXml: string, wPx: number, hPx: number): string {
  return invoke('patchDrawingExtent', [paragraphXml, wPx, hPx]) as never
}
/** Insertable line/connector kinds: stroke-only wps:wsp with optional arrow ends */
export const LINE_KINDS: Record<string, { prst: string; head?: boolean; tail?: boolean }> = {
  line: { prst: 'line' },
  lineArrow: { prst: 'straightConnector1', tail: true },
  lineArrowDouble: { prst: 'straightConnector1', head: true, tail: true },
  lineBent: { prst: 'bentConnector3' },
  lineCurved: { prst: 'curvedConnector3' },
}
/** Insert a floating stroke-only line/connector paragraph (wp:anchor + wps:wsp). */
export function buildLineParagraphXml(opts: {
  kind: string
  widthEmu?: number
  heightEmu?: number
  id?: number
  colorHex?: string
}): string {
  return invoke('buildLineParagraphXml', [opts]) as never
}
/** CT_PPr child sequence (subset), for schema-ordered assembly and merging */
export const PPR_CHILD_ORDER = [
  'w:pStyle',
  'w:keepNext',
  'w:keepLines',
  'w:pageBreakBefore',
  'w:framePr',
  'w:widowControl',
  'w:numPr',
  'w:suppressLineNumbers',
  'w:pBdr',
  'w:shd',
  'w:tabs',
  'w:suppressAutoHyphens',
  'w:kinsoku',
  'w:wordWrap',
  'w:overflowPunct',
  'w:topLinePunct',
  'w:autoSpaceDE',
  'w:autoSpaceDN',
  'w:bidi',
  'w:adjustRightInd',
  'w:snapToGrid',
  'w:spacing',
  'w:ind',
  'w:contextualSpacing',
  'w:mirrorIndents',
  'w:suppressOverlap',
  'w:jc',
  'w:textDirection',
  'w:textAlignment',
  'w:textboxTightWrap',
  'w:outlineLvl',
  'w:divId',
  'w:cnfStyle',
  'w:rPr',
  'w:sectPr',
  'w:pPrChange',
]
interface PPrChild {
  name: string
  xml: string
}
/** top-level child elements of an XML fragment (depth-aware, attrs kept) */
export function splitXmlChildren(xml: string): PPrChild[] {
  return (invoke('splitXmlChildren', [xml]) as Array<[string, string]>).map(([name, child]) => ({
    name,
    xml: child,
  }))
}
/**
 * Paragraph format edit inside a layout-table cell: only the groups whose
 * fields differ from `original` are rewritten, so unmodeled pPr children
 * (bidi, borders, shading, page break) and style-resolved values the editor
 * merely reports stay as they were. w:jc / w:tabs go through mergePPrFormat;
 * w:ind / w:spacing merge attribute-wise so their unmodeled attributes survive.
 */
export function mergeCellParaFormat(
  rawPPr: string,
  format: ParaFormat,
  original: ParaFormat | undefined,
): string {
  return invoke('mergeCellParaFormat', [rawPPr, format, original]) as never
}
export function mergePPrFormat(
  rawPPr: string,
  format: ParaFormat | undefined,
  original?: ParaFormat,
  /** restrict the managed groups (others keep their raw bytes whatever the format says) */
  onlyTags?: ReadonlySet<string>,
): string {
  return invoke('mergePPrFormat', [rawPPr, format, original, onlyTags]) as never
}
/**
 * Strip <w:pPrChange>...</w:pPrChange> from a raw <w:pPr> slice.
 * Used when the editor accepts or rejects a paragraph-property revision,
 * so the saved file no longer contains the pPrChange record.
 */
/** hex color of the paragraph mark (pPr/rPr w:color), ignoring the pPrChange history */
export function paraMarkColor(rawPPr: string): string | undefined {
  return invoke('paraMarkColor', [rawPPr], { undef: true }) as never
}
/**
 * Drop the paragraph mark's w:color (pPr/rPr). Word types new text at the end
 * of a paragraph in the mark's formatting, so a mark left red after every red
 * run was recolored would resurrect the red on the next keystroke.
 */
export function stripParaMarkColor(rawPPr: string): string {
  return invoke('stripParaMarkColor', [rawPPr]) as never
}
/**
 * w:del / w:ins marker for a paragraph mark the editor tracked ('' when the
 * record is absent or malformed). Without an allocator the id is left empty
 * for fillRevisionIds to mint at save, like row/cell revisions.
 */
export function paraMarkRevisionXml(
  kind: 'del' | 'ins',
  record: string | null | undefined,
  mintId: () => string = () => '',
): string {
  return invoke('paraMarkRevisionXml', [kind, record, mintId], {
    names: ['kind', 'record', 'mintId'],
  }) as never
}
/** add a tracked paragraph-mark marker to raw pPr bytes (the mark's rPr opens with the revision markers) */
export function setParaMarkRevision(rawPPr: string, markerXml: string): string {
  return invoke('setParaMarkRevision', [rawPPr, markerXml]) as never
}
/** drop the paragraph mark's tracked w:del / w:ins record (pPr/rPr) once the revision is accepted or rejected */
export function stripParaMarkRevision(rawPPr: string, kind: 'del' | 'ins'): string {
  return invoke('stripParaMarkRevision', [rawPPr, kind]) as never
}
/**
 * Resolve the paragraph mark's tracked formatting change (pPr/rPr/rPrChange):
 * accept drops the record, reject puts the recorded old rPr back (the mark's
 * own ins/del/move markers stay).
 */
export function resolveParaMarkRPrChange(rawPPr: string, mode: 'accept' | 'reject'): string {
  return invoke('resolveParaMarkRPrChange', [rawPPr, mode]) as never
}
export function stripPPrChange(rawPPr: string): string {
  return invoke('stripPPrChange', [rawPPr]) as never
}
/**
 * Insert or replace the live paragraph-property revision in a raw pPr slice.
 * The revision is last in CT_PPr schema order.
 */
export function setPPrChange(rawPPr: string, changeJson: string): string {
  return invoke('setPPrChange', [rawPPr, changeJson]) as never
}
/**
 * Generate an OOXML <w:p> fragment for an edited/new block.
 * Only references styles that already exist in the original document, so the
 * patched file never needs styles.xml modifications. When `rawPPr` is set the
 * paragraph properties pass through byte-identical instead of being rebuilt.
 */
export function generateParagraphXml(block: GeneratedBlock, ctx: GenerateContext): string {
  return invoke('generateParagraphXml', [block, { ...ctx, part: undefined }], {
    names: ['block', 'ctx'],
  }) as never
}
export interface TableGenOptions {
  /**
   * Style the first row as a header: light shading plus an empty bold run.
   * The bold run matters because patchTableCellTexts reuses the first run's
   * rPr when it fills in cell texts, so header texts come out bold.
   */
  headerRow?: boolean
}
/** shading fill used for generated table header rows (hex without '#') */
export const TABLE_HEADER_FILL = 'F2F2F2'
export function generateTableModelXml(
  model: TableModel,
  originalTableXml?: string,
  _part?: ContentControlPart,
): string {
  return invoke('generateTableModelXml', [model, originalTableXml]) as never
}
/** rId / docPr placeholder of a picture inserted by the editor; saveDocx resolves
 *  it against SaveOptions.newPictures once the bytes land as a media part */
export const NEW_PICTURE_TOKEN_PREFIX = 'aidocs-new-pic-'
export interface InlinePictureXmlOptions {
  rId: string
  /** wp:docPr / pic:cNvPr id (a placeholder token until the save mints a real one) */
  docPrId: string | number
  widthPx: number
  heightPx: number
  altText?: string
  rotDeg?: number
  flipH?: boolean
  flipV?: boolean
}
/** The drawing re-sized to widthPx x heightPx: wp:extent and the picture's own
 *  a:ext follow (effectExtent is left alone). Unchanged when the extent already
 *  reads these sizes, so an untouched picture saves byte-identical. */
export function resizeInlinePictureXml(xml: string, widthPx: number, heightPx: number): string {
  return invoke('resizeInlinePictureXml', [xml, widthPx, heightPx]) as never
}
/** resizeInlinePictureXml for a floating (wp:anchor) run picture; only a lone
 *  picture: a group's extent does not follow its first picture */
export function resizeAnchoredPictureXml(xml: string, widthPx: number, heightPx: number): string {
  return invoke('resizeAnchoredPictureXml', [xml, widthPx, heightPx]) as never
}
/** `<w:drawing>` of an inline picture (wp:inline + pic:pic), the run and paragraph excluded */
export function inlinePictureDrawingXml(o: InlinePictureXmlOptions): string {
  return invoke('inlinePictureDrawingXml', [o]) as never
}
/**
 * Generate a self-contained w:tbl fragment (inline borders, no style reference),
 * so the patched file never needs styles.xml modifications.
 */
export function generateTableXml(rows: number, cols: number, opts: TableGenOptions = {}): string {
  return invoke('generateTableXml', [rows, cols, opts]) as never
}
export interface TocEntry {
  /** heading level 1-9 */
  level: number
  text: string
  /** page number computed by real pagination (cached text; begin is dirty, so Word still recalculates on open) */
  pageNo?: number
}
/**
 * Generate a real TOC field as one w:p fragment per line. The begin fldChar is
 * marked dirty so Word recalculates entries and page numbers on open; the
 * static entry texts serve as the visible result until then.
 */
export function generateTocFieldXml(entries: TocEntry[]): string[] {
  return invoke('generateTocFieldXml', [entries]) as never
}
/**
 * Caption paragraph: `<label> <SEQ label> <text>`, e.g. "Figure 1 System architecture".
 * The SEQ field is marked dirty so Word renumbers all captions on open; the
 * static number is the visible result until then.
 */
export function generateCaptionXml(label: string, number: number, text: string): string {
  return invoke('generateCaptionXml', [label, number, text]) as never
}
/**
 * INDEX field as one w:p per cached entry line, alphabetically sorted. The
 * begin fldChar is dirty so Word rebuilds entries and page numbers on open.
 * `locale` is the collation of the document's language; a caller that shows the
 * entries itself sorts them the same way, line for line.
 */
export function generateIndexFieldXml(terms: string[], locale = 'zh-CN'): string[] {
  return invoke('generateIndexFieldXml', [terms, locale]) as never
}
export interface RunsXmlOptions {
  /** the content controls already written for this paragraph, shared by a
   *  caller that writes one paragraph's runs in several calls */
  written?: Set<string>
  /** xml written in place of a run (the fields of a header) */
  fragments?: ReadonlyMap<Run, string>
  /** the part the runs are written into (see GenerateContext.part) */
  part?: ContentControlPart
}
/** OOXML runs without relationship allocation (header/footer parts, ...). */
export function inlineRunsXml(runs: Run[], options?: RunsXmlOptions): string {
  const written = options?.written
  const fragments = options?.fragments
    ? [...options.fragments].map(([run, xml]) => [runs.indexOf(run), xml])
    : undefined
  const done = invoke('inlineRunsXml', [runs, written ? [...written] : undefined, fragments]) as {
    xml: string
    written: string[]
  }
  for (const id of done.written) written?.add(id)
  return done.xml
}
/** CT_RPr child sequence (subset), for schema-ordered assembly and merging */
export const RPR_CHILD_ORDER = [
  'w:rStyle',
  'w:rFonts',
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:caps',
  'w:smallCaps',
  'w:strike',
  'w:dstrike',
  'w:outline',
  'w:shadow',
  'w:emboss',
  'w:imprint',
  'w:noProof',
  'w:snapToGrid',
  'w:vanish',
  'w:webHidden',
  'w:color',
  'w:spacing',
  'w:w',
  'w:kern',
  'w:position',
  'w:sz',
  'w:szCs',
  'w:highlight',
  'w:u',
  'w:effect',
  'w:bdr',
  'w:shd',
  'w:fitText',
  'w:vertAlign',
  'w:rtl',
  'w:cs',
  'w:em',
  'w:lang',
  'w:eastAsianLayout',
  'w:specVanish',
  'w:oMath',
  'w:rPrChange',
]
/**
 * Merge the raw rPr slice with the run model: groups whose model value matches the raw
 * encoding keep their original bytes (double underline/themeColor/all four rFonts slots
 * do not degrade); mismatched (edited) groups are rebuilt from the model; children the
 * model does not cover (bdr/em/lang/effects…) are always kept.
 */
export function mergeRPrModel(rawRPr: string, run: Run, insideLink: boolean): string {
  return invoke('mergeRPrModel', [rawRPr, run, insideLink]) as never
}
// ---- new drawing paragraph generators ----

/**
 * Build a minimal <w:p> fragment that contains a floating WPS text-box anchored
 * at the cursor position with the given dimensions.
 *
 * @param widthEmu  horizontal size in EMU  (default ~5 cm = 1800000)
 * @param heightEmu vertical size in EMU    (default ~3 cm = 1080000)
 * @param id        wp:docPr id / name suffix (caller must keep unique)
 * @param fillHex   6-char solid fill hex colour (default "FFFFFF" = white)
 * @param borderHex 6-char border hex colour     (default "000000" = black)
 */
export function buildTextboxParagraphXml(opts?: {
  widthEmu?: number
  heightEmu?: number
  id?: number
  fillHex?: string
  borderHex?: string
}): string {
  return invoke('buildTextboxParagraphXml', [opts]) as never
}
/** one paragraph of anchored-textbox content: real runs plus ParaFormat-owned pPr */
export interface TextboxContentParagraph {
  runs: Run[]
  format?: ParaFormat
}
export interface AnchoredTextboxOptions {
  /**
   * 'paragraph': the box rides its holder paragraph through the flow (card
   * regions); 'page': absolute page coordinates (newsletter regions).
   */
  anchor: 'paragraph' | 'page'
  /**
   * EMU offsets. paragraph anchor: x from the text column, y from the holder
   * paragraph; page anchor: both from the page edges.
   */
  xEmu: number
  yEmu: number
  widthEmu: number
  heightEmu: number
  paragraphs: TextboxContentParagraph[]
  /** wp:docPr id / name suffix (caller must keep unique) */
  id?: number
  /** solid interior fill (RRGGBB); omitted = transparent */
  fillHex?: string
  /** border color (RRGGBB); omitted = no outline */
  borderHex?: string
  /** text insets in EMU; omitted = Word defaults (91440 horizontal / 45720 vertical) */
  insetsEmu?: { l: number; t: number; r: number; b: number }
  /** corner radius in EMU; maps to a:prstGeom roundRect with the matching adj */
  cornerRadiusEmu?: number
  /** written as relativeHeight base + zOrder (P16 z discipline) */
  zOrder?: number
  behindDoc?: boolean
  /** default: paragraph anchor wraps topAndBottom, page anchor wraps none */
  wrap?: 'topAndBottom' | 'none'
  /** exact line height (twips) for the holder <w:p>, so the anchor row adds no visible height */
  holderLineTwips?: number
  /** spacing-before (twips) on the holder <w:p> — the region's slot in the caller's spacing chain */
  holderSpacingBeforeTwips?: number
  /** page-break-before on the holder <w:p> (region starts its page) */
  holderPageBreakBefore?: boolean
}
/**
 * Build a <w:p> holding a floating WPS text box whose content is real,
 * editable w:p paragraphs (P20 region container). Unlike
 * buildTextboxParagraphXml (cursor-position UI insert), this variant takes
 * explicit geometry, fill, insets and z-order — pdf2docx uses it to rebuild
 * measured card/column regions.
 */
export function buildAnchoredTextboxParagraphXml(opts: AnchoredTextboxOptions): string {
  return invoke('buildAnchoredTextboxParagraphXml', [opts]) as never
}
/**
 * Build a <w:p> fragment for a floating WPS shape (prstGeom) with optional
 * text content. Same anchor structure as buildTextboxParagraphXml.
 */
export function buildShapeParagraphXml(opts: {
  prst: string
  widthEmu?: number
  heightEmu?: number
  id?: number
  fillHex?: string
  borderHex?: string
  withTextbox?: boolean
}): string {
  return invoke('buildShapeParagraphXml', [opts]) as never
}
/**
 * Build a <w:p> fragment containing a floating WordArt WPS text box.
 * The shape has no background fill; the text runs carry large size (36pt)
 * and the specified solid color. Style is approximated (no stroke/effects in
 * the saved run — the caller picks a readable solid color) — Word can open
 * the result. Presets live in the UI layer (@seuoffice/ui wordart-presets).
 */
export function buildWordArtParagraphXml(opts: {
  text?: string
  /** 6-digit hex without '#'; defaults to the Office accent blue. */
  colorHex?: string
  italic?: boolean
  widthEmu?: number
  heightEmu?: number
  id?: number
}): string {
  return invoke('buildWordArtParagraphXml', [opts]) as never
}
