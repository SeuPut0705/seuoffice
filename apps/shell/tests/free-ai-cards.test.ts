import { describe, expect, it } from 'vitest'
import { OPENROUTER_FREE_MODELS, normalizeAiSettings } from '@genoffice/ai-provider/browser'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import { FREE_AI_IDLE, freeAiCardView } from '../src/renderer/src/free-ai-cards'

function settings(patch: (s: AiSettings) => void = () => {}): AiSettings {
  const s = normalizeAiSettings({ providers: {} })
  patch(s)
  return s
}

const openRouterFree = (s: AiSettings) => {
  s.providers.openrouter = { apiKey: 'sk-or-v1-x', model: OPENROUTER_FREE_MODELS[0]! }
}

describe('free connection cards', () => {
  it('offers the browser sign-in for OpenRouter and a key field for Gemini when nothing is connected', () => {
    const openrouter = freeAiCardView('openrouter', settings(), FREE_AI_IDLE)
    expect(openrouter).toMatchObject({
      state: 'idle',
      statusKey: 'freeStatusNotConnected',
      messageKey: 'freeOpenRouterDesc',
      keyInput: false,
      actions: ['connect-browser'],
    })
    const gemini = freeAiCardView('gemini', settings(), FREE_AI_IDLE)
    expect(gemini).toMatchObject({
      keyInput: true,
      actions: ['get-key'],
      messageKey: 'freeGeminiDesc',
    })
  })

  it('waits for the browser with only a cancel button', () => {
    const view = freeAiCardView('openrouter', settings(), { phase: 'waiting' })
    expect(view).toMatchObject({ state: 'waiting', messageKey: 'freeWaiting', actions: ['cancel'] })
  })

  it('shows a connected provider in use with its quota, and offers "use" when another AI is selected', () => {
    const inUse = settings((s) => {
      openRouterFree(s)
      s.provider = 'openrouter'
    })
    const quota = { used: 9, limit: 50, remaining: 41 }
    expect(freeAiCardView('openrouter', inUse, FREE_AI_IDLE, quota)).toMatchObject({
      state: 'connected',
      inUse: true,
      statusKey: 'freeStatusInUse',
      quota,
      actions: ['disconnect'],
    })
    const other = settings(openRouterFree)
    expect(freeAiCardView('openrouter', other, FREE_AI_IDLE)).toMatchObject({
      inUse: false,
      statusKey: 'freeStatusConnected',
      actions: ['use', 'disconnect'],
    })
  })

  it('does not count a paid OpenRouter setup as the free connection', () => {
    const paid = settings((s) => {
      s.providers.openrouter = { apiKey: 'sk-or-v1-x', model: 'openrouter/auto' }
      s.provider = 'openrouter'
    })
    expect(freeAiCardView('openrouter', paid, FREE_AI_IDLE).state).toBe('idle')
  })

  it('says why a connection failed, but treats a cancel as nothing having happened', () => {
    expect(
      freeAiCardView('gemini', settings(), { phase: 'failed', reason: 'invalid' }),
    ).toMatchObject({
      tone: 'error',
      messageKey: 'freeFailedInvalid',
      keyInput: true,
    })
    expect(
      freeAiCardView('openrouter', settings(), { phase: 'failed', reason: 'denied' }).messageKey,
    ).toBe('freeFailedDenied')
    expect(
      freeAiCardView('openrouter', settings(), { phase: 'failed', reason: 'cancelled' }),
    ).toMatchObject({ tone: 'neutral', messageKey: 'freeOpenRouterDesc' })
  })

  it('never shows a quota for Gemini, which has no way to report one', () => {
    const gemini = settings((s) => {
      s.providers.gemini = { apiKey: 'AIza-k', model: 'gemini-3.5-flash-lite' }
    })
    const view = freeAiCardView('gemini', gemini, FREE_AI_IDLE, { used: 1, limit: 2, remaining: 1 })
    expect(view.quota).toBeUndefined()
  })
})
