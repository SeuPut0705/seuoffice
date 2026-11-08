import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx, generateTableModelXml } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function merge(value: string, table = false) {
  const dir = tempDir(),
    input = join(dir, 'template.docx'),
    output = join(dir, 'result.docx'),
    zip = await JSZip.loadAsync(await buildBlankDocx()),
    xml = await zip.file('word/document.xml')!.async('string')
  const body = table
    ? generateTableModelXml({ rows: [[{ paras: ['{{name}}'] }]] })
    : '<w:p><w:r><w:t>{{name}}</w:t></w:r></w:p>'
  zip.file(
    'word/document.xml',
    xml.replace(/<w:body>[\s\S]*<\/w:body>/, '<w:body>' + body + '<w:sectPr/></w:body>'),
  )
  writeFileSync(input, await zip.generateAsync({ type: 'nodebuffer' }))
  const r = await run([
    'merge',
    input,
    '--data',
    JSON.stringify({ name: value }),
    '--out',
    output,
    '--strict',
    '--json',
  ])
  expect(r.code, r.stdout).toBe(0)
  const read = (await run(['docs', 'read', output, '--full', '--json'])).json()
  const result = await JSZip.loadAsync(readFileSync(output))
  return {
    text: read.detail.items[0].text as string,
    xml: await result.file('word/document.xml')!.async('string'),
  }
}
for (const ending of ['\r', '\r\n', '\n'])
  for (const table of [false, true])
    it(`preserves ${JSON.stringify(ending)} in a ${table ? 'table cell' : 'paragraph'} replacement`, async () => {
      const r = await merge('First' + ending + 'Second', table)
      const fragment = table ? (/<w:tc\b[\s\S]*?<\/w:tc>/.exec(r.xml)?.[0] ?? '') : r.xml
      const lineBreaks =
        (fragment.match(/<w:br\b/g) ?? []).length +
        (table ? Math.max(0, (fragment.match(/<w:p(?:\s|>)/g) ?? []).length - 1) : 0)
      expect(lineBreaks).toBe(1)
      expect(r.text).toBe(table ? 'First Second' : 'First\nSecond')
    })
it('does not introduce a break in a single line', async () => {
  const r = await merge('One line')
  expect(r.text).toBe('One line')
  expect(r.xml).not.toMatch(/<w:br\b/)
})
it('keeps placeholder-shaped replacement text literal', async () => {
  const r = await merge('First\r{{other}}')
  expect(r.text).toBe('First\n{{other}}')
})
