import { placeholderSource, sanitizeLabel } from '@seuoffice/agent-core/redact-core'
import { decodeEntities } from './parse-xml-text'
import {
  attrsOf,
  childrenOf,
  escapeXmlAttr,
  findChild,
  maskOpaque,
  nameOf,
  textOf,
  xmlParser,
  type XNode,
} from './xml-utils'
import {
  REDACT_EL,
  REDACT_NAMESPACES,
  REDACT_NS_WRITTEN,
  REDACT_PREFIX,
} from '@seuoffice/agent-core/redact-range'
import { findStartTag } from './xml-tag'

/**
 * Text a person marked "hidden from AI" outside the body: in a header, a
 * footer, a comment, a note or an inline content control. The document editor
 * writes the mark as `<go:redact w:label="…"/>` in a run's rPr.
 *
 * Everything here reads the parser's tree, never the XML by pattern: a
 * pattern that reads a tag differently from the parser (quotes, white space,
 * `>` inside a value, comments, CDATA) has handed a model the words the parser
 * then showed, or made up an entry out of markup inside CDATA. Entries
 * (comments, notes, inline controls) are found in the tree and read from it.
 */

/**
 * The mark under any prefix or none. The editor writes `go:redact`, but
 * another writer may bind the namespace to another prefix, declare it as the
 * mark's default, or inherit it from an element around it; a reader that
 * cannot tell which withholds the words rather than hand them over.
 */
const MARK_RE = /<(?:[\w.-]+:)?redact\b/
const LABEL_RE = /<(?:[\w.-]+:)?redact\b[^>]*?\sw:label="([^"]*)"/

/**
 * The label of a run whose rPr carries the mark, or null when the run reads as
 * itself. For the rPr the engine's parser serialised (Run.rawRPr), so its
 * spelling is the serialiser's; a mark whose label is not read is withheld as
 * `private`.
 */
export function withheldLabelOf(rPrXml: string | undefined): string | null {
  if (!rPrXml || !MARK_RE.test(rPrXml)) return null
  return decodeEntities(LABEL_RE.exec(rPrXml)?.[1] ?? 'private')
}

/** Whether the raw XML holds anything that looks like the mark, comments and CDATA included. */
export function hasWithheldTrace(xml: string): boolean {
  return MARK_RE.test(xml)
}

/** What a model reads for an entry whose marks cannot all be read: the whole entry is withheld. */
export const WITHHELD_ENTRY_TEXT = placeholderSource('private')

function isMark(name: string): boolean {
  return name === 'redact' || name.endsWith(':redact')
}

/** the first mark element in the subtree, or undefined */
function markIn(node: XNode): XNode | undefined {
  const name = nameOf(node)
  if (name === undefined) return undefined
  if (isMark(name)) return node
  for (const child of childrenOf(node)) {
    const found = markIn(child)
    if (found) return found
  }
  return undefined
}

/** Whether a parsed subtree holds a mark element. */
export function hasMarkElement(node: XNode): boolean {
  return markIn(node) !== undefined
}

function placeholderRun(label: string): XNode {
  return { 'w:r': [{ 'w:t': [{ '#text': placeholderSource(label) }] }] }
}

/** a run's mark and label, or null when the run reads as itself */
function runLabel(run: XNode): string | null {
  const rPr = findChild(run, 'w:rPr')
  const mark = rPr ? markIn(rPr) : undefined
  if (!mark) return null
  const label = attrsOf(mark)['w:label']
  return label ? label : 'private'
}

function withheldChildren(nodes: XNode[]): XNode[] | null {
  const out: XNode[] = []
  // the label of the placeholder just written: neighbours under one label read as one
  let last: string | null = null
  for (const child of nodes) {
    const name = nameOf(child)
    if (name === undefined) {
      out.push(child)
      if (String(child['#text'] ?? '').trim() !== '') last = null
      continue
    }
    // a mark on a paragraph mark: no words to withhold
    if (name === 'w:pPr') {
      out.push(child)
      continue
    }
    if (isMark(name)) return null
    const label = name === 'w:r' ? runLabel(child) : null
    if (label !== null) {
      if (last !== label) out.push(placeholderRun(label))
      last = label
      continue
    }
    const inner = withheldChildren(childrenOf(child))
    if (inner === null) return null
    out.push({ ...child, [name]: inner })
    last = null
  }
  return out
}

