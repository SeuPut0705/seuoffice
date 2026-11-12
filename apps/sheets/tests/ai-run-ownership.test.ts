// @vitest-environment jsdom
import { InMemoryWorkbookAdapter } from '@seuoffice/xlsx-gateway/domain/in-memory-workbook'
import type { AppliedOutcome, TurnProposal } from '../src/renderer/ai/turn-proposal'
import type { ChangePlan, WorkbookSnapshot } from '@seuoffice/xlsx-gateway/domain/workbook.types'
import { afterEach, describe, expect, it } from 'vitest'

import {
  captureBlankBaseline,
  createProposalBackend,
  type BlankBaseline,
} from '../src/renderer/ai/proposal-backend'
import {
  aiRunSaveRefusal,
  beginAgentWrite,
  installAiRunLockGuard,
  lockForAiRun,
  setProposalPending,
  unlockAfterAiRun,
  type AiRunLockHold,
} from '../src/renderer/ai/run-lock'
import { AiRunSession } from '../src/renderer/ai/run-session'
import { holdRun, reject } from '../src/renderer/ai/turn-proposal'
import { createSaveGate, guardedSave } from '../src/renderer/save-scheduler'
import { aiRunLock, type LazyWorkbookState, type UniverRuntime } from '../src/renderer/univer-state'
import { loadSnapshotIntoUniver } from '../src/renderer/univer-sync'
import { bootEmptyUniver, bootWorkbook, cellOf, setCell } from './univer-workbook'

const holds: AiRunLockHold[] = []
const lock = (): AiRunLockHold => {
  const hold = lockForAiRun()
  holds.push(hold)
  return hold
}

afterEach(() => {
  for (const hold of holds.splice(0)) unlockAfterAiRun(hold)
  aiRunLock.stranded = false
  aiRunLock.proposalPending = false
  aiRunLock.agentWriting = 0
})

const planOf = (id: string): ChangePlan => ({
  transactionId: id,
  baseRevision: 0,
  cellChanges: [],
  sheetRenames: [],
  structuralChanges: [],
  formatChanges: [],
  warnings: [],
})

/** The app's backend over a real Univer file workbook, as App wires it. */
function fileBackend(runtime: UniverRuntime) {
  return createProposalBackend({
    lazyWorkbookRef: { current: {} as LazyWorkbookState },
    univerRef: { current: runtime },
    adapterRef: { current: new InMemoryWorkbookAdapter({ revision: 0, sheets: [] }) },
    lazyPreviewRef: { current: null },
    blankBaselineRef: { current: null },
    autoApplySafePlan: async () => ({ ok: false, undoSteps: 0 }),
    afterBlankUndo: () => undefined,
  })
}

describe('the lock an AI run takes', () => {
  it("is not released by an abandoned run's late unlock while a newer run holds it", () => {
    const abandoned = lock() // run A, then "new chat": its revert is still in flight
    const newer = lock() // run B starts
    unlockAfterAiRun(abandoned) // A's revert finishes
    expect(aiRunLock.active).toBe(true)
    unlockAfterAiRun(newer)
    expect(aiRunLock.active).toBe(false)
  })
})

describe('"new chat" while a run is in flight, then a new run', () => {
  /** A plan apply the test settles by hand: it keeps the abandoned run's revert waiting. */
  const deferred = () => {
    let resolve!: (outcome: AppliedOutcome) => void
    const promise = new Promise<AppliedOutcome>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  /** Lets every promise step that can run without a hand-settled promise run. */
  const flushMicrotasks = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  }
  const sessionOver = (runtime: UniverRuntime) => {
    const backend = fileBackend(runtime)
    return new AiRunSession(async (record) => holdRun(backend, await record.settle()))
  }

  it("starts the new run only after the abandoned run's revert, and keeps the new run's lock", async () => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)
    const session = sessionOver(runtime)

    const first = session.begin()
    expect(await session.acquire(first)).toBe(true)
    const endWrite = beginAgentWrite()
    setCell(runtime, 'A1', 11) // the first run's edit
    endWrite()
    const applying = deferred()
    first.record.track(planOf('t1'), applying.promise)

    // "new chat": the run is abandoned and its revert waits for the plan still applying
    const reverting = session.end()
    // the person sends again right away
    const second = session.begin()
    let secondLocked = false
    const acquiring = session.acquire(second).then((acquired) => {
      secondLocked = acquired
      return acquired
    })
    await flushMicrotasks()
    expect(secondLocked).toBe(false)
    expect(cellOf(runtime, 'A1')).toBe(11)

    applying.resolve({ ok: true, undoSteps: 1 })
    await reverting
    expect(await acquiring).toBe(true)

    expect(cellOf(runtime, 'A1')).toBe(10) // reverted before the new run took over
    expect(aiRunLock.active).toBe(true) // the new run's own claim survived the late unlock

    await session.end()
    expect(aiRunLock.active).toBe(false)
  })

  it('does not let a run abandoned before it took the lock release the earlier run claim', async () => {
    const runtime = bootWorkbook()
    const session = sessionOver(runtime)

    const first = session.begin()
    await session.acquire(first)
    const applying = deferred()
    first.record.track(planOf('t1'), applying.promise)

    const firstReverting = session.end()
    session.begin() // a second send that never gets to run
    const secondReverting = session.end() // abandoned before it took the lock
    await flushMicrotasks()
    expect(aiRunLock.active).toBe(true)

    applying.resolve({ ok: false, undoSteps: 0 })
    await Promise.all([firstReverting, secondReverting])
    expect(aiRunLock.active).toBe(false)
  })

  it('refuses to start a run that a new chat abandoned while it was starting', async () => {
    const runtime = bootWorkbook()
    const session = sessionOver(runtime)

    const run = session.begin()
    await session.end() // abandoned before the lock
    expect(await session.acquire(run)).toBe(false)
    expect(aiRunLock.active).toBe(false)
  })

  it('leaves the workbook stranded and the lock released when the revert fails', async () => {
    const session = new AiRunSession(() => Promise.reject(new Error('undo failed')))
    const run = session.begin()
    await session.acquire(run)

    await expect(session.end()).rejects.toThrow('undo failed')
    expect(aiRunLock.active).toBe(false)
    expect(aiRunLock.stranded).toBe(true)
  })
})

