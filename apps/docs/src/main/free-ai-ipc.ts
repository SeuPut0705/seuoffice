/**
 * The free connections' IPC (Settings and the first-run guide call it): the
 * OpenRouter browser sign-in, the Gemini key check, removing a connection,
 * today's remaining free requests, and the page where a key is made. A made
 * connection is written here, in the main process, so the key OpenRouter hands
 * back never passes through a renderer.
 */
import { ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { safeExternalUrl } from '@genoffice/electron-utils'
import { createI18n, getUiLang } from '@genoffice/i18n'
import {
  FREE_AI_IPC_CHANNELS,
  FREE_AI_KEY_PAGES,
  isFreeAiProvider,
  withFreeAiConnection,
  withoutFreeAiConnection,
} from '@genoffice/ai-provider/browser'
import type {
  AiSettings,
  FreeAiConnectResult,
  FreeAiProviderId,
  FreeAiQuota,
} from '@genoffice/ai-provider/browser'
import {
  connectGemini,
  connectOpenRouter,
  openRouterFreeQuota,
} from '@genoffice/ai-provider/free-connect'
import type { FreeConnectResult } from '@genoffice/ai-provider/free-connect'
import { FREE_AI_PAGE_STRINGS } from './free-ai-strings'

const tPage = createI18n(FREE_AI_PAGE_STRINGS)

export interface FreeAiIpcDeps {
  /** the settings file as every reader gets it */
  readSettings: () => AiSettings
  /** checks, writes and announces new settings; false when they were refused */
  writeSettings: (settings: AiSettings) => boolean
  /** the window that shows this webContents (a tab's view has no window of its own) */
  windowFor: (wc: WebContents) => BrowserWindow | undefined
}

/** the browser sign-in still waiting for OpenRouter; a new one or cancel ends it */
let pending: AbortController | null = null

async function openInBrowser(url: string): Promise<boolean> {
  const target = safeExternalUrl(url)
  if (!target) return false
  try {
    await shell.openExternal(target)
    return true
  } catch {
    return false
  }
}

/** after the browser sign-in the user is still in the browser: bring the app back */
function raiseWindowOf(event: IpcMainInvokeEvent, deps: FreeAiIpcDeps): void {
  const win = deps.windowFor(event.sender)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function providerOf(input: unknown): FreeAiProviderId | null {
  const provider = (input as { provider?: unknown } | null)?.provider
  return isFreeAiProvider(provider) ? provider : null
}

export function registerFreeAiIpc(deps: FreeAiIpcDeps): void {
  const save = (provider: FreeAiProviderId, result: FreeConnectResult): FreeAiConnectResult => {
    if (!result.ok) return result
    const written = deps.writeSettings(
      withFreeAiConnection(deps.readSettings(), provider, {
        apiKey: result.apiKey,
        model: result.model,
      }),
    )
    return written ? { ok: true, provider, model: result.model } : { ok: false, reason: 'network' }
  }

  ipcMain.handle(
    FREE_AI_IPC_CHANNELS.connect,
    async (event, input: unknown): Promise<FreeAiConnectResult> => {
      const provider = providerOf(input)
      if (provider === 'gemini') {
        return save('gemini', await connectGemini((input as { apiKey?: unknown }).apiKey))
      }
      if (provider !== 'openrouter') return { ok: false, reason: 'invalid' }
      pending?.abort()
      const attempt = new AbortController()
      pending = attempt
      const lang = getUiLang()
      try {
        const result = await connectOpenRouter({
          openBrowser: openInBrowser,
          pages: {
            done: {
              lang,
              title: tPage(lang, 'pageDoneTitle'),
              body: tPage(lang, 'pageDoneBody'),
            },
            failed: {
              lang,
              title: tPage(lang, 'pageFailedTitle'),
              body: tPage(lang, 'pageFailedBody'),
            },
          },
          signal: attempt.signal,
        })
        if (result.ok || result.reason !== 'cancelled') raiseWindowOf(event, deps)
        return save('openrouter', result)
      } finally {
        if (pending === attempt) pending = null
      }
    },
  )

  ipcMain.handle(FREE_AI_IPC_CHANNELS.cancel, () => {
    pending?.abort()
    pending = null
  })

  ipcMain.handle(FREE_AI_IPC_CHANNELS.disconnect, (_event, input: unknown) => {
    const provider = providerOf(input)
    if (!provider) return
    deps.writeSettings(withoutFreeAiConnection(deps.readSettings(), provider))
  })

  ipcMain.handle(
    FREE_AI_IPC_CHANNELS.quota,
    async (_event, input: unknown): Promise<FreeAiQuota | null> => {
      // Gemini has no endpoint that tells the remaining free requests
      if (providerOf(input) !== 'openrouter') return null
      return openRouterFreeQuota(deps.readSettings().providers.openrouter?.apiKey ?? '')
    },
  )

  ipcMain.handle(FREE_AI_IPC_CHANNELS.openKeyPage, (_event, input: unknown) => {
    const provider = providerOf(input)
    if (provider) void openInBrowser(FREE_AI_KEY_PAGES[provider])
  })
}
