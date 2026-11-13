// Group `vml`: the shape readers of parse-vml.ts. The helpers the watermark
// readers stand on (vmlLengthPx, vmlColorHex...) are in group `section`.
import {
  VML_PICT_RID_RE,
  VML_WORDART_RE,
  vmlCoordPx,
  vmlGroupScale,
  vmlPathToNormD,
  vmlShapeDimPx,
  vmlShapeSvg,
  vmlShapeTypeTable,
  vmlWordArtBox,
  type VmlGroupScale,
  type VmlOrigin,
} from './reference/parse-vml'
import { nameOf, xmlParser, type XNode } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments, tagTokens } from './fragments'

const CONSTANTS: Record<string, unknown> = {
  VML_WORDART_RE: { source: VML_WORDART_RE.source, flags: VML_WORDART_RE.flags },
  VML_PICT_RID_RE: { source: VML_PICT_RID_RE.source, flags: VML_PICT_RID_RE.flags },
}

// ---- the corpus

/** Corpus inputs per function and document, a bounded few. */
const PER_DOCUMENT = 40

const VML_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/

const vmlParts = (parts: ReadonlyMap<string, string>): string[] =>
  [...parts].filter(([name]) => VML_PART.test(name)).map(([, text]) => text)

const picturesOf = (parts: ReadonlyMap<string, string>): string[] =>
  vmlParts(parts)
    .flatMap((xml) => elementFragments(xml, 'w:pict'))
    .slice(0, PER_DOCUMENT)

/** The start tags called `name` in a part. */
const startTags = (xml: string, name: string): string[] =>
  [...tagTokens(xml)]
    .filter((tag) => !tag.closing && tag.name === name)
    .map((tag) => xml.slice(tag.start, tag.end))

/** The start tags of the VML elements of a part. */
const vmlTags = (xml: string): string[] =>
  [...tagTokens(xml)]
    .filter((tag) => !tag.closing && tag.name.startsWith('v:'))
    .map((tag) => xml.slice(tag.start, tag.end))

const attrIn = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** Distinct values of `attribute` on the VML tags of the parts. */
const vmlAttributesOf = (parts: ReadonlyMap<string, string>, attribute: string): string[] => [
  ...new Set(
    vmlParts(parts)
      .flatMap(vmlTags)
      .map((tag) => attrIn(tag, attribute))
      .filter((value) => value !== undefined),
  ),
]

/** Every pict of the parts, alone and with the shapetypes of its part as the table. */
function shapeInputsOf(parts: ReadonlyMap<string, string>): Input[] {
  const out: Input[] = []
  for (const xml of vmlParts(parts)) {
    const types = startTags(xml, 'v:shapetype').join('')
    for (const text of elementFragments(xml, 'w:pict')) {
      out.push({ text })
      if (types) out.push({ text, args: { types } })
    }
  }
  return out.slice(0, PER_DOCUMENT * 2)
}

// ---- built inputs

const STYLE = 'width:100pt;height:50pt'
const pict = (inner: string): string => `<w:pict>${inner}</w:pict>`
const shape = (kind: string, attrs: string, children = ''): string =>
  children
    ? `<v:${kind} style="${STYLE}"${attrs}>${children}</v:${kind}>`
    : `<v:${kind} style="${STYLE}"${attrs}/>`

const HUGE = '9'.repeat(308)
const OVERFLOW = '9'.repeat(400)

const PATHS = [
  'm0,0l100,0,100,100,0,100xe',
  'm,l,21600r21600,l21600,xe',
  'm10800,l,10800,10800,21600,21600,10800xe',
  'm10,10 l 20 20',
  'm,10l5,',
  't10,10r5,5',
  'm0,0t10,10,5,5r-20,0',
  'm0,0l10',
  'm0,0',
  'm0,0c1,1,2,2,3,3',
  'm0,0l10,10qx5,5',
  'm0,0l10,10ar0,0,1,1,0,0,1,1',
  'nfm0,0l10,10ns',
  'm0,0l10,10e x',
  'm0,0l10,10nsx',
  'm0,0l10,10n',
  'm-5,-5l.5,.5',
  'm1.2.3,4l5,6',
  'm-,0l1,1',
  'm.,0l1,1',
  'm0,0l1,1,',
  'm0,0,5,5,10,10l1,1',
  '',
  '   ',
  ', ,',
  'm0,0l10,10l',
  'M0,0L10,10',
  'm0,0l10,10\u00a0l20,20',
  'm0,0l10,10\ufeff',
  'm0,0\u2028l10,10',
  'm0,0l10,10\u{1d4b3}',
  '\u{1d4b3}m0,0l1,1',
  `m${OVERFLOW},0l1,1`,
  `m0,0t${HUGE},0t${HUGE},0`,
  `m0,0l${HUGE},1`,
  'm-1,0l1,0',
  'm-0,-0l0,0',
  'm1,1l3,3',
  'm0.00001,0l1,1',
  'm10,10l10,10x',
]

