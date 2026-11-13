/**
 * The wire form of an IPC value, the TypeScript half of
 * crates/shell-core/src/wire.rs (the stage 3 shell contract, section 2): one
 * JSON header and the byte buffers it points at. Plain JSON stands for
 * itself; a tagged object (key `$`) stands for what JSON cannot hold:
 * `{"$":"u"}` undefined, `{"$":"b","k":"u8"|"ab","i":n}` bytes,
 * `{"$":"d","v":ms}` a date, `{"$":"n","v":"NaN"|"Infinity"|"-Infinity"|"-0"}`,
 * `{"$":"o","v":{…}}` an object with an own key `$`.
 *
 * A frame is the header's UTF-8 length (u32, little-endian), the header, the
 * buffer count (u32), then each buffer as its u32 length and bytes.
 */

/** What Electron's structured clone carries that the renderers use, and nothing else */
export class WireError extends Error {}

const tag = (kind: string, rest: Record<string, unknown> = {}): Record<string, unknown> => ({
  $: kind,
  ...rest,
})

function number(x: number): unknown {
  if (Number.isNaN(x)) return tag('n', { v: 'NaN' })
  if (x === Infinity) return tag('n', { v: 'Infinity' })
  if (x === -Infinity) return tag('n', { v: '-Infinity' })
  if (Object.is(x, -0)) return tag('n', { v: '-0' })
  return x
}

/** Collects the buffers of every value written through it, so a frame holding several values shares one list */
export class Encoder {
  readonly buffers: Uint8Array[] = []

  value(v: unknown): unknown {
    switch (typeof v) {
      case 'undefined':
        return tag('u')
      case 'boolean':
      case 'string':
        return v
      case 'number':
        return number(v)
      case 'object':
        break
      default:
        throw new WireError(`a ${typeof v} cannot cross the shell's IPC`)
    }
    if (v === null) return null
    if (v instanceof Uint8Array && v.constructor === Uint8Array) return this.bytes('u8', v)
    // a Node Buffer arrives as a Uint8Array, as Electron delivers it
    if (v instanceof Uint8Array) return this.bytes('u8', new Uint8Array(v))
    if (v instanceof ArrayBuffer) return this.bytes('ab', new Uint8Array(v))
    if (ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set) {
      throw new WireError(
        `a ${v.constructor.name} cannot cross the shell's IPC (a contract change)`,
      )
    }
    if (v instanceof Date) return tag('d', { v: number(v.getTime()) })
    if (Array.isArray(v)) return v.map((item) => this.value(item))
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v)) out[key] = this.value((v as Record<string, unknown>)[key])
    return Object.prototype.hasOwnProperty.call(v, '$') ? tag('o', { v: out }) : out
  }

  values(list: readonly unknown[]): unknown[] {
    return list.map((v) => this.value(v))
  }

  private bytes(kind: 'u8' | 'ab', bytes: Uint8Array): unknown {
    this.buffers.push(new Uint8Array(bytes))
    return tag('b', { k: kind, i: this.buffers.length - 1 })
  }
}

export function encode(v: unknown): { header: unknown; buffers: Uint8Array[] } {
  const e = new Encoder()
  const header = e.value(v)
  return { header, buffers: e.buffers }
}

function decodeNumber(h: unknown): number {
  if (typeof h === 'number') return h
  const t = h as Record<string, unknown> | null
  if (t && t.$ === 'n') {
    switch (t.v) {
      case 'NaN':
        return NaN
      case 'Infinity':
        return Infinity
      case '-Infinity':
        return -Infinity
      case '-0':
        return -0
    }
  }
  throw new WireError(`not a number: ${JSON.stringify(h)}`)
}

function decodeObject(o: Record<string, unknown>, buffers: Uint8Array[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(o)) out[key] = decode(o[key], buffers)
  return out
}

export function decode(h: unknown, buffers: Uint8Array[]): unknown {
  if (h === null || typeof h === 'boolean' || typeof h === 'number' || typeof h === 'string') {
    return h
  }
  if (Array.isArray(h)) return h.map((item) => decode(item, buffers))
  if (typeof h !== 'object') throw new WireError(`not a header: ${String(h)}`)
  const o = h as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(o, '$')) return decodeObject(o, buffers)
  switch (o.$) {
    case 'u':
      return undefined
    case 'n':
      return decodeNumber(o)
    case 'd':
      return new Date(decodeNumber(o.v))
    case 'b': {
      const bytes = typeof o.i === 'number' ? buffers[o.i] : undefined
      if (bytes === undefined) throw new WireError(`no buffer ${String(o.i)}`)
      if (o.k === 'u8') return new Uint8Array(bytes)
      if (o.k === 'ab') return new Uint8Array(bytes).buffer
      throw new WireError(`no such bytes kind: ${String(o.k)}`)
    }
    case 'o':
      if (o.v && typeof o.v === 'object' && !Array.isArray(o.v)) {
        return decodeObject(o.v as Record<string, unknown>, buffers)
      }
      throw new WireError('an escaped object without v')
    default:
      throw new WireError(`no such tag: ${JSON.stringify(o.$)}`)
  }
}

export function frame(header: unknown, buffers: readonly Uint8Array[]): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(header))
  const size = 8 + text.length + buffers.reduce((n, b) => n + 4 + b.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  const u32 = (n: number): void => {
    view.setUint32(at, n, true)
    at += 4
  }
  u32(text.length)
  out.set(text, at)
  at += text.length
  u32(buffers.length)
  for (const b of buffers) {
    u32(b.length)
    out.set(b, at)
    at += b.length
  }
  return out
}

export function unframe(bytes: Uint8Array): { header: unknown; buffers: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const take = (n: number): Uint8Array => {
    if (at + n > bytes.length) throw new WireError('a cut frame')
    const part = bytes.subarray(at, at + n)
    at += n
    return part
  }
  const u32 = (): number => {
    take(4)
    return view.getUint32(at - 4, true)
  }
  const header = JSON.parse(new TextDecoder().decode(take(u32()))) as unknown
  const count = u32()
  const buffers: Uint8Array[] = []
  for (let i = 0; i < count; i++) buffers.push(take(u32()).slice())
  if (at !== bytes.length) throw new WireError('bytes after the last buffer')
  return { header, buffers }
}
