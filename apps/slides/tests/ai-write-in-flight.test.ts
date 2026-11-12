/**
 * An AI write call that is still in flight (a generated page being read from disk) when the
 * person presses Stop, starts a new chat or the panel unmounts: the real panel in jsdom, its
 * slidesApi routed to the real main-process handlers. The late write must be refused, so the deck
 * ends equal to its pre-run state (or holds only the run's earlier edits as a fresh proposal).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentCore from '@seuoffice/agent-core'

const handlers = new Map<string, (...args: never[]) => unknown>()
const fsGate = vi.hoisted(() => ({ hold: null as null | Promise<void> }))
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

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (fsGate.hold && String(args[0]).includes('seuoffice-local-pages')) await fsGate.hold
      return actual.readFile(...args)
    }) as typeof actual.readFile,
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

async function generatedPage(): Promise<string> {
  const r = (await ipc('slides:local-page-generate', {
    specJson: JSON.stringify({
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
    }),
  })) as { ok: boolean; marker?: string; error?: string }
  if (!r.ok || !r.marker) throw new Error(`page not generated: ${r.error}`)
  return r.marker
}

/** the next page read from disk waits until release() */
function pauseRead(): { release: () => void } {
  let go!: () => void
  fsGate.hold = new Promise<void>((resolve) => (go = resolve))
  return {
    release: () => {
      fsGate.hold = null
      go()
    },
  }
}

type LandMode = 'append' | 'replace_at' | 'insert_at' | 'replace'
const land = (marker: string, mode: LandMode) =>
  ipc('slides:land-generated-pages', [marker], FIT_WIDTH, mode, 0, 'deck') as Promise<{
    error?: string
  }>

const stopButton = (container: HTMLElement) => container.querySelector<HTMLElement>('.ai-stop-btn')!
const newChatButton = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.ai-header-btn:not([class*=" "])')!
const click = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

afterEach(() => {
  fsGate.hold = null
})

describe('slides:land-generated-pages while the run is held meanwhile', () => {
  for (const mode of ['append', 'replace_at', 'insert_at', 'replace'] as const) {
    it(`${mode}: the page read finishes after the hold, nothing lands, the proposal stays fresh`, async () => {
      const marker = await generatedPage()
      expect(await ipc('slides:ai-run-begin')).toBe(true)
      await flush()
      aiEdit()
      const before = slideCount() - 1
      const gate = pauseRead()
      const landing = land(marker, mode)
      await flush()
      expect(ipc('slides:ai-run-hold')).not.toBeNull()
      gate.release()
      const result = await landing

      expect(result.error).toBeDefined()
      expect(sessions.get(WC)).toBe(session)
      expect(session.aiRun).toBeUndefined()
      expect(slideCount()).toBe(before)
      expect(session.aiProposal).toBeDefined()
      const accepted = ipc('slides:ai-proposal-accept') as { slides: unknown[] } | null
      expect(accepted?.slides.length).toBe(before + 1)
    })
  }
})

describe('slides:land-generated-pages for a panel run that is no longer open', () => {
  const expectRun = (marker: string, mode: LandMode) =>
    ipc('slides:land-generated-pages', [marker], FIT_WIDTH, mode, 0, 'deck', true) as Promise<{
      error?: string
    }>

  for (const mode of ['append', 'replace_at', 'insert_at', 'replace'] as const) {
    it(`${mode}: refused when the panel expects a run and none is open`, async () => {
      const marker = await generatedPage()
      const before = slideCount()
      const result = await expectRun(marker, mode)
      expect(result.error).toBeDefined()
      expect(sessions.get(WC)).toBe(session)
      expect(slideCount()).toBe(before)
      expect(session.undoStack.length).toBe(0)
    })
  }

  it('lands as before when no run is expected (a handed-over run makes a new document)', async () => {
    const marker = await generatedPage()
    const before = slideCount()
    const result = await land(marker, 'append')
    expect(result.error).toBeUndefined()
    expect(slideCount()).toBe(before + 1)
  })

  it('lands while the expected run is open', async () => {
    const marker = await generatedPage()
    expect(await ipc('slides:ai-run-begin')).toBe(true)
    const before = slideCount()
    const result = await expectRun(marker, 'append')
    expect(result.error).toBeUndefined()
    expect(slideCount()).toBe(before + 1)
  })

  it('insert and replace picture by URL are refused when the expected run is gone', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ).toString('base64')
    const before = slideCount()
    const inserted = await ipc('ai:insert-image-url', {
      slideIndex: 0,
      base64: png,
      ext: 'png',
      xPx: 10,
      yPx: 10,
      wPx: 50,
      hPx: 50,
      fitWidthPx: FIT_WIDTH,
      aiRunExpected: true,
    })
    expect(inserted).toBeNull()
    const replaced = await ipc('ai:replace-picture-url', {
      slideIndex: 0,
      sourceId: 'x',
      base64: png,
      ext: 'png',
      aiRunExpected: true,
    })
    expect(replaced).toBeNull()
    expect(slideCount()).toBe(before)
    expect(session.undoStack.length).toBe(0)
    expect(session.opened.deck.slides[0]!.elements.length).toBe(0)
    // the same call without the flag is a valid insert, so the refusal above came from the flag
    const control = await ipc('ai:insert-image-url', {
      slideIndex: 0,
      base64: png,
      ext: 'png',
      xPx: 10,
      yPx: 10,
      wPx: 50,
      hPx: 50,
      fitWidthPx: FIT_WIDTH,
    })
    expect(control).not.toBeNull()
  })
})

