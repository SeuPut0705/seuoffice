/**
 * Outline text back into a map: the text `sheetsToOutline` writes, and an
 * ordinary markdown document just as well.
 *
 * - **Sheets.** Every level 1 heading (`# `) starts a sheet and names it. Text
 *   without one makes a single sheet. What stands before the first `# ` is a
 *   sheet of its own when it holds topics; when it is only text, that text
 *   goes to the note of the first sheet's central topic.
 * - **Topics.** Headings of level 2 to 6 and list items (`-`, `*`, `+`, `1.`,
 *   `1)`) are topics. A heading hangs below the nearest heading of a lower
 *   level; a list item hangs below the nearest item above it whose marker is
 *   indented less, or else below the heading above the list. A line indented
 *   four columns or more outside any list is code, not the start of a list.
 * - **Central topic.** A sheet with exactly one outermost topic takes it as
 *   the central topic. Otherwise the central topic is the sheet title (the
 *   caller's "untitled" text when there is none) and the outermost topics are
 *   its branches.
 * - **Everything else is a note.** A line that is no heading and no list item
 *   (a paragraph, a table, a code block, a quote, a rule) goes to the note of
 *   the topic it stands under, as written: only the indentation of the list
 *   item it belongs to is taken off. It belongs to the nearest item above
 *   whose marker is indented less than the line; a plain text line directly
 *   under a line of an item continues that item whatever its indentation.
 *   Text under a `# ` heading before any topic goes to the central topic.
 * - **The writer's notation comes back.** `[a, b]` at the end of a topic line
 *   are labels and `<https://...>` at its end is the web link. The `> ` lines
 *   directly under a list item are its note, without the marker. A kind mark
 *   (`(summary)` and the like) at the start of an item is taken off, and the
 *   item is an ordinary topic. Backslash escapes in titles and labels are
 *   undone.
 *
 * Only the line of the marker is the title: an item whose text wraps onto a
 * second line gets that second line in its note. Nothing inside a line is read
 * as markdown, so `**bold**` in a title stays as typed.
 *
 * The text is untrusted and may be huge. Every line is handled once, with no
 * recursion; nesting deeper than MAX_TOPIC_DEPTH is flattened: a topic that
 * would sit below the deepest level allowed becomes a sibling at that level,
 * in the order it was read, so the result always passes the structure check.
 */

import {
  createXmindDocumentFromSheets,
  newSheet,
  newTopic,
  type CreateXmindOptions,
} from './create'
import type { XmindDocument } from './document'
import { kindMarkLength, LINE_BREAK } from './outline-marks'
import { MAX_TOPIC_DEPTH } from './structure-check'
import type { XmindSheet, XmindTopic } from './types'
import { isWebLink } from './view'

export interface OutlineReadOptions {
  /**
   * The "untitled" text in the user's language. It names a sheet that has no
   * `# ` heading, and the central topic of such a sheet when the outline gives
   * no single outermost topic. The engine has no screen text of its own.
   */
  untitled: string
}

/**
 * The sheets an outline describes, as source trees with fresh ids, ready to be
 * added to an open document or wrapped into a new one. Always at least one.
 */
export function outlineToSheets(text: string, options: OutlineReadOptions): XmindSheet[] {
  return readSections(text).map((section) => sectionToSheet(section, options.untitled))
}

/** A new map file from outline text. */
export function createXmindDocumentFromOutline(
  text: string,
  options: OutlineReadOptions & CreateXmindOptions,
): Promise<XmindDocument> {
  return createXmindDocumentFromSheets(outlineToSheets(text, options), options)
}

/** A topic as read, before it becomes part of a source tree. */
interface Draft {
  title: string
  labels: string[]
  link: string | null
  /** the `> ` lines directly under a list item, markers taken off */
  quoted: string[]
  /** every other line under it, as written */
  body: string[]
  children: Draft[]
  parent: Draft | null
  /** 0 for an outermost topic of the sheet */
  depth: number
}

/** What one `# ` heading covers, or the text before the first one. */
interface Section {
  /** null when no heading names it */
  title: string | null
  /** lines that stand under no topic */
  body: string[]
  /** how many of those lines came before the first outermost topic; null while there is none */
  itemsAt: number | null
  outer: Draft[]
  /** the drafts at the deepest level a topic may have */
  deepest: Draft[]
}

