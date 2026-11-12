// Group `decktext` of comparison (f): index.ts lines 2906-3721 of
// packages/pptx-engine (charts, hidden/name, fonts, find/replace, paragraph
// format). The Rust side answers in crates/office-wasm/src/calls/pptx_decktext.rs
// to `pptxDecktext.index.<TypeScript name>`.
//
// Private functions are proven through the export that reaches them:
//   patchOwnCNvPrAttr    setElementHidden, setElementName
//   escapeRegex          editChartElement (a relationship id with regex metacharacters
//                        and a decoy id the unescaped pattern would take)
//   applyFontPatch       setElementFont
//   escapeRegExp         replaceAllInDeck (find texts with metacharacters)
//   mergePPrDirty        setElementParagraphFormat (`then`: a second patch on the same element)
//
// FontSizeMap is a function argument: the gate gives both sides the stand-in
// GATE_SIZE_MAP, `(pt) => (pt ?? 18) + 2`, where `args.sizeStep` is true.
import JSZip from 'jszip'
import { createBlankPptx } from '../../packages/pptx-engine/src/blank'
import { buildChartSpaceXml, type NewChartOptions } from '../../packages/pptx-engine/src/chart-insert'
import { chartWorkbookXlsx } from '../../packages/pptx-engine/src/chart-workbook'
import {
  applyParagraphFormat,
  editChartElement,
  getChartElementData,
  markChartEditable,
  replaceAllInDeck,
  setElementFont,
  setElementHidden,
  setElementName,
  setElementParagraphFormat,
  setGroupChildParagraphFormat,
  type ElementFontPatch,
  type FontSizeMap,
  type ParagraphFormatPatch,
  type ReplaceOptions,
} from '../../packages/pptx-engine/src/index'
import type { GroupElement } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckInput, deckOp } from './deck-ops'

/** The fixed stand-in for a caller's FontSizeMap (`fontSizeStep` of the ops layer). */
const GATE_SIZE_MAP: FontSizeMap = (pt) => (pt ?? 18) + 2

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SLIDE_PART = 'ppt/slides/slide1.xml'

// ── The deck: one slide of text, a table, a group and eleven charts ──────

const XFRM = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>'

/** A run; `props` are attributes of its a:rPr. */
const run = (text: string, props = ''): string =>
  `<a:r><a:rPr lang="en-US"${props}/><a:t>${text}</a:t></a:r>`

const para = (pPr: string, ...inner: string[]): string => `<a:p>${pPr}${inner.join('')}</a:p>`

