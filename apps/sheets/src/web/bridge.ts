import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createAiStreamBridge,
  createWebBridge,
  editMode,
  installWebBridge,
  onHostSaveRequest,
  reportDirty,
  reportError,
  reportOpened,
  saveToHost,
  unsupported,
  waitForDocument,
  WebUnsupportedError,
  webAiSettings,
  webLanguage,
} from '@seuoffice/web-platform'
import {
  saveEditsChunkArraySchema,
  workbookFileSchema,
  workbookSaveRequestSchema,
  type DesktopApi,
  type MenuAction,
  type WorkbookFile,
  type WorkbookSaveRequest,
  type WorkbookSaveResult,
} from '../shared/desktop-api'
import { SaveEditsTransferStore } from '../main/save-edits-transfer'
import { resolveWorkbookSave } from '../main/workbook-save-resolve'
import { WasmSidecarClient, type SidecarOpenResult } from './wasm-sidecar-client'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

let client: WasmSidecarClient | undefined
const engine = (): WasmSidecarClient => (client ??= new WasmSidecarClient())

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The workbook open in the engine: its /work file, its bytes and its sheet ids */
interface WebSession {
  readonly sessionId: string
  /** the host's name for the document; saves go back under it */
  readonly fileName: string
  readonly virtualPath: string
  /** the file under /work the engine session reads */
  readonly engineName: string
  readonly bytes: Uint8Array
  /** Univer sheet id → file sheet name, as the desktop session keeps it */
  readonly sheetNames: ReadonlyMap<string, string>
}

// One document per page: the embed hands over a single workbook.
let current: WebSession | undefined

async function adopt(
  opened: SidecarOpenResult,
  bytes: Uint8Array,
  names: Pick<WebSession, 'fileName' | 'virtualPath' | 'engineName'>,
): Promise<WorkbookFile> {
  current = {
    ...names,
    sessionId: opened.sessionId,
    bytes,
    sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
  }
  return workbookFileSchema.parse({
    ...opened,
    // the renderer-facing path is the virtual one: the engine's /work path is an implementation detail
    path: names.virtualPath,
    sha256: await sha256Hex(bytes),
    fileBytes: bytes.length,
    readOnly: !editMode(),
    needsSaveAs: false,
    restoredFromRecovery: false,
    // no recovery copies on the web: nothing is written back
    automaticRecoveryDisabled: true,
  })
}

// The queued document is handed out once: the renderer asks hasQueuedWorkbook at boot and again after mount.
let queuedOpened: Promise<WorkbookFile | null> | undefined

// Files under /work get names of their own: a document called like a save target
// (or any other name) can never be the file a save writes over.
let engineFiles = 0
function engineFileName(extension: string): string {
  engineFiles += 1
  return `workbook-${engineFiles}${extension}`
}

async function openQueuedDocument(): Promise<WorkbookFile | null> {
  const doc = await waitForDocument()
  if (!doc) return null
  try {
    const engineName = engineFileName(/\.[^./]+$/.exec(doc.fileName)?.[0].toLowerCase() ?? '')
    const enginePath = await engine().put(engineName, doc.bytes)
    const opened = await engine().open(enginePath, navigator.language)
    return await adopt(opened, doc.bytes, {
      fileName: doc.fileName,
      virtualPath: doc.virtualPath,
      engineName,
    })
  } catch (error) {
    reportError('open_failed', error instanceof Error ? error.message : String(error))
    throw error
  }
}

// Large saves stage their cell edits in chunks first, as they do over the desktop IPC.
const transfers = new SaveEditsTransferStore()

// Bumps each time the host stored the bytes of a save
let deliveredCount = 0
let lastSaveError: string | undefined

function withTransferredEdits(request: WorkbookSaveRequest): WorkbookSaveRequest {
  if (request.editsTransferId === undefined) return request
  if (request.edits.length > 0) throw new Error('Save request mixes inline and transferred edits.')
  return { ...request, edits: transfers.take(request.editsTransferId, request.sessionId) }
}

/**
 * The desktop save handler's web counterpart: the engine writes the edited
 * package, reopens it to prove it reads back, and the host stores the bytes
 * before the session moves to the saved workbook. A refused store leaves the
 * session and its pending edits as they were.
 */
