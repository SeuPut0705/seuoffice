// Group `blockpasses`: parse-block-passes.ts, the passes run over the parsed
// blocks. Each pass mutates its argument: the call works on a copy made as
// the wire makes it (so the Rust side receives the arguments untouched) and
// returns that copy, so the key order of every object a pass writes into is
// compared. The corpus model has been through these passes already and
// mostly takes the no-change paths; the built inputs carry the changes.
import {
  applyBalancedDbcsSpacing,
  applyProtectedLeadingBreaks,
  bandWrappedBoxesBeforeTables,
  blockRunGroups,
  floatTableColumnSpan,
  normalizeImageZOrders,
} from './reference/parse-block-passes'
import type { EffectiveRPr } from './reference/resolve-props'
import type {
  Block,
  BlockType,
  ParsedDoc,
  Run,
  SectionSettings,
  TableCell,
  TableModel,
  TextboxDisplay,
} from './reference/types'
import type { CallSpec, Input } from './calls-spec'

/** The value as it crosses the wire. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The value as it crosses the wire, with data URLs cut short: they only make inputs large. */
const slim = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && item.startsWith('data:') && item.length > 256
        ? item.slice(0, 64)
        : item,
    ),
  ) as T

let nextId = 0
const block = (type: BlockType, extra: Partial<Block> = {}): Block => ({
  id: `built-${nextId}`,
  type,
  docxIndex: nextId++,
  originalXml: null,
  ...extra,
})

const run = (text: string, extra: Partial<Run> = {}): Run => ({ text, ...extra })

const box = (extra: Partial<TextboxDisplay> = {}): TextboxDisplay => ({ paras: [], ...extra })

// ---- applyProtectedLeadingBreaks

const DRAWING = '<w:r><w:drawing><wp:inline distT="0"/></w:drawing></w:r>'
const PAGE_BR = '<w:r><w:br w:type="page"/></w:r>'
const p = (inner: string, open = '<w:p>'): string => `${open}${inner}</w:p>`
const pPr = (inner: string): string => `<w:pPr>${inner}</w:pPr>`
const textRun = (text: string, open = '<w:t>'): string => `<w:r>${open}${text}</w:t></w:r>`

/** Paragraphs whose own pPr does or does not ask for a page break before. */
const HOST_XMLS = [
  p(pPr('<w:pageBreakBefore/>') + DRAWING),
  p(pPr('<w:pageBreakBefore w:val="1"/>') + DRAWING, '<w:p w:rsidR="00A1">'),
  p(pPr('<w:jc w:val="center"/><w:pageBreakBefore  w:val="true" />') + DRAWING),
  p(pPr('<w:pageBreakBefore w:val="on"/>') + DRAWING),
  p(pPr('<w:pageBreakBefore w:val="0"/>') + DRAWING),
  p(pPr('<w:pageBreakBefore w:val="false"/>') + DRAWING),
  p(`\n  ${pPr('<w:pageBreakBefore/>')}${DRAWING}`),
  // a tracked change's previous pPr is not the live one
  p(
    pPr('<w:jc/><w:pPrChange w:id="1"><w:pPr><w:pageBreakBefore/></w:pPr></w:pPrChange>') + DRAWING,
  ),
  p(pPr('<w:pPrChange w:id="1"><w:pPr/></w:pPrChange><w:pageBreakBefore/>') + DRAWING),
  p(pPr('<w:pPrChange>x</w:pPrChange><w:pageBreakBefore/>') + DRAWING),
  // the pPr must open the paragraph
  p(`${textRun('a')}${pPr('<w:pageBreakBefore/>')}${DRAWING}`),
  p(pPr('<w:pageBreakBeforeX/>') + DRAWING),
  `<w:pPr><w:pageBreakBefore/></w:pPr>${DRAWING}`,
]

