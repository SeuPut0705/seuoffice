// Group genProps: the paragraph property builders of generate.ts
// (PPR_CHILD_ORDER through setPPrChange).
import {
  mergeCellParaFormat,
  mergePPrFormat,
  paraMarkColor,
  paraMarkRevisionXml,
  resolveParaMarkRPrChange,
  setParaMarkRevision,
  setPPrChange,
  splitXmlChildren,
  stripParaMarkColor,
  stripParaMarkRevision,
  stripPPrChange,
} from './reference/generate'
import type { ParaFormat } from './reference/types'
import type { CallSpec, Input } from './calls-spec'
import { pprModelInputs } from './generate-model-inputs'

/** Every top-level w:pPr of a part (one nested in w:pPrChange stays inside its parent). */
function pPrsOf(xml: string): string[] {
  const out: string[] = []
  const tag = /<w:pPr(?: [^>]*)?(\/?)>|<\/w:pPr>/g
  let depth = 0
  let start = -1
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[0] === '</w:pPr>') {
      depth--
      if (depth === 0 && start >= 0) out.push(xml.slice(start, m.index + m[0].length))
    } else if (m[1] === '/') {
      if (depth === 0) out.push(m[0])
    } else {
      if (depth === 0) start = m.index
      depth++
    }
  }
  return out
}

const corpusPPrs = (parts: ReadonlyMap<string, string>): string[] => {
  const raws = new Set<string>()
  for (const [name, xml] of parts) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue
    for (const raw of pPrsOf(xml)) {
      if (raws.size >= 40) break
      raws.add(raw)
    }
  }
  return [...raws]
}

const P = (inner: string): string => `<w:pPr>${inner}</w:pPr>`

const RAWS = [
  '',
  '<w:pPr/>',
  '<w:pPr />',
  P(''),
  P(
    '<w:pStyle w:val="Heading1"/><w:keepNext/><w:spacing w:before="240" w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/>',
  ),
  P(
    '<w:spacing w:before="0" w:beforeAutospacing="1" w:after="120" w:afterAutospacing="0" w:line="240" w:lineRule="exact"/>',
  ),
  P('<w:spacing w:line="300" w:lineRule="atLeast" w:afterLines="50"/>'),
  P('<w:ind w:left="720" w:hanging="360"/>'),
  P('<w:ind w:start="420" w:end="-100" w:firstLineChars="200" w:firstLine="420"/>'),
  P('<w:ind w:firstLine="0"/><w:jc w:val="both"/><w:bidi/>'),
  P(
    '<w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="FF0000"/><w:bottom w:val="nil"/><w:left w:val="double" w:sz="12" w:space="4" w:color="auto"/></w:pBdr>',
  ),
  P(
    '<w:pBdr><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:pBdr>',
  ),
  P('<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:shd w:val="pct10" w:fill="auto"/>'),
  P(
    '<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs>',
  ),
  P('<w:tabs><w:tab w:val="clear" w:pos="x"/></w:tabs><w:suppressAutoHyphens/>'),
  P('<w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>'),
  P('<w:framePr w:dropCap="margin" w:lines="0"/>'),
  P(
    '<w:framePr w:w="2000" w:h="500" w:hRule="atLeast" w:wrap="none" w:vAnchor="page" w:hAnchor="page" w:x="100" w:y="200"/>',
  ),
  P('<w:widowControl w:val="0"/><w:contextualSpacing/><w:suppressLineNumbers w:val="false"/>'),
  P('<w:pageBreakBefore/><w:keepLines w:val="0"/>'),
  P('<w:textDirection w:val="tbRl"/><w:outlineLvl w:val="0"/>'),
  P('<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>'),
  P('<w:rPr><w:color w:val="#ff0000"/><w:b/></w:rPr>'),
  P('<w:rPr><w:color w:val="auto"/></w:rPr>'),
  P('<w:rPr><w:color w:val="00FF00"></w:color></w:rPr><w:sectPr><w:pgSz w:w="12240"/></w:sectPr>'),
  P(
    '<w:rPr><w:ins w:id="1" w:author="A"/><w:del w:id="2" w:author="B"/><w:moveFrom w:id="3" w:author="C"/></w:rPr>',
  ),
  P('<w:rPr><w:moveTo w:id="3" w:author="C"/><w:b/></w:rPr>'),
  P('<w:rPr/>'),
  P(
    '<w:rPr><w:ins w:id="1" w:author="A"/><w:b/><w:rPrChange w:id="9" w:author="X"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>',
  ),
  P('<w:rPr><w:b/><w:rPrChange w:id="9" w:author="X"/></w:rPr>'),
  P('<w:rPr><w:rPrChange w:id="9" w:author="X"><w:rPr></w:rPr></w:rPrChange></w:rPr>'),
  P('<w:rPr><w:b/><w:rPrChange w:id="9"><w:rPr><w:i/></w:rPr>'),
  P(
    '<w:jc w:val="left"/><w:pPrChange w:id="4" w:author="R"><w:pPr><w:jc w:val="right"/><w:rPr><w:color w:val="111111"/></w:rPr></w:pPr></w:pPrChange>',
  ),
  P('<w:pPrChange w:id="4" w:author="R"><w:pPr/>'),
  P('<w:cnfStyle w:val="1"/><w:x-unknown/><w:jc w:val="constructor"/><w:ind w:left="1"/>'),
  P('<w:sectPr><w:cols/></w:sectPr>'),
  '<w:pPr w:rsid="00A1">' + '<w:jc w:val="end"/><w:bidi/></w:pPr>',
  P('<w:rPr><w:b/></w:rPr>$&$$'),
]