interface OpenItem {
  /** column of the list marker */
  indent: number
  /** column where the item's own text starts */
  content: number
  draft: Draft
}

interface OpenFence {
  char: string
  length: number
  /** marker column of the list item the block sits in; -1 outside a list */
  floor: number
}

const HEADING = /^(#{1,6})(?:[ \t]+|$)/
const BULLET = /^[-+*](?=[ \t]|$)/
const ORDERED = /^\d{1,9}[.)](?=[ \t]|$)/
const FENCE = /^(?:`{3,}|~{3,})/
const RULE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/

function readSections(text: string): Section[] {
  let section = newSection(null)
  const sections = [section]
  let headings: { level: number; draft: Draft }[] = []
  let items: OpenItem[] = []
  /** where a line that is not a topic goes, and how much indentation comes off it */
  let sink: { body: string[] } = section
  let dedent = 0
  /** the item whose `> ` lines are still its note: nothing else has followed it yet */
  let noteItem: OpenItem | null = null
  let afterBlank = false
  let fence: OpenFence | null = null

  /** Closes the items a line at this column is not inside, and points the sink at what is left. */
  const settle = (column: number): void => {
    while (items.length > 0 && column <= items[items.length - 1]!.indent) items.pop()
    const item = items[items.length - 1]
    sink = item?.draft ?? headings[headings.length - 1]?.draft ?? section
    dedent = item?.content ?? 0
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (const line of source.split(LINE_BREAK)) {
    const blanks = leadingBlanks(line)
    const column = columnAt(line, blanks)
    const rest = line.slice(blanks)

    if (fence) {
      // A line that has left the list item ends the block with it.
      if (rest === '' || column > fence.floor) {
        sink.body.push(withoutIndent(line, dedent))
        if (closesFence(rest, fence)) fence = null
        afterBlank = false
        continue
      }
      fence = null
    }
    if (rest === '') {
      sink.body.push('')
      afterBlank = true
      noteItem = null
      continue
    }

    // Four columns in and outside any list is an indented code block: text,
    // whatever it starts with.
    const code = items.length === 0 && column >= 4
    const heading = column <= 3 ? HEADING.exec(rest) : null
    const rule = !code && !heading && RULE.test(rest)
    const marker = code || heading || rule ? 0 : markerLength(rest)
    if (heading) {
      const level = heading[1]!.length
      const title = withoutClosingHashes(rest.slice(heading[0].length))
      items = []
      noteItem = null
      dedent = 0
      if (level === 1) {
        section = newSection(unescape(title))
        sections.push(section)
        headings = []
        sink = section
      } else {
        while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
        const parent = headings[headings.length - 1]?.draft ?? null
        const draft = addDraft(section, parent, readTopicLine(title, false))
        headings.push({ level, draft })
        sink = draft
      }
    } else if (marker > 0) {
      while (items.length > 0 && items[items.length - 1]!.indent >= column) items.pop()
      const parent = items[items.length - 1]?.draft ?? headings[headings.length - 1]?.draft ?? null
      const after = rest.slice(marker)
      const gap = leadingBlanks(after)
      const draft = addDraft(section, parent, readTopicLine(after.slice(gap), true))
      const item = {
        indent: column,
        content: column + marker + (gap >= 1 && gap <= 4 ? gap : 1),
        draft,
      }
      items.push(item)
      sink = draft
      dedent = item.content
      noteItem = item
    } else if (!code && rest[0] === '>') {
      settle(column)
      if (noteItem !== null && items[items.length - 1] === noteItem) {
        noteItem.draft.quoted.push(rest.slice(rest[1] === ' ' ? 2 : 1))
      } else {
        noteItem = null
        sink.body.push(withoutIndent(line, dedent))
      }
    } else {
      const opening = code ? undefined : FENCE.exec(rest)?.[0]
      // A backtick fence cannot have a backtick after it: that is inline code.
      const opens =
        opening !== undefined && !(opening[0] === '`' && rest.includes('`', opening.length))
      // Plain text directly under a line of an item goes on with that item.
      const continues = !opens && !rule && !afterBlank && items.length > 0
      if (!continues) settle(column)
      noteItem = null
      sink.body.push(withoutIndent(line, dedent))
      if (opens) {
        fence = {
          char: opening[0]!,
          length: opening.length,
          floor: items[items.length - 1]?.indent ?? -1,
        }
      }
    }
    afterBlank = false
  }

  // Text before the first heading that holds no topic belongs to the sheet after it.
  const first = sections[0]!
  if (sections.length > 1 && first.outer.length === 0) {
    sections.shift()
    const body = withoutBlankEdges(first.body)
    if (body.length > 0) {
      const next = sections[0]!
      next.body = [...body, '', ...next.body]
      if (next.itemsAt !== null) next.itemsAt += body.length + 1
    }
  }
  return sections
}

function newSection(title: string | null): Section {
  return { title, body: [], itemsAt: null, outer: [], deepest: [] }
}

function addDraft(
  section: Section,
  parent: Draft | null,
  line: Pick<Draft, 'title' | 'labels' | 'link'>,
): Draft {
  let above = parent
  while (above !== null && above.depth >= MAX_TOPIC_DEPTH) above = above.parent
  const draft: Draft = {
    ...line,
    quoted: [],
    body: [],
    children: [],
    parent: above,
    depth: above === null ? 0 : above.depth + 1,
  }
  if (above === null && section.itemsAt === null) section.itemsAt = section.body.length
  ;(above === null ? section.outer : above.children).push(draft)
  if (draft.depth === MAX_TOPIC_DEPTH) section.deepest.push(draft)
  return draft
}

/** How many spaces and tabs a line starts with. */
function leadingBlanks(line: string): number {
  let at = 0
  while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at++
  return at
}

const TAB_STOP = 4

/** The column the first `count` characters of a line reach; a tab runs to the next tab stop. */
function columnAt(line: string, count: number): number {
  let column = 0
  for (let at = 0; at < count; at++) {
    column = line[at] === '\t' ? column + TAB_STOP - (column % TAB_STOP) : column + 1
  }
  return column
}

/** The line without the blanks that fill its first `columns` columns. */
function withoutIndent(line: string, columns: number): string {
  let at = 0
  let column = 0
  while (column < columns && at < line.length && (line[at] === ' ' || line[at] === '\t')) {
    column = line[at] === '\t' ? column + TAB_STOP - (column % TAB_STOP) : column + 1
    at++
  }
  return at === 0 ? line : line.slice(at)
}

/** The length of the list marker a line's text starts with; 0 when it starts with none. */
function markerLength(rest: string): number {
  if (BULLET.test(rest)) return 1
  return ORDERED.exec(rest)?.[0].length ?? 0
}

function closesFence(rest: string, fence: OpenFence): boolean {
  let run = 0
  while (run < rest.length && rest[run] === fence.char) run++
  return run >= fence.length && rest.slice(run).trim() === ''
}

/** A heading's text without the `#` run that may close it. */
function withoutClosingHashes(text: string): string {
  const trimmed = text.trimEnd()
  let start = trimmed.length
  while (start > 0 && trimmed[start - 1] === '#') start--
  if (start === trimmed.length) return trimmed
  const closes = start === 0 || trimmed[start - 1] === ' ' || trimmed[start - 1] === '\t'
  return closes ? trimmed.slice(0, start).trimEnd() : trimmed
}

/**
 * The parts of a topic line: `title [labels] <link>`. A list item may start
 * with a kind mark, which is taken off; a heading is never written with one.
 */
function readTopicLine(text: string, isItem: boolean): Pick<Draft, 'title' | 'labels' | 'link'> {
  let rest = text.trim()
  if (isItem) rest = rest.slice(kindMarkLength(rest))

  let link: string | null = null
  if (rest.endsWith('>')) {
    // The writer escapes every `<` of a title that a link could start with, so
    // an unescaped one after a blank is the link's.
    const open = rest.lastIndexOf('<')
    const inner = rest.slice(open + 1, -1)
    if (open >= 0 && startsWord(rest, open) && !/[\s>]/.test(inner) && isWebLink(inner)) {
      link = inner
      rest = rest.slice(0, open).trimEnd()
    }
  }

  let labels: string[] = []
  if (rest.endsWith(']')) {
    const escaped = escapedPositions(rest)
    const close = rest.length - 1
    let open = escaped[close] ? -1 : close - 1
    while (open >= 0 && (escaped[open] || (rest[open] !== '[' && rest[open] !== ']'))) open--
    if (open >= 0 && rest[open] === '[' && startsWord(rest, open)) {
      const found = splitLabels(rest, open + 1, close, escaped)
      // Brackets with nothing in them are text, not an empty list of labels.
      if (found.length > 0) {
        labels = found
        rest = rest.slice(0, open).trimEnd()
      }
    }
  }
  return { title: unescape(rest), labels, link }
}

/** Whether the character at `at` starts the text or follows a blank. */
function startsWord(text: string, at: number): boolean {
  return at === 0 || text[at - 1] === ' ' || text[at - 1] === '\t'
}

const PUNCTUATION = /[!-/:-@[-`{-~]/

/** Marks each character that a backslash before it turns into plain text. One pass, left to right. */
function escapedPositions(text: string): Uint8Array {
  const escaped = new Uint8Array(text.length)
  for (let at = 0; at < text.length - 1; at++) {
    if (text[at] === '\\' && PUNCTUATION.test(text[at + 1]!)) {
      escaped[at + 1] = 1
      at++
    }
  }
  return escaped
}

function splitLabels(text: string, from: number, to: number, escaped: Uint8Array): string[] {
  const labels: string[] = []
  let start = from
  for (let at = from; at <= to; at++) {
    if (at < to && (text[at] !== ',' || escaped[at])) continue
    const label = unescape(text.slice(start, at).trim())
    if (label !== '') labels.push(label)
    start = at + 1
  }
  return labels
}

/** Undoes backslash escapes the way markdown does: a backslash before punctuation goes. */
function unescape(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function withoutBlankEdges(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start++
  while (end > start && lines[end - 1]!.trim() === '') end--
  return lines.slice(start, end)
}

/**
 * The note of a topic: what stood above it in the sheet, its `> ` lines, its
 * other text, then what stood after it in the sheet.
 */
function noteOf(
  draft: Draft,
  above: readonly string[] = [],
  after: readonly string[] = [],
): string | null {
  const parts = [
    withoutBlankEdges(above).join('\n'),
    draft.quoted.join('\n'),
    withoutBlankEdges(draft.body).join('\n'),
    withoutBlankEdges(after).join('\n'),
  ].filter((part) => part !== '')
  return parts.length > 0 ? parts.join('\n\n') : null
}

function sectionToSheet(section: Section, untitled: string): XmindSheet {
  const title = section.title === null || section.title === '' ? untitled : section.title
  const only = section.outer.length === 1 ? section.outer[0]! : null
  if (only === null) raiseDeepest(section)
  const root: Draft = only ?? {
    title,
    labels: [],
    link: null,
    quoted: [],
    body: section.body,
    children: section.outer,
    parent: null,
    depth: 0,
  }
  const sheet = newSheet({ title, rootTitle: root.title })
  if (only === null) {
    dress(sheet.rootTopic, root)
  } else {
    // the sheet's own text keeps its place: before the topic's lines or after them
    const at = section.itemsAt ?? section.body.length
    dress(sheet.rootTopic, root, section.body.slice(0, at), section.body.slice(at))
  }

  const pending: [Draft, XmindTopic][] = [[root, sheet.rootTopic]]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [draft, topic] = next
    if (draft.children.length === 0) continue
    topic.children = {
      attached: draft.children.map((child) => {
        const made = newTopic(child.title)
        dress(made, child)
        pending.push([child, made])
        return made
      }),
    }
  }
  return sheet
}

/**
 * A sheet whose outermost topics become branches of a central topic made for
 * them is one level deeper than it was read. The topics at the deepest level
 * then move up one, to stand after the topic they were under.
 */
function raiseDeepest(section: Section): void {
  const done = new Set<Draft>()
  for (const draft of section.deepest) {
    const above = draft.parent!.parent!
    if (done.has(above)) continue
    done.add(above)
    above.children = above.children.flatMap((child) => {
      const raised = child.children
      child.children = []
      return [child, ...raised]
    })
  }
}

/** Puts what a draft holds besides its title on the topic made for it. */
function dress(
  topic: XmindTopic,
  draft: Draft,
  above: readonly string[] = [],
  after: readonly string[] = [],
): void {
  if (draft.labels.length > 0) topic.labels = draft.labels
  if (draft.link !== null) topic.href = draft.link
  const note = noteOf(draft, above, after)
  if (note !== null) topic.notes = { plain: { content: note } }
}
