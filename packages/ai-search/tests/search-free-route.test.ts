import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/parallel-mcp', () => ({ parallelMcpSearch: vi.fn() }))

import { defaultAiSettings, normalizeAiSettings } from '@genoffice/ai-provider'
import { aiToolCapabilities, imageSearch, readAiSettingsFile, webSearch } from '../src/index'
import { parallelMcpSearch } from '../src/parallel-mcp'
import { imageSearchTool, searchOptionsFromSettings, webSearchTool } from '../src/search-tools'
import { writeSettings } from './routing-helpers'

const parallelFree = vi.mocked(parallelMcpSearch)
const KEY_ENV = [
  'SERPER_API_KEY',
  'SERPLY_API_KEY',
  'TAVILY_API_KEY',
  'PARALLEL_API_KEY',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
]

const DUCK_HTML = '<a class="result__a" href="https://duck.example.com">Duck</a>'
const DUCK_IMAGES = {
  results: [
    { title: 'Duck', image: 'https://duck.example.com/a.png', url: 'https://duck.example.com' },
  ],
}

/** DuckDuckGo answers; every keyed backend would fail the test by being asked */
function stubDuckDuckGo() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input)
    if (url.startsWith('https://html.duckduckgo.com/')) return new Response(DUCK_HTML)
    if (url.startsWith('https://duckduckgo.com/i.js')) return Response.json(DUCK_IMAGES)
    if (url.startsWith('https://duckduckgo.com/')) return new Response('vqd="123-456"')
    throw new Error(`unexpected request to ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  for (const key of KEY_ENV) vi.stubEnv(key, '')
  parallelFree.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const NO_KEYS = {
  serperKey: '',
  serplyKey: '',
  tavilyKey: '',
  parallelKey: '',
  exaKey: '',
  firecrawlKey: '',
}

/**
 * DuckDuckGo answers, every other host is down, and each request is recorded.
 * A keyed backend swallows its own failure, so only the record can tell that
 * it was asked.
 */
function recordRequests(): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('https://html.duckduckgo.com/')) return new Response(DUCK_HTML)
      if (url.startsWith('https://duckduckgo.com/i.js')) return Response.json(DUCK_IMAGES)
      if (url.startsWith('https://duckduckgo.com/')) return new Response('vqd="123-456"')
      return new Response('', { status: 500 })
    }),
  )
  return urls
}

const notDuckDuckGo = (urls: string[]) =>
  urls.filter((url) => !/^https:\/\/(html\.)?duckduckgo\.com\//.test(url))

/** every settings shape in which the user selected no key search provider */
const NOTHING_SELECTED = [
  ['fresh settings', () => writeSettings()],
  ['an unknown provider', () => writeSettings({ search: { provider: 'bing' } })],
  [
    'free Parallel search, the stored default',
    () => writeSettings({ search: { provider: 'parallel', providers: {} } }),
  ],
  ['no settings file', () => '/nonexistent/ai-settings.json'],
] as const

describe('the default search route with paid keys in the environment', () => {
  it.each(KEY_ENV)('searches the web without %s', async (name) => {
    vi.stubEnv(name, 'env-key')
    for (const [, settings] of NOTHING_SELECTED) {
      const urls = recordRequests()
      parallelFree.mockReset()
      parallelFree.mockResolvedValue(null)
      const r = await webSearchTool(settings(), 'office suites', 3)
      expect(r.method).toBe('duckduckgo')
      // free Parallel search was asked, through its keyless endpoint, and nothing with a key
      expect(parallelFree).toHaveBeenCalledTimes(1)
      expect(notDuckDuckGo(urls)).toEqual([])
    }
  })

  it.each(KEY_ENV)('searches images without %s', async (name) => {
    vi.stubEnv(name, 'env-key')
    for (const [, settings] of NOTHING_SELECTED) {
      const urls = recordRequests()
      const r = await imageSearchTool(settings(), 'ducks', 3)
      expect(r.method).toBe('duckduckgo')
      expect(notDuckDuckGo(urls)).toEqual([])
    }
  })

  it.each(NOTHING_SELECTED)(
    'asks no keyed backend with all of them set: %s',
    async (_name, settings) => {
      for (const name of KEY_ENV) vi.stubEnv(name, 'env-key')
      const urls = recordRequests()
      parallelFree.mockResolvedValue({
        results: [{ title: 'P', url: 'https://parallel.example.com', excerpts: ['one'] }],
      })
      expect((await webSearchTool(settings(), 'office suites', 3)).method).toBe('parallel')
      expect((await imageSearchTool(settings(), 'ducks', 3)).method).toBe('duckduckgo')
      expect(notDuckDuckGo(urls)).toEqual([])
      const capabilities = aiToolCapabilities(readAiSettingsFile(settings()))
      expect(capabilities.webSearch).toEqual({
        available: true,
        route: 'free',
        provider: 'parallel',
      })
      expect(capabilities.imageSearch).toEqual({
        available: true,
        route: 'free',
        provider: 'duckduckgo',
      })
    },
  )

  it('leaves no key for the environment to fill in, whatever is selected', () => {
    for (const name of KEY_ENV) vi.stubEnv(name, 'env-key')
    const selections = [
      ...NOTHING_SELECTED.map(([, settings]) => settings()),
      ...['serper', 'serply', 'tavily', 'parallel', 'exa', 'firecrawl'].map((provider) =>
        writeSettings({ search: { provider, providers: { [provider]: { apiKey: 'stored' } } } }),
      ),
    ]
    for (const settings of selections) {
      const options = searchOptionsFromSettings(readAiSettingsFile(settings))
      for (const key of Object.keys(NO_KEYS)) {
        expect(options).toHaveProperty(key, expect.any(String))
      }
      // at most the selected provider carries a key, and it is the stored one
      const keys = Object.keys(NO_KEYS).map((key) => options[key as keyof typeof NO_KEYS])
      expect(keys.filter(Boolean).every((key) => key === 'stored')).toBe(true)
      expect(keys.filter(Boolean).length).toBeLessThanOrEqual(1)
    }
  })
})

describe('a selected key provider and the environment', () => {
  const serperSelected = (apiKey: string) =>
    writeSettings({ search: { provider: 'serper', providers: { serper: { apiKey } } } })

  it('takes its key from the environment when none is stored', async () => {
    vi.stubEnv('SERPER_API_KEY', 'env-serper-key')
    const keys: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = String(input)
        keys.push(new Headers(init?.headers).get('X-API-KEY'))
        if (url === 'https://google.serper.dev/search') {
          return Response.json({ organic: [{ title: 'S', link: 'https://s.example.com' }] })
        }
        if (url === 'https://google.serper.dev/images') {
          return Response.json({
            images: [{ title: 'S', imageUrl: 'https://s.example.com/a.png', link: 'https://s' }],
          })
        }
        throw new Error(`unexpected request to ${url}`)
      }),
    )
    const settings = serperSelected('')
    expect((await webSearchTool(settings, 'q', 3)).method).toBe('serper')
    expect((await imageSearchTool(settings, 'q', 3)).method).toBe('serper')
    expect(keys).toEqual(['env-serper-key', 'env-serper-key'])
    const capabilities = aiToolCapabilities(readAiSettingsFile(settings))
    expect(capabilities.webSearch).toEqual({ available: true, route: 'key', provider: 'serper' })
    expect(capabilities.imageSearch).toEqual({ available: true, route: 'key', provider: 'serper' })
  })

  it('prefers the stored key over the environment', () => {
    vi.stubEnv('SERPER_API_KEY', 'env-serper-key')
    expect(searchOptionsFromSettings(readAiSettingsFile(serperSelected('stored-key')))).toEqual({
      ...NO_KEYS,
      serperKey: 'stored-key',
      prefer: 'serper',
    })
  })

  it('is the keyless route when neither holds a key', async () => {
    const settings = serperSelected('')
    expect(searchOptionsFromSettings(readAiSettingsFile(settings))).toEqual({
      ...NO_KEYS,
      prefer: 'parallel',
    })
    expect(aiToolCapabilities(readAiSettingsFile(settings)).webSearch).toEqual({
      available: true,
      route: 'free',
      provider: 'parallel',
    })
  })

  it('does not borrow the environment key of a provider that is not the selection', async () => {
    for (const name of KEY_ENV) vi.stubEnv(name, 'env-key')
    // Tavily has no image endpoint: its image search is the free one, not Serper on an environment key
    const settings = writeSettings({
      search: { provider: 'tavily', providers: { tavily: { apiKey: 'stored-tavily' } } },
    })
    const urls = recordRequests()
    parallelFree.mockResolvedValue(null)
    expect((await imageSearchTool(settings, 'ducks', 3)).method).toBe('duckduckgo')
    expect(notDuckDuckGo(urls)).toEqual([])
    // the web search asks Tavily, then only the keyless chain
    expect((await webSearchTool(settings, 'q', 3)).method).toBe('duckduckgo')
    expect(notDuckDuckGo(urls)).toEqual(['https://api.tavily.com/search'])
    expect(parallelFree).toHaveBeenCalledTimes(1)
    expect(aiToolCapabilities(readAiSettingsFile(settings)).imageSearch).toEqual({
      available: true,
      route: 'free',
      provider: 'duckduckgo',
    })
  })

  it('keeps free Parallel search keyless even with PARALLEL_API_KEY set', async () => {
    vi.stubEnv('PARALLEL_API_KEY', 'env-parallel-key')
    const settings = writeSettings({
      search: { provider: 'parallel', providers: { parallel: { apiKey: '' } } },
    })
    const urls = recordRequests()
    parallelFree.mockResolvedValue({
      results: [{ title: 'P', url: 'https://parallel.example.com', excerpts: [] }],
    })
    expect((await webSearchTool(settings, 'q', 3)).method).toBe('parallel')
    expect(urls).toEqual([])
    expect(aiToolCapabilities(readAiSettingsFile(settings)).webSearch).toEqual({
      available: true,
      route: 'free',
      provider: 'parallel',
    })
  })
})

describe('the default search route', () => {
  it('is the keyless chain for fresh settings', () => {
    const free = { ...NO_KEYS, prefer: 'parallel' }
    expect(searchOptionsFromSettings(normalizeAiSettings(undefined))).toEqual(free)
    expect(defaultAiSettings().search?.provider).toBe('parallel')
    expect(searchOptionsFromSettings(defaultAiSettings())).toEqual(free)
  })

  it('asks free Parallel search first', async () => {
    const fetch = stubDuckDuckGo()
    parallelFree.mockResolvedValue({
      results: [{ title: 'P', url: 'https://parallel.example.com', excerpts: ['one'] }],
    })
    const r = await webSearchTool(writeSettings(), 'office suites', 3)
    expect(r).toEqual({
      results: [{ title: 'P', url: 'https://parallel.example.com', snippet: 'one' }],
      method: 'parallel',
    })
    expect(parallelFree).toHaveBeenCalledWith('office suites')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls to DuckDuckGo when free Parallel search fails', async () => {
    stubDuckDuckGo()
    parallelFree.mockRejectedValue(new Error('mcp down'))
    const r = await webSearchTool(writeSettings(), 'office suites', 3)
    expect(r).toEqual({
      results: [{ title: 'Duck', url: 'https://duck.example.com', snippet: '' }],
      method: 'duckduckgo',
    })
  })

  it('searches images without a key', async () => {
    stubDuckDuckGo()
    const r = await imageSearchTool(writeSettings(), 'ducks', 3)
    expect(r.method).toBe('duckduckgo')
    expect(r.images).toEqual([
      {
        title: 'Duck',
        imageUrl: 'https://duck.example.com/a.png',
        sourceUrl: 'https://duck.example.com',
        source: 'duck.example.com',
      },
    ])
  })

  it('is what a settings file that selected a provider this build does not know gets', async () => {
    stubDuckDuckGo()
    parallelFree.mockResolvedValue(null)
    const settings = writeSettings({ search: { provider: 'retired-provider' } })
    expect((await webSearchTool(settings, 'q')).method).toBe('duckduckgo')
    expect((await imageSearchTool(settings, 'q')).method).toBe('duckduckgo')
  })
})

describe('webSearch / imageSearch called directly', () => {
  it('takes the keyless chain when no options are given, in every spelling', async () => {
    stubDuckDuckGo()
    parallelFree.mockResolvedValue(null)
    for (const options of [undefined, true, {}] as const) {
      expect((await webSearch('q', 3, options)).method).toBe('duckduckgo')
      expect((await imageSearch('q', 3, options)).method).toBe('duckduckgo')
    }
  })
})

describe('a key search provider the user selected', () => {
  it('runs first, with the free chain behind it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url === 'https://google.serper.dev/search') {
        return Response.json({ organic: [{ title: 'S', link: 'https://s.example.com' }] })
      }
      throw new Error(`unexpected request to ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const settings = writeSettings({
      search: { provider: 'serper', providers: { serper: { apiKey: 'user-key' } } },
    })
    const r = await webSearchTool(settings, 'q', 3)
    expect(r.method).toBe('serper')
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('X-API-KEY')).toBe('user-key')
    expect(parallelFree).not.toHaveBeenCalled()
  })
})
