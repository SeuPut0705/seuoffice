// Group `layout` of comparison (f): align.ts, dgm-hier.ts, smartart-layout.ts
// and format-brush.ts of packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_layout.rs to `pptxLayout.<module>.<TypeScript name>`.
import { type AlignRect, alignRects, distributeRects } from '../../packages/pptx-engine/src/align'
import {
  type HierConstraints,
  type HierTreeNode,
  layoutHierTree,
  parseHierConstraints,
} from '../../packages/pptx-engine/src/dgm-hier'
import {
  applyFormat,
  type CopiedFormat,
  extractFormat,
} from '../../packages/pptx-engine/src/format-brush'
import { parseSlide } from '../../packages/pptx-engine/src/parse'
import {
  layoutShapes,
  SMARTART_PALETTE,
  type SmartArtLayout,
} from '../../packages/pptx-engine/src/smartart-layout'
import type { SlideElement, TextElement } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { mulberry32 } from '../docx-diff/synthetic'

/** What the Rust side receives: the value after JSON, so both sides read the same object. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/
const SHAPE_TREE_PART = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/
const DIAGRAM_LAYOUT_PART = /^ppt\/diagrams\/[^/]*layout[^/]*\.xml$/i

const partsMatching = (parts: ReadonlyMap<string, string>, name: RegExp): Array<[string, string]> =>
  [...parts].filter(([path]) => name.test(path))

// ── align.ts ────────────────────────────────────────────────────────────

const rect = (x: number, y: number, w: number, h: number): AlignRect => ({ x, y, w, h })

const RECT_SETS: AlignRect[][] = [
  [],
  [rect(10, 20, 30, 40)],
  [rect(0, 0, 100, 50), rect(200, 80, 60, 30)],
  [rect(50, 10, 20, 20), rect(0, 100, 40, 10), rect(300, 40, 80, 60), rect(120, 5, 10, 90)],
  // ties on x and y: the sort keeps their order
  [rect(5, 1, 10, 2), rect(5, 9, 3, 2), rect(1, 1, 4, 4), rect(5, 1, 7, 7), rect(1, 9, 2, 2)],
  [rect(-50, -20, 30, 10), rect(-0.5, 3.25, 1e-9, 7.1), rect(12.125, -7.75, 0.3, 0.7)],
  [rect(0.1, 0.2, 0.3, 0.7), rect(0.7, 0.1, 0.2, 0.3), rect(1 / 3, 2 / 3, 1 / 7, 1 / 9)],
  // negative and zero sizes
  [rect(10, 10, -10, -5), rect(0, 0, 0, 0), rect(30, -30, 5, 0), rect(20, 20, -1, 3)],
  // sums past the largest double
  [rect(1e308, 1e308, 1e308, 1), rect(-1e308, -1e308, 1e308, 1e308), rect(0, 0, 1, 1)],
  [rect(9e15, 1, 3, 1), rect(2 ** 53, 2, 1, 1), rect(-9e15, 3, 2, 1)],
]

const randomRects = (seed: number, count: number): AlignRect[] => {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () =>
    rect(
      Math.round(random() * 12192000) - 1000000,
      Math.round(random() * 6858000),
      Math.round(random() * 3000000),
      Math.round(random() * 2000000) / 4,
    ),
  )
}

const ALL_RECTS: AlignRect[][] = [
  ...RECT_SETS,
  ...[3, 7, 12, 25].map((count, i) => randomRects(0x5eed + i, count)),
]

const ALIGN_KINDS = [
  'left',
  'center-h',
  'right',
  'top',
  'center-v',
  'bottom',
  'middle',
  'constructor',
]
const CONTAINERS: Array<AlignRect | null> = [
  null,
  rect(0, 0, 960, 540),
  rect(-10, 5.5, 0, -3),
  rect(0, 0, 12192000, 6858000),
]
const DISTRIBUTE_KINDS = ['horizontal', 'vertical', 'diagonal', 'toString']

/** The xfrm of every shape of a slide, and the slide size of the deck. */
function rectsOf(parts: ReadonlyMap<string, string>): {
  slides: AlignRect[][]
  size: AlignRect | null
} {
  const sz = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(
    parts.get('ppt/presentation.xml') ?? '',
  )
  const size = sz ? rect(0, 0, Number(sz[1]), Number(sz[2])) : null
  const slides = partsMatching(parts, SLIDE_PART).map(([, text]) =>
    [
      ...text.matchAll(
        /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(-?\d+)" cy="(-?\d+)"\s*\/>/g,
      ),
    ].map(([, x, y, w, h]) => rect(Number(x), Number(y), Number(w), Number(h))),
  )
  return { slides: slides.filter((rects) => rects.length > 0), size }
}

