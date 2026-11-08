/**
 * generate_image in the sheets main process can run a subscription program:
 * the call must end when its tab is closed or the user stops the AI run. The
 * tool and the sidecar are mocked — nothing here starts a real program.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let lastContents: FakeContents
let nextId = 800
/** a tab's webContents: an id, and the `destroyed` event of a closed tab */
class FakeContents extends EventEmitter {
  id = ++nextId
  destroyed = false
  isDestroyed = () => this.destroyed
  setWindowOpenHandler = vi.fn()
  loadURL = vi.fn()
  send = vi.fn()
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'sheets-test',
    getVersion: () => '0',
    getAppPath: () => tmpdir(),
    isPackaged: false,
    on: () => {},
    once: () => {},
    whenReady: () => new Promise(() => {}),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  WebContentsView: class {
    webContents = (lastContents = new FakeContents())
  },
  desktopCapturer: {},
  dialog: {},
  net: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

// no spreadsheet engine process: a tab only needs a client object to exist
vi.mock('../src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    start(): void {}
    onProcessExit(): void {}
  },
}))

const generateImageTool = vi.fn()
vi.mock('@genoffice/ai-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-search')>()),
  generateImageTool: (...args: unknown[]) => generateImageTool(...args),
}))

// no status check either: registering the subscription channels would look for the CLIs
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { abortMediaCalls } from '@genoffice/ai-search'
import { createSheetsView } from '../src/main/sheets-main'

/** a request of a new tab that stays in flight until the test answers it */
function startRequest() {
  let answer!: (result: { url?: string; error?: string }) => void
  generateImageTool.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  // the standalone app: this main answers ai:stream-cancel itself
  createSheetsView({ includeAiHandlers: true })
  const sender = lastContents
  const result = handlers.get(IPC_CHANNELS.aiGenerateImage)!({ sender }, { prompt: 'a red kite' })
  const options = generateImageTool.mock.calls.at(-1)![2] as {
    signal: AbortSignal
    context: unknown
  }
  return { sender, signal: options.signal, options, result, answer }
}

describe('sheets:ai-generate-image, cancelling', () => {
  beforeEach(() => {
    generateImageTool.mockReset()
  })

  it('hands the tool a signal that stays live while nothing is cancelled', async () => {
    const request = startRequest()
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.options.context).toEqual({ path: 'screen', statuses: {} })
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

  it('aborts when the user stops the AI run, and leaves another tab alone', async () => {
    const stopped = startRequest()
    const other = startRequest()
    // Stop while a tool runs: the loop cancels the turn that already ended
    await handlers.get(IPC_CHANNELS.aiStreamCancel)!(
      { sender: stopped.sender },
      'turn-that-already-ended',
    )
    expect(stopped.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    stopped.answer({ error: 'cancelled' })
    other.answer({ url: 'file:///fake/out.png' })
    expect(await other.result).toEqual({ url: 'file:///fake/out.png' })
    await stopped.result
  })

  it('aborts on the stop message the suite answers for every editor', async () => {
    const stopped = startRequest()
    const other = startRequest()
    // what the docs main does on ai:stream-cancel of a tab
    abortMediaCalls(stopped.sender.id)
    expect(stopped.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    stopped.answer({ error: 'cancelled' })
    other.answer({ error: 'unavailable' })
    await Promise.all([stopped.result, other.result])
  })
})
