// Slides that reach the picture section of parse.ts: parsePicture, parseSrcRect,
// parseChartUserLines, parseChartUserShapes, graphicFramePassthrough,
// diagramTextColors, parseDiagramDrawing, splitDiagramParagraphs and
// findDescendantPic.

const THEME = {
  colors: {
    dk1: '#000000',
    lt1: '#FFFFFF',
    dk2: '#44546A',
    lt2: '#E7E6E6',
    accent1: '#4472C4',
    accent2: '#ED7D31',
    accent3: '#A5A5A5',
    accent4: '#FFC000',
    accent5: '#5B9BD5',
    accent6: '#70AD47',
    hlink: '#0563C1',
    folHlink: '#954F72',
  },
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
}
const MEDIA = [
  ['rId2', 'ppt/media/image1.png'],
  ['rId3', 'ppt/media/image2.svg'],
  ['rIdEmpty', ''],
  ['constructor', 'ppt/media/ctor.png'],
]
const BASE = { theme: THEME, mediaRels: MEDIA }

// ── p:pic ──────────────────────────────────────────────────────────────

const xfrm = (x = '100', y = '200', cx = '3000000', cy = '2000000', attrs = ''): string =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

interface PicOpts {
  cNvPr?: string
  nvPr?: string
  blipFill?: string
  spPr?: string
  /** replaces the whole <p:spPr> element */
  spPrEl?: string
}
const pic = (o: PicOpts = {}): string =>
  `<p:pic><p:nvPicPr>${o.cNvPr ?? '<p:cNvPr id="4" name="Picture 3"/>'}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${o.nvPr ?? ''}</p:nvPr></p:nvPicPr>` +
  (o.blipFill ??
    '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>') +
  (o.spPrEl ??
    `<p:spPr>${o.spPr ?? `${xfrm()}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`}</p:spPr>`) +
  '</p:pic>'
const blipFill = (
  blip: string,
  rest = '<a:stretch><a:fillRect/></a:stretch>',
  attrs = '',
): string => `<p:blipFill${attrs}>${blip}${rest}</p:blipFill>`
const many = (...pics: string[]): string => pics.join('')

const CUST_GEOM =
  '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="2000000" h="1000000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="2000000" y="0"/></a:lnTo><a:lnTo><a:pt x="1500000" y="1000000"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>'
const REDACT =
  '<a:extLst><a:ext uri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}" xmlns:go="urn:seuoffice"><go:redact label="face"/></a:ext></a:extLst>'
const SVG_BLIP =
  '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId3"/></a:ext></a:extLst>'

const transform = (x: number, y: number, cx: number, cy: number) => ({
  offset: { x, y, cx, cy },
  rot: 0,
  flipH: false,
  flipV: false,
})
const PLACEHOLDERS = {
  layoutPlaceholders: {
    entries: [
      {
        type: 'pic',
        idx: '13',
        transform: transform(500, 600, 4000000, 3000000),
        presetGeom: { prst: 'ellipse' },
      },
      {
        type: 'body',
        idx: '1',
        transform: transform(700, 800, 5000000, 2500000),
        presetGeom: {
          prst: 'roundRect',
          avLstRaw: { 'a:gd': { '@_name': 'adj', '@_fmla': 'val 30000' } },
        },
      },
      { type: 'obj', idx: '2', transform: null },
    ],
  },
  masterPlaceholders: {
    entries: [
      {
        type: 'pic',
        idx: '20',
        transform: transform(1, 2, 3, 4),
        presetGeom: { prst: 'parallelogram' },
      },
    ],
  },
}

const VIDEO = '<a:videoFile r:link="rId5"/>'
const P14 = (embed: string, uri = '{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}'): string =>
  `<p:extLst><p:ext uri="${uri}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${embed}"/></p:ext></p:extLst>`
const AV_RELS = [
  ['rId5', { target: 'ppt/media/media1.mp4' }],
  ['rId6', { target: 'https://example.com/clip.MP3', external: true }],
  ['rId7', { target: 'ppt/media/media2.m4a', external: false }],
  ['rId8', { target: 'ppt/media/media3.wmv' }],
  ['', { target: 'ppt/media/empty-key.wav' }],
]