/** Image paragraphs with a page-break run before or after the drawing. */
const RUN_XMLS = [
  p(PAGE_BR + DRAWING),
  p(`<w:r><w:br w:type='page'/></w:r>${DRAWING}`),
  p(`<w:r><w:br w:type="page'/></w:r>${DRAWING}`),
  p(`<w:r><w:br w:type="column"/></w:r>${DRAWING}`),
  p(`<w:r><w:br/></w:r>${DRAWING}`),
  p(textRun('x') + PAGE_BR + DRAWING),
  p(textRun(' \u3000\t', '<w:t xml:space="preserve">') + PAGE_BR + DRAWING),
  p(textRun('\ufeff') + PAGE_BR + DRAWING),
  p(textRun('\u0085') + PAGE_BR + DRAWING),
  p(textRun('\u{1F600}') + PAGE_BR + DRAWING),
  p(textRun('\ud55c\uae00') + PAGE_BR + DRAWING),
  p(textRun('') + PAGE_BR + DRAWING),
  p(PAGE_BR + textRun('after the break') + DRAWING),
  p(`${PAGE_BR}<w:r><w:pict><v:shape/></w:pict></w:r>`),
  p(`${PAGE_BR}<w:r><w:object><v:shape/></w:object></w:r>`),
  p(`${PAGE_BR}<w:r><w:drawingX/></w:r>`),
  p(PAGE_BR),
  p(textRun('x') + PAGE_BR),
  p(DRAWING + PAGE_BR),
  p(DRAWING + textRun('x') + `<w:r><w:br w:type='page'/></w:r>`),
  p(`<w:r><w:drawing><w:txbxContent>${p(PAGE_BR)}</w:txbxContent></w:drawing></w:r>`),
  p(`<w:r><w:drawing><w:txbxContent>${p(PAGE_BR)}</w:txbxContent></w:drawing></w:r>${PAGE_BR}`),
  p(`<w:r><w:pict>${PAGE_BR}</w:pict></w:r>`),
  p(DRAWING + textRun('\u{1F600}')),
  p(DRAWING),
]

const pageBreakField = { kind: 'pageBreak' } as const

/** A text box whose paragraph holds a paired w:pPrChange after the host pPr. */
const BOX_WITH_PPR_CHANGE =
  '<w:r><w:drawing><w:txbxContent><w:p><w:pPr><w:pPrChange w:id="2"><w:pPr/></w:pPrChange></w:pPr></w:p></w:txbxContent></w:drawing></w:r>'

/**
 * A self-closing w:pPrChange in the host pPr. The TypeScript strips from it
 * to a later `</w:pPrChange>` and loses the live pPr (the first input, listed);
 * without a later one, or without attributes, both sides agree.
 */
const SELF_CLOSING_PPR_CHANGE: Block[][] = [
  p(pPr('<w:pPrChange w:id="1" w:author="A"/><w:pageBreakBefore/>') + BOX_WITH_PPR_CHANGE),
  p(
    pPr('<w:pPrChange w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"/><w:pageBreakBefore/>') +
      DRAWING,
  ),
  p(pPr('<w:pPrChange/><w:pageBreakBefore/>') + DRAWING),
  p(pPr('<w:pPrChange/><w:pageBreakBefore/>') + BOX_WITH_PPR_CHANGE),
].flatMap((originalXml, i) =>
  (['image', 'passthrough'] as const).map((type, t) => [
    { id: `ppr-change-${2 * i + t}`, type, docxIndex: 2 * i + t, originalXml },
  ]),
)

