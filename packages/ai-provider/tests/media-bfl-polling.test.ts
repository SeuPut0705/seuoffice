import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { generateImageWithProvider } from '../src/media-protocols'

/**
 * A queued FLUX job is polled at the address the provider's first reply names,
 * and every poll carries the person's API key (`x-key`). The key may only go
 * to the provider's own host.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const KEY = 'bfl-secret-key'
const SAMPLE_URL = 'https://delivery.bfl.example/out.png'

const cfg = (baseUrl?: string) => ({
  apiKey: KEY,
  imageModel: 'flux-2-pro',
  analysisModel: '',
  ...(baseUrl ? { baseUrl } : {}),
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchCall = [url: string, init: RequestInit]

/** the `fetch` the generation runs on, with its requests recorded */
type ProviderFetch = Mock<(url: string, init: RequestInit) => Promise<Response>>

/**
 * A provider that queues the job, names `pollingUrl` (when given), answers
 * `pendingPolls` polls with Pending and the next with Ready, then serves the
 * picture. Every address is answered, so a poll that should not have gone out
 * shows up as a recorded request rather than as a hang.
 */
function bflProvider(pollingUrl: string | undefined, pendingPolls = 0): ProviderFetch {
  let polls = 0
  return vi.fn(async (url: string, _init: RequestInit) => {
    if (url.endsWith('/v1/flux-2-pro')) {
      return jsonResponse({ id: 'job-1', ...(pollingUrl ? { polling_url: pollingUrl } : {}) })
    }
    if (url === SAMPLE_URL) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return polls++ < pendingPolls
      ? jsonResponse({ status: 'Pending' })
      : jsonResponse({ status: 'Ready', result: { sample: SAMPLE_URL } })
  })
}

/** the addresses of the requests that carried the API key, in order */
function keyedUrls(fetchMock: ProviderFetch): string[] {
  return (fetchMock.mock.calls as FetchCall[])
    .filter(([, init]) => (init.headers as Record<string, string> | undefined)?.['x-key'] === KEY)
    .map(([url]) => url)
}

