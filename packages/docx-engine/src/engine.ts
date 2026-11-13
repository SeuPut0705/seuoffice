// The docx side of the binding: how an exported function of this package
// reaches the wasm engine (crates/office-wasm). The generated modules call
// `invoke` with the TypeScript arguments positionally; the codec is the shared
// one of @seuoffice/engine-wasm, with this package's boundary rule for
// `Run.wrap`. It never starts the engine (engine-init.ts and the `node` export
// condition do); it only refuses to call one that has not started.
import {
  engineInvokeRaw,
  engineReady,
  type Answered,
  type InvokeOptions,
  type Raw,
} from '@seuoffice/engine-wasm'
import { serializeXNode, type XNode } from './xml-utils'

export {
  callEngine,
  revive,
  sameBytesAs,
  type Answered,
  type InvokeOptions,
  type Owed,
  type Raw,
  type Shape,
} from '@seuoffice/engine-wasm'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

export function ensureEngine(): void {
  if (!engineReady()) {
    throw new Error(
      'the docx engine is not started: await initDocxEngine(url) (a page or worker) or initDocxEngineSync(bytes) once before the first call; under the `node` export condition it starts itself',
    )
  }
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function base64Text(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** `Run.wrap` as it crosses: a list that is no list is no wrapper, and only usable entries go. */
function runWrapField(holder: object, name: string, value: unknown): unknown {
  if (name !== 'wrap' || !('text' in holder) || typeof holder.text !== 'string') return value
  return Array.isArray(value) ? value.filter(isInlineWrapShape) : undefined
}

/** One pass of an exported function of the package, with what the host has answered so far. */
export function invokeRaw(
  fn: string,
  args: readonly unknown[],
  options: InvokeOptions = {},
  answered?: Answered,
): Raw {
  ensureEngine()
  return engineInvokeRaw(fn, args, { ...options, field: runWrapField }, answered)
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

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const wellFormed = (text: unknown): boolean =>
  typeof text === 'string' && !LONE_SURROGATE.test(text)

/**
 * An entry of `Run.wrap` the engine's model can hold: the TypeScript skipped
 * any other (`isInlineWrapShape` of inline-opaque.ts) and wrote the text
 * without it; a typed model cannot hold it, and a string with half a
 * surrogate pair cannot cross JSON. So the boundary leaves such entries out.
 */
function isInlineWrapShape(wrap: unknown): boolean {
  if (typeof wrap !== 'object' || wrap === null) return false
  const { seq, open, close, inside, text } = wrap as Record<string, unknown>
  return (
    typeof seq === 'number' &&
    Number.isFinite(seq) &&
    wellFormed(open) &&
    wellFormed(close) &&
    (inside === undefined || inside === 'revision' || inside === 'link') &&
    (text === undefined || wellFormed(text))
  )
}

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
      const wrap = key === 'wrap' ? runWrapField(this, key, original) : original
      if (wrap !== original) return wrap
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
