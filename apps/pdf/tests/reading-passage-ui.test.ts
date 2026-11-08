/**
 * Passage cards on screen (reading-assist spec 4.2, 3.1-3.5, 10.2): nothing is
 * sent on open or without the send gate, the same passage opens its card
 * without sending, "Regenerate" overwrites the card, the answer shows as plain
 * text, "Keep as note" waits for a PDF save before the store hears of it, and
 * the dotted marks are screen-only. The preload bridge and the store channel
 * are fakes; "sending" means a call to the fake `aiStream`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamChunk } from '@genoffice/agent-core'
import {
  normalizeAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type SubscriptionStatusMap,
} from '@genoffice/ai-provider/browser'
import { createI18n } from '@genoffice/i18n'
import { aiRunErrorText } from '@genoffice/ui'
import type { PassageCard } from '../../../packages/pdf-structure/src/store/reading'
import { strings } from '../src/renderer/i18n/strings'
import type { PdfStoreWriteRequest } from '../src/shared/ipc'
import type { NoteInput } from '../src/renderer/note-threads'
import { PassageCards } from '../src/renderer/reading/passage-controller'
import { passageHash } from '../src/renderer/reading/passage-text'
import {
  PassageReading,
  type PassageReadingHandle,
  type PassageReadingProps,
} from '../src/renderer/reading/PassageReading'
import { PassageUnderlines } from '../src/renderer/reading/PassageUnderlines'
import { createSaveConfirmations } from '../src/renderer/reading/save-confirmations'

const translate = createI18n(strings)
const t: PassageReadingProps['t'] = (key, params) => translate('en', key, params)

const DOC = 'a'.repeat(64)
const SAVED = 'b'.repeat(64)
const PATH = 'C:\\docs\\report.pdf'
const FPS = ['fp1', 'fp2', 'fp3']
const QUADS = [[100, 700, 300, 700, 100, 688, 300, 688]]

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

interface StreamStart {
  requestId: string
  settings: AiSettings
  system?: string
  messages: Array<{ role: string; text?: string }>
  tools?: unknown[]
}

function fakeBridge(initial: {
  settings: AiSettings
  statuses: SubscriptionStatusMap
  /** the status check stays unanswered until `answerCheck` */
  holdCheck?: boolean
}) {
  const state = { settings: initial.settings, statuses: initial.statuses }
  let releaseCheck: (() => void) | null = null
  const checked = initial.holdCheck
    ? new Promise<void>((resolve) => {
        releaseCheck = resolve
      })
    : Promise.resolve()
  const statusListeners = new Set<(s: SubscriptionStatusMap) => void>()
  const starts: StreamStart[] = []
  const answered = new Set<string>()
  const listeners = new Set<(chunk: IpcStreamChunk) => void>()
  const api = {
    getAiSettings: vi.fn(async () => state.settings),
    setAiSettings: vi.fn(async (next: AiSettings) => {
      state.settings = next
    }),
    onAiSettingsChanged: () => () => {},
    openAiModelSettings: vi.fn(async () => {}),
    onLanguageChanged: () => () => {},
    subscription: {
      statuses: vi.fn(async () => {
        await checked
        return state.statuses
      }),
      recheck: vi.fn(async () => {
        await checked
        return state.statuses
      }),
      login: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ ok: true })),
      setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses: state.statuses })),
      onChanged: (handler: (s: SubscriptionStatusMap) => void) => {
        statusListeners.add(handler)
        return () => statusListeners.delete(handler)
      },
      openInstallHelp: vi.fn(async () => {}),
    },
    aiStream: vi.fn(async (request: StreamStart) => {
      starts.push(request)
    }),
    aiStreamCancel: vi.fn(async () => {}),
    onAiStream: (listener: (chunk: IpcStreamChunk) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const push = (requestId: string, chunk: Omit<IpcStreamChunk, 'requestId'>) => {
    for (const listener of [...listeners]) listener({ requestId, ...chunk })
  }
  return {
    api,
    starts,
    /** answer the held status check with these statuses */
    answerCheck(statuses: SubscriptionStatusMap) {
      state.statuses = statuses
      releaseCheck?.()
    },
    /** the main process reports new statuses */
    changeStatuses(statuses: SubscriptionStatusMap) {
      state.statuses = statuses
      for (const handler of [...statusListeners]) handler(statuses)
    },
    /** every open call fails with this stream error */
    failAll(chunk: Omit<IpcStreamChunk, 'requestId'>) {
      for (const s of starts) {
        if (answered.has(s.requestId)) continue
        answered.add(s.requestId)
        push(s.requestId, chunk)
      }
    },
    answerAll(text: string) {
      for (const s of starts) {
        if (answered.has(s.requestId)) continue
        answered.add(s.requestId)
        push(s.requestId, { type: 'delta', text })
        push(s.requestId, { type: 'done' })
      }
    },
  }
}

