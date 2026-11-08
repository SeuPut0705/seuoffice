/**
 * ai:web-search / ai:image-search for the editors' main processes: reads
 * ai-settings.json live and turns the search provider choice into
 * SearchOptions. The default is the keyless chain (free Parallel MCP, then
 * DuckDuckGo); a key provider the user selected runs first, with that chain
 * behind it.
 */

import {
  AI_SEARCH_PROVIDERS,
  type AiSearchProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { imageSearch, searchEnvKey, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'

type KeySearchProviderId = NonNullable<SearchOptions['prefer']>

/** Every key spelled out as absent, so the environment fills none in behind the user's selection. */
const NO_SEARCH_KEYS = {
  serperKey: '',
  serplyKey: '',
  tavilyKey: '',
  parallelKey: '',
  exaKey: '',
  firecrawlKey: '',
} satisfies SearchOptions

/** The keyless chain and nothing else: free Parallel search, then DuckDuckGo. */
const FREE_SEARCH_OPTIONS: SearchOptions = { ...NO_SEARCH_KEYS, prefer: 'parallel' }

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
  if (!selected) return { ...FREE_SEARCH_OPTIONS }
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

/** settings-UI test: the selected backend (keyed or free) must answer one minimal query. */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  apiKey = apiKey.trim()
  if (!apiKey && provider !== 'parallel') return { ok: false, error: 'API key is empty' }
  const options: SearchOptions = {
    serperKey: provider === 'serper' ? apiKey : '',
    serplyKey: provider === 'serply' ? apiKey : '',
    tavilyKey: provider === 'tavily' ? apiKey : '',
    parallelKey: provider === 'parallel' ? apiKey : '',
    exaKey: provider === 'exa' ? apiKey : '',
    firecrawlKey: provider === 'firecrawl' ? apiKey : '',
    prefer: provider,
  }
  const r = await webSearch('GenOffice', 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
