// @vitest-environment node
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import { PDF_CHANNELS } from '../src/shared/ipc'

type Handler = (event: { sender: FakeContents }, ...args: any[]) => any
const handlers = new Map<string, Handler>()
let lastContents: FakeContents
let nextId = 500
class FakeContents extends EventEmitter {
  id = ++nextId
  setWindowOpenHandler = vi.fn()
  loadURL = vi.fn()
  loadFile = vi.fn()
  destroyed = false
  isDestroyed = () => this.destroyed
  send = vi.fn()
  /** the tab or window was closed */
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}
vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: () => new Promise(() => {}),
    getPath: (name: string) => join('/fake', name),
  },
  dialog: {},
  shell: {},
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {
    webContents = (lastContents = new FakeContents())
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: vi.fn(),
  },
}))

const generateImageTool = vi.fn()
vi.mock('@genoffice/ai-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-search')>()),
  generateImageTool: (...args: unknown[]) => generateImageTool(...args),
}))

const sharedSubscriptionStatuses = vi.fn()
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  sharedSubscriptionStatuses: () => sharedSubscriptionStatuses(),
}))

import { abortMediaCalls } from '@genoffice/ai-search'
import { createPdfView } from '../src/main/pdf-main'

const STATUSES: SubscriptionStatusMap = {
  'claude-code': { provider: 'claude-code', state: 'signed-out', meteredAccepted: false },
  codex: {
    provider: 'codex',
    state: 'ready',
    loginMethod: 'subscription',
    meteredAccepted: false,
  },
}

describe('pdf:generate-image handler', () => {
  beforeEach(() => {
    generateImageTool.mockReset()
    sharedSubscriptionStatuses.mockReset()
  })

  it('runs as a screen request with the live subscription statuses', async () => {
    generateImageTool.mockResolvedValue({ url: 'file:///fake/out.png' })
    sharedSubscriptionStatuses.mockReturnValue(STATUSES)
    createPdfView('/docs/report.pdf')
    const result = await handlers.get(PDF_CHANNELS.generateImage)!(
      { sender: lastContents },
      { prompt: 'a red kite', aspectRatio: '16:9' },
    )
    expect(result).toEqual({ url: 'file:///fake/out.png' })
    expect(generateImageTool).toHaveBeenCalledTimes(1)
    const [settingsPath, op, options] = generateImageTool.mock.calls[0]!
    expect(settingsPath).toBe(join('/fake', 'userData', 'ai-settings.json'))
    expect(op).toEqual({ prompt: 'a red kite', aspectRatio: '16:9' })
    expect(options.context).toEqual({ path: 'screen', statuses: STATUSES })
    // no leftover of the removed signed-out message hook
    expect(options).not.toHaveProperty('notLoggedInError')
    expect(Array.isArray(options.mediaRoots)).toBe(true)
  })

  it('reads the statuses at request time, not at registration', async () => {
    generateImageTool.mockResolvedValue({ error: 'unavailable', errorCode: 'unavailable' })
    createPdfView('/docs/report.pdf')
    const call = () =>
      handlers.get(PDF_CHANNELS.generateImage)!({ sender: lastContents }, { prompt: 'x' })

    sharedSubscriptionStatuses.mockReturnValue({})
    expect(await call()).toEqual({ error: 'unavailable', errorCode: 'unavailable' })
    expect(generateImageTool.mock.calls[0]![2].context).toEqual({ path: 'screen', statuses: {} })

    sharedSubscriptionStatuses.mockReturnValue(STATUSES)
    await call()
    expect(generateImageTool.mock.calls[1]![2].context).toEqual({
      path: 'screen',
      statuses: STATUSES,
    })
  })

  it('normalises a malformed request instead of throwing', async () => {
    generateImageTool.mockResolvedValue({ error: 'prompt must not be empty' })
    sharedSubscriptionStatuses.mockReturnValue({})
    createPdfView('/docs/report.pdf')
    await handlers.get(PDF_CHANNELS.generateImage)!({ sender: lastContents }, undefined)
    expect(generateImageTool.mock.calls[0]![1]).toEqual({ prompt: '', aspectRatio: undefined })
  })

  describe('cancelling', () => {
    /** a request that stays in flight until the test answers it */
    function startRequest() {
      let answer!: (result: { url?: string; error?: string }) => void
      generateImageTool.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      )
      createPdfView('/docs/report.pdf')
      const sender = lastContents
      const result = handlers.get(PDF_CHANNELS.generateImage)!({ sender }, { prompt: 'a red kite' })
      const signal: AbortSignal = generateImageTool.mock.calls.at(-1)![2].signal
      return { sender, signal, result, answer }
    }

    beforeEach(() => {
      sharedSubscriptionStatuses.mockReturnValue(STATUSES)
    })

    it('hands the tool a signal that stays live while nothing is cancelled', async () => {
      const request = startRequest()
      expect(request.signal).toBeInstanceOf(AbortSignal)
      request.answer({ url: 'file:///fake/out.png' })
      expect(await request.result).toEqual({ url: 'file:///fake/out.png' })
      expect(request.signal.aborted).toBe(false)
    })

    it('aborts when the tab that asked is closed', async () => {
      const request = startRequest()
      request.sender.destroy()
      expect(request.signal.aborted).toBe(true)
      request.answer({ error: 'cancelled' })
      await request.result
    })

    it('aborts when the AI run of its tab is stopped, and leaves another tab alone', async () => {
      const stopped = startRequest()
      const other = startRequest()
      // what the AI handlers do on the stop message (ai:stream-cancel) of a tab
      abortMediaCalls(stopped.sender.id)
      expect(stopped.signal.aborted).toBe(true)
      expect(other.signal.aborted).toBe(false)
      stopped.answer({ error: 'cancelled' })
      other.answer({ url: 'file:///fake/out.png' })
      expect(await other.result).toEqual({ url: 'file:///fake/out.png' })
      await stopped.result
    })
  })
})
