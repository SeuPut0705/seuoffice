import { expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { CliError } from '../src/result'
import { closeDocument, fillFromHtml, openDocument, saveDocument } from '../src/formats/docx'

/**
 * Replacing a document's body from HTML is refused by the editor when the body
 * holds a content control locked against editing whose text the new content
 * would change or drop. The CLI must say so: reporting the blocks as written
 * while the document stayed as it was is a silent failure.
 */

const locked = (text: string) =>
  '<w:sdt><w:sdtPr><w:tag w:val="clause"/><w:id w:val="41"/><w:lock w:val="contentLocked"/></w:sdtPr>' +
  `<w:sdtContent><w:r><w:t>${text}</w:t></w:r></w:sdtContent></w:sdt>`
const body = (control: string) =>
  `<w:p><w:r><w:t xml:space="preserve">Clause: </w:t></w:r>${control}</w:p>`

it('fillFromHtml reports the refusal instead of a block count when a locked control would be dropped', async () => {
  const source = await buildDocx({ bodyXml: body(locked('governing law')) })
  const doc = await openDocument(source)
  try {
    expect(() => fillFromHtml(doc, '<p>Entirely new text</p>')).toThrow(CliError)
    // nothing was written: the document saves as the bytes it was opened from
    expect(await saveDocument(doc)).toEqual(source)
  } finally {
    closeDocument(doc)
  }
})

it('fillFromHtml still replaces the body of a document without locked controls', async () => {
  const doc = await openDocument(
    await buildDocx({ bodyXml: '<w:p><w:r><w:t>Old text</w:t></w:r></w:p>' }),
  )
  try {
    expect(fillFromHtml(doc, '<p>First</p><p>Second</p>')).toBe(2)
    expect(doc.editor.state.doc.textContent).toBe('FirstSecond')
  } finally {
    closeDocument(doc)
  }
})
