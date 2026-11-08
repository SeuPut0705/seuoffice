/**
 * What a free connection card shows, as a plain function of the settings, the
 * attempt under way and today's quota, so the rules are testable without a DOM.
 * The card (FreeAiCards.tsx) only lays the result out.
 */
import { freeAiConnected, providerSelectionOf } from '@genoffice/ai-provider/browser'
import type {
  AiSettings,
  FreeAiConnectFailure,
  FreeAiProviderId,
  FreeAiQuota,
} from '@genoffice/ai-provider/browser'
import type { StringKey } from './locale'

/** The connect attempt a card is in; `failed` keeps the reason until the next press */
export type FreeAiAttempt =
  | { readonly phase: 'idle' }
  | { readonly phase: 'waiting' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'failed'; readonly reason: FreeAiConnectFailure }

export const FREE_AI_IDLE: FreeAiAttempt = { phase: 'idle' }

export type FreeAiCardAction =
  /** OpenRouter: open the browser sign-in */
  | 'connect-browser'
  /** stop a browser sign-in that is still waiting */
  | 'cancel'
  /** Gemini: open the page where a key is made */
  | 'get-key'
  /** make the connected provider the AI in use */
  | 'use'
  | 'disconnect'

export interface FreeAiCardView {
  readonly provider: FreeAiProviderId
  readonly state: 'connected' | 'waiting' | 'checking' | 'idle'
  readonly tone: 'ok' | 'neutral' | 'error'
  /** the short status at the right of the card head */
  readonly statusKey: StringKey
  /** the provider is connected and is the stored selection */
  readonly inUse: boolean
  /** the line under the head: what to do, or what went wrong */
  readonly messageKey?: StringKey | undefined
  /** today's free requests, shown while connected when the provider reports them */
  readonly quota?: FreeAiQuota | undefined
  /** a Gemini card that is not connected takes a pasted key */
  readonly keyInput: boolean
  readonly actions: readonly FreeAiCardAction[]
}

const FAILURE_KEYS: Record<Exclude<FreeAiConnectFailure, 'cancelled'>, StringKey> = {
  timeout: 'freeFailedTimeout',
  denied: 'freeFailedDenied',
  invalid: 'freeFailedInvalid',
  network: 'freeFailedNetwork',
}

const DESCRIPTION_KEYS: Record<FreeAiProviderId, StringKey> = {
  openrouter: 'freeOpenRouterDesc',
  gemini: 'freeGeminiDesc',
}

export function freeAiCardView(
  provider: FreeAiProviderId,
  settings: Pick<AiSettings, 'provider' | 'providers'>,
  attempt: FreeAiAttempt,
  quota: FreeAiQuota | null = null,
): FreeAiCardView {
  const connected = freeAiConnected(settings, provider)
  if (attempt.phase === 'waiting') {
    return {
      provider,
      state: 'waiting',
      tone: 'neutral',
      statusKey: 'freeStatusWaiting',
      inUse: false,
      messageKey: 'freeWaiting',
      keyInput: false,
      actions: ['cancel'],
    }
  }
  if (attempt.phase === 'checking') {
    return {
      provider,
      state: 'checking',
      tone: 'neutral',
      statusKey: 'freeStatusChecking',
      inUse: false,
      keyInput: provider === 'gemini',
      actions: [],
    }
  }
  if (connected) {
    const inUse = providerSelectionOf(settings) === provider
    return {
      provider,
      state: 'connected',
      tone: 'ok',
      statusKey: inUse ? 'freeStatusInUse' : 'freeStatusConnected',
      inUse,
      ...(quota && provider === 'openrouter' ? { quota } : {}),
      keyInput: false,
      actions: inUse ? ['disconnect'] : ['use', 'disconnect'],
    }
  }
  // a cancelled attempt leaves the card as it was before the press
  const failed =
    attempt.phase === 'failed' && attempt.reason !== 'cancelled'
      ? FAILURE_KEYS[attempt.reason]
      : undefined
  return {
    provider,
    state: 'idle',
    tone: failed ? 'error' : 'neutral',
    statusKey: 'freeStatusNotConnected',
    inUse: false,
    messageKey: failed ?? DESCRIPTION_KEYS[provider],
    keyInput: provider === 'gemini',
    actions: provider === 'openrouter' ? ['connect-browser'] : ['get-key'],
  }
}

/** Display names of the free connections, as the cards and the first-run summary say them */
export const FREE_AI_PROVIDER_NAMES: Record<FreeAiProviderId, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
}
