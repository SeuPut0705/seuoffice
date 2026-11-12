/**
 * Merge Workbooks copies the cells of other files into new sheets of the open
 * workbook. A source that hides cells from AI would hand those values over as
 * plain cells, with no mark on them here. Such a source is refused, by name,
 * before anything lands.
 *
 * The main process is stood in for by the functions it answers with: the marks
 * are read from a real package by the reader behind `readWorkbookRedactions`,
 * the cells by the gateway's workbook reader.
 */
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readBasicWorkbook } from '@seuoffice/xlsx-gateway/gateway/xlsx-gateway'
import {
  REDACTION_PART_PATH,
  serializeRedactionPart,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { readRedactionEntries } from '../src/main/workbook-redaction-entries'
import { mergeAttachedWorkbooks, mergeWorkbooksIntoCurrent } from '../src/renderer/merge-workbooks'
import type { UniverRuntime } from '../src/renderer/univer-state'
import type { WorkbookFile } from '../src/shared/desktop-api'
import { buildEditFixture } from './fixture-builder'

const SECRET = '13800138000'
const B2 = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }

/** a one-sheet workbook with the secret at Data!B2, and the given record of hidden cells */
async function sourceBytes(part?: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildEditFixture())
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row>' +
      `<row r="2"><c r="B2" t="inlineStr"><is><t>${SECRET}</t></is></c></row>` +
      '</sheetData></worksheet>',
  )
  if (part !== undefined) zip.file(REDACTION_PART_PATH, part)
  return zip.generateAsync({ type: 'nodebuffer' })
}

interface Source {
  readonly file: WorkbookFile
  readonly bytes: Buffer
}

function source(name: string, sessionId: string, bytes: Buffer): Source {
  const file = {
    sessionId,
    name,
    sheets: [{ id: 'sheet-1', name: 'Data', rowCount: 3, columnCount: 3 }],
    styles: [],
  } as unknown as WorkbookFile
  return { file, bytes }
}

/** the open workbook and the desktop API, recording what the merge does to them */
function desk(sources: readonly Source[]) {
  const commands: { id: string; params: Record<string, unknown> }[] = []
  const closed: string[] = []
  const messages: string[] = []
  const bySession = new Map(sources.map((entry) => [entry.file.sessionId, entry.bytes]))
  const bytesOf = (sessionId: string): Buffer => {
    const bytes = bySession.get(sessionId)
    if (!bytes) throw new Error('Unknown workbook session.')
    return bytes
  }
  vi.stubGlobal('window', {
    desktopApi: {
      selectWorkbooksForMerge: async () => sources.map((entry) => entry.file),
      openWorkbooksForMerge: async () => sources.map((entry) => entry.file),
      closeWorkbook: async (sessionId: string) => {
        closed.push(sessionId)
      },
      readWorkbookRedactions: async ({ sessionId }: { sessionId: string }) => {
        const zip = await JSZip.loadAsync(bytesOf(sessionId))
        return readRedactionEntries({
          has: async (path) => zip.file(path) !== null,
          readText: (path) => zip.file(path)!.async('string'),
        })
      },
      readWorkbookRange: async ({ sessionId }: { sessionId: string }) => {
        const { snapshot } = await readBasicWorkbook(bytesOf(sessionId))
        const cells = Object.entries(snapshot.sheets[0]!.cells).map(([at, cell]) => ({
          row: Number(at.slice(1)) - 1,
          column: at.charCodeAt(0) - 65,
          value: cell.value,
        }))
        return { cells, merges: [], rows: [], indexingComplete: true, indexedThroughRow: null }
      },
    },
  })
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => ({
        getId: () => 'open-workbook',
        getSheets: () => [{ getSheetName: () => 'Sheet1' }],
      }),
    },
    univer: {
      __getInjector: () => ({
        get: () => ({
          executeCommand: async (id: string, params: Record<string, unknown>) => {
            commands.push({ id, params })
            return true
          },
        }),
      }),
    },
  } as unknown as UniverRuntime
  const deps = {
    runtime,
    lazyWorkbookRef: { current: null },
    setMessage: (message: string) => messages.push(message),
  }
  /** every value the merge wrote into the open workbook */
  const landed = (): unknown[] =>
    commands
      .filter((command) => command.id === 'sheet.command.set-range-values')
      .flatMap((command) =>
        Object.values(command.params.value as Record<number, Record<number, { v?: unknown }>>),
      )
      .flatMap((row) => Object.values(row).map((cell) => cell.v))
  return { deps, commands, closed, messages, landed }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('merging a workbook that hides cells from AI', () => {
  it('refuses the file by name and brings nothing in', async () => {
    const marked = source(
      'clients.xlsx',
      '11111111-1111-4111-8111-111111111111',
      await sourceBytes(serializeRedactionPart([{ sheetName: 'Data', marks: [B2] }])),
    )
    const { deps, commands, closed, messages, landed } = desk([marked])
    await mergeWorkbooksIntoCurrent(deps)
    expect(landed()).toEqual([])
    expect(commands).toEqual([])
    expect(messages.at(-1)).toContain('clients.xlsx')
    expect(closed).toEqual([marked.file.sessionId])
  })

  it('refuses a file whose record of hidden cells cannot be read', async () => {
    const damaged = source(
      'damaged.xlsx',
      '22222222-2222-4222-8222-222222222222',
      await sourceBytes('{"version":1,"sheets":['),
    )
    const { deps, commands, messages } = desk([damaged])
    await mergeWorkbooksIntoCurrent(deps)
    expect(commands).toEqual([])
    expect(messages.at(-1)).toContain('damaged.xlsx')
  })

  it('refuses the whole merge when one of several files hides cells', async () => {
    const plain = source('plain.xlsx', '33333333-3333-4333-8333-333333333333', await sourceBytes())
    const marked = source(
      'clients.xlsx',
      '44444444-4444-4444-8444-444444444444',
      await sourceBytes(serializeRedactionPart([{ sheetName: 'Data', marks: [B2] }])),
    )
    const { deps, commands, closed } = desk([plain, marked])
    await expect(mergeAttachedWorkbooks(deps, ['plain.xlsx', 'clients.xlsx'])).rejects.toThrow(
      'clients.xlsx',
    )
    expect(commands).toEqual([])
    expect(closed).toEqual([plain.file.sessionId, marked.file.sessionId])
  })

  it('merges a file that hides nothing as before', async () => {
    const plain = source('plain.xlsx', '55555555-5555-4555-8555-555555555555', await sourceBytes())
    const { deps, landed } = desk([plain])
    await mergeWorkbooksIntoCurrent(deps)
    expect(landed()).toEqual(['Name', SECRET])
  })
})
