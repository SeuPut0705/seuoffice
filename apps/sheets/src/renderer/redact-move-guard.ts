/**
 * Stop a person's edit from carrying a hidden value out from under its mark.
 *
 * A privacy mark is a rectangle over an address, and it follows the grid only
 * through the structural journal (whole rows and columns inserted or removed).
 * Everything else that relocates or duplicates a cell leaves the mark behind:
 * a drag, cut and paste, a sort, inserting or deleting cells with a shift,
 * moving rows, the fill handle and Fill Down/Right, copy and paste. The value
 * then sits at an address no mark covers — the in-app AI reads it there at
 * once, and file parsing and search read it from the next save — while the
 * mark goes on hiding whatever took its place.
 *
 * None of these is a move the journal the save replays could carry a mark
 * through: they reach the save as plain cell edits, and a mark moved here
 * would have to be moved back by every undo, redo and partial overlap. So they
 * are refused, the way the AI's own writes are (`ai/redact-guard.ts`), and the
 * person is told to stop hiding the cells first or leave them out.
 *
 * What stays allowed: writing INTO a hidden cell (typing, a fill or a paste
 * that runs over it) — the new value sits under the same mark; pasting only
 * the formatting of a copied hidden cell; and every operation on ranges that
 * hold no hidden cell.
 */
import { IUndoRedoService, type IRange } from '@univerjs/core'
import { SheetsSelectionsService } from '@univerjs/sheets'
import { COPY_TYPE, ISheetClipboardService } from '@univerjs/sheets-ui'

import type { RedactionIndex } from './ai/redact'
import { t } from './i18n/locale'
import { journalSuppression, type UniverRuntime } from './univer-state'

export interface RedactMoveGuardDeps {
  /** the on-screen index: it answers "every cell" while the marks are unknown */
  readonly redactions: () => RedactionIndex
  readonly notify: (message: string) => void
}

type Bounds = Pick<IRange, 'startRow' | 'endRow' | 'startColumn' | 'endColumn'>

/** Cells an operation carries away or copies from; `sheetId` undefined = the active sheet. */
interface CarriedCells {
  readonly sheetId: string | undefined
  readonly range: Bounds
  /**
   * The operation writes the cells' computed values down as constants. A
   * formula that computes from a hidden cell then counts too: left as a
   * formula it stays withheld, frozen it is the hidden value in a plain cell.
   */
  readonly frozen?: true
}

