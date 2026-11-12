// Group `decktables` of the comparison: the table editing of index.ts (cell
// text, style, row/column structure, merge/split, sizes, resize, cell anchor).
// The Rust side answers in crates/office-wasm/src/calls/pptx_decktables.rs to
// `pptxDecktables.index.<TypeScript name>`.
//
// The tracked decks hold no table with merges, spans, a missing gridCol or the
// two gridCol forms, so every input writes its own slide XML into slide1 of the
// blank deck (`textPart`). Private functions (gridColSpans, nthTagSpan,
// clearTcText, bumpFrameExt, tcAttr, setTcAttrXml, tcParagraphsXml, scaleToSum)
// are proven through the exports that reach them.
import JSZip from 'jszip'
import {
  editTableCellText,
  editTableStructure,
  editTableStyle,
  ensureTableStylePart,
  mergeTableCells,
  resizeTable,
  setTableCellAnchor,
  setTableColWidth,
  setTableRowHeight,
} from '../../packages/pptx-engine/src/index'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckInput, deckNamed, deckOp } from './deck-ops'

const PART = 'ppt/slides/slide1.xml'
const BLANK = 'blank deck'

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const slideXml = (...shapes: string[]): string =>
  `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`

const frame = (tbl: string, xfrm = '<a:off x="100" y="200"/><a:ext cx="600" cy="110"/>'): string =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr>' +
  '<a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
  `<p:xfrm>${xfrm}</p:xfrm><a:graphic>` +
  `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData>` +
  '</a:graphic></p:graphicFrame>'

const SHAPE =
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:sp>'

const tc = (text: string, tcPr = '', attrs = ''): string =>
  `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody>${tcPr}</a:tc>`

const tr = (h: string, ...cells: string[]): string => `<a:tr${h}>${cells.join('')}</a:tr>`

const H = (n: number): string => ` h="${n}"`
const COLID = (n: number): string =>
  `<a:extLst><a:ext uri="{9D8B030D-6E8A-4147-A177-3AD203B41FA5}"><a16:colId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="${n}"/></a:ext></a:extLst>`

const SELF = '<a:tblGrid><a:gridCol w="100"/><a:gridCol w="200"/><a:gridCol w="300"/></a:tblGrid>'
const PAIRED = `<a:tblGrid><a:gridCol w="100">${COLID(1)}</a:gridCol><a:gridCol w="200">${COLID(2)}</a:gridCol><a:gridCol w="300">${COLID(3)}</a:gridCol></a:tblGrid>`
const MIXED = `<a:tblGrid><a:gridCol w="100">${COLID(1)}</a:gridCol><a:gridCol w="200"/><a:gridCol w="300">${COLID(3)}</a:gridCol></a:tblGrid>`
const SHORT = '<a:tblGrid><a:gridCol w="100"/></a:tblGrid>'
const UNCLOSED = '<a:tblGrid><a:gridCol w="100"/><a:gridCol w="200"></a:tblGrid>'
const NOW = '<a:tblGrid><a:gridCol/><a:gridCol w="200"/><a:gridCol w="300"/></a:tblGrid>'

const row = (h: string, a: string, b: string, c: string, pr = ''): string =>
  tr(h, tc(a, pr), tc(b, pr), tc(c, pr))

const tbl = (grid: string, pr: string, ...rows: string[]): string =>
  `<a:tbl>${pr}${grid}${rows.join('')}</a:tbl>`

const PLAIN_ROWS = [row(H(50), 'a', 'b', 'c'), row(H(60), 'd', 'e', 'f')]

