/**
 * The objects layer's slot in the bridge map (`ext('objects')`) and the names
 * it gives pictures in the bridge docx.
 *
 * Every picture the bridge writes carries its identity in the `wp:docPr`
 * name, which the editor keeps through resizes and picture replacement:
 * - `odt-pic:<id>` — an editable ODF picture (`draw:frame > draw:image`);
 * - `odt-keep:<id>:<kind>` — a locked placeholder for an object the editor
 *   cannot change (formula, shape, text box, table of contents, chart,
 *   tracked change …). `<kind>` is one of `OBJECT_KINDS`; the editor draws a
 *   localized label for it when the placeholder shows the neutral picture.
 *
 * Everything here is JSON (the map crosses IPC).
 */
import type { OdtStylePart } from '../core/styles'

/** Converter id of every objects-layer handler. */
export const OBJECTS_OWNER = 'objects'

/** `wp:docPr` name prefix of a locked placeholder: `odt-keep:<id>:<kind>`. */
export const ODT_KEEP_PREFIX = 'odt-keep:'
/** `wp:docPr` name prefix of an editable ODF picture: `odt-pic:<id>`. */
export const ODT_PICTURE_PREFIX = 'odt-pic:'

/** The fixed feature ids of placeholders. */
export const OBJECT_KINDS = [
  'equation',
  'shape',
  'textbox',
  'toc',
  'chart',
  'revision',
  'object',
] as const
export type ObjectKind = (typeof OBJECT_KINDS)[number]

export const keepName = (id: string, kind: ObjectKind): string => `${ODT_KEEP_PREFIX}${id}:${kind}`
export const pictureName = (id: string): string => `${ODT_PICTURE_PREFIX}${id}`

/** `{ id, kind }` of a placeholder `wp:docPr` name, or null. */
export function parseKeepName(name: string): { id: string; kind: ObjectKind } | null {
  if (!name.startsWith(ODT_KEEP_PREFIX)) return null
  const rest = name.slice(ODT_KEEP_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const kind = rest.slice(colon + 1) as ObjectKind
  if (!(OBJECT_KINDS as readonly string[]).includes(kind)) return null
  return { id: rest.slice(0, colon), kind }
}

/** The id of a picture `wp:docPr` name, or null. */
export function parsePictureName(name: string): string | null {
  return name.startsWith(ODT_PICTURE_PREFIX) && name.length > ODT_PICTURE_PREFIX.length
    ? name.slice(ODT_PICTURE_PREFIX.length)
    : null
}

/** A locked placeholder: one uneditable object shown as one picture. */
export interface ObjectPlaceholder {
  /** the `<id>` of `odt-keep:<id>:<kind>` */
  id: string
  kind: ObjectKind
  /** the exact `wp:docPr` name */
  name: string
  part: OdtStylePart
  /** source range of the object: the inline element, or the whole block */
  start: number
  end: number
  /** paragraph record that holds an inline object; null for a block placeholder */
  paragraph: number | null
  /** bridge block of a block placeholder (table of contents, tracked-change paragraph …); else null */
  block: number | null
  /** bridge element of a block placeholder; else null */
  element: number | null
  /** size of the object (and of the placeholder picture) */
  widthEmu: number
  heightEmu: number
  /** the picture is a preview stored in the file; false = the neutral picture */
  preview: boolean
  /** package entries the object references (`Object 1/`, `ObjectReplacements/Object 1` …) */
  entries: string[]
  /** tracked-change placeholder: the text as shown with every change applied; else null */
  finalText: string | null
}

/** An editable picture (`draw:frame` whose content is one `draw:image`). */
export interface ObjectPicture {
  /** the `<id>` of `odt-pic:<id>` */
  id: string
  name: string
  part: OdtStylePart
  /** source range of the `draw:frame` */
  start: number
  end: number
  /** one past the frame's start tag */
  openEnd: number
  /** source range of the `draw:image` start tag (its `xlink:href` changes when the picture is replaced) */
  imageStart: number
  imageOpenEnd: number
  /** `xlink:href` as written (decoded) */
  href: string
  /** the package entry it names */
  entry: string
  /** relationship id of the picture's media in the bridge docx */
  rId: string
  widthEmu: number
  heightEmu: number
  /** floating (`wp:anchor`) rather than inline */
  anchored: boolean
  /** `wp:posOffset` values written for a floating picture (null when aligned) */
  xEmu: number | null
  yEmu: number | null
  /** paragraph record that holds the picture */
  paragraph: number | null
  /** package entries it references */
  entries: string[]
}

/** An existing comment (`office:annotation`), shown as a docx comment. */
export interface ObjectComment {
  /** docx `w:id` */
  id: string
  /** `office:name`, or null */
  name: string | null
  /** source range of the `office:annotation` element (kept byte for byte on save) */
  start: number
  end: number
  /** source range of the matching `office:annotation-end`, or null */
  endStart: number | null
  endEnd: number | null
  /** paragraph record holding the annotation, and its character offset there */
  paragraph: number
  offset: number
  /** paragraph record holding the end, and its offset; null for a point comment */
  endParagraph: number | null
  endOffset: number | null
  /** the comment covers text (deleting all of it deletes the comment) */
  ranged: boolean
  /** the comment's text (paragraphs joined with a line feed), as shown in the editor */
  text: string
}

export type NoteKind = 'footnote' | 'endnote'

/** A footnote or endnote (`text:note`). */
export interface ObjectNote {
  /** docx `w:id` (unique per kind) */
  id: string
  kind: NoteKind
  /** source range of the `text:note` */
  start: number
  end: number
  /** inner range of `text:note-body` (between its tags) */
  bodyStart: number
  bodyEnd: number
  /** `text:note-citation` text as written */
  citation: string
  /** the body comes before the citation (Hancom's order) */
  bodyFirst: boolean
  /** paragraph record holding the citation */
  paragraph: number
  /** paragraph records of the note body, in order */
  paragraphs: number[]
  /** the note text as the docx engine reads it (`NoteInfo.text`) */
  text: string
  /** the body holds only paragraphs; otherwise edits of its text are not saved */
  editable: boolean
}

export interface ObjectsExt {
  version: 1
  /** locked placeholders, in conversion order (the list the editor and CLI read) */
  placeholders: ObjectPlaceholder[]
  pictures: ObjectPicture[]
  comments: ObjectComment[]
  notes: ObjectNote[]
}

export const OBJECTS_EXT_KEY = 'objects'

export function emptyObjectsExt(): ObjectsExt {
  return { version: 1, placeholders: [], pictures: [], comments: [], notes: [] }
}
