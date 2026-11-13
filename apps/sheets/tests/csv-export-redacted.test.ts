// @vitest-environment jsdom
/**
 * A CSV copy cannot keep the marks that hide cells from the AI: it is plain
 * text, and what a model later reads from it is the value. The export, and a
 * CSV session's own save, refuse before serializing, and offer .xlsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRedactionIndex, NO_REDACTIONS } from '../src/renderer/ai/redact'
import { REDACTIONS_UNREADABLE, redactionIndexOf } from '../src/renderer/ai/redact-load'
import { csvWouldExposeWithheld, handleExportCsv } from '../src/renderer/csv-export'
import { createEditJournal } from '../src/renderer/edit-journal'
import { setModuleLang } from '../src/renderer/i18n/locale'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

/// A fully loaded one-row workbook (A1 = 2, B1 = 3, C1 = A1*B1) whose formula
/// result has not landed yet, as right after the stream completes on a file
/// saved without cached values.
function harness(pendingFormula = false) {
  const cells: { v?: number; f?: string }[] = [
    { v: 2 },
    { v: 3 },
    pendingFormula ? { f: '=A1*B1' } : { f: '=A1*B1', v: 6 },
  ]
  const display = () => [cells.map((cell) => (cell.v === undefined ? '' : String(cell.v)))]
  const worksheet = {
    getSheetId: () => 'sheet-1',
    getSheetName: () => 'Sheet1',
    getLastRow: () => 0,
    getLastColumn: () => 2,
    getRowHeight: () => 20,
    getColumnWidth: () => 100,
    getMergedRanges: () => [],
    getRange: () => ({
      getValues: () => [cells.map((cell) => cell.v ?? null)],
      getRawValues: () => [cells.map((cell) => cell.v ?? null)],
      getDisplayValues: display,
      getCellStyleData: () => null,
    }),
    getMaxRows: () => 10,
    getMaxColumns: () => 10,
    isSheetHidden: () => false,
    getSheet: () => ({
      getRowVisible: () => true,
      getColVisible: () => true,
      getCellMatrix: () => ({
        forValue: (visit: (row: number, column: number, cell: { f?: string }) => unknown) =>
          cells.forEach((cell, column) => visit(0, column, cell)),
      }),
    }),
  }
  const calculate = vi.fn()
  const workbook = {
    getActiveSheet: () => worksheet,
    getActiveRange: () => null,
    getSheets: () => [worksheet],
    getSheetBySheetId: () => worksheet,
    getSnapshot: () => ({
      sheets: { 'sheet-1': { cellData: { 0: Object.fromEntries(cells.entries()) } } },
    }),
  }
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => workbook,
      getFormula: () => ({
        executeCalculation: calculate,
        calculationEnd: () => ({ dispose: () => undefined }),
      }),
    },
  } as unknown as UniverRuntime
  const state = {
    file: {
      name: 'book.xlsx',
      sessionId: 'session-1',
      sheets: [{ id: 'sheet-1', name: 'Sheet1', rowCount: 10, columnCount: 10 }],
      visuals: [],
    },
    flags: { preloadComplete: true, preloadRunning: false },
    editJournal: createEditJournal(),
    sheetFilePageSetups: new Map(),
    sheetPageBreaks: new Map(),
    sheetProtections: new Map(),
    sheetProtectedRanges: new Map(),
    showFormulaSheets: new Set<string>(),
  } as unknown as LazyWorkbookState
  const refs = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state as LazyWorkbookState | null },
    setMessage: () => undefined,
  }
  return { refs }
}

const SHEETS = [{ id: 'sheet-1', name: 'Sheet1' }]
/** A1 hidden */
const HIDDEN_A1 = buildRedactionIndex(
  [
    {
      sheetName: 'Sheet1',
      marks: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, label: 'client phone' }],
    },
  ],
  SHEETS,
)
/** a mark on another sheet only */
const HIDDEN_ELSEWHERE = buildRedactionIndex(
  [
    {
      sheetName: 'Other',
      marks: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, label: 'x' }],
    },
  ],
  [...SHEETS, { id: 'sheet-2', name: 'Other' }],
)

const exportCsv = vi.fn()
const askWithheldCsv = vi.fn()

beforeEach(() => {
  setModuleLang('en')
  exportCsv.mockReset().mockResolvedValue({ canceled: false, path: '/docs/book.csv' })
  askWithheldCsv.mockReset()
  vi.stubGlobal('window', { desktopApi: { exportCsv, askWithheldCsv } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function run(index: ReturnType<typeof redactionIndexOf>, requestSaveAs = vi.fn()) {
  const messages: string[] = []
  const { refs } = harness()
  const done = handleExportCsv(
    {
      ...refs,
      setMessage: (message) => messages.push(message),
      requestSaveAs,
      redactions: () => index,
    },
    '/docs/book.csv',
  )
  return { done, messages, requestSaveAs }
}

describe('exporting a sheet that holds a cell hidden from the AI as CSV', () => {
  it('goes to Save As .xlsx and writes no CSV when the person asks for that', async () => {
    askWithheldCsv.mockResolvedValue('xlsx')
    const { done, requestSaveAs } = run(HIDDEN_A1)
    await done
    expect(askWithheldCsv).toHaveBeenCalledTimes(1)
    expect(exportCsv).not.toHaveBeenCalled()
    expect(requestSaveAs).toHaveBeenCalledTimes(1)
  })

  it('writes the real values, and says no mark came with them, when the person asks for that', async () => {
    askWithheldCsv.mockResolvedValue('export')
    const { done, requestSaveAs } = run(HIDDEN_A1)
    await done
    expect(askWithheldCsv).toHaveBeenCalledTimes(1)
    expect(requestSaveAs).not.toHaveBeenCalled()
    expect(exportCsv).toHaveBeenCalledTimes(1)
    // the values as they are, never a placeholder, and nothing else in the file
    expect(exportCsv.mock.calls[0]?.[0].content).toBe('2,3,6\r\n')
  })

  it('writes nothing when the person cancels', async () => {
    askWithheldCsv.mockResolvedValue('cancel')
    const { done, requestSaveAs, messages } = run(HIDDEN_A1)
    await done
    expect(exportCsv).not.toHaveBeenCalled()
    expect(requestSaveAs).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it('asks about a record that could not be read, which hides every cell', async () => {
    askWithheldCsv.mockResolvedValue('cancel')
    await run(redactionIndexOf(REDACTIONS_UNREADABLE)).done
    expect(askWithheldCsv).toHaveBeenCalledTimes(1)
    expect(exportCsv).not.toHaveBeenCalled()
  })

  it.each([
    ['a workbook that hides nothing', NO_REDACTIONS],
    ['a mark on another sheet only', HIDDEN_ELSEWHERE],
  ])('still writes for %s', async (_what, index) => {
    await run(index).done
    expect(askWithheldCsv).not.toHaveBeenCalled()
    expect(exportCsv).toHaveBeenCalledTimes(1)
  })

  it('judges a sheet by its own marks', () => {
    expect(csvWouldExposeWithheld(HIDDEN_A1, 'sheet-1', 'Sheet1')).toBe(true)
    expect(csvWouldExposeWithheld(HIDDEN_A1, 'sheet-9', 'Elsewhere')).toBe(false)
    expect(csvWouldExposeWithheld(NO_REDACTIONS, 'sheet-1', 'Sheet1')).toBe(false)
  })
})
