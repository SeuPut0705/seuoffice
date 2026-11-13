/**
 * Group `d1/sheets-read`: what a session answers once it is open. The range,
 * formula, row-outline, find, media, recalculation, external-link, pivot,
 * slicer, connection, query and redaction reads, the tab list and the
 * cross-tab range pick (`apps/sheets/src/main/sheets-main.ts`), loaded as the
 * shell loads it (`d1/sheets-host.ts`).
 *
 * What the engine answers is the case's (`d1/sheets-canon.json`, the schemas'
 * own output); every read is asked of a known session, an unknown one and a
 * request the schema refuses. The pick ids carry the shared UUID counter.
 *
 * Not reachable by a call, so not compared here: `workbook:sidecar-crashed`
 * (the sidecar process dying), `workbook:close-save-request` and
 * `workbook:recovery-write-now` (the shell's `requestSheetsClose` and
 * `writeSheetsCopiesNow`). The sends `workbook:pending-edits` and
 * `workbook:close-save-result` answer nothing and only change what the
 * close guard waits for, which no probe call asks.
 */
import { loadSheets } from '../../d1/sheets-host.ts'
import { NOBODY, S1, SELECT, call, queued, sheetsCase, tab } from '../../d1/sheets-cases.ts'
import type { Case, Group } from '../../types.ts'

const A = queued([1, 'a.xlsx'])
const TWO = queued([1, 'a.xlsx'], [2, 'b.xlsx'])
const range = (extra: Record<string, number> = {}) => ({
  startRow: 0,
  endRow: 1,
  startColumn: 0,
  endColumn: 1,
  ...extra,
})
const withSession = (session: string, rest: Record<string, unknown> = {}) => ({ sessionId: session, ...rest })
const both = (channel: string, rest: Record<string, unknown> = {}) => [
  SELECT,
  call(channel, [withSession(S1, rest)]),
  call(channel, [withSession(NOBODY, rest)]),
  call(channel, [{ sessionId: 'not-a-uuid', ...rest }]),
  call(channel, [null]),
]
const SLICER = {
  sheetId: 's1',
  worksheetPath: 'xl/worksheets/sheet1.xml',
  partPath: 'xl/slicers/slicer1.xml',
  cachePath: 'xl/slicerCaches/slicerCache1.xml',
  name: 'Region',
  cacheName: 'Slicer_Region',
  sourceName: 'Region',
  caption: 'Region',
  pivotCacheDefinitionPath: null,
  selectedItems: null,
}
const PICK1 = 'pick-11111111-0000-4000-8000-000000000003'
const PICK2 = 'pick-11111111-0000-4000-8000-000000000004'
const pick = (pickId: string, extra: Record<string, unknown>) => ({
  pickId,
  startRow: 0,
  endRow: 1,
  startColumn: 0,
  endColumn: 1,
  ...extra,
})
const PIVOT = 'xl/pivotTables/pivotTable1.xml'
const CACHE = 'xl/pivotCache/pivotCacheDefinition1.xml'

