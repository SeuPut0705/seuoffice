/**
 * A formula that computes from a hidden cell is hidden from AI too.
 *
 * The grid here is a real Univer workbook with its formula engine, the index
 * is the one the app builds for a session (the marks, then the formula cells
 * that depend on them), and what the AI would read is asked through the real
 * read tools: `readCells`, `findWorkbookCells`, `aggregateWorkbookRange`.
 */
import {
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { IDefinedNamesService, UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SheetRedactionState } from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'

import { aggregateWorkbookRange } from '../src/renderer/ai/aggregate-range'
import { loadedRedactions } from '../src/renderer/ai/redact-load'
import { readCells, type WorkbookReadContext } from '../src/renderer/ai/workbook-readers'
import { findWorkbookCells } from '../src/renderer/ai/workbook-search'
import { redactGuardForOps } from '../src/renderer/ai/redact-guard'
import { redactionIndexOf } from '../src/renderer/ai/redact-load'
import { createEditJournal, recordSetRangeValues } from '../src/renderer/edit-journal'
import {
  createDerivedCells,
  installDerivedCellsInvalidation,
  type DerivedCellsDeps,
} from '../src/renderer/redact-derived'
import { sessionRedactionIndex } from '../src/renderer/redact-session'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import type { WorkbookFormulaCellsResult } from '../src/shared/desktop-api'

const SECRET = '13800138000'
const PRIVATE = '{{private}}'
const FILE_SHEETS = [
  { id: 's1', name: 'Data' },
  { id: 's2', name: 'Report' },
]
/** B2 of Data is hidden. */
const HIDDEN_B2: SheetRedactionState[] = [
  {
    sheetName: 'Data',
    marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
  },
]

type Cells = Record<string, { v?: string | number; f?: string; si?: string }>

function matrix(cells: Cells): Record<number, Record<number, object>> {
  const out: Record<number, Record<number, object>> = {}
  for (const [address, cell] of Object.entries(cells)) {
    const column = address.charCodeAt(0) - 65
    const row = Number(address.slice(1)) - 1
    out[row] = { ...out[row], [column]: cell }
  }
  return out
}

let univer: Univer | null = null
afterEach(() => {
  univer?.dispose()
  univer = null
})

interface Session {
  /** what the AI's read tool answers for one cell */
  read(sheetId: string, address: string): unknown
  readonly ctx: WorkbookReadContext
  readonly state: LazyWorkbookState
  readonly runtime: UniverRuntime
  /** install new marks, as hiding or showing a cell does */
  mark(states: readonly SheetRedactionState[]): void
  defineName(name: string, formula: string): void
}

function open(
  data: Cells,
  report: Cells = {},
  options: {
    /** the workbook is streamed: the grid holds only what was loaded */
    streamed?: boolean
    readFormulas?: DerivedCellsDeps['readFormulas']
  } = {},
): Session {
  univer = new Univer({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
    logLevel: LogLevel.SILENT,
  })
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
    id: 'wb',
    sheetOrder: ['s1', 's2'],
    sheets: {
      s1: { id: 's1', name: 'Data', rowCount: 6000, columnCount: 12, cellData: matrix(data) },
      s2: { id: 's2', name: 'Report', rowCount: 50, columnCount: 12, cellData: matrix(report) },
    },
  })
  const univerAPI = FUniver.newAPI(univer)
  const injector = univer.__getInjector()
  injector.get(IUniverInstanceService).focusUnit('wb')
  const runtime = { univer, univerAPI } as unknown as UniverRuntime
  const state = {
    file: { sessionId: '11111111-1111-4111-8111-111111111111', sheets: FILE_SHEETS },
    editJournal: createEditJournal(),
    formulaMode: !options.streamed,
    flags: { preloadComplete: !options.streamed, preloadRunning: false },
    formulaText: new Map(),
    formulaTextTruncated: new Set(),
    fileArrayRefs: new Map(),
    sharedFormulaGroups: new Map(),
    loadedRanges: new Map(),
  } as unknown as LazyWorkbookState
  const derived = createDerivedCells({
    runtime: () => runtime,
    state: () => state,
    readFormulas: options.readFormulas,
  })
  installDerivedCellsInvalidation(runtime, derived)
  const redactionLoadRef = {
    current: loadedRedactions(sessionRedactionIndex([], FILE_SHEETS, state.editJournal)),
  }
  const mark = (states: readonly SheetRedactionState[]): void => {
    redactionLoadRef.current = loadedRedactions(
      derived.indexOver(sessionRedactionIndex(states, FILE_SHEETS, state.editJournal)),
    )
  }
  mark(HIDDEN_B2)
  const ctx: WorkbookReadContext = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state },
    adapterRef: { current: null } as never,
    redactionLoadRef,
  }
  return {
    ctx,
    state,
    runtime,
    mark,
    read: (sheetId, address) => readCells(ctx, [address], sheetId)[address]?.value,
    defineName: (name, formula) =>
      injector
        .get(IDefinedNamesService)
        .registerDefinedName('wb', { id: name, name, formulaOrRefString: formula }),
  }
}

