// The `invoke` command of crates/office-wasm, shared by the engine bindings:
// an exported TypeScript function reaches its Rust port by name with its
// arguments positionally. This file turns the TypeScript arguments into the
// command (bytes as request blobs, functions as callback slots, NaN and the
// infinities by their spelling) and the reply back into what the TypeScript
// function returned (Maps and Sets where `Shape` says, bytes from the reply
// blobs), and an engine refusal into the error the TypeScript threw.
import {
  EngineError,
  engineCall,
  type EngineCallback,
  type EngineReply,
} from './index'

/** Where a Map, a Set or a list of them sits in a reply: a binding's generator writes it from the declared return type. */
export interface Shape {
  /** map | set | arr | tuple | obj | rec */
  k: string
  /** an array whose holes are undefined: the reply writes them as null */
  u?: true
  v?: Shape
  items?: Array<Shape | null>
  f?: Record<string, Shape>
}

export interface InvokeOptions {
  /** the name of each argument, for the functions the engine calls back (`{"$cb": name}`) */
  names?: readonly string[]
  /** the reply holds Maps, Sets or lists of them at these places */
  shape?: Shape
  /** the TypeScript function returns undefined where Rust has no value: null becomes undefined */
  undef?: boolean
  /** prefixed to the name: the engine's table for this binding (`pptx.`, `fileParse.`; none for docx) */
  fnPrefix?: string
  /** callbacks of the host on slots of its own (slot 0 is reserved for them); the argument callbacks take 1 and up */
  extraCallbacks?: Readonly<Record<number, EngineCallback>>
  /**
   * A field of an argument object as it crosses: `undefined` leaves it out.
   * The binding's boundary rules for values its model types cannot hold.
   */
  field?: (holder: object, name: string, value: unknown) => unknown
}

/** A conversion only the host can do, owed by the engine to the call that asked for it. */
export interface Owed {
  id: string
  kind: string
  mime?: string
  /** the reply blob that holds the input */
  blob: number
}

/** What the host answered of the conversions an earlier pass owed: null, a string or bytes. */
export interface Answered {
  resolved: Record<string, string | null | { $blob: number }>
  /** the answers that are bytes, numbered from 0 after the arguments' blobs */
  blobs: Uint8Array[]
  altChunkConverter: boolean
}

export interface Raw {
  value: unknown
  owed: Owed[]
  /** the reply blobs, the inputs of what is owed among them */
  blobs: readonly Uint8Array[]
}

interface InvokeReply {
  value?: unknown
  pending?: Owed[]
  warnings?: string[]
}

/** What one request carries besides its JSON: the blobs and the functions it may call back. */
interface Wire {
  blobs: Uint8Array[]
  /** callback name to slot */
  slots: Record<string, number>
  handlers: Record<number, EngineCallback>
  field: InvokeOptions['field']
}

/** `record[key] = value` as an own entry, `__proto__` included (the own-value rule of the engines). */
function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__')
    Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
  else record[key] = value
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/** One argument as JSON; `key` names a function the engine may call back. */
function encode(value: unknown, wire: Wire, key: string): unknown {
  if (value === undefined || value === null) return null
  // JSON has no NaN and no infinity: they cross as their spelling (jscompat::js_f64 reads it)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'function') {
    let slot = 1
    while (slot in wire.handlers) slot++
    wire.slots[key] = slot
    const call = value as (...args: unknown[]) => unknown
    wire.handlers[slot] = (input) => {
      const answer = call(...(JSON.parse(input) as unknown[]))
      return JSON.stringify(answer === undefined ? null : answer)
    }
    return { $cb: key }
  }
  const bytes = bytesOf(value)
  if (bytes) {
    wire.blobs.push(bytes)
    return { $blob: wire.blobs.length - 1 }
  }
  if (value instanceof Date) return value.getTime()
  if (value instanceof Map)
    return [...value.entries()].map(([k, v]) => [encode(k, wire, key), encode(v, wire, key)])
  if (value instanceof Set) return [...value].map((item) => encode(item, wire, key))
  if (Array.isArray(value)) return value.map((item) => encode(item, wire, key))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [name, inner] of Object.entries(value)) {
      const kept = wire.field ? wire.field(value, name, inner) : inner
      if (kept !== undefined) setOwn(out, name, encode(kept, wire, name))
    }
    return out
  }
  return null
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function isMarker(value: object, key: string): boolean {
  return key in value && Object.keys(value).length === 1
}

