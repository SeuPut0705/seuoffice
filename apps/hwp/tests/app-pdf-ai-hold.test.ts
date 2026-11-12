// @vitest-environment jsdom
/**
 * A PDF export under way when the person sends an AI request, through the app as it is: the
 * real `App` rendered, its AI dock and its own print path, over a real rhwp document behind
 * the real agent plugin. Only the editor frame is replaced (a fake `RhwpEditor` whose plugin
 * calls go to that plugin) and the model (a scripted transport). The export's second batch of
 * pages is held back while the request runs and is taken out of the document; when the batch
 * comes back the export must stop: nothing goes to the main process, and the person is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentStreamCallbacks } from '@seuoffice/agent-core'
import { defaultAiSettings } from '@seuoffice/ai-provider'
import App from '../src/renderer/App'
import { LocaleProvider, t } from '../src/renderer/i18n/locale'
import { HELD_ERROR } from '../src/renderer/print-flow'
import type { PrintJob, PrintMode, PrintResult } from '../src/shared/ipc'
import { fakeProjectFolder } from './fake-project-folder'
import { openEditor, same, useEngine, type TestEditor } from './ai-run-harness'

useEngine()

/** the editor the app boots: set per test, made when the app asks for it */
const editorMaker = vi.hoisted(() => ({
  make: null as null | ((host: HTMLElement) => unknown),
}))
vi.mock('@rhwp/editor', () => ({
  createEditor: async (host: HTMLElement) => editorMaker.make!(host),
}))

/** the model: the first request makes one change through a tool call, the next closes with a reply */
const transport = vi.hoisted(() => ({ streams: 0 }))
vi.mock('../src/renderer/ai/transport', () => ({
  createElectronTransport: () => ({
    stream: (_request: unknown, callbacks: AgentStreamCallbacks) => {
      transport.streams += 1
      const turn = transport.streams
      setTimeout(() => {
        if (turn === 1) {
          callbacks.onToolCall({
            id: 't0',
            name: 'insert_paragraphs',
            input: { anchor: '끝 문단입니다.', where: 'after', paragraphs: ['AI가 넣은 문단'] },
          })
        } else {
          callbacks.onDelta('Done.')
        }
        callbacks.onDone()
      }, 0)
      return { cancel: () => undefined }
    },
  }),
}))

let container: HTMLElement
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => undefined
  transport.streams = 0
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container.remove()
  for (const name of ['hwpApi', 'projectApi', 'projectFolderApi']) {
    delete (window as unknown as Record<string, unknown>)[name]
  }
  editorMaker.make = null
  vi.unstubAllGlobals()
})

async function settle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The editor frame the app talks to, with its plugin calls answered by the real plugin of `real`. */
function fakeEditor(real: TestEditor, host: HTMLElement, printPages: (from: number) => unknown) {
  const frame = document.createElement('iframe')
  host.appendChild(frame)
  const plugin = real.bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  return {
    element: frame,
    plugins: {
      load: async () => ({ id: 'ieum-agent', methods: [] }),
      invoke: async (_id: string, method: string, args: unknown[] = []) =>
        method === 'printPages' ? printPages(args[0] as number) : plugin[method]!(...args),
    },
    commands: {
      context: async () => ({ hasDocument: true, isDirty: false }),
      execute: async () => ({ ok: true }),
    },
    chrome: { get: async () => ({}), set: async (visibility: unknown) => visibility },
    loadFile: async () => ({}),
    exportHwp: async () => real.bytes(),
    exportHwpx: async () => real.bytes(),
    exportHwpVerify: async () => ({ pageCountBefore: 1, pageCountAfter: 1, recovered: true }),
    notifySaved: async () => ({ ok: true, wasDirty: false }),
    getSelectionContext: async () => ({}),
    focusTarget: async () => ({ focused: true, page: 1 }),
    destroy: () => frame.remove(),
  }
}

