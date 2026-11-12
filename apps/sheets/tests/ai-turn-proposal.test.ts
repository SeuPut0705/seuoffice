import {
  AgentLoop,
  type AgentMessage,
  type AgentStreamCallbacks,
  type AgentTransport,
  type ToolExecution,
} from '@seuoffice/agent-core'
import { InMemoryWorkbookAdapter } from '@seuoffice/xlsx-gateway/domain/in-memory-workbook'
import type { ChangePlan, WorkbookSnapshot } from '@seuoffice/xlsx-gateway/domain/workbook.types'
import { describe, expect, it } from 'vitest'

import { createWorkbookSkill } from '../src/renderer/ai/workbook-skill'
import type { SheetsSkillDeps } from '../src/renderer/ai/tools'
import {
  accept,
  holdRun,
  planUndoCells,
  proposalPreview,
  rebasePlan,
  reject,
  RunRecord,
  type AppliedOutcome,
  type ProposalBackend,
  type TurnProposal,
} from '../src/renderer/ai/turn-proposal'

const SNAPSHOT: WorkbookSnapshot = {
  revision: 0,
  sheets: [
    {
      id: 'sheet-1',
      name: 'Sheet1',
      cells: { A1: { value: 10 }, B1: { value: 20 }, A2: { value: 'keep' } },
    },
  ],
}

