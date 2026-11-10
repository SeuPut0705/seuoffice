/**
 * The edits two people can make to one deck at once, as data every client applies the same way.
 *
 * An edit names slides by their part (`s_<n>`) and elements by the ids their own bytes carry
 * (`e_<guid8>` or `e_<cNvPr id>`), never by position or parse-time id: positions move under
 * other people's edits and parse-time ids differ from page to page. Applying an edit is the same
 * op transaction the single-user page runs, with two things pinned so every client ends with the
 * same bytes:
 *
 * - the GUIDs the engine mints (`a16:creationId` for an element an edit touches, `a:fld` ids of
 *   a body it bakes while applying) come from the edit's own id, so they are the same on every
 *   page that applies it;
 * - the `a:fld` ids the engine mints anew each time it writes a body with a field come from one
 *   fixed sequence whenever a slide is written (fingerprint, file), so writing is repeatable;
 * - what the originator's layout decided after a text edit (autofit size or shrink) travels in
 *   the edit, because another page lays text out at another width.
 */
import {
  elementDurableId,
  ensureCreationId,
  groupChildDurableId,
  matchesElementRef,
  PackageArchive,
  patchBodyPrAutofit,
  patchSlideXml,
  savePptx,
  slideDurableId,
  type OpenedPptx,
  type Slide,
  type SlideElement,
  type SlideSize,
  type TextElement,
} from '@genoffice/pptx-engine'
import { runTxn, type EditParagraph, type Op as PptxOp, type TxnResult } from '@genoffice/pptx-ops'

/** An element as every page names it */
export interface ElementRef {
  slide: string
  el: string
  /** the top-level group `el` is a direct child of */
  group?: string
}

/** What the originator's layout wrote back after a text edit */
export interface Autofit {
  /** spAutoFit: the box after it grew or shrank around its text */
  offset?: { x: number; y: number; cx: number; cy: number }
  /** normAutofit: the shrink the layout used; a reduction of 0 removes the attribute */
  fontScale?: number
  lnSpcReduction?: number
}

export type SlidesEdit =
  /** the whole text of one box; a later edit of the same box replaces an earlier one */
  | { kind: 'text'; at: ElementRef; paragraphs: EditParagraph[]; autofit?: Autofit }
  /** `made` is the slide it created when it was last applied on the page that holds it */
  | { kind: 'duplicateSlide'; slide: string; clearText: boolean; made: string }
  | { kind: 'blankSlide'; slide: string; before: boolean; made: string }
  | { kind: 'deleteSlides'; slides: string[] }
  | { kind: 'notes'; slide: string; text: string }

export interface SlidesOp {
  /** minted by the originator; seeds every GUID applying the edit mints */
  id: string
  edit: SlidesEdit
}

export interface Applied {
  /** the slide a duplicateSlide or blankSlide created */
  made?: string
  /** a text edit changed paragraph levels, so its slide was parsed again */
  levelDirty?: boolean
}

export const slideIndexOf = (opened: OpenedPptx, slide: string): number =>
  opened.deck.slides.findIndex((s) => slideDurableId(s) === slide)

/** The slide shown at `index`, as every page names it */
export const slideIdAt = (opened: OpenedPptx, index: number): string | null => {
  const slide = opened.deck.slides[index]
  return slide ? slideDurableId(slide) : null
}

/** The element a parse-time id stands for on this page, wherever its slide now sits */
export function elementRefOf(
  opened: OpenedPptx,
  sourceId: string,
  groupId?: string,
): ElementRef | null {
  for (const slide of opened.deck.slides) {
    if (groupId) {
      const grp = slide.elements.find((el) => el.id === groupId && el.type === 'group')
      if (!grp || grp.type !== 'group') continue
      const child = grp.children.find((c) => c.id === sourceId)
      const el = child && groupChildDurableId(grp, child)
      const group = elementDurableId(grp)
      return el && group ? { slide: slideDurableId(slide), el, group } : null
    }
    const found = slide.elements.find((el) => el.id === sourceId)
    if (!found) continue
    const el = elementDurableId(found)
    return el ? { slide: slideDurableId(slide), el } : null
  }
  return null
}