/** A shape; `paragraphs` undefined = no a:txBody. `cNvPr` replaces the whole a:cNvPr tag. */
const sp = (id: number, name: string, paragraphs?: string, cNvPr?: string): string =>
  `<p:sp><p:nvSpPr>${cNvPr ?? `<p:cNvPr id="${id}" name="${name}"/>`}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${XFRM}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  (paragraphs === undefined
    ? ''
    : `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`) +
  '</p:sp>'

const TEXT_A = sp(
  2,
  'Text A',
  para(
    '<a:pPr marL="285750" indent="-285750"><a:buClr><a:srgbClr val="FF0000"/></a:buClr>' +
      '<a:buSzPct val="80000"/><a:buFont typeface="Wingdings"/><a:buChar char="&#167;"/></a:pPr>',
    run('Hello wor'),
    run('ld ', ' b="1"'),
    run('hello'),
  ) +
    para(
      '<a:pPr rtl="1"/>',
      run('a.b*c'),
      run('[x] (y)'),
      '<a:br/>',
      run('$&amp; \u{1F600} \u00DCn\u00EF \u00DF \u017F K\u212A'),
    ) +
    para(
      '<a:pPr lvl="1" algn="ctr"/>',
      '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>\u2039#\u203A</a:t></a:fld>',
      run('tail Hello'),
    ) +
    para(
      '<a:pPr><a:buAutoNum type="arabicParenR" startAt="3"/></a:pPr>',
      run('numbered one', ' sz="2400" i="1" u="sng" strike="sngStrike"'),
    ) +
    para(
      '<a:pPr marL="342900" indent="-342900"><a:lnSpc><a:spcPct val="150000"/></a:lnSpc>' +
        '<a:spcBef><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPct val="20000"/></a:spcAft>' +
        '<a:buNone/></a:pPr>',
      run('spaced \u{1F600}\u{1F600}'),
    ) +
    para('', run('plain Hello')),
)
const TEXT_B = sp(3, 'Empty', '<a:p/>')
const RECT = sp(4, 'Rect')

const cell = (inner: string, attrs = ''): string =>
  `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${inner}</a:txBody><a:tcPr/></a:tc>`
const TABLE =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Table 10"/>' +
  '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
  `<p:xfrm><a:off x="0" y="0"/><a:ext cx="200" cy="100"/></p:xfrm><a:graphic>` +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>' +
  '<a:tblGrid><a:gridCol w="100"/><a:gridCol w="100"/></a:tblGrid>' +
  `<a:tr h="100">${cell(para('', run('Hello cell'), run(' & more hello')), ' gridSpan="2"')}${cell('<a:p/>', ' hMerge="1"')}</a:tr>` +
  `<a:tr h="100">${cell(para('<a:pPr algn="r"/>', run('x Hello')))}${cell('<a:p/>')}</a:tr>` +
  '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

const GROUP =
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Group 20"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="200" cy="100"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="200" cy="100"/></a:xfrm></p:grpSpPr>' +
  sp(
    21,
    'Child text',
    para('<a:pPr marL="285750" indent="-285750"><a:buChar char="x"/></a:pPr>', run('child Hello')) +
      para('', run('second Hello')),
  ) +
  sp(22, 'Child rect') +
  sp(23, 'Child empty', '<a:p/>') +
  '</p:grpSp>'

interface ChartSpec {
  /** The r:id of the frame (and the Id of the relationship) */
  rid: string
  descr: string | null
  /** The a:cNvPr as written (no descr attribute is added) */
  cNvPr?: string
  opts: Partial<NewChartOptions> & Pick<NewChartOptions, 'kind' | 'categories' | 'series'>
  /** Chart part relationships written beside it, and the externalData id the part names */
  external?: { id: string; rel: string } | null
  /** The legend position the part is rewritten to (`legendPos val`) */
  legend?: string
}

const BASE_SERIES = [
  { name: 'North', values: [1, 2, 3] },
  { name: 'South & East', values: [4, 5, 6] },
]
const CATS = ['Q1', 'Q2', 'Q3']

const WORKBOOK_REL = `${REL}/package`
const CHARTS: ChartSpec[] = [
  {
    rid: 'rIdC0',
    descr: 'aislides-chart',
    opts: {
      kind: 'bar',
      title: 'Sales',
      categories: CATS,
      series: BASE_SERIES,
      legendPos: 'r',
      dataLabels: true,
      gridlines: true,
      catAxisTitle: 'Quarter',
      valAxisTitle: 'Units',
      gapWidthPct: 80,
      colorScheme: ['#FF0000', '#00FF00'],
      pointColors: [[undefined, '#0000FF']],
    },
    external: {
      id: 'rId1',
      rel: `<Relationship Id="rId1" Type="${WORKBOOK_REL}" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>`,
    },
    legend: 'tr',
  },
  {
    rid: 'rIdC1',
    descr: 'aislides-chart',
    opts: { kind: 'doughnut', title: 'Share', categories: CATS, series: [BASE_SERIES[0]!], holeSizePct: 60 },
  },
  {
    // the id carries regex metacharacters: a decoy relationship precedes the real one
    rid: 'r.I+d(2)',
    descr: 'aislides-chart',
    opts: {
      kind: 'comboBarLine',
      categories: CATS,
      series: [...BASE_SERIES, { name: 'Line', values: [7, 8, 9] }],
      dataLabels: true,
    },
    external: {
      id: 'rId1',
      rel: `<Relationship Id="rId1" Type="${WORKBOOK_REL}" Target="file:///x.xlsx" TargetMode="External"/>`,
    },
  },
  {
    rid: 'rIdC3',
    descr: 'aislides-chart',
    opts: { kind: 'bar', barDir: 'bar', categories: CATS, series: BASE_SERIES, legendPos: 'none' },
    // names an externalData id the relationships do not have
    external: { id: 'rId1', rel: '' },
  },
  {
    rid: 'rIdC4',
    descr: 'aislides-chart',
    opts: { kind: 'pie3D', title: 'Pie', categories: CATS, series: [BASE_SERIES[1]!] },
  },
  {
    rid: 'rIdC5',
    descr: 'aislides-chart',
    opts: { kind: 'bar3D', categories: CATS, series: BASE_SERIES, legendPos: 't' },
    external: {
      id: 'rId1',
      rel: `<Relationship Id="rId1" Type="${REL}/oleObject" Target="../embeddings/oleObject1.bin"/>`,
    },
  },
  {
    rid: 'rIdC6',
    descr: 'aislides-chart',
    opts: {
      kind: 'barStacked',
      categories: CATS,
      series: [...BASE_SERIES, { name: '', values: [1, 1, 1] }],
      gapWidthPct: 20,
    },
  },
  {
    rid: 'rIdC7',
    descr: 'aislides-chart',
    opts: { kind: 'scatter', categories: ['1', '2.5', 'x'], series: BASE_SERIES },
  },
  {
    // not created by this app, a start tag with children rewritten to an open tag
    rid: 'rIdC8',
    descr: null,
    cNvPr: '<p:cNvPr id="38" name="Chart 38"></p:cNvPr>',
    opts: { kind: 'area', categories: CATS, series: BASE_SERIES },
  },
  {
    rid: 'rIdC9',
    descr: 'alt $& text',
    opts: { kind: 'line', categories: CATS, series: BASE_SERIES },
  },
  {
    rid: 'rIdC10',
    descr: 'aislides-chart',
    opts: { kind: 'radar', categories: [], series: [] },
  },
]

const frame = (c: ChartSpec, i: number): string =>
  '<p:graphicFrame><p:nvGraphicFramePr>' +
  (c.cNvPr ??
    `<p:cNvPr id="${30 + i}" name="Chart ${30 + i}"${c.descr === null ? '' : ` descr="${c.descr}"`}/>`) +
  '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  `<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${c.rid}"/>` +
  '</a:graphicData></a:graphic></p:graphicFrame>'

