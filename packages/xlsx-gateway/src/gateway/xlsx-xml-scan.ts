/// A reader of the elements of a small XML part (the workbook, a relationships
/// part, [Content_Types].xml, a pivot definition) that reads it the way an XML
/// parser does, for the callers that edit the text in place and so cannot hand
/// it to one.
///
/// A pattern over the serialized text sees what is written, not what is meant:
/// a producer may write `name='x'`, `name = "x"`, `</definedName >`, a CDATA
/// section for a formula, a comment around an element, or bind the namespace to
/// a prefix. All of these name the same element, and a pattern that misses one
/// reads a record of withheld cells as "none". So every token is read whole:
/// comments, CDATA sections and processing instructions are skipped as units
/// (a closing tag inside them is not one), and an attribute run is consumed as
/// quoted strings (a `>` inside a value does not end the tag).

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTRIBUTE = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const TEXT_RUN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
}

/// Single-pass decode of the XML named entities plus numeric character
/// references (&#dd; / &#xhh;): producers may encode non-ASCII text as numeric
/// references, which sequential replaceAll would miss.
export function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? match
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    },
  )
}

export interface XmlElement {
  /** the element's name as written, prefix included */
  readonly name: string
  /** the name without its prefix */
  readonly local: string
  /** the offset of the `<` that opens the element */
  readonly start: number
  /** the offset after the `>` of the opening tag */
  readonly openEnd: number
  /** the offset of the `<` of the end tag, `end` for an element written self-closed */
  readonly closeStart: number
  /** the offset after the element's last `>` */
  readonly end: number
  /** the attributes by name as written (`r:id`), their values decoded */
  readonly attributes: ReadonlyMap<string, string>
}

export function localNameOf(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

export function prefixOf(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? '' : name.slice(0, colon)
}

export function attributesOf(attributeText: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of attributeText.matchAll(ATTRIBUTE)) {
    attributes.set(match[1]!, decodeXmlEntities(match[2] ?? match[3] ?? ''))
  }
  return attributes
}

/// The elements of `xml` whose name (prefix aside) is `local`, in document
/// order. An element with no end tag, or one an end tag of another name
/// closes first, ends where the part does.
export function xmlElements(xml: string, local: string): XmlElement[] {
  const found: XmlElement[] = []
  const open: { name: string; start: number; openEnd: number; attributeText: string }[] = []
  const finish = (
    entry: { name: string; start: number; openEnd: number; attributeText: string },
    closeStart: number,
    end: number,
  ): void => {
    if (localNameOf(entry.name) !== local) return
    found.push({
      name: entry.name,
      local,
      start: entry.start,
      openEnd: entry.openEnd,
      closeStart,
      end,
      attributes: attributesOf(entry.attributeText),
    })
  }
  for (const match of xml.matchAll(TOKEN)) {
    if (match[2] === undefined) continue
    const end = match.index + match[0].length
    if (match[1] === '/') {
      let at = open.length - 1
      while (at >= 0 && open[at]!.name !== match[2]) at -= 1
      if (at < 0) continue
      const entry = open[at]!
      for (const unclosed of open.splice(at).slice(1)) finish(unclosed, match.index, match.index)
      finish(entry, match.index, end)
    } else if ((match[3] ?? '').endsWith('/')) {
      finish(
        { name: match[2], start: match.index, openEnd: end, attributeText: match[3]! },
        end,
        end,
      )
    } else {
      open.push({ name: match[2], start: match.index, openEnd: end, attributeText: match[3] ?? '' })
    }
  }
  for (const entry of open) finish(entry, xml.length, xml.length)
  return found.sort((left, right) => left.start - right.start)
}

/// The elements `xmlElements` finds that are written with the prefix of the
/// part's root element (none, for a part that binds its namespace as the
/// default): an element of another namespace that happens to share the local
/// name is not the one meant.
export function rootNamespaceElements(xml: string, local: string): XmlElement[] {
  const rootName = TOKEN_ROOT.exec(xml)?.[1]
  const prefix = rootName === undefined ? '' : prefixOf(rootName)
  return xmlElements(xml, local).filter((element) => prefixOf(element.name) === prefix)
}

/// The first start tag of the part's root element.
const TOKEN_ROOT = /<(?![?!])([^\s/>]+)/

/// What the element holds as text: entities decoded, CDATA sections as they
/// are, comments and child elements dropped.
export function elementText(xml: string, element: XmlElement): string {
  let text = ''
  for (const match of xml.slice(element.openEnd, element.closeStart).matchAll(TEXT_RUN)) {
    if (match[1] !== undefined) text += match[1]
    else if (match[2] !== undefined) text += decodeXmlEntities(match[2])
  }
  return text
}

