/**
 * pptx-engine top-level API.
 *
 * Phase 1 scope: openPptx (parsing) + savePptx's "no changes = byte identical"
 * path (proving fidelity). Element-level patch regeneration is left for Phase 3.
 */
import { PackageArchive, type Relationship } from './zip'
import { type CustGeomPath } from './custgeom'
import { type GradientFillPatch, type SlideTransitionKind, type StrokePatch } from './generate'
import { type NewTableOptions } from './insert'
import type {
  Paragraph,
  PPrDirty,
  SlideDeck,
  Slide,
  SlideElement,
  TextElement,
  GroupElement,
  Stroke,
} from './types'
import { type TableStyleEdit } from './table-edit'
import { type NewChartKind } from './chart-insert'
import { type SlideBundle } from './slide-transfer'
import { cleanupSupersededSlideResources } from './resource-cleanup'
import { call, slideIndex, forgetSnapshot } from './engine'

export * from './types'
export {
  REDACT_EXT_URI,
  hasRedactExtIn,
  readRedactLabel,
  redactExtXml,
  setRedactExt,
  stripRedactExt,
  syncRedactExt,
} from './redaction-xml'
export { cleanupSupersededSlideResources }
export type { ResourceCleanupStats } from './resource-cleanup'
export {
  animClassOf,
  isMediaEffect,
  buildTimingXml,
  DEFAULT_MOTION_PATH,
  elementSpid,
  getSlideAnimations,
  patchSlideTimingIncrementalXml,
  patchSlideTimingXml,
  readSlideTimingXml,
  setSlideAnimations,
  pruneTimingForSpids,
  cNvPrIdsInXml,
  ANIM_EFFECTS,
  ANIM_TRIGGERS,
  ANIM_DIRECTIONS,
  type AnimDirection,
  type AnimClass,
  type AnimEffectKind,
  type AnimTrigger,
  type SlideAnimation,
} from './animation'
export { PackageArchive, PPTX_ZIP_LIMITS, assertZipWithinLimits, resolveTarget } from './zip'
export {
  listEmbeddedFonts,
  eotToSfnt,
  type EmbeddedFontFace,
  type EmbeddedFontStyle,
} from './embedded-fonts'
export { scanSlide, type SlideScan, type SpElement } from './scan'
export {
  parseSlide,
  parseDecorations,
  DEFAULT_BODY_INSETS,
  EMU_PER_PT,
  type ParseContext,
  type DecorationOptions,
} from './parse'
export { tableRowGridCols } from './table-grid'
export { parseTheme, parseClrMap, resolveSchemeColor, type Theme } from './theme'
export {
  patchTextElementXml,
  patchElementXfrm,
  patchElementFill,
  patchElementPPr,
  patchParagraphPPrXml,
  patchElementStroke,
  patchBodyPrAutofit,
  patchPictureSrcRect,
  patchSlideAdvanceTimeXml,
  patchSlideBackgroundXml,
  patchSlideHiddenXml,
  patchSlideShowMasterSpXml,
  patchSlideTransitionXml,
  readSlideAdvanceTimeXml,
  readSlideHiddenXml,
  readSlideTransitionXml,
  removeSlideBackgroundXml,
  generateParagraphXml,
  generateXfrmXml,
  isConnectorXml,
  tagHangulParagraphs,
  tagHangulRun,
  TRANSITION_KINDS,
  type GradientFillPatch,
  type BackgroundImagePatch,
  type SlideTransitionKind,
  type StrokePatch,
} from './generate'
export {
  addElement,
  addPicture,
  addImageMediaAndRel,
  deleteElement,
  buildSpXml,
  buildTableXml,
  buildTableGridXml,
  MAX_INSERT_TABLE_DIM,
  buildGrpSpXml,
  calcBoundingBox,
  type NewElementOptions,
  type NewElementBodyPr,
  type NewPictureOptions,
  type NewShapeKind,
  type NewTableOptions,
  type NewTableCellSpec,
  type NewTableGridOptions,
} from './insert'
export {
  alignRects,
  distributeRects,
  type AlignKind,
  type DistributeKind,
  type AlignRect,
} from './align'
export { createBlankPptx } from './blank'
export {
  BUILTIN_TABLE_STYLES,
  builtinTableStyleName,
  resolveBuiltinTableStyleId,
  type BuiltinTableStyle,
} from './table-style'
export {
  elementCNvPrId,
  elementDurableId,
  ensureCreationId,
  groupChildDurableId,
  matchesElementRef,
  slideDurableId,
} from './identity'
export { promoteSlideBackground, isBackgroundLikeElement } from './background-promote'
export {
  applyThemeToArchive,
  buildColorMap,
  collectExplicitColors,
  patchThemeXml,
  recolorXml,
  remapDeckColors,
  type ThemeSpec,
} from './theme-apply'
export { escapeXmlText, escapeXmlAttr } from './xml-utils'
export {
  custGeomXml,
  parseCustGeom,
  validCustGeomPath,
  CUST_GEOM_PT_COUNT,
  type CustGeomPath,
  type CustGeomPathCmd,
} from './custgeom'
export {
  extractFormat,
  applyFormat,
  type CopiedFormat,
  type ShapeFormat,
  type TextRunFormat,
  type ParagraphFormat,
  type FormatPatchResult,
} from './format-brush'
export { listSlideLayouts, type SlideLayoutInfo, type LayoutPlaceholder } from './layout'
export {
  BUILTIN_LAYOUTS,
  BUILTIN_LAYOUT_PREFIX,
  builtinLayoutInfos,
  ensureBuiltinLayout,
  shouldOfferBuiltinLayouts,
  type BuiltinLayoutDef,
} from './builtin-layouts'
export {
  parsePlaceholderMap,
  resolvePlaceholderTransform,
  parseMasterTextStyles,
  parseLstStyleLevels,
  placeholderStyleChain,
  mergeTextStyleChain,
  type PlaceholderMap,
  type PlaceholderGeom,
  type LevelTextStyle,
  type TextStyleLevels,
  type MasterTextStyles,
} from './placeholder'
export { resolveFontRef } from './theme'
export { resolveColorNode, applyColorMods } from './color'
export {
  parseChartXml,
  type ChartModel,
  type ChartSeries,
  type ChartKind,
  type ChartAxisStyle,
  type ChartDataTable,
} from './chart'
export { parseChartExXml } from './chartex'
export { getSlideNotes, setSlideNotes, notesPathForSlide, unescapeXml } from './notes'
export {
  getSlideComments,
  addSlideComment,
  deleteSlideComment,
  type SlideComment,
} from './comments'
export {
  setElementLink,
  getElementLink,
  getSlideLinks,
  getRunLinks,
  ensureRunLinkRels,
  encodeRunLink,
  decodeRunLink,
  type LinkTarget,
} from './hyperlink'
export { NAMED_ACTIONS, namedActionOf, type NamedAction } from './named-action'
export {
  addChart,
  buildChartSpaceXml,
  writeChartWorkbook,
  type NewChartKind,
  type NewChartOptions,
} from './chart-insert'
export {
  CHART_WORKBOOK_REL_TYPE,
  chartWorkbookParts,
  chartWorkbookXlsx,
  type ChartWorkbookData,
} from './chart-workbook'
export {
  addSmartArt,
  buildSmartArtXml,
  type SmartArtLayout,
  type NewSmartArtOptions,
} from './smartart'
export {
  AM3D_NS,
  MODEL3D_REL_TYPE,
  NO_ROTATION,
  readModel3dRotation,
  type Model3dRotation,
} from './model3d'
export { glbBounds, type GlbBounds } from './glb-bounds'
export {
  addMedia,
  addModel3d,
  setModel3dView,
  model3dPartOf,
  solidPng,
  type NewMediaOptions,
  type NewModel3dOptions,
} from './media-insert'
export {
  addNarration,
  clearNarration,
  narrationSpids,
  setShowNarration,
  NARRATION_NAME,
  type NarrationAudio,
} from './narration'
export { applyHeaderFooter, readHeaderFooter, type HeaderFooterOptions } from './headerfooter'
export {
  getSections,
  setSections,
  addSection,
  renameSection,
  removeSection,
  moveSection,
  moveSlide,
  normalizeSections,
  type SectionInfo,
} from './sections'
export {
  collectSlideBundle,
  importSourceLayout,
  materializeSlideBundle,
  chooseLayout,
  listLayouts,
  type SlideBundle,
  type SlideBundleChain,
} from './slide-transfer'
export {
  patchTableStyleXml,
  findTableElementInSlide,
  ensureTableStyleXml,
  TABLE_STYLE_PRESETS,
  type TableStyleEdit,
  type TableStylePreset,
} from './table-edit'
export { listMasterParts, parseMasterPart, type MasterPartInfo } from './master-edit'
// The following functions are implemented in this file and exposed directly via
// export function (see below): editPictureSrcRect, setSlideBackground,
// setSlideHidden, etc. TypeScript sees export function directly, no need to relist.

