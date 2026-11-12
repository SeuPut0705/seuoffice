import type { ParsedDoc, SectionInfo, SectionSettings, NoteProps, LineNumbering } from './types'
import { invoke } from './engine'

/** US Letter, portrait, 1-inch margins */
export const DEFAULT_SECTION: SectionSettings = {
  pageWidth: 12240,
  pageHeight: 15840,
  orientation: 'portrait',
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  pageBorder: false,
  columns: 1,
  headerDist: 720,
  footerDist: 720,
}
/** ST_Border line styles; every other w:val is an art (bitmap) border. */
export const LINE_BORDER_VALS = new Set([
  'single',
  'thick',
  'double',
  'dotted',
  'dashed',
  'dotDash',
  'dotDotDash',
  'triple',
  'thinThickSmallGap',
  'thickThinSmallGap',
  'thinThickThinSmallGap',
  'thinThickMediumGap',
  'thickThinMediumGap',
  'thinThickThinMediumGap',
  'thinThickLargeGap',
  'thickThinLargeGap',
  'thinThickThinLargeGap',
  'wave',
  'doubleWave',
  'dashSmallGap',
  'dashDotStroked',
  'threeDEmboss',
  'threeDEngrave',
  'outset',
  'inset',
])
/** Page setup from one w:sectPr XML slice. */
export function sectionSettingsFromXml(
  xml: string,
  opts: { gutterAtTop?: boolean } = {},
): SectionSettings {
  return invoke('sectionSettingsFromXml', [xml, opts.gutterAtTop]) as never
}
/**
 * Fields declared by a w:footnotePr / w:endnotePr element (sectPr or settings.xml);
 * undefined when the element is absent or declares none of them.
 */
export function notePropsFromXml(
  xml: string,
  tag: 'w:footnotePr' | 'w:endnotePr',
): NoteProps | undefined {
  return invoke('notePropsFromXml', [xml, tag], { undef: true }) as never
}
/** w:lnNumType of a sectPr slice; undefined when the section has no line numbering */
export function lineNumberingOf(xml: string): LineNumbering | undefined {
  return invoke('lineNumberingOf', [xml], { undef: true }) as never
}
/** Read page setup from the trailing (hidden) w:sectPr. */
export function readSectionSettings(parsed: ParsedDoc): SectionSettings {
  return invoke('readSectionSettings', [parsed.blocks.map((b) => ({ hidden: b.hidden, originalXml: b.originalXml, docxIndex: b.docxIndex })), parsed.gutterAtTop]) as never
}
/** On/off flag element (w:titlePg, w:evenAndOddHeaders, …) present and not switched
 *  off: matches self-closing and paired forms, w:val="0|false|off" counts as off. */
export function xmlFlagOn(xml: string, tag: string): boolean {
  return invoke('xmlFlagOn', [xml, tag]) as never
}
/**
 * Header/footer reference elements of a sectPr, in document order. Matching is
 * quote-agnostic and covers the empty element pair LibreOffice writes, so a
 * reference a producer spelled differently still resolves: matching only
 * self-closing double-quoted tags dropped the part from the model, the save
 * plan and the section info at once.
 */
export function hfReferenceTags(xml: string, kind: 'header' | 'footer'): string[] {
  return invoke('hfReferenceTags', [xml, kind]) as never
}
/** w:type of a header/footer reference element (undefined when undeclared) */
export function hfReferenceType(tag: string): string | undefined {
  return invoke('hfReferenceType', [tag], { undef: true }) as never
}
/** r:id of a header/footer reference element (undefined when undeclared) */
export function hfReferenceRId(tag: string): string | undefined {
  return invoke('hfReferenceRId', [tag], { undef: true }) as never
}
export function sectionFromSectPr(
  sectPrXml: string,
  firstBlockIndex: number,
  lastBlockIndex: number,
  gutterAtTop?: boolean,
): SectionInfo {
  return invoke('sectionFromSectPr', [sectPrXml, firstBlockIndex, lastBlockIndex, gutterAtTop]) as never
}
/**
 * Rewrite the sectPr page numbering w:pgNumType (fmt = number format, start = starting
 * page number; undefined fields are omitted, and the tag is removed when both are unset).
 * Schema order: pgNumType comes after pgMar/pgBorders and before cols/docGrid.
 */
export function applyPageNumType(
  sectPrXml: string,
  fmt: string | undefined,
  start: number | undefined,
): string {
  return invoke('applyPageNumType', [sectPrXml, fmt, start]) as never
}
/**
 * Insert tag as the first child of a sectPr. A self-closing <w:sectPr/> is
 * expanded to a pair first: the open-tag anchor matched that element whole, so
 * the child was written after it, as a sibling inside w:body / w:pPr.
 */
export function injectIntoSectPr(xml: string, tag: string): string {
  return invoke('injectIntoSectPr', [xml, tag]) as never
}
/**
 * Enumerate every section in document order. A paragraph-level w:sectPr
 * (section-break paragraph) closes its section; the trailing hidden sectPr closes the last.
 * Block ranges use docxIndex (body child order), boundaries inclusive.
 */
export function readSections(parsed: ParsedDoc): SectionInfo[] {
  return invoke('readSections', [parsed.blocks.map((b) => ({ hidden: b.hidden, originalXml: b.originalXml, docxIndex: b.docxIndex })), parsed.gutterAtTop]) as never
}
/**
 * w:pgBorders for pageBorderProps. Without props the legacy single-line box
 * (½ pt, 24 pt from the page edge) is written; props with no sides yield ''.
 */
export function pageBordersXml(props: SectionSettings['pageBorderProps']): string {
  return invoke('pageBordersXml', [props]) as never
}
/** Rewrite pgSz / pgMar inside a w:sectPr XML slice, preserving everything else. */
export function applySectionSettings(sectPrXml: string, settings: SectionSettings): string {
  return invoke('applySectionSettings', [sectPrXml, settings]) as never
}
/**
 * Rewrite the sectPr start type w:type (how this section starts relative to the previous
 * one). nextPage is the default and is written by removing the tag; w:type comes before
 * pgSz in CT_SectPr.
 */
export function applySectionStartType(
  sectPrXml: string,
  type: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn',
): string {
  return invoke('applySectionStartType', [sectPrXml, type]) as never
}
/** set or remove w:titlePg (different first page) at its CT_SectPr position */
export function applyTitlePg(sectPrXml: string, on: boolean): string {
  return invoke('applyTitlePg', [sectPrXml, on]) as never
}
/** Read the page color (w:background) from document.xml; null when unset. */
export function readPageColor(parsed: ParsedDoc): string | null {
  return invoke('readPageColor', [parsed.internal.documentXml]) as never
}