/** The slide texts: each one table, at element 0 unless noted. */
const TABLES: Array<[string, string]> = [
  ['self-closing grid', slideXml(frame(tbl(SELF, '<a:tblPr firstRow="1"/>', ...PLAIN_ROWS)))],
  ['paired grid', slideXml(frame(tbl(PAIRED, '<a:tblPr/>', ...PLAIN_ROWS)))],
  ['mixed grid', slideXml(frame(tbl(MIXED, '<a:tblPr/>', ...PLAIN_ROWS)))],
  [
    'rows without h and a frame without ext',
    slideXml(
      frame(
        tbl(SELF, '<a:tblPr/>', row('', 'a', 'b', 'c'), row(' h = "7"', 'd', 'e', 'f')),
        '<a:off x="100" y="200"/>',
      ),
    ),
  ],
  [
    'merged cells',
    slideXml(
      frame(
        tbl(
          SELF,
          '<a:tblPr/>',
          tr(H(50), tc('a', '', ' gridSpan="2"'), tc('b', '', ' hMerge="1"'), tc('c')),
          tr(H(60), tc('d', '', ' rowSpan="2"'), tc('e'), tc('f')),
          tr(H(70), tc('g', '', ' vMerge="1"'), tc('h'), tc('i')),
        ),
      ),
    ),
  ],
  [
    'plain 3x3 for merging',
    slideXml(
      frame(
        tbl(
          SELF,
          '<a:tblPr/>',
          row(H(50), 'a', 'b', 'c', '<a:tcPr/>'),
          row(H(60), 'd', 'e $& f', 'g'),
          row(H(70), 'h', 'i', 'j'),
        ),
      ),
    ),
  ],
  [
    'a spanning cell to split',
    slideXml(
      frame(
        tbl(
          SELF,
          '<a:tblPr/>',
          tr(H(50), tc('a', '', ' gridSpan="2" rowSpan="2"'), tc('b', '', ' hMerge="1"'), tc('c')),
          tr(
            H(60),
            tc('d', '', ' vMerge="1" gridSpan="2"'),
            tc('e', '', ' hMerge="1" vMerge="1"'),
            tc('f'),
          ),
        ),
      ),
    ),
  ],
  ['a missing gridCol', slideXml(frame(tbl(SHORT, '<a:tblPr/>', ...PLAIN_ROWS)))],
  ['an unclosed paired gridCol', slideXml(frame(tbl(UNCLOSED, '<a:tblPr/>', ...PLAIN_ROWS)))],
  ['a gridCol without w', slideXml(frame(tbl(NOW, '<a:tblPr/>', ...PLAIN_ROWS)))],
  ['no gridCol at all', slideXml(frame(tbl('<a:tblGrid/>', '<a:tblPr/>', ...PLAIN_ROWS)))],
  [
    'right-to-left',
    slideXml(frame(tbl(SELF, '<a:tblPr rtl="1" firstRow="1"/>', ...PLAIN_ROWS))),
  ],
  [
    'cell edge cases',
    slideXml(
      frame(
        tbl(
          SELF,
          '<a:tblPr/>',
          tr(
            H(50),
            '<a:tc/>',
            '<a:tc><a:txBody><a:bodyPr wrap="none"></a:bodyPr><a:lstStyle><a:lvl1pPr/></a:lstStyle><a:p/></a:txBody></a:tc>',
            '<a:tc><a:txBody><a:p/></a:txBody><a:tcPr anchor="b" marL="1"/></a:tc>',
          ),
          tr(
            H(60),
            tc('x', '<a:tcPr anchor="ctr"><a:noFill/></a:tcPr>'),
            tc('y', '<a:tcPr/>'),
            tc('z', '<a:tcPr marL="5" anchor="t"/>'),
          ),
          '<a:tr h="5"></a:tr>',
        ),
      ),
    ),
  ],
  [
    'a table nested in a cell',
    slideXml(
      frame(
        tbl(
          SELF,
          '<a:tblPr/>',
          tr(
            H(50),
            `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tbl>${tr(H(5), tc('in'))}</a:tbl></a:tc>`,
            tc('o'),
            tc('p'),
          ),
        ),
      ),
    ),
  ],
  [
    'text outside a table first',
    slideXml(SHAPE, frame(tbl(SELF, '<a:tblPr/>', ...PLAIN_ROWS))), // the table is element 1
  ],
  ['unicode text', slideXml(frame(tbl(SELF, '<a:tblPr/>', row(H(50), '\u{1F600}\uD55C', '&amp;', 'x'))))],
  [
    'an empty tr',
    slideXml(frame(tbl(SELF, '<a:tblPr/>', ...PLAIN_ROWS, '<a:tr h="9"/>'))),
  ],
]

const PARAGRAPHS: unknown[][] = [
  [{ runs: [{ text: 'Hello' }] }],
  [{ runs: [{ text: 'a & b <c>' }] }, { runs: [{ text: '\u{1F600}' }] }],
  [],
  [{ runs: [{ text: '$&' }] }],
]

const built = (
  rest: (index: number) => Record<string, unknown>[],
  seedFalse?: (index: number) => boolean,
): Input[] => {
  const out: Input[] = []
  TABLES.forEach(([, text], index) => {
    const element = index === 14 ? 1 : 0
    rest(index).forEach((args) =>
      out.push({
        ...deckInput(BLANK, { slide: 0, element, ...args }, { part: PART, text }),
        ...(seedFalse?.(index) ? { seed: false as const } : {}),
      }),
    )
  })
  return out
}

