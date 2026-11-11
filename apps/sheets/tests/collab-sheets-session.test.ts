/**
 * What a co-editing session needs from the app around the adapter: the whole
 * workbook stays installed, the journal that is never emptied keeps room for
 * a save, a save request is checked for what a session holds, and the edits
 * that would stay on one page are refused where they start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEditJournal,
  recordStructuralOp,
  type StructuralJournalOp,
} from '../src/renderer/edit-journal'
import { ensureLazyRangeLoaded, loadVisibleRange } from '../src/renderer/univer-sync'
import {
  type LazyWorkbookState,
  modelResidency,
  type UniverRuntime,
  type UniverWorksheet,
} from '../src/renderer/univer-state'
import { type WorkbookSaveRequest, workbookSaveRequestSchema } from '../src/shared/desktop-api'
import {
  compactStructuralOps,
  STRUCTURAL_OPS_LIMIT,
  structuralOpsRefusal,
} from '../src/web/collab-journal'
import { sharedWhileCoEditing } from '../src/web/collab-refusals'
import { coEditedSaveRequest } from '../src/web/collab-save'
import { int, seeded } from './collab/random-edit'
import { Room } from './collab/room'
import { disposeAll } from './collab/sheets-workbook'

afterEach(() => {
  disposeAll()
  modelResidency.whole = false
  vi.unstubAllGlobals()
})

type Range = { startRow: number; endRow: number; startColumn: number; endColumn: number }
const at = (startRow: number, startColumn: number, endRow: number, endColumn: number): Range => ({
  startRow,
  endRow,
  startColumn,
  endColumn,
})

describe('a co-editing page keeps the whole workbook installed', () => {
  /** A fully loaded sheet right after a row insert: the app has dropped its loaded-range entry */
  function afterRowInsert() {
    const readWorkbookRange = vi.fn().mockRejectedValue(new Error('this test has no file'))
    vi.stubGlobal('window', { desktopApi: { readWorkbookRange } })
    const journal = createEditJournal()
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 3, count: 2 })
    const state = {
      file: {
        sessionId: 'session',
        sheets: [{ id: 's1', rowCount: 500, columnCount: 20 }],
      },
      editJournal: journal,
      loadedRanges: new Map<string, Range>(),
      loadingKeys: new Map<string, string>(),
      retryTimers: new Map<string, number>(),
      decorationsPendingSheets: new Set<string>(),
      flags: { preloadRunning: false, preloadComplete: true },
      formulaMode: true,
    } as unknown as LazyWorkbookState
    // the person scrolled a few hundred rows down
    const worksheet = {
      getSheetId: () => 's1',
      getVisibleRange: () => at(300, 0, 340, 10),
    } as unknown as UniverWorksheet
    const runtime = { univerAPI: { getActiveWorkbook: () => null } } as unknown as UniverRuntime
    return { readWorkbookRange, state, worksheet, runtime }
  }

  it('without co-editing, the scroll after a row insert reads the window from the file again', async () => {
    const { readWorkbookRange, state, worksheet, runtime } = afterRowInsert()
    await loadVisibleRange(runtime, { current: state }, worksheet, () => {}).catch(() => {})
    expect(readWorkbookRange).toHaveBeenCalled()
  })

  it('with every cell resident, the windowed loader reads nothing and only notes the new extent', async () => {
    const { readWorkbookRange, state, worksheet, runtime } = afterRowInsert()
    modelResidency.whole = true
    await loadVisibleRange(runtime, { current: state }, worksheet, () => {})
    expect(readWorkbookRange).not.toHaveBeenCalled()
    expect(state.loadedRanges.get('s1')).toEqual(at(0, 0, 501, 19))
    // a read that asks for a range first (the AI's, a sort's) finds it loaded too
    state.loadedRanges.delete('s1')
    const loaded = await ensureLazyRangeLoaded(
      runtime,
      { current: state },
      worksheet,
      at(400, 0, 420, 5),
      () => {},
    )
    expect(loaded).toBe(true)
    expect(readWorkbookRange).not.toHaveBeenCalled()
  })
})

/** A plain model of what structural records do to one sheet, to weigh two lists against each other */
interface Lines {
  size: number | null | 'file' | 'new'
  hidden: boolean | 'file'
}
interface Sheet {
  rows: Lines[]
  cols: Lines[]
  merges: Range[]
}

const overlap = (a: Range, b: Range): boolean =>
  a.startRow <= b.endRow &&
  b.startRow <= a.endRow &&
  a.startColumn <= b.endColumn &&
  b.startColumn <= a.endColumn

