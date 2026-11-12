/**
 * The save plumbing for the links panel: an ops-only request (Change Source on
 * an otherwise clean workbook, or a Break whose referencing cells all carry
 * error caches so the literal journal is empty) must still be a save, and the
 * request has to accept it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import { createEditJournal } from '../src/renderer/edit-journal'
import { resolveWorkbookSave } from '../src/main/workbook-save-resolve'
import {
  externalLinksRequestSchema,
  workbookSaveRequestSchema,
  type ExternalLinkOps,
} from '../src/shared/desktop-api'

const saveWorkbookEdits = vi.fn()
const writeWorkbookRecovery = vi.fn()

beforeEach(() => {
  saveWorkbookEdits.mockReset().mockResolvedValue({ canceled: true })
  writeWorkbookRecovery.mockReset().mockResolvedValue({ ok: true })
  ;(globalThis as unknown as { window: unknown }).window = {
    desktopApi: { saveWorkbookEdits, writeWorkbookRecovery },
  }
})

const OPS: ExternalLinkOps = { broken: [1], retargets: [] }

function ctx(ops: ExternalLinkOps | null): SaveContext {
  return {
    univerRef: { current: null },
    lazyWorkbookRef: {
      current: {
        editJournal: createEditJournal(),
        recalc: {
          timer: null,
          generation: 0,
          formulaCells: new Map(),
          overlay: new Map(),
          incompleteRuns: new Set(),
        },
        file: { sessionId: '11111111-1111-4111-8111-111111111111' },
      },
    } as never,
    setMessage: () => {},
    openLazyWorkbook: () => {},
    stashViewRestore: () => {},
    externalLinkOps: () => ops,
  }
}

describe('a save carrying only external-link ops', () => {
  it('reaches the file instead of answering "No edits to save"', async () => {
    await handleSave(ctx(OPS), 'save')
    expect(saveWorkbookEdits).toHaveBeenCalledTimes(1)
    const request = saveWorkbookEdits.mock.calls[0]![0] as {
      externalLinkOps: ExternalLinkOps
      edits: unknown[]
    }
    expect(request.externalLinkOps).toEqual(OPS)
    expect(request.edits).toEqual([])
  })

  it('sends the ops shape the save schema accepts', async () => {
    await handleSave(ctx(OPS), 'save')
    const request = saveWorkbookEdits.mock.calls[0]![0] as Record<string, unknown>
    expect(workbookSaveRequestSchema.safeParse(request).success).toBe(true)
  })

  it('still skips a save with no journal and no ops', async () => {
    const messages: string[] = []
    const context = { ...ctx(null), setMessage: (message: string) => messages.push(message) }
    await handleSave(context, 'save')
    expect(saveWorkbookEdits).not.toHaveBeenCalled()
    // the "nothing to save" status, in whatever locale the test run uses
    expect(messages).toHaveLength(1)
  })
})

describe('a save carrying only refreshed external-link values', () => {
  /** the panel's Update applied one value and nothing else is pending */
  function updated(): SaveContext {
    const context = ctx(null)
    const recalc = context.lazyWorkbookRef.current!.recalc as unknown as {
      externalOverlay: Map<string, Map<string, { v: number }>>
    }
    recalc.externalOverlay = new Map([['sheet-1', new Map([['1:2', { v: 20 }]])]])
    return context
  }

  async function sentRequest(): Promise<unknown> {
    await handleSave(updated(), 'save')
    expect(saveWorkbookEdits).toHaveBeenCalledTimes(1)
    return saveWorkbookEdits.mock.calls[0]![0]
  }

  it('is a request the save schema accepts', async () => {
    const parsed = workbookSaveRequestSchema.safeParse(await sentRequest())
    expect(parsed.error?.issues.map((issue) => issue.message) ?? []).toEqual([])
    expect(parsed.data?.edits).toEqual([])
  })

  it('reaches the file write with the values, through the parse the main process runs', async () => {
    // the same two steps the save handler takes before it writes
    const request = workbookSaveRequestSchema.parse(await sentRequest())
    const save = resolveWorkbookSave(new Map([['sheet-1', 'Sheet1']]), request)
    expect(save.formulaValues).toEqual([
      { sheetName: 'Sheet1', cells: [{ row: 1, column: 2, value: 20 }] },
    ])
  })

  it('still refuses a request with no values and no edits', async () => {
    const request = (await sentRequest()) as Record<string, unknown>
    const parsed = workbookSaveRequestSchema.safeParse({ ...request, formulaValues: [] })
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'A save needs at least one edit.',
    ])
  })
})

describe('the external-links request is bound to the session', () => {
  it('takes a session id, not a renderer-supplied path', () => {
    expect(externalLinksRequestSchema.safeParse({ path: '/tmp/other.xlsx' }).success).toBe(false)
    expect(
      externalLinksRequestSchema.safeParse({
        sessionId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true)
  })
})