/** Excel's grid limits, for an operation that reaches to the edge of the sheet. */
const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383
export const WHOLE_SHEET: Bounds = {
  startRow: 0,
  endRow: MAX_ROW,
  startColumn: 0,
  endColumn: MAX_COLUMN,
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false
  const { startRow, endRow, startColumn, endColumn } = value as Record<string, unknown>
  return [startRow, endRow, startColumn, endColumn].every((n) => typeof n === 'number')
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Every row from the first to the last of `ranges`, across the whole width. */
function rowBand(ranges: readonly unknown[]): Bounds {
  const known = ranges.filter(isBounds)
  if (known.length === 0) return WHOLE_SHEET
  return {
    startRow: Math.min(...known.map((range) => range.startRow)),
    endRow: Math.max(...known.map((range) => range.endRow)),
    startColumn: 0,
    endColumn: MAX_COLUMN,
  }
}

function columnBand(ranges: readonly unknown[]): Bounds {
  const known = ranges.filter(isBounds)
  if (known.length === 0) return WHOLE_SHEET
  return {
    startRow: 0,
    endRow: MAX_ROW,
    startColumn: Math.min(...known.map((range) => range.startColumn)),
    endColumn: Math.max(...known.map((range) => range.endColumn)),
  }
}

const SHIFT_COMMAND = /^sheet\.command\.(?:insert|delete)-range-move-(left|right|up|down)$/
/// Univer's table rows and columns: inserting or removing one shifts the cells
/// below or beside the table, and the command does not say which.
const TABLE_SHIFT_COMMAND = /^sheet\.command\.table-(?:insert|remove)-(?:row|col|row-at|column-at)$/

/**
 * The cells a person's command would carry away or copy from, or null for a
 * command that does neither. A command that names no range acts on the
 * selection; with nothing to go on the whole sheet is assumed, failing closed.
 */
function cellsCarriedByCommand(
  id: string,
  params: unknown,
  selections: readonly IRange[],
): CarriedCells[] | null {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const sheetId = textOf(p.subUnitId)
  const orSelection = (range: unknown): CarriedCells[] => {
    if (isBounds(range)) return [{ sheetId, range }]
    if (selections.length > 0) return selections.map((selection) => ({ sheetId, range: selection }))
    return [{ sheetId, range: WHOLE_SHEET }]
  }
  switch (id) {
    // A drag. The landing cells count too: a hidden value overwritten by a
    // move could only come back through an undo that moves cells under a mark.
    case 'sheet.command.move-range':
      return [
        {
          sheetId: textOf(p.fromSubUnitId),
          range: isBounds(p.fromRange) ? p.fromRange : WHOLE_SHEET,
        },
        { sheetId: textOf(p.toSubUnitId), range: isBounds(p.toRange) ? p.toRange : WHOLE_SHEET },
      ]
    // Dragged rows or columns swap places with everything between the two ends.
    case 'sheet.command.move-rows':
      return [{ sheetId, range: rowBand([p.fromRange, p.toRange, p.range, ...selections]) }]
    case 'sheet.command.move-cols':
      return [{ sheetId, range: columnBand([p.fromRange, p.toRange, p.range, ...selections]) }]
    // Every sort ends in this command.
    case 'sheet.command.reorder-range':
      return orSelection(p.range)
    // The fill handle, Fill Down/Right/Up/Left: the series is built from the source.
    case 'sheet.command.auto-fill':
      return orSelection(p.sourceRange)
    // Text to Columns writes the parts of each cell's text into the cells to its right.
    case 'sheet.command.split-text-to-columns':
      return orSelection(p.range).map((cells) => ({ ...cells, frozen: true as const }))
    // A merge keeps one value: the first filled cell of the range, moved to its top-left.
    case 'sheet.command.add-worksheet-merge': {
      const merged = Array.isArray(p.selections) ? p.selections.filter(isBounds) : []
      return merged.length > 0 ? merged.map((range) => ({ sheetId, range })) : orSelection(null)
    }
    default: {
      if (TABLE_SHIFT_COMMAND.test(id)) return [{ sheetId, range: WHOLE_SHEET }]
      // Insert/Delete Cells with a shift moves everything from the range to the sheet edge.
      const shift = SHIFT_COMMAND.exec(id)?.[1]
      if (!shift) return null
      return orSelection(p.range).map(({ range }) => ({
        sheetId,
        range:
          shift === 'left' || shift === 'right'
            ? { ...range, endColumn: MAX_COLUMN }
            : { ...range, endRow: MAX_ROW },
      }))
    }
  }
}

/** The same question about one mutation of an undo or redo step. */
function cellsCarriedByMutation(id: string, params: unknown): CarriedCells[] {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const sheetId = textOf(p.subUnitId)
  switch (id) {
    case 'sheet.mutation.move-range': {
      const from = p.from as { subUnitId?: unknown } | undefined
      const to = p.to as { subUnitId?: unknown } | undefined
      return [
        {
          sheetId: textOf(from?.subUnitId),
          range: isBounds(p.fromRange) ? p.fromRange : WHOLE_SHEET,
        },
        { sheetId: textOf(to?.subUnitId), range: isBounds(p.toRange) ? p.toRange : WHOLE_SHEET },
      ]
    }
    case 'sheet.mutation.reorder-range':
      return [{ sheetId, range: isBounds(p.range) ? p.range : WHOLE_SHEET }]
    case 'sheet.mutation.move-rows':
      return [{ sheetId, range: rowBand([p.sourceRange, p.targetRange]) }]
    case 'sheet.mutation.move-columns':
      return [{ sheetId, range: columnBand([p.sourceRange, p.targetRange]) }]
    default:
      return []
  }
}

function holdsHidden(
  index: RedactionIndex,
  cells: readonly CarriedCells[],
  activeSheetId: string | undefined,
): boolean {
  const reaches = (range: Bounds) => (area: Bounds) =>
    area.startRow <= range.endRow &&
    area.endRow >= range.startRow &&
    area.startColumn <= range.endColumn &&
    area.endColumn >= range.startColumn
  return cells.some(({ sheetId, range, frozen }) => {
    const target = sheetId ?? activeSheetId
    if (target === undefined) return false
    return (
      index.marksFor(target).some(reaches(range)) ||
      (frozen === true && (index.derivedFor?.(target) ?? []).some(reaches(range)))
    )
  })
}

/// The guard of each running editor, for the tools that are not commands.
const INSTALLED = new WeakMap<object, RedactMoveGuardDeps>()

/**
 * Whether `ranges` of a sheet hold a cell withheld from AI: a hidden cell, or
 * a formula that computes from one.
 *
 * For the editor's own tools, which read cells and write what they read, or
 * something worked out from it, into other cells (remove duplicates, flash
 * fill, subtotal labels, a pivot table, ...). They run no command that names
 * a source, so each asks here before it reads. They all write constants,
 * hence formulas count.
 */
export function holdsHiddenCells(
  runtime: UniverRuntime,
  sheetId: string,
  ranges: readonly Bounds[],
): boolean {
  const deps = INSTALLED.get(runtime.univer)
  if (deps === undefined) return false
  const index = deps.redactions()
  if (index.isEmpty) return false
  return holdsHidden(
    index,
    ranges.map((range) => ({ sheetId, range, frozen: true as const })),
    undefined,
  )
}

/** `holdsHiddenCells`, telling the person when it does. True = the tool must not run. */
export function refuseHiddenSource(
  runtime: UniverRuntime,
  sheetId: string,
  ranges: readonly Bounds[],
): boolean {
  if (!holdsHiddenCells(runtime, sheetId, ranges)) return false
  INSTALLED.get(runtime.univer)?.notify(t('redactMoveRefused'))
  return true
}

/**
 * Refuse the commands that would move or copy a hidden cell.
 *
 * Undo and redo are checked by the step they are about to replay: an edit made
 * while a range held no hidden cell (so it was allowed) moves a cell the
 * person hid afterwards when it is undone. Univer announces those two on
 * events of their own, not as commands.
 */
export function installRedactMoveGuard(
  runtime: UniverRuntime,
  deps: RedactMoveGuardDeps,
): { dispose(): void } {
  const injector = runtime.univer.__getInjector()
  const { univerAPI } = runtime
  const refuseIfHidden = (
    event: { cancel?: boolean },
    carried: () => CarriedCells[] | null,
  ): void => {
    if (journalSuppression.active || event.cancel) return
    const index = deps.redactions()
    if (index.isEmpty) return
    const cells = carried()
    if (cells === null || cells.length === 0) return
    const activeSheetId = univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheetId()
    if (!holdsHidden(index, cells, activeSheetId)) return
    event.cancel = true
    deps.notify(t('redactMoveRefused'))
  }
  const history = injector.get(IUndoRedoService)
  const disposables = [
    univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) =>
      refuseIfHidden(event, () =>
        cellsCarriedByCommand(
          event.id,
          event.params,
          injector
            .get(SheetsSelectionsService)
            .getCurrentSelections()
            .map((selection) => selection.range),
        ),
      ),
    ),
    univerAPI.addEvent(univerAPI.Event.BeforeUndo, (event) =>
      refuseIfHidden(event, () =>
        (history.pitchTopUndoElement()?.undoMutations ?? []).flatMap((mutation) =>
          cellsCarriedByMutation(mutation.id, mutation.params),
        ),
      ),
    ),
    univerAPI.addEvent(univerAPI.Event.BeforeRedo, (event) =>
      refuseIfHidden(event, () =>
        (history.pitchTopRedoElement()?.redoMutations ?? []).flatMap((mutation) =>
          cellsCarriedByMutation(mutation.id, mutation.params),
        ),
      ),
    ),
  ]
  INSTALLED.set(runtime.univer, deps)
  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose()
      INSTALLED.delete(runtime.univer)
    },
  }
}

