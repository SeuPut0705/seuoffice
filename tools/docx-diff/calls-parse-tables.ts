// parse.ts: tables and headers and footers (crates/docx-engine/src/parse/tables.rs).
// A node argument crosses as its XML text, which both sides read with the
// table parser (deepXmlParser); a model value crosses as JSON, where NaN is
// null and an undefined array element is null, and the call maps them back.
// A function that changes its arguments is called on a copy, and what it
// changed is compared beside what it returned.
import type { CallSpec, Input } from './calls-spec'
import { parseInternals } from './parse-internals'
import { deepXmlParser, nameOf, serializeXNode, type XNode } from '../../packages/docx-engine/src/xml-utils'

const internals = await parseInternals()
/** The module-level WeakMaps bindHfImageAnchors reads, exported by the copy. */
const weakMaps = internals as unknown as Record<string, WeakMap<object, unknown>>

/** The first element of `text`, as the Rust side picks it. */
const nodeOf = (text: string): XNode | undefined =>
  (deepXmlParser.parse(text) as XNode[]).find((node) => nameOf(node) !== undefined)
const elementOf = (text: string): XNode => nodeOf(text) ?? {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const nodeInput = (node: unknown): Input | undefined =>
  isObject(node) ? { text: serializeXNode(node) } : undefined
/** The value as JSON has it, taken at the call: the parser goes on to change what it passed. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** JSON writes NaN as null. */
const num = (value: unknown): unknown => (value === null ? NaN : value)

const P = (inner: string): string => `<w:p><w:r><w:t>${inner}</w:t></w:r></w:p>`
const tc = (inner = P('x'), tcPr = ''): string => `<w:tc>${tcPr}${inner}</w:tc>`
const tr = (cells: string, trPr = ''): string => `<w:tr>${trPr}${cells}</w:tr>`
const tbl = (rows: string, tblPr = ''): string => `<w:tbl>${tblPr}${rows}</w:tbl>`
/** The parser refuses it on both sides. */
const REFUSED = '<w:tbl><__proto__/></w:tbl>'

const cell = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ paras: [], ...extra })

const sect = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  pageWidth: 12240,
  pageHeight: 15840,
  orientation: 'portrait',
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  pageBorder: false,
  columns: 1,
  ...extra,
})

const LOOK_ALL = { firstRowOn: true, lastRowOn: true, firstColOn: true, lastColOn: true, hBandOn: true }
const LOOK_DEFAULT = { firstRowOn: true, lastRowOn: false, firstColOn: true, lastColOn: false, hBandOn: true }

const anchorDrawing = (inner: string): string =>
  `<w:drawing><wp:anchor><wp:docPr id="1"/><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></wp:anchor></w:drawing>`
const PIC = '<pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic>'

const image = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  dataUrl: 'data:image/png;base64,AA==',
  widthPx: 10,
  heightPx: 10,
  ...extra,
})

const hfPart = (tblPr: string, rows: string): string => `<w:hdr>${tbl(rows, tblPr)}</w:hdr>`
const GRID = '<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/><w:gridCol w:w="450"/></w:tblGrid>'

