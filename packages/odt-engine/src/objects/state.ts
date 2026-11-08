/**
 * Per-conversion state of the objects layer. The JSON part lives in the
 * bridge map (`ext('objects')`); everything else (media registry, the lazily
 * assembled notes/comments parts, save bookkeeping) is kept here, keyed by
 * the conversion context.
 */
import type { NoteInfo } from '@genoffice/docx-engine'
import type {
  DocxExtraPart,
  JsonValue,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
} from '../core/convert'
import type { OdtStylePart } from '../core/styles'
import { type ImageFormat, NEUTRAL_PLACEHOLDER_PNG, sameBytes } from './media'
import {
  type NoteKind,
  OBJECTS_EXT_KEY,
  type ObjectComment,
  type ObjectNote,
  type ObjectPicture,
  type ObjectPlaceholder,
  type ObjectsExt,
  emptyObjectsExt,
} from './model'

// ---------------------------------------------------------------------------
// Forward

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

export interface ForwardState {
  ext: ObjectsExt
  /** object id counter (placeholders and pictures share it) */
  seq: number
  docPrSeq: number
  /** bridge media per package entry (or `#neutral`) */
  media: Map<string, string>
  mediaSeq: number
  /** > 0 while note bodies are converted (objects inside them are kept, not converted) */
  nested: number
  noteSeq: Record<NoteKind, number>
  noteEntries: Record<NoteKind, string[]>
  comments: string[]
  commentSeq: number
  /** `office:annotation-end` start → its comment record */
  commentByEnd: Map<number, ObjectComment>
  /** `office:annotation` start → its end element, from the body-wide pairing */
  annotationEnds: Map<number, { start: number; end: number }> | null
  /** sorted offsets of `change-start` in content.xml */
  changeStarts: number[] | null
  warnedTracked: boolean
}

const forwardStates = new WeakMap<OdfToOoxmlContext, ForwardState>()

export function forwardState(ctx: OdfToOoxmlContext): ForwardState {
  let s = forwardStates.get(ctx)
  if (!s) {
    s = {
      ext: ctx.ext(
        OBJECTS_EXT_KEY,
        () => emptyObjectsExt() as unknown as JsonValue,
      ) as unknown as ObjectsExt,
      seq: 0,
      docPrSeq: 0,
      media: new Map(),
      mediaSeq: 0,
      nested: 0,
      noteSeq: { footnote: 0, endnote: 0 },
      noteEntries: { footnote: [], endnote: [] },
      comments: [],
      commentSeq: 0,
      commentByEnd: new Map(),
      annotationEnds: null,
      changeStarts: null,
      warnedTracked: false,
    }
    forwardStates.set(ctx, s)
  }
  return s
}

/** Relationship id of a picture in the bridge docx (one media part per package entry). */
export function bridgeMedia(
  ctx: OdfToOoxmlContext,
  key: string,
  bytes: Uint8Array,
  format: ImageFormat,
): string {
  const st = forwardState(ctx)
  const found = st.media.get(key)
  if (found) return found
  const name = `odt${++st.mediaSeq}.${format.ext}`
  ctx.docx.parts.push({ path: `word/media/${name}`, data: bytes })
  const rId = ctx.addRelationship(IMAGE_REL, `media/${name}`)
  st.media.set(key, rId)
  return rId
}

/** Relationship id of the neutral placeholder picture. */
export const neutralMedia = (ctx: OdfToOoxmlContext): string =>
  bridgeMedia(ctx, '#neutral', NEUTRAL_PLACEHOLDER_PNG, { ext: 'png', mime: 'image/png' })

/**
 * Adds a part whose XML is assembled when the bridge docx is built (notes and
 * comments are collected while the body converts).
 */
