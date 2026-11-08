/**
 * Inline text of an AI answer → runs: **bold**, *italic*, $…$ / $$…$$
 * formulas, [^n] footnote markers (id = printed label until the reading is
 * placed on a page), backslash escapes and <br>. Anything else is literal
 * text: the answer is data, nothing in it is acted on.
 */
import type { InlineRun, TextRun } from '../tree/types'

/** CommonMark escapable characters */
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
const FOOTNOTE_MARK = /^\[\^([^\]\s]{1,16})\]/
const BR = /^<br\s*\/?>/i
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

/** index of the `$` closing an inline formula opened at `open`, or -1 */
function closingDollar(s: string, open: number): number {
  if (isSpace(s[open + 1]) || s[open + 1] === '$') return -1
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === '\\') {
      j++
      continue
    }
    if (s[j] === '$') {
      if (isSpace(s[j - 1]) || isDigit(s[j + 1])) return -1
      return j
    }
  }
  return -1
}

/** a `**` or `*` delimiter at `i` that has a matching closer later in the text */
function opens(s: string, i: number, delim: string): boolean {
  const after = s[i + delim.length]
  if (isSpace(after) || after === '*') return false
  for (let j = s.indexOf(delim, i + delim.length); j !== -1; j = s.indexOf(delim, j + 1)) {
    if (delim === '*' && (s[j + 1] === '*' || s[j - 1] === '*')) continue
    if (!isSpace(s[j - 1])) return true
  }
  return false
}

export function parseAiInline(input: string): InlineRun[] {
  const s = input
  const runs: InlineRun[] = []
  let buf = ''
  let bold = false
  let italic = false

  const flush = () => {
    if (buf === '') return
    const run: TextRun = { kind: 'text', text: buf.replace(/\s+/g, ' ') }
    if (bold) run.bold = true
    if (italic) run.italic = true
    const last = runs[runs.length - 1]
    if (last?.kind === 'text' && last.bold === run.bold && last.italic === run.italic) {
      last.text = (last.text + run.text).replace(/\s+/g, ' ')
    } else {
      runs.push(run)
    }
    buf = ''
  }
  const push = (run: InlineRun) => {
    flush()
    runs.push(run)
  }

  for (let i = 0; i < s.length;) {
    const c = s[i]!
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1]!)) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (c === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2)
      const latex = end === -1 ? '' : s.slice(i + 2, end).trim()
      if (latex !== '') {
        push({ kind: 'math', latex })
        i = end + 2
      } else {
        buf += '$$'
        i += 2
      }
      continue
    }
    if (c === '$') {
      const end = closingDollar(s, i)
      if (end !== -1) {
        push({ kind: 'math', latex: s.slice(i + 1, end) })
        i = end + 1
      } else {
        buf += '$'
        i++
      }
      continue
    }
    if (c === '[') {
      const m = FOOTNOTE_MARK.exec(s.slice(i, i + 20))
      if (m) {
        push({ kind: 'footnoteRef', id: m[1]! })
        i += m[0].length
        continue
      }
    }
    if (c === '<') {
      const m = BR.exec(s.slice(i, i + 8))
      if (m) {
        push({ kind: 'lineBreak' })
        i += m[0].length
        continue
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      if (bold ? !isSpace(s[i - 1]) : opens(s, i, '**')) {
        flush()
        bold = !bold
      } else {
        buf += '**'
      }
      i += 2
      continue
    }
    if (c === '*') {
      if (italic ? !isSpace(s[i - 1]) : opens(s, i, '*')) {
        flush()
        italic = !italic
      } else {
        buf += '*'
      }
      i++
      continue
    }
    buf += c
    i++
  }
  flush()

  // trim the paragraph's outer whitespace
  const first = runs[0]
  if (first?.kind === 'text') first.text = first.text.replace(/^\s+/, '')
  const last = runs[runs.length - 1]
  if (last?.kind === 'text') last.text = last.text.replace(/\s+$/, '')
  return runs.filter((r) => r.kind !== 'text' || r.text !== '')
}
