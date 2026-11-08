import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { run, tempDir } from './helpers'

const fake = vi.hoisted(() => ({ writes: vi.fn() }))
vi.mock('../src/formats/xlsx', async (original) => ({
  ...(await original<object>()),
  workbookSummary: async () => ({
    activeSheet: 'Data',
    sheets: [{ name: 'Data', rows: 2, columns: 2 }],
    definedNames: 0,
  }),
  writeWorkbook: async (_source: Buffer, _edits: unknown[], output: string) => {
    fake.writes(output)
    writeFileSync(output, 'writer output')
    return { cells: 1, formulas: 0, cachedValues: true }
  },
}))
vi.mock('../src/formats/xlsx-dsl', async (original) => {
  const { EMPTY_PAYLOADS } = await import('../src/formats/xlsx-gateway-ops')
  return {
    ...(await original<object>()),
    runWorkbookDsl: async () => ({
      edits: [],
      structuralOps: [],
      warnings: [],
      gateway: EMPTY_PAYLOADS,
    }),
  }
})
beforeEach(() => fake.writes.mockClear())

function fixture() {
  const dir = tempDir()
  const input = join(dir, 'form.xlsx')
  const cells = join(dir, 'cells.json')
  const ops = join(dir, 'ops.json')
  writeFileSync(input, 'original fixture')
  writeFileSync(cells, JSON.stringify([{ cell: 'A1', value: 'Trial' }]))
  writeFileSync(ops, JSON.stringify([{ op: 'set_value', cell: 'A1', value: 'Trial' }]))
  return { dir, input, cells, ops }
}

for (const flag of ['--dry-run', '--best-effort', '--stop-on-error']) {
  for (const separate of [false, true]) {
    it(`refuses ${flag} with --cells (${separate ? 'named output' : 'in place'})`, async () => {
      const { dir, input, cells } = fixture()
      const output = join(dir, 'existing.xlsx')
      writeFileSync(output, 'keep output')
      const r = await run([
        'sheet',
        'apply',
        input,
        '--cells',
        cells,
        flag,
        ...(separate ? ['--out', output, '--force'] : []),
        '--json',
      ])
      expect(r.code, r.stdout).toBe(1)
      expect(r.json().error).toBe('invalid_argument')
      expect(r.json().message).toContain('--ops')
      expect(fake.writes).not.toHaveBeenCalled()
      expect(readFileSync(input, 'utf8')).toBe('original fixture')
      expect(readFileSync(output, 'utf8')).toBe('keep output')
    })
  }
}
it('refuses simultaneous --cells and --ops before reading either list', async () => {
  const { input, cells, ops } = fixture()
  writeFileSync(ops, 'invalid JSON deliberately')
  const r = await run(['sheet', 'apply', input, '--cells', cells, '--ops', ops, '--json'])
  expect(r.code).toBe(1)
  expect(r.json().error).toBe('invalid_argument')
  expect(fake.writes).not.toHaveBeenCalled()
})
it('keeps normal --cells writes working', async () => {
  const { input, cells } = fixture()
  expect((await run(['sheet', 'apply', input, '--cells', cells, '--json'])).code).toBe(0)
  expect(fake.writes).toHaveBeenCalledWith(input)
})
it('keeps --ops --dry-run working without writing', async () => {
  const { dir, input, ops } = fixture()
  const output = join(dir, 'new.xlsx')
  const r = await run([
    'sheet',
    'apply',
    input,
    '--ops',
    ops,
    '--dry-run',
    '--out',
    output,
    '--json',
  ])
  expect(r.code, r.stdout).toBe(0)
  expect(fake.writes).not.toHaveBeenCalled()
  expect(existsSync(output)).toBe(false)
})
it('keeps the missing edit source diagnostic', async () => {
  const { input } = fixture()
  const r = await run(['sheet', 'apply', input, '--json'])
  expect(r.json().error).toBe('missing_argument')
})
