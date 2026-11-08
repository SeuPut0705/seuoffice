/**
 * What follows a login or a logout the app itself ran ("sign in with another
 * account", "sign out"): the metered acceptance of that provider is gone, and
 * the status comes from a check that started after the change.
 *
 * The launchers are replaced for the whole file: the real ones start the
 * vendor programs, and no test may reach those.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '../src/providers'
import {
  SUBSCRIPTION_IPC_CHANNELS,
  SUBSCRIPTION_METERED_FILE,
  createSubscriptionIpcDeps,
  notifySubscriptionLoginChange,
  registerSubscriptionIpc,
  type SubscriptionDetection,
  type SubscriptionDetector,
  type SubscriptionIpcDeps,
  type SubscriptionMeteredResult,
  type SubscriptionStatusMap,
} from '../src/subscription'
import type { AiSettings, AiSubscriptionProviderId } from '../src/types'

const launched = vi.hoisted(() => ({
  logins: [] as Array<{ provider: string; onExit?: (() => void) | undefined }>,
  logouts: [] as string[],
  /** runs when the logout command has ended, before the launcher answers */
  afterLogout: null as (() => void) | null,
}))

vi.mock('../src/subscription/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/subscription/launch')>()
  return {
    ...actual,
    launchSubscriptionLogin: async (
      provider: AiSubscriptionProviderId,
      options: { onExit?: () => void } = {},
    ) => {
      launched.logins.push({ provider, onExit: options.onExit })
      return { ok: true }
    },
    launchSubscriptionLogout: async (provider: AiSubscriptionProviderId) => {
      launched.logouts.push(provider)
      launched.afterLogout?.()
      // as the real launcher does once the command has ended
      actual.notifySubscriptionLoginChange(provider)
      return { ok: true }
    },
    launchSubscriptionInstall: async () => ({ ok: false, reason: 'unsupported' }),
  }
})

/** The login window the app opened last has closed: what the real launcher does on the exit */
function closeLoginWindow(): void {
  const login = launched.logins.at(-1)!
  notifySubscriptionLoginChange(login.provider as AiSubscriptionProviderId)
  login.onExit?.()
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain {
  handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return Promise.resolve(this.handlers.get(channel)!({ sender: {} }, ...args))
  }
}

