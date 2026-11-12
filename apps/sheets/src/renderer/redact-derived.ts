/**
 * The formula cells that show a value computed from a hidden cell.
 *
 * A mark withholds its own cell. `=B2` beside it shows the same value, a
 * `=SUM(B:B)` gives it away, and a formula reading either does so again. The
 * index every reader asks (`redactionIndexOf`) therefore answers "withheld"
 * for those cells too, with the generic `{{private}}` label: such a cell is
 * not the one the person labelled. Both its value and its formula text are
 * withheld, the same as for a marked cell, so no reader needs a second shape
 * of answer. The rule that decides which cells is the workbook gateway's
 * (`formula-reads`), shared with the file reader in `file-parse`.
 *
 * ## Where the formulas come from
 *
 * - **Live formulas**: every cell the grid's model holds a formula for (typed
 *   this session, loaded for the engine, pinned by the closure), and the range
 *   a dynamic array spills into. Their text is current, so they are traced.
 * - **Formulas the session only knows from the file**: a formula cell shown
 *   from its cached value (a function the engine lacks, a streamed workbook
 *   whose formulas stay in the sidecar). Its text is in file coordinates and
 *   its value was computed by another program, so it is not traced: it is
 *   withheld, and so is everything that reads it.
 * - **A sheet whose formula cells are not known** (the list has not arrived,
 *   holds more than the sidecar returns, or the platform has none) is withheld
 *   whole.
 * - **The output of a PivotTable**: plain cells that hold the labels and totals
 *   of the pivot's source range. It is traced like a formula that reads that
 *   range, so it is withheld when the source holds a withheld cell, and what
 *   reads the output is withheld after it. A pivot whose source is not a range
 *   of this workbook the session can name (its definition is not read yet, an
 *   external or OLAP source, a named source) is withheld untraced. These cells
 *   are constants, which matters to a person copying them (`computedFor`).
 *
 * None of this runs, and nothing is withheld, in a workbook without marks.
 *
 * The answer is computed when a reader asks and kept until something changes
 * (any mutation of the workbook, a new mark, a formula list arriving), so a
 * formula typed after the hide and a hide made after the formula are both
 * covered by the next read.
 */
import type { RangeBounds } from '@genoffice/xlsx-gateway/domain/cell-address'
import { columnLabel, parseRange } from '@genoffice/xlsx-gateway/domain/cell-address'
import { offsetFormulaRefs } from '@genoffice/xlsx-gateway/domain/formula-shift'
import {
  areaLookup,
  cellsDerivedFromWithheld,
  type NameDefinition,
  type ReadsSheet,
} from '@genoffice/xlsx-gateway/gateway/formula-reads'
import { CommandType } from '@univerjs/core'
import {
  FormulaDataModel,
  IDefinedNamesService,
  type IArrayFormulaRangeType,
} from '@univerjs/engine-formula'

import type { WorkbookFormulaCellsResult, WorkbookPivotDefinition } from '../shared/desktop-api'
import type { RedactionIndex } from './ai/redact'
import { UNKNOWN_REDACTION_LABEL } from './ai/redact-load'
import { resolveDuplicateSource } from './edit-journal'
import { pivotSourceSheetId } from './pivot-source'
import { SharedFormulaLookup } from './shared-formula-index'
import type { LazyWorkbookState, UniverRuntime } from './univer-state'
import { fileRangeToScreenRange, fileToScreen } from './view-transform'

const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383
const WHOLE_SHEET: RangeBounds = {
  startRow: 0,
  endRow: MAX_ROW,
  startColumn: 0,
  endColumn: MAX_COLUMN,
}

/** The formula cells of one file sheet, in file coordinates. */
interface FileFormulaCells {
  readonly cells: readonly (readonly [row: number, column: number])[]
  /** the range each array formula fills, with its master at the top left */
  readonly arrays: readonly RangeBounds[]
}

