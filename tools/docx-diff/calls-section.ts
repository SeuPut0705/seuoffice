// Group `section`: the readers of section.ts, watermark.ts and notes.ts, and
// the parse-vml.ts helpers the watermark readers stand on.
import { nextNoteId, noteModelText, parseNotesXml, rootAttributes } from './reference/notes'
import {
  anchorRelH,
  anchorRelV,
  vmlColorHex,
  vmlFloatAnchor,
  vmlFraction,
  vmlLengthPx,
  vmlRotationDeg,
  vmlStyleDimPx,
  vmlStyleProp,
} from './reference/parse-vml'
import {
  hfReferenceRId,
  hfReferenceTags,
  hfReferenceType,
  lineNumberingOf,
  notePropsFromXml,
  readPageColor,
  readSections,
  readSectionSettings,
  sectionFromSectPr,
  sectionSettingsFromXml,
  xmlFlagOn,
} from './reference/section'
import type { HfImage, ParsedDoc } from './reference/types'
import {
  isPictureWatermark,
  isPictureWatermarkShape,
  isWatermarkChild,
  pictureWatermarkBoxPt,
  pictureWatermarkParagraphXml,
  pictureWatermarkPreviewImage,
  readPictureWatermark,
  readWatermarkShape,
  readWatermarkText,
  textWatermarkBoxPt,
  textWatermarkPreviewImage,
  watermarkParagraphXml,
  type PictureWatermarkSpec,
  type Watermark,
  type WatermarkSpec,
} from './reference/watermark'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments, tagTokens } from './fragments'
import { NOTE_PARTS } from './withheld-inputs'

type NoteKind = 'footnote' | 'endnote'
type NotePrTag = 'w:footnotePr' | 'w:endnotePr'
type HfKind = 'header' | 'footer'
type MarginBox = { widthPt: number; heightPt: number } | null

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const NOTE_NS = `xmlns:w="${W}" xmlns:r="${R}"`

const sectPr = (inner: string): string => `<w:sectPr>${inner}</w:sectPr>`

/** Attribute values each integer reader meets: absent, empty, garbage, signs, fractions, units. */
const NUMBERS = [
  '',
  'abc',
  '0',
  '-0.4',
  '-720',
  '1987.1997',
  '2.5',
  '-2.5',
  '1440pt',
  '12.',
  '.5',
  ' 7',
  '1e3',
  '9'.repeat(400),
]

/** Every numeric attribute the section reader knows, in its element. */
const NUMERIC_ATTRIBUTES: Array<[element: string, attribute: string]> = [
  ['w:pgSz', 'w:w'],
  ['w:pgSz', 'w:h'],
  ['w:pgMar', 'w:top'],
  ['w:pgMar', 'w:right'],
  ['w:pgMar', 'w:bottom'],
  ['w:pgMar', 'w:left'],
  ['w:pgMar', 'w:header'],
  ['w:pgMar', 'w:footer'],
  ['w:pgMar', 'w:gutter'],
  ['w:cols', 'w:num'],
  ['w:cols', 'w:space'],
  ['w:lnNumType', 'w:countBy'],
  ['w:lnNumType', 'w:start'],
  ['w:lnNumType', 'w:distance'],
  ['w:docGrid', 'w:linePitch'],
  ['w:docGrid', 'w:charSpace'],
  ['w:pgNumType', 'w:start'],
]

const BORDERS =
  `<w:pgBorders w:offsetFrom="page" w:display="firstPage" w:zOrder="back">` +
  `<w:top w:val="single" w:sz="4" w:space="24" w:color="FF0000"/>` +
  `<w:left w:val="none" w:sz="4"/>` +
  `<w:bottom w:val="apples" w:sz="20" w:space="10" w:shadow="1" w:frame="true" w:color="auto"/>` +
  `<w:right w:val="nil"/>` +
  `</w:pgBorders>`