/** `name="a>b"`: the cNvPr ends at the first `>`. */
const GT_NAME = sp(40, 'a>b', '<a:p/>', '<p:cNvPr id="40" name="a>b"/>')
const OPEN_TAG = sp(41, 'x', '<a:p/>', '<p:cNvPr id="41" name="x"></p:cNvPr>')
const HIDDEN = sp(42, 'Hidden', para('', run('hidden Hello')), '<p:cNvPr id="42" name="Hidden" hidden="1"/>')

/** The element indexes of the slide. */
const EL = {
  text: 0,
  empty: 1,
  rect: 2,
  table: 3,
  group: 4,
  chart: (i: number) => 5 + i,
  gtName: 5 + CHARTS.length,
  openTag: 6 + CHARTS.length,
  hidden: 7 + CHARTS.length,
}

const slideXml = (shapes: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${NS}><p:cSld><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`

const SLIDE_SHAPES = (frames: string[] = CHARTS.map(frame)): string =>
  TEXT_A + TEXT_B + RECT + TABLE + GROUP + frames.join('') + GT_NAME + OPEN_TAG + HIDDEN
const SLIDE_XML = slideXml(SLIDE_SHAPES())

/** The blank deck with the charts, their workbooks and relationships added. */
async function richDeck(): Promise<string> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const relsPath = 'ppt/slides/_rels/slide1.xml.rels'
  const slideRels: string[] = []
  CHARTS.forEach((c, i) => {
    const n = i + 1
    if (c.rid === 'r.I+d(2)') {
      slideRels.push(
        `<Relationship Id="rIId2" Type="${REL}/chart" Target="../charts/chart99.xml"/>`,
      )
    }
    slideRels.push(`<Relationship Id="${c.rid}" Type="${REL}/chart" Target="../charts/chart${n}.xml"/>`)
    let xml = buildChartSpaceXml(
      { offset: { x: 0, y: 0, cx: 0, cy: 0 }, ...c.opts },
      c.external?.id,
    )
    if (c.legend) xml = xml.replace(/<c:legendPos val="[^"]*"\/>/, `<c:legendPos val="${c.legend}"/>`)
    zip.file(`ppt/charts/chart${n}.xml`, xml)
    if (c.external && c.external.rel) {
      zip.file(
        `ppt/charts/_rels/chart${n}.xml.rels`,
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${c.external.rel}</Relationships>`,
      )
    }
  })
  zip.file(
    'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx',
    chartWorkbookXlsx({ categories: CATS, series: BASE_SERIES }),
  )
  const rels = (await zip.file(relsPath)!.async('string')).replace(
    '</Relationships>',
    `${slideRels.join('')}</Relationships>`,
  )
  zip.file(relsPath, rels)
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).toString(
    'base64',
  )
}

const DECK = await richDeck()

/** An input on the deck above; `text` is the slide the deck opens with. */
const on = (rest: Record<string, unknown>, text = SLIDE_XML): Input => ({
  text,
  args: { deck: DECK, textPart: SLIDE_PART, ...rest },
})
const onElement = (element: number, rest: Record<string, unknown> = {}): Input =>
  on({ slide: 0, element, ...rest })

/** An input on the blank deck, whose only slide has no element. */
const blank = (rest: Record<string, unknown>): Input => deckInput('blank deck', { slide: 0, element: 0, ...rest })

const CHART_ELEMENTS = CHARTS.map((_, i) => EL.chart(i))

// ── editChartElement ────────────────────────────────────────────────────

const CHART_PATCHES: Array<Record<string, unknown>> = [
  {},
  { title: 'Renamed' },
  { title: '' },
  { kind: 'line' },
  { kind: 'area' },
  { kind: 'pie' },
  { kind: 'doughnut', holeSizePct: 75 },
  { kind: 'bar', barDir: 'bar' },
  { kind: 'bar' },
  { kind: 'barStacked' },
  { kind: 'barPercentStacked' },
  { kind: 'scatter' },
  { kind: 'radar' },
  { kind: 'comboBarLine' },
  { kind: 'pie3D' },
  { kind: 'bar3D', barDir: 'bar' },
  { barDir: 'bar' },
  { categories: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }] },
  { categories: ['only'] },
  { series: [{ name: 'One', values: [10, 20, 30] }] },
  { categories: [], series: [] },
  { switchRowCol: true },
  { switchRowCol: true, categories: ['x', 'y'] },
  { pointColors: { 0: { 1: '#112233', 2: null }, 1: { 0: '#445566' } } },
  { pointColors: { 0: { 0: null, 1: null } } },
  { pointColors: { 3: { 4: '#778899' } } },
  { pointColors: { x: { 1: '#aabbcc' }, '1.5': { 0: '#001122' }, '': { 2: '#334455' } } },
  { switchRowCol: true, pointColors: { 0: { 0: '#abcdef' } } },
  { colorScheme: ['#aabbcc'] },
  { colorScheme: [] },
  { legendPos: 't' },
  { legendPos: 'l' },
  { legendPos: 'none' },
  { dataLabels: false },
  { dataLabels: true },
  { gridlines: true },
  { gridlines: false },
  { catAxisTitle: '', valAxisTitle: 'Values' },
  { catAxisTitle: 'Cats', valAxisTitle: '' },
  { gapWidthPct: 40 },
  { holeSizePct: 30 },
  { title: 'All', legendPos: 'b', dataLabels: true, gridlines: true, gapWidthPct: 55, catAxisTitle: 'x', valAxisTitle: 'y', colorScheme: ['#010203', '#040506', '#070809'] },
]

