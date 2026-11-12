// Group `generate` of comparison (f): generate.ts of packages/pptx-engine. The Rust side
// answers in crates/office-wasm/src/calls/pptx_generate.rs to
// `pptxGenerate.generate.<TypeScript name>`.
//
// A fragment is the `text`; the model values (a paragraph, a text body, a fill patch) are
// `args`, taken from the parsed slides of the corpus decks where there are some and written
// by hand where the corpus has none.
import {
  alternateContentBranches,
  clampEmu,
  clampInt,
  clampPosEmu,
  COORD_MAX,
  generateParagraphXml,
  generateXfrmXml,
  hangulLang,
  isConnectorXml,
  patchBodyPrAutofit,
  patchElementFill,
  patchElementPPr,
  patchElementStroke,
  patchElementXfrm,
  patchParagraphPPrXml,
  patchPictureSrcRect,
  patchSlideAdvanceTimeXml,
  patchSlideBackgroundXml,
  patchSlideHiddenXml,
  patchSlideShowMasterSpXml,
  patchSlideTransitionXml,
  patchTextElementXml,
  readSlideAdvanceTimeXml,
  readSlideHiddenXml,
  readSlideTransitionXml,
  rebuildTxBody,
  removeSlideBackgroundXml,
  szAttr,
  tagHangulParagraphs,
  tagHangulRun,
  topLevelChildren,
  TRANSITION_KINDS,
  type BackgroundFillPatch,
  type FillPatch,
  type StrokePatch,
} from '../../packages/pptx-engine/src/generate'
import { parseSlide } from '../../packages/pptx-engine/src/parse'
import type {
  Paragraph,
  PPrDirty,
  SlideElement,
  TextElement,
  TextRun,
} from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Args = Record<string, unknown>

/** A value as it reaches Rust: keys that hold undefined are gone. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** `<a:fld>` takes a random GUID: both sides print it as one fixed text. */
const FIELD_ID = /(<a:fld id=")\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}"/g
const noGuid = (xml: string): string => xml.replace(FIELD_ID, '$1{G}"')

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/

/** The elements of every slide of the document, flattened through groups. */
function corpusElements(parts: ReadonlyMap<string, string>): SlideElement[] {
  const out: SlideElement[] = []
  const walk = (list: SlideElement[]): void => {
    for (const el of list) {
      out.push(el)
      if (el.type === 'group') walk(el.children)
    }
  }
  for (const [path, slideXml] of parts) {
    if (!SLIDE_PART.test(path)) continue
    try {
      walk(parseSlide({ path, slideXml, ctx: {} }).elements)
    } catch {
      // a slide the parser refuses gives no model value
    }
  }
  return out
}

const isText = (el: SlideElement): el is TextElement => el.type === 'text' || el.type === 'shape'

// ── Model values ──────────────────────────────────────────────────────

const WHICH: PPrDirty[] = [
  { bullet: true },
  { level: true },
  { lnSpc: true },
  { spcBef: true, spcAft: true },
  { align: true, rtl: true },
  { indents: true },
  { bullet: true, lnSpc: true, spcBef: true, spcAft: true, align: true, indents: true },
  { align: true, paraIndices: [0] },
  { align: true, paraIndices: [1, 5] },
  { align: true, paraIndices: [] },
  {},
]

const FILLS: FillPatch[] = [
  'none',
  '#FF0000',
  '#ff000080',
  '#F00',
  '#F00A',
  'red',
  '#00FF00FF',
  '$&',
  { stops: [{ pos: 0, color: '#FF0000' }, { pos: 1, color: '#0000FF80' }], angle: 5400000 },
  { stops: [{ pos: -1, color: '#FF0000' }, { pos: 2, color: '#0000FF' }] },
  { stops: [{ pos: 0.5, color: '#123456' }], radial: true },
  { stops: [{ pos: 0, color: '#123456' }], path: 'rect', fillTo: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 } },
  { stops: [{ pos: 0, color: '#123456' }], path: 'shape' },
  { stops: [{ pos: 0, color: '#123456' }], path: 'circle', angle: 1 },
  { stops: [], angle: 0 },
  { rawFillXml: '<a:pattFill prst="pct5"/>' },
  { rawFillXml: '$1' },
]

const STROKES: Array<StrokePatch | null> = [
  null,
  { color: '#FF0000', widthEmu: 12700 },
  { color: '#FF000080', widthEmu: 0 },
  { color: '#00FF00', widthEmu: 1e12, dash: 'dash', cap: 'rnd', compound: 'dbl', join: 'round' },
  { color: '#00FF00', widthEmu: -5, dash: 'solid', cap: 'flat', compound: 'sng', join: 'bevel' },
  { color: '#0000FF', widthEmu: 9525, dash: '', join: 'miter' },
  { color: '#0000FF', widthEmu: 9525, dash: 'sysDot', cap: 'sq', compound: 'tri' },
  {
    color: '#0000FF',
    widthEmu: 9525,
    gradient: { stops: [{ pos: 0, color: '#FF0000' }, { pos: 1, color: '#00FF00' }], angle: 2700000 },
  },
  { color: '#0000FF', widthEmu: 100, dash: 'a"<b', join: 'bevel' },
]

