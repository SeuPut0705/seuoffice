/** XML escaping utilities (same as docx-engine's, used for patch generation). */

/**
 * A fast-xml-parser element node: attributes are '@_'-prefixed, text is '#text',
 * child elements are nested nodes (a single child collapses to an object instead
 * of an array). Parse trees are inherently untyped, so readers probe them through
 * the narrowing helpers below instead of `any`.
 */
export type XmlNode = Record<string, unknown>

/** View an unknown parse-tree value as an element node; non-objects read as empty. */
export function asXmlNode(v: unknown): XmlNode {
  return typeof v === 'object' && v !== null ? (v as XmlNode) : {}
}

/** Normalize fast-xml-parser's single-child collapse: always get an array of element nodes. */
export function xmlArray(v: unknown): XmlNode[] {
  if (Array.isArray(v)) return v.map(asXmlNode)
  return v ? [asXmlNode(v)] : []
}

const ATTRIBUTE = /\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const REFERENCE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * An attribute value as XML reads it: the five predefined entities and the numeric references
 * decoded, in one pass (so `&amp;#38;` is the five characters `&#38;`, not `&`). `r&amp;1`,
 * `r&#38;1` and `r&#x26;1` are one value, and `rId&#49;` is `rId1`.
 */
export function decodeXmlAttr(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(
    REFERENCE,
    (
      reference,
      hex: string | undefined,
      decimal: string | undefined,
      named: string | undefined,
    ) => {
      if (named !== undefined) return NAMED_ENTITIES[named]!
      const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16)
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : reference
    },
  )
}

/**
 * What an element's open tag gives the attribute `name`, whatever its quotes and spacing: the
 * value, decoded (`decodeXmlAttr`), not its spelling. This is how a value from the deck (a
 * relationship id, an extension, an element id) is looked up. It is compared as text, never built
 * into a RegExp, where a `(` in it throws, a `.` matches any character and a `$` matches nothing;
 * and it is compared decoded, because two parts may spell one id differently. A value written
 * back into XML goes through `escapeXmlAttr`.
 */
export function attributeOf(element: string, name: string): string | undefined {
  const openTag = element.slice(0, element.indexOf('>') + 1)
  for (const attr of openTag.matchAll(ATTRIBUTE)) {
    if (attr[1] === name) return decodeXmlAttr(attr[2] ?? attr[3]!)
  }
  return undefined
}

/**
 * An id attribute as the XML parser hands it over, decoded. The parser decodes the named
 * entities and leaves numeric references as written, so `r&#38;1` would not meet the `r&1` that
 * `attributeOf` and the rels reader give for the same id.
 */
export function parsedId(value: unknown): string | undefined {
  return value == null ? undefined : decodeNumericCharRefs(String(value))
}

const R_REFERENCE = /\br:(\w+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g

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
  if (ids.size === 0) return xml
  return xml.replace(
    R_REFERENCE,
    (all, name: string, equals: string, double: string | undefined, single: string | undefined) => {
      const to = names.includes(name) ? ids.get(decodeXmlAttr(double ?? single ?? '')) : undefined
      if (to === undefined) return all
      const value = escapeXmlAttr(to)
      return double === undefined
        ? `r:${name}${equals}'${value.replace(/'/g, '&apos;')}'`
        : `r:${name}${equals}"${value}"`
    },
  )
}

/** Decode numeric references only when they name a Unicode scalar value. */
export function decodeNumericCharRefs(text: string): string {
  return text.replace(/&#(?:x([0-9a-fA-F]+)|(\d+));/g, (reference, hex, decimal) => {
    const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16)
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : reference
  })
}

/**
 * An ST_Percentage as a fraction of one. The schema's own form is an integer
 * in 1/1000 % ("50000"), and Google Slides writes the suffixed form ("50%").
 * Reading the suffix as a bare integer turns every such value into a
 * thousandth of what the file meant, so both forms are accepted here.
 */
