/**
 * Getting a free connection's key, in the main process. Two ways in:
 *
 * - OpenRouter: the browser sign-in of OpenRouter's OAuth PKCE flow. The app
 *   opens openrouter.ai in the system browser, the user signs in and allows the
 *   app there, OpenRouter sends the browser back to a one-shot server on this
 *   PC's loopback address with a code, and the code buys a key. The app never
 *   sees the OpenRouter password; there is no client id or secret.
 * - Gemini: the user makes a key in Google AI Studio and pastes it. The key is
 *   checked by listing models, which costs nothing from the free allowance.
 *
 * Node-only: it binds a socket. Every network call goes through an injectable
 * fetch so tests never reach the providers.
 */
import { createHash, randomBytes } from 'node:crypto'
// node:http is imported where a server starts: on Node 22 a static ESM import of
// it evaluates its WebSocket getter, which compiles undici's WebAssembly parser,
// and the command line reaches this module through the ChatGPT sign-in.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { aiFetch } from './fetch'
import { GEMINI_FREE_MODEL, OPENROUTER_FREE_MODELS } from './free-ai'
import type { FreeAiConnectFailure, FreeAiQuota } from './free-ai'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys'
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_KEY_INFO_URL = 'https://openrouter.ai/api/v1/key'
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

/** how long the browser sign-in may take before the waiting server gives up */
export const OPENROUTER_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

const REQUEST_TIMEOUT_MS = 20_000

/**
 * cancelled: the user pressed cancel, or a newer attempt replaced this one;
 * timeout: the browser never came back in time; denied: the provider refused
 * the sign-in; invalid: the provider rejected the key; network: the provider
 * could not be reached, or answered with something unusable.
 */
export type FreeConnectFailure = FreeAiConnectFailure

export type FreeConnectResult =
  { ok: true; apiKey: string; model: string } | { ok: false; reason: FreeConnectFailure }

/** The page the browser shows once it is back on this PC */
export interface FreeConnectPage {
  lang: string
  title: string
  body: string
}

export interface OpenRouterConnectOptions {
  /** opens the sign-in page in the system browser; false when no browser took it */
  openBrowser: (url: string) => Promise<boolean>
  /** what the browser shows after the sign-in, by outcome */
  pages: { done: FreeConnectPage; failed: FreeConnectPage }
  signal?: AbortSignal | undefined
  fetch?: FetchLike | undefined
  timeoutMs?: number | undefined
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE verifier and its S256 challenge */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** The sign-in page address for a callback port and challenge */
export function openRouterAuthUrl(port: number, challenge: string): string {
  const params = new URLSearchParams({
    callback_url: `http://localhost:${port}/callback`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** A self-contained page: no script, no outside resource */
export function freeConnectPageHtml(page: FreeConnectPage): string {
  return `<!doctype html>
<html lang="${escapeHtml(page.lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{line-height:1.6}</style>
</head><body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.body)}</p></main></body></html>`
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })
}

/**
 * Wait for the browser to come back with a code. The callback address is
 * `localhost`, which a browser may resolve to either loopback address, so the
 * server answers on both (IPv6 when this PC has it). Only loopback is bound:
 * nothing off this PC can reach it.
 */
async function waitForCode(
  options: OpenRouterConnectOptions,
  challenge: string,
): Promise<{ ok: true; code: string } | { ok: false; reason: FreeConnectFailure }> {
  const servers: Server[] = []
  let settle: (
    result: { ok: true; code: string } | { ok: false; reason: FreeConnectFailure },
  ) => void = () => {}
  const outcome = new Promise<
    { ok: true; code: string } | { ok: false; reason: FreeConnectFailure }
  >((resolve) => (settle = resolve))
  let answered = false

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' || url.pathname !== '/callback' || answered) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end()
      return
    }
    answered = true
    const code = url.searchParams.get('code')
    const page = code ? options.pages.done : options.pages.failed
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    })
    res.end(freeConnectPageHtml(page))
    settle(code ? { ok: true, code } : { ok: false, reason: 'denied' })
  }

  try {
    const { createServer } = await import('node:http')
    const primary = createServer(handle)
    servers.push(primary)
    const port = await listen(primary, 0, '127.0.0.1')
    try {
      const v6 = createServer(handle)
      await listen(v6, port, '::1')
      servers.push(v6)
    } catch {
      // no IPv6 loopback here: browsers fall back to 127.0.0.1
    }
    const timer = setTimeout(
      () => settle({ ok: false, reason: 'timeout' }),
      options.timeoutMs ?? OPENROUTER_SIGN_IN_TIMEOUT_MS,
    )
    const onAbort = () => settle({ ok: false, reason: 'cancelled' })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    else if (!(await options.openBrowser(openRouterAuthUrl(port, challenge)))) {
      settle({ ok: false, reason: 'network' })
    }
    const result = await outcome
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    return result
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    for (const server of servers) {
      server.close()
      server.closeAllConnections?.()
    }
  }
}