const SECT_PRS: string[] = [
  '',
  '<w:sectPr/>',
  sectPr(''),
  '<w:sectPr>',
  ...NUMERIC_ATTRIBUTES.flatMap(([element, attribute]) =>
    NUMBERS.map((v) => sectPr(`<${element} ${attribute}="${v}"/>`)),
  ),
  ...NUMERIC_ATTRIBUTES.map(([element, attribute]) => sectPr(`<${element} ${attribute}='360'/>`)),
  ...NUMERIC_ATTRIBUTES.map(([element, attribute]) => sectPr(`<${element} ${attribute} = "360"/>`)),
  // a fully written Word section
  sectPr(
    '<w:headerReference w:type="default" r:id="rId8"/><w:headerReference w:type="first" r:id="rId9"/>' +
      '<w:footerReference w:type="even" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/>' +
      '<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/><w:numRestart w:val="eachPage"/></w:footnotePr>' +
      '<w:endnotePr><w:pos w:val="sectEnd"/><w:numFmt w:val="chicago"/></w:endnotePr>' +
      '<w:type w:val="continuous"/><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
      `${BORDERS}<w:lnNumType w:countBy="5" w:start="2" w:distance="360" w:restart="continuous"/>` +
      '<w:pgNumType w:fmt="lowerRoman" w:start="4"/><w:cols w:space="425" w:num="2"/>' +
      '<w:vAlign w:val="center"/><w:titlePg/><w:textDirection w:val="tbRl"/><w:bidi/>' +
      '<w:docGrid w:type="lines" w:linePitch="312" w:charSpace="-4096"/>',
  ),
  // orientation
  sectPr('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>'),
  sectPr('<w:pgSz w:w="15840" w:h="12240" w:orient="portrait"/>'),
  sectPr("<w:pgSz w:orient='Landscape'/>"),
  // margins: negative (fixed), gutter, fractional
  sectPr('<w:pgMar w:top="-1440" w:bottom="-720" w:left="1440" w:right="1440"/>'),
  sectPr('<w:pgMar w:top="1440" w:left="1440" w:gutter="720"/>'),
  sectPr('<w:pgMar w:top="-1440" w:left="1440" w:gutter="567.5"/>'),
  sectPr('<w:pgMar w:gutter="-360"/>'),
  // margins as another producer may spell them: single quotes, white space
  // around `=`, a spaced `/>`; read, and rewritten in place, not added twice
  sectPr(`<w:pgMar w:top = '1440' w:right="1800" w:bottom ='720' w:left= "1440" w:header='851'/>`),
  sectPr(`<w:pgMar w:top='-1440' w:left='1440' w:gutter = '360' />`),
  sectPr(`<w:pgMar w:top = "1440" w:footer=	'992'/>`),
  // columns, equal and unequal
  sectPr('<w:cols w:space="720" w:num="2"/>'),
  sectPr(
    '<w:cols w:num="3" w:space="300" w:equalWidth="0"><w:col w:w="2000" w:space="300"/>' +
      `<w:col w:w='3000.6'/><w:col w:w="0"/><w:col w:w="abc"/></w:cols>`,
  ),
  sectPr(
    '<w:cols w:num="2" w:equalWidth="0"><w:col w:w="2000"></w:col><w:col w:w="3000"></w:col></w:cols>',
  ),
  sectPr('<w:cols w:num="2" w:equalWidth="0"><w:col w:w="2000"/><w:col w:space="3"/></w:cols>'),
  sectPr('<w:cols w:num="2" w:equalWidth="0"><w:col  w:w="2000"/><w:col\tw:w="3000"/></w:cols>'),
  sectPr('<w:cols w:num="2"/><w:x><w:col w:w="100"/><w:col w:w="200"/></w:x></w:cols>'),
  sectPr('<w:colsX w:num="4"/>'),
  // start types
  ...['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn', 'bogus', ''].map((v) =>
    sectPr(`<w:type w:val="${v}"/>`),
  ),
  sectPr('<w:type/>'),
  // title page and even/odd, every spelling of the flag
  ...[
    '<w:titlePg/>',
    '<w:titlePg w:val="0"/>',
    '<w:titlePg w:val="false"/>',
    "<w:titlePg w:val='off'/>",
    '<w:titlePg w:val="1"/>',
    '<w:titlePg w:val="on"/>',
    '<w:titlePg></w:titlePg>',
    '<w:titlePgX/>',
    '<w:titlePg w:val="0"/><w:titlePg/>',
    '<w:titlePg\nw:val="true"/>',
  ].map(sectPr),
  // page borders
  sectPr(BORDERS),
  sectPr('<w:pgBorders><w:top w:val="none"/><w:left w:val="nil"/></w:pgBorders>'),
  sectPr('<w:pgBorders/>'),
  sectPr('<w:pgBorders w:display="notFirstPage"><w:top w:val=""/><w:left/></w:pgBorders>'),
  sectPr(
    `<w:pgBorders w:offsetFrom='text' w:zOrder="front" w:display=""><w:left w:val='double' w:sz='12' w:space='4' w:color='00ff00' w:shadow='on' w:frame='0'/>` +
      `<w:left w:val="thick" w:sz="16"/><w:right w:val="gems" w:sz="31" w:space="31" w:color="0000FF"/></w:pgBorders>`,
  ),
  sectPr(
    '<w:pgBorders w:zOrder = "back"><w:top w:val="dotted" w:sz="5" w:space="1.5"/><w:bottom w:val="threeDEmboss" w:sz="abc"/>' +
      '<w:topX w:val="single"/></w:pgBorders>',
  ),
  sectPr(
    '<w:pgBorders><w:right w:val="single" w:sz="8"/><w:bottom w:val="wave" w:sz="6"/><w:top w:val="single" w:sz="4"/>' +
      '<w:right w:val="double" w:sz="2"/></w:pgBorders>',
  ),
  // line numbering, every w:restart
  ...['continuous', 'newPage', 'newSection', 'bogus', ''].map((v) =>
    sectPr(`<w:lnNumType w:countBy="1" w:restart="${v}"/>`),
  ),
  sectPr('<w:lnNumType/>'),
  sectPr('<w:lnNumType w:countBy="0" w:start="-2" w:distance="-1"/>'),
  sectPr('<w:lnNumType w:countBy="-3" w:start="3" w:distance="0"></w:lnNumType>'),
  // document grid
  ...['default', 'lines', 'linesAndChars', 'snapToChars', 'bogus', ''].map((v) =>
    sectPr(`<w:docGrid w:type="${v}" w:linePitch="360" w:charSpace="0"/>`),
  ),
  sectPr('<w:docGrid/>'),
  // vertical alignment, text direction, bidi
  ...['center', 'both', 'bottom', 'top', '', 'bogus'].map((v) =>
    sectPr(`<w:vAlign w:val="${v}"/>`),
  ),
  ...['tbRl', 'lrTb', '', 'btLr', 'lrTbV'].map((v) => sectPr(`<w:textDirection w:val="${v}"/>`)),
  ...[
    '<w:bidi/>',
    '<w:bidi w:val="0"/>',
    "<w:bidi w:val='off'/>",
    '<w:BIDI/>',
    '<w:bidi w:val="true"/>',
    // U+0131: an i only under Unicode case folding
    '<w:b\u0131di/>',
    '<w:B\u0131D\u0131 w:val="1"/>',
    '<w:bid\u0131 w:val="0"/><w:bidi/>',
  ].map(sectPr),
  // page numbering
  ...[
    '<w:pgNumType w:start="5"/>',
    '<w:pgNumType w:start="05" w:fmt="upperRoman"/>',
    "<w:pgNumType w:start='-1' w:fmt=''/>",
    '<w:pgNumType w:fmt="decimal" w:start = "7"/>',
    `<w:pgNumType w:start="${'9'.repeat(400)}"/>`,
  ].map(sectPr),
  // note properties, every w:pos / w:numFmt / w:numRestart
  ...['pageBottom', 'beneathText', 'sectEnd', 'docEnd', 'bogus', ''].map((v) =>
    sectPr(
      `<w:footnotePr><w:pos w:val="${v}"/></w:footnotePr><w:endnotePr><w:pos w:val="${v}"/></w:endnotePr>`,
    ),
  ),
  ...[
    'decimal',
    'upperRoman',
    'lowerRoman',
    'upperLetter',
    'lowerLetter',
    'chicago',
    'ganada',
    '',
  ].map((v) =>
    sectPr(
      `<w:footnotePr><w:numFmt w:val="${v}"/></w:footnotePr><w:endnotePr><w:numFmt w:val="${v}"/></w:endnotePr>`,
    ),
  ),
  ...['continuous', 'eachSect', 'eachPage', 'bogus'].map((v) =>
    sectPr(
      `<w:footnotePr><w:numRestart w:val="${v}"/></w:footnotePr><w:endnotePr><w:numRestart w:val="${v}"/></w:endnotePr>`,
    ),
  ),
  ...['3', '03', '-1', '2.5', 'x', ''].map((v) =>
    sectPr(
      `<w:footnotePr><w:numStart w:val="${v}"/></w:footnotePr><w:endnotePr><w:numStart w:val="${v}"/></w:endnotePr>`,
    ),
  ),
  sectPr('<w:footnotePr/><w:endnotePr></w:endnotePr>'),
  sectPr('<w:footnotePr w:x="1"><w:pos w:val="docEnd"/></w:footnotePr>'),
  sectPr('<w:footnotePr><w:numberingChange w:original="1"/></w:footnotePr>'),
  sectPr("<w:footnotePr><w:numFmt w:val='lowerLetter'/><w:posX w:val='docEnd'/></w:footnotePr>"),
  // header and footer references: every type, duplicated, missing r:id, quoting
  sectPr(
    '<w:headerReference w:type="default" r:id="rId1"/><w:headerReference w:type="default" r:id="rId2"/>' +
      '<w:headerReference w:type="even" r:id=""/><w:headerReference w:type="first"/>' +
      `<w:footerReference w:type='first' r:id='rId3'/><w:footerReference r:id="rId4"></w:footerReference>` +
      '<w:footerReference w:type="bogus" r:id="rId5"/><w:footerReference w:type="even" r:id="rId6"><w:x/></w:footerReference>',
  ),
  sectPr('<w:headerReference r:id = "rId7" w:type = "even"/><w:headerReferences r:id="rId8"/>'),
]

