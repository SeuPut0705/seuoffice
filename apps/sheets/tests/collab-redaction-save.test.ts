import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SheetRedactionState } from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import {
  createEditJournal,
  recordStructuralOp,
  recordSheetRename,
  type StructuralJournalOp,
} from '../src/renderer/edit-journal'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import { editRefusal, setEditRefusalRule } from '../src/renderer/sheet-protection'
import { buildRedactionIndex, NO_REDACTIONS } from '../src/renderer/ai/redact'
import { redactIntentFor } from '../src/renderer/redact-actions'
import { joinSheetsCollab, type SheetsRendererHandles } from '../src/web/collab-join'
import JSZip from 'jszip'
import {
  applyCellEditsToXlsx,
  readBasicWorkbook,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-gateway'
import {
  REDACTION_PART_PATH,
  serializeRedactionPart,
  parseRedactionPart,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { loadedRedactions } from '../src/renderer/ai/redact-load'
import { readCells, type WorkbookReadContext } from '../src/renderer/ai/workbook-readers'
import { workbookSaveRequestSchema } from '../src/shared/desktop-api'
import { resolveWorkbookSave } from '../src/main/workbook-save-resolve'
import { buildEditFixture } from './fixture-builder'

const host = vi.hoisted(() => ({ options: undefined as unknown, adapter: undefined as unknown }))
vi.mock('@seuoffice/web-platform', () => ({
  webLanguage: () => 'en',
  joinPageCollab: (options: unknown) => {
    host.options = options
    return Promise.resolve(null)
  },
}))
vi.mock('../src/web/collab-adapter', () => ({
  sheetsCollabAdapter: (adapter: unknown) => {
    host.adapter = adapter
    return {}
  },
}))
const workbookTemplateBytes = vi.fn().mockResolvedValue({ ok: false })
const MARKS: readonly SheetRedactionState[] = [
  {
    sheetName: 'Data',
    marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'private' }],
  },
]
const SHEETS = [{ id: 's1', name: 'Data' }]
const selection = {
  sheetId: 's1',
  startRow: 1,
  endRow: 1,
  startColumn: 1,
  endColumn: 1,
  isSingleCell: true,
}

interface JoinOptions {
  format: { schema: number }
  adapter(handles: SheetsRendererHandles): unknown
}
interface AdapterHost {
  produceFile(): Promise<unknown>
}

async function attached(
  ops: readonly StructuralJournalOp[] = [{ kind: 'insert-rows', index: 0, count: 1 }],
  renamed?: string,
) {
  workbookTemplateBytes.mockClear()
  vi.stubGlobal('window', { desktopApi: { workbookTemplateBytes } })
  await joinSheetsCollab('private.xlsx', new Uint8Array())
  const options = host.options as JoinOptions
  const journal = createEditJournal()
  for (const op of ops) recordStructuralOp(journal, 's1', op)
  if (renamed) recordSheetRename(journal, 's1', renamed, 'Data')
  const state = {
    formulaMode: true,
    flags: { preloadComplete: true },
    editJournal: journal,
    file: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sheets: [{ id: 's1', name: 'Data' }],
    },
  } as unknown as LazyWorkbookState
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => ({
        getId: () => 'wb',
        getActiveSheet: () => null,
        getSheets: () => [{ getSheetId: () => 's1' }],
      }),
    },
  } as unknown as UniverRuntime
  options.adapter({ runtime, state, redactionStates: MARKS })
  const adapter = host.adapter as AdapterHost
  return { adapter, options }
}

afterEach(() => {
  setEditRefusalRule(null)
  vi.unstubAllGlobals()
})

