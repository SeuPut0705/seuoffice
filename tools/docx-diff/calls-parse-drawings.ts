// parse.ts: drawings, VML, media and settings (crates/docx-engine/src/parse/drawings.rs).
// A function over a node takes its XML text (serializeXNode at the call); one
// over the package takes `args.parts`; a Map crosses as its entries; one that
// writes into an argument answers that argument after the call.
import { inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import type { JSZipObject } from 'jszip'
import { parseNumbering, resolveRelationshipTargetPath } from './reference/parse-package'
import { parseStyles } from './reference/parse-styles'
import { resolveCtxOf } from './reference/resolve-props'
import { scanBody } from './reference/scan'
import { sectionSettingsFromXml } from './reference/section'
import type {
  DocDefaults,
  NumberingDef,
  SectionSettings,
  StyleInfo,
  ThemeColors,
  ThemeFonts,
} from './reference/types'
import type { RelInfo } from './reference/parse-xml-text'
import {
  attrsOf,
  findChild,
  nameOf,
  serializeXNode,
  xmlParser,
  type XNode,
} from './reference/xml-utils'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { parseInternals } from './parse-internals'
import { lineRuleOutsideItsType } from './listed'

const internals = await parseInternals()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNode = (value: unknown): value is XNode =>
  isObject(value) && nameOf(value as XNode) !== undefined

/** The first element of `text` as xmlParser reads it, `{}` for none: what the Rust side takes. */
const nodeOf = (text: string): XNode =>
  (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) !== undefined) ?? {}

/** A copy of a model argument, so the call cannot write into the input both sides read. */
const copy = <T>(value: T): T => structuredClone(value)

const SETTINGS = 'word/settings.xml'

/** `[name, text]` of the parts in `names` the document has. */
const partsNamed = (
  parts: ReadonlyMap<string, string>,
  ...names: string[]
): Array<[string, string]> =>
  names.flatMap((name) => (parts.has(name) ? [[name, parts.get(name)!] as [string, string]] : []))

const settingsOnly = (parts: ReadonlyMap<string, string>): Input => ({
  args: { parts: partsNamed(parts, SETTINGS) },
})

const relsEntries = (rels: unknown): Array<[string, RelInfo]> | undefined =>
  rels instanceof Map ? ([...rels] as Array<[string, RelInfo]>) : undefined

const sourcePathOf = (ctx: Record<string, unknown>): string | undefined =>
  typeof ctx.sourcePath === 'string' ? ctx.sourcePath : undefined

/** The part a relationship of `rels` names, as `[name, text]` when the corpus holds its text. */
function relPart(
  parts: ReadonlyMap<string, string>,
  rels: Map<string, RelInfo>,
  rId: string | undefined,
  sourcePath = 'word/document.xml',
): Array<[string, string]> {
  const rel = rId ? rels.get(rId) : undefined
  if (!rel || rel.targetMode === 'External') return []
  const path = resolveRelationshipTargetPath(sourcePath, rel.target)
  return path ? partsNamed(parts, path) : []
}

const SECT = {
  pageWidth: 12240,
  pageHeight: 15840,
  orientation: 'portrait',
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1800,
  pageBorder: false,
  columns: 1,
}
const SECTS = [
  SECT,
  { ...SECT, columns: 2, marginLeft: 0 },
  { ...SECT, pageWidth: 16838, marginLeft: 720, marginRight: 1080, marginTop: 0 },
]

const positionH = (from: string, inner: string): string =>
  `<wp:anchor><wp:positionH relativeFrom="${from}">${inner}</wp:positionH></wp:anchor>`
const positionV = (from: string, inner: string): string =>
  `<wp:positionV relativeFrom="${from}">${inner}</wp:positionV>`
const ALIGNS = ['left', 'center', 'right', 'inside', 'outside', 'top', 'bottom', 'none']
const ANCHOR_FRAGS = [
  ...[
    'page',
    'column',
    'margin',
    'character',
    'leftMargin',
    'insideMargin',
    'outsideMargin',
  ].flatMap((from) => [
    ...ALIGNS.map((align) => positionH(from, `<wp:align>${align}</wp:align>`)),
    positionH(from, '<wp:posOffset>-952500</wp:posOffset>'),
  ]),
  positionH('page', '<wp:posOffset>4762</wp:posOffset>') +
    positionV('paragraph', '<wp:posOffset>-14287</wp:posOffset>'),
  positionH('margin', '<wp:align>center</wp:align><wp:posOffset>12</wp:posOffset>') +
    positionV('line', '<wp:align>bottom</wp:align>'),
  ...[
    'page',
    'paragraph',
    'line',
    'topMargin',
    'bottomMargin',
    'insideMargin',
    'outsideMargin',
    'margin',
  ].flatMap((from) => [
    positionV(from, '<wp:align>top</wp:align>'),
    positionV(from, '<wp:align>left</wp:align>'),
    positionV(from, '<wp:posOffset>95250</wp:posOffset>'),
  ]),
  '<wp:positionH relativeFrom="page"><wp:posOffset>1.5</wp:posOffset></wp:positionH>',
  '<wp:positionH><wp:align>left</wp:align></wp:positionH>',
  '<wp:positionH relativeFrom="page"></wp:positionH>',
  '',
]

const HR_RECTS = [
  '<v:rect id="_x0000_i1025" style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t" fillcolor="#a0a0a0" stroked="f">',
  '<v:rect style="width:468pt;height:3pt" o:hralign="right" o:hr="t" fillcolor="a0b0c0">',
  '<v:rect style="width:468pt;height:0.1pt" o:hralign="left" o:hr="t" fillcolor="red">',
  '<v:rect style="width:200.5pt;height:.75pt" o:hr="t" fillcolor="#FfEe11">',
  '<v:rect style="height:2pt" o:hralign="center" o:hr="t">',
  '<v:rect style="width:10pt;height:-2pt" o:hralign="center" o:hr="t" fillcolor="#12345">',
  '<v:rect style="width:9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999pt;height:1pt" o:hralign="right" o:hr="t">',
  '<v:rect o:hr="t">',
]

const PICT = (shape: string): string => `<w:pict>${shape}</w:pict>`
const RECT_SHAPE =
  '<v:rect style="width:100pt;height:50pt" fillcolor="#ff0000" strokecolor="#00ff00" strokeweight="2pt"/>'
const VML_PARAS = [
  `<w:p><w:r>${PICT(RECT_SHAPE)}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:oval style="position:absolute;margin-left:10pt;width:20pt;height:20pt" fillcolor="blue"/>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:shapetype id="_x0000_t202" coordsize="21600,21600" path="m,l,21600r21600,l21600,xe"/>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:shapetype id="t1"><v:path/></v:shapetype><v:shape type="#t1" style="width:10pt;height:10pt" fillcolor="red"/>')}</w:r></w:p>`,
  `<w:p><w:r><w:pict/></w:r><w:r><w:pict /></w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:shape style="width:10pt;height:10pt"><v:imagedata r:id="rId4"/></v:shape>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:group style="width:10pt;height:10pt"><v:rect/></v:group>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT(RECT_SHAPE)}${PICT('<v:textbox><w:txbxContent/></v:textbox>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:rect style="position: absolute;width:5pt;height:5pt" fillcolor="red"/>')}</w:r></w:p>`,
  '<w:p><w:r><w:t>no picture</w:t></w:r></w:p>',
  `<w:p><w:r>${PICT('<v:shape type="#tbl" style="width:30pt;height:30pt"/>')}</w:r></w:p>`,
  `<w:p><w:r>${PICT('<v:rect style="width:30pt;height:30pt" fillcolor="#123456"><v:fill opacity="32768f"/></v:rect>')}</w:r></w:p>`,
]
const FLOATING_VML = [
  '<v:rect style="position:absolute;width:10pt" fillcolor="red"/>',
  '<v:shape id="s" style="position: absolute;margin-left:4pt"/>',
  '<v:roundrect style="z-index:2;position:absolute"/>',
  '<v:oval xstyle="position:absolute"/>',
  '<v:ovalx style="position:absolute"/>',
  '<v:line style="position:absolute"/>',
  '<v:rect style="position:absolute"><v:imagedata r:id="rId1"/></v:rect>',
  '<v:rect style="position:absolute"><w:txbxContent/></v:rect>',
  '<v:rect style="position:relative"/>',
  '<v:rect><v:textbox style="position:absolute"/></v:rect>',
  '',
]
const SHAPE_TYPES: Array<[string, Record<string, string>]> = [
  ['tbl', { path: 'm,l,21600r21600,l21600,xe', coordsize: '21600,21600', fillcolor: '#00ff00' }],
  ['constructor', { path: 'm,l,21600r21600,xe' }],
]

const MSO_STYLES = [
  '',
  'position:absolute;mso-position-horizontal:left',
  'mso-position-horizontal:inside;mso-position-horizontal-relative:page',
  'mso-position-horizontal:right;mso-position-horizontal-relative:margin',
  'mso-position-horizontal:outside;mso-position-horizontal-relative:page',
  'mso-position-horizontal:center;mso-position-horizontal-relative:text',
  'mso-position-horizontal:absolute;mso-position-horizontal-relative:page',
  'mso-position-horizontal-relative:page;mso-position-vertical-relative:page',
  'mso-position-vertical-relative:margin;mso-position-vertical:absolute',
  'mso-position-vertical-relative:page;mso-position-vertical:top',
  'mso-position-vertical-relative:line;mso-position-horizontal-relative:column',
  'mso-position-horizontal:center;mso-position-horizontal-relative:right-margin-area',
]
const BOXES = [
  { paras: [] },
  { paras: [], widthPx: 120, offsetXEmu: 25400 },
  { paras: [], offsetYEmu: 12700, floating: true },
  { paras: [], widthPx: 33.3, offsetXEmu: -5, offsetYEmu: 0, pageRelV: false },
]

const BODY_PRS = [
  '<wps:bodyPr/>',
  '<wps:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"><a:spAutoFit/></wps:bodyPr>',
  '<wps:bodyPr lIns="12.7" tIns="-91440" rIns="x" bIns="" anchor="b" wrap="square"><a:noAutofit/></wps:bodyPr>',
  '<wps:bodyPr anchor="t"><a:spAutoFit></a:spAutoFit></wps:bodyPr>',
  '<wps:bodyPr lIns="914400000000000000000000"/>',
]
const TEXT_BOXES = [
  { id: 1 },
  { id: 2, widthPx: 10, autofit: false, insets: [1, 2, 3, 4] },
  { id: 3, vAlign: 'top', nowrap: false },
]

const RECT_TAGS = [
  '<a:srcRect l="12500" t="-3000" r="0" b="99999.5"/>',
  '<a:srcRect xl="5" l="abc" t=".5" r="-." b="1e5"/>',
  '<a:lum bright="70000" contrast="-70000"/>',
  '<a:biLevel thresh="25000"/>',
  '<a:fillRect/>',
]
const RECT_NAMES = ['l', 't', 'r', 'b', 'bright', 'contrast', 'thresh', 'x(', '', '.']

const pic = (spPr: string): string => `<pic:pic><pic:nvPicPr/><pic:spPr${spPr}</pic:spPr></pic:pic>`
const PIC_XMLS = [
  pic(
    '><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/></a:xfrm><a:ln w="19050"><a:solidFill><a:srgbClr val="ff00aa"/></a:solidFill></a:ln>',
  ),
  pic(
    ' bwMode="auto"><a:xfrm rot="-60000" flipV="true"/><a:ln><a:solidFill> <a:srgbClr val="00FF00"/></a:solidFill></a:ln>',
  ),
  pic('><a:xfrm rot="21570000" flipH="0"/><a:ln w="0"><a:noFill/></a:ln>'),
  pic(
    '><a:xfrm rot="30000"/><a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>',
  ),
  pic(
    '><a:xfrm/><a:ln w="12700"><a:noFill /><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>',
  ),
  pic('><a:xfrm rot="abc" flipV="1" flipH="true"></a:xfrm>'),
  pic('></a:xfrm>'),
  '<wps:spPr><a:xfrm rot="5400000"/><a:ln w="9525"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln></wps:spPr>',
  pic('>'),
  '',
]

const groupDrawing = (
  pics: string,
  ext = '<wp:extent cx="2000000" cy="1000000"/>',
  grp = '',
): string =>
  `<w:drawing><wp:anchor>${ext}<a:graphic><a:graphicData><wpg:wgp><wpg:grpSpPr>${grp}</wpg:grpSpPr>${pics}</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const groupPic = (rId: string, xfrm: string, link = false): string =>
  `<pic:pic><pic:blipFill><a:blip r:${link ? 'link' : 'embed'}="${rId}"/></pic:blipFill><pic:spPr>${xfrm}</pic:spPr></pic:pic>`
const PIC_XFRM = (x: number, y: number, cx: number, cy: number, extra = ''): string =>
  `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
const GRP_XFRM =
  '<a:xfrm><a:off x="100" y="200"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm>'
const MEDIA: Array<[string, string]> = [
  ['rId1', 'data:image/png;base64,AAAA'],
  ['rId2', 'data:image/png;base64,BBBB'],
  ['rId3', ''],
]
const GROUP_DRAWINGS = [
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 1000000, 500000)) +
      groupPic('rId2', PIC_XFRM(500000, 250000, 1000000, 500000)),
    undefined,
    GRP_XFRM,
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 1000000, 500000)) +
      groupPic('rId2', PIC_XFRM(-7, 0, 3, 3), true),
  ),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId9', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId3', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' rot="60000"')) +
      groupPic('rId2', PIC_XFRM(0, 0, 10, 10)),
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' flipH="0"')) +
      groupPic('rId2', PIC_XFRM(0, 0, 10, 10)),
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' rot="x"')) + groupPic('rId2', PIC_XFRM(0, 0, 0, 10)),
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) +
      groupPic('rId2', PIC_XFRM(0, 0, 10, 10)) +
      '<wps:wsp/>',
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) +
      '<wpg:grpSp>' +
      groupPic('rId2', PIC_XFRM(0, 0, 10, 10)) +
      '</wpg:grpSp>',
  ),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)),
    '<wp:extent cx="0" cy="5"/>',
  ),
  groupDrawing(
    groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)),
    '',
  ),
  groupDrawing(groupPic('rId1', '') + groupPic('rId2', PIC_XFRM(0, 0, 10, 10))),
  '<w:drawing><wp:inline/></w:drawing>',
  '<wpg:wgp><pic:pic/><pic:pic/></wpg:wgp>',
]

const VML_IMAGES = [
  '<w:pict><v:shape id="a" style="width:100pt;height:50.5pt" o:spt="75"><v:imagedata r:id="rId5"/></v:shape></w:pict>',
  '<w:pPr><w:jc w:val="center"/></w:pPr><w:pict><v:shape id="b" style="position:absolute;margin-left:-12.5pt;margin-top:30pt;width:20pt;height:0pt;z-index:-251658240;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:page"/></w:pict>',
  '<w:jc w:val="end"/><v:shape style="position:absolute;z-index:5;margin-left:x;mso-position-horizontal:left;mso-position-horizontal-relative:page;mso-position-vertical:top;mso-position-vertical-relative:text"/>',
  '<w:jc w:val="right"/><v:shape style="position:absolute;mso-position-horizontal:inside;mso-position-horizontal-relative:page;mso-position-vertical:bottom;mso-position-vertical-relative:margin"/>',
  '<v:shape style="xwidth:5pt;width:6pt;height:7pt"/>',
  '<v:shapetype style="width:5pt"/><v:shape  style="width:1in"/>',
  '<w:jc w:val="both"/>',
  '',
]

const RELS: Array<[string, RelInfo]> = [
  ['rId1', { target: 'media/image1.png', type: 'http://x/image' }],
  ['rId2', { target: 'http://example.com/a.png', type: 'http://x/image', targetMode: 'External' }],
  ['rId3', { target: '../customXml/item1.xml', type: 'http://x/customXml' }],
  ['rId4', { target: '/word/charts/chart1.xml', type: 'http://x/chart' }],
  ['rId5', { target: '../../escape.xml', type: 'http://x/x' }],
  ['rId6', { target: 'txbx%201.xml', type: 'http://x/txbx' }],
  ['rId7', { target: 'charts/chart2.xml', type: 'http://x/chartEx' }],
  ['rId8', { target: 'charts/missing.xml', type: 'http://x/chart' }],
  ['rId9', { target: '%E0%A4%A.xml', type: 'http://x/x' }],
  ['', { target: 'empty.xml', type: 'http://x/x' }],
]

const SETTINGS_XMLS = [
  '<w:settings><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:defaultTabStop w:val="720"/><w:autoHyphenation/><w:evenAndOddHeaders/><w:characterSpacingControl w:val="compressPunctuation"/><w:themeFontLang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:settings>',
  '<w:settings><w:compatSetting w:val="14" w:name="compatibilityMode"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:val="1"/><w:defaultTabStop w:val="-1.5"/><w:autoHyphenation w:val="false"/><w:gutterAtTop w:val="1"/><w:mirrorMargins w:val="0"/><w:characterSpacingControl w:val="compressPunctuationAndJapaneseKana"/><w:themeFontLang w:eastAsia=""/></w:settings>',
  '<w:settings><w:compatSetting w:name="compatibilityMode" w:val="x"/><w:compatSetting w:name="compatibilityMode" w:val="12"/><w:balanceSingleByteDoubleByteWidth/><w:useFELayout w:val="on"/><w:adjustLineHeightInTable/><w:doNotUseIndentAsNumberingTabStop/><w:doNotExpandShiftReturn w:val="off"/><w:doNotUseHTMLParagraphAutoSpacing/><w:trackRevisions/><w:characterSpacingControl w:val="doNotCompress"/><w:themeFontLang/></w:settings>',
  '<w:settings><w:compatSetting w:name="compatibilityModeX" w:val="11"/><w:defaultTabStop w:val="0"/><w:autoHyphenationX/><w:themeFontLang w:bidi="he-IL"></w:themeFontLang><w:footnotePr><w:numFmt w:val="lowerRoman"/></w:footnotePr><w:endnotePr><w:pos w:val="sectEnd"/><w:numStart w:val="3"/></w:endnotePr></w:settings>',
  '<w:settings><w:footnotePr><w:pos w:val="beneathText"/><w:numRestart w:val="eachSect"/></w:footnotePr></w:settings>',
  '',
]
const SETTINGS_TAGS = [
  'w:gutterAtTop',
  'w:evenAndOddHeaders',
  'w:mirrorMargins',
  'w:trackRevisions',
  'w:autoHyphenation',
  'w:(',
  '',
]
const settingsParts = (xml: string): Array<[string, string]> =>
  xml === '' ? [] : [[SETTINGS, xml]]

