/**
 * What a co-editing page takes from the wire.
 *
 * A change of a peer is JSON from a page that may run other code than this one. `decodeOp`
 * takes only what the app itself sends: the buckets the web can save (not text, image or
 * saved-annotation edits, which co-editing refuses the person too), items of the kinds and
 * with the fields the app writes, numbers that are finite and within reach of a page, a link
 * only to where the app opens links, and sizes and counts a person's own change stays under,
 * so that no single change can keep a page busy. Anything else throws, and the engine stops
 * this page's session instead of showing the change.
 *
 * The shapes are spelled out per type (`shape<T>` names every field of `T`): a field added to
 * one of the app's types does not compile here until it is given a check.
 *
 * A person's own change passes the same check before it is sent (collab-adapter.ts), so a
 * page never sends what its peers would stop on.
 */
import { safeExternalUrl } from '@seuoffice/electron-utils/safe-external-url'
import type { Json } from '@seuoffice/collab/client'
import type { LocalMarkup } from '../renderer/annotations'
import type { LocalDrawing } from '../renderer/DrawLayer'
import type {
  LocalBlankPage,
  LocalFormField,
  LocalNoteEdit,
  StampConfig,
} from '../renderer/edit-state'
import type { SavedNoteAnnot } from '../renderer/note-threads'
import type { HeaderFooterConfig, WatermarkConfig } from '../renderer/stamps'
import type {
  BlankPageInput,
  DrawingInput,
  FormFieldInput,
  FormValueInput,
  FormWidgetEditInput,
  MetadataInput,
  NoteReplyTarget,
} from '../shared/ipc'
import {
  pictureRefKey,
  type BlockedBucket,
  type ListBucket,
  type PdfOp,
  type Put,
} from './collab-model'

/** Why a change is not taken: not a shape the app writes, too long or too many, or a link target */
export type WireFault = 'shape' | 'size' | 'link'

export class WireError extends Error {
  constructor(
    readonly fault: WireFault,
    message: string,
  ) {
    super(message)
  }
}

/** The most one change holds; a person's own change over these is refused where it is made */
export const WIRE_LIMITS = {
  /** edits in one change (bringing a full page back by undo is one change) */
  puts: 5_000,
  id: 128,
  /** a field name, an author, a subject */
  name: 1_024,
  /** a comment, a field's value, a line of document info */
  text: 100_000,
  url: 2_048,
  /** a measurement's label, as the app caps it */
  label: 64,
  /** coordinates of one ink drawing, over all its strokes */
  inkNumbers: 200_000,
  vertices: 5_000,
  /** rectangles of one text markup */
  quads: 20_000,
  options: 2_000,
  pages: 100_000,
  /** PDF user space, with room for what a move adds */
  coord: 10_000_000,
  /** a page side, in points (the PDF limit) */
  side: 14_400,
} as const

/** The list buckets a change may put into; the others hold what the web cannot save */
type Carried = Exclude<ListBucket, BlockedBucket>

/** Where the app opens a link (the desktop's `open-external` allows the same three) */
const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:']

type Check = (value: unknown, at: string) => void

function fail(fault: WireFault, at: string, need: string): never {
  throw new WireError(fault, `${at} is not ${need}`)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const text =
  (max: number, min = 0): Check =>
  (v, at) => {
    if (typeof v !== 'string' || v.length < min) fail('shape', at, 'a string')
    if (v.length > max) fail('size', at, `at most ${max} characters`)
  }

const number =
  (min: number, max: number): Check =>
  (v, at) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      fail('shape', at, `a number from ${min} to ${max}`)
    }
  }

const integer =
  (min: number, max: number): Check =>
  (v, at) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
      fail('shape', at, `a whole number from ${min} to ${max}`)
    }
  }

const flag: Check = (v, at) => {
  if (typeof v !== 'boolean') fail('shape', at, 'true or false')
}

const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, at) => {
    if (!values.includes(v)) fail('shape', at, `one of ${values.join(', ')}`)
  }

const nullable =
  (check: Check): Check =>
  (v, at) => {
    if (v !== null) check(v, at)
  }

const list =
  (max: number, item: Check, min = 0): Check =>
  (v, at) => {
    if (!Array.isArray(v) || v.length < min) fail('shape', at, 'a list')
    if (v.length > max) fail('size', at, `at most ${max} entries`)
    v.forEach((entry, i) => item(entry, `${at}[${i}]`))
  }

const tuple =
  (length: number, item: Check): Check =>
  (v, at) => {
    if (!Array.isArray(v) || v.length !== length) fail('shape', at, `${length} values`)
    v.forEach((entry, i) => item(entry, `${at}[${i}]`))
  }

