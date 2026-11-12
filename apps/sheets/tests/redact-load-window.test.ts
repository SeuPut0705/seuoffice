/**
 * The gap between an open and its marks.
 *
 * The marks are read once per open, over IPC, and every save reopens the
 * workbook under a new session. So after each save there is a stretch in which
 * the grid already shows the cells and the marks have not arrived. A read that
 * lands in it (an MCP `read_sheet` sent straight after `save_sheet` outruns the
 * round trip) used to be answered as if nothing were withheld.
 *
 * Not knowing is not the same as knowing there is nothing: until the read
 * lands every cell is withheld, exactly as it is for a part that cannot be
 * read, and the real answers come back the moment the marks are in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  followRedactionRead,
  REDACTIONS_NONE,
  type RedactionLoad,
  type RedactionSession,
} from '../src/renderer/ai/redact-load'
import { executeWorkbookTool, type SheetsSkillDeps } from '../src/renderer/ai/tools'
import {
  readCells,
  redactionsOf,
  type WorkbookReadContext,
} from '../src/renderer/ai/workbook-readers'
import type { TFunc } from '../src/renderer/i18n/locale'
import { installSheetsMcpBridge } from '../src/renderer/mcp-bridge'
import { readCellsForMcp } from '../src/renderer/mcp-sheet-handlers'
import type { WorkbookRedactionsResult } from '../src/shared/desktop-api'

const SHEETS = [{ id: 'sh1', name: 'Customers' }]
const PHONE = '13800138000'
const NAME = 'Acme Ltd'
/// What main answers for this file: B2 only, the phone number. A2 beside it is not marked.
const MARKS_READ: WorkbookRedactionsResult = {
  status: 'ok',
  source: 'part',
  states: [
    {
      sheetName: 'Customers',
      marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
    },
  ],
}

const t = ((key: string) => key) as TFunc

/// A workbook holding a name in A2 and a phone number in B2.
function workbookContext(loadRef: { current: RedactionLoad }): WorkbookReadContext {
  const worksheet = {
    getSheetId: () => 'sh1',
    getSheetName: () => 'Customers',
    getRange: () => ({ getValue: () => null }),
  }
  return {
    univerRef: {
      current: {
        univerAPI: {
          getActiveWorkbook: () => ({
            getActiveSheet: () => worksheet,
            getSheetBySheetId: () => worksheet,
            getActiveRange: () => null,
            getSheets: () => [worksheet],
          }),
        },
      },
    } as never,
    lazyWorkbookRef: { current: null },
    adapterRef: {
      current: {
        getSnapshot: () => ({
          revision: 1,
          sheets: [
            {
              id: 'sh1',
              name: 'Customers',
              cells: { A2: { value: NAME }, B2: { value: PHONE } },
            },
          ],
        }),
      },
    } as never,
    redactionLoadRef: loadRef,
  }
}

/** The marks' IPC round trip, settled by the test (the project's TS lib predates Promise.withResolvers). */
function pendingRead(): {
  promise: Promise<WorkbookRedactionsResult>
  land: (result: WorkbookRedactionsResult) => void
  fail: (error: Error) => void
} {
  let land!: (result: WorkbookRedactionsResult) => void
  let fail!: (error: Error) => void
  const promise = new Promise<WorkbookRedactionsResult>((resolve, reject) => {
    land = resolve
    fail = reject
  })
  return { promise, land, fail }
}

/** What the reopen after a save does with its marks (App's openLazyWorkbook). */
function reopen(
  loadRef: { current: RedactionLoad },
  read: Promise<WorkbookRedactionsResult>,
  options: { isCurrent?: () => boolean } = {},
): { settled: [WorkbookRedactionsResult, RedactionSession][] } {
  const settled: [WorkbookRedactionsResult, RedactionSession][] = []
  followRedactionRead(loadRef, read, {
    isCurrent: options.isCurrent ?? (() => true),
    sheets: () => SHEETS,
    t,
    onSettled: (result, session) => settled.push([result, session]),
  })
  return { settled }
}

type CommandListener = (message: {
  requestId: number
  command: string
  payload: Record<string, unknown>
}) => void

let commandListener: CommandListener | undefined
const reportMcpResult = vi.fn()
let nextRequestId = 0

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

/** Mount the bridge over a workbook, the way App wires its read handler. */
function mountBridge(ctx: WorkbookReadContext): void {
  installSheetsMcpBridge({
    hasWorkbook: () => true,
    context: () => ({}),
    readCells: (addresses, sheetId) => readCellsForMcp(ctx, addresses, sheetId),
    sheets: () => SHEETS,
    focusSheet: () => {},
    applyOps: async () => ({ ok: true }),
    saveTo: async () => ({ ok: true }),
  })
}

/** One `read_sheet` over the bridge, as an external agent sends it. */
async function readSheet(addresses: string[]): Promise<Record<string, { value: unknown }>> {
  const requestId = (nextRequestId += 1)
  const before = reportMcpResult.mock.calls.length
  commandListener!({ requestId, command: 'read_sheet', payload: { addresses, sheet: 'Customers' } })
  await vi.waitFor(() => expect(reportMcpResult.mock.calls.length).toBe(before + 1))
  const reply = reportMcpResult.mock.calls[before]![0] as {
    ok: boolean
    result: { cells: Record<string, { value: unknown }> }
  }
  expect(reply.ok).toBe(true)
  return reply.result.cells
}