function fakeStore(initial: PassageCard[] = []) {
  let cards = [...initial]
  const writes: PdfStoreWriteRequest[] = []
  const store = {
    docHash: vi.fn(async () => ({ ok: true as const, docHash: DOC })),
    passages: vi.fn(async () => ({ ok: true as const, cards: cards.map((c) => ({ ...c })) })),
    pageFingerprints: vi.fn(async () => ({ ok: true as const, docHash: DOC, fingerprints: FPS })),
    write: vi.fn(async (request: PdfStoreWriteRequest) => {
      writes.push(request)
      if (request.kind === 'passage') {
        cards = [...cards.filter((c) => c.id !== request.card.id), { ...request.card, savedAt: 2 }]
      }
      if (request.kind === 'deletePassage') cards = cards.filter((c) => c.id !== request.id)
      return { ok: true as const }
    }),
  }
  return { store, writes }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let bridge: ReturnType<typeof fakeBridge>

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => window.localStorage.clear())
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (check()) return
    await settle()
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function mount(
  o: {
    statuses?: SubscriptionStatusMap
    stored?: PassageCard[]
    props?: Partial<PassageReadingProps>
    noticeSeen?: boolean
    holdCheck?: boolean
  } = {},
) {
  bridge = fakeBridge({
    settings: { ...normalizeAiSettings({}), subscriptionNoticeSeen: o.noticeSeen ?? true },
    statuses: o.statuses ?? statusesOf('ready', 'signed-out'),
    holdCheck: o.holdCheck ?? false,
  })
  vi.stubGlobal('pdfApi', bridge.api)
  const f = fakeStore(o.stored)
  const cards = new PassageCards({ store: f.store, file: () => ({ path: PATH }) })
  await cards.load()
  const confirmations = createSaveConfirmations()
  const handle = createRef<PassageReadingHandle>()
  const notes: NoteInput[] = []
  const live = new Set<string>()
  const props: PassageReadingProps = {
    cards,
    confirmations,
    lang: 'en',
    t,
    readOnly: false,
    title: 'Report',
    pageText: async () => 'Before text. the passage After text.',
    addNote: vi.fn((note: NoteInput) => {
      notes.push(note)
      const id = `note-${notes.length}`
      live.add(id)
      return id
    }),
    hasPendingDrawing: (id: string) => live.has(id),
    author: 'kim',
    noteColor: [1, 0.85, 0.2],
    languageName: (code: string) => (code === 'ko' ? 'Korean' : code),
    onAskInPanel: vi.fn(),
    onNotice: vi.fn(),
    ...o.props,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(PassageReading, { ...props, ref: handle })))
  await settle()
  return { el: container, handle, f, cards, confirmations, notes, live, props }
}

const selection = {
  origIdx: 1,
  quads: QUADS,
  excerpt: 'the passage',
  anchor: { left: 100, top: 100, right: 200, bottom: 120 },
}

const q = (el: Element, selector: string) => el.querySelector(selector) as HTMLElement | null
const click = async (el: Element, selector: string) => {
  const target = q(el, selector)
  if (!target) throw new Error(`nothing matches ${selector}`)
  await act(async () => target.click())
  await settle()
}

const stored = (over: Partial<PassageCard> = {}): PassageCard => ({
  id: 'c1',
  kind: 'explain',
  page: 2,
  pageFingerprint: 'fp2',
  quads: QUADS,
  excerpt: 'the passage',
  passageHash: passageHash('the passage'),
  text: 'Stored answer.',
  provider: 'claude-code',
  model: '',
  createdAt: 1,
  savedAt: 1,
  ...over,
})