// ── dgm-hier.ts ─────────────────────────────────────────────────────────

const node = (
  text: string,
  children: HierTreeNode[] = [],
  extra: Record<string, unknown> = {},
): HierTreeNode => ({ texts: text ? [text] : [], children, ...extra }) as HierTreeNode

const ORG_LAYOUT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/orgChart1">' +
  '<dgm:layoutNode name="hierChild1"><dgm:constrLst>' +
  '<dgm:constr type="h" for="des" forName="rootComposite1" refType="w" refFor="des" refForName="rootComposite1" fact="0.6"/>' +
  '<dgm:constr type="sibSp" refType="w" refFor="des" refForName="rootComposite1" fact="0.3"/>' +
  '<dgm:constr type="sp" for="des" forName="hierRoot1" refType="w" refFor="des" refForName="rootComposite1" fact="0.25"/>' +
  '<dgm:constr type="w" for="ch" forName="rootConnector1" refType="w" refFor="ch" refForName="rootText1" fact="0.2"/>' +
  '<dgm:constr type="primFontSz" for="des" ptType="node" op="equ"/>' +
  '<dgm:constr type="primFontSz" for="ch" forName="rootText1" val="48"/>' +
  '</dgm:constrLst></dgm:layoutNode></dgm:layoutDef>'

const constr = (attrs: string): string => `<dgm:constr ${attrs}/>`

const LAYOUT_TEXTS: string[] = [
  '',
  'x',
  ORG_LAYOUT,
  // the forms without the trailing 1, attribute values that parse to nothing
  constr('type="h" for="des" forName="rootComposite" refForName="rootComposite" fact="1.25"') +
    constr('type="sibSp" refForName="rootComposite" fact="0"') +
    constr('type="sp" for="des" forName="hierRoot1" fact="."') +
    constr('type="w" for="ch" forName="rootConnector" fact="1.2.3"') +
    constr('type="primFontSz" val="0"'),
  constr('type="h" for="des" forName="rootComposite1" refForName="rootComposite1" fact="00.5"') +
    constr('type="sibSp" refType="w" refForName="rootComposite1" fact=".75"') +
    constr('type="sp" for="des" forName="hierRoot1" fact="3."') +
    constr('type="w" for="ch" forName="rootConnector1" fact="0.0"') +
    constr('type="primFontSz" val="."'),
  // attributes in another order, the other quote, and a value word that only ends in val
  constr('for="des" type="h" forName="rootComposite1" refForName="rootComposite1" fact="0.9"') +
    "<dgm:constr type='sibSp' refForName='rootComposite1' fact='0.4'/>" +
    constr('type="sp"  for="des" forName="hierRoot1" fact="0.5"') +
    constr('type="primFontSz" xval="30"'),
  constr('type="primFontSz" op="equ" val="12.5"') +
    constr('type="primFontSz" val="99"') +
    constr('type="w" for="ch" forName="rootConnector1" fact="0.000001"') +
    constr('type="sibSp" fact="9" refForName="rootComposite1"'),
  // the factor sits behind a > of another element: [^>]* does not cross it
  '<dgm:constr type="sibSp" refForName="rootComposite1"><x fact="0.8"/></dgm:constr>' +
    constr('type="h" for="des" forName="rootComposite1" refForName="rootComposite1" fact="1e3"'),
  constr(
    `type="h" for="des" forName="rootComposite1" refForName="rootComposite1" fact="${'9'.repeat(400)}"`,
  ) + constr('type="primFontSz" val="1e999"'),
  constr('type="sp" for="des" forName="hierRoot1" fact="12345678901234567890.5"') +
    constr('type="primFontSz" val="\u{1F600}"') +
    constr('type="constructor" fact="2"'),
]

