// @vitest-environment jsdom
/**
 * A person acts (Stop, New chat, the panel going away) while an AI write call is still on its
 * way to the editor: the editor applies the change when the call arrives, but the panel only
 * hears of it when the answer comes back. Against the real panel, the real hwp skill and the
 * real plugin over a real rhwp document (see ai-run-harness.ts), the run must never be let
 * go of with an edit of its still in the document, and a call the skill makes after the run
 * ended must never reach the editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentStreamCallbacks } from '@genoffice/agent-core'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { t } from '../src/renderer/i18n/locale'
import type { HoldState } from '../src/renderer/ai/turn-proposal'
import { fakeProjectFolder } from './fake-project-folder'
import { LINES, openEditor, same, useEngine, type TestEditor } from './ai-run-harness'

useEngine()

type ToolCall = { name: string; input: Record<string, unknown> }

/**
 * The model of the panel tests: what each request the loop makes plays, in order. Tool calls,
 * or a closing reply; a request with no turn never answers, so the run stays in flight until
 * the person acts (the stream then ends the way the real one does when it is cancelled).
 */
type Turn = ToolCall[] | 'reply' | undefined
const transport = vi.hoisted(() => ({ streams: 0, turns: [] as Turn[] }))
vi.mock('../src/renderer/ai/transport', () => ({
  createElectronTransport: () => ({
    stream: (_request: unknown, callbacks: AgentStreamCallbacks) => {
      const turn = transport.turns[transport.streams]
      transport.streams += 1
      let ended = false
      const end = () => {
        ended = true
        callbacks.onDone()
      }
      if (turn === 'reply') {
        setTimeout(() => {
          callbacks.onDelta('Done.')
          end()
        }, 0)
      } else if (turn) {
        setTimeout(() => {
          turn.forEach((call, index) => callbacks.onToolCall({ id: `t${index}`, ...call }))
          end()
        }, 0)
      }
      return { cancel: () => void (ended || queueMicrotask(end)) }
    },
  }),
}))

const AI_PARAGRAPH = 'AI가 넣은 문단'
const INSERT: ToolCall = {
  name: 'insert_paragraphs',
  input: { anchor: '끝 문단입니다.', where: 'after', paragraphs: [AI_PARAGRAPH] },
}
const REPLACE: ToolCall = {
  name: 'replace_text',
  input: { find: '첫째 문단', replace: '첫 번째 문단' },
}
const INSERT_IMAGE: ToolCall = {
  name: 'insert_image',
  input: { where: 'end', url: 'https://example.com/a.png' },
}
/** a 1x1 PNG: the plugin's engine takes it as a picture */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let container: HTMLElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => undefined
  transport.streams = 0
  transport.turns = []
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

