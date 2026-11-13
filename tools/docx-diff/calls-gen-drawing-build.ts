// Group `genDrawingBuild`: the fresh drawing builders of generate.ts. Each
// builder takes its options object as `args.opts`. A numeric option may cross
// as text ('NaN', 'Infinity'); both sides read it with Number.
import {
  type AnchoredTextboxOptions,
  buildAnchoredTextboxParagraphXml,
  buildLineParagraphXml,
  buildShapeParagraphXml,
  buildTextboxParagraphXml,
  buildWordArtParagraphXml,
  type InlinePictureXmlOptions,
  inlinePictureDrawingXml,
  LINE_KINDS,
} from './reference/generate'
import { ownValue } from './reference/own-value'
import type { CallSpec, Input } from './calls-spec'

type Opts = Record<string, unknown>

/** `opts` with the text of each numeric key read with Number; `insetsEmu` sides too. */
function numbersOf(opts: unknown, keys: readonly string[]): Opts {
  if (opts == null) return opts as unknown as Opts
  const out: Opts = { ...(opts as Opts) }
  for (const key of keys) if (typeof out[key] === 'string') out[key] = Number(out[key])
  if (out.insetsEmu != null && typeof out.insetsEmu === 'object')
    out.insetsEmu = numbersOf(out.insetsEmu, ['l', 't', 'r', 'b'])
  return out
}
const BOX_KEYS = ['widthEmu', 'heightEmu', 'id']
const PICTURE_KEYS = ['widthPx', 'heightPx', 'rotDeg']
const ANCHORED_KEYS = [
  'xEmu',
  'yEmu',
  'widthEmu',
  'heightEmu',
  'id',
  'cornerRadiusEmu',
  'zOrder',
  'holderLineTwips',
  'holderSpacingBeforeTwips',
]

const PART = /^word\/(document|header\d*|footer\d*)\.xml$/
const CAP = 12

interface Geometry {
  extents: Array<[number, number]>
  prsts: string[]
  colors: string[]
  ids: number[]
}

/** The extents, preset names, colors and docPr ids of one document's drawings. */
function geometryOf(parts: ReadonlyMap<string, string>): Geometry {
  const extents = new Map<string, [number, number]>()
  const prsts = new Set<string>()
  const colors = new Set<string>()
  const ids = new Set<number>()
  for (const [name, xml] of parts) {
    if (!PART.test(name)) continue
    for (const m of xml.matchAll(/<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/g))
      if (extents.size < CAP) extents.set(`${m[1]},${m[2]}`, [Number(m[1]), Number(m[2])])
    for (const m of xml.matchAll(/<a:prstGeom\b[^>]*\bprst="([^"]*)"/g))
      if (prsts.size < CAP) prsts.add(m[1])
    for (const m of xml.matchAll(/<a:srgbClr\b[^>]*\bval="([^"]*)"/g))
      if (colors.size < CAP) colors.add(m[1])
    for (const m of xml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g))
      if (ids.size < CAP) ids.add(Number(m[1]))
  }
  return { extents: [...extents.values()], prsts: [...prsts], colors: [...colors], ids: [...ids] }
}

let lastParts: ReadonlyMap<string, string> | undefined
let lastGeometry: Geometry = { extents: [], prsts: [], colors: [], ids: [] }
const geometry = (parts: ReadonlyMap<string, string>): Geometry => {
  if (parts !== lastParts) {
    lastParts = parts
    lastGeometry = geometryOf(parts)
  }
  return lastGeometry
}

/** One option set per corpus extent, cycling the document's colors, presets and ids. */
const fromGeometry =
  (make: (g: Geometry, cx: number, cy: number, i: number) => Opts) =>
  (parts: ReadonlyMap<string, string>): Input[] => {
    const g = geometry(parts)
    return g.extents.map(([cx, cy], i) => ({ args: { opts: make(g, cx, cy, i) } }))
  }
const pick = <T>(list: T[], i: number): T | undefined =>
  list.length ? list[i % list.length] : undefined

const SIZES: Array<[number | undefined, number | undefined]> = [
  [undefined, undefined],
  [914400, 457200],
  [1, 0],
  [12700.5, 6350.25],
  [-12700, 254000],
  [1e21, 3],
]
const IDS = [undefined, 0, 7, 1.5, -2]
const HEXES = [undefined, 'FF0000', 'abc', '', 'A&"<>']

