// Group `odtAssemble` of comparison (f): assemble/*.ts and assemble/export/*.ts
// of packages/odt-engine (the functions whose arguments are plain data; the
// four public functions are comparisons (a) to (d)). The Rust side answers in
// crates/office-wasm/src/calls/odt_assemble.rs to `odtAssemble.<TypeScript name>`;
// the convention is at the top of calls-support.ts. Shapes particular to this group:
//
//   readMetaPeople, coreXmlFor   text the meta.xml (`args.missing` for a document without one: the
//        OdtDocument of the TypeScript is `{ metaXml }`); coreXmlFor also `args.people`.
//   personalInfoRemoved   text the edited core.xml (`args.missing` for null); args `bridge` (null or
//        `{ creator, lastModifiedBy }`), `editedFlag`.
//   headingsAsParagraphs  text the xml; args `commonLevels` as entries `[[style, level]]`.
//   withRowFloors, paragraphStylesXml, unresolvedThemeReferences   args `parsed`: a whole ParsedDoc (Maps as
//        entries, bytes as `$bytes`); withRowFloors also `model` (a TableModel); unresolvedThemeReferences:
//        text the documentXml; args `stylesXml`, `parts` (the header and footer parts).
//   textProps          args `format` a TextFormat (`Pick<Run, ...>`, no `text`); answers `{ attrs, families }` (the FontSet is fresh; `families` as it holds them
//                      after the call); defaultStyleXml `{ xml, decls }`; paragraphStylesXml `{ xml, names:
//                      [[styleId, name]], base, decls }`.
//   odtToDocxReport    args `map` (a BridgeMap), `contentXml` (the OdtDocument is `{ contentXml }`).
//   dataUrlOf, pictureRun, solidPng   bytes as `{ $bytes }`, in the arguments and the result.
//   pictureRun, drawingXml  text the `name`; args `bytes` (pictureRun), `cx`, `cy`.
//   defaultSize        text the text; args `kind`.
//   (a ParsedDoc argument is what parseDocx answers, `extras` included: the Rust side drops it.)
//   odtAssemble.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { ParsedDoc, TableModel } from '@seuoffice/docx-engine'
import { parseDocx } from '@seuoffice/docx-engine'
import JSZip from 'jszip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { withClock } from './clock'
import { builtDocxSpecs, builtOdts } from './corpus'
import { elementFragments } from '../docx-diff/fragments'
import { bytesArg, bytesOf, distinct, wire, constantSpec } from './calls-support'
import * as ts from './ts'

const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)
const objects = ts.exportObjects
const styles = ts.exportStyles

/** The bridge maps of three documents of the odt tests, with their content.xml: what odtToDocxReport reads. */
const REPORT_FIXTURES = await (async () => {
  const wanted = ['hancom-sample', 'placeholders', 'tables-doc', 'bookmarks-fields', 'text-sample']
  const out: Array<{ map: unknown; contentXml: string }> = []
  for (const odt of await builtOdts(() => 0.5, 0)) {
    if (!wanted.includes(odt.name)) continue
    const { bridge } = await withClock(() => ts.odtToDocx(odt.bytes))
    out.push({
      map: JSON.parse(JSON.stringify(bridge)) as unknown,
      contentXml: (await ts.coreOpen.openOdt(odt.bytes)).contentXml,
    })
  }
  return out
})()

/** Documents whose whole model a spec sends: a ParsedDoc is large, and the first few show what the rest do. */
const WHOLE_MODELS = 10
const sent = new Map<string, number>()
function wholeModel(fn: string, doc: ParsedDoc): Record<string, unknown> | null {
  const n = sent.get(fn) ?? 0
  sent.set(fn, n + 1)
  return n < WHOLE_MODELS ? parsedArg(doc) : null
}

/** A whole ParsedDoc as it crosses the wire: Maps as entries, bytes as `$bytes`. */
const parsedArg = (doc: ParsedDoc): Record<string, unknown> => wire(doc) as Record<string, unknown>

/** The ParsedDoc of an argument: only the Maps the functions read (`styles`) are Maps again. */
const parsedOf = (arg: unknown): ParsedDoc => {
  const p = arg as { styles: Array<[string, unknown]> }
  return { ...p, styles: new Map(p.styles) } as unknown as ParsedDoc
}

