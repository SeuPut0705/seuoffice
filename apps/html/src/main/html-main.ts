import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  webContents,
} from 'electron'
import type { MessageBoxOptions, WebContents } from 'electron'
import {
  configuredDefaultSaveDir,
  confirmOverwriteIfConflicted,
  contextMenuLabels,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  isPathOpenElsewhere,
  recordDiskState,
  safeExternalUrl,
  shouldDeferAutoSave,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  type HeadlessExportFormat,
  type HeadlessExportTarget,
  type RecoveryIdentity,
  type SaveDiskState,
  installRendererProtocol,
  registerRecoveryEditor,
  rendererUrl,
  printHtmlDocument,
  type PrintDialogOutcome,
  assertFileSaved,
} from '@seuoffice/electron-utils'
import { fetchImageBytes } from '@seuoffice/electron-utils/fetch-image-bytes'
import { createI18n, getUiLang } from '@seuoffice/i18n'
import {
  sharedSubscriptionStatuses,
  shutdownSubscriptionChildren,
} from '@seuoffice/ai-provider/subscription'
import { generateImageTool, documentMediaRoots, withMediaCallSignal } from '@seuoffice/ai-search'
import {
  parseFileToText,
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  ATTACHABLE_IMAGE_MAX_BYTES,
  diagramPictureExtOf,
  diagramPictureExtOfName,
} from '@seuoffice/file-parse'
import { convertHtmlToDocx } from '../../../../packages/html2docx/src'
import { atomicWriteFile } from './atomic-write'
import { ElectronBrowserDriver } from '../../../../packages/html2docx/src/drivers/electron'
import {
  copyImageIntoOwnedAssets,
  discardPendingOwnedAssets,
  extractHtmlAssetReferences,
  isInDocDir,
  pendingOwnedAssetsForDocument,
  prepareAssetsForSaveAs,
  reconcileOwnedAssets,
  renameOwnedAssetDocument,
  resolveSafeRelativeImagePath,
  resolveSourcePendingAfterSaveAs,
  rollbackPreparedSaveAsAssets,
  writeImageIntoOwnedAssets,
} from './asset-lifecycle'
import {
  ASSET_SNIFF_BYTES,
  PREVIEW_ASSET_EXTS,
  editableImageMime,
  extensionlessAssetMime,
} from './asset-mime'
import { buildPreviewDocument } from './preview-document'
import {
  askMarkedExport,
  confirmOdtReport,
  exportOdt,
  markedExportRefusal,
  odtFilterName,
} from './odt-export'
import { planMarkedExport } from './marked-html'
import { inlineImagesForSingleFile, singleFileExportBaseName } from './single-file-html'
import { registerHtmlHandoffIpc } from './generate-handoff-ipc'
import { registerHtmlSeedIpc } from './seed-main'
import { createTextRecovery } from './recovery'
import { registerHtmlAiSearchIpc } from './ai-search-ipc'
import {
  assetBaseHref,
  previewUrlFor,
  registerPrivilegedSchemes,
  registerPreviewProtocol,
} from './preview-protocol'
import { HTML_CHANNELS } from '../shared/ipc'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  ExportDocxRequest,
  ExportHtmlRequest,
  ExportFormat,
  ExportOdtRequest,
  ExportPdfRequest,
  ExportResult,
  ImageData,
  PrintHtmlRequest,
  PrintResult,
  SaveHtmlRequest,
  SaveHtmlResult,
  SaveMode,
} from '../shared/ipc'

const tDlg = createI18n({
  en: {
    dlgSaveTitle: 'Save HTML Document',
    filterHtml: 'HTML Documents',
    filterPdf: 'PDF Document',
    filterWord: 'Word Document',
    dlgPickImage: 'Choose an Image',
    filterImages: 'Images',
    untitledFile: 'Untitled',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
    dlgAddAttachment: 'Add Attachments',
    filterSupported: 'Supported Files',
    filterAll: 'All Files',
    errUnsupportedExt: '.{ext} files are not supported',
    errNotFile: 'not a file',
    errTooLarge: 'exceeds the {mb}MB limit',
    errImageTooLarge: 'image exceeds the 5MB limit',
    errUnreadable: 'cannot be read',
    errFileTooLarge: 'File exceeds the size limit',
    errParseFailed: 'Failed to parse file',
    errImageNoText: 'Image attachments have no text; the image is sent along with the user message',
    errNotImage: 'not a supported image type',
  },
  ko: {
    dlgSaveTitle: 'HTML 문서 저장',
    filterHtml: 'HTML 문서',
    filterPdf: 'PDF 문서',
    filterWord: 'Word 문서',
    dlgPickImage: '이미지 선택',
    filterImages: '이미지',
    untitledFile: '제목 없음',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
    dlgAddAttachment: '첨부 파일 추가',
    filterSupported: '지원되는 파일',
    filterAll: '모든 파일',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    errNotFile: '파일이 아닙니다',
    errTooLarge: '{mb}MB 제한을 초과했습니다',
    errImageTooLarge: '이미지가 5MB 제한을 초과했습니다',
    errUnreadable: '읽을 수 없습니다',
    errFileTooLarge: '파일이 크기 제한을 초과했습니다',
    errParseFailed: '파일을 분석하지 못했습니다',
    errImageNoText:
      '이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다',
    errNotImage: '지원되지 않는 이미지 형식입니다',
  },
})
type DlgKey =
  | 'dlgSaveTitle'
  | 'filterHtml'
  | 'filterPdf'
  | 'filterWord'
  | 'dlgPickImage'
  | 'filterImages'
  | 'untitledFile'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'
  | 'dlgAddAttachment'
  | 'filterSupported'
  | 'filterAll'
  | 'errUnsupportedExt'
  | 'errNotFile'
  | 'errTooLarge'
  | 'errImageTooLarge'
  | 'errUnreadable'
  | 'errFileTooLarge'
  | 'errParseFailed'
  | 'errImageNoText'
  | 'errNotImage'
const tm = (key: DlgKey, vars?: Record<string, string | number>) => tDlg(getUiLang(), key, vars)

// ---- chat attachments: local files parsed for the agent (same contract as the docs panel) ----

const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** extracted text cache keyed by path; invalidated by mtime+size */
const attachmentTextCache = new Map<string, { stamp: string; text: string }>()

function statAttachment(filePath: string): { meta?: AttachmentMeta; error?: string } {
  const name = basename(filePath)
  // a draw.io picture that holds its diagram is read as diagram text
  const ext = diagramPictureExtOf(filePath) ?? name.split('.').pop()?.toLowerCase() ?? ''
  if (!ATTACHABLE_EXTS.has(ext)) return { error: `${name}: ${tm('errUnsupportedExt', { ext })}` }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return { error: `${name}: ${tm('errNotFile')}` }
    if (!ATTACHABLE_IMAGE_EXTS.has(ext) && stat.size > attachableMaxBytes(ext)) {
      return {
        error: `${name}: ${tm('errTooLarge', { mb: Math.round(ATTACHABLE_MAX_BYTES / 1024 / 1024) })}`,
      }
    }
    if (ATTACHABLE_IMAGE_EXTS.has(ext) && stat.size > ATTACHABLE_IMAGE_MAX_BYTES) {
      return { error: `${name}: ${tm('errImageTooLarge')}` }
    }
    return { meta: { path: filePath, name, ext, sizeBytes: stat.size } }
  } catch {
    return { error: `${name}: ${tm('errUnreadable')}` }
  }
}

function collectAttachments(paths: string[]): AttachmentAddResult {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const p of paths) {
    const { meta, error } = statAttachment(p)
    if (meta) accepted.push(meta)
    else if (error) rejected.push(error)
  }
  return { accepted, rejected }
}

let pastedImageSeq = 0
let pastedDirPruned = false

