import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAiTransientRetryDelays } from '../src/fetch'
import {
  analyzeMediaWithProvider,
  generateImageWithProvider,
  testMediaProvider,
} from '../src/media-protocols'

/**
 * FLUX, Gemini and Microsoft Foundry take the person's API key in a header of
 * their own (`x-key`, `x-goog-api-key`, `api-key`). A redirect that is followed
 * repeats such a header at whatever address it names, so a request carrying
 * one stops at the redirect instead.
 *
 * Two real servers on 127.0.0.1 play the parts: the provider, which answers a
 * redirect, and the other party the redirect names, which records whatever
 * reaches it. The requests run on Node's own fetch.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const KEY = 'secret-api-key'
const BFL = 'https://api.bfl.ai'
/** every status fetch follows */
const REDIRECTS = [301, 302, 303, 307, 308]

interface Seen {
  method: string
  path: string
  headers: IncomingHttpHeaders
}

interface TestServer {
  origin: string
  seen: Seen[]
}

type Answer = (seen: Seen, res: ServerResponse) => void

const closers: (() => Promise<void>)[] = []

async function serve(answer: Answer): Promise<TestServer> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const entry = { method: req.method ?? '', path: req.url ?? '', headers: req.headers }
    seen.push(entry)
    // the request body is read to its end before the answer goes out
    req.resume().on('end', () => answer(entry, res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, { location })
  res.end()
}

/** the other party: it answers every request as a provider that accepts the key would */
function collector(): Promise<TestServer> {
  return serve((_seen, res) =>
    json(res, { id: 'job-1', credits: 100, status: 'Ready', result: { sample: 'x' }, models: [] }),
  )
}

/** the names of the key headers a request arrived with */
function keysIn(seen: Seen[]): string[] {
  return seen.flatMap((request) =>
    Object.entries(request.headers)
      .filter(([, value]) => String(value).includes(KEY))
      .map(([name]) => name),
  )
}

function messageOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'no error',
    (error: unknown) => String((error as Error).message),
  )
}

const REFUSED = /redirect.*API key was not sent on/is

// a refused answer is reported as it came: the retry of busy answers is fetch.test.ts's subject
beforeEach(() => setAiTransientRetryDelays([]))

afterEach(async () => {
  vi.unstubAllGlobals()
  setAiTransientRetryDelays(null)
  await Promise.all(closers.splice(0).map((close) => close()))
})

const bfl = (baseUrl?: string) => ({
  apiKey: KEY,
  imageModel: 'flux-2-pro',
  analysisModel: '',
  ...(baseUrl ? { baseUrl } : {}),
})

