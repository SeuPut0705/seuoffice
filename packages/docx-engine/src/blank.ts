import type { NumberingLevel } from './types'
import { invoke, invokeAsync } from './engine'

/** numId of the template's bullet list definition */
export const BLANK_BULLET_NUM_ID = '1'
/** numId of the template's ordered (decimal) list definition */
export const BLANK_ORDERED_NUM_ID = '2'
/** Custom numbering level (one level of a multilevel list / bullet library / numbering library definition) */
export interface CustomNumberingLevel {
  /** w:numFmt:decimal/bullet/lowerLetter/upperRoman/chineseCountingThousand… */
  numFmt: string
  /** w14 enumeration behind numFmt "custom" ("Za prvé, Za druhé, …"), written as mc:AlternateContent */
  customFormat?: string
  /** w:lvlText: a pattern like "%1." or a literal bullet symbol */
  lvlText: string
  /** w:ind w:left(twips) */
  indentLeft: number
  /** w:ind w:hanging (twips, default 360) */
  hanging?: number
  /** w:start (default 1) */
  start?: number
  /** w:suff (default tab) */
  suff?: 'tab' | 'space' | 'nothing'
  /** w:lvlJc (default left) */
  lvlJc?: 'left' | 'center' | 'right'
  /** w:pPr/w:tabs: an explicit tab stop after the marker (twips) */
  tabStop?: number
  /** w:rPr of the marker: font family, size (half-points), color (hex), weight */
  font?: string
  szHalfPoints?: number
  color?: string
  bold?: boolean
  italic?: boolean
  /** w:pStyle: paragraphs in this style take the level's numbering */
  pStyle?: string
  /** w:isLgl: legal-style numbering (every placeholder shows as decimal) */
  isLgl?: boolean
  /** w:lvlRestart: restart this level after the given (higher) level; 0 = never */
  lvlRestart?: number
  /** w:lvlPicBulletId: draw a w:numPicBullet image instead of lvlText */
  picBulletId?: number
}
/** A parsed level in the shape the define/adjust dialogs edit */
export function customLevelFromNumberingLevel(level: NumberingLevel): CustomNumberingLevel {
  return invoke('customLevelFromNumberingLevel', [level]) as never
}
/** The renderer's overlay shape for a level the dialogs produced (display before save) */
export function numberingLevelFromCustom(
  l: CustomNumberingLevel,
  picBulletSrc?: string,
): NumberingLevel {
  return invoke('numberingLevelFromCustom', [l, picBulletSrc]) as never
}
/**
 * Merge a dialog-produced level into an existing w:lvl: the fields the level
 * carries replace their elements, everything else in the original (legacy,
 * w14 extensions, rPr children the dialogs do not know) keeps its bytes.
 */
export function mergeLevelXml(existing: string, l: CustomNumberingLevel, ilvl: number): string {
  return invoke('mergeLevelXml', [existing, l, ilvl]) as never
}
/** One w:lvl in CT_Lvl child order */
export function customLevelXml(l: CustomNumberingLevel, ilvl: number): string {
  return invoke('customLevelXml', [l, ilvl]) as never
}
export type BlankPaperSize = 'A4' | 'Letter'
export function paperSizeForRegion(region: string | null | undefined): BlankPaperSize {
  return invoke('paperSizeForRegion', [region]) as never
}
/** Paper size for a BCP 47 system locale such as `en-US` or `zh-Hans-CN`. */
export function paperSizeForLocale(locale: string | null | undefined): BlankPaperSize {
  return invoke('paperSizeForLocale', [locale]) as never
}
export interface BlankDocxOptions {
  /**
   * docDefaults East Asian font (w:eastAsia); pick per UI language so e.g.
   * Japanese/Korean users don't start with a Simplified-Chinese face.
   * When omitted no w:eastAsia is written — like an en-US Word document,
   * Word/our renderer then substitute per script when CJK text appears.
   */
  eastAsiaFont?: string
  /** Page size of the single section; defaults to A4. */
  paperSize?: BlankPaperSize
  /** Creation stamp of docProps/core.xml; defaults to now (tests pin a fixed date). */
  createdAt?: Date
  /** docProps/app.xml Application; defaults to "SeuOffice". */
  application?: string
  /** docProps/app.xml AppVersion; defaults to the docx-engine package version. */
  appVersion?: string
  /** docProps/app.xml Template; defaults to Word's "Normal.dotm". */
  template?: string
  /** drop the Application / AppVersion generator fields from docProps/app.xml
   *  (the Word-default Template stays); defaults to false. */
  omitGeneratorFields?: boolean
}
/** Build a minimal valid .docx: one empty paragraph, portrait page, standard styles. */
export async function buildBlankDocx(options?: BlankDocxOptions): Promise<Uint8Array> {
  return invokeAsync('buildBlankDocx', [options ?? {}, Date.now()]) as never
}