/** Every parse-time id on the page with the ref it stands for, keyed as `group/source` */
export function elementRefs(opened: OpenedPptx): Map<string, ElementRef> {
  const refs = new Map<string, ElementRef>()
  for (const slide of opened.deck.slides) {
    const at = slideDurableId(slide)
    for (const el of slide.elements) {
      const id = elementDurableId(el)
      if (id) refs.set(`/${el.id}`, { slide: at, el: id })
      if (el.type !== 'group' || !id) continue
      for (const child of el.children) {
        const childId = groupChildDurableId(el, child)
        if (childId) refs.set(`${el.id}/${child.id}`, { slide: at, el: childId, group: id })
      }
    }
  }
  return refs
}

// ── applying ────────────────────────────────────────────────────────────

/** 32 bits from a text */
function mix(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return h >>> 0
}

/** 128 bits from the edit id and a counter, shaped as a version 4 UUID */
function uuidFrom(seed: string, n: number): string {
  const words: string[] = []
  for (let salt = 0; salt < 4; salt++)
    words.push(mix(`${salt}#${seed}#${n}`).toString(16).padStart(8, '0'))
  const hex = words.join('')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Run `work` with `Math.random` answering from `seed`: the same numbers in the same order every
 * time. The engine draws a field's id (`a:fld`) from it each time it writes a body anew. `work`
 * is synchronous, or at least draws nothing after its first await.
 */
function withRandom<T>(seed: string, work: () => T): T {
  const real = Math.random
  let n = 0
  Math.random = () => mix(`r#${seed}#${n++}`) / 0x100000000
  try {
    return work()
  } finally {
    Math.random = real
  }
}

/**
 * Run `apply` with `crypto.randomUUID` and `Math.random` answering from `seed`. The engine mints
 * creationIds with the first and field ids with the second; nothing that renders runs inside,
 * so media URLs keep their real randomness.
 */
function seeded<T>(seed: string, apply: () => T): T {
  const crypto = globalThis.crypto
  const own = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  let n = 0
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => uuidFrom(seed, n++),
  })
  try {
    return withRandom(seed, apply)
  } finally {
    if (own) Object.defineProperty(crypto, 'randomUUID', own)
    else Reflect.deleteProperty(crypto, 'randomUUID')
  }
}

/**
 * Write slides with the ids the engine mints while writing taken from one fixed sequence. The
 * fingerprint and the file write the same edited slides in the same order, so both get the same
 * bytes, every time and on every page.
 */
const writing = <T>(write: () => T): T => withRandom('write', write)

const isDirty = (el: SlideElement): boolean =>
  !!(
    el.dirty ||
    el.dirtyTransform ||
    el.dirtyFill ||
    el.dirtyStroke ||
    el.dirtySrcRect ||
    el.dirtyPPr
  )

/**
 * Give every edited element its creationId now, while the edit's seed answers. A save, a render
 * or a fingerprint would otherwise mint one later from real randomness, different on each page.
 */
function hardenEdited(opened: OpenedPptx): void {
  for (const slide of opened.deck.slides)
    for (const el of slide.elements) if (isDirty(el)) ensureCreationId(el)
}

function txn(opened: OpenedPptx, ops: PptxOp[]): TxnResult | null {
  const r = runTxn(opened, { ops })
  return r.applied ? r : null
}

/** The slide `run` added, or null when it added none */
function created(opened: OpenedPptx, run: () => TxnResult | null): Applied | null {
  const before = new Set(opened.deck.slides.map((s) => s.path))
  if (!run()) return null
  const slide = opened.deck.slides.find((s) => !before.has(s.path))
  return slide ? { made: slideDurableId(slide) } : null
}

/**
 * The originator's autofit write-back (main/autofit-writeback.ts), from its carried result. The
 * originator runs it too, after its own layout, so every page marks the element the same way.
 */
export function fitText(opened: OpenedPptx, at: ElementRef, fit: Autofit): void {
  const slide = opened.deck.slides[slideIndexOf(opened, at.slide)]
  const el = slide?.elements.find((e) => matchesElementRef(e, at.el))
  if (!slide || !el || (el.type !== 'text' && el.type !== 'shape')) return
  if (fit.offset) {
    el.transform = { ...el.transform, offset: { ...el.transform.offset, ...fit.offset } }
    el.dirtyTransform = true
  }
  const text = (el as TextElement).text
  if (fit.fontScale !== undefined && text) {
    const reduction = fit.lnSpcReduction ?? 0
    text.fontScale = fit.fontScale
    if (reduction) text.lnSpcReduction = reduction
    else delete text.lnSpcReduction
    el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, fit.fontScale, reduction)
    slide.structureDirty = true
  }
}

