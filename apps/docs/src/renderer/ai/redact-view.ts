import {
  redactTextBetween as redactRangeTextBetween,
  type WithheldMark,
  type WithheldNode,
} from '@seuoffice/agent-core/redact-range'
import { decodeBlockLabel } from '../editor/block-redact-label'
import { REDACT_MARK, placeholderSource } from './redact'

/**
 * The model-facing view of a document: every withheld span becomes its marker,
 * and the text it covers disappears. A withheld picture becomes a marker too,
 * without a path, so the model is not handed a reference it could fetch.
 *
 * The walk takes a plain shape rather than a ProseMirror node so it can be
 * tested without a schema, and so it does not depend on which ProseMirror
 * version the editor is pinned to. It is total: anything it does not recognise
 * passes through, because a throw here would be a silent leak — the caller's
 * fallback would be the unredacted text.
 */
/** the shared shape, not a second one */
export type RedactableNode = WithheldNode
export type RedactableMark = WithheldMark

/**
 * TipTap serialises a mark's `type` as its schema object rather than the
 * registered name, so both forms have to be accepted — a strict
 * `=== 'redaction'` matches nothing and the span is read back in full.
 */
function markName(mark: RedactableMark | undefined): string {
  const type = mark?.type
  if (typeof type === 'string') return type
  return type?.name ?? ''
}

function nameOf(node: RedactableNode): string {
  const type = node.type
  if (typeof type === 'string') return type
  return type?.name ?? ''
}

function redactionMarkOf(node: RedactableNode): RedactableMark | undefined {
  return node.marks?.find((m) => markName(m) === REDACT_MARK)
}

function isWithheld(node: RedactableNode): boolean {
  return redactionMarkOf(node) !== undefined
}

function labelOf(node: RedactableNode): string {
  const label = redactionMarkOf(node)?.attrs?.label
  return typeof label === 'string' ? label : 'private'
}

/** A picture that is withheld still needs a marker: it has no text to redact. */
function isPicture(node: RedactableNode): boolean {
  const name = nameOf(node)
  return name === 'docInlineImage' || name === 'image'
}

/** nodes ProseMirror counts as a single token: their JSON carries no content */
const ATOM_TYPES = new Set([
  'hardBreak',
  'docNoteRef',
  'docXeMark',
  'docRuby',
  'docInlineImage',
  'docInlineMath',
  'docCellBoxes',
  'docNestedTable',
  'docProtected',
])

/** The model-facing text of one node: a withheld span reads as its placeholder. */
export function projectedNodeText(node: RedactableNode): string {
  if (isWithheld(node)) return placeholderSource(labelOf(node))
  return typeof node.text === 'string' ? node.text : ''
}

/**
 * The text of a document as the model may read it.
 *
 * `limit` stops the walk once roughly that many characters are collected —
 * the naming caller reads this on the UI thread and the shell truncates the
 * answer to 4000 characters anyway, so a long document should not pay for
 * its whole walk. Without a limit the walk covers the document whole.
 */
export function modelTextOf(node: RedactableNode, limit?: { maxChars: number }): string {
  return modelTextWalk(node, limit ? { chars: limit.maxChars } : null)
}

/** What is left of a `modelTextOf` limit while the walk collects. */
interface TextBudget {
  chars: number
}

function modelTextWalk(node: RedactableNode, budget: TextBudget | null): string {
  if (budget !== null && budget.chars <= 0) return ''
  if (isWithheld(node)) return placeholderSource(labelOf(node))
  if (typeof node.text === 'string') {
    if (budget !== null) budget.chars -= node.text.length
    return node.text
  }
  const children = node.content
  if (!Array.isArray(children)) return ''
  let out = ''
  for (const child of children) {
    out += modelTextWalk(child, budget)
    // a block boundary is a line break, but not a trailing one: the caller
    // joins this with other text and a stray newline reads as a blank line
    if (Array.isArray(child.content) && child !== children[children.length - 1]) out += '\n'
    if (budget !== null && budget.chars <= 0) break
  }
  return out
}

/**
 * The text of a range, as the model may read it.
 *
 * A thin wrapper over the shared walker so the options are stated once for
 * docs — the mark name, the marker, and the picture rule all live here rather
 * than at every call site.
 */
export function redactTextBetween(
  node: RedactableNode,
  from: number,
  to: number,
  blockSeparator = '\n',
): string {
  return redactRangeTextBetween(node, from, to, {
    markName: REDACT_MARK,
    marker: placeholderSource,
    blockSeparator,
    // an atom not listed here would serialise without `content` and read as
    // an empty container, so the set has to name every one the schema has
    isLeaf: (n) => ATOM_TYPES.has(nameOf(n as RedactableNode) ?? ''),
  })
}

/**
 * A whole-unit block (a picture, a drawing) whose picture sits in a run marked
 * hidden from AI: the label of the mark, or undefined when it is not hidden.
 * The block has no run for a mark to sit on; the parser lifts the label here.
 */
