// Group `geom` of comparison (f): custgeom.ts and preset-shape-types.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_geom.rs to `pptxGeom.<module>.<TypeScript name>`.
import {
  CUST_GEOM_PT_COUNT,
  custGeomXml,
  evalGuides,
  parseCustGeom,
  validCustGeomPath,
  type CustGeomPath,
} from './reference/custgeom'
import {
  isPresetShapeType,
  PRESET_SHAPE_TYPES,
} from './reference/preset-shape-types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Gd = { name: string; fmla: string }

const SHAPE_TREE_PART =
  /^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters)\/[^/]+\.xml$/

/** What JSON cannot carry (NaN, the infinities, -0, a value that is no number) as a string. */
const numberForm = (v: unknown): unknown =>
  typeof v !== 'number'
    ? typeof v
    : Number.isNaN(v)
      ? 'NaN'
      : v === Infinity
        ? 'Infinity'
        : v === -Infinity
          ? '-Infinity'
          : Object.is(v, -0)
            ? '-0'
            : v

/** The cx/cy of the last `a:ext` before `at`, the box a shape's geometry is read in. */
function extentBefore(text: string, at: number): { w: number; h: number } | undefined {
  const start = text.lastIndexOf('<a:ext ', at)
  if (start < 0) return undefined
  const ext = /^<a:ext\b[^>]*?\bcx="(\d+)"[^>]*?\bcy="(\d+)"/.exec(text.slice(start, start + 200))
  return ext ? { w: Number(ext[1]), h: Number(ext[2]) } : undefined
}

/** Every a:custGeom of the parts, read in the box of its shape and in a zero box. */
function custGeomInputs(parts: ReadonlyMap<string, string>): Input[] {
  const inputs: Input[] = []
  for (const text of parts.values()) {
    for (const m of text.matchAll(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/g)) {
      const box = extentBefore(text, m.index!) ?? { w: 914400, h: 914400 }
      inputs.push(
        { text: m[0], args: { shapeW: box.w, shapeH: box.h } },
        { text: m[0], args: { shapeW: 0, shapeH: 0 } },
      )
      if (inputs.length >= 80) return inputs
    }
  }
  return inputs
}

/** The guides of every a:avLst and a:gdLst of the parts, raw as parseCustGeom reads them. */
function guideInputs(parts: ReadonlyMap<string, string>): Input[] {
  const inputs: Input[] = []
  for (const text of parts.values()) {
    for (const m of text.matchAll(/<a:(avLst|gdLst)>([\s\S]*?)<\/a:\1>/g)) {
      const gds: Gd[] = []
      for (const [tag] of m[2]!.matchAll(/<a:gd\b[^>]*>/g)) {
        const name = /\bname="([^"]*)"/.exec(tag)?.[1]
        const fmla = /\bfmla="([^"]*)"/.exec(tag)?.[1]
        if (name && fmla) gds.push({ name, fmla })
      }
      if (gds.length === 0) continue
      const box = extentBefore(text, m.index!) ?? { w: 914400, h: 914400 }
      inputs.push({ args: { gds, w: box.w, h: box.h } })
      if (inputs.length >= 40) return inputs
    }
  }
  return inputs
}

const one = (fmla: string, w = 200, h = 100): Input => ({
  args: { gds: [{ name: 'x', fmla }], w, h },
})

const chain = (fmlas: Array<string | [string, string]>, w = 200, h = 100): Input => ({
  args: {
    gds: fmlas.map((f, i) =>
      typeof f === 'string' ? { name: `g${i}`, fmla: f } : { name: f[0], fmla: f[1] },
    ),
    w,
    h,
  },
})

