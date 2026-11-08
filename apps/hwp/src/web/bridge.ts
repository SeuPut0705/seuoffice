import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import {
  createWebBridge,
  documentByPath,
  editMode,
  installWebBridge,
  onHostSaveRequest,
  reportDirty,
  reportOpened,
  saveToHost,
  unsupported,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import type { WebDocument } from '@seuoffice/web-platform'
import type { Lang } from '@genoffice/i18n'
import { READ_ONLY_ATTRIBUTE } from '../../studio-plugin/read-only.mjs'
import { hwpFormatOfPath } from '../shared/ipc'
import type { CommitSaveResult, HwpApi, HwpFormat, SaveMode } from '../shared/ipc'
import { openHwpFromBytes } from './open-hwp'
import type { OpenedHwp } from './open-hwp'
import { newTabSpots, webSaveBytes } from './save-hwp'
import { watchSaveKey } from './save-key'

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

/** `?mode=edit`: the host stores what this page saves */
const canSave = editMode()

let trackingDropped = false
/** the document this page opened, and what its saves correct against */
let opened: { doc: WebDocument; hwp: OpenedHwp } | null = null
/** the format `beginSave` settled on; `newTabs` and `commitSave` need one */
let pendingFormat: HwpFormat | null = null
/** the renderer's save handlers; the editor's File menu, Ctrl+S and the host send to them */
const saveListeners = new Set<(mode: SaveMode) => void>()
/** the save a host request started, settled when that save ends */
let hostSave: { resolve: () => void; reject: (error: Error) => void } | null = null

function requestSave(mode: SaveMode): void {
  for (const listener of saveListeners) listener(mode)
}

/** the end of a save, as the desktop main process's `settleSave` sees it */
function settleSave(ok: boolean, error = 'hwp: the document was not saved'): void {
  const waiter = hostSave
  hostSave = null
  if (!waiter) return
  if (ok) waiter.resolve()
  else waiter.reject(new Error(error))
}

/**
 * The save half of the desktop main process (hwp-main.ts `beginSave`, `newTabs`, `commitSave`)
 * for a page in edit mode: one target, the opened name in its own format, and the host in
 * place of the disk. Save As to another name or format is not offered.
 */
const saveApi: Partial<HwpApi> = {
  setDirty: reportDirty,
  abortSave: () => {
    pendingFormat = null
    settleSave(false)
  },
  onSaveRequest: (listener) => {
    saveListeners.add(listener)
    return () => saveListeners.delete(listener)
  },
  requestFileCommand: (command) => {
    if (command === 'save') requestSave('save')
  },
  beginSave: async () => {
    pendingFormat = null
    const refuse = (error: string, reason?: 'tracked') => {
      settleSave(false, error)
      return { ok: false as const, error, ...(reason ? { reason } : {}) }
    }
    if (!opened) return refuse('hwp: no document is open')
    if (opened.hwp.tracked) return refuse('hwp: the document has tracked changes', 'tracked')
    const format = hwpFormatOfPath(opened.doc.fileName)
    if (!format) return refuse('hwp: no save format for this file name')
    pendingFormat = format
    return { ok: true, path: opened.doc.virtualPath, format }
  },
  newTabs: async (data, format) => (pendingFormat ? newTabSpots(data, format) : []),
  commitSave: async (data, tabs) => {
    const format = pendingFormat
    pendingFormat = null
    const done = (result: CommitSaveResult): CommitSaveResult => {
      if (result.ok) settleSave(true)
      else settleSave(false, result.error)
      return result
    }
    if (!format || !opened) return done({ ok: false, error: 'hwp: no save in progress' })
    const fixed = webSaveBytes(opened.hwp.base, format, data, tabs)
    if (!fixed.ok) return done(fixed)
    try {
      await saveToHost(opened.doc.fileName, fixed.bytes)
    } catch (error) {
      return done({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    return done({
      ok: true,
      path: opened.doc.virtualPath,
      ...(fixed.tailsLost ? { tailsLost: true as const } : {}),
    })
  },
}

const hwpApi: Partial<HwpApi> = {
  consumePending: async () => (await waitForDocument())?.virtualPath ?? null,
  untitledCopy: async () => null,
  readFile: async (path) => {
    const doc = documentByPath(path)
    if (!doc) throw new Error(`seuoffice web: no document at ${path}`)
    const hwp = openHwpFromBytes(doc, canSave)
    if (!hwp) throw new Error('seuoffice web: hwp refused')
    trackingDropped = hwp.trackingDropped
    opened = { doc, hwp }
    queueMicrotask(reportOpened)
    return hwp.bytes
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
  ...(canSave ? saveApi : {}),
}

/** As long as the desktop main process waits for a requested save (hwp-main.ts `requestHwpSave`) */
const HOST_SAVE_TIMEOUT_MS = 120_000

/** One save the host asked for: settles when that save ends, however late */
function saveForHost(): Promise<void> {
  if (saveListeners.size === 0) {
    return Promise.reject(new Error('hwp: the document is not ready to save'))
  }
  return new Promise<void>((resolve, reject) => {
    hostSave = { resolve, reject }
    // the host asks for the bytes, so the save runs even when nothing changed: the renderer
    // answers 'saveAs' without asking the editor, and here both modes write the opened name
    requestSave('saveAs')
  })
}

export function installBridges(): void {
  installWebBridge('hwpApi', createWebBridge<HwpApi>('hwpApi', hwpApi))
  if (!canSave) {
    // a page the host does not store saves from shows the document and cannot change it;
    // set before the renderer makes the editor's frame, which reads it once at start-up
    document.documentElement.setAttribute(READ_ONLY_ATTRIBUTE, '')
    return
  }
  watchSaveKey(() => requestSave('save'))
  // One host request at a time, in arrival order. The next one starts only once the save before
  // it has really ended, even when its host stopped waiting: a late end would settle the next one.
  let previous: Promise<unknown> = Promise.resolve()
  onHostSaveRequest(() => {
    let refused = false
    // a request refused while it still waited for its turn starts no save
    const saved = previous.then(() => (refused ? undefined : saveForHost()))
    previous = saved.catch(() => {})
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        refused = true
        reject(new Error('hwp: the save did not finish in time'))
      }, HOST_SAVE_TIMEOUT_MS)
      saved.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  })
}
