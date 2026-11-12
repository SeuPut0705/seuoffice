import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { openEpub } from '../../packages/epub-engine/src/open'
import { formatModifiedTimestamp, maskUndefinedEntities, modifiedReplacements, saveEpub } from '../../packages/epub-engine/src/save'
import { extractChapterText } from '../../packages/epub-engine/src/text'
import { batchEpubTranslationItems, createEpubTranslationModelCall } from '../../packages/epub-engine/src/translate/call'
import { epubBlockKeyString } from '../../packages/epub-engine/src/translate/keys'
import { buildTranslatedEpub, type EpubTranslationOutcome } from '../../packages/epub-engine/src/translate/output'
import { epubTranslationUnits, type EpubTranslationUnit } from '../../packages/epub-engine/src/translate/units'
import type { EpubBook } from '../../packages/epub-engine/src/types'
import { estimateTokens } from '../../packages/pdf-structure/src/translate/batch'
import { parseTranslationOutput } from '../../packages/pdf-structure/src/translate/prompt'
import { parseHtml, parseXml } from '../../packages/epub-engine/src/xml'
import {
  checkWellFormed, decodeCharacterData, parseXml as parseXmlPositions, resolveHtmlEntity, textRawOffset,
  type XmlElement as PositionsElement, type XmlText,
} from '../../packages/epub-engine/src/xml-positions'
import { repoRoot } from '../docx-diff/harness'
import { SOURCE_FRAGMENT_TEXT, SOURCE_PARSE5_ROOTS_LINES, SOURCE_PARSE5_ROOTS_TEXT } from '../fileparse-diff/host-steps-epub'
import type { Input, Spec } from '../fileparse-diff/spec'
import { builtBooks, buildEpub, epub2Files, epub3Files, opf, utf16, xhtml, zipEntries } from './epub-fixtures'

// Texts cross as JSON strings: an input of this gate holds no lone surrogate. What a function answers as text crosses
// as the list of its UTF-16 units. A tree that points to its parent crosses flat (see the Rust `positions_value`).

/** The save time of an input that gives none: `Date.UTC(2026, 5, 15, 12, 30, 45)`. */
export const DEFAULT_NOW = 1781526645000

const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
const wireNumber = (n: number): number | string => (Object.is(n, -0) ? '-0' : Number.isFinite(n) ? n : String(n))
const readNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value))
const sha1 = (data: Uint8Array | string): string => createHash('sha1').update(data).digest('hex')

/**
 * The zip gate appends the host's own text to "cannot be inflated": Node gives the bare name TypeError, a browser
 * something else, Rust its own sentence. Only what the TypeScript wrote itself is compared (as outcome.ts does
 * for an error), here in the `detail` of a refusal.
 */
const withoutHostText = (detail: string): string => detail.replace(/(cannot be inflated:).*$/s, '$1')

/** One input per distinct text; an input that repeats another adds a check that tests nothing. */
function texts(cases: ReadonlyArray<readonly [label: string, text: string]>, extra: (text: string) => Record<string, unknown> = () => ({})): Input[] {
  const seen = new Set<string>()
  const out: Input[] = []
  for (const [label, text] of cases) {
    const key = `${label}\0${text}`
    if (seen.has(key)) throw new Error(`built input ${label} repeats another`)
    seen.add(key)
    const args = extra(text)
    out.push({ label, text, ...(Object.keys(args).length > 0 ? { args } : {}) })
  }
  return out
}

const EXTRA_ENTITY_NAMES = ['nbsp', 'ensp', 'emsp', 'thinsp', 'zwnj', 'zwj', 'shy', 'ndash', 'mdash', 'lsquo', 'rsquo', 'ldquo', 'rdquo', 'laquo', 'raquo', 'hellip', 'middot', 'bull', 'copy', 'reg', 'trade']

/** Documents for the parsers of xml.ts and xml-positions.ts. */
export const DOCUMENTS: Array<[string, string]> = [
  ['empty element', '<a/>'],
  ['xml declaration and comment', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- c --><a>t</a><!-- after -->'],
  ['xml 1.1 declaration', '<?xml version="1.1"?><a>\u0085</a>'],
  ['declaration with a bad version', '<?xml version="2.0"?><a/>'],
  ['declaration that is not first', '<a/><?xml version="1.0"?>'],
  ['default namespace and prefixes', '<a xmlns="urn:a" xmlns:p="urn:p" p:x="1" y="2"><p:b z="3"><c xmlns=""><d/></c></p:b><p:e xmlns:p="urn:q"/></a>'],
  ['undeclared prefix on an element and an attribute', '<a><dc:title q:x="1" xml:lang="en">T</dc:title><b xmlns:dc="urn:dc"><dc:t/></b></a>'],
  ['xmlns attributes only', '<a xmlns="urn:a" xmlns:p="urn:p" xmlns:q=""/>'],
  ['prefix named like an object property', '<constructor:a xmlns:constructor="urn:c" __proto__:b="1" xmlns:__proto__="urn:p" toString="x"/>'],
  ['prefix that is empty', '<a :b="1" xmlns:="urn:x"><:c/></a>'],
  ['attribute quotes, spaces and order', "<a  z='1'  b = \"2\" a=\"3\"\n\tc='&lt;&amp;&#65;&#x42;'/>"],
  ['duplicate attribute', '<a b="1" b="2"/>'],
  ['attribute without a value', '<a b/>'],
  ['unquoted attribute', '<a b=1/>'],
  ['attribute with a less-than', '<a b="<"/>'],
  ['predefined entities', '<a>&amp;&lt;&gt;&quot;&apos;</a>'],
  ...EXTRA_ENTITY_NAMES.map((name): [string, string] => [`entity ${name}`, `<a>&${name};</a>`]),
  ['entity in an attribute', '<a b="x&nbsp;y&hellip;"/>'],
  ['undefined entity', '<a>&eacute;</a>'],
  ['entity named like an object property', '<a>&constructor;&__proto__;&toString;</a>'],
  ['entity with a bad name', '<a>&1a;&a b;&;</a>'],
  ['entity without a semicolon', '<a>&amp</a>'],
  ['character references', '<a>&#65;&#x1F600;&#X41;&#0;</a>'],
  ['character reference past the range', '<a>&#x110000;</a>'],
  ['character reference to a surrogate', '<a>&#xD800;</a>'],
  ['character reference to a control character', '<a>&#1;&#x8;</a>'],
  ['CDATA', '<a><![CDATA[<b> & ]]]]><![CDATA[>]]>x<![CDATA[]]></a>'],
  ['CDATA with carriage returns', '<a><![CDATA[1\r\n2\r3]]></a>'],
  ['carriage returns in text', '<a>1\r\n2\r3\n4</a>'],
  ['processing instruction in the root', '<a><?target some body?>t</a>'],
  ['comment with double hyphen', '<a><!-- a -- b --></a>'],
  ['doctype with HTML entity', '<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><body>&nbsp;&eacute;&Eacute;&notin;&amp;&lt;&bogus;&semi;&AMP;&not;</body></html>'],
  ['doctype with an entity declaration', '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'],
  ['public doctype', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html>&nbsp;&copy;</html>'],
  ['entity before the doctype is known', '<?xml version="1.0"?><!-- &nbsp; --><!DOCTYPE html><html>&nbsp;</html>'],
  ['text outside the root', 'text<a/>'],
  ['whitespace outside the root', '  \n<a/>\n  '],
  ['two roots', '<a/><b/>'],
  ['no root', '<?xml version="1.0"?>'],
  ['empty text', ''],
  ['only whitespace', ' \n '],
  ['unclosed element', '<a><b>'],
  ['mismatched end tag', '<a><b></a></b>'],
  ['unmatched end tag', '<a></a></b>'],
  ['unterminated tag', '<a b="1"'],
  ['unterminated comment', '<a><!-- x'],
  ['unterminated CDATA', '<a><![CDATA[x'],
  ['unterminated entity', '<a>&amp'],
  ['bad name start', '<1a/>'],
  ['less-than in text', '<a>1 < 2</a>'],
  ['double-hyphen start of comment', '<a><!- x --></a>'],
  ['byte order mark', '\uFEFF<a/>'],
  ['byte order mark in the middle', '<a>\uFEFF</a>'],
  ['control character', '<a>\u0001</a>'],
  ['non-characters', '<a>\uFFFE</a>'],
  ['astral text and names', '<a b="\ud83d\ude00">\ud83d\ude00<\ud800\udc00x/></a>'],
  ['astral name start', '<\ud835\udc9c/>'],
  ['nested elements and text', '<a>1<b>2<c>3</c>4</b>5<d/>6</a>'],
  ['self-closing with a space', '<a />'],
  ['end tag with a space', '<a></a >'],
  ['tab and newline in a tag', '<a\tb="1"\n/>'],
  ['deep nesting', `${'<a>'.repeat(300)}x${'</a>'.repeat(300)}`],
  ['many siblings', `<r>${'<i k="v"/>'.repeat(500)}</r>`],
  ['long text', `<a>${'text '.repeat(5000)}</a>`],
  ['XHTML chapter', xhtml('Title', '<h1>H</h1><p>P &amp; Q &nbsp; &eacute;</p><p>two<br/>lines</p>')],
  ['XHTML chapter without a doctype', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&nbsp;</p></body></html>'],
  ['package document', epub3Files()['OEBPS/content.opf']!],
  ['navigation document', epub3Files()['OEBPS/nav.xhtml']!],
  ['NCX', '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>A</text></navLabel><content src="a.html"/></navPoint></navMap></ncx>'],
  ['HTML tag soup', '<html><body><p>a<p>b<br>c<img src=x alt="y"><table><tr><td>1<td>2</table><!-- c -->&nbsp;&eacute;'],
  ['HTML with a template and attributes', '<html><head><title>t</title></head><body><template><p>in</p></template><svg viewBox="0 0 1 1" xlink:href="#a"><a xlink:href="#b"/></svg><math><mi>x</mi></math><p CLASS=a Data-X=b>c</p></body></html>'],
  ['HTML fragment', 'just text'],
  ['HTML with no body', '<head><title>only</title></head>'],
  ['HTML with a doctype and nested lists', '<!DOCTYPE html><ul><li>a<ul><li>b</ul><li>c</ul>'],
]

/** Every XML-like text part of the built books, as extra seeds. */
async function bookParts(limit: number): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  for (const { label, bytes } of await builtBooks()) {
    if (!/^(epub3|epub2|nav|ncx|chapters)/.test(label)) continue
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(bytes)
    } catch {
      continue
    }
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir || !/\.(xml|opf|ncx|xhtml|html)$/i.test(name) || out.length >= limit) continue
      out.push([`${label}: ${name}`, await file.async('string')])
    }
  }
  return out
}

