import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { xlsxBufferFromSheets } from '@seuoffice/xlsx-gateway/gateway/csv-import-xlsx'
import { EXIT } from '../src/result'
import { run, tempDir } from './helpers'

// The sidecar is a stand-in that opens anything: what is under test is what the
// CLI itself does with the file's bytes beside it.
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
        sheets: [{ id: 's1', name: 'Data', rowCount: 1, columnCount: 1 }],
      }
    }
    async readRange() {
      return {
        indexingComplete: true,
        cells: [{ row: 0, column: 0, value: 1 }],
        rows: [],
        merges: [],
        hyperlinks: [],
      }
    }
    async updateExternalLinks() {
      return {
        links: [{ index: 1, reachable: true }],
        cells: [
          { sheet: 'Data', row: 0, column: 0, formatted: '2', number: 2, formula: '[1]S!A1' },
        ],
      }
    }
    async close() {}
    stop() {}
  },
}))

const env = { ...process.env, SEUOFFICE_AUDIT_LOG: 'off' }

/** What the CLI prints when the zip gate refuses a workbook (as `sheet apply --ops` does). */
const REFUSAL = { status: 'error', message: 'zip: zip64 archives are not supported' }

/**
 * The archive as ZIP64: the disk number of its end record all ones, with a
 * ZIP64 end record and locator in front. JSZip opens it; the zip gate refuses
 * every archive JSZip reads this way, because JSZip's ZIP64 reader does not
 * return from some of them.
 */
function asZip64(archive: Buffer): Buffer {
  const end = archive.length - 22
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeUInt32LE(44, 4)
  record.writeUInt32LE(archive.readUInt16LE(end + 10), 32)
  record.writeUInt32LE(archive.readUInt32LE(end + 12), 40)
  record.writeUInt32LE(archive.readUInt32LE(end + 16), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(end, 8)
  locator.writeUInt32LE(1, 16)
  const endRecord = Buffer.from(archive.subarray(end))
  endRecord.writeUInt16LE(0xffff, 4)
  return Buffer.concat([archive.subarray(0, end), record, locator, endRecord])
}

let zip64: Buffer
beforeAll(async () => {
  zip64 = asZip64(Buffer.from(await xlsxBufferFromSheets([{ name: 'Data', rows: [['1']] }])))
  // what makes the cases: without the gate JSZip opens these bytes
  expect(Object.keys((await JSZip.loadAsync(zip64)).files)).toContain('xl/workbook.xml')
})

function workbook(): string {
  const path = join(tempDir(), 'book.xlsx')
  writeFileSync(path, zip64)
  return path
}

describe('a workbook the zip gate refuses never reaches JSZip', () => {
  let loadAsync: MockInstance<typeof JSZip.loadAsync>
  beforeEach(() => {
    loadAsync = vi.spyOn(JSZip, 'loadAsync')
  })
  afterEach(() => {
    loadAsync.mockRestore()
  })

  it('sheet check reports the refusal', async () => {
    const r = await run(['sheet', 'check', workbook(), '--json'], { env })
    expect(r.code).toBe(EXIT.conversion)
    expect(r.json()).toMatchObject(REFUSAL)
    expect(loadAsync).not.toHaveBeenCalled()
  })

  it('sheet read reports the refusal: the cells it withholds from AI cannot be read', async () => {
    const r = await run(['sheet', 'read', workbook(), '--formats', '--json'], { env })
    expect(r.code).toBe(EXIT.conversion)
    expect(r.json()).toMatchObject(REFUSAL)
    expect(loadAsync).not.toHaveBeenCalled()
  })

  it('sheet links --update reports the refusal and writes nothing', async () => {
    const path = workbook()
    const r = await run(['sheet', 'links', path, '--update', '--json'], { env })
    expect(r.code).toBe(EXIT.conversion)
    expect(r.json()).toMatchObject(REFUSAL)
    expect(loadAsync).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(zip64)
  })

  it('sheet apply --cells with a theme color reports the refusal and writes nothing', async () => {
    const path = workbook()
    const cells = join(tempDir(), 'cells.json')
    writeFileSync(
      cells,
      JSON.stringify([{ cell: 'A1', value: 2, style: { fontColor: { theme: 4 } } }]),
    )
    const r = await run(['sheet', 'apply', path, '--cells', cells, '--json'], { env })
    expect(r.code).toBe(EXIT.conversion)
    expect(r.json()).toMatchObject(REFUSAL)
    expect(loadAsync).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(zip64)
  })
})