const ORG = (): HierTreeNode =>
  node('A', [
    node('B1', [node('C1'), node('C2', [node('D1'), node('D2')])]),
    node('B2', [node('C3'), node('C4')]),
  ])

const chain = (depth: number): HierTreeNode => {
  let ref = node(`d${depth}`)
  for (let i = depth - 1; i >= 0; i--) ref = node(`d${i}`, [ref])
  return ref
}

const BRANCHES = ['l', 'r', 'hang', 'std', 'init', 'constructor', '__proto__', '']

const TREES: HierTreeNode[][] = [
  [],
  [node('A')],
  [node('')],
  [ORG()],
  [node('A', [node('B1', [node('C1'), node('C2')]), node('B2', [node('C3')])])],
  [node('A', [node('B1'), node('B2')])],
  [
    node('Manager', [node('Assistant', [], { asst: true }), node('Employee'), node('Employee2')]),
    node('Manager2'),
  ],
  [node('M', [node('a1', [], { asst: true }), node('a2', [], { asst: true })])],
  [node('M', [node('a', [node('k')], { asst: true }), node('b', [], { asst: false })])],
  [node('M', [node('a', [], { asst: null }), node('b', [], { asst: true }), node('c')])],
  ...BRANCHES.map((hierBranch) => [
    node('A', [node('B', [node('C1'), node('C2', [node('E1'), node('E2')])], { hierBranch })]),
  ]),
  ...BRANCHES.map((hierBranch) => [
    node('A', [
      node('B', [node('C1', [], { asst: true }), node('C2'), node('C3')], { hierBranch }),
      node('F'),
    ]),
  ]),
  [node('A', [node('B', [node('C', [node('D1'), node('D2'), node('D3')])])], { hierBranch: null })],
  [node('r0', [node('a', [node('b')])]), node('r1', [node('c')]), node('r2')],
  [node('r0'), node('r1', [node('x', [node('y', [node('z')])])]), node('r2', [node('q')])],
  [
    node(
      'root',
      Array.from({ length: 30 }, (_, i) => node(`k${i}`)),
    ),
  ],
  [chain(30)],
  // keys the layout does not read, in an order of their own, come back on the box
  [
    {
      id: '7',
      sizePt: 14,
      spPr: { 'a:solidFill': { 'a:srgbClr': { '@_val': 'FF0000' } } },
      children: [{ children: [], texts: ['x', 'y'], styleLbl: 'node1', styleIdx: 2 }],
      texts: ['\u{1F600}', 'toString'],
      hierBranch: 'r',
    } as unknown as HierTreeNode,
  ],
]

const randomTree = (random: () => number, depth: number): HierTreeNode => {
  const fanout = depth >= 4 ? 0 : Math.floor(random() * (depth === 0 ? 4 : 5))
  const extra: Record<string, unknown> = {}
  if (random() < 0.2) extra.asst = true
  if (random() < 0.2) extra.hierBranch = BRANCHES[Math.floor(random() * BRANCHES.length)]
  return node(
    `n${depth}`,
    Array.from({ length: fanout }, () => randomTree(random, depth + 1)),
    extra,
  )
}

const RANDOM_TREES: HierTreeNode[][] = (() => {
  const random = mulberry32(0x0d6a)
  return Array.from({ length: 24 }, () =>
    Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomTree(random, 0)),
  )
})()

const cons = (over: Partial<HierConstraints>): HierConstraints => ({
  ...parseHierConstraints(undefined),
  ...over,
})