export function lazyPart(
  ctx: OdfToOoxmlContext,
  path: string,
  contentType: string,
  relType: string,
  build: () => string,
): void {
  if (ctx.docx.parts.some((p) => p.path === path)) return
  const part = { path, contentType } as DocxExtraPart
  Object.defineProperty(part, 'data', { get: build, enumerable: true })
  ctx.docx.parts.push(part)
  ctx.addRelationship(relType, path.replace(/^word\//, ''))
}

// ---------------------------------------------------------------------------
// Save

export interface AddedEntry {
  path: string
  data: Uint8Array
  mediaType: string
}

export interface SaveState {
  ext: ObjectsExt
  placeholders: Map<string, ObjectPlaceholder>
  pictures: Map<string, ObjectPicture>
  notes: Map<string, ObjectNote>
  comments: Map<string, ObjectComment>
  /** new package entries written by this save */
  added: AddedEntry[]
  /** lower-cased names taken in the package (existing and added) */
  taken: Set<string>
  emittedNotes: Set<string>
  emittedPictures: Set<string>
  emittedBlocks: Set<number>
  claimedHosts: Set<number>
  commentStarted: Set<string>
  commentDone: Set<string>
  /** comment ids present anywhere in the edited body (lazy) */
  surviving: Set<string> | null
  /** paragraph records the pre-step forced to be rewritten (a note body changed) */
  dirtyParagraphs: Set<number>
  /** bridge element XML replaced by the pre-step, restored afterwards */
  dirtyElements: Array<{ id: number; xml: string }>
  prepared: boolean
  /** next free `draw:z-index` for new frames */
  zIndex: number | null
  /** `wp:docPr` names already written back */
  emittedNames: Set<string>
  /** docPr names in the edited body XML and in its picture runs (lazy) */
  editedNames: { xml: Set<string>; runs: Set<string> } | null
}

const saveStates = new WeakMap<OoxmlToOdfContext, SaveState>()

export function objectsExtOf(rctx: OoxmlToOdfContext): ObjectsExt {
  return (
    (rctx.ext<JsonValue>(OBJECTS_EXT_KEY) as unknown as ObjectsExt | undefined) ?? emptyObjectsExt()
  )
}

export const noteKey = (kind: NoteKind, id: string): string => `${kind}:${id}`

export function saveState(rctx: OoxmlToOdfContext): SaveState {
  let s = saveStates.get(rctx)
  if (!s) {
    const ext = objectsExtOf(rctx)
    s = {
      ext,
      placeholders: new Map(ext.placeholders.map((p) => [p.id, p])),
      pictures: new Map(ext.pictures.map((p) => [p.id, p])),
      notes: new Map(ext.notes.map((n) => [noteKey(n.kind, n.id), n])),
      comments: new Map(ext.comments.map((c) => [c.id, c])),
      added: [],
      taken: new Set(rctx.doc.pkg.entries.map((e) => e.name.toLowerCase())),
      emittedNotes: new Set(),
      emittedPictures: new Set(),
      emittedBlocks: new Set(),
      claimedHosts: new Set(),
      commentStarted: new Set(),
      commentDone: new Set(),
      surviving: null,
      dirtyParagraphs: new Set(),
      dirtyElements: [],
      prepared: false,
      zIndex: null,
      emittedNames: new Set(),
      editedNames: null,
    }
    saveStates.set(rctx, s)
  }
  return s
}

/** The source text of a range of an original part. */
export const sourceOf = (
  rctx: OoxmlToOdfContext,
  part: OdtStylePart,
  start: number,
  end: number,
): string => rctx.part(part).xml.slice(start, end)

/** A new picture entry (shared by identical bytes), named so it collides with nothing. */
export function addPictureEntry(
  rctx: OoxmlToOdfContext,
  bytes: Uint8Array,
  format: ImageFormat,
): string {
  const st = saveState(rctx)
  const same = st.added.find((a) => sameBytes(a.data, bytes))
  if (same) return same.path
  const ext = format.ext === 'jpeg' ? 'jpg' : format.ext
  let n = 1
  while (st.taken.has(`pictures/io_${n}.${ext}`.toLowerCase())) n++
  const path = `Pictures/io_${n}.${ext}`
  st.taken.add(path.toLowerCase())
  st.added.push({ path, data: bytes, mediaType: format.mime })
  return path
}

/** The edited docx's note list entry for a reference, or undefined. */
export function editedNote(
  rctx: OoxmlToOdfContext,
  kind: NoteKind,
  id: string,
): NoteInfo | undefined {
  const list = kind === 'footnote' ? rctx.edited.footnotes : rctx.edited.endnotes
  return (list ?? []).find((n) => n.id === id)
}
