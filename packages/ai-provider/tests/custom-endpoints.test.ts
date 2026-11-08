import { describe, expect, it } from 'vitest'
import {
  activeCustomEndpoint,
  customEndpointLabel,
  removeCustomEndpoint,
  resolveCustomEndpoints,
  selectCustomEndpoint,
  upsertCustomEndpoint,
} from '../src/custom-endpoints'
import { sanitizeAiSettings } from '../src/ai-settings-guard'
import { normalizeAiSettings } from '../src/legacy-settings'
import { isKeyProviderConfigured } from '../src/provider-selection'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import type { AiCustomEndpoint, AiLocalModelProfile } from '../src/types'

const ollama: AiCustomEndpoint = {
  id: 'a',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'llama3',
}
const gateway: AiCustomEndpoint = {
  id: 'b',
  name: '',
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'k',
  model: 'gpt-x',
  models: ['gpt-x', 'gpt-y'],
}

describe('resolveCustomEndpoints', () => {
  it('seeds the list from a pre-list custom slot and mirrors it back', () => {
    const settings = defaultAiSettings()
    settings.providers.custom = { apiKey: 'k', model: 'm', baseUrl: 'http://h/v1' }
    const next = resolveCustomEndpoints(settings)
    expect(next.customEndpoints).toHaveLength(1)
    expect(next.customEndpoints![0]).toMatchObject({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'http://h/v1',
    })
    expect(next.customEndpoint).toBe(next.customEndpoints![0]!.id)
    expect(next.providers.custom).toEqual({ apiKey: 'k', model: 'm', baseUrl: 'http://h/v1' })
  })

  it('leaves an unconfigured file without a list', () => {
    const next = resolveCustomEndpoints(defaultAiSettings())
    expect(next.customEndpoints).toBeUndefined()
    expect(next.customEndpoint).toBeUndefined()
  })

  it('falls back to the first entry when the active id is stale', () => {
    const next = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [ollama, gateway],
      customEndpoint: 'gone',
    })
    expect(next.customEndpoint).toBe('a')
    expect(next.providers.custom.baseUrl).toBe(ollama.baseUrl)
  })

  it('drops duplicate and id-less entries', () => {
    const next = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [ollama, { ...gateway, id: 'a' }, { ...gateway, id: '' }],
    })
    expect(next.customEndpoints!.map((e) => e.id)).toEqual(['a'])
  })

  it('runs as part of resolveAiSettings', () => {
    const stored = {
      provider: 'custom',
      providers: { custom: { apiKey: '', model: 'old', baseUrl: 'http://old/v1' } },
      customEndpoints: [ollama, gateway],
      customEndpoint: 'b',
    }
    const settings = resolveAiSettings(stored, defaultAiSettings())
    expect(settings.providers.custom).toEqual({
      apiKey: 'k',
      model: 'gpt-x',
      baseUrl: gateway.baseUrl,
    })
    expect(activeCustomEndpoint(settings)?.id).toBe('b')
  })
})

