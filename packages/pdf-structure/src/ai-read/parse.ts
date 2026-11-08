/**
 * Parsing and checking one AI page-reading answer (spec §7). The answer is
 * data: it is read into blocks and nothing in it is followed. A malformed
 * answer (no page tags, unclosed formula or table, a broken footnote
 * section, nothing but repetition loops) is reported as problems so the
 * caller can ask once more.
 */
import { isCaptionText } from '../tree/captions'
import type { InlineRun } from '../tree/types'
import {
  AI_READ_PAYLOAD_VERSION,
  materializeReading,
  type AiContentBlock,
  type AiContentCaption,
  type AiContentFootnote,
  type AiPageReading,
  type AiReadPagePayload,
} from './content'
import { parseAiInline } from './inline'
import { AI_READ_CLOSE_TAG, AI_READ_EMPTY_PAGE, AI_READ_OPEN_TAG } from './instruction'
import { filterRepetitions, findRepetitionLoop, type AiReadRepetitionTuning } from './repetition'
import { parseHtmlTable } from './table'

export type AiReadProblem =
  | 'missing-page-tags'
  | 'empty'
  | 'unclosed-math'
  | 'unclosed-table'
  | 'bad-table'
  | 'bad-footnotes'
  | 'repetition-only'

export interface ParseAiPageOptions {
  /** 1-based original page number */
  page: number
  pageFingerprint: string
  /** this answer is the re-ask (recorded on the reading) */
  reasked?: boolean
  repetition?: Partial<AiReadRepetitionTuning>
}

export type ParseAiPageResult =
  { ok: true; reading: AiPageReading } | { ok: false; problems: AiReadProblem[] }

const FOOTNOTES_RE = /^\s*={2,}\s*FOOTNOTES\s*={2,}\s*$/i
const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const FIGURE_RE = /^\[FIGURE(?:\s*:\s*(.*?))?\s*\]$/i
const LIST_RE = /^([ \t]*)([-*+•]|\d{1,4}[.)])\s+(.*)$/
/** a thematic break ("---", "***"): not page content */
const RULE_RE = /^(?:[-*_]\s*){3,}$/
const NOTE_RE = /^\[\^([^\]\s]{1,16})\]:\s*(.*)$/
const NO_SPACE_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u
const NO_SPACE_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
/** captions are short (same limit as the tree's caption binding) */
const CAPTION_MAX_CHARS = 300

/** join the lines of one paragraph: a space, none between CJK characters */
function joinLines(lines: readonly string[]): string {
  let out = ''
  for (const line of lines) {
    const l = line.trim()
    if (l === '') continue
    if (out === '' || (NO_SPACE_END.test(out) && NO_SPACE_START.test(l))) out += l
    else out += ` ${l}`
  }
  return out
}

const indentOf = (s: string): number => s.replace(/\t/g, '  ').length

interface BodyResult {
  blocks: AiContentBlock[]
  problems: Set<AiReadProblem>
}

function parseBody(input: readonly string[]): BodyResult {
  const lines = [...input]
  const blocks: AiContentBlock[] = []
  const problems = new Set<AiReadProblem>()
  let para: string[] = []
  let item: { ordered: boolean; level: number; marker?: string; lines: string[] } | null = null

  const flush = () => {
    if (para.length > 0) {
      const runs = parseAiInline(joinLines(para))
      if (runs.length > 0) blocks.push({ kind: 'paragraph', runs })
      para = []
    }
    if (item) {
      const runs = parseAiInline(joinLines(item.lines))
      blocks.push({
        kind: 'listItem',
        ordered: item.ordered,
        level: item.level,
        ...(item.marker !== undefined ? { marker: item.marker } : {}),
        runs,
      })
      item = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    if (line.toUpperCase() === AI_READ_EMPTY_PAGE) continue
    if (RULE_RE.test(line)) {
      flush()
      continue
    }

    if (line.startsWith('$$')) {
      const rest = line.slice(2)
      const end = rest.indexOf('$$')
      if (end !== -1 && rest.slice(end + 2).trim() !== '') {
        // a formula that text follows on the same line is inline
        if (item) item.lines.push(line)
        else para.push(line)
        continue
      }
      flush()
      let latex: string
      if (end !== -1) {
        latex = rest.slice(0, end)
      } else {
        const parts = [rest]
        let closed = false
        for (i++; i < lines.length; i++) {
          const l = lines[i]!
          const k = l.indexOf('$$')
          if (k === -1) {
            parts.push(l)
            continue
          }
          parts.push(l.slice(0, k))
          const after = l.slice(k + 2).trim()
          if (after !== '') lines.splice(i + 1, 0, after)
          closed = true
          break
        }
        if (!closed) {
          problems.add('unclosed-math')
          break
        }
        latex = parts.join('\n')
      }
      latex = latex.trim()
      if (latex !== '') blocks.push({ kind: 'math', latex })
      continue
    }

    if (/^<table\b/i.test(line)) {
      flush()
      const parts: string[] = []
      let closed = false
      for (; i < lines.length; i++) {
        const l = lines[i]!
        const m = /<\/table\s*>/i.exec(l)
        if (!m) {
          parts.push(l)
          continue
        }
        parts.push(l.slice(0, m.index + m[0].length))
        const after = l.slice(m.index + m[0].length).trim()
        if (after !== '') lines.splice(i + 1, 0, after)
        closed = true
        break
      }
      if (!closed) {
        problems.add('unclosed-table')
        break
      }
      const table = parseHtmlTable(parts.join('\n'))
      if (table) blocks.push({ kind: 'table', table })
      else problems.add('bad-table')
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flush()
      const runs = parseAiInline(heading[2]!)
      if (runs.length > 0) {
        blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, runs })
      }
      continue
    }

    const figure = FIGURE_RE.exec(line)
    if (figure) {
      flush()
      const runs = parseAiInline(figure[1] ?? '')
      blocks.push(
        runs.length > 0
          ? { kind: 'figure', caption: { position: 'below', runs } }
          : { kind: 'figure' },
      )
      continue
    }

    const list = LIST_RE.exec(raw)
    if (list) {
      flush()
      const ordered = /\d/.test(list[2]!)
      item = {
        ordered,
        level: Math.floor(indentOf(list[1]!) / 2),
        ...(ordered ? { marker: list[2]! } : {}),
        lines: [list[3]!],
      }
      continue
    }

    if (item && /^\s/.test(raw)) {
      item.lines.push(line)
      continue
    }
    if (item) flush()
    para.push(line)
  }
  flush()
  return { blocks: bindCaptions(blocks), problems }
}