const API_KEY_CLAUDE: SubscriptionDetection = {
  provider: 'claude-code',
  state: 'metered',
  loginMethod: 'metered',
  loginKind: 'api_key/firstParty',
  account: 'first@example.com',
}
const API_KEY_CODEX: SubscriptionDetection = {
  provider: 'codex',
  state: 'metered',
  loginMethod: 'metered',
  loginKind: 'api-key',
}
const SIGNED_OUT_CLAUDE: SubscriptionDetection = { provider: 'claude-code', state: 'signed-out' }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('an account change the app itself ran', () => {
  let dir: string
  let unregister: () => void = () => undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subscription-account-change-'))
    launched.logins.length = 0
    launched.logouts.length = 0
    launched.afterLogout = null
  })
  afterEach(async () => {
    unregister()
    await rm(dir, { recursive: true, force: true })
  })

  function app(detect: SubscriptionDetector): {
    ipc: FakeIpcMain
    deps: SubscriptionIpcDeps
    settings: AiSettings
    broadcasts: SubscriptionStatusMap[]
    record: () => Promise<Record<string, unknown>>
  } {
    const settings = defaultAiSettings()
    const broadcasts: SubscriptionStatusMap[] = []
    const deps = createSubscriptionIpcDeps({
      getSettings: () => settings,
      setMeteredAccepted: (provider, accepted) => {
        settings.meteredAccepted = { ...settings.meteredAccepted, [provider]: accepted }
      },
      dataDir: dir,
      detect,
      listModels: async () => undefined,
      broadcast: (channel, statuses) => {
        if (channel === SUBSCRIPTION_IPC_CHANNELS.changed) broadcasts.push(statuses)
      },
    })
    const ipc = new FakeIpcMain()
    unregister = registerSubscriptionIpc(ipc, deps)
    return {
      ipc,
      deps,
      settings,
      broadcasts,
      record: async () =>
        JSON.parse(
          await readFile(join(dir, SUBSCRIPTION_METERED_FILE), 'utf8').catch(() => '{}'),
        ) as Record<string, unknown>,
    }
  }

  /** Both providers signed in with a pay-per-use login, and "use anyway" given for both */
  async function bothAccepted(): Promise<ReturnType<typeof app>> {
    const running = app(async (provider) =>
      provider === 'claude-code' ? API_KEY_CLAUDE : API_KEY_CODEX,
    )
    await running.deps.service.check()
    for (const provider of ['claude-code', 'codex'] as const) {
      const result = (await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.metered, {
        provider,
        accepted: true,
      })) as SubscriptionMeteredResult
      expect(result.ok).toBe(true)
    }
    expect(running.settings.meteredAccepted).toEqual({ 'claude-code': true, codex: true })
    expect(await running.record()).toEqual({
      'claude-code': 'metered:api_key/firstParty',
      codex: 'metered:api-key',
    })
    return running
  }

  function expectClaudeClearedCodexKept(
    running: ReturnType<typeof app>,
    record: Record<string, unknown>,
  ): void {
    const statuses = running.deps.service.getStatuses()
    // the login found afterwards is of the same kind, and still not the one that was accepted
    expect(statuses['claude-code']).toMatchObject({ state: 'metered', meteredAccepted: false })
    expect(running.settings.meteredAccepted?.['claude-code']).toBe(false)
    expect(record['claude-code']).toBeUndefined()
    expect(running.broadcasts.at(-1)!['claude-code'].meteredAccepted).toBe(false)
    // the other provider's acceptance is its own
    expect(statuses.codex).toMatchObject({ state: 'metered', meteredAccepted: true })
    expect(running.settings.meteredAccepted?.codex).toBe(true)
    expect(record.codex).toBe('metered:api-key')
  }

  describe('clears "use anyway" for that provider', () => {
    it('a login the user changed outside the app keeps the acceptance while its kind is the same', async () => {
      const running = await bothAccepted()
      const rechecked = (await running.ipc.invoke(
        SUBSCRIPTION_IPC_CHANNELS.recheck,
      )) as SubscriptionStatusMap
      expect(rechecked['claude-code'].meteredAccepted).toBe(true)
      expect(rechecked.codex.meteredAccepted).toBe(true)
    })

    it('after a logout, though the login found afterwards is of the same kind', async () => {
      const running = await bothAccepted()
      expect(
        await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.logout, { provider: 'claude-code' }),
      ).toEqual({ ok: true })
      expect(launched.logouts).toEqual(['claude-code'])
      expectClaudeClearedCodexKept(running, await running.record())
      // and a later check does not bring it back
      const later = await running.deps.service.check()
      expect(later['claude-code'].meteredAccepted).toBe(false)
      expect(later.codex.meteredAccepted).toBe(true)
    })

    it('after a login window the app opened has closed, though the login is of the same kind', async () => {
      const running = await bothAccepted()
      expect(
        await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.login, { provider: 'claude-code' }),
      ).toEqual({ ok: true })
      // nothing changed while the window is open
      expect(running.deps.service.getStatuses()['claude-code'].meteredAccepted).toBe(true)
      closeLoginWindow()
      await vi.waitFor(() => expect(running.settings.meteredAccepted?.['claude-code']).toBe(false))
      await running.deps.service.check()
      expectClaudeClearedCodexKept(running, await running.record())
    })

    it('writes nothing for a provider nothing was accepted for', async () => {
      const written: string[] = []
      const running = app(async (provider) =>
        provider === 'claude-code' ? API_KEY_CLAUDE : API_KEY_CODEX,
      )
      const setting = running.settings
      Object.defineProperty(setting, 'meteredAccepted', {
        get: () => undefined,
        set: () => void written.push('setting'),
      })
      await running.deps.service.check()
      await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.logout, { provider: 'claude-code' })
      await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.login, { provider: 'codex' })
      closeLoginWindow()
      await running.deps.service.check(undefined, { fresh: true })
      // a first sign-in must not rewrite the settings file or create the acceptance file
      expect(written).toEqual([])
      expect(await readFile(join(dir, SUBSCRIPTION_METERED_FILE), 'utf8').catch(() => null)).toBe(
        null,
      )
    })

    it('stops when the channels are unregistered', async () => {
      const running = await bothAccepted()
      unregister()
      notifySubscriptionLoginChange('claude-code')
      await running.deps.service.check()
      expect(running.settings.meteredAccepted?.['claude-code']).toBe(true)
    })
  })

  describe('is followed by a status from a check that started after it', () => {
    const READY_A: SubscriptionDetection = {
      provider: 'claude-code',
      state: 'ready',
      loginMethod: 'subscription',
      account: 'first@example.com',
    }
    const READY_B: SubscriptionDetection = { ...READY_A, account: 'second@example.com' }

    /** Claude answers from `answers` in turn, the last one from then on; Codex is not installed */
    function claudeAnswers(
      answers: Array<SubscriptionDetection | Promise<SubscriptionDetection>>,
    ): {
      detect: SubscriptionDetector
      asked: () => number
    } {
      let asked = 0
      return {
        detect: async (provider) => {
          if (provider !== 'claude-code') return { provider, state: 'not-installed' }
          return answers[Math.min(asked++, answers.length - 1)]!
        },
        asked: () => asked,
      }
    }

    it('a logout is not answered from a check that was already under way', async () => {
      const stale = deferred<SubscriptionDetection>()
      const claude = claudeAnswers([stale.promise, SIGNED_OUT_CLAUDE])
      const running = app(claude.detect)
      const early = running.deps.service.check(['claude-code'])
      await vi.waitFor(() => expect(claude.asked()).toBe(1))
      // the check under way asked the CLI before the logout: it answers with the old login
      launched.afterLogout = () => void setTimeout(() => stale.resolve(READY_A), 5)

      expect(
        await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.logout, { provider: 'claude-code' }),
      ).toEqual({ ok: true })
      const signedOut = { provider: 'claude-code', state: 'signed-out', meteredAccepted: false }
      expect(running.deps.service.getStatuses()['claude-code']).toEqual(signedOut)
      expect(running.broadcasts.at(-1)!['claude-code']).toEqual(signedOut)
      // one check after the one under way, and no more
      expect(claude.asked()).toBe(2)
      await early
      expect(running.deps.service.getStatuses()['claude-code']).toEqual(signedOut)
    })

    it('a logout with no check under way is followed by one check', async () => {
      const claude = claudeAnswers([READY_A, SIGNED_OUT_CLAUDE])
      const running = app(claude.detect)
      await running.deps.service.check(['claude-code'])
      await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.logout, { provider: 'claude-code' })
      expect(claude.asked()).toBe(2)
      expect(running.deps.service.getStatuses()['claude-code'].state).toBe('signed-out')
    })

    it('a closed login window is not answered from a check that was already under way', async () => {
      const stale = deferred<SubscriptionDetection>()
      const claude = claudeAnswers([READY_A, stale.promise, READY_B])
      const running = app(claude.detect)
      await running.deps.service.check(['claude-code'])
      await running.ipc.invoke(SUBSCRIPTION_IPC_CHANNELS.login, { provider: 'claude-code' })
      // the window regains focus and re-checks while the login program is still finishing
      const early = running.deps.service.check(['claude-code'])
      await vi.waitFor(() => expect(claude.asked()).toBe(2))
      closeLoginWindow()
      stale.resolve(READY_A)
      await early

      await vi.waitFor(() =>
        expect(running.deps.service.getStatuses()['claude-code'].account).toBe(
          'second@example.com',
        ),
      )
      expect(running.broadcasts.at(-1)!['claude-code']).toMatchObject({
        state: 'ready',
        account: 'second@example.com',
      })
      expect(claude.asked()).toBe(3)
    })
  })
})
