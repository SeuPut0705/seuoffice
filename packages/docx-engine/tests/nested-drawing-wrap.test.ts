import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/index'
import { buildDocx } from './helpers/build-docx'

/**
 * A floating drawing wraps by its own wrap element. One nested in a text box
 * has a wrap element too, inside the outer drawing's a:graphic; it says how
 * the box's inner text meets the inner drawing and nothing about the box.
 */

const anchor = (id: number, cx: number, wrap: string, graphic: string) =>
  '<w:drawing><wp:anchor behindDoc="0" simplePos="0" locked="0" layoutInCell="1" allowOverlap="1" relativeHeight="251659264">' +
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>100000</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>100000</wp:posOffset></wp:positionV>' +
  `<wp:extent cx="${cx}" cy="${cx / 2}"/>${wrap}<wp:docPr id="${id}" name="Drawing ${id}"/>` +
  `<a:graphic>${graphic}</a:graphic></wp:anchor></w:drawing>`

const picture = (wrap: string) =>
  anchor(
    2,
    914400,
    wrap,
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData>',
  )

const boxParagraph = (wrap: string, innerRun = '') =>
  `<w:p><w:r>${anchor(
    1,
    3000000,
    wrap,
    '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="1500000"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
      `<wps:txbx><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r>${innerRun}</w:p></w:txbxContent></wps:txbx>` +
      '<wps:bodyPr/></wps:wsp></a:graphicData>',
  )}</w:r><w:r><w:t>Body text beside the box</w:t></w:r></w:p>`

const SQUARE = '<wp:wrapSquare wrapText="bothSides"/>'
const NONE = '<wp:wrapNone/>'

/** how the body text meets the outer box */
async function outerWrap(bodyXml: string) {
  const doc = await parseDocx(await buildDocx({ bodyXml, withImage: true }))
  const { noWrap, wrapSides, floating } = doc.blocks[0].textboxes![0]
  return { noWrap, wrapSides, floating }
}

describe('the wrap of a text box that holds a floating picture', () => {
  it('a square-wrapped box stays square-wrapped around an in-front-of-text picture inside it', async () => {
    const alone = await outerWrap(boxParagraph(SQUARE))
    expect(alone.noWrap).toBeUndefined()
    expect(await outerWrap(boxParagraph(SQUARE, `<w:r>${picture(NONE)}</w:r>`))).toEqual(alone)
  })

  it('an in-front-of-text box stays so around a square-wrapped picture inside it', async () => {
    const alone = await outerWrap(boxParagraph(NONE))
    expect(alone.noWrap).toBe(true)
    expect(await outerWrap(boxParagraph(NONE, `<w:r>${picture(SQUARE)}</w:r>`))).toEqual(alone)
  })
})
