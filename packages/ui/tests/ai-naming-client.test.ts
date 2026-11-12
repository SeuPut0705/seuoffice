/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@seuoffice/i18n'
import {
  fileNamingFailureText,
  fileNamingRunningText,
  runFileNaming,
  suggestFileName,
  type FileNameSuggestion,
  type FileNamingFailure,
} from '../src/ai-naming-client'

/**
 * A name, or the reason there is none.
 *
 * A file name is the one thing a reader cannot get back easily, so every way
 * the naming attempt can go wrong has to end with no name at all rather than a
 * wrong one, and with a reason the editor can show. These cases are the ways
 * it can go wrong.
 */

const TEXT = { content: 'Some document text' }

function stubApi(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { aiNamingApi: unknown }).aiNamingApi = {
    suggestFileName: vi.fn(async () => ({ ok: true, name: 'Quarterly plan' })),
    ...overrides,
  }
}

/** A bridge whose main process declined with `reply` */
function stubDeclined(reply: Record<string, unknown>): void {
  stubApi({ suggestFileName: vi.fn(async () => ({ ok: false, ...reply })) })
}

afterEach(() => {
  delete (window as unknown as { aiNamingApi?: unknown }).aiNamingApi
  delete (window as unknown as { aiOffice?: unknown }).aiOffice
  vi.restoreAllMocks()
})

describe('suggestFileName', () => {
  it('uses the name the model returned', async () => {
    stubApi()
    expect(await suggestFileName(TEXT)).toEqual({ ok: true, name: 'Quarterly plan' })
  })

  it('offers no name when the model declines', async () => {
    stubDeclined({ reason: 'empty-name' })
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'failed' })
  })

  // the bug this whole helper exists to be robust against: an empty name
  // arriving as a *success* would put nothing in the Save As dialog
  it('offers no name when a success carries an empty name', async () => {
    stubApi({ suggestFileName: vi.fn(async () => ({ ok: true, name: '' })) })
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'failed' })
  })

  it('offers no name when a success carries only whitespace', async () => {
    stubApi({ suggestFileName: vi.fn(async () => ({ ok: true, name: '   ' })) })
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'failed' })
  })

  it('offers no name when the call rejects', async () => {
    stubApi({
      suggestFileName: vi.fn(async () => {
        throw new Error('no handler')
      }),
    })
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'failed' })
  })

  it('offers no name when the bridge has no naming channel at all', async () => {
    ;(window as unknown as { aiNamingApi: unknown }).aiNamingApi = {}
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('offers no name in a window without a shell behind it', async () => {
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'unavailable' })
  })

  // the namespace the naming bridge must stay out of: `aiOffice` is the shell's
  // home API, and an editor window exposing a partial one would shadow it there
  it('does not look for the naming channel in the shell namespace', async () => {
    ;(window as unknown as { aiOffice: unknown }).aiOffice = {
      suggestFileName: vi.fn(async () => ({ ok: true, name: 'From the shell namespace' })),
    }
    expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('never asks about an empty document', async () => {
    const suggest = vi.fn(async () => ({ ok: true, name: 'x' }))
    stubApi({ suggestFileName: suggest })
    expect(await suggestFileName({ content: '   \n  ' })).toEqual({ ok: false, reason: 'no-text' })
    expect(suggest).not.toHaveBeenCalled()
  })

  it('hands over exactly the text it was given — the caller decides what the model may see', async () => {
    const suggest = vi.fn(async () => ({ ok: true, name: 'x' }))
    stubApi({ suggestFileName: suggest })
    // a projected view: the withheld words are already gone, replaced by the
    // reader's own label, so the model can still name the file sensibly
    await suggestFileName({ content: 'Customer phone: {{customer phone}}' })
    expect(suggest).toHaveBeenCalledWith({
      content: 'Customer phone: {{customer phone}}',
    })
  })

  it('trims the name it hands back', async () => {
    stubApi({ suggestFileName: vi.fn(async () => ({ ok: true, name: '  Quarterly plan  ' })) })
    expect(await suggestFileName(TEXT)).toEqual({ ok: true, name: 'Quarterly plan' })
  })

  describe('says why the main process sent nothing or got nothing', () => {
    it('the first-connection notice is still unread', async () => {
      stubDeclined({ reason: 'notice' })
      expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'notice' })
    })

    it('no provider is connected, and which connection is missing', async () => {
      stubDeclined({ reason: 'not-connected', errorKind: 'signed-out', provider: 'codex' })
      expect(await suggestFileName(TEXT)).toEqual({
        ok: false,
        reason: 'not-connected',
        kind: 'signed-out',
        provider: 'codex',
      })
    })

    it('no provider is connected, from a main process that names no cause', async () => {
      stubDeclined({ reason: 'not-connected' })
      expect(await suggestFileName(TEXT)).toEqual({
        ok: false,
        reason: 'not-connected',
        kind: 'not-connected',
      })
    })

    it('the provider did not answer in time', async () => {
      stubDeclined({ reason: 'timeout' })
      expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'timeout' })
    })

    it('the main process found nothing to send', async () => {
      stubDeclined({ reason: 'empty-content' })
      expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'no-text' })
    })

    it('a reason this build does not know', async () => {
      stubDeclined({ reason: 'something-newer' })
      expect(await suggestFileName(TEXT)).toEqual({ ok: false, reason: 'failed' })
    })
  })
})

