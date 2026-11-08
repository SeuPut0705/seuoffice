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
  SubscriptionStatusMap,
} from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../src/shared/home-api'
import { KbAskPanel } from '../src/renderer/src/KbAskPanel'
import { LocaleProvider } from '../src/renderer/src/locale'
import { strings } from '../src/renderer/src/strings'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'

/**
 * The ask panel's "All / <group>" choice (spec 8.8). The panel only names the
 * group; the main process mints the run's scope and narrows every call (see
 * kb-ask-scope.test.ts). Here: the choice starts at All and is not remembered,
 * a scoped run carries its scope on every knowledge call and lists the group's
 * files only, and a group that is gone runs nothing rather than everything.
 * The provider is a stub: nothing here reaches Claude or Codex.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const LEASE = {
  path: '/kb/a/lease.docx',
  folder: 'a',
  name: 'lease.docx',
  ext: 'docx',
  sizeBytes: 10,
}
const RULES = { path: '/kb/a/rules.md', folder: 'a', name: 'rules.md', ext: 'md', sizeBytes: 10 }
const SECRET = {
  path: '/kb/b/salary.xlsx',
  folder: 'b',
  name: 'salary.xlsx',
  ext: 'xlsx',
  sizeBytes: 10,
}
const ALL = [LEASE, RULES, SECRET]
const GROUP_A = [LEASE, RULES]

let host: HTMLDivElement
let root: Root
let stored: AiSettings
let streamListeners: Array<(chunk: AiStreamChunk) => void>
let aiStream: ReturnType<typeof vi.fn<(request: AiStreamRequest) => Promise<void>>>
let kbList: ReturnType<typeof vi.fn<(scope?: string) => Promise<typeof ALL>>>
let kbSearch: ReturnType<
  typeof vi.fn<(query: { q: string; limit?: number }, scope?: string) => Promise<unknown[]>>
>
let kbRead: ReturnType<
  typeof vi.fn<(path: string, offset: number, scope?: string) => Promise<unknown>>
>
let kbOpenScope: ReturnType<typeof vi.fn<(group: string) => Promise<string>>>
let kbCloseScope: ReturnType<typeof vi.fn<(scope: string) => Promise<void>>>
let setAiSettings: ReturnType<typeof vi.fn<(settings: AiSettings) => Promise<void>>>
let groups: string[]

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = defaultAiSettings()
  streamListeners = []
  groups = ['Unit A', 'Unit B']
  aiStream = vi.fn(async () => undefined)
  setAiSettings = vi.fn(async () => undefined)
  let minted = 0
  kbOpenScope = vi.fn(async (group: string) => {
    if (!groups.includes(group)) throw new Error('knowledge-base group has no starred files')
    return `scope-${++minted}`
  })
  kbCloseScope = vi.fn(async () => undefined)
  kbList = vi.fn(async (scope?: string) => (scope ? GROUP_A : ALL))
  kbSearch = vi.fn(async () => [])
  kbRead = vi.fn(async () => ({ text: 'pets are allowed', totalChars: 17, offset: 0 }))
  window.aiOffice = {
    kbList,
    kbSearch,
    kbRead,
    kbOpenScope,
    kbCloseScope,
    starredGroups: async () => groups,
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
  localStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const READY: SubscriptionStatusMap = {
  'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
  codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
}

const connection: SubscriptionConnection = {
  statuses: READY,
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function renderPanel(lang: Lang = 'en'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: lang },
        createElement(KbAskPanel, {
          connection,
          aiSettings: stored,
          noticeDue: false,
          onOpenAiSettings: vi.fn(),
          onOpenPath: vi.fn(),
          onGoToRecents: vi.fn(),
        }),
      ),
    )
    await settle()
  })
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount())
  root = createRoot(host)
}

const scopeButtons = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.kb-ask-scope button'))
const chosen = (): string | undefined =>
  scopeButtons().find((b) => b.getAttribute('aria-checked') === 'true')?.textContent ?? undefined

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
    await settle()
  })
}

async function choose(label: string): Promise<void> {
  await click(scopeButtons().find((b) => b.textContent === label))
}

async function ask(text: string): Promise<void> {
  const box = host.querySelector<HTMLTextAreaElement>('textarea')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(host.querySelector('.ai-send-btn:not(.ai-stop-btn)'))
}

/** answer the request the panel started last, the way the main process does */
async function answer(chunks: Array<Omit<AiStreamChunk, 'requestId'>>): Promise<void> {
  const request = aiStream.mock.calls.at(-1)![0]
  await act(async () => {
    for (const chunk of chunks) {
      for (const listener of [...streamListeners]) {
        listener({ requestId: request.requestId, ...chunk })
      }
    }
    await settle()
  })
}

