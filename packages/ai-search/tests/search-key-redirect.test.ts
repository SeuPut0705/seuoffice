import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageSearch, webSearch, type SearchOptions } from '../src/index'
import {
  carriers,
  closeServers,
  collector,
  redirect,
  serve,
  type TestServer,
} from '../../ai-provider/tests/two-servers'

/**
 * Every keyed search backend takes the person's key in a header of its own
 * (`X-API-KEY`, `X-Api-Key`, `x-api-key`), as a Bearer token, or in the request
 * body (Tavily). A followed redirect repeats the request, key included, at
 * whatever address the answer names, so a keyed search stops at a redirect.
 *
 * The backends' addresses are fixed in the code, so the `fetch` of the test
 * carries each request for the backend under test to a local server, exactly
 * as the search built it; the redirect is answered and handled by the real
 * fetch and two real servers. Requests to any other host fail, so the search
 * cannot wander off to the next backend's real service.
 */

const KEY = 'secret-search-key'

const realFetch = globalThis.fetch

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeServers()
})

function carry(host: string, provider: TestServer): void {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.host !== host) return Promise.reject(new TypeError('fetch failed'))
    return realFetch(provider.origin + url.pathname + url.search, init)
  })
}

const none: SearchOptions = {
  serperKey: '',
  serplyKey: '',
  searchapiKey: '',
  tavilyKey: '',
  parallelKey: '',
  exaKey: '',
  firecrawlKey: '',
  keenableKey: '',
}

const web: [backend: NonNullable<SearchOptions['prefer']>, host: string, key: SearchOptions][] = [
  ['serper', 'google.serper.dev', { serperKey: KEY }],
  ['serply', 'api.serply.io', { serplyKey: KEY }],
  ['searchapi', 'www.searchapi.io', { searchapiKey: KEY }],
  ['tavily', 'api.tavily.com', { tavilyKey: KEY }],
  ['parallel', 'api.parallel.ai', { parallelKey: KEY }],
  ['exa', 'api.exa.ai', { exaKey: KEY }],
  ['firecrawl', 'api.firecrawl.dev', { firecrawlKey: KEY }],
  ['keenable', 'api.keenable.ai', { keenableKey: KEY }],
]

/** an answer every backend's reader would take for results */
const PLANTED = {
  organic: [{ title: 'planted', link: 'https://planted.example/', snippet: 's' }],
  organic_results: [{ title: 'planted', link: 'https://planted.example/', snippet: 's' }],
  results: [
    { title: 'planted', url: 'https://planted.example/', link: 'https://planted.example/' },
  ],
  data: { web: [{ title: 'planted', url: 'https://planted.example/' }] },
  images: [{ title: 'planted', imageUrl: 'https://planted.example/a.png', imageWidth: 800 }],
}

describe('a keyed search and a redirect', () => {
  it.each(web)(
    'stops a %s search at the redirect and sends the key nowhere else',
    async (id, host, key) => {
      const other = await collector(PLANTED)
      const provider = await serve((seen, res) => redirect(res, 307, `${other.origin}${seen.path}`))
      carry(host, provider)

      const result = await webSearch('PRIVATE-QUERY', 3, { ...none, ...key, prefer: id })

      expect(other.seen).toEqual([])
      // the backend did not answer, and nothing the other party planted is a result
      expect(result.method).not.toBe(id)
      expect(result.results).toEqual([])
      expect(carriers(provider.seen, KEY).length).toBeGreaterThan(0)
    },
  )

  it.each([web[0]!, web[1]!, web[2]!])(
    'stops a %s image search at the redirect too',
    async (id, host, key) => {
      const other = await collector(PLANTED)
      const provider = await serve((seen, res) => redirect(res, 307, `${other.origin}${seen.path}`))
      carry(host, provider)

      const result = await imageSearch('PRIVATE-QUERY', 3, { ...none, ...key, prefer: id })

      expect(other.seen).toEqual([])
      expect(result.images).toEqual([])
      expect(carriers(provider.seen, KEY).length).toBeGreaterThan(0)
    },
  )

  it('still follows a redirect of the keyless DuckDuckGo search', async () => {
    const provider = await serve((seen, res) => {
      if (seen.path.startsWith('/html/')) return redirect(res, 302, '/moved')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<a class="result__a" href="https://found.example/">Found</a>')
    })
    carry('html.duckduckgo.com', provider)

    const result = await webSearch('q', 3, none)

    expect(result.method).toBe('duckduckgo')
    expect(result.results).toEqual([{ title: 'Found', url: 'https://found.example/', snippet: '' }])
  })
})
