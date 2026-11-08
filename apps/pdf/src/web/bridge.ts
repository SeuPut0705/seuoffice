// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
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
import type { PdfApi } from '../shared/ipc'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

function bytesOf(path: string): Uint8Array {
  const doc = documentByPath(path)
  if (!doc) throw new Error(`seuoffice web: no document at ${path}`)
  return doc.bytes
}

const pdfApi: Partial<PdfApi> = {
  consumePending: async () => (await waitForDocument())?.virtualPath ?? null,
  readFile: async (path) => {
    const bytes = bytesOf(path)
    queueMicrotask(reportOpened)
    return bytes.slice().buffer
  },
  getLanguage: async () => webLanguage() as Lang,
  onLanguageChanged: unsubscribe,
  getTheme: async () => 'system',
  onThemeChanged: unsubscribe,
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  onAiPanelPrefsChanged: unsubscribe,
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  onAutoSaveDefaultChanged: unsubscribe,
  getUsername: async () => '',
  getAiSettings: async () => defaultAiSettings(),
  onAiSettingsChanged: unsubscribe,
  imageGenerationAvailable: async () => false,
  listDigitalSignatures: async () => [],
  reportUnprotectable: async () => null,
  isUntitledCopy: async () => false,
  recoveryState: async () => ({ unsaved: false }),
  listEditFonts: async () => [],
  listStaticFormFills: async () => [],
  setDirty: noop,
  // menu and shell requests that never arrive on the web
  onSaveAsFlow: unsubscribe,
  onRecoveryFlushRequest: unsubscribe,
  onRecoveryDropped: unsubscribe,
  onCloseSaveRequest: unsubscribe,
  onSaveAsRequest: unsubscribe,
  onPrintRequest: unsubscribe,
  onExportImagesRequest: unsubscribe,
  onConvertDialogRequest: unsubscribe,
  onFileRenamed: unsubscribe,
  decryptPdf: unsupported('pdf.decrypt'),
  save: unsupported('pdf.save'),
  // desktop-only services: undefined turns their features off, as without a shell
  structure: undefined,
  store: undefined,
  subscription: undefined,
  noteOpen: undefined,
}

export function installBridges(): void {
  installWebBridge('pdfApi', createWebBridge<PdfApi>('pdfApi', pdfApi))
}