let partsCache: Promise<Array<[string, string]>> | undefined
const parts = (): Promise<Array<[string, string]>> => (partsCache ??= bookParts(60))

async function documents(): Promise<Input[]> {
  const seen = new Set<string>()
  const cases: Array<[string, string]> = []
  for (const entry of [...DOCUMENTS, ...(await parts())]) {
    if (seen.has(entry[1])) continue
    seen.add(entry[1])
    cases.push(entry)
  }
  return texts(cases)
}

// xml-positions.ts: the tree written flat, as the Rust side writes it
type FlatChild = { element: number } | { type: 'text'; start: number; end: number; value: number[]; cdata: boolean } | { type: 'comment' | 'pi'; start: number; end: number }

function flat(source: string): unknown {
  const parsed = parseXmlPositions(source)
  if (!parsed.ok) return { ok: false, error: parsed.error, offset: parsed.offset }
  const ids = new Map<PositionsElement, number>()
  const order: PositionsElement[] = []
  const stack: PositionsElement[] = [parsed.doc.root]
  while (stack.length > 0) {
    const el = stack.pop()!
    ids.set(el, order.length)
    order.push(el)
    for (let i = el.children.length - 1; i >= 0; i--) {
      const child = el.children[i]!
      if (child.type === 'element') stack.push(child)
    }
  }
  const child = (node: PositionsElement['children'][number]): FlatChild =>
    node.type === 'element' ? { element: ids.get(node)! }
      : node.type === 'text' ? { type: 'text', start: node.start, end: node.end, value: units(node.value), cdata: node.cdata }
        : { type: node.type, start: node.start, end: node.end }
  return {
    ok: true, hasDoctype: parsed.doc.hasDoctype, root: 0,
    elements: order.map(el => ({
      name: el.name, local: el.local, attributes: el.attributes.map(a => ({ name: a.name, value: a.value })),
      start: el.start, startTagEnd: el.startTagEnd, endTagStart: el.endTagStart, end: el.end, selfClosing: el.selfClosing,
      parent: el.parent === null ? null : ids.get(el.parent)!, children: el.children.map(child),
    })),
  }
}

function textNodes(root: PositionsElement): XmlText[] {
  const out: XmlText[] = []
  const stack = [root.children[Symbol.iterator]()]
  while (stack.length > 0) {
    const next = stack[stack.length - 1]!.next()
    if (next.done) { stack.pop(); continue }
    if (next.value.type === 'text') out.push(next.value)
    else if (next.value.type === 'element') stack.push(next.value.children[Symbol.iterator]())
  }
  return out
}

const ENTITY_NAMES = [
  'nbsp', 'eacute', 'Eacute', 'amp', 'lt', 'gt', 'quot', 'apos', 'AMP', 'LT', 'not', 'notin', 'notit', 'semi', 'copy', 'COPY', 'hellip', 'ndash', 'mdash',
  'bogus', 'a', 'A', 'x1', '1x', '', 'a-b', 'a_b', 'a b', 'amp;', 'nbsp ', ' nbsp', 'euro', 'lang', 'rang', 'bne', 'NotEqualTilde', 'ThickSpace', 'fjlig',
  'Aacute', 'aacute', 'aacut', 'aelig', 'AElig', 'ccedil', 'frac12', 'frac14', 'sup2', 'times', 'divide', 'not;', 'amp1', 'ampx', 'nbspx', 'it', 'in',
  'constructor', '__proto__', 'toString', 'hasOwnProperty', 'x'.repeat(40), 'Colon', 'colon', 'Tab', 'NewLine', 'excl', 'num', 'dollar', 'percnt',
  'lbrace', 'rbrace', 'comma', 'period', 'sol', 'bsol', 'lowbar', 'grave', 'DiacriticalGrave', '\u00e9', 'e\u0301',
]

export const RAW_TEXTS: Array<[string, string]> = [
  ['plain', 'plain text'], ['crlf', 'a\r\nb\rc\n'], ['predefined', '&amp;&lt;&gt;&quot;&apos;'], ['decimal and hex', '&#65;&#x42;&#X43;&#128512;&#x1F600;'],
  ['html entities', '&nbsp;&eacute;&notin;&bogus;&AMP;&semi;'], ['ampersand without a name', '& &; &&amp; &a'], ['reference with a space', '&a b;'],
  ['reference with a less-than', '&a<b;'], ['empty hex digits', '&#x;&#;'], ['not a number', '&#xZZ;&#12a;'], ['past the range', '&#x110000;'],
  ['surrogate reference', '&#xD800;&#xDFFF;'], ['astral text', '\ud83d\ude00&amp;\ud83d\ude00'], ['nested', '&amp;amp;&amp;#65;'], ['two semicolons', '&amp;;'],
  ['reference with a tab', '&a\tb;'], ['reference with a no-break space', '&\u00a0;'], ['reference with a byte order mark', '&a\uFEFF;'],
  ['reference followed by a carriage return', '&nbsp;\r\n&nbsp;'], ['empty', ''],
]

