// @vitest-environment jsdom
/**
 * An AI run's edits never land without a yes, and the person's own edits never meet the run.
 * Against the real hwp skill and plugin over a real rhwp document (see ai-run-harness.ts):
 * while a run is in flight no save writes the document, the person cannot edit, and a run
 * too large to be taken back out is refused before it applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentStreamCallbacks } from '@genoffice/agent-core'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { t } from '../src/renderer/i18n/locale'
import { createAiHoldWiring, runPrintJob } from '../src/renderer/print-flow'
import { fakeProjectFolder } from './fake-project-folder'
import { runSave, type SaveEditorPort, type SaveOutcome } from '../src/renderer/save-flow'
import {
  RunHold,
  StrandedError,
  accept,
  reject,
  type HoldState,
  type RunBackend,
} from '../src/renderer/ai/turn-proposal'
import type { HwpApi } from '../src/shared/ipc'
import {
  EDITS,
  LINES,
  openEditor,
  runRequest,
  same,
  useEngine,
  type TestEditor,
} from './ai-run-harness'

useEngine()

/**
 * The model of the panel tests: the first request edits the document through tool calls, and
 * the next one never answers, so the run stays in flight.
 */
const transport = vi.hoisted(() => ({ streams: 0, finish: false }))
vi.mock('../src/renderer/ai/transport', () => ({
  createElectronTransport: () => ({
    stream: (_request: unknown, callbacks: AgentStreamCallbacks) => {
      transport.streams += 1
      if (transport.streams === 1) {
        setTimeout(() => {
          callbacks.onToolCall({
            id: 't0',
            name: 'insert_paragraphs',
            input: { anchor: '끝 문단입니다.', where: 'after', paragraphs: ['AI가 넣은 문단'] },
          })
          callbacks.onDone()
        }, 0)
      }
      if (transport.streams > 1 && transport.finish) {
        setTimeout(() => {
          callbacks.onDelta('Done.')
          callbacks.onDone()
        }, 0)
      }
      return { cancel: () => undefined }
    },
  }),
}))

let container: HTMLElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => undefined
  transport.streams = 0
  transport.finish = false
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container = null
  document.body.replaceChildren()
  delete (window as unknown as Record<string, unknown>).hwpApi
  delete (window as unknown as Record<string, unknown>).projectApi
  delete (window as unknown as Record<string, unknown>).projectFolderApi
  vi.unstubAllGlobals()
})

async function settle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The AI panel over `bridge`, with the app's side (the hold state) and the buttons a person presses. */
async function mountPanel(bridge: AgentBridge) {
  const settings = defaultAiSettings()
  const keyed = {
    ...settings,
    provider: 'openai' as const,
    providers: { ...settings.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
  }
  Object.assign(window, {
    hwpApi: {
      getAiSettings: async () => keyed,
      setAiSettings: async () => undefined,
      onAiSettingsChanged: () => () => undefined,
      openAiModelSettings: async () => undefined,
      setAiPanelPrefs: async () => ({}),
      pickAttachments: async () => ({ accepted: [], rejected: [] }),
      addAttachmentPaths: async () => ({ accepted: [], rejected: [] }),
      addPastedImage: async () => ({ accepted: [], rejected: [] }),
      getPathForFile: () => '',
      readAttachmentImage: async () => ({ ok: false }),
      aiToolCapabilities: async () => ({ imageGeneration: { available: false } }),
    },
    projectApi: {
      resolveChat: async () => ({ projectId: 'doc-store', chatId: 'doc-chat' }),
      loadChat: async () => [],
      appendChat: async () => undefined,
      rebindChat: async () => null,
    },
    projectFolderApi: fakeProjectFolder(null).api,
  })
  // the panel lives in its own frame, as in the app: the editor's run lock blocks the input
  // events of the editor's window only, never the panel's
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const panelWindow = frame.contentWindow as unknown as Window & typeof globalThis
  panelWindow.Element.prototype.scrollTo = () => undefined
  container = panelWindow.document.createElement('div')
  panelWindow.document.body.appendChild(container)
  const held: HoldState[] = []
  const listeners: ((state: HoldState) => void)[] = []
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(AiPanel, {
        bridge,
        filePath: null,
        onCollapse: () => undefined,
        onRunHold: (state: HoldState) => {
          held.push(state)
          for (const listener of listeners) listener(state)
        },
      }),
    )
  })
  await settle()
  return {
    held,
    /** the app's side: told of every hold change besides the log */
    onRunHold: (listener: (state: HoldState) => void) => listeners.push(listener),
    /** a starter fills the input; the send button sends it */
    async send() {
      const box = container!
      const starter = box.querySelector<HTMLButtonElement>('.ai-starter')
      if (starter) await act(async () => starter.click())
      await act(async () => {
        box.querySelector<HTMLButtonElement>('.ai-send-btn:not(.ai-stop-btn)')!.click()
      })
      await settle()
    },
    async newChat() {
      await act(async () => {
        container!
          .querySelector<HTMLButtonElement>(`button[aria-label="${t('aiNewChat')}"]`)!
          .click()
      })
      await settle()
    },
  }
}