const lastUserText = (): string => JSON.stringify(aiStream.mock.calls.at(-1)![0].messages.at(-1))

describe('the ask panel’s group choice', () => {
  it('offers All and every group that has files, with All chosen', async () => {
    await renderPanel('ko')
    expect(scopeButtons().map((b) => b.textContent)).toEqual([
      strings.ko.askScopeAll,
      'Unit A',
      'Unit B',
    ])
    expect(chosen()).toBe(strings.ko.askScopeAll)
    expect(strings.ko.askScopeAll).toBe('전체')
  })

  it('shows no choice when no starred file is in a group', async () => {
    groups = []
    await renderPanel()
    expect(host.querySelector('.kb-ask-scope')).toBeNull()
  })

  it('starts at All again when the panel opens next time, and stores nothing', async () => {
    await renderPanel()
    await choose('Unit B')
    expect(chosen()).toBe('Unit B')
    await unmount()
    await renderPanel()
    expect(chosen()).toBe(strings.en.askScopeAll)
    expect(setAiSettings).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
})

describe('an ask over All', () => {
  it('opens no scope and lists every starred file', async () => {
    await renderPanel()
    await ask('What about pets?')
    expect(kbOpenScope).not.toHaveBeenCalled()
    expect(kbList).toHaveBeenLastCalledWith()
    expect(aiStream).toHaveBeenCalledTimes(1)
    expect(lastUserText()).toContain(SECRET.path)
  })
})

describe('an ask narrowed to a group', () => {
  it('runs on a scope main opened for that group, and lists its files only', async () => {
    await renderPanel()
    await choose('Unit A')
    await ask('What about pets?')
    expect(kbOpenScope).toHaveBeenCalledWith('Unit A')
    expect(kbList).toHaveBeenLastCalledWith('scope-1')
    expect(aiStream).toHaveBeenCalledTimes(1)
    const text = lastUserText()
    expect(text).toContain(LEASE.path)
    expect(text).toContain(RULES.path)
    expect(text).not.toContain(SECRET.path)
  })

  it('carries the scope on every search and read the AI asks for, then closes it', async () => {
    await renderPanel()
    await choose('Unit A')
    await ask('What about pets?')
    await answer([
      {
        type: 'tool-call',
        toolCall: { id: 't1', name: 'search_knowledge_base', input: { query: 'pets' } },
      },
      {
        type: 'tool-call',
        toolCall: { id: 't2', name: 'read_knowledge_file', input: { index: 1 } },
      },
      { type: 'done' },
    ])
    expect(kbSearch).toHaveBeenCalledWith({ q: 'pets', limit: 8 }, 'scope-1')
    expect(kbRead).toHaveBeenCalledWith(RULES.path, 0, 'scope-1')
    // the next turn goes out, then the run ends and its scope is given back
    expect(aiStream).toHaveBeenCalledTimes(2)
    await answer([{ type: 'delta', text: 'Pets are allowed.' }, { type: 'done' }])
    expect(kbCloseScope).toHaveBeenCalledWith('scope-1')
  })

  it('keeps the choice for the next question in the same conversation', async () => {
    await renderPanel()
    await choose('Unit A')
    await ask('What about pets?')
    await answer([{ type: 'delta', text: 'Allowed.' }, { type: 'done' }])
    await ask('And cats?')
    expect(kbOpenScope).toHaveBeenCalledTimes(2)
    expect(kbOpenScope).toHaveBeenLastCalledWith('Unit A')
    expect(lastUserText()).not.toContain(SECRET.path)
  })

  it('runs nothing, rather than everything, when the group is gone', async () => {
    await renderPanel()
    await choose('Unit B')
    groups = ['Unit A']
    const listedBefore = kbList.mock.calls.length
    await ask('What about pay?')
    expect(aiStream).not.toHaveBeenCalled()
    expect(kbList.mock.calls.length).toBe(listedBefore)
    expect(host.querySelector('.kb-ask-error')!.textContent).toBe(strings.en.askScopeGone)
  })

  it('never falls back to the full list when the group’s list cannot be read', async () => {
    await renderPanel()
    await choose('Unit A')
    kbList.mockImplementation(async (scope?: string) => {
      if (scope) throw new Error('knowledge-base scope is not open')
      return ALL
    })
    await ask('What about pets?')
    expect(aiStream).not.toHaveBeenCalled()
    expect(kbCloseScope).toHaveBeenCalledWith('scope-1')
  })

  it('cannot change the group while a run is going', async () => {
    await renderPanel()
    await choose('Unit A')
    await ask('What about pets?')
    expect(scopeButtons().every((b) => b.disabled)).toBe(true)
  })
})