function shiftMerges(
  merges: Range[],
  rows: boolean,
  index: number,
  count: number,
  insert: boolean,
): Range[] {
  const [startKey, endKey] = rows
    ? (['startRow', 'endRow'] as const)
    : (['startColumn', 'endColumn'] as const)
  return merges.flatMap((merge) => {
    let start = merge[startKey]
    let end = merge[endKey]
    if (insert) {
      if (start >= index) start += count
      if (end >= index) end += count
    } else {
      start = start >= index + count ? start - count : Math.min(start, index)
      end = end >= index + count ? end - count : Math.min(end, index - 1)
    }
    return end < start ? [] : [{ ...merge, [startKey]: start, [endKey]: end }]
  })
}

function apply(sheet: Sheet, op: StructuralJournalOp): void {
  const fresh = (): Lines => ({ size: 'new', hidden: false })
  switch (op.kind) {
    case 'insert-rows':
    case 'insert-cols': {
      const rows = op.kind === 'insert-rows'
      const lines = rows ? sheet.rows : sheet.cols
      lines.splice(op.index, 0, ...Array.from({ length: op.count }, fresh))
      sheet.merges = shiftMerges(sheet.merges, rows, op.index, op.count, true)
      return
    }
    case 'remove-rows':
    case 'remove-cols': {
      const rows = op.kind === 'remove-rows'
      const lines = rows ? sheet.rows : sheet.cols
      lines.splice(op.index, op.count)
      sheet.merges = shiftMerges(sheet.merges, rows, op.index, op.count, false)
      return
    }
    case 'move-rows': {
      const moved = sheet.rows.splice(op.index, op.count)
      sheet.rows.splice(op.before > op.index ? op.before - op.count : op.before, 0, ...moved)
      return
    }
    case 'set-row-size':
    case 'set-col-size': {
      const lines = op.kind === 'set-row-size' ? sheet.rows : sheet.cols
      for (let line = op.start; line <= op.end && line < lines.length; line++)
        lines[line]!.size = op.size
      return
    }
    case 'set-rows-hidden':
    case 'set-cols-hidden': {
      const lines = op.kind === 'set-rows-hidden' ? sheet.rows : sheet.cols
      for (let line = op.start; line <= op.end && line < lines.length; line++)
        lines[line]!.hidden = op.hidden
      return
    }
    case 'merge-cells':
      sheet.merges.push({ ...op.range })
      return
    case 'unmerge-cells':
      sheet.merges = sheet.merges.filter((merge) => !overlap(merge, op.range))
      return
    default:
      throw new Error(`the model does not know ${op.kind}`)
  }
}

function sheetAfter(ops: readonly StructuralJournalOp[]): Sheet {
  const lines = (count: number): Lines[] =>
    Array.from({ length: count }, () => ({ size: 'file', hidden: 'file' }))
  const sheet: Sheet = { rows: lines(60), cols: lines(20), merges: [] }
  for (const op of ops) apply(sheet, op)
  sheet.merges.sort((a, b) => a.startRow - b.startRow || a.startColumn - b.startColumn)
  return sheet
}

/** Records as a session leaves them: many sizes and hidden flags, some merges, now and then lines */
function randomRecords(seed: number, count: number): StructuralJournalOp[] {
  const random = seeded(seed)
  const ops: StructuralJournalOp[] = []
  const sheet: Sheet = sheetAfter([])
  const push = (op: StructuralJournalOp): void => {
    ops.push(op)
    apply(sheet, op)
  }
  let lastInsert = 5
  while (ops.length < count) {
    const roll = random()
    const start = int(random, 30)
    const end = start + int(random, 4)
    if (roll < 0.35) {
      push({ kind: 'set-row-size', start, end, size: [15, 20, 33, null][int(random, 4)]! })
    } else if (roll < 0.5) {
      push({ kind: 'set-rows-hidden', start, end, hidden: random() < 0.5 })
    } else if (roll < 0.58) {
      push({ kind: 'set-col-size', start: start % 12, end: start % 12, size: 8 + int(random, 3) })
    } else if (roll < 0.62) {
      push({ kind: 'set-cols-hidden', start: start % 12, end: start % 12, hidden: random() < 0.5 })
    } else if (roll < 0.72) {
      // half of them right where the last one went, as a person adding rows one by one does
      const index = random() < 0.5 ? lastInsert + int(random, 2) : int(random, 30)
      lastInsert = index
      push({ kind: 'insert-rows', index, count: 1 + int(random, 2) })
    } else if (roll < 0.78) {
      const last = ops[ops.length - 1]
      const index = last?.kind === 'remove-rows' && random() < 0.6 ? last.index : int(random, 30)
      push({ kind: 'remove-rows', index, count: 1 + int(random, 2) })
    } else if (roll < 0.81) {
      push({
        kind: random() < 0.5 ? 'insert-cols' : 'remove-cols',
        index: int(random, 10),
        count: 1,
      })
    } else if (roll < 0.83) {
      push({ kind: 'move-rows', index: 2, count: 2, before: 10 + int(random, 5) })
    } else if (roll < 0.93 || sheet.merges.length === 0) {
      // Univer takes the merges under a new one apart first, so merges never overlap
      const range = at(start, int(random, 8), end, 8 + int(random, 3))
      if (!sheet.merges.some((merge) => overlap(merge, range))) push({ kind: 'merge-cells', range })
    } else {
      const merge = sheet.merges[int(random, sheet.merges.length)]!
      push({ kind: 'unmerge-cells', range: { ...merge } })
    }
  }
  return ops
}

