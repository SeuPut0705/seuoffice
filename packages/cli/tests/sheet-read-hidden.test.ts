import { describe, expect, it } from 'vitest'
import { xlsxSidecarPath } from '../src/resources'
import { hiddenXlsx, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

const sidecar = Boolean(xlsxSidecarPath())

describe('sheet read: a cell hidden from AI', () => {
  it.skipIf(!sidecar)('reads as its placeholder, with its formula and what it feeds', async () => {
    const file = await hiddenXlsx(tempDir())
    for (const flags of [
      [],
      ['--formats'],
      ['--where', 'number'],
      ['--where', 'text'],
      ['--where', 'formula'],
      ['--stats'],
      ['--range', 'B2:C2'],
    ]) {
      const read = await run(['sheet', 'read', file, ...flags, '--json'])
      expect(read.code).toBe(0)
      expect(read.stdout).not.toContain(SECRET)
      // the formula that computes from it would give the number away too
      expect(read.stdout).not.toContain('27600276000')
      expect(read.stdout).not.toContain('B2*2')
    }
    const read = await run(['sheet', 'read', file, '--json'])
    const { rows, formulas } = read.json().detail
    expect(rows[0]).toEqual(['Name', 'Phone', 'Double'])
    expect(rows[1][0]).toBe('Kim')
    expect(rows[1][1]).toBe(PLACEHOLDER)
    expect(rows[1][2]).toBe('{{private}}')
    expect(formulas).toEqual({})
  })

  it.skipIf(!sidecar)('an unmarked workbook reads exactly as before', async () => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir()
    const table = join(dir, 'table.json')
    writeFileSync(
      table,
      JSON.stringify([
        ['Name', 'Phone'],
        ['Kim', 13800138000],
      ]),
    )
    const file = join(dir, 'plain.xlsx')
    expect(
      (await run(['create', '--type', 'xlsx', '--from', table, '--out', file, '--json'])).code,
    ).toBe(0)
    const read = await run(['sheet', 'read', file, '--json'])
    expect(read.json().detail.rows).toEqual([
      ['Name', 'Phone'],
      ['Kim', 13800138000],
    ])
  })
})
