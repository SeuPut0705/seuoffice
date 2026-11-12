/**
 * Start tags read with their attribute values in mind. XML allows `>` inside
 * a quoted attribute value (a namespace URI, a name, a note from another
 * producer), so a start tag read with `<name[^>]*>` stops inside the value: a
 * part rewritten from that cut tag is not well-formed.
 */

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