/** drop pasted-image temp files older than 7 days (once per app run) */
function prunePastedImages(dir: string): void {
  if (pastedDirPruned) return
  pastedDirPruned = true
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        // another tab may have removed it already
      }
    }
  } catch {
    // directory may not exist yet
  }
}

/** clipboard-pasted image bytes → temp file (shared with the docs panel), null for non-images or empty data */
function savePastedImage(data: unknown, ext: unknown): string | null {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!ATTACHABLE_IMAGE_EXTS.has(cleanExt)) return null
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) return null
  const dir = join(app.getPath('temp'), 'seuoffice-pasted')
  mkdirSync(dir, { recursive: true })
  prunePastedImages(dir)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const filePath = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  writeFileSync(filePath, bytes)
  return filePath
}

async function extractAttachmentText(filePath: string): Promise<string> {
  // a file open with unsaved changes is not read (before the cache): a
  // withholding mark only reaches the file on save
  await assertFileSaved(filePath)
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = attachmentTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  const capExt = diagramPictureExtOfName(filePath) ?? extname(filePath)
  if (stat.size > attachableMaxBytes(capExt)) throw new Error(tm('errFileTooLarge'))
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error((!parsed.damaged && parsed.error) || tm('errParseFailed'))
  }
  attachmentTextCache.set(filePath, { stamp, text: parsed.text })
  if (attachmentTextCache.size > 8) {
    const oldest = attachmentTextCache.keys().next().value
    if (oldest) attachmentTextCache.delete(oldest)
  }
  return parsed.text
}

interface RuntimePaths {
  preloadPath: string
  rendererUrl?: string
  rendererFile?: string
  /** Shell router used to open exported PDFs in a new SeuOffice tab. */
  openGeneratedPath?: (path: string) => boolean
  /**
   * Project folders (spec 6): the folder an untitled document's save dialog
   * opens in for this view, or null for the default save folder.
   */
  newDocumentDir?: (webContentsId: number) => Promise<string | null>
  /**
   * Project folders (spec 6): write a new document the AI made in this view
   * into the project its panel chose (a free name, never over a file);
   * resolves to the path written, or null when the panel has no project.
   */
  writeNewDocument?: (
    webContentsId: number,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<string | null>
}

let runtime: RuntimePaths = { preloadPath: '' }

export function configureHtmlRuntime(paths: RuntimePaths): void {
  runtime = paths
}

export { registerPrivilegedSchemes }

/** After a successful Html → PDF export: open the file in a PDF tab (shell)
 * or reveal it in the folder (standalone). Tab-opening failure must not
 * report the export itself as failed — the file is already persisted. */
function openExportedPdf(path: string): void {
  // Headless export must stay silent: no tab, no Finder window.
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[html] Failed to open exported PDF:', err)
  }
  shell.showItemInFolder(path)
}

/** Open path per view, queued at tab creation; the renderer consumes it after mount.
 * Kept until the view is destroyed so a reload (View > Reload) consumes it again. */
const openPathByWc = new Map<number, string>()
/** File paths granted to each view — readFile/save only allow these */
const allowedByWc = new Map<number, Set<string>>()
/** Current save target per view; absent = untitled document */
const savePathByWc = new Map<number, string>()
/** Unsaved-changes flags mirrored from the renderer; drives the save prompt before closing a tab/window */
const dirtyByWc = new Set<number>()
/** Latest buffer text pushed by each renderer; served by html-preview:// to the preview iframe */
const previewTextByWc = new Map<number, string>()
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
/** Resolvers for menu-triggered saves, resolved when the renderer's save invoke completes */
const saveWaiters = new Map<number, (ok: boolean) => void>()
/** Resolvers for MCP reads of the live document source, resolved by the renderer's reply */
const readTextWaiters = new Map<number, (result: { text: string } | { error: string }) => void>()
/** one read per tab at a time: concurrent callers share this promise */
const readTextInFlight = new Map<number, Promise<string>>()

// ── Split-copy save guard (decision 0036): remember the disk state of every
// read and write per view and path, so that while the same document is open in
// two panes a save can see the sibling pane's write. A manual save asks before
// overwriting it; an automatic save defers silently to the next manual one.
const docDiskStates = new Map<number, Map<string, SaveDiskState>>()

async function rememberDiskState(wcId: number, path: string): Promise<void> {
  const state = await recordDiskState(path)
  if (!state) return
  const states = docDiskStates.get(wcId) ?? new Map<string, SaveDiskState>()
  states.set(path, state)
  docDiskStates.set(wcId, states)
}

function forgetDiskState(wcId: number, path: string): void {
  const states = docDiskStates.get(wcId)
  if (!states) return
  states.delete(path)
  if (states.size === 0) docDiskStates.delete(wcId)
}

// ── Crash-recovery copies (spec "work is not lost"): the renderer pushes the
// text a save would write; the copy lives in <userData>/html-autosave.
const recovery = createTextRecovery({
  kind: 'html',
  untitledExt: '.html',
  userDataDir: () => app.getPath('userData'),
  dialog,
  parentOf: (contents) => BrowserWindow.fromWebContents(contents),
  lang: () => getUiLang(),
  savePath: (wcId) => savePathByWc.get(wcId),
  openPath: (wcId) => openPathByWc.get(wcId),
  isDirty: (wcId) => dirtyByWc.has(wcId),
  adoptFile: (contents, filePath) => {
    openPathByWc.set(contents.id, filePath)
    savePathByWc.set(contents.id, filePath)
    const allowed = allowedByWc.get(contents.id) ?? new Set<string>()
    allowed.add(filePath)
    allowedByWc.set(contents.id, allowed)
  },
  restoredFile: (wcId, filePath) => {
    // the save guard compares with the file as it was when the tab opened
    void rememberDiskState(wcId, filePath)
  },
  untitledFallbackTitle: () => tm('untitledFile'),
  flushChannel: HTML_CHANNELS.recoveryFlushRequest,
})

/**
 * The HTML editor's crash-recovery contract. Registered when this module loads,
 * not with the first view: the shell restores untitled tabs and asks for copies at
 * OS shutdown before any view of this editor may exist.
 */
export const htmlRecoveryEditor = recovery.contract
registerRecoveryEditor(recovery.contract)

/**
 * The shell's tab title for an untitled document, used as its recovery copy's
 * title in the launch list (falls back to the provisional name, then "Untitled").
 */
export function setHtmlRecoveryTitleSource(
  source: ((contents: WebContents) => string | undefined) | null,
): void {
  recovery.setTitleSource(source)
}

/**
 * The recovery copy identity of a view's document: its path, or the untitled
 * copy id (session record, reopening a crashed untitled tab). Null when the
 * view is not an HTML document view.
 */
export function htmlRecoveryIdentity(webContentsId: number): RecoveryIdentity | null {
  return recovery.identityOf(webContentsId)
}

/** True when this save must stop instead of writing: the sibling copy changed
 *  the disk since this view's last read or write, and either the automatic
 *  save defers or the user chose to keep the disk copy. */
async function conflictStopsSave(
  contents: WebContents,
  path: string,
  auto: boolean,
): Promise<boolean> {
  if (!isPathOpenElsewhere(path)) return false
  const recorded = docDiskStates.get(contents.id)?.get(path)
  if (auto) return shouldDeferAutoSave(path, recorded)
  return (
    (await confirmOverwriteIfConflicted({
      parent: BrowserWindow.fromWebContents(contents),
      path,
      recorded,
      lang: getUiLang(),
    })) === 'cancel'
  )
}

/** Fired after a save lands on a NEW path (untitled first save / Save As) — the shell syncs tab title, recents, projects */
let fileSavedHook: ((wc: WebContents, path: string) => void) | null = null

export function setHtmlFileSavedHook(hook: (wc: WebContents, path: string) => void): void {
  fileSavedHook = hook
}

