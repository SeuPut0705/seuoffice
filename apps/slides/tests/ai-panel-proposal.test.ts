/** AI edit review in the panel: a finished run becomes a pending proposal the person settles. */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@seuoffice/pptx-render'

import type * as AgentCore from '@seuoffice/agent-core'
const agentHarness = vi.hoisted(() => ({
  events: null as null | {
    onDone?: (result: { text: string; cancelled: boolean; turnLimit: boolean }) => void
  },
  run: vi.fn(),
}))

vi.mock('@seuoffice/agent-core', async () => {
  const actual = await vi.importActual<typeof AgentCore>('@seuoffice/agent-core')
  return {
    ...actual,
    AgentLoop: class MockAgentLoop {
      busy = false

      constructor(options: { events?: typeof agentHarness.events }) {
        agentHarness.events = options.events ?? null
      }

      run(...args: unknown[]) {
        agentHarness.run(...args)
      }

      cancel() {}

      reset() {}

      restore() {}
    },
  }
})

vi.mock('../src/renderer/ai/transport', () => ({ createElectronTransport: () => ({}) }))

// react-konva's node entry requires the native 'canvas' package; these tests do not draw.
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

import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((provider) => [
      provider.id,
      { apiKey: provider.id === 'anthropic' ? 'test-key' : '', model: provider.defaultModel },
    ]),
  ) as AiSettings['providers'],
}

const slide = (partPath: string, text: string) =>
  ({
    partPath,
    widthPx: 960,
    heightPx: 540,
    scale: 1,
    background: { kind: 'none' },
    nodes: [{ text }],
  }) as unknown as RenderSlide

const preRun = [slide('/ppt/slides/slide1.xml', 'Original')]
const liveAfterRun = [slide('/ppt/slides/slide1.xml', 'Edited by the AI')]

const mountedRoots: Array<{ root: Root; container: HTMLElement }> = []

function mount(applyDeck: (slides: RenderSlide[]) => void): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(AiPanel, {
        slides: liveAfterRun,
        current: 0,
        selectedIds: [],
        images: new Map<string, HTMLImageElement>(),
        applySlide: () => {},
        applyDeck,
        fitWidthPx: 960,
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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

interface SlidesApiStub {
  aiRunBegin: ReturnType<typeof vi.fn>
  aiRunHold: ReturnType<typeof vi.fn>
  aiProposalAccept: ReturnType<typeof vi.fn>
  aiProposalReject: ReturnType<typeof vi.fn>
}

function installSlidesApi(overrides: Partial<SlidesApiStub> = {}): SlidesApiStub {
  const api: SlidesApiStub = {
    aiRunBegin: vi.fn(async () => true),
    aiRunHold: vi.fn(async () => preRun),
    aiProposalAccept: vi.fn(async () => ({ slides: liveAfterRun, snapshotId: 7 })),
    aiProposalReject: vi.fn(async () => true),
    ...overrides,
  }
  Object.defineProperty(window, 'slidesApi', {
    configurable: true,
    value: {
      beginHistoryBatch: vi.fn(async () => true),
      endHistoryBatch: vi.fn(async () => 5),
      aiLogRunFailure: vi.fn(async () => undefined),
      ...api,
    },
  })
  return api
}

/** Mount, let the preset start its run, then end the run the way AgentLoop does */
async function finishedRun(
  applyDeck: (slides: RenderSlide[]) => void = () => {},
): Promise<HTMLElement> {
  const container = mount(applyDeck)
  await flush()
  expect(agentHarness.run).toHaveBeenCalled()
  await act(async () =>
    agentHarness.events!.onDone!({ text: 'Done', cancelled: false, turnLimit: false }),
  )
  await flush()
  return container
}

const click = (el: Element | null) =>
  act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollTo ??= () => {}
})