const SIZE_STYLES = [
  'width:100pt;height:50pt',
  'width:100px;height:50px',
  'width:1in;height:.5in',
  'width:20mm;height:1cm',
  'width:100;height:50',
  'height:50pt',
  'width:100pt',
  'width:0.3px;height:10px',
  'width:-10pt;height:10pt',
  'position:absolute;margin-left:10pt;width:72pt;height:72pt;rotation:45;flip:x',
  'width:72pt;height:72pt;rotation:-30;flip:x y',
  'width:72pt;height:72pt;visibility:hidden',
  'width:72pt;height:72pt;visibility: hidden',
  'width:72pt;height:72pt;mso-x:\u{1d4b3}',
  'width:33.3pt;height:17.7pt',
  `width:${HUGE}pt;height:10pt`,
  `width:${OVERFLOW}pt;height:10pt`,
  '',
]

const ARCSIZES = ['', '10923f', '.5', '0', 'x', '1.5', '-0.1', '65536f']

const FILL_ATTRS = [
  '',
  ' fillcolor="#ff0000"',
  ' fillcolor="#abc"',
  ' fillcolor="silver"',
  ' fillcolor="#dbe5f1 [3204]"',
  ' fillcolor="bogus"',
  ' fillcolor="\u{1d4b3}"',
  ' filled="f"',
  ' filled="false"',
  ' filled="0"',
  ' filled="t"',
  " fillcolor='red'",
]

const FILL_NODES = [
  '<v:fill type="solid"/>',
  '<v:fill type="pattern"/>',
  '<v:fill type="tile" color2="red"/>',
  '<v:fill type="frame"/>',
  '<v:fill type=""/>',
  '<v:fill on="f"/>',
  '<v:fill on="false"/>',
  '<v:fill on="0"/>',
  '<v:fill on="t"/>',
  '<v:fill opacity=".5"/>',
  '<v:fill opacity="32768f"/>',
  '<v:fill opacity="50%"/>',
  '<v:fill opacity="1"/>',
  '<v:fill opacity="1.5"/>',
  '<v:fill opacity="0"/>',
  '<v:fill opacity="-0"/>',
  '<v:fill opacity="-.25"/>',
  '<v:fill opacity="65536f"/>',
  '<v:fill opacity="6554f"/>',
  '<v:fillx type="pattern"/>',
  '<v:fill type="gradient"/>',
  '<v:fill type="gradient" color2="bogus"/>',
  "<v:fill type='pattern'/>",
]

const ANGLES = ['', '0', '90', '-45', '-0', 'abc', '180', '45.5', '-135', '1e3', '270']
const FOCUSES = [
  '50%',
  '-50%',
  '100%',
  '-100%',
  '30%',
  '.5',
  '32768f',
  '0',
  'x',
  '%50%',
  '80',
  '-80',
  '20%',
  '0.76',
  '-0.25',
  '-75%',
]
const COLOR2S = ['#00ff00', '#aaa', 'silver', '#123456 [3204]', 'BLUE']

const gradient = (angle: string, focus?: string, color2 = '#00ff00'): string =>
  `<v:fill type="gradient" color2="${color2}"${angle ? ` angle="${angle}"` : ''}${
    focus === undefined ? '' : ` focus="${focus}"`
  }/>`

const GRADIENTS = [
  ...ANGLES.map((angle) => gradient(angle)),
  ...FOCUSES.flatMap((focus) => ['90', '-45'].map((angle) => gradient(angle, focus))),
  ...COLOR2S.map((color2) => gradient('30', '50%', color2)),
]

const STROKE_ATTRS = [
  ' strokeweight="1pt"',
  ' strokeweight="2px"',
  ' strokeweight=".5mm"',
  ' strokeweight="0.1in"',
  ' strokeweight="1cm"',
  ' strokeweight="3"',
  ' strokeweight=""',
  ' strokeweight="abc"',
  ' strokeweight="-2pt"',
  ' strokeweight="200pt"',
  ` strokeweight="${HUGE}"`,
  ` strokeweight="-${HUGE}"`,
  ' strokecolor="#00f"',
  ' strokecolor="red [3]"',
  ' strokecolor="nope"',
  ' stroked="f"',
  ' stroked="false"',
  ' stroked="0"',
  ' stroked="t"',
]

const STROKE_NODES = [
  '<v:stroke on="f"/>',
  '<v:stroke dashstyle="dash"/>',
  '<v:stroke dashstyle="longDashDot" on="t"/>',
  '<v:stroke on="false" weight="3pt"/>',
  '<v:stroke on="0"/>',
]

