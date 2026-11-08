/**
 * An HTML table from an AI answer → the shared table shape (`tableFromSpans`).
 * Only rows, cells and their colspan / rowspan are read; every other tag is
 * dropped and the cell text is kept as text.
 */
import { tableFromSpans, type SpanCellInput } from '../tree/tables'
import type { InlineRun, TreeTable } from '../tree/types'
import { parseAiInline } from './inline'

/** largest colspan / rowspan taken from an answer (a bigger one is capped) */
export const AI_READ_MAX_SPAN = 64

const ROW = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table\s*>|$)/gi
const CELL = /<(td|th)\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr\s*>|$)/gi

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

function spanAttr(attrs: string, name: 'colspan' | 'rowspan'): number | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d{1,9})`, 'i').exec(attrs)
  return m ? Math.min(Number(m[1]), AI_READ_MAX_SPAN) : undefined
}

/** cell HTML → paragraphs (split at <br> and paragraph tags) */
function cellParagraphs(html: string): InlineRun[][] {
  const withBreaks = html
    .replace(/<\/t[dh]\s*>[\s\S]*$/i, '')
    .replace(/<br\s*\/?>|<\/?p\b[^>]*>|<\/?div\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
  return withBreaks
    .split('\n')
    .map((line) => parseAiInline(decodeEntities(line)))
    .filter((runs) => runs.length > 0)
}

/** the table, or null when it has no cell */
export function parseHtmlTable(html: string): TreeTable | null {
  const rows: SpanCellInput[][] = []
  for (const row of html.matchAll(ROW)) {
    const cells: SpanCellInput[] = []
    for (const cell of row[1]!.matchAll(CELL)) {
      const input: SpanCellInput = { paragraphs: cellParagraphs(cell[3]!) }
      const colSpan = spanAttr(cell[2]!, 'colspan')
      const rowSpan = spanAttr(cell[2]!, 'rowspan')
      if (colSpan !== undefined) input.colSpan = colSpan
      if (rowSpan !== undefined) input.rowSpan = rowSpan
      if (cell[1]!.toLowerCase() === 'th') input.header = true
      cells.push(input)
    }
    rows.push(cells)
  }
  if (!rows.some((r) => r.length > 0)) return null
  return tableFromSpans(rows)
}
