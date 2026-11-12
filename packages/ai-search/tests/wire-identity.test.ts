/**
 * What a search backend learns about its caller: the product's own name where the
 * service asks for one, never the name of the upstream project, and no product
 * name at all in the query the settings test sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSearchProviderId } from '@genoffice/ai-provider'
import { PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from '@genoffice/i18n'
import { imageSearch, webSearch, type SearchOptions } from '../src/index'
import { testSearchProvider } from '../src/search-tools'

interface Sent {
  url: URL
  headers: Headers
  body: string
}

const NO_KEYS = {
  serperKey: '',
  serplyKey: '',
  searchapiKey: '',
  tavilyKey: '',
  parallelKey: '',
  exaKey: '',
  firecrawlKey: '',
  keenableKey: '',
} satisfies SearchOptions

const ALL_KEYS = Object.fromEntries(Object.keys(NO_KEYS).map((name) => [name, 'k'])) as Record<
  keyof typeof NO_KEYS,
  string
>

const upstream = new RegExp(UPSTREAM_PRODUCT_NAME, 'i')
const anyProduct = new RegExp(`${UPSTREAM_PRODUCT_NAME}|${PRODUCT_NAME}`, 'i')

/** Every service answers 500, so each backend in the chain is asked once and only what was sent matters. */
function recordRequests(): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      sent.push({
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response(null, { status: 500 })
    }),
  )
  return sent
}

function jsonBody(request: Sent): Record<string, unknown> {
  return request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {}
}

/** The search text of one request, wherever its backend carries it; undefined for a request without one */
function queryOf(request: Sent): string | undefined {
  const body = jsonBody(request)
  const queries = body.search_queries
  const found =
    request.url.searchParams.get('q') ??
    body.q ??
    body.query ??
    (Array.isArray(queries) ? queries[0] : undefined)
  return typeof found === 'string' ? found : undefined
}

beforeEach(() => {
  for (const key of [
    'SERPER_API_KEY',
    'SERPLY_API_KEY',
    'SEARCHAPI_API_KEY',
    'TAVILY_API_KEY',
    'PARALLEL_API_KEY',
    'EXA_API_KEY',
    'FIRECRAWL_API_KEY',
    'KEENABLE_API_KEY',
  ])
    vi.stubEnv(key, '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the name a search backend is given', () => {
  it.each([
    ['serply', { serplyKey: 'k' }, 'api.serply.io'],
    ['searchapi', { searchapiKey: 'k' }, 'www.searchapi.io'],
  ] as const)(
    '%s reads the product in User-Agent, for pages and for images',
    async (prefer, key, host) => {
      const sent = recordRequests()
      await webSearch('office tools', 3, { ...NO_KEYS, ...key, prefer })
      await imageSearch('office tools', 3, { ...NO_KEYS, ...key, prefer })
      const agents = sent
        .filter((request) => request.url.host === host)
        .map((request) => request.headers.get('User-Agent'))
      expect(agents).toEqual([PRODUCT_NAME.toLowerCase(), PRODUCT_NAME.toLowerCase()])
    },
  )

  it.each([
    ['without a key', '', '/v1/search/public'],
    ['with a key', 'k', '/v1/search'],
  ])('Keenable reads the product as the app title %s', async (_label, keenableKey, path) => {
    const sent = recordRequests()
    await webSearch('office tools', 3, { ...NO_KEYS, keenableKey, prefer: 'keenable' })
    const keenable = sent.filter((request) => request.url.host === 'api.keenable.ai')
    expect(keenable.map((request) => request.url.pathname)).toEqual([path])
    expect(keenable[0]!.headers.get('X-Keenable-Title')).toBe(PRODUCT_NAME)
  })

  it("Parallel's free search server is greeted by a client named after the product", async () => {
    const sent = recordRequests()
    await webSearch('office tools', 3, { ...NO_KEYS, prefer: 'parallel' })
    const hello = sent
      .filter((request) => request.url.host === 'search.parallel.ai')
      .map(jsonBody)
      .find((body) => body.method === 'initialize')
    expect(hello?.params).toMatchObject({ clientInfo: { name: PRODUCT_NAME.toLowerCase() } })
  })

  it('no request of any backend names the upstream project', async () => {
    const sent = recordRequests()
    // every key backend, then DuckDuckGo
    await webSearch('office tools', 3, { ...ALL_KEYS, prefer: 'serper' })
    await imageSearch('office tools', 3, { ...ALL_KEYS, prefer: 'serper' })
    // the keyless ones: Keenable's free endpoint and Parallel's free server
    await webSearch('office tools', 3, { ...NO_KEYS, prefer: 'keenable' })
    expect(new Set(sent.map((request) => request.url.host))).toEqual(
      new Set([
        'google.serper.dev',
        'api.serply.io',
        'www.searchapi.io',
        'api.tavily.com',
        'api.parallel.ai',
        'api.exa.ai',
        'api.firecrawl.dev',
        'api.keenable.ai',
        'search.parallel.ai',
        'html.duckduckgo.com',
        'duckduckgo.com',
      ]),
    )
    const naming = sent.filter((request) => {
      const said = [request.url.href, request.body]
      request.headers.forEach((value, name) => said.push(`${name}: ${value}`))
      return upstream.test(said.join('\n'))
    })
    expect(naming.map((request) => request.url.href)).toEqual([])
  })
})

describe('the query the settings test sends', () => {
  const cases: [AiSearchProviderId, string, string][] = [
    ['serper', 'k', 'google.serper.dev'],
    ['serply', 'k', 'api.serply.io'],
    ['searchapi', 'k', 'www.searchapi.io'],
    ['tavily', 'k', 'api.tavily.com'],
    ['parallel', 'k', 'api.parallel.ai'],
    ['exa', 'k', 'api.exa.ai'],
    ['firecrawl', 'k', 'api.firecrawl.dev'],
    ['keenable', 'k', 'api.keenable.ai'],
    ['keenable', '', 'api.keenable.ai'],
  ]

  it.each(cases)(
    '%s (key "%s") is asked for a word that names no product',
    async (id, key, host) => {
      const sent = recordRequests()
      await testSearchProvider(id, key)
      const query = queryOf(sent.find((request) => request.url.host === host)!)
      expect(query).toBeTruthy()
      expect(query).not.toMatch(anyProduct)
      // the services the failed test falls back to see the same query
      const queries = sent.map(queryOf).filter((text) => text !== undefined)
      expect(queries.filter((text) => anyProduct.test(text))).toEqual([])
    },
  )
})
