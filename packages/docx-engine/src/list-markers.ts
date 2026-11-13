import type { NumberingDef } from './types'
import { invoke } from './engine'

/** w14 custom numFmt enumeration ("α, β, γ, ..."): comma-separated items, a trailing "..." marks continuation */
export function customEnumItems(format: string): string[] | null {
  return invoke('customEnumItems', [format]) as never
}
export function formatNumber(rawValue: number, numFmt: string, customFormat?: string): string {
  return invoke('formatNumber', [rawValue, numFmt, customFormat]) as never
}
export interface ListItemRef {
  numId: string | null
  ilvl: number
  /** paragraph mark is a tracked deletion: Word merges it into the next paragraph, so it
   *  shows that paragraph's number without consuming one */
  deleted?: boolean
}
export interface ListMarkerInfo {
  /** display text (symbol glyphs decoded to Unicode) */
  text: string
  /** bullets declared in a symbol-encoded font: original glyph in U+F0xx form, so the renderer can pass it through when the font is installed */
  symbolChar?: string
  symbolFont?: string
  /** picture bullet (w:lvlPicBulletId): data URL drawn in place of the text */
  picBulletSrc?: string
  /** literal bullet text declared in an ordinary text font (Word's "o" in Courier New) */
  font?: string
  /** the item's own counter value (numbered levels only) */
  value?: number
}
export interface BulletSubstitute {
  glyph: string
  face: string
}
export function substituteBullet(glyph: string): BulletSubstitute | null {
  return invoke('substituteBullet', [glyph]) as never
}
export const SEGOE_UI_SYMBOL_RE = /^segoe ui symbol$/
/** the face Word substitutes when a text-font marker glyph is missing from its face */
export function markerFallbackFace(glyph: string, face: string): string | null {
  return invoke('markerFallbackFace', [glyph, face]) as never
}
/**
 * Word numbering semantics: counters accumulate document-wide per abstractNum
 * (plain paragraphs in between don't break the sequence); when a level appears,
 * its deeper levels reset; startOverride applies the first time that numId uses
 * the level. Returns a marker array the same length as items; items without a
 * definition return null (CSS fallback handles them).
 */
export function computeListMarkerInfos(
  items: ListItemRef[],
  defs: Map<string, NumberingDef>,
): (ListMarkerInfo | null)[] {
  return invoke('computeListMarkerInfos', [items, defs]) as never
}
/** Per item: the counter value its own level shows (1 for bullets and unresolved items) */
export function computeListValues(items: ListItemRef[], defs: Map<string, NumberingDef>): number[] {
  return invoke('computeListValues', [items, defs]) as never
}
export function computeListMarkers(
  items: ListItemRef[],
  defs: Map<string, NumberingDef>,
): (string | null)[] {
  return invoke('computeListMarkers', [items, defs]) as never
}
/**
 * Word's default tab after a numbering marker: when the marker fits the hanging
 * area the text starts at the text indent, unless a custom stop sits between
 * the marker end and that indent (the text indent is only an implicit stop;
 * explicit stops before it still catch the tab). Otherwise it jumps to the
 * next tab stop past the marker end — the paragraph's custom stops first, the
 * default grid only beyond the last custom stop (a custom stop clears the
 * default stops left of it). All positions are twips relative to the text
 * column edge. Returns the marker-box width (marker start -> text start), or
 * null when the text starts at the hanging indent.
 */
export function markerTabAdvance(
  markerStart: number,
  markerWidth: number,
  textIndent: number,
  defaultTab = 720,
  customStops: number[] = [],
): number | null {
  return invoke('markerTabAdvance', [
    markerStart,
    markerWidth,
    textIndent,
    defaultTab,
    customStops,
  ]) as never
}
