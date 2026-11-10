/**
 * Two toy editors for the package's own tests. Each keeps the confirmed state
 * apart from what it shows; on `integrate` it applies `remote` to the
 * confirmed state, rewrites `local` past it and recomputes the view, so any
 * mistake the engine makes in what it calls local or confirmed shows up as a
 * fingerprint that differs from the log's.
 */

import type { Format, Json } from '../model.js'
import type { SimulatedEditor } from './network.js'

export interface ToyEditor<Op> extends SimulatedEditor<Op> {
  /** make exactly this local edit, editable or not */
  perform(op: Op): void
  readonly editable: boolean
}

export interface Toy<Op> {
  format: Format
  /** the bytes of an untouched document */
  file(): Uint8Array
  open(bytes: Uint8Array): ToyEditor<Op>
}

interface ToySpec<State, Op> {
  format: Format
  initial: State
  serialize(state: State): string
  parse(text: string): State
  /** throws when `op` does not fit `state` */
  apply(state: State, op: Op): State
  /** `local` rewritten to apply after `remote` */
  transform(local: Op[], remote: Op[]): Op[]
  random(state: State, random: () => number, id: string): Op | null
  decode(json: Json): Op
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toy<State, Op extends { id: string }>(spec: ToySpec<State, Op>): Toy<Op> {
  return {
    format: spec.format,
    file: () => encoder.encode(spec.serialize(spec.initial)),
    open(bytes) {
      let confirmedState = spec.parse(decoder.decode(bytes))
      let view = confirmedState
      let editable = true
      let emit: ((ops: Op[]) => void) | null = null

      function local(op: Op): void {
        view = spec.apply(view, op)
        emit?.([op])
      }

      return {
        get editable() {
          return editable
        },
        encode: (op) => op as unknown as Json,
        decode: spec.decode,
        listen(handler) {
          emit = handler
          return () => {
            emit = null
          }
        },
        integrate(remote, pending) {
          confirmedState = remote.reduce(spec.apply, confirmedState)
          const rebased = spec.transform(pending, remote)
          view = rebased.reduce(spec.apply, confirmedState)
          return rebased
        },
        confirmed(ops) {
          confirmedState = ops.reduce(spec.apply, confirmedState)
        },
        fingerprint: () => hash(spec.serialize(view)),
        setEditable(value) {
          editable = value
        },
        produceFile: async () => ({
          fileName: 'toy.json',
          bytes: encoder.encode(spec.serialize(view)),
        }),
        perform: local,
        edit(random, id) {
          if (!editable || !emit) return false
          const op = spec.random(view, random, id)
          if (!op) return false
          local(op)
          return true
        },
        opKey: (json) => spec.decode(json).id,
      }
    },
  }
}

function fields(json: Json): Record<string, Json> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('not an op')
  return json
}

function index(json: Json | undefined): number {
  if (typeof json !== 'number' || !Number.isSafeInteger(json) || json < 0)
    throw new Error('not an index')
  return json
}

function name(json: Json | undefined): string {
  if (typeof json !== 'string') throw new Error('not a string')
  return json
}

/** Set or delete (`value` null) one key; the later write wins, so `local` needs no rewriting */
export interface MapOp {
  id: string
  key: string
  value: number | null
}

const KEYS = 'abcde'

export const toyMap: Toy<MapOp> = toy<Record<string, number>, MapOp>({
  format: { name: 'toy-map', schema: 1 },
  initial: {},
  serialize: (state) =>
    JSON.stringify(
      Object.keys(state)
        .sort()
        .map((key) => [key, state[key]]),
    ),
  parse: (text) => Object.fromEntries(JSON.parse(text) as [string, number][]),
  apply(state, op) {
    const next = { ...state }
    if (op.value === null) delete next[op.key]
    else next[op.key] = op.value
    return next
  },
  transform: (local) => local,
  random: (_state, random, id) => ({
    id,
    key: KEYS.charAt(Math.floor(random() * KEYS.length)),
    value: random() < 0.2 ? null : Math.floor(random() * 100),
  }),
  decode(json) {
    const f = fields(json)
    if (f.value !== null && typeof f.value !== 'number') throw new Error('not a value')
    return { id: name(f.id), key: name(f.key), value: f.value }
  },
})

/** Insert a line before index `at`, or delete the line at `at`; null when it was already gone */
export type LineOp =
  { id: string; t: 'ins'; at: number; text: string } | { id: string; t: 'del'; at: number | null }

/** `l` past `r`, and `r` past `l`; when both insert at one index the remote line comes first */
function pass(l: LineOp, r: LineOp): [LineOp, LineOp] {
  if (l.at === null || r.at === null) return [l, r]
  if (r.t === 'ins') {
    if (l.t === 'ins')
      return r.at <= l.at ? [{ ...l, at: l.at + 1 }, r] : [l, { ...r, at: r.at + 1 }]
    return r.at <= l.at ? [{ ...l, at: l.at + 1 }, r] : [l, { ...r, at: r.at - 1 }]
  }
  if (l.t === 'ins') return l.at > r.at ? [{ ...l, at: l.at - 1 }, r] : [l, { ...r, at: r.at + 1 }]
  if (l.at === r.at)
    return [
      { ...l, at: null },
      { ...r, at: null },
    ]
  return l.at > r.at ? [{ ...l, at: l.at - 1 }, r] : [l, { ...r, at: r.at - 1 }]
}

export const toyLines: Toy<LineOp> = toy<string[], LineOp>({
  format: { name: 'toy-lines', schema: 1 },
  initial: ['one', 'two', 'three'],
  serialize: (state) => JSON.stringify(state),
  parse: (text) => JSON.parse(text) as string[],
  apply(state, op) {
    if (op.t === 'ins') {
      if (op.at > state.length) throw new Error(`insert at ${op.at} past ${state.length} lines`)
      return [...state.slice(0, op.at), op.text, ...state.slice(op.at)]
    }
    if (op.at === null) return state
    if (op.at >= state.length) throw new Error(`delete at ${op.at} past ${state.length} lines`)
    return [...state.slice(0, op.at), ...state.slice(op.at + 1)]
  },
  transform(local, remote) {
    let rebased = local
    for (const r of remote) {
      let incoming = r
      rebased = rebased.map((l) => {
        const [moved, past] = pass(l, incoming)
        incoming = past
        return moved
      })
    }
    return rebased
  },
  random(state, random, id) {
    if (state.length > 0 && random() < 0.35)
      return { id, t: 'del', at: Math.floor(random() * state.length) }
    return { id, t: 'ins', at: Math.floor(random() * (state.length + 1)), text: id }
  },
  decode(json) {
    const f = fields(json)
    if (f.t === 'ins') return { id: name(f.id), t: 'ins', at: index(f.at), text: name(f.text) }
    if (f.t === 'del') return { id: name(f.id), t: 'del', at: f.at === null ? null : index(f.at) }
    throw new Error('not a line op')
  },
})

/** A 64-bit string hash (cyrb53 widened); a toy needs a stable digest, not a secure one */
function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}
