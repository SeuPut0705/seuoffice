/**
 * The context gate stands between a renderer-side run and the main process: a
 * prompt close to the model's context window must be confirmed by the person
 * once per run before anything is sent. A declined request never starts.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_ASSUMED_TOKENS,
  CONTEXT_WARNING_RATIO,
  contextWarningFor,
  createIpcTransport,
  estimatePromptTokens,
  type AgentStreamCallbacks,
  type AgentStreamRequest,
  type AgentToolDef,
  type IpcContextGate,
  type IpcStreamChunk,
  type IpcStreamError,
  type IpcStreamStart,
  type IpcTransportOptions,
} from '../src'

interface FakeSettings {
  provider: string
}

/** ASCII text that estimates to exactly `tokens` tokens (4 ASCII characters per token) */
const ascii = (tokens: number): string => 'a'.repeat(tokens * 4)

function setup(extra: Partial<IpcTransportOptions<FakeSettings>> = {}) {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const started: IpcStreamStart<FakeSettings>[] = []
  const transport = createIpcTransport<FakeSettings>({
    onStream: (l) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    start: (request) => {
      started.push(request)
    },
    cancel: () => {},
    getSettings: () => ({ provider: 'auto' }),
    unknownErrorText: () => 'unknown error',
    ...extra,
  })
  const stream = (request: Partial<AgentStreamRequest> = {}) => {
    const cb: AgentStreamCallbacks = {
      onDelta: vi.fn(),
      onToolCall: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const handle = transport.stream({ system: '', messages: [], tools: [], ...request }, cb)
    return { cb, handle }
  }
  /** true while this transport still holds a live chunk listener (a request started) */
  const listening = () => listener !== undefined
  return { listener, started, stream, listening }
}

describe('estimatePromptTokens', () => {
  it('counts ASCII at four characters per token', () => {
    expect(estimatePromptTokens(ascii(100), [], [])).toBe(100)
    expect(estimatePromptTokens('', [{ role: 'user', text: ascii(40) }], [])).toBe(40)
  })

  it('counts other scripts at 1.5 characters per token and rounds up', () => {
    expect(estimatePromptTokens('', [{ role: 'user', text: '한'.repeat(15) }], [])).toBe(10)
    // 2/4 + 3/1.5 = 2.5 → 3
    expect(estimatePromptTokens(`aa${'한'.repeat(3)}`, [], [])).toBe(3)
  })

  it('counts tool calls, tool results and tool definitions', () => {
    const tool: AgentToolDef = { name: 'read', description: 'Read', inputSchema: {} }
    // 'read' 4 + 'Read' 4 + '{}' 2 = 10 characters → 3
    expect(estimatePromptTokens('', [], [tool])).toBe(3)
    expect(
      estimatePromptTokens(
        '',
        [
          { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: {} }] },
          { role: 'tool', results: [{ id: 'c1', name: 'read', output: 'a'.repeat(8) }] },
        ],
        [],
      ),
    ).toBe(3)
  })
})

describe('contextWarningFor', () => {
  it('stays quiet below 80% of the limit and warns at it', () => {
    expect(CONTEXT_WARNING_RATIO).toBe(0.8)
    expect(contextWarningFor(ascii(79), [], [], 100, true)).toBeUndefined()
    expect(contextWarningFor(ascii(80), [], [], 100, true)).toEqual({
      estimatedTokens: 80,
      contextTokens: 100,
      ratio: 0.8,
      known: true,
    })
  })

  it('carries an unknown context size through and assumes 4096 tokens', () => {
    expect(CONTEXT_ASSUMED_TOKENS).toBe(4096)
    expect(contextWarningFor(ascii(3300), [], [], CONTEXT_ASSUMED_TOKENS, false)).toEqual({
      estimatedTokens: 3300,
      contextTokens: CONTEXT_ASSUMED_TOKENS,
      ratio: 3300 / CONTEXT_ASSUMED_TOKENS,
      known: false,
    })
    expect(contextWarningFor(ascii(100), [], [], CONTEXT_ASSUMED_TOKENS, false)).toBeUndefined()
  })
})

