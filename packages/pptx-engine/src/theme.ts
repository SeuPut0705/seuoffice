/**
 * Theme reading (read-only, never written back).
 * Provides color scheme and font scheme lookups so inheritance resolution can turn
 * schemeClr / theme fonts into final values.
 */
import { type XmlNode } from './xml-utils'
import { call } from './engine'

export interface Theme {
  /** clrScheme: dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink → #RRGGBB */
  colors: Record<string, string>
  /**
   * Master p:clrMap (or slide/layout a:overrideClrMapping): schemeClr name → clrScheme key.
   * Dark masters invert it (bg1="dk1" tx1="lt1" …); absent → standard mapping.
   */
  clrMap?: Record<string, string>
  /** fontScheme: major / minor Latin fonts */
  majorFont?: string
  minorFont?: string
  /** fontScheme: major / minor East Asian fonts */
  majorEaFont?: string
  minorEaFont?: string
  /** fontScheme per-script fonts (<a:font script="Jpan" typeface=…/>), keyed by script tag */
  majorScriptFonts?: Record<string, string>
  minorScriptFonts?: Record<string, string>
  /** fontScheme: major / minor Complex Script fonts (Arabic/Hebrew/Thai/Hindi etc.) */
  majorCsFont?: string
  minorCsFont?: string
  /**
   * fmtScheme templates (referenced by style refs: fillRef/lnRef/effectRef; phClr is
   * substituted by the referencing side). Each entry is a parsed node (e.g.
   * { 'a:gradFill': {...} } / { 'a:ln': {...} } / { 'a:effectStyle': {...} }), mapping
   * to idx 1..3 in original XML order; bgFills map to idx 1001..1003.
   */
  fillStyles?: XmlNode[]
  lnStyles?: XmlNode[]
  effectStyles?: XmlNode[]
  bgFillStyles?: XmlNode[]
}
/**
 * PowerPoint paints `window`/`windowText` as the live system colors (white/black on every
 * modern desktop) and ignores a stale `lastClr`; other system colors keep the cached value.
 */
export function sysColorHex(val: unknown, lastClr: unknown): string {
  return call('sysColorHex', [val, lastClr]) as never
}
export function parseTheme(themeXml: string): Theme {
  return call('parseTheme', [themeXml]) as never
}
/**
 * Chart-part theme override (<a:themeOverride>, referenced from the chart's own
 * rels): the chart's schemeClr refs and default palette resolve against ITS
 * clrScheme/fontScheme, not the deck theme's — decks legitimately remap accents
 * per chart. Wrapping the override's themeElements as a full theme reuses
 * parseTheme; fields the override omits fall back to the base theme.
 */
export function themeWithOverride(base: Theme | undefined, overrideXml: string): Theme {
  return call('themeWithOverride', [base, overrideXml]) as never
}
/**
 * Theme font reference ("+mj-lt" / "+mn-ea" etc.) → final font name.
 * Values not starting with "+" are returned as-is; returns undefined when the theme has no match.
 */
/** 'han': ideographs without a language — resolves only when the theme names a single Han script */
export type EaScript = 'ja' | 'ko' | 'sc' | 'tc' | 'han'
/** East Asian script of a BCP-47 lang/altLang tag (ja-JP → ja, zh-TW → tc, zh-CN → sc). */
export function eaScriptOfLang(tag: unknown): Exclude<EaScript, 'han'> | undefined {
  return call('eaScriptOfLang', [tag], { undef: true }) as never
}
export function resolveFontRef(
  typeface: string | undefined,
  theme: Theme | undefined,
  /** Script of the text using an ea theme ref: with an empty <a:ea typeface=""/> PowerPoint
   *  takes the fontScheme's per-script entry (Jpan/Hang/Hans/Hant) before the Latin font. */
  eaScript?: EaScript,
): string | undefined {
  return call('resolveFontRef', [typeface, theme, eaScript], { undef: true }) as never
}
/** schemeClr name (e.g. 'tx1','bg1','accent1','phClr') → final #RRGGBB. */
export function resolveSchemeColor(
  name: string,
  theme: Theme | undefined,
  phClr?: string,
): string | undefined {
  return call('resolveSchemeColor', [name, theme, phClr], { undef: true }) as never
}
/**
 * Effective color mapping for a slide: slide/layout <a:overrideClrMapping> wins over the
 * master's <p:clrMap> (<a:masterClrMapping/> just inherits). Undefined → standard mapping.
 */
export function parseClrMap(
  masterXml?: string,
  layoutXml?: string,
  slideXml?: string,
): Record<string, string> | undefined {
  return call('parseClrMap', [masterXml, layoutXml, slideXml], { undef: true }) as never
}