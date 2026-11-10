/**
 * What a co-editing page takes from the wire.
 *
 * A peer's edit is JSON from a page that may run other code than this one, and applying it
 * runs the op executor on this page's deck. `decodeOp` takes only what the app itself sends:
 * the five edit kinds, with the fields the app writes and nothing beside them; slides and
 * elements named the way every page names them (`s_<n>`, `e_<guid8>` or `e_<cNvPr id>`), never
 * a part path, a position or an id a page made while parsing; names and tokens that end up in
 * the slide's XML in the shapes the text editor produces; and text, paragraph and run counts a
 * person's own edit stays under, so that no single edit can keep a page busy. Anything else
 * throws, and the engine stops this page's session instead of applying the edit.
 *
 * Where a run's link may go is not decided here: a text box is sent whole, links the file
 * already had included, so that takes the deck the edit lands on (`applyOp`, collab-ops.ts).
 *
 * `shape<T>` names every field of `T`: a field added to an edit, a paragraph or a run does not
 * compile here until it is given a check.
 *
 * A person's own text and notes pass the same check before they are applied (collab-side.ts),
 * so a page never sends what its peers would stop on.
 */
import { NAMED_ACTIONS } from '@genoffice/pptx-engine/named-action'
import type { EditParagraph, EditRun, LinkTargetOp } from '@genoffice/pptx-ops'
import type { Autofit, ElementRef, SlidesEdit, SlidesOp } from './collab-ops'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Why an edit is not taken: not a shape the app writes, or too long or too many */
export type WireFault = 'shape' | 'size'

export class WireError extends Error {
  constructor(
    readonly fault: WireFault,
    message: string,
  ) {
    super(`not a slides edit: ${message}`)
  }
}

/** The most one edit holds; a person's own edit over these is refused where it is made */
export const WIRE_LIMITS = {
  id: 128,
  /** characters of one text box, over all its runs, and of one slide's notes */
  text: 500_000,
  paragraphs: 2_000,
  /** runs of one paragraph */
  runs: 2_000,
  /** a font name, a withheld run's label */
  name: 256,
  /** a link's address; a file's own may be long */
  url: 8_192,
  /** base64 characters of a picture bullet */
  bulletImage: 2_000_000,
  /** slides one edit deletes */
  slides: 10_000,
  /** EMU, with room beyond any slide */
  emu: 1e12,
} as const

/** A slide id no slide has: an edit naming it applies as nothing, on every page */
export const GONE = '\u0000gone'

type Check = (value: unknown, at: string) => void

