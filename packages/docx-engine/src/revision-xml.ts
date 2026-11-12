/**
 * Accept / reject tracked changes in a raw WordprocessingML part (headers,
 * footers, footnotes, endnotes): the parts the editor never loads as nodes.
 * Word's Accept All semantics on the markup itself: deleted runs leave,
 * inserted runs stay unwrapped, moved text stays only at its destination,
 * property-change records drop, a deleted paragraph mark joins the paragraph
 * into the next one, a deleted row goes.
 */
import { invoke } from './engine'

/**
 * Accept / reject tracked changes in a raw WordprocessingML part (headers,
 * footers, footnotes, endnotes): the parts the editor never loads as nodes.
 * Word's Accept All semantics on the markup itself: deleted runs leave,
 * inserted runs stay unwrapped, moved text stays only at its destination,
 * property-change records drop, a deleted paragraph mark joins the paragraph
 * into the next one, a deleted row goes.
 */

export type RevisionXmlMode = 'accept' | 'reject'
export type RevisionXmlType = 'insertion' | 'deletion' | 'formatting' | 'move'
export interface RevisionXmlFilter {
  /** case-insensitive w:author match */
  author?: string
  type?: RevisionXmlType
  /** ISO date: only changes recorded strictly before it; without a zone designator it is UTC, as a w:date is */
  before?: string
  /** exact w:date match */
  date?: string
  /** w:id of the wrapper / record */
  ids?: string[]
}
/** one accept / reject the editor applied to a part it holds as a display model */
export interface RevisionResolution {
  mode: RevisionXmlMode
  /** absent = every tracked change in the part */
  filter?: RevisionXmlFilter
}
export interface RevisionXmlResult {
  xml: string
  /** revisions the mode was applied to */
  applied: number
  /** revisions still in the part afterwards */
  remaining: number
}
/**
 * Epoch ms of a revision date (a w:date, or the `before` of a filter); NaN
 * when it is no date. An ISO date-time without a zone designator is UTC:
 * Date.parse reads it as local time, and a filter would pick different
 * changes on machines in different zones. Any other form (a date alone, a
 * date with its zone spelled out) is read as Date.parse reads it. The
 * editor's filter over body revisions reads dates through this too.
 */
export function revisionDateMs(iso: string): number {
  return invoke('revisionDateMs', [iso]) as never
}
/** a change recorded at `date` lies strictly before `beforeMs`; a w:date that is no date does not */
export function revisionDateBefore(date: string | undefined, beforeMs: number): boolean {
  return invoke('revisionDateBefore', [date, beforeMs]) as never
}
/** pending tracked changes in a part (range markers not counted) */
export function countTrackedChangesXml(xml: string): number {
  return invoke('countTrackedChangesXml', [xml]) as never
}
export function applyTrackedChangesXml(
  xml: string,
  mode: RevisionXmlMode,
  filter?: RevisionXmlFilter,
): RevisionXmlResult {
  return invoke('applyTrackedChangesXml', [xml, mode, filter]) as never
}
/** the editor's accept / reject decisions replayed on the part's original bytes */
export function applyRevisionResolutions(
  xml: string,
  resolutions: readonly RevisionResolution[] | undefined,
): string {
  return invoke('applyRevisionResolutions', [xml, resolutions]) as never
}
export interface PropChangeRecord {
  author: string
  date?: string
  dateUtc?: string
  id?: string
  /** inner XML of the recorded previous properties (empty for records without one) */
  oldXml: string
  /** w:cellMerge only: the merge state after / before the revision */
  vMerge?: string
  vMergeOrig?: string
}
/**
 * The first `changeName` record (w:tblPrChange, w:trPrChange, w:tcPrChange, w:tblGridChange,
 * w:tblPrExChange, w:sectPrChange, w:numberingChange, w:cellMerge) in a property fragment.
 */
export function readPropChangeXml(xml: string, changeName: string): PropChangeRecord | undefined {
  return invoke('readPropChangeXml', [xml, changeName], { undef: true }) as never
}
/**
 * Resolve one property-change record inside a property fragment (a raw tblPr / trPr /
 * tcPr / tblGrid / tblPrEx / pPr-with-sectPr slice): accept drops the record, reject
 * puts the recorded previous properties back. Records without a previous-properties
 * payload (numberingChange, cellMerge) just drop.
 */
export function resolvePropChangeXml(
  xml: string,
  changeName: string,
  mode: RevisionXmlMode,
): string {
  return invoke('resolvePropChangeXml', [xml, changeName, mode]) as never
}
/**
 * Drop orphaned move-range markers: an end whose start is gone (the moved
 * paragraph was accepted / rejected, so the wrapper left and the untouched
 * following paragraph keeps the end), and defensively a start whose end is
 * gone. A range pairs by side and w:id (a moveFrom range and a moveTo range
 * that happen to share an id are independent), and an end closes the nearest
 * still-open start of its side, mirroring how the parser closes the ranges it
 * reads. A range with both markers (a still-pending move) is left alone. The
 * final save runs this over the body and every story part because the editor
 * rebuilds edited paragraphs from its model, which does not model the range
 * markers.
 */
export function cleanMoveRangeMarkers(xml: string): { xml: string; removed: number } {
  return invoke('cleanMoveRangeMarkers', [xml]) as never
}