describe('AiPanel with an AI write call still in flight', () => {
  async function startPausedWrite(mode: LandMode): Promise<{
    container: HTMLElement
    landing: Promise<{ error?: string }>
    gate: { release: () => void }
    before: number
  }> {
    const marker = await generatedPage()
    const container = mount()
    await flush()
    expect(session.aiRun).toBeDefined()
    const before = slideCount()
    const gate = pauseRead()
    const landing = land(marker, mode)
    await flush()
    return { container, landing, gate, before }
  }

  const settled = (r: { error?: string }) => {
    expect(r.error).toBeDefined()
    expect(session.aiRun).toBeUndefined()
    expect(session.aiProposal).toBeUndefined()
    expect(container0().querySelector('.turn-proposal')).toBeNull()
  }
  const container0 = () => mountedRoots[0]?.container ?? document.body

  for (const mode of ['append', 'replace_at', 'insert_at'] as const) {
    it(`Stop while ${mode} is reading: the late write never lands`, async () => {
      const { container, landing, gate, before } = await startPausedWrite(mode)
      await click(stopButton(container))
      await act(async () =>
        agentHarness.events!.onDone?.({ text: '', cancelled: true, turnLimit: false }),
      )
      await flush()
      gate.release()
      settled(await landing)
      await flush()
      expect(slideCount()).toBe(before)
      expect(editor.length).toBe(before)
      expect(session.undoStack.length).toBe(0)
    })

    it(`New chat while ${mode} is reading: the late write never lands`, async () => {
      const { container, landing, gate, before } = await startPausedWrite(mode)
      await click(newChatButton(container))
      await flush()
      gate.release()
      settled(await landing)
      await flush()
      expect(slideCount()).toBe(before)
      expect(session.undoStack.length).toBe(0)
    })

    it(`unmount while ${mode} is reading: the late write never lands`, async () => {
      const { landing, gate, before } = await startPausedWrite(mode)
      const { root, container } = mountedRoots.pop()!
      act(() => root.unmount())
      container.remove()
      await flush()
      gate.release()
      const r = await landing
      expect(r.error).toBeDefined()
      expect(session.aiRun).toBeUndefined()
      expect(session.aiProposal).toBeUndefined()
      expect(slideCount()).toBe(before)
      expect(session.undoStack.length).toBe(0)
    })
  }

  it('Stop with an earlier AI edit holds it as a proposal the late write does not stale', async () => {
    const { container, landing, gate, before } = await startPausedWrite('append')
    aiEdit()
    await click(stopButton(container))
    await act(async () =>
      agentHarness.events!.onDone?.({ text: '', cancelled: true, turnLimit: false }),
    )
    await flush()
    gate.release()
    expect((await landing).error).toBeDefined()
    await flush()
    expect(session.aiRun).toBeUndefined()
    expect(slideCount()).toBe(before)
    expect(session.aiProposal).toBeDefined()
    const accepted = ipc('slides:ai-proposal-accept') as { slides: unknown[] } | null
    expect(accepted?.slides.length).toBe(before + 1)
  })
})
