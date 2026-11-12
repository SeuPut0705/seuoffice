/**
 * A document may write, where the engine looks a value up in a table of its own, a name every
 * JavaScript object answers to: `constructor`, `toString`, `valueOf`, `hasOwnProperty` give a
 * function and `__proto__` gives Object.prototype. One such value in a theme, a table style id,
 * a group or a diagram made parseSlide throw, and the deck did not open at all. Each is read
 * as the unknown value it is; the slide opens with everything else on it.
 * (Inputs from the Rust port's divergence ledger: inherited-key-theme-clrmap,
 * inherited-key-table-style-id, grpsppr-string-in, dgm-style-idx-negative,
 * dgm-style-idx-infinite, inherited-key-color-prst.)
 */
import { describe, expect, it } from 'vitest'
import { createBlankPptx, openPptx, parseSlide, savePptx, type OpenedPptx } from '../src/index'
import { resolveColorNode } from '../src/color'
import { parseTheme, resolveSchemeColor, parseClrMap } from '../src/theme'
import { resolveTableStyle } from '../src/table-style'
import { parseChartXml } from '../src/chart'
import type { GroupElement, PassthroughElement, TableElement, TextElement } from '../src/types'

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
const MASTER = 'ppt/slideMasters/slideMaster1.xml'
const SLIDE = 'ppt/slides/slide1.xml'

/** A blank deck with `edit` applied to one of its parts, saved and opened again. */
async function deckWith(path: string, edit: (xml: string) => string): Promise<OpenedPptx> {
  const built = await openPptx(await createBlankPptx())
  built.archive.entries.set(path, Buffer.from(edit(built.archive.readText(path)!), 'utf8'))
  return openPptx(await savePptx(built))
}

const onSlide = (shapes: string) => (xml: string) =>
  xml.replace('</p:spTree>', () => `${shapes}</p:spTree>`)

const SHAPE =
  '<p:sp><p:nvSpPr><p:cNvPr id="40" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>kept</a:t></a:r></a:p></p:txBody></p:sp>'

describe('a master clrMap naming an inherited key, with no background to fall back on', () => {
  it.each(INHERITED)('bg1="%s": the deck opens, with no background', async (name) => {
    const opened = await deckWith(MASTER, (xml) => xml.replace('bg1="lt1"', () => `bg1="${name}"`))
    expect(opened.deck.slides).toHaveLength(1)
    expect(opened.deck.slides[0]!.background).toBeUndefined()
  })

  it.each(INHERITED)('a scheme color the map sends to "%s" is unresolved', async (name) => {
    const built = await openPptx(await createBlankPptx())
    const theme = parseTheme(built.archive.readText('ppt/theme/theme1.xml')!)
    theme.clrMap = parseClrMap(
      built.archive.readText(MASTER)!.replace('bg1="lt1"', () => `bg1="${name}"`),
    )
    expect(resolveSchemeColor('bg1', theme)).toBeUndefined()
    const node = { 'a:schemeClr': { '@_val': 'bg1', 'a:lumMod': { '@_val': '50000' } } }
    expect(resolveColorNode(node, theme)).toBeUndefined()
    // a scheme name that is itself an inherited key is no slot either
    expect(resolveSchemeColor(name, theme)).toBeUndefined()
  })
})

describe('a preset color naming an inherited key', () => {
  it.each([...INHERITED, 'isPrototypeOf', 'Constructor', 'ToString', 'ValueOf'])(
    '<a:prstClr val="%s"/> is unresolved, and the shape keeps its words',
    async (name) => {
      expect(resolveColorNode({ 'a:prstClr': { '@_val': name } }, undefined)).toBeUndefined()
      const opened = await deckWith(
        SLIDE,
        onSlide(
          SHAPE.replace(
            '</p:spPr>',
            `<a:solidFill><a:prstClr val="${name}"/></a:solidFill></p:spPr>`,
          ),
        ),
      )
      const box = opened.deck.slides[0]!.elements.find((e) => e.name === 'Box') as TextElement
      expect(box.fill).toBeUndefined()
      expect(box.text!.paragraphs[0]!.runs[0]!.text).toBe('kept')
    },
  )
})

