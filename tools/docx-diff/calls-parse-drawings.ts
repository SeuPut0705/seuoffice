// parse.ts: drawings, VML, media and settings (crates/docx-engine/src/parse/drawings.rs).
// A function over a node takes its XML text (serializeXNode at the call); one
// over the package takes `args.parts`; a Map crosses as its entries; one that
// writes into an argument answers that argument after the call.
import { inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import type { JSZipObject } from 'jszip'
import { resolveRelationshipTargetPath } from '../../packages/docx-engine/src/parse-package'
import type { RelInfo } from '../../packages/docx-engine/src/parse-xml-text'
import { attrsOf, findChild, nameOf, serializeXNode, xmlParser, type XNode } from '../../packages/docx-engine/src/xml-utils'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { custgeomInheritedGuide } from './listed'
import { parseInternals } from './parse-internals'

const internals = await parseInternals()


const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNode = (value: unknown): value is XNode => isObject(value) && nameOf(value as XNode) !== undefined

/** The first element of `text` as xmlParser reads it, `{}` for none: what the Rust side takes. */
const nodeOf = (text: string): XNode =>
  (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) !== undefined) ?? {}

/** A copy of a model argument, so the call cannot write into the input both sides read. */
const copy = <T>(value: T): T => structuredClone(value)

const SETTINGS = 'word/settings.xml'

/** `[name, text]` of the parts in `names` the document has. */
const partsNamed = (parts: ReadonlyMap<string, string>, ...names: string[]): Array<[string, string]> =>
  names.flatMap((name) => (parts.has(name) ? [[name, parts.get(name)!] as [string, string]] : []))

const settingsOnly = (parts: ReadonlyMap<string, string>): Input => ({ args: { parts: partsNamed(parts, SETTINGS) } })

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
  ...['page', 'column', 'margin', 'character', 'leftMargin', 'insideMargin', 'outsideMargin'].flatMap((from) => [
    ...ALIGNS.map((align) => positionH(from, `<wp:align>${align}</wp:align>`)),
    positionH(from, '<wp:posOffset>-952500</wp:posOffset>'),
  ]),
  positionH('page', '<wp:posOffset>4762</wp:posOffset>') + positionV('paragraph', '<wp:posOffset>-14287</wp:posOffset>'),
  positionH('margin', '<wp:align>center</wp:align><wp:posOffset>12</wp:posOffset>') +
    positionV('line', '<wp:align>bottom</wp:align>'),
  ...['page', 'paragraph', 'line', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin', 'margin'].flatMap(
    (from) => [
      positionV(from, '<wp:align>top</wp:align>'),
      positionV(from, '<wp:align>left</wp:align>'),
      positionV(from, '<wp:posOffset>95250</wp:posOffset>'),
    ],
  ),
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
const TEXT_BOXES = [{ id: 1 }, { id: 2, widthPx: 10, autofit: false, insets: [1, 2, 3, 4] }, { id: 3, vAlign: 'top', nowrap: false }]

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
  pic('><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/></a:xfrm><a:ln w="19050"><a:solidFill><a:srgbClr val="ff00aa"/></a:solidFill></a:ln>'),
  pic(' bwMode="auto"><a:xfrm rot="-60000" flipV="true"/><a:ln><a:solidFill> <a:srgbClr val="00FF00"/></a:solidFill></a:ln>'),
  pic('><a:xfrm rot="21570000" flipH="0"/><a:ln w="0"><a:noFill/></a:ln>'),
  pic('><a:xfrm rot="30000"/><a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>'),
  pic('><a:xfrm/><a:ln w="12700"><a:noFill /><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'),
  pic('><a:xfrm rot="abc" flipV="1" flipH="true"></a:xfrm>'),
  pic('></a:xfrm>'),
  '<wps:spPr><a:xfrm rot="5400000"/><a:ln w="9525"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln></wps:spPr>',
  pic('>'),
  '',
]

