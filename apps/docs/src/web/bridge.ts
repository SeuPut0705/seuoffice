// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createWebBridge,
  installWebBridge,
  reportOpened,
  unsupported,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import type { DesktopApi } from '../shared/ipc'
import { openDocxFromBytes } from './open-docx'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// the document handed in by the embed, given to the renderer once (like the desktop's one-shot consume)
let pendingConsumed = false

const desktop: Partial<DesktopApi> = {
  getLanguage: async () => webLanguage() as Awaited<ReturnType<DesktopApi['getLanguage']>>,
  onLanguageChanged: unsubscribe,
  getSystemLocale: async () => navigator.language,
  getTheme: async () => 'system',
  onThemeChanged: unsubscribe,
  getDocumentTheme: async () => 'follow',
  onDocumentThemeChanged: unsubscribe,
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: unsubscribe,
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: unsubscribe,
  getAuthorName: async () => '',
  onAuthorNameChanged: unsubscribe,
  getAiSettings: async () => defaultAiSettings(),
  onAiSettingsChanged: unsubscribe,
  getRecentFiles: async () => [],
  consumePendingOpenDocx: async () => {
    if (pendingConsumed) return null
    pendingConsumed = true
    const doc = await waitForDocument()
    if (!doc) return null
    const result = await openDocxFromBytes(doc)
    if (result) queueMicrotask(reportOpened)
    return result
  },
  consumeNewBlankDoc: async () => false,
  consumeAiDocContent: async () => null,
  consumeDocCopy: async () => null,
  // no host fonts to read: the editor falls back to its bundled and CSS fonts
  fontMetrics: async () => null,
  fontFamilyInfo: async () => [],
  fetchImage: async (url) => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { base64: toBase64(bytes), mime: res.headers.get('content-type') ?? '' }
    } catch {
      return null
    }
  },
  armContextMenu: noop,
  spellDiag: noop,
  // shell, menu and recovery requests that never arrive on the web
  onOpenDocx: unsubscribe,
  onRenamedDocx: unsubscribe,
  onTeardown: unsubscribe,
  onWriteRecoveryNow: unsubscribe,
  onContextMenuRequest: unsubscribe,
  onViewImage: unsubscribe,
  reportViewMenuState: noop,
  onRecoveryCopyDropped: unsubscribe,
  onZoteroRequest: unsubscribe,
  onCloseCheck: unsubscribe,
  onCloseSaveRequest: unsubscribe,
  onMenuCommand: unsubscribe,
  consumeHeadlessExport: async () => null,
  // no password-protected files on the web, so no password intents to track
  docPasswordIntentRevision: async () => 0,
  discardDocPasswordIntents: async () => ({ ok: true }),
  openDocxDecrypt: unsupported('docs.decrypt'),
  setDocPassword: unsupported('docs.decrypt'),
  saveDocx: unsupported('docs.save'),
  saveDocxAs: unsupported('docs.save'),
  saveDocxNew: unsupported('docs.save'),
  saveDocxTo: unsupported('docs.save'),
  materializeDocx: unsupported('docs.save'),
  // feature-detected services the web lacks: undefined keeps those features off
  convertAltChunkHtml: undefined,
  onMcpCommand: undefined,
  reportMcpResult: undefined,
  signalMcpReady: undefined,
  kbList: undefined,
  aiToolCapabilities: undefined,
}

/** An object whose listed members are explicitly absent: the renderer's `typeof x === 'function'` probes see no service. */
const absent = (...keys: string[]): Record<string, undefined> =>
  Object.fromEntries(keys.map((key) => [key, undefined]))

// Shell-side bridges the desktop preload exposes next to `desktop`. The web has no shell, so none
// of their services exist; the renderer feature-detects each member and turns the feature off.
const shellBridges: Record<string, object> = {
  aiOfficeSplit: absent('getRole', 'onRoleChanged', 'requestFocus', 'reportFocus'),
  aiOfficeMcpTools: absent('list', 'call', 'cancel', 'onChanged', 'retry', 'openSettings'),
  aiOfficeOutbound: absent('internetToolsEnabled', 'confirmAddresses', 'onInternetToolsChanged'),
  aiOfficeUserSkills: absent(
    'list',
    'aiRead',
    'aiReadFile',
    'openSettings',
    'onChanged',
    'suggestName',
    'checkName',
    'saveFromCard',
    'openTemplate',
    'openPreview',
    'previewOriginal',
    'finishPreview',
    'takeHandoff',
    'focusTab',
    'onPreviewEnded',
  ),
  aiOfficeDriveAi: absent(
    'driveAiEnabled',
    'driveSearch',
    'driveRead',
    'onDriveAiChanged',
    'driveConnected',
    'onDriveConnectedChanged',
    'drivePickAttachments',
  ),
  aiOfficeDocs: absent('list', 'available', 'pick'),
  aiOfficeSubscription: absent('statuses', 'onChanged'),
  // the AI panel calls these without probing, and every call site already swallows a rejection
  projectApi: {
    loadChat: unsupported('docs.project-chat'),
    appendChat: unsupported('docs.project-chat'),
    resolveChat: unsupported('docs.project-chat'),
    rebindChat: unsupported('docs.project-chat'),
  },
  projectFolderApi: absent(
    'getSelection',
    'readContext',
    'openScope',
    'closeScope',
    'listFiles',
    'search',
    'read',
    'remember',
    'openChat',
    'appendChat',
    'onChatMessageAppended',
    'onOpenChat',
    'onProjectChanged',
    'listProjects',
    'getDefaultParentFolder',
  ),
}

export function installBridges(): void {
  installWebBridge('desktop', createWebBridge<DesktopApi>('desktop', desktop))
  for (const [name, members] of Object.entries(shellBridges)) {
    installWebBridge(name, createWebBridge(name, members))
  }
}
