/**
 * "Fill with AI" in the EPUB dialog: nothing is checked or sent before the
 * button is pressed, a press goes through the shared send gate (connect
 * prompt, first-connection notice, held during the status check), and the
 * reply only fills the editable fields. The main process is a fake preload
 * bridge, so no provider is ever reached.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcStreamChunk } from '@genoffice/agent-core'
import {
  normalizeAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type SubscriptionStatusMap,
} from '@genoffice/ai-provider/browser'
import { createI18n } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'
import {
  ConvertDialog,
  type ConvertDialogApi,
  type ConvertDialogProps,
} from '../src/renderer/convert/ConvertDialog'

const translate = createI18n(strings)
const t: ConvertDialogProps['t'] = (key, params) => translate('en', key, params)
const en = strings.en

interface StreamStart {
  requestId: string
  system?: string
  messages: Array<{ role: string; content?: unknown; text?: string }>
  tools?: unknown[]
}

const statusesOf = (claude: AiSubscriptionState, codex: AiSubscriptionState) =>
  ({
    'claude-code': {
      provider: 'claude-code',
      state: claude,
      meteredAccepted: false,
      ...(claude === 'ready' ? { loginMethod: 'subscription' as const } : {}),
    },
    codex: {
      provider: 'codex',
      state: codex,
      meteredAccepted: false,
      ...(codex === 'ready' ? { loginMethod: 'subscription' as const } : {}),
    },
  }) as SubscriptionStatusMap

function fakeBridge(initial: { settings: AiSettings; statuses: SubscriptionStatusMap }) {
  const state = { settings: initial.settings, statuses: initial.statuses }
  const starts: StreamStart[] = []
  const statusListeners = new Set<(s: SubscriptionStatusMap) => void>()
  const settingsListeners = new Set<() => void>()
  let streamListener: ((chunk: IpcStreamChunk) => void) | null = null
  const subscription = {
    statuses: vi.fn(async () => state.statuses),
    recheck: vi.fn(async () => state.statuses),
    login: vi.fn(async () => ({ ok: true })),
    install: vi.fn(async () => ({ ok: true })),
    setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses: state.statuses })),
    onChanged: (handler: (s: SubscriptionStatusMap) => void) => {
      statusListeners.add(handler)
      return () => statusListeners.delete(handler)
    },
    openInstallHelp: vi.fn(async () => {}),
  }
  const api = {
    getAiSettings: vi.fn(async () => state.settings),
    setAiSettings: vi.fn(async (next: AiSettings) => {
      state.settings = next
      for (const listener of settingsListeners) listener()
    }),
    onAiSettingsChanged: (handler: () => void) => {
      settingsListeners.add(handler)
      return () => settingsListeners.delete(handler)
    },
    openAiModelSettings: vi.fn(async () => {}),
    subscription,
    aiStream: vi.fn(async (request: StreamStart) => {
      starts.push(request)
    }),
    aiStreamCancel: vi.fn(async () => {}),
    onAiStream: (listener: (chunk: IpcStreamChunk) => void) => {
      streamListener = listener
      return () => {
        streamListener = null
      }
    },
  }
  return {
    api,
    starts,
    subscription,
    push: (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
      streamListener?.({ requestId: starts.at(-1)!.requestId, ...chunk }),
    setStatuses: (next: SubscriptionStatusMap) => {
      state.statuses = next
      for (const listener of statusListeners) listener(next)
    },
  }
}

const structureApi = (): ConvertDialogApi => ({
  pickTarget: vi.fn(async () => null),
  convert: vi.fn(async () => ({ ok: false as const, error: 'failed' as const })),
  cancel: vi.fn(async () => true),
  onProgress: vi.fn(() => () => {}),
  releaseTarget: vi.fn(async () => true),
  openResult: vi.fn(async () => true),
  revealResult: vi.fn(async () => true),
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let bridge: ReturnType<typeof fakeBridge>

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

const PAGE_TEXT: Record<number, string> = {
  1: '',
  2: 'A Field Guide to Ferns',
  3: 'by Mina Park',
}

async function render(initial: {
  settings?: Partial<AiSettings>
  statuses: SubscriptionStatusMap
}) {
  bridge = fakeBridge({
    settings: { ...normalizeAiSettings({}), ...initial.settings },
    statuses: initial.statuses,
  })
  vi.stubGlobal('pdfApi', bridge.api)
  const pageText = vi.fn(async (page: number) => PAGE_TEXT[page] ?? '')
  const props: ConvertDialogProps = {
    format: 'epub',
    filePath: 'C:\\docs\\ferns.pdf',
    fileName: 'ferns.pdf',
    pageCount: 3,
    docInfo: {},
    password: undefined,
    lang: 'en',
    t,
    api: structureApi(),
    prepare: async () => true,
    pageText,
    onClose: () => {},
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ConvertDialog, props)))
  await settle()
  return { el: container, pageText }
}

const q = (el: Element, selector: string) => el.querySelector(selector) as HTMLElement | null
const field = (el: Element, name: string) =>
  (q(el, `[data-field="${name}"]`) as HTMLInputElement).value

const press = async (el: Element) => {
  await act(async () => q(el, '[data-action="ai-fill"]')!.click())
  await settle()
}

describe('EPUB dialog: Fill with AI', () => {
  it('checks nothing and sends nothing until the button is pressed', async () => {
    const { el, pageText } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('ready', 'ready'),
    })
    expect(q(el, '[data-action="ai-fill"]')?.textContent).toBe(en.cvAiFill)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(bridge.subscription.statuses).not.toHaveBeenCalled()
    expect(bridge.subscription.recheck).not.toHaveBeenCalled()
    expect(bridge.api.getAiSettings).not.toHaveBeenCalled()
    expect(pageText).not.toHaveBeenCalled()
  })

  it('sends the first pages once when pressed and fills the fields from the reply', async () => {
    const { el } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('ready', 'signed-out'),
    })
    await press(el)
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
    const request = bridge.starts[0]!
    expect(request.tools ?? []).toEqual([])
    const sent = JSON.stringify(request)
    expect(sent).toContain('A Field Guide to Ferns')
    expect(sent).toContain('by Mina Park')
    expect(q(el, '[data-ai-state]')?.textContent).toBe(en.cvAiFilling)

    await act(async () => {
      bridge.push({
        type: 'delta',
        text: 'Sure: {"title": "A Field Guide to Ferns", "author": "Mina Park", "language": "en"}',
      })
      bridge.push({ type: 'done' })
    })
    await settle()
    expect(field(el, 'title')).toBe('A Field Guide to Ferns')
    expect(field(el, 'author')).toBe('Mina Park')
    expect(field(el, 'language')).toBe('en')
    expect(q(el, '[data-ai-state]')?.textContent).toBe(en.cvAiFilled)
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
  })

  it('keeps the fields and says so when the reply is not usable', async () => {
    const { el } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('ready', 'signed-out'),
    })
    await press(el)
    await act(async () => {
      bridge.push({ type: 'delta', text: 'I cannot tell.' })
      bridge.push({ type: 'done' })
    })
    await settle()
    expect(field(el, 'title')).toBe('ferns')
    expect(q(el, '[data-ai-state]')?.textContent).toBe(en.cvAiUnreadable)
  })

  it('shows the connect prompt instead of sending when nothing is connected', async () => {
    const { el, pageText } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('signed-out', 'not-installed'),
    })
    await press(el)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(pageText).not.toHaveBeenCalled()
    expect(q(el, '.ai-sub-prompt')).not.toBeNull()
    // a sign-in afterwards does not send the refused request by itself
    await act(async () => bridge.setStatuses(statusesOf('ready', 'not-installed')))
    await settle()
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
  })

  it('never falls back to a filled-in key provider on its own', async () => {
    const base = normalizeAiSettings({})
    const { el } = await render({
      settings: {
        subscriptionNoticeSeen: true,
        providers: {
          ...base.providers,
          openai: { ...base.providers.openai, apiKey: 'sk-test', model: 'gpt-test' },
        },
      },
      statuses: statusesOf('signed-out', 'signed-out'),
    })
    await press(el)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(q(el, '.ai-sub-prompt')).not.toBeNull()
  })

  it('holds the press behind the first-connection notice until it is acknowledged', async () => {
    const { el } = await render({ statuses: statusesOf('ready', 'signed-out') })
    await press(el)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    const ack = q(el, '.ai-sub-first button')
    expect(ack).not.toBeNull()
    await act(async () => ack!.click())
    await settle()
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
  })

  it('holds a press made during the status check and sends it once a provider can run', async () => {
    const { el } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('checking', 'checking'),
    })
    // the check never answers by itself here
    bridge.subscription.recheck.mockImplementation(() => new Promise(() => {}))
    bridge.subscription.statuses.mockImplementation(() => new Promise(() => {}))
    await press(el)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    await act(async () => bridge.setStatuses(statusesOf('ready', 'signed-out')))
    await settle()
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when the first pages carry no text', async () => {
    const { el, pageText } = await render({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusesOf('ready', 'signed-out'),
    })
    pageText.mockImplementation(async () => '')
    await press(el)
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(q(el, '[data-ai-state]')?.textContent).toBe(en.cvAiNoText)
  })
})