const SECT_PR_INPUTS: Input[] = SECT_PRS.map((text) => ({ text }))

/** body children as the parser's blocks: what the section readers look at */
interface BlockInput {
  hidden?: boolean
  originalXml?: string
  docxIndex?: number | null
}

function blocksOf(documentXml: string): BlockInput[] {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? ''
  const blocks: BlockInput[] = []
  const push = (name: string, xml: string): void => {
    blocks.push({
      ...(name === 'w:sectPr' ? { hidden: true } : {}),
      // the readers only look inside a block that holds a sectPr
      originalXml: xml.includes('<w:sectPr') ? xml : `<${name}/>`,
      docxIndex: blocks.length,
    })
  }
  let depth = 0
  let start = 0
  let name = ''
  for (const tag of tagTokens(body)) {
    if (tag.selfClosing) {
      if (depth === 0) push(tag.name, body.slice(tag.start, tag.end))
    } else if (!tag.closing) {
      if (depth === 0) {
        start = tag.start
        name = tag.name
      }
      depth += 1
    } else if (depth > 0) {
      depth -= 1
      if (depth === 0) push(name, body.slice(start, tag.end))
    }
  }
  return blocks
}

const PARA_SECT = `<w:p><w:pPr>${sectPr('<w:type w:val="continuous"/><w:pgMar w:gutter="720" w:left="1000"/>')}</w:pPr></w:p>`
const TRAILING = sectPr(
  '<w:headerReference w:type="first" r:id="rId1"/><w:titlePg/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:gutter="360"/>',
)

const BLOCK_LISTS: BlockInput[][] = [
  [],
  [
    { docxIndex: 0, originalXml: '<w:p/>' },
    { docxIndex: 1, originalXml: '<w:tbl/>' },
  ],
  [{ docxIndex: 0, originalXml: '<w:p/>' }, { originalXml: '<w:p/>' }],
  [
    { docxIndex: 0, originalXml: '<w:p/>' },
    { docxIndex: 1, originalXml: '<w:p/>' },
    { docxIndex: 2, originalXml: PARA_SECT },
    { docxIndex: 3, originalXml: '<w:p/>' },
    { docxIndex: 4, originalXml: TRAILING, hidden: true },
  ],
  [
    { docxIndex: null, originalXml: PARA_SECT },
    { docxIndex: 1, originalXml: '<w:sectPr>', hidden: true },
    { docxIndex: 7 },
  ],
  [
    { docxIndex: 0, originalXml: PARA_SECT, hidden: false },
    { docxIndex: 1, hidden: true },
    { docxIndex: 2, originalXml: '<w:sectPr/>', hidden: true },
    { docxIndex: 3, originalXml: TRAILING, hidden: true },
  ],
  [
    { docxIndex: -1, originalXml: TRAILING },
    { docxIndex: 2.5, originalXml: `<w:p>${TRAILING}</w:p>` },
  ],
]

const BLOCK_INPUTS: Input[] = BLOCK_LISTS.flatMap((blocks) =>
  [undefined, true, false].map((gutterAtTop) => ({
    args: { blocks, ...(gutterAtTop === undefined ? {} : { gutterAtTop }) },
  })),
)

/** The readers over a parsed document touch only these fields. */
function parsedOf(args: Record<string, unknown>, documentXml = ''): ParsedDoc {
  const parsed = {
    blocks: args.blocks ?? [],
    gutterAtTop: args.gutterAtTop,
    internal: { documentXml },
  }
  return parsed as unknown as ParsedDoc
}

const documentOf = (parts: ReadonlyMap<string, string>): string =>
  parts.get('word/document.xml') ?? ''

const sectPrsOf = (parts: ReadonlyMap<string, string>): string[] =>
  elementFragments(documentOf(parts), 'w:sectPr')

const headersOf = (parts: ReadonlyMap<string, string>): string[] =>
  [...parts]
    .filter(([name]) => /^word\/(?:header|footer)\d*\.xml$/.test(name))
    .map(([, text]) => text)

const gutterAtTopOf = (parts: ReadonlyMap<string, string>): boolean =>
  xmlFlagOn(parts.get('word/settings.xml') ?? '', 'w:gutterAtTop')

const REFERENCE_TAGS = [
  '<w:headerReference w:type="default" r:id="rId1"/>',
  '<w:headerReference w:type="first" r:id="rId2"></w:headerReference>',
  "<w:footerReference w:type='even' r:id='rId3'/>",
  '<w:footerReference w:type="" r:id=""/>',
  '<w:headerReference r:id = "rId4"/>',
  '<w:headerReference w:type="bogus"/>',
  '<w:headerReference xw:type="first" xr:id="rId5"/>',
  '<w:headerReference w:type="first" r:id="rId6" w:type="even" r:id="rId7"/>',
]

// ---- watermarks

