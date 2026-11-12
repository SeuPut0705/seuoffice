/**
 * Phase 3.3 element-level patch generation — regenerating OOXML fragments for
 * dirty elements.
 *
 * Fidelity philosophy (aligned with docx-engine): **no wholesale parse→serialize**
 * (it loses unmodeled attributes: effects/custom geometry/extensions etc.).
 * Instead, **surgical in-place patches** of the original <p:sp> byte slice:
 *   - Text editing (the main scenario): replace each <a:r>'s <a:t> text content in
 *     order, and patch/inject <a:rPr> formatting attributes as needed
 *     (b/i/u/sz + solidFill color).
 *   - Untouched bytes (bodyPr/spPr/geometry/placeholder attributes…) are kept verbatim.
 *
 * If the model's run count doesn't match the original XML's <a:r> count, or any
 * paragraph's run count differs (runs added/removed / paragraph structure
 * changed), fall back to the "rebuild txBody per paragraph" path (still keeping
 * outer bytes like spPr where possible). A text edit whose traced paragraph/run
 * moved (element.textMoved) also rebuilds: the in-place patch would keep the
 * attributes of the old run now at that position. The Phase 3 editor uses the
 * former (lossless) when only text and formatting change in place; structural or
 * reordered edits use the latter.
 */
import type { SlideElement, TextElement, Paragraph, TextRun, Transform, PPrDirty } from './types'
import { call, shared } from './engine'

/**
 * In-place patch of a text/shape element's original XML.
 * originalXml = the <p:sp>'s full original byte slice (anchor.originalXml).
 */
export function patchTextElementXml(el: TextElement, originalXml: string): string {
  return call('patchTextElementXml', [el, originalXml]) as never
}
/**
 * Surgically patch the <a:pPr> of one <a:p>…</a:p> slice: only reorder groups we
 * model that are flagged dirty (lnSpc/spcBef/spcAft/bu*); non-dirty groups keep
 * their original bytes and join the reorder in schema order; unmodeled children
 * like defRPr/tabLst stay in place (schema order puts them after these groups, so
 * still valid). Attrs (algn/marL/indent) are set in place.
 */
export function patchParagraphPPrXml(paraXml: string, p: Paragraph, which: PPrDirty): string {
  return call('patchParagraphPPrXml', [paraXml, p, which]) as never
}
/**
 * Element-level paragraph formatting patch: surgically patch pPr per <a:p> (run
 * bytes untouched). Returns null when the paragraph count doesn't match the model
 * (the caller falls back to rebuild).
 */
export function patchElementPPr(el: TextElement, xml: string, which: PPrDirty): string | null {
  return call('patchElementPPr', [el, xml, which]) as never
}
export function szAttr(pt: number): string {
  return call('szAttr', [pt]) as never
}
/** Integer attribute value inside a schema range; NaN/Infinity land on the lower bound. */
export function clampInt(v: number, min: number, max: number): number {
  return call('clampInt', [v, min, max]) as never
}
/** ST_Coordinate / ST_PositiveCoordinate ceiling (EMU). Exported so the read path
 *  (parse.ts) can bound a group's child-to-parent scale by the same range the write
 *  path emits coordinates in. */
export const COORD_MAX = 27273042316900
// The numeric clamps are exported so the insert builders size their grids from
// the same bounds their a:off/a:ext attributes are written with.
export const clampEmu = (v: number): number => clampInt(v, -COORD_MAX, COORD_MAX)
export const clampPosEmu = (v: number): number => clampInt(v, 0, COORD_MAX)
/**
 * The language tag for text written without one: `ko-KR` when it holds Hangul (alone or mixed
 * with Latin), which is what PowerPoint writes for a Korean user's typing. PowerPoint and the
 * layout keep a space-delimited Hangul word whole only in a Korean-tagged run and break an
 * untagged one per syllable, so untagged Korean text breaks inside words.
 */
