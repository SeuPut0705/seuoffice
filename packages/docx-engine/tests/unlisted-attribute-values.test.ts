/**
 * An attribute value the model's type does not name (a misspelt w:lineRule)
 * is kept as written: the document opens and a regenerated paragraph writes
 * the value back.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/parse'
import { saveDocx } from '../src/patch'
import { buildDocx } from './helpers/build-docx'

const PARAGRAPH =
  '<w:p><w:pPr><w:spacing w:line="300" w:lineRule="aut"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>'

describe('attribute values no type names', () => {
  it('opens the document and keeps the values as written', async () => {
    const parsed = await parseDocx(await buildDocx({ bodyXml: PARAGRAPH }))
    expect(parsed.blocks[0].format).toMatchObject({ lineRule: 'aut', lineRawTwips: 300 })
  })

  it('writes them back when the paragraph is regenerated', async () => {
    const parsed = await parseDocx(await buildDocx({ bodyXml: PARAGRAPH }))
    const saved = await saveDocx(parsed, [
      {
        kind: 'generated',
        // the paragraph as read with its text replaced, as the editor hands it over
        block: {
          type: 'paragraph',
          format: parsed.blocks[0].format,
          rawPPr: parsed.blocks[0].rawPPr,
          runs: [{ text: 'edited' }],
        },
      },
    ])
    const xml = await (await JSZip.loadAsync(saved)).file('word/document.xml')!.async('string')
    expect(xml).toContain('edited')
    expect(xml).toContain('w:lineRule="aut"')
  })
})
