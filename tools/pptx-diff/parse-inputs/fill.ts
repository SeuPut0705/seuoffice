// Slides that reach the fill section of parse.ts: blipEmbedId, svgBlipEmbedId,
// blipMediaRef, parseLum, parseBiLevel, parseDuotone, parseClrChange, parseFill,
// parseGradFill, resolveColorNode, xmlAttrEsc, nonPlainColorNode, colorNodeXml.

let nextId = 10
/** One p:sp per fill, its spPr holding the fill XML. */
const sp = (fill: string, text = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${nextId++}" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>${text}</p:sp>`
const pic = (blipFill: string): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${nextId++}" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>${blipFill}<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`
const run = (rPr: string): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US">${rPr}</a:rPr><a:t>x</a:t></a:r></a:p></p:txBody>`
const many = (...fills: string[]): string => fills.map((f) => sp(f)).join('')

const THEME = {
  colors: {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
    accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
    accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  },
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
}
const MEDIA = [
  ['rId1', 'ppt/media/image1.png'],
  ['rId2', 'ppt/media/image2.svg'],
  ['rIdEmpty', ''],
  ['constructor', 'ppt/media/ctor.png'],
]
const CTX = { theme: THEME, mediaRels: MEDIA }

const blip = (blipInner: string, rest = '<a:stretch><a:fillRect/></a:stretch>', attrs = ' r:embed="rId1"'): string =>
  `<a:blipFill><a:blip${attrs}>${blipInner}</a:blip>${rest}</a:blipFill>`
const gs = (pos: string, clr: string): string => `<a:gs pos="${pos}">${clr}</a:gs>`
const SRGB = (v: string, kids = ''): string => (kids ? `<a:srgbClr val="${v}">${kids}</a:srgbClr>` : `<a:srgbClr val="${v}"/>`)
const grad = (inner: string, attrs = ''): string =>
  `<a:gradFill${attrs}><a:gsLst>${gs('0', SRGB('FF0000'))}${gs('100000', SRGB('0000FF'))}</a:gsLst>${inner}</a:gradFill>`

export const SLIDES: Array<{ name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }> = [
  // ── parseFill: early kinds ──
  { name: 'fill none and absent', spTree: many('<a:noFill/>', '', '<a:noFill/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>') },
  { name: 'fill grpFill without group', spTree: many('<a:grpFill/>') },
  { name: 'fill grpFill with group fill', spTree: many('<a:grpFill/>'), ctx: { groupFill: { type: 'solid', color: '#123456' } } },
  {
    name: 'fill grpFill in a group',
    spTree: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></p:grpSpPr>${sp('<a:grpFill/>')}</p:grpSp>`,
  },
  // ── solid ──
  {
    name: 'fill solid every color kind',
    spTree: many(
      '<a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>',
      '<a:solidFill><a:srgbClr val="ff8800"><a:alpha val="50000"/></a:srgbClr></a:solidFill>',
      '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/><a:lumOff val="25000"/></a:schemeClr></a:solidFill>',
      '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>',
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
      '<a:solidFill><a:sysClr val="windowText" lastClr="000000"/></a:solidFill>',
      '<a:solidFill><a:prstClr val="black"/></a:solidFill>',
      '<a:solidFill><a:hslClr hue="0" sat="100000" lum="50000"/></a:solidFill>',
      '<a:solidFill><a:scrgbClr r="100000" g="0" b="0"/></a:solidFill>',
      '<a:solidFill/>',
      '<a:solidFill><a:srgbClr/></a:solidFill>',
      "<a:solidFill><a:srgbClr val='00FF00'/></a:solidFill>",
    ),
    ctx: CTX,
  },
  { name: 'fill solid phClr with phClr ctx', spTree: many('<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill>'), ctx: { ...CTX, phClr: '#336699' } },
  { name: 'fill solid scheme without theme', spTree: many('<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>') },
  // ── gradient ──
  {
    name: 'grad lin and path forms',
    spTree: many(
      grad('<a:lin ang="2700000" scaled="1"/>'),
      grad('<a:lin ang="2700000" scaled="true"/>'),
      grad('<a:lin ang="2700000" scaled="0"/>'),
      grad('<a:lin/>'),
      grad('<a:lin ang="abc"/>'),
      grad('<a:lin ang="-5400000"/>'),
      grad(''),
      grad('<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'),
      grad('<a:path path="rect"><a:fillToRect l="50%" t="25.5%" r=" 10% " b="x"/></a:path>'),
      grad('<a:path path="shape"><a:fillToRect/></a:path>'),
      grad('<a:path path="other"><a:fillToRect r="100000"/></a:path>'),
      grad('<a:path/>'),
      grad('<a:path path="circle"/><a:lin ang="60000"/>'),
      grad('<a:lin ang="0"/><a:tileRect/>'),
      grad('<a:lin ang="0"/><a:tileRect l="-50000" r="-50000"/>'),
      grad('<a:lin ang="0"/><a:tileRect l="0" t="0" r="0" b="0"/>'),
      grad('<a:lin ang="0"/><a:tileRect b="10%"/>'),
      grad('', ' flip="xy" rotWithShape="1"'),
    ),
    ctx: CTX,
  },
  {
    name: 'grad stop forms',
    spTree: many(
      '<a:gradFill><a:gsLst><a:gs pos="50000"><a:schemeClr val="accent2"/></a:gs></a:gsLst></a:gradFill>',
      '<a:gradFill><a:gsLst><a:gs pos="abc"><a:srgbClr val="010203"/></a:gs><a:gs><a:srgbClr val="040506"/></a:gs><a:gs pos="-1000"><a:srgbClr val="070809"/></a:gs><a:gs pos="250000"><a:srgbClr val="0A0B0C"/></a:gs><a:gs pos="33333.9"><a:srgbClr val="0D0E0F"/></a:gs></a:gsLst></a:gradFill>',
      '<a:gradFill><a:gsLst><a:gs pos="0"/><a:gs pos="100000"/></a:gsLst></a:gradFill>',
      '<a:gradFill><a:gsLst><a:gs pos="0"/><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill>',
      '<a:gradFill><a:gsLst/></a:gradFill>',
      '<a:gradFill/>',
      '<a:gradFill><a:lin ang="0"/></a:gradFill>',
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="10000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill>',
    ),
    ctx: { ...CTX, phClr: '#AA5500' },
  },
  // ── image fills ──
  {
    name: 'blip stretch and tile forms',
    spTree: many(
      blip(''),
      blip('', '<a:stretch/>'),
      blip('', '<a:stretch><a:fillRect l="10000" t="-20000" r="abc" b="5000"/></a:stretch>'),
      blip('', '<a:stretch><a:fillRect r="0"/></a:stretch>'),
      blip('', '<a:tile/>'),
      blip('', '<a:tile tx="100" ty="-200" sx="50000" sy="abc" algn="ctr" flip="none"/>'),
      blip('', '<a:tile algn=""/>'),
      blip('', '<a:srcRect/><a:tile tx="1"/><a:stretch><a:fillRect l="1"/></a:stretch>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip embed and svg lookup',
    spTree: many(
      blip('', undefined, ''),
      blip('', undefined, ' r:embed=""'),
      blip('', undefined, ' r:embed="rIdMissing"'),
      blip('', undefined, ' r:embed="rIdEmpty"'),
      blip('<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/></a:ext></a:extLst>'),
      blip('<a:extLst><a:ext uri="x"><asvg:svgBlip r:embed="rId2"/></a:ext></a:extLst>', undefined, ''),
      blip('<a:extLst><a:ext uri="a"><a14:useLocalDpi val="0"/></a:ext><a:ext uri="b"><svgBlip r:embed="rId2"/></a:ext></a:extLst>', undefined, ''),
      blip('<a:extLst><a:ext uri="b"><x:svgBlip r:embed="rIdMissing"/></a:ext></a:extLst>'),
      blip('<a:extLst><a:ext uri="b"><x:svgBlip/><y:svgBlip r:embed="rId2"/></a:ext></a:extLst>', undefined, ''),
      blip('<a:extLst><a:ext uri="b"><x:svgBlipX r:embed="rId2"/></a:ext></a:extLst>', undefined, ''),
      blip('<a:extLst><a:ext uri="x"><asvg:svgBlip r:embed="rId2"/></a:ext></a:extLst>', undefined, ' r:embed=""'),
      '<a:blipFill><a:stretch/></a:blipFill>',
      '<a:blipFill/>',
    ),
    ctx: CTX,
  },
  // mediaRels is a Map: an rId named after an inherited key is an ordinary key (no defect)
  { name: 'blip embed named constructor', spTree: many(blip('', undefined, ' r:embed="constructor"'), blip('', undefined, ' r:embed="toString"')), ctx: CTX },
  {
    name: 'blip alphaModFix',
    spTree: many(
      blip('<a:alphaModFix amt="50000"/>'),
      blip('<a:alphaModFix amt="100000"/>'),
      blip('<a:alphaModFix amt="150000"/>'),
      blip('<a:alphaModFix amt="-10"/>'),
      blip('<a:alphaModFix amt="abc"/>'),
      blip('<a:alphaModFix/>'),
      blip('<a:alphaModFix amt="99999.9"/>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip lum',
    spTree: many(
      blip('<a:lum bright="20000" contrast="-40000"/>'),
      blip('<a:lum bright="0" contrast="0"/>'),
      blip('<a:lum/>'),
      blip('<a:lum bright="300000"/>'),
      blip('<a:lum contrast="-300000"/>'),
      blip('<a:lum bright="abc" contrast="12.9"/>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip biLevel and grayscl',
    spTree: many(
      blip('<a:biLevel thresh="25000"/>'),
      blip('<a:biLevel/>'),
      blip('<a:biLevel thresh="abc"/>'),
      blip('<a:biLevel thresh="-5"/>'),
      blip('<a:biLevel thresh="250000"/>'),
      blip('<a:grayscl/>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip duotone',
    spTree: many(
      blip('<a:duotone><a:prstClr val="black"/><a:schemeClr val="accent1"><a:tint val="45000"/></a:schemeClr></a:duotone>'),
      blip('<a:duotone><a:schemeClr val="bg1"/><a:prstClr val="black"/></a:duotone>'),
      blip('<a:duotone><a:srgbClr val="FFFFFF"/><a:srgbClr val="000000"/></a:duotone>'),
      blip('<a:duotone><a:schemeClr val="accent2"/><a:schemeClr val="accent1"/><a:schemeClr val="accent3"/></a:duotone>'),
      blip('<a:duotone><a:srgbClr val="FFFFFF"/><a:sysClr val="windowText" lastClr="000000"/></a:duotone>'),
      blip('<a:duotone><a:srgbClr val="FFFFFF"/></a:duotone>'),
      blip('<a:duotone><a:srgbClr/><a:srgbClr val="000000"/></a:duotone>'),
      blip('<a:duotone/>'),
      blip('<a:duotone/><a:grayscl/>'),
      blip('<a:duotone><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr><a:prstClr val="white"/></a:duotone>'),
      blip('<a:duotone><a:hslClr hue="0" sat="0" lum="0"/><a:scrgbClr r="0" g="0" b="0"/></a:duotone>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip clrChange',
    spTree: many(
      blip('<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>'),
      blip('<a:clrChange><a:clrFrom><a:schemeClr val="accent1"/></a:clrFrom></a:clrChange>'),
      blip('<a:clrChange><a:clrTo><a:srgbClr val="000000"/></a:clrTo></a:clrChange>'),
      blip('<a:clrChange/>'),
      blip('<a:clrChange useA="1"><a:clrFrom/><a:clrTo/></a:clrChange>'),
    ),
    ctx: CTX,
  },
  {
    name: 'blip every effect at once',
    spTree: many(
      blip(
        '<a:alphaModFix amt="40000"/><a:duotone><a:prstClr val="black"/><a:srgbClr val="FF0000"/></a:duotone><a:clrChange><a:clrFrom><a:srgbClr val="00FF00"/></a:clrFrom><a:clrTo><a:srgbClr val="0000FF"/></a:clrTo></a:clrChange><a:lum bright="10000"/><a:biLevel thresh="60000"/>',
        '<a:tile sx="200000"/>',
      ),
    ),
    ctx: CTX,
  },
  { name: 'blip without media rels', spTree: many(blip('')) },
  { name: 'blip picture element', spTree: pic(blip('<a:duotone><a:prstClr val="black"/><a:srgbClr val="00FF00"/></a:duotone>')), ctx: CTX },
  // ── pattern ──
  {
    name: 'pattern forms',
    spTree: many(
      '<a:pattFill prst="ltDnDiag"><a:fgClr><a:schemeClr val="accent1"/></a:fgClr><a:bgClr><a:schemeClr val="bg1"/></a:bgClr></a:pattFill>',
      '<a:pattFill/>',
      '<a:pattFill prst=""/>',
      '<a:pattFill prst="cross"><a:fgClr/></a:pattFill>',
      "<a:pattFill prst='horz'><a:bgClr><a:prstClr val='red'/></a:bgClr></a:pattFill>",
    ),
    ctx: CTX,
  },
  // ── precedence ──
  {
    name: 'fill precedence',
    spTree: many(
      '<a:solidFill/><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill>',
      '<a:gradFill/><a:pattFill prst="cross"/>',
      `${blip('', undefined, ' r:embed="rIdMissing"')}<a:pattFill prst="cross"/>`,
      `<a:grpFill/>${blip('')}`,
    ),
    ctx: CTX,
  },
  // ── colorNodeXml / nonPlainColorNode / xmlAttrEsc, reached through run colors ──
  {
    name: 'run color node xml',
    spTree: [
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
      '<a:solidFill><a:srgbClr val="FF0000"><a:lumMod val="50000"/><a:lumMod val="80000"/><a:alpha val="1"/></a:srgbClr></a:solidFill>',
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>',
      '<a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr></a:solidFill>',
      '<a:solidFill><a:prstClr val="red"/></a:solidFill>',
      '<a:solidFill><a:sysClr val="window" lastClr="FFFFFF"/></a:solidFill>',
      '<a:solidFill><a:hslClr hue="1" sat="2" lum="3"><a:shade val="4"/></a:hslClr></a:solidFill>',
      '<a:solidFill><a:scrgbClr r="1" g="2" b="3"/></a:solidFill>',
      '<a:solidFill><a:srgbClr val="A&amp;B&lt;C&quot;D&gt;E\'"/></a:solidFill>',
      "<a:solidFill><a:schemeClr val='a&amp;&quot;'><a:lumMod val='&lt;1'/></a:schemeClr></a:solidFill>",
      '<a:solidFill><a:srgbClr val="FF0000"/><a:srgbClr val="00FF00"/></a:solidFill>',
      '<a:solidFill><a:schemeClr val="accent1"><a:lumMod/></a:schemeClr></a:solidFill>',
      '<a:solidFill><a:schemeClr/></a:solidFill>',
      '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="1"><a:x/></a:lumMod><b:other z="1"/></a:schemeClr></a:solidFill>',
      '<a:solidFill><a:srgbClr val="\u{1F600}"/></a:solidFill>',
    ]
      .map((f) => sp('', run(f)))
      .join(''),
    ctx: CTX,
  },
]
