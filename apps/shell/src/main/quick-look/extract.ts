import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '@genoffice/docx-engine'
import { parseFileToText, type ParsedFile } from '@genoffice/file-parse'
import {
  QUICK_LOOK_SUPPORTED_EXTS,
  isQuickLookSupportedPath,
  quickLookFamilyOf,
  type QuickLookDocBlock,
  type QuickLookErrorCode,
  type QuickLookMindmapSheet,
  type QuickLookPayload,
  type QuickLookSheet,
  type QuickLookSlide,
} from '../../shared/quick-look-api'

export { QUICK_LOOK_SUPPORTED_EXTS, isQuickLookSupportedPath, quickLookFamilyOf }

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
const MAX_PLAIN_CHARS = 12_000
const MAX_DOC_BLOCKS = 120
const MAX_SHEETS = 8
const MAX_SHEET_ROWS = 50
const MAX_SHEET_COLS = 15
const MAX_SLIDES = 30
const MAX_MINDMAP_SHEETS = 6
const MAX_MINDMAP_NODES = 120

const IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function toDataUrl(bytes: Uint8Array, mime: string): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * Extract the preview image from an HWP 5 OLE2 container (`/PrvImage` stream).
 * HWP 5 stores a BMP or GIF of the first page in `/PrvImage`.
 */
function extractHwp5Thumbnail(bytes: Buffer): string | undefined {
  try {
    const cfb = CFB.read(bytes, { type: 'buffer' })
    const entry = CFB.find(cfb, '/PrvImage') ?? CFB.find(cfb, 'PrvImage')
    if (!entry?.content || entry.content.length < 8) return undefined
    const raw = Buffer.from(entry.content as Uint8Array)
    const directMime = sniffImageMime(raw)
    if (directMime) return toDataUrl(raw, directMime)
    // Some writers deflate PrvImage when the header compressed bit is set
    const inflated = inflateRawSync(raw)
    const inflatedMime = sniffImageMime(inflated)
    if (inflatedMime) return toDataUrl(inflated, inflatedMime)
  } catch {
    // Thumbnail is optional; ignore malformed containers here
  }
  return undefined
}

const ZIP_THUMBNAIL_CANDIDATES = [
  'Preview/PrvImage.png',
  'Preview/PrvImage.bmp',
  'Preview/PrvImage.gif',
  'Preview/PrvImage.jpg',
  'Preview/PrvImage.jpeg',
  'Thumbnails/thumbnail.png',
  'Thumbnails/thumbnail.jpg',
  'Thumbnails/thumbnail.jpeg',
  'docProps/thumbnail.png',
  'docProps/thumbnail.jpeg',
  'docProps/thumbnail.jpg',
  'docProps/thumbnail.gif',
]

/**
 * Extract an embedded thumbnail image from a ZIP-based office/HWPX/ODT/XMind file
 * after running the zip-bomb inflation gate.
 */
async function extractZipThumbnail(bytes: Buffer): Promise<string | undefined> {
  try {
    await assertZipInflatesWithinLimits(bytes)
    const zip = await JSZip.loadAsync(bytes)
    for (const candidate of ZIP_THUMBNAIL_CANDIDATES) {
      const entry =
        zip.file(candidate) ??
        Object.values(zip.files).find(
          (f) => !f.dir && f.name.toLowerCase() === candidate.toLowerCase(),
        )
      if (!entry) continue
      const imgBytes = await entry.async('uint8array')
      const mime = sniffImageMime(imgBytes)
      if (mime) {
        const url = toDataUrl(imgBytes, mime)
        if (url) return url
      }
    }
  } catch {
    // Optional thumbnail extraction
  }
  return undefined
}

export async function extractEmbeddedThumbnail(
  ext: string,
  bytes: Buffer,
): Promise<string | undefined> {
  if (bytes.length < 4) return undefined
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  if (ext === 'hwp' && isOle) {
    return extractHwp5Thumbnail(bytes)
  }
  if (
    isZip &&
    (ext === 'hwpx' ||
      ext === 'hwp' ||
      ext === 'docx' ||
      ext === 'doc' ||
      ext === 'pptx' ||
      ext === 'xlsx' ||
      ext === 'xlsm' ||
      ext === 'odt' ||
      ext === 'xmind')
  ) {
    return extractZipThumbnail(bytes)
  }
  return undefined
}