const EDIT_CHART_INPUTS: Input[] = [
  // every chart with the empty patch: the existing style survives the rebuild
  ...CHART_ELEMENTS.map((e) => onElement(e, { patch: {} })),
  // the patches on the charts a rebuild reads differently
  ...CHART_PATCHES.flatMap((patch) => [0, 1, 2, 3].map((i) => onElement(EL.chart(i), { patch }))),
  ...CHART_PATCHES.slice(0, 20).flatMap((patch) =>
    [4, 5, 6, 7, 10].map((i) => onElement(EL.chart(i), { patch })),
  ),
  // not an editable chart, not a chart, no element, no slide
  onElement(EL.chart(8), { patch: { title: 'x' } }),
  onElement(EL.chart(9), { patch: { title: 'x' } }),
  onElement(EL.text, { patch: { title: 'x' } }),
  onElement(EL.table, { patch: {} }),
  onElement(99, { patch: {} }),
  on({ slide: 3, element: 0, patch: {} }),
  // a frame without an r:id, a relationship the slide lacks, a slide without relationships
  on(
    { slide: 0, element: EL.chart(0), patch: {} },
    SLIDE_XML.replace(/ r:id="rIdC0"/, ''),
  ),
  on(
    { slide: 0, element: EL.chart(0), patch: {} },
    SLIDE_XML.replace('r:id="rIdC0"', 'r:id="rIdMissing"'),
  ),
  on(
    { slide: 0, element: EL.chart(0), patch: {} },
    SLIDE_XML.replace('r:id="rIdC0"', "r:id='rIdC0'"),
  ),
  // a patch on the blank deck: no chart there
  blank({ patch: { title: 't' } }),
  // a series index no sane patch reaches: refused rather than allocated
  onElement(EL.chart(0), { patch: { pointColors: { 70000: { 0: '#000000' } } } }),
]

// ── markChartEditable ───────────────────────────────────────────────────

const MARK_INPUTS: Input[] = [
  ...CHART_ELEMENTS.map((e) => onElement(e)),
  onElement(EL.text),
  onElement(EL.table),
  onElement(99),
  blank({}),
  // the chart frame has no cNvPr at all
  on(
    { slide: 0, element: EL.chart(8) },
    SLIDE_XML.replace('<p:cNvPr id="38" name="Chart 38"></p:cNvPr>', ''),
  ),
  // descr is the first attribute, a space before the close, an empty descr
  on(
    { slide: 0, element: EL.chart(8) },
    SLIDE_XML.replace('<p:cNvPr id="38" name="Chart 38"></p:cNvPr>', '<p:cNvPr descr="" id="38" name="Chart 38" />'),
  ),
  on(
    { slide: 0, element: EL.chart(8) },
    SLIDE_XML.replace('<p:cNvPr id="38" name="Chart 38"></p:cNvPr>', '<p:cNvPr id="38" name="a>b"/>'),
  ),
]

// ── setElementHidden / setElementName (patchOwnCNvPrAttr) ───────────────

const OWN_CNVPR_ELEMENTS = [
  EL.text,
  EL.empty,
  EL.rect,
  EL.table,
  EL.group,
  EL.chart(0),
  EL.chart(8),
  EL.gtName,
  EL.openTag,
  EL.hidden,
  99,
]

const HIDDEN_INPUTS: Input[] = [
  ...OWN_CNVPR_ELEMENTS.flatMap((e) => [onElement(e, { hidden: true }), onElement(e, { hidden: false })]),
  blank({ hidden: true }),
  // single quotes, no name, hidden already in the tag, tag closed with a space
  on(
    { slide: 0, element: 0, hidden: true },
    slideXml(sp(2, 'q', '<a:p/>', "<p:cNvPr id='2' name='q'/>")),
  ),
  on(
    { slide: 0, element: 0, hidden: true },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" />')),
  ),
  on(
    { slide: 0, element: 0, hidden: false },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" hidden="1" name="q">'  + '</p:cNvPr>')),
  ),
  on(
    { slide: 0, element: 0, hidden: false },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" xhidden="1" data-hidden="1"/>')),
  ),
  on(
    { slide: 0, element: 0, hidden: true },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2"   >' + '</p:cNvPr>')),
  ),
  // a group: its own cNvPr precedes its children's
  onElement(EL.group, { hidden: true }),
]

const NAMES = ['Renamed', 'a"b<c>&d', '\u{1F600} \u00DCn\u00EF', '', 'x\ny', "it's"]
const DOLLAR_NAMES = ['$&', '$1x', '$$', "$'", 'a$`b']

