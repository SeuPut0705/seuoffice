import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertHwpxToDocx, HwpConvertError } from '../src/index'

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

const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"' +
  ' xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'

async function hwpx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
  zip.file('Contents/header.xml', `<?xml version="1.0" encoding="UTF-8"?><hh:head ${NS}/>`)
  zip.file(
    'Contents/section0.xml',
    `<?xml version="1.0" encoding="UTF-8"?><hs:sec ${NS}><hp:p><hp:run><hp:t>hello</hp:t></hp:run></hp:p></hs:sec>`,
  )
  zip.file(
    'Contents/content.hpf',
    `<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>` +
      `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>` +
      `<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>` +
      `</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('an HWPX package goes through the zip gate', () => {
  it('refuses a package the gate refuses', async () => {
    const zip64 = asZip64(await hwpx())
    // what makes the case: without the gate JSZip opens these bytes
    expect(Object.keys((await JSZip.loadAsync(zip64)).files)).toContain('Contents/section0.xml')
    const refusal = await convertHwpxToDocx(zip64).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(HwpConvertError)
    expect((refusal as HwpConvertError).code).toBe('unreadable')
  })

  it('still converts an ordinary package', async () => {
    await expect(convertHwpxToDocx(await hwpx())).resolves.toBeDefined()
  })
})
