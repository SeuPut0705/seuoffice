/** XML escaping utilities (same as docx-engine's, used for patch generation). */

/**
 * A fast-xml-parser element node: attributes are '@_'-prefixed, text is '#text',
 * child elements are nested nodes (a single child collapses to an object instead
 * of an array). Parse trees are inherently untyped, so readers probe them through
 * the narrowing helpers below instead of `any`.
 */
import { call } from './engine'

/** XML escaping utilities (same as docx-engine's, used for patch generation). */

/**
 * A fast-xml-parser element node: attributes are '@_'-prefixed, text is '#text',
 * child elements are nested nodes (a single child collapses to an object instead
 * of an array). Parse trees are inherently untyped, so readers probe them through
 * the narrowing helpers below instead of `any`.
 */
export type XmlNode = Record<string, unknown>
/**
 * A value as XML reads it: the five predefined entities and the numeric references decoded, in
 * ONE pass. `r&amp;1`, `r&#38;1` and `r&#x26;1` are one value and `rId&#49;` is `rId1`; and
 * `X&amp;#38;1` is the seven characters `X&#38;1`, because what a reference decodes to is text,
 * never read again.
 *
 * This is the engine's only decoder. The parsers use it (`xmlParser`) and so does every value
 * read off a raw tag (`attributeOf`), so the two readings of one spelling agree and no value is
 * decoded twice: never run a parsed value through it, or through any other decoder.
 *
 * A reference to NUL or to a C0 control XML 1.0 forbids is dropped; one that names no Unicode
 * scalar value (a surrogate, or beyond U+10FFFF) stays as written.
 */
export function decodeXml(raw: string): string {
  return call('decodeXml', [raw]) as never
}
/**
 * What an element's open tag gives the attribute `name`, whatever its quotes and spacing: the
 * value, decoded (`decodeXml`), not its spelling. This is how a value from the deck (a
 * relationship id, an extension, an element id, a part name) is looked up. It is compared as
 * text, never built into a RegExp, where a `(` in it throws, a `.` matches any character and a
 * `$` matches nothing; and it is compared decoded, because two parts may spell one value
 * differently. A value written back into XML goes through `escapeXmlAttr`, once.
 */
export function attributeOf(element: string, name: string): string | undefined {
  return call('attributeOf', [element, name], { undef: true }) as never
}
/**
 * `xml` with each `r:<name>` reference (for the `names` given) whose id is a key of `ids`
 * re-pointed at the id it maps to. One pass: every reference is read once and its decoded id
 * compared as text, so an id from the deck is never a pattern, and a new id that equals another
 * old id is not renamed a second time, which renaming one id after another did.
 */
export function withRelationshipIds(
  xml: string,
  names: readonly string[],
  ids: ReadonlyMap<string, string>,
): string {
  return call('withRelationshipIds', [xml, names, ids]) as never
}
export function escapeXmlText(text: string): string {
  return call('escapeXmlText', [text]) as never
}
export function escapeXmlAttr(text: string): string {
  return call('escapeXmlAttr', [text]) as never
}
/**
 * Highest rIdN already present in a .rels part, so `rId<N+1>` is free. The Id attribute is read
 * quote-agnostically and decoded: a rels file that spells its ids with single quotes, or one
 * that writes `rId&#49;` for `rId1`, still raises the counter instead of being handed a
 * duplicate id. Ids of any other shape are not counted: none of them can equal `rId<number>`.
 */
export function maxRelationshipIdNumber(relsXml: string): number {
  return call('maxRelationshipIdNumber', [relsXml]) as never
}
/**
 * Whether [Content_Types].xml already declares an Override for the part. The PartName is read
 * quote-agnostically and decoded, like every value from the deck: a single-quoted PartName, or
 * one of a part whose name holds `&` (written `&amp;` or `&#38;`), must be recognized so no
 * second Override is emitted for the same part (PowerPoint offers to repair such a package).
 */
export function hasContentTypeOverride(contentTypes: string, partPath: string): boolean {
  return call('hasContentTypeOverride', [contentTypes, partPath]) as never
}
/**
 * The content type [Content_Types].xml declares by default for this extension, whatever the
 * attribute order or quoting; undefined when it declares none. Extensions compare without regard
 * to case, as OPC matches them.
 */
export function defaultContentTypeFor(ct: string, ext: string): string | undefined {
  return call('defaultContentTypeFor', [ct, ext], { undef: true }) as never
}
/** Any <Default> already declaring this extension. */
export function hasDefaultFor(ct: string, ext: string): boolean {
  return call('hasDefaultFor', [ct, ext]) as never
}
