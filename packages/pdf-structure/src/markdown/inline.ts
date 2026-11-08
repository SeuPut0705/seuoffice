/**
 * Inline runs → Markdown text: bold / italic / link nesting, footnote
 * markers, `$…$` formulas and hard breaks, escaped for our Markdown editor
 * (see ./syntax.ts) and for CommonMark emphasis rules.
 */
import type { InlineRun } from '../tree/types'
import {
  bracketsAreRisky,
  containsMathSyntax,
  CURRENCY_SPAN_RE,
  escapeText,
  fenceCodeSpan,
} from './syntax'

/** block: paragraph lines with hard breaks; heading: one line; table: one cell */
export type InlineMode = 'block' | 'heading' | 'table'

export interface InlineHost {
  /** the note's number (assigned on first reference), or undefined when the tree lacks it */
  footnoteNumber(id: string): number | undefined
  onMissingFootnote(id: string): void
  /** a formula `$…$` cannot hold, written as code instead */
  onFormulaAsCode(latex: string): void
}

export interface InlineOptions {
  /** captions: the whole text is italic */
  italic?: boolean
}

interface Marks {
  bold: boolean
  italic: boolean
  href?: string
}

type Seg =
  | { kind: 'text'; text: string; marks: Marks }
  | { kind: 'atom'; md: string; role: 'footnote' | 'math' | 'marker'; latex?: string; marks: Marks }
  | { kind: 'break'; marks: Marks }

type Mark = 'a' | 'b' | 'i'

const NO_MARKS: Marks = { bold: false, italic: false }
const WORD = /[^\s\p{P}\p{S}]/u
const SAFE_SCHEME = /^(?:https?|mailto|ftp|tel):/i

/** web and mail targets only: in-document `#page=N` and script URLs become plain text */
export function linkTarget(href: string | undefined): string | undefined {
  const h = href?.trim()
  if (!h || !SAFE_SCHEME.test(h)) return undefined
  return h.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `$latex$`, or null when the strict tokenizer could not read it back */
export function inlineFormula(latex: string): string | null {
  let l = latex.replace(/\s*\n\s*/g, ' ').trim()
  if (!l || l.includes('$')) return null
  // the closing `$` may not follow a backslash; `{}` is an empty TeX group
  if (l.endsWith('\\')) l += '{}'
  // `$5 and 10$` reads as currency prose
  if (CURRENCY_SPAN_RE.test(l)) l = `{}${l}`
  return `$${l}$`
}

const has = (marks: Marks, mark: Mark): boolean =>
  mark === 'a' ? marks.href !== undefined : mark === 'b' ? marks.bold : marks.italic

const sameMarks = (x: Marks, y: Marks): boolean =>
  x.bold === y.bold && x.italic === y.italic && x.href === y.href

const intersect = (x: Marks | undefined, y: Marks | undefined): Marks =>
  x && y
    ? {
        bold: x.bold && y.bold,
        italic: x.italic && y.italic,
        ...(x.href !== undefined && x.href === y.href ? { href: x.href } : {}),
      }
    : NO_MARKS

const isSolid = (s: Seg): boolean => s.kind === 'text' && s.text.trim() !== ''

function toSegments(
  runs: InlineRun[],
  mode: InlineMode,
  host: InlineHost,
  escapeMarker: (text: string) => string,
): Seg[] {
  const segs: Seg[] = []
  for (const run of runs) {
    const last = segs[segs.length - 1]
    if (run.kind === 'text') {
      const text = run.text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')
      if (!text) continue
      const href = linkTarget(run.href)
      const marks: Marks = {
        bold: run.bold === true,
        italic: run.italic === true,
        ...(href ? { href } : {}),
      }
      if (last?.kind === 'text' && sameMarks(last.marks, marks)) last.text += text
      else segs.push({ kind: 'text', text, marks })
    } else if (run.kind === 'lineBreak') {
      if (mode === 'heading') segs.push({ kind: 'text', text: ' ', marks: NO_MARKS })
      else segs.push({ kind: 'break', marks: NO_MARKS })
    } else if (run.kind === 'math') {
      // `$a$$b$` would not tokenize: adjacent formulas are one formula
      if (last?.kind === 'atom' && last.role === 'math') last.latex += ` ${run.latex}`
      else segs.push({ kind: 'atom', role: 'math', md: '', latex: run.latex, marks: NO_MARKS })
    } else {
      const n = host.footnoteNumber(run.id)
      if (n !== undefined) {
        segs.push({ kind: 'atom', role: 'footnote', md: `[^${n}]`, marks: NO_MARKS })
      } else {
        host.onMissingFootnote(run.id)
        if (run.marker) {
          segs.push({ kind: 'atom', role: 'marker', md: escapeMarker(run.marker), marks: NO_MARKS })
        }
      }
    }
  }
  // formulas are rendered once merged
  for (const s of segs) {
    if (s.kind !== 'atom' || s.role !== 'math') continue
    const latex = s.latex ?? ''
    const formula = inlineFormula(latex)
    if (formula === null) host.onFormulaAsCode(latex)
    s.md = formula ?? fenceCodeSpan(latex.replace(/\s*\n\s*/g, ' ').trim())
    if (mode === 'table') s.md = s.md.replace(/\|/g, '\\|')
  }
  return segs
}

/** whitespace, breaks and atoms take the marks both neighbours share */
function settleMarks(segs: Seg[], italic: boolean): void {
  const solid = segs.map(isSolid)
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!
    if (solid[k]) continue
    let prev: Marks | undefined
    for (let j = k - 1; j >= 0 && !prev; j--) if (solid[j]) prev = segs[j]!.marks
    let next: Marks | undefined
    for (let j = k + 1; j < segs.length && !next; j++) if (solid[j]) next = segs[j]!.marks
    const marks = intersect(prev, next)
    // a footnote marker inside link text would be read as a nested link
    if (s.kind === 'atom' && s.role === 'footnote') delete marks.href
    s.marks = marks
  }
  if (italic) for (const s of segs) s.marks = { ...s.marks, italic: true }
}

