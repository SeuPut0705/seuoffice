// Group `leaves` of comparison (f): scan.ts, xml-utils.ts, slide-ids.ts,
// named-action.ts, table-grid.ts and crc32.ts of packages/pptx-engine. The
// Rust side answers in crates/office-wasm/src/calls/pptx_leaves.rs to
// `pptxLeaves.<module>.<TypeScript name>`.
import { XMLParser } from 'fast-xml-parser'
import { crc32 } from './reference/crc32'
import {
  namedActionAttr,
  namedActionOf,
  NAMED_ACTIONS,
} from './reference/named-action'
import { scanSlide } from './reference/scan'
import {
  canListSlide,
  nextSlideId,
  withSlideListed,
  withSlideUnlisted,
} from './reference/slide-ids'
import { tableRowGridCols } from './reference/table-grid'
import {
  asXmlNode,
  attributeOf,
  cSldNameOf,
  creationIdExtXml,
  creationIdXml,
  decodeXml,
  defaultContentTypeFor,
  elementRange,
  percentFraction,
  canonicalXml,
  escapeXmlAttr,
  escapeXmlText,
  hasContentTypeOverride,
  hasDefaultFor,
  maxRelationshipIdNumber,
  rootPrefixOf,
  withRelationshipIds,
  xmlArray,
} from './reference/xml-utils'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

/**
 * `run` with `crypto.randomUUID` answering `uuid`. creationIdExtXml draws a
 * UUID; the Rust side takes it as an argument.
 */
export function withUuid<T>(uuid: string, run: () => T): T {
  const host = globalThis.crypto
  const own = Object.getOwnPropertyDescriptor(host, 'randomUUID')
  Object.defineProperty(host, 'randomUUID', {
    value: () => uuid,
    configurable: true,
    writable: true,
  })
  try {
    return run()
  } finally {
    if (own) Object.defineProperty(host, 'randomUUID', own)
    else Reflect.deleteProperty(host, 'randomUUID')
  }
}

/** Entity references only: a numeric one could name a lone surrogate, which JSON cannot carry to Rust. */
const unescapeXml = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const SHAPE_TREE_PART =
  /^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters)\/[^/]+\.xml$/
const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/

const partsMatching = (parts: ReadonlyMap<string, string>, name: RegExp): string[] =>
  [...parts].filter(([path]) => name.test(path)).map(([, text]) => text)

/** Distinct captures of `re` over the texts, at most `cap`. */
function capturesOf(texts: string[], re: RegExp, cap = 30): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      if (found.size >= cap) return [...found]
      found.add(m[1]!)
    }
  }
  return [...found]
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

