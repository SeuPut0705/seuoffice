// @vitest-environment node
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let lastContents: FakeContents
let nextId = 700
/** a tab's webContents: an id, and the `destroyed` event of a closed tab */
class FakeContents extends EventEmitter {
  id = ++nextId
  destroyed = false
  isDestroyed = () => this.destroyed
  setWindowOpenHandler = vi.fn()
  loadURL = vi.fn()
  loadFile = vi.fn()
  send = vi.fn()
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
  net: {},
  protocol: { handle: vi.fn() },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
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

// the process-wide statuses of the subscription service (registered by the docs main in the shell)
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  sharedSubscriptionStatuses: () => ({}),
}))

import { abortMediaCalls } from '@genoffice/ai-search'
import { createHtmlView } from '../src/main/html-main'
import { HTML_CHANNELS } from '../src/shared/ipc'

/** a request that stays in flight until the test answers it */
function startRequest() {
  let answer!: (result: { url?: string; error?: string }) => void
  generateImageTool.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  createHtmlView(null)
  const sender = lastContents
  const result = handlers.get(HTML_CHANNELS.aiGenerateImage)!({ sender }, { prompt: 'a red kite' })
  const signal: AbortSignal = generateImageTool.mock.calls.at(-1)![2].signal
  return { sender, signal, result, answer }
}

describe('html:ai-generate-image, cancelling', () => {
  beforeEach(() => {
    generateImageTool.mockReset()
  })

  it('hands the tool a signal that stays live while nothing is cancelled', async () => {
    const request = startRequest()
    expect(request.signal).toBeInstanceOf(AbortSignal)
    const options = generateImageTool.mock.calls[0]![2]
    expect(options.context).toEqual({ path: 'screen', statuses: {} })
    expect(Array.isArray(options.mediaRoots)).toBe(true)
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
