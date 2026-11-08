/**
 * The model list a subscription CLI gives: how it is read, bounded and carried
 * by the connection status. The list arrives after the status and never holds
 * it up. No test here starts a real CLI.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '../src/providers'
import {
  SUBSCRIPTION_MODELS_MAX,
  createSubscriptionStatusService,
  listSubscriptionModels,
  setSubscriptionModelSource,
  subscriptionModelsOf,
  subscriptionStatusMapOf,
  type MeteredAcceptanceRecord,
  type SubscriptionDetection,
  type SubscriptionModelLister,
  type SubscriptionStatusMap,
} from '../src/subscription'
import type { AiSubscriptionModel, AiSubscriptionProviderId } from '../src/types'

const CLAUDE_MODELS: AiSubscriptionModel[] = [
  { id: '', label: 'Default (recommended)', resolved: 'claude-opus-5-5', isDefault: true },
  { id: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5' },
  { id: 'sonnet', label: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' },
]

describe('subscriptionModelsOf', () => {
  it('keeps the listed fields of a well-formed list', () => {
    expect(subscriptionModelsOf(CLAUDE_MODELS)).toEqual(CLAUDE_MODELS)
    // fields the contract does not list are left behind
    expect(
      subscriptionModelsOf([
        {
          id: 'opus',
          label: 'Opus 5.5',
          description: 'Best for everyday tasks',
          account: 'x@y.kr',
        },
      ]),
    ).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
  })

  it('reads anything that is not a list of models as absent', () => {
    for (const value of [undefined, null, 'opus', 7, {}, [], [null, 3, 'opus'], [{ label: 'x' }]]) {
      expect(subscriptionModelsOf(value), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('drops an entry whose id could not be given to the CLI', () => {
    const read = subscriptionModelsOf([
      { id: '--dangerously-skip-permissions', label: 'Flag' },
      { id: 'opus; rm -rf', label: 'Shell' },
      { id: 'x'.repeat(200), label: 'Long' },
      { id: 7, label: 'Number' },
      { id: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M)' },
    ])
    expect(read).toEqual([{ id: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M)' }])
  })

  it('trims and bounds the names, and falls back to the id for a missing one', () => {
    const read = subscriptionModelsOf([
      { id: ' opus ', label: '  Opus 5.5\n' },
      { id: 'haiku', label: '' },
      { id: 'sonnet', label: 'S'.repeat(500), resolved: 'not a model id' },
      { id: 'fable', label: 'Fable\u0000 5.1', resolved: ' claude-fable-5-1 ', isDefault: 'yes' },
    ])
    expect(read).toEqual([
      { id: 'opus', label: 'Opus 5.5' },
      { id: 'haiku', label: 'haiku' },
      { id: 'sonnet', label: 'S'.repeat(80) },
      { id: 'fable', label: 'Fable 5.1', resolved: 'claude-fable-5-1' },
    ])
  })

  it('keeps one entry per id and at most the bounded number of entries', () => {
    expect(
      subscriptionModelsOf([
        { id: 'opus', label: 'Opus 5.5' },
        { id: 'opus', label: 'Opus again' },
      ]),
    ).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
    const many = Array.from({ length: 500 }, (_, index) => ({
      id: `m-${index}`,
      label: `M${index}`,
    }))
    expect(subscriptionModelsOf(many)).toHaveLength(SUBSCRIPTION_MODELS_MAX)
  })

  it('takes the default entry (empty id) only when it says what it resolves to', () => {
    expect(subscriptionModelsOf([{ id: '', label: '', isDefault: true }])).toBeUndefined()
    expect(subscriptionModelsOf([{ id: '', label: '', resolved: 'claude-opus-5-5' }])).toEqual([
      { id: '', label: 'claude-opus-5-5', resolved: 'claude-opus-5-5', isDefault: true },
    ])
  })

  it('is applied by the status sanitiser, for the states that can run only', () => {
    const ready = { provider: 'claude-code', state: 'ready', meteredAccepted: false }
    const withList = subscriptionStatusMapOf({
      'claude-code': { ...ready, models: [...CLAUDE_MODELS, { id: '--flag', label: 'x' }] },
    })
    expect(withList['claude-code']).toEqual({ ...ready, models: CLAUDE_MODELS })
    const malformed = subscriptionStatusMapOf({ 'claude-code': { ...ready, models: 'opus' } })
    expect(malformed['claude-code']).toEqual(ready)
    expect('models' in malformed['claude-code']).toBe(false)
    const signedOut = subscriptionStatusMapOf({
      'claude-code': { ...ready, state: 'signed-out', models: CLAUDE_MODELS },
    })
    expect('models' in signedOut['claude-code']).toBe(false)
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function serviceWith(options: {
  detections: Partial<Record<AiSubscriptionProviderId, SubscriptionDetection>>
  listModels?: SubscriptionModelLister
}) {
  const changes: SubscriptionStatusMap[] = []
  const settings = defaultAiSettings()
  settings.providers.codex = { ...settings.providers.codex, cliPath: 'D:\\codex.exe' }
  let record: MeteredAcceptanceRecord = {}
  const service = createSubscriptionStatusService({
    getSettings: () => settings,
    setMeteredAccepted: (provider, accepted) => {
      settings.meteredAccepted = { ...settings.meteredAccepted, [provider]: accepted }
    },
    acceptanceStore: {
      read: async () => ({ ...record }),
      write: async (next) => {
        record = { ...next }
      },
    },
    detect: async (provider) =>
      options.detections[provider] ?? { provider, state: 'not-installed' },
    listModels: options.listModels,
    onChange: (statuses) => changes.push(statuses),
  })
  return { service, changes }
}

const READY_CLAUDE: SubscriptionDetection = {
  provider: 'claude-code',
  state: 'ready',
  loginMethod: 'subscription',
  loginKind: 'claude.ai/firstParty',
}

const METERED_CODEX: SubscriptionDetection = {
  provider: 'codex',
  state: 'metered',
  loginMethod: 'metered',
  loginKind: 'api-key',
}

describe('the model list on the connection status', () => {
  it('arrives after the status: the check does not wait for it', async () => {
    const pending = deferred<AiSubscriptionModel[] | undefined>()
    const asked: unknown[] = []
    const { service, changes } = serviceWith({
      detections: { 'claude-code': READY_CLAUDE },
      listModels: (provider, options) => {
        asked.push([provider, options?.configuredPath])
        return pending.promise
      },
    })
    const checked = await service.check(['claude-code'])
    // the status is there, the list is still being read
    expect(checked['claude-code'].state).toBe('ready')
    expect(checked['claude-code'].models).toBeUndefined()
    expect(asked).toEqual([['claude-code', undefined]])
    const before = changes.length

    pending.resolve(CLAUDE_MODELS)
    await settle()
    expect(changes).toHaveLength(before + 1)
    expect(changes.at(-1)!['claude-code']).toMatchObject({ state: 'ready', models: CLAUDE_MODELS })
    expect(service.getStatuses()['claude-code'].models).toEqual(CLAUDE_MODELS)
  })

  it('is asked for a login that is signed in only', async () => {
    const asked: string[] = []
    const listModels: SubscriptionModelLister = async (provider) => {
      asked.push(provider)
      return CLAUDE_MODELS
    }
    for (const state of ['not-installed', 'signed-out', 'error'] as const) {
      const { service } = serviceWith({
        detections: { 'claude-code': { provider: 'claude-code', state } },
        listModels,
      })
      await service.check(['claude-code'])
      await settle()
      expect(service.getStatuses()['claude-code'].models, state).toBeUndefined()
    }
    expect(asked).toEqual([])

    const ready = serviceWith({ detections: { 'claude-code': READY_CLAUDE }, listModels })
    await ready.service.check(['claude-code'])
    await settle()
    expect(asked).toEqual(['claude-code'])
    expect(ready.service.getStatuses()['claude-code'].models).toEqual(CLAUDE_MODELS)
  })

  it('is not asked of a metered login the user has not accepted: its program is not started for a list', async () => {
    const asked: Array<[string, string | undefined]> = []
    const { service, changes } = serviceWith({
      detections: { codex: METERED_CODEX },
      listModels: async (provider, options) => {
        asked.push([provider, options?.configuredPath])
        return CLAUDE_MODELS
      },
    })
    for (let round = 0; round < 2; round++) {
      const checked = await service.check(['codex'])
      await settle()
      expect(checked.codex).toMatchObject({ state: 'metered', meteredAccepted: false })
      // no list: the UI shows its built-in one
      expect('models' in service.getStatuses().codex).toBe(false)
    }
    expect(asked).toEqual([])
    expect(changes.every((statuses) => statuses.codex.models === undefined)).toBe(true)

    // "use anyway": now the app may use this login, and the list is read, once
    const accepted = await service.setMeteredAccepted('codex', true)
    expect(accepted.ok).toBe(true)
    expect(accepted.statuses.codex.models).toBeUndefined()
    const before = changes.length
    await settle()
    expect(asked).toEqual([['codex', 'D:\\codex.exe']])
    // it follows on the change event, like the list of a subscription
    expect(changes).toHaveLength(before + 1)
    expect(changes.at(-1)!.codex).toMatchObject({
      state: 'metered',
      meteredAccepted: true,
      models: CLAUDE_MODELS,
    })

    // while accepted it behaves like a subscription: kept, and read again on a re-check
    const rechecked = await service.check(['codex'])
    expect(rechecked.codex).toMatchObject({ meteredAccepted: true, models: CLAUDE_MODELS })
    await settle()
    expect(asked).toHaveLength(2)

    // the acceptance taken back: no list on the status, and none asked for again
    const withdrawn = await service.setMeteredAccepted('codex', false)
    expect(withdrawn.statuses.codex.meteredAccepted).toBe(false)
    expect('models' in withdrawn.statuses.codex).toBe(false)
    await service.check(['codex'])
    await settle()
    expect('models' in service.getStatuses().codex).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('a list that arrives after the acceptance was taken back is not shown', async () => {
    const pending = deferred<AiSubscriptionModel[] | undefined>()
    const { service, changes } = serviceWith({
      detections: { codex: METERED_CODEX },
      listModels: () => pending.promise,
    })
    await service.check(['codex'])
    await service.setMeteredAccepted('codex', true)
    await service.setMeteredAccepted('codex', false)
    const before = changes.length
    pending.resolve(CLAUDE_MODELS)
    await settle()
    expect('models' in service.getStatuses().codex).toBe(false)
    expect(changes).toHaveLength(before)
  })

  it('hands the configured path of the CLI to the lister', async () => {
    const paths: Array<string | undefined> = []
    const { service } = serviceWith({
      detections: { codex: { provider: 'codex', state: 'ready', loginMethod: 'subscription' } },
      listModels: async (_provider, options) => {
        paths.push(options?.configuredPath)
        return undefined
      },
    })
    await service.check(['codex'])
    await settle()
    expect(paths).toEqual(['D:\\codex.exe'])
  })

  it('a list that cannot be read leaves the status as it is and announces nothing', async () => {
    for (const listModels of [
      async () => undefined,
      async () => [],
      async () => {
        throw new Error('spawn C:\\Users\\jun.il\\claude.exe ENOENT')
      },
    ] as SubscriptionModelLister[]) {
      const { service, changes } = serviceWith({
        detections: { 'claude-code': READY_CLAUDE },
        listModels,
      })
      const checked = await service.check(['claude-code'])
      const before = changes.length
      await settle()
      expect(changes).toHaveLength(before)
      expect(service.getStatuses()['claude-code']).toEqual(checked['claude-code'])
      expect(service.getStatuses()['claude-code'].state).toBe('ready')
    }
  })

  it('is kept for the process and read again on a re-check', async () => {
    let list: AiSubscriptionModel[] | undefined = CLAUDE_MODELS
    let reading: Promise<AiSubscriptionModel[] | undefined> | undefined
    let asked = 0
    const { service, changes } = serviceWith({
      detections: { 'claude-code': READY_CLAUDE },
      listModels: async () => {
        asked++
        return reading ?? list
      },
    })
    await service.check(['claude-code'])
    await settle()
    expect(asked).toBe(1)

    // the next check answers with the list it already has, and asks again
    const next = [...CLAUDE_MODELS, { id: 'haiku', label: 'Haiku 4.5' }]
    const second = deferred<AiSubscriptionModel[] | undefined>()
    reading = second.promise
    const rechecked = await service.check(['claude-code'])
    expect(rechecked['claude-code'].models).toEqual(CLAUDE_MODELS)
    expect(asked).toBe(2)
    second.resolve(next)
    reading = undefined
    list = next
    await settle()
    expect(service.getStatuses()['claude-code'].models).toEqual(next)

    // an unchanged list is not announced again
    const before = changes.length
    await service.check(['claude-code'])
    const afterCheck = changes.length
    await settle()
    expect(asked).toBe(3)
    expect(changes).toHaveLength(afterCheck)
    expect(afterCheck).toBe(before + 1)

    // a failed reading keeps what was read before
    list = undefined
    await service.check(['claude-code'])
    await settle()
    expect(service.getStatuses()['claude-code'].models).toEqual(next)
  })

  it('does not start a second reading while one is under way', async () => {
    const pending = deferred<AiSubscriptionModel[] | undefined>()
    let asked = 0
    const { service } = serviceWith({
      detections: { 'claude-code': READY_CLAUDE },
      listModels: () => {
        asked++
        return pending.promise
      },
    })
    await service.check(['claude-code'])
    await service.check(['claude-code'])
    expect(asked).toBe(1)
    pending.resolve(CLAUDE_MODELS)
    await settle()
    expect(service.getStatuses()['claude-code'].models).toEqual(CLAUDE_MODELS)
  })

  it('is dropped when the CLI is signed out, and an answer for the old login is not used', async () => {
    const detections: Partial<Record<AiSubscriptionProviderId, SubscriptionDetection>> = {
      'claude-code': READY_CLAUDE,
    }
    const first = deferred<AiSubscriptionModel[] | undefined>()
    const second = deferred<AiSubscriptionModel[] | undefined>()
    const answers = [first.promise, second.promise]
    const { service } = serviceWith({ detections, listModels: () => answers.shift()! })
    await service.check(['claude-code'])

    detections['claude-code'] = { provider: 'claude-code', state: 'signed-out' }
    await service.check(['claude-code'])
    first.resolve(CLAUDE_MODELS)
    await settle()
    expect(service.getStatuses()['claude-code']).toEqual({
      provider: 'claude-code',
      state: 'signed-out',
      meteredAccepted: false,
    })

    // signed in again: the list is read for this login, not taken from the one before
    detections['claude-code'] = READY_CLAUDE
    const again = await service.check(['claude-code'])
    expect(again['claude-code'].models).toBeUndefined()
    second.resolve([{ id: 'haiku', label: 'Haiku 4.5' }])
    await settle()
    expect(service.getStatuses()['claude-code'].models).toEqual([
      { id: 'haiku', label: 'Haiku 4.5' },
    ])
  })

  it('without a lister nothing is asked: a headless caller starts no extra program', async () => {
    const { service, changes } = serviceWith({ detections: { 'claude-code': READY_CLAUDE } })
    await service.check()
    await settle()
    expect(changes.every((statuses) => statuses['claude-code'].models === undefined)).toBe(true)
  })
})

describe('listSubscriptionModels', () => {
  afterEach(() => {
    setSubscriptionModelSource('claude-code', null)
    setSubscriptionModelSource('codex', null)
  })

  it('asks the source the bridge registered, with the configured path', async () => {
    const asked: Array<string | undefined> = []
    setSubscriptionModelSource('claude-code', async ({ configuredPath }) => {
      asked.push(configuredPath)
      return [...CLAUDE_MODELS, { id: '--flag', label: 'x' }]
    })
    expect(
      await listSubscriptionModels('claude-code', { configuredPath: 'C:\\claude.exe' }),
    ).toEqual(CLAUDE_MODELS)
    expect(asked).toEqual(['C:\\claude.exe'])
    // no bridge loaded for the other provider: no list, and nothing thrown
    expect(await listSubscriptionModels('codex')).toBeUndefined()
  })

  it('reads a source that fails or answers nonsense as no list', async () => {
    setSubscriptionModelSource('codex', async () => {
      throw new Error('Codex app-server exited (1): jun.il@school.kr')
    })
    expect(await listSubscriptionModels('codex')).toBeUndefined()
    setSubscriptionModelSource('codex', async () => 'gpt-next')
    expect(await listSubscriptionModels('codex')).toBeUndefined()
  })

  it('gives up on a source that does not answer, and tells it to stop', async () => {
    let aborted = false
    setSubscriptionModelSource(
      'claude-code',
      ({ signal }) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            aborted = true
          })
        }),
    )
    const started = Date.now()
    expect(await listSubscriptionModels('claude-code', { timeoutMs: 30 })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(aborted).toBe(true)
  })

  it('ends what the source started once it has its answer, too', async () => {
    let signalSeen: AbortSignal | undefined
    setSubscriptionModelSource('claude-code', async ({ signal }) => {
      signalSeen = signal
      return CLAUDE_MODELS
    })
    await listSubscriptionModels('claude-code')
    expect(signalSeen?.aborted).toBe(true)
  })
})
