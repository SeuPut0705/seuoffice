// Field-code display (PAGE, TOC, REF, ...) and TOC entry numbering.
import type { FieldDisplay, StyleInfo } from './types'
import { type ResolveCtx } from './resolve-props'
import { invoke } from './engine'

/**
 * Display-only rendering hint for protected field paragraphs. The visible
 * field *result* (w:t runs; instruction text lives in w:instrText and is
 * excluded) is shown instead of a generic chip. Original XML still saves
 * byte-identical.
 */
/** TOC entry level: styleId "TOC1" (Word) / "TOC 1" (Pages), or the style's
 *  name "toc 1" when the styleId is opaque (html2docx exports numeric ids) */
export function tocLevelOf(styleId: string, styles?: Map<string, StyleInfo>): number | null {
  return invoke('tocLevelOf', [styleId, styles]) as never
}
export function fieldDisplayOf(
  xml: string,
  styles?: Map<string, StyleInfo>,
  resolver?: ResolveCtx,
): FieldDisplay | undefined {
  return invoke('fieldDisplayOf', [xml, styles, resolver], { undef: true }) as never
}
