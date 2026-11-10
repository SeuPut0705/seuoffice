/**
 * The PDF editor's pending edits as the co-editing log carries them.
 *
 * Everything an ordinary save writes lives in one EditSnapshot
 * (renderer/edit-state.ts), relative to the opened file. A change travels as
 * puts: one item of a list bucket by its id, one entry of a map bucket by its
 * key, one page's deleted flag or rotation, or a whole value (page order,
 * stamps, metadata). Every client folds the log's puts in server order onto the
 * opened file's snapshot, so all of them hold the same state; the fold is the
 * only place where a put changes state, and it reads nothing but the put and
 * the state.
 *
 * Only the originator rewrites a put, while it is still unconfirmed (`rebase`),
 * so that it applies on top of what peers did first: a page a peer added takes
 * the index this person's new blank page held, an edit of an item a peer
 * removed is void, an edit on a page a peer deleted is void, rotations add up,
 * an order that only inserted pages inserts them into the peer's order.
 *
 * Original page indexes are the stable identity of pages: a deletion only
 * flags a page and an order lists every page. The one index a client mints is
 * a blank page's (the page count at the time), which `rebase` renumbers.
 */
import type { Json } from '@seuoffice/collab/client'
import type { LocalDrawing } from '../renderer/DrawLayer'
import type { EditSnapshot, LocalFormField } from '../renderer/edit-state'
import { lookup, reduceEditOps } from '../renderer/edit-ops'

export const LIST_BUCKETS = [
  'blankPages',
  'markups',
  'annotDeletes',
  'noteEdits',
  'drawings',
  'textEdits',
  'textInserts',
  'imageEdits',
  'formFields',
] as const satisfies readonly (keyof EditSnapshot)[]

export type ListBucket = (typeof LIST_BUCKETS)[number]
type MapBucket = 'formEdits' | 'formWidgetEdits'
type ValueBucket = 'stampCfg' | 'metadata'

export type Put =
  | { b: ListBucket; id: string; v: Json | null }
  | { b: MapBucket; k: string; v: Json | null }
  /** `v` is the rotation this person set and `was` the one they saw: the difference is their turn */
  | { b: 'rotations'; k: number; v: number; was: number }
  | { b: 'deleted'; k: number; v: boolean }
  /** `was` is the order this person saw, every page listed */
  | { b: 'order'; v: number[] | null; was: number[] }
  | { b: ValueBucket; v: Json | null }

type ListPut = Extract<Put, { b: ListBucket }>

/** One change a person made (one edit batch, one undo), applied whole or not at all */
export interface PdfOp {
  id: string
  puts: Put[]
}

type Entity = { id: string } & Record<string, unknown>
type PageRef = { of(item: Entity): number; at(item: Entity, page: number): Entity }

const inputPage: PageRef = {
  of: (item) => (item.input as { pageIndex: number }).pageIndex,
  at: (item, page) => ({ ...item, input: { ...(item.input as object), pageIndex: page } }),
}
const annotPage: PageRef = {
  of: (item) => (item.annot as { pageIndex: number }).pageIndex,
  at: (item, page) => ({ ...item, annot: { ...(item.annot as object), pageIndex: page } }),
}

/** Where each list item names its page */
const PAGE: Record<ListBucket, PageRef> = {
  blankPages: inputPage,
  markups: {
    of: (item) => item.pageIndex as number,
    at: (item, page) => ({ ...item, pageIndex: page }),
  },
  annotDeletes: annotPage,
  noteEdits: annotPage,
  drawings: inputPage,
  textEdits: inputPage,
  textInserts: inputPage,
  imageEdits: inputPage,
  formFields: inputPage,
}

/** The buckets whose items go with a deleted page, as the deletePage op decides */
const WITH_PAGE: ReadonlySet<string> = new Set(
  lookup('deletePage').touches.filter((bucket) => bucket !== 'deleted'),
)

