import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { PRODUCT_NAME } from '@genoffice/i18n'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** a minimal but valid .docx holding the given body paragraphs */
async function buildDocx(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/styles.xml',
    `${XML_DECL}<w:styles ${DOC_NS}>` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '</w:styles>',
  )
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document ${DOC_NS}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const P = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const UNCHANGED = P('Hello world')
const ORIGINAL_BODY =
  UNCHANGED + P('The quick brown fox jumps.') + P('This paragraph was removed entirely.')
const REVISED_BODY =
  UNCHANGED + P('The quick red fox jumps.') + P('A brand new paragraph appears here.')

async function documentXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  return zip.file('word/document.xml')!.async('string')
}

/** writes the two fixtures into a fresh folder and returns their paths */
async function fixtures(): Promise<{ dir: string; original: string; revised: string }> {
  const dir = tempDir()
  const original = join(dir, 'original.docx')
  const revised = join(dir, 'revised.docx')
  writeFileSync(original, await buildDocx(ORIGINAL_BODY))
  writeFileSync(revised, await buildDocx(REVISED_BODY))
  return { dir, original, revised }
}

describe('genoffice docs compare', () => {
  it('writes a redline with the differences marked as tracked changes', async () => {
    const { dir, original, revised } = await fixtures()
    const out = join(dir, 'redline.docx')
    const r = await run(['docs', 'compare', original, revised, '--out', out, '--json'])
    expect(r.code).toBe(0)

    const xml = await documentXml(out)
    expect(xml).toContain('<w:ins ')
    expect(xml).toContain('<w:del ')
    expect(xml).toContain('brown</w:delText>')
    expect(xml).toContain('>red</w:t>')
    // the redline is a document the editor opens, and it sees the pending changes
    const read = await run(['docs', 'read', out, '--revisions', '--json'])
    expect(read.code).toBe(0)
    expect(
      read
        .json()
        .detail.items.map((i: { text: string }) => i.text)
        .join(' '),
    ).toContain('red fox jumps.')
    const revisions = read.json().detail.revisions as { author: string }[]
    expect(revisions.length).toBeGreaterThan(0)
    // the default author is this product's name, not the upstream engine's constant
    expect(revisions.every((r) => r.author === PRODUCT_NAME)).toBe(true)
  })

  it('reports the counts and the output path as JSON', async () => {
    const { dir, original, revised } = await fixtures()
    const out = join(dir, 'redline.docx')
    const r = await run(['docs', 'compare', original, revised, '--out', out, '--json'])
    expect(r.code).toBe(0)
    const payload = r.json()
    expect(payload.output_path).toBe(out)
    expect(payload.detail).toMatchObject({
      insertions: 2,
      deletions: 2,
      inserted_paragraphs: 1,
      deleted_paragraphs: 1,
      changed_paragraphs: 1,
      unchanged_paragraphs: 1,
    })
  })

  it.each([
    '2023-02-29T12:00:00Z',
    '2024-02-30T12:00:00Z',
    '2026-04-31T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-02-31T23:30:00-05:00',
  ])('rejects the nonexistent calendar date %s without overwriting output', async (date) => {
    const { dir, original, revised } = await fixtures()
    const originalBytes = readFileSync(original)
    const revisedBytes = readFileSync(revised)
    const out = join(dir, 'existing.docx')
    const before = Buffer.from('preserve the existing output')
    writeFileSync(out, before)
    const result = await run([
      'docs',
      'compare',
      original,
      revised,
      '--date',
      date,
      '--out',
      out,
      '--force',
      '--json',
    ])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(readFileSync(out)).toEqual(before)
    expect(readFileSync(original)).toEqual(originalBytes)
    expect(readFileSync(revised)).toEqual(revisedBytes)
  })

  it.each([
    '2024-02-29T12:00:00Z',
    '2000-02-29',
    '2026-04-30T23:30:00-05:00',
    '2024-03-01T00:15:00+14:00',
  ])('retains the valid civil date %s even when its UTC day differs', async (date) => {
    const { dir, original, revised } = await fixtures()
    const out = join(dir, 'valid.docx')
    const result = await run([
      'docs',
      'compare',
      original,
      revised,
      '--date',
      date,
      '--out',
      out,
      '--json',
    ])
    expect(result.code).toBe(0)
    expect(result.json().detail.date).toBe(date)
    const xml = await documentXml(out)
    const revisions = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*>/g)]
    expect(revisions.length).toBeGreaterThan(0)
    for (const revision of revisions) expect(revision[0]).toContain(`w:date="${date}"`)
  })

  it('records the author and the date on every revision', async () => {
    const { dir, original, revised } = await fixtures()
    const out = join(dir, 'redline.docx')
    const r = await run([
      'docs',
      'compare',
      original,
      revised,
      '--out',
      out,
      '--author',
      'Opposing Counsel',
      '--date',
      '2026-10-16T00:00:00Z',
      '--json',
    ])
    expect(r.code).toBe(0)
    const xml = await documentXml(out)
    const revisions = [...xml.matchAll(/<w:(ins|del)\b[^>]*>/g)].map((m) => m[0]!)
    expect(revisions.length).toBeGreaterThan(0)
    for (const tag of revisions) {
      expect(tag).toContain('w:author="Opposing Counsel"')
      expect(tag).toContain('w:date="2026-10-16T00:00:00Z"')
    }
    const ids = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:id="(\d+)"/g)].map((m) => m[1]!)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('diffs a changed paragraph at word level and at character level', async () => {
    const { dir } = await fixtures()
    const original = join(dir, 'word-original.docx')
    const revised = join(dir, 'word-revised.docx')
    writeFileSync(original, await buildDocx(P('Hello world')))
    writeFileSync(revised, await buildDocx(P('Hello worl')))

    const wordOut = join(dir, 'word.docx')
    const word = await run(['docs', 'compare', original, revised, '--out', wordOut, '--json'])
    expect(word.code).toBe(0)
    expect(await documentXml(wordOut)).toContain('world</w:delText>')

    const charOut = join(dir, 'char.docx')
    const char = await run([
      'docs',
      'compare',
      original,
      revised,
      '--out',
      charOut,
      '--granularity',
      'char',
      '--json',
    ])
    expect(char.code).toBe(0)
    const charXml = await documentXml(charOut)
    expect(charXml).toContain('d</w:delText>')
    expect(charXml).not.toContain('world</w:delText>')
  })

  it('ignores a case-only or whitespace-only difference when asked to', async () => {
    const { dir } = await fixtures()
    const original = join(dir, 'case-original.docx')
    const revised = join(dir, 'case-revised.docx')
    writeFileSync(original, await buildDocx(P('the quick fox')))
    writeFileSync(revised, await buildDocx(P('The quick  fox')))

    const plain = join(dir, 'plain.docx')
    const before = await run(['docs', 'compare', original, revised, '--out', plain, '--json'])
    expect(before.json().detail.changed_paragraphs).toBe(1)

    const ignored = join(dir, 'ignored.docx')
    const after = await run([
      'docs',
      'compare',
      original,
      revised,
      '--out',
      ignored,
      '--ignore',
      'case,whitespace',
      '--json',
    ])
    expect(after.code).toBe(0)
    expect(after.json().detail.changed_paragraphs).toBe(0)
    expect(await documentXml(ignored)).not.toContain('<w:ins ')
  })

  it('refuses a missing --out, an unknown granularity and an existing output file', async () => {
    const { dir, original, revised } = await fixtures()
    const noOut = await run(['docs', 'compare', original, revised, '--json'])
    expect(noOut.code).toBe(1)
    expect(noOut.json().error).toBe('missing_argument')

    const badGranularity = await run([
      'docs',
      'compare',
      original,
      revised,
      '--out',
      join(dir, 'x.docx'),
      '--granularity',
      'sentence',
      '--json',
    ])
    expect(badGranularity.code).toBe(1)
    expect(badGranularity.json().error).toBe('invalid_argument')

    const out = join(dir, 'taken.docx')
    writeFileSync(out, 'x')
    const exists = await run(['docs', 'compare', original, revised, '--out', out, '--json'])
    expect(exists.code).toBe(2)
    expect(exists.json().error).toBe('output_exists')
  })
})