const sectPr = (inner: string): string => `<w:sectPr>${inner}</w:sectPr>`
const NOTE_DOCUMENTS = [
  `<w:body><w:p/>${sectPr('<w:footnotePr><w:pos w:val="beneathText"/></w:footnotePr>')}</w:body>`,
  `<w:body><w:p><w:pPr>${sectPr('<w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr>')}</w:pPr></w:p>${sectPr('<w:endnotePr><w:numFmt w:val="upperLetter"/><w:numRestart w:val="continuous"/></w:endnotePr>')}</w:body>`,
  `<w:body>${sectPr('<w:footnotePr><w:numStart w:val="5"/></w:footnotePr><w:sectPrChange><w:sectPr><w:footnotePr><w:pos w:val="docEnd"/></w:footnotePr></w:sectPr></w:sectPrChange>')}</w:body>`,
  `<w:body>${sectPr('<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:pos w:val="pageBottom"/></w:footnotePr>')}</w:body>`,
  '<w:body><w:p/></w:body>',
  '',
]

const SOURCES_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
const SOURCES_XML = `<b:Sources xmlns:b="${SOURCES_NS}"><b:Source><b:Tag>Smi20</b:Tag><b:SourceType>Book</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Smith</b:Last><b:First>A</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>T &amp; U</b:Title><b:Year>2020</b:Year></b:Source></b:Sources>`
const SOURCES_PACKAGES: Array<Array<[string, string]>> = [
  [
    ['customXml/item1.xml', '<other/>'],
    ['customXml/item2.xml', SOURCES_XML],
  ],
  [['customXml/item1.xml', `<b:Sources xmlns:b="${SOURCES_NS}"/>`]],
  [['customXml/itemProps1.xml', SOURCES_XML]],
  [],
]

const PLACEHOLDER_HASH = '0123456789abcdef'.repeat(4)
const placeholder = (hash: string, tail = '\n'): string => `SEUOFFICE-LAZY-MEDIA\n${hash}${tail}`
const MEDIA_PARTS: Array<[string, string, string]> = [
  ['word/media/image1.png', placeholder(PLACEHOLDER_HASH), 'image/png'],
  ['word/media/ä b#1.png', placeholder('f'.repeat(64)), 'image/png'],
  ['word/media/image2.png', placeholder(PLACEHOLDER_HASH.toUpperCase()), 'image/png'],
  ['word/media/image3.png', placeholder(PLACEHOLDER_HASH, '\r'), 'image/png'],
  ['word/media/image4.png', placeholder(PLACEHOLDER_HASH.slice(1), 'x\n'), 'image/png'],
  ['word/media/image5.png', placeholder(PLACEHOLDER_HASH) + '\n', 'image/png'],
  [
    'word/media/image6.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    'image/svg+xml',
  ],
  ['word/media/empty.png', '', 'image/png'],
  ['word/media/text.svg', 'ü€😀', ''],
]

const CHART_XML =
  '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>S</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
const CHARTEX_XML =
  '<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="funnel"><cx:tx><cx:txData><cx:v>F</cx:v></cx:txData></cx:tx></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>'
const CHART_PARTS: Array<[string, string]> = [
  ['word/charts/chart1.xml', CHART_XML],
  ['word/charts/chart2.xml', CHARTEX_XML],
]
const chartDrawing = (rId: string, extent: string, tag = 'c:chart'): string =>
  `<w:drawing><wp:inline>${extent}<a:graphic><a:graphicData><${tag} xmlns:c="c" r:id="${rId}"/></a:graphicData></a:graphic></wp:inline></w:drawing>`
const CHART_DRAWINGS = [
  chartDrawing('rId4', '<wp:extent cx="5486400" cy="3200400"/>'),
  chartDrawing('rId7', "<wp:extent cx = '952500' cy='0'/>", 'cx:chart'),
  chartDrawing('rId4', '<wp:extent cx="-5" cy="x"/>'),
  chartDrawing('rId8', '<wp:extent cx="1" cy="1"/>'),
  chartDrawing('rId2', '<wp:extent cx="1" cy="1"/>'),
  chartDrawing('rId99', ''),
  '<c:chart r:id="rId4"/>',
  '',
]

const TXBX_DOCUMENTS = [
  '<w:body><wps:txbx r:txbx="rId6"/><wps:txbx  id="1" r:txbx="rId6"/><wps:txbx r:txbx="rId2"/><wps:txbx r:txbx="rId1"/><wps:txbx r:txbx="rId99"/><wps:txbx r:txbx="rId5"/></w:body>',
  '<w:body><wps:txbxContent/><wps:txbx r:id="rId6"/></w:body>',
  '',
]
const TXBX_PARTS: Array<[string, string]> = [
  ['word/txbx 1.xml', '<w:txbxContent><w:p/></w:txbxContent>'],
  ['word/media/image1.png', 'not a picture'],
]

/** a solid-fill custGeom shape of a wpg group: x, y, cx, cy in EMU */
const wsp = (
  x: number,
  y: number,
  cx: number,
  cy: number,
  geom: string,
  spPr = '<a:solidFill><a:srgbClr val="1f497d"/></a:solidFill>',
  tail = '',
): string =>
  `<wps:wsp><wps:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${geom}${spPr}</wps:spPr>${tail}</wps:wsp>`
const geom = (paths: string, guides = ''): string =>
  `<a:custGeom><a:avLst/><a:gdLst>${guides}</a:gdLst><a:pathLst>${paths}</a:pathLst></a:custGeom>`
