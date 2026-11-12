import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertOdpToPptx, convertOdtToDocx, OdfConvertError } from '../src/index'

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

const NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"' +
  ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
  ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"' +
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"' +
  ' xmlns:xlink="http://www.w3.org/1999/xlink"'

async function build(body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NAMESPACES} office:version="1.2"><office:body>${body}</office:body></office:document-content>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const odt = () => build('<office:text><text:p>hello</text:p></office:text>')
const odp = () => build('<office:presentation><draw:page draw:name="page1"/></office:presentation>')

describe('an ODF package goes through the zip gate', () => {
  it('refuses a text document the gate refuses', async () => {
    const zip64 = asZip64(await odt())
    // what makes the case: without the gate JSZip opens these bytes
    expect(Object.keys((await JSZip.loadAsync(zip64)).files)).toContain('content.xml')
    // an unreadable package is reported as OdfConvertError('unreadable')
    await expect(convertOdtToDocx(zip64)).rejects.toThrow(new OdfConvertError('unreadable'))
  })

  it('refuses a presentation the gate refuses', async () => {
    const zip64 = asZip64(await odp())
    expect(Object.keys((await JSZip.loadAsync(zip64)).files)).toContain('content.xml')
    await expect(convertOdpToPptx(zip64)).rejects.toThrow(new OdfConvertError('unreadable'))
  })

  it('still converts ordinary packages', async () => {
    expect((await convertOdtToDocx(await odt())).dropped).toEqual([])
    await expect(convertOdpToPptx(await odp())).resolves.toBeDefined()
  })
})
