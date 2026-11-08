/**
 * The note of each PDF (reading-assist spec 4.9, 5.4): one Markdown file per
 * PDF, linked in the result store's `note-links.json`.
 *
 * Paths: the PDF is the asking view's own document (the main process knows
 * it), the note is a path the person chose in this process's save dialog or
 * one read back from `note-links.json`. No handler takes a path from the
 * renderer; a request only carries text parts (excerpt, page, body, title).
 *
 * The note file is written here only once, when it does not exist yet (a
 * one-line `# <title>` header, exclusive create). Everything else goes to
 * the open note tab through the shell (`insertIntoNote`): the Markdown
 * editor does not re-read its file, so writing the file would split the tab
 * from the disk.
 */
import { access, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Lang } from '@genoffice/i18n'
import type {
  FoundNoteLink,
  NoteLink,
  NoteLinks,
} from '../../../../packages/pdf-structure/src/store'
import { noteLinkKey } from '../../../../packages/pdf-structure/src/store'
import type { PdfNoteInsertRequest, PdfNoteOpenRequest, PdfNoteResult } from '../shared/ipc'

/** the store calls this module makes (ResultStore) */
export interface NoteLinkStore {
  readNoteLinks(): Promise<NoteLinks>
  findNoteLink(pdfPath: string, docHash: string): Promise<FoundNoteLink | null>
  setNoteLink(pdfPath: string, link: Pick<NoteLink, 'notePath' | 'docHash'>): Promise<void>
  updateNoteLinkDocHash(pdfPath: string, docHash: string): Promise<boolean>
}

/** what the shell injects (configurePdfRuntime); absent when the pdf app runs alone */
export interface NoteHost {
  openNote?: (path: string) => boolean | Promise<boolean>
  insertIntoNote?: (path: string, text: string) => boolean | Promise<boolean>
}

export interface NoteLinkDeps {
  store(): NoteLinkStore
  hashFile(path: string): Promise<string>
  /** a shell-created blank still carrying its untitled name (never saved by the person) */
  isUntitled(pdfPath: string): boolean
  /** the main-process save dialog for the asking view; null when cancelled */
  pickNotePath(owner: number, defaultPath: string): Promise<string | null>
  /** "note" in the UI language, for the default file name */
  noteWord(): string
  host(): NoteHost
  /** exclusive create; false when the file already exists */
  createNoteFile?(path: string, text: string): Promise<boolean>
  fileExists?(path: string): Promise<boolean>
  platform?: NodeJS.Platform
}

const MAX_EXCERPT_CHARS = 20_000
const MAX_BODY_CHARS = 200_000
const MAX_HEADING_CHARS = 200
const MAX_TITLE_CHARS = 300
const MAX_PAGE = 1_000_000

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)

/** one link segment, percent-encoded (parentheses too: they would end a Markdown link) */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** a file:/// URL of an absolute path, every segment encoded except a drive letter */
function fileUrl(absolute: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform)
  const normalized = p.normalize(absolute)
  if (platform === 'win32' && normalized.startsWith('\\\\')) {
    // UNC: \\server\share\dir\file → file://server/share/dir/file
    const [host, ...rest] = normalized.slice(2).split('\\')
    return `file://${host}/${rest.map(encodeSegment).join('/')}`
  }
  const parts = normalized.split(p.sep).filter((part, i) => part !== '' || i === 0)
  const encoded = parts.map((part) => (/^[A-Za-z]:$/.test(part) ? part : encodeSegment(part)))
  const joined = encoded.join('/')
  return `file:///${joined.replace(/^\/+/, '')}`
}

/**
 * The link to the PDF as written in the note: the path relative to the note's
 * folder with `/` separators and encoded segments; a `file:///` URL when no
 * relative path exists (another drive).
 */