const SQUARE = geom(
  '<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:close/></a:path>',
)
const CURVES = geom(
  '<a:path w="w" h="h"><a:moveTo><a:pt x="l" y="vc"/></a:moveTo><a:arcTo wR="wd2" hR="hd4" stAng="cd2" swAng="-21600000"/><a:quadBezTo><a:pt x="g1" y="t"/><a:pt x="r" y="g2"/></a:quadBezTo><a:cubicBezTo><a:pt x="g3" y="b"/><a:pt x="0" y="constructor"/><a:pt x="unknown" y="g4"/></a:cubicBezTo><a:close/><a:arcTo wR="ss" hR="ss" stAng="0" swAng="5400000"/></a:path><a:path fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="g5" y="g6"/></a:lnTo></a:path><a:path stroke="false"><a:moveTo><a:pt x="5"/></a:moveTo><a:lnTo><a:pt y="7"/></a:lnTo></a:path><a:path fill="none" stroke="0"><a:moveTo><a:pt x="1" y="1"/></a:moveTo></a:path><a:path w="0"/>',
  '<a:gd name="g1" fmla="*/ w 1 3"/><a:gd name="g2" fmla="+- h 0 hd3"/><a:gd name="g3" fmla="?: g1 wd4 wd5"/><a:gd name="g4" fmla="pin 0 h ss"/><a:gd name="g5" fmla="at2 w h"/><a:gd name="g6" fmla="mod w h 0"/><a:gd name="g7" fmla=" sqrt  -4 "/><a:gd name="g8" fmla="cat2 w h w"/><a:gd name="g9" fmla="sat2 w h w"/><a:gd name="g10" fmla="cos w 2700000"/><a:gd name="g11" fmla="sin w g5"/><a:gd name="g12" fmla="tan w 60000"/><a:gd name="g13" fmla="abs -3"/><a:gd name="g14" fmla="min g1 g2"/><a:gd name="g15" fmla="max g1 g2"/><a:gd name="g16" fmla="+/ w h 0"/><a:gd name="g17" fmla="*/ w h 0"/><a:gd name="g18" fmla="val toString"/><a:gd name="g19" fmla="nope 1"/><a:gd name="__proto__" fmla="val 5"/><a:gd name="g20" fmla=""/>',
)
const ARCS = geom(
  '<a:path w="1000" h="500"><a:moveTo><a:pt x="0" y="250"/></a:moveTo><a:arcTo wR="500" hR="250" stAng="10800000" swAng="16200000"/><a:arcTo wR="300" hR="100" stAng="2700000" swAng="-43200000"/><a:arcTo wR="0" hR="100" stAng="0" swAng="5400000"/><a:arcTo wR="g1" hR="100" stAng="0" swAng="0"/></a:path>',
  '<a:gd name="g1" fmla="val __proto__"/>',
)
const NO_SIZE = geom(
  '<a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="20" y="40"/></a:lnTo></a:path><a:path><a:moveTo><a:pt x="10" y="5"/></a:moveTo><a:lnTo><a:pt x="-3" y="60"/></a:lnTo></a:path>',
)
const LINE_LN = '<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>'
const shapeDrawing = (
  shapes: string,
  extent = '<wp:extent cx="952500" cy="476250"/>',
  grp = '',
): string =>
  `<w:drawing><wp:anchor>${extent}<a:graphic><a:graphicData><wpg:wgp><wpg:grpSpPr>${grp}</wpg:grpSpPr>${shapes}</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const SVG_FRAGS = [
  shapeDrawing(wsp(0, 0, 952500, 476250, SQUARE)),
  shapeDrawing(
    wsp(0, 0, 952500, 476250, CURVES) + wsp(9525, 19050, 95250, 95250, ARCS),
    undefined,
    GRP_XFRM,
  ),
  shapeDrawing(wsp(0, 0, 0, 476250, NO_SIZE, LINE_LN)),
  shapeDrawing(
    wsp(
      10,
      10,
      952500,
      0,
      SQUARE,
      '<a:ln w="25400"><a:noFill/></a:ln>',
      '<wps:style><a:lnRef idx="2"><a:srgbClr val="00FF00"/></a:lnRef></wps:style>',
    ),
  ),
  shapeDrawing(
    wsp(
      10,
      10,
      952500,
      0,
      SQUARE,
      '<a:ln w="25400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln>',
      '<wps:style><a:lnRef idx="2"><a:srgbClr val="00FF00"/></a:lnRef></wps:style>',
    ),
  ),
  shapeDrawing(wsp(0, 0, 100, 100, SQUARE, '<a:noFill/>')),
  shapeDrawing(wsp(0, 0, 100, 100, '')),
  shapeDrawing(wsp(0, 0, -1, 100, SQUARE)),
  shapeDrawing(wsp(0, 0, 0, 0, SQUARE, LINE_LN)),
  shapeDrawing(wsp(0, 0, 100, 0, SQUARE)),
  shapeDrawing(wsp(0, 0, 100, 100, SQUARE)).replace('<a:xfrm>', '<a:xfrm rot="5400000">'),
  shapeDrawing(wsp(0, 0, 100, 100, SQUARE)).replace('<a:xfrm>', '<a:xfrm rot="0" flipH="0">'),
  shapeDrawing(wsp(0, 0, 100, 100, SQUARE) + '<w:txbxContent/>'),
  shapeDrawing(wsp(0, 0, 100, 100, SQUARE), '<wp:extent cx="0" cy="5"/>'),
  `<mc:AlternateContent><mc:Choice>${shapeDrawing(wsp(0, 0, 100, 100, SQUARE))}</mc:Choice><mc:Fallback><w:pict><v:shape style="rotation:90"/></w:pict><wps:wsp/></mc:Fallback></mc:AlternateContent>`,
  shapeDrawing(wsp(0, 0, 100, 100, geom('<a:path w="100" h="100"><a:close/></a:path>'))),
  shapeDrawing(
    wsp(
      0,
      0,
      100,
      100,
      '<a:custGeom><a:pathLst><a:path w="1" h="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path></a:pathLst>',
    ),
  ),
  shapeDrawing(
    wsp(
      0,
      0,
      100,
      100,
      geom(
        '<a:path w="1" h="1" fill="none" stroke="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path>',
      ),
    ),
  ),
  shapeDrawing(
    wsp(
      0,
      0,
      100,
      100,
      geom(
        '<a:path w="2" h="2"><!-- a > b --><a:moveTo><a:pt x="1" y="1" name="a>b"/></a:moveTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo><a:gd name="x" fmla="val 1"/></a:path>',
      ),
    ),
  ),
  // a point at -0.125 px: a tie Math.round takes up, toward zero
  shapeDrawing(
    wsp(
      0,
      0,
      9525,
      9525,
      geom(
        '<a:path w="1000" h="1000"><a:moveTo><a:pt x="-125" y="-375"/></a:moveTo><a:lnTo><a:pt x="1000" y="1000"/></a:lnTo></a:path>',
      ),
    ),
  ),
  // Object.prototype members as guide names: NaN in the TypeScript, and a guide named __proto__ is not kept
  shapeDrawing(
    wsp(
      0,
      0,
      100,
      100,
      geom(
        '<a:path w="10" h="10"><a:moveTo><a:pt x="g1" y="__proto__"/></a:moveTo><a:lnTo><a:pt x="valueOf" y="hasOwnProperty"/></a:lnTo><a:arcTo wR="__proto__" hR="5" stAng="0" swAng="5400000"/><a:lnTo><a:pt x="toString" y="5"/></a:lnTo></a:path>',
        '<a:gd name="g1" fmla="val toString"/><a:gd name="__proto__" fmla="val 5"/>',
      ),
    ),
  ),
  '<w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing>',
]

const TEXTBOX_PARAS = [
  { runs: [] },
  { runs: [], cells: [] },
  { runs: [{ text: 'a' }] },
  { runs: [{ text: '' }], styleId: 'x' },
]

const DOCUMENT_VML_FLAGS = /\b(?:stroked|filled|on)="([^"]*)"/g

const WAVE0: CallSpec[] = [
  {
    fn: 'parse.alignedPictureXEmu',
    call: (text, args) => internals.alignedPictureXEmu!(args.meta, text, args.sect),
    fromParse: {
      fn: 'alignedPictureXEmu',
      input: ([meta, xml, sect]) => {
        if (!isObject(meta) || typeof xml !== 'string' || !isObject(sect)) return undefined
        // imageNoOverlap is no key of Block, and the function does not read it
        const { imageNoOverlap: _unread, ...block } = meta
        return { text: xml, args: { meta: block, sect } }
      },
    },
    built: ANCHOR_FRAGS.flatMap((text) =>
      [
        { imageWidthPx: 96 },
        { imageWidthPx: 0 },
        {},
        { imageWidthPx: 1000.5, imageWrap: 'square-left' },
      ].flatMap((meta) => SECTS.map((sect) => ({ text, args: { meta, sect } }))),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.vmlHrRule',
    call: (text) => internals.vmlHrRule!(text),
    fromParse: {
      fn: 'vmlHrRule',
      input: ([tag]) => (typeof tag === 'string' ? { text: tag } : undefined),
    },
    built: HR_RECTS.map((text) => ({ text })),
  },
  {
    fn: 'parse.txbxParaVisible',
    call: (_text, args) => internals.txbxParaVisible!(args.p),
    fromParse: {
      fn: 'txbxParaVisible',
      input: ([p]) => (isObject(p) ? { args: { p: copy(p) } } : undefined),
    },
    built: TEXTBOX_PARAS.map((p) => ({ args: { p } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hasFloatingVmlGeometry',
    call: (text) => internals.hasFloatingVmlGeometry!(text),
    fromParse: {
      fn: 'hasFloatingVmlGeometry',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: [...FLOATING_VML, ...VML_PARAS].map((text) => ({ text })),
  },
  {
    fn: 'parse.vmlPictsInlineOnly',
    call: (text, args) =>
      internals.vmlPictsInlineOnly!(
        text,
        Array.isArray(args.shapeTypes)
          ? new Map(args.shapeTypes as Array<[string, unknown]>)
          : undefined,
      ),
    fromParse: {
      fn: 'vmlPictsInlineOnly',
      input: ([xml, shapeTypes]) =>
        typeof xml === 'string'
          ? {
              text: xml,
              args: shapeTypes instanceof Map ? { shapeTypes: copy([...shapeTypes]) } : {},
            }
          : undefined,
    },
    built: VML_PARAS.flatMap((text) => [{ text }, { text, args: { shapeTypes: SHAPE_TYPES } }]),
  },
  {
    fn: 'parse.vmlFlagOff',
    call: (_text, args) => internals.vmlFlagOff!(args.value),
    // a const arrow function reports no call: the value it reads in vmlStrokeChildOff
    fromParse: {
      fn: 'vmlStrokeChildOff',
      input: ([shape]) => {
        const stroke = isNode(shape) ? findChild(shape, 'v:stroke') : undefined
        return stroke ? { args: { value: attrsOf(stroke)['on'] } } : undefined
      },
    },
    fromDocument: (parts) =>
      [
        ...new Set(
          [...parts.values()].flatMap((xml) =>
            [...xml.matchAll(DOCUMENT_VML_FLAGS)].map((m) => m[1]!),
          ),
        ),
      ].map((value) => ({ args: { value } })),
    built: ['f', 'false', '0', 't', 'true', '1', '', 'F', 'off', ' f']
      .map((value): Input => ({ args: { value } }))
      .concat([{ args: {} }]),
    mutation: 'none',
  },
  {
    fn: 'parse.vmlStrokeWeightPx',
    call: (_text, args) => internals.vmlStrokeWeightPx!(args.value),
    fromParse: {
      fn: 'vmlStrokeWeightPx',
      input: ([value]) =>
        value === undefined || typeof value === 'string'
          ? { args: value === undefined ? {} : { value } }
          : undefined,
    },
    built: [
      '0.75pt',
      '2px',
      ' 1 ',
      '0',
      '-1pt',
      '1.5 pt',
      'abc',
      '1e2',
      '..',
      '1.2.3pt',
      '',
      '3in',
      '1px ',
      '.5',
      '0.333px',
      '\u00a01pt',
    ]
      .map((value): Input => ({ args: { value } }))
      .concat([{ args: {} }]),
    mutation: 'none',
  },
  {
    fn: 'parse.applyVmlMsoPosition',
    call: (text, args) => {
      const box = copy(args.box)
      internals.applyVmlMsoPosition!(box, text, args.sect)
      return box
    },
    fromParse: {
      fn: 'applyVmlMsoPosition',
      input: ([box, style, sect]) =>
        isObject(box) && typeof style === 'string' && isObject(sect)
          ? { text: style, args: { box: copy(box), sect } }
          : undefined,
    },
    built: MSO_STYLES.flatMap((text) =>
      BOXES.flatMap((box) => SECTS.map((sect) => ({ text, args: { box, sect } }))),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.readAnchorPos',
    call: (text, args) => {
      const image = copy(args.image)
      internals.readAnchorPos!(text, image)
      return image
    },
    fromParse: {
      fn: 'readAnchorPos',
      input: ([frag, image]) => {
        if (typeof frag !== 'string' || !isObject(image)) return undefined
        return { text: frag, args: { image: copy(image) } }
      },
    },
    built: ANCHOR_FRAGS.flatMap((text) =>
      [
        {},
        { posH: 'center', posXPx: 7 },
        { dataUrl: 'data:,', posH: 'right', posYPx: 3, floating: true },
        { id: 4, posVRel: 'page', widthPx: 10 },
      ].map((image) => ({ text, args: { image } })),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.hfShapeDrawingSvg',
    call: (text) => internals.hfShapeDrawingSvg!(text),
    fromParse: {
      fn: 'hfShapeDrawingSvg',
      input: ([frag]) => (typeof frag === 'string' ? { text: frag } : undefined),
    },
    built: SVG_FRAGS.map((text): Input => ({ text })),
  },
  {
    fn: 'parse.vmlLengthPx',
    call: (_text, args) => internals.vmlLengthPx!(args.raw),
    fromParse: {
      fn: 'vmlLengthPx',
      input: ([raw]) =>
        raw === undefined || typeof raw === 'string'
          ? { args: raw === undefined ? {} : { raw } }
          : undefined,
    },
    built: [
      '46pt',
      '16in',
      '2cm',
      '12px',
      '1pc',
      '3mm',
      '0',
      '-1.5pt',
      ' 7 pt ',
      '1em',
      '..',
      '',
      'pt',
      '1e3pt',
      '0.1',
      '-',
    ]
      .map((raw): Input => ({ args: { raw } }))
      .concat([{ args: {} }]),
    mutation: 'none',
  },
  {
    fn: 'parse.readBodyPr',
    call: (text, args) => {
      const box = copy(args.box)
      internals.readBodyPr!(nodeOf(text), box)
      return box
    },
    fromParse: {
      fn: 'readBodyPr',
      input: ([bodyPr, box]) =>
        isNode(bodyPr) && isObject(box)
          ? { text: serializeXNode(bodyPr), args: { box: copy(box) } }
          : undefined,
    },
    built: BODY_PRS.flatMap((text) => TEXT_BOXES.map((box) => ({ text, args: { box } }))),
    argMutation: true,
  },
  {
    fn: 'parse.rectFrac',
    call: (text, args) => internals.rectFrac!(text, args.name),
    fromParse: {
      fn: 'rectFrac',
      input: ([tag, name]) =>
        typeof tag === 'string' && typeof name === 'string'
          ? { text: tag, args: { name } }
          : undefined,
    },
    built: RECT_TAGS.flatMap((text) => RECT_NAMES.map((name) => ({ text, args: { name } }))),
  },
  {
    fn: 'parse.picBorderOf',
    call: (text) => internals.picBorderOf!(text),
    fromParse: {
      fn: 'picBorderOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: PIC_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'parse.groupPictureLayers',
    call: (text, args) =>
      internals.groupPictureLayers!(
        nodeOf(text),
        new Map(args.mediaByRid as Array<[string, string]>),
      ),
    fromParse: {
      fn: 'groupPictureLayers',
      input: ([drawing, mediaByRid]) =>
        isNode(drawing) && mediaByRid instanceof Map
          ? { text: serializeXNode(drawing), args: { mediaByRid: [...mediaByRid] } }
          : undefined,
    },
    built: GROUP_DRAWINGS.map((text) => ({ text, args: { mediaByRid: MEDIA } })),
  },
  {
    fn: 'parse.picTransformOf',
    call: (text) => internals.picTransformOf!(text),
    fromParse: {
      fn: 'picTransformOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: PIC_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'parse.vmlImageMeta',
    call: (text) => internals.vmlImageMeta!(text),
    fromParse: {
      fn: 'vmlImageMeta',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: VML_IMAGES.map((text) => ({ text })),
  },
  {
    fn: 'parse.relPartPath',
    call: (_text, args) =>
      internals.relPartPath!(
        {
          rels: new Map(args.rels as Array<[string, RelInfo]>),
          ...(args.sourcePath !== undefined ? { sourcePath: args.sourcePath } : {}),
        },
        args.rId,
      ),
    fromParse: {
      fn: 'relPartPath',
      input: ([ctx, rId]) => {
        const rels = isObject(ctx) ? relsEntries(ctx.rels) : undefined
        if (!isObject(ctx) || !rels || (rId !== undefined && typeof rId !== 'string'))
          return undefined
        const sourcePath = sourcePathOf(ctx)
        return {
          args: {
            rels,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
            ...(rId !== undefined ? { rId } : {}),
          },
        }
      },
    },
    built: [...RELS.map(([id]) => id), 'rId99', undefined].flatMap((rId) =>
      [undefined, 'word/header1.xml', 'word/glossary/document.xml', ''].map((sourcePath) => ({
        args: {
          rels: RELS,
          ...(sourcePath !== undefined ? { sourcePath } : {}),
          ...(rId !== undefined ? { rId } : {}),
        },
      })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.parseCompatibilityMode',
    call: (_text, args) => internals.parseCompatibilityMode!(zipOf(args.parts)),
    fromParse: { fn: 'parseCompatibilityMode', input: (_args, parts) => settingsOnly(parts) },
    built: SETTINGS_XMLS.map((xml) => ({ args: { parts: settingsParts(xml) } })),
    mutation: 'none',
  },
  {
    fn: 'parse.parseLayoutSettings',
    call: (_text, args) => internals.parseLayoutSettings!(zipOf(args.parts)),
    fromParse: { fn: 'parseLayoutSettings', input: (_args, parts) => settingsOnly(parts) },
    built: SETTINGS_XMLS.map((xml) => ({ args: { parts: settingsParts(xml) } })),
    mutation: 'none',
  },
  {
    fn: 'parse.parseNoteProps',
    call: (text, args) => internals.parseNoteProps!(zipOf(args.parts), text),
    fromParse: {
      fn: 'parseNoteProps',
      input: ([, documentXml], parts) =>
        typeof documentXml === 'string'
          ? { text: documentXml, args: { parts: partsNamed(parts, SETTINGS) } }
          : undefined,
    },
    built: NOTE_DOCUMENTS.flatMap((text) =>
      SETTINGS_XMLS.map((xml) => ({ text, args: { parts: settingsParts(xml) } })),
    ),
  },
  {
    fn: 'parse.parseSettingsFlag',
    call: (_text, args) => internals.parseSettingsFlag!(zipOf(args.parts), args.tag),
    fromParse: {
      fn: 'parseSettingsFlag',
      input: ([, tag], parts) =>
        typeof tag === 'string' ? { args: { ...settingsOnly(parts).args, tag } } : undefined,
    },
    built: SETTINGS_XMLS.flatMap((xml) =>
      SETTINGS_TAGS.map((tag) => ({ args: { parts: settingsParts(xml), tag } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.parseSources',
    call: (_text, args) => internals.parseSources!(zipOf(args.parts)),
    fromParse: {
      fn: 'parseSources',
      input: (_args, parts) => ({
        args: { parts: [...parts].filter(([name]) => name.startsWith('customXml/')) },
      }),
    },
    built: SOURCES_PACKAGES.map((parts) => ({ args: { parts } })),
    mutation: 'none',
  },
  {
    fn: 'parse.readThemeFontLang',
    call: (_text, args) => internals.readThemeFontLang!(zipOf(args.parts)),
    fromParse: { fn: 'readThemeFontLang', input: (_args, parts) => settingsOnly(parts) },
    built: SETTINGS_XMLS.map((xml) => ({ args: { parts: settingsParts(xml) } })),
    mutation: 'none',
  },
  {
    fn: 'parse.mediaPartSrc',
    // a zip read from bytes, as parseDocx has it: its parts carry the size the zip declares
    call: async (_text, args) => {
      const zip = await JSZip.loadAsync(
        await zipOf(args.parts).generateAsync({ type: 'uint8array' }),
      )
      const partPath = args.partPath as string
      const src = await internals.mediaPartSrc!(zip, zip.file(partPath), partPath, args.mime)
      const lazy = internals.lazyHashesByZip as unknown as WeakMap<JSZip, Set<string>>
      return { src, lazyHashes: [...(lazy.get(zip) ?? [])] }
    },
    fromParse: {
      fn: 'mediaPartSrc',
      input: ([, file, partPath, mime]) => {
        const text =
          typeof partPath === 'string' && typeof mime === 'string' ? partText(file) : undefined
        return text === undefined
          ? undefined
          : { args: { parts: [[partPath, text]], partPath, mime } }
      },
    },
    built: MEDIA_PARTS.map(([name, text, mime]) => ({
      args: { parts: [[name, text]], partPath: name, mime },
    })).concat([
      {
        args: {
          parts: [['word/media/a.png', 'x']],
          partPath: 'word/media/b.png',
          mime: 'image/png',
        },
      },
    ]),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.externalTxbxParts',
    call: (text, args) =>
      internals.externalTxbxParts!(
        text,
        zipOf(args.parts),
        new Map(args.rels as Array<[string, RelInfo]>),
        ...(args.sourcePath !== undefined ? [args.sourcePath] : []),
      ),
    fromParse: {
      fn: 'externalTxbxParts',
      input: ([documentXml, , rels, sourcePath], parts) => {
        const entries = relsEntries(rels)
        if (
          typeof documentXml !== 'string' ||
          !entries ||
          (sourcePath !== undefined && typeof sourcePath !== 'string')
        )
          return undefined
        const map = rels as Map<string, RelInfo>
        const ids = [...documentXml.matchAll(/<wps:txbx\b[^>]*\br:txbx="([^"]+)"/g)].map(
          (m) => m[1],
        )
        const named = ids.flatMap((rId) => relPart(parts, map, rId, sourcePath))
        return {
          text: documentXml,
          args: {
            parts: [...new Map(named)],
            rels: entries,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
          },
        }
      },
    },
    built: TXBX_DOCUMENTS.flatMap((text) =>
      [undefined, 'word/sub/document.xml'].map((sourcePath) => ({
        text,
        args: {
          parts: TXBX_PARTS,
          rels: RELS,
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        },
      })),
    ),
  },
  {
    fn: 'parse.extractChart',
    call: async (text, args) => {
      const ctx = {
        zip: zipOf(args.parts),
        rels: new Map(args.rels as Array<[string, RelInfo]>),
        ...(args.sourcePath !== undefined ? { sourcePath: args.sourcePath } : {}),
        ...(args.themeColors !== undefined ? { themeColors: args.themeColors } : {}),
        chartParts: copy(args.chartParts) as Record<string, string>,
      }
      const display = await internals.extractChart!(text, ctx)
      return { display, chartParts: ctx.chartParts }
    },
    fromParse: {
      fn: 'extractChart',
      input: ([xml, ctx], parts) => {
        const rels = isObject(ctx) ? relsEntries(ctx.rels) : undefined
        if (typeof xml !== 'string' || !isObject(ctx) || !rels || !isObject(ctx.chartParts))
          return undefined
        const sourcePath = sourcePathOf(ctx)
        const rId = /<cx?:chart [^>]*r:id="([^"]+)"/.exec(xml)?.[1]
        return {
          text: xml,
          args: {
            parts: relPart(parts, ctx.rels as Map<string, RelInfo>, rId, sourcePath),
            rels,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
            ...(ctx.themeColors !== undefined ? { themeColors: copy(ctx.themeColors) } : {}),
            chartParts: copy(ctx.chartParts),
          },
        }
      },
    },
    built: CHART_DRAWINGS.flatMap((text) =>
      [
        { chartParts: {} },
        {
          chartParts: { 'word/charts/chart1.xml': 'old', '2': 'two' },
          themeColors: null,
          sourcePath: 'word/document.xml',
        },
        {
          chartParts: {},
          themeColors: { accent1: '112233', dk1: '000000' },
          sourcePath: 'word/sub/x.xml',
        },
      ].map((extra) => ({ text, args: { parts: CHART_PARTS, rels: RELS, ...extra } })),
    ),
    argMutation: true,
  },
]

/**
 * The text of a part as JSZip holds it after loading a zip, read without
 * awaiting: stored or deflated bytes inflated here. `undefined` where the
 * bytes are no UTF-8, which the wire's `[name, text]` parts cannot carry.
 */
function partText(file: unknown): string | undefined {
  const data = (file as JSZipObject & { _data?: unknown })._data as
    { compressedContent?: Uint8Array; compression?: { magic?: string } } | Uint8Array | undefined
  let bytes: Uint8Array | undefined
  if (data instanceof Uint8Array) bytes = data
  else if (data?.compressedContent && data.compression?.magic === '\x00\x00')
    bytes = data.compressedContent
  else if (data?.compressedContent && data.compression?.magic === '\x08\x00')
    bytes = inflateRawSync(data.compressedContent)
  if (!bytes) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

// ================================================================ batch 2: media, VML, text boxes, diagrams
// A function over a BuildContext takes `args.parts` (the styles, numbering,
// theme and settings the context is read from), `args.extra` (the parts the
// call reads through `ctx.zip`: its media, charts and diagrams) and the members
// the context holds beyond them. `args.hf` is a header, footer or notes
// context: no `zip`, no `numbering`. `args.sectSlices` is `[index, text]` of
// the w:sectPr of document.xml, what `sectionAt` is made of.

const CTX_PART_NAMES = [
  'word/styles.xml',
  'word/numbering.xml',
  'word/theme/theme1.xml',
  'word/settings.xml',
]
/** Characters of parts per spec and document: every call carries its parts. */
const CTX_PARTS_BUDGET = 400_000
const MAX_CTX_INPUTS = 12
/** Characters of the parts a call reads through its zip. */
const EXTRA_BUDGET = 300_000

interface CtxParsed {
  styles: Map<string, unknown>
  docDefaults: unknown
  numbering: Map<string, unknown>
  numFormats: Map<string, unknown>
  themeFonts: unknown
  themeColors: unknown
  gutterAtTop: boolean
}

async function parseCtxParts(parts: unknown): Promise<CtxParsed> {
  const zip = zipOf(parts)
  const theme = (await internals.parseTheme!(zip)) as {
    fonts: ThemeFonts | null
    colors: ThemeColors | null
  }
  const { styles, docDefaults } = await parseStyles(zip, theme.colors, theme.fonts)
  const { defs, formats } = await parseNumbering(zip)
  return {
    styles,
    docDefaults,
    numbering: defs,
    numFormats: formats,
    themeFonts: theme.fonts,
    themeColors: theme.colors,
    gutterAtTop: (await internals.parseSettingsFlag!(zip, 'w:gutterAtTop')) as boolean,
  }
}

/** Parsed once per `args.parts` array: the inputs of one document share it. */
const ctxParsedByParts = new WeakMap<object, Promise<CtxParsed>>()

function ctxParsedOf(parts: unknown): Promise<CtxParsed> {
  if (typeof parts !== 'object' || parts === null) return parseCtxParts(parts)
  let parsed = ctxParsedByParts.get(parts)
  if (!parsed) {
    parsed = parseCtxParts(parts)
    ctxParsedByParts.set(parts, parsed)
  }
  return parsed
}

/** A zip read from bytes, as parseDocx has it: its parts carry the size the zip declares. */
async function loadedZip(parts: unknown): Promise<JSZip> {
  return JSZip.loadAsync(await zipOf(parts ?? []).generateAsync({ type: 'uint8array' }))
}

interface CompatArgs {
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}

const entriesOf = <V>(value: unknown): Array<[string, V]> =>
  (value as Array<[string, V]> | undefined) ?? []

/** The BuildContext of `args`, as parseDocx builds the body's (or, with `hf`, a header's). */
async function buildCtx(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = await ctxParsedOf(args.parts)
  const resolver = resolveCtxOf({
    styles: parsed.styles as Map<string, StyleInfo>,
    docDefaults: parsed.docDefaults as DocDefaults | undefined,
    numbering: parsed.numbering as Map<string, NumberingDef>,
    themeFonts: parsed.themeFonts as ThemeFonts | null,
    themeColors: parsed.themeColors as ThemeColors | null,
    ...((args.compat ?? {}) as CompatArgs),
  })
  const ctx: Record<string, unknown> = {
    rels: new Map(entriesOf<RelInfo>(args.rels)),
    noteNumbers: new Map(entriesOf<number>(args.noteNumbers)),
    themeColors: parsed.themeColors,
    themeFonts: parsed.themeFonts,
    styles: parsed.styles,
    xmlSpacePreserve: args.xmlSpacePreserve === true,
    resolver,
  }
  if (args.partNamespaces !== undefined)
    ctx.partNamespaces = new Map(entriesOf<string>(args.partNamespaces))
  if (args.hf !== true) {
    Object.assign(ctx, {
      zip: await loadedZip(args.extra),
      compat: resolver.compat,
      numFormats: parsed.numFormats,
      numbering: parsed.numbering,
      chartParts: copy(args.chartParts ?? {}),
      docDefaults: parsed.docDefaults,
      sdtGroupSeq: 0,
      ...(resolver.defaultParaStyle ? { defaultParaStyle: resolver.defaultParaStyle } : {}),
    })
    if (args.sourcePath !== undefined) ctx.sourcePath = args.sourcePath
  }
  if (args.chartParts !== undefined && args.hf === true) ctx.chartParts = copy(args.chartParts)
  if (args.mediaByRid !== undefined) ctx.mediaByRid = new Map(entriesOf<string>(args.mediaByRid))
  if (args.externalTxbxByRid !== undefined)
    ctx.externalTxbxByRid = new Map(entriesOf<string>(args.externalTxbxByRid))
  if (args.vmlShapeTypes !== undefined)
    ctx.vmlShapeTypes = new Map(entriesOf<Record<string, string>>(args.vmlShapeTypes))
  if (args.compatibilityMode !== undefined) ctx.compatibilityMode = args.compatibilityMode
  if (args.nextZoteroFieldId !== undefined) ctx.nextZoteroFieldId = args.nextZoteroFieldId
  if (args.referenceOnlyComments !== undefined)
    ctx.referenceOnlyComments = new Set(args.referenceOnlyComments as string[])
  if (args.sectSlices !== undefined) {
    const slices = args.sectSlices as Array<[number, string]>
    const cache = new Map<number, SectionSettings>()
    // parseDocx's sectionAt over the slices of document.xml it keeps
    ctx.sectionAt = (docOffset: number): SectionSettings => {
      let i = slices.findIndex(([index, text]) => index + text.length > docOffset)
      if (i === -1) i = slices.length - 1
      let settings = cache.get(i)
      if (!settings) {
        settings = sectionSettingsFromXml(i >= 0 ? slices[i]![1] : '', {
          gutterAtTop: parsed.gutterAtTop,
        })
        cache.set(i, settings)
      }
      return settings
    }
  }
  return ctx
}

/** What a spec took per document, by function name. */
const ctxTaken = new WeakMap<ReadonlyMap<string, string>, Map<string, number>>()
const ctxPartsByDocument = new WeakMap<
  ReadonlyMap<string, string>,
  { parts: Array<[string, string]>; cap: number }
>()

/** The context parts of a document, or undefined once `fn` has taken as many inputs of it as its budget allows. */
function takeCtxParts(
  fn: string,
  parts: ReadonlyMap<string, string>,
): Array<[string, string]> | undefined {
  let own = ctxPartsByDocument.get(parts)
  if (!own) {
    const pairs = partsNamed(parts, ...CTX_PART_NAMES)
    const size = pairs.reduce((sum, [, text]) => sum + text.length, 0)
    own = {
      parts: pairs,
      cap: Math.max(3, Math.min(MAX_CTX_INPUTS, Math.floor(CTX_PARTS_BUDGET / Math.max(1, size)))),
    }
    ctxPartsByDocument.set(parts, own)
  }
  const counts = ctxTaken.get(parts) ?? new Map<string, number>()
  ctxTaken.set(parts, counts)
  const taken = counts.get(fn) ?? 0
  if (taken >= own.cap) return undefined
  counts.set(fn, taken + 1)
  return own.parts
}

/** The parts of the package a drawing's relationships name: what its call reads through the zip. */
function referencedParts(
  parts: ReadonlyMap<string, string>,
  rels: Map<string, RelInfo>,
  sourcePath: string | undefined,
  xml: string,
): Array<[string, string]> {
  const out = new Map<string, string>()
  const add = (name: string | null): void => {
    const text = name === null ? undefined : parts.get(name)
    if (text !== undefined) out.set(name!, text)
  }
  for (const m of xml.matchAll(/\br:[A-Za-z]+\s*=\s*["']([^"']+)["']/g)) {
    const rel = rels.get(m[1]!)
    if (rel && rel.targetMode !== 'External')
      add(resolveRelationshipTargetPath(sourcePath ?? 'word/document.xml', rel.target))
  }
  // a diagram's data part has its drawing beside it, and the drawing its own rels and media
  for (const name of [...out.keys()]) {
    if (!/data\d*\.xml$/.test(name)) continue
    const drawing = name.replace(/data(\d*)\.xml$/, 'drawing$1.xml')
    add(drawing)
    const relsName = drawing.replace(/([^/]+)$/, '_rels/$1.rels')
    add(relsName)
    for (const m of (parts.get(relsName) ?? '').matchAll(/Target="([^"]+)"/g))
      add(resolveRelationshipTargetPath(drawing, m[1]!))
  }
  add('[Content_Types].xml')
  return [...out]
}

/** `[index, text]` of the w:sectPr of document.xml, as sectionAt finds them; undefined where they would not cross as ASCII. */
function sectSlicesOf(parts: ReadonlyMap<string, string>): Array<[number, string]> | undefined {
  const documentXml = parts.get('word/document.xml') ?? ''
  const slices = [...documentXml.matchAll(/<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>/g)].map(
    (m) => [m.index ?? 0, m[0]] as [number, string],
  )
  const size = slices.reduce((sum, [, text]) => sum + text.length, 0)
  return size > 60_000 || slices.some(([, text]) => /[^\x00-\x7f]/.test(text)) ? undefined : slices
}

/** The arguments a BuildContext crosses as, at the call; undefined where it is not one this side can rebuild. */
function ctxArgs(
  fn: string,
  parts: ReadonlyMap<string, string>,
  ctx: unknown,
  xml: string,
): Record<string, unknown> | undefined {
  if (!isObject(ctx)) return undefined
  const rels = relsEntries(ctx.rels)
  if (!rels) return undefined
  const hf = ctx.numbering === undefined
  const sourcePath = sourcePathOf(ctx)
  const extra = hf ? [] : referencedParts(parts, ctx.rels as Map<string, RelInfo>, sourcePath, xml)
  if (extra.reduce((sum, [, text]) => sum + text.length, 0) > EXTRA_BUDGET) return undefined
  const slices = ctx.sectionAt === undefined ? undefined : sectSlicesOf(parts)
  if (ctx.sectionAt !== undefined && slices === undefined) return undefined
  const ctxParts = takeCtxParts(fn, parts)
  if (!ctxParts) return undefined
  const resolver = isObject(ctx.resolver) ? ctx.resolver : {}
  const compat = isObject(resolver.compat) ? resolver.compat : {}
  const out: Record<string, unknown> = {
    parts: ctxParts,
    rels,
    compat: {
      compatibilityMode: compat.mode,
      doNotUseHTMLParagraphAutoSpacing: compat.additiveParaSpacing,
      indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
    },
  }
  if (hf) out.hf = true
  else out.extra = extra
  if (sourcePath !== undefined) out.sourcePath = sourcePath
  if (ctx.xmlSpacePreserve === true) out.xmlSpacePreserve = true
  if (ctx.partNamespaces instanceof Map) out.partNamespaces = [...ctx.partNamespaces]
  if (ctx.noteNumbers instanceof Map && ctx.noteNumbers.size > 0)
    out.noteNumbers = [...ctx.noteNumbers]
  if (isObject(ctx.chartParts)) out.chartParts = copy(ctx.chartParts)
  if (ctx.mediaByRid instanceof Map) out.mediaByRid = [...ctx.mediaByRid]
  if (ctx.externalTxbxByRid instanceof Map) out.externalTxbxByRid = [...ctx.externalTxbxByRid]
  if (ctx.vmlShapeTypes instanceof Map) out.vmlShapeTypes = copy([...ctx.vmlShapeTypes])
  if (typeof ctx.compatibilityMode === 'number') out.compatibilityMode = ctx.compatibilityMode
  if (typeof ctx.nextZoteroFieldId === 'number') out.nextZoteroFieldId = ctx.nextZoteroFieldId
  if (ctx.referenceOnlyComments instanceof Set)
    out.referenceOnlyComments = [...ctx.referenceOnlyComments]
  if (slices !== undefined) out.sectSlices = slices
  return out
}

/** `{ text, args }` of a call over an XML string and a context. */
function ctxInput(
  fn: string,
  parts: ReadonlyMap<string, string>,
  xml: unknown,
  ctx: unknown,
  more: Record<string, unknown> = {},
): Input | undefined {
  if (typeof xml !== 'string') return undefined
  const args = ctxArgs(fn, parts, ctx, xml)
  return args ? { text: xml, args: { ...args, ...more } } : undefined
}

/** [`ctxInput`] over a node argument: its XML text. */
function ctxNodeInput(
  fn: string,
  parts: ReadonlyMap<string, string>,
  node: unknown,
  ctx: unknown,
  more: Record<string, unknown> = {},
): Input | undefined {
  if (!isNode(node)) return undefined
  return ctxInput(fn, parts, serializeXNode(node), ctx, more)
}

/** Ids a text box takes from a counter the two sides do not share: renumbered from 1 in order of appearance. */
function renumberBoxIds(paras: Array<{ box?: { id?: number } }>): void {
  const seen = new Map<object, number>()
  for (const para of paras) {
    if (para.box && !seen.has(para.box)) {
      seen.set(para.box, seen.size + 1)
      para.box.id = seen.size
    }
  }
}

// ---------------------------------------------------------------- built contexts

const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const stylesXml = (...styles: string[]): string =>
  `<w:styles ${WNS}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${styles.join('')}</w:styles>`
const styleXml = (type: string, id: string, inner: string, attrs = ''): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${attrs}><w:name w:val="${id}"/>${inner}</w:style>`
const B_STYLES = stylesXml(
  styleXml('paragraph', 'Normal', '<w:rPr><w:sz w:val="24"/></w:rPr>', ' w:default="1"'),
  styleXml(
    'paragraph',
    'Heading1',
    '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="60"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>',
  ),
  styleXml(
    'paragraph',
    'ListBullet',
    '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>',
  ),
  styleXml('paragraph', 'RtlPara', '<w:pPr><w:bidi/></w:pPr>'),
  styleXml('character', 'Strong', '<w:rPr><w:b/><w:color w:val="00AA00"/></w:rPr>'),
)
const B_NUMBERING = `<w:numbering ${WNS}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/><w:sz w:val="40"/></w:rPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%2."/><w:pPr><w:bidi/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`
const B_THEME =
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
const B_PARTS: Array<[string, string]> = [
  ['word/styles.xml', B_STYLES],
  ['word/numbering.xml', B_NUMBERING],
  ['word/theme/theme1.xml', B_THEME],
]
const B_PARTS_GUTTER: Array<[string, string]> = [
  ...B_PARTS,
  [SETTINGS, '<w:settings><w:gutterAtTop/></w:settings>'],
]
const NO_PARTS: Array<[string, string]> = []