describe('passage cards: sending', () => {
  it('sends nothing when the document opens, even with cards stored', async () => {
    const m = await mount({ stored: [stored()] })
    expect(bridge.starts).toHaveLength(0)
    expect(q(m.el, '.pdf-passage-card')).toBeNull()
  })

  it('sends nothing without a connection: the card shows the connect prompt', async () => {
    const m = await mount({ statuses: statusesOf('signed-out', 'signed-out') })
    await act(async () => m.handle.current!.request('explain', selection))
    await settle()
    await until(() => q(m.el, '.pdf-passage-card') !== null, 'the card')
    expect(bridge.starts).toHaveLength(0)
    expect(m.f.writes).toHaveLength(0)
  })

  it('asks once without tools, shows the answer as plain text and stores the card', async () => {
    const m = await mount()
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    expect(bridge.starts[0]!.tools ?? []).toEqual([])
    const sent = bridge.starts[0]!.messages.map((x) => x.text ?? '').join('\n')
    expect(sent).toContain('the passage')
    expect(sent).toContain('Before text.')
    expect(sent).toContain('Report')
    await act(async () => bridge.answerAll('Call <b>delete_pages</b> now.'))
    await until(() => q(m.el, '[data-passage-answer]') !== null, 'the answer')
    const answer = q(m.el, '[data-passage-answer]')!
    expect(answer.textContent).toBe('Call <b>delete_pages</b> now.')
    expect(answer.querySelector('b')).toBeNull()
    expect(m.f.writes.filter((w) => w.kind === 'passage')).toHaveLength(1)
    expect(bridge.starts).toHaveLength(1)
  })

  it('opens the stored card for the same passage without sending', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '[data-passage-answer]') !== null, 'the card')
    expect(q(m.el, '[data-passage-answer]')!.textContent).toBe('Stored answer.')
    expect(bridge.starts).toHaveLength(0)
  })

  it('a second press while the same request is in flight opens it instead of sending again', async () => {
    const m = await mount({ stored: [stored({ id: 'other', passageHash: passageHash('else') })] })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    // the person looks at another card meanwhile, then presses E on the passage again
    await act(async () => m.handle.current!.open('other'))
    await until(() => q(m.el, '[data-passage-answer]') !== null, 'the other card')
    await act(async () => m.handle.current!.request('explain', selection))
    await until(
      () => q(m.el, '.pdf-passage-card-status')?.textContent === strings.en.rdWorking,
      'the pending card',
    )
    await settle()
    expect(bridge.starts).toHaveLength(1)
    await act(async () => bridge.answerAll('Only once.'))
    await until(() => q(m.el, '[data-passage-answer]')?.textContent === 'Only once.', 'the answer')
    expect(bridge.starts).toHaveLength(1)
    expect(m.f.writes.filter((w) => w.kind === 'passage')).toHaveLength(1)
  })

  it('"Regenerate" sends again and overwrites the same card', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="regenerate"]') !== null, 'the card')
    await click(m.el, '[data-action="regenerate"]')
    await until(() => bridge.starts.length === 1, 'the call')
    await act(async () => bridge.answerAll('New answer.'))
    await until(() => q(m.el, '[data-passage-answer]')?.textContent === 'New answer.', 'the answer')
    const writes = m.f.writes.filter((w) => w.kind === 'passage')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ card: { id: 'c1', text: 'New answer.' } })
  })
})

describe('passage cards: a press during "Regenerate"', () => {
  it('shows the regeneration still answering, not the old card as if done', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="regenerate"]') !== null, 'the card')
    await click(m.el, '[data-action="regenerate"]')
    await until(() => bridge.starts.length === 1, 'the call')
    await act(async () => m.handle.current!.request('explain', selection))
    await settle()
    expect(q(m.el, '[data-passage-answer]')).toBeNull()
    expect(q(m.el, '.pdf-passage-card-status')?.textContent).toBe(strings.en.rdWorking)
    await act(async () => bridge.answerAll('New answer.'))
    await until(() => q(m.el, '[data-passage-answer]')?.textContent === 'New answer.', 'the answer')
    expect(bridge.starts).toHaveLength(1)
  })

  it('shows a regeneration the gate still holds as waiting, and it still starts', async () => {
    const m = await mount({ stored: [stored()], holdCheck: true })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="regenerate"]') !== null, 'the card')
    await click(m.el, '[data-action="regenerate"]')
    await act(async () => m.handle.current!.request('explain', selection))
    await settle()
    expect(q(m.el, '[data-passage-answer]')).toBeNull()
    expect(q(m.el, '.pdf-passage-card-status')?.textContent).toBe(strings.en.rdWaiting)
    await act(async () => bridge.answerCheck(statusesOf('ready', 'signed-out')))
    await until(() => bridge.starts.length === 1, 'the call')
  })
})