export function hangulLang(text: string): 'ko-KR' | undefined {
  return call('hangulLang', [text], { undef: true }) as never
}
/**
 * A run as an authoring writer stores it (the deck builder, the text ops, the editor's commit):
 * tagged per `hangulLang` unless it already carries a language, which is never replaced. The
 * model gets what a reparse of the written `lang` gives (line-breaking language, substitution
 * script), so the canvas wraps the text the way the saved file will. Importers do not call
 * this: a source run that had no language stays untagged.
 */
export function tagHangulRun(run: TextRun): TextRun {
  return shared(run, call('tagHangulRun', [run]) as never)
}
/** `tagHangulRun` over every run; the same array when no run needed a tag. */
export function tagHangulParagraphs(paragraphs: Paragraph[]): Paragraph[] {
  const tagged = call('tagHangulParagraphs', [paragraphs]) as never as Paragraph[] | null
  return tagged === null ? paragraphs : shared(paragraphs, tagged)
}
/**
 * Bytes of a <p:cxnSp>. CT_Connector's sequence is nvCxnSpPr/spPr/style/extLst —
 * there is no txBody child, so a connector can never gain text (PowerPoint offers no
 * text editing on a line either).
 */
export function isConnectorXml(xml: string): boolean {
  return call('isConnectorXml', [xml]) as never
}
/** Rebuild the <p:txBody>'s paragraph content on structural change, keeping the txBody wrapper and <a:bodyPr>. */
export function rebuildTxBody(el: TextElement, originalXml: string): string {
  return call('rebuildTxBody', [el, originalXml]) as never
}
/**
 * Generate <a:p> from a model paragraph (for the rebuild path).
 * Paragraph properties write only explicit items (per the pPrExplicit flags; no
 * flags = a newly created element, all model values treated as explicit); display
 * values inherited from lstStyle/placeholder/master are not baked in — the rebuild
 * keeps lstStyle and placeholder attributes, so inheritance still resolves along
 * the original chain in PowerPoint.
 */
export function generateParagraphXml(p: Paragraph): string {
  return call('generateParagraphXml', [p]) as never
}
export interface AlternateContentBranch {
  /** Byte range of the branch root (the p:sp / p:pic / p:graphicFrame inside the wrapper) */
  start: number
  end: number
  tag: string
  fallback: boolean
}
/**
 * Branch roots of an element anchored to a whole <mc:AlternateContent> block, or null for any
 * other anchor. The model reads one branch, so a patch has to land inside that branch: scanning
 * the block as one shape would count the runs/paragraphs of every branch and splice across the
 * Choice/Fallback boundary.
 */
export function alternateContentBranches(xml: string): AlternateContentBranch[] | null {
  return call('alternateContentBranches', [xml]) as never
}
/** Scan top-level children (depth 1) in the [from,to) range of an xml fragment, returning {name,start,end}. */
export function topLevelChildren(
  xml: string,
  from: number,
  to: number,
): Array<{ name: string; start: number; end: number }> {
  return call('topLevelChildren', [xml, from, to]) as never
}
/** Gradient fill write-back parameters (subset of the model's Fill gradient). */
export interface GradientFillPatch {
  stops: Array<{ pos: number; color: string }>
  /** 1/60000 degree (for linear) */
  angle?: number
  /** Radial (alias for path: 'circle') */
  radial?: boolean
  /** <a:path path> kind (PPT: radial/rectangular/path); linear when absent */
  path?: 'circle' | 'rect' | 'shape'
  /** <a:fillToRect> focus insets as fractions (default: centered 0.5 each) */
  fillTo?: { l: number; t: number; r: number; b: number }
}
export type FillPatch = 'none' | string | GradientFillPatch | { rawFillXml: string }
/**
 * In-place patch of an element's shape fill (the fill node that is a direct child of spPr):
 * fill='none' -> <a:noFill/>; hex -> <a:solidFill>. When a direct fill child exists, patch
 * in place for the same kind and replace the whole block across kinds (never touching the
 * solidFill inside a:ln); otherwise insert after the geometry (prstGeom/custGeom) or xfrm.
 */