const BACKGROUNDS: BackgroundFillPatch[] = [
  '#FF0000',
  'none',
  '#11223380',
  { stops: [{ pos: 0, color: '#FF0000' }, { pos: 1, color: '#0000FF' }], angle: 5400000 },
  { stops: [{ pos: 0, color: '#FF0000' }], path: 'circle' },
  { imageRid: 'rId2' },
  { imageRid: 'rId3', tile: true },
  { imageRid: 'rId4', tile: false },
]

/** Hand-written paragraphs: the corpus rarely carries every key a rebuild reads. */
const PARAGRAPHS: Paragraph[] = wire([
  { runs: [{ text: 'plain' }], align: 'left' },
  {
    runs: [
      { text: 'bold', bold: true, italic: true, underline: true, underlineStyle: 'dbl', strike: true, strikeStyle: 'dblStrike' },
      { text: '\n' },
      { text: 'a\r\nb\rc\nd' },
      { text: '', fontSize: 18 },
      { text: 'x', fontSize: 1e9, color: '#FF0000', highlight: '#00FF00', fontFamily: 'Arial', kern: 12, letterSpacing: 1.5, baseline: 30, capExplicit: 'all' },
      { text: 'link', hyperlinkRId: 'rId9', hyperlinkAction: 'ppaction://hlinkshowjump?jump=nextslide', hyperlinkTooltip: 'tip "q"' },
      { text: '7', field: 'slidenum', color: '#112233' },
      { text: 'raw', rawXml: '<a:r><a:t>raw</a:t></a:r>' },
      { text: 'o', outline: { color: '#010203', widthEmu: 12700.4 }, redact: 'secret' },
      { text: 'f', latinFont: 'Calibri', eaFont: 'MS Gothic', csFont: 'Arial', colorNodeXml: '<a:schemeClr val="accent1"/>' },
      { text: '\u{1F600}\uD55C', underlineExplicitNone: true, strikeExplicitNone: true, boldImplicit: true, bold: false },
    ],
    align: 'justify',
    rtl: true,
    level: 2,
    marL: 457200,
    marR: 12.4,
    indent: -285750,
    defTabSz: 914400,
    eaLnBrk: true,
    latinLnBrk: false,
    hangingPunct: true,
    lineHeight: 1.5,
    spaceBefore: 6,
    spaceAfterPct: 20,
    bullet: { type: 'char', char: '\u2022', color: '#FF0000', font: 'Arial', sizePct: 80 },
    tabStops: [{ pos: 914400, algn: 'l' }, { pos: 1828800 }],
    defRPr: { fontSize: 12, bold: true, italic: false, cap: 'small', color: '#334455', latinFont: 'Arial', eaFont: 'X', csFont: 'Y' },
  },
  {
    runs: [{ text: 'n', color: '#abc' }],
    lineExact: 14,
    spaceBeforePct: 50,
    spaceAfter: 3,
    bullet: { type: 'number', numType: 'arabicPeriod', startAt: 3, sizePt: 12, colorNodeXml: '<a:schemeClr val="tx1"/>' },
    pPrExplicit: { align: false, lnSpc: true, bullet: true, marL: true },
    marL: 1,
    align: 'center',
  },
  {
    runs: [],
    bullet: { type: 'none' },
    rtl: false,
    level: 0,
    pPrExplicit: {},
  },
  {
    runs: [{ text: 'b' }],
    bullet: { type: 'blip', blipEmbedId: 'rId5' },
  },
  {
    runs: [{ text: 'b' }],
    bullet: { type: 'blip' },
    lineExact: 1e12,
    spaceBefore: -4,
  },
  { runs: [{ text: 'c' }], bullet: { type: 'char' }, align: 'right', marL: 1e12, indent: 1e12 },
])

// ── Fragments ──────────────────────────────────────────────────────────

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const sp = (spPr: string, tail = ''): string =>
  `<p:sp ${NS}><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${spPr}${tail}</p:sp>`

const TX_BODY = (paras: string): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>`

const R = (text: string, rPr = ''): string => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`

const SHAPES: string[] = [
  sp('<p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>', TX_BODY(`<a:p>${R('one')}</a:p>`)),
  sp('<p:spPr/>', TX_BODY(`<a:p>${R('one', '<a:rPr lang="en-US" b="1"/>')}<a:br/>${R('two', '<a:rPr sz="1800"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:latin typeface="Arial"/></a:rPr>')}</a:p><a:p><a:pPr algn="ctr"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:buChar char="x"/></a:pPr>${R('three')}</a:p>`)),
  sp('<p:spPr><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:ln w="9525" cap="rnd" cmpd="dbl"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:prstDash val="dash"/><a:round/><a:headEnd/></a:ln></p:spPr>'),
  sp('<p:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="1" y="2"/><a:ext cx="3" cy="4"/><a:chOff x="0" y="0"/></a:xfrm><a:gradFill rotWithShape="0"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst><a:lin ang="100" scaled="0"/></a:gradFill><a:ln><a:gradFill><a:gsLst/><a:path path="rect"><a:fillToRect l="1"/></a:path></a:gradFill></a:ln></p:spPr>'),
  sp('<p:spPr><a:custGeom/><a:gradFill><a:gsLst/><a:path path="circle"/><a:tileRect/></a:gradFill><a:ln w="1"><a:noFill/></a:ln><a:effectLst/></p:spPr>'),
  sp('<p:spPr><a:noFill/><a:ln/></p:spPr>'),
  sp('<p:spPr><a:gradFill/><a:ln w="5"/></p:spPr>'),
  sp('<p:spPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"/></a:gsLst></a:gradFill></p:spPr>'),
  sp('<p:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>'),
  sp('<p:spPr><a:pattFill prst="pct5"/><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:miter lim="1"/><a:prstDash val="sysDot"/></a:ln></p:spPr>'),
  sp('<p:spPr xmlns:x="y"/>', '<p:style/>'),
  sp('<p:spPr xmlns:x="y"/>', '<p:style></p:style>'),
  '<p:cxnSp><p:nvCxnSpPr/><p:spPr/></p:cxnSp>',
  '<p:sp><p:spPr>',
  '<p:sp><p:spPr/>',
  '<p:sp/>',
  '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr></p:pic>',
  '<p:grpSp><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:chOff x="5" y="5"/></a:xfrm></p:grpSpPr></p:grpSp>',
  '<p:grpSp><p:grpSpPr/></p:grpSp>',
  '',
]