/** Parse CSV or TSV text into a single sheet preview */
function parseDelimitedSheet(name: string, text: string, delimiter: ',' | '\t'): QuickLookSheet {
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && !line))
  const truncatedRows = lines.length > MAX_SHEET_ROWS
  const slicedLines = lines.slice(0, MAX_SHEET_ROWS)
  let truncatedCols = false
  const rows: string[][] = slicedLines.map((line) => {
    const cells = splitDelimitedLine(line, delimiter)
    if (cells.length > MAX_SHEET_COLS) {
      truncatedCols = true
      return cells.slice(0, MAX_SHEET_COLS)
    }
    return cells
  })
  return { name, rows, truncatedRows, truncatedCols }
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  if (delimiter === '\t') return line.split('\t')
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** Parse `xlsxToText` output (`# SheetName` sections with ` | ` separated cells) into sheets */
export function parseSheetsFromText(
  text: string,
  ext: string,
  fallbackName: string,
): { sheets: QuickLookSheet[]; truncated: boolean } {
  if (ext === 'csv' || ext === 'tsv') {
    const sheet = parseDelimitedSheet(fallbackName, text, ext === 'tsv' ? '\t' : ',')
    return {
      sheets: [sheet],
      truncated: sheet.truncatedRows || sheet.truncatedCols,
    }
  }

  const lines = text.split(/\r?\n/)
  const rawSheets: Array<{ name: string; lines: string[] }> = []
  let current: { name: string; lines: string[] } | null = null

  for (const line of lines) {
    if (line.startsWith('# ')) {
      current = { name: line.slice(2).trim() || `Sheet ${rawSheets.length + 1}`, lines: [] }
      rawSheets.push(current)
      continue
    }
    if (!current) {
      if (!line.trim()) continue
      current = { name: fallbackName, lines: [] }
      rawSheets.push(current)
    }
    if (line.trim() !== '') {
      current.lines.push(line)
    }
  }

  let truncated = rawSheets.length > MAX_SHEETS
  const sheets: QuickLookSheet[] = rawSheets.slice(0, MAX_SHEETS).map((s) => {
    const truncatedRows = s.lines.length > MAX_SHEET_ROWS
    let truncatedCols = false
    const rows = s.lines.slice(0, MAX_SHEET_ROWS).map((rowLine) => {
      const cells = rowLine.split(' | ')
      if (cells.length > MAX_SHEET_COLS) {
        truncatedCols = true
        return cells.slice(0, MAX_SHEET_COLS)
      }
      return cells
    })
    if (truncatedRows || truncatedCols) truncated = true
    return {
      name: s.name,
      rows,
      truncatedRows,
      truncatedCols,
    }
  })

  return { sheets, truncated }
}

/** Parse `pptxToText` / `pptToText` output (`## Slide N` and `### Notes`) into slide cards */
export function parseSlidesFromText(text: string): {
  slides: QuickLookSlide[]
  truncated: boolean
} {
  const lines = text.split(/\r?\n/)
  const slides: QuickLookSlide[] = []
  let current: QuickLookSlide | null = null
  // Anything after a `### Notes`/`### Comments` heading belongs to that section: Notes feeds
  // the notes card; Comments (pptx text output) is skipped so its lines are never mistaken
  // for slide bullets. Any other `###` line is ordinary slide text.
  let section: 'body' | 'notes' | 'other' = 'body'

  for (const line of lines) {
    const slideMatch = /^##\s+Slide\s+(\d+)\b/i.exec(line)
    if (slideMatch) {
      current = {
        number: Number(slideMatch[1]),
        title: '',
        bullets: [],
        notes: [],
      }
      slides.push(current)
      section = 'body'
      continue
    }
    if (!current) continue
    if (/^###\s+Notes\b/i.test(line)) {
      section = 'notes'
      continue
    }
    if (/^###\s+Comments\b/i.test(line)) {
      section = 'other'
      continue
    }
    const trimmed = line.trim()
    if (!trimmed) continue
    if (section === 'notes') {
      current.notes.push(trimmed)
    } else if (section === 'body') {
      if (!current.title) current.title = trimmed
      else current.bullets.push(trimmed)
    }
  }

  // Fallback for legacy .ppt or decks without "## Slide N" headers
  if (slides.length === 0 && text.trim()) {
    const paragraphs = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    slides.push({
      number: 1,
      title: paragraphs[0] ?? '',
      bullets: paragraphs.slice(1, 20),
      notes: [],
    })
  }

  const truncated = slides.length > MAX_SLIDES
  return { slides: slides.slice(0, MAX_SLIDES), truncated }
}

