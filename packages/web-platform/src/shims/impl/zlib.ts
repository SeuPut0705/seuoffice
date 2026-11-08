import { Buffer } from 'buffer'
import {
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

/** zlib-wrapped deflate, like node:zlib */
export const deflateSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(zlibSync(bytes(input), level(options)))
export const inflateSync = (input: Input): Buffer => out(unzlibSync(bytes(input)))
export const deflateRawSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(fflateDeflateRaw(bytes(input), level(options)))
export const inflateRawSync = (input: Input): Buffer => out(fflateInflateRaw(bytes(input)))
export const gzipSync = (input: Input, options?: ZlibOptions): Buffer =>
  out(fflateGzip(bytes(input), level(options)))
export const gunzipSync = (input: Input): Buffer => out(fflateGunzip(bytes(input)))
/** gzip or zlib, detected from the header */
export const unzipSync = (input: Input): Buffer => out(decompressSync(bytes(input)))

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