/**
 * A parsed entry with every run hidden from AI replaced by a run that holds
 * its placeholder (neighbours under one label as one; everything inside a
 * hidden run goes with it, a nested text box included). Null when a mark sits
 * anywhere but a run's properties or a paragraph mark: the caller withholds
 * the whole entry rather than guess which words it meant.
 */
export function withheldNode(node: XNode): XNode | null {
  const name = nameOf(node)
  if (name === undefined) return node
  if (isMark(name)) return null
  const inner = withheldChildren(childrenOf(node))
  return inner === null ? null : { ...node, [name]: inner }
}

function firstMarkedRunLabel(node: XNode): string | null {
  for (const child of childrenOf(node)) {
    const name = nameOf(child)
    if (name === undefined) continue
    const label = name === 'w:r' ? runLabel(child) : null
    if (label !== null) return label
    const inner = firstMarkedRunLabel(child)
    if (inner !== null) return inner
  }
  return null
}

/**
 * The label of the first run marked hidden from AI anywhere in a block's XML
 * (a text box's paragraphs and a field's cached result included); null when no
 * run is. A block shown as a whole unit (a picture, a drawing, a field or
 * control paragraph) has no run of its own for the mark to sit on, and its
 * picture, description, preview text and display data are its runs' content: so
 * the parser asks here, and withholds the whole block under that label. A block
 * that does not parse and shows a trace of the mark is withheld as `private`.
 */
export function withheldBlockLabel(blockXml: string): string | null {
  const node = parseEntry(blockXml)
  if (!node) return hasWithheldTrace(blockXml) ? 'private' : null
  return firstMarkedRunLabel(node)
}

/** The run text of a subtree as Word shows it: w:t, outside field codes and deletions. */
export function runsText(node: XNode): string {
  let out = ''
  for (const child of childrenOf(node)) {
    if ('#text' in child) continue
    const name = nameOf(child)
    if (name === 'w:t') out += textOf(child)
    else if (name !== 'w:instrText' && name !== 'w:delInstrText' && name !== 'w:delText')
      out += runsText(child)
  }
  return out
}

/** the first element of an XML text (a declaration skipped), parsed; undefined when it does not parse */
export function parseEntry(xml: string): XNode | undefined {
  try {
    return (xmlParser.parse(xml) as XNode[]).find((n) => {
      const name = nameOf(n)
      return name !== undefined && !name.startsWith('?')
    })
  } catch {
    return undefined
  }
}

/**
 * What a model reads of a parsed entry, given how its reader reads text
 * (`textOf`): undefined when the entry carries no mark, else its text with each
 * hidden run as its placeholder, or the whole entry withheld when a mark sits
 * where no run accounts for it. It is defined whenever a mark is there, also
 * when it reads the same as the entry's own words (a hidden run whose words are
 * the placeholder): its presence is how a reader knows the entry hides something.
 */
export function withheldText(node: XNode, textOf: (node: XNode) => string): string | undefined {
  if (!hasMarkElement(node)) return undefined
  const view = withheldNode(node)
  return view === null ? WITHHELD_ENTRY_TEXT : textOf(view)
}

/** the label of the first mark in an entry's XML, `private` when it carries none that is read */
export function firstMarkLabel(entryXml: string): string {
  const node = parseEntry(entryXml)
  const mark = node ? markIn(node) : undefined
  return (mark && attrsOf(mark)['w:label']) || 'private'
}

/**
 * What a model reads of an entry written whole under one mark (`overWithheld`):
 * one placeholder per line that holds words (a blank line reads as it is).
 */
export function overWithheldModelText(text: string, label: string): string {
  return text
    .split('\n')
    .map((line) => (/\S/.test(line) ? placeholderSource(label) : line))
    .join('\n')
}

/**
 * The run properties of a run a person hid from AI, as the Docs editor writes
 * them: the character border Word draws and the mark carrying the label (the
 * namespace is declared on the part's root when the document is saved). For
 * the writers that export content hidden from AI into a .docx (Markdown, HTML)
 * to give it the mark the readers withhold by.
 */
export function hiddenRunProperties(label: string): string {
  return (
    '<w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
    `<${REDACT_EL} w:label="${escapeXmlAttr(sanitizeLabel(label) || 'private')}"/></w:rPr>`
  )
}

