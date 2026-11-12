// Group `odtObjects` of comparison (f): objects/*.ts of packages/odt-engine (the
// functions whose arguments are plain data). The Rust side answers in
// crates/office-wasm/src/calls/odt_objects.rs to `odtObjects.<TypeScript name>`;
// the convention is at the top of calls-support.ts. Shapes particular to this group:
//
//   subElements        text the xml; args `from`, `to` (UTF-16 units of `text`). The PrefixMap is the one of the
//                      root element of `text` (`readRoot(text)?.prefixes`).
//   plainTextOf        the same arguments.
//   entriesOf, graphicProps, textWidthEmu, anchorOf, analyzeObject   take an OdtDocument: `args.doc` is the
//                      bytes (`{ $bytes }`) of an ODT package, opened as `openOdt` opens it; `part` is the
//                      part name (`content.xml`/`styles.xml`); entriesOf: text the href; graphicProps: args
//                      `styleName` (absent for null); anchorOf: args `facts`; analyzeObject: text the xml of
//                      `part`, args `el` `{ name, start, nameEnd, openEnd, closeStart }`, its PrefixMap the
//                      root's of `text`; a result's Uint8Array crosses as `{ $bytes }`.
//   sniffImage, base64Encode, sameBytes: bytes as `{ $bytes }` (`bytes`, `a`, `b`);
//   base64Decode, dataUrlBytes: the bytes as a result are `{ $bytes }` or `null`.
//   patchManifestXml   text the manifest; args `changes` `{ add: [{ path, data: {$bytes}, mediaType }], remove }`.
//   keepName           text the id; args `kind`. pictureName: text the id.
//   noteKey            text the kind; args `id`.
//   lengthToEmu        text the value.
//   emuToCm            args `emu`.//
//   odtObjects.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { bytesArg, bytesOf, distinct, wire, constantSpec } from './calls-support'
import { buildZip } from '../docx-diff/package-zips'
import { surrogateClasses } from './listed'
import * as ts from './ts'

const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)
const geometry = ts.objectsGeometry
const media = ts.objectsMedia

/** The PrefixMap of the root element of a part. */
const prefixesOf = (text: string): ts.coreXml.PrefixMap =>
  ts.coreXml.readRoot(text)?.prefixes ?? new ts.coreXml.PrefixMap()

const LENGTHS = [
  '4.547cm',
  '0cm',
  '-1cm',
  '12pt',
  '1in',
  '2inch',
  '10mm',
  '3pc',
  '15px',
  '5',
  '.5',
  '5.',
  '1e1',
  '1e1cm',
  '1E-1mm',
  ' 2cm ',
  '2 cm',
  '2CM',
  'cm',
  '',
  'abc',
  '1e400',
  '1e400cm',
  '100%',
  '0.0000001cm',
  '+3mm',
  '\ud55c\uae00',
  '1.5.5cm',
]

const DOCX_DRAWING = (inner: string, name = 'Picture 1'): string =>
  `<w:drawing>${inner}<wp:docPr id="1" name="${name}" descr="d"/></w:drawing>`

const DRAWINGS = [
  '<w:p><w:r>' + DOCX_DRAWING('<wp:inline><wp:extent cx="100" cy="200"/>') + '</w:r></w:p>',
  '<w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>-5</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:align>top</wp:align></wp:positionV><wp:extent cx="1" cy="2"/><wp:docPr id="9" name="a &amp; &lt;b&gt;"/><a:blip r:embed="rId7"/></wp:anchor></w:drawing></w:r>',
  '<w:drawing><wp:docPr name="x"/></w:drawing><w:drawing><wp:extent cx="-3" cy="x"/></w:drawing>',
  '<wp:docPr   name  =  "spaced"  /><wp:extent cx = "10" />',
  '<w:drawing><wp:inline><a:blip r:embed = "rIdX" /><wp:docPr name=\'single\'/></wp:inline></w:drawing>',
  '<w:drawing></w:drawing>',
  '',
  'plain',
  '<w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>1</wp:posOffset></wp:positionH>\n<wp:positionV relativeFrom="page"> <wp:posOffset>2</wp:posOffset></wp:positionV><wp:docPr name="&quot;q&quot;&apos;"/></wp:anchor></w:drawing>',
  '<w:drawing><wp:docPr name="\ud55c\uae00 \ud83d\ude00"/><wp:extent cx="99999999999" cy="1"/></w:drawing>',
]