describe('FLUX key and a redirect', () => {
  it.each(REDIRECTS)('stops the submit at a %i and sends nothing on', async (status) => {
    const other = await collector()
    const provider = await serve((_seen, res) => redirect(res, status, `${other.origin}/v1/job`))

    const message = await messageOf(
      generateImageWithProvider('bfl', bfl(provider.origin), { prompt: 'a fox' }),
    )

    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(message).toContain(other.origin)
    expect(provider.seen.map((request) => request.path)).toEqual(['/v1/flux-2-pro'])
  })

  it.each(REDIRECTS)('fails the credential check at a %i and sends nothing on', async (status) => {
    const other = await collector()
    const provider = await serve((_seen, res) => redirect(res, status, `${other.origin}/credits`))

    const result = await testMediaProvider('bfl', bfl(provider.origin))

    expect(other.seen).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(REFUSED)
    expect(provider.seen.map((request) => request.path)).toEqual(['/v1/credits'])
  })

  it('stops at a redirect to another path of the provider too', async () => {
    const provider = await serve((seen, res) =>
      seen.path === '/v1/credits' ? redirect(res, 302, '/v2/credits') : json(res, { credits: 1 }),
    )

    const result = await testMediaProvider('bfl', bfl(provider.origin))

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(REFUSED)
    expect(provider.seen.map((request) => request.path)).toEqual(['/v1/credits'])
  })

  /**
   * A poll is only ever sent over https to the provider's own domain, which a
   * plain local server cannot be. The generation therefore runs against the
   * default `https://api.bfl.ai`, and the fetch it uses carries those requests
   * to the local provider, with the request as the generation built it; the
   * redirect is answered and handled by the real fetch and the real servers.
   */
  function bflOnLocalProvider(provider: TestServer): void {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      realFetch(url.startsWith(BFL) ? provider.origin + url.slice(BFL.length) : url, init),
    )
  }

  it('stops a poll at a redirect and sends nothing on', async () => {
    const other = await collector()
    const provider = await serve((seen, res) =>
      seen.path === '/v1/flux-2-pro'
        ? json(res, { id: 'job-1', polling_url: `${BFL}/v1/get_result?id=job-1` })
        : redirect(res, 302, `${other.origin}/v1/get_result?id=job-1`),
    )
    bflOnLocalProvider(provider)

    const message = await messageOf(generateImageWithProvider('bfl', bfl(), { prompt: 'a fox' }))

    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(provider.seen.map((request) => request.path)).toEqual([
      '/v1/flux-2-pro',
      '/v1/get_result?id=job-1',
    ])
    // both went out with the key, so the poll is the keyed request that stopped
    expect(keysIn(provider.seen)).toEqual(['x-key', 'x-key'])
  }, 20_000)

  it('still generates when nothing redirects, and follows a redirect of the keyless download', async () => {
    const provider = await serve((seen, res) => {
      if (seen.path === '/v1/flux-2-pro') {
        json(res, { id: 'job-1', polling_url: `${BFL}/v1/get_result?id=job-1` })
      } else if (seen.path === '/v1/get_result?id=job-1') {
        json(res, { status: 'Ready', result: { sample: `${provider.origin}/out.png` } })
      } else if (seen.path === '/out.png') {
        redirect(res, 302, '/delivery/out.png')
      } else {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG)
      }
    })
    bflOnLocalProvider(provider)

    const image = await generateImageWithProvider('bfl', bfl(), { prompt: 'a fox' })

    expect(image.mime).toBe('image/png')
    expect(provider.seen.map((request) => request.path)).toEqual([
      '/v1/flux-2-pro',
      '/v1/get_result?id=job-1',
      '/out.png',
      '/delivery/out.png',
    ])
    expect(keysIn(provider.seen)).toEqual(['x-key', 'x-key'])
  }, 20_000)

  it('passes the credential check when nothing redirects', async () => {
    const provider = await serve((_seen, res) => json(res, { credits: 100 }))
    expect(await testMediaProvider('bfl', bfl(provider.origin))).toEqual({ ok: true })
    expect(keysIn(provider.seen)).toEqual(['x-key'])
  })
})

