// @vitest-environment node
/**
 * The reading assistant's store calls on window.pdfApi.store (reading-assist
 * spec 5.1): each goes to its own shell channel with its arguments as given,
 * and a missing handler (standalone pdf) answers a failure, never a throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { PdfApi } from '../src/shared/ipc'

const invoke = vi.fn()
const exposed = new Map<string, unknown>()
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))
vi.mock('@genoffice/electron-utils/drop-open', () => ({ installDropOpenBridge: vi.fn() }))

const READS = [
  ['passages', 'storePassages', ['h']],
  ['highlightRuns', 'storeHighlightRuns', ['h']],
  ['highlightBlocks', 'storeHighlightBlocks', ['h', 'run1']],
  ['latestHighlight', 'storeLatestHighlight', ['h']],
  ['insights', 'storeInsights', ['h', 'ko']],
  ['deleteCounts', 'storeDeleteCounts', ['h']],
  ['pageFingerprints', 'storePageFingerprints', [{ path: 'C:\\docs\\a.pdf', password: 'pw' }]],
  ['translationRecency', 'storeTranslationRecency', ['h']],
] as const

describe('pdf preload: reading assistant store calls', () => {
  let api: PdfApi

  beforeEach(async () => {
    invoke.mockReset()
    await import('../src/preload/index')
    api = exposed.get('pdfApi') as PdfApi
  })

  it('has every read as a function on its own channel', async () => {
    invoke.mockResolvedValue({ ok: true })
    const channels = new Set<string>()
    for (const [name, channel, args] of READS) {
      const fn = (api.store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        name
      ]
      expect(typeof fn, name).toBe('function')
      expect(PDF_CHANNELS[channel], channel).toMatch(/^pdf:store-/)
      channels.add(PDF_CHANNELS[channel])
      await fn!(...args)
      expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS[channel], ...args)
    }
    expect(channels.size).toBe(READS.length)
  })

  it('sends the new write kinds through the one write channel', async () => {
    invoke.mockResolvedValue({ ok: true, removed: 2 })
    const request = { kind: 'deleteTranslationExceptEdited' as const, docHash: 'h', lang: 'en' }
    await expect(api.store.write(request)).resolves.toEqual({ ok: true, removed: 2 })
    expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS.storeWrite, request)
  })

  it('answers a missing handler as not-available', async () => {
    invoke.mockRejectedValue(new Error('No handler registered'))
    for (const [name, , args] of READS) {
      const fn = (api.store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        name
      ]!
      await expect(fn(...args), name).resolves.toMatchObject({ ok: false, error: 'not-available' })
    }
  })
})