describe('the structural records of a session, compacted', () => {
  it('a later size or hidden flag replaces an earlier one on the lines it covers', () => {
    expect(
      compactStructuralOps([
        { kind: 'set-row-size', start: 2, end: 6, size: 20 },
        { kind: 'set-rows-hidden', start: 4, end: 4, hidden: true },
        { kind: 'set-row-size', start: 4, end: 5, size: 30 },
        { kind: 'set-row-size', start: 6, end: 6, size: 30 },
        { kind: 'set-rows-hidden', start: 4, end: 4, hidden: false },
      ]),
    ).toEqual([
      { kind: 'set-row-size', start: 2, end: 3, size: 20 },
      { kind: 'set-row-size', start: 4, end: 6, size: 30 },
      { kind: 'set-rows-hidden', start: 4, end: 4, hidden: false },
    ])
  })

  it('a merge taken apart again leaves no record, and rows added one by one are one insert', () => {
    const range = at(1, 1, 1, 3)
    expect(
      compactStructuralOps([
        { kind: 'merge-cells', range },
        { kind: 'merge-cells', range: at(5, 0, 6, 0) },
        { kind: 'unmerge-cells', range },
        { kind: 'insert-rows', index: 4, count: 1 },
        { kind: 'insert-rows', index: 5, count: 2 },
        { kind: 'insert-rows', index: 4, count: 1 },
      ]),
    ).toEqual([
      { kind: 'merge-cells', range: at(5, 0, 6, 0) },
      { kind: 'insert-rows', index: 4, count: 4 },
    ])
  })

  it('nothing is weighed across a row or column change: the lines are not the same ones', () => {
    const ops: StructuralJournalOp[] = [
      { kind: 'set-row-size', start: 4, end: 4, size: 20 },
      { kind: 'insert-rows', index: 2, count: 1 },
      { kind: 'set-row-size', start: 4, end: 4, size: 30 },
    ]
    expect(compactStructuralOps(ops)).toEqual(ops)
  })

  it('leaves the sheet as the full list does, for every seed', () => {
    let kept = 0
    for (let seed = 1; seed <= 300; seed++) {
      const ops = randomRecords(seed, 200)
      const compacted = compactStructuralOps(ops)
      expect(compacted.length, `seed ${seed}`).toBeLessThanOrEqual(ops.length)
      expect(sheetAfter(compacted), `seed ${seed}`).toEqual(sheetAfter(ops))
      kept += compacted.length
    }
    // a fifth of each list is row and column changes, which nothing is weighed across
    expect(kept).toBeLessThan(300 * 200)
  })
})