/** no edge whitespace, no breaks at the ends, one break at most in a row */
function trimSegments(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (s.kind === 'break' && (out.length === 0 || out[out.length - 1]!.kind === 'break')) continue
    out.push(s)
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'break') out.pop()
  for (let k = 0; k < out.length; k++) {
    const s = out[k]!
    if (s.kind !== 'text') continue
    if (k === 0 || out[k - 1]!.kind === 'break') s.text = s.text.trimStart()
    if (k === out.length - 1 || out[k + 1]!.kind === 'break') s.text = s.text.trimEnd()
  }
  return out.filter((s) => s.kind !== 'text' || s.text !== '')
}

const emphasisChanges = (from: Marks, to: Marks): boolean =>
  (from.bold && !to.bold) || (from.italic && !to.italic)

/**
 * CommonMark only closes `**` after punctuation when whitespace or
 * punctuation follows, and only opens it before punctuation after the same.
 * Where a word touches the delimiter instead, the punctuation moves outside
 * the emphasis (`**Note:**text` → `**Note**:text`).
 */
function peelPunctuation(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    const prev = out[out.length - 1]
    if (s.kind !== 'text' || prev?.kind !== 'text' || /\s$/.test(prev.text) || /^\s/.test(s.text)) {
      out.push(s)
      continue
    }
    const shared = intersect(prev.marks, s.marks)
    const opens = !sameMarks(shared, s.marks)
    const closes = !sameMarks(shared, prev.marks)
    const tail = /[\p{P}\p{S}]+$/u.exec(prev.text)
    if (emphasisChanges(prev.marks, s.marks) && !opens && tail && WORD.test(s.text[0]!)) {
      prev.text = prev.text.slice(0, tail.index)
      if (prev.text === '') out.pop()
      out.push({ kind: 'text', text: tail[0], marks: shared }, s)
      continue
    }
    const head = /^[\p{P}\p{S}]+/u.exec(s.text)
    if (emphasisChanges(s.marks, prev.marks) && !closes && head && WORD.test(prev.text.slice(-1))) {
      out.push({ kind: 'text', text: head[0], marks: shared })
      s.text = s.text.slice(head[0].length)
      if (s.text !== '') out.push(s)
      continue
    }
    out.push(s)
  }
  // a peeled piece may now sit next to a neighbour with the same marks
  const merged: Seg[] = []
  for (const s of out) {
    const last = merged[merged.length - 1]
    if (s.kind === 'text' && last?.kind === 'text' && sameMarks(last.marks, s.marks)) {
      last.text += s.text
    } else merged.push(s)
  }
  return merged
}

