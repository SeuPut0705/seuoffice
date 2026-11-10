/**
 * The Sheets editor's co-editing adapter (`@seuoffice/collab`).
 *
 * One op is the list of mutations one burst of local work executed (a command
 * and the mutations its interceptors added, such as formula reference
 * rewrites), in the wire form of collab-mutations.ts. Right before each of
 * those mutations runs, the adapter computes the mutations that undo it, so it
 * holds an exact inverse for every unconfirmed op.
 *
 * `integrate` reverts the unconfirmed ops (newest first), applies the remote
 * mutations, rewrites the local ops past the remote structural changes
 * (collab-rebase.ts) and replays them, computing fresh inverses. The page then
 * shows confirmed state plus its own ops exactly as it will send them, so every
 * page that applies the log in order reaches the same workbook.
 * The formula text Univer restates when rows, columns or a sheet's name change
 * is right only for the workbook it was computed on, so a replay leaves that
 * part of an op out and computes it again from the formulas the workbook
 * holds then: someone else's formula, confirmed meanwhile, is rewritten from
 * what it says now instead of being overwritten.
 *
 * A page that may show something else than the log stops at once: a remote or
 * replayed mutation that does not run, or a local one the adapter lost track
 * of, fails the session on this page instead of leaving it to drift.
 *
 * Every mutation the adapter runs goes through `ICommandService` with
 * `fromCollab`, so the app's save journal (a `CommandExecuted` listener)
 * records remote and replayed mutations like local ones. The mutations that
 * revert an edit are recorded too, but they are not edits, so the adapter
 * puts the journal back to its mark from before the edit (collab-journal.ts):
 * the journal then holds the log in server order, as on every other page.
 * Mutations that cannot be undone exactly are cancelled before they run.
 * A local edit too large to travel as one change is taken back whole, and
 * this page's undo history is emptied when someone else's change could make
 * an undo take that change back.
 */
import { type CollabAdapter, type Json, MAX_CHANGE_BYTES } from '@seuoffice/collab/client'
import {
  CommandType,
  CustomCommandExecutionError,
  ICommandService,
  IUndoRedoService,
  Rectangle,
  type ICommandInfo,
  type IExecutionOptions,
  type IRange,
  type Univer,
  type Workbook,
} from '@univerjs/core'
import { FormulaDataModel, IDefinedNamesService } from '@univerjs/engine-formula'
import { journalSuppression } from '../renderer/univer-state'
import { fingerprintText, hashText } from './collab-fingerprint'
import type { JournalRevert } from './collab-journal'
import {
  classify,
  ADD_MERGE,
  fromWire,
  INSERT_COL,
  INSERT_ROW,
  INSERT_SHEET,
  inverseOf,
  isSynced,
  MOVE_COLS,
  MOVE_RANGE,
  MOVE_ROWS,
  type Mutation,
  type MutationEnv,
  type Params,
  REMOVE_COL,
  REMOVE_MERGE,
  REMOVE_ROWS,
  REMOVE_SHEET,
  REMOVE_DEFINED_NAME,
  SET_DEFINED_NAME,
  SET_RANGE_VALUES,
  SET_SHEET_HIDDEN,
  SET_SHEET_NAME,
  SET_SHEET_ORDER,
  toWire,
  workbookOf,
} from './collab-mutations'
import {
  axisChangeOf,
  type AxisChange,
  type Change,
  mapIndex,
  rebaseMutations,
  renameInFormula,
  shiftFormula,
  type SheetNames,
} from './collab-rebase'
import {
  checkWireMutation,
  firstInvalid,
  MAX_COLUMNS,
  MAX_REBUILD_WORK,
  MAX_ROWS,
  MAX_SHEET_NAME,
  mergedCells,
  mergesFit,
} from './collab-wire-check'

/**
 * User commands whose every mutation co-editing cannot take back exactly
 * (collab-mutations.ts), refused before anything runs: conditional formats,
 * data validation, filters, notes, tables, drawings, protection, range themes
 * and the workbook name. A command not listed here that still reaches such a
 * mutation is refused there and taken back whole when it ends.
 *
 * Copying a sheet is refused for another reason: it travels as one insert of
 * a sheet that already holds its cells, and the save journal of every other
 * page records a new sheet as an empty one, so their files would lack the copy.
 */
