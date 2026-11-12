/**
 * The AI panel's attachments and the untitled diagram's provisional name, on the
 * main-process side. The same contract as the other editors' attachment
 * readers (`apps/slides/src/main/attachments-ipc.ts`, the html main):
 *
 * - A file is accepted by extension and size; pictures (5 MB at most) go to
 *   the model as pictures with the user message, every other kind is read as
 *   text. A diagram (`.drawio`, a draw.io picture holding its diagram) is read as its table.
 * - Text comes from `parseFileToText` and nowhere else, so what a reader
 *   withholds from a model (a withholding mark in a Word, PowerPoint or HTML
 *   file) is withheld here as well, and a file it cannot read safely is not
 *   read at all.
 * - A file open in a tab with unsaved changes is not read (`assertFileSaved`):
 *   a withholding mark only reaches the file on save.
 * - One read hands back at most 48,000 characters; the panel asks for 24,000
 *   at a time, like the other editors.
 *
 * The channels are this editor's own (`diagram:`); the shared `ai:*` and
 * subscription channels belong to the docs main and are never registered here.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { assertFileSaved, showOpenDialogWithMemory } from '@genoffice/electron-utils'
import {
  parseFileToText,
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  ATTACHABLE_IMAGE_MAX_BYTES,
  diagramPictureExtOf,
  diagramPictureExtOfName,
} from '@genoffice/file-parse'
import { createI18n, getUiLang } from '@genoffice/i18n'
import { DIAGRAM_CHANNELS } from '../shared/ipc'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
} from '../shared/ipc'

const ATTACH_STRINGS = {
  en: {
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
}

const tAttach = createI18n(ATTACH_STRINGS)
type AttachKey = keyof (typeof ATTACH_STRINGS)['en']
const tm = (key: AttachKey, vars?: Record<string, string | number>): string =>
  tAttach(getUiLang(), key, vars)

/** The largest file read as an attachment. */
export const ATTACHMENT_MAX_BYTES = ATTACHABLE_MAX_BYTES
/** The largest picture sent to the model with a message. */
export const ATTACHMENT_IMAGE_MAX_BYTES = ATTACHABLE_IMAGE_MAX_BYTES
/** The most characters one read hands back; the panel asks for less. */
export const ATTACHMENT_READ_MAX_CHARS = 48_000

/** What an attachment may be: text, office and PDF files read as text, diagrams as their read table, and pictures. */
export const ATTACHMENT_EXTS: ReadonlySet<string> = ATTACHABLE_EXTS

const ATTACHMENT_IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function extOf(name: string): string {
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
}

function statAttachment(filePath: string): { meta?: AttachmentMeta; error?: string } {
  const name = basename(filePath)
  // a draw.io picture that holds its diagram is read as diagram text
  const ext = diagramPictureExtOf(filePath) ?? extOf(name)
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

/** The files that may be attached, with a reason for each one that may not. */
export function collectAttachments(paths: readonly unknown[]): AttachmentAddResult {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || path === '') continue
    const { meta, error } = statAttachment(path)
    if (meta) accepted.push(meta)
    else if (error) rejected.push(error)
  }
  return { accepted, rejected }
}

let pastedImageSeq = 0
let pastedDirPruned = false

/** Pasted pictures older than a week are removed, once per run of the app. */
function prunePastedImages(dir: string): void {
  if (pastedDirPruned) return
  pastedDirPruned = true
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        // another tab may have removed it already
      }
    }
  } catch {
    // the folder may not exist yet
  }
}

/** A picture pasted from the clipboard (no file of its own) goes to a temporary file, then the usual way. */
function savePastedImage(data: unknown, ext: unknown): string | 'too-large' | null {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!ATTACHABLE_IMAGE_EXTS.has(cleanExt)) return null
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) return null
  // the renderer decides what lands on disk here: the picture limit applies before anything is written
  if (bytes.byteLength > ATTACHABLE_IMAGE_MAX_BYTES) return 'too-large'
  const dir = join(app.getPath('temp'), 'genoffice-pasted')
  mkdirSync(dir, { recursive: true })
  prunePastedImages(dir)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const path = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  writeFileSync(path, bytes)
  return path
}

/** Text already read, by path; a changed file (time or size) is read again. */
const textCache = new Map<string, { stamp: string; text: string }>()