const TEXT_SPECS: WatermarkSpec[] = [
  { text: 'DRAFT' },
  {
    text: 'CONFIDENTIAL',
    diagonal: false,
    bold: true,
    italic: true,
    colorHex: '#ff0000',
    opacity: 0.25,
  },
  { text: '<A & "B" \'C\'>', fontFamily: 'Malgun "Gothic" & Co', opacity: 2 },
  { text: 'x', colorHex: 'abc', opacity: -1, boxPt: { widthPt: 100.5, heightPt: 30 } },
  { text: '\u{6A23}\u{672C}', fontFamily: '\u{5B8B}\u{4F53}', diagonal: true, opacity: 0 },
  { text: '' },
  // text that holds an entity: written escaped twice, it must decode once
  { text: '&lt;b&gt; &amp;amp; &quot;' },
]

const PICTURE_SPECS: PictureWatermarkSpec[] = [
  { image: { base64: 'iVBORw0KGgo=', mime: 'image/png', widthPx: 800, heightPx: 600 } },
  {
    image: { base64: 'R0lGOD', mime: 'image/gif', widthPx: 300, heightPx: 900 },
    scale: 50,
    washout: false,
  },
  { image: { base64: '/9j/', mime: 'image/jpeg', widthPx: 1, heightPx: 1 }, washout: true },
  { image: { base64: '', mime: 'image/png', widthPx: 0, heightPx: 600 } },
  { image: { base64: '', mime: 'image/png', widthPx: 0, heightPx: 0 } },
  { image: { base64: 'x', mime: 'image/png', widthPx: 640.5, heightPx: 480.25 }, scale: 0 },
  { image: { base64: 'x', mime: 'image/png', widthPx: 640, heightPx: 480 }, scale: 133.3 },
  { image: { base64: 'x', mime: 'image/png', widthPx: 100, heightPx: 100 }, scale: -10 },
]

const MARGIN_BOXES: MarginBox[] = [
  null,
  { widthPt: 468, heightPt: 648 },
  { widthPt: 0, heightPt: 0 },
  { widthPt: 451.3, heightPt: 100 },
]

const SHAPE_STYLES = [
  'position:absolute;margin-left:0;margin-top:0;width:412.4pt;height:247.45pt;rotation:315;z-index:-251656192;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin',
  'width:6in;height:2in',
  'width:10cm;height:30mm;rotation:-45;z-index:5;margin-left:12pt;margin-top:-1in',
  'width:300px;height:100;rotation:41366637fd;mso-position-horizontal:left;mso-position-vertical:bottom',
  'width:300;height:abc',
  'width:0.3px;height:100pt',
  'height:100pt',
  'width:200pt;height:50pt;rotation:0;mso-position-horizontal:right;mso-position-vertical:top;mso-position-horizontal-relative:page;mso-position-vertical-relative:page',
  'width:200pt;height:50pt;rotation:720.5;mso-position-horizontal-relative:left-margin-area;mso-position-vertical-relative:top-margin-area;margin-left:1.5cm;margin-top:4mm',
  'width:200pt; height:50pt ;rotation:abc;mso-position-horizontal:inside;mso-position-vertical-relative:line',
  ' width : 2in;height:1in;rotation:360',
]

const FILLS = [
  '',
  '<v:fill opacity="32768f"/>',
  '<v:fill opacity=".5"/>',
  '<v:fill opacity="1.5"/>',
  '<v:fill opacity="-1"/>',
  '<v:fill opacity="x"/>',
  '<v:fill type="solid"/>',
]

const FILL_ATTRIBUTES = [
  ' fillcolor="silver" stroked="f"',
  ' fillcolor="#abc"',
  ' fillcolor="#dbe5f1 [3204]"',
  ' fillcolor="Red [3204]"',
  ' fillcolor="bogus"',
  ' filled="f" fillcolor="red"',
  ' filled="t"',
  '',
]

const TEXTPATHS = [
  '<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/>',
  '<v:textpath style="font-family:&quot;Malgun Gothic&quot;;font-size:1pt;font-weight:bold;font-style:italic" string="A &amp; B &lt;C&gt;"/>',
  '<v:textpath style="font-family:Arial" string="&quot;x&quot; &apos;y&apos;"/>',
  '<v:textpath string="no style"/>',
  '<v:textpath string="A &amp;lt; B &amp;amp; C &amp;quot;"/>',
  '<v:textpath style="font-family:&quot;&quot;" string="empty family"/>',
  '<v:textpath style="font-weight: bold" string=""/>',
  "<v:textpath string='single'/>",
  '<v:textpath on="t" fitshape="t"/>',
]

const wordArt = (style: string, fill: string, attributes: string, textpath: string): string =>
  `<w:p><w:r><w:pict><v:shapetype id="_x0000_t136" coordsize="21600,21600"><v:textpath on="t" fitshape="t"/></v:shapetype>` +
  `<v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" style="${style}"${attributes}>${fill}${textpath}</v:shape></w:pict></w:r></w:p>`

const TEXT_WATERMARKS: string[] = [
  ...TEXT_SPECS.map((spec) => watermarkParagraphXml(spec)),
  ...SHAPE_STYLES.map((style, i) =>
    wordArt(
      style,
      FILLS[i % FILLS.length]!,
      FILL_ATTRIBUTES[i % FILL_ATTRIBUTES.length]!,
      TEXTPATHS[0]!,
    ),
  ),
  ...FILLS.map((fill) => wordArt(SHAPE_STYLES[1]!, fill, '', TEXTPATHS[1]!)),
  ...FILL_ATTRIBUTES.map((attributes) => wordArt(SHAPE_STYLES[0]!, '', attributes, TEXTPATHS[2]!)),
  ...TEXTPATHS.map((textpath) => wordArt(SHAPE_STYLES[3]!, '', ' fillcolor="#123456"', textpath)),
  '<w:p><w:r><w:pict><v:textpath string="no shape"/></w:pict></w:r></w:p>',
  '<w:p><w:r><w:pict><v:shapetype id="t"><v:textpath string="only in the shapetype"/></v:shapetype><v:shape style="width:1in;height:1in"/></w:pict></w:r></w:p>',
  '<w:p><w:r><w:pict><v:shape style="width:1in;height:1in" fillcolor="blue"><v:textpath string="no closer"/></w:pict></w:r></w:p>',
  // fill colours that are names every object inherits
  ...['constructor', '__proto__', 'toString [3204]'].map((color) =>
    wordArt(SHAPE_STYLES[0]!, '', ` fillcolor="${color}"`, TEXTPATHS[0]!),
  ),
]

const pictureShape = (attributes: string, style: string, imagedata: string): string =>
  `<w:p><w:r><w:pict><v:shape ${attributes} style="${style}">${imagedata}</v:shape></w:pict></w:r></w:p>`