describe('select / upsert / remove', () => {
  const base = resolveCustomEndpoints({
    ...defaultAiSettings(),
    customEndpoints: [ollama, gateway],
    customEndpoint: 'a',
  })

  it('switching the active endpoint swaps the slot', () => {
    const next = selectCustomEndpoint(base, 'b')
    expect(next.providers.custom.model).toBe('gpt-x')
    expect(base.providers.custom.model).toBe('llama3')
  })

  it('upsert edits in place and appends new ids as active', () => {
    const edited = upsertCustomEndpoint(base, { ...ollama, model: 'mistral' })
    expect(edited.customEndpoints!.map((e) => e.model)).toEqual(['mistral', 'gpt-x'])
    expect(edited.providers.custom.model).toBe('mistral')
    const added = upsertCustomEndpoint(base, { ...gateway, id: 'c', name: 'Third' })
    expect(added.customEndpoints).toHaveLength(3)
    expect(added.customEndpoint).toBe('c')
  })

  it('removing the active entry activates the next one, removing the last clears the slot', () => {
    const one = removeCustomEndpoint(base, 'a')
    expect(one.customEndpoint).toBe('b')
    expect(one.providers.custom.baseUrl).toBe(gateway.baseUrl)
    const none = removeCustomEndpoint(one, 'b')
    expect(none.customEndpoints).toBeUndefined()
    expect(none.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
  })

  it('labels fall back to the host', () => {
    expect(customEndpointLabel(ollama, 'Custom')).toBe('Ollama')
    expect(customEndpointLabel(gateway, 'Custom')).toBe('gw.example.com')
    expect(customEndpointLabel({ ...gateway, baseUrl: '' }, 'Custom')).toBe('Custom')
  })
})

describe('sanitizeAiSettings', () => {
  it('keeps the endpoint list, drops bad base URLs and oversized ids', () => {
    const out = sanitizeAiSettings({
      provider: 'custom',
      providers: {},
      customEndpoints: [
        gateway,
        { ...ollama, id: 'x'.repeat(100), baseUrl: 'javascript:alert(1)' },
        { name: 'no id' },
      ],
      customEndpoint: 'b',
    })
    expect(out?.customEndpoints).toHaveLength(2)
    expect(out?.customEndpoints![0]).toEqual(gateway)
    expect(out?.customEndpoints![1]!.id).toHaveLength(64)
    expect(out?.customEndpoints![1]!.baseUrl).toBe('')
    expect(out?.customEndpoint).toBe('b')
  })

  it('omits the list when nothing survives', () => {
    const out = sanitizeAiSettings({ provider: 'custom', providers: {}, customEndpoints: 'nope' })
    expect(out?.customEndpoints).toBeUndefined()
  })
})

// ── local profile data (T1) ────────────────────────────────

const modelProfile: AiLocalModelProfile = {
  contextLength: 32_768,
  maxContextLength: 131_072,
  tools: true,
  vision: false,
  contextSource: 'user',
  toolsSource: 'server',
  visionSource: 'test',
  checkedAt: 1_700_000_000_000,
  notes: 'qwen3:8b · Apache-2.0',
}

const localOllama: AiCustomEndpoint = {
  id: 'loc',
  name: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen3:8b',
  models: ['qwen3:8b', 'llama3'],
  kind: 'local',
  modelProfiles: { 'qwen3:8b': modelProfile },
  timeoutMs: 300_000,
}

function storedLocal() {
  return {
    provider: 'custom',
    providers: {
      custom: { apiKey: '', model: '', baseUrl: '' },
    },
    customEndpoints: [localOllama],
    customEndpoint: 'loc',
  }
}

describe('local fields', () => {
  it('survives normalize -> sanitize -> normalize', () => {
    const normalized = normalizeAiSettings(storedLocal(), defaultAiSettings())
    expect(normalized.customEndpoints![0]).toMatchObject({
      kind: 'local',
      timeoutMs: 300_000,
    })
    expect(normalized.customEndpoints![0]!.modelProfiles!['qwen3:8b']).toEqual(modelProfile)

    const saved = sanitizeAiSettings(normalized)
    expect(saved).not.toBeNull()
    expect(saved!.customEndpoints![0]!.kind).toBe('local')
    expect(saved!.customEndpoints![0]!.timeoutMs).toBe(300_000)
    expect(saved!.customEndpoints![0]!.modelProfiles!['qwen3:8b']).toEqual(modelProfile)

    const reread = normalizeAiSettings(saved, defaultAiSettings())
    expect(reread.customEndpoints![0]!.kind).toBe('local')
    expect(reread.customEndpoints![0]!.timeoutMs).toBe(300_000)
    expect(reread.customEndpoints![0]!.modelProfiles!['qwen3:8b']).toEqual(modelProfile)
  })

  it('does not classify a server saved before kind existed as local', () => {
    const next = normalizeAiSettings(
      {
        provider: 'custom',
        providers: { custom: { apiKey: 'k', model: 'gpt-x', baseUrl: gateway.baseUrl } },
        customEndpoints: [gateway],
        customEndpoint: 'b',
      },
      defaultAiSettings(),
    )
    expect(next.customEndpoints![0]!.kind).toBeUndefined()
    expect(next.customEndpoints![0]!.modelProfiles).toBeUndefined()
    expect(next.customEndpoints![0]!.timeoutMs).toBeUndefined()
  })

  it('drops malformed local values but keeps the server', () => {
    const next = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [
        {
          ...localOllama,
          kind: 'cloud' as never,
          timeoutMs: 10_000,
          modelProfiles: {
            'qwen3:8b': {
              contextLength: -1,
              maxContextLength: 10_000_001,
              tools: 'yes' as never,
              vision: 1 as never,
              contextSource: 'cloud' as never,
              checkedAt: 1.5,
              notes: `  ${'x'.repeat(600)}  `,
            },
            ['k'.repeat(300)]: { tools: true },
          },
        },
      ],
      customEndpoint: 'loc',
    })
    const entry = next.customEndpoints![0]!
    expect(entry.kind).toBeUndefined()
    expect(entry.timeoutMs).toBeUndefined()
    expect(Object.keys(entry.modelProfiles!)).toEqual(['qwen3:8b'])
    expect(entry.modelProfiles!['qwen3:8b']).toEqual({ notes: 'x'.repeat(500) })
  })

  it('keeps at most 2000 model profiles', () => {
    const many = Object.fromEntries(
      Array.from({ length: 2_005 }, (_, i) => [`m${i}`, { tools: true }]),
    )
    const next = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [{ ...localOllama, modelProfiles: many }],
      customEndpoint: 'loc',
    })
    const profiles = next.customEndpoints![0]!.modelProfiles!
    expect(Object.keys(profiles)).toHaveLength(2_000)
    expect(profiles.m1999).toEqual({ tools: true })
    expect(profiles.m2000).toBeUndefined()
  })

  it('accepts the exact bounds and rejects the ones past them', () => {
    const bounds = [
      { timeoutMs: 59_999, ok: false },
      { timeoutMs: 60_000, ok: true },
      { timeoutMs: 600_000, ok: true },
      { timeoutMs: 600_001, ok: false },
      { timeoutMs: 300_000.5, ok: false },
    ]
    for (const { timeoutMs, ok } of bounds) {
      const next = resolveCustomEndpoints({
        ...defaultAiSettings(),
        customEndpoints: [{ ...localOllama, timeoutMs }],
        customEndpoint: 'loc',
      })
      expect(next.customEndpoints![0]!.timeoutMs).toBe(ok ? timeoutMs : undefined)
    }
  })
})

