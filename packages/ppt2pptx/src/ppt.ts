import { LegacyPptError } from './errors'
import {
  PPT_TYPES,
  RECORD_HEADER,
  type PptRecord,
  decodeTextBytes,
  decodeTextChars,
  isRecordContainer,
  payloadOf,
  walkRecords,
} from './records'

/** Caps: fail fast, never walk an absurd deck. Input/stream caps live in the shared OLE2 opener. */
const MAX_SLIDES = 4096
/** Deepest record nesting walked: a real slide's text sits about six levels down. */
const MAX_RECORD_DEPTH = 64
/** One change-directory chain (edits or persist blocks) longer than this is damaged, not a deck. */
const MAX_EDIT_CHAIN = 1024
/** A single slide with more text sequences than this is not a real deck. */
const MAX_TEXT_SEQUENCES = 100_000
/**
 * Text of the whole deck, in characters: 1,024 on every one of MAX_SLIDES
 * slides, about two thousand printed pages. A real deck carries tens of
 * thousands of characters, a very large one a few hundred thousand. The
 * sibling importers cap what a document may expand to in bytes (64 MiB a part
 * in odf2ooxml and hwp2docx, 128 MiB a stream in the OLE2 opener); here the
 * stream cap alone would let 128 MiB of text through, and the reader and the
 * writer each hold the text several times over (measured: about a gibibyte
 * of resident memory at sixteen million characters).
 */
const MAX_TEXT_CHARS = MAX_SLIDES * 1024
/**
 * Paragraphs of the whole deck: 64 on every one of MAX_SLIDES slides. A
 * paragraph mark is one byte in the file and about a hundred bytes of markup
 * in the .pptx, so the character cap alone leaves a hundredfold blow-up.
 */
const MAX_PARAGRAPHS = MAX_SLIDES * 64

/**
 * The PowerPoint slide surface is measured in master units: 576 per inch, so
 * a 10 × 7.5 in deck is 5760 × 4320 (not the 576000 × 432000 a
 * hundredth-of-an-inch surface would use).
 */
const DEFAULT_SLIDE_WIDTH = 5760
const DEFAULT_SLIDE_HEIGHT = 4320
const MAX_SLIDE_MASTER_UNITS = 1_000_000

const CURRENT_USER_TOKEN = 0xe391c05f
/** CurrentUserAtom headerToken of a password-protected (encrypted) deck. */
export const ENCRYPTED_CURRENT_USER_TOKEN = 0xf3d1c4df

export interface PptSlideText {
  /** the TextHeaderEnum of the sequence (0 title, 1 body, 2 notes, 4 other…) */
  kind: number
  text: string
}

export interface PptSlide {
  textSequences: PptSlideText[]
}

export interface PptPresentation {
  slides: PptSlide[]
  /** slide surface in master units (576 per inch) */
  slideWidth: number
  slideHeight: number
  /** what the reader left out of a damaged deck (repeated slide references) */
  warnings: string[]
}

/**
 * The change directory: persistId → stream offset. PowerPoint's stream holds
 * one generation per save; the live UserEditAtom (named by the CurrentUser
 * stream) starts the walk, and each generation's PersistDirectoryAtom maps
 * the persist ids it wrote to their stream offsets. A sequential walk of the
 * stream would read stale generations.
 */
export interface PersistChain {
  directory: Map<number, number>
  /** the DocumentContainer's persist id, when the chain names one */
  docPersistId: number | null
}

/** The CurrentUserAtom's headerToken and the offset of the live UserEditAtom. */
export interface CurrentUserInfo {
  headerToken: number
  editOffset: number | null
}

/**
 * The CurrentUserAtom of the "Current User" stream. headerToken distinguishes
 * a plain deck (0xE391C05F) from a password-protected one (0xF3D1C4DF, checked
 * by the container opener); offsetToCurrentEdit follows the size and
 * headerToken fields.
 */
export function currentUserInfo(currentUser: Uint8Array): CurrentUserInfo | null {
  for (const record of walkRecords(currentUser)) {
    if (record.type !== PPT_TYPES.currentUserAtom) continue
    const payload = payloadOf(currentUser, record)
    if (payload.length < 12) return { headerToken: 0, editOffset: null }
    const view = viewOf(payload)
    return {
      headerToken: view.getUint32(4, true),
      editOffset: view.getUint32(8, true) || null,
    }
  }
  return null
}

/**
 * The live change directory. The UserEditAtom the CurrentUserAtom points at
 * names (a) its persist directory (a PersistDirectoryAtom: 4-byte
 * persistId:20|cPersist:12 entries, then cPersist 4-byte offsets) and (b) the
 * previous generation through offsetLastEdit. Newer entries win: a persist id
 * the current generation wrote keeps its current offset even when an older
 * directory also lists it.
 */
