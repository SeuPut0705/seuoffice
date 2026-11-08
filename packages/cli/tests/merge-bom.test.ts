import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from './helpers'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture(data: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ieumoffice-merge-bom-'))
  dirs.push(dir)
  const input = join(dir, 'template.docx'),
    values = join(dir, 'values.json'),
    output = join(dir, 'filled.docx')
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      '<w:body><w:p><w:r><w:t>{{name}}</w:t></w:r></w:p></w:body>',
    ),
  )
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  writeFileSync(values, data, 'utf8')
  const r = await run(['merge', input, '--data', values, '--out', output, '--strict', '--json'])
  expect(readFileSync(input)).toEqual(bytes)
  expect(readFileSync(values, 'utf8')).toBe(data)
  return { r, output }
}

describe('UTF-8 BOM in merge data', () => {
  it.each(['', '\ufeff'])(
    'fills Korean values with the optional leading BOM %j',
    async (prefix) => {
      const { r, output } = await fixture(
        prefix + ' \r\n' + JSON.stringify({ name: '테스트 고객' }),
      )
      expect(r.code).toBe(0)
      expect(r.json().detail).toMatchObject({ filled: 1, unresolved_placeholders: [] })
      const z = await JSZip.loadAsync(readFileSync(output))
      expect(await z.file('word/document.xml')!.async('string')).toContain('테스트 고객')
    },
  )

  it('keeps a BOM character inside a JSON string value', async () => {
    const { r, output } = await fixture('\ufeff' + JSON.stringify({ name: 'A\ufeffB' }))
    expect(r.code).toBe(0)
    const z = await JSZip.loadAsync(readFileSync(output))
    expect(await z.file('word/document.xml')!.async('string')).toContain('A\ufeffB')
  })

  it('still rejects malformed JSON after a BOM', async () => {
    const { r, output } = await fixture('\ufeff{"name":')
    expect(r.json()).toMatchObject({ status: 'error', error: 'invalid_json' })
    expect(existsSync(output)).toBe(false)
  })

  it('still validates the object shape after removing the BOM', async () => {
    const { r, output } = await fixture('\ufeff[]')
    expect(r.json()).toMatchObject({ status: 'error', error: 'invalid_argument' })
    expect(existsSync(output)).toBe(false)
  })

  it('does not erase repeated BOMs to accept otherwise invalid input', async () => {
    const { r, output } = await fixture('\ufeff\ufeff{"name":"Test"}')
    expect(r.json()).toMatchObject({ status: 'error', error: 'invalid_json' })
    expect(existsSync(output)).toBe(false)
  })
})
