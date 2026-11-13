// The one loader of the Rust engines' WASM build (crates/office-wasm), shared
// by every engine binding (@seuoffice/pptx-engine, @seuoffice/docx-engine).
// Host-agnostic: no Node built-in and no browser API beyond WebAssembly,
// TextEncoder, TextDecoder, Intl and crypto.getRandomValues, so the same code
// runs in Electron main, Node tools and the web page.
//
// Startup points instantiate once: `initEngineSync(bytes)` where the bytes
// are at hand (Node, Electron main), `await initEngine(source)` in a browser
// before the editor mounts. Every call after that is synchronous.
//
// The frame of `seu_call` (crates/office-wasm/src/lib.rs): request and reply
// are `u32 header length | header JSON | u32 blob count | (u32 length | bytes)*`,
// little endian. A header is `{ version: 1, cmd, ... }`; a failure answers
// `{ error: { code, message } }`.

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

export interface EngineReply<Header> {
  header: Header
  blobs: Uint8Array[]
}

/** What `engineCall` throws when the engine answers with a failure. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// generateIndexFieldXml sorts index entries with `a.localeCompare(b, locale)`:
// one collator per locale, made on first use
const collators = new Map<string, Intl.Collator>()

/** What `host_collate` answers where `new Intl.Collator(locale)` throws: the engine refuses the call. */
const COLLATE_REFUSED = -2_147_483_648

function collatorFor(locale: string): Intl.Collator | null {
  let collator = collators.get(locale)
  if (!collator) {
    try {
      collator = new Intl.Collator(locale)
    } catch {
      return null
    }
    collators.set(locale, collator)
  }
  return collator
}

/** errno of WASI preview 1 */
const ERRNO_SUCCESS = 0
const ERRNO_BADF = 8

/**
 * The WASI imports the engine uses, and nothing else: it reads no file and no
 * argument. `fd_write` takes what Rust prints on a panic (stdout and stderr)
 * to the console; `proc_exit` throws, since a reactor never exits on purpose.
 * `clock_time_get` is there for the HWP reader (rhwp), which reads the clock
 * in places; the document readers themselves take their time from the host.
 */
function wasiImports(memory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  const view = (): DataView => new DataView(memory().buffer)
  let pending = ''
  return {
    random_get(pointer: number, length: number): number {
      const bytes = new Uint8Array(memory().buffer, pointer, length)
      // getRandomValues takes at most 65,536 bytes at a time
      for (let at = 0; at < length; at += 65_536) {
        crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + 65_536)))
      }
      return ERRNO_SUCCESS
    },
    environ_sizes_get(countOut: number, sizeOut: number): number {
      view().setUint32(countOut, 0, true)
      view().setUint32(sizeOut, 0, true)
      return ERRNO_SUCCESS
    },
    environ_get(): number {
      return ERRNO_SUCCESS
    },
    // clock 0 is the wall clock, the others count from a fixed point (monotonic, CPU time)
    clock_time_get(id: number, _precision: bigint, timeOut: number): number {
      const milliseconds = id === 0 ? Date.now() : performance.now()
      view().setBigUint64(timeOut, BigInt(Math.round(milliseconds * 1e6)), true)
      return ERRNO_SUCCESS
    },
    fd_write(fd: number, iovs: number, iovsLength: number, writtenOut: number): number {
      if (fd !== 1 && fd !== 2) return ERRNO_BADF
      const data = view()
      let written = 0
      for (let i = 0; i < iovsLength; i++) {
        const pointer = data.getUint32(iovs + i * 8, true)
        const length = data.getUint32(iovs + i * 8 + 4, true)
        pending += new TextDecoder().decode(new Uint8Array(memory().buffer, pointer, length))
        written += length
      }
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) console.error(`office-wasm: ${line}`)
      data.setUint32(writtenOut, written, true)
      return ERRNO_SUCCESS
    },
    proc_exit(code: number): never {
      throw new Error(`office-wasm exited with code ${code}`)
    },
  }
}

let engine: EngineExports | null = null

/** A function the engine may call back during one `engineCall`: text in, text out. */
export type EngineCallback = (input: string) => string

/** What `host_callback` answers where the engine must refuse the call. */
const CALLBACK_REFUSED = 0xffff_ffff_ffff_ffffn

// the callbacks of each running call, innermost last: a callback may itself
// call the engine, and its own call's callbacks are then the ones in force
const activeCallbacks: Array<Readonly<Record<number, EngineCallback>>> = []
// what a callback threw during the running call, rethrown once it returns
const callbackErrors: unknown[] = []

