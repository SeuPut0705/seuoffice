/**
 * A PivotTable whose output range cannot be read (no part, no `<location>`, no
 * `ref`, a `ref` that is no range) is in neither `pivotRanges` nor
 * `pivotTables`: its output cells look like ordinary cells. The sheet says how
 * many such pivots it has (`pivotsUnlocated`), so a reader that withholds
 * pivot output built from cells hidden from AI knows when it cannot tell
 * where that output is.
 *
 * The count is made by the engine, in the loop that leaves the pivot out.
 * This file follows it from there to the renderer: the engine's answer, the
 * schema the main process and the web page parse it with, and the preload
 * that rebuilds the sheet for the renderer.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: () => {},
    once: () => {},
    send: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
  },
  webFrame: {},
  webUtils: {},
}))

// the preload itself, loaded for what it exposes to the renderer (through the electron stand-in above)
import '../src/preload/index'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import { workbookFileSchema, type DesktopApi } from '../src/shared/desktop-api'
import { buildEditFixture } from './fixture-builder'

const sheetSchema = workbookFileSchema.shape.sheets.element
/** what the engine sends for a sheet, less the count */
const SHEET = {
  id: 'sheet-1',
  name: 'Data',
  rowCount: 10,
  columnCount: 5,
  columnWidths: [],
  defaultRowHeight: null,
  defaultColumnWidth: null,
  freeze: null,
  hidden: false,
  tabColor: null,
  showGridLines: true,
  tables: [],
  comments: [],
  pivotRanges: [],
}

describe('the count as the main process and the web page read it', () => {
  it('keeps the number the engine reports', () => {
    expect(sheetSchema.parse({ ...SHEET, pivotsUnlocated: 2 }).pivotsUnlocated).toBe(2)
  })

  it('reads an engine that does not report it yet as none', () => {
    expect(sheetSchema.parse(SHEET).pivotsUnlocated).toBe(0)
  })

  it.each([-1, 1.5, '2', null])('refuses %j for a count', (value) => {
    expect(() => sheetSchema.parse({ ...SHEET, pivotsUnlocated: value })).toThrow()
  })
})

describe('the count as the renderer receives it', () => {
  const file = (sheet: Record<string, unknown>) => ({
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: 'book.xlsx',
    sha256: 'a'.repeat(64),
    entryCount: 5,
    sheets: [sheet],
    styles: [],
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
  })
  const api = () => electron.exposed.get('desktopApi') as DesktopApi

  it('carries the number through the preload', async () => {
    electron.invoke.mockResolvedValueOnce(file({ ...SHEET, pivotsUnlocated: 3 }))
    const opened = await api().reopenWorkbook('/books/book.xlsx')
    expect(opened?.sheets[0]?.pivotsUnlocated).toBe(3)
  })

  it('gives none for a sheet that reports no count', async () => {
    electron.invoke.mockResolvedValueOnce(file(SHEET))
    const opened = await api().reopenWorkbook('/books/book.xlsx')
    expect(opened?.sheets[0]?.pivotsUnlocated).toBe(0)
  })

  it('refuses a workbook whose count is not a count', async () => {
    electron.invoke.mockResolvedValueOnce(file({ ...SHEET, pivotsUnlocated: 'many' }))
    await expect(api().reopenWorkbook('/books/book.xlsx')).rejects.toThrow(
      'Invalid worksheet metadata.',
    )
  })
})

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const pivotPart = (body: string) =>
  `<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="P" cacheId="1">${body}</pivotTableDefinition>`

/** one sheet, five pivot relationships: one with a readable output range, four without */
async function workbookWithUnlocatedPivots(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildEditFixture())
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      [1, 2, 3, 4, 5]
        .map(
          (n) =>
            `<Relationship Id="rId${n}" Type="${REL}/pivotTable" Target="../pivotTables/pivotTable${n}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  )
  zip.file(
    'xl/pivotTables/pivotTable1.xml',
    pivotPart('<location ref="E3:F5" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>'),
  )
  // pivotTable2.xml: the relationship points at a part that is not there
  zip.file('xl/pivotTables/pivotTable3.xml', pivotPart(''))
  zip.file(
    'xl/pivotTables/pivotTable4.xml',
    pivotPart('<location firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>'),
  )
  zip.file(
    'xl/pivotTables/pivotTable5.xml',
    pivotPart('<location ref="nowhere" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>'),
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('the count as the engine reports it', () => {
  let directory: string
  let client: XlsxSidecarClient

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pivots-unlocated-'))
    const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
    client = new XlsxSidecarClient(
      fileURLToPath(new URL(`../native/xlsx-engine/target/release/${executable}`, import.meta.url)),
    )
  })

  afterAll(async () => {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  })

  const openSheets = async (name: string, bytes: Buffer) => {
    const path = join(directory, name)
    await writeFile(path, bytes)
    const opened = workbookFileSchema
      .omit({ sha256: true, readOnly: true })
      .parse(await client.open(path))
    await client.close(opened.sessionId)
    return opened.sheets
  }

  it('counts every pivot of a sheet whose output range it could not read', async () => {
    const [sheet] = await openSheets('unlocated.xlsx', await workbookWithUnlocatedPivots())
    // the one pivot that says where its output is, is known as before
    expect(sheet?.pivotRanges).toEqual([{ startRow: 2, endRow: 4, startColumn: 4, endColumn: 5 }])
    expect(sheet?.pivotsUnlocated).toBe(4)
  })

  it('reports none for a sheet without such a pivot', async () => {
    const [sheet] = await openSheets('plain.xlsx', await buildEditFixture())
    expect(sheet?.pivotsUnlocated).toBe(0)
  })
})