/** The AI panel over `bridge`, with the app's side (what it is told of the hold) and the buttons a person presses. */
async function mountPanel(bridge: AgentBridge, hwpApi: Record<string, unknown> = {}) {
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
      ...hwpApi,
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
  const click = async (selector: string) => {
    await act(async () => {
      container!.querySelector<HTMLButtonElement>(selector)!.click()
    })
    await settle()
  }
  return {
    held,
    /** told of every hold change, in step with the log */
    onRunHold: (listener: (state: HoldState) => void) => listeners.push(listener),
    /** a starter fills the input; the send button sends it */
    async send() {
      const starter = container!.querySelector<HTMLButtonElement>('.ai-starter')
      if (starter) await act(async () => starter.click())
      await click('.ai-send-btn:not(.ai-stop-btn)')
    },
    /** the person types a message into the composer and presses send */
    async sendTyped(text: string) {
      const box = container!.querySelector<HTMLTextAreaElement>('textarea')!
      const view = box.ownerDocument.defaultView!
      const setValue = Object.getOwnPropertyDescriptor(
        view.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      await act(async () => {
        setValue.call(box, text)
        box.dispatchEvent(new view.Event('input', { bubbles: true }))
      })
      await click('.ai-send-btn:not(.ai-stop-btn)')
    },
    stop: () => click(`button[aria-label="${t('aiStop')}"]`),
    newChat: () => click(`button[aria-label="${t('aiNewChat')}"]`),
    accept: () => click('.ai-changes-accept'),
    reject: () => click('.ai-changes-actions .ai-changes-revert:not(.ai-changes-accept)'),
    /** the person's answer to the run is waiting on the card */
    hasProposal: () => container!.querySelector('.ai-changes-accept') !== null,
    unmount: async () => {
      await act(async () => root!.unmount())
      root = null
    },
  }
}

/**
 * A bridge whose `method` reaches the editor at once (the editor makes the change when the
 * call arrives) while its answer is on its way until `release`. With `ordered`, the answers of
 * the calls made after it queue behind it, as they do over the one channel to the editor frame.
 */
function slowReply(editor: TestEditor, method: keyof AgentBridge, ordered = false) {
  const reply = Promise.withResolvers<void>()
  let arrived = 0
  const bridge = new Proxy(editor.bridge, {
    get: (target, name) => {
      const call = target[name as keyof AgentBridge] as (...args: unknown[]) => Promise<unknown>
      if (typeof call !== 'function') return call
      return async (...args: unknown[]) => {
        const result = await call(...args)
        if (name === method) {
          arrived += 1
          await reply.promise
        } else if (ordered && arrived > 0) {
          await reply.promise
        }
        return result
      }
    },
  })
  return { bridge, release: reply.resolve, arrived: () => arrived }
}

/** What the app learns and what the document holds, one entry per change of the hold. */
function watchDocument(
  editor: TestEditor,
  original: Uint8Array,
  panel: { onRunHold(listener: (state: HoldState) => void): unknown },
) {
  const seen: { state: HoldState; clean: boolean }[] = []
  panel.onRunHold((state) => seen.push({ state, clean: same(editor.bytes(), original) }))
  return {
    /** the app was told the document is free while the run's edit was still in it */
    freedWithEditInside: () => seen.some((entry) => entry.state === 'free' && !entry.clean),
  }
}

describe('Stop pressed while an AI write call is on its way to the editor', () => {
  it('takes the run out of the document before the person has it back', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[INSERT]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    const watch = watchDocument(editor, original, panel)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))
    expect(same(editor.bytes(), original)).toBe(false)

    await panel.stop()
    slow.release()
    await settle()

    expect(panel.held.at(-1)).toBe('free')
    expect(watch.freedWithEditInside()).toBe(false)
    expect(same(editor.bytes(), original)).toBe(true)
    // the person types into a document that has none of the run
    expect(editor.typeIn()).toBe(true)
  })

  it('holds the edit that was on its way as part of the proposal: a yes brings back all of it, once', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[INSERT]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))

    await panel.stop()
    slow.release()
    await settle()

    expect(panel.hasProposal()).toBe(true)
    expect(same(editor.bytes(), original)).toBe(true)
    await panel.accept()
    expect(editor.lines().filter((line) => line === AI_PARAGRAPH)).toHaveLength(1)
    expect(editor.lines().filter((line) => LINES.includes(line))).toHaveLength(LINES.length)
  })

  it('takes out every change of the run when an earlier one was already counted', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[REPLACE, INSERT]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    const watch = watchDocument(editor, original, panel)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))
    expect(editor.lines()).toContain('첫 번째 문단입니다.')

    await panel.stop()
    slow.release()
    await settle()

    expect(panel.held.at(-1)).toBe('free')
    expect(watch.freedWithEditInside()).toBe(false)
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.lines()).toEqual(LINES)
  })

  it('waits for the editor’s answers when they come in order, and proposes the change that was on its way', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[INSERT]]
    const slow = slowReply(editor, 'insertParagraphs', true)
    const panel = await mountPanel(slow.bridge)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))

    await panel.stop()
    // the run is still on the document: its edit is in it, and nobody else may touch it
    expect(panel.held.at(-1)).toBe('held')
    expect(editor.typeIn()).toBe(false)

    slow.release()
    await settle()
    expect(panel.held.at(-1)).toBe('free')
    expect(same(editor.bytes(), original)).toBe(true)
    // the tool never reported it (its run was stopped), but the proposal counts it
    expect(container!.querySelector('.ai-changes-title')?.textContent).toBe(
      t('aiProposalTitle', { count: 1 }),
    )
  })

  it('does not list the change that was on its way in the run that starts after it', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[INSERT], [REPLACE]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))
    await panel.stop()
    // the person turns the stopped run down and asks again, before the old answer arrives
    await panel.reject()
    await panel.sendTyped('고쳐 주세요')
    await vi.waitFor(() => expect(editor.lines()).toContain('첫 번째 문단입니다.'))
    slow.release()
    await settle()

    await panel.stop()
    expect(panel.held.at(-1)).toBe('free')
    expect(same(editor.bytes(), original)).toBe(true)
    // the new run's list is its own change only
    expect(container!.querySelectorAll('.ai-change')).toHaveLength(1)
    await panel.accept()
    expect(editor.lines()).not.toContain(AI_PARAGRAPH)
  })
})