const PICTURES: Array<{
  name: string
  spTree: string
  ctx?: Record<string, unknown>
  seed?: false
}> = [
  { name: 'pic plain', spTree: pic(), ctx: BASE },
  { name: 'pic without context', spTree: pic() },
  {
    name: 'pic descr, name absent and empty',
    spTree: many(
      pic({ cNvPr: '<p:cNvPr id="4" name="P" descr="A cat"/>' }),
      pic({ cNvPr: '<p:cNvPr id="5"/>' }),
      pic({ cNvPr: '<p:cNvPr id="6" name="" descr=""/>' }),
      pic({ cNvPr: "<p:cNvPr id='7' name='single' descr='quoted'/>" }),
      pic({ cNvPr: '<p:cNvPr id="8" name="a"/><p:cNvPr id="9" name="b"/>' }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic media refs',
    spTree: many(
      pic({ blipFill: blipFill('<a:blip r:embed="rIdMissing"/>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rIdEmpty"/>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="constructor"/>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="__proto__"/>') }),
      pic({ blipFill: blipFill(`<a:blip r:embed="rId2">${SVG_BLIP}</a:blip>`) }),
      pic({ blipFill: blipFill(`<a:blip>${SVG_BLIP}</a:blip>`) }),
      pic({ blipFill: blipFill('<a:blip/>') }),
      pic({ blipFill: '' }),
      pic({ blipFill: '<p:blipFill/>' }),
      pic({
        blipFill: blipFill('<a:blip r:embed="rId2"/>') + blipFill('<a:blip r:embed="rId3"/>'),
      }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic srcRect',
    spTree: many(
      pic({
        blipFill: blipFill(
          '<a:blip r:embed="rId2"/>',
          '<a:srcRect l="10000" t="20000" r="30000" b="40000"/><a:stretch/>',
        ),
      }),
      pic({
        blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:srcRect l="0" t="0" r="0" b="0"/>'),
      }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:srcRect/>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:srcRect b="-5000"/>') }),
      pic({
        blipFill: blipFill(
          '<a:blip r:embed="rId2"/>',
          '<a:srcRect l="abc" t="12.9" r="1e5" b=" 7"/>',
        ),
      }),
      pic({
        blipFill: blipFill(
          '<a:blip r:embed="rId2"/>',
          "<a:srcRect l='2500' r='99999999999999999999999'/>",
        ),
      }),
      pic({
        blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:srcRect l="1"/><a:srcRect t="2"/>'),
      }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:srcRect>text</a:srcRect>') }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic tile',
    spTree: many(
      pic({
        blipFill: blipFill(
          '<a:blip r:embed="rId2"/>',
          '<a:tile tx="0" ty="0" sx="100000" sy="100000" algn="tl"/>',
        ),
      }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:tile/>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"/>', '<a:tile/><a:tile/>') }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic preset geometry',
    spTree: many(
      pic({ spPr: `${xfrm()}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>` }),
      pic({
        spPr: `${xfrm()}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>`,
      }),
      pic({
        spPr: `${xfrm()}<a:prstGeom prst="rect"><a:avLst><a:gd name="adj" fmla="val 1"/></a:avLst></a:prstGeom>`,
      }),
      pic({ spPr: `${xfrm()}<a:prstGeom prst=""/>` }),
      pic({ spPr: `${xfrm()}<a:prstGeom/>` }),
      pic({ spPr: xfrm() }),
      pic({ spPrEl: '<p:spPr/>' }),
      pic({ spPrEl: '' }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic custGeom from the fragment',
    spTree: many(
      pic({ spPr: `${xfrm('0', '0', '2000000', '1000000')}${CUST_GEOM}` }),
      pic({ spPr: `${xfrm('0', '0', '0', '0')}${CUST_GEOM}` }),
      pic({ spPr: `${xfrm()}<a:custGeom/>` }),
      pic({ spPr: `${xfrm()}<a:prstGeom prst="ellipse"/>${CUST_GEOM}` }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic placeholder inheritance',
    spTree: many(
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: '' }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: '<a:xfrm><a:off x="9" y="9"/></a:xfrm>' }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: xfrm() }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: `${xfrm()}<a:prstGeom prst="star5"/>` }),
      pic({ nvPr: '<p:ph idx="1"/>', spPr: '' }),
      pic({ nvPr: '<p:ph type="pic" idx="20"/>', spPr: '' }),
      pic({ nvPr: '<p:ph type="pic" idx="99"/>', spPr: '' }),
      pic({ nvPr: '<p:ph idx="2"/>', spPr: '' }),
      pic({ nvPr: '<p:ph/>', spPr: '' }),
      pic({ nvPr: '<p:ph>text</p:ph>', spPr: '' }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/><p:ph type="body" idx="1"/>', spPr: '' }),
      pic({ nvPr: '<p:ph type="constructor" idx="__proto__"/>', spPr: '' }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: '<a:custGeom/>' }),
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: CUST_GEOM }),
      pic({ nvPr: "<p:ph type='pic' idx='13'/>", spPr: '<a:prstGeom prst=""/>' }),
    ),
    ctx: { ...BASE, ...PLACEHOLDERS },
  },
  {
    name: 'pic placeholder without placeholder maps',
    spTree: pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: '' }),
    ctx: BASE,
  },
  {
    name: 'pic opacity and soft edge',
    spTree: many(
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="50000"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="100000"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="120000"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="-5000"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="-0"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="abc"/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt=""/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix/></a:blip>') }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:alphaModFix amt="33333.9"/></a:blip>') }),
      pic({ spPr: `${xfrm()}<a:effectLst><a:softEdge rad="63500"/></a:effectLst>` }),
      pic({ spPr: `${xfrm()}<a:effectLst><a:softEdge rad="x"/></a:effectLst>` }),
      pic({ spPr: `${xfrm()}<a:effectLst><a:softEdge rad=""/></a:effectLst>` }),
      pic({ spPr: `${xfrm()}<a:effectLst><a:softEdge/></a:effectLst>` }),
      pic({
        spPr: `${xfrm()}<a:effectLst><a:softEdge rad="-12"/><a:glow rad="10"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>`,
      }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic effects, fill and blip adjustments',
    spTree: many(
      pic({
        spPr: `${xfrm('0', '0', '100', '100', ' rot="5400000" flipH="1"')}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln w="12700"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln><a:effectLst><a:glow rad="63500"><a:schemeClr val="accent1"><a:alpha val="40000"/></a:schemeClr></a:glow><a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl"><a:prstClr val="black"><a:alpha val="40000"/></a:prstClr></a:outerShdw><a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT/></a:sp3d>`,
      }),
      pic({ spPr: `${xfrm()}<a:ln><a:noFill/></a:ln>` }),
      pic({
        blipFill: blipFill(
          '<a:blip r:embed="rId2"><a:duotone><a:schemeClr val="accent1"/><a:srgbClr val="FFFFFF"/></a:duotone><a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange><a:lum bright="20000" contrast="-10000"/><a:biLevel thresh="50000"/></a:blip>',
        ),
      }),
      pic({ blipFill: blipFill('<a:blip r:embed="rId2"><a:grayscl/><a:biLevel/></a:blip>') }),
      pic({ spPr: `${xfrm()}${REDACT}` }),
      pic({
        spPr: `${xfrm()}<a:extLst><a:ext uri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}"><go:redact label=""/></a:ext></a:extLst>`,
      }),
    ),
    ctx: BASE,
  },
  {
    name: 'pic audio and video',
    spTree: many(
      pic({ nvPr: VIDEO }),
      pic({ nvPr: '<a:audioFile r:link="rId6"/>' }),
      pic({ nvPr: '<a:videoFile r:link="rId7"/>' }),
      pic({ nvPr: '<a:videoFile r:link="rIdMissing"/>' }),
      pic({ nvPr: '<a:videoFile r:link=""/>' }),
      pic({ nvPr: '<a:videoFile/>' }),
      pic({ nvPr: '<a:audioFile/>' }),
      pic({ nvPr: '<a:audioFile r:link="rId5"/><a:videoFile r:link="rId6"/>' }),
      pic({ nvPr: '<a:videoFile r:link="constructor"/>' }),
      pic({ nvPr: `${VIDEO}${P14('rId6')}` }),
      pic({ nvPr: P14('rId5') }),
      pic({ nvPr: P14('rId6') }),
      pic({ nvPr: P14('rId7') }),
      pic({ nvPr: P14('rId8') }),
      pic({ nvPr: P14('rIdMissing') }),
      pic({ nvPr: P14('') }),
      pic({ nvPr: P14('toString') }),
      pic({
        nvPr: '<p:extLst><p:ext uri="{X}"><p14:creationId val="1"/></p:ext><p:ext uri="{Y}"><p14:media r:embed="rId6"/></p:ext></p:extLst>',
      }),
      pic({ nvPr: '<p:extLst><p:ext uri="{X}"/></p:extLst>' }),
      pic({ nvPr: '<p:extLst/>' }),
    ),
    ctx: { ...BASE, avRels: AV_RELS },
  },
  {
    name: 'pic media without avRels',
    spTree: many(pic({ nvPr: VIDEO }), pic({ nvPr: P14('rId6') })),
    ctx: BASE,
  },
  {
    name: 'pic in a group: custGeom from the group bytes',
    spTree:
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1000000"/></a:xfrm></p:grpSpPr>' +
      pic({ spPr: `${xfrm('0', '0', '2000000', '1000000')}${CUST_GEOM}` }) +
      pic({ nvPr: '<p:ph type="pic" idx="13"/>', spPr: '' }) +
      '</p:grpSp>',
    ctx: { ...BASE, ...PLACEHOLDERS },
  },
  {
    name: 'pic as the fallback of mc:AlternateContent',
    spTree:
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p14"><p:contentPart r:id="rId9"/></mc:Choice><mc:Fallback>' +
      pic({ spPr: `${xfrm('0', '0', '2000000', '1000000')}${CUST_GEOM}` }) +
      '</mc:Fallback></mc:AlternateContent>',
    ctx: BASE,
  },
]

// ── charts ─────────────────────────────────────────────────────────────

const C_NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const CHARTEX_URI = 'http://schemas.microsoft.com/office/drawing/2014/chartex'

const barChart = (serSpPr = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace ${C_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
  `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>S1</c:v></c:tx>${serSpPr}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
  '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>' +
  '<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>'
const BAR = barChart()
const BAR_BLIP = barChart(
  '<c:spPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></c:spPr>',
)
const BAR_SCHEME = barChart(
  '<c:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></c:spPr>',
)
const NO_PLOT = `<c:chartSpace ${C_NS}><c:chart><c:plotArea><c:layout/></c:plotArea></c:chart></c:chartSpace>`

const CX_NS =
  'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const cxChart = (layout: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cx:chartSpace ${CX_NS}><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$4</cx:f><cx:lvl ptCount="3"><cx:pt idx="0">C1</cx:pt><cx:pt idx="1">C2</cx:pt><cx:pt idx="2">C3</cx:pt></cx:lvl></cx:strDim><cx:numDim type="size"><cx:f>Sheet1!$B$2:$B$4</cx:f><cx:lvl ptCount="3" formatCode="General"><cx:pt idx="0">50</cx:pt><cx:pt idx="1">100</cx:pt><cx:pt idx="2">200</cx:pt></cx:lvl></cx:numDim></cx:data></cx:chartData>` +
  `<cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="${layout}" uniqueId="{X}"><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`
const FUNNEL = cxChart('funnel')
const WATERFALL = cxChart('waterfall')

const OVERRIDE =
  '<a:themeOverride xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:clrScheme name="Custom"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="EEEEEE"/></a:lt1><a:accent1><a:srgbClr val="AA0000"/></a:accent1></a:clrScheme></a:themeOverride>'
const BROKEN_OVERRIDE =
  '<a:themeOverride><a:clrScheme name="x"><a:dk1><a:srgbClr val="111111"/></a:accent1></a:clrScheme></a:themeOverride>'

const CDR =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:cdr="http://schemas.openxmlformats.org/drawingml/2006/chartDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const from = (x: string, y: string): string =>
  `<cdr:from><cdr:x>${x}</cdr:x><cdr:y>${y}</cdr:y></cdr:from>`
const to = (x: string, y: string): string =>
  `<cdr:to><cdr:x>${x}</cdr:x><cdr:y>${y}</cdr:y></cdr:to>`
const cdrSp = (spPr: string, opts: { nv?: string; style?: string; tx?: string } = {}): string =>
  `<cdr:sp macro="" textlink="">${opts.nv ?? '<cdr:nvSpPr><cdr:cNvPr id="2" name="Overlay 1"/><cdr:cNvSpPr/></cdr:nvSpPr>'}<cdr:spPr>${spPr}</cdr:spPr>${opts.style ?? ''}${opts.tx ?? ''}</cdr:sp>`
const lineSp = (
  prst = 'line',
  ln = '<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>',
): string =>
  cdrSp(
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${ln}`,
  )
const cdrTx = (t: string): string =>
  `<cdr:txBody><a:bodyPr vertOverflow="clip" wrap="none" rtlCol="0"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>${t}</a:t></a:r></a:p></cdr:txBody>`
const STYLE =
  '<cdr:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></cdr:style>'
const rel = (inner: string): string => `<cdr:relSizeAnchor>${inner}</cdr:relSizeAnchor>`
const abs = (inner: string): string => `<cdr:absSizeAnchor>${inner}</cdr:absSizeAnchor>`
const userShapes = (...anchors: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:userShapes ${CDR}>${anchors.join('')}</c:userShapes>`

const USER_SHAPES = userShapes(
  rel(from('0.1', '0.5') + to('0.9', '0.5') + lineSp()),
  rel(
    from('0.2', '0.1') +
      to('0.2', '0.9') +
      lineSp(
        'straightConnector1',
        '<a:ln><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln>',
      ),
  ),
  rel(
    from('0', '0') +
      to('1', '1') +
      lineSp('line', '<a:ln w="0"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>'),
  ),
  rel(
    from('abc', '1e400') +
      to('', '-0.5') +
      lineSp('line', '<a:ln w="abc"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln>'),
  ),
  rel(from('0.3', '0.3') + to('0.4', '0.4') + lineSp('line', '<a:ln w="12700"><a:noFill/></a:ln>')),
  rel(from('0.3', '0.3') + to('0.4', '0.4') + lineSp('line', '')),
  rel(
    from('0.3', '0.3') +
      to('0.4', '0.4') +
      lineSp(
        'line',
        '<a:ln w="25400"><a:solidFill><a:srgbClr val="FF00FF"/></a:solidFill></a:ln>',
      ) +
      lineSp('rect'),
  ),
  rel(
    from('0.05', '0.05') +
      to('0.45', '0.25') +
      cdrSp(
        '<a:xfrm rot="600000" flipH="1" flipV="0"/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>',
        {
          nv: '<cdr:nvSpPr><cdr:cNvPr id="3" name="TextBox 2"/><cdr:cNvSpPr txBox="1"/></cdr:nvSpPr>',
          tx: cdrTx('Note'),
        },
      ),
  ),
  rel(
    from('0.5', '0.5') +
      to('0.4', '0.6') +
      cdrSp('<a:prstGeom prst="ellipse"/>', { tx: cdrTx('Negative width') }),
  ),
  rel(
    from('0.6', '0.6') +
      to('0.8', '0.9') +
      cdrSp('', { style: STYLE, tx: cdrTx('Styled, no spPr') }),
  ),
  rel(
    from('0.6', '0.1') +
      to('0.7', '0.2') +
      cdrSp(
        '<a:prstGeom prst="wedgeRectCallout"/><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill>',
        { nv: '' },
      ),
  ),
  rel(
    from('<b>0.1</b>', '0.1') +
      to('0.2', '0.2') +
      cdrSp('<a:prstGeom prst="rect"/>', { tx: cdrTx('Object coordinate') }),
  ),
  abs(
    from('0.5', '0.1') +
      '<cdr:ext cx="914400" cy="457200"/>' +
      cdrSp('<a:prstGeom prst="roundRect"/>', { style: STYLE, tx: cdrTx('Absolute') }),
  ),
  abs(
    from('0.5', '0.1') +
      '<cdr:ext cx="0" cy="457200"/>' +
      cdrSp('<a:prstGeom prst="rect"/>', { tx: cdrTx('Zero width') }),
  ),
  abs(from('0.5', '0.1') + cdrSp('<a:prstGeom prst="rect"/>', { tx: cdrTx('No ext') })),
  abs(from('0.5', '0.1') + '<cdr:ext cx="914400.6" cy="457200.5"/>' + lineSp()),
  '<cdr:relSizeAnchor/>',
)

const gf = (uri: string, body: string, opts: { cNvPr?: string; xfrm?: string } = {}): string =>
  `<p:graphicFrame><p:nvGraphicFramePr>${opts.cNvPr ?? '<p:cNvPr id="5" name="Frame 4"/>'}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
  `${opts.xfrm ?? '<p:xfrm><a:off x="1000000" y="500000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>'}` +
  `<a:graphic><a:graphicData uri="${uri}">${body}</a:graphicData></a:graphic></p:graphicFrame>`
const chartRef = (rid: string): string =>
  `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/>`
const cxRef = (rid: string): string => `<cx:chart xmlns:cx="${CHARTEX_URI}" r:id="${rid}"/>`

const CHART_CTX = {
  ...BASE,
  chartXmls: [
    ['rId7', BAR],
    ['rId8', FUNNEL],
    ['rId9', NO_PLOT],
    ['rId10', BAR_BLIP],
    ['rId11', WATERFALL],
    ['rId12', BAR_SCHEME],
    ['rId13', ''],
    ['rId14', 'not xml <<<'],
    ['constructor', BAR],
  ],
  chartUserShapes: [
    ['rId7', USER_SHAPES],
    ['rId9', USER_SHAPES],
    ['rId12', userShapes(rel(from('0.1', '0.1') + to('0.2', '0.2') + lineSp('rect')))],
    ['rId10', '<c:userShapes><cdr:relSizeAnchor></c:userShapes>'],
  ],
  chartMediaRels: [['rId10', [['rId1', 'ppt/media/chart-image.png']]]],
  chartStyleRels: ['rId10', 'rId8'],
  chartThemeOverrides: [
    ['rId12', OVERRIDE],
    ['rId8', OVERRIDE],
    ['rId7', '<a:themeOverride/>'],
  ],
}

const CHARTS: Array<{ name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }> =
  [
    {
      name: 'chart with user lines and shapes',
      spTree: gf(CHART_URI, chartRef('rId7'), {
        cNvPr: '<p:cNvPr id="5" name="Chart 4" descr="Sales by region"/>',
      }),
      ctx: CHART_CTX,
    },
    {
      name: 'chart variants',
      spTree: many(
        gf(CHART_URI, chartRef('rId10'), { cNvPr: '<p:cNvPr id="6" descr=""/>' }),
        gf(CHART_URI, chartRef('rId12')),
        gf(CHART_URI, chartRef('rId9')),
        gf(CHART_URI, chartRef('rId13')),
        gf(CHART_URI, chartRef('rId14')),
        gf(CHART_URI, chartRef('rIdMissing')),
        gf(CHART_URI, chartRef('')),
        gf(CHART_URI, '<c:chart/>'),
        gf(CHART_URI, ''),
        gf(CHART_URI, chartRef('constructor')),
        gf(CHART_URI, chartRef('toString')),
        gf(CHART_URI, chartRef('rId7'), {
          xfrm: '<p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="3000000"/></p:xfrm>',
        }),
        gf(CHART_URI, chartRef('rId7'), { xfrm: '' }),
      ),
      ctx: CHART_CTX,
    },
    {
      name: 'chart without chart context',
      spTree: many(gf(CHART_URI, chartRef('rId7')), gf(CHARTEX_URI, cxRef('rId8'))),
      ctx: BASE,
    },
    {
      name: 'chartex',
      spTree: many(
        gf(CHARTEX_URI, cxRef('rId8'), {
          cNvPr: '<p:cNvPr id="7" name="Funnel" descr="dropped"/>',
        }),
        gf(CHARTEX_URI, cxRef('rId11')),
        gf(CHARTEX_URI, cxRef('rId11') + chartRef('rId7')),
        gf(CHARTEX_URI, cxRef('rId7')),
        gf(CHARTEX_URI, cxRef('rIdMissing')),
        gf(CHARTEX_URI, '<cx:chart/>'),
        gf(CHARTEX_URI, cxRef('rId8'), { cNvPr: '<p:cNvPr id="8"/>' }),
      ),
      ctx: CHART_CTX,
    },
    {
      name: 'chartex in mc:AlternateContent',
      spTree:
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1">' +
        gf(CHARTEX_URI, cxRef('rId8')) +
        '</mc:Choice><mc:Fallback>' +
        pic() +
        '</mc:Fallback></mc:AlternateContent>',
      ctx: CHART_CTX,
    },
    {
      name: 'chart theme override that does not parse',
      spTree: gf(CHART_URI, chartRef('rId7')),
      ctx: { ...CHART_CTX, chartThemeOverrides: [['rId7', BROKEN_OVERRIDE]] },
    },
    {
      name: 'chart theme override without a base theme',
      spTree: many(gf(CHART_URI, chartRef('rId12')), gf(CHARTEX_URI, cxRef('rId8'))),
      ctx: { ...CHART_CTX, theme: undefined },
    },
    {
      name: 'charts hidden from AI by their own text or their overlay text',
      spTree: many(
        gf(CHART_URI, chartRef('rId20'), { cNvPr: '<p:cNvPr id="9" name="Overlay hidden"/>' }),
        gf(CHART_URI, chartRef('rId21'), { cNvPr: '<p:cNvPr id="10" name="Both hidden"/>' }),
        gf(CHART_URI, chartRef('rId22'), { cNvPr: '<p:cNvPr id="11" name="Plain"/>' }),
      ),
      ctx: {
        ...CHART_CTX,
        chartXmls: [
          ['rId20', BAR],
          [
            'rId21',
            BAR.replace(
              '<c:autoTitleDeleted val="1"/>',
              `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr lang="en-US">${REDACT}</a:rPr><a:t>T</a:t></a:r></a:p></c:rich></c:tx></c:title>`,
            ),
          ],
          ['rId22', BAR],
        ],
        chartUserShapes: ['rId20', 'rId21'].map((rid) => [
          rid,
          userShapes(
            abs(
              from('0.5', '0.1') +
                cdrSp('<a:prstGeom prst="rect"/>', {
                  tx: `<cdr:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US">${REDACT.replace('face', 'overlay')}</a:rPr><a:t>Note</a:t></a:r></a:p></cdr:txBody>`,
                }),
            ),
          ),
        ]),
      },
    },
  ]