/** Docx documents parsed once, for the functions that read a ParsedDoc: the fixtures of the odt tests. */
const FIXTURES = await (async () => {
  const wanted = [
    'kitchen-sink',
    'row-heights',
    'theme-accent1',
    'theme-font-with-theme',
    'headings-outline',
    'plain',
    'styles-and-links',
    'theme-accent5-missing',
    'continuous-columns',
  ]
  const out: Array<{
    name: string
    parsed: ParsedDoc
    documentXml: string
    stylesXml: string
    parts: string[]
  }> = []
  for (const [name, spec] of await builtDocxSpecs()) {
    if (!wanted.includes(name)) continue
    const bytes = await withClock(() => ts.helpersBuildDocx.buildDocx(spec))
    const zip = await JSZip.loadAsync(bytes)
    const read = async (path: string): Promise<string> =>
      (await zip.file(path)?.async('string')) ?? ''
    out.push({
      name,
      parsed: await withClock(() => parseDocx(bytes)),
      documentXml: await read('word/document.xml'),
      stylesXml: await read('word/styles.xml'),
      parts: await Promise.all(
        Object.keys(zip.files)
          .filter((n) => /^word\/(header|footer)[^/]*\.xml$/.test(n))
          .map(read),
      ),
    })
  }
  return out
})()

const META_XMLS = [
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><meta:initial-creator>A &amp; B</meta:initial-creator><dc:creator>C</dc:creator><dc:title>T &lt;1&gt;</dc:title><meta:creation-date>2026-01-01T10:00:00+09:00</meta:creation-date><dc:date>2026-06-15T12:30:00-05:00</dc:date></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><meta:creation-date>2026-01-01T10:00:00</meta:creation-date><dc:creator/><meta:printed-by>P</meta:printed-by></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:d="http://purl.org/dc/elements/1.1/"><office:meta><m:initial-creator>\ud55c\uae00</m:initial-creator><d:creator>x</d:creator><d:date>2026-01-01T10:00:00.123456789Z</d:date><m:creation-date>2026-13-45T25:61:61</m:creation-date></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:meta/></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:initial-creator>A</meta:initial-creator><meta:initial-creator>B</meta:initial-creator></office:meta></office:document-meta>',
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:creator>only</dc:creator><meta:creation-date> 2026-01-01T10:00:00Z </meta:creation-date><dc:date>1969-12-31T23:59:59-00:30</dc:date></office:meta></office:document-meta>',
  'not xml',
  '',
]

const PEOPLE = [
  { creator: 'A', lastModifiedBy: 'B' },
  { creator: null, lastModifiedBy: 'B' },
  { creator: 'A & B', lastModifiedBy: null },
  { creator: null, lastModifiedBy: null },
  { creator: '', lastModifiedBy: '\ud55c\uae00' },
  { creator: '<x>', lastModifiedBy: '"q"' },
]

const CORES = [
  '<cp:coreProperties><dc:creator>A</dc:creator><cp:lastModifiedBy>B</cp:lastModifiedBy></cp:coreProperties>',
  '<cp:coreProperties><dc:creator></dc:creator><cp:lastModifiedBy>B</cp:lastModifiedBy></cp:coreProperties>',
  '<cp:coreProperties><dc:creator>A</dc:creator><cp:lastModifiedBy/></cp:coreProperties>',
  '<cp:coreProperties><dc:creator>A</dc:creator></cp:coreProperties>',
  '<cp:coreProperties><dc:creator a="1">A &amp; B</dc:creator><cp:lastModifiedBy>B</cp:lastModifiedBy></cp:coreProperties>',
  '<cp:coreProperties/>',
  '',
]