export const BLOCKED_COMMANDS = new Set([
  'sheet.command.add-conditional-rule',
  'sheet.command.clear-range-conditional-rule',
  'sheet.command.clear-worksheet-conditional-rule',
  'sheet.command.delete-conditional-rule',
  'sheet.command.move-conditional-rule',
  'sheet.command.set-conditional-rule',
  'sheet.command.add-average-conditional-rule',
  'sheet.command.add-color-scale-conditional-rule',
  'sheet.command.add-data-bar-conditional-rule',
  'sheet.command.add-duplicate-values-conditional-rule',
  'sheet.command.add-number-conditional-rule',
  'sheet.command.add-rank-conditional-rule',
  'sheet.command.add-text-conditional-rule',
  'sheet.command.add-time-period-conditional-rule',
  'sheet.command.add-uniqueValues-conditional-rule',
  'sheet.command.updateDataValidationRuleRange',
  'sheet.command.addDataValidation',
  'sheets.command.update-data-validation-setting',
  'sheets.command.update-data-validation-options',
  'sheets.command.clear-range-data-validation',
  'sheet.command.remove-all-data-validation',
  'sheet.command.remove-data-validation-rule',
  'data-validation.command.addRuleAndOpen',
  'data-validation.command.addRule',
  'data-validation.command.removeRule',
  'data-validation.command.updateDataValidationSetting',
  'data-validation.command.updateDataValidationOptions',
  'data-validation.command.removeAll',
  'sheet.command.set-filter-range',
  'sheet.command.remove-sheet-filter',
  'sheet.command.smart-toggle-filter',
  'sheet.command.set-filter-criteria',
  'sheet.command.clear-filter-criteria',
  'sheet.command.delete-note',
  'sheet.command.update-note',
  'sheet.command.add-table',
  'sheet.command.add-table-theme',
  'sheet.command.delete-table',
  'sheet.command.remove-table-theme',
  'sheet.command.set-table-config',
  'sheet.command.set-table-filter',
  'sheet.command.table-insert-row',
  'sheet.command.table-insert-row-at',
  'sheet.command.table-insert-col',
  'sheet.command.table-insert-column-at',
  'sheet.command.table-remove-column-at',
  'sheet.command.table-remove-row',
  'sheet.command.table-remove-col',
  'sheet.command.delete-drawing',
  'sheet.command.group-sheet-image',
  'sheet.command.ungroup-sheet-image',
  'sheet.command.insert-float-image',
  'sheet.command.insert-cell-image',
  'sheet.command.move-drawing',
  'sheet.command.save-cell-images',
  'sheet.command.toggle-flip-drawings',
  'sheet.command.add-range-protection',
  'sheet.command.delete-range-protection',
  'sheet.command.set-protection',
  'sheet.command.add-worksheet-protection',
  'sheet.command.delete-worksheet-protection',
  'sheet.command.set-worksheet-protection',
  'sheet.command.set-worksheet-permission-points',
  'sheet.command.set-worksheet-range-theme-style',
  'sheet.command.remove-worksheet-range-theme-style',
  'sheet.command.register-worksheet-range-theme-style',
  'sheet.command.unregister-worksheet-range-theme-style',
  'sheet.command.set-workbook-name',
  'sheet.command.copy-sheet',
])

/** One local edit as it travels: its mutations in wire form, in the order they ran */
export interface SheetOp {
  readonly id: string
  readonly mutations: readonly Mutation[]
}

/** What the renderer hands over once the workbook is on screen */
export interface SheetsCollabHandles {
  readonly univer: Univer
  /** the Univer unit id of the co-edited workbook */
  readonly unitId: string
  /** the file of exactly the workbook on screen; must not reopen or change anything */
  produceFile(): Promise<{ fileName: string; bytes: Uint8Array }>
  /**
   * The app's save journal records every mutation that runs. Called right
   * before a local mutation runs; the result puts the journal back to that
   * moment, and the adapter calls it once it has reverted the mutation
   * (collab-journal.ts). Without it the journal keeps what the reverts wrote.
   */
  journalMark?(mutation: Mutation): JournalRevert
  /**
   * Why a local mutation (in the form `ICommandService` runs) must not run
   * now although it could be shared; null when it may. Asked before it runs.
   */
  refusalOf?(mutation: Mutation): BlockReason | null
}

export interface SheetsCollabAdapter extends CollabAdapter<SheetOp> {
  confirmed(ops: SheetOp[]): void
  /** report the mutations of the current burst now, as one op tagged `id` */
  flush(id?: string): boolean
  dispose(): void
}

/**
 * Why a local edit was cancelled: it cannot be shared, it is too large to
 * travel as one change, or the session's save journal has no room for it.
 */
export type BlockReason = 'unshared' | 'too-large' | 'limit'

export interface SheetsCollabOptions {
  /** 'manual': ops are reported only by `flush` (tests drive bursts themselves) */
  readonly bursts?: 'macrotask' | 'manual'
  /** a local edit was cancelled, or taken back whole */
  readonly onBlocked?: (mutationId: string, reason: BlockReason) => void
  /** the largest op to report, in bytes of its JSON; the engine's limit for one change by default */
  readonly maxChangeBytes?: number
}

/** What takes local mutations back: `undo` runs in order, then `journal` in order (newest mark first) */
interface Revert {
  undo: Mutation[]
  journal: JournalRevert[]
}

interface Burst extends Revert {
  mutations: Mutation[]
  /** the merged cells its mutations made Univer rebuild (rebuildWork) */
  work: number
}

/** One local mutation as it ran again (wire form), with what takes it back */
interface Replayed extends Revert {
  wire: Mutation
}

/** What the adapter keeps of a local mutation between its before and its executed event */
interface Captured extends Revert {
  /** it only restates formulas after the structural mutation before it (Univer's reference rewrite) */
  rewrite: boolean
  work: number
}

/** A user command that began; where the burst stood then, and whether one of its mutations was refused */
interface OpenCommand {
  info: ICommandInfo
  mutations: number
  undo: number
  journal: number
  refused: boolean
}

/** A formula a cell holds: its own text, or the one its shared-formula group gives it */
interface HeldFormula {
  sheet: string
  row: number
  column: number
  formula: string
  /** sheet and shared-formula id; null for a cell with a formula of its own only */
  group: string | null
}

/** What the engine adds around an op when it sends it; an op this close to the limit is refused */
const OP_FRAME_BYTES = 64 * 1024
/** Commands that began and never ended (thrown, cancelled) stay listed; nesting never goes this deep */
const MAX_OPEN_COMMANDS = 64

const FROM_COLLAB: IExecutionOptions = { fromCollab: true }

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')
}

function subUnitsOf(mutation: Mutation): string[] {
  const p = mutation.params
  if (mutation.id === MOVE_RANGE) {
    return [(p.from as { subUnitId: string }).subUnitId, (p.to as { subUnitId: string }).subUnitId]
  }
  return typeof p.subUnitId === 'string' && mutation.id !== INSERT_SHEET ? [p.subUnitId] : []
}

/** The cells a cell matrix names, as `row:column` */
function cellKeys(matrix: unknown): string[] {
  const keys: string[] = []
  for (const [row, columns] of Object.entries((matrix ?? {}) as Record<string, object | null>))
    for (const column of Object.keys(columns ?? {})) keys.push(`${Number(row)}:${Number(column)}`)
  return keys
}

