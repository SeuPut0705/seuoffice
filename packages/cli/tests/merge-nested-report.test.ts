import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function template(outer = 'Company', deep = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ieumoffice-merge-nested-'))
  dirs.push(dir)
  const inside: TableModel = {
    rows: [
      [
        {
          paras: [deep ? 'Inner text' : '{{고객명}}'],
          ...(deep ? { nestedTables: [{ rows: [[{ paras: ['{{고객명}}'] }]] }] } : {}),
        },
      ],
    ],
  }
  const model: TableModel = {
    rows: [[{ paras: [outer], nestedTables: [inside], nestedTableAnchors: [1] }]],
  }
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body>${generateTableModelXml(model)}<w:p/></w:body>`,
    ),
  )
  const input = join(dir, 'template.docx'),
    output = join(dir, 'filled.docx')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  return { input, output, bytes }
}

describe('Word nested-table merge reporting', () => {
  it.each([false, true])(
    'strict mode refuses an unreachable placeholder at nested depth %s',
    async (deep) => {
      const { input, output, bytes } = await template('Company', deep)
      const r = await run([
        'merge',
        input,
        '--data',
        '{"고객명":"테스트 고객"}',
        '--out',
        output,
        '--strict',
        '--json',
      ])
      expect(r.code).toBe(1)
      expect(r.json()).toMatchObject({
        status: 'error',
        error: 'unresolved_placeholder',
        suggestion: expect.stringMatching(/Word/),
        detail: {
          unresolved_placeholders: [
            expect.objectContaining({
              key: '고객명',
              reason: 'unreachable_nested',
              location: expect.objectContaining({ block: 0, nested: true }),
            }),
          ],
        },
      })
      expect(existsSync(output)).toBe(false)
      expect(readFileSync(input)).toEqual(bytes)
    },
  )

  it('non-strict mode warns and leaves an inner-only template byte-for-byte unchanged', async () => {
    const { input, output, bytes } = await template()
    const r = await run([
      'merge',
      input,
      '--data',
      '{"고객명":"테스트 고객"}',
      '--out',
      output,
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({
      filled: 0,
      unused_keys: ['고객명'],
      unresolved_placeholders: [
        expect.objectContaining({ key: '고객명', reason: 'unreachable_nested' }),
      ],
    })
    expect(r.json().warnings[0]).toMatchObject({
      code: 'unresolved_placeholder',
      suggestion: expect.stringMatching(/Word/),
    })
    expect(readFileSync(output)).toEqual(bytes)
  })

  it('still fills the outer cell and reports the untouched inner placeholder', async () => {
    const { input, output } = await template('Company {{name}}')
    const r = await run([
      'merge',
      input,
      '--data',
      '{"name":"Test Company","고객명":"테스트 고객"}',
      '--out',
      output,
      '--json',
    ])
    expect(r.code).toBe(0)
    expect(r.json().detail.filled).toBe(1)
    expect(r.json().detail.unresolved_placeholders).toHaveLength(1)
    const zip = await JSZip.loadAsync(readFileSync(output))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Company Test Company')
    expect(xml).toContain('{{고객명}}')
    expect(xml.match(/<w:tbl[ >]/g)).toHaveLength(2)
  })

  it('strict mode does not replace an existing output even with --force', async () => {
    const { input, output } = await template()
    const previous = Buffer.from('keep previous output')
    writeFileSync(output, previous)
    const r = await run([
      'merge',
      input,
      '--data',
      '{}',
      '--out',
      output,
      '--strict',
      '--force',
      '--json',
    ])
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('unresolved_placeholder')
    expect(readFileSync(output)).toEqual(previous)
  })
})
