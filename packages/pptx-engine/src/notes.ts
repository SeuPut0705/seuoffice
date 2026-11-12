/**
 * Speaker notes (notesSlide) read/write — archive surgery, same approach as
 * duplicateSlide.
 *
 * - Read: slide rels → notesSlide part → body placeholder <a:t> text (\n-separated).
 * - Write: patch the existing notesSlide's body txBody; if there is no notesSlide,
 *   create one (creating a notesMaster too if needed and registering it in
 *   presentation.xml).
 * All changes land in archive.entries: savePptx persists automatically, and the
 * main process's snapshot-style undo (shallow copy of entries) covers them.
 */
import type { OpenedPptx } from './index'
import { type PackageArchive } from './zip'
import { decodeXml } from './xml-utils'
import { call } from './engine'

/**
 * Text or an attribute value read off raw XML, as XML reads it (`decodeXml`): one pass, so
 * `&amp;lt;` is the four characters `&lt;`. Never applied to a value the parser returned.
 */
export const unescapeXml = decodeXml
/** Path of the slide's notesSlide part (null if there is no notes slide). */
export function notesPathForSlide(archive: PackageArchive, slidePath: string): string | null {
  return call('notesPathForSlide', [archive, slidePath]) as never
}
/** Read notes as plain text (body placeholder paragraphs joined by \n); '' if none. */
export function getSlideNotes(archive: PackageArchive, slidePath: string): string {
  return call('getSlideNotes', [archive, slidePath]) as never
}
/**
 * Write notes (overwrite): patch the existing notesSlide's body txBody;
 * if there is no notesSlide, create the part (with a notesMaster if needed).
 * A notes slide part is written under the prefixes it binds its namespaces to; false, and
 * nothing written to it, when it binds them to none or has no shape tree to hold the body.
 */
export function setSlideNotes(opened: OpenedPptx, slideIndex: number, text: string): boolean {
  return call('setSlideNotes', [opened, slideIndex, text], { mut: { 0: 'opened' } }) as never
}