/// Parts above this size are rewritten only when a cheap test finds a spelling
/// the patterns cannot read; a smaller one is always read token by token.
const LARGE_PART_CHARS = 2 * 1024 * 1024

/// What the cheap test looks for. All of it sits inside a tag or is itself
/// markup, so ordinary text (a formula with `=` in it) does not trip it.
const NON_CANONICAL = /<!--|<!\[CDATA\[|<\/[^>\s]+\s+>|<[^<>]*(?:='|\s=|=\s)/

/// The part written the way the patterns that edit the serialized text read
/// it: attributes as ` name="value"` (single quotes, spaces around `=` and a
/// `>` inside a value are other spellings of the same value), end tags as
/// `</name>`, no comments, CDATA sections as the text they hold. The document
/// a parser reads is the same, but for the comments; a part that is no XML
/// (a JSON part) or already written so comes back as it was.
export function canonicalXmlSpelling(xml: string): string {
  if (!xml.trimStart().startsWith('<')) return xml
  if (xml.length > LARGE_PART_CHARS && !NON_CANONICAL.test(xml)) return xml
  const out: string[] = []
  let last = 0
  for (const match of xml.matchAll(TOKEN)) {
    out.push(xml.slice(last, match.index))
    last = match.index + match[0].length
    const token = match[0]
    if (token.startsWith('<!--')) continue
    if (token.startsWith('<![CDATA[')) {
      out.push(
        token
          .slice('<![CDATA['.length, -']]>'.length)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;'),
      )
    } else if (match[2] === undefined) {
      out.push(token)
    } else if (match[1] === '/') {
      out.push(`</${match[2]}>`)
    } else {
      out.push(canonicalStartTag(token, match[2], match[3] ?? ''))
    }
  }
  out.push(xml.slice(last))
  return out.join('')
}

function canonicalStartTag(token: string, name: string, attributeText: string): string {
  const selfClosing = attributeText.trimEnd().endsWith('/')
  const attributes = selfClosing ? attributeText.trimEnd().slice(0, -1) : attributeText
  // anything between the attributes that is not one: leave the tag as written
  if (attributes.replace(ATTRIBUTE, '').trim() !== '') return token
  // The sheet list is read quote-aware and its elements are reused as they
  // are, so a `>` in a sheet's name stays as it was written.
  const keepGreaterThan = localNameOf(name) === 'sheet'
  let written = ''
  for (const attribute of attributes.matchAll(ATTRIBUTE)) {
    let value = (attribute[2] ?? attribute[3] ?? '').replaceAll('"', '&quot;')
    if (!keepGreaterThan) value = value.replaceAll('>', '&gt;')
    written += ` ${attribute[1]}="${value}"`
  }
  return `<${name}${written}${selfClosing ? '/' : ''}>`
}

/// `xml` with the text of every element named in `locals` (a prefix aside)
/// replaced by what `edit` makes of it, for the elements it changes: the rest
/// keep their bytes, comments and CDATA sections included. The text handed to
/// `edit` is what the element holds (entities decoded, CDATA as it is,
/// comments dropped) and what it returns is written escaped.
export function rewriteElementTexts(
  xml: string,
  locals: ReadonlySet<string>,
  edit: (text: string) => string,
): string {
  const stop = new RegExp(
    `<!--[\\s\\S]*?-->|<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|<\\?[\\s\\S]*?\\?>|<(\\/?)(?:[\\w.-]+:)?(${[...locals].join('|')})(?=[\\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>`,
    'g',
  )
  const out: string[] = []
  let copied = 0
  let last = 0
  let open: { openEnd: number; text: string } | null = null
  for (const match of xml.matchAll(stop)) {
    if (open !== null) open.text += decodeXmlEntities(xml.slice(last, match.index))
    last = match.index + match[0].length
    if (match[3] === undefined) {
      if (open !== null && match[1] !== undefined) open.text += match[1]
    } else if (match[2] === '/') {
      if (open === null) continue
      const edited = edit(open.text)
      if (edited !== open.text) {
        out.push(xml.slice(copied, open.openEnd), escapeText(edited))
        copied = match.index
      }
      open = null
    } else if (!(match[4] ?? '').endsWith('/')) {
      open = { openEnd: last, text: '' }
    }
  }
  out.push(xml.slice(copied))
  return out.join('')
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