const SINGLE_FORMULAS = [
  'val 50000',
  'val w',
  'val hc',
  'val ss',
  'val ls',
  'val 3cd4',
  'val 7cd8',
  'val ssd32',
  'val -0',
  'val 0x10',
  'val 0b11',
  'val -0x10',
  'val 1e3',
  'val .5',
  'val 5.',
  'val +5',
  'val 1_000',
  'val Infinity',
  'val -Infinity',
  'val 1e400',
  'val NaN',
  'val unknown',
  'val',
  '',
  '   ',
  '\tval\u00a05\uFEFF',
  'val\n7',
  'val  \r\n 8',
  '\u2003val 9\u3000',
  'VAL 5',
  'val 5 6 7 8',
  '*/ 3 4 2',
  '*/ 3 4 0',
  '*/ 3 4 -0',
  '*/ 1e308 10 1',
  '*/ -1 0 5',
  '*/ w h ss',
  '*/ 1 1 3',
  '+- 1 2 4',
  '+- 0.1 0.2 0',
  '+- -0 0 0',
  '+- -0 -0 0',
  '+- 1e308 1e308 0',
  '+/ 1 2 3',
  '+/ 1 2 0',
  '+/ 1 2 -0',
  '+/ -0 -0 1',
  '?: 1 2 3',
  '?: 0 2 3',
  '?: -1 2 3',
  '?: -0 2 3',
  '?: 0.0001 2 3',
  'abs -5',
  'abs -0',
  'abs 5',
  'min 1 2',
  'min 2 1',
  'min -0 0',
  'min 0 -0',
  'max -0 0',
  'max 0 -0',
  'max 3 -3',
  'max -0 -0',
  'pin 10 5 20',
  'pin 10 15 20',
  'pin 10 99 20',
  'pin 20 15 10',
  'pin -0 0 0',
  'mod 3 4 0',
  'mod 1 2 2',
  'mod -3 0 0',
  'mod 1e200 1e200 0',
  'sqrt 16',
  'sqrt -4',
  'sqrt 2',
  'sqrt -0',
  'at2 1 0',
  'at2 0 1',
  'at2 -1 0',
  'at2 0 -1',
  'at2 1 1',
  'at2 0 0',
  'at2 -1 -0',
  'at2 -0 -0',
  'at2 -0 0',
  'at2 -1 1e-300',
  'at2 3 4',
  'cat2 100 1 1',
  'cat2 100 0 0',
  'cat2 100 -1 0',
  'cat2 100 -1 -0',
  'sat2 100 1 1',
  'sat2 100 -1 -0',
  'sat2 -0 1 1',
  'sat2 100 3 -4',
  'cos 100 0',
  'cos 100 5400000',
  'cos 100 10800000',
  'cos 100 16200000',
  'cos 100 21600000',
  'cos 100 -5400000',
  'cos 100 2700000',
  'cos 100 60000',
  'cos 100 1e10',
  'cos 100 1e22',
  'cos 914400 1234567',
  'sin 100 0',
  'sin 100 5400000',
  'sin 100 10800000',
  'sin 100 -0',
  'sin -0 5',
  'sin 100 60000',
  'sin 100 1234567',
  'sin 914400 7777777',
  'sin 100 21600000',
  'tan 100 0',
  'tan 100 2700000',
  'tan 100 5400000',
  'tan 100 -2700000',
  'tan 100 10800000',
  'tan 100 1e9',
  'tan 100 16200000',
  'foo 1 2 3',
  '*/',
  '+-',
  'sqrt',
]

const BOXES: Array<[number, number]> = [
  [0, 0],
  [-100, 50],
  [0.5, 1e-7],
  [1e300, 1e300],
  [914400, 457200],
  [3, 7],
  [7, 3],
]

