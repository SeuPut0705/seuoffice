// The zip the Rust writer (crates/ooxml-pkg/src/write.rs) produces against
// the one JSZip produces: for every option set of BLANK_DOCX_MATRIX, and for
// the built packages of ZIP_PACKAGES that no blank document is.
//
//   npx tsx tools/docx-diff/compare-blank.ts   (after a wasm build)
//
// (a) The Rust zip opened with JSZip (checking CRC-32) must hold the same
//     entries, in the same order, with the same inflated bytes.
// (b) Both files are walked record by record and every raw field that differs
//     is tallied: what a byte-preserving save would have to account for. Only
//     the fields that follow from the deflate stream may differ; any other
//     field that differs fails like (a).
import JSZip from 'jszip'
import { pathToFileURL } from 'node:url'
import { BLANK_DOCX_MATRIX, typescriptBlankDocx, typescriptZip, ZIP_PACKAGES } from './calls-blank'
import { failed } from './engine'
import { engine } from './harness'

/** One record of a zip as it lies in the file: its fields in file order. */
interface ZipRecord {
  kind: 'local' | 'central' | 'end'
  /** The entry name, to say where a field differs. */
  name: string
  fields: Array<[field: string, value: Uint8Array | number]>
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const DESCRIPTOR = 0x08074b50

/** The deflate implementations differ: these fields follow from their output. */
const DEFLATE_FIELDS = new Set([
  'local.compressedSize',
  'local.data',
  'central.compressedSize',
  'central.localHeaderOffset',
  'end.directoryOffset',
])

/** Every record of `bytes`: local headers with their data, the central directory, the end record. */
function walk(bytes: Uint8Array): ZipRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const records: ZipRecord[] = []
  let end = bytes.length - 22
  while (end >= 0 && view.getUint32(end, true) !== END) end--
  if (end < 0) throw new Error('no end of central directory record')

  let at = 0
  const u16 = (field: string, record: ZipRecord): number => {
    const value = view.getUint16(at, true)
    record.fields.push([field, value])
    at += 2
    return value
  }
  const u32 = (field: string, record: ZipRecord): number => {
    const value = view.getUint32(at, true)
    record.fields.push([field, value])
    at += 4
    return value
  }
  const raw = (field: string, record: ZipRecord, length: number): Uint8Array => {
    const value = bytes.subarray(at, at + length)
    record.fields.push([field, value])
    at += length
    return value
  }

  const centralSizes: number[] = []
  at = view.getUint32(end + 16, true)
  while (at < end && view.getUint32(at, true) === CENTRAL) {
    const record: ZipRecord = { kind: 'central', name: '', fields: [] }
    u32('signature', record)
    for (const field of ['versionMadeBy', 'versionNeeded', 'flags', 'method', 'time', 'date'])
      u16(field, record)
    u32('crc32', record)
    centralSizes.push(u32('compressedSize', record))
    u32('uncompressedSize', record)
    const nameLength = u16('nameLength', record)
    const extraLength = u16('extraLength', record)
    const commentLength = u16('commentLength', record)
    u16('diskStart', record)
    u16('internalAttributes', record)
    u32('externalAttributes', record)
    u32('localHeaderOffset', record)
    record.name = decoder.decode(raw('name', record, nameLength))
    raw('extra', record, extraLength)
    raw('comment', record, commentLength)
    records.push(record)
  }
  const centralStart = view.getUint32(end + 16, true)

  const locals: ZipRecord[] = []
  at = 0
  while (at < centralStart && view.getUint32(at, true) === LOCAL) {
    const record: ZipRecord = { kind: 'local', name: '', fields: [] }
    u32('signature', record)
    u16('versionNeeded', record)
    const flags = u16('flags', record)
    for (const field of ['method', 'time', 'date']) u16(field, record)
    u32('crc32', record)
    const compressedSize = u32('compressedSize', record)
    u32('uncompressedSize', record)
    const nameLength = u16('nameLength', record)
    const extraLength = u16('extraLength', record)
    record.name = decoder.decode(raw('name', record, nameLength))
    raw('extra', record, extraLength)
    // with bit 3 the sizes follow the data: the central directory has them
    const dataLength = flags & 0x0008 ? (centralSizes[locals.length] ?? 0) : compressedSize
    raw('data', record, dataLength)
    if (flags & 0x0008) {
      if (view.getUint32(at, true) === DESCRIPTOR) u32('descriptorSignature', record)
      u32('descriptorCrc32', record)
      u32('descriptorCompressedSize', record)
      u32('descriptorUncompressedSize', record)
    }
    locals.push(record)
  }
  if (at !== centralStart) {
    locals.push({ kind: 'local', name: '', fields: [['gap', bytes.subarray(at, centralStart)]] })
  }

  at = end
  const record: ZipRecord = { kind: 'end', name: '', fields: [] }
  u32('signature', record)
  for (const field of ['disk', 'directoryDisk', 'diskEntries', 'totalEntries']) u16(field, record)
  u32('directorySize', record)
  u32('directoryOffset', record)
  const commentLength = u16('commentLength', record)
  raw('comment', record, commentLength)
  raw('trailing', record, bytes.length - at)
  return [...locals, ...records, record]
}

function shown(value: Uint8Array | number | undefined): string {
  if (value === undefined) return 'absent'
  if (typeof value === 'number') return `${value} (0x${value.toString(16)})`
  const head = Buffer.from(value.subarray(0, 24)).toString('hex')
  return `${value.length} bytes ${head}${value.length > 24 ? '…' : ''}`
}

function same(a: Uint8Array | number | undefined, b: Uint8Array | number | undefined): boolean {
  if (typeof a === 'number' || typeof b === 'number' || a === undefined || b === undefined)
    return a === b
  return Buffer.from(a).equals(Buffer.from(b))
}

