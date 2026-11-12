import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AiRedirectRefusedError,
  fetchSeeingRedirects,
  keyedDownload,
  setAiTransientRetryDelays,
  type KeyedFetchBase,
} from '../src/fetch'
import { carriers, closeServers, json, redirect, serve, type TestServer } from './two-servers'

/**
 * A download asked for with a credential (a file's bytes behind an access
 * token) may be answered with a redirect to where the bytes are kept. It is
 * followed by hand: every header that could carry the credential stays behind
 * once the next address is another origin, and is never put back.
 *
 * Two real servers on 127.0.0.1 are the two origins (two ports); the requests
 * run on Node's own fetch. Plain http between them is the one exception the
 * download makes, for a request that itself went to an http address on this
 * machine; the https rule is shown through a fetch double, because a local
 * server pair has no certificate.
 */

const KEY = 'secret-credential'
const BYTES = randomBytes(256 * 1024)

/** every header a caller in this repository carries a credential in, and one a person could set */
const keyed = (): Record<string, string> => ({
  Authorization: `Bearer ${KEY}`,
  'x-goog-api-key': KEY,
  'x-api-key': KEY,
  'api-key': KEY,
  'x-key': KEY,
  Cookie: `session=${KEY}`,
  'X-Tenant-Secret': KEY,
  Accept: 'application/octet-stream',
  Range: 'bytes=0-',
})

function file(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  // in two writes: the body is a stream the caller reads, not a buffered answer
  res.write(BYTES.subarray(0, 1000), () => res.end(BYTES.subarray(1000)))
}

const refusal = (run: Promise<unknown>): Promise<AiRedirectRefusedError | string> =>
  run.then(
    () => 'no error',
    (error: unknown) => (error instanceof AiRedirectRefusedError ? error : String(error)),
  )

beforeEach(() => setAiTransientRetryDelays([]))

afterEach(async () => {
  setAiTransientRetryDelays(null)
  await closeServers()
})