const groupDrawing = (pics: string, ext = '<wp:extent cx="2000000" cy="1000000"/>', grp = ''): string =>
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
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 1000000, 500000)) + groupPic('rId2', PIC_XFRM(500000, 250000, 1000000, 500000)), undefined, GRP_XFRM),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 1000000, 500000)) + groupPic('rId2', PIC_XFRM(-7, 0, 3, 3), true)),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId9', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId3', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' rot="60000"')) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' flipH="0"')) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10, ' rot="x"')) + groupPic('rId2', PIC_XFRM(0, 0, 0, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)) + '<wps:wsp/>'),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + '<wpg:grpSp>' + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)) + '</wpg:grpSp>'),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10))),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)), '<wp:extent cx="0" cy="5"/>'),
  groupDrawing(groupPic('rId1', PIC_XFRM(0, 0, 10, 10)) + groupPic('rId2', PIC_XFRM(0, 0, 10, 10)), ''),
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
const SETTINGS_TAGS = ['w:gutterAtTop', 'w:evenAndOddHeaders', 'w:mirrorMargins', 'w:trackRevisions', 'w:autoHyphenation', 'w:(', '']
const settingsParts = (xml: string): Array<[string, string]> => (xml === '' ? [] : [[SETTINGS, xml]])

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
  [['customXml/item1.xml', '<other/>'], ['customXml/item2.xml', SOURCES_XML]],
  [['customXml/item1.xml', `<b:Sources xmlns:b="${SOURCES_NS}"/>`]],
  [['customXml/itemProps1.xml', SOURCES_XML]],
  [],
]