// ── tables, unknown and OLE ────────────────────────────────────────────

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table'
const OLE_URI = 'http://schemas.openxmlformats.org/presentationml/2006/ole'
const TBL =
  '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="2000000"/></a:tblGrid><a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>'

const olePic = (blip = '<a:blip r:embed="rId2"/>'): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000000" y="500000"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
const oleObj = (attrs: string, inner = '<p:embed/>'): string =>
  `<p:oleObj name="Worksheet" r:id="rId3" imgW="914400" imgH="914400" progId="Excel.Sheet.12"${attrs}>${inner}</p:oleObj>`
const oleAlternate = (choice: string, fallback: string): string =>
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`
const deep = (levels: number, inner: string): string => {
  let xml = inner
  for (let i = 0; i < levels; i++) xml = `<x:w${i}>${xml}</x:w${i}>`
  return xml
}
const VML = [
  ['_x0000_s1026', 'ppt/media/image5.emf'],
  ['_x0000_s2048', ''],
  ['constructor', 'ppt/media/ctor.emf'],
]

const FRAMES: Array<{ name: string; spTree: string; ctx?: Record<string, unknown>; seed?: false }> =
  [
    {
      name: 'graphicFrame table and unknown kinds',
      spTree: many(
        gf(TABLE_URI, TBL),
        gf(TABLE_URI, '<a:tbl/>'),
        gf(TABLE_URI, ''),
        gf('urn:example:unknown', '<x:thing/>'),
        gf('http://example.com/SmartArtish', ''),
        gf('', ''),
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Bare"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/></p:graphicFrame>',
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Bare"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="a"/><a:graphicData uri="b"/></a:graphic></p:graphicFrame>',
      ),
      ctx: BASE,
    },
    {
      name: 'ole previews',
      spTree: many(
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"', `<p:embed/>${olePic()}`)),
        gf(
          OLE_URI,
          oleAlternate(oleObj(' spid="_x0000_s1026"'), oleObj('', `<p:embed/>${olePic()}`)),
        ),
        gf(
          OLE_URI,
          oleAlternate(
            oleObj(' spid="_x0000_s1026"'),
            oleObj('', `<p:embed/>${olePic('<a:blip/>')}`),
          ),
        ),
        gf(OLE_URI, oleAlternate(oleObj(''), oleObj(' spid="_x0000_s1026"'))),
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"')),
        gf(OLE_URI, oleObj(' spid="_x0000_s2048"')),
        gf(OLE_URI, oleObj(' spid="_x0000_s9999"')),
        gf(OLE_URI, oleObj(' spid=""')),
        gf(OLE_URI, oleObj(' spid="constructor"')),
        gf(OLE_URI, oleObj(' spid="__proto__"')),
        gf(OLE_URI, `<p:oleObj/>${oleAlternate(oleObj(' spid="_x0000_s1026"'), '')}`),
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"', `<p:embed/>${olePic('<a:blip r:embed=""/>')}`)),
        gf(
          OLE_URI,
          oleObj(
            ' spid="_x0000_s1026"',
            `<p:embed/>${olePic('<a:blip r:embed="rIdMissing"/>')}${olePic()}`,
          ),
        ),
        gf(OLE_URI, deep(5, olePic())),
        gf(OLE_URI, deep(7, olePic()) + oleObj(' spid="_x0000_s1026"')),
        gf(OLE_URI, `<x:list><x:item/><x:item>${olePic()}</x:item></x:list>`),
        gf(OLE_URI, '<p:pic/>' + oleObj(' spid="_x0000_s1026"')),
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"'), { xfrm: '' }),
        gf(OLE_URI, ''),
      ),
      ctx: { ...BASE, vmlPreviews: VML },
    },
    {
      name: 'ole previews without vmlPreviews',
      spTree: many(
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"')),
        gf(OLE_URI, oleObj('', `<p:embed/>${olePic()}`)),
      ),
      ctx: BASE,
    },
    {
      name: 'ole and chart frames inside a group',
      spTree:
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="4000000"/><a:chOff x="0" y="0"/><a:chExt cx="6000000" cy="4000000"/></a:xfrm></p:grpSpPr>' +
        gf(OLE_URI, oleObj(' spid="_x0000_s1026"')) +
        gf(CHART_URI, chartRef('rId7')) +
        '</p:grpSp>',
      ctx: { ...CHART_CTX, vmlPreviews: VML },
    },
  ]

// ── SmartArt ───────────────────────────────────────────────────────────

const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const relIds = (attrs: string): string =>
  `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ${attrs}/>`
const RELS = relIds('r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"')

const DGM_NS =
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const dgmPt = (id: string, text: string, attrs = ''): string =>
  `<dgm:pt modelId="${id}"${attrs}><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`
const presPt = (id: string, lbl: string): string =>
  `<dgm:pt modelId="${id}" type="pres"><dgm:prSet presAssocID="{1}" presName="node" presStyleLbl="${lbl}" presStyleIdx="0" presStyleCnt="2"/><dgm:spPr/></dgm:pt>`
const cxn = (id: string, src: string, dest: string, ord: string): string =>
  `<dgm:cxn modelId="${id}" srcId="${src}" destId="${dest}" srcOrd="${ord}" destOrd="0"/>`
const DATA =
  `<dgm:dataModel ${DGM_NS}><dgm:ptLst>` +
  '<dgm:pt modelId="{D}" type="doc"><dgm:prSet loTypeId="urn:microsoft.com/office/officeart/2005/8/layout/default"/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>' +
  dgmPt('{1}', 'One') +
  dgmPt('{2}', 'Two') +
  presPt('{P1}', 'node1') +
  presPt('{P2}', 'revTx') +
  presPt('constructor', 'node1') +
  presPt('{P3}', 'constructor') +
  presPt('{P4}', 'empty') +
  presPt('{P5}', 'missing') +
  '<dgm:pt type="pres" modelId="{P6}"><dgm:prSet presStyleLbl="node1"/></dgm:pt>' +
  '<dgm:pt modelId="{P7}" type="pres"><dgm:prSet/></dgm:pt>' +
  '<dgm:pt modelId="{P8}" type="pres"/>' +
  presPt('{P9}', 'revTx') +
  '</dgm:ptLst><dgm:cxnLst>' +
  cxn('{C1}', '{D}', '{1}', '0') +
  cxn('{C2}', '{D}', '{2}', '1') +
  '</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>'

const styleLbl = (name: string, inner: string): string =>
  `<dgm:styleLbl name="${name}">${inner}</dgm:styleLbl>`
const txFill = (clr: string): string =>
  `<dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/></dgm:fillClrLst><dgm:txFillClrLst meth="repeat">${clr}</dgm:txFillClrLst>`
const COLORS =
  `<dgm:colorsDef ${DGM_NS} uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2">` +
  styleLbl('node1', txFill('<a:schemeClr val="lt1"/>')) +
  styleLbl('revTx', txFill('<a:srgbClr val="ab12cd"/>')) +
  styleLbl(
    'constructor',
    txFill('<a:schemeClr val="accent2"><a:lumMod val="50000"/></a:schemeClr>'),
  ) +
  styleLbl('empty', '<dgm:txFillClrLst/>') +
  styleLbl('prst', txFill('<a:prstClr val="red"/>')) +
  styleLbl('unknownScheme', txFill('<a:schemeClr val="nope"/>')) +
  "<dgm:styleLbl name='single'>" +
  txFill('<a:srgbClr val="00FF00"/>') +
  '</dgm:styleLbl>' +
  '</dgm:colorsDef>'
