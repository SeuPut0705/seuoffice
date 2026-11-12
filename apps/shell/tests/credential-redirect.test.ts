import { afterEach, describe, expect, it } from 'vitest'
import { DriveApi, refreshGoogleToken, type FetchLike } from '@genoffice/google-drive'
import { driveFetchOver } from '../src/main/drive/drive-fetch'
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
 * file search's decision endpoint (Node's fetch). A followed redirect repeats
 * the request at whatever address the answer names, so each stops at one.
 *
 * Two real servers on 127.0.0.1 play the parts: the service, which answers a
 * 307, and the other party the redirect names, which records what reaches it.
 */

const TOKEN = 'secret-access-token'

afterEach(closeServers)

async function redirecting(other: TestServer): Promise<TestServer> {
  return serve((seen, res) => redirect(res, 307, `${other.origin}/taken${seen.path}`))
}

/** carries a request for Google to the local service, as the code built it */
function carriedTo(service: TestServer): FetchLike {
  return (url, init) => fetch(service.origin + new URL(url).pathname + new URL(url).search, init)
}

/**
 * Electron's `net.fetch`, as it answered a probe with Electron 43.8.3 against
 * two local servers: following, it repeats every header (`Authorization`
 * included) at the new origin; told not to follow, it throws.
 */
function electronNetFetch(service: TestServer): FetchLike {
  const send = carriedTo(service)
  return async (url, init) => {
    let response = await send(url, { ...init, redirect: 'manual' })
    for (;;) {
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || location === null) return response
      if (init?.redirect === 'manual') throw new Error('Redirect was cancelled')
      response = await fetch(location, { ...init, redirect: 'manual' })
    }
  }
}

describe('Google Drive and a redirect', () => {
  it.each([
    ['Node', carriedTo],
    ['Electron', electronNetFetch],
  ] as const)('sends the access token nowhere else over the %s fetch', async (_name, over) => {
    const other = await collector({ user: { displayName: 'planted', emailAddress: 'p@x' } })
    const google = await redirecting(other)
    const api = new DriveApi({ token: async () => TOKEN, fetch: driveFetchOver(over(google)) })

    const account = await api.account()
    const download = await api.download('file-1', 1024)

    expect(other.seen).toEqual([])
    expect(account).toEqual({ ok: false, kind: 'network' })
    expect(download).toEqual({ ok: false, kind: 'network' })
    expect(carriers(google.seen, TOKEN)).toEqual(['authorization', 'authorization'])
  })

  it('does not send the refresh token or the client secret on', async () => {
    const other = await collector({ access_token: 'planted', expires_in: 3600 })
    const google = await redirecting(other)

    const refreshed = await refreshGoogleToken(
      { clientId: 'client-1', clientSecret: 'secret-client' },
      'secret-refresh',
      driveFetchOver(electronNetFetch(google)),
    )

    expect(other.seen).toEqual([])
    // a passing failure: the connection is kept and tried again later
    expect(refreshed).toEqual({ ok: false, reason: 'network' })
    expect(carriers(google.seen, 'secret-')).toEqual(['body'])
  })

  it('still reads the account when nothing redirects', async () => {
    const google = await collector({ user: { displayName: 'Ada', emailAddress: 'ada@x' } })
    const api = new DriveApi({
      token: async () => TOKEN,
      fetch: driveFetchOver(electronNetFetch(google)),
    })
    expect(await api.account()).toEqual({
      ok: true,
      account: { displayName: 'Ada', emailAddress: 'ada@x' },
    })
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
    const endpoint = await redirecting(other)

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
