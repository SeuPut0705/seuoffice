// Group `genTable`: generateTableModelXml and generateTableXml of generate.ts.
// The text of generateTableModelXml is the original table XML ('' for none).
// Corpus tables come as parsed TableModel values: CallSpec.fromDocument is
// synchronous and parseDocx is not, so `tableModelInputs` takes a parsed
// document and the runner calls it where it holds one.
import { generateTableModelXml, generateTableXml } from './reference/generate'
import type { CellBorder, TableCell, TableModel } from './reference/types'
import type { CallSpec, Input } from './calls-spec'

const PER_DOC = 12

/** Variants of a parsed table: as parsed, every pending change resolved both ways, a structural edit. */
function variantsOf(model: TableModel): TableModel[] {
  const resolve = (mode: 'accept' | 'reject' | null) => {
    const fix = <T extends { resolved?: 'accept' | 'reject' }>(c: T | null | undefined) =>
      c == null ? c : mode === null ? null : { ...c, resolved: mode }
    return {
      ...model,
      ...(model.tblPrChange !== undefined ? { tblPrChange: fix(model.tblPrChange) } : {}),
      ...(model.tblGridChange !== undefined ? { tblGridChange: fix(model.tblGridChange) } : {}),
      ...(model.rowPrChanges ? { rowPrChanges: model.rowPrChanges.map((c) => fix(c) ?? null) } : {}),
      rows: model.rows.map((row) =>
        row.map((cell) => ({
          ...cell,
          ...(cell.tcPrChange !== undefined ? { tcPrChange: fix(cell.tcPrChange) } : {}),
          ...(cell.cellMerge !== undefined ? { cellMerge: fix(cell.cellMerge) } : {}),
        })),
      ),
    } as TableModel
  }
  return [
    model,
    resolve('reject'),
    resolve(null),
    {
      ...model,
      autoFit: 'window',
      align: 'center',
      caption: 'Cap & "x"',
      description: '',
      tblStyleId: '',
      floatSide: model.floatPos ? null : 'right',
      cellMarTwips: { left: 108.5, right: -3 },
      repeatHeaderRows: model.rows.map((_, i) => i === 0),
      rowCantSplit: model.rows.map((_, i) => (i % 2 ? false : null)),
      rowHeightsTwips: model.rows.map((_, i) => (i % 3 === 0 ? 400.5 : i % 3 === 1 ? null : 0)),
      rowHeightRules: model.rows.map((_, i) => (i % 2 ? 'exact' : 'atLeast')),
      rows: model.rows.map((row) =>
        row.map((cell, c) => ({ ...cell, tcPrEdited: true, noWrap: c % 2 === 0, vAlign: 'bottom' as const })),
      ),
    },
  ]
}

/** The inputs a parsed document gives: every top-level table, with and without its original XML. */
export function tableModelInputs(doc: {
  blocks: ReadonlyArray<{ table?: TableModel; originalXml?: string | null }>
}): Input[] {
  return doc.blocks
    .filter((block) => block.table)
    .slice(0, PER_DOC)
    .flatMap((block) =>
      variantsOf(block.table!).flatMap((model) => [
        { text: block.originalXml ?? '', args: { model } },
        { text: '', args: { model } },
      ]),
    )
}

// ---------------------------------------------------------------- built models

const cell = (paras: string[], extra: Partial<TableCell> = {}): TableCell => ({ paras, ...extra })
const border = (style: string, extra: Partial<CellBorder> = {}): CellBorder => ({ style, ...extra })
const change = (extra: Record<string, unknown> = {}) => ({ author: 'A', date: '2024-01-01T00:00:00Z', id: '7', ...extra })

const RAW_TC_PR =
  '<w:tcPr><w:cnfStyle w:val="1"/><w:tcW w:w="1" w:type="dxa"/><w:tcBorders><w:top w:val="single"/></w:tcBorders>' +
  '<w:tcMar><w:left w:w="5" w:type="dxa"/></w:tcMar><w:hideMark/>' +
  '<w:tcPrChange w:id="3" w:author="B"><w:tcPr><w:shd w:fill="FF0000"/></w:tcPr></w:tcPrChange></w:tcPr>'

const NESTED: TableModel = {
  rows: [[cell(['inner a']), cell(['inner b'], { colSpan: 2 })], [cell([], { gridGap: true }), cell(['x'])]],
}