const CLIENTS: Cells = {
  A1: { v: 'Name' },
  B1: { v: 'Phone' },
  A2: { v: 'Kim' },
  B2: { v: SECRET },
}

describe('what the in-app AI reads from a formula that depends on a hidden cell', () => {
  it('withholds a formula that reads the cell, value and text', () => {
    const session = open({ ...CLIENTS, C2: { f: '=B2', v: SECRET }, D2: { f: '=A2', v: 'Kim' } })
    expect(readCells(session.ctx, ['B2', 'C2'], 's1')).toEqual({
      B2: { value: '{{client phone}}' },
      C2: { value: PRIVATE },
    })
    // and still shows a formula that reads nothing hidden
    expect(readCells(session.ctx, ['D2'], 's1').D2).toMatchObject({ value: 'Kim', formula: '=A2' })
  })

  it('follows a chain of three formulas', () => {
    const { read } = open({
      ...CLIENTS,
      C2: { f: '=B2', v: SECRET },
      D2: { f: '=C2&"x"', v: `${SECRET}x` },
      E2: { f: '=LEFT(D2,11)', v: SECRET },
    })
    expect(['C2', 'D2', 'E2'].map((cell) => read('s1', cell))).toEqual([PRIVATE, PRIVATE, PRIVATE])
  })

  it('withholds a formula on a sheet without marks that points at the marked sheet', () => {
    const { read } = open(CLIENTS, {
      A1: { f: '=Data!B2', v: SECRET },
      B1: { f: "='Data'!A2", v: 'Kim' },
    })
    expect(read('s2', 'A1')).toBe(PRIVATE)
    expect(read('s2', 'B1')).toBe('Kim')
  })

  it('withholds a total over the whole column', () => {
    const { read } = open({
      ...CLIENTS,
      D1: { f: '=SUM(B:B)', v: Number(SECRET) },
      D2: { f: '=COUNTA(A:A)', v: 2 },
    })
    expect(read('s1', 'D1')).toBe(PRIVATE)
    expect(read('s1', 'D2')).toBe(2)
  })

  it('resolves a named range', () => {
    const session = open({
      ...CLIENTS,
      C2: { f: '=KimPhone', v: SECRET },
      D2: { f: '=KimName', v: 'Kim' },
    })
    session.defineName('KimPhone', 'Data!$B$2')
    session.defineName('KimName', 'Data!$A$2')
    session.mark(HIDDEN_B2)
    expect(session.read('s1', 'C2')).toBe(PRIVATE)
    expect(session.read('s1', 'D2')).toBe('Kim')
  })

  it('withholds what it cannot trace: INDIRECT, and what reads it', () => {
    const { read } = open({
      ...CLIENTS,
      C2: { f: '=INDIRECT("B"&2)', v: SECRET },
      D2: { f: '=C2', v: SECRET },
      E2: { f: '=A2', v: 'Kim' },
    })
    expect(['C2', 'D2', 'E2'].map((cell) => read('s1', cell))).toEqual([PRIVATE, PRIVATE, 'Kim'])
  })

  it('answers for formulas that refer to each other in a circle', () => {
    const { read } = open({
      ...CLIENTS,
      C2: { f: '=D2+B2', v: 1 },
      D2: { f: '=C2', v: 1 },
      E2: { f: '=F2', v: 0 },
      F2: { f: '=E2', v: 0 },
    })
    expect(['C2', 'D2'].map((cell) => read('s1', cell))).toEqual([PRIVATE, PRIVATE])
    expect(read('s1', 'E2')).not.toBe(PRIVATE)
  })

  it('withholds the followers of a shared formula that reach the cell, and only those', () => {
    const { read } = open({
      ...CLIENTS,
      A3: { v: 'Lee' },
      B3: { v: 555 },
      C1: { f: '=B1', si: 'g1', v: 'Phone' },
      C2: { si: 'g1', v: SECRET },
      C3: { si: 'g1', v: 555 },
    })
    expect(read('s1', 'C2')).toBe(PRIVATE)
    expect(read('s1', 'C3')).not.toBe(PRIVATE)
  })

  it('covers a formula typed after the cell was hidden, at once', () => {
    const session = open(CLIENTS)
    expect(session.read('s1', 'E5')).toBeNull()
    const sheet = session.runtime.univerAPI.getActiveWorkbook()!.getSheetBySheetId('s1')!
    sheet.getRange('E5').setValue({ f: '=B2' })
    sheet.getRange('E6').setValue({ f: '=LEN(A2)' })
    expect(session.read('s1', 'E5')).toBe(PRIVATE)
    expect(session.read('s1', 'E6')).not.toBe(PRIVATE)
  })

  it('follows a hide and a show made after the formula', () => {
    const session = open({ ...CLIENTS, C2: { f: '=B2', v: SECRET }, D2: { f: '=A2', v: 'Kim' } })
    // the person stops hiding the phone number and hides the name instead
    session.mark([
      {
        sheetName: 'Data',
        marks: [{ startRow: 1, endRow: 1, startColumn: 0, endColumn: 0, label: 'client name' }],
      },
    ])
    expect(session.read('s1', 'C2')).toBe(SECRET)
    expect(session.read('s1', 'D2')).toBe(PRIVATE)
    session.mark([])
    expect(session.read('s1', 'D2')).toBe('Kim')
  })

  it('leaves a workbook without marks alone, whatever its formulas say', () => {
    const session = open({ ...CLIENTS, C2: { f: '=INDIRECT("B2")', v: SECRET } })
    session.mark([])
    expect(session.read('s1', 'C2')).toBe(SECRET)
  })

  it('keeps find and aggregate away from a dependent cell', async () => {
    const session = open({ ...CLIENTS, C2: { f: '=B2', v: SECRET }, C3: { v: 7 } })
    // the same cells as a snapshot, for the tools' in-memory path
    const ctx: WorkbookReadContext = {
      ...session.ctx,
      lazyWorkbookRef: { current: null },
      adapterRef: {
        current: {
          getSnapshot: () => ({
            revision: 1,
            sheets: [
              {
                id: 's1',
                name: 'Data',
                cells: {
                  B2: { value: SECRET },
                  C2: { value: SECRET, formula: '=B2' },
                  C3: { value: 7 },
                },
              },
            ],
          }),
        },
      } as never,
    }
    const found = await findWorkbookCells(ctx, {
      query: '138',
      regex: false,
      lookIn: 'both',
      errorsOnly: false,
      maxResults: 10,
    })
    expect(found.matches).toEqual([])
    const total = await aggregateWorkbookRange(ctx, 's1', {
      startRow: 0,
      endRow: 5,
      startColumn: 2,
      endColumn: 2,
    })
    expect(total.ok && total.aggregate.sum).toBe(7)
    expect(JSON.stringify(total)).not.toContain(SECRET)
  })
})

