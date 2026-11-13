import { describe, expect, it } from 'vitest'
import { docxToOdt, odtToText } from '../src'
import { buildDocx, sectPr } from './helpers/build-docx'
import { readArchive } from './helpers/odt-archive'

describe('exported text is escaped XML', () => {
  it('strips XML 1.0 illegal C0 controls and escapes markup characters', async () => {
    const docx = await buildDocx({
      body: '<w:p><w:r><w:t>Report Q1&#1;Draft &amp; &lt;tag&gt;</w:t></w:r></w:p>' + sectPr(),
    })
    const { odtBytes } = await docxToOdt(docx)
    const content = (await readArchive(odtBytes)).text('content.xml') as string
    expect(content).toContain('Report Q1Draft &amp; &lt;tag&gt;')
    // eslint-disable-next-line no-control-regex -- asserting the controls are gone IS the check
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)).toBe(false)
    expect(await odtToText(odtBytes)).toContain('Report Q1Draft & <tag>')
  })
})