const MODELS: TableModel[] = [
  { rows: [[cell(['a']), cell(['b'])], [cell(['c']), cell(['d'])]] },
  { rows: [[cell([])]] },
  { rows: [] },
  {
    rows: [
      [
        cell(['head'], { bold: true, color: 'FF0000', align: 'center', fill: 'EEEEEE', vAlign: 'center' }),
        cell(['tab\there', 'line2'], { colSpan: 3.7, vMerge: 'restart', textDirection: 'btLr', tcPrEdited: true }),
      ],
      [
        cell([], { gridGap: true, colSpan: 2 }),
        cell(['merged'], { vMerge: 'continue', cellMerge: change({ vMerge: 'rest' }) }),
        cell([], { gridGap: true }),
      ],
    ],
    colWidthsPct: [10, 20, 30, 40],
    rowHeightsTwips: [500, null],
    rowHeightRules: ['exact', 'atLeast'],
    repeatHeaderRows: [true, false],
    rowCantSplit: [true, null],
    rawTrPrs: ['<w:trPr><w:cnfStyle w:val="1"/><w:gridBefore w:val="9"/><w:trHeight w:val="1"/></w:trPr>', '<w:trPr></w:trPr>'],
  },
  {
    rows: [
      [
        cell(['b'], {
          borders: { top: border('single', { szEighths: 12, color: 'A<B' }), left: border('nil'), tl2br: border('dashed') },
          tcPrEdited: true,
          cellMarTwips: { top: -5, left: 100.6 },
          noWrap: true,
          rawTcPr: RAW_TC_PR,
          tcPrChange: change({ resolved: 'reject' }),
        }),
        cell(['c'], { rawTcPr: RAW_TC_PR, tcPrChange: null }),
        cell(['d'], { rawTcPr: RAW_TC_PR }),
        cell(['e'], { rawTcPr: '<w:tcPr/>', colSpan: 1e9 }),
      ],
    ],
    borders: { top: border('none'), insideH: border('single', { szEighths: 4.5 }) },
    cellMarTwips: { top: 0 },
    colWidthsTwips: [1000.4, 0.2, Number.MAX_SAFE_INTEGER, 50],
    tableLook: { firstRow: false, lastRow: true, firstColumn: false, lastColumn: true, bandedRows: false, bandedColumns: true },
    tblStyleId: 'Grid & "1"',
    align: 'left',
    indentTwips: 120.5,
    floatPos: { xTwips: 5000, yTwips: -20.5, distanceTwips: { left: 100, bottom: -4 }, horzAnchor: 'margin' },
  },
  {
    rows: [
      [
        cell(['host'], {
          nestedTables: [NESTED, { rows: [[cell(['deep'], { nestedTables: [NESTED] })]] }],
          nestedTableAnchors: [0, 7],
          richParas: [
            { runs: [{ text: 'rich', italic: true }], align: 'right', bidi: true, list: { kind: 'bullet', numId: '4', ilvl: 1 } },
            { runs: [], spaceBefore: 120, indentLeft: 360 },
          ],
        }),
      ],
    ],
    autoLayout: true,
    floatSide: 'left',
    tblGridChange: change({ oldXml: '<w:gridCol w:w="5"/>' }),
    tblPrChange: change({ resolved: 'accept' }),
    rawTblPrExs: ['<w:tblPrEx><w:tblW w:w="1"/><w:tblPrExChange w:id="1" w:author="a"><w:tblPrEx/></w:tblPrExChange></w:tblPrEx>'],
    rowTblPrExChanges: [change({ resolved: 'reject' })],
    rowPrChanges: [null],
    rawTrPrs: ['<w:trPr><w:ins w:id="1" w:author="a"/><w:trPrChange w:id="2" w:author="a"><w:trPr><w:cantSplit/></w:trPr></w:trPrChange></w:trPr>'],
    caption: '',
    description: 'desc',
  },
  {
    rows: [[cell(['x'], { nestedTables: [NESTED], nestedTableAnchors: [-1] }), cell(['y'])]],
    floatSide: null,
    autoFit: 'contents',
    rawTrPrs: ['<w:trPr x="1"><w:divId w:val="1"/></w:trPr>'],
    rowHeightsTwips: [0],
  },
  {
    rows: [[cell([], { gridGap: true }), cell(['z'])], [cell([], { gridGap: true }), cell(['w'])]],
    rawTrPrs: ['<w:trPr><w:tblHeader/>', 'junk</w:trPr>'],
    autoFit: 'fixed',
  },
]

