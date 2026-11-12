/**
 * `apply_sheet_ops` over the MCP bridge, on a workbook that withholds a cell.
 *
 * `read_sheet` shows an external agent a placeholder for a withheld cell. The
 * apply path is the other way to the same value: a formula that references the
 * cell comes back computed in `formulaValues`, a find/replace over it comes
 * back as the replaced text in a dry run's preview, and a plain write destroys
 * what the reader kept. So a batch that reads or writes a withheld cell is
 * refused whole, before anything is planned or applied, exactly as the in-app
 * AI's batch is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkbookOperation } from '@seuoffice/xlsx-gateway/domain/workbook-dsl'
import type { ApplyOutcome, CellState } from '@seuoffice/xlsx-gateway/domain/workbook.types'
import { buildRedactionIndex } from '../src/renderer/ai/redact'
import {
  loadedRedactions,
  REDACTIONS_NONE,
  REDACTIONS_NOT_LOADED,
  type RedactionLoad,
} from '../src/renderer/ai/redact-load'
import { readCells, type WorkbookReadContext } from '../src/renderer/ai/workbook-readers'
import { buildLazyChangePlan } from '../src/renderer/lazy-plan'
import { installSheetsMcpBridge } from '../src/renderer/mcp-bridge'
import { applyOpsForMcp, readCellsForMcp } from '../src/renderer/mcp-sheet-handlers'

const SHEETS = [
  { id: 'sh1', name: 'Customers' },
  { id: 'sh2', name: 'Orders' },
]
const PHONE = '13800138000'

/// A1 on Customers is the phone number the reader withheld.
const WITHHELD_A1 = loadedRedactions(
  buildRedactionIndex(
    [
      {
        sheetName: 'Customers',
        marks: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, label: 'client phone' }],
      },
    ],
    SHEETS,
  ),
)

type Cells = Record<string, CellState>

/** The open workbook: its cells, and every batch that reached the grid. */
interface Workbook {
  readonly cells: Record<string, Cells>
  readonly applied: WorkbookOperation[][]
}

function openWorkbook(): Workbook {
  return {
    cells: {
      sh1: { A1: { value: PHONE }, C1: { value: 'visible' } },
      sh2: {},
    },
    applied: [],
  }
}

/** `=A1` or `=Customers!A1`: the one formula shape the stand-in engine computes. */
const SINGLE_REF = /^=(?:'?([^'!]+)'?!)?([A-Z]+\d+)$/

/**
 * Stands in for the grid and its formula engine: writes values, and gives a
 * single-reference formula the value of the cell it names, resolving a sheet
 * name the way the real engine does (ignoring case).
 */
function applyToGrid(workbook: Workbook, ops: readonly WorkbookOperation[]): ApplyOutcome {
  workbook.applied.push([...ops])
  for (const op of ops) {
    if (!('sheetId' in op)) continue
    const sheet = workbook.cells[op.sheetId]
    if (!sheet) return { ok: false, reason: `Unknown sheet: ${op.sheetId}` }
    if (op.op === 'set_cell') sheet[op.address] = { value: op.value }
    if (op.op === 'set_formula') {
      const [, sheetName, address] = SINGLE_REF.exec(op.formula) ?? []
      const source =
        sheetName === undefined
          ? sheet
          : workbook.cells[
              SHEETS.find((entry) => entry.name.toLowerCase() === sheetName.toLowerCase())?.id ?? ''
            ]
      sheet[op.address] = {
        value: (address === undefined ? undefined : source?.[address]?.value) ?? '#REF!',
        formula: op.formula,
      }
    }
  }
  return { ok: true }
}