export function buildPersistChain(
  document: Uint8Array,
  currentUser: Uint8Array | null,
): PersistChain {
  const directory = new Map<number, number>()
  let docPersistId: number | null = null
  const info = currentUser ? currentUserInfo(currentUser) : null
  if (!info || info.headerToken !== CURRENT_USER_TOKEN || info.editOffset === null) {
    return { directory, docPersistId }
  }
  let editOffset: number | null = info.editOffset
  for (let edits = 0; editOffset !== null && edits < MAX_EDIT_CHAIN; edits++) {
    const edit = recordAt(document, editOffset)
    if (!edit || edit.type !== PPT_TYPES.userEditAtom || edit.length < 28) {
      // the live edit is the one piece of the chain that must be readable
      if (edits === 0) throw new LegacyPptError('bad_persist', `no UserEditAtom at ${editOffset}`)
      break
    }
    const view = viewOf(payloadOf(document, edit))
    if (edits === 0) {
      const docRef = view.getUint32(16, true)
      if (docRef > 0) docPersistId = docRef
    }
    readPersistDirectory(document, view.getUint32(12, true), directory)
    editOffset = view.getUint32(8, true) || null
  }
  return { directory, docPersistId }
}

/** One generation's PersistDirectoryAtom chain; entries already in the map stay. */
function readPersistDirectory(
  document: Uint8Array,
  offset: number,
  directory: Map<number, number>,
): void {
  let at = offset
  for (let blocks = 0; blocks < MAX_EDIT_CHAIN; blocks++) {
    const record = recordAt(document, at)
    if (!record || record.type !== PPT_TYPES.persistPtrIncrementalBlock) return
    const payload = payloadOf(document, record)
    const view = viewOf(payload)
    let cursor = 0
    while (cursor + 4 <= payload.length) {
      const header = view.getUint32(cursor, true)
      cursor += 4
      const persistId = header & 0xfffff
      const count = header >>> 20
      if (count === 0 || cursor + count * 4 > payload.length) {
        throw new LegacyPptError('bad_persist', 'a persist directory entry runs off its block')
      }
      for (let index = 0; index < count; index++) {
        const streamOffset = view.getUint32(cursor, true)
        cursor += 4
        const id = persistId + index
        // offset 0 is a legal stream position (the DocumentContainer can open
        // the stream); only a past-the-end offset is garbage
        if (streamOffset < document.length && !directory.has(id)) {
          directory.set(id, streamOffset)
        }
      }
    }
    // the continuation blocks of one generation sit back to back
    at = record.offset + record.length
  }
}

/**
 * The presentation: slide size from the DocumentAtom, the slide order from
 * the DocumentContainer's SlideListWithText (instance 0 = slides, each
 * SlidePersistAtom followed by that slide's outline text), and each slide's
 * text from its outline entries plus the text boxes nested in its drawing.
 */