const built = (sets: Opts[]): Input[] => sets.map((opts) => ({ args: { opts } }))
const def = (o: Opts): Opts =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

const RUNS = [
  [{ text: 'Card title', bold: true }],
  [{ text: 'a & b < c' }, { text: ' tail', italic: true, color: 'FF0000' }],
  [],
]
const FORMATS = [
  undefined,
  { align: 'center' },
  { spaceBefore: 120, spaceAfter: 0, indentLeft: 360 },
  { lineSpacing: 1.5, lineRule: 'auto', align: 'right' },
]

const ANCHORED: Opts[] = [
  { anchor: 'paragraph', xEmu: 0, yEmu: 0, widthEmu: 1800000, heightEmu: 900000, paragraphs: [] },
  {
    anchor: 'page',
    xEmu: 457200.4,
    yEmu: -12700.5,
    widthEmu: 2540000,
    heightEmu: 1270000,
    paragraphs: RUNS.map((runs, i) => def({ runs, format: FORMATS[i] })),
    id: 4,
    fillHex: 'F2F2F2',
    borderHex: '1F3864',
    insetsEmu: { l: 0, t: 12700.5, r: 1.4, b: -3 },
    cornerRadiusEmu: 127000,
    zOrder: 3,
    behindDoc: true,
    wrap: 'topAndBottom',
    holderLineTwips: 20.4,
    holderSpacingBeforeTwips: 240,
    holderPageBreakBefore: true,
  },
  {
    anchor: 'paragraph',
    xEmu: 1,
    yEmu: 2,
    widthEmu: 100,
    heightEmu: 50,
    paragraphs: [
      { runs: RUNS[0], format: FORMATS[3] },
      { runs: RUNS[1], format: FORMATS[2] },
    ],
    cornerRadiusEmu: 1e9,
    fillHex: '',
    borderHex: 'x"y',
    wrap: 'none',
    holderLineTwips: null,
    holderSpacingBeforeTwips: 0,
  },
  {
    anchor: 'page',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 0,
    heightEmu: 0,
    paragraphs: [{ runs: [{ text: 'x' }] }],
    cornerRadiusEmu: -5,
    zOrder: -1.5,
    behindDoc: false,
    holderSpacingBeforeTwips: null,
  },
  {
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 10,
    heightEmu: 10,
    paragraphs: [],
    cornerRadiusEmu: 3,
    holderSpacingBeforeTwips: 99.5,
  },
  // non-finite options whose TypeScript output is valid: roundRect val 50000 / 0, spacing without w:before
  {
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 200,
    heightEmu: 100,
    paragraphs: [],
    cornerRadiusEmu: 'Infinity',
  },
  {
    anchor: 'page',
    xEmu: 5,
    yEmu: 5,
    widthEmu: 200,
    heightEmu: 100,
    paragraphs: [],
    cornerRadiusEmu: '-Infinity',
    fillHex: 'FFEEDD',
  },
  {
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 200,
    heightEmu: 100,
    paragraphs: [],
    holderSpacingBeforeTwips: 'NaN',
  },
  {
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 200,
    heightEmu: 100,
    paragraphs: [],
    holderSpacingBeforeTwips: 'NaN',
    holderLineTwips: 240,
  },
]