/** the panel's side of a run: the state the app's saves read, and the hold over the document */
function takeHold(editor: TestEditor, backend: RunBackend = editor.bridge as RunBackend) {
  const flag = { held: false, state: 'free' as HoldState }
  const hold = new RunHold(
    () => backend,
    (state) => {
      flag.state = state
      flag.held = state !== 'free'
    },
  )
  return { flag, hold }
}

/** The editor and the main process a save talks to; what they were asked to write is recorded. */
function savePorts(editor: TestEditor) {
  const written: Uint8Array[] = []
  const exports: Uint8Array[] = []
  const port: SaveEditorPort = {
    isPasswordProtected: async () => false,
    exportHwp: async () => {
      // the editor takes its messages in order: the bytes are what it holds when this is posted
      const bytes = editor.bytes()
      exports.push(bytes)
      return bytes
    },
    exportHwpx: async () => editor.bytes(),
    exportHwpVerify: async () => ({ pageCountBefore: 1, pageCountAfter: 1, recovered: true }),
    listMemos: async () => [],
    setMemoLock: async () => ({ ok: true }),
    measureTabs: async () => [],
    notifySaved: async () => undefined,
  }
  const api = {
    beginSave: vi.fn(async () => ({ ok: true as const, path: '/doc.hwp', format: 'hwp' as const })),
    newTabs: vi.fn(async () => []),
    commitSave: vi.fn(async (bytes: Uint8Array) => {
      written.push(bytes)
      return { ok: true as const, path: '/doc.hwp' }
    }),
    abortSave: vi.fn(),
  }
  return {
    port,
    api: api as unknown as Pick<HwpApi, 'beginSave' | 'newTabs' | 'commitSave' | 'abortSave'>,
    spies: api,
    written,
    exports,
  }
}

describe('a save while an AI run is in flight', () => {
  it('writes nothing, and the save after the run is held writes the document as it was', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const { flag, hold } = takeHold(editor)
    const ports = savePorts(editor)
    let refused: SaveOutcome | null = null

    const run = await runRequest(editor, EDITS, {
      hold,
      midRun: async () => {
        // the run's edits are in the live document: a save now would write them
        expect(same(editor.bytes(), original)).toBe(false)
        refused = await runSave(ports.port, ports.api, 'save', false, () => flag.held)
      },
    })

    expect(refused).toEqual({ kind: 'failed', reason: 'ai' })
    expect(ports.spies.commitSave).not.toHaveBeenCalled()
    expect(ports.spies.abortSave).toHaveBeenCalledTimes(1)
    expect(ports.exports).toHaveLength(0)

    // the run is taken out of the document, and then the app may write again
    expect((await hold.hold(run.foreign)).kind).toBe('pending')
    expect(flag.held).toBe(false)
    const saved = await runSave(ports.port, ports.api, 'save', false, () => flag.held)
    expect(saved.kind).toBe('saved')
    expect(ports.written).toHaveLength(1)
    expect(same(ports.written[0]!, original)).toBe(true)
  })

  it('writes the document as it was when the export was asked for before the run began', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const { flag, hold } = takeHold(editor)
    const ports = savePorts(editor)
    // the export is posted (and so reads the document) now, and answers only later
    const exportPosted = Promise.withResolvers<void>()
    const exportAnswers = Promise.withResolvers<void>()
    const exportHwp = ports.port.exportHwp
    ports.port.exportHwp = async () => {
      const bytes = await exportHwp()
      exportPosted.resolve()
      await exportAnswers.promise
      return bytes
    }

    const saving = runSave(ports.port, ports.api, 'save', false, () => flag.held)
    await exportPosted.promise
    const run = await runRequest(editor, EDITS, { hold })
    expect(same(run.live, original)).toBe(false)
    exportAnswers.resolve()

    expect((await saving).kind).toBe('saved')
    expect(ports.written).toHaveLength(1)
    expect(same(ports.written[0]!, original)).toBe(true)
  })

  it('is refused when the run takes the document while the memo list is read for a HWPX', async () => {
    const editor = openEditor()
    const { flag, hold } = takeHold(editor)
    const ports = savePorts(editor)
    ports.spies.beginSave.mockImplementation(async () => ({
      ok: true as const,
      path: '/doc.hwpx',
      format: 'hwpx' as const,
    }))
    ports.port.listMemos = async () => {
      hold.begin()
      return []
    }

    const outcome = await runSave(ports.port, ports.api, 'saveAs', false, () => flag.held)
    expect(outcome).toEqual({ kind: 'failed', reason: 'ai' })
    expect(ports.spies.commitSave).not.toHaveBeenCalled()
    hold.release()
  })
})

