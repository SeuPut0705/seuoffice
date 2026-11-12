// Slides for the text section of parse.ts (base64ToUtf8, parseTextBody,
// spcPct, spcPts, parseParagraph, parseParagraphDefRPr, paragraphSources,
// themeFontSource, parseRun). Each entry is the inner XML of one <p:spTree>;
// `ctx` holds the parse-context parts it needs, as context.rs reads them
// (a Map as its [key, value] pairs).

type SlideInput = { name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }

const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const NS_A14 = 'http://schemas.microsoft.com/office/drawing/2010/main'
const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const NS_DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REDACT_URI = '{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}'
const REDACT_NS = 'https://genspark.ai/genoffice/redaction/2026'

const sp = (txBody: string, nvPr = '', style = ''): string =>
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/>' +
  `<p:nvPr>${nvPr}</p:nvPr></p:nvSpPr>` +
  '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
  `${style}<p:txBody>${txBody}</p:txBody></p:sp>`

const tx = (paras: string, bodyPr = '<a:bodyPr/>', lstStyle = '<a:lstStyle/>'): string =>
  `${bodyPr}${lstStyle}${paras}`
const p = (inner: string, pPr = ''): string => `<a:p>${pPr}${inner}</a:p>`
const r = (t: string, rPr = '<a:rPr lang="en-US"/>'): string => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`
/** One shape per text body, each with an empty bodyPr. */
const shapes = (...paras: string[]): string => paras.map((x) => sp(tx(x))).join('')
/** One shape whose body has the given bodyPr. */
const withBodyPr = (...bodyPrs: string[]): string =>
  bodyPrs.map((b) => sp(tx(p(r('x')), b))).join('')
const redact = (label: string, uri = REDACT_URI): string =>
  `<a:extLst><a:ext uri="${uri}"><go:redact xmlns:go="${REDACT_NS}" label="${label}"/></a:ext></a:extLst>`

const THEME = {
  colors: {
    dk1: '#000000',
    lt1: '#FFFFFF',
    dk2: '#1F497D',
    lt2: '#EEECE1',
    accent1: '#4F81BD',
    accent2: '#C0504D',
    accent3: '#9BBB59',
    accent4: '#8064A2',
    accent5: '#4BACC6',
    accent6: '#F79646',
    hlink: '#0563C1',
    folHlink: '#954F72',
  },
  majorFont: 'Major Sans',
  minorFont: 'Minor Sans',
  majorScriptFonts: { Hant: 'MingLiU' },
  minorScriptFonts: { Jpan: 'Yu Mincho', Hang: 'Batang', Hans: 'SimSun' },
  majorCsFont: 'Major Arabic',
  fillStyles: [],
  lnStyles: [],
  effectStyles: [],
  bgFillStyles: [],
}
/** A theme whose fontScheme carries an empty <a:ea typeface=""/>. */
const THEME_EMPTY_EA = { ...THEME, majorEaFont: '', minorEaFont: '' }
/** A theme without fonts or an hlink color. */
const THEME_BARE = { colors: { dk1: '#111111', lt1: '#EEEEEE', accent1: '#336699' } }

const HLINK_RELS = [
  ['rId2', 'https://example.com/'],
  ['rId3', ''],
  ['constructor', 'https://constructor.example/'],
]
const MEDIA_RELS = [
  ['rId5', 'ppt/media/image1.png'],
  ['rId6', ''],
]
const CTX = { theme: THEME, hlinkRels: HLINK_RELS, mediaRels: MEDIA_RELS }

/** A level style in the model form (LevelTextStyle). */
const LEVEL_FULL = {
  fontSize: 32,
  bold: true,
  italic: false,
  cap: 'all',
  color: '#112233',
  shadow: { color: '#000000', blurRad: 38100, dist: 12700, dirDeg: 45 },
  latinFont: 'Master Latin',
  latinFontRef: '+mn-lt',
  eaFont: 'Master EA',
  eaFontRef: '+mn-ea',
  csFont: 'Master CS',
  eaScript: 'ko',
  align: 'center',
  bullet: { type: 'char', char: '\u2013', font: 'Arial', color: '#FF0000', sizePct: 80 },
  marL: 342900,
  indent: -342900,
  lineHeight: 90,
  spaceBefore: 10,
  spaceAfterPct: 20,
  hangingPunct: true,
  latinLnBrk: false,
  eaLnBrk: true,
}
const LEVEL_NUMBERED = {
  fontSize: 20,
  color: '#445566',
  bullet: { type: 'number', numType: 'romanUcPeriod', startAt: 4, sizePt: 14 },
  lineExact: 24,
  spaceBeforePct: 50,
  spaceAfter: 6,
  align: 'right',
}
const MASTER_TEXT_STYLES = {
  title: { levels: [{ fontSize: 44, latinFont: 'Title Face', latinFontRef: '+mj-lt', align: 'left' }] },
  body: { levels: [LEVEL_FULL, LEVEL_NUMBERED, null, { bullet: { type: 'none' } }] },
  other: { levels: [{ fontSize: 18 }] },
}
const LAYOUT_PLACEHOLDERS = {
  entries: [
    {
      type: 'body',
      idx: '1',
      insets: { l: 1000, b: 2000 },
      anchor: 'bottom',
      textStyle: { levels: [{ color: '#ABCDEF', bullet: { type: 'blip', mediaRef: 'ppt/media/b.png' } }] },
    },
    { type: 'title', idx: '', insets: { t: 0, r: -5 } },
  ],
}
const DEFAULT_TEXT_STYLE = {
  levels: [{ fontSize: 18, color: '#333333', latinFont: 'Default Latin', bold: false }],
}
const PH_CTX = {
  ...CTX,
  layoutPlaceholders: LAYOUT_PLACEHOLDERS,
  masterTextStyles: MASTER_TEXT_STYLES,
  defaultTextStyle: DEFAULT_TEXT_STYLE,
}
const BODY_PH = '<p:ph type="body" idx="1"/>'

/** A gxRaw run as a genuine a:r carries it (the math rewrite writes the same). */
const gx = (b64: string, t = 'eq'): string => `<a:r gxRaw="${b64}"><a:rPr/><a:t>${t}</a:t></a:r>`

const MATH_OPEN =
  `<mc:AlternateContent xmlns:mc="${NS_MC}"><mc:Choice xmlns:a14="${NS_A14}" Requires="a14">` +
  `<a14:m><m:oMathPara xmlns:m="${NS_M}"><m:oMath>`
const MATH_TO_FALLBACK = '</m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback>'
const MATH_CLOSE = '</mc:Fallback></mc:AlternateContent>'

const DIAGRAM_FRAME =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/>' +
  '</p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="1828800"/></p:xfrm>' +
  `<a:graphic><a:graphicData uri="${NS_DGM}"><dgm:relIds xmlns:dgm="${NS_DGM}" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:dm="rId7" ' +
  'r:lo="rId20" r:qs="rId21" r:cs="rId22"/></a:graphicData></a:graphic></p:graphicFrame>'
