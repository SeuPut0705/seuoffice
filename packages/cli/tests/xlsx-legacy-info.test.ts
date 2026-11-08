import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { run, tempDir } from './helpers'

const fake = vi.hoisted(() => ({
  opens: [] as string[],
  converts: [] as string[],
  failConvert: false,
  failOpen: false,
}))
vi.mock('../src/resources', async (original) => ({
  ...(await original<object>()),
  xlsxSidecarPath: () => 'fake-sidecar',
}))
vi.mock('../../../apps/sheets/src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    async open(path: string) {
      fake.opens.push(path)
      if (/\.(xls|xlsb|ods)$/i.test(path) || fake.failOpen) throw new Error('cannot open directly')
      return {
        sessionId: 'test',
        activeTab: 1,
        sheets: [
          { id: '1', name: 'First', rowCount: 3, columnCount: 2 },
          { id: '2', name: 'Second', rowCount: 5, columnCount: 4 },
        ],
        definedNames: ['Example'],
      }
    }
    async convertWorkbook({ targetPath }: { targetPath: string }) {
      fake.converts.push(targetPath)
      writeFileSync(targetPath, 'converted fixture')
      if (fake.failConvert) throw new Error('conversion failed')
      return { sheets: 2, cells: 10 }
    }
    async close() {}
    stop() {}
  },
}))

beforeEach(() => {
  fake.opens.length = 0
  fake.converts.length = 0
  fake.failConvert = false
  fake.failOpen = false
})

for (const ext of ['xls', 'XLS', 'xlsb', 'ods']) {
  it(`summarizes .${ext} through a temporary conversion and keeps the input intact`, async () => {
    const path = join(tempDir(), 'legacy.' + ext)
    writeFileSync(path, 'legacy fixture')
    const r = await run(['info', path, '--json'])
    expect(r.code, r.stdout).toBe(0)
    expect(r.json().detail.sheets).toEqual([
      { name: 'First', rows: 3, columns: 2 },
      { name: 'Second', rows: 5, columns: 4 },
    ])
    expect(r.json().detail.active_sheet).toBeUndefined()
    expect(r.json().detail.defined_names).toBeUndefined()
    expect(r.json().detail.note).toContain('converted values and formulas')
    expect(fake.converts).toHaveLength(1)
    expect(extname(fake.opens[0]!)).toBe('.xlsx')
    expect(existsSync(dirname(fake.converts[0]!))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('legacy fixture')
  })
}

for (const ext of ['xlsx', 'xlsm']) {
  it(`keeps .${ext} on the direct open path`, async () => {
    const path = join(tempDir(), 'book.' + ext)
    writeFileSync(path, 'modern fixture')
    expect((await run(['info', path, '--json'])).code).toBe(0)
    expect(fake.opens).toEqual([path])
    expect(fake.converts).toHaveLength(0)
    expect((await run(['info', path, '--json'])).json().detail.active_sheet).toBe('Second')
  })
}

for (const stage of ['convert', 'open']) {
  it(`cleans the temporary conversion after ${stage} fails`, async () => {
    const path = join(tempDir(), 'legacy.xls')
    writeFileSync(path, 'legacy fixture')
    fake.failConvert = stage === 'convert'
    fake.failOpen = stage === 'open'
    const r = await run(['info', path, '--json'])
    expect(r.code).not.toBe(0)
    expect(fake.converts).toHaveLength(1)
    expect(existsSync(dirname(fake.converts[0]!))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('legacy fixture')
  })
}