/**
 * Whether the cells a copy or cut took hold a hidden one. With `dependents`
 * a formula that computes from a hidden cell counts too: its value says what
 * the hidden cell holds, which matters once the copy leaves this workbook.
 */
export function pasteSourceHoldsHidden(
  index: RedactionIndex,
  source: { subUnitId: string; rows: readonly number[]; cols: readonly number[] },
  dependents = false,
): boolean {
  const within = (area: Bounds): boolean =>
    source.rows.some((row) => row >= area.startRow && row <= area.endRow) &&
    source.cols.some((column) => column >= area.startColumn && column <= area.endColumn)
  return (
    index.marksFor(source.subUnitId).some(within) ||
    (dependents && (index.derivedFor?.(source.subUnitId) ?? []).some(within))
  )
}

/** The slice of Univer's clipboard service a paste from this workbook goes through. */
export interface InternalPasteService {
  _pasteInternal: (copyId: string, pasteType: unknown) => Promise<unknown>
  _copyContentCache?: {
    get(id: string):
      | {
          subUnitId?: string
          range?: { rows: readonly number[]; cols: readonly number[] }
          copyType?: unknown
        }
      | undefined
  }
}

/** Paste kinds that put no value down: formatting and column widths. */
export const VALUE_FREE_PASTES: ReadonlySet<unknown> = new Set([
  'special-paste-format',
  'special-paste-col-width',
])

