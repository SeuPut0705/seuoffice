/**
 * "New chat" while an AI run is open: the real panel in jsdom, its slidesApi routed to the real
 * main-process review handlers. The run's edits must be taken back out of the deck and the deck
 * unlocked, even though the loop never reports the run's end after a reset.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentCore from '@seuoffice/agent-core'

const handlers = new Map<string, (...args: never[]) => unknown>()
const agentHarness = vi.hoisted(() => ({
  events: null as null | {
    onDone?: (result: { text: string; cancelled: boolean; turnLimit: boolean }) => void
  },
  run: vi.fn(),
  busy: false,
}))

vi.mock('@seuoffice/agent-core', async () => {
  const actual = await vi.importActual<typeof AgentCore>('@seuoffice/agent-core')
  return {
    ...actual,
    AgentLoop: class MockAgentLoop {
      constructor(options: { events?: typeof agentHarness.events }) {
        agentHarness.events = options.events ?? null
      }
      get busy() {
        return agentHarness.busy
      }
      run(...args: unknown[]) {
        agentHarness.busy = true
        agentHarness.run(...args)
      }
      cancel() {}
      // like the real loop: a reset drops the run without ever calling onDone
      reset() {
        agentHarness.busy = false
      }
      restore() {}
    },
  }
})

vi.mock('../src/renderer/ai/transport', () => ({ createElectronTransport: () => ({}) }))
vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
    once: () => {},
    on: () => {},
  },
  dialog: {},
  clipboard: { writeBuffer: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  net: { fetch: async () => new Response() },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) }),
  },
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import { createBlankPptx, openPptx } from '@seuoffice/pptx-engine'
import type { RenderSlide } from '@seuoffice/pptx-render'
import { applySessionTxn, registerSlidesIpc } from '../src/main/slides-main'
import { buildAllRenderSlides, sessions, type Session } from '../src/main/session-state'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const WC = 1
const FIT_WIDTH = 1280
const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((provider) => [
      provider.id,
      { apiKey: provider.id === 'anthropic' ? 'test-key' : '', model: provider.defaultModel },
    ]),
  ) as AiSettings['providers'],
}

const ipc = (channel: string, ...args: unknown[]): unknown =>
  (handlers.get(channel) as (...a: unknown[]) => unknown)({ sender: { id: WC } }, ...args)

let session: Session
let editor: RenderSlide[]
const mountedRoots: Array<{ root: Root; container: HTMLElement }> = []

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

function mount(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(AiPanel, {
        slides: editor,
        current: 0,
        selectedIds: [],
        images: new Map<string, HTMLImageElement>(),
        applySlide: () => {},
        applyDeck: (all: RenderSlide[]) => {
          editor = all
        },
        fitWidthPx: FIT_WIDTH,
        settings,
        open: true,
        onExpand: () => {},
        onCollapse: () => {},
        preset: { text: 'Polish this slide', nonce: 1, autoRun: true },
      } as never),
    ),
  )
  mountedRoots.push({ root, container })
  return container
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollTo ??= () => {}
  registerSlidesIpc()
})

beforeEach(async () => {
  agentHarness.events = null
  agentHarness.busy = false
  agentHarness.run.mockReset()
  sessions.clear()
  session = {
    path: '',
    fitWidthPx: FIT_WIDTH,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(WC, session)
  editor = buildAllRenderSlides(session.opened, FIT_WIDTH)
  Object.defineProperty(window, 'projectApi', { configurable: true, value: undefined })
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { readAttachmentImage: vi.fn(async () => ({ ok: false })) },
  })
  Object.defineProperty(window, 'slidesApi', {
    configurable: true,
    value: {
      beginHistoryBatch: () => ipc('slides:history-batch-begin'),
      endHistoryBatch: () => ipc('slides:history-batch-end'),
      aiRunBegin: () => ipc('slides:ai-run-begin'),
      aiRunHold: () => ipc('slides:ai-run-hold'),
      aiProposalAccept: () => ipc('slides:ai-proposal-accept'),
      aiProposalReject: () => ipc('slides:ai-proposal-reject'),
      aiLogRunFailure: async () => undefined,
    },
  })
})

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

const slideCount = () => session.opened.deck.slides.length
const aiEdit = () =>
  expect(
    applySessionTxn(session, { ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] })?.applied,
  ).toBe(true)

describe('AiPanel new chat during a run (slides)', () => {
  it('takes the run back out of the deck and unlocks it', async () => {
    const container = mount()
    await flush()
    expect(agentHarness.run).toHaveBeenCalled()
    expect(session.aiRun).toBeDefined()
    const before = slideCount()
    aiEdit()

    await act(async () =>
      container
        .querySelector<HTMLElement>('.ai-header-btn:not([class*=" "])')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await flush()

    expect(session.aiRun).toBeUndefined()
    expect(session.aiProposal).toBeUndefined()
    expect(slideCount()).toBe(before)
    expect(editor.length).toBe(before)
    expect(container.querySelector('.turn-proposal')).toBeNull()
  })

  it('unmounting the panel mid-run takes the run back out too', async () => {
    mount()
    await flush()
    const before = slideCount()
    aiEdit()
    const { root, container } = mountedRoots.pop()!
    act(() => root.unmount())
    container.remove()
    await flush()
    expect(session.aiRun).toBeUndefined()
    expect(slideCount()).toBe(before)
  })

  /** aiRunBegin held open (the real handler runs once released), like a begin waiting for a save */
  function pauseRunBegin(): { release: () => Promise<void> } {
    let go!: () => void
    const gate = new Promise<void>((resolve) => (go = resolve))
    let pending: Promise<unknown> = Promise.resolve()
    const api = window.slidesApi as unknown as Record<string, () => unknown>
    api.aiRunBegin = () => (pending = gate.then(() => ipc('slides:ai-run-begin')))
    return {
      release: async () => {
        go()
        await pending
        await flush()
      },
    }
  }

  const clickNewChat = (container: HTMLElement) =>
    act(async () =>
      container
        .querySelector<HTMLElement>('.ai-header-btn:not([class*=" "])')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )

  it('new chat while the run is still being prepared never starts the request', async () => {
    const begin = pauseRunBegin()
    const container = mount()
    await flush()
    expect(agentHarness.run).not.toHaveBeenCalled()

    await clickNewChat(container)
    await begin.release()
    await flush()

    expect(agentHarness.run).not.toHaveBeenCalled()
    expect(session.aiRun).toBeUndefined()
    expect(container.querySelector('.turn-proposal')).toBeNull()
  })

  it('unmounting while the run is still being prepared never starts the request', async () => {
    const begin = pauseRunBegin()
    mount()
    await flush()
    const { root, container } = mountedRoots.pop()!
    act(() => root.unmount())
    container.remove()
    await begin.release()
    await flush()

    expect(agentHarness.run).not.toHaveBeenCalled()
    expect(session.aiRun).toBeUndefined()
  })

  it('a later send works after the abandoned preparation', async () => {
    const begin = pauseRunBegin()
    const container = mount()
    await flush()
    await clickNewChat(container)
    await begin.release()
    await flush()
    // the begin stub of the next send is the real handler again
    ;(window.slidesApi as unknown as Record<string, () => unknown>).aiRunBegin = () =>
      ipc('slides:ai-run-begin')

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-slides-ai-input]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(textarea, 'second try')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    await flush()

    expect(agentHarness.run).toHaveBeenCalledTimes(1)
    expect(session.aiRun).toBeDefined()
  })
})
