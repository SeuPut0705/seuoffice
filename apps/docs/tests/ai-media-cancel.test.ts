// @vitest-environment node
/**
 * generate_image / analyze_media in the docs main process can run a
 * subscription program: the call must end when its tab is closed or the user
 * stops the AI run. The tools are mocked — nothing here starts a real CLI.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'docs-test',
    getVersion: () => '0',
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
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: {},
  net: {},
  session: {},
  shell: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

const generateImageTool = vi.fn()
const analyzeMediaTool = vi.fn()
// the real cancellation helper, by path: this workspace's test aliases do not reach the
// rest of the package, and the handlers under test use nothing else of it
vi.mock('@genoffice/ai-search', async () => ({
  ...(await import('../../../packages/ai-search/src/media-call-abort')),
  generateImageTool: (...args: unknown[]) => generateImageTool(...args),
  analyzeMediaTool: (...args: unknown[]) => analyzeMediaTool(...args),
  documentMediaRoots: () => [],
  // the Codex CLI image backend is registered when the AI IPC is: this test is only
  // about cancellation, so a stub generator and a no-op registration are enough
  createCodexImageCliGenerator: () => async () => ({ bytes: new Uint8Array(), mime: 'image/png' }),
  registerCodexImageGenerator: () => {},
}))

// no status check either: registering the subscription channels would look for the CLIs
vi.mock('@genoffice/ai-provider/subscription', () => ({
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))
vi.mock('@genoffice/ai-provider/codex-app-server', () => ({
  shutdownCodexAppServers: () => {},
}))
vi.mock('@genoffice/ai-provider/custom-models', () => ({}))
// nothing here is stored lazily: every media reference goes to the tool as given
vi.mock('../src/main/lazy-media', () => ({ readLazyMedia: async () => null }))
vi.mock('../src/main/lazy-media-inline', () => ({}))

import { withMediaCallSignal } from '../../../packages/ai-search/src/media-call-abort'
import { registerAiIpc } from '../src/main/docs-main'

let nextId = 100
/** a tab's webContents: an id, and the `destroyed` event of a closed tab */
class FakeContents extends EventEmitter {
  id = ++nextId
  destroyed = false
  isDestroyed = () => this.destroyed
  send = vi.fn()
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const CALLS = [
  {
    channel: 'docs:ai-generate-image',
    tool: generateImageTool,
    op: { prompt: 'a red kite' },
    done: { url: 'file:///fake/out.png' },
  },
  {
    channel: 'docs:analyze-media',
    tool: analyzeMediaTool,
    op: { mediaUrls: ['/docs/photo.png'], requirements: 'describe' },
    done: { text: 'a photo' },
  },
] as const

beforeAll(() => {
  registerAiIpc()
})

beforeEach(() => {
  generateImageTool.mockReset()
  analyzeMediaTool.mockReset()
})

describe.each(CALLS)('$channel, cancelling', ({ channel, tool, op, done }) => {
  /** a request that stays in flight until the test answers it */
  async function startRequest(sender = new FakeContents()) {
    let answer!: (result: unknown) => void
    tool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const result = handlers.get(channel)!({ sender }, op)
    // analyze_media resolves lazily stored pictures before it reaches the tool
    await vi.waitFor(() => expect(tool).toHaveBeenCalled())
    const options = tool.mock.calls.at(-1)![2] as { signal: AbortSignal; context: unknown }
    return { sender, signal: options.signal, options, result, answer }
  }

  it('hands the tool a signal that stays live while nothing is cancelled', async () => {
    const request = await startRequest()
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.options.context).toEqual({ path: 'screen', statuses: {} })
    request.answer(done)
    expect(await request.result).toEqual(done)
    expect(request.signal.aborted).toBe(false)
  })

  it('aborts when the tab that asked is closed', async () => {
    const request = await startRequest()
    request.sender.destroy()
    expect(request.signal.aborted).toBe(true)
    request.answer({ error: 'cancelled' })
    await request.result
  })

  it('aborts when the user stops the AI run, and leaves another tab alone', async () => {
    const stopped = await startRequest()
    tool.mockClear()
    const other = await startRequest()
    // Stop while a tool runs: the loop cancels the turn that already ended
    await handlers.get('ai:stream-cancel')!({ sender: stopped.sender }, 'turn-that-already-ended')
    expect(stopped.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    stopped.answer({ error: 'cancelled' })
    other.answer(done)
    expect(await other.result).toEqual(done)
    await stopped.result
  })
})

describe('ai:stream-cancel in the suite', () => {
  it('ends the media calls another editor main started for the same tab', async () => {
    // slides, sheets, pdf, markdown and html answer their own media channels, but their
    // stop message arrives here: the calls in flight are kept per tab for the whole process
    const tab = new FakeContents()
    const otherTab = new FakeContents()
    const pending = (sender: FakeContents) => {
      let signal!: AbortSignal
      void withMediaCallSignal(sender, (s) => {
        signal = s
        return new Promise<void>(() => {})
      })
      return signal
    }
    const mine = pending(tab)
    const theirs = pending(otherTab)
    await handlers.get('ai:stream-cancel')!({ sender: tab }, 'turn-that-already-ended')
    expect(mine.aborted).toBe(true)
    expect(theirs.aborted).toBe(false)
  })
  it("a document job's request-scoped cancel leaves the tab's media calls alone; Stop still ends them", async () => {
    const tab = new FakeContents()
    let signal!: AbortSignal
    void withMediaCallSignal(tab, (s) => {
      signal = s
      return new Promise<void>(() => {})
    })
    // a PDF document job stops one of its calls while the AI window generates an image
    await handlers.get('ai:stream-cancel')!({ sender: tab }, 'job-call', 'request')
    expect(signal.aborted).toBe(false)
    // the AI window's Stop (no scope) still ends the tab's media calls
    await handlers.get('ai:stream-cancel')!({ sender: tab }, 'chat-turn')
    expect(signal.aborted).toBe(true)
  })
})
