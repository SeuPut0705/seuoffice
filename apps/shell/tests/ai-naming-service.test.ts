import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_SUBSCRIPTION_NOTICE_VERSION,
  SEALED_PREFIX,
  setAiSecretCodec,
  type AiSubscriptionStatuses,
} from '@seuoffice/ai-provider'
import type * as AiProvider from '@seuoffice/ai-provider'

/**
 * The naming channel as a window calls it: the settings file on disk, the
 * subscription statuses of this process, and the one request that may go out.
 */

interface Reply {
  ok: boolean
  name?: string
  reason?: string
}
type Handler = (event: unknown, input: unknown) => Promise<Reply>

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, unknown>(),
  statuses: {} as Record<string, unknown>,
  chat: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  ipcMain: {
    handle: (channel: string, handler: unknown) => h.handlers.set(channel, handler),
  },
}))
vi.mock('@seuoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof AiProvider>()),
  chatForProvider: h.chat,
}))
vi.mock('@seuoffice/ai-provider/subscription', () => ({
  sharedSubscriptionStatuses: () => h.statuses,
}))

// imported after the mocks: the service binds electron and the chat call when it loads
const { AI_NAMING_SUGGEST_CHANNEL, registerAiNamingIpc } =
  await import('../src/main/ai-naming-service')

const CLAUDE_READY: AiSubscriptionStatuses = {
  'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
  codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
}

/** The first-connection notice, acknowledged in its current wording */
const NOTICE_SEEN = {
  subscriptionNoticeSeen: true,
  subscriptionNoticeVersion: AI_SUBSCRIPTION_NOTICE_VERSION,
}

function writeSettings(settings: unknown): void {
  writeFileSync(join(h.userData, 'ai-settings.json'), JSON.stringify(settings))
}

function suggest(content: string): Promise<Reply> {
  const handler = h.handlers.get(AI_NAMING_SUGGEST_CHANNEL) as Handler
  return handler({}, { content })
}

/** The provider each request went to */
function providersAsked(): unknown[] {
  return h.chat.mock.calls.map((call) => call[0])
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'ai-naming-'))
  h.statuses = CLAUDE_READY
  h.chat.mockReset()
  h.chat.mockResolvedValue({ ok: true, content: 'Quarterly revenue\n' })
  registerAiNamingIpc(() => 'en')
})

afterEach(() => {
  setAiSecretCodec(null)
  rmSync(h.userData, { recursive: true, force: true })
})