export const GEN_DRAWING_BUILD: CallSpec[] = [
  {
    fn: 'genDrawingBuild.LINE_KINDS',
    call: (text) => ownValue(LINE_KINDS, text),
    built: [
      'line',
      'lineArrow',
      'lineArrowDouble',
      'lineBent',
      'lineCurved',
      'nope',
      'constructor',
      '__proto__',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'genDrawingBuild.buildLineParagraphXml',
    argMutation: true,
    call: (_text, args) =>
      buildLineParagraphXml(
        numbersOf(args.opts, BOX_KEYS) as Parameters<typeof buildLineParagraphXml>[0],
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        kind: Object.keys(LINE_KINDS)[i % 5],
        widthEmu: cx,
        heightEmu: cy,
        id: pick(g.ids, i),
        colorHex: pick(g.colors, i),
      }),
    ),
    built: built(
      [
        'line',
        'lineArrow',
        'lineArrowDouble',
        'lineBent',
        'lineCurved',
        'other',
        'toString',
      ].flatMap((kind, k) =>
        SIZES.map(([widthEmu, heightEmu], i) =>
          def({
            kind,
            widthEmu,
            heightEmu,
            id: IDS[(i + k) % IDS.length],
            colorHex: HEXES[(i + k) % HEXES.length],
          }),
        ),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'genDrawingBuild.inlinePictureDrawingXml',
    argMutation: true,
    call: (_text, args) =>
      inlinePictureDrawingXml(
        numbersOf(args.opts, PICTURE_KEYS) as unknown as InlinePictureXmlOptions,
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        rId: `rId${i}`,
        docPrId: pick(g.ids, i) ?? 1,
        widthPx: cx / 9525,
        heightPx: cy / 9525,
        rotDeg: [undefined, 90, 30][i % 3],
      }),
    ),
    built: built(
      [
        { widthPx: 100, heightPx: 50 },
        { widthPx: 0, heightPx: 0.00001 },
        { widthPx: 33.3, heightPx: 66.6 },
        { widthPx: -5, heightPx: 1e15 },
        // valid TypeScript output: -Infinity clamps to 1 EMU
        { widthPx: '-Infinity', heightPx: 40 },
      ].flatMap((size, i) =>
        // a NaN rotation is falsy: no rotation on either side
        [undefined, 0, 90, -90, 45.5, 359.6, 720, 1e300, 'NaN'].map((rotDeg, j) =>
          def({
            rId: ['rId1', 'aidocs-new-pic-3', ''][j % 3],
            docPrId: [1, 'aidocs-new-pic-3', 2.5, 'x'][(i + j) % 4],
            ...size,
            altText: [undefined, '', 'A "cat" & <dog>', 'alt'][j % 4],
            rotDeg,
            flipH: [undefined, true, false][j % 3],
            flipV: [undefined, false, true][(i + j) % 3],
          }),
        ),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'genDrawingBuild.buildTextboxParagraphXml',
    argMutation: true,
    call: (_text, args) =>
      buildTextboxParagraphXml(
        numbersOf(args.opts, BOX_KEYS) as Parameters<typeof buildTextboxParagraphXml>[0],
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        widthEmu: cx,
        heightEmu: cy,
        id: pick(g.ids, i),
        fillHex: pick(g.colors, i),
        borderHex: pick(g.colors, i + 1),
      }),
    ),
    built: [
      {},
      { args: { opts: null } },
      ...built(
        SIZES.map(([widthEmu, heightEmu], i) =>
          def({
            widthEmu,
            heightEmu,
            id: IDS[i % IDS.length],
            fillHex: HEXES[i % HEXES.length],
            borderHex: HEXES[(i + 2) % HEXES.length],
          }),
        ),
      ),
    ],
    mutation: 'none',
  },
  {
    fn: 'genDrawingBuild.buildAnchoredTextboxParagraphXml',
    argMutation: true,
    call: (_text, args) =>
      buildAnchoredTextboxParagraphXml(
        numbersOf(args.opts, ANCHORED_KEYS) as unknown as AnchoredTextboxOptions,
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        anchor: i % 2 ? 'page' : 'paragraph',
        xEmu: cx / 3,
        yEmu: cy / 7,
        widthEmu: cx,
        heightEmu: cy,
        paragraphs: [{ runs: RUNS[i % 3] }],
        fillHex: pick(g.colors, i),
        cornerRadiusEmu: i % 3 ? cy / 5 : undefined,
      }),
    ),
    built: built(ANCHORED),
    mutation: 'none',
  },
  {
    fn: 'genDrawingBuild.buildShapeParagraphXml',
    argMutation: true,
    call: (_text, args) =>
      buildShapeParagraphXml(
        numbersOf(args.opts, BOX_KEYS) as Parameters<typeof buildShapeParagraphXml>[0],
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        prst: pick(g.prsts, i) ?? 'rect',
        widthEmu: cx,
        heightEmu: cy,
        id: pick(g.ids, i),
        fillHex: pick(g.colors, i),
        withTextbox: i % 2 === 0,
      }),
    ),
    built: built(
      ['rect', 'ellipse', 'roundRect', 'rightArrow', '', 'a"b'].flatMap((prst, k) =>
        SIZES.map(([widthEmu, heightEmu], i) =>
          def({
            prst,
            widthEmu,
            heightEmu,
            id: IDS[(i + k) % IDS.length],
            fillHex: HEXES[i % HEXES.length],
            borderHex: HEXES[k % HEXES.length],
            withTextbox: [undefined, true, false][(i + k) % 3],
          }),
        ),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'genDrawingBuild.buildWordArtParagraphXml',
    argMutation: true,
    call: (_text, args) =>
      buildWordArtParagraphXml(
        numbersOf(args.opts, BOX_KEYS) as Parameters<typeof buildWordArtParagraphXml>[0],
      ),
    fromDocument: fromGeometry((g, cx, cy, i) =>
      def({
        widthEmu: cx,
        heightEmu: cy,
        id: pick(g.ids, i),
        colorHex: pick(g.colors, i),
        italic: i % 2 === 1,
      }),
    ),
    built: built(
      [undefined, '', 'WordArt', 'A & B <c> "d"', '\u0001ctl\u000b', '한글 텍스트'].flatMap(
        (text, k) =>
          SIZES.map(([widthEmu, heightEmu], i) =>
            def({
              text,
              colorHex: HEXES[(i + k) % HEXES.length],
              italic: [undefined, true, false][i % 3],
              widthEmu,
              heightEmu,
              id: IDS[k % IDS.length],
            }),
          ),
      ),
    ),
    mutation: 'none',
  },
]