export const CHAPTER_TEXTS: Array<[string, string]> = [
  ['paragraphs and headings', xhtml('T', '<h1>Head</h1><p>one   two\n three</p><h2>Sub</h2><div>a<br/>b</div>')],
  ['table cells', xhtml('T', '<table><tr><td>a</td><td> </td><th>c</th></tr><tr><td></td><td>x</td></tr></table>')],
  ['pre keeps its spaces', xhtml('T', '<pre>  a\n   b  \n\n</pre><p>after</p>')],
  ['nested pre and blocks', xhtml('T', '<pre>1<div>2<pre>3</pre>4</div>5</pre>')],
  ['skipped elements', xhtml('T', '<p>a<script>x</script><style>y</style><rt>z</rt><rp>(</rp><svg><text>s</text></svg><math><mi>m</mi></math><noscript>n</noscript><template>t</template>b</p>')],
  ['list and definition list', xhtml('T', '<ul><li>one</li><li>two</li></ul><dl><dt>t</dt><dd>d</dd></dl><blockquote>q</blockquote><hr/>')],
  ['headings of every level', xhtml('T', [1, 2, 3, 4, 5, 6, 7].map(n => `<h${n}>H${n}</h${n}>`).join(''))],
  ['inline elements only', xhtml('T', '<span>a</span><em>b</em><b>c</b>')],
  ['no body', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><p>x</p></html>'],
  ['nothing but whitespace', xhtml('T', '  \n  ')],
  ['empty body', '<html><body/></html>'],
  ['uppercase names', '<HTML><BODY><P>x</P><H1>h</H1></BODY></HTML>'],
  ['prefixed XHTML', '<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:body><x:h2>P</x:h2><x:p>t</x:p></x:body></x:html>'],
  ['XHTML with entities and a doctype', xhtml('T', '<p>&nbsp;&eacute;&hellip;&#169;</p>')],
  ['CDATA and comments', '<html><body><p>a<![CDATA[ <b> ]]><!-- hidden -->b<?pi x?></p></body></html>'],
  ['carriage returns', '<html><body><p>a\r\nb\rc</p><pre>1\r\n2</pre></body></html>'],
  ['body nested in another element', '<a><b><body><p>in</p></body></b><body><p>second</p></body></a>'],
  ['body that is empty before another', '<a><body/><body><p>x</p></body></a>'],
  ['soup: unclosed paragraphs', '<p>one<p>two<br>three'],
  ['soup: undefined entities', '<html><body><p>&nbsp;&eacute;&bogus;&#0;&#x1F600;</p></body></html>'],
  ['soup: tables without end tags', '<table><tr><td>1<td>2<tr><td>3'],
  ['soup: pre with a first newline', '<pre>\nfirst\n second</pre>'],
  ['soup: head and body', '<html><head><title>t</title><script>s</script></head><body><h3>x<p>y</body>'],
  ['soup: template', '<body><template><p>skipped</p></template><p>shown</p></body>'],
  ['soup: svg and math', '<body><svg><title>s</title></svg><math><mi>m</mi></math><p>p</p></body>'],
  ['soup: only text', 'just words'],
  ['soup: only a comment', '<!-- c -->'],
  ['soup: nothing', ''],
  ['soup: stray end tags', '</p></div><p>ok</p></span>'],
  ['soup: deep nesting', '<div>'.repeat(200) + 'deep' + '</div>'.repeat(200)],
  ['deep XML nesting', `<html><body>${'<div>'.repeat(900)}deep${'</div>'.repeat(900)}</body></html>`],
  ['wide', `<html><body>${'<p>row</p>'.repeat(2000)}</body></html>`],
  ['text with line breaks around blocks', '<html><body>a<div>b</div>c<p>d</p>e</body></html>'],
  ['spaces around line breaks', '<html><body><p>a <br/> b <br/><br/> c</p></body></html>'],
  ['form feed and tabs', '<html><body><p>a\f\tb\u00a0c</p></body></html>'],
  ['astral and combining text', '<html><body><p>\ud83d\ude00 e\u0301</p></body></html>'],
]

// the zip describer, mirrored by `describe_zip` of epub_xml.rs
interface Raw {
  madeBy: number; needed: number; flags: number; method: number; time: number; date: number; crc32: number
  compressedSize: number; uncompressedSize: number; internal: number; external: number
  name: Buffer; extra: Buffer; comment: Buffer
  local: { needed: number; flags: number; method: number; time: number; date: number; crc32: number; compressedSize: number; uncompressedSize: number; name: Buffer; extra: Buffer }
  data: Buffer
}

function rawRecords(bytes: Uint8Array): Raw[] {
  const b = Buffer.from(bytes)
  let end = -1
  for (let at = b.length - 22; at >= 0; at--) {
    if (b.readUInt32LE(at) === 0x06054b50) { end = at; break }
  }
  if (end < 0) throw new Error('no end of central directory')
  const count = b.readUInt16LE(end + 10)
  let at = b.readUInt32LE(end + 16)
  const out: Raw[] = []
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error('no central record')
    const nameLength = b.readUInt16LE(at + 28)
    const extraLength = b.readUInt16LE(at + 30)
    const commentLength = b.readUInt16LE(at + 32)
    const local = b.readUInt32LE(at + 42)
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('no local record')
    const localNameLength = b.readUInt16LE(local + 26)
    const localExtraLength = b.readUInt16LE(local + 28)
    const compressedSize = b.readUInt32LE(at + 20)
    const dataAt = local + 30 + localNameLength + localExtraLength
    out.push({
      madeBy: b.readUInt16LE(at + 4), needed: b.readUInt16LE(at + 6), flags: b.readUInt16LE(at + 8), method: b.readUInt16LE(at + 10),
      time: b.readUInt16LE(at + 12), date: b.readUInt16LE(at + 14), crc32: b.readUInt32LE(at + 16), compressedSize,
      uncompressedSize: b.readUInt32LE(at + 24), internal: b.readUInt16LE(at + 36), external: b.readUInt32LE(at + 38),
      name: b.subarray(at + 46, at + 46 + nameLength), extra: b.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      comment: b.subarray(at + 46 + nameLength + extraLength, at + 46 + nameLength + extraLength + commentLength),
      local: {
        needed: b.readUInt16LE(local + 4), flags: b.readUInt16LE(local + 6), method: b.readUInt16LE(local + 8), time: b.readUInt16LE(local + 10),
        date: b.readUInt16LE(local + 12), crc32: b.readUInt32LE(local + 14), compressedSize: b.readUInt32LE(local + 18),
        uncompressedSize: b.readUInt32LE(local + 22), name: b.subarray(local + 30, local + 30 + localNameLength),
        extra: b.subarray(local + 30 + localNameLength, dataAt),
      },
      data: b.subarray(dataAt, dataAt + compressedSize),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

function describeZip(bytes: Uint8Array, original: Uint8Array): unknown {
  const written = rawRecords(bytes)
  let before: Raw[] = []
  try { before = rawRecords(original) } catch { /* an original with bytes before its first record has no record the writer could copy */ }
  return written.map(record => {
    const copied = before.some(b => b.name.equals(record.name) && b.method === record.method && b.data.equals(record.data))
    let inflated: unknown
    try {
      const content = record.method === 0 ? record.data : inflateRawSync(record.data)
      inflated = { size: content.length, sha1: sha1(content) }
    } catch (error) {
      inflated = { error: (error as Error).message }
    }
    return {
      name: record.name.toString('utf8'), madeBy: record.madeBy, needed: record.needed, flags: record.flags, method: record.method,
      time: record.time, date: record.date, crc32: record.crc32, uncompressedSize: record.uncompressedSize, extra: record.extra.toString('hex'),
      comment: record.comment.toString('utf8'), internal: record.internal, external: record.external,
      local: {
        needed: record.local.needed, flags: record.local.flags, method: record.local.method, time: record.local.time, date: record.local.date,
        crc32: record.local.crc32, uncompressedSize: record.local.uncompressedSize, name: record.local.name.toString('utf8'),
        extra: record.local.extra.toString('hex'), compressedSizeAgrees: record.local.compressedSize === record.compressedSize,
      },
      copied,
      ...(copied || record.method === 0 ? { compressedSize: record.compressedSize, compressedSha1: sha1(record.data) } : {}),
      inflated,
    }
  })
}

// openEpub and saveEpub
const probesOf = (names: string[]): string[] =>
  names.slice(0, 40).flatMap(name => [name, name.replace(/[a-z]/g, c => c.toUpperCase()), `./${name}`, `x/../${name}`, `${name}~`])

export async function openCall(bytes: Uint8Array): Promise<unknown> {
  const opened = await openEpub(bytes)
  if (!opened.ok) return { ok: false, reason: opened.reason, detail: withoutHostText(opened.detail) }
  const { book } = opened
  const { has: _has, read, readText, readForRendering, ...info } = book
  const entries = []
  for (const name of book.entryNames.slice(0, 60)) {
    const stored = await read(name)
    const text = await readText(name)
    const rendering = await readForRendering(name)
    entries.push({
      name, bytes: stored === null ? null : sha1(stored),
      text: text === null ? null : { encoding: text.encoding, valid: text.valid, length: text.text.length, sha1: sha1(Buffer.from(text.text, 'utf8')) },
      rendering: rendering === null ? null : sha1(rendering),
    })
  }
  return { ok: true, info, entries, has: probesOf(book.entryNames).map(path => [path, book.has(path)]) }
}

type WireEdit = [string, Array<{ start: number | string; end: number | string; text: string }>]

/** For an input that gives no edits: a comment after the start tag of the first chapter. */
async function derivedEdits(bytes: Uint8Array): Promise<WireEdit[]> {
  const opened = await openEpub(bytes)
  if (!opened.ok) return []
  const path = opened.book.spine.items[0]!.path
  const chapter = await opened.book.readText(path)
  const parsed = chapter ? parseXmlPositions(chapter.text) : null
  if (!parsed?.ok) return []
  const at = parsed.doc.root.startTagEnd
  return [[path, [{ start: at, end: at, text: '<!--gate-->' }]]]
}

export async function saveCall(input: Input): Promise<unknown> {
  const bytes = input.bytes!
  const edits = (input.args?.edits as WireEdit[] | undefined) ?? await derivedEdits(bytes)
  const now = readNumber(input.args?.now ?? DEFAULT_NOW)
  const map = new Map(edits.map(([path, ranges]) => [path, ranges.map(r => ({ start: readNumber(r.start), end: readNumber(r.end), text: r.text }))]))
  const result = await saveEpub(bytes, map, { now: () => new Date(now) })
  if (!result.ok) return { ok: false, reason: result.reason, path: result.path, detail: withoutHostText(result.detail) }
  if (!result.changed) return { ok: true, changed: false }
  return { ok: true, changed: true, changedChapters: result.changedChapters, zip: describeZip(result.bytes, bytes) }
}

export const NOW_CASES: Array<[string, number]> = [
  ['now', DEFAULT_NOW], ['epoch', 0], ['negative', -1], ['year 1', Date.UTC(1, 0, 1) - 0], ['year 0', -62167219200000], ['year 10000', 253402300800000],
  ['year 275760', 8.64e15], ['year -271821', -8.64e15], ['past the range', 8.64e15 + 1], ['NaN', NaN], ['Infinity', Infinity], ['fraction', 1.9e12 + 0.7],
  ['leap day', Date.UTC(2024, 1, 29, 23, 59, 59, 999)], ['1979', Date.UTC(1979, 11, 31)], ['2108', Date.UTC(2108, 0, 1)], ['-0', -0],
]

export const OPF_TEXTS: Array<[string, string]> = [
  ['two lines', '<?xml version="1.0"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0">\n  <metadata>\n    <dc:title xmlns:dc="urn:dc">T</dc:title>\n  </metadata>\n  <manifest/>\n</package>\n'],
  ['one modified', '<package><metadata><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata></package>'],
  ['modified twice', '<package><metadata><meta property=" dcterms:modified ">a</meta><meta property="dcterms:modified"/><meta property="dcterms:modified">b</meta></metadata></package>'],
  ['modified that refines', '<package><metadata><meta property="dcterms:modified" refines="#x">a</meta></metadata></package>'],
  ['self-closing metadata', '<package><metadata/></package>'],
  ['self-closing prefixed metadata', '<opf:package xmlns:opf="urn:o"><opf:metadata /></opf:package>'],
  ['no metadata', '<package><manifest/></package>'],
  ['metadata on one line', '<package><metadata><a/></metadata></package>'],
  ['metadata with CRLF', '<package>\r\n  <metadata>\r\n    <a/>\r\n  </metadata>\r\n</package>'],
  ['metadata whose end tag starts the document line', '<metadata>\n</metadata>'],
  ['metadata with text before its end tag', '<package><metadata>\n  <a/>\n  text</metadata></package>'],
  ['metadata empty on two lines', '<package>\n<metadata>\n</metadata>\n</package>'],
  ['metadata indented with tabs', '<package>\n\t<metadata>\n\t\t<a/>\n\t</metadata>\n</package>'],
  ['last child on the metadata line', '<package>\n<metadata><a/>\n</metadata></package>'],
  ['prefixed metadata', '<o:package xmlns:o="urn:o">\n <o:metadata>\n  <o:meta property="x"/>\n </o:metadata>\n</o:package>'],
  ['undefined entities', '<package>\n<metadata>\n<dc:title>A&nbsp;B&eacute;</dc:title>\n<meta property="dcterms:modified">&amp;</meta>\n</metadata></package>'],
  ['not well-formed', '<package><metadata>'],
  ['metadata in a nested element', '<package><x><metadata/></x></package>'],
  ['metadata then metadata', '<package><metadata>\n</metadata><metadata/></package>'],
  ['a self-closing modified', '<package><metadata><meta property="dcterms:modified"/></metadata></package>'],
  ['a comment before the end tag', '<package>\n<metadata>\n<a/>\n<!-- c -->\n</metadata>\n</package>'],
  ['a byte order mark', '\uFEFF<package>\n<metadata>\n</metadata>\n</package>'],
]

export const MASK_TEXTS: Array<[string, string]> = [
  ['entities', '&amp;&lt;&gt;&quot;&apos;&nbsp;&eacute;&#65;&_x;&a.b-c;&a b;&;&1;&A1_;'], ['nothing', 'plain'], ['empty', ''],
  ['ampersands', '&&&amp;&&nbsp;'], ['no semicolon', '&nbsp'], ['astral', '\ud83d\ude00&nbsp;\ud83d\ude00'], ['case', '&AMP;&Amp;&amp;'],
  ['dots and dashes', '&a.b;&a-b;&a:b;&a\u00e9;'],
]

/** A host step that copies TypeScript must still be that code: the gate fails once the original changes. */
function assertCopied(file: string, ...copies: string[]): void {
  const source = readFileSync(resolve(repoRoot, 'packages/epub-engine/src', file), 'utf8')
  for (const copy of copies) {
    if (!source.includes(copy)) throw new Error(`${file} no longer holds the text that tools/fileparse-diff/host-steps-epub.ts copies`)
  }
}

const bookInputs = async (): Promise<Input[]> => (await builtBooks()).map(({ label, bytes }) => ({ label, bytes }))

/** Edits of one book, by what they make `saveEpub` decide. */
export async function saveInputs(): Promise<Input[]> {
  const e3 = epub3Files()
  const book = await buildEpub(e3)
  const c1 = 'OEBPS/text/chapter 1.xhtml'
  const text = e3[c1]!
  const at = text.indexOf('<h1>')
  const edit = (path: string, ...ranges: Array<[number | string, number | string, string]>): WireEdit =>
    [path, ranges.map(([start, end, t]) => ({ start, end, text: t }))]
  const save = (label: string, bytes: Uint8Array, edits: WireEdit[], now: number = DEFAULT_NOW): Input => ({ label, bytes, args: { edits, now: wireNumber(now) } })
  const inputs: Input[] = [
    save('no edits', book, []),
    save('empty replacements', book, [[c1, []]]),
    save('an insertion', book, [edit(c1, [at, at, '<p>inserted</p>'])]),
    save('a replacement that changes nothing', book, [edit(c1, [at, at + 4, '<h1>'])]),
    save('a replacement and an insertion', book, [edit(c1, [at, at + 4, '<h2>'], [at + 10, at + 10, '<!-- x -->'])]),
    save('two entries', book, [edit(c1, [at, at, '<p>a</p>']), edit('OEBPS/text/c2.xhtml', [0, 0, ''])]),
    save('two entries both changed', book, [edit(c1, [at, at, '<p>a</p>']), edit('OEBPS/text/notes.xhtml', [text.length > 0 ? 0 : 0, 0, '<!-- n -->'])]),
    save('the same entry twice', book, [edit(c1, [at, at, '<p>a</p>']), edit(c1.toUpperCase(), [at + 1, at + 1, ''])]),
    save('an entry in another case and with dots', book, [edit('oebps/./text/../TEXT/CHAPTER 1.xhtml', [at, at, '<!--c-->'])]),
    save('an unknown entry', book, [edit('OEBPS/nope.xhtml', [0, 0, 'x'])]),
    save('an unknown entry with no replacement', book, [['OEBPS/nope.xhtml', []]]),
    save('an unknown entry after a good one', book, [edit(c1, [at, at, '<!--c-->']), edit('nope', [0, 0, 'x'])]),
    save('overlapping replacements', book, [edit(c1, [at, at + 6, ''], [at + 2, at + 8, ''])]),
    save('a range past the end', book, [edit(c1, [0, text.length + 1, ''])]),
    save('a negative start', book, [edit(c1, [-1, 0, ''])]),
    save('a fractional offset', book, [edit(c1, [1.5, 2, ''])]),
    save('NaN offsets', book, [edit(c1, ['NaN', 2, ''])]),
    save('an end before the start', book, [edit(c1, [5, 4, ''])]),
    save('an edit that is not well-formed', book, [edit(c1, [at, at, '<p>'])]),
    save('an edit that closes the root', book, [edit(c1, [at, at, '</body></html><html>'])]),
    save('an edit with a bad entity', book, [edit(c1, [at, at, '&bogus;'])]),
    save('an edit with a known entity under a doctype', book, [edit(c1, [at, at, '&nbsp;&eacute;'])]),
    save('an edit that splits a surrogate pair', book, [edit(c1, [at, at, '\ud83d\ude00'], [at, at, ''])]),
    save('an edit that makes the chapter empty', book, [edit(c1, [0, text.length, ''])]),
    save('an edit of the package document', book, [edit('OEBPS/content.opf', [0, 0, '<!-- opf -->'])]),
    save('an edit that breaks the package document', book, [edit('OEBPS/content.opf', [0, 0, '<x>'])]),
    save('an edit of a stylesheet', book, [edit('OEBPS/styles/book.css', [0, 0, '/* css */'])]),
    save('an edit of mimetype', book, [edit('mimetype', [0, 0, 'x'])]),
    save('an edit of a directory', book, [edit('OEBPS/', [0, 0, 'x'])]),
    save('an edit of the container', book, [edit('META-INF/container.xml', [0, 0, '<!-- c -->'])]),
    save('an edit of a nav document', book, [edit('OEBPS/nav.xhtml', [0, 0, ''], [1, 1, ''])]),
  ]
  for (const [label, time] of NOW_CASES) inputs.push(save(`save time ${label}`, book, [edit(c1, [at, at, '<!--t-->'])], time))

  // book shapes
  const book2 = await buildEpub(epub2Files(), 'content.opf')
  inputs.push(
    save('EPUB 2 is never stamped', book2, [edit('ch1.html', [0, 0, '<!-- x -->'])]),
    save('EPUB 2 package edited by hand', book2, [edit('content.opf', [0, 0, '<!-- x -->'])]),
  )
  for (const [label, opfText] of OPF_TEXTS) {
    const files: Record<string, string> = { ...e3, 'OEBPS/content.opf': opfText }
    const bytes = await zipEntries([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      ...Object.entries(files).map(([name, data]) => ({ name, data })),
    ])
    inputs.push({ label: `package: ${label}`, bytes, args: { edits: [edit('OEBPS/text/c2.xhtml', [0, 0, '<!-- c -->'])], now: DEFAULT_NOW } })
  }

  // zip shapes
  const shaped = async (label: string, entries: Parameters<typeof zipEntries>[0], platform?: 'DOS' | 'UNIX'): Promise<void> => {
    inputs.push({ label, bytes: await zipEntries(entries, platform), args: { edits: [edit('OEBPS/text/c2.xhtml', [0, 0, '<!-- c -->'])], now: DEFAULT_NOW } })
  }
  const base = [{ name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' }, ...Object.entries(e3).map(([name, data]) => ({ name, data }))]
  await shaped('save: no mimetype', base)
  await shaped('save: mimetype deflated and last', [...base, { name: 'mimetype', data: 'application/epub+zip' }])
  await shaped('save: mimetype empty', [{ name: 'mimetype', data: '', store: true }, ...base])
  await shaped('save: comments, folders, permissions and dates', [
    { name: 'mimetype', data: 'application/epub+zip', store: true, date: new Date('1999-12-31T23:59:58Z'), comment: 'm' },
    { name: 'META-INF/', data: '', dir: true, comment: '\u00e9', date: new Date('2000-02-29T00:00:00Z') },
    ...base.map((entry, index) => ({ ...entry, date: new Date(Date.UTC(1990 + index, index % 12, 1 + index, index, index, 2 * index)), ...(index % 2 ? { comment: `n${index}` } : {}), ...(index % 3 === 0 ? { dosPermissions: 0x20 } : {}) })),
    { name: 'OEBPS/empty', data: '', dosPermissions: 1 },
    { name: 'OEBPS/\u00e9.txt', data: 'unicode', comment: '\u6ce8' },
  ])
  await shaped('save: UNIX platform entries', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.map(entry => ({ ...entry, unixPermissions: 0o755 }))], 'UNIX')
  await shaped('save: stored entries and a duplicate name', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.map((entry, index) => ({ ...entry, store: index % 2 === 0 })), { name: 'OEBPS/text/c2.xhtml', data: xhtml('Dup', '<p>second</p>') }])
  await shaped('save: a chapter in UTF-16LE', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: utf16(xhtml('Two', '<h1>\u4e8c</h1><p>x</p>'), true) }])
  await shaped('save: a chapter in UTF-16BE with a BOM only', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: utf16('<p>x</p>', false) }])
  await shaped('save: a chapter that is invalid UTF-8', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: new Uint8Array([0x3c, 0x70, 0x2f, 0x3e, 0xff]) }])
  await shaped('save: a chapter that is not well-formed to begin with', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: '<p>soup<br>' }])
  await shaped('save: a chapter with a byte order mark', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<p>bom</p>')]) }])
  await shaped('save: a very compressible chapter', [{ name: 'mimetype', data: 'application/epub+zip', store: true }, ...base.filter(entry => entry.name !== 'OEBPS/text/c2.xhtml'), { name: 'OEBPS/text/c2.xhtml', data: `<p>${'abc '.repeat(20000)}</p>` }])
  return inputs
}

