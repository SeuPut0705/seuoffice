import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import { createChatGptConnection } from '../src/chatgpt/connection'
import { createChatGptConnectionMemoryStore } from '../src/chatgpt/credentials'
import {
  CHATGPT_PLAN_SCOPE,
  exchangeChatGptCode,
  refreshChatGptTokens,
  revokeChatGptSession,
} from '../src/chatgpt/oauth'
import { chatChatGpt, readChatGptModels, streamChatGpt } from '../src/chatgpt/responses'
import { listCustomModels } from '../src/custom-models'
import {
  aiFetch,
  keyedFetch,
  setAiFetch,
  setAiTransientRetryDelays,
  setRescueFetch,
  type KeyedFetchBase,
} from '../src/fetch'
import { connectGemini, exchangeOpenRouterCode, openRouterFreeQuota } from '../src/free-connect'
import { listKeyProviderModelListing } from '../src/key-models'
import { inspectLocalModel, listLocalModels } from '../src/local-models'
import { testLocalModel } from '../src/local-test'
import { setGatewayTokenProvider } from '../src/protocols/gateway-complete'
import type { StreamCallbacks } from '../src/protocols/shared'
import { streamForProvider } from '../src/stream'
import type { AiProviderId } from '../src/types'
import {
  carriers,
  closeServers,
  collector,
  json,
  messageOf,
  redirect,
  serve,
  type TestServer,
} from './two-servers'

/**
 * Every request of this package that carries a credential (an API key in a
 * header, a token in `Authorization`, a sign-in code or refresh token in the
 * body) ends at a redirect instead of following it: a followed redirect
 * repeats the request, and with it the credential, at whatever address the
 * answer names.
 *
 * Two real servers on 127.0.0.1 play the parts: the provider, which answers a
 * 307 (the status that repeats method, headers and body), and the other party
 * the redirect names, which records whatever reaches it.
 */

const KEY = 'secret-api-key'
const REFUSED = /redirect.*API key was not sent on/is

const callbacks = (deltas: string[] = []): StreamCallbacks => ({
  signal: new AbortController().signal,
  onDelta: (text) => deltas.push(text),
  onToolCall: () => undefined,
})

/** a provider that answers every request with a 307 to `other` */
async function redirecting(other: TestServer): Promise<TestServer> {
  return serve((seen, res) => redirect(res, 307, `${other.origin}/taken${seen.path}`))
}

/**
 * For the requests whose address is fixed in the code (OpenAI's sign-in host,
 * OpenRouter, Google): the fetch they are given carries each to the local
 * provider, with the request exactly as the code built it, so the redirect is
 * answered and handled by the real fetch and the real servers.
 */
function carriedTo(provider: TestServer): KeyedFetchBase {
  return (url, init) => fetch(provider.origin + new URL(url).pathname + new URL(url).search, init)
}

beforeEach(() => setAiTransientRetryDelays([]))

afterEach(async () => {
  vi.unstubAllGlobals()
  setAiTransientRetryDelays(null)
  setAiFetch(null)
  setRescueFetch(null)
  setGatewayTokenProvider(null)
  await closeServers()
})

const turn = (provider: AiProviderId, model: string, base: string): Promise<void> =>
  streamForProvider(
    provider,
    { apiKey: KEY, model, baseUrl: base },
    'You edit documents.',
    [{ role: 'user', text: 'PRIVATE-QUESTION' }],
    [],
    1024,
    callbacks(),
  )

const oneShot = (provider: AiProviderId, model: string, base: string): Promise<unknown> =>
  chatForProvider(
    provider,
    { apiKey: KEY, model, baseUrl: base },
    'You name files.',
    'PRIVATE-QUESTION',
  )

