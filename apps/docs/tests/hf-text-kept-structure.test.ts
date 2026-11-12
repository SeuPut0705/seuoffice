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
 * CLI header op) when the line holds a wrapper the run model keeps as bytes
 * (a content control). The new text is the line.
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

describe('applyHfText on a line holding a content control', () => {
  it('a line that starts with a content control: the retyped text is not put inside the control', async () => {
    const header =
      '<w:p><w:sdt><w:sdtPr><w:alias w:val="Title"/><w:id w:val="5"/>' +
      '<w:dataBinding w:xpath="/a" w:storeItemID="{X}"/></w:sdtPr>' +
      `<w:sdtContent>${T('Report')}</w:sdtContent></w:sdt>${T(' - draft')}</w:p>`
    const hdr = await retype(header, 'New header')
    expect(skeleton(hdr)).toMatch(/<w:p>(?:<w:pPr>.*?<\/w:pPr>)?\[New header\]<\/w:p>/)
    expect(hdr).not.toContain('<w:sdt>')
  })

  it("the line keeps the first text run's formatting, without the control it sat in", async () => {
    const header =
      '<w:p><w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr>' +
      `<w:sdtContent>${T('Old', '<w:rPr><w:b/></w:rPr>')}</w:sdtContent></w:sdt></w:p>`
    const hdr = await retype(header, 'New')
    expect(hdr).toMatch(/<w:r><w:rPr><w:b\/>.*?<\/w:rPr><w:t[^>]*>New<\/w:t><\/w:r>/)
    expect(hdr).not.toContain('<w:sdt>')
  })
})
