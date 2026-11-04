import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  collabLink,
  createAiStreamBridge,
  createWebBridge,
  editMode,
  installWebBridge,
  onHostSaveRequest,
  registerCollabCapable,
  reportDirty,
  reportError,
  reportOpened,
  saveToHost,
  unsupported,
  waitForDocument,
  WebUnsupportedError,
  webAiSettings,
  webLanguage,
  type PageCollab,
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
import type { SheetsRendererHandles } from './collab-join'
import { WasmSidecarClient, type SidecarOpenResult } from './wasm-sidecar-client'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

// Before the page announces ready: this page can co-edit when the host asks for it
registerCollabCapable()

/** The co-editing session when the host asked for one: saves then go through it */
let collab: PageCollab<SheetsRendererHandles> | null = null

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
    // joined before anything opens: a session already running hands back its base file
    // pages the host did not ask to co-edit never load the adapter or the engine
    if (collabLink()) {
      const { joinSheetsCollab } = await import('./collab-join')
      collab = await joinSheetsCollab(doc.fileName, doc.bytes)
    }
    const bytes = collab?.baseBytes ?? doc.bytes
    const engineName = engineFileName(/\.[^./]+$/.exec(doc.fileName)?.[0].toLowerCase() ?? '')
    const enginePath = await engine().put(engineName, bytes)
    const opened = await engine().open(enginePath, navigator.language)
    return await adopt(opened, bytes, {
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
  // A co-edited workbook is saved at one version of the session, by the host, without a reopen
  if (collab) {
    await collab.save()
    return { canceled: true }
  }
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

/**
 * The bytes of the workbook as edited, written to scratch files the session
 * never adopts: the co-editing save, which must leave the editor untouched.
 *
 * The engine writes a defined-names snapshot only onto a package whose rows,
 * columns and sheets are final. The app's own save splits such a request in
 * two saves with a reopen between them; here nothing reopens, and the journal
 * lasts the whole session, so the split happens in place: everything but the
 * names first, then the names onto that file.
 */
async function workbookTemplateBytes(
  input: WorkbookSaveRequest,
): Promise<{ ok: boolean; bytes?: Uint8Array }> {
  // Only a co-editing page asks for a copy; the app's other caller (a skill's template) has no
  // web counterpart, and its request would not be checked by this page's own bounds.
  if (!collab) return { ok: false }
  const targets: string[] = []
  try {
    // split out with the adapter: only a co-editing page reaches here
    const { coEditedSaveRequest } = await import('./collab-save')
    const checked = coEditedSaveRequest(input)
    const session = current
    if (!session || session.sessionId !== input.sessionId) {
      throw new Error('Unknown workbook session.')
    }
    // nothing a save writes was edited yet: the workbook is the file the session started from
    if (checked === null) return { ok: true, bytes: session.bytes }
    const request = withTransferredEdits(checked)
    const scratch = (): string => {
      const name = engineFileName(/\.[^.]+$/.exec(session.engineName)?.[0] ?? '.xlsx')
      targets.push(name)
      return name
    }
    const save = resolveWorkbookSave(session.sheetNames, request)
    const names = save.definedNamesState ?? null
    const reshapes =
      save.sheetPlan !== undefined ||
      (save.structuralOps ?? []).some((sheet) => sheet.ops.length > 0)
    if (names === null || !reshapes) {
      return { ok: true, bytes: (await engine().save(session.engineName, scratch(), save)).bytes }
    }
    const reshaped = scratch()
    await engine().save(session.engineName, reshaped, { ...save, definedNamesState: null })
    const named = await engine().save(reshaped, scratch(), { edits: [], definedNamesState: names })
    return { ok: true, bytes: named.bytes }
  } catch (error) {
    // the renderer reports only "not written" and the session then stops: keep the reason
    console.error('[co-editing] the workbook could not be written', error)
    throw error
  } finally {
    for (const target of targets) await engine().drop(target).catch(noop)
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
    if (collab)
      void collab.save().catch((error: unknown) => console.error('[co-editing] save failed', error))
    else callback('save')
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
  readWorkbookRedactions: async (request) => {
    const session = current
    if (!session || session.sessionId !== request.sessionId) {
      throw new Error('Unknown workbook session.')
    }
    return engine().readRedactions(session.engineName)
  },
  closeWorkbook: async (sessionId) => {
    // a save already closed the session it replaced
    if (current?.sessionId !== sessionId) return
    transfers.discardSession(sessionId)
    await engine().close(sessionId)
  },
  saveWorkbookEdits,
  workbookTemplateBytes,
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
  // the pending-edit count feeds the host's unsaved-changes flag; a co-editing session reports its own
  notifyPendingEdits: (count) => {
    if (editMode() && !collab) reportDirty(count > 0)
  },
  // shell and desktop services that never fire on the web
  onChromePressed: unsubscribe,
  onSidecarCrashed: unsubscribe,
  onWorkbookRenamed: unsubscribe,
  onRecoveryNotice: unsubscribe,
  onRecoveryWriteNow: unsubscribe,
  onMcpCommand: unsubscribe,
  // An AI run applies, reverts and re-applies its edits as one proposal and vetoes everything else
  // meanwhile, remote edits included, so co-editing turns it off
  aiStream: (...args) =>
    collab
      ? Promise.reject(new WebUnsupportedError('sheets.aiWhileCoEditing'))
      : ai.aiStream(...args),
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
  // a web query is fetched by main through its SSRF gate: the page lists none, so Refresh query stays hidden
  listWorkbookConnections: async () => ({ connections: [] }),
  refreshWorkbookConnection: unsupported('sheets.queryRefresh'),
}

export function installBridges(): void {
  installWebBridge(
    'desktopApi',
    createWebBridge<DesktopApi>('desktopApi', desktopApi as Partial<DesktopApi>),
  )
  installWebBridge('nativeSpell', createWebBridge('nativeSpell', {}))
  installWebBridge('__genofficeDebugHooks', createWebBridge('__genofficeDebugHooks', {}))
  // aiNamingApi stays absent: suggestFileName reads a missing one as "no shell" and offers no name
  if (editMode()) onHostSaveRequest(saveForHost)
}
