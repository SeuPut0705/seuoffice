// The AI panel under the subscription contract: a send while nothing is
// connected is answered by the connect cards instead of a run, a send made
// during the status check waits for its answer, a blocked run offers "continue
// with ...", the first run on a subscription waits for the notice, and usage /
// a cut input reported by the main process are shown.
// Every request goes to a mocked preload bridge: no provider is started.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import type { AiSubscriptionState, SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import { AI_SUBSCRIPTION_STRINGS } from '@genoffice/ui'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import {
  AI_PROVIDERS,
  type AiProviderId,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
} from '../src/shared/ipc'

type ChunkListener = (chunk: AiStreamChunk) => void

function settingsWith(
  provider: AiSettings['provider'],
  patch: Partial<AiSettings> = {},
): AiSettings {
  return {
    provider,
    providers: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        p.id === provider
          ? { apiKey: 'k', model: p.defaultModel || 'm' }
          : { apiKey: '', model: p.defaultModel },
      ]),
    ) as AiSettings['providers'],
    ...patch,
  }
}

function statuses(claude: AiSubscriptionState, codex: AiSubscriptionState): SubscriptionStatusMap {
  return {
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    chatgpt: { provider: 'chatgpt', state: 'signed-out', meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flush()
  })
}

interface Harness {
  container: HTMLElement
  requests: AiStreamRequest[]
  setAiSettings: ReturnType<typeof vi.fn>
  recheck: ReturnType<typeof vi.fn>
  send(text: string): Promise<void>
  /** type a message and press Enter: while a reply runs, that queues it */
  typeAndEnter(text: string): Promise<void>
  composerText(): string
  /** the main process reports a status change */
  setStatuses(next: SubscriptionStatusMap): Promise<void>
  /** the app hands the panel newly read settings */
  setSettings(next: AiSettings): Promise<void>
  cleanup(): void
}

/** records what the panel scrolls into view (jsdom implements no scrolling of its own) */
function watchScrollIntoView(): Element[] {
  const scrolled: Element[] = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  return scrolled
}

/**
 * Mount the panel over a mocked bridge. `answer` plays the main process for
 * each request: it gets the request and a function to emit chunks with.
 */
async function mountPanel(options: {
  settings: AiSettings
  subscription?: SubscriptionStatusMap
  /** what the settings file holds, when it differs from the panel's copy */
  fileSettings?: AiSettings
  answer: (
    request: AiStreamRequest,
    emit: (chunk: Omit<AiStreamChunk, 'requestId'>) => void,
  ) => void
}): Promise<Harness> {
  const editor = createEditor()
  let listener: ChunkListener | null = null
  const requests: AiStreamRequest[] = []
  const setAiSettings = vi.fn(async () => {})
  let currentStatuses = options.subscription
  let statusListener: ((next: SubscriptionStatusMap) => void) | null = null
  const recheck = vi.fn(async () => currentStatuses)
  const win = window as unknown as Record<string, unknown>
  win.desktop = {
    onAiStream: (l: ChunkListener) => {
      listener = l
      return () => {
        listener = null
      }
    },
    aiStream: vi.fn(async (request: AiStreamRequest) => {
      requests.push(request)
      options.answer(request, (chunk) =>
        listener?.({ ...chunk, requestId: request.requestId } as AiStreamChunk),
      )
    }),
    aiStreamCancel: vi.fn(async () => {}),
    setAiSettings,
    ...(options.fileSettings ? { getAiSettings: async () => options.fileSettings } : {}),
    openAiModelSettings: vi.fn(async () => {}),
  }
  if (options.subscription) {
    win.aiOfficeSubscription = {
      statuses: async () => currentStatuses,
      recheck,
      login: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ ok: true })),
      setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses: currentStatuses })),
      onChanged: (handler: (next: SubscriptionStatusMap) => void) => {
        statusListener = handler
        return () => {
          statusListener = null
        }
      },
    }
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const render = (settings: AiSettings) =>
    act(() =>
      root.render(
        createElement(AiPanel, {
          editor,
          blocks: [],
          settings,
          open: true,
          onExpand: () => {},
          onCollapse: () => {},
        }),
      ),
    )
  render(options.settings)
  // the subscription statuses arrive asynchronously
  await settle()
  const textarea = () => container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!
  const type = (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return {
    container,
    requests,
    setAiSettings,
    recheck,
    send: async (text) => {
      type(text)
      act(() => container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
      await settle()
    },
    typeAndEnter: async (text) => {
      type(text)
      act(() => {
        textarea().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
      })
      await settle()
    },
    composerText: () => textarea().value,
    setStatuses: async (next) => {
      currentStatuses = next
      act(() => statusListener?.(next))
      await settle()
    },
    setSettings: async (next) => {
      render(next)
      await settle()
    },
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
      editor.destroy()
    },
  }
}

