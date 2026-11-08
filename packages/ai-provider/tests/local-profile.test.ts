import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  localContextLimit,
  localModelCapabilities,
  localModelProfilesOf,
  mergeLocalModelProfile,
} from '../src/local-profile'
import { defaultAiSettings } from '../src/providers'
import { resolveCustomEndpoints } from '../src/custom-endpoints'
import type { AiCustomEndpoint, AiLocalModelProfile, AiProviderSelection } from '../src/types'

const localEndpoint: AiCustomEndpoint = {
  id: 'loc',
  name: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen3:8b',
  models: ['qwen3:8b', 'llama3'],
  kind: 'local',
  modelProfiles: {
    'qwen3:8b': { contextLength: 32_768, tools: true, vision: false },
  },
  timeoutMs: 300_000,
}

const plainEndpoint: AiCustomEndpoint = {
  id: 'plain',
  name: 'Gateway',
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'k',
  model: 'gpt-x',
}

function localSettings(
  endpoint: AiCustomEndpoint = localEndpoint,
  provider: AiProviderSelection = 'custom',
) {
  return resolveCustomEndpoints({
    ...defaultAiSettings(),
    provider,
    customEndpoints: [endpoint],
    customEndpoint: endpoint.id,
  })
}

describe('localModelCapabilities', () => {
  it('reads the active local model profile', () => {
    expect(localModelCapabilities(localSettings())).toEqual({
      contextLength: 32_768,
      tools: true,
      vision: false,
    })
  })

  it('is empty for a server saved before kind existed', () => {
    expect(localModelCapabilities(localSettings(plainEndpoint))).toEqual({})
  })

  it('is empty while the custom provider is not the selected one', () => {
    expect(localModelCapabilities(localSettings(localEndpoint, 'openai'))).toEqual({})
  })

  it('does not invent capabilities for a model without a profile', () => {
    const unknown: AiCustomEndpoint = {
      ...localEndpoint,
      model: 'missing',
    }
    expect(localModelCapabilities(localSettings(unknown))).toEqual({})
  })

  it('keeps unknown values out instead of reading them as false', () => {
    const partial: AiCustomEndpoint = {
      ...localEndpoint,
      modelProfiles: { 'qwen3:8b': { tools: false } },
    }
    expect(localModelCapabilities(localSettings(partial))).toEqual({ tools: false })
  })
})

describe('localContextLimit', () => {
  it('uses the profile context when there is one', () => {
    expect(localContextLimit(localSettings())).toEqual({ limit: 32_768, known: true })
  })

  it('assumes 4096 tokens when the model context is unknown', () => {
    const unknown: AiCustomEndpoint = { ...localEndpoint, modelProfiles: {} }
    expect(localContextLimit(localSettings(unknown))).toEqual({
      limit: DEFAULT_LOCAL_CONTEXT_TOKENS,
      known: false,
    })
  })

  it('is undefined for a non-local server or another provider', () => {
    expect(localContextLimit(localSettings(plainEndpoint))).toBeUndefined()
    expect(localContextLimit(localSettings(localEndpoint, 'openai'))).toBeUndefined()
  })

  it('is undefined when no custom server is active', () => {
    const settings = resolveCustomEndpoints({
      ...defaultAiSettings(),
      provider: 'custom',
      customEndpoints: [localEndpoint],
      customEndpoint: '',
    })
    expect(localContextLimit(settings)).toBeUndefined()
  })
})

describe('mergeLocalModelProfile', () => {
  it('lets a newer observation fill values the user did not set', () => {
    const merged = mergeLocalModelProfile(
      { contextLength: 8_192, contextSource: 'server', tools: true, toolsSource: 'server' },
      {
        contextLength: 32_768,
        contextSource: 'server',
        vision: true,
        visionSource: 'server',
        checkedAt: 10,
      },
    )
    expect(merged).toEqual({
      contextLength: 32_768,
      contextSource: 'server',
      tools: true,
      toolsSource: 'server',
      vision: true,
      visionSource: 'server',
      checkedAt: 10,
    })
  })

  it('never overwrites a user-set item', () => {
    const merged = mergeLocalModelProfile(
      {
        contextLength: 16_384,
        maxContextLength: 32_768,
        contextSource: 'user',
        tools: false,
        toolsSource: 'user',
      },
      {
        contextLength: 131_072,
        maxContextLength: 131_072,
        contextSource: 'server',
        tools: true,
        toolsSource: 'test',
        vision: true,
        visionSource: 'server',
      },
    )
    expect(merged.contextLength).toBe(16_384)
    expect(merged.maxContextLength).toBe(32_768)
    expect(merged.contextSource).toBe('user')
    expect(merged.tools).toBe(false)
    expect(merged.toolsSource).toBe('user')
    expect(merged.vision).toBe(true)
    expect(merged.visionSource).toBe('server')
  })

  it('keeps the base when the new observation knows nothing', () => {
    const base: AiLocalModelProfile = { tools: true, toolsSource: 'test', notes: 'kept' }
    expect(mergeLocalModelProfile(base, undefined)).toEqual(base)
  })

  it('takes the later check time and the newer notes', () => {
    const merged = mergeLocalModelProfile(
      { checkedAt: 20, notes: 'old' },
      { checkedAt: 10, notes: 'new' },
    )
    expect(merged.checkedAt).toBe(20)
    expect(merged.notes).toBe('new')
  })

  it('turns two empty profiles into an empty one', () => {
    expect(mergeLocalModelProfile(undefined, undefined)).toEqual({})
  })
})

describe('localModelProfilesOf', () => {
  it('keeps valid profiles and drops malformed values', () => {
    const profiles = localModelProfilesOf({
      'qwen3:8b': {
        contextLength: 32_768,
        maxContextLength: 131_072,
        tools: true,
        vision: false,
        contextSource: 'server',
        toolsSource: 'test',
        visionSource: 'user',
        checkedAt: 1_700_000_000_000,
        notes: '  Apache-2.0  ',
      },
      bad: {
        contextLength: 0,
        maxContextLength: 10_000_001,
        tools: 'yes',
        vision: 1,
        contextSource: 'cloud',
        checkedAt: 1.5,
      },
    })
    expect(profiles).toEqual({
      'qwen3:8b': {
        contextLength: 32_768,
        maxContextLength: 131_072,
        tools: true,
        vision: false,
        contextSource: 'server',
        toolsSource: 'test',
        visionSource: 'user',
        checkedAt: 1_700_000_000_000,
        notes: 'Apache-2.0',
      },
    })
  })
})
