import { describe, expect, it } from 'vitest'
import {
  applyImageWrap,
  applyImageZOrder,
  buildAnchoredTextboxParagraphXml,
  patchDrawingExtent,
  patchTextboxHeights,
  resizeInlinePictureXml,
} from '../src/generate'

/**
 * Each number of a drawing has its own range in the schema, narrower than the
 * widest drawing coordinate: wp:posOffset is an xsd:int (ST_PositionOffset),
 * relativeHeight is an xsd:unsignedInt, and an extent's cx / cy is
 * ST_PositiveCoordinate (0 to 27273042316900). A value outside its range has
 * no text there: a patch keeps what the drawing holds, a builder refuses it.
 */

const extent = (cx: number, cy: number) => `<wp:extent cx="${cx}" cy="${cy}"/>`
const inline =
  '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
  `${extent(952500, 476250)}<wp:docPr id="1" name="Picture 1"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
const anchored = (rank = 251658240) =>
  '<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" ' +
  `relativeHeight="${rank}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>457200</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>95250</wp:posOffset></wp:positionV>' +
  `${extent(952500, 476250)}<wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Picture 1"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr></pic:pic>' +
  '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'
const textbox =
  '<w:p><w:r><w:drawing><wp:anchor relativeHeight="251658240"><wp:extent cx="1800000" cy="1080000"/>' +
  '<a:graphic><a:graphicData><wps:wsp><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="1080000"/></a:xfrm></wps:spPr>' +
  '<wps:txbx><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>' +
  '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'

/** px whose EMU is past the widest extent: 1e10 px is 95250000000000 EMU */
const TOO_WIDE_PX = 1e10

describe('an extent past ST_PositiveCoordinate', () => {
  it('a resized picture keeps its extent', () => {
    expect(resizeInlinePictureXml(inline, TOO_WIDE_PX, 50)).not.toContain('95250000000000')
    expect(resizeInlinePictureXml(inline, TOO_WIDE_PX, 50)).toContain(extent(952500, 476250))
  })

  it('a resized chart or diagram keeps its extent', () => {
    expect(patchDrawingExtent(inline, TOO_WIDE_PX, TOO_WIDE_PX)).toContain(extent(952500, 476250))
  })

  it('a text box made taller keeps its height', () => {
    expect(patchTextboxHeights(textbox, [TOO_WIDE_PX])).toContain('cy="1080000"')
  })

  it('the widest extent itself is still written', () => {
    expect(resizeInlinePictureXml(inline, 27273042316900 / 9525, 50)).toContain(
      'cx="27273042316900"',
    )
  })
})

describe('a stacking rank past xsd:unsignedInt', () => {
  it('a reorder keeps the rank the anchor has', () => {
    expect(applyImageZOrder(anchored(), 1e10)).toContain('relativeHeight="251658240"')
  })

  it('a rewrapped picture keeps the rank it had', () => {
    const out = applyImageWrap(anchored(251660000), 'square-left', undefined, undefined, 1e10)
    expect(out).toContain('relativeHeight="251660000"')
  })
})

describe('a position past xsd:int', () => {
  it('a rewrapped picture keeps the position it had', () => {
    const out = applyImageWrap(anchored(), 'square-left', { x: 2147483648, y: -2147483649 })
    expect(out).toContain('<wp:posOffset>457200</wp:posOffset>')
    expect(out).toContain('<wp:posOffset>95250</wp:posOffset>')
  })
})

describe('a builder given a number outside its attribute range', () => {
  const box = {
    anchor: 'paragraph' as const,
    xEmu: 0,
    yEmu: 0,
    widthEmu: 1800000,
    heightEmu: 1080000,
    paragraphs: [{ runs: [{ text: 'Box' }] }],
  }
  it.each([
    ['xEmu', { xEmu: 2147483648 }],
    ['yEmu', { yEmu: -2147483649 }],
    ['widthEmu', { widthEmu: 27273042316901 }],
    ['zOrder', { zOrder: 1e10 }],
  ])('refuses %s', (name, over) => {
    expect(() => buildAnchoredTextboxParagraphXml({ ...box, ...over } as never)).toThrow(
      new RegExp(name),
    )
  })
})