beforeAll(() => {
  // jsdom's opaque origin has no localStorage; the panel reads it at mount
  let store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        store = {}
      },
    },
  })
  Element.prototype.scrollTo ??= () => {}
})

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
  const win = window as unknown as Record<string, unknown>
  delete win.desktop
  delete win.aiOfficeSubscription
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('AI panel: failed runs', () => {
  it('keeps the plain error line for a key provider failure', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini' satisfies AiProviderId),
      answer: (_request, emit) => emit({ type: 'error', error: 'HTTP 429: rate limit' }),
    })
    await harness.send('summarize this')
    const { container } = harness
    expect(container.querySelector('.ai-msg-error')?.textContent).toContain('HTTP 429')
    expect(container.querySelector('.ai-sub-blocked')).toBeNull()
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('shows the connect cards instead of sending when nothing is connected', async () => {
    const scrolled = watchScrollIntoView()
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('not-installed', 'signed-out'),
      answer: (_request, emit) =>
        emit({ type: 'error', error: 'No AI is connected.', errorCode: 'not-connected' }),
    })
    const { container } = harness
    // the way to connect is on screen before anything is asked, without drawing attention
    expect(container.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(scrolled).toEqual([])

    await harness.send('summarize this')
    // nothing was sent, no reply and no error line: the composer keeps the request
    expect(harness.requests).toHaveLength(0)
    expect(container.querySelector('.ai-msg')).toBeNull()
    expect(container.querySelector('.ai-msg-error')).toBeNull()
    expect(harness.composerText()).toBe('summarize this')
    // which AI the user has comes first; each answer leads to its own card
    expect(container.querySelector('.ai-sub-guide-question')).not.toBeNull()
    expect(container.querySelectorAll('.ai-sub-guide-path')).toHaveLength(3)
    // the refused send points at the prompt
    expect(scrolled).toContain(container.querySelector('.ai-sub-prompt'))
  })

  it('does not send the refused request once a subscription connects', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('not-installed', 'signed-out'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    await harness.setStatuses(statuses('not-installed', 'ready'))
    // minutes may have passed at the sign-in page: the run must be asked for again
    expect(harness.requests).toHaveLength(0)
    expect(harness.composerText()).toBe('summarize this')
    expect(harness.container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('shows only the card of a selected subscription that cannot run', async () => {
    harness = await mountPanel({
      settings: settingsWith('codex', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'signed-out'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    // a selection is never replaced by the other subscription, even a ready one
    expect(harness.requests).toHaveLength(0)
    const cards = harness.container.querySelectorAll('.ai-sub-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.getAttribute('data-provider')).toBe('codex')
  })

  it('tells the reason and looks again when the main process refuses a run after all', async () => {
    // the panel saw Codex ready; the login had expired by the time the request arrived
    harness = await mountPanel({
      settings: settingsWith('codex', { subscriptionNoticeSeen: true }),
      subscription: statuses('not-installed', 'ready'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'Codex is not signed in.',
          errorCode: 'signed-out',
          errorProvider: 'codex',
        }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-msg-error')).toBeNull()
    // the reason is told, but there is nothing to continue on
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.container.querySelector('[data-action="continue-with"]')).toBeNull()
    // the refusal may rest on an out-of-date status: the panel looks again
    expect(harness.recheck).toHaveBeenCalledWith(['codex'])
  })

  it('offers to continue on the other subscription and reruns the request there', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (request, emit) => {
        if (request.settings.provider === 'claude-code') {
          emit({
            type: 'error',
            error: 'limit reached',
            errorCode: 'rate-limit',
            errorProvider: 'claude-code',
            errorResetsAt: Date.now() + 3_600_000,
          })
        } else {
          emit({ type: 'delta', text: 'done on the other one' })
          emit({ type: 'done' })
        }
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    expect(container.querySelector('.ai-msg-error')).toBeNull()
    // connected: the reason and the button, no connect cards
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
    const button = container.querySelector<HTMLButtonElement>(
      '.ai-sub-blocked [data-action="continue-with"]',
    )
    expect(button?.getAttribute('data-provider')).toBe('codex')

    act(() => button!.click())
    await settle()
    // the selection is stored (the model picker follows the settings file)...
    expect(harness.setAiSettings).toHaveBeenCalledTimes(1)
    expect(harness.setAiSettings.mock.calls[0]?.[0]).toMatchObject({ provider: 'codex' })
    // ...and the same request ran again on it
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]?.settings.provider).toBe('codex')
    expect(container.textContent).toContain('done on the other one')
    // the offer belonged to the run that had just stopped: the older reply keeps its reason only
    expect(container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(container.querySelector('[data-action="continue-with"]')).toBeNull()
  })

  it('offers to continue on the most recent blocked reply only', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'limit reached',
          errorCode: 'rate-limit',
          errorProvider: 'claude-code',
        }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelectorAll('[data-action="continue-with"]')).toHaveLength(1)
    await harness.send('try once more')
    expect(harness.requests).toHaveLength(2)
    const blocked = [...harness.container.querySelectorAll('.ai-sub-blocked')]
    expect(blocked).toHaveLength(2)
    expect(blocked[0]!.querySelector('[data-action="continue-with"]')).toBeNull()
    expect(blocked[1]!.querySelector('[data-action="continue-with"]')).not.toBeNull()
  })

  it('pauses the message queue, so the next message does not run into the same wall', async () => {
    let fail: (() => void) | null = null
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      // the turn stays in flight until the test fails it
      answer: (_request, emit) => {
        fail = () =>
          emit({
            type: 'error',
            error: 'limit reached',
            errorCode: 'rate-limit',
            errorProvider: 'claude-code',
          })
      },
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    // typed while the reply runs: it waits in the queue
    await harness.typeAndEnter('then translate it')
    expect(harness.container.querySelector('.ai-queue-strip')).not.toBeNull()

    act(() => fail!())
    await settle()
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-queue-strip')?.getAttribute('data-paused')).toBe(
      'true',
    )
  })

  it('never offers a key provider to continue on', async () => {
    const base = settingsWith('claude-code', { subscriptionNoticeSeen: true })
    harness = await mountPanel({
      settings: {
        ...base,
        providers: { ...base.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
      },
      subscription: statuses('ready', 'signed-out'),
      answer: (_request, emit) =>
        emit({
          type: 'error',
          error: 'limit reached',
          errorCode: 'rate-limit',
          errorProvider: 'claude-code',
        }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-sub-blocked')).not.toBeNull()
    expect(harness.container.querySelector('[data-action="continue-with"]')).toBeNull()
  })
})

describe('AI panel: a send while the connection is still being checked', () => {
  it('holds the request and starts it by itself once a provider can run', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('checking', 'checking'),
      answer: (_request, emit) => {
        emit({ type: 'delta', text: 'hello' })
        emit({ type: 'done' })
      },
    })
    const { container } = harness
    // nobody is waiting on the check yet: no prompt flashes up
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()

    await harness.send('summarize this')
    // held: not sent, not dropped; the cards show the check the request waits for
    expect(harness.requests).toHaveLength(0)
    expect(harness.composerText()).toBe('summarize this')
    expect(container.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(container.querySelector('.ai-msg-error')).toBeNull()

    await harness.setStatuses(statuses('signed-out', 'ready'))
    expect(harness.requests).toHaveLength(1)
    expect(harness.composerText()).toBe('')
    expect(container.textContent).toContain('hello')
    expect(container.querySelector('.ai-sub-prompt')).toBeNull()
  })

  it('falls to the connect prompt when the answer is "not connected", and sends nothing later', async () => {
    const scrolled = watchScrollIntoView()
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('checking', 'checking'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')

    await harness.setStatuses(statuses('signed-out', 'not-installed'))
    expect(harness.requests).toHaveLength(0)
    const prompt = harness.container.querySelector('.ai-sub-prompt')
    expect(prompt).not.toBeNull()
    expect(scrolled).toContain(prompt)
    expect(harness.composerText()).toBe('summarize this')

    await harness.setStatuses(statuses('ready', 'not-installed'))
    expect(harness.requests).toHaveLength(0)
  })
})

describe('AI panel: first connection notice', () => {
  it('holds the first run on a subscription until the notice is acknowledged', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => {
        emit({ type: 'delta', text: 'hello' })
        emit({ type: 'done' })
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    // nothing left the PC yet
    expect(harness.requests).toHaveLength(0)
    const notice = container.querySelector('.ai-sub-first')
    expect(notice).not.toBeNull()
    // Codex keeps a diagnostic log the app cannot read or prevent: the notice says so here too
    expect(notice?.querySelectorAll('li')).toHaveLength(3)

    act(() => notice!.querySelector<HTMLButtonElement>('button')!.click())
    await settle()
    expect(harness.setAiSettings.mock.calls[0]?.[0]).toMatchObject({ subscriptionNoticeSeen: true })
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.settings.subscriptionNoticeSeen).toBe(true)
    expect(container.querySelector('.ai-sub-first')).toBeNull()
    expect(container.textContent).toContain('hello')
  })

  it('sends nothing and keeps the text when the notice goes away without an acknowledgement', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto'),
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-sub-first')).not.toBeNull()

    // the user picks a filled-in key provider instead of answering the notice
    await harness.setSettings(settingsWith('gemini'))
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
    expect(harness.requests).toHaveLength(0)
    expect(harness.setAiSettings).not.toHaveBeenCalled()
    expect(harness.composerText()).toBe('summarize this')
  })

  it('writes the acknowledgement over the latest settings file, as complete settings', async () => {
    const panelCopy = settingsWith('auto')
    // another window saved a key after this panel read its copy
    const fileSettings: AiSettings = {
      ...panelCopy,
      providers: { ...panelCopy.providers, openai: { apiKey: 'sk-newer', model: 'some-model' } },
    }
    harness = await mountPanel({
      settings: panelCopy,
      fileSettings,
      subscription: statuses('ready', 'not-installed'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    const ack = harness.container.querySelector<HTMLButtonElement>('.ai-sub-first button')!
    act(() => ack.click())
    await settle()
    expect(harness.setAiSettings).toHaveBeenCalledTimes(1)
    const written = harness.setAiSettings.mock.calls[0]?.[0] as AiSettings
    expect(written.subscriptionNoticeSeen).toBe(true)
    expect(written.providers.openai.apiKey).toBe('sk-newer')
    // a whole settings object, never a one-field patch
    expect(written.provider).toBe('auto')
    expect(Object.keys(written.providers).length).toBe(AI_PROVIDERS.length)
  })

  it('does not ask again once acknowledged, nor for a key provider', async () => {
    harness = await mountPanel({
      settings: settingsWith('auto', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
    harness.cleanup()

    harness = await mountPanel({
      settings: settingsWith('gemini'),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.container.querySelector('.ai-sub-first')).toBeNull()
  })
})

describe('AI panel: entry label', () => {
  it('uses the shared "AI Assistant" label for the panel title and its resizer', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    const title = harness.container.querySelector('.ai-panel-title')!.textContent
    expect(Object.values(AI_SUBSCRIPTION_STRINGS).map((d) => d.aiAssistant)).toContain(title)
    expect(harness.container.querySelector('.ai-panel-resizer')!.getAttribute('aria-label')).toBe(
      title,
    )
  })
})

describe('AI panel: usage and cut input', () => {
  it('shows a usage window at or above the threshold and the cut-input notice', async () => {
    harness = await mountPanel({
      settings: settingsWith('claude-code', { subscriptionNoticeSeen: true }),
      subscription: statuses('ready', 'ready'),
      answer: (_request, emit) => {
        emit({
          type: 'subscription-usage',
          subscriptionUsage: [
            {
              provider: 'claude-code',
              window: 'five_hour',
              utilization: 0.91,
              resetsAt: Date.now() + 3_600_000,
            },
            {
              provider: 'claude-code',
              window: 'seven_day',
              utilization: 0.3,
              resetsAt: Date.now() + 86_400_000,
            },
          ],
        })
        emit({ type: 'input-truncated' })
        emit({ type: 'delta', text: 'ok' })
        emit({ type: 'done' })
      },
    })
    await harness.send('summarize this')
    const { container } = harness
    const usage = container.querySelectorAll('.ai-subscription-usage-item')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.getAttribute('data-window')).toBe('five_hour')
    expect(usage[0]?.textContent).toContain('91')
    expect(container.querySelector('.ai-sub-truncated')).not.toBeNull()
  })

  it('shows nothing while no subscription reports usage', async () => {
    harness = await mountPanel({
      settings: settingsWith('gemini'),
      answer: (_request, emit) => emit({ type: 'done' }),
    })
    await harness.send('summarize this')
    expect(harness.container.querySelector('.ai-subscription-usage')).toBeNull()
    expect(harness.container.querySelector('.ai-sub-truncated')).toBeNull()
  })
})