describe('co-editing a workbook with privacy marks', () => {
  it('carries the base marks alongside the structural journal on every export', async () => {
    const { adapter } = await attached()
    // The host write is cancelled after capture: the externally visible save
    // request must carry marks and row edits together, just as desktop does.
    await expect(adapter.produceFile()).rejects.toThrow('could not be written')
    const request = workbookTemplateBytes.mock.calls[0]![0]
    expect(request.redactionStates).toEqual(MARKS)
    expect(request.structuralOps).toEqual([
      { sheetId: 's1', kind: 'insert-rows', index: 0, count: 1 },
    ])
    // A co-edited save keeps the epoch's base file and journal: do not move the
    // stored marks once per save and then move them again on the next one.
    await expect(adapter.produceFile()).rejects.toThrow('could not be written')
    expect(workbookTemplateBytes.mock.calls[1]![0]).toEqual(request)
  })

  it('refuses a hide request instead of sharing a tint without its privacy mark', async () => {
    await attached()
    expect(editRefusal('direct:redact')).not.toBeNull()
    expect(redactIntentFor(selection, NO_REDACTIONS, () => 'Data')).toEqual({ kind: 'ignore' })
  })

  it('refuses unhide too, leaving the base mark for every peer', async () => {
    await attached()
    expect(redactIntentFor(selection, buildRedactionIndex(MARKS, SHEETS), () => 'Data')).toEqual({
      kind: 'ignore',
    })
    setEditRefusalRule(null)
    expect(redactIntentFor(selection, buildRedactionIndex(MARKS, SHEETS), () => 'Data').kind).toBe(
      'clear',
    )
    expect(redactIntentFor(selection, NO_REDACTIONS, () => 'Data').kind).toBe('ask')
  })

  it('does not join peers using the earlier formula-error fingerprint', async () => {
    const { options } = await attached()
    expect(options.format.schema).toBe(3)
  })
})

describe('the co-edited file reopened by an AI reader', () => {
  it.each([
    {
      title: 'insert row',
      ops: [{ kind: 'insert-rows' as const, index: 0, count: 1 }],
      address: 'B3',
    },
    {
      title: 'insert column',
      ops: [{ kind: 'insert-cols' as const, index: 0, count: 1 }],
      address: 'C2',
    },
    { title: 'rename sheet', ops: [], renamed: 'Renamed', address: 'B2' },
    {
      title: 'row, column and rename together',
      ops: [
        { kind: 'insert-rows' as const, index: 0, count: 1 },
        { kind: 'insert-cols' as const, index: 0, count: 1 },
      ],
      renamed: 'Renamed',
      address: 'C3',
    },
  ])('keeps the value hidden after $title', async ({ ops, renamed, address }) => {
    const secret = '13800138000'
    const base = await JSZip.loadAsync(await buildEditFixture())
    base.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>${secret}</t></is></c></row></sheetData></worksheet>`,
    )
    // The input really has a mark: passing null preserves this stale B2 mark
    // instead of shifting it with the value, which is the original disclosure.
    base.file(REDACTION_PART_PATH, serializeRedactionPart(MARKS))
    const source = await base.generateAsync({ type: 'nodebuffer' })
    const { adapter } = await attached(ops, renamed)
    workbookTemplateBytes.mockImplementationOnce(async (raw) => {
      const request = workbookSaveRequestSchema.parse(raw)
      const save = resolveWorkbookSave(new Map([['s1', 'Data']]), request)
      // Same package planner used by the web worker and the desktop streaming
      // save; the buffer wrapper avoids needing a WASM worker in this test.
      const saved = await applyCellEditsToXlsx(
        source,
        save.edits,
        save.structuralOps,
        save.chartEdits,
        save.sheetPlan,
        save.filterStates,
        save.hyperlinkEdits,
        save.cfStates,
        save.dvStates,
        save.sheetProtections,
        save.definedNamesState,
        save.pageSetupStates,
        save.noteStates,
        save.formulaValues,
        save.redactionStates,
      )
      return { ok: true, bytes: saved.buffer }
    })
    const produced = (await adapter.produceFile()) as { bytes: Uint8Array }
    const bytes = Buffer.from(produced.bytes)
    const reopened = await readBasicWorkbook(bytes)
    const sheet = reopened.snapshot.sheets[0]!
    expect(sheet.name).toBe(renamed ?? 'Data')
    expect(sheet.cells[address]?.value).toBe(secret)
    const archive = await JSZip.loadAsync(bytes)
    const marks = parseRedactionPart(await archive.file(REDACTION_PART_PATH)!.async('string'))
    const ctx: WorkbookReadContext = {
      univerRef: { current: null },
      lazyWorkbookRef: { current: null },
      adapterRef: { current: { getSnapshot: () => reopened.snapshot } } as never,
      redactionLoadRef: { current: loadedRedactions(buildRedactionIndex(marks, [sheet])) },
    }
    expect(readCells(ctx, [address], sheet.id)[address]).toEqual({ value: '{{private}}' })
    expect(JSON.stringify(readCells(ctx, [address], sheet.id))).not.toContain(secret)
  })
})