describe('passage cards: the gate and closing', () => {
  const statusText = (el: Element) => q(el, '.pdf-passage-card-status')?.textContent ?? ''

  it('a request held for the status check shows the connect prompt when the answer is "not connected"', async () => {
    const m = await mount({ holdCheck: true })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '.pdf-passage-card') !== null, 'the card')
    expect(statusText(m.el)).toBe(strings.en.rdWaiting)
    await act(async () => bridge.answerCheck(statusesOf('signed-out', 'signed-out')))
    await until(() => statusText(m.el) === strings.en.rdNeedsConnection, 'the connect state')
    expect(bridge.starts).toHaveLength(0)
  })

  it('a request held for the status check starts once a provider can run', async () => {
    const m = await mount({ holdCheck: true })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '.pdf-passage-card') !== null, 'the card')
    expect(bridge.starts).toHaveLength(0)
    await act(async () => bridge.answerCheck(statusesOf('ready', 'signed-out')))
    await until(() => bridge.starts.length === 1, 'the call')
  })

  it('closing the card drops a held request: nothing starts when the check answers later', async () => {
    const m = await mount({ holdCheck: true })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '.pdf-passage-card') !== null, 'the card')
    await click(m.el, '.pdf-passage-card-close')
    expect(q(m.el, '.pdf-passage-card')).toBeNull()
    await act(async () => bridge.answerCheck(statusesOf('ready', 'signed-out')))
    await settle()
    await settle()
    expect(bridge.starts).toHaveLength(0)
    expect(q(m.el, '.pdf-passage-card')).toBeNull()
  })

  it('closing the card during the call stops it; a late answer is neither shown nor stored', async () => {
    const m = await mount()
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    await click(m.el, '.pdf-passage-card-close')
    expect(bridge.api.aiStreamCancel).toHaveBeenCalled()
    await act(async () => bridge.answerAll('Late answer.'))
    await settle()
    expect(q(m.el, '.pdf-passage-card')).toBeNull()
    expect(m.f.writes).toHaveLength(0)
    expect(m.cards.list()).toHaveLength(0)
  })

  it('sends nothing until the first-connection notice is acknowledged, then exactly once', async () => {
    const m = await mount({ noticeSeen: false })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '.pdf-passage-card .ai-sub-first') !== null, 'the notice in the card')
    await settle()
    expect(bridge.starts).toHaveLength(0)
    await click(m.el, '.pdf-passage-card .ai-sub-first .ai-sub-btn.primary')
    await until(() => bridge.starts.length === 1, 'the call')
    await settle()
    expect(bridge.starts).toHaveLength(1)
    await act(async () => bridge.answerAll('After the notice.'))
    await until(
      () => q(m.el, '[data-passage-answer]')?.textContent === 'After the notice.',
      'the answer',
    )
    expect(bridge.starts).toHaveLength(1)
  })

  it('a request held behind the notice is dropped when the connection goes away: the connect prompt shows', async () => {
    const m = await mount({ noticeSeen: false })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => q(m.el, '.pdf-passage-card .ai-sub-first') !== null, 'the notice')
    await act(async () => bridge.changeStatuses(statusesOf('signed-out', 'signed-out')))
    await until(() => statusText(m.el) === strings.en.rdNeedsConnection, 'the connect state')
    expect(bridge.starts).toHaveLength(0)
    // signing in again does not start the dropped request by itself
    await act(async () => bridge.changeStatuses(statusesOf('ready', 'signed-out')))
    await settle()
    expect(bridge.starts).toHaveLength(0)
  })
})