/** Parse `xmindToText` outline (`# SheetTitle` and indented `- Topic`) into mindmap sheets */
export function parseMindmapFromText(text: string): {
  mindmap: QuickLookMindmapSheet[]
  truncated: boolean
} {
  const lines = text.split(/\r?\n/)
  const sheets: QuickLookMindmapSheet[] = []
  let current: QuickLookMindmapSheet | null = null
  let truncated = false

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (sheets.length >= MAX_MINDMAP_SHEETS) {
        truncated = true
        break
      }
      current = { title: line.slice(2).trim() || `Map ${sheets.length + 1}`, nodes: [] }
      sheets.push(current)
      continue
    }
    const bulletMatch = /^(\s*)-\s+(.*)$/.exec(line)
    if (bulletMatch) {
      if (!current) {
        current = { title: 'Map 1', nodes: [] }
        sheets.push(current)
      }
      if (current.nodes.length >= MAX_MINDMAP_NODES) {
        truncated = true
        continue
      }
      const indent = bulletMatch[1]?.length ?? 0
      const depth = Math.min(6, Math.floor(indent / 2))
      current.nodes.push({ depth, text: bulletMatch[2]!.trim() })
    }
  }

  return { mindmap: sheets, truncated }
}

/**
 * Parse Word / ODT / HWP / Markdown extracted text into structured document blocks
 * (headings, bullet items, pipe/tab tables, code blocks, and paragraphs).
 */
export function parseDocBlocksFromText(text: string): {
  docBlocks: QuickLookDocBlock[]
  truncated: boolean
} {
  const lines = text.split(/\r?\n/)
  const blocks: QuickLookDocBlock[] = []
  let tableRows: string[][] | null = null
  let codeLines: string[] | null = null
  let truncated = false

  const flushTable = () => {
    if (tableRows && tableRows.length > 0) {
      blocks.push({ kind: 'table', rows: tableRows })
      tableRows = null
    }
  }

  const flushCode = () => {
    if (codeLines !== null) {
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      codeLines = null
    }
  }

  for (const line of lines) {
    if (blocks.length >= MAX_DOC_BLOCKS) {
      truncated = true
      break
    }

    if (line.trim().startsWith('```')) {
      flushTable()
      if (codeLines !== null) {
        flushCode()
      } else {
        codeLines = []
      }
      continue
    }

    if (codeLines !== null) {
      if (codeLines.length < 40) codeLines.push(line)
      continue
    }

    // Pipe-separated table row (docx, hwp, markdown) or tab-separated row (odt)
    const hasPipeCells = line.includes(' | ')
    const hasTabCells = !hasPipeCells && line.includes('\t') && line.split('\t').length >= 2
    if (hasPipeCells || hasTabCells) {
      const rawCells = hasPipeCells
        ? line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim())
        : line.split('\t').map((c) => c.trim())
      // Skip markdown separator rows like |---|---|
      if (rawCells.every((c) => /^[-:]+$/.test(c))) continue
      if (!tableRows) tableRows = []
      if (tableRows.length < 30) {
        tableRows.push(rawCells.slice(0, 12))
      } else {
        truncated = true
      }
      continue
    }

    flushTable()

    const trimmed = line.trim()
    if (!trimmed) continue

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (headingMatch) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
      })
      continue
    }

    const bulletMatch = /^[-*•]\s+(.*)$/.exec(trimmed)
    if (bulletMatch) {
      blocks.push({
        kind: 'bullet',
        text: bulletMatch[1]!.trim(),
      })
      continue
    }

    blocks.push({
      kind: 'paragraph',
      text: trimmed,
    })
  }

  flushTable()
  flushCode()

  return { docBlocks: blocks, truncated }
}

function classifyParseError(error?: string): QuickLookErrorCode {
  if (!error) return 'unreadable'
  if (/password|encrypted|암호/i.test(error)) return 'encrypted'
  if (/unsupported file type/i.test(error)) return 'unsupported'
  return 'unreadable'
}

export interface ExtractQuickLookDeps {
  stat?: (path: string) => Promise<{ isFile(): boolean; size: number; mtimeMs: number }>
  readFile?: (path: string) => Promise<Buffer>
  parse?: (path: string) => Promise<ParsedFile>
}

interface CacheEntry {
  key: string
  payload: QuickLookPayload
}

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRIES = 24

function cacheKeyOf(filePath: string, size: number, mtimeMs: number): string {
  const norm = process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath)
  return `${norm}|${size}|${mtimeMs}`
}

