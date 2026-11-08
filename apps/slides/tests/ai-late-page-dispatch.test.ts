/**
 * A generate_deck / regenerate_slide tool call still building its page (localGeneratePage pending)
 * when the person presses Stop or New chat: the real panel and the real slides skill in jsdom,
 * slidesApi routed to the real main-process handlers. Once the run is over, the late page must not
 * reach main at all, so the deck equals its pre-run state and no run is left open.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentCore from '@genoffice/agent-core'

const handlers = new Map<string, (...args: never[]) => unknown>()
const agentHarness = vi.hoisted(() => ({
  skill: null as null | {
    executeTool?: (
      call: { id: string; name: string; input: unknown },
      signal?: AbortSignal,
    ) => Promise<unknown>
  },
  controller: null as AbortController | null,
  toolCall: null as null | { id: string; name: string; input: unknown },
  toolDone: null as null | Promise<unknown>,
  events: null as null | {
    onDone?: (result: { text: string; cancelled: boolean; turnLimit: boolean }) => void
  },
  run: vi.fn(),
  busy: false,
}))

vi.mock('@genoffice/agent-core', async () => {
  const actual = await vi.importActual<typeof AgentCore>('@genoffice/agent-core')
  return {
    ...actual,
    AgentLoop: class MockAgentLoop {
      constructor(options: {
        events?: typeof agentHarness.events
        skill?: typeof agentHarness.skill
      }) {
        agentHarness.events = options.events ?? null
        agentHarness.skill = options.skill ?? null
      }
      get busy() {
        return agentHarness.busy
      }
      run(...args: unknown[]) {
        agentHarness.busy = true
        agentHarness.run(...args)
        // the real skill executes the model's tool call under the run's abort signal
        agentHarness.controller = new AbortController()
        if (agentHarness.toolCall)
          agentHarness.toolDone = agentHarness.skill!.executeTool!(
            agentHarness.toolCall,
            agentHarness.controller.signal,
          )
      }
      cancel() {
        agentHarness.controller?.abort()
      }
      // like the real loop: a reset drops the run without ever calling onDone
      reset() {
        agentHarness.busy = false
        agentHarness.controller?.abort()
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

import { createBlankPptx, openPptx } from '@genoffice/pptx-engine'
import type { RenderSlide } from '@genoffice/pptx-render'
import { registerSlidesIpc } from '../src/main/slides-main'
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

type Call = { id: string; name: string; input: Record<string, unknown> }
const scenario = {
  /** the first N single-page builds fail (a rejected spec), so generate_deck needs its retry round */
  failFirst: 0,
  /** the next build after the failures waits for release() */
  pause: false,
  paused: false,
  localCalls: 0,
  release: null as null | (() => void),
}
const landSpy = vi.fn()

const pageSpec = JSON.stringify({
  background: '#0E1A2B',
  elements: [
    {
      type: 'text',
      x: 80,
      y: 60,
      w: 800,
      h: 90,
      paragraphs: [{ runs: [{ text: 'late page', sizePt: 36, color: '#FFFFFF' }] }],
    },
  ],
})

const streamListeners = new Set<(chunk: unknown) => void>()

beforeEach(() => {
  scenario.failFirst = 0
  scenario.pause = false
  scenario.paused = false
  scenario.localCalls = 0
  scenario.release = null
  landSpy.mockReset()
  landSpy.mockImplementation((...a: unknown[]) => ipc('slides:land-generated-pages', ...a))
  agentHarness.toolCall = null
  agentHarness.toolDone = null
  agentHarness.controller = null
  // the retry backoff between a page's two attempts is real time otherwise
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms === 2000 ? 0 : ms)) as typeof setTimeout)
  const api = window.slidesApi as unknown as Record<string, unknown>
  api.onAiStream = (cb: (chunk: unknown) => void) => {
    streamListeners.add(cb)
    return () => streamListeners.delete(cb)
  }
  api.aiStreamCancel = async () => undefined
  api.aiStream = async (req: { requestId: string }) => {
    queueMicrotask(() => {
      for (const cb of [...streamListeners]) {
        cb({ requestId: req.requestId, type: 'delta', text: pageSpec })
        cb({ requestId: req.requestId, type: 'done' })
      }
    })
  }
  api.localGeneratePage = async (op: unknown) => {
    scenario.localCalls += 1
    if (scenario.failFirst > 0) {
      scenario.failFirst -= 1
      return { ok: false, error: 'spec rejected' }
    }
    if (scenario.pause) {
      scenario.pause = false
      scenario.paused = true
      await new Promise<void>((resolve) => (scenario.release = resolve))
    }
    return ipc('slides:local-page-generate', op)
  }
  api.landGeneratedPages = landSpy
})

const stopButton = (container: HTMLElement) => container.querySelector<HTMLElement>('.ai-stop-btn')!
const newChatButton = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.ai-header-btn:not([class*=" "])')!
const click = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

async function untilPaused(): Promise<void> {
  for (let i = 0; i < 200 && !scenario.paused; i++) await flush()
  expect(scenario.paused).toBe(true)
}

const generateDeck: Call = {
  id: 'tool-1',
  name: 'generate_deck',
  input: {
    core_hook: 'Hook',
    style: 'clean and calm',
    insert_mode: 'append',
    pages: [{ title: 'One', brief: 'Body text', layout: 'left_text_right_image' }],
  },
}
const regenerateSlide: Call = {
  id: 'tool-1',
  name: 'regenerate_slide',
  input: { slideIndex: 0, title: 'Redo', brief: 'Redo this page' },
}

const scenarios: Array<{ name: string; call: Call; failFirst: number }> = [
  // two attempts of the first pass, each of them two builds: the retry round starts at build 5
  { name: 'generate_deck retry round', call: generateDeck, failFirst: 4 },
  { name: 'regenerate_slide', call: regenerateSlide, failFirst: 0 },
]

describe('a page build still pending when the person acts', () => {
  for (const sc of scenarios) {
    for (const action of ['Stop', 'New chat'] as const) {
      it(`${action} during ${sc.name}: nothing is landed, the deck stays as it was`, async () => {
        const before = session.opened.deck.slides.length
        agentHarness.toolCall = sc.call
        scenario.failFirst = sc.failFirst
        scenario.pause = true
        const container = mount()
        await flush()
        await untilPaused()
        expect(session.aiRun).toBeDefined()

        if (action === 'Stop') {
          await click(stopButton(container))
          await act(async () =>
            agentHarness.events!.onDone?.({ text: '', cancelled: true, turnLimit: false }),
          )
        } else {
          await click(newChatButton(container))
        }
        await flush()
        scenario.release!()
        await agentHarness.toolDone
        await flush()

        expect(landSpy).not.toHaveBeenCalled()
        expect(session.opened.deck.slides.length).toBe(before)
        expect(editor.length).toBe(before)
        expect(session.undoStack.length).toBe(0)
        expect(session.aiRun).toBeUndefined()
        expect(session.aiProposal).toBeUndefined()
        expect(container.querySelector('.turn-proposal')).toBeNull()
      })
    }
  }
})