describe('New chat pressed while an AI write call is on its way to the editor', () => {
  it('takes the run out of the document before the person has it back', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[REPLACE, INSERT]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    const watch = watchDocument(editor, original, panel)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))

    await panel.newChat()
    slow.release()
    await settle()

    expect(panel.held.at(-1)).toBe('free')
    expect(watch.freedWithEditInside()).toBe(false)
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.typeIn()).toBe(true)
  })
})

describe('the panel going away while an AI write call is on its way to the editor', () => {
  it('takes the run out of the document before the app is told it is free', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    transport.turns = [[INSERT]]
    const slow = slowReply(editor, 'insertParagraphs')
    const panel = await mountPanel(slow.bridge)
    const watch = watchDocument(editor, original, panel)
    await panel.send()
    await vi.waitFor(() => expect(slow.arrived()).toBe(1))

    await panel.unmount()
    slow.release()
    await settle()

    expect(panel.held.at(-1)).toBe('free')
    expect(watch.freedWithEditInside()).toBe(false)
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.typeIn()).toBe(true)
  })
})

describe('Stop pressed while a picture is being measured', () => {
  it('puts nothing into the document once the run has ended', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    // the picture's size is read by the window; its answer is held back
    const measured = Promise.withResolvers<{ width: number; height: number; close(): void }>()
    const measuring = vi.fn(() => measured.promise)
    vi.stubGlobal('createImageBitmap', measuring)
    transport.turns = [[INSERT_IMAGE]]
    const inserted = vi.fn()
    const spied = new Proxy(editor.bridge, {
      get: (target, name) => {
        if (name === 'insertPicture') {
          return (...args: Parameters<AgentBridge['insertPicture']>) => {
            inserted()
            return target.insertPicture(...args)
          }
        }
        return target[name as keyof AgentBridge]
      },
    })
    const panel = await mountPanel(spied, {
      fetchImage: async () => ({ base64: PNG, mime: 'image/png' }),
    })
    const watch = watchDocument(editor, original, panel)
    await panel.send()
    await vi.waitFor(() => expect(measuring).toHaveBeenCalled())

    await panel.stop()
    expect(panel.held.at(-1)).toBe('free')
    measured.resolve({ width: 1, height: 1, close: () => undefined })
    await settle()

    expect(inserted).not.toHaveBeenCalled()
    expect(watch.freedWithEditInside()).toBe(false)
    expect(same(editor.bytes(), original)).toBe(true)
    expect(editor.typeIn()).toBe(true)
  })
})

describe('Stop pressed while a picture is being measured, and a new request started before it is', () => {
  it('never puts the old picture into the new run: not its document, its list or its hold', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const measured = Promise.withResolvers<{ width: number; height: number; close(): void }>()
    const measuring = vi.fn(() => measured.promise)
    vi.stubGlobal('createImageBitmap', measuring)
    // the first request inserts a picture; the second changes a word and then waits on the model
    transport.turns = [[INSERT_IMAGE], [REPLACE]]
    const inserted = vi.fn()
    const spied = new Proxy(editor.bridge, {
      get: (target, name) => {
        if (name === 'insertPicture') {
          return (...args: Parameters<AgentBridge['insertPicture']>) => {
            inserted()
            return target.insertPicture(...args)
          }
        }
        return target[name as keyof AgentBridge]
      },
    })
    const panel = await mountPanel(spied, {
      fetchImage: async () => ({ base64: PNG, mime: 'image/png' }),
    })
    await panel.send()
    await vi.waitFor(() => expect(measuring).toHaveBeenCalled())
    await panel.stop()
    expect(panel.held.at(-1)).toBe('free')

    // the new run is on the document and has made its change when the old measure is answered
    await panel.sendTyped('고쳐 주세요')
    await vi.waitFor(() => expect(editor.lines()).toContain('첫 번째 문단입니다.'))
    expect(panel.held.at(-1)).toBe('held')
    measured.resolve({ width: 1, height: 1, close: () => undefined })
    await settle()
    expect(inserted).not.toHaveBeenCalled()

    // the new run ends holding its own change and nothing else
    await panel.stop()
    expect(panel.held.at(-1)).toBe('free')
    expect(same(editor.bytes(), original)).toBe(true)
    expect(container!.querySelectorAll('.ai-change')).toHaveLength(1)
    await panel.accept()
    expect(editor.lines()).toContain('첫 번째 문단입니다.')
    expect((await editor.bridge.listPictures()).count).toBe(0)
  })
})
