// A zip read as the bytes it holds, entry by entry, so that two writers can be
// compared field by field. What may differ between the TypeScript host and the
// Rust writer is the deflated bytes of an entry the writer deflated itself (a
// different deflate implementation) and so the compressed size, and whatever
// follows from sizes: the offsets of later entries, the start of the central
// directory, the total length. Everything else is compared: the names and
// their order, every header field of both the local and the central record,
// the CRC (of the inflated data), the inflated bytes, the extra fields and the
// end record.
import { inflateRawSync } from 'node:zlib'

export interface ZipRecord {
  name: Uint8Array
  nameText: string
  local: Record<string, number>
  central: Record<string, number>
  localExtra: Uint8Array
  centralExtra: Uint8Array
  comment: Uint8Array
  /** the compressed bytes as stored */
  compressed: Uint8Array
  /** inflated bytes, or an error text where the data does not inflate */
  inflated: Uint8Array | string
}

export interface ZipRead {
  records: ZipRecord[]
  end: Record<string, number>
  endComment: Uint8Array
  trailing: number
  length: number
  problems: string[]
}

const decoder = new TextDecoder('utf-8')

/** Reads `bytes` through its central directory; a structural fault is a `problems` entry. */
export function readZip(bytes: Uint8Array): ZipRead {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const problems: string[] = []
  const out: ZipRead = {
    records: [],
    end: {},
    endComment: new Uint8Array(),
    trailing: 0,
    length: bytes.length,
    problems,
  }
  let endAt = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      endAt = at
      break
    }
  }
  if (endAt < 0) {
    problems.push('no end of central directory record')
    return out
  }
  const end = {
    disk: view.getUint16(endAt + 4, true),
    cdDisk: view.getUint16(endAt + 6, true),
    entriesOnDisk: view.getUint16(endAt + 8, true),
    entries: view.getUint16(endAt + 10, true),
    cdSize: view.getUint32(endAt + 12, true),
    cdStart: view.getUint32(endAt + 16, true),
    commentLength: view.getUint16(endAt + 20, true),
  }
  out.end = end
  out.endComment = bytes.subarray(endAt + 22, endAt + 22 + end.commentLength)
  out.trailing = bytes.length - (endAt + 22 + end.commentLength)
  let at = end.cdStart
  for (let index = 0; index < end.entries; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      problems.push(`central record ${index} is not at ${at}`)
      break
    }
    const central = {
      versionMadeBy: view.getUint16(at + 4, true),
      versionNeeded: view.getUint16(at + 6, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      nameLength: view.getUint16(at + 28, true),
      extraLength: view.getUint16(at + 30, true),
      commentLength: view.getUint16(at + 32, true),
      disk: view.getUint16(at + 34, true),
      internalAttributes: view.getUint16(at + 36, true),
      externalAttributes: view.getUint32(at + 38, true),
      offset: view.getUint32(at + 42, true),
    }
    const name = bytes.subarray(at + 46, at + 46 + central.nameLength)
    const centralExtra = bytes.subarray(
      at + 46 + central.nameLength,
      at + 46 + central.nameLength + central.extraLength,
    )
    const comment = bytes.subarray(
      at + 46 + central.nameLength + central.extraLength,
      at + 46 + central.nameLength + central.extraLength + central.commentLength,
    )
    at += 46 + central.nameLength + central.extraLength + central.commentLength
    const l = central.offset
    let local: Record<string, number> = {}
    let localExtra: Uint8Array = new Uint8Array()
    let compressed: Uint8Array = new Uint8Array()
    if (l + 30 > bytes.length || view.getUint32(l, true) !== 0x04034b50) {
      problems.push(`local header of entry ${index} is not at ${l}`)
    } else {
      local = {
        versionNeeded: view.getUint16(l + 4, true),
        flags: view.getUint16(l + 6, true),
        method: view.getUint16(l + 8, true),
        time: view.getUint16(l + 10, true),
        date: view.getUint16(l + 12, true),
        crc: view.getUint32(l + 14, true),
        compressedSize: view.getUint32(l + 18, true),
        size: view.getUint32(l + 22, true),
        nameLength: view.getUint16(l + 26, true),
        extraLength: view.getUint16(l + 28, true),
      }
      const dataAt = l + 30 + local.nameLength! + local.extraLength!
      localExtra = bytes.subarray(l + 30 + local.nameLength!, dataAt)
      compressed = bytes.subarray(dataAt, dataAt + (local.compressedSize ?? 0))
      const localName = bytes.subarray(l + 30, l + 30 + local.nameLength!)
      if (Buffer.compare(localName, name) !== 0)
        problems.push(`entry ${index}: the local name differs from the central name`)
    }
    let inflated: Uint8Array | string
    try {
      inflated =
        central.method === 0
          ? compressed
          : central.method === 8
            ? new Uint8Array(inflateRawSync(compressed))
            : `method ${central.method}`
    } catch (error) {
      inflated = `does not inflate: ${String(error)}`
    }
    out.records.push({
      name,
      nameText: decoder.decode(name),
      local,
      central,
      localExtra,
      centralExtra,
      comment,
      compressed,
      inflated,
    })
  }
  return out
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/**
 * `null` where the two zips are the same but for what the deflate
 * implementations may differ in, else the first difference. `copied` is the
 * list of entry names whose compressed bytes the writer took over from a
 * source package (`saveOdt` keeps untouched entries as they were): these must
 * be equal to the byte on both sides.
 */