const MEDIA_URLS: Array<[string, string]> = [
  ['rId1', 'data:image/png;base64,AAAA'],
  ['rId2', 'http://example.com/a.png'],
]
const SECT_SLICES: Array<[number, string]> = [
  [
    40,
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  ],
  [
    900,
    '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="1080" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:num="2" w:space="720"/><w:docGrid w:type="lines" w:linePitch="360"/></w:sectPr>',
  ],
]
const NO_SECT: Array<[number, string]> = []

/** A body context over the built package. */
const bodyCtx = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  parts: B_PARTS,
  extra: NO_PARTS,
  rels: RELS,
  sourcePath: 'word/document.xml',
  compat: { compatibilityMode: 15 },
  compatibilityMode: 15,
  chartParts: {},
  mediaByRid: MEDIA_URLS,
  ...extra,
})
/** A header context over the built package. */
const hfCtx = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  parts: B_PARTS,
  hf: true,
  rels: [],
  compat: { compatibilityMode: 0 },
  ...extra,
})
const CTX_VARIANTS: Array<Record<string, unknown>> = [
  bodyCtx(),
  bodyCtx({
    sectSlices: SECT_SLICES,
    compat: { compatibilityMode: 14, doNotUseHTMLParagraphAutoSpacing: true },
    compatibilityMode: 14,
  }),
  bodyCtx({
    parts: B_PARTS_GUTTER,
    sectSlices: SECT_SLICES,
    externalTxbxByRid: [
      [
        'rId6',
        '<w14:txbx><w:txbxContent><w:p><w:r><w:t>external</w:t></w:r></w:p></w:txbxContent></w14:txbx>',
      ],
    ],
  }),
  bodyCtx({
    sectSlices: NO_SECT,
    noteNumbers: [['footnote:1', 1]],
    referenceOnlyComments: ['3'],
    xmlSpacePreserve: true,
  }),
  hfCtx(),
  hfCtx({
    mediaByRid: MEDIA_URLS,
    partNamespaces: [['w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main']],
  }),
]

// ---------------------------------------------------------------- built drawings

const para = (inner: string, pPr = ''): string =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`
const run = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`
const txbxParas = (inner: string): string => `<w:txbxContent>${inner}</w:txbxContent>`
const NUM_PR = (numId: string, ilvl = '0'): string =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`
const INLINE_PIC =
  '<w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'

const TXBX_CONTENTS = [
  txbxParas(para(run('a'))),
  txbxParas(
    para(run('title'), '<w:pStyle w:val="Heading1"/><w:ind w:left="720" w:hanging="360"/>'),
  ),
  txbxParas(
    para(run('first'), NUM_PR('1')) +
      para(run('second'), NUM_PR('1', '1')) +
      para(run('roman'), NUM_PR('2')) +
      para(run('after')),
  ),
  txbxParas(
    para(run('styled list'), '<w:pStyle w:val="ListBullet"/>') +
      para(run('missing list'), NUM_PR('9')),
  ),
  txbxParas('<w:p><w:pPr><w:rPr><w:sz w:val="44"/></w:rPr></w:pPr></w:p>'),
  txbxParas(para('<w:r><w:t xml:space="preserve">   </w:t></w:r>')),
  txbxParas(
    para(run('שלום', '<w:rtl/>'), '<w:pStyle w:val="RtlPara"/><w:jc w:val="right"/>') +
      para(run('x'), '<w:bidi w:val="0"/>'),
  ),
  txbxParas(
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:fill="FFFF00"/></w:tcPr>${para(run('c1'))}</w:tc><w:tc>${para(run('c2'))}</w:tc></w:tr></w:tbl>${para(run('after table'))}`,
  ),
  txbxParas(
    `<w:sdt><w:sdtContent>${para(run('in sdt'))}</w:sdtContent></w:sdt><w:sdt><w:sdtPr/></w:sdt>`,
  ),
  txbxParas(para(INLINE_PIC)),
  txbxParas(para(run('chars'), '<w:ind w:leftChars="100" w:firstLineChars="50"/>')),
  // w:firstLine in twips with a character-unit left: the TypeScript sets
  // indentFirstLine before indentLeft, the other order of the two keys
  txbxParas(para(run('chars'), '<w:ind w:leftChars="100" w:firstLine="50"/>')),
  '<w:txbxContent/>',
  txbxParas(
    para(
      '<w:r><w:tab/><w:t>a</w:t><w:br/><w:t>b</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
  ),
  txbxParas(
    para(
      run('a'),
      '<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/><w:spacing w:line="480" w:lineRule="auto"/>',
    ) + '<w:bookmarkStart w:id="1" w:name="b"/>',
  ),
  txbxParas(
    para(
      '<w:r><w:footnoteReference w:id="1"/></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>',
    ),
  ),
]

const STRAY_PARAS = [
  `<w:p><w:r><w:t>stray text</w:t></w:r><w:r><w:pict><v:shape style="position:absolute"><v:textbox>${TXBX_CONTENTS[0]}</v:textbox></v:shape></w:pict></w:r></w:p>`,
  `<w:p><w:pPr><w:jc w:val="center"/><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>centered</w:t></w:r>${TXBX_CONTENTS[1]}</w:p>`,
  '<w:p><w:r><w:t>   </w:t></w:r></w:p>',
  '<w:p><w:pPr><w:jc w:val="right"/></w:pPr></w:p>',
  '<w:r><w:t>no paragraph</w:t></w:r>',
  '<w:p><w:r><w:pict><v:rect/></w:pict><w:t>after pict</w:t></w:r></w:p>',
  `<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>`,
  `<w:p><w:r><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx>${TXBX_CONTENTS[0]}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r><w:r><w:t>beside</w:t></w:r></w:p>`,
  '<w:p><w:r><w:t>unclosed',
  '',
]

