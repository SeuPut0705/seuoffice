import { describe, expect, it } from 'vitest'
import { OLD_REDACT_NS } from '../../agent-core/src/old-names'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { parseFileToText } from '../src/index'
import { writeFixture } from './helpers/fixtures'

/**
 * A .docx read as another file's material (an attachment) keeps a span the
 * writer marked "hidden from AI" out of the text, whichever namespace the
 * mark was saved under, and hands over a plain document exactly as before.
 */

const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const LABEL = 'client phone'
const SECRET = '13800138000'

let seq = 0
async function read(bodyXml: string, ns?: string) {
  const bytes = await buildDocx({
    ...(ns ? { docRootExtraAttrs: `xmlns:mc="${MC}" xmlns:go="${ns}" mc:Ignorable="go"` } : {}),
    bodyXml,
  })
  return parseFileToText(writeFixture(`docx-redaction-${++seq}.docx`, bytes))
}

const marked = (text: string, label = LABEL) =>
  `<w:r><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/><go:redact w:label="${label}"/></w:rPr><w:t>${text}</w:t></w:r>`

describe('docx attachment: a span hidden from AI', () => {
  it.each([
    ['the old namespace', OLD_REDACT_NS],
    ['this product’s own namespace', OWN_REDACT_NS],
  ])('reads as its placeholder when the label is under %s', async (_n, ns) => {
    const result = await read(
      '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
        marked(SECRET) +
        '<w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>',
      ns,
    )
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.text).toContain(`Call {{${LABEL}}} now`)
  })

  it('a mark inside a table cell is withheld too', async () => {
    const result = await read(
      `<w:tbl><w:tr><w:tc><w:p>${marked(SECRET)}</w:p></w:tc><w:tc><w:p><w:r><w:t>open</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
      OLD_REDACT_NS,
    )
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.text).toContain(`{{${LABEL}}} | open`)
  })

  it('a mark that cannot be read fails the read instead of passing the text', async () => {
    const result = await read(
      `<w:p><w:r><w:rPr><go:redact/></w:rPr><w:t>${SECRET}</w:t></w:r></w:p>`,
      OLD_REDACT_NS,
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('an unmarked document reads exactly as before', async () => {
    const result = await read(
      '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r><w:r><w:t>everyone</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>second</w:t></w:r></w:p>',
    )
    expect(result).toEqual({ ok: true, kind: 'text', text: 'Call everyone\nsecond' })
  })
})