const PICS: string[] = [
  '<p:pic><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10" t="20"/><a:stretch/></p:blipFill><p:spPr/></p:pic>',
  '<p:pic><p:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch/></p:blipFill></p:pic>',
  '<p:pic><p:blipFill><a:srcRect r="1"></a:srcRect><a:blip/></p:blipFill></p:pic>',
  '<p:pic><p:blipFill></p:blipFill></p:pic>',
  '<p:pic><p:blipFill><a:blip/>',
  '<p:pic/>',
  '<p:pic><p:blipFill><a:blip><a:extLst><a:ext uri="x"><a:srcRect/></a:ext></a:extLst></a:blip></p:blipFill></p:pic>',
]

const SRC_RECTS = [
  null,
  { l: 0, t: 0, r: 0, b: 0 },
  { l: 0.1, t: 0.2, r: 0.3, b: 0.4 },
  { l: -1, t: 2, r: 0.00001, b: 0.99999 },
  { l: 0.5, t: 0, r: 0, b: 0 },
]

const BODY_PREFIXES: string[] = [
  `<p:sld ${NS}><p:cSld><p:spTree>`,
  `<p:sld ${NS} showMasterSp="1" show="0"><p:cSld name="x"><p:bg><p:bgPr><a:noFill/></p:bgPr></p:bg><p:spTree>`,
  `<p:sld ${NS} showMasterSp='0' show='1'><p:cSld><p:bg bwMode="auto"/><p:spTree>`,
  `<p:sld><p:cSld/>`,
  `<p:sld x="a>b" show="0">`,
  `<p:sld>`,
  '<p:sldLayout><p:cSld>',
  '<p:cSld>',
  '',
]

const BODY_SUFFIXES: string[] = [
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition spd="med"><p:fade/></p:transition><p:timing/></p:sld>',
  '</p:spTree></p:cSld><p:transition advTm="3000"><p:wipe dir="r"/></p:transition></p:sld>',
  '</p:spTree></p:cSld><p:transition advTm="3000" advClick="0"/></p:sld>',
  '</p:spTree></p:cSld><p:transition advTm="3000" />',
  '</p:spTree></p:cSld><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="p159"><p:transition spd="slow" p14:dur="800" advTm="100"><p159:morph option="byObject"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow" advTm="100"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent><p:timing/></p:sld>',
  '</p:spTree></p:cSld><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="x"><p:other/></mc:Choice></mc:AlternateContent><p:transition><p:zoom/></p:transition>',
  '</p:spTree></p:cSld><p:transition><p:split orient="vert"/></p:transition>',
  '</p:spTree></p:cSld><p:transition><p:unknown/></p:transition>',
  '<p:clrMapOvr/>',
  '<p:timing/>',
  '',
]

const ADV_TIMES: Array<number | null> = [null, 0, 5000, 5000.6, -3, 1e12, 4294967295]

const PPR_PARAS: string[] = [
  '<a:p><a:r><a:t>x</a:t></a:r></a:p>',
  '<a:p><a:pPr/><a:r><a:t>x</a:t></a:r></a:p>',
  '<a:p><a:pPr algn="l" marL="1" lvl="1"></a:pPr><a:r><a:t>x</a:t></a:r></a:p>',
  '<a:p><a:pPr marL="1"><a:lnSpc><a:spcPct val="1"/></a:lnSpc><a:spcBef/><a:buClr><a:srgbClr val="FF0000"/></a:buClr><a:buSzPct val="1"/><a:buFont typeface="x"/><a:buChar char="y"/><a:tabLst/><a:defRPr/></a:pPr></a:p>',
  '<a:p><a:pPr><a:buNone/><a:spcAft><a:spcPts val="1"/></a:spcAft></a:pPr></a:p>',
  '<a:p><a:pPr algn="ctr"',
  '<a:p x="1"><a:r/></a:p>',
  '<a:p>',
  '',
]

const AC_BLOCKS: string[] = [
  '<mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="a14"><p:sp><p:nvSpPr/></p:sp></mc:Choice><mc:Fallback><p:pic/></mc:Fallback></mc:AlternateContent>',
  '<mc:AlternateContent><mc:Choice Requires="x"><p:graphicFrame/></mc:Choice></mc:AlternateContent>',
  '<mc:AlternateContent><mc:Choice Requires="x"/><mc:Fallback/></mc:AlternateContent>',
  '<mc:AlternateContent><mc:Choice Requires="x"></mc:Choice><mc:Other><p:sp/></mc:Other></mc:AlternateContent>',
  '<mc:AlternateContent><mc:Choice Requires="x"><p:sp/><p:pic/></mc:Choice>',
  '<mc:AlternateContent x="a>b"><mc:Fallback><p:cxnSp/></mc:Fallback></mc:AlternateContent>',
  '<p:sp/>',
  '',
]