function imports(): WebAssembly.Imports {
  const memory = (): WebAssembly.Memory => {
    if (!engine) throw new Error('office-wasm: memory read before the instance exists')
    return engine.memory
  }
  return {
    wasi_snapshot_preview1: wasiImports(memory),
    seu_host: {
      // `(a, b, locale)` as three UTF-8 strings; a build from before the
      // locale argument passes four arguments and means 'zh-CN'
      host_collate(
        a: number,
        aLength: number,
        b: number,
        bLength: number,
        locale?: number,
        localeLength?: number,
      ): number {
        const { buffer } = memory()
        const name =
          locale === undefined || localeLength === undefined
            ? 'zh-CN'
            : decoder.decode(new Uint8Array(buffer, locale, localeLength))
        const collator = collatorFor(name)
        if (!collator) return COLLATE_REFUSED
        return collator.compare(
          decoder.decode(new Uint8Array(buffer, a, aLength)),
          decoder.decode(new Uint8Array(buffer, b, bLength)),
        )
      },
      // A JS function the engine calls back during `seu_call`: the callback
      // registered under `slot` for the running call gets the UTF-8 text at
      // `pointer`, `length` and answers text. The answer goes back in memory
      // the engine allocates (`seu_alloc`), packed as `(pointer << 32) | length`,
      // and the engine frees it. CALLBACK_REFUSED where there is no such
      // callback or it threw: the engine refuses the call.
      host_callback(slot: number, pointer: number, length: number): bigint {
        const callback = activeCallbacks[activeCallbacks.length - 1]?.[slot]
        if (!callback || !engine) return CALLBACK_REFUSED
        let answer: Uint8Array
        try {
          const input = decoder.decode(new Uint8Array(memory().buffer, pointer, length))
          answer = encoder.encode(callback(input))
        } catch (error) {
          callbackErrors.push(error)
          return CALLBACK_REFUSED
        }
        const at = engine.seu_alloc(answer.length)
        // seu_alloc may have grown the memory: take the buffer after it
        new Uint8Array(memory().buffer, at, answer.length).set(answer)
        return (BigInt(at) << 32n) | BigInt(answer.length)
      },
    },
  }
}

function adopt(instance: WebAssembly.Instance): void {
  engine = instance.exports as unknown as EngineExports
}

/** Instantiate the engine from its bytes, synchronously. A second call does nothing. */
export function initEngineSync(bytes: BufferSource): void {
  if (engine) return
  adopt(new WebAssembly.Instance(new WebAssembly.Module(bytes), imports()))
}

/**
 * Instantiate the engine from a URL, a fetch response or its bytes. Await it
 * once before the first call. A second call does nothing.
 */
export async function initEngine(source: string | URL | Response | BufferSource): Promise<void> {
  if (engine) return
  if (typeof source === 'string' || source instanceof URL) {
    source = await fetch(source)
  }
  if (source instanceof Response) {
    const response = source
    try {
      const { instance } = await WebAssembly.instantiateStreaming(response.clone(), imports())
      if (!engine) adopt(instance)
      return
    } catch {
      // a server that does not answer application/wasm: compile the bytes instead
      source = await response.arrayBuffer()
    }
  }
  const { instance } = await WebAssembly.instantiate(source, imports())
  if (!engine) adopt(instance)
}

/** Whether `initEngine` or `initEngineSync` has run. */
export function engineReady(): boolean {
  return engine !== null
}

/** The UTF-8 length of `text`: what `TextEncoder.encodeInto` writes for it. */
function utf8Length(text: string): number {
  let length = text.length
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) continue
    // two bytes below U+0800; three for the rest of the plane and for a lone
    // surrogate (written as U+FFFD); a pair is four bytes for its two units
    length += unit < 0x800 ? 1 : 2
    if (unit >= 0xd800 && unit < 0xdc00) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next < 0xe000) i++
    }
  }
  return length
}

/**
 * One command: `command` is the header without `version`, `blobs` what goes
 * beside it, bytes or a text (written as UTF-8 straight into the engine's
 * memory, without a copy of its own), `callbacks` the functions the engine
 * may call back by slot during this call (`seu_host.host_callback`). Throws
 * `EngineError` where the engine answers a failure, and rethrows what a
 * callback threw.
 */
export function engineCall<Header extends object>(
  command: object,
  blobs: readonly (Uint8Array | string)[] = [],
  callbacks: Readonly<Record<number, EngineCallback>> = {},
): EngineReply<Header> {
  if (!engine) throw new Error('office-wasm: call initEngine or initEngineSync first')
  const { memory, seu_alloc, seu_call, seu_free } = engine
  const header = encoder.encode(JSON.stringify({ version: PROTOCOL_VERSION, ...command }))
  const lengths = blobs.map((blob) => (typeof blob === 'string' ? utf8Length(blob) : blob.length))
  const size = 8 + header.length + lengths.reduce((sum, length) => sum + 4 + length, 0)

  const request = seu_alloc(size)
  const bytes = new Uint8Array(memory.buffer, request, size)
  const view = new DataView(memory.buffer, request, size)
  let offset = 0
  const put = (part: Uint8Array | string, length: number): void => {
    view.setUint32(offset, length, true)
    if (typeof part === 'string')
      encoder.encodeInto(part, bytes.subarray(offset + 4, offset + 4 + length))
    else bytes.set(part, offset + 4)
    offset += 4 + length
  }
  put(header, header.length)
  view.setUint32(offset, blobs.length, true)
  offset += 4
  blobs.forEach((blob, i) => put(blob, lengths[i]!))

  activeCallbacks.push(callbacks)
  const errorsBefore = callbackErrors.length
  let packed: bigint
  try {
    packed = seu_call(request, size)
  } finally {
    activeCallbacks.pop()
  }
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
  const replyHeader = JSON.parse(decoder.decode(take())) as Header | EngineFailure
  const thrown = callbackErrors.splice(errorsBefore)
  if (thrown.length > 0) throw thrown[0]
  if ('error' in replyHeader) {
    throw new EngineError(replyHeader.error.code, replyHeader.error.message)
  }
  const count = replyView.getUint32(cursor, true)
  cursor += 4
  return { header: replyHeader, blobs: Array.from({ length: count }, take) }
}

export * from './invoke'