function readContext(workbook: Workbook, loadRef: { current: RedactionLoad }): WorkbookReadContext {
  const worksheetOf = (id: string): object => ({
    getSheetId: () => id,
    getSheetName: () => SHEETS.find((sheet) => sheet.id === id)?.name,
    getRange: () => ({ getValue: () => null }),
  })
  return {
    univerRef: {
      current: {
        univerAPI: {
          getActiveWorkbook: () => ({
            getActiveSheet: () => worksheetOf('sh1'),
            getSheetBySheetId: worksheetOf,
          }),
        },
      },
    } as never,
    lazyWorkbookRef: { current: null },
    adapterRef: {
      current: {
        getSnapshot: () => ({
          revision: 1,
          sheets: SHEETS.map((sheet) => ({ ...sheet, cells: workbook.cells[sheet.id] ?? {} })),
        }),
      },
    } as never,
    redactionLoadRef: loadRef,
  }
}

type CommandListener = (message: {
  requestId: number
  command: string
  payload: Record<string, unknown>
}) => void

let commandListener: CommandListener | undefined
const reportMcpResult = vi.fn()

beforeEach(() => {
  commandListener = undefined
  reportMcpResult.mockReset()
  vi.stubGlobal('window', {
    desktopApi: {
      onMcpCommand: (listener: CommandListener) => {
        commandListener = listener
        return () => {}
      },
      reportMcpResult,
      signalMcpReady: () => {},
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Mount the bridge over a workbook, wired the way App wires it. */
function mountBridge(workbook: Workbook, loadRef: { current: RedactionLoad }): void {
  const ctx = readContext(workbook, loadRef)
  installSheetsMcpBridge({
    hasWorkbook: () => true,
    context: () => ({}),
    readCells: (addresses, sheetId) => readCellsForMcp(ctx, addresses, sheetId),
    sheets: () => SHEETS,
    focusSheet: () => {},
    applyOps: (ops, dryRun) =>
      applyOpsForMcp(
        {
          redactionLoad: () => loadRef.current,
          sheets: () => SHEETS,
          plan: (batch) =>
            buildLazyChangePlan(
              {
                dslVersion: 1,
                transactionId: 'mcp-test',
                baseRevision: 0,
                summary: 'mcp',
                operations: [...batch],
              },
              (address, sheetId) => workbook.cells[sheetId]?.[address] ?? { value: null },
              (sheetId) => SHEETS.find((sheet) => sheet.id === sheetId)?.name ?? sheetId,
            ),
          apply: async (batch) => applyToGrid(workbook, batch),
          readCells: (addresses, sheetId) => readCells(ctx, addresses, sheetId),
        },
        ops,
        dryRun,
      ),
    saveTo: async () => ({ ok: true }),
  })
}

interface ApplyAnswer {
  readonly ok: boolean
  readonly reason?: string
  readonly formulaValues?: readonly { address: string; value: unknown }[]
  readonly cellChanges?: readonly { address: string; after: unknown }[]
}

/** One `apply_ops` over the bridge; returns the answer and everything that crossed the wire. */
async function applySheetOps(
  ops: unknown[],
  dryRun = false,
): Promise<{ answer: ApplyAnswer; wire: string }> {
  const before = reportMcpResult.mock.calls.length
  commandListener!({ requestId: before + 1, command: 'apply_ops', payload: { ops, dryRun } })
  await vi.waitFor(() => expect(reportMcpResult.mock.calls.length).toBe(before + 1))
  const reply = reportMcpResult.mock.calls[before]![0] as { ok: boolean; result: ApplyAnswer }
  expect(reply.ok).toBe(true)
  return { answer: reply.result, wire: JSON.stringify(reply) }
}

describe('apply_sheet_ops on a workbook that withholds a cell', () => {
  it('does not hand back the withheld value as the result of a formula over it', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: WITHHELD_A1 })

    const { answer, wire } = await applySheetOps([
      { op: 'set_formula', sheet: 'Customers', address: 'B1', formula: '=A1' },
    ])

    expect(wire).not.toContain(PHONE)
    expect(answer.ok).toBe(false)
    // the refusal names the cell by its placeholder, as the in-app tool's does
    expect(answer.reason).toContain('{{client phone}}')
    expect(workbook.applied).toHaveLength(0)
    expect(workbook.cells.sh1?.B1).toBeUndefined()
  })

  it('refuses the same formula written from another sheet, however the sheet name is cased', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: WITHHELD_A1 })

    for (const formula of ['=Customers!A1', '=customers!A1', "='CUSTOMERS'!A1"]) {
      const { answer, wire } = await applySheetOps([
        { op: 'set_formula', sheet: 'Orders', address: 'A1', formula },
      ])
      expect(wire, formula).not.toContain(PHONE)
      expect(answer.ok, formula).toBe(false)
    }
    expect(workbook.applied).toHaveLength(0)
  })

  it('refuses to overwrite the withheld cell', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: WITHHELD_A1 })

    const { answer } = await applySheetOps([
      { op: 'set_cell', sheet: 'Customers', address: 'A1', value: 'overwritten' },
      { op: 'set_cell', sheet: 'Customers', address: 'C1', value: 'also changed' },
    ])

    expect(answer.ok).toBe(false)
    // all-or-nothing: the harmless half of the batch did not land either
    expect(workbook.applied).toHaveLength(0)
    expect(workbook.cells.sh1).toEqual({ A1: { value: PHONE }, C1: { value: 'visible' } })
  })

  it('leaks nothing through a dry run', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: WITHHELD_A1 })

    // the preview of a replace is the cell's own text with the replacement in it
    const replace = await applySheetOps(
      [{ op: 'find_replace', sheet: 'Customers', range: 'A1:C1', find: '138', replace: 'x' }],
      true,
    )
    expect(replace.wire).not.toContain('x00x000')
    expect(replace.answer.ok).toBe(false)
    expect(replace.answer.cellChanges).toBeUndefined()

    const copy = await applySheetOps(
      [{ op: 'copy_range', sheet: 'Customers', source: 'A1:A1', target: 'D1' }],
      true,
    )
    expect(copy.wire).not.toContain(PHONE)
    expect(copy.answer.ok).toBe(false)
    expect(workbook.applied).toHaveLength(0)
  })

  it('still applies a batch that stays off the withheld cell, and reports its formula value', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: WITHHELD_A1 })

    const { answer } = await applySheetOps([
      { op: 'set_formula', sheet: 'Customers', address: 'D1', formula: '=C1' },
    ])

    expect(answer.ok).toBe(true)
    expect(answer.formulaValues).toEqual([
      { sheetId: 'sh1', address: 'D1', value: 'visible', formula: '=C1' },
    ])
    const preview = await applySheetOps(
      [{ op: 'set_cell', sheet: 'Customers', address: 'C1', value: 'next' }],
      true,
    )
    expect(preview.answer.cellChanges).toEqual([{ address: 'C1', after: 'next' }])
    expect(workbook.applied).toHaveLength(1)
  })
})