export interface DerivedCellsDeps {
  readonly runtime: () => UniverRuntime | null
  readonly state: () => LazyWorkbookState | null
  /**
   * The sidecar's list of one file sheet's formulas, for a workbook that is
   * not fully loaded. Absent on a platform without one: such a workbook's file
   * sheets are then withheld whole.
   */
  readonly readFormulas?:
    ((sessionId: string, sheetId: string) => Promise<WorkbookFormulaCellsResult>) | undefined
}

export interface DerivedCells {
  /** The index readers ask: `marks`, plus the formula cells that compute from them. */
  indexOver(marks: RedactionIndex): RedactionIndex
  /** A formula, a value a formula shows, or the shape of the workbook changed. */
  invalidate(): void
  /** Another workbook was opened: nothing known about the last one applies. */
  reset(): void
}

interface DerivedLookup {
  readonly sheetIds: readonly string[]
  areasOf(sheetId: string): readonly RangeBounds[]
  has(sheetId: string, row: number, column: number): boolean
  /** the withheld areas that hold constants: pivot outputs */
  computedOf(sheetId: string): readonly RangeBounds[]
}

/** Every cell of every sheet: what is answered when the formulas cannot be collected at all. */
const EVERYTHING: DerivedLookup = {
  sheetIds: [],
  areasOf: () => [WHOLE_SHEET],
  has: () => true,
  // No reader hands a cell over in this state, so nothing a person copies can be read either.
  computedOf: () => [],
}

/** One PivotTable's cells on a sheet; `formula` reads its source, null when that is not known. */
interface PivotOutput {
  readonly area: RangeBounds
  readonly formula: string | null
}

const a1Of = (range: RangeBounds): string =>
  `${columnLabel(range.startColumn)}${range.startRow + 1}:${columnLabel(range.endColumn)}${range.endRow + 1}`

const sameArea = (a: RangeBounds, b: RangeBounds): boolean =>
  a.startRow === b.startRow &&
  a.endRow === b.endRow &&
  a.startColumn === b.startColumn &&
  a.endColumn === b.endColumn

/**
 * The pivot outputs of every sheet, by sheet id. Ranges are taken as the rest
 * of the session takes them (the refresh reads the source at these addresses);
 * on a sheet with rows or columns inserted this session the range as it was in
 * the file is counted as well, since the file's output was computed from that.
 * A file pivot names its source sheet as the file did, so that name is looked
 * up among the file's sheets (`pivotSourceSheetId`), never among the names
 * the sheets carry now.
 */
function pivotOutputsOf(
  state: LazyWorkbookState,
  sheetNames: ReadonlyMap<string, string>,
): Map<string, PivotOutput[]> {
  const journal = state.editJournal
  const onScreen = (sheetId: string, range: RangeBounds): RangeBounds[] => {
    const ops = journal.structuralOps.get(sheetId) ?? []
    const moved = ops.length === 0 ? null : fileRangeToScreenRange(ops, range)
    return moved && !sameArea(moved, range) ? [range, moved] : [range]
  }
  const sourceFormula = (sheetId: string | undefined, range: RangeBounds | null): string | null => {
    const name = sheetId === undefined ? undefined : sheetNames.get(sheetId)
    if (name === undefined || range === null) return null
    const sheet = `'${name.replaceAll("'", "''")}'!`
    return `=${onScreen(sheetId!, range)
      .map((part) => sheet + a1Of(part))
      .join('+')}`
  }
  const rangeOf = (ref: string): RangeBounds | null => {
    try {
      return parseRange(ref.replaceAll('$', '').toUpperCase())
    } catch {
      return null
    }
  }
  const out = new Map<string, PivotOutput[]>()
  const add = (sheetId: string, area: RangeBounds, formula: string | null): void => {
    const list = out.get(sheetId) ?? []
    for (const part of onScreen(sheetId, area)) list.push({ area: part, formula })
    out.set(sheetId, list)
  }
  for (const sheet of state.file.sheets) {
    const resolved: RangeBounds[] = []
    for (const pivot of sheet.pivotTables) {
      const definition = state.pivotDefinitions.get(pivot.path)
      const output = rangeOf(definition?.outputRef ?? pivot.outputRef)
      if (output === null) continue // left to `pivotRanges` below
      const formula = definition
        ? sourceFormula(
            pivotSourceSheetId(state, definition.sourceSheet),
            rangeOf(definition.sourceRef),
          )
        : null
      resolved.push(output)
      const relaid =
        pivot.cachePath === null
          ? undefined
          : journal.pivotRefreshUpdates.get(pivot.cachePath)?.relayout?.pageFieldIndices?.length
      add(sheet.id, withReportFilters(output, filterExtent(definition, relaid)), formula)
    }
    // An output area no definition accounts for: what sits above it is not known either.
    for (const range of sheet.pivotRanges) {
      if (!resolved.some((output) => sameArea(output, range))) {
        add(sheet.id, withReportFilters(range, null), null)
      }
    }
  }
  for (const pivot of journal.pivotAdds) {
    add(
      pivot.sheetId,
      withReportFilters(pivot.location, {
        rows: pivot.pageFieldIndices?.length ?? 0,
        columns: 1,
      }),
      sourceFormula(pivot.sourceSheetId, pivot.sourceArea),
    )
  }
  return out
}

