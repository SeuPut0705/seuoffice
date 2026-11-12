/**
 * The one character classification every Word-layout rule reads. Rules never
 * spell code-point ranges themselves: a class here is the vocabulary (Word's
 * single-byte / double-byte split, East Asian script membership, the gaps
 * autospace pads), and each predicate names the set a probe measured.
 */
import { invoke } from './engine'

/**
 * The one character classification every Word-layout rule reads. Rules never
 * spell code-point ranges themselves: a class here is the vocabulary (Word's
 * single-byte / double-byte split, East Asian script membership, the gaps
 * autospace pads), and each predicate names the set a probe measured.
 */
export type CharClass =
  | 'han'
  | 'kana'
  | 'hangul'
  | 'bopomofo'
  | 'cjkPunct'
  | 'cjkSymbol'
  | 'fullwidth'
  | 'halfwidthEA'
  | 'ideographicSpace'
  | 'latinLetter'
  | 'digit'
  | 'asciiPunct'
  | 'space'
  | 'nbsp'
  | 'tab'
  | 'other'
export function charClass(cp: number): CharClass {
  return invoke('charClass', [cp]) as never
}
/** hangul syllables, jamo and compatibility jamo (Korean line and wrap rules) */
export function isHangulChar(cp: number): boolean {
  return invoke('isHangulChar', [cp]) as never
}
/** every East Asian character: the scripts, their punctuation, symbols and width forms */
export function isEastAsianChar(cp: number): boolean {
  return invoke('isEastAsianChar', [cp]) as never
}
/** Word's double-byte character: an East Asian character of full-width advance
 *  (halfwidth forms are single-byte for the character grid and balance rules) */
export function isDoubleByteChar(cp: number): boolean {
  return invoke('isDoubleByteChar', [cp]) as never
}
/** Han / kana / hangul letters: the East Asian side of an autoSpaceDE/DN gap
 *  (punctuation, symbols and width forms get none) */
export function isCjkLetterChar(cp: number): boolean {
  return invoke('isCjkLetterChar', [cp]) as never
}
/** Latin letters and digits: the other side of an autospace gap */
export function isLatinAlnumChar(cp: number): boolean {
  return invoke('isLatinAlnumChar', [cp]) as never
}
export function textHasEastAsian(text: string): boolean {
  return invoke('textHasEastAsian', [text]) as never
}
export function textHasHangulChars(text: string): boolean {
  return invoke('textHasHangulChars', [text]) as never
}
/** w:lang tag of an East Asian language (zh / ja / ko); `korean:false` for the
 *  ja/zh-only rules (punctuation compression, hanging: Word probe
 *  2026-09-05 ko-KR neither hangs nor compresses) */
export function isEastAsianLangTag(tag: string | null | undefined, korean = true): boolean {
  return invoke('isEastAsianLangTag', [tag, korean]) as never
}
