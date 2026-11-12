// @vitest-environment jsdom
/**
 * Create Table over data without a header row, when the row above is taken:
 * the editor makes room by copying the whole data block one row down. A cell
 * hidden from AI in that block would then sit one row below its mark.
 */
import { IUniverInstanceService, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { describe, expect, it, vi } from 'vitest'

import { buildRedactionIndex } from '../src/renderer/ai/redact'
import { createEditJournal } from '../src/renderer/edit-journal'
import { t } from '../src/renderer/i18n/locale'
import { installRedactMoveGuard } from '../src/renderer/redact-move-guard'
import { handleTableDesignCommand } from '../src/renderer/table-design-actions'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

vi.mock('../src/renderer/univer-sync', () => ({
  ensureLazyRangeLoaded: vi.fn(() => Promise.resolve(true)),
  loadVisibleRange: vi.fn(() => Promise.resolve()),
}))
// registering the table itself is not what is looked at here
vi.mock('../src/renderer/workbook-ops', () => ({
  applyAiTableAdd: vi.fn(),
  applySessionTableTheme: vi.fn(),
}))

const SECRET = '13800138000'

function boot(hiddenRow: number | null) {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverDocsPlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  const univerAPI = FUniver.newAPI(univer)
  univerAPI.createWorkbook({
    id: 'wb',
    name: 'tables',
    sheetOrder: ['s'],
    sheets: {
      s: {
        id: 's',
        name: 'Data',
        rowCount: 20,
        columnCount: 5,
        // row 1 is taken, the data is A2:B2, row 3 is free
        cellData: {
          0: { 0: { v: 'note' }, 1: { v: 'note' } },
          1: { 0: { v: 'Kim' }, 1: { v: SECRET } },
        },
      },
    },
  })
  univer.__getInjector().get(IUniverInstanceService).focusUnit('wb')
  const runtime = { univer, univerAPI } as unknown as UniverRuntime
  const index = buildRedactionIndex(
    hiddenRow === null
      ? []
      : [
          {
            sheetName: 'Data',
            marks: [
              {
                startRow: hiddenRow,
                endRow: hiddenRow,
                startColumn: 1,
                endColumn: 1,
                label: 'client phone',
              },
            ],
          },
        ],
    [{ id: 's', name: 'Data' }],
  )
  installRedactMoveGuard(runtime, { redactions: () => index, notify: () => {} })
  const state = {
    file: { sheets: [{ id: 's', name: 'Data', tables: [], rowCount: 20, columnCount: 5 }] },
    editJournal: createEditJournal(),
    loadedRanges: new Map(),
    frozenStripKeys: new Set(),
  } as unknown as LazyWorkbookState
  const worksheet = univerAPI.getActiveWorkbook()!.getActiveSheet()!
  const valueAt = (row: number, column: number) =>
    worksheet.getRange(row, column, 1, 1).getValue() as string | number | null
  const messages: string[] = []
  const ctx = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state },
    setMessage: (message: string) => messages.push(message),
    setPendingEdits: () => undefined,
    refreshSelection: () => undefined,
  }
  return { ctx, valueAt, messages }
}

describe('Create Table without a header row', () => {
  it('does not move the data down when it holds a hidden cell', async () => {
    const { ctx, valueAt, messages } = boot(1)
    handleTableDesignCommand(ctx, 'table-create:A2:B2:0')
    await vi.waitFor(() => expect(messages).toEqual([t('redactMoveRefused')]))
    expect(String(valueAt(1, 1))).toBe(SECRET)
    expect(valueAt(2, 1)).toBeNull()
  })

  it('still makes room when it holds none', async () => {
    const { ctx, valueAt, messages } = boot(null)
    handleTableDesignCommand(ctx, 'table-create:A2:B2:0')
    await vi.waitFor(() => expect(messages).toEqual([t('appTableCreated')]))
    expect(String(valueAt(2, 1))).toBe(SECRET)
  })
})