/** transport scripted turn by turn (the pattern of packages/agent-core/tests/loop.test.ts) */
function scriptedTransport(script: Array<(cb: AgentStreamCallbacks) => void>): AgentTransport {
  let turn = 0
  return {
    stream(_request: { system: string; messages: AgentMessage[]; tools: unknown[] }, cb) {
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
}

function proposeCall(id: string, summary: string, operations: unknown[]) {
  return (cb: AgentStreamCallbacks) => {
    cb.onToolCall({ id, name: 'propose_operations', input: { summary, operations } })
    cb.onDone()
  }
}

/** The document without its history counter: undo moves the revision forward, not back. */
function documentOf(adapter: InMemoryWorkbookAdapter): unknown {
  return structuredClone(adapter.getSnapshot().sheets)
}

/**
 * A demo workbook the way the app drives it: the adapter applies and undoes whole plans,
 * and a plan the run's revert could not reach is refused before it applies (App.autoApplySafePlan).
 */
function demoWorkbook(
  limits: Partial<Pick<ProposalBackend, 'undoCapacity' | 'undoCellBudget'>> = {},
) {
  const adapter = new InMemoryWorkbookAdapter(SNAPSHOT)
  const record = new RunRecord()
  let transactions = 0

  const backend: ProposalBackend = {
    undoCapacity: Number.POSITIVE_INFINITY,
    undoCellBudget: Number.POSITIVE_INFINITY,
    unundoableOps: new Set<string>(),
    ...limits,
    undo: async (steps) => {
      for (let step = 0; step < steps; step += 1) adapter.undo()
    },
    watch: () => {
      const revision = adapter.getSnapshot().revision
      return () => adapter.getSnapshot().revision !== revision
    },
    apply: async (plan) => {
      adapter.apply(rebasePlan(plan, adapter.getSnapshot().revision))
      return { ok: true, undoSteps: 1 }
    },
  }

  const deps: SheetsSkillDeps = {
    getActiveSheetInfo: () => {
      const snapshot = adapter.getSnapshot()
      return {
        mode: 'demo',
        sheetId: 'sheet-1',
        sheetName: snapshot.sheets[0]!.name,
        revision: snapshot.revision,
        knownAddresses: Object.keys(snapshot.sheets[0]!.cells),
        sheets: snapshot.sheets.map((sheet) => ({ id: sheet.id, name: sheet.name })),
      }
    },
    readCells: (addresses, sheetId = 'sheet-1') => {
      const sheet = adapter.getSnapshot().sheets.find((candidate) => candidate.id === sheetId)
      return Object.fromEntries(
        addresses.map((address) => {
          const cell = sheet?.cells[address]
          return [address, { value: cell?.value ?? null }]
        }),
      )
    },
    readFormats: () => ({}),
    readSheetFeatures: () => '',
    findCells: () => ({ matches: [], truncated: false, incompleteSheets: [] }),
    selectRange: () => ({ ok: true, sheetName: 'Sheet1' }),
    tracePrecedents: () => ({ refs: [] }),
    traceDependents: () => ({ dependents: [], truncated: false, incompleteSheets: [] }),
    proposeOperations: (operations, summary) => {
      const plan = adapter.plan({
        dslVersion: 1,
        transactionId: `agent-${(transactions += 1)}`,
        baseRevision: adapter.getSnapshot().revision,
        summary,
        operations,
      })
      const refusal = record.refusal(plan, backend)
      if (refusal !== null) {
        return { ok: true, plan, applied: Promise.resolve({ ok: false, reason: refusal }) }
      }
      adapter.apply(plan)
      const applied: Promise<AppliedOutcome> = Promise.resolve({ ok: true, undoSteps: 1 })
      record.track(plan, applied)
      return { ok: true, plan, applied }
    },
  }

  /** What each tool call of the runs answered, in order. */
  const toolResults: ToolExecution[] = []

  /** One AI run through the real AgentLoop and the real workbook skill. */
  async function runAi(script: Array<(cb: AgentStreamCallbacks) => void>): Promise<void> {
    // the project's TS lib predates Promise.withResolvers
    await new Promise<void>((resolve, reject) => {
      const loop = new AgentLoop({
        transport: scriptedTransport(script),
        skill: createWorkbookSkill(deps),
        events: {
          onToolExecuted: ({ execution }) => toolResults.push(execution),
          onDone: () => resolve(),
          onError: (e) => reject(new Error(e)),
        },
      })
      loop.run('Total the row and rename the sheet')
    })
  }

  return { adapter, record, backend, runAi, deps, toolResults }
}

/** A run of three tool calls: each plan is built on top of the earlier ones' edits. */
const TWO_PLAN_RUN = [
  proposeCall('t1', 'Fill the totals', [
    { op: 'set_cell', sheetId: 'sheet-1', address: 'C1', value: 30 },
    { op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 11 },
    { op: 'format_range', sheetId: 'sheet-1', range: 'A1:C1', format: { bold: true } },
  ]),
  proposeCall('t2', 'Adjust the total', [
    { op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 12 },
    { op: 'clear_cell', sheetId: 'sheet-1', address: 'A2' },
  ]),
  proposeCall('t3', 'Rename and add a sheet', [
    { op: 'rename_sheet', sheetId: 'sheet-1', name: 'Data' },
    { op: 'add_sheet', name: 'Summary' },
  ]),
  (cb: AgentStreamCallbacks) => {
    cb.onDelta('Done.')
    cb.onDone()
  },
]

describe('AI run held as a proposal', () => {
  it('takes the run back out when it ends and holds its plans in order', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    const before = documentOf(adapter)

    await runAi(TWO_PLAN_RUN)
    const liveEnd = documentOf(adapter)
    expect(liveEnd).not.toEqual(before)

    const proposal = await holdRun(backend, await record.settle())

    expect(documentOf(adapter)).toEqual(before)
    expect(proposal.kind).toBe('pending')
    if (proposal.kind !== 'pending') return
    expect(proposal.plans).toHaveLength(3)
    // the card shows one diff: the first plan's "before" to the last plan's "after"
    const diff = proposalPreview(proposal.plans)
    expect(diff.cellChanges.find((change) => change.address === 'A1')).toMatchObject({
      before: { value: 10 },
      after: { value: 12 },
    })
    expect(diff.sheetRenames).toEqual([{ sheetId: 'sheet-1', before: 'Sheet1', after: 'Data' }])
  })

  it('Accept leaves the workbook exactly as the live run left it', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    await runAi(TWO_PLAN_RUN)
    const liveEnd = documentOf(adapter)
    const proposal = await holdRun(backend, await record.settle())
    if (proposal.kind !== 'pending') throw new Error('expected a held proposal')

    const next = await accept(backend, proposal)

    expect(next.kind).toBe('none')
    expect(documentOf(adapter)).toEqual(liveEnd)
  })

  it('Reject leaves the workbook as it was before the run', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    const before = documentOf(adapter)
    await runAi(TWO_PLAN_RUN)
    const proposal = await holdRun(backend, await record.settle())

    expect(reject().kind).toBe('none')
    expect(proposal.kind).toBe('pending')
    expect(documentOf(adapter)).toEqual(before)
  })

  it('refuses to Accept after the workbook changed, and leaves it untouched', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    await runAi(TWO_PLAN_RUN)
    const proposal = await holdRun(backend, await record.settle())
    if (proposal.kind !== 'pending') throw new Error('expected a held proposal')

    // a person edits the workbook after the revert
    adapter.apply(
      adapter.plan({
        dslVersion: 1,
        transactionId: 'person-1',
        baseRevision: adapter.getSnapshot().revision,
        summary: 'person edit',
        operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'B1', value: 99 }],
      }),
    )
    const afterPersonEdit = documentOf(adapter)

    const next = await accept(backend, proposal)

    expect(next.kind).toBe('stale')
    expect(documentOf(adapter)).toEqual(afterPersonEdit)
    expect(reject().kind).toBe('none')
  })

  it('rolls back plans already applied when a later plan is refused', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    const before = documentOf(adapter)
    await runAi(TWO_PLAN_RUN)
    const proposal = await holdRun(backend, await record.settle())
    if (proposal.kind !== 'pending') throw new Error('expected a held proposal')

    let applies = 0
    const guarded: ProposalBackend = {
      ...backend,
      apply: async (plan): Promise<AppliedOutcome> =>
        (applies += 1) === 2 ? { ok: false, undoSteps: 0 } : backend.apply(plan),
    }
    const next = await accept(guarded, proposal)

    expect(applies).toBe(2)
    expect(next.kind).toBe('stale')
    expect(documentOf(adapter)).toEqual(before)
  })

  it('holds nothing for a run that changed nothing, and its failed proposals leave no trace', async () => {
    const { adapter, record, backend, runAi } = demoWorkbook()
    const before = documentOf(adapter)

    await runAi([
      proposeCall('t1', 'Bad batch', [
        { op: 'set_cell', sheetId: 'sheet-9', address: 'A1', value: 1 },
      ]),
      (cb) => {
        cb.onDelta('I could not do that.')
        cb.onDone()
      },
    ])
    const proposal: TurnProposal = await holdRun(backend, await record.settle())

    expect(proposal.kind).toBe('none')
    expect(documentOf(adapter)).toEqual(before)
  })

  it('refuses an oversized plan before it applies, and the run still holds', async () => {
    // one cell per change here: the budget stands for the 100k cells of the real undo gate
    const { adapter, record, backend, runAi, toolResults } = demoWorkbook({ undoCellBudget: 3 })
    const before = documentOf(adapter)

    await runAi([
      proposeCall('small', 'Fill one cell', [
        { op: 'set_cell', sheetId: 'sheet-1', address: 'C1', value: 30 },
      ]),
      proposeCall('big', 'Fill many cells', [
        { op: 'set_cell', sheetId: 'sheet-1', address: 'D1', value: 1 },
        { op: 'set_cell', sheetId: 'sheet-1', address: 'D2', value: 2 },
        { op: 'set_cell', sheetId: 'sheet-1', address: 'D3', value: 3 },
        { op: 'set_cell', sheetId: 'sheet-1', address: 'D4', value: 4 },
      ]),
      (cb) => {
        cb.onDelta('Done.')
        cb.onDone()
      },
    ])

    expect(toolResults[0]?.isError).toBeFalsy()
    expect(toolResults[1]?.isError).toBe(true)
    expect(toolResults[1]?.output).toContain('the workbook is UNCHANGED')
    expect(toolResults[1]?.output).toContain('smaller changes')
    const proposal = await holdRun(backend, await record.settle())
    expect(proposal.kind === 'pending' && proposal.plans.length).toBe(1)
    expect(documentOf(adapter)).toEqual(before)
  })

  it('refuses the plan past the undo steps the app keeps, and the run still holds', async () => {
    const { adapter, record, backend, runAi, toolResults } = demoWorkbook({ undoCapacity: 2 })
    const before = documentOf(adapter)
    const cell = (id: string, address: string) =>
      proposeCall(id, `Fill ${address}`, [
        { op: 'set_cell', sheetId: 'sheet-1', address, value: 1 },
      ])

    await runAi([
      cell('a', 'C1'),
      cell('b', 'C2'),
      cell('c', 'C3'),
      (cb) => {
        cb.onDelta('Done.')
        cb.onDone()
      },
    ])

    expect(toolResults.map((result) => Boolean(result.isError))).toEqual([false, false, true])
    expect(toolResults[2]?.output).toContain('2 of the 2 undo steps')
    const proposal = await holdRun(backend, await record.settle())
    expect(proposal.kind === 'pending' && proposal.plans.length).toBe(2)
    expect(documentOf(adapter)).toEqual(before)
  })
})

