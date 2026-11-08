/**
 * A scripted AI run over a real rhwp document, without a model: the real AgentLoop plays a
 * conversation against the real hwp skill and plugin. The editor's history (undo and redo) is
 * modelled by snapshots, one per plugin transaction, and its edit gate by the check the studio's
 * patched `isOperationAllowedInEditMode` makes: a person's edit asks the plugin whether a run
 * holds the document. Documents are compared byte for byte.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import {
  AgentLoop,
  type AgentMessage,
  type AgentStreamCallbacks,
  type AgentTransport,
} from '@genoffice/agent-core'
import {
  REDO_GATE,
  RUN_LOCK_GATE,
  agentPlugin,
  type AgentPluginHost,
} from '../studio-plugin/agent-plugin.mjs'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { createHwpSkill, type HwpChange } from '../src/renderer/ai/hwp-skill'
import type { RunHold } from '../src/renderer/ai/turn-proposal'

const require = createRequire(import.meta.url)

/** Loads the engine once per test file. */
export function useEngine(): void {
  beforeAll(async () => {
    const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
    await init({ module_or_path: readFileSync(wasm) })
  })
}

export const LINES = ['제목', '첫째 문단입니다.', '둘째 문단입니다.', '끝 문단입니다.']

export interface TestEditor {
  bridge: AgentBridge
  bytes(): Uint8Array
  lines(): string[]
  /** how many changes the engine's undo store lets one run take back out whole */
  runLimit(): number
  /** how many steps the editor's history holds now */
  historyDepth(): number
  /** what the person typing does, through the studio's edit gate; false when the gate refused it */
  typeIn(): boolean
  /** the person's redo (Ctrl+Y, the menu): the studio's handleRedo, which asks the plugin first */
  redoByPerson(): void
  /** something changed the document without a step in the history */
  outsideEdit(): void
}

/** A document of four paragraphs behind a host whose history can undo and redo. */
export function openEditor(): TestEditor {
  let doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  LINES.forEach((line, index) => {
    if (index > 0) doc.splitParagraph(0, index - 1, doc.getParagraphLength(0, index - 1))
    doc.insertText(0, index, 0, line)
  })
  // what a save and a reopen leave is the state every comparison starts from
  doc = new HwpDocument(doc.exportHwp())

  // The editor's undo store holds a bounded number of snapshots (two per step: before and
  // after) and drops the oldest past `capacity - 2`: the rule the plugin's run limit assumes.
  const historyLimit = Math.floor((doc.snapshotCapacity() - 2) / 2)
  const undoStack: Uint8Array[] = []
  const redoStack: Uint8Array[] = []
  const listeners: (() => void)[] = []
  const emit = () => listeners.forEach((listener) => listener())
  const host = {
    read: (fn: (d: never) => unknown) => fn(doc as never),
    transaction: (_label: string, fn: (tx: never) => unknown) => {
      // the studio's one gate for edits (patch studio-ai-run-lock): refused before anything runs
      const blocked = (globalThis as Record<string, unknown>)[RUN_LOCK_GATE] as
        (() => boolean) | undefined
      if (blocked?.() === true) throw new Error('the edit mode refuses this edit')
      const before = doc.exportHwp()
      try {
        const result = fn({ doc: () => doc, deferPagination: () => {} } as never)
        undoStack.push(before)
        // the oldest step falls off a full store, and can no longer be undone
        while (undoStack.length > historyLimit) undoStack.shift()
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
      getContext: () => ({ canRedo: redoStack.length > 0 }),
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
    runLimit: () => historyLimit,
    historyDepth: () => undoStack.length,
    typeIn: () => {
      try {
        host.transaction('typing', () => doc.insertText(0, 0, 0, '손으로 '))
        return true
      } catch {
        return false
      }
    },
    redoByPerson: () => {
      // the studio's handleRedo, patched (studio-ai-run-lock): refused while the plugin says so
      const blocked = (globalThis as Record<string, unknown>)[REDO_GATE] as
        (() => boolean) | undefined
      if (blocked?.() === true) return
      const after = redoStack.pop()
      if (!after) return
      undoStack.push(doc.exportHwp())
      doc = new HwpDocument(after)
      emit()
    },
    outsideEdit: () => emit(),
  }
}

export type ToolCall = { name: string; input: Record<string, unknown> }

/** a transport that plays one tool-calling turn, waits for `midRun`, then closes with a reply */
function scriptedTransport(calls: ToolCall[], midRun: () => Promise<void>): AgentTransport {
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
      // the second request is made after the tools of the first have run: the run is in flight
      if (step) {
        queueMicrotask(() => {
          void (turn === 2 ? midRun() : Promise.resolve()).then(() => step(cb))
        })
      }
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
}

export interface RunOptions {
  /**
   * Takes the document the way the panel does before the run starts (begin, lock, read the
   * count), and is the one the test later holds the run with.
   */
  hold?: RunHold
  /** called while the run is in flight, after its tools have changed the document */
  midRun?: (run: { items: HwpChange[]; foreign: number }) => Promise<void>
}

/** One request of the person, run the way the panel runs it; settles when the loop ends. */
export async function runRequest(editor: TestEditor, calls: ToolCall[], options: RunOptions = {}) {
  const items: HwpChange[] = []
  const hwp = createHwpSkill({
    bridge: editor.bridge,
    label: (key) => key,
    onChange: (change) => items.push(change),
    confirmMemoRemoval: async () => false,
  })
  let foreign: number
  if (options.hold) {
    const generation = options.hold.begin()
    foreign = await options.hold.lock(generation)
  } else {
    foreign = await editor.bridge.foreignChanges()
  }
  await hwp.refreshContext()
  hwp.beginRun()
  const finished = Promise.withResolvers<void>()
  const loop = new AgentLoop({
    transport: scriptedTransport(calls, async () => options.midRun?.({ items, foreign })),
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

export const EDITS: ToolCall[] = [
  { name: 'replace_text', input: { find: '첫째 문단', replace: '첫 번째 문단' } },
  {
    name: 'insert_paragraphs',
    input: { anchor: '둘째 문단입니다.', where: 'after', paragraphs: ['새로 넣은 문단입니다.'] },
  },
  { name: 'replace_all', input: { find: '입니다', replace: '이에요' } },
]

export const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))
