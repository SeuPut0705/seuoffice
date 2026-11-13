// Block-level content controls (w:sdt): the metadata a control carries and the
// bytes a newly created one is written as. A control wraps body blocks
// (paragraphs, tables) so a consumer can find them by tag and confirm they
// were not reflowed.

/**
 * The lock states a block-level content control can carry (w:sdtPr/w:lock
 * @w:val). 'none' writes no w:lock element at all.
 */
import { invoke } from './engine'

// Block-level content controls (w:sdt): the metadata a control carries and the
// bytes a newly created one is written as. A control wraps body blocks
// (paragraphs, tables) so a consumer can find them by tag and confirm they
// were not reflowed.

/**
 * The lock states a block-level content control can carry (w:sdtPr/w:lock
 * @w:val). 'none' writes no w:lock element at all.
 */
export const CONTENT_CONTROL_LOCKS = [
  'none',
  'sdtLocked',
  'contentLocked',
  'sdtContentLocked',
] as const
export type ContentControlLock = (typeof CONTENT_CONTROL_LOCKS)[number]
/** what a content control carries */
export interface ContentControlSpec {
  /** programmatic tag (w:sdtPr/w:tag @w:val) */
  tag?: string
  /** human-visible title (w:sdtPr/w:alias @w:val) */
  title?: string
  /** lock state; 'none' (the default) writes no w:lock element */
  lock?: ContentControlLock
  /** control id (w:sdtPr/w:id @w:val); empty = the caller assigns one */
  id?: string
}
/** the lock states a control can carry, 'none' included */
export function isContentControlLock(value: unknown): value is ContentControlLock {
  return invoke('isContentControlLock', [value]) as never
}
/** the opening and closing bytes of a block-level content control */
export interface ContentControlShell {
  /** <w:sdt><w:sdtPr>…</w:sdtPr><w:sdtContent> */
  openXml: string
  /** </w:sdtContent></w:sdt> */
  closeXml: string
}
/**
 * The opening and closing bytes of a block-level content control (w:sdt).
 * The w:sdtPr children follow the CT_SdtPr order (alias, tag, id, lock, then
 * the control type), so Word accepts the control as written.
 */
export function buildContentControlXml(spec: ContentControlSpec): ContentControlShell {
  return invoke('buildContentControlXml', [spec]) as never
}
/**
 * The next free control id (w:sdtPr/w:id) in a document: Word keeps the ids
 * unique across the file, so a new control takes the next number.
 */
export function nextContentControlId(documentXml: string): number {
  return invoke('nextContentControlId', [documentXml]) as never
}