const PICTURE_WATERMARKS: string[] = [
  ...PICTURE_SPECS.flatMap((spec) =>
    MARGIN_BOXES.slice(0, 2).map((box) => pictureWatermarkParagraphXml(spec, 'rId3', box)),
  ),
  pictureWatermarkParagraphXml(PICTURE_SPECS[0]!, 'a&b', null),
  pictureShape(
    'id="WordPictureWatermark7"',
    'width:4in;height:3cm',
    `<v:imagedata r:id='rId9' o:title=""/>`,
  ),
  pictureShape(
    'id="WordPictureWatermark7"',
    'width:40mm;height:300px',
    '<v:imagedata r:id = "rId9" gain="19661f"/>',
  ),
  pictureShape(
    'id="PowerPlusWaterMarkObject2"',
    'width:100;height:.',
    '<v:imagedata r:id="rId1"/>',
  ),
  pictureShape('id="WordPictureWatermark7"', 'width:1in;height:1in', '<v:imagedata o:title=""/>'),
  pictureShape('id="WordPictureWatermark7"', 'width:1in;height:1in', `<v:imagedata r:id="rId1'/>`),
  pictureShape('id="_x0000_s1025"', 'width:1in;height:1in', '<v:imagedata r:id="rId4"/>'),
  pictureShape(
    'id="_x0000_s1026"',
    'width:1in;height:1in',
    '<v:imagedata r:id="rId4"/><v:textpath string="both"/>',
  ),
  pictureShape('id="WordPictureWatermark1"', 'width:-2in;height:5em', '<v:imagedata r:id="rId2"/>'),
  pictureShape(
    'o:spid="x" id="WordPictureWatermark1"',
    'mso-width:1in;width:2pt',
    '<v:imagedata r:id="rId2"/>',
  ),
  `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Watermarks"/></w:docPartObj></w:sdtPr><w:sdtContent>` +
    pictureShape('id="_x0000_s1027"', 'width:1in;height:1in', '<v:imagedata r:id="rId4"/>') +
    '</w:sdtContent></w:sdt>',
  '<w:p><w:r><w:pict><v:shape id="WordPictureWatermark1" style="width:1in"/></w:pict></w:r></w:p>',
  '<w:p><w:r><w:pict><v:shapetype id="WordPictureWatermark1"><v:imagedata r:id="rId1"/></v:shapetype></w:pict></w:r></w:p>',
]

const WATERMARK_HEADERS: string[] = [...TEXT_WATERMARKS, ...PICTURE_WATERMARKS].map(
  (child) => `<w:hdr xmlns:w="${W}">${child}<w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`,
)

const WATERMARK_TEXT_INPUTS: Input[] = [
  ...[...TEXT_WATERMARKS, ...PICTURE_WATERMARKS, ...WATERMARK_HEADERS].map((text) => ({ text })),
  { text: '' },
  { text: '<v:textpath' },
]

const CHILD_NAMES = ['w:p', 'w:sdt', 'w:tbl']

const VML_STYLE_KEYS = [
  'width',
  'height',
  'rotation',
  'mso-position-horizontal',
  'margin-left',
  'font-family',
  'z-index',
  '.',
  'w(',
]

const LENGTHS = [
  '46pt',
  '16in',
  '2cm',
  '12px',
  '3mm',
  '5',
  ' 7pt ',
  '-2.5in',
  '.',
  '1.2.3pt',
  'abc',
  '',
  '10em',
  '1e3pt',
  '0',
  '-0',
]

const RELS = [
  'page',
  'leftMargin',
  'insideMargin',
  'left-margin-area',
  'inner-margin-area',
  'rightMargin',
  'outsideMargin',
  'right-margin-area',
  'outer-margin-area',
  'paragraph',
  'line',
  'text',
  'topMargin',
  'top-margin-area',
  'bottomMargin',
  'bottom-margin-area',
  'margin',
  'column',
  '',
  'Page',
]

const FRACTIONS = ['32768f', '.5', '1', ' 2f ', '-1', 'x', '', '1.2.3', '65536f', '0.5f5']

const COLORS = [
  '#dbe5f1',
  'dbe5f1',
  '#aaa',
  'aaa',
  '#aaaa',
  '#dbe5f1 [3204]',
  'silver',
  'Silver',
  'grey',
  'red [3]',
  '[3]',
  '  blue  ',
  'bogus',
  '',
  '#ab',
  '#ABCDEFAB',
  'white\tsmoke',
  'constructor',
  '__proto__',
  'toString',
  'Constructor [3212]',
  'valueOf\tx',
]
/** style and colour attribute values of the VML shapes in a part, a bounded few */
function vmlAttributesOf(xml: string, attribute: string): string[] {
  const values = new Set<string>()
  for (const tag of tagTokens(xml)) {
    if (tag.closing || !tag.name.startsWith('v:')) continue
    const value = new RegExp(`\\s${attribute}="([^"]*)"`).exec(xml.slice(tag.start, tag.end))?.[1]
    if (value !== undefined) values.add(value)
    if (values.size >= 30) break
  }
  return [...values]
}

const vmlPartsOf = (parts: ReadonlyMap<string, string>): string[] => [
  documentOf(parts),
  ...headersOf(parts),
]

// ---- notes

const NOTES_PART = (kind: NoteKind, entries: string): string =>
  `<w:${kind}s xmlns:w="${W}" xmlns:w14="${W14}">${entries}</w:${kind}s>`

const noteEntries = (kind: NoteKind): string => {
  const e = `w:${kind}`
  const ref = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:${kind}Ref/></w:r>`
  return (
    `<${e} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></${e}>` +
    `<${e} w:type='continuationSeparator' w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></${e}>` +
    `<${e} w:id="3"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${ref}<w:r><w:t xml:space="preserve"> Third &amp; &#x41;&#66;</w:t></w:r></w:p></${e}>` +
    `<${e} w:id="1"><w:p>${ref.replace('Ref/>', 'Ref />')}<w:r><w:t>One</w:t></w:r><w:ins w:id="5" w:author="a"><w:r><w:t>+in</w:t></w:r></w:ins><w:del w:id="6" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>` +
    `<w:p><w:r><w:t>second para</w:t></w:r></w:p><w:p/></${e}>` +
    `<${e} w:id="-2"><w:p><w:r><w:${kind}Ref></w:${kind}Ref></w:r><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:p></${e}>` +
    `<${e} w:id='7'><w:p><w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION </w:instrText></w:r><w:r><w:t>(Kim 2020)</w:t></w:r></w:p></${e}>` +
    `<${e} w:id="8"><w:p><w:r><w:instrText>ADDIN  CSL_x</w:instrText></w:r></w:p></${e}>` +
    `<${e} w:id="9"/>` +
    `<${e}><w:p><w:r><w:t>no id</w:t></w:r></w:p></${e}>` +
    `<${e} w:id=""><w:p><w:r><w:t>empty id</w:t></w:r></w:p></${e}>` +
    `<${e} w:id="2" w:type="normal"><w:p/></${e}>` +
    `<${e} w:id="12abc"><w:p><w:pPr><w:pStyle w:val='Single'/></w:pPr><w:r><w:t>  lead</w:t></w:r></w:p></${e}>` +
    `<${e} w:id="10"></${e}>`
  )
}