const CONS_SETS: HierConstraints[] = [
  cons({ boxAspect: 0 }),
  cons({ sp: 0, sibSp: 0 }),
  cons({ sp: -0.5, sibSp: -2 }),
  cons({ trunkOff: 0.75, hangIndent: -1.5 }),
  cons({ boxAspect: 1e-300, sp: 3.5 }),
  cons({ sibSp: 1.7e308 }),
]

const FRAMES: Array<[number, number]> = [
  [8000000, 6000000],
  [3000000, 2000000],
  [0, 0],
  [-100, 50],
  [1234.5, 1e-300],
]

// ── smartart-layout.ts ──────────────────────────────────────────────────

const SMARTART_LAYOUTS = [
  'list',
  'process',
  'cycle',
  'hierarchy',
  'pyramid',
  'matrix',
  'venn',
  'constructor',
  '',
]

const ITEM_SETS: string[][] = [
  [],
  ['A'],
  ['A', 'B'],
  ['A', 'B', 'C'],
  ['A', 'B', 'C', 'D'],
  ['A', 'B', 'C', 'D', 'E'],
  ['1', '2', '3', '4', '5', '6', '7', '8'],
  ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  ['', '\u{1F600}', 'toString', '__proto__', '&<>"'],
]

const SIZES: Array<[number, number]> = [
  [5486400, 3200400],
  [0, 0],
  [-1000, 500],
  [1234.5, 987.25],
  [1e15, 3],
  [100, 1000000],
  [1, 1],
]

// ── format-brush.ts ─────────────────────────────────────────────────────

const SOLID = { type: 'solid', color: '#FF0000' }
const STROKE = { fill: { type: 'solid', color: '#000000' }, width: 12700, dash: 'dash' }
const RUN = {
  text: 'a',
  fontFamily: 'Arial',
  fontSize: 18,
  bold: true,
  italic: false,
  underline: false,
  color: '#112233',
}
const para = (runs: unknown[] | undefined, align?: unknown): Record<string, unknown> => ({
  ...(runs === undefined ? {} : { runs }),
  ...(align === undefined ? {} : { align }),
})
const element = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'sp_1',
  type: 'shape',
  ...over,
})

const ELEMENTS: Array<Record<string, unknown>> = [
  element({
    fill: SOLID,
    stroke: STROKE,
    adjust: { adj: 16667 },
    text: { paragraphs: [para([RUN], 'center'), para([{ text: 'b', bold: false }], 'right')] },
  }),
  element({ type: 'text' }),
  { id: 'x' },
  element({ type: null }),
  element({ fill: { type: 'none' }, stroke: null, adjust: {} }),
  element({ fill: null, stroke: 0, adjust: null, text: null }),
  element({ fill: '', stroke: false, text: {} }),
  element({ fill: 1, stroke: 'x', text: { paragraphs: [] } }),
  element({ text: { paragraphs: [para(undefined)] } }),
  element({ text: { paragraphs: [para([])] } }),
  element({ text: { paragraphs: [para([], '')] } }),
  element({ text: { paragraphs: [para([], 'justify')] } }),
  element({ text: { paragraphs: [para([{ text: '' }], 0)] } }),
  element({
    text: {
      paragraphs: [
        para([
          { fontFamily: null, fontSize: 0, bold: false, italic: null, underline: true, color: '' },
        ]),
      ],
    },
  }),
  // the run's own key order does not decide the copy's
  element({
    text: {
      paragraphs: [
        para([
          { color: { type: 'scheme', value: 'accent1' }, underline: false, fontFamily: 'Gulim' },
        ]),
      ],
    },
  }),
  element({ adjust: { adj2: 1, adj1: 2, 10: 3, 2: 4 } }),
  element({ adjust: JSON.parse('{"__proto__": 5, "constructor": 1, "toString": 2}') }),
  element({ type: 'picture', fill: SOLID, stroke: STROKE }),
]

