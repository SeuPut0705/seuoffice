/**
 * The split pane's role wiring (decision 0036), in the whole editor against a
 * fake `window.aiOfficeSplit`: a secondary pane folds the AI panel to its rail
 * while the panel itself stays mounted, a click on the rail asks the shell to
 * focus this pane (and remembers the panel as open), and the screen root
 * reports focus pings. The model's answers and the subscription statuses are
 * fakes, so no provider program can be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  defaultAiSettings,
  type AiSubscriptionState,
} from '@genoffice/ai-provider'
import type { SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import type { SplitPaneRole } from '@genoffice/ui'
import App from '../src/renderer/App'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import type { MindmapApi } from '../src/shared/ipc'
import { mapLoaded, until } from './helpers/wait'

const statusMap = (
  claude: AiSubscriptionState,
  codex: AiSubscriptionState,
): SubscriptionStatusMap => ({
  'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
  codex: { provider: 'codex', state: codex, meteredAccepted: false },
})

interface FakeSplit {
  getRole: ReturnType<typeof vi.fn>
  requestFocus: ReturnType<typeof vi.fn>
  reportFocus: ReturnType<typeof vi.fn>
  bridge: {
    getRole: () => Promise<SplitPaneRole | null>
    onRoleChanged: (handler: (role: SplitPaneRole | null) => void) => () => void
    requestFocus: () => void
    reportFocus: () => void
  }
  /** the shell moves this view to another role: every listener hears the new one */
  push(role: SplitPaneRole | null): void
}

function fakeSplit(initial: SplitPaneRole | null): FakeSplit {
  let role = initial
  const listeners = new Set<(role: SplitPaneRole | null) => void>()
  const getRole = vi.fn(async () => role)
  const requestFocus = vi.fn()
  const reportFocus = vi.fn()
  return {
    getRole,
    requestFocus,
    reportFocus,
    bridge: {
      getRole,
      requestFocus,
      reportFocus,
      onRoleChanged: (handler) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    push(next) {
      role = next
      for (const handler of listeners) handler(next)
    },
  }
}

/** The editor's whole preload bridge, faked: side effects are recorded, nothing external runs. */
function fakeApi(): MindmapApi {
  const statuses = statusMap('ready', 'ready')
  const api = {
    consumePending: async () => null,
    openFile: async () => ({ status: 'unreadable' }),
    save: async () => ({ ok: true, path: 'C:/maps/new.xmind' }),
    setDirty: () => {},
    onSaveRequest: () => () => {},
    sendSaveRequestAck: () => {},
    onCloseSaveRequest: () => () => {},
    sendCloseSaveResult: () => {},
    onFileRenamed: () => () => {},
    openLink: async () => true,
    onMenuCommand: () => () => {},
    onExportRequest: () => () => {},
    onPrintRequest: () => () => {},
    getLanguage: async () => 'en' as Lang,
    onLanguageChanged: () => () => {},
    getTheme: async () => 'system' as const,
    onThemeChanged: () => () => {},
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    onAutoSaveDefaultChanged: () => () => {},
    onChromePressed: () => () => {},
    onOutlineRequest: () => () => {},
    sendOutlineResult: () => {},
    onBytesRequest: () => () => {},
    sendBytesResult: () => {},
    getAiSettings: async () => ({ ...defaultAiSettings(), subscriptionNoticeSeen: true }),
    setAiSettings: async () => {},
    onAiSettingsChanged: () => () => {},
    openAiModelSettings: async () => {},
    getAiPanelPrefs: async () => ({}),
    onAiPanelPrefsChanged: () => () => {},
    setProvisionalTitle: () => {},
    addAttachmentPaths: async () => ({ accepted: [], rejected: [] }),
    readAttachmentImage: async () => ({ ok: false }),
    subscription: {
      statuses: vi.fn(async () => statuses),
      recheck: vi.fn(async () => statuses),
      login: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ ok: true })),
      setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses })),
      onChanged: () => () => {},
      openInstallHelp: vi.fn(async () => undefined),
    },
    onAiStream: () => () => {},
    aiStream: async () => {},
    aiStreamCancel: async () => {},
  }
  return api as unknown as MindmapApi
}

let container: HTMLElement
let unmount: () => void = () => {}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  Element.prototype.scrollTo = () => undefined
})

afterEach(() => {
  unmount()
  unmount = () => {}
  document.body.innerHTML = ''
  delete (window as { mindmapApi?: unknown }).mindmapApi
  vi.unstubAllGlobals()
})

async function settle(turns = 16): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mountApp(split: FakeSplit): Promise<void> {
  vi.stubGlobal('aiOfficeSplit', split.bridge)
  ;(window as unknown as { mindmapApi: MindmapApi }).mindmapApi = fakeApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(App) }))
  })
  unmount = () => act(() => root.unmount())
  await until(() => mapLoaded(container), 'the map to open')
  await settle()
}

const dock = () => container.querySelector<HTMLElement>('.ai-dock')!
const rail = () => container.querySelector<HTMLButtonElement>('.ai-rail')

describe('the split pane role', () => {
  it('folds the panel to its rail in a secondary pane, and the panel stays mounted', async () => {
    await mountApp(fakeSplit('secondary'))
    expect(dock().classList.contains('collapsed')).toBe(true)
    expect(dock().getAttribute('data-ai-open')).toBe('false')
    expect(rail()).not.toBeNull()
    // folded, not unmounted: a run in flight and its chat survive
    expect(container.querySelector('.ai-input-box textarea')).not.toBeNull()
  })

  it('asks the shell to focus this pane from the rail, and the panel shows once focus arrives', async () => {
    // the user had collapsed the panel; the click on the rail must remember it as open
    localStorage.setItem('mindmapapp.showAi', '0')
    const split = fakeSplit('secondary')
    await mountApp(split)
    expect(dock().classList.contains('collapsed')).toBe(true)

    act(() => rail()!.click())
    expect(split.requestFocus).toHaveBeenCalledTimes(1)
    // the shell has not moved focus yet: the panel stays folded
    expect(dock().classList.contains('collapsed')).toBe(true)

    act(() => split.push('focus'))
    expect(dock().classList.contains('collapsed')).toBe(false)
    expect(dock().getAttribute('data-ai-open')).toBe('true')
    expect(rail()).toBeNull()
  })

  it('reports this view gaining focus from the screen root', async () => {
    const split = fakeSplit(null)
    await mountApp(split)
    expect(split.getRole).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(split.reportFocus).toHaveBeenCalledTimes(1)
  })
})
