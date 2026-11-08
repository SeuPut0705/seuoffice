import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createWebBridge,
  installWebBridge,
  reportError,
  reportOpened,
  unsupported,
  viewMode,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import { workbookFileSchema, type DesktopApi, type WorkbookFile } from '../shared/desktop-api'
import { WasmSidecarClient } from './wasm-sidecar-client'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

let client: WasmSidecarClient | undefined
const engine = (): WasmSidecarClient => (client ??= new WasmSidecarClient())

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// The queued document is handed out once: the renderer asks hasQueuedWorkbook at boot and again after mount.
let queuedOpened: Promise<WorkbookFile | null> | undefined

async function openQueuedDocument(): Promise<WorkbookFile | null> {
  const doc = await waitForDocument()
  if (!doc) return null
  try {
    const enginePath = await engine().put(doc.fileName, doc.bytes)
    const opened = await engine().open(enginePath, navigator.language)
    return workbookFileSchema.parse({
      ...opened,
      // the renderer-facing path is the virtual one: the engine's /work path is an implementation detail
      path: doc.virtualPath,
      sha256: await sha256Hex(doc.bytes),
      fileBytes: doc.bytes.length,
      readOnly: viewMode(),
      needsSaveAs: false,
      restoredFromRecovery: false,
      // no recovery copies on the web: nothing is written back
      automaticRecoveryDisabled: true,
    })
  } catch (error) {
    reportError('open_failed', error instanceof Error ? error.message : String(error))
    throw error
  }
}

// A member set to undefined turns its feature off: the renderer feature-detects it, as without a shell.
type WebDesktopApi = { [K in keyof DesktopApi]?: DesktopApi[K] | undefined }

const desktopApi: WebDesktopApi = {
  getLanguage: async () => webLanguage() as Awaited<ReturnType<DesktopApi['getLanguage']>>,
  onLanguageChanged: unsubscribe,
  getTheme: async () => 'system',
  onThemeChanged: unsubscribe,
  getDocumentTheme: async () => 'follow',
  onDocumentThemeChanged: unsubscribe,
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: unsubscribe,
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: unsubscribe,
  getAiSettings: async () => defaultAiSettings(),
  onAiSettingsChanged: unsubscribe,
  getUserDisplayName: async () => '',
  onUserDisplayNameChanged: unsubscribe,
  hasQueuedWorkbook: async () => (await waitForDocument()) !== null && queuedOpened === undefined,
  consumeNewBlankWorkbook: async () => false,
  consumeHeadlessExport: async () => null,
  selectWorkbook: async () => {
    if (queuedOpened !== undefined) return null
    queuedOpened = openQueuedDocument()
    return queuedOpened
  },
  readWorkbookRange: async (request) => {
    const result = await engine().readRange(request)
    reportOpened()
    return result
  },
  closeWorkbook: async (sessionId) => {
    await engine().close(sessionId)
  },
  // shell and desktop services that never fire on the web
  onChromePressed: unsubscribe,
  onSidecarCrashed: unsubscribe,
  onMenuAction: unsubscribe,
  onWorkbookRenamed: unsubscribe,
  onCloseSaveRequest: unsubscribe,
  onRecoveryNotice: unsubscribe,
  onRecoveryWriteNow: unsubscribe,
  onMcpCommand: unsubscribe,
  onAiStream: unsubscribe,
  notifyPendingEdits: noop,
  reportCloseSaveResult: noop,
  reportMcpResult: noop,
  signalMcpReady: noop,
  headlessExportDone: noop,
  // desktop-only services: undefined turns their features off
  aiSubscription: undefined,
  aiToolCapabilities: undefined,
  // edits and saves need the desktop
  saveWorkbookEdits: unsupported('sheets.save'),
  writeWorkbookRecovery: unsupported('sheets.save'),
  exportPdf: unsupported('sheets.save'),
  exportCsv: unsupported('sheets.save'),
  printWorkbook: unsupported('sheets.save'),
}

export function installBridges(): void {
  installWebBridge(
    'desktopApi',
    createWebBridge<DesktopApi>('desktopApi', desktopApi as Partial<DesktopApi>),
  )
  installWebBridge('nativeSpell', createWebBridge('nativeSpell', {}))
  installWebBridge('__genofficeDebugHooks', createWebBridge('__genofficeDebugHooks', {}))
}