const FORMATS: Array<Record<string, unknown>> = [
  {},
  { sourceType: 'shape' },
  {
    sourceType: 'shape',
    shape: { fill: SOLID, stroke: STROKE, adjust: { adj: 5000 } },
    run: { fontFamily: 'Arial', bold: true },
    paragraph: { align: 'right' },
  },
  { sourceType: 'text', shape: { stroke: null } },
  { sourceType: 'text', shape: { fill: null } },
  { sourceType: 'text', shape: { fill: 0, stroke: '' } },
  { shape: null, run: null, paragraph: null },
  { shape: {}, run: {}, paragraph: {} },
  { run: { bold: null } },
  { run: { color: '#123456', fontFamily: 'Gulim', fontSize: 0 } },
  { paragraph: { align: '' } },
  { paragraph: { align: null } },
  { paragraph: { align: 'justify' } },
  { paragraph: { align: 1 } },
  { sourceType: 7, shape: { adjust: { adj: 1 } }, run: JSON.parse('{"__proto__": true}') },
]

const TARGETS: Array<string | undefined> = ['text', 'shape', 'picture', 'constructor', undefined]

/** The text and shape elements of every shape tree part, groups opened, as they cross JSON. */
function textElementsOf(parts: ReadonlyMap<string, string>): TextElement[] {
  const out: TextElement[] = []
  const walk = (elements: SlideElement[]): void => {
    for (const el of elements) {
      if (el.type === 'text' || el.type === 'shape') out.push(wire(el))
      else if (el.type === 'group') walk(el.children)
    }
  }
  for (const [path, slideXml] of partsMatching(parts, SHAPE_TREE_PART)) {
    try {
      walk(parseSlide({ path, slideXml, ctx: {} }).elements)
    } catch {
      // a part the parser refuses gives no elements
    }
  }
  return out.slice(0, 60)
}

