/**
 * The app's save journal (renderer/edit-journal.ts) under co-editing.
 *
 * Marks. The journal is an overwrite record fed by every mutation that runs.
 * That is right for remote and replayed mutations, which are the edits
 * themselves, but the mutations that revert an edit are not edits: a cell
 * cleared and set back journals as "reset this cell's style and write the old
 * value" (the old style travels as a style id, which the journal does not
 * read), and a full restore of a sheet's merges journals every merge once
 * more. A file saved from such a journal differs from the screen and from
 * every other page's file. So the adapter takes a mark right before each local
 * mutation runs, and once it has reverted that mutation it puts the journal
 * back to the mark: the journal then holds the log in server order, as on a
 * page that only ever applied it. A mark covers what its mutation and the
 * mutations that revert it can record, and nothing else: what the app journals
 * without a mutation (the zoom a person set, a chart's cached values) stays.
 *
 * Room. A session's journal is never emptied, a page that joins later builds
 * the same one from the log, and one save carries a bounded number of
 * structural records. The save sends them compacted (most are sizes, hidden
 * flags and merges a later record supersedes), and a local edit that would
 * leave no room is refused before it runs.
 */
import type { IRange } from '@univerjs/core'
import {
  AXIS_ATTR_MUTATIONS,
  MERGE_MUTATIONS,
  MOVE_ROWS_MUTATION,
  ROW_COLUMN_MUTATIONS,
  SHEET_LIFECYCLE_MUTATIONS,
} from '../renderer/app-constants'
import type {
  EditJournal,
  JournalEntry,
  PageSetupJournalState,
  StructuralJournalOp,
} from '../renderer/edit-journal'
import {
  MOVE_RANGE,
  type Mutation,
  REMOVE_DEFINED_NAME,
  REMOVE_NUMFMT,
  REORDER_RANGE,
  SET_DEFINED_NAME,
  SET_FROZEN,
  SET_NUMFMT,
  SET_RANGE_VALUES,
  SET_RIGHT_TO_LEFT,
  TOGGLE_GRIDLINES,
} from './collab-mutations'

/** Puts the journal back to where it was when the mark was taken; runs at most once */
export type JournalRevert = () => void

/** The page-setup fields mutations record (freeze, gridlines, direction) or shift (breaks) */
const PAGE_SETUP_FROM_MUTATIONS: readonly (keyof PageSetupJournalState)[] = [
  'frozenRows',
  'frozenColumns',
  'showGridlines',
  'rightToLeft',
  'rowBreaks',
  'colBreaks',
]

/** `map`'s entry at `key` as it is now; entries are replaced by the journal, never changed in place */
function entryMark<V>(map: Map<string, V>, key: string, copy: (value: V) => V): JournalRevert {
  const had = map.has(key)
  const saved = had ? copy(map.get(key)!) : undefined
  return () => {
    if (had) map.set(key, copy(saved!))
    else map.delete(key)
  }
}

/** One sheet's page setup: the fields mutations write go back, the others keep what they hold now */
function pageSetupMark(journal: EditJournal, sheetId: string): JournalRevert {
  const saved = journal.pageSetup.get(sheetId)
  return () => {
    const next: Record<string, unknown> = { ...journal.pageSetup.get(sheetId) }
    for (const key of PAGE_SETUP_FROM_MUTATIONS) {
      if (saved && key in saved) next[key] = saved[key]
      else delete next[key]
    }
    if (Object.keys(next).length > 0 || saved) {
      journal.pageSetup.set(sheetId, next as PageSetupJournalState)
    } else journal.pageSetup.delete(sheetId)
  }
}

/** One sheet's cell entries, as a row or column change, a move, a sort or a number format rewrites them */
function cellsMark(journal: EditJournal, sheetId: string): JournalRevert {
  return entryMark(journal.cells, sheetId, (entries) => new Map(entries))
}

function structuralMark(journal: EditJournal, sheetId: string): JournalRevert {
  return entryMark(journal.structuralOps, sheetId, (ops) => ops.slice())
}

/**
 * Everything a row or column change of one sheet records or shifts: its
 * structural list, cell entries, fills, links, page breaks, and the anchors of
 * drawings. A chart's pending edit is left as it is: its references are moved
 * by the change and moved back by the revert, and its cached values come from
 * the page's own data sync, not from a mutation.
 */