describe('a table style id naming an inherited key, defined nowhere', () => {
  const table = (styleId: string) =>
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="41" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="0" y="0"/><a:ext cx="200" cy="100"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<a:tbl><a:tblPr firstRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>` +
    '<a:tblGrid><a:gridCol w="200"/></a:tblGrid>' +
    '<a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>' +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

  it.each(INHERITED)('"%s": no style, and the table is on the slide', async (name) => {
    expect(resolveTableStyle(name, undefined, undefined)).toBeUndefined()
    const opened = await deckWith(SLIDE, onSlide(table(name)))
    expect(opened.deck.slides[0]!.elements.map((e) => e.type)).toContain('table')
  })
})

describe('a group whose grpSpPr is empty or holds only text', () => {
  const group = (grpSpPr: string) =>
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="42" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `${grpSpPr}${SHAPE}</p:grpSp>`

  it.each(['<p:grpSpPr/>', '<p:grpSpPr></p:grpSpPr>', '<p:grpSpPr>text</p:grpSpPr>'])(
    '%s: the group and its shape are read',
    async (grpSpPr) => {
      const opened = await deckWith(SLIDE, onSlide(group(grpSpPr)))
      const g = opened.deck.slides[0]!.elements.find((e) => e.type === 'group') as GroupElement
      expect(g.children).toHaveLength(1)
      expect((g.children[0] as TextElement).fill).toBeUndefined()
    },
  )
})

// The same flaw as the group's: an element that holds only text parses as a string, and a
// reader that asks a string for a child with `in` throws.
describe('shape, cell and chart properties that hold only text', () => {
  it('a shape whose spPr holds only text keeps its words, with no fill', async () => {
    const opened = await deckWith(
      SLIDE,
      onSlide(SHAPE.replace(/<p:spPr>[\s\S]*?<\/p:spPr>/, '<p:spPr>text</p:spPr>')),
    )
    const box = opened.deck.slides[0]!.elements.find((e) => e.name === 'Box') as TextElement
    expect(box.fill).toBeUndefined()
    expect(box.text!.paragraphs[0]!.runs[0]!.text).toBe('kept')
  })

  it('a table cell whose tcPr holds only text keeps its words', async () => {
    const frame =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="41" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="200" cy="100"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      '<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="200"/></a:tblGrid>' +
      '<a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody><a:tcPr>text</a:tcPr></a:tc></a:tr>' +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    const opened = await deckWith(SLIDE, onSlide(frame))
    const table = opened.deck.slides[0]!.elements.find((e) => e.type === 'table') as TableElement
    expect(table.rows[0]![0]!.text!.paragraphs[0]!.runs[0]!.text).toBe('cell')
  })

  it.each([
    ['the series spPr', '<c:spPr>text</c:spPr>'],
    ['a data point spPr', '<c:dPt><c:idx val="0"/><c:spPr>text</c:spPr></c:dPt>'],
  ])('a bar chart whose %s holds only text is read', (_where, xml) => {
    const chart =
      '<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/>' +
      `<c:ser><c:idx val="0"/><c:order val="0"/>${xml}` +
      '<c:cat><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>' +
      '</c:barChart></c:plotArea></c:chart></c:chartSpace>'
    expect(parseChartXml(chart, undefined)?.series[0]!.values).toEqual([1])
  })
})

describe('a SmartArt point whose presStyleIdx is no slot', () => {
  const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
  const data = (idx: string) =>
    `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>` +
    '<dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>' +
    '<dgm:pt modelId="1"><dgm:prSet phldrT="[Text]"/><dgm:spPr></dgm:spPr><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Negative</a:t></a:r></a:p></dgm:t></dgm:pt>' +
    '<dgm:pt modelId="2"><dgm:prSet phldrT="[Text]"/><dgm:spPr></dgm:spPr><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Next</a:t></a:r></a:p></dgm:t></dgm:pt>' +
    `<dgm:pt modelId="p1" type="pres"><dgm:prSet presAssocID="1" presName="node" presStyleLbl="node1" presStyleIdx="${idx}" presStyleCnt="3"></dgm:prSet><dgm:spPr/></dgm:pt>` +
    '</dgm:ptLst><dgm:cxnLst><dgm:cxn modelId="c1" srcId="0" destId="1" srcOrd="0" destOrd="0"/><dgm:cxn modelId="c2" srcId="0" destId="2" srcOrd="1" destOrd="0"/></dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>'
  const LAYOUT = `<dgm:layoutDef xmlns:dgm="${DGM}" uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/default"><dgm:title val=""/><dgm:desc val=""/></dgm:layoutDef>`
  const COLORS =
    `<dgm:colorsDef xmlns:dgm="${DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2">` +
    '<dgm:styleLbl name="node0"><dgm:fillClrLst meth="repeat"><a:srgbClr val="112233"/></dgm:fillClrLst></dgm:styleLbl>' +
    '<dgm:styleLbl name="node1"><dgm:fillClrLst meth="repeat"><a:srgbClr val="C00000"/><a:srgbClr val="00B050"/><a:srgbClr val="7030A0"/></dgm:fillClrLst></dgm:styleLbl>' +
    '</dgm:colorsDef>'
  const FRAME =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="24" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="1524000" y="1397000"/><a:ext cx="8128000" cy="5418667"/></p:xfrm>' +
    `<a:graphic><a:graphicData uri="${DGM}"><dgm:relIds xmlns:dgm="${DGM}" r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/></a:graphicData></a:graphic></p:graphicFrame>`

  it.each(['-1', '-4', '9'.repeat(400)])(
    'presStyleIdx="%s": the node takes the color cycle',
    (idx) => {
      const slide = parseSlide({
        path: SLIDE,
        slideXml:
          '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="r" xmlns:p="p">' +
          `<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${FRAME}</p:spTree></p:cSld></p:sld>`,
        ctx: {
          diagramDatas: new Map([['rId2', data(idx)]]),
          diagramLayouts: new Map([['rId3', LAYOUT]]),
          diagramColors: new Map([['rId5', COLORS]]),
        },
      })
      const frame = slide.elements[0] as PassthroughElement
      const fills = frame.previewShapes!.map((s) => (s as TextElement).fill)
      expect(fills).toEqual([
        { type: 'solid', color: '#C00000' },
        { type: 'solid', color: '#00B050' },
      ])
    },
  )
})
