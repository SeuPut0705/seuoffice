/**
 * The `inlineWrap` mark's attribute: the chain of run-level wrapper elements
 * (inline content controls, w:smartTag, w:customXml, w:dir, w:bdo) around a
 * piece of text, as the docx run model carries it (Run.wrap). No editor
 * imports here: the document converter reads and writes the attribute too.
 */
import { sameInlineWrap, type InlineWrap, type Run } from '@genoffice/docx-engine'

export const INLINE_WRAP_MARK = 'inlineWrap'

/**
 * Chains that came out of an opened document, by the token they go by in the
 * DOM. Their bytes go into the saved file as they are, so they stay out of the
 * DOM (clipboard, exported HTML), and pasted HTML may only bring back what
 * this renderer has read from a file: anything else pastes as plain text.
 */
const chainsByDomKey = new Map<string, string>()
const domKeys = new Map<string, string>()

/** 64 bits of the text (two rounds of a 32-bit multiplicative hash) */
function hashKey(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(36)}-${(h1 >>> 0).toString(36)}`
}

/**
 * One wrapper as the attribute holds it: every field the run model gave it,
 * the identifying three first and the rest by name, so equal wrappers always
 * make equal text.
 */
function wrapJson(wrap: InlineWrap): Record<string, unknown> {
  const out: Record<string, unknown> = { seq: wrap.seq, open: wrap.open, close: wrap.close }
  const fields: Record<string, unknown> = { ...wrap }
  for (const key of Object.keys(fields).sort()) {
    if (!(key in out) && fields[key] !== undefined) out[key] = fields[key]
  }
  return out
}

/** the mark attribute of a run's wrapper chain */
export function inlineWrapChainAttr(wrap: readonly InlineWrap[]): string {
  const chain = JSON.stringify(wrap.map(wrapJson))
  if (!domKeys.has(chain)) {
    const key = hashKey(chain)
    domKeys.set(chain, key)
    chainsByDomKey.set(key, chain)
  }
  return chain
}

/** the token a mark attribute goes by in the DOM; empty for one no document produced */
export function inlineWrapDomKey(attr: unknown): string {
  return typeof attr === 'string' ? (domKeys.get(attr) ?? '') : ''
}

/** the mark attribute behind a DOM token, when a document this renderer opened produced it */
export function inlineWrapChainOfDomKey(key: string): string | undefined {
  return chainsByDomKey.get(key)
}

const isInlineWrap = (value: unknown): value is InlineWrap =>
  typeof value === 'object' &&
  value !== null &&
  'seq' in value &&
  typeof value.seq === 'number' &&
  'open' in value &&
  typeof value.open === 'string' &&
  'close' in value &&
  typeof value.close === 'string' &&
  (!('inside' in value) || value.inside === 'revision' || value.inside === 'link') &&
  (!('text' in value) || typeof value.text === 'string')

const parsedChains = new Map<string, InlineWrap[]>()

/** the wrapper chain a mark attribute holds; empty when it holds none */
export function inlineWrapChainOf(attr: unknown): InlineWrap[] {
  if (typeof attr !== 'string' || attr === '') return []
  const cached = parsedChains.get(attr)
  if (cached) return cached
  let chain: InlineWrap[] = []
  try {
    const value: unknown = JSON.parse(attr)
    if (Array.isArray(value)) chain = value.filter(isInlineWrap)
  } catch {
    chain = []
  }
  parsedChains.set(attr, chain)
  return chain
}

/** the wrappers two chains share from the outside in: what both pieces of text sit in */
export function sharedInlineWraps(
  a: readonly InlineWrap[],
  b: readonly InlineWrap[],
): InlineWrap[] {
  const shared: InlineWrap[] = []
  for (let i = 0; i < a.length && i < b.length && sameInlineWrap(a[i], b[i]); i++) {
    shared.push(a[i])
  }
  return shared
}

/** `chain` put inside `outer`: unchanged when it already is, `outer` itself when it is part of it */
export function inlineWrapsInside(
  outer: readonly InlineWrap[],
  chain: readonly InlineWrap[],
): readonly InlineWrap[] {
  const shared = sharedInlineWraps(outer, chain).length
  if (shared === outer.length) return chain
  return shared === chain.length ? outer : [...outer, ...chain]
}

/** `chain` without the wrappers in `gone` */
export function inlineWrapsWithout(
  chain: readonly InlineWrap[],
  gone: readonly InlineWrap[],
): InlineWrap[] {
  return chain.filter((wrap) => !gone.some((other) => sameInlineWrap(wrap, other)))
}

/**
 * What makes a wrapper one of a kind in the file: a content control's w:id
 * (its opening bytes when it has none). Null for the wrappers that carry no
 * id (w:smartTag, w:customXml, w:dir, w:bdo), which a copy may repeat.
 */
export function contentControlKey(wrap: InlineWrap): string | null {
  if (!/^<w:sdt[\s>]/.test(wrap.open)) return null
  return /<w:id\s[^>]*w:val=["']([^"']*)["']/.exec(wrap.open)?.[1] ?? wrap.open
}

/**
 * A node of the editor's JSON as a copy placed elsewhere holds it: without
 * the content controls around its text, which exist once in a file. The
 * wrappers that carry no id stay.
 */
export function withoutUniqueStructure<T extends NodeJson & { content?: T[]; marks?: MarkJson[] }>(
  node: T,
): T {
  let out = node
  const mark = node.marks?.find((m) => m.type === INLINE_WRAP_MARK)
  if (mark) {
    const chain = inlineWrapChainOf(mark.attrs?.chain)
    const kept = chain.filter((wrap) => contentControlKey(wrap) === null)
    if (kept.length !== chain.length) {
      const marks = (node.marks ?? []).flatMap((m) =>
        m !== mark
          ? [m]
          : kept.length > 0
            ? [{ ...m, attrs: { ...m.attrs, chain: inlineWrapChainAttr(kept) } }]
            : [],
      )
      out = { ...out, marks }
    }
  }
  if (node.content) {
    const content = node.content.map(withoutUniqueStructure)
    if (content.some((c, i) => c !== node.content![i])) out = { ...out, content }
  }
  return out
}

// ---- the document converter's side: Run <-> editor JSON ----

interface MarkJson {
  type: string
  attrs?: Record<string, unknown>
}
interface NodeJson {
  type: string
  attrs?: Record<string, unknown>
}

/** the mark that carries a run's wrapper chain; null for a run outside any wrapper */
export function inlineWrapMarkOf(run: Run): MarkJson | null {
  return run.wrap?.length
    ? { type: INLINE_WRAP_MARK, attrs: { chain: inlineWrapChainAttr(run.wrap) } }
    : null
}

/** reads `mark` into `run` when it is the wrapper mark; false for any other mark */
export function readInlineWrapMark(run: Run, mark: MarkJson): boolean {
  if (mark.type !== INLINE_WRAP_MARK) return false
  const chain = inlineWrapChainOf(mark.attrs?.chain)
  if (chain.length > 0) run.wrap = chain
  return true
}

/** the run sits in a wrapper: text beside it never merges into it */
export function holdsInlineStructure(run: Run | undefined): boolean {
  return (run?.wrap?.length ?? 0) > 0
}

/** the wrappers a run sits in, as merge / signature key */
export function inlineStructureKey(run: Run): unknown {
  return run.wrap?.length ? run.wrap.map((w) => [w.seq, w.open, w.close]) : null
}

// ---- where the wrappers sit: what a "did this block change" test asks ----

/** one stretch of a paragraph's text that sits in one wrapper chain, in characters of that text */
export interface WrapSpan {
  /** the chain, and for a stretch read from the editor's JSON the paragraph it is in */
  chain: string
  from: number
  to: number
}

/**
 * The stretches of a paragraph's text that sit in one wrapper chain. Text
 * without a wrapper makes no stretch, and a piece without text (a picture)
 * neither ends nor starts one.
 */
function wrapSpans(pieces: Iterable<readonly [chain: string | null, length: number]>): WrapSpan[] {
  const spans: WrapSpan[] = []
  let at = 0
  let from = 0
  let open: string | null = null
  for (const [chain, length] of [...pieces, [null, 1] as const]) {
    if (length === 0) continue
    if (chain !== open) {
      if (open !== null) spans.push({ chain: open, from, to: at })
      open = chain
      from = at
    }
    at += length
  }
  return spans
}

/** the wrapper stretches of a paragraph's runs */
export function runWrapSpans(runs: readonly Run[]): WrapSpan[] {
  return wrapSpans(
    runs.map((run) => [
      run.wrap?.length ? JSON.stringify(inlineStructureKey(run)) : null,
      run.text.length,
    ]),
  )
}

/**
 * The wrapper stretches of every paragraph under `node` in the editor's JSON.
 * Each carries the path of its paragraph in its chain, so the same wrapper in
 * another paragraph is another stretch.
 */
export function nodeWrapSpans(node: NodeJson): WrapSpan[] {
  type Json = NodeJson & { content?: Json[]; text?: string; marks?: MarkJson[] }
  const out: WrapSpan[] = []
  const walk = (parent: Json, path: string): void => {
    const content = parent.content ?? []
    if (!content.some((child) => child.type === 'text')) {
      content.forEach((child, i) => walk(child, `${path}.${i}`))
      return
    }
    const spans = wrapSpans(
      content.map((child) => {
        const chain = child.marks?.find((m) => m.type === INLINE_WRAP_MARK)?.attrs?.chain
        return [typeof chain === 'string' ? chain : null, child.text?.length ?? 0]
      }),
    )
    for (const span of spans) out.push({ ...span, chain: `${path}|${span.chain}` })
  }
  walk(node, '')
  return out
}

/**
 * No wrapper the editor shows covers text the file's wrapper does not. One
 * that grew, moved, or stands where the file has none is an edit, and only
 * writing the block anew puts it there. One that is gone or covers less is no
 * difference: no command shrinks a wrapper, it only loses text as a side
 * effect (a paragraph split inside it and joined again, text put back without
 * its mark by an AI rewrite, a retyped word or a peer), and that text is still
 * the file's text, so the block keeps its bytes, the whole wrapper included.
 */
export function wrapSpansKept(shown: readonly WrapSpan[], read: readonly WrapSpan[]): boolean {
  return shown.every((span) =>
    read.some((r) => r.chain === span.chain && r.from <= span.from && span.to <= r.to),
  )
}