const COORDSIZES = ['', '21600,21600', '1000 500', ' 100, 200', '0,100', '-5,10', 'abc', '100,0']

const SPTS = [
  '1',
  '4',
  '5',
  '6',
  '110',
  '202',
  '3',
  '2',
  '7',
  'constructor',
  '__proto__',
  'toString',
]

const TYPE_202 =
  '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">' +
  '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
const TYPE_T1 =
  '<v:shapetype id="t1" fillcolor="#ff0" strokecolor="#0f0" strokeweight="3pt" stroked="f" coordsize="100,100" path="m0,0l100,0,50,100xe"></v:shapetype>'
const TYPE_T1_TABLE =
  '<v:shapetype id="t1" fillcolor="#0ff" stroked="t" strokeweight="1px" path="m0,0l100,100xe" coordsize="200,200"></v:shapetype>'
const TYPE_CURVE =
  '<v:shapetype id="_x0000_t3" coordsize="21600,21600" o:spt="3" path="m,10800qx10800,l21600,10800,10800,21600xe"></v:shapetype>'
const TYPE_ROUND =
  '<v:shapetype id="_x0000_t2" coordsize="21600,21600" o:spt="2" arcsize="5461f" path="m@0,qx0@0l0@2qy@0,21600xe"></v:shapetype>'

const typed = (type: string, attrs = ''): string =>
  `<v:shape type="${type}" style="${STYLE}"${attrs}/>`

/** [pict inner, shapetype table text or undefined] */
const SHAPETYPE_CASES: Array<[string, string | undefined]> = [
  [TYPE_202 + typed('#_x0000_t202', ' fillcolor="red"'), undefined],
  [typed('#_x0000_t202'), TYPE_202],
  [typed('#_x0000_t202'), undefined],
  [typed('#_x0000_t202'), ''],
  [typed('#_x0000_t202'), TYPE_T1],
  [TYPE_202 + typed('_x0000_t202'), TYPE_202],
  [TYPE_T1 + typed('#t1'), TYPE_T1_TABLE],
  [typed('#t1'), TYPE_T1_TABLE],
  [typed('#t1', ' stroked="t" path="m0,0l50,50xe"'), TYPE_T1],
  [typed('#t1', ' path=""'), TYPE_T1],
  [typed('#t1', ' path="" o:spt="1"'), TYPE_T1],
  [
    '<v:shapetype id="t1" fillcolor="#123"/><v:shapetype id="t1" fillcolor="#456" path="m0,0l1,1xe" coordsize="1,1"/>' +
      typed('#t1'),
    undefined,
  ],
  [typed('#'), TYPE_202],
  [typed('#t1\n'), TYPE_T1],
  [typed('##t1'), '<v:shapetype id="#t1" path="m0,0l9,9xe"/>'],
  [typed('#_x0000_t3'), TYPE_CURVE],
  [TYPE_CURVE + typed('#_x0000_t3', ' fillcolor="red"'), undefined],
  [typed('#_x0000_t2'), TYPE_ROUND],
  [typed('#_x0000_t2', ' path="m0,0l1,1xe" coordsize="1,1"'), TYPE_ROUND],
  [typed('#__proto__'), '<v:shapetype id="__proto__" path="m0,0l5,5xe" coordsize="10,10"/>'],
  [typed('#constructor'), '<v:shapetype id="constructor" o:spt="1"/>'],
  [typed('#toString'), TYPE_T1],
  [
    '<v:shapetype id="a"><v:rect style="width:9pt;height:9pt"/></v:shapetype>' +
      typed('#a', ' path="m0,0l1,1"'),
    undefined,
  ],
  [`<v:shapetype id="u" o:spt="202"/>${shape('shape', ' type="#u"')}`, undefined],
]

const BAILS = [
  `<v:group style="${STYLE}">${shape('rect', '')}</v:group>`,
  `${shape('rect', '', '<v:imagedata r:id="rId1"/>')}`,
  `${shape('rect', '', '<v:imagedata o:title=""/>')}`,
  `${shape('shape', '', '<v:textpath string="x"/>')}`,
  `${shape('rect', '', '<v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox>')}`,
  `${shape('rect', '', '<w:txbxContent/>')}`,
  `${shape('rect', '', '<v:groupx/><v:textboxes/>')}`,
  `<v:line from="0,0" to="10,10" style="${STYLE}"/>`,
  `<v:polyline points="0,0 10,10" style="${STYLE}"/>`,
  `<v:roundrectx style="${STYLE}"/>`,
]