/**
 * An object with exactly the fields of `T`: each named here with its check, the ones in
 * `optional` free to be absent. A field holding `undefined` is absent, as JSON leaves it out.
 */
function shape<T>(fields: { [K in keyof T]-?: Check }, optional: readonly (keyof T)[] = []): Check {
  const checks = Object.entries(fields) as [string, Check][]
  const known = new Set(Object.keys(fields))
  const free = new Set<PropertyKey>(optional)
  return (v, at) => {
    if (!isObject(v)) fail('shape', at, 'an object')
    for (const key of Object.keys(v)) {
      if (v[key] !== undefined && !known.has(key))
        fail('shape', `${at}.${key}`, 'a field the app writes')
    }
    for (const [key, check] of checks) {
      const value = v[key]
      if (value !== undefined) check(value, `${at}.${key}`)
      else if (!free.has(key)) fail('shape', `${at}.${key}`, 'there')
    }
  }
}

const anyKind: Check = () => {}
const id = text(WIRE_LIMITS.id, 1)
const name = text(WIRE_LIMITS.name)
const words = text(WIRE_LIMITS.text)
const page = integer(0, WIRE_LIMITS.pages - 1)
const coord = number(-WIRE_LIMITS.coord, WIRE_LIMITS.coord)
const rect = tuple(4, coord)
const point = tuple(2, coord)
const rgb = tuple(3, number(0, 1))
const objNum = integer(0, 2 ** 31)
const hexColor: Check = (v, at) => {
  if (typeof v !== 'string' || !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
    fail('shape', at, 'a hex colour')
  }
}

/**
 * An AFDate format as a file carries it (date-format.ts reads any; the designer offers four):
 * its tokens are ASCII letters, between them separators, and a local file spells the parts
 * out in its own script (`yyyy년 mm월 dd일`). The save writes it into a viewer script.
 */
const dateFormat: Check = (v, at) => {
  if (typeof v !== 'string' || !/^[\p{L}0-9 .,:/-]{1,64}$/u.test(v)) {
    fail('shape', at, 'a date format of letters, digits, spaces and . , : / -')
  }
}

const strokes: Check = (v, at) => {
  if (!Array.isArray(v)) fail('shape', at, 'a list of strokes')
  let numbers = 0
  v.forEach((stroke: unknown, i) => {
    if (!Array.isArray(stroke) || stroke.length % 2 !== 0)
      fail('shape', `${at}[${i}]`, 'x, y pairs')
    numbers += stroke.length
    if (numbers > WIRE_LIMITS.inkNumbers) {
      fail('size', at, `at most ${WIRE_LIMITS.inkNumbers} coordinates`)
    }
    stroke.forEach((n: unknown, j) => coord(n, `${at}[${i}][${j}]`))
  })
}

const PNG_HEAD = 'iVBORw0KGgo'
const PICTURE_KEY = /^[0-9a-z]{1,12}\.[0-9a-f]{16}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** A stamp's picture: base64 PNG, as the save embeds it, or the name of bytes the log carries */
const picture: Check = (v, at) => {
  if (typeof v !== 'string') fail('shape', at, 'a picture')
  const named = pictureRefKey(v)
  if (named !== null) {
    if (!PICTURE_KEY.test(named)) fail('shape', at, 'the name of a picture')
    return
  }
  if (!v.startsWith(PNG_HEAD) || !BASE64.test(v)) fail('shape', at, 'a base64 PNG')
}

/** An address the app would open (the suite's gate): nothing a viewer could run or read off a disk */
const linkUrl: Check = (v, at) => {
  if (typeof v !== 'string') fail('shape', at, 'an address')
  if (v.length > WIRE_LIMITS.url) fail('size', at, `at most ${WIRE_LIMITS.url} characters`)
  // as the link dialog leaves it: trimmed
  if (safeExternalUrl(v, { allowedProtocols: LINK_PROTOCOLS }) !== v) {
    fail('link', at, 'an http, https or mailto address')
  }
}

type Drawing<K extends DrawingInput['kind']> = Extract<DrawingInput, { kind: K }>

const stroked = { pageIndex: page, color: rgb, width: number(0, 1_000), formFieldName: name }

const linkShape = shape<Drawing<'link'>>(
  {
    kind: anyKind,
    pageIndex: page,
    rect,
    url: linkUrl,
    destPage: integer(1, WIRE_LIMITS.pages),
  },
  ['url', 'destPage'],
)

/**
 * A line or an arrow. The draw layer builds all three line tools one way, so these two come
 * with the label a measurement gets filled in, empty here.
 */
