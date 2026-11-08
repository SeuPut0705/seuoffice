import { IUniverInstanceService, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'

import type { UniverRuntime } from '../src/renderer/univer-state'

/** A Univer with the sheets plugin and no workbook yet. */
export function bootEmptyUniver(): UniverRuntime {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  univer.registerPlugin(UniverSheetsPlugin)
  return { univer, univerAPI: FUniver.newAPI(univer) } as unknown as UniverRuntime
}

/** A workbook 'wb' with A1 = 10 and A2 = 20. */
export function bootWorkbook(): UniverRuntime {
  const runtime = bootEmptyUniver()
  runtime.univerAPI.createWorkbook({
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
  runtime.univer.__getInjector().get(IUniverInstanceService).focusUnit('wb')
  return runtime
}

export const cellOf = (runtime: UniverRuntime, address: string): unknown =>
  runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(address).getValue()

export const setCell = (runtime: UniverRuntime, address: string, value: number): void => {
  runtime.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(address).setValue(value)
}