const MALFORMED = [
  `<v:rect style="${STYLE}"`,
  `<v:rect style="${STYLE}" fillcolor="red">`,
  `<v:rect style="${STYLE}"><v:fill type="pattern"/>`,
  `<v:rect style="${STYLE}"><v:fill type="pattern"/></v:rect>`,
  `<v:rect style="${STYLE}"><v:fill type="pattern"/></v:oval></v:rect>`,
  `<v:oval/ style="${STYLE}">`,
  `</v:rect><v:rect style="${STYLE}">`,
  `<v:rect style="${STYLE}" fillcolor="red" fillcolor="blue"/>`,
  `<v:rect style="a" style="${STYLE}"/>`,
  `<v:rect style='${STYLE}'/>`,
  `<v:rect style="${STYLE}" fillcolor='red' stroked='f'/>`,
  `<v:rect __proto__="x" constructor="y" toString="z" style="${STYLE}"/>`,
  `<v:rect style="${STYLE}" a.b="1" x-y="2" 0="z" alt="\u{1F600}"/>`,
  `<v:shapetype id="t" path="m0,0l1,1"><v:rect style="${STYLE}"/>`,
  `<V:RECT style="${STYLE}"/>`,
  `<v:rect\nstyle="${STYLE}"\tfillcolor="red"/>`,
  `<v:rect style="${STYLE}" fillcolor="red"><v:fill color2="blue" type="gradient"/><v:fill type="pattern"/></v:rect>`,
  '',
  'not xml at all',
]

const SHAPE_BUILT: Input[] = [
  ...['oval', 'rect', 'roundrect'].flatMap((kind) =>
    SIZE_STYLES.map((style) => ({ text: pict(`<v:${kind} style="${style}"/>`) })),
  ),
  ...ARCSIZES.map((arc) => ({
    text: pict(shape('roundrect', arc ? ` arcsize="${arc}"` : '')),
  })),
  ...ARCSIZES.map((arc) => ({
    text: pict(shape('roundrect', `${arc ? ` arcsize="${arc}"` : ''} strokeweight="20pt"`)),
  })),
  ...['oval', 'rect'].flatMap((kind) => [
    ...FILL_ATTRS.map((attrs) => ({ text: pict(shape(kind, attrs)) })),
    ...FILL_NODES.map((fill) => ({ text: pict(shape(kind, ' fillcolor="#336699"', fill)) })),
    ...STROKE_ATTRS.map((attrs) => ({ text: pict(shape(kind, attrs)) })),
    ...STROKE_NODES.map((stroke) => ({ text: pict(shape(kind, '', stroke)) })),
  ]),
  ...GRADIENTS.map((fill) => ({ text: pict(shape('rect', ' fillcolor="#ff0000"', fill)) })),
  ...GRADIENTS.slice(0, 4).map((fill) => ({ text: pict(shape('oval', '', fill)) })),
  ...GRADIENTS.slice(0, 2).map((fill) => ({ text: pict(shape('rect', ' filled="f"', fill)) })),
  {
    text: pict(
      shape('rect', ' fillcolor="#ff0000"', `${gradient('45', '50%')}<v:fill opacity=".5"/>`),
    ),
  },
  {
    text: pict(
      shape(
        'shape',
        ' fillcolor="#ff0000" path="m0,0l21600,0,21600,21600xe"',
        gradient('-45', '-50%'),
      ),
    ),
  },
  ...PATHS.map((path) => ({ text: pict(shape('shape', ` path="${path}"`)) })),
  ...PATHS.slice(0, 6).map((path) => ({
    text: pict(shape('shape', ` path="${path}" strokeweight="4pt" fillcolor="blue"`)),
  })),
  ...COORDSIZES.flatMap((coordsize) =>
    ['m0,0l100,0,100,100,0,100xe', 'm0,0l1,1,0,1x'].map((path) => ({
      text: pict(shape('shape', `${coordsize ? ` coordsize="${coordsize}"` : ''} path="${path}"`)),
    })),
  ),
  ...SPTS.map((spt) => ({ text: pict(shape('shape', ` o:spt="${spt}"`)) })),
  { text: pict(shape('shape', ' o:spt="3" path="m0,0l5,5xe"')) },
  { text: pict(shape('shape', ' o:spt="2" arcsize="0"')) },
  { text: pict(shape('rect', ' o:spt="3"')) },
  { text: pict(shape('shape', ' o:spt="202" coordsize="0,0"')) },
  ...SHAPETYPE_CASES.map(([inner, types]) => ({
    text: pict(inner),
    ...(types === undefined ? {} : { args: { types } }),
  })),
  ...BAILS.map((inner) => ({ text: pict(inner) })),
  ...MALFORMED.map((inner) => ({ text: pict(inner) })),
  { text: shape('oval', ' fillcolor="red"') },
]