describe('the person editing while an AI run is in flight', () => {
  const fire = (name: string) => {
    const event = new Event(name, { bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event
  }

  it('is refused: the typing is not made, and after a reject the document is the one before the run', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const { hold } = takeHold(editor)
    let during: Uint8Array | null = null
    let typed: boolean | null = null

    const run = await runRequest(editor, EDITS, {
      hold,
      midRun: async () => {
        during = editor.bytes()
        typed = editor.typeIn()
        // the memo panel is the person's too
        const memo = await editor.bridge.insertMemo(
          { place: 'body', sectionIndex: 0, paraIndex: 1, startCharIdx: 0, endCharIdx: 2 } as never,
          'person',
          'a note',
        )
        expect(memo).toEqual({ ok: false, reason: 'edit_locked' })
        expect(same(editor.bytes(), during)).toBe(true)
      },
    })

    expect(typed).toBe(false)
    expect(same(run.live, during!)).toBe(true)
    // the run was held with nothing of the person's in it
    const proposal = await hold.hold(run.foreign)
    expect(proposal.kind).toBe('pending')
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.lines()).toEqual(LINES)
  })

  it('keeps what the person did before the run: the run is held on top of it', async () => {
    const editor = openEditor()
    expect(editor.typeIn()).toBe(true)
    const withTyping = editor.bytes()
    const { hold } = takeHold(editor)

    const run = await runRequest(editor, EDITS, { hold })
    const proposal = await hold.hold(run.foreign)

    expect(proposal.kind).toBe('pending')
    expect(same(editor.bytes(), withTyping)).toBe(true)
    expect(editor.lines()[0]).toBe('손으로 제목')
  })

  it('stops the input events of the editor frame, and lets them through once the run is held', async () => {
    const editor = openEditor()
    const { hold } = takeHold(editor)
    const typing = [
      'keydown',
      'beforeinput',
      'paste',
      'cut',
      'drop',
      'pointerdown',
      'mousedown',
      'click',
    ]
    const seen: Record<string, boolean> = {}
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(document.activeElement).toBe(field)

    const run = await runRequest(editor, EDITS, {
      hold,
      midRun: async () => {
        for (const name of typing) seen[name] = fire(name).defaultPrevented
        // a composition in progress does not go on
        expect(document.activeElement).not.toBe(field)
      },
    })
    for (const name of typing) expect(seen[name], name).toBe(true)

    await hold.hold(run.foreign)
    for (const name of typing) expect(fire(name).defaultPrevented, name).toBe(false)
    // and the document takes the person's typing again
    expect(editor.typeIn()).toBe(true)
    // and the caret is where they left it
    expect(document.activeElement).toBe(field)
  })

  it('has the run dropped when "new chat" is pressed in the middle of it, through the real panel', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const panel = await mountPanel(editor.bridge)
    await panel.send()
    // the run's edits are in the live document and the model has not finished
    await vi.waitFor(() => expect(same(editor.bytes(), original)).toBe(false))
    expect(panel.held.at(-1)).toBe('held')
    expect(editor.typeIn()).toBe(false)

    await panel.newChat()
    await vi.waitFor(() => expect(panel.held.at(-1)).toBe('free'))

    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.typeIn()).toBe(true)
  })

  it('does not start a new run before the dropped one is out of the document, and a late release does not free the new one', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    // the editor's undo of the dropped run comes late
    const undone = Promise.withResolvers<void>()
    const slowUndo = new Proxy(editor.bridge, {
      get: (bridge, method) =>
        method === 'undo'
          ? async (...args: Parameters<typeof bridge.undo>) => {
              await undone.promise
              return bridge.undo(...args)
            }
          : bridge[method as keyof typeof bridge],
    })
    const panel = await mountPanel(slowUndo)
    await panel.send()
    await vi.waitFor(() => expect(same(editor.bytes(), original)).toBe(false))

    await panel.newChat()
    // the dropped run is still in the document: a second request is not started over it
    const streams = transport.streams
    await panel.send()
    expect(transport.streams).toBe(streams)
    expect(panel.held.at(-1)).toBe('held')

    undone.resolve()
    await vi.waitFor(() => expect(panel.held.at(-1)).toBe('free'))
    expect(same(editor.bytes(), original)).toBe(true)
  })
})