/** A slide whose spTree opener is `open` and whose shape tree holds `tree`. */
const slideWith = (tree: string, open = '<p:spTree>', close = '</p:spTree>'): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  `<p:sld ${NS}><p:cSld>${open}${tree}${close}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

const slide = (tree: string): string => slideWith(tree)

const NV =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const sp = (id: number, text = 'x', attrs = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"${attrs}/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const pic = (id: number): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
  '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>'

const ALTERNATE =
  '<mc:AlternateContent><mc:Choice Requires="cx1"><p:graphicFrame><p:nvGraphicFramePr>' +
  '<p:cNvPr id="9" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm/><a:graphic><a:graphicData uri="x"/></a:graphic></p:graphicFrame></mc:Choice>' +
  `<mc:Fallback>${pic(10)}</mc:Fallback></mc:AlternateContent>`

const SCAN_TEXTS: string[] = [
  slide(NV),
  slide(''),
  slide(NV + sp(2) + sp(3)),
  slide(NV + sp(2) + '\n  ' + sp(3) + '<p:contentPart r:id="rId9"/>' + pic(4) + '\r\n'),
  slide(NV + ALTERNATE + sp(11)),
  slide(NV + '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>' + sp(5) + pic(6) + '</p:grpSp>' + '<p:cxnSp/>'),
  slide(NV + sp(2, '\u{1F600}\u{1D4B3} \uD55C\uAE00') + '<!-- \u{1F600} -->' + sp(3, '\u00e9')),
  slide(NV + sp(2) + '<!-- <p:sp> </p:sp> </p:spTree> -->' + sp(3)),
  '<!-- <p:spTree> -->' + slide(NV + sp(2)),
  slide(NV + sp(4, 'a', ' descr="a>b" title=\'q"<x\'') + sp(5)),
  slide(NV + '<p:sp/><p:pic /><p:graphicFrame\t/>' + sp(7)),
  slide(NV + sp(2, '<![CDATA[ <p:sp> ]]>')),
  slide(NV + '<?mso-application progid="x"?>' + sp(2) + '<?pi ?>'),
  slideWith(NV + sp(2), '<p:spTree a="1>" b=\'2\'>'),
  slideWith(NV + sp(2), '<p:spTree\u00a0x="1">'),
  slideWith(NV + sp(2), '<p:spTree\uFEFF>'),
  slideWith(NV, '<p:spTree/>', ''),
  '<p:spTreeX>' + slide(NV + sp(2)),
  slideWith(NV + sp(2), '<p:spTree>', '</ p:spTree >'),
  slideWith(NV + sp(2), '<p:spTree>', '</p:spTree\n>'),
  slide(NV + sp(2) + '<p:extLst><p:ext uri="{x}"><p14:creationId val="1"/></p:ext></p:extLst>'),
  slide(NV + '<p:extLst/>' + sp(2) + '<p:extLst><p:ext/></p:extLst>' + sp(3)),
  slide(NV + '<1abc></1abc>' + sp(2)),
  slide(NV + '< p:sp>< /p:sp>' + sp(3)),
  slide(NV + '<P:SP></P:SP><p:sp ></p:sp >'),
  slide(NV + '<p:sp a="x></p:sp>' + sp(3)),
  slide(NV + sp(2) + "<p:sp b='unterminated>" + sp(3)),
  slide(NV + sp(2) + '<mc:AlternateContent/>' + '\u{1F600}' + '<p:pic/>'),
  'no shape tree at all',
  '',
  slideWith(NV + sp(2), '<p:spTree>', ''),
  slide(NV + sp(2) + '</p:cSld>'),
  slide(NV + '</>'),
  slide(NV + sp(2) + '</p:sp>'),
  slide(NV + '<p:sp><p:sp></p:sp>'),
  `<p:spTree>${'<p:sp/>'.repeat(50)}</p:spTree>`,
  `<p:spTree>${sp(2)}\t</p:spTree>${'\u{1F600}'.repeat(3)}`,
]

/** Values of a parsed tree down to depth 3: element nodes, lists of them, texts, numbers. */
function treeValues(texts: string[], cap = 30): Input[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const values: unknown[] = []
  const walk = (value: unknown, depth: number): void => {
    if (values.length >= cap) return
    // a number JSON cannot carry (a text like 1e999) would reach Rust as null
    if (typeof value === 'number' && !Number.isFinite(value)) return
    values.push(value)
    if (depth >= 3 || typeof value !== 'object' || value === null) return
    for (const child of Object.values(value)) walk(child, depth + 1)
  }
  for (const text of texts) {
    try {
      walk(parser.parse(text), 0)
    } catch {
      // a part the parser refuses gives no values
    }
  }
  return values.map((value) => ({ args: { value } }))
}

const NODE_VALUES: unknown[] = [
  null,
  0,
  1,
  -1,
  0.5,
  '',
  'a',
  '0',
  true,
  false,
  [],
  [null, 0, 'x', {}, [1], { '@_id': '2' }],
  {},
  { '@_id': '1', '#text': 'x' },
  { 'p:sp': [{ '@_id': '1' }, { '@_id': '2' }] },
]

const nodeInputs: Input[] = [{}, ...NODE_VALUES.map((value) => ({ args: { value } }))]

const DECODE_TEXTS = [
  '&amp;&lt;&gt;&quot;&apos;',
  'r&amp;1|r&#38;1|r&#x26;1|rId&#49;',
  'X&amp;#38;1',
  '&amp;amp;',
  '&#1;&#8;&#9;&#xA;&#xD;&#xB;&#x1F;&#x20;',
  '&#X41;&#x4a;&#x4A;',
  '&AMP;&Amp;&nbsp;&copy;&apos',
  '&#65 ;&# 65;&#+65;',
  '&',
  '&&amp;&',
  '&#65;',
  '&#x41;&#X41;',
  '&#x1F600;',
  '&#128512;',
  '&#xD800;',
  '&#55296;',
  '&#xDFFF;&#xE000;',
  '&#x110000;',
  '&#1114111;',
  '&#x10FFFF;',
  '&#0;',
  '&#x0;',
  '&#0000065;',
  `&#${'9'.repeat(25)};`,
  `&#x${'f'.repeat(300)};`,
  '&#;',
  '&#x;',
  '&amp;#65;',
  'a&#65',
  'plain text',
  '',
  '&#xFFFE;&#9;&#10;',
  '&#x00000041;&#x+41;&#-65;',
  '\u{1F600}&#x1f600;\uD55C',
]