describe('passage cards: a blocked run', () => {
  it('a used-up limit shows the standard blocked notice, not the raw message, and rechecks', async () => {
    const m = await mount()
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    const resetsAt = Date.now() + 3_600_000
    await act(async () =>
      bridge.failAll({
        type: 'error',
        error: 'raw provider text',
        errorCode: 'rate-limit',
        errorProvider: 'claude-code',
        errorResetsAt: resetsAt,
      }),
    )
    await until(() => q(m.el, '.pdf-passage-card .ai-sub-blocked') !== null, 'the notice')
    const notice = q(m.el, '.pdf-passage-card .ai-sub-blocked')!
    expect(notice.dataset.kind).toBe('rate-limit')
    expect(notice.textContent).toContain(
      aiRunErrorText('en', { kind: 'rate-limit', provider: 'claude-code', resetsAt }),
    )
    expect(q(m.el, '.pdf-passage-card')!.textContent).not.toContain('raw provider text')
    expect(bridge.api.subscription.recheck).toHaveBeenCalled()
    expect(m.f.writes).toHaveLength(0)
  })

  it('a signed-out connection shows its standard text', async () => {
    const m = await mount()
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    await act(async () =>
      bridge.failAll({
        type: 'error',
        error: 'raw',
        errorCode: 'signed-out',
        errorProvider: 'claude-code',
      }),
    )
    await until(() => q(m.el, '.pdf-passage-card .ai-sub-blocked') !== null, 'the notice')
    expect(q(m.el, '.pdf-passage-card .ai-sub-blocked')!.textContent).toContain(
      aiRunErrorText('en', { kind: 'signed-out', provider: 'claude-code' }),
    )
  })

  it('never offers to continue with another connection, even when one is ready', async () => {
    const m = await mount({ statuses: statusesOf('ready', 'ready') })
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    await act(async () =>
      bridge.failAll({
        type: 'error',
        error: 'raw',
        errorCode: 'rate-limit',
        errorProvider: 'claude-code',
        errorResetsAt: Date.now() + 60_000,
      }),
    )
    await until(() => q(m.el, '.pdf-passage-card .ai-sub-blocked') !== null, 'the notice')
    expect(q(m.el, '.pdf-passage-card [data-action="continue-with"]')).toBeNull()
  })

  it('any other failure keeps the plain error line', async () => {
    const m = await mount()
    await act(async () => m.handle.current!.request('explain', selection))
    await until(() => bridge.starts.length === 1, 'the call')
    await act(async () => bridge.failAll({ type: 'error', error: 'network down' }))
    await until(() => q(m.el, '.pdf-passage-card-status.is-error') !== null, 'the error')
    expect(q(m.el, '.pdf-passage-card-status.is-error')!.textContent).toContain('network down')
    expect(q(m.el, '.pdf-passage-card .ai-sub-blocked')).toBeNull()
  })
})