const anchor = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  h: { relativeFrom: 'column', offset: 100, align: null },
  v: { relativeFrom: 'paragraph', offset: null, align: 'top' },
  wrap: 'square',
  behind: false,
  z: 4,
  ...extra,
})

const SPECS: Array<Record<string, unknown>> = [
  { docPrId: 1, name: 'Picture1', rId: 'rId1', cx: 100, cy: 200, anchor: null },
  {
    docPrId: 2,
    name: 'a & "b" <c>',
    descr: 'desc & <x>',
    rId: 'r"1',
    cx: 0.4,
    cy: -5,
    anchor: null,
  },
  { docPrId: 3, name: 'p', rId: 'r', cx: 914400.6, cy: 457200.4, anchor: anchor() },
  {
    docPrId: 4,
    name: 'p',
    descr: '',
    rId: 'r',
    cx: 1,
    cy: 1,
    anchor: anchor({ wrap: 'none', behind: true, z: -3 }),
  },
  {
    docPrId: 5,
    name: 'p',
    rId: 'r',
    cx: 1,
    cy: 1,
    anchor: anchor({
      wrap: 'topAndBottom',
      z: 5000000,
      h: { relativeFrom: 'page', offset: -12.5, align: 'center' },
      v: { relativeFrom: 'line', offset: 7.5, align: null },
    }),
  },
  {
    docPrId: 6,
    name: '\ud55c\uae00',
    rId: 'r',
    cx: 360000,
    cy: 360000,
    anchor: anchor({ h: { relativeFrom: 'margin', offset: null, align: null } }),
  },
]

const BYTE_SAMPLES: Uint8Array[] = [
  new Uint8Array(),
  new Uint8Array([1, 2, 3]),
  ts.helpersHancomSample.PNG_1X1,
  ts.helpersObjectsFixtures.PNG_GREY,
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]),
  new TextEncoder().encode('GIF89a'),
  new Uint8Array([0x42, 0x4d, 0, 0]),
  new Uint8Array([0x49, 0x49, 0x2a, 0x00]),
  new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]),
  new Uint8Array([0xd7, 0xcd, 0xc6, 0x9a, 0]),
  new Uint8Array([0x01, 0x00, 0x09, 0x00]),
  new Uint8Array([0x02, 0x00, 0x09, 0x00, 1]),
  Uint8Array.from([1, 0, 0, 0, ...new Array(36).fill(0), 0x20, 0x45, 0x4d, 0x46]),
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  new TextEncoder().encode('  <?xml version="1.0"?><!-- c --><svg>'),
  new TextEncoder().encode('<svgx>'),
  new TextEncoder().encode('\ufeff<svg>'),
  new Uint8Array([0x89, 0x50, 0x4e]),
  new Uint8Array(1000).map((_, i) => i & 0xff),
]

const BASE64_TEXTS = [
  '',
  'AA==',
  'AQID',
  'AQI=',
  'AQ',
  'AQ==\n',
  ' A Q I D ',
  'A-_B',
  '+/+/',
  '!!!!',
  'AQID=',
  '====',
  'a',
  'ab',
  'abc',
  'abcd',
  '\ud55c\uae00',
  'QUJD\nREVG',
  'AQID\u00a0',
  '_-_-',
  'AA=A',
]

const DATA_URLS = [
  'data:image/png;base64,AQID',
  'data:;base64,AQI=',
  'data:image/png,AQID',
  'data:image/png;base64,',
  'data:image/png;charset=utf-8;base64,QUJD',
  'http://x/y.png',
  'data:image/png;base64,AQ\nID',
  'data:image/png;base64,!!',
  'DATA:image/png;base64,AQID',
  '',
  `data:image/png;base64,${Buffer.from(ts.helpersHancomSample.PNG_1X1).toString('base64')}`,
]

