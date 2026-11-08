import type { Lang } from '@genoffice/i18n'

/**
 * The PDF tools window: pick a task first, then the files it needs, then get
 * a new file. Every tool runs on the user's PC without AI and never writes
 * over its source. Plan: docs/plans/pdf-tools.md, decision 0030.
 *
 * Kept apart from pdf-tools-home-channels.ts: the shell preload and this
 * window's preload are separate bundle entries, and a module both import by
 * value would become a shared chunk a sandboxed preload cannot load.
 */
export const PDF_TOOLS_CHANNELS = {
  getInit: 'pdf-tools:get-init',
  pickInputs: 'pdf-tools:pick-inputs',
  run: 'pdf-tools:run',
  openResult: 'pdf-tools:open-result',
  revealResult: 'pdf-tools:reveal-result',
  openInEditor: 'pdf-tools:open-in-editor',
  findBlankPages: 'pdf-tools:find-blank-pages',
  cancelFind: 'pdf-tools:cancel-find',
  /** stop a tool that reports progress (compress) */
  cancelRun: 'pdf-tools:cancel-run',
  /** the task the PDF editor's ribbon asked for, taken once */
  takeStart: 'pdf-tools:take-start',
  /** main → window: a task from the ribbon is waiting */
  startReady: 'pdf-tools:start-ready',
  /** main → window: { done, total } while blank pages are being looked for */
  progress: 'pdf-tools:progress',
  close: 'pdf-tools:close',
} as const

/** Tools the window runs itself, each making a new file from the picked PDFs */
export const PDF_TOOL_IDS = [
  'merge',
  'split',
  'extract',
  'reverse',
  'nup',
  'rotate',
  'pageSize',
  'splitPages',
  'imagesToPdf',
  'toText',
  'duplex',
  'overlay',
  'stripAnnots',
  'blankPages',
  'compress',
  'encrypt',
  'decrypt',
  'repair',
] as const
export type PdfToolId = (typeof PDF_TOOL_IDS)[number]

/** Tools that need the PDF editor's view; their cards open the file in a PDF tab */
export const PDF_EDITOR_TOOL_IDS = ['stamps', 'crop', 'exportImages', 'convert', 'edit'] as const
export type PdfEditorToolId = (typeof PDF_EDITOR_TOOL_IDS)[number]

/** Paper sizes "page size" offers (points, portrait), the PDF editor's list */
export const PDF_TOOL_PAPERS = ['A3', 'A4', 'A5', 'Letter', 'Legal'] as const
export type PdfToolPaper = (typeof PDF_TOOL_PAPERS)[number]

/** Which PDFs a tool takes: readable ones, only password-protected ones (decrypt), or damaged ones too (repair) */
export type PdfToolAccept = 'pdf' | 'encrypted' | 'damaged'

/** What a tool takes: PDFs, or JPEG and PNG pictures (imagesToPdf) */
export type PdfToolInputKind = 'pdf' | 'image'

/** Pages a sheet will later hold N-up (duplex): 1 for no N-up */
export const PDF_TOOL_SHEET_PAGES = [1, 2, 4, 6, 8, 9, 16] as const

/** Kinds of annotation stripAnnots can remove (apps/pdf/src/main/annot-strip.ts) */
export const PDF_TOOL_ANNOT_KINDS = [
  'comments',
  'highlights',
  'drawings',
  'stamps',
  'links',
  'other',
] as const
export type PdfToolAnnotKind = (typeof PDF_TOOL_ANNOT_KINDS)[number]

/** Space around a picture on its page (imagesToPdf) */
export const PDF_TOOL_MARGINS = ['none', 'small', 'large'] as const
export type PdfToolMargin = (typeof PDF_TOOL_MARGINS)[number]

