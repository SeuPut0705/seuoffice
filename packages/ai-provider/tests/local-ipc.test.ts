import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelLocalTestForIpc,
  inspectLocalModelForIpc,
  listLocalModelsForIpc,
  parseLocalDiscoveryInput,
  parseLocalInspectionInput,
  parseLocalTestInput,
  testLocalModelForIpc,
} from '../src/local-ipc'
import { DEFAULT_LOCAL_TIMEOUT_MS } from '../src/local-profile'

/**
 * The three `ai:local-*` payloads. A renderer (or anything else in the process
 * that can reach `ipcRenderer`) hands over whatever it likes, so every field is
 * checked here, before a request leaves the app. Invalid input is an ordinary
 * answer: `shape` for discovery and inspection, a fully skipped test result for
 * the connection test. Nothing is fetched.
 */

const BASE = 'http://127.0.0.1:11434/v1'

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseLocalDiscoveryInput', () => {
  it('accepts a bounded http(s) base URL and trims the key', () => {
    expect(parseLocalDiscoveryInput({ baseUrl: ` ${BASE} `, apiKey: ' secret ' })).toEqual({
      baseUrl: BASE,
      apiKey: 'secret',
    })
    expect(parseLocalDiscoveryInput({ baseUrl: 'https://box.local:1234/v1' })).toEqual({
      baseUrl: 'https://box.local:1234/v1',
    })
  })

  it('keeps an empty key out of the request shape', () => {
    expect(parseLocalDiscoveryInput({ baseUrl: BASE, apiKey: '   ' })).toEqual({ baseUrl: BASE })
  })

  it.each([
    ['missing object', undefined],
    ['missing url', {}],
    ['blank url', { baseUrl: '   ' }],
    ['non-string url', { baseUrl: 11434 }],
    ['non-http scheme', { baseUrl: 'file:///etc/passwd' }],
    ['not a url', { baseUrl: 'localhost:11434' }],
    ['too long', { baseUrl: `http://127.0.0.1/${'x'.repeat(2049)}` }],
    ['non-string key', { baseUrl: BASE, apiKey: 42 }],
    ['too long key', { baseUrl: BASE, apiKey: 'k'.repeat(8193) }],
  ])('rejects %s', (_name, input) => {
    expect(parseLocalDiscoveryInput(input)).toBeUndefined()
  })

  it('accepts the string limits exactly (2048 / 8192)', () => {
    const prefix = 'http://127.0.0.1/'
    const baseUrl = `${prefix}${'x'.repeat(2048 - prefix.length)}`
    expect(parseLocalDiscoveryInput({ baseUrl })).toEqual({ baseUrl })
    expect(parseLocalDiscoveryInput({ baseUrl: BASE, apiKey: 'k'.repeat(8192) })).toEqual({
      baseUrl: BASE,
      apiKey: 'k'.repeat(8192),
    })
  })
})

describe('parseLocalInspectionInput', () => {
  it('requires a bounded model id and accepts both server kinds', () => {
    expect(
      parseLocalInspectionInput({ baseUrl: BASE, model: ' qwen3:8b ', server: 'ollama' }),
    ).toEqual({ baseUrl: BASE, model: 'qwen3:8b', server: 'ollama' })
    expect(
      parseLocalInspectionInput({ baseUrl: BASE, model: 'm', server: 'openai-compatible' }),
    ).toEqual({ baseUrl: BASE, model: 'm', server: 'openai-compatible' })
    expect(parseLocalInspectionInput({ baseUrl: BASE, model: 'm' })).toEqual({
      baseUrl: BASE,
      model: 'm',
    })
  })

  it.each([
    ['missing model', { baseUrl: BASE }],
    ['blank model', { baseUrl: BASE, model: '   ' }],
    ['non-string model', { baseUrl: BASE, model: 7 }],
    ['too long model', { baseUrl: BASE, model: 'm'.repeat(257) }],
    ['unknown server kind', { baseUrl: BASE, model: 'm', server: 'vllm' }],
    ['non-string server kind', { baseUrl: BASE, model: 'm', server: 1 }],
    ['bad url', { baseUrl: 'ftp://box/v1', model: 'm' }],
  ])('rejects %s', (_name, input) => {
    expect(parseLocalInspectionInput(input)).toBeUndefined()
  })

  it('accepts a model id of exactly 256 characters', () => {
    const model = 'm'.repeat(256)
    expect(parseLocalInspectionInput({ baseUrl: BASE, model })).toEqual({ baseUrl: BASE, model })
  })
})