const GUIDES: Input[] = [
  ...SINGLE_FORMULAS.map((fmla) => one(fmla)),
  ...BOXES.map(([w, h]) => chain(['val w', 'val ss', 'val wd3', 'val hd6', 'val ssd16'], w, h)),
  chain([]),
  chain(['val 40', '*/ g0 2 1', '+- g1 w 0']),
  chain(['val g1', 'val 5']),
  chain([
    '*/ 1e308 10 1',
    '*/ g0 0 1',
    '+- g0 0 g0',
    'max g1 1',
    'min 1 g1',
    'pin 0 g1 1',
    '?: g1 1 2',
    '*/ 1 1 g1',
    'abs g1',
    'sqrt g0',
    'at2 g0 g0',
    'cos g0 1',
    'cos 1 g0',
    'sin 1 g1',
    'mod g0 0 0',
    'tan 1 g0',
    '*/ -1 g0 1',
    'at2 g16 1',
  ]),
  chain([
    ['w', 'val 7'],
    ['x', 'val w'],
    ['hc', 'val 1'],
    ['y', 'val hc'],
  ]),
  chain([
    ['x', 'val 1'],
    ['0', 'val 2'],
    ['10', 'val 3'],
    ['2', 'val 4'],
    ['3cd4', 'val 5'],
    ['4294967294', 'val 6'],
    ['4294967295', 'val 7'],
    ['-1', 'val 8'],
    ['01', 'val 9'],
    ['y', 'val 0'],
  ]),
  chain([
    ['a', 'val 1'],
    ['b', 'val 2'],
    ['a', '+- a b 0'],
  ]),
  chain([
    ['\u{1F600}', 'val 7'],
    ['\uD55C', '*/ \u{1F600} 2 1'],
  ]),
  // an own key: both sides read 5
  chain([
    ['constructor', 'val 5'],
    ['x', 'val constructor'],
    ['toString', 'val 6'],
    ['y', '+- toString constructor 0'],
  ]),
  // ledger custgeom-inherited-guide: an inherited name reads Object.prototype's value in
  // TypeScript (a function, or the prototype object) and propagates it; Rust reads 0
  { ...one('val constructor'), seed: false },
  { ...one('val toString'), seed: false },
  { ...one('val __proto__'), seed: false },
  { ...one('*/ hasOwnProperty 2 1'), seed: false },
  { ...chain(['val valueOf', '+- g0 1 0']), seed: false },
  // ledger custgeom-inherited-guide: a guide named __proto__ is dropped by the TypeScript's
  // plain assignment; Rust keeps it as an entry
  {
    ...chain([
      ['__proto__', 'val 5'],
      ['x', 'val 1'],
    ]),
    seed: false,
  },
]

const sp = (inner: string): string => `<p:sp><p:spPr>${inner}</p:spPr><p:txBody/></p:sp>`
const geom = (paths: string, lists = ''): string =>
  `<a:custGeom>${lists}<a:pathLst>${paths}</a:pathLst></a:custGeom>`
const pt = (x: string | number, y: string | number): string => `<a:pt x="${x}" y="${y}"/>`
const mv = (x: string | number, y: string | number): string => `<a:moveTo>${pt(x, y)}</a:moveTo>`
const ln = (x: string | number, y: string | number): string => `<a:lnTo>${pt(x, y)}</a:lnTo>`
const path = (attrs: string, body: string): string => `<a:path${attrs}>${body}</a:path>`
const TRI = path(' w="100" h="100"', mv(0, 100) + ln(50, 0) + ln(100, 100) + '<a:close/>')
const arc = (wR: string, hR: string, st: string, sw: string): string =>
  `<a:arcTo wR="${wR}" hR="${hR}" stAng="${st}" swAng="${sw}"/>`
const arcPath = (a: string, start = mv(100, 50)): string =>
  geom(path(' w="100" h="100"', start + a))