const HREFS = [
  'Pictures/a.png',
  './Pictures/a.png',
  '././x',
  'Object 1',
  './Object 1/',
  '#bookmark',
  '/abs/path',
  'http://example.com/a',
  'mailto:a@b',
  'C:/x',
  'c:x',
  'a:b',
  '1a:b',
  'a1+.-:x',
  '  Pictures/b.png  ',
  '',
  ' ',
  '\ud55c\uae00/\ud30c\uc77c.png',
  '../up.png',
  'Pictures/%ED%95%9C.png',
  'file:///x',
]

const NAMES = [
  'odt-keep:1:equation',
  'odt-keep:abc:shape',
  'odt-keep::shape',
  'odt-keep:1:nothing',
  'odt-keep:1',
  'odt-keep:1:',
  'odt-keep:a:b:toc',
  'odt-keep:\ud55c:chart',
  'ODT-KEEP:1:object',
  'odt-pic:7',
  'odt-pic:',
  'odt-pic',
  'odt-pic:\ud55c\uae00',
  'Picture 1',
  '',
  'odt-keep:1:revision',
  'odt-keep:1:textbox',
]

const CHANGES = [
  { add: [], remove: [] },
  {
    add: [
      { path: 'Pictures/io_1.png', data: bytesArg(new Uint8Array([1])), mediaType: 'image/png' },
    ],
    remove: [],
  },
  { add: [], remove: ['Pictures/a.png'] },
  {
    add: [
      { path: 'Pictures/a&b.png', data: bytesArg(new Uint8Array()), mediaType: 'image/p"ng' },
      { path: 'Pictures/io_2.png', data: bytesArg(new Uint8Array()), mediaType: 'image/png' },
    ],
    remove: ['content.xml', 'Pictures/gone.png'],
  },
  {
    add: [{ path: 'content.xml', data: bytesArg(new Uint8Array()), mediaType: 'text/xml' }],
    remove: [],
  },
  {
    add: [
      {
        path: 'Pictures/\ud55c\uae00.png',
        data: bytesArg(new Uint8Array()),
        mediaType: 'image/png',
      },
    ],
    remove: ['/'],
  },
]

const MANIFEST_TEXTS = [
  '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.text" manifest:full-path="/"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/><manifest:file-entry manifest:media-type="image/png" manifest:full-path="Pictures/a.png"/></manifest:manifest>',
  '<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="x"/><m:file-entry m:full-path="Pictures/a.png" m:media-type="image/png"></m:file-entry></m:manifest>',
  '<manifest xmlns="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><file-entry full-path="Pictures/a.png"/></manifest>',
  'no markup',
  '',
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
]

const SUB_XML = [
  '<a><b x="1">t&amp;u<c/><d>text</d></b><e/></a>',
  '<text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">a<text:span>b&lt;</text:span>c<!-- n --><![CDATA[ d ]]></text:p>',
  '<a><b></a>',
  '<a>\ud55c\uae00 \ud83d\ude00</a>',
  '',
  '<a/>',
]

function rangeInputs(text: string): Input[] {
  const n = text.length
  return [
    { text, args: { from: 0, to: n } },
    { text, args: { from: Math.floor(n / 4), to: Math.floor((n * 3) / 4) } },
    { text, args: { from: Math.floor(n / 2), to: n } },
    { text, args: { from: 0, to: 0 } },
  ]
}

// ---------------------------------------------------------------------------
// ODT packages written byte by byte (the specs that take an OdtDocument)

const OFFICE_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'

const GRAPHIC_STYLES =
  '<style:style style:name="Frame" style:family="graphic"><style:graphic-properties style:wrap="parallel" style:horizontal-pos="center"/></style:style>' +
  '<style:style style:name="gr1" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" style:wrap="none"/></style:style>' +
  '<style:style style:name="gr2" style:family="graphic"><style:graphic-properties style:wrap="run-through" style:run-through="background" style:horizontal-pos="right" style:horizontal-rel="page-content" style:vertical-pos="middle" style:vertical-rel="page"/></style:style>' +
  '<style:style style:name="gr3" style:family="graphic"><style:graphic-properties style:wrap="dynamic" style:horizontal-rel="char" style:vertical-rel="baseline"/></style:style>'