const MAP_BUCKETS: readonly MapBucket[] = ['formEdits', 'formWidgetEdits']
const VALUE_BUCKETS: readonly ValueBucket[] = ['stampCfg', 'metadata']

export function emptySnapshot(): EditSnapshot {
  return {
    markups: [],
    annotDeletes: [],
    noteEdits: [],
    drawings: [],
    textEdits: [],
    textInserts: [],
    imageEdits: [],
    stampCfg: null,
    formEdits: new Map(),
    formFields: [],
    formWidgetEdits: new Map(),
    blankPages: [],
    rotations: new Map(),
    deleted: new Set(),
    order: null,
    metadata: null,
  }
}

const listOf = (s: EditSnapshot, bucket: ListBucket): readonly Entity[] =>
  s[bucket] as unknown as Entity[]

/** Every addressable page: the opened file's and the blank pages added since */
export const pageCount = (s: EditSnapshot, basePages: number): number =>
  basePages + s.blankPages.length

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/** The page order the App shows (`visList` before it hides deleted pages) */
export const effectiveOrder = (s: EditSnapshot, basePages: number): number[] =>
  s.order ?? range(pageCount(s, basePages))

// ── fold ──────────────────────────────────────────────────────────────

/** `s` with `puts` applied in order; the same on every client */
export function fold(s: EditSnapshot, puts: readonly Put[]): EditSnapshot {
  let cur = s
  for (const put of puts) cur = foldOne(cur, put)
  return cur
}

export function foldOps(s: EditSnapshot, ops: readonly PdfOp[]): EditSnapshot {
  let cur = s
  for (const op of ops) cur = fold(cur, op.puts)
  return cur
}

function foldOne(s: EditSnapshot, put: Put): EditSnapshot {
  switch (put.b) {
    case 'formEdits':
    case 'formWidgetEdits': {
      const next = new Map(s[put.b] as Map<string, unknown>)
      if (put.v === null) next.delete(put.k)
      else next.set(put.k, put.v)
      return { ...s, [put.b]: next }
    }
    case 'rotations': {
      const turn = (((put.v - (s.rotations.get(put.k) ?? 0)) % 360) + 360) % 360
      if (turn === 0) return s
      // the op's own reducer: a quarter turn also lays the page's picture stamps on their side,
      // so two people's turns of one page turn its stamps twice
      return reduceEditOps(s, [
        { op: 'rotatePages', pages: [put.k], dir: turn === 270 ? -90 : turn },
      ])
    }
    case 'deleted': {
      if (put.v) {
        // the op's own reducer: the page's pending markups, drawings and fields go with it
        return reduceEditOps(s, [{ op: 'deletePage', pageIndex: put.k }])
      }
      const deleted = new Set(s.deleted)
      deleted.delete(put.k)
      return { ...s, deleted }
    }
    case 'order':
      return { ...s, order: put.v }
    case 'stampCfg':
    case 'metadata':
      return { ...s, [put.b]: put.v }
    default:
      return { ...s, [put.b]: foldList(listOf(s, put.b), put) }
  }
}

function foldList(list: readonly Entity[], put: ListPut): Entity[] {
  const at = list.findIndex((item) => item.id === put.id)
  if (put.v === null) return at < 0 ? (list as Entity[]) : list.filter((_, i) => i !== at)
  const item = put.v as Entity
  if (at >= 0) return list.map((old, i) => (i === at ? item : old))
  if (put.b === 'noteEdits') {
    // one pending edit per saved note, as editSavedNote keeps it: the later one replaces it
    const target = item.annot as { objNum: number; pageIndex: number }
    return [
      ...list.filter((old) => {
        const annot = old.annot as { objNum: number; pageIndex: number }
        return annot.objNum !== target.objNum || annot.pageIndex !== target.pageIndex
      }),
      item,
    ]
  }
  return [...list, item]
}

// ── diff ──────────────────────────────────────────────────────────────