const OPENER: Record<Mark, string> = { a: '[', b: '**', i: '*' }

/** render runs to Markdown; lines are separated by `  \n` in block mode */
export function renderInline(
  runs: InlineRun[],
  mode: InlineMode,
  host: InlineHost,
  options: InlineOptions = {},
): string {
  const plain = runs.map((r) => (r.kind === 'text' ? r.text : r.kind === 'lineBreak' ? '\n' : ''))
  const plainText = plain.join('')
  const escape = {
    brackets: bracketsAreRisky(plainText),
    dollars: runs.some((r) => r.kind === 'math') || containsMathSyntax(plainText),
    table: mode === 'table',
  }
  const esc = (text: string): string => escapeText(text, escape)

  let segs = toSegments(runs, mode, host, esc)
  settleMarks(segs, options.italic === true)
  segs = peelPunctuation(trimSegments(segs))

  let out = ''
  const stack: { mark: Mark; href?: string }[] = []
  let pendingSpace = ''
  let last: Seg | undefined
  /** the previous atom was a footnote at the start of a line */
  let footnoteAtLineStart = false

  const lastsFor = (from: number, mark: Mark, href?: string): number => {
    let n = 0
    for (let k = from; k < segs.length; k++) {
      const m = segs[k]!.marks
      if (!has(m, mark) || (mark === 'a' && m.href !== href)) break
      n++
    }
    return n
  }

  /** a `!` or `]` the text ended with would join a following `[` */
  const guardBracketOpen = (): void => {
    if (last?.kind !== 'text') return
    if (/(?<!\\)(?:\\\\)*[!\]]$/.test(out)) out = `${out.slice(0, -1)}\\${out.slice(-1)}`
  }

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!
    const target = s.marks
    // close from the first stacked mark the segment no longer carries
    let keep = 0
    while (
      keep < stack.length &&
      has(target, stack[keep]!.mark) &&
      (stack[keep]!.mark !== 'a' || stack[keep]!.href === target.href)
    ) {
      keep++
    }
    let between = ''
    for (const open of stack.splice(keep).reverse()) {
      between += open.mark === 'a' ? `](${open.href})` : OPENER[open.mark]
    }
    const opening = (['a', 'b', 'i'] as Mark[])
      .filter((mark) => has(target, mark) && !stack.some((o) => o.mark === mark))
      .map((mark) => ({ mark, n: lastsFor(k, mark, target.href) }))
      .sort((x, y) => y.n - x.n)

    let lead = ''
    let core: string
    let trail = ''
    if (s.kind === 'text') {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!
      lead = m[1]!
      core = esc(m[2]!)
      trail = m[3]!
    } else if (s.kind === 'break') {
      core = mode === 'table' ? '<br>' : '  \n'
    } else {
      core = s.md
    }

    between += esc(pendingSpace + lead)
    if (between === '' && opening.length === 0 && last) {
      // what directly follows an atom can change how it reads
      if (last.kind === 'atom' && last.role === 'footnote' && s.kind === 'text') {
        const re = footnoteAtLineStart ? /^[([:]/ : /^[([]/
        if (re.test(core)) core = `\\${core}`
      }
      if (last.kind === 'atom' && last.role === 'math' && s.kind === 'text' && /^\d/.test(core)) {
        core = `&#${core.charCodeAt(0)};${core.slice(1)}`
      }
    }
    const startsWithBracket =
      opening.length > 0 ? opening[0]!.mark === 'a' : s.kind === 'atom' && s.role === 'footnote'
    if (between === '' && startsWithBracket) guardBracketOpen()
    out += between
    for (const { mark } of opening) {
      out += OPENER[mark]
      stack.push(mark === 'a' ? { mark, href: target.href! } : { mark })
    }
    if (s.kind === 'atom' && s.role === 'footnote') {
      footnoteAtLineStart = out === '' || out.endsWith('\n')
    }
    out += core
    pendingSpace = trail
    last = s
  }
  for (const open of stack.reverse())
    out += open.mark === 'a' ? `](${open.href})` : OPENER[open.mark]
  return out
}
