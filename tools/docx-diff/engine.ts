// Node host of crates/office-wasm. The frame is described in its src/lib.rs.
import { readFileSync } from 'node:fs'
import { WASI } from 'node:wasi'
import { parseKeepingOrder } from './key-order'

const PROTOCOL_VERSION = 1

interface EngineExports {
  memory: WebAssembly.Memory
  seu_alloc(length: number): number
  seu_free(pointer: number, length: number): void
  seu_call(pointer: number, length: number): bigint
}

export interface EngineFailure {
  error: { code: string; message: string }
}

export interface Reply<Header> {
  header: Header | EngineFailure
  blobs: Uint8Array[]
}

export function failed(header: object): header is EngineFailure {
  return 'error' in header
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// the collators of generateIndexFieldXml's `a.localeCompare(b, locale)`, by locale;
// null for a locale Intl refuses, which the import answers with i32::MIN
const collators = new Map<string, Intl.Collator | null>()
const collatorOf = (locale: string): Intl.Collator | null => {
  if (!collators.has(locale)) {
    try {
      collators.set(locale, new Intl.Collator(locale))
    } catch {
      collators.set(locale, null)
    }
  }
  return collators.get(locale) ?? null
}

export class Engine {
  private constructor(private readonly exports: EngineExports) {}

  /**
   * `steps` answers callback slot 0 of the import `seu_host.host_callback`,
   * the steps of crates/seu-host: `{ name, input }` in, `{ ok }` or
   * `{ error: { name, message } }` out; a step that throws answers the latter.
   * Any other slot is refused, as the loader refuses a slot no call registered.
   */
  static load(wasmPath: string, steps: Record<string, (input: unknown) => unknown> = {}): Engine {
    const wasi = new WASI({ version: 'preview1' })
    const module = new WebAssembly.Module(readFileSync(wasmPath))
    const instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
      seu_host: {
        host_callback: (slot: number, pointer: number, length: number): bigint => {
          if (slot !== 0) return 0xffff_ffff_ffff_ffffn
          let answer: unknown
          try {
            const { name, input } = JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length))) as { name: string; input: unknown }
            const step = steps[name]
            if (step === undefined) throw Object.assign(new Error(`no host step ${name}`), { name: 'HostUnavailable' })
            answer = { ok: step(input) ?? null }
          } catch (error) {
            const thrown = error instanceof Error ? error : new Error(String(error))
            answer = { error: { name: thrown.name, message: thrown.message } }
          }
          const bytes = encoder.encode(JSON.stringify(answer))
          const at = exports.seu_alloc(bytes.length)
          // seu_alloc may have grown the memory: take the buffer after it
          new Uint8Array(exports.memory.buffer, at, bytes.length).set(bytes)
          return (BigInt(at) << 32n) | BigInt(bytes.length)
        },
        host_collate: (
          a: number,
          aLength: number,
          b: number,
          bLength: number,
          locale: number,
          localeLength: number,
        ): number => {
          const { buffer } = exports.memory
          const collator = collatorOf(decoder.decode(new Uint8Array(buffer, locale, localeLength)))
          if (!collator) return -2147483648
          return collator.compare(
            decoder.decode(new Uint8Array(buffer, a, aLength)),
            decoder.decode(new Uint8Array(buffer, b, bLength)),
          )
        },
      },
    })
    const exports = instance.exports as unknown as EngineExports
    wasi.initialize(instance)
    return new Engine(exports)
  }

  call<Header extends object>(command: object, blobs: Uint8Array[] = []): Reply<Header> {
    const header = encoder.encode(JSON.stringify({ version: PROTOCOL_VERSION, ...command }))
    const size = 8 + header.length + blobs.reduce((sum, blob) => sum + 4 + blob.length, 0)
    const { memory, seu_alloc, seu_call, seu_free } = this.exports

    const request = seu_alloc(size)
    const bytes = new Uint8Array(memory.buffer, request, size)
    const view = new DataView(memory.buffer, request, size)
    let offset = 0
    const put = (part: Uint8Array): void => {
      view.setUint32(offset, part.length, true)
      bytes.set(part, offset + 4)
      offset += 4 + part.length
    }
    put(header)
    view.setUint32(offset, blobs.length, true)
    offset += 4
    blobs.forEach(put)

    const packed = seu_call(request, size)
    seu_free(request, size)
    const pointer = Number(packed >> 32n)
    const length = Number(packed & 0xffff_ffffn)
    // the call may have grown the memory: take the buffer again
    const reply = new Uint8Array(memory.buffer, pointer, length).slice()
    seu_free(pointer, length)

    const replyView = new DataView(reply.buffer)
    let cursor = 0
    const take = (): Uint8Array => {
      const partLength = replyView.getUint32(cursor, true)
      const part = reply.subarray(cursor + 4, cursor + 4 + partLength)
      cursor += 4 + partLength
      return part
    }
    // not JSON.parse: the order Rust wrote the keys in is compared
    const replyHeader = parseKeepingOrder(decoder.decode(take())) as Header | EngineFailure
    const count = replyView.getUint32(cursor, true)
    cursor += 4
    return { header: replyHeader, blobs: Array.from({ length: count }, take) }
  }
}
