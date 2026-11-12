/**
 * Compare two documents the way Word's Review > Compare does: the revised
 * document's content with the differences marked as tracked insertions and
 * deletions, so the result can be accepted or rejected like any other redline.
 *
 * The revision marks are the ones the rest of the suite already writes. A run
 * carries `ins` / `del` (see Run in types.ts) and the generator wraps
 * consecutive runs of the same revision in w:ins / w:del (see generate.ts);
 * a paragraph inserted or deleted as a whole additionally carries the record
 * on its paragraph mark (w:pPr/w:rPr) — Word's own Compare shape, which
 * accept / reject resolve to the revised / original document. A non-paragraph
 * block (a table) keeps the block-level w:ins / w:del wrapper. A redline
 * written here therefore resolves through the same accept / reject path.
 *
 * Out of scope: w:rPrChange / w:pPrChange records and moved text. A run whose
 * formatting changed is reported as a deletion of the old run plus an
 * insertion of the new one, which is honest but more verbose than Word.
 */
import { type ParsedDocFull, type SaveBlock } from './patch'
import { invoke } from './engine'
import * as hand from './engine-hand'

/** at what granularity a changed paragraph is diffed */
export type CompareGranularity = 'word' | 'char'
/** what the comparison leaves out */
export type CompareIgnore = 'formatting' | 'case' | 'whitespace'
export interface CompareOptions {
  /** author recorded on every revision; default "SeuOffice" */
  author?: string
  /** ISO timestamp recorded on every revision; default: now */
  date?: string
  /** default "word" */
  granularity?: CompareGranularity
  /** default: nothing is ignored */
  ignore?: readonly CompareIgnore[]
}
export interface CompareSummary {
  /** paragraphs the revised document adds */
  insertedParagraphs: number
  /** paragraphs the revised document drops */
  deletedParagraphs: number
  /** paragraphs both have, with a different content */
  changedParagraphs: number
  /** paragraphs both have, identical */
  unchangedParagraphs: number
  /** inserted text regions (w:ins) */
  insertions: number
  /** deleted text regions (w:del) */
  deletions: number
}
export interface CompareResult {
  /** the redline document */
  bytes: Uint8Array
  summary: CompareSummary
}
/** the author recorded when the caller names none */
export const DEFAULT_COMPARE_AUTHOR = 'SeuOffice'
/**
 * Build the redline: the revised document with the differences marked as
 * tracked insertions and deletions.
 */
export async function compareDocuments(
  original: ParsedDocFull,
  revised: ParsedDocFull,
  options: CompareOptions = {},
): Promise<CompareResult> {
  return hand.compareDocuments(original, revised, options) as never
}
/** the save plan of a comparison, for a caller that writes the file itself */
export function compareBlocks(
  original: ParsedDocFull,
  revised: ParsedDocFull,
  options: CompareOptions = {},
): { blocks: SaveBlock[]; summary: CompareSummary; nextRevisionId: number } {
  return invoke('compareBlocks', [original.blocks, revised.blocks, revised.internal.documentXml, options ?? {}, new Date().toISOString()]) as never
}