/**
 * The puts that turn `from` into `to`. Pages come first (blank pages, deleted
 * flags, order, rotations), so the item puts after them address pages that
 * exist. A blank page that disappears (an undone insertion) becomes a deleted
 * page: blank page indexes must stay gapless, and a peer may have added the
 * next one already. Items are compared with what the page puts already made
 * of them (a deleted page takes its items along, a quarter turn turns its
 * stamps): that part of the change travels as the page put alone, so it
 * composes with a peer's change of the same page.
 */
export function diff(from: EditSnapshot, to: EditSnapshot, basePages: number): Put[] {
  const puts: Put[] = []
  const blankGone: number[] = []
  puts.push(
    ...listDiff('blankPages', from, to).filter((put) => {
      if (put.v !== null) return true
      const gone = from.blankPages.find((b) => b.id === put.id)
      if (gone) blankGone.push(gone.input.pageIndex)
      return false
    }),
  )
  const deleted = new Set([...to.deleted, ...blankGone])
  for (const k of deleted) if (!from.deleted.has(k)) puts.push({ b: 'deleted', k, v: true })
  for (const k of from.deleted) if (!deleted.has(k)) puts.push({ b: 'deleted', k, v: false })
  if (!same(from.order, to.order)) {
    puts.push({ b: 'order', v: to.order, was: effectiveOrder(from, basePages) })
  }
  for (const k of new Set([...from.rotations.keys(), ...to.rotations.keys()])) {
    const was = from.rotations.get(k) ?? 0
    const v = to.rotations.get(k) ?? 0
    if (v !== was) puts.push({ b: 'rotations', k, v, was })
  }
  const paged = fold(from, puts)
  for (const bucket of LIST_BUCKETS)
    if (bucket !== 'blankPages') puts.push(...listDiff(bucket, paged, to))
  for (const bucket of MAP_BUCKETS) {
    const before = from[bucket] as Map<string, unknown>
    const after = to[bucket] as Map<string, unknown>
    if (before === after) continue
    for (const k of before.keys()) if (!after.has(k)) puts.push({ b: bucket, k, v: null })
    for (const [k, v] of after) {
      const old = before.get(k)
      if (old !== v && !same(old, v)) puts.push({ b: bucket, k, v: v as Json })
    }
  }
  for (const bucket of VALUE_BUCKETS) {
    if (from[bucket] !== to[bucket] && !same(from[bucket], to[bucket])) {
      puts.push({ b: bucket, v: to[bucket] as Json | null })
    }
  }
  return puts
}

function listDiff(bucket: ListBucket, from: EditSnapshot, to: EditSnapshot): ListPut[] {
  const before = listOf(from, bucket)
  const after = listOf(to, bucket)
  if (before === after) return []
  const puts: ListPut[] = []
  const kept = new Set(after.map((item) => item.id))
  for (const item of before) if (!kept.has(item.id)) puts.push({ b: bucket, id: item.id, v: null })
  const old = new Map(before.map((item) => [item.id, item]))
  for (const item of after) {
    const prev = old.get(item.id)
    if (prev !== item && !same(prev, item)) puts.push({ b: bucket, id: item.id, v: item as Json })
  }
  return puts
}

// ── rebase ────────────────────────────────────────────────────────────

/** What one `integrate` shares across the local ops it rewrites */
export interface Round {
  basePages: number
  /** `bucket:id` of every list item the peers' changes removed */
  removed: ReadonlySet<string>
  /** a local blank page's index → the index it takes after the peers' pages */
  renum: Map<number, number>
}

export function newRound(before: EditSnapshot, after: EditSnapshot, basePages: number): Round {
  const removed = new Set<string>()
  for (const bucket of LIST_BUCKETS) {
    const kept = new Set(listOf(after, bucket).map((item) => item.id))
    for (const item of listOf(before, bucket)) {
      if (!kept.has(item.id)) removed.add(`${bucket}:${item.id}`)
    }
  }
  return { basePages, removed, renum: new Map() }
}

/**
 * `puts` rewritten to apply on top of `cur`, with the state they make; null
 * when the change as a whole can no longer happen (it would delete the last
 * page). Puts that lost their target are left out.
 */