const wpsAnchor = (opts: {
  attrs?: string
  posH?: string
  posV?: string
  wrap?: string
  extent?: string
  spPr?: string
  txbx?: string
  bodyPr?: string
  style?: string
  id?: string
}): string =>
  `<w:drawing><wp:anchor ${opts.attrs ?? 'distT="0" distB="0" distL="114300" distR="114300" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"'}><wp:simplePos x="0" y="0"/>${opts.posH ?? '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>'}${opts.posV ?? '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'}${opts.extent ?? '<wp:extent cx="2000000" cy="1000000"/>'}${opts.wrap ?? '<wp:wrapSquare wrapText="bothSides"/>'}<wp:docPr id="1" name="TB"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvPr id="${opts.id ?? '2'}" name="Text Box 2"/><wps:cNvSpPr txBox="1"/><wps:spPr>${opts.spPr ?? '<a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'}</wps:spPr>${opts.style ?? ''}${opts.txbx ?? `<wps:txbx>${TXBX_CONTENTS[0]}</wps:txbx>`}${opts.bodyPr ?? '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:noAutofit/></wps:bodyPr>'}</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const inRun = (inner: string): string => `<w:r>${inner}</w:r>`
const paraOf = (inner: string, pPr = ''): string => para(inner, pPr)

const POS_H = [
  '<wp:positionH relativeFrom="column"><wp:posOffset>914400</wp:posOffset></wp:positionH>',
  '<wp:positionH relativeFrom="page"><wp:posOffset>6000000</wp:posOffset></wp:positionH>',
  '<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>',
  '<wp:positionH relativeFrom="page"><wp:align>right</wp:align></wp:positionH>',
  '<wp:positionH relativeFrom="column"><wp:align>left</wp:align></wp:positionH>',
  '<wp:positionH relativeFrom="page"><wp:posOffset>-100000</wp:posOffset></wp:positionH>',
]
const POS_V = [
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>-500000</wp:posOffset></wp:positionV>',
  '<wp:positionV relativeFrom="page"><wp:posOffset>300000</wp:posOffset></wp:positionV>',
  '<wp:positionV relativeFrom="margin"><wp:align>bottom</wp:align></wp:positionV>',
  '<wp:positionV relativeFrom="page"><wp:align>center</wp:align></wp:positionV>',
  '<wp:positionV relativeFrom="line"><wp:posOffset>12700</wp:posOffset></wp:positionV>',
  '<wp:positionV relativeFrom="page"><wp:posOffset>12000000</wp:posOffset></wp:positionV>',
]
const WRAPS = [
  '<wp:wrapSquare wrapText="bothSides"/>',
  '<wp:wrapSquare wrapText="left"/>',
  '<wp:wrapTight wrapText="right"><wp:wrapPolygon edited="0"/></wp:wrapTight>',
  '<wp:wrapThrough wrapText="largest"/>',
  '<wp:wrapTopAndBottom/>',
  '<wp:wrapNone/>',
  '',
]
const EXTENTS = [
  '<wp:extent cx="2000000" cy="1000000"/>',
  '<wp:extent cx="5760000" cy="2400000"/>',
  '<wp:extent cx="4000000" cy="9000000"/>',
  '<wp:extent cx="0" cy="0"/>',
]
const ATTRS = [
  undefined,
  'distT="0" distB="0" distL="0" distR="0" behindDoc="1" relativeHeight="251658240"',
  'behindDoc="0" locked="1" allowOverlap="0" relativeHeight="251700000" distL="91440"',
]
const SHAPE_SP_PRS = [
  undefined,
  '<a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill><a:ln w="19050"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:prstDash val="sysDash"/></a:ln>',
  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln>',
  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="ellipse"/><a:pattFill prst="pct5"><a:fgClr><a:srgbClr val="123456"/></a:fgClr></a:pattFill>',
  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId1"/><a:tile/></a:blipFill><a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  '<a:noFill/>',
]
const BODY_PR_VARIANTS = [
  undefined,
  '<wps:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"><a:spAutoFit/></wps:bodyPr>',
  '<wps:bodyPr lIns="-5" anchor="b"/>',
  '',
]
const WPS_STYLE =
  '<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></wps:style>'
const SHAPE_ONLY = (prst: string, extra = '', cy = 1000000): string =>
  wpsAnchor({
    txbx: '',
    bodyPr: '',
    extent: `<wp:extent cx="2000000" cy="${cy}"/>`,
    spPr: `<a:xfrm${extra}><a:off x="0" y="0"/><a:ext cx="2000000" cy="${cy}"/></a:xfrm><a:prstGeom prst="${prst}"/><a:solidFill><a:srgbClr val="336699"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:headEnd type="none"/><a:tailEnd type="triangle"/></a:ln>`,
  })

/** One paragraph of text-box drawings: what extractTextboxes and textboxParagraphs read. */
const BOX_PARAS: string[] = [
  ...POS_H.flatMap((posH, i) =>
    POS_V.map((posV, j) =>
      paraOf(
        inRun(
          wpsAnchor({
            posH,
            posV,
            wrap: WRAPS[(i + j) % WRAPS.length],
            extent: EXTENTS[(i * j) % EXTENTS.length],
            spPr: SHAPE_SP_PRS[(i + j) % SHAPE_SP_PRS.length],
            attrs: ATTRS[(i * 2 + j) % ATTRS.length],
          }),
        ),
      ),
    ),
  ),
  ...TXBX_CONTENTS.map((content) =>
    paraOf(inRun(wpsAnchor({ txbx: `<wps:txbx>${content}</wps:txbx>` }))),
  ),
  ...BODY_PR_VARIANTS.map((bodyPr) => paraOf(inRun(wpsAnchor({ bodyPr })))),
  ...SHAPE_SP_PRS.map((spPr) => paraOf(inRun(wpsAnchor({ spPr, style: WPS_STYLE })))),
  paraOf(inRun(wpsAnchor({ attrs: 'behindDoc="0"', txbx: '<wps:txbx r:txbx="rId6"/>' }))),
  paraOf(inRun(wpsAnchor({ txbx: '<wps:txbx r:txbx="rId7"/>' }))),
  paraOf(inRun(wpsAnchor({ txbx: '' })) + inRun(wpsAnchor({ id: '9' }))),
  paraOf(
    inRun(wpsAnchor({})) +
      inRun(wpsAnchor({ posH: POS_H[1], posV: POS_V[2], id: '4' })) +
      inRun(wpsAnchor({ posH: POS_H[3], wrap: WRAPS[5], id: '5' })),
  ),
  paraOf(
    inRun(wpsAnchor({ extent: '<wp:extent cx="2900000" cy="500000"/>' })) +
      inRun(
        wpsAnchor({
          extent: '<wp:extent cx="2900000" cy="500000"/>',
          posH: '<wp:positionH relativeFrom="column"><wp:posOffset>3000000</wp:posOffset></wp:positionH>',
          id: '3',
        }),
      ),
  ),
  ...[
    'line',
    'straightConnector1',
    'bentConnector3',
    'curvedConnector2',
    'rect',
    'ellipse',
    'triangle',
    'roundRect',
  ].flatMap((prst) => [
    paraOf(inRun(SHAPE_ONLY(prst))),
    paraOf(inRun(SHAPE_ONLY(prst, ' flipV="1"', 100))),
    paraOf(inRun(SHAPE_ONLY(prst, '', 500000))),
  ]),
  paraOf(inRun(SHAPE_ONLY('rect', '', 100)) + inRun(wpsAnchor({}))),
  paraOf(
    inRun(
      wpsAnchor({
        wrap: '<wp:wrapSquare wrapText="bothSides"/>',
        spPr: '<a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="445566"/></a:solidFill>',
        txbx: '',
      }),
    ),
  ),
  // a shape in a group, a textbox inside a textbox, a canvas
  paraOf(
    inRun(
      `<w:drawing><wp:anchor><wp:extent cx="3000000" cy="2000000"/><a:graphic><a:graphicData><wpg:wgp><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="6000000" cy="4000000"/></a:xfrm></wpg:grpSpPr><wps:wsp><wps:cNvPr id="7" name="a"/><wps:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"/><a:grpFill/></wps:spPr><wps:txbx>${TXBX_CONTENTS[0]}</wps:txbx></wps:wsp><wps:wsp><wps:spPr><a:xfrm><a:off x="2000000" y="100"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF00FF"/></a:solidFill></wps:spPr></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing>`,
    ),
  ),
  paraOf(
    inRun(
      wpsAnchor({
        txbx: `<wps:txbx>${txbxParas(para(inRun(wpsAnchor({ id: '8', txbx: `<wps:txbx>${TXBX_CONTENTS[0]}</wps:txbx>` }))))}</wps:txbx>`,
      }),
    ),
  ),
  paraOf(
    inRun(
      '<w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData><wpc:wpc><a:txSp><wps:txbx><w:txbxContent><w:p><w:r><w:t>canvas</w:t></w:r></w:p></w:txbxContent></wps:txbx></a:txSp></wpc:wpc></a:graphicData></a:graphic></wp:inline></w:drawing>',
    ),
  ),
  paraOf(
    '<mc:AlternateContent><mc:Choice Requires="wps">' +
      inRun(wpsAnchor({})) +
      '</mc:Choice><mc:Fallback><w:pict><v:shape style="position:absolute"><v:textbox><w:txbxContent><w:p><w:r><w:t>fallback</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent>',
  ),
  paraOf(inRun('<w:drawing><wp:inline><wp:extent cx="1"/></wp:inline></w:drawing>')),
  paraOf(inRun('<w:drawing><wp:anchor><wp:extent cx="1" cy="1"/>')),
  paraOf(run('plain')),
  '',
]

const PIC_DRAWING = (
  rId: string,
  anchorOpen: string,
  extent = '<wp:extent cx="1905000" cy="952500"/>',
  spPr = '<a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="roundRect"/>',
): string => {
  const graphic = `<wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="11" name="p.png"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill><pic:spPr>${spPr}</pic:spPr></pic:pic></a:graphicData></a:graphic>`
  return anchorOpen
    ? `<w:drawing>${anchorOpen}${extent}${graphic}</wp:anchor></w:drawing>`
    : `<w:drawing><wp:inline>${extent}${graphic}</wp:inline></w:drawing>`
}
const ANCHOR_OPEN =
  '<wp:anchor behindDoc="0" distL="0" distR="0"><wp:positionH relativeFrom="page"><wp:posOffset>100000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>200000</wp:posOffset></wp:positionV><wp:wrapNone/>'
const PIC_PARAS = [
  paraOf(inRun(PIC_DRAWING('rId1', ANCHOR_OPEN))),
  paraOf(inRun(PIC_DRAWING('rId1', ''))),
  paraOf(inRun(PIC_DRAWING('rId2', ANCHOR_OPEN, undefined, '<a:xfrm/><a:prstGeom prst="rect"/>'))),
  paraOf(inRun(PIC_DRAWING('rId9', ANCHOR_OPEN))),
  paraOf(inRun(PIC_DRAWING('rId1', ANCHOR_OPEN)) + inRun(wpsAnchor({}))),
  paraOf(inRun(PIC_DRAWING('rId1', ANCHOR_OPEN)) + inRun(PIC_DRAWING('rId2', ANCHOR_OPEN))),
  paraOf(inRun(PIC_DRAWING('rId1', ANCHOR_OPEN, '<wp:extent cx="x" cy="5"/>'))),
]

const vmlShape = (style: string, inner = '', attrs = '', tag = 'v:shape'): string =>
  `<${tag} style="${style}"${attrs ? ` ${attrs}` : ''}>${inner}</${tag}>`
const VML_TEXTBOX = (content: string, attrs = ''): string =>
  `<v:textbox${attrs ? ` ${attrs}` : ''}>${content}</v:textbox>`
const VML_STYLES = [
  'position:absolute;margin-left:10pt;margin-top:20pt;width:200pt;height:100pt;z-index:251659264',
  'position:absolute;margin-left:-5.5pt;margin-top:0;width:100pt;height:50pt;z-index:-251658240;mso-position-horizontal:center;mso-position-horizontal-relative:margin',
  'position:absolute;width:468pt;height:60pt;mso-position-horizontal-relative:page;mso-position-vertical:bottom;mso-position-vertical-relative:page;mso-wrap-style:none',
  'width:100pt;height:50pt',
  'position:relative',
  'position:absolute;rotation:30;mso-position-horizontal:right;mso-position-horizontal-relative:text',
]
const VML_BOX_PARAS = [
  ...VML_STYLES.flatMap((style, i) => [
    paraOf(
      inRun(
        `<w:pict>${vmlShape(style, VML_TEXTBOX(TXBX_CONTENTS[i % TXBX_CONTENTS.length]!, 'inset="1pt,2pt,3pt,4pt" style="mso-fit-shape-to-text:t"'), 'fillcolor="#ffff00" strokecolor="#ff0000" strokeweight="2pt" o:allowincell="f"')}</w:pict>`,
      ),
    ),
    paraOf(
      inRun(
        `<w:pict>${vmlShape(style, VML_TEXTBOX(TXBX_CONTENTS[0]!) + '<w10:wrap type="square"/>', 'stroked="f" filled="f" type="#_x0000_t202"', 'v:rect')}</w:pict>`,
      ),
    ),
    paraOf(
      inRun(
        `<w:pict>${vmlShape(style, '<v:imagedata r:id="rId1"/>', 'type="#_x0000_t75"')}</w:pict>`,
      ),
    ),
    paraOf(
      inRun(
        `<w:pict>${vmlShape(style, '<v:fill opacity="32768f"/><v:stroke on="f"/>', 'fillcolor="#123456" type="#tbl"', 'v:roundrect')}</w:pict>`,
      ),
    ),
  ]),
  paraOf(
    inRun(
      '<w:pict><v:shapetype id="_x0000_t202" coordsize="21600,21600" path="m,l,21600r21600,l21600,xe" fillcolor="#eeeeee"/>' +
        vmlShape(
          'position:absolute;width:10pt;height:10pt',
          VML_TEXTBOX(TXBX_CONTENTS[0]!),
          'type="#_x0000_t202"',
        ) +
        '</w:pict>',
    ),
  ),
  paraOf(
    inRun(
      '<w:pict>' +
        vmlShape(
          'position:absolute;width:50pt;height:20pt',
          '<v:textpath string="WordArt" style="font-family:&quot;Arial&quot;;font-size:20pt"/>',
          'fillcolor="red" type="#_x0000_t136"',
        ) +
        '</w:pict>',
    ),
  ),
  paraOf(
    inRun(
      '<w:pict><v:group style="position:absolute;margin-left:0;margin-top:0;width:200pt;height:100pt" coordsize="2000,1000" coordorigin="0,0">' +
        vmlShape(
          'position:absolute;left:100;top:50;width:500;height:300',
          VML_TEXTBOX(TXBX_CONTENTS[0]!),
          'fillcolor="#abcdef"',
          'v:rect',
        ) +
        vmlShape(
          'position:absolute;left:700;top:50;width:500;height:300',
          '<v:imagedata r:id="rId1"/>',
        ) +
        '</v:group></w:pict>',
    ),
  ),
  paraOf(
    inRun(
      '<w:pict><v:group style="width:200pt;height:100pt">' +
        vmlShape('width:50pt;height:20pt', VML_TEXTBOX(TXBX_CONTENTS[1]!)) +
        '</v:group></w:pict>',
    ),
  ),
  paraOf(
    inRun(
      `<w:pict>${vmlShape('position:absolute;width:10pt;height:10pt', VML_TEXTBOX(`<w:txbxContent>${para(run('a'))}</w:txbxContent>`))}</w:pict>`,
    ) +
      inRun(
        `<w:pict>${vmlShape('position:absolute;margin-left:5pt;width:10pt;height:10pt', VML_TEXTBOX(TXBX_CONTENTS[2]!))}</w:pict>`,
      ),
  ),
  paraOf(inRun('<w:pict><v:line from="0,0" to="100,0" style="position:absolute"/></w:pict>')),
  paraOf(
    inRun(
      '<w:pict>' +
        vmlShape('position:absolute;width:10pt;height:10pt', VML_TEXTBOX(TXBX_CONTENTS[0]!)) +
        '</w:pict>',
    ).replace('<w:pict>', '<w:pict><v:shapetype id="x" path="m,l,21600r21600,l21600,xe"/>'),
  ),
]
const ALL_BOX_PARAS = [...BOX_PARAS, ...PIC_PARAS, ...VML_BOX_PARAS]
const TEXTBOX_OPTS: Array<Record<string, unknown> | undefined> = [
  undefined,
  { shapes: true },
  { pictures: true },
  { shapes: true, pictures: true, firstPage: true },
]
const SECT_OPTS = [
  undefined,
  SECT,
  { ...SECT, columns: 2 },
  {
    ...SECT,
    pageWidth: 16838,
    pageHeight: 11906,
    orientation: 'landscape',
    marginLeft: 720,
    marginRight: 720,
    marginTop: 360,
  },
]

// ---------------------------------------------------------------- built media

const CONTENT_TYPES = (types: string): string =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types}</Types>`
const CT_PARTS: Array<[string, string]> = [
  [
    '[Content_Types].xml',
    CONTENT_TYPES(
      '<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="image/x-custom"/><Default Extension="dat" ContentType="text/plain"/><Override PartName="/word/media/x.bin" ContentType="image/jpeg"/><Override PartName="/word/media/y.dat" ContentType="image/gif"/>',
    ),
  ],
]
const IMAGE_PATHS = [
  'word/media/a.png',
  'word/media/A.PNG',
  'word/media/photo.JPG',
  'word/media/photo.jpeg',
  'word/media/anim.gif',
  'word/media/vec.svg',
  'word/media/vec.emf',
  'word/media/vec.wmf',
  'word/media/scan.tif',
  'word/media/scan.tiff',
  'word/media/x.bin',
  'word/media/y.dat',
  'word/media/z.bin',
  'word/media/noext',
  'word/media/a.b.c.png',
  'word/media/trailing.',
  'word/media/x.constructor',
  'word/media/x.__proto__',
  'word/media/x.toString',
  '',
]
const MEDIA_FILES: Array<Array<[string, string]>> = [
  [],
  [
    ['word/media/a.png', 'png bytes'],
    ['word/media/x.bin', 'bin'],
    ['word/media/image1.png', 'x'],
    ['word/media/vec.emf', 'emf'],
    ['word/media/scan.tif', 'tif'],
  ],
  [...MEDIA_PARTS.map(([name, text]) => [name, text] as [string, string])],
]
const CT_VARIANTS: Array<Array<[string, string]>> = [
  [],
  CT_PARTS,
  [['[Content_Types].xml', '<Types>']],
  [['[Content_Types].xml', CONTENT_TYPES('')]],
]

