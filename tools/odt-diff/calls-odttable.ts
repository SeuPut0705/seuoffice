// Group `odtTable` of comparison (f): table/*.ts of packages/odt-engine (the
// functions whose arguments are plain data). The Rust side answers in
// crates/office-wasm/src/calls/odt_table.rs to `odtTable.<TypeScript name>`; the
// convention is at the top of calls-support.ts. Shapes particular to this group:
//
//   tcIndexes          args `cells`: the grid as `[[{ kind, anchor, colSpan, rowSpan }]]` (the nodes are not read).
//   elementRecord      text a string at least as long as the largest offset of `n` (the offsets are UTF-16 units of it);
//                      args `n` `{ start, end, openEnd, closeStart, selfClosing }`.
//   protectedCellsOf, isProtectedCell   args `map` = `{ ext }`; `cell`.
//   borderFromOdf, lengthCm   `args.missing` for `undefined`.
//   borderToOdf        args `b` (absent for `undefined`).
//   editedGrid         args `model` (a TableModel), `ox` (an OxTable, as segmentTable gives it).
//   editedItems        args `anchor` `{ cell, ox }`.//
//   odtTable.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { TableModel } from '../docx-diff/reference/index'
import { elementFragments } from '../docx-diff/fragments'
import type { CallSpec } from '../docx-diff/calls-spec'
import { distinct, constantSpec } from './calls-support'
import { REAL_TABLES } from './real-model'
import * as ts from './ts'

const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)
const fwd = ts.tableForward
const odf = ts.tableOdfRead
const ox = ts.tableOoxmlRead

function scan(text: string): ts.coreBody.OdtBody | null {
  try {
    return ts.coreBody.scanOdtBody(text)
  } catch {
    return null
  }
}

const nodesOf = (text: string, kind: ts.coreBody.OdtNodeKind): ts.coreBody.OdtNode[] => {
  const body = scan(text)
  return body ? ts.coreBody.nodesOfKind(body.blocks, kind) : []
}

const ELEMENT = { start: 10, end: 90, openEnd: 30, closeStart: 80, selfClosing: false }
const cellRecords = (): Array<Record<string, unknown>> => [
  { kind: 'cell', ...ELEMENT, tc: 0, style: null, units: [] },
  {
    kind: 'cell',
    ...ELEMENT,
    tc: 1,
    style: 'Table1.A1',
    units: [{ kind: 'p', paragraph: 0, start: 40, end: 70 }],
    colSpan: 3,
    rowSpan: 2,
  },
  { kind: 'cell', ...ELEMENT, tc: 2, style: null, units: [], colSpan: 0, rowSpan: 4 },
  {
    kind: 'cell',
    ...ELEMENT,
    tc: 0,
    style: null,
    units: [],
    rowSpan: 2,
    protected: true,
    synthetic: 'trailing',
  },
  { kind: 'covered', start: 10, end: 20, anchor: [2, 3], tc: null },
  { kind: 'covered', start: 10, end: 20, anchor: [0, 1], tc: 2 },
  { kind: 'orphan', start: 10, end: 20, tc: 1 },
  { kind: 'filler', start: -1, end: -1, tc: 3 },
]

const BORDERS = [
  '0.012cm solid #000000',
  'none',
  'hidden',
  '0cm solid #000000',
  '1pt double #FF0000',
  '2pt groove #abc',
  '0.5pt dotted',
  '#00ff00',
  'dashed',
  '1pt dash-dot #123456',
  '1pt dash-dot-dot',
  '3pt double-thin #aabbcc',
  'ridge inset outset',
  'fine-dashed 0.1cm',
  'wave 1pt #000',
  '  1pt   solid   #FFF  ',
  '1pt SOLID #000000',
  '100pt solid',
  '0.001cm solid',
  '1pt unknown-style',
  '',
  '1pt solid #12345',
  '1pt solid #1234567',
  '2mm solid red',
  '1in dotted',
  '\ud55c\uae00',
]