const NAME_INPUTS: Input[] = [
  ...OWN_CNVPR_ELEMENTS.flatMap((e) => NAMES.slice(0, 3).map((name) => onElement(e, { name }))),
  ...[EL.text, EL.group, EL.chart(0), EL.gtName].flatMap((e) => NAMES.slice(3).map((name) => onElement(e, { name }))),
  blank({ name: 'n' }),
  // no name attribute, single-quoted name, a name attribute that is a suffix of another
  on(
    { slide: 0, element: 0, name: 'Added' },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" />')),
  ),
  on(
    { slide: 0, element: 0, name: 'Added' },
    slideXml(sp(2, 'q', '<a:p/>', "<p:cNvPr id='2' name='q'/>")),
  ),
  on(
    { slide: 0, element: 0, name: 'Added' },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" data-name="d" name="q"/>')),
  ),
  on(
    { slide: 0, element: 0, name: 'Added' },
    slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" data-name="d"/>')),
  ),
  // the same name again: the bytes stay as they are
  on({ slide: 0, element: 0, name: 'Same' }, slideXml(sp(2, 'Same', '<a:p/>'))),
  // ledger cnvpr-attr-dollar: the TypeScript puts the name into a replacement string, `$&` expands
  ...DOLLAR_NAMES.flatMap((name) =>
    [EL.text, EL.gtName, EL.group].map((e): Input => ({ ...onElement(e, { name }), seed: false })),
  ),
  ...DOLLAR_NAMES.map((name): Input => ({
    ...on(
      { slide: 0, element: 0, name },
      slideXml(sp(2, 'q', '<a:p/>', '<p:cNvPr id="2" />')),
    ),
    seed: false,
  })),
]

// ── getChartElementData ─────────────────────────────────────────────────

const DATA_INPUTS: Input[] = [
  ...CHART_ELEMENTS.map((e) => onElement(e)),
  onElement(EL.text),
  onElement(EL.table),
  onElement(99),
  blank({}),
]

// ── setElementFont (applyFontPatch) ─────────────────────────────────────

const FONT_PATCHES: Array<Record<string, unknown>> = [
  { fontFamily: 'Arial' },
  { fontFamily: '' },
  { fontSizePt: 32 },
  { fontSizePt: 0 },
  { strike: true },
  { strike: false },
  { bold: true },
  { bold: false },
  { italic: true },
  { italic: false },
  { underline: true },
  { underline: false },
  { color: '#336699' },
  { color: '' },
  { highlight: '#FFFF00' },
  { highlight: null },
  { highlight: '' },
  { letterSpacingPt: 2.5 },
  { letterSpacingPt: -1 },
  { letterSpacingPt: 0 },
  { letterSpacingPt: null },
  {},
  {
    fontFamily: 'Segoe UI',
    fontSizePt: 14,
    strike: true,
    bold: true,
    italic: true,
    underline: true,
    color: '#abcdef',
    highlight: '#00ff00',
    letterSpacingPt: 3,
  },
  {
    strike: false,
    underline: false,
    bold: false,
    italic: false,
    highlight: null,
    letterSpacingPt: null,
  },
]

const FONT_ELEMENTS = [EL.text, EL.empty, EL.table, EL.rect, EL.group, EL.chart(0), 99]

const FONT_INPUTS: Input[] = [
  ...FONT_PATCHES.flatMap((patch) => [EL.text, EL.empty, EL.table].map((e) => onElement(e, { patch }))),
  ...FONT_ELEMENTS.slice(3).map((e) => onElement(e, { patch: { bold: true } })),
  // the stand-in size map: with and without a size in the patch
  ...[EL.text, EL.empty, EL.table, EL.rect, EL.group].map((e) => onElement(e, { patch: {}, sizeStep: true })),
  onElement(EL.text, { patch: { fontSizePt: 40, bold: true }, sizeStep: true }),
  onElement(EL.table, { patch: { fontFamily: 'Calibri' }, sizeStep: true }),
  blank({ patch: { bold: true } }),
  // a shape whose text body has no paragraph
  on(
    { slide: 0, element: 0, patch: { bold: true } },
    slideXml(sp(2, 'n', '')),
  ),
  // a run that already carries a size, and a table whose cell has no a:txBody span to edit
  on(
    { slide: 0, element: 0, patch: { fontSizePt: 11 }, sizeStep: true },
    slideXml(sp(2, 'n', para('', run('a', ' sz="1000"'), run('b')))),
  ),
]

// ── replaceAllInDeck (escapeRegExp) ─────────────────────────────────────