const nf = (fn: string, base: Opts, patches: Opts[]) =>
  patches.map((patch) => ({
    fn: `genDrawingBuild.${fn}`,
    text: '',
    args: { opts: { ...base, ...patch } },
  }))
const ANCHORED_BASE: Opts = {
  anchor: 'paragraph',
  xEmu: 0,
  yEmu: 0,
  widthEmu: 100,
  heightEmu: 50,
  paragraphs: [],
}
const ZERO_INSETS = { l: 0, t: 0, r: 0, b: 0 }
const BOX_NF: Opts[] = [{ widthEmu: 'NaN' }, { heightEmu: 'Infinity' }, { id: 'NaN' }]

/** One input per numeric option where the TypeScript writes NaN or Infinity into the XML and the Rust ignores the value. */
export const NON_FINITE_DRAWING_BUILD: Array<{
  fn: string
  text: string
  args: Record<string, unknown>
}> = [
  ...nf('buildLineParagraphXml', { kind: 'line' }, BOX_NF),
  ...nf('inlinePictureDrawingXml', { rId: 'rId1', docPrId: 1, widthPx: 100, heightPx: 50 }, [
    { widthPx: 'NaN' },
    { heightPx: 'Infinity' },
    { rotDeg: 'Infinity' },
  ]),
  ...nf('buildTextboxParagraphXml', {}, BOX_NF),
  ...nf('buildAnchoredTextboxParagraphXml', ANCHORED_BASE, [
    { xEmu: 'NaN' },
    { yEmu: 'Infinity' },
    { widthEmu: 'NaN' },
    { heightEmu: '-Infinity' },
    { id: 'NaN' },
    { zOrder: 'NaN' },
    { insetsEmu: { ...ZERO_INSETS, l: 'NaN' } },
    { insetsEmu: { ...ZERO_INSETS, t: 'Infinity' } },
    { insetsEmu: { ...ZERO_INSETS, r: 'NaN' } },
    { insetsEmu: { ...ZERO_INSETS, b: '-Infinity' } },
    { holderLineTwips: 'NaN' },
    { holderSpacingBeforeTwips: 'Infinity' },
  ]),
  ...nf('buildShapeParagraphXml', { prst: 'rect' }, BOX_NF),
  ...nf('buildWordArtParagraphXml', {}, BOX_NF),
]

// The non-finite inputs are built inputs of the comparison; the mutations
// carry their numbers to other places.
for (const spec of GEN_DRAWING_BUILD) {
  const listed = NON_FINITE_DRAWING_BUILD.filter(({ fn }) => fn === spec.fn)
  if (listed.length === 0) continue
  spec.built.push(...listed.map(({ text, args }) => ({ text, args })))
}
