/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type {
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  AiSubscriptionState,
  SubscriptionStatusMap,
} from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import { TOOLS_UNAVAILABLE_NOTE } from '@genoffice/agent-core'
import { resolveCustomEndpoints } from '@genoffice/ai-provider/browser'
import { AI_CONTEXT_STRINGS, aiRunErrorText, aiSubscriptionText } from '@genoffice/ui'
import type { HomeApi } from '../src/shared/home-api'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { strings } from '../src/renderer/src/strings'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'

/**
 * The home screen's ask panel under the subscription contract: nothing is sent
 * without a connection or in front of the first-connection notice, a refusal
 * reads in the UI language, and a blocked run offers the other connection.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** what the settings file holds; `setAiSettings` replaces it */
let stored: AiSettings
let aiStream: ReturnType<typeof vi.fn<(request: AiStreamRequest) => Promise<void>>>
let setAiSettings: ReturnType<typeof vi.fn<(settings: AiSettings) => Promise<void>>>
let streamListeners: Array<(chunk: AiStreamChunk) => void>

const QUESTION = 'What does the lease say about pets?'

beforeEach(() => {
  // jsdom has no element scrolling; the panel keeps its log scrolled to the end
  Element.prototype.scrollTo = () => undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = defaultAiSettings()
  streamListeners = []
  aiStream = vi.fn(async () => undefined)
  setAiSettings = vi.fn(async (next: AiSettings) => {
    stored = next
  })
  window.aiOffice = {
    kbList: async () => [
      { path: '/kb/lease.docx', folder: 'kb', name: 'lease.docx', ext: 'docx', sizeBytes: 10 },
    ],
    kbSearch: async () => [],
    kbRead: async () => ({ text: '', nextOffset: null }),
    aiGetSettings: async () => stored,
    getAiSettings: async () => stored,
    setAiSettings,
    aiStream,
    aiStreamCancel: async () => undefined,
    onAiStream: (handler: (chunk: AiStreamChunk) => void) => {
      streamListeners.push(handler)
      return () => {
        streamListeners = streamListeners.filter((listener) => listener !== handler)
      }
    },
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function statuses(claude: AiSubscriptionState, codex: AiSubscriptionState): SubscriptionStatusMap {
  return {
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }
}

function connectionOf(map: SubscriptionStatusMap): SubscriptionConnection {
  return {
    statuses: map,
    busy: false,
    failed: {},
    codexImageAvailable: false,
    install: vi.fn(),
    login: vi.fn(),
    switchAccount: vi.fn(),
    logout: vi.fn(),
    recheck: vi.fn(),
    refresh: vi.fn(),
    acceptMetered: vi.fn(async () => undefined),
    openInstallHelp: vi.fn(),
  }
}

/** a selected local model with a window and what it reported about tools */
function localSettings(tools?: boolean): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.customEndpoint = 'loc'
  settings.customEndpoints = [
    {
      id: 'loc',
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3:8b',
      kind: 'local',
      modelProfiles: {
        'qwen3:8b': {
          contextLength: 32_768,
          ...(tools === undefined ? {} : { tools }),
        },
      },
    },
  ]
  return resolveCustomEndpoints(settings)
}

interface RenderOptions {
  connection: SubscriptionConnection
  aiSettings?: AiSettings | null
  noticeDue?: boolean
  onOpenAiSettings?: () => void
  lang?: Lang
}

async function renderPanel(options: RenderOptions): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: options.lang ?? 'en' },
        createElement(KbAskPanel, {
          connection: options.connection,
          aiSettings: options.aiSettings === undefined ? stored : options.aiSettings,
          noticeDue: options.noticeDue ?? false,
          onOpenAiSettings: options.onOpenAiSettings ?? vi.fn(),
          onOpenPath: vi.fn(),
          onGoToRecents: vi.fn(),
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const composer = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('textarea')!

async function type(text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
    // a send reads the corpus and the settings before it reaches the transport
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const send = (): Promise<void> => click(host.querySelector('.ai-send-btn:not(.ai-stop-btn)'))

/** answer the request the panel started last, the way the main process does */
async function answer(chunk: Omit<AiStreamChunk, 'requestId'>): Promise<void> {
  const request = aiStream.mock.calls.at(-1)![0]
  await act(async () => {
    for (const listener of [...streamListeners]) {
      listener({ requestId: request.requestId, ...chunk })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ask panel without a connection', () => {
  it('sends nothing, keeps the question and shows the connect prompt', async () => {
    const connection = connectionOf(statuses('not-installed', 'signed-out'))
    await renderPanel({ connection })
    expect(host.querySelector('.ai-sub-prompt')).toBeNull()

    await type(QUESTION)
    await send()

    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
    expect(host.querySelectorAll('.kb-ask-msg')).toHaveLength(0)
    const prompt = host.querySelector<HTMLElement>('.ai-sub-prompt')!
    expect(prompt.textContent).toContain(aiSubscriptionText('en', 'connectTitle'))
    // which AI the user has comes first; a card follows the answer
    expect(prompt.querySelector('.ai-sub-guide-question')).not.toBeNull()
    expect(prompt.querySelectorAll('.ai-sub-card')).toHaveLength(0)
    // the prompt replaces the one-line hint instead of repeating it
    expect(host.querySelector('.kb-ask-login')).toBeNull()

    await click(prompt.querySelector('[data-path="claude-code"]'))
    await click(prompt.querySelector('[data-provider="claude-code"] [data-action="install"]'))
    expect(connection.install).toHaveBeenCalledWith('claude-code')
    await click(prompt.querySelector('[data-action="guide-back"]'))
    await click(prompt.querySelector('[data-path="chatgpt"]'))
    await click(prompt.querySelector('[data-action="guide-alternate"]'))
    await click(prompt.querySelector('[data-provider="codex"] [data-action="login"]'))
    expect(connection.login).toHaveBeenCalledWith('codex')
  })

  it('leads to Settings → AI when the selected key provider is not filled in', async () => {
    const onOpenAiSettings = vi.fn()
    stored = { ...defaultAiSettings(), provider: 'openai' }
    await renderPanel({
      connection: connectionOf(statuses('ready', 'ready')),
      onOpenAiSettings,
    })
    await type(QUESTION)
    await send()

    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
    await click(host.querySelector('.ai-sub-prompt [data-action="open-settings"]'))
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1)
  })

  it('takes the prompt away and sends once a provider can run', async () => {
    await renderPanel({ connection: connectionOf(statuses('not-installed', 'signed-out')) })
    await type(QUESTION)
    await send()
    expect(host.querySelector('.ai-sub-prompt')).not.toBeNull()

    await renderPanel({ connection: connectionOf(statuses('ready', 'signed-out')) })
    expect(host.querySelector('.ai-sub-prompt')).toBeNull()
    expect(composer().value).toBe(QUESTION)

    await send()
    expect(aiStream).toHaveBeenCalledTimes(1)
    expect(composer().value).toBe('')
  })

  it('says a launch could not start', async () => {
    await renderPanel({
      connection: {
        ...connectionOf(statuses('not-installed', 'signed-out')),
        failed: { codex: 'login' },
      },
    })
    await type(QUESTION)
    await send()
    const failed = host.querySelector<HTMLElement>('.kb-ask-error[role="alert"]')!
    expect(failed.dataset.provider).toBe('codex')
    expect(failed.textContent).toBe(strings.en.setSubLoginFailed)
  })
})

describe('ask panel while the connection is still being checked', () => {
  it('holds the question and starts it by itself once the check says it can run', async () => {
    await renderPanel({ connection: connectionOf(statuses('checking', 'checking')) })
    await type(QUESTION)
    await send()

    // nothing went out, nothing was refused: no connect prompt on a guess
    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
    expect(host.querySelector('.ai-sub-prompt')).toBeNull()

    await renderPanel({ connection: connectionOf(statuses('ready', 'signed-out')) })
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(aiStream).toHaveBeenCalledTimes(1)
    expect(aiStream.mock.calls[0]![0].messages.at(-1)).toMatchObject({ role: 'user' })
    expect(composer().value).toBe('')
  })

  it('drops the held question and shows the connect prompt when the check says it cannot', async () => {
    await renderPanel({ connection: connectionOf(statuses('checking', 'checking')) })
    await type(QUESTION)
    await send()

    await renderPanel({ connection: connectionOf(statuses('signed-out', 'not-installed')) })
    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
    expect(host.querySelector('.ai-sub-prompt')).not.toBeNull()

    // connecting later starts nothing by itself: the question is asked again
    await renderPanel({ connection: connectionOf(statuses('ready', 'not-installed')) })
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(aiStream).not.toHaveBeenCalled()
  })

  it('holds while the settings are not read yet, too', async () => {
    const connection = connectionOf(statuses('ready', 'ready'))
    await renderPanel({ connection, aiSettings: null })
    await type(QUESTION)
    await send()
    expect(aiStream).not.toHaveBeenCalled()

    await renderPanel({ connection, aiSettings: stored })
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(aiStream).toHaveBeenCalledTimes(1)
  })

  it('does not start a held question in front of the first-connection notice', async () => {
    const connection = connectionOf(statuses('ready', 'signed-out'))
    await renderPanel({ connection: connectionOf(statuses('checking', 'checking')) })
    await type(QUESTION)
    await send()
    await renderPanel({ connection, noticeDue: true })
    await renderPanel({ connection, noticeDue: false })
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
  })
})

describe('ask panel in front of the first-connection notice', () => {
  it('sends nothing and keeps the question until the notice is acknowledged', async () => {
    const connection = connectionOf(statuses('ready', 'signed-out'))
    await renderPanel({ connection, noticeDue: true })
    await type(QUESTION)
    await send()

    expect(aiStream).not.toHaveBeenCalled()
    expect(composer().value).toBe(QUESTION)
    // the notice itself is the home screen's dialog; the panel adds no prompt of its own
    expect(host.querySelector('.ai-sub-prompt')).toBeNull()

    await renderPanel({ connection, noticeDue: false })
    await send()
    expect(aiStream).toHaveBeenCalledTimes(1)
    expect(aiStream.mock.calls[0]![0].messages.at(-1)).toMatchObject({ role: 'user' })
  })
})

describe('ask panel when a run is blocked', () => {
  it('shows why it stopped and continues on the other subscription', async () => {
    const connection = connectionOf(statuses('ready', 'ready'))
    await renderPanel({ connection })
    await type(QUESTION)
    await send()
    expect(aiStream).toHaveBeenCalledTimes(1)

    const resetsAt = Date.now() + 60 * 60 * 1000
    await answer({
      type: 'error',
      error: 'Usage limit reached (English fallback of the main process)',
      errorCode: 'rate-limit',
      errorProvider: 'claude-code',
      errorResetsAt: resetsAt,
    })

    const notice = host.querySelector<HTMLElement>('.ai-sub-blocked')!
    expect(notice.dataset.kind).toBe('rate-limit')
    expect(notice.querySelector('.ai-sub-blocked-reason')!.textContent).toBe(
      aiRunErrorText('en', { kind: 'rate-limit', provider: 'claude-code', resetsAt }),
    )
    expect(host.textContent).not.toContain('English fallback of the main process')
    // the status may be stale: the blocked provider is looked at again
    expect(connection.recheck).toHaveBeenCalledWith('claude-code')
    // the composer takes questions again
    expect(host.querySelector('.ai-stop-btn')).toBeNull()

    const button = notice.querySelector<HTMLButtonElement>('[data-action="continue-with"]')!
    expect(button.dataset.provider).toBe('codex')
    expect(button.textContent).toBe(aiSubscriptionText('en', 'continueWith', { provider: 'Codex' }))

    await click(button)
    expect(setAiSettings).toHaveBeenCalledTimes(1)
    expect(setAiSettings.mock.calls[0]![0].provider).toBe('codex')
    expect(aiStream).toHaveBeenCalledTimes(2)
    const rerun = aiStream.mock.calls[1]![0]
    expect(rerun.settings.provider).toBe('codex')
    expect(JSON.stringify(rerun.messages.at(-1))).toContain(QUESTION)
  })

  it('offers no other connection when none can run', async () => {
    await renderPanel({ connection: connectionOf(statuses('ready', 'signed-out')) })
    await type(QUESTION)
    await send()
    await answer({ type: 'error', errorCode: 'signed-out', errorProvider: 'claude-code' })

    const notice = host.querySelector<HTMLElement>('.ai-sub-blocked')!
    expect(notice.querySelector('.ai-sub-blocked-reason')!.textContent).toBe(
      aiRunErrorText('en', { kind: 'signed-out', provider: 'claude-code' }),
    )
    expect(notice.querySelector('[data-action="continue-with"]')).toBeNull()
  })

  it('words a refusal of the main process in the UI language', async () => {
    // the statuses the panel holds say "ready"; the main process knows better
    await renderPanel({ connection: connectionOf(statuses('ready', 'signed-out')), lang: 'ko' })
    await type(QUESTION)
    await send()
    await answer({
      type: 'error',
      error: 'No AI provider is connected.',
      errorCode: 'not-connected',
    })

    const reason = host.querySelector('.ai-sub-blocked-reason')!.textContent
    expect(reason).toBe(aiRunErrorText('ko', { kind: 'not-connected' }))
    expect(reason).not.toBe(aiRunErrorText('en', { kind: 'not-connected' }))
    expect(host.textContent).not.toContain('No AI provider is connected.')
  })

  it('keeps the plain error line for a failure that is not about the connection', async () => {
    await renderPanel({ connection: connectionOf(statuses('ready', 'ready')) })
    await type(QUESTION)
    await send()
    await answer({ type: 'error', error: 'The provider said no.' })

    expect(host.querySelector('.ai-sub-blocked')).toBeNull()
    expect(host.querySelector('.kb-ask-error')!.textContent).toContain('The provider said no.')
    expect(host.querySelector('.ai-stop-btn')).toBeNull()
  })
})

describe('ask panel with a local model', () => {
  it('turns tools off and shows the notice when the model reported tools: false', async () => {
    stored = localSettings(false)
    await renderPanel({ connection: connectionOf(statuses('ready', 'ready')) })
    expect(host.querySelector('.ai-sub-notice')?.textContent).toBe(
      AI_CONTEXT_STRINGS.en.toolsUnsupported,
    )

    await type(QUESTION)
    await send()
    expect(aiStream).toHaveBeenCalledTimes(1)
    const request = aiStream.mock.calls[0]![0]
    expect(request.tools).toEqual([])
    expect(request.system).toContain(TOOLS_UNAVAILABLE_NOTE)
  })

  it('keeps tools and shows nothing when the model did not report tools', async () => {
    stored = localSettings(undefined)
    await renderPanel({ connection: connectionOf(statuses('ready', 'ready')) })
    expect(host.querySelector('.ai-sub-notice')).toBeNull()

    await type(QUESTION)
    await send()
    expect(aiStream).toHaveBeenCalledTimes(1)
    const request = aiStream.mock.calls[0]![0]
    expect(request.tools.length).toBeGreaterThan(0)
    expect(request.system).not.toContain(TOOLS_UNAVAILABLE_NOTE)
  })
})
