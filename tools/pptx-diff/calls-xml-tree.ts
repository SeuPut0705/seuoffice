// Group pptxXml: the object tree fast-xml-parser's XMLParser gives the slides
// engine, against crates/ooxml-xml/src/object.rs. One function, called with
// the options of every XMLParser the engine constructs. Those options are read
// from the engine source, and an option this file does not know stops the
// gate, so the comparison cannot drift from what the engine parses with.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { xmlParser } from '../../packages/pptx-engine/src/xml-parser'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

interface TreeOptions {
  trimValues?: boolean
  parseTagValue?: boolean
  arrayNames: string[]
}

const ENGINE_SOURCE = fileURLToPath(new URL('../../packages/pptx-engine/src/', import.meta.url))
/** Every option an engine parser sets besides `isArray`, as written. */
const FIXED_OPTIONS: Record<string, Partial<TreeOptions>> = {
  'ignoreAttributes: false': {},
  "attributeNamePrefix: '@_'": {},
  'trimValues: false': { trimValues: false },
  'parseTagValue: false': { parseTagValue: false },
}

/** The options of one `new XMLParser({ ... })` literal of the engine. */
function readOptions(where: string, literal: string): TreeOptions {
  const code = literal.replace(/\/\/.*$/gm, '')
  const isArrayAt = code.indexOf('isArray:')
  const fixed = isArrayAt === -1 ? code : code.slice(0, isArrayAt)
  const options: TreeOptions = { arrayNames: [] }
  for (const option of fixed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (!Object.hasOwn(FIXED_OPTIONS, option)) {
      throw new Error(`calls-xml-tree: ${where} sets ${option}, which this group does not model`)
    }
    Object.assign(options, FIXED_OPTIONS[option])
  }
  if (isArrayAt !== -1) {
    const isArray = code.slice(isArrayAt)
    if (
      !/^isArray: \(name\) =>\s*(\[[^\]]*\]\.includes\(name\)|name === '[^']*'(\s*\|\|\s*name === '[^']*')*),?\s*$/.test(
        isArray,
      )
    ) {
      throw new Error(`calls-xml-tree: ${where} has an isArray that is not a list of names`)
    }
    options.arrayNames = [...isArray.matchAll(/'([^']*)'/g)].map((match) => match[1]!)
  }
  return options
}

/** One entry per `xmlParser(...)` of the engine, named by file and line. */
const ENGINE_PARSERS: Array<[string, TreeOptions]> = readdirSync(ENGINE_SOURCE, {
  encoding: 'utf8',
  recursive: true,
})
  .filter((file) => file.endsWith('.ts') && file !== 'xml-parser.ts')
  .sort()
  .flatMap((file) => {
    const source = readFileSync(`${ENGINE_SOURCE}${file}`, 'utf8')
    return [...source.matchAll(/xmlParser\(\{([\s\S]*?)\}\)/g)].map(
      (match): [string, TreeOptions] => {
        const where = `${file.replace(/\\/g, '/')}:${source.slice(0, match.index).split('\n').length}`
        return [where, readOptions(where, match[1]!)]
      },
    )
  })
if (ENGINE_PARSERS.length === 0) throw new Error('calls-xml-tree: no xmlParser found in the engine')

/** The engine's option sets once each, as the arguments that cross the wire. */
const ENGINE_OPTIONS: TreeOptions[] = [
  ...new Map(ENGINE_PARSERS.map(([, options]) => [JSON.stringify(options), options])).values(),
]

/** Option sets the engine does not build, for branches its sets leave alone. */
const OTHER_OPTIONS: TreeOptions[] = [
  { trimValues: false, arrayNames: [] },
  { parseTagValue: false, arrayNames: [] },
  { arrayNames: ['a', 'b', 'r', '1', '@_b', '?xml', '#text', ':@', 'isPrototypeOf'] },
  { trimValues: false, parseTagValue: false, arrayNames: ['a', '@_b', '1'] },
]

function parseObject(text: string, args: Record<string, unknown>): unknown {
  const { trimValues, parseTagValue, arrayNames = [] } = args as Partial<TreeOptions>
  return xmlParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    ...(trimValues === undefined ? {} : { trimValues }),
    ...(parseTagValue === undefined ? {} : { parseTagValue }),
    isArray: (name) => arrayNames.includes(name),
  }).parse(text)
}