const CHILDREN: string[] = [
  '<a:r><a:rPr b="1"/><a:t>x</a:t></a:r>',
  '<a:a><a:b/><a:c></a:c></a:a><a:d x=">"/>',
  '<a:a x=\'<\'>t</a:a>',
  '<a:a><a:a></a:a>',
  '</a:a><a:b/>',
  '<?x?><!--c--><a:a/>',
  '<a:a/>',
  '',
]

const RUN_FONTS: string[] = [
  '<a:r><a:rPr lang="en"><a:latin typeface="Old" pitchFamily="34"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:ea typeface="E"/><a:cs typeface="C"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr/><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:ln><a:latin typeface="in"/></a:ln><a:hlinkClick r:id="rId1"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><!-- c --><a:latin typeface="Old"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><mc:AlternateContent><mc:Choice><a:latin typeface="Old"/></mc:Choice></mc:AlternateContent></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:latin typeface="A"/><a:latin typeface="B"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:latin faketypeface="A" typeface=\'Q\'/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:latin/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:latin typeface="A">payload</a:latin><a:extLst/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:sym typeface="S"/><a:extLst><a:ext uri="u"><a:rPr><a:latin typeface="n"/></a:rPr></a:ext></a:extLst></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:_x typeface="n"/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:solidFill><a:srgbClr val="000000"><a:alpha val="5"/></a:srgbClr></a:solidFill><a:highlight><a:srgbClr val="FFFF00"/></a:highlight><a:hlinkClick r:id="rId7" action="x"/><a:rtl/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr><a:ln><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln><a:effectLst/></a:rPr><a:t>x</a:t></a:r>',
  '<a:r><a:rPr/><a:t/></a:r>',
  '<a:r><a:rPr b="0" i="1" u="sng" strike="sngStrike" baseline="30000" spc="5" sz="100"/><a:t xml:space="preserve"> y </a:t></a:r>',
]

const RUNS: Array<Args> = wire([
  { text: 'new' },
  { text: '' },
  { text: 'a<b>&"\'$&', bold: true, italic: false, underline: false, strike: false, baseline: 0, fontSize: 24, letterSpacingEdited: true, letterSpacing: 0 },
  { text: 'c', underline: true, underlineStyle: 'wavy', strike: true, strikeStyle: 'dblStrike', baseline: 30, letterSpacingEdited: true, letterSpacing: 2.5 },
  { text: 'c', underlineImplicit: true, underline: true, boldImplicit: true, bold: true, italicImplicit: true, italic: true, fontSizeImplicit: true, fontSize: 9 },
  { text: 'c', underlineExplicitNone: true },
  { text: 'd', color: '#FF0000', fontFamily: 'Segoe', hyperlinkRId: 'rId9' },
  { text: 'd', color: '#FF0000', colorFollowsTheme: true, fontFamily: 'Segoe', latinFont: 'L', hyperlinkRId: '', hyperlinkAction: 'ppaction://hlinkshowjump?jump=lastslide', hyperlinkTooltip: 't' },
  { text: 'd', color: '#FF0000', colorInherited: true, fontFamily: 'Segoe', fontImplicit: true, highlight: '#00FF00', highlightEdited: true },
  { text: 'd', highlightEdited: true },
  { text: 'e', redact: 'why', colorNodeXml: '<a:schemeClr val="bg1"/>', fontFamily: 'A&B' },
  { text: '', paraMark: true },
  { text: 'x', paraMark: true, color: '#010101' },
  { text: 'x', fontSize: 1e999, baseline: 1e999, letterSpacing: 1e12, letterSpacingEdited: true },
  { text: '\u{1F600}', kern: 1.234, capExplicit: 'small', letterSpacing: 0.005, baseline: 0.0004, fontSize: 0.005 },
])

/** A wrapper element carrying the model's text body, so the Rust side builds the same value. */
function textArgs(text: unknown, extra: Args = {}): Args {
  return { text, ...extra }
}

/** The model call `fn(el)`: the element is a text element carrying `args.text`. */
const modelElement = (args: Args): TextElement =>
  ({ type: 'text', text: args.text, textMoved: args.textMoved }) as unknown as TextElement

const FRAMES: string[] = [
  '<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData><a:xfrm><a:off x="9" y="9"/></a:xfrm></a:graphicData></a:graphic></p:graphicFrame>',
  '<p:graphicFrame><p:nvGraphicFramePr/><a:graphic><a:graphicData><a:xfrm><a:off x="9" y="9"/></a:xfrm></a:graphicData></a:graphic></p:graphicFrame>',
  '<p:graphicFrame><p:xfrm rot="1"><a:off x="0" y="0"/><a:chOff x="1" y="1"/></p:xfrm></p:graphicFrame>',
  '<p:graphicFrame><p:xfrm>',
  '<p:graphicFrame/>',
]

const HANGUL_TEXTS = [
  '',
  'plain',
  '\uD55C\uAE00',
  'mixed \uD55C text',
  '\u3131',
  '\u1100',
  '\uA960',
  '\uD7B0',
  '\uFFA0',
  '\u65E5\u672C',
  '\uD83D\uDE00',
  '\uAC00'.repeat(3),
]

