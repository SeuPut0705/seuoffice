/**
 * Section read/write — modeled after PowerPoint's "sections".
 *
 * OOXML storage: inside <p:extLst> at the end of ppt/presentation.xml:
 *   <p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">
 *     <p14:sectionLst xmlns:p14="…/powerpoint/2010/main">
 *       <p14:section name="…" id="{GUID}">
 *         <p14:sldIdLst><p14:sldId id="256"/>…</p14:sldIdLst>
 *       </p14:section>…
 *
 * Note: a p14:sldId's id is the numeric slide id from p:sldIdLst (what PowerPoint
 * actually writes), not an rId; parsing tolerates the odd generator that writes
 * rIds by mistake.
 *
 * After slide-order changes (adding/deleting slides), section data may be stale
 * (dangling references / incomplete coverage), so every edit operation first does
 * a positional normalization: each section covers [its first slide, next
 * section's first slide), and slides before the first section count as
 * unsectioned — an intuitive rule that naturally self-heals stale
 * references.
 */
import type { OpenedPptx } from './index'
import { call } from './engine'

export interface SectionInfo {
  /** Section GUID (with braces, PowerPoint style) */
  id: string
  name: string
  /** Indices in deck.slides of the slides in this section (in slide order) */
  slideIndices: number[]
}
/**
 * Parse presentation.xml's p14:sectionLst. Returns [] if there are no sections
 * (older documents). sldIds referencing deleted slides are silently skipped.
 */
export function getSections(opened: OpenedPptx): SectionInfo[] {
  return call('getSections', [opened], { opened: [0] }) as never
}
/**
 * Write the section structure back into presentation.xml's extLst (created if
 * missing). With empty sections the whole sectionLst extension is removed (and
 * the extLst too if it becomes empty). Only presentation.xml is touched;
 * [Content_Types]/rels are unaffected.
 */
export function setSections(opened: OpenedPptx, sections: SectionInfo[]): void {
  return call('setSections', [opened, sections], { mut: { 0: 'opened' }, undef: true }) as never
}
/**
 * Positional normalization: each section's start = its minimum index (empty
 * sections take the next section's start), section i covers
 * [starts[i], starts[i+1]), the last section runs to total. Returns the
 * unsectioned leading slides + the normalized sections.
 */
export function normalizeSections(
  sections: SectionInfo[],
  total: number,
): { lead: number[]; starts: number[]; sections: SectionInfo[] } {
  return call('normalizeSections', [sections, total]) as never
}
/**
 * Add a section before slide atSlideIndex (covering atSlideIndex through the end
 * of its containing section). For documents without sections: slides before
 * atSlideIndex go into an auto-created "default section".
 * Returns the updated section list; null for an invalid index.
 */
export function addSection(
  opened: OpenedPptx,
  atSlideIndex: number,
  name: string,
): SectionInfo[] | null {
  return call('addSection', [opened, atSlideIndex, name], { mut: { 0: 'opened' } }) as never
}
/** Rename a section; returns null if the id does not exist. */
export function renameSection(opened: OpenedPptx, id: string, name: string): SectionInfo[] | null {
  return call('renameSection', [opened, id, name], { mut: { 0: 'opened' } }) as never
}
/**
 * Delete a section but keep its slides: the section's slides merge into the
 * previous section (or the next one for the first section); when no sections
 * remain the whole sectionLst is removed. Returns null if the id does not exist.
 */
export function removeSection(
  opened: OpenedPptx,
  id: string,
  _opts?: { keepSlides?: boolean },
): SectionInfo[] | null {
  return call('removeSection', [opened, id, _opts], { mut: { 0: 'opened' } }) as never
}
/**
 * Move slide fromIndex to toIndex (the insertion index after removal, i.e.
 * drag-drop semantics). Keeps presentation.xml's sldIdLst order and deck.slides
 * in sync; with sections, the moved slide joins the section at the drop position
 * (a section emptied by the move stays as an empty section).
 */
export function moveSlide(opened: OpenedPptx, fromIndex: number, toIndex: number): boolean {
  return call('moveSlide', [opened, fromIndex, toIndex], { mut: { 0: 'opened' } }) as never
}
/**
 * Move a whole section up/down: swaps places with the adjacent section, keeping
 * presentation.xml's sldIdLst order and deck.slides order in sync (unsectioned
 * leading slides stay pinned at the front). Returns the updated section list.
 */
export function moveSection(
  opened: OpenedPptx,
  id: string,
  dir: 'up' | 'down',
): SectionInfo[] | null {
  return call('moveSection', [opened, id, dir], { mut: { 0: 'opened' } }) as never
}
