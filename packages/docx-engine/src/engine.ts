// The core of the binding: how an exported function of this package reaches
// the wasm engine (crates/office-wasm). The generated modules call `invoke`
// with the TypeScript arguments positionally; this file turns them into the
// `invoke` command and the reply back into what the TypeScript function
// returned. It never starts the engine (engine-init.ts and the `node` export
// condition do); it only refuses to call one that has not started.
import { engineCall, engineReady, type EngineCallback } from '@seuoffice/engine-wasm'
import { serializeXNode, type XNode } from './xml-utils'

/** Where a Map, a Set or a list of them sits in a reply: the manifest writes it from the declared return type. */
export interface Shape {
  /** map | set | arr | tuple | obj | rec */
  k: string
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
}

interface InvokeReply {
  value?: unknown
  warnings?: string[]
}

/** What one request carries besides its JSON: the blobs and the functions it may call back. */
interface Wire {
  blobs: Uint8Array[]
  /** callback name to slot */
  slots: Record<string, number>
  handlers: Record<number, EngineCallback>
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

export function ensureEngine(): void {
  if (!engineReady()) {
    throw new Error(
      'the docx engine is not started: await initDocxEngine(url) (a page or worker) or initDocxEngineSync(bytes) once before the first call; under the `node` export condition it starts itself',
    )
  }
}

function newWire(): Wire {
  return { blobs: [], slots: {}, handlers: {} }
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'function') {
    const slot = Object.keys(wire.handlers).length + 1
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
    for (const [name, inner] of Object.entries(value))
      if (inner !== undefined) out[name] = encode(inner, wire, name)
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

function base64Text(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
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
    return value.map((item) => revive(item, blobs, shape?.k === 'arr' ? shape.v : undefined, input))
  }
  const object = value as Record<string, unknown>
  if (isMarker(object, '$blob')) return blobs[object.$blob as number]
  if (isMarker(object, '$bytes')) return base64Bytes(object.$bytes as string)
  if (isMarker(object, '$input')) return input
  const out: Record<string, unknown> = {}
  for (const [name, inner] of Object.entries(object)) {
    out[name] = revive(
      inner,
      blobs,
      shape?.k === 'obj' ? shape.f?.[name] : shape?.k === 'rec' ? shape.v : undefined,
      input,
    )
  }
  return out
}

/** Where the engine reports a console.warn of the TypeScript, the host says it. */
function report(warnings: string[] | undefined): void {
  for (const message of warnings ?? []) console.warn(message)
}

/** A conversion only the host can do, owed by the engine to the call that asked for it. */
export interface Owed {
  id: string
  kind: 'metafile' | 'tiff' | 'altchunk'
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

/** One pass of an exported function of the package, with what the host has answered so far. */
export function invokeRaw(
  fn: string,
  args: readonly unknown[],
  options: InvokeOptions = {},
  answered?: Answered,
): Raw {
  ensureEngine()
  const wire = newWire()
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
    fn,
    args: encoded,
    nowMs: Date.now(),
    ...asked,
    ...(Object.keys(wire.slots).length ? { callbacks: wire.slots } : {}),
  }
  const reply = engineCall<InvokeReply & { pending?: Owed[] }>(
    header,
    [...wire.blobs, ...(answered?.blobs ?? [])],
    wire.handlers,
  )
  report(reply.header.warnings)
  const owed = reply.header.pending ?? []
  const value = reply.header.value === null && options.undef ? undefined : reply.header.value
  return {
    value: owed.length ? undefined : revive(value, reply.blobs, options.shape),
    owed,
    blobs: reply.blobs,
  }
}

/** One exported function of the package: the engine's answer to the TypeScript arguments. */
export function invoke(fn: string, args: readonly unknown[], options: InvokeOptions = {}): unknown {
  const raw = invokeRaw(fn, args, options)
  if (raw.owed.length)
    throw new Error(
      `${fn}: the engine owes the host a conversion; this export must run through the async binding`,
    )
  return raw.value
}

/** `invoke` for a function the TypeScript declares `async`: it resolves, or rejects with what the TypeScript threw. */
export async function invokeAsync(
  fn: string,
  args: readonly unknown[],
  options: InvokeOptions = {},
): Promise<unknown> {
  return invoke(fn, args, options)
}

/** A node argument as the engine reads it: the XML of the element, or null. */
export function xnodeArg(node: XNode | null | undefined): string | null {
  return node === undefined || node === null ? null : serializeXNode(node)
}

// ---------------------------------------------------------------- whole-document commands

/**
 * A model value as the engine's model reader takes it: a Map as its entries,
 * bytes as `{ "$bytes" }`, `internal.originalBytes` left to the docx blob.
 */
export function modelJson(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: Record<string, unknown>, key, inner: unknown): unknown {
      const original = this[key]
      if (original instanceof Map) return [...original.entries()]
      if (original instanceof Set) return [...original]
      const bytes = bytesOf(original)
      if (bytes) return { $bytes: key === 'originalBytes' ? '' : base64Text(bytes) }
      return inner
    },
  )
}

/** `modelJson`, parsed again: a value that goes in a header. */
export function jsonOf(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(modelJson(value))
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}
