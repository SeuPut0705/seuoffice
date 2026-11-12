// Run-level structure the run model has no field for: wrapper elements around
// runs (w:sdt, w:smartTag, w:customXml, w:dir, w:bdo) and paragraph-level
// elements without text (w:permStart, range markers...). Their bytes ride on
// the runs (Run.wrap, Run.opaqueXml) so a rebuilt paragraph writes them back.
import type { InlineWrap, Run } from './types'
import { attrsOf, childrenOf, escapeXmlAttr, nameOf, serializeXNode, type XNode } from './xml-utils'

/** wrapper element -> the child that holds its own properties (not content) */
const WRAPPER_PROPS: Readonly<Record<string, string | undefined>> = {
  'w:sdt': undefined,
  'w:smartTag': 'w:smartTagPr',
  'w:customXml': 'w:customXmlPr',
  'w:dir': undefined,
  'w:bdo': undefined,
}

export function isInlineWrapper(name: string): boolean {
  return Object.hasOwn(WRAPPER_PROPS, name)
}

/**
 * Text-less run-level elements kept verbatim at their position (CT_P /
 * EG_RunLevelElements members the model has no field for). Anything else the
 * run walk does not know stays out of the model, as it always did: bookmarks
 * and comment ranges are kept on the block, move ranges are rebuilt from the
 * move's name, proofing marks are Word's to recompute, and the property
 * children of a container the walk descends into (m:oMathParaPr, w:fldData)
 * are not paragraph content.
 */
export const INLINE_KEPT_ELEMENTS: ReadonlySet<string> = new Set([
  'w:permStart',
  'w:permEnd',
  'w:customXmlInsRangeStart',
  'w:customXmlInsRangeEnd',
  'w:customXmlDelRangeStart',
  'w:customXmlDelRangeEnd',
  'w:customXmlMoveFromRangeStart',
  'w:customXmlMoveFromRangeEnd',
  'w:customXmlMoveToRangeStart',
  'w:customXmlMoveToRangeEnd',
  'w:subDoc',
])

/**
 * Content that keeps a wrapper from being carried whole as one element: runs
 * and run containers (the model reads them, so the whole element would write
 * them a second time) and the markers a rebuilt block emits on its own.
 */
const NOT_WHOLE: ReadonlySet<string> = new Set([
  'w:r',
  'w:hyperlink',
  'w:fldSimple',
  'm:oMath',
  'm:oMathPara',
  'w:bookmarkStart',
  'w:bookmarkEnd',
  'w:commentRangeStart',
  'w:commentRangeEnd',
])

/** the wrapper holds nothing the model reads or re-emits: it can ride as one element */
export function inlineWrapperIsBare(node: XNode): boolean {
  // explicit stack: a cell paragraph of a hostile table can nest very deep
  const todo = [...childrenOf(node)]
  for (let next = todo.pop(); next; next = todo.pop()) {
    const name = nameOf(next)
    if (name === undefined) continue
    if (NOT_WHOLE.has(name)) return false
    todo.push(...childrenOf(next))
  }
  return true
}

/** one element of the scanned xml: the byte ranges of its tags and its element children */
interface RawElement {
  name: string
  start: number
  /** end of the opening tag */
  openEnd: number
  /** start of the closing tag (= end for a self-closing element) */
  closeStart: number
  end: number
  selfClosing: boolean
  children: RawElement[]
}

function rawElements(xml: string): RawElement[] {
  // comments, CDATA and processing instructions can hide tag-like text; the
  // parse tree drops them, so the two would not line up
  if (xml.includes('<!') || xml.includes('<?')) return []
  const roots: RawElement[] = []
  const stack: RawElement[] = []
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    const end = m.index + m[0].length
    if (m[1] === '/') {
      const el = stack.pop()
      if (!el || el.name !== m[2]) return []
      el.closeStart = m.index
      el.end = end
      continue
    }
    const selfClosing = m[3].endsWith('/')
    const el: RawElement = {
      name: m[2],
      start: m.index,
      openEnd: end,
      closeStart: end,
      end,
      selfClosing,
      children: [],
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else roots.push(el)
    if (!selfClosing) stack.push(el)
  }
  return stack.length === 0 ? roots : []
}

