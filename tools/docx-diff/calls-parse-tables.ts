// parse.ts: tables and headers and footers (crates/docx-engine/src/parse/tables.rs).
// A node argument crosses as its XML text, which both sides read with the
// table parser (deepXmlParser); a model value crosses as JSON, where NaN is
// null and an undefined array element is null, and the call maps them back.
// A function that changes its arguments is called on a copy, and what it
// changed is compared beside what it returned.
import type JSZip from 'jszip'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { parseInternals } from './parse-internals'
import { parseNumbering, parseRels } from './reference/parse-package'
import type { RelInfo } from './reference/parse-xml-text'
import { parseStyles } from './reference/parse-styles'
import { resolveCtxOf, type ResolveCtx } from './reference/resolve-props'
import { sectionSettingsFromXml } from './reference/section'
import type { DocDefaults, NumberingDef, StyleInfo, ThemeColors, ThemeFonts } from './reference/types'
import {
  inlineRawSource,
  inlineWrapContentLocked,
  inlineWrapKey,
  inlineWrapPrefixes,
  inlineWrapTextOf,
  inlineWrapWritesOnce,
  inlineWrapperShell,
  isInlineWrapper,
  partNamespaces,
  placeInlineWraps,
  rawElements,
  runCopiedElsewhere,
  sameInlineWrap,
  sameInlineWrapChain,
  sdtFollowsItsText,
  sdtOpenForChangedText,
  validInlineWrap,
} from './reference/inline-opaque'
import { deepXmlParser, nameOf, serializeXNode, type XNode } from './reference/xml-utils'
import { lineRuleOutsideItsType } from './listed'

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

