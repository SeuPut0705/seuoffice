/**
 * Symbol-encoded legacy fonts (Symbol / Wingdings / Webdings) carry glyphs at
 * arbitrary byte positions, stored either as that byte or as U+F0xx (private
 * use). Without the font installed they render as the raw letter or tofu, so
 * map every glyph to a Unicode stand-in for display.
 *
 * Tables follow the public Symbol / Wingdings / Webdings -> Unicode charts
 * (the Unicode 7.0 dingbat additions). Where that equivalent lives outside the
 * repertoire of the symbol fonts common desktops ship (Apple Symbols, Zapf
 * Dingbats, Menlo, Segoe UI Symbol, DejaVu), the nearest widely available
 * glyph stands in instead, so a glyph never falls back to tofu.
 */
import { invoke } from './engine'

export function isSymbolFont(font: string | null | undefined): boolean {
  return invoke('isSymbolFont', [font]) as never
}
/** glyph code (raw byte or its U+F0xx private-use form) → Unicode equivalent, null when unknown */
export function decodeSymbolChar(font: string, code: number): string | null {
  return invoke('decodeSymbolChar', [font, code]) as never
}
/** the U+F0xx private-use form of a w:sym hex char (how symbol-font cmaps index glyphs); null = bad char */
export function symbolPuaChar(charHex: string): string | null {
  return invoke('symbolPuaChar', [charHex]) as never
}
/** display glyph of a w:sym (font + hex char): the Unicode equivalent when the
 *  font is a known symbol face, else the U+F0xx private-use form; null = bad char */
export function symbolGlyph(font: string, charHex: string): string | null {
  return invoke('symbolGlyph', [font, charHex]) as never
}
/** raw-byte glyph codes → their U+F0xx private-use form (how symbol-font cmaps index glyphs) */
export function toSymbolPua(text: string): string {
  return invoke('toSymbolPua', [text]) as never
}
/** whole string decode; null unless every non-whitespace char maps. `textGlyphsOnly`
 *  (text runs, which keep their font otherwise) also refuses pictograph stand-ins and
 *  ASCII approximations (Webdings 0x3E -> A), so the font is only dropped for glyphs a
 *  text font draws faithfully */
export function decodeSymbolText(
  font: string,
  text: string,
  opts?: { textGlyphsOnly?: boolean },
): string | null {
  return invoke('decodeSymbolText', [font, text, !!opts?.textGlyphsOnly]) as never
}