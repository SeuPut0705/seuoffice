/** @vitest-environment jsdom */
// The HWP AI panel with the project folder (spec 5): the project skill is in
// the loop's skill list, the project context is read before the run starts,
// messages go to the project chat (and to the document's own chat when no
// project is chosen), "new chat" starts a project chat, and the project chip
// sits on the row under the input. The model is a fake transport and the
// project folder a fake bridge; no provider and no folder is ever reached.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentStreamCallbacks, AgentStreamRequest } from '@seuoffice/agent-core'
import { defaultAiSettings, type AiSettings } from '@seuoffice/ai-provider'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import type { HoldState } from '../src/renderer/ai/turn-proposal'
import { t } from '../src/renderer/i18n/locale'
import { fakeProjectFolder, type FakeProjectFolder } from './fake-project-folder'

const model = vi.hoisted(() => ({
  calls: [] as string[],
  requests: [] as { system: string; tools: string[] }[],
  /** the model never answers: a run stays in flight */
  hang: false,
}))

vi.mock('../src/renderer/ai/transport', () => ({
  createElectronTransport: () => ({
    stream: (request: AgentStreamRequest, callbacks: AgentStreamCallbacks) => {
      model.calls.push('stream')
      model.requests.push({ system: request.system, tools: request.tools.map((tool) => tool.name) })
      if (model.hang) return { cancel: () => undefined }
      setTimeout(() => {
        callbacks.onDelta('Done.')
        callbacks.onDone()
      }, 0)
      return { cancel: () => undefined }
    },
  }),
}))

/** a key provider the person chose: the send gate lets it run (the transport is fake) */
function keySettings(): AiSettings {
  const settings = defaultAiSettings()
  return {
    ...settings,
    provider: 'openai',
    providers: { ...settings.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
  }
}

function hwpApiStub() {
  return {
    getAiSettings: async () => keySettings(),
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
  }
}

/** the per-document chat store */
function projectApiStub() {
  return {
    resolveChat: vi.fn(async () => ({ projectId: 'doc-store', chatId: 'doc-chat' })),
    loadChat: vi.fn(async () => []),
    appendChat: vi.fn(async () => undefined),
    rebindChat: vi.fn(async () => null),
  }
}

/**
 * an editor with no document behind it: it takes the run's lock and counts no foreign
 * changes, and every other call fails, which the panel swallows
 */
const NO_EDITOR = new Proxy({} as AgentBridge, {
  get: (_target, method) => () =>
    method === 'setRunLock'
      ? Promise.resolve({ ok: true, locked: true })
      : method === 'foreignChanges'
        ? Promise.resolve(0)
        : Promise.reject(new Error('no editor in this test')),
})

let container: HTMLElement
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => undefined
  model.calls.length = 0
  model.requests.length = 0
  model.hang = false
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  for (const key of ['hwpApi', 'projectApi', 'projectFolderApi']) {
    delete (window as unknown as Record<string, unknown>)[key]
  }
  vi.unstubAllGlobals()
})

async function settle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(folder: FakeProjectFolder) {
  const projectApi = projectApiStub()
  Object.assign(window, { hwpApi: hwpApiStub(), projectApi, projectFolderApi: folder.api })
  // the model's request follows the bridge calls in one log
  const readContext = folder.api.readContext
  folder.api.readContext = (args) => {
    model.calls.push('readContext')
    return readContext(args)
  }
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(AiPanel, { bridge: NO_EDITOR, filePath: null, onCollapse: () => undefined }),
    )
  })
  await settle()
  return projectApi
}

/** a starter fills the input; the send button sends it */
async function sendStarter(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.ai-starter')!.click()
  })
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.ai-send-btn:not(.ai-stop-btn)')!.click()
  })
  await settle()
}

const newChatButton = () =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${t('aiNewChat')}"]`)

describe('hwp AI panel: project folder', () => {
  it('puts the project chip on the row under the input and the chat menu in the header', async () => {
    const folder = fakeProjectFolder('p1')
    await mount(folder)
    expect(container.querySelector('.ai-input-below .ai-project-chip')).not.toBeNull()
    expect(container.querySelector('.ai-panel-header .ai-project-chat-button')).not.toBeNull()
  })

  it('reads the project context before the run and sends the project skill with it', async () => {
    const folder = fakeProjectFolder('p1')
    const projectApi = await mount(folder)
    await sendStarter()

    expect(model.calls.indexOf('readContext')).toBeGreaterThanOrEqual(0)
    expect(model.calls.indexOf('readContext')).toBeLessThan(model.calls.indexOf('stream'))
    const request = model.requests[0]!
    expect(request.system).toContain('## Project folder')
    expect(request.system).toContain('Write in plain words.')
    expect(request.tools).toEqual(
      expect.arrayContaining(['project_list_files', 'project_search', 'project_read']),
    )
    // the run's scope was closed again
    expect(folder.calls).toContain('closeScope')
    // the question and the answer went to the project chat, not to the document's own chat
    expect(folder.appended.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(folder.appended[0]).toMatchObject({ projectId: 'p1', chatId: 'c1' })
    expect(projectApi.appendChat).not.toHaveBeenCalled()
    // the memory notice of the send shows above the input
    expect(container.querySelector('[data-notice="memory-long"]')).not.toBeNull()
  })

  it('keeps the document’s own chat when no project is chosen', async () => {
    const folder = fakeProjectFolder(null)
    const projectApi = await mount(folder)
    expect(container.querySelector('.ai-input-below .ai-project-chip')).not.toBeNull()
    expect(container.querySelector('.ai-project-chat-button')).toBeNull()
    await sendStarter()

    expect(folder.appended).toEqual([])
    expect(projectApi.appendChat).toHaveBeenCalledTimes(2)
    expect(projectApi.appendChat).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'doc-store', chatId: 'doc-chat', role: 'user' }),
    )
    const request = model.requests[0]!
    expect(request.system).not.toContain('## Project folder')
    expect(request.tools.some((name) => name.startsWith('project_'))).toBe(false)
  })

  it('"new chat" starts a new project chat when a project is chosen', async () => {
    const folder = fakeProjectFolder('p1')
    await mount(folder)
    await sendStarter()
    expect(folder.newChats).toEqual(['c1'])

    await act(async () => newChatButton()!.click())
    await settle()
    expect(folder.newChats).toEqual(['c1', 'c2'])
    expect(container.querySelectorAll('.ai-msg').length).toBe(0)
  })

  it('"new chat" without a project clears the chat as before', async () => {
    const folder = fakeProjectFolder(null)
    await mount(folder)
    await sendStarter()
    expect(container.querySelectorAll('.ai-msg').length).toBeGreaterThan(0)

    act(() => newChatButton()!.click())
    expect(container.querySelectorAll('.ai-msg').length).toBe(0)
    await settle()
    expect(folder.newChats).toEqual([])
  })
})