const REPLACE_CASES: Array<[string, string, Record<string, unknown>]> = [
  ['Hello', 'World', {}],
  ['Hello', 'World', { matchCase: true }],
  ['hello', 'X', {}],
  ['hello', 'X', { matchCase: true }],
  ['Hello', 'World', { firstOnly: true }],
  ['hello', 'X', { firstOnly: true, matchCase: true }],
  ['o w', '_', {}],
  ['world', 'W', {}],
  ['lo wor', 'LO', { matchCase: true }],
  ['d hel', 'D', {}],
  ['ld ', '', {}],
  ['Hello', '', {}],
  ['Hello wor', 'one two three', { firstOnly: true }],
  // regex metacharacters in the search text
  ['a.b*c', 'dot', {}],
  ['a.b', 'dot', {}],
  ['.*', 'all', {}],
  ['[x] (y)', 'br', {}],
  ['[x]', 'br', {}],
  ['(y)', 'par', {}],
  ['^', 'caret', {}],
  ['$', 'dollar', {}],
  ['a|b', 'bar', {}],
  ['\\', 'slash', {}],
  ['{1}', 'brace', {}],
  ['+', 'plus', {}],
  ['?', 'q', {}],
  // replacement strings are literal
  ['Hello', '$&', {}],
  ['Hello', '$1', {}],
  ['Hello', '$$', {}],
  ['Hello', "$'", {}],
  ['Hello', '$`', {}],
  ['Hello', '$<x>', {}],
  ['$&', '$&$&', {}],
  ['$', '$', {}],
  // case options on non-ASCII letters, non-BMP text and special casing
  ['\u00DCN\u00CF', 'umlaut', {}],
  ['\u00DCN\u00CF', 'umlaut', { matchCase: true }],
  ['\u00FCn\u00EF', 'umlaut', {}],
  ['\u00DF', 'sharp', {}],
  ['SS', 'ss', {}],
  ['ss', 'ss', {}],
  ['\u017F', 'long s', {}],
  ['S', 'S', { firstOnly: true }],
  ['K\u212A', 'kelvin', {}],
  ['k\u212A', 'kelvin', {}],
  ['\u212A', 'kelvin', {}],
  ['\u{1F600}', 'smile', {}],
  ['\u{1F600}\u{1F600}', 'two', {}],
  ['x', '\u{1F600}', {}],
  ['spaced \u{1F600}', '\u{1F600}\u{1F600}\u{1F600}', {}],
  ['\u{1F600}', '', { firstOnly: true }],
  ['\uD55C\uAE00', 'korean', {}],
  // barriers: a field run and a soft break stop a match
  [')$&', 'barrier', {}],
  ['\u2039#\u203Atail', 'barrier', {}],
  ['tail Hello', 'T', {}],
  ['\n', 'nl', {}],
  ['y)', 'Y', {}],
  // table cells, group children
  ['x Hello', 'cell', {}],
  ['cell', 'C', {}],
  ['child Hello', 'child', {}],
  ['second', '2nd', {}],
  [' & more hello', '', { matchCase: true }],
  // nothing to find, nothing to replace
  ['', 'x', {}],
  ['absent', 'x', {}],
]

/** `scope`: a slide, an element of it (by index), as `opts.slideIndex` and `opts.elementId`. */
const SCOPES: Array<Record<string, unknown>> = [
  {},
  { slideIndex: 0 },
  { slideIndex: 1 },
  { slideIndex: 0, elementAt: EL.text },
  { elementAt: EL.table },
  { elementAt: EL.group },
  { elementAt: EL.rect },
  { elementAt: 99 },
  { slideIndex: 0, elementAt: EL.hidden },
]

const REPLACE_INPUTS: Input[] = [
  ...REPLACE_CASES.map(([find, replace, opts]) => on({ find, replace, opts })),
  ...SCOPES.flatMap((scope) =>
    [
      ['Hello', 'World', {}],
      ['hello', 'X', { firstOnly: true }],
      ['o', '0', { matchCase: true }],
      ['\u{1F600}', 'x', {}],
    ].map(([find, replace, opts]) =>
      on({ find, replace, opts: { ...(opts as object), ...scope } }),
    ),
  ),
  // two slides
  deckInput('pptxgenjs text, shape, table and two slides', {
    find: 'A',
    replace: 'Z',
    opts: {},
  }),
  deckInput('pptxgenjs text, shape, table and two slides', {
    find: 'Second',
    replace: '2nd',
    opts: { slideIndex: 1 },
  }),
  deckInput('pptxgenjs text, shape, table and two slides', {
    find: 'a',
    replace: '\u{1F600}',
    opts: { firstOnly: true },
  }),
  deckInput('pptxgenjs text, shape, table and two slides', {
    find: '2026 & <text>',
    replace: '$&',
    opts: {},
  }),
  blank({ find: 'a', replace: 'b', opts: {} }),
]

// ── applyParagraphFormat / setElementParagraphFormat (mergePPrDirty) ────