// the book translation: the units of a book, the book built from stored results, the batcher and the model call
const openBook = async (bytes: Uint8Array): Promise<EpubBook | null> => {
  const opened = await openEpub(bytes)
  return opened.ok ? opened.book : null
}

const unitSummary = (unit: EpubTranslationUnit): unknown => ({
  key: epubBlockKeyString(unit.key), page: unit.page, text: units(unit.text), plainText: units(unit.plainText), sources: unit.sources,
})

async function unitsCall(input: Input): Promise<unknown> {
  const book = await openBook(input.bytes!)
  if (!book) return null
  const chapters = input.args?.chapters as number[] | undefined
  const result = await epubTranslationUnits(book, chapters === undefined ? {} : { chapters })
  return { units: result.units.map(unitSummary), skipped: result.skipped }
}

/** The stored results a variant makes of the units of a book: the same rule in the Rust gate (`results_of`). */
function resultsOf(all: readonly EpubTranslationUnit[], variant: string): Map<string, EpubTranslationOutcome> {
  const results = new Map<string, EpubTranslationOutcome>()
  all.forEach((unit, index) => {
    const key = epubBlockKeyString(unit.key)
    const translated: EpubTranslationOutcome = { status: 'translated', text: `T: ${unit.text}` }
    switch (variant) {
      case 'all': results.set(key, translated); break
      case 'half': if (index % 2 === 0) results.set(key, translated); break
      case 'failed': results.set(key, index % 2 === 0 ? translated : { status: 'failed', reason: 'gave-up' }); break
      case 'failed-without-reason': results.set(key, index % 3 === 0 ? { status: 'failed' } : translated); break
      case 'mismatch': results.set(key, unit.context.placeholders.length > 0 ? { status: 'translated', text: 'no placeholders here' } : translated); break
      case 'empty': results.set(key, index % 2 === 0 ? { status: 'translated', text: '   ' } : translated); break
      case 'no-text': results.set(key, index % 2 === 0 ? { status: 'translated' } : translated); break
      case 'markup': results.set(key, { status: 'translated', text: `<b>T</b>\u00e9 &amp; ${index}<br/>${unit.text}` }); break
      case 'rtl-labels': results.set(key, { status: 'translated', text: `\u05e9\u05dc\u05d5\u05dd ${index} <b>x</b>` }); break
    }
  })
  return results
}