const NOTE_IDS = [
  '999999999999999999999',
  ' 7',
  '0x10',
  'abc',
  '-5',
  `${'9'.repeat(400)}`,
  '-0',
  '4.9',
  '1e5',
]

const NOTES_TEXTS: Array<[NoteKind, string]> = [
  ['footnote', NOTES_PART('footnote', noteEntries('footnote'))],
  ['endnote', NOTES_PART('endnote', noteEntries('endnote'))],
  ['endnote', NOTES_PART('footnote', noteEntries('footnote'))],
  ['footnote', NOTES_PART('footnote', '')],
  ['footnote', ''],
  ...NOTE_IDS.map((id): [NoteKind, string] => [
    'footnote',
    NOTES_PART(
      'footnote',
      `<w:footnote w:id="2"><w:p/></w:footnote><w:footnote w:id="${id}"><w:p/></w:footnote>`,
    ),
  ]),
  ['footnote', NOTES_PART('footnote', '<w:footnote w:id="-3"><w:p/></w:footnote>')],
]

const NOTE_INPUTS: Input[] = [
  ...NOTES_TEXTS.map(([kind, text]) => ({ text, args: { kind } })),
  // hidden from AI: every spelling of the mark, every tag mutation, entries no run accounts for
  ...NOTE_PARTS.flatMap((text) =>
    (['footnote', 'endnote'] as const).map((kind) => ({
      text: kind === 'endnote' ? text.replaceAll('w:footnote', 'w:endnote') : text,
      args: { kind },
    })),
  ),
]

const DELETED = { author: 'Ann', date: '2026-01-01T00:00:00Z' }
/** Display runs of notes, some hidden from AI under a label. */
const RICH_PARAS: Array<Array<Array<Record<string, unknown>>>> = [
  [],
  [[]],
  [[{ text: 'plain' }]],
  [
    [
      { text: 'a' },
      { text: '1', redact: 'phone' },
      { text: '2', redact: 'phone' },
      { text: 'b' },
      { text: 'x', redact: 'name' },
      { text: 'y', redact: 'phone' },
    ],
  ],
  [
    [{ text: 'a', redact: 'p' }],
    [{ text: 'b' }],
    [
      { text: 'c', redact: 'q' },
      { text: 'd', redact: 'q' },
    ],
  ],
  [[{ text: 'gone', redact: 'p', del: DELETED }, { text: 'kept' }]],
  [
    [
      { text: 'a', redact: 'p', del: DELETED },
      { text: 'b', redact: 'p' },
      { text: 'c', del: DELETED },
    ],
  ],
  [
    [
      { text: 'a', redact: '' },
      { text: 'b', redact: '{braces} <x> "q"' },
      { text: 'c', redact: 'a'.repeat(50) },
    ],
  ],
  [[{ text: 'a', redact: 'p', ins: { author: 'Bob' } }], [{ text: '', redact: 'p' }]],
  [
    [
      { text: 'a', redact: 'p' },
      { text: 'b', del: DELETED, redact: 'q' },
      { text: 'c', redact: 'p' },
    ],
  ],
  [
    [
      { text: '\u{1F600}', redact: '\u{1F600}'.repeat(25) },
      { text: 'e', redact: 'e\u0301' },
    ],
  ],
]

const notePartsOf = (parts: ReadonlyMap<string, string>): Input[] =>
  (['footnote', 'endnote'] as const).flatMap((kind) => {
    const text = parts.get(`word/${kind}s.xml`)
    return text === undefined ? [] : [{ text, args: { kind } }]
  })

const REQUIRED: Array<Array<[string, string]>> = [
  [],
  [['w14', W14]],
  [
    ['w', 'urn:x'],
    ['wp14', 'urn:y'],
  ],
]

const ROOTS = [
  NOTES_PART('footnote', ''),
  `<w:footnotes xmlns:w="${W}"/>`,
  '<w:footnotes a="1"/>',
  '<w:footnotes/>',
  `<w:endnotes\n  xmlns:w="${W}"  >`,
  `<w:comments xmlns:w14="${W14}"></w:comments>`,
  '',
]

const ROOT_INPUTS: Input[] = ROOTS.flatMap((text) =>
  ['w:footnotes', 'w:endnotes', 'w:comments', 'w:(', 'w:.'].flatMap((rootTag) =>
    REQUIRED.map((required) => ({ text, args: { rootTag, fallback: NOTE_NS, required } })),
  ),
)

