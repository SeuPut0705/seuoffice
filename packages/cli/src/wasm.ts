import { readFileSync } from 'node:fs'
import { CliError, EXIT } from './result'

/**
 * WebAssembly is how the PDF and Hangul engines run, and the HTTP parser Node
 * uses for the network commands is one too. A WebAssembly memory reserves a
 * large virtual address range up front, so a sandbox that caps virtual memory
 * (`ulimit -v`, common in container images around 2 GB) cannot instantiate any
 * of them: the engine fails with a bare RangeError instead of doing its work.
 * These helpers keep that environment legible to a program:
 *
 * - `wasmAvailability` says whether the largest memory any engine asks for can
 *   be instantiated here, for `capabilities`.
 * - `wasmMemoryFailure` turns an engine's abort into a `resource_limit`
 *   envelope with the one action that fixes it, instead of a raw
 *   "Aborted(RangeError: ...)" message.
 */

/**
 * The message shapes an out-of-memory WebAssembly instantiation takes: V8's own
 * and the Emscripten abort that wraps it (pdfium, the Hangul engine).
 */
const WASM_MEMORY_FAILURE =
  /Cannot allocate Wasm memory|WebAssembly\.(?:instantiate|compile)[^\n]*Out of memory|Aborted\(RangeError[^\n]*WebAssembly/i

/** What the engines need: pdfium declares 2 GiB, the Hangul engine no maximum (4 GiB). */
const PROBE_MAX_PAGES = 65_536

function leb128(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest) byte |= 0x80
    out.push(byte)
  } while (rest)
  return out
}

/** A memory-only module: one memory, one page minimum, the largest maximum. */
function probeModule(): ArrayBuffer {
  const body = [0x01, 0x01, 0x01, ...leb128(PROBE_MAX_PAGES)]
  const bytes = Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x05,
    ...leb128(body.length),
    ...body,
  ])
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** The soft `ulimit -v` value in bytes, when the platform reports one (Linux). */
export function virtualMemoryLimitBytes(): number | undefined {
  try {
    const limits = readFileSync('/proc/self/limits', 'utf8')
    const match = /^Max virtual memory size\s+(\S+)\s+\S+\s+bytes$/m.exec(limits)
    if (!match || match[1] === 'unlimited') return undefined
    const bytes = Number(match[1])
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
  } catch {
    return undefined
  }
}

export interface WasmAvailability {
  available: boolean
  /** `virtual_memory` when the reservation did not fit, `unsupported` otherwise */
  reason?: 'virtual_memory' | 'unsupported'
  /** the soft `ulimit -v` the failure ran into, when the platform reports it */
  limit_bytes?: number
}

let cachedAvailability: WasmAvailability | undefined

/** Whether the biggest WebAssembly memory the engines need can be created here. */
export function wasmAvailability(): WasmAvailability {
  if (cachedAvailability) return cachedAvailability
  try {
    new WebAssembly.Instance(new WebAssembly.Module(probeModule()))
    cachedAvailability = { available: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const limit = virtualMemoryLimitBytes()
    cachedAvailability = {
      available: false,
      reason: /memory/i.test(message) ? 'virtual_memory' : 'unsupported',
      ...(limit ? { limit_bytes: limit } : {}),
    }
  }
  return cachedAvailability
}

/**
 * The `resource_limit` answer for an engine that ran out of WebAssembly memory,
 * or null for every other failure. Applied once, where the command line turns a
 * thrown error into the envelope, so each command keeps its own error handling.
 */
export function wasmMemoryFailure(err: unknown): CliError | null {
  if (err instanceof CliError && err.reason === 'resource_limit') return null
  const message = err instanceof Error ? err.message : String(err)
  if (!WASM_MEMORY_FAILURE.test(message)) return null
  const limit = virtualMemoryLimitBytes()
  return new CliError(
    EXIT.conversion,
    'This environment cannot allocate the memory the document engine needs (WebAssembly)',
    {
      reason: 'virtual_memory',
      ...(limit ? { limit_bytes: limit } : {}),
    },
    {
      reason: 'resource_limit',
      suggestion:
        'raise the virtual-memory limit (ulimit -v; the engines need about 12 GB of it) and run the command again',
    },
  )
}