const cases: Case[] = [
  // ---- before any session ----
  sheetsCase('a tab with no workbook has no session to read', { d1: A }, [
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range() })]),
    call('workbook:list-tabs'),
    call('workbook:read-redactions', [withSession(S1)]),
  ]),

  // ---- cell reads ----
  sheetsCase('a range: read, unknown session, bad id, reversed, too large, no sheet', { d1: A }, [
    SELECT,
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range() })]),
    call('workbook:read-range', [withSession(NOBODY, { sheetId: 's1', range: range() })]),
    call('workbook:read-range', [withSession('x', { sheetId: 's1', range: range() })]),
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range({ startRow: 5, endRow: 1 }) })]),
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range({ endRow: 99_999, endColumn: 9 }) })]),
    call('workbook:read-range', [withSession(S1, { range: range() })]),
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range({ startRow: -1 }) })]),
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range(), extra: 1 })]),
    call('workbook:read-range', []),
  ]),
  sheetsCase('the engine fails to read a range', { d1: { ...A, readRange: { error: 'sidecar gone' } } }, [
    SELECT,
    call('workbook:read-range', [withSession(S1, { sheetId: 's1', range: range() })]),
  ]),
  sheetsCase('formula cells', { d1: A }, [
    ...both('workbook:read-formulas', { sheetId: 's1' }),
    call('workbook:read-formulas', [withSession(S1, { sheetId: '' })]),
  ]),
  sheetsCase('the row outline', { d1: A }, [
    ...both('workbook:read-row-outline', { sheetId: 's1' }),
    call('workbook:read-row-outline', [withSession(S1)]),
  ]),
  sheetsCase('find: a whole workbook, a sheet, resuming, and requests the schema refuses', { d1: A }, [
    SELECT,
    call('workbook:find-cells', [
      withSession(S1, { query: 'x', matchCase: false, matchEntireCell: false, lookIn: 'values', wildcards: false, limit: 50 }),
    ]),
    call('workbook:find-cells', [
      withSession(S1, {
        sheetId: 's1',
        query: 'x',
        matchCase: true,
        matchEntireCell: true,
        lookIn: 'both',
        wildcards: true,
        resumeAt: { sheetId: 's1', row: 3, column: 2 },
        limit: 100_000,
      }),
    ]),
    call('workbook:find-cells', [
      withSession(NOBODY, { query: 'x', matchCase: false, matchEntireCell: false, lookIn: 'values', wildcards: false, limit: 50 }),
    ]),
    call('workbook:find-cells', [
      withSession(S1, { query: '', matchCase: false, matchEntireCell: false, lookIn: 'values', wildcards: false, limit: 50 }),
    ]),
    call('workbook:find-cells', [
      withSession(S1, { query: 'x', matchCase: false, matchEntireCell: false, lookIn: 'nowhere', wildcards: false, limit: 0 }),
    ]),
    call('workbook:find-cells', [withSession(S1, { query: 'x' })]),
  ]),
  sheetsCase('an image of the sheet', { d1: A }, [
    ...both('workbook:read-media', { visualId: 'v1' }),
    call('workbook:read-media', [withSession(S1, { visualId: '' })]),
  ]),

  // ---- recalculation ----
  sheetsCase('recalculation: values, formulas, a sheet that is not in the file, reversed and oversize reads', { d1: A }, [
    SELECT,
    call('workbook:recalc', [
      withSession(S1, {
        edits: [
          { sheetId: 's1', row: 0, column: 0, input: '42' },
          { sheetId: 's1', row: 1, column: 0, input: '=A1*2' },
          { sheetId: 's1', row: 2, column: 0, input: 'text' },
          { sheetId: 's1', row: 3, column: 0, input: '  ' },
        ],
        reads: [{ sheetId: 's1', range: range() }],
      }),
    ]),
    call('workbook:recalc', [withSession(S1, { edits: [], reads: [] })]),
    call('workbook:recalc', [withSession(S1, { edits: [{ sheetId: 's9', row: 0, column: 0, input: '1' }], reads: [] })]),
    call('workbook:recalc', [withSession(S1, { edits: [], reads: [{ sheetId: 's9', range: range() }] })]),
    call('workbook:recalc', [withSession(S1, { edits: [], reads: [{ sheetId: 's1', range: range({ startColumn: 4, endColumn: 1 }) }] })]),
    call('workbook:recalc', [
      withSession(S1, {
        edits: [],
        reads: [
          { sheetId: 's1', range: range({ endRow: 999, endColumn: 99 }) },
          { sheetId: 's1', range: range({ endRow: 999, endColumn: 99 }) },
        ],
      }),
    ]),
    call('workbook:recalc', [withSession(NOBODY, { edits: [], reads: [] })]),
    call('workbook:recalc', [withSession(S1, { edits: [{ sheetId: 's1', row: 1_048_576, column: 0, input: '1' }], reads: [] })]),
    call('workbook:recalc', [withSession(S1, { edits: [] })]),
  ]),

  // ---- external links ----
  sheetsCase('the links of a workbook, refreshed, and what uses them', { d1: A }, [
    ...both('workbook:list-external-links'),
    ...both('workbook:update-external-links'),
    ...both('workbook:read-external-link-usage'),
  ]),
  sheetsCase('a link source is picked by the host: chosen, cancelled, empty', { opens: [['$DIR/b.xlsx'], null, []] }, [
    call('workbook:select-external-link-source'),
    call('workbook:select-external-link-source'),
    call('workbook:select-external-link-source'),
  ]),

  // ---- pivot, slicer, connections, queries, redactions ----
  sheetsCase('a pivot table is read from the snapshot of its session', { d1: A }, [
    SELECT,
    call('workbook:read-pivot-definition', [withSession(S1, { path: PIVOT, cachePath: CACHE })]),
    call('workbook:read-pivot-definition', [withSession(NOBODY, { path: PIVOT, cachePath: CACHE })]),
    call('workbook:read-pivot-definition', [withSession(S1, { path: '../x.xml', cachePath: CACHE })]),
    call('workbook:read-pivot-definition', [withSession(S1, { path: PIVOT })]),
    call('workbook:read-pivot-definition', [withSession(S1, { path: 'xl/a b.xml', cachePath: 'xl/.xml' })]),
  ]),
  sheetsCase('a workbook with no slicers is answered before the parser runs', { d1: A }, both('workbook:read-slicer-state')),
  sheetsCase('slicers are read when the snapshot has their parts', { d1: { ...A, readSlicerState: [SLICER] } }, [
    SELECT,
    call('workbook:read-slicer-state', [withSession(S1)]),
  ]),
  sheetsCase('connections: listed, refreshed, and the ones that cannot be', { d1: A }, [
    ...both('workbook:list-connections'),
    SELECT,
    call('workbook:refresh-connection', [withSession(S1, { connectionId: 'c1' })]),
    call('workbook:refresh-connection', [withSession(NOBODY, { connectionId: 'c1' })]),
    call('workbook:refresh-connection', [withSession(S1, { connectionId: '' })]),
    call('workbook:refresh-connection', [withSession(S1, { connectionId: 'c'.repeat(201) })]),
    call('workbook:refresh-connection', [withSession(S1)]),
  ]),
  sheetsCase('a connection the workbook does not have', { d1: { ...A, refreshOutcome: { unknown: true } } }, [
    SELECT,
    call('workbook:refresh-connection', [withSession(S1, { connectionId: 'c1' })]),
  ]),
  sheetsCase('a connection whose source has no table', { d1: { ...A, refreshOutcome: { noTable: true } } }, [
    SELECT,
    call('workbook:refresh-connection', [withSession(S1, { connectionId: 'c1' })]),
  ]),
  sheetsCase('queries and redactions', { d1: A }, [
    ...both('workbook:read-queries'),
    ...both('workbook:read-redactions'),
  ]),

  // ---- tabs and the range pick ----
  sheetsCase('another tab shows in the list once it has a workbook', { d1: TWO }, [
    call('workbook:select', [], { view: 1 }),
    call('workbook:list-tabs', [], { view: 1 }),
    call('workbook:select', [], { view: 2 }),
    call('workbook:list-tabs', [], { view: 1 }),
    call('workbook:list-tabs', [], { view: 2 }),
  ], { views: [tab(1), tab(2)] }),

  sheetsCase('a range pick: armed on the source tab, chosen there, and cancelled on the rest', { d1: TWO }, [
    call('workbook:select', [], { view: 1 }),
    call('workbook:select', [], { view: 2 }),
    call('workbook:pick-arm', [{ wcId: 2 }], { view: 1 }),
    call('workbook:pick-select', [pick(PICK1, { sheetName: 'Sheet1' })], { view: 1 }),
    call('workbook:pick-select', [pick(PICK1, { sheetName: 'Sheet1', rangeType: 2 })], { view: 2 }),
    call('workbook:pick-select', [pick(PICK1, { sheetName: 'Sheet1' })], { view: 2 }),
    call('workbook:pick-cancel', [{ pickId: PICK1 }], { view: 1 }),
  ], { views: [tab(1), tab(2)] }),
  sheetsCase('a second arm supersedes the first, and a cancel ends the pick', { d1: TWO }, [
    call('workbook:select', [], { view: 1 }),
    call('workbook:select', [], { view: 2 }),
    call('workbook:pick-arm', [{ wcId: 2 }], { view: 1 }),
    call('workbook:pick-arm', [{ wcId: 2 }], { view: 1 }),
    call('workbook:pick-cancel', [{ pickId: PICK1 }], { view: 2 }),
    call('workbook:pick-cancel', [{ pickId: PICK2 }], { view: 2 }),
    call('workbook:pick-cancel', [{ pickId: PICK2 }], { view: 2 }),
    call('workbook:pick-arm', [{ wcId: 1 }], { view: 1 }),
    call('workbook:pick-arm', [{ wcId: 99 }], { view: 1 }),
  ], { views: [tab(1), tab(2)] }),
  sheetsCase('a pick the schema refuses', { d1: TWO }, [
    call('workbook:select', [], { view: 1 }),
    call('workbook:pick-arm', [{}], { view: 1 }),
    call('workbook:pick-arm', [{ wcId: 1.5 }], { view: 1 }),
    call('workbook:pick-arm', [null], { view: 1 }),
    call('workbook:pick-select', [{ pickId: '', sheetName: '', startRow: -1 }], { view: 1 }),
    call('workbook:pick-select', [pick('p', { sheetName: 'S', extra: 1 })], { view: 1 }),
    call('workbook:pick-cancel', [{ pickId: '' }], { view: 1 }),
    call('workbook:pick-cancel', [], { view: 1 }),
  ], { views: [tab(1), tab(2)] }),
]

export const group: Group = {
  batch: 'D1',
  load: loadSheets,
  cases,
  single: {},
}
