/**
 * The docs AI path's context gate and tools-off notice: the shared transport is
 * wired with the app's language and the local model's window, and a declined
 * prompt never reaches the main process. A model that reported no tool support
 * shows the notice; an unknown report does not.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import type { AgentStreamCallbacks, IpcStreamError } from '@genoffice/agent-core'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { AI_CONTEXT_STRINGS, aiRunErrorText } from '@genoffice/ui'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { createElectronTransport } from '../src/renderer/ai/transport'

/** ASCII text that estimates to exactly `tokens` tokens (4 ASCII characters per token) */
const ascii = (tokens: number): string => 'a'.repeat(tokens * 4)

/** the active local model this app reads: a window and what it reported about tools */
function localSettings(tools?: boolean): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.customEndpoint = 'loc'
  settings.customEndpoints = [
    {
      id: 'loc',
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3:8b',
      kind: 'local',
      modelProfiles: {
        'qwen3:8b': {
          contextLength: 100,
          ...(tools === undefined ? {} : { tools }),
        },
      },
    },
  ]
  return settings
}

type Listener = (chunk: { requestId: string } & Record<string, unknown>) => void

function fakeDesktop() {
  const listeners = new Set<Listener>()
  const started: Array<Record<string, unknown>> = []
  ;(window as unknown as { desktop: unknown }).desktop = {
    onAiStream: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    aiStream: async (request: Record<string, unknown>) => {
      started.push(request)
    },
    aiStreamCancel: async () => undefined,
  }
  return { started, listeners }
}

function streamOnce(
  settings: AiSettings,
  runId?: string,
  shared?: ReturnType<typeof makeTransport>,
) {
  const turn = shared ?? makeTransport(settings)
  const callback: AgentStreamCallbacks = {
    onDelta: vi.fn(),
    onToolCall: vi.fn(),
    onDone: vi.fn(),
    onError: (error) => turn.errors.push(error),
  }
  turn.transport.stream(
    {
      system: ascii(90),
      messages: [],
      tools: [],
      ...(runId ? { runId } : {}),
    },
    callback,
  )
  return turn
}

function makeTransport(settings: AiSettings) {
  const errors: string[] = []
  const streamErrors: IpcStreamError[] = []
  const transport = createElectronTransport(() => settings, {
    onStreamError: (error) => streamErrors.push(error),
  })
  return { transport, errors, streamErrors }
}

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  vi.restoreAllMocks()
})

function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  cleanup.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return { container, root }
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

describe('the docs transport context gate', () => {
  it('declines without sending: one confirmation, no start, the shared context-limit text', () => {
    const { started } = fakeDesktop()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const turn = streamOnce(localSettings(), 'run-1')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(0)
    expect(turn.streamErrors).toEqual([
      { kind: 'context-limit', message: aiRunErrorText('zh', { kind: 'context-limit' }) },
    ])
    expect(turn.errors).toEqual([aiRunErrorText('zh', { kind: 'context-limit' })])
  })

  it('asks once for a run: the second turn of the same run starts without a dialog', () => {
    const { started } = fakeDesktop()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const turn = makeTransport(localSettings())
    streamOnce(localSettings(), 'run-1', turn)
    streamOnce(localSettings(), 'run-1', turn)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(2)
  })

  it('asks again for a new run', () => {
    const { started } = fakeDesktop()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const turn = makeTransport(localSettings())
    streamOnce(localSettings(), 'run-1', turn)
    streamOnce(localSettings(), 'run-2', turn)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(started).toHaveLength(2)
  })
})

describe('the docs tools-off notice', () => {
  it('shows the shared notice when the active local model reported tools: false', () => {
    const editor = createEditor()
    cleanup.push(() => editor.destroy())
    const { container } = mount(
      createElement(AiPanel, {
        editor,
        blocks: [],
        settings: localSettings(false),
        open: true,
        onExpand: () => {},
        onCollapse: () => {},
      }),
    )
    expect(container.querySelector('.ai-sub-notice')?.textContent).toBe(
      AI_CONTEXT_STRINGS.zh.toolsUnsupported,
    )
  })

  it('shows nothing when the model reported no tool support answer', () => {
    const editor = createEditor()
    cleanup.push(() => editor.destroy())
    const { container } = mount(
      createElement(AiPanel, {
        editor,
        blocks: [],
        settings: localSettings(undefined),
        open: true,
        onExpand: () => {},
        onCollapse: () => {},
      }),
    )
    expect(container.querySelector('.ai-sub-notice')).toBeNull()
  })
})
