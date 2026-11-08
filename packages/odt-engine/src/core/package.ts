/**
 * Lenient ODT package reader.
 *
 * Hancom writes `mimetype` after other entries and deflates it, which the ODF
 * packaging rules forbid; this reader accepts any order and either method.
 * It reads the archive itself (rather than through JSZip) to keep what a later
 * re-pack needs: each entry's exact uncompressed bytes, its original method
 * and the original physical order. Before anything is inflated the archive
 * passes the same metered zip-bomb gate as the docx engine.
 *
 * Renderer-safe: no Node builtins.
 */
import {
  DEFAULT_ZIP_LIMITS,
  assertZipInflatesWithinLimits,
  decompressionStream,
  streamBytes,
  type ZipLimits,
} from '@genoffice/zip-gate'
import { OdtOpenError } from './errors'

/** Same caps as the docx engine's `DOCX_ZIP_LIMITS` (10,000 parts, 512 MiB per part, 1.5 GiB total). */
export const ODT_ZIP_LIMITS: ZipLimits = DEFAULT_ZIP_LIMITS

export const ODT_TEXT_MEDIA_TYPE = 'application/vnd.oasis.opendocument.text'

export interface OdtEntry {
  /** entry path as stored (UTF-8 decoded) */
  name: string
  /** `true` for directory entries (name ends with `/`) */
  directory: boolean
  /** original compression method: 0 stored, 8 deflated */
  method: number
  /** the entry's original uncompressed bytes */
  bytes: Uint8Array
  /** a view of the entry's original compressed data inside the archive */
  compressed: Uint8Array
  /** CRC-32 from the central directory */
  crc32: number
  /** MS-DOS date (high 16 bits) and time (low 16 bits) as stored */
  dosDateTime: number
  /** offset of the local header (physical order) */
  offset: number
}

export interface OdtPackage {
  /** the archive as received */
  readonly originalBytes: Uint8Array
  /** every entry in original physical order */
  readonly entries: readonly OdtEntry[]
  /** trimmed content of the `mimetype` entry, or the manifest root media type if the entry is missing */
  readonly mimetype: string | null
  /** whether `mimetype` is the first entry (the ODF rule; Hancom breaks it) */
  readonly mimetypeFirst: boolean
  /** whether `mimetype` is stored uncompressed (the ODF rule; Hancom breaks it) */
  readonly mimetypeStored: boolean
  get(name: string): OdtEntry | undefined
  /**
   * The entry decoded as UTF-8 with any byte order mark KEPT (as U+FEFF), so
   * offsets index the same characters a re-encode writes back. Cached.
   */
  text(name: string): string | undefined
}

export interface ReadOdtPackageOptions {
  /** zip gate limits; default `ODT_ZIP_LIMITS` */
  limits?: ZipLimits
}

/**
 * Reads the archive after the zip gate. Throws `OdtOpenError` with code
 * `zip-rejected` (gate) or `corrupt` (not a readable zip). Does not check the
 * media type or encryption; `openOdt` does.
 */
