/**
 * An AI run held as a proposal, end to end without a model: the real AgentLoop runs a
 * scripted conversation against the real hwp skill and plugin over a real rhwp document,
 * whose editor history (undo and redo) is modelled by snapshots as the editor records a
 * plugin transaction. The document is compared byte for byte.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import {
  AgentLoop,
  type AgentMessage,
  type AgentStreamCallbacks,
  type AgentTransport,
} from '@genoffice/agent-core'
import { agentPlugin, type AgentPluginHost } from '../studio-plugin/agent-plugin.mjs'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { createHwpSkill, type HwpChange } from '../src/renderer/ai/hwp-skill'
import { accept, holdRun, reject, type TurnProposal } from '../src/renderer/ai/turn-proposal'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const LINES = ['제목', '첫째 문단입니다.', '둘째 문단입니다.', '끝 문단입니다.']

interface TestEditor {
  bridge: AgentBridge
  bytes(): Uint8Array
  lines(): string[]
  /** an edit that is not the plugin's: what the person typing does */
  typeIn(): void
  /** something changed the document without a step in the history */
  outsideEdit(): void
}

/** A document of four paragraphs behind a host whose history can undo and redo. */
function openEditor(): TestEditor {
  let doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  LINES.forEach((line, index) => {
    if (index > 0) doc.splitParagraph(0, index - 1, doc.getParagraphLength(0, index - 1))
    doc.insertText(0, index, 0, line)
  })
  // what a save and a reopen leave is the state every comparison starts from
  doc = new HwpDocument(doc.exportHwp())

  const undoStack: Uint8Array[] = []
  const redoStack: Uint8Array[] = []
  const listeners: (() => void)[] = []
  const emit = () => listeners.forEach((listener) => listener())
  const host = {
    read: (fn: (d: never) => unknown) => fn(doc as never),
    transaction: (_label: string, fn: (tx: never) => unknown) => {
      const before = doc.exportHwp()
      try {
        const result = fn({ doc: () => doc, deferPagination: () => {} } as never)
        undoStack.push(before)
        // a new change ends what could be redone
        redoStack.length = 0
        emit()
        return result
      } catch (thrown) {
        doc = new HwpDocument(before)
        throw thrown
      }
    },
    events: { on: (_name: string, handler: () => void) => listeners.push(handler) },
    automation: {
      execute: (command: string) => {
        if (command === 'edit:undo') {
          const before = undoStack.pop()
          if (!before) return { ok: false }
          redoStack.push(doc.exportHwp())
          doc = new HwpDocument(before)
          emit()
          return { ok: true }
        }
        if (command === 'edit:redo') {
          const after = redoStack.pop()
          if (!after) return { ok: false }
          undoStack.push(doc.exportHwp())
          doc = new HwpDocument(after)
          emit()
          return { ok: true }
        }
        return null
      },
    },
  } as unknown as AgentPluginHost

  const plugin = agentPlugin.activate(host)
  // the bridge calls the plugin by method name, as the editor frame does
  const methods = plugin as unknown as Record<string, (...rest: unknown[]) => unknown>
  const bridge = new Proxy({} as AgentBridge, {
    get: (_target, method) =>
      typeof method === 'string'
        ? async (...args: unknown[]) => methods[method]!(...args)
        : undefined,
  })
  return {
    bridge,
    bytes: () => doc.exportHwp(),
    lines: () =>
      plugin
        .readText()
        .split(/\r?\n/)
        .filter((line) => line.length > 0),
    typeIn: () => {
      host.transaction('typing', () => doc.insertText(0, 0, 0, '손으로 '))
    },
    outsideEdit: () => emit(),
  }
}

type ToolCall = { name: string; input: Record<string, unknown> }

