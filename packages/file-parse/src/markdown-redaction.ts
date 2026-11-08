import { placeholderSource } from '@genoffice/agent-core/redact-core'
import { RedactionMarkError } from './redaction-error'

/**
 * Withheld spans in a file the markdown editor saves, read as another file's
 * material.
 *
 * The editor persists a withheld span as
 * `<span class="redact-span" data-redaction="" data-label="…">words</span>`
 * (apps/markdown `editor/Redaction.ts`), and its own model view writes the span
 * out as `{{label}}`. It opens `.md`, `.markdown`, `.txt` and `.json`, and Save
 * As writes the same text under any of them, so all four are read here.
 *
 * ## What this can and cannot know
 *
 * The editor finds a span again in two ways. In running text it works on the
 * markdown parser's inline tokens (`editor/inlineTokens.ts`): an HTML token
 * matching `OPEN_RE` opens the span and the next HTML token starting `</span`
 * closes it. Inside an HTML block the browser's own parser decides, by element
 * nesting. This package has neither parser, and a raw `</span>` in the text is
 * not always that closing token: it can sit in a code span, in a comment, in a
 * link, in another tag's attribute, behind a backslash, inside emphasis that
 * ends later. Closing there would hand over the rest of the hidden words.
 *
 * So the first raw `</span` is taken as the end only when nothing can make it
 * anything else, and every other case fails the read (`RedactionMarkError`):
 *
 * 1. the opening tag is not inside a larger HTML construct, and ends where the
 *    pattern says it ends;
 * 2. the text up to the closing tag holds no raw `<` and does not end in a
 *    backslash, and the closing tag is a plain `</span>`;
 * 3. no construct opened in that text (code, emphasis, strikethrough, a link, a
 *    formula) can still be open at the closing tag: either it has no opener
 *    there, or nothing after the tag, up to the end of the paragraph, could
 *    close it.
 *
 * Under those three the result withholds at least what the editor withholds, in
 * running text and in an HTML block alike. It can withhold more (a span spelled
 * inside a code block, a span the editor ends at a paragraph break).
 *
 * A file that only *mentions* the attribute is read as written. It fails only
 * when the name is left standing inside what an HTML parser would take for the
 * start tag of a span: that is the one form the editor can read as a mark and
 * the pattern here cannot (a `>` inside a quoted attribute before the name).
 */

/** the opening tag of a persisted span, as the editor's parser patch matches it */
const OPEN_RE = /<span\b[^>]*\bdata-redaction\b[^>]*>/gi
const LABEL_RE = /\bdata-label\s*=\s*(?:"([^"]*)"|'([^']*)')/i
/** any raw closing tag; whether it is a plain one is checked where it is found */
const CLOSE_RE = /<\/span\b/gi
const PLAIN_CLOSE_RE = /<\/span[ \t\r\n]*>/iy
/** the attribute that makes a span a withheld one, wherever it is spelled */
const MARK_NAME_RE = /data-redaction/gi
const SPAN_START_RE = /<span\b/gi
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/g

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/**
 * Tag scanning is bounded: a file built to make every `<` rescan the rest of
 * the text is refused instead of being scanned in quadratic time.
 */
interface Budget {
  left: number
}

function spend(budget: Budget, chars: number): void {
  budget.left -= chars
  if (budget.left < 0)
    throw new RedactionMarkError('the markup around a withheld span is too tangled')
}

/**
 * Where a start or end tag whose name begins at `i` ends, the way an HTML
 * tokenizer delimits it: quoted attribute values may hold anything, `>` ends
 * the tag anywhere else. With `stopAtLt`, an unquoted `<` ends it too: no
 * markdown parser takes such a thing for a tag, so nothing can hide behind it.
 */