/** An untitled document got a provisional name from the user's first AI request — the shell titles its tab */
let provisionalTitleHook: ((wc: WebContents, title: string) => void) | null = null

export function setHtmlProvisionalTitleHook(hook: (wc: WebContents, title: string) => void): void {
  provisionalTitleHook = hook
}

/** After a Word export the shell opens the new .docx in a docs tab; standalone reveals it */
let docxExportedHook: ((path: string) => void) | null = null
/** Before the .docx is written: the shell closes a docs tab already showing that path
 * (its unsaved-changes prompt applies); false = the user kept it, so the export is dropped */
let docxExportPrepareHook: ((path: string) => Promise<boolean>) | null = null

export function setHtmlDocxExportedHook(hook: (path: string) => void): void {
  docxExportedHook = hook
}

export function setHtmlDocxExportPrepareHook(hook: (path: string) => Promise<boolean>): void {
  docxExportPrepareHook = hook
}

function openExportedDocx(path: string): void {
  if (isHeadlessMode()) return
  try {
    if (docxExportedHook) {
      docxExportedHook(path)
      return
    }
  } catch (err) {
    console.warn('[html] Failed to open exported Word file:', err)
  }
  shell.showItemInFolder(path)
}

function exportFileName(suggested: unknown): string {
  return (
    String(suggested || tm('untitledFile'))
      .replace(/[/\\:*?"<>|]/g, '_')
      .slice(0, 80)
      .trim() || tm('untitledFile')
  )
}

export interface HtmlPresentHooks {
  /** cover the tab strip with the presenting tab's view (shell tab mode) */
  setBleed?: (wc: WebContents, on: boolean) => void
  /** window hosting a view when BrowserWindow.fromWebContents cannot tell (shell WebContentsView) */
  hostWindow?: (wc: WebContents) => BrowserWindow | null
  /** open a chrome-free tab presenting the owner view's preview; false → a window is opened instead */
  openTab?: (owner: WebContents, title: string) => boolean
  /** close the tab hosting a present view; false → not a tab of this shell */
  closeTab?: (wc: WebContents) => boolean
}
let presentHooks: HtmlPresentHooks = {}
export function setHtmlPresentHooks(hooks: HtmlPresentHooks): void {
  presentHooks = hooks
}
/** present views → the editing view whose preview they show */
const presentOwnerByWc = new Map<number, number>()
/** standalone Present windows; unreferenced BrowserWindows may be garbage-collected */
const presentWindows = new Set<BrowserWindow>()

/** The owner view is gone, so is its preview: close every present view showing it */
function closePresentViewsOf(ownerWcId: number): void {
  for (const [id, owner] of presentOwnerByWc) {
    if (owner !== ownerWcId) continue
    presentOwnerByWc.delete(id)
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) continue
    if (presentHooks.closeTab?.(wc)) continue
    const win = BrowserWindow.fromWebContents(wc)
    if (win && !win.isDestroyed()) win.close()
    else wc.close()
  }
}

/** A4 at 96dpi; html2docx re-measures at the authored width itself when the page asks for more. */
const HTML2DOCX_VIEWPORT = { width: 794, height: 1123, deviceScaleFactor: 2 }
// A renderer that never yields must not strand the export: watchdog destroys
// the hidden conversion window.
const HTML_EXPORT_TIMEOUT_MS = 180_000

/** Print the document in a hidden script-free window (sheets-style). Relative assets
 * resolve through html-asset:// against the document's folder, exactly as in the preview. */
async function renderPrintPdf(
  html: string,
  docPath: string | undefined,
  workDir: string,
): Promise<Buffer> {
  const base = docPath ? assetBaseHref(dirname(docPath)) : null
  const htmlPath = join(workDir, 'print.html')
  await writeFile(htmlPath, buildPreviewDocument(html, base), 'utf8')
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  })
  try {
    await printWin.loadFile(htmlPath)
    return await printWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    })
  } finally {
    printWin.destroy()
  }
}