const PARAGRAPH_PATCHES: Array<Record<string, unknown>> = [
  { bullet: 'char' },
  { bullet: 'char', bulletChar: '-' },
  { bullet: 'char', bulletChar: '\u00A7', bulletFont: 'Wingdings' },
  { bullet: 'char', bulletFont: 'Arial' },
  { bullet: 'char', bulletChar: '', bulletFont: 'Arial' },
  { bullet: 'number' },
  { bullet: 'number', numType: 'romanUcPeriod', startAt: 4 },
  { bullet: 'number', startAt: 0 },
  { bullet: 'blip', bulletBlip: { mediaRef: 'ppt/media/image1.png', blipEmbedId: 'rId9' } },
  { bullet: 'blip', bulletBlip: { blipEmbedId: 'rId9', mediaRef: 'ppt/media/image1.png' } },
  { bullet: 'blip' },
  { bullet: 'none' },
  { bullet: '' },
  { bullet: 'char', bulletHangEmu: 400000 },
  { bullet: 'char', bulletHangEmu: 0 },
  { numType: 'alphaLcPeriod' },
  { startAt: 7 },
  { numType: 'arabicPlain', startAt: 2 },
  { bulletHangEmu: 100000 },
  { bulletHangEmu: 0 },
  { bulletSizePct: 150 },
  { bulletSizePct: 0 },
  { bulletColor: '#00FF00' },
  { bulletColor: '' },
  { bulletSizePct: 50, bulletColor: '#123456' },
  { lineSpacingPct: 120 },
  { lineSpacingPct: 0 },
  { spaceBeforePt: 12 },
  { spaceAfterPt: 6 },
  { spaceBeforePt: 0, spaceAfterPt: 0 },
  { align: 'left' },
  { align: 'center' },
  { align: 'right' },
  { align: 'justify' },
  { rtl: true },
  { rtl: false },
  { indentDelta: 1 },
  { indentDelta: -1 },
  { indentDelta: 0 },
  {},
  {
    bullet: 'char',
    lineSpacingPct: 90,
    spaceBeforePt: 3,
    spaceAfterPt: 4,
    align: 'right',
    rtl: true,
    indentDelta: 1,
  },
  { indentDelta: 1, bullet: 'number', numType: 'arabicPeriod' },
]

/** Paragraphs as a parsed model gives them: plain, bulleted, hanging, deep, numbered, spaced. */
const MODEL_PARAGRAPHS = [
  [{ runs: [{ text: 'plain' }] }],
  [{ runs: [], pPrExplicit: { align: true } }],
  [
    {
      runs: [{ text: 'bullet' }],
      pPrExplicit: {},
      level: 1,
      marL: 285750,
      indent: -285750,
      bullet: { type: 'char', char: 'x', color: '#FF0000', colorNodeXml: '<a:schemeClr val="accent1"/>', sizePct: 80, font: 'Wingdings' },
    },
    {
      runs: [{ text: 'numbered' }],
      pPrExplicit: { bullet: true, marL: true, indent: true },
      level: 3,
      marL: 1000000,
      indent: -250000,
      bullet: { type: 'number', numType: 'romanLcPeriod', startAt: 5, sizePt: 12 },
    },
    {
      runs: [{ text: 'none' }],
      pPrExplicit: { marL: true },
      marL: 100,
      indent: 0,
      bullet: { type: 'none' },
      lineHeight: 110,
      lineExact: 20,
      spaceBefore: 1,
      spaceBeforePct: 10,
      spaceAfter: 2,
      spaceAfterPct: 20,
    },
  ],
  [
    {
      runs: [{ text: 'deep' }],
      level: 8,
      marL: 8,
      indent: -4,
      pPrExplicit: { marL: true },
      bullet: { type: 'blip', mediaRef: 'm', blipEmbedId: 'r' },
    },
    { runs: [{ text: 'top' }], level: 0, indent: 5, bullet: { type: 'number' } },
    { runs: [{ text: 'bare' }], bullet: { type: 'char', char: 'y' }, indent: -1 },
  ],
]

const APPLY_PARAGRAPH_INPUTS: Input[] = [
  ...PARAGRAPH_PATCHES.flatMap((patch) =>
    MODEL_PARAGRAPHS.map((paragraphs): Input => ({ args: { paragraphs, patch } })),
  ),
  { args: { paragraphs: [], patch: { bullet: 'char' } } },
]

const PARAGRAPH_INDICES: Array<number[] | null> = [
  null,
  [0],
  [1, 3],
  [0, 0],
  [2, 99, -1, 1.5],
  [99],
  [],
  [0, 2, 0],
  [-0, 0],
]

const SET_PARAGRAPH_INPUTS: Input[] = [
  ...PARAGRAPH_PATCHES.flatMap((patch) =>
    [EL.text, EL.empty, EL.table, EL.group, EL.rect, EL.chart(0)].map((e) => onElement(e, { patch })),
  ),
  ...PARAGRAPH_INDICES.flatMap((paraIndices) =>
    [
      { bullet: 'char' },
      { bullet: 'number' },
      { align: 'center', indentDelta: 1 },
      { lineSpacingPct: 130 },
      { indentDelta: 1 },
      {},
    ].map((patch) => onElement(EL.text, { patch, paraIndices })),
  ),
  // dirtyPPr accumulates: a second patch merges into the first (paraIndices stay restricted
  // only while every operation was)
  ...[
    [null, null],
    [[0], null],
    [null, [1]],
    [[0], [1]],
    [[0, 1], [1, 2]],
    [[-0], [0]],
    [[1], [1]],
  ].flatMap(([first, second]) =>
    [
      [{ bullet: 'char' }, { align: 'right' }],
      [{ align: 'right' }, { bullet: 'number' }],
      [{ lineSpacingPct: 100 }, { lineSpacingPct: 150 }],
      [{ bullet: 'none' }, { indentDelta: 1 }],
    ].map(([patch, then]) => onElement(EL.text, { patch, paraIndices: first, then, thenIndices: second })),
  ),
  blank({ patch: { bullet: 'char' } }),
  on(
    { slide: 0, element: 0, patch: { bullet: 'char' } },
    slideXml(sp(2, 'n', '')),
  ),
]