function tagEnd(src: string, i: number, stopAtLt: boolean, budget: Budget): number {
  const n = src.length
  const from = i
  try {
    while (i < n && !isSpace(src[i]) && src[i] !== '/' && src[i] !== '>') {
      if (stopAtLt && src[i] === '<') return i
      i++
    }
    for (;;) {
      while (i < n && (isSpace(src[i]) || src[i] === '/')) i++
      if (i >= n) return n
      if (src[i] === '>') return i + 1
      // an attribute name, which may be empty in front of a stray "="
      while (i < n && !isSpace(src[i]) && src[i] !== '/' && src[i] !== '>' && src[i] !== '=') {
        if (stopAtLt && src[i] === '<') return i
        i++
      }
      while (i < n && isSpace(src[i])) i++
      if (src[i] !== '=') continue
      i++
      while (i < n && isSpace(src[i])) i++
      const quote = src[i]
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1)
        if (close < 0) return n
        i = close + 1
      } else {
        while (i < n && !isSpace(src[i]) && src[i] !== '>') {
          if (stopAtLt && src[i] === '<') return i
          i++
        }
      }
    }
  } finally {
    spend(budget, i - from)
  }
}

function endAfter(src: string, terminator: string, from: number): number {
  const at = src.indexOf(terminator, from)
  return at < 0 ? src.length : at + terminator.length
}

/**
 * The furthest a construct starting at the `<` at `at` can reach: a comment, a
 * processing instruction, a declaration, a CDATA section or a tag. `at` itself
 * when the `<` starts none of them.
 */
function constructEnd(src: string, at: number, budget: Budget): number {
  if (src.startsWith('<!--', at)) return endAfter(src, '-->', at + 4)
  if (src.startsWith('<![CDATA[', at)) return endAfter(src, ']]>', at + 9)
  if (src[at + 1] === '?') return endAfter(src, '?>', at + 2)
  if (src[at + 1] === '!') return endAfter(src, '>', at + 2)
  const name = src[at + 1] === '/' ? at + 2 : at + 1
  if (!/[a-zA-Z]/.test(src[name] ?? '')) return at
  return tagEnd(src, name, true, budget)
}

/** true when `text` holds `char` outside a backslash escape */
function hasUnescaped(text: string, char: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === char) return true
  }
  return false
}

const ambiguous = () => new RedactionMarkError('where a withheld span ends cannot be told')

/**
 * Rules 2 and 3 of the module comment, for the text `from..close` of one span
 * whose closing tag ends at `closeEnd`.
 *
 * The text is walked the way the inline parser reads plain text: a backslash
 * takes the next character with it, and every character that can open a
 * construct is noted. A construct only swallows the closing tag if it is still
 * open there, which needs its closing character somewhere after the tag and
 * before the paragraph ends, so that is what each noted opener is held against.
 */
function assertClosesHere(src: string, from: number, close: number, closeEnd: number): void {
  let code = false
  let star = false
  let underscore = false
  let tilde = false
  let label = 0
  let destination = false
  let formula = false
  for (let i = from; i < close; i++) {
    const c = src[i]
    if (c === '\\') {
      // the last character before the tag: the tag itself is the escaped text
      if (i + 1 >= close) throw ambiguous()
      i++
      if (src[i] === '\n') formula = false
    } else if (c === '<') {
      // a tag, a comment, an autolink, a nested span: the editor never writes one
      // inside a span, and each of them can hold the closing tag
      throw ambiguous()
    } else if (c === '`') code = true
    else if (c === '*') star = true
    else if (c === '~') tilde = true
    // between two letters or digits an underscore opens nothing
    else if (c === '_') underscore ||= !(isAlnum(src[i - 1]) && isAlnum(src[i + 1]))
    else if (c === '[') label++
    else if (c === ']') {
      if (label > 0) label--
      if (src[i + 1] === '(') destination ||= !destinationEndsBefore(src, i + 2, close)
    }
    // a formula stays on one line
    else if (c === '$') formula = true
    else if (c === '\n') formula = false
  }
  if (!(code || star || underscore || tilde || label > 0 || destination || formula)) return

  BLANK_LINE_RE.lastIndex = closeEnd
  const blank = BLANK_LINE_RE.exec(src)
  const rest = src.slice(closeEnd, blank ? blank.index : src.length)
  const restOfLine = rest.slice(0, rest.search(/\n|$/))
  if (
    (code && rest.includes('`')) ||
    (star && hasUnescaped(rest, '*')) ||
    (underscore && hasUnescaped(rest, '_')) ||
    (tilde && hasUnescaped(rest, '~')) ||
    (label > 0 && hasUnescaped(rest, ']')) ||
    (destination && rest.includes(')')) ||
    (formula && restOfLine.includes('$'))
  ) {
    throw ambiguous()
  }
}