const OPS_STRUCTURE = [
  { kind: 'insert-row', index: 0 },
  { kind: 'insert-row', index: 1, before: true },
  { kind: 'insert-row', index: 1, before: false },
  { kind: 'insert-row', index: 5 },
  { kind: 'insert-row', index: -1 },
  { kind: 'insert-row', index: 0.5 },
  { kind: 'delete-row', index: 0 },
  { kind: 'delete-row', index: 1 },
  { kind: 'delete-row', index: 9 },
  { kind: 'insert-col', index: 0 },
  { kind: 'insert-col', index: 1, before: true },
  { kind: 'insert-col', index: 2 },
  { kind: 'insert-col', index: 3 },
  { kind: 'delete-col', index: 0 },
  { kind: 'delete-col', index: 1 },
  { kind: 'delete-col', index: 2 },
]

const OPS_MERGE = [
  { kind: 'merge-right', row: 0, col: 0 },
  { kind: 'merge-right', row: 0, col: 1 },
  { kind: 'merge-right', row: 1, col: 2 },
  { kind: 'merge-right', row: 1, col: 0 },
  { kind: 'merge-right', row: 0, col: 9 },
  { kind: 'merge-right', row: 9, col: 0 },
  { kind: 'merge-down', row: 0, col: 0 },
  { kind: 'merge-down', row: 1, col: 1 },
  { kind: 'merge-down', row: 2, col: 0 },
  { kind: 'merge-down', row: 0.5, col: 0 },
  { kind: 'split', row: 0, col: 0 },
  { kind: 'split', row: 1, col: 0 },
  { kind: 'split', row: 0, col: 1 },
  { kind: 'split', row: 1, col: 1 },
]

/** Text with `$` in it merges into the anchor cell: the replacement string of the TypeScript expands it. */
// ledger tablemerge-dollar
const DOLLAR_TABLE = 5

const NASTY = [0, 1, 1.5, -1, 1e21, 1e308, 0.4, 2.5, 123456789012]

const blank = await JSZip.loadAsync(Buffer.from(deckNamed(BLANK), 'base64'))
const blankContentTypes = await blank.file('[Content_Types].xml')!.async('string')
const blankPresRels = await blank.file('ppt/_rels/presentation.xml.rels')!.async('string')
const STYLE_DEF = '<a:tblStyle styleId="{AAAAAAAA-0000-0000-0000-000000000001}" styleName="X"/>'
const STYLE_ID = '{AAAAAAAA-0000-0000-0000-000000000001}'
const TABLE_STYLES_OVERRIDE =
  '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'

const styleInput = (
  deck: string,
  part?: { part: string; text: string },
  styleDefXml = STYLE_DEF,
  styleId = STYLE_ID,
): Input =>
  deckInput(deck, { slide: 0, element: 0, styleId, styleDefXml }, part)

const STYLE_DECK = 'pptxgenjs text, shape, table and two slides'