/** a run holds content when it has words, a picture, a drawing, an object or a symbol */
const RUN_CONTENT_RE =
  /<w:t(?:\s[^>]*)?>[^<]*\S[^<]*<\/w:t>|<w:(?:drawing|pict|object|sym)[\s>/]|<mc:AlternateContent[\s>]/

/**
 * An entry written anew from its text, with every run that holds content (words,
 * or a picture, drawing, object or symbol) hidden under `label`. For an edit
 * that cannot be patched around an entry's hidden runs (a paragraph added, a
 * change across hidden and plain words): which of the new words are the hidden
 * ones is no longer known, so all of them are, and the person can show them to
 * AI again. A picture kept in the entry is hidden with them: it may be what a
 * hidden run held. `entryXml` is the entry as this engine generates it (one run
 * per text piece, no comments or CDATA).
 */
export function overWithheld(entryXml: string, label: string): string {
  const mark =
    '<w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
    `<${REDACT_EL} xmlns:${REDACT_PREFIX}="${REDACT_NS_WRITTEN}" w:label="${escapeXmlAttr(label)}"/>`
  return entryXml.replace(
    /<w:r(\s[^>]*)?>([\s\S]*?)<\/w:r>/g,
    (run, attrs: string | undefined, inner: string) => {
      // a run with no content (a reference mark, a spacer) stays as it is
      if (!RUN_CONTENT_RE.test(inner)) return run
      const marked = inner.includes('</w:rPr>')
        ? inner.replace('</w:rPr>', `${mark}</w:rPr>`)
        : `<w:rPr>${mark}</w:rPr>${inner}`
      return `<w:r${attrs ?? ''}>${marked}</w:r>`
    },
  )
}

const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/** a start tag's attributes, each with where its value sits and the quote around it */
function tagAttributes(tag: string) {
  const out = new Map<string, { value: string; start: number; end: number }>()
  for (const m of tag.matchAll(/\s([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = m[2] ?? m[3] ?? ''
    const end = m.index + m[0].length - 1
    out.set(m[1]!, { value, start: end - value.length, end })
  }
  return out
}

/**
 * A written story part (the document, a header or footer, the comments, the
 * notes) whose runs carry the editor's mark, with its root declaring what a
 * consumer needs to keep that mark: the mark's namespace, that namespace as
 * ignorable (a consumer that does not know it skips the element instead of
 * rejecting the run), and the mark element as preserved (a consumer that
 * re-saves keeps it instead of dropping every ignorable element). The root is
 * read through its quoted values whatever its name or quotes, an existing
 * markup-compatibility prefix and lists are extended, and a root that binds
 * the mark's prefix to another namespace is left as it is.
 */
export function withRedactRoot(partXml: string): string {
  if (!partXml.includes(`<${REDACT_EL}`)) return partXml
  const root = findStartTag(maskOpaque(partXml))
  if (!root || root.selfClosing) return partXml
  let tag = partXml.slice(root.start, root.end)
  const name = /^<([\w.:-]+)/.exec(tag)![1]!
  const add = (attr: string) => {
    tag = `<${name} ${attr}${tag.slice(name.length + 1)}`
  }
  const bound = tagAttributes(tag).get(`xmlns:${REDACT_PREFIX}`)?.value
  if (bound !== undefined && !REDACT_NAMESPACES.includes(bound)) return partXml
  if (bound === undefined) add(`xmlns:${REDACT_PREFIX}="${REDACT_NS_WRITTEN}"`)
  let mc = [...tagAttributes(tag)]
    .find(([attr, a]) => attr.startsWith('xmlns:') && a.value === MC_NS)?.[0]
    .slice(6)
  if (mc === undefined) {
    mc = tagAttributes(tag).has('xmlns:mc') ? 'mce' : 'mc'
    add(`xmlns:${mc}="${MC_NS}"`)
  }
  // each list holds its token once, the producer's own entries kept
  const ensure = (list: string, token: string) => {
    const attr = tagAttributes(tag).get(`${mc}:${list}`)
    if (!attr) return add(`${mc}:${list}="${token}"`)
    const tokens = attr.value.split(/\s+/).filter(Boolean)
    if (tokens.includes(token)) return
    tag = `${tag.slice(0, attr.start)}${[...tokens, token].join(' ')}${tag.slice(attr.end)}`
  }
  ensure('Ignorable', REDACT_PREFIX)
  ensure('PreserveElements', REDACT_EL)
  return partXml.slice(0, root.start) + tag + partXml.slice(root.end)
}