export function pdfLinkFromNote(
  notePath: string,
  pdfPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathApi(platform)
  const noteDir = p.dirname(p.resolve(notePath))
  const pdf = p.resolve(pdfPath)
  const rootOf = (path: string) => p.parse(path).root.toLowerCase()
  if (platform === 'win32' && rootOf(noteDir) !== rootOf(pdf)) return fileUrl(pdf, platform)
  const relative = p.relative(noteDir, pdf)
  if (relative === '' || p.isAbsolute(relative)) return fileUrl(pdf, platform)
  return relative.split(p.sep).map(encodeSegment).join('/')
}

/**
 * Inserted text is document or model output: a Markdown image (`![…]`) or a
 * raw `<img>` tag in it would make the note's editor fetch a remote picture.
 * Both lose their meaning behind a backslash; one already escaped (an odd run
 * of backslashes before it) stays as it is.
 */
function withoutImages(text: string): string {
  return text.replace(/(\\*)(!\[|<img\b)/gi, (match, slashes: string, mark: string) =>
    slashes.length % 2 === 1 ? match : `${slashes}\\${mark}`,
  )
}

/** the text one "Add to note" puts at the end of the note (spec 4.9) */
export function noteInsertText(
  notePath: string,
  pdfPath: string,
  request: PdfNoteInsertRequest,
  platform: NodeJS.Platform = process.platform,
): string {
  const body = withoutImages(request.body?.trim() ?? '')
  let head: string
  if (request.kind === 'overview') {
    head = `## ${withoutImages(request.heading.trim())}`
  } else {
    const link = `([p.${request.page}](${pdfLinkFromNote(notePath, pdfPath, platform)}#page=${request.page}))`
    const lines = withoutImages(request.excerpt)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length === 0) {
      head = `> ${link}`
    } else {
      const quoted = lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`))
      quoted[quoted.length - 1] += ` ${link}`
      head = quoted.join('\n')
    }
  }
  return body ? `${head}\n\n${body}` : head
}

const textOf = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null

function titleOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
  return line || undefined
}

/** the renderer's request reduced to its text parts; null when malformed (any path is dropped) */
export function parseNoteInsertRequest(raw: unknown): PdfNoteInsertRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = titleOf(r.title)
  if (r.kind === 'quote') {
    const excerpt = textOf(r.excerpt, MAX_EXCERPT_CHARS)
    const page = r.page
    if (excerpt === null) return null
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE)
      return null
    const body = r.body === undefined ? undefined : textOf(r.body, MAX_BODY_CHARS)
    if (body === null) return null
    return {
      kind: 'quote',
      excerpt,
      page,
      ...(body !== undefined ? { body } : {}),
      ...(title ? { title } : {}),
    }
  }
  if (r.kind === 'overview') {
    const heading = textOf(r.heading, MAX_HEADING_CHARS)
    const body = textOf(r.body, MAX_BODY_CHARS)
    if (!heading?.trim() || !body?.trim()) return null
    return { kind: 'overview', heading, body, ...(title ? { title } : {}) }
  }
  return null
}

export function parseNoteOpenRequest(raw: unknown): PdfNoteOpenRequest {
  const title =
    raw && typeof raw === 'object' ? titleOf((raw as { title?: unknown }).title) : undefined
  return title ? { title } : {}
}

/** `<PDF folder>/<PDF name without extension> <note word>.md` */
export function defaultNotePath(
  pdfPath: string,
  noteWord: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathApi(platform)
  const stem = p.basename(pdfPath).replace(/\.pdf$/i, '')
  return p.join(p.dirname(pdfPath), `${stem} ${noteWord}.md`)
}

async function defaultCreateNoteFile(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isMarkdownPath = (path: string) => /\.md$/i.test(path)

export interface NoteLinkService {
  open(owner: number, pdfPath: string | null, request: PdfNoteOpenRequest): Promise<PdfNoteResult>
  insert(
    owner: number,
    pdfPath: string | null,
    request: PdfNoteInsertRequest,
  ): Promise<PdfNoteResult>
  /** after a save wrote `pdfPath` in place: the link of that path follows the new hash */
  afterSave(pdfPath: string): Promise<void>
}

export function createNoteLinkService(deps: NoteLinkDeps): NoteLinkService {
  const platform = deps.platform ?? process.platform
  const createNoteFile = deps.createNoteFile ?? defaultCreateNoteFile
  const fileExists = deps.fileExists ?? defaultFileExists
  /** views with a note request in flight (one save dialog per view) */
  const busy = new Set<number>()

  /** the linked note, or the one the person picks now; a refusal otherwise */
  async function resolveNote(
    owner: number,
    pdfPath: string,
    title: string | undefined,
  ): Promise<{ notePath: string } | PdfNoteResult> {
    const store = deps.store()
    const docHash = await deps.hashFile(pdfPath)
    const found = await store.findNoteLink(pdfPath, docHash)
    if (found) {
      // a copy found by hash keeps its own link from now on
      if (found.matchedBy === 'docHash') {
        await store.setNoteLink(pdfPath, { notePath: found.notePath, docHash })
      }
      return { notePath: found.notePath }
    }
    const picked = await deps.pickNotePath(
      owner,
      defaultNotePath(pdfPath, deps.noteWord(), platform),
    )
    if (!picked) return { ok: false, reason: 'cancelled' }
    const p = pathApi(platform)
    if (!p.isAbsolute(picked)) return { ok: false, reason: 'failed', message: 'not absolute' }
    const notePath = isMarkdownPath(picked) ? picked : `${picked}.md`
    if (!(await fileExists(notePath))) {
      const header = `# ${title ?? p.basename(pdfPath)}\n`
      // a file that appeared meanwhile is linked as it is, never overwritten
      await createNoteFile(notePath, header)
    }
    await store.setNoteLink(pdfPath, { notePath, docHash })
    return { notePath }
  }

  async function run(
    owner: number,
    pdfPath: string | null,
    title: string | undefined,
    use: (host: Required<NoteHost>, notePath: string) => Promise<boolean>,
  ): Promise<PdfNoteResult> {
    if (!pdfPath || deps.isUntitled(pdfPath)) return { ok: false, reason: 'unsaved' }
    const host = deps.host()
    if (!host.openNote || !host.insertIntoNote) return { ok: false, reason: 'unavailable' }
    if (busy.has(owner)) return { ok: false, reason: 'busy' }
    busy.add(owner)
    try {
      const resolved = await resolveNote(owner, pdfPath, title)
      if (!('notePath' in resolved)) return resolved
      const ok = await use(host as Required<NoteHost>, resolved.notePath)
      return ok ? { ok: true } : { ok: false, reason: 'failed' }
    } catch (err) {
      return {
        ok: false,
        reason: 'failed',
        message: err instanceof Error ? err.message : String(err),
      }
    } finally {
      busy.delete(owner)
    }
  }

  return {
    open: (owner, pdfPath, request) =>
      run(owner, pdfPath, request.title, async (host, notePath) => host.openNote(notePath)),
    insert: (owner, pdfPath, request) =>
      run(owner, pdfPath, request.title, async (host, notePath) =>
        host.insertIntoNote(notePath, noteInsertText(notePath, pdfPath ?? '', request, platform)),
      ),
    afterSave: async (pdfPath) => {
      try {
        const store = deps.store()
        const { links } = await store.readNoteLinks()
        if (!links[noteLinkKey(pdfPath, platform)]) return
        await store.updateNoteLinkDocHash(pdfPath, await deps.hashFile(pdfPath))
      } catch (err) {
        console.warn('[pdf] note link hash update failed:', err)
      }
    },
  }
}