function applyEdit(opened: OpenedPptx, edit: SlidesEdit): Applied | null {
  switch (edit.kind) {
    case 'text': {
      const r = txn(opened, [
        {
          op: 'setText',
          target: { slide: edit.at.slide, el: edit.at.el },
          // the executor may normalize what it is given; the edit stays as it was sent
          paragraphs: structuredClone(edit.paragraphs),
          ...(edit.at.group ? { group: edit.at.group } : {}),
        },
      ])
      if (!r) return null
      if (edit.autofit) fitText(opened, edit.at, edit.autofit)
      const after = r.records?.[0]?.after
      return isRecord(after) && after.levelDirty === true ? { levelDirty: true } : {}
    }
    case 'duplicateSlide':
      return created(opened, () =>
        txn(opened, [
          {
            op: 'duplicateSlide',
            target: { slide: edit.slide },
            ...(edit.clearText ? { clearText: true } : {}),
          },
        ]),
      )
    case 'blankSlide': {
      const at = slideIndexOf(opened, edit.slide)
      if (at < 0) return null
      return created(opened, () =>
        txn(opened, [
          { op: 'addBlankSlide', target: { slide: edit.slide } },
          // the source moves past the new slide, which so lands where the source was
          ...(edit.before ? [{ op: 'moveSlide', target: { slide: edit.slide }, to: at + 1 }] : []),
        ]),
      )
    }
    case 'deleteSlides': {
      // slides someone else already deleted are gone either way; a deck is never emptied
      const present = edit.slides.filter((id) => slideIndexOf(opened, id) >= 0)
      if (present.length === 0 || present.length >= opened.deck.slides.length) return null
      return txn(
        opened,
        present.map((id) => ({ op: 'deleteSlide', target: { slide: id } })),
      )
        ? {}
        : null
    }
    case 'notes':
      return txn(opened, [{ op: 'setNotes', target: { slide: edit.slide }, text: edit.text }])
        ? {}
        : null
  }
}

/**
 * Apply `op` to the deck. The same deck and the same op give the same bytes on every page.
 * Null when the edit no longer applies (its slide or element is gone); the deck is then as it was.
 */
export function applyOp(opened: OpenedPptx, op: SlidesOp): Applied | null {
  return seeded(op.id, () => {
    const applied = applyEdit(opened, op.edit)
    if (applied) hardenEdited(opened)
    return applied
  })
}

// ── state ───────────────────────────────────────────────────────────────

/** Everything an edit can change: the parsed slides, the package entries and the page size */
export interface DeckState {
  slides: Slide[]
  entries: Map<string, Uint8Array>
  size: SlideSize
}

/** Entry bytes are replaced on change, never written into, so the map copy is shallow */
export function takeState(opened: OpenedPptx): DeckState {
  return {
    slides: structuredClone(opened.deck.slides),
    entries: new Map(opened.archive.entries),
    size: structuredClone(opened.deck.size),
  }
}

/** Put `state` back into the deck; the deck owns it from then on */
export function putState(opened: OpenedPptx, state: DeckState): void {
  opened.deck.slides = state.slides
  opened.deck.size = state.size
  const entries = opened.archive.entries
  entries.clear()
  for (const [path, bytes] of state.entries) entries.set(path, bytes)
}

