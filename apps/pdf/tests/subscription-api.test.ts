// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIPTION_IPC_CHANNELS } from '@genoffice/ai-provider/browser'
import type { PdfApi } from '../src/shared/ipc'
import {
  AI_TOOL_CAPABILITIES_CHANNEL,
  SUBSCRIPTION_INSTALL_HELP_CHANNEL,
  checkingSubscriptionStatuses,
  imageGenerationAvailableOf,
  subscriptionLaunchResultOf,
  subscriptionMeteredResultOf,
  subscriptionStatusMapOf,
} from '../src/shared/subscription-api'

const invoke = vi.fn()
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const removed: string[] = []
const exposed = new Map<string, unknown>()
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: vi.fn(),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      listeners.set(channel, fn),
    removeListener: (channel: string) => removed.push(channel),
  },
}))
vi.mock('@genoffice/electron-utils/drop-open', () => ({ installDropOpenBridge: vi.fn() }))

const CHECKING = checkingSubscriptionStatuses()
/** an answer that names no ChatGPT status comes from an app without that connection */
const ANSWERED = {
  ...CHECKING,
  chatgpt: { provider: 'chatgpt', state: 'signed-out', meteredAccepted: false },
}

describe('subscriptionStatusMapOf', () => {
  it('reads a missing or malformed answer as still checking', () => {
    expect(subscriptionStatusMapOf(undefined)).toEqual(CHECKING)
    expect(subscriptionStatusMapOf('nope')).toEqual(CHECKING)
    expect(subscriptionStatusMapOf({ codex: { state: 'bogus' } })).toEqual(ANSWERED)
  })

  it('fills in the provider an answer leaves out', () => {
    const map = subscriptionStatusMapOf({
      'claude-code': { provider: 'claude-code', state: 'ready', planName: 'max' },
    })
    expect(map['claude-code']).toEqual({
      provider: 'claude-code',
      state: 'ready',
      planName: 'max',
      meteredAccepted: false,
    })
    expect(map.codex).toEqual(CHECKING.codex)
  })

  it('accepts a metered acceptance only when it is literally true', () => {
    const map = subscriptionStatusMapOf({
      'claude-code': { state: 'metered', meteredAccepted: 'yes' },
      codex: { state: 'metered', meteredAccepted: true },
    })
    expect(map['claude-code'].meteredAccepted).toBe(false)
    expect(map.codex.meteredAccepted).toBe(true)
  })
})

describe('subscriptionLaunchResultOf', () => {
  it('passes a started launch through', () => {
    expect(subscriptionLaunchResultOf({ ok: true })).toEqual({ ok: true })
  })

  it('reads anything unreadable as a plain failure', () => {
    expect(subscriptionLaunchResultOf(undefined)).toEqual({ ok: false, reason: 'failed' })
    expect(subscriptionLaunchResultOf({ ok: false, reason: 'weird' })).toEqual({
      ok: false,
      reason: 'failed',
    })
  })

  it('leaves the spawn error text behind and keeps the install page', () => {
    expect(
      subscriptionLaunchResultOf({
        ok: false,
        reason: 'unsupported',
        error: 'spawn C:\\Users\\someone\\codex.exe ENOENT',
        installUrl: 'https://example.com/install',
      }),
    ).toEqual({ ok: false, reason: 'unsupported', installUrl: 'https://example.com/install' })
  })
})

describe('subscriptionMeteredResultOf', () => {
  it('always carries a full status map', () => {
    expect(subscriptionMeteredResultOf(undefined)).toEqual({ ok: false, statuses: CHECKING })
    const result = subscriptionMeteredResultOf({
      ok: true,
      statuses: { codex: { state: 'metered', meteredAccepted: true } },
    })
    expect(result.ok).toBe(true)
    expect(result.statuses.codex.meteredAccepted).toBe(true)
    expect(result.statuses['claude-code']).toEqual(CHECKING['claude-code'])
  })
})

