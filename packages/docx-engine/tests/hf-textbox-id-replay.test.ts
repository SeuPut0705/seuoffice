import { describe, expect, it, vi } from 'vitest'
import { parseDocx } from '../src/index'
import { buildDocx } from './helpers/build-docx'

/**
 * Header text boxes are numbered by a counter of the process, one step per
 * box per parse. A picture the host converts (EMF) makes the engine parse a
 * document twice, the first pass owing the conversion: that pass must not
 * count, so a parse takes as many numbers with a converted picture as
 * without one.
 */

vi.mock('../src/vendor/emf-converter/index.mjs', () => ({
  convertEmfToDataUrl: vi.fn(async () => 'data:image/png;base64,EMFPNG'),
  convertWmfToDataUrl: vi.fn(async () => 'data:image/png;base64,WMFPNG'),
}))

const HEADER_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'

const BOX =
  '<w:r><w:drawing><wp:anchor behindDoc="1" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">' +
  '<wp:simplePos x="0" y="0"/>' +
  '<wp:positionH relativeFrom="page"><wp:posOffset>635297</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="page"><wp:posOffset>318638</wp:posOffset></wp:positionV>' +
  '<wp:extent cx="1855470" cy="154940"/><wp:wrapNone/><wp:docPr id="1" name="Textbox 1"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1855470" cy="154940"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
  '<wps:txbx><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx>' +
  '<wps:bodyPr wrap="square"><a:noAutofit/></wps:bodyPr>' +
  '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'

const EMF_DRAWING =
  '<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>'

function headerDocx(withEmf: boolean): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: withEmf
      ? `<w:p><w:r>${EMF_DRAWING}</w:r></w:p>`
      : '<w:p><w:r><w:t>body</w:t></w:r></w:p>',
    extraRels:
      '<Relationship Id="rId61" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
      (withEmf
        ? '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.emf"/>'
        : ''),
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: `<w:hdr ${NS}><w:p>${BOX}</w:p></w:hdr>`,
        contentType: HEADER_TYPE,
      },
    ],
    ...(withEmf
      ? {
          binaryParts: [
            {
              path: 'word/media/image1.emf',
              base64: Buffer.from('not-a-real-emf-payload').toString('base64'),
              extension: 'emf',
              contentType: 'image/x-emf',
            },
          ],
        }
      : {}),
    sectPrExtra: '<w:headerReference w:type="default" r:id="rId61"/>',
  })
}

const boxId = async (bytes: Uint8Array): Promise<number> => {
  const doc = await parseDocx(bytes)
  const id = doc.headerParas?.find((p) => p.box)?.box?.id
  if (id === undefined) throw new Error('the header holds no text box')
  return id
}

describe('header text box ids across a parse that waits for a converted picture', () => {
  it('advance as far for a parse that waited for a conversion as for one that did not', async () => {
    const plain = await headerDocx(false)
    const withEmf = await headerDocx(true)
    const first = await boxId(plain)
    const converted = await boxId(withEmf)
    const after = await boxId(plain)
    const second = await boxId(plain)
    // every parse takes the same count of numbers, the converted one included
    expect(converted - first).toBe(second - after)
    expect(after - converted).toBe(second - after)
  })
})
