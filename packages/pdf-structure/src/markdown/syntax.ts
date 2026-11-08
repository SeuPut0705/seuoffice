/**
 * Markdown syntax rules of our Markdown editor, mirrored here so the writer
 * produces text the editor reads the way it was meant. Kept in step with
 * apps/markdown/src/renderer/editor/mathSyntax.ts (inline formula tokenizer)
 * and markdownEscape.ts (text escaping); tests compare the formula rules
 * with the editor's own functions.
 */

// ── formulas (mathSyntax.ts) ──

const INLINE_MATH_RE = /\$(?!\s)([^$\n]*[^\\\s$])\$(?![$\d])/g
/** `<amount> <words> <amount>` between dollars is currency prose, not a formula */
export const CURRENCY_SPAN_RE = /^\d[\d.,]*(?:\s+[\p{L}\p{N}]+)*\s+\d[\d.,]*$/u
const UNESCAPED_DOLLAR_RE = /(?<!\\)(?:\\\\)*\$/

function strictInlineMathStart(src: string): number {
  const match = UNESCAPED_DOLLAR_RE.exec(src)
  return match ? match.index + match[0].length - 1 : -1
}

export function matchInlineMath(src: string): { raw: string; latex: string } | undefined {
  INLINE_MATH_RE.lastIndex = 0
  const match = INLINE_MATH_RE.exec(src)
  if (!match || match.index !== 0 || CURRENCY_SPAN_RE.test(match[1]!)) return undefined
  return { raw: match[0], latex: match[1]!.trim() }
}

/** true when the text, written as-is, would tokenize a `$...$` or `$$...$$` span */
export function containsMathSyntax(text: string): boolean {
  for (let i = strictInlineMathStart(text); i >= 0;) {
    const rest = text.slice(i)
    if (rest.startsWith('$$') || matchInlineMath(rest)) return true
    const next = strictInlineMathStart(text.slice(i + 1))
    i = next < 0 ? -1 : i + 1 + next
  }
  return false
}

// ── text escaping (markdownEscape.ts) ──

const LINK_LIKE_RE = /\]\(/
const TASK_MARKER_RE = /^\s*\[[ xX]\]/
const REF_DEFINITION_RE = /^\s*\[[^\]]+\]:/
/** footnote label syntax (`[^1]`) in plain text */
const FOOTNOTE_LIKE_RE = /\[\^/

/**
 * Brackets are inert in CommonMark unless the text would become a link, a
 * task box, a reference definition or a footnote marker. Decided per block
 * (or table cell) over its whole plain text, since such a pattern can span
 * runs with different marks.
 */
export function bracketsAreRisky(plain: string): boolean {
  if (!plain.includes('[') && !plain.includes(']')) return false
  return (
    LINK_LIKE_RE.test(plain) ||
    TASK_MARKER_RE.test(plain) ||
    REF_DEFINITION_RE.test(plain) ||
    FOOTNOTE_LIKE_RE.test(plain)
  )
}

export interface EscapeOptions {
  /** escape every `[` / `]` (see bracketsAreRisky) */
  brackets: boolean
  /** escape every `$` (the block holds a formula or text that would read as one) */
  dollars: boolean
  /** inside a pipe table cell */
  table: boolean
}

/**
 * Escape plain text for Markdown. `<` always becomes an entity (the editor
 * drops raw inline HTML); `&` only where it would start an entity; `>` and
 * other line-start syntax are handled per line by escapeLineStart.
 */
export function escapeText(text: string, options: EscapeOptions): string {
  let out = text.replace(/([\\`*_~])/g, '\\$1')
  if (options.brackets) out = out.replace(/([[\]])/g, '\\$1')
  if (options.dollars) out = out.replace(/\$/g, '\\$')
  out = out
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    // a literal no-break space is trimmed at cell and line edges when read back; the entity is not
    .replace(/\u00a0/g, '&nbsp;')
  return options.table ? out.replace(/\|/g, '\\|') : out
}

/** block starts CommonMark would read from a paragraph line */
const BLOCK_START_RE =
  /^( {0,3})(?:(\d{1,9})(?=[.)](?:\s|$))|(#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|-{3,}\s*$|=+\s*$))/
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * Escape what would turn line `index` of a paragraph into another block: a
 * heading, list marker, quote, thematic break, setext underline or table
 * delimiter row. Mirrors escapeBlockStarts in markdownEscape.ts.
 */
export function escapeLineStart(line: string, index: number): string {
  if (index > 0 && line.includes('|') && TABLE_DELIMITER_RE.test(line)) {
    return line.replace(/^(\s*)/, '$1\\')
  }
  if (index > 0 && /^ {0,3}-+\s*$/.test(line)) return line.replace(/^(\s*)/, '$1\\')
  const m = BLOCK_START_RE.exec(line)
  if (!m) return line
  if (m[2]) return `${m[1]}${m[2]}\\${line.slice(m[0].length)}`
  if (m[3]!.startsWith('=') && index === 0) return line
  return `${m[1]}\\${line.slice(m[1]!.length)}`
}

/** CommonMark code span whose fence is longer than any backtick run inside */
export function fenceCodeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(1, ...runs.map((run) => run.length + 1)))
  const pad = /^`|`$/.test(text) || (/^ .* $/s.test(text) && text.trim() !== '') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** fenced code block whose fence is longer than any backtick run inside */
export function fenceCodeBlock(text: string, info: string): string {
  const runs = text.match(/`{3,}/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `${fence}${info}\n${text}\n${fence}`
}
