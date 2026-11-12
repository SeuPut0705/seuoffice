// Run-level wrapper elements the run model has no field for (w:sdt,
// w:smartTag, w:customXml, w:dir, w:bdo). The bytes of a wrapper that holds
// runs ride on those runs (Run.wrap), opaque to the model, so a rebuilt
// paragraph writes the wrapper back around them. A wrapper that holds no run
// and the text-less markers of a paragraph (w:permStart, the customXml range
// markers, w:subDoc) are not carried: bookmarks and comment ranges are kept on
// the block, move ranges are rebuilt from the move's name, proofing marks are
// Word's to recompute, and the rest stays out of the model as it always did.
import { decodeEntities } from './parse-xml-text'
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

// ---- which bytes may be carried: one strict, positive check ----
//
// The same check decides what the parser puts on a run and what the writer
// takes from one. A run list can come from a co-editing peer, so the writer
// cannot assume the parser made it; and what the parser carries must be
// writable, so it never carries bytes the writer would refuse.

/** prefix -> namespace URI, as the root element of a part declares them */
export type PartNamespaces = ReadonlyMap<string, string>

const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
/** Word's own extension namespaces: w14, w15, w16cid, w16sdtdh... */
const EXTENSION_PREFIX_RE = /^w1[4-9][a-z]*$/
const EXTENSION_NAMESPACE_START = 'http://schemas.microsoft.com/office/word/'
/** nesting inside one carried element; real controls sit a few levels deep */
const MAX_CARRIED_DEPTH = 32
/**
 * Opening and closing bytes of one wrapper together, in UTF-16 code units.
 * Checked before anything scans them, so the scan never meets an element
 * with more children than a call may spread (the shortest element is four
 * code units: about 16,000 of them fit).
 */
const MAX_WRAP_LENGTH = 65536

/** the namespace declarations on the root element of a part */
export function partNamespaces(partXml: string): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  // the declaration, comments and a doctype may come before the root element
  for (;;) {
    while (at < partXml.length && /[\s\uFEFF]/.test(partXml[at])) at++
    const closer = partXml.startsWith('<?', at)
      ? '?>'
      : partXml.startsWith('<!--', at)
        ? '-->'
        : partXml.startsWith('<!', at)
          ? '>'
          : null
    if (closer === null) break
    const end = partXml.indexOf(closer, at)
    if (end < 0) return out
    at = end + closer.length
  }
  const rootRe = /<[A-Za-z_][\w:.-]*((?:"[^"]*"|'[^']*'|[^"'>])*)>/y
  rootRe.lastIndex = at
  const root = rootRe.exec(partXml)
  if (!root) return out
  // each match takes a whole attribute, so text inside a value is never read as one
  for (const attr of root[1].matchAll(/\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (attr[1].startsWith('xmlns:'))
      out.set(attr[1].slice(6), decodeEntities(attr[2] ?? attr[3] ?? ''))
  }
  return out
}

/** element of strictly scanned bytes: names only, text and attributes are checked while scanning */
interface CarriedElement {
  name: string
  children: CarriedElement[]
}

interface CarriedScan {
  root: CarriedElement
  /** the element the runs go into (a wrapper split around its content), with its children before them */
  holder?: { element: CarriedElement; before: number }
  /** prefixes the bytes use without declaring them: the part root has to */
  outer: ReadonlySet<string>
}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y
const REFERENCE_RE = /&(?:lt|gt|amp|quot|apos|#([0-9]{1,8})|#x([0-9A-Fa-f]{1,7}));/y

const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff)

/** an attribute value as XML allows it: no `<`, only real references, only XML characters */
function validAttributeValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[<\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(value)) return false
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))
    return false
  for (let at = value.indexOf('&'); at >= 0; at = value.indexOf('&', at + 1)) {
    REFERENCE_RE.lastIndex = at
    const ref = REFERENCE_RE.exec(value)
    if (!ref) return false
    const digits = ref[1] ?? ref[2]
    if (digits !== undefined && !isXmlChar(parseInt(digits, ref[1] !== undefined ? 10 : 16)))
      return false
  }
  return true
}

const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x9 || code === 0xa || code === 0xd

/**
 * Strict scan of carried bytes. They may hold tags and white space, nothing
 * else: no text, comment, CDATA, processing instruction or doctype. Every
 * tag has to be well-formed (names, quoting, one of each attribute, attribute
 * values as XML allows them) and a namespace declared inside the bytes has to
 * be the w namespace itself or one of Word's extension namespaces. The two
 * segments are a wrapper split around its content.
 */
