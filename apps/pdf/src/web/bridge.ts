import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createAiStreamBridge,
  createWebBridge,
  documentByPath,
  editMode,
  installWebBridge,
  onHostSaveRequest,
  registerCollabCapable,
  reportDirty,
  reportError,
  reportOpened,
  unsupported,
  waitForDocument,
  webAiSettings,
  webLanguage,
  type PageCollab,
} from '@seuoffice/web-platform'
import type { Lang } from '@genoffice/i18n'
import { CertificateEncryptionError, WrongPasswordError, decryptDocument } from '../main/pdf-crypt'
import type { PdfApi, SavePdfRequest, SavePdfResult } from '../shared/ipc'
import { joinPdfCollab, type PdfCollabHandles } from './collab-join'
import { saveOnWeb, viewOnlyReason } from './save'

// `ready` must say so before anything asks for the document
registerCollabCapable()

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

/** set when the host asked for co-editing and the page joined its session */
let coEditing: PageCollab<PdfCollabHandles> | null = null

async function save(request: SavePdfRequest): Promise<SavePdfResult> {
  if (coEditing) {
    // the session writes the file of one exact version from the log, never the renderer's
    // own request. "external-modified" keeps the renderer from reloading the document from
    // the file it thinks it saved, which would drop every pending edit on this page.
    try {
      await coEditing.save()
      lastSaveError = undefined
      return { ok: false, error: 'external-modified' }
    } catch (error) {
      lastSaveError = error instanceof Error ? error.message : String(error)
      return { ok: false, error: lastSaveError }
    }
  }
  const doc = documentByPath(request.path)
  const result = doc
    ? await saveOnWeb(doc, request)
    : { ok: false as const, error: `seuoffice web: no document at ${request.path}` }
  lastSaveError = result.ok ? undefined : result.error
  return result
}

/**
 * The page's document, once: a co-edited one joins the host's session before
 * the renderer reads it, and a later joiner reads the session's base file.
 */
let pending: Promise<string | null> | undefined
async function consumeDocument(): Promise<string | null> {
  const doc = await waitForDocument()
  if (!doc) return null
  try {
    coEditing = await joinPdfCollab(doc)
  } catch (error) {
    reportError('collab_unavailable', error instanceof Error ? error.message : String(error))
    return null
  }
  if (coEditing) doc.bytes = coEditing.baseBytes
  return doc.virtualPath
}

/** The desktop decrypt handler over the page's bytes: same results, same refusals */
const decryptPdf: PdfApi['decryptPdf'] = async (bytes, password) => {
  try {
    const opened = await decryptDocument(bytes, password)
    return {
      ok: true,
      bytes: opened.bytes,
      permissions: opened.permissions,
      neededPassword: opened.neededPassword,
      unlockedAs: opened.unlockedAs,
    }
  } catch (err) {
    if (err instanceof WrongPasswordError) return { ok: false, reason: 'wrong-password' }
    if (err instanceof CertificateEncryptionError) {
      return { ok: false, reason: 'certificate-encryption' }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
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

// AI turns go to the embed host, which calls its gateway (decision 0017)
const ai = createAiStreamBridge()

const pdfApi: Partial<PdfApi> = {
  consumePending: () => (pending ??= consumeDocument()),
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
  getAiSettings: webAiSettings,
  aiStream: ai.aiStream,
  aiStreamCancel: ai.aiStreamCancel,
  onAiStream: ai.onAiStream,
  onAiSettingsChanged: unsubscribe,
  imageGenerationAvailable: async () => false,
  listDigitalSignatures: async () => [],
  reportUnprotectable: async () => null,
  isUntitledCopy: async () => false,
  recoveryState: async () => ({ unsaved: false }),
  listEditFonts: async () => [],
  listStaticFormFills: async () => [],
  // a co-edited page's unsaved flag follows the session (collab-page.ts), not this renderer
  setDirty: editing
    ? (dirty) => {
        if (!coEditing) reportDirty(dirty)
      }
    : noop,
  onCloseSaveRequest: (handler) => {
    closeSaveRequest = handler
    return () => {
      if (closeSaveRequest === handler) closeSaveRequest = undefined
    }
  },
  sendCloseSaveResult: (ok) => closeSaveAnswers.shift()?.(ok),
  // the page's document comes from the host, not a file another program can change
  watchDiskFile: async () => false,
  onDiskFileChanged: unsubscribe,
  discardForDiskReload: async () => false,
  // menu and shell requests that never arrive on the web
  onSaveAsFlow: unsubscribe,
  onRecoveryFlushRequest: unsubscribe,
  onRecoveryDropped: unsubscribe,
  onSaveAsRequest: unsubscribe,
  onPrintRequest: unsubscribe,
  onExportImagesRequest: unsubscribe,
  onConvertDialogRequest: unsubscribe,
  onFileRenamed: unsubscribe,
  decryptPdf,
  // pdfium probes and renders of the text, image, insert and redaction tools: the
  // renderer catches each rejection, keeps the edit pending, and the web save
  // refuses it with a message
  validateTextEdits: unsupported('pdf.validateTextEdits'),
  pagePreviewPng: unsupported('pdf.pagePreviewPng'),
  pageImagePng: unsupported('pdf.pageImagePng'),
  listPageImages: unsupported('pdf.listPageImages'),
  canDrawText: unsupported('pdf.canDrawText'),
  requestRedactionCopy: unsupported('pdf.redaction'),
  // signatures reused across documents live in the desktop app data folder
  listSavedSignatures: unsupported('pdf.savedSignatures'),
  addSavedSignature: unsupported('pdf.savedSignatures'),
  removeSavedSignature: unsupported('pdf.savedSignatures'),
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