const nested = (depth: number, inner = ''): string =>
  '<a>'.repeat(depth) + inner + '</a>'.repeat(depth)

/** What the corpus lacks: each rule of the parser and of strnum, at its edges. */
const EDGES: string[] = [
  // strnum
  ...[
    '2026',
    ' 42 ',
    '-0',
    '0',
    '00',
    '007',
    '-007',
    '+9',
    '1.50',
    '0.0',
    '.5',
    '-.5',
    '5.',
    '1.',
    '+.5',
    '1e5',
    '1E-3',
    '-1e+2',
    '00e5',
    '0e5',
    '0.e5',
    '000.5e3',
    '-00.5e3',
    '0E5',
    '1e400',
    '-1e400',
    '0x1F',
    '-0x1f',
    '+0xa',
    '0X1F',
    '0x',
    '0xg',
    `0x${'f'.repeat(300)}`,
    '0b101',
    '0o7',
    'Infinity',
    '-Infinity',
    'NaN',
    '1234567890123456789',
    '12345678901234567890123',
    '9007199254740993',
    '0.1000000000000000055511151231257827',
    '1e21',
    '100000000000000000000000',
    '0.000001',
    '0.0000001',
    '1e-7',
    '1_000',
    '1 2',
    '1,5',
    '--1',
    '+-1',
    'true',
    ' false ',
    'True',
    'FALSE',
    '\u00a012\u00a0',
    '\ufeff7',
    '\u3000 3',
    '\u00858',
    '\u0661',
    '12abc',
    '.',
    '-',
    '+',
    'e5',
    '5e',
  ].map((text) => `<a>${text}</a>`),
  // CDATA: no trim, no entities, but coerced; the exponent check reads the untrimmed text
  '<a><![CDATA[ 12 ]]></a>',
  '<a><![CDATA[ 00e5]]></a>',
  '<a><![CDATA[00e5]]></a>',
  '<a><![CDATA[ -00.5e3 ]]></a>',
  '<a><![CDATA[]]></a>',
  '<a>x<![CDATA[]]>y</a>',
  '<a><![CDATA[1]]><![CDATA[2]]></a>',
  '<a>1<![CDATA[]]></a>',
  '<a><![CDATA[&amp;]]></a>',
  '<a><![CDATA[ true ]]></a>',
  '<a><![CDATA[<b/>]]></a>',
  '<a><![x]]>yz</a>',
  '<a><![CDATA[x]]>',
  // text pieces join, a number and a string alike
  '<a>1<b/>2</a>',
  '<a>1<b/>x</a>',
  '<a>true<b/>false</a>',
  '<a> 1 <b/> </a>',
  '<a>x<b>y</b>z<b>w</b></a>',
  '<a>  </a>',
  '<a>\n  <b/>\n</a>',
  '<a>x<!-- c -->y</a>',
  '<a><!-- <b/> --></a>',
  '<a>x\r\ny\rz</a>',
  // what collapses
  '<a/>',
  '<a></a>',
  '<a b="1"/>',
  '<a b="1">t</a>',
  '<a b="1"><c/></a>',
  '<a>t<c/></a>',
  '<a><c>1</c><c>2</c><d/><c>3</c></a>',
  '<r><x/><x/></r>',
  '<r><a>1</a><b>2</b><a>3</a></r>',
  // attributes
  '<a b=" 1 " c=\'2\' b="3" d e=f/>',
  '<a b="&lt;&amp;&#65;&#1;&gt;&quot;&apos;"/>',
  '<a b="&#1; x"/>',
  '<a b=" &#1;"/>',
  '<a b="x &#1;"/>',
  '<a constructor="1" toString="2" __proto__="3" hasOwnProperty="4"/>',
  '<a 2="x" 1="y" 0="z"/>',
  '<a b=""/>',
  '<a\tb="1"\tc="2"/>',
  '<a b="x>y"/>',
  '<a b=\'"\' c="\'"/>',
  '<a b="x\r\ny"/>',
  '<a b="1" b=" 2 ">t</a>',
  '<r a="1"><@_a>t</@_a></r>',
  // names
  '<toString/>',
  '<valueOf>1</valueOf>',
  '<isPrototypeOf/>',
  '<r><isPrototypeOf>1</isPrototypeOf><isPrototypeOf>2</isPrototypeOf></r>',
  '<r><2/><1/><b/><10/><1/><4294967295/><01/></r>',
  '<r><:@ x="1"/><:@>t</:@><b/></r>',
  '<r><!xml>a<b/>c</!xml></r>',
  '<r><>x</></r>',
  '<a/ b="1">x</a/>',
  '<r><a a/><b b>t</b></r>',
  '<a:p><a:r><a:t>x</a:t></a:r></a:p>',
  '<a:p/><a:p>1</a:p>',
  '<p:sldIdLst><p:sldId id="256"/><p:sldId id="257"/></p:sldIdLst>',
  '<Relationships><Relationship Id="rId1" Target="a"/></Relationships>',
  '<c:chart><c:ser><c:pt idx="0"><c:v>1</c:v></c:pt></c:ser></c:chart>',
  // a self-closing `#text` tag passes the name check; compress takes its empty child list for text
  '<#text/>',
  '<a><#text/></a>',
  '<a b="1"><#text/></a>',
  '<a><#text c="1"/><d/></a>',
  '<a><#text/>1</a>',
  '<a>1<#text/></a>',
  '<a><#text/><#text/></a>',
  '<r><a><#text/></a><a>x</a></r>',
  // text outside elements
  'text<a/>tail',
  'abc</x>',
  '<a/>tail',
  '<a>x</a></b>y',
  // processing instructions and the XML version
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a/>',
  '<?xml?><a/>',
  '<?pi?>',
  '<?xml version="1.1"?><a>&#1;x</a>',
  '<?xml version="1.1"?><a b="&#1;"/>',
  '<?xml version=" 1.1 "?><a>&#2;</a>',
  '<?xml version="1.10"?><a>&#3;</a>',
  'x<?pi a="1"?>',
  '<a><?pi b="1"?>t</a>',
  '<?a="1"?><a/>',
  // entities: one decoder, one pass (xml-parser.ts)
  '<a>r&amp;1|r&#38;1|r&#x26;1|rId&#49;</a>',
  '<a b="X&amp;#38;1" c="X&#38;1"/>',
  '<a>&#xD800;&#x110000;&#0;&#1;&#9;&#10;&#13;&#31;&#32;</a>',
  '<a>&#X41;&AMP;&#65 ;&#;&#x;</a>',
  '<a b="&#X41;&#x41;"/>',
  '<?xml version="1.1"?><a>&#1;&#x1F;x</a>',
  '<a>&#1114111;&#x10FFFF;&#1114112;</a>',
  '<a>&#999999999999999999999;&#x%s;</a>'.replace('%s', 'f'.repeat(40)),
  '<a>&lt;&gt;&amp;&quot;&apos;&nbsp;&#x41;&#0;&#xD800;&#65;</a>',
  '<a>&amp;lt;</a>',
  `<a>&${'x'.repeat(40)};</a>`,
  '<a>&#1;</a>',
  '<a> &#1; 5 </a>',
  '<a>&#1;7</a>',
  '<a>\uD55C\uAE00 \u{1F600}</a>',
  // refusals
  '<constructor/>',
  '<__proto__>',
  '<prototype a="1"/>',
  '<a></constructor>',
  '<a',
  '<a></a',
  '<?xml',
  '<!-- x',
  '<![CDATA[x',
  '<a/></a><b/>',
  '<a/></a><?pi?>',
  '<a/></a><![CDATA[x]]>',
  nested(101),
  nested(102),
  nested(101, '<b/>'),
]

/** Listed in divergences.json, so not seeds of the mutations. */
const LISTED: string[] = [
  // DOCTYPE is refused on purpose
  '<!DOCTYPE a><a/>',
  // a CDATA opener that splits a surrogate pair
  '<a><![CDATA\u{1F600}]]></a>',
]

const ALL_OPTIONS = [...ENGINE_OPTIONS, ...OTHER_OPTIONS]

export const XML_TREE: CallSpec[] = [
  {
    fn: 'pptxXml.parseObject',
    call: parseObject,
    fromDocument: (parts) =>
      [...parts.values()].flatMap((text): Input[] =>
        ENGINE_OPTIONS.map((args) => ({ text, args: { ...args } })),
      ),
    built: [
      ...EDGES.flatMap((text): Input[] => ALL_OPTIONS.map((args) => ({ text, args: { ...args } }))),
      ...LISTED.flatMap((text): Input[] =>
        ALL_OPTIONS.map((args) => ({ text, args: { ...args }, seed: false })),
      ),
    ],
  },
]