/** Comments, CDATA sections and end tags with white space before their `>`, among other markup. */
const CANONICAL_TEXTS = [
  '',
  '<a:p><a:r><a:t>plain</a:t></a:r></a:p>',
  '<a:p><!-- </a:p> --><a:r><a:t>x</a:t></a:r></a:p>',
  '<a:p><a:r><a:t><![CDATA[<b> & </a:r> "q"]]></a:t></a:r></a:p>',
  '<a:t><![CDATA[]]></a:t>',
  '<a:t><![CDATA[a]]><![CDATA[b]]]]></a:t>',
  '<a:p><a:r><a:t>x</a:t></a:r ></a:p\t>',
  '<a:p><a:r><a:t>x</a:t></a:r\r\n></a:p \u00A0\uFEFF>',
  '<a:p></a:p\u0085>',
  '<a:p x=">" y=\'>\'></a:p >',
  '<a:p x="</a:p >"></a:p>',
  '<!-- unterminated <a:p></a:p >',
  '<![CDATA[ unterminated </a:p >',
  '<a:t>a</a:t><!--x--><!--y-->',
  '<!---->',
  '<?xml version="1.0"?><!DOCTYPE x><a:p></a:p >',
  '<a:t>\u{1F600}<![CDATA[\u{1F600}<]]></a:t></a:t >',
  '< /a:p>',
  '</ >',
  '</a:p >< ',
  '<a:t>"unclosed</a:t >',
]

const ESCAPE_TEXTS = [
  '',
  'plain',
  '<a & b>"\'',
  '&amp;',
  '\u0000a\u0001\u0008\t\n\r\u000b\u000c\u000e\u001f\u007f',
  '\ufffe\uffff\ufffd',
  '\u{1F600}\u{10FFFF}',
  '\u0085\u2028\u00a0',
  'x\u000by\u000cz',
]