describe('what the in-app AI may do with a formula that depends on a hidden cell', () => {
  const DEPENDENT: Cells = { ...CLIENTS, C2: { f: '=B2', v: SECRET }, D2: { f: '=A2', v: 'Kim' } }
  const refusal = (session: Session, op: object) =>
    redactGuardForOps([op], redactionIndexOf(session.ctx.redactionLoadRef!.current))

  it('refuses to freeze it into a value', () => {
    const session = open(DEPENDENT)
    const refused = refusal(session, { op: 'convert_to_values', sheetId: 's1', range: 'C2:D2' })
    expect(refused).toMatchObject({ where: 'C2', label: 'private' })
  })

  it('refuses to copy it or fill from it, which may write its value', () => {
    const session = open(DEPENDENT)
    for (const op of [
      { op: 'copy_range', sheetId: 's1', source: 'C2', target: 'G2' },
      { op: 'fill_range', sheetId: 's1', source: 'C2', target: 'C3:C5' },
      { op: 'set_formula', sheetId: 's1', address: 'G2', formula: '=C2' },
    ]) {
      expect(refusal(session, op), op.op).not.toBeNull()
    }
  })

  it('refuses to overwrite a formula it was never shown', () => {
    const session = open(DEPENDENT)
    expect(refusal(session, { op: 'set_cell', sheetId: 's1', address: 'C2', value: 1 })).not.toBe(
      null,
    )
  })

  it('leaves formulas that read nothing hidden alone, and rows may still be inserted', () => {
    const session = open(DEPENDENT)
    expect(refusal(session, { op: 'convert_to_values', sheetId: 's1', range: 'D2' })).toBeNull()
    expect(
      refusal(session, { op: 'copy_range', sheetId: 's1', source: 'D2', target: 'G2' }),
    ).toBeNull()
    // below the mark: nothing withheld moves away from its mark
    expect(refusal(session, { op: 'insert_rows', sheetId: 's1', row: 5, count: 1 })).toBeNull()
  })
})