const LEADING_BLOCKS: Block[][] = [
  ...[...HOST_XMLS, ...RUN_XMLS].flatMap((xml) => [
    [block('image', { originalXml: xml })],
    [block('passthrough', { originalXml: xml })],
  ]),
  [block('paragraph', { originalXml: HOST_XMLS[0]! })],
  [block('table', { originalXml: RUN_XMLS[0]! })],
  // an existing format: pageBreakBefore keeps its place, or goes last
  [
    block('image', {
      format: { align: 'left', pageBreakBefore: false, keepNext: true },
      originalXml: HOST_XMLS[0]!,
    }),
  ],
  [block('image', { format: { keepNext: true }, originalXml: RUN_XMLS[0]! })],
  [block('passthrough', { format: { align: 'center' }, originalXml: HOST_XMLS[1]! })],
  [
    block('image', {
      format: { pageBreakBefore: true, align: 'right' },
      originalXml: RUN_XMLS[0]!,
    }),
  ],
  [block('image', { format: {}, originalXml: RUN_XMLS[18]! })],
  [block('image', { originalXml: '' })],
  [block('passthrough', { originalXml: null })],
  [block('image', { hidden: true, originalXml: HOST_XMLS[0]! })],
  [block('image', { hidden: false, originalXml: RUN_XMLS[0]! })],
  [block('passthrough', { label: 'Section break paragraph', originalXml: HOST_XMLS[0]! })],
  [block('image', { label: 'Section break paragraph ', originalXml: RUN_XMLS[0]! })],
  [block('image', { fieldDisplay: { kind: 'text', left: 'x' }, originalXml: RUN_XMLS[18]! })],
  [block('image', { fieldDisplay: pageBreakField, originalXml: RUN_XMLS[19]! })],
  [
    block('image', { originalXml: RUN_XMLS[18]! }),
    block('paragraph', { runs: [run('between')], originalXml: p(textRun('between')) }),
    block('image', { label: 'Picture', originalXml: RUN_XMLS[0]! }),
    block('passthrough', { originalXml: HOST_XMLS[2]! }),
  ],
  ...SELF_CLOSING_PPR_CHANGE,
  [],
]

// ---- applyBalancedDbcsSpacing

const EFFECTIVE = (eastAsia?: string): EffectiveRPr => ({
  cs: false,
  bold: false,
  italic: false,
  sizeHalfPoints: 22,
  fonts: { ascii: 'Calibri', ...(eastAsia !== undefined ? { eastAsia } : {}) },
  underline: false,
  strike: false,
  caps: 'none',
  vanish: false,
  charSpacingTwips: 20,
  source: {},
})

/** One character at each edge of the ranges the fraction counts. */
const EDGE_CHARACTERS = [
  0x10ff, 0x1100, 0x11ff, 0x1200, 0x2e7f, 0x2e80, 0x303f, 0x3040, 0x30ff, 0x3100, 0x312f, 0x3130,
  0x318f, 0x3190, 0x31ef, 0x31f0, 0x31ff, 0x3200, 0x9fff, 0xa000, 0xabff, 0xac00, 0xd7af, 0xd7b0,
  0xf8ff, 0xf900, 0xfaff, 0xfb00, 0xfeff, 0xff00, 0xff60, 0xff61, 0x1f600, 0x1ffff, 0x20000,
  0x2a6d6,
].map((cp) => String.fromCodePoint(cp))

/** Faces that keep hangul and kana single, written as documents write them, and some that do not. */
const FONTS = [
  'Malgun Gothic',
  'MALGUN GOTHIC Semilight',
  '\ub9d1\uc740 \uace0\ub515',
  '\ub9d1\uc740\u3000\uace0\ub515',
  'Nanum Gothic',
  '\ub098\ub214\uace0\ub515',
  'Apple SD Gothic Neo',
  'MS PGothic',
  '\uff2d\uff33\uff30\u30b4\u30b7\u30c3\u30af',
  '\uff2d\uff33 \uff30\u30b4\u30b7\u30c3\u30af',
  'Batang',
  'MS Gothic',
  '',
  ' malgungothic\n',
  'malgun\ufeffgothic',
  'malgun\u0085gothic',
  'MALGUNGOTH\u0130C',
  'app\u017fesdgothicneo',
  'Malgun Gothic\u212a',
  'malgungothic\u0131',
]