export const PARSE_TABLES: CallSpec[] = [
  {
    fn: 'parse.tableSummary',
    call: (text) => internals.tableSummary!(text),
    fromParse: { fn: 'tableSummary', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: [
      tbl(tr(tc(P('a')) + tc(P('b'))) + tr(tc())),
      tbl(tr(tc(tbl(tr(tc(P('in')) + tc() + tc()))) + tc(P('out')))),
      '',
      '<w:tbl/>',
      '<w:tbl><w:tr><w:trPr/><w:tc>',
      `<w:tbl><w:tr\u3000a="1"><w:tc\u00a0b="2">${P('&amp;x&lt;')}</w:tc></w:tr></w:tbl>`,
      tbl(tr(tc(P('y'.repeat(150))))),
      tbl(tr(tc(P('a')) + tc(P('b'))) + tr(tc(P('c')))),
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.tableLacksTcW',
    call: (text) => internals.tableLacksTcW!(elementOf(text)),
    fromParse: { fn: 'tableLacksTcW', input: ([node]) => nodeInput(node) },
    built: [
      tbl(tr(tc(P('a'), '<w:tcPr><w:tcW w:w="100"/></w:tcPr>'))),
      tbl(tr(tc(P('a'), '<w:tcPr><w:vAlign w:val="top"/></w:tcPr>'))),
      tbl(`<w:sdt><w:sdtContent>${tr(`<w:sdt><w:sdtContent>${tc(P('a'), '<w:tcPr><w:tcW/></w:tcPr>')}</w:sdtContent></w:sdt>`)}</w:sdtContent></w:sdt>`),
      tbl(`<w:sdt>${tr(tc(P('a'), '<w:tcPr><w:tcW/></w:tcPr>'))}</w:sdt>`),
      tbl(tr(tc(tbl(tr(tc(P('a'), '<w:tcPr><w:tcW/></w:tcPr>')))))),
      tbl(tr(tc(P('a'), '<w:tcW w:w="1"/>'))),
      '',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.rowGridEdges',
    call: (text) => internals.rowGridEdges!(elementOf(text)),
    fromParse: { fn: 'rowGridEdges', input: ([node]) => nodeInput(node) },
    built: [
      tr(tc()),
      tr(tc(), '<w:trPr/>'),
      tr(tc(), '<w:trPr><w:gridBefore w:val="2"/><w:gridAfter w:val="1.7"/><w:wBefore w:w="300" w:type="dxa"/><w:wAfter w:w="20" w:type="pct"/></w:trPr>'),
      tr(tc(), '<w:trPr><w:gridBefore w:val="-1"/><w:gridAfter w:val="abc"/><w:wBefore w:w="0"/><w:wAfter w:w=" 12 " w:type=""/></w:trPr>'),
      tr(tc(), '<w:trPr><w:gridBefore w:val="0x10"/><w:gridAfter w:val="1e2"/><w:wBefore w:w="1e3"/><w:wAfter/></w:trPr>'),
      tr(tc(), '<w:trPr><w:gridBefore/><w:gridAfter w:val=""/><w:wBefore w:type="dxa"/><w:wAfter w:w="-5"/></w:trPr>'),
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.reconcileGridColumns',
    call: (_text, args) => {
      const rows = structuredClone(args.rows)
      const rowTcws = Array.isArray(args.rowTcws)
        ? args.rowTcws.map((row: unknown) => (Array.isArray(row) ? row.map((w) => w ?? undefined) : row))
        : args.rowTcws
      const gridCols = Array.isArray(args.gridCols) ? args.gridCols.map(num) : args.gridCols
      const result = internals.reconcileGridColumns!(rows, rowTcws, gridCols)
      return { result, rows }
    },
    fromParse: {
      fn: 'reconcileGridColumns',
      input: ([rows, rowTcws, gridCols]) => ({
        args: json({ rows, rowTcws, ...(gridCols !== undefined ? { gridCols } : {}) }),
      }),
    },
    built: [
      { rows: [[cell(), cell()], [cell({ colSpan: 2 })]], rowTcws: [[100, 100], [200]], gridCols: [100, 100] },
      { rows: [[cell(), cell(), cell()], [cell(), cell()]], rowTcws: [[1000, 1000, 1000], [1500, 1500]], gridCols: [1000, 1000, 1000] },
      { rows: [[cell(), cell(), cell()], [cell(), cell()]], rowTcws: [[1000, 1000, 1000], [1500, 1500]] },
      { rows: [[cell(), cell()], [cell()]], rowTcws: [[null, 400], [null]], gridCols: [300, 400] },
      { rows: [[cell(), cell()], [cell()]], rowTcws: [[null, 400], [null]] },
      { rows: [[cell(), cell(), cell()], [cell({ colSpan: 2 })]], rowTcws: [[1000, 1015, 990], [2000]], gridCols: [1000, 1000, 1000] },
      // boundaries exactly GRID_SNAP_TOL apart fuse
      { rows: [[cell(), cell()], [cell(), cell()]], rowTcws: [[1000, 1000], [1020, 980]], gridCols: [1000, 1000, 1000] },
      { rows: [[cell(), cell(), cell()], [cell()]], rowTcws: [[1000, 10, 2000], [3010]], gridCols: [1000, 1000, 1000] },
      { rows: [[cell({ colSpan: 3 })], [cell(), cell()]], rowTcws: [[3000], [1000, 2000]], gridCols: [1000, 1000, 1000] },
      { rows: [[cell({ colSpan: 1.5 }), cell()], [cell()]], rowTcws: [[null, 500], [null]], gridCols: [200, 300, 400] },
      { rows: [[cell({ colSpan: -1 }), cell()], [cell()]], rowTcws: [[null, 500], [null]], gridCols: [200, 300, 400] },
      { rows: [[cell(), cell()], [cell()], []], rowTcws: [[100, 200], [300]], gridCols: [100, 100, 100] },
      { rows: [[cell(), cell()], [cell()]], rowTcws: [[100, 200]], gridCols: [100, 100, 100] },
      { rows: [Array.from({ length: 98 }, () => cell()), [cell()]], rowTcws: [Array.from({ length: 98 }, () => 100), [9800]] },
      { rows: [[cell(), cell()], [cell({ colSpan: 2, fill: 'FF0000' }), cell()]], rowTcws: [[500, 600], [700, 400]], gridCols: [500, 600] },
      { rows: [[cell(), cell()], [cell()]], rowTcws: [[100, 200], [300]], gridCols: [] },
      { rows: [], rowTcws: [], gridCols: [100] },
      { rows: [[cell(), cell()], [cell()]], rowTcws: [[100, 200], [300]], gridCols: [null, 100] },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.flattenedTableModel',
    call: (text) => internals.flattenedTableModel!(elementOf(text)),
    fromParse: { fn: 'flattenedTableModel', input: ([node]) => nodeInput(node) },
    built: [
      tbl(tr(tc(P('a') + '<w:p/>' + P('b')) + tc(tbl(tr(tc(P('deep'))))))),
      tbl(tr(tc('<w:p><w:r><w:t>out</w:t></w:r><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>in</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>'))),
      tbl(tr(tc('loose<w:x>text</w:x>'))),
      '<w:p>one<w:r>two</w:r></w:p>',
      '<w:p/>',
      `<w:tbl>${'<w:tr><w:tc>'.repeat(300)}${P('x')}${'</w:tc></w:tr>'.repeat(300)}</w:tbl>`,
      '',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.usableTableWidths',
    call: (_text, args) =>
      internals.usableTableWidths!(
        args.sect,
        num(args.tblIndTwips),
        args.hangTwips === undefined ? undefined : num(args.hangTwips),
      ),
    fromParse: {
      fn: 'usableTableWidths',
      input: ([sect, tblIndTwips, hangTwips]) => ({
        args: json({ sect, tblIndTwips, ...(hangTwips !== undefined ? { hangTwips } : {}) }),
      }),
    },
    built: [
      { sect: sect(), tblIndTwips: 0 },
      { sect: sect(), tblIndTwips: null },
      { sect: sect(), tblIndTwips: 360, hangTwips: 216 },
      { sect: sect(), tblIndTwips: -200, hangTwips: 0 },
      { sect: sect({ columns: 2 }), tblIndTwips: 100 },
      { sect: sect({ columns: 2, colSpace: 0 }), tblIndTwips: 0, hangTwips: 100 },
      { sect: sect({ columns: 3, colWidths: [2000, 3000, 2000] }), tblIndTwips: 50 },
      { sect: sect({ columns: 3, colWidths: [2000, 3000] }), tblIndTwips: 50 },
      { sect: sect({ marginLeft: 6000, marginRight: 6240 }), tblIndTwips: 10, hangTwips: 5 },
      { sect: sect({ columns: 2, colWidths: [4680, 4680] }), tblIndTwips: 0, hangTwips: null },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.isUniformGrid',
    call: (_text, args) => internals.isUniformGrid!(Array.isArray(args.widths) ? args.widths.map(num) : args.widths),
    fromParse: {
      fn: 'isUniformGrid',
      input: ([widths]) => ({ args: widths === undefined ? {} : json({ widths }) }),
    },
    built: [
      {},
      { widths: [] },
      { widths: [100, 100, 100] },
      { widths: [1000, 1005] },
      { widths: [100, 200] },
      { widths: [1, 1, 4] },
      { widths: [1, 1, 5] },
      { widths: [null, 100] },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.rowRevisionOf',
    call: (text) => internals.rowRevisionOf!(elementOf(text)),
    fromParse: { fn: 'rowRevisionOf', input: ([node]) => nodeInput(node) },
    built: [
      '<w:trPr><w:ins w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:trPr>',
      '<w:trPr><w:del w:author="B" w16du:dateUtc="2024-02-02T00:00:00Z" w:id=""/></w:trPr>',
      '<w:trPr><w:del w:author="B"/><w:ins w:author="C"/></w:trPr>',
      '<w:trPr><w:ins/></w:trPr>',
      '<w:trPr><w:ins w:date=""/></w:trPr>',
      '<w:trPr><w:cantSplit/></w:trPr>',
      '',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.tblLookFlags',
    call: (text) => internals.tblLookFlags!(nodeOf(text)),
    // undefined is no element at all
    fromParse: { fn: 'tblLookFlags', input: ([node]) => (node === undefined ? { text: '' } : nodeInput(node)) },
    built: [
      '',
      '<w:tblPr/>',
      '<w:tblPr><w:tblLook w:val="04A0"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:val="0000"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:val="0x0360"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:val="zz"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:val="ffffffffff20"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="false" w:lastColumn="true" w:noHBand="1"/></w:tblPr>',
      '<w:tblPr><w:tblLook w:val="04A0" w:firstRow="0" w:noHBand="off"/></w:tblPr>',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.cellConds',
    call: (_text, args) =>
      internals.cellConds!(args.look, num(args.r), num(args.rowCount), num(args.col), num(args.span), num(args.totalCols)),
    fromParse: {
      fn: 'cellConds',
      input: ([look, r, rowCount, col, span, totalCols]) => ({ args: json({ look, r, rowCount, col, span, totalCols }) }),
    },
    built: [
      { look: LOOK_ALL, r: 0, rowCount: 1, col: 0, span: 1, totalCols: 1 },
      { look: LOOK_ALL, r: 2, rowCount: 3, col: 1, span: 2, totalCols: 3 },
      { look: LOOK_DEFAULT, r: 2, rowCount: 3, col: 1, span: 2, totalCols: 3 },
      { look: LOOK_DEFAULT, r: 0, rowCount: 3, col: 0, span: 1, totalCols: 3 },
      { look: { ...LOOK_ALL, firstRowOn: false, firstColOn: false }, r: 0, rowCount: 1, col: 0, span: 1, totalCols: 1 },
      { look: LOOK_ALL, r: 1, rowCount: 3, col: 1, span: 1, totalCols: 3 },
      { look: LOOK_ALL, r: 0, rowCount: 0, col: 0.5, span: 0.5, totalCols: 1 },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hfMovablePictureFrag',
    call: (text) => internals.hfMovablePictureFrag!(text),
    fromParse: { fn: 'hfMovablePictureFrag', input: ([frag]) => (typeof frag === 'string' ? { text: frag } : undefined) },
    built: [
      anchorDrawing(PIC),
      anchorDrawing(PIC + PIC),
      anchorDrawing('<pic:pic/>'),
      anchorDrawing(`<wps:wsp>${PIC}</wps:wsp>`),
      anchorDrawing(`<w:txbxContent>${PIC}</w:txbxContent>`),
      anchorDrawing(`<w:txbxContentX/>${PIC}`),
      `<w:drawing><wp:inline>${PIC}</wp:inline></w:drawing>`,
      anchorDrawing('<pic:pic\u2003><a:blip\t/></pic:pic>'),
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.anchorDocPrIds',
    call: (text) => internals.anchorDocPrIds!(elementOf(text)),
    fromParse: { fn: 'anchorDocPrIds', input: ([node]) => nodeInput(node) },
    built: [
      tr(tc(`<w:p><w:r>${anchorDrawing(PIC)}</w:r><w:r><w:drawing><wp:anchor><wp:docPr id="7"/><wp:anchor><wp:docPr id=""/></wp:anchor></wp:anchor></w:drawing></w:r></w:p>`)),
      tr(tc('<w:p><w:r><w:drawing><wp:anchor><wp:docPr name="x"/></wp:anchor><wp:inline><wp:docPr id="9"/></wp:inline></w:drawing></w:r></w:p>')),
      '<wp:anchor><wp:docPr id="5"/></wp:anchor>',
      '',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.hasDeepChildOutside',
    call: (text, args) =>
      internals.hasDeepChildOutside!(
        elementOf(text),
        new Set(args.names as string[]),
        args.skip === undefined ? undefined : new Set(args.skip as string[]),
      ),
    fromParse: {
      fn: 'hasDeepChildOutside',
      input: ([node, names, skip]) => {
        const input = nodeInput(node)
        if (!input || !(names instanceof Set) || !(skip === undefined || skip instanceof Set)) return undefined
        return { ...input, args: { names: [...names], ...(skip ? { skip: [...skip] } : {}) } }
      },
    },
    built: [
      { text: '<w:p><w:r><w:pict><w:txbxContent><wp:inline/></w:txbxContent></w:pict></w:r></w:p>', args: { names: ['wp:inline'], skip: ['w:txbxContent'] } },
      { text: '<w:p><w:r><w:pict><w:txbxContent><wp:inline/></w:txbxContent></w:pict></w:r></w:p>', args: { names: ['wp:inline'] } },
      { text: '<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>', args: { names: ['wp:inline'], skip: ['w:txbxContent'] } },
      { text: '<w:p><w:txbxContent/></w:p>', args: { names: ['w:txbxContent'], skip: ['w:txbxContent'] } },
      { text: '<w:p>text</w:p>', args: { names: ['w:r'] } },
      { text: '<wp:inline/>', args: { names: ['wp:inline'] } },
      { text: REFUSED, args: { names: ['w:tr'] } },
    ],
  },
  {
    fn: 'parse.hfPartInfo',
    call: (_text, args) => internals.hfPartInfo!(args.part ?? null),
    fromParse: {
      fn: 'hfPartInfo',
      input: ([part]) => {
        if (part === null) return { args: { part: null } }
        if (!isObject(part)) return undefined
        const { text, hasPageNumber, paras, images } = part
        return { args: json({ part: { text, hasPageNumber, paras, ...(images !== undefined ? { images } : {}) } }) }
      },
    },
    built: [
      { part: null },
      { part: { text: 'Page 1', hasPageNumber: true, paras: [{ runs: [{ text: 'Page 1' }] }] } },
      { part: { text: '', hasPageNumber: false, paras: [], images: [] } },
      { part: { text: 'logo', hasPageNumber: false, paras: [{ runs: [] }], images: [image({ floating: true })] } },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.bindHfImageAnchors',
    call: (_text, args) => {
      const images = structuredClone(args.images) as object[]
      const ids = args.imageAnchorIds as unknown[]
      images.forEach((image, i) => {
        if (typeof ids[i] === 'string') weakMaps.hfImageAnchorId!.set(image, ids[i])
      })
      const paras = (args.rowAnchorIds as unknown[]).map((rowIds) => {
        const para = {}
        if (Array.isArray(rowIds)) weakMaps.hfRowAnchorIds!.set(para, rowIds)
        return para
      })
      return internals.bindHfImageAnchors!(images, paras)
    },
    fromParse: {
      fn: 'bindHfImageAnchors',
      input: ([images, paras]) =>
        Array.isArray(images) && Array.isArray(paras)
          ? {
              args: json({
                images,
                imageAnchorIds: images.map((image: object) => weakMaps.hfImageAnchorId!.get(image) ?? null),
                rowAnchorIds: paras.map((para: object) => weakMaps.hfRowAnchorIds!.get(para) ?? null),
              }),
            }
          : undefined,
    },
    built: [
      { images: [], imageAnchorIds: [], rowAnchorIds: [] },
      { images: [image(), image({ anchorPara: 0 })], imageAnchorIds: ['5', '6'], rowAnchorIds: [null, ['4', '6'], ['5']] },
      { images: [image(), image()], imageAnchorIds: ['', null], rowAnchorIds: [[''], ['x']] },
      { images: [image({ drawing: 1 }), image()], imageAnchorIds: ['9'], rowAnchorIds: [['8'], ['9'], ['9']] },
      { images: [image()], imageAnchorIds: ['1'], rowAnchorIds: [['2']] },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.stripHfDeletions',
    call: (text) => internals.stripHfDeletions!(text),
    fromParse: { fn: 'stripHfDeletions', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: [
      '<w:p><w:del w:id="1" w:author="a"><w:r><w:drawing/></w:r></w:del><w:del w:id="2"><w:r><w:delText>x</w:delText></w:r></w:del></w:p>',
      '<w:p><w:moveFrom w:id="1"><w:r><w:pict>v</w:pict></w:r></w:moveFrom><w:moveFromRangeStart/></w:p>',
      '<w:p><w:del w:id="1" a="x/y"><w:r><w:object/></w:r></w:del></w:p>',
      '<w:p><w:del/><w:r><w:drawing/></w:r></w:p>',
      '<w:p><w:del w:id="1"><w:r><w:drawingX/></w:r></w:del></w:p>',
      '<w:p><w:del w:id="1"><w:del w:id="2"><w:drawing/></w:del></w:del></w:p>',
      '<w:p><w:delText>no</w:delText></w:p>',
      '<w:p><w:del\u3000w:id="1"><w:r><w:drawing\n/></w:r></w:del></w:p>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.hfTblRanges',
    call: (text) => internals.hfTblRanges!(text),
    fromParse: { fn: 'hfTblRanges', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: [
      `<w:hdr>${tbl(tr(tc()))}<w:p/>${tbl(tr(tc(tbl(tr(tc())))))}</w:hdr>`,
      `<w:hdr>\u{1F600}${tbl(tr(tc(P('\u{1F600}'))))}</w:hdr>`,
      '<w:hdr></w:tbl><w:tbl><w:tbl></w:tbl></w:hdr>',
      '<w:hdr><w:tblPr/><w:tblGrid/></w:hdr>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.hfCellColumnLeftPx',
    call: (text, args) => internals.hfCellColumnLeftPx!(text, num(args.at)),
    fromParse: {
      fn: 'hfCellColumnLeftPx',
      input: ([xml, at]) => (typeof xml === 'string' && typeof at === 'number' ? { text: xml, args: { at } } : undefined),
    },
    built: (() => {
      const rows = tr(tc(P('a')) + tc(P('b'), '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>')) + tr(tc(P('c'), '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>') + tc(`${tbl(tr(tc() + tc()))}<w:p><w:r><w:drawing/></w:r></w:p>`))
      const part = hfPart(`<w:tblPr><w:tblInd w:w="-120" w:type="dxa"/></w:tblPr>${GRID}`, rows)
      const plain = hfPart(GRID, tr(tc(P('a')) + tc('\u{1F600}<w:p><w:r><w:drawing/></w:r></w:p>')))
      // a row starts at a UTF-16 offset below `at` whose byte offset is above it
      const korean = hfPart(GRID, tr(tc(P('가'.repeat(200)))) + tr(tc(P('a'), '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>') + tc('<w:p><w:r><w:drawing/></w:r></w:p>')))
      const drawingAt = (xml: string): number => xml.indexOf('<w:drawing')
      return [
        { text: part, args: { at: drawingAt(part) } },
        { text: part, args: { at: part.indexOf('<w:t>b') } },
        { text: part, args: { at: part.indexOf('<w:t>a') } },
        { text: part, args: { at: part.indexOf('<w:tc>', part.indexOf('<w:tc>') + 1) } },
        { text: part, args: { at: 3 } },
        { text: part, args: { at: part.length + 10 } },
        { text: part, args: { at: null } },
        { text: plain, args: { at: drawingAt(plain) } },
        { text: plain, args: { at: plain.indexOf('\u{1F600}') + 1 } },
        { text: korean, args: { at: drawingAt(korean) } },
        { text: hfPart('<w:tblPr><w:tblInd w:w="-0"/></w:tblPr>', tr(tc() + tc(P('z')))), args: { at: 200 } },
        { text: `<w:hdr>${tbl(tr(tc() + tc() + tc()))}</w:hdr>`, args: { at: 40 } },
        { text: '', args: { at: 0 } },
      ]
    })(),
  },
  {
    fn: 'parse.hfOnlyEmptyRuns',
    call: (text) => internals.hfOnlyEmptyRuns!(elementOf(text)),
    fromParse: { fn: 'hfOnlyEmptyRuns', input: ([node]) => nodeInput(node) },
    built: [
      '<w:p><w:pPr/><w:r><w:rPr/></w:r><w:r/></w:p>',
      '<w:p><w:r><w:t/></w:r></w:p>',
      '<w:p><w:bookmarkStart/></w:p>',
      '<w:p>text</w:p>',
      '<w:p/>',
      '<w:p><w:r>x</w:r></w:p>',
      '',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.hfLine',
    call: (_text, args) => internals.hfLine!(args.b ?? undefined),
    fromParse: { fn: 'hfLine', input: ([b]) => ({ args: b === undefined ? {} : json({ b }) }) },
    built: [
      {},
      { b: { style: 'single', szEighths: 4, color: '000000' } },
      { b: { style: 'none' } },
      { b: { style: 'nil' } },
      { b: { style: '' } },
      { b: { style: 'double', color: 'auto' } },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hfTableFloatOf',
    call: (text) => internals.hfTableFloatOf!(nodeOf(text)),
    fromParse: { fn: 'hfTableFloatOf', input: ([node]) => (node === undefined ? { text: '' } : nodeInput(node)) },
    built: [
      '',
      '<w:tblPr/>',
      '<w:tblPr><w:tblpPr w:tblpX="100" w:tblpY="-20" w:horzAnchor="page" w:vertAnchor="text" w:tblpXSpec="center"/></w:tblPr>',
      '<w:tblPr><w:tblpPr w:tblpX="" w:tblpY="1e3" w:horzAnchor="margin" w:vertAnchor="margin" w:tblpXSpec="outside"/></w:tblPr>',
      '<w:tblPr><w:tblpPr w:tblpX="abc" w:horzAnchor="Page" w:vertAnchor="page" w:tblpXSpec="inside"/></w:tblPr>',
      '<w:tblPr><w:tblpPr/></w:tblPr>',
      '<w:tblPr><w:tblpPr w:tblpX=" 0x10 " w:horzAnchor="text" w:tblpXSpec="left"/><w:tblpPr w:tblpXSpec="right"/></w:tblPr>',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.withoutResolvedGeometry',
    call: (_text, args) => internals.withoutResolvedGeometry!(args.direct ?? undefined),
    fromParse: { fn: 'withoutResolvedGeometry', input: ([direct]) => ({ args: direct === undefined ? {} : json({ direct }) }) },
    built: [
      {},
      { direct: {} },
      { direct: { align: 'center', keepNext: true, spaceBefore: 120, styleId: undefined } },
      { direct: { keepLines: true, indentLeft: 720, indentRight: 0, indentFirstLine: -360, bidi: true, tabStops: [] } },
      { direct: { lineSpacing: 1.5, lineRule: 'auto', lineRawTwips: 360, borders: 'x', borderReset: 'y', contextualSpacing: true } },
      { direct: { spaceAfter: 0, shadingFill: 'FFFF00', widowControl: false } },
    ].map((args) => ({ args: json(args) })),
    mutation: 'none',
    argMutation: true,
  },
]
