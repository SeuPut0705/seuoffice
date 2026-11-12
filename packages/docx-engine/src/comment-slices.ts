import { decodeEntities } from './parse-xml-text'
import { maskOpaque } from './xml-utils'

/**
 * Each `<w:comment>` of a comments part with its id, read the way the parser
 * reads the tag (any quotes, white space around =, '>' inside a value): a
 * comment the save cannot find is written anew from its plain text, and loses
 * its runs, a hidden-from-AI mark included.
 */
export function commentEntries(xml: string): Array<{ id: string; xml: string }> {
  const out: Array<{ id: string; xml: string }> = []
  const open = /<w:comment\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  const endTag = /<\/w:comment\s*>/g
  // tags are found where comments and CDATA cannot fake one; bytes come from xml
  const masked = maskOpaque(xml)
  let m: RegExpExecArray | null
  while ((m = open.exec(masked)) !== null) {
    let close = open.lastIndex
    if (!m[2]) {
      endTag.lastIndex = open.lastIndex
      if (!endTag.exec(masked)) break
      close = endTag.lastIndex
    }
    const id = /(?:^|\s)w:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[1]!)
    const value = id ? (id[1] ?? id[2]) : undefined
    if (value) out.push({ id: decodeEntities(value), xml: xml.slice(m.index, close) })
    open.lastIndex = close
  }
  return out
}