/**
 * True when the link destination starting at `i` (just past `](`) is closed by
 * its own `)` before `limit`. Whitespace counts as not closed: a title may
 * follow, and a quoted title can hold anything.
 */
function destinationEndsBefore(src: string, i: number, limit: number): boolean {
  let open = 1
  for (; i < limit; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (isSpace(c)) return false
    else if (c === '(') open++
    else if (c === ')' && --open === 0) return true
  }
  return false
}

/** the text with every withheld span replaced by its `{{label}}` marker */
export function redactMarkdownSource(source: string): string {
  MARK_NAME_RE.lastIndex = 0
  if (!MARK_NAME_RE.test(source)) return source
  const budget: Budget = { left: source.length * 16 + 4096 }
  const open = new RegExp(OPEN_RE)
  const close = new RegExp(CLOSE_RE)
  const plainClose = new RegExp(PLAIN_CLOSE_RE)
  const out: string[] = []
  /** the stretches of the file that stay as written */
  const kept: Array<[number, number]> = []
  let cursor = 0
  // how far any HTML construct starting before `nextLt` reaches
  let reach = 0
  let nextLt = source.indexOf('<')
  for (;;) {
    open.lastIndex = cursor
    const start = open.exec(source)
    if (!start) break
    const openEnd = start.index + start[0].length
    // rule 1: a tag or comment that began earlier and has not ended yet would be
    // the token the editor reads, and its end, not this tag's, starts the span
    while (nextLt >= 0 && nextLt < start.index) {
      // once something reaches the end of the file nothing can reach further
      if (reach < source.length) reach = Math.max(reach, constructEnd(source, nextLt, budget))
      nextLt = source.indexOf('<', nextLt + 1)
    }
    if (reach > start.index) throw ambiguous()
    // the pattern ends the tag at the first ">", a parser at the first one
    // outside a quoted value: they have to agree
    if (tagEnd(source, start.index + 1, true, budget) !== openEnd) throw ambiguous()

    close.lastIndex = openEnd
    const end = close.exec(source)
    if (!end) throw new RedactionMarkError('a withheld span is never closed')
    plainClose.lastIndex = end.index
    const tag = plainClose.exec(source)
    if (!tag) throw ambiguous()
    const closeEnd = end.index + tag[0].length
    assertClosesHere(source, openEnd, end.index, closeEnd)

    const found = LABEL_RE.exec(start[0])
    const label = (found?.[1] ?? found?.[2] ?? 'private').trim() || 'private'
    kept.push([cursor, start.index])
    out.push(source.slice(cursor, start.index), placeholderSource(label))
    cursor = closeEnd
  }
  kept.push([cursor, source.length])
  out.push(source.slice(cursor))
  assertNoUnreadMark(source, kept, budget)
  return out.join('')
}

/**
 * The spans above were found by the editor's own pattern, which is all its
 * inline reading has. An HTML block is read by a real parser instead, and that
 * one also sees the attribute behind a `>` inside a quoted value, where the
 * pattern stops. So a mark name left standing inside the extent of a span's
 * start tag, as a parser would delimit it, is a mark that was not read. A name
 * anywhere else is only text.
 */
function assertNoUnreadMark(
  source: string,
  kept: ReadonlyArray<[number, number]>,
  budget: Budget,
): void {
  const names: number[] = []
  MARK_NAME_RE.lastIndex = 0
  for (let m = MARK_NAME_RE.exec(source); m; m = MARK_NAME_RE.exec(source)) {
    if (kept.some(([from, to]) => m!.index >= from && m!.index < to)) names.push(m.index)
  }
  if (names.length === 0) return
  const last = names[names.length - 1]!
  SPAN_START_RE.lastIndex = 0
  for (let s = SPAN_START_RE.exec(source); s && s.index < last; s = SPAN_START_RE.exec(source)) {
    const end = tagEnd(source, s.index + 1, false, budget)
    if (names.some((at) => at > s!.index && at < end)) {
      throw new RedactionMarkError('a withheld span is written in a form that cannot be read')
    }
  }
}