/** The Word export's bytes (html2docx in a hidden window); the ODT export converts these. */
async function renderHtmlDocx(
  html: string,
  docPath: string | undefined,
  workDir: string,
): Promise<Uint8Array> {
  let driver: ElectronBrowserDriver | null = null
  try {
    // Same document the preview shows (scripts on, relative assets via html-asset://):
    // html2docx extracts from the rendered DOM, not from a print.
    const base = docPath ? assetBaseHref(dirname(docPath)) : null
    const htmlPath = join(workDir, 'export.html')
    await writeFile(htmlPath, buildPreviewDocument(html, base), 'utf8')
    driver = await ElectronBrowserDriver.create(HTML2DOCX_VIEWPORT)
    // AI-generated markup with a script that never yields keeps
    // executeJavaScript pending forever, which would strand the hidden
    // window and this handler; race a watchdog and destroy the window on
    // timeout (same shape as the slides export guard).
    const conversion = convertHtmlToDocx({ url: pathToFileURL(htmlPath).href }, driver).then(
      ({ docx }) => docx,
    )
    let watchdog: ReturnType<typeof setTimeout> | undefined
    return await Promise.race([
      conversion,
      new Promise<Uint8Array>((_, reject) => {
        watchdog = setTimeout(() => {
          if (driver && !driver.isWindowDestroyed()) driver.destroyNow()
          driver = null
          reject(new Error('html export timed out'))
        }, HTML_EXPORT_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(watchdog))
  } finally {
    await driver?.close()
  }
}

/** The Word export to a path already chosen (its dialog, Save As or the command line). */
async function writeHtmlDocx(
  html: string,
  docPath: string | undefined,
  target: string,
  win?: BrowserWindow,
): Promise<ExportResult> {
  // The Word export writes the page's words and no mark: a marked page is exported
  // only with its marks cleared, when the person agrees; a headless export writes nothing.
  const plan = await planMarkedExport(
    html,
    isHeadlessMode() ? null : () => askMarkedExport('docx', (options) => showBox(win, options)),
  )
  if (plan.kind === 'declined') {
    return isHeadlessMode()
      ? { ok: false, error: markedExportRefusal() }
      : { ok: true, canceled: true }
  }
  html = plan.html
  if (docxExportPrepareHook && !(await docxExportPrepareHook(target))) {
    return { ok: true, canceled: true }
  }
  const workDir = await mkdtemp(join(tmpdir(), 'seuoffice-html-docx-'))
  try {
    const docx = await renderHtmlDocx(html, docPath, workDir)
    await writeFile(target, docx)
    openExportedDocx(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

const showBox = (win: BrowserWindow | undefined, options: MessageBoxOptions) =>
  win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)

/** The ODT export: the Word export's bytes converted by docxToOdt, a change report confirmed. */
async function writeHtmlOdt(
  html: string,
  docPath: () => string | undefined,
  win: BrowserWindow | undefined,
  pickPath: () => Promise<string | null>,
  skipConfirm: boolean,
): Promise<ExportResult> {
  // An ODT cannot keep content hidden from AI: a marked page is exported only with
  // its marks cleared, when the person agrees; a headless export writes nothing.
  const plan = await planMarkedExport(
    html,
    skipConfirm ? null : () => askMarkedExport('odt', (options) => showBox(win, options)),
  )
  if (plan.kind === 'declined') {
    return skipConfirm ? { ok: false, error: markedExportRefusal() } : { ok: true, canceled: true }
  }
  const outcome = await exportOdt({
    pickPath,
    docx: async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'seuoffice-html-docx-'))
      try {
        return await renderHtmlDocx(plan.html, docPath(), workDir)
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    },
    confirm: async (report) =>
      skipConfirm ||
      confirmOdtReport(report, (options) =>
        win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options),
      ),
    // a docs tab showing the target is closed first, as for the Word export
    prepare: async (path) => !docxExportPrepareHook || docxExportPrepareHook(path),
    write: (path, bytes) => writeFile(path, bytes),
  })
  if ('path' in outcome) openExportedDocx(outcome.path)
  return outcome
}

/** The PDF export to a path already chosen (its dialog, Save As or the command line). */
async function writeHtmlPdf(
  html: string,
  docPath: string | undefined,
  target: string,
): Promise<ExportResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'seuoffice-html-pdf-'))
  try {
    await writeFile(target, await renderPrintPdf(html, docPath, workDir))
    openExportedPdf(target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The page markup the export menu sends, recovered from a save request's text:
 * the renderer's `serializeDocText` undone (BOM, line endings, final newline).
 */
function exportHtmlOfSaveText(text: string): string {
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n')
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

/** Save As › the export a picked extension selects */
const SAVE_AS_EXPORT_BY_EXT: Record<string, 'pdf' | 'docx' | 'odt'> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.odt': 'odt',
}

/** Shell menu export entry: ask the renderer to serialize and run the export flow */
export function sendHtmlExportRequest(contents: WebContents, format: ExportFormat): void {
  if (contents.isDestroyed() || presentOwnerByWc.has(contents.id)) return
  contents.send(HTML_CHANNELS.exportRequest, format)
}

/** Shell menu Print: ask the renderer to build the print HTML and open the system dialog */
export function sendHtmlPrintRequest(contents: WebContents): void {
  if (contents.isDestroyed() || presentOwnerByWc.has(contents.id)) return
  contents.send(HTML_CHANNELS.printRequest)
}

// Scripting stays on here, unlike the PDF export window: Chromium rejects
// executeJavaScript under `javascript: false`, and the fonts/images readiness
// probe needs it. Print and Export-PDF therefore differ for <script>-built content.
function printHtml(html: string, docPath: string | undefined): Promise<PrintDialogOutcome> {
  const base = docPath ? assetBaseHref(dirname(docPath)) : null
  return printHtmlDocument({
    html: buildPreviewDocument(html, base),
    window: new BrowserWindow({ show: false, webPreferences: { sandbox: true } }),
    fileName: 'print.html',
    dirPrefix: 'seuoffice-html-print-',
  })
}

export function htmlIsDirty(webContentsId: number): boolean {
  return dirtyByWc.has(webContentsId)
}

export function htmlFilePath(webContentsId: number): string | undefined {
  return savePathByWc.get(webContentsId)
}

/** The file was renamed on disk — re-grant the new path and tell the renderer */
export function htmlFileRenamed(contents: WebContents, oldPath: string, newPath: string): void {
  const wcId = contents.id
  if (savePathByWc.get(wcId) === oldPath) savePathByWc.set(wcId, newPath)
  if (openPathByWc.get(wcId) === oldPath) openPathByWc.set(wcId, newPath)
  const allowed = allowedByWc.get(wcId)
  if (allowed?.has(oldPath)) allowed.add(newPath)
  const states = docDiskStates.get(wcId)
  const recorded = states?.get(oldPath)
  if (states && recorded) {
    states.delete(oldPath)
    states.set(newPath, recorded)
  }
  void renameOwnedAssetDocument(oldPath, newPath).catch((error) => {
    console.warn('[html] asset manifest rename sync failed:', error)
  })
  if (savePathByWc.get(wcId) === newPath) recovery.renamed(wcId, oldPath)
  if (!contents.isDestroyed()) contents.send(HTML_CHANNELS.fileRenamed, newPath)
}

/**
 * Close guard: true means proceed with closing. Clean → true; dirty →
 * Save / Don't Save / Cancel. On Save, ask the renderer to serialize + write
 * and await the result; a canceled untitled-save dialog keeps the tab open.
 */
export async function requestHtmlClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  if (!dirtyByWc.has(contents.id) || contents.isDestroyed()) return true
  const options = {
    type: 'warning' as const,
    message: tm('closeUnsavedMsg'),
    detail: tm('closeUnsavedDetail'),
    buttons: [tm('btnSave'), tm('btnDontSave'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response === 2) return false
  if (response === 1) {
    recovery.dontSave(contents.id)
    const documentPath = savePathByWc.get(contents.id)
    if (documentPath) {
      const discarded = await discardPendingOwnedAssets(documentPath)
      if (discarded.errors.length > 0) {
        console.warn('[html] pending asset discard incomplete:', discarded.errors)
      }
    }
    return true
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send(HTML_CHANNELS.closeSaveRequest)
  })
}

/**
 * Drop assets staged next to the document but never written into it — the MCP
 * "discard unsaved changes" path, same cleanup the interactive close prompt
 * runs when the user picks "Don't Save".
 */
export async function htmlDiscardPendingAssets(contents: WebContents): Promise<void> {
  // closing without saving: the recovery copy goes as with "Don't Save"
  recovery.dontSave(contents.id)
  const documentPath = savePathByWc.get(contents.id)
  if (!documentPath) return
  const discarded = await discardPendingOwnedAssets(documentPath)
  if (discarded.errors.length > 0) {
    console.warn('[html] pending asset discard incomplete:', discarded.errors)
  }
}

/** Menu Save / Save As: ask the renderer to serialize and save; clean views resolve true immediately on plain save */
export function requestHtmlSave(contents: WebContents, mode: SaveMode): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false)
  if (presentOwnerByWc.has(contents.id)) return Promise.resolve(true)
  if (mode === 'save' && !dirtyByWc.has(contents.id) && savePathByWc.has(contents.id)) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      saveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    saveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send(HTML_CHANNELS.saveRequest, mode)
  })
}

/**
 * Read the live document source for an MCP `open_documents` read. The buffer the
 * renderer pushes for the preview is instrumented for the iframe, so it cannot
 * be reused here: this asks for the saved serialization instead, unsaved edits
 * included.
 */
export function htmlReadText(contents: WebContents): Promise<string> {
  if (contents.isDestroyed()) return Promise.reject(new Error('the document is no longer open'))
  const wcId = contents.id
  const inFlight = readTextInFlight.get(wcId)
  if (inFlight) return inFlight
  const request = new Promise<string>((resolve, reject) => {
    // The renderer registers its listener while mounting, which can land after
    // the tab appears; a request sent before that is dropped silently. Re-send
    // on an interval until the renderer answers, the way the shell's own
    // control channel polls for a not-yet-ready editor.
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(retry)
      clearTimeout(timer)
      readTextWaiters.delete(wcId)
      readTextInFlight.delete(wcId)
      finish()
    }
    const retry = setInterval(() => {
      if (contents.isDestroyed()) {
        settle(() => reject(new Error('the document is no longer open')))
        return
      }
      contents.send(HTML_CHANNELS.readTextRequest)
    }, 250)
    const timer = setTimeout(
      () => settle(() => reject(new Error('timed out reading the document'))),
      30_000,
    )
    readTextWaiters.set(wcId, (result) => {
      settle(() => {
        if ('text' in result) resolve(result.text)
        else reject(new Error(result.error))
      })
    })
    contents.send(HTML_CHANNELS.readTextRequest)
  })
  readTextInFlight.set(wcId, request)
  return request
}

/**
 * Save the live document to `filePath` with no dialog — the MCP close path
 * ("save before closing"). Pointing the view's save target at `filePath` first
 * keeps `resolveSaveTarget` from opening the save dialog, so the renderer's
 * normal save runs unattended.
 */
