/**
 * A small zip writer for ODF packages, renderer-safe (no Node builtins).
 *
 * ODF packaging rules: the `mimetype` entry comes first, STORED (no
 * compression, no extra field), so a reader can sniff the media type at a
 * fixed offset. Entries the save did not touch are written from their
 * original compressed data (same method, same CRC), so their uncompressed
 * bytes cannot change; new and changed entries are deflated.
 */
import { streamBytes } from '@genoffice/zip-gate'
import type { OdtEntry } from '../core/package'

/** One entry to write. */
export type ZipEntryInput =
  /** an entry of the received package, copied as stored (`method` kept) */
  | { kind: 'original'; entry: OdtEntry }
  /** new or changed content */
  | { kind: 'data'; name: string; data: Uint8Array; store?: boolean; dosDateTime?: number }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  // `Blob.prototype.stream` is missing in jsdom; zip-gate's stream is not
  const stream = streamBytes(bytes).pipeThrough(
    new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
  )
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** MS-DOS date (high 16 bits) and time (low 16 bits) of a date, local time. */
export function dosDateTime(date: Date): number {
  const year = Math.max(1980, date.getFullYear())
  const d = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const t = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return ((d << 16) | t) >>> 0
}

interface Prepared {
  name: Uint8Array
  utf8: boolean
  method: number
  crc: number
  data: Uint8Array
  size: number
  dosDateTime: number
  directory: boolean
}

const encoder = new TextEncoder()

/** A name needs the UTF-8 flag. */
const nonAscii = (name: string) => [...name].some((c) => c.charCodeAt(0) > 0x7f)

async function prepare(input: ZipEntryInput, now: number): Promise<Prepared> {
  if (input.kind === 'original') {
    const e = input.entry
    const name = encoder.encode(e.name)
    return {
      name,
      utf8: nonAscii(e.name),
      method: e.method,
      crc: e.crc32,
      data: e.compressed,
      size: e.bytes.length,
      dosDateTime: e.dosDateTime,
      directory: e.directory,
    }
  }
  const name = encoder.encode(input.name)
  const directory = input.name.endsWith('/')
  const store = input.store || directory || input.data.length === 0
  return {
    name,
    utf8: nonAscii(input.name),
    method: store ? 0 : 8,
    crc: crc32(input.data),
    data: store ? input.data : await deflateRaw(input.data),
    size: input.data.length,
    dosDateTime: input.dosDateTime ?? now,
    directory,
  }
}

/** Writes a zip archive of the entries, in the given order. */
export async function writeZip(inputs: readonly ZipEntryInput[]): Promise<Uint8Array> {
  const now = dosDateTime(new Date())
  const entries: Prepared[] = []
  for (const input of inputs) entries.push(await prepare(input, now))
  let size = 22
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  const u16 = (v: number) => {
    view.setUint16(at, v & 0xffff, true)
    at += 2
  }
  const u32 = (v: number) => {
    view.setUint32(at, v >>> 0, true)
    at += 4
  }
  const offsets: number[] = []
  for (const e of entries) {
    offsets.push(at)
    u32(0x04034b50)
    u16(20)
    u16(e.utf8 ? 0x0800 : 0)
    u16(e.method)
    u16(e.dosDateTime & 0xffff)
    u16(e.dosDateTime >>> 16)
    u32(e.crc)
    u32(e.data.length)
    u32(e.size)
    u16(e.name.length)
    u16(0)
    out.set(e.name, at)
    at += e.name.length
    out.set(e.data, at)
    at += e.data.length
  }
  const cdStart = at
  entries.forEach((e, i) => {
    u32(0x02014b50)
    u16(20)
    u16(20)
    u16(e.utf8 ? 0x0800 : 0)
    u16(e.method)
    u16(e.dosDateTime & 0xffff)
    u16(e.dosDateTime >>> 16)
    u32(e.crc)
    u32(e.data.length)
    u32(e.size)
    u16(e.name.length)
    u16(0)
    u16(0)
    u16(0)
    u16(0)
    u32(e.directory ? 0x10 : 0)
    u32(offsets[i])
    out.set(e.name, at)
    at += e.name.length
  })
  const cdSize = at - cdStart
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(entries.length)
  u16(entries.length)
  u32(cdSize)
  u32(cdStart)
  u16(0)
  return out
}