const lineShape = shape<Drawing<'line' | 'arrow'> & { label?: string }>(
  { kind: anyKind, ...stroked, from: point, to: point, label: text(WIRE_LIMITS.label) },
  ['formFieldName', 'label'],
)

const DRAWING: { [K in DrawingInput['kind']]: Check } = {
  ink: shape<Drawing<'ink'>>({ kind: anyKind, ...stroked, paths: strokes }, ['formFieldName']),
  rect: shape<Drawing<'rect'>>({ kind: anyKind, ...stroked, rect }, ['formFieldName']),
  ellipse: shape<Drawing<'ellipse'>>({ kind: anyKind, ...stroked, rect }, ['formFieldName']),
  link(v, at) {
    linkShape(v, at)
    const { url, destPage } = v as Drawing<'link'>
    if ((url === undefined) === (destPage === undefined))
      fail('shape', at, 'a link with one target')
  },
  line: lineShape,
  arrow: lineShape,
  measure: shape<Drawing<'measure'>>({
    kind: anyKind,
    pageIndex: page,
    color: rgb,
    width: stroked.width,
    from: point,
    to: point,
    label: text(WIRE_LIMITS.label, 1),
  }),
  caret: shape<Drawing<'caret'>>({ kind: anyKind, pageIndex: page, color: rgb, point }),
  polygon: shape<Drawing<'polygon'>>(
    { kind: anyKind, ...stroked, vertices: list(WIRE_LIMITS.vertices, point, 3) },
    ['formFieldName'],
  ),
  image: shape<Drawing<'image'>>(
    { kind: anyKind, pageIndex: page, image: picture, rect, formFieldName: name },
    ['formFieldName'],
  ),
  note: shape<Drawing<'note'>>(
    {
      kind: anyKind,
      pageIndex: page,
      color: rgb,
      at: point,
      contents: words,
      author: name,
      createdMs: number(0, 1e15),
      localId: id,
      replyToSaved: shape<NoteReplyTarget>({ objNum, rect, contents: words }),
      replyToLocalId: id,
    },
    ['author', 'createdMs', 'localId', 'replyToSaved', 'replyToLocalId'],
  ),
}

const drawingInput: Check = (v, at) => {
  const kind = isObject(v) ? v.kind : undefined
  if (typeof kind !== 'string' || !Object.hasOwn(DRAWING, kind)) fail('shape', at, 'a drawing')
  DRAWING[kind as DrawingInput['kind']](v, at)
}

const savedNote = shape<SavedNoteAnnot>({
  pageIndex: page,
  objNum,
  type: oneOf('note'),
  rect,
  color: nullable(rgb),
  author: words,
  contents: words,
  timeMs: nullable(number(-1e15, 1e15)),
  inReplyTo: nullable(objNum),
})

/** What each carried list bucket holds */
const ITEM: Record<Carried, Check> = {
  blankPages: shape<LocalBlankPage>({
    id,
    input: shape<BlankPageInput>({
      pageIndex: page,
      width: number(1, WIRE_LIMITS.side),
      height: number(1, WIRE_LIMITS.side),
    }),
  }),
  markups: shape<LocalMarkup>(
    {
      id,
      pageIndex: page,
      type: oneOf('highlight', 'underline', 'strikeout', 'squiggly'),
      color: rgb,
      quads: list(WIRE_LIMITS.quads, tuple(8, coord), 1),
      subject: name,
    },
    ['subject'],
  ),
  noteEdits: shape<LocalNoteEdit>({ id, annot: savedNote, contents: words }),
  drawings: shape<LocalDrawing>({ id, input: drawingInput, formWidgetId: name }, ['formWidgetId']),
  formFields: shape<LocalFormField>({
    id,
    input: shape<FormFieldInput>(
      {
        name: text(WIRE_LIMITS.name, 1),
        kind: oneOf('text', 'checkbox', 'radio', 'choice', 'signature'),
        pageIndex: page,
        rect,
        required: flag,
        multiLine: flag,
        maxLen: integer(0, 1_000_000),
        fontSize: number(0, 1_000),
        textAlignment: oneOf('left', 'center', 'right'),
        value: words,
        checked: flag,
        exportValue: name,
        options: list(WIRE_LIMITS.options, name),
        dateFormat,
      },
      [
        'required',
        'multiLine',
        'maxLen',
        'fontSize',
        'textAlignment',
        'value',
        'checked',
        'exportValue',
        'options',
        'dateFormat',
      ],
    ),
  }),
}

