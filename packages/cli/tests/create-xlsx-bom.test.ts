import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function create(text: string) {
  const dir = tempDir()
  const input = join(dir, 'table.JSON')
  const output = join(dir, 'table.xlsx')
  writeFileSync(input, text, 'utf-8')
  const result = await run(['create', '--type', 'xlsx', '--from', input, '--out', output, '--json'])
  return { result, output }
}

describe('create xlsx from UTF-8 BOM JSON', () => {
  for (const prefix of ['', '\uFEFF']) {
    it(`accepts a table ${prefix ? 'with' : 'without'} a leading BOM`, async () => {
      const { result, output } = await create(
        prefix + JSON.stringify([['item', 2, true, null], ['=B1+1']]),
      )
      expect(result.code).toBe(0)
      const zip = await JSZip.loadAsync(readFileSync(output))
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
      expect(xml).toContain('item')
      expect(xml).toContain('<v>2</v>')
      expect(xml).toContain('<f>B1+1</f>')
    })
  }

  it('accepts a BOM before a multi-sheet workbook object', async () => {
    const { result, output } = await create(
      '\uFEFF' +
        JSON.stringify({
          sheets: [
            { name: 'First', rows: [[1]] },
            { name: 'Second', rows: [[2]] },
          ],
        }),
    )
    expect(result.code).toBe(0)
    expect(result.json().detail.sheets).toBe(2)
    const zip = await JSZip.loadAsync(readFileSync(output))
    expect(zip.file('xl/worksheets/sheet2.xml')).not.toBeNull()
  })

  it('preserves BOM characters inside cell strings', async () => {
    const { result, output } = await create('\uFEFF' + JSON.stringify([['\uFEFFkeep', 'a\uFEFFb']]))
    expect(result.code).toBe(0)
    const zip = await JSZip.loadAsync(readFileSync(output))
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('\uFEFFkeep')
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('a\uFEFFb')
  })

  for (const [label, text] of [
    ['malformed JSON', '\uFEFF[[1,]'],
    ['a repeated BOM', '\uFEFF\uFEFF[[1]]'],
    ['an unquoted internal BOM', '\uFEFF[\uFEFF[1]]'],
    ['a BOM after whitespace', ' \uFEFF[[1]]'],
    ['a BOM without a JSON value', '\uFEFF'],
  ]) {
    it(`still rejects ${label} without creating output`, async () => {
      const { result, output } = await create(text!)
      expect(result.code).toBe(1)
      expect(result.json().error).toBe('invalid_json')
      expect(existsSync(output)).toBe(false)
    })
  }
})
