import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx, generateTableModelXml, type TableModel } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from './helpers'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const table = (text: string): TableModel => ({ rows: [[{ paras: [text] }]] })

async function convert(model: TableModel) {
  const dir = mkdtempSync(join(tmpdir(), 'ieumoffice-nested-md-'))
  dirs.push(dir)
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body>${generateTableModelXml(model)}<w:p/></w:body>`,
    ),
  )
  const input = join(dir, 'nested.docx'),
    output = join(dir, 'nested.md')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  const r = await run(['convert', input, '--to', 'md', '--out', output, '--json'])
  expect(r.code).toBe(0)
  expect(readFileSync(input)).toEqual(bytes)
  return { text: readFileSync(output, 'utf8'), result: r.json() }
}

describe('DOCX nested-table Markdown export', () => {
  it('keeps nested cell text at its paragraph anchor', async () => {
    const model: TableModel = {
      rows: [
        [
          {
            paras: ['앞 문장', '뒤 문장'],
            nestedTables: [table('내부 값')],
            nestedTableAnchors: [1],
          },
        ],
      ],
    }
    const { text, result } = await convert(model)
    expect(text).toContain('내부 값')
    expect(text.indexOf('앞 문장')).toBeLessThan(text.indexOf('내부 값'))
    expect(text.indexOf('내부 값')).toBeLessThan(text.indexOf('뒤 문장'))
    expect(result).toMatchObject({
      detail: { nested_tables_as_text: 1 },
      warnings: [expect.objectContaining({ code: 'nested_tables_flattened' })],
    })
  })

  it('keeps sibling nested tables in order, including an empty host cell', async () => {
    const { text, result } = await convert({
      rows: [
        [
          {
            paras: [],
            nestedTables: [table('첫 내부 표'), table('둘째 내부 표')],
            nestedTableAnchors: [0, 0],
          },
        ],
      ],
    })
    expect(text).toContain('첫 내부 표')
    expect(text).toContain('둘째 내부 표')
    expect(text.indexOf('첫 내부 표')).toBeLessThan(text.indexOf('둘째 내부 표'))
    expect(result.detail.nested_tables_as_text).toBe(2)
  })

  it('keeps recursive tables and every row and cell', async () => {
    const inner: TableModel = {
      rows: [
        [{ paras: ['가'] }, { paras: ['나'] }],
        [{ paras: ['다'], nestedTables: [table('깊은 값')] }, { paras: ['라'] }],
      ],
    }
    const { text, result } = await convert({ rows: [[{ paras: ['바깥'], nestedTables: [inner] }]] })
    for (const value of ['가', '나', '다', '라', '깊은 값']) expect(text).toContain(value)
    expect(result.detail.nested_tables_as_text).toBe(2)
  })

  it('exports literal HTML characters as text', async () => {
    const { text } = await convert({
      rows: [[{ paras: ['상위'], nestedTables: [table('<script> & 보존')] }]],
    })
    expect(text).toContain('script')
    expect(text).toContain('보존')
    expect(text).not.toContain('<script>')
  })

  it('does not report a flattening warning for an ordinary table', async () => {
    const { text, result } = await convert(table('일반 표'))
    expect(text).toContain('일반 표')
    expect(result.detail.nested_tables_as_text).toBeUndefined()
    expect(result.warnings).toBeUndefined()
  })
})