const SHAPETYPE_TABLES = [
  TYPE_202,
  TYPE_202 + TYPE_T1 + TYPE_CURVE,
  '<v:shapetype id="a" x="1"/><v:shapetype id="b"/><v:shapetype id="a" y="2"/>',
  '<v:shapetype x="1"/><v:shapetype id=""/><v:shapetype id=\'q\'/><v:shapetypes id="s"/><v:shapetype>',
  '<v:shapetype id="__proto__" __proto__="p" constructor="c" toString="t" 10="ten" 2="two" 0="zero" 01="lead" b="x"/>',
  '<v:shapetype id="constructor"/><v:shapetype id="toString" valueOf="v"/><v:shapetype id="hasOwnProperty"/>',
  '<v:shapetype id="\u{1d4b3}" a="\u{1f600}"/>',
  '<v:shapetype id="m"<x/><v:shapetype id="n" path="m0,0">',
  '<v:shapetype id="a" id="b" k="1" k="2"/>',
  '<v:shapetype\nid="nl"\tpath="m0,0l1,1"/>',
  '<w:pict><v:shapetype id="z" o:spt="202" coordsize="21600 21600"></v:shapetype><v:shape type="#z"/></w:pict>',
  '',
  'no shapetypes',
]

const GROUPS = [
  '<v:group style="width:100pt;height:50pt" coordsize="1000,500"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="1000 500"><v:rect/></v:group>',
  '<v:group style="width:100pt;height:50pt" coordsize="0,500"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="500,0"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="-10,10"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="abc"/>',
  '<v:group style="width:100pt;height:50pt"/>',
  '<v:group style="width:100pt;height:50pt" coordsize=" 21600 , 21600"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="21600"/>',
  '<v:group style="width:100pt;height:50pt" coordsize="10.5,20.5"/>',
  '<v:group style="position:absolute;left:0;top:0;width:1000;height:500" coordsize="100,100"/>',
  '<v:group coordsize="100,100"/>',
  '<v:group style="width:0.2px;height:10px" coordsize="10,10"/>',
  '<v:group style="width:-5pt;height:5pt" coordsize="10,10"/>',
  '<v:group style="height:5pt;width:5in" coordsize="10,10"/>',
  '<v:group style="width:.3;height:.3" coordsize="1,1"/>',
  '<v:group constructor="x" style="width:72pt;height:72pt" coordsize="72,72"/>',
  `<v:group style="width:${HUGE}pt;height:10pt" coordsize="1,1"/>`,
  '<?xml version="1.0"?><v:group style="width:10pt;height:10pt" coordsize="3,7"/>',
  '<v:shape style="width:10pt;height:10pt" coordsize="1,1"/>',
  '<v:group style="width:10pt;height:10pt" coordsize="1,1"',
  '<v:group style="width:10pt;height:10pt" coordsize="1,1"></v:shape>',
]

const PARENT_SCALES: Array<VmlGroupScale | undefined> = [
  undefined,
  { sx: 0.5, sy: 2 },
  { sx: 0, sy: 0 },
  { sx: -1, sy: 3 },
]

const COORD_STYLES = [
  'left:100;top:50',
  'left:10pt;top:1in',
  'left:-5px;top:2cm',
  'left:3mm;top:-0',
  'left:1.2.3;top:.',
  'left:abc;top:',
  'left:5em;top:5em',
  'margin-left:5;left:7;margin-top:9;top:11',
  'position:absolute; left:4; top:6',
  'left:4 ;top:6 ',
  'LEFT:4;TOP:4',
  'left:-.5;top:-',
  '',
  `left:${OVERFLOW};top:${HUGE}in`,
  'top:1e3;left:2e1',
]

const PLACEMENTS: Array<{ scale: VmlGroupScale; origin: VmlOrigin }> = [
  { scale: { sx: 2, sy: 0.5 }, origin: { x: 10, y: 20 } },
  { scale: { sx: 0.75, sy: 0.75 }, origin: { x: -3.5, y: 0 } },
]

const DIM_STYLES = [
  'width:100;height:50',
  'width:100pt;height:1.5in',
  'width:.5;height:0',
  'width:-5;height:5',
  'width:1.2.3;height:.',
  'width:20mm;height:2cm',
  'position:absolute;width:300;height:200',
  'WIDTH:5;HEIGHT:5',
  'x;width:5; height:7',
  'width:5px;height:5em',
  'width:0.4;height:0.6',
  'width:1e3;height:2e2',
  `width:${OVERFLOW};height:${HUGE}pt`,
  '',
]

const DIM_SCALES: Array<VmlGroupScale | undefined> = [
  undefined,
  { sx: 0.5, sy: 2 },
  { sx: -1, sy: 0 },
  { sx: 1e300, sy: 1e-300 },
]

