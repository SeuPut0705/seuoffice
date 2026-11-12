/**
 * Start tags read with their attribute values in mind. XML allows `>` inside
 * a quoted attribute value (a namespace URI, a name, a note from another
 * producer), so a start tag read with `<name[^>]*>` stops inside the value: a
 * part rewritten from that cut tag is not well-formed.
 */
import { invoke } from './engine'

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
/**
 * `xml` without the elements named `name`: a self-closing one is one element,
 * a paired one runs to its own close tag (the element must not nest itself,
 * as no property-change record does). A close tag may hold white space before
 * its > (`</w:pPrChange >`), as XML allows. `limit` stops after that many.
 */
export function removeElements(xml: string, name: string, limit = Infinity): string {
  return invoke('removeElements', [xml, name, Number.isFinite(limit) ? limit : null]) as never
}