function scanCarried(segments: readonly string[]): CarriedScan | null {
  const roots: CarriedElement[] = []
  const stack: Array<{ element: CarriedElement; declared: string[] }> = []
  const active = new Map<string, number>()
  const outer = new Set<string>()
  let holder: CarriedScan['holder']
  for (let s = 0; s < segments.length; s++) {
    const xml = segments[s]
    const n = xml.length
    let i = 0
    const skipSpace = () => {
      while (i < n && isSpace(xml.charCodeAt(i))) i++
    }
    while (i < n) {
      if (isSpace(xml.charCodeAt(i))) {
        i++
        continue
      }
      if (xml.charCodeAt(i) !== 0x3c) return null
      i++
      const closing = xml.charCodeAt(i) === 0x2f
      if (closing) i++
      NAME_RE.lastIndex = i
      const name = NAME_RE.exec(xml)?.[0]
      if (name === undefined) return null
      i += name.length
      if (closing) {
        skipSpace()
        if (xml.charCodeAt(i) !== 0x3e) return null
        i++
        const top = stack.pop()
        if (!top || top.element.name !== name) return null
        for (const prefix of top.declared) active.set(prefix, active.get(prefix)! - 1)
        continue
      }
      const colon = name.indexOf(':')
      if (colon < 0) return null
      const used = [name.slice(0, colon)]
      const declared: string[] = []
      const seen = new Set<string>()
      let selfClosing = false
      for (;;) {
        const before = i
        skipSpace()
        const next = xml.charCodeAt(i)
        if (next === 0x3e) {
          i++
          break
        }
        if (next === 0x2f) {
          if (xml.charCodeAt(i + 1) !== 0x3e) return null
          i += 2
          selfClosing = true
          break
        }
        if (i === before) return null
        NAME_RE.lastIndex = i
        const attr = NAME_RE.exec(xml)?.[0]
        if (attr === undefined || seen.has(attr)) return null
        seen.add(attr)
        i += attr.length
        skipSpace()
        if (xml.charCodeAt(i) !== 0x3d) return null
        i++
        skipSpace()
        const quote = xml[i]
        if (quote !== '"' && quote !== "'") return null
        const end = xml.indexOf(quote, i + 1)
        if (end < 0) return null
        const value = xml.slice(i + 1, end)
        i = end + 1
        if (!validAttributeValue(value)) return null
        if (attr === 'xmlns') return null
        if (attr.startsWith('xmlns:')) {
          const prefix = attr.slice(6)
          const allowed =
            prefix === 'w'
              ? value === W_NAMESPACE
              : EXTENSION_PREFIX_RE.test(prefix) && value.startsWith(EXTENSION_NAMESPACE_START)
          if (!allowed) return null
          declared.push(prefix)
        } else {
          const at = attr.indexOf(':')
          if (at >= 0 && !attr.startsWith('xml:')) used.push(attr.slice(0, at))
        }
      }
      for (const prefix of declared) active.set(prefix, (active.get(prefix) ?? 0) + 1)
      for (const prefix of used) if (!active.get(prefix)) outer.add(prefix)
      const element: CarriedElement = { name, children: [] }
      const parent = stack[stack.length - 1]
      if (parent) parent.element.children.push(element)
      else roots.push(element)
      if (selfClosing) {
        for (const prefix of declared) active.set(prefix, active.get(prefix)! - 1)
      } else {
        if (stack.length >= MAX_CARRIED_DEPTH) return null
        stack.push({ element, declared })
      }
    }
    if (s < segments.length - 1) {
      const top = stack[stack.length - 1]
      if (!top) return null
      holder = { element: top.element, before: top.element.children.length }
    }
  }
  if (stack.length > 0 || roots.length !== 1) return null
  return { root: roots[0], ...(holder ? { holder } : {}), outer }
}

/**
 * The w: elements that describe a wrapper (CT_SdtPr, CT_SdtEndPr,
 * CT_SmartTagPr, CT_CustomXmlPr and the run properties inside them). An
 * element of one of Word's extension namespaces may sit among them; nothing
 * that is document content (a run, a paragraph, a table, a section) may.
 */
const PROPERTY_NAMES: ReadonlySet<string> = new Set(
  (
    'alias tag id lock placeholder docPart temporary showingPlcHdr dataBinding label tabIndex ' +
    'equation comboBox listItem date dateFormat lid storeMappedDataAs calendar docPartObj ' +
    'docPartList docPartGallery docPartCategory docPartUnique dropDownList picture richText ' +
    'text citation group bibliography attr ' +
    'rPr rPrChange rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow ' +
    'emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs ' +
    'highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath'
  )
    .split(' ')
    .map((name) => `w:${name}`),
)