function axisMark(journal: EditJournal, sheetId: string): JournalRevert {
  const visualAdds = journal.visualAdds.slice()
  const visualEdits = new Map(journal.visualEdits)
  const parts = [
    structuralMark(journal, sheetId),
    cellsMark(journal, sheetId),
    entryMark(journal.bulkConstantFills, sheetId, (fills) => fills.slice()),
    entryMark(journal.hyperlinks, sheetId, (links) => new Map(links)),
    pageSetupMark(journal, sheetId),
  ]
  return () => {
    for (const part of parts) part()
    journal.visualAdds.splice(0, journal.visualAdds.length, ...visualAdds)
    journal.visualEdits.clear()
    for (const [id, edit] of visualEdits) journal.visualEdits.set(id, edit)
  }
}

/** The record of added, removed, renamed, hidden, coloured and reordered sheets */
function sheetsMark(journal: EditJournal): JournalRevert {
  const { added, removed, renamed, hidden, tabColor, orderDirty } = journal.sheets
  const saved = {
    added: new Map(added),
    removed: new Set(removed),
    renamed: new Map(renamed),
    hidden: new Map(hidden),
    tabColor: new Map(tabColor),
  }
  const refill = <K, V>(live: Map<K, V>, from: Map<K, V>): void => {
    live.clear()
    for (const [key, value] of from) live.set(key, value)
  }
  return () => {
    refill(added, saved.added)
    refill(renamed, saved.renamed)
    refill(hidden, saved.hidden)
    refill(tabColor, saved.tabColor)
    removed.clear()
    for (const id of saved.removed) removed.add(id)
    journal.sheets.orderDirty = orderDirty
  }
}

/** The entries of the cells one cell write names */
function writtenCellsMark(journal: EditJournal, mutation: Mutation): JournalRevert {
  const sheetId = String(mutation.params.subUnitId)
  const entries = journal.cells.get(sheetId)
  const before: [string, JournalEntry | undefined][] = []
  const cells = (mutation.params.cellValue ?? {}) as Record<
    string,
    Record<string, unknown> | null | undefined
  >
  for (const [row, columns] of Object.entries(cells)) {
    for (const column of Object.keys(columns ?? {})) {
      const key = `${Number(row)}:${Number(column)}`
      before.push([key, entries?.get(key)])
    }
  }
  return () => {
    const live = journal.cells.get(sheetId) ?? new Map<string, JournalEntry>()
    for (const [key, entry] of before) {
      if (entry) live.set(key, entry)
      else live.delete(key)
    }
    if (live.size > 0) journal.cells.set(sheetId, live)
    else journal.cells.delete(sheetId)
  }
}

/** Every part a mark can cover, for a mutation this file does not know how the app journals */
function wholeMark(journal: EditJournal): JournalRevert {
  const sheets = new Set([
    ...journal.cells.keys(),
    ...journal.structuralOps.keys(),
    ...journal.bulkConstantFills.keys(),
    ...journal.hyperlinks.keys(),
    ...journal.pageSetup.keys(),
  ])
  const known = [...sheets].map((sheetId) => axisMark(journal, sheetId))
  const lifecycle = sheetsMark(journal)
  const names = journal.definedNames.dirty
  return () => {
    // a sheet first journaled after the mark goes back to holding nothing
    for (const map of [
      journal.cells,
      journal.structuralOps,
      journal.bulkConstantFills,
      journal.hyperlinks,
    ])
      for (const sheetId of [...map.keys()]) if (!sheets.has(sheetId)) map.delete(sheetId)
    for (const part of known) part()
    lifecycle()
    journal.definedNames.dirty = names
  }
}

/**
 * The mark of `journal` before `mutation` (in the form `ICommandService` runs)
 * is recorded: the parts that mutation, and the mutations that take it back,
 * can write.
 */
