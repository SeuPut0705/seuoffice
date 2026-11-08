/**
 * AI edit review: an AI run drives the real AgentLoop and the real slides skill against a
 * real session (the actual main-process IPC handlers), and its edits are held as a proposal.
 */
import { tmpdir } from 'node:os'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
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
  nativeImage: {},
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import {
  AgentLoop,
  type AgentStreamCallbacks,
  type AgentToolCall,
  type AgentTransport,
} from '@genoffice/agent-core'
import { createBlankPptx, openPptx, type Slide } from '@genoffice/pptx-engine'
import type { RenderSlide } from '@genoffice/pptx-render'
import { applySessionTxn, registerSlidesIpc } from '../src/main/slides-main'
import {
  buildAllRenderSlides,
  carryHistoryForReplacement,
  pushHistory,
  sessions,
  takeSnapshot,
  type Session,
} from '../src/main/session-state'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import {
  NO_PROPOSAL,
  accept,
  holdRun,
  reject,
  slidesApiBackend,
  type ProposalState,
} from '../src/renderer/ai/turn-proposal'

const WC = 1
const event = { sender: { id: WC } } as never
const FIT_WIDTH = 1280

function ipc(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return (fn as (...a: unknown[]) => unknown)(event, ...args)
}

/** One scripted model turn per entry; a turn may call tools */
function scriptedTransport(script: Array<(cb: AgentStreamCallbacks) => void>): AgentTransport {
  let turn = 0
  return {
    stream(_request, cb) {
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
}

const toolTurn = (...calls: AgentToolCall[]) => {
  return (cb: AgentStreamCallbacks) => {
    for (const call of calls) cb.onToolCall(call)
    cb.onDone()
  }
}
const finalTurn = (cb: AgentStreamCallbacks) => {
  cb.onDelta('Done.')
  cb.onDone()
}

const editTitleScript = (id: string): AgentToolCall => ({
  id: 'edit',
  name: 'execute_slide_script',
  input: { slideIndex: 0, code: `setText(${JSON.stringify(id)}, 'Edited by the AI')` },
})
const addSlideOp: AgentToolCall = {
  id: 'add',
  name: 'apply_ops',
  input: { ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] },
}

let session: Session
/** The editor's slides, as the panel keeps them while a run edits the deck */
let editor: RenderSlide[]

function access(extra: Partial<DeckAccess> = {}): DeckAccess {
  return {
    getSlides: () => editor,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: (i: number, updated: RenderSlide) => {
      editor = editor.map((s, k) => (k === i ? updated : s))
    },
    applyDeck: (all: RenderSlide[]) => {
      editor = all
    },
    fitWidthPx: FIT_WIDTH,
    deckHasPath: () => !!session.path,
    ...extra,
  } as unknown as DeckAccess
}

interface ToolResult {
  output: string
  isError?: boolean
}

/** The panel's run lifecycle around a real AgentLoop run; returns the tool results the run got */
async function runAi(
  script: Array<(cb: AgentStreamCallbacks) => void>,
  extra: Partial<DeckAccess> = {},
): Promise<ToolResult[]> {
  const api = window.slidesApi
  if (await api.beginHistoryBatch()) await api.aiRunBegin()
  const results: ToolResult[] = []
  await new Promise<void>((resolve, reject) => {
    const loop = new AgentLoop({
      transport: scriptedTransport(script),
      skill: createSlidesSkill(access(extra)),
      events: {
        onToolExecuted: ({ execution }) => results.push(execution),
        onDone: () => resolve(),
        onError: (e) => reject(new Error(e)),
      },
    })
    loop.run('Change the deck')
  })
  await api.endHistoryBatch()
  return results
}

/** The id the model sees for the first text element (durable id, else source id) */
function firstTextId(): string {
  const node = editor[0]!.nodes.find((n) => 'text' in n && n.text)
  const id = node?.durableId ?? node?.sourceId
  if (!id) throw new Error('fixture has no text element')
  return id
}

/** Full deck state: every slide, the archive entries (bytes) and the slide size */
interface DeckState {
  slides: Slide[]
  entries: Map<string, Uint8Array>
  size: { cx: number; cy: number }
}
const deckState = (): DeckState => {
  const { slides, entries, size } = takeSnapshot(session)
  return { slides, entries, size }
}

beforeAll(() => {
  // registerSlidesIpc is guarded by a module-level flag, so it must run exactly once
  registerSlidesIpc()
})

beforeEach(async () => {
  sessions.clear()
  session = {
    path: '',
    fitWidthPx: FIT_WIDTH,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(WC, session)
  // A deck with real content (the from-scratch guard stays out of the way) and some history
  const box = (y: number, text: string) => ({
    op: 'addElement',
    target: { slide: 0 },
    kind: 'textbox',
    offset: { x: 600000, y, cx: 6000000, cy: 800000 },
    paragraphs: [{ runs: [{ text }] }],
  })
  const seeded = applySessionTxn(session, {
    ops: [box(400000, 'Title'), box(1600000, 'First point'), box(2800000, 'Second point')],
  })
  expect(seeded?.failures ?? []).toEqual([])
  expect(seeded?.applied).toBe(true)
  editor = buildAllRenderSlides(session.opened, FIT_WIDTH)

  vi.stubGlobal('window', {
    slidesApi: {
      applyTxn: (op: unknown) => ipc('slides:apply-txn', op),
      applyEditScript: (op: unknown) => ipc('slides:apply-edit-script', op),
      beginHistoryBatch: () => ipc('slides:history-batch-begin'),
      endHistoryBatch: () => ipc('slides:history-batch-end'),
      aiRunBegin: () => ipc('slides:ai-run-begin'),
      aiRunHold: () => ipc('slides:ai-run-hold'),
      aiProposalAccept: () => ipc('slides:ai-proposal-accept'),
      aiProposalReject: () => ipc('slides:ai-proposal-reject'),
      aiSnapshotRestore: (id: number) => ipc('slides:ai-snapshot-restore', id),
      undo: () => ipc('slides:undo'),
    },
  })
})

const backend = () => slidesApiBackend(window.slidesApi)

describe('AI edit review', () => {
  async function heldRun(): Promise<{
    before: DeckState
    live: DeckState
    state: ProposalState
  }> {
    const before = deckState()
    const results = await runAi([toolTurn(editTitleScript(firstTextId()), addSlideOp), finalTurn])
    expect(results.filter((r) => r.isError).map((r) => r.output)).toEqual([])
    const live = deckState()
    // the run really edited the deck while it ran
    expect(live).not.toEqual(before)
    expect(editor.length).toBe(2)
    const held = await holdRun(backend(), editor)
    return { before, live, state: held.state }
  }

  it('puts the deck back to its pre-run state when the run ends', async () => {
    const undoStackBefore = [...session.undoStack]
    const { before, state } = await heldRun()
    expect(deckState()).toEqual(before)
    expect(session.undoStack).toEqual(undoStackBefore)
    expect(session.redoStack).toEqual([])
    expect(state.kind).toBe('pending')
    if (state.kind !== 'pending') return
    // the proposal names the slides the run touched: the edited first slide and the new one
    expect(state.changes.map((c) => [!!c.before, !!c.after])).toEqual([
      [true, true],
      [false, true],
    ])
  })

  it('accept applies exactly what the run produced, as one undo step', async () => {
    const { before, live, state } = await heldRun()
    const undoDepth = session.undoStack.length
    const result = await accept(state, backend())
    expect(result.state).toEqual(NO_PROPOSAL)
    expect(result.deck).toHaveLength(2)
    expect(deckState()).toEqual(live)
    expect(session.undoStack).toHaveLength(undoDepth + 1)
    // the reply's existing undo control and Ctrl+Z both lead back to the pre-run deck
    await window.slidesApi.undo()
    expect(deckState()).toEqual(before)
  })

  it('accept keeps the reply rollback control working', async () => {
    const { before, live, state } = await heldRun()
    const result = await accept(state, backend())
    expect(deckState()).toEqual(live)
    const restored = await window.slidesApi.aiSnapshotRestore(result.snapshotId!)
    expect(restored).toHaveLength(1)
    expect(deckState()).toEqual(before)
  })

  it('reject leaves the pre-run deck and drops the proposal', async () => {
    const { before, state } = await heldRun()
    const next = await reject(state, backend())
    expect(next).toEqual(NO_PROPOSAL)
    expect(deckState()).toEqual(before)
    expect(session.aiProposal).toBeUndefined()
    // nothing is left to accept
    expect((await accept(state, backend())).state.kind).toBe('stale')
    expect(deckState()).toEqual(before)
  })

  it('accept refuses once the deck changed after the revert, and leaves the deck alone', async () => {
    const { before, state } = await heldRun()
    // the person edits the deck while the proposal is pending
    const edited = applySessionTxn(session, {
      ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
    })
    expect(edited?.applied).toBe(true)
    const afterEdit = deckState()
    expect(afterEdit).not.toEqual(before)

    const result = await accept(state, backend())
    expect(result.state.kind).toBe('stale')
    expect(result.deck).toBeNull()
    expect(deckState()).toEqual(afterEdit)
    // a stale proposal stays until the person dismisses it
    expect(session.aiProposal).toBeDefined()
    expect(await reject(result.state, backend())).toEqual(NO_PROPOSAL)
    expect(session.aiProposal).toBeUndefined()
  })

  it('accept also refuses after the person undid something', async () => {
    const { state } = await heldRun()
    await window.slidesApi.undo()
    const afterUndo = deckState()
    const result = await accept(state, backend())
    expect(result.state.kind).toBe('stale')
    expect(deckState()).toEqual(afterUndo)
  })

  it('a run that changed nothing holds nothing', async () => {
    const before = deckState()
    await runAi([
      toolTurn({
        id: 'noop',
        name: 'apply_ops',
        input: { ops: [{ op: 'setText', target: { slide: 0, el: 'nope' }, paragraphs: [] }] },
      }),
      finalTurn,
    ])
    const held = await holdRun(backend(), editor)
    expect(held.state).toEqual(NO_PROPOSAL)
    expect(held.deck).toBeNull()
    expect(deckState()).toEqual(before)
  })

  it('generate_deck refuses to replace a deck that is a file on disk, and changes nothing', async () => {
    session.path = '/tmp/existing.pptx'
    const before = deckState()
    const generated = vi.fn()
    const results = await runAi(
      [
        toolTurn({
          id: 'gen',
          name: 'generate_deck',
          input: { topic: 'Quarterly review', insert_mode: 'replace' },
        }),
        finalTurn,
      ],
      {
        generatePageLocal: generated,
        landGeneratedPages: generated,
      } as Partial<DeckAccess>,
    )
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.output).toContain('insert_mode:"append"')
    expect(generated).not.toHaveBeenCalled()
    expect(deckState()).toEqual(before)
    const held = await holdRun(backend(), editor)
    expect(held.state).toEqual(NO_PROPOSAL)
    expect(session.aiProposal).toBeUndefined()
  })

  it('holds a run even when the undo history is full', async () => {
    for (let i = 0; i < 60; i++) pushHistory(session)
    expect(session.undoStack).toHaveLength(50)
    const { before, state } = await heldRun()
    expect(state.kind).toBe('pending')
    expect(deckState()).toEqual(before)
    expect(session.undoStack).toHaveLength(50)
  })

  describe('a run that replaces the whole deck (generate_deck replace mode)', () => {
    async function replaceDeck(): Promise<void> {
      const replacement: Session = {
        path: '',
        fitWidthPx: FIT_WIDTH,
        undoStack: [],
        redoStack: [],
        opened: await openPptx(await createBlankPptx()),
      }
      applySessionTxn(replacement, { ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] })
      carryHistoryForReplacement(session, replacement)
      sessions.set(WC, replacement)
      session = replacement
    }

    it('holds the replacement of an untitled deck and restores the old deck on reject', async () => {
      const before = deckState()
      const api = window.slidesApi
      await api.beginHistoryBatch()
      await api.aiRunBegin()
      await replaceDeck()
      expect(deckState()).not.toEqual(before)
      await api.endHistoryBatch()
      const held = await holdRun(backend(), editor)
      expect(held.state.kind).toBe('pending')
      expect(deckState()).toEqual(before)
      await reject(held.state, backend())
      expect(deckState()).toEqual(before)
    })

    it('leaves a replaced file-backed deck as it is (the replacement is a new untitled draft)', async () => {
      session.path = '/tmp/existing.pptx'
      const api = window.slidesApi
      await api.beginHistoryBatch()
      await api.aiRunBegin()
      await replaceDeck()
      const replaced = deckState()
      await api.endHistoryBatch()
      const held = await holdRun(backend(), editor)
      expect(held.state).toEqual(NO_PROPOSAL)
      expect(deckState()).toEqual(replaced)
    })
  })
})
