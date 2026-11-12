/**
 * ai:web-search / ai:image-search for the editors' main processes: reads
 * ai-settings.json live and turns the search provider choice into
 * SearchOptions. The default is the keyless chain (free Parallel MCP, then
 * DuckDuckGo); a key provider the user selected runs first, with that chain
 * behind it. Keenable's free endpoint only runs when Keenable is the selected
 * provider.
 */

import {
  AI_SEARCH_PROVIDERS,
  type AiSearchProviderId,
  type AiSettings,
} from '@seuoffice/ai-provider'
import { imageSearch, searchEnvKey, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'

type KeySearchProviderId = NonNullable<SearchOptions['prefer']>

/** Every key spelled out as absent, so the environment fills none in behind the user's selection. */
const NO_SEARCH_KEYS = {
  serperKey: '',
  serplyKey: '',
  searchapiKey: '',
  tavilyKey: '',
  parallelKey: '',
  exaKey: '',
  firecrawlKey: '',
  keenableKey: '',
} satisfies SearchOptions

/**
 * The backend the keyless chain starts on: Keenable when it is the selected
 * provider (its free endpoint runs only then), else free Parallel search; the
 * rest of the keyless chain and DuckDuckGo follow either way.
 */
export function keylessSearchBackend(
  settings: Pick<AiSettings, 'search'>,
): 'parallel' | 'keenable' {
  return settings.search?.provider === 'keenable' ? 'keenable' : 'parallel'
}

/**
 * The key search provider the user selected, with the key it runs on, or null
 * when the search is the keyless one. The stored key wins; without one, the
 * environment key of that same provider stands in (a developer's override).
 * Parallel with no stored key is the free route itself, so no environment
 * key may turn it into a paid one.
 */
export function selectedSearchKey(
  settings: Pick<AiSettings, 'search'>,
): { provider: KeySearchProviderId; key: string } | null {
  const stored: unknown = settings.search?.provider
  const provider = AI_SEARCH_PROVIDERS.find((meta) => meta.id === stored)?.id
  // nothing usable is selected: an unknown id (one that was removed among them)
  if (!provider) return null
  const storedKey = settings.search?.providers?.[provider]?.apiKey?.trim() ?? ''
  const key = storedKey || (provider === 'parallel' ? '' : searchEnvKey(provider))
  return key ? { provider, key } : null
}

export function searchOptionsFromSettings(settings: AiSettings): SearchOptions {
  const selected = selectedSearchKey(settings)
  if (!selected) return { ...NO_SEARCH_KEYS, prefer: keylessSearchBackend(settings) }
  return {
    ...NO_SEARCH_KEYS,
    [`${selected.provider}Key`]: selected.key,
    prefer: selected.provider,
  }
}

export function webSearchTool(settingsPath: string, query: string, maxResults = 6) {
  return webSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

export function imageSearchTool(settingsPath: string, query: string, maxResults = 8) {
  return imageSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

/**
 * A word every backend has results for. It goes to the provider as a search, and to the
 * services the chain falls back to when the provider does not answer, so it names no product.
 */
const KEY_TEST_QUERY = 'weather'

/** settings-UI test: the selected backend (keyed or free) must answer one minimal query. */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  apiKey = apiKey.trim()
  if (!apiKey && provider !== 'parallel' && provider !== 'keenable')
    return { ok: false, error: 'API key is empty' }
  const options: SearchOptions = {
    serperKey: provider === 'serper' ? apiKey : '',
    serplyKey: provider === 'serply' ? apiKey : '',
    searchapiKey: provider === 'searchapi' ? apiKey : '',
    tavilyKey: provider === 'tavily' ? apiKey : '',
    parallelKey: provider === 'parallel' ? apiKey : '',
    exaKey: provider === 'exa' ? apiKey : '',
    firecrawlKey: provider === 'firecrawl' ? apiKey : '',
    keenableKey: provider === 'keenable' ? apiKey : '',
    prefer: provider,
  }
  const r = await webSearch(KEY_TEST_QUERY, 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
