/**
 * Saving a CSV session that streams (too large for a full load): the
 * "keep this format?" question must come BEFORE the full-load guard —
 * a streamed session never reaches preloadComplete, so guarding first
 * dead-ended plain Save forever with the Save-As-.xlsx escape hatch
 * unreachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import { buildRedactionIndex, type RedactionIndex } from '../src/renderer/ai/redact'

const saveWorkbookEdits = vi.fn()
const writeWorkbookRecovery = vi.fn()
const confirmCsvSave = vi.fn()
const refuseWithheldCsv = vi.fn()

beforeEach(() => {
  saveWorkbookEdits.mockReset().mockResolvedValue({ canceled: true })
  writeWorkbookRecovery.mockReset().mockResolvedValue({ ok: true })
  confirmCsvSave.mockReset()
  refuseWithheldCsv.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = {
    desktopApi: { saveWorkbookEdits, writeWorkbookRecovery, confirmCsvSave, refuseWithheldCsv },
  }
})

// confirmedCsvSaves is remembered per path across handleSave calls, so every
// test uses its own csv path to stay independent.
let serial = 0

function csvCtx(opts: { preloadComplete: boolean; redactions?: RedactionIndex }): {
  ctx: SaveContext
  messages: string[]
} {
  const journal = createEditJournal()
  recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'edited' } } })
  const messages: string[] = []
  serial += 1
  return {
    messages,
    ctx: {
      univerRef: {
        current: {
          univerAPI: {
            getActiveWorkbook: () => ({
              getActiveSheet: () => ({
                getSheetId: () => 'sheet-1',
                getSheetName: () => 'Sheet1',
                getLastRow: () => 0,
                getLastColumn: () => 0,
                getRange: () => ({ getDisplayValues: () => [['x']], getRawValues: () => [['x']] }),
                getSheet: () => ({ getCellMatrix: () => ({ forValue: () => undefined }) }),
              }),
              getSheets: () => [{}],
            }),
          },
        } as never,
      },
      ...(opts.redactions ? { redactions: () => opts.redactions! } : {}),
      stashViewRestore: () => {},
      lazyWorkbookRef: {
        current: {
          editJournal: journal,
          recalc: {
            timer: null,
            generation: 0,
            failed: false,
            formulaCells: new Map(),
            overlay: new Map(),
          },
          flags: { preloadComplete: opts.preloadComplete },
          showFormulaSheets: new Set<string>(),
          file: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            needsSaveAs: false,
            restoredFromRecovery: false,
            csvPath: `/tmp/streamed-${serial}.csv`,
          },
        },
      } as never,
      setMessage: (message: string) => messages.push(message),
      openLazyWorkbook: () => {},
    },
  }
}

describe('handleSave on a streamed CSV session', () => {
  it('asks the format question and routes the xlsx choice to Save As', async () => {
    confirmCsvSave.mockResolvedValue('xlsx')
    const { ctx } = csvCtx({ preloadComplete: false })
    await handleSave(ctx, 'save')
    expect(confirmCsvSave).toHaveBeenCalledTimes(1)
    expect(saveWorkbookEdits).toHaveBeenCalledTimes(1)
    const payload = saveWorkbookEdits.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.mode).toBe('save-as')
  })

  it('keeps CSV unavailable while streaming, without remembering the choice', async () => {
    confirmCsvSave.mockResolvedValue('csv')
    const { ctx, messages } = csvCtx({ preloadComplete: false })
    await handleSave(ctx, 'save')
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    expect(messages.length).toBe(1)
    // Not remembered: the next Save must offer the choice (and its escape
    // hatch) again instead of silently repeating the message.
    await handleSave(ctx, 'save')
    expect(confirmCsvSave).toHaveBeenCalledTimes(2)
  })

  it('cancel aborts without saving', async () => {
    confirmCsvSave.mockResolvedValue('cancel')
    const { ctx, messages } = csvCtx({ preloadComplete: false })
    await handleSave(ctx, 'save')
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    expect(messages.length).toBe(1)
  })

  it('remembers the CSV choice once the workbook is fully loaded', async () => {
    confirmCsvSave.mockResolvedValue('csv')
    const { ctx } = csvCtx({ preloadComplete: true })
    await handleSave(ctx, 'save')
    await handleSave(ctx, 'save')
    expect(confirmCsvSave).toHaveBeenCalledTimes(1)
  })
})

describe('handleSave on a CSV session whose sheet holds a cell hidden from the AI', () => {
  const HIDDEN_A1 = buildRedactionIndex(
    [
      {
        sheetName: 'Sheet1',
        marks: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, label: 'client phone' }],
      },
    ],
    [{ id: 'sheet-1', name: 'Sheet1' }],
  )

  it('writes no CSV, and offers .xlsx through Save As', async () => {
    confirmCsvSave.mockResolvedValue('csv')
    refuseWithheldCsv.mockResolvedValue('xlsx')
    const { ctx } = csvCtx({ preloadComplete: true, redactions: HIDDEN_A1 })
    await handleSave(ctx, 'save')
    expect(refuseWithheldCsv).toHaveBeenCalledTimes(1)
    // the one write is the Save As that follows, never a CSV
    expect(saveWorkbookEdits).toHaveBeenCalledTimes(1)
    const payload = saveWorkbookEdits.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.mode).toBe('save-as')
    expect(payload.csvContent).toBeUndefined()
  })

  it('writes nothing when the person cancels', async () => {
    confirmCsvSave.mockResolvedValue('csv')
    refuseWithheldCsv.mockResolvedValue('cancel')
    const { ctx, messages } = csvCtx({ preloadComplete: true, redactions: HIDDEN_A1 })
    await handleSave(ctx, 'save')
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })
})