describe('no active custom server', () => {
  it('an explicit empty id clears the mirror instead of falling back to the first entry', () => {
    const next = resolveCustomEndpoints({
      ...defaultAiSettings(),
      provider: 'custom',
      customEndpoints: [localOllama, gateway],
      customEndpoint: '',
    })
    expect(next.customEndpoint).toBe('')
    expect(activeCustomEndpoint(next)).toBeUndefined()
    expect(next.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
    expect(isKeyProviderConfigured(next, 'custom')).toBe(false)
  })

  it('a file without the field still falls back to the first entry', () => {
    const next = normalizeAiSettings(
      {
        provider: 'custom',
        providers: { custom: { apiKey: 'k', model: 'gpt-x', baseUrl: gateway.baseUrl } },
        customEndpoints: [localOllama, gateway],
      },
      defaultAiSettings(),
    )
    expect(next.customEndpoint).toBe('loc')
    expect(next.providers.custom.baseUrl).toBe(localOllama.baseUrl)
  })

  it('removeCustomEndpoint keeps the old fallback unless asked not to', () => {
    const base = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [localOllama, gateway],
      customEndpoint: 'loc',
    })
    const fallback = removeCustomEndpoint(base, 'loc')
    expect(fallback.customEndpoint).toBe('b')
    expect(fallback.providers.custom.baseUrl).toBe(gateway.baseUrl)

    const noFallback = removeCustomEndpoint(base, 'loc', { fallback: false })
    expect(noFallback.customEndpoint).toBe('')
    expect(noFallback.customEndpoints!.map((e) => e.id)).toEqual(['b'])
    expect(noFallback.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
    expect(isKeyProviderConfigured(noFallback, 'custom')).toBe(false)

    const reread = normalizeAiSettings(sanitizeAiSettings(noFallback), defaultAiSettings())
    expect(reread.customEndpoint).toBe('')
    expect(isKeyProviderConfigured(reread, 'custom')).toBe(false)
  })

  it('removing the last entry without fallback leaves an explicit empty selection', () => {
    const base = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [localOllama],
      customEndpoint: 'loc',
    })
    const next = removeCustomEndpoint(base, 'loc', { fallback: false })
    expect(next.customEndpoints).toBeUndefined()
    expect(next.customEndpoint).toBe('')
    expect(next.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
  })

  it('removing an inactive entry leaves the active one alone', () => {
    const base = resolveCustomEndpoints({
      ...defaultAiSettings(),
      customEndpoints: [localOllama, gateway],
      customEndpoint: 'loc',
    })
    const next = removeCustomEndpoint(base, 'b', { fallback: false })
    expect(next.customEndpoint).toBe('loc')
    expect(next.providers.custom.baseUrl).toBe(localOllama.baseUrl)
  })
})