async function buildCall(input: Input): Promise<unknown> {
  const bytes = input.bytes!
  const args = input.args ?? {}
  const book = await openBook(bytes)
  const all = book ? (await epubTranslationUnits(book)).units : []
  const lang = String(args.lang ?? 'fr')
  const mode = (args.mode as 'translate' | 'easy' | undefined) ?? 'translate'
  const chapters = args.chapters as number[] | undefined
  const result = await buildTranslatedEpub(bytes, {
    kind: (args.kind as 'translated' | 'bilingual' | undefined) ?? 'translated', lang, mode,
    results: resultsOf(all, String(args.variant ?? 'all')), now: () => new Date(readNumber(args.now ?? DEFAULT_NOW)),
    uuid: () => String(args.uuid ?? 'FEDCBA98-7654-4321-8ABC-0123456789ab'),
    ...(chapters === undefined ? {} : { chapters }),
  })
  if (!result.ok) return { ok: false, reason: result.reason, detail: withoutHostText(result.detail) }
  return { ok: true, identifier: result.identifier, report: result.report, zip: describeZip(result.bytes, bytes) }
}

/** A built book for the translation specs: an EPUB 3 book, an EPUB 2 vertical one, and variations. */
async function translationBooks(): Promise<Array<{ label: string; bytes: Uint8Array }>> {
  const files = epub3Files()
  const rich = {
    ...files,
    'OEBPS/text/chapter 1.xhtml': xhtml('One', '<h1 id="a">Heading <em>one</em></h1><p class="x" id="p1">First <b>bold</b> and <a href="#a">link</a><br/>line two</p><p/><ul><li id="l1">Item <i>one</i></li><li>Item two</li></ul><table><tr><td>Cell one</td><th xml:id="t">Head</th></tr></table><figure><figcaption>A caption</figcaption></figure><dl><dt>Term</dt><dd>Definition</dd></dl><blockquote>Quoted text here</blockquote><div>Division text</div><p>12345</p><p>  </p><p><ruby>\u6f22<rt>kan</rt></ruby>\u5b57 text</p>'),
    'OEBPS/text/c2.xhtml': xhtml('Two', '<h2 id="top">Second</h2><p dir="rtl" class="  ">\u05e9\u05dc\u05d5\u05dd</p><p class="a b ">Spaced class</p><p>Img <img src="x.png" alt="y"/> end</p>'),
  }
  return [
    { label: 'epub3', bytes: await buildEpub(files) },
    { label: 'epub3 with many block kinds', bytes: await buildEpub(rich) },
    { label: 'epub2 vertical rtl', bytes: await buildEpub(epub2Files(), 'content.opf') },
    { label: 'epub3 vertical', bytes: await buildEpub({ ...rich, 'OEBPS/styles/book.css': 'html { writing-mode: vertical-rl }' }) },
    { label: 'epub3 with a doctype-less chapter', bytes: await buildEpub({ ...rich, 'OEBPS/text/c2.xhtml': '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" dir="rtl"><body><p>Second one</p><p>Third</p></body></html>' }) },
    { label: 'epub3 with a broken chapter and a fixed-layout item', bytes: await buildEpub({ ...rich, 'OEBPS/text/c2.xhtml': '<p>broken<br>', 'OEBPS/content.opf': files['OEBPS/content.opf']!.replace('<itemref idref="notes" linear="no"/>', '<itemref idref="notes" properties="rendition:layout-pre-paginated"/>') }) },
    { label: 'epub3 with a self-closing metadata, a scheme and an unprefixed dc', bytes: await buildEpub({
      ...rich, 'OEBPS/content.opf': opf({ metadata: '<dc:identifier id="uid" opf:scheme="ISBN">urn:uuid:12345678-90ab-cdef-1234-567890abcdef</dc:identifier><dc:title>Only</dc:title><dc:language>fr-FR</dc:language>', manifest: '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c1"/><itemref idref="c2"/>' }),
    }) },
    { label: 'epub3 without identifiers and languages', bytes: await buildEpub({
      ...rich, 'OEBPS/content.opf': opf({ metadata: '<dc:title>Only title</dc:title><dc:title>Second title</dc:title>', manifest: '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c1"/>', packageAttrs: 'xmlns:x="urn:x"' }).replace(' unique-identifier="uid"', ''),
    }) },
    { label: 'epub3 with obfuscated fonts', bytes: await buildEpub({
      ...rich, 'OEBPS/fonts/a.otf': new Uint8Array(2000).map((_, i) => (i * 3) & 255),
      'META-INF/encryption.xml': '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/a.otf"/></enc:CipherData></enc:EncryptedData></encryption>',
    }) },
    { label: 'epub3 with a nav that is also a chapter', bytes: await buildEpub({
      ...rich, 'OEBPS/content.opf': files['OEBPS/content.opf']!.replace('<itemref idref="c1"/>', '<itemref idref="nav"/><itemref idref="c1"/>'),
    }) },
    { label: 'epub2 ncx nested', bytes: await buildEpub(epub2Files(), 'content.opf') },
  ]
}