const WAVE0: CallSpec[] = [
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

// ------------------------------------------------------------ batch B2
// A BuildContext crosses as `args.parts` (the package its styles, numbering,
// theme and relationships are read from: [name, text] pairs), `args.compat`
// (the settings the resolver takes), `args.sectionAt` (the context holds the
// section reader of document.xml) and `args.hf` (the bare context of a
// header/footer part). Model values cross as JSON.

const KEPT_PARTS =
  /^word\/(?:styles|numbering|settings|document|header\d*|footer\d*)\.xml$|^word\/theme\/theme1\.xml$|^word\/_rels\/(?:document|header\d*|footer\d*)\.xml\.rels$/
/** Characters of parts one input may carry: the calls of a document repeat them. */
const PARTS_BUDGET = 300_000

/** The parts a context is read from, or undefined where they are too large. */
function partsOf(parts: ReadonlyMap<string, string>): Array<[string, string]> | undefined {
  const kept = [...parts].filter(([name]) => KEPT_PARTS.test(name))
  return kept.reduce((n, [, text]) => n + text.length, 0) <= PARTS_BUDGET ? kept : undefined
}

interface Doc {
  zip: JSZip
  styles: Map<string, StyleInfo>
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  numFormats: Map<string, 'bullet' | 'ordered'>
  themeFonts: ThemeFonts | null
  themeColors: ThemeColors | null
  rels: Map<string, RelInfo>
  documentXml: string
}

const docs = new WeakMap<object, Promise<Doc>>()

async function readDoc(parts: Array<[string, string]>): Promise<Doc> {
  const zip = zipOf(parts)
  const theme = (await internals.parseTheme!(zip)) as { fonts: ThemeFonts | null; colors: ThemeColors | null }
  const { styles, docDefaults } = await parseStyles(zip, theme.colors, theme.fonts)
  const { defs, formats } = await parseNumbering(zip)
  const rels = await parseRels(zip, 'word/_rels/document.xml.rels')
  const documentXml = parts.find(([name]) => name === 'word/document.xml')?.[1] ?? ''
  return { zip, styles, docDefaults, numbering: defs, numFormats: formats, themeFonts: theme.fonts, themeColors: theme.colors, rels, documentXml }
}

function docOf(args: Record<string, unknown>): Promise<Doc> {
  const parts = args.parts as Array<[string, string]>
  let doc = docs.get(parts)
  if (!doc) {
    doc = readDoc(parts)
    docs.set(parts, doc)
  }
  return doc
}

interface CompatArgs {
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}

function resolverOf(doc: Doc, args: Record<string, unknown>): ResolveCtx {
  const compat = (args.compat ?? {}) as CompatArgs
  return resolveCtxOf({
    styles: doc.styles,
    docDefaults: doc.docDefaults,
    numbering: doc.numbering,
    themeFonts: doc.themeFonts,
    themeColors: doc.themeColors,
    compatibilityMode: compat.compatibilityMode,
    doNotUseHTMLParagraphAutoSpacing: compat.doNotUseHTMLParagraphAutoSpacing,
    indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
  })
}

/** The BuildContext of `args`, as parseDocx (or hfParagraphs) builds it. */
async function buildCtx(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const doc = await docOf(args)
  const resolver = resolverOf(doc, args)
  if (args.hf === true) {
    return {
      rels: new Map(),
      noteNumbers: new Map(),
      themeColors: doc.themeColors,
      themeFonts: doc.themeFonts,
      styles: doc.styles,
      xmlSpacePreserve: false,
      resolver,
    }
  }
  const compat = (args.compat ?? {}) as CompatArgs
  const ctx: Record<string, unknown> = {
    zip: doc.zip,
    compat: resolver.compat,
    resolver,
    sourcePath: 'word/document.xml',
    styles: doc.styles,
    rels: doc.rels,
    numFormats: doc.numFormats,
    numbering: doc.numbering,
    themeColors: doc.themeColors,
    themeFonts: doc.themeFonts,
    ...(doc.docDefaults ? { docDefaults: doc.docDefaults } : {}),
    ...(resolver.defaultParaStyle ? { defaultParaStyle: resolver.defaultParaStyle } : {}),
    compatibilityMode: compat.compatibilityMode,
    xmlSpacePreserve: false,
    noteNumbers: new Map(),
    openMoves: [],
    chartParts: {},
    sdtGroupSeq: 0,
  }
  if (args.sectionAt === true) {
    const slices = [...doc.documentXml.matchAll(/<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>/g)]
    const gutterAtTop = (await internals.parseSettingsFlag!(doc.zip, 'w:gutterAtTop')) as boolean
    ctx.sectionAt = (docOffset: number) => {
      let i = slices.findIndex((m) => (m.index ?? 0) + m[0].length > docOffset)
      if (i === -1) i = slices.length - 1
      return sectionSettingsFromXml(i >= 0 ? slices[i]![0] : '', { gutterAtTop })
    }
  }
  return ctx
}

/** The arguments of a context taken at a call: where the parts are small enough. */
function ctxArgs(
  parts: ReadonlyMap<string, string>,
  ctx: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const kept = partsOf(parts)
  if (!kept || !isObject(ctx)) return undefined
  const compat: Partial<ResolveCtx['compat']> = isObject(ctx.resolver) && isObject(ctx.resolver.compat) ? ctx.resolver.compat : {}
  return {
    parts: kept,
    compat: {
      compatibilityMode: compat.mode,
      doNotUseHTMLParagraphAutoSpacing: compat.additiveParaSpacing,
      indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
    },
    ...(typeof ctx.sectionAt === 'function' ? { sectionAt: true } : {}),
    ...(ctx.numbering === undefined ? { hf: true } : {}),
    ...extra,
  }
}

const withOffset = (docOffset: unknown): Record<string, unknown> =>
  typeof docOffset === 'number' ? { docOffset } : {}

// A small document: Normal, a table style with conditions and bands, the
// Header and Footer styles with their tab stops, one list.
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
const MINI_STYLES =
  `<?xml version="1.0"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="table" w:styleId="Banded"><w:name w:val="Banded"/><w:basedOn w:val="Grid"/><w:tblPr><w:tblStyleRowBandSize w:val="1"/></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:val="clear" w:fill="4472C4"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="lastCol"><w:rPr><w:b/></w:rPr><w:tcPr><w:tcBorders><w:left w:val="double" w:sz="6" w:color="FF0000"/></w:tcBorders></w:tcPr></w:tblStylePr></w:style>' +
  '</w:styles>'
const MINI_NUMBERING = `<?xml version="1.0"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
const MINI_SETTINGS = `<?xml version="1.0"?><w:settings ${NS}><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:num="1"/></w:sectPr>'
const MINI_DOCUMENT = (body = '') => `<?xml version="1.0"?><w:document ${NS}><w:body>${body}${SECT}</w:body></w:document>`
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const RELS = (items: string[]) =>
  `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">${items.join('')}</Relationships>`
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const miniParts = (extra: Array<[string, string]> = [], body = ''): Array<[string, string]> => [
  ['word/styles.xml', MINI_STYLES],
  ['word/numbering.xml', MINI_NUMBERING],
  ['word/settings.xml', MINI_SETTINGS],
  ['word/document.xml', MINI_DOCUMENT(body)],
  [
    'word/_rels/document.xml.rels',
    RELS([
      `<Relationship Id="rId1" Type="${OFFICE}/header" Target="header1.xml"/>`,
      `<Relationship Id="rId2" Type="${OFFICE}/footer" Target="footer1.xml"/>`,
      `<Relationship Id="rId3" Type="${OFFICE}/header" Target="header2.xml"/>`,
      `<Relationship Id="rId4" Type="${OFFICE}/image" Target="media/image1.png"/>`,
    ]),
  ],
  ...extra,
]
const COMPAT15 = { compatibilityMode: 15 }
const COMPAT14 = { compatibilityMode: 14 }

const hfXml = (kind: 'hdr' | 'ftr', body: string): string => `<?xml version="1.0"?><w:${kind} ${NS}>${body}</w:${kind}>`

// ---- tables of the document
const TC = (text: string, tcPr = ''): string => tc(P(text), tcPr)
const GRIDCOLS = (...w: number[]): string => `<w:tblGrid>${w.map((x) => `<w:gridCol w:w="${x}"/>`).join('')}</w:tblGrid>`
const TABLES: string[] = [
  tbl(tr(TC('a') + TC('b')) + tr(TC('c') + TC('d')), `<w:tblPr><w:tblStyle w:val="Banded"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0"/></w:tblPr>${GRIDCOLS(4000, 5000)}`),
  tbl(
    tr(TC('h1', '<w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:fill="FFFF00"/><w:vAlign w:val="center"/></w:tcPr>') + TC('h2', '<w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="8"/></w:tcBorders></w:tcPr>'), '<w:trPr><w:tblHeader/><w:trHeight w:val="400" w:hRule="exact"/></w:trPr>') +
      tr(TC('x', '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>')) +
      tr(TC('m1', '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>') + TC('r'), '<w:trPr><w:cantSplit/><w:ins w:id="5" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:trPr>') +
      tr(TC('m2', '<w:tcPr><w:vMerge/></w:tcPr>') + TC('r2')),
    `<w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="9000" w:type="dxa"/><w:tblInd w:w="100" w:type="dxa"/><w:jc w:val="center"/><w:tblLayout w:type="fixed"/><w:tblCaption w:val="cap"/></w:tblPr>${GRIDCOLS(3000, 6000)}`,
  ),
  tbl(tr(TC('l') + TC('mid') + TC('r')), `<w:tblPr><w:tblpPr w:tblpX="6000" w:tblpY="200" w:horzAnchor="page" w:vertAnchor="text" w:leftFromText="100" w:topFromText="50"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${GRIDCOLS(100, 100, 100)}`),
  tbl(tr(`<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${tbl(tr(TC('in1') + TC('in2')))}<w:p/></w:tc>${TC('side')}`)),
  tbl('<w:tr><w:trPr><w:gridBefore w:val="1"/><w:wBefore w:w="500" w:type="dxa"/><w:gridAfter w:val="1"/></w:trPr>' + TC('lone') + '</w:tr>' + tr(TC('p') + TC('q') + TC('s'))),
  tbl(tr(TC('a', '<w:tcPr><w:hMerge w:val="restart"/></w:tcPr>') + TC('', '<w:tcPr><w:hMerge/></w:tcPr>') + TC('b')) + tr('<w:tblPrEx><w:tblBorders><w:top w:val="dotted" w:sz="4"/><w:insideH w:val="dashed" w:sz="4"/></w:tblBorders><w:shd w:val="clear" w:fill="EEEEEE"/></w:tblPrEx>' + TC('e1') + TC('e2'))),
  `<w:tbl><w:tblPr><w:tblLook w:firstRow="1" w:lastColumn="1"/></w:tblPr>${tr(`<w:sdt><w:sdtContent>${TC('in sdt')}</w:sdtContent></w:sdt>${TC('after')}`)}</w:tbl>`,
  tbl(tr(tc('<w:p><w:pPr><w:pStyle w:val="Footer"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>bold</w:t></w:r></w:p>') + tc(`<w:p><w:r><m:t xmlns:m="x">y</m:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>`))),
]
const FLAT_TABLE = (n: number): string => `<w:tbl><w:tr><w:tc>${'<w:tbl><w:tr><w:tc>'.repeat(n)}${P('deep')}${'</w:tc></w:tr></w:tbl>'.repeat(n)}</w:tc></w:tr></w:tbl>`

const tableInputs = (extra: Record<string, unknown> = {}, tables = TABLES): Input[] =>
  tables.map((text, i) => ({
    text,
    args: { parts: miniParts([], text), compat: i % 2 ? COMPAT14 : COMPAT15, sectionAt: true, docOffset: 60 + i, ...extra },
  }))

const fromRows = (rows: unknown): unknown => json(rows)
const ctxNodeInput =
  (extra: (args: unknown[]) => Record<string, unknown>, nodeAt = 0, ctxAt = 1, offsetAt = -1) =>
  (args: unknown[], parts: ReadonlyMap<string, string>): Input | undefined => {
    const node = args[nodeAt]
    const common = ctxArgs(parts, args[ctxAt], offsetAt >= 0 ? withOffset(args[offsetAt]) : {})
    if (!common || !(node === undefined || isObject(node))) return undefined
    return { text: node === undefined ? '' : serializeXNode(node), args: { ...common, ...extra(args) } }
  }

// ---- header / footer parts
const hfParts = (header: string, footer = '', extraParts: Array<[string, string]> = []): Array<[string, string]> =>
  miniParts([
    ['word/header1.xml', header],
    ['word/footer1.xml', footer || hfXml('ftr', '<w:p/>')],
    ['word/_rels/header1.xml.rels', RELS([`<Relationship Id="rId9" Type="${OFFICE}/image" Target="media/logo.png"/>`])],
    ...extraParts,
  ])
const PAGE_FLD = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
const NUM_FLD = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
const DATE_FLD = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>today</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
const NESTED_FLD = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF </w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>ok</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
const UNCLOSED_FLD = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF </w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> X </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>r</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
const DRAWING = (inner: string, anchor = true): string =>
  `<w:r><w:drawing>${anchor ? '<wp:anchor behindDoc="1" distL="9525" distT="19050"><wp:positionH relativeFrom="page"><wp:posOffset>95250</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>19050</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="476250"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="7" name="logo"/>' : '<wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="8" name="in"/>'}<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId9"/><a:srcRect l="10000" t="5000"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>${anchor ? '</wp:anchor>' : '</wp:inline>'}</w:drawing></w:r>`
const HF_BODIES: string[] = [
  `<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t>left</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>center</w:t></w:r><w:r><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/></w:r>${PAGE_FLD}</w:p>`,
  `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Page </w:t></w:r>${PAGE_FLD}<w:r><w:t> / </w:t></w:r>${NUM_FLD}</w:p><w:p>${DATE_FLD}</w:p><w:p>${NESTED_FLD}</w:p>`,
  `<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:b/></w:rPr><w:t>1</w:t></w:r></w:fldSimple><w:fldSimple w:instr=" NUMPAGES "/><w:fldSimple w:instr=" SECTIONPAGES "><w:r><w:t>x</w:t></w:r></w:fldSimple><w:fldSimple w:instr=" AUTHOR "><w:r><w:t>me</w:t></w:r></w:fldSimple><w:r><w:pgNum/></w:r></w:p>`,
  `<w:p>${UNCLOSED_FLD}</w:p>`,
  `<w:p><w:pPr><w:framePr w:w="500" w:h="300" w:hRule="exact" w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="right"/></w:pPr><w:r><w:t>1</w:t></w:r></w:p><w:p><w:r><w:t>x</w:t></w:r></w:p>`,
  `<w:p><w:r><w:rPr><w:sz w:val="16"/></w:rPr></w:r></w:p><w:p/><w:p><w:pPr><w:rPr><w:rFonts w:hint="eastAsia" w:eastAsia="Malgun Gothic"/><w:sz w:val="40"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">  </w:t></w:r></w:p>`,
  `<w:p>${DRAWING(P(''), true)}</w:p><w:p><w:r><w:t>text</w:t></w:r>${DRAWING('', false)}</w:p>`,
  tbl(
    tr(TC('left', '<w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:tcBorders><w:bottom w:val="single" w:sz="4"/></w:tcBorders></w:tcPr>') + TC('right', '<w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>'), '<w:trPr><w:trHeight w:val="500"/></w:trPr>') +
      tr(`<w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="auto"/></w:tcPr>${P('v')}</w:tc>${TC('w')}`) +
      tr(`<w:tc><w:tcPr><w:vMerge/></w:tcPr>${P('')}</w:tc>${TC('z')}`),
    `<w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="9000" w:type="dxa"/><w:tblInd w:w="-108" w:type="dxa"/><w:jc w:val="right"/><w:bidiVisual/></w:tblPr>${GRIDCOLS(3000, 6000)}`,
  ) + '<w:p/>',
  `<w:tbl><w:tblPr><w:tblpPr w:tblpX="100" w:vertAnchor="page"/></w:tblPr><w:tr><w:tc>${tbl(tr(TC('n1') + TC('n2')))}${P('after')}</w:tc></w:tr></w:tbl><w:p><w:r><w:t>following</w:t></w:r></w:p>`,
  `<w:sdt><w:sdtContent><w:p><w:r><w:t>in sdt</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><w:r><w:pict><v:shape style="position:absolute;margin-left:10pt;margin-top:5pt;width:100pt;height:50pt;z-index:-1" type="#t"><v:imagedata r:id="rId9" gain="32768f"/></v:shape></w:pict></w:r></w:p>`,
  `<w:p><w:del w:id="1" w:author="x"><w:r><w:drawing><wp:inline><wp:docPr id="1"/></wp:inline></w:drawing></w:r></w:del><w:del w:id="2" w:author="x"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
]
const HF_PARTS = (): string[] => HF_BODIES.map((body, i) => hfXml(i % 2 ? 'ftr' : 'hdr', body))

const hfIn = (text: string, extra: Record<string, unknown> = {}, compat: CompatArgs = COMPAT15): Input => ({
  text,
  args: { parts: hfParts(text), compat, hf: true, compatibilityMode: compat.compatibilityMode ?? 0, ...extra },
})

const mapEntries = (value: unknown): unknown => (value instanceof Map ? [...value] : value)
const entriesOf = (value: unknown): Map<string, string> | undefined =>
  Array.isArray(value) ? new Map(value as Array<[string, string]>) : undefined

// ---- inline opaque
const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const wrap = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq: 1,
  open: `<w:sdt><w:sdtPr><w:alias w:val="a"/><w:id w:val="5"/></w:sdtPr><w:sdtContent>`,
  close: '</w:sdtContent></w:sdt>',
  ...extra,
})
const WRAPS: Array<Record<string, unknown>> = [
  wrap(),
  wrap({ inside: 'revision' }),
  wrap({ inside: 'link', text: 'x' }),
  wrap({ open: '<w:smartTag w:uri="u"><w:smartTagPr><w:attr w:name="a"/></w:smartTagPr>', close: '</w:smartTag>' }),
  wrap({ open: '<w:dir w:val="rtl">', close: '</w:dir>' }),
  wrap({ open: '<w:bdo w:val="ltr">', close: '</w:bdo>' }),
  wrap({ open: `<w:customXml w:element="e" xmlns:w14="${W14}"><w:customXmlPr/>`, close: '</w:customXml>' }),
  wrap({ open: `<w:sdt xmlns:w="${WNS}" xmlns:w14="${W14}"><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent>` }),
  wrap({ open: '<w:sdt><w:sdtPr><w:showingPlcHdr/><w:dataBinding w:xpath="/a" w:storeItemID="{1}"/></w:sdtPr><w:sdtContent>' }),
  wrap({ open: '<w:sdt><w:sdtPr><w:lock w:val="sdtContentLocked"/></w:sdtPr><w:sdtContent>' }),
  wrap({ open: '<w:sdt><w:sdtPr><w:lock w:val=\'contentLocked\'/><w15:dataBinding w15:x="1"/></w:sdtPr><w:sdtContent>' }),
  wrap({ open: '<w:sdt><w:sdtContent>text' }),
  wrap({ open: '<w:sdt><w:sdtPr><w:r/></w:sdtPr><w:sdtContent>' }),
  wrap({ open: '<w:sdt><w:sdtPr x:a="1"/><w:sdtContent>' }),
  wrap({ open: '<w:sdt a="1" a="2"><w:sdtContent>' }),
  wrap({ open: '<w:sdt a="&bogus;"><w:sdtContent>' }),
  wrap({ open: '<w:sdt a="&#x41;&#65;&amp;"><w:sdtContent>' }),
  wrap({ open: '<w:sdt a="&#0;"><w:sdtContent>' }),
  wrap({ open: '<w:sdt a="x<y"><w:sdtContent>' }),
  wrap({ open: '<w:sdt xmlns="u"><w:sdtContent>' }),
  wrap({ open: '<w:sdt xmlns:w="other"><w:sdtContent>' }),
  wrap({ open: '<w:sdt xmlns:w14="http://evil/"><w:sdtContent>' }),
  wrap({ open: '<w:p><w:sdtContent>', close: '</w:sdtContent></w:p>' }),
  wrap({ open: '<w:sdt><w:sdtContent>', close: '</w:sdtContent></w:sdt><w:sdt/>' }),
  wrap({ open: '<w:sdt><w:sdtContent><!-- c -->', close: '</w:sdtContent></w:sdt>' }),
  wrap({ open: '<w:sdt>', close: '</w:sdt>' }),
  wrap({ open: `${'<w:sdt><w:sdtContent>'.repeat(40)}`, close: '</w:sdtContent></w:sdt>'.repeat(40) }),
  wrap({ open: `<w:sdt><w:sdtPr><w:tag w:val="${'x'.repeat(70000)}"/></w:sdtPr><w:sdtContent>` }),
  wrap({ seq: 'one' }),
  wrap({ inside: 'sideways' }),
  wrap({ text: 5 }),
]

const SHELL_XMLS: string[] = [
  '<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent><w:r><w:t>a</w:t></w:r></w:sdtContent></w:sdt>',
  '<w:sdt><w:sdtPr/><w:sdtContent/></w:sdt>',
  '<w:sdt><w:sdtPr/></w:sdt>',
  '<w:sdt><w:sdtContent><w:r/></w:sdtContent><w:sdtEndPr/></w:sdt>',
  '<w:sdt><w:sdtContent><w:r/></w:sdtContent><w:r/></w:sdt>',
  '<w:smartTag w:uri="u"><w:smartTagPr><w:attr w:name="a"/></w:smartTagPr><w:r><w:t>s</w:t></w:r></w:smartTag>',
  '<w:smartTag w:uri="u"><w:r><w:t>s</w:t></w:r></w:smartTag>',
  '<w:customXml w:element="e"><w:customXmlPr><w:attr/></w:customXmlPr><w:r/><w:r/></w:customXml>',
  '<w:dir w:val="rtl"><w:r><w:t>d</w:t></w:r></w:dir>',
  '<w:bdo w:val="ltr"/>',
  '<w:bdo w:val="ltr"></w:bdo>',
  '<w:p><w:r/></w:p>',
  '<!-- c --><w:dir w:val="rtl"><w:r/></w:dir>',
  '<w:sdt a="x&amp;y"><w:sdtContent><w:r><w:t>é&lt;</w:t></w:r></w:sdtContent></w:sdt>',
  '',
]

const RUNS: Array<Record<string, unknown>> = [
  { text: 'a' },
  { text: 'b', del: { author: 'x' } },
  { text: '1', noteRef: { kind: 'footnote', id: '1' } },
  { text: 'c', wrap: [wrap()] },
  { text: 'd', wrap: [wrap(), wrap({ seq: 2, open: '<w:dir w:val="rtl">', close: '</w:dir>' })] },
  { text: 'e', wrap: [wrap()], ins: { author: 'x', id: '9' } },
  { text: 'f', wrap: [wrap({ inside: 'link' })], link: { href: 'http://a', rId: 'r1' } },
  { text: 'g', wrap: [wrap({ inside: 'link' })], link: { href: 'http://a', rId: 'r2' } },
  { text: 'h', link: { href: 'http://a' } },
  { text: 'i', wrap: [wrap({ seq: 3, inside: 'revision' })], del: { author: 'x', id: '4' } },
  { text: 'j', wrap: [wrap({ seq: 3, open: '<w:smartTag w:uri="u">', close: '</w:smartTag>' })] },
]
const runsIn = (...at: number[]): Array<Record<string, unknown>> => at.map((i) => RUNS[i]!)
const REV_KEY = (run: { ins?: { id?: string }; del?: { id?: string } }): string =>
  run.ins ? `ins:${run.ins.id ?? ''}` : run.del ? `del:${run.del.id ?? ''}` : ''

const BATCH2: CallSpec[] = [
  // ---------------------------------------------------------------- tables
  {
    fn: 'parse.tcwColumnWidths',
    call: (text, args) => internals.tcwColumnWidths!(elementOf(text), args.pctTableTwips),
    fromParse: {
      fn: 'tcwColumnWidths',
      input: ([node, pct]) => {
        const input = nodeInput(node)
        return input ? { ...input, args: pct === undefined ? {} : { pctTableTwips: pct } } : undefined
      },
    },
    built: [
      ...TABLES.map((text) => ({ text })),
      { text: tbl(tr(TC('a', '<w:tcPr><w:tcW w:w="2500" w:type="pct"/></w:tcPr>'))), args: { pctTableTwips: 9000 } },
      { text: tbl(tr(TC('a', '<w:tcPr><w:tcW w:w="1000"/></w:tcPr>') + TC('b', '<w:tcPr><w:gridSpan w:val="2"/><w:tcW w:w="800"/></w:tcPr>')) + tr(TC('c', '<w:tcPr><w:tcW w:w="1500"/></w:tcPr>') + TC('d', '<w:tcPr><w:tcW w:w="900"/></w:tcPr>'))) },
      { text: tbl(`<w:tr><w:trPr><w:gridBefore w:val="2"/></w:trPr>${TC('a', '<w:tcPr><w:tcW w:w="100"/></w:tcPr>')}</w:tr>`) },
      { text: tbl(tr(TC('a', '<w:tcPr><w:gridSpan w:val="1.5"/><w:tcW w:w="100"/></w:tcPr>') + TC('b', '<w:tcPr><w:tcW w:w="200"/></w:tcPr>'))) },
      { text: tbl(tr(TC('a', '<w:tcPr><w:tcW w:w="100"/><w:tcW w:w="300"/></w:tcPr>'))) },
      { text: '' },
    ],
  },
  {
    fn: 'parse.tablePropExceptionsOf',
    call: (text) => internals.tablePropExceptionsOf!(nodeOf(text)),
    fromParse: { fn: 'tablePropExceptionsOf', input: ([node]) => (node === undefined ? { text: '' } : nodeInput(node)) },
    built: [
      '',
      '<w:tblPrEx/>',
      '<w:tblPrEx><w:tblBorders><w:top w:val="single" w:sz="4" w:color="FF0000"/><w:insideV w:val="dashed"/></w:tblBorders></w:tblPrEx>',
      '<w:tblPrEx><w:tblCellMar><w:left w:w="50" w:type="dxa"/><w:top w:w="x"/></w:tblCellMar><w:shd w:val="clear" w:fill="00FF00"/></w:tblPrEx>',
      '<w:tblPrEx><w:shd w:val="pct25" w:color="000000" w:fill="FFFFFF"/></w:tblPrEx>',
      '<w:tblPrEx><w:shd w:val="clear" w:fill="auto"/></w:tblPrEx>',
      REFUSED,
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.applyRowPropExceptions',
    call: (_text, args) => {
      const rows = structuredClone(args.rows) as unknown[]
      internals.applyRowPropExceptions!(rows, args.exceptions)
      return rows
    },
    fromParse: {
      fn: 'applyRowPropExceptions',
      input: ([rows, exceptions]) => ({ args: json({ rows, exceptions }) }),
    },
    built: (() => {
      const border = (style = 'single'): Record<string, unknown> => ({ style, szEighths: 4, color: '000000' })
      const tblBorders = { top: border(), bottom: border('double'), left: border(), right: border('dotted'), insideH: border('dashed'), insideV: border('dotted') }
      const grid = (r: number, c: number): Array<Array<Record<string, unknown>>> => Array.from({ length: r }, () => Array.from({ length: c }, () => cell()))
      return [
        { rows: grid(3, 3), exceptions: [null, { borders: tblBorders }, null] },
        { rows: grid(2, 2), exceptions: [{ borders: tblBorders, cellMarTwips: { left: 10, right: 20 }, fill: 'EEEEEE' }, { fill: 'AAAAAA' }] },
        { rows: [[cell({ fill: 'FF0000', borders: { top: border('thick') }, cellMarTwips: { top: 5 } }), cell()]], exceptions: [{ borders: tblBorders, cellMarTwips: { left: 1 }, fill: 'EEEEEE' }] },
        { rows: grid(1, 1), exceptions: [{ borders: { top: border() } }] },
        { rows: grid(2, 1), exceptions: [{ borders: { insideH: border() } }, { borders: { insideH: border() } }] },
        { rows: grid(2, 2), exceptions: [null, null] },
        { rows: [], exceptions: [] },
      ].map((args) => ({ args }))
    })(),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.applyTableStyleDisplay',
    call: async (text, args) => {
      const rows = structuredClone(args.rows) as unknown[]
      internals.applyTableStyleDisplay!(rows, nodeOf(text), await buildCtx(args))
      return rows
    },
    fromParse: {
      fn: 'applyTableStyleDisplay',
      input: ([rows, tblPr, ctx], parts) => {
        const common = ctxArgs(parts, ctx)
        if (!common || !(tblPr === undefined || isObject(tblPr))) return undefined
        return { text: tblPr === undefined ? '' : serializeXNode(tblPr as XNode), args: { ...common, rows: json(rows) } }
      },
    },
    built: (() => {
      const plain = (r: number, c: number): Array<Array<Record<string, unknown>>> => Array.from({ length: r }, () => Array.from({ length: c }, () => cell()))
      const pr = (style: string, look = ''): string => `<w:tblPr><w:tblStyle w:val="${style}"/>${look}</w:tblPr>`
      return [
        { text: pr('Banded', '<w:tblLook w:val="04A0"/>'), args: { rows: plain(4, 3) } },
        { text: pr('Banded', '<w:tblLook w:firstRow="0" w:lastColumn="1" w:noHBand="1"/>'), args: { rows: plain(3, 2) } },
        { text: pr('Banded', '<w:tblLook w:val="0000"/><w:tblStyleRowBandSize w:val="2"/>'), args: { rows: plain(5, 1) } },
        { text: pr('Banded'), args: { rows: [[cell({ fill: 'FF0000', colSpan: 2, bold: false, color: '111111' }), cell({ borders: { left: { style: 'single' } }, cellMarTwips: { left: 3 } })]] } },
        { text: pr('Grid'), args: { rows: plain(2, 2) } },
        { text: pr('Missing'), args: { rows: plain(2, 2) } },
        { text: '', args: { rows: plain(1, 1) } },
      ].map((input) => ({ ...input, args: { ...input.args, parts: miniParts(), compat: COMPAT15 } }))
    })(),
    argMutation: true,
  },
  {
    fn: 'parse.attachRawTablePr',
    call: (text, args) => {
      const model = structuredClone(args.model) as Record<string, unknown>
      const rawTrPrs = structuredClone(args.rawTrPrs) as unknown[]
      internals.attachRawTablePr!(text, model, rawTrPrs)
      return { model, rawTrPrs }
    },
    fromParse: {
      fn: 'attachRawTablePr',
      input: ([xml, model, rawTrPrs]) =>
        typeof xml === 'string' ? { text: xml, args: json({ model, rawTrPrs }) } : undefined,
    },
    built: (() => {
      const model = (rows: number, cols: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell())),
        ...extra,
      })
      const chg = (name: string, inner = ''): string => `<${name} w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z">${inner}</${name}>`
      const x1 = tbl(tr(TC('a', `<w:tcPr><w:tcW w:w="1"/>${chg('w:tcPrChange', '<w:tcPr/>')}<w:cellMerge w:id="4" w:author="B" w:vMerge="rest"/></w:tcPr>`) + TC('b'), `<w:trPr><w:cantSplit/>${chg('w:trPrChange', '<w:trPr/>')}</w:trPr>`) + tr(TC('c')), `<w:tblPr>${chg('w:tblPrChange', '<w:tblPr><w:tblW w:w="5"/></w:tblPr>')}</w:tblPr><w:tblGrid><w:gridCol w:w="1"/>${chg('w:tblGridChange', '<w:tblGrid/>')}</w:tblGrid>`)
      const x2 = tbl('<w:tr><w:tblPrEx><w:shd w:fill="AA"/>' + chg('w:tblPrExChange', '<w:tblPrEx/>') + '</w:tblPrEx>' + TC('only') + '</w:tr>')
      return [
        { text: x1, args: { model: model(2, 2), rawTrPrs: [null, null] } },
        { text: x1, args: { model: model(1, 2), rawTrPrs: [null] } },
        { text: x1, args: { model: model(2, 1), rawTrPrs: [null, null] } },
        { text: x2, args: { model: model(1, 1), rawTrPrs: [null] } },
        { text: x2, args: { model: model(1, 2, { rows: [[cell({ gridGap: true }), cell()]] }), rawTrPrs: [null] } },
        { text: tbl(tr(tc(tbl(tr(TC('inner'))) + '<w:p/>', '<w:tcPr><w:vAlign w:val="top"/></w:tcPr>'))), args: { model: model(1, 1), rawTrPrs: [null] } },
        { text: '<w:p/>', args: { model: model(1, 1), rawTrPrs: [null] } },
        { text: '<w:tbl>', args: { model: model(1, 1), rawTrPrs: [null] } },
        { text: '', args: { model: model(0, 0), rawTrPrs: [] } },
      ].map((input) => ({ ...input }))
    })(),
    argMutation: true,
  },
  {
    fn: 'parse.extractTable',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => internals.extractTable!(text, await buildCtx(args), args.docOffset),
    fromParse: {
      fn: 'extractTable',
      input: ([xml, ctx, docOffset], parts) => {
        const common = ctxArgs(parts, ctx, withOffset(docOffset))
        return typeof xml === 'string' && common ? { text: xml, args: common } : undefined
      },
    },
    built: [...tableInputs(), { text: FLAT_TABLE(10), args: { parts: miniParts(), compat: COMPAT15 } }, { text: '<w:p/>', args: { parts: miniParts(), compat: COMPAT15 } }, { text: REFUSED, args: { parts: miniParts(), compat: COMPAT15 } }],
  },
  {
    fn: 'parse.extractTableModel',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => internals.extractTableModel!(elementOf(text), await buildCtx(args), args.depth, args.docOffset),
    fromParse: {
      fn: 'extractTableModel',
      input: ([node, ctx, depth, docOffset], parts) => {
        const input = nodeInput(node)
        const common = ctxArgs(parts, ctx, { ...withOffset(docOffset), ...(typeof depth === 'number' ? { depth } : {}) })
        return input && common ? { ...input, args: common } : undefined
      },
    },
    built: [...tableInputs(), ...tableInputs({ depth: 8 }, [TABLES[3]!]), { text: '', args: { parts: miniParts(), compat: COMPAT15 } }],
  },
  {
    fn: 'parse.extractCell',
    call: async (text, args) =>
      internals.extractCell!(elementOf(text), await buildCtx(args), args.depth, args.docOffset, args.tableStyleId, args.conds),
    fromParse: {
      fn: 'extractCell',
      input: ([node, ctx, depth, docOffset, tableStyleId, conds], parts) => {
        const input = nodeInput(node)
        const common = ctxArgs(parts, ctx, {
          ...withOffset(docOffset),
          depth,
          ...(tableStyleId === undefined ? {} : { tableStyleId }),
          ...(conds === undefined ? {} : { conds }),
        })
        return input && common && typeof depth === 'number' ? { ...input, args: common } : undefined
      },
    },
    built: [
      tc(P('plain')),
      tc('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="00FF00"/></w:rPr><w:t>c</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="00FF00"/></w:rPr><w:t>d</w:t></w:r></w:p>', '<w:tcPr><w:gridSpan w:val="2"/><w:vMerge/><w:shd w:val="clear" w:fill="FFEEDD"/><w:vAlign w:val="bottom"/><w:tcMar><w:left w:w="40" w:type="dxa"/></w:tcMar><w:textDirection w:val="btLr"/><w:noWrap/><w:hideMark/><w:hMerge w:val="restart"/><w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders><w:cellIns w:id="3" w:author="A"/><w:cellDel w:author="B"/></w:tcPr>'),
      tc(`${P('before')}${tbl(tr(TC('n')))}${P('after')}`),
      tc('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>li</w:t></w:r></w:p><w:p/>'),
      tc('<w:p><w:r><w:drawing><wp:anchor><wp:extent cx="9525" cy="9525"/><wp:docPr id="1"/><a:graphic><a:graphicData><pic:pic><a:blip r:embed="rId4"/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing><w:t>pic</w:t></w:r></w:p>'),
      tc('<w:sdt><w:sdtContent><w:p><w:r><w:t>s</w:t></w:r></w:p></w:sdtContent></w:sdt>'),
      tc(''),
    ].flatMap((text) => [
      { text, args: { parts: miniParts(), compat: COMPAT15, depth: 1, tableStyleId: 'Banded', conds: ['firstRow', 'lastCol'] } },
      { text, args: { parts: miniParts(), compat: COMPAT14, depth: 8, sectionAt: true, docOffset: 5 } },
    ]),
  },
  // ------------------------------------------------- header/footer helpers
  {
    fn: 'parse.hfEmptyMarkFont',
    call: async (text, args) => internals.hfEmptyMarkFont!(nodeOf(text), await buildCtx(args)),
    fromParse: { fn: 'hfEmptyMarkFont', input: ctxNodeInput(() => ({})) },
    built: [
      '',
      '<w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Batang"/></w:rPr></w:pPr>',
      '<w:pPr><w:rPr><w:rFonts w:hint="eastAsia" w:eastAsia="Batang" w:ascii="Arial"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:pPr>',
      '<w:pPr><w:rPr><w:rFonts w:hint="eastAsia"/><w:lang w:eastAsia="en-US"/></w:rPr></w:pPr>',
      '<w:pPr><w:pStyle w:val="Header"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman"/></w:rPr></w:pPr>',
      '<w:pPr><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/></w:rPr></w:pPr>',
      '<w:pPr/>',
    ].map((text) => ({ text, args: { parts: miniParts(), compat: COMPAT15, hf: true } })),
  },
  {
    fn: 'parse.hfParaStyleLayers',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => internals.hfParaStyleLayers!(elementOf(text), (await buildCtx(args)).styles),
    fromParse: {
      fn: 'hfParaStyleLayers',
      input: ([node, styles], parts) => {
        const input = nodeInput(node)
        const kept = partsOf(parts)
        return input && kept && styles instanceof Map ? { ...input, args: { parts: kept, compat: COMPAT15 } } : undefined
      },
    },
    built: [
      '<w:p/>',
      '<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="clear" w:pos="4680"/><w:tab w:val="left" w:pos="100"/></w:tabs><w:keepNext/></w:pPr></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Nope"/></w:pPr></w:p>',
      '',
    ].map((text) => ({ text, args: { parts: miniParts(), compat: COMPAT15, hf: true } })),
  },
  {
    fn: 'parse.hfStyledParaFormat',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => internals.hfStyledParaFormat!(elementOf(text), await buildCtx(args)),
    fromParse: { fn: 'hfStyledParaFormat', input: ctxNodeInput(() => ({})) },
    built: [
      '<w:p/>',
      '<w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/><w:ind w:left="720" w:firstLine="-360"/><w:spacing w:before="120" w:after="60" w:line="360" w:lineRule="auto"/><w:keepNext/><w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr><w:shd w:val="clear" w:fill="EEEEEE"/></w:pPr></w:p>',
      '<w:p><w:pPr><w:bidi/><w:jc w:val="left"/><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr></w:p>',
      '',
    ].map((text) => ({ text, args: { parts: miniParts(), compat: COMPAT15, hf: true } })),
  },
  {
    fn: 'parse.hfCellBorders',
    call: (_text, args) => internals.hfCellBorders!(args.rows, args.r, args.c, args.tbl),
    fromParse: { fn: 'hfCellBorders', input: () => undefined },
    built: (() => {
      const b = (style: string, sz = 4): Record<string, unknown> => ({ style, szEighths: sz, color: '000000' })
      const raw = (gridStart: number, span = 1, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        gridStart,
        span,
        widthTwips: 1000,
        widthIsPct: false,
        vMergeContinue: false,
        ...extra,
      })
      const tblB = { top: b('single'), left: b('single'), bottom: b('single'), right: b('single'), insideH: b('dashed'), insideV: b('dotted') }
      const rows = [[raw(0, 1, { borders: { bottom: b('double'), right: b('thick', 8) } }), raw(1, 2)], [raw(0, 2, { borders: { top: b('wave') } }), raw(2, 1, { vMergeContinue: true })], [raw(0), raw(1), raw(2, 1, { borders: { left: b('none') } })]]
      const at = (r: number, c: number, tbl?: unknown): Input => ({ args: json({ rows, r, c, ...(tbl ? { tbl } : {}) }) })
      return [at(0, 0, tblB), at(0, 1, tblB), at(1, 0, tblB), at(1, 1, tblB), at(2, 0, tblB), at(2, 2, tblB), at(0, 0), at(1, 1), at(2, 1), at(5, 0), at(0, 5)]
    })(),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hfVSpanOf',
    call: (_text, args) => internals.hfVSpanOf!(args.rows, args.r, num(args.col)),
    fromParse: { fn: 'hfVSpanOf', input: () => undefined },
    built: (() => {
      const raw = (gridStart: number, span: number, vMergeContinue: boolean): Record<string, unknown> => ({ gridStart, span, widthTwips: 1, widthIsPct: false, vMergeContinue })
      const rows = [[raw(0, 1, false), raw(1, 2, false)], [raw(0, 1, true), raw(1, 2, true)], [raw(0, 2, true), raw(2, 1, false)], [raw(0, 1, false)]]
      return [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0], [3, 0], [0, 1.5], [0, 9], [9, 0]].map(([r, col]) => ({ args: { rows, r, col } }))
    })(),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.hfTableMedia',
    call: async (text, args) => mapEntries(await internals.hfTableMedia!(zipOf(args.parts), args.partPath, text)),
    fromParse: {
      fn: 'hfTableMedia',
      input: ([, partPath, partXml], parts) => {
        const kept = partsOf(parts)
        return typeof partPath === 'string' && typeof partXml === 'string' && kept ? { text: partXml, args: { parts: kept, partPath } } : undefined
      },
    },
    built: [
      ...HF_PARTS().map((text) => ({ text, args: { parts: hfParts(text), partPath: 'word/header1.xml' } })),
      { text: hfXml('hdr', `<w:p>${DRAWING('', false)}</w:p><w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId9"/><v:imagedata r:id="rId404"/></v:shape></w:pict></w:r></w:p>`), args: { parts: hfParts(hfXml('hdr', ''), '', [['word/_rels/header9.xml.rels', RELS([`<Relationship Id="rId9" Type="${OFFICE}/image" Target="http://example.com/a.png" TargetMode="External"/>`, `<Relationship Id="rId10" Type="${OFFICE}/image" Target="HTTPS://x/y.png"/>`])]]), partPath: 'word/header9.xml' } },
      { text: '<w:hdr/>', args: { parts: miniParts(), partPath: 'word/header1.xml' } },
    ],
  },
  {
    fn: 'parse.hfCellContent',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => internals.hfCellContent!(elementOf(text), await buildCtx(args), args.tableStyleId),
    fromParse: {
      fn: 'hfCellContent',
      input: (args, parts) => {
        const node = args[0]
        const common = ctxArgs(parts, args[1], args[2] === undefined ? {} : { tableStyleId: args[2] })
        return isObject(node) && common ? { text: serializeXNode(node), args: common } : undefined
      },
    },
    built: [
      tc(P('plain')),
      tc('<w:p><w:pPr><w:pStyle w:val="Footer"/><w:ind w:left="200" w:firstLine="100"/><w:spacing w:before="20" w:after="40" w:line="300" w:lineRule="exact"/><w:tabs><w:tab w:val="right" w:pos="5000"/></w:tabs><w:wordWrap w:val="0"/></w:pPr><w:r><w:t>styled</w:t></w:r></w:p>'),
      tc('<w:tcPr><w:shd w:val="clear" w:fill="#AABBCC"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>c</w:t></w:r></w:p>'),
      tc('<w:tcPr><w:shd w:val="clear" w:fill="auto"/></w:tcPr><w:p/>'),
      tc(`<w:p><w:r><w:t>out</w:t></w:r></w:p>${tbl(tr(TC('n1', '<w:tcPr><w:shd w:fill="DDDDDD"/></w:tcPr>') + TC('n2')), '<w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr>')}<w:p/><w:p/>`),
      tc(`<w:p>${DRAWING('', true)}<w:r><w:t>kept text</w:t></w:r></w:p><w:p>${DRAWING('', false)}</w:p>`),
      tc('<w:sdt><w:sdtContent><w:p><w:r><w:t>s</w:t></w:r></w:p></w:sdtContent></w:sdt>'),
    ].flatMap((text) => [
      { text, args: { parts: hfParts(hfXml('hdr', '')), compat: COMPAT15, hf: true } },
      { text, args: { parts: hfParts(hfXml('hdr', '')), compat: COMPAT14, hf: true, tableStyleId: 'Grid' } },
    ]),
  },
  {
    fn: 'parse.hfTableRowParagraphs',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => {
      const paras = internals.hfTableRowParagraphs!(elementOf(text), await buildCtx(args), args.compatibilityMode, args.tblIndex) as object[]
      return { paras, rowAnchorIds: paras.map((p) => weakMaps.hfRowAnchorIds!.get(p) ?? null) }
    },
    fromParse: {
      fn: 'hfTableRowParagraphs',
      input: ([tblNode, ctx, compatibilityMode, tblIndex], parts) => {
        const input = nodeInput(tblNode)
        const common = ctxArgs(parts, ctx, { compatibilityMode, ...(tblIndex === undefined ? {} : { tblIndex }) })
        return input && common && typeof compatibilityMode === 'number' ? { ...input, args: common } : undefined
      },
    },
    built: HF_BODIES.flatMap((body) => [...body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => m[0])).flatMap((text) => [
      { text, args: { parts: hfParts(hfXml('hdr', text)), compat: COMPAT15, hf: true, compatibilityMode: 15, tblIndex: 0 } },
      { text, args: { parts: hfParts(hfXml('hdr', text)), compat: COMPAT14, hf: true, compatibilityMode: 14 } },
    ]),
  },
  {
    fn: 'parse.hfParagraphs',
    call: async (text, args) => {
      const doc = await docOf(args)
      const paras = internals.hfParagraphs!(
        text,
        doc.themeColors,
        doc.styles,
        entriesOf(args.tableMedia),
        args.compatibilityMode,
        doc.themeFonts,
        resolverOf(doc, args),
      ) as object[]
      return {
        paras,
        rowAnchorIds: paras.map((p) => weakMaps.hfRowAnchorIds!.get(p) ?? null),
        runImageIds: [...((weakMaps.hfRunImageIds!.get(paras) as Set<string> | undefined) ?? [])].sort(),
      }
    },
    fromParse: {
      fn: 'hfParagraphs',
      input: ([partXml, , , tableMedia, compatibilityMode], parts) => {
        const kept = partsOf(parts)
        return typeof partXml === 'string' && kept
          ? { text: partXml, args: { parts: kept, compat: { compatibilityMode }, compatibilityMode: compatibilityMode ?? 0, ...(tableMedia instanceof Map ? { tableMedia: [...tableMedia] } : {}) } }
          : undefined
      },
    },
    built: HF_PARTS().flatMap((text, i) => [
      hfIn(text, i % 3 === 0 ? { tableMedia: [['rId9', 'data:image/png;base64,AA==']] } : {}),
      hfIn(text, {}, COMPAT14),
    ]),
  },
  {
    fn: 'parse.hfContentFromXml',
    listed: lineRuleOutsideItsType,
    call: async (text, args) => {
      const doc = await docOf(args)
      return internals.hfContentFromXml!(
        text,
        args.kind,
        doc.themeColors,
        doc.styles,
        entriesOf(args.tableMedia),
        args.compatibilityMode,
        doc.themeFonts,
        resolverOf(doc, args),
      )
    },
    fromParse: {
      fn: 'hfContentFromXml',
      input: ([xml, kind, , , tableMedia, compatibilityMode], parts) => {
        const kept = partsOf(parts)
        return typeof xml === 'string' && kept
          ? { text: xml, args: { parts: kept, kind, compat: { compatibilityMode }, compatibilityMode: compatibilityMode ?? 0, ...(tableMedia instanceof Map ? { tableMedia: [...tableMedia] } : {}) } }
          : undefined
      },
    },
    built: HF_PARTS().flatMap((text, i) => [
      hfIn(text, { kind: i % 2 ? 'footer' : 'header' }),
      hfIn(text, { kind: 'header' }, COMPAT14),
      hfIn(hfXml('hdr', `<w:p><w:r><v:shape type="#t"><v:textpath string="DRAFT"/></v:shape></w:r></w:p>${text}`), { kind: 'header' }),
    ]),
  },
  {
    fn: 'parse.readHeaderFooterPart',
    call: async (text, args) => {
      const doc = await docOf(args)
      return internals.readHeaderFooterPart!(
        doc.zip,
        text,
        doc.rels,
        args.kind,
        args.hfType,
        doc.themeColors,
        doc.styles,
        args.compatibilityMode,
        doc.themeFonts,
        resolverOf(doc, args),
        args.sourcePath,
      )
    },
    fromParse: {
      fn: 'readHeaderFooterPart',
      input: ([, documentXml, , kind, hfType, , , compatibilityMode, , , sourcePath], parts) => {
        const kept = partsOf(parts)
        return typeof documentXml === 'string' && kept
          ? { text: documentXml, args: { parts: kept, kind, hfType, compat: { compatibilityMode }, compatibilityMode: compatibilityMode ?? 0, sourcePath: sourcePath ?? 'word/document.xml' } }
          : undefined
      },
    },
    built: (() => {
      const sectRefs = (types: Array<[string, string, string?]>): string =>
        `<w:sectPr>${types.map(([kind, id, type]) => `<w:${kind}Reference r:id="${id}"${type ? ` w:type="${type}"` : ''}/>`).join('')}</w:sectPr>`
      const docs = [
        sectRefs([['header', 'rId1', 'default'], ['footer', 'rId2']]),
        sectRefs([['header', 'rId3', 'even'], ['header', 'rId1', 'odd']]),
        sectRefs([['header', 'rId1']]),
        sectRefs([['header', 'rId404', 'default']]),
        sectRefs([]),
      ]
      const body = hfXml('hdr', HF_BODIES[0]! + HF_BODIES[6]!)
      return docs.flatMap((sectPr) =>
        (['header', 'footer'] as const).flatMap((kind) =>
          (['default', 'first', 'even'] as const).map((hfType) => ({
            text: MINI_DOCUMENT(sectPr),
            args: {
              parts: hfParts(body, hfXml('ftr', HF_BODIES[1]!), [['word/header2.xml', hfXml('hdr', HF_BODIES[2]!)]]),
              compat: COMPAT15,
              compatibilityMode: 15,
              kind,
              hfType,
              sourcePath: 'word/document.xml',
            },
          })),
        ),
      )
    })(),
  },
  {
    fn: 'parse.parseAllHfParts',
    call: async (_text, args) => {
      const doc = await docOf(args)
      return internals.parseAllHfParts!(doc.zip, doc.rels, doc.styles, doc.themeColors, args.compatibilityMode, doc.themeFonts, resolverOf(doc, args), args.sourcePath)
    },
    fromParse: {
      fn: 'parseAllHfParts',
      input: ([, , , , compatibilityMode, , , sourcePath], parts) => {
        const kept = partsOf(parts)
        return kept ? { args: { parts: kept, compat: { compatibilityMode }, compatibilityMode: compatibilityMode ?? 0, sourcePath: sourcePath ?? 'word/document.xml' } } : undefined
      },
    },
    built: [COMPAT15, COMPAT14].flatMap((compat) =>
      [0, 3, 6, 7].map((i) => ({
        args: {
          parts: hfParts(hfXml('hdr', HF_BODIES[i]!), hfXml('ftr', HF_BODIES[i + 1] ?? ''), [['word/header2.xml', hfXml('hdr', HF_BODIES[9]!)]]),
          compat,
          compatibilityMode: compat.compatibilityMode,
          sourcePath: 'word/document.xml',
        },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'parse.hfImages',
    call: async (text, args) => {
      const doc = await docOf(args)
      const paras: unknown[] = []
      if (Array.isArray(args.runImageIds)) weakMaps.hfRunImageIds!.set(paras, new Set(args.runImageIds as string[]))
      const images = (await internals.hfImages!(doc.zip, args.partPath, text, Array.isArray(args.runImageIds) ? paras : undefined)) as object[]
      return { images, anchorIds: images.map((image) => weakMaps.hfImageAnchorId!.get(image) ?? null) }
    },
    fromParse: {
      fn: 'hfImages',
      input: ([, partPath, partXml, paras], parts) => {
        const kept = partsOf(parts)
        const ids = Array.isArray(paras) ? [...((weakMaps.hfRunImageIds!.get(paras) as Set<string> | undefined) ?? [])] : undefined
        return typeof partPath === 'string' && typeof partXml === 'string' && kept
          ? { text: partXml, args: { parts: kept, partPath, ...(ids ? { runImageIds: ids } : {}) } }
          : undefined
      },
    },
    built: HF_PARTS().map((text) => ({ text, args: { parts: hfParts(text, '', [['word/media/logo.png', 'logo bytes']]), partPath: 'word/header1.xml', runImageIds: ['8'] } })),
  },
  {
    fn: 'parse.hfGroupPictures',
    call: async (text, args) => {
      const doc = await docOf(args)
      return internals.hfGroupPictures!(doc.zip, doc.rels, text, args.sourcePath)
    },
    fromParse: {
      fn: 'hfGroupPictures',
      input: ([, rels, frag, sourcePath], parts) => {
        const kept = partsOf(parts)
        return typeof frag === 'string' && kept && rels instanceof Map ? { text: frag, args: { parts: kept, sourcePath: sourcePath ?? 'word/document.xml' } } : undefined
      },
    },
    built: (() => {
      const pic = (off: string, ext: string, extra = ''): string => `<pic:pic><pic:blipFill><a:blip r:embed="rId4"/>${extra}</pic:blipFill><pic:spPr><a:xfrm><a:off ${off}/><a:ext ${ext}/></a:xfrm></pic:spPr></pic:pic>`
      const grp = (inner: string, anchor = '<wp:positionH relativeFrom="page"><wp:posOffset>95250</wp:posOffset></wp:positionH><wp:positionV relativeFrom="margin"><wp:posOffset>190500</wp:posOffset></wp:positionV>', xfrm = '<a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="500000"/>'): string =>
        `<w:drawing><wp:anchor behindDoc="1">${anchor}<wp:wrapNone/><wpg:wgp><wpg:grpSpPr><a:xfrm>${xfrm}</a:xfrm></wpg:grpSpPr>${inner}</wpg:wgp></wp:anchor></w:drawing>`
      return [
        grp(pic('x="0" y="0"', 'cx="500000" cy="250000"') + pic('x="500000" y="250000"', 'cx="500000" cy="250000"', '<a:srcRect l="25000"/>')),
        grp(pic('x="0" y="0"', 'cx="500000" cy="250000"')),
        grp(pic('x="0" y="0"', 'cx="0" cy="250000"')),
        grp(`<pic:pic><pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="5" cy="5"/></a:xfrm></pic:spPr></pic:pic>`),
        grp(pic('x="0" y="0"', 'cx="500000" cy="250000"'), '<wp:positionH relativeFrom="page"><wp:align>left</wp:align></wp:positionH>'),
        grp(pic('x="0" y="0"', 'cx="500000" cy="250000"'), undefined, '<a:off x="5" y="5"/>'),
        grp('<pic:pic><pic:blipFill><a:blip r:embed="rId404"/></pic:blipFill></pic:pic>'),
        grp(''),
      ].map((text) => ({ text, args: { parts: miniParts([['word/media/image1.png', 'picture bytes']]), sourcePath: 'word/document.xml' } }))
    })(),
  },
  {
    fn: 'parse.parseFieldTree',
    call: (text) => {
      const frame = (f: Record<string, unknown>): unknown => ({ ...f, children: (f.children as Array<Record<string, unknown>>).map(frame) })
      return (internals.parseFieldTree!(text) as Array<Record<string, unknown>>).map(frame)
    },
    fromParse: { fn: 'parseFieldTree', input: ([xml]) => (typeof xml === 'string' ? { text: xml } : undefined) },
    built: [PAGE_FLD, NUM_FLD, NESTED_FLD, UNCLOSED_FLD, DATE_FLD + PAGE_FLD, '<w:r><w:fldChar w:fldCharType="end"/></w:r>', '<w:r><w:fldChar w:fldCharType=\'begin\'></w:fldChar></w:r>', '<w:r><w:instrText>stray</w:instrText></w:r>', ''].map((text) => ({ text })),
  },
  // ------------------------------------------------------- inline-opaque.ts
  {
    fn: 'parse.partNamespaces',
    call: (text) => [...partNamespaces(text)],
    built: [
      `<?xml version="1.0"?><w:document xmlns:w="${WNS}" xmlns:w14="${W14}" xml:space="preserve">`,
      `<!-- c --><?pi x?><!DOCTYPE d><w:hdr xmlns:w="${WNS}" a="xmlns:fake:x"/>`,
      '  <w:hdr xmlns:w=\'a&amp;b\' xmlns:w=\'c\' xmlns:v=""/>',
      '<w:hdr xmlns:a="1" xmlns:b="2"',
      '<?xml version="1.0"?>',
      '\uFEFF<w:hdr xmlns:x="u"/>',
      '<w:p/>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.isInlineWrapper',
    call: (_text, args) => isInlineWrapper(args.name as string),
    built: ['w:sdt', 'w:smartTag', 'w:customXml', 'w:dir', 'w:bdo', 'w:r', 'constructor', '__proto__', 'toString', ''].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'parse.inlineWrapPrefixes',
    call: (_text, args) => {
      const prefixes = inlineWrapPrefixes(args.wrap)
      return prefixes === null ? null : [...prefixes].sort()
    },
    built: WRAPS.map((w) => ({ args: { wrap: w } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.validInlineWrap',
    call: (_text, args) => validInlineWrap(args.wrap, entriesOf(args.namespaces)),
    built: WRAPS.flatMap((w) => [
      { args: { wrap: w } },
      { args: { wrap: w, namespaces: [['w', WNS], ['w14', W14]] } },
      { args: { wrap: w, namespaces: [['w', WNS]] } },
    ]),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.rawElements',
    call: (text, args) => {
      const flat = (e: Record<string, unknown>): unknown => ({ ...e, children: (e.children as Array<Record<string, unknown>>).map(flat) })
      return (rawElements(text, args.skipNonElements === true) as unknown as Array<Record<string, unknown>>).map(flat)
    },
    built: [
      '<w:a><w:b x="1>2"/><w:c>t</w:c></w:a>',
      '<w:a><!-- c --><w:b/></w:a>',
      '<w:a><![CDATA[<w:z>]]><w:b/></w:a>',
      '<?xml version="1.0"?><w:a/>',
      '<w:a><w:b></w:a>',
      '</w:a>',
      '<w:a>',
      '<w:a/><w:b/>',
      '<w:a>é<w:b>\u{1F600}</w:b></w:a>',
      '',
    ].flatMap((text) => [{ text }, { text, args: { skipNonElements: true } }]),
  },
  {
    fn: 'parse.inlineWrapperShell',
    call: (text, args) => {
      const node = elementOf(text)
      const shell = inlineWrapperShell(node, args.withSource === true ? inlineRawSource(text, node) : undefined)
      return shell && { open: shell.open, close: shell.close, content: shell.content.map(serializeXNode) }
    },
    built: SHELL_XMLS.flatMap((text) => [{ text }, { text, args: { withSource: true } }]),
  },
  {
    fn: 'parse.sameInlineWrap',
    call: (_text, args) => sameInlineWrap(args.a as never, args.b as never),
    built: [[undefined, undefined], [WRAPS[0], undefined], [WRAPS[0], WRAPS[0]], [WRAPS[0], WRAPS[1]], [WRAPS[0], { ...WRAPS[0], seq: 2 }], [WRAPS[0], { ...WRAPS[0], open: 'x' }], [WRAPS[0], { ...WRAPS[0], close: 'x' }]].map(([a, b]) => ({ args: json({ ...(a ? { a } : {}), ...(b ? { b } : {}) }) })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.inlineWrapKey',
    call: (_text, args) => inlineWrapKey(args.wrap as never),
    built: WRAPS.slice(0, 8).map((wrap) => ({ args: { wrap } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.sameInlineWrapChain',
    call: (_text, args) => sameInlineWrapChain(args.a as never, args.b as never),
    built: [[undefined, undefined], [[], undefined], [[WRAPS[0]], [WRAPS[0]]], [[WRAPS[0], WRAPS[4]], [WRAPS[0], WRAPS[4]]], [[WRAPS[0]], [WRAPS[1]]], [[WRAPS[0]], [WRAPS[0], WRAPS[4]]]].map(([a, b]) => ({ args: json({ ...(a ? { a } : {}), ...(b ? { b } : {}) }) })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.inlineWrapContentLocked',
    call: (_text, args) => inlineWrapContentLocked(args.wrap as never),
    built: WRAPS.map((wrap) => ({ args: { wrap } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.inlineWrapWritesOnce',
    call: (_text, args) => inlineWrapWritesOnce(args.wrap as never),
    built: WRAPS.map((wrap) => ({ args: { wrap } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.sdtFollowsItsText',
    call: (text) => sdtFollowsItsText(text),
    built: WRAPS.map((w) => ({ text: String(w.open) })).concat(['<w:sdt><w:sdtPr><w:dataBinding/></w:sdtPr>', '<w:sdtX><w:showingPlcHdr/>', '<w:sdt>', ''].map((text) => ({ text }))),
  },
  {
    fn: 'parse.inlineWrapTextOf',
    call: (_text, args) => inlineWrapTextOf(args.runs as never, args.from as number | undefined, args.to as number | undefined),
    built: [{ runs: runsIn(0, 1, 2, 3) }, { runs: runsIn(0, 1, 2, 3), from: 1 }, { runs: runsIn(0, 1, 2, 3), from: 1, to: 3 }, { runs: [] }, { runs: runsIn(0), from: 5 }].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.sdtOpenForChangedText',
    call: (text) => sdtOpenForChangedText(text),
    built: [
      '<w:sdt><w:sdtPr><w:showingPlcHdr/><w:dataBinding w:xpath="/a" w:storeItemID="{1}"/></w:sdtPr><w:sdtContent>',
      '<w:sdt><w:sdtPr><w:showingPlcHdr w:val="1"></w:showingPlcHdr><w15:dataBinding x="&gt;"/></w:sdtPr>',
      '<w:sdt><w:sdtPr><w:dataBindingX/><w:showingPlcHdr>text</w:showingPlcHdr></w:sdtPr>',
      '<w:sdt><w:sdtPr><w:tag w:val="a"/></w:sdtPr>',
      '<w:showingPlcHdr/><w:showingPlcHdr/>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'parse.placeInlineWraps',
    call: (_text, args) => placeInlineWraps(args.runs as never, REV_KEY),
    built: [
      { runs: runsIn(3, 3) },
      { runs: runsIn(0, 3, 3, 0) },
      { runs: runsIn(4, 4, 3) },
      { runs: runsIn(5, 5) },
      { runs: runsIn(6, 6, 7) },
      { runs: runsIn(6, 7, 6) },
      { runs: runsIn(9, 9, 5) },
      { runs: runsIn(10, 3, 10) },
      { runs: runsIn(0, 1, 2) },
      { runs: [] },
    ].map((args) => ({ args })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.runCopiedElsewhere',
    call: (_text, args) => runCopiedElsewhere(args.run as never),
    built: RUNS.map((run) => ({ args: { run } })).concat([{ args: { run: { text: 'k', wrap: [wrap(), wrap({ open: '<w:dir w:val="rtl">', close: '</w:dir>' })], ins: { author: 'a' } } } }, { args: { run: { text: 'z', wrap: [wrap()], link: { href: 'h' } } } }]),
    mutation: 'none',
    argMutation: true,
  },
]

export const PARSE_TABLES: CallSpec[] = [...WAVE0, ...BATCH2]
