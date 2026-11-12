import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAiTransientRetryDelays } from '../src/fetch'
import { generateImageWithProvider } from '../src/media-protocols'
import { carriers, closeServers, json, redirect, serve, type TestServer } from './two-servers'

/**
 * Four image APIs answer with the address of the picture instead of its bytes
 * (OpenAI-shaped `data[0].url`, DashScope, MiniMax `image_urls`, FLUX
 * `result.sample`). That address comes out of a response body, so the picture
 * is asked for without the API key, and its host may redirect freely.
 *
 * Two real servers on 127.0.0.1: the provider, and the host its answer names.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const KEY = 'secret-api-key'
const BFL = 'https://api.bfl.ai'

/** the host a result address names: it redirects once, then serves the picture */
function pictureHost(): Promise<TestServer> {
  return serve((seen, res) => {
    if (seen.path === '/out.png') return redirect(res, 302, '/delivery/out.png')
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
}

const config = (baseUrl: string | undefined, imageModel: string) => ({
  apiKey: KEY,
  imageModel,
  analysisModel: '',
  ...(baseUrl ? { baseUrl } : {}),
})

beforeEach(() => setAiTransientRetryDelays([]))

afterEach(async () => {
  vi.unstubAllGlobals()
  setAiTransientRetryDelays(null)
  await closeServers()
})

describe('the download of a result the provider names by address', () => {
  const byAddress: [
    name: string,
    answer: (picture: string) => unknown,
    run: (base: string) => Promise<{ mime: string }>,
  ][] = [
    [
      'an OpenAI-shaped image API',
      (picture) => ({ data: [{ url: picture }] }),
      (base) => generateImageWithProvider('openai', config(base, 'gpt-image-2'), { prompt: 'x' }),
    ],
    [
      'DashScope',
      (picture) => ({ output: { choices: [{ message: { content: [{ image: picture }] } }] } }),
      (base) => generateImageWithProvider('qwen', config(base, 'qwen-image-plus'), { prompt: 'x' }),
    ],
    [
      'MiniMax',
      (picture) => ({ base_resp: { status_code: 0 }, data: { image_urls: [picture] } }),
      (base) => generateImageWithProvider('minimax', config(base, 'image-01'), { prompt: 'x' }),
    ],
  ]

  it.each(byAddress)('asks the host %s names without the key', async (_name, answer, run) => {
    const host = await pictureHost()
    const provider = await serve((_seen, res) => json(res, answer(`${host.origin}/out.png`)))

    const image = await run(provider.origin)

    expect(image.mime).toBe('image/png')
    expect(carriers(provider.seen, KEY)).toEqual(['authorization'])
    expect(host.seen.map((request) => request.path)).toEqual(['/out.png', '/delivery/out.png'])
    expect(carriers(host.seen, KEY)).toEqual([])
    // and nothing else a caller could have put a credential in
    const neutral = /^(accept(-encoding|-language)?|connection|host|sec-fetch-mode|user-agent)$/
    for (const request of host.seen) {
      expect(Object.keys(request.headers).filter((name) => !neutral.test(name))).toEqual([])
    }
  })

  it('asks the host a FLUX result names without the key', async () => {
    const host = await pictureHost()
    const provider = await serve((seen, res) =>
      seen.path === '/v1/flux-2-pro'
        ? json(res, { id: 'job-1', polling_url: `${BFL}/v1/get_result?id=job-1` })
        : json(res, { status: 'Ready', result: { sample: `${host.origin}/out.png` } }),
    )
    // the polling address must be https on the provider's domain, which a local server is
    // not: requests for api.bfl.ai are carried to it as the generation built them
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      realFetch(url.startsWith(BFL) ? provider.origin + url.slice(BFL.length) : url, init),
    )

    const image = await generateImageWithProvider('bfl', config(undefined, 'flux-2-pro'), {
      prompt: 'x',
    })

    expect(image.mime).toBe('image/png')
    expect(carriers(provider.seen, KEY)).toEqual(['x-key', 'x-key'])
    expect(host.seen).toHaveLength(2)
    expect(carriers(host.seen, KEY)).toEqual([])
  }, 20_000)
})
