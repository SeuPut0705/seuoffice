/**
 * "Use anyway" for a metered login: remembered per provider, valid only for
 * the login it was given for, cleared when that login changes or goes away.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectAiProvider, subscriptionConnection } from '../src/provider-selection'
import { defaultAiSettings } from '../src/providers'
import {
  SUBSCRIPTION_METERED_FILE,
  createMeteredAcceptanceFileStore,
  createSubscriptionStatusService,
  meteredLoginFingerprint,
  reconcileMeteredAcceptance,
  type MeteredAcceptanceRecord,
  type MeteredAcceptanceStore,
  type SubscriptionDetection,
  type SubscriptionStatusService,
} from '../src/subscription'
import type { AiSettings, AiSubscriptionProviderId, AiSubscriptionStatuses } from '../src/types'

const apiKeyLogin: SubscriptionDetection = {
  provider: 'claude-code',
  state: 'metered',
  version: '2.1.287',
  loginMethod: 'metered',
  loginKind: 'api_key/firstParty',
}
const bedrockLogin: SubscriptionDetection = {
  ...apiKeyLogin,
  loginKind: 'third_party/bedrock',
}
const unknownLogin: SubscriptionDetection = {
  ...apiKeyLogin,
  loginMethod: 'unknown',
  loginKind: 'oauth_token/firstParty',
}
const subscriptionLogin: SubscriptionDetection = {
  provider: 'claude-code',
  state: 'ready',
  version: '2.1.287',
  loginMethod: 'subscription',
  planName: 'max',
  loginKind: 'claude.ai/firstParty',
}
const signedOut: SubscriptionDetection = { provider: 'claude-code', state: 'signed-out' }

describe('reconcileMeteredAcceptance', () => {
  it('holds while the login it was given for is still the one detected', () => {
    const fingerprint = meteredLoginFingerprint(apiKeyLogin)!
    expect(reconcileMeteredAcceptance(apiKeyLogin, { accepted: true, fingerprint })).toEqual({
      meteredAccepted: true,
      clear: false,
    })
  })

  it('is cleared when the login method changes', () => {
    const fingerprint = meteredLoginFingerprint(apiKeyLogin)!
    for (const now of [bedrockLogin, unknownLogin, subscriptionLogin]) {
      expect(reconcileMeteredAcceptance(now, { accepted: true, fingerprint })).toEqual({
        meteredAccepted: false,
        clear: true,
      })
    }
  })

  it('is cleared when the user signs out', () => {
    const fingerprint = meteredLoginFingerprint(apiKeyLogin)!
    expect(reconcileMeteredAcceptance(signedOut, { accepted: true, fingerprint })).toEqual({
      meteredAccepted: false,
      clear: true,
    })
  })

  it('a stored flag without the login it belongs to is not an acceptance', () => {
    expect(reconcileMeteredAcceptance(apiKeyLogin, { accepted: true })).toEqual({
      meteredAccepted: false,
      clear: true,
    })
    const fingerprint = meteredLoginFingerprint(apiKeyLogin)!
    expect(reconcileMeteredAcceptance(apiKeyLogin, { accepted: false, fingerprint })).toEqual({
      meteredAccepted: false,
      clear: true,
    })
  })

  it('survives a check that could not tell (error, program missing) without counting as accepted', () => {
    const fingerprint = meteredLoginFingerprint(apiKeyLogin)!
    for (const state of ['error', 'not-installed'] as const) {
      const detection: SubscriptionDetection = { provider: 'claude-code', state }
      expect(reconcileMeteredAcceptance(detection, { accepted: true, fingerprint })).toEqual({
        meteredAccepted: false,
        clear: false,
      })
    }
  })

  it('nothing stored, nothing to clear', () => {
    expect(reconcileMeteredAcceptance(apiKeyLogin, { accepted: false })).toEqual({
      meteredAccepted: false,
      clear: false,
    })
  })

  it('the fingerprint names the kind of login, never the account', () => {
    expect(meteredLoginFingerprint(apiKeyLogin)).toBe('metered:api_key/firstParty')
    expect(meteredLoginFingerprint(unknownLogin)).toBe('unknown:oauth_token/firstParty')
    expect(meteredLoginFingerprint(subscriptionLogin)).toBeNull()
    expect(meteredLoginFingerprint(signedOut)).toBeNull()
  })
})

interface Harness {
  service: SubscriptionStatusService
  settings: AiSettings
  record: MeteredAcceptanceRecord
  login: Record<AiSubscriptionProviderId, SubscriptionDetection>
  changes: AiSubscriptionStatuses[]
}

function harness(): Harness {
  const settings = defaultAiSettings()
  const state: Harness = {
    service: undefined as unknown as SubscriptionStatusService,
    settings,
    record: {},
    login: {
      'claude-code': apiKeyLogin,
      codex: { provider: 'codex', state: 'not-installed' },
      chatgpt: { provider: 'chatgpt', state: 'signed-out' },
    },
    changes: [],
  }
  const store: MeteredAcceptanceStore = {
    read: async () => ({ ...state.record }),
    write: async (record) => {
      state.record = { ...record }
    },
  }
  state.service = createSubscriptionStatusService({
    getSettings: () => settings,
    setMeteredAccepted: (provider, accepted) => {
      settings.meteredAccepted = { ...settings.meteredAccepted, [provider]: accepted }
    },
    acceptanceStore: store,
    detect: async (provider) => state.login[provider],
    onChange: (statuses) => state.changes.push(statuses),
  })
  return state
}

describe('the status service', () => {
  it('reports checking until the first check has answered', async () => {
    const h = harness()
    expect(h.service.getStatuses()).toEqual({
      'claude-code': { provider: 'claude-code', state: 'checking', meteredAccepted: false },
      chatgpt: { provider: 'chatgpt', state: 'checking', meteredAccepted: false },
      codex: { provider: 'codex', state: 'checking', meteredAccepted: false },
    })
    const statuses = await h.service.check()
    expect(statuses['claude-code'].state).toBe('metered')
    expect(statuses.codex).toEqual({
      provider: 'codex',
      state: 'not-installed',
      meteredAccepted: false,
    })
    expect(h.service.getStatuses()).toEqual(statuses)
    expect(h.changes.at(-1)).toEqual(statuses)
  })

  it('a status carries only the contract fields', async () => {
    const h = harness()
    const statuses = await h.service.check()
    expect(statuses['claude-code']).toEqual({
      provider: 'claude-code',
      state: 'metered',
      version: '2.1.287',
      loginMethod: 'metered',
      meteredAccepted: false,
    })
  })

  it('a metered login is not usable until the user accepts it', async () => {
    const h = harness()
    h.settings.provider = 'claude-code'
    const before = await h.service.check()
    expect(subscriptionConnection(h.settings, before['claude-code'])).toBeNull()
    expect(selectAiProvider(h.settings, before)).toMatchObject({
      connected: false,
      reason: 'metered-not-accepted',
    })

    const result = await h.service.setMeteredAccepted('claude-code', true)
    expect(result.ok).toBe(true)
    expect(result.statuses['claude-code'].meteredAccepted).toBe(true)
    expect(h.settings.meteredAccepted?.['claude-code']).toBe(true)
    expect(h.record['claude-code']).toBe('metered:api_key/firstParty')
    expect(selectAiProvider(h.settings, result.statuses)).toEqual({
      connected: true,
      provider: 'claude-code',
      metered: true,
    })
  })

  it('stays accepted across checks and restarts while the login is the same', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    expect((await h.service.check())['claude-code'].meteredAccepted).toBe(true)

    // a new service over the same stored values, as after an app restart
    const restarted = createSubscriptionStatusService({
      getSettings: () => h.settings,
      setMeteredAccepted: () => undefined,
      acceptanceStore: { read: async () => h.record, write: async () => undefined },
      detect: async (provider) => h.login[provider],
    })
    expect((await restarted.check())['claude-code'].meteredAccepted).toBe(true)
  })

  it('clears the acceptance when the login method changes', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    h.login['claude-code'] = bedrockLogin
    const statuses = await h.service.check()
    expect(statuses['claude-code']).toMatchObject({ state: 'metered', meteredAccepted: false })
    expect(h.settings.meteredAccepted?.['claude-code']).toBe(false)
    expect(h.record['claude-code']).toBeUndefined()
    // going back to the first login does not bring the acceptance back
    h.login['claude-code'] = apiKeyLogin
    expect((await h.service.check())['claude-code'].meteredAccepted).toBe(false)
  })

  it('clears the acceptance when the user signs out', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    h.login['claude-code'] = signedOut
    const statuses = await h.service.check()
    expect(statuses['claude-code']).toEqual({
      provider: 'claude-code',
      state: 'signed-out',
      meteredAccepted: false,
    })
    expect(h.settings.meteredAccepted?.['claude-code']).toBe(false)
    expect(h.record['claude-code']).toBeUndefined()
  })

  it('keeps the acceptance through a check that failed', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    h.login['claude-code'] = {
      provider: 'claude-code',
      state: 'error',
      error: 'timeout: no answer',
    }
    expect((await h.service.check())['claude-code'].meteredAccepted).toBe(false)
    expect(h.settings.meteredAccepted?.['claude-code']).toBe(true)
    h.login['claude-code'] = apiKeyLogin
    expect((await h.service.check())['claude-code'].meteredAccepted).toBe(true)
  })

  it('a flag planted in the settings without an acceptance is ignored and removed', async () => {
    const h = harness()
    h.settings.meteredAccepted = { 'claude-code': true }
    const statuses = await h.service.check()
    expect(statuses['claude-code'].meteredAccepted).toBe(false)
    expect(h.settings.meteredAccepted['claude-code']).toBe(false)
  })

  it('refuses to accept anything that is not a metered login', async () => {
    const h = harness()
    h.login['claude-code'] = subscriptionLogin
    await h.service.check()
    const result = await h.service.setMeteredAccepted('claude-code', true)
    expect(result.ok).toBe(false)
    expect(h.settings.meteredAccepted?.['claude-code']).not.toBe(true)
    expect(h.record['claude-code']).toBeUndefined()

    const missing = await h.service.setMeteredAccepted('codex', true)
    expect(missing.ok).toBe(false)
    expect(missing.statuses.codex.meteredAccepted).toBe(false)
  })

  it('takes the acceptance back on request', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    const result = await h.service.setMeteredAccepted('claude-code', false)
    expect(result.ok).toBe(true)
    expect(result.statuses['claude-code'].meteredAccepted).toBe(false)
    expect(h.settings.meteredAccepted?.['claude-code']).toBe(false)
    expect(h.record['claude-code']).toBeUndefined()
  })

  it('clears the acceptance on request whatever the login is, and writes nothing when there is none', async () => {
    const h = harness()
    h.login.codex = { provider: 'codex', state: 'metered', loginMethod: 'metered' }
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    await h.service.setMeteredAccepted('codex', true)
    const before = h.changes.length

    await h.service.clearMeteredAcceptance('claude-code')
    expect(h.service.getStatuses()['claude-code']).toMatchObject({
      state: 'metered',
      meteredAccepted: false,
    })
    expect(h.settings.meteredAccepted).toEqual({ 'claude-code': false, codex: true })
    expect(h.record).toEqual({ codex: 'metered:unknown' })
    expect(h.changes).toHaveLength(before + 1)
    expect(h.changes.at(-1)!['claude-code']?.meteredAccepted).toBe(false)
    // the same login, seen again: it is not the one that was accepted any more
    const rechecked = await h.service.check()
    expect(rechecked['claude-code'].meteredAccepted).toBe(false)
    expect(rechecked.codex.meteredAccepted).toBe(true)

    // nothing accepted: the settings and the record are not written, nothing is announced
    const writes: string[] = []
    const untouched = createSubscriptionStatusService({
      getSettings: () => defaultAiSettings(),
      setMeteredAccepted: (provider) => void writes.push(`setting:${provider}`),
      acceptanceStore: {
        read: async () => ({}),
        write: async () => void writes.push('record'),
      },
      detect: async (provider) => h.login[provider],
      onChange: () => void writes.push('change'),
    })
    await untouched.clearMeteredAcceptance('claude-code')
    await untouched.check()
    writes.length = 0
    await untouched.clearMeteredAcceptance('claude-code')
    expect(writes).toEqual([])
  })

  it('a flag that cannot be cleared in the settings counts for nothing once the remembered kind is gone', async () => {
    const h = harness()
    await h.service.check()
    await h.service.setMeteredAccepted('claude-code', true)
    const service = createSubscriptionStatusService({
      getSettings: () => h.settings,
      setMeteredAccepted: () => {
        throw new Error('EACCES')
      },
      acceptanceStore: {
        read: async () => ({ ...h.record }),
        write: async (record) => {
          h.record = { ...record }
        },
      },
      detect: async (provider) => h.login[provider],
    })
    expect((await service.check())['claude-code'].meteredAccepted).toBe(true)
    await service.clearMeteredAcceptance('claude-code')
    expect(service.getStatuses()['claude-code'].meteredAccepted).toBe(false)
    // the remembered kind went first, so the flag that stayed behind counts for nothing
    expect(h.record['claude-code']).toBeUndefined()
    expect((await service.check())['claude-code'].meteredAccepted).toBe(false)
  })

  it('checks one provider without touching the other', async () => {
    const h = harness()
    await h.service.check()
    h.login.codex = { provider: 'codex', state: 'signed-out', version: '0.159.2' }
    h.login['claude-code'] = signedOut
    const statuses = await h.service.check(['codex'])
    expect(statuses.codex.state).toBe('signed-out')
    expect(statuses['claude-code'].state).toBe('metered')
  })

  it('shares one check between callers that ask at the same time', async () => {
    let detections = 0
    const service = createSubscriptionStatusService({
      getSettings: () => defaultAiSettings(),
      setMeteredAccepted: () => undefined,
      acceptanceStore: { read: async () => ({}), write: async () => undefined },
      detect: async (provider) => {
        detections++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { provider, state: 'signed-out' }
      },
    })
    const [first, second] = await Promise.all([service.check(), service.check()])
    expect(first).toEqual(second)
    // one detection per provider, shared by both callers
    expect(detections).toBe(3)
  })

  it('a fresh check does not share one already under way: it waits for that one, then asks again', async () => {
    const answers: Array<(detection: SubscriptionDetection) => void> = []
    const service = createSubscriptionStatusService({
      getSettings: () => defaultAiSettings(),
      setMeteredAccepted: () => undefined,
      acceptanceStore: { read: async () => ({}), write: async () => undefined },
      detect: (provider) =>
        provider === 'claude-code'
          ? new Promise((resolve) => answers.push(resolve))
          : Promise.resolve({ provider, state: 'not-installed' }),
    })
    const asked = (count: number) =>
      new Promise<void>((resolve) => {
        const poll = (): void => void (answers.length >= count ? resolve() : setTimeout(poll, 1))
        poll()
      })
    const shared = service.check(['claude-code'])
    await asked(1)
    // asked while the first is under way: neither may be answered by it
    const fresh = service.check(['claude-code'], { fresh: true })
    const alsoFresh = service.check(['claude-code'], { fresh: true })
    answers[0]!(subscriptionLogin)
    expect((await shared)['claude-code'].state).toBe('ready')
    await asked(2)
    answers[1]!(signedOut)
    expect((await fresh)['claude-code'].state).toBe('signed-out')
    expect((await alsoFresh)['claude-code'].state).toBe('signed-out')
    // one check after the one under way, shared by both: no check per caller, no loop
    expect(answers).toHaveLength(2)

    // with nothing under way a fresh check is just a check
    const plain = service.check(['claude-code'], { fresh: true })
    await asked(3)
    answers[2]!(subscriptionLogin)
    expect((await plain)['claude-code'].state).toBe('ready')
    expect(answers).toHaveLength(3)
  })

  it('passes the configured Codex path to the detection', async () => {
    const settings = defaultAiSettings()
    settings.providers.codex = { apiKey: '', model: '', cliPath: 'D:\\tools\\codex.exe' }
    const seen: Array<[string, string | undefined]> = []
    const service = createSubscriptionStatusService({
      getSettings: () => settings,
      setMeteredAccepted: () => undefined,
      acceptanceStore: { read: async () => ({}), write: async () => undefined },
      detect: async (provider, options) => {
        seen.push([provider, options?.configuredPath])
        return { provider, state: 'not-installed' }
      },
    })
    await service.check()
    expect(seen.sort()).toEqual([
      ['chatgpt', undefined],
      ['claude-code', undefined],
      ['codex', 'D:\\tools\\codex.exe'],
    ])
  })
})

describe('the acceptance file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subscription-metered-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores the kind of login per provider and nothing else', async () => {
    const store = createMeteredAcceptanceFileStore(dir)
    expect(await store.read()).toEqual({})
    await store.write({ codex: 'metered:api-key' })
    expect(await store.read()).toEqual({ codex: 'metered:api-key' })
    const onDisk = JSON.parse(await readFile(join(dir, SUBSCRIPTION_METERED_FILE), 'utf8'))
    expect(onDisk).toEqual({ codex: 'metered:api-key' })
  })

  it('reads a damaged or foreign file as no acceptance', async () => {
    const store = createMeteredAcceptanceFileStore(dir)
    await writeFile(join(dir, SUBSCRIPTION_METERED_FILE), '{ not json')
    expect(await store.read()).toEqual({})
    await writeFile(
      join(dir, SUBSCRIPTION_METERED_FILE),
      JSON.stringify({
        codex: 7,
        anthropic: 'metered:x',
        'claude-code': 'metered:api_key/firstParty',
      }),
    )
    expect(await store.read()).toEqual({ 'claude-code': 'metered:api_key/firstParty' })
  })
})