export interface PdfToolOptions {
  /** split: pages per output file */
  chunkSize?: number
  /** extract: "1-3,5" style, 1-based */
  pages?: string
  /** nup: pages per sheet (2-16), fill order and hairlines between cells */
  perSheet?: number
  direction?: 'horizontal' | 'vertical'
  separator?: boolean
  /** rotate: clockwise degrees added to every page */
  rotation?: 90 | 180 | 270
  /** pageSize: target paper */
  paper?: PdfToolPaper
  /** splitPages: pieces each page is cut into */
  perPage?: 2 | 4 | 9
  /** imagesToPdf: a paper, or 'image' for pages the size of each picture */
  imagePaper?: PdfToolPaper | 'image'
  /** imagesToPdf: space kept around each picture on a paper page */
  margin?: PdfToolMargin
  /** duplex: pages each sheet side will hold when printed N-up afterwards */
  sheetPages?: number
  /** overlay: under the page's content or over it */
  layer?: 'behind' | 'front'
  /** overlay: 1-based page of the background PDF */
  backgroundPage?: number
  /** overlay, stripAnnots: "1-3,5" style pages to work on, '' for every page */
  applyPages?: string
  /** stripAnnots: the kinds to remove */
  annotKinds?: PdfToolAnnotKind[]
  /** blankPages: "3,7" style 1-based pages to remove, all among the pages found */
  removePages?: string
  /** compress: how hard to shrink the pictures */
  compressLevel?: 'light' | 'medium' | 'strong'
  /** encrypt: the password asked for on opening; decrypt: the one that opens it now */
  password?: string
  /** encrypt, in the window only (never sent): the password typed again */
  passwordConfirm?: string
  /** encrypt: refuse printing, copying and changes without `permissionPassword` */
  restrict?: boolean
  permissionPassword?: string
}

/** One picked file, as the window may see it: an opaque id, never the path */
export interface PdfToolInput {
  id: string
  kind: PdfToolInputKind
  name: string
  /** 1 for a picture */
  pages: number
  size: number
}

export type PdfInputProblem =
  'encrypted' | 'unreadable' | 'too-large' | 'not-image' | 'not-encrypted'

export interface PdfPickResult {
  inputs: PdfToolInput[]
  rejected: { name: string; problem: PdfInputProblem }[]
}

export type PdfToolError =
  | 'no-input'
  | 'need-two'
  | 'missing'
  | 'too-large'
  | 'range'
  | 'same-as-source'
  | 'unsaved-target'
  | 'busy'
  | 'no-text'
  | 'need-background'
  | 'no-annots'
  | 'no-kinds'
  | 'all-pages'
  | 'not-found'
  | 'none-chosen'
  | 'not-smaller'
  | 'password-empty'
  | 'password-same'
  | 'password-long'
  | 'wrong-password'
  | 'failed'

export interface PdfToolRunRequest {
  tool: PdfToolId
  /** ids from pickInputs, in the order the user arranged them */
  inputIds: string[]
  options: PdfToolOptions
  /** overlay: the id of the PDF picked as the background */
  backgroundId?: string
}

export type PdfToolRunResult =
  | { ok: true; outputs: { id: string; name: string; size: number }[] }
  | { ok: false; canceled: true }
  | { ok: false; error: PdfToolError }

/** A page that may be blank, for the user to look at before anything is removed */
export interface PdfBlankCandidate {
  /** 1-based */
  page: number
  /** draws nothing at all, or white but for specks */
  reason: 'empty' | 'nearly-white'
  /** a PNG data URL of the page; null past the candidates that get one */
  thumb: string | null
}

export type PdfBlankPagesResult =
  | { ok: true; pageCount: number; candidates: PdfBlankCandidate[] }
  | { ok: false; canceled: true }
  | { ok: false; error: 'no-input' | 'missing' | 'busy' | 'failed' }

/** A task opened from the PDF editor's ribbon, its file already picked */
export interface PdfToolsStart {
  tool: PdfToolId
  inputs: PdfToolInput[]
  rejected: PdfPickResult['rejected']
}

export type PdfToolsTheme = 'light' | 'dark' | 'system'

export interface PdfToolsInit {
  lang: Lang
  theme: PdfToolsTheme
}

export interface PdfToolsWindowApi {
  getInit(): Promise<PdfToolsInit>
  onThemeChanged(handler: (theme: PdfToolsTheme) => void): () => void
  /** a main-process open dialog; the window gets ids, never paths */
  pickInputs(
    multi: boolean,
    kind?: PdfToolInputKind,
    accept?: PdfToolAccept,
  ): Promise<PdfPickResult>
  run(request: PdfToolRunRequest): Promise<PdfToolRunResult>
  openResult(id: string): Promise<void>
  revealResult(id: string): Promise<void>
  /** pick a PDF and open it in a PDF editor tab */
  openInEditor(): Promise<void>
  /** look for blank pages in a picked PDF, in a process of its own */
  findBlankPages(inputId: string): Promise<PdfBlankPagesResult>
  cancelFind(): Promise<void>
  cancelRun(): Promise<void>
  onProgress(handler: (done: number, total: number) => void): () => void
  /** the task the editor's ribbon opened this window on, once; null when none waits */
  takeStart(): Promise<PdfToolsStart | null>
  onStartReady(handler: () => void): () => void
  close(): Promise<void>
}

export interface PdfToolsHomeApi {
  open(): Promise<void>
}