/** Trade the code from the browser for a key */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  fetchImpl: FetchLike = aiFetch,
  signal?: AbortSignal,
): Promise<{ ok: true; apiKey: string } | { ok: false; reason: FreeConnectFailure }> {
  try {
    const response = await fetchImpl(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: withTimeout(signal),
    })
    if (response.status === 400 || response.status === 403) return { ok: false, reason: 'denied' }
    if (!response.ok) return { ok: false, reason: 'network' }
    const body = (await response.json()) as { key?: unknown }
    return typeof body.key === 'string' && body.key.trim()
      ? { ok: true, apiKey: body.key.trim() }
      : { ok: false, reason: 'network' }
  } catch {
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'network' }
  }
}

interface OpenRouterModelEntry {
  id?: unknown
  context_length?: unknown
  supported_parameters?: unknown
}

/**
 * The free model a new OpenRouter connection runs on: the first of the tested
 * ones OpenRouter still lists with tool support, else the free model with tool
 * support and the longest context, else the first tested one (the list could
 * not be read; the run will say so if it is gone).
 */
export async function pickOpenRouterFreeModel(
  fetchImpl: FetchLike = aiFetch,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: withTimeout(signal) })
    if (!response.ok) return OPENROUTER_FREE_MODELS[0]!
    const body = (await response.json()) as { data?: unknown }
    const entries = Array.isArray(body.data) ? (body.data as OpenRouterModelEntry[]) : []
    const usable = entries.filter(
      (m): m is OpenRouterModelEntry & { id: string } =>
        typeof m.id === 'string' &&
        m.id.endsWith(':free') &&
        Array.isArray(m.supported_parameters) &&
        m.supported_parameters.includes('tools'),
    )
    const tested = OPENROUTER_FREE_MODELS.find((id) => usable.some((m) => m.id === id))
    if (tested) return tested
    const longest = usable.sort(
      (a, b) => Number(b.context_length ?? 0) - Number(a.context_length ?? 0),
    )[0]
    return longest?.id ?? OPENROUTER_FREE_MODELS[0]!
  } catch {
    return OPENROUTER_FREE_MODELS[0]!
  }
}

/** The whole OpenRouter browser sign-in: a key and the free model to run on */
export async function connectOpenRouter(
  options: OpenRouterConnectOptions,
): Promise<FreeConnectResult> {
  const fetchImpl = options.fetch ?? aiFetch
  const { verifier, challenge } = pkcePair()
  const code = await waitForCode(options, challenge)
  if (!code.ok) return code
  const key = await exchangeOpenRouterCode(code.code, verifier, fetchImpl, options.signal)
  if (!key.ok) return key
  const model = await pickOpenRouterFreeModel(fetchImpl, options.signal)
  return { ok: true, apiKey: key.apiKey, model }
}

/** How a pasted key looks before it is sent anywhere: one token, no spaces */
export function plausibleApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return /^[A-Za-z0-9._-]{20,256}$/.test(key) ? key : null
}

/** Check a pasted Gemini key by listing models: it costs nothing from the free allowance */
export async function connectGemini(
  rawKey: unknown,
  fetchImpl: FetchLike = aiFetch,
  signal?: AbortSignal,
): Promise<FreeConnectResult> {
  const apiKey = plausibleApiKey(rawKey)
  if (!apiKey) return { ok: false, reason: 'invalid' }
  try {
    const response = await fetchImpl(`${GEMINI_MODELS_URL}?pageSize=1`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: withTimeout(signal),
    })
    if (response.ok) return { ok: true, apiKey, model: GEMINI_FREE_MODEL }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid' }
    }
    return { ok: false, reason: 'network' }
  } catch {
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'network' }
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Today's free requests on an OpenRouter key; null when OpenRouter does not say */
export async function openRouterFreeQuota(
  apiKey: string,
  fetchImpl: FetchLike = aiFetch,
  signal?: AbortSignal,
): Promise<FreeAiQuota | null> {
  if (!apiKey.trim()) return null
  try {
    const response = await fetchImpl(OPENROUTER_KEY_INFO_URL, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: withTimeout(signal),
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      data?: {
        free_model_daily_requests?: { used?: unknown; limit?: unknown; remaining?: unknown }
      }
    }
    const daily = body.data?.free_model_daily_requests
    const used = count(daily?.used)
    const limit = count(daily?.limit)
    const remaining = count(daily?.remaining)
    if (used === null || limit === null || remaining === null) return null
    return { used, limit, remaining }
  } catch {
    return null
  }
}
