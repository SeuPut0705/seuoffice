// @vitest-environment jsdom
/**
 * A PDF of a sheet cannot keep the marks that hide cells from the AI: the page
 * text is the value, and whatever reads the file later reads it. The person's
 * own export asks first (keep .xlsx / export without the marks / cancel), and
 * an export nobody can be asked about (the headless CLI) is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRedactionIndex, NO_REDACTIONS } from '../src/renderer/ai/redact'
import { createEditJournal } from '../src/renderer/edit-journal'
import { setModuleLang } from '../src/renderer/i18n/locale'
import {
  createPrintPreviewHost,
  handleExportPdf,
  type PageLayoutContext,
} from '../src/renderer/page-layout-actions'
import type { RedactionIndex } from '../src/renderer/ai/redact'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

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

const exportPdf = vi.fn()
const askWithheldExport = vi.fn()

beforeEach(() => {
  setModuleLang('en')
  exportPdf.mockReset().mockResolvedValue({ canceled: false, path: '/docs/book.pdf' })
  askWithheldExport.mockReset()
  vi.stubGlobal('window', {
    desktopApi: {
      exportPdf,
      askWithheldExport,
      readWorkbookRange: vi.fn().mockResolvedValue({
        cells: [],
        rows: [],
        indexingComplete: true,
        indexedThroughRow: 1,
        sheetProtection: null,
        rowBreaks: [],
        colBreaks: [],
        pageSetup: null,
        protectedRanges: [],
      }),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(index: RedactionIndex) {
  const messages: string[] = []
  const worksheet = {
    getSheetId: () => 'sheet-1',
    getSheetName: () => 'Sheet1',
    getLastRow: () => 1,
    getLastColumn: () => 1,
    getRowHeight: () => 20,
    getColumnWidth: () => 100,
    getMergedRanges: () => [],
    getRange: () => ({
      getValues: () => [['A1']],
      getDisplayValues: () => [['A1']],
      getCellStyleData: () => null,
    }),
    getMaxRows: () => 10,
    getMaxColumns: () => 10,
    isSheetHidden: () => false,
    activate: () => undefined,
  }
  const workbook = {
    getActiveSheet: () => worksheet,
    getActiveRange: () => null,
    getSheets: () => [worksheet],
    getSheetBySheetId: () => worksheet,
    getSnapshot: () => ({ sheets: {} }),
  }
  const state = {
    file: { name: 'book.xlsx', sessionId: 'session-1', sheets: SHEETS, visuals: [] },
    flags: { preloadComplete: true, preloadRunning: false },
    editJournal: createEditJournal(),
    sheetFilePageSetups: new Map(),
    sheetPageBreaks: new Map(),
    sheetProtections: new Map(),
    sheetProtectedRanges: new Map(),
  } as unknown as LazyWorkbookState
  const requestSaveAs = vi.fn()
  const ctx = {
    univerRef: {
      current: { univerAPI: { getActiveWorkbook: () => workbook } } as unknown as UniverRuntime,
    },
    lazyWorkbookRef: { current: state as LazyWorkbookState | null },
    setMessage: (message: string) => messages.push(message),
    setPendingEdits: vi.fn(),
    requestVisualInstall: vi.fn(),
    runOps: () => Promise.reject(new Error('page layout ops are not used here')),
    redactions: () => index,
    requestSaveAs,
  } as PageLayoutContext & { requestSaveAs: () => void }
  return { ctx, messages, requestSaveAs }
}

describe('exporting a sheet that holds a cell hidden from the AI as PDF', () => {
  it('asks before anything is written, and writes the real page when the person asks for that', async () => {
    askWithheldExport.mockResolvedValue('export')
    const { ctx, requestSaveAs } = context(HIDDEN_A1)
    expect(await handleExportPdf(ctx)).toBe(true)
    expect(askWithheldExport).toHaveBeenCalledTimes(1)
    expect(askWithheldExport).toHaveBeenCalledWith('PDF')
    expect(exportPdf).toHaveBeenCalledTimes(1)
    expect(askWithheldExport.mock.invocationCallOrder[0]).toBeLessThan(
      exportPdf.mock.invocationCallOrder[0]!,
    )
    expect(requestSaveAs).not.toHaveBeenCalled()
  })

  it('writes nothing when the person cancels', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx, requestSaveAs, messages } = context(HIDDEN_A1)
    expect(await handleExportPdf(ctx)).toBe(false)
    expect(exportPdf).not.toHaveBeenCalled()
    expect(requestSaveAs).not.toHaveBeenCalled()
    expect(messages.at(-1)).toBe('PDF export canceled.')
  })

  it('goes to Save As .xlsx and writes no PDF when the person asks for that', async () => {
    askWithheldExport.mockResolvedValue('xlsx')
    const { ctx, requestSaveAs } = context(HIDDEN_A1)
    expect(await handleExportPdf(ctx)).toBe(false)
    expect(exportPdf).not.toHaveBeenCalled()
    expect(requestSaveAs).toHaveBeenCalledTimes(1)
  })

  it('asks for Save As › PDF too, since that target was picked before the hidden cells came up', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { ctx } = context(HIDDEN_A1)
    expect(await handleExportPdf(ctx, undefined, '/docs/book.pdf')).toBe(false)
    expect(askWithheldExport).toHaveBeenCalledTimes(1)
    expect(exportPdf).not.toHaveBeenCalled()
  })

  it('refuses an export nobody can be asked about, and writes nothing', async () => {
    const { ctx } = context(HIDDEN_A1)
    await expect(handleExportPdf(ctx, '/out/book.pdf')).rejects.toThrow(/hidden from the AI/)
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportPdf).not.toHaveBeenCalled()
  })

  it.each([
    ['a workbook that hides nothing', NO_REDACTIONS],
    ['a mark on another sheet only', HIDDEN_ELSEWHERE],
  ])('still writes for %s, without a box', async (_what, index) => {
    const { ctx } = context(index)
    expect(await handleExportPdf(ctx)).toBe(true)
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportPdf).toHaveBeenCalledTimes(1)
    // and a headless export of such a workbook is still written
    exportPdf.mockClear()
    expect(await handleExportPdf(ctx, '/out/book.pdf')).toBe(true)
    expect(exportPdf).toHaveBeenCalledTimes(1)
  })
})

describe('exporting from the Print dialog as PDF', () => {
  async function job(index: RedactionIndex) {
    const { ctx, requestSaveAs } = context(index)
    const host = createPrintPreviewHost(ctx)!
    return { host, requestSaveAs, built: await host.buildJob('active', {}) }
  }

  it('asks first, and writes nothing when the person cancels', async () => {
    askWithheldExport.mockResolvedValue('cancel')
    const { host, built } = await job(HIDDEN_A1)
    await host.exportPdf(built, null)
    expect(askWithheldExport).toHaveBeenCalledTimes(1)
    expect(exportPdf).not.toHaveBeenCalled()
  })

  it('writes the page when the person exports without the marks', async () => {
    askWithheldExport.mockResolvedValue('export')
    const { host, built } = await job(HIDDEN_A1)
    await host.exportPdf(built, null)
    expect(exportPdf).toHaveBeenCalledTimes(1)
  })

  it('does not ask about a workbook that hides nothing', async () => {
    const { host, built } = await job(NO_REDACTIONS)
    await host.exportPdf(built, null)
    expect(askWithheldExport).not.toHaveBeenCalled()
    expect(exportPdf).toHaveBeenCalledTimes(1)
  })
})
