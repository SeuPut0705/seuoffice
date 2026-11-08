import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import {
  createWebBridge,
  documentByPath,
  installWebBridge,
  reportOpened,
  unsupported,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import type { Lang } from '@genoffice/i18n'
import type { HwpApi } from '../shared/ipc'
import { openHwpFromBytes } from './open-hwp'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

let trackingDropped = false

const hwpApi: Partial<HwpApi> = {
  consumePending: async () => (await waitForDocument())?.virtualPath ?? null,
  untitledCopy: async () => null,
  readFile: async (path) => {
    const doc = documentByPath(path)
    if (!doc) throw new Error(`seuoffice web: no document at ${path}`)
    const opened = openHwpFromBytes(doc)
    if (!opened) throw new Error('seuoffice web: hwp refused')
    trackingDropped = opened.trackingDropped
    queueMicrotask(reportOpened)
    return opened.bytes
  },
  trackingDropped: async () => trackingDropped,
  getLanguage: async () => webLanguage() as Lang,
  onLanguageChanged: unsubscribe,
  getTheme: async () => 'system',
  onThemeChanged: unsubscribe,
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  setAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: unsubscribe,
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: unsubscribe,
  getAiSettings: async () => defaultAiSettings(),
  onAiSettingsChanged: unsubscribe,
  getAuthorName: async () => ({ value: '', fallback: '' }),
  getMemoModalOpen: async () => false,
  setMemoModalOpen: noop,
  setDirty: noop,
  abortSave: noop,
  sendCloseSaveResult: noop,
  sendReadBytesResult: noop,
  sendRecoveryFlushed: noop,
  requestFileCommand: noop,
  headlessExportDone: noop,
  consumeHeadlessExport: async () => null,
  recoveryBegin: async () => ({ ok: false }),
  recoveryOpened: async () => ({ restored: false, notice: null }),
  getPathForFile: () => '',
  openDroppedDocuments: () => false,
  aiToolCapabilities: async () => null,
  // menu and shell requests that never arrive on the web
  onSaveRequest: unsubscribe,
  onPrintRequest: unsubscribe,
  onPreviewRequest: unsubscribe,
  onCloseSaveRequest: unsubscribe,
  onMemoBlocked: unsubscribe,
  onReadBytesRequest: unsubscribe,
  onRecoveryFlush: unsubscribe,
  onRecoveryReset: unsubscribe,
  onAiStream: unsubscribe,
  beginSave: unsupported('hwp.save'),
  commitSave: unsupported('hwp.save'),
  newTabs: unsupported('hwp.save'),
  recoveryNewTabs: unsupported('hwp.save'),
  recoveryWrite: unsupported('hwp.save'),
  printPages: unsupported('hwp.print'),
  aiStream: unsupported('hwp.ai'),
  // desktop-only services: undefined turns their features off, as without a shell
  aiSubscription: undefined,
  pickAttachments: undefined,
  addAttachmentPaths: undefined,
  addPastedImage: undefined,
  readAttachment: undefined,
  readAttachmentImage: undefined,
  readAttachmentDocument: undefined,
  analyzeMedia: undefined,
  openAiModelSettings: undefined,
  readUrl: undefined,
  imageSearch: undefined,
  generateImage: undefined,
  fetchImage: undefined,
  aiStreamCancel: undefined,
}

export function installBridges(): void {
  installWebBridge('hwpApi', createWebBridge<HwpApi>('hwpApi', hwpApi))
}