beforeEach(() => {
  agentHarness.events = null
  agentHarness.run.mockReset()
  Object.defineProperty(window, 'projectApi', { configurable: true, value: undefined })
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { readAttachmentImage: vi.fn(async () => ({ ok: false })) },
  })
})

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('AiPanel edit review (slides)', () => {
  it('takes the finished run out of the deck and offers it as a proposal', async () => {
    const api = installSlidesApi()
    const applyDeck = vi.fn()
    const container = await finishedRun(applyDeck)

    expect(api.aiRunBegin).toHaveBeenCalledTimes(1)
    expect(api.aiRunHold).toHaveBeenCalledTimes(1)
    // the editor shows the deck as it was before the run
    expect(applyDeck).toHaveBeenCalledWith(preRun, 0)
    expect(container.querySelector('.turn-proposal')).not.toBeNull()
    expect(container.querySelector('.turn-proposal-btn-primary')).not.toBeNull()
    // the reply carries no rollback control for edits that are no longer in the deck
    expect(container.textContent).not.toContain('Roll back')
  })

  it('shows no proposal when the run changed nothing', async () => {
    installSlidesApi({ aiRunHold: vi.fn(async () => null) })
    const applyDeck = vi.fn()
    const container = await finishedRun(applyDeck)
    expect(container.querySelector('.turn-proposal')).toBeNull()
    expect(applyDeck).not.toHaveBeenCalled()
  })

  it('refuses a new request until the proposal is accepted or rejected', async () => {
    installSlidesApi()
    const container = await finishedRun()
    const send = container.querySelector<HTMLButtonElement>('.ai-send-btn')!
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-slides-ai-input]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(textarea, 'one more change')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(send.disabled).toBe(true)

    agentHarness.run.mockClear()
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    )
    await flush()
    expect(agentHarness.run).not.toHaveBeenCalled()

    await click(container.querySelector('.turn-proposal-btn:not(.turn-proposal-btn-primary)'))
    await flush()
    expect(container.querySelector('.turn-proposal')).toBeNull()
    expect(send.disabled).toBe(false)
  })

  it('accept applies the proposal and brings back the reply rollback control', async () => {
    const api = installSlidesApi()
    const applyDeck = vi.fn()
    const container = await finishedRun(applyDeck)
    applyDeck.mockClear()

    await click(container.querySelector('.turn-proposal-btn-primary'))
    await flush()

    expect(api.aiProposalAccept).toHaveBeenCalledTimes(1)
    expect(applyDeck).toHaveBeenCalledWith(liveAfterRun, 0)
    expect(container.querySelector('.turn-proposal')).toBeNull()
    expect(container.querySelector('.ai-rollback-btn')).not.toBeNull()
  })

  it('reject drops the proposal and leaves the deck as it is', async () => {
    const api = installSlidesApi()
    const applyDeck = vi.fn()
    const container = await finishedRun(applyDeck)
    applyDeck.mockClear()

    await click(container.querySelector('.turn-proposal-btn:not(.turn-proposal-btn-primary)'))
    await flush()

    expect(api.aiProposalReject).toHaveBeenCalledTimes(1)
    expect(api.aiProposalAccept).not.toHaveBeenCalled()
    expect(applyDeck).not.toHaveBeenCalled()
    expect(container.querySelector('.turn-proposal')).toBeNull()
  })

  it('a refused accept marks the proposal stale and leaves the deck alone', async () => {
    const api = installSlidesApi({ aiProposalAccept: vi.fn(async () => null) })
    const applyDeck = vi.fn()
    const container = await finishedRun(applyDeck)
    applyDeck.mockClear()

    await click(container.querySelector('.turn-proposal-btn-primary'))
    await flush()

    expect(api.aiProposalAccept).toHaveBeenCalledTimes(1)
    expect(applyDeck).not.toHaveBeenCalled()
    expect(container.querySelector('.turn-proposal-stale')).not.toBeNull()
    // nothing left to accept: only a dismiss button remains
    expect(container.querySelector('.turn-proposal-btn-primary')).toBeNull()
    await click(container.querySelector('.turn-proposal-btn'))
    await flush()
    expect(api.aiProposalReject).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.turn-proposal')).toBeNull()
  })
})