// ── setGroupChildParagraphFormat ────────────────────────────────────────

const GROUP_CHILD_INPUTS: Input[] = [
  ...PARAGRAPH_PATCHES.flatMap((patch) =>
    [0, 1, 2].map((child) => onElement(EL.group, { patch, child })),
  ),
  ...PARAGRAPH_INDICES.flatMap((paraIndices) =>
    [{ bullet: 'char' }, { align: 'center' }, { indentDelta: 1 }, {}].map((patch) =>
      onElement(EL.group, { patch, child: 0, paraIndices }),
    ),
  ),
  // not a group, a child that is not there, a deck without a group
  onElement(EL.text, { patch: { bullet: 'char' }, child: 0 }),
  onElement(EL.group, { patch: { bullet: 'char' }, child: 9 }),
  blank({ patch: { bullet: 'char' }, child: 0 }),
  // a group child whose bytes have no nvId the group can find
  on(
    { slide: 0, element: 0, patch: { bullet: 'char' }, child: 0 },
    slideXml(
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></p:grpSpPr>' +
        sp(21, 'c', para('', run('t')), '<p:cNvPr name="no id"/>') +
        '</p:grpSp>',
    ),
  ),
]

// ── The specs ───────────────────────────────────────────────────────────

const slideOf = (args: Record<string, unknown>) => args.slide as number
const sizeMap = (args: Record<string, unknown>): FontSizeMap | undefined =>
  args.sizeStep ? GATE_SIZE_MAP : undefined

export const DECKTEXT: CallSpec[] = [
  {
    fn: 'pptxDecktext.index.editChartElement',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        editChartElement(
          opened,
          slideOf(args),
          at.element(slideOf(args), args.element as number),
          args.patch as Parameters<typeof editChartElement>[3],
        ),
      ),
    built: EDIT_CHART_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.markChartEditable',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        markChartEditable(
          at.slide(slideOf(args)),
          at.element(slideOf(args), args.element as number),
        ),
      ),
    built: MARK_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.setElementHidden',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setElementHidden(
          at.slide(slideOf(args)),
          at.element(slideOf(args), args.element as number),
          args.hidden as boolean,
        ),
      ),
    built: HIDDEN_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.setElementName',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setElementName(
          at.slide(slideOf(args)),
          at.element(slideOf(args), args.element as number),
          args.name as string,
        ),
      ),
    built: NAME_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.getChartElementData',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        getChartElementData(
          at.slide(slideOf(args)),
          at.element(slideOf(args), args.element as number),
        ),
      ),
    built: DATA_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.setElementFont',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        setElementFont(
          at.slide(slideOf(args)),
          at.element(slideOf(args), args.element as number),
          args.patch as ElementFontPatch,
          sizeMap(args),
        ),
      ),
    built: FONT_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.replaceAllInDeck',
    call: (text, args) =>
      deckOp(text, args, (opened, at) => {
        const opts = { ...(args.opts as Record<string, unknown>) }
        if (typeof opts.elementAt === 'number') {
          opts.elementId = at.element(0, opts.elementAt)
          delete opts.elementAt
        }
        return replaceAllInDeck(
          opened.deck,
          args.find as string,
          args.replace as string,
          opts as ReplaceOptions,
        )
      }),
    built: REPLACE_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.applyParagraphFormat',
    call: (_text, args) => {
      const paragraphs = structuredClone(args.paragraphs) as Parameters<typeof applyParagraphFormat>[0]
      const dirty = applyParagraphFormat(paragraphs, args.patch as ParagraphFormatPatch)
      return { dirty, paragraphs }
    },
    mutation: 'none',
    built: APPLY_PARAGRAPH_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.setElementParagraphFormat',
    call: (text, args) =>
      deckOp(text, args, (opened, at) => {
        const slide = at.slide(slideOf(args))
        const id = at.element(slideOf(args), args.element as number)
        const first = setElementParagraphFormat(
          slide,
          id,
          args.patch as ParagraphFormatPatch,
          (args.paraIndices ?? undefined) as number[] | undefined,
        )
        if (!args.then) return first
        const second = setElementParagraphFormat(
          slide,
          id,
          args.then as ParagraphFormatPatch,
          (args.thenIndices ?? undefined) as number[] | undefined,
        )
        return [first, second]
      }),
    built: SET_PARAGRAPH_INPUTS,
  },
  {
    fn: 'pptxDecktext.index.setGroupChildParagraphFormat',
    call: (text, args) =>
      deckOp(text, args, (opened, at) => {
        const slide = at.slide(slideOf(args))
        const id = at.element(slideOf(args), args.element as number)
        const group = slide.elements.find((e) => e.id === id) as GroupElement | undefined
        const childId = group?.children?.[args.child as number]?.id ?? ''
        return setGroupChildParagraphFormat(
          slide,
          id,
          childId,
          args.patch as ParagraphFormatPatch,
          (args.paraIndices ?? undefined) as number[] | undefined,
        )
      }),
    built: GROUP_CHILD_INPUTS,
  },
]