const FAILURES: FileNamingFailure[] = [
  { reason: 'unavailable' },
  { reason: 'no-text' },
  { reason: 'notice' },
  { reason: 'not-connected', kind: 'not-connected' },
  { reason: 'timeout' },
  { reason: 'failed' },
]

describe('fileNamingFailureText', () => {
  it('has a sentence of its own for every reason, in every language', () => {
    for (const lang of LANGS) {
      const texts = [
        fileNamingRunningText(lang),
        ...FAILURES.map((f) => fileNamingFailureText(lang, f)),
      ]
      expect(
        texts.every((text) => text.trim() !== ''),
        lang,
      ).toBe(true)
      expect(new Set(texts).size, lang).toBe(texts.length)
    }
  })

  it('names the connection that is missing', () => {
    const text = fileNamingFailureText('en', {
      reason: 'not-connected',
      kind: 'signed-out',
      provider: 'codex',
    })
    expect(text).toContain('Codex')
    expect(text).not.toBe(
      fileNamingFailureText('en', { reason: 'not-connected', kind: 'not-connected' }),
    )
  })

  it('still says "not connected" for a cause that has no sentence of its own', () => {
    expect(fileNamingFailureText('en', { reason: 'not-connected', kind: 'timeout' })).toBe(
      fileNamingFailureText('en', { reason: 'not-connected', kind: 'not-connected' }),
    )
  })
})

/** What an editor's status surface was told, in order */
function recordingStatus(): {
  events: string[]
  status: { running(text: string | null): void; failed(text: string): void }
} {
  const events: string[] = []
  return {
    events,
    status: {
      running: (text) => events.push(text === null ? 'running:off' : `running:${text}`),
      failed: (text) => events.push(`failed:${text}`),
    },
  }
}

describe('runFileNaming', () => {
  // read when a test runs, not when the file is collected
  let RUNNING = ''
  beforeEach(() => {
    RUNNING = fileNamingRunningText('en')
  })

  it('shows that naming is running until the answer is in, then hands the name over', async () => {
    const { events, status } = recordingStatus()
    let answer: (suggestion: FileNameSuggestion) => void = () => {}
    const pending = runFileNaming(
      'en',
      status,
      () => new Promise<FileNameSuggestion>((resolve) => (answer = resolve)),
    )
    expect(events).toEqual([`running:${RUNNING}`])
    answer({ ok: true, name: 'Quarterly plan' })
    expect(await pending).toBe('Quarterly plan')
    // nothing is left on screen: a reader who cancels the dialog sees no trace
    expect(events).toEqual([`running:${RUNNING}`, 'running:off'])
  })

  it.each(FAILURES)('says why there is no name: $reason', async (failure) => {
    const { events, status } = recordingStatus()
    expect(await runFileNaming('en', status, async () => ({ ok: false, ...failure }))).toBeNull()
    expect(events).toEqual([
      `running:${RUNNING}`,
      'running:off',
      `failed:${fileNamingFailureText('en', failure)}`,
    ])
  })

  it('does not leave "running" on screen when the editor could not even ask', async () => {
    const { events, status } = recordingStatus()
    await expect(
      runFileNaming('en', status, async () => {
        throw new Error('no document')
      }),
    ).rejects.toThrow('no document')
    expect(events).toEqual([`running:${RUNNING}`, 'running:off'])
  })
})