describe('formulas the session only knows from the file', () => {
  it('withholds a formula shown from its cached value, and what reads it', () => {
    // C2 was loaded as a value: the engine could not take its formula.
    const session = open({
      ...CLIENTS,
      C2: { v: SECRET },
      D2: { f: '=C2', v: SECRET },
      E2: { v: 'plain' },
    })
    session.state.formulaText.set('s1', new Map([['1:2', '=MYMACRO(B2)']]))
    session.mark(HIDDEN_B2)
    expect(session.read('s1', 'C2')).toBe(PRIVATE)
    expect(session.read('s1', 'D2')).toBe(PRIVATE)
    expect(session.read('s1', 'E2')).toBe('plain')
  })

  it('shows such a cell again once the person typed a constant over it', () => {
    const session = open({ ...CLIENTS, C2: { v: 'typed' } })
    session.state.formulaText.set('s1', new Map([['1:2', '=MYMACRO(B2)']]))
    recordSetRangeValues(session.state.editJournal, 's1', { 1: { 2: { v: 'typed' } } })
    session.mark(HIDDEN_B2)
    expect(session.read('s1', 'C2')).toBe('typed')
  })

  it('withholds every cell an array formula of the file fills', () => {
    const session = open({ ...CLIENTS, D1: { v: 'Phone' }, D2: { v: SECRET }, E2: { v: 'plain' } })
    session.state.formulaText.set('s1', new Map([['0:3', '=B1:B2']]))
    session.state.fileArrayRefs.set('s1', new Map([['0:3', 'D1:D2']]))
    session.mark(HIDDEN_B2)
    expect(session.read('s1', 'D1')).toBe(PRIVATE)
    expect(session.read('s1', 'D2')).toBe(PRIVATE)
    expect(session.read('s1', 'E2')).toBe('plain')
  })

  it('withholds a streamed sheet whole until its formula cells are known, then only those', async () => {
    let answer: (result: WorkbookFormulaCellsResult) => void = () => {}
    const listed = new Promise<WorkbookFormulaCellsResult>((resolve) => {
      answer = resolve
    })
    const session = open(
      { ...CLIENTS, C2: { v: SECRET } },
      { A1: { v: 'Q1' } },
      {
        streamed: true,
        readFormulas: async (_session, sheetId) =>
          sheetId === 's1'
            ? listed
            : { cells: [], sharedGroups: [], indexingComplete: true, truncated: false },
      },
    )
    expect(session.read('s1', 'A2')).toBe(PRIVATE)
    answer({
      cells: [{ row: 1, column: 2, formula: '=B2', value: SECRET }] as never,
      sharedGroups: [],
      indexingComplete: true,
      truncated: false,
    })
    await vi.waitFor(() => expect(session.read('s1', 'A2')).toBe('Kim'))
    expect(session.read('s1', 'C2')).toBe(PRIVATE)
    expect(session.read('s2', 'A1')).toBe('Q1')
  })

  it('keeps a streamed sheet withheld when its formulas cannot be listed', async () => {
    const answers: Promise<WorkbookFormulaCellsResult>[] = []
    const truncated = open(
      { ...CLIENTS },
      {},
      {
        streamed: true,
        readFormulas: () => {
          const answer = Promise.resolve({
            cells: [],
            sharedGroups: [],
            indexingComplete: true,
            truncated: true,
          })
          answers.push(answer)
          return answer
        },
      },
    )
    expect(truncated.read('s1', 'A2')).toBe(PRIVATE)
    // the list is read, and says "more formulas than listed": still nothing is known
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    await Promise.all(answers)
    expect(truncated.read('s1', 'A2')).toBe(PRIVATE)
    expect(truncated.read('s2', 'A1')).toBe(PRIVATE)
    univer?.dispose()
    // and on a platform with no formula list at all
    const none = open({ ...CLIENTS }, {}, { streamed: true })
    expect(none.read('s1', 'A2')).toBe(PRIVATE)
    expect(none.read('s1', 'A2')).toBe(PRIVATE)
  })
})

describe('a large sheet', () => {
  it('answers for a 5,000-formula sheet in well under a second', () => {
    const cells: Cells = { A1: { v: 'n' }, B2: { v: SECRET }, C2: { f: '=B2', v: SECRET } }
    for (let row = 3; row <= 2501; row += 1) {
      cells[`A${row}`] = { v: row }
      cells[`C${row}`] = { f: `=C${row - 1}+A${row}`, v: row }
    }
    for (let row = 2; row <= 2501; row += 1) cells[`D${row}`] = { f: `=SUM(A$2:A${row})`, v: row }
    const session = open(cells)
    const started = performance.now()
    const first = session.read('s1', 'C2501')
    const elapsed = performance.now() - started
    expect(first).toBe(PRIVATE)
    expect(session.read('s1', 'D2501')).not.toBe(PRIVATE)
    expect(elapsed).toBeLessThan(1000)
  })
})