const elementChildren = (node: XNode): XNode[] =>
  childrenOf(node).filter((c) => nameOf(c) !== undefined)

/**
 * The source text a parse tree came from, with the byte range of each of its
 * elements. Wrapper and marker bytes are sliced from it; without one (or for
 * an element that does not line up with the text) the serialized parse tree
 * stands in, which keeps the meaning but not the exact bytes.
 */
export interface InlineRawSource {
  readonly xml: string
  of(node: XNode): RawElement | undefined
}

/** `root` is the element of that name at the top level of `xml`; pairing runs on first use */
export function inlineRawSource(xml: string, root: XNode): InlineRawSource {
  let paired: Map<XNode, RawElement> | null = null
  const pair = (): Map<XNode, RawElement> => {
    const out = new Map<XNode, RawElement>()
    const rootName = nameOf(root)
    const rawRoot = rawElements(xml).find((el) => el.name === rootName)
    if (!rawRoot) return out
    // explicit stack: table sources nest far deeper than a call stack allows
    const todo: Array<[XNode, RawElement]> = [[root, rawRoot]]
    for (let next = todo.pop(); next; next = todo.pop()) {
      const [node, raw] = next
      out.set(node, raw)
      const kids = elementChildren(node)
      // children that do not line up stay unpaired, with everything below them
      if (kids.length !== raw.children.length) continue
      kids.forEach((kid, i) => {
        if (nameOf(kid) === raw.children[i].name) todo.push([kid, raw.children[i]])
      })
    }
    return out
  }
  return {
    xml,
    of: (node) => (paired ??= pair()).get(node),
  }
}

