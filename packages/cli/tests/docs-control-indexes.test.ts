import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function fixture() {
  const dir = tempDir()
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      '<w:body><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body>',
    ),
  )
  const input = join(dir, 'input.docx')
  const output = join(dir, 'output.docx')
  const ops = join(dir, 'ops.json')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(input, bytes)
  return { input, output, ops, bytes }
}

describe('Word content-control block index validation', () => {
  it.each([null, false, true, '', '0', [], [0], {}, -1, 0.5])(
    'rejects a non-index start value: %j',
    async (startBlockIndex) => {
      const { input, output, ops, bytes } = await fixture()
      writeFileSync(
        ops,
        JSON.stringify([{ op: 'wrap_content_control', startBlockIndex, tag: 'Trial' }]),
      )
      const r = await run(['docs', 'apply', input, '--ops', ops, '--out', output, '--json'])
      expect(r.code, r.stdout).toBe(1)
      expect(existsSync(output)).toBe(false)
      expect(readFileSync(input)).toEqual(bytes)
    },
  )

  it.each([null, false, '', '1', [], [1]])(
    'rejects an explicit non-index end value: %j',
    async (endBlockIndex) => {
      const { input, output, ops, bytes } = await fixture()
      writeFileSync(
        ops,
        JSON.stringify([
          { op: 'wrap_content_control', startBlockIndex: 0, endBlockIndex, tag: 'Trial' },
        ]),
      )
      const r = await run(['docs', 'apply', input, '--ops', ops, '--out', output, '--json'])
      expect(r.code, r.stdout).toBe(1)
      expect(existsSync(output)).toBe(false)
      expect(readFileSync(input)).toEqual(bytes)
    },
  )

  it.each([undefined, 0, 1])(
    'accepts integer bounds and an omitted end: %s',
    async (endBlockIndex) => {
      const { input, output, ops } = await fixture()
      writeFileSync(
        ops,
        JSON.stringify([
          { op: 'wrap_content_control', startBlockIndex: 0, endBlockIndex, tag: 'Trial' },
        ]),
      )
      const r = await run(['docs', 'apply', input, '--ops', ops, '--out', output, '--json'])
      expect(r.code, r.stdout).toBe(0)
      const read = await run(['docs', 'read', output, '--json'])
      const items = read.json().detail.items as Array<{ contentControl?: { tag: string } }>
      expect(items.filter((b) => b.contentControl?.tag === 'Trial')).toHaveLength(
        (endBlockIndex ?? 0) + 1,
      )
    },
  )
})