export function rebase(
  puts: readonly Put[],
  cur: EditSnapshot,
  round: Round,
): { puts: Put[]; state: EditSnapshot } | null {
  let state = cur
  const out: Put[] = []
  const keep = (put: Put): void => {
    out.push(put)
    state = foldOne(state, put)
  }
  const page = (index: number): number => round.renum.get(index) ?? index
  const count = (): number => pageCount(state, round.basePages)
  // the order this person saw before the change, which tells an insertion from a reorder
  const seen = effectiveOrder(cur, round.basePages)

  for (const put of puts) {
    switch (put.b) {
      case 'blankPages': {
        // blank pages are added and never changed: a known id has nothing left to do
        if (put.v === null || state.blankPages.some((b) => b.id === put.id)) break
        const item = put.v as Entity
        const target = count()
        const minted = PAGE.blankPages.of(item)
        if (minted !== target) round.renum.set(minted, target)
        keep({ b: 'blankPages', id: put.id, v: PAGE.blankPages.at(item, target) as Json })
        break
      }
      case 'deleted': {
        const k = page(put.k)
        if (k >= count() || state.deleted.has(k) === put.v) break
        if (put.v && count() - state.deleted.size <= 1) return null
        keep({ b: 'deleted', k, v: put.v })
        break
      }
      case 'order': {
        const v = put.v && mergeOrder(put.v.map(page), put.was.map(page), state, round.basePages)
        keep({ b: 'order', v, was: seen })
        break
      }
      case 'rotations': {
        const k = page(put.k)
        if (k >= count()) break
        const now = state.rotations.get(k) ?? 0
        const v = (((now + put.v - put.was) % 360) + 360) % 360
        if (v !== now) keep({ b: 'rotations', k, v, was: now })
        break
      }
      case 'formEdits':
      case 'formWidgetEdits':
      case 'stampCfg':
      case 'metadata':
        keep(put)
        break
      default: {
        if (put.v === null) {
          const gone = listOf(state, put.b).find((item) => item.id === put.id)
          if (!gone) break
          keep(put)
          if (put.b === 'drawings') {
            for (const reply of repliesTo(state, gone as unknown as LocalDrawing)) keep(reply)
          }
          break
        }
        // an edit of something a peer removed would bring it back
        if (round.removed.has(`${put.b}:${put.id}`)) break
        const ref = PAGE[put.b]
        let item = put.v as Entity
        const at = page(ref.of(item))
        if (at !== ref.of(item)) item = ref.at(item, at)
        if (at >= count() || (WITH_PAGE.has(put.b) && state.deleted.has(at))) break
        // list items are the App's own LocalDrawing, LocalFormField... (decodeOp checked the shape)
        if (put.b === 'drawings' && !parentShown(state, item as unknown as LocalDrawing)) break
        if (put.b === 'formFields') {
          item = freeName(state, item as unknown as LocalFormField) as unknown as Entity
        }
        keep({ b: put.b, id: put.id, v: item as Json })
      }
    }
  }
  const order = state.order && permutationOf(state.order, count())
  if (order) keep({ b: 'order', v: order, was: seen })
  return { puts: out, state }
}

/**
 * The order this person set, applied on top of a peer's: an order that only
 * inserted pages (a blank page) inserts them after the same neighbour in the
 * peer's order; any other order is this person's, and the pages they never saw
 * keep the neighbour they have in the peer's order.
 */
function mergeOrder(
  mine: number[],
  was: number[],
  state: EditSnapshot,
  basePages: number,
): number[] {
  const now = effectiveOrder(state, basePages)
  if (same(was, now)) return mine
  const seen = new Set(was)
  const fresh = new Set(mine.filter((p) => !seen.has(p)))
  if (
    fresh.size > 0 &&
    same(
      mine.filter((p) => !fresh.has(p)),
      was,
    )
  ) {
    return insertAfterNeighbours(
      now.filter((p) => !fresh.has(p)),
      mine,
      fresh,
    )
  }
  const count = pageCount(state, basePages)
  const own = mine.filter((p, i) => p < count && mine.indexOf(p) === i)
  const held = new Set(own)
  return insertAfterNeighbours(own, now, new Set(now.filter((p) => !held.has(p))))
}