const NORM_SIZES: Array<[number | null, number | null]> = [
  [21600, 21600],
  [100, 200],
  [0, 100],
  [-1, 100],
  [100, null],
  [0.5, 0.5],
  [20000, 3],
]

const RE_TEXTS = [
  '<v:textpath style="x" string="Hi"/>',
  '<v:textpath string="a"/>',
  '<v:textpath on="t"/>',
  '<v:textpath xstring="a"/>',
  '<v:textpath\nstring="a"/>',
  '<v:textpathx string="a"/>',
  "<v:textpath string='a'/>",
  '<v:textpath>string="a"',
  '<v:imagedata r:id="rId1"/>',
  '<v:imagedata o:title=""/>',
  '<v:imagedata o:title="" r:id="rId2"/>',
  '<v:imagedata xr:id="a"/>',
  "<v:imagedata r:id='a'/>",
  '<v:imagedata r:pict="x"/>',
  '<v:imagedata>r:id="a"',
  '',
]

/** A WordArt v:shape: `style` of the shape, extra shape attributes, the v:textpath attributes. */
const wordArt = (style: string, attrs: string, textpath: string, children = ''): string =>
  `<v:shape id="WordArt" type="#_x0000_t136" style="${style}"${attrs}>${children}<v:textpath${textpath}/></v:shape>`

const WA_STYLE = 'position:absolute;margin-left:10pt;margin-top:20.5pt;width:300pt;height:60pt'
const WA_TEXTPATH = ' style="font-family:&quot;Arial Black&quot;;font-size:40pt" string="CONFIDENTIAL"'
const wordArtTextpath = (string: string, style = 'font-family:&quot;Arial&quot;;font-size:40pt'): string =>
  ` style="${style}" string="${string}"`

