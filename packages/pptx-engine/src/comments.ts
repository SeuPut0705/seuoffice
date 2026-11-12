/**
 * Slide comments (classic comments part) read/write — archive surgery.
 *
 * Structure: ppt/commentAuthors.xml (author table, referenced by
 * presentation.xml.rels) + one ppt/comments/commentN.xml per slide (referenced by
 * slide rels). A comment is uniquely identified by (authorId, idx). All changes
 * land in archive.entries: savePptx persists automatically, and the main process's
 * snapshot-style undo covers them automatically.
 */
import type { OpenedPptx } from './index'
import { type PackageArchive } from './zip'
import { call } from './engine'

export interface SlideComment {
  authorId: number
  author: string
  initials: string
  /** ISO timestamp (the dt attribute in the part) */
  dt: string
  idx: number
  text: string
}
/** Read all comments on a slide (in order of appearance). */
export function getSlideComments(archive: PackageArchive, slidePath: string): SlideComment[] {
  return call('getSlideComments', [archive, slidePath]) as never
}
/** Add a comment; returns the new comment (with assigned authorId/idx). */
export function addSlideComment(
  opened: OpenedPptx,
  slideIndex: number,
  opts: { author: string; initials?: string; text: string },
): SlideComment | null {
  return call('addSlideComment', [opened, slideIndex, opts, new Date().toISOString()], { mut: { 0: 'opened' } }) as never
}
/** Delete a comment (by authorId + idx). */
export function deleteSlideComment(
  opened: OpenedPptx,
  slideIndex: number,
  ref: { authorId: number; idx: number },
): boolean {
  return call('deleteSlideComment', [opened, slideIndex, ref], { mut: { 0: 'opened' } }) as never
}