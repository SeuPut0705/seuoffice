import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
let templateBytes: Buffer
beforeAll(async () => {
  const dir = tempDir()
  const md = join(dir, 'template.md')
  writeFileSync(md, '{{a.b}} | {{value}}')
  const out = join(dir, 'template.docx')
  expect((await run(['create', '--type', 'docx', '--from', md, '--out', out])).code).toBe(0)
  templateBytes = readFileSync(out)
})
describe('merge data must have unique flattened keys and representable numbers', () => {
  it.each([
    '{"a":{"b":"nested"},"a.b":"flat","value":1}',
    '{"a.b":"flat","a":{"b":"nested"},"value":1}',
    '{"a":{"b":{"c":1}},"a.b":{"c":2}}',
    '{"value":{"x":1},"value.x":2}',
    '{"value":1e309}',
    '{"value":-1e309}',
    '{"value":9007199254740993}',
    '{"value":-9007199254740993}',
    '{"value":1e20}',
  ])('rejects ambiguous or lossy data %s before replacing output', async (data) => {
    const dir = tempDir()
    const input = join(dir, 'template.docx')
    writeFileSync(input, templateBytes)
    const out = join(dir, 'out.docx')
    const before = Buffer.from('keep this existing output')
    writeFileSync(out, before)
    const result = await run(['merge', input, '--data', data, '--out', out, '--force', '--json'])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(readFileSync(out)).toEqual(before)
    expect(readFileSync(input)).toEqual(templateBytes)
  })
  it.each([
    { raw: '0', expected: '0' },
    { raw: 'false', expected: 'false' },
    { raw: 'null', expected: null },
    { raw: '12.5', expected: '12.5' },
    { raw: '9007199254740991', expected: '9007199254740991' },
    { raw: '-9007199254740991', expected: '-9007199254740991' },
    { raw: '"9007199254740993"', expected: '9007199254740993' },
    { raw: '"1e309"', expected: '1e309' },
  ])('keeps valid typed and exact-string value $raw', async ({ raw, expected }) => {
    const dir = tempDir()
    const input = join(dir, 'template.docx')
    writeFileSync(input, templateBytes)
    const out = join(dir, 'out.docx')
    const data = `{"a":{"b":"OK"},"value":${raw},"ignoredArray":[1]}`
    const result = await run(['merge', input, '--data', data, '--out', out, '--json'])
    expect(result.code).toBe(0)
    expect(result.json().detail.filled).toBe(2)
    expect(result.json().detail.ignored_keys).toContain('ignoredArray')
    const zip = await JSZip.loadAsync(readFileSync(out))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('OK')
    if (expected !== null) expect(xml).toContain(expected)
    expect(readFileSync(input)).toEqual(templateBytes)
  })
})