const COLORS_NONE = `<dgm:colorsDef ${DGM_NS}>${styleLbl('node1', txFill(''))}</dgm:colorsDef>`

const LAYOUT = `<dgm:layoutDef ${DGM_NS} uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/default"><dgm:title val=""/></dgm:layoutDef>`
const LAYOUT_TRAILING_SLASH = `<dgm:layoutDef ${DGM_NS} uniqueId="urn:x/"><dgm:title val=""/></dgm:layoutDef>`
const LAYOUT_NO_ID = `<dgm:layoutDef ${DGM_NS}><dgm:title val=""/></dgm:layoutDef>`

const DSP_NS =
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const DSP_STYLE =
  '<dsp:style><a:lnRef idx="2"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>'
const dspTx = (paras: string): string =>
  `<dsp:txBody><a:bodyPr spcFirstLastPara="0" vert="horz" wrap="square" anchor="ctr"/><a:lstStyle/>${paras}</dsp:txBody>`
const dspP = (...runs: string[]): string =>
  `<a:p>${runs.map((t) => `<a:r><a:rPr lang="en-US" sz="1800" kern="1200"/>${t}</a:r>`).join('')}</a:p>`
interface DspOpts {
  modelId?: string
  rot?: string
  spPr?: string
  style?: string
  tx?: string
  txXfrm?: string
  nv?: string
}
const dspSp = (o: DspOpts = {}): string =>
  `<dsp:sp${o.modelId === undefined ? ' modelId="{P1}"' : o.modelId}>` +
  `${o.nv ?? '<dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>'}` +
  `<dsp:spPr>${o.spPr ?? `<a:xfrm${o.rot ?? ''}><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>`}</dsp:spPr>` +
  `${o.style ?? DSP_STYLE}${o.tx ?? ''}${o.txXfrm ?? ''}</dsp:sp>`