export function htmlSaveToPath(contents: WebContents, filePath: string): Promise<void> {
  if (contents.isDestroyed()) return Promise.reject(new Error('the document is no longer open'))
  const wcId = contents.id
  const previousPath = savePathByWc.get(wcId)
  const previousOpenPath = openPathByWc.get(wcId)
  // the copy belongs to the document as it was (an untitled one included),
  // not to the path the save is pointed at
  const recoveryBefore = recovery.identityOf(wcId)
  savePathByWc.set(wcId, filePath)
  const allowed = allowedByWc.get(wcId) ?? new Set<string>()
  allowed.add(filePath)
  allowedByWc.set(wcId, allowed)
  return new Promise<void>((resolve, reject) => {
    const restore = (): void => {
      if (previousPath === undefined) savePathByWc.delete(wcId)
      else savePathByWc.set(wcId, previousPath)
      if (previousOpenPath === undefined) openPathByWc.delete(wcId)
      else openPathByWc.set(wcId, previousOpenPath)
      // a copy written under the target while the save ran must not outlive it
      recovery.saveToPathFailed(wcId, filePath)
    }
    const timer = setTimeout(() => {
      saveWaiters.delete(wcId)
      restore()
      reject(new Error('timed out saving the document'))
    }, 120_000)
    saveWaiters.set(wcId, (ok) => {
      clearTimeout(timer)
      if (ok) {
        recovery.saved(wcId, recoveryBefore)
        resolve()
      } else {
        restore()
        reject(new Error('could not save the document'))
      }
    })
    contents.send(HTML_CHANNELS.saveRequest, 'save')
  })
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await atomicWriteFile(path, Buffer.from(text, 'utf8'))
}