describe('hwp AI panel: the run holds the document', () => {
  /** an editor whose lock calls are recorded, with no document behind it */
  function lockableEditor(options: { lockFails?: boolean } = {}) {
    const locks: boolean[] = []
    const editor = new Proxy({} as AgentBridge, {
      get: (_target, method) => async (locked?: boolean) => {
        if (method === 'setRunLock') {
          locks.push(locked === true)
          if (options.lockFails && locked) throw new Error('the editor did not take the lock')
          return { ok: true, locked }
        }
        if (method === 'foreignChanges') return 0
        // the run changed nothing in the document behind it
        if (method === 'runSteps') return 0
        throw new Error('no editor in this test')
      },
    })
    return { editor, locks }
  }

  async function mountWith(editor: AgentBridge, onRunHold: (state: HoldState) => void) {
    Object.assign(window, {
      hwpApi: hwpApiStub(),
      projectApi: projectApiStub(),
      projectFolderApi: fakeProjectFolder(null).api,
    })
    root = createRoot(container)
    await act(async () => {
      root!.render(
        createElement(AiPanel, {
          bridge: editor,
          filePath: null,
          onCollapse: () => undefined,
          onRunHold,
        }),
      )
    })
    await settle()
  }

  it('tells the app from the send until the run ends, and holds the editor meanwhile', async () => {
    const { editor, locks } = lockableEditor()
    const held: HoldState[] = []
    await mountWith(editor, (value) => held.push(value))
    await sendStarter()

    expect(model.requests).toHaveLength(1)
    // the lock says it again once it is in
    expect(held).toEqual(['held', 'held', 'free'])
    expect(locks).toEqual([true, false])
  })

  it('does not start a run the editor cannot be locked for, and lets go of the document', async () => {
    const { editor, locks } = lockableEditor({ lockFails: true })
    const held: HoldState[] = []
    await mountWith(editor, (value) => held.push(value))
    await sendStarter()

    expect(model.requests).toHaveLength(0)
    expect(held).toEqual(['held', 'free'])
    expect(locks).toEqual([true, false])
    expect(container.textContent).toContain('the editor did not take the lock')
  })

  it('lets go of the document when a new chat is started in the middle of a run', async () => {
    model.hang = true
    const { editor, locks } = lockableEditor()
    const held: HoldState[] = []
    await mountWith(editor, (value) => held.push(value))
    await sendStarter()
    // the run is in flight: the model has not answered
    expect(held).toEqual(['held', 'held'])

    await act(async () => newChatButton()!.click())
    await settle()
    expect(held).toEqual(['held', 'held', 'free'])
    expect(locks).toEqual([true, false])
  })

  /** a promise the test settles by hand */
  function deferred() {
    let open!: () => void
    const promise = new Promise<void>((resolve) => (open = resolve))
    return { promise, open }
  }

  it('does not run a request whose chat was reset while it was being prepared, and keeps the document held until then', async () => {
    const { editor, locks } = lockableEditor()
    const held: HoldState[] = []
    await mountWith(editor, (value) => held.push(value))
    // the request is still reading the settings when "new chat" is pressed
    const settings = deferred()
    const api = window.hwpApi as unknown as { getAiSettings: () => Promise<AiSettings> }
    api.getAiSettings = async () => {
      await settings.promise
      return keySettings()
    }
    await sendStarter()
    expect(held).toEqual(['held'])

    await act(async () => newChatButton()!.click())
    await settle()
    expect(held).toEqual(['held', 'free'])

    settings.open()
    await settle()
    // the prepared request stopped before the loop: no run, and the document stays free
    expect(model.requests).toHaveLength(0)
    expect(held).toEqual(['held', 'free'])
    expect(locks).not.toContain(true)
  })

  it('does not run a request reset while the editor was being locked, and lifts the lock again', async () => {
    const { editor, locks } = lockableEditor()
    const lock = deferred()
    const slow = new Proxy(editor, {
      get: (target, method) =>
        method === 'setRunLock'
          ? async (locked?: boolean) => {
              if (locked) await lock.promise
              return (target as unknown as Record<string, (l?: boolean) => Promise<unknown>>)
                .setRunLock!(locked)
            }
          : (target as unknown as Record<string | symbol, unknown>)[method],
    })
    const held: HoldState[] = []
    await mountWith(slow, (value) => held.push(value))
    await sendStarter()
    expect(held).toEqual(['held'])

    await act(async () => newChatButton()!.click())
    await settle()
    lock.open()
    await settle()
    expect(model.requests).toHaveLength(0)
    expect(held).toEqual(['held', 'free'])
    expect(locks.at(-1)).toBe(false)
  })
})