const DRAWING_OPEN =
  `<dsp:drawing xmlns:dsp="${NS_DSP}" xmlns:a="${NS_A}"><dsp:spTree><dsp:nvGrpSpPr>` +
  '<dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>' +
  '<dsp:sp modelId="{AAAA0001-0000-0000-0000-000000000000}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/>' +
  '<dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/>' +
  '</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr/><a:lstStyle/>'
const DRAWING_CLOSE = '</dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>'

export const SLIDES: SlideInput[] = [
  // ── base64ToUtf8 ──────────────────────────────────────────────────
  {
    name: 'math block as a gxRaw run: non-ASCII and astral text in the block',
    spTree: shapes(
      p(
        r('Area: ') +
          MATH_OPEN +
          '<m:r><m:t>\u{1D465}\u00B2</m:t></m:r>' +
          MATH_TO_FALLBACK +
          '<a:r><a:rPr/><a:t>x2</a:t></a:r>' +
          MATH_CLOSE +
          r(' end'),
      ),
      p(`${MATH_OPEN}<m:r><m:t>\u03B1+\u03B2</m:t></m:r>${MATH_TO_FALLBACK}${MATH_CLOSE}`),
    ),
    ctx: CTX,
  },
  {
    name: 'gxRaw that decodes: padded, unpadded, spaced, BOM, invalid UTF-8, empty after decode',
    spTree: shapes(
      p(gx('PGE6cj48L2E6cj4=')),
      p(gx('PGE6cj48L2E6cj4')),
      p(gx(' PGE6 cj48L2E6cj4= ')),
      p(gx('PGE6cj48L2E6cj4&#10;=')),
      p(gx('77u/YQ==')),
      p(gx('/w==') + gx('8J+YgA==')),
      p(gx('4pyT', '')),
      p(gx(' ', '') + '<a:endParaRPr lang="en-US" sz="2400"/>'),
      p(gx('', '') + '<a:endParaRPr lang="en-US" sz="2400"/>'),
      p(gx('YR==')),
    ),
  },
  { name: 'gxRaw throws: invalid character', spTree: shapes(p(gx('!!!'))) },
  { name: 'gxRaw throws: one character left over', spTree: shapes(p(gx('Y'))) },
  { name: 'gxRaw throws: padding where none may stand', spTree: shapes(p(gx('YQ='))) },
  { name: 'gxRaw throws: padding inside', spTree: shapes(p(gx('Y=Q='))) },
  { name: 'gxRaw throws: three pads', spTree: shapes(p(gx('YQ==='))) },
  { name: 'gxRaw throws: non-ASCII', spTree: shapes(p(gx('YQ==\u00E9'))) },
  { name: 'gxRaw throws: no-break space', spTree: shapes(p(gx('Y\u00A0Q'))) },
  { name: "gxRaw throws: single-quoted base64url", spTree: shapes(p("<a:r gxRaw='_-'><a:rPr/><a:t>q</a:t></a:r>")) },

  // ── parseRun: a:t ─────────────────────────────────────────────────
  {
    name: 'a:t forms: preserve, empty, self-closing, repeated, child element, whitespace only',
    spTree: shapes(
      p(r('plain') + '<a:r><a:rPr/><a:t xml:space="preserve">  two  spaces  </a:t></a:r>'),
      p('<a:r><a:rPr/><a:t/></a:r><a:r><a:rPr/><a:t></a:t></a:r>'),
      p('<a:r><a:rPr/><a:t xml:space="preserve"/></a:r>'),
      p('<a:r><a:rPr/><a:t>one</a:t><a:t>two</a:t></a:r>'),
      p('<a:r><a:rPr/><a:t>a<a:x/>c</a:t></a:r>'),
      p(r('   ') + r('\t')),
      p('<a:r/><a:r></a:r><a:r><a:t>no rPr</a:t></a:r><a:r><a:rPr lang="en-US"/></a:r>'),
    ),
    ctx: CTX,
  },
  {
    name: 'a:t text: surrogate pairs, numeric references, entities',
    spTree: shapes(
      p(r('\u{1F600} \u{1D465}\u{20BB7}')),
      p(r('&#x1F600;&#65;&#x41;&#128512;')),
      p(r('&#xD800;&#xDC00;&#1114112;&#0;')),
      p(r('&amp;lt; &lt;b&gt; &quot;q&quot; &apos;')),
      p(r('&#x;&#;&#x1g;')),
    ),
  },
  {
    name: 'line breaks and fields rewritten to runs',
    spTree: shapes(
      p(r('one') + '<a:br/>' + r('two') + '<a:br><a:rPr sz="1200"/></a:br>' + r('three')),
      p(
        '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>' +
          r(' of ') +
          '<a:fld id="{1}" type="datetime1"><a:rPr lang="en-US"/><a:t>11/12/2026</a:t></a:fld>',
      ),
      p('<a:fld id="{2}" type="slidenum"><a:rPr lang="en-US"/></a:fld><a:endParaRPr lang="en-US" sz="4000"/>'),
      p('<a:fld id="{3}"><a:rPr lang="en-US"/><a:t>untyped</a:t></a:fld>'),
      p("<a:fld id='{4}' type=''><a:rPr/><a:t/></a:fld><a:endParaRPr sz='900'/>"),
    ),
    ctx: CTX,
  },
  {
    name: 'a:fld in its original form: a SmartArt drawing part',
    spTree: DIAGRAM_FRAME,
    ctx: {
      ...CTX,
      diagramDrawings: [
        [
          'rId7',
          DRAWING_OPEN +
            p(
              r('Lead ') +
                '<a:fld id="{5}" type="slidenum"><a:rPr lang="en-US" b="1"/><a:t>7</a:t></a:fld>' +
                '<a:br/><a:fld id="{6}"><a:t>x</a:t></a:fld>',
            ) +
              p('<a:fld id="{7}" type="datetime"/><a:endParaRPr lang="en-US"/>') +
              p('<a:fld/><a:fld/><a:endParaRPr lang="en-US" sz="1100"/>') +
              p('<a:fld type="footer"><a:rPr/><a:t>Footer text</a:t></a:fld>') +
              DRAWING_CLOSE,
        ],
      ],
    },
  },

  // ── parseRun: rPr attributes ──────────────────────────────────────
  {
    name: 'rPr sizes: valid, zero, negative, fractional, exponent, text, empty, huge',
    spTree: shapes(
      p(
        r('a', '<a:rPr sz="1800"/>') +
          r('b', '<a:rPr sz="0"/>') +
          r('c', '<a:rPr sz="-100"/>') +
          r('d', '<a:rPr sz="1250.7"/>') +
          r('e', '<a:rPr sz="1e3"/>') +
          r('f', '<a:rPr sz="big"/>') +
          r('g', '<a:rPr sz=""/>') +
          r('h', '<a:rPr sz="99999999999999999999999"/>'),
      ),
    ),
  },
  {
    name: 'rPr flags: b, i, cap, u, strike in every form',
    spTree: shapes(
      p(
        r('1', '<a:rPr b="1" i="1"/>') +
          r('2', '<a:rPr b="true" i="true"/>') +
          r('3', '<a:rPr b="0" i="false"/>') +
          r('4', "<a:rPr b='yes' i=''/>") +
          r('5', '<a:rPr cap="all"/>') +
          r('6', '<a:rPr cap="small"/>') +
          r('7', '<a:rPr cap="none"/>') +
          r('8', '<a:rPr cap=""/>'),
      ),
      p(
        r('u1', '<a:rPr u="sng"/>') +
          r('u2', '<a:rPr u="none"/>') +
          r('u3', '<a:rPr u="dbl"/>') +
          r('u4', '<a:rPr u=""/>') +
          r('s1', '<a:rPr strike="sngStrike"/>') +
          r('s2', '<a:rPr strike="noStrike"/>') +
          r('s3', '<a:rPr strike="dblStrike"/>') +
          r('s4', '<a:rPr strike=""/>'),
      ),
    ),
  },
  {
    name: 'rPr spacing: spc, kern, baseline present, absent, zero, negative, text',
    spTree: shapes(
      p(
        r('a', '<a:rPr spc="300" kern="1200" baseline="30000"/>') +
          r('b', '<a:rPr spc="-50" kern="0" baseline="-25000"/>') +
          r('c', '<a:rPr spc="x" kern="x" baseline="x"/>') +
          r('d', '<a:rPr spc="" kern="" baseline=""/>') +
          r('e', '<a:rPr spc="0" kern="-0" baseline="0"/>') +
          r('f', '<a:rPr kern="12.5"/>'),
      ),
    ),
  },

  // ── parseRun: fills and effects ───────────────────────────────────
  {
    name: 'run colors: srgb plain, srgb with transforms, scheme, empty fill, highlight, text outline',
    spTree: shapes(
      p(
        r('a', '<a:rPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>') +
          r('b', '<a:rPr><a:solidFill><a:srgbClr val="FF0000"><a:lumMod val="50000"/></a:srgbClr></a:solidFill></a:rPr>') +
          r('c', '<a:rPr><a:solidFill><a:srgbClr val="00FF00"><a:alpha val="40000"/></a:srgbClr></a:solidFill></a:rPr>') +
          r('d', '<a:rPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:rPr>') +
          r('e', '<a:rPr><a:solidFill/></a:rPr>') +
          r('f', '<a:rPr><a:solidFill><a:srgbClr/></a:solidFill></a:rPr>') +
          r('g', '<a:rPr><a:solidFill><a:prstClr val="red"/></a:solidFill></a:rPr>'),
      ),
      p(
        r('h1', '<a:rPr><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr>') +
          r('h2', '<a:rPr><a:highlight/></a:rPr>') +
          r('h3', '<a:rPr><a:highlight><a:schemeClr val="bg1"/></a:highlight></a:rPr>'),
      ),
      p(
        r('o1', '<a:rPr><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:rPr>') +
          r('o2', '<a:rPr><a:ln><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:rPr>') +
          r('o3', '<a:rPr><a:ln w="thin"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></a:rPr>') +
          r('o4', '<a:rPr><a:ln w="12700"><a:noFill/></a:ln></a:rPr>') +
          r('o5', '<a:rPr><a:ln/></a:rPr>') +
          r('o6', '<a:rPr><a:ln w="-1"><a:solidFill/></a:ln></a:rPr>'),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'run gradients: stops, angle, scaled, empty, with a solid fill beside',
    spTree: shapes(
      p(
        r(
          'g1',
          '<a:rPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
            '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill></a:rPr>',
        ) +
          r(
            'g2',
            '<a:rPr><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent1"/></a:gs>' +
              '<a:gs pos="50000"><a:srgbClr val="00FF00"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>' +
              '</a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill></a:rPr>',
          ) +
          r('g3', '<a:rPr><a:gradFill/></a:rPr>') +
          r('g4', '<a:rPr><a:gradFill><a:gsLst/></a:gradFill></a:rPr>') +
          r(
            'g5',
            '<a:rPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:gradFill><a:gsLst>' +
              '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill></a:rPr>',
          ) +
          r('g6', '<a:rPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="ABCDEF"/></a:gs></a:gsLst><a:path path="circle"/></a:gradFill></a:rPr>'),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'run effects: shadows, glow, reflection, inherited shadow',
    spTree:
      shapes(
        p(
          r('s1', '<a:rPr><a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst></a:rPr>') +
            r('s2', '<a:rPr><a:effectLst><a:innerShdw blurRad="63500"><a:prstClr val="black"/></a:innerShdw></a:effectLst></a:rPr>') +
            r('s3', '<a:rPr><a:effectLst><a:glow rad="101600"><a:schemeClr val="accent1"/></a:glow></a:effectLst></a:rPr>') +
            r('s4', '<a:rPr><a:effectLst><a:reflection blurRad="6350" stA="50000"/></a:effectLst></a:rPr>') +
            r('s5', '<a:rPr><a:effectLst><a:reflection/></a:effectLst></a:rPr>') +
            r('s6', '<a:rPr><a:effectLst/></a:rPr>'),
        ),
      ) +
      sp(
        tx(
          p(r('inherits shadow')),
          '<a:bodyPr/>',
          '<a:lstStyle><a:lvl1pPr><a:defRPr><a:effectLst><a:outerShdw blurRad="12700" dist="25400" dir="5400000">' +
            '<a:srgbClr val="333333"/></a:outerShdw></a:effectLst></a:defRPr></a:lvl1pPr></a:lstStyle>',
        ),
      ),
    ctx: CTX,
  },

  // ── parseRun: hyperlinks and redaction ────────────────────────────
  {
    name: 'hyperlinks: relationship, missing relationship, empty target, named actions, tooltip, explicit u',
    spTree: shapes(
      p(
        r('a', '<a:rPr><a:hlinkClick r:id="rId2" tooltip="Go there"/></a:rPr>') +
          r('b', '<a:rPr><a:hlinkClick r:id="rId99"/></a:rPr>') +
          r('c', '<a:rPr><a:hlinkClick r:id="rId3"/></a:rPr>') +
          r('d', '<a:rPr><a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/></a:rPr>') +
          r('e', '<a:rPr><a:hlinkClick action="ppaction://hlinkshowjump?jump=endshow"/></a:rPr>') +
          r('f', '<a:rPr><a:hlinkClick r:id="rId2" action="ppaction://hlinksldjump"/></a:rPr>') +
          r('g', '<a:rPr><a:hlinkClick action="ppaction://hlinkshowjump?jump=sideways"/></a:rPr>') +
          r('h', '<a:rPr><a:hlinkClick/></a:rPr>'),
      ),
      p(
        r('i', '<a:rPr u="none"><a:hlinkClick r:id="rId2"/></a:rPr>') +
          r('j', '<a:rPr u="dash"><a:hlinkClick r:id="rId2"/></a:rPr>') +
          r('k', '<a:rPr><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill><a:hlinkClick r:id="rId2"/></a:rPr>') +
          r('l', '<a:rPr><a:hlinkClick r:id="constructor"/></a:rPr>') +
          r('m', '<a:rPr><a:hlinkClick r:id="toString"/></a:rPr>') +
          r('n', "<a:rPr><a:hlinkClick r:id='rId2' tooltip=''/></a:rPr>"),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'hyperlinks without a theme hlink color, and without a theme',
    spTree: shapes(p(r('a', '<a:rPr><a:hlinkClick r:id="rId2"/></a:rPr>') + r('b', '<a:rPr/>'))),
    ctx: { theme: THEME_BARE, hlinkRels: HLINK_RELS },
  },
  {
    name: 'hyperlink with no context maps',
    spTree: shapes(p(r('a', '<a:rPr><a:hlinkClick r:id="rId2"/></a:rPr>'))),
  },
  {
    name: 'redaction marks: label, empty label, another extension, both quote styles',
    spTree: shapes(
      p(
        r('Jane Doe', `<a:rPr lang="en-US">${redact('PII')}</a:rPr>`) +
          r('x', `<a:rPr>${redact('')}</a:rPr>`) +
          r('y', `<a:rPr>${redact('PII', '{00000000-0000-0000-0000-000000000000}')}</a:rPr>`) +
          r('z', `<a:rPr><a:extLst><a:ext uri='${REDACT_URI}'><go:redact xmlns:go='${REDACT_NS}' label='secret &amp; more'/></a:ext></a:extLst></a:rPr>`),
      ),
    ),
  },

  // ── parseRun: fonts and scripts ───────────────────────────────────
  {
    name: 'fonts: explicit faces, theme references, empty typeface, symbol font',
    spTree: shapes(
      p(
        r('a', '<a:rPr><a:latin typeface="Georgia"/><a:ea typeface="MS Gothic"/><a:cs typeface="Arial"/></a:rPr>') +
          r('b', '<a:rPr><a:latin typeface="+mj-lt"/></a:rPr>') +
          r('c', '<a:rPr><a:latin typeface="+mn-lt"/></a:rPr>') +
          r('d', '<a:rPr><a:latin typeface="+zz"/></a:rPr>') +
          r('e', '<a:rPr><a:latin typeface=""/></a:rPr>') +
          r('f', '<a:rPr><a:ea typeface="+mj-ea"/></a:rPr>') +
          r('g', '<a:rPr><a:cs typeface="+mj-cs"/></a:rPr>') +
          r('h', '<a:rPr><a:cs typeface="+mn-cs"/></a:rPr>'),
      ),
      p(
        r('\uF0A7', '<a:rPr><a:sym typeface="Wingdings"/></a:rPr>') +
          r(' \uF0D8\uF0FC ', '<a:rPr><a:sym typeface="Wingdings"/></a:rPr>') +
          r('\uF0A7x', '<a:rPr><a:sym typeface="Wingdings"/></a:rPr>') +
          r('\uF0A7', '<a:rPr/>') +
          r('   ', '<a:rPr><a:sym typeface="Symbol"/></a:rPr>') +
          r('\uF0A7', '<a:rPr><a:latin typeface="Arial"/><a:sym typeface="+mj-lt"/></a:rPr>') +
          r('\uF0A7', '<a:rPr><a:sym typeface=""/></a:rPr>'),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'font buckets by script: complex script, CJK, kana, hangul, latin with ea only',
    spTree: shapes(
      p(
        r('\u05E9\u05DC\u05D5\u05DD', '<a:rPr><a:cs typeface="David"/><a:latin typeface="Arial"/></a:rPr>') +
          r('\u0645\u0631\u062D\u0628\u0627', '<a:rPr><a:latin typeface="Arial"/><a:ea typeface="MS Gothic"/></a:rPr>') +
          r('\u0E2A\u0E27\u0E31\u0E2A', '<a:rPr><a:ea typeface="MS Gothic"/></a:rPr>') +
          r('\u6F22\u5B57', '<a:rPr><a:latin typeface="Arial"/><a:ea typeface="SimSun"/></a:rPr>') +
          r('\u6F22\u5B57', '<a:rPr><a:latin typeface="SimSun"/><a:ea typeface="SimSun"/></a:rPr>') +
          r('\u3072\u3089\u304C\u306A', '<a:rPr><a:latin typeface="Arial"/></a:rPr>') +
          r('\uD55C\uAE00', '<a:rPr><a:ea typeface="+mn-ea"/></a:rPr>') +
          r('Latin', '<a:rPr><a:ea typeface="Malgun Gothic"/></a:rPr>') +
          r('\uFF21\uFF22', '<a:rPr/>'),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'ea theme references by script: lang, altLang, text, inherited script, han',
    spTree:
      shapes(
        p(
          r('\u6F22', '<a:rPr lang="ja-JP"><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr lang="en-US" altLang="ko-KR"><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr lang="zh-CN"><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr lang="zh-TW"><a:ea typeface="+mj-ea"/></a:rPr>') +
            r('\u30AB\u30CA', '<a:rPr><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\uAC00', '<a:rPr><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr><a:ea typeface="+mn-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr><a:ea typeface="+mj-ea"/></a:rPr>') +
            r('\u6F22', '<a:rPr lang="fr-FR"><a:ea typeface="+mj-ea"/></a:rPr>') +
            r('\u6F22', "<a:rPr lang='ZH-hk'><a:ea typeface='+mn-ea'/></a:rPr>"),
        ),
      ) +
      sp(
        tx(
          p(r('\u6F22', '<a:rPr><a:ea typeface="+mn-ea"/></a:rPr>') + r('plain', '<a:rPr/>')),
          '<a:bodyPr/>',
          '<a:lstStyle><a:lvl1pPr><a:defRPr lang="ko-KR"><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></a:lstStyle>',
        ),
      ),
    ctx: CTX,
  },
  {
    name: 'ea theme references on a theme with an empty ea face',
    spTree: shapes(
      p(
        r('\u6F22', '<a:rPr lang="ja-JP"><a:ea typeface="+mn-ea"/></a:rPr>') +
          r('Latin', '<a:rPr><a:latin typeface="Arial"/><a:ea typeface="+mj-ea"/></a:rPr>'),
      ),
    ),
    ctx: { theme: THEME_EMPTY_EA },
  },
  {
    name: 'charset hints: every CJK charset, masked, negative, text, without a typeface, with a lang',
    spTree: shapes(
      p(
        r('Digits 123', '<a:rPr><a:latin typeface="LG Smart" charset="129"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="MS Mincho" charset="128"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="Batang" charset="130"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="SimSun" charset="134"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="MingLiU" charset="136"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="X" charset="384"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="X" charset="-128"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="X" charset="0"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea typeface="X" charset="x"/></a:rPr>') +
          r('\u6F22', '<a:rPr><a:ea charset="128"/></a:rPr>'),
      ),
      p(
        r('Latin', '<a:rPr lang="ko-KR"><a:latin typeface="Rakuten Sans" charset="128"/></a:rPr>') +
          r('\u6F22', '<a:rPr altLang="ja-JP"><a:ea typeface="X" charset="134"/></a:rPr>') +
          r('Latin', '<a:rPr altLang="ja-JP"><a:latin typeface="Y"/></a:rPr>') +
          r('\u05D0', '<a:rPr><a:cs typeface="David" charset="177"/></a:rPr>') +
          r('\u05D0', '<a:rPr lang="he-IL"><a:cs typeface="David" charset="136"/></a:rPr>'),
      ),
    ),
    ctx: CTX,
  },
  {
    name: 'font fallback: theme minor font, no theme at all',
    spTree: shapes(p(r('a', '<a:rPr/>') + r('\u6F22', '<a:rPr/>'))),
  },
  {
    name: 'font fallback: theme without fonts',
    spTree: shapes(p(r('a', '<a:rPr/>'))),
    ctx: { theme: THEME_BARE },
  },

  // ── parseParagraph: levels, alignment, flags ──────────────────────
  {
    name: 'paragraph levels: in range, clamped, negative, fractional, text, empty',
    spTree: shapes(
      p(r('l0'), '<a:pPr lvl="0"/>') +
        p(r('l3'), '<a:pPr lvl="3"/>') +
        p(r('l9'), '<a:pPr lvl="9"/>') +
        p(r('lneg'), '<a:pPr lvl="-1"/>') +
        p(r('lfrac'), '<a:pPr lvl="2.7"/>') +
        p(r('lx'), '<a:pPr lvl="x"/>') +
        p(r('lempty'), '<a:pPr lvl=""/>') +
        p(r('lhuge'), '<a:pPr lvl="99999999999999999999"/>') +
        p(r('self-closing pPr'), '<a:pPr/>') +
        p(r('two pPr'), '<a:pPr lvl="1"/><a:pPr lvl="2"/>'),
    ),
    ctx: PH_CTX,
  },
  {
    name: 'paragraph alignment: every value, unknown, empty, both quote styles',
    spTree: shapes(
      p(r('l'), '<a:pPr algn="l"/>') +
        p(r('ctr'), '<a:pPr algn="ctr"/>') +
        p(r('r'), "<a:pPr algn='r'/>") +
        p(r('just'), '<a:pPr algn="just"/>') +
        p(r('dist'), '<a:pPr algn="dist"/>') +
        p(r('empty'), '<a:pPr algn=""/>'),
    ),
  },
  {
    // ledger inherited-key-parse-3985: alignMap[algn] answers for Object.prototype's names
    name: 'paragraph alignment named after Object.prototype members',
    spTree: shapes(
      p(r('a'), '<a:pPr algn="constructor"/>') +
        p(r('b'), '<a:pPr algn="toString"/>') +
        p(r('c'), '<a:pPr algn="__proto__"/>') +
        p(r('d'), '<a:pPr algn="hasOwnProperty"/>'),
    ),
    seed: false,
  },
  {
    name: 'rtl and line-break switches: explicit both ways, other values, inherited',
    spTree:
      shapes(
        p(r('a'), '<a:pPr rtl="1" hangingPunct="1" latinLnBrk="true" eaLnBrk="1"/>') +
          p(r('b'), '<a:pPr rtl="true" hangingPunct="0" latinLnBrk="false" eaLnBrk="0"/>') +
          p(r('c'), '<a:pPr rtl="0" hangingPunct="false"/>') +
          p(r('d'), '<a:pPr rtl="false" hangingPunct="yes" latinLnBrk="" eaLnBrk="on"/>') +
          p(r('e'), '<a:pPr rtl="yes"/>'),
      ) +
      sp(tx(p(r('inherited switches')) + p(r('overridden'), '<a:pPr eaLnBrk="0" latinLnBrk="1"/>')), BODY_PH),
    ctx: PH_CTX,
  },

  // ── parseParagraph: spacing ───────────────────────────────────────
  {
    name: 'spacing: lnSpc, spcBef, spcAft in percent and points, empty, text, negative',
    spTree: shapes(
      p(r('a'), '<a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:spcAft><a:spcPct val="50000"/></a:spcAft></a:pPr>') +
        p(r('b'), '<a:pPr><a:lnSpc><a:spcPts val="2400"/></a:lnSpc><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:spcAft><a:spcPts val="600"/></a:spcAft></a:pPr>') +
        p(r('c'), '<a:pPr><a:lnSpc/><a:spcBef/><a:spcAft/></a:pPr>') +
        p(r('d'), '<a:pPr><a:lnSpc><a:spcPct val="x"/></a:lnSpc><a:spcBef><a:spcPts val=""/></a:spcBef></a:pPr>') +
        p(r('e'), '<a:pPr><a:lnSpc><a:spcPct val="-90000"/></a:lnSpc><a:spcAft><a:spcPts val="-0"/></a:spcAft></a:pPr>') +
        p(r('f'), '<a:pPr><a:lnSpc><a:spcPct/></a:lnSpc><a:spcBef><a:spcPts/></a:spcBef></a:pPr>') +
        p(r('g'), '<a:pPr><a:lnSpc><a:spcPct val="100000"/><a:spcPts val="1800"/></a:lnSpc></a:pPr>') +
        p(r('h'), '<a:pPr><a:lnSpc><a:spcPct val="12.5e3"/></a:lnSpc><a:spcBef><a:spcPts val="99999999999999999999999"/></a:spcBef></a:pPr>'),
    ),
  },
  {
    name: 'spacing inherited from the placeholder chain and overridden',
    spTree: sp(
      tx(
        p(r('inherits lineHeight and spaceBefore')) +
          p(r('level 2 inherits lineExact and percent'), '<a:pPr lvl="1"/>') +
          p(r('own lnSpc wins'), '<a:pPr lvl="1"><a:lnSpc><a:spcPct val="80000"/></a:lnSpc></a:pPr>') +
          p(r('level 3 falls back to level 1'), '<a:pPr lvl="2"/>'),
      ),
      BODY_PH,
    ),
    ctx: PH_CTX,
  },

  // ── parseParagraph: bullets ───────────────────────────────────────
  {
    name: 'bullets: none, char, numeric reference char, empty char, auto numbers, blips',
    spTree: shapes(
      p(r('a'), '<a:pPr><a:buNone/><a:buClr><a:srgbClr val="FF0000"/></a:buClr></a:pPr>') +
        p(r('b'), '<a:pPr><a:buFont typeface="Arial"/><a:buChar char="\u2022"/></a:pPr>') +
        p(r('c'), '<a:pPr><a:buChar char="&amp;#8226;"/></a:pPr>') +
        p(r('d'), '<a:pPr><a:buChar char=""/></a:pPr>') +
        p(r('e'), '<a:pPr><a:buChar/></a:pPr>') +
        p(r('f'), '<a:pPr><a:buChar char="\u{1F600}"/></a:pPr>'),
      p(r('n1'), '<a:pPr><a:buAutoNum type="arabicPeriod" startAt="3"/></a:pPr>') +
        p(r('n2'), '<a:pPr><a:buAutoNum type="alphaLcParenR" startAt="1"/></a:pPr>') +
        p(r('n3'), '<a:pPr><a:buAutoNum type="romanUcPeriod" startAt="0"/></a:pPr>') +
        p(r('n4'), '<a:pPr><a:buAutoNum type="arabicPlain" startAt="40000"/></a:pPr>') +
        p(r('n5'), '<a:pPr><a:buAutoNum type="arabicPlain" startAt="x"/></a:pPr>') +
        p(r('n6'), '<a:pPr><a:buAutoNum startAt="7"/></a:pPr>') +
        p(r('n7'), '<a:pPr><a:buAutoNum/></a:pPr>') +
        p(r('n8'), '<a:pPr><a:buAutoNum type=""/></a:pPr>') +
        p(r('n9'), '<a:pPr><a:buAutoNum type="arabicPeriod" startAt="2.9"/></a:pPr>'),
      p(r('i1'), '<a:pPr><a:buBlip><a:blip r:embed="rId5"/></a:buBlip></a:pPr>') +
        p(r('i2'), '<a:pPr><a:buBlip><a:blip r:embed="rId404"/></a:buBlip></a:pPr>') +
        p(r('i3'), '<a:pPr><a:buBlip><a:blip r:embed="rId6"/></a:buBlip></a:pPr>') +
        p(r('i4'), '<a:pPr><a:buBlip/></a:pPr>') +
        p(r('i5'), '<a:pPr><a:buBlip><a:blip/></a:buBlip></a:pPr>') +
        p(r('i6'), '<a:pPr><a:buBlip><a:blip r:embed="constructor"/></a:buBlip></a:pPr>') +
        p(r('i7'), '<a:pPr><a:buBlip><a:blip r:embed=""><a:extLst><a:ext uri="x"><asvg:svgBlip r:embed="rId5"/></a:ext></a:extLst></a:blip></a:buBlip></a:pPr>') +
        p(r('i8'), '<a:pPr><a:buBlip><a:blip r:embed=""/></a:buBlip></a:pPr>'),
    ),
    ctx: CTX,
  },
  {
    name: 'bullet decoration: color, scheme color with transforms, font, size in percent and points',
    spTree: shapes(
      p(r('a'), '<a:pPr><a:buClr><a:srgbClr val="00FF00"/></a:buClr><a:buSzPct val="75000"/><a:buChar char="o"/></a:pPr>') +
        p(r('b'), '<a:pPr><a:buClr><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:buClr><a:buSzPts val="1200"/><a:buChar char="-"/></a:pPr>') +
        p(r('c'), '<a:pPr><a:buClr/><a:buFont typeface=""/><a:buSzPct val="x"/><a:buSzPts val="y"/><a:buChar char="*"/></a:pPr>') +
        p(r('d'), '<a:pPr><a:buClr><a:srgbClr val="0000FF"><a:alpha val="50000"/></a:srgbClr></a:buClr><a:buFont typeface="+mj-lt"/><a:buSzPct val=""/><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
        p(r('e'), '<a:pPr><a:buSzPts val="-100"/><a:buSzPct val="250000"/><a:buBlip><a:blip r:embed="rId5"/></a:buBlip></a:pPr>'),
    ),
    ctx: CTX,
  },
  {
    name: 'bullet and paragraph defRPr color: repeated srgbClr children are a plain color',
    spTree: shapes(
      p(r('a'), '<a:pPr><a:buClr><a:srgbClr val="FF0000"/><a:srgbClr val="00FF00"/></a:buClr><a:buChar char="o"/></a:pPr>') +
        p(r('b'), '<a:pPr><a:defRPr><a:solidFill><a:srgbClr val="010203"/><a:srgbClr val="040506"/></a:solidFill></a:defRPr></a:pPr>'),
    ),
    ctx: CTX,
  },
  {
    name: 'inherited bullets: glyph kept, font, size and color following the text',
    spTree: sp(
      tx(
        p(r('master bullet')) +
          p(r('buFontTx'), '<a:pPr><a:buFontTx/></a:pPr>') +
          p(r('buSzTx'), '<a:pPr><a:buSzTx/></a:pPr>') +
          p(r('buClrTx'), '<a:pPr><a:buClrTx/></a:pPr>') +
          p(r('all three'), '<a:pPr><a:buFontTx/><a:buSzTx/><a:buClrTx/></a:pPr>') +
          p(r('numbered level'), '<a:pPr lvl="1"><a:buSzTx/></a:pPr>') +
          p(r('none level'), '<a:pPr lvl="3"><a:buFontTx/></a:pPr>') +
          p(r('own bullet'), '<a:pPr><a:buFontTx/><a:buChar char="+"/></a:pPr>'),
      ),
      BODY_PH,
    ),
    ctx: { ...PH_CTX, layoutPlaceholders: { entries: [] } },
  },
  {
    name: 'layout placeholder chain: bullet and color from the layout, insets and anchor inherited',
    spTree: sp(tx(p(r('layout first')) + p(r('lvl 2'), '<a:pPr lvl="1"><a:buFontTx/></a:pPr>')), BODY_PH),
    ctx: PH_CTX,
  },

  // ── parseParagraph: margins and tabs ──────────────────────────────
  {
    name: 'margins, indent and default tab size: valid, negative, text, empty, inherited',
    spTree:
      shapes(
        p(r('a'), '<a:pPr marL="342900" marR="0" indent="-342900" defTabSz="914400"/>') +
          p(r('b'), '<a:pPr marL="x" marR="y" indent="z" defTabSz="w"/>') +
          p(r('c'), '<a:pPr marL="" marR="" indent="" defTabSz=""/>') +
          p(r('d'), '<a:pPr marL="12.9" marR="-1" indent="1e5" defTabSz="-0"/>'),
      ) + sp(tx(p(r('inherited marL and indent')) + p(r('own marL'), '<a:pPr marL="0"/>')), BODY_PH),
    ctx: PH_CTX,
  },
  {
    name: 'tab stops: single, several unsorted, equal positions, without pos, empty, text',
    spTree: shapes(
      p(r('a'), '<a:pPr><a:tabLst><a:tab pos="914400" algn="l"/></a:tabLst></a:pPr>') +
        p(r('b'), '<a:pPr><a:tabLst><a:tab pos="2743200" algn="r"/><a:tab pos="914400"/><a:tab pos="1828800" algn="ctr"/><a:tab pos="914400" algn="dec"/></a:tabLst></a:pPr>') +
        p(r('c'), '<a:pPr><a:tabLst><a:tab/></a:tabLst></a:pPr>') +
        p(r('d'), '<a:pPr><a:tabLst><a:tab/><a:tab/></a:tabLst></a:pPr>') +
        p(r('e'), '<a:pPr><a:tabLst><a:tab pos="x" algn="l"/><a:tab pos="-100" algn=""/><a:tab pos="12.5"/></a:tabLst></a:pPr>') +
        p(r('f'), '<a:pPr><a:tabLst/></a:pPr>') +
        p(r('g'), '<a:pPr><a:tabLst><a:tab algn="r"/></a:tabLst></a:pPr>'),
    ),
  },

  // ── parseParagraph: defRPr, paragraphSources, themeFontSource ─────
  {
    name: 'paragraph defRPr: every field, theme references, plain and modified colors, empty',
    spTree: shapes(
      p(r('a', '<a:rPr/>'), '<a:pPr><a:defRPr sz="2000" b="1" i="0" cap="small"><a:solidFill><a:srgbClr val="FF8800"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="Tahoma"/></a:defRPr></a:pPr>') +
        p(r('b', '<a:rPr/>'), '<a:pPr><a:defRPr><a:solidFill><a:schemeClr val="accent3"><a:lumOff val="20000"/></a:schemeClr></a:solidFill><a:latin typeface="Arial"/><a:ea typeface=""/></a:defRPr></a:pPr>') +
        p(r('c', '<a:rPr sz="1000" b="0"/>'), '<a:pPr><a:defRPr sz="3600" b="1" i="1"/></a:pPr>') +
        p(r('d'), '<a:pPr><a:defRPr/></a:pPr>') +
        p(r('e'), '<a:pPr><a:defRPr sz="x"><a:latin typeface="+mj-lt"/></a:defRPr></a:pPr>') +
        p(r('f'), '<a:pPr><a:defRPr lang="ja-JP"><a:ea typeface="+mn-ea"/></a:defRPr></a:pPr>'),
    ),
    ctx: CTX,
  },
  {
    name: 'paragraph defRPr over a placeholder chain: sources, concrete faces replacing theme references',
    spTree: sp(
      tx(
        p(r('chain only', '<a:rPr/>')) +
          p(r('defRPr size and color', '<a:rPr/>'), '<a:pPr><a:defRPr sz="1400"><a:solidFill><a:srgbClr val="010203"/></a:solidFill></a:defRPr></a:pPr>') +
          p(r('concrete latin and ea', '<a:rPr/>'), '<a:pPr><a:defRPr><a:latin typeface="Verdana"/><a:ea typeface="Meiryo"/></a:defRPr></a:pPr>') +
          p(r('theme latin and ea', '<a:rPr/>'), '<a:pPr><a:defRPr><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:pPr>') +
          p(r('\u6F22\u5B57', '<a:rPr/>'), '<a:pPr><a:defRPr b="0"/></a:pPr>') +
          p(r('run face', '<a:rPr><a:latin typeface="+mn-lt"/></a:rPr>')) +
          p(r('run cs', '<a:rPr><a:cs typeface="Tahoma"/></a:rPr>')) +
          p(r('\u05D0\u05D1', '<a:rPr/>')),
      ),
      BODY_PH,
    ),
    ctx: PH_CTX,
  },
  {
    name: 'title placeholder: major theme face through the chain',
    spTree: sp(tx(p(r('Title', '<a:rPr/>')) + p(r('\u6F22', '<a:rPr/>'))), '<p:ph type="title"/>'),
    ctx: PH_CTX,
  },
  {
    name: 'shape lstStyle levels and the presentation default text style',
    spTree:
      sp(
        tx(
          p(r('lvl1', '<a:rPr/>')) +
            p(r('lvl2', '<a:rPr/>'), '<a:pPr lvl="1"/>') +
            p(r('lvl5 missing', '<a:rPr/>'), '<a:pPr lvl="4"/>'),
          '<a:bodyPr/>',
          '<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr" rtl="1"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc>' +
            '<a:buFont typeface="Wingdings"/><a:buChar char="\uF0A7"/><a:defRPr sz="2800" b="1" i="1" cap="all">' +
            '<a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/>' +
            '<a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="457200"><a:buAutoNum type="arabicPeriod" startAt="5"/>' +
            '<a:defRPr sz="1600"/></a:lvl2pPr></a:lstStyle>',
        ),
      ) + sp(tx(p(r('default text style', '<a:rPr/>')))),
    ctx: PH_CTX,
  },
  {
    name: 'p:style fontRef color between the shape lstStyle and the chain',
    spTree: sp(
      tx(p(r('fontRef color', '<a:rPr/>')) + p(r('own fill', '<a:rPr><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:rPr>'))),
      '',
      '<p:style><a:lnRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef>' +
        '<a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>',
    ),
    ctx: PH_CTX,
  },

  // ── parseParagraph: paragraph marks ───────────────────────────────
  {
    name: 'paragraph marks: empty paragraph, empty run, whitespace run, self-closing mark, two marks',
    spTree: shapes(
      p('<a:endParaRPr lang="en-US" sz="8000"/>') +
        p(r('', '<a:rPr sz="1000"/>') + '<a:endParaRPr lang="en-US" sz="4000" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:endParaRPr>') +
        p(r(' ') + '<a:endParaRPr sz="4000"/>') +
        p('<a:endParaRPr/>') +
        p('<a:endParaRPr sz="1"/><a:endParaRPr sz="2"/>') +
        '<a:p/>' +
        '<a:p></a:p>' +
        p('<a:pPr><a:defRPr sz="2200"/></a:pPr><a:endParaRPr lang="en-US"/>'),
    ),
    ctx: CTX,
  },

  // ── parseTextBody: bodyPr ─────────────────────────────────────────
  {
    name: 'bodyPr anchors: every value, unknown, empty; anchorCtr in every form',
    spTree: withBodyPr(
      '<a:bodyPr anchor="t"/>',
      '<a:bodyPr anchor="ctr" anchorCtr="1"/>',
      '<a:bodyPr anchor="b" anchorCtr="true"/>',
      '<a:bodyPr anchor="just" anchorCtr="0"/>',
      '<a:bodyPr anchor="" anchorCtr=""/>',
      "<a:bodyPr anchor='dist' anchorCtr='false'/>",
      '<a:bodyPr anchorCtr="yes"/>',
    ),
  },
  {
    // ledger inherited-key-parse-3762: anchorMap[anchor] answers for Object.prototype's names
    name: 'bodyPr anchor named after Object.prototype members',
    spTree: withBodyPr(
      '<a:bodyPr anchor="constructor"/>',
      '<a:bodyPr anchor="toString"/>',
      '<a:bodyPr anchor="__proto__"/>',
      '<a:bodyPr anchor="valueOf"/>',
    ),
    seed: false,
  },
  {
    name: 'bodyPr insets: given, zero, text, negative, huge, missing',
    spTree: withBodyPr(
      '<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/>',
      '<a:bodyPr lIns="182880" tIns="x" rIns="-91440" bIns=""/>',
      '<a:bodyPr lIns="99999999999999999999" tIns="12.7"/>',
      '<a:bodyPr/>',
      '<a:bodyPr wrap="none"/>',
      '<a:bodyPr wrap="square"/>',
    ),
  },
  {
    name: 'bodyPr insets and anchors inherited from a placeholder',
    spTree:
      sp(tx(p(r('x')), '<a:bodyPr/>'), BODY_PH) +
      sp(tx(p(r('x')), '<a:bodyPr lIns="5" tIns="x"/>'), BODY_PH) +
      sp(tx(p(r('x')), '<a:bodyPr anchor="t"/>'), '<p:ph type="title"/>') +
      sp(tx(p(r('x')), '<a:bodyPr anchorCtr="0"/>'), '<p:ph type="body" idx="7"/>'),
    ctx: PH_CTX,
  },
  {
    name: 'bodyPr autofit: shrink with ratios, ratios zero, negative and text, resize, both, none',
    spTree: withBodyPr(
      '<a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit fontScale="0" lnSpcReduction="-5"/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit fontScale="x" lnSpcReduction="10000.9"/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit/></a:bodyPr>',
      '<a:bodyPr><a:spAutoFit/></a:bodyPr>',
      '<a:bodyPr><a:spAutoFit/><a:normAutofit fontScale="90000"/></a:bodyPr>',
      '<a:bodyPr><a:noAutofit/></a:bodyPr>',
      '<a:bodyPr><a:normAutofit fontScale="100000"/><a:normAutofit fontScale="50000"/></a:bodyPr>',
    ),
  },
  {
    name: 'bodyPr vertical text and columns',
    spTree: withBodyPr(
      '<a:bodyPr vert="eaVert"/>',
      '<a:bodyPr vert="vert"/>',
      '<a:bodyPr vert="vert270"/>',
      '<a:bodyPr vert="wordArtVert"/>',
      '<a:bodyPr vert="horz"/>',
      '<a:bodyPr vert="mongolianVert"/>',
      '<a:bodyPr numCol="2" spcCol="91440"/>',
      '<a:bodyPr numCol="3"/>',
      '<a:bodyPr numCol="1" spcCol="91440"/>',
      '<a:bodyPr numCol="x" spcCol="y"/>',
      '<a:bodyPr numCol="2.5" spcCol="x"/>',
    ),
  },
  {
    name: 'bodyPr text extrusion: depth, color, camera tilt, missing pieces',
    spTree: withBodyPr(
      '<a:bodyPr><a:scene3d><a:camera prst="orthographicFront"><a:rot lat="1200000" lon="-600000" rev="0"/></a:camera><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d extrusionH="76200"><a:extrusionClr><a:srgbClr val="FF0000"/></a:extrusionClr></a:sp3d></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="12700"/></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="12700"><a:extrusionClr/></a:sp3d></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="12700"><a:extrusionClr><a:schemeClr val="accent6"/></a:extrusionClr></a:sp3d></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="0"/></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="-5"/></a:bodyPr>',
      '<a:bodyPr><a:sp3d extrusionH="x"/></a:bodyPr>',
      '<a:bodyPr><a:sp3d/></a:bodyPr>',
      '<a:bodyPr><a:scene3d><a:camera prst="perspectiveFront"><a:rot lat="x" lon=""/></a:camera></a:scene3d><a:sp3d extrusionH="1"/></a:bodyPr>',
    ),
    ctx: CTX,
  },
  {
    name: 'bodyPr preset text warp: adjustments, no-op presets, malformed guides, integer names',
    spTree: withBodyPr(
      '<a:bodyPr><a:prstTxWarp prst="textArchUp"><a:avLst><a:gd name="adj" fmla="val 10800000"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textWave1"><a:avLst><a:gd name="adj1" fmla="val -5"/><a:gd name="adj2" fmla="val 0"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textInflate"><a:avLst/></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textInflate"><a:avLst><a:gd name="adj" fmla="val x"/><a:gd fmla="val 3"/><a:gd name="adj2" fmla="pin 0 adj 100"/><a:gd name="adj3"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textChevron"><a:avLst><a:gd name="10" fmla="val 1"/><a:gd name="b" fmla="val 2"/><a:gd name="2" fmla="val 3"/><a:gd name="a" fmla="val -0"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textChevron"><a:avLst><a:gd name="constructor" fmla="val 1"/><a:gd name="toString" fmla="val 2"/><a:gd name="__proto__" fmla="val 3"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textChevron"><a:avLst><a:gd name="__proto__" fmla="val 3"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textChevron"><a:avLst><a:gd name="adj" fmla="val 1"/><a:gd name="adj" fmla="val 2"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textNoShape"><a:avLst><a:gd name="adj" fmla="val 1"/></a:avLst></a:prstTxWarp></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textPlain"/></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst=""/></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp/></a:bodyPr>',
      '<a:bodyPr><a:prstTxWarp prst="textCircle"><a:avLst><a:gd name="adj" fmla="val  7"/><a:gd name="adj2" fmla="val 99999999999999999999"/></a:avLst></a:prstTxWarp></a:bodyPr>',
    ),
  },
  {
    name: 'text body shapes: no paragraphs, bodyPr twice, a body that is text',
    spTree:
      sp('<a:bodyPr/><a:lstStyle/>') +
      sp('<a:bodyPr anchor="ctr"/><a:bodyPr anchor="b"/><a:lstStyle/><a:p><a:r><a:t>x</a:t></a:r></a:p>') +
      sp('stray text') +
      sp('<a:bodyPr/><a:lstStyle/><a:lstStyle><a:lvl1pPr algn="r"/></a:lstStyle><a:p><a:r><a:t>two lstStyles</a:t></a:r></a:p>'),
  },
]