const FRAMES =
  '<text:p><draw:frame draw:style-name="gr1" svg:width="4.547cm" svg:height="1.342cm" svg:x="0.5cm" svg:y="0.2cm" draw:z-index="4" text:anchor-type="paragraph"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>' +
  '<text:p><draw:frame draw:style-name="gr2" svg:width="2cm" svg:height="0.6cm" text:anchor-type="page"><draw:object xlink:href="./Object 1"/><draw:image xlink:href="./ObjectReplacements/Object 1"/></draw:frame></text:p>' +
  '<text:p><draw:frame draw:style-name="gr3" svg:width="1cm" svg:height="1cm" text:anchor-type="as-char"><draw:object xlink:href="Object 2"/></draw:frame><draw:custom-shape svg:x="1cm" svg:y="1cm" svg:width="3cm" svg:height="2cm"><text:p>shape</text:p></draw:custom-shape></text:p>' +
  '<text:p><draw:line svg:x1="1cm" svg:y1="3cm" svg:x2="0cm" svg:y2="1cm"/><draw:frame svg:width="bad" svg:height="1cm"><draw:image xlink:href="http://example.com/x.png"/></draw:frame><draw:frame><draw:text-box><text:p>box</text:p></draw:text-box></draw:frame></text:p>' +
  '<text:p><draw:g><draw:rect svg:x="0cm" svg:y="0cm" svg:width="1cm" svg:height="1cm"/><draw:ellipse svg:x="1cm" svg:y="1cm" svg:width="1cm" svg:height="1cm"/></draw:g><draw:frame><draw:image xlink:href="Pictures/%61.png"/><draw:image xlink:href="Pictures/b.png"/></draw:frame></text:p>'

const SPELLED = (extra: string, masters: string): { content: string; styles: string } => ({
  content: `<office:document-content ${OFFICE_NS}><office:automatic-styles>${GRAPHIC_STYLES}</office:automatic-styles><office:body><office:text>${extra}</office:text></office:body></office:document-content>`,
  styles: `<office:document-styles ${OFFICE_NS}><office:styles>${GRAPHIC_STYLES}</office:styles><office:automatic-styles>${masters}</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`,
})

const LAYOUT_A =
  '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21.000cm" fo:page-height="29.700cm" fo:margin-left="2cm" fo:margin-right="3cm"/></style:page-layout>'
const LAYOUT_B =
  '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm" fo:margin-left="0cm" fo:margin-right="25cm"/></style:page-layout>'
const LAYOUT_C =
  '<style:page-layout style:name="pm1"><style:page-layout-properties/></style:page-layout>'

/** An ODT package written byte by byte: mimetype first and stored, the manifest, the parts, the media. */
function odtPackage(content: string, styles: string, withObjects = true): Uint8Array {
  const manifest =
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.text" manifest:full-path="/"/>' +
    '<manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="styles.xml"/>' +
    (withObjects
      ? '<manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.formula" manifest:full-path="Object 1/"/><manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.chart" manifest:full-path="Object 2/"/>'
      : '') +
    '</manifest:manifest>'
  const entries = [
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', method: 0 },
    { name: 'META-INF/manifest.xml', data: manifest, method: 8 },
    { name: 'content.xml', data: content, method: 8 },
    { name: 'styles.xml', data: styles, method: 8 },
    ...(withObjects
      ? [
          { name: 'Pictures/a.png', data: ts.helpersHancomSample.PNG_1X1, method: 0 },
          { name: 'Pictures/b.png', data: ts.helpersObjectsFixtures.PNG_GREY, method: 8 },
          {
            name: 'Object 1/content.xml',
            data: ts.helpersFragments.FORMULA_CONTENT_XML,
            method: 8,
          },
          {
            name: 'Object 2/content.xml',
            data: '<office:document-content xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:chart><chart:chart/></office:chart></office:body></office:document-content>',
            method: 8,
          },
          { name: 'ObjectReplacements/Object 1', data: ts.helpersHancomSample.PNG_1X1, method: 0 },
        ]
      : []),
  ]
  return buildZip(entries)
}

