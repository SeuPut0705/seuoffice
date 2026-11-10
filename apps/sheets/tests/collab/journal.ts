/**
 * The app's save journal for the co-editing tests: the real journal functions
 * (renderer/edit-journal.ts) behind one `CommandExecuted` listener that
 * records what App.tsx's listener records for the mutations these tests run.
 */
import { CommandType, type ICommandInfo, type IExecutionOptions, type IRange } from '@univerjs/core'
import {
  AXIS_ATTR_MUTATIONS,
  MERGE_MUTATIONS,
  MOVE_ROWS_MUTATION,
  ROW_COLUMN_MUTATIONS,
  SET_RANGE_VALUES_MUTATION,
  SHEET_LIFECYCLE_MUTATIONS,
} from '../../src/renderer/app-constants'
import {
  type EditJournal,
  recordSetRangeValues,
  recordSheetHidden,
  recordSheetInsert,
  recordSheetOrderChange,
  recordSheetRemove,
  recordSheetRename,
  recordSheetTabColor,
  recordStructuralOp,
  toSaveEdits,
  toSaveSheetOps,
  toSaveStructuralOps,
} from '../../src/renderer/edit-journal'
import { journalSuppression } from '../../src/renderer/univer-state'
import type { OpenedBook } from './sheets-workbook'

type Journaled = {
  unitId?: string
  subUnitId?: string
  cellValue?: unknown
  range?: IRange
  ranges?: IRange[]
  sourceRange?: IRange
  targetRange?: IRange
  name?: string
  hidden?: number | boolean
  color?: unknown
  sheet?: { id: string; name: string }
  rowHeight?: number
}

/** Feed `journal` from every mutation `page` runs, as the app does */
export function feedJournal(
  page: Pick<OpenedBook, 'commands' | 'workbook'>,
  journal: EditJournal,
): void {
  const originalNames = new Map(
    page.workbook.getSheets().map((sheet) => [sheet.getSheetId(), sheet.getName()]),
  )
  page.commands.onCommandExecuted((info: ICommandInfo, options?: IExecutionOptions) => {
    if (journalSuppression.active || info.type !== CommandType.MUTATION) return
    if ((options as { fromFormula?: boolean } | undefined)?.fromFormula) return
    const params = info.params as Journaled | undefined
    if (params?.unitId !== page.workbook.getUnitId()) return
    if (SHEET_LIFECYCLE_MUTATIONS.has(info.id)) {
      const sheetId = params.subUnitId
      if (info.id === 'sheet.mutation.insert-sheet')
        recordSheetInsert(journal, params.sheet!.id, params.sheet!.name)
      else if (info.id === 'sheet.mutation.set-worksheet-order') recordSheetOrderChange(journal)
      else if (!sheetId) return
      else if (info.id === 'sheet.mutation.remove-sheet') recordSheetRemove(journal, sheetId)
      else if (info.id === 'sheet.mutation.set-worksheet-hidden')
        recordSheetHidden(journal, sheetId, params.hidden === true || params.hidden === 1, false)
      else if (info.id === 'sheet.mutation.set-tab-color')
        recordSheetTabColor(journal, sheetId, params.color, undefined)
      else recordSheetRename(journal, sheetId, String(params.name), originalNames.get(sheetId))
      return
    }
    const sheetId = params.subUnitId
    if (!sheetId) return
    const axisAttr = AXIS_ATTR_MUTATIONS[info.id]
    const rowColumn = ROW_COLUMN_MUTATIONS[info.id]
    const merge = MERGE_MUTATIONS[info.id]
    if (axisAttr) {
      for (const range of params.ranges ?? []) {
        const start = axisAttr.axis === 'row' ? range.startRow : range.startColumn
        const end = axisAttr.axis === 'row' ? range.endRow : range.endColumn
        if (axisAttr.kind === 'hidden') {
          recordStructuralOp(journal, sheetId, {
            kind: axisAttr.axis === 'row' ? 'set-rows-hidden' : 'set-cols-hidden',
            start,
            end,
            hidden: axisAttr.hidden === true,
          })
        } else if (axisAttr.kind === 'size' && typeof params.rowHeight === 'number') {
          recordStructuralOp(journal, sheetId, {
            kind: 'set-row-size',
            start,
            end,
            size: params.rowHeight,
          })
        }
      }
    } else if (rowColumn && params.range) {
      const rows = rowColumn.axis === 'row'
      recordStructuralOp(journal, sheetId, {
        kind: rowColumn.kind,
        index: rows ? params.range.startRow : params.range.startColumn,
        count: rows
          ? params.range.endRow - params.range.startRow + 1
          : params.range.endColumn - params.range.startColumn + 1,
      })
    } else if (info.id === MOVE_ROWS_MUTATION && params.sourceRange && params.targetRange) {
      recordStructuralOp(journal, sheetId, {
        kind: 'move-rows',
        index: params.sourceRange.startRow,
        count: params.sourceRange.endRow - params.sourceRange.startRow + 1,
        before: params.targetRange.startRow,
      })
    } else if (merge) {
      for (const range of params.ranges ?? []) {
        recordStructuralOp(journal, sheetId, {
          kind: merge,
          range: {
            startRow: range.startRow,
            endRow: range.endRow,
            startColumn: range.startColumn,
            endColumn: range.endColumn,
          },
        })
      }
    } else if (info.id === SET_RANGE_VALUES_MUTATION) {
      recordSetRangeValues(journal, sheetId, params.cellValue)
    }
  })
}

/** What a save would send from `journal`, in an order two journals of one workbook share */
export function savePayload(journal: EditJournal): {
  edits: unknown[]
  structural: unknown[]
  sheets: unknown[]
} {
  const text = (value: unknown) => JSON.stringify(value)
  return {
    edits: toSaveEdits(journal)
      .map(text)
      .sort()
      .map((edit) => JSON.parse(edit) as unknown),
    structural: toSaveStructuralOps(journal),
    sheets: toSaveSheetOps(journal)
      .map(text)
      .sort()
      .map((op) => JSON.parse(op) as unknown),
  }
}