describe('saving while an AI proposal is pending', () => {
  const heldProposal = async (): Promise<TurnProposal> => {
    const runtime = bootWorkbook()
    installAiRunLockGuard(runtime, () => undefined)
    const hold = lock()
    const endWrite = beginAgentWrite()
    setCell(runtime, 'A1', 11)
    endWrite()
    const held = await holdRun(fileBackend(runtime), { plans: [planOf('t1')], undoSteps: 1 })
    unlockAfterAiRun(hold)
    return held
  }
  const trySave = async (mode: Parameters<typeof aiRunSaveRefusal>[0]) => {
    type Outcome = { ok: boolean; error?: string }
    const written: string[] = []
    const outcome = await guardedSave(
      createSaveGate(),
      (): Outcome | null => {
        const reason = aiRunSaveRefusal(mode)
        return reason === null ? null : { ok: false, error: reason }
      },
      async (): Promise<Outcome> => {
        written.push('saved')
        return { ok: true }
      },
    )
    return { written, outcome }
  }

  it('is refused with a notice to accept or reject first, because the reopen would drop the proposal', async () => {
    const held = await heldProposal()
    expect(held.kind).toBe('pending')
    setProposalPending(held)

    for (const mode of ['save', 'save-as'] as const) {
      const { written, outcome } = await trySave(mode)
      expect(written).toEqual([])
      expect(outcome.ok).toBe(false)
      expect(aiRunSaveRefusal(mode)).toMatch(/accept or reject/i)
    }
  })

  it('still lets a copy (recovery, template) be written, and saves again after Reject', async () => {
    const held = await heldProposal()
    setProposalPending(held)
    expect((await trySave('recovery')).written).toEqual(['saved'])
    expect((await trySave('template')).written).toEqual(['saved'])

    setProposalPending(reject())
    expect((await trySave('save')).written).toEqual(['saved'])
  })
})

describe("a blank workbook's run is reverted without losing what the person typed into the grid", () => {
  const SNAPSHOT: WorkbookSnapshot = {
    revision: 0,
    sheets: [{ id: 'sheet-1', name: 'Sheet1', cells: { A1: { value: 10 } } }],
  }

  it('puts the grid back as the person left it, not as the adapter remembers it', async () => {
    const runtime = bootEmptyUniver()
    const adapter = new InMemoryWorkbookAdapter(SNAPSHOT)
    loadSnapshotIntoUniver(runtime, adapter.getSnapshot(), 'new-workbook', 'Untitled')
    installAiRunLockGuard(runtime, () => undefined)
    setCell(runtime, 'C3', 7) // typed into the grid: the adapter never sees it

    const blankBaselineRef: { current: BlankBaseline | null } = { current: null }
    const backend = createProposalBackend({
      lazyWorkbookRef: { current: null },
      univerRef: { current: runtime },
      adapterRef: { current: adapter },
      lazyPreviewRef: { current: null },
      blankBaselineRef,
      autoApplySafePlan: async () => ({ ok: false, undoSteps: 0 }),
      afterBlankUndo: () => undefined,
    })

    // the run: App captures the baseline when it takes the lock, then rebuilds the grid
    // from the adapter after a structural plan
    const hold = lock()
    blankBaselineRef.current = captureBlankBaseline(runtime)
    const plan = adapter.plan({
      dslVersion: 1,
      transactionId: 'run-1',
      baseRevision: adapter.getSnapshot().revision,
      summary: 'set A1',
      operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 99 }],
    })
    adapter.apply(plan)
    const endWrite = beginAgentWrite()
    loadSnapshotIntoUniver(runtime, adapter.getSnapshot(), 'new-workbook', 'Untitled')
    endWrite()
    expect(cellOf(runtime, 'A1')).toBe(99)

    const held = await holdRun(backend, { plans: [plan], undoSteps: 1 })
    unlockAfterAiRun(hold)

    expect(held.kind).toBe('pending')
    expect(cellOf(runtime, 'A1')).toBe(10)
    expect(cellOf(runtime, 'C3')).toBe(7)
  })
})
