import './mock-editor-surfaces'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'

import { normalizeAiSettings } from '@seuoffice/ai-provider/browser'
import type { IpcStreamChunk } from '@seuoffice/agent-core'

import { LocaleProvider, setModuleLang } from '../../src/renderer/i18n/locale'
import { mounted } from './minimal-univer'

/** One streamed model turn the test scripts; it emits chunks for the request it answers. */
export type ScriptedTurn = (emit: (chunk: Omit<IpcStreamChunk, 'requestId'>) => void) => void

export interface MountedApp {
  host: HTMLElement
  /** the requests the app has sent to the model, oldest first */
  streamRequests: { requestId: string; messages: unknown[] }[]
  /** menu commands the main process sends (File ▸ Save, ...) */
  menuAction(action: string): Promise<void>
  /** the status bar line */
  statusText(): string
  /** lets the app's promise chains and effects settle */
  settle(): Promise<void>
  unmount(): Promise<void>
}

vi.stubGlobal('Path2D', class {})
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollTo = () => undefined

/**
 * Mounts the real `App` with only the editor surfaces replaced (see mock-editor-surfaces.ts)
 * and the main process stood in for by `desktopApi`: a key-configured provider, and a model
 * that answers each request with the next scripted turn. A turn that never emits keeps the
 * run in flight.
 */
export async function mountSheetsApp(turns: ScriptedTurn[]): Promise<MountedApp> {
  const streamRequests: MountedApp['streamRequests'] = []
  let onStream: ((chunk: IpcStreamChunk) => void) | undefined
  let onMenu: ((action: string) => void) | undefined
  const settings = normalizeAiSettings({
    provider: 'openai',
    providers: { openai: { apiKey: 'sk-test', model: 'gpt-test' } },
    subscriptionNoticeSeen: true,
  })
  const overrides: Record<string, unknown> = {
    getAiSettings: () => Promise.resolve(settings),
    getUserDisplayName: () => Promise.resolve('Tester'),
    onAiStream: (listener: (chunk: IpcStreamChunk) => void) => {
      onStream = listener
      return () => undefined
    },
    onMenuAction: (listener: (action: string) => void) => {
      onMenu = listener
      return () => undefined
    },
    aiStream: (request: { requestId: string; messages: unknown[] }) => {
      const turn = turns[streamRequests.length]
      streamRequests.push(request)
      turn?.((chunk) => onStream?.({ requestId: request.requestId, ...chunk }))
      return Promise.resolve()
    },
  }
  ;(window as unknown as { desktopApi: unknown }).desktopApi = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key !== 'string' || key === 'then') return undefined
        if (key in overrides) return overrides[key]
        return key.startsWith('on') ? () => () => undefined : () => Promise.resolve(null)
      },
    },
  )
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia

  const { App } = await import('../../src/renderer/App')
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  await act(async () => {
    setModuleLang('en')
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(App, {}) }))
  })
  await settle()
  if (!mounted.runtime) throw new Error('the app never created its Univer runtime')
  return {
    host,
    streamRequests,
    menuAction: async (action) => {
      await act(async () => onMenu?.(action))
      await settle()
    },
    statusText: () =>
      host.querySelector('.status-bar, .statusbar, [class*="status"]')?.textContent ?? '',
    settle,
    unmount: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/** Types into the AI composer the way a person does and presses Send. */
export async function sendFromComposer(app: MountedApp, text: string): Promise<void> {
  const textarea = app.host.querySelector<HTMLTextAreaElement>('.ai-composer textarea')
  if (!textarea) throw new Error('no AI composer on screen')
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setValue.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    app.host.querySelector<HTMLButtonElement>('.ai-send-btn')!.click()
  })
  await app.settle()
}

export async function clickButton(app: MountedApp, label: string): Promise<void> {
  const button = [...app.host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === label,
  )
  if (!button) throw new Error(`no button "${label}"`)
  await act(async () => button.click())
  await app.settle()
}
