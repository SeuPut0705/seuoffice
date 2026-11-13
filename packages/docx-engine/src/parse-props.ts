// Pure XML -> value readers for paragraph, run and table-cell properties
// (no document context, no recursion into block builders).
import { maskOpaque } from './xml-utils'
import type { ParaBorderSides, ParaFormat, Run, ThemeFonts } from './types'
import { findStartTag } from './xml-tag'
import { invoke } from './engine'

/** No run un-hides itself and nothing anchors here (bookmarks, comments, sectPr,
 *  drawings): safe to collapse a style-vanished paragraph entirely. Numbering is
 *  fine: the hidden item still advances the counter (see hiddenParagraph) */
export function staysVanished(xml: string): boolean {
  return invoke('staysVanished', [xml]) as never
}
/**
 * Exact <w:pPr>...</w:pPr> slice of a paragraph (depth-aware: pPrChange nests
 * another w:pPr inside). undefined when the paragraph has no properties.
 */
export function rawPPrOf(xml: string): string | undefined {
  // tags are found in the XML with its comments and CDATA blanked, so their
  // text is never a tag; the slice is of the XML itself
  const masked = maskOpaque(xml)
  // the paragraph's own pPr must be the first child of w:p; a later match
  // would belong to nested content (textbox paragraphs)
  const openEnd = findStartTag(masked)?.end
  if (openEnd === undefined) return undefined
  // pretty-printed sources put whitespace between <w:p> and its pPr
  const start = openEnd + (/^\s*/.exec(masked.slice(openEnd))?.[0].length ?? 0)
  if (!masked.startsWith('<w:pPr', start)) return undefined
  const re = /<w:pPr(?=[\s/>])|<\/w:pPr\s*>/g
  re.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(masked)) !== null) {
    if (match[0].startsWith('</')) {
      depth--
      if (depth === 0) return xml.slice(start, match.index + match[0].length)
    } else {
      // self-closing <w:pPr/> never opens
      const tag = findStartTag(masked, 'w:pPr', match.index)
      if (tag?.selfClosing) {
        if (depth === 0) return xml.slice(start, tag.end)
        re.lastIndex = tag.end
        continue
      }
      depth++
    }
  }
  return undefined
}
/** drop textbox content so "does the paragraph itself have text" checks work */
export function stripTextboxes(xml: string): string {
  return invoke('stripTextboxes', [xml]) as never
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
