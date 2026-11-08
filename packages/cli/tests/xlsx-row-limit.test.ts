import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run, tempDir } from './helpers'

const fakes = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/resources')>()),
  xlsxSidecarPath: () => 'fake-sidecar',
}))
vi.mock('../../../apps/sheets/src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    async open() {
      return {
        sessionId: 'session',
        activeTab: 0,
        sheets: [{ id: 's1', name: 'Data', rowCount: 100001, columnCount: 2 }],
      }
    }
    readRange = fakes.read
    async close() {}
    stop() {}
  },
}))

const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }
const cells = [
  { row: 0, column: 0, value: 1 },
  { row: 0, column: 1, value: 2, formula: '1+1' },
  { row: 1, column: 0, value: 3 },
  { row: 2, column: 1, value: 4 },
  { row: 99999, column: 0, value: 5 },
  { row: 100000, column: 1, value: 6 },
]
beforeEach(() => {
  fakes.read.mockReset().mockImplementation(async ({ range: r }) => {
    if ((r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1) > 100000)
      throw new Error('Range exceeds the 100000 cell response limit.')
    return {
      indexingComplete: true,
      cells: cells.filter(
        (c) =>
          c.row >= r.startRow &&
          c.row <= r.endRow &&
          c.column >= r.startColumn &&
          c.column <= r.endColumn,
      ),
      rows: [],
      merges: [],
      hyperlinks: [],
    }
  })
})

async function read(flags: string[]) {
  const file = join(tempDir(), 'data.xlsx')
  writeFileSync(file, 'the reader is mocked')
  const before = readFileSync(file)
  const r = await run(['sheet', 'read', file, ...flags, '--json'], { env })
  expect(readFileSync(file)).toEqual(before)
  return r
}

describe('sheet row limits constrain the work before reading', () => {
  it('reads one row from a range above the sidecar limit', async () => {
    const r = await read(['--range', 'A1:B100001', '--max-rows', '1'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({
      range: 'A1:B1',
      rows: [[1, 2]],
      rowsShown: 1,
      rowsTotal: 100001,
      truncated: true,
    })
    expect(r.json().detail.note).toContain('A2:B100001')
    expect(fakes.read.mock.calls[0]![0].range).toMatchObject({ startRow: 0, endRow: 0 })
  })

  it('starts the limited read at the requested row', async () => {
    const r = await read(['--range', 'A100000:B200000', '--max-rows', '1'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({
      range: 'A100000:B100000',
      rows: [[5, null]],
      rowsTotal: 100001,
    })
    expect(r.json().detail.note).toContain('A100001:B200000')
    expect(fakes.read.mock.calls[0]![0].range).toMatchObject({ startRow: 99999, endRow: 99999 })
  })

  it('limits the default preview request too', async () => {
    const r = await read(['--max-rows', '1'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({ range: 'A1:B1', rowsTotal: 100001 })
    expect(fakes.read.mock.calls[0]![0].range.endRow).toBe(0)
  })

  it('combines a row limit with column and formula filters', async () => {
    const r = await read([
      '--range',
      'A1:B100001',
      '--max-rows',
      '1',
      '--where',
      'formula',
      '--cols',
      'B',
    ])
    expect(r.code).toBe(0)
    expect(r.json().detail.cells).toEqual([{ ref: 'B1', value: 2, formula: '=1+1' }])
    expect(r.json().detail.columns).toEqual(['B'])
    expect(r.json().detail.matches).toBe(1)
  })

  it('keeps an uncapped small range unchanged', async () => {
    const r = await read(['--range', 'A1:B2'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({
      range: 'A1:B2',
      rows: [
        [1, 2],
        [3, null],
      ],
      rowsShown: 2,
      rowsTotal: 2,
      truncated: false,
    })
    expect(fakes.read.mock.calls[0]![0].range.endRow).toBe(1)
  })

  it('preserves full scanned-range statistics even when the listed rows are capped', async () => {
    const r = await read(['--range', 'A1:B3', '--max-rows', '1', '--stats'])
    expect(r.code).toBe(0)
    expect(r.json().detail.stats).toMatchObject({
      scanned: 'A1:B3',
      nonEmpty: 4,
      numbers: 4,
      formulas: 1,
    })
    expect(fakes.read.mock.calls[0]![0].range.endRow).toBe(2)
  })

  it('does not leak the A1 feature probe into an empty requested range', async () => {
    const r = await read(['--range', 'A150000:B250000', '--max-rows', '1'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({
      range: 'A150000:B150000',
      rows: [[null, null]],
      formulas: {},
      rowsTotal: 100001,
    })
    expect(fakes.read.mock.calls[0]![0].range).toMatchObject({ startRow: 0, endRow: 0 })
  })
})
