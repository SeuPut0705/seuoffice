import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type SaveBlock } from '../src'
import { buildDocx } from './helpers/build-docx'
import { OWN_REDACT_NS, PLACEHOLDER, SECRET } from './helpers/hidden-stories'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** a footnote whose open tag is spelled `attrs` and end tag `end`, holding a run hidden from AI */
async function notedDocx(attrs: string, end = '</w:footnote>'): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>',
    extraRels:
      '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    extraParts: [
      {
        path: 'word/footnotes.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        xml:
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}>` +
          '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
          '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
          `<w:footnote ${attrs}><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See </w:t></w:r>` +
          `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
          `</w:p>${end}</w:footnotes>`,
      },
    ],
  })
}

describe('saving notes keeps a hidden run however the note tag is spelled', () => {
  it.each([
    [`w:id='1'`, '</w:footnote>'],
    [`w:id = "1"`, '</w:footnote>'],
    [`w:x="a/>b>c" w:id="1"`, '</w:footnote>'],
    [`w:id="1"`, '</w:footnote >'],
  ])('<w:footnote %s>…%s keeps its mark when another note is added', async (attrs, end) => {
    const doc = await parseDocx(await notedDocx(attrs, end))
    expect(doc.footnotes.map((n) => n.modelText)).toEqual([`See ${PLACEHOLDER}`])
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      footnotes: [...doc.footnotes, { id: '5', text: 'plain' }],
    })
    const reopened = await parseDocx(saved)
    const first = reopened.footnotes.find((n) => n.id === '1')!
    expect(first.text).toBe(`See ${SECRET}`)
    expect(first.modelText).toBe(`See ${PLACEHOLDER}`)
  })
})
