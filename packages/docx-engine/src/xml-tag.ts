/**
 * Start tags read with their attribute values in mind. XML allows `>` inside
 * a quoted attribute value (a namespace URI, a name, a note from another
 * producer), so a start tag read with `<name[^>]*>` stops inside the value: a
 * part rewritten from that cut tag is not well-formed.
 */

import { maskOpaque } from './xml-utils'

export interface StartTag {
  start: number
  /** just past the tag's own closing `>` */
  end: number
  text: string
  selfClosing: boolean
}

const NAME_CHAR = /[\w.:-]/

/**
 * The first start tag at or after `from` whose qualified name is `name` (or
 * matches it, a RegExp tested against the whole name; no name = any element),
 * read through its quoted attribute values to its own `>`.
 */
export function findStartTag(xml: string, name?: string | RegExp, from = 0): StartTag | null {
  for (let lt = xml.indexOf('<', from); lt !== -1; lt = xml.indexOf('<', lt + 1)) {
    let i = lt + 1
    while (i < xml.length && NAME_CHAR.test(xml[i]!)) i++
    const tagName = xml.slice(lt + 1, i)
    if (!tagName || !/^[A-Za-z_]/.test(tagName)) continue
    if (name !== undefined && (typeof name === 'string' ? tagName !== name : !name.test(tagName)))
      continue
    // a name must end at white space, `/` or `>`; `<w:hdrX` is another element
    if (i < xml.length && !/[\s/>]/.test(xml[i]!)) continue
    for (let quote = ''; i < xml.length; i++) {
      const c = xml[i]!
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') {
        const end = i + 1
        return { start: lt, end, text: xml.slice(lt, end), selfClosing: xml[i - 1] === '/' }
      }
    }
    return null
  }
  return null
}

/**
 * `xml` without the elements named `name`: a self-closing one is one element,
 * a paired one runs to its own close tag (the element must not nest itself,
 * as no property-change record does). A close tag may hold white space before
 * its > (`</w:pPrChange >`), as XML allows. `limit` stops after that many.
 */
export function removeElements(xml: string, name: string, limit = Infinity): string {
  const close = new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'g')
  let out = xml
  let from = 0
  for (let n = 0; n < limit; n++) {
    const tag = findStartTag(out, name, from)
    if (!tag) break
    let end = tag.end
    if (!tag.selfClosing) {
      close.lastIndex = tag.end
      const found = close.exec(out)
      if (!found) break
      end = found.index + found[0].length
    }
    out = out.slice(0, tag.start) + out.slice(end)
    from = tag.start
  }
  return out
}

/** the index of the `>` that ends the start tag whose name ends at `from`, read through quoted attribute values; -1 when it never ends */
function startTagEnd(xml: string, from: number): number {
  for (let quote = '', i = from; i < xml.length; i++) {
    const c = xml[i]!
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/**
 * What an element holds: its XML between its start tag and its end tag (the
 * last one in `xml`, which is the element's own). '' for a self-closing element.
 */
export function elementInner(xml: string): string {
  const masked = maskOpaque(xml)
  const open = findStartTag(masked)
  if (!open || open.selfClosing) return ''
  const close = masked.lastIndexOf('</')
  return close < open.end ? '' : xml.slice(open.end, close)
}

/**
 * Top-level segments of `tag` between [from, to), depth-aware for nesting.
 * Tags are read the way an XML parser reads them: markup inside a comment, a
 * CDATA section or a processing instruction is no tag, a `>` inside a quoted
 * attribute value does not end the tag, and an end tag may hold white space
 * before its `>`.
 */
export function xmlSegments(
  xml: string,
  tag: string,
  from: number,
  to: number,
): Array<{ start: number; end: number }> {
  const masked = maskOpaque(xml)
  const name = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // an open tag's name ends at white space, `/` or `>` (`w:tr` is not `w:trPr`)
  const tags = new RegExp(`<${name}(?=[\\s/>])|</${name}\\s*>`, 'g')
  tags.lastIndex = from
  const segs: Array<{ start: number; end: number }> = []
  let depth = 0
  let segStart = -1
  for (let m = tags.exec(masked); m !== null && m.index < to; m = tags.exec(masked)) {
    if (m[0].startsWith('</')) {
      if (depth === 0) break
      depth--
      if (depth === 0) segs.push({ start: segStart, end: m.index + m[0].length })
      continue
    }
    const gt = startTagEnd(masked, m.index + m[0].length)
    if (gt === -1) break
    tags.lastIndex = gt + 1
    // a trailing self-closing element (Word's empty <w:p/>) has no close tag after it
    if (masked.charAt(gt - 1) === '/') {
      if (depth === 0) segs.push({ start: m.index, end: gt + 1 })
      continue
    }
    if (depth === 0) segStart = m.index
    depth++
  }
  return segs
}

/**
 * `xml` with each top-level `tag` element (to its own end tag, nested ones
 * inside it) replaced by `replace(element)`; `replace` returns '' to drop it.
 * The elements are found as xmlSegments finds them.
 */
export function replaceSegments(
  xml: string,
  tag: string,
  replace: (element: string) => string,
): string {
  let out = ''
  let cursor = 0
  for (const seg of xmlSegments(xml, tag, 0, xml.length)) {
    out += xml.slice(cursor, seg.start) + replace(xml.slice(seg.start, seg.end))
    cursor = seg.end
  }
  return cursor === 0 ? xml : out + xml.slice(cursor)
}

/** `xml` without its top-level `tag` elements */
export function removeSegments(xml: string, tag: string): string {
  return replaceSegments(xml, tag, () => '')
}