const embedDrawing = (attr: string): string =>
  `<w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip ${attr}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
const BLIP_XMLS = [
  embedDrawing('r:embed="rId1"'),
  embedDrawing('r:link="rId2"'),
  embedDrawing('r:embed="rId1" r:link="rId2"'),
  embedDrawing('r:link="rId2" r:embed="rId1"'),
  embedDrawing("r:embed = 'rId1'"),
  embedDrawing('r:embed="rId3"'),
  embedDrawing('r:embed="rId99"'),
  embedDrawing('r:embed="rId9"'),
  embedDrawing('r:embed=""'),
  embedDrawing(''),
  `<w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict>`,
  `<w:pict><v:shape><v:imagedata o:title="x" r:id="rId2"/></v:shape></w:pict>`,
  embedDrawing('r:embed="rId1"') + `<w:pict><v:imagedata r:id="rId2"/></w:pict>`,
  '<w:p/>',
  '',
]

const OLE_XMLS = [
  '<w:object w:dxaOrig="3000" w:dyaOrig="1500"><v:shape id="s" style="width:150pt;height:75pt" o:ole=""><v:imagedata r:id="rId1" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="s" DrawAspect="Content" r:id="rId3"/></w:object>',
  '<w:object w:dxaOrig="3000" w:dyaOrig="1500"><v:shape style="width:0pt;height:75.5pt"><v:imagedata r:id="rId2"/></v:shape><o:OLEObject ProgID="Word.Document.8"/></w:object>',
  '<w:object w:dxaOrig="x" w:dyaOrig="1500"><v:shape style="margin:0;width:10pt"><v:imagedata r:id="rId99"/></v:shape></w:object>',
  '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:object><v:shape style="height:20pt;width:30pt"><v:imagedata r:id="rId6"/></v:shape></w:object></w:r></w:p>',
  '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:object w:dxaOrig="1500" w:dyaOrig="750"><v:shape><v:imagedata r:id="rId1"/></v:shape></w:object></w:r></w:p>',
  '<w:p><w:pPr><w:jc w:val="end"/></w:pPr><w:object w:dxaOrig="15" w:dyaOrig="0"><v:shape style="width:-1pt"><v:imagedata r:id="rId7"/></v:shape></w:object></w:p>',
  '<w:p><w:pPr><w:jc w:val="left"/></w:pPr></w:p>',
  '',
]
const OLE_PARTS: Array<[string, string]> = [
  ['word/media/image1.png', 'png'],
  ['word/media/vec.emf', 'emf'],
  ['word/txbx 1.xml', '<x/>'],
  ['word/charts/chart2.xml', '<c/>'],
  ['word/media/image.emf', 'emf bytes'],
]
const OLE_RELS: Array<[string, RelInfo]> = [
  ...RELS.filter(([id]) => id !== 'rId7'),
  ['rId7', { target: 'media/image.emf', type: 'http://x/image' }],
]

const dgmDrawing = (rId: string, extent = '<wp:extent cx="3810000" cy="2540000"/>'): string =>
  `<w:drawing><wp:inline>${extent}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="${rId}" r:lo="rId31" r:qs="rId32" r:cs="rId33"/></a:graphicData></a:graphic></wp:inline></w:drawing>`
const DIAGRAM_RELS: Array<[string, RelInfo]> = [
  ['rId30', { target: 'diagrams/data1.xml', type: 'http://x/diagramData' }],
  ['rId31', { target: 'diagrams/layout1.xml', type: 'http://x/diagramLayout' }],
  ['rId34', { target: 'diagrams/data2.xml', type: 'http://x/diagramData' }],
  ['rId35', { target: 'diagrams/data3.xml', type: 'http://x/diagramData' }],
  [
    'rId36',
    { target: 'http://example.com/data.xml', type: 'http://x/diagramData', targetMode: 'External' },
  ],
]
const DGM_NS =
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const dgmPt = (id: string, text: string, type = ''): string =>
  `<dgm:pt modelId="${id}"${type ? ` type="${type}"` : ''}><dgm:prSet/><dgm:t><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`
const DIAGRAM_DATA = `<dgm:dataModel ${DGM_NS}><dgm:ptLst>${dgmPt('{R}', 'Root', 'doc')}${dgmPt('{A}', 'First &amp; best')}${dgmPt('{B}', 'Second &#65;')}${dgmPt('{C}', 'Third')}${dgmPt('{P}', 'pres', 'pres')}${dgmPt('{T}', 'trans', 'parTrans')}${dgmPt('{S}', 'sib', 'sibTrans')}${dgmPt('{I}', 'Isolated')}${dgmPt('{E}', '  ')}</dgm:ptLst><dgm:cxnLst><dgm:cxn modelId="{1}" srcId="{R}" destId="{B}" srcOrd="1" destOrd="0"/><dgm:cxn modelId="{2}" srcId="{R}" destId="{A}" srcOrd="0" destOrd="0" type="parOf"/><dgm:cxn modelId="{3}" srcId="{A}" destId="{C}" srcOrd="0"/><dgm:cxn modelId="{4}" srcId="{R}" destId="{P}" type="presOf" srcOrd="0"/><dgm:cxn srcId="{C}" destId="{R}" srcOrd="0"/><dgm:cxn srcId="" destId="{A}"/><dgm:cxn srcId="{A}"/></dgm:cxnLst></dgm:dataModel>`
const DIAGRAM_DATA_ISOLATED = `<dgm:dataModel ${DGM_NS}><dgm:ptLst>${dgmPt('{X}', 'one')}${dgmPt('{Y}', 'two')}</dgm:ptLst></dgm:dataModel>`
const DIAGRAM_DATA_EMPTY = `<dgm:dataModel ${DGM_NS}><dgm:ptLst>${dgmPt('{X}', '', 'pres')}</dgm:ptLst></dgm:dataModel>`
const dspShape = (
  x: number,
  y: number,
  cx: number,
  cy: number,
  xfrmAttrs: string,
  spPrTail: string,
  text = '',
): string =>
  `<dsp:sp modelId="{s${x}}"><dsp:spPr><a:xfrm${xfrmAttrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${spPrTail}</dsp:spPr>${text}</dsp:sp>`
const dspText = (
  text: string,
  rPr = ' sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr',
): string =>
  `<dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr${rPr}><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>  </a:t></a:r></a:p></dsp:txBody>`
const DIAGRAM_DRAWING = `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" ${DGM_NS}><dsp:spTree>${[
  dspShape(
    0,
    0,
    1905000,
    952500,
    '',
    '<a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="4F81BD"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln>',
    dspText('Hello &amp; &#9731;'),
  ),
  dspShape(
    1905000,
    0,
    1905000,
    952500,
    ' rot="5400000"',
    '<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:ln><a:noFill/></a:ln>',
  ),
  dspShape(
    0,
    952500,
    3810000,
    0,
    '',
    '<a:prstGeom prst="line"/><a:ln w="1000"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>',
  ),
  dspShape(10, 10, 0, 0, '', '<a:prstGeom prst="rect"/>'),
  dspShape(
    0,
    0,
    1000000,
    500000,
    '',
    '<a:prstGeom prst="bentConnector3"/><a:solidFill><a:schemeClr val="constructor"/></a:solidFill>',
  ),
  dspShape(
    0,
    1000000,
    1000000,
    500000,
    '',
    '<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect l="10000" t="-5000"/></a:stretch></a:blipFill>',
  ),
  dspShape(
    0,
    1000000,
    1000000,
    500000,
    '',
    '<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
  ),
  dspShape(0, 1000000, 1000000, 500000, '', '<a:blipFill><a:blip r:embed="rId3"/></a:blipFill>'),
  dspShape(0, 1000000, 1000000, 500000, '', '<a:blipFill><a:blip r:embed="rId4"/></a:blipFill>'),
  '<dsp:sp><dsp:txBody><a:p/></dsp:txBody></dsp:sp>',
  '<dsp:sp><dsp:spPr><a:prstGeom prst="rect"/></dsp:spPr></dsp:sp>',
].join('')}</dsp:spTree></dsp:drawing>`
const DIAGRAM_DRAWING_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://x/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="http://x/image" Target="http://example.com/a.png" TargetMode="External"/><Relationship Id="rId3" Type="http://x/image" Target="../media/vec.emf"/><Relationship Id="rId4" Type="http://x/image" Target="../media/missing.png"/></Relationships>`
const DIAGRAM_PARTS: Array<[string, string]> = [
  ['word/diagrams/data1.xml', DIAGRAM_DATA],
  ['word/diagrams/drawing1.xml', DIAGRAM_DRAWING],
  ['word/diagrams/_rels/drawing1.xml.rels', DIAGRAM_DRAWING_RELS],
  ['word/diagrams/data2.xml', DIAGRAM_DATA_ISOLATED],
  ['word/diagrams/drawing2.xml', '<dsp:drawing><dsp:spTree>' + '</dsp:spTree></dsp:drawing>'],
  ['word/diagrams/data3.xml', DIAGRAM_DATA_EMPTY],
  ['word/diagrams/layout1.xml', '<dgm:layoutDef/>'],
  ['word/media/image1.png', 'png'],
  ['word/media/vec.emf', 'emf'],
  [
    '[Content_Types].xml',
    CONTENT_TYPES(
      '<Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/>',
    ),
  ],
]
const DIAGRAM_XMLS = [
  dgmDrawing('rId30'),
  dgmDrawing('rId34'),
  dgmDrawing('rId35'),
  dgmDrawing('rId31'),
  dgmDrawing('rId36'),
  dgmDrawing('rId99'),
  dgmDrawing('rId30', '<wp:extent cx="0" cy="5"/>'),
  dgmDrawing('rId30', "<wp:extent cx = '952500' cy='x'/>"),
  dgmDrawing('rId34', '<wp:extent cx="100" cy="100"/>').replace(
    '<wp:inline>',
    '<wp:inline><wp:extent cx="9525" cy="9525"/>',
  ),
  dgmDrawing('rId30', ''),
  '<w:p/>',
  '',
]

const lockedChild = (
  tag: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  inner = '',
  spPr = '',
): string =>
  `<a:${tag}>${tag === 'pic' ? '<a:blipFill><a:blip r:embed="rId1"/></a:blipFill>' : ''}<a:spPr><a:xfrm${spPr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/>${inner}</a:spPr>${tag === 'sp' ? '' : ''}</a:${tag}>`
const lockedText = (text: string, sz: number): string =>
  `<a:txSp><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="${sz}"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></a:txBody></a:txSp>`
const canvas = (
  children: string,
  grp = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="3000000"/><a:chOff x="100" y="200"/><a:chExt cx="6000000" cy="3000000"/></a:xfrm>',
  extent = '<wp:extent cx="3000000" cy="1500000"/>',
): string =>
  `<w:drawing><wp:inline>${extent}<a:graphic><a:graphicData><lc:lockedCanvas xmlns:lc="http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas"><a:grpSpPr>${grp}</a:grpSpPr>${children}</lc:lockedCanvas></a:graphicData></a:graphic></wp:inline></w:drawing>`
const withText = (text: string, sz: number, x = 0, y = 0, cx = 1000000, cy = 400000): string =>
  `<a:sp><a:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:spPr>${lockedText(text, sz)}</a:sp>`
const CANVAS_XMLS = [
  canvas(
    lockedChild('sp', 100, 200, 1000000, 500000) +
      lockedChild('pic', 2000000, 1000000, 800000, 800000),
  ),
  canvas(withText('Hello', 1800) + withText('World', 2400, 1000000, 500000)),
  canvas(
    withText('overflowing text '.repeat(20), 6000, 0, 0, 200000, 100000) +
      withText('second column text '.repeat(10), 6000, 300000, 0, 200000, 100000) +
      withText('x', 9000, 600000, 0, 90000, 60000),
  ),
  canvas(
    withText('abc', 12000, 0, 0, 100000, 100000) + withText('de', 12000, 200000, 0, 100000, 100000),
  ),
  canvas(
    lockedChild('sp', 0, 0, 0, 100) +
      lockedChild('sp', 0, 0, 100, 0) +
      '<a:sp><a:spPr><a:xfrm><a:off x="0" y="0"/></a:xfrm></a:spPr></a:sp>',
  ),
  canvas(
    lockedChild('sp', 0, 0, 1000000, 500000, '<a:noFill/>') +
      lockedChild(
        'sp',
        0,
        0,
        1000000,
        500000,
        '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill>',
        ' rot="1800000"',
      ),
  ),
  canvas(
    lockedChild('sp', 0, 0, 1000000, 500000),
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>',
  ),
  canvas(
    lockedChild('sp', 0, 0, 1000000, 500000),
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/><a:chExt cx="0" cy="-5"/></a:xfrm>',
  ),
  canvas(lockedChild('sp', 0, 0, 1000000, 500000), ''),
  canvas(lockedChild('sp', 0, 0, 1000000, 500000), undefined, '<wp:extent cx="0" cy="1"/>'),
  canvas(lockedChild('sp', 0, 0, 1000000, 500000), undefined, ''),
  canvas(
    lockedChild('sp', 0, 0, 1000000, 500000),
    undefined,
    "<wp:extent cx = '2000000' cy='1000000'/><wp:extent cx='3000000' cy='3000000'/>",
  ),
  canvas(lockedChild('pic', 0, 0, 1000000, 500000)).replace('rId1', 'rId2'),
  canvas('<a:grpSp/>'),
  '<w:drawing><lc:lockedCanvas><a:sp/></lc:lockedCanvas>',
  '<w:drawing><wp:inline><wp:extent cx="5" cy="5"/><lc:lockedCanvas>',
  '<w:p/>',
  '',
]

const TABLE_DOCS = [
  `<w:document><w:body><w:tbl><w:tr><w:tc><w:p>${embedDrawing('r:embed="rId1"')}${embedDrawing('r:link="rId2"')}</w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  `<w:document><w:body><w:p>${embedDrawing('r:embed="rId1"')}</w:p><w:tbl><w:tr><w:tc><w:p><w:pict><v:imagedata r:id="rId1"/></w:pict>${embedDrawing('r:embed="rId99"')}${embedDrawing('r:embed="rId1"')}</w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  `<w:document><w:body><w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt><w:sdt><w:sdtContent><w:tbl><w:tr><w:tc><w:p><w:pict><v:imagedata r:id="rId3"/></w:pict></w:p></w:tc></w:tr></w:tbl><w:tbl><w:tr><w:tc><w:p>${embedDrawing('r:embed="rId2"')}${embedDrawing('r:embed="rId8"')}</w:p></w:tc></w:tr></w:tbl></w:sdtContent></w:sdt></w:body></w:document>`,
  `<w:document><w:body><w:tbl><w:tr><w:tc><w:p>${embedDrawing('r:embed="rId9"')}${embedDrawing("r:embed='rId1'")}</w:p></w:tc></w:tr></w:tbl><w:tbl/></w:body></w:document>`,
  '<w:document><w:body><w:p/></w:body></w:document>',
  '<w:document/>',
]
const TABLE_MEDIA_PARTS: Array<[string, string]> = [
  ['word/media/image1.png', 'png bytes'],
  ['word/media/vec.emf', 'emf'],
  ['[Content_Types].xml', CT_PARTS[0]![1]],
]

