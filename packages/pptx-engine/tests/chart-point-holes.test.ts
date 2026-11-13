/**
 * A chart series whose c:dPt colors only point 1 holds a hole at point 0: the TypeScript model
 * has `pointColors[0] === undefined`. The engine's JSON writes that hole as null, and the binding
 * turns it back into undefined wherever a chart sits: on the slide, in a group, in a group in a
 * group, and in an element an edit writes back into the caller's object.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  createBlankPptx,
  ensureCreationId,
  duplicateSlide,
  openPptx,
  type ChartElement,
  type GroupElement,
  type SlideElement,
} from '../src/index'

const CHART_PART = 'ppt/charts/chart1.xml'
const CHART_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
  '<c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' +
  '<c:ser><c:idx val="0"/><c:order val="0"/>' +
  '<c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt>' +
  '<c:val><c:numRef><c:numCache><c:ptCount val="2"/>' +
  '<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>' +
  '<c:axId val="1"/><c:axId val="2"/></c:barChart>' +
  '<c:catAx><c:axId val="1"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:crossAx val="1"/></c:valAx>' +
  '</c:plotArea></c:chart></c:chartSpace>'

const XFRM = '<a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/>'
const frame = (id: number) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm>${XFRM}</p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
  '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdHoles"/></a:graphicData></a:graphic></p:graphicFrame>'
const group = (id: number, child: string) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm>${XFRM}<a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr>${child}</p:grpSp>`

/** A blank deck whose first slide holds the chart on its own and in a group in a group. */
async function deckWithCharts(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const slidePath = 'ppt/slides/slide1.xml'
  const relsPath = 'ppt/slides/_rels/slide1.xml.rels'
  const slide = await zip.file(slidePath)!.async('string')
  zip.file(
    slidePath,
    slide.replace('</p:spTree>', `${frame(40)}${group(41, group(42, frame(43)))}</p:spTree>`),
  )
  const rels = await zip.file(relsPath)!.async('string')
  zip.file(
    relsPath,
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdHoles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    ),
  )
  zip.file(CHART_PART, CHART_XML)
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '</Types>',
      `<Override PartName="/${CHART_PART}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
    ),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const colorsOf = (el: SlideElement | undefined) => (el as ChartElement).chart.series[0]!.pointColors

const childOf = (el: SlideElement | undefined) => (el as GroupElement).children[0]

describe('the hole before a colored chart point', () => {
  it('stays undefined for a chart on the slide and one in a group in a group', async () => {
    const { deck } = await openPptx(await deckWithCharts())
    const elements = deck.slides[0]!.elements
    const top = elements.find((el) => el.type === 'chart')
    const outer = elements.find((el) => el.type === 'group')
    expect(colorsOf(top)).toEqual([undefined, '#FF0000'])
    expect(colorsOf(childOf(childOf(outer)))).toEqual([undefined, '#FF0000'])
  })

  it('stays undefined in an element an edit writes back', async () => {
    const { deck } = await openPptx(await deckWithCharts())
    const elements = deck.slides[0]!.elements
    const top = elements.find((el) => el.type === 'chart')!
    const outer = elements.find((el) => el.type === 'group')!
    ensureCreationId(top)
    ensureCreationId(outer)
    expect(colorsOf(top)).toEqual([undefined, '#FF0000'])
    expect(colorsOf(childOf(childOf(outer)))).toEqual([undefined, '#FF0000'])
  })

  it('stays undefined in the slide an edit answers', async () => {
    const opened = await openPptx(await deckWithCharts())
    const copy = duplicateSlide(opened, 0)
    expect(copy).not.toBeNull()
    const top = copy!.elements.find((el) => el.type === 'chart')
    const outer = copy!.elements.find((el) => el.type === 'group')
    expect(colorsOf(top)).toEqual([undefined, '#FF0000'])
    expect(colorsOf(childOf(childOf(outer)))).toEqual([undefined, '#FF0000'])
  })
})