describe('RunRecord', () => {
  const plan = (id: string): ChangePlan => ({
    transactionId: id,
    baseRevision: 0,
    cellChanges: [],
    sheetRenames: [],
    structuralChanges: [],
    formatChanges: [],
    warnings: [],
  })
  const backendCounting = () => {
    const undone: number[] = []
    const backend: ProposalBackend = {
      undoCapacity: 20,
      undoCellBudget: 100_000,
      unundoableOps: new Set<string>(),
      undo: async (steps) => {
        undone.push(steps)
      },
      watch: () => () => false,
      apply: async () => ({ ok: true, undoSteps: 1 }),
    }
    return { backend, undone }
  }

  it('reverts what a batch that failed midway committed, without proposing it', async () => {
    const record = new RunRecord()
    record.track(plan('whole'), Promise.resolve({ ok: true, undoSteps: 1 }))
    record.track(
      plan('partial'),
      Promise.resolve({ ok: false, partiallyApplied: true, undoSteps: 1 } as AppliedOutcome),
    )
    const { backend, undone } = backendCounting()

    const proposal = await holdRun(backend, await record.settle())

    expect(undone).toEqual([2])
    expect(proposal.kind === 'pending' && proposal.plans.map((p) => p.transactionId)).toEqual([
      'whole',
    ])
  })

  it('refuses a plan the undo history could not record, before it applies', () => {
    const { backend } = backendCounting()
    const wide: ChangePlan = {
      ...plan('wide'),
      structuralChanges: [
        { op: { op: 'clear_range', sheetId: 'sheet-1', range: 'A1:Z1000' }, label: 'clear' },
      ],
    }

    const refusal = new RunRecord().refusal(wide, { ...backend, undoCellBudget: 100 })

    expect(refusal).toContain('26000 cells')
    expect(refusal).toContain('smaller changes')
  })

  it('counts the cells of every kind of change a plan carries', () => {
    expect(
      planUndoCells({
        ...plan('mixed'),
        cellChanges: [
          { sheetId: 's', address: 'A1', before: { value: null }, after: { value: 1 } },
          { sheetId: 's', address: 'A2', before: { value: null }, after: { value: 1 } },
        ],
        formatChanges: [{ sheetId: 's', range: 'A1:B5', format: { bold: true }, label: 'bold' }],
        structuralChanges: [
          {
            op: {
              op: 'copy_range',
              sheetId: 's',
              source: 'A1:B2',
              target: 'D1',
            },
            label: 'copy',
          },
        ],
      }),
    ).toBe(2 + 10 + 4)
  })

  it('refuses a plan the app cannot record in its undo at all', () => {
    const { backend } = backendCounting()
    const protect: ChangePlan = {
      ...plan('protect'),
      structuralChanges: [
        { op: { op: 'protect_sheet', sheetId: 'sheet-1', protected: true }, label: 'protect' },
      ],
    }

    const refusal = new RunRecord().refusal(protect, {
      ...backend,
      unundoableOps: new Set(['protect_sheet']),
    })

    expect(refusal).toContain('protect_sheet')
  })

  it('refuses the plan that would push the run past the undo steps the app keeps', () => {
    const record = new RunRecord()
    for (let index = 0; index < 20; index += 1) {
      record.track(plan(`p${index}`), Promise.resolve({ ok: true, undoSteps: 1 }))
    }
    const { backend } = backendCounting()

    expect(record.refusal(plan('one-too-many'), backend)).toContain('20 of the 20 undo steps')
    expect(new RunRecord().refusal(plan('first'), backend)).toBeNull()
  })

  it('throws instead of reverting part of a run that outgrew the undo it was checked against', async () => {
    const record = new RunRecord()
    for (let index = 0; index < 21; index += 1) {
      record.track(plan(`p${index}`), Promise.resolve({ ok: true, undoSteps: 1 }))
    }
    const { backend, undone } = backendCounting()

    await expect(holdRun(backend, await record.settle())).rejects.toThrow('21 undo steps')
    expect(undone).toEqual([])
  })

  it('holds a run that exactly fills the undo stack', async () => {
    const record = new RunRecord()
    for (let index = 0; index < 20; index += 1) {
      record.track(plan(`p${index}`), Promise.resolve({ ok: true, undoSteps: 1 }))
    }
    const { backend, undone } = backendCounting()

    expect((await holdRun(backend, await record.settle())).kind).toBe('pending')
    expect(undone).toEqual([20])
  })

  it('waits for an apply still in flight when the run ends', async () => {
    const record = new RunRecord()
    let finish: (outcome: AppliedOutcome) => void = () => undefined
    record.track(
      plan('slow'),
      new Promise<AppliedOutcome>((resolve) => {
        finish = resolve
      }),
    )
    const settled = record.settle()
    finish({ ok: true, undoSteps: 1 })

    expect((await settled).plans.map((p) => p.transactionId)).toEqual(['slow'])
  })
})
