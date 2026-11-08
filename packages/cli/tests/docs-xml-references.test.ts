import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
const simple = (instruction: string, result: string) =>
  `<w:fldSimple w:instr="${instruction}"><w:r><w:t xml:space="preserve">${result}</w:t></w:r></w:fldSimple>`
const complex = (instruction: string, result: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instruction}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve">${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`

describe('Word checks decode XML character references exactly once', () => {
  it.each([
    {
      name: 'literal anchor',
      xml: '<w:hyperlink w:anchor="Target"><w:r><w:t>link</w:t></w:r></w:hyperlink>',
      broken: 0,
      empty: 0,
    },
    {
      name: 'decimal anchor',
      xml: '<w:hyperlink w:anchor="&#84;arget"><w:r><w:t>link</w:t></w:r></w:hyperlink>',
      broken: 0,
      empty: 0,
    },
    {
      name: 'hex anchor',
      xml: '<w:hyperlink w:anchor="&#x54;arget"><w:r><w:t>link</w:t></w:r></w:hyperlink>',
      broken: 0,
      empty: 0,
    },
    {
      name: 'simple instruction separator',
      xml: simple('REF&#32;Missing', '1'),
      broken: 1,
      empty: 0,
    },
    {
      name: 'complex instruction separator',
      xml: complex('REF&#x20;Missing', '1'),
      broken: 1,
      empty: 0,
    },
    { name: 'simple space cache', xml: simple('PAGE', '&#32;'), broken: 0, empty: 1 },
    { name: 'simple tab cache', xml: simple('PAGE', '&#x9;'), broken: 0, empty: 1 },
    { name: 'complex space cache', xml: complex('PAGE', '&#32;'), broken: 0, empty: 1 },
    { name: 'literal whitespace cache', xml: complex('PAGE', ' '), broken: 0, empty: 1 },
    { name: 'named ampersand is visible text', xml: simple('PAGE', '&amp;'), broken: 0, empty: 0 },
    { name: 'amp-escaped numeric text', xml: simple('PAGE', '&amp;#32;'), broken: 0, empty: 0 },
    {
      name: 'numeric-escaped reference text',
      xml: complex('PAGE', '&#38;#32;'),
      broken: 0,
      empty: 0,
    },
  ])('handles $name', async ({ xml, broken, empty }) => {
    const zip = await JSZip.loadAsync(await buildBlankDocx())
    const document = await zip.file('word/document.xml')!.async('string')
    const bookmark =
      '<w:bookmarkStart w:id="8" w:name="Target"/><w:r><w:t>target</w:t></w:r><w:bookmarkEnd w:id="8"/>'
    zip.file(
      'word/document.xml',
      document.replace('<w:sectPr', `<w:p>${bookmark}</w:p><w:p>${xml}</w:p><w:sectPr`),
    )
    const file = join(tempDir(), 'references.docx')
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
    const before = readFileSync(file)
    const r = await run(['docs', 'check', file, '--json'], { env })
    expect(r.code).toBe(0)
    const issues = r.json().detail.issues as { code: string; message: string }[]
    expect(issues.filter((i) => i.code === 'broken_ref')).toHaveLength(broken)
    expect(issues.filter((i) => i.message.includes('has no cached result'))).toHaveLength(empty)
    if (broken) expect(issues.find((i) => i.code === 'broken_ref')?.message).toContain('"Missing"')
    expect(readFileSync(file)).toEqual(before)
  })
})