describe('imageGenerationAvailableOf', () => {
  it('follows the image-generation entry of the capabilities answer', () => {
    expect(
      imageGenerationAvailableOf({
        imageGeneration: { available: true, route: 'subscription', provider: 'codex' },
      }),
    ).toBe(true)
    expect(
      imageGenerationAvailableOf({
        imageGeneration: { available: false, route: null, provider: null, message: 'none' },
        imageSearch: { available: true, route: 'free', provider: 'parallel' },
      }),
    ).toBe(false)
  })

  it('reads anything else as unavailable', () => {
    for (const answer of [undefined, null, true, 'yes', [], {}, { imageGeneration: true }]) {
      expect(imageGenerationAvailableOf(answer)).toBe(false)
    }
    expect(imageGenerationAvailableOf({ imageGeneration: { available: 'true' } })).toBe(false)
  })
})

describe('pdf preload bridge', () => {
  let api: PdfApi

  beforeEach(async () => {
    invoke.mockReset()
    listeners.clear()
    removed.length = 0
    await import('../src/preload/index')
    api = exposed.get('pdfApi') as PdfApi
  })

  it('asks the shared subscription channels and normalises the answers', async () => {
    invoke.mockResolvedValue({ codex: { state: 'ready' } })
    expect((await api.subscription.statuses()).codex.state).toBe('ready')
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.statuses)

    await api.subscription.recheck(['codex'])
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.recheck, {
      providers: ['codex'],
    })
    await api.subscription.recheck()
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.recheck, undefined)

    invoke.mockResolvedValue({ ok: false, reason: 'not-installed', error: 'C:\\secret\\path' })
    expect(await api.subscription.login('claude-code')).toEqual({
      ok: false,
      reason: 'not-installed',
    })
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.login, {
      provider: 'claude-code',
    })
    await api.subscription.install('codex')
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.install, {
      provider: 'codex',
    })

    invoke.mockResolvedValue({ ok: true, statuses: {} })
    expect(await api.subscription.setMeteredAccepted('codex', true)).toEqual({
      ok: true,
      statuses: ANSWERED,
    })
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_IPC_CHANNELS.metered, {
      provider: 'codex',
      accepted: true,
    })

    invoke.mockResolvedValue(undefined)
    await api.subscription.openInstallHelp('codex')
    expect(invoke).toHaveBeenLastCalledWith(SUBSCRIPTION_INSTALL_HELP_CHANNEL, 'codex')
  })

  it('lets a missing handler reject, for the renderer to read as still checking', async () => {
    invoke.mockRejectedValue(new Error("No handler registered for 'ai:subscription-statuses'"))
    await expect(api.subscription.statuses()).rejects.toThrow('No handler')
  })

  it('forwards status changes as a full map and unsubscribes', () => {
    const seen: unknown[] = []
    const off = api.subscription.onChanged((statuses) => seen.push(statuses))
    listeners.get(SUBSCRIPTION_IPC_CHANNELS.changed)!({}, { codex: { state: 'signed-out' } })
    expect(seen).toEqual([
      {
        'claude-code': CHECKING['claude-code'],
        chatgpt: ANSWERED.chatgpt,
        codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
      },
    ])
    off()
    expect(removed).toEqual([SUBSCRIPTION_IPC_CHANNELS.changed])
  })

  it('asks the capabilities channel whether an image can be generated', async () => {
    invoke.mockResolvedValue({ imageGeneration: { available: true } })
    expect(await api.imageGenerationAvailable()).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith(AI_TOOL_CAPABILITIES_CHANNEL)
    invoke.mockResolvedValue({ imageGeneration: { available: false } })
    expect(await api.imageGenerationAvailable()).toBe(false)
  })

  it('reads a missing capabilities handler as unavailable', async () => {
    invoke.mockRejectedValue(new Error("No handler registered for 'ai:tool-capabilities'"))
    expect(await api.imageGenerationAvailable()).toBe(false)
  })
})
