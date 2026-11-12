import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createAiStreamBridge,
  createWebBridge,
  documentByPath,
  editMode,
  installWebBridge,
  joinPageCollab,
  onHostSaveRequest,
  registerCollabCapable,
  reportDirty,
  reportError,
  reportOpened,
  saveToHost,
  unsupported,
  waitForDocument,
  webAiSettings,
  webLanguage,
  type PageCollab,
  type WebDocument,
} from '@seuoffice/web-platform'
import { docFormatOfPath, prepareSaveBytes } from '../main/doc-format'
import {
  commitDocPasswordSave,
  currentDocPasswordIntentRevision,
  discardDocPasswordIntents,
  encryptDocx,
  setDocPassword,
  snapshotDocPassword,
} from '../main/docx-encryption'
import { notifySubEditorState } from '../renderer/editor/active-editor'
import type { DesktopApi } from '../shared/ipc'
import type { DocsOp } from './collab-adapter'
import type { DocsCollabHandles } from './collab-side'
import { WEB_RENDERER, openDecryptedDocx, openDocxFromBytes } from './open-docx'

// `ready` must say so before anything asks for the document
registerCollabCapable()

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

/** the reason the host gave for refusing the last save, for a host-asked save to report back */
let lastSaveError: string | undefined

/** set when the host asked for co-editing and the page joined its session */
let coEditing: PageCollab<DocsCollabHandles> | null = null

/** the renderer's author-name listeners: in co-editing the name is the one the session gives this user */
const authorListeners = new Set<(name: string) => void>()
let coEditAuthor = ''
let coEditUnsaved = false

/**
 * Track changes label this user's edits with the name the host gave the
 * session, so peers' revisions are told apart. The App draws its unsaved mark
 * from `window.seuCollab.unsaved()` when it renders; a peer's save or the
 * server's answer to this page's own changes nothing it renders from, so the
 * page asks for a render (the textbox editors' existing nudge) when the value
 * flips.
 */
function onSessionStatus(): void {
  const name = coEditing?.self()?.name ?? ''
  if (name !== coEditAuthor) {
    coEditAuthor = name
    for (const listener of authorListeners) listener(name)
  }
  const unsaved = window.seuCollab?.unsaved?.() ?? false
  if (unsaved !== coEditUnsaved) {
    coEditUnsaved = unsaved
    notifySubEditorState(false)
  }
}

/** The docx as the file the host stores: with the password the session wants on it */
async function fileBytes(path: string, data: Uint8Array) {
  const format = docFormatOfPath(path) ?? 'docx'
  const passwordState = format === 'docx' ? snapshotDocPassword(WEB_RENDERER, path) : null
  const { bytes } = await prepareSaveBytes(format, Buffer.from(data), {
    materialize: async (plain) => ({ bytes: plain, hashes: new Set() }),
    encrypt: encryptDocx,
    password: passwordState?.password ?? null,
  })
  return { bytes, passwordState }
}

/**
 * The desktop save's bytes without its file write: the docx takes the
 * password the session wants (the opened one unless the user changed it) and
 * goes to the host. Lazily served pictures are a desktop-only path: the web
 * document opens whole, so the renderer's bytes are already complete.
 */
const saveDocxToHost: DesktopApi['saveDocx'] = async (path, data) => {
  const doc = documentByPath(path)
  if (!doc) return { ok: false, error: 'save target is not an opened document' }
  try {
    if (coEditing) {
      // the session writes the file of one exact version from the log, never the renderer's
      // own bytes. "Intent pending" keeps the renderer from reloading the document from
      // the file it thinks it saved, which would replace every peer's edit on this page.
      await coEditing.save({ skipWhenSaved: true })
      return { ok: true, passwordIntentPending: true }
    }
    const { bytes, passwordState } = await fileBytes(path, new Uint8Array(data))
    await saveToHost(doc.fileName, bytes)
    const passwordIntentPending = passwordState
      ? commitDocPasswordSave(WEB_RENDERER, passwordState, path)
      : false
    return { ok: true, passwordIntentPending }
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error)
    return { ok: false, error: lastSaveError }
  }
}

/**
 * Join the host's co-editing session for `doc` before the renderer opens it;
 * a later joiner opens the session's base file, not the host's copy.
 */