describe('createIpcTransport context gate', () => {
  const limit = () => ({ limit: 100, known: true })
  const at90 = (runId?: string): Partial<AgentStreamRequest> => ({
    system: ascii(90),
    ...(runId ? { runId } : {}),
  })

  it('asks once per run and starts the second turn without asking again', () => {
    const confirmContext = vi.fn(() => true)
    const { started, stream } = setup({ contextLimit: limit, confirmContext })
    stream(at90('run-1'))
    stream(at90('run-1'))
    expect(confirmContext).toHaveBeenCalledTimes(1)
    expect(confirmContext).toHaveBeenCalledWith({
      estimatedTokens: 90,
      contextTokens: 100,
      ratio: 0.9,
      known: true,
    })
    expect(started).toHaveLength(2)
  })

  it('asks again for a new run', () => {
    const confirmContext = vi.fn(() => true)
    const { started, stream } = setup({ contextLimit: limit, confirmContext })
    stream(at90('run-1'))
    stream(at90('run-1'))
    stream(at90('run-2'))
    expect(confirmContext).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(3)
  })

  it('asks on every request when the run id is absent', () => {
    const confirmContext = vi.fn(() => true)
    const { started, stream } = setup({ contextLimit: limit, confirmContext })
    stream(at90())
    stream(at90())
    expect(confirmContext).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(2)
  })

  it('never asks for an internal request that skips the gate', () => {
    const confirmContext = vi.fn(() => true)
    const { started, stream } = setup({ contextLimit: limit, confirmContext })
    stream({ ...at90('run-1'), skipContextGate: true })
    stream({ ...at90('run-1'), skipContextGate: true })
    expect(confirmContext).not.toHaveBeenCalled()
    expect(started).toHaveLength(2)
  })

  it('does not ask, and starts, without a reported limit or below the threshold', () => {
    const confirmContext = vi.fn(() => true)
    const noLimit = setup({ confirmContext })
    noLimit.stream(at90('run-1'))
    expect(confirmContext).not.toHaveBeenCalled()
    expect(noLimit.started).toHaveLength(1)

    const small = setup({ contextLimit: limit, confirmContext })
    small.stream({ system: ascii(40), runId: 'run-1' })
    expect(confirmContext).not.toHaveBeenCalled()
    expect(small.started).toHaveLength(1)
  })

  it('reads the limit from the current settings', () => {
    const contextLimit = vi.fn(() => ({ limit: 100, known: true }))
    const { stream } = setup({ contextLimit, confirmContext: () => true })
    stream(at90('run-1'))
    expect(contextLimit).toHaveBeenCalledWith({ provider: 'auto' })
  })

  it('declining sends nothing: no start, no listener, one context-limit error', () => {
    const seen: IpcStreamError[] = []
    const { started, stream, listening } = setup({
      contextLimit: limit,
      confirmContext: () => false,
      onStreamError: (error) => seen.push(error),
    })
    const { cb } = stream(at90('run-1'))
    expect(started).toHaveLength(0)
    expect(listening()).toBe(false)
    expect(seen).toEqual([{ kind: 'context-limit', message: 'unknown error' }])
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
    expect(cb.onError).toHaveBeenCalledTimes(1)
  })

  it('declining uses the localized context-limit text when the factory supplies it', () => {
    const seen: IpcStreamError[] = []
    const { started, stream } = setup({
      contextLimit: limit,
      confirmContext: () => false,
      errorText: (cause) => (cause.kind === 'context-limit' ? 'too much context' : undefined),
      onStreamError: (error) => seen.push(error),
    })
    const { cb } = stream(at90('run-1'))
    expect(started).toHaveLength(0)
    expect(seen).toEqual([{ kind: 'context-limit', message: 'too much context' }])
    expect(cb.onError).toHaveBeenCalledWith('too much context')
  })

  it('asks again after a decline: only an accepted answer marks the run', () => {
    const confirmContext = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { started, stream } = setup({ contextLimit: limit, confirmContext })
    stream(at90('run-1'))
    stream(at90('run-1'))
    expect(confirmContext).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(1)
  })

  it('fails closed when a limit is reported but nothing can ask the person', () => {
    const { started, stream } = setup({ contextLimit: limit })
    const { cb } = stream(at90('run-1'))
    expect(started).toHaveLength(0)
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
  })

  it('shares one confirmation across transports through the shared gate', () => {
    const confirmed = new Set<string>()
    const contextGate: IpcContextGate = {
      isConfirmed: (runId) => confirmed.has(runId),
      markConfirmed: (runId) => {
        confirmed.add(runId)
      },
    }
    const firstConfirm = vi.fn(() => true)
    const secondConfirm = vi.fn(() => true)
    const first = setup({ contextLimit: limit, confirmContext: firstConfirm, contextGate })
    const second = setup({ contextLimit: limit, confirmContext: secondConfirm, contextGate })
    first.stream(at90('run-1'))
    second.stream(at90('run-1'))
    expect(firstConfirm).toHaveBeenCalledTimes(1)
    expect(secondConfirm).not.toHaveBeenCalled()
    expect(first.started).toHaveLength(1)
    expect(second.started).toHaveLength(1)

    // a different run is a different question
    second.stream(at90('run-2'))
    expect(secondConfirm).toHaveBeenCalledTimes(1)
    expect(second.started).toHaveLength(2)
  })
})