const FORMATS: Array<ParaFormat | undefined> = [
  undefined,
  {},
  { align: 'center', spaceBefore: 240, spaceAfter: 0, lineSpacing: 1.5, keepNext: true },
  {
    align: 'justify',
    bidi: true,
    indentLeft: 720,
    indentFirstLine: -360,
    spaceBeforeAuto: true,
    spaceAfterAuto: false,
  },
  {
    align: 'left',
    bidiInherited: true,
    indentRight: -100,
    indentFirstLine: 420,
    charIndents: { firstLine: 200 },
  },
  {
    lineRule: 'exact',
    lineRawTwips: 240.4,
    spaceAfter: 120,
    widowControl: false,
    contextualSpacing: true,
    suppressLineNumbers: false,
  },
  {
    lineRule: 'atLeast',
    lineRawTwips: 300,
    lineSpacing: 2,
    keepLines: false,
    pageBreakBefore: true,
  },
  {
    borders: 'tlbr',
    borderStyle: { color: 'FF0000', szEighths: 1, spacePt: 40 },
    borderLines: { t: { color: '00FF00', szPt: 0.5, spacePt: 1 }, b: { szPt: 1.5 } },
  },
  {
    borders: 'bt',
    borderLines: {
      t: { color: 'FF0000', szPt: 0.5, spacePt: 1 },
      l: { color: 'X', szPt: 1.5, spacePt: 4 },
    },
  },
  { borders: 'tlbr', borderStyle: { szEighths: 4 } },
  {
    shadingFill: 'FFFF00',
    tabStops: [
      { pos: 720, val: 'left' },
      { pos: 9350, val: 'right', leader: 'dot' },
    ],
  },
  {
    tabStops: [
      { pos: 720, val: 'left', leader: 'none' },
      { pos: 100, val: 'center', rel: 'margin' },
      { pos: 200, val: 'bar', inherited: true },
    ],
  },
  { tabStops: [] },
  { dropCap: { type: 'drop', lines: 3 } },
  { dropCap: { type: 'margin', lines: 2 }, textDirection: 'btLr' },
  { frame: { wTwips: 2000, hTwips: 500, xTwips: 100, yTwips: 200 } },
  {
    frame: {
      wTwips: 2000.5,
      xTwips: 1,
      yTwips: 2,
      hRule: 'exact',
      vSpaceTwips: 10,
      hSpaceTwips: 20,
      wrap: 'around',
      vAnchor: 'text',
      hAnchor: 'margin',
      xAlign: 'center',
      yAlign: 'inline',
      anchorLock: true,
    },
  },
  { emptyRunSizeHalfPoints: 28 },
  { emptyRunSizeHalfPoints: 21.5, align: 'distribute', lineSpacing: 1.155 },
  { indentLeft: 1, align: 'right' },
  { indentLeft: 0, indentRight: 0, indentFirstLine: 0, spaceBefore: -10 },
  { align: 'right', bidi: true, borders: 'x', shadingFill: 'a&b"' },
]

const ORIGINALS: Array<ParaFormat | undefined> = [
  undefined,
  { indentLeft: 720, indentFirstLine: -360 },
  { indentFirstLine: 420, charIndents: { firstLine: 200 } },
  { indentLeft: 0, charIndents: { left: 2, right: 1, hanging: 3 } },
  { keepNext: true, widowControl: true },
  { align: 'center', spaceBefore: 240, spaceAfter: 0, lineSpacing: 1.5 },
]

const ONLY: Array<string[] | undefined> = [
  undefined,
  ['w:jc'],
  ['w:tabs', 'w:jc'],
  ['w:ind', 'w:keepNext'],
]

/** w:ind whose first attribute is empty: `??` keeps it, so parseInt reads NaN and the group rebuilds
 *  even though the fallback attribute equals the model. */