const DBCS_GROUPS: Array<Array<Run[] | null>> = [
  [],
  [null, []],
  [
    [
      run('abc', { charSpacingTwips: 20 }),
      run('\ud55c\uae00', { charSpacingTwips: 20 }),
      run('\ud55c\uae00'),
      run('\ud55c\uae00', { charSpacingTwips: 0 }),
      run('', { charSpacingTwips: 20 }),
      run('a\ud55c', { charSpacingTwips: 15 }),
      run('\u6f22aaa', { charSpacingTwips: -1 }),
      run('\u6f22a', { charSpacingTwips: -10 }),
      run('\u{1F600}\u6f22', { charSpacingTwips: 10 }),
      run('\u{20000}', { charSpacingTwips: 7.5 }),
      run('\u304b\u6f22', { charSpacingTwips: 3 }),
    ],
    null,
    [run('\ud55c', { charSpacingTwips: 1.05 }), run('\u3042b', { charSpacingTwips: 0.15 })],
  ],
  [EDGE_CHARACTERS.map((ch) => run(ch, { charSpacingTwips: 20 }))],
  [EDGE_CHARACTERS.map((ch) => run(ch, { charSpacingTwips: 20, eastAsiaFont: 'Malgun Gothic' }))],
  [FONTS.map((font) => run('\ud55c\u304b\u6f22a', { charSpacingTwips: 20, eastAsiaFont: font }))],
  [
    FONTS.map((font) =>
      run('\ud55c\u304b\u6f22a', { charSpacingTwips: 20, effective: EFFECTIVE(font) }),
    ),
  ],
  [
    [
      run('\ud55c', { charSpacingTwips: 20, effective: EFFECTIVE() }),
      run('\ud55c', {
        charSpacingTwips: 20,
        eastAsiaFont: '',
        effective: EFFECTIVE('Malgun Gothic'),
      }),
      run('\ud55c', {
        charSpacingTwips: 20,
        eastAsiaFont: 'Batang',
        effective: EFFECTIVE('Malgun Gothic'),
      }),
      run('\ud55c', {
        charSpacingTwips: 20,
        eastAsiaFont: 'Malgun Gothic',
        effective: EFFECTIVE('Batang'),
      }),
      run('\ud55c', { charSpacingTwips: 20, effective: EFFECTIVE('') }),
    ],
  ],
]

const DEFAULT_FONTS: Array<string | undefined> = [undefined, 'Malgun Gothic', 'Batang', '']

// ---- blockRunGroups

const cell = (extra: Partial<TableCell> = {}): TableCell => ({ paras: [], ...extra })

const NESTED: TableModel = {
  rows: [
    [
      cell({
        richParas: [{ runs: [run('nested')] }],
        nestedTables: [{ rows: [[cell({ richParas: [{ runs: [run('deep')] }] })]] }],
      }),
    ],
  ],
}

const GROUP_BLOCKS: Block[][] = [
  [],
  [block('paragraph')],
  [block('paragraph', { runs: [run('a')], strayRuns: [run('stray')] })],
  [block('paragraph', { strayRuns: [] })],
  [
    block('table', {
      table: {
        rows: [
          [
            cell({
              anchoredBoxes: [box({ paras: [{ runs: [run('in a cell box')] }, { runs: [] }] })],
              richParas: [{ runs: [run('one')] }, { runs: [run('two')] }],
              nestedTables: [NESTED, { rows: [] }],
            }),
            cell(),
          ],
          [],
        ],
      },
    }),
    block('paragraph', {
      runs: [run('anchor')],
      textboxes: [
        box({ paras: [{ runs: [run('box')] }] }),
        box(),
        box({ paras: [{ runs: [run('second')] }] }),
      ],
    }),
    block('table', { table: { rows: [] } }),
  ],
]

// ---- normalizeImageZOrders

const zImage = (z: number | undefined, extra: Partial<Block> = {}): Block =>
  block('image', { ...(z !== undefined ? { imageZOrder: z } : {}), ...extra })