export function patchElementFill(originalXml: string, fill: FillPatch): string {
  return call('patchElementFill', [originalXml, fill]) as never
}
// ── Stroke patch (dirtyStroke) ──────────────────────────────────────────

export interface StrokePatch {
  color: string
  widthEmu: number
  /** prstDash preset name; 'solid' removes the prstDash node; undefined keeps the original bytes */
  dash?: string
  /** Line cap attribute (undefined keeps the original bytes) */
  cap?: 'flat' | 'rnd' | 'sq'
  /** Compound type attribute ('sng' removes it; undefined keeps the original bytes) */
  compound?: 'sng' | 'dbl' | 'thickThin' | 'thinThick' | 'tri'
  /** Join child element (undefined keeps the original bytes) */
  join?: 'round' | 'bevel' | 'miter'
  /** Gradient line: replaces the fill child (color then only feeds callers' fallbacks); angle in 1/60000° */
  gradient?: { stops: Array<{ pos: number; color: string }>; angle: number }
}
/**
 * In-place patch of an element's stroke (the <a:ln> direct child of spPr):
 * stroke=null -> replace the fill child with <a:noFill/> (explicit no stroke, overriding
 * theme inheritance); otherwise change the w attribute and replace the fill child with a
 * solid color. With an existing a:ln only these spots are touched; other attributes
 * (cap/cmpd/algn) and children (headEnd/tailEnd/join) keep their original bytes; the
 * prstDash child is only rewritten when stroke.dash is set; without an a:ln, insert
 * after the fill/geometry.
 */
export function patchElementStroke(originalXml: string, stroke: StrokePatch | null): string {
  return call('patchElementStroke', [originalXml, stroke]) as never
}
// ── Slide background patch ──────────────────────────────────────────────

// ── Picture crop patch (dirtySrcRect) ───────────────────────────────────

/**
 * In-place patch of the <a:srcRect> inside a <p:pic>'s <p:blipFill>:
 * srcRect=null removes the srcRect (show the full image); otherwise writes the
 * l/t/r/b attributes (1/1000 %). Crop values are 0..1 fractions, converted to
 * OOXML's 0..100000 integers.
 */
export function patchPictureSrcRect(
  originalXml: string,
  srcRect: { l: number; t: number; r: number; b: number } | null,
): string {
  return call('patchPictureSrcRect', [originalXml, srcRect]) as never
}
/** Slide background image write-back parameters (the rel must already exist in the slide's rels). */
export interface BackgroundImagePatch {
  imageRid: string
  /** Tile instead of stretch */
  tile?: boolean
}
export type BackgroundFillPatch = string | GradientFillPatch | BackgroundImagePatch
/**
 * In-place patch of a slide's bodyPrefix: replace/inject the <p:bg> under <p:cSld>
 * with a solid color, gradient, or picture fill. Returns the new bodyPrefix (the
 * caller writes it back to slide.bodyPrefix and flags a rebuild).
 */
export function patchSlideBackgroundXml(bodyPrefix: string, fill: BackgroundFillPatch): string {
  return call('patchSlideBackgroundXml', [bodyPrefix, fill]) as never
}
/** Remove the slide's own <p:bg> override (background falls back to layout/master). */
export function removeSlideBackgroundXml(bodyPrefix: string): string {
  return call('removeSlideBackgroundXml', [bodyPrefix]) as never
}
/**
 * Toggle showMasterSp on the <p:sld> root ("hide background graphics").
 * hidden=true writes showMasterSp="0"; hidden=false removes the attribute
 * (default is shown).
 */
export function patchSlideShowMasterSpXml(bodyPrefix: string, hidden: boolean): string {
  return call('patchSlideShowMasterSpXml', [bodyPrefix, hidden]) as never
}
// ── Slide transition patch ──────────────────────────────────────────────

export type SlideTransitionKind =
  | 'none'
  | 'morph'
  | 'fade'
  | 'push'
  | 'wipe'
  | 'split'
  | 'circle'
  | 'cover'
  | 'pull'
  | 'dissolve'
  | 'zoom'
  | 'random'