const TX_XFRM =
  '<dsp:txXfrm rot="-5400000"><a:off x="10" y="10"/><a:ext cx="1900000" cy="900000"/></dsp:txXfrm>'
const drawing = (...sps: string[]): string =>
  `<dsp:drawing ${DSP_NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>${sps.join('')}</dsp:spTree></dsp:drawing>`

const DRAWING = drawing(
  dspSp({ rot: ' rot="5400000"', tx: dspTx(dspP('<a:t>One\nTwo</a:t>')), txXfrm: TX_XFRM }),
  dspSp({
    modelId: ' modelId="{P2}"',
    tx: dspTx(
      dspP(
        '<a:t xml:space="preserve">Lead \r\nTail</a:t>',
        '<a:t>\nfirst</a:t>',
        '<a:t>last\n</a:t>',
      ) + dspP('<a:t>Plain</a:t>'),
    ),
  }),
  dspSp({ modelId: ' modelId="constructor"', tx: dspTx(dspP('<a:t>Ctor</a:t>')) }),
  dspSp({
    modelId: ' modelId="{P3}"',
    tx: dspTx(dspP('<a:t>a\n\nb</a:t>')),
    txXfrm: '<dsp:txXfrm/>',
  }),
  dspSp({
    modelId: ' modelId="{P4}"',
    rot: ' rot="abc"',
    tx: dspTx(dspP('<a:t>Rot</a:t>')),
    txXfrm:
      '<dsp:txXfrm rot="99999999999999999999999"><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></dsp:txXfrm>',
  }),
  dspSp({
    modelId: ' modelId="{P9}"',
    style: '',
    tx: dspTx(dspP('<a:t>No style</a:t>')),
    txXfrm: '<dsp:txXfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></dsp:txXfrm>',
  }),
  dspSp({
    modelId: ' modelId="{P9}"',
    style: '<dsp:style/>',
    tx: dspTx(dspP('<a:t>Empty style</a:t>')),
  }),
  dspSp({
    modelId: ' modelId="{P5}"',
    nv: '',
    tx: dspTx(dspP('<a:t>No nv</a:t>')),
    txXfrm: TX_XFRM,
  }),
  dspSp({ modelId: ' modelId="{P1}"' }),
  dspSp({ modelId: '', tx: dspTx(dspP('<a:t>No modelId</a:t>')) }),
  dspSp({
    modelId: ' modelId="{P7}"',
    spPr: '<a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
  }),
  dspSp({
    modelId: ' modelId="{P1}"',
    style: `${DSP_STYLE}`,
    tx: dspTx(dspP('<a:t>Two styles</a:t>')),
  }).replace('</dsp:sp>', `${DSP_STYLE}</dsp:sp>`),
  '<dsp:sp/>',
)
const STUB = drawing(dspSp({ modelId: ' modelId="{P1}"' }))
const STUB_BLANK_TEXT = drawing(dspSp({ tx: dspTx(dspP('<a:t>  </a:t>')) }))
const ONE_WITH_TEXT = drawing(dspSp({ tx: dspTx(dspP('<a:t>Only</a:t>')) }))

