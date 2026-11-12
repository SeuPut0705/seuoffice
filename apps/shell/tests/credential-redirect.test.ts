import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DriveApi, refreshGoogleToken, type FetchLike } from '@seuoffice/google-drive'
import { driveFetches } from '../src/main/drive/drive-fetch'
import { evaluate, type DecisionCallOptions } from '../src/main/file-index/decider'
import {
  carriers,
  closeServers,
  collector,
  redirect,
  serve,
  type TestServer,
} from '../../../packages/ai-provider/tests/two-servers'

/**
 * The shell's own requests that carry a credential: the Drive calls and the
 * Google token exchange (the app passes them Electron's `net.fetch`), and the
 * file search's decision endpoint (Node's fetch). The credential goes to no
 * origin but the one it was sent to: a call that is no download stops at a
 * redirect, and a Drive file's bytes are fetched through one without the token.
 *
 * Real servers on 127.0.0.1 play the hosts and record what reaches them. The
 * Drive addresses are fixed https ones, so the fetches of the test carry each
 * request to the local server that plays its host, exactly as the code built
 * it; the code under test sees the real addresses and their origins.
 */

const TOKEN = 'secret-access-token'
const GOOGLE = 'www.googleapis.com'
const OAUTH = 'oauth2.googleapis.com'
/** where Drive would keep a file's bytes: another origin */
const STORE = 'doc-0s-docs.googleusercontent.com'
const BYTES = new Uint8Array(64 * 1024).map((_, i) => (i * 31) % 251)

afterEach(closeServers)

type Hosts = Record<string, TestServer>

/** Node's fetch, carried to the local server that plays the request's host */
function nodeFetch(hosts: Hosts): FetchLike {
  return (url, init) => {
    const at = new URL(url)
    const server = hosts[at.host]
    if (!server) return Promise.reject(new TypeError(`fetch failed: no server plays ${at.host}`))
    return fetch(server.origin + at.pathname + at.search, init)
  }
}

/**
 * A stand-in for Electron's `net.fetch`, written after what it did in a probe
 * with Electron 43.8.3 against two local servers: following, it repeats every
 * header (`Authorization` included) at the new origin; told not to follow, it
 * throws `Redirect was cancelled` and never hands the 3xx back.
 */
