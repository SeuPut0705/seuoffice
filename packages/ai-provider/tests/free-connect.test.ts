import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  OPENROUTER_KEYS_URL,
  connectGemini,
  connectOpenRouter,
  freeConnectPageHtml,
  openRouterAuthUrl,
  openRouterFreeQuota,
  pickOpenRouterFreeModel,
  pkcePair,
  plausibleApiKey,
} from '../src/free-connect'
import { GEMINI_FREE_MODEL, OPENROUTER_FREE_MODELS } from '../src/free-ai'

const PAGES = {
  done: { lang: 'en', title: 'Connected', body: 'Close this tab.' },
  failed: { lang: 'en', title: 'Not connected', body: 'Try again.' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** what the browser does after the sign-in: follow the callback the app gave OpenRouter */
async function browserReturns(authUrl: string, query: string): Promise<Response> {
  const callback = new URL(new URL(authUrl).searchParams.get('callback_url')!)
  // the callback names localhost; reach the server on the IPv4 loopback it always binds
  return fetch(`http://127.0.0.1:${callback.port}${callback.pathname}?${query}`)
}

describe('PKCE', () => {
  it('pairs a verifier with its S256 challenge', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('points OpenRouter back at a loopback callback', () => {
    const url = new URL(openRouterAuthUrl(51423, 'abc'))
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:51423/callback')
    expect(url.searchParams.get('code_challenge')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('escapes the page text', () => {
    const html = freeConnectPageHtml({ lang: 'en', title: '<b>x</b>', body: '"y" & z' })
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&#60;b&#62;x&#60;/b&#62;')
    expect(html).not.toContain('<script')
  })
})

describe('connectOpenRouter', () => {
  it('trades the code from the browser for a key and picks a tested free model', async () => {
    let authUrl = ''
    let page: Promise<Response> | null = null
    const providerFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENROUTER_KEYS_URL) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>
        expect(body.code).toBe('the-code')
        expect(body.code_challenge_method).toBe('S256')
        // the verifier answers the challenge that went to the browser
        const challenge = new URL(authUrl).searchParams.get('code_challenge')
        const derived = createHash('sha256')
          .update(body.code_verifier!)
          .digest('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')
        expect(derived).toBe(challenge)
        return json({ key: 'sk-or-v1-new' })
      }
      return json({
        data: [
          { id: 'paid/model', supported_parameters: ['tools'] },
          { id: 'no-tools/model:free', supported_parameters: [] },
          { id: OPENROUTER_FREE_MODELS[1], supported_parameters: ['tools'] },
        ],
      })
    })
    const result = await connectOpenRouter({
      pages: PAGES,
      fetch: providerFetch,
      openBrowser: async (url) => {
        authUrl = url
        page = browserReturns(url, 'code=the-code')
        return true
      },
    })
    expect(result).toEqual({ ok: true, apiKey: 'sk-or-v1-new', model: OPENROUTER_FREE_MODELS[1] })
    const shown = await page!
    expect(shown.headers.get('content-type')).toContain('text/html')
    expect(await shown.text()).toContain('Connected')
  })

  it('reports a refused sign-in without asking for a key', async () => {
    const providerFetch = vi.fn()
    const result = await connectOpenRouter({
      pages: PAGES,
      fetch: providerFetch,
      openBrowser: async (url) => {
        void browserReturns(url, 'error=access_denied')
        return true
      },
    })
    expect(result).toEqual({ ok: false, reason: 'denied' })
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('stops waiting on cancel and on timeout, and closes the server', async () => {
    const controller = new AbortController()
    let authUrl = ''
    const cancelled = connectOpenRouter({
      pages: PAGES,
      signal: controller.signal,
      openBrowser: async (url) => {
        authUrl = url
        return true
      },
    })
    await vi.waitFor(() => expect(authUrl).not.toBe(''))
    controller.abort()
    expect(await cancelled).toEqual({ ok: false, reason: 'cancelled' })
    await expect(browserReturns(authUrl, 'code=late')).rejects.toThrow()

    const timedOut = await connectOpenRouter({
      pages: PAGES,
      timeoutMs: 20,
      openBrowser: async () => true,
    })
    expect(timedOut).toEqual({ ok: false, reason: 'timeout' })
  })

  it('fails when no browser could be opened', async () => {
    const result = await connectOpenRouter({ pages: PAGES, openBrowser: async () => false })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })
})

describe('free models and quota', () => {
  it('falls back to the free model with tools and the longest context, then to the tested list', async () => {
    const listing = vi.fn(async () =>
      json({
        data: [
          { id: 'a:free', context_length: 8000, supported_parameters: ['tools'] },
          { id: 'b:free', context_length: 256000, supported_parameters: ['tools'] },
        ],
      }),
    )
    expect(await pickOpenRouterFreeModel(listing)).toBe('b:free')
    expect(await pickOpenRouterFreeModel(vi.fn(async () => json({}, 500)))).toBe(
      OPENROUTER_FREE_MODELS[0],
    )
  })

  it("reads today's free requests from the key info", async () => {
    const info = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-or-v1-x')
      return json({ data: { free_model_daily_requests: { used: 9, limit: 50, remaining: 41 } } })
    })
    expect(await openRouterFreeQuota('sk-or-v1-x', info)).toEqual({
      used: 9,
      limit: 50,
      remaining: 41,
    })
    expect(await openRouterFreeQuota('', info)).toBeNull()
    expect(
      await openRouterFreeQuota(
        'k',
        vi.fn(async () => json({ data: {} })),
      ),
    ).toBeNull()
  })
})

describe('connectGemini', () => {
  it('accepts a key that can list models, on the free model', async () => {
    const check = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('generativelanguage.googleapis.com')
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('AIzaSyTestKey1234567890')
      return json({ models: [] })
    })
    expect(await connectGemini('  AIzaSyTestKey1234567890 ', check)).toEqual({
      ok: true,
      apiKey: 'AIzaSyTestKey1234567890',
      model: GEMINI_FREE_MODEL,
    })
  })

  it('rejects a key the provider refuses, and anything that is not a key before sending it', async () => {
    expect(
      await connectGemini(
        'AIzaSyTestKey1234567890',
        vi.fn(async () => json({}, 400)),
      ),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    })
    const never = vi.fn()
    expect(await connectGemini('not a key', never)).toEqual({ ok: false, reason: 'invalid' })
    expect(await connectGemini(42, never)).toEqual({ ok: false, reason: 'invalid' })
    expect(never).not.toHaveBeenCalled()
    expect(plausibleApiKey('AQ.Ab8RN6J586fxDRMZP5PFhx')).toBe('AQ.Ab8RN6J586fxDRMZP5PFhx')
  })

  it('tells an unreachable provider apart from a wrong key', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await connectGemini('AIzaSyTestKey1234567890', down)).toEqual({
      ok: false,
      reason: 'network',
    })
  })
})