const RELS = (ids: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  ids +
  '</Relationships>'

const RELS_TEXTS = [
  RELS(''),
  RELS('<Relationship Id="rId1" Target="a"/><Relationship Id="rId12" Target="b"/>'),
  RELS("<Relationship Id='rId7' Target='a'/><Relationship Id = \"rId3\"/>"),
  RELS('<Relationship TargetId="rId99" xId="rId98" Id="rId2"/>'),
  RELS('<Relationship Id="rId5\'/><Relationship Id="RID40"/><Relationship Id="rid41"/>'),
  RELS(`<Relationship Id="rId${'9'.repeat(400)}"/>`),
  RELS('<Relationship Id="rId9007199254740993"/>'),
  RELS('<Relationship Id="rId0"/><Relationship Id="rId007"/>'),
  RELS('<Relationship Id="rIdx"/><Relationship Id="rId-3"/>'),
  'Id="rId8"',
]

const CT = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  body +
  '</Types>'

const CONTENT_TYPES = CT(
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    "<Default ContentType='image/png' Extension='PNG'/>" +
    '<Default\nExtension = "jpeg" ContentType="image/jpeg">' +
    '<DefaultX Extension="gif"/>' +
    '<Default ContentType="Extension=\'svg\'"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="x"/>' +
    "<Override PartName='/ppt/slides/slide1.xml' ContentType='y'/>" +
    '<Override PartName = "/ppt/a b.xml"/>' +
    '<Override PartName="/ppt/\nnewline.xml"/>' +
    '<Override PartName="/PPT/Upper.xml"/>' +
    '<Override PartName="/ppt/mixed.xml\'/>' +
    '<Override PartName=""/>',
)

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const ATTRIBUTE_ELEMENTS = [
  '<a a="1" b="2"/>',
  '<a a=\'1\' b="2">',
  '<a\ta\n=\r"1"/>',
  '<a a = "x&amp;y&#38;z&#x26;"/>',
  '<a a="1" a="2"/>',
  '<a:b r:id="rId&#49;" name=\'q"r\'/>',
  '<a id="1">',
  '<a><b id="inner"/></a>',
  '<a x="a>b" id="after"/>',
  '<a id="unclosed',
  '<a id=1/>',
  '<a ID="1" Id="2"/>',
  '<a xmlns:p="u" xmlns:p="v"/>',
  '<a name="\u{1F600}&#x1F600;"/>',
  'a name="no-open-tag">',
  '',
  '<a name="constructor" __proto__="x"/>',
  '<a name=""/>',
]
const ROOT_XMLS = [
  `<?xml version="1.0"?><p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"/>`,
  `<p:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}"/>`,
  `<sld xmlns="${P_NS}"/>`,
  `<a:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}" xmlns="${P_NS}"/>`,
  `<p:sld xmlns:q="${P_NS}" xmlns:p="urn:x"/>`,
  `<sld xmlns='${P_NS}'/>`,
  `<sld xmlns = "${P_NS}" />`,
  `<p:sld xmlns:p="${P_NS.replace('/main', '/m&#97;in')}"/>`,
  `<p:sld xmlns:p="a&amp;b"/>`,
  '<!-- c --><!DOCTYPE x><x:y xmlns:x="urn:x"/>',
  '<?xml version="1.0"?>',
  '<sld',
  '',
  "<p:sld xmlns:p='a\"b'>",
  `<sld xmlns:="${P_NS}" xmlnsp="${P_NS}" xmlns:p:q="${P_NS}"/>`,
  `<p:sld xmlns:p="${P_NS}" xmlns:p="urn:x"/>`,
  `<s:sld xmlns:s="">`,
  '<a:b xmlns:a=">"/>',
]
const RANGE_XMLS = [
  '<a:t>x</a:t>',
  '<a:t/>',
  '<a:t />',
  '<a:t><a:t>in</a:t></a:t><a:t>after</a:t>',
  '<a:t>unclosed',
  '</a:t><a:t>x</a:t>',
  '<a:t x=">">y</a:t>',
  "<a:t x='>'>y</a:t>",
  '<a:t/><a:t>x</a:t>',
  '<a:t>x</a:t><a:t/>',
  '<a:t><a:t/></a:t>',
  '<a:tx>no</a:tx><a:t>yes</a:t>',
  '<!-- <a:t>c</a:t> --><a:t>real</a:t>',
  '<?pi a:t?><a:t>x</a:t>',
  '<![CDATA[<a:t>c</a:t>]]><a:t>x</a:t>',
  '<b><b><b/></b></b><b/>',
  '\u{1F600}<a:t>\u{1F600}</a:t>\u{1F600}',
  '<q:é>é</q:é>',
  '<a:t\n>x</a:t\n>',
  '<a:t>x</ a:t></a:t>',
  '<p:x a="1"/>',
  '',
]
const REL_XMLS = [
  '<a:blip r:embed="rId1"/>',
  "<a:blip r:embed='rId1' r:link='rId2'/>",
  '<a:blip r:embed = "rId&#49;"/>',
  '<a:blip r:embed="rId1"/><a:blip r:embed="rId2"/>',
  '<a:blip r:embed="rId2" r:id="rId1"/>',
  '<a:blip xr:embed="rId1" r:embed2="rId1"/>',
  '<a:blip r:embed="r&amp;1"/>',
  '<a:blip r:embed="constructor" r:id="__proto__"/>',
  "<a:blip r:embed='it\"s'/>",
  '<a:blip r:embed="rId1" a:embed="rId1"/>',
  '<a:blip r:embed=""/>',
  '<a:blip r:embed=rId1/>',
  '',
]
const REL_ID_MAPS: Record<string, string>[] = [
  {},
  { rId1: 'rId2' },
  { rId1: 'rId2', rId2: 'rId1' },
  { rId1: '$&' },
  { rId1: "it's" },
  { rId1: 'a"b' },
  { 'r&1': 'x<y' },
  { rId1: 'rId$1$$' },
  JSON.parse('{"constructor":"c","__proto__":"p"}') as Record<string, string>,
  { '': 'empty' },
]
const PART_PATHS = [
  'ppt/presentation.xml',
  'ppt/slides/slide1.xml',
  'ppt/a b.xml',
  'ppt/\nnewline.xml',
  'ppt/upper.xml',
  'PPT/Upper.xml',
  '/ppt/presentation.xml',
  'ppt/mixed.xml',
  '',
  'ppt/slides/slide2.xml',
]

const EXTS = [
  'rels',
  'xml',
  'png',
  'PNG',
  'jpeg',
  'gif',
  'svg',
  'mp4',
  '',
  '.',
  'p.g',
  'pn.',
  'a|xml',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '?',
  '*',
  '\\',
  'x{2}',
  '\\1',
  '(?:x)',
]

const UUIDS = [
  'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
  '00000000-0000-4000-8000-000000000000',
  'ABCDEF01-2345-4678-9ABC-DEF012345678',
  'aBcD-eF',
  '',
  'stra\u00dfe-\u01c6-\ufb03-\u0131-\u00ff',
  '<"&>',
  '\u{1F600}',
]

const presentation = (list: string): string =>
  `<p:presentation ${NS}><p:sldMasterIdLst/>${list}<p:sldSz cx="1" cy="1"/></p:presentation>`

const sldIds = (...tags: string[]): string => `<p:sldIdLst>${tags.join('')}</p:sldIdLst>`

const PRESENTATIONS = [
  presentation(''),
  presentation(sldIds('<p:sldId id="256" r:id="rId2"/>', '<p:sldId id="257" r:id="rId3"/>')),
  presentation(sldIds("<p:sldId id='300' r:id='rId2'/>", '<p:sldId\tid="400"/>')),
  presentation(sldIds('<p:sldId id="2147483647" r:id="rId2"/>')),
  presentation(
    sldIds(
      '<p:sldId id="2147483647"/>',
      '<p:sldId id="256"/>',
      '<p:sldId id="257"/>',
      '<p:sldId id="259"/>',
    ),
  ),
  presentation(
    sldIds('<p:sldId id="2147483648"/>', '<p:sldId id="99999999999"/>', '<p:sldId id="255"/>'),
  ),
  presentation(sldIds('<p:sldId id="00300"/>', '<p:sldId r:id="rId2" id="500"/>')),
  presentation(sldIds('<p:sldId id="300" r:id="7"/>')),
  presentation(sldIds('<p:sldId id = "600"/>', '<p:sldId id="-700"/>', '<p:sldId id="7e2"/>')),
  presentation(sldIds(`<p:sldId id="${'9'.repeat(400)}"/>`, '<p:sldId id="1000"/>')),
  presentation(sldIds('<p:sldId/>', '<p:sldIdLst id="900"/>', '<p:sldId\u00a0id="901"/>')),
  presentation(sldIds('<p:sldId id="2147483646"/>')),
]

/** Presentation parts for the list writers: every form of list, entry and r:id the writers read. */
const LISTED_PRESENTATIONS = [
  ...PRESENTATIONS,
  presentation(sldIds('<p:sldId id="256" r:id="rId2"/>', '<p:sldId id="257" r:id="rId3"/>')),
  presentation(sldIds("<p:sldId id='256' r:id='rId2'/>", '<p:sldId id="257" r:id = "rId3"/>')),
  presentation(sldIds('<p:sldId id="256" r:id="rId&#50;"/>', '<p:sldId id="257" r:id="rId3"/>')),
  presentation(
    sldIds(
      '<p:sldId id="256" r:id="rId2"><p:extLst/></p:sldId>',
      '<p:sldId id="257" r:id="rId3"/>',
    ),
  ),
  presentation(sldIds('<p:sldId id="256" r:id="rId2"><p:ext>$&</p:ext></p:sldId >')),
  presentation('<p:sldIdLst />'),
  presentation('<p:sldIdLst></p:sldIdLst >'),
  presentation('<p:sldIdLst/>'),
  presentation('<sldIdLst><sldId id="256" r:id="rId2"/></sldIdLst>'),
  presentation('<x:sldIdLst><x:sldId id="256" r:id="rId2"/></x:sldIdLst>'),
  presentation('<p:sldIdLst><p:sldId id="256" r:id="rId2"/>'),
  presentation(
    sldIds('<p:sldId id="256" r:id="rId2"/>') + sldIds('<p:sldId id="300" r:id="rId3"/>'),
  ),
  presentation(sldIds('<p:sldId id="2147483647" r:id="rId2"/>', '<p:sldId id="2147483646"/>')),
  presentation(
    sldIds('<p:sldId id="256" xr:id="rId2"/>', '<p:sldId id="257" r:id="rId2" r:id="rId3"/>'),
  ),
  presentation(sldIds('<p:sldId id="256" r:id=\'a"b\'/>', '<p:sldId id="257" r:id="rId3"/>')),
  presentation(sldIds('<p:sldId id="256" r:id="r&amp;1"/>')),
  presentation(sldIds('<p:sldId id="256" r:id="constructor"/>')),
  '',
]

const ACTIONS = [
  ...NAMED_ACTIONS.map((name) => `ppaction://hlinkshowjump?jump=${name}`),
  'ppaction://hlinkshowjump?jump=',
  'ppaction://hlinkshowjump?jump=nextslide ',
  'ppaction://hlinkshowjump?jump=NextSlide',
  'PPACTION://hlinkshowjump?jump=endshow',
  'ppaction://hlinksldjump',
  'ppaction://hlinkshowjump?jump=constructor',
  'ppaction://hlinkshowjump?jump=__proto__',
  'nextslide',
  '',
]

const cell = (gridSpan?: number | null, merged?: boolean): Record<string, unknown> => ({
  ...(gridSpan === undefined ? {} : { gridSpan }),
  ...(merged === undefined ? {} : { merged }),
})

const ROWS: Array<Array<Record<string, unknown>>> = [
  [],
  [cell()],
  [cell(), cell(), cell()],
  [cell(2), cell(undefined, true), cell()],
  [cell(2), cell()],
  [cell(3), cell(1, true), cell(undefined, true), cell(2)],
  [cell(3), cell(undefined, true)],
  [cell(2), cell(undefined, false), cell()],
  [cell(2.5), cell(undefined, true), cell(undefined, true), cell()],
  [cell(2.5), cell(undefined, true)],
  [cell(0), cell(-1), cell(1), cell(0.5)],
  [cell(1e308), cell(1e308), cell()],
  [cell(null), cell(null, true)],
  [cell(4), cell(undefined, true), cell(undefined, true), cell(undefined, true), cell(2)],
  [cell(1, true), cell(2, true), cell(1, true)],
]

/** Rows of every a:tbl of the slides: gridSpan and hMerge of each a:tc. */
function rowsOf(parts: ReadonlyMap<string, string>): Input[] {
  const rows: Input[] = []
  for (const text of partsMatching(parts, SLIDE_PART)) {
    for (const [tr] of text.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      const row = [...tr.matchAll(/<a:tc\b([^>]*)>/g)].map(([, attrs]) => {
        const span = /\bgridSpan="([^"]*)"/.exec(attrs!)?.[1]
        const merge = /\bhMerge="([^"]*)"/.exec(attrs!)?.[1]
        return cell(
          // NaN would cross JSON as null, which reads as no span
          span === undefined || !Number.isFinite(Number(span)) ? undefined : Number(span),
          merge === undefined ? undefined : merge === '1' || merge === 'true',
        )
      })
      rows.push({ args: { row } })
      if (rows.length >= 30) return rows
    }
  }
  return rows
}

