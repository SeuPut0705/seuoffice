// Host steps of epub-engine: what parse5 gives xml.ts, xml-positions.ts and text.ts.
//
// Each step answers what the TypeScript computes at its call site. Trees cross flat (the elements in document
// order, a child naming its place), so that no nesting reaches JSON, which the engine reads to 128 levels.
import { parse, parseFragment } from 'parse5'
import { parseHtml, type XmlElement } from '../../packages/epub-engine/src/xml'
import { EPUB_PURE_STEPS } from './host-steps-epub-pure'

type FlatChild = string | { element: number }

/**
 * The lines of `resolveHtmlEntity` (packages/epub-engine/src/xml-positions.ts) that ask parse5, copied as they are:
 * the gate (xml-cases.ts) fails when that file no longer holds this text.
 */
export const SOURCE_FRAGMENT_TEXT = String.raw`    const fragment = parseFragment(ref)
    const node = fragment.childNodes[0] as { nodeName: string; value?: string } | undefined
    const decoded = node?.nodeName === '#text' ? node.value : undefined
`

/**
 * What `extractChapterText` (packages/epub-engine/src/text.ts) builds from parse5's tree, copied as it is: the type of
 * the nodes, `fromParse5` and the two lines that make `roots` of it. The gate (xml-cases.ts) fails when that file no
 * longer holds this text.
 */
export const SOURCE_PARSE5_ROOTS_TEXT = String.raw`interface Parse5Node {
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
`
export const SOURCE_PARSE5_ROOTS_LINES = String.raw`    const doc = parse(source) as unknown as Parse5Node
    roots = (doc.childNodes ?? []).map(fromParse5).filter((n): n is TextNode => n !== null)
`

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

/** `epub.parseHtml`: the tree `parseHtml` of xml.ts builds, written flat. */
function parseHtmlFlat(input: unknown): unknown {
  // the gate's input is built by crates/epub-engine and carries exactly this
  const { text } = input as { text: string }
  const root = parseHtml(text)
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
    elements: order.map(element => ({
      name: element.name, local: element.local, uri: element.uri, attributes: element.attributes,
      children: element.children.map((child): FlatChild => (typeof child === 'string' ? child : { element: ids.get(child)! })),
    })),
  }
}

/** `epub.parseFragmentText`: the text of the first node parse5 reads in `html`, or null. */
function parseFragmentText(input: unknown): unknown {
  const { html: ref } = input as { html: string }
  const fragment = parseFragment(ref)
  const node = fragment.childNodes[0] as { nodeName: string; value?: string } | undefined
  const decoded = node?.nodeName === '#text' ? node.value : undefined
  return decoded ?? null
}

/** `epub.chapterTextRoots`: the `roots` `extractChapterText` reads a chapter that is not XML into, written flat. */
function chapterTextRoots(input: unknown): unknown {
  const { text: source } = input as { text: string }
  let roots: TextNode[]
  {
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
  const child = (node: TextNode): FlatChild => (node.kind === 'text' ? node.value : { element: ids.get(node)! })
  return {
    elements: order.map(element => ({ name: element.name, children: element.children.map(child) })),
    roots: roots.map(child),
  }
}

export const EPUB_STEPS: Record<string, (input: unknown) => unknown> = {
  ...EPUB_PURE_STEPS,
  'epub.parseHtml': parseHtmlFlat,
  'epub.parseFragmentText': parseFragmentText,
  'epub.chapterTextRoots': chapterTextRoots,
}