const digests = new WeakMap<Uint8Array, string>()

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  let hex = ''
  for (const byte of new Uint8Array(hash)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * A hash of the file a save would write now: every package entry, with the slides an edit
 * touched as the save patches them. Equal on every page at one version, and equal to the
 * hash of that version's saved file reopened.
 */
export function fingerprint(opened: OpenedPptx): Promise<string> {
  // read now; only the hashing runs later
  const parts = new Map<string, Uint8Array>(opened.archive.entries)
  const encoder = new TextEncoder()
  writing(() => {
    for (const slide of opened.deck.slides) {
      // the slides a save patches (engine buildZip), in its order; the others it copies as they are
      if (slide.structureDirty || slide.elements.some(isDirty))
        parts.set(slide.path, encoder.encode(patchSlideXml(slide)))
    }
  })
  const head = `${opened.deck.size.cx}x${opened.deck.size.cy} ${opened.deck.slides.map((s) => s.path).join(',')}`
  return (async () => {
    const lines: string[] = []
    for (const [path, bytes] of parts) {
      let hex = digests.get(bytes)
      if (hex === undefined) digests.set(bytes, (hex = await digest(bytes)))
      lines.push(`${path} ${hex}`)
    }
    lines.sort()
    return digest(encoder.encode([head, ...lines].join('\n')))
  })()
}

/**
 * The file of the deck as it is now, written by the engine's save on a copy: the live deck
 * keeps its dirty flags and entries, which a save would otherwise bake in or strip.
 */
export function deckFile(opened: OpenedPptx): Promise<Uint8Array> {
  const archive = Object.assign(Object.create(PackageArchive.prototype) as PackageArchive, {
    entries: new Map(opened.archive.entries),
    originalHash: opened.archive.originalHash,
  })
  // the engine patches every edited slide before its first await (buildZip)
  return writing(() =>
    savePptx({
      deck: { ...opened.deck, slides: structuredClone(opened.deck.slides) },
      archive,
    }),
  )
}

// ── the wire form ───────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function fail(what: string): never {
  throw new Error(`not a slides edit: ${what}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) fail(what)
  return value
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(what)
  return value
}

function ref(value: unknown): ElementRef {
  if (!isRecord(value)) fail('at')
  const at: ElementRef = { slide: text(value.slide, 'at.slide'), el: text(value.el, 'at.el') }
  if (value.group !== undefined) at.group = text(value.group, 'at.group')
  return at
}

function paragraphs(value: unknown): EditParagraph[] {
  if (!Array.isArray(value)) fail('paragraphs')
  for (const p of value) {
    if (!isRecord(p) || !Array.isArray(p.runs)) fail('paragraphs[].runs')
    for (const r of p.runs) if (!isRecord(r) || typeof r.text !== 'string') fail('runs[].text')
  }
  return value as EditParagraph[]
}

function autofit(value: unknown): Autofit {
  if (!isRecord(value)) fail('autofit')
  const fit: Autofit = {}
  if (value.offset !== undefined) {
    const o = value.offset
    if (!isRecord(o)) fail('autofit.offset')
    fit.offset = {
      x: finite(o.x, 'offset.x'),
      y: finite(o.y, 'offset.y'),
      cx: finite(o.cx, 'offset.cx'),
      cy: finite(o.cy, 'offset.cy'),
    }
  }
  if (value.fontScale !== undefined) fit.fontScale = finite(value.fontScale, 'fontScale')
  if (value.lnSpcReduction !== undefined)
    fit.lnSpcReduction = finite(value.lnSpcReduction, 'lnSpcReduction')
  return fit
}

function edit(value: unknown): SlidesEdit {
  if (!isRecord(value)) fail('edit')
  switch (value.kind) {
    case 'text':
      return {
        kind: 'text',
        at: ref(value.at),
        paragraphs: paragraphs(value.paragraphs),
        ...(value.autofit !== undefined ? { autofit: autofit(value.autofit) } : {}),
      }
    case 'duplicateSlide':
      if (typeof value.clearText !== 'boolean') fail('clearText')
      return {
        kind: 'duplicateSlide',
        slide: text(value.slide, 'slide'),
        clearText: value.clearText,
        made: text(value.made, 'made'),
      }
    case 'blankSlide':
      if (typeof value.before !== 'boolean') fail('before')
      return {
        kind: 'blankSlide',
        slide: text(value.slide, 'slide'),
        before: value.before,
        made: text(value.made, 'made'),
      }
    case 'deleteSlides':
      if (!Array.isArray(value.slides) || value.slides.length === 0) fail('slides')
      return { kind: 'deleteSlides', slides: value.slides.map((s) => text(s, 'slides[]')) }
    case 'notes':
      if (typeof value.text !== 'string') fail('text')
      return { kind: 'notes', slide: text(value.slide, 'slide'), text: value.text }
    default:
      return fail(`kind ${String(value.kind)}`)
  }
}

export function decodeOp(json: unknown): SlidesOp {
  if (!isRecord(json)) fail('op')
  return { id: text(json.id, 'id'), edit: edit(json.edit) }
}

export const encodeOp = (op: SlidesOp): Json => JSON.parse(JSON.stringify(op)) as Json