const captionRuns = (b: AiContentBlock | undefined): InlineRun[] | null => {
  if (b?.kind !== 'paragraph') return null
  const text = b.runs.map((r) => (r.kind === 'text' ? r.text : '')).join('')
  return text.length <= CAPTION_MAX_CHARS && isCaptionText(text) ? b.runs : null
}

/** a caption paragraph right above (or else below) a table or figure belongs to it */
function bindCaptions(blocks: AiContentBlock[]): AiContentBlock[] {
  const out: AiContentBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if ((b.kind !== 'table' && b.kind !== 'figure') || b.caption) {
      out.push(b)
      continue
    }
    const above = captionRuns(out[out.length - 1])
    let caption: AiContentCaption | null = null
    if (above) {
      out.pop()
      caption = { position: 'above', runs: above }
    } else {
      const below = captionRuns(blocks[i + 1])
      if (below) {
        i++
        caption = { position: 'below', runs: below }
      }
    }
    out.push(caption ? { ...b, caption } : b)
  }
  return out
}

function parseFootnotes(lines: readonly string[]): AiContentFootnote[] | null {
  const notes: { label: string; paragraphs: string[][] }[] = []
  let current: { label: string; paragraphs: string[][] } | null = null
  let gap = false
  for (const raw of lines) {
    const line = raw.trim()
    const m = NOTE_RE.exec(line)
    if (m) {
      const existing = notes.find((n) => n.label === m[1])
      current = existing ?? { label: m[1]!, paragraphs: [] }
      if (!existing) notes.push(current)
      current.paragraphs.push(m[2] ? [m[2]] : [])
      gap = false
      continue
    }
    if (line === '') {
      gap = true
      continue
    }
    if (!current) return null
    if (gap || current.paragraphs.length === 0) current.paragraphs.push([line])
    else current.paragraphs[current.paragraphs.length - 1]!.push(line)
    gap = false
  }
  return notes.map((n) => ({
    label: n.label,
    paragraphs: n.paragraphs.map((p) => parseAiInline(joinLines(p))).filter((r) => r.length > 0),
  }))
}

/** the answer's page-free content (what the store keeps), or its problems */
export function parseAiPageContent(
  answer: string,
  options: { reasked?: boolean; repetition?: Partial<AiReadRepetitionTuning> } = {},
): { ok: true; payload: AiReadPagePayload } | { ok: false; problems: AiReadProblem[] } {
  const lower = answer.toLowerCase()
  const open = lower.indexOf(AI_READ_OPEN_TAG)
  const close = lower.lastIndexOf(AI_READ_CLOSE_TAG)
  if (open === -1 || close < open + AI_READ_OPEN_TAG.length) {
    return { ok: false, problems: ['missing-page-tags'] }
  }
  const body = answer.slice(open + AI_READ_OPEN_TAG.length, close).replace(/\r\n?/g, '\n')
  if (body.trim() === '') return { ok: false, problems: ['empty'] }

  const lines = body.split('\n')
  const sections = lines.flatMap((l, k) => (FOOTNOTES_RE.test(l) ? [k] : []))
  const problems = new Set<AiReadProblem>()
  if (sections.length > 1) problems.add('bad-footnotes')
  const split = sections[0] ?? lines.length
  const parsed = parseBody(lines.slice(0, split))
  for (const p of parsed.problems) problems.add(p)
  const notes = sections.length === 1 ? parseFootnotes(lines.slice(split + 1)) : []
  if (notes === null) problems.add('bad-footnotes')
  if (problems.size > 0) return { ok: false, problems: [...problems] }

  const filtered = filterRepetitions(parsed.blocks, options.repetition)
  let dropped = filtered.dropped
  const footnotes = (notes ?? []).map((n) => {
    const paragraphs = n.paragraphs.filter(
      (p) =>
        !findRepetitionLoop(
          p.map((r) => (r.kind === 'text' ? r.text : '')).join(''),
          options.repetition,
        ),
    )
    dropped += n.paragraphs.length - paragraphs.length
    return { label: n.label, paragraphs }
  })
  if (filtered.blocks.length === 0 && filtered.dropped > 0) {
    return { ok: false, problems: ['repetition-only'] }
  }
  return {
    ok: true,
    payload: {
      version: AI_READ_PAYLOAD_VERSION,
      blocks: filtered.blocks,
      footnotes,
      droppedRepetitions: dropped,
      reasked: options.reasked === true,
    },
  }
}

/** one answer → the page's tree blocks, or the problems that call for a re-ask */
export function parseAiPageResponse(answer: string, o: ParseAiPageOptions): ParseAiPageResult {
  const content = parseAiPageContent(answer, o)
  if (!content.ok) return content
  return { ok: true, reading: materializeReading(content.payload, o.page, o.pageFingerprint) }
}