export interface OpenedPptx {
  deck: SlideDeck
  archive: PackageArchive
}
export async function openPptx(bytes: Uint8Array): Promise<OpenedPptx> {
  const o = call('openPptx', [bytes], { reply: 'opened' }) as never as {
    deck: SlideDeck
    archive: Parameters<typeof PackageArchive.fromWire>[0]
  }
  return { deck: o.deck, archive: PackageArchive.fromWire(o.archive) }
}
/**
 * Rebuild the deck model from the archive's current entries — same result as
 * openPptx(await savePptx(opened)) without materializing the zip, whose contiguous
 * output buffer fails outright on large decks. Pending edits must already be baked
 * into the entries (commitSaved).
 */
export function reparseDeck(opened: OpenedPptx): OpenedPptx {
  call('reparseDeck', [opened], { mut: { 0: 'opened' } })
  return opened
}
/**
 * Save (element-level patches, Phase 3.3).
 *
 * - With no dirty elements: write original entries back byte-for-byte, producing a
 *   slideN.xml 100% identical to the original.
 * - Slides with dirty elements: rebuild that slideN.xml = bodyPrefix + each element
 *   (dirty ? patch-regenerated : original byte slice) + bodySuffix; all other
 *   entries are copied byte-for-byte.
 * - Non-text elements (pictures/passthrough) don't support content editing yet;
 *   even flagged dirty they use original bytes.
 */
export async function savePptx(opened: OpenedPptx): Promise<Uint8Array> {
  return call('savePptx', [opened], { mut: { 0: 'opened' } }) as never
}
/**
 * Same output as savePptx, written straight to `filePath`.
 *
 * Prefer this for anything that lands on disk: savePptx has to assemble the whole
 * package into one contiguous buffer, which on a large deck fails outright with
 * "Array buffer allocation failed". Streaming keeps peak memory to a chunk at a
 * time. JSZip throws stream errors from inside its own scheduled callbacks, so the
 * stream's 'error' event — not just the returned promise — has to be handled or the
 * throw escapes as an uncaught exception and takes the process down.
 *
 * The stream truncates `filePath` before its first chunk lands, so a caller that
 * replaces an existing deck hands this a sibling temp path and renames it over the
 * deck once the promise resolves (Slides does so through atomicWriteVia); given the
 * deck's own path, a save that dies mid-stream leaves it cut off.
 */
export async function savePptxToFile(opened: OpenedPptx, filePath: string): Promise<void> {
  // The engine builds the zip whole (savePptx); the file is written from that buffer through
  // the same stream, so a stream error still reaches the promise and still drops the snapshot.
  const bytes = await savePptx(opened)
  const { createWriteStream } = await import('node:fs')
  const { Readable } = await import('node:stream')
  const { pipeline } = await import('node:stream/promises')
  try {
    await pipeline(Readable.from([bytes]), createWriteStream(filePath))
  } catch (err) {
    forgetSnapshot(opened)
    throw err
  }
}
/**
 * Sync the in-memory model with what savePptx/savePptxToFile just wrote, without
 * the full reopen (readFile + sha256 + unzip + reparse) that used to double save
 * latency and peak memory on large decks.
 *
 * For every dirty slide this bakes the patched XML back into archive.entries and
 * anchor.originalXml, then clears the dirty flags — exactly the state a reopen
 * would produce, minus new element ids. Uses the same patchSlideXml /
 * patchedElementXml pair as buildZip, so memory and disk are byte-identical and
 * the next save's byte slices are safe to reuse.
 *
 * Only slides the finished save actually carried are cleared, so an edit
 * committed while the stream was running stays dirty and lands in the next save.
 * Call only after a successful save; on failure keep the dirty state so the next
 * save retries the patches.
 */
export function commitSaved(opened: OpenedPptx): void {
  return call('commitSaved', [opened], { mut: { 0: 'opened' }, undef: true }) as never
}
/**
 * Rebuild one slideN.xml: dirty elements are patch-regenerated, the rest pass
 * through as original bytes. With no dirty elements the result == originalXml.
 */
export function patchSlideXml(slide: Slide): string {
  return call('patchSlideXml', [slide], { mut: { 0: 'Slide' } }) as never
}
/** One element's current XML slice (dirty elements patch-regenerated, clean elements original bytes). */
export function patchedElementXml(el: SlideElement): string {
  return call('patchedElementXml', [el], { mut: { 0: 'SlideElement' } }) as never
}
/**
 * Set a solid or gradient slide background: patch the bodyPrefix and sync the model
 * (written back with the whole-slide rebuild on save).
 */
export function setSlideBackground(
  opened: OpenedPptx,
  slide: Slide,
  fill: string | GradientFillPatch,
): void {
  call('setSlideBackground', [opened, slideIndex(opened, slide), fill], { mut: { 0: 'opened' } })
}
/**
 * Set a picture slide background. Source is either fresh bytes (lands a new media
 * part) or an existing media path (e.g. applying one picked image to all slides —
 * only a rel is added). Returns the media path used, or null for unsupported formats.
 */
export function setSlideBackgroundImage(
  opened: OpenedPptx,
  slide: Slide,
  source: { bytes: Uint8Array; ext: string } | { mediaPath: string },
  tile?: boolean,
): string | null {
  return call('setSlideBackgroundImage', [opened, slideIndex(opened, slide), source, tile], {
    mut: { 0: 'opened' },
  }) as never
}
/**
 * Remove the slide's own <p:bg> override; the background falls back to the
 * layout/master definition (recomputed here so rendering updates without a reopen).
 */
