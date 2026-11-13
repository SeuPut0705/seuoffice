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
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return reference
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return ''
      return String.fromCodePoint(code)
    },
  )
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
  const openTag = element.slice(0, element.indexOf('>') + 1)
  for (const attr of openTag.matchAll(ATTRIBUTE)) {
    if (attr[1] === name) return decodeXml(attr[2] ?? attr[3]!)
  }
  return undefined
}

/** An open, close or empty tag: its slash, its name, and whether it closes itself. */
const TAG = /<(\/?)([^\s/>!?]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g

/**
 * The prefix, with its colon, under which the root element of `xml` binds namespace `ns`: `p:`
 * for `xmlns:p="…"`, '' for `xmlns="…"`; null when the root binds it to none. A part may bind
 * a namespace either way, under any prefix, so an element of it is looked for and written with
 * the prefix the part chose, never with the one this engine writes (`p:`).
 */
export function rootPrefixOf(xml: string, ns: string): string | null {
  const root = /<(?![?!])(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(xml)?.[0]
  if (!root) return null
  const own = /^<([^\s/>:]+:)?/.exec(root)?.[1] ?? ''
  let found: string | null = null
  for (const attr of root.matchAll(ATTRIBUTE)) {
    const name = attr[1]!
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue
    if (decodeXml(attr[2] ?? attr[3]!) !== ns) continue
    const prefix = name === 'xmlns' ? '' : `${name.slice('xmlns:'.length)}:`
    if (prefix === own) return prefix
    found ??= prefix
  }
  return found
}

/**
 * Where the first element named `name` (a qualified name, compared as text) at or after `from`
 * lies in `xml`: from its open tag through its close tag, or its empty tag; with where its
 * content starts and ends (equal for an empty tag). Null when there is none, or it is not closed.
 */
export function elementRange(
  xml: string,
  name: string,
  from = 0,
): { start: number; end: number; contentStart: number; contentEnd: number } | null {
  const tags = new RegExp(TAG)
  tags.lastIndex = from
  let start = -1
  let contentStart = -1
  let depth = 0
  for (let tag = tags.exec(xml); tag; tag = tags.exec(xml)) {
    if (tag[2] !== name) continue
    const end = tag.index + tag[0].length
    if (tag[1]) {
      if (start >= 0 && --depth === 0) return { start, end, contentStart, contentEnd: tag.index }
    } else if (tag[3]) {
      if (start < 0) return { start: tag.index, end, contentStart: end, contentEnd: end }
    } else {
      if (start < 0) {
        start = tag.index
        contentStart = end
      }
      depth++
    }
  }
  return null
}

/** The name a slide, layout or master part gives itself (`<p:cSld name>`), as the reader has it. */
export function cSldNameOf(partXml: string): string | undefined {
  const cSld = /<p:cSld\b[^>]*>/.exec(partXml)?.[0]
  return cSld === undefined ? undefined : attributeOf(cSld, 'name')
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
      const to = names.includes(name) ? ids.get(decodeXml(double ?? single ?? '')) : undefined
      if (to === undefined) return all
      const value = escapeXmlAttr(to)
      return double === undefined
        ? `r:${name}${equals}'${value.replace(/'/g, '&apos;')}'`
        : `r:${name}${equals}"${value}"`
    },
  )
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

const NON_CANONICAL = /<!--|<!\[CDATA\[|<\/[^>]*\s>/
/** a comment, a CDATA section, or any tag (quote-aware, so a `>` inside a value ends nothing) */
const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>/g

/**
 * A part's XML in the one spelling the engine's patchers look for: no comments, no CDATA
 * sections (their text escaped instead) and no white space before the `>` of an end tag.
 *
 * Reading and saving search the XML text for `</a:r>`, `</a:p>`, `</p:txBody>` and the like.
 * A comment or a CDATA section can hold those very words, and `</a:p >` is the end tag
 * `</a:p>` as XML reads it, so a search that looked for one spelling cut a run or a
 * paragraph in the wrong place: an edit went missing, or the saved part did not parse.
 * Applied once where a slide is read, so every patcher after it sees what it was written for.
 * What XML reads is unchanged.
 */
export function canonicalXml(xml: string): string {
  if (!NON_CANONICAL.test(xml)) return xml
  return xml.replace(MARKUP, (markup, cdata: string | undefined) => {
    if (markup.startsWith('<!--')) return ''
    if (cdata !== undefined) return escapeXmlText(cdata)
    return markup.startsWith('</') ? markup.replace(/\s+>$/, '>') : markup
  })
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
    const n = Number(/^rId(\d+)$/.exec(decodeXml(match[1] ?? match[2]!))?.[1] ?? 0)
    if (n > max) max = n
  }
  return max
}

const OVERRIDE_TAG = /<Override\b[^>]*>/g

/**
 * Whether [Content_Types].xml already declares an Override for the part. The PartName is read
 * quote-agnostically and decoded, like every value from the deck: a single-quoted PartName, or
 * one of a part whose name holds `&` (written `&amp;` or `&#38;`), must be recognized so no
 * second Override is emitted for the same part (PowerPoint offers to repair such a package).
 */
export function hasContentTypeOverride(contentTypes: string, partPath: string): boolean {
  const wanted = `/${partPath}`
  for (const tag of contentTypes.matchAll(OVERRIDE_TAG)) {
    if (attributeOf(tag[0], 'PartName') === wanted) return true
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
