import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { generateParagraphXml, parseDocx, saveDocx, type Run, type SaveBlock } from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, count, genCtx, HYPERLINK_REL, T } from './helpers/inline-wrap'

const PR =
  '<w:sdtPr><w:id w:val="5"/><w:dataBinding w:xpath="/a" w:storeItemID="{X}"/><w:showingPlcHdr/></w:sdtPr>'
const control = (inner: string) => `<w:sdt>${PR}<w:sdtContent>${inner}</w:sdtContent></w:sdt>`
const smart = (inner: string) => `<w:smartTag w:uri="u" w:element="e">${inner}</w:smartTag>`
const F = (part: string) => `<w:r><w:fldChar w:fldCharType="${part}"/></w:r>`
const field = (instr: string, inner: string) =>
  `${F('begin')}<w:r><w:instrText>${instr}</w:instrText></w:r>${F('separate')}${inner}${F('end')}`
const generated = (runs: Run[]) => generateParagraphXml({ type: 'paragraph', runs }, genCtx())
const original = (doc: Awaited<ReturnType<typeof parseDocx>>): SaveBlock[] =>
  doc.blocks.filter((b) => !b.hidden).map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
async function runsOf(inner: string): Promise<Run[]> {
  return (await parseDocx(await buildDocx({ bodyXml: `<w:p>${inner}</w:p>` }))).blocks[0].runs!
}
describe('header edits outside structure preserve its logical content', () => {
  async function editOutside(inner: string, linked = false): Promise<string> {
    let bytes = await buildWithHeader(`<w:p>${inner}${T(' end')}</w:p>`)
    if (linked) {
      const zip = await JSZip.loadAsync(bytes)
      zip.file(
        'word/_rels/header1.xml.rels',
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${HYPERLINK_REL}</Relationships>`,
      )
      bytes = await zip.generateAsync({ type: 'uint8array' })
    }
    const doc = await parseDocx(bytes)
    const paras = doc.headerParas!.map((p) => ({
      ...p,
      runs: p.runs.map((r) =>
        r.text.includes(' end') ? { ...r, text: r.text.replace(' end', ' enD') } : r,
      ),
    }))
    const saved = await saveDocx(doc, original(doc), { header: { text: '', paras } })
    return (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
  }
  it('a bound control with PAGE and NUMPAGES keeps its exact properties', async () => {
    const xml = await editOutside(
      control(T('Page ') + field('PAGE', T('1')) + T(' of ') + field('NUMPAGES', T('2'))),
    )
    expect(xml).toContain(PR)
    expect(count(xml, '<w:sdt>')).toBe(1)
    expect(xml).toContain(' enD')
    expect(xml).toContain(' NUMPAGES ')
  })
  it('one hyperlink crossing a smart tag stays one hyperlink', async () => {
    const xml = await editOutside(
      `<w:hyperlink r:id="rId20">${T('our ')}${smart(T('Seoul'))}${T(' office')}</w:hyperlink>`,
      true,
    )
    expect(count(xml, '<w:hyperlink ')).toBe(1)
    expect(xml.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '')).toContain(
      `<w:hyperlink r:id="rId20">${T('our ')}${smart(T('Seoul'))}${T(' office')}</w:hyperlink>`,
    )
  })
})

describe('malformed controls never hide readable text in their shell', () => {
  it.each([
    [
      `<w:sdt>${PR}<w:sdtContent>${T('one')}</w:sdtContent><w:sdtContent>${T('two')}</w:sdtContent></w:sdt>`,
      'onetwo',
    ],
    [`<w:sdt>${PR}${T('stray')}<w:sdtContent>${T('in')}</w:sdtContent></w:sdt>`, 'strayin'],
    [`<w:sdt>${PR}<w:sdtContent>${T('in')}</w:sdtContent>${T('stray')}</w:sdt>`, 'instray'],
  ])('all readable children remain visible: %s', async (inner, expected) => {
    const runs = await runsOf(T('a ') + inner + T(' z'))
    expect(runs.map((r) => r.text).join('')).toBe(`a ${expected} z`)
    expect(generated(runs)).toBe(generated([{ text: `a ${expected} z` }]))
  })
})

describe('untrusted inline bytes cannot break a generated paragraph', () => {
  it.each([
    ['<w:sdt><w:sdtContent>', '</w:smartTag>'],
    ['</w:p><w:p><w:r><w:t>INJECTED</w:t></w:r>', ''],
    ['not xml <', '>'],
    ['<w:unknown>', '</w:unknown>'],
    ['<w:smartTag><w:r><w:t>hidden</w:t></w:r>', '</w:smartTag>'],
    ['<w:sdt><w:sdtContent>', '</w:sdtContent><w:sdtContent/></w:sdt>'],
    ['<w:smartTag>hidden', '</w:smartTag>'],
    ['<w:sdt><w:sdtContent>hidden', '</w:sdtContent></w:sdt>'],
  ])('invalid shell is omitted, text is kept: %s', async (open, close) => {
    const runs = [{ text: 'kept', wrap: [{ seq: 1, open, close }] }]
    const source = await buildDocx({ bodyXml: `<w:p>${T('old')}</w:p>` })
    const doc = await parseDocx(source)
    const saved = await saveDocx(doc, [{ kind: 'generated', block: { type: 'paragraph', runs } }])
    const again = await parseDocx(saved)
    expect(again.blocks[0].runs!.map((r) => r.text).join('')).toBe('kept')
    expect(again.internal.documentXml).toContain(`<w:p>${T('kept')}</w:p>`)
  })
})