function electronNetFetch(hosts: Hosts): FetchLike {
  const send = nodeFetch(hosts)
  return async (url, init) => {
    let at = url
    for (;;) {
      const response = await send(at, { ...init, redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || location === null) return response
      await response.body?.cancel()
      if (init?.redirect === 'manual') throw new Error('Redirect was cancelled')
      at = new URL(location, at).href
    }
  }
}

/** the Drive client as the shell builds it: its two fetches over `net.fetch` and Node's fetch */
function drive(hosts: Hosts, node: FetchLike = nodeFetch(hosts)): DriveApi {
  return new DriveApi({
    token: async () => TOKEN,
    ...driveFetches(electronNetFetch(hosts), node),
  })
}

function file(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/pdf' })
  res.end(BYTES)
}

describe('a Google Drive call that is no download, and a redirect', () => {
  it('sends the access token nowhere else', async () => {
    const store = await collector({ user: { displayName: 'planted', emailAddress: 'p@x' } })
    const google = await serve((_seen, res) => redirect(res, 307, `https://${STORE}/taken`))
    const api = drive({ [GOOGLE]: google, [STORE]: store })

    const account = await api.account()
    const meta = await api.file('file-1')

    expect(store.seen).toEqual([])
    expect(account).toEqual({ ok: false, kind: 'network' })
    expect(meta).toEqual({ ok: false, kind: 'network' })
    // one request each: a call that is no download is not asked a second time
    expect(carriers(google.seen, TOKEN)).toEqual(['authorization', 'authorization'])
  })

  it('does not send the refresh token or the client secret on', async () => {
    const store = await collector({ access_token: 'planted', expires_in: 3600 })
    const oauth = await serve((_seen, res) => redirect(res, 307, `https://${STORE}/taken`))
    const hosts = { [OAUTH]: oauth, [STORE]: store }

    const refreshed = await refreshGoogleToken(
      { clientId: 'client-1', clientSecret: 'secret-client' },
      'secret-refresh',
      driveFetches(electronNetFetch(hosts), nodeFetch(hosts)).fetch,
    )

    expect(store.seen).toEqual([])
    // a passing failure: the connection is kept and tried again later
    expect(refreshed).toEqual({ ok: false, reason: 'network' })
    expect(carriers(oauth.seen, 'secret-')).toEqual(['body'])
  })

  it('still reads the account when nothing redirects', async () => {
    const google = await collector({ user: { displayName: 'Ada', emailAddress: 'ada@x' } })
    expect(await drive({ [GOOGLE]: google }).account()).toEqual({
      ok: true,
      account: { displayName: 'Ada', emailAddress: 'ada@x' },
    })
  })
})

describe('a Google Drive file download and a redirect', () => {
  it('reads the bytes from the host Drive redirects to, without the token', async () => {
    const store = await serve((_seen, res) => file(res))
    const google = await serve((seen, res) =>
      redirect(res, 302, `https://${STORE}/blob${seen.path.split('?')[0]}`),
    )
    const api = drive({ [GOOGLE]: google, [STORE]: store })

    const stored = await api.download('file-1', BYTES.byteLength)
    const exported = await api.export('doc-1', 'application/pdf', BYTES.byteLength)

    expect(stored.ok && Buffer.from(stored.bytes).equals(BYTES)).toBe(true)
    expect(exported.ok && Buffer.from(exported.bytes).equals(BYTES)).toBe(true)
    expect(store.seen.map((request) => request.path)).toEqual([
      '/blob/drive/v3/files/file-1',
      '/blob/drive/v3/files/doc-1/export',
    ])
    expect(carriers(store.seen, TOKEN)).toEqual([])
    for (const request of store.seen) {
      expect(Object.keys(request.headers)).not.toContain('authorization')
    }
    // Drive itself was asked with the token: once over net.fetch, which could not
    // say where the redirect pointed, and once over Node's fetch, which could
    expect(carriers(google.seen, TOKEN)).toEqual(Array(4).fill('authorization'))
  })

  it('asks once, over net.fetch alone, when Drive answers with the bytes', async () => {
    const google = await serve((_seen, res) => file(res))
    const node = vi.fn(nodeFetch({ [GOOGLE]: google }))

    const stored = await drive({ [GOOGLE]: google }, node).download('file-1', BYTES.byteLength)

    expect(stored.ok && Buffer.from(stored.bytes).equals(BYTES)).toBe(true)
    expect(google.seen).toHaveLength(1)
    expect(node).not.toHaveBeenCalled()
  })

  it('does not follow a download to an address that is not https', async () => {
    const store = await serve((_seen, res) => file(res))
    const google = await serve((_seen, res) => redirect(res, 302, `${store.origin}/blob`))

    const stored = await drive({ [GOOGLE]: google }).download('file-1', BYTES.byteLength)

    expect(stored).toEqual({ ok: false, kind: 'network' })
    expect(store.seen).toEqual([])
  })
})

describe('the file search decision endpoint and a redirect', () => {
  const docs = [{ title: 'a.md', heading: 'notes', text: 'PRIVATE-EXCERPT' }]
  const custom = (base: string): DecisionCallOptions => ({
    endpoint: 'custom',
    key: TOKEN,
    customBaseUrl: `${base}/v1/systemone`,
    customModel: 'm',
    cloudflareAccountId: '',
    cloudflareModel: '',
  })

  it('sends neither the key nor the file excerpts on', async () => {
    const other = await collector({ answers: {} })
    const endpoint = await serve((seen, res) =>
      redirect(res, 307, `${other.origin}/taken${seen.path}`),
    )

    const failure = await evaluate('q', docs, custom(endpoint.origin)).then(
      () => 'no error',
      (error: unknown) => String((error as Error).message),
    )

    expect(other.seen).toEqual([])
    expect(failure).toMatch(/redirect.*API key was not sent on/is)
    expect(carriers(endpoint.seen, TOKEN)).toEqual(['authorization'])
    expect(carriers(endpoint.seen, 'PRIVATE-EXCERPT')).toEqual(['body'])
  })
})
