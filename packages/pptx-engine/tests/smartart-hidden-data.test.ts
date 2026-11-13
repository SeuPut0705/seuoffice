import { describe, expect, it } from 'vitest'
import { parseSlide } from '../src/parse'
import { redactExtXml } from '../src/redaction-xml'
import type { PassthroughElement, TextElement } from '../src/types'

/**
 * A SmartArt whose data part holds a run a person hid from AI: the shapes the
 * slide draws for it (its cached drawing, or the layout made from the data
 * when there is none) carry the mark on their text, so every reader and the
 * screenshot gate, which read those shapes, withhold it.
 */

const SECRET = '13800138000'
const LABEL = 'client phone'

const slideWith = (body: string) =>
  '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>' +
  `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`

const FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Diagram 1"/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="100" y="200"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
  '<dgm:relIds xmlns:dgm="dgm" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>' +
  '</a:graphicData></a:graphic></p:graphicFrame>'

const point = (id: string, runs: string) =>
  `<dgm:pt modelId="${id}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p>${runs}</a:p></dgm:t></dgm:pt>`

const DATA =
  '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="a"><dgm:ptLst>' +
  '<dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>' +
  point(
    '1',
    `<a:r><a:rPr lang="en-US">${'<a:extLst>' + redactExtXml(LABEL) + '</a:extLst>'}</a:rPr><a:t>${SECRET}</a:t></a:r>`,
  ) +
  point('2', '<a:r><a:rPr lang="en-US"/><a:t>Plain</a:t></a:r>') +
  '</dgm:ptLst><dgm:cxnLst>' +
  '<dgm:cxn modelId="c1" srcId="0" destId="1" srcOrd="0" destOrd="0"/>' +
  '<dgm:cxn modelId="c2" srcId="0" destId="2" srcOrd="1" destOrd="0"/>' +
  '</dgm:cxnLst></dgm:dataModel>'

/** a cached drawing that copied the words without the mark */
const DRAWING =
  '<dsp:drawing xmlns:dsp="dsp" xmlns:a="a"><dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/>' +
  '<dsp:sp modelId="{X}"><dsp:nvSpPr><dsp:cNvPr id="1" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>' +
  '<dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000" cy="1000"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>' +
  `<dsp:txBody><a:bodyPr/><a:p><a:r><a:t>${SECRET}</a:t></a:r></a:p></dsp:txBody></dsp:sp>` +
  '<dsp:sp modelId="{Y}"><dsp:nvSpPr><dsp:cNvPr id="2" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>' +
  '<dsp:spPr><a:xfrm><a:off x="0" y="1000"/><a:ext cx="2000" cy="1000"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>' +
  '<dsp:txBody><a:bodyPr/><a:p><a:r><a:t>Plain</a:t></a:r></a:p></dsp:txBody></dsp:sp>' +
  '</dsp:spTree></dsp:drawing>'

function runsOf(drawings?: Map<string, string>) {
  const slide = parseSlide({
    path: 'ppt/slides/slide1.xml',
    slideXml: slideWith(FRAME),
    ctx: {
      diagramDatas: new Map([['rId1', DATA]]),
      ...(drawings ? { diagramDrawings: drawings } : {}),
    },
  })
  const el = slide.elements[0] as PassthroughElement
  return (el.previewShapes ?? []).flatMap((shape) =>
    ((shape as TextElement).text?.paragraphs ?? []).flatMap((p) => p.runs),
  )
}

describe.each([
  ['no cached drawing', undefined],
  ['a cached drawing without the mark', new Map([['rId1', DRAWING]])],
])('a SmartArt whose data holds a hidden run, %s', (_name, drawings) => {
  it('draws no run of its text unmarked', () => {
    const runs = runsOf(drawings).filter((r) => r.text.trim())
    expect(runs.some((r) => r.text.includes(SECRET))).toBe(true)
    for (const run of runs) expect(run.redact, run.text).toBeTruthy()
  })
})

describe('a SmartArt whose data holds no mark', () => {
  it('draws its text as it is', () => {
    const plain = DATA.replace(/<a:extLst>[\s\S]*?<\/a:extLst>/, '')
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml: slideWith(FRAME),
      ctx: { diagramDatas: new Map([['rId1', plain]]) },
    })
    const el = slide.elements[0] as PassthroughElement
    const runs = (el.previewShapes ?? []).flatMap((s) =>
      ((s as TextElement).text?.paragraphs ?? []).flatMap((p) => p.runs),
    )
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.every((r) => r.redact === undefined)).toBe(true)
  })
})