const OBJECT_XMLS = [
  '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="200"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><a:blip r:embed="rId1"/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
  '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>',
  '<w:object><o:OLEObject ProgID="Equation.3"/></w:object>',
  '<w:object><o:OLEObject ProgID="Excel.Chart.8"/><v:imagedata r:id="rId9"/></w:object>',
  '<w:object><o:OLEObject ProgID="Word.Document.8"/></w:object>',
  '<w:drawing><wp:inline><wp:extent cx="1" cy="2"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></wp:inline></w:drawing>',
  '<w:drawing><wp:inline><a:graphic><a:graphicData uri="x/chartex"/></a:graphic></wp:inline></w:drawing>',
  '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic><a:graphicData><wps:wsp/></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:100pt;height:50pt"><v:imagedata r:id="rIdFallback" o:title=""/></v:shape></w:pict></mc:Fallback></mc:AlternateContent>',
  '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx/></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:oval style="width:100pt;height:50pt"/></w:pict></mc:Fallback></mc:AlternateContent>',
  '<w:pict><v:shape style="width:2in;height:1.5cm"><v:textbox><w:txbxContent/></v:textbox></v:shape></w:pict>',
  '<w:pict><v:rect style="width:10mm;height:20mm"/></w:pict>',
  '<w:pict><v:shape style="margin-left:1pt;width:10px;height:5"><v:imagedata r:id="rIdV"/></v:shape></w:pict>',
  '<w:drawing><wpg:wgp/></w:drawing>',
  '<w:drawing><dgm:relIds/></w:drawing>',
  '<w:r><w:t>plain text</w:t></w:r>',
  '',
  '<w:pict><v:group/></w:pict>',
  '<w:drawing><wp:inline><wp:extent cx="12" cx2="3" cy="34"/></wp:inline></w:drawing>',
  '<w:pict><v:shape style="width:0;height:5pt"/></w:pict>',
]

const FORMATS: Array<Record<string, unknown>> = [
  {},
  { align: 'center' },
  { align: 'right', indentLeft: 720, indentFirstLine: -360, spaceBefore: 0, spaceAfter: 200 },
  { lineRule: 'exact', lineRawTwips: 300, keepNext: true, pageBreakBefore: true },
  {
    lineSpacing: 1.5,
    lineRule: 'auto',
    shadingFill: 'AABBCC',
    tabStops: [
      { pos: 1701, val: 'left', leader: 'dot' },
      { pos: 8500, val: 'right' },
    ],
  },
  { spaceBefore: 0 },
  { indentLeft: 0, indentRight: 0, indentFirstLine: 0 },
  { align: 'distribute', lineRule: 'atLeast', lineRawTwips: 280, keepLines: true },
  {
    tabStops: [
      { pos: 5, val: 'clear' },
      { pos: 7, val: 'bar', rel: 'margin' },
    ],
  },
]

const TEXT_FORMATS: Array<Record<string, unknown>> = [
  {},
  { bold: true, italic: true, underline: true, strike: true },
  { bold: false, italic: false },
  {
    color: 'FF0000',
    sizeHalfPoints: 28,
    font: 'Malgun Gothic',
    fontAscii: 'Arial',
    fontCs: 'Tahoma',
  },
  { vertAlign: 'superscript', caps: 'all', highlight: 'yellow' },
  {
    vertAlign: 'subscript',
    caps: 'small',
    shading: 'aabbcc',
    charSpacingTwips: 20,
    charScalePct: 150,
  },
  { eastAsiaFont: '\ub9d1\uc740 \uace0\ub515', font: 'x y' },
  { color: 'auto', sizeHalfPoints: 0 },
]

const DEFAULTS: Array<Record<string, unknown> | undefined> = [
  undefined,
  {},
  {
    sizeHalfPoints: 22,
    asciiFont: 'Calibri',
    eastAsiaFont: 'Malgun Gothic',
    csFont: 'Arial',
    lang: 'en-US',
    eastAsiaLang: 'ko-KR',
  },
  {
    lineSpacing: 1.08,
    spaceBeforeTwips: 0,
    spaceAfterTwips: 160,
    bold: true,
    italic: true,
    color: '112233',
  },
  { lineRule: 'exact', lineRawTwips: 240, lang: 'xx' },
  { lineRule: 'atLeast', lineRawTwips: 0, eastAsiaLang: 'zh' },
  { lang: 'en', eastAsiaLang: 'ja-JP', asciiFont: 'A B' },
  { lineRule: 'atLeast', lineRawTwips: 300, lineSpacing: 2 },
]

const masterSpec = (
  extra: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'Standard',
  layoutName: 'Mpm1',
  settings: {
    pageWidth: 11906,
    pageHeight: 16838,
    orientation: 'portrait',
    marginTop: 1417,
    marginBottom: 1417,
    marginLeft: 1134,
    marginRight: 1134,
    headerDist: 708,
    footerDist: 708,
    ...settings,
  },
  header: true,
  footer: true,
  regions: ['header', 'footer'],
  numFormat: null,
  mirrored: false,
  columns: { count: 1, gap: 0 },
  ...extra,
})

