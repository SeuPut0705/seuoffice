/**
 * ISO Strict OOXML (purl.oclc.org URIs) and non-canonical namespace prefixes,
 * normalized to the transitional URIs + canonical prefixes that the rest of
 * the engine matches literally (`w:p`, `wps:wsp`, rel-type strings...). Runs
 * once per XML part at zip load, so parse offsets, patch splices and saved
 * output all see the same bytes.
 */
import { invoke } from './engine'

export function hasUniversalMeasures(xml: string): boolean {
  return invoke('hasUniversalMeasures', [xml]) as never
}
/** Cheap pre-check; normalizeOoxmlXml is only worth calling when this is true. */
export function needsOoxmlNormalization(xml: string): boolean {
  return invoke('needsOoxmlNormalization', [xml]) as never
}
/**
 * XML has more than one spelling for one document, and the engine finds most
 * of what it reads by pattern. For a reader that only reads (never keeps the
 * bytes, never counts offsets into the original), this is the text with the
 * spellings a pattern can't follow written the usual way:
 *   - comments and processing instructions (but the XML declaration) go,
 *     their text was never part of the document,
 *   - a CDATA section becomes the same text, escaped,
 *   - an end tag has no white space before its `>`,
 *   - a start tag's attributes are `name="value"`: double quotes, no white
 *     space around `=`, a `>` in a value written `&gt;`.
 * Text written the usual way (as Word writes it) comes back as it was. The
 * bytes the save writes back are never these: a part is not rewritten.
 */
const SYNTAX_TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?([\s\S]*?)\?>|<\/([^\s>]+)\s+>|<([A-Za-z_][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const PLAIN_ATTRS_RE = /^(?:\s+[^\s=/>"']+="[^"<>]*")*\s*\/?$/
const ANY_ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
export function canonicalXmlSyntax(xml: string): string {
  return xml.replace(
    SYNTAX_TOKEN_RE,
    (
      token: string,
      cdata: string | undefined,
      instruction: string | undefined,
      endName: string | undefined,
      startName: string | undefined,
      attrs: string | undefined,
    ) => {
      if (cdata !== undefined) {
        return cdata.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }
      if (instruction !== undefined) return /^xml\s/.test(instruction) ? token : ''
      if (endName !== undefined) return `</${endName}>`
      if (startName !== undefined && attrs !== undefined) {
        if (PLAIN_ATTRS_RE.test(attrs)) return token
        let out = `<${startName}`
        for (const m of attrs.matchAll(ANY_ATTR_RE)) {
          const value = (m[2] ?? (m[3] ?? '').replace(/"/g, '&quot;')).replace(/>/g, '&gt;')
          out += ` ${m[1]}="${value}"`
        }
        return out + (/\/\s*$/.test(attrs) ? '/>' : '>')
      }
      return '' // a comment
    },
  )
}
export function normalizeOoxmlXml(xml: string): string {
  return invoke('normalizeOoxmlXml', [xml]) as never
}
/** Cheap pre-check; dedupeStyleRefs is only worth calling when this is true. */
export function hasDuplicateStyleRefs(xml: string): boolean {
  return invoke('hasDuplicateStyleRefs', [xml]) as never
}
/**
 * Repeated w:pStyle / w:rStyle children of one property set: Word applies the
 * last one (invalid per schema, written by some Markdown converters as
 * `Heading1` + `MdHeading1`), so the earlier siblings are dropped here and
 * every reader, string or node based, sees the winner.
 */
export function dedupeStyleRefs(xml: string): string {
  return invoke('dedupeStyleRefs', [xml]) as never
}