/**
 * Refuse pasting what was copied or cut from hidden cells of this workbook.
 *
 * A cut-paste is a move; a copy-paste makes a second place that holds the
 * value with no mark on it. Both are judged where the paste runs, against the
 * marks as they are then, so a cell hidden after it was copied is covered and
 * the copy itself stays free: the person may paste their own data into another
 * program.
 *
 * Paste Values writes computed values down, so there a formula that computes
 * from a hidden cell counts as well; any other paste carries it as a formula,
 * which stays withheld where it lands.
 */
export function guardInternalPaste(
  service: InternalPasteService,
  deps: RedactMoveGuardDeps,
): { dispose(): void } {
  const previous = service._pasteInternal
  const guarded = async (copyId: string, pasteType: unknown): Promise<unknown> => {
    const copied = service._copyContentCache?.get(copyId)
    if (
      copied?.subUnitId !== undefined &&
      copied.range !== undefined &&
      (copied.copyType === COPY_TYPE.CUT || !VALUE_FREE_PASTES.has(pasteType)) &&
      pasteSourceHoldsHidden(
        deps.redactions(),
        { subUnitId: copied.subUnitId, rows: copied.range.rows, cols: copied.range.cols },
        pasteType === 'special-paste-value',
      )
    ) {
      deps.notify(t('redactMoveRefused'))
      return false
    }
    return previous.call(service, copyId, pasteType)
  }
  service._pasteInternal = guarded
  return {
    dispose() {
      if (service._pasteInternal === guarded) service._pasteInternal = previous
    },
  }
}

/** Guard the pastes of the running editor (keyboard, ribbon and context-menu paste alike). */
export function installRedactPasteGuard(
  runtime: UniverRuntime,
  deps: RedactMoveGuardDeps,
): { dispose(): void } {
  return guardInternalPaste(
    runtime.univer.__getInjector().get(ISheetClipboardService) as unknown as InternalPasteService,
    deps,
  )
}