describe('a run that cannot be taken back out', () => {
  it('is what the editor history does: a full store drops its oldest step', () => {
    const editor = openEditor()
    const limit = editor.runLimit()
    for (let index = 0; index < limit + 3; index++) expect(editor.typeIn()).toBe(true)
    expect(editor.historyDepth()).toBe(limit)
  })

  it('is refused before the change that would make it so is applied, and the run still holds', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const { hold } = takeHold(editor)
    const limit = editor.runLimit()
    expect(limit).toBeGreaterThan(1)

    // one more change than the editor's undo store can take back whole, each its own step
    const calls = Array.from({ length: limit + 1 }, (_, index) => ({
      name: 'insert_paragraphs',
      input: { anchor: '끝 문단입니다.', where: 'after', paragraphs: [`추가 ${index}`] },
    }))
    const run = await runRequest(editor, calls, { hold })

    // the changes up to the limit applied; the next one was refused and changed nothing
    expect(run.items).toHaveLength(limit)
    expect(editor.lines().filter((line) => line.startsWith('추가'))).toHaveLength(limit)

    const proposal = await hold.hold(run.foreign)
    expect(proposal).toMatchObject({ kind: 'pending', steps: limit })
    expect(same(editor.bytes(), original)).toBe(true)
  })
})

describe('the hold a run takes on the document', () => {
  function backend(over: Partial<RunBackend> = {}) {
    const calls: string[] = []
    const base: RunBackend = {
      runSteps: async () => 2,
      foreignChanges: async () => 3,
      undo: async (steps) => {
        calls.push(`undo ${steps}`)
        return { ok: true, undone: steps }
      },
      redo: async (steps) => ({ ok: true, redone: steps }),
      setHeldRun: async (steps) => {
        calls.push(`held ${steps}`)
        return { ok: true, steps }
      },
      setRunLock: async (locked) => {
        calls.push(`lock ${locked}`)
        return { ok: true, locked }
      },
      strandRun: async () => {
        calls.push('strand')
        return { ok: true }
      },
    }
    return { calls, backend: { ...base, ...over } as RunBackend }
  }
  const holdOf = (b: RunBackend) => {
    const told: HoldState[] = []
    return {
      told,
      hold: new RunHold(
        () => b,
        (state) => told.push(state),
      ),
    }
  }

  it('tells the app at the first moment, and lets go when a run that changed nothing ends', () => {
    const { calls, backend: b } = backend()
    const { told, hold } = holdOf(b)
    hold.begin()
    expect(told).toEqual(['held'])
    hold.release()
    hold.release()
    expect(told).toEqual(['held', 'free'])
    expect(calls).toEqual(['lock false'])
  })

  it('does not start a run whose lock cannot be taken, and lets go of the document', async () => {
    const { backend: b } = backend({
      setRunLock: async () => {
        throw new Error('the editor is not ready')
      },
    })
    const { told, hold } = holdOf(b)
    const generation = hold.begin()
    await expect(hold.lock(generation)).rejects.toThrow('the editor is not ready')
    hold.release()
    expect(told).toEqual(['held', 'free'])
  })

  it('does not drop a run that is already being held when the conversation is reset', async () => {
    const { calls, backend: b } = backend()
    const { hold } = holdOf(b)
    hold.begin()
    const held = hold.hold(3)
    hold.abandon(3)
    await held
    expect(calls.filter((call) => call.startsWith('undo'))).toEqual(['undo 2'])
  })

  it('strands a run the editor cannot take out whole: nothing is put back, nothing is let go', async () => {
    const { calls, backend: b } = backend({
      undo: async () => ({ ok: false, reason: 'changed', undone: 1 }),
      redo: async () => {
        throw new Error('a partial undo must not be redone')
      },
    })
    const { told, hold } = holdOf(b)
    hold.begin()
    expect(await hold.hold(3)).toEqual({ kind: 'stranded' })
    expect(told).toEqual(['held', 'stranded'])
    expect(calls).toEqual(['strand'])
    // nothing lets it go
    hold.release()
    expect(told).toEqual(['held', 'stranded'])
    expect(calls).not.toContain('lock false')
  })

  it('strands a run whose undo throws, and one dropped by a reset whose undo is refused', async () => {
    const thrown = backend({
      undo: async () => {
        throw new Error('the editor is gone')
      },
    })
    const first = holdOf(thrown.backend)
    first.hold.begin()
    expect(await first.hold.hold(0)).toEqual({ kind: 'stranded' })
    expect(first.told).toEqual(['held', 'stranded'])

    const refused = backend({ undo: async () => ({ ok: false, reason: 'changed', undone: 0 }) })
    const second = holdOf(refused.backend)
    second.hold.begin()
    second.hold.abandon(0)
    await vi.waitFor(() => expect(second.told).toEqual(['held', 'stranded']))
    expect(refused.calls).toEqual(['strand'])
  })

  it('does not start a run in a document the plugin keeps stranded', async () => {
    const { backend: b } = backend({ setRunLock: async () => ({ ok: false }) })
    const { told, hold } = holdOf(b)
    const generation = hold.begin()
    await expect(hold.lock(generation)).rejects.toBeInstanceOf(StrandedError)
    hold.release()
    expect(told).toEqual(['held', 'stranded'])
  })

  it('takes out what the plugin counted, and lets go without an undo when it counted nothing', async () => {
    const counted = backend({ runSteps: async () => 4 })
    const first = holdOf(counted.backend)
    first.hold.begin()
    expect(await first.hold.hold(3)).toMatchObject({ kind: 'pending', steps: 4 })
    expect(counted.calls).toEqual(['undo 4', 'held 4', 'lock false'])

    const nothing = backend({ runSteps: async () => 0 })
    const second = holdOf(nothing.backend)
    second.hold.begin()
    expect(await second.hold.hold(3)).toEqual({ kind: 'none' })
    expect(second.told).toEqual(['held', 'free'])
    expect(nothing.calls).toEqual(['lock false'])
  })

  it('frees a dropped run that made no change without an undo', async () => {
    const { calls, backend: b } = backend({ runSteps: async () => 0 })
    const { told, hold } = holdOf(b)
    hold.begin()
    hold.abandon(3)
    await vi.waitFor(() => expect(told).toEqual(['held', 'free']))
    expect(calls).toEqual(['lock false'])
  })

  it('strands a run it cannot count or place, instead of letting go of it', async () => {
    const unreadable = backend({
      runSteps: async () => {
        throw new Error('the editor did not answer')
      },
    })
    const first = holdOf(unreadable.backend)
    first.hold.begin()
    expect(await first.hold.hold(3)).toEqual({ kind: 'stranded' })
    expect(first.told).toEqual(['held', 'stranded'])

    // a start that could not be read cannot be checked, so what the run made cannot come out
    const unknown = holdOf(backend().backend)
    unknown.hold.begin()
    expect(await unknown.hold.hold(null)).toEqual({ kind: 'stranded' })
  })
})