const BYTES: number[][] = [[], [0], [255], [0, 0, 0, 0], Array.from({ length: 256 }, (_, i) => i)]

export const LEAVES: CallSpec[] = [
  {
    fn: 'pptxLeaves.scan.scanSlide',
    call: (text) => scanSlide(text),
    fromDocument: (parts) => partsMatching(parts, SHAPE_TREE_PART).map((text) => ({ text })),
    built: SCAN_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.asXmlNode',
    call: (_text, args) => asXmlNode(args.value),
    fromDocument: (parts) =>
      treeValues([
        parts.get('ppt/presentation.xml') ?? '',
        ...partsMatching(parts, SLIDE_PART).slice(0, 2),
      ]),
    built: nodeInputs,
    mutation: 'none',
  },
  {
    fn: 'pptxLeaves.xml-utils.xmlArray',
    call: (_text, args) => xmlArray(args.value),
    fromDocument: (parts) =>
      treeValues([
        parts.get('ppt/presentation.xml') ?? '',
        ...partsMatching(parts, SLIDE_PART).slice(0, 2),
      ]),
    built: nodeInputs,
    mutation: 'none',
  },
  {
    fn: 'pptxLeaves.xml-utils.percentFraction',
    call: (_text, args) => percentFraction(args.raw),
    mutation: 'none',
    built: [
      ...[
        '50%',
        '50000',
        '-25%',
        ' 7% ',
        '%',
        '',
        'abc',
        '1e3',
        '1e999%',
        'Infinity',
        '0',
        '-0',
        '100000',
        '12.5%',
        '50 %',
        '0x10',
      ].map((raw) => ({ args: { raw } })),
      { args: { raw: 75000 } },
      { args: { raw: null } },
      { args: {} },
      { args: { raw: true } },
      { args: { raw: ['50%'] } },
    ],
  },
  {
    fn: 'pptxLeaves.xml-utils.decodeXml',
    call: (text) => decodeXml(text),
    fromDocument: (parts) => [
      ...[...parts.values()].filter((text) => text.includes('&#')).map((text) => ({ text })),
      ...capturesOf(partsMatching(parts, SLIDE_PART), /<a:t>([^<]*)<\/a:t>/g, 20).map((text) => ({
        text,
      })),
    ],
    built: DECODE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.canonicalXml',
    call: (text) => canonicalXml(text),
    fromDocument: (parts) => [...partsMatching(parts, SLIDE_PART)].map((text) => ({ text })),
    built: CANONICAL_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.escapeXmlText',
    call: (text) => escapeXmlText(text),
    fromDocument: (parts) =>
      capturesOf(partsMatching(parts, SLIDE_PART), /<a:t>([^<]*)<\/a:t>/g).map((t) => ({
        text: unescapeXml(t),
      })),
    built: ESCAPE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.escapeXmlAttr',
    call: (text) => escapeXmlAttr(text),
    fromDocument: (parts) =>
      capturesOf(partsMatching(parts, SHAPE_TREE_PART), /\bname="([^"]*)"/g).map((t) => ({
        text: unescapeXml(t),
      })),
    built: ESCAPE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.maxRelationshipIdNumber',
    call: (text) => maxRelationshipIdNumber(text),
    fromDocument: (parts) =>
      [...parts].filter(([path]) => path.endsWith('.rels')).map(([, text]) => ({ text })),
    built: RELS_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.hasContentTypeOverride',
    call: (text, args) => hasContentTypeOverride(text, args.partPath as string),
    fromDocument: (parts) => {
      const text = parts.get('[Content_Types].xml')
      if (text === undefined) return []
      return [...[...parts.keys()].slice(0, 20), 'ppt/slides/slide999.xml'].map((partPath) => ({
        text,
        args: { partPath },
      }))
    },
    built: PART_PATHS.map((partPath) => ({ text: CONTENT_TYPES, args: { partPath } })),
  },
  {
    fn: 'pptxLeaves.xml-utils.creationIdExtXml',
    call: (text) => withUuid(text, () => creationIdExtXml()),
    fromDocument: (parts) =>
      capturesOf(
        partsMatching(parts, SHAPE_TREE_PART),
        /<a16:creationId\b[^>]*\bid="\{([^"}]*)\}"/g,
      ).map((id) => ({ text: id.toLowerCase() })),
    built: UUIDS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.creationIdXml',
    call: (text) => withUuid(text, () => creationIdXml()),
    fromDocument: (parts) =>
      capturesOf(
        partsMatching(parts, SHAPE_TREE_PART),
        /<a16:creationId\b[^>]*\bid="\{([^"}]*)\}"/g,
      ).map((text) => ({ text })),
    built: UUIDS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.hasDefaultFor',
    call: (text, args) => hasDefaultFor(text, args.ext as string),
    fromDocument: (parts) => {
      const text = parts.get('[Content_Types].xml')
      if (text === undefined) return []
      const declared = capturesOf([text], /\bExtension="([^"]*)"/g)
      return [...declared, 'png', 'jpeg', 'glb', 'xlsx', 'mp4'].map((ext) => ({
        text,
        args: { ext },
      }))
    },
    built: EXTS.flatMap((ext) => [
      { text: CONTENT_TYPES, args: { ext } },
      { text: CT(''), args: { ext } },
    ]),
  },
  {
    fn: 'pptxLeaves.xml-utils.defaultContentTypeFor',
    call: (text, args) => defaultContentTypeFor(text, args.ext as string),
    fromDocument: (parts) => {
      const text = parts.get('[Content_Types].xml')
      if (text === undefined) return []
      return [...capturesOf([text], /\bExtension="([^"]*)"/g), 'png', 'jpeg'].map((ext) => ({
        text,
        args: { ext },
      }))
    },
    built: [...EXTS, 'JPEG', 'Gif', 'pn&#103;', 'toString', '__proto__', 'constructor'].flatMap(
      (ext) => [
        { text: CONTENT_TYPES, args: { ext } },
        { text: CT(''), args: { ext } },
        { text: CT('<Default Extension="p&#110;g" ContentType="a&amp;b"/>'), args: { ext } },
        {
          text: CT(
            "<Default Extension='toString' ContentType='t'/><Default Extension=\"__proto__\"/>",
          ),
          args: { ext },
        },
        {
          text: CT('<Default Extension="PnG"/><Default Extension="png" ContentType="second"/>'),
          args: { ext },
        },
        { text: CT('<Default Extension="png" ContentType="image/png"'), args: { ext } },
      ],
    ),
  },
  {
    fn: 'pptxLeaves.xml-utils.attributeOf',
    call: (text, args) => attributeOf(text, args.name as string),
    fromDocument: (parts) =>
      capturesOf(partsMatching(parts, SHAPE_TREE_PART), /<p:cNvPr\b[^>]*>/g, 20).map((text) => ({
        text,
        args: { name: 'name' },
      })),
    built: [
      ...ATTRIBUTE_ELEMENTS.flatMap((text) =>
        ['a', 'r:id', 'name', 'Id', 'x', 'id', 'xmlns:p', ''].map((name) => ({
          text,
          args: { name },
        })),
      ),
    ],
  },
  {
    fn: 'pptxLeaves.xml-utils.rootPrefixOf',
    call: (text, args) => rootPrefixOf(text, args.ns as string),
    fromDocument: (parts) =>
      [...parts.values()].slice(0, 30).map((text) => ({
        text,
        args: { ns: 'http://schemas.openxmlformats.org/presentationml/2006/main' },
      })),
    built: ROOT_XMLS.flatMap((text) =>
      [P_NS, A_NS, 'urn:x', '', 'a&b'].map((ns) => ({ text, args: { ns } })),
    ),
  },
  {
    fn: 'pptxLeaves.xml-utils.elementRange',
    call: (text, args) => elementRange(text, args.name as string, args.from as number | undefined),
    fromDocument: (parts) =>
      partsMatching(parts, SLIDE_PART)
        .slice(0, 3)
        .flatMap((text) =>
          ['p:spTree', 'p:sp', 'p:cSld', 'a:p', 'p:nvSpPr'].map((name) => ({
            text,
            args: { name },
          })),
        ),
    built: RANGE_XMLS.flatMap((text) =>
      [
        { name: 'a:t' },
        { name: 'p:x' },
        { name: 'a:t', from: 5 },
        { name: 'a:t', from: 9999 },
        { name: 'a:t', from: -3 },
        { name: 'b' },
        { name: 'q:é' },
        { name: '' },
      ].map((args) => ({ text, args })),
    ),
  },
  {
    fn: 'pptxLeaves.xml-utils.cSldNameOf',
    call: (text) => cSldNameOf(text),
    fromDocument: (parts) => partsMatching(parts, SLIDE_PART).map((text) => ({ text })),
    built: [
      '<p:cSld name="Title"/>',
      "<p:cSld name='Title &amp; Co'>",
      '<p:cSld\nname = "a&#38;b" x="1">',
      '<p:cSld>',
      '<p:cSld name="">',
      '<p:cSldx name="no"/>',
      '<p:cSld xname="no" name="yes"/>',
      '<p:cSld name="a>b">',
      '<p:cSld name="x" name="y">',
      '<p:cSld',
      '',
      '<q:cSld name="no"/>',
      '<p:cSld name="\u{1F600}"/>',
    ].map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.xml-utils.withRelationshipIds',
    call: (text, args) =>
      withRelationshipIds(
        text,
        args.names as string[],
        new Map(Object.entries(args.ids as Record<string, string>)),
      ),
    fromDocument: (parts) =>
      partsMatching(parts, SLIDE_PART)
        .slice(0, 3)
        .map((text) => ({
          text,
          args: { names: ['embed', 'id', 'link'], ids: { rId1: 'rId10', rId2: 'rId1' } },
        })),
    built: REL_XMLS.flatMap((text) =>
      REL_ID_MAPS.map((ids) => ({ text, args: { names: ['embed', 'id'], ids } })),
    ),
  },
  {
    fn: 'pptxLeaves.slide-ids.nextSlideId',
    call: (text) => nextSlideId(text),
    fromDocument: (parts) => {
      const text = parts.get('ppt/presentation.xml')
      return text === undefined ? [] : [{ text }]
    },
    built: PRESENTATIONS.map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.slide-ids.canListSlide',
    call: (text, args) => canListSlide(args.absent === true ? null : text),
    fromDocument: (parts) => {
      const text = parts.get('ppt/presentation.xml')
      return text === undefined ? [] : [{ text }]
    },
    built: [
      ...LISTED_PRESENTATIONS.map((text) => ({ text })),
      { text: '', args: { absent: true } },
    ],
  },
  {
    fn: 'pptxLeaves.slide-ids.withSlideListed',
    call: (text, args) =>
      withSlideListed(text, args.rid as string, args.afterRid as string | undefined),
    fromDocument: (parts) => {
      const text = parts.get('ppt/presentation.xml')
      return text === undefined ? [] : [{ text, args: { rid: 'rId99' } }]
    },
    built: LISTED_PRESENTATIONS.flatMap((text) => [
      { text, args: { rid: 'rId99' } },
      { text, args: { rid: 'rId99', afterRid: 'rId2' } },
      { text, args: { rid: 'rId99', afterRid: 'rId&#50;' } },
      { text, args: { rid: 'rId99', afterRid: 'nothing' } },
      { text, args: { rid: 'rId99', afterRid: 'constructor' } },
      { text, args: { rid: 'a$&b', afterRid: '' } },
    ]),
  },
  {
    fn: 'pptxLeaves.slide-ids.withSlideUnlisted',
    call: (text, args) => withSlideUnlisted(text, args.rid as string),
    fromDocument: (parts) => {
      const text = parts.get('ppt/presentation.xml')
      return text === undefined ? [] : [{ text, args: { rid: 'rId2' } }]
    },
    built: LISTED_PRESENTATIONS.flatMap((text) =>
      ['rId2', 'rId3', 'rId&#50;', 'nothing', 'constructor', '', 'r&amp;1'].map((rid) => ({
        text,
        args: { rid },
      })),
    ),
  },
  {
    fn: 'pptxLeaves.named-action.namedActionOf',
    call: (text, args) =>
      namedActionOf(
        args.nullish === 'null' ? null : args.nullish === 'undefined' ? undefined : text,
      ),
    fromDocument: (parts) =>
      capturesOf(partsMatching(parts, SHAPE_TREE_PART), /\baction="([^"]*)"/g).map((action) => ({
        text: unescapeXml(action),
      })),
    built: [
      ...ACTIONS.map((text) => ({ text })),
      { text: ACTIONS[0]!, args: { nullish: 'null' } },
      { text: ACTIONS[0]!, args: { nullish: 'undefined' } },
    ],
  },
  {
    fn: 'pptxLeaves.named-action.namedActionAttr',
    call: (text) => namedActionAttr(text),
    built: [...NAMED_ACTIONS, '', '&"<', '\u{1F600}'].map((text) => ({ text })),
  },
  {
    fn: 'pptxLeaves.table-grid.tableRowGridCols',
    call: (_text, args) =>
      tableRowGridCols(args.row as Array<{ gridSpan?: number; merged?: boolean }>),
    fromDocument: rowsOf,
    built: ROWS.map((row) => ({ args: { row } })),
    mutation: 'none',
  },
  {
    fn: 'pptxLeaves.crc32.crc32',
    call: (text, args) =>
      crc32(
        args.bytes === undefined
          ? new TextEncoder().encode(text)
          : Uint8Array.from(args.bytes as number[]),
      ),
    fromDocument: (parts) => [...parts.values()].slice(0, 40).map((text) => ({ text })),
    built: [
      ...['', '123456789', 'a', '\u{1F600}', '\uD55C\uAE00', 'The quick brown fox'].map((text) => ({
        text,
      })),
      ...BYTES.map((bytes) => ({ args: { bytes } })),
    ],
  },
]
