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
 *
 * Every mutation the adapter runs goes through `ICommandService` with
 * `fromCollab`, so the app's save journal (a `CommandExecuted` listener)
 * records remote and replayed mutations like local ones. The mutations that
 * revert an edit are recorded too, but they are not edits, so the adapter
 * puts the journal back to its mark from before the edit (collab-journal.ts):
 * the journal then holds the log in server order, as on every other page.
 * Mutations that cannot be undone exactly are cancelled before they run.
 */
import type { CollabAdapter, Json } from '@seuoffice/collab/client'
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
  INSERT_SHEET,
  inverseOf,
  isSynced,
  MOVE_RANGE,
  type Mutation,
  type MutationEnv,
  type Params,
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
  mapIndex,
  rebaseMutations,
  shiftFormula,
  type SheetNames,
} from './collab-rebase'

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
}

export interface SheetsCollabAdapter extends CollabAdapter<SheetOp> {
  confirmed(ops: SheetOp[]): void
  /** report the mutations of the current burst now, as one op tagged `id` */
  flush(id?: string): boolean
  dispose(): void
}

export interface SheetsCollabOptions {
  /** 'manual': ops are reported only by `flush` (tests drive bursts themselves) */
  readonly bursts?: 'macrotask' | 'manual'
  /** a local edit co-editing cannot carry was cancelled */
  readonly onBlocked?: (mutationId: string) => void
}

/** What takes local mutations back: `undo` runs in order, then `journal` in order (newest mark first) */
interface Revert {
  undo: Mutation[]
  journal: JournalRevert[]
}

interface Burst extends Revert {
  mutations: Mutation[]
}

/** One local mutation as it ran again (wire form), with what takes it back */
interface Replayed extends Revert {
  wire: Mutation
}

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