const ORIGINALS: string[] = [
  '',
  '<w:tbl><w:tblPr><w:tblStyle w:val="Old"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid/></w:tbl>',
  '<w:tbl><w:tblPr/><w:tblGrid/></w:tbl>',
  '<w:tbl><w:tblPr><w:jc w:val="center"/><w:tblpPr w:tblpX="1"/><w:tblPrChange w:id="1" w:author="a"><w:tblPr><w:tblW w:w="5"/></w:tblPr></w:tblPrChange></w:tblPr></w:tbl>',
  '<w:tbl>no props</w:tbl>',
]

/** Property changes whose recorded old properties are empty, rejected, accepted and resolved by null. */
const EMPTY_OLD_TBL =
  '<w:tbl><w:tblPr><w:jc w:val="center"/><w:tblPrChange w:id="1" w:author="a"><w:tblPr/></w:tblPrChange></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="100"/><w:tblGridChange w:id="2"><w:tblGrid/></w:tblGridChange></w:tblGrid></w:tbl>'
const EMPTY_OLD_TBL_PAIRED =
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblPrChange w:id="1" w:author="a"><w:tblPr></w:tblPr></w:tblPrChange></w:tblPr><w:tblGrid/></w:tbl>'
const VERDICTS = [change({ resolved: 'reject' }), change({ resolved: 'accept' }), null]
const EMPTY_OLD_INPUTS: Input[] = [
  ...VERDICTS.map((verdict) => ({
    text: EMPTY_OLD_TBL,
    args: { model: { rows: [[cell(['a'])]], tblPrChange: verdict, tblGridChange: change({ resolved: 'reject', oldXml: '' }) } },
  })),
  { text: EMPTY_OLD_TBL_PAIRED, args: { model: { rows: [[cell(['a'])]], tblPrChange: VERDICTS[0] } } },
  ...VERDICTS.map((verdict) => ({
    text: '',
    args: {
      model: {
        rows: [[cell(['r'])]],
        rawTrPrs: ['<w:trPr><w:cantSplit/><w:trPrChange w:id="3" w:author="a"><w:trPr/></w:trPrChange></w:trPr>'],
        rowPrChanges: [verdict],
        rawTblPrExs: ['<w:tblPrEx><w:tblW w:w="1"/><w:tblPrExChange w:id="5" w:author="a"><w:tblPrEx/></w:tblPrExChange></w:tblPrEx>'],
        rowTblPrExChanges: [verdict],
      },
    },
  })),
  ...VERDICTS.map((verdict) => ({
    text: '',
    args: {
      model: {
        rows: [
          [
            cell(['c'], {
              rawTcPr: '<w:tcPr><w:shd w:val="clear" w:fill="FF0000"/><w:tcPrChange w:id="4" w:author="a"><w:tcPr/></w:tcPrChange></w:tcPr>',
              tcPrChange: verdict,
            }),
          ],
        ],
      },
    },
  })),
]

// ---------------------------------------------------------------- the specs

export const GEN_TABLE: CallSpec[] = [
  {
    fn: 'genTable.generateTableModelXml',
    argMutation: true,
    call: (text, args) => generateTableModelXml(args.model as TableModel, text || undefined),
    fromModel: tableModelInputs,
    built: [
      ...MODELS.flatMap((model) => ORIGINALS.map((text) => ({ text, args: { model } }))),
      ...MODELS.flatMap((model) => variantsOf(model).map((model) => ({ text: ORIGINALS[3]!, args: { model } }))),
      ...EMPTY_OLD_INPUTS,
    ],
  },
  {
    fn: 'genTable.generateTableXml',
    argMutation: true,
    call: (_text, args) => generateTableXml(args.rows as number, args.cols as number, args.opts as never),
    built: [
      [1, 1],
      [3, 4],
      [0, -2],
      [60, 25],
      [2.5, 3.5],
      [7, 3],
    ].flatMap(([rows, cols]) =>
      [undefined, { headerRow: true }, { headerRow: false }].map((opts) => ({
        args: opts ? { rows, cols, opts } : { rows, cols },
      })),
    ),
    mutation: 'none',
  },
]
