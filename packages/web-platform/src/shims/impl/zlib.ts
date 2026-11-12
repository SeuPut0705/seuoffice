import { Buffer } from 'buffer'
import {
  Gunzip,
  Inflate,
  Unzlib,
  decompressSync,
  deflateSync as fflateDeflateRaw,
  gunzipSync as fflateGunzip,
  gzipSync as fflateGzip,
  inflateSync as fflateInflateRaw,
  unzlibSync,
  zlibSync,
} from 'fflate'

type Input = string | ArrayBuffer | ArrayBufferView
type DeflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

interface ZlibOptions {
  level?: number
}

/** The option of node's inflate calls the desktop code bounds a file's output with. */
interface InflateOptions {
  maxOutputLength?: number
}

/** What fflate's stream decoders (Inflate, Unzlib, Gunzip) have in common. */
type Decoder = new (ondata: (chunk: Uint8Array) => void) => {
  push(chunk: Uint8Array, final?: boolean): void
}

/**
 * Compressed bytes the decoder gets at a time while the output has a limit. Deflate expands
 * about a thousand to one at most, so the decoder is stopped about a mebibyte past the
 * limit at worst, whatever the whole input would inflate to.
 */
const BOUNDED_STEP_BYTES = 1024

function bytes(input: Input): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function level(options?: ZlibOptions): { level?: DeflateLevel } {
  const value = options?.level
  if (value === undefined || value < 0) return {}
  return { level: Math.min(9, value) as DeflateLevel }
}

const out = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength)

/** The decoder fflate's decompressSync picks for these bytes: gzip, zlib, else bare deflate. */
function decoderOf(data: Uint8Array): Decoder {
  const [first = 0, second = 0, third = 0] = data
  if (first === 31 && second === 139 && third === 8) return Gunzip
  const zlibHeader = (first & 15) === 8 && first >> 4 <= 7 && ((first << 8) | second) % 31 === 0
  return zlibHeader ? Unzlib : Inflate
}

/**
 * The inflated bytes. Without `maxOutputLength` the whole output in one go. With it, like
 * node: output of that length at most, and for a stream that holds more the error node
 * throws (a RangeError with the code ERR_BUFFER_TOO_LARGE), thrown when the output passes
 * the limit and not after the rest was inflated.
 */
function inflateWith(
  decoder: (data: Uint8Array) => Decoder,
  whole: (data: Uint8Array) => Uint8Array,
  input: Input,
  options?: InflateOptions,
): Buffer {
  const data = bytes(input)
  const limit = options?.maxOutputLength
  if (typeof limit !== 'number' || Number.isNaN(limit)) return out(whole(data))
  const chunks: Uint8Array[] = []
  let total = 0
  const Stream = decoder(data)
  const stream = new Stream((chunk) => {
    total += chunk.length
    if (total > limit) {
      throw Object.assign(new RangeError(`Cannot create a Buffer larger than ${limit} bytes`), {
        code: 'ERR_BUFFER_TOO_LARGE',
      })
    }
    chunks.push(chunk)
  })
  for (let at = 0; ; at += BOUNDED_STEP_BYTES) {
    const final = at + BOUNDED_STEP_BYTES >= data.length
    stream.push(data.subarray(at, at + BOUNDED_STEP_BYTES), final)
    if (final) break
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return out(joined)
}

/** zlib-wrapped deflate, like node:zlib */
export const deflateSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(zlibSync(bytes(input), level(options)))
export const inflateSync = (input: Input, options?: InflateOptions): Buffer =>
  inflateWith(() => Unzlib, unzlibSync, input, options)
export const deflateRawSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(fflateDeflateRaw(bytes(input), level(options)))
export const inflateRawSync = (input: Input, options?: InflateOptions): Buffer =>
  inflateWith(() => Inflate, fflateInflateRaw, input, options)
export const gzipSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(fflateGzip(bytes(input), level(options)))
export const gunzipSync = (input: Input, options?: InflateOptions): Buffer =>
  inflateWith(() => Gunzip, fflateGunzip, input, options)
/** gzip or zlib, detected from the header */
export const unzipSync = (input: Input, options?: InflateOptions): Buffer =>
  inflateWith(decoderOf, decompressSync, input, options)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE), continuing from `value` like node:zlib crc32 */
export function crc32(data: Input, value = 0): number {
  const input = bytes(data)
  let crc = (value ^ 0xffffffff) >>> 0
  for (let i = 0; i < input.length; i++) crc = CRC_TABLE[(crc ^ input[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