/** Rows of report filters above a pivot's output, and filters side by side in a row. */
interface FilterExtent {
  readonly rows: number
  readonly columns: number
}

/**
 * How far the report filters of a file's pivot reach, or null when that cannot be told: its
 * definition was not read, or it has filters and no layout that holds them all. A pivot laid
 * out again in this session (`relaid`: the filters it has now) has one filter per row, as
 * the app writes them; the block the file had is counted with it, since cells of that block
 * may still be on the sheet, and when the file's block is not known nothing is.
 */
function filterExtent(
  definition: WorkbookPivotDefinition | undefined,
  relaid: number | undefined,
): FilterExtent | null {
  if (definition === undefined) return null
  const { pageRows: rows, pageColumns: columns } = definition
  if (rows === undefined || columns === undefined) return null
  if (relaid !== undefined) return { rows: Math.max(relaid, rows), columns: Math.max(1, columns) }
  if (rows * columns < definition.pageFields.length) return null
  return { rows, columns }
}

/**
 * A pivot's output with the report filters above it: per row of filters a label and the
 * chosen item for each filter, a blank column between two filters, then a blank row. With an
 * extent that is not known, every row from the top of the sheet down to the end of the output,
 * in every column: the filters are somewhere above the output, and how wide is not known.
 */
function withReportFilters(output: RangeBounds, extent: FilterExtent | null): RangeBounds {
  if (extent === null) return { ...output, startRow: 0, startColumn: 0, endColumn: MAX_COLUMN }
  if (extent.rows === 0) return output
  return {
    ...output,
    startRow: Math.max(0, output.startRow - extent.rows - 1),
    endColumn: Math.min(
      MAX_COLUMN,
      Math.max(output.endColumn, output.startColumn + Math.max(1, extent.columns) * 3 - 2),
    ),
  }
}

const cellKey = (row: number, column: number): number => row * (MAX_COLUMN + 1) + column
const cellArea = (row: number, column: number): RangeBounds => ({
  startRow: row,
  endRow: row,
  startColumn: column,
  endColumn: column,
})

/** Cells as column runs, so a column of 100,000 formulas is one area and not 100,000. */
function columnRuns(cells: readonly (readonly [number, number])[]): RangeBounds[] {
  const sorted = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const runs: RangeBounds[] = []
  let run: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null =
    null
  for (const [row, column] of sorted) {
    if (run && run.startColumn === column && row <= run.endRow + 1) {
      run.endRow = Math.max(run.endRow, row)
      continue
    }
    run = { ...cellArea(row, column) }
    runs.push(run)
  }
  return runs
}