const DOC_PARTS = [SPELLED(FRAMES, LAYOUT_A), SPELLED(FRAMES, LAYOUT_B), SPELLED(FRAMES, LAYOUT_C)]
const DOCS = [
  odtPackage(DOC_PARTS[0]!.content, DOC_PARTS[0]!.styles),
  odtPackage(DOC_PARTS[1]!.content, DOC_PARTS[1]!.styles),
  odtPackage(DOC_PARTS[2]!.content, DOC_PARTS[2]!.styles, false),
]
const docArg = (index: number): { $bytes: string } => bytesArg(DOCS[index]!)

/** The drawing elements of a part: the `el` argument of analyzeObject for each. */
function drawingElements(
  text: string,
): Array<{ name: string; start: number; nameEnd: number; openEnd: number; closeStart: number }> {
  const out: Array<{
    name: string
    start: number
    nameEnd: number
    openEnd: number
    closeStart: number
  }> = []
  const body = ts.coreBody.scanOdtBody(text)
  ts.coreBody.walkNodes(body.blocks, (node) => {
    if (node.name.startsWith('draw:') || node.name.startsWith('dr3d:'))
      out.push({
        name: node.name,
        start: node.start,
        nameEnd: node.nameEnd,
        openEnd: node.openEnd,
        closeStart: node.closeStart,
      })
  })
  return out
}

const HREF_CASES = [
  'Pictures/a.png',
  './Pictures/a.png',
  'Pictures/%61.png',
  'Pictures/b.png',
  'Pictures/',
  'Pictures',
  './Object 1',
  'Object 1/',
  'Object%201',
  'Object 2/content.xml',
  'ObjectReplacements/Object 1',
  'Missing/x',
  'http://example.com/x',
  '#anchor',
  '',
  '../Pictures/a.png',
  '%zz',
]
const FACTS: Array<Record<string, unknown>> = [
  { type: 'as-char', xEmu: 0, yEmu: 0, z: 1, styleName: null },
  { type: 'paragraph', xEmu: 180000, yEmu: 72000, z: 4, styleName: 'gr1' },
  { type: 'page', xEmu: -5, yEmu: null, z: -2, styleName: 'gr2' },
  { type: 'char', xEmu: null, yEmu: 7, z: 1e9, styleName: 'gr3' },
  { type: null, xEmu: 1.5, yEmu: 2.5, z: 0, styleName: 'Frame' },
  { type: 'frame', z: 3, styleName: 'missing' },
  { type: 'paragraph', z: 3 },
]