export const SECTION: CallSpec[] = [
  {
    fn: 'section.sectionSettingsFromXml',
    call: (text, args) =>
      sectionSettingsFromXml(text, { gutterAtTop: args.gutterAtTop as boolean | undefined }),
    fromDocument: (parts) =>
      sectPrsOf(parts).map((text) => ({ text, args: { gutterAtTop: gutterAtTopOf(parts) } })),
    built: SECT_PRS.flatMap((text) => [{ text }, { text, args: { gutterAtTop: true } }]),
  },
  {
    fn: 'section.notePropsFromXml',
    call: (text, args) => notePropsFromXml(text, args.tag as NotePrTag),
    fromDocument: (parts) =>
      [...sectPrsOf(parts), parts.get('word/settings.xml') ?? ''].flatMap((text) =>
        (['w:footnotePr', 'w:endnotePr'] as const).map((tag) => ({ text, args: { tag } })),
      ),
    built: SECT_PRS.flatMap((text) =>
      (['w:footnotePr', 'w:endnotePr'] as const).map((tag) => ({ text, args: { tag } })),
    ),
  },
  {
    fn: 'section.lineNumberingOf',
    call: (text) => lineNumberingOf(text),
    fromDocument: (parts) => sectPrsOf(parts).map((text) => ({ text })),
    built: SECT_PR_INPUTS,
  },
  {
    fn: 'section.readSectionSettings',
    call: (_text, args) => readSectionSettings(parsedOf(args)),
    fromDocument: (parts) => [
      { args: { blocks: blocksOf(documentOf(parts)), gutterAtTop: gutterAtTopOf(parts) } },
    ],
    built: BLOCK_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'section.xmlFlagOn',
    call: (text, args) => xmlFlagOn(text, args.tag as string),
    fromDocument: (parts) => [
      ...sectPrsOf(parts).map((text) => ({ text, args: { tag: 'w:titlePg' } })),
      { text: parts.get('word/settings.xml') ?? '', args: { tag: 'w:evenAndOddHeaders' } },
      { text: parts.get('word/settings.xml') ?? '', args: { tag: 'w:gutterAtTop' } },
    ],
    built: SECT_PRS.flatMap((text) =>
      ['w:titlePg', 'w:bidi', 'w:(', 'w:.', 'w:titlePg|w:bidi'].map((tag) => ({
        text,
        args: { tag },
      })),
    ),
  },
  {
    fn: 'section.hfReferenceTags',
    call: (text, args) => hfReferenceTags(text, args.kind as HfKind),
    fromDocument: (parts) =>
      sectPrsOf(parts).flatMap((text) =>
        (['header', 'footer'] as const).map((kind) => ({ text, args: { kind } })),
      ),
    built: SECT_PRS.flatMap((text) =>
      (['header', 'footer'] as const).map((kind) => ({ text, args: { kind } })),
    ),
  },
  {
    fn: 'section.hfReferenceType',
    call: (text) => hfReferenceType(text),
    fromDocument: (parts) =>
      sectPrsOf(parts).flatMap((xml) =>
        [...hfReferenceTags(xml, 'header'), ...hfReferenceTags(xml, 'footer')].map((text) => ({
          text,
        })),
      ),
    built: REFERENCE_TAGS.map((text) => ({ text })),
  },
  {
    fn: 'section.hfReferenceRId',
    call: (text) => hfReferenceRId(text),
    fromDocument: (parts) =>
      sectPrsOf(parts).flatMap((xml) =>
        [...hfReferenceTags(xml, 'header'), ...hfReferenceTags(xml, 'footer')].map((text) => ({
          text,
        })),
      ),
    built: REFERENCE_TAGS.map((text) => ({ text })),
  },
  {
    fn: 'section.sectionFromSectPr',
    call: (text, args) =>
      sectionFromSectPr(
        text,
        args.first as number,
        args.last as number,
        args.gutterAtTop as boolean | undefined,
      ),
    fromDocument: (parts) =>
      sectPrsOf(parts).map((text, i) => ({
        text,
        args: { first: i, last: i + 3, gutterAtTop: gutterAtTopOf(parts) },
      })),
    built: SECT_PRS.flatMap((text, i) => [
      { text, args: { first: 0, last: i } },
      { text, args: { first: 2.5, last: -1, gutterAtTop: true } },
    ]),
  },
  {
    fn: 'section.readSections',
    call: (_text, args) => readSections(parsedOf(args)),
    fromDocument: (parts) => [
      { args: { blocks: blocksOf(documentOf(parts)), gutterAtTop: gutterAtTopOf(parts) } },
    ],
    built: BLOCK_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'section.readPageColor',
    call: (text, args) => readPageColor(parsedOf(args, text)),
    fromDocument: (parts) => [{ text: documentOf(parts) }],
    built: [
      '<w:document><w:background w:color="ff00aa"/><w:body/></w:document>',
      '<w:document><w:background w:color="auto"/></w:document>',
      '<w:document><w:background w:themeColor="accent1"/></w:document>',
      `<w:document><w:background w:color='FF00AA'/></w:document>`,
      '<w:document><w:background w:themeColor="text2" w:themeShade="BF" w:color="1F3864"/></w:document>',
      '<w:document><w:background w:color="12345"/></w:document>',
      '<w:document><w:background w:color="1234567"/></w:document>',
      '<w:document><w:backgroundX w:color="aBcDeF"/></w:document>',
      '<w:document><w:body/></w:document>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'section.readWatermarkText',
    call: (text) => readWatermarkText(text),
    fromDocument: (parts) =>
      headersOf(parts)
        .flatMap((header) => [header, ...elementFragments(header, 'w:pict')])
        .map((text) => ({ text })),
    built: WATERMARK_TEXT_INPUTS,
  },
  {
    fn: 'section.readWatermarkShape',
    call: (text) => readWatermarkShape(text),
    fromDocument: (parts) =>
      headersOf(parts)
        .flatMap((header) => elementFragments(header, 'w:pict'))
        .map((text) => ({ text })),
    built: WATERMARK_TEXT_INPUTS,
  },
  {
    fn: 'section.isPictureWatermark',
    call: (_text, args) => isPictureWatermark(args.wm as Watermark),
    built: [
      { args: { wm: 'DRAFT' } },
      { args: { wm: '' } },
      ...TEXT_SPECS.slice(0, 2).map((wm) => ({ args: { wm } })),
      ...PICTURE_SPECS.slice(0, 2).map((wm) => ({ args: { wm } })),
      { args: { wm: { ...TEXT_SPECS[0]!, ...PICTURE_SPECS[0]! } } },
    ],
    mutation: 'none',
  },
  {
    fn: 'section.isWatermarkChild',
    call: (text, args) => isWatermarkChild({ name: args.name as string, xml: text }),
    fromDocument: (parts) =>
      headersOf(parts).flatMap((header) =>
        CHILD_NAMES.flatMap((name) =>
          elementFragments(header, name).map((text) => ({ text, args: { name } })),
        ),
      ),
    built: [...TEXT_WATERMARKS, ...PICTURE_WATERMARKS, '<w:p/>', '<v:imagedata r:id="x"/>'].flatMap(
      (text) => CHILD_NAMES.map((name) => ({ text, args: { name } })),
    ),
  },
  {
    fn: 'section.isPictureWatermarkShape',
    call: (text) => isPictureWatermarkShape(text),
    fromDocument: (parts) =>
      headersOf(parts)
        .flatMap((header) => [header, ...elementFragments(header, 'v:shape')])
        .map((text) => ({ text })),
    built: WATERMARK_TEXT_INPUTS,
  },
  {
    fn: 'section.readPictureWatermark',
    call: (text) => readPictureWatermark(text),
    fromDocument: (parts) => headersOf(parts).map((text) => ({ text })),
    built: WATERMARK_TEXT_INPUTS,
  },
  {
    fn: 'section.pictureWatermarkPreviewImage',
    call: (_text, args): HfImage =>
      pictureWatermarkPreviewImage(args.spec as PictureWatermarkSpec, args.marginBox as MarginBox),
    built: PICTURE_SPECS.flatMap((spec) =>
      MARGIN_BOXES.map((marginBox) => ({ args: { spec, marginBox } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'section.textWatermarkBoxPt',
    call: (_text, args) => textWatermarkBoxPt(args.spec as WatermarkSpec),
    built: TEXT_SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
  },
  {
    fn: 'section.textWatermarkPreviewImage',
    call: (_text, args) => textWatermarkPreviewImage(args.spec as WatermarkSpec),
    built: TEXT_SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
  },
  {
    fn: 'section.pictureWatermarkBoxPt',
    call: (_text, args) =>
      pictureWatermarkBoxPt(args.spec as PictureWatermarkSpec, args.marginBox as MarginBox),
    built: PICTURE_SPECS.flatMap((spec) =>
      MARGIN_BOXES.map((marginBox) => ({ args: { spec, marginBox } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'section.vmlLengthPx',
    call: (text) => vmlLengthPx(text),
    fromDocument: (parts) =>
      [
        ...new Set(
          vmlPartsOf(parts)
            .flatMap((xml) => vmlAttributesOf(xml, 'style'))
            .flatMap((style) =>
              style.split(';').map((declaration) => declaration.split(':')[1] ?? ''),
            ),
        ),
      ]
        .slice(0, 40)
        .map((text) => ({ text })),
    built: LENGTHS.map((text) => ({ text })),
  },
  {
    fn: 'section.vmlStyleProp',
    call: (text, args) => vmlStyleProp(text, args.key as string),
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => vmlAttributesOf(xml, 'style'))
        .slice(0, 20)
        .flatMap((text) => VML_STYLE_KEYS.slice(0, 7).map((key) => ({ text, args: { key } }))),
    built: SHAPE_STYLES.flatMap((text) => VML_STYLE_KEYS.map((key) => ({ text, args: { key } }))),
  },
  {
    fn: 'section.vmlStyleDimPx',
    call: (text, args) => vmlStyleDimPx(text, args.key as 'width' | 'height'),
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => vmlAttributesOf(xml, 'style'))
        .flatMap((text) => (['width', 'height'] as const).map((key) => ({ text, args: { key } }))),
    built: [...SHAPE_STYLES, ...LENGTHS.map((v) => `width:${v};height:${v}`)].flatMap((text) =>
      (['width', 'height'] as const).map((key) => ({ text, args: { key } })),
    ),
  },
  {
    fn: 'section.vmlRotationDeg',
    call: (text) => vmlRotationDeg(text),
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => vmlAttributesOf(xml, 'style'))
        .map((text) => ({ text })),
    built: [
      ...SHAPE_STYLES,
      ...[
        '315',
        '-45',
        '41366637fd',
        '0',
        '360',
        '-360.004',
        'abc',
        '720.5',
        '.',
        '90fd',
        '1e3',
        ' 45',
      ].map((v) => `rotation:${v}`),
    ].map((text) => ({ text })),
  },
  {
    fn: 'section.anchorRelH',
    call: (text) => anchorRelH(text),
    built: RELS.map((text) => ({ text })),
  },
  {
    fn: 'section.anchorRelV',
    call: (text) => anchorRelV(text),
    built: RELS.map((text) => ({ text })),
  },
  {
    fn: 'section.vmlFloatAnchor',
    call: (text) => {
      const out: Pick<HfImage, 'posH' | 'posV' | 'posXPx' | 'posYPx' | 'posHRel' | 'posVRel'> = {}
      vmlFloatAnchor(text, out)
      return out
    },
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => vmlAttributesOf(xml, 'style'))
        .map((text) => ({ text })),
    built: [
      ...SHAPE_STYLES,
      ...RELS.map(
        (rel) => `mso-position-horizontal-relative:${rel};mso-position-vertical-relative:${rel}`,
      ),
      'mso-position-horizontal:center;mso-position-vertical:top;margin-left:5in',
      'mso-position-horizontal:absolute;margin-left:abc;margin-top:2.5cm',
    ].map((text) => ({ text })),
  },
  {
    fn: 'section.vmlFraction',
    call: (text) => vmlFraction(text),
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => vmlAttributesOf(xml, 'opacity'))
        .map((text) => ({ text })),
    built: FRACTIONS.map((text) => ({ text })),
  },
  {
    fn: 'section.vmlColorHex',
    call: (text) => vmlColorHex(text),
    fromDocument: (parts) =>
      vmlPartsOf(parts)
        .flatMap((xml) => [
          ...vmlAttributesOf(xml, 'fillcolor'),
          ...vmlAttributesOf(xml, 'strokecolor'),
        ])
        .map((text) => ({ text })),
    built: COLORS.map((text) => ({ text })),
  },
  {
    fn: 'section.parseNotesXml',
    call: (text, args) => parseNotesXml(text, args.kind as NoteKind),
    fromDocument: notePartsOf,
    built: NOTE_INPUTS,
  },
  {
    fn: 'section.noteModelText',
    call: (_text, args) => noteModelText(args.richParas as Parameters<typeof noteModelText>[0]),
    built: RICH_PARAS.map((richParas) => ({ args: { richParas } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'section.nextNoteId',
    call: (text, args) => nextNoteId(parseNotesXml(text, args.kind as NoteKind)),
    fromDocument: notePartsOf,
    built: NOTE_INPUTS,
  },
  {
    fn: 'section.rootAttributes',
    call: (text, args) =>
      rootAttributes(
        text,
        args.rootTag as string,
        args.fallback as string,
        Object.fromEntries((args.required as Array<[string, string]> | undefined) ?? []),
      ),
    fromDocument: (parts) =>
      (
        [
          ['word/footnotes.xml', 'w:footnotes'],
          ['word/endnotes.xml', 'w:endnotes'],
          ['word/comments.xml', 'w:comments'],
        ] as const
      ).flatMap(([name, rootTag]) => {
        const text = parts.get(name)
        return text === undefined
          ? []
          : REQUIRED.slice(0, 2).map((required) => ({
              text,
              args: { rootTag, fallback: NOTE_NS, required },
            }))
      }),
    built: ROOT_INPUTS,
  },
]