export function parsePptPresentation(
  document: Uint8Array,
  currentUser: Uint8Array | null,
): PptPresentation {
  const { directory, docPersistId } = buildPersistChain(document, currentUser)
  const chained = directory.size > 0
  const at = (persistId: number): PptRecord | null => {
    const offset = directory.get(persistId)
    return offset === undefined ? null : recordAt(document, offset)
  }

  // the live DocumentContainer: docPersistIdRef of the current UserEditAtom
  let documentRecord: PptRecord | null = null
  if (docPersistId !== null) {
    documentRecord = at(docPersistId)
    if (!documentRecord || documentRecord.type !== PPT_TYPES.documentContainer) {
      throw new LegacyPptError(
        'bad_persist',
        `docPersistIdRef ${docPersistId} is not a DocumentContainer`,
      )
    }
  } else if (!chained) {
    // a flat file (no readable change directory) holds exactly one generation
    for (const record of walkRecords(document)) {
      if (record.type === PPT_TYPES.documentContainer) {
        documentRecord = record
        break
      }
    }
  }
  if (!documentRecord) throw new LegacyPptError('corrupt', 'no DocumentContainer')

  const children = [
    ...walkRecords(document, documentRecord.offset, documentRecord.offset + documentRecord.length),
  ]

  // DocumentAtom: the slide surface, in master units
  let slideWidth = DEFAULT_SLIDE_WIDTH
  let slideHeight = DEFAULT_SLIDE_HEIGHT
  for (const record of children) {
    if (record.type !== PPT_TYPES.documentAtom || record.length < 8) continue
    const view = viewOf(payloadOf(document, record))
    const cx = view.getUint32(0, true)
    const cy = view.getUint32(4, true)
    if (cx > 0 && cy > 0 && cx <= MAX_SLIDE_MASTER_UNITS && cy <= MAX_SLIDE_MASTER_UNITS) {
      slideWidth = cx
      slideHeight = cy
    }
  }

  const budget: TextBudget = { chars: MAX_TEXT_CHARS, paragraphs: MAX_PARAGRAPHS }
  // stream offsets of the slides already named, and how many references named one again
  const named = new Set<number>()
  let repeats = 0

  // SlideListWithText instance 0 is the slide list; instance 1 is the main
  // master's outline and 2 the notes', so only 0 is the deck order.
  const slideEntries: { persistIdRef: number; outline: PptSlideText[] }[] = []
  for (const record of children) {
    if (record.type !== PPT_TYPES.slideListWithText || record.instance !== 0) continue
    let entry: { persistIdRef: number; outline: PptSlideText[] } | null = null
    let pendingKind: number | null = null
    for (const inner of walkRecords(document, record.offset, record.offset + record.length)) {
      if (inner.type === PPT_TYPES.slidePersistAtom) {
        if (inner.length < 4) continue
        const persistIdRef = viewOf(payloadOf(document, inner)).getUint32(0, true)
        pendingKind = null
        // PowerPoint lists a slide once. A list that names one container
        // again (by the same persist id, or by another that resolves to the
        // same offset) would have the slide read once per entry.
        const offset = directory.get(persistIdRef)
        if (offset !== undefined && named.has(offset)) {
          repeats++
          entry = null
          continue
        }
        if (offset !== undefined) named.add(offset)
        entry = { persistIdRef, outline: [] }
        slideEntries.push(entry)
        continue
      }
      if (inner.type === PPT_TYPES.textHeaderAtom) {
        pendingKind = textKindOf(document, inner)
        continue
      }
      if (inner.type !== PPT_TYPES.textCharsAtom && inner.type !== PPT_TYPES.textBytesAtom) continue
      if (!entry || pendingKind === null) continue
      entry.outline.push({ kind: pendingKind, text: textOf(document, inner, budget) })
      pendingKind = null
    }
  }
  if (slideEntries.length > MAX_SLIDES) {
    throw new LegacyPptError('limits_exceeded', `more than ${MAX_SLIDES} slides`)
  }

  const slides: PptSlide[] = []
  if (chained && slideEntries.length > 0) {
    const records: PptRecord[] = []
    for (const entry of slideEntries) {
      const record = at(entry.persistIdRef)
      if (!record || record.type !== PPT_TYPES.slideContainer) {
        throw new LegacyPptError('bad_slide', `persist id ${entry.persistIdRef}`)
      }
      records.push(record)
    }
    assertDisjointSlides(records)
    for (const [index, record] of records.entries()) {
      slides.push(parseSlide(document, record, slideEntries[index]!.outline, budget))
    }
  } else {
    // no usable slide list (a flat file still knows its containers): the
    // containers in stream order are the deck order
    const containers: PptRecord[] = []
    if (chained) {
      for (const offset of directory.values()) {
        const record = recordAt(document, offset)
        if (record?.type !== PPT_TYPES.slideContainer) continue
        if (named.has(offset)) {
          repeats++
          continue
        }
        named.add(offset)
        containers.push(record)
      }
      assertDisjointSlides(containers)
    } else {
      for (const record of walkRecords(document)) {
        if (record.type === PPT_TYPES.slideContainer) containers.push(record)
      }
    }
    containers.sort((a, b) => a.offset - b.offset)
    if (containers.length > MAX_SLIDES) {
      throw new LegacyPptError('limits_exceeded', `more than ${MAX_SLIDES} slides`)
    }
    for (const [index, record] of containers.entries()) {
      // a flat file still groups each slide's outline after its SlidePersistAtom
      const outline =
        !chained && slideEntries.length === containers.length ? slideEntries[index]!.outline : []
      slides.push(parseSlide(document, record, outline, budget))
    }
  }
  const warnings: string[] = []
  if (repeats > 0) {
    warnings.push(`${repeats} repeated slide references were skipped; each slide was kept once`)
  }
  return { slides, slideWidth, slideHeight, warnings }
}

/**
 * Slide containers are top-level records of the stream, so no two share a
 * byte. A change directory that points into the middle of one (containers
 * nested, or framed over each other) would have every such slide read the
 * same bytes again: work and text many times the size of the file.
 */
function assertDisjointSlides(records: readonly PptRecord[]): void {
  const ordered = [...records].sort((a, b) => a.offset - b.offset)
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!
    if (ordered[index]!.offset - RECORD_HEADER < previous.offset + previous.length) {
      throw new LegacyPptError('bad_slide', 'slide containers overlap')
    }
  }
}