/** a transport that plays one tool-calling turn and then a closing reply */
function scriptedTransport(calls: ToolCall[]): AgentTransport {
  const script: Array<(cb: AgentStreamCallbacks) => void> = [
    (cb) => {
      calls.forEach((call, index) => cb.onToolCall({ id: `t${index}`, ...call }))
      cb.onDone()
    },
    (cb) => {
      cb.onDelta('Done.')
      cb.onDone()
    },
  ]
  let turn = 0
  return {
    stream(_request: { system: string; messages: AgentMessage[]; tools: unknown[] }, cb) {
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
}

/** One request of the person, run the way the panel runs it; settles when the loop ends. */
async function runRequest(editor: TestEditor, calls: ToolCall[]) {
  const items: HwpChange[] = []
  const hwp = createHwpSkill({
    bridge: editor.bridge,
    label: (key) => key,
    onChange: (change) => items.push(change),
    confirmMemoRemoval: async () => false,
  })
  const foreign = await editor.bridge.foreignChanges()
  await hwp.refreshContext()
  hwp.beginRun()
  const finished = Promise.withResolvers<void>()
  const loop = new AgentLoop({
    transport: scriptedTransport(calls),
    skill: hwp.skill,
    events: {
      onDone: () => finished.resolve(),
      onError: (message) => finished.reject(new Error(message)),
    },
  })
  loop.run('고쳐 주세요')
  await finished.promise
  return { items, foreign, live: editor.bytes() }
}

const EDITS: ToolCall[] = [
  { name: 'replace_text', input: { find: '첫째 문단', replace: '첫 번째 문단' } },
  {
    name: 'insert_paragraphs',
    input: { anchor: '둘째 문단입니다.', where: 'after', paragraphs: ['새로 넣은 문단입니다.'] },
  },
  { name: 'replace_all', input: { find: '입니다', replace: '이에요' } },
]

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

/** a run over the document, taken back out and held, with the states a test compares */
async function heldRun() {
  const editor = openEditor()
  const original = editor.bytes()
  const run = await runRequest(editor, EDITS)
  const proposal = await holdRun(editor.bridge, run.items.length, run.foreign)
  return { editor, original, run, proposal }
}

describe('an AI run held as a proposal', () => {
  it('edits the live document during the run and leaves it as it was when the run ends', async () => {
    const { editor, original, run, proposal } = await heldRun()
    expect(run.items).toHaveLength(EDITS.length)
    // the run really changed the document: this is not a vacuous comparison
    expect(same(run.live, original)).toBe(false)
    expect(proposal).toMatchObject({ kind: 'pending', steps: EDITS.length })
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.lines()).toEqual(LINES)
  })

  it('puts exactly the run back when it is accepted, and the run can then be undone as before', async () => {
    const { editor, original, run, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome.kind).toBe('applied')
    expect(same(editor.bytes(), run.live)).toBe(true)
    expect(editor.lines()).toContain('새로 넣은 문단이에요.')

    // the panel's undo of an applied run, with the count the accept handed back
    if (outcome.kind !== 'applied') return
    expect(await editor.bridge.undo(run.items.length, outcome.foreign)).toMatchObject({ ok: true })
    expect(same(editor.bytes(), original)).toBe(true)
  })

  it('leaves the document as it was when it is rejected', async () => {
    const { editor, original, proposal } = await heldRun()
    expect(proposal.kind).toBe('pending')
    expect(reject()).toEqual({ kind: 'none' })
    expect(same(editor.bytes(), original)).toBe(true)
  })

  it('refuses to accept after the person typed, and leaves their document alone', async () => {
    const { editor, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    editor.typeIn()
    const typed = editor.bytes()
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome).toEqual({ kind: 'stale', proposal: { kind: 'stale', steps: EDITS.length } })
    expect(same(editor.bytes(), typed)).toBe(true)
  })

  it('refuses to accept after a change the editor history does not show, too', async () => {
    const { editor, proposal } = await heldRun()
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    // the redo stack is intact here: only the plugin's foreign count says the document moved
    editor.outsideEdit()
    const before = editor.bytes()
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome.kind).toBe('stale')
    expect(same(editor.bytes(), before)).toBe(true)
  })

  it('does not hold a run when the document was changed while it ran, and keeps its edits', async () => {
    const editor = openEditor()
    const run = await runRequest(editor, EDITS)
    editor.outsideEdit()
    const proposal: TurnProposal = await holdRun(editor.bridge, run.items.length, run.foreign)
    expect(proposal).toEqual({ kind: 'none' })
    expect(same(editor.bytes(), run.live)).toBe(true)
  })
})