const TRANSLATE_ARGS: Array<[string, Record<string, unknown>]> = [
  ['translated fr', { kind: 'translated', lang: 'fr', variant: 'all' }],
  ['bilingual fr', { kind: 'bilingual', lang: 'fr', variant: 'all' }],
  ['translated ar', { kind: 'translated', lang: 'ar', variant: 'all' }],
  ['bilingual he', { kind: 'bilingual', lang: 'he-IL', variant: 'markup' }],
  ['translated ja vertical', { kind: 'translated', lang: 'ja', variant: 'all' }],
  ['translated en horizontal', { kind: 'translated', lang: 'en', variant: 'rtl-labels' }],
  ['easy bilingual ko', { kind: 'bilingual', lang: 'ko', variant: 'half', mode: 'easy' }],
  ['easy translated zh-TW', { kind: 'translated', lang: 'zh-TW', variant: 'all', mode: 'easy' }],
  ['easy translated zh-Hant', { kind: 'translated', lang: 'zh-Hant', variant: 'half', mode: 'easy' }],
  ['half translated', { kind: 'bilingual', lang: 'de', variant: 'half' }],
  ['failed results', { kind: 'translated', lang: 'es', variant: 'failed' }],
  ['failed results without a reason', { kind: 'bilingual', lang: 'es', variant: 'failed-without-reason' }],
  ['placeholder mismatches', { kind: 'bilingual', lang: 'it', variant: 'mismatch' }],
  ['empty translations', { kind: 'translated', lang: 'pt', variant: 'empty' }],
  ['results without text', { kind: 'translated', lang: 'nl', variant: 'no-text' }],
  ['no results', { kind: 'translated', lang: 'ru', variant: 'none' }],
  ['one chapter', { kind: 'bilingual', lang: 'fr', variant: 'all', chapters: [1] }],
  ['chapter given twice and out of order', { kind: 'translated', lang: 'fr', variant: 'all', chapters: [1, 0, 1] }],
  ['a chapter that does not exist', { kind: 'translated', lang: 'fr', variant: 'all', chapters: [9] }],
  ['a negative chapter', { kind: 'translated', lang: 'fr', variant: 'all', chapters: [-1] }],
  ['a fractional chapter', { kind: 'translated', lang: 'fr', variant: 'all', chapters: [0.5] }],
  ['not a language tag', { kind: 'translated', lang: 'f', variant: 'all' }],
  ['a language tag with a trailing newline', { kind: 'translated', lang: 'fr\n', variant: 'all' }],
  ['a long subtag', { kind: 'translated', lang: 'en-123456789', variant: 'all' }],
  ['an upper case UUID', { kind: 'translated', lang: 'fr', variant: 'all', uuid: 'ABCDEF12-3456-7890-ABCD-EF1234567890' }],
  ['not a UUID', { kind: 'translated', lang: 'fr', variant: 'all', uuid: 'abc' }],
  ['a UUID with a space', { kind: 'translated', lang: 'fr', variant: 'all', uuid: '12345678-90ab-cdef-1234-567890abcde ' }],
  ['an invalid build time', { kind: 'translated', lang: 'fr', variant: 'all', now: 'NaN' }],
]