export const LAYOUT: CallSpec[] = [
  {
    fn: 'pptxLayout.align.alignRects',
    call: (_text, args) =>
      alignRects(
        args.rects as AlignRect[],
        args.kind as Parameters<typeof alignRects>[1],
        args.containerRect as AlignRect | null,
      ),
    fromDocument: (parts) => {
      const { slides, size } = rectsOf(parts)
      return slides.flatMap((rects) =>
        ALIGN_KINDS.slice(0, 6).flatMap((kind) =>
          [null, size].map((containerRect) => ({ args: { rects, kind, containerRect } })),
        ),
      )
    },
    built: ALL_RECTS.flatMap((rects) =>
      ALIGN_KINDS.flatMap((kind) =>
        CONTAINERS.map((containerRect) => ({ args: { rects, kind, containerRect } })),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxLayout.align.distributeRects',
    call: (_text, args) =>
      distributeRects(
        args.rects as AlignRect[],
        args.kind as Parameters<typeof distributeRects>[1],
      ),
    fromDocument: (parts) =>
      rectsOf(parts).slides.flatMap((rects) =>
        ['horizontal', 'vertical'].map((kind) => ({ args: { rects, kind } })),
      ),
    built: ALL_RECTS.flatMap((rects) =>
      DISTRIBUTE_KINDS.map((kind) => ({ args: { rects, kind } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxLayout.dgm-hier.parseHierConstraints',
    call: (text, args) => parseHierConstraints(args.undefined === true ? undefined : text),
    fromDocument: (parts) =>
      partsMatching(parts, DIAGRAM_LAYOUT_PART).map(([, text]) => ({ text })),
    built: [
      { text: ORG_LAYOUT, args: { undefined: true } },
      ...LAYOUT_TEXTS.map((text) => ({ text })),
    ],
  },
  {
    fn: 'pptxLayout.dgm-hier.layoutHierTree',
    call: (text, args) =>
      layoutHierTree(
        args.roots as HierTreeNode[],
        (args.cons as HierConstraints | undefined) ?? parseHierConstraints(text),
        args.frameCx as number,
        args.frameCy as number,
      ),
    fromDocument: (parts) =>
      partsMatching(parts, DIAGRAM_LAYOUT_PART).flatMap(([, text]) =>
        [[ORG()], TREES[6]!, TREES[13]!].map((roots) => ({
          text,
          args: { roots, frameCx: 8000000, frameCy: 6000000 },
        })),
      ),
    built: [
      ...[...TREES, ...RANDOM_TREES].flatMap((roots, i): Input[] => [
        { text: '', args: { roots, frameCx: 8000000, frameCy: 6000000 } },
        {
          text: ORG_LAYOUT,
          args: {
            roots,
            frameCx: FRAMES[i % FRAMES.length]![0],
            frameCy: FRAMES[i % FRAMES.length]![1],
          },
        },
        {
          text: LAYOUT_TEXTS[3 + (i % (LAYOUT_TEXTS.length - 3))]!,
          args: { roots, frameCx: 3000000, frameCy: 2000000 },
        },
      ]),
      ...CONS_SETS.flatMap((c, i) =>
        [[ORG()], TREES[6]!, TREES[7]!, TREES[13]!, [node('A')], TREES[14]!].map(
          (roots, j): Input => ({
            args: {
              roots,
              cons: c,
              frameCx: FRAMES[(i + j) % FRAMES.length]![0],
              frameCy: FRAMES[(i + j) % FRAMES.length]![1],
            },
          }),
        ),
      ),
    ],
  },
  {
    fn: 'pptxLayout.smartart-layout.layoutShapes',
    call: (_text, args) =>
      layoutShapes(
        args.layout as SmartArtLayout,
        args.items as string[],
        args.cx as number,
        args.cy as number,
      ),
    fromDocument: (parts) => {
      const sz = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(
        parts.get('ppt/presentation.xml') ?? '',
      )
      const [cx, cy] = sz ? [Number(sz[1]), Number(sz[2])] : [9144000, 6858000]
      return partsMatching(parts, SLIDE_PART).flatMap(([, text]) => {
        const items = [...text.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(([, t]) => t!).slice(0, 9)
        return SMARTART_LAYOUTS.slice(0, 7).map((layout) => ({ args: { layout, items, cx, cy } }))
      })
    },
    built: SMARTART_LAYOUTS.flatMap((layout) =>
      ITEM_SETS.flatMap((items) => SIZES.map(([cx, cy]) => ({ args: { layout, items, cx, cy } }))),
    ),
    mutation: 'none',
  },
  {
    fn: 'pptxLayout.smartart-layout.SMARTART_PALETTE',
    call: (_text, args) => SMARTART_PALETTE[args.index as number],
    built: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1, 0.5, 1e21].map((index) => ({ args: { index } })),
    mutation: 'none',
  },
  {
    fn: 'pptxLayout.format-brush.extractFormat',
    call: (_text, args) => extractFormat(args.el as TextElement),
    fromDocument: (parts) => textElementsOf(parts).map((el) => ({ args: { el } })),
    built: ELEMENTS.map((el) => ({ args: { el } })),
    mutation: 'none',
  },
  {
    fn: 'pptxLayout.format-brush.applyFormat',
    call: (_text, args) =>
      applyFormat(args.fmt as CopiedFormat, args.targetType as Parameters<typeof applyFormat>[1]),
    fromDocument: (parts) =>
      textElementsOf(parts).flatMap((el) => {
        const fmt = wire(extractFormat(el))
        return TARGETS.slice(0, 3).map((targetType) => ({ args: { fmt, targetType } }))
      }),
    built: [
      ...FORMATS.flatMap((fmt) =>
        TARGETS.map((targetType) => ({
          args: targetType === undefined ? { fmt } : { fmt, targetType },
        })),
      ),
      ...ELEMENTS.map((el) => ({
        args: { fmt: wire(extractFormat(el as unknown as TextElement)), targetType: 'shape' },
      })),
    ],
    mutation: 'none',
  },
]