export function withheldBlockLabel(node: RedactableNode): string | undefined {
  const stored = node.attrs?.redact
  return nameOf(node) === 'docProtected' && typeof stored === 'string'
    ? decodeBlockLabel(stored)
    : undefined
}

/** What a model reads as the preview of a protected block: the placeholder of a hidden one, else its own preview text. */
export function protectedPreviewOf(attrs: Record<string, unknown> | undefined): string {
  const stored = attrs?.redact
  return typeof stored === 'string'
    ? placeholderSource(decodeBlockLabel(stored))
    : String(attrs?.previewText ?? '')
}

/** The same document with spans replaced, for callers that need the nodes. */
export function redactNode<T extends RedactableNode>(node: T): T {
  const hiddenBlock = withheldBlockLabel(node)
  if (hiddenBlock !== undefined) {
    // nothing of the block travels but its place: no picture, preview text,
    // description or display data of what a hidden run holds
    return {
      type: 'docProtected',
      attrs: {
        docxIndex: node.attrs?.docxIndex ?? null,
        blockType: node.attrs?.blockType ?? 'passthrough',
        label: node.attrs?.label ?? '',
        previewText: placeholderSource(hiddenBlock),
        // as stored, so that what reads it again decodes it once
        redact: node.attrs?.redact,
      },
    } as unknown as T
  }
  if (isWithheld(node)) {
    if (isPicture(node)) {
      // a picture's `src` and inlined `dataUrl` are exactly what must not
      // travel: either one would let the model fetch the withheld image
      return { type: 'docInlineImage', attrs: { redact: labelOf(node) } } as unknown as T
    }
    return { type: 'text', text: placeholderSource(labelOf(node)) } as unknown as T
  }
  if (Array.isArray(node.content)) {
    return { ...node, content: node.content.map((c) => redactNode(c)) }
  }
  return node
}

/** Every label withheld in a document, for the model's instruction. */
export function redactLabelsOf(node: RedactableNode): string[] {
  const out: string[] = []
  const visit = (n: RedactableNode) => {
    if (isWithheld(n)) out.push(labelOf(n))
    const block = withheldBlockLabel(n)
    if (block !== undefined) out.push(block)
    if (Array.isArray(n.content)) n.content.forEach(visit)
  }
  visit(node)
  return out
}

/** How many spans a document withholds; the guard's "is there anything to check". */
export function redactionCount(node: RedactableNode): number {
  let n = 0
  const visit = (x: RedactableNode) => {
    if (isWithheld(x) || withheldBlockLabel(x) !== undefined) n++
    if (Array.isArray(x.content)) x.content.forEach(visit)
  }
  visit(node)
  return n
}

/** A word of a run hidden from AI, with the run's label. */
export interface HiddenWord {
  word: string
  label: string
}

/**
 * The words a document hides from AI: each run of hidden text whole, and each
 * of its words (letters or digits, however short: a Korean word is often two
 * syllables), lower-cased. A protected block hidden from AI keeps its words
 * in its XML, not in runs: every word of its visible text counts as hidden.
 */
export function hiddenWordsOf(node: RedactableNode): HiddenWord[] {
  const out: HiddenWord[] = []
  const add = (text: string, label: string) => {
    const whole = text.trim().toLowerCase()
    if (whole) out.push({ word: whole, label })
    for (const word of whole.match(/[\p{L}\p{N}]+/gu) ?? []) out.push({ word, label })
  }
  const visit = (n: RedactableNode) => {
    const blockLabel = withheldBlockLabel(n)
    if (blockLabel !== undefined) {
      const display = n.attrs?.fieldDisplay as { left?: unknown; right?: unknown } | null
      for (const text of [n.attrs?.previewText, display?.left, display?.right])
        if (typeof text === 'string') add(text, blockLabel)
    }
    if (!Array.isArray(n.content)) return
    // the hidden text nodes that touch read as one run: formatting may split it
    let run = ''
    let runLabel: string | null = null
    for (const child of n.content) {
      const label = isWithheld(child) && typeof child.text === 'string' ? labelOf(child) : null
      if (label !== null && label === runLabel) run += child.text
      else {
        if (runLabel !== null) add(run, runLabel)
        run = label !== null ? (child.text as string) : ''
        runLabel = label
      }
      visit(child)
    }
    if (runLabel !== null) add(run, runLabel)
  }
  visit(node)
  return out
}

/**
 * The label a field instruction is withheld under when it repeats a word a
 * person hid from AI (case aside), else undefined. A MERGEFIELD or HYPERLINK
 * naming the hidden words would hand them over though its result reads as a
 * placeholder; a short word that happens to occur in the instruction withholds
 * more, never less.
 */
export function repeatedHiddenLabel(
  instr: string,
  words: readonly HiddenWord[],
): string | undefined {
  const lower = instr.toLowerCase()
  return words.find((w) => lower.includes(w.word))?.label
}
