import { SaxesParser, type SaxesOptions } from 'saxes'
import type { Input, Spec } from '../fileparse-diff/spec'

/**
 * `saxesEvents`: the real saxes parses a text with a handler on every event, and the list of events comes back with
 * the payload and `position`, `line`, `column` and `columnIndex` of the parser at that moment. The Rust recorder
 * (`crates/saxes/src/record.rs`) answers the same list.
 *
 * Arguments: `options` (SaxesOptions as JSON; `resolvePrefix` is a table), `units` (the text as UTF-16 units, for a
 * lone surrogate a JSON string cannot carry), `chunkSize`, `handlers` (the events listened to, all by default) and
 * `throwAt` (the handler throws after recording that event). A string that is not well formed is `{ $units }`; the
 * `attributes` and `ns` of a tag are lists of `[name, value]` in the order JavaScript lists the keys.
 */
type Wire = string | { $units: number[] }
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const wire = (text: string): Wire =>
  LONE.test(text)
    ? { $units: Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)) }
    : text
const fromUnits = (codes: readonly number[]): string => {
  let out = ''
  for (let i = 0; i < codes.length; i += 4096)
    out += String.fromCharCode(...codes.slice(i, i + 4096))
  return out
}

type Strings = Record<string, string>
interface WireArgs {
  options?: Record<string, unknown>
  units?: number[]
  chunkSize?: number
  handlers?: string[]
  throwAt?: number
}

function wireAttribute(attr: Strings): Record<string, Wire> {
  return Object.fromEntries(Object.keys(attr).map((key) => [key, wire(attr[key]!)]))
}

interface AnyTag {
  name: string
  attributes: Record<string, string | Strings>
  ns?: Strings
  prefix?: string
  local?: string
  uri?: string
  isSelfClosing?: boolean
}
function wireTag(tag: AnyTag): Record<string, unknown> {
  const out: Record<string, unknown> = { name: wire(tag.name) }
  out.attributes = Object.entries(tag.attributes).map(([name, value]) => [
    wire(name),
    typeof value === 'string' ? wire(value) : wireAttribute(value),
  ])
  if (tag.ns !== undefined)
    out.ns = Object.entries(tag.ns).map(([key, value]) => [wire(key), wire(value)])
  if (tag.prefix !== undefined) out.prefix = wire(tag.prefix)
  if (tag.local !== undefined) out.local = wire(tag.local)
  if (tag.uri !== undefined) out.uri = wire(tag.uri)
  if (tag.isSelfClosing !== undefined) out.isSelfClosing = tag.isSelfClosing
  return out
}

function parserOptions(given: Record<string, unknown> | undefined): SaxesOptions {
  const { resolvePrefix, ...rest } = given ?? {}
  const options: SaxesOptions = { ...rest }
  if (resolvePrefix !== undefined) {
    const table = resolvePrefix as Strings
    options.resolvePrefix = (prefix) => (Object.hasOwn(table, prefix) ? table[prefix] : undefined)
  }
  return options
}

export function recordSaxes(text: string, args: WireArgs): { events: unknown[]; thrown: unknown } {
  const events: unknown[] = []
  const source = args.units === undefined ? text : fromUnits(args.units)
  const thrown = (error: unknown) => {
    const e = error as Error
    return { name: e.name, message: wire(e.message) }
  }
  let parser: SaxesParser
  try {
    parser = new SaxesParser(parserOptions(args.options))
  } catch (error) {
    return { events, thrown: thrown(error) }
  }
  const listens = (name: string) => args.handlers === undefined || args.handlers.includes(name)
  const push = (event: string, data?: unknown): void => {
    events.push({
      event,
      ...(data === undefined ? {} : { data }),
      position: parser.position,
      line: parser.line,
      column: parser.column,
      columnIndex: parser.columnIndex,
    })
    if (args.throwAt === events.length - 1) throw new Error('stop')
  }
  // `on` is typed per event; the recorder registers every event by name
  const register = parser.on.bind(parser) as unknown as (
    name: string,
    handler: (value: never) => void,
  ) => void
  const on = <T>(name: string, data?: (value: T) => unknown): void => {
    if (!listens(name)) return
    register(name, (value: T) => push(name, data === undefined ? undefined : data(value)))
  }
  on<{ version?: string; encoding?: string; standalone?: string }>('xmldecl', (decl) =>
    Object.fromEntries(
      (['version', 'encoding', 'standalone'] as const)
        .filter((key) => decl[key] !== undefined)
        .map((key) => [key, wire(decl[key]!)]),
    ),
  )
  on<string>('text', wire)
  on<{ target: string; body: string }>('processinginstruction', (pi) => ({
    target: wire(pi.target),
    body: wire(pi.body),
  }))
  on<string>('doctype', wire)
  on<string>('comment', wire)
  on<AnyTag>('opentagstart', wireTag)
  on<Strings>('attribute', wireAttribute)
  on<AnyTag>('opentag', wireTag)
  on<AnyTag>('closetag', wireTag)
  on<string>('cdata', wire)
  on<Error>('error', (error) => wire(error.message))
  on('end')
  on('ready')
  let failure: unknown = null
  try {
    if (args.chunkSize === undefined || args.chunkSize <= 0) parser.write(source)
    else
      for (let i = 0; i < source.length; i += args.chunkSize)
        parser.write(source.slice(i, i + args.chunkSize))
    parser.close()
  } catch (error) {
    failure = thrown(error)
  }
  return { events, thrown: failure }
}

const HIGH = '\uD83D'
const LOW = '\uDE00'
const ASTRAL = HIGH + LOW

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

const NS_OPTIONS = { xmlns: true }
const OPTION_SETS: Array<Record<string, unknown> | undefined> = [
  undefined,
  NS_OPTIONS,
  { xmlns: true, position: false },
  { fileName: 'chapter.xhtml' },
  { position: false },
  { fragment: true },
  { fragment: true, xmlns: true },
  { defaultXMLVersion: '1.1' },
]

/** The documents every option set is run on. */
const XHTML_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Chapter 1 &amp; more</title>
  <link rel="stylesheet" type="text/css" href="../css/book.css"/>
