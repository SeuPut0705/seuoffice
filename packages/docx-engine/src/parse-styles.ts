// styles.xml: paragraph / character / table style resolution into the
// ParsedDoc style tables.
import type { DocDefaults, StyleDisplay } from './types'
import { invoke } from './engine'

/**
 * Style-chain run props under Word's rtl selection (probed, Word for Mac 2026-08):
 * rtl runs read only the Cs twins (w:bCs/w:iCs/w:szCs), non-rtl runs read only the
 * base props — no cross-fallback. Pass the run's cs flag; callers without run
 * context (style gallery previews, caret defaults) pass false (= non-rtl).
 */
export function styleRunFormat(
  display: StyleDisplay | undefined,
  cs: boolean,
): Pick<StyleDisplay, 'bold' | 'italic' | 'sizeHalfPoints'> {
  return invoke('styleRunFormat', [display, cs]) as never
}
export type CsFormat = { sizeHalfPoints: number; bold: boolean; italic: boolean }
/**
 * Cs set a paragraph hands its rtl runs for the twins they do not carry: paragraph
 * style, then docDefaults. A twin nobody sets is regular / 10pt — the base w:b /
 * w:sz of the chain never leak in (prod corpus 20261021 sample 007: a Heading1
 * `<w:b/><w:sz 32/>` run with only `<w:rtl/>` is 11pt regular in Word).
 */
export function paraCsFormat(
  paraStyle: StyleDisplay | undefined,
  docDefaults: DocDefaults | undefined,
): CsFormat {
  return invoke('paraCsFormat', [paraStyle, docDefaults]) as never
}