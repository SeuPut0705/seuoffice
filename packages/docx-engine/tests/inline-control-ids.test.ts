import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  generateTableModelXml,
  parseDocx,
  saveDocx,
  patchTableCellTexts,
  patchTextboxParas,
  type Run,
  type SaveBlock,
} from '../src/index'
import { buildDocx } from './helpers/build-docx'
import { buildWithHeader, count, T } from './helpers/inline-wrap'

const C = (text: string, id = '7') =>
  `<w:sdt><w:sdtPr><w:id w:val="${id}"/></w:sdtPr><w:sdtContent>${T(text)}</w:sdtContent></w:sdt>`
const P = (text: string) => `<w:p>${C(text)}</w:p>`
const table = (a: string, b: string) =>
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${a}</w:tc><w:tc><w:tcPr/>${b}</w:tc></w:tr></w:tbl>`
const originals = (doc: Awaited<ReturnType<typeof parseDocx>>): SaveBlock[] =>
  doc.blocks.filter((b) => !b.hidden).map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
const generated = (runs: Run[]): SaveBlock => ({
  kind: 'generated',
  block: { type: 'paragraph', runs },
})
async function part(bytes: Uint8Array, path = 'word/document.xml'): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file(path)!.async('string')
}

describe('only engine-generated controls yield a duplicate id in their own part', () => {
  it('an unedited source with duplicate ids stays byte-identical', async () => {
    const source = await buildDocx({ bodyXml: P('first') + P('second') })
    const doc = await parseDocx(source)
    expect(await saveDocx(doc, originals(doc))).toEqual(source)
  })

  it.each([true, false])(
    'copied original wins regardless of generated position (generated first=%s)',
    async (first) => {
      const doc = await parseDocx(await buildDocx({ bodyXml: P('original') }))
      const g = generated(doc.blocks[0].runs!.map((r) => ({ ...r, text: 'generated' })))
      const o = originals(doc)[0]
      const xml = await part(await saveDocx(doc, first ? [g, o] : [o, g]))
      expect(count(xml, '<w:sdt>')).toBe(1)
      expect(xml).toContain(P('original'))
      expect(xml).toContain(`<w:p>${T('generated')}</w:p>`)
    },
  )

  it('the first of two generated paragraphs keeps the id', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: P('first') }))
    const runs = doc.blocks[0].runs!
    const xml = await part(
      await saveDocx(doc, [
        generated(runs),
        generated(runs.map((r) => ({ ...r, text: 'second' }))),
      ]),
    )
    expect(xml).toContain(P('first'))
    expect(xml).toContain(`<w:p>${T('second')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it('verbatim xml reserves its ids and bytes even after a generated paragraph', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: P('first') }))
    const raw = `<!--seuoffice-inline-generated:start-->${P('verbatim').replace('w:val="7"', "w:val='7'")}<!--seuoffice-inline-generated:end-->`
    const xml = await part(
      await saveDocx(doc, [generated(doc.blocks[0].runs!), { kind: 'xml', xml: raw }]),
    )
    expect(xml).toContain(raw)
    expect(xml).toContain(`<w:p>${T('first')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it('header and body are separate id scopes; two generated header paragraphs are not', async () => {
    const doc = await parseDocx(await buildWithHeader(P('header'), { bodyXml: P('body') }))
    const p = doc.headerParas![0]
    const bytes = await saveDocx(doc, originals(doc), {
      header: {
        text: '',
        paras: [p, { ...p, runs: p.runs.map((r) => ({ ...r, text: 'second' })) }],
      },
    })
    expect(await part(bytes)).toContain(P('body'))
    const hdr = await part(bytes, 'word/header1.xml')
    expect(count(hdr, '<w:sdt>')).toBe(1)
    expect(hdr).toContain(C('header'))
    expect(hdr).toContain(T('second'))
  })

  it('an untouched header table reserves its id before generated header text', async () => {
    const doc = await parseDocx(
      await buildWithHeader(P('header') + table(P('original cell'), '<w:p/>')),
    )
    const bytes = await saveDocx(doc, originals(doc), {
      header: { text: '', paras: doc.headerParas! },
    })
    const hdr = await part(bytes, 'word/header1.xml')
    expect(hdr).toContain(P('original cell'))
    expect(count(hdr, '<w:sdt>')).toBe(1)
    expect(hdr).toContain(T('header'))
  })

  it('an untouched table cell reserves its id before a generated cell', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: table(P('edited'), P('original')) }))
    const b = doc.blocks.find((b) => b.table)!
    const runs = b.table!.rows[0][0].richParas![0].runs
    const xml = patchTableCellTexts(b.originalXml!, [[[{ runs }], null]])
    expect(xml).toContain(P('original'))
    expect(xml).toContain(`<w:p>${T('edited')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })

  it.each([false, true])(
    'a fully regenerated table shares one id scope across cells (original properties=%s)',
    async (keepProperties) => {
      const doc = await parseDocx(await buildDocx({ bodyXml: table(P('first'), P('second')) }))
      const b = doc.blocks.find((b) => b.table)!
      const xml = generateTableModelXml(b.table!, keepProperties ? b.originalXml! : undefined)
      expect(count(xml, '<w:sdt>')).toBe(1)
      expect(xml).toContain(C('first'))
      expect(xml).toContain(T('second'))
      expect(xml).not.toContain(C('second'))
    },
  )

  it('text boxes share their enclosing part id scope', async () => {
    const box = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:200pt;height:50pt"><v:textbox><w:txbxContent>${P('edited')}${P('original')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const doc = await parseDocx(await buildDocx({ bodyXml: box }))
    const b = doc.blocks.find((b) => b.textboxes?.length)!
    const xml = patchTextboxParas(b.originalXml!, {
      byIndex: [[{ runs: b.textboxes![0].paras[0].runs }, null]],
    })
    expect(xml).toContain(P('original'))
    expect(xml).toContain(`<w:p>${T('edited')}</w:p>`)
    expect(count(xml, '<w:sdt>')).toBe(1)
  })
})