function fail(fault: WireFault, at: string, need: string): never {
  throw new WireError(fault, `${at} is not ${need}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text =
  (max: number, min = 0): Check =>
  (v, at) => {
    if (typeof v !== 'string' || v.length < min) fail('shape', at, 'a string')
    if (v.length > max) fail('size', at, `at most ${max} characters`)
  }

/** A string of a known shape: one that goes into the slide's XML as a name or a token */
const matching =
  (pattern: RegExp, need: string): Check =>
  (v, at) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail('shape', at, need)
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

/**
 * An object with exactly the fields of `T`: each named here with its check, the ones in
 * `optional` free to be absent. A field holding `undefined` is absent, as JSON leaves it out.
 */
function shape<T>(fields: { [K in keyof T]-?: Check }, optional: readonly (keyof T)[] = []): Check {
  const checks = Object.entries(fields) as [string, Check][]
  const known = new Set(Object.keys(fields))
  const free = new Set<PropertyKey>(optional)
  return (v, at) => {
    if (!isRecord(v)) fail('shape', at, 'an object')
    for (const key of Object.keys(v)) {
      if (v[key] !== undefined && !known.has(key)) {
        fail('shape', `${at}.${key}`, 'a field the app writes')
      }
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

/** `s_<n>` of a numbered slide part, or the form `slideDurableId` gives any other part */
const SLIDE_ID = /^s_[A-Za-z0-9_]{1,200}$/
/** `e_<guid8>` from a creationId, or `e_<cNvPr id>` */
const ELEMENT_ID = /^e_(?:[0-9a-f]{8}|\d{1,20})$/

const madeSlide = matching(SLIDE_ID, 'a slide id')
const slide: Check = (v, at) => {
  if (v !== GONE) madeSlide(v, at)
}
const element = matching(ELEMENT_ID, 'an element id')

const hexColor = matching(/^#?[0-9A-Fa-f]{6}$/, 'a hex colour')
/** A font or bullet font as a deck names it: no control character, nothing that reads as markup */
const fontName: Check = (v, at) => {
  if (typeof v !== 'string' || v.length < 1 || v.length > WIRE_LIMITS.name) {
    fail('shape', at, 'a font name')
  }
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || '<>"'.includes(v[i]!)) fail('shape', at, 'a font name')
  }
}
/** `slidenum`, `datetime1`, `arabicPeriod`: a token of the format's own vocabulary */
const token = matching(/^[A-Za-z][A-Za-z0-9]{0,39}$/, 'a name of the format')
const emu = number(-WIRE_LIMITS.emu, WIRE_LIMITS.emu)

/** A link's address as text: which addresses a box may link to is decided where the edit lands */
const linkUrl: Check = (v, at) => {
  if (typeof v !== 'string' || v.length < 1) fail('shape', at, 'an address')
  if (v.length > WIRE_LIMITS.url) fail('size', at, `at most ${WIRE_LIMITS.url} characters`)
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) fail('shape', at, 'an address')
  }
}

type Link<K extends LinkTargetOp['kind']> = Extract<LinkTargetOp, { kind: K }>

const LINK: { [K in LinkTargetOp['kind']]: Check } = {
  url: shape<Link<'url'>>({ kind: anyKind, url: linkUrl }),
  slide: shape<Link<'slide'>>({ kind: anyKind, slideIndex: integer(0, 1_000_000) }),
  action: shape<Link<'action'>>({ kind: anyKind, action: oneOf(...NAMED_ACTIONS) }),
}

const link: Check = (v, at) => {
  const kind = isRecord(v) ? v.kind : undefined
  if (typeof kind !== 'string' || !Object.hasOwn(LINK, kind)) fail('shape', at, 'a link')
  LINK[kind as LinkTargetOp['kind']](v, at)
}

const run = shape<EditRun>(
  {
    text: text(WIRE_LIMITS.text),
    bold: flag,
    italic: flag,
    underline: flag,
    fontSize: number(0.1, 4_000),
    fontFamily: fontName,
    color: hexColor,
    strike: flag,
    baseline: number(-1_000, 1_000),
    outline: shape<NonNullable<EditRun['outline']>>({
      color: hexColor,
      widthEmu: number(0, 10_000_000),
    }),
    highlight: nullable(hexColor),
    letterSpacing: nullable(number(-1_000, 1_000)),
    field: token,
    srcRun: integer(0, 1_000_000),
    link: nullable(link),
    redact: nullable(text(WIRE_LIMITS.name, 1)),
  },
  [
    'bold',
    'italic',
    'underline',
    'fontSize',
    'fontFamily',
    'color',
    'strike',
    'baseline',
    'outline',
    'highlight',
    'letterSpacing',
    'field',
    'srcRun',
    'link',
    'redact',
  ],
)

const bulletImage = shape<NonNullable<EditParagraph['bulletImage']>>({
  base64: (v, at) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) fail('shape', at, 'base64')
    if (v.length > WIRE_LIMITS.bulletImage) fail('size', at, 'a picture a bullet can be')
  },
  ext: matching(/^[A-Za-z0-9]{1,5}$/, 'a picture type'),
})

const paragraph = shape<EditParagraph>(
  {
    runs: list(WIRE_LIMITS.runs, run),
    align: oneOf('left', 'center', 'right', 'justify'),
    level: integer(0, 8),
    srcPara: integer(0, 1_000_000),
    bullet: oneOf('char', 'number', 'blip', 'none'),
    bulletChar: text(32, 1),
    bulletFont: fontName,
    numType: token,
    startAt: integer(1, 32_767),
    bulletImage,
    lineSpacingPct: number(-100_000, 100_000),
    spaceBeforePt: number(-100_000, 100_000),
    spaceAfterPt: number(-100_000, 100_000),
    rtl: flag,
  },
  [
    'align',
    'level',
    'srcPara',
    'bullet',
    'bulletChar',
    'bulletFont',
    'numType',
    'startAt',
    'bulletImage',
    'lineSpacingPct',
    'spaceBeforePt',
    'spaceAfterPt',
    'rtl',
  ],
)

const paragraphList = list(WIRE_LIMITS.paragraphs, paragraph)

/** The paragraphs of one box: each a paragraph, and all their text within what a box holds */
const paragraphs: Check = (v, at) => {
  paragraphList(v, at)
  let chars = 0
  for (const p of v as EditParagraph[]) for (const r of p.runs) chars += r.text.length
  if (chars > WIRE_LIMITS.text) fail('size', at, `at most ${WIRE_LIMITS.text} characters`)
}

const autofit = shape<Autofit>(
  {
    offset: shape<NonNullable<Autofit['offset']>>({ x: emu, y: emu, cx: emu, cy: emu }),
    fontScale: number(0, 10),
    lnSpcReduction: number(0, 10),
  },
  ['offset', 'fontScale', 'lnSpcReduction'],
)

type Edit<K extends SlidesEdit['kind']> = Extract<SlidesEdit, { kind: K }>

const EDIT: { [K in SlidesEdit['kind']]: Check } = {
  text: shape<Edit<'text'>>(
    {
      kind: anyKind,
      at: shape<ElementRef>({ slide, el: element, group: element }, ['group']),
      paragraphs,
      autofit,
    },
    ['autofit'],
  ),
  duplicateSlide: shape<Edit<'duplicateSlide'>>({
    kind: anyKind,
    slide,
    clearText: flag,
    made: madeSlide,
  }),
  blankSlide: shape<Edit<'blankSlide'>>({ kind: anyKind, slide, before: flag, made: madeSlide }),
  deleteSlides: shape<Edit<'deleteSlides'>>({
    kind: anyKind,
    slides: list(WIRE_LIMITS.slides, slide, 1),
  }),
  notes: shape<Edit<'notes'>>({ kind: anyKind, slide, text: text(WIRE_LIMITS.text) }),
}

const edit: Check = (v, at) => {
  const kind = isRecord(v) ? v.kind : undefined
  if (typeof kind !== 'string' || !Object.hasOwn(EDIT, kind)) {
    fail('shape', at, 'an edit co-editing carries')
  }
  EDIT[kind as SlidesEdit['kind']](v, at)
}

const op = shape<SlidesOp>({ id, edit })

/** `json` as a SlidesOp; throws a WireError on anything this editor does not send */
export function decodeOp(json: unknown): SlidesOp {
  op(json, 'op')
  return json as SlidesOp
}

export const encodeOp = (sent: SlidesOp): Json => JSON.parse(JSON.stringify(sent)) as Json

/**
 * Why peers would not take `made`, or null when they would. For an edit that has not been
 * applied yet: a slide it is to make has no id to check.
 */
export function unshareable(made: SlidesEdit): WireFault | null {
  try {
    if (made.kind === 'text') paragraphs(made.paragraphs, 'paragraphs')
    else if (made.kind === 'notes') EDIT.notes(made, 'edit')
    return null
  } catch (error) {
    if (error instanceof WireError) return error.fault
    throw error
  }
}