const SCRIPTS: Array<[string, { answers: Array<string | { throw: string }>; maxResends?: number | string; mode?: string; lang?: string }]> = [
  ['one good answer', { answers: ['GOOD'] }],
  ['a good answer in code fences with chatter', { answers: ['Sure!\n```json\n{"translations":[{"id":"1","text":"T"}]}\n```', 'GOOD'] }],
  ['partial answers then the rest', { answers: ['PARTIAL', 'GOOD'] }],
  ['nothing readable', { answers: ['no json here', '[', '{"x":1}'] }],
  ['nothing readable and no resend', { answers: ['no json'], maxResends: 0 }],
  ['placeholder mismatches that never fix', { answers: ['MISMATCH'] }],
  ['empty translations', { answers: ['EMPTY', 'EMPTY', 'GOOD'] }],
  ['the send throws', { answers: ['PARTIAL', { throw: 'rate limited' }] }],
  ['two resends allowed', { answers: ['PARTIAL', 'PARTIAL', 'GOOD'], maxResends: 2 }],
  ['one resend allowed', { answers: ['PARTIAL', 'PARTIAL', 'GOOD'], maxResends: 1 }],
  ['four resends', { answers: ['PARTIAL', 'PARTIAL', 'PARTIAL', 'PARTIAL', 'GOOD'], maxResends: 4 }],
  ['a fractional resend count', { answers: ['GOOD'], maxResends: 1.5 }],
  ['a negative resend count', { answers: ['GOOD'], maxResends: -1 }],
  ['a resend count that is not a number', { answers: ['GOOD'], maxResends: 'NaN' }],
  ['easy mode', { answers: ['PARTIAL', 'GOOD'], mode: 'easy', lang: 'ko' }],
  ['answers as a map', { answers: ['MAP'] }],
  ['answers as a bare list', { answers: ['LIST'] }],
  ['numeric ids and text that is not a string', { answers: ['NUMERIC', 'GOOD'] }],
]

const ANSWER_TEXTS: Array<[string, string]> = [
  ['a list under translations', '{"translations":[{"id":"1","text":"a"},{"id":2,"text":"b"}]}'],
  ['a bare list', '[{"id":"1","text":"a"}]'], ['a bare empty list', '[]'], ['an empty translations list', '{"translations":[]}'],
  ['a map of ids', '{"translations":{"1":"a","2":"b","x":3}}'], ['a bare object', '{"1":"a"}'], ['entries without a string text', '[{"id":"1","text":5},{"id":"2"},null,"s",[1],{"id":null,"text":"a"}]'],
  ['numeric ids', '[{"id":1,"text":"a"},{"id":1.5,"text":"b"},{"id":1e21,"text":"c"},{"id":-0,"text":"d"},{"id":9007199254740993,"text":"e"}]'],
  ['text around the json', 'Here you go: {"translations":[{"id":"1","text":"a"}]} done'], ['a first value of the wrong shape', '{"x":1} then [{"id":"1","text":"b"}]'],
  ['a stray bracket first', '[ not json {"translations":[{"id":"1","text":"c"}]}'], ['an unclosed value', '{"translations":[{"id":"1","text":"a"}'],
  ['braces in strings', '{"translations":[{"id":"1","text":"a } ] b"}]}'], ['escaped quotes', '{"translations":[{"id":"1","text":"say \\"hi\\" \\\\"}]}'],
  ['duplicate ids', '[{"id":"1","text":"a"},{"id":"1","text":"b"}]'], ['duplicate keys', '{"1":"a","1":"b"}'], ['translations that is a string', '{"translations":"x"}'],
  ['nothing', ''], ['only chatter', 'no braces'], ['a mismatched closer', '{"a":[}]'], ['unicode escapes', '[{"id":"1","text":"\\u00e9\\ud83d\\ude00"}]'],
  ['nested lists', '[[{"id":"1","text":"a"}]]'], ['a value that is not an object', '[1,2,3]'], ['a tab and a newline in text', '[{"id":"1","text":"a\\tb\\nc"}]'],
]

const TOKEN_TEXTS = ['', 'abcd', 'abcde', 'caf\u00e9', '\u6f22\u5b57\u304b\u306a\u30ab\u30ca\ud55c\uae00', 'mixed \u6f22 text \u00e9\u00e9', '\ud83d\ude00\ud83d\ude00', 'a'.repeat(1001), '\u0e01\u0e02', '\u0391\u03b2', '\u3000', '\u2e80\u2fd5', '\u31f0']

async function batchCall(input: Input): Promise<unknown> {
  const args = input.args ?? {}
  const texts = args.texts as string[]
  const items = texts.map((text, i) => ({ block: { text }, key: { pageFingerprint: 'p', textHash: String(i), occurrence: 0 } }))
  const max = args.maxTokens === undefined ? undefined : readNumber(args.maxTokens)
  return batchEpubTranslationItems(items, max === undefined ? {} : { maxTokens: max }).map(batch => batch.map(item => Number(item.key.textHash)))
}

async function modelCall(input: Input): Promise<unknown> {
  const args = input.args ?? {}
  const book = await openBook(input.bytes!)
  const all = book ? (await epubTranslationUnits(book)).units.filter(unit => unit.sources[0]?.kind === 'block').slice(0, 4) : []
  const items = all.map(unit => ({ block: unit, key: unit.key }))
  const goodText = (index: number): string => `T: ${all[index]!.text}`
  const answerFor = (id: string): string => {
    const asJson = (entries: Array<{ id: string | number; text?: unknown }>): string => JSON.stringify({ translations: entries })
    const ids = items.map((_, i) => String(i + 1))
    switch (id) {
      case 'GOOD': return asJson(ids.map((x, i) => ({ id: x, text: goodText(i) })))
      case 'PARTIAL': return asJson(ids.slice(0, 1).map((x, i) => ({ id: x, text: goodText(i) })))
      case 'MISMATCH': return asJson(ids.map(x => ({ id: x, text: 'no placeholders <x9/>' })))
      case 'EMPTY': return asJson(ids.map(x => ({ id: x, text: '  ' })))
      case 'MAP': return JSON.stringify({ translations: Object.fromEntries(ids.map((x, i) => [x, goodText(i)])) })
      case 'LIST': return JSON.stringify(ids.map((x, i) => ({ id: x, text: goodText(i) })))
      case 'NUMERIC': return asJson(ids.map((x, i) => ({ id: Number(x), text: i === 0 ? 5 : goodText(i) })))
      default: return id
    }
  }
  const answers = args.answers as Array<string | { throw: string }>
  const requests: unknown[] = []
  let call = 0
  const maxResends = args.maxResends === undefined ? undefined : readNumber(args.maxResends)
  try {
    const run = createEpubTranslationModelCall<EpubTranslationUnit>({
      lang: String(args.lang ?? 'fr'), ...(args.mode === undefined ? {} : { mode: args.mode as 'easy' }), ...(maxResends === undefined ? {} : { maxResends }),
      send: async request => {
        requests.push({ attempt: request.attempt, lang: request.lang, mode: request.mode ?? null, system: sha1(request.system), prompt: sha1(request.prompt) })
        const answer = answers[Math.min(call++, answers.length - 1)]!
        if (typeof answer !== 'string') throw new Error(answer.throw)
        return answerFor(answer)
      },
    })
    const results = await run(items, new AbortController().signal)
    return { ok: true, results: results.map(r => (r.status === 'translated' ? { status: r.status, text: units(r.text) } : { status: r.status, reason: r.reason })), requests }
  } catch (error) {
    const named = error as Error & { reason?: string }
    return { ok: false, name: named.name, message: named.message, reason: named.reason ?? null, requests }
  }
}

