// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createWebBridge,
  documentByPath,
  editMode,
  installWebBridge,
  onHostSaveRequest,
  reportDirty,
  reportOpened,
  unsupported,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import type { Lang } from '@genoffice/i18n'
import type { PdfApi, SavePdfRequest, SavePdfResult } from '../shared/ipc'
import { saveOnWeb, viewOnlyReason } from './save'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

function bytesOf(path: string): Uint8Array {
  const doc = documentByPath(path)
  if (!doc) throw new Error(`seuoffice web: no document at ${path}`)
  return doc.bytes
}

// The host stores saves only in edit mode; elsewhere the page stays a viewer
const editing = editMode()

let lastSaveError: string | undefined

async function save(request: SavePdfRequest): Promise<SavePdfResult> {
  const doc = documentByPath(request.path)
  const result = doc
    ? await saveOnWeb(doc, request)
    : { ok: false as const, error: `seuoffice web: no document at ${request.path}` }
  lastSaveError = result.ok ? undefined : result.error
  return result
}

// The renderer's own save runs through its close-save request, the way the
// desktop shell asks for one, and answers through sendCloseSaveResult in order
let closeSaveRequest: ((opts: { flushAll: boolean }) => void) | undefined
const closeSaveAnswers: ((ok: boolean) => void)[] = []

function saveForHost(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!closeSaveRequest) {
      reject(new Error('the document is not ready to save'))
      return
    }
    lastSaveError = undefined
    closeSaveAnswers.push((ok) =>
      ok ? resolve() : reject(new Error(lastSaveError ?? 'the document was not saved')),
    )
    closeSaveRequest({ flushAll: true })
  })
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
  setDirty: editing ? reportDirty : noop,
  onCloseSaveRequest: (handler) => {
    closeSaveRequest = handler
    return () => {
      if (closeSaveRequest === handler) closeSaveRequest = undefined
    }
  },
  sendCloseSaveResult: (ok) => closeSaveAnswers.shift()?.(ok),
  // menu and shell requests that never arrive on the web
  onSaveAsFlow: unsubscribe,
  onRecoveryFlushRequest: unsubscribe,
  onRecoveryDropped: unsubscribe,
  onSaveAsRequest: unsubscribe,
  onPrintRequest: unsubscribe,
  onExportImagesRequest: unsubscribe,
  onConvertDialogRequest: unsubscribe,
  onFileRenamed: unsubscribe,
  decryptPdf: unsupported('pdf.decrypt'),
  save: editing ? save : unsupported('pdf.save'),
  // the host keeps edits only in edit mode; elsewhere the view is read-only
  readOnlyReason: editing ? undefined : viewOnlyReason(),
  // desktop-only services: undefined turns their features off, as without a shell
  structure: undefined,
  store: undefined,
  subscription: undefined,
  noteOpen: undefined,
}

export function installBridges(): void {
  installWebBridge('pdfApi', createWebBridge<PdfApi>('pdfApi', pdfApi))
  if (editing) onHostSaveRequest(saveForHost)
}