const GEOM_TEXTS: Array<[string, number, number]> = [
  ['<p:sp><p:spPr/></p:sp>', 100, 100],
  ['', 100, 100],
  ['<a:custGeom><a:pathLst>' + TRI, 100, 100],
  [sp(geom('')), 914400, 914400],
  [sp(geom(TRI)), 914400, 914400],
  [geom(TRI), 0, 0],
  [geom(TRI), -914400, 914400],
  [geom(TRI), 0.5, 1e21],
  [sp(geom(path('', mv(0, 0) + ln(50, 50)) + path('', mv(0, 100) + ln(100, 0)))), 0, 0],
  [geom(path('', mv(0, 0) + ln(50, 50)) + path('', mv(0, 100) + ln(100, 0))), 200000, 100000],
  [geom(path(' w="100"', mv(0, 0) + ln(100, 30))), 0, 0],
  [geom(path(' h="100"', mv(-10, -20) + ln(-5, -30))), 0, 0],
  [geom(path('', mv(-10, -20) + ln(-5, -30))), -50, -60],
  [
    geom(
      path(
        ' w="w" h="h"',
        mv(0, 0) + ln('hc', 'vc') + ln('r', 'b') + ln('wd3', 'hd6') + ln('ssd8', 'cd4'),
      ),
      '<a:avLst/><a:gdLst/>',
    ),
    200000,
    100000,
  ],
  [
    geom(
      path(' w="100" h="100"', mv('adj', 0) + ln('x1', 'y1') + ln('x2', 0)),
      '<a:avLst><a:gd name="adj" fmla="val 25"/></a:avLst>' +
        '<a:gdLst><a:gd name="x1" fmla="*/ adj 2 1"/><a:gd name="y1" fmla="+- 100 0 adj"/>' +
        '<a:gd name="x2" fmla="pin 0 x1 60"/><a:gd name="bad" fmla=""/><a:gd fmla="val 9"/></a:gdLst>' +
        '<a:cxnLst><a:gd name="x2" fmla="val 99"/></a:cxnLst>',
    ),
    100,
    100,
  ],
  [
    geom(
      path(' w="100" h="100"', mv('g', 0) + ln(10, 10)),
      '<a:avLst/><a:gd name="g" fmla="val 50"/>',
    ),
    100,
    100,
  ],
  [
    geom(
      path(' w="100" h="100"', mv('g', 0) + ln(10, 10)),
      '<a:avLst><a:gd name="g" fmla="val 50"/><a:gd name="g" fmla="val 70"/></a:avLst>',
    ),
    100,
    100,
  ],
  [
    geom(
      path(
        ' w="100" h="100"',
        mv(0, 0) +
          `<a:cubicBezTo>${pt(10, 0)}${pt(20, 0)}${pt(50, 50)}</a:cubicBezTo>` +
          `<a:quadBezTo>${pt(80, 100)}${pt(100, 100)}</a:quadBezTo>`,
      ),
    ),
    914400,
    914400,
  ],
  [
    geom(
      path(
        ' w="100" h="100"',
        mv(0, 0) +
          `<a:cubicBezTo>${pt(10, 0)}${pt(20, 0)}</a:cubicBezTo>` +
          ln(30, 30) +
          `<a:lnTo/>` +
          '<a:close/>',
      ),
    ),
    100,
    100,
  ],
  [arcPath(arc('50', '50', '0', '5400000')), 914400, 914400],
  [arcPath(arc('50', '50', '0', '21600000000')), 914400, 914400],
  [arcPath(arc('50', '50', '0', '21605400000')), 914400, 914400],
  [arcPath(arc('50', '50', '0', '-16200000')), 914400, 914400],
  [arcPath(arc('50', '50', '5400000', '21600000')), 914400, 914400],
  [arcPath(arc('50', '50', '0', '0')), 914400, 914400],
  [arcPath(arc('50', '50', '0', '-0')), 914400, 914400],
  [arcPath(arc('0', '50', '0', '5400000')), 914400, 914400],
  [arcPath(arc('50', '0', '2700000', '5400000')), 914400, 914400],
  [arcPath(arc('50000', '25000', '2700000', '2700000'), mv(72361, 72361)), 914400, 914400],
  [arcPath(arc('50', '25', '-2700000', '-18900000')), 914400, 914400],
  [arcPath(arc('50', '25', '1e15', '33333333')), 914400, 914400],
  [arcPath(arc('wd2', 'hd2', 'cd2', 'cd4')), 200000, 100000],
  [arcPath(arc('50', '50', '0', '1e400')), 914400, 914400],
  [arcPath('<a:arcTo/>'), 914400, 914400],
  [arcPath(arc('50', '50', '0', '5400000'), ''), 914400, 914400],
  [
    geom(
      path(
        ' w="100" h="100"',
        mv(50, 0) + ln(100, 0) + '<a:close/>' + arc('50', '50', '10800000', '-5400000'),
      ),
    ),
    914400,
    914400,
  ],
  [
    geom(
      path(' w="10" h="10" stroke="0"', mv(0, 0) + ln(10, 10) + '<a:close/>') +
        path(' w="10" h="10" fill="none"', mv(0, 10) + ln(10, 0)) +
        path(' w="10" h="10"', mv(0, 0) + ln(10, 0) + '<a:close/>') +
        path(' w="10" h="10" stroke="false"', mv(1, 1) + ln(2, 2)) +
        path(' w="10" h="10" stroke="none"', mv(3, 3) + ln(4, 4)) +
        path(' w="10" h="10" fill="none" stroke="none"', mv(5, 5) + ln(6, 6)) +
        path(' w="10" h="10" fill="norm" stroke="1"', mv(7, 7) + ln(8, 8)) +
        path(' w="10" h="10" fill="None" stroke="False"', mv(9, 9) + ln(1, 1)),
    ),
    100,
    100,
  ],
  [
    geom(
      path(' w="10" h="10" fill="none"', mv(0, 0) + ln(1, 1)) +
        path(' w="10" h="10" stroke="0"', mv(0, 0) + ln(2, 2)),
    ),
    100,
    100,
  ],
  [geom(path(' w="10" h="10" fill="none" stroke="0"', mv(0, 0) + ln(1, 1))), 100, 100],
  [geom(path(" w='10' h='10'", "<a:moveTo><a:pt x='5' y='5'/></a:moveTo>" + ln(10, 10))), 100, 100],
  [
    geom(
      path(' w="100" h="100" extra="a>b"', mv(0, 0) + '<!-- <a:close/> -->' + ln(50, 50)) +
        '<![CDATA[ x ]]><?pi x?>',
    ),
    100,
    100,
  ],
  [geom(path(' w="100" h="100"', mv(0, 0) + '<!-- note -->' + ln(50, 50) + '<?pi?>')), 100, 100],
  [geom('<a:path w="1" h="1"/>' + TRI), 100, 100],
  [geom('<a:path w="1" h="1"></a:path>'), 100, 100],
  [geom(path(' w="10" h="10"', '<a:close/>')), 100, 100],
  [`<a:custGeomX>${geom(TRI)}`, 100, 100],
  [geom(TRI) + geom(path(' w="10" h="10"', mv(1, 1))), 100, 100],
  [geom(path(' w="abc" h="-0"', mv(10, 10) + ln(20, 20))), 100, 200],
  [geom(path(' w="0x10" h=" 5 "', mv(10, 10) + ln(16, 5))), 100, 200],
  [geom(path(' w="" h="1e400"', mv(10, 10) + ln(16, 5))), 100, 200],
  [geom(path(' w="-100" h="0.5"', mv(10, 0.25) + ln(-50, 1))), 100, 200],
  // -1/64 and -3/64 are -1562.5 and -4687.5 hundred-thousandths: Math.round goes up
  [geom(path(' w="64" h="64"', mv(-1, -3) + ln(-5, 7) + ln(1, 3))), 100, 200],
  [
    geom(
      path(
        ' w="100" h="100"',
        mv('1e400', 'Infinity') +
          ln(-5, '33.333333') +
          ln('1e21', '0.000005') +
          ln('-0.000005', '0.0000049') +
          ln('', '-0') +
          ln('0x20', ' 7 '),
      ),
    ),
    100,
    100,
  ],
  [geom(path(' w="3" h="7"', mv(1, 1) + ln(2, 2) + ln(1, 5) + ln(0.1, 0.7))), 100, 100],
  [geom(mv(1, 1) + '<a:pt x="2" y="2"/>' + TRI), 100, 100],
  [
    geom(path(' w="10" h="10"', '<a:pt x="1" y="1"/>' + mv(1, 1) + '<a:lnTo></a:lnTo><a:close/>')),
    100,
    100,
  ],
  [
    geom(
      path(' w="10" h="10"', mv(1, 1)) +
        '<a:path w="20" h="20">' +
        mv(2, 2) +
        ln(4, 4) +
        '</a:path>',
    ),
    100,
    100,
  ],
  [
    geom('<a:path w="10" h="10">' + mv(1, 1) + '<a:path w="20" h="20">' + ln(4, 4) + '</a:path>'),
    100,
    100,
  ],
  [
    geom(
      path(' w="100" h="100" fill="\u{1F600}"', mv('\u{1F600}', 0) + ln(10, 10)),
      '<a:gdLst><a:gd name="\u{1F600}" fmla="val 7"/></a:gdLst>',
    ),
    100,
    100,
  ],
  [
    geom(
      path(' w="100" h="100"', mv('nan', 0) + ln(10, 'big')),
      '<a:gdLst><a:gd name="big" fmla="*/ 1e308 10 1"/><a:gd name="nan" fmla="*/ big 0 1"/></a:gdLst>',
    ),
    100,
    100,
  ],
  [
    geom(
      path('', mv('nan', 0) + ln(10, 'big')),
      '<a:gdLst><a:gd name="big" fmla="*/ 1e308 10 1"/><a:gd name="nan" fmla="*/ big 0 1"/></a:gdLst>',
    ),
    0,
    0,
  ],
  [
    geom(
      path(
        ' w="100" h="100"',
        '<a:moveTo><a:pt y="2" x="1"/></a:moveTo>' + '<a:lnTo><a:pt  x = "30"\ty="40" /></a:lnTo>',
      ) + '</a:path >',
    ),
    100,
    100,
  ],
  [geom('< a:path w="10" h="10">' + mv(1, 1) + ln(2, 2) + '</a:path>'), 100, 100],
  [geom('<A:PATH w="10" h="10">' + mv(1, 1) + ln(2, 2) + '</A:PATH>'), 100, 100],
  [
    geom(path(' w="10" h="10"', '<a:moveTo><a:pt x="1" x="2" y="3"/></a:moveTo>' + ln(5, 5))),
    100,
    100,
  ],
  [
    sp(
      '<a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="1524000"/></a:xfrm>' +
        geom(
          path(
            ' w="3048000" h="1524000"',
            mv(0, 762000) +
              `<a:cubicBezTo>${pt(0, 341170)}${pt(682291, 0)}${pt(1524000, 0)}</a:cubicBezTo>` +
              ln(3048000, 0) +
              ln(3048000, 1524000) +
              arc('wd2', 'hd2', '0', 'cd4') +
              '<a:close/>',
          ),
          '<a:avLst/><a:gdLst/><a:ahLst/>' +
            '<a:cxnLst><a:cxn ang="3cd4"><a:pos x="hc" y="t"/></a:cxn></a:cxnLst>' +
            '<a:rect l="l" t="t" r="r" b="b"/>',
        ) +
        '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
    ),
    3048000,
    1524000,
  ],
]