/** every element below `holder` describes the wrapper: nothing there is content */
function propertiesOnly(holder: CarriedElement): boolean {
  const todo = [...holder.children]
  for (let el = todo.pop(); el; el = todo.pop()) {
    if (!PROPERTY_NAMES.has(el.name) && !EXTENSION_PREFIX_RE.test(el.name.split(':')[0]))
      return false
    todo.push(...el.children)
  }
  return true
}

const declaredBy = (
  prefixes: ReadonlySet<string>,
  namespaces: PartNamespaces | undefined,
): boolean => namespaces === undefined || [...prefixes].every((prefix) => namespaces.has(prefix))

/** the value has the fields of an InlineWrap, each of its type */
function isInlineWrapShape(wrap: unknown): wrap is InlineWrap {
  if (typeof wrap !== 'object' || wrap === null) return false
  const { seq, open, close, inside, text } = wrap as Record<string, unknown>
  return (
    typeof seq === 'number' &&
    Number.isFinite(seq) &&
    typeof open === 'string' &&
    typeof close === 'string' &&
    (inside === undefined || inside === 'revision' || inside === 'link') &&
    (text === undefined || typeof text === 'string')
  )
}

/**
 * The prefixes a wrapper needs its part root to declare, null when it may not
 * be carried. It may when it is no larger than MAX_WRAP_LENGTH and is one
 * allowed wrapper element split where the parser splits it: around the
 * content of its one w:sdtContent (a control), or after its property element
 * (a smart tag, custom xml) or its own opening tag (w:dir, w:bdo), with
 * nothing but property elements beside the content.
 */
export function inlineWrapPrefixes(wrap: unknown): ReadonlySet<string> | null {
  if (!isInlineWrapShape(wrap)) return null
  if (wrap.open.length + wrap.close.length > MAX_WRAP_LENGTH) return null
  const scan = scanCarried([wrap.open, wrap.close])
  if (!scan?.holder) return null
  const { root, holder } = scan
  if (!isInlineWrapper(root.name)) return null
  if (root.name === 'w:sdt') {
    const ok =
      holder.element.name === 'w:sdtContent' &&
      holder.element.children.length === 0 &&
      root.children.includes(holder.element) &&
      root.children.every(
        (child) =>
          child === holder.element ||
          ((child.name === 'w:sdtPr' || child.name === 'w:sdtEndPr') && propertiesOnly(child)),
      )
    return ok ? scan.outer : null
  }
  const props = WRAPPER_PROPS[root.name]
  const ok =
    holder.element === root &&
    holder.before === root.children.length &&
    root.children.length <= (props === undefined ? 0 : 1) &&
    root.children.every((child) => child.name === props && propertiesOnly(child))
  return ok ? scan.outer : null
}

/** the wrapper may be carried in a part whose root declares `namespaces` (unknown: not judged) */
export function validInlineWrap(wrap: unknown, namespaces?: PartNamespaces): wrap is InlineWrap {
  const prefixes = inlineWrapPrefixes(wrap)
  return prefixes !== null && declaredBy(prefixes, namespaces)
}

/** one element of the scanned xml: the byte ranges of its tags and its element children */
export interface RawElement {
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

export function rawElements(xml: string, skipNonElements = false): RawElement[] {
  // Pairing a parse tree cannot skip these (its element children differ).
  // The save-time byte scanner may skip them without losing offsets.
  if (!skipNonElements && (xml.includes('<!') || xml.includes('<?'))) return []
  const roots: RawElement[] = []
  const stack: RawElement[] = []
  const tagRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    if (m[2] === undefined) continue
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
 * elements. Wrapper bytes are sliced from it; without one (or for
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
    // Only one content child may supply the visible runs. Anything else
    // readable must be walked, never hidden in the shell's original bytes.
    if (
      at < 0 ||
      kids.some((kid, i) => i !== at && nameOf(kid) !== 'w:sdtPr' && nameOf(kid) !== 'w:sdtEndPr')
    )
      return null
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

/** Stable across copied mark objects, scoped to one paragraph's writer. */
export const inlineWrapKey = (wrap: InlineWrap): string =>
  JSON.stringify([wrap.seq, wrap.open, wrap.close])

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
 * after the first, the other side of a comparison): a content control carries
 * an id that belongs to the original, so the copy goes without it.
 */
export function runCopiedElsewhere(run: Run): Run {
  if (!run.wrap?.some(isContentControl)) return run
  const { wrap, ...rest } = run
  const kept = wrap.filter((w) => !isContentControl(w))
  return kept.length > 0 ? { ...rest, wrap: kept } : rest
}
