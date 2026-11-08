import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBasicWorkbook } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { run, tempDir } from './helpers'

describe('workbook creation with XML-invalid sheet names', () => {
  it.each([
    'Bad\u0000Name',
    'Bad\u0001Name',
    'Bad\u000bName',
    'Bad\u001fName',
    'Bad\ufffeName',
    'Bad\uffffName',
    'Bad\ud800Name',
    'Bad\udfffName',
  ])('rejects %j before creating the output', async (name) => {
    const dir = tempDir()
    const source = join(dir, 'data.json')
    const input = JSON.stringify({ sheets: [{ name, rows: [[1]] }] })
    writeFileSync(source, input)
    const out = join(dir, 'out.xlsx')
    const result = await run(['create', '--type', 'xlsx', '--from', source, '--out', out, '--json'])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(result.json().message).toContain('sheets[0].name')
    expect(existsSync(out)).toBe(false)
    expect(readFileSync(source, 'utf-8')).toBe(input)
  })
  it('validates later names before --force can replace an existing output', async () => {
    const dir = tempDir()
    const source = join(dir, 'data.json')
    writeFileSync(
      source,
      JSON.stringify({
        sheets: [
          { name: 'Good', rows: [[1]] },
          { name: 'Bad\u0001Name', rows: [[2]] },
        ],
      }),
    )
    const out = join(dir, 'out.xlsx')
    const before = Buffer.from('keep the existing output')
    writeFileSync(out, before)
    const result = await run([
      'create',
      '--type',
      'xlsx',
      '--from',
      source,
      '--out',
      out,
      '--force',
      '--json',
    ])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(result.json().message).toContain('sheets[1].name')
    expect(readFileSync(out)).toEqual(before)
  })
  it.each(['Data', '매출 📊', 'Sales & "Q"', "O'Brien", 'Valid\ufdd0Name'])(
    'round trips the valid name %j unchanged',
    async (name) => {
      const dir = tempDir()
      const source = join(dir, 'data.json')
      writeFileSync(source, JSON.stringify({ sheets: [{ name, rows: [[1]] }] }))
      const out = join(dir, 'out.xlsx')
      const result = await run([
        'create',
        '--type',
        'xlsx',
        '--from',
        source,
        '--out',
        out,
        '--json',
      ])
      expect(result.code).toBe(0)
      expect((await readBasicWorkbook(readFileSync(out))).snapshot.sheets[0]!.name).toBe(name)
    },
  )
})
