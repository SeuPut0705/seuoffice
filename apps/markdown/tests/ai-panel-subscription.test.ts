import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type SubscriptionStatusMap,
} from '@genoffice/ai-provider/browser'
import { AiPanel, type MarkdownAiDeps } from '../src/renderer/ai/AiPanel'

// The panel under the subscription contract, mounted against a fake preload
// bridge. No provider is ever called: the fake `aiStream` only records the
// request, and the test plays the main process's chunks back.

interface StreamRequest {
  requestId: string
  settings: AiSettings
  system: string
  tools: Array<{ name: string }>
}

type Chunk = Record<string, unknown> & { type: string }

const statusMap = (claude: AiSubscriptionState, codex: AiSubscriptionState) =>
  ({
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }) as SubscriptionStatusMap

function installBridge(options: {
  settings?: Partial<AiSettings>
  statuses?: SubscriptionStatusMap
  /** omit: the capability handler is not registered (the invoke rejects) */
  imageGeneration?: boolean
}) {
  let settings: AiSettings = { ...normalizeAiSettings(undefined), ...options.settings }
  const settingsListeners = new Set<() => void>()
  const streamListeners = new Set<(chunk: Chunk) => void>()
  const requests: StreamRequest[] = []
  let statuses = options.statuses ?? statusMap('checking', 'checking')
  const statusListeners = new Set<(next: SubscriptionStatusMap) => void>()
  const subscription = {
    statuses: vi.fn(async () => statuses),
    recheck: vi.fn(async () => statuses),
    login: vi.fn(async () => ({ ok: true })),
    install: vi.fn(async () => ({ ok: true })),
    setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses: options.statuses })),
    onChanged: vi.fn((listener: (next: SubscriptionStatusMap) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }),
    openInstallHelp: vi.fn(async () => {}),
  }
  const api = {
    getAiSettings: vi.fn(async () => settings),
    setAiSettings: vi.fn(async (next: AiSettings) => {
      settings = next
      settingsListeners.forEach((listener) => listener())
    }),
    onAiSettingsChanged: (listener: () => void) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    openAiModelSettings: vi.fn(async () => {}),
    setAiPanelPrefs: vi.fn(async () => ({})),
    aiStream: vi.fn(async (request: StreamRequest) => {
      requests.push(request)
    }),
    aiStreamCancel: vi.fn(async () => {}),
    onAiStream: (listener: (chunk: Chunk) => void) => {
      streamListeners.add(listener)
      return () => streamListeners.delete(listener)
    },
    aiSubscription: subscription,
    aiToolCapabilities: vi.fn(async () => {
      if (options.imageGeneration === undefined) {
        throw new Error("No handler registered for 'ai:tool-capabilities'")
      }
      return { imageGeneration: { available: options.imageGeneration } }
    }),
  }
  Object.defineProperty(window, 'markdownApi', { configurable: true, value: api })
  Object.defineProperty(window, 'projectApi', { configurable: true, value: undefined })
  return {
    api,
    subscription,
    requests,
    emit: (chunk: Chunk) => [...streamListeners].forEach((listener) => listener(chunk)),
    /** the main process reports a status change */
    setStatuses: (next: SubscriptionStatusMap) => {
      statuses = next
      statusListeners.forEach((listener) => listener(next))
    },
    /** what is stored changes behind the panel's back (no change event reaches it) */
    storeSilently: (next: AiSettings) => {
      settings = next
    },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

/** let the promise chains of a mount, a click or a played-back chunk settle */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountPanel(): Promise<HTMLElement> {
  const deps: MarkdownAiDeps = {
    getEditor: () => null,
    getFrontmatter: () => '',
    setFrontmatter: () => {},
    getSnapshot: () => ({ body: '', frontmatter: '' }),
    restoreSnapshot: () => {},
    onRunDone: () => {},
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(AiPanel, { deps, filePath: null, onCollapse: () => {} })))
  mounted.push({ root, container })
  await settle()
  return container
}

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
  await settle()
}