const SMARTART_CTX = {
  ...BASE,
  diagramDatas: [
    ['rId2', DATA],
    ['rIdNoDrawing', DATA],
    ['rIdBroken', DATA],
    ['rIdStub', DATA],
    ['rIdEmptyData', ''],
  ],
  diagramDrawings: [
    ['rId2', DRAWING],
    ['rIdBroken', '<dsp:drawing><dsp:spTree><dsp:sp></dsp:drawing>'],
    ['rIdStub', STUB],
    ['rIdBlank', STUB_BLANK_TEXT],
    ['rIdOne', ONE_WITH_TEXT],
    ['rIdNoTree', `<dsp:drawing ${DSP_NS}/>`],
    ['rIdEmptyTree', drawing()],
    ['rIdEmpty', ''],
    ['constructor', DRAWING],
  ],
  diagramLayouts: [
    ['rId3', LAYOUT],
    ['rIdSlash', LAYOUT_TRAILING_SLASH],
    ['rIdNoId', LAYOUT_NO_ID],
    ['rIdBlank', ''],
  ],
  diagramColors: [
    ['rId5', COLORS],
    ['rIdNone', COLORS_NONE],
    ['rIdEmpty', ''],
  ],
  diagramMediaRels: [['rId2', [['rId1', 'ppt/media/dgm-image.png']]]],
}

