import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { docxToText } from '../src/docx'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'

async function docx(body: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W} ${WP}><w:body>${body}</w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('docxToText image alternative text', () => {
  it('includes the descr of an inline picture so the figure is not invisible to readers', async () => {
    const drawing =
      '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Revenue chart 2026"/></wp:inline></w:drawing></w:r></w:p>'
    const text = await docxToText(await docx(drawing))
    expect(text).toContain('[image: Revenue chart 2026]')
  })

  it('wraps the alt text so it does not run into the words around it', async () => {
    const drawing =
      '<w:p>' +
      '<w:r><w:t>See figure</w:t></w:r>' +
      '<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Revenue chart"/></wp:inline></w:drawing></w:r>' +
      '<w:r><w:t> below.</w:t></w:r>' +
      '</w:p>'
    const text = await docxToText(await docx(drawing))
    expect(text).toBe('See figure[image: Revenue chart] below.')
  })

  it('skips the alt text of a drawing marked hidden, like a vanish run', async () => {
    const drawing =
      '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" hidden="1" descr="Revenue chart 2026"/></wp:inline></w:drawing></w:r></w:p>'
    const text = await docxToText(await docx(drawing))
    expect(text).not.toContain('Revenue chart 2026')
    expect(text).toMatch(/image-only document: 1 image/)
  })

  it('marks a picture-only document that has no alt text, like picture-only slides', async () => {
    const drawing =
      '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1"/></wp:inline></w:drawing></w:r></w:p>'
    const text = await docxToText(await docx(drawing))
    expect(text).toMatch(/image-only document: 1 image/)
  })
})