describe('a save request of a session that never empties its journal', () => {
  const base: WorkbookSaveRequest = {
    ...workbookSaveRequestSchema.parse({
      sessionId: '5d4f6f7a-1c2b-4e3d-9a8f-0b1c2d3e4f5a',
      mode: 'save-as',
      edits: [],
      structuralOps: [],
      chartEdits: [],
      visualEdits: [],
      visualAdditions: [],
      tableAdditions: [],
      pivotAdditions: [],
      sheetOps: [],
      sheetOrder: [],
      filterStates: [],
      hyperlinkEdits: [],
      cfStates: [],
      dvStates: [],
      pageSetupStates: [],
      noteStates: [],
      formulaValues: [],
      pivotCacheRefreshPaths: [],
      pivotRefreshUpdates: [],
      sheetProtections: [],
      sparklineAdditions: [],
      definedNamesState: null,
    }),
    mode: 'save',
  }

  it('sends more size records than a session may record as the few that remain once compacted', () => {
    // 1 500 drags of the heights of ten rows
    const structuralOps = Array.from({ length: 1_500 }, (_, i) => ({
      sheetId: 's1',
      kind: 'set-row-size' as const,
      start: i % 10,
      end: i % 10,
      size: 20 + (i % 7),
    }))
    const request = coEditedSaveRequest({ ...base, structuralOps })
    expect(request?.structuralOps.length).toBeLessThanOrEqual(10)
    expect(request?.structuralOps.every((op) => op.sheetId === 's1')).toBe(true)
  })

  it('keeps records that cannot be compacted, each sheet’s in their order', () => {
    const structuralOps = Array.from({ length: STRUCTURAL_OPS_LIMIT + 200 }, (_, i) => ({
      sheetId: i % 2 === 0 ? 's1' : 's2',
      kind: 'merge-cells' as const,
      range: at(i, 0, i, 1),
    }))
    const request = coEditedSaveRequest({ ...base, structuralOps })
    expect(request?.structuralOps).toHaveLength(STRUCTURAL_OPS_LIMIT + 200)
    // each sheet's records keep their order
    expect(
      request?.structuralOps
        .filter((op) => op.sheetId === 's2')
        .map((op) => ('range' in op ? op.range.startRow : -1)),
    ).toEqual(Array.from({ length: (STRUCTURAL_OPS_LIMIT + 200) / 2 }, (_, i) => 2 * i + 1))
  })

  it('is the base file itself while nobody has edited anything a save writes', () => {
    // the request schema refuses a save with nothing to apply; the session's save then failed the page
    expect(workbookSaveRequestSchema.safeParse(base).success).toBe(false)
    expect(coEditedSaveRequest(base)).toBeNull()
  })

  it('still refuses a request that is wrong', () => {
    const structuralOps = [{ sheetId: 's1', kind: 'insert-rows' as const, index: -1, count: 1 }]
    expect(() => coEditedSaveRequest({ ...base, structuralOps })).toThrow()
  })
})

describe('an edit that would leave the journal no room for a save', () => {
  const merges = (count: number): StructuralJournalOp[] =>
    Array.from({ length: count }, (_, i) => ({
      kind: 'merge-cells',
      range: at(2 * i, 20, 2 * i, 21),
    }))
  const insertRow = { subUnitId: 's1', range: at(1, 0, 1, 11), direction: 0 }

  it('is refused before it runs, and the person is told why', () => {
    const room = new Room()
    const journal = createEditJournal()
    const told: string[] = []
    const a = room.join(journal, { onBlocked: (id, reason) => told.push(`${reason}: ${id}`) })
    // a row insert may record two; the room left for edits several people make at once is 100
    journal.structuralOps.set('s1', merges(STRUCTURAL_OPS_LIMIT - 100 - 2))
    expect(a.edit('fits', 'sheet.command.insert-row-by-range', insertRow)).toBe(true)
    const rows = a.workbook.getSheetBySheetId('s1')!.getRowCount()
    expect(a.edit('full', 'sheet.command.insert-row-by-range', insertRow)).toBe(false)
    expect(told).toEqual(['limit: sheet.mutation.insert-row'])
    expect(a.workbook.getSheetBySheetId('s1')!.getRowCount()).toBe(rows)
    expect(a.emitted.map((op) => op.id)).toEqual(['fits'])
    // what records nothing structural still goes through
    expect(
      a.edit('typed', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: at(0, 0, 0, 0),
        value: { v: 'still editable' },
      }),
    ).toBe(true)
  })

  it('counts the records as a save sends them, not as the journal holds them', () => {
    const journal = createEditJournal()
    // 5 000 drags of one row's height are one record in a save
    journal.structuralOps.set(
      's1',
      Array.from({ length: 5_000 }, (_, i) => ({
        kind: 'set-row-size',
        start: 3,
        end: 3,
        size: 20 + (i % 30),
      })),
    )
    const insert = {
      id: 'sheet.mutation.insert-row',
      params: { subUnitId: 's1', range: at(1, 0, 1, 11) },
    }
    expect(structuralOpsRefusal(journal, insert)).toBeNull()
    journal.structuralOps.set('s2', merges(STRUCTURAL_OPS_LIMIT - 100))
    expect(structuralOpsRefusal(journal, insert)).toBe('limit')
    expect(
      structuralOpsRefusal(journal, {
        id: 'sheet.mutation.set-range-values',
        params: { subUnitId: 's1', cellValue: { 0: { 0: { v: 1 } } } },
      }),
    ).toBeNull()
  })
})

describe('edits a co-editing page refuses where they start', () => {
  it('an AI run, and the pickers that are the only way to a slicer or a timeline', () => {
    // a run takes the workbook for itself while the other people's edits keep arriving
    expect(sharedWhileCoEditing('direct:ai-run')).toBe(false)
    // slicers and timelines exist only once made through these; a file opens with none
    expect(sharedWhileCoEditing('slicer-open')).toBe(false)
    expect(sharedWhileCoEditing('timeline-open')).toBe(false)
    // the panel itself changes nothing
    expect(sharedWhileCoEditing('ai-open-panel')).toBe(true)
  })
})
