// Pure XML -> value readers for paragraph, run and table-cell properties
// (no document context, no recursion into block builders).
import type { ParaBorderSides, ParaFormat, Run, ThemeFonts } from './types'
import { invoke } from './engine'

/** No run un-hides itself and nothing anchors here (bookmarks, comments, sectPr,
 *  drawings): safe to collapse a style-vanished paragraph entirely. Numbering is
 *  fine: the hidden item still advances the counter (see hiddenParagraph) */
export function staysVanished(xml: string): boolean {
  return invoke('staysVanished', [xml]) as never
}
/** twips of one "character" for each family of character-unit indents */
export interface CharUnits {
  /** w:firstLineChars / w:hangingChars: the paragraph's first text run — its font
   *  size plus its letter spacing (plus the section's character-grid pitch delta) */
  run: number
  /** w:leftChars / w:rightChars: the default paragraph style's (Normal) font size —
   *  whatever the paragraph's own style or runs say (plus the grid delta) */
  normal: number
}
/** Word's face for an East Asian theme slot whose typeface is empty (<a:ea typeface=""/>) */
export const EMPTY_EA_THEME_FONT = 'DengXian'
/** empty-EA-slot face themeFontLang specifically resolves (theme script table first,
 * then the probed per-language defaults); undefined = only the generic DengXian applies */
export function themeLangEaSlotFont(
  fonts: ThemeFonts,
  eaRef: string | undefined,
): string | undefined {
  return invoke('themeLangEaSlotFont', [fonts, eaRef], { undef: true }) as never
}
/** xml:space="preserve" declared on the part's root element — an inherited XML
 *  scope covering every w:t below it (PDF-to-DOCX converters set it once on
 *  w:document/w:hdr instead of per element; Word honors the inheritance) */
export function partXmlSpacePreserve(partXml: string, rootTag: string): boolean {
  return invoke('partXmlSpacePreserve', [partXml, rootTag]) as never
}
export function mergeRuns(runs: Run[]): Run[] {
  return invoke('mergeRuns', [runs]) as never
}
export type ParaBorderModel = Pick<
  ParaFormat,
  'borders' | 'borderLines' | 'borderReset' | 'borderPad'
>
/**
 * Word merges pBdr per side: every side the direct pPr declares (drawn or reset)
 * wins, the style fills in the rest. Model form for consumers without a style
 * CSS layer (header/footer paragraphs).
 */
export function mergeStyleBorders(
  sides: ParaBorderSides,
  direct: ParaBorderModel | undefined,
): Pick<ParaFormat, 'borders' | 'borderLines' | 'borderPad'> {
  return invoke('mergeStyleBorders', [sides, direct]) as never
}
