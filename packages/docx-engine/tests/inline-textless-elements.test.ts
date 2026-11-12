import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  generateParagraphXml,
  parseDocx,
  patchTableCellTexts,
  saveDocx,
  type Block,
  type Run,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { HYPERLINK_REL, T, buildWithHeader, genCtx } from './helpers/inline-wrap'

/**
 * Run-level elements that hold no text are not carried on the runs: the edit
 * permission and customXml range markers, w:subDoc, and a wrapper with no run
 * in it. They read as if they were not there and a paragraph rebuilt from the
 * model is written without them, as it always was; a paragraph that is not
 * rebuilt keeps them in its own bytes. The values pinned here are what the
 * engine gave before runs carried any structure.
 */

const BOLD = '<w:rPr><w:b/></w:rPr>'
const REV = 'w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"'

const MARKERS: Record<string, string> = {
  'w:permStart': '<w:permStart w:id="7" w:edGrp="everyone"/>',
  'w:permEnd': '<w:permEnd w:id="7"/>',
  'w:customXmlInsRangeStart': `<w:customXmlInsRangeStart ${REV}/>`,
  'w:customXmlInsRangeEnd': '<w:customXmlInsRangeEnd w:id="3"/>',
  'w:customXmlDelRangeStart': `<w:customXmlDelRangeStart ${REV}/>`,
  'w:customXmlDelRangeEnd': '<w:customXmlDelRangeEnd w:id="3"/>',
  'w:customXmlMoveFromRangeStart': `<w:customXmlMoveFromRangeStart ${REV}/>`,
  'w:customXmlMoveFromRangeEnd': '<w:customXmlMoveFromRangeEnd w:id="3"/>',
  'w:customXmlMoveToRangeStart': `<w:customXmlMoveToRangeStart ${REV}/>`,
  'w:customXmlMoveToRangeEnd': '<w:customXmlMoveToRangeEnd w:id="3"/>',
  'w:subDoc': '<w:subDoc r:id="rId20"/>',
}

const EMPTY_CONTROL =
  '<w:sdt><w:sdtPr><w:tag w:val="empty"/><w:id w:val="9"/></w:sdtPr><w:sdtContent/></w:sdt>'
const EMPTY_WRAPPERS: Record<string, string> = {
  'a control with empty content': EMPTY_CONTROL,
  'a control without w:sdtContent':
    '<w:sdt><w:sdtPr><w:tag w:val="bare"/><w:id w:val="10"/></w:sdtPr></w:sdt>',
  'a control holding only a marker': `<w:sdt><w:sdtPr><w:id w:val="9"/></w:sdtPr><w:sdtContent>${MARKERS['w:permStart']}</w:sdtContent></w:sdt>`,
  'a self-closing smart tag': '<w:smartTag w:uri="urn:x" w:element="place"/>',
  'an empty w:customXml': '<w:customXml w:uri="urn:x" w:element="city"></w:customXml>',
  'an empty w:bdo': '<w:bdo w:val="rtl"></w:bdo>',
}

/** the paragraph under test: the element sits between two runs of the same formatting */
const paragraph = (element: string) =>
  `<w:p>${T('Meet ')}${element}${T('Seoul')}${T(' soon', BOLD)}</w:p>`
const TAIL = `<w:p>${T('tail')}</w:p>`

// what the paragraph reads as and rebuilds to, with or without the element
const PINNED_RUNS: Run[] = [{ text: 'Meet Seoul' }, { text: ' soon', rawRPr: BOLD, bold: true }]
const PINNED_XML = `<w:p>${T('Meet Seoul')}${T(' soon', BOLD)}</w:p>`

type Doc = Awaited<ReturnType<typeof parseDocx>>
const read = async (element: string): Promise<Doc> =>
  parseDocx(await buildDocx({ bodyXml: paragraph(element) + TAIL, extraRels: HYPERLINK_REL }))
const bodyOf = async (bytes: Uint8Array): Promise<string> => {
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf('<w:sectPr'))
}
const modelOf = ({ id: _id, originalXml: _xml, inlineContentControls: _c, ...rest }: Block) => rest

