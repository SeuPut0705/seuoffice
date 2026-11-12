import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  compareDocuments,
  generateParagraphXml,
  parseDocx,
  saveDocx,
  type Run,
  type SaveBlock,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, count, genCtx, HYPERLINK_REL, T } from './helpers/inline-wrap'

const PS = '<w:permStart w:id="7" w:edGrp="everyone"/>'
const PE = '<w:permEnd w:id="7"/>'
const REF = '<w:r><w:commentReference w:id="0"/></w:r>'
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
const COMMENTS =
  '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>'

describe('text-less inline elements do not become neighbouring text', () => {
  it.each([
    [T('noted') + PE + REF, 'noted'],
    [REF + PS + T('noted'), 'noted'],
    [T('noted') + control('') + REF, 'noted'],
    [REF + control('') + T('noted'), 'noted'],
  ])('a reference-only comment keeps its text anchor: %s', async (inner, expected) => {
    const doc = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${inner}</w:p>`,
        extraRels:
          '<Relationship Id="rId60" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>',
        extraParts: [
          {
            path: 'word/comments.xml',
            xml: COMMENTS,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          },
        ],
      }),
    )
    expect(
      doc.blocks[0].runs!.filter((r) => r.commentIds?.includes('0')).map((r) => r.text),
    ).toEqual([expected])
    const xml = generated(doc.blocks[0].runs!)
    expect(xml).toContain(
      `<w:commentRangeStart w:id="0"/>${T('noted')}<w:commentRangeEnd w:id="0"/>`,
    )
  })

  it('a collapsed checkbox never takes its glyph payload from a marker', async () => {
    const checkbox = `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent>${PS}</w:sdtContent></w:sdt>`
    const runs = await runsOf(checkbox)
    expect(runs.map((r) => r.text).join('')).toBe('☒')
    const xml = generated(runs)
    expect(xml).toContain('☒')
    expect(xml).toContain('<w14:checkbox>')
    expect(xml).not.toContain('permStart')
  })

  it('comparison preserves revised zero-width elements once at their text offsets', async () => {
    const read = async (text: string) =>
      parseDocx(await buildDocx({ bodyXml: `<w:p>${PS}${T(text)}${PE}${control('')}</w:p>` }))
    const left = await read('old name')
    const right = await read('new name')
    const result = await compareDocuments(left, right)
    const xml = (await parseDocx(result.bytes)).internal.documentXml
    expect(count(xml, PS)).toBe(1)
    expect(count(xml, PE)).toBe(1)
    expect(count(xml, PR)).toBe(1)
    expect(xml.indexOf(PS)).toBeLessThan(xml.indexOf('new'))
    expect(xml.indexOf(PE)).toBeGreaterThan(xml.indexOf('name'))
  })

  for (const instr of ['PAGE', 'REF bm', 'MERGEFIELD Name']) {
    it.each([true, false])(
      `markers inside a folded ${instr} result are not moved (simple=%s)`,
      async (simple) => {
        const inner = PS + T('result') + PE
        const xml = simple
          ? `<w:fldSimple w:instr="${instr}">${inner}</w:fldSimple>`
          : field(instr, inner)
        const plain = simple
          ? `<w:fldSimple w:instr="${instr}">${T('result')}</w:fldSimple>`
          : field(instr, T('result'))
        expect(generated(await runsOf(xml))).toBe(generated(await runsOf(plain)))
      },
    )
  }
})

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
  it.each([
    '</w:p><w:p>',
    '<w:unknown/>',
    '<w:permStart/><w:permEnd/>',
    '<w:permStart><w:r><w:t>hidden</w:t></w:r></w:permStart>',
    '<w:sdt><w:sdtContent><w:r><w:t>hidden</w:t></w:r></w:sdtContent></w:sdt>',
  ])('invalid opaque element is omitted, text is kept: %s', (opaqueXml) => {
    expect(generated([{ text: 'kept', opaqueXml }])).toBe(`<w:p>${T('kept')}</w:p>`)
  })
  it('valid bare nested controls and paired markers keep their exact bytes', async () => {
    const inner = control(control('')) + '<w:permEnd w:id="7"></w:permEnd>'
    expect(generated(await runsOf(T('a') + inner + T('z')))).toBe(
      `<w:p>${T('a')}${inner}${T('z')}</w:p>`,
    )
  })
})
