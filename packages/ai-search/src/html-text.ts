/// HTML → readable text for the read_url tool. The page keeps its words and
/// loses everything a reader does not see: script, style, noscript, template
/// and svg are dropped whole; block elements end a line; links become
/// `[text](absolute address)` resolved against the address the page was
/// actually fetched from; images leave only their alt text.

import { parse, type DefaultTreeAdapterTypes as T } from 'parse5'

export interface HtmlText {
  /** `<title>`, else the first `<h1>`; absent when the page has neither */
  title?: string
  text: string
}

/** Subtrees that never carry page text. */
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg'])

/** Elements whose edges become line breaks. */
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

function isElement(node: T.Node): node is T.Element {
  return 'tagName' in node && typeof (node as T.Element).tagName === 'string'
}

function isTextNode(node: T.Node): node is T.TextNode {
  return 'value' in node && typeof (node as T.TextNode).value === 'string'
}

function attrOf(element: T.Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name.toLowerCase() === name)?.value
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ')
}

/** All visible text of a subtree, whitespace collapsed. */
function textOf(element: T.Element): string {
  const parts: string[] = []
  const stack: T.Node[] = [...element.childNodes].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isTextNode(node)) parts.push(node.value)
    else if (isElement(node) && !DROPPED.has(node.tagName)) {
      stack.push(...[...node.childNodes].reverse())
    }
  }
  return collapse(parts.join(' ')).trim()
}

/** An http(s) absolute address for a link, or undefined when it cannot be one. */
function resolveLink(href: string, baseUrl: string): string | undefined {
  try {
    const resolved = new URL(href, baseUrl)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : undefined
  } catch {
    return undefined
  }
}

/** One line per block: surrounding whitespace is trimmed and empty lines are dropped. */
function tidyLines(parts: string[]): string {
  return parts
    .join('')
    .split('\n')
    .map((line) => collapse(line).trim())
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The readable text of `html`, with relative links resolved against `baseUrl`
 * (the address the page was fetched from). Never throws: an unparsable page
 * comes back as whatever the parser could salvage.
 */
export function htmlToText(html: string, baseUrl: string): HtmlText {
  const document = parse(html)
  const out: string[] = []
  let title = ''
  let firstH1 = ''
  interface Frame {
    node: T.Node
    /** a closing marker: the element's own edge is applied on the way out */
    closing?: boolean
    tag?: string
    /** index in `out` where an `<a>`'s inner text begins */
    linkAt?: number
    href?: string
  }
  const stack: Frame[] = [...document.childNodes].reverse().map((node) => ({ node }) as Frame)
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.closing) {
      if (frame.tag === 'a') {
        const inner = out.splice(frame.linkAt!).join('').replace(/\s+/g, ' ').trim()
        const address = frame.href !== undefined ? resolveLink(frame.href, baseUrl) : undefined
        if (inner !== '') out.push(address !== undefined ? `[${inner}](${address})` : inner)
      } else if (frame.tag !== undefined && BLOCK.has(frame.tag)) {
        out.push('\n')
      }
      continue
    }
    const node = frame.node
    if (isTextNode(node)) {
      out.push(collapse(node.value))
      continue
    }
    if (!isElement(node)) continue
    const tag = node.tagName
    if (DROPPED.has(tag)) continue
    if (tag === 'title') {
      if (title === '') title = textOf(node)
      continue
    }
    if (tag === 'img') {
      const alt = collapse(attrOf(node, 'alt') ?? '').trim()
      if (alt !== '') out.push(alt)
      continue
    }
    if (tag === 'br') {
      out.push('\n')
      continue
    }
    if (tag === 'a') {
      const material: Frame = { node, closing: true, tag }
      material.linkAt = out.length
      const href = attrOf(node, 'href')
      if (href !== undefined) material.href = href
      stack.push(material)
    } else {
      if (BLOCK.has(tag)) out.push('\n')
      if (tag === 'h1' && firstH1 === '') firstH1 = textOf(node)
      stack.push({ node, closing: true, tag })
    }
    const children = [...node.childNodes]
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]! })
  }
  const text = tidyLines(out)
  const heading = firstH1 !== '' ? firstH1 : undefined
  return {
    ...(title !== '' ? { title } : heading !== undefined ? { title: heading } : {}),
    text,
  }
}