const EMPTY_IND: Input[] = (
  [
    ['<w:ind w:left="" w:start="720"/>', { indentLeft: 720 }],
    ['<w:ind w:right="" w:end="360"/>', { indentRight: 360 }],
    ['<w:ind w:left="" w:start="720" w:hanging=""/>', { indentLeft: 720 }],
    [
      '<w:ind w:left="" w:start="720" w:right="" w:end="360" w:hanging="240"/>',
      { indentLeft: 720, indentRight: 360, indentFirstLine: -240 },
    ],
    ['<w:ind w:left="" w:start="720"/>', { indentLeft: 720, align: 'center' }],
  ] as Array<[string, ParaFormat]>
).flatMap(([ind, format]) => [
  { text: P(`<w:jc w:val="center"/>${ind}`), args: { format } },
  { text: P(ind), args: { format, original: { indentLeft: 1 } } },
])

const merges = (texts: string[], all: boolean): Input[] =>
  texts.flatMap((text, i) =>
    (all ? FORMATS : FORMATS.filter((_, j) => (i + j) % 4 === 0)).flatMap((format, j) => [
      { text, args: { format, original: ORIGINALS[(i + j) % ORIGINALS.length] } },
      {
        text,
        args: {
          format,
          original: ORIGINALS[(i + j + 2) % ORIGINALS.length],
          onlyTags: ONLY[(i + j) % ONLY.length],
        },
      },
    ]),
  )

const cellMerges = (texts: string[], all: boolean): Input[] =>
  texts.flatMap((text, i) =>
    (all ? FORMATS : FORMATS.filter((_, j) => (i + j) % 4 === 0))
      .filter((f) => f !== undefined)
      .flatMap((format, j) => [
        { text, args: { format, original: ORIGINALS[(i + j) % ORIGINALS.length] } },
        { text, args: { format, original: format } },
        {
          text,
          args: { format: { ...format, spaceAfter: 6, indentFirstLine: 0 }, original: format },
        },
      ]),
  )

const texts = (list: string[]): Input[] => list.map((text) => ({ text }))

const MARKERS = [
  '',
  '<w:ins w:id="" w:author="A"/>',
  '<w:del w:id="7" w:author="B" w:date="2024-01-01T00:00:00Z"/>',
  '$&<w:ins/>$$',
]

const RECORDS: Array<[string | null, string | undefined]> = [
  [null, undefined],
  ['', '5'],
  ['{"author":"A","date":"2024-01-01T00:00:00Z"}', '12'],
  ['{"author":"<B&\\"">"}', undefined],
  ['{"date":""}', '3'],
  ['{"author":null,"date":0}', '1'],
  ['{"author":5}', '1'],
  ['{"date":true}', '1'],
  ['null', '1'],
  ['42', '1'],
  ['"str"', '1'],
  ['[1,2]', '1'],
  ['{bad json', '1'],
  ['{"author":"A","author":"Z"}', '8'],
]

const CHANGES = [
  '',
  'not json',
  'null',
  '7',
  '"s"',
  '{}',
  '{"id":"3","author":"Ann","date":"2024-01-01T00:00:00Z","dateUtc":"2024-01-01T00:00:00Z","old":{"styleId":"Heading1","format":{"align":"center","spaceBefore":240,"keepNext":true}}}',
  '{"id":5,"author":"B<&>","old":{"type":"docListItem","numId":"4","ilvl":"2","align":"right","indentLeft":720,"styleId":7,"text":"ignored"}}',
  '{"author":"C","old":{"type":"docListItem","numId":3,"ilvl":12,"format":null,"bidi":true,"align":"left"}}',
  '{"author":"C","old":{"type":"docListItem","numId":1,"ilvl":-4}}',
  '{"author":"C","old":{"type":"docListItem","numId":1,"ilvl":[1]}}',
  '{"author":"D","old":{"format":{"tabStops":[{"pos":720,"val":"left"}],"dropCap":{"type":"drop","lines":2}}}}',
  '{"author":"E","old":0}',
  '{"author":"E","old":"str","date":0}',
  '{"author":null,"id":null,"old":{"styleId":["a","b"],"format":{}}}',
]