async function joinDocsCollab(doc: WebDocument): Promise<void> {
  const page = await joinPageCollab<DocsCollabHandles, DocsOp>({
    // 4: run-level wrappers ride in the document (the `inlineWrap` mark), so the same file
    // opens as another document than under 3. 3: header and footer table rows are cell nodes,
    // text inserted then deleted is two revisions, and the room shares track changes.
    format: { name: 'docx', schema: 4 },
    status: onSessionStatus,
    fileName: doc.fileName,
    bytes: doc.bytes,
    adapter: async (handles) => {
      // the renderer's modules are loaded by now; a page that never co-edits never loads these
      const { openDocsCollab } = await import('./collab-side')
      return openDocsCollab(handles, {
        path: doc.virtualPath,
        fileName: doc.fileName,
        finish: async (docx) => (await fileBytes(doc.virtualPath, docx)).bytes,
      })
    },
  })
  if (!page) return
  coEditing = page
  doc.bytes = page.baseBytes
}

// The renderer's close-guard "Save" runs its full save until the document is
// persisted and reports the outcome; a host-asked save runs the same flow.
let closeSaveHandler: (() => void) | undefined
let settleCloseSave: ((ok: boolean) => void) | undefined
let hostSaves: Promise<void> = Promise.resolve()

function runHostSave(): Promise<void> {
  const run = async (): Promise<void> => {
    const handler = closeSaveHandler
    if (!handler) throw new Error('the document is not open yet')
    lastSaveError = undefined
    const ok = await new Promise<boolean>((resolve) => {
      settleCloseSave = resolve
      handler()
    })
    if (!ok) throw new Error(lastSaveError ?? 'the document was not saved')
  }
  const pass = hostSaves.then(run)
  hostSaves = pass.catch(() => {})
  return pass
}

// AI turns go to the embed host, which calls its gateway (decision 0017)
const ai = createAiStreamBridge()

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
  // the renderer reads it before the document opens; co-editing names this user once it attached
  getAuthorName: async () => coEditAuthor,
  onAuthorNameChanged: (listener) => {
    authorListeners.add(listener)
    return () => {
      authorListeners.delete(listener)
    }
  },
  getAiSettings: webAiSettings,
  aiStream: ai.aiStream,
  aiStreamCancel: ai.aiStreamCancel,
  onAiStream: ai.onAiStream,
  onAiSettingsChanged: unsubscribe,
  getRecentFiles: async () => [],
  consumePendingOpenDocx: async () => {
    if (pendingConsumed) return null
    pendingConsumed = true
    const doc = await waitForDocument()
    if (!doc) return null
    try {
      await joinDocsCollab(doc)
    } catch (error) {
      reportError('collab_unavailable', error instanceof Error ? error.message : String(error))
      return null
    }
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
  fontAliases: async () => ({}),
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
  onCloseSaveRequest: (handler) => {
    closeSaveHandler = handler
    return () => {
      if (closeSaveHandler === handler) closeSaveHandler = undefined
    }
  },
  reportCloseSaveResult: (ok) => {
    settleCloseSave?.(ok)
    settleCloseSave = undefined
  },
  // a co-edited page's unsaved flag follows the session (collab-page.ts), not this renderer
  reportDirty: (dirty) => {
    if (!coEditing) reportDirty(dirty)
  },
  onMenuCommand: unsubscribe,
  consumeHeadlessExport: async () => null,
  // the desktop main process's password state, kept for the page's one renderer
  docPasswordIntentRevision: async () => currentDocPasswordIntentRevision(),
  discardDocPasswordIntents: async (throughRevision) => {
    discardDocPasswordIntents(WEB_RENDERER, throughRevision)
    return { ok: true }
  },
  openDocxDecrypt: async (path, password) => {
    const doc = documentByPath(path)
    if (!doc) return { ok: false, reason: 'error', error: 'file not found' }
    return openDecryptedDocx(doc, password)
  },
  // a page holds one document: the prompt answers for the host's, with nothing open to replace
  confirmDocumentReplace: async () => true,
  // an open password is not part of the co-editing log: one person's choice would decide what
  // every later save of a peer writes, so it cannot change while co-editing
  setDocPassword: async (filePath, password) => {
    if (coEditing) return { ok: false }
    setDocPassword(WEB_RENDERER, filePath, password)
    return { ok: true }
  },
  // the host stores a save only when it opened the document for editing
  saveDocx: editMode() ? saveDocxToHost : unsupported('docs.save'),
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
  aiNamingApi: absent('suggestFileName'),
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
  if (editMode()) onHostSaveRequest(runHostSave)
}
