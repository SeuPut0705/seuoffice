// The steps the Rust readers leave to the host (crates/seu-host), answered in
// callback slot 0 of each call: `{ name, input }` in, `{ ok }` or
// `{ error: { name, message } }` out. They are what a JavaScript library gives
// and Rust does not have: parse5's tree of an HTML page, the draw.io readers,
// and epub-engine's HTML reading. Trees cross flat (elements in document order,
// a child naming its place), so no nesting reaches JSON, which the engine reads
// to 128 levels.
import { parse, parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5'
import { parseHtml, type XmlElement } from '@seuoffice/epub-engine/core'
import { diagramFormatOf, readDiagramText } from './diagram'

interface SourceElement {
  node: T.Element
  startTag: [number, number]
  /** content between the start tag and the end tag (or the implied end) */
  inner: [number, number]
}

function isElement(node: T.Node): node is T.Element {
  return 'tagName' in node && typeof (node as T.Element).tagName === 'string'
}

/**
 * Elements with a source location, in document order, deduped by start-tag
 * offset (the adoption agency re-creates formatting elements that share one
 * start tag). An explicit stack rather than recursion: a hostile page nests
 * deeper than the call stack. Template contents are walked too.
 */
export function sourceElements(source: string): SourceElement[] {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const out: SourceElement[] = []
  const seen = new Set<number>()
  const stack: T.Node[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isElement(node)) {
      const loc = node.sourceCodeLocation
      if (loc?.startTag && !seen.has(loc.startTag.startOffset)) {
        seen.add(loc.startTag.startOffset)
        const startTag: [number, number] = [loc.startTag.startOffset, loc.startTag.endOffset]
        const innerEnd = loc.endTag ? loc.endTag.startOffset : Math.max(startTag[1], loc.endOffset)
        out.push({ node, startTag, inner: [startTag[1], innerEnd] })
      }
    }
    const children: T.Node[] = 'childNodes' in node ? [...node.childNodes] : []
    if (isElement(node) && node.tagName === 'template') {
      const content = (node as T.Template).content
      if (content) children.push(...content.childNodes)
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return out
}

type FlatChild = string | { element: number }

type TextNode =
  { kind: 'element'; name: string; children: TextNode[] } | { kind: 'text'; value: string }

interface Parse5Node {
  nodeName: string
  value?: string
  childNodes?: Parse5Node[]
  content?: Parse5Node
}

function fromParse5(node: Parse5Node): TextNode | null {
  if (node.nodeName === '#text') return { kind: 'text', value: node.value ?? '' }
  if (node.nodeName.startsWith('#')) return null
  return {
    kind: 'element',
    name: node.nodeName,
    children: (node.childNodes ?? []).map(fromParse5).filter((n): n is TextNode => n !== null),
  }
}

/** A string field of a step's input; a step given another shape throws. */
function stringField(input: unknown, key: string): string {
  const value =
    input !== null && typeof input === 'object' && key in input
      ? (input as Record<string, unknown>)[key]
      : undefined
  if (typeof value !== 'string') throw new TypeError(`host step input has no string ${key}`)
  return value
}

/** `epub.parseHtml`: the tree epub-engine's `parseHtml` builds, written flat. */
function parseHtmlFlat(input: unknown): unknown {
  const root = parseHtml(stringField(input, 'text'))
  const ids = new Map<XmlElement, number>()
  const order: XmlElement[] = []
  const stack: XmlElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()!
    ids.set(element, order.length)
    order.push(element)
    for (let i = element.children.length - 1; i >= 0; i--) {
      const child = element.children[i]!
      if (typeof child !== 'string') stack.push(child)
    }
  }
  return {
    elements: order.map((element) => ({
      name: element.name,
      local: element.local,
      uri: element.uri,
      attributes: element.attributes,
      children: element.children.map((child): FlatChild =>
        typeof child === 'string' ? child : { element: ids.get(child)! },
      ),
    })),
  }
}

/** `epub.parseFragmentText`: the text of the first node parse5 reads in `html`, or null. */
function parseFragmentText(input: unknown): unknown {
  const ref = stringField(input, 'html')
  {
    // the lines of xml-positions.ts that ask parse5
    const fragment = parseFragment(ref)
    const node = fragment.childNodes[0] as { nodeName: string; value?: string } | undefined
    const decoded = node?.nodeName === '#text' ? node.value : undefined
    return decoded ?? null
  }
}

/** `epub.chapterTextRoots`: the roots of a chapter that is not XML, as parse5 reads it, written flat. */
function chapterTextRoots(input: unknown): unknown {
  const source = stringField(input, 'text')
  let roots: TextNode[]
  {
    // the two lines of text.ts that read a chapter that is not XML
    const doc = parse(source) as unknown as Parse5Node
    roots = (doc.childNodes ?? []).map(fromParse5).filter((n): n is TextNode => n !== null)
  }
  const ids = new Map<TextNode, number>()
  const order: Array<Extract<TextNode, { kind: 'element' }>> = []
  const stack: TextNode[] = [...roots].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.kind !== 'element') continue
    ids.set(node, order.length)
    order.push(node)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!)
  }
  const child = (node: TextNode): FlatChild =>
    node.kind === 'text' ? node.value : { element: ids.get(node)! }
  return {
    elements: order.map((element) => ({
      name: element.name,
      children: element.children.map(child),
    })),
    roots: roots.map(child),
  }
}

/** Every host step, by the name the Rust readers call it. */
export const HOST_STEPS: Readonly<Record<string, (input: unknown) => unknown>> = {
  'fileparse.htmlSourceElements': (input) =>
    sourceElements(stringField(input, 'source')).map((e) => ({
      tagName: e.node.tagName,
      attrs: e.node.attrs.map((attr) => ({ name: attr.name, value: attr.value })),
      startTag: e.startTag,
      inner: e.inner,
    })),
  'fileparse.diagramFormatOf': (input) => diagramFormatOf(stringField(input, 'filePath')),
  'fileparse.readDiagramText': (input) =>
    readDiagramText(
      stringField(input, 'fileName'),
      new Uint8Array(Buffer.from(stringField(input, 'bytesBase64'), 'base64')),
    ),
  // the host's zone east of UTC, in seconds, at an instant: the HWP reader writes memo dates in
  // local time, as Hangul does, and WASI has no zone
  'fileparse.localOffsetSeconds': (input) => {
    const ms =
      input !== null && typeof input === 'object' && 'ms' in input ? Number(input.ms) : Number.NaN
    if (!Number.isFinite(ms)) throw new TypeError('host step input has no number ms')
    return -new Date(ms).getTimezoneOffset() * 60
  },
  'epub.parseHtml': parseHtmlFlat,
  'epub.parseFragmentText': parseFragmentText,
  'epub.chapterTextRoots': chapterTextRoots,
}

/** The answer of one step: what it returned, or what it threw. */
export function runHostStep(
  steps: Readonly<Record<string, (input: unknown) => unknown>>,
  request: string,
): string {
  let answer: unknown
  try {
    const { name, input } = JSON.parse(request) as { name: string; input: unknown }
    const step = steps[name]
    if (step === undefined) {
      throw Object.assign(new Error(`no host step ${name}`), { name: 'HostUnavailable' })
    }
    answer = { ok: step(input) ?? null }
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error))
    answer = { error: { name: thrown.name, message: thrown.message } }
  }
  return JSON.stringify(answer)
}

/** Callback slot 0 of a call into the engine. */
export function hostStep(request: string): string {
  return runHostStep(HOST_STEPS, request)
}
