import type { Lang } from '@genoffice/i18n'

export type QuickLookTheme = 'light' | 'dark' | 'system'

export type QuickLookFamily =
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'hwp'
  | 'xmind'
  | 'md'
  | 'html'
  | 'image'
  | 'text'
  | 'unsupported'

const FAMILY_BY_EXT: Readonly<Record<string, QuickLookFamily>> = {
  docx: 'docx',
  doc: 'docx',
  odt: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xls: 'xlsx',
  csv: 'xlsx',
  tsv: 'xlsx',
  pptx: 'pptx',
  ppt: 'pptx',
  pdf: 'pdf',
  hwp: 'hwp',
  hwpx: 'hwp',
  xmind: 'xmind',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  txt: 'text',
  json: 'text',
  xml: 'text',
  log: 'text',
  py: 'text',
}

export const QUICK_LOOK_SUPPORTED_EXTS: ReadonlySet<string> = new Set(Object.keys(FAMILY_BY_EXT))

export function quickLookFamilyOf(ext: string): QuickLookFamily {
  const clean = ext.trim().replace(/^\./, '').toLowerCase()
  return FAMILY_BY_EXT[clean] ?? 'unsupported'
}

export function isQuickLookSupportedPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/')
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return QUICK_LOOK_SUPPORTED_EXTS.has(ext)
}

export interface QuickLookSheet {
  name: string
  rows: string[][]
  truncatedRows: boolean
  truncatedCols: boolean
}

export interface QuickLookSlide {
  number: number
  title: string
  bullets: string[]
  notes: string[]
}

export interface QuickLookDocBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'table' | 'code'
  level?: number
  text?: string
  rows?: string[][]
}

export interface QuickLookMindmapNode {
  depth: number
  text: string
}

export interface QuickLookMindmapSheet {
  title: string
  nodes: QuickLookMindmapNode[]
}

export type QuickLookErrorCode = 'missing' | 'encrypted' | 'unsupported' | 'unreadable'

export interface QuickLookPayload {
  ok: boolean
  path: string
  name: string
  ext: string
  family: QuickLookFamily
  sizeBytes: number
  mtimeMs: number
  /** Embedded preview thumbnail or image file as a data:image/... URL */
  thumbnailDataUrl?: string
  /** Structured document blocks for Word / ODT / HWP / Markdown */
  docBlocks?: QuickLookDocBlock[]
  /** Structured sheets for Excel / CSV / TSV */
  sheets?: QuickLookSheet[]
  /** Structured slides for PowerPoint */
  slides?: QuickLookSlide[]
  /** Structured mindmap sheets for XMind */
  mindmap?: QuickLookMindmapSheet[]
  /** Plain text fallback or source preview */
  plainText?: string
  /** Whether the extracted content was capped for preview speed */
  truncated?: boolean
  /** Error classification when ok === false */
  error?: QuickLookErrorCode
  errorMessage?: string
}

export interface QuickLookWindowInit {
  lang: Lang
  theme: QuickLookTheme
  payload: QuickLookPayload | null
}

export type QuickLookInit = QuickLookWindowInit

export interface QuickLookWindowApi {
  getInit(): Promise<QuickLookWindowInit>
  onUpdate(handler: (payload: QuickLookPayload) => void): () => void
  onWillShow(handler: () => void): () => void
  onWillHide(handler: () => void): () => void
  onThemeChanged(handler: (theme: QuickLookTheme) => void): () => void
  onLangChanged(handler: (lang: Lang) => void): () => void
  openInEditor(): Promise<void>
  revealInFolder(): Promise<void>
  close(): Promise<void>
}

export const QUICK_LOOK_WINDOW_CHANNELS = {
  getInit: 'quick-look:get-init',
  update: 'quick-look:payload',
  willShow: 'quick-look:will-show',
  willHide: 'quick-look:will-hide',
  themeChanged: 'quick-look:theme-changed',
  langChanged: 'quick-look:lang-changed',
  openInEditor: 'quick-look:open-in-editor',
  revealInFolder: 'quick-look:reveal-in-folder',
  close: 'quick-look:close',
} as const