export async function readOdtPackage(
  bytes: Uint8Array,
  options: ReadOdtPackageOptions = {},
): Promise<OdtPackage> {
  try {
    await assertZipInflatesWithinLimits(bytes, options.limits ?? ODT_ZIP_LIMITS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = message.startsWith('zip rejected:') ? 'zip-rejected' : 'corrupt'
    throw new OdtOpenError(code, message, { cause: err })
  }
  let records: CentralRecord[]
  try {
    records = readCentralDirectory(bytes)
  } catch (err) {
    throw new OdtOpenError('corrupt', err instanceof Error ? err.message : String(err), {
      cause: err,
    })
  }
  const entries: OdtEntry[] = []
  for (const record of records) {
    let data: Uint8Array
    try {
      data = record.directory ? new Uint8Array(0) : await inflateEntry(record)
    } catch (err) {
      throw new OdtOpenError(
        'corrupt',
        `odt: entry ${record.name} cannot be read: ${err instanceof Error ? err.message || err.name : String(err)}`,
        { cause: err },
      )
    }
    entries.push({
      name: record.name,
      directory: record.directory,
      method: record.method,
      bytes: data,
      compressed: record.compressed,
      crc32: record.crc32,
      dosDateTime: record.dosDateTime,
      offset: record.offset,
    })
  }
  return createPackage(bytes, entries)
}

function createPackage(originalBytes: Uint8Array, entries: OdtEntry[]): OdtPackage {
  const byName = new Map<string, OdtEntry>()
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  const texts = new Map<string, string>()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const text = (name: string): string | undefined => {
    const cached = texts.get(name)
    if (cached !== undefined) return cached
    const entry = byName.get(name)
    if (!entry) return undefined
    const decoded = decoder.decode(entry.bytes)
    texts.set(name, decoded)
    return decoded
  }
  const mimetypeEntry = byName.get('mimetype')
  let mimetype: string | null = mimetypeEntry ? (text('mimetype') as string).trim() : null
  if (mimetype === null) mimetype = manifestRootMediaType(text('META-INF/manifest.xml'))
  const files = entries.filter((e) => !e.directory)
  return {
    originalBytes,
    entries,
    mimetype,
    mimetypeFirst: files.length > 0 && files[0].name === 'mimetype',
    mimetypeStored: mimetypeEntry !== undefined && mimetypeEntry.method === 0,
    get: (name) => byName.get(name),
    text,
  }
}

/** The media type of the manifest's `/` entry; used only when `mimetype` is missing. */
function manifestRootMediaType(manifest: string | undefined): string | null {
  if (!manifest) return null
  for (const match of manifest.matchAll(/<[\w.-]*:?file-entry\b[^>]*>/g)) {
    const tag = match[0]
    const path = /full-path\s*=\s*["']([^"']*)["']/.exec(tag)?.[1]
    if (path !== '/') continue
    return /media-type\s*=\s*["']([^"']*)["']/.exec(tag)?.[1]?.trim() ?? null
  }
  return null
}

interface CentralRecord {
  name: string
  directory: boolean
  method: number
  crc32: number
  dosDateTime: number
  offset: number
  compressed: Uint8Array
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * Central directory entries, sorted by local-header offset (physical order).
 * The gate has already rejected zip64, encrypted entries and out-of-bounds
 * offsets; the bounds are re-checked here anyway since this runs on its own.
 */
function readCentralDirectory(bytes: Uint8Array): CentralRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (i: number) => view.getUint16(i, true)
  const u32 = (i: number) => view.getUint32(i, true)
  const last = bytes.byteLength - 22
  let eocd = -1
  for (let i = last; i >= Math.max(0, last - 0xffff); i--) {
    if (u32(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = u16(eocd + 10)
  const cdSize = u32(eocd + 12)
  const cdOffset = u32(eocd + 16)
  if (cdOffset + cdSize > bytes.byteLength) throw new Error('zip: corrupt central directory')
  const utf8 = new TextDecoder('utf-8')
  const records: CentralRecord[] = []
  let pos = cdOffset
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cdOffset + cdSize || u32(pos) !== CENTRAL_SIG) {
      throw new Error('zip: corrupt central directory')
    }
    const method = u16(pos + 10)
    const dosDateTime = ((u16(pos + 14) << 16) | u16(pos + 12)) >>> 0
    const crc32 = u32(pos + 16)
    const csize = u32(pos + 20)
    const nameLen = u16(pos + 28)
    const extraLen = u16(pos + 30)
    const commentLen = u16(pos + 32)
    const offset = u32(pos + 42)
    // names without the UTF-8 flag are decoded as UTF-8 too, as JSZip does
    const name = utf8.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    if (offset + 30 > bytes.byteLength || u32(offset) !== LOCAL_SIG) {
      throw new Error(`zip: corrupt local header for ${name}`)
    }
    const dataStart = offset + 30 + u16(offset + 26) + u16(offset + 28)
    if (dataStart + csize > bytes.byteLength) {
      throw new Error(`zip: entry ${name} extends past the end of the archive`)
    }
    records.push({
      name,
      directory: name.endsWith('/'),
      method,
      crc32,
      dosDateTime,
      offset,
      compressed: bytes.subarray(dataStart, dataStart + csize),
    })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return records.sort((a, b) => a.offset - b.offset)
}

async function inflateEntry(record: CentralRecord): Promise<Uint8Array> {
  if (record.method === 0) return record.compressed.slice()
  if (record.method !== 8) throw new Error(`unsupported compression method ${record.method}`)
  const reader = streamBytes(record.compressed)
    .pipeThrough(decompressionStream('deflate-raw'))
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