function rememberPayload(key: string, payload: QuickLookPayload): void {
  cache.delete(key)
  cache.set(key, { key, payload })
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export function clearQuickLookCache(): void {
  cache.clear()
}

export async function extractQuickLook(
  filePath: string,
  deps: ExtractQuickLookDeps = {},
): Promise<QuickLookPayload> {
  const ext = extname(filePath).slice(1).toLowerCase()
  const family = quickLookFamilyOf(ext)
  const name = basename(filePath) || filePath
  const base: QuickLookPayload = {
    ok: false,
    path: filePath,
    name,
    ext,
    family,
    sizeBytes: 0,
    mtimeMs: 0,
  }

  if (!filePath || !isAbsolute(filePath)) {
    return { ...base, error: 'missing' }
  }
  if (family === 'unsupported') {
    return { ...base, error: 'unsupported' }
  }

  let sizeBytes: number
  let mtimeMs: number
  try {
    const st = await (deps.stat ?? stat)(filePath)
    if (!st.isFile()) return { ...base, error: 'missing' }
    sizeBytes = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return { ...base, error: 'missing' }
  }

  const sized: QuickLookPayload = { ...base, sizeBytes, mtimeMs }
  const maxBytes = family === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
  if (sizeBytes > maxBytes) {
    return {
      ...sized,
      error: 'unreadable',
      errorMessage: 'File is too large for Quick Look preview',
    }
  }

  const useCache = !deps.stat && !deps.readFile && !deps.parse
  const key = useCache ? cacheKeyOf(filePath, sizeBytes, mtimeMs) : ''
  if (useCache) {
    const hit = cache.get(key)
    if (hit) return hit.payload
  }

  const readBytes = deps.readFile ?? ((p: string) => readFile(p))

  // Image files: return data URL directly
  if (family === 'image') {
    try {
      const bytes = await readBytes(filePath)
      const mime = sniffImageMime(bytes) ?? IMAGE_MIMES[ext] ?? 'image/png'
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
      const result: QuickLookPayload = {
        ...sized,
        ok: true,
        thumbnailDataUrl: dataUrl,
      }
      if (useCache) rememberPayload(key, result)
      return result
    } catch {
      return { ...sized, error: 'unreadable' }
    }
  }

  // Extract embedded thumbnail in parallel with text extraction
  const thumbnailPromise = (async (): Promise<string | undefined> => {
    if (
      family !== 'hwp' &&
      family !== 'docx' &&
      family !== 'pptx' &&
      family !== 'xlsx' &&
      family !== 'xmind'
    ) {
      return undefined
    }
    try {
      const bytes = await readBytes(filePath)
      return await extractEmbeddedThumbnail(ext, bytes)
    } catch {
      return undefined
    }
  })()

  let parsed: ParsedFile
  try {
    parsed = await (deps.parse ?? parseFileToText)(filePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ...sized, error: classifyParseError(msg), errorMessage: msg }
  }

  const thumbnailDataUrl = await thumbnailPromise

  if (!parsed.ok) {
    // If HWP/Office has an embedded preview image even when text extraction failed, show the image
    if (thumbnailDataUrl && classifyParseError(parsed.error) !== 'encrypted') {
      const partial: QuickLookPayload = {
        ...sized,
        ok: true,
        thumbnailDataUrl,
      }
      if (useCache) rememberPayload(key, partial)
      return partial
    }
    return {
      ...sized,
      error: classifyParseError(parsed.error),
      errorMessage: parsed.error,
    }
  }

  const rawText = parsed.text ?? ''
  const plainTruncated = rawText.length > MAX_PLAIN_CHARS
  const plainText = plainTruncated ? rawText.slice(0, MAX_PLAIN_CHARS) : rawText

  let result: QuickLookPayload = {
    ...sized,
    ok: true,
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
  }

  if (family === 'xlsx') {
    const { sheets, truncated } = parseSheetsFromText(rawText, ext, name)
    result = { ...result, sheets, truncated: truncated || plainTruncated }
  } else if (family === 'pptx') {
    const { slides, truncated } = parseSlidesFromText(rawText)
    result = { ...result, slides, truncated: truncated || plainTruncated }
  } else if (family === 'xmind') {
    const { mindmap, truncated } = parseMindmapFromText(rawText)
    result = { ...result, mindmap, truncated: truncated || plainTruncated }
  } else if (family === 'docx' || family === 'hwp' || family === 'md' || family === 'pdf') {
    const { docBlocks, truncated } = parseDocBlocksFromText(plainText)
    result = {
      ...result,
      docBlocks,
      plainText,
      truncated: truncated || plainTruncated,
    }
  } else {
    result = {
      ...result,
      plainText,
      truncated: plainTruncated,
    }
  }

  if (useCache) rememberPayload(key, result)
  return result
}
