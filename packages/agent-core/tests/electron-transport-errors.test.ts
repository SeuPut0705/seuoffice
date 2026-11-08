/**
 * The transport used to flatten every failure to one string, so the renderer
 * could not tell "the Claude subscription hit its limit, it resets at 3pm"
 * from any other error. An error chunk now carries its kind plus the provider
 * and reset time, and the app can read them without parsing the message.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createIpcTransport,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  type IpcStreamChunk,
  type IpcStreamError,
  type IpcStreamErrorCause,
  type IpcStreamStart,
  type IpcSubscriptionUsage,
  type IpcTransportOptions,
} from '../src'

interface FakeSettings {
  provider: string
}

function setup(extra: Partial<IpcTransportOptions<FakeSettings>> = {}) {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const started: IpcStreamStart<FakeSettings>[] = []
  const calls: string[] = []
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
    timeoutErrorText: () => 'timed out',
    ...extra,
  })
  const cb = {
    onDelta: vi.fn(),
    onToolCall: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn((message: string) => {
      calls.push(`onError:${message}`)
    }),
  }
  transport.stream({ system: 'sys', messages: [], tools: [] }, cb)
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
    listener?.({ requestId: started[0]!.requestId, ...chunk })
  return { cb, emit, calls }
}

describe('createIpcTransport structured errors', () => {
  it('hands the kind, provider and reset time to onStreamError before onError', () => {
    const seen: IpcStreamError[] = []
    const { cb, emit, calls } = setup({
      onStreamError: (error) => {
        seen.push(error)
        calls.push('onStreamError')
      },
    })
    emit({
      type: 'error',
      error: 'usage limit reached',
      errorCode: 'rate-limit',
      errorProvider: 'claude-code',
      errorResetsAt: 1_791_879_000_000,
    })
    expect(seen).toEqual([
      {
        kind: 'rate-limit',
        provider: 'claude-code',
        resetsAt: 1_791_879_000_000,
        message: 'usage limit reached',
      },
    ])
    expect(calls).toEqual(['onStreamError', 'onError:usage limit reached'])
    expect(cb.onError).toHaveBeenCalledTimes(1)
  })

  it('lets errorText localize any kind from its accompanying values', () => {
    const causes: IpcStreamErrorCause[] = []
    const seen: IpcStreamError[] = []
    const { cb, emit } = setup({
      errorText: (cause) => {
        causes.push(cause)
        return cause.kind === 'signed-out' ? `sign in to ${cause.provider}` : undefined
      },
      onStreamError: (error) => seen.push(error),
    })
    emit({ type: 'error', error: 'raw', errorCode: 'signed-out', errorProvider: 'codex' })
    expect(causes).toEqual([{ kind: 'signed-out', provider: 'codex' }])
    expect(cb.onError).toHaveBeenCalledWith('sign in to codex')
    expect(seen[0]).toEqual({ kind: 'signed-out', provider: 'codex', message: 'sign in to codex' })
  })

  it('falls back to the carried text when errorText has nothing for the kind', () => {
    const { cb, emit } = setup({ errorText: () => undefined })
    emit({ type: 'error', error: 'Claude Code started with tools', errorCode: 'unsafe-tools' })
    expect(cb.onError).toHaveBeenCalledWith('Claude Code started with tools')
  })

  it('a new kind with no text at all falls back to the unknown-error text', () => {
    const { cb, emit } = setup()
    emit({ type: 'error', errorCode: 'not-connected' })
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
  })

  it('errorText wins over the legacy per-code texts, which still apply without it', () => {
    const legacy = setup({ networkErrorText: () => 'offline' })
    legacy.emit({ type: 'error', error: 'fetch failed', errorCode: 'network' })
    expect(legacy.cb.onError).toHaveBeenCalledWith('offline')

    const both = setup({
      networkErrorText: () => 'offline',
      errorText: (cause) => (cause.kind === 'network' ? 'no connection' : undefined),
    })
    both.emit({ type: 'error', error: 'fetch failed', errorCode: 'network' })
    expect(both.cb.onError).toHaveBeenCalledWith('no connection')
  })

  it('reports an error chunk without a code as a kind-less failure', () => {
    const seen: IpcStreamError[] = []
    const { emit } = setup({ onStreamError: (error) => seen.push(error) })
    emit({ type: 'error', error: 'boom' })
    expect(seen).toEqual([{ message: 'boom' }])
  })

  it('reports the silence watchdog as a timeout', () => {
    vi.useFakeTimers()
    try {
      const seen: IpcStreamError[] = []
      const { cb } = setup({ onStreamError: (error) => seen.push(error) })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS)
      expect(seen).toEqual([{ kind: 'timeout', message: 'timed out' }])
      expect(cb.onError).toHaveBeenCalledWith('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing onStreamError does not swallow the failure', () => {
    const { cb, emit } = setup({
      onStreamError: () => {
        throw new Error('listener bug')
      },
    })
    emit({ type: 'error', error: 'boom' })
    expect(cb.onError).toHaveBeenCalledWith('boom')
  })
})

describe('createIpcTransport subscription side channels', () => {
  it('forwards subscription usage without ending the run', () => {
    const seen: IpcSubscriptionUsage[][] = []
    const { cb, emit } = setup({ onSubscriptionUsage: (usage) => seen.push(usage) })
    const usage: IpcSubscriptionUsage[] = [
      {
        provider: 'claude-code',
        window: 'five_hour',
        utilization: 0.86,
        resetsAt: 1_791_879_000_000,
      },
      {
        provider: 'claude-code',
        window: 'seven_day',
        utilization: 0.08,
        resetsAt: 1_792_300_000_000,
      },
    ]
    emit({ type: 'subscription-usage', subscriptionUsage: usage })
    emit({ type: 'subscription-usage' }) // payload-less chunk carries nothing
    expect(seen).toEqual([usage])
    expect(cb.onDone).not.toHaveBeenCalled()
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('tells the app when the input was truncated', () => {
    const onInputTruncated = vi.fn()
    const { cb, emit } = setup({ onInputTruncated })
    emit({ type: 'input-truncated' })
    expect(onInputTruncated).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('both side channels are optional', () => {
    const { cb, emit } = setup()
    emit({ type: 'subscription-usage', subscriptionUsage: [] })
    emit({ type: 'input-truncated' })
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledTimes(1)
  })
})
