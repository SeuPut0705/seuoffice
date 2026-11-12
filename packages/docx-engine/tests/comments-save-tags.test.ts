import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type SaveBlock } from '../src'
import { buildDocx } from './helpers/build-docx'
import { OWN_REDACT_NS, PLACEHOLDER, SECRET } from './helpers/hidden-stories'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** a comment whose open tag is spelled `attrs`, holding a run hidden from AI */
async function commentedDocx(attrs: string): Promise<Uint8Array> {
  return buildDocx({
    bodyXml:
      '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Body</w:t></w:r><w:commentRangeEnd w:id="1"/>' +
      '<w:r><w:commentReference w:id="1"/></w:r></w:p>',
    extraParts: [
      {
        path: 'word/comments.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>` +
          `<w:comment ${attrs}><w:p><w:r><w:t xml:space="preserve">Note: </w:t></w:r>` +
          `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
          '</w:p></w:comment></w:comments>',
      },
    ],
  })
}

describe('saving comments keeps a hidden run however the comment tag is spelled', () => {
  it.each([`w:id='1' w:author='K'`, `w:id = "1" w:author="K"`, `w:author="a/>b>c" w:id="1"`])(
    '<w:comment %s> keeps its mark when another comment is added',
    async (attrs) => {
      const doc = await parseDocx(await commentedDocx(attrs))
      expect(doc.comments[0]!.modelText).toBe(`Note: ${PLACEHOLDER}`)
      const blocks = doc.blocks
        .filter((block) => !block.hidden)
        .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
      const saved = await saveDocx(doc, blocks, {
        comments: [...doc.comments, { id: '2', author: 'Lee', text: 'reply', parentId: '1' }],
      })
      const reopened = await parseDocx(saved)
      const first = reopened.comments.find((c) => c.id === '1')!
      expect(first.text).toBe(`Note: ${SECRET}`)
      expect(first.modelText).toBe(`Note: ${PLACEHOLDER}`)
    },
  )
})