export function resetSlideBackground(opened: OpenedPptx, slide: Slide): void {
  call('resetSlideBackground', [opened, slideIndex(opened, slide)], { mut: { 0: 'opened' } })
}
/**
 * Toggle "hide background graphics" (<p:sld showMasterSp="0">) and rebuild the
 * slide's decoration layer so rendering reflects the change immediately.
 */
export function setSlideBgGraphicsHidden(opened: OpenedPptx, slide: Slide, hidden: boolean): void {
  call('setSlideBgGraphicsHidden', [opened, slideIndex(opened, slide), hidden], {
    mut: { 0: 'opened' },
  })
}
/**
 * Update a picture element's srcRect crop (0..1 fractions, null = full image).
 * Flags dirtySrcRect so save surgically patches <a:srcRect>; no other bytes are
 * touched. Returns whether the element was found and updated.
 */
export function editPictureSrcRect(
  slide: Slide,
  sourceId: string,
  srcRect: { l: number; t: number; r: number; b: number } | null,
): boolean {
  return call('editPictureSrcRect', [slide, sourceId, srcRect], { mut: { 0: 'Slide' } }) as never
}
/**
 * Change a shape's preset geometry ("Change Shape"): replace <a:prstGeom> (or
 * <a:custGeom>) with the new preset and a fresh <a:avLst/>, keeping transform,
 * fill, outline, and text. Byte surgery baked directly into originalXml.
 */
export function setShapePresetGeometry(slide: Slide, elementId: string, prst: string): boolean {
  return call('setShapePresetGeometry', [slide, elementId, prst], { mut: { 0: 'Slide' } }) as never
}
/**
 * Replace a shape's geometry with a freeform path ("Edit Points"): <a:prstGeom>
 * or the previous <a:custGeom> becomes a single-path <a:custGeom> whose w/h are
 * the path space (callers pass the element extents so points are EMU). The
 * model's customGeometry is re-parsed from the written XML so the render matches
 * a reopen byte for byte. Byte surgery baked directly into originalXml.
 */
export function setShapeCustomGeometry(
  slide: Slide,
  elementId: string,
  geom: CustGeomPath,
): boolean {
  return call('setShapeCustomGeometry', [slide, elementId, geom], { mut: { 0: 'Slide' } }) as never
}
/**
 * Set a shape's preset-geometry adjust values (the "yellow handle" edit):
 * rewrite <a:avLst> inside <a:prstGeom>, keeping everything else. Byte surgery
 * baked directly into originalXml (same contract as setShapePresetGeometry).
 */
export function setShapeAdjustValues(
  slide: Slide,
  elementId: string,
  adjust: Record<string, number>,
): boolean {
  return call('setShapeAdjustValues', [slide, elementId, adjust], { mut: { 0: 'Slide' } }) as never
}
/**
 * Text-box vertical alignment (bodyPr anchor: t/ctr/b). Byte surgery baked directly into originalXml.
 */
export function setElementTextAnchor(
  slide: Slide,
  elementId: string,
  anchor: 'top' | 'middle' | 'bottom',
): boolean {
  return call('setElementTextAnchor', [slide, elementId, anchor], { mut: { 0: 'Slide' } }) as never
}
/**
 * Landing-time normalization for generated pages: the cloud html→pptx converter writes text
 * boxes without any autofit child, which PowerPoint reads as "do not autofit" — typing past
 * the frame overflows a box that never grows. Bare txBox bodies get spAutoFit, the default of
 * a PowerPoint-inserted text box; explicit noAutofit/normAutofit and autoshapes are kept.
 * Top-level elements only (mirrors the editor's autofit resize).
 */
export function autofitGeneratedTextBoxes(slide: Slide): number {
  return call('autofitGeneratedTextBoxes', [slide], { mut: { 0: 'Slide' } }) as never
}
/** Patch for setElementTextBodyProps; only the provided fields are written. */
export interface TextBodyPropsPatch {
  /** Text direction ('horz' clears the vert attribute) */
  vert?: 'horz' | 'eaVert' | 'vert' | 'vert270' | 'wordArtVert'
  /** Autofit mode (noAutofit / normAutofit / spAutoFit) */
  autofit?: 'none' | 'shrink' | 'resize'
  /** Internal margins (EMU); only the provided sides are written */
  insets?: Partial<{ l: number; t: number; r: number; b: number }>
  wrap?: boolean
}
/**
 * Text-box body properties (direction/autofit/insets/wrap): <a:bodyPr> byte
 * surgery baked into originalXml, mirroring setElementTextAnchor.
 */