/** Ledger custgeom-inherited-guide: names every object inherits, read as guides. */
const INHERITED_GEOM_TEXTS: Array<[string, number, number]> = [
  [geom(path(' w="100" h="100"', mv('constructor', 0) + ln(10, 10))), 100, 100],
  [geom(path(' w="100" h="100"', mv('__proto__', 'toString') + ln(10, 10))), 100, 100],
  [
    geom(
      path(' w="100" h="100"', mv('g', 0) + ln(10, 10)),
      '<a:gdLst><a:gd name="g" fmla="val toString"/></a:gdLst>',
    ),
    100,
    100,
  ],
  [
    geom(
      path(' w="100" h="100"', mv('__proto__', 0) + ln(10, 10)),
      '<a:gdLst><a:gd name="__proto__" fmla="val 50"/></a:gdLst>',
    ),
    100,
    100,
  ],
  [
    geom(path(' w="100" h="100"', mv(0, 0) + arc('hasOwnProperty', '50', '0', '5400000'))),
    100,
    100,
  ],
]

const tri: CustGeomPath = {
  w: 1828800,
  h: 914400,
  cmds: [
    { op: 'M', pts: [0, 914400] },
    { op: 'L', pts: [914400, 0] },
    { op: 'C', pts: [1371600, 0, 1828800, 457200, 1828800, 914400] },
    { op: 'Q', pts: [914400, 1097280, 0, 914400] },
    { op: 'Z', pts: [] },
  ],
}