export function journalMark(journal: EditJournal, mutation: Mutation): JournalRevert {
  const { id, params } = mutation
  const sheetId = String(params.subUnitId)
  if (id === SET_RANGE_VALUES) return writtenCellsMark(journal, mutation)
  if (ROW_COLUMN_MUTATIONS[id] || id === MOVE_ROWS_MUTATION) return axisMark(journal, sheetId)
  if (MERGE_MUTATIONS[id] || AXIS_ATTR_MUTATIONS[id]) return structuralMark(journal, sheetId)
  if (SHEET_LIFECYCLE_MUTATIONS.has(id)) return sheetsMark(journal)
  if (id === SET_NUMFMT || id === REMOVE_NUMFMT || id === REORDER_RANGE) {
    return cellsMark(journal, sheetId)
  }
  if (id === MOVE_RANGE) {
    const from = cellsMark(journal, (params.from as { subUnitId: string }).subUnitId)
    const to = cellsMark(journal, (params.to as { subUnitId: string }).subUnitId)
    return () => {
      from()
      to()
    }
  }
  if (id === SET_FROZEN || id === TOGGLE_GRIDLINES || id === SET_RIGHT_TO_LEFT) {
    return pageSetupMark(journal, sheetId)
  }
  if (id === SET_DEFINED_NAME || id === REMOVE_DEFINED_NAME) {
    const dirty = journal.definedNames.dirty
    return () => {
      journal.definedNames.dirty = dirty
    }
  }
  return wholeMark(journal)
}

/** What one save request may carry (shared/desktop-api.ts, `structuralOps`) */
export const STRUCTURAL_OPS_LIMIT = 1_000
/** Room left for the edits several people make before they see each other's */
const STRUCTURAL_OPS_ROOM = 100

type SpanKind = 'set-row-size' | 'set-col-size' | 'set-rows-hidden' | 'set-cols-hidden'
type SpanOp = Extract<StructuralJournalOp, { kind: SpanKind }>
type MergeOp = Extract<StructuralJournalOp, { kind: 'merge-cells' | 'unmerge-cells' }>
type InsertRemoveOp = Extract<
  StructuralJournalOp,
  { kind: 'insert-rows' | 'remove-rows' | 'insert-cols' | 'remove-cols' }
>

const isSpan = (op: StructuralJournalOp): op is SpanOp =>
  op.kind === 'set-row-size' ||
  op.kind === 'set-col-size' ||
  op.kind === 'set-rows-hidden' ||
  op.kind === 'set-cols-hidden'

const isMerge = (op: StructuralJournalOp): op is MergeOp =>
  op.kind === 'merge-cells' || op.kind === 'unmerge-cells'

const spanValue = (op: SpanOp): number | boolean | null => ('size' in op ? op.size : op.hidden)

const overlap = (a: MergeOp['range'], b: MergeOp['range']): boolean =>
  a.startRow <= b.endRow &&
  b.startRow <= a.endRow &&
  a.startColumn <= b.endColumn &&
  b.startColumn <= a.endColumn

const sameRange = (a: MergeOp['range'], b: MergeOp['range']): boolean =>
  a.startRow === b.startRow &&
  a.endRow === b.endRow &&
  a.startColumn === b.startColumn &&
  a.endColumn === b.endColumn

/**
 * The size or hidden records of one kind as the lines they leave set: a later
 * record wins on the lines it covers, and neighbours with one value join.
 */
function supersede(ops: readonly SpanOp[]): SpanOp[] {
  const taken: [number, number][] = []
  const pieces: SpanOp[] = []
  for (const op of [...ops].reverse()) {
    let free: [number, number][] = [[op.start, op.end]]
    for (const [start, end] of taken) {
      free = free.flatMap(([from, to]): [number, number][] => {
        if (end < from || start > to) return [[from, to]]
        const left: [number, number][] = start > from ? [[from, start - 1]] : []
        const right: [number, number][] = end < to ? [[end + 1, to]] : []
        return [...left, ...right]
      })
    }
    for (const [start, end] of free) {
      pieces.push({ ...op, start, end })
      taken.push([start, end])
    }
  }
  pieces.sort((a, b) => a.start - b.start)
  const out: SpanOp[] = []
  for (const piece of pieces) {
    const last = out[out.length - 1]
    // one record spans fewer than 100 000 lines (the save request's bound)
    if (
      last &&
      last.end + 1 === piece.start &&
      spanValue(last) === spanValue(piece) &&
      piece.end - last.start < 100_000
    ) {
      out[out.length - 1] = { ...last, end: piece.end }
    } else out.push(piece)
  }
  return out
}