export function percentFraction(raw: unknown): number | undefined {
  if (raw == null) return undefined
  const text = String(raw).trim()
  const n = Number.parseFloat(text)
  if (!Number.isFinite(n)) return undefined
  return text.endsWith('%') ? n / 100 : n / 100000
}

/** XML 1.0 forbids C0 controls (minus tab/LF/CR), U+FFFE/FFFF and lone
    surrogates even when escaped — one such byte makes the whole part
    unparseable and PowerPoint offers repair. VT/FF (common in PDF-extracted
    text) degrade to a space; the rest have no textual meaning and drop. */
// eslint-disable-next-line no-control-regex -- the forbidden chars are the subject
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu

function sanitizeXmlChars(text: string): string {
  XML_INVALID_CHARS.lastIndex = 0
  if (!XML_INVALID_CHARS.test(text)) return text
  XML_INVALID_CHARS.lastIndex = 0
  return text.replace(XML_INVALID_CHARS, (ch) => (ch === '\u000B' || ch === '\u000C' ? ' ' : ''))
}

export function escapeXmlText(text: string): string {
  return sanitizeXmlChars(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;')
}

const RELATIONSHIP_ID = /\bId\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Highest rIdN already present in a .rels part, so `rId<N+1>` is free. The Id attribute is read
 * quote-agnostically and decoded: a rels file that spells its ids with single quotes, or one
 * that writes `rId&#49;` for `rId1`, still raises the counter instead of being handed a
 * duplicate id. Ids of any other shape are not counted: none of them can equal `rId<number>`.
 */
export function maxRelationshipIdNumber(relsXml: string): number {
  let max = 0
  for (const match of relsXml.matchAll(RELATIONSHIP_ID)) {
    const n = Number(/^rId(\d+)$/.exec(decodeXmlAttr(match[1] ?? match[2]!))?.[1] ?? 0)
    if (n > max) max = n
  }
  return max
}

const PART_NAME = /\bPartName\s*=\s*(["'])(.*?)\1/g

/**
 * Whether [Content_Types].xml already declares an Override for the part.
 * Quote-agnostic for the same reason as maxRelationshipIdNumber: an existing
 * single-quoted PartName must be recognized so no second Override is emitted
 * for the same part (PowerPoint offers to repair such a package).
 */
export function hasContentTypeOverride(contentTypes: string, partPath: string): boolean {
  const wanted = `/${partPath}`
  for (const match of contentTypes.matchAll(PART_NAME)) {
    if (match[2] === wanted) return true
  }
  return false
}

/**
 * a16:creationId extLst for a newborn <p:cNvPr> — durable identity from birth
 * (design step 0): the GUID is written into the file bytes, so ids survive
 * save→reopen, reparse, group/ungroup, and editors that renumber cNvPr ids.
 * The a16 namespace is declared inline so the fragment is valid standalone.
 */
export function creationIdExtXml(): string {
  return (
    '<a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}">' +
    `<a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{${globalThis.crypto.randomUUID().toUpperCase()}}"/>` +
    '</a:ext>'
  )
}

export function creationIdXml(): string {
  return `<a:extLst>${creationIdExtXml()}</a:extLst>`
}

const DEFAULT_TAG = /<Default\b[^>]*\/?>/g

/**
 * The content type [Content_Types].xml declares by default for this extension, whatever the
 * attribute order or quoting; undefined when it declares none. Extensions compare without regard
 * to case, as OPC matches them.
 */
export function defaultContentTypeFor(ct: string, ext: string): string | undefined {
  const wanted = ext.toLowerCase()
  for (const tag of ct.matchAll(DEFAULT_TAG)) {
    if (attributeOf(tag[0], 'Extension')?.toLowerCase() === wanted) {
      return attributeOf(tag[0], 'ContentType') ?? ''
    }
  }
  return undefined
}

/** Any <Default> already declaring this extension. */
export function hasDefaultFor(ct: string, ext: string): boolean {
  return defaultContentTypeFor(ct, ext) !== undefined
}