const formValue = shape<FormValueInput>(
  {
    name: text(WIRE_LIMITS.name, 1),
    kind: oneOf('text', 'checkbox', 'radio', 'choice'),
    value: words,
    checked: flag,
  },
  ['value', 'checked'],
)

const widgetEdit = shape<FormWidgetEditInput>(
  { widgetId: text(WIRE_LIMITS.name, 1), fieldName: name, rect, required: flag, remove: flag },
  ['rect', 'required', 'remove'],
)

const line = text(10_000)

const stampCfg = shape<StampConfig>({
  wm: nullable(
    shape<WatermarkConfig>({
      text: line,
      angle: number(-3_600, 3_600),
      opacity: number(0, 1),
      color: hexColor,
      sizeRatio: number(0, 10),
    }),
  ),
  hf: nullable(
    shape<HeaderFooterConfig>({
      headerLeft: line,
      headerCenter: line,
      headerRight: line,
      footerLeft: line,
      footerCenter: line,
      footerRight: line,
      pageNumber: flag,
      startAt: number(-1_000_000_000, 1_000_000_000),
      fontSize: number(0, 1_000),
      color: hexColor,
    }),
  ),
})

const metadata = shape<MetadataInput>(
  { title: line, author: line, subject: line, keywords: line },
  ['title', 'author', 'subject', 'keywords'],
)

const pages = list(WIRE_LIMITS.pages, page)
const turn = oneOf(0, 90, 180, 270)
const bucket: Check = () => {}

const listPut = shape<{ b: string; id: string; v: unknown }>({ b: bucket, id, v: bucket })

/** One item of a list bucket, by its id; null takes it away */
const itemOf =
  (b: Carried): Check =>
  (v, at) => {
    listPut(v, at)
    const edit = v as { id: string; v: unknown }
    if (edit.v === null) {
      // blank pages are never taken away: an undone insertion is a deleted page
      if (b === 'blankPages') fail('shape', at, 'a blank page')
      return
    }
    ITEM[b](edit.v, `${at}.v`)
    if ((edit.v as { id: unknown }).id !== edit.id) fail('shape', at, "its id's item")
  }

/** One entry of a map bucket, which is stored under the key its value names */
const entryOf = <V>(value: Check, key: (entry: V) => string): Check => {
  const entry = shape<{ b: string; k: string; v: unknown }>({
    b: bucket,
    k: name,
    v: nullable(value),
  })
  return (v, at) => {
    entry(v, at)
    const edit = v as { k: string; v: V | null }
    if (edit.v !== null && key(edit.v) !== edit.k) fail('shape', at, "its key's entry")
  }
}

/** One edit of each bucket, as `Put` (collab-model.ts) spells it */
const PUT: Record<Carried | Exclude<Put['b'], ListBucket>, Check> = {
  blankPages: itemOf('blankPages'),
  markups: itemOf('markups'),
  noteEdits: itemOf('noteEdits'),
  drawings: itemOf('drawings'),
  formFields: itemOf('formFields'),
  formEdits: entryOf<FormValueInput>(formValue, (entry) => entry.name),
  formWidgetEdits: entryOf<FormWidgetEditInput>(widgetEdit, (entry) => entry.widgetId),
  rotations: shape<{ b: string; k: number; v: number; was: number }>({
    b: bucket,
    k: page,
    v: turn,
    was: turn,
  }),
  deleted: shape<{ b: string; k: number; v: boolean }>({ b: bucket, k: page, v: flag }),
  order: shape<{ b: string; v: number[] | null; was: number[] }>({
    b: bucket,
    v: nullable(pages),
    was: pages,
  }),
  stampCfg: shape<{ b: string; v: unknown }>({ b: bucket, v: nullable(stampCfg) }),
  metadata: shape<{ b: string; v: unknown }>({ b: bucket, v: nullable(metadata) }),
}

const put: Check = (v, at) => {
  const b = isObject(v) ? v.b : undefined
  if (typeof b !== 'string' || !Object.hasOwn(PUT, b)) {
    fail('shape', at, 'an edit co-editing carries')
  }
  PUT[b as keyof typeof PUT](v, at)
}

const op = shape<PdfOp>({ id, puts: list(WIRE_LIMITS.puts, put) })

/** `json` as a PdfOp; throws a WireError on anything this editor does not send */
export function decodeOp(json: Json): PdfOp {
  op(json, 'change')
  return json as unknown as PdfOp
}

/** Why peers would not take `change`, or null when they would */
export function unshareable(change: PdfOp): WireFault | null {
  try {
    op(change, 'change')
    return null
  } catch (error) {
    if (error instanceof WireError) return error.fault
    throw error
  }
}
