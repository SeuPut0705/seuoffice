import { describe, expect, it } from 'vitest'
import { generateParagraphXml, parseDocx, type Block, type Run } from '../src/index'
import { buildDocx } from './helpers/build-docx'
import {
  HYPERLINK_REL,
  T,
  WRAPPERLESS_PARAGRAPHS,
  buildWithHeader,
  genCtx,
  withoutInlineStructure,
} from './helpers/inline-wrap'

/**
 * Carrying run-level wrappers on the runs must not change what a document
 * reads as. Two guards:
 *
 * - a document with none of that structure reads, and rebuilds, to exactly
 *   what is pinned here (the values the engine gave before the runs carried
 *   anything);
 * - a document WITH wrappers, text-less markers or empty wrappers reads as
 *   the same document without them, once the wrappers are taken off the
 *   runs: no text read twice, no paragraph that was empty turning non-empty,
 *   no property child surfacing as content.
 */

const REV = 'w:author="Ada" w:date="2024-01-01T00:00:00Z"'
const LINK_STYLE = '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>'
const D = (text: string) => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`
const F = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
const I = (instr: string) => `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>`
const ada = (id: string) => ({ author: 'Ada', date: '2024-01-01T00:00:00Z', id })
const link = { href: 'https://example.com/', rId: 'rId20', tooltip: 'tip' }

/** per paragraph of WRAPPERLESS_PARAGRAPHS: the runs it reads as, the xml they rebuild to */
const PINNED: Array<{ runs: Run[]; xml: string }> = [
  {
    runs: [
      { text: 'plain ' },
      { text: 'bold', rawRPr: '<w:rPr><w:b/></w:rPr>', bold: true },
      {
        text: ' red 14',
        rawRPr: '<w:rPr><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr>',
        sizeHalfPoints: 28,
        color: 'FF0000',
      },
      { text: ' & <tail>' },
    ],
    xml: WRAPPERLESS_PARAGRAPHS[0],
  },
  {
    runs: [
      { text: 'see ' },
      { text: 'site', link, rawRPr: LINK_STYLE, styleId: 'Hyperlink' },
      { text: ' map', link },
      { text: 'up', link: { href: '#top', plain: true } },
    ],
    xml:
      `<w:p>${T('see ')}<w:hyperlink r:id="rId20" w:tooltip="tip">${T('site', LINK_STYLE)}${T(' map', LINK_STYLE)}</w:hyperlink>` +
      `<w:hyperlink w:anchor="top">${T('up')}</w:hyperlink></w:p>`,
  },
  {
    runs: [
      { text: 'kept ' },
      { text: 'added', ins: ada('11') },
      { text: 'gone', del: ada('12') },
      { text: 'both', ins: ada('13'), del: ada('14') },
      { text: ' end' },
    ],
    xml:
      `<w:p>${T('kept ')}<w:ins w:id="11" ${REV}>${T('added')}</w:ins><w:del w:id="12" ${REV}>${D('gone')}</w:del>` +
      `<w:ins w:id="13" ${REV}><w:del w:id="14" ${REV}>${D('both')}</w:del></w:ins>${T(' end')}</w:p>`,
  },
  {
    runs: [{ text: 'moved', del: { ...ada('22'), move: 'move1' } }, { text: ' stays' }],
    xml:
      `<w:p><w:moveFromRangeStart w:id="700" ${REV} w:name="move1"/><w:moveFrom w:id="22" ${REV}>${D('moved')}</w:moveFrom>` +
      `<w:moveFromRangeEnd w:id="700"/>${T(' stays')}</w:p>`,
  },
  {
    runs: [{ text: 'a ' }, { text: 'noted', commentIds: ['0'] }, { text: ' z' }],
    xml: WRAPPERLESS_PARAGRAPHS[4],
  },
  {
    runs: [
      { text: 'page ' },
      { text: '3', instrField: 'PAGE' },
      { text: ' ref ' },
      { text: 'target', refField: 'bm', refInstr: ' REF bm \\h ' },
      { text: '', xeTerm: 'term' },
    ],
    xml:
      `<w:p>${T('page ')}${F('begin')}${I(' PAGE ')}${F('separate')}${T('3')}${F('end')}${T(' ref ')}` +
      `${F('begin')}${I(' REF bm \\h ')}${F('separate')}${T('target')}${F('end')}` +
      `${F('begin')}${I(' XE "term" ')}${F('end')}</w:p>`,
  },
  {
    runs: [
      { text: 'tab\tbreak\nhy\u2011phen' },
      { text: '\u2713', sym: { font: 'Wingdings', char: 'F0FC' } },
    ],
    xml:
      '<w:p><w:r><w:t xml:space="preserve">tab</w:t><w:tab/><w:t xml:space="preserve">break</w:t><w:br/>' +
      '<w:t xml:space="preserve">hy</w:t><w:noBreakHyphen/><w:t xml:space="preserve">phen</w:t></w:r>' +
      '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p>',
  },
  {
    runs: [
      { text: 'speling note' },
      {
        text: '*',
        noteRef: { kind: 'footnote', id: '2' },
        rawRPr: '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>',
      },
    ],
    xml:
      `<w:p><w:bookmarkStart w:id="40" w:name="bm"/><w:bookmarkEnd w:id="40"/>${T('speling note')}` +
      '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>',
  },
]

describe('a document without wrappers reads and rebuilds as it always did', () => {
  it('every paragraph: the pinned runs, and the pinned xml when rebuilt from them', async () => {
    const doc = await parseDocx(
      await buildDocx({ bodyXml: WRAPPERLESS_PARAGRAPHS.join(''), extraRels: HYPERLINK_REL }),
    )
    const paras = doc.blocks.filter((b) => !b.hidden)
    expect(paras).toHaveLength(PINNED.length)
    paras.forEach((block, i) => {
      const runs = block.runs!.map(({ effective: _effective, ...run }) => run)
      expect(runs, `runs of paragraph ${i}`).toEqual(PINNED[i].runs)
      const xml = generateParagraphXml(
        {
          type: 'paragraph',
          runs: block.runs!,
          bookmarks: block.bookmarks,
          hiddenBookmarks: block.hiddenBookmarks,
        },
        { ...genCtx(), allocateBookmarkId: () => 40 },
      )
      expect(xml, `xml of paragraph ${i}`).toBe(PINNED[i].xml)
    })
  })
})

// ---- the same document with and without the structure ----

const PERM = { open: '<w:permStart w:id="7" w:edGrp="everyone"/>', close: '<w:permEnd w:id="7"/>' }
const SMART = {
  open: '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="PersonName">',
  close: '</w:smartTag>',
}
const SDT = {
  open: '<w:sdt><w:sdtPr><w:tag w:val="t"/><w:id w:val="9"/></w:sdtPr><w:sdtContent>',
  close: '</w:sdtContent></w:sdt>',
}
const field = (instr: string, result: string) =>
  `${F('begin')}${I(instr)}${F('separate')}${result}${F('end')}`
const SIZED_MARK = '<w:pPr><w:rPr><w:sz w:val="40"/></w:rPr></w:pPr>'

/** [what it shows, paragraph content with the structure, the same content without it] */
const PARAGRAPHS: Array<[string, string, string]> = [
  [
    'a smart tag inside a HYPERLINK field result',
    `${T('See ')}${field(' HYPERLINK "mailto:kim@example.test" ', SMART.open + T('kim@example.test', LINK_STYLE) + SMART.close)}${T(' now')}`,
    `${T('See ')}${field(' HYPERLINK "mailto:kim@example.test" ', T('kim@example.test', LINK_STYLE))}${T(' now')}`,
  ],
  [
    'a smart tag inside a REF field result',
    `${T('See ')}${field(' REF bm \\h ', SMART.open + T('Seoul') + SMART.close)}`,
    `${T('See ')}${field(' REF bm \\h ', T('Seoul'))}`,
  ],
  [
    'a control inside a PAGE field result',
    `${T('Page ')}${field(' PAGE ', SDT.open + T('3') + SDT.close)}`,
    `${T('Page ')}${field(' PAGE ', T('3'))}`,
  ],
  [
    'a field that begins inside a control and ends after it',
    `${T('a ')}${SDT.open}${F('begin')}${I(' DATE ')}${F('separate')}${T('1 May')}${SDT.close}${F('end')}${T(' z')}`,
    `${T('a ')}${field(' DATE ', T('1 May'))}${T(' z')}`,
  ],
  [
    'a field that begins before a control and ends inside it',
    `${T('a ')}${F('begin')}${I(' DATE ')}${F('separate')}${SDT.open}${T('1 May')}${F('end')}${SDT.close}${T(' z')}`,
    `${T('a ')}${field(' DATE ', T('1 May'))}${T(' z')}`,
  ],
  [
    'a w:fldSimple that opens with an edit-permission marker',
    `<w:fldSimple w:instr=" PAGE ">${PERM.open}${T('3', '<w:rPr><w:b/></w:rPr>')}${PERM.close}</w:fldSimple>`,
    `<w:fldSimple w:instr=" PAGE ">${T('3', '<w:rPr><w:b/></w:rPr>')}</w:fldSimple>`,
  ],
  [
    'an empty line holding only edit-permission markers (the mark sizes it)',
    `${SIZED_MARK}${PERM.open}${PERM.close}`,
    SIZED_MARK,
  ],
  [
    'an empty line holding only an empty control',
    `${SIZED_MARK}<w:sdt><w:sdtPr><w:id w:val="9"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent/></w:sdt>`,
    SIZED_MARK,
  ],
  [
    'a space-only line beside a marker',
    `${SIZED_MARK}${PERM.open}${T(' ', '<w:rPr><w:sz w:val="12"/></w:rPr>')}${PERM.close}`,
    `${SIZED_MARK}${T(' ', '<w:rPr><w:sz w:val="12"/></w:rPr>')}`,
  ],
  [
    'a tracked insertion of a control, part of it deleted again (not carried)',
    `<w:ins w:id="5" ${REV}>${SDT.open}${T('new ')}<w:del w:id="6" ${REV}>${D('old')}</w:del>${SDT.close}</w:ins>`,
    `<w:ins w:id="5" ${REV}>${T('new ')}<w:del w:id="6" ${REV}>${D('old')}</w:del></w:ins>`,
  ],
  [
    'a smart tag in a hyperlink holding a tracked insertion (not carried)',
    `<w:hyperlink r:id="rId20">${SMART.open}<w:ins w:id="5" ${REV}>${T('Kim')}</w:ins>${SMART.close}</w:hyperlink>`,
    `<w:hyperlink r:id="rId20"><w:ins w:id="5" ${REV}>${T('Kim')}</w:ins></w:hyperlink>`,
  ],
  [
    'nested wrappers with markers at every depth',
    `${PERM.open}${T('a ')}<w:hyperlink r:id="rId20">${SMART.open}${T('Kim ')}${SDT.open}${T('Seoul')}${SDT.close}${SMART.close}${PERM.close}${T(' x')}</w:hyperlink>`,
    `${T('a ')}<w:hyperlink r:id="rId20">${T('Kim ')}${T('Seoul')}${T(' x')}</w:hyperlink>`,
  ],
]

const blockModel = ({ id: _id, originalXml: _xml, inlineContentControls: _c, ...rest }: Block) =>
  withoutInlineStructure(rest)

describe('structure the runs carry does not change what a paragraph reads as', () => {
  for (const [name, withIt, withoutIt] of PARAGRAPHS) {
    it(`body: ${name}`, async () => {
      const read = async (content: string) =>
        (
          await parseDocx(
            await buildDocx({ bodyXml: `<w:p>${content}</w:p>`, extraRels: HYPERLINK_REL }),
          )
        ).blocks[0]
      expect(blockModel(await read(withIt))).toEqual(blockModel(await read(withoutIt)))
    })

    it(`table cell: ${name}`, async () => {
      const read = async (content: string) => {
        const table =
          '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
          `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${content}</w:p></w:tc></w:tr></w:tbl>`
        const doc = await parseDocx(await buildDocx({ bodyXml: table, extraRels: HYPERLINK_REL }))
        return withoutInlineStructure(doc.blocks.find((b) => b.type === 'table')!.table)
      }
      expect(await read(withIt)).toEqual(await read(withoutIt))
    })

    it(`header: ${name}`, async () => {
      const read = async (content: string) => {
        const doc = await parseDocx(
          await buildWithHeader(`<w:p>${content}</w:p><w:p>${T('Title')}</w:p>`, {
            extraRels: HYPERLINK_REL,
          }),
        )
        return withoutInlineStructure({ text: doc.headerText, paras: doc.headerParas })
      }
      const [a, b] = [await read(withIt), await read(withoutIt)]
      expect(a).toEqual(b)
    })
  }

  it('property children of a container the walk enters are not paragraph content', async () => {
    const body =
      `<w:p>${T('a ')}<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr>` +
      `<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>${T(' z')}</w:p>` +
      `<w:p>${T('a ')}<w:fldSimple w:instr=" AUTHOR "><w:fldData xml:space="preserve">AAAA</w:fldData>${T('Kim')}</w:fldSimple></w:p>` +
      `<w:p>${T('a ')}<w15:unknownThing xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>${T('b')}</w:p>`
    const cell = (inner: string) =>
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>`
    const doc = await parseDocx(await buildDocx({ bodyXml: body + cell(body) }))
    // (the display-equation paragraph of the body is a protected block: no runs)
    const bodyRuns = doc.blocks.filter((b) => b.runs).map((b) => b.runs!)
    const cellRuns = doc.blocks
      .find((b) => b.type === 'table')!
      .table!.rows[0][0].richParas!.map((p) => p.runs)
    expect(cellRuns).toHaveLength(3)
    expect(cellRuns.map((runs) => runs.map((r) => r.text).join(''))).toEqual([
      'a x z',
      'a Kim',
      'a b',
    ])
    for (const runs of [...bodyRuns, ...cellRuns]) {
      expect(runs.filter((r) => r.wrap)).toEqual([])
    }
  })

  it("a header's watermark control (a control holding only a picture) leaves its line empty", async () => {
    const watermark =
      '<w:r><w:rPr><w:noProof/></w:rPr><w:pict><v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" ' +
      'style="position:absolute;margin-left:0;margin-top:0;width:412pt;height:247pt;rotation:315;z-index:-251658752" ' +
      'fillcolor="silver" stroked="f"><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/></v:shape></w:pict></w:r>'
    const control =
      '<w:sdt><w:sdtPr><w:id w:val="-1964490184"/><w:docPartObj><w:docPartGallery w:val="Watermarks"/>' +
      `<w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${watermark}</w:sdtContent></w:sdt>`
    const read = async (inner: string) =>
      parseDocx(await buildWithHeader(`<w:p>${inner}</w:p><w:p>${T('Title')}</w:p>`))
    const doc = await read(control)
    // the line of the watermark's paragraph is sized as an empty line: no run on it
    expect(doc.headerParas!.map((p) => p.runs.map((r) => r.text))).toEqual([[], ['Title']])
    expect(doc.headerText).toBe('Title')
    expect(doc.watermarkText).toBe('DRAFT')
  })

  it('text box: a line holding only a marker is still an empty line of the box', async () => {
    const box = (inner: string) =>
      '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" type="#_x0000_t202" ' +
      'style="width:200pt;height:50pt"><v:textbox>' +
      `<w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const read = async (inner: string) => {
      const doc = await parseDocx(await buildDocx({ bodyXml: box(inner) }))
      const { id: _id, originalXml: _xml, ...block } = doc.blocks[0]
      return withoutInlineStructure(block)
    }
    expect(await read(`<w:p>${SIZED_MARK}${PERM.open}${PERM.close}</w:p>`)).toEqual(
      await read(`<w:p>${SIZED_MARK}</w:p>`),
    )
    expect(await read(`<w:p>${PERM.open}${T(' ')}${PERM.close}</w:p><w:p>${T('x')}</w:p>`)).toEqual(
      await read(`<w:p>${T(' ')}</w:p><w:p>${T('x')}</w:p>`),
    )
  })
})
