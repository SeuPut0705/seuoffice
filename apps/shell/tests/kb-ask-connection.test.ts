import { describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type {
  AiSettings,
  AiSubscriptionState,
  SubscriptionStatusMap,
} from '@genoffice/ai-provider/browser'
import { aiSendGate } from '@genoffice/ui'
import {
  askBlockedRunOf,
  askHeldStep,
  askSendGate,
  withContinuedProvider,
} from '../src/renderer/src/kb-ask-connection'

/**
 * The ask panel's rules under the subscription contract
 * (src/renderer/src/kb-ask-connection.ts): what a send does, which failures
 * count as a blocked run, and what "continue with" stores.
 */

function statuses(claude: AiSubscriptionState, codex: AiSubscriptionState): SubscriptionStatusMap {
  return {
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }
}

const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  ...patch,
})

describe('askSendGate', () => {
  it('sends when the selected AI can run and no notice is owed', () => {
    expect(askSendGate(settings(), statuses('ready', 'signed-out'), false)).toBe('run')
    expect(askSendGate(settings(), statuses('not-installed', 'ready'), false)).toBe('run')
  })

  it('asks for a connection when nothing can run', () => {
    expect(askSendGate(settings(), statuses('not-installed', 'signed-out'), false)).toBe('connect')
    expect(askSendGate(settings(), statuses('error', 'signed-out'), false)).toBe('connect')
  })

  it('holds the question while a status check that could still connect it is out', () => {
    // nothing goes out on a guess, and nothing is refused on one either
    expect(askSendGate(settings(), statuses('checking', 'checking'), false)).toBe('checking')
    // Codex is ready, but automatic picks Claude first: Claude's answer is waited for
    expect(askSendGate(settings(), statuses('checking', 'ready'), false)).toBe('checking')
    expect(askSendGate(settings(), statuses('signed-out', 'checking'), false)).toBe('checking')
    const selected = settings({ provider: 'codex' })
    expect(askSendGate(selected, statuses('ready', 'checking'), false)).toBe('checking')
    // a missing status reads as one that has not answered
    expect(askSendGate(settings(), {}, false)).toBe('checking')
  })

  it('agrees with the gate every editor panel uses, whatever the statuses', () => {
    const states = ['checking', 'not-installed', 'signed-out', 'ready', 'metered', 'error'] as const
    for (const selection of ['auto', 'claude-code', 'codex', 'openai'] as const) {
      const stored = settings({ provider: selection, subscriptionNoticeSeen: true })
      for (const claude of states) {
        for (const codex of states) {
          const map = statuses(claude, codex)
          const shared = aiSendGate(stored, map)
          expect(askSendGate(stored, map, false), `${selection}:${claude}:${codex}`).toBe(
            shared.kind,
          )
        }
      }
    }
  })

  it('does not fall over to the other provider when the selected one cannot run', () => {
    const selected = settings({ provider: 'claude-code' })
    expect(askSendGate(selected, statuses('signed-out', 'ready'), false)).toBe('connect')
  })

  it('holds back while the first-connection notice is owed', () => {
    expect(askSendGate(settings(), statuses('ready', 'signed-out'), true)).toBe('notice')
    // the home screen owns that dialog: while it is not up, a ready connection runs
    expect(askSendGate(settings(), statuses('ready', 'signed-out'), false)).toBe('run')
    // a notice is never shown over a panel that has nothing to run on
    expect(askSendGate(settings(), statuses('signed-out', 'signed-out'), true)).toBe('connect')
    expect(askSendGate(settings(), statuses('checking', 'checking'), true)).toBe('checking')
  })

  it('holds the question while the settings are not read yet', () => {
    expect(askSendGate(null, statuses('not-installed', 'not-installed'), false)).toBe('checking')
    expect(askSendGate(null, statuses('ready', 'ready'), true)).toBe('checking')
  })
})

describe('askHeldStep', () => {
  it('starts a held question once it can run, and keeps it while the check is still out', () => {
    expect(askHeldStep('run')).toBe('start')
    expect(askHeldStep('checking')).toBe('keep')
  })

  it('drops it when the answer is "not connected" or the notice: it must be asked again', () => {
    // a sign-in can take minutes, and the notice is read first: nothing starts by itself later
    expect(askHeldStep('connect')).toBe('drop')
    expect(askHeldStep('notice')).toBe('drop')
  })
})

describe('askBlockedRunOf', () => {
  it('keeps the kind, the provider and the reset time of a blocked run', () => {
    expect(
      askBlockedRunOf({
        message: 'limit',
        kind: 'rate-limit',
        provider: 'claude-code',
        resetsAt: 1_700_000_000_000,
      }),
    ).toEqual({ kind: 'rate-limit', provider: 'claude-code', resetsAt: 1_700_000_000_000 })
    expect(askBlockedRunOf({ message: 'x', kind: 'not-connected' })).toEqual({
      kind: 'not-connected',
    })
  })

  it('drops a reset time that is not a number', () => {
    expect(askBlockedRunOf({ message: 'x', kind: 'rate-limit', resetsAt: Number.NaN })).toEqual({
      kind: 'rate-limit',
    })
  })

  it('is null for failures that keep the plain error line', () => {
    expect(askBlockedRunOf(null)).toBeNull()
    expect(askBlockedRunOf({ message: 'boom' })).toBeNull()
    for (const kind of ['timeout', 'network', 'overloaded', 'credits'] as const) {
      expect(askBlockedRunOf({ message: 'x', kind })).toBeNull()
    }
  })
})

describe('withContinuedProvider', () => {
  it('stores the provider as the selection and keeps the model it last used', () => {
    const base = settings({ provider: 'claude-code' })
    const before = {
      ...base,
      providers: { ...base.providers, codex: { ...base.providers.codex, model: 'some-model' } },
    }
    const next = withContinuedProvider(before, 'codex')
    expect(next.provider).toBe('codex')
    expect(next.providers.codex?.model).toBe('some-model')
    // the provider that was blocked keeps its own settings
    expect(next.providers['claude-code']).toEqual(before.providers['claude-code'])
  })
})
