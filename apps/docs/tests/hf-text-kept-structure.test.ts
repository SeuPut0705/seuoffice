import JSZip from 'jszip'
import { parseDocx, saveDocx, type HeaderFooter } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import {
  T,
  buildWithHeader,
  skeleton,
} from '../../../packages/docx-engine/tests/helpers/inline-wrap'
import { applyHfText, hfEditText } from '../src/renderer/editor/hf-text'

/**
 * Retyping a header line as plain text (the AI set_header_footer tool, the
 * CLI header op) when the line holds structure the run model keeps as bytes:
 * an edit-permission range, a content control. The new text is the line.
 */

async function retype(headerXml: string, text: string): Promise<string> {
  const doc = await parseDocx(await buildWithHeader(headerXml))
  const value: HeaderFooter = { text: doc.headerText ?? '', paras: doc.headerParas ?? [] }
  expect(hfEditText(value)).not.toBe(text)
  const saved = await saveDocx(
    doc,
    doc.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
    { header: applyHfText(value, text) },
  )
  return (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
}

describe('applyHfText on a line holding kept structure', () => {
  it('a line inside an edit-permission range: the retyped text is written', async () => {
    const header = `<w:p><w:permStart w:id="7" w:edGrp="everyone"/>${T('Old header')}<w:permEnd w:id="7"/></w:p>`
    const hdr = await retype(header, 'New header')
    expect(skeleton(hdr)).toContain('[New header]')
    expect(hdr).not.toContain('Old header')
  })

  it('a line that starts with a content control: the retyped text is not put inside the control', async () => {
    const header =
      '<w:p><w:sdt><w:sdtPr><w:alias w:val="Title"/><w:id w:val="5"/>' +
      '<w:dataBinding w:xpath="/a" w:storeItemID="{X}"/></w:sdtPr>' +
      `<w:sdtContent>${T('Report')}</w:sdtContent></w:sdt>${T(' - draft')}</w:p>`
    const hdr = await retype(header, 'New header')
    expect(skeleton(hdr)).toMatch(/<w:p>(?:<w:pPr>.*?<\/w:pPr>)?\[New header\]<\/w:p>/)
    expect(hdr).not.toContain('<w:sdt>')
  })

  it("the line keeps the first text run's formatting", async () => {
    const header =
      `<w:p><w:permStart w:id="7" w:edGrp="everyone"/>${T('Old', '<w:rPr><w:b/></w:rPr>')}` +
      `<w:permEnd w:id="7"/></w:p>`
    const hdr = await retype(header, 'New')
    expect(hdr).toMatch(/<w:r><w:rPr><w:b\/>.*?<\/w:rPr><w:t[^>]*>New<\/w:t><\/w:r>/)
  })
})