export function setElementTextBodyProps(
  slide: Slide,
  elementId: string,
  patch: TextBodyPropsPatch,
): boolean {
  return call('setElementTextBodyProps', [slide, elementId, patch], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Patch for setElementEffects; null clears an effect, undefined leaves it untouched. */
export interface EffectsPatch {
  /** Shadow (<a:outerShdw>, or <a:innerShdw> when inner); color may carry alpha as #RRGGBBAA.
   * sx/sy/kxDeg/kyDeg/algn are the outer perspective attributes (scale fraction / skew degrees). */
  shadow?: {
    color: string
    blurRad: number
    dist: number
    dirDeg: number
    inner?: boolean
    sx?: number
    sy?: number
    kxDeg?: number
    kyDeg?: number
    algn?: string
  } | null
  /** Glow (<a:glow>); radius in EMU */
  glow?: { color: string; radius: number } | null
  /** Reflection (<a:reflection>): startA/endPos as 0..1 fractions, blurRad/dist in EMU */
  reflection?: { blurRad: number; startA: number; endPos: number; dist: number } | null
  /** Soft-edge feather radius (<a:softEdge rad>, EMU); the renderer honors it on pictures */
  softEdge?: number | null
}
/**
 * Shape/picture effects (shadow / glow / soft edge): <a:effectLst> byte surgery inside
 * the element's <p:spPr>, mirroring setElementTextBodyProps. Untouched effectLst children
 * (fillOverlay, reflection, ...) are preserved and the list is re-emitted in schema order;
 * an emptied effectLst is removed entirely.
 */
export function setElementEffects(slide: Slide, elementId: string, patch: EffectsPatch): boolean {
  return call('setElementEffects', [slide, elementId, patch], { mut: { 0: 'Slide' } }) as never
}
/**
 * Shape fill (top-level or one-level group child). The XML patch is baked into
 * the owning fragment so a dropped picture fill can immediately release its
 * obsolete relationship and unshared media.
 */
export function setElementFill(
  opened: OpenedPptx,
  slide: Slide,
  elementId: string,
  fill: string | GradientFillPatch,
  opts: { groupId?: string } = {},
): boolean {
  return call('setElementFill', [opened, slideIndex(opened, slide), elementId, fill, opts], {
    mut: { 0: 'opened' },
  }) as never
}
/**
 * Shape picture/texture fill (top-level or one-level group child): lands the
 * image in the package (media + rels), or reuses an already-landed media path
 * (applying one pick to many shapes only adds rels), then replaces the spPr
 * fill node with a blipFill, byte surgery baked directly into originalXml.
 * tile repeats the image at natural size (texture), stretch maps it onto the
 * bounds. Returns the mediaPath (render-layer decoding / reuse), null on failure.
 */
export function setElementImageFill(
  opened: OpenedPptx,
  slide: Slide,
  elementId: string,
  source: { bytes: Uint8Array; ext: string } | { mediaPath: string },
  opts: { tile?: boolean; groupId?: string } = {},
): string | null {
  return call('setElementImageFill', [opened, slideIndex(opened, slide), elementId, source, opts], {
    mut: { 0: 'opened' },
  }) as never
}
/**
 * Withhold a picture, video or audio shape from the model, or stop withholding it
 * (`label` null/empty clears). A `label` puts `go:redact` in the element's
 * `<a:spPr><a:extLst>` — the one extension slot a picture has, since `p:nvPicPr`
 * admits only `cNvPr` + `cNvPicPr` and `cNvPr` takes attributes alone, which the
 * reader's own alt text already uses.
 *
 * The words of a *text* element are withheld through `TextRun.redact` on the edit
 * path instead, because a run is a finer unit than an element and the text-edit
 * pipeline already carries run attributes.
 *
 * Byte surgery on `originalXml` with no separate dirty flag, exactly as
 * `setPictureOpacity` does for `a:alphaModFix`: a picture's shape properties are
 * never regenerated from the model, so this is the only place the mark can live.
 */
export function setElementRedaction(slide: Slide, sourceId: string, label: string | null): boolean {
  return call('setElementRedaction', [slide, sourceId, label], { mut: { 0: 'Slide' } }) as never
}
/**
 * Whole-picture opacity (0..1; ≥1 clears alphaModFix). Byte surgery on the
 * <a:blip> child, baked directly into originalXml (no separate dirty flag).
 */
export function setPictureOpacity(slide: Slide, sourceId: string, opacity: number): boolean {
  return call('setPictureOpacity', [slide, sourceId, opacity], { mut: { 0: 'Slide' } }) as never
}
/**
 * Swap a picture's backing image for new bytes, keeping frame, z-order, border
 * and effects. New media part + rel; the <a:blip> reference is re-pointed via
 * byte surgery baked into originalXml (same pattern as setPictureOpacity).
 * srcRect is kept only when the caller knows the new image shares the old one's
 * pixel geometry (e.g. background-removal output) — otherwise the stale crop
 * would show an arbitrary window of the new image.
 */
export function replacePictureBytes(
  opened: OpenedPptx,
  slide: Slide,
  sourceId: string,
  bytes: Uint8Array,
  ext: string,
  opts?: { keepSrcRect?: boolean },
): boolean {
  return call(
    'replacePictureBytes',
    [opened, slideIndex(opened, slide), sourceId, bytes, ext, opts?.keepSrcRect ?? false],
    { mut: { 0: 'opened' } },
  ) as never
}
/**
 * Duplicate the sourceIndex slide as a new slide inserted after it; returns the
 * new slide model.
 *
 * The new slideK.xml includes the source slide's unsaved patches; rels are copied
 * verbatim but with notesSlide removed, so two slides don't share the same notes.
 */
export function duplicateSlide(
  opened: OpenedPptx,
  sourceIndex: number,
  opts?: { clearText?: boolean },
): Slide | null {
  const i = call('duplicateSlide', [opened, sourceIndex, opts], {
    mut: { 0: 'opened' },
  }) as never as number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Snapshot a slide for pasting into another deck (or back into this one),
 * including its unsaved edits and every part it references.
 */
export function copySlide(opened: OpenedPptx, sourceIndex: number): SlideBundle | null {
  return call('copySlide', [opened, sourceIndex], { mut: { 0: 'opened' } }) as never
}
/**
 * Paste a bundle after `afterIndex` (-1 pastes at the front). By default the
 * slide adopts a layout from this deck — matched by the source layout's name,
 * else the neighbour's — so it takes on the destination theme ("use destination
 * theme"). With `keepSourceFormatting` the bundled layout→master→theme chain is
 * imported instead, so the slide keeps its source look; falls back to the
 * destination theme when the bundle carries no chain.
 */
export function pasteSlide(
  opened: OpenedPptx,
  afterIndex: number,
  bundle: SlideBundle,
  opts?: { keepSourceFormatting?: boolean },
): Slide | null {
  const i = call('pasteSlide', [opened, afterIndex, bundle, opts], {
    mut: { 0: 'opened' },
  }) as never as number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Insert a truly blank slide after the sourceIndex slide: content is an empty
 * spTree, rels only point at the source slide's slideLayout — layout/master
 * background and decorations carry over, slide elements are empty.
 */
export function insertBlankSlide(opened: OpenedPptx, sourceIndex: number): Slide | null {
  const i = call('insertBlankSlide', [opened, sourceIndex], { mut: { 0: 'opened' } }) as never as
    number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Merge the single slide of a one-slide pptx into the target deck (appended at
 * the end).
 *
 * Used by the html→pptx pipeline's per-slide independent conversion: each slide's
 * HTML converts into its own single-slide pptx, and on landing that slide is moved
 * into the existing deck **without reconverting earlier slides**.
 *
 * Precondition (pipeline homogeneity): all single-slide pptx files share the same
 * layout/master/theme structure, so the appended slide reuses the target's
 * existing slideLayout (the source's layout/master/theme is not imported); only
 * the slide XML + the media it references are moved (rIds reassigned to avoid
 * cross-slide name clashes), notesSlide dropped.
 */
export async function mergeSlideFromPptx(
  target: OpenedPptx,
  sourceBytes: Uint8Array,
  opts: MergeSlideOptions = {},
): Promise<Slide | null> {
  const i = call(
    'mergeSlideFromPptx',
    [target, sourceBytes, { layoutFrom: opts?.layoutFrom?.path }],
    { mut: { 0: 'opened' }, names: ['target', 'sourceBytes', ''] },
  ) as never as number | null
  return i === null ? null : target.deck.slides[i]!
}
export interface MergeSlideOptions {
  /** Target slide whose layout the merged slide takes (default: the last slide) */
  layoutFrom?: Slide
}
/**
 * A single-slide pptx reduced to the plain data the merge needs: slide XML, its
 * relationships, referenced media bytes, and the source layout chain for the
 * empty-deck fallback. Fully serializable, so ops and journals can carry it.
 */
export interface MergeSlideSource {
  srcSlidePath: string
  slideXml: string
  rels: Relationship[]
  /** Referenced media bytes keyed by their resolved source path */
  media: Array<{ path: string; bytes: Uint8Array }>
  /** Source layout→master→theme chain parts (used only when the target has no layout) */
  layoutChain: Array<{ path: string; bytes: Uint8Array; rels?: Uint8Array }>
}
/** Async half of the merge: unzip the source and extract everything the sync half needs. Pure read. */
export async function extractMergeSlideSource(
  sourceBytes: Uint8Array,
): Promise<MergeSlideSource | null> {
  return call('extractMergeSlideSource', [sourceBytes]) as never
}
/** Sync half of the merge: land an extracted source into the target deck (appended at the end). */
export function mergeSlideFromSource(
  target: OpenedPptx,
  source: MergeSlideSource,
  opts: MergeSlideOptions = {},
): Slide | null {
  const i = call('mergeSlideFromSource', [target, source, { layoutFrom: opts?.layoutFrom?.path }], {
    mut: { 0: 'opened' },
    names: ['target', 'source', ''],
  }) as never as number | null
  return i === null ? null : target.deck.slides[i]!
}
/**
 * Insert a blank slide after the sourceIndex slide, with rels pointing at the
 * given layoutPath (from listSlideLayouts). The layout itself is read-only, never
 * written back. Returns the new Slide, or null on failure.
 */
export function insertSlideWithLayout(
  opened: OpenedPptx,
  sourceIndex: number,
  layoutPath: string,
): Slide | null {
  const i = call('insertSlideWithLayout', [opened, sourceIndex, layoutPath], {
    mut: { 0: 'opened' },
  }) as never as number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Delete a slide: the sldId in presentation.xml, the presentation rels, the
 * [Content_Types] Override, the slide part and its rels are all removed;
 * deck.slides synced. Refused when only one slide remains.
 */
export function deleteSlide(opened: OpenedPptx, index: number): boolean {
  return call('deleteSlide', [opened, index], { mut: { 0: 'opened' } }) as never
}
export type ReorderDirection = 'front' | 'back' | 'forward' | 'backward'
/** Adjust an element's z-order (the elements array order is the spTree order); returns whether anything changed. */
export function reorderElement(slide: Slide, elementId: string, dir: ReorderDirection): boolean {
  return call('reorderElement', [slide, elementId, dir], { mut: { 0: 'Slide' } }) as never
}
// ── Raw slice append + whole-slide reparse (shared by paste/table insert) ──

/**
 * Write the slide's current state (incl. unsaved patches) back to the archive and
 * reparse, replacing the model in the deck. New elements appended as raw XML
 * slices go through here, gaining a full semantic model for any element type.
 * Note: after reparse all element ids on the slide change; the caller must rebuild
 * the render tree for the whole slide.
 */
export function materializeSlide(opened: OpenedPptx, slideIndex: number): Slide | null {
  return (call('materializeSlide', [opened, slideIndex], { mut: { 0: 'opened' } }) as never)
    ? opened.deck.slides[slideIndex]!
    : null
}
// ── Connector move-following ────────────────────────────────────────────

export type ConnectionSide = 'top' | 'left' | 'bottom' | 'right'
/** Connection-site index of a shape edge midpoint for the element's preset geometry. */
export function connectionSiteForSide(el: SlideElement, side: ConnectionSide): number {
  return call('connectionSiteForSide', [el, side]) as never
}
/**
 * Re-lay connectors after connected shapes move: the geometry box = the bounding
 * box of the two endpoints, direction expressed via flip (exact for straight
 * connectors; elbow connectors approximated by the same bounding box). An
 * unattached end keeps its current endpoint. Returns the number of connectors
 * updated (>0 means each is flagged dirtyTransform).
 */
export function updateConnectorsForMoved(slide: Slide, movedIds: string[]): number {
  return call('updateConnectorsForMoved', [slide, movedIds], { mut: { 0: 'Slide' } }) as never
}
/**
 * Write/clear a connector's shape attachments (<a:stCxn>/<a:endCxn> in
 * p:cNvCxnSpPr; id = target shape's cNvPr id, idx = connection point index).
 * undefined leaves that end unchanged, null detaches it. Byte surgery baked
 * directly into originalXml (pending patches are materialized first).
 */
export function setElementConnection(
  slide: Slide,
  elementId: string,
  patch: {
    start?: { id: number; idx: number } | null
    end?: { id: number; idx: number } | null
  },
): boolean {
  return call('setElementConnection', [slide, elementId, patch], { mut: { 0: 'Slide' } }) as never
}
/**
 * Switch an existing slide's layout: point the slide rels' slideLayout
 * relationship at the new layout, then reparse (inheritance chain/decoration
 * layer/placeholder default styles all refreshed). Placeholder positions are kept
 * (existing shapes stay put; use resetSlideLayout to snap
 * them back). Layout placeholders with no counterpart on the slide are added as
 * empty prompt boxes (PowerPoint semantics).
 */
export function setSlideLayout(
  opened: OpenedPptx,
  slideIndex: number,
  layoutPath: string,
): Slide | null {
  const i = call('setSlideLayout', [opened, slideIndex, layoutPath], {
    mut: { 0: 'opened' },
  }) as never as number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Reset layout: placeholder elements drop their explicit <a:xfrm>, geometry falls
 * back to layout/master inheritance (restoring the inherited
 * position/size).
 */
export function resetSlideLayout(opened: OpenedPptx, slideIndex: number): Slide | null {
  const i = call('resetSlideLayout', [opened, slideIndex], { mut: { 0: 'opened' } }) as never as
    number | null
  return i === null ? null : opened.deck.slides[i]!
}
/**
 * Slide size (16:9 ↔ 4:3 etc.): edits <p:sldSz> in presentation.xml.
 * Content reflows with the canvas: each axis scales independently
 * (sx = cx/oldCx, sy = cy/oldCy), like PowerPoint's stretch on size change.
 * Anisotropic on purpose — it fills the new canvas with no letterbox bands
 * and makes A→B→A a true round-trip (within 1 EMU of rounding), which a
 * uniform fit-and-center scale cannot be. Font sizes are left alone.
 */
export function setSlideSize(opened: OpenedPptx, cx: number, cy: number): boolean {
  return call('setSlideSize', [opened, cx, cy], { mut: { 0: 'opened' } }) as never
}
/** Append a batch of raw shape slices at the slide end and materialize; returns the new slide and new element ids (in append order). */
export function appendRawElements(
  opened: OpenedPptx,
  slideIndex: number,
  xmls: string[],
): { slide: Slide; elementIds: string[] } | null {
  const v = call('appendRawElements', [opened, slideIndex, xmls], { mut: { 0: 'opened' } }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementIds: v }
}
/** Insert a table: build a graphicFrame slice, append, and reparse. */
export function addTable(
  opened: OpenedPptx,
  slideIndex: number,
  opts: NewTableOptions,
): { slide: Slide; elementId: string } | null {
  const v = call('addTable', [opened, slideIndex, opts], { mut: { 0: 'opened' } }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
/**
 * Rewrite table cell text: XML surgery (replacing the txBody paragraphs of the
 * col-th a:tc inside the row-th a:tr, keeping bodyPr/lstStyle/tcPr) with the model
 * synced. col is the tc index (not the logical column).
 */
export function editTableCellText(
  slide: Slide,
  elementId: string,
  row: number,
  col: number,
  paragraphs: Paragraph[],
): boolean {
  return call('editTableCellText', [slide, elementId, row, col, paragraphs], {
    mut: { 0: 'Slide' },
  }) as never
}
/**
 * Table style editing (surgical patch of a:tblPr + a:tcPr):
 * apply a preset style or change firstRow/bandRow/shading/borders without touching
 * cell text. anchor.originalXml is patched directly; structureDirty=true triggers
 * the save rebuild.
 */
export function editTableStyle(slide: Slide, elementId: string, edit: TableStyleEdit): boolean {
  return call('editTableStyle', [slide, elementId, edit], { mut: { 0: 'Slide' } }) as never
}
/**
 * Ensure ppt/tableStyles.xml contains the given custom style (injected the first
 * time a preset is applied). Creates the part when missing, adding the
 * [Content_Types].xml Override and presentation rels.
 */
export function ensureTableStylePart(
  opened: OpenedPptx,
  styleId: string,
  styleDefXml: string,
): void {
  return call('ensureTableStylePart', [opened, styleId, styleDefXml], {
    mut: { 0: 'opened' },
    undef: true,
  }) as never
}
/**
 * Chart editing (charts created by this app, rebuilding the chart part):
 * find the element's chart part path (via slide rels), rebuild the XML with the
 * new data/type/colors, and write it back to the archive. structureDirty=true
 * triggers a reparse.
 */
export function editChartElement(
  opened: OpenedPptx,
  slideIndex: number,
  elementId: string,
  patch: {
    kind?: NewChartKind
    /** Bar direction for an explicit type change ('bar' = horizontal) */
    barDir?: 'col' | 'bar'
    categories?: string[]
    series?: Array<{ name: string; values: number[] }>
    title?: string
    colorScheme?: string[]
    legendPos?: 'b' | 't' | 'r' | 'l' | 'none'
    dataLabels?: boolean
    gridlines?: boolean
    /** '' = clear */
    catAxisTitle?: string
    valAxisTitle?: string
    gapWidthPct?: number
    /** Doughnut hole size percent (kept from the existing chart when unspecified) */
    holeSizePct?: number
    /** Swap rows/columns: categories ↔ series (mutually exclusive with categories/series patches, triggered separately in the UI) */
    switchRowCol?: boolean
    /** Per-point fill overrides, seriesIdx → pointIdx → color; null clears back to the series color */
    pointColors?: Record<number, Record<number, string | null>>
  },
): boolean {
  return call('editChartElement', [opened, slideIndex, elementId, patch], {
    mut: { 0: 'opened' },
  }) as never
}
/**
 * Mark a chart not created by this app as editable (cNvPr descr="aislides-chart"):
 * only tags it without rewriting the chart part (the conversion itself is
 * lossless); subsequent edits go through editChartElement's rebuild template, and
 * fine-grained formatting beyond the parsed model (number formats/per-point
 * styles etc.) is dropped at that point.
 */
export function markChartEditable(slide: Slide, elementId: string): boolean {
  return call('markChartEditable', [slide, elementId], { mut: { 0: 'Slide' } }) as never
}
/**
 * Show or hide a top-level element (<p:cNvPr hidden="1">, PowerPoint's Selection Pane eye).
 * Only the element's own cNvPr changes. A hidden element parses as a silent passthrough
 * (never drawn), so the caller rematerializes the slide afterwards (materializeSlide) to
 * bring the model in line — which also renews every element id on the slide.
 */
export function setElementHidden(slide: Slide, elementId: string, hidden: boolean): boolean {
  return call('setElementHidden', [slide, elementId, hidden], { mut: { 0: 'Slide' } }) as never
}
/** Rename a top-level element (<p:cNvPr name>, the name the Selection Pane shows). */
export function setElementName(slide: Slide, elementId: string, name: string): boolean {
  return call('setElementName', [slide, elementId, name], { mut: { 0: 'Slide' } }) as never
}
/** Read a chart element's current data (for dialog echo-back). */
export function getChartElementData(
  slide: Slide,
  elementId: string,
): {
  kind: string
  title: string
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  seriesColors: Array<string | undefined>
  pointColors: Array<Array<string | undefined> | undefined>
} | null {
  return call('getChartElementData', [slide, elementId], {
    shape: {
      k: 'obj',
      f: {
        seriesColors: { k: 'arr', u: true },
        pointColors: { k: 'arr', u: true, v: { k: 'arr', u: true } },
      },
    },
  }) as never
}
/**
 * Elements without text (pictures/charts etc.) return false.
 */
export interface ElementFontPatch {
  fontFamily?: string
  fontSizePt?: number
  strike?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** #RRGGBB (explicit color: clears theme-link/inheritance flags) */
  color?: string
  /** Text highlight #RRGGBB; null removes it */
  highlight?: string | null
  /** Letter spacing in points (negative = tighter); null or 0 = normal spacing */
  letterSpacingPt?: number | null
}
/** Per-run size rewrite (relative grow/shrink); undefined = the run inherits its size. */
export type FontSizeMap = (pt: number | undefined) => number
export function setElementFont(
  slide: Slide,
  elementId: string,
  patch: ElementFontPatch,
  sizeMap?: FontSizeMap,
): boolean {
  return call('setElementFont', [slide, elementId, patch, sizeMap], {
    mut: { 0: 'Slide' },
    names: ['slide', 'elementId', 'patch', 'sizeMap'],
  }) as never
}
// ── Find/replace ────────────────────────────────────────────────────────

export interface ReplaceOptions {
  matchCase?: boolean
  /** Replace only the first match (the "Replace" button; default replaces all) */
  firstOnly?: boolean
  /** Restrict to one slide/element (the "Replace" button acts on the currently hit element) */
  slideIndex?: number
  elementId?: string
  /**
   * Text a person hid from AI is out of the search: no match inside it or across it, and no count
   * for one. For an agent, whose answer would otherwise tell it the words are there.
   */
  skipWithheld?: boolean
}
/**
 * Deck-wide replace (a match may span consecutive runs of a paragraph: the
 * replacement lands in the run holding its first character and the matched text
 * is cut from the runs it covers, so untouched text keeps its own rPr). Covers
 * text/shape, table cells, and direct group children; dynamic field runs are
 * skipped and no match spans one.
 * Returns the replacement count; elements on changed slides are flagged dirty.
 */
export function replaceAllInDeck(
  deck: SlideDeck,
  find: string,
  replace: string,
  opts: ReplaceOptions = {},
): { count: number; changedSlides: number[] } {
  return call('replaceAllInDeck', [deck, find, replace, opts], { mut: { 0: 'SlideDeck' } }) as never
}
// ── Paragraph formatting (bullet/line spacing/paragraph spacing/alignment) ──

export interface ParagraphFormatPatch {
  /** 'char' round bullet / 'number' numbering / 'blip' picture / 'none' explicitly none */
  bullet?: 'char' | 'number' | 'blip' | 'none'
  /** buAutoNum scheme (ST_TextAutonumberScheme) with bullet: 'number'; alone it re-schemes numbered paragraphs */
  numType?: string
  /** First number of the sequence; alone it only touches numbered paragraphs */
  startAt?: number
  /** Picture bullet already landed in the package (media path + slide rId), with bullet: 'blip' */
  bulletBlip?: { mediaRef: string; blipEmbedId: string }
  /** Custom bullet character (with bullet: 'char'; defaults to '•') */
  bulletChar?: string
  /** <a:buFont> for the character (PowerPoint's gallery pairs Wingdings/Courier codes with their font) */
  bulletFont?: string
  /** Bullet hanging indent (EMU); alone it adjusts existing bullets' indent */
  bulletHangEmu?: number
  /** Bullet size (% of text size, 100 = same); alone it only touches bulleted paragraphs */
  bulletSizePct?: number
  /** Bullet color (#RRGGBB); alone it only touches bulleted paragraphs */
  bulletColor?: string
  /** Line spacing (%, 100 = single) */
  lineSpacingPct?: number
  /** Space before / after (pt) */
  spaceBeforePt?: number
  spaceAfterPt?: number
  align?: Paragraph['align']
  /** Paragraph base direction (a:pPr rtl); false writes an explicit rtl="0" */
  rtl?: boolean
  /** Indent level delta (multi-level list Tab/⇧Tab; clamp 0..8) */
  indentDelta?: 1 | -1
}
/**
 * Apply a paragraph-format patch to model paragraphs in place. Exported for
 * callers that rebuild a text body themselves (table cell edits) and need the
 * same bullet/spacing/direction semantics as setElementParagraphFormat without
 * its element-wide scope.
 */
export function applyParagraphFormat(
  paragraphs: Paragraph[],
  patch: ParagraphFormatPatch,
): PPrDirty {
  return call('applyParagraphFormat', [paragraphs, patch], { mut: { 0: 'Paragraph[]' } }) as never
}
/**
 * Change paragraph formatting directly on a selected element (bullet/line
 * spacing/paragraph spacing/alignment), applied to all of its paragraphs
 * (text/shape/table; same as clicking bullets with a shape selected in PowerPoint).
 * paraIndices restricts the patch to those paragraphs (editing-mode selection).
 */
export function setElementParagraphFormat(
  slide: Slide,
  elementId: string,
  patch: ParagraphFormatPatch,
  paraIndices?: number[],
): boolean {
  return call('setElementParagraphFormat', [slide, elementId, patch, paraIndices], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Paragraph formatting for a group child (same semantics as setGroupChildFont; the pPr patch is baked straight into the group bytes). */
export function setGroupChildParagraphFormat(
  slide: Slide,
  groupId: string,
  childId: string,
  patch: ParagraphFormatPatch,
  paraIndices?: number[],
): boolean {
  return call('setGroupChildParagraphFormat', [slide, groupId, childId, patch, paraIndices], {
    mut: { 0: 'Slide' },
  }) as never
}
// ── Table row/column structure editing ──────────────────────────────────

export type TableStructureOp =
  | { kind: 'insert-row'; index: number; before?: boolean }
  | { kind: 'delete-row'; index: number }
  | { kind: 'insert-col'; index: number; before?: boolean }
  | { kind: 'delete-col'; index: number }
/**
 * Table row/column insert/delete (XML surgery + materialize/reparse):
 * - Inserted rows/columns clone the reference row/column's formatting with text
 *   cleared; the table frame grows/shrinks with the total row height/column width.
 * - Deleting is refused when only 1 row/column remains; tables with merged cells
 *   are always refused.
 * After reparse element ids change; the new table id is found back by element position.
 */
export function editTableStructure(
  opened: OpenedPptx,
  slideIndex: number,
  elementId: string,
  op: TableStructureOp,
): { slide: Slide; elementId: string } | null {
  const v = call('editTableStructure', [opened, slideIndex, elementId, op], {
    mut: { 0: 'opened' },
  }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
// ── Table merge/split cells ─────────────────────────────────────────────

export type TableMergeOp =
  | { kind: 'merge-right'; row: number; col: number }
  | { kind: 'merge-down'; row: number; col: number }
  | { kind: 'split'; row: number; col: number }
/**
 * Merge/split cells (XML surgery + materialize/reparse). v1 constraints:
 * merge-right requires anchor rowSpan=1 and a plain right neighbor; merge-down
 * requires anchor gridSpan=1 and a plain neighbor below (an already-merged anchor
 * can keep extending). The absorbed cell's text folds into the anchor.
 */
export function mergeTableCells(
  opened: OpenedPptx,
  slideIndex: number,
  elementId: string,
  op: TableMergeOp,
): { slide: Slide; elementId: string } | null {
  const v = call('mergeTableCells', [opened, slideIndex, elementId, op], {
    mut: { 0: 'opened' },
  }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v }
}
/**
 * Set a column's width (EMU): gridCol w + frame ext.cx synced, model updated in
 * place (no reparse, element ids stable — good for drag resizing).
 */
export function setTableColWidth(
  slide: Slide,
  elementId: string,
  col: number,
  wEmu: number,
): boolean {
  return call('setTableColWidth', [slide, elementId, col, wEmu], { mut: { 0: 'Slide' } }) as never
}
/** Set a row's height (EMU): <a:tr h> + frame ext.cy synced (matching setTableColWidth semantics). */
export function setTableRowHeight(
  slide: Slide,
  elementId: string,
  row: number,
  hEmu: number,
): boolean {
  return call('setTableRowHeight', [slide, elementId, row, hEmu], { mut: { 0: 'Slide' } }) as never
}
/**
 * Resize a table by proportionally redistributing <a:gridCol w> and <a:tr h>
 * (PowerPoint's behavior). Without this, setting the frame's a:ext leaves the
 * internal grid at its old size, so other software renders the old dimensions
 *. The frame ext is synced to the redistributed sums.
 */
export function resizeTable(slide: Slide, elementId: string, cx: number, cy: number): boolean {
  return call('resizeTable', [slide, elementId, cx, cy], { mut: { 0: 'Slide' } }) as never
}
/** Cell text vertical alignment (tcPr anchor: t/ctr/b). Byte surgery + model sync. */
export function setTableCellAnchor(
  slide: Slide,
  elementId: string,
  row: number,
  col: number,
  anchor: 'top' | 'middle' | 'bottom',
): boolean {
  return call('setTableCellAnchor', [slide, elementId, row, col, anchor], {
    mut: { 0: 'Slide' },
  }) as never
}
// ── Element clipboard ───────────────────────────────────────────────────

export interface ElementClipboardItem {
  /** The element's current XML slice (incl. unsaved patches) */
  xml: string
  /** rId referenced by the xml → absolute part path (External relationships keep the target verbatim) */
  rels: Array<{ rid: string; type: string; target: string; external?: boolean }>
  /** Dependency part bytes (base64, keyed by absolute path), so the paste target can be a different deck */
  parts?: Readonly<Record<string, string>>
  /** ContentType per dependency: keyed by lower-case extension or by part path */
  contentTypes?: Readonly<Record<string, string>>
}
/** Copy: grab the element's current XML and the relationships it references (part paths that pictures/charts etc. point at). */
export function copyElementData(
  opened: OpenedPptx,
  slide: Slide,
  el: SlideElement,
): ElementClipboardItem {
  const at = slideIndex(opened, slide)
  return call('copyElementData', [opened, at, opened.deck.slides[at]!.elements.indexOf(el)], {
    mut: { 0: 'opened' },
  }) as never
}
/**
 * Paste: land bundled dependency parts (byte-identical ones already in the
 * target are shared, so a same-deck paste copies no media), rels surgery
 * (reuse the rId when the target slide already has a relationship with the
 * same type+target), renumber cNvPr ids, offset the whole thing, append, and
 * reparse.
 */
export function pasteElements(
  opened: OpenedPptx,
  slideIndex: number,
  items: ElementClipboardItem[],
  shiftEmu: { dx: number; dy: number },
): { slide: Slide; elementIds: string[] } | null {
  const v = call('pasteElements', [opened, slideIndex, items, shiftEmu], {
    mut: { 0: 'opened' },
  }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, elementIds: v }
}
// ── Slide transitions ───────────────────────────────────────────────────

/** Set/clear the transition (writes bodySuffix, persisted with the whole-slide rebuild on save). */
export function setSlideTransition(slide: Slide, kind: SlideTransitionKind): void {
  return call('setSlideTransition', [slide, kind], { mut: { 0: 'Slide' }, undef: true }) as never
}
/** Read the current transition. */
export function getSlideTransition(slide: Slide): SlideTransitionKind {
  return call('getSlideTransition', [slide]) as never
}
/** Set/clear the auto-advance time (advTm, ms; saved by rehearsal timing, auto-advances in PowerPoint slideshows). */
export function setSlideAdvanceTime(slide: Slide, ms: number | null): void {
  return call('setSlideAdvanceTime', [slide, ms], { mut: { 0: 'Slide' }, undef: true }) as never
}
/** Read the auto-advance time (ms; null when unset). */
export function getSlideAdvanceTime(slide: Slide): number | null {
  return call('getSlideAdvanceTime', [slide]) as never
}
// ── Hidden slides ───────────────────────────────────────────────────────

/** Hide/unhide a slide (<p:sld show="0">, skipped in PowerPoint slideshows). */
export function setSlideHidden(slide: Slide, hidden: boolean): void {
  return call('setSlideHidden', [slide, hidden], { mut: { 0: 'Slide' }, undef: true }) as never
}
/** Read whether the slide is hidden. */
export function getSlideHidden(slide: Slide): boolean {
  return call('getSlideHidden', [slide]) as never
}
/**
 * Fetch a slide's patch-rebuilt result directly (Phase 1: with no dirty elements
 * it should equal originalXml). Lets tests verify the scan's
 * prefix/elements/suffix concatenation is lossless.
 */
export function reassembleSlideXml(slide: Slide): string {
  return call('reassembleSlideXml', [slide]) as never
}
// ── Element group / ungroup ───────────────────────────────────────────────

/**
 * Group multiple editable elements (text/shape/picture) into one p:grpSp.
 *
 * - Removes the selected elements from slide.elements, builds the p:grpSp XML and appends at the slide end
 * - Goes through the appendRawElements → materialize path (structureDirty=true, rebuilt on save)
 * - Only accepts text/shape/picture; passthrough/table/chart/group are refused outright
 * - Requires at least 2 elements
 *
 * Returns: { slide: fresh Slide, groupId: new group element id } or null (failure)
 */
export function groupElements(
  opened: OpenedPptx,
  slideIndex: number,
  sourceIds: string[],
): { slide: Slide; groupId: string } | null {
  const v = call('groupElements', [opened, slideIndex, sourceIds], {
    mut: { 0: 'opened' },
  }) as never
  return v === null ? null : { slide: opened.deck.slides[slideIndex]!, groupId: v }
}
/**
 * Ungroup: lift the group's children to the slide top level.
 *
 * Coordinate conversion rules:
 * - If childOffset defines a child coordinate system (chOff/chExt), child
 *   coordinates are based on it.
 * - This implementation sets chOff=off, chExt=ext (1:1 mapping) in buildGrpSpXml,
 *   so child coordinates are directly slide coordinates; groups from old files
 *   get the generic conversion too.
 * - Conversion: slideX = childX - chOff.x + group.off.x (plus * ext/chExt when scaled)
 *
 * Old-file groups pass their bytes through wholesale; after ungrouping they take
 * the rebuild path (structureDirty=true). Passthrough children (charts etc.)
 * keep their originalXml slices.
 *
 * Returns a fresh Slide or null.
 */
export function ungroupElement(
  opened: OpenedPptx,
  slideIndex: number,
  sourceId: string,
): Slide | null {
  return (call('ungroupElement', [opened, slideIndex, sourceId], { mut: { 0: 'opened' } }) as never)
    ? opened.deck.slides[slideIndex]!
    : null
}
export interface GroupChildSlice {
  start: number
  end: number
  xml: string
  nvId?: string
}
/** Direct child slices of the group XML (document order; a nested group's inner elements are not double-counted). */
export function groupChildSlices(grpXml: string): GroupChildSlice[] {
  return call('groupChildSlices', [grpXml]) as never
}
/** Patch the in-group slice matching child.nvId in place; returns true on success. */
export function patchGroupChildXml(
  grp: GroupElement,
  child: SlideElement,
  patch: (xml: string) => string,
): boolean {
  return call('patchGroupChildXml', [grp, child.nvId, patch], {
    mut: { 0: 'GroupElement' },
    names: ['grp', '', 'patch'],
  }) as never
}
/** Top-level group and its direct child (in-group editing goes one level; a nested subgroup is edited as a whole). */
export function findGroupChild(
  slide: Slide,
  groupId: string,
  childId: string,
): { grp: GroupElement; child: SlideElement } | null {
  const at = call('findGroupChild', [slide, groupId, childId]) as never as [number, number] | null
  if (at === null) return null
  const grp = slide.elements[at[0]] as GroupElement
  return { grp, child: grp.children[at[1]]! }
}
/** Group-child geometry editing (offset is in the child EMU coordinate system, incl. chOff). */
export function editGroupChildTransform(
  slide: Slide,
  groupId: string,
  childId: string,
  offset: { x: number; y: number; cx: number; cy: number },
  rotationDeg: number,
): boolean {
  return call('editGroupChildTransform', [slide, groupId, childId, offset, rotationDeg], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Group-child text editing: called after model paragraphs are updated; regenerates the slice's txBody. */
export function patchGroupChildText(slide: Slide, groupId: string, child: TextElement): boolean {
  return call('patchGroupChildText', [slide, groupId, child], { mut: { 0: 'Slide' } }) as never
}
/** Change font/size on a whole group child (same run-level semantics as setElementFont). */
export function setGroupChildFont(
  slide: Slide,
  groupId: string,
  childId: string,
  patch: ElementFontPatch,
  sizeMap?: FontSizeMap,
): boolean {
  return call('setGroupChildFont', [slide, groupId, childId, patch, sizeMap], {
    mut: { 0: 'Slide' },
    names: ['slide', 'groupId', 'childId', 'patch', 'sizeMap'],
  }) as never
}
/** Group-child fill ('none' | #RRGGBB(AA) | gradient). */
export function editGroupChildFill(
  slide: Slide,
  groupId: string,
  childId: string,
  fill: string | GradientFillPatch,
): boolean {
  return call('editGroupChildFill', [slide, groupId, childId, fill], {
    mut: { 0: 'Slide' },
  }) as never
}
/** StrokePatch → in-memory Stroke model (mirrors what patchLnXml writes into the XML). */
export function strokePatchToModel(stroke: StrokePatch): Stroke {
  return call('strokePatchToModel', [stroke]) as never
}
export function editGroupChildStroke(
  slide: Slide,
  groupId: string,
  childId: string,
  stroke: StrokePatch | null,
): boolean {
  return call('editGroupChildStroke', [slide, groupId, childId, stroke], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Group-child adjust values (same avLst-swap semantics as setShapeAdjustValues). */
export function setGroupChildShapeAdjustValues(
  slide: Slide,
  groupId: string,
  childId: string,
  adjust: Record<string, number>,
): boolean {
  return call('setGroupChildShapeAdjustValues', [slide, groupId, childId, adjust], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Group-child "Change Shape" (same geometry-swap semantics as setShapePresetGeometry). */
export function setGroupChildShapePresetGeometry(
  slide: Slide,
  groupId: string,
  childId: string,
  prst: string,
): boolean {
  return call('setGroupChildShapePresetGeometry', [slide, groupId, childId, prst], {
    mut: { 0: 'Slide' },
  }) as never
}
/** Group-child freeform geometry (same semantics as setShapeCustomGeometry). */
export function setGroupChildShapeCustomGeometry(
  slide: Slide,
  groupId: string,
  childId: string,
  geom: CustGeomPath,
): boolean {
  return call('setGroupChildShapeCustomGeometry', [slide, groupId, childId, geom], {
    mut: { 0: 'Slide' },
  }) as never
}
