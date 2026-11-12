import type { TabStop } from './types'
import { invoke } from './engine'

/** Run properties of a style definition; a present key sets, null clears, absent keeps. */
export interface StyleRunProps {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  caps?: boolean
  smallCaps?: boolean
  /** hex without '#' */
  color?: string | null
  /** w:highlight color name (yellow, green, ...) */
  highlight?: string | null
  sizeHalfPoints?: number | null
  /** Latin face (w:ascii / w:hAnsi); theme font attributes are dropped so it takes effect */
  font?: string | null
  /** East Asian face (w:eastAsia) */
  eastAsiaFont?: string | null
}
/** Paragraph properties of a style definition; same patch semantics as StyleRunProps. */
export interface StyleParaProps {
  align?: 'left' | 'center' | 'right' | 'justify' | null
  spaceBeforeTwips?: number | null
  spaceAfterTwips?: number | null
  /** line spacing as a multiple (auto) */
  lineSpacing?: number | null
  indentLeftTwips?: number | null
  indentRightTwips?: number | null
  /** positive = first-line indent, negative = hanging indent */
  firstLineTwips?: number | null
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
  /** 1-9 (w:outlineLvl val + 1) */
  outlineLevel?: number | null
  /** list level linked to the style (w:numPr); null removes it */
  numPr?: { numId: string; ilvl: number } | null
  /** w:tabs of the style; [] or null removes the element */
  tabStops?: TabStop[] | null
}
/**
 * Create or modify one style in word/styles.xml. An existing definition is
 * patched property by property: children the patch does not name (link,
 * uiPriority, rsid, tblPr, ...) keep their bytes, and w:spacing / w:ind /
 * w:rFonts keep the attributes the patch does not set.
 */
export interface StyleHeadingInfo {
  name?: string
  basedOn?: string
  headingLevel?: number
  headingLevelInherited?: boolean
  /** own w:outlineLvl 9 (body text); kept by a patch that does not set outlineLevel */
  headingOutlineOff?: boolean
}
/**
 * Heading level a pending paragraph style resolves to once saved, mirroring parse-styles on
 * reopen: heading name or id, else its own outline level (`null` or an existing w:outlineLvl 9
 * = body text), else the nearest basedOn ancestor's. An existing style keeps what it has unless the upsert moves
 * an inherited level to a new parent.
 */
export function pendingHeadingLevel(
  styleId: string,
  pending: (id: string) => StyleUpsert | undefined,
  existing: (id: string) => StyleHeadingInfo | undefined,
  seen: Set<string> = new Set(),
): number | undefined {
  return invoke('pendingHeadingLevel', [styleId, pending, existing, seen], {
    names: ['styleId', 'pending', 'existing', 'seen'],
    undef: true,
  }) as never
}
export interface StyleUpsert {
  styleId: string
  /** used when creating (default paragraph); an existing style keeps its type */
  type?: 'paragraph' | 'character' | 'table'
  /** display name; defaults to styleId when creating */
  name?: string
  /** null removes w:basedOn */
  basedOn?: string | null
  /** style of the following paragraph; null removes w:next */
  next?: string | null
  /** w:qFormat (quick style gallery); new styles default to true */
  quickFormat?: boolean
  /** one of Word's built-in styles (by name): created without w:customStyle */
  builtIn?: boolean
  rPr?: StyleRunProps
  pPr?: StyleParaProps
}
/**
 * Word's built-in "heading N" for a document that defines none: the same
 * definition the blank template ships (bold, keep-with-next, outline level,
 * quick-style), based on the document's default paragraph style so its fonts
 * show through. The id is HeadingN — parse-styles reads that id as the level
 * even without the name, so the saved heading survives reopen.
 */
export function builtInHeadingStyleUpsert(
  level: number,
  defaultParagraphStyleId: string | undefined,
): StyleUpsert {
  return invoke('builtInHeadingStyleUpsert', [level, defaultParagraphStyleId]) as never
}
/** The w:style element after applying `up` to `existing` (null = create). */
export function mergeStyleXml(existing: string | null, up: StyleUpsert): string {
  return invoke('mergeStyleXml', [existing, up]) as never
}
/** Patch only the requested default font slots, preserving all other defaults. */
export type DefaultFonts = Pick<StyleRunProps, 'font' | 'eastAsiaFont'>
export function mergeDefaultFontsXml(xml: string, fonts: DefaultFonts): string {
  return invoke('mergeDefaultFontsXml', [xml, fonts]) as never
}