export const DECKTABLES: CallSpec[] = [
  {
    fn: 'pptxDecktables.index.editTableCellText',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        editTableCellText(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.row as number,
          args.col as number,
          args.paragraphs as never,
        ),
      ),
    built: [
      ...built(
        (i) => {
          const rest: Record<string, unknown>[] = []
          for (const [row, col] of [
            [0, 0],
            [0, 1],
            [0, 2],
            [1, 2],
            [1, 0],
            [2, 0],
            [0, 3],
            [-1, 0],
            [0, 1.5],
          ]) {
            rest.push({ row, col, paragraphs: PARAGRAPHS[i % PARAGRAPHS.length] })
          }
          if (i === 0) for (const paragraphs of PARAGRAPHS) rest.push({ row: 1, col: 1, paragraphs })
          return rest
        },
      ),
      // text with `$` goes through the paragraph generator, not a replacement string
      ...built((i) => (i === 0 ? [{ row: 0, col: 0, paragraphs: PARAGRAPHS[3] }] : [])),
    ],
  },
  {
    fn: 'pptxDecktables.index.editTableStyle',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        editTableStyle(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.edit as never,
        ),
      ),
    built: built((i) =>
      i < 4 || i === 11 || i === 14
        ? [
            { edit: { firstRow: true } },
            { edit: { bandRow: false, rtl: true } },
            { edit: { styleId: '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}' } },
            { edit: { shadingColor: '#FF0000' } },
            { edit: { borderPreset: 'all', borderColor: '#00F', borderWidthEmu: 12700 } },
            { edit: { shadingColor: '#00FF00', cells: [{ row: 0, col: 1 }] } },
            { edit: { tblPrXml: '<a:tblPr firstRow="1" bandRow="1"/>', clearDirectFormatting: true } },
          ]
        : [{ edit: { firstRow: true } }],
    ),
  },
  {
    fn: 'pptxDecktables.index.ensureTableStylePart',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        ensureTableStylePart(opened, args.styleId as string, args.styleDefXml as string)
        return null
      }),
    built: [
      // no tableStyles.xml: the part, its override and its relationship are created
      styleInput(BLANK),
      // the part is there already (and the style is, or is not)
      styleInput(STYLE_DECK),
      styleInput(STYLE_DECK, undefined, '<a:tblStyle styleId="{BBBBBBBB-0000-0000-0000-000000000002}"/>', '{BBBBBBBB-0000-0000-0000-000000000002}'),
      // an empty part reads as missing
      styleInput(BLANK, { part: 'ppt/tableStyles.xml', text: '' }),
      // a part without a list: the empty list is the base
      styleInput(BLANK, { part: 'ppt/tableStyles.xml', text: '<x/>' }),
      // a self-closing list, and a style id already inside the list
      styleInput(BLANK, {
        part: 'ppt/tableStyles.xml',
        text: '<a:tblStyleLst xmlns:a="x" def="d"/>',
      }),
      styleInput(BLANK, {
        part: 'ppt/tableStyles.xml',
        text: `<a:tblStyleLst xmlns:a="x" def="d">${STYLE_DEF}</a:tblStyleLst>`,
      }),
      // the override and the relationship exist while the part does not
      styleInput(BLANK, {
        part: '[Content_Types].xml',
        text: blankContentTypes.replace('</Types>', `${TABLE_STYLES_OVERRIDE}</Types>`),
      }),
      styleInput(BLANK, {
        part: 'ppt/_rels/presentation.xml.rels',
        text: blankPresRels.replace(
          '</Relationships>',
          '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>',
        ),
      }),
      // no rId in the relationships, an empty relationships part, an empty content types part
      styleInput(BLANK, {
        part: 'ppt/_rels/presentation.xml.rels',
        text: blankPresRels.replace(/Id="rId(\d+)"/g, 'Id="x$1"'),
      }),
      styleInput(BLANK, { part: '[Content_Types].xml', text: '' }),
      // a dollar sign in the definition goes in as written
      styleInput(BLANK, undefined, '<a:tblStyle styleId="d$&"/>', 'd$&'),
    ].map((input) => ({ ...input })),
  },
  {
    fn: 'pptxDecktables.index.editTableStructure',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        editTableStructure(
          opened,
          args.slide as number,
          at.element(args.slide as number, args.element as number),
          args.op as never,
        ),
      ),
    built: built((i) =>
      i === 4 || i === 5 || i === 6 ? OPS_STRUCTURE.slice(0, 3).map((op) => ({ op })) : OPS_STRUCTURE.map((op) => ({ op })),
    ),
  },
  {
    fn: 'pptxDecktables.index.mergeTableCells',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        mergeTableCells(
          opened,
          args.slide as number,
          at.element(args.slide as number, args.element as number),
          args.op as never,
        ),
      ),
    built: built(
      (i) => OPS_MERGE.map((op) => ({ op })),
      // the `$&` of the text of cell (1, 1) expands in the TypeScript
      (i) => i === DOLLAR_TABLE,
    ),
  },
  {
    fn: 'pptxDecktables.index.setTableColWidth',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setTableColWidth(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.col as number,
          args.wEmu as number,
        ),
      ),
    built: built(() => [
      ...[0, 1, 2, 3, -1, 0.5].map((col) => ({ col, wEmu: 555 })),
      ...NASTY.map((wEmu) => ({ col: 1, wEmu })),
    ]),
  },
  {
    fn: 'pptxDecktables.index.setTableRowHeight',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setTableRowHeight(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.row as number,
          args.hEmu as number,
        ),
      ),
    built: built(() => [
      ...[0, 1, 2, 3, -1, 0.5].map((row) => ({ row, hEmu: 321 })),
      ...NASTY.map((hEmu) => ({ row: 0, hEmu })),
    ]),
  },
  {
    fn: 'pptxDecktables.index.resizeTable',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        resizeTable(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.cx as number,
          args.cy as number,
        ),
      ),
    built: built(() => [
      { cx: 1200, cy: 220 },
      { cx: 1, cy: 1 },
      { cx: 0, cy: -5 },
      { cx: 1000.5, cy: 77.7 },
      { cx: 1e15, cy: 1e15 },
      { cx: 601, cy: 111 },
    ]),
  },
  {
    fn: 'pptxDecktables.index.setTableCellAnchor',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setTableCellAnchor(
          at.slide(args.slide as number),
          at.element(args.slide as number, args.element as number),
          args.row as number,
          args.col as number,
          args.anchor as never,
        ),
      ),
    built: built(() => {
      const rest: Record<string, unknown>[] = []
      for (const anchor of ['top', 'middle', 'bottom'])
        for (const [row, col] of [
          [0, 0],
          [0, 1],
          [0, 2],
          [1, 0],
          [1, 2],
          [2, 0],
          [0, 3],
          [-1, 0],
        ])
          rest.push({ row, col, anchor })
      return rest
    }),
  },
]