const DOC_SPECS: CallSpec[] = [
  {
    fn: 'odtObjects.entriesOf',
    call: async (text, args) =>
      ts.objectsAnalyze.entriesOf(await ts.coreOpen.openOdt(bytesOf(args.doc)), text),
    built: DOCS.flatMap((_, i) => HREF_CASES.map((text) => ({ text, args: { doc: docArg(i) } }))),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.graphicProps',
    call: async (_t, args) =>
      ts.objectsAnalyze.graphicProps(
        await ts.coreOpen.openOdt(bytesOf(args.doc)),
        args.part as never,
        args.styleName === undefined ? null : (args.styleName as string),
      ),
    built: DOCS.flatMap((_, i) =>
      ['content.xml', 'styles.xml'].flatMap((part) =>
        [undefined, 'gr1', 'gr2', 'gr3', 'Frame', 'missing', ''].map((styleName) => ({
          args: { doc: docArg(i), part, ...(styleName === undefined ? {} : { styleName }) },
        })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.textWidthEmu',
    call: async (_t, args) =>
      ts.objectsAnalyze.textWidthEmu(await ts.coreOpen.openOdt(bytesOf(args.doc))),
    built: DOCS.map((_, i) => ({ args: { doc: docArg(i) } })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.anchorOf',
    call: async (_t, args) =>
      ts.objectsAnalyze.anchorOf(
        await ts.coreOpen.openOdt(bytesOf(args.doc)),
        args.part as never,
        { styleName: null, xEmu: null, yEmu: null, ...(args.facts as object) } as never,
      ),
    built: DOCS.flatMap((_, i) =>
      FACTS.map((facts) => ({ args: { doc: docArg(i), part: 'content.xml', facts } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.analyzeObject',
    call: async (text, args) =>
      wire(
        ts.objectsAnalyze.analyzeObject(
          await ts.coreOpen.openOdt(bytesOf(args.doc)),
          args.part as never,
          text,
          prefixesOf(text),
          args.el as never,
        ),
      ),
    built: DOC_PARTS.flatMap((parts, i) =>
      drawingElements(parts.content).map((el) => ({
        text: parts.content,
        args: { doc: docArg(i), part: 'content.xml', el },
      })),
    ),
    mutation: 'none',
  },
]

export const OBJECTS: CallSpec[] = [
  {
    fn: 'odtObjects.lengthToEmu',
    call: (text) => geometry.lengthToEmu(text),
    fromDocument: (parts) =>
      distinct(
        [
          ...[part(parts, 'content.xml'), part(parts, 'styles.xml')].flatMap((p) =>
            [...(p ?? '').matchAll(/(?:svg:(?:width|height|x|y))="([^"]*)"/g)].map((m) => m[1]!),
          ),
        ],
        40,
      ).map((text) => ({ text })),
    built: LENGTHS.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.emuToCm',
    call: (_t, args) => geometry.emuToCm(args.emu as number),
    built: [
      0, 360000, 1636920, 483120, 1, 179999, 180000, 1828800, 914400, -360000, 0.5, 1e12, 2743200,
      1270000, 123456789, 3.14159e5,
    ].map((emu) => ({ args: { emu } })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.drawingXml',
    call: (_t, args) => geometry.drawingXml(args.spec as never),
    built: SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtObjects.readDrawing',
    call: (text) => geometry.readDrawing(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => /^word\/.*\.xml$/.test(n))
        .flatMap(([, xml]) =>
          geometry
            .drawingsOf(xml)
            .slice(0, 10)
            .map((text) => ({ text })),
        ),
    built: [...DRAWINGS, ...SPECS.map((spec) => geometry.drawingXml(spec as never))].map(
      (text) => ({ text }),
    ),
  },
  {
    fn: 'odtObjects.drawingsOf',
    call: (text) => geometry.drawingsOf(text),
    fromDocument: (parts) =>
      [...parts].filter(([n]) => /^word\/document\.xml$/.test(n)).map(([, text]) => ({ text })),
    built: DRAWINGS.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.sniffImage',
    call: (_t, args) => media.sniffImage(bytesOf(args.bytes)),
    built: BYTE_SAMPLES.map((bytes) => ({ args: { bytes: bytesArg(bytes) } })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.base64Encode',
    call: (_t, args) => media.base64Encode(bytesOf(args.bytes)),
    built: BYTE_SAMPLES.map((bytes) => ({ args: { bytes: bytesArg(bytes) } })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.base64Decode',
    call: (text) => wire(media.base64Decode(text)),
    built: BASE64_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.dataUrlBytes',
    call: (text) => wire(media.dataUrlBytes(text)),
    built: DATA_URLS.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.sameBytes',
    call: (_t, args) => media.sameBytes(bytesOf(args.a), bytesOf(args.b)),
    built: BYTE_SAMPLES.flatMap((a, i) =>
      [
        BYTE_SAMPLES[i]!,
        BYTE_SAMPLES[(i + 1) % BYTE_SAMPLES.length]!,
        new Uint8Array([...a, 0]),
      ].map((b) => ({ args: { a: bytesArg(a), b: bytesArg(b) } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.hrefPath',
    call: (text) => ts.objectsAnalyze.hrefPath(text),
    fromDocument: (parts) =>
      distinct(
        [...(part(parts, 'content.xml') ?? '').matchAll(/xlink:href="([^"]*)"/g)].map((m) =>
          ts.coreXml.decodeXmlEntities(m[1]!),
        ),
        40,
      ).map((text) => ({ text })),
    built: HREFS.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.subElements',
    listed: surrogateClasses,
    call: (text, args) =>
      ts.objectsAnalyze.subElements(text, prefixesOf(text), args.from as number, args.to as number),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      return content === undefined
        ? []
        : rangeInputs(content.length > 20000 ? content.slice(0, 20000) : content)
    },
    built: SUB_XML.flatMap(rangeInputs),
  },
  {
    fn: 'odtObjects.plainTextOf',
    listed: surrogateClasses,
    call: (text, args) =>
      ts.objectsAnalyze.plainTextOf(text, prefixesOf(text), args.from as number, args.to as number),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      return content === undefined
        ? []
        : rangeInputs(content.length > 20000 ? content.slice(0, 20000) : content)
    },
    built: SUB_XML.flatMap(rangeInputs),
  },
  {
    fn: 'odtObjects.keepName',
    call: (text, args) => ts.objectsModel.keepName(text, args.kind as never),
    built: [
      ['1', 'equation'],
      ['a:b', 'toc'],
      ['', 'object'],
      ['\ud55c', 'chart'],
      ['x', 'shape'],
      ['y', 'textbox'],
      ['z', 'revision'],
    ].map(([text, kind]) => ({ text: text!, args: { kind } })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.pictureName',
    call: (text) => ts.objectsModel.pictureName(text),
    built: ['1', '', 'a:b', '\ud55c\uae00'].map((text) => ({ text })),
    mutation: 'none',
  },
  {
    fn: 'odtObjects.parseKeepName',
    call: (text) => ts.objectsModel.parseKeepName(text),
    built: NAMES.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.parsePictureName',
    call: (text) => ts.objectsModel.parsePictureName(text),
    built: NAMES.map((text) => ({ text })),
  },
  {
    fn: 'odtObjects.patchManifestXml',
    call: (text, args) => {
      const changes = args.changes as {
        add: Array<{ path: string; data: { $bytes: string }; mediaType: string }>
        remove: string[]
      }
      return ts.objectsPackage.patchManifestXml(text, {
        add: changes.add.map((a) => ({ ...a, data: bytesOf(a.data) })),
        remove: changes.remove,
      })
    },
    fromDocument: (parts) =>
      part(parts, 'META-INF/manifest.xml') === undefined
        ? []
        : CHANGES.map((changes) => ({
            text: part(parts, 'META-INF/manifest.xml')!,
            args: { changes },
          })),
    built: MANIFEST_TEXTS.flatMap((text) =>
      CHANGES.map((changes) => ({ text, args: { changes } })),
    ),
  },
  {
    fn: 'odtObjects.noteKey',
    call: (text, args) => ts.objectsState.noteKey(text as never, args.id as string),
    built: [
      ['footnote', '1'],
      ['endnote', '1'],
      ['footnote', ''],
      ['endnote', 'a:b'],
      ['footnote', '\ud55c'],
    ].map(([text, id]) => ({ text: text!, args: { id } })),
    mutation: 'none',
  },
  ...DOC_SPECS,
  constantSpec('odtObjects', {
    EMU_PER_CM: () => geometry.EMU_PER_CM,
    OBJECTS_OWNER: () => ts.objectsModel.OBJECTS_OWNER,
    OBJECTS_EXT_KEY: () => ts.objectsModel.OBJECTS_EXT_KEY,
    ODT_KEEP_PREFIX: () => ts.objectsModel.ODT_KEEP_PREFIX,
    ODT_PICTURE_PREFIX: () => ts.objectsModel.ODT_PICTURE_PREFIX,
    OBJECT_KINDS: () => ts.objectsModel.OBJECT_KINDS,
    DRAW_OBJECT_NAMES: () => ts.objectsAnalyze.DRAW_OBJECT_NAMES,
    NEUTRAL_PLACEHOLDER_PNG: () => media.NEUTRAL_PLACEHOLDER_PNG,
    emptyObjectsExt: () => ts.objectsModel.emptyObjectsExt(),
  }),
]