/** `name`, or the first `name (n)` no other sheet uses; sheet names compare without case */
function freeName(workbook: Workbook, name: string, self: string): string {
  const taken = new Set(
    workbook
      .getSheets()
      .filter((sheet) => sheet.getSheetId() !== self)
      .map((sheet) => sheet.getName().toLowerCase()),
  )
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
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

  let emit: ((ops: SheetOp[]) => void) | null = null
  let editable = true
  let burst: Burst | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  /** set while integrate runs mutations; anything else that writes then is a stray */
  let applying = false
  let running: Params | null = null
  let strays: string[] = []
  /** every sheet a mutation removed on this page, local or remote: all journals know these ids */
  const removedSheets = new Set<string>()
  /** the revert computed before a captured mutation ran, by its command info */
  const inverses = new WeakMap<ICommandInfo, Revert>()
  /** the revert of every reported op the server has not confirmed */
  const undoOf = new WeakMap<SheetOp, Revert>()

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
   * Where the outermost user command started in the burst, and whether one of
   * its mutations was refused; a refused command is taken back whole.
   */
  let command: { mutations: number; undo: number; journal: number; refused: boolean } | null = null
  let depth = 0

  function beforeMutation(info: ICommandInfo, executionOptions?: IExecutionOptions): void {
    if (info.type === CommandType.COMMAND && !applying && !journalSuppression.active) {
      if (BLOCKED_COMMANDS.has(info.id)) {
        options.onBlocked?.(info.id)
        throw new CustomCommandExecutionError(`co-editing refuses ${info.id}`)
      }
      if (depth++ === 0) {
        command = {
          mutations: burst?.mutations.length ?? 0,
          undo: burst?.undo.length ?? 0,
          journal: burst?.journal.length ?? 0,
          refused: false,
        }
      }
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
    if (kind === 'blocked' || !editable) {
      if (kind === 'blocked') options.onBlocked?.(info.id)
      if (command) command.refused = true
      throw new CustomCommandExecutionError(`co-editing refuses ${info.id}`)
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
      options.onBlocked?.(info.id)
      if (command) command.refused = true
      throw new CustomCommandExecutionError(`co-editing refuses a second sheet named ${named.name}`)
    }
    // A sheet that arrives with content is journaled as an empty new sheet on the other pages
    // (see BLOCKED_COMMANDS). One that was removed earlier is known to every journal: its return
    // (the undo of a removal) only lifts the removal.
    if (
      info.id === INSERT_SHEET &&
      !removedSheets.has(named!.self) &&
      carriesContent(params.sheet)
    ) {
      options.onBlocked?.(info.id)
      if (command) command.refused = true
      throw new CustomCommandExecutionError(
        'co-editing refuses a new sheet that arrives with content',
      )
    }
    let inverse: Mutation[]
    try {
      inverse = inverseOf(env, { id: info.id, params })
    } catch {
      // an edit the adapter cannot take back would leave this page apart from the others
      options.onBlocked?.(info.id)
      if (command) command.refused = true
      throw new CustomCommandExecutionError(`co-editing cannot undo ${info.id}`)
    }
    inverses.set(info, {
      undo: inverse,
      journal: journalMarkOf({ id: info.id, params: info.params as Params }),
    })
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

  const after = commands.onMutationExecutedForCollab((info) => {
    const taken = inverses.get(info)
    if (!taken) return
    inverses.delete(info)
    burst ??= { mutations: [], undo: [], journal: [] }
    burst.mutations.push(toWire(workbook, { id: info.id, params: info.params as Params }))
    burst.undo = taken.undo.concat(burst.undo)
    burst.journal = taken.journal.concat(burst.journal)
    if (options.bursts !== 'manual' && flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 0)
    }
  })

  // The outermost command ended: if one of its mutations was refused, take back the ones that ran
  const ended = commands.onCommandExecuted((info) => {
    if (info.type !== CommandType.COMMAND || applying || depth === 0 || --depth > 0) return
    const ran = command
    command = null
    if (!ran?.refused || !burst) return
    const undone = burst.undo.length - ran.undo
    const marks = burst.journal.length - ran.journal
    applying = true
    try {
      revert([{ undo: burst.undo.slice(0, undone), journal: burst.journal.slice(0, marks) }])
    } finally {
      applying = false
    }
    burst.undo = burst.undo.slice(undone)
    burst.journal = burst.journal.slice(marks)
    burst.mutations = burst.mutations.slice(0, ran.mutations)
    if (burst.mutations.length === 0) burst = null
  })

  function flush(id?: string): boolean {
    if (!burst || !emit || applying) return false
    const op: SheetOp = { id: id ?? randomId(), mutations: burst.mutations }
    undoOf.set(op, { undo: burst.undo, journal: burst.journal })
    burst = null
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
    let fixed = wire
    if (wire.id === INSERT_SHEET) {
      const sheet = wire.params.sheet as { id: string; name: string }
      const name = freeName(workbook!, sheet.name, sheet.id)
      if (name !== sheet.name)
        fixed = { id: wire.id, params: { ...wire.params, sheet: { ...sheet, name } } }
      if (workbook!.getSheetBySheetId(sheet.id)) return null
    } else if (wire.id === SET_SHEET_NAME) {
      const name = freeName(workbook!, String(wire.params.name), String(wire.params.subUnitId))
      if (name !== wire.params.name) fixed = { id: wire.id, params: { ...wire.params, name } }
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
    const local = fromWire(workbook!, withLocalNameId(fixed))
    const undo = inverseOf(env, local)
    const journal = journalMarkOf(local)
    run([local])
    return { wire: fixed, undo, journal }
  }

  /**
   * Formulas the remote ops wrote, by position after them. A local insert or
   * remove replayed after them was made without knowing these formulas, so
   * their references are moved here, as Univer's own reference rewrite would
   * have done had they existed when the person inserted.
   */
  type Tracked = { sheet: string; row: number; column: number }

  function track(tracked: Tracked[], mutation: Mutation): Tracked[] {
    const change = axisChangeOf(mutation)
    let out = change ? moveTracked(tracked, change) : tracked
    if (mutation.id === REMOVE_SHEET)
      out = out.filter((cell) => cell.sheet !== mutation.params.subUnitId)
    if (mutation.id === SET_RANGE_VALUES) {
      const sheet = String(mutation.params.subUnitId)
      const cells = (mutation.params.cellValue ?? {}) as Record<
        string,
        Record<string, { f?: unknown } | null>
      >
      for (const [row, columns] of Object.entries(cells))
        for (const [column, cell] of Object.entries(columns ?? {}))
          if (typeof cell?.f === 'string')
            out.push({ sheet, row: Number(row), column: Number(column) })
    }
    return out
  }

  function moveTracked(tracked: Tracked[], change: AxisChange): Tracked[] {
    return tracked.flatMap((cell) => {
      if (cell.sheet !== change.sheet) return [cell]
      const index = mapIndex(change, change.axis === 'row' ? cell.row : cell.column)
      if (index === null) return []
      return [change.axis === 'row' ? { ...cell, row: index } : { ...cell, column: index }]
    })
  }

  function fixTrackedFormulas(tracked: Tracked[], change: AxisChange): Replayed[] {
    const changedName = workbook!.getSheetBySheetId(change.sheet)?.getName()
    if (changedName === undefined) return []
    const out: Replayed[] = []
    for (const cell of tracked) {
      const sheet = workbook!.getSheetBySheetId(cell.sheet)
      const f = sheet?.getCellRaw(cell.row, cell.column)?.f
      if (!sheet || typeof f !== 'string') continue
      const shifted = shiftFormula(f, sheet.getName(), changedName, change)
      if (shifted === f) continue
      const fix: Mutation = {
        id: SET_RANGE_VALUES,
        params: {
          subUnitId: cell.sheet,
          cellValue: { [cell.row]: { [cell.column]: { f: shifted } } },
        },
      }
      const replayed = replayOne(fix)
      if (replayed) out.push(replayed)
    }
    return out
  }

  function replayOp(
    wires: readonly Mutation[],
    tracked: Tracked[],
  ): Burst & { tracked: Tracked[] } {
    const mutations: Mutation[] = []
    let undo: Mutation[] = []
    let journal: JournalRevert[] = []
    const ran = (replayed: Replayed): void => {
      mutations.push(replayed.wire)
      undo = replayed.undo.concat(undo)
      journal = replayed.journal.concat(journal)
    }
    for (const wire of wires) {
      const replayed = replayOne(wire)
      if (!replayed) continue
      ran(replayed)
      const change = axisChangeOf(replayed.wire)
      if (!change) continue
      tracked = moveTracked(tracked, change)
      for (const fix of fixTrackedFormulas(tracked, change)) ran(fix)
    }
    return { mutations, undo, journal, tracked }
  }

  function integrate(remote: SheetOp[], local: SheetOp[]): SheetOp[] {
    applying = true
    strays = []
    try {
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

      const changes: AxisChange[] = []
      let tracked: Tracked[] = []
      let reshaped = false
      for (const op of remote)
        for (const mutation of op.mutations) {
          run([fromWire(workbook!, withLocalNameId(mutation))])
          const change = axisChangeOf(mutation)
          if (change) changes.push(change)
          if (change || mutation.id === INSERT_SHEET || mutation.id === REMOVE_SHEET)
            reshaped = true
          tracked = track(tracked, mutation)
        }

      const queued = local.map((op) => op.mutations)
      if (open) queued.push(open.mutations)
      const rebased = rebaseMutations(queued, changes, names)
      const rebuilt: SheetOp[] = []
      rebased.forEach((wires, index) => {
        const replayed = replayOp(wires, tracked)
        tracked = replayed.tracked
        if (index < local.length) {
          const op: SheetOp = { id: local[index]!.id, mutations: replayed.mutations }
          undoOf.set(op, { undo: replayed.undo, journal: replayed.journal })
          rebuilt.push(op)
        } else {
          burst = { mutations: replayed.mutations, undo: replayed.undo, journal: replayed.journal }
        }
      })
      if (reshaped) {
        // Univer's undo entries hold coordinates and sheets from before the remote change
        injector.get(IUndoRedoService).clearUndoRedo(handles.unitId)
      }
      if (strays.length > 0) {
        throw new Error(
          `co-editing saw untracked writes while applying a change: ${[...new Set(strays)].join(', ')}`,
        )
      }
      return rebuilt
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
    return { id, params: params as Params }
  }

  return {
    encode: (op) => ({ id: op.id, m: op.mutations.map((m) => [m.id, m.params as Json]) }),
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
    produceFile: () => handles.produceFile(),
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