export const GEN_PROPS: CallSpec[] = [
  {
    fn: 'genProps.mergePPrFormat',
    argMutation: true,
    call: (text, args) =>
      mergePPrFormat(
        text,
        args.format as ParaFormat | undefined,
        args.original as ParaFormat | undefined,
        args.onlyTags === undefined ? undefined : new Set(args.onlyTags as string[]),
      ),
    fromDocument: (parts) => merges(corpusPPrs(parts), false),
    built: [...merges(RAWS, true), ...EMPTY_IND],
    fromModel: pprModelInputs,
  },
  {
    fn: 'genProps.mergeCellParaFormat',
    argMutation: true,
    call: (text, args) =>
      mergeCellParaFormat(text, args.format as ParaFormat, args.original as ParaFormat | undefined),
    fromDocument: (parts) => cellMerges(corpusPPrs(parts), false),
    built: cellMerges(RAWS, true),
    fromModel: pprModelInputs,
  },
  {
    fn: 'genProps.paraMarkColor',
    call: (text) => paraMarkColor(text),
    fromDocument: (parts) => texts(corpusPPrs(parts)),
    built: texts(RAWS),
  },
  {
    fn: 'genProps.stripParaMarkColor',
    call: (text) => stripParaMarkColor(text),
    fromDocument: (parts) => texts(corpusPPrs(parts)),
    built: texts(RAWS),
  },
  {
    fn: 'genProps.paraMarkRevisionXml',
    call: (text, args) =>
      paraMarkRevisionXml(
        args.kind as 'del' | 'ins',
        args.nullRecord ? null : text,
        args.mintId === undefined ? undefined : () => args.mintId as string,
      ),
    built: RECORDS.flatMap(([record, mintId]) =>
      (['del', 'ins'] as const).map((kind) => ({
        text: record ?? '',
        args: { kind, nullRecord: record === null, mintId },
      })),
    ),
  },
  {
    fn: 'genProps.setParaMarkRevision',
    call: (text, args) => setParaMarkRevision(text, args.markerXml as string),
    fromDocument: (parts) =>
      corpusPPrs(parts).map((text, i) => ({ text, args: { markerXml: MARKERS[1 + (i % 3)] } })),
    built: RAWS.flatMap((text) => MARKERS.map((markerXml) => ({ text, args: { markerXml } }))),
  },
  {
    fn: 'genProps.stripParaMarkRevision',
    call: (text, args) => stripParaMarkRevision(text, args.kind as 'del' | 'ins'),
    fromDocument: (parts) =>
      corpusPPrs(parts).flatMap((text) => [
        { text, args: { kind: 'del' } },
        { text, args: { kind: 'ins' } },
      ]),
    built: RAWS.flatMap((text) => [
      { text, args: { kind: 'del' } },
      { text, args: { kind: 'ins' } },
    ]),
  },
  {
    fn: 'genProps.resolveParaMarkRPrChange',
    call: (text, args) => resolveParaMarkRPrChange(text, args.mode as 'accept' | 'reject'),
    fromDocument: (parts) =>
      corpusPPrs(parts).flatMap((text) => [
        { text, args: { mode: 'accept' } },
        { text, args: { mode: 'reject' } },
      ]),
    built: RAWS.flatMap((text) => [
      { text, args: { mode: 'accept' } },
      { text, args: { mode: 'reject' } },
    ]),
  },
  {
    fn: 'genProps.stripPPrChange',
    call: (text) => stripPPrChange(text),
    fromDocument: (parts) => texts(corpusPPrs(parts)),
    built: texts(RAWS),
  },
  {
    fn: 'genProps.setPPrChange',
    call: (text, args) => setPPrChange(text, args.changeJson as string),
    fromDocument: (parts) =>
      corpusPPrs(parts).map((text, i) => ({ text, args: { changeJson: CHANGES[6 + (i % 6)] } })),
    built: RAWS.flatMap((text, i) =>
      CHANGES.filter((_, j) => i < 4 || (i + j) % 3 === 0).map((changeJson) => ({
        text,
        args: { changeJson },
      })),
    ),
  },
  {
    fn: 'genProps.splitXmlChildren',
    call: (text) => splitXmlChildren(text),
    fromDocument: (parts) =>
      texts(corpusPPrs(parts).map((p) => p.replace(/^<w:pPr[^>]*>|<\/w:pPr>$/g, ''))),
    built: texts([
      ...RAWS,
      '<a><b></a>',
      '</x><y/>',
      "<w:t a='>'>x</w:t><c/>",
      // a comment, CDATA or a processing instruction that fakes a tag or hides one
      '<w:r><!-- </w:r> --><w:t>a</w:t></w:r><w:b/>',
      '<w:r><w:t><![CDATA[</w:r><w:r>]]></w:t></w:r><w:i/>',
      '<w:r><?pi </w:r> ?></w:r><w:u/>',
      '<!-- <w:b/> --><w:i/><![CDATA[<w:u/>]]><?pi <w:u/> ?>',
      '<w:a/><!-- never closed <w:b/>',
      '<w:a><!--></w:a>--></w:a><w:b/>',
      '<w:rFonts w:ascii="\u{1F600}"/><!-- \u{1F600} --><w:b w:x=\'<!-- x -->\'/>',
      '<w:a w:x="<![CDATA["/><w:b/>]]>',
    ]),
  },
]