export function compareZips(
  typescript: Uint8Array,
  rust: Uint8Array,
  copied: ReadonlySet<string> = new Set(),
): string | null {
  const a = readZip(typescript)
  const b = readZip(rust)
  if (a.problems.length > 0) return `TypeScript zip is damaged: ${a.problems[0]}`
  if (b.problems.length > 0) return `Rust zip is damaged: ${b.problems[0]}`
  if (a.records.length !== b.records.length)
    return `entry count: TypeScript ${a.records.length}, Rust ${b.records.length}`
  const names = (zip: ZipRead): string[] => zip.records.map((r) => r.nameText)
  for (let i = 0; i < a.records.length; i++)
    if (hex(a.records[i]!.name) !== hex(b.records[i]!.name))
      return `entry ${i} is named ${JSON.stringify(a.records[i]!.nameText)} by TypeScript and ${JSON.stringify(b.records[i]!.nameText)} by Rust (orders ${JSON.stringify(names(a))} and ${JSON.stringify(names(b))})`
  let exact = true
  for (let i = 0; i < a.records.length; i++) {
    const x = a.records[i]!
    const y = b.records[i]!
    const where = `entry ${JSON.stringify(x.nameText)}`
    // the compressed bytes are free where the writer deflated them itself
    const free = x.central.method === 8 && !copied.has(x.nameText)
    for (const [side, left, right] of [
      ['local', x.local, y.local],
      ['central', x.central, y.central],
    ] as const) {
      for (const key of Object.keys(left)) {
        if (key === 'offset') continue
        if (key === 'compressedSize' && free) continue
        if (left[key] !== right[key])
          return `${where}: ${side} ${key}: TypeScript ${left[key]}, Rust ${right[key]}`
      }
    }
    if (free && x.local.compressedSize !== x.central.compressedSize)
      return `${where}: TypeScript local and central compressed sizes differ`
    if (free && y.local.compressedSize !== y.central.compressedSize)
      return `${where}: Rust local and central compressed sizes differ`
    if (hex(x.localExtra) !== hex(y.localExtra)) return `${where}: local extra field`
    if (hex(x.centralExtra) !== hex(y.centralExtra)) return `${where}: central extra field`
    if (hex(x.comment) !== hex(y.comment)) return `${where}: entry comment`
    if (typeof x.inflated === 'string' || typeof y.inflated === 'string') {
      if (x.inflated !== y.inflated)
        return `${where}: data: TypeScript ${typeof x.inflated === 'string' ? x.inflated : 'inflates'}, Rust ${typeof y.inflated === 'string' ? y.inflated : 'inflates'}`
    } else if (Buffer.compare(x.inflated, y.inflated) !== 0) {
      return `${where}: inflated bytes differ (${x.inflated.length} and ${y.inflated.length} bytes)`
    }
    if (!free) {
      if (Buffer.compare(x.compressed, y.compressed) !== 0) return `${where}: stored bytes differ`
    } else if (x.compressed.length !== y.compressed.length) exact = false
  }
  for (const key of Object.keys(a.end)) {
    if (key === 'cdStart' && !exact) continue
    if (a.end[key] !== b.end[key])
      return `end record ${key}: TypeScript ${a.end[key]}, Rust ${b.end[key]}`
  }
  if (hex(a.endComment) !== hex(b.endComment)) return 'end record comment'
  if (a.trailing !== b.trailing)
    return `bytes after the end record: ${a.trailing} and ${b.trailing}`
  if (exact) {
    for (let i = 0; i < a.records.length; i++)
      if (a.records[i]!.central.offset !== b.records[i]!.central.offset)
        return `entry ${JSON.stringify(a.records[i]!.nameText)}: central offset ${a.records[i]!.central.offset} and ${b.records[i]!.central.offset}`
    if (a.length !== b.length) return `length ${a.length} and ${b.length}`
  }
  return null
}

/** The names of the entries of `bytes` whose compressed bytes equal an entry of the same name in `source`. */
export function copiedEntries(bytes: Uint8Array, source: Uint8Array): Set<string> {
  const original = new Map(readZip(source).records.map((r) => [r.nameText, r.compressed]))
  const out = new Set<string>()
  for (const record of readZip(bytes).records) {
    const was = original.get(record.nameText)
    if (was && Buffer.compare(was, record.compressed) === 0) out.add(record.nameText)
  }
  return out
}
