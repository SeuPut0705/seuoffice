import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildChartWorkbookXlsxBase64, patchChartWorkbookXlsxBase64 } from '../src/index'

/**
 * The archive as ZIP64: the disk number of its end record all ones, with a
 * ZIP64 end record and locator in front. JSZip opens it; the zip gate refuses
 * every archive JSZip reads this way, because JSZip's ZIP64 reader does not
 * return from some of them.
 */
function asZip64(archive: Buffer): Buffer {
  const end = archive.length - 22
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeUInt32LE(44, 4)
  record.writeUInt32LE(archive.readUInt16LE(end + 10), 32)
  record.writeUInt32LE(archive.readUInt32LE(end + 12), 40)
  record.writeUInt32LE(archive.readUInt32LE(end + 16), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(end, 8)
  locator.writeUInt32LE(1, 16)
  const endRecord = Buffer.from(archive.subarray(end))
  endRecord.writeUInt16LE(0xffff, 4)
  return Buffer.concat([archive.subarray(0, end), record, locator, endRecord])
}

const CATEGORIES = ['Q1', 'Q2']
const SERIES = [{ name: 'S1', values: [1, 2] as (number | null)[] }]

describe('the workbook embedded in a chart goes through the zip gate', () => {
  it('leaves a workbook the gate refuses alone', async () => {
    const workbook = Buffer.from(await buildChartWorkbookXlsxBase64(CATEGORIES, SERIES), 'base64')
    const zip64 = asZip64(workbook)
    // what makes the case: without the gate JSZip opens these bytes
    expect(Object.keys((await JSZip.loadAsync(zip64)).files)).toContain('xl/worksheets/sheet1.xml')
    // null is how an embedded workbook that cannot be read comes back: the
    // callers then keep the part as it is
    expect(
      await patchChartWorkbookXlsxBase64(zip64.toString('base64'), CATEGORIES, SERIES),
    ).toBeNull()
  })

  it('still patches an ordinary workbook', async () => {
    const workbook = await buildChartWorkbookXlsxBase64(CATEGORIES, SERIES)
    const patched = await patchChartWorkbookXlsxBase64(workbook, CATEGORIES, [
      { name: 'S1', values: [9, 8] },
    ])
    const zip = await JSZip.loadAsync(Buffer.from(patched!, 'base64'))
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<v>9</v>')
  })
})