describe('a chat request and a redirect', () => {
  const chats: [name: string, run: (base: string) => Promise<unknown>][] = [
    ['an Anthropic turn (x-api-key)', (base) => turn('anthropic', 'claude-sonnet-4-5', base)],
    [
      'an Anthropic one-shot (x-api-key)',
      (base) => oneShot('anthropic', 'claude-sonnet-4-5', base),
    ],
    ['a Gemini turn (x-goog-api-key)', (base) => turn('gemini', 'gemini-3.7-flash', base)],
    ['a Gemini one-shot (x-goog-api-key)', (base) => oneShot('gemini', 'gemini-3.7-flash', base)],
    ['an OpenAI-compatible turn (Authorization)', (base) => turn('custom', 'some-model', base)],
    ['an OpenAI-compatible one-shot (Authorization)', (base) => oneShot('custom', 'm', base)],
    ['a Responses API turn (Authorization)', (base) => turn('openai', 'gpt-5.5', base)],
    ['a Responses API one-shot (Authorization)', (base) => oneShot('openai', 'gpt-5.5', base)],
    ['a gateway turn (Authorization)', (base) => turn('gateway', 'm', base)],
    ['a gateway one-shot (Authorization)', (base) => oneShot('gateway', 'm', base)],
  ]

  it.each(chats)('stops %s at the redirect and sends nothing on', async (_name, run) => {
    setGatewayTokenProvider(() => KEY)
    const other = await collector()
    const provider = await redirecting(other)

    const message = await messageOf(run(provider.origin))

    // neither the key nor the conversation reached the other party
    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(message).toContain(other.origin)
    expect(carriers(provider.seen, KEY).length).toBeGreaterThan(0)
  })

  it('still streams an answer when nothing redirects', async () => {
    const provider = await serve((_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // the second half leaves once the first has been written out on its own
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', () => {
        res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    const deltas: string[] = []
    await streamForProvider(
      'custom',
      { apiKey: KEY, model: 'm', baseUrl: provider.origin },
      'sys',
      [{ role: 'user', text: 'hi' }],
      [],
      64,
      callbacks(deltas),
    )
    expect(deltas.join('')).toBe('Hello')
    expect(carriers(provider.seen, KEY)).toEqual(['authorization'])
  })
})

describe('the ChatGPT connection and a redirect', () => {
  const TOKEN = 'secret-access-token'
  const connection = () =>
    createChatGptConnection({
      store: createChatGptConnectionMemoryStore({
        hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        clientId: 'oaiapp_1',
        session: {
          accessToken: TOKEN,
          refreshToken: 'refresh-1',
          expiresAt: Date.now() + 3_600_000,
          scopes: [CHATGPT_PLAN_SCOPE],
        },
      }),
      agentName: 'x',
      fetch: async () => new Response('', { status: 500 }),
    })

  const withToken: [name: string, run: (via: KeyedFetchBase) => Promise<unknown>][] = [
    [
      'a turn',
      (via) =>
        streamChatGpt(
          { apiKey: '', model: 'gpt-5.6-sol' },
          'sys',
          [{ role: 'user', text: 'PRIVATE-QUESTION' }],
          [],
          1024,
          callbacks(),
          { fetch: via, connection: connection() },
        ),
    ],
    [
      'a one-shot',
      (via) =>
        chatChatGpt(
          { apiKey: '', model: 'gpt-5.6-sol' },
          'sys',
          'hi',
          new AbortController().signal,
          {
            fetch: via,
            connection: connection(),
          },
        ),
    ],
    ['the model list', (via) => readChatGptModels(TOKEN, via)],
  ]

  it.each(withToken)('stops %s at the redirect and sends nothing on', async (_name, run) => {
    const other = await collector({ data: [] })
    const provider = await redirecting(other)

    const message = await messageOf(run(carriedTo(provider)))

    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(carriers(provider.seen, TOKEN)).toContain('authorization')
  })

  it('does not send a sign-in code or a refresh token on', async () => {
    const other = await collector({ access_token: 'a', refresh_token: 'b', expires_in: 3600 })
    const provider = await redirecting(other)
    const via = carriedTo(provider)

    const exchanged = await exchangeChatGptCode(
      { code: 'secret-code', clientId: 'oaiapp_1', verifier: 'secret-verifier', port: 1455 },
      via,
    )
    const refreshed = await refreshChatGptTokens(
      { clientId: 'oaiapp_1', refreshToken: 'secret-refresh' },
      via,
    )

    expect(other.seen).toEqual([])
    expect(exchanged.ok).toBe(false)
    // a passing failure: the session is kept and tried again later
    expect(refreshed).toEqual({ ok: false, reason: 'failed' })
    expect(carriers(provider.seen, 'secret-')).toEqual(['body', 'body'])
  })

  it('does not send the refresh token on when the session is revoked', async () => {
    const other = await collector()
    const provider = await serve((seen, res) =>
      seen.path === '/.well-known/openid-configuration'
        ? json(res, { revocation_endpoint: 'https://auth.openai.com/oauth/revoke' })
        : redirect(res, 307, `${other.origin}/taken`),
    )

    const revoked = await revokeChatGptSession(
      { clientId: 'oaiapp_1', refreshToken: 'secret-refresh' },
      carriedTo(provider),
    )

    expect(other.seen).toEqual([])
    expect(revoked).toBe(false)
    expect(provider.seen.map((request) => request.path)).toEqual([
      '/.well-known/openid-configuration',
      '/oauth/revoke',
    ])
  })
})

describe('a model list, a key check and a redirect', () => {
  it.each(['anthropic', 'gemini', 'deepseek', 'xai'] as const)(
    'reads no %s model list through a redirect, and sends the key nowhere else',
    async (provider) => {
      const other = await collector({ data: [{ id: 'planted-model' }], models: [] })
      const vendor = await redirecting(other)

      const listing = await listKeyProviderModelListing(provider, {
        apiKey: KEY,
        baseUrl: vendor.origin,
      })

      expect(other.seen).toEqual([])
      expect(listing).toBeNull()
      expect(carriers(vendor.seen, KEY)).toHaveLength(1)
    },
  )

  it('reads no model list of a custom or local server through a redirect', async () => {
    const other = await collector({
      data: [{ id: 'planted-model' }],
      models: [{ name: 'planted' }],
    })
    const server = await redirecting(other)

    expect(await listCustomModels(`${server.origin}/v1`, KEY)).toEqual({
      models: [],
      defaultModel: '',
    })
    const local = await listLocalModels({ baseUrl: `${server.origin}/v1`, apiKey: KEY })
    await inspectLocalModel({ baseUrl: `${server.origin}/v1`, apiKey: KEY, model: 'm' })

    expect(other.seen).toEqual([])
    expect(local.ok).toBe(false)
    expect(carriers(server.seen, KEY).length).toBeGreaterThan(0)
  })

  it('runs no connection test of a local server through a redirect', async () => {
    const other = await collector({
      data: [{ id: 'm' }],
      choices: [{ message: { content: 'ok' } }],
    })
    const server = await redirecting(other)

    const result = await testLocalModel({ baseUrl: `${server.origin}/v1`, apiKey: KEY, model: 'm' })

    expect(other.seen).toEqual([])
    for (const check of [result.server, result.model, result.chat, result.tools]) {
      expect(check.status).not.toBe('pass')
    }
  })

  it('does not take a pasted Gemini key for good, or bad, when the check is redirected', async () => {
    const other = await collector({ models: [] })
    const provider = await redirecting(other)

    const result = await connectGemini('AIza-secret-api-key-0123456789', carriedTo(provider))

    expect(other.seen).toEqual([])
    // neither connected nor "the key is wrong": the provider could not be asked
    expect(result).toEqual({ ok: false, reason: 'network' })
  })

  it('does not send an OpenRouter sign-in code or key on', async () => {
    const other = await collector({
      key: 'planted-key',
      data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } },
    })
    const provider = await redirecting(other)
    const via = carriedTo(provider)

    const exchanged = await exchangeOpenRouterCode('secret-code', 'secret-verifier', via)
    const quota = await openRouterFreeQuota(KEY, via)

    expect(other.seen).toEqual([])
    expect(exchanged).toEqual({ ok: false, reason: 'network' })
    expect(quota).toBeNull()
  })
})