/** type a message and press Enter: while a reply runs, that queues it */
async function typeAndEnter(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const target = container.querySelector<HTMLElement>(selector)
  expect(target, selector).not.toBeNull()
  act(() => target!.click())
  await settle()
}

beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  vi.unstubAllGlobals()
})

/** records what the panel scrolls into view (jsdom implements no scrolling of its own) */
function watchScrollIntoView(): Element[] {
  const scrolled: Element[] = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  return scrolled
}

const composerText = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea')!.value

describe('AiPanel under the subscription contract', () => {
  it('shows the connect prompt and starts no run while nothing is connected', async () => {
    const scrolled = watchScrollIntoView()
    const bridge = installBridge({ statuses: statusMap('signed-out', 'not-installed') })
    const container = await mountPanel()

    const prompt = container.querySelector('.ai-sub-prompt')
    expect(prompt?.getAttribute('data-reason')).toBe('no-subscription')
    expect(scrolled).toEqual([])

    await sendMessage(container, 'summarize this')
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    // the request stays in the composer for after the connection is made
    expect(composerText(container)).toBe('summarize this')
    expect(container.querySelector('.ai-msg-user')).toBeNull()
    // the refused send points at the prompt
    expect(scrolled).toContain(container.querySelector('.ai-sub-prompt'))

    // which AI the user has comes first; each answer leads to its own card
    await click(container, '.ai-sub-prompt [data-path="claude-code"]')
    await click(container, '.ai-sub-prompt [data-action="login"]')
    expect(bridge.subscription.login).toHaveBeenCalledWith('claude-code')
    await click(container, '.ai-sub-prompt [data-action="guide-back"]')
    // the Codex program is a way within the one ChatGPT answer
    await click(container, '.ai-sub-prompt [data-path="chatgpt"]')
    await click(container, '.ai-sub-prompt [data-action="guide-alternate"]')
    await click(container, '.ai-sub-prompt [data-action="install"]')
    expect(bridge.subscription.install).toHaveBeenCalledWith('codex')
  })

  it('does not send the refused request once a subscription connects', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('signed-out', 'not-installed'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'summarize this')

    act(() => bridge.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    // minutes may have passed at the sign-in page: the run must be asked for again
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(composerText(container)).toBe('summarize this')
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('reads a bridge without subscription handlers as still checking', async () => {
    const bridge = installBridge({})
    bridge.subscription.statuses.mockRejectedValue(new Error('No handler registered'))
    const container = await mountPanel()

    // nobody is waiting on the check yet: no prompt flashes up
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
    await sendMessage(container, 'hello')
    // held: nothing is sent, and the cards show the check the request waits for
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(composerText(container)).toBe('hello')
    expect(container.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(container.querySelector('.ai-msg-error')).toBeNull()
  })

  it('holds a send made during the status check and starts it once a provider can run', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('checking', 'checking'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'summarize this')
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(composerText(container)).toBe('summarize this')

    act(() => bridge.setStatuses(statusMap('signed-out', 'ready')))
    await settle()
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
    expect(composerText(container)).toBe('')
    expect(container.querySelector('.ai-msg-user')?.textContent).toContain('summarize this')
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('a send held during the status check falls to the connect prompt when the answer is "not connected"', async () => {
    const scrolled = watchScrollIntoView()
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('checking', 'checking'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'summarize this')

    act(() => bridge.setStatuses(statusMap('signed-out', 'not-installed')))
    await settle()
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    const prompt = container.querySelector('.ai-sub-prompt')
    expect(prompt?.getAttribute('data-reason')).toBe('no-subscription')
    expect(scrolled).toContain(prompt)
    expect(composerText(container)).toBe('summarize this')

    // and nothing starts by itself after the sign-in
    act(() => bridge.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
  })

  it('holds the first subscription run until the first-connection notice is acknowledged, then starts it', async () => {
    const bridge = installBridge({ statuses: statusMap('ready', 'not-installed') })
    const container = await mountPanel()

    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
    expect(container.querySelector('.ai-sub-first')).not.toBeNull()
    await sendMessage(container, 'first request')
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(composerText(container)).toBe('first request')

    await click(container, '.ai-sub-first .ai-sub-btn')
    expect(bridge.api.setAiSettings).toHaveBeenCalledTimes(1)
    expect(bridge.api.setAiSettings.mock.calls[0]![0].subscriptionNoticeSeen).toBe(true)
    expect(container.querySelector('.ai-sub-first')).toBeNull()

    // the held request went out by itself: no second press of send
    expect(bridge.api.aiStream).toHaveBeenCalledTimes(1)
    expect(composerText(container)).toBe('')
    expect(container.querySelector('.ai-msg-user')?.textContent).toContain('first request')
  })

  it('sends nothing and keeps the text when the notice goes away without an acknowledgement', async () => {
    const base = normalizeAiSettings(undefined)
    const bridge = installBridge({ statuses: statusMap('ready', 'not-installed') })
    const container = await mountPanel()
    await sendMessage(container, 'first request')

    // the user picks a filled-in key provider instead of answering the notice
    await act(async () =>
      bridge.api.setAiSettings({
        ...base,
        provider: 'openai',
        providers: { ...base.providers, openai: { apiKey: 'sk-test', model: 'gpt-5' } },
      }),
    )
    await settle()
    expect(container.querySelector('.ai-sub-first')).toBeNull()
    expect(bridge.api.aiStream).not.toHaveBeenCalled()
    expect(composerText(container)).toBe('first request')
  })

  it('writes the acknowledgement onto the settings stored now, not onto the panel copy', async () => {
    const base = normalizeAiSettings(undefined)
    const bridge = installBridge({ statuses: statusMap('ready', 'not-installed') })
    const container = await mountPanel()
    // the settings page stored a key after this panel read its copy
    bridge.storeSilently({
      ...base,
      providers: { ...base.providers, openai: { apiKey: 'stored-later', model: 'gpt-later' } },
    })

    await click(container, '.ai-sub-first .ai-sub-btn')
    expect(bridge.api.setAiSettings).toHaveBeenCalledTimes(1)
    const saved = bridge.api.setAiSettings.mock.calls[0]![0]
    expect(saved.subscriptionNoticeSeen).toBe(true)
    expect(saved.providers.openai).toEqual({ apiKey: 'stored-later', model: 'gpt-later' })
  })

  it('renders a blocked run with a continue button that switches the provider and reruns', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'rewrite the intro')
    expect(bridge.requests).toHaveLength(1)

    act(() =>
      bridge.emit({
        requestId: bridge.requests[0]!.requestId,
        type: 'error',
        error: 'rate limited',
        errorCode: 'rate-limit',
        errorProvider: 'claude-code',
        errorResetsAt: Date.now() + 3_600_000,
      }),
    )
    await settle()

    const notice = container.querySelector('.ai-sub-blocked')
    expect(notice?.getAttribute('data-kind')).toBe('rate-limit')
    // the shared wording, not the raw message of the chunk
    expect(notice?.textContent).not.toContain('rate limited')
    expect(container.querySelector('.ai-msg-error')).toBeNull()

    await click(container, '.ai-sub-blocked [data-action="continue-with"][data-provider="codex"]')
    expect(bridge.api.setAiSettings).toHaveBeenCalledTimes(1)
    expect(bridge.api.setAiSettings.mock.calls[0]![0].provider).toBe('codex')
    expect(bridge.requests).toHaveLength(2)
    expect(bridge.requests[1]!.settings.provider).toBe('codex')
    // the offer belongs to the run that just stopped: the older reply keeps its reason only
    expect(container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(container.querySelector('[data-action="continue-with"]')).toBeNull()
  })

  it('offers to continue on the most recent blocked reply only, and pauses the queue', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    const container = await mountPanel()
    const blockRun = async () => {
      act(() =>
        bridge.emit({
          requestId: bridge.requests.at(-1)!.requestId,
          type: 'error',
          errorCode: 'rate-limit',
          errorProvider: 'claude-code',
        }),
      )
      await settle()
    }
    await sendMessage(container, 'rewrite the intro')
    // typed while the reply runs: it waits in the queue
    await typeAndEnter(container, 'then translate it')
    expect(bridge.requests).toHaveLength(1)
    expect(container.querySelector('.ai-queue-strip')).not.toBeNull()

    await blockRun()
    // the queued message did not run into the same wall
    expect(bridge.requests).toHaveLength(1)
    expect(container.querySelector('.ai-queue-strip')?.getAttribute('data-paused')).toBe('true')
    expect(container.querySelectorAll('[data-action="continue-with"]')).toHaveLength(1)

    // the user resumes the queue; that run stops the same way
    await click(container, '.ai-queue-pause')
    expect(bridge.requests).toHaveLength(2)
    await blockRun()
    const blocked = [...container.querySelectorAll('.ai-sub-blocked')]
    expect(blocked).toHaveLength(2)
    expect(blocked[0]!.querySelector('[data-action="continue-with"]')).toBeNull()
    expect(blocked[1]!.querySelector('[data-action="continue-with"]')).not.toBeNull()
  })

  it('keeps a transient failure as a plain error line', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'hello')

    act(() =>
      bridge.emit({
        requestId: bridge.requests[0]!.requestId,
        type: 'error',
        errorCode: 'network',
      }),
    )
    await settle()

    expect(container.querySelector('.ai-sub-blocked')).toBeNull()
    expect(container.querySelector('.ai-msg-error')).not.toBeNull()
  })

  it('shows subscription usage near the limit and tells when the input was cut', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'hello')
    const requestId = bridge.requests[0]!.requestId

    expect(container.querySelector('.ai-subscription-usage-item')).toBeNull()
    expect(container.querySelector('.ai-sub-truncated')).toBeNull()
    act(() => {
      bridge.emit({
        requestId,
        type: 'subscription-usage',
        subscriptionUsage: [
          {
            provider: 'claude-code',
            window: 'five_hour',
            utilization: 0.91,
            resetsAt: Date.now() + 60_000,
          },
          {
            provider: 'claude-code',
            window: 'seven_day',
            utilization: 0.2,
            resetsAt: Date.now() + 60_000,
          },
        ],
      })
      bridge.emit({ requestId, type: 'input-truncated' })
    })
    await settle()

    const usage = container.querySelectorAll('.ai-subscription-usage-item')
    expect(usage).toHaveLength(1)
    expect(usage[0]!.getAttribute('data-window')).toBe('five_hour')
    expect(container.querySelector('.ai-sub-truncated')).not.toBeNull()
  })

  it('offers generate_image only when the main process reports an image route', async () => {
    const withRoute = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
      imageGeneration: true,
    })
    let container = await mountPanel()
    await sendMessage(container, 'draw a cat')
    expect(withRoute.requests[0]!.tools.map((tool) => tool.name)).toContain('generate_image')

    // no capability handler registered: unavailable, the tool is not offered
    const withoutHandler = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    container = await mountPanel()
    await sendMessage(container, 'draw a cat')
    const request = withoutHandler.requests[0]!
    expect(request.tools.map((tool) => tool.name)).not.toContain('generate_image')
    expect(request.system).toContain('generate_image is currently unavailable')
  })

  it('names the product, not the upstream project, in the system prompt', async () => {
    const bridge = installBridge({
      settings: { subscriptionNoticeSeen: true },
      statuses: statusMap('ready', 'ready'),
    })
    const container = await mountPanel()
    await sendMessage(container, 'hello')
    expect(bridge.requests[0]!.system).toContain('IeumOffice Markdown')
    expect(bridge.requests[0]!.system).not.toContain('GenOffice')
  })
})