describe('ai:suggest-file-name', () => {
  it('names on the default selection when the stored settings name no provider', async () => {
    writeSettings({ providers: {}, ...NOTICE_SEEN })
    expect(await suggest('Revenue by region, third quarter')).toEqual({
      ok: true,
      name: 'Quarterly revenue',
    })
    expect(providersAsked()).toEqual(['claude-code'])
  })

  it('names on the default selection when the stored one is a provider this build dropped', async () => {
    writeSettings({ provider: 'a-provider-of-an-older-build', providers: {}, ...NOTICE_SEEN })
    expect((await suggest('Revenue by region, third quarter')).ok).toBe(true)
    expect(providersAsked()).toEqual(['claude-code'])
  })

  it('sends a key the settings file holds sealed as the plain key', async () => {
    setAiSecretCodec({
      seal: (plain) => `${SEALED_PREFIX}${Buffer.from(plain).toString('base64')}`,
      open: (sealed) => Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64').toString(),
    })
    writeSettings({
      provider: 'anthropic',
      providers: {
        anthropic: {
          apiKey: `${SEALED_PREFIX}${Buffer.from('sk-ant-plain').toString('base64')}`,
          model: 'claude-sonnet-4-6',
        },
      },
    })
    expect((await suggest('Revenue by region, third quarter')).ok).toBe(true)
    expect(providersAsked()).toEqual(['anthropic'])
    expect(h.chat.mock.calls[0]?.[1]).toMatchObject({
      apiKey: 'sk-ant-plain',
      model: 'claude-sonnet-4-6',
    })
  })

  describe('before the first-connection notice was acknowledged', () => {
    it('sends nothing to a subscription when there is no settings file yet', async () => {
      expect(await suggest('Revenue by region, third quarter')).toEqual({
        ok: false,
        reason: 'notice',
      })
      expect(providersAsked()).toEqual([])
    })

    it('sends nothing to a subscription the settings select', async () => {
      writeSettings({ provider: 'claude-code', providers: {} })
      expect(await suggest('Revenue by region, third quarter')).toEqual({
        ok: false,
        reason: 'notice',
      })
      expect(providersAsked()).toEqual([])
    })

    it('sends nothing to a subscription when only an earlier wording was acknowledged', async () => {
      // the flag alone is a file from before the notice had versions: the first wording
      for (const seen of [
        { subscriptionNoticeSeen: true, subscriptionNoticeVersion: 1 },
        { subscriptionNoticeSeen: true },
      ]) {
        writeSettings({ provider: 'auto', providers: {}, ...seen })
        expect((await suggest('Revenue by region, third quarter')).reason).toBe('notice')
      }
      expect(providersAsked()).toEqual([])
    })

    it('still names on a key provider, which the notice is not about', async () => {
      writeSettings({
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' } },
      })
      expect((await suggest('Revenue by region, third quarter')).ok).toBe(true)
      expect(providersAsked()).toEqual(['anthropic'])
    })
  })

  describe('a request that gives no name says why', () => {
    const TEXT = 'Revenue by region, third quarter'

    afterEach(() => {
      vi.useRealTimers()
    })

    it('the selected subscription is signed out', async () => {
      writeSettings({ provider: 'codex', providers: {}, ...NOTICE_SEEN })
      expect(await suggest(TEXT)).toEqual({
        ok: false,
        reason: 'not-connected',
        errorKind: 'signed-out',
        provider: 'codex',
      })
      expect(providersAsked()).toEqual([])
    })

    it('no AI is connected at all', async () => {
      h.statuses = {
        'claude-code': { provider: 'claude-code', state: 'not-installed', meteredAccepted: false },
        codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
      }
      expect(await suggest(TEXT)).toEqual({
        ok: false,
        reason: 'not-connected',
        errorKind: 'not-connected',
      })
    })

    it.each([
      ['rejects', (reject: (e: Error) => void) => reject(new Error('aborted'))],
      [
        'reports a failed reply',
        (_: unknown, resolve: (r: unknown) => void) => resolve({ ok: false, error: 'aborted' }),
      ],
    ] as const)('the provider is cut off after 30 seconds and %s', async (_name, settle) => {
      vi.useFakeTimers()
      writeSettings({ providers: {}, ...NOTICE_SEEN })
      h.chat.mockImplementation(
        (_p: unknown, _c: unknown, _s: unknown, _u: unknown, signal: AbortSignal) =>
          new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => settle(reject, resolve))
          }),
      )
      let reply: Reply | undefined
      void suggest(TEXT).then((r) => (reply = r))
      await vi.advanceTimersByTimeAsync(29_000)
      expect(reply).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reply).toEqual({ ok: false, reason: 'timeout' })
    })

    it('the provider answers with an error', async () => {
      writeSettings({ providers: {}, ...NOTICE_SEEN })
      h.chat.mockResolvedValue({ ok: false, error: 'HTTP 500' })
      expect(await suggest(TEXT)).toEqual({ ok: false, reason: 'failed' })
    })

    it('the provider call throws', async () => {
      writeSettings({ providers: {}, ...NOTICE_SEEN })
      h.chat.mockRejectedValue(new Error('spawn ENOENT'))
      expect(await suggest(TEXT)).toEqual({ ok: false, reason: 'failed' })
    })

    it('the model answers nothing that can be a file name', async () => {
      writeSettings({ providers: {}, ...NOTICE_SEEN })
      h.chat.mockResolvedValue({ ok: true, content: '\n  \n' })
      expect(await suggest(TEXT)).toEqual({ ok: false, reason: 'empty-name' })
    })

    it('there is no text to name the file from', async () => {
      writeSettings({ providers: {}, ...NOTICE_SEEN })
      expect(await suggest('  \n ')).toEqual({ ok: false, reason: 'empty-content' })
      expect(providersAsked()).toEqual([])
    })
  })
})