const MASTER_SPECS = [
  masterSpec(),
  masterSpec({ header: false, footer: false, regions: [] }),
  masterSpec(
    {
      numFormat: 'lowerRoman',
      mirrored: true,
      regions: ['header', 'header-left', 'header-first', 'footer', 'footer-left', 'footer-first'],
      columns: { count: 3, gap: 720 },
    },
    { gutter: 567, marginLeft: 1000 },
  ),
  masterSpec(
    { name: 'A&B', layoutName: 'L"1', numFormat: 'bogus' },
    {
      gutter: 100,
      gutterAtTop: true,
      headerDist: undefined,
      footerDist: 5000,
      orientation: 'landscape',
      pageWidth: 16838,
      pageHeight: 11906,
    },
  ),
  masterSpec({ header: true, footer: false }, { marginTop: 300, headerDist: 900, marginBottom: 0 }),
  masterSpec({ columns: { count: 2.6, gap: -5 } }, { marginLeft: -50 }),
]

const HEADING_XMLS = [
  '<office:document-content><office:automatic-styles><style:style style:name="H1" style:family="paragraph" style:parent-style-name="Heading"><style:paragraph-properties fo:text-align="start"/></style:style></office:automatic-styles><office:body><office:text><text:h text:style-name="H1" text:outline-level="1">T</text:h><text:p text:style-name="H1">shared</text:p><text:h text:outline-level="2">U</text:h></office:text></office:body></office:document-content>',
  '<office:automatic-styles><style:style style:name="A" style:family="paragraph"/></office:automatic-styles><text:h text:style-name="A" text:outline-level="1">a</text:h><text:h text:style-name="A" text:outline-level="3">b</text:h><text:h text:style-name="Heading1" text:outline-level="1">c</text:h><text:h text:style-name="Heading1" text:outline-level="2"/>',
  '<text:h>x</text:h><text:h text:outline-level="99">y</text:h><text:h text:outline-level="0">z</text:h><text:h text:outline-level="abc" xml:id="i" text:is-list-header="true" text:restart-numbering="true" text:start-value="3">w</text:h>',
  '<text:p>no headings</text:p>',
  '',
  '<office:automatic-styles><style:style style:name="B" style:family="paragraph" style:default-outline-level="2"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><text:h text:style-name="B" text:outline-level="2">b</text:h><text:h text:style-name="B" text:outline-level="1">c</text:h><text:h text:style-name="B_L1" text:outline-level="1">d</text:h>',
]

const COMMON_LEVELS: Array<Array<[string, number]>> = [
  [],
  [
    ['Heading1', 1],
    ['Heading2', 2],
  ],
  [
    ['Heading', 1],
    ['Other', 3],
  ],
]

const SOURCES = [
  {
    documentXml:
      '<w:p><w:r><w:rPr><w:color w:val="111111" w:themeColor="accent1"/></w:rPr></w:r></w:p>',
    stylesXml: '',
    parts: [],
  },
  {
    documentXml:
      '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="bogus"/>',
    stylesXml:
      '<w:docDefaults><w:rFonts w:asciiTheme="majorAscii"/><w:color w:themeColor="dk1" w:themeFill="accent9"/></w:docDefaults>',
    parts: ['<w:color w:themeColor="lt1"/><w:shd w:themeFill="text1"/>'],
  },
  {
    documentXml: '<w:pStyle w:val="A"/><w:rStyle w:val="B"/><w:tblStyle w:val="C"/>',
    stylesXml:
      '<w:style w:styleId="A"><w:rPr><w:color w:themeColor="accent1"/></w:rPr></w:style><w:style w:styleId="B"><w:rPr><w:color w:themeColor="bogus"/></w:rPr></w:style><w:style w:styleId="Z"><w:rPr><w:color w:themeColor="bogus"/></w:rPr></w:style><w:style w:styleId="Dflt"><w:rPr><w:rFonts w:asciiTheme="minorAscii"/></w:rPr></w:style>',
    parts: [],
  },
  { documentXml: '', stylesXml: '', parts: [] },
]

