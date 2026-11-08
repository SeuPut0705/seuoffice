// @vitest-environment jsdom
import { IUniverInstanceService, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { afterEach, describe, expect, it } from 'vitest'

import {
  aiRunOpenRefusal,
  aiRunSaveRefusal,
  beginAgentWrite,
  installAiRunLockGuard,
  lockForAiRun,
  personEditVetoed,
  unlockAfterAiRun,
} from '../src/renderer/ai/run-lock'
import {
  accept,
  type AppliedOutcome,
  type ProposalBackend,
  type TurnProposal,
} from '../src/renderer/ai/turn-proposal'
import { createSaveGate, guardedSave } from '../src/renderer/save-scheduler'
import { aiRunLock, type UniverRuntime } from '../src/renderer/univer-state'
import { dropRedoStack } from '../src/renderer/undo-carry'

afterEach(() => {
  unlockAfterAiRun()
  aiRunLock.stranded = false
  aiRunLock.agentWriting = 0
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

  it("cannot bring a held run back with the person's Redo", async () => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)

    lockForAiRun()
    const endAgentWrite = beginAgentWrite()
    setCell(runtime, 'A1', 11) // the run's edit
    await runtime.univerAPI.undo() // the hold takes it back out
    endAgentWrite()
    dropRedoStack(runtime)
    unlockAfterAiRun()

    await runtime.univerAPI.redo() // the person's Redo while the proposal is pending
    expect(cellOf(runtime, 'A1')).toBe(10)
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

describe('the person typing at the grid while an AI apply is paused in an async step', () => {
  const grid = (runtime: UniverRuntime) => {
    const element = document.createElement('div')
    document.body.append(element)
    const seen: string[] = []
    // what the grid does with the person's input: each one edits a cell
    element.addEventListener('keydown', () => {
      seen.push('keydown')
      setCell(runtime, 'A2', 99)
    })
    element.addEventListener('paste', () => {
      seen.push('paste')
      setCell(runtime, 'B1', 7)
    })
    element.addEventListener('pointerdown', () => seen.push('pointerdown'))
    return { element, seen }
  }

  it('never reaches the grid, so Reject returns the pre-run document and the earlier edit survives', async () => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)
    setCell(runtime, 'A2', 5) // the person's edit before the run
    const before = [cellOf(runtime, 'A1'), cellOf(runtime, 'A2'), cellOf(runtime, 'B1')]
    const { element, seen } = grid(runtime)

    lockForAiRun()
    // the AI apply: it writes, then waits on an async step with its write flag up
    let resume: () => void = () => undefined
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const apply = (async () => {
      const endAgentWrite = beginAgentWrite()
      setCell(runtime, 'A1', 11)
      await paused
      setCell(runtime, 'C1', 3)
      endAgentWrite()
    })()
    await Promise.resolve()

    // the person types, pastes and clicks at the grid while the apply is paused
    for (const event of [
      new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      new Event('paste', { bubbles: true, cancelable: true }),
      new Event('pointerdown', { bubbles: true, cancelable: true }),
    ]) {
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(seen).toEqual([])
    expect(cellOf(runtime, 'A2')).toBe(5)
    expect(cellOf(runtime, 'B1')).toBeNull()

    resume()
    await apply
    expect([cellOf(runtime, 'A1'), cellOf(runtime, 'C1')]).toEqual([11, 3])

    // Reject: the run's own revert takes out exactly its two writes
    const endRevert = beginAgentWrite()
    await runtime.univerAPI.undo()
    await runtime.univerAPI.undo()
    endRevert()
    unlockAfterAiRun()

    expect([cellOf(runtime, 'A1'), cellOf(runtime, 'A2'), cellOf(runtime, 'B1')]).toEqual(before)
    element.remove()
  })

  it('leaves the AI panel and the save shortcut alone, and the grid free after the run', () => {
    const runtime = bootWorkbook()
    const { element, seen } = grid(runtime)
    const panel = document.createElement('aside')
    panel.className = 'copilot'
    const input = document.createElement('textarea')
    panel.append(input)
    document.body.append(panel)
    const panelKeys: string[] = []
    input.addEventListener('keydown', () => panelKeys.push('keydown'))

    lockForAiRun()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    const save = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    element.dispatchEvent(save)
    unlockAfterAiRun()
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))

    expect(panelKeys).toEqual(['keydown'])
    expect(save.defaultPrevented).toBe(false)
    expect(seen).toEqual(['keydown', 'keydown'])
    element.remove()
    panel.remove()
  })
})