/** WordArt shapes for every branch of vmlWordArtBox. */
const WORD_ARTS: string[] = [
  // no v:textpath, no string, empty and blank strings
  `<v:shape style="${WA_STYLE}"><v:fill color="red"/></v:shape>`,
  wordArt(WA_STYLE, '', ' style="font-size:40pt"'),
  ...['', ' ', '\t\n', '\u3000', '\ufeff', '\u00a0', '&#10;', 'x', ' x '].map((string) =>
    wordArt(WA_STYLE, '', wordArtTextpath(string)),
  ),
  // texts: non-ASCII, outside the BMP (two units each), entities, long
  ...[
    '\u4e2d\u6587\u6c34\u5370',
    'Caf\u00e9 \u00fcber',
    '\u{1F600}\u{1F600}\u{1F600}',
    'A\u{20BB7}B',
    'R&amp;D &lt;draft&gt;',
    'DRAFT DRAFT DRAFT DRAFT DRAFT DRAFT DRAFT DRAFT DRAFT DRAFT',
  ].map((string) => wordArt(WA_STYLE, '', wordArtTextpath(string))),
  // shape sizes with each unit, unitless, rounding to 0, negative, missing
  ...[
    'width:300pt;height:60pt',
    'width:400px;height:80px',
    'width:4in;height:1in',
    'width:100mm;height:20mm',
    'width:10cm;height:2cm',
    'width:300;height:60',
    'width:0.4px;height:0.5px',
    'width:0.5px;height:0.4px',
    'width:-10pt;height:-5pt',
    'width:abc;height:',
    'height:60pt',
    'width:300pt',
    '',
    'width : 300pt',
    ' width:2.5in ; height: 0.75in ',
  ].flatMap((style) => [
    wordArt(style, '', WA_TEXTPATH),
    wordArt(style, '', wordArtTextpath('ABC', 'font-family:Arial')),
  ]),
  // floating: each margin spelling
  ...[
    'position:absolute',
    'position: absolute;margin-left:-12.5pt;margin-top:0pt',
    'position:absolute;margin-left:10px;margin-top:1in',
    'position:absolute;margin-left:.pt;margin-top:-pt',
    'position:absolute;margin-left:72pt;margin-top:36pt;width:200pt;height:50pt',
    'position:absolute;x-margin-left:5pt;mso-margin-top:5pt',
    'margin-left:10pt;margin-top:10pt;position:absolute',
    'position:relative;margin-left:10pt',
    'POSITION:absolute;margin-left:10pt',
    'position:absolute;margin-left:0.00001pt;margin-top:1e3pt',
  ].map((style) => wordArt(style, '', WA_TEXTPATH)),
  // the textpath style: fonts with and without quotes, sizes with other units, bold, italic
  ...[
    'font-family:&quot;Arial Black&quot;;font-size:36pt',
    'font-family:Impact;font-size:36.5pt',
    "font-family:'Times New Roman';font-size:1pt",
    'font-family: &quot; Courier New &quot; ;font-size:0pt',
    'font-family:&quot;&quot;;font-size:.5pt',
    'font-family:&quot; &quot;',
    'font-family:\u5b8b\u4f53;font-size:36px',
    'font-family:&quot;\u{1D400}Font&quot;;font-size:36',
    'font-size:40pt;font-weight:bold',
    'font-weight: bold;font-style: italic;font-size:20pt',
    'font-weight:normal;font-style:normal',
    'font-style:italic',
    'v-text-kern:t;font-size:x40pt',
    'font-size: 30pt',
    '',
  ].flatMap((style) => [
    wordArt(WA_STYLE, '', wordArtTextpath('Hello', style)),
    wordArt('width:300pt', '', wordArtTextpath('Hello', style)),
    wordArt('', '', wordArtTextpath('Hello', style)),
  ]),
  // the font shrinks to the width: above, at and below the floor of 6 pt
  ...[
    'width:300pt;height:60pt',
    'width:30pt;height:60pt',
    'width:37.2pt;height:60pt',
    'width:37pt;height:60pt',
    'width:1pt;height:60pt',
    'width:30pt',
  ].flatMap((style) =>
    ['WIDE', 'W', '\u{1F600}\u{1F600}', 'WIDEWIDEWIDEWIDE'].map((string) =>
      wordArt(style, '', wordArtTextpath(string, 'font-size:40pt')),
    ),
  ),
  // fill: fillcolor, v:fill color and color2, filled="f", unreadable colours
  ...[
    [' fillcolor="#ff0000"', ''],
    [' fillcolor="red"', ''],
    [' fillcolor="#abc"', ''],
    [' fillcolor="#123456 [3204]"', ''],
    [' fillcolor="bogus"', '<v:fill color="blue" color2="#00ff00"/>'],
    ['', '<v:fill color="Silver"/>'],
    ['', '<v:fill color="none" color2="#0f0"/>'],
    ['', '<v:fill color2="yellow"/>'],
    ['', '<v:fill/>'],
    [' fillcolor=""', '<v:fill type="gradient"/>'],
    [' filled="f" fillcolor="#ff0000"', '<v:fill color="blue"/>'],
    [' filled="false" fillcolor="#ff0000"', ''],
    [' filled="t" fillcolor="window [65]"', ''],
  ].map(([attrs, children]) => wordArt(WA_STYLE, attrs!, WA_TEXTPATH, children)),
  // stroke: off, colours, weights with and without units
  ...[
    ' stroked="f"',
    ' stroked="false" strokecolor="#00ff00"',
    ' strokecolor="#00ff00"',
    ' strokecolor="navy"',
    ' strokecolor="nope"',
    ' strokeweight="1pt"',
    ' strokeweight="1.5"',
    ' strokeweight="0.75pt"',
    ' strokeweight="0"',
    ' strokeweight="0pt"',
    ' strokeweight="2px"',
    ' strokeweight="abc"',
    ' strokeweight=""',
    ' strokeweight=" 1pt"',
    ' strokeweight="."',
    ' strokeweight="0.001pt"',
    ' strokecolor="#123" strokeweight="3pt"',
  ].map((attrs) => wordArt(WA_STYLE, attrs, WA_TEXTPATH)),
  wordArt(
    WA_STYLE,
    ' fillcolor="#c0c0c0" stroked="f"',
    wordArtTextpath('\u00c9TAT', 'font-family:&quot;\u00c9l\u00e9gant&quot;;font-weight:bold;font-style:italic'),
  ),
  '<v:shape style="width:10pt"><v:textpath string="A"></v:shape>',
  '',
]