describe('a download that is redirected', () => {
  it('reaches another origin without any credential header, and the file arrives whole', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((_seen, res) => redirect(res, 302, `${store.origin}/blob/1`))

    const response = await keyedDownload(`${api.origin}/files/1?alt=media`, { headers: keyed() })

    expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true)
    expect(carriers(api.seen, KEY)).toHaveLength(7)
    expect(store.seen).toHaveLength(1)
    expect(carriers(store.seen, KEY)).toEqual([])
    // what says nothing about who is asking goes along
    expect(store.seen[0]!.headers).toMatchObject({
      accept: 'application/octet-stream',
      range: 'bytes=0-',
    })
    expect(Object.keys(store.seen[0]!.headers)).not.toContain('x-tenant-secret')
  })

  it('keeps the credential on a redirect within the origin it was sent to', async () => {
    const api = await serve((seen, res) =>
      seen.path === '/files/1' ? redirect(res, 307, '/download/files/1') : file(res),
    )

    const response = await keyedDownload(`${api.origin}/files/1`, { headers: keyed() })

    expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true)
    expect(api.seen.map((request) => request.path)).toEqual(['/files/1', '/download/files/1'])
    expect(carriers(api.seen.slice(1), KEY)).toHaveLength(7)
  })

  it('does not put the credential back when a later hop returns to the first origin', async () => {
    const store: TestServer = await serve((_seen, res) => redirect(res, 302, `${api.origin}/back`))
    const api: TestServer = await serve((seen, res) =>
      seen.path === '/files/1' ? redirect(res, 302, `${store.origin}/blob/1`) : file(res),
    )

    const response = await keyedDownload(`${api.origin}/files/1`, { headers: keyed() })

    expect(response.status).toBe(200)
    await response.body?.cancel()
    expect(api.seen.map((request) => request.path)).toEqual(['/files/1', '/back'])
    expect(carriers(store.seen, KEY)).toEqual([])
    expect(carriers(api.seen.slice(1), KEY)).toEqual([])
  })

  it('follows five redirects and refuses the sixth', async () => {
    const chain = (length: number): Promise<TestServer> =>
      serve((seen, res) => {
        const step = Number(seen.path.slice(1))
        return step < length ? redirect(res, 302, `/${step + 1}`) : file(res)
      })

    const five = await chain(5)
    const response = await keyedDownload(`${five.origin}/0`, { headers: keyed() })
    expect(response.status).toBe(200)
    await response.body?.cancel()
    expect(five.seen).toHaveLength(6)

    const six = await chain(6)
    const refused = await refusal(keyedDownload(`${six.origin}/0`, { headers: keyed() }))
    expect(refused).toMatchObject({ reason: 'too-many' })
    // the sixth redirect was read, and nothing was asked of the address it named
    expect(six.seen.map((request) => request.path)).toEqual(['/0', '/1', '/2', '/3', '/4', '/5'])
  })

  it('refuses a redirect from https to plain http', async () => {
    // a fetch double: the https rule is a comparison of addresses, and a local server has no certificate
    const asked: string[] = []
    const base: KeyedFetchBase = async (url) => {
      asked.push(url)
      return new Response(null, { status: 302, headers: { location: 'http://files.example/blob' } })
    }

    const refused = await refusal(
      keyedDownload('https://api.example/files/1', { headers: keyed() }, { base }),
    )

    expect(refused).toMatchObject({ reason: 'insecure' })
    expect(asked).toEqual(['https://api.example/files/1'])
  })

  it('refuses a redirect off this machine over plain http', async () => {
    const api = await serve((_seen, res) => redirect(res, 302, 'http://files.example.invalid/blob'))
    const refused = await refusal(keyedDownload(`${api.origin}/files/1`, { headers: keyed() }))
    expect(refused).toMatchObject({ reason: 'insecure' })
    expect(api.seen).toHaveLength(1)
  })

  it('refuses any redirect when the credential is in the address', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((seen, res) =>
      seen.path.startsWith('/same')
        ? redirect(res, 302, '/elsewhere')
        : redirect(res, 302, `${store.origin}/blob`),
    )

    for (const [address, options] of [
      // a key the address names as one
      [`${api.origin}/files/1?key=${KEY}`, {}],
      [`${api.origin}/same/1?access_token=${KEY}`, {}],
      // one only the caller knows to be a credential
      [`${api.origin}/files/1?sid=${KEY}`, { keyOutsideHeaders: true }],
    ] as const) {
      const refused = await refusal(keyedDownload(address, {}, options))
      expect(refused, address).toMatchObject({ reason: 'not-followed' })
    }
    expect(store.seen).toEqual([])
    expect(api.seen).toHaveLength(3)
  })

  it('does not repeat a request body at another origin', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((_seen, res) => redirect(res, 307, `${store.origin}/blob`))

    const refused = await refusal(
      keyedDownload(`${api.origin}/files/1/download`, {
        method: 'POST',
        headers: keyed(),
        body: 'PRIVATE-BODY',
      }),
    )

    expect(refused).toMatchObject({ reason: 'not-followed' })
    expect(store.seen).toEqual([])
  })

  it('asks again with GET and no body after a 303, as fetch does', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((_seen, res) => redirect(res, 303, `${store.origin}/blob`))

    const response = await keyedDownload(`${api.origin}/files/1/download`, {
      method: 'POST',
      headers: { ...keyed(), 'Content-Type': 'application/json' },
      body: '{"PRIVATE":"BODY"}',
    })

    expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true)
    expect(store.seen).toHaveLength(1)
    expect(store.seen[0]).toMatchObject({ method: 'GET', body: '' })
    expect(Object.keys(store.seen[0]!.headers)).not.toContain('content-type')
    expect(carriers(store.seen, KEY)).toEqual([])
  })

  it('hands back an answer that is no redirect as it came', async () => {
    const api = await serve((seen, res) =>
      seen.path === '/missing' ? json(res, { error: 'gone' }, {}, 404) : res.writeHead(304).end(),
    )
    const missing = await keyedDownload(`${api.origin}/missing`, { headers: keyed() })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'gone' })
    // a 3xx that names no address is not a redirect to follow
    expect((await keyedDownload(`${api.origin}/unchanged`, { headers: keyed() })).status).toBe(304)
  })
})

describe('a download over a fetch that cannot hand a redirect back', () => {
  /**
   * A stand-in for Electron's `net.fetch`, after what it did in a probe with
   * Electron 43.8.3 against two local servers: told not to follow, it throws
   * `Redirect was cancelled` and never hands the 3xx back.
   */
  const electronNetFetch: KeyedFetchBase = async (url, init) => {
    const response = await fetch(url, init)
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel()
      throw new Error('Redirect was cancelled')
    }
    return response
  }

  it('refuses the redirect over that fetch alone', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((_seen, res) => redirect(res, 302, `${store.origin}/blob`))

    const refused = await refusal(
      keyedDownload(`${api.origin}/files/1`, { headers: keyed() }, { base: electronNetFetch }),
    )

    expect(refused).toMatchObject({ reason: 'not-followed' })
    expect(store.seen).toEqual([])
  })

  it('follows it when a second fetch asks the refused hop again', async () => {
    const store = await serve((_seen, res) => file(res))
    const api = await serve((_seen, res) => redirect(res, 302, `${store.origin}/blob`))

    const response = await keyedDownload(
      `${api.origin}/files/1`,
      { headers: keyed() },
      { base: fetchSeeingRedirects(electronNetFetch, (url, init) => fetch(url, init)) },
    )

    expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true)
    // the hop that redirected went out twice, the second time to read where to
    expect(api.seen).toHaveLength(2)
    expect(store.seen).toHaveLength(1)
    expect(carriers(store.seen, KEY)).toEqual([])
  })
})