const PATH_VALUES: unknown[] = [
  null,
  0,
  1,
  '',
  'x',
  true,
  false,
  [],
  [1, 2],
  {},
  tri,
  { ...tri, w: 0 },
  { ...tri, w: -1 },
  { ...tri, h: 0 },
  { ...tri, w: 0.5, h: 1e-300 },
  { ...tri, w: 1e308 },
  { ...tri, w: '1' },
  { h: 1, cmds: tri.cmds },
  { w: 1, h: 1 },
  { ...tri, cmds: {} },
  { ...tri, cmds: 'M' },
  { ...tri, cmds: [] },
  { ...tri, cmds: [null] },
  { ...tri, cmds: [null, { op: 'M', pts: [0, 0] }] },
  { ...tri, cmds: [5] },
  { ...tri, cmds: ['M'] },
  { ...tri, cmds: [[]] },
  { ...tri, cmds: [{ op: 'L', pts: [0, 0] }] },
  { ...tri, cmds: [{ op: ['M'], pts: [0, 0] }] },
  { ...tri, cmds: [{ op: 'M', pts: [0] }] },
  { ...tri, cmds: [{ op: 'M', pts: [0, '1'] }] },
  { ...tri, cmds: [{ op: 'M', pts: [0, true] }] },
  { ...tri, cmds: [{ op: 'M', pts: [0, null] }] },
  { ...tri, cmds: [{ op: 'M', pts: {} }] },
  { ...tri, cmds: [{ op: 'M' }] },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }] },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: ['L'], pts: [1, 1] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: [['Q']], pts: [1, 1, 2, 2] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'Z', pts: [] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'Z', pts: [0, 0] },
    ],
  },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }, { op: 'Z' }] },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'X', pts: [] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'm', pts: [0, 0] },
    ],
  },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }, null] },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }, []] },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }, 'L'] },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 2, pts: [0, 0] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: null, pts: [0, 0] },
    ],
  },
  { ...tri, cmds: [{ op: 'M', pts: [0, 0] }, { pts: [0, 0] }] },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: {}, pts: [0, 0] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'C', pts: [0, 0, 1, 1, 2, 2] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [0, 0] },
      { op: 'C', pts: [0, 0, 1, 1] },
    ],
  },
  {
    ...tri,
    cmds: [
      { op: 'M', pts: [-1e308, 1e308] },
      { op: 'Q', pts: [0.5, -0.5, 1, 1] },
    ],
  },
  // custgeom.ts:461: `in` answers for inherited names, the length test refuses them; both sides false
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].flatMap((op) => [
    {
      ...tri,
      cmds: [
        { op: 'M', pts: [0, 0] },
        { op, pts: [] },
      ],
    },
    {
      ...tri,
      cmds: [
        { op: 'M', pts: [0, 0] },
        { op, pts: [0, 0] },
      ],
    },
  ]),
  { ...tri, cmds: [{ op: 'constructor', pts: [0, 0] }] },
]