const zBoxes = (...zs: Array<number | undefined>): TextboxDisplay[] =>
  zs.map((z) => box(z !== undefined ? { floating: true, z } : { floating: true }))

const Z_BLOCKS: Block[][] = [
  [],
  [block('paragraph')],
  [zImage(3), zImage(-2), block('paragraph', { textboxes: zBoxes(10000, -10000) })],
  [zImage(10001)],
  [zImage(-10001)],
  [block('paragraph', { textboxes: zBoxes(10001) })],
  [block('paragraph', { textboxes: zBoxes(20000, 5, undefined, 5) })],
  [
    zImage(251658245, { imageZOrderNormalized: false }),
    zImage(5),
    block('paragraph', { textboxes: zBoxes(-10001, 5) }),
    zImage(5, { textboxes: zBoxes(4) }),
    zImage(undefined, { textboxes: zBoxes(251658240) }),
    zImage(0),
    block('paragraph'),
  ],
  [zImage(-20000, { imageWrap: 'behind' }), zImage(2.5), zImage(-1e9, { textboxes: zBoxes(-1e9) })],
  [zImage(1), zImage(2), zImage(3), zImage(100000)],
  [zImage(0, { imageZOrderNormalized: true }), zImage(-0.5), zImage(1e300)],
]

// ---- floatTableColumnSpan

const SECTIONS: SectionSettings[] = [
  {
    pageWidth: 11906,
    pageHeight: 16838,
    orientation: 'portrait',
    marginTop: 1440,
    marginRight: 1440,
    marginBottom: 1440,
    marginLeft: 1800,
    pageBorder: false,
    columns: 1,
  },
  {
    pageWidth: 12240,
    pageHeight: 15840,
    orientation: 'landscape',
    marginTop: 720,
    marginRight: 720,
    marginBottom: 720,
    marginLeft: -0.5,
    pageBorder: true,
    columns: 2,
  },
]

const floatTable = (
  floatPos: TableModel['floatPos'],
  colWidthsTwips: number[] | undefined = [2000, 3000.5],
): TableModel => ({
  rows: [],
  ...(colWidthsTwips !== undefined ? { colWidthsTwips } : {}),
  ...(floatPos !== undefined ? { floatPos } : {}),
})

const POSITIONS: NonNullable<TableModel['floatPos']>[] = [
  { xTwips: 100, yTwips: 0 },
  { xTwips: 100, yTwips: 0, horzAnchor: 'page' },
  { xTwips: 100, yTwips: 0, horzAnchor: 'margin' },
  { xTwips: -250, yTwips: 10, horzAnchor: 'text', distanceTwips: { left: 180, right: 144 } },
  { xTwips: 0, yTwips: 0, horzAnchor: 'page', distanceTwips: { top: 0, bottom: 0 } },
  { xTwips: 1800.5, yTwips: 0, distanceTwips: { right: -36 } },
  { xTwips: 0, yTwips: 0, horzAnchor: 'margin', xSpec: 'center', distanceTwips: { left: 0 } },
]

const SPAN_BLOCKS: Block[] = [
  block('paragraph', { table: floatTable(POSITIONS[0]) }),
  block('table'),
  block('table', { table: floatTable(undefined) }),
  block('table', { table: floatTable(POSITIONS[0], undefined) }),
  block('table', { table: floatTable(POSITIONS[0], []) }),
  block('table', { table: floatTable(POSITIONS[0], [0]) }),
  ...POSITIONS.map((pos) => block('table', { table: floatTable(pos) })),
  ...POSITIONS.map((pos) => block('table', { table: floatTable(pos, [1440]) })),
  block('table', {
    table: floatTable(POSITIONS[2]),
    originalXml: '<w:tbl><w:tblPr><w:tblpPr w:tblpXSpec="center"/></w:tblPr></w:tbl>',
  }),
  block('table', {
    table: floatTable(POSITIONS[2]),
    originalXml: '<w:tbl><w:tblPr><w:tblpPr w:tblpX="10"/></w:tblPr></w:tbl>',
  }),
  block('table', {
    table: floatTable(POSITIONS[2]),
    originalXml: '<w:tbl xw:tblpXSpec="center"/>',
  }),
  block('table', {
    table: floatTable(POSITIONS[2]),
    originalXml: '<w:tbl \u212aw:tblpXSpec="center"/>',
  }),
]