function fileCellsOfState(state: LazyWorkbookState, fileSheetId: string): FileFormulaCells {
  const cells: [number, number][] = []
  for (const key of state.formulaText.get(fileSheetId)?.keys() ?? []) {
    const [row, column] = key.split(':').map(Number)
    if (row !== undefined && column !== undefined) cells.push([row, column])
  }
  state.sharedFormulaGroups
    .get(fileSheetId)
    ?.forEachFollower((row, column) => cells.push([row, column]))
  const arrays: RangeBounds[] = []
  for (const ref of state.fileArrayRefs.get(fileSheetId)?.values() ?? []) {
    try {
      arrays.push(parseRange(ref))
    } catch {
      // A range that cannot be read fills cells nobody can name.
      arrays.push(WHOLE_SHEET)
    }
  }
  return { cells, arrays }
}

function fileCellsOfIndex(result: WorkbookFormulaCellsResult): FileFormulaCells {
  const cells: [number, number][] = []
  const arrays: RangeBounds[] = []
  for (const cell of result.cells) {
    if (!cell.formula) continue
    cells.push([cell.row, cell.column])
    if (!cell.arrayRef) continue
    try {
      arrays.push(parseRange(cell.arrayRef))
    } catch {
      arrays.push(WHOLE_SHEET)
    }
  }
  new SharedFormulaLookup(result.sharedGroups).forEachFollower((row, column) =>
    cells.push([row, column]),
  )
  return { cells, arrays }
}

const INDEX_RETRY_MS = 400
const INDEX_RETRIES = 450