describe('Accept of a held proposal', () => {
  it('locks the workbook through a failing re-apply and its rollback, and leaves the pre-run document', async () => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)
    setCell(runtime, 'A2', 5) // the person's edit before the run
    const before = [cellOf(runtime, 'A1'), cellOf(runtime, 'A2'), cellOf(runtime, 'C1')]

    const element = document.createElement('div')
    document.body.append(element)
    const reached: string[] = []
    // what the grid does with the person's input: each one edits a cell
    element.addEventListener('keydown', () => {
      reached.push('keydown')
      setCell(runtime, 'A2', 99)
    })
    element.addEventListener('paste', () => {
      reached.push('paste')
      setCell(runtime, 'B1', 7)
    })
    element.addEventListener('pointerdown', () => reached.push('pointerdown'))

    let failSecondApply: () => void = () => undefined
    const secondApplyPaused = new Promise<void>((resolve) => {
      failSecondApply = resolve
    })
    const plan = (id: string) =>
      ({
        transactionId: id,
        baseRevision: 0,
        cellChanges: [],
        sheetRenames: [],
        structuralChanges: [],
        formatChanges: [],
        warnings: [],
      }) as const
    let applies = 0
    const backend: ProposalBackend = {
      undoCapacity: 20,
      undoCellBudget: 100_000,
      unundoableOps: new Set<string>(),
      // the proposal's own writes pass the veto, the way the app's apply and undo do
      apply: async (): Promise<AppliedOutcome> => {
        const end = beginAgentWrite()
        try {
          applies += 1
          if (applies === 1) {
            setCell(runtime, 'A1', 11)
            return { ok: true, undoSteps: 1 }
          }
          setCell(runtime, 'C1', 3)
          await secondApplyPaused
          return { ok: false, reason: 'drifted', undoSteps: 1 }
        } finally {
          end()
        }
      },
      undo: async (steps) => {
        const end = beginAgentWrite()
        try {
          for (let step = 0; step < steps; step += 1) await runtime.univerAPI.undo()
        } finally {
          end()
        }
      },
      watch: () => () => false,
    }
    const pending: Extract<TurnProposal, { kind: 'pending' }> = {
      kind: 'pending',
      plans: [plan('p1'), plan('p2')],
      changed: () => false,
    }

    // what handleAcceptProposal does around accept()
    lockForAiRun()
    const accepting = accept(backend, pending).finally(unlockAfterAiRun)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cellOf(runtime, 'C1')).toBe(3) // the second re-apply is paused after its write

    const events = [
      new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      new Event('paste', { bubbles: true, cancelable: true }),
      new Event('pointerdown', { bubbles: true, cancelable: true }),
    ]
    for (const event of events) {
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    const written: string[] = []
    const gate = createSaveGate()
    const saved = await guardedSave(
      gate,
      () => {
        const reason = aiRunSaveRefusal()
        return reason === null ? null : { ok: false, error: reason }
      },
      async () => {
        written.push('written')
        return { ok: true }
      },
    )
    expect(reached).toEqual([])
    expect(saved.ok).toBe(false)
    expect(written).toEqual([])

    failSecondApply()
    const next = await accepting

    expect(next.kind).toBe('stale')
    expect([cellOf(runtime, 'A1'), cellOf(runtime, 'A2'), cellOf(runtime, 'C1')]).toEqual(before)
    expect(aiRunLock.active).toBe(false)
    element.remove()
  })
})

describe('opening a file over the workbook', () => {
  it('is refused with the lock notice while a run or an Accept holds the workbook, and allowed otherwise', () => {
    expect(aiRunOpenRefusal()).toBeNull()

    lockForAiRun()
    expect(aiRunOpenRefusal()).toMatch(/AI is working/)

    unlockAfterAiRun()
    expect(aiRunOpenRefusal()).toBeNull()
  })
})