const openTagXml = (node: XNode): string =>
  `<${nameOf(node)}${Object.entries(attrsOf(node))
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(String(v))}"`)
    .join('')}>`

/** the element's own bytes when its range is known, else the serialized parse tree */
export function inlineElementXml(node: XNode, source: InlineRawSource | undefined): string {
  const raw = source?.of(node)
  return source && raw ? source.xml.slice(raw.start, raw.end) : serializeXNode(node)
}

/**
 * A wrapper element split around its run content: the bytes before and after
 * it, and the content nodes. Null when the wrapper has nowhere to hold runs
 * (a w:sdt without w:sdtContent, a self-closing wrapper).
 */
export function inlineWrapperShell(
  node: XNode,
  source: InlineRawSource | undefined,
): { open: string; close: string; content: XNode[] } | null {
  const name = nameOf(node)
  if (!name) return null
  const kids = elementChildren(node)
  const raw = source?.of(node)
  const rawKids = raw && raw.children.length === kids.length ? raw.children : null
  if (name === 'w:sdt') {
    const at = kids.findIndex((k) => nameOf(k) === 'w:sdtContent')
    if (at < 0) return null
    const content = childrenOf(kids[at])
    const rawContent = rawKids?.[at]
    if (source && raw && rawContent?.name === 'w:sdtContent') {
      if (rawContent.selfClosing) return null
      return {
        open: source.xml.slice(raw.start, rawContent.openEnd),
        close: source.xml.slice(rawContent.closeStart, raw.end),
        content,
      }
    }
    if (content.length === 0) return null
    return {
      open:
        openTagXml(node) + kids.slice(0, at).map(serializeXNode).join('') + openTagXml(kids[at]),
      close:
        '</w:sdtContent>' +
        kids
          .slice(at + 1)
          .map(serializeXNode)
          .join('') +
        '</w:sdt>',
      content,
    }
  }
  const propsName = WRAPPER_PROPS[name]
  const props = propsName !== undefined && nameOf(kids[0] ?? {}) === propsName ? kids[0] : undefined
  const content = childrenOf(node).filter((c) => c !== props)
  if (source && raw) {
    if (raw.selfClosing) return null
    const rawProps = props ? rawKids?.[0] : undefined
    if (!props || rawProps) {
      return {
        open: source.xml.slice(raw.start, rawProps ? rawProps.end : raw.openEnd),
        close: source.xml.slice(raw.closeStart, raw.end),
        content,
      }
    }
  }
  if (content.length === 0) return null
  return {
    open: openTagXml(node) + (props ? serializeXNode(props) : ''),
    close: `</${name}>`,
    content,
  }
}

/** two runs sit in the same wrapper element */
export function sameInlineWrap(a: InlineWrap | undefined, b: InlineWrap | undefined): boolean {
  if (!a || !b) return a === b
  return a.seq === b.seq && a.open === b.open && a.close === b.close
}

/** two runs sit in the same chain of wrapper elements */
export function sameInlineWrapChain(
  a: readonly InlineWrap[] | undefined,
  b: readonly InlineWrap[] | undefined,
): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((w, i) => sameInlineWrap(w, y[i]))
}

const isContentControl = (wrap: InlineWrap): boolean => /^<w:sdt[\s>]/.test(wrap.open)

/**
 * The wrapper is a content control whose content may not be edited
 * (w:lock contentLocked / sdtContentLocked in its own w:sdtPr).
 */
export function inlineWrapContentLocked(wrap: InlineWrap): boolean {
  if (!isContentControl(wrap)) return false
  const lock = /<w:lock\b[^>]*\bw:val\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(wrap.open)
  const val = lock?.[1] ?? lock?.[2]
  return val === 'contentLocked' || val === 'sdtContentLocked'
}

/**
 * The wrapper may be written once only: a content control carries a w:id (and
 * often a data binding), and two elements from one original would repeat it.
 * The other wrappers hold no identity, so a second group of their runs keeps
 * its own copy of the element (dropping w:bdo / w:dir would flip the text).
 */
export const inlineWrapWritesOnce = isContentControl

// ---- a control whose properties are tied to its text (C3) ----

/** w:sdtPr children that only hold while the control shows the text it was read with */
const TEXT_BOUND_SDT_PROPS = ['w:showingPlcHdr', 'w:dataBinding', 'w15:dataBinding']
const TEXT_BOUND_RE = new RegExp(`<(?:${TEXT_BOUND_SDT_PROPS.join('|')})[\\s/>]`)
/** each of them as a whole element: self-closing, or an open tag with its close */
const TEXT_BOUND_ELEMENT_RE = new RegExp(
  TEXT_BOUND_SDT_PROPS.map((name) => {
    const open = `<${name}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*`
    return `${open}/>|${open}>\\s*</${name}>`
  }).join('|'),
  'g',
)

/** the opening bytes are a content control with a placeholder flag or a data binding */
export function sdtFollowsItsText(open: string): boolean {
  return /^<w:sdt[\s>]/.test(open) && TEXT_BOUND_RE.test(open)
}

/**
 * The text a control's text-bound properties are compared by: what a reader
 * sees with pending deletions gone. Note markers are display numbers, not
 * content (adding a footnote elsewhere renumbers them).
 */
export function inlineWrapTextOf(runs: readonly Run[], from = 0, to = runs.length): string {
  let text = ''
  for (let i = from; i < to; i++) {
    const run = runs[i]
    if (!run.del && !run.noteRef) text += run.text
  }
  return text
}

/**
 * A control's opening bytes for text that is no longer the text it was read
 * with: w:showingPlcHdr goes (Word would treat the new text as placeholder
 * text) and so does the data binding (Word would overwrite the new text from
 * the bound store on open). Nothing else in w:sdtPr changes.
 */
export function sdtOpenForChangedText(open: string): string {
  return open.replace(TEXT_BOUND_ELEMENT_RE, '')
}

// ---- where a rebuilt paragraph writes each wrapper ----

/** the wrappers of one run by the depth they are written at: outside its
 *  revision element, inside it (outside the hyperlink), inside the hyperlink */
export type PlacedWraps = [InlineWrap[], InlineWrap[], InlineWrap[]]

const nominalLevel = (wrap: InlineWrap): number =>
  wrap.inside === 'link' ? 2 : wrap.inside === 'revision' ? 1 : 0

/**
 * The depth each wrapper of each run is written at, null when no run sits in
 * a wrapper. A wrapper goes back where it was read (InlineWrap.inside) as
 * long as the runs it holds still share that revision element / hyperlink;
 * runs that no longer do keep the wrapper around all of them, one level out.
 * A hyperlink that grew past a wrapper takes the wrapper inside it instead of
 * being cut in two at the wrapper's edge.
 *
 * `revKeyOf` is the generator's grouping key for tracked-change elements.
 */
export function placeInlineWraps(
  runs: readonly Run[],
  revKeyOf: (run: Run) => string,
): PlacedWraps[] | null {
  let maxDepth = 0
  for (const run of runs) maxDepth = Math.max(maxDepth, run.wrap?.length ?? 0)
  if (maxDepth === 0) return null
  const n = runs.length
  const rev = runs.map(revKeyOf)
  // hyperlink groups as the generator forms them inside one revision group
  const linkGroup = new Array<number>(n).fill(-1)
  let groups = 0
  for (let i = 0; i < n;) {
    const link = runs[i].link
    if (!link) {
      i++
      continue
    }
    const start = i
    let rId = link.rId
    while (i < n && rev[i] === rev[start] && runs[i].link?.href === link.href) {
      const next = runs[i].link!.rId
      if (i > start && next !== undefined && rId !== undefined && next !== rId) break
      rId = rId ?? next
      linkGroup[i] = groups
      i++
    }
    groups++
  }
  const level = runs.map((run) => new Array<number>(run.wrap?.length ?? 0).fill(0))
  for (let d = 0; d < maxDepth; d++) {
    let a = 0
    while (a < n) {
      const chain = runs[a].wrap
      if (!chain || chain.length <= d) {
        a++
        continue
      }
      // [a, b): the adjacent runs that sit in this element
      let b = a + 1
      while (b < n && sharesWrapPrefix(runs[b].wrap, chain, d)) b++
      let oneRev = true
      let oneLink = linkGroup[a] !== -1
      for (let i = a + 1; i < b; i++) {
        if (rev[i] !== rev[a]) oneRev = false
        if (linkGroup[i] !== linkGroup[a]) oneLink = false
      }
      let lvl = nominalLevel(chain[d])
      if (!oneRev) lvl = 0
      else if (!oneLink) lvl = Math.min(lvl, 1)
      else if (
        lvl < 2 &&
        (lvl === 1 || rev[a] === '') &&
        (linkGroup[a - 1] === linkGroup[a] || linkGroup[b] === linkGroup[a])
      ) {
        lvl = 2
      }
      // never outside the wrapper that holds it
      if (d > 0) lvl = Math.max(lvl, level[a][d - 1])
      for (let i = a; i < b; i++) level[i][d] = lvl
      a = b
    }
  }
  return runs.map((run, i) => {
    const placed: PlacedWraps = [[], [], []]
    run.wrap?.forEach((wrap, d) => placed[level[i][d]].push(wrap))
    return placed
  })
}

function sharesWrapPrefix(
  chain: readonly InlineWrap[] | undefined,
  other: readonly InlineWrap[],
  depth: number,
): boolean {
  if (!chain || chain.length <= depth) return false
  for (let k = 0; k <= depth; k++) if (!sameInlineWrap(chain[k], other[k])) return false
  return true
}

// ---- runs copied out of their paragraph ----

/**
 * A run as it goes into ANOTHER paragraph or document (a mail-merge record
 * after the first, the other side of a comparison): content controls and kept
 * elements carry ids that belong to the original, so the copy goes without
 * them. Null for a run that is nothing but a kept element.
 */
export function runCopiedElsewhere(run: Run): Run | null {
  if (run.opaqueXml !== undefined) return null
  if (!run.wrap?.some(isContentControl)) return run
  const { wrap, ...rest } = run
  const kept = wrap.filter((w) => !isContentControl(w))
  return kept.length > 0 ? { ...rest, wrap: kept } : rest
}
