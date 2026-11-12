/**
 * Complex fields are begin/separate/end run triples, and Word treats an
 * unbalanced sequence as a damaged file (repair prompt, or the rest of the
 * document swallowed as one field result). Editing a field whose result spans
 * paragraphs (Zotero bibliographies) can drop the paragraph carrying the begin
 * or the end run, so the assembled body is balanced once more before it is
 * written: stray separate/end runs go, and a begin left open is closed at the
 * end of its own paragraph so the field keeps its code and first result line.
 */
import { invoke } from './engine'

export function balanceFieldChars(bodyXml: string): string {
  return invoke('balanceFieldChars', [bodyXml]) as never
}