export const TRANSITION_KINDS = [
  'none',
  'morph',
  'fade',
  'push',
  'wipe',
  'split',
  'circle',
  'cover',
  'pull',
  'dissolve',
  'zoom',
  'random',
] as const satisfies readonly SlideTransitionKind[]
/**
 * In-place patch of the bodySuffix's <p:transition> (schema order: after clrMapOvr,
 * before timing). kind='none' only removes the effect; 'morph' writes an
 * AlternateContent-wrapped p159:morph. A configured auto-advance time (advTm) is
 * kept when switching effects. Returns
 * the new bodySuffix.
 */
export function patchSlideTransitionXml(bodySuffix: string, kind: SlideTransitionKind): string {
  return call('patchSlideTransitionXml', [bodySuffix, kind]) as never
}
/** Read the current transition from the bodySuffix (for UI echo; unmodeled effects map to 'none'). */
export function readSlideTransitionXml(bodySuffix: string): SlideTransitionKind {
  return call('readSlideTransitionXml', [bodySuffix]) as never
}
/**
 * In-place patch of the bodySuffix's auto-advance time (PowerPoint's "advance slide
 * after / rehearse timings"). ms=null removes it; when the slide has no transition,
 * a new empty <p:transition> carrying only advTm is created. Returns the new bodySuffix.
 */
export function patchSlideAdvanceTimeXml(bodySuffix: string, ms: number | null): string {
  return call('patchSlideAdvanceTimeXml', [bodySuffix, ms]) as never
}
/** Read the auto-advance time from the bodySuffix (ms; null when unset). */
export function readSlideAdvanceTimeXml(bodySuffix: string): number | null {
  return call('readSlideAdvanceTimeXml', [bodySuffix]) as never
}
/** In-place patch of the show attribute on the bodyPrefix root element; hidden=false removes it. Returns the new bodyPrefix. */
export function patchSlideHiddenXml(bodyPrefix: string, hidden: boolean): string {
  return call('patchSlideHiddenXml', [bodyPrefix, hidden]) as never
}
/** Read whether the bodyPrefix marks the slide as hidden. */
export function readSlideHiddenXml(bodyPrefix: string): boolean {
  return call('readSlideHiddenXml', [bodyPrefix]) as never
}
// ── Geometry patch (dirtyTransform) ─────────────────────────────────────

export function generateXfrmXml(t: Transform, tag = 'a:xfrm'): string {
  return call('generateXfrmXml', [t, tag]) as never
}
/**
 * In-place patch of an element's xfrm (off/ext/rot/flip all taken from the model):
 * - sp/pic/grpSp: the first <a:xfrm> inside spPr/grpSpPr; when absent (placeholder
 *   inheriting geometry), inject a full <a:xfrm> after the spPr open tag.
 * - graphicFrame (table/chart/smartart/ole passthrough): <p:xfrm> (directly
 *   containing a:off/a:ext, required by the schema). Embedded content (OLE preview
 *   pictures etc.) may carry its own a:xfrm, so p:xfrm must be matched.
 *   Non-graphicFrame passthroughs have no p:xfrm and are returned unchanged.
 * - Existing xfrm: replace the whole block, but keep children other than off/ext
 *   (a group's chOff/chExt untouched).
 */
export function patchElementXfrm(el: SlideElement, originalXml: string): string {
  return call('patchElementXfrm', [el, originalXml]) as never
}
/**
 * Write back <a:normAutofit>'s fontScale/lnSpcReduction (thousandths of a percent,
 * 62500 = 62.5%). Clears the attribute when the ratio ≈1 / no reduction
 * (defaults are not written). Only effective when bodyPr already has
 * normAutofit (elements with autofit=shrink always do).
 */
export function patchBodyPrAutofit(
  xml: string,
  fontScale: number,
  lnSpcReduction?: number,
): string {
  return call('patchBodyPrAutofit', [xml, fontScale, lnSpcReduction]) as never
}