const CELL_PROPS: Array<Record<string, string>> = [
  {},
  { 'fo:background-color': '#ffcc00' },
  { 'fo:background-color': 'transparent', 'style:vertical-align': 'middle' },
  { 'style:vertical-align': 'bottom', 'style:vertical-align2': 'x' },
  { 'fo:border': '0.012cm solid #000000' },
  {
    'fo:border': '0.012cm solid #000000',
    'fo:border-top': 'none',
    'fo:border-left': '1pt double #ff0000',
  },
  {
    'fo:border-bottom': '2pt dashed #00f',
    'fo:border-right': '0.5pt dotted #0f0',
    'style:diagonal-tl-br': '1pt solid #000',
    'style:diagonal-bl-tr': 'none',
  },
  { 'style:diagonal-tl-br': '1pt dash-dot #000000', 'style:diagonal-bl-tr': '2pt solid #123456' },
  { 'fo:padding': '0.1cm', 'fo:padding-top': '0.2cm', 'fo:padding-left': '-1cm' },
  { 'fo:padding-right': '1pt', 'fo:padding-bottom': 'bad', 'fo:padding': '0.3cm' },
  { 'fo:background-color': '#abc', 'style:vertical-align': 'top' },
]

const border = (style: string, szEighths?: number, color?: string): Record<string, unknown> => ({
  style,
  ...(szEighths !== undefined ? { szEighths } : {}),
  ...(color !== undefined ? { color } : {}),
})

const BORDER_MODELS: Array<Record<string, unknown> | undefined> = [
  undefined,
  border('none'),
  border('nil'),
  border('single', 4, '000000'),
  border('double', 12, 'FF0000'),
  border('dotted'),
  border('dashed', 8, 'auto'),
  border('dotDash', 2, 'abcdef'),
  border('dotDotDash', 96, 'ABCDEF'),
  border('threeDEngrave', 4, 'xyz'),
  border('threeDEmboss'),
  border('inset'),
  border('outset', 6),
  border('dashSmallGap', 4, '12345'),
  border('wave', 4),
  border('unknown', 4, '00ff00'),
  border('single', 0),
  border('double', 1),
]

const ox0 = (xml: string): ts.tableOoxmlRead.OxTable => ts.tableOoxmlRead.segmentTable(xml)
const TABLE_XML = (rows: string): string =>
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1"/></w:tblGrid>${rows}</w:tbl>`
const TC = (inner: string, pr = ''): string =>
  `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${inner}</w:tc>`
const P = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

const OX_SAMPLES = [
  '',
  'no table here',
  TABLE_XML(
    `<w:tr>${TC(P('a'), '<w:tcW w:w="100" w:type="dxa"/>')}${TC(P('b') + P('c'))}</w:tr><w:tr>${TC(P('d'), '<w:gridSpan w:val="2"/>')}</w:tr>`,
  ),
  TABLE_XML(
    `<w:tr>${TC(P('a') + TABLE_XML(`<w:tr>${TC(P('inner'))}</w:tr>`) + P('after'))}</w:tr>`,
  ),
  TABLE_XML(
    `<w:sdt><w:sdtContent><w:tr>${TC(P('x'))}</w:tr></w:sdtContent></w:sdt><w:tr><w:sdt><w:sdtContent>${TC(P('y'))}</w:sdtContent></w:sdt></w:tr>`,
  ),
  TABLE_XML('<w:tr><w:tc/></w:tr><w:tr/>'),
  TABLE_XML(
    `<w:tr>${TC(`<w:sdt><w:sdtContent>${P('in sdt')}</w:sdtContent></w:sdt>` + P('\ud55c\uae00'))}</w:tr>`,
  ),
  `<w:tbl><w:tr><w:tc><w:p></w:tc></w:tr>`,
  P('lone paragraph') + TABLE_XML(`<w:tr>${TC(P('t'))}</w:tr>`),
]

const TCPRS = [
  '',
  '<w:tcPr/>',
  '<w:tcPr><w:tcW w:w="1" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/><w:shd w:fill="x"/></w:tcPr>',
  '<w:tcPr><w:vMerge/><w:tcBorders/></w:tcPr>',
  '<w:tcPr><w:tcW w:w="1"></w:tcW></w:tcPr>',
  '<w:tcPr><w:gridSpan w:val="3"/></w:tcPr>',
  '<w:tcPr><w:tcW w:w="9" w:type="pct"/><w:vAlign w:val="center"/></w:tcPr>',
]

const BOOKMARK_PARAS = [
  '<w:p><w:bookmarkStart w:id="1" w:name="_odtp3"/><w:r><w:t>a</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
  '<w:p><w:bookmarkStart w:id="1" w:name="keep"/><w:bookmarkStart w:id="2" w:name="_odtm3_1"/><w:bookmarkEnd w:id="2"/><w:bookmarkEnd w:id="1"/></w:p>',
  '<w:p><w:bookmarkStart w:name="_odtx"/><w:bookmarkEnd w:id="1"/></w:p>',
  '<w:p><w:bookmarkEnd w:id="7"/><w:bookmarkStart w:id="7" w:name="_odt"/></w:p>',
  '<w:p><w:bookmarkStart w:id="1" w:name="a"/><w:bookmarkEnd w:id="1"/></w:p>',
  '<w:p/>',
  '',
  '<w:bookmarkStart w:id="5" w:name="_odt\ud55c"/><w:bookmarkEnd w:id="5"/><w:bookmarkEnd w:id="5"/>',
]

const SEQUENCES: Array<[string[], string[]]> = [
  [[], []],
  [['a'], []],
  [[], ['a']],
  [
    ['a', 'b', 'c'],
    ['a', 'b', 'c'],
  ],
  [
    ['a', 'b', 'c'],
    ['a', 'c'],
  ],
  [
    ['a', 'b', 'c'],
    ['a', 'x', 'b', 'c'],
  ],
  [
    ['a', 'b'],
    ['b', 'a'],
  ],
  [['a', 'a', 'a'], ['a']],
  [['a'], ['a', 'a', 'a']],
  [
    ['a', 'b', 'c', 'd'],
    ['x', 'y'],
  ],
  [
    ['\ud55c', '\uae00'],
    ['\uae00', '\ud55c', '\ud83d\ude00'],
  ],
  [
    ['a', 'b', 'c'],
    ['c', 'b', 'a'],
  ],
  [
    ['', ''],
    ['', '', ''],
  ],
  [
    Array.from({ length: 30 }, (_, i) => `r${i}`),
    Array.from({ length: 33 }, (_, i) => `r${i % 11 === 5 ? 'x' + i : i}`),
  ],
]

function modelsOf(doc: {
  blocks: Array<{ type: string; table?: TableModel; originalXml?: string | null }>
}): Array<{ model: TableModel; xml: string }> {
  return doc.blocks
    .filter((b) => b.type === 'table' && b.table && b.originalXml)
    .slice(0, 4)
    .map((b) => ({ model: b.table!, xml: b.originalXml as string }))
}

export const TABLE: CallSpec[] = [
  {
    fn: 'odtTable.elementRecord',
    call: (_t, args) => fwd.elementRecord(args.n as never),
    built: [
      { start: 0, end: 10, openEnd: 3, closeStart: 8, selfClosing: false },
      { start: 5, end: 9, openEnd: 9, closeStart: 9, selfClosing: true },
      { start: 0, end: 0, openEnd: 0, closeStart: 0, selfClosing: false },
      { start: 2, end: 20, openEnd: 6, closeStart: 14, selfClosing: false },
    ].map((n) => ({ text: 'x'.repeat(20), args: { n } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.borderFromOdf',
    call: (text, args) => fwd.borderFromOdf(args.missing ? undefined : text),
    fromDocument: (parts) =>
      distinct(
        [...(part(parts, 'content.xml') ?? '').matchAll(/fo:border[\w-]*="([^"]*)"/g)].map((m) => ({
          text: m[1]!,
        })),
        40,
      ),
    built: [...BORDERS.map((text) => ({ text })), { text: '', args: { missing: true } }],
  },
  {
    fn: 'odtTable.cellPropsFromOdf',
    call: (_t, args) => fwd.cellPropsFromOdf(args.props as Record<string, string>),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      const table = ts.coreStyles.readOdtStyles(part(parts, 'styles.xml') ?? null, content)
      return distinct(
        table.all
          .map((s) => s.properties['style:table-cell-properties'])
          .filter((p): p is Record<string, string> => !!p)
          .map((props) => ({ args: { props } })),
        30,
      )
    },
    built: CELL_PROPS.map((props) => ({ args: { props } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.cellBordersXml',
    call: (_t, args) => fwd.cellBordersXml(args.borders as never),
    built: [
      {},
      { top: border('single', 4, '000000') },
      {
        top: border('none'),
        left: border('nil'),
        bottom: border('double', 12, 'FF0000'),
        right: border('dotted'),
      },
      { tl2br: border('single', 8, 'auto'), tr2bl: border('dashed') },
      { top: border('s&<"', 4, '"c&') },
      { right: border('single', 0, '') },
    ].map((borders) => ({ args: { borders } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.borderToOdf',
    call: (_t, args) => ts.tableReverse.borderToOdf(args.b as never),
    built: BORDER_MODELS.map((b) => ({ args: b === undefined ? {} : { b } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.mapSequence',
    call: (_t, args) =>
      ts.tableReverse.mapSequence(args.original as string[], args.edited as string[]),
    built: SEQUENCES.map(([original, edited]) => ({ args: { original, edited } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.tcIndexes',
    call: (_t, args) => odf.tcIndexes(args.cells as never),
    fromDocument: (parts) => {
      const content = part(parts, 'content.xml')
      if (content === undefined) return []
      return nodesOf(content, 'table')
        .slice(0, 20)
        .map((table) => ({
          args: {
            cells: odf.readGrid(table).cells.map((row) =>
              row.map((c) => ({
                kind: c.kind,
                anchor: c.anchor,
                colSpan: c.colSpan,
                rowSpan: c.rowSpan,
              })),
            ),
          },
        }))
    },
    built: [
      [[['cell', [0, 0], 1, 1]]],
      [
        [
          ['cell', [0, 0], 2, 1],
          ['covered', [0, 0], 1, 1],
        ],
        [
          ['cell', [1, 0], 1, 1],
          ['cell', [1, 1], 1, 1],
        ],
      ],
      [
        [
          ['cell', [0, 0], 1, 2],
          ['cell', [0, 1], 1, 1],
        ],
        [
          ['covered', [0, 0], 1, 1],
          ['filler', [1, 1], 1, 1],
        ],
      ],
      [],
      [[]],
      [
        [
          ['covered', [5, 5], 1, 1],
          ['cell', [0, 1], 1, 1],
        ],
      ],
    ].map((rows) => ({
      args: {
        cells: (rows as Array<Array<[string, number[], number, number]>>).map((row) =>
          row.map(([kind, anchor, colSpan, rowSpan]) => ({ kind, anchor, colSpan, rowSpan })),
        ),
      },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.lengthCm',
    call: (text, args) => odf.lengthCm(args.missing ? undefined : text),
    fromDocument: (parts) =>
      distinct(
        [...(part(parts, 'content.xml') ?? '').matchAll(/="(-?[\d.]+(?:cm|mm|in|pt))"/g)].map(
          (m) => ({ text: m[1]! }),
        ),
        40,
      ),
    built: [
      ...['0cm', '2.54cm', '1in', '72pt', '10mm', '-1cm', '1e1mm', 'x', '', '1 cm', '5%'].map(
        (text) => ({ text }),
      ),
      { text: '', args: { missing: true } },
    ],
  },
  {
    fn: 'odtTable.segmentTable',
    call: (text) => ox.segmentTable(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:tbl')
            .slice(0, 12)
            .map((text) => ({ text })),
        ),
    built: OX_SAMPLES.map((text) => ({ text })),
  },
  {
    fn: 'odtTable.normalizedTcPr',
    call: (text) => ox.normalizedTcPr(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          distinct(elementFragments(xml, 'w:tcPr'), 20).map((text) => ({ text })),
        ),
    built: TCPRS.map((text) => ({ text })),
  },
  {
    fn: 'odtTable.withoutBridgeBookmarks',
    call: (text) => ox.withoutBridgeBookmarks(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:p')
            .slice(0, 20)
            .map((text) => ({ text })),
        ),
    built: BOOKMARK_PARAS.map((text) => ({ text })),
  },
  {
    fn: 'odtTable.editedGrid',
    call: (_t, args) => ox.editedGrid(args.model as TableModel, args.ox as never),
    fromModel: (doc) =>
      modelsOf(doc).map(({ model: m, xml }) => ({ args: { model: m, ox: ox.segmentTable(xml) } })),
    built: REAL_TABLES.flatMap(({ model: m, xml }) => {
      const ox = ox0(xml)
      const copy = JSON.parse(JSON.stringify(m)) as TableModel
      const spanned = JSON.parse(JSON.stringify(m)) as TableModel
      if (spanned.rows[0]?.[0]) spanned.rows[0][0].colSpan = 2
      const merged = JSON.parse(JSON.stringify(m)) as TableModel
      if (merged.rows[1]?.[0]) merged.rows[1][0].vMerge = 'restart'
      if (merged.rows[2]?.[0]) merged.rows[2][0].vMerge = 'continue'
      const shorter = JSON.parse(JSON.stringify(m)) as TableModel
      shorter.rows = shorter.rows.map((row, i) => (i === 0 ? row.slice(0, -1) : row))
      return [m, copy, spanned, merged, shorter].map((model) => ({ args: { model, ox } }))
    }),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtTable.editedItems',
    call: (_t, args) => ox.editedItems(args.anchor as never),
    fromModel: (doc) =>
      modelsOf(doc).flatMap(({ model: m, xml }) => {
        const grid = ox.editedGrid(m, ox.segmentTable(xml))
        return grid.anchors
          .slice(0, 6)
          .map((a) => ({ args: { anchor: { cell: a.cell, ox: a.ox } } }))
      }),
    built: REAL_TABLES.flatMap(({ model: m, xml }) => {
      const grid = ox.editedGrid(m, ox.segmentTable(xml))
      return grid.anchors.slice(0, 4).flatMap((a) => [
        { cell: a.cell, ox: a.ox },
        { cell: a.cell, ox: null },
        { cell: { ...a.cell, nestedTables: [m, m], nestedTableAnchors: [0, 5] }, ox: null },
      ])
    }).map((anchor) => ({ args: { anchor } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.paraText',
    call: (_t, args) => ox.paraText(args.p as never),
    fromModel: (doc) =>
      distinct(
        doc.blocks
          .filter((b) => b.table)
          .slice(0, 4)
          .flatMap((b) => b.table!.rows.flat().flatMap((c) => c.richParas ?? []))
          .slice(0, 40)
          .map((p) => ({ args: { p } })),
        30,
      ),
    built: [
      {},
      { p: { runs: [] } },
      {
        p: {
          runs: [{ text: 'a' }, { text: '\ud55c\uae00' }, { text: '' }, { text: '\ud83d\ude00' }],
        },
      },
    ].map((i) => ({ args: i })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.protectedCellsOf',
    call: (_t, args) => ts.tableProtected.protectedCellsOf(args.map as never),
    built: [
      { ext: {} },
      { ext: { table: { protectedCells: [] } } },
      {
        ext: {
          table: {
            protectedCells: [
              { table: 1, path: [], row: 0, col: 1, tc: 1 },
              { table: 2, path: [{ row: 0, col: 0, index: 0 }], row: 1, col: 0, tc: 0 },
            ],
          },
        },
      },
      { ext: { table: {} } },
      { ext: { page: {} } },
    ].map((map) => ({ args: { map } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.isProtectedCell',
    call: (_t, args) => ts.tableProtected.isProtectedCell(args.map as never, args.cell as never),
    built: [
      { table: 1, row: 0, col: 1 },
      { table: 1, row: 0, tc: 1 },
      { table: 1, row: 0, col: 0 },
      { table: 2, path: [{ row: 0, col: 0, index: 0 }], row: 1, col: 0 },
      { table: 2, path: [{ row: 0, col: 0, index: 1 }], row: 1, tc: 0 },
      { table: 2, row: 1, tc: 0 },
      { table: 3, row: 0, col: 0 },
    ].map((cell) => ({
      args: {
        cell,
        map: {
          ext: {
            table: {
              protectedCells: [
                { table: 1, path: [], row: 0, col: 1, tc: 1 },
                { table: 2, path: [{ row: 0, col: 0, index: 0 }], row: 1, col: 0, tc: 0 },
              ],
            },
          },
        },
      },
    })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.anchorOf',
    call: (_t, args) =>
      ts.tableModel.anchorOf(args.cell as never, args.row as number, args.col as number),
    built: cellRecords().flatMap((cell) =>
      [
        [0, 0],
        [4, 5],
      ].map(([row, col]) => ({ args: { cell, row, col } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtTable.spanOf',
    call: (_t, args) => ts.tableModel.spanOf(args.cell as never),
    built: cellRecords().map((cell) => ({ args: { cell } })),
    mutation: 'none',
  },
  {
    fn: 'odtTable.asJson',
    call: (_t, args) => ts.tableModel.asJson(args.value),
    built: [1, 'a', null, [1, { a: [] }], { a: 1 }, true, '\ud55c\uae00'].map((value) => ({
      args: { value },
    })),
    mutation: 'none',
  },
  constantSpec('odtTable', {
    TABLE_OWNER: () => ts.tableModel.TABLE_OWNER,
    TABLE_EXT_VERSION: () => ts.tableModel.TABLE_EXT_VERSION,
    emptyTableExt: () => ts.tableModel.emptyTableExt(),
  }),
]