export const ASSEMBLE: CallSpec[] = [
  {
    fn: 'odtAssemble.readMetaPeople',
    call: (text, args) =>
      ts.assembleMeta.readMetaPeople({ metaXml: args.missing ? null : text } as never),
    fromDocument: (parts) =>
      part(parts, 'meta.xml') === undefined ? [] : [{ text: part(parts, 'meta.xml')! }],
    built: [...META_XMLS.map((text) => ({ text })), { text: '', args: { missing: true } }],
  },
  {
    fn: 'odtAssemble.coreXmlFor',
    call: (text, args) =>
      ts.assembleMeta.coreXmlFor(
        { metaXml: args.missing ? null : text } as never,
        args.people as never,
      ),
    fromDocument: (parts) =>
      part(parts, 'meta.xml') === undefined
        ? []
        : PEOPLE.slice(0, 3).map((people) => ({
            text: part(parts, 'meta.xml')!,
            args: { people },
          })),
    built: [
      ...META_XMLS.slice(0, 6).flatMap((text) =>
        PEOPLE.map((people) => ({ text, args: { people } })),
      ),
      { text: '', args: { missing: true, people: PEOPLE[0] } },
    ],
  },
  {
    fn: 'odtAssemble.personalInfoRemoved',
    call: (text, args) =>
      ts.assembleMeta.personalInfoRemoved(
        args.bridge === null ? null : (args.bridge as never),
        args.missing ? null : text,
        args.editedFlag as boolean,
      ),
    built: CORES.flatMap((text): Input[] =>
      [null, ...PEOPLE.slice(0, 4)].flatMap((bridge) =>
        [false, true].map((editedFlag) => ({ text, args: { bridge, editedFlag } })),
      ),
    ).concat([
      { text: '', args: { missing: true, bridge: PEOPLE[0], editedFlag: false } },
      { text: '', args: { missing: true, bridge: null, editedFlag: false } },
    ]),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.scrubMetaXml',
    call: (text) => ts.assembleMeta.scrubMetaXml(text),
    fromDocument: (parts) =>
      part(parts, 'meta.xml') === undefined ? [] : [{ text: part(parts, 'meta.xml')! }],
    built: META_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'odtAssemble.classifyObject',
    call: (text) => objects.classifyObject(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => /^word\/.*\.xml$/.test(n))
        .flatMap(([, xml]) =>
          distinct(
            [
              ...elementFragments(xml, 'w:drawing'),
              ...elementFragments(xml, 'w:pict'),
              ...elementFragments(xml, 'w:object'),
              ...elementFragments(xml, 'mc:AlternateContent'),
              ...elementFragments(xml, 'm:oMath'),
            ],
            30,
          ).map((text) => ({ text })),
        ),
    built: OBJECT_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'odtAssemble.objectSize',
    call: (text) => objects.objectSize(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => /^word\/.*\.xml$/.test(n))
        .flatMap(([, xml]) =>
          distinct(
            [
              ...elementFragments(xml, 'w:drawing'),
              ...elementFragments(xml, 'w:pict'),
              ...elementFragments(xml, 'mc:AlternateContent'),
            ],
            30,
          ).map((text) => ({ text })),
        ),
    built: OBJECT_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'odtAssemble.fallbackPictureRId',
    call: (text) => objects.fallbackPictureRId(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => /^word\/.*\.xml$/.test(n))
        .flatMap(([, xml]) =>
          distinct(
            [...elementFragments(xml, 'w:object'), ...elementFragments(xml, 'mc:AlternateContent')],
            30,
          ).map((text) => ({ text })),
        ),
    built: OBJECT_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'odtAssemble.drawingXml',
    call: (text, args) => objects.drawingXml(args.cx as number, args.cy as number, text),
    built: [
      [100, 200, 'Picture 1'],
      [0, 0, ''],
      [-5, 2.5, 'a & "b" <c>'],
      [914400.6, 0.4, 'odt-label:chart'],
      [1e12, 1, '\ud55c\uae00 \ud83d\ude00'],
    ].map(([cx, cy, text]) => ({ text: text as string, args: { cx, cy } })),
  },
  {
    fn: 'odtAssemble.dataUrlOf',
    call: (_t, args) => objects.dataUrlOf(bytesOf(args.bytes)),
    built: [
      ts.helpersHancomSample.PNG_1X1,
      ts.helpersObjectsFixtures.PNG_GREY,
      new Uint8Array([0xff, 0xd8, 0xff, 0]),
      new Uint8Array(),
      new Uint8Array([1, 2, 3, 4, 5]),
      new TextEncoder().encode('<svg>'),
    ].map((bytes) => ({ args: { bytes: bytesArg(bytes) } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.pictureRun',
    call: (text, args) =>
      wire(objects.pictureRun(bytesOf(args.bytes), args.cx as number, args.cy as number, text)),
    built: [
      [ts.helpersHancomSample.PNG_1X1, 100, 200, 'Picture 1'],
      [new Uint8Array([0xff, 0xd8, 0xff, 0]), 1, 1, 'x &'],
      [new Uint8Array(), 0, 0, ''],
    ].map(([bytes, cx, cy, text]) => ({
      text: text as string,
      args: { bytes: bytesArg(bytes as Uint8Array), cx, cy },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.labelRun',
    call: (_t, args) => objects.labelRun(args.kind as never, args.cx as number, args.cy as number),
    built: [
      ['chart', 100, 200],
      ['equation', 0, 0],
      ['shape', 1.5, 2.5],
      ['textbox', 1e9, 1],
    ].map(([kind, cx, cy]) => ({ args: { kind, cx, cy } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.defaultSize',
    call: (text, args) => objects.defaultSize(args.kind as never, text),
    built: [
      ['equation', ''],
      ['equation', 'x=1'],
      ['equation', 'y'.repeat(60)],
      ['equation', '\ud55c'.repeat(10)],
      ['chart', ''],
      ['shape', 'abc'],
      ['textbox', ''],
    ].map(([kind, text]) => ({ text: text as string, args: { kind } })),
  },
  {
    fn: 'odtAssemble.solidPng',
    call: (_t, args) =>
      wire(objects.solidPng(args.r as number, args.g as number, args.b as number)),
    built: [
      [0, 0, 0],
      [255, 255, 255],
      [200, 30, 30],
      [1, 2, 3],
      [255, 0, 128],
    ].map(([r, g, b]) => ({ args: { r, g, b } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.headingsAsParagraphs',
    call: (text, args) =>
      ts.exportHeadings.headingsAsParagraphs(
        text,
        new Map(args.commonLevels as Array<[string, number]>),
      ),
    fromDocument: (parts) =>
      part(parts, 'content.xml') === undefined
        ? []
        : COMMON_LEVELS.map((commonLevels) => ({
            text: part(parts, 'content.xml')!,
            args: { commonLevels },
          })),
    built: HEADING_XMLS.flatMap((text) =>
      COMMON_LEVELS.map((commonLevels) => ({ text, args: { commonLevels } })),
    ),
  },
  {
    fn: 'odtAssemble.withRowFloors',
    call: (_t, args) =>
      ts.exportRows.withRowFloors(args.model as TableModel, parsedOf(args.parsed)),
    fromModel: (doc) => {
      const parsed = wholeModel('withRowFloors', doc)
      return parsed === null
        ? []
        : doc.blocks
            .filter((b) => b.table)
            .slice(0, 2)
            .map((b) => ({ args: { model: b.table, parsed } }))
    },
    built: FIXTURES.flatMap(({ parsed }) =>
      parsed.blocks
        .filter((b) => b.table)
        .slice(0, 3)
        .flatMap((b) => {
          const model = b.table!
          const taller = {
            ...model,
            rowHeightsTwips: model.rows.map(() => 10),
            rowHeightRules: model.rows.map(() => 'atLeast'),
          }
          const exact = {
            ...model,
            rowHeightsTwips: model.rows.map(() => 100000),
            rowHeightRules: model.rows.map(() => 'exact'),
          }
          return [model, taller, exact].map((m) => ({
            args: { model: m, parsed: parsedArg(parsed) },
          }))
        }),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtAssemble.paragraphProps',
    call: (_t, args) => styles.paragraphProps(args.format as never),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .filter((b) => b.format)
          .slice(0, 40)
          .map((b) => ({ args: { format: b.format } })),
        30,
      ),
    built: FORMATS.map((format) => ({ args: { format } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtAssemble.textProps',
    call: (_t, args) => {
      const fonts = new styles.FontSet()
      const attrs = styles.textProps(args.format as never, fonts)
      return { attrs, families: [...fonts.families] }
    },
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .flatMap((b) => (b.runs ?? []).slice(0, 3))
          .slice(0, 60)
          .map((format) => ({ args: { format } })),
        30,
      ),
    built: TEXT_FORMATS.map((format) => ({ args: { format } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtAssemble.documentDefaults',
    call: (_t, args) => styles.documentDefaults(args.defaults as never),
    fromModel: (doc) => [{ args: { defaults: doc.docDefaults } }],
    built: DEFAULTS.map((defaults) => ({ args: defaults === undefined ? {} : { defaults } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.defaultStyleXml',
    call: (_t, args) => {
      const fonts = new styles.FontSet()
      const xml = styles.defaultStyleXml(args.defaults as never, fonts)
      return { xml, decls: fonts.decls() }
    },
    fromModel: (doc) => [{ args: { defaults: doc.docDefaults } }],
    built: DEFAULTS.map((defaults) => ({ args: defaults === undefined ? {} : { defaults } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.paragraphStylesXml',
    call: (_t, args) => {
      const fonts = new styles.FontSet()
      const result = styles.paragraphStylesXml(parsedOf(args.parsed), fonts)
      return { xml: result.xml, names: [...result.names], base: result.base, decls: fonts.decls() }
    },
    fromModel: (doc) => {
      const parsed = wholeModel('paragraphStylesXml', doc)
      return parsed === null ? [] : [{ args: { parsed } }]
    },
    built: FIXTURES.map(({ parsed }) => ({ args: { parsed: parsedArg(parsed) } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtAssemble.pageLayoutXml',
    call: (_t, args) => styles.pageLayoutXml(args.spec as never),
    built: MASTER_SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtAssemble.columnsXml',
    call: (_t, args) => styles.columnsXml(args.columns as never),
    built: [
      { count: 1, gap: 0 },
      { count: 2, gap: 720 },
      { count: 3, gap: 0.5 },
      { count: 0, gap: 10 },
      { count: 2.5, gap: -5 },
      { count: 4, gap: 567 },
    ].map((columns) => ({ args: { columns } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.masterPageXml',
    call: (_t, args) => styles.masterPageXml(args.spec as never),
    built: MASTER_SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.unresolvedThemeReferences',
    call: (text, args) =>
      ts.exportTheme.unresolvedThemeReferences(parsedOf(args.parsed), {
        documentXml: text,
        stylesXml: args.stylesXml as string,
        parts: args.parts as string[],
      }),
    built: [
      ...FIXTURES.map(({ parsed, documentXml, stylesXml, parts }) => ({
        text: documentXml,
        args: { parsed: parsedArg(parsed), stylesXml, parts },
      })),
      ...SOURCES.flatMap((sources) =>
        FIXTURES.slice(0, 4).map(({ parsed }) => ({
          text: sources.documentXml,
          args: { parsed: parsedArg(parsed), stylesXml: sources.stylesXml, parts: sources.parts },
        })),
      ),
    ],
    mutation: 'none',
  },
  {
    fn: 'odtAssemble.odtToDocxReport',
    call: (_t, args) =>
      ts.assembleReport.odtToDocxReport(
        { contentXml: args.contentXml } as never,
        args.map as never,
      ),
    built: REPORT_FIXTURES.flatMap(({ map, contentXml }) =>
      [
        contentXml,
        contentXml + '<text:changed-region text:id="a"/><text:changed-region text:id="b"/>',
        contentXml +
          '<text:section text:protected="true"/><text:section text:style-name="S" text:protected="true"/>',
        '',
      ].map((content) => ({ args: { map, contentXml: content } })),
    ),
    mutation: 'none',
  },
  constantSpec('odtAssemble', {
    ASSEMBLE_EXT_KEY: () => ts.assembleOdt.ASSEMBLE_EXT_KEY,
    REPORT_FEATURES: () => ts.assembleReport.REPORT_FEATURES,
    LABEL_PREFIX: () => objects.LABEL_PREFIX,
    outlineStyleXml: () => styles.outlineStyleXml(),
  }),
]