const SMARTART: Array<{
  name: string
  spTree: string
  ctx?: Record<string, unknown>
  seed?: false
}> = [
  {
    name: 'smartart drawing with text colors and split paragraphs',
    spTree: gf(DIAGRAM_URI, RELS),
    ctx: SMARTART_CTX,
  },
  {
    name: 'smartart drawing variants',
    spTree: many(
      gf(DIAGRAM_URI, relIds('r:dm="rId2" r:lo="rId3"')),
      gf(DIAGRAM_URI, relIds('r:dm="rId2" r:cs="rIdNone"')),
      gf(DIAGRAM_URI, relIds('r:dm="rId2" r:cs="rIdEmpty"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdOne" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="constructor" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdEmptyTree" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoTree"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdEmpty"')),
    ),
    ctx: SMARTART_CTX,
  },
  {
    name: 'smartart layout fallback',
    spTree: many(
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing" r:lo="rId3" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdStub" r:lo="rIdSlash" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdBroken" r:lo="rIdNoId"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing" r:lo="rIdBlank"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing" r:lo="rIdMissing" r:cs="rIdMissing"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdEmptyData"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing"'), { xfrm: '' }),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing"'), {
        xfrm: '<p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></p:xfrm>',
      }),
      gf(DIAGRAM_URI, ''),
      gf(DIAGRAM_URI, relIds('')),
    ),
    ctx: SMARTART_CTX,
  },
  {
    name: 'smartart stub drawing with blank text',
    spTree: gf(DIAGRAM_URI, relIds('r:dm="rIdBlank"')),
    ctx: { ...SMARTART_CTX, diagramDatas: [['rIdBlank', DATA]] },
  },
  {
    name: 'smartart without diagram context',
    spTree: gf(DIAGRAM_URI, RELS),
    ctx: BASE,
  },
  {
    name: 'smartart drawing without a theme',
    spTree: gf(DIAGRAM_URI, RELS),
    ctx: { ...SMARTART_CTX, theme: undefined },
  },
  {
    // every run and picture drawn for the diagram is withheld under the data's first label
    name: 'smartart whose data part holds a hidden run, drawn and laid out',
    spTree: many(
      gf(DIAGRAM_URI, relIds('r:dm="rId2" r:lo="rId3" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdNoDrawing" r:lo="rId3" r:cs="rId5"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdStub" r:lo="rIdSlash"')),
      gf(DIAGRAM_URI, relIds('r:dm="rIdEmptyData"')),
    ),
    ctx: {
      ...SMARTART_CTX,
      diagramDatas: [
        ['rId2', DATA.replace('<a:rPr lang="en-US"/>', `<a:rPr lang="en-US">${REDACT}</a:rPr>`)],
        [
          'rIdNoDrawing',
          DATA.replace(
            '<a:rPr lang="en-US"/>',
            `<a:rPr>${REDACT.replace('label="face"', "label=''")}</a:rPr>`,
          ),
        ],
        [
          'rIdStub',
          DATA.replace('</dgm:ptLst>', '<!-- &#60;x:redact label="ref"/> --></dgm:ptLst>'),
        ],
        ['rIdEmptyData', ''],
      ],
    },
  },
]

export const SLIDES: Array<{
  name: string
  spTree: string
  ctx?: Record<string, unknown>
  seed?: false
}> = [...PICTURES, ...CHARTS, ...FRAMES, ...SMARTART]
