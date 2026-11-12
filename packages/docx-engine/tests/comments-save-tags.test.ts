import { describe, expect, it } from 'vitest'
import { HiddenEntrySaveError, parseDocx, saveDocx, type SaveBlock } from '../src'
import { buildDocx } from './helpers/build-docx'
import { OWN_REDACT_NS, PLACEHOLDER, SECRET } from './helpers/hidden-stories'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** a comment whose open tag is spelled `attrs`, holding a run hidden from AI */
async function commentedDocx(attrs: string, end = '</w:comment>'): Promise<Uint8Array> {
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
          `</w:p>${end}</w:comments>`,
      },
    ],
  })
}

describe('saving comments keeps a hidden run however the comment tag is spelled', () => {
  it('a hidden run whose CDATA holds a comment end tag keeps its mark', async () => {
    const bytes = await commentedDocx('w:id="1" w:author="K"')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/comments.xml')!.async('string')
    zip.file(
      'word/comments.xml',
      xml.replace(`<w:t>${SECRET}</w:t>`, `<w:t><![CDATA[</w:comment>]]>${SECRET}</w:t>`),
    )
    const doc = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
    expect(doc.comments[0]!.modelText).toBe(`Note: ${PLACEHOLDER}`)
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      comments: [...doc.comments, { id: '2', author: 'Lee', text: 'reply', parentId: '1' }],
    })
    const first = (await parseDocx(saved)).comments.find((c) => c.id === '1')!
    expect(first.text).toContain(SECRET)
    expect(first.modelText).toBe(`Note: ${PLACEHOLDER}`)
  })

  it('a comment whose end tag has white space before > keeps its mark', async () => {
    const doc = await parseDocx(await commentedDocx('w:id="1" w:author="K"', '</w:comment >'))
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const saved = await saveDocx(doc, blocks, {
      comments: [...doc.comments, { id: '2', author: 'Lee', text: 'reply', parentId: '1' }],
    })
    const first = (await parseDocx(saved)).comments.find((c) => c.id === '1')!
    expect(first.modelText).toBe(`Note: ${PLACEHOLDER}`)
  })

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

describe('an edited comment or note whose hidden run holds CDATA keeps its mark', () => {
  it('a comment edited by a person', async () => {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(await commentedDocx('w:id="1" w:author="K"'))
    const xml = await zip.file('word/comments.xml')!.async('string')
    zip.file(
      'word/comments.xml',
      xml.replace(`<w:t>${SECRET}</w:t>`, `<w:t><![CDATA[${SECRET}]]></w:t>`),
    )
    const doc = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
    expect(doc.comments[0]!.modelText).toBe(`Note: ${PLACEHOLDER}`)
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    const edited = { ...doc.comments[0]!, text: `Later: ${SECRET}` }
    const saved = await saveDocx(doc, blocks, { comments: [edited] })
    const first = (await parseDocx(saved)).comments.find((c) => c.id === '1')!
    expect(first.text).toBe(`Later: ${SECRET}`)
    expect(first.modelText).toBe(`Later: ${PLACEHOLDER}`)
  })
})

describe('an edit that cannot be patched into a marked comment', () => {
  it('fails the save rather than drop its mark or the edit', async () => {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(await commentedDocx('w:id="1" w:author="K"'))
    const xml = await zip.file('word/comments.xml')!.async('string')
    zip.file(
      'word/comments.xml',
      xml.replace(`<w:t>${SECRET}</w:t>`, `<w:t><![CDATA[${SECRET}]]></w:t>`),
    )
    const doc = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    // a second paragraph: the runs of the first cannot carry it
    const edited = { ...doc.comments[0]!, text: `Note: ${SECRET}\nthanks` }
    await expect(
      saveDocx(doc, blocks, {
        comments: [edited, { id: '2', author: 'Lee', text: 'reply', parentId: '1' }],
      }),
    ).rejects.toThrow(HiddenEntrySaveError)
  })
})
