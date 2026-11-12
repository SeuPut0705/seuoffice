/**
 * Load-time normalization also runs on transitional documents: a universal
 * measure ("12pt") is converted to the attribute's native unit and a duplicated
 * w:pStyle / w:rStyle keeps the last one (genoffice#2581, genoffice#2503). That
 * changes what a save WITH changes writes for the part. A save without changes
 * is still the file that was opened.
 */
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type SaveBlock } from '../src/index'
import { buildDocx } from './helpers/build-docx'

const EXTRA_STYLES =
  '<w:style w:type="paragraph" w:styleId="MdHeading1"><w:name w:val="Md Heading 1"/></w:style>' +
  '<w:style w:type="character" w:styleId="Red"><w:name w:val="Red"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Blue"><w:name w:val="Blue"/><w:rPr><w:color w:val="0000FF"/></w:rPr></w:style>'

const BODY =
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pStyle w:val="MdHeading1"/></w:pPr>' +
  '<w:r><w:rPr><w:rStyle w:val="Red"/><w:rStyle w:val="Blue"/></w:rPr><w:t>Title</w:t></w:r></w:p>' +
  '<w:p><w:r><w:rPr><w:sz w:val="12pt"/><w:szCs w:val="12pt"/></w:rPr><w:t>Twelve points</w:t></w:r></w:p>'

describe('transitional document with a universal measure and duplicated style references', () => {
  it('saves to its original bytes when nothing was edited', async () => {
    const bytes = await buildDocx({ bodyXml: BODY, extraStylesXml: EXTRA_STYLES })
    const parsed = await parseDocx(bytes)

    // the normalization did run: the model reads the converted text
    expect(parsed.blocks[0]!.styleId).toBe('MdHeading1')
    expect(parsed.blocks[0]!.runs![0]!.styleId).toBe('Blue')
    expect(parsed.blocks[1]!.runs![0]!.sizeHalfPoints).toBe(24)
    expect(parsed.internal.documentXml).not.toContain('12pt')

    const untouched: SaveBlock[] = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original', docxIndex: b.docxIndex! }))
    expect(await saveDocx(parsed, untouched)).toBe(bytes)
  })
})