describe('what a followed redirect repeats', () => {
  /**
   * Electron's `net.fetch`, as it answered a probe with Electron 43.8.3 against
   * two local servers: following, it repeats every header (`Authorization`
   * included) at the new origin; told not to follow, it throws.
   */
  const electronNetFetch: KeyedFetchBase = async (url, init) => {
    let at = url
    for (;;) {
      const response = await fetch(at, { ...init, redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || location === null) return response
      if (init.redirect === 'manual') throw new Error('Redirect was cancelled')
      at = new URL(location, at).href
    }
  }

  it('Node drops Authorization when the redirect leaves the origin, and nothing else', async () => {
    const other = await collector()
    const provider = await redirecting(other)

    await fetch(`${provider.origin}/v1/x?key=${KEY}-in-query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY, 'Content-Type': 'text/plain' },
      body: `${KEY}-in-body`,
    })

    expect(other.seen).toHaveLength(1)
    expect(carriers(other.seen, KEY).sort()).toEqual(['body', 'url', 'x-api-key'])
  })

  it('keyedFetch stops there over any fetch, with the same error', async () => {
    const other = await collector()
    const provider = await redirecting(other)
    const init = { headers: { Authorization: `Bearer ${KEY}` } }

    for (const base of [undefined, fetch as KeyedFetchBase, electronNetFetch]) {
      expect(await messageOf(keyedFetch(`${provider.origin}/v1/x`, init, undefined, base))).toMatch(
        REFUSED,
      )
    }
    expect(other.seen).toEqual([])
  })

  it('a Bearer key does not ride the rescue fetch to another origin', async () => {
    const other = await collector({ choices: [{ message: { content: 'planted answer' } }] })
    const provider = await redirecting(other)
    // the first try fails at the network layer, so the request goes out again over the rescue fetch
    const failing = vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    setAiFetch(failing)
    setRescueFetch((url, init) => electronNetFetch(url, init ?? {}))

    const message = await messageOf(oneShot('custom', 'm', provider.origin))

    expect(failing).toHaveBeenCalled()
    expect(carriers(other.seen, KEY)).toEqual([])
    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
  })

  it('a request without a credential still follows its redirect', async () => {
    const provider = await serve((seen, res) =>
      seen.path === '/a' ? redirect(res, 302, '/b') : json(res, { ok: true }),
    )
    const response = await aiFetch(`${provider.origin}/a`, {})
    expect(await response.json()).toEqual({ ok: true })
  })
})