export const VML: CallSpec[] = [
  {
    fn: 'vml.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'vml.VML_WORDART_RE',
    call: (text) => VML_WORDART_RE.test(text),
    fromDocument: (parts) => picturesOf(parts).map((text) => ({ text })),
    built: RE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'vml.VML_PICT_RID_RE',
    call: (text) => VML_PICT_RID_RE.test(text),
    fromDocument: (parts) => picturesOf(parts).map((text) => ({ text })),
    built: RE_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'vml.vmlGroupScale',
    // attrsOf of no node throws: the element `args.node` missing is an input
    call: (text, args) => {
      const nodes = xmlParser.parse(text) as XNode[]
      const group = nodes.find((node) => nameOf(node) === args.node) as XNode
      return vmlGroupScale(group, args.parentScale as VmlGroupScale | undefined)
    },
    fromDocument: (parts) =>
      vmlParts(parts)
        .flatMap((xml) => elementFragments(xml, 'v:group'))
        .slice(0, PER_DOCUMENT)
        .map((text) => ({ text, args: { node: 'v:group' } })),
    built: [
      ...GROUPS.flatMap((text) =>
        PARENT_SCALES.map((parentScale) => ({
          text,
          args: { node: 'v:group', ...(parentScale ? { parentScale } : {}) },
        })),
      ),
      { text: GROUPS[0], args: { node: 'v:shape' } },
      { text: GROUPS[0], args: {} },
    ],
  },
  {
    fn: 'vml.vmlCoordPx',
    call: (text, args) =>
      vmlCoordPx(
        text,
        args.key as 'left' | 'top',
        args.scale as VmlGroupScale,
        args.origin as VmlOrigin,
      ),
    fromDocument: (parts) =>
      vmlAttributesOf(parts, 'style')
        .slice(0, PER_DOCUMENT / 2)
        .flatMap((text) =>
          (['left', 'top'] as const).map((key) => ({ text, args: { key, ...PLACEMENTS[0] } })),
        ),
    built: COORD_STYLES.flatMap((text) =>
      PLACEMENTS.flatMap((placement) =>
        (['left', 'top'] as const).map((key) => ({ text, args: { key, ...placement } })),
      ),
    ),
  },
  {
    fn: 'vml.vmlPathToNormD',
    call: (text, args) =>
      vmlPathToNormD(text, (args.cw as number | null) ?? NaN, (args.ch as number | null) ?? NaN),
    fromDocument: (parts) =>
      vmlParts(parts)
        .flatMap(vmlTags)
        .flatMap((tag) => {
          const path = attrIn(tag, 'path')
          const cs = /^\s*(-?\d+)[,\s]+(-?\d+)/.exec(attrIn(tag, 'coordsize') ?? '21600,21600')
          if (path === undefined || !cs) return []
          return [{ text: path, args: { cw: parseInt(cs[1]!, 10), ch: parseInt(cs[2]!, 10) } }]
        })
        .slice(0, PER_DOCUMENT),
    built: PATHS.flatMap((text) => NORM_SIZES.map(([cw, ch]) => ({ text, args: { cw, ch } }))),
  },
  {
    fn: 'vml.vmlShapeDimPx',
    call: (text, args) =>
      vmlShapeDimPx(
        text,
        args.key as 'width' | 'height',
        (args.scale as VmlGroupScale | undefined) ?? null,
      ),
    fromDocument: (parts) =>
      vmlAttributesOf(parts, 'style')
        .slice(0, PER_DOCUMENT / 2)
        .flatMap((text) =>
          (['width', 'height'] as const).flatMap((key) =>
            DIM_SCALES.slice(0, 2).map((scale) => ({
              text,
              args: { key, ...(scale ? { scale } : {}) },
            })),
          ),
        ),
    built: DIM_STYLES.flatMap((text) =>
      (['width', 'height'] as const).flatMap((key) =>
        DIM_SCALES.map((scale) => ({ text, args: { key, ...(scale ? { scale } : {}) } })),
      ),
    ),
  },
  {
    fn: 'vml.vmlShapeTypeTable',
    call: (text) => vmlShapeTypeTable(text),
    fromDocument: (parts) =>
      vmlParts(parts)
        .map((xml) => startTags(xml, 'v:shapetype').join(''))
        .filter((text) => text !== '')
        .map((text) => ({ text })),
    built: SHAPETYPE_TABLES.map((text) => ({ text })),
  },
  {
    fn: 'vml.vmlShapeSvg',
    call: (text, args) =>
      vmlShapeSvg(text, typeof args.types === 'string' ? vmlShapeTypeTable(args.types) : undefined),
    fromDocument: shapeInputsOf,
    built: SHAPE_BUILT,
  },
  {
    fn: 'vml.vmlWordArtBox',
    call: (text, args) =>
      vmlWordArtBox(
        (xmlParser.parse(text) as XNode[]).find((node) => nameOf(node) === args.node) ?? {},
      ),
    fromDocument: (parts) => {
      const shapes = vmlParts(parts).flatMap((xml) => elementFragments(xml, 'v:shape'))
      return [
        ...shapes.filter((text) => text.includes('<v:textpath')).slice(0, PER_DOCUMENT),
        ...shapes.filter((text) => !text.includes('<v:textpath')).slice(0, 3),
      ].map((text) => ({ text, args: { node: 'v:shape' } }))
    },
    built: [
      ...WORD_ARTS.map((text) => ({ text, args: { node: 'v:shape' } })),
      { text: wordArt(WA_STYLE, '', WA_TEXTPATH), args: { node: 'v:textpath' } },
      { text: wordArt(WA_STYLE, '', WA_TEXTPATH) },
    ],
  },
]