</head>
<body epub:type="bodymatter">
  <!-- a comment -->
  <section epub:type="chapter" id="c1">
    <h1 class="title">Call me Ishmael&#8230;</h1>
    <p>Some years ago&#x2014;never mind how long &lt;precisely&gt;&#8212;having little or no money.</p>
    <p class="a b" style='color: red'>A <em>second</em> paragraph<br/>with a break &quot;quoted&quot; &apos;text&apos;.</p>
    <p><![CDATA[raw <b>markup</b> & more]]> after cdata</p>
    <?render mode="fast"?>
    <img src="a.png" alt="" epub:type="x"/>
  </section>
</body>
</html>
`

const DOCUMENTS: Array<[string, string]> = [
  ['empty', ''],
  ['one space', ' '],
  ['whitespace only', ' \t\r\n\r\n '],
  ['text only', 'hello'],
  ['one character', 'x'],
  ['a lone <', '<'],
  ['root element', '<a/>'],
  ['root with content', '<a>text</a>'],
  ['nested', '<a><b><c/></b><b/></a>'],
  ['two roots', '<a/><b/>'],
  ['two roots with text between', '<a/>text<b/>'],
  ['text before root', 'text<a/>'],
  ['text after root', '<a/>text'],
  ['text before and after root', 'a<r/>b'],
  ['entity before root', '&amp;<a/>'],
  ['unclosed', '<a><b>'],
  ['unclosed with text', '<a>x<b>y'],
  ['truncated open tag', '<a'],
  ['truncated attribute', '<a b'],
  ['truncated attribute value', '<a b="c'],
  ['truncated close tag', '<a></a'],
  ['truncated comment', '<a><!-- x'],
  ['truncated cdata', '<a><![CDATA[x'],
  ['truncated entity', '<a>&am'],
  // entity names at the end of the astral name characters: U+EFFFF is one, U+F0000 is not
  ['entity name of the last astral name character', '<a>&\u{EFFFF};</a>'],
  ['entity name ending in the last astral name character', '<a>&x\u{EFFFF};</a>'],
  ['entity name past the astral name characters', '<a>&\u{F0000};</a>'],
  ['entity name of the first astral name character', '<a>&\u{10000};</a>'],
  ['truncated pi', '<a><?x y'],
  ['truncated doctype', '<!DOCTYPE'],
  ['truncated doctype body', '<!DOCTYPE html'],
  ['truncated xml declaration', '<?xml version="1.0"'],
  ['mismatched close', '<a></b>'],
  ['crossed tags', '<a><b></a></b>'],
  ['close of nothing', '</a>'],
  ['close of nothing inside root', '<a></b></a>'],
  ['two closes of the same', '<a></a></a>'],
  ['empty close tag', '<a></></a>'],
  ['close tag with space', '<a></a >'],
  ['close tag with newline', '<a></a\n>'],
  ['close tag space then junk', '<a></a x>'],
  ['close tag with junk char', '<a></a!>'],
  ['space after <', '< a/>'],
  ['digit after <', '<1/>'],
  ['< then equals', '<=/>'],
  ['< at the end of text', '<a>1 < 2</a>'],
  ['unknown <! construct', '<a><!FOO></a>'],
  ['short <! construct', '<a><!-x></a>'],
  ['<![CDATA with typo', '<a><![CDATX[x]]></a>'],
  ['< before root then bang', '<!x'],
  // attributes
  ['attributes', '<a b="1" c=\'2\' d="3"/>'],
  ['attribute value entities', '<a b="x &amp; y &lt; &#65; &#x42;"/>'],
  ['attribute value whitespace', '<a b="x\ty\nz\r\nw\rv"/>'],
  ['attribute without value', '<a b/>'],
  ['attribute without value before >', '<a b>x</a>'],
  ['attribute without value then others', '<a b c="1" d/>'],
  ['attribute name then space then junk', '<a b !/>'],
  ['attribute name then space then name', '<a b c="1"/>'],
  ['attribute name then space then >', '<a b >x</a>'],
  ['unquoted attribute', '<a b=c/>'],
  ['unquoted attribute then >', '<a b=c>x</a>'],
  ['unquoted attributes', '<a b=c d=e f=g/>'],
  ['unquoted attribute with entity', '<a b=x&amp;y c=1/>'],
  ['unquoted attribute with ]]>', '<a b=x]]>y>z</a>'],
  ['unquoted attribute with <', '<a b=x<y/>'],
  ['quoted attribute with <', '<a b="x<y"/>'],
  ['attribute value with lone ]]>', '<a b="]]>"/>'],
  ['attribute junk', '<a !b="1"/>'],
  ['attribute name junk char', '<a b!="1"/>'],
  ['attribute name with quote', '<a "b"="1"/>'],
  ['attribute space equals space', '<a b = "1" c\n=\n\'2\'/>'],
  ['attributes without whitespace', '<a b="1"c="2"/>'],
  ['attribute junk after value', '<a b="1"!/>'],
  ['duplicate attribute', '<a b="1" b="2"/>'],
  ['duplicate attribute thrice', '<a b="1" c="x" b="2" b="3"/>'],
  ['slash in tag not followed by >', '<a / b="1"/>'],
  ['slash then junk', '<a/x>'],
  ['slash in the middle of attributes', '<a b="1" / c="2"/>'],
  ['attribute value entity unterminated at end', '<a b="&amp'],
  ['attribute value with astral char', `<a b="${ASTRAL}x"/>`],
  ['name with astral char', `<a${ASTRAL}/>`],
  ['attribute name with astral char', `<a ${ASTRAL}x="1"/>`],
  ['name with colon', '<a:b c:d="1"/>'],
  ['name with unicode letters', '<é à="1" ñ:ü="2"/>'],
  ['name with dot and dash', '<a-b.c d-e.f="1"/>'],
  ['name with middle dot and digits', '<a\u00B71 b2="1"/>'],
  ['name starting with a combining char', '<\u0300a/>'],
  ['name with U+2028', '<a\u2028b/>'],
  // namespaces
  ['default namespace', '<a xmlns="urn:a"><b/><c xmlns="urn:c"><d/></c><e/></a>'],
  [
    'prefixed namespaces',
    '<p:a xmlns:p="urn:p" xmlns:q="urn:q" q:x="1" p:y="2" z="3"><q:b/></p:a>',
  ],
  ['namespace redeclared', '<a xmlns:p="urn:1"><b xmlns:p="urn:2"><p:c/></b><p:d/></a>'],
  ['unbound tag prefix', '<p:a/>'],
  ['unbound attribute prefix', '<a p:b="1"/>'],
  ['unbound prefix with quote in name', '<p:a/><q:b/>'],
  ['xmlns prefix on a tag', '<xmlns:a xmlns:xmlns="urn:x"/>'],
  ['xml prefix bound right', `<a xmlns:xml="${XML_NS}" xml:lang="en"/>`],
  ['xml prefix bound wrong', '<a xmlns:xml="urn:x"/>'],
  ['xml prefix unbound is fine', '<a xml:lang="en"/>'],
  ['xmlns prefix bound wrong', '<a xmlns:xmlns="urn:x"/>'],
  ['xmlns prefix bound right', `<a xmlns:xmlns="${XMLNS_NS}"/>`],
  ['default namespace set to xmlns namespace', `<a xmlns="${XMLNS_NS}"/>`],
  ['prefix set to xmlns namespace', `<a xmlns:p="${XMLNS_NS}"/>`],
  ['default namespace set to xml namespace', `<a xmlns="${XML_NS}"/>`],
  ['prefix set to xml namespace', `<a xmlns:p="${XML_NS}"/>`],
  ['xml set to xml namespace', `<a xmlns:xml="${XML_NS}"/>`],
  ['undefine prefix in 1.0', '<a xmlns:p=""><p:b/></a>'],
  ['undefine default namespace', '<a xmlns="urn:a"><b xmlns=""><c/></b></a>'],
  [
    'undefine prefix in 1.1',
    '<?xml version="1.1"?><a xmlns:p="urn:p"><b xmlns:p=""><p:c/></b></a>',
  ],
  ['namespace value with spaces', '<a xmlns:p="  urn:p \n" xmlns="\turn:d\t"><p:b/></a>'],
  ['duplicate by namespace', '<a xmlns:p="urn:x" xmlns:q="urn:x" p:n="1" q:n="2"/>'],
  ['duplicate xmlns', '<a xmlns="urn:a" xmlns="urn:b"/>'],
  ['malformed names', '<a:b:c d:e:f="1" :g="2" h:="3"/>'],
  ['malformed tag name', '<:a/><b:/>'],
  ['colon only tag', '<:/>'],
  [
    'prefix named like an object property',
    '<constructor:a xmlns:constructor="urn:c" __proto__:b="1" xmlns:__proto__="urn:p"/>',
  ],
  ['integer-like prefixes', '<a xmlns:x1="u1" xmlns:y="u2" xmlns:a1="u3"/>'],
  ['digit prefix after start char', '<a xmlns:b1="u1"><b1:c/></a>'],
  ['namespaced attributes of a prefixed tag', '<p:a xmlns:p="urn:p" p:x="1" x="2" xmlns="urn:d"/>'],
  ['self closing namespaced', '<p:a xmlns:p="urn:p"/>'],
  ['ns in nested after pop', '<a xmlns:p="urn:p"><b xmlns:q="urn:q"/><p:c/><q:d/></a>'],
  ['unbound prefix on a quoted string needing escapes', '<a:\u0001b/>'],
  // processing instructions and the XML declaration
  ['xml declaration', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>'],
  ['xml declaration single quotes', "<?xml version='1.0' encoding='utf-8' standalone='no'?><a/>"],
  ['xml declaration version only', '<?xml version="1.0"?><a/>'],
  ['xml declaration with spaces', '<?xml  version = "1.0"  encoding = "UTF-8"   ?><a/>'],
  ['xml declaration with newlines', '<?xml\nversion="1.0"\r\nencoding="UTF-8"\n?><a/>'],
  ['xml declaration empty', '<?xml?><a/>'],
  ['xml declaration empty with space', '<?xml ?><a/>'],
  ['xml declaration without version', '<?xml encoding="UTF-8"?><a/>'],
  ['xml declaration standalone only', '<?xml standalone="yes"?><a/>'],
  ['xml declaration out of order', '<?xml encoding="UTF-8" version="1.0"?><a/>'],
  ['xml declaration repeated', '<?xml version="1.0" version="1.0"?><a/>'],
  ['xml declaration extra name', '<?xml version="1.0" foo="bar"?><a/>'],
  ['xml declaration extra name one char', '<?xml version="1.0" standalone="no" x="1"?><a/>'],
  [
    'xml declaration extra after standalone',
    '<?xml version="1.0" standalone="no" encoding="x"?><a/>',
  ],
  ['xml declaration bad version', '<?xml version="2.0"?><a/>'],
  ['xml declaration version 1.', '<?xml version="1."?><a/>'],
  ['xml declaration version 1.00', '<?xml version="1.00"?><a/>'],
  ['xml declaration version 1.5', '<?xml version="1.5"?><a/>'],
  ['xml declaration version 1.1', '<?xml version="1.1"?><a>\u0085\u2028</a>'],
  [
    'xml declaration version 1.1 with controls',
    '<?xml version="1.1"?><a>\u0001\u007F\u0080\u009F</a>',
  ],
  [
    'xml declaration version 1.1 with CR NEL',
    '<?xml version="1.1"?><a>x\r\u0085y\r\ny\rz\u0085w\u2028v</a>',
  ],
  ['xml declaration bad encoding', '<?xml version="1.0" encoding="1abc"?><a/>'],
  ['xml declaration odd encoding', '<?xml version="1.0" encoding="a.b_c-d9"?><a/>'],
  ['xml declaration empty encoding', '<?xml version="1.0" encoding=""?><a/>'],
  ['xml declaration bad standalone', '<?xml version="1.0" standalone="maybe"?><a/>'],
  ['xml declaration unquoted value', '<?xml version=1.0 ?><a/>'],
  ['xml declaration unquoted value then ?', '<?xml version=1.0?><a/>'],
  ['xml declaration no equals', '<?xml version "1.0"?><a/>'],
  ['xml declaration no equals and no quote', '<?xml version 1.0?><a/>'],
  ['xml declaration name then ?', '<?xml version?><a/>'],
  ['xml declaration name then = then ?', '<?xml version=?><a/>'],
  ['xml declaration name space ?', '<?xml version ?><a/>'],
  ['xml declaration ? inside value', '<?xml version="1?0"?><a/>'],
  ['xml declaration no space between pairs', '<?xml version="1.0"encoding="UTF-8"?><a/>'],
  ['xml declaration ? not followed by >', '<?xml version="1.0"?x><a/>'],
  ['xml declaration ?? ', '<?xml version="1.0"??><a/>'],
  ['xml declaration after whitespace', ' <?xml version="1.0"?><a/>'],
  ['xml declaration after a comment', '<!-- c --><?xml version="1.0"?><a/>'],
  ['xml declaration after the root', '<a/><?xml version="1.0"?>'],
  ['xml declaration inside the root', '<a><?xml version="1.0"?></a>'],
  ['xml declaration uppercase', '<?XML version="1.0"?><a/>'],
  ['xml declaration mixed case', '<?xMl version="1.0"?><a/>'],
  ['xml declaration unterminated value', '<?xml version="1.0'],
  ['xml declaration twice', '<?xml version="1.0"?><?xml version="1.0"?><a/>'],
  ['xml declaration with BOM', '\uFEFF<?xml version="1.0" encoding="UTF-8"?><a/>'],
  ['xml declaration with tab value', '<?xml version="1.0\t"?><a/>'],
  ['xml declaration with newline in value', '<?xml version="1.0\n"?><a/>'],
  ['xml declaration with CR in value', '<?xml version="1.0\r"?><a/>'],
  ['xml declaration forbidden char in name', '<?xml ve\u0001rsion="1.0"?><a/>'],
  ['processing instruction', '<a><?target some data?></a>'],
  ['processing instruction no body', '<a><?target?></a>'],
  ['processing instruction empty body space', '<a><?target ?></a>'],
  ['processing instruction question in body', '<a><?target a?b?></a>'],
  ['processing instruction double question', '<a><?target a??></a>'],
  ['processing instruction triple question', '<a><?target a???></a>'],
  ['processing instruction leading spaces', '<a><?target \n\t body \n?></a>'],
  ['processing instruction before root', '<?target data?><a/>'],
  ['processing instruction after root', '<a/><?target data?>'],
  ['processing instruction without target', '<a><? data?></a>'],
  ['processing instruction question without target', '<a><??></a>'],
  ['processing instruction bad first char', '<a><?1x data?></a>'],
  ['processing instruction bad char in name', '<a><?x!y data?></a>'],
  ['processing instruction name with colon', '<a><?x:y data?></a>'],
  ['processing instruction named xml-stylesheet', '<?xml-stylesheet href="a.css"?><a/>'],
  ['processing instruction named XML in root', '<a><?XML data?></a>'],
  ['processing instruction named Xml', '<a><?Xml data?></a>'],
  ['processing instruction named xml in root', '<a><?xml data?></a>'],
  ['processing instruction named xml', '<?xml ?>'],
  ['processing instruction with newlines', '<a><?t line1\nline2\r\nline3\r?></a>'],
  ['processing instruction with astral', `<a><?t${ASTRAL} ${ASTRAL}?></a>`],
  // doctype
  ['doctype', '<!DOCTYPE html><html/>'],
  [
    'doctype public',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html/>',
  ],
  ['doctype with internal subset', '<!DOCTYPE a [ <!ELEMENT a (#PCDATA)> <!ENTITY e "v"> ]><a/>'],
  ['doctype with comment in subset', '<!DOCTYPE a [ <!-- a comment --> <!ELEMENT a ANY> ]><a/>'],
  ['doctype with malformed comment in subset', '<!DOCTYPE a [ <!-- a -- b --> ]><a/>'],
  ['doctype with pi in subset', '<!DOCTYPE a [ <?pi data?> <!ELEMENT a ANY> ]><a/>'],
  ['doctype with pi question in subset', '<!DOCTYPE a [ <?pi a?b??> ]><a/>'],
  [
    'doctype with quotes in subset',
    '<!DOCTYPE a [ <!ENTITY e "a > b ] c"> <!ENTITY f \'x ]> y\'> ]><a/>',
  ],
  ['doctype with unterminated quote in subset', '<!DOCTYPE a [ <!ENTITY e "oops> ]><a/>'],
  ['doctype with > in quotes', '<!DOCTYPE a SYSTEM "x>y"><a/>'],
  ['doctype with [ in quotes', "<!DOCTYPE a SYSTEM 'x[y'><a/>"],
  ['doctype with newlines', '<!DOCTYPE\nhtml\r\nPUBLIC\r"x"\n"y"\n>\n<html/>'],
  ['doctype with newlines in subset', '<!DOCTYPE a [\n<!ENTITY e\r\n"v">\r\n]><a/>'],
  ['doctype with bang in subset', '<!DOCTYPE a [ <!ELEMENT a ANY> <!-x> ]><a/>'],
  ['doctype with dashes in subset', '<!DOCTYPE a [ <!----> <!--->--> <!-- - --> ]><a/>'],
  ['doctype with unknown bang in subset', '<!DOCTYPE a [ <!X Y> ]><a/>'],
  ['doctype with astral', `<!DOCTYPE ${ASTRAL} [ <!ENTITY e "${ASTRAL}"> ]><a/>`],
  ['doctype twice', '<!DOCTYPE a><!DOCTYPE a><a/>'],
  ['doctype after root', '<a/><!DOCTYPE a>'],
  ['doctype inside root', '<a><!DOCTYPE a></a>'],
  ['doctype after a comment', '<!-- c --><!DOCTYPE a><a/>'],
  ['doctype lowercase', '<!doctype html><html/>'],
  ['doctype typo', '<!DOCTYPX html><html/>'],
  ['doctype short', '<!DOC>'],
  ['doctype with ]]> in subset', '<!DOCTYPE a [ ]]> ]><a/>'],
  ['doctype entity then use', '<!DOCTYPE a [ <!ENTITY e "v"> ]><a>&e;</a>'],
  ['doctype unterminated subset', '<!DOCTYPE a [ <!ELEMENT a ANY>'],
  ['doctype unterminated comment in subset', '<!DOCTYPE a [ <!-- x'],
  ['doctype unterminated pi in subset', '<!DOCTYPE a [ <?x'],
  ['doctype unterminated quote', '<!DOCTYPE a "x'],
  // comments
  ['comment', '<a><!-- c --></a>'],
  ['comment empty', '<a><!----></a>'],
  ['comment with dashes', '<a><!-- a - b -- c --></a>'],
  ['comment ending with three dashes', '<a><!-- a ---></a>'],
  ['comment before root', '<!-- c --><a/>'],
  ['comment after root', '<a/><!-- c -->'],
  ['comment with newlines', '<a><!-- a\nb\r\nc\rd --></a>'],
  ['comment with markup', '<a><!-- <b>&amp;</b> --></a>'],
  ['comment with astral', `<a><!-- ${ASTRAL} --></a>`],
  ['comment ending -- not >', '<a><!-- x --y --></a>'],
  ['comment ending -- then dash', '<a><!-- x ---y --></a>'],
  ['comment with -- at the end of input', '<a><!-- x --'],
  ['comment with - at the end of input', '<a><!-- x -'],
  ['comment dashes only', '<!----->'],
  ['comment forbidden char', '<a><!-- x\u0001y --></a>'],
  // cdata
  ['cdata', '<a><![CDATA[ <b>&amp;</b> ]]></a>'],
  ['cdata empty', '<a><![CDATA[]]></a>'],
  ['cdata with brackets', '<a><![CDATA[a]b]]c]]]]></a>'],
  ['cdata with ]]]>', '<a><![CDATA[x]]]></a>'],
  ['cdata with ]]]]>', '<a><![CDATA[x]]]]></a>'],
  ['cdata with newlines', '<a><![CDATA[a\nb\r\nc\rd]]></a>'],
  ['cdata before root', '<![CDATA[x]]><a/>'],
  ['cdata after root', '<a/><![CDATA[x]]>'],
  ['cdata before and after root', '<![CDATA[x]]><![CDATA[y]]><a/><![CDATA[z]]><![CDATA[w]]>'],
  ['cdata with astral', `<a><![CDATA[${ASTRAL}]]></a>`],
  ['cdata with forbidden char', '<a><![CDATA[a\u0000b]]></a>'],
  ['cdata then text', '<a>x<![CDATA[y]]>z</a>'],
  ['cdata two in a row', '<a><![CDATA[x]]><![CDATA[y]]></a>'],
  ['cdata lowercase', '<a><![cdata[x]]></a>'],
  ['cdata unterminated by ]]', '<a><![CDATA[x]]'],
  // text and entities
  ['text with newlines', '<a>one\ntwo\r\nthree\rfour\n\rfive</a>'],
  ['text with CR at the end', '<a>x\r</a>'],
  ['text with tabs', '<a>\tx\t</a>'],
  ['text with ]]>', '<a>x ]]> y</a>'],
  ['text with ]]>>', '<a>]]>></a>'],
  ['text with ]]]>', '<a>]]]></a>'],
  ['text with ]] > ', '<a>]] ></a>'],
  ['text with ]]&gt;', '<a>]]&gt;</a>'],
  ['text with ]> ', '<a>]></a>'],
  ['text with ]]> after entity', '<a>&amp;]]></a>'],
  ['text with ]]> outside root', ']]><a/>]]>'],
  ['entities', '<a>&amp;&lt;&gt;&quot;&apos;</a>'],
  ['entity empty', '<a>&;</a>'],
  ['entity undefined', '<a>&nbsp;&foo;</a>'],
  ['entity bad name', '<a>&1a;&-x;&a b;&a:b;</a>'],
  ['entity with colon', '<a>&a:b;</a>'],
  ['entity unterminated', '<a>&amp</a>'],
  ['entity unterminated at the end of input', '<a>&amp'],
  ['entity with newline', '<a>&am\np;</a>'],
  ['entity with CRLF', '<a>&am\r\np;</a>'],
  [
    'entity name from the prototype chain',
    '<a>&constructor;&__proto__;&toString;&hasOwnProperty;</a>',
  ],
  ['entity case', '<a>&AMP;&Amp;&LT;</a>'],
  ['entity with astral name', `<a>&${ASTRAL};</a>`],
  ['character references', '<a>&#65;&#x41;&#x61;&#X41;&#0065;&#x0041;&#10;&#9;&#13;&#xD;</a>'],
  ['character reference empty', '<a>&#;&#x;</a>'],
  ['character reference bad digits', '<a>&#xZ;&#12a;&#x1G;&# 1;&#-1;&#+1;</a>'],
  ['character reference zero', '<a>&#0;&#x0;</a>'],
  ['character reference controls', '<a>&#1;&#8;&#11;&#12;&#14;&#31;&#127;&#128;&#133;&#159;</a>'],
  [
    'character reference controls in 1.1',
    '<?xml version="1.1"?><a>&#1;&#8;&#11;&#12;&#14;&#31;&#127;&#128;&#133;&#159;&#0;</a>',
  ],
  ['character reference surrogates', '<a>&#xD7FF;&#xD800;&#xDBFF;&#xDC00;&#xDFFF;&#xE000;</a>'],
  [
    'character reference noncharacters',
    '<a>&#xFFFD;&#xFFFE;&#xFFFF;&#x10000;&#x10FFFF;&#x110000;</a>',
  ],
  ['character reference astral', '<a>&#x1F600;&#128512;</a>'],
  [
    'character reference huge',
    `<a>&#${'9'.repeat(30)};&#x${'F'.repeat(30)};&#${'0'.repeat(30)}65;&#x${'0'.repeat(30)}41;</a>`,
  ],
  ['character reference in attribute', '<a b="&#65;&#x42;&#0;&bad;&amp;"/>'],
  ['character reference unquoted attribute', '<a b=&#65;x c=&amp;/>'],
  ['entity in unquoted attribute then >', '<a b=x&amp;>t</a>'],
  ['entity outside root', '&amp;'],
  ['entity after root', '<a/>&amp;'],
  ['entity then text outside root', '<a/>&amp; text'],
  ['only entity empty', '&;'],
  // characters
  ['forbidden control in text', '<a>x\u0001y</a>'],
  ['forbidden NUL', '<a>\u0000</a>'],
  ['forbidden controls', '<a>\u0002\u0003\u0008\u000B\u000C\u000E\u001F</a>'],
  ['forbidden U+FFFE', '<a>\uFFFE\uFFFF</a>'],
  ['allowed U+FFFD and U+E000', '<a>\uFFFD\uE000</a>'],
  ['DEL and C1 in 1.0', '<a>\u007F\u0080\u0085\u009F</a>'],
  ['NEL and LS in 1.0', '<a>\u0085\u2028\u2029</a>'],
  ['forbidden control in a name', '<a\u0001/>'],
  ['forbidden control in an attribute', '<a b="\u0001"/>'],
  ['forbidden control in a comment', '<a><!--\u0001--></a>'],
  ['forbidden control outside root', '\u0001<a/>'],
  ['astral text', `<a>${ASTRAL}x${ASTRAL}${ASTRAL}</a>`],
  ['astral text with newlines', `<a>${ASTRAL}\n${ASTRAL}\r\n${ASTRAL}\r${ASTRAL}</a>`],
  ['astral text outside root', `${ASTRAL}<a/>${ASTRAL}`],
  ['astral names', `<${ASTRAL}a ${ASTRAL}b="1"></${ASTRAL}a>`],
  ['astral beyond names', '<a>\u{EFFFF}\u{F0000}\u{10FFFF}</a>'],
  ['astral name chars', '<\u{10000}a \u{EFFFF}b="1" c\u{F0000}="2"/>'],
  ['BOM', '\uFEFF<a/>'],
  ['BOM then text', '\uFEFFx<a/>'],
  ['BOM then space', '\uFEFF <a/>'],
  ['two BOMs', '\uFEFF\uFEFF<a/>'],
  ['BOM in the middle', '<a>\uFEFF</a>'],
  ['BOM only', '\uFEFF'],
  ['CR LF document', '<a>\r\n<b>\r\n</b>\r\n</a>\r\n'],
  ['CR document', '<a>\r<b>\r</b>\r</a>\r'],
  ['LF CR document', '<a>\n\r<b>\n\r</b></a>'],
  ['CR LF between attributes', '<a\r\nb="1"\r\nc="2"\r\n/>'],
  ['CR before root', '\r\n\r\n<a/>'],
  ['CR only', '\r'],
  ['CRLF only', '\r\n'],
  ['text with only CR', '<a>\r</a>'],
  ['NL in names region', '<a\n>x</a\n>'],
  ['lines and columns', '<a>\n  <b>\n    x\n  </b>\n  <c d="1"\n     e="2"/>\n</a>\n'],
  ['XHTML chapter', XHTML_CHAPTER],
  ['XHTML chapter with CRLF', XHTML_CHAPTER.replaceAll('\n', '\r\n')],
  ['XHTML chapter with BOM', `\uFEFF${XHTML_CHAPTER}`],
  ['XHTML chapter truncated', XHTML_CHAPTER.slice(0, 600)],
  [
    'EPUB nav',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
<li><a href="ch1.xhtml">Chapter 1</a></li>
<li><a href="ch2.xhtml#s1">Chapter 2 &amp; 3</a><ol><li><a href="ch2.xhtml#s2">Sub</a></li></ol></li>
</ol></nav>
</body>
</html>`,
  ],
  [
    'EPUB package',
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:1</dc:identifier><dc:title>T</dc:title><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata>
<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="a"/></spine>
</package>`,
  ],
  [
    'NCX',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="n1" playOrder="1"><navLabel><text>One</text></navLabel><content src="a.xhtml"/></navPoint></navMap></ncx>`,
  ],
  [
    'SVG',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><image xlink:href="a.png" width="1" height="1"/><text x="0" y="1">T</text></svg>',
  ],
  ['Korean text', '<p lang="ko">안녕하세요 &amp; 세계</p>'],
]

/** Documents whose events depend on the chunking: every chunk boundary is a place the carry-over can fail. */
const CHUNKED: string[] = [
  XHTML_CHAPTER,
  '<a>\r\n<b c="d\r\ne"/>\r</a>',
  `<a>${ASTRAL}${ASTRAL}x${ASTRAL}</a>`,
  '<?xml version="1.1"?><a>x\r\u0085y\u2028z\r</a>',
  '\uFEFF<a/>',
  '<a>&amp;&#65;&lt;</a>',
  '<!DOCTYPE a [ <!-- c --> <?p x?> ]><a><![CDATA[x]]]]></a>',
  '<a b=c d="e"></a >',
  '<a xmlns:p="u"><p:b p:c="1"/></a>',
  '<a>]]></a>',
  '<a><!-- x -- y --></a>',
  '<?xml version="1.0"?><a/>',
]

function built(): Input[] {
  const inputs: Input[] = []
  const add = (label: string, text: string, args: WireArgs, extra: Partial<Input> = {}): void => {
    inputs.push({ label, text, args: args as Record<string, unknown>, ...extra })
  }
  for (const [name, text] of DOCUMENTS) {
    for (const options of OPTION_SETS) {
      add(
        `${name} ${JSON.stringify(options ?? {})}`,
        text,
        options === undefined ? {} : { options },
      )
    }
  }
  // options the documents above meet less often
  const extra: Array<[string, Record<string, unknown>, string]> = [
    ['default 1.1', { defaultXMLVersion: '1.1' }, '<a>x\r\u0085y\u2028\u0001\u007F</a>'],
    [
      'forced 1.1',
      { defaultXMLVersion: '1.1', forceXMLVersion: true },
      '<?xml version="1.0"?><a>x\u0085y</a>',
    ],
    [
      'forced 1.0 against a 1.1 declaration',
      { defaultXMLVersion: '1.0', forceXMLVersion: true },
      '<?xml version="1.1"?><a>x\u0085y</a>',
    ],
    [
      'forced with an undefining declaration',
      { defaultXMLVersion: '1.1', forceXMLVersion: true, xmlns: true },
      '<?xml version="1.0"?><a xmlns:p=""/>',
    ],
    ['default 2.0', { defaultXMLVersion: '2.0' }, '<a>x\u0085y</a>'],
    [
      'default 1.0 not forced against 1.1',
      { defaultXMLVersion: '1.0' },
      '<?xml version="1.1"?><a>x\u0085y</a>',
    ],
    ['force without default', { forceXMLVersion: true }, '<a/>'],
    ['force false without default', { forceXMLVersion: false }, '<a/>'],
    ['fileName only', { fileName: 'book.opf' }, '<a><b></a>'],
    ['fileName empty', { fileName: '' }, '<a><b></a>'],
    ['fileName empty without position', { fileName: '', position: false }, '<a><b></a>'],
    ['fileName without position', { fileName: 'x.xml', position: false }, '<a><b></a>'],
    ['fileName with astral', { fileName: `f${ASTRAL}.xml` }, '<a><b></a>'],
    ['fragment with text', { fragment: true }, 'text <b>bold</b> more &amp; <c/> tail'],
    ['fragment with two roots', { fragment: true }, '<a/><b/>text'],
    ['fragment with cdata', { fragment: true }, '<![CDATA[x]]>y'],
    ['fragment with declaration', { fragment: true }, '<?xml version="1.0"?><a/>'],
    ['fragment with doctype', { fragment: true }, '<!DOCTYPE a><a/>'],
    ['fragment with close tag', { fragment: true }, '</a>'],
    ['fragment with unclosed', { fragment: true }, '<a><b>'],
    ['fragment empty', { fragment: true }, ''],
    ['fragment with namespaces', { fragment: true, xmlns: true }, '<p:a xmlns:p="u"/><p:b/>'],
    [
      'additional namespaces',
      { xmlns: true, additionalNamespaces: { x: 'urn:x', '': 'urn:d' } },
      '<x:a><b x:c="1"/></x:a>',
    ],
    [
      'additional namespaces override',
      { xmlns: true, additionalNamespaces: { xml: XML_NS, p: 'urn:p' } },
      '<p:a xml:lang="en"/>',
    ],
    [
      'additional namespaces ignored without xmlns',
      { additionalNamespaces: { x: 'urn:x' } },
      '<x:a/>',
    ],
    [
      'additional namespaces bad xml',
      { xmlns: true, additionalNamespaces: { xml: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces bad xmlns',
      { xmlns: true, additionalNamespaces: { xmlns: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces xmlns uri',
      { xmlns: true, additionalNamespaces: { p: XMLNS_NS } },
      '<a/>',
    ],
    [
      'additional namespaces xmlns uri default',
      { xmlns: true, additionalNamespaces: { '': XMLNS_NS } },
      '<a/>',
    ],
    [
      'additional namespaces xml uri default',
      { xmlns: true, additionalNamespaces: { '': XML_NS } },
      '<a/>',
    ],
    [
      'additional namespaces xml uri other',
      { xmlns: true, additionalNamespaces: { p: XML_NS } },
      '<a/>',
    ],
    [
      'additional namespaces bad xml with fileName',
      { xmlns: true, fileName: 'f.xml', additionalNamespaces: { xml: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces bad xml without position',
      { xmlns: true, position: false, additionalNamespaces: { xml: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces bad xml with fileName without position',
      { xmlns: true, position: false, fileName: 'f.xml', additionalNamespaces: { xml: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces second bad',
      { xmlns: true, additionalNamespaces: { ok: 'urn:ok', xmlns: 'urn:x' } },
      '<a/>',
    ],
    [
      'additional namespaces integer keys',
      { xmlns: true, additionalNamespaces: { 2: 'urn:2', b: 'urn:b', 1: 'urn:1' } },
      '<a/>',
    ],
    [
      'additional namespaces then redeclared',
      { xmlns: true, additionalNamespaces: { p: 'urn:outer' } },
      '<a xmlns:p="urn:inner"><p:b/></a>',
    ],
    [
      'resolvePrefix',
      { xmlns: true, resolvePrefix: { ext: 'urn:ext', empty: '' } },
      '<ext:a ext:b="1" empty:c="2"/>',
    ],
    ['resolvePrefix without xmlns', { resolvePrefix: { ext: 'urn:ext' } }, '<ext:a/>'],
    [
      'resolvePrefix after declaration',
      { xmlns: true, resolvePrefix: { p: 'urn:r' } },
      '<a xmlns:p="urn:d"><p:b/></a><p:c/>',
    ],
    [
      'resolvePrefix with proto',
      { xmlns: true, resolvePrefix: { ['__proto__']: 'u', constructor: 'c' } },
      '<a/>',
    ],
    ['position false with errors', { position: false }, '<a><b></a>'],
    ['position false chunked', { position: false }, '<a b=1></c>'],
  ]
  for (const [name, options, text] of extra)
    add(`${name} ${JSON.stringify(options)}`, text, { options })
  // chunking: a CR or the first half of a pair at the end of a chunk is carried to the next
  for (const text of CHUNKED) {
    for (const chunkSize of [1, 2, 3, 5, 7, 64]) {
      add(`chunks of ${chunkSize}: ${JSON.stringify(text.slice(0, 40))}`, text, { chunkSize })
      if (chunkSize <= 3)
        add(`namespaced chunks of ${chunkSize}: ${JSON.stringify(text.slice(0, 40))}`, text, {
          chunkSize,
          options: NS_OPTIONS,
        })
    }
  }
  // handlers left off: no text handler changes what is kept, no error handler makes fail throw
  const bodies = [
    '<a>x&amp;y<![CDATA[z]]></a>',
    '<a></></a>',
    '</a>',
    '<a b="x&amp;y"/>',
    '<a>t</b>t2</a>',
    '<?x y?>t',
    '<a>&foo;<b/>',
    '<?xml version="1.0"?><a/>',
    '<a>x]]>y</a>',
  ]
  const all = [
    'xmldecl',
    'text',
    'processinginstruction',
    'doctype',
    'comment',
    'opentagstart',
    'attribute',
    'opentag',
    'closetag',
    'cdata',
    'error',
    'end',
    'ready',
  ]
  for (const body of bodies) {
    for (const off of [
      ['text'],
      ['error'],
      ['text', 'error'],
      ['end', 'ready', 'opentagstart', 'attribute'],
      all,
    ]) {
      add(`without ${off.join('+')}: ${JSON.stringify(body)}`, body, {
        handlers: all.filter((name) => !off.includes(name)),
      })
    }
    add(`text off, chunks of 2: ${JSON.stringify(body)}`, body, {
      handlers: all.filter((name) => name !== 'text'),
      chunkSize: 2,
    })
  }
  // a handler that throws: the parse stops there
  for (const body of ['<a b="1">t<!--c--><?p q?></a>', '<a><b></a>', '<a>&bad;</a>']) {
    for (const throwAt of [0, 1, 2, 3, 5])
      add(`throws at ${throwAt}: ${JSON.stringify(body)}`, body, { throwAt })
  }
  // lone surrogates cross as units
  const unitCases: Array<[string, number[], WireArgs]> = [
    [
      'lone high in text',
      [...'<a>x']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d],
          [...'y</a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone low in text',
      [...'<a>x']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xde00],
          [...'y</a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'high then low swapped',
      [...'<a>']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xde00, 0xd83d],
          [...'</a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    ['high at the very end', [...'<a>x</a>'].map((c) => c.charCodeAt(0)).concat([0xd83d]), {}],
    [
      'high at the end of an open element',
      [...'<a>x'].map((c) => c.charCodeAt(0)).concat([0xd83d]),
      {},
    ],
    ['high alone', [0xd83d], {}],
    ['low alone', [0xde00], {}],
    ['high then letter', [0xd83d, 0x61, 0x3c, 0x61, 0x2f, 0x3e], {}],
    ['high then newline', [0x3c, 0x61, 0x3e, 0xd83d, 0x0a, 0x78, 0x3c, 0x2f, 0x61, 0x3e], {}],
    ['high then CR', [0x3c, 0x61, 0x3e, 0xd83d, 0x0d, 0x0a, 0x78, 0x3c, 0x2f, 0x61, 0x3e], {}],
    ['high then <', [0x3c, 0x61, 0x3e, 0xd83d, 0x3c, 0x2f, 0x61, 0x3e], {}],
    [
      'high then high then low',
      [0x3c, 0x61, 0x3e, 0xd83d, 0xd83d, 0xde00, 0x3c, 0x2f, 0x61, 0x3e],
      {},
    ],
    [
      'high then BMP in an attribute',
      [...'<a b="']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0x78],
          [...'"/>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    ['lone surrogate in a name', [0x3c, 0x61, 0xd83d, 0x62, 0x2f, 0x3e], {}],
    ['lone low in a name', [0x3c, 0x61, 0xde00, 0x62, 0x2f, 0x3e], {}],
    [
      'lone surrogates in a comment',
      [...'<a><!--']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0xde00, 0xde00, 0xd83d],
          [...'--></a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in a pi',
      [...'<a><?t']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0x20, 0xde00],
          [...'?></a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in a pi target start',
      [0x3c, 0x61, 0x3e, 0x3c, 0x3f, 0xd83d, 0x20, 0x78, 0x3f, 0x3e, 0x3c, 0x2f, 0x61, 0x3e],
      {},
    ],
    [
      'lone surrogate in a doctype',
      [...'<!DOCTYPE a [']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0xde00, 0xd83d],
          [...'] ><a/>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in an entity',
      [...'<a>&a']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d],
          [...'b;</a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in a cdata',
      [...'<a><![CDATA[']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d],
          [...']]></a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in the xml declaration',
      [...'<?xml version="1.0']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d],
          [...'"?><a/>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in the xml declaration name',
      [...'<?xml ']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0x78],
          [...'="1"?><a/>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in an xml 1.1 document',
      [...'<?xml version="1.1"?><a>']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xde00, 0xd83d, 0x0d],
          [...'</a>'].map((c) => c.charCodeAt(0)),
        ),
      {},
    ],
    [
      'lone surrogate in an unbound prefix',
      [0x3c, 0xd83d, 0x3a, 0x61, 0x2f, 0x3e],
      { options: NS_OPTIONS },
    ],
    [
      'lone surrogate in a duplicate attribute',
      [...'<a ']
        .map((c) => c.charCodeAt(0))
        .concat([
          0x78, 0xd83d, 0x3d, 0x22, 0x31, 0x22, 0x20, 0x78, 0xd83d, 0x3d, 0x22, 0x32, 0x22, 0x2f,
          0x3e,
        ]),
      {},
    ],
    ['lone surrogate in an unclosed tag name', [0x3c, 0x61, 0xd83d, 0x62, 0x3e], {}],
    ['lone surrogate in a closing tag', [0x3c, 0x61, 0x3e, 0x3c, 0x2f, 0x61, 0xd83d, 0x3e], {}],
    [
      'lone surrogate in a namespace prefix',
      [...'<a xmlns:p']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0x78],
          [...'="u"/>'].map((c) => c.charCodeAt(0)),
        ),
      { options: NS_OPTIONS },
    ],
    [
      'high at the end, chunked',
      [...'<a>x'].map((c) => c.charCodeAt(0)).concat([0xd83d]),
      { chunkSize: 2 },
    ],
    [
      'pair split by chunks',
      [...'<a>x']
        .map((c) => c.charCodeAt(0))
        .concat(
          [0xd83d, 0xde00],
          [...'y</a>'].map((c) => c.charCodeAt(0)),
        ),
      { chunkSize: 1 },
    ],
    [
      'lone surrogates chunked',
      [0x3c, 0x61, 0x3e, 0xd83d, 0x78, 0xde00, 0xd83d, 0x3c, 0x2f, 0x61, 0x3e],
      { chunkSize: 3 },
    ],
    [
      'lone surrogate with namespaces and position',
      [0x3c, 0x61, 0x3e, 0xd83d, 0x3c, 0x2f, 0x61, 0x3e],
      { options: { xmlns: true, fileName: 'x' } },
    ],
    [
      'lone surrogate in text, in a fragment',
      [0x78, 0xd83d, 0x3c, 0x61, 0x2f, 0x3e],
      { options: { fragment: true } },
    ],
    ['high at the end in a fragment', [0x78, 0xd83d], { options: { fragment: true } }],
    [
      'high at the end of a fragment, no text handler',
      [0x78, 0xd83d],
      { options: { fragment: true }, handlers: ['error', 'end'] },
    ],
    ['text of units', [...'<a>héllo wörld</a>'].map((c) => c.charCodeAt(0)), {}],
  ]
  for (const [name, codes, args] of unitCases)
    add(name, '', { ...args, units: codes }, { mutate: false })
  return inputs
}

export const SPECS: Spec[] = [
  {
    fn: 'saxesEvents',
    extensions: [],
    mutation: 'text',
    call: ({ text = '', args = {} }) => recordSaxes(text, args as WireArgs),
    built,
  },
]