function fileNameBase(name: string | undefined): string {
  return (name ?? '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .slice(0, 80)
    .trim()
}

/**
 * The AI's silent first save while this view's panel has a project (spec 6):
 * the page goes into that project folder through its write guard. Null (nothing
 * written) without a project; the default save folder then takes it as before.
 */
async function saveIntoProject(
  wcId: number,
  suggestedName: string | undefined,
  text: string,
): Promise<string | null> {
  const base = fileNameBase(suggestedName)
  if (!base || !runtime.writeNewDocument) return null
  return runtime.writeNewDocument(wcId, `${base}.html`, Buffer.from(text, 'utf8'))
}

async function resolveSaveTarget(
  e: Electron.IpcMainInvokeEvent,
  mode: SaveMode,
  suggestedName?: string,
  defaultName?: string,
  offerExports = false,
): Promise<string | null | 'canceled'> {
  const current = savePathByWc.get(e.sender.id)
  if (mode === 'save' && current) return current
  // AI auto-naming: silent first save of an untitled document
  if (mode === 'save' && !current && suggestedName) {
    const base = fileNameBase(suggestedName)
    if (base) {
      const dir = configuredDefaultSaveDir(app)
      let target = join(dir, `${base}.html`)
      for (let n = 1; existsSync(target); n++) target = join(dir, `${base}-${n}.html`)
      return target
    }
  }
  const win =
    BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
  // An untitled page starts in the folder a recovered copy came from, else in
  // its panel's project (spec 6), else in the default save folder.
  const recovered = current ? undefined : recovery.saveAsDefaultPath(e.sender.id)
  const folder = current
    ? dirname(current)
    : recovered
      ? dirname(recovered)
      : ((await runtime.newDocumentDir?.(e.sender.id)) ?? configuredDefaultSaveDir(app))
  // A name proposed by the model (or the page's own title) prefills the dialog
  // rather than replacing it: the reader still chooses the location, and
  // cancelling still cancels. It keeps the open file's extension: an .html
  // proposal must not offer to rewrite an opened .htm file.
  const proposed = fileNameBase(defaultName)
  const defaultPath = proposed
    ? join(folder, `${proposed}${current ? extname(current) : '.html'}`)
    : current
      ? join(dirname(current), basename(current))
      : (recovered ?? join(folder, `${tm('untitledFile')}.html`))
  const filters: Array<{ name: string; extensions: string[] }> = [
    { name: tm('filterHtml'), extensions: ['html', 'htm'] },
  ]
  if (offerExports) {
    filters.push(
      { name: tm('filterPdf'), extensions: ['pdf'] },
      { name: tm('filterWord'), extensions: ['docx'] },
      { name: odtFilterName(), extensions: ['odt'] },
    )
  }
  const picked = await showSaveDialogWithMemory(dialog, win, {
    title: tm('dlgSaveTitle'),
    // With the exports offered, the suggestion carries no extension: the file
    // type chosen in the dialog supplies it (a typed name keeps its own)
    defaultPath: offerExports ? defaultPath.replace(/\.html?$/i, '') : defaultPath,
    filters,
  })
  if (picked.canceled || !picked.filePath) return 'canceled'
  // A dialog that does not add the chosen type's extension (some Linux desktops)
  // leaves a bare name: the default type is HTML
  return offerExports && !extname(picked.filePath) ? `${picked.filePath}.html` : picked.filePath
}

/**
 * Serves authored image paths to the editor DOM. A plain file:// <img> URL is
 * blocked whenever the renderer page is served over http (dev server), so the
 * renderer resolves images to html-asset:// instead. Only files inside an open
 * document's directory are served: by extension, or for extensionless
 * "Save page as, complete" assets by signature / requesting slot.
 */
function registerImageProtocol(): void {
  protocol.handle('html-asset', async (request) => {
    let target: string
    try {
      target = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (/^\/[a-zA-Z]:\//.test(target)) target = target.slice(1)
    target = resolve(target)
    const knownExt = PREVIEW_ASSET_EXTS.has(extname(target).toLowerCase())
    if (!existsSync(target)) return new Response(null, { status: 404 })
    let inDocDir = false
    for (const doc of new Set([...openPathByWc.values(), ...savePathByWc.values()])) {
      const dir = resolve(dirname(doc))
      if (!isInDocDir(target, dir)) continue
      if (await resolveSafeRelativeImagePath(doc, relative(dir, target))) {
        inDocDir = true
        break
      }
    }
    if (!inDocDir) return new Response(null, { status: 403 })
    let mime: string | null = null
    if (!knownExt) {
      mime = extensionlessAssetMime(target, await readHead(target), request.headers.get('accept'))
      if (!mime) return new Response(null, { status: 404 })
    }
    const res = await net.fetch(pathToFileURL(target).toString())
    if (!mime || !res.ok) return res
    return new Response(res.body, { status: 200, headers: { 'Content-Type': mime } })
  })
}

async function readHead(target: string): Promise<Uint8Array> {
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(ASSET_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, ASSET_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

let ipcRegistered = false

function registerHtmlIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  registerImageProtocol()
  registerPreviewProtocol((wcId) => {
    const text = previewTextByWc.get(wcId)
    if (text === undefined) return null
    const doc = savePathByWc.get(wcId)
    return { text, baseHref: doc ? assetBaseHref(dirname(doc)) : null }
  })

  ipcMain.handle(HTML_CHANNELS.consumePending, (e) => openPathByWc.get(e.sender.id) ?? null)
  registerHtmlHandoffIpc(ipcMain, (wcId) => openPathByWc.has(wcId))
  registerHtmlSeedIpc({ opensFile: (wcId) => openPathByWc.has(wcId) })

  // ---- headless export mode (--headless-export) ----

  ipcMain.handle(HTML_CHANNELS.consumeHeadlessExport, (e): HeadlessExportTarget | null => {
    const target = headlessExportTargets.get(e.sender.id) ?? null
    headlessExportTargets.delete(e.sender.id)
    return target
  })

  ipcMain.on(HTML_CHANNELS.headlessExportDone, (e, result: unknown) => {
    const settle = headlessExportWaiters.get(e.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(e.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  ipcMain.on(HTML_CHANNELS.previewUpdate, (e, text: unknown) => {
    if (typeof text === 'string') previewTextByWc.set(e.sender.id, text)
  })

  ipcMain.handle(HTML_CHANNELS.previewInfo, (e) => ({
    url: previewUrlFor(presentOwnerByWc.get(e.sender.id) ?? e.sender.id),
  }))

  // Same shape as the slides show: the renderer asks for the screen in one call so the
  // macOS snap skips the Space animation; HTML fullscreen is left to the renderer elsewhere.
  let presentFsRelease: ReturnType<typeof setTimeout> | null = null
  ipcMain.handle(HTML_CHANNELS.presentFullScreen, (e, on: unknown) => {
    const wc = e.sender
    const win = BrowserWindow.fromWebContents(wc) ?? presentHooks.hostWindow?.(wc) ?? null
    if (!win || win.isDestroyed()) return
    if (presentFsRelease) {
      clearTimeout(presentFsRelease)
      presentFsRelease = null
    }
    if (on === true) {
      presentHooks.setBleed?.(wc, true)
      if (process.platform === 'darwin' && !win.isFullScreen()) {
        win.setFullScreenable(false)
        if (!win.isSimpleFullScreen()) win.setSimpleFullScreen(true)
      }
      // the snap can hand the first responder to the shell chrome; Esc must keep landing in the tab
      wc.focus()
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.focus()
      }, 50)
      return
    }
    presentFsRelease = setTimeout(() => {
      presentFsRelease = null
      if (!wc.isDestroyed()) presentHooks.setBleed?.(wc, false)
      if (win.isDestroyed()) return
      if (process.platform === 'darwin') {
        if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
        win.setFullScreenable(true)
      }
    }, 150)
  })

  ipcMain.handle(HTML_CHANNELS.presentNewTab, (e, title: unknown) => {
    const label = typeof title === 'string' ? title : ''
    if (presentHooks.openTab?.(e.sender, label)) return true
    const parent = BrowserWindow.fromWebContents(e.sender) ?? presentHooks.hostWindow?.(e.sender)
    const bounds =
      parent && !parent.isDestroyed() ? parent.getContentBounds() : { width: 1200, height: 850 }
    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    presentWindows.add(win)
    win.once('closed', () => presentWindows.delete(win))
    bindPresentView(win.webContents, e.sender.id, label)
    return true
  })

  ipcMain.handle(HTML_CHANNELS.readFile, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('html: path not granted to this view')
    }
    const text = await readFile(path, 'utf8')
    // The reader's copy: this view's save guard compares against this state
    await rememberDiskState(e.sender.id, path)
    return text
  })

  ipcMain.handle(HTML_CHANNELS.recoveryOpen, (e) => recovery.resolveOpen(e.sender))

  ipcMain.handle(HTML_CHANNELS.recoveryWrite, (e, text: unknown) =>
    recovery.writeCopy(e.sender, typeof text === 'string' ? text : null),
  )

  ipcMain.handle(
    HTML_CHANNELS.save,
    async (e, request: SaveHtmlRequest): Promise<SaveHtmlResult> => {
      const waiter = saveWaiters.get(e.sender.id)
      saveWaiters.delete(e.sender.id)
      const done = (result: SaveHtmlResult): SaveHtmlResult => {
        waiter?.(result.ok && !('canceled' in result))
        return result
      }
      if (typeof request?.text !== 'string') {
        return done({ ok: false, error: 'html: bad save request' })
      }
      if (
        request.imageSources !== undefined &&
        (!Array.isArray(request.imageSources) ||
          request.imageSources.some((source) => typeof source !== 'string'))
      ) {
        return done({ ok: false, error: 'html: bad image references' })
      }
      const mode: SaveMode = request.mode === 'saveAs' ? 'saveAs' : 'save'
      // Request input is untrusted: only an explicit automatic-save flag counts
      const auto = (request as { auto?: unknown } | null)?.auto === true
      const pathAtRequest = savePathByWc.get(e.sender.id)
      const recoveryAtRequest = recovery.identityOf(e.sender.id)
      // A copy pair saving onto the document's own path settles the conflict
      // before anything is prepared or written
      if (
        mode === 'save' &&
        pathAtRequest &&
        (await conflictStopsSave(e.sender, pathAtRequest, auto))
      ) {
        return done({ ok: false, error: 'external-modified' })
      }
      const pendingAtRequest = pathAtRequest
        ? await pendingOwnedAssetsForDocument(pathAtRequest)
        : []
      try {
        const suggestedName =
          typeof request.suggestedName === 'string' ? request.suggestedName : undefined
        const defaultName =
          typeof request.defaultName === 'string' ? request.defaultName : undefined
        // the AI's silent first save lands in the panel's project when it has one
        const placed =
          mode === 'save' && !pathAtRequest && suggestedName
            ? await saveIntoProject(e.sender.id, suggestedName, request.text)
            : null
        const offerExports = mode === 'saveAs'
        const target =
          placed ?? (await resolveSaveTarget(e, mode, suggestedName, defaultName, offerExports))
        if (target === 'canceled') return done({ ok: true, canceled: true })
        if (!target) return done({ ok: false, error: 'html: no save target' })
        const exportAs = offerExports
          ? SAVE_AS_EXPORT_BY_EXT[extname(target).toLowerCase()]
          : undefined
        if (exportAs) {
          // Save As › PDF, Word or ODT: a copy written by the export menu's code
          // (and opened as that export opens it). Nothing below is a save: the
          // page keeps its path, unsaved edits, recovery copy and assets.
          const html = exportHtmlOfSaveText(request.text)
          const win =
            BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
          const exported =
            exportAs === 'pdf'
              ? await writeHtmlPdf(html, pathAtRequest, target)
              : exportAs === 'docx'
                ? await writeHtmlDocx(html, pathAtRequest, target, win)
                : await writeHtmlOdt(
                    html,
                    () => pathAtRequest,
                    win,
                    async () => target,
                    false,
                  )
          if (!exported.ok || 'canceled' in exported) return done(exported)
          return done({ ok: true, path: exported.path, exported: exportAs })
        }
        const currentPath = pathAtRequest
        const isNewPath = currentPath !== target
        const imageSources = [...(request.imageSources ?? [])]
        const knownImageSources = new Set(imageSources)
        for (const source of extractHtmlAssetReferences(request.text)) {
          if (knownImageSources.has(source)) continue
          knownImageSources.add(source)
          imageSources.push(source)
        }
        const prepared =
          currentPath && resolve(dirname(currentPath)) !== resolve(dirname(target))
            ? await prepareAssetsForSaveAs(currentPath, target, request.text, imageSources)
            : null
        const textToWrite = prepared?.text ?? request.text
        const savedImageSources = prepared?.imageSources ?? imageSources
        try {
          // a page placed in the project was written by the project's write guard
          if (!placed) await writeTextAtomic(target, textToWrite)
        } catch (error) {
          if (prepared) await rollbackPreparedSaveAsAssets(prepared).catch(() => {})
          throw error
        }
        savePathByWc.set(e.sender.id, target)
        // keep the reload path in sync — a stale openPathByWc would make a
        // reloaded renderer load the OLD file and then save it over the new one
        openPathByWc.set(e.sender.id, target)
        const allowed = allowedByWc.get(e.sender.id) ?? new Set<string>()
        allowed.add(target)
        allowedByWc.set(e.sender.id, allowed)
        dirtyByWc.delete(e.sender.id)
        // the document is saved: its recovery copy goes ('saved' passes even while quitting)
        recovery.saved(e.sender.id, recoveryAtRequest)
        // Refresh the record for the written bytes; the view no longer edits a moved-away path
        await rememberDiskState(e.sender.id, target)
        if (currentPath && currentPath !== target) forgetDiskState(e.sender.id, currentPath)
        const pendingNames = prepared
          ? prepared.created.map((record) => record.name)
          : currentPath && resolve(currentPath) === resolve(target)
            ? pendingAtRequest
            : []
        const reconciled = await reconcileOwnedAssets(target, savedImageSources, { pendingNames })
        if (reconciled.errors.length > 0) {
          console.warn('[html] asset reconciliation incomplete:', reconciled.errors)
        }
        if (mode === 'saveAs' && currentPath && resolve(currentPath) !== resolve(target)) {
          const sourceResolved = await resolveSourcePendingAfterSaveAs(
            currentPath,
            pendingAtRequest,
          )
          if (sourceResolved.errors.length > 0) {
            console.warn('[html] source asset reconciliation incomplete:', sourceResolved.errors)
          }
        }
        if (isNewPath) fileSavedHook?.(e.sender, target)
        return done({
          ok: true,
          path: target,
          ...(prepared?.rewrites.length ? { imageRewrites: prepared.rewrites } : {}),
        })
      } catch (err) {
        return done({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  ipcMain.handle(HTML_CHANNELS.filesPick, async (e): Promise<AttachmentAddResult | null> => {
    const win =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgAddAttachment'),
      filters: [
        { name: tm('filterSupported'), extensions: [...ATTACHABLE_EXTS] },
        { name: tm('filterAll'), extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return collectAttachments(picked.filePaths)
  })

  ipcMain.handle(HTML_CHANNELS.filesAdd, (_e, paths: unknown) =>
    collectAttachments(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []),
  )

  ipcMain.handle(
    HTML_CHANNELS.filesAddPastedImage,
    (_e, data: unknown, ext: unknown): AttachmentAddResult => {
      const filePath = savePastedImage(data, ext)
      return filePath
        ? collectAttachments([filePath])
        : { accepted: [], rejected: [tm('errNotImage')] }
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.filesRead,
    async (
      _e,
      filePath: string,
      offset: number,
      maxChars: number,
    ): Promise<AttachmentReadResult> => {
      const name = basename(filePath)
      const ext = diagramPictureExtOf(filePath) ?? name.split('.').pop()?.toLowerCase() ?? ''
      if (!ATTACHABLE_EXTS.has(ext)) return { ok: false, error: tm('errUnsupportedExt', { ext }) }
      if (ATTACHABLE_IMAGE_EXTS.has(ext)) return { ok: false, error: tm('errImageNoText') }
      try {
        const text = await extractAttachmentText(filePath)
        const start = Math.max(0, Math.floor(offset) || 0)
        const size = Math.min(Math.max(1, Math.floor(maxChars) || 1), 48_000)
        return {
          ok: true,
          name,
          totalChars: text.length,
          offset: start,
          text: text.slice(start, start + size),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(HTML_CHANNELS.filesReadImage, (_e, filePath: string): AttachmentImageResult => {
    const name = basename(filePath)
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = ATTACHMENT_IMAGE_MIME[ext]
    if (!mime) return { ok: false, error: `${name}: ${tm('errNotImage')}` }
    try {
      const stat = statSync(filePath)
      if (stat.size > ATTACHABLE_IMAGE_MAX_BYTES) {
        return { ok: false, error: `${name}: ${tm('errImageTooLarge')}` }
      }
      return { ok: true, base64: readFileSync(filePath).toString('base64'), mime }
    } catch {
      return { ok: false, error: `${name}: ${tm('errUnreadable')}` }
    }
  })

  ipcMain.handle(HTML_CHANNELS.pickImage, async (e): Promise<string | null> => {
    const docPath = savePathByWc.get(e.sender.id)
    if (!docPath) return null
    const win =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgPickImage'),
      // only formats readImage/DOCX export can round-trip (docx-engine NewImage mimes)
      filters: [{ name: tm('filterImages'), extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
      properties: ['openFile'],
    })
    const source = picked.filePaths[0]
    if (picked.canceled || !source) return null
    return copyImageIntoOwnedAssets(docPath, source)
  })

  ipcMain.handle(
    HTML_CHANNELS.saveImage,
    async (e, data: { base64?: unknown; ext?: unknown }): Promise<string | null> => {
      const docPath = savePathByWc.get(e.sender.id)
      const ext = String(data?.ext ?? '').toLowerCase()
      if (!docPath || typeof data?.base64 !== 'string' || !data.base64) return null
      // keep in sync with readImage's MIME map — every authored asset must stay DOCX-exportable
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      return writeImageIntoOwnedAssets(docPath, `image.${ext}`, Buffer.from(data.base64, 'base64'))
    },
  )

  // html-owned (like docs:ai-generate-image): the shared ai:* handlers are
  // shell-registered, but image generation is gated per app
  ipcMain.handle(
    HTML_CHANNELS.aiGenerateImage,
    (e, op: { prompt?: unknown; aspectRatio?: unknown }) =>
      // ends with its tab, or when the tab's AI run is stopped
      withMediaCallSignal(e.sender, (signal) =>
        generateImageTool(
          join(app.getPath('userData'), 'ai-settings.json'),
          {
            prompt: String(op?.prompt ?? ''),
            aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
          },
          {
            mediaRoots: documentMediaRoots(
              htmlFilePath(e.sender.id),
              join(app.getPath('temp'), 'seuoffice-pasted'),
            ),
            // screen path: the statuses of the process-wide subscription service decide the route
            context: { path: 'screen', statuses: sharedSubscriptionStatuses() },
            signal,
          },
        ),
      ),
  )

  const MIME_BY_EXT: Record<string, ImageData['mime']> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
  }

  ipcMain.handle(HTML_CHANNELS.readImage, async (e, src: unknown): Promise<ImageData | null> => {
    const docPath = savePathByWc.get(e.sender.id)
    if (!docPath || typeof src !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
    const target = await resolveSafeRelativeImagePath(docPath, src)
    if (!target || !existsSync(target)) return null
    try {
      // "save page as, complete" assets have no extension: type them from the signature
      const mime =
        MIME_BY_EXT[extname(target).toLowerCase()] ?? editableImageMime(await readHead(target))
      if (!mime) return null
      return { base64: (await readFile(target)).toString('base64'), mime }
    } catch {
      return null
    }
  })

  // remote pictures (AI-generated or hot-linked) are downloaded here: the frame's fetch is
  // CORS-bound, and fetchImageBytes gates both the http(s) download and the generated store
  ipcMain.handle(HTML_CHANNELS.fetchImage, (_e, url: unknown): Promise<ImageData | null> =>
    fetchImageBytes(url),
  )

  ipcMain.handle(
    HTML_CHANNELS.exportDocx,
    async (e, request: ExportDocxRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${exportFileName(request.suggestedName)}.docx`,
                filters: [{ name: 'Word', extensions: ['docx'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      return writeHtmlDocx(request.html, savePathByWc.get(e.sender.id), picked.filePath, win)
    },
  )

  // ODT export: the Word export above (same html2docx bytes) converted by
  // docxToOdt; a non-empty change report is confirmed before the file is written.
  ipcMain.handle(
    HTML_CHANNELS.exportOdt,
    async (e, request: ExportOdtRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path or confirm; the CLI already chose.
      const headlessPath =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? request.outPath
          : null
      return writeHtmlOdt(
        request.html,
        () => savePathByWc.get(e.sender.id),
        win,
        async () => {
          if (headlessPath) return headlessPath
          const picked = await showSaveDialogWithMemory(
            dialog,
            win,
            {
              defaultPath: `${exportFileName(request.suggestedName)}.odt`,
              filters: [{ name: odtFilterName(), extensions: ['odt'] }],
            },
            configuredDefaultSaveDir(app),
          )
          return picked.canceled || !picked.filePath ? null : picked.filePath
        },
        headlessPath !== null,
      )
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.exportPdf,
    async (e, request: ExportPdfRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${exportFileName(request.suggestedName)}.pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      return writeHtmlPdf(request.html, savePathByWc.get(e.sender.id), picked.filePath)
    },
  )

  // Page thumbnails of the paper view: the very PDF the export writes, handed back in
  // memory. A page that cannot be rendered has no thumbnails; that is not worth a dialog.
  ipcMain.handle(
    HTML_CHANNELS.printPreview,
    async (e, request: PrintHtmlRequest): Promise<Uint8Array | null> => {
      if (typeof request?.html !== 'string') return null
      const workDir = await mkdtemp(join(tmpdir(), 'seuoffice-html-preview-'))
      try {
        return await renderPrintPdf(request.html, savePathByWc.get(e.sender.id), workDir)
      } catch (err) {
        console.error('[html] print preview failed:', err)
        return null
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.printHtml,
    async (e, request: PrintHtmlRequest): Promise<PrintResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad print request' }
      }
      // printHtml already reports why it failed and separates a dialog the
      // user closed from a real failure, so the outcome maps straight onto
      // PrintResult: the renderer can stay silent on cancel and must surface
      // a failure instead of swallowing it.
      return printHtml(request.html, savePathByWc.get(e.sender.id))
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.exportHtml,
    async (e, request: ExportHtmlRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${singleFileExportBaseName(exportFileName(request.suggestedName))}.html`,
                filters: [{ name: 'HTML', extensions: ['html'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      const docPath = savePathByWc.get(e.sender.id) ?? null
      // inlining the document into itself would silently rewrite the working file
      if (docPath && resolve(picked.filePath) === resolve(docPath)) {
        return { ok: false, error: 'single-file export cannot overwrite the open document' }
      }
      try {
        const { html, skipped } = await inlineImagesForSingleFile(request.html, docPath)
        await writeFile(picked.filePath, html, 'utf8')
        if (!isHeadlessMode()) shell.showItemInFolder(picked.filePath)
        return skipped.length
          ? { ok: true, path: picked.filePath, skipped }
          : { ok: true, path: picked.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.on(HTML_CHANNELS.provisionalTitle, (e, title: unknown) => {
    if (typeof title !== 'string' || savePathByWc.has(e.sender.id)) return
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (clean) recovery.setTitle(e.sender.id, clean)
    if (clean) provisionalTitleHook?.(e.sender, clean)
  })

  ipcMain.on(HTML_CHANNELS.dirtyChanged, (e, dirty: unknown) => {
    if (dirty === true) dirtyByWc.add(e.sender.id)
    else dirtyByWc.delete(e.sender.id)
  })

  ipcMain.on(HTML_CHANNELS.closeSaveResult, (e, ok: unknown) => {
    const waiter = closeSaveWaiters.get(e.sender.id)
    closeSaveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  ipcMain.on(HTML_CHANNELS.readTextResult, (e, result: unknown) => {
    const waiter = readTextWaiters.get(e.sender.id)
    readTextWaiters.delete(e.sender.id)
    if (!waiter) return
    if (result && typeof result === 'object' && 'text' in result) {
      waiter({ text: String((result as { text: unknown }).text) })
    } else {
      waiter({ error: 'the document could not be read' })
    }
  })

  // safety net for menu saves the renderer declined without invoking save()
  // (busy / still loading) — the save handler itself resolves the normal path
  ipcMain.on(HTML_CHANNELS.saveRequestAck, (e, ok: unknown) => {
    const waiter = saveWaiters.get(e.sender.id)
    saveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  // Language channel shared with other modules; removeHandler tolerates duplicate registration
  ipcMain.removeHandler(HTML_CHANNELS.getLanguage)
  ipcMain.handle(HTML_CHANNELS.getLanguage, () => getUiLang())
}

function grantAndTrack(wc: WebContents, openPath?: string | null): void {
  const wcId = wc.id
  if (openPath && existsSync(openPath)) {
    openPathByWc.set(wcId, openPath)
    savePathByWc.set(wcId, openPath)
    allowedByWc.set(wcId, new Set([openPath]))
  }
  installExternalLinkOpener(wc)
  recovery.track(wc)
  wc.once('destroyed', () => {
    closePresentViewsOf(wcId)
    // before the dirty flag goes: a clean close drops the copy, an unsaved or crashed one keeps it
    recovery.forget(wcId)
    openPathByWc.delete(wcId)
    allowedByWc.delete(wcId)
    savePathByWc.delete(wcId)
    dirtyByWc.delete(wcId)
    docDiskStates.delete(wcId)
    previewTextByWc.delete(wcId)
    closeSaveWaiters.get(wcId)?.(false)
    closeSaveWaiters.delete(wcId)
    saveWaiters.get(wcId)?.(false)
    saveWaiters.delete(wcId)
  })
}

function installExternalLinkOpener(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
}

/** A present view renders only the owner's preview (renderer route `?present=<owner wc id>`) */
function bindPresentView(wc: WebContents, ownerWcId: number, title: string): void {
  const wcId = wc.id
  presentOwnerByWc.set(wcId, ownerWcId)
  installExternalLinkOpener(wc)
  wc.once('destroyed', () => presentOwnerByWc.delete(wcId))
  const query = { present: String(ownerWcId), title }
  void wc.loadURL(rendererUrl(runtime.rendererUrl, 'html', query))
}

export function createHtmlPresentView(owner: WebContents, title: string): WebContentsView {
  registerHtmlIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  bindPresentView(view.webContents, owner.id, title)
  return view
}

/** hidden export windows: webContents id -> what the renderer must write */
const headlessExportTargets = new Map<number, HeadlessExportTarget>()
/** settled by the renderer's headless-export-done message (or by it dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessHtmlReport) => void>()

interface HeadlessHtmlReport {
  ok: boolean
  error?: string
}

/**
 * Render `input` to `outPath` (PDF or Word) with no visible window: a hidden
 * html renderer opens the file through the normal pending-open queue and runs
 * the File menu's own export, which already renders in a second hidden window.
 */
export async function exportHtmlHeadless(
  input: string,
  outPath: string,
  format: HeadlessExportFormat = 'pdf',
  timeoutMs = 180_000,
): Promise<void> {
  registerHtmlIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  const wcId = win.webContents.id
  grantAndTrack(win.webContents, input)
  headlessExportTargets.set(wcId, { outPath, format })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const report = await new Promise<HeadlessHtmlReport>((resolve) => {
      headlessExportWaiters.set(wcId, resolve)
      win.webContents.on('render-process-gone', (_event, details) =>
        resolve({ ok: false, error: `html renderer stopped (${details.reason})` }),
      )
      timer = setTimeout(
        () => resolve({ ok: false, error: `html export timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      void win.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
    })
    if (!report.ok) throw new Error(report.error ?? 'html export failed')
  } finally {
    if (timer) clearTimeout(timer)
    headlessExportWaiters.delete(wcId)
    headlessExportTargets.delete(wcId)
    if (!win.isDestroyed()) win.destroy()
  }
}

export function createHtmlView(openPath?: string | null): WebContentsView {
  registerHtmlIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  grantAndTrack(view.webContents, openPath)
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
  return view
}

/** Standalone window mode: `npm run dev -w @seuoffice/html`, md path passed via argv */
export function startHtmlStandalone(): void {
  registerPrivilegedSchemes()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  configureHtmlRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  void app.whenReady().then(() => {
    installRendererProtocol({ html: join(__dirname, '../renderer') })
    registerHtmlIpc()
    // shell mode leaves the shared ai:* search channels to docs-main registerAiIpc
    registerHtmlAiSearchIpc()
    const win = new BrowserWindow({
      width: 1200,
      height: 850,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const argPath = process.argv.slice(1).find((a) => /\.html?$/i.test(a) && existsSync(a))
    grantAndTrack(win.webContents, argPath)
    void win.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
  })
  app.on('window-all-closed', () => app.quit())
  // standalone has no shell to do it: no subscription program may outlive the app
  app.on('will-quit', () => shutdownSubscriptionChildren())
}