const HANGUL_RUNS: TextRun[] = [
  { text: '\uD55C\uAE00' },
  { text: 'plain' },
  { text: '\uD55C', lang: 'en-US' },
  { text: '\uD55C', lang: 'ko-KR' },
  { text: '\uD55C', altLang: 'en-US' },
  { text: '', lang: '' },
  { text: '\uD55C', fontSize: 12, bold: true },
]

export const GENERATE: CallSpec[] = [
  {
    fn: 'pptxGenerate.generate.hangulLang',
    call: (text) => hangulLang(text),
    built: HANGUL_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxGenerate.generate.tagHangulRun',
    call: (_text, args) => tagHangulRun(args.run as TextRun),
    mutation: 'none',
    built: HANGUL_RUNS.map((run) => ({ args: { run } })),
  },
  {
    // the same array back when nothing changed: `null` says so here
    fn: 'pptxGenerate.generate.tagHangulParagraphs',
    call: (_text, args) => {
      const paragraphs = args.paragraphs as Paragraph[]
      const out = tagHangulParagraphs(paragraphs)
      return out === paragraphs ? null : out
    },
    mutation: 'none',
    built: [
      { args: { paragraphs: [] } },
      { args: { paragraphs: [{ runs: HANGUL_RUNS.slice(0, 2) }] } },
      { args: { paragraphs: [{ runs: [{ text: 'plain' }] }, { runs: HANGUL_RUNS }] } },
      { args: { paragraphs: [{ runs: [] }, { runs: [{ text: '\uD55C', lang: 'en-US' }] }] } },
    ],
  },
  {
    fn: 'pptxGenerate.generate.patchTextElementXml',
    call: (text, args) => noGuid(patchTextElementXml(modelElement(args), text)),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] => {
        if (!isText(el) || !el.text) return []
        const xml = el.anchor.originalXml
        const body = wire(el.text)
        const moved: Input[] = [{ text: xml, args: textArgs(body, { textMoved: true }) }]
        const fewer = { ...body, paragraphs: body.paragraphs.slice(0, -1) }
        return [{ text: xml, args: textArgs(body) }, ...moved, { text: xml, args: textArgs(wire(fewer)) }]
      }),
    built: [
      ...SHAPES.flatMap((xml) =>
        PARAGRAPHS.slice(0, 3).map((p): Input => ({
          text: xml,
          args: textArgs({ paragraphs: [p], anchor: 'middle' }),
        })),
      ),
      ...SHAPES.slice(0, 4).map((xml): Input => ({
        text: xml,
        args: textArgs({ paragraphs: PARAGRAPHS, anchor: 'bottom' }),
      })),
      ...SHAPES.slice(0, 4).map((xml): Input => ({
        text: xml,
        args: textArgs({ paragraphs: PARAGRAPHS.slice(1, 2) }, { textMoved: true }),
      })),
      ...SHAPES.slice(0, 2).map((xml): Input => ({ text: xml, args: textArgs({ paragraphs: [] }) })),
      ...SHAPES.slice(0, 2).map((xml): Input => ({ text: xml, args: {} })),
      // every run of RUNS written into a one-run paragraph of a one-run shape, each in place
      ...RUN_FONTS.flatMap((run) =>
        RUNS.map((r): Input => ({
          text: sp('<p:spPr/>', TX_BODY(`<a:p>${run}</a:p>`)),
          args: textArgs({ paragraphs: [{ runs: [r] }] }),
        })),
      ),
      // paragraph layout differs from the original while the flattened run count is the same
      {
        text: sp('<p:spPr/>', TX_BODY(`<a:p>${R('a')}${R('b')}</a:p><a:p>${R('c')}${R('d')}</a:p>`)),
        args: textArgs({ paragraphs: [1, 2, 3, 4].map((i) => ({ runs: [{ text: `t${i}` }] })) }),
      },
      {
        text: sp('<p:spPr/>', TX_BODY(`<a:p>${R('a')}<a:br/>${R('b')}</a:p>`)),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }, { text: '\n' }, { text: 'b' }] }] }),
      },
      {
        text: sp('<p:spPr/>', TX_BODY(`<a:p>${R('a')}<a:br></a:br>${R('\n')}</a:p>`)),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }, { text: '\n' }, { text: 'z' }] }] }),
      },
      {
        text: sp('<p:spPr/>', TX_BODY('<a:p><a:r><a:t>a</a:t></a:r><mc:AlternateContent><mc:Choice Requires="a14"><a14:m/></mc:Choice></mc:AlternateContent></a:p>')),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }, { text: 'm', rawXml: '<a14:m>raw</a14:m>' }] }] }),
      },
      {
        text: sp('<p:spPr/>', TX_BODY('<a:p><a:r><a:t>a</a:t></a:r><mc:AlternateContent><mc:Choice Requires="a14"><a14:m/></mc:Choice></mc:AlternateContent></a:p>')),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }, { text: 'm' }] }] }),
      },
      {
        text: '<a:p><a:r><a:t>a</a:t></a:r><mc:AlternateContent><mc:Choice><p:sp/></mc:Choice></mc:AlternateContent></a:p>',
        args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }] }] }),
      },
      { text: '<a:p><a:r><a:t>a</a:t>', args: textArgs({ paragraphs: [{ runs: [{ text: 'a' }] }] }) },
      { text: '<a:p><a:br>', args: textArgs({ paragraphs: [{ runs: [{ text: '\n' }] }] }) },
      { text: '<a:p><a:r><a:t>a</a:t></a:r></a:p>', args: textArgs({ paragraphs: [{ runs: [{ text: 'b' }] }] }) },
      { text: '<a:p><a:r><a:t>a</a:t></a:r><a:t/></a:p>', args: textArgs({ paragraphs: [{ runs: [{ text: 'b' }] }] }) },
    ],
  },
  {
    fn: 'pptxGenerate.generate.patchParagraphPPrXml',
    call: (text, args) =>
      patchParagraphPPrXml(text, args.p as Paragraph, args.which as PPrDirty),
    built: PPR_PARAS.flatMap((xml) =>
      PARAGRAPHS.flatMap((p) => WHICH.map((which): Input => ({ text: xml, args: { p, which } }))),
    ),
  },
  {
    fn: 'pptxGenerate.generate.patchElementPPr',
    call: (text, args) =>
      patchElementPPr(modelElement(args), text, args.which as PPrDirty),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] => {
        if (!isText(el) || !el.text) return []
        return WHICH.map((which): Input => ({
          text: el.anchor.originalXml,
          args: textArgs(wire(el.text), { which }),
        }))
      }),
    built: [
      ...WHICH.map((which): Input => ({
        text: sp('<p:spPr/>', TX_BODY(`<a:p>${R('a')}</a:p><a:p>${R('b')}</a:p>`)),
        args: textArgs({ paragraphs: PARAGRAPHS.slice(0, 2) }, { which }),
      })),
      ...WHICH.map((which): Input => ({
        text: sp('<p:spPr/>', TX_BODY(`<a:p>${R('a')}</a:p>`)),
        args: textArgs({ paragraphs: PARAGRAPHS.slice(0, 2) }, { which }),
      })),
      { text: sp('<p:spPr/>'), args: textArgs({ paragraphs: [] }, { which: {} }) },
      { text: sp('<p:spPr/>'), args: { which: {} } },
    ],
  },
  {
    fn: 'pptxGenerate.generate.szAttr',
    call: (_t, args) => szAttr(args.pt as number),
    mutation: 'none',
    built: [0, 1, 12, 12.5, 18.004, 0.5, -3, 4000, 4000.5, 1e9, 99.999].map(
      (pt): Input => ({ args: { pt } }),
    ),
  },
  {
    fn: 'pptxGenerate.generate.clampInt',
    call: (_t, args) => clampInt(args.v as number, args.min as number, args.max as number),
    mutation: 'none',
    built: [
      [0, 0, 10],
      [5.5, 0, 10],
      [-0.4, -5, 5],
      [-0.5, -5, 5],
      [2.5, 0, 10],
      [1e30, 0, 10],
      [-1e30, 0, 10],
      [3, 5, 1],
    ].map(([v, min, max]): Input => ({ args: { v, min, max } })),
  },
  {
    fn: 'pptxGenerate.generate.clampEmu',
    call: (_t, args) => clampEmu(args.v as number),
    mutation: 'none',
    built: [0, 1.5, -1.5, COORD_MAX, COORD_MAX + 1e6, -COORD_MAX * 2, 1e300].map(
      (v): Input => ({ args: { v } }),
    ),
  },
  {
    fn: 'pptxGenerate.generate.clampPosEmu',
    call: (_t, args) => clampPosEmu(args.v as number),
    mutation: 'none',
    built: [0, 1.5, -1.5, COORD_MAX, COORD_MAX + 1e6, -COORD_MAX * 2, 1e300].map(
      (v): Input => ({ args: { v } }),
    ),
  },
  {
    fn: 'pptxGenerate.generate.COORD_MAX',
    call: () => COORD_MAX,
    mutation: 'none',
    built: [{ args: {} }],
  },
  {
    fn: 'pptxGenerate.generate.isConnectorXml',
    call: (text) => isConnectorXml(text),
    fromDocument: (parts) =>
      corpusElements(parts).map((el): Input => ({ text: el.anchor.originalXml })),
    built: [
      ...SHAPES.map((text): Input => ({ text })),
      { text: ' \n<p:cxnSp>' },
      { text: '<p:cxnSp/>' },
      { text: '<p:cxnSpx>' },
      { text: '<p:cxnSp\t>' },
    ],
  },
  {
    fn: 'pptxGenerate.generate.rebuildTxBody',
    call: (text, args) => noGuid(rebuildTxBody(modelElement(args), text)),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] =>
        isText(el) && el.text
          ? [{ text: el.anchor.originalXml, args: textArgs(wire(el.text)) }]
          : [],
      ),
    built: [
      ...SHAPES.map((text): Input => ({
        text,
        args: textArgs({ paragraphs: PARAGRAPHS, anchor: 'middle' }),
      })),
      ...SHAPES.slice(0, 3).map((text): Input => ({
        text,
        args: textArgs({ paragraphs: [], anchor: 'bottom' }),
      })),
      ...SHAPES.slice(0, 3).map((text): Input => ({
        text,
        args: textArgs({ paragraphs: [{ runs: [{ text: 'k' }] }], anchor: 'top' }),
      })),
      {
        text: sp('<p:spPr/>', '<p:txBody><a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr><a:lstStyle><a:lvl1pPr/></a:lstStyle><a:p/>'),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'k' }] }] }),
      },
      {
        text: sp('<p:spPr/>', '<p:txBody ><a:bodyPr/></p:txBody>'),
        args: textArgs({ paragraphs: [{ runs: [{ text: '\u{1F600}' }] }] }),
      },
      {
        text: sp('<p:spPr/>', '<p:txBody></p:txBody>'),
        args: textArgs({ paragraphs: [{ runs: [{ text: 'k' }] }] }),
      },
      { text: sp('<p:spPr/>', '<p:txBody><a:p/>'), args: textArgs({ paragraphs: [{ runs: [] }] }) },
      { text: sp('<p:spPr/>', '<p:txBody><a:p/>'), args: {} },
    ],
  },
  {
    fn: 'pptxGenerate.generate.generateParagraphXml',
    call: (_t, args) => noGuid(generateParagraphXml(args.p as Paragraph)),
    mutation: 'none',
    argMutation: true,
    built: [
      ...PARAGRAPHS.map((p): Input => ({ args: { p } })),
      ...RUNS.map((r): Input => ({ args: { p: { runs: [r] } } })),
    ],
  },
  {
    fn: 'pptxGenerate.generate.alternateContentBranches',
    call: (text) => alternateContentBranches(text),
    fromDocument: (parts) =>
      corpusElements(parts)
        .filter((el) => el.anchor.originalXml.startsWith('<mc:AlternateContent'))
        .map((el): Input => ({ text: el.anchor.originalXml })),
    built: AC_BLOCKS.map((text): Input => ({ text })),
  },
  {
    fn: 'pptxGenerate.generate.topLevelChildren',
    call: (text, args) => topLevelChildren(text, args.from as number, args.to as number),
    built: CHILDREN.flatMap((text) =>
      [0, 3, 10].flatMap((from) =>
        [text.length, 8, 0, text.length + 5].map((to): Input => ({ text, args: { from, to } })),
      ),
    ),
  },
  {
    fn: 'pptxGenerate.generate.patchElementFill',
    call: (text, args) => patchElementFill(text, args.fill as FillPatch),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] =>
        FILLS.slice(0, 9).map((fill): Input => ({ text: el.anchor.originalXml, args: { fill } })),
      ),
    built: SHAPES.flatMap((text) => FILLS.map((fill): Input => ({ text, args: { fill } }))),
  },
  {
    fn: 'pptxGenerate.generate.patchElementStroke',
    call: (text, args) => patchElementStroke(text, (args.stroke ?? null) as StrokePatch | null),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] =>
        STROKES.slice(0, 5).map((stroke): Input => ({ text: el.anchor.originalXml, args: { stroke } })),
      ),
    built: SHAPES.flatMap((text) => STROKES.map((stroke): Input => ({ text, args: { stroke } }))),
  },
  {
    fn: 'pptxGenerate.generate.patchPictureSrcRect',
    call: (text, args) => patchPictureSrcRect(text, (args.srcRect ?? null) as never),
    fromDocument: (parts) =>
      corpusElements(parts)
        .filter((el) => el.type === 'picture')
        .flatMap((el): Input[] =>
          SRC_RECTS.map((srcRect): Input => ({ text: el.anchor.originalXml, args: { srcRect } })),
        ),
    built: PICS.flatMap((text) => SRC_RECTS.map((srcRect): Input => ({ text, args: { srcRect } }))),
  },
  {
    fn: 'pptxGenerate.generate.patchSlideBackgroundXml',
    call: (text, args) => patchSlideBackgroundXml(text, args.fill as BackgroundFillPatch),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => SLIDE_PART.test(name))
        .flatMap(([, xml]): Input[] => {
          const at = xml.indexOf('<p:spTree')
          const prefix = at < 0 ? xml : xml.slice(0, at)
          return BACKGROUNDS.map((fill): Input => ({ text: prefix, args: { fill } }))
        }),
    built: BODY_PREFIXES.flatMap((text) =>
      BACKGROUNDS.map((fill): Input => ({ text, args: { fill } })),
    ),
  },
  {
    fn: 'pptxGenerate.generate.removeSlideBackgroundXml',
    call: (text) => removeSlideBackgroundXml(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => SLIDE_PART.test(name))
        .map(([, xml]): Input => ({ text: xml.slice(0, Math.max(0, xml.indexOf('<p:spTree'))) })),
    built: BODY_PREFIXES.map((text): Input => ({ text })),
  },
  {
    fn: 'pptxGenerate.generate.patchSlideShowMasterSpXml',
    call: (text, args) => patchSlideShowMasterSpXml(text, args.hidden as boolean),
    built: BODY_PREFIXES.flatMap((text) =>
      [true, false].map((hidden): Input => ({ text, args: { hidden } })),
    ),
  },
  {
    fn: 'pptxGenerate.generate.TRANSITION_KINDS',
    call: () => [...TRANSITION_KINDS],
    mutation: 'none',
    built: [{ args: {} }],
  },
  {
    fn: 'pptxGenerate.generate.patchSlideTransitionXml',
    call: (text, args) => patchSlideTransitionXml(text, args.kind as never),
    built: BODY_SUFFIXES.flatMap((text) =>
      TRANSITION_KINDS.map((kind): Input => ({ text, args: { kind } })),
    ),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => SLIDE_PART.test(name))
        .flatMap(([, xml]): Input[] => {
          const at = xml.indexOf('</p:spTree>')
          const suffix = at < 0 ? xml : xml.slice(at)
          return TRANSITION_KINDS.map((kind): Input => ({ text: suffix, args: { kind } }))
        }),
  },
  {
    fn: 'pptxGenerate.generate.readSlideTransitionXml',
    call: (text) => readSlideTransitionXml(text),
    built: BODY_SUFFIXES.map((text): Input => ({ text })),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => SLIDE_PART.test(name))
        .map(([, xml]): Input => ({ text: xml.slice(Math.max(0, xml.indexOf('</p:spTree>'))) })),
  },
  {
    fn: 'pptxGenerate.generate.patchSlideAdvanceTimeXml',
    call: (text, args) => patchSlideAdvanceTimeXml(text, (args.ms ?? null) as number | null),
    built: BODY_SUFFIXES.flatMap((text) =>
      ADV_TIMES.map((ms): Input => ({ text, args: { ms } })),
    ),
  },
  {
    fn: 'pptxGenerate.generate.readSlideAdvanceTimeXml',
    call: (text) => readSlideAdvanceTimeXml(text),
    built: [
      ...BODY_SUFFIXES.map((text): Input => ({ text })),
      { text: '<p:transition advTm="99999999999999999999999"/>' },
      { text: '<p:transition advTm="007"/>' },
      { text: '<p:transition advTm=\'5\'/>' },
      { text: '<p:transition advTm="-5"/>' },
    ],
  },
  {
    fn: 'pptxGenerate.generate.patchSlideHiddenXml',
    call: (text, args) => patchSlideHiddenXml(text, args.hidden as boolean),
    built: BODY_PREFIXES.flatMap((text) =>
      [true, false].map((hidden): Input => ({ text, args: { hidden } })),
    ),
  },
  {
    fn: 'pptxGenerate.generate.readSlideHiddenXml',
    call: (text) => readSlideHiddenXml(text),
    built: [
      ...BODY_PREFIXES.map((text): Input => ({ text })),
      { text: '<p:sld  show="0">' },
      { text: '<p:sld show="1">' },
      { text: '<p:sld showMasterSp="0">' },
    ],
  },
  {
    fn: 'pptxGenerate.generate.generateXfrmXml',
    call: (_t, args) => generateXfrmXml(args.t as never, args.tag as string | undefined),
    mutation: 'none',
    argMutation: true,
    built: TRANSFORMS().flatMap((t) =>
      [undefined, 'p:xfrm', 'a:xfrm'].map((tag): Input => ({ args: { t, ...(tag ? { tag } : {}) } })),
    ),
  },
  {
    fn: 'pptxGenerate.generate.patchElementXfrm',
    call: (text, args) =>
      patchElementXfrm(
        { type: args.type, transform: args.transform } as unknown as SlideElement,
        text,
      ),
    fromDocument: (parts) =>
      corpusElements(parts).flatMap((el): Input[] => [
        {
          text: el.anchor.originalXml,
          args: { type: el.type, transform: wire(el.transform) },
        },
        ...TRANSFORMS()
          .slice(0, 4)
          .map((transform): Input => ({
            text: el.anchor.originalXml,
            args: { type: el.type, transform },
          })),
      ]),
    built: [
      ...SHAPES.flatMap((text) =>
        TRANSFORMS().flatMap((transform) =>
          ['text', 'picture', 'group'].map((type): Input => ({ text, args: { type, transform } })),
        ),
      ),
      ...FRAMES.flatMap((text) =>
        TRANSFORMS().flatMap((transform) =>
          ['table', 'chart', 'passthrough', 'text'].map(
            (type): Input => ({ text, args: { type, transform } }),
          ),
        ),
      ),
    ],
  },
  {
    fn: 'pptxGenerate.generate.patchBodyPrAutofit',
    call: (text, args) =>
      patchBodyPrAutofit(text, args.fontScale as number, args.lnSpcReduction as number | undefined),
    built: [
      '<a:bodyPr><a:normAutofit/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit fontScale="50000" lnSpcReduction="10000"/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit fontScale="50000"></a:normAutofit></a:bodyPr>',
      '<a:bodyPr><a:normAutofit > </a:normAutofit></a:bodyPr><a:normAutofit/>',
      '<a:bodyPr><a:spAutoFit/></a:bodyPr>',
      '<a:normAutofitX/>',
      '',
    ].flatMap((text) =>
      [
        [1, undefined],
        [0.9995, 0],
        [0.5, 0.1],
        [0.0001, 0.2],
        [-3, 1e9],
        [0.998, -0.1],
        [1e9, 0.0000001],
      ].map(([fontScale, lnSpcReduction]): Input => ({
        text,
        args: { fontScale, ...(lnSpcReduction === undefined ? {} : { lnSpcReduction }) },
      })),
    ),
  },
]

function TRANSFORMS(): Array<Record<string, unknown>> {
  const t = (x: number, y: number, cx: number, cy: number, rot = 0, flipH = false, flipV = false) => ({
    offset: { x, y, cx, cy },
    rot,
    flipH,
    flipV,
  })
  return [
    t(0, 0, 0, 0),
    t(914400, 457200, 1828800, 914400),
    t(-5, 1.5, 2.5, -2, 5400000, true, true),
    t(1e30, -1e30, 1e30, 1e30, 1e30, true, false),
    t(0.5, -0.5, 0.4, 1e-9, -2147483649, false, true),
    t(COORD_MAX + 1, 0, COORD_MAX, 0, 2147483648),
  ]
}