describe('the other keys sent in a header of their own, and a redirect', () => {
  const gemini = (baseUrl: string) => ({
    apiKey: KEY,
    baseUrl: `${baseUrl}/v1beta`,
    imageModel: 'gemini-3.1-flash-image',
    analysisModel: 'gemini-3.7-flash',
  })
  const microsoft = (baseUrl: string) => ({
    apiKey: KEY,
    baseUrl,
    imageModel: 'MAI-Image-2',
    analysisModel: '',
  })
  const reference = { bytes: PNG, mime: 'image/png' }

  const firstRequests: [name: string, run: (base: string) => Promise<unknown>][] = [
    [
      'a Gemini image generation',
      (base) => generateImageWithProvider('gemini', gemini(base), { prompt: 'a dog' }),
    ],
    [
      'an Imagen generation',
      (base) =>
        generateImageWithProvider(
          'gemini',
          { ...gemini(base), imageModel: 'imagen-4.0-generate-001' },
          { prompt: 'a dog' },
        ),
    ],
    [
      'a Gemini media analysis',
      (base) =>
        analyzeMediaWithProvider('gemini', gemini(base), {
          media: [reference],
          requirements: 'describe',
        }),
    ],
    [
      'a Gemini file upload',
      (base) =>
        analyzeMediaWithProvider('gemini', gemini(base), {
          media: [{ bytes: new Uint8Array(18 * 1024 * 1024 + 1), mime: 'video/mp4' }],
          requirements: 'describe',
        }),
    ],
    [
      'a Microsoft image generation',
      (base) => generateImageWithProvider('microsoft', microsoft(base), { prompt: 'a dog' }),
    ],
    [
      'a Microsoft image edit',
      (base) =>
        generateImageWithProvider('microsoft', microsoft(base), {
          prompt: 'a dog',
          references: [reference],
        }),
    ],
  ]

  it.each(firstRequests)('stops %s at a redirect and sends nothing on', async (_name, run) => {
    const other = await collector()
    // 307 repeats the method and the body at the new address
    const provider = await serve((_seen, res) => redirect(res, 307, `${other.origin}/taken`))

    const message = await messageOf(run(provider.origin))

    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(provider.seen).toHaveLength(1)
  })

  it('stops the two later steps of a Gemini file upload at a redirect', async () => {
    const other = await collector()
    const video = { bytes: new Uint8Array(18 * 1024 * 1024 + 1), mime: 'video/mp4' }

    // the upload itself, at the address the start names
    const atUpload = await serve((seen, res) =>
      seen.path === '/upload/v1beta/files'
        ? json(res, {}, { 'x-goog-upload-url': `${atUpload.origin}/session` })
        : redirect(res, 307, `${other.origin}/taken`),
    )
    expect(
      await messageOf(
        analyzeMediaWithProvider('gemini', gemini(atUpload.origin), {
          media: [video],
          requirements: 'describe',
        }),
      ),
    ).toMatch(REFUSED)
    expect(atUpload.seen.map((request) => request.path)).toEqual([
      '/upload/v1beta/files',
      '/session',
    ])

    // the wait for the uploaded file to be processed
    const atPoll = await serve((seen, res) => {
      if (seen.path === '/upload/v1beta/files') {
        json(res, {}, { 'x-goog-upload-url': `${atPoll.origin}/session` })
      } else if (seen.path === '/session') {
        json(res, { file: { name: 'files/abc', state: 'PROCESSING' } })
      } else {
        redirect(res, 302, `${other.origin}/taken`)
      }
    })
    expect(
      await messageOf(
        analyzeMediaWithProvider('gemini', gemini(atPoll.origin), {
          media: [video],
          requirements: 'describe',
        }),
      ),
    ).toMatch(REFUSED)
    expect(atPoll.seen.map((request) => request.path)).toEqual([
      '/upload/v1beta/files',
      '/session',
      '/v1beta/files/abc',
    ])

    expect(other.seen).toEqual([])
  }, 30_000)

  it.each([
    ['gemini', gemini],
    ['microsoft', microsoft],
  ] as const)('fails the %s credential check at a redirect', async (id, config) => {
    const other = await collector()
    const provider = await serve((_seen, res) => redirect(res, 302, `${other.origin}/models`))

    const result = await testMediaProvider(id, config(provider.origin))

    expect(other.seen).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(REFUSED)
  })

  it('leaves a Bearer key to fetch, which drops it when a redirect leaves the origin', async () => {
    const other = await collector()
    const provider = await serve((_seen, res) => redirect(res, 302, `${other.origin}/models`))

    const result = await testMediaProvider('custom', {
      apiKey: KEY,
      baseUrl: `${provider.origin}/v1`,
      imageModel: '',
      analysisModel: '',
    })

    expect(result).toEqual({ ok: true })
    expect(keysIn(provider.seen)).toEqual(['authorization'])
    expect(other.seen).toHaveLength(1)
    expect(keysIn(other.seen)).toEqual([])
  })
})
