// @vitest-environment jsdom
import { IUniverInstanceService, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { afterEach, describe, expect, it } from 'vitest'

import {
  aiRunSaveRefusal,
  beginAgentWrite,
  installAiRunLockGuard,
  lockForAiRun,
  personEditVetoed,
  unlockAfterAiRun,
} from '../src/renderer/ai/run-lock'
import { createSaveGate, guardedSave } from '../src/renderer/save-scheduler'
import { aiRunLock, type UniverRuntime } from '../src/renderer/univer-state'

afterEach(() => {
  unlockAfterAiRun()
  aiRunLock.stranded = false
  aiRunLock.agentWriting = false
})

/** The save path the app owns: one gate, the refusal of the lock, and a write that sees the document. */
function savePath(document: { cells: Record<string, number> }) {
  const gate = createSaveGate()
  const written: string[] = []
  type Outcome = { ok: boolean; error?: string }
  const refusal = (): Outcome | null => {
    const reason = aiRunSaveRefusal()
    return reason === null ? null : { ok: false, error: reason }
  }
  const save = (
    write: () => Promise<Outcome> = async () => {
      written.push(JSON.stringify(document.cells))
      return { ok: true }
    },
  ) => guardedSave(gate, refusal, write)
  return { save, written, gate }
}

describe('a save while an AI run is in flight', () => {
  it('writes nothing, whichever save path asks', async () => {
    const document = { cells: { A1: 10 } }
    const { save, written } = savePath(document)

    lockForAiRun()
    document.cells.A1 = 99 // the run's live edit
    const refused = await Promise.all([save(), save(), save()]) // save, autosave tick, recovery copy

    expect(refused.map((outcome) => outcome.ok)).toEqual([false, false, false])
    expect(refused[0]?.error).toMatch(/while the AI is working/i)
    expect(written).toEqual([])
  })

  it('writes the pre-run document once the run is reverted', async () => {
    const document = { cells: { A1: 10 } }
    const { save, written } = savePath(document)

    lockForAiRun()
    document.cells.A1 = 99
    expect((await save()).ok).toBe(false)
    document.cells.A1 = 10 // the revert
    unlockAfterAiRun()

    expect((await save()).ok).toBe(true)
    expect(written).toEqual([JSON.stringify({ A1: 10 })])
  })

  it('refuses a save that was queued behind another save and starts after the run began', async () => {
    const document = { cells: { A1: 10 } }
    const { save, written } = savePath(document)
    let finishFirst: () => void = () => undefined
    const first = save(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ ok: true })
        }),
    )

    await new Promise((resolve) => setTimeout(resolve, 0)) // the first save is under way
    const queued = save()
    lockForAiRun()
    document.cells.A1 = 99
    finishFirst()

    expect((await first).ok).toBe(true)
    expect((await queued).ok).toBe(false)
    expect(written).toEqual([])
  })

  it('stays refused while edits of a run could not be taken back out', async () => {
    const { save, written } = savePath({ cells: { A1: 10 } })

    lockForAiRun()
    aiRunLock.stranded = true
    unlockAfterAiRun()

    const outcome = await save()
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/could not be taken back/i)
    expect(written).toEqual([])
  })
})

function bootWorkbook(): UniverRuntime {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  univer.registerPlugin(UniverSheetsPlugin)
  const univerAPI = FUniver.newAPI(univer)
  univerAPI.createWorkbook({
    id: 'wb',
    sheetOrder: ['sheet-1'],
    sheets: {
      'sheet-1': {
        id: 'sheet-1',
        name: 'Sheet1',
        cellData: { 0: { 0: { v: 10 } }, 1: { 0: { v: 20 } } },
      },
    },
  })
  // undo works on the focused unit; createWorkbook does not focus what it created
  univer.__getInjector().get(IUniverInstanceService).focusUnit('wb')
  return { univer, univerAPI } as unknown as UniverRuntime
}

const cellOf = (runtime: UniverRuntime, address: string): unknown =>
  runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(address).getValue()

const setCell = (runtime: UniverRuntime, address: string, value: number): void => {
  runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(address).setValue(value)
}

describe('the person editing the workbook while an AI run is in flight', () => {
  it('is blocked, leaves the workbook as the run has it, and Reject returns the pre-run document', async () => {
    const runtime = bootWorkbook()
    const notices: string[] = []
    installAiRunLockGuard(runtime, (message) => notices.push(message))
    setCell(runtime, 'A2', 5) // the person's own edit before the run
    const before = [cellOf(runtime, 'A1'), cellOf(runtime, 'A2')]
    expect(before).toEqual([10, 5])

    lockForAiRun()
    // the run writes through its own path
    const endAgentWrite = beginAgentWrite()
    setCell(runtime, 'A1', 11)
    endAgentWrite()
    expect(cellOf(runtime, 'A1')).toBe(11)

    // the person tries to edit and to undo while the run is in flight
    setCell(runtime, 'A2', 99)
    setCell(runtime, 'B1', 7)
    await runtime.univerAPI.undo()
    expect([cellOf(runtime, 'A1'), cellOf(runtime, 'A2'), cellOf(runtime, 'B1')]).toEqual([
      11,
      5,
      null,
    ])
    expect(notices.length).toBeGreaterThan(0)
    expect(notices[0]).toMatch(/AI is working/)

    // the run ends: its own revert is the only undo, and the person's earlier edit stays
    const endRevert = beginAgentWrite()
    await runtime.univerAPI.undo()
    endRevert()
    unlockAfterAiRun()

    expect([cellOf(runtime, 'A1'), cellOf(runtime, 'A2')]).toEqual(before)
  })

  it('edits again once the run is over', () => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)

    lockForAiRun()
    unlockAfterAiRun()
    setCell(runtime, 'A2', 42)

    expect(cellOf(runtime, 'A2')).toBe(42)
  })

  it('cannot open the cell editor, but a plain click on a cell is not an edit', () => {
    lockForAiRun()

    expect(
      personEditVetoed(
        { id: 'sheet.operation.set-cell-edit-visible', type: 1, params: { visible: true } },
        'wb',
      ),
    ).toBe(true)
    expect(
      personEditVetoed(
        { id: 'sheet.operation.set-cell-edit-visible', type: 1, params: { visible: false } },
        'wb',
      ),
    ).toBe(false)
    expect(
      personEditVetoed({ id: 'sheet.operation.set-selections', type: 1, params: {} }, 'wb'),
    ).toBe(false)
  })

  it('lets the formula engine restate what the run wrote', () => {
    lockForAiRun()

    expect(
      personEditVetoed(
        {
          id: 'sheet.mutation.set-range-values',
          type: 2,
          params: { unitId: 'wb' },
          options: { fromFormula: true },
        },
        'wb',
      ),
    ).toBe(false)
    expect(
      personEditVetoed(
        { id: 'formula.mutation.set-formula-data', type: 2, params: { unitId: 'wb' } },
        'wb',
      ),
    ).toBe(false)
    expect(
      personEditVetoed(
        { id: 'sheet.mutation.set-range-values', type: 2, params: { unitId: 'wb' } },
        'wb',
      ),
    ).toBe(true)
  })
})