/** `into` with each page of `pages` that `add` holds put after its nearest earlier neighbour there */
function insertAfterNeighbours(
  into: number[],
  pages: readonly number[],
  add: ReadonlySet<number>,
): number[] {
  const out = [...into]
  pages.forEach((p, i) => {
    if (!add.has(p)) return
    let j = i - 1
    while (j >= 0 && !out.includes(pages[j]!)) j--
    out.splice(j < 0 ? 0 : out.indexOf(pages[j]!) + 1, 0, p)
  })
  return out
}

/** `order` made a permutation of 0..count-1, or null when it is one */
function permutationOf(order: readonly number[], count: number): number[] | null {
  const seen = new Set<number>()
  const out: number[] = []
  for (const p of order) {
    if (Number.isInteger(p) && p >= 0 && p < count && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  for (let p = 0; p < count; p++) if (!seen.has(p)) out.push(p)
  return out.length === order.length && out.every((p, i) => p === order[i]) ? null : out
}

const localIdOf = (d: LocalDrawing): string | undefined =>
  d.input.kind === 'note' ? d.input.localId : undefined

/** Removal puts for the pending replies under a removed note, its whole subtree */
function repliesTo(state: EditSnapshot, removed: LocalDrawing): Put[] {
  const puts: Put[] = []
  const parents = [removed]
  while (parents.length > 0) {
    const parent = localIdOf(parents.pop()!)
    if (parent === undefined) continue
    for (const d of state.drawings) {
      if (d.input.kind === 'note' && d.input.replyToLocalId === parent) {
        puts.push({ b: 'drawings', id: d.id, v: null })
        parents.push(d)
      }
    }
  }
  return puts
}

/** A reply needs the note it answers; a peer may have deleted that thread */
function parentShown(state: EditSnapshot, item: LocalDrawing): boolean {
  if (item.input.kind !== 'note' || item.input.replyToLocalId === undefined) return true
  const parent = item.input.replyToLocalId
  return state.drawings.some((d) => localIdOf(d) === parent)
}

/**
 * A new field keeps its name unless a peer's pending field took it first; then
 * it takes the name with the next free number. Radio buttons share a name on
 * purpose.
 */
function freeName(state: EditSnapshot, item: LocalFormField): LocalFormField {
  const { input } = item
  const others = state.formFields.filter((f) => f.id !== item.id)
  const clash = others.some(
    (f) => f.input.name === input.name && !(f.input.kind === 'radio' && input.kind === 'radio'),
  )
  if (!clash) return item
  let n = 2
  while (others.some((f) => f.input.name === `${input.name} ${n}`)) n++
  return { ...item, input: { ...input, name: `${input.name} ${n}` } }
}

/** `s` with a round's blank page renumbering applied to every page it names */
export function renumbered(s: EditSnapshot, renum: ReadonlyMap<number, number>): EditSnapshot {
  if (renum.size === 0) return s
  const page = (index: number): number => renum.get(index) ?? index
  const next: EditSnapshot = { ...s }
  for (const bucket of LIST_BUCKETS) {
    const ref = PAGE[bucket]
    ;(next as unknown as Record<string, Entity[]>)[bucket] = listOf(s, bucket).map((item) =>
      page(ref.of(item)) === ref.of(item) ? item : ref.at(item, page(ref.of(item))),
    )
  }
  next.rotations = new Map([...s.rotations].map(([k, v]) => [page(k), v]))
  next.deleted = new Set([...s.deleted].map(page))
  next.order = s.order && s.order.map(page)
  return next
}

// ── encoding ──────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isPage = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const isPages = (v: unknown): v is number[] => Array.isArray(v) && v.every(isPage)

// ── picture bytes on the wire ─────────────────────────────────────────

/** A stamp's `image` on the wire when an earlier change of the log carries its bytes */
const PICTURE_REF = 'ref:'

export const pictureRef = (key: string): string => `${PICTURE_REF}${key}`

/** The key a wire `image` names, or null when it is the bytes themselves (base64 has no colon) */
export const pictureRefKey = (image: string): string | null =>
  image.startsWith(PICTURE_REF) ? image.slice(PICTURE_REF.length) : null

/** A name for picture bytes from the bytes alone: their length and 64 bits of two hashes */
export function pictureKey(image: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < image.length; i++) {
    const c = image.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 15)
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
  return `${image.length.toString(36)}.${hex(a)}${hex(b)}`
}

/** `op` with every picture stamp's `image` passed through `map`; `op` itself when none changed */
export function mapPictures(op: PdfOp, map: (image: string) => string): PdfOp {
  let changed = false
  const puts = op.puts.map((put): Put => {
    if (put.b !== 'drawings' || !isObject(put.v)) return put
    const input = put.v.input
    if (!isObject(input) || input.kind !== 'image' || typeof input.image !== 'string') return put
    const image = map(input.image)
    if (image === input.image) return put
    changed = true
    return { ...put, v: { ...put.v, input: { ...input, image } } }
  })
  return changed ? { id: op.id, puts } : op
}

/** `json` as a PdfOp; throws on any shape this editor does not write */
export function decodeOp(json: Json): PdfOp {
  if (!isObject(json) || typeof json.id !== 'string' || !Array.isArray(json.puts)) {
    throw new Error('not a pdf op')
  }
  return { id: json.id, puts: json.puts.map(decodePut) }
}

function decodePut(json: Json): Put {
  if (!isObject(json) || typeof json.b !== 'string') throw new Error('not a pdf edit')
  const { b, v } = json
  if ((LIST_BUCKETS as readonly string[]).includes(b)) {
    const bucket = b as ListBucket
    if (typeof json.id !== 'string') throw new Error(`a ${b} edit without an id`)
    if (v !== null) {
      if (!isObject(v) || v.id !== json.id) throw new Error(`a ${b} item that is not its id's`)
      if (!isPage(PAGE[bucket].of(v as Entity))) throw new Error(`a ${b} item without a page`)
    }
    return { b: bucket, id: json.id, v: v as Json | null }
  }
  switch (b) {
    case 'formEdits':
    case 'formWidgetEdits':
      if (typeof json.k !== 'string' || !(v === null || isObject(v))) {
        throw new Error(`a malformed ${b} edit`)
      }
      return { b, k: json.k, v: v as Json | null }
    case 'rotations':
      if (!isPage(json.k) || !isTurn(v) || !isTurn(json.was))
        throw new Error('a malformed rotation')
      return { b, k: json.k, v, was: json.was }
    case 'deleted':
      if (!isPage(json.k) || typeof v !== 'boolean') throw new Error('a malformed page deletion')
      return { b, k: json.k, v }
    case 'order':
      if (!(v === null || isPages(v)) || !isPages(json.was)) throw new Error('a malformed order')
      return { b, v, was: json.was }
    case 'stampCfg':
    case 'metadata':
      if (!(v === null || isObject(v))) throw new Error(`a malformed ${b} edit`)
      return { b, v: v as Json | null }
    default:
      throw new Error(`an edit of unknown kind ${b}`)
  }
}

const isTurn = (v: unknown): v is number => Number.isInteger(v) && (v as number) % 90 === 0

/** JSON with object keys sorted and map and set entries in key order: equal states read equal */
export function canonical(value: unknown): string {
  return JSON.stringify(plain(value))
}

function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, plain(v)])
  }
  if (value instanceof Set) return [...value].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (Array.isArray(value)) return value.map(plain)
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = plain(value[key])
    }
    return out
  }
  return value
}

export const same = (a: unknown, b: unknown): boolean => a === b || canonical(a) === canonical(b)