async function attachmentText(filePath: string): Promise<string> {
  // a file open with unsaved changes is not read (before the cache): a
  // withholding mark only reaches the file on save
  await assertFileSaved(filePath)
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = textCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  const capExt = diagramPictureExtOfName(filePath) ?? extname(filePath)
  if (stat.size > attachableMaxBytes(capExt)) throw new Error(tm('errFileTooLarge'))
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error((!parsed.damaged && parsed.error) || tm('errParseFailed'))
  }
  textCache.set(filePath, { stamp, text: parsed.text })
  if (textCache.size > 8) {
    const oldest = textCache.keys().next().value
    if (oldest !== undefined) textCache.delete(oldest)
  }
  return parsed.text
}

/** One page of an attachment's text: from `offset`, at most `maxChars` (and never more than 48,000). */
export async function readAttachmentPage(
  filePath: unknown,
  offset: unknown,
  maxChars: unknown,
): Promise<AttachmentReadResult> {
  if (typeof filePath !== 'string' || filePath === '') {
    return { ok: false, error: tm('errUnreadable') }
  }
  const name = basename(filePath)
  const ext = diagramPictureExtOf(filePath) ?? extOf(name)
  if (!ATTACHABLE_EXTS.has(ext)) return { ok: false, error: tm('errUnsupportedExt', { ext }) }
  if (ATTACHABLE_IMAGE_EXTS.has(ext)) return { ok: false, error: tm('errImageNoText') }
  try {
    const text = await attachmentText(filePath)
    const start = Math.max(0, Math.floor(Number(offset)) || 0)
    const size = Math.min(Math.max(1, Math.floor(Number(maxChars)) || 1), ATTACHMENT_READ_MAX_CHARS)
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
}

/** A picture attachment as base64, for the user message. */
export function readAttachmentImage(filePath: unknown): AttachmentImageResult {
  const path = typeof filePath === 'string' ? filePath : ''
  const name = basename(path)
  const mime = ATTACHMENT_IMAGE_MIME[extOf(name)]
  if (!path || !mime) return { ok: false, error: `${name}: ${tm('errNotImage')}` }
  try {
    const stat = statSync(path)
    if (stat.size > ATTACHABLE_IMAGE_MAX_BYTES) {
      return { ok: false, error: `${name}: ${tm('errImageTooLarge')}` }
    }
    return { ok: true, base64: readFileSync(path).toString('base64'), mime }
  } catch {
    return { ok: false, error: `${name}: ${tm('errUnreadable')}` }
  }
}

/** An untitled diagram got a provisional name from the user's first AI request: the shell titles its tab. */
let provisionalTitleHook: ((wc: WebContents, title: string) => void) | null = null

export function setDiagramProvisionalTitleHook(
  hook: ((wc: WebContents, title: string) => void) | null,
): void {
  provisionalTitleHook = hook
}

export interface DiagramAiIpcOptions {
  /** whether the view already has a file of its own (then its tab keeps the file's name) */
  hasFile(webContentsId: number): boolean
}

let aiIpcRegistered = false

/**
 * Registers the attachment channels and the provisional name. The editor's
 * own channel registration (`createDiagramView`) calls it; a second call does
 * nothing, so a name is never registered twice.
 */
export function registerDiagramAiIpc(options: DiagramAiIpcOptions): void {
  if (aiIpcRegistered) return
  aiIpcRegistered = true
  ipcMain.handle(DIAGRAM_CHANNELS.filesPick, async (e): Promise<AttachmentAddResult | null> => {
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

  ipcMain.handle(DIAGRAM_CHANNELS.filesAdd, (_e, paths: unknown) =>
    collectAttachments(Array.isArray(paths) ? paths : []),
  )

  ipcMain.handle(
    DIAGRAM_CHANNELS.filesAddPastedImage,
    (_e, data: unknown, ext: unknown): AttachmentAddResult => {
      const saved = savePastedImage(data, ext)
      if (saved === 'too-large') return { accepted: [], rejected: [tm('errImageTooLarge')] }
      return saved ? collectAttachments([saved]) : { accepted: [], rejected: [tm('errNotImage')] }
    },
  )

  ipcMain.handle(
    DIAGRAM_CHANNELS.filesRead,
    (_e, filePath: unknown, offset: unknown, maxChars: unknown) =>
      readAttachmentPage(filePath, offset, maxChars),
  )

  ipcMain.handle(DIAGRAM_CHANNELS.filesReadImage, (_e, filePath: unknown) =>
    readAttachmentImage(filePath),
  )

  ipcMain.on(DIAGRAM_CHANNELS.provisionalTitle, (e, title: unknown) => {
    if (typeof title !== 'string' || options.hasFile(e.sender.id)) return
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (clean) provisionalTitleHook?.(e.sender, clean)
  })
}