/** run one generation to its end with the waits between polls skipped */
async function generate(
  fetchMock: ProviderFetch,
  baseUrl?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; mime: string } | { ok: false; message: string }> {
  vi.stubGlobal('fetch', fetchMock)
  const run = generateImageWithProvider('bfl', cfg(baseUrl), { prompt: 'a fox' }, signal).then(
    (blob) => ({ ok: true as const, mime: blob.mime }),
    (error: unknown) => ({ ok: false as const, message: String((error as Error).message) }),
  )
  await vi.runAllTimersAsync()
  return run
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('FLUX polling address', () => {
  it('polls a regional host of the provider with the key', async () => {
    const provider = bflProvider('https://api.eu1.bfl.ai/v1/get_result?id=job-1')
    const result = await generate(provider)
    expect(result).toEqual({ ok: true, mime: 'image/png' })
    expect(keyedUrls(provider)).toEqual([
      'https://api.bfl.ai/v1/flux-2-pro',
      'https://api.eu1.bfl.ai/v1/get_result?id=job-1',
    ])
  })

  it('sends nothing to another host the reply names, and fails the generation', async () => {
    for (const foreign of [
      'https://collector.example/v1/get_result?id=job-1',
      // look-alikes of the provider's name
      'https://api.bfl.ai.collector.example/v1/get_result?id=job-1',
      'https://notbfl.ai/v1/get_result?id=job-1',
      'https://api.bfl.ai@collector.example/v1/get_result?id=job-1',
      // same top-level label only
      'https://bfl.collector.ai/v1/get_result?id=job-1',
    ]) {
      const provider = bflProvider(foreign)
      const result = await generate(provider)
      expect(result.ok, foreign).toBe(false)
      expect(!result.ok && result.message, foreign).toMatch(/polling address/i)
      // the submit is the only request of the whole generation
      expect(
        provider.mock.calls.map((call) => call[0]),
        foreign,
      ).toEqual(['https://api.bfl.ai/v1/flux-2-pro'])
    }
  })

  it('refuses a plain http polling address, the provider host included', async () => {
    const provider = bflProvider('http://api.bfl.ai/v1/get_result?id=job-1')
    const result = await generate(provider)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toMatch(/polling address/i)
    expect(provider.mock.calls.map((call) => call[0])).toEqual(['https://api.bfl.ai/v1/flux-2-pro'])
  })

  it('refuses a polling address that is no absolute URL', async () => {
    const provider = bflProvider('/v1/get_result?id=job-1')
    const result = await generate(provider)
    expect(result.ok).toBe(false)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('holds a configured base URL to its own host, not to the default provider', async () => {
    const base = 'https://flux.gateway.example.co.uk/bfl'
    const submit = `${base}/v1/flux-2-pro`

    const sibling = bflProvider('https://eu.gateway.example.co.uk/bfl/v1/get_result?id=job-1')
    expect((await generate(sibling, base)).ok).toBe(true)
    expect(keyedUrls(sibling)).toEqual([
      submit,
      'https://eu.gateway.example.co.uk/bfl/v1/get_result?id=job-1',
    ])

    for (const foreign of [
      // the default provider is another party for a key that was given to this gateway
      'https://api.eu1.bfl.ai/v1/get_result?id=job-1',
      // `co.uk` is a public suffix, not a domain the gateway owns
      'https://collector.co.uk/v1/get_result?id=job-1',
    ]) {
      const provider = bflProvider(foreign)
      expect((await generate(provider, base)).ok, foreign).toBe(false)
      expect(
        provider.mock.calls.map((call) => call[0]),
        foreign,
      ).toEqual([submit])
    }
  })

  it('asks for the exact host when the base URL is an IP address or a one-label name', async () => {
    for (const [base, own, foreign] of [
      [
        'https://10.0.0.5:8443',
        'https://10.0.0.5:8443/v1/get_result?id=job-1',
        'https://10.1.0.5:8443/v1/get_result?id=job-1',
      ],
      [
        'https://flux-gateway',
        'https://flux-gateway/v1/get_result?id=job-1',
        'https://other-gateway/v1/get_result?id=job-1',
      ],
    ] as const) {
      const accepted = bflProvider(own)
      expect((await generate(accepted, base)).ok, own).toBe(true)
      expect(keyedUrls(accepted), own).toEqual([`${base}/v1/flux-2-pro`, own])

      const refused = bflProvider(foreign)
      expect((await generate(refused, base)).ok, foreign).toBe(false)
      expect(
        refused.mock.calls.map((call) => call[0]),
        foreign,
      ).toEqual([`${base}/v1/flux-2-pro`])
    }
  })

  it('refuses HTTP polling even at the configured base origin, including the fallback', async () => {
    const base = 'http://127.0.0.1:8787'
    for (const address of [
      'http://127.0.0.1:8787/v1/get_result?id=job-1',
      'http://127.0.0.1:9999/v1/get_result?id=job-1',
      undefined,
    ]) {
      const provider = bflProvider(address)
      expect((await generate(provider, base)).ok).toBe(false)
      expect(provider).toHaveBeenCalledTimes(1)
    }
  })

  it('polls the base URL when the reply names no address', async () => {
    const provider = bflProvider(undefined)
    expect((await generate(provider)).ok).toBe(true)
    expect(keyedUrls(provider)).toEqual([
      'https://api.bfl.ai/v1/flux-2-pro',
      'https://api.bfl.ai/v1/get_result?id=job-1',
    ])
  })
})

describe('FLUX polling and the abort signal', () => {
  it('keeps the number of abort listeners the same however long the job takes', async () => {
    // every request of one generation carries the same guard signal
    const listeners: number[] = []
    let guard: AbortSignal | undefined
    const provider = bflProvider('https://api.bfl.ai/v1/get_result?id=job-1', 5)
    const watched = vi.fn(async (url: string, init: RequestInit) => {
      guard = init.signal as AbortSignal
      if (url.includes('get_result')) listeners.push(getEventListeners(guard, 'abort').length)
      return provider(url, init)
    })
    const result = await generate(watched)
    expect(result.ok).toBe(true)
    // six polls: five Pending, one Ready
    expect(listeners).toHaveLength(6)
    expect(new Set(listeners).size).toBe(1)
    // and nothing is left on the signal once the generation is over
    expect(getEventListeners(guard!, 'abort')).toHaveLength(0)
  })

  it('stops waiting at once when the generation is cancelled, without another poll', async () => {
    const provider = bflProvider('https://api.bfl.ai/v1/get_result?id=job-1', 100)
    vi.stubGlobal('fetch', provider)
    const cancel = new AbortController()
    const run = generateImageWithProvider('bfl', cfg(), { prompt: 'a fox' }, cancel.signal).then(
      () => 'done',
      (error: unknown) => String((error as Error).message),
    )
    // the submit and the first poll are through; the second wait is running
    await vi.advanceTimersByTimeAsync(2_000)
    expect(provider).toHaveBeenCalledTimes(2)
    cancel.abort()
    expect(await run).toMatch(/cancelled/)
    await vi.runAllTimersAsync()
    expect(provider).toHaveBeenCalledTimes(2)
  })
})