/** The main process the app talks to: what the app reads at boot, and a spy where the PDF would go. */
function mainProcess() {
  const settings = defaultAiSettings()
  const keyed = {
    ...settings,
    provider: 'openai' as const,
    providers: { ...settings.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
  }
  let printRequest: ((mode: PrintMode) => void) | null = null
  const known: Record<string, unknown> = {
    consumePending: async () => '/doc.hwp',
    getTheme: async () => 'system',
    getLanguage: async () => 'en',
    readFile: async () => new Uint8Array(),
    getAiSettings: async () => keyed,
    aiToolCapabilities: async () => ({ imageGeneration: { available: false } }),
    pickAttachments: async () => ({ accepted: [], rejected: [] }),
    addAttachmentPaths: async () => ({ accepted: [], rejected: [] }),
    addPastedImage: async () => ({ accepted: [], rejected: [] }),
    readAttachmentImage: async () => ({ ok: false }),
    setAiPanelPrefs: async () => ({}),
    getPathForFile: () => '',
    printPages: vi.fn(async (_job: PrintJob): Promise<PrintResult> => ({ ok: true })),
    onPrintRequest: (listener: (mode: PrintMode) => void) => {
      printRequest = listener
      return () => undefined
    },
  }
  // every other call the app makes at boot has nothing to say here
  const hwpApi = new Proxy(known, {
    get: (target, name) => {
      if (typeof name !== 'string') return undefined
      if (name in target) return target[name]
      return name.startsWith('on') ? () => () => undefined : async () => undefined
    },
  })
  Object.assign(window, {
    hwpApi,
    projectApi: {
      resolveChat: async () => ({ projectId: 'doc-store', chatId: 'doc-chat' }),
      loadChat: async () => [],
      appendChat: async () => undefined,
      rebindChat: async () => null,
    },
    projectFolderApi: fakeProjectFolder(null).api,
  })
  return {
    printPages: known.printPages as Mock<(job: PrintJob) => Promise<PrintResult>>,
    /** the main process asks for File > Export as PDF */
    async requestPdf() {
      await act(async () => printRequest!('pdf'))
    },
  }
}

/** The app up over `editor`, with its export's page batches under the test's control. */
async function bootApp(editor: TestEditor) {
  const main = mainProcess()
  const batches = { calls: 0, resume: Promise.withResolvers<void>() }
  editorMaker.make = (host) =>
    fakeEditor(editor, host, async (from: number) => {
      batches.calls += 1
      // the second batch is the one still being drawn when the person sends a request
      if (batches.calls === 2) await batches.resume.promise
      return { pageCount: 3, from, pages: [{ svg: '<svg/>', width: 10, height: 10 }] }
    })
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(LocaleProvider, { initial: 'en', children: createElement(App) }))
  })
  await vi.waitFor(() => expect(container.querySelector('.hwp-topbar')).not.toBeNull())
  await settle()
  return { main, batches }
}

const click = async (selector: string) => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click()
  })
  await settle()
}

const noticeText = () => container.querySelector('.hwp-notice')?.textContent ?? ''

describe('a PDF export in flight when the person sends an AI request, in the app', () => {
  it('stops the export when the run has been taken out of the document: nothing is sent, the person is told', async () => {
    const editor = openEditor()
    const original = editor.bytes()
    const { main, batches } = await bootApp(editor)

    await main.requestPdf()
    await vi.waitFor(() => expect(batches.calls).toBe(2))

    // the person sends a request through the app's AI dock while the second batch is drawn
    await click('.ai-starter')
    await click('.ai-send-btn:not(.ai-stop-btn)')
    // the run finished, was taken out of the document and let go: its edit waits for a yes
    await vi.waitFor(() => expect(container.querySelector('.ai-changes-accept')).not.toBeNull())
    expect(same(editor.bytes(), original)).toBe(true)

    batches.resume.resolve()
    await settle()

    expect(main.printPages).not.toHaveBeenCalled()
    expect(noticeText()).toContain(t('pdfFailed'))
    expect(noticeText()).toContain(HELD_ERROR)
  })

  it('exports all the pages when no request is sent meanwhile', async () => {
    const editor = openEditor()
    const { main, batches } = await bootApp(editor)

    await main.requestPdf()
    await vi.waitFor(() => expect(batches.calls).toBe(2))
    batches.resume.resolve()
    await vi.waitFor(() => expect(main.printPages).toHaveBeenCalledTimes(1))

    expect(main.printPages.mock.calls[0]![0]).toMatchObject({ mode: 'pdf' })
    expect(main.printPages.mock.calls[0]![0].pages).toHaveLength(3)
  })
})
