/// The renderer half of the ODS export: the pending edits travel with the
/// request instead of being saved first, and a Save As that ends on the ODS
/// format runs the export only after the save gate has let the save go.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/toast-bus', () => ({ showToast: vi.fn() }))

import { handleExportOds, saveThenExportOds } from '../src/renderer/ods-export'
import { createSaveGate } from '../src/renderer/save-scheduler'

const SESSION = '00000000-0000-4000-b000-000000000001'
const exportOds = vi.fn()
const messages: string[] = []
const requestSaveAs = vi.fn()

function context(pendingEdits: () => Promise<unknown>) {
  return {
    lazyWorkbookRef: { current: { file: { sessionId: SESSION } } },
    setMessage: (message: string) => {
      messages.push(message)
    },
    pendingEdits,
    requestSaveAs,
  } as never
}

beforeEach(() => {
  exportOds.mockReset()
  messages.length = 0
  requestSaveAs.mockReset()
  ;(globalThis as { window?: unknown }).window = { desktopApi: { exportOds } }
})

describe('handleExportOds', () => {
  it('sends the pending edits along instead of saving the workbook', async () => {
    const workbook = { sessionId: SESSION, mode: 'save', edits: [] }
    exportOds.mockResolvedValue({ canceled: false, path: '/docs/a.ods' })

    const written = await handleExportOds(
      context(async () => workbook),
      '/docs/a.ods',
    )

    expect(written).toBe(true)
    expect(exportOds).toHaveBeenCalledWith({
      sessionId: SESSION,
      targetPath: '/docs/a.ods',
      workbook,
    })
  })

  it('takes the person into Save As when the refusal of a marked workbook offered .xlsx', async () => {
    exportOds.mockResolvedValue({ canceled: true, reason: 'redacted', saveAsXlsxInstead: true })

    const written = await handleExportOds(context(async () => ({ sessionId: SESSION })))

    expect(written).toBe(false)
    expect(requestSaveAs).toHaveBeenCalledTimes(1)
  })

  it('only says nothing was exported when the person leaves the refusal', async () => {
    exportOds.mockResolvedValue({ canceled: true, reason: 'redacted' })

    const written = await handleExportOds(context(async () => ({ sessionId: SESSION })))

    expect(written).toBe(false)
    expect(requestSaveAs).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it('does not export when the edits could not be gathered', async () => {
    const written = await handleExportOds(context(async () => null))

    expect(written).toBe(false)
    expect(exportOds).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it('does not export edits gathered for a session that was swapped away', async () => {
    const stale = { sessionId: '00000000-0000-4000-b000-0000000000ff', mode: 'save', edits: [] }

    const written = await handleExportOds(context(async () => stale))

    expect(written).toBe(false)
    expect(exportOds).not.toHaveBeenCalled()
  })
})

describe('saveThenExportOds', () => {
  it('exports after the save gate is free, so the two never wait on each other', async () => {
    const gate = createSaveGate()
    const order: string[] = []
    // the export gathers its edits through the same gate the Save As holds
    const exportTo = async (targetPath: string): Promise<void> => {
      await gate.run(async () => {
        order.push(`edits for ${targetPath}`)
      })
    }

    const outcome = await saveThenExportOds(
      () =>
        gate.run(async () => {
          order.push('save as')
          return { ok: false, odsSaveAsPath: '/docs/a.ods' }
        }),
      exportTo,
    )

    expect(outcome).toEqual({ ok: false })
    expect(order).toEqual(['save as', 'edits for /docs/a.ods'])
    // a later save is not stuck behind them
    await expect(gate.run(async () => 'next save')).resolves.toBe('next save')
    await Promise.resolve()
    expect(gate.busy).toBe(false)
  })

  it('hands an ordinary save straight back', async () => {
    const exportTo = vi.fn()

    const outcome = await saveThenExportOds(
      async () => ({ ok: true, path: '/docs/a.xlsx' }),
      exportTo,
    )

    expect(outcome).toEqual({ ok: true, path: '/docs/a.xlsx' })
    expect(exportTo).not.toHaveBeenCalled()
  })
})