// ---- bandWrappedBoxesBeforeTables

const wrapped = (extra: Partial<TextboxDisplay> = {}): TextboxDisplay =>
  box({ floating: true, wrapSides: true, heightPx: 50, offsetYEmu: 95250, ...extra })

const table = (): Block => block('table', { table: { rows: [] } })

const BAND_BLOCKS: Block[][] = [
  [],
  [block('paragraph', { textboxes: [] }), table()],
  [block('paragraph', { textboxes: [wrapped()] }), table()],
  [block('paragraph', { textboxes: [wrapped()] })],
  [block('paragraph', { textboxes: [wrapped(), wrapped({ floating: false })] }), table()],
  [
    block('paragraph', { textboxes: [wrapped()] }),
    block('paragraph', { runs: [run('text')] }),
    table(),
  ],
  [
    block('paragraph', { textboxes: [wrapped()] }),
    block('paragraph'),
    block('paragraph', { runs: [] }),
    block('paragraph', { runs: [run(''), run(' \u3000\ufeff\t')] }),
    table(),
  ],
  [
    block('paragraph', { textboxes: [wrapped()] }),
    block('paragraph', { runs: [run('\u0085')] }),
    table(),
  ],
  [
    block('paragraph', { textboxes: [wrapped()] }),
    block('paragraph', { runs: [run('', { image: { dataUrl: '', xml: '<w:drawing/>' } })] }),
    table(),
  ],
  [block('paragraph', { textboxes: [wrapped()] }), block('heading', { runs: [] }), table()],
  [block('image', { textboxes: [wrapped()] }), block('paragraph', { runs: [] })],
  [
    block('paragraph', {
      textboxes: [
        wrapped({ wrapSides: false }),
        wrapped({ bandBottomPx: 0 }),
        wrapped({ pagePinned: true }),
        wrapped({ pageRelV: true }),
        wrapped({ heightPx: undefined }),
        wrapped({ offsetYEmu: -476250 }),
        wrapped({ offsetYEmu: -476250, heightPx: 51 }),
        wrapped({ offsetYEmu: undefined }),
        wrapped({ offsetYEmu: 14287.5, heightPx: 10 }),
        wrapped({ offsetYEmu: -14287.5, heightPx: 10 }),
        wrapped({ bandTopPx: 99, pagePinned: false, pageRelV: false }),
        box({ floating: true, offsetYEmu: 0, heightPx: 20, wrapSides: true, bandBeside: false }),
      ],
    }),
    table(),
  ],
  [
    block('paragraph', { textboxes: [wrapped()] }),
    block('paragraph', { textboxes: [wrapped({ offsetYEmu: 190500 })] }),
    table(),
    table(),
  ],
]

// ---- inputs of the corpus model

/** Blocks whose fields a pass reads, each as a list of its own. */
function eachBlockOf(doc: ParsedDoc, wanted: (b: Block) => boolean, limit = 40): Input[] {
  return doc.blocks
    .filter(wanted)
    .slice(0, limit)
    .map((b) => ({ args: { blocks: [slim(b)] } }))
}

/** Blocks with a textbox, each with the empty paragraphs after it and the block that ends them. */
function bandWindowsOf(doc: ParsedDoc): Input[] {
  const inputs: Input[] = []
  doc.blocks.forEach((b, i) => {
    if (!b.textboxes?.length || inputs.length >= 40) return
    let j = i + 1
    while (
      j < doc.blocks.length &&
      doc.blocks[j]!.type === 'paragraph' &&
      !(doc.blocks[j]!.runs ?? []).some((r) => r.text.trim() !== '' || r.image)
    )
      j++
    inputs.push({ args: { blocks: slim(doc.blocks.slice(i, j + 1)) } })
  })
  return inputs
}