const NUMBERING_RELS = (targets: string): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets}</Relationships>`
const picBulletNumbering = (bullets: string, levels: string): string =>
  `<w:numbering ${WNS} xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${bullets}<w:abstractNum w:abstractNumId="1">${levels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
const PIC_BULLET = (id: string, rId: string, vml = true): string =>
  `<w:numPicBullet w:numPicBulletId="${id}"><w:pict>${vml ? `<v:shape><v:imagedata r:id="${rId}"/></v:shape>` : `<a:blip r:embed="${rId}"/>`}</w:pict></w:numPicBullet>`
const bulletLevel = (ilvl: number, picId: string): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:numFmt w:val="bullet"/><w:lvlText w:val="*"/><w:lvlPicBulletId w:val="${picId}"/></w:lvl>`
const PIC_BULLET_PACKAGES: Array<Array<[string, string]>> = [
  [
    [
      'word/numbering.xml',
      picBulletNumbering(
        PIC_BULLET('0', 'rId1') + PIC_BULLET('1', 'rId2', false),
        bulletLevel(0, '0') + bulletLevel(1, '1') + bulletLevel(2, '7'),
      ),
    ],
    [
      'word/_rels/numbering.xml.rels',
      NUMBERING_RELS(
        '<Relationship Id="rId1" Type="http://x/image" Target="media/image1.png"/><Relationship Id="rId2" Type="http://x/image" Target="http://example.com/a.png" TargetMode="External"/>',
      ),
    ],
    ['word/media/image1.png', 'png bytes'],
    ['[Content_Types].xml', CT_PARTS[0]![1]],
  ],
  [
    ['word/numbering.xml', picBulletNumbering(PIC_BULLET('3', 'rId5'), bulletLevel(0, '3'))],
    [
      'word/_rels/numbering.xml.rels',
      NUMBERING_RELS('<Relationship Id="rId5" Type="http://x/image" Target="../media/vec.emf"/>'),
    ],
    ['word/media/vec.emf', 'emf'],
  ],
  [['word/numbering.xml', picBulletNumbering(PIC_BULLET('0', 'rId1'), bulletLevel(0, '0'))]],
  [['word/numbering.xml', picBulletNumbering('', bulletLevel(0, '0'))]],
  [
    [
      'word/numbering.xml',
      picBulletNumbering(PIC_BULLET('0', 'rId1') + PIC_BULLET('0', 'rId2'), bulletLevel(0, '0')),
    ],
    [
      'word/_rels/numbering.xml.rels',
      NUMBERING_RELS(
        '<Relationship Id="rId2" Type="http://x/image" Target="media/b.png"/><Relationship Id="rId1" Type="http://x/image" Target="media/a.png"/>',
      ),
    ],
    ['word/media/a.png', 'a'],
    ['word/media/b.png', 'b'],
  ],
  [],
]

const HF_ANCHORS = [
  '<wp:anchor behindDoc="1"><wp:extent cx="2000000" cy="1000000"/><wp:wrapNone/></wp:anchor>',
  '<wp:anchor behindDoc="true"><wp:extent cx="0" cy="x"/><wp:wrapTopAndBottom/></wp:anchor>',
  '<wp:anchor><wp:extent cx="4762" cy="9525"/><wp:wrapTight/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:xfrm rot="5400000"/><a:ln w="19050"><a:solidFill><a:srgbClr val="ff0000"/></a:solidFill></a:ln></wps:spPr></wps:wsp></a:graphicData></a:graphic></wp:anchor>',
  '<wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:xfrm rot="0"/><a:ln w="0"><a:solidFill><a:srgbClr val="00ff00"/></a:solidFill></a:ln></wps:spPr></wps:wsp></a:graphicData></a:graphic><wp:wrapSquare/><wp:wrapThrough/></wp:anchor>',
  '<wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:xfrm rot="x"/><a:ln w="9525"/></wps:spPr></wps:wsp></a:graphicData></a:graphic><wp:wrapNone/></wp:anchor>',
  '<wp:anchor/>',
  '<wp:anchor behindDoc="0"/>',
  ...ANCHOR_FRAGS.filter((_, i) => i % 4 === 0),
]
const HF_VML_STYLES = [
  'position:absolute;margin-left:10pt;margin-top:20pt;width:200pt;height:100pt',
  'position:absolute;margin-left:-5.5pt;width:1in;height:2.54cm;z-index:-251658240;rotation:45',
  'position:absolute;mso-position-horizontal:center;mso-position-vertical:bottom;width:0;height:-5pt',
  'position:absolute;mso-position-horizontal:absolute;mso-position-horizontal-relative:page;margin-left:5mm;mso-position-vertical-relative:margin;margin-top:12px',
  'position:absolute;mso-position-horizontal-relative:text;mso-position-vertical-relative:paragraph;margin-top:1pc',
  'position:absolute;margin-left:x;margin-top:;width:abc',
  'position:absolute;rotation:-90;margin-left:  3pt',
  'position:absolute;mso-position-vertical-relative:line;margin-top:3pt;mso-position-horizontal:left',
  'position:absolute;mso-position-vertical:top;mso-position-horizontal:right;mso-position-horizontal-relative:right-margin-area',
  '',
]
const HF_VML_SHAPES = HF_VML_STYLES.flatMap((style) => [
  `<v:shape style="${style}"/>`,
  `<v:rect style="${style}" stroked="f"><w10:wrap type="topAndBottom"/></v:rect>`,
  `<v:shape style="${style}" strokecolor="#ff00aa" strokeweight="2.5pt"><v:stroke on="false"/><w10:wrap type="square"/></v:shape>`,
  `<v:roundrect style="${style}" strokecolor="red" strokeweight="1px"><w10:wrap type="tight"/></v:roundrect>`,
  `<v:oval style="${style}" stroked="0" strokecolor="#123456"><w10:wrap type="none"/></v:oval>`,
  `<v:shape style="${style}" strokeweight="zz"><w10:wrap type="through"/></v:shape>`,
])
const VML_INSET_TEXTBOXES = [
  '<v:textbox/>',
  '<v:textbox inset="0,0,0,0"/>',
  '<v:textbox inset="5pt,10pt"/>',
  '<v:textbox inset="1in,,3mm,4cm" style="mso-fit-shape-to-text:t"/>',
  '<v:textbox inset="x,1px,2pc,3"/>',
  '<v:textbox style="mso-fit-shape-to-text:f"/>',
  '<v:textbox style="mso-fit-shape-to-text: t;"/>',
  '<v:textbox inset=""/>',
  '<v:textbox inset=" 1pt , 2pt "/>',
  '<v:textbox inset="1,2,3,4,5,6"/>',
]
const HF_BOXES = [
  { id: 1 },
  { id: 2, widthPx: 10, autofit: false, insets: [1, 2, 3, 4] },
  { id: 3, vAlign: 'top', nowrap: false },
  { id: 4, autofit: true, insets: [9.6, 4.8, 9.6, 4.8] },
]

const FLOATING_PICTURES = [
  '<v:rect style="position:absolute"><v:imagedata r:id="rId1"/></v:rect>',
  '<v:group><v:shape style="position:absolute"><v:imagedata r:id="rId1"/></v:shape></v:group>',
  '<v:group><v:shape style="position:absolute"><v:textbox><w:txbxContent/></v:textbox></v:shape></v:group>',
  '<v:shape style="position: absolute"><v:fill/></v:shape>',
  '<w:pict><w:r><v:shape style="position:absolute;margin-left:0"><v:imagedata/></v:shape></w:r></w:pict>',
  '<w:pict><v:shape style="z-index:3;position:relative"/></w:pict>',
  '<w:pict><v:shape style="position:absolute"><w:r><w:txbxContent/></w:r></v:shape></w:pict>',
  '<w:p><w:r><w:t>text</w:t></w:r></w:p>',
  '<w:pict><v:shape xstyle="position:absolute"/><wp:anchor style="position:absolute"/></w:pict>',
  '<w:pict><v:textbox><v:rect style="position:absolute"/></v:textbox></w:pict>',
  '',
]
const STROKE_SHAPES = [
  '<v:shape><v:stroke on="f"/></v:shape>',
  '<v:shape><v:stroke on="false"/></v:shape>',
  '<v:shape><v:stroke on="0"/></v:shape>',
  '<v:shape><v:stroke on="t"/></v:shape>',
  '<v:shape><v:stroke on="1"/></v:shape>',
  '<v:shape><v:stroke/></v:shape>',
  '<v:shape><v:fill/></v:shape>',
  '<v:shape><v:fill><v:stroke on="f"/></v:fill></v:shape>',
  '<v:shape><v:stroke weight="1pt"/><v:stroke on="f"/></v:shape>',
  '<v:shape/>',
  '',
]
const DEEP_NODES = [
  '<w:p><w:r><w:drawing/></w:r></w:p>',
  '<w:p><w:r><w:txbxContent/></w:r></w:p>',
  '<v:shape><v:textbox><w:txbxContent/></v:textbox></v:shape>',
  '<w:r><w:pict><v:imagedata/></w:pict></w:r>',
  '<w:r/>',
  '<w:txbxContent/>',
  '',
]
const DEEP_NAMES = [['w:txbxContent'], ['w:drawing', 'v:imagedata'], [], ['w:r'], ['nope']]

const ANCHOR_DRAWINGS: string[] = [
  ...ANCHOR_FRAGS.map((frag) => `<w:drawing>${frag}</w:drawing>`),
  ...WRAPS.flatMap((wrap) =>
    POS_H.flatMap((posH, i) =>
      POS_V.filter((_, j) => (i + j) % 2 === 0).map(
        (posV) =>
          `<w:drawing><wp:anchor behindDoc="0" distT="1" distB="22" distL="333" distR="4444" relativeHeight="251658241" allowOverlap="0" locked="true"><wp:simplePos x="0" y="0"/>${posH}${posV}<wp:extent cx="2000000" cy="1000000"/>${wrap}<a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm rot="5400000" flipH="1"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`,
      ),
    ),
  ),
  ...ATTRS.map(
    (attrs) =>
      `<w:drawing><wp:anchor ${attrs ?? ''}>${POS_H[2]}${POS_V[1]}<wp:extent cx="95250" cy="95250"/></wp:anchor></w:drawing>`,
  ),
  '<w:drawing><wp:anchor behindDoc="1"><wp:wrapTight/></wp:anchor></w:drawing>',
  '<w:drawing><wp:anchor behindDoc="1"><wp:wrapNone/></wp:anchor></w:drawing>',
  '<w:drawing><wp:anchor><wp:positionV relativeFrom="line"><wp:align>center</wp:align></wp:positionV></wp:anchor></w:drawing>',
  '<w:drawing><wp:anchor><wp:positionV relativeFrom="line"> <wp:align>center</wp:align></wp:positionV></wp:anchor></w:drawing>',
  '<w:drawing><wp:anchorX/></w:drawing>',
  '<w:drawing><wp:inline distT="0"><wp:extent cx="95250" cy="95250"/><wp:effectExtent l="0" t="38100" r="0" b="19050"/></wp:inline></w:drawing>',
  '<w:drawing><wp:inline><wp:effectExtent t="x" b="0"/></wp:inline></w:drawing>',
  '',
]
const HOST_PARAS = [
  (drawing: string): string => drawing,
  (drawing: string): string => `<w:p><w:r>${drawing}</w:r></w:p>`,
  (drawing: string): string =>
    `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:left="720" w:right="360" w:firstLine="200"/><w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="MS Mincho"/><w:sz w:val="28"/></w:rPr><w:t>lead</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">   </w:t></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">  </w:t></w:r><w:r>${drawing}</w:r></w:p>`,
  (drawing: string): string =>
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="right"/><w:spacing w:beforeAutospacing="1" w:afterAutospacing="1"/><w:ind w:leftChars="100"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr><w:t>x</w:t></w:r><w:r>${drawing}</w:r></w:p>`,
  (drawing: string): string =>
    `<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:rPr><w:sz w:val="36"/><w:rFonts w:eastAsia="SimSun"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times"/></w:rPr><w:tab/><w:t>y</w:t></w:r><w:r>${drawing}</w:r></w:p>`,
  (drawing: string): string =>
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>a</w:t></w:r><w:r>${drawing}</w:r><w:r><w:t>after</w:t></w:r></w:p>`,
  (drawing: string): string =>
    `<w:p><w:r><w:pict><v:shape style="width:10pt"/></w:pict></w:r><w:r>${drawing}</w:r></w:p>`,
  (drawing: string): string => `<w:p><w:r><w:tab></w:tab></w:r><w:r>${drawing}</w:r></w:p>`,
]
const IMAGE_META_XMLS = ANCHOR_DRAWINGS.flatMap((drawing, i) => [
  HOST_PARAS[0]!(drawing),
  HOST_PARAS[1 + (i % (HOST_PARAS.length - 1))]!(drawing),
])
const PIC_EFFECT_DRAWINGS = [
  embedDrawing('r:embed="rId1"').replace(
    '<a:blip r:embed="rId1"/>',
    '<a:blip r:embed="rId1"><a:lum bright="70000" contrast="-70000"/><a:grayscl/><a:biLevel thresh="25000"/></a:blip><a:srcRect l="12500" t="-3000" r="0" b="99999.5"/><a:stretch><a:fillRect l="1000" t="2000"/></a:stretch>',
  ),
  embedDrawing('r:embed="rId1"').replace(
    '<a:blip r:embed="rId1"/>',
    '<a:blip r:embed="rId1"><a:biLevel/></a:blip><a:srcRect l="0"/><a:stretch><a:fillRect/></a:stretch>',
  ),
  embedDrawing('r:embed="rId1"').replace(
    '<a:blip r:embed="rId1"/>',
    '<a:blip r:embed="rId1"/><a:srcRect l="5"/>',
  ) + '<a:blip><a:grayscl/></a:blip>',
  embedDrawing('r:embed="rId1"').replace(
    '<a:blip r:embed="rId1"/>',
    '<a:blip r:embed="rId1"><a:lum/><a:grayscale/></a:blip>',
  ),
  '<a:blip/><a:blip r:embed="rId1"><a:grayscl/></a:blip>',
  '<a:blip r:embed="rId1"><a:lum bright="abc" contrast=".5"></a:lum></a:blip>',
  ...PIC_XMLS.map(
    (xml) =>
      `<w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/>${xml}</wp:inline></w:drawing>`,
  ),
]
const IMAGE_META_ALL = [
  ...IMAGE_META_XMLS,
  ...PIC_EFFECT_DRAWINGS.flatMap((drawing, i) => [
    drawing,
    HOST_PARAS[1 + (i % (HOST_PARAS.length - 1))]!(drawing),
  ]),
]

const COLUMN_METAS = [
  { imageWrap: 'square-left', imageWidthPx: 96, imageOffsetXEmu: 100000 },
  {
    imageWrap: 'tight-right',
    imageWidthPx: 200,
    imageHeightPx: 100,
    imageRotDeg: 90,
    imageWrapDistLeftEmu: 114300,
    imageWrapDistRightEmu: 114300,
  },
  {
    imageWrap: 'through-left',
    imageWidthPx: 50,
    imageHeightPx: 50,
    imageRotDeg: 270,
    imageWrapDistLeftEmu: 12700,
    imageWrapDistRightEmu: 25400,
    imageOffsetXEmu: -500000,
  },
  { imageWrap: 'square-right', imageWidthPx: 600, imageOffsetXEmu: 0 },
  {
    imageWrap: 'square-left',
    imageWidthPx: 400,
    imageOffsetXEmu: 300000,
    imageHeightPx: 0,
    imageRotDeg: 180,
  },
  { imageWrap: 'square-left', imageWidthPx: 700, imageOffsetXEmu: 0 },
  { imageWrap: 'tight-right', imageWidthPx: 100, imageOffsetXEmu: -3000000 },
  {
    imageWrap: 'square-left',
    imageWidthPx: 650,
    imageOffsetXEmu: -300000,
    imageWrapDistLeftEmu: 5000000,
  },
  {
    imageWrap: 'through-right',
    imageWidthPx: 400,
    imageHeightPx: 700,
    imageRotDeg: 90,
    imageOffsetXEmu: 2000000,
  },
  { imageWrap: 'topBottom', imageWidthPx: 96 },
  { imageWrap: 'square-left', imageWidthPx: 0 },
  { imageWrap: 'square-right', imageHeightPx: 10 },
  {},
]
const FLOAT_TABLES = [
  { leftTwips: 0, rightTwips: 2000 },
  { leftTwips: 8000, rightTwips: 9000 },
  { leftTwips: 12000, rightTwips: 20000 },
  { leftTwips: 0, rightTwips: 100000 },
  { leftTwips: -100, rightTwips: 0 },
  { leftTwips: 1500, rightTwips: 1500 },
]
const META_FRAGS = ANCHOR_FRAGS.filter((_, i) => i % 3 === 0)

/** `{ meta }` of a captured ImageMeta: the model keys, without the `imageNoOverlap` no Block holds. */
const metaArg = (meta: unknown): Record<string, unknown> | undefined => {
  if (!isObject(meta)) return undefined
  const { imageNoOverlap: _unread, ...block } = meta
  return copy(block)
}

/** A context without `mediaByRid`. */
const withoutMedia = (args: Record<string, unknown>): Record<string, unknown> => {
  const { mediaByRid: _unused, ...rest } = args
  return rest
}

const BATCH2: CallSpec[] = [
  {
    fn: 'parse.imagePartMime',
    call: async (_text, args) => internals.imagePartMime!(await loadedZip(args.parts), args.path),
    fromParse: {
      fn: 'imagePartMime',
      input: ([, path], parts) =>
        typeof path === 'string'
          ? { args: { parts: partsNamed(parts, '[Content_Types].xml'), path } }
          : undefined,
    },
    built: CT_VARIANTS.flatMap((ct) => IMAGE_PATHS.map((path) => ({ args: { parts: ct, path } }))),
    mutation: 'none',
  },
  {
    fn: 'parse.pictureColumnGeom',
    call: (text, args) => internals.pictureColumnGeom!(args.meta, text, args.sect),
    fromParse: {
      fn: 'pictureColumnGeom',
      input: ([meta, xml, sect]) => {
        const block = metaArg(meta)
        if (!block || typeof xml !== 'string' || (sect !== undefined && !isObject(sect)))
          return undefined
        return {
          text: xml,
          args: { meta: block, ...(sect === undefined ? {} : { sect: copy(sect) }) },
        }
      },
    },
    built: META_FRAGS.flatMap((text) =>
      COLUMN_METAS.flatMap((meta) =>
        SECT_OPTS.map((sect) => ({
          text,
          args: { meta, ...(sect === undefined ? {} : { sect }) },
        })),
      ),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.pictureBesideFloatTable',
    call: (text, args) =>
      internals.pictureBesideFloatTable!(args.meta, text, args.table, args.sect),
    fromParse: {
      fn: 'pictureBesideFloatTable',
      input: ([meta, xml, table, sect]) => {
        const block = metaArg(meta)
        if (
          !block ||
          typeof xml !== 'string' ||
          !isObject(table) ||
          (sect !== undefined && !isObject(sect))
        )
          return undefined
        return {
          text: xml,
          args: {
            meta: block,
            table: copy(table),
            ...(sect === undefined ? {} : { sect: copy(sect) }),
          },
        }
      },
    },
    built: META_FRAGS.filter((_, i) => i % 2 === 0).flatMap((text) =>
      COLUMN_METAS.flatMap((meta) =>
        FLOAT_TABLES.flatMap((table) =>
          SECT_OPTS.map((sect) => ({
            text,
            args: { meta, table, ...(sect === undefined ? {} : { sect }) },
          })),
        ),
      ),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.pictureOverhangsColumn',
    call: (text, args) => internals.pictureOverhangsColumn!(args.meta, text, args.sect),
    fromParse: {
      fn: 'pictureOverhangsColumn',
      input: ([meta, xml, sect]) => {
        const block = metaArg(meta)
        if (!block || typeof xml !== 'string' || (sect !== undefined && !isObject(sect)))
          return undefined
        return {
          text: xml,
          args: { meta: block, ...(sect === undefined ? {} : { sect: copy(sect) }) },
        }
      },
    },
    built: META_FRAGS.flatMap((text) =>
      COLUMN_METAS.flatMap((meta) =>
        SECT_OPTS.map((sect) => ({
          text,
          args: { meta, ...(sect === undefined ? {} : { sect }) },
        })),
      ),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.vmlStrokeChildOff',
    call: (text) => internals.vmlStrokeChildOff!(nodeOf(text)),
    fromParse: {
      fn: 'vmlStrokeChildOff',
      input: ([shape]) => (isNode(shape) ? { text: serializeXNode(shape) } : undefined),
    },
    built: STROKE_SHAPES.map((text) => ({ text })),
  },
  {
    fn: 'parse.hasDeepChild',
    call: (text, args) => internals.hasDeepChild!(nodeOf(text), new Set(args.names as string[])),
    fromParse: {
      fn: 'hasDeepChild',
      input: ([node, names]) =>
        isNode(node) && names instanceof Set
          ? { text: serializeXNode(node), args: { names: [...names] } }
          : undefined,
    },
    built: DEEP_NODES.flatMap((text) => DEEP_NAMES.map((names) => ({ text, args: { names } }))),
  },
  {
    fn: 'parse.hasFloatingVmlPicture',
    call: (text) => internals.hasFloatingVmlPicture!(nodeOf(text)),
    fromParse: {
      fn: 'hasFloatingVmlPicture',
      input: ([node]) => (isNode(node) ? { text: serializeXNode(node) } : undefined),
    },
    built: [...FLOATING_PICTURES, ...FLOATING_VML, ...DEEP_NODES].map((text) => ({ text })),
  },
  {
    fn: 'parse.hfTextBoxOfAnchor',
    call: (text) => {
      // the id is the count of the boxes the process built: the two sides do not share it
      const { id: _id, ...box } = internals.hfTextBoxOfAnchor!(nodeOf(text)) as Record<
        string,
        unknown
      >
      return box
    },
    fromParse: {
      fn: 'hfTextBoxOfAnchor',
      input: ([anchor]) => (isNode(anchor) ? { text: serializeXNode(anchor) } : undefined),
    },
    built: HF_ANCHORS.map((text) => ({ text })),
  },
  {
    fn: 'parse.hfTextBoxOfVml',
    call: (text) => {
      const { id: _id, ...box } = internals.hfTextBoxOfVml!(nodeOf(text)) as Record<string, unknown>
      return box
    },
    fromParse: {
      fn: 'hfTextBoxOfVml',
      input: ([shape]) => (isNode(shape) ? { text: serializeXNode(shape) } : undefined),
    },
    built: [...HF_VML_SHAPES, ...STROKE_SHAPES].map((text) => ({ text })),
  },
  {
    fn: 'parse.readVmlInset',
    call: (text, args) => {
      const box = copy(args.box)
      internals.readVmlInset!(nodeOf(text), box)
      return box
    },
    fromParse: {
      fn: 'readVmlInset',
      input: ([textbox, box]) =>
        isNode(textbox) && isObject(box)
          ? { text: serializeXNode(textbox), args: { box: copy(box) } }
          : undefined,
    },
    built: VML_INSET_TEXTBOXES.flatMap((text) => HF_BOXES.map((box) => ({ text, args: { box } }))),
    argMutation: true,
  },
  {
    fn: 'parse.blipEffectsOf',
    call: (text) => internals.blipEffectsOf!(text),
    fromParse: {
      fn: 'blipEffectsOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: PIC_EFFECT_DRAWINGS.map((text) => ({ text })),
  },
  {
    fn: 'parse.runPictureAnchorOf',
    call: (text) => internals.runPictureAnchorOf!(text),
    fromParse: {
      fn: 'runPictureAnchorOf',
      input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined),
    },
    built: [...ANCHOR_DRAWINGS, ...PIC_EFFECT_DRAWINGS].map((text) => ({ text })),
  },
  {
    fn: 'parse.imageMeta',
    call: async (text, args) =>
      internals.imageMeta!(text, args.parts === undefined ? undefined : await buildCtx(args)),
    fromParse: {
      fn: 'imageMeta',
      input: ([xml, ctx], parts) =>
        ctx === undefined
          ? typeof xml === 'string'
            ? { text: xml }
            : undefined
          : ctxInput('imageMeta', parts, xml, ctx),
    },
    built: [
      ...IMAGE_META_ALL.filter((_, i) => i % 3 === 0).map((text) => ({ text })),
      ...IMAGE_META_ALL.flatMap((text, i) =>
        [CTX_VARIANTS[i % CTX_VARIANTS.length]!, CTX_VARIANTS[(i + 3) % CTX_VARIANTS.length]!].map(
          (args) => ({ text, args }),
        ),
      ),
    ],
  },
  {
    fn: 'parse.readMediaPartDataUrl',
    call: async (_text, args) =>
      internals.readMediaPartDataUrl!(await loadedZip(args.parts), args.partPath),
    fromParse: {
      fn: 'readMediaPartDataUrl',
      input: ([, partPath], parts) => {
        const text = typeof partPath === 'string' ? parts.get(partPath) : undefined
        return typeof partPath === 'string'
          ? {
              args: {
                parts: [
                  ...(text === undefined ? [] : [[partPath, text] as [string, string]]),
                  ...partsNamed(parts, '[Content_Types].xml'),
                ],
                partPath,
              },
            }
          : undefined
      },
    },
    built: MEDIA_FILES.flatMap((files) =>
      CT_VARIANTS.flatMap((ct) =>
        [
          'word/media/a.png',
          'word/media/x.bin',
          'word/media/vec.emf',
          'word/media/scan.tif',
          'word/media/image1.png',
          'word/media/missing.png',
          'word/media/ä b#1.png',
          'word/media/image6.svg',
          'word/media/text.svg',
          'word/media/empty.png',
        ].map((partPath) => ({ args: { parts: [...files, ...ct], partPath } })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.mediaPartDataUrl',
    call: async (_text, args) =>
      internals.mediaPartDataUrl!(await loadedZip(args.parts), args.partPath),
    fromParse: {
      fn: 'mediaPartDataUrl',
      input: ([, partPath], parts) => {
        const text = typeof partPath === 'string' ? parts.get(partPath) : undefined
        return typeof partPath === 'string'
          ? {
              args: {
                parts: [
                  ...(text === undefined ? [] : [[partPath, text] as [string, string]]),
                  ...partsNamed(parts, '[Content_Types].xml'),
                ],
                partPath,
              },
            }
          : undefined
      },
    },
    built: MEDIA_FILES.flatMap((files) =>
      CT_VARIANTS.flatMap((ct) =>
        [
          'word/media/a.png',
          'word/media/x.bin',
          'word/media/vec.emf',
          'word/media/scan.tif',
          'word/media/image1.png',
          'word/media/missing.png',
          'word/media/ä b#1.png',
          'word/media/image6.svg',
          'word/media/text.svg',
          'word/media/empty.png',
        ].map((partPath) => ({ args: { parts: [...files, ...ct], partPath } })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.mediaDataUrl',
    call: async (_text, args) =>
      internals.mediaDataUrl!(
        await loadedZip(args.parts),
        new Map(args.rels as Array<[string, RelInfo]>),
        args.rId,
        ...(args.sourcePath !== undefined ? [args.sourcePath] : []),
      ),
    fromParse: {
      fn: 'mediaDataUrl',
      input: ([, rels, rId, sourcePath], parts) => {
        const entries = relsEntries(rels)
        if (
          !entries ||
          typeof rId !== 'string' ||
          (sourcePath !== undefined && typeof sourcePath !== 'string')
        )
          return undefined
        return {
          args: {
            parts: [
              ...relPart(parts, rels as Map<string, RelInfo>, rId, sourcePath),
              ...partsNamed(parts, '[Content_Types].xml'),
            ],
            rels: entries,
            rId,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
          },
        }
      },
    },
    built: MEDIA_FILES.flatMap((files) =>
      [...RELS.map(([id]) => id), 'rId99'].flatMap((rId) =>
        [undefined, 'word/sub/document.xml', 'word/header1.xml'].map((sourcePath) => ({
          args: {
            parts: [...files, ...CT_PARTS],
            rels: OLE_RELS,
            rId,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
          },
        })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.extractImage',
    call: async (text, args) => internals.extractImage!(text, await buildCtx(args)),
    fromParse: {
      fn: 'extractImage',
      input: ([xml, ctx], parts) => ctxInput('extractImage', parts, xml, ctx),
    },
    built: BLIP_XMLS.flatMap((text) =>
      [undefined, 'word/sub/document.xml'].flatMap((sourcePath) =>
        MEDIA_FILES.slice(0, 2).map((files) => ({
          text,
          args: bodyCtx({
            extra: [...files, ...CT_PARTS],
            ...(sourcePath !== undefined ? { sourcePath } : {}),
            rels: OLE_RELS,
          }),
        })),
      ),
    ),
  },
  {
    fn: 'parse.resolvePicBullets',
    call: async (_text, args) => {
      const zip = await loadedZip(args.parts)
      const { defs, picBullets } = await parseNumbering(zip)
      await internals.resolvePicBullets!(zip, defs, picBullets)
      return defs
    },
    fromParse: {
      fn: 'resolvePicBullets',
      input: ([, numbering, picBullets], parts) => {
        if (!(numbering instanceof Map) || !(picBullets instanceof Map) || picBullets.size === 0)
          return undefined
        const relsText = parts.get('word/_rels/numbering.xml.rels') ?? ''
        const targets = [...relsText.matchAll(/Target="([^"]+)"/g)].flatMap((m) => {
          const path = resolveRelationshipTargetPath('word/numbering.xml', m[1]!)
          return path ? partsNamed(parts, path) : []
        })
        return {
          args: {
            parts: [
              ...partsNamed(
                parts,
                'word/numbering.xml',
                'word/_rels/numbering.xml.rels',
                '[Content_Types].xml',
              ),
              ...targets,
            ],
          },
        }
      },
    },
    built: PIC_BULLET_PACKAGES.map((parts) => ({ args: { parts } })),
    mutation: 'none',
  },
  {
    fn: 'parse.tableBlipMedia',
    call: async (text, args) => {
      const zip = await loadedZip(args.parts)
      const elements = scanBody(text).elements
      return internals.tableBlipMedia!(
        elements,
        text,
        zip,
        new Map(args.rels as Array<[string, RelInfo]>),
        ...(args.sourcePath !== undefined ? [args.sourcePath] : []),
      )
    },
    fromParse: {
      fn: 'tableBlipMedia',
      input: ([elements, documentXml, , rels, sourcePath], parts) => {
        const entries = relsEntries(rels)
        if (
          !Array.isArray(elements) ||
          typeof documentXml !== 'string' ||
          !entries ||
          (sourcePath !== undefined && typeof sourcePath !== 'string')
        )
          return undefined
        // only the tables and controls are read: the document is cut to them
        const slices = (elements as Array<{ name: string; start: number; end: number }>)
          .filter((element) => element.name === 'w:tbl' || element.name === 'w:sdt')
          .map((element) => documentXml.slice(element.start, element.end))
        const text = `<w:document><w:body>${slices.join('')}</w:body></w:document>`
        if (text.length > 200_000) return undefined
        const ids = [
          ...text.matchAll(
            /<a:blip[^>]*r:(?:embed|link)\s*=\s*["']([^"']+)["']|<v:imagedata[^>]*r:id\s*=\s*["']([^"']+)["']/g,
          ),
        ].map((m) => m[1] ?? m[2]!)
        const named = ids.flatMap((rId) =>
          relPart(parts, rels as Map<string, RelInfo>, rId, sourcePath),
        )
        return {
          text,
          args: {
            parts: [...new Map([...named, ...partsNamed(parts, '[Content_Types].xml')])],
            rels: entries,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
          },
        }
      },
    },
    built: TABLE_DOCS.flatMap((text) =>
      [undefined, 'word/sub/document.xml'].map((sourcePath) => ({
        text,
        args: {
          parts: TABLE_MEDIA_PARTS,
          rels: OLE_RELS,
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        },
      })),
    ),
  },
  {
    fn: 'parse.resolveBlipMedia',
    call: async (text, args) => {
      const ctx = await buildCtx(args)
      await internals.resolveBlipMedia!(text, ctx)
      return { mediaByRid: ctx.mediaByRid instanceof Map ? [...ctx.mediaByRid] : undefined }
    },
    fromParse: {
      fn: 'resolveBlipMedia',
      input: ([xml, ctx], parts) =>
        isObject(ctx) && ctx.mediaByRid instanceof Map
          ? ctxInput('resolveBlipMedia', parts, xml, ctx)
          : undefined,
    },
    built: BLIP_XMLS.flatMap((text) =>
      [[], [['rId1', 'known']]].flatMap((mediaByRid) =>
        MEDIA_FILES.slice(0, 2).map((files) => ({
          text,
          args: bodyCtx({ extra: [...files, ...CT_PARTS], mediaByRid, rels: OLE_RELS }),
        })),
      ),
    ).concat(
      BLIP_XMLS.slice(0, 4).map((text) => ({
        text,
        args: withoutMedia(bodyCtx({ extra: MEDIA_FILES[1]!, rels: OLE_RELS })),
      })),
    ),
  },
  {
    fn: 'parse.hasResolvablePicture',
    call: async (text, args) => {
      const ctx = await buildCtx(args)
      const found = await internals.hasResolvablePicture!(text, ctx)
      return {
        value: found,
        mediaByRid: ctx.mediaByRid instanceof Map ? [...ctx.mediaByRid] : undefined,
      }
    },
    fromParse: {
      fn: 'hasResolvablePicture',
      input: ([xml, ctx], parts) =>
        isObject(ctx) ? ctxInput('hasResolvablePicture', parts, xml, ctx) : undefined,
    },
    built: BLIP_XMLS.flatMap((text) =>
      [[], [['rId2', 'known']]].flatMap((mediaByRid) =>
        MEDIA_FILES.slice(0, 2).map((files) => ({
          text,
          args: bodyCtx({ extra: [...files, ...CT_PARTS], mediaByRid, rels: OLE_RELS }),
        })),
      ),
    ).concat(
      BLIP_XMLS.slice(0, 4).map((text) => ({
        text,
        args: withoutMedia(bodyCtx({ extra: MEDIA_FILES[1]!, rels: OLE_RELS })),
      })),
    ),
  },
  {
    fn: 'parse.oleDisplay',
    call: async (text, args) => internals.oleDisplay!(text, await buildCtx(args)),
    fromParse: {
      fn: 'oleDisplay',
      input: ([xml, ctx], parts) => ctxInput('oleDisplay', parts, xml, ctx),
    },
    built: OLE_XMLS.flatMap((text) =>
      [undefined, 'word/sub/document.xml'].map((sourcePath) => ({
        text,
        args: bodyCtx({
          extra: [...OLE_PARTS, ...CT_PARTS],
          rels: OLE_RELS,
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        }),
      })),
    ),
  },
  {
    fn: 'parse.extractDiagramText',
    call: async (text, args) => internals.extractDiagramText!(text, await buildCtx(args)),
    fromParse: {
      fn: 'extractDiagramText',
      input: ([xml, ctx], parts) => ctxInput('extractDiagramText', parts, xml, ctx),
    },
    built: DIAGRAM_XMLS.map((text) => ({
      text,
      args: bodyCtx({ extra: DIAGRAM_PARTS, rels: DIAGRAM_RELS }),
    })),
  },
  {
    fn: 'parse.extractLockedCanvas',
    call: async (text, args) => internals.extractLockedCanvas!(text, await buildCtx(args)),
    fromParse: {
      fn: 'extractLockedCanvas',
      input: ([xml, ctx], parts) => ctxInput('extractLockedCanvas', parts, xml, ctx),
    },
    built: CANVAS_XMLS.flatMap((text) =>
      [bodyCtx({ mediaByRid: MEDIA_URLS }), withoutMedia(bodyCtx())].map((args) => ({
        text,
        args,
      })),
    ),
  },
  {
    fn: 'parse.extractDiagramDrawing',
    call: async (text, args) => internals.extractDiagramDrawing!(text, await buildCtx(args)),
    fromParse: {
      fn: 'extractDiagramDrawing',
      input: ([xml, ctx], parts) => ctxInput('extractDiagramDrawing', parts, xml, ctx),
    },
    built: DIAGRAM_XMLS.flatMap((text) =>
      [
        DIAGRAM_PARTS,
        DIAGRAM_PARTS.filter(([name]) => !name.includes('image1')),
        DIAGRAM_PARTS.filter(([name]) => !name.endsWith('.rels')),
      ].map((extra) => ({
        text,
        args: bodyCtx({ extra, rels: DIAGRAM_RELS }),
      })),
    ),
  },
  {
    fn: 'parse.paragraphStrayBox',
    call: async (text, args) => internals.paragraphStrayBox!(text, await buildCtx(args)),
    fromParse: {
      fn: 'paragraphStrayBox',
      input: ([xml, ctx], parts) => ctxInput('paragraphStrayBox', parts, xml, ctx),
    },
    built: STRAY_PARAS.flatMap((text, i) =>
      [CTX_VARIANTS[i % CTX_VARIANTS.length]!, CTX_VARIANTS[(i + 1) % CTX_VARIANTS.length]!].map(
        (args) => ({ text, args }),
      ),
    ),
  },
  {
    fn: 'parse.textboxParagraphs',
    call: async (text, args) => {
      const paras = internals.textboxParagraphs!(nodeOf(text), await buildCtx(args)) as Array<{
        box?: { id?: number }
      }>
      renumberBoxIds(paras)
      return paras
    },
    fromParse: {
      fn: 'textboxParagraphs',
      input: ([node, ctx], parts) => ctxNodeInput('textboxParagraphs', parts, node, ctx),
    },
    built: [...ALL_BOX_PARAS, ...STRAY_PARAS].flatMap((text, i) =>
      [CTX_VARIANTS[i % CTX_VARIANTS.length]!, CTX_VARIANTS[(i + 4) % CTX_VARIANTS.length]!].map(
        (args) => ({ text, args }),
      ),
    ),
  },
  {
    fn: 'parse.txbxTableParas',
    call: async (text, args) => internals.txbxTableParas!(nodeOf(text), await buildCtx(args)),
    fromParse: {
      fn: 'txbxTableParas',
      input: ([tbl, ctx], parts) => ctxNodeInput('txbxTableParas', parts, tbl, ctx),
    },
    built: TXBX_TABLES().flatMap((text, i) =>
      [CTX_VARIANTS[i % CTX_VARIANTS.length]!, CTX_VARIANTS[(i + 3) % CTX_VARIANTS.length]!].map(
        (args) => ({ text, args }),
      ),
    ),
  },
  {
    fn: 'parse.collectTxbxParas',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => {
      const out: Array<{ para?: unknown }> = []
      const items: Array<{ para: unknown; ref: unknown; textSizeHalf: number }> = []
      internals.collectTxbxParas!(nodeOf(text), await buildCtx(args), args.docOffset, out, items)
      return {
        out,
        listItems: items.map((item) => ({
          index: out.indexOf(item.para as never),
          listRef: item.ref,
          textSizeHalf: item.textSizeHalf,
        })),
      }
    },
    fromParse: {
      fn: 'collectTxbxParas',
      input: ([content, ctx, docOffset], parts) =>
        docOffset === undefined || typeof docOffset === 'number'
          ? ctxNodeInput(
              'collectTxbxParas',
              parts,
              content,
              ctx,
              docOffset === undefined ? {} : { docOffset },
            )
          : undefined,
    },
    built: TXBX_CONTENTS.flatMap((text, i) =>
      [CTX_VARIANTS[i % CTX_VARIANTS.length]!, CTX_VARIANTS[(i + 1) % CTX_VARIANTS.length]!].map(
        (args) => ({ text, args: { ...args, ...(i % 2 === 0 ? { docOffset: 100 } : {}) } }),
      ),
    ),
  },
  {
    fn: 'parse.txbxContentParas',
    listed: lineRuleOutsideItsType,
    call: async (text, args) =>
      internals.txbxContentParas!(nodeOf(text), await buildCtx(args), args.docOffset),
    fromParse: {
      fn: 'txbxContentParas',
      input: ([content, ctx, docOffset], parts) =>
        docOffset === undefined || typeof docOffset === 'number'
          ? ctxNodeInput(
              'txbxContentParas',
              parts,
              content,
              ctx,
              docOffset === undefined ? {} : { docOffset },
            )
          : undefined,
    },
    built: TXBX_CONTENTS.flatMap((text, i) =>
      CTX_VARIANTS.map((args, j) => ({
        text,
        args: { ...args, ...((i + j) % 2 === 0 ? { docOffset: 100 } : {}) },
      })),
    ),
  },
  {
    fn: 'parse.extractTextboxes',
    call: async (text, args) => internals.extractTextboxes!(text, await buildCtx(args), args.opts),
    fromParse: {
      fn: 'extractTextboxes',
      input: ([xml, ctx, opts], parts) => {
        if (opts !== undefined && !isObject(opts)) return undefined
        return ctxInput(
          'extractTextboxes',
          parts,
          xml,
          ctx,
          opts === undefined ? {} : { opts: copy(opts) },
        )
      },
    },
    built: ALL_BOX_PARAS.flatMap((text, i) =>
      [
        {
          ...CTX_VARIANTS[i % CTX_VARIANTS.length]!,
          opts: {
            ...TEXTBOX_OPTS[i % TEXTBOX_OPTS.length],
            ...(SECT_OPTS[i % SECT_OPTS.length] === undefined
              ? {}
              : { section: SECT_OPTS[i % SECT_OPTS.length] }),
            ...(i % 5 === 0 ? { docOffset: 100 } : {}),
          },
        },
        {
          ...CTX_VARIANTS[(i + 1) % CTX_VARIANTS.length]!,
          opts: {
            shapes: true,
            pictures: true,
            ...(SECT_OPTS[(i + 1) % SECT_OPTS.length] === undefined
              ? {}
              : { section: SECT_OPTS[(i + 1) % SECT_OPTS.length] }),
          },
        },
        { ...CTX_VARIANTS[(i + 2) % CTX_VARIANTS.length]! },
      ].map((args) => ({ text, args })),
    ),
  },
]

function TXBX_TABLES(): string[] {
  const tc = (inner: string, tcPr = ''): string => `<w:tc>${tcPr}${inner}</w:tc>`
  const tr = (cells: string, trPr = ''): string => `<w:tr>${trPr}${cells}</w:tr>`
  const p = (text: string): string => para(run(text))
  return [
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>${tr(tc(p('a')) + tc(p('b')))}${tr(tc(p('c'), '<w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr>'))}</w:tbl>`,
    `<w:tbl><w:tr>${tc(p('only'))}</w:tr></w:tbl>`,
    `<w:tbl><w:tr><w:trPr><w:trHeight w:val="400"/></w:trPr>${tc(p('x'), '<w:tcPr><w:shd w:val="clear" w:fill="FFFF00"/><w:tcBorders><w:top w:val="single" w:sz="8" w:color="FF0000"/></w:tcBorders><w:vAlign w:val="center"/></w:tcPr>')}${tc(`<w:tbl><w:tr>${tc(p('nested'))}</w:tr></w:tbl><w:p/>`)}</w:tr></w:tbl>`,
    '<w:tbl/>',
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:jc w:val="center"/></w:tblPr><w:tr>${tc(p('wide'), '<w:tcPr><w:tcW w:w="5000" w:type="dxa"/></w:tcPr>')}</w:tr></w:tbl>`,
    '',
  ]
}

export const PARSE_DRAWINGS: CallSpec[] = [...WAVE0, ...BATCH2]