// ── main-process words (the save dialog and the default file name) ──

type NoteDialogKey = 'noteWord' | 'dialogTitle' | 'filterMarkdown'

export const NOTE_DIALOG_TEXT: Record<Lang, Record<NoteDialogKey, string>> = {
  zh: { noteWord: '笔记', dialogTitle: '选择此 PDF 的笔记文件', filterMarkdown: 'Markdown 文档' },
  en: {
    noteWord: 'Note',
    dialogTitle: 'Choose the note file for this PDF',
    filterMarkdown: 'Markdown document',
  },
  ja: {
    noteWord: 'ノート',
    dialogTitle: 'この PDF のノートファイルを選択',
    filterMarkdown: 'Markdown 文書',
  },
  ko: {
    noteWord: '노트',
    dialogTitle: '이 PDF의 노트 파일 고르기',
    filterMarkdown: '마크다운 문서',
  },
  fr: {
    noteWord: 'Notes',
    dialogTitle: 'Choisir le fichier de notes de ce PDF',
    filterMarkdown: 'Document Markdown',
  },
  de: {
    noteWord: 'Notizen',
    dialogTitle: 'Notizdatei für dieses PDF wählen',
    filterMarkdown: 'Markdown-Dokument',
  },
  es: {
    noteWord: 'Notas',
    dialogTitle: 'Elegir el archivo de notas de este PDF',
    filterMarkdown: 'Documento Markdown',
  },
  th: {
    noteWord: 'โน้ต',
    dialogTitle: 'เลือกไฟล์โน้ตของ PDF นี้',
    filterMarkdown: 'เอกสาร Markdown',
  },
  id: {
    noteWord: 'Catatan',
    dialogTitle: 'Pilih file catatan untuk PDF ini',
    filterMarkdown: 'Dokumen Markdown',
  },
  ru: {
    noteWord: 'Заметки',
    dialogTitle: 'Выберите файл заметок для этого PDF',
    filterMarkdown: 'Документ Markdown',
  },
  ar: {
    noteWord: 'ملاحظات',
    dialogTitle: 'اختر ملف الملاحظات لملف PDF هذا',
    filterMarkdown: 'مستند Markdown',
  },
  pt: {
    noteWord: 'Notas',
    dialogTitle: 'Escolher o arquivo de notas deste PDF',
    filterMarkdown: 'Documento Markdown',
  },
  it: {
    noteWord: 'Note',
    dialogTitle: 'Scegli il file di note di questo PDF',
    filterMarkdown: 'Documento Markdown',
  },
  pl: {
    noteWord: 'Notatki',
    dialogTitle: 'Wybierz plik notatek dla tego PDF',
    filterMarkdown: 'Dokument Markdown',
  },
  cs: {
    noteWord: 'Poznámky',
    dialogTitle: 'Vyberte soubor poznámek k tomuto PDF',
    filterMarkdown: 'Dokument Markdown',
  },
  nl: {
    noteWord: 'Notities',
    dialogTitle: 'Kies het notitiebestand voor deze pdf',
    filterMarkdown: 'Markdown-document',
  },
  ms: {
    noteWord: 'Nota',
    dialogTitle: 'Pilih fail nota untuk PDF ini',
    filterMarkdown: 'Dokumen Markdown',
  },
  he: {
    noteWord: 'הערות',
    dialogTitle: 'בחירת קובץ ההערות של PDF זה',
    filterMarkdown: 'מסמך Markdown',
  },
  hi: {
    noteWord: 'नोट',
    dialogTitle: 'इस PDF की नोट फ़ाइल चुनें',
    filterMarkdown: 'Markdown दस्तावेज़',
  },
  'zh-TW': {
    noteWord: '筆記',
    dialogTitle: '選擇此 PDF 的筆記檔案',
    filterMarkdown: 'Markdown 文件',
  },
  vi: {
    noteWord: 'Ghi chú',
    dialogTitle: 'Chọn tệp ghi chú cho PDF này',
    filterMarkdown: 'Tài liệu Markdown',
  },
}

export function noteDialogText(lang: Lang, key: NoteDialogKey): string {
  return (NOTE_DIALOG_TEXT[lang] ?? NOTE_DIALOG_TEXT.en)[key]
}