/** A reply value as the TypeScript function returned it: Maps and Sets from `shape`, bytes from their blobs. */
export function revive(
  value: unknown,
  blobs: readonly Uint8Array[],
  shape: Shape | undefined,
  input?: Uint8Array,
): unknown {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) {
    if (shape?.k === 'map')
      return new Map(
        value.map((pair: unknown[]): [unknown, unknown] => [
          revive(pair[0], blobs, undefined, input),
          revive(pair[1], blobs, shape.v, input),
        ]),
      )
    if (shape?.k === 'set')
      return new Set(value.map((item) => revive(item, blobs, undefined, input)))
    if (shape?.k === 'tuple')
      return value.map((item, i) => revive(item, blobs, shape.items?.[i] ?? undefined, input))
    if (shape?.u)
      return value.map((item) => (item === null ? undefined : revive(item, blobs, shape.v, input)))
    return value.map((item) => revive(item, blobs, shape?.k === 'arr' ? shape.v : undefined, input))
  }
  const object = value as Record<string, unknown>
  if (isMarker(object, '$blob')) return blobs[object.$blob as number]
  if (isMarker(object, '$bytes')) return base64Bytes(object.$bytes as string)
  if (isMarker(object, '$input')) return input
  const out: Record<string, unknown> = {}
  for (const [name, inner] of Object.entries(object)) {
    const at = shape?.k === 'obj' ? shape.f?.[name] : shape?.k === 'rec' ? shape.v : undefined
    setOwn(out, name, revive(inner, blobs, at, input))
  }
  return out
}

/**
 * Bytes the engine answered, as the TypeScript answered them: the very input
 * array where the function gave its argument back unchanged (callers compare
 * by identity to learn that nothing changed).
 */
export function sameBytesAs(value: unknown, inputs: readonly Uint8Array[]): unknown {
  if (!(value instanceof Uint8Array)) return value
  for (const input of inputs) {
    if (input.length !== value.length) continue
    let i = 0
    while (i < input.length && input[i] === value[i]) i++
    if (i === input.length) return input
  }
  return value
}

const ERROR_CLASSES: Readonly<Record<string, new (message: string) => Error>> = {
  RangeError,
  TypeError,
  SyntaxError,
}

/**
 * The error the TypeScript threw where the engine refused: a port writes the
 * TypeScript's `Name: message`. RangeError, TypeError and SyntaxError come
 * back as those classes, any other name as an Error whose `name` it is, no
 * name as a plain Error. `a non-finite number: ` is the RangeError of the
 * docx engine's xml-number.ts, which writes its message without the name.
 */
export function engineErrorOf(error: EngineError): Error {
  const message = error.message
  if (message.startsWith('a non-finite number: ')) return new RangeError(message)
  const named = /^([A-Z][A-Za-z]*Error): /.exec(message)
  if (!named) return new Error(message)
  const name = named[1]!
  const rest = message.slice(named[0].length)
  const Class = Object.hasOwn(ERROR_CLASSES, name) ? ERROR_CLASSES[name]! : undefined
  if (Class) return new Class(rest)
  const out = new Error(rest)
  out.name = name
  return out
}

/** `engineCall`, throwing what the TypeScript threw where the engine refuses (`engineErrorOf`). */
export function callEngine<Header extends object>(
  command: object,
  blobs?: readonly Uint8Array[],
  callbacks?: Readonly<Record<number, EngineCallback>>,
): EngineReply<Header> {
  try {
    return engineCall<Header>(command, blobs, callbacks)
  } catch (error) {
    throw error instanceof EngineError ? engineErrorOf(error) : error
  }
}

/** One pass of an exported function, with what the host has answered so far of the conversions it owes. */
export function engineInvokeRaw(
  fn: string,
  args: readonly unknown[],
  options: InvokeOptions = {},
  answered?: Answered,
): Raw {
  const wire: Wire = { blobs: [], slots: {}, handlers: { ...options.extraCallbacks }, field: options.field }
  const encoded = args.map((arg, i) => encode(arg, wire, options.names?.[i] ?? ''))
  // an answer that is bytes names its place after the blobs of the arguments
  const shifted = (entry: string | null | { $blob: number }): string | null | { $blob: number } =>
    entry !== null && typeof entry === 'object' ? { $blob: entry.$blob + wire.blobs.length } : entry
  const asked = answered
    ? {
        resolved: Object.fromEntries(
          Object.entries(answered.resolved).map(([id, entry]) => [id, shifted(entry)]),
        ),
        altChunkConverter: answered.altChunkConverter,
      }
    : {}
  const header = {
    cmd: 'invoke',
    fn: `${options.fnPrefix ?? ''}${fn}`,
    args: encoded,
    nowMs: Date.now(),
    ...asked,
    ...(Object.keys(wire.slots).length ? { callbacks: wire.slots } : {}),
  }
  const reply = callEngine<InvokeReply>(
    header,
    [...wire.blobs, ...(answered?.blobs ?? [])],
    wire.handlers,
  )
  // a console.warn of the TypeScript comes back as a warning: the host says it
  for (const message of reply.header.warnings ?? []) console.warn(message)
  const owed = reply.header.pending ?? []
  const value = reply.header.value === null && options.undef ? undefined : reply.header.value
  return {
    value: owed.length
      ? undefined
      : sameBytesAs(revive(value, reply.blobs, options.shape), wire.blobs),
    owed,
    blobs: reply.blobs,
  }
}

/** One exported function: the engine's answer to the TypeScript arguments. Throws where it owes the host a conversion. */
export function engineInvoke(
  fn: string,
  args: readonly unknown[],
  options: InvokeOptions = {},
): unknown {
  const raw = engineInvokeRaw(fn, args, options)
  if (raw.owed.length)
    throw new Error(
      `${fn}: the engine owes the host a conversion; this export must run through the async binding`,
    )
  return raw.value
}