const noArgs = { extensions: [] as string[], mutation: 'text' as const }

export const SPECS: Spec[] = [
  { fn: 'parseXml', ...noArgs, call: ({ text = '' }) => parseXml(text), built: documents },
  { fn: 'parseHtml', ...noArgs, call: ({ text = '' }) => parseHtml(text), built: documents },
  {
    fn: 'resolveHtmlEntity', ...noArgs, mutation: 'none',
    call: ({ text = '' }) => resolveHtmlEntity(text) ?? null,
    built: () => {
      assertCopied('xml-positions.ts', SOURCE_FRAGMENT_TEXT)
      return ENTITY_NAMES.map(name => ({ label: JSON.stringify(name), text: name }))
    },
  },
  {
    fn: 'decodeCharacterData', ...noArgs,
    call: ({ text = '', args }) => units(decodeCharacterData(text, args?.withHtml === true)),
    built: () => RAW_TEXTS.flatMap(([label, text]) => [true, false].map(withHtml => ({ label: `${label} ${withHtml ? 'with' : 'without'} HTML`, text, args: { withHtml } }))),
  },
  { fn: 'parseXmlPositions', ...noArgs, call: ({ text = '' }) => flat(text), built: documents },
  {
    fn: 'checkWellFormed', ...noArgs,
    call: ({ text = '' }) => { const result = checkWellFormed(text); return result.ok ? { ok: true } : { ok: false, error: result.error, offset: result.offset } },
    built: documents,
  },
  {
    fn: 'textRawOffset', ...noArgs,
    call: ({ text = '', args }) => {
      const parsed = parseXmlPositions(text)
      if (!parsed.ok) return null
      const nodes = textNodes(parsed.doc.root)
      if (nodes.length === 0) return null
      return textRawOffset(parsed.doc, nodes[readNumber(args?.index ?? 0) % nodes.length]!, readNumber(args?.k ?? 0))
    },
    built: async () => {
      const inputs: Input[] = []
      for (const [label, text] of [...DOCUMENTS, ...CHAPTER_TEXTS].filter(([, text]) => text.length < 4000)) {
        for (const index of [0, 1, 2]) for (const k of [0, 1, 2, 5, 40, 100000]) inputs.push({ label: `${label} #${index} k=${k}`, text, args: { index, k } })
      }
      return inputs
    },
  },
  { fn: 'extractChapterText', ...noArgs, call: ({ text = '' }) => extractChapterText(text), built: async () => {
      assertCopied('text.ts', SOURCE_PARSE5_ROOTS_TEXT, SOURCE_PARSE5_ROOTS_LINES)
      return texts([...CHAPTER_TEXTS, ...(await parts()).slice(0, 20)])
    },
  },
  {
    fn: 'maskUndefinedEntities', ...noArgs, call: ({ text = '' }) => units(maskUndefinedEntities(text)),
    built: () => texts(MASK_TEXTS),
  },
  {
    fn: 'formatModifiedTimestamp', ...noArgs, mutation: 'none',
    call: ({ args }) => formatModifiedTimestamp(new Date(readNumber(args?.time))),
    built: () => NOW_CASES.map(([label, time]) => ({ label, args: { time: wireNumber(time) } })),
  },
  {
    fn: 'modifiedReplacements', ...noArgs,
    call: ({ text = '', args }) => modifiedReplacements(text, String(args?.timestamp ?? '2026-06-15T12:30:45Z'))?.map(r => ({ start: r.start, end: r.end, text: units(r.text) })) ?? null,
    built: () => texts(OPF_TEXTS),
  },
  {
    fn: 'epubTranslationUnits', ...noArgs, mutation: 'none', call: unitsCall,
    built: async () => (await translationBooks()).flatMap(({ label, bytes }) => [
      { label, bytes }, { label: `${label}: chapter 1`, bytes, args: { chapters: [1] } }, { label: `${label}: chapter 9`, bytes, args: { chapters: [9] } },
    ]),
  },
  {
    fn: 'buildTranslatedEpub', ...noArgs, mutation: 'none', call: buildCall,
    built: async () => (await translationBooks()).flatMap(({ label, bytes }) => TRANSLATE_ARGS.map(([name, args]) => ({ label: `${label}: ${name}`, bytes, args }))),
  },
  {
    fn: 'parseTranslationOutput', ...noArgs,
    call: ({ text = '' }) => [...(parseTranslationOutput(text) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, value]) => [id, units(value)]),
    built: () => texts(ANSWER_TEXTS).map(input => input),
  },
  {
    fn: 'estimateTokens', ...noArgs, call: ({ text = '' }) => estimateTokens(text),
    built: () => TOKEN_TEXTS.map(text => ({ label: JSON.stringify(text.slice(0, 20)), text })),
  },
  {
    fn: 'batchEpubTranslationItems', ...noArgs, mutation: 'none', call: batchCall,
    built: () => [
      ['empty', [], undefined], ['one unit', ['abc'], undefined], ['many small', Array.from({ length: 400 }, (_, i) => `unit ${i}`), undefined],
      ['over the budget alone', ['x'.repeat(40000), 'a', 'b'], undefined], ['budget of 20', ['a'.repeat(40), 'b'.repeat(40), 'c', 'd'], 20],
      ['budget exactly met', ['a'.repeat(8), 'b'.repeat(8), 'c'.repeat(8)], 10], ['budget of 0', ['a'], 0], ['negative budget', ['a'], -5], ['NaN budget', ['a'], 'NaN'],
      ['infinite budget', ['a', 'b'], 'Infinity'], ['fractional budget', ['a'.repeat(8), 'b'.repeat(8)], 10.5], ['cjk', ['\u6f22\u5b57'.repeat(300), '\u6f22'.repeat(500)], 700],
    ].map(([label, texts, maxTokens]) => ({ label: label as string, args: { texts, ...(maxTokens === undefined ? {} : { maxTokens: typeof maxTokens === 'number' ? wireNumber(maxTokens) : maxTokens }) } })),
  },
  {
    fn: 'createEpubTranslationModelCall', ...noArgs, mutation: 'none', call: modelCall,
    built: async () => {
      const books = (await translationBooks()).slice(0, 4)
      return books.flatMap(({ label, bytes }) => SCRIPTS.map(([name, args]) => ({ label: `${label}: ${name}`, bytes, args })))
    },
  },
  { fn: 'openEpub', extensions: ['epub'], mutation: 'zip-xml', call: ({ bytes }) => openCall(bytes!), built: bookInputs },
  { fn: 'saveEpub', extensions: ['epub'], mutation: 'zip-xml', call: input => saveCall(input), built: async () => [...(await saveInputs()), ...(await bookInputs())] },
]