describe('a run that cannot be taken out of the document', () => {
  it('leaves saves refused and the person locked out, and the plugin keeps it so', async () => {
    const editor = openEditor()
    // the editor's undo stops short: the last step of the run is refused
    const redo = vi.fn()
    const stopsShort = new Proxy(editor.bridge, {
      get: (bridge, method) => {
        if (method === 'undo') {
          return async (steps: number, foreign: number) => {
            await bridge.undo(steps - 1, foreign)
            return { ok: false, reason: 'changed', undone: steps - 1 }
          }
        }
        return method === 'redo' ? redo : bridge[method as keyof typeof bridge]
      },
    }) as unknown as RunBackend
    const { flag, hold } = takeHold(editor, stopsShort)
    const ports = savePorts(editor)
    const run = await runRequest(editor, EDITS, { hold })
    const withRun = editor.bytes()

    expect(await hold.hold(run.foreign)).toEqual({ kind: 'stranded' })
    expect(redo).not.toHaveBeenCalled()
    expect(flag.state).toBe('stranded')
    // the part that did not come out is still in the document: nothing was put back
    expect(same(editor.bytes(), withRun)).toBe(false)

    // no save path writes it
    const outcome = await runSave(ports.port, ports.api, 'save', false, () => flag.held)
    expect(outcome).toEqual({ kind: 'failed', reason: 'ai' })
    expect(ports.spies.commitSave).not.toHaveBeenCalled()
    // the person stays locked out
    expect(editor.typeIn()).toBe(false)
    // and so does the next run, even from a panel that is mounted again
    const again = takeHold(editor)
    const generation = again.hold.begin()
    await expect(again.hold.lock(generation)).rejects.toBeInstanceOf(StrandedError)
    again.hold.release()
    expect(editor.typeIn()).toBe(false)
  })
})

