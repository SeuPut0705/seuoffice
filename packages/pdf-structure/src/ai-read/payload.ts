/**
 * The store payload of an AI-read page (store `AiReadPayload`, version 1):
 * the page-free content, so pages with the same fingerprint share it. A
 * payload read back from disk is checked shape by shape; anything that does
 * not fit, or another version, counts as absent (the page is read again).
 */
import type { InlineRun, TableCell, TreeTable } from '../tree/types'
import {
  AI_READ_PAYLOAD_VERSION,
  materializeReading,
  type AiContentBlock,
  type AiContentCaption,
  type AiContentFootnote,
  type AiPageReading,
  type AiReadPagePayload,
} from './content'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** thrown inside the checks; turned into "absent" at the top */
class Unreadable extends Error {}
function need(ok: boolean): asserts ok {
  if (!ok) throw new Unreadable()
}

function run(v: unknown): InlineRun {
  need(isRecord(v))
  switch (v.kind) {
    case 'text': {
      need(isStr(v.text))
      const r: InlineRun = { kind: 'text', text: v.text }
      if (v.bold !== undefined) {
        need(v.bold === true)
        r.bold = true
      }
      if (v.italic !== undefined) {
        need(v.italic === true)
        r.italic = true
      }
      if (v.href !== undefined) {
        need(isStr(v.href))
        r.href = v.href
      }
      return r
    }
    case 'footnoteRef':
      need(isStr(v.id) && v.id !== '')
      return { kind: 'footnoteRef', id: v.id }
    case 'math':
      need(isStr(v.latex))
      return { kind: 'math', latex: v.latex }
    case 'lineBreak':
      return { kind: 'lineBreak' }
    default:
      throw new Unreadable()
  }
}

function runs(v: unknown): InlineRun[] {
  need(Array.isArray(v))
  return v.map(run)
}

function caption(v: unknown): AiContentCaption | undefined {
  if (v === undefined) return undefined
  need(isRecord(v) && (v.position === 'above' || v.position === 'below'))
  return { position: v.position, runs: runs(v.runs) }
}

function table(v: unknown): TreeTable {
  need(isRecord(v) && isInt(v.rowCount, 0) && isInt(v.colCount, 0) && Array.isArray(v.cells))
  const { rowCount, colCount } = v
  const cells = v.cells.map((c): TableCell => {
    need(isRecord(c) && isInt(c.row, 0, rowCount - 1) && isInt(c.col, 0, colCount - 1))
    need(isInt(c.rowSpan, 1, rowCount - c.row) && isInt(c.colSpan, 1, colCount - c.col))
    need(Array.isArray(c.paragraphs) && (c.header === undefined || c.header === true))
    const cell: TableCell = {
      row: c.row,
      col: c.col,
      rowSpan: c.rowSpan,
      colSpan: c.colSpan,
      paragraphs: c.paragraphs.map(runs),
    }
    if (c.header === true) cell.header = true
    return cell
  })
  return { rowCount, colCount, cells }
}

function block(v: unknown): AiContentBlock {
  need(isRecord(v))
  switch (v.kind) {
    case 'heading':
      need(isInt(v.level, 1, 6))
      return { kind: 'heading', level: v.level as 1 | 2 | 3 | 4 | 5 | 6, runs: runs(v.runs) }
    case 'paragraph':
      return { kind: 'paragraph', runs: runs(v.runs) }
    case 'listItem': {
      need(typeof v.ordered === 'boolean' && isInt(v.level, 0, 32))
      need(v.marker === undefined || isStr(v.marker))
      return {
        kind: 'listItem',
        ordered: v.ordered,
        level: v.level,
        ...(isStr(v.marker) ? { marker: v.marker } : {}),
        runs: runs(v.runs),
      }
    }
    case 'math':
      need(isStr(v.latex))
      return { kind: 'math', latex: v.latex }
    case 'table': {
      const cap = caption(v.caption)
      return { kind: 'table', table: table(v.table), ...(cap ? { caption: cap } : {}) }
    }
    case 'figure': {
      const cap = caption(v.caption)
      return cap ? { kind: 'figure', caption: cap } : { kind: 'figure' }
    }
    default:
      throw new Unreadable()
  }
}

function footnote(v: unknown): AiContentFootnote {
  need(isRecord(v) && isStr(v.label) && v.label !== '' && Array.isArray(v.paragraphs))
  return { label: v.label, paragraphs: v.paragraphs.map(runs) }
}

/** a stored payload checked and copied, or null when it cannot be used */
export function readAiReadPayload(raw: unknown): AiReadPagePayload | null {
  try {
    need(isRecord(raw) && raw.version === AI_READ_PAYLOAD_VERSION)
    need(Array.isArray(raw.blocks) && Array.isArray(raw.footnotes))
    need(isInt(raw.droppedRepetitions, 0) && typeof raw.reasked === 'boolean')
    return {
      version: AI_READ_PAYLOAD_VERSION,
      blocks: raw.blocks.map(block),
      footnotes: raw.footnotes.map(footnote),
      droppedRepetitions: raw.droppedRepetitions,
      reasked: raw.reasked,
    }
  } catch (err) {
    if (err instanceof Unreadable) return null
    throw err
  }
}

/** what the store keeps for this reading */
export function aiReadPayload(reading: AiPageReading): AiReadPagePayload {
  return reading.payload
}

/** a stored payload as the reading of one page (null: unreadable or another version) */
export function aiReadingFromPayload(
  raw: unknown,
  page: number,
  pageFingerprint: string,
): AiPageReading | null {
  const payload = readAiReadPayload(raw)
  return payload && materializeReading(payload, page, pageFingerprint)
}