/** the element is read as nothing, a rebuild writes nothing of it, an untouched paragraph keeps it */
async function expectNotCarried(element: string): Promise<Doc> {
  const doc = await read(element)
  const [first, tail] = doc.blocks.filter((b) => !b.hidden)
  expect(first.runs!.map(({ effective: _effective, ...run }) => run)).toEqual(PINNED_RUNS)
  // the whole block is the block of the same paragraph without the element
  expect(modelOf(first)).toEqual(modelOf((await read('')).blocks[0]))
  expect(generateParagraphXml({ type: 'paragraph', runs: first.runs! }, genCtx())).toBe(PINNED_XML)

  const rebuilt = await saveDocx(doc, [
    {
      kind: 'generated',
      block: { type: 'paragraph', runs: first.runs! },
      docxIndex: first.docxIndex!,
    },
    { kind: 'original', docxIndex: tail.docxIndex! },
  ])
  expect(await bodyOf(rebuilt)).toBe(PINNED_XML + TAIL)

  const untouched = await saveDocx(doc, [
    { kind: 'original', docxIndex: first.docxIndex! },
    {
      kind: 'generated',
      block: { type: 'paragraph', runs: [{ text: 'new tail' }] },
      docxIndex: tail.docxIndex!,
    },
  ])
  expect(await bodyOf(untouched)).toBe(`${paragraph(element)}<w:p>${T('new tail')}</w:p>`)
  return doc
}

describe('a text-less marker is not carried on the runs', () => {
  it.each(Object.entries(MARKERS))('%s', async (_name, marker) => {
    const doc = await expectNotCarried(marker)
    expect(doc.blocks[0].inlineContentControls).toBeUndefined()
  })
})

describe('a wrapper that holds no run is not carried on the runs', () => {
  it.each(Object.entries(EMPTY_WRAPPERS))('%s', async (_name, wrapper) => {
    await expectNotCarried(wrapper)
  })

  it('an empty control is still reported as an inline control of its paragraph', async () => {
    const doc = await read(EMPTY_CONTROL)
    expect(doc.blocks[0].inlineContentControls).toEqual([
      { tag: 'empty', title: '', lock: '', id: '9', text: '' },
    ])
  })
})

describe('the same elements inside a container', () => {
  const INNER = `${MARKERS['w:permStart']}${T('Seoul')}${EMPTY_CONTROL}${MARKERS['w:permEnd']}`

  it('table cell: the paragraph reads as one run and a rebuilt cell is written without them', async () => {
    const table =
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${INNER}</w:p></w:tc></w:tr></w:tbl>`
    const doc = await parseDocx(await buildDocx({ bodyXml: table }))
    const block = doc.blocks.find((b) => b.type === 'table')!
    const runs = block.table!.rows[0][0].richParas![0].runs
    expect(runs.map(({ effective: _effective, ...run }) => run)).toEqual([{ text: 'Seoul' }])
    const patched = patchTableCellTexts(block.originalXml!, [[[{ runs: [{ text: 'Busan' }] }]]])
    expect(patched).toContain(`<w:p>${T('Busan')}</w:p>`)
    expect(patched).not.toContain('w:permStart')
    expect(patched).not.toContain('<w:sdt>')
  })

  it('header: the line reads as one run and a rewritten header is written without them', async () => {
    const doc = await parseDocx(await buildWithHeader(`<w:p>${INNER}</w:p>`))
    expect(doc.headerParas!.map((p) => p.runs.map((r) => r.text))).toEqual([['Seoul']])
    const paras = doc.headerParas!.map((p) => ({
      ...p,
      runs: p.runs.map((r) => ({ ...r, text: 'Busan' })),
    }))
    const saved = await saveDocx(
      doc,
      doc.blocks
        .filter((b) => !b.hidden)
        .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
      { header: { text: '', paras } },
    )
    const header = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(header).toContain('Busan')
    expect(header).not.toContain('w:permStart')
    expect(header).not.toContain('w:permEnd')
    expect(header).not.toContain('<w:sdt>')
  })
})