const XML_PATHS: CustGeomPath[] = [
  tri,
  { w: 10.4, h: 10.6, cmds: [{ op: 'M', pts: [1.5, 2.49] }] },
  {
    w: 0.5,
    h: -0.5,
    cmds: [
      { op: 'M', pts: [-0.4, -2.5] },
      { op: 'L', pts: [-0.5, 0.49999999999999994] },
    ],
  },
  {
    w: 1e21,
    h: 1e300,
    cmds: [
      { op: 'M', pts: [1e21, -1e21] },
      { op: 'L', pts: [123456789.5, 1e-7] },
    ],
  },
  { w: 1, h: 1, cmds: [] },
  { w: 1, h: 1, cmds: [{ op: 'Z', pts: [] }] },
  {
    w: 1,
    h: 1,
    cmds: [
      { op: 'Z', pts: [1, 2] },
      { op: 'M', pts: [] },
    ],
  },
  {
    w: 1,
    h: 1,
    cmds: [
      { op: 'M', pts: [1] },
      { op: 'L', pts: [1, 2, 3] },
    ],
  },
  {
    w: 1,
    h: 1,
    cmds: [
      { op: 'Q', pts: [1, 2, 3, 4] },
      { op: 'C', pts: [1, 2, 3, 4, 5, 6] },
      { op: 'Z', pts: [] },
    ],
  },
  { w: -3.5, h: 2.5, cmds: [{ op: 'M', pts: [-3.5, 2.5] }] },
]

