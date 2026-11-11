import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { assertZipInflatesWithinLimits } from '../src/index'

const MB = 1024 * 1024
const LIMITS = { maxParts: 100, maxPartBytes: 2 * MB, maxTotalBytes: 8 * MB } as const

/** The one refusal callers see for ZIP64, whichever way the archive says it. */
const ZIP64_REFUSAL = 'zip: zip64 archives are not supported'

const END_RECORD_SIG = 0x06054b50
const ZIP64_END_RECORD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const LOCATOR_SIG_BYTES = 'PK\x06\x07'

/** One field of the end record: where it is in the record and how wide. */
interface EndField {
  name: string
  offset: number
  width: 2 | 4
}

/**
 * The end-record fields JSZip 3.10.1 compares with all ones before it takes its
 * ZIP64 path (zipEntries.js, readEndOfCentral).
 */
const END_FIELDS: EndField[] = [
  { name: 'number of this disk', offset: 4, width: 2 },
  { name: 'disk where the central directory starts', offset: 6, width: 2 },
  { name: 'record count on this disk', offset: 8, width: 2 },
  { name: 'total record count', offset: 10, width: 2 },
  { name: 'central directory size', offset: 12, width: 4 },
  { name: 'central directory offset', offset: 16, width: 4 },
]
const NUMBER_OF_THIS_DISK = END_FIELDS[0]

/** A small docx-shaped archive, as JSZip writes it. */
async function ordinary(comment?: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', '<w:document/>')
  // Stored, so the locator signature is in the archive byte for byte, far from
  // the end record.
  zip.file('word/media/image1.bin', `data ${LOCATOR_SIG_BYTES} data`, { compression: 'STORE' })
  return (await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    comment,
  })) as Buffer
}

/** Where the end record of an archive without a comment starts. */
function endRecordOf(archive: Buffer): number {
  const end = archive.length - 22
  if (archive.readUInt32LE(end) !== END_RECORD_SIG) throw new Error('no end record at the tail')
  return end
}

/** The archive with all ones written into one field of its end record. */
function withAllOnes(archive: Buffer, { offset, width }: EndField): Buffer {
  const out = Buffer.from(archive)
  const at = endRecordOf(out) + offset
  if (width === 2) out.writeUInt16LE(0xffff, at)
  else out.writeUInt32LE(0xffffffff, at)
  return out
}

/** The archive with `gap` between its central directory and its end record. */
function withGap(archive: Buffer, gap: Buffer): Buffer {
  const end = endRecordOf(archive)
  return Buffer.concat([archive.subarray(0, end), gap, archive.subarray(end)])
}

/**
 * A ZIP64 end record, its extensible data and its locator, for the gap before
 * the end record of `archive`. `padding` bytes follow the locator, so it does
 * not sit right before the end record; JSZip finds it wherever it is.
 */
function zip64Tail(
  archive: Buffer,
  { extensible = Buffer.alloc(0), padding = 4 }: { extensible?: Buffer; padding?: number } = {},
): Buffer {
  const end = endRecordOf(archive)
  const count = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  const record = Buffer.alloc(56)
  record.writeUInt32LE(ZIP64_END_RECORD_SIG, 0)
  record.writeUInt32LE(44 + extensible.length, 4)
  record.writeUInt32LE(count, 24)
  record.writeUInt32LE(count, 32)
  // counts the padding, so the end record is where JSZip expects it
  record.writeUInt32LE(directorySize + padding, 40)
  record.writeUInt32LE(directoryOffset, 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
  locator.writeUInt32LE(directoryOffset + directorySize, 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([record, extensible, locator, Buffer.alloc(padding)])
}

describe('ZIP64 refusal', () => {
  it('refuses the archive whose ZIP64 extensible data JSZip never finishes reading', async () => {
    // JSZip reads the extensible data in a loop that only ends when a read runs
    // past the data. One field, id 1, whose length 0xfffffffa JSZip reads as -6:
    // the reader steps back over the six bytes it just read, for ever. Only the
    // disk number says ZIP64, and the locator is 24 bytes before the end record.
    // JSZip must never be given these bytes in this process.
    const archive = await ordinary()
    const extensible = Buffer.from([1, 0, 0xfa, 0xff, 0xff, 0xff])
    const hostile = withAllOnes(
      withGap(archive, zip64Tail(archive, { extensible })),
      NUMBER_OF_THIS_DISK,
    )
    await expect(assertZipInflatesWithinLimits(hostile, LIMITS)).rejects.toThrow(ZIP64_REFUSAL)
  })

  it.each(END_FIELDS)(
    'refuses all ones in the $name, with no ZIP64 record in the archive',
    async (field) => {
      const archive = withAllOnes(await ordinary(), field)
      await expect(assertZipInflatesWithinLimits(archive, LIMITS)).rejects.toThrow(ZIP64_REFUSAL)
    },
  )

  it.each(END_FIELDS)(
    'refuses all ones in the $name, with a locator away from the end record',
    async (field) => {
      const archive = await ordinary()
      const zip64 = withAllOnes(withGap(archive, zip64Tail(archive)), field)
      await expect(assertZipInflatesWithinLimits(zip64, LIMITS)).rejects.toThrow(ZIP64_REFUSAL)
    },
  )

  it('refuses a locator right before the end record, whatever the fields say', async () => {
    const archive = await ordinary()
    const zip64 = withGap(archive, zip64Tail(archive, { padding: 0 }))
    await expect(assertZipInflatesWithinLimits(zip64, LIMITS)).rejects.toThrow(ZIP64_REFUSAL)
  })

  it.each([
    ['without a comment', undefined],
    ['with a comment after the end record', 'written by a test'],
    ['with a comment holding the locator signature', `see ${LOCATOR_SIG_BYTES} for more`],
  ])('still accepts an ordinary archive %s', async (_name, comment) => {
    const archive = await ordinary(comment)
    await expect(assertZipInflatesWithinLimits(archive, LIMITS)).resolves.toBeUndefined()
    // and the reader the gate stands in front of opens it
    const zip = await JSZip.loadAsync(archive)
    expect(Object.keys(zip.files)).toContain('word/document.xml')
  })
})