export function createDerivedCells(deps: DerivedCellsDeps): DerivedCells {
  /** per file sheet id: its formula cells, or why they are not known */
  const fileIndexes = new Map<string, FileFormulaCells | 'loading' | 'unavailable'>()
  let cached: { marks: RedactionIndex; stamp: string; lookup: DerivedLookup } | null = null
  /** bumped by `reset`, so a list read for the last workbook is dropped */
  let generation = 0

  async function loadFileIndex(state: LazyWorkbookState, fileSheetId: string): Promise<void> {
    const started = generation
    const settle = (value: FileFormulaCells | 'unavailable'): void => {
      if (started !== generation || deps.state() !== state) return
      fileIndexes.set(fileSheetId, value)
      cached = null
    }
    if (!deps.readFormulas) return settle('unavailable')
    try {
      for (let attempt = 0; attempt < INDEX_RETRIES; attempt += 1) {
        const result = await deps.readFormulas(state.file.sessionId, fileSheetId)
        if (started !== generation || deps.state() !== state) return
        // More formulas than the sidecar lists: the rest could be anywhere.
        if (result.truncated) return settle('unavailable')
        if (result.indexingComplete) return settle(fileCellsOfIndex(result))
        await new Promise((resolve) => setTimeout(resolve, INDEX_RETRY_MS))
      }
      settle('unavailable')
    } catch {
      settle('unavailable')
    }
  }

  /** The file sheet's formula cells, or null while they are not known. */
  function fileCells(state: LazyWorkbookState, fileSheetId: string): FileFormulaCells | null {
    // A full load has read every cell of every sheet, formulas included.
    if (state.flags.preloadComplete && !state.formulaTextTruncated.has(fileSheetId)) {
      return fileCellsOfState(state, fileSheetId)
    }
    const known = fileIndexes.get(fileSheetId)
    if (known === undefined) {
      fileIndexes.set(fileSheetId, 'loading')
      void loadFileIndex(state, fileSheetId)
      return null
    }
    return typeof known === 'string' ? null : known
  }

  function collect(marks: RedactionIndex): DerivedLookup {
    const runtime = deps.runtime()
    const state = deps.state()
    const workbook = runtime?.univerAPI.getActiveWorkbook()
    if (!runtime || !state || !workbook) return EVERYTHING
    const injector = runtime.univer.__getInjector()
    const unitId = workbook.getId()
    let spills: IArrayFormulaRangeType[string]
    try {
      spills = injector.get(FormulaDataModel).getArrayFormulaRange()?.[unitId]
    } catch {
      // no formula engine in this runtime: nothing spills
    }
    const names: NameDefinition[] = []
    try {
      const defined = injector.get(IDefinedNamesService).getDefinedNameMap(unitId)
      for (const item of Object.values(defined ?? {})) {
        names.push({ name: item.name, formula: item.formulaOrRefString })
      }
    } catch {
      // no names service: a formula that uses a name is withheld
    }
    const fileSheetIds = new Set(state.file.sheets.map((sheet) => sheet.id))
    const journal = state.editJournal
    const pivots = pivotOutputsOf(
      state,
      new Map(workbook.getSheets().map((sheet) => [sheet.getSheetId(), sheet.getSheetName()])),
    )

    const ids: string[] = []
    const sheets: ReadsSheet[] = []
    for (const sheet of workbook.getSheets()) {
      const id = sheet.getSheetId()
      const live = new Map<number, string>()
      const masters = new Map<string, { row: number; column: number; formula: string }>()
      const followers: { row: number; column: number; si: string }[] = []
      const unknownCells: [number, number][] = []
      sheet
        .getSheet()
        .getCellMatrix()
        .forValue((row, column, cell) => {
          const formula = typeof cell?.f === 'string' && cell.f !== '' ? cell.f : null
          const si = typeof cell?.si === 'string' && cell.si !== '' ? cell.si : null
          if (formula !== null) {
            live.set(cellKey(row, column), formula)
            if (si !== null) masters.set(si, { row, column, formula })
          } else if (si !== null) followers.push({ row, column, si })
        })
      for (const follower of followers) {
        const master = masters.get(follower.si)
        if (!master) {
          unknownCells.push([follower.row, follower.column])
          continue
        }
        live.set(
          cellKey(follower.row, follower.column),
          offsetFormulaRefs(
            master.formula,
            follower.row - master.row,
            follower.column - master.column,
          ),
        )
      }
      const formulas: { area: RangeBounds; formula: string }[] = []
      for (const [key, formula] of live) {
        const row = Math.floor(key / (MAX_COLUMN + 1))
        const column = key % (MAX_COLUMN + 1)
        formulas.push({ area: spills?.[id]?.[row]?.[column] ?? cellArea(row, column), formula })
      }
      // A formula typed this session whose row the streaming grid has let go of.
      const journalCells = journal.cells.get(id)
      for (const entry of journalCells?.values() ?? []) {
        if (!entry.hasValue || !entry.formula || live.has(cellKey(entry.row, entry.column)))
          continue
        // Nothing rewrites this text when a sheet is renamed, so a sheet name
        // in it may by now be another sheet's: not traced.
        if (entry.formula.includes('!')) unknownCells.push([entry.row, entry.column])
        else formulas.push({ area: cellArea(entry.row, entry.column), formula: entry.formula })
      }

      const unknown: RangeBounds[] = []
      const fileSheetId = fileSheetIds.has(id) ? id : resolveDuplicateSource(journal, id)
      if (fileSheetId !== undefined && !fileSheetIds.has(fileSheetId)) {
        // neither a file sheet nor one this session made: nothing is known about it
        unknown.push(WHOLE_SHEET)
      } else if (fileSheetId !== undefined) {
        const file = fileCells(state, fileSheetId)
        if (!file) unknown.push(WHOLE_SHEET)
        else {
          const ops = journal.structuralOps.get(id) ?? []
          const isLive = (row: number, column: number): boolean =>
            live.has(cellKey(row, column)) ||
            // overwritten this session: a constant, or a formula listed above
            journalCells?.get(`${row}:${column}`)?.hasValue === true
          for (const [fileRow, fileColumn] of file.cells) {
            const row = fileToScreen(ops, 'row', fileRow)
            const column = fileToScreen(ops, 'column', fileColumn)
            if (row === null || column === null || isLive(row, column)) continue
            unknownCells.push([row, column])
          }
          for (const filled of file.arrays) {
            const row = fileToScreen(ops, 'row', filled.startRow)
            const column = fileToScreen(ops, 'column', filled.startColumn)
            // a master the engine evaluates spills by itself (see `spills`)
            if (row !== null && column !== null && live.has(cellKey(row, column))) continue
            const onScreen = ops.length === 0 ? filled : fileRangeToScreenRange(ops, filled)
            if (onScreen) unknown.push(onScreen)
          }
        }
      }
      unknown.push(...columnRuns(unknownCells))
      for (const pivot of pivots.get(id) ?? []) {
        if (pivot.formula === null) unknown.push(pivot.area)
        else formulas.push({ area: pivot.area, formula: pivot.formula })
      }
      ids.push(id)
      sheets.push({ name: sheet.getSheetName(), marks: marks.marksFor(id), unknown, formulas })
    }

    const traced = cellsDerivedFromWithheld(sheets, names)
    const lookups = new Map(
      ids.map((id, index) => [
        id,
        { areas: traced.bySheet[index]!, has: areaLookup(traced.bySheet[index]!) },
      ]),
    )
    const computed = new Map(
      ids.map((id) => [
        id,
        (pivots.get(id) ?? [])
          .map((pivot) => pivot.area)
          // the whole output is withheld or none of it
          .filter((area) => lookups.get(id)!.has(area.startRow, area.startColumn)),
      ]),
    )
    return {
      sheetIds: ids.filter((id) => (lookups.get(id)?.areas.length ?? 0) > 0),
      areasOf: (sheetId) => lookups.get(sheetId)?.areas ?? [],
      has: (sheetId, row, column) => lookups.get(sheetId)?.has(row, column) ?? false,
      computedOf: (sheetId) => computed.get(sheetId) ?? [],
    }
  }

  function derivedOf(marks: RedactionIndex): DerivedLookup {
    const state = deps.state()
    // What the collection depends on besides mutations (which invalidate):
    // the load state, and the pivot definitions, which are read on demand.
    const stamp =
      `${state?.flags.preloadComplete}:${state?.formulaTextTruncated.size}` +
      `:${state?.pivotDefinitions.size}:${state?.editJournal.pivotAdds.length}`
    if (cached?.marks === marks && cached.stamp === stamp) return cached.lookup
    let lookup: DerivedLookup
    try {
      lookup = collect(marks)
    } catch {
      lookup = EVERYTHING
    }
    cached = { marks, stamp, lookup }
    return lookup
  }

  return {
    indexOver(marks) {
      if (marks.isEmpty) return marks
      return {
        isEmpty: false,
        get sheetIds() {
          return [...new Set([...marks.sheetIds, ...derivedOf(marks).sheetIds])]
        },
        labelAt(sheetId, row, column) {
          return (
            marks.labelAt(sheetId, row, column) ??
            (derivedOf(marks).has(sheetId, row, column) ? UNKNOWN_REDACTION_LABEL : null)
          )
        },
        labelsFor(sheetId) {
          const labels = marks.labelsFor(sheetId)
          return derivedOf(marks).areasOf(sheetId).length === 0
            ? labels
            : [...new Set([...labels, UNKNOWN_REDACTION_LABEL])]
        },
        marksFor: (sheetId) => marks.marksFor(sheetId),
        derivedFor: (sheetId) => derivedOf(marks).areasOf(sheetId),
        computedFor: (sheetId) => derivedOf(marks).computedOf(sheetId),
      }
    },
    invalidate() {
      cached = null
    },
    reset() {
      generation += 1
      fileIndexes.clear()
      cached = null
    },
  }
}

/**
 * Forget the answer whenever the workbook changes. Every mutation counts: a
 * typed formula, a pasted block, a row inserted, a sheet renamed, and the
 * engine's own result writes (they change what a dynamic array spills into).
 */
export function installDerivedCellsInvalidation(
  runtime: UniverRuntime,
  derived: DerivedCells,
): { dispose(): void } {
  return runtime.univerAPI.addEvent(runtime.univerAPI.Event.CommandExecuted, (event) => {
    if (event.type === CommandType.MUTATION) derived.invalidate()
  })
}
