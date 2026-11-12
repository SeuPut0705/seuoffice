import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import { decodeEntities } from './parse-xml-text'
import { attrsOf, childrenOf, findChild, nameOf, textOf, xmlParser, type XNode } from './xml-utils'

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
 * (`textOf`): undefined when the entry hides nothing, else its text with each
 * hidden run as its placeholder, or the whole entry withheld when a mark sits
 * where no run accounts for it.
 */
export function withheldText(node: XNode, textOf: (node: XNode) => string): string | undefined {
  if (!hasMarkElement(node)) return undefined
  const view = withheldNode(node)
  const modelText = view === null ? WITHHELD_ENTRY_TEXT : textOf(view)
  return modelText === textOf(node) ? undefined : modelText
}

/**
 * A save refused because an edit cannot be written into a comment or note that
 * hides words from AI: written anew from its text, the entry would lose its
 * mark and show a model the words; kept as it was, the edit would be lost.
 */
export class HiddenEntrySaveError extends Error {
  constructor(kind: 'comment' | 'footnote' | 'endnote', id: string) {
    super(
      `${kind} ${id} holds text hidden from AI, and this edit cannot be written into it ` +
        '(it adds or removes a paragraph): keep its paragraphs as they were, or show the text to AI first',
    )
    this.name = 'HiddenEntrySaveError'
  }
}