describe('passage cards: actions', () => {
  it('"Keep as note" adds a note now and writes savedAsNote only after the save, under the new hash', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="note"]') !== null, 'the card')
    await click(m.el, '[data-action="note"]')
    expect(m.notes).toHaveLength(1)
    expect(m.notes[0]!.contents).toBe('AI explanation\nStored answer.')
    expect(m.notes[0]!.author).toBe('kim')
    expect(m.notes[0]!.pageIndex).toBe(1)
    expect(q(m.el, '[data-note-state="pending"]')).not.toBeNull()
    expect(m.f.writes.some((w) => w.kind === 'passage' && w.card.savedAsNote)).toBe(false)

    // a save that did not contain the note confirms nothing
    await act(async () => m.confirmations.afterSave(['unrelated'], async () => SAVED))
    expect(m.f.writes).toHaveLength(0)

    await act(async () => m.confirmations.afterSave(['note-1'], async () => SAVED))
    await settle()
    expect(m.f.writes).toEqual([
      {
        kind: 'passage',
        docHash: SAVED,
        card: expect.objectContaining({ id: 'c1', savedAsNote: true }),
      },
    ])
    expect(q(m.el, '[data-note-state="saved"]')).not.toBeNull()
  })

  it('"Keep as note" stays waiting through the save reload and confirms once, under the new hash', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="note"]') !== null, 'the card')
    await click(m.el, '[data-action="note"]')
    expect(m.notes).toHaveLength(1)
    // the save succeeded: held before the reload, which then drops the pending note
    await act(async () => m.confirmations.hold(['note-1']))
    m.live.delete('note-1')
    await act(async () => m.handle.current!.open('c1'))
    await settle()
    expect(q(m.el, '[data-note-state="pending"]')).not.toBeNull()
    expect((q(m.el, '[data-action="note"]') as HTMLButtonElement).disabled).toBe(true)
    await click(m.el, '[data-action="note"]')
    expect(m.notes).toHaveLength(1)
    await act(async () => m.confirmations.afterSave(['note-1'], async () => SAVED))
    await settle()
    expect(m.f.writes).toEqual([
      {
        kind: 'passage',
        docHash: SAVED,
        card: expect.objectContaining({ id: 'c1', savedAsNote: true }),
      },
    ])
    expect(q(m.el, '[data-note-state="saved"]')).not.toBeNull()
  })

  it('"Keep as note" is refused on a document that cannot be edited', async () => {
    const m = await mount({ stored: [stored()], props: { readOnly: true } })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="note"]') !== null, 'the card')
    expect((q(m.el, '[data-action="note"]') as HTMLButtonElement).disabled).toBe(true)
    await click(m.el, '[data-action="note"]')
    expect(m.notes).toHaveLength(0)
  })

  it('"Ask more in the AI panel" hands over the passage and the answer without sending', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="ask"]') !== null, 'the card')
    await click(m.el, '[data-action="ask"]')
    expect(m.props.onAskInPanel).toHaveBeenCalledWith({
      origIdx: 1,
      excerpt: 'the passage',
      heading: 'AI explanation',
      answer: 'Stored answer.',
    })
    expect(bridge.starts).toHaveLength(0)
  })

  it('"Delete" removes the card from the store only', async () => {
    const m = await mount({ stored: [stored()] })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="delete"]') !== null, 'the card')
    await click(m.el, '[data-action="delete"]')
    expect(m.f.writes).toEqual([{ kind: 'deletePassage', docHash: DOC, id: 'c1' }])
    expect(m.notes).toHaveLength(0)
    expect(q(m.el, '.pdf-passage-card')).toBeNull()
  })

  it('leaves an extension slot for more card actions', async () => {
    const m = await mount({
      stored: [stored()],
      props: {
        cardActions: (card) =>
          createElement('button', { 'data-action': 'extra', type: 'button' }, card.id),
      },
    })
    await act(async () => m.handle.current!.open('c1'))
    await until(() => q(m.el, '[data-action="extra"]') !== null, 'the slot')
    expect(q(m.el, '[data-action="extra"]')!.textContent).toBe('c1')
  })
})

describe('dotted marks', () => {
  it('draws screen-only marks for cards found on the page, none for a changed page, and reopens on click', async () => {
    bridge = fakeBridge({
      settings: normalizeAiSettings({}),
      statuses: statusesOf('ready', 'signed-out'),
    })
    vi.stubGlobal('pdfApi', bridge.api)
    const f = fakeStore([stored(), stored({ id: 'lost', pageFingerprint: 'gone' })])
    const cards = new PassageCards({ store: f.store, file: () => ({ path: PATH }) })
    await cards.load()
    const onOpen = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const geom = { pw: 595, ph: 842, rot: 0 }
    await act(async () =>
      root!.render(
        createElement('div', null, [
          createElement(PassageUnderlines, {
            key: 'p1',
            cards,
            origIdx: 1,
            geom,
            scale: 1,
            label: (excerpt: string) => t('rdOpenCard', { excerpt }),
            onOpen,
          }),
          createElement(PassageUnderlines, {
            key: 'p0',
            cards,
            origIdx: 0,
            geom,
            scale: 1,
            label: (excerpt: string) => t('rdOpenCard', { excerpt }),
            onOpen,
          }),
        ]),
      ),
    )
    const marks = [...container.querySelectorAll('.pdf-passage-mark')] as HTMLElement[]
    expect(marks).toHaveLength(1)
    expect(marks[0]!.dataset.card).toBe('c1')
    await act(async () => marks[0]!.click())
    expect(onOpen).toHaveBeenCalledWith('c1', expect.anything())
    // the marks live in the screen DOM only: the print root and the save request never see them
    expect(document.querySelector('.pdf-print-root .pdf-passage-mark')).toBeNull()
  })
})

describe('the title a passage request sends', () => {
  it('is the document title only, never the file name (spec 8)', () => {
    const app = readFileSync(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    const start = app.indexOf('<PassageReading\n')
    const block = app.slice(start, app.indexOf('pageText=', start))
    expect(start).toBeGreaterThan(-1)
    expect(block.includes("title={(metadata ?? docInfo).title?.trim() || ''}")).toBe(true)
    expect(block.includes('fileName')).toBe(false)
  })
})