describe('parseLocalTestInput', () => {
  it('defaults the budget when the field is absent', () => {
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm' })).toEqual({
      baseUrl: BASE,
      model: 'm',
      timeoutMs: DEFAULT_LOCAL_TIMEOUT_MS,
    })
  })

  it('accepts whole milliseconds inside 60,000..600,000', () => {
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', timeoutMs: 60_000 })).toMatchObject({
      timeoutMs: 60_000,
    })
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', timeoutMs: 600_000 })).toMatchObject({
      timeoutMs: 600_000,
    })
  })

  it.each([59_999, 600_001, 60_000.5, NaN, Infinity, '60000', null])(
    'rejects a timeout of %s',
    (timeoutMs) => {
      expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', timeoutMs })).toBeUndefined()
    },
  )

  it('rejects the same base URL and model problems as inspection', () => {
    expect(parseLocalTestInput({ baseUrl: BASE })).toBeUndefined()
    expect(parseLocalTestInput({ baseUrl: 'javascript:alert(1)', model: 'm' })).toBeUndefined()
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm'.repeat(257) })).toBeUndefined()
  })

  it('carries the typed-model flag only when it is true', () => {
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', typed: true })).toMatchObject({
      typed: true,
    })
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', typed: false })).not.toHaveProperty(
      'typed',
    )
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', typed: 'yes' })).toBeUndefined()
  })
})

describe('IPC handlers', () => {
  it('answers discovery with shape and sends nothing for a bad payload', async () => {
    const fetchMock = stubFetch(() => new Response('{}'))
    await expect(listLocalModelsForIpc({ baseUrl: 'ftp://box/v1' })).resolves.toEqual({
      ok: false,
      errorCode: 'shape',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers inspection with shape and sends nothing for a bad payload', async () => {
    const fetchMock = stubFetch(() => new Response('{}'))
    await expect(
      inspectLocalModelForIpc({ baseUrl: BASE, model: 'm', server: 'vllm' }),
    ).resolves.toEqual({ ok: false, errorCode: 'shape' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers the connection test with every check skipped and no request', async () => {
    const fetchMock = stubFetch(() => new Response('{}'))
    const result = await testLocalModelForIpc({ baseUrl: BASE, model: 'm', timeoutMs: 10 })
    expect(result).toMatchObject({
      server: { status: 'skip' },
      model: { status: 'skip' },
      chat: { status: 'skip' },
      tools: { status: 'skip' },
      elapsedMs: 0,
      inputError: 'shape',
    })
    expect(typeof result.checkedAt).toBe('number')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes a valid discovery payload to the probe', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(listLocalModelsForIpc({ baseUrl: BASE })).resolves.toEqual({
      ok: true,
      server: 'ollama',
      models: [{ id: 'qwen3:8b' }],
    })
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('cancelling a connection test by id', () => {
  const TAGS = 'http://127.0.0.1:11434/api/tags'
  const CHAT = 'http://127.0.0.1:11434/v1/chat/completions'

  /** a server that lists the model and never answers chat until aborted */
  function hangingChat(): { chatSignals: AbortSignal[]; started: Promise<void> } {
    const chatSignals: AbortSignal[] = []
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === TAGS) {
          return Promise.resolve(
            new Response(JSON.stringify({ models: [{ name: 'm' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        if (url === CHAT) {
          const signal = init.signal as AbortSignal
          chatSignals.push(signal)
          markStarted()
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('This operation was aborted', 'AbortError')),
              { once: true },
            )
          })
        }
        return Promise.resolve(new Response('{}', { status: 404 }))
      }),
    )
    return { chatSignals, started }
  }

  it('keeps a valid test id and refuses a malformed one', () => {
    expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', testId: 'a1-B_2' })).toMatchObject({
      testId: 'a1-B_2',
    })
    for (const testId of ['', 'has space', 'x'.repeat(129), 42, {}]) {
      expect(parseLocalTestInput({ baseUrl: BASE, model: 'm', testId })).toBeUndefined()
    }
  })

  it('aborts the request in this process, not only the wait for it', async () => {
    const { chatSignals, started } = hangingChat()
    const running = testLocalModelForIpc(
      { baseUrl: BASE, model: 'm', timeoutMs: 600_000, testId: 'run-1' },
      { owner: 7 },
    )
    await started
    expect(cancelLocalTestForIpc({ testId: 'run-1' }, 7)).toBe(true)
    const result = await running
    expect(chatSignals[0]!.aborted).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(result.tools).toEqual({ status: 'skip' })
    // finished: the id is no longer known
    expect(cancelLocalTestForIpc({ testId: 'run-1' }, 7)).toBe(false)
  })

  it('does not let another window cancel the test, and ends it when the asking window closes', async () => {
    const { chatSignals, started } = hangingChat()
    const outer = new AbortController()
    const running = testLocalModelForIpc(
      { baseUrl: BASE, model: 'm', timeoutMs: 600_000, testId: 'run-2' },
      { owner: 1, signal: outer.signal },
    )
    await started
    expect(cancelLocalTestForIpc({ testId: 'run-2' }, 2)).toBe(false)
    expect(cancelLocalTestForIpc('run-2', 2)).toBe(false)
    expect(chatSignals[0]!.aborted).toBe(false)
    outer.abort()
    const result = await running
    expect(chatSignals[0]!.aborted).toBe(true)
    expect(result.cancelled).toBe(true)
  })

  it('answers false for an unknown or malformed id', () => {
    expect(cancelLocalTestForIpc({ testId: 'nobody' }, 1)).toBe(false)
    expect(cancelLocalTestForIpc({ testId: '../x' }, 1)).toBe(false)
    expect(cancelLocalTestForIpc(undefined, 1)).toBe(false)
  })
})
