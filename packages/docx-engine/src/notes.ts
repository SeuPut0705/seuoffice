import type { NoteInfo, NoteRun } from './types'
import { invoke } from './engine'

/**
 * Footnotes / endnotes part handling (word/footnotes.xml, word/endnotes.xml).
 *
 * Both parts share one schema: a list of w:footnote / w:endnote elements.
 * Entries carrying a w:type attribute (separator, continuationSeparator, ...)
 * are structural and must be preserved; only typeless entries are real notes.
 */

export type NoteKind = 'footnote' | 'endnote'
export const NOTE_PART_PATH: Record<NoteKind, string> = {
  footnote: 'word/footnotes.xml',
  endnote: 'word/endnotes.xml',
}
export const NOTE_REL_TYPE: Record<NoteKind, string> = {
  footnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
}
export const NOTE_CONTENT_TYPE: Record<NoteKind, string> = {
  footnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
}
/**
 * Root attributes for a regenerated part. Entries are spliced back in as original bytes, so
 * the root has to keep declaring whatever prefixes those bytes use: Word puts w14:paraId on
 * every paragraph it writes, and a literal namespace list leaves that prefix unbound.
 *
 * `required` lists namespaces the rebuild itself emits (e.g. w14 on rebuilt comments): they
 * are appended when the reused original root does not declare them, since an original from
 * a non-Word producer may bind fewer prefixes than our generated markup uses.
 */
export function rootAttributes(
  originalXml: string | null,
  rootTag: string,
  fallback: string,
  required: Record<string, string> = {},
): string {
  return invoke('rootAttributes', [
    originalXml,
    rootTag,
    fallback,
    Object.entries(required),
  ]) as never
}
/** one note paragraph read through the document's run extraction and property resolver */
export interface NoteParagraph {
  /** display runs, the self-reference mark run excluded */
  runs: NoteRun[]
  /** w:pStyle of the paragraph */
  styleId?: string
  /** before / after / line resolved through the style chain and docDefaults */
  spacing: NonNullable<NoteInfo['spacing']>
}
/** supplied by the document parser; without it notes carry plain text only */
export type NoteParagraphReader = (pXml: string) => NoteParagraph
/** real notes (separator entries excluded), in file order */
export function parseNotesXml(xml: string, kind: NoteKind, read?: NoteParagraphReader): NoteInfo[] {
  return invoke(
    'parseNotesXml',
    [
      xml,
      kind,
      read === undefined
        ? null
        : Symbol.for('seuoffice.standaloneNoteReader') in read
          ? 'standalone'
          : read,
    ],
    { names: ['xml', 'kind', 'read'] },
  ) as never
}
/**
 * Regenerate the notes part from the full desired list. Structural entries
 * (separator/continuation) from the original part are kept byte-identical;
 * when there is no original part, standard separators are created.
 * Surgical: existing entries whose text is unchanged keep their original bytes (inline
 * formatting, images, and hyperlinks are preserved); entries with changed text first try
 * an in-paragraph w:t-level patch (formatting still preserved), and only fall back to a
 * plain-text rebuild when patching fails (paragraph count changed, etc.).
 */
export function buildNotesXml(
  kind: NoteKind,
  notes: NoteInfo[],
  originalXml: string | null,
): string {
  return invoke('buildNotesXml', [kind, notes, originalXml]) as never
}
/** next free numeric note id (separator ids -1/0 and existing notes considered) */
export function nextNoteId(notes: NoteInfo[]): string {
  return invoke('nextNoteId', [notes]) as never
}
