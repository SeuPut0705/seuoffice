/**
 * Real Univer workbooks for the co-editing tests: the sheets model, the
 * formula engine and its reference rewrites, no canvas. A "file" is the JSON
 * of a workbook snapshot, so reopening a produced file is a real round trip
 * through Univer's own snapshot.
 */
import {
  CommandType,
  ICommandService,
  type IWorkbookData,
  LocaleService,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
  type Workbook,
} from '@univerjs/core'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import type { SimulatedEditor } from '@seuoffice/collab/conformance'
import type { EditJournal } from '../../src/renderer/edit-journal'
import {
  type SheetOp,
  type SheetsCollabAdapter,
  type SheetsCollabOptions,
  sheetsCollabAdapter,
} from '../../src/web/collab-adapter'
import { journalMark } from '../../src/web/collab-journal'
import { feedJournal } from './journal'

export const UNIT = 'collab-book'
export const FORMAT = { name: 'xlsx', schema: 1 }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function workbookData(cells: Record<number, Record<number, unknown>> = {}): IWorkbookData {
  return {
    id: UNIT,
    name: 'book',
    appVersion: '',
    locale: LocaleType.EN_US,
    styles: { bold: { bl: 1 } },
    sheetOrder: ['s1', 's2'],
    sheets: {
      s1: { id: 's1', name: 'Sheet1', rowCount: 40, columnCount: 12, cellData: cells as never },
      s2: {
        id: 's2',
        name: 'Data',
        rowCount: 40,
        columnCount: 12,
        cellData: { 0: { 0: { v: 'data' } } },
      },
    },
  } as IWorkbookData
}

export function fileOf(data: IWorkbookData): Uint8Array {
  return encoder.encode(JSON.stringify(data))
}

/** Test commands for edits whose Univer commands live in the UI plugins */
const MOVE_ROWS_COMMAND = {
  id: 'test.command.move-rows',
  type: CommandType.COMMAND,
  handler: (
    accessor: { get(id: unknown): unknown },
    params: { unitId: string; subUnitId: string; from: number; count: number; to: number },
  ) => {
    const commands = accessor.get(ICommandService) as ICommandService
    return commands.syncExecuteCommand('sheet.mutation.move-rows', {
      unitId: params.unitId,
      subUnitId: params.subUnitId,
      sourceRange: {
        startRow: params.from,
        endRow: params.from + params.count - 1,
        startColumn: 0,
        endColumn: 11,
        rangeType: 1,
      },
      targetRange: {
        startRow: params.to,
        endRow: params.to + params.count - 1,
        startColumn: 0,
        endColumn: 11,
        rangeType: 1,
      },
    })
  },
}

export interface OpenedBook {
  readonly univer: Univer
  readonly workbook: Workbook
  readonly commands: ICommandService
  readonly adapter: SheetsCollabAdapter
  /** run a command and report its mutations as one op tagged `id`; false when it changed nothing */
  edit(id: string, commandId: string, params: object): boolean
  /** the reported ops, in order */
  readonly emitted: SheetOp[]
  /** with COLLAB_TRACE set: every mutation that ran, with its options */
  readonly trace: string[]
  snapshot(): IWorkbookData
  dispose(): void
}

const opened = new Set<OpenedBook>()

/** Dispose every workbook a test opened */
export function disposeAll(): void {
  for (const book of opened) book.dispose()
  opened.clear()
}

/** `journal`: a save journal to feed from this workbook's mutations, as the app does */
export function openBook(
  bytes: Uint8Array,
  options: SheetsCollabOptions = {},
  journal?: EditJournal,
): OpenedBook {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)
  const data = JSON.parse(decoder.decode(bytes)) as IWorkbookData
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, data)
  const injector = univer.__getInjector()
  const commands = injector.get(ICommandService)
  // sheets-formula arms a one-second progress timer per calculation and never clears it; firing
  // after dispose it asks the disposed locale service for a label, which throws
  const locale = injector.get(LocaleService)
  const translate = locale.t.bind(locale)
  locale.t = (key: string, ...args: string[]) => {
    try {
      return translate(key, ...args)
    } catch {
      return key
    }
  }
  commands.registerCommand(MOVE_ROWS_COMMAND as never)
  const trace: string[] = []
  if (process.env.COLLAB_TRACE) {
    commands.onCommandExecuted((info, executionOptions) => {
      if (
        info.type === CommandType.MUTATION &&
        !info.id.startsWith('formula.mutation.set-formula-calculation')
      )
        trace.push(
          `${info.id} ${JSON.stringify(executionOptions ?? {})} ${JSON.stringify(info.params).slice(0, 400)}`,
        )
    })
  }
  if (journal) feedJournal({ commands, workbook }, journal)
  const adapter = sheetsCollabAdapter(
    {
      univer,
      unitId: workbook.getUnitId(),
      produceFile: async () => ({ fileName: 'book.json', bytes: fileOf(workbook.save()) }),
      ...(journal ? { journalMark: (mutation) => journalMark(journal, mutation) } : {}),
    },
    { bursts: 'manual', ...options },
  )
  const emitted: SheetOp[] = []
  adapter.listen((ops) => emitted.push(...ops))
  const book: OpenedBook = {
    univer,
    workbook,
    commands,
    adapter,
    emitted,
    trace,
    edit(id, commandId, params) {
      void commands.executeCommand(commandId, { unitId: workbook.getUnitId(), ...params })
      return adapter.flush(id)
    },
    snapshot: () => JSON.parse(JSON.stringify(workbook.save())) as IWorkbookData,
    dispose() {
      adapter.dispose()
      univer.dispose()
    },
  }
  opened.add(book)
  return book
}

/** The simulated editor `simulate` drives: one real workbook per client */
export function simulatedBook(
  bytes: Uint8Array,
  randomEdit: (book: OpenedBook, random: () => number, id: string) => boolean,
): SimulatedEditor<SheetOp> {
  const book = openBook(bytes)
  let editable = true
  const adapter = book.adapter
  return {
    encode: adapter.encode,
    decode: adapter.decode,
    listen: (emit) => adapter.listen(emit),
    integrate: adapter.integrate,
    confirmed: adapter.confirmed,
    fingerprint: adapter.fingerprint,
    setEditable(value) {
      editable = value
      adapter.setEditable(value)
    },
    produceFile: adapter.produceFile,
    edit(random, id) {
      if (!editable) return false
      return randomEdit(book, random, id)
    },
    opKey(json) {
      return adapter.decode(json).id
    },
  }
}