describe('between a save and the marks of the reopened workbook', () => {
  it('withholds from read_sheet until the marks land, then answers', async () => {
    const loadRef = { current: REDACTIONS_NONE }
    mountBridge(workbookContext(loadRef))
    const read = pendingRead()
    reopen(loadRef, read.promise)

    const early = await readSheet(['A2', 'B2'])
    expect(JSON.stringify(early)).not.toContain(PHONE)
    expect(JSON.stringify(early)).not.toContain(NAME)
    expect(early.B2).toEqual({ value: '{{private}}' })

    read.land(MARKS_READ)
    await vi.waitFor(() => expect(loadRef.current.status).toBe('loaded'))

    const late = await readSheet(['A2', 'B2'])
    expect(late.A2).toEqual({ value: NAME })
    expect(late.B2).toEqual({ value: '{{client phone}}' })
  })

  it('answers normally once a workbook with no marks has loaded', async () => {
    const loadRef = { current: REDACTIONS_NONE }
    mountBridge(workbookContext(loadRef))
    const read = pendingRead()
    reopen(loadRef, read.promise)

    expect(JSON.stringify(await readSheet(['B2']))).not.toContain(PHONE)

    read.land({ status: 'absent' })
    await vi.waitFor(() => expect(loadRef.current.status).toBe('loaded'))
    expect((await readSheet(['B2'])).B2).toEqual({ value: PHONE })
  })

  it('withholds from the AI readers and the write guard in the same gap', async () => {
    const loadRef = { current: REDACTIONS_NONE }
    const ctx = workbookContext(loadRef)
    const read = pendingRead()
    reopen(loadRef, read.promise)

    expect(JSON.stringify(readCells(ctx, ['A2', 'B2']))).not.toContain(PHONE)
    expect(redactionsOf(ctx).isEmpty).toBe(false)
    // the in-app tool asks the same index before it writes: a batch landing in
    // the gap could otherwise overwrite a cell whose mark is still on its way
    const proposeOperations = vi.fn()
    const deps = {
      getActiveSheetInfo: () => ({ sheetId: 'sh1', sheetName: 'Customers', sheets: SHEETS }),
      redactions: () => redactionsOf(ctx),
      proposeOperations,
    } as unknown as SheetsSkillDeps
    const refused = await executeWorkbookTool(
      {
        id: 'call-1',
        name: 'propose_operations',
        input: {
          summary: 'overwrite',
          operations: [{ op: 'set_cell', sheetId: 'sh1', address: 'B2', value: 'x' }],
        },
      },
      deps,
    )
    expect(refused.isError).toBe(true)
    expect(proposeOperations).not.toHaveBeenCalled()

    read.land(MARKS_READ)
    await vi.waitFor(() => expect(loadRef.current.status).toBe('loaded'))
    expect(readCells(ctx, ['A2', 'B2'])).toEqual({
      A2: { value: NAME },
      B2: { value: '{{client phone}}' },
    })
  })

  it('keeps withholding when the read itself fails, and hands over the reason', async () => {
    const loadRef = { current: REDACTIONS_NONE }
    mountBridge(workbookContext(loadRef))
    const read = pendingRead()
    const { settled } = reopen(loadRef, read.promise)

    read.fail(new Error('the sidecar went away'))
    await vi.waitFor(() => expect(settled).toHaveLength(1))

    expect(settled[0]![0]).toEqual({ status: 'unreadable', error: 'the sidecar went away' })
    expect(settled[0]![1].error).toBe('the sidecar went away')
    expect(loadRef.current.status).toBe('unreadable')
    expect(JSON.stringify(await readSheet(['A2', 'B2']))).not.toContain(PHONE)
  })

  it('does not install the marks of a workbook that has been replaced', async () => {
    const loadRef = { current: REDACTIONS_NONE }
    mountBridge(workbookContext(loadRef))
    const stale = pendingRead()
    let current = true
    const first = reopen(loadRef, stale.promise, { isCurrent: () => current })
    // a second open supersedes the first before its marks arrive
    current = false
    const fresh = pendingRead()
    reopen(loadRef, fresh.promise)

    // the old workbook withheld nothing; that says nothing about the new one
    stale.land({ status: 'absent' })
    await Promise.resolve()
    await Promise.resolve()
    expect(first.settled).toHaveLength(0)
    expect(loadRef.current.status).toBe('not-loaded')
    expect(JSON.stringify(await readSheet(['B2']))).not.toContain(PHONE)

    fresh.land(MARKS_READ)
    await vi.waitFor(() => expect(loadRef.current.status).toBe('loaded'))
    expect((await readSheet(['B2'])).B2).toEqual({ value: '{{client phone}}' })
  })
})

describe('a workbook with no file behind it', () => {
  it('has nothing to wait for, so it answers at once', async () => {
    mountBridge(workbookContext({ current: REDACTIONS_NONE }))
    expect((await readSheet(['B2'])).B2).toEqual({ value: PHONE })
  })
})