describe('a run taken out of the document and waiting on the redo stack', () => {
  async function pending() {
    const editor = openEditor()
    const original = editor.bytes()
    const { hold } = takeHold(editor)
    const run = await runRequest(editor, EDITS, { hold })
    const proposal = await hold.hold(run.foreign)
    if (proposal.kind !== 'pending') throw new Error('the run was not held')
    return { editor, original, run, proposal }
  }

  it("is not brought back by the person's redo, pending or after a reject", async () => {
    const { editor, original } = await pending()
    editor.redoByPerson()
    expect(same(editor.bytes(), original)).toBe(true)
    // rejecting changes nothing about the stack: the same redo still does nothing
    expect(reject()).toEqual({ kind: 'none' })
    editor.redoByPerson()
    expect(same(editor.bytes(), original)).toBe(true)
  })

  it("still comes back through the panel's own accept, and the person's redo is theirs again after", async () => {
    const { editor, original, run, proposal } = await pending()
    const outcome = await accept(editor.bridge, proposal)
    expect(outcome.kind).toBe('applied')
    expect(same(editor.bytes(), run.live)).toBe(true)
    if (outcome.kind !== 'applied') return
    // the panel's undo of the applied run, then the person's redo of it
    expect(await editor.bridge.undo(run.items.length, outcome.foreign)).toMatchObject({ ok: true })
    expect(same(editor.bytes(), original)).toBe(true)
    for (let press = 0; press < run.items.length; press++) editor.redoByPerson()
    expect(same(editor.bytes(), run.live)).toBe(true)
  })

  it("lifts once the person's own edit has emptied the redo stack", async () => {
    const { editor } = await pending()
    expect(editor.typeIn()).toBe(true)
    const typed = editor.bytes()
    // nothing of the run is left to revive
    editor.redoByPerson()
    expect(same(editor.bytes(), typed)).toBe(true)
    // and the person's undo and redo of their own typing is not held back
    await editor.bridge.undo(1, await editor.bridge.foreignChanges())
    editor.redoByPerson()
    expect(same(editor.bytes(), typed)).toBe(true)
  })
})

describe('a PDF export in flight when the person sends an AI request', () => {
  it('is stopped by the real panel send: nothing is dispatched to the main process', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const panel = await mountPanel(editor.bridge)
    // the app's own wiring of the hold (createAiHoldWiring, which App builds all three of its
    // ends from): the panel reports into it, and the print job's ports take their hold from it
    const wiring = createAiHoldWiring()
    panel.onRunHold(wiring.onRunHold)
    // the run ends by itself and is taken back out before the paused batch comes back
    transport.finish = true

    // the export is under way: page 1 is drawn, page 2 waits
    const resume = Promise.withResolvers<void>()
    let calls = 0
    const bridge = {
      printPages: async (from: number) => {
        calls += 1
        if (calls === 2) await resume.promise
        return {
          pageCount: 3,
          from,
          pages: [{ svg: '<svg/>', width: 10, height: 10 }],
        }
      },
    }
    const dispatched = vi.fn(async () => ({ ok: true as const }))
    const exporting = runPrintJob(
      wiring.printPorts({
        ready: true,
        printing: { current: false },
        bridge,
        api: { printPages: dispatched } as unknown as Pick<HwpApi, 'printPages'>,
      }),
      'pdf',
      () => {},
    )
    await vi.waitFor(() => expect(calls).toBe(2))

    // the person sends an AI request through the real panel; the run takes the document
    await panel.send()
    expect(wiring.tracker.epoch()).toBeGreaterThan(0)
    // the run finishes and is reverted and released: the hold is off again
    await vi.waitFor(() => expect(wiring.tracker.isHeld()).toBe(false))
    expect(same(editor.bytes(), original)).toBe(true)
    resume.resolve()

    expect(await exporting).toEqual({ ok: false, error: expect.stringMatching(/AI request/) })
    expect(dispatched).not.toHaveBeenCalled()
  })
})