describe('apply_sheet_ops while the marks of the workbook are not known', () => {
  it('refuses a write in the gap after a save and applies it once the marks are in', async () => {
    const workbook = openWorkbook()
    const loadRef: { current: RedactionLoad } = { current: REDACTIONS_NOT_LOADED }
    mountBridge(workbook, loadRef)
    const batch = [{ op: 'set_cell', sheet: 'Customers', address: 'C1', value: 'edited' }]

    const early = await applySheetOps(batch)
    expect(early.answer.ok).toBe(false)
    expect(workbook.applied).toHaveLength(0)
    // it is a wait, not a withheld cell: nothing tells the agent C1 is private
    expect(early.answer.reason).not.toContain('{{')

    loadRef.current = WITHHELD_A1
    const late = await applySheetOps(batch)
    expect(late.answer.ok).toBe(true)
    expect(workbook.cells.sh1?.C1).toEqual({ value: 'edited' })
  })

  it('applies everything on a workbook that withholds nothing', async () => {
    const workbook = openWorkbook()
    mountBridge(workbook, { current: REDACTIONS_NONE })

    const { answer } = await applySheetOps([
      { op: 'set_formula', sheet: 'Customers', address: 'B1', formula: '=A1' },
    ])

    expect(answer.ok).toBe(true)
    expect(answer.formulaValues).toEqual([
      { sheetId: 'sh1', address: 'B1', value: PHONE, formula: '=A1' },
    ])
  })
})