/**
 * Whether a cell matrix only sets or clears formula text: the shape of the
 * rewrite Univer adds to a command that moves rows, columns or a sheet's name.
 */
function restatesFormulas(matrix: unknown): boolean {
  let cells = 0
  for (const columns of Object.values((matrix ?? {}) as Record<string, object | null>)) {
    for (const cell of Object.values(columns ?? {}) as unknown[]) {
      if (!cell || typeof cell !== 'object') return false
      if (Object.keys(cell).some((key) => key !== 'f' && key !== 'si')) return false
      cells++
    }
  }
  return cells > 0
}

/** Whether a sheet snapshot holds cells, merges, or row or column records */
function carriesContent(sheet: unknown): boolean {
  const { cellData, rowData, columnData, mergeData } = (sheet ?? {}) as {
    cellData?: object
    rowData?: object
    columnData?: object
    mergeData?: unknown[]
  }
  if ((mergeData?.length ?? 0) > 0) return true
  return [cellData, rowData, columnData].some(
    (data) => data !== undefined && Object.keys(data).length > 0,
  )
}

/**
 * `name`, or the first `name (n)` no other sheet uses, shortened to Excel's 31 characters; sheet
 * names compare without case. It reads only the workbook, so pages at one version agree on it.
 */
function freeName(workbook: Workbook, name: string, self: string): string {
  const taken = new Set(
    workbook
      .getSheets()
      .filter((sheet) => sheet.getSheetId() !== self)
      .map((sheet) => sheet.getName().toLowerCase()),
  )
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${name.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** `wire` with the sheet name it sets made free in `workbook` */
function withFreeName(workbook: Workbook, wire: Mutation): Mutation {
  if (wire.id === INSERT_SHEET) {
    const sheet = wire.params.sheet as { id: string; name: string }
    const name = freeName(workbook, sheet.name, sheet.id)
    return name === sheet.name
      ? wire
      : { id: wire.id, params: { ...wire.params, sheet: { ...sheet, name } } }
  }
  if (wire.id === SET_SHEET_NAME) {
    const name = freeName(workbook, String(wire.params.name), String(wire.params.subUnitId))
    return name === wire.params.name ? wire : { id: wire.id, params: { ...wire.params, name } }
  }
  return wire
}

/**
 * Whether `wire` keeps its sheet within what every page can hold: Excel's grid, and the merged
 * cells a span cache may walk. Every page decides it on the same version of the log.
 */
function keepsSheetBounds(workbook: Workbook, wire: Mutation): boolean {
  const sheet = workbook.getSheetBySheetId(String(wire.params.subUnitId))
  if (!sheet) return true
  const range = wire.params.range as IRange
  switch (wire.id) {
    case ADD_MERGE:
      return mergesFit(sheet.getConfig().mergeData, wire.params.ranges as IRange[])
    case INSERT_ROW:
      return sheet.getRowCount() + range.endRow - range.startRow + 1 <= MAX_ROWS
    case INSERT_COL:
      return sheet.getColumnCount() + range.endColumn - range.startColumn + 1 <= MAX_COLUMNS
    default:
      return true
  }
}

/** Mutations after which Univer rebuilds the sheet's span cache over every merged cell */
const REBUILDS_SPANS = new Set([
  ADD_MERGE,
  REMOVE_MERGE,
  INSERT_ROW,
  INSERT_COL,
  REMOVE_ROWS,
  REMOVE_COL,
  MOVE_ROWS,
  MOVE_COLS,
])

/**
 * The merged cells Univer walks when `wire` runs now: the sheet's merges (with those it adds) for
 * a mutation that rebuilds the span cache, a new sheet's own merges. Pages at one version of the
 * log agree on it, so an op is held to MAX_REBUILD_WORK the same way everywhere.
 */
function rebuildWork(workbook: Workbook, wire: Mutation): number {
  if (wire.id === INSERT_SHEET)
    return mergedCells((wire.params.sheet as { mergeData?: IRange[] }).mergeData ?? [])
  if (!REBUILDS_SPANS.has(wire.id)) return 0
  const sheet = workbook.getSheetBySheetId(String(wire.params.subUnitId))
  if (!sheet) return 0
  const added = wire.id === ADD_MERGE ? mergedCells(wire.params.ranges as IRange[]) : 0
  return mergedCells(sheet.getConfig().mergeData) + added
}

export function sheetsCollabAdapter(
  handles: SheetsCollabHandles,
  options: SheetsCollabOptions = {},
): SheetsCollabAdapter {
  const injector = handles.univer.__getInjector()
  const accessor = injector as unknown as MutationEnv['accessor']
  const commands = injector.get(ICommandService)
  // Univer stamps the innermost command on this stack onto every mutation as `trigger`, and a
  // command that threw never leaves it. Mutations the adapter runs carry their own trigger.
  const commandStack = (commands as unknown as { _commandExecutionStack?: unknown[] })
    ._commandExecutionStack
  if (!Array.isArray(commandStack))
    throw new Error('co-editing needs the Univer command execution stack')
  const workbook = workbookOf(accessor, handles.unitId)
  if (!workbook) throw new Error(`no workbook ${handles.unitId}`)
  const env: MutationEnv = { accessor, workbook }
  const names: SheetNames = { nameOf: (id) => workbook.getSheetBySheetId(id)?.getName() }
  const maxOpBytes = options.maxChangeBytes ?? MAX_CHANGE_BYTES - OP_FRAME_BYTES

  let emit: ((ops: SheetOp[]) => void) | null = null
  let editable = true
  let burst: Burst | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  /** set while integrate runs mutations; anything else that writes then is a stray */
  let applying = false
  let running: Params | null = null
  let strays: string[] = []
  /** why this page may no longer show what the log holds; every later call of the engine fails */
  let broken: Error | null = null
  /** every sheet a mutation removed on this page, local or remote: all journals know these ids */
  const removedSheets = new Set<string>()
  /** what was computed before a captured mutation ran, by its command info */
  const inverses = new WeakMap<ICommandInfo, Captured>()
  /**
   * Ids of captured mutations whose executed event has not come. One that another listener
   * cancelled after the capture stays listed, so the list is bounded: it only says when to look.
   */
  const awaited: string[] = []
  /** the revert of every reported op the server has not confirmed */
  const undoOf = new WeakMap<SheetOp, Revert>()
  /**
   * Wire mutations that only restate formulas after the structural mutation
   * before them. They are right for the workbook they were computed on, so a
   * replay computes them again instead of running them.
   */
  const rewrites = new WeakSet<Mutation>()
  /** counts the user commands that began; a rewrite runs in the round of its structural mutation */
  let commandRound = 0
  let rewriter: { round: number; trigger: string } | null = null
  /**
   * The cells this page's own edits wrote since its undo history was last
   * emptied, by sheet; null once one of those edits was not a plain cell
   * write. Undo entries write these cells (or, after null, anything).
   */
  let undoable: Map<string, Set<string>> | null = new Map()

  /**
   * Stop for good: this page may show something else than the log. Inside an
   * engine call the caller throws the result; outside one, an op that cannot
   * be encoded makes the engine fail the session as soon as it looks at it.
   */
  function fail(error: unknown): Error {
    if (broken) return broken
    broken = error instanceof Error ? error : new Error(String(error))
    console.error('[co-editing] this page stops:', broken)
    if (!applying) emit?.([{ id: 'broken', mutations: [] }])
    return broken
  }

  /** the save journal's mark before `mutation` (local form) runs, as the list a `Revert` holds */
  function journalMarkOf(mutation: Mutation): JournalRevert[] {
    return handles.journalMark ? [handles.journalMark(mutation)] : []
  }

  /**
   * Take local mutations back: run their inverses, then put the save journal
   * back, which recorded those inverses as if they were edits. Every inverse
   * runs before the first journal step, so each step finds the journal as the
   * mutations after its own left it.
   */
  function revert(reverts: readonly Revert[]): boolean {
    for (const { undo } of reverts) if (!run(undo)) return false
    for (const { journal } of reverts) for (const step of journal) step()
    return true
  }

  /** Univer's undo and redo entries of this workbook hold values and positions that no longer apply */
  function clearHistory(): void {
    injector.get(IUndoRedoService).clearUndoRedo(handles.unitId)
    undoable = new Map()
  }

  /**
   * Whether this page's undo history still fits after `remote`: only when the
   * remote ops wrote nothing but cells, none of them a cell this page's own
   * edits wrote, and those edits were cell writes too. Otherwise an undo could
   * take back someone else's confirmed value, write an old value where another
   * record now sits, or remove someone else's merge.
   */
  function historyFits(remote: readonly SheetOp[]): boolean {
    if (!undoable) return false
    for (const op of remote) {
      for (const mutation of op.mutations) {
        if (mutation.id !== SET_RANGE_VALUES) return false
        const own = undoable.get(String(mutation.params.subUnitId))
        if (own && cellKeys(mutation.params.cellValue).some((key) => own.has(key))) return false
      }
    }
    return true
  }

  function ours(info: ICommandInfo): boolean {
    const unitId = (info.params as { unitId?: unknown } | undefined)?.unitId
    if (unitId !== undefined) return unitId === handles.unitId
    return !info.id.startsWith('doc.')
  }

  /**
   * The formula engine computes by position and writes its results later. A
   * change applied meanwhile (a remote insert, a revert) moves or removes the
   * formula, and the result then lands on a cell that holds none: on this page
   * only, as a value. Results go only to cells that still hold a formula or sit
   * in an array formula's range; the engine recomputes the moved ones.
   */
  function dropStaleResults(params: Params): void {
    const sheet = workbook!.getSheetBySheetId(String(params.subUnitId))
    const cells = params.cellValue as
      Record<string, Record<string, unknown> | undefined> | undefined
    if (!sheet || !cells) return
    const arrays = arrayRanges(String(params.subUnitId))
    for (const [row, columns] of Object.entries(cells)) {
      if (!columns) continue
      for (const column of Object.keys(columns)) {
        const r = Number(row)
        const c = Number(column)
        const cell = sheet.getCellRaw(r, c)
        if (cell?.f || cell?.si) continue
        if (
          arrays.some(
            (range) =>
              r >= range.startRow &&
              r <= range.endRow &&
              c >= range.startColumn &&
              c <= range.endColumn,
          )
        )
          continue
        delete columns[column]
      }
    }
  }

  function arrayRanges(sheetId: string): IRange[] {
    try {
      const ranges = injector.get(FormulaDataModel).getArrayFormulaRange() as Record<
        string,
        Record<string, Record<string, Record<string, IRange>>>
      >
      return Object.values(ranges[handles.unitId]?.[sheetId] ?? {}).flatMap((columns) =>
        Object.values(columns),
      )
    } catch {
      return []
    }
  }

  /**
   * The user commands that began and have not ended, innermost last. A command
   * ends with its executed event, or never: another listener cancelled it, or
   * its handler threw. Such a command stays listed until an outer one ends, so
   * nothing here may wait for the list to empty: every command settles its own
   * refusal when it ends.
   */
  const openCommands: OpenCommand[] = []

  /** the open commands' marks point into a burst that is gone or was rebuilt */
  function resetMarks(): void {
    for (const open of openCommands) {
      open.mutations = 0
      open.undo = 0
      open.journal = 0
    }
  }

  /** Cancel the mutation about to run; the commands it belongs to are taken back when they end */
  function refuse(message: string): never {
    for (const open of openCommands) open.refused = true
    throw new CustomCommandExecutionError(message)
  }

  /** Take back the part of the burst made since `from`, as if it had not been made */
  function takeBack(from: { mutations: number; undo: number; journal: number }): void {
    if (!burst) return
    const undone = burst.undo.length - from.undo
    const marks = burst.journal.length - from.journal
    applying = true
    try {
      const part = { undo: burst.undo.slice(0, undone), journal: burst.journal.slice(0, marks) }
      if (!revert([part])) fail(new Error('co-editing could not take back an edit it refused'))
    } finally {
      applying = false
    }
    burst.undo = burst.undo.slice(undone)
    burst.journal = burst.journal.slice(marks)
    burst.mutations = burst.mutations.slice(0, from.mutations)
    if (burst.mutations.length === 0) burst = null
    // the command may have left an undo entry for what is no longer there
    if (undone > 0) clearHistory()
  }

  function beforeMutation(info: ICommandInfo, executionOptions?: IExecutionOptions): void {
    if (info.type === CommandType.COMMAND && !applying && !journalSuppression.active) {
      if (BLOCKED_COMMANDS.has(info.id)) {
        options.onBlocked?.(info.id, 'unshared')
        throw new CustomCommandExecutionError(`co-editing refuses ${info.id}`)
      }
      commandRound++
      openCommands.push({
        info,
        mutations: burst?.mutations.length ?? 0,
        undo: burst?.undo.length ?? 0,
        journal: burst?.journal.length ?? 0,
        refused: false,
      })
      if (openCommands.length > MAX_OPEN_COMMANDS) openCommands.shift()
      return
    }
    if (info.type !== CommandType.MUTATION || !ours(info)) return
    if (info.id === REMOVE_SHEET) removedSheets.add(String((info.params as Params).subUnitId))
    if (
      info.id === SET_RANGE_VALUES &&
      (executionOptions as { applyFormulaCalculationResult?: boolean } | undefined)
        ?.applyFormulaCalculationResult
    ) {
      dropStaleResults(info.params as Params)
      return
    }
    const kind = journalSuppression.active ? 'derived' : classify(info.id, executionOptions)
    if (applying) {
      if (info.params !== running && kind !== 'derived') strays.push(info.id)
      return
    }
    if (kind === 'derived') return
    if (kind === 'blocked' || !editable || broken) {
      if (kind === 'blocked') options.onBlocked?.(info.id, 'unshared')
      refuse(`co-editing refuses ${info.id}`)
    }
    const params = { ...(info.params as Params) }
    delete params.trigger
    // two sheets with one name do not survive a save; the replay renames remote clashes, so a
    // local edit that makes one is refused like the app's rename box refuses it
    const named =
      info.id === INSERT_SHEET
        ? {
            name: (params.sheet as { name: string; id: string }).name,
            self: (params.sheet as { id: string }).id,
          }
        : info.id === SET_SHEET_NAME
          ? { name: String(params.name), self: String(params.subUnitId) }
          : null
    if (named && freeName(workbook!, named.name, named.self) !== named.name) {
      options.onBlocked?.(info.id, 'unshared')
      refuse(`co-editing refuses a second sheet named ${named.name}`)
    }
    // every page must hold the sheet: Excel's grid, and merges a span cache can walk
    if (!keepsSheetBounds(workbook!, { id: info.id, params })) {
      options.onBlocked?.(info.id, 'too-large')
      refuse(`co-editing refuses ${info.id} past what a sheet may hold`)
    }
    // A sheet that arrives with content is journaled as an empty new sheet on the other pages
    // (see BLOCKED_COMMANDS). One that was removed earlier is known to every journal: its return
    // (the undo of a removal) only lifts the removal.
    if (
      info.id === INSERT_SHEET &&
      !removedSheets.has(named!.self) &&
      carriesContent(params.sheet)
    ) {
      options.onBlocked?.(info.id, 'unshared')
      refuse('co-editing refuses a new sheet that arrives with content')
    }
    const limit = handles.refusalOf?.({ id: info.id, params: info.params as Params }) ?? null
    if (limit) {
      options.onBlocked?.(info.id, limit)
      refuse(`co-editing refuses ${info.id}: ${limit}`)
    }
    let inverse: Mutation[]
    try {
      inverse = inverseOf(env, { id: info.id, params })
    } catch {
      // an edit the adapter cannot take back would leave this page apart from the others
      options.onBlocked?.(info.id, 'unshared')
      refuse(`co-editing cannot undo ${info.id}`)
    }
    // Univer adds its reference rewrite to the command that moves rows, columns or a sheet's
    // name: one set-range-values of formula text, run right after the structural mutation
    const trigger = (info.params as Params).trigger
    let rewrite = false
    if (info.id === SET_SHEET_NAME || axisChangeOf({ id: info.id, params })) {
      rewriter = typeof trigger === 'string' ? { round: commandRound, trigger } : null
    } else if (
      info.id === SET_RANGE_VALUES &&
      rewriter?.round === commandRound &&
      rewriter.trigger === trigger &&
      restatesFormulas(params.cellValue)
    ) {
      rewrite = true
    }
    inverses.set(info, {
      undo: inverse,
      journal: journalMarkOf({ id: info.id, params: info.params as Params }),
      rewrite,
      work: rebuildWork(workbook!, { id: info.id, params }),
    })
    awaited.push(info.id)
    if (awaited.length > MAX_OPEN_COMMANDS) awaited.shift()
  }

  const before = commands.beforeCommandExecuted(beforeMutation)
  // The inverse must read the state before anything touches it, and other listeners write:
  // sheets-formula's runs a set-range-values of its own before the one it sees.
  const beforeListeners = (commands as unknown as { _beforeCommandExecutionListeners?: unknown[] })
    ._beforeCommandExecutionListeners
  if (!Array.isArray(beforeListeners) || !beforeListeners.includes(beforeMutation)) {
    before.dispose()
    throw new Error('co-editing needs to run first among Univer before-command listeners')
  }
  beforeListeners.splice(beforeListeners.indexOf(beforeMutation), 1)
  beforeListeners.unshift(beforeMutation)

  const after = commands.onMutationExecutedForCollab((info, executionOptions) => {
    const taken = inverses.get(info)
    if (!taken) {
      // Every local mutation the adapter let run is known by its command info object. One that
      // ran, would have been captured, and is not known: Univer handed this listener another
      // object than the before-listener got, and the edit would stay on this page unsaid.
      const result = (executionOptions as { applyFormulaCalculationResult?: boolean } | undefined)
        ?.applyFormulaCalculationResult
      if (
        awaited.includes(info.id) &&
        !applying &&
        !journalSuppression.active &&
        !result &&
        ours(info) &&
        classify(info.id, executionOptions) === 'synced'
      ) {
        fail(new Error(`co-editing lost the command info of ${info.id} between Univer's listeners`))
      }
      return
    }
    inverses.delete(info)
    awaited.splice(awaited.lastIndexOf(info.id), 1)
    const wire = toWire(workbook, { id: info.id, params: info.params as Params })
    if (taken.rewrite) rewrites.add(wire)
    if (undoable) {
      if (info.id !== SET_RANGE_VALUES) undoable = null
      else {
        const sheet = String((info.params as Params).subUnitId)
        const own = undoable.get(sheet) ?? new Set<string>()
        for (const key of cellKeys((info.params as Params).cellValue)) own.add(key)
        undoable.set(sheet, own)
      }
    }
    burst ??= { mutations: [], undo: [], journal: [], work: 0 }
    burst.work += taken.work
    burst.mutations.push(wire)
    burst.undo = taken.undo.concat(burst.undo)
    burst.journal = taken.journal.concat(burst.journal)
    if (options.bursts !== 'manual' && flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 0)
    }
  })

  // A command ended: if one of its mutations was refused, take back the ones that ran
  const ended = commands.onCommandExecuted((info) => {
    if (info.type !== CommandType.COMMAND || applying) return
    let index = openCommands.length - 1
    while (index >= 0 && openCommands[index]!.info !== info) index--
    if (index < 0) return
    // the commands listed after it began inside it and never ended
    const ran = openCommands.splice(index)[0]!
    if (ran.refused) takeBack(ran)
  })

  const encode = (op: SheetOp): Json => {
    if (broken) throw broken
    return { id: op.id, m: op.mutations.map((m) => [m.id, m.params as Json]) }
  }

  function flush(id?: string): boolean {
    if (!burst || !emit || applying || broken) return false
    const op: SheetOp = { id: id ?? randomId(), mutations: burst.mutations }
    // One op travels as one change, and the engine fails the session over a change it cannot
    // send. The person loses this one edit instead, and is told.
    // Nor may it carry what the other pages' decode refuses (collab-wire-check.ts), or make them
    // rebuild merges for longer than an op may
    const invalid = firstInvalid(burst.mutations)
    const tooLarge =
      burst.work > MAX_REBUILD_WORK ||
      new TextEncoder().encode(JSON.stringify(encode(op))).length > maxOpBytes
    if (invalid || tooLarge) {
      if (invalid) console.warn(`[co-editing] ${invalid.message}`)
      const first = burst.mutations[0]!.id
      takeBack({ mutations: 0, undo: 0, journal: 0 })
      resetMarks()
      options.onBlocked?.(first, invalid && !invalid.tooLarge ? 'unshared' : 'too-large')
      return false
    }
    undoOf.set(op, { undo: burst.undo, journal: burst.journal })
    burst = null
    resetMarks()
    emit([op])
    return true
  }

  /** run `mutations` (local form) in order; false when one refused to run */
  function run(mutations: readonly Mutation[]): boolean {
    let ok = true
    const outer = commandStack!.splice(0)
    try {
      for (const mutation of mutations) {
        running = mutation.params
        if (!commands.syncExecuteCommand(mutation.id, mutation.params, FROM_COLLAB)) ok = false
      }
    } finally {
      running = null
      commandStack!.unshift(...outer)
    }
    return ok
  }

  /**
   * Defined names loaded from the file get a random id on every page, so a
   * name another page edits is found here by its name and sheet scope.
   */
  function withLocalNameId(wire: Mutation): Mutation {
    if (wire.id !== SET_DEFINED_NAME && wire.id !== REMOVE_DEFINED_NAME) return wire
    const names = accessor
      .get<{
        getDefinedNameMap(
          unitId: string,
        ): Record<string, { id: string; name: string; localSheetId?: string }> | null
      }>(IDefinedNamesService)
      .getDefinedNameMap(handles.unitId)
    const all = Object.values(names ?? {})
    if (all.some((name) => name.id === wire.params.id)) return wire
    const same = all.find(
      (name) =>
        name.name === wire.params.name &&
        (name.localSheetId ?? '') === ((wire.params.localSheetId as string | undefined) ?? ''),
    )
    return same ? { id: wire.id, params: { ...wire.params, id: same.id } } : wire
  }

  /** run one wire mutation of a local op again; returns its revert, or null when it no longer applies */
  function replayOne(wire: Mutation): Replayed | null {
    if (subUnitsOf(wire).some((id) => !workbook!.getSheetBySheetId(id))) return null
    let fixed = withFreeName(workbook!, wire)
    if (wire.id === INSERT_SHEET) {
      if (workbook!.getSheetBySheetId((wire.params.sheet as { id: string }).id)) return null
    } else if (wire.id === REMOVE_SHEET || (wire.id === SET_SHEET_HIDDEN && wire.params.hidden)) {
      // a workbook keeps one visible sheet; a remote change may have taken the others
      const others = workbook!
        .getSheets()
        .filter((sheet) => sheet.getSheetId() !== wire.params.subUnitId)
      if (!others.some((sheet) => !sheet.isSheetHidden())) return null
    } else if (wire.id === SET_SHEET_ORDER) {
      // the mutation splices by position: the sheet's position now, and a target that still exists
      const order = workbook!.getConfig().sheetOrder
      const fromOrder = order.indexOf(String(wire.params.subUnitId))
      const toOrder = Math.min(Number(wire.params.toOrder), order.length - 1)
      fixed = { id: wire.id, params: { ...wire.params, fromOrder, toOrder } }
    } else if (wire.id === ADD_MERGE) {
      // a merge someone else made first over the same cells wins; overlapping merges are invalid
      const merges = workbook!
        .getSheetBySheetId(String(wire.params.subUnitId))!
        .getConfig().mergeData
      const ranges = (wire.params.ranges as IRange[]).filter(
        (range) => !merges.some((merge) => Rectangle.intersects(merge, range)),
      )
      if (ranges.length === 0) return null
      fixed = { id: wire.id, params: { ...wire.params, ranges } }
    }
    if (!keepsSheetBounds(workbook!, fixed)) return null
    const local = fromWire(workbook!, withLocalNameId(fixed))
    const undo = inverseOf(env, local)
    const journal = journalMarkOf(local)
    // the page would show less than the op it is about to send again
    if (!run([local])) throw new Error(`co-editing could not apply its own ${wire.id} again`)
    return { wire: fixed, undo, journal }
  }

  /** Every formula in the workbook now; a shared-formula cell without text of its own gets its group's */
  function heldFormulas(): HeldFormula[] {
    let model: FormulaDataModel | null = null
    try {
      model = injector.get(FormulaDataModel)
    } catch {
      // no formula engine: cells keep only the text they hold themselves
    }
    const held: HeldFormula[] = []
    for (const sheet of workbook!.getSheets()) {
      const id = sheet.getSheetId()
      sheet.getCellMatrix().forValue((row, column, cell) => {
        const own = typeof cell?.f === 'string' && cell.f !== '' ? cell.f : null
        const shared = typeof cell?.si === 'string' && cell.si !== '' ? cell.si : null
        if (!own && !shared) return
        const formula = own ?? model?.getFormulaStringByCell(row, column, id, handles.unitId)
        if (typeof formula !== 'string' || formula === '') return
        held.push({
          sheet: id,
          row,
          column,
          formula,
          group: shared ? `${id}\u0000${shared}` : null,
        })
      })
    }
    return held
  }

  /**
   * The reference rewrite of the structural mutation `wire`, which just ran
   * again: what Univer adds to the command a person runs, computed for the
   * formulas the workbook held right before it (`held`), so a formula someone
   * else changed meanwhile is rewritten from what it says now. A shared-formula
   * group one of whose cells changes or moves becomes plain formulas, as in
   * Univer's own rewrite: its cells no longer follow one text.
   */
  function rewriteFormulas(held: HeldFormula[], wire: Mutation, oldName: string | undefined) {
    const change = axisChangeOf(wire)
    const changedName = change ? names.nameOf(change.sheet) : undefined
    const moved = held.flatMap((cell) => {
      if (!workbook!.getSheetBySheetId(cell.sheet)) return []
      let { row, column } = cell
      const onChanged = change !== null && cell.sheet === change.sheet
      if (change && onChanged) {
        const index = mapIndex(change, change.axis === 'row' ? row : column)
        if (index === null) return []
        if (change.axis === 'row') row = index
        else column = index
      }
      const next = change
        ? shiftFormula(cell.formula, onChanged, changedName, change)
        : renameInFormula(cell.formula, oldName ?? '', String(wire.params.name))
      return [{ ...cell, row, column, next, onChanged }]
    })
    const plain = new Set<string>()
    for (const cell of moved)
      if (cell.group && (cell.onChanged || cell.next !== cell.formula)) plain.add(cell.group)
    const bySheet = new Map<string, Record<number, Record<number, { f: string; si: null }>>>()
    for (const cell of moved) {
      if (cell.next === cell.formula && !(cell.group && plain.has(cell.group))) continue
      const cells = bySheet.get(cell.sheet) ?? {}
      ;(cells[cell.row] ??= {})[cell.column] = { f: cell.next, si: null }
      bySheet.set(cell.sheet, cells)
    }
    const out: Replayed[] = []
    for (const [subUnitId, cellValue] of bySheet) {
      const replayed = replayOne({ id: SET_RANGE_VALUES, params: { subUnitId, cellValue } })
      if (!replayed) continue
      rewrites.add(replayed.wire)
      out.push(replayed)
    }
    return out
  }

  function replayOp(wires: readonly Mutation[]): Burst {
    const mutations: Mutation[] = []
    let undo: Mutation[] = []
    let journal: JournalRevert[] = []
    let work = 0
    const ran = (replayed: Replayed): void => {
      mutations.push(replayed.wire)
      undo = replayed.undo.concat(undo)
      journal = replayed.journal.concat(journal)
    }
    for (const wire of wires) {
      // what the others hold the op to, on the version it is now sent at
      const cost = rebuildWork(workbook!, wire)
      if (work + cost > MAX_REBUILD_WORK) continue
      work += cost
      const renames = wire.id === SET_SHEET_NAME
      const held = renames || axisChangeOf(wire) ? heldFormulas() : null
      const oldName = renames ? names.nameOf(String(wire.params.subUnitId)) : undefined
      const replayed = replayOne(wire)
      if (!replayed) continue
      ran(replayed)
      if (held) for (const rewrite of rewriteFormulas(held, replayed.wire, oldName)) ran(rewrite)
    }
    return { mutations, undo, journal, work }
  }

  function integrate(remote: SheetOp[], local: SheetOp[]): SheetOp[] {
    if (broken) throw broken
    applying = true
    strays = []
    try {
      const shown = workbook!.getActiveSheet(true)?.getSheetId()
      const open = burst
      // newest first: the edit in progress, then the reported ops from the last one back
      const reverts: Revert[] = open ? [open] : []
      for (const op of [...local].reverse()) {
        const taken = undoOf.get(op)
        if (!taken) throw new Error(`co-editing lost the undo of op ${op.id}`)
        reverts.push(taken)
        undoOf.delete(op)
      }
      if (!revert(reverts)) throw new Error('co-editing could not revert its unconfirmed edits')

      const changes: Change[] = []
      for (const op of remote) {
        let work = 0
        let dropped = 0
        for (const received of op.mutations) {
          // Checks every page makes on the same version of the log, so all of them end alike: a
          // clashing sheet name gets the same free name; a mutation past a sheet's bounds, or
          // past the op's merge rebuilds, runs nowhere. Only a page that skipped its own checks
          // sends either.
          const cost = rebuildWork(workbook!, received)
          if (!keepsSheetBounds(workbook!, received) || work + cost > MAX_REBUILD_WORK) {
            dropped++
            continue
          }
          work += cost
          const mutation = withFreeName(workbook!, received)
          const sheet = String(mutation.params.subUnitId)
          const nameBefore = names.nameOf(sheet)
          const change: AxisChange | null = axisChangeOf(mutation)
          // A confirmed edit that does not run here leaves this page without it for good
          if (!run([fromWire(workbook!, withLocalNameId(mutation))]))
            throw new Error(`co-editing could not apply ${mutation.id}`)
          if (change)
            changes.push(nameBefore === undefined ? change : { ...change, name: nameBefore })
          else if (mutation.id === SET_SHEET_NAME && nameBefore !== undefined)
            changes.push({
              kind: 'rename',
              sheet,
              from: nameBefore,
              to: String(mutation.params.name),
            })
        }
        if (dropped > 0)
          console.warn(`[co-editing] dropped ${dropped} mutations past the bounds of op ${op.id}`)
      }

      // a rewrite belongs to the workbook it was computed on: the replay computes it again
      const queued = local.map((op) => op.mutations.filter((mutation) => !rewrites.has(mutation)))
      if (open) queued.push(open.mutations.filter((mutation) => !rewrites.has(mutation)))
      const rebased = rebaseMutations(queued, changes, names)
      const rebuilt: SheetOp[] = []
      rebased.forEach((wires, index) => {
        const replayed = replayOp(wires)
        if (index < local.length) {
          const op: SheetOp = { id: local[index]!.id, mutations: replayed.mutations }
          undoOf.set(op, { undo: replayed.undo, journal: replayed.journal })
          rebuilt.push(op)
        } else {
          burst = replayed.mutations.length > 0 ? replayed : null
        }
      })
      resetMarks()
      if (remote.length > 0 && !historyFits(remote)) clearHistory()
      if (strays.length > 0) {
        throw new Error(
          `co-editing saw untracked writes while applying a change: ${[...new Set(strays)].join(', ')}`,
        )
      }
      // taking back and putting again a sheet the person just added must not move them off it
      if (
        shown !== undefined &&
        workbook!.getSheetBySheetId(shown) &&
        workbook!.getActiveSheet(true)?.getSheetId() !== shown
      ) {
        commands.syncExecuteCommand('sheet.operation.set-worksheet-active', {
          unitId: handles.unitId,
          subUnitId: shown,
        })
      }
      return rebuilt
    } catch (error) {
      throw fail(error)
    } finally {
      applying = false
    }
  }

  function decodeMutation(json: Json): Mutation {
    if (!Array.isArray(json) || json.length !== 2) throw new Error('not a mutation')
    const [id, params] = json
    if (typeof id !== 'string' || !isSynced(id)) throw new Error(`unknown mutation ${String(id)}`)
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new Error('mutation params must be an object')
    checkWireMutation(id, params)
    return { id, params: params as Params }
  }

  return {
    encode,
    decode(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json))
        throw new Error('not a sheet op')
      const { id, m } = json
      if (typeof id !== 'string' || !Array.isArray(m)) throw new Error('not a sheet op')
      return { id, mutations: m.map(decodeMutation) }
    },
    listen(handler) {
      emit = handler
      return () => {
        if (emit === handler) emit = null
      }
    },
    integrate,
    confirmed(ops) {
      for (const op of ops) undoOf.delete(op)
    },
    fingerprint() {
      if (broken) throw broken
      const text = fingerprintText(workbook, {
        spill: spills(),
        definedNames: () => {
          const map = accessor
            .get<{ getDefinedNameMap(unitId: string): Record<string, never> | null }>(
              IDefinedNamesService,
            )
            .getDefinedNameMap(handles.unitId)
          return Object.values(map ?? {})
        },
      })
      return hashText(text)
    },
    setEditable(value) {
      // the burst in progress belongs to the state a save or a lock freezes
      if (!value) flush()
      editable = value
    },
    produceFile: () => (broken ? Promise.reject(broken) : handles.produceFile()),
    flush,
    dispose() {
      before.dispose()
      after.dispose()
      ended.dispose()
      clearTimeout(flushTimer ?? undefined)
      emit = null
    },
  }

  /** array-formula spill cells, read now; the formula engine may be absent */
  function spills(): ((sheetId: string, row: number, column: number) => boolean) | undefined {
    let data: Record<string, Record<string, Record<number, Record<number, unknown>>>> | undefined
    try {
      data = injector.get(FormulaDataModel).getArrayFormulaCellData() as typeof data
    } catch {
      return undefined
    }
    const unit = data?.[handles.unitId]
    if (!unit) return undefined
    return (sheetId, row, column) => unit[sheetId]?.[row]?.[column] !== undefined
  }
}
