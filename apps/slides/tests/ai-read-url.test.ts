// @vitest-environment node
/**
 * ai:read-url in the slides main process is a standalone handler: it coerces
 * its input, hands the tool a cancellable signal, and answers a plain failure
 * object instead of throwing. The tool is mocked — nothing here touches the
 * network.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    once: () => {},
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  nativeImage: {},
  net: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env;
// nothing here renders text.
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

const readUrlTool = vi.fn()
vi.mock('@genoffice/ai-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-search')>()),
  readUrlTool: (...args: unknown[]) => readUrlTool(...args),
}))

// no status check either: registering the subscription channels would look for the CLIs
vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { registerAiIpc } from '../src/main/ai-ipc'

let nextId = 500
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

const call = (sender: FakeContents, url: unknown, offset?: unknown) =>
  handlers.get('ai:read-url')!({ sender }, url, offset) as Promise<unknown>

beforeAll(() => {
  registerAiIpc()
})

beforeEach(() => {
  readUrlTool.mockReset()
})

describe('slides ai:read-url', () => {
  it('reads the address it was given, paged by a numeric offset', async () => {
    const done = {
      ok: true,
      url: 'https://example.com/',
      text: 'hello',
      offset: 0,
      totalChars: 5,
      truncated: false,
    }
    readUrlTool.mockResolvedValueOnce(done)
    const sender = new FakeContents()

    expect(await call(sender, 'https://example.com/', 40)).toEqual(done)
    const [settingsPath, url, offset, options] = readUrlTool.mock.calls.at(-1)!
    expect(settingsPath).toBe(join(tmpdir(), 'ai-settings.json'))
    expect(url).toBe('https://example.com/')
    expect(offset).toBe(40)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
  })

  it('coerces the address to a string and a non-numeric offset to 0', async () => {
    readUrlTool.mockResolvedValueOnce({ ok: false, error: 'bad', errorCode: 'invalid_url' })
    const sender = new FakeContents()

    await call(sender, 42, '40')
    const [, url, offset] = readUrlTool.mock.calls.at(-1)!
    expect(url).toBe('42')
    expect(offset).toBe(0)
  })

  it('answers a failure object when the tool throws', async () => {
    readUrlTool.mockRejectedValueOnce(new Error('boom'))

    expect(await call(new FakeContents(), 'https://example.com/')).toEqual({
      ok: false,
      error: 'The read failed.',
      errorCode: 'network',
    })
  })

  it('aborts the download when the user stops the AI run', async () => {
    let answer!: (result: unknown) => void
    readUrlTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const sender = new FakeContents()
    const result = call(sender, 'https://example.com/')
    const signal = readUrlTool.mock.calls.at(-1)![3].signal as AbortSignal

    await handlers.get('ai:stream-cancel')!({ sender }, 'turn-that-already-ended')
    expect(signal.aborted).toBe(true)
    answer({ ok: false, error: 'The read was cancelled.', errorCode: 'network' })
    await result
  })
})