const PLACEHOLDER_HASH = '0123456789abcdef'.repeat(4)
const placeholder = (hash: string, tail = '\n'): string => `GENOFFICE-LAZY-MEDIA\n${hash}${tail}`
const MEDIA_PARTS: Array<[string, string, string]> = [
  ['word/media/image1.png', placeholder(PLACEHOLDER_HASH), 'image/png'],
  ['word/media/ä b#1.png', placeholder('f'.repeat(64)), 'image/png'],
  ['word/media/image2.png', placeholder(PLACEHOLDER_HASH.toUpperCase()), 'image/png'],
  ['word/media/image3.png', placeholder(PLACEHOLDER_HASH, '\r'), 'image/png'],
  ['word/media/image4.png', placeholder(PLACEHOLDER_HASH.slice(1), 'x\n'), 'image/png'],
  ['word/media/image5.png', placeholder(PLACEHOLDER_HASH) + '\n', 'image/png'],
  ['word/media/image6.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'image/svg+xml'],
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
const wsp = (x: number, y: number, cx: number, cy: number, geom: string, spPr = '<a:solidFill><a:srgbClr val="1f497d"/></a:solidFill>', tail = ''): string =>
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
const shapeDrawing = (shapes: string, extent = '<wp:extent cx="952500" cy="476250"/>', grp = ''): string =>
  `<w:drawing><wp:anchor>${extent}<a:graphic><a:graphicData><wpg:wgp><wpg:grpSpPr>${grp}</wpg:grpSpPr>${shapes}</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const SVG_FRAGS = [
  shapeDrawing(wsp(0, 0, 952500, 476250, SQUARE)),
  shapeDrawing(wsp(0, 0, 952500, 476250, CURVES) + wsp(9525, 19050, 95250, 95250, ARCS), undefined, GRP_XFRM),
  shapeDrawing(wsp(0, 0, 0, 476250, NO_SIZE, LINE_LN)),
  shapeDrawing(wsp(10, 10, 952500, 0, SQUARE, '<a:ln w="25400"><a:noFill/></a:ln>', '<wps:style><a:lnRef idx="2"><a:srgbClr val="00FF00"/></a:lnRef></wps:style>')),
  shapeDrawing(wsp(10, 10, 952500, 0, SQUARE, '<a:ln w="25400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln>', '<wps:style><a:lnRef idx="2"><a:srgbClr val="00FF00"/></a:lnRef></wps:style>')),
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
  shapeDrawing(wsp(0, 0, 100, 100, '<a:custGeom><a:pathLst><a:path w="1" h="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path></a:pathLst>')),
  shapeDrawing(wsp(0, 0, 100, 100, geom('<a:path w="1" h="1" fill="none" stroke="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path>'))),
  shapeDrawing(wsp(0, 0, 100, 100, geom('<a:path w="2" h="2"><!-- a > b --><a:moveTo><a:pt x="1" y="1" name="a>b"/></a:moveTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo><a:gd name="x" fmla="val 1"/></a:path>'))),
  // a point at -0.125 px: a tie Math.round takes up, toward zero
  shapeDrawing(
    wsp(0, 0, 9525, 9525, geom('<a:path w="1000" h="1000"><a:moveTo><a:pt x="-125" y="-375"/></a:moveTo><a:lnTo><a:pt x="1000" y="1000"/></a:lnTo></a:path>')),
  ),
  // Object.prototype members as guide names: NaN in the TypeScript, and a guide named __proto__ is not kept
  shapeDrawing(
    wsp(0, 0, 100, 100, geom(
      '<a:path w="10" h="10"><a:moveTo><a:pt x="g1" y="__proto__"/></a:moveTo><a:lnTo><a:pt x="valueOf" y="hasOwnProperty"/></a:lnTo><a:arcTo wR="__proto__" hR="5" stAng="0" swAng="5400000"/><a:lnTo><a:pt x="toString" y="5"/></a:lnTo></a:path>',
      '<a:gd name="g1" fmla="val toString"/><a:gd name="__proto__" fmla="val 5"/>',
    )),
  ),
  '<w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing>',
]

const TEXTBOX_PARAS = [{ runs: [] }, { runs: [], cells: [] }, { runs: [{ text: 'a' }] }, { runs: [{ text: '' }], styleId: 'x' }]

const DOCUMENT_VML_FLAGS = /\b(?:stroked|filled|on)="([^"]*)"/g

export const PARSE_DRAWINGS: CallSpec[] = [
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
      [{ imageWidthPx: 96 }, { imageWidthPx: 0 }, {}, { imageWidthPx: 1000.5, imageWrap: 'square-left' }].flatMap((meta) =>
        SECTS.map((sect) => ({ text, args: { meta, sect } })),
      ),
    ),
    argMutation: true,
  },
  {
    fn: 'parse.vmlHrRule',
    call: (text) => internals.vmlHrRule!(text),
    fromParse: { fn: 'vmlHrRule', input: ([tag]) => (typeof tag === 'string' ? { text: tag } : undefined) },
    built: HR_RECTS.map((text) => ({ text })),
  },
  {
    fn: 'parse.txbxParaVisible',
    call: (_text, args) => internals.txbxParaVisible!(args.p),
    fromParse: { fn: 'txbxParaVisible', input: ([p]) => (isObject(p) ? { args: { p: copy(p) } } : undefined) },
    built: TEXTBOX_PARAS.map((p) => ({ args: { p } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hasFloatingVmlGeometry',
    call: (text) => internals.hasFloatingVmlGeometry!(text),
    fromParse: { fn: 'hasFloatingVmlGeometry', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: [...FLOATING_VML, ...VML_PARAS].map((text) => ({ text })),
  },
  {
    fn: 'parse.vmlPictsInlineOnly',
    call: (text, args) =>
      internals.vmlPictsInlineOnly!(text, Array.isArray(args.shapeTypes) ? new Map(args.shapeTypes as Array<[string, unknown]>) : undefined),
    fromParse: {
      fn: 'vmlPictsInlineOnly',
      input: ([xml, shapeTypes]) =>
        typeof xml === 'string'
          ? { text: xml, args: shapeTypes instanceof Map ? { shapeTypes: copy([...shapeTypes]) } : {} }
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
      [...new Set([...parts.values()].flatMap((xml) => [...xml.matchAll(DOCUMENT_VML_FLAGS)].map((m) => m[1]!)))].map(
        (value) => ({ args: { value } }),
      ),
    built: ['f', 'false', '0', 't', 'true', '1', '', 'F', 'off', ' f'].map((value): Input => ({ args: { value } })).concat([{ args: {} }]),
    mutation: 'none',
  },
  {
    fn: 'parse.vmlStrokeWeightPx',
    call: (_text, args) => internals.vmlStrokeWeightPx!(args.value),
    fromParse: {
      fn: 'vmlStrokeWeightPx',
      input: ([value]) => (value === undefined || typeof value === 'string' ? { args: value === undefined ? {} : { value } } : undefined),
    },
    built: ['0.75pt', '2px', ' 1 ', '0', '-1pt', '1.5 pt', 'abc', '1e2', '..', '1.2.3pt', '', '3in', '1px ', '.5', '0.333px', '\u00a01pt']
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
        isObject(box) && typeof style === 'string' && isObject(sect) ? { text: style, args: { box: copy(box), sect } } : undefined,
    },
    built: MSO_STYLES.flatMap((text) => BOXES.flatMap((box) => SECTS.map((sect) => ({ text, args: { box, sect } })))),
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
    listed: custgeomInheritedGuide,
    fromParse: { fn: 'hfShapeDrawingSvg', input: ([frag]) => (typeof frag === 'string' ? { text: frag } : undefined) },
    built: SVG_FRAGS.map((text): Input => (custgeomInheritedGuide(text, {}) ? { text, seed: false } : { text })),
  },
  {
    fn: 'parse.vmlLengthPx',
    call: (_text, args) => internals.vmlLengthPx!(args.raw),
    fromParse: {
      fn: 'vmlLengthPx',
      input: ([raw]) => (raw === undefined || typeof raw === 'string' ? { args: raw === undefined ? {} : { raw } } : undefined),
    },
    built: ['46pt', '16in', '2cm', '12px', '1pc', '3mm', '0', '-1.5pt', ' 7 pt ', '1em', '..', '', 'pt', '1e3pt', '0.1', '-']
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
      input: ([bodyPr, box]) => (isNode(bodyPr) && isObject(box) ? { text: serializeXNode(bodyPr), args: { box: copy(box) } } : undefined),
    },
    built: BODY_PRS.flatMap((text) => TEXT_BOXES.map((box) => ({ text, args: { box } }))),
    argMutation: true,
  },
  {
    fn: 'parse.rectFrac',
    call: (text, args) => internals.rectFrac!(text, args.name),
    fromParse: {
      fn: 'rectFrac',
      input: ([tag, name]) => (typeof tag === 'string' && typeof name === 'string' ? { text: tag, args: { name } } : undefined),
    },
    built: RECT_TAGS.flatMap((text) => RECT_NAMES.map((name) => ({ text, args: { name } }))),
  },
  {
    fn: 'parse.picBorderOf',
    call: (text) => internals.picBorderOf!(text),
    fromParse: { fn: 'picBorderOf', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: PIC_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'parse.groupPictureLayers',
    call: (text, args) => internals.groupPictureLayers!(nodeOf(text), new Map(args.mediaByRid as Array<[string, string]>)),
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
    fromParse: { fn: 'picTransformOf', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: PIC_XMLS.map((text) => ({ text })),
  },
  {
    fn: 'parse.vmlImageMeta',
    call: (text) => internals.vmlImageMeta!(text),
    fromParse: { fn: 'vmlImageMeta', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: VML_IMAGES.map((text) => ({ text })),
  },
  {
    fn: 'parse.relPartPath',
    call: (_text, args) =>
      internals.relPartPath!(
        { rels: new Map(args.rels as Array<[string, RelInfo]>), ...(args.sourcePath !== undefined ? { sourcePath: args.sourcePath } : {}) },
        args.rId,
      ),
    fromParse: {
      fn: 'relPartPath',
      input: ([ctx, rId]) => {
        const rels = isObject(ctx) ? relsEntries(ctx.rels) : undefined
        if (!isObject(ctx) || !rels || (rId !== undefined && typeof rId !== 'string')) return undefined
        const sourcePath = sourcePathOf(ctx)
        return { args: { rels, ...(sourcePath !== undefined ? { sourcePath } : {}), ...(rId !== undefined ? { rId } : {}) } }
      },
    },
    built: [...RELS.map(([id]) => id), 'rId99', undefined].flatMap((rId) =>
      [undefined, 'word/header1.xml', 'word/glossary/document.xml', ''].map((sourcePath) => ({
        args: { rels: RELS, ...(sourcePath !== undefined ? { sourcePath } : {}), ...(rId !== undefined ? { rId } : {}) },
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
        typeof documentXml === 'string' ? { text: documentXml, args: { parts: partsNamed(parts, SETTINGS) } } : undefined,
    },
    built: NOTE_DOCUMENTS.flatMap((text) => SETTINGS_XMLS.map((xml) => ({ text, args: { parts: settingsParts(xml) } }))),
  },
  {
    fn: 'parse.parseSettingsFlag',
    call: (_text, args) => internals.parseSettingsFlag!(zipOf(args.parts), args.tag),
    fromParse: {
      fn: 'parseSettingsFlag',
      input: ([, tag], parts) => (typeof tag === 'string' ? { args: { ...settingsOnly(parts).args, tag } } : undefined),
    },
    built: SETTINGS_XMLS.flatMap((xml) => SETTINGS_TAGS.map((tag) => ({ args: { parts: settingsParts(xml), tag } }))),
    mutation: 'none',
  },
  {
    fn: 'parse.parseSources',
    call: (_text, args) => internals.parseSources!(zipOf(args.parts)),
    fromParse: {
      fn: 'parseSources',
      input: (_args, parts) => ({ args: { parts: [...parts].filter(([name]) => name.startsWith('customXml/')) } }),
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
      const zip = await JSZip.loadAsync(await zipOf(args.parts).generateAsync({ type: 'uint8array' }))
      const partPath = args.partPath as string
      const src = await internals.mediaPartSrc!(zip, zip.file(partPath), partPath, args.mime)
      const lazy = internals.lazyHashesByZip as unknown as WeakMap<JSZip, Set<string>>
      return { src, lazyHashes: [...(lazy.get(zip) ?? [])] }
    },
    fromParse: {
      fn: 'mediaPartSrc',
      input: ([, file, partPath, mime]) => {
        const text = typeof partPath === 'string' && typeof mime === 'string' ? partText(file) : undefined
        return text === undefined ? undefined : { args: { parts: [[partPath, text]], partPath, mime } }
      },
    },
    built: MEDIA_PARTS.map(([name, text, mime]) => ({ args: { parts: [[name, text]], partPath: name, mime } })).concat([
      { args: { parts: [['word/media/a.png', 'x']], partPath: 'word/media/b.png', mime: 'image/png' } },
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
        if (typeof documentXml !== 'string' || !entries || (sourcePath !== undefined && typeof sourcePath !== 'string')) return undefined
        const map = rels as Map<string, RelInfo>
        const ids = [...documentXml.matchAll(/<wps:txbx\b[^>]*\br:txbx="([^"]+)"/g)].map((m) => m[1])
        const named = ids.flatMap((rId) => relPart(parts, map, rId, sourcePath))
        return {
          text: documentXml,
          args: { parts: [...new Map(named)], rels: entries, ...(sourcePath !== undefined ? { sourcePath } : {}) },
        }
      },
    },
    built: TXBX_DOCUMENTS.flatMap((text) =>
      [undefined, 'word/sub/document.xml'].map((sourcePath) => ({
        text,
        args: { parts: TXBX_PARTS, rels: RELS, ...(sourcePath !== undefined ? { sourcePath } : {}) },
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
        if (typeof xml !== 'string' || !isObject(ctx) || !rels || !isObject(ctx.chartParts)) return undefined
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
        { chartParts: { 'word/charts/chart1.xml': 'old', '2': 'two' }, themeColors: null, sourcePath: 'word/document.xml' },
        { chartParts: {}, themeColors: { accent1: '112233', dk1: '000000' }, sourcePath: 'word/sub/x.xml' },
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
    | { compressedContent?: Uint8Array; compression?: { magic?: string } }
    | Uint8Array
    | undefined
  let bytes: Uint8Array | undefined
  if (data instanceof Uint8Array) bytes = data
  else if (data?.compressedContent && data.compression?.magic === '\x00\x00') bytes = data.compressedContent
  else if (data?.compressedContent && data.compression?.magic === '\x08\x00') bytes = inflateRawSync(data.compressedContent)
  if (!bytes) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