/** One slide's text: its outline entries first (title/body), then its own text boxes. */
function parseSlide(
  document: Uint8Array,
  slideRecord: PptRecord,
  outline: readonly PptSlideText[],
  budget: TextBudget,
): PptSlide {
  const textSequences: PptSlideText[] = []
  const push = (sequence: PptSlideText): void => {
    if (sequence.text.trim().length === 0) return
    if (textSequences.length >= MAX_TEXT_SEQUENCES) {
      throw new LegacyPptError(
        'limits_exceeded',
        `more than ${MAX_TEXT_SEQUENCES} text sequences on one slide`,
      )
    }
    textSequences.push(sequence)
  }
  for (const sequence of outline) push(sequence)
  for (const sequence of textBoxesOf(document, slideRecord, budget)) push(sequence)
  return { textSequences }
}

/**
 * The text boxes of a slide. A real slide nests them under PPDrawing →
 * OfficeArtDgContainer → OfficeArtSpgrContainer → OfficeArtSpContainer →
 * OfficeArtClientTextbox, so the walk follows every record container.
 */
function textBoxesOf(
  document: Uint8Array,
  slideRecord: PptRecord,
  budget: TextBudget,
): PptSlideText[] {
  const out: PptSlideText[] = []
  collectTextBoxes(
    document,
    slideRecord.offset,
    slideRecord.offset + slideRecord.length,
    0,
    out,
    budget,
  )
  return out
}

function collectTextBoxes(
  document: Uint8Array,
  from: number,
  to: number,
  depth: number,
  out: PptSlideText[],
  budget: TextBudget,
): void {
  if (depth > MAX_RECORD_DEPTH) return
  for (const record of walkRecords(document, from, to)) {
    if (record.type === PPT_TYPES.escherClientTextbox) {
      const text = textOfTextbox(document, record, budget)
      if (text) out.push(text)
      continue
    }
    if (isRecordContainer(record)) {
      collectTextBoxes(
        document,
        record.offset,
        record.offset + record.length,
        depth + 1,
        out,
        budget,
      )
    }
  }
}

/**
 * One ClientTextbox's text. A text box whose text lives in the slide's
 * SlideListWithText carries an OutlineTextRefAtom and no text atom, so it
 * contributes nothing here — its text already came from the outline entries.
 */
function textOfTextbox(
  document: Uint8Array,
  record: PptRecord,
  budget: TextBudget,
): PptSlideText | null {
  let kind = 4 // TextHeaderEnum "other text"; a box without a header still reads as text
  let text: string | null = null
  for (const inner of walkRecords(document, record.offset, record.offset + record.length)) {
    if (inner.type === PPT_TYPES.textHeaderAtom) {
      kind = textKindOf(document, inner) ?? kind
      continue
    }
    if (inner.type !== PPT_TYPES.textCharsAtom && inner.type !== PPT_TYPES.textBytesAtom) continue
    text = textOf(document, inner, budget)
  }
  return text === null ? null : { kind, text }
}

function textKindOf(document: Uint8Array, record: PptRecord): number | null {
  const payload = payloadOf(document, record)
  if (payload.length < 4) return null
  return viewOf(payload).getInt32(0, true)
}

/** What is left of the deck-wide text allowance; every text atom read draws on it. */
interface TextBudget {
  chars: number
  paragraphs: number
}

function textOf(document: Uint8Array, record: PptRecord, budget: TextBudget): string {
  const payload = payloadOf(document, record)
  const wide = record.type === PPT_TYPES.textCharsAtom
  // charged from the payload size, before decoding: an atom over the
  // allowance never becomes a string
  budget.chars -= wide ? payload.length >> 1 : payload.length
  if (budget.chars < 0) {
    throw new LegacyPptError('limits_exceeded', `more than ${MAX_TEXT_CHARS} characters of text`)
  }
  const text = wide ? decodeTextChars(payload) : decodeTextBytes(payload)
  let paragraphs = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) paragraphs++
  budget.paragraphs -= paragraphs
  if (budget.paragraphs < 0) {
    throw new LegacyPptError('limits_exceeded', `more than ${MAX_PARAGRAPHS} paragraphs of text`)
  }
  return text
}

function viewOf(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
}

/** The record header at a stream offset (or null when it would run off). */
function recordAt(stream: Uint8Array, offset: number): PptRecord | null {
  if (offset < 0 || offset + 8 > stream.length) return null
  const head = stream[offset]! | (stream[offset + 1]! << 8)
  const type = stream[offset + 2]! | (stream[offset + 3]! << 8)
  const length = viewOf(stream.subarray(offset + 4, offset + 8)).getUint32(0, true)
  if (offset + 8 + length > stream.length) return null
  return { version: head & 0x000f, instance: head >> 4, type, length, offset: offset + 8 }
}