const presetsOf = (parts: ReadonlyMap<string, string>): string[] => {
  const found = new Set<string>()
  for (const [path, text] of parts) {
    if (!SHAPE_TREE_PART.test(path)) continue
    for (const m of text.matchAll(/\bprst="([^"]*)"/g)) found.add(m[1]!)
  }
  return [...found]
}

export const GEOM: CallSpec[] = [
  {
    fn: 'pptxGeom.custgeom.evalGuides',
    call: (_text, args) =>
      Object.fromEntries(
        Object.entries(evalGuides(args.gds as Gd[], args.w as number, args.h as number)).map(
          ([key, v]) => [key, numberForm(v)],
        ),
      ),
    fromDocument: guideInputs,
    built: GUIDES,
    mutation: 'none',
  },
  {
    fn: 'pptxGeom.custgeom.parseCustGeom',
    call: (text, args) => parseCustGeom(text, args.shapeW as number, args.shapeH as number),
    fromDocument: custGeomInputs,
    built: [
      ...GEOM_TEXTS.map(([text, shapeW, shapeH]) => ({ text, args: { shapeW, shapeH } })),
      // ledger custgeom-inherited-guide: TypeScript writes NaN where an inherited name is
      // read; Rust reads 0 (or the guide named __proto__)
      ...INHERITED_GEOM_TEXTS.map(([text, shapeW, shapeH]) => ({
        text,
        args: { shapeW, shapeH },
        seed: false as const,
      })),
    ],
  },
  {
    fn: 'pptxGeom.custgeom.CUST_GEOM_PT_COUNT',
    call: (_text, args) => {
      const op = args.op as string
      return Object.hasOwn(CUST_GEOM_PT_COUNT, op)
        ? CUST_GEOM_PT_COUNT[op as keyof typeof CUST_GEOM_PT_COUNT]
        : undefined
    },
    built: ['M', 'L', 'C', 'Q', 'Z', 'X', 'm', '', 'constructor', 'toString', '__proto__'].map(
      (op) => ({ args: { op } }),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxGeom.custgeom.validCustGeomPath',
    call: (_text, args) => validCustGeomPath(args.p),
    built: [{}, ...PATH_VALUES.map((p) => ({ args: { p } }))],
    mutation: 'none',
  },
  {
    fn: 'pptxGeom.custgeom.custGeomXml',
    call: (_text, args) => custGeomXml(args.p as CustGeomPath),
    built: XML_PATHS.map((p) => ({ args: { p } })),
    mutation: 'none',
  },
  {
    fn: 'pptxGeom.preset-shape-types.PRESET_SHAPE_TYPES',
    call: (_text, args) => PRESET_SHAPE_TYPES[args.index as number],
    built: [
      ...PRESET_SHAPE_TYPES.map((_, index) => ({ args: { index } })),
      ...[PRESET_SHAPE_TYPES.length, -1, 1.5, 1e10].map((index) => ({ args: { index } })),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxGeom.preset-shape-types.isPresetShapeType',
    call: (text) => isPresetShapeType(text),
    fromDocument: (parts) => presetsOf(parts).map((text) => ({ text })),
    built: [
      ...PRESET_SHAPE_TYPES,
      'Rect',
      'rect ',
      ' rect',
      '',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'line\u0000',
      '\u{1F600}',
      'custGeom',
      'rectX',
      'star3',
    ].map((text) => ({ text })),
  },
]