/** The entries JSZip reads: name, folder or not, inflated bytes. */
async function entriesOf(bytes: Uint8Array): Promise<Array<[string, boolean, Buffer]>> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const entries: Array<[string, boolean, Buffer]> = []
  for (const [name, file] of Object.entries(zip.files)) {
    entries.push([name, file.dir, Buffer.from(await file.async('uint8array'))])
  }
  return entries
}

/** One zip written by both writers. */
interface ByteCase {
  where: string
  /** The Rust function that writes it, and its arguments. */
  fn: string
  args: Record<string, unknown>
  typescript(): Promise<Uint8Array>
}

/** The Rust bytes of each case, or why the Rust side refused it. */
function rustBytesOf(cases: ByteCase[]): Array<Uint8Array | string> {
  const out: Array<Uint8Array | string> = []
  for (let from = 0; from < cases.length; from += 200) {
    const batch = cases.slice(from, from + 200)
    const { header } = engine.call<{ results: Array<Array<{ value?: string; error?: string }>> }>({
      cmd: 'props',
      inputs: [{ xml: '', calls: batch.map(({ fn, args }) => ({ fn, args })) }],
    })
    if (failed(header)) throw new Error(`props failed: ${header.error.message}`)
    for (const result of header.results[0]!) {
      out.push(
        result.value === undefined
          ? (result.error ?? 'undefined')
          : Buffer.from(result.value, 'base64'),
      )
    }
  }
  return out
}

/**
 * Every option set of BLANK_DOCX_MATRIX, and every package of ZIP_PACKAGES
 * (what the writer meets beyond blank documents), written by both writers.
 */
export async function compareBlankBytes(): Promise<{
  compared: number
  differences: string[]
  rawFields: Map<string, number>
  /** The first difference of each raw field. */
  rawExamples: Map<string, string>
}> {
  const differences: string[] = []
  const rawFields = new Map<string, number>()
  const rawExamples = new Map<string, string>()
  const cases: ByteCase[] = [
    ...BLANK_DOCX_MATRIX.map(({ text = '', args = {} }, index) => ({
      where: `option set ${index} ${JSON.stringify(args)}`,
      fn: 'blank.buildBlankDocxBytes',
      args,
      typescript: () => typescriptBlankDocx(text, args),
    })),
    ...ZIP_PACKAGES.map((zip) => ({
      where: `zip package "${zip.label}"`,
      fn: 'blank.zipBytes',
      args: { parts: zip.parts, now: zip.now },
      typescript: () => typescriptZip(zip),
    })),
  ]
  const rust = rustBytesOf(cases)
  let compared = 0
  for (const [index, { where, typescript: write }] of cases.entries()) {
    compared++
    let typescript: Uint8Array | string
    try {
      typescript = await write()
    } catch (error) {
      typescript = String(error)
    }
    const rustBytes = rust[index]!
    if (typeof typescript === 'string' || typeof rustBytes === 'string') {
      if (typeof typescript !== typeof rustBytes) {
        differences.push(
          `${where}: typescript ${typeof typescript === 'string' ? typescript : 'bytes'}, rust ${typeof rustBytes === 'string' ? rustBytes : 'bytes'}`,
        )
      }
      continue
    }

    const expected = await entriesOf(typescript)
    let actual: Array<[string, boolean, Buffer]>
    try {
      actual = await entriesOf(rustBytes)
    } catch (error) {
      differences.push(`${where}: JSZip cannot open the Rust zip: ${String(error)}`)
      continue
    }
    const names = (entries: Array<[string, boolean, Buffer]>): string =>
      entries.map(([name, dir]) => (dir ? `${name}(dir)` : name)).join(', ')
    if (names(expected) !== names(actual)) {
      differences.push(
        `${where}: entries\n      typescript ${names(expected)}\n      rust       ${names(actual)}`,
      )
    } else {
      for (const [at, [name, , content]] of expected.entries()) {
        if (!content.equals(actual[at]![2])) differences.push(`${where}: content of ${name}`)
      }
    }

    const ours = walk(rustBytes)
    const theirs = walk(typescript)
    for (let at = 0; at < Math.max(ours.length, theirs.length); at++) {
      const a = theirs[at]
      const b = ours[at]
      const kind = a?.kind ?? b!.kind
      const fieldNames = new Set(
        [...(a?.fields ?? []), ...(b?.fields ?? [])].map(([field]) => field),
      )
      for (const field of fieldNames) {
        const valueA = a?.fields.find(([name]) => name === field)?.[1]
        const valueB = b?.fields.find(([name]) => name === field)?.[1]
        if (same(valueA, valueB)) continue
        const key = `${kind}.${field}`
        rawFields.set(key, (rawFields.get(key) ?? 0) + 1)
        const example = `${where}, entry ${a?.name || b?.name || '(end)'}\n      typescript ${shown(valueA)}\n      rust       ${shown(valueB)}`
        if (!DEFLATE_FIELDS.has(key)) differences.push(`${key}: ${example}`)
        if (!rawExamples.has(key)) rawExamples.set(key, example)
      }
    }
  }
  return { compared, differences, rawFields, rawExamples }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { compared, differences, rawFields, rawExamples } = await compareBlankBytes()
  console.log(`blank bytes: ${compared} zips compared, ${differences.length} differences`)
  for (const difference of differences.slice(0, 20)) console.log(`  ${difference}`)
  console.log('raw fields that differ (records, over every zip):')
  for (const [field, count] of [...rawFields].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`  ${field}: ${count}\n    ${rawExamples.get(field)}`)
  }
  if (differences.length > 0) process.exitCode = 1
}
