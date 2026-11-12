import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxSidecarPath } from '../src/resources'
import { hiddenXlsx, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'
import { expectNoGiveaway } from './rich-hidden-xlsx'

const sidecar = Boolean(xlsxSidecarPath())

/**
 * A hidden B2 holds the phone number under the label "phone" (a word, so the
 * placeholder {{phone}} is also a valid template key), C2 `=B2*2` computes from
 * it, and A3 is a template cell asking for the same key.
 */
async function templateWithHiddenCell(dir: string): Promise<string> {
  const file = await hiddenXlsx(dir, 'template.xlsx', async (path) => {
    const ops = join(dir, 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([{ op: 'set_cell', address: 'A3', value: '{{phone}}', type: 'text' }]),
    )
    expect((await run(['sheet', 'apply', path, '--ops', ops, '--json'])).code).toBe(0)
  })
  const zip = await JSZip.loadAsync(readFileSync(file))
  for (const part of ['xl/gxRedactions.json', 'xl/workbook.xml']) {
    zip.file(part, (await zip.file(part)!.async('string')).replaceAll('client phone', 'phone'))
  }
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}

describe.skipIf(!sidecar)('merge into an xlsx template with a cell hidden from AI', () => {
  it('fills the visible placeholder and leaves the hidden cell, and what computes from it, alone', async () => {
    const dir = tempDir()
    const file = await templateWithHiddenCell(dir)
    const out = join(dir, 'merged.xlsx')
    const data = JSON.stringify({ phone: 'X', private: 'Y' })
    const merged = await run(['merge', file, '--data', data, '--out', out, '--json'])
    expect(merged.code, merged.stdout).toBe(0)
    expectNoGiveaway(merged.stdout + merged.stderr, 'merge output')

    const zip = await JSZip.loadAsync(readFileSync(out))
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toContain(`<v>${SECRET}</v>`)
    expect(sheet).toContain('<f>B2*2</f>')
    expect(sheet).toMatch(/<t[^>]*>X<\/t>/)
    expect(sheet).not.toMatch(/>Y</)
    expect(await zip.file('xl/gxRedactions.json')!.async('string')).toContain('"phone"')

    const read = await run(['sheet', 'read', out, '--json'])
    expect(read.json().detail.rows[1][1]).toBe('{{phone}}')
    expectNoGiveaway(read.stdout, 'sheet read after the merge')
  })

  it('does not report the hidden cell as a placeholder of the template', async () => {
    const dir = tempDir()
    const file = await templateWithHiddenCell(dir)
    const merged = await run([
      'merge',
      file,
      '--data',
      JSON.stringify({ unrelated: 'X' }),
      '--out',
      join(dir, 'merged.xlsx'),
      '--json',
    ])
    expectNoGiveaway(merged.stdout + merged.stderr, 'merge report')
    const unresolved = JSON.stringify(merged.json().detail.unresolved_placeholders)
    expect(unresolved).toContain('A3')
    expect(unresolved).not.toContain('B2')
    expect(unresolved).not.toContain('C2')
  })
})