async function saveWorkbookEdits(input: WorkbookSaveRequest): Promise<WorkbookSaveResult> {
  try {
    if (!editMode()) throw new WebUnsupportedError('sheets.save')
    // Save As (another name or format) and MCP path saves need a file system
    if (input.mode !== 'save' || input.targetPath !== undefined) {
      throw new WebUnsupportedError('sheets.saveAs')
    }
    const request = withTransferredEdits(workbookSaveRequestSchema.parse(input))
    const session = current
    if (!session || session.sessionId !== request.sessionId) {
      throw new Error('Unknown workbook session.')
    }
    // the saved package keeps the source's type (.xlsm keeps its macros)
    const target = engineFileName(/\.[^.]+$/.exec(session.engineName)?.[0] ?? '.xlsx')
    const saved = await engine().save(
      session.engineName,
      target,
      resolveWorkbookSave(session.sheetNames, request),
    )
    let opened: SidecarOpenResult
    try {
      opened = await engine().open(`/work/${target}`, navigator.language)
    } catch (error) {
      await engine().drop(target)
      throw error
    }
    try {
      await saveToHost(session.fileName, saved.bytes)
    } catch (error) {
      await engine().close(opened.sessionId).catch(noop)
      await engine().drop(target).catch(noop)
      throw error
    }
    deliveredCount += 1
    await engine().close(session.sessionId).catch(noop)
    await engine().drop(session.engineName).catch(noop)
    transfers.discardSession(session.sessionId)
    const file = await adopt(opened, saved.bytes, { ...session, engineName: target })
    return { canceled: false, file, touchedEntries: [...saved.touchedEntries] }
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error)
    throw error
  }
}

// The renderer's close-guard save runs its normal save and reports whether the journal drained.
let closeSave: (() => void) | undefined
let closeSaveSettled: ((ok: boolean) => void) | undefined

/** The host's `request_save`: the app's own save, or the workbook as it is when nothing is pending */
async function runHostSave(): Promise<void> {
  const run = closeSave
  const session = current
  if (!run || !session) throw new Error('the workbook is not open yet')
  const delivered = deliveredCount
  lastSaveError = undefined
  const ok = await new Promise<boolean>((resolve) => {
    closeSaveSettled = resolve
    run()
  })
  closeSaveSettled = undefined
  if (!ok) throw new Error(lastSaveError ?? 'the workbook was not saved')
  if (deliveredCount === delivered) await saveToHost(session.fileName, session.bytes)
}

// Host requests run one after another: each waits on the single close-save answer.
let hostSaves: Promise<void> = Promise.resolve()
function saveForHost(): Promise<void> {
  const next = hostSaves.then(runHostSave, runHostSave)
  hostSaves = next.catch(noop)
  return next
}

/** Ctrl+S / Cmd+S runs the app's save, as the desktop menu accelerator does */
function onSaveShortcut(callback: (action: MenuAction) => void): () => void {
  if (!editMode()) return noop
  const onKey = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 's') return
    event.preventDefault()
    callback('save')
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}

// A member set to undefined turns its feature off: the renderer feature-detects it, as without a shell.
type WebDesktopApi = { [K in keyof DesktopApi]?: DesktopApi[K] | undefined }

// AI turns go to the embed host, which calls its gateway (decision 0017)
const ai = createAiStreamBridge()

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
  getAiSettings: webAiSettings,
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
    // a save already closed the session it replaced
    if (current?.sessionId !== sessionId) return
    transfers.discardSession(sessionId)
    await engine().close(sessionId)
  },
  saveWorkbookEdits,
  beginSaveEditsTransfer: async (request) => transfers.begin(request),
  sendSaveEditsChunk: async (request) =>
    transfers.addChunk({
      sessionId: request.sessionId,
      transferId: request.transferId,
      seq: request.seq,
      edits: saveEditsChunkArraySchema.parse(JSON.parse(request.editsJson)),
    }),
  abortSaveEditsTransfer: async (request) =>
    transfers.discard(request.transferId, request.sessionId),
  onMenuAction: onSaveShortcut,
  onCloseSaveRequest: (callback) => {
    closeSave = callback
    return () => {
      if (closeSave === callback) closeSave = undefined
    }
  },
  reportCloseSaveResult: (ok) => closeSaveSettled?.(ok),
  // the pending-edit count feeds the host's unsaved-changes flag
  notifyPendingEdits: (count) => {
    if (editMode()) reportDirty(count > 0)
  },
  // shell and desktop services that never fire on the web
  onChromePressed: unsubscribe,
  onSidecarCrashed: unsubscribe,
  onWorkbookRenamed: unsubscribe,
  onRecoveryNotice: unsubscribe,
  onRecoveryWriteNow: unsubscribe,
  onMcpCommand: unsubscribe,
  aiStream: ai.aiStream,
  aiStreamCancel: ai.aiStreamCancel,
  onAiStream: ai.onAiStream,
  reportMcpResult: noop,
  signalMcpReady: noop,
  headlessExportDone: noop,
  // desktop-only services: undefined turns their features off
  aiSubscription: undefined,
  aiToolCapabilities: undefined,
  // need a file system or a print pipeline
  writeWorkbookRecovery: unsupported('sheets.recovery'),
  exportPdf: unsupported('sheets.export'),
  exportCsv: unsupported('sheets.export'),
  printWorkbook: unsupported('sheets.print'),
}

export function installBridges(): void {
  installWebBridge(
    'desktopApi',
    createWebBridge<DesktopApi>('desktopApi', desktopApi as Partial<DesktopApi>),
  )
  installWebBridge('nativeSpell', createWebBridge('nativeSpell', {}))
  installWebBridge('__genofficeDebugHooks', createWebBridge('__genofficeDebugHooks', {}))
  if (editMode()) onHostSaveRequest(saveForHost)
}