const call =
  (pass: (blocks: Block[]) => void) =>
  (_text: string, args: Record<string, unknown>): Block[] => {
    const blocks = wire(args.blocks as Block[])
    pass(blocks)
    return blocks
  }

export const BLOCKPASSES: CallSpec[] = [
  {
    fn: 'blockpasses.applyProtectedLeadingBreaks',
    argMutation: true,
    call: call(applyProtectedLeadingBreaks),
    fromModel: (doc) => eachBlockOf(doc, (b) => b.type === 'image' || b.type === 'passthrough'),
    built: LEADING_BLOCKS.map((blocks) => ({ args: { blocks } })),
    mutation: 'none',
  },
  {
    fn: 'blockpasses.applyBalancedDbcsSpacing',
    argMutation: true,
    call: (_text, args) => {
      const runGroups = wire(args.runGroups as Array<Run[] | undefined>)
      applyBalancedDbcsSpacing(runGroups, args.defaultFont as string | undefined)
      return runGroups
    },
    fromModel: (doc) => {
      const runGroups = blockRunGroups(slim(doc.blocks)).filter((runs) =>
        runs?.some((r) => r.charSpacingTwips),
      )
      if (runGroups.length === 0 || runGroups.flat().length > 2000) return []
      const defaultFont = doc.docDefaults?.eastAsiaFont
      return [{ args: { runGroups, ...(defaultFont !== undefined ? { defaultFont } : {}) } }]
    },
    built: DBCS_GROUPS.flatMap((runGroups) =>
      DEFAULT_FONTS.map((defaultFont) => ({
        args: { runGroups, ...(defaultFont !== undefined ? { defaultFont } : {}) },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'blockpasses.blockRunGroups',
    argMutation: true,
    call: (_text, args) => blockRunGroups(wire(args.blocks as Block[])),
    fromModel: (doc) =>
      eachBlockOf(
        doc,
        (b) =>
          b.type === 'table' || (b.textboxes?.length ?? 0) > 0 || (b.strayRuns?.length ?? 0) > 0,
        20,
      ),
    built: GROUP_BLOCKS.map((blocks) => ({ args: { blocks } })),
    mutation: 'none',
  },
  {
    fn: 'blockpasses.normalizeImageZOrders',
    argMutation: true,
    call: call(normalizeImageZOrders),
    fromModel: (doc) => {
      const blocks = doc.blocks.filter(
        (b) => b.imageZOrder !== undefined || b.textboxes?.some((t) => t.z !== undefined),
      )
      return blocks.length === 0 || blocks.length > 200 ? [] : [{ args: { blocks: slim(blocks) } }]
    },
    built: Z_BLOCKS.map((blocks) => ({ args: { blocks } })),
    mutation: 'none',
  },
  {
    fn: 'blockpasses.floatTableColumnSpan',
    argMutation: true,
    call: (_text, args) => floatTableColumnSpan(args.block as Block, args.sect as SectionSettings),
    fromModel: (doc) =>
      doc.blocks
        .filter((b) => b.type === 'table' && b.table?.floatPos !== undefined)
        .slice(0, 20)
        .flatMap((b) => SECTIONS.map((sect) => ({ args: { block: slim(b), sect } }))),
    built: SPAN_BLOCKS.flatMap((b) => SECTIONS.map((sect) => ({ args: { block: b, sect } }))),
    mutation: 'none',
  },
  {
    fn: 'blockpasses.bandWrappedBoxesBeforeTables',
    argMutation: true,
    call: call(bandWrappedBoxesBeforeTables),
    fromModel: bandWindowsOf,
    built: BAND_BLOCKS.map((blocks) => ({ args: { blocks } })),
    mutation: 'none',
  },
]