/** The records between two row or column changes: they share one coordinate space */
function compactSegment(segment: readonly StructuralJournalOp[]): StructuralJournalOp[] {
  const kept: StructuralJournalOp[] = []
  const spans = new Map<SpanKind, SpanOp[]>()
  for (const op of segment) {
    if (isSpan(op)) {
      spans.set(op.kind, [...(spans.get(op.kind) ?? []), op])
      continue
    }
    if (op.kind === 'unmerge-cells') {
      // a merge made and taken apart again, with no other merge over its cells in between
      let at = kept.length - 1
      while (at >= 0) {
        const earlier = kept[at]!
        if (isMerge(earlier) && overlap(earlier.range, op.range)) break
        at--
      }
      const earlier = at >= 0 ? kept[at]! : null
      if (earlier?.kind === 'merge-cells' && sameRange(earlier.range, op.range)) {
        kept.splice(at, 1)
        continue
      }
    }
    kept.push(op)
  }
  // sizes and hidden flags are attributes of their own: their place among the others is free
  return [...kept, ...[...spans.values()].flatMap(supersede)]
}

/** `next` joined to the insert or remove right before it, when both make one block of lines */
function joined(
  last: StructuralJournalOp | undefined,
  next: StructuralJournalOp,
): InsertRemoveOp | null {
  if (!last || last.kind !== next.kind || !('index' in last) || !('index' in next)) return null
  if (last.kind === 'move-rows' || next.kind === 'move-rows') return null
  if (last.count + next.count > 10_000) return null
  const inserting = last.kind === 'insert-rows' || last.kind === 'insert-cols'
  if (inserting) {
    // the new lines land inside or at an end of the lines the earlier insert added
    return next.index >= last.index && next.index <= last.index + last.count
      ? { ...last, count: last.count + next.count }
      : null
  }
  // the later remove takes lines on both sides of where the earlier one took its own
  return next.index <= last.index && next.index + next.count >= last.index
    ? { ...next, count: last.count + next.count }
    : null
}

/**
 * One sheet's structural records with the same effect in fewer records. The
 * coordinates of a record are those all records before it left, so only
 * records between two row or column changes are weighed against each other.
 */
export function compactStructuralOps(ops: readonly StructuralJournalOp[]): StructuralJournalOp[] {
  const out: StructuralJournalOp[] = []
  let segment: StructuralJournalOp[] = []
  for (const op of ops) {
    if (!('index' in op)) {
      segment.push(op)
      continue
    }
    const merged = segment.length === 0 ? joined(out[out.length - 1], op) : null
    if (merged) {
      out[out.length - 1] = merged
      continue
    }
    out.push(...compactSegment(segment), op)
    segment = []
  }
  out.push(...compactSegment(segment))
  return out
}

/** How many structural records the app journals for `mutation`, at most */
function structuralRecordsOf(mutation: Mutation): number {
  const { id, params } = mutation
  // a row or column insert may also record the outline level its new lines take
  if (ROW_COLUMN_MUTATIONS[id]) return 2
  if (id === MOVE_ROWS_MUTATION) return 1
  const ranges = ((params.ranges ?? []) as IRange[]).length
  if (MERGE_MUTATIONS[id]) return ranges
  const attribute = AXIS_ATTR_MUTATIONS[id]
  if (!attribute) return 0
  // sizes given line by line (an undo puts them back so) are one record a line
  const perLine = params.rowHeight ?? params.colWidth ?? params.autoHeightInfo
  return perLine && typeof perLine === 'object' ? Object.keys(perLine).length : ranges
}

/**
 * Whether `mutation` must be refused because the journal has no room for what
 * it records: every later save of this session, from any page, would fail.
 */
export function structuralOpsRefusal(
  journal: EditJournal,
  mutation: Mutation,
  limit = STRUCTURAL_OPS_LIMIT - STRUCTURAL_OPS_ROOM,
): 'limit' | null {
  const added = structuralRecordsOf(mutation)
  if (added === 0) return null
  let held = 0
  for (const ops of journal.structuralOps.values()) held += compactStructuralOps(ops).length
  return held + added > limit ? 'limit' : null
}
