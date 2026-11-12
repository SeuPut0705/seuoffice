import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/index'
import { buildDocx } from './helpers/build-docx'

/**
 * A paragraph whose w:pStyle names a style the document does not define is
 * laid out in the default paragraph style, as Word does: its paragraph
 * properties and its text alike.
 */

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/></w:pPr>' +
  '<w:rPr><w:i/><w:sz w:val="28"/><w:color w:val="FF0000"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/>' +
  '<w:rPr><w:sz w:val="18"/></w:rPr></w:style>' +
  '</w:styles>'

const para = (text: string, pStyle?: string) =>
  `<w:p>${pStyle ? `<w:pPr><w:pStyle w:val="${pStyle}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`

describe('a paragraph that names a missing style', () => {
  it('shows its text and its mark in the default paragraph style', async () => {
    const doc = await parseDocx(
      await buildDocx({
        stylesXml: STYLES,
        bodyXml: para('unstyled') + para('missing', 'Gone') + para('own', 'Plain'),
      }),
    )
    const look = doc.blocks.slice(0, 3).map((b) => {
      const run = b.runs![0].effective!
      const mark = b.format!.effective!.mark!
      return {
        align: b.format!.effective!.align,
        run: [run.italic, run.sizeHalfPoints, run.color],
        mark: [mark.italic, mark.sizeHalfPoints, mark.color],
      }
    })
    const normal = { align: 'center', run: [true, 28, 'FF0000'], mark: [true, 28, 'FF0000'] }
    expect(look[0]).toEqual(normal)
    expect(look[1]).toEqual(normal)
    // a style that exists and does not build on Normal keeps its own look
    expect(look[2]).toEqual({ run: [false, 18, undefined], mark: [false, 18, undefined] })
  })
})
