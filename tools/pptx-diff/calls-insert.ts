// Group `insert` of comparison (f): insert.ts, background-promote.ts,
// headerfooter.ts and smartart.ts of packages/pptx-engine. The Rust side
// answers in crates/office-wasm/src/calls/pptx_insert.rs to
// `pptxInsert.<module>.<TypeScript name>`. Every function reads or changes an
// opened deck, so each goes through deckOp; `args.uuid` is what
// crypto.randomUUID answers and `args.now` what Date.now answers.
import { promoteSlideBackground, isBackgroundLikeElement } from '../../packages/pptx-engine/src/background-promote'
import { applyHeaderFooter, readHeaderFooter } from '../../packages/pptx-engine/src/headerfooter'
import {
  addElement,
  addImageMediaAndRel,
  addPicture,
  buildGrpSpXml,
  buildSpXml,
  buildTableGridXml,
  buildTableXml,
  calcBoundingBox,
  deleteElement,
  isLineKind,
  nextCNvPrId,
  type NewElementOptions,
  type NewPictureOptions,
  type NewTableGridOptions,
  type NewTableOptions,
} from '../../packages/pptx-engine/src/insert'
import { addSmartArt, buildSmartArtXml, type NewSmartArtOptions } from '../../packages/pptx-engine/src/smartart'
import type { CallSpec } from '../docx-diff/calls-spec'
import { deckInput, deckOp } from './deck-ops'
import { withUuid } from './calls-leaves'

const UUID = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const NOW = 1_700_000_000_000
const RealDate = Date

/** `run` with the clock stopped at `args.now` and randomUUID answering `args.uuid`. */
function fixed<T>(args: Record<string, unknown>, run: () => T): T {
  const now = (args.now as number | undefined) ?? NOW
  class Stopped extends RealDate {
    static override now(): number {
      return now
    }
  }
  globalThis.Date = Stopped as DateConstructor
  try {
    return withUuid((args.uuid as string | undefined) ?? UUID, run)
  } finally {
    globalThis.Date = RealDate
  }
}

/** `<a:fld>` takes a random GUID (generate.ts fieldGuid): both sides print it as one fixed text. */
const FIELD_ID = /(<a:fld id=")\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}"/g
function noFieldGuid(node: unknown): unknown {
  if (typeof node === 'string') return node.replace(FIELD_ID, '$1{G}"')
  if (Array.isArray(node)) return node.map(noFieldGuid)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, noFieldGuid(value)]))
}

const BLANK = 'blank deck'
const GEN = 'pptxgenjs text, shape, table and two slides'
const OFFSET = { x: 100, y: 200, cx: 3000, cy: 1500 }
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]

const slideXml = (inner: string): string =>
  `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`
const SLIDE_PART = 'ppt/slides/slide1.xml'
const withSlide = (inner: string, rest: Record<string, unknown>) =>
  deckInput(BLANK, { slide: 0, ...rest }, { part: SLIDE_PART, text: slideXml(inner) })

const rect = (id: number, x: number, y: number, cx: number, cy: number, extra = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${extra}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
const FULL = [12192000, 6858000] as const
const solid = (c: string) => `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>`

const para = (text: string) => ({ runs: [{ text }] })

const ELEMENT_OPTS: NewElementOptions[] = [
  { kind: 'textbox', offset: OFFSET },
  { kind: 'textbox', offset: OFFSET, paragraphs: [para('A & <B> \u{1F600}')], bodyPr: { wrap: 'none', anchor: 'ctr', insetsEmu: { l: 1.5, t: 2.5, r: 3.5, b: 4.5 }, autoFit: 'shrink' } },
  { kind: 'rect', offset: OFFSET, fillColor: '#336699' },
  { kind: 'roundRect', offset: OFFSET, fillColor: '#33669980', stroke: { color: '#ff0000ff', widthEmu: 12700.6 }, adjustments: { adj: 25000.4, 'a"b': 1 }, flipH: true, flipV: true, bodyPr: { autoFit: 'resize', anchor: 'b', wrap: 'square' } },
  { kind: 'ellipse', offset: OFFSET, fillColor: '#12', paragraphs: [] },
  { kind: 'a"<b', offset: OFFSET, fillColor: '#11223344', stroke: { color: '#abcdef', widthEmu: 0 } },
  { kind: 'line', offset: OFFSET },
  { kind: 'lineArrow', offset: OFFSET, stroke: { color: '#00ff00', widthEmu: 9525.5 } },
  { kind: 'lineArrowDouble', offset: OFFSET, flipH: true, flipV: true, adjustments: { adj1: 5 } },
  { kind: 'lineBent', offset: OFFSET },
  { kind: 'lineCurved', offset: OFFSET },
]

const TABLE_OPTS: NewTableOptions[] = [
  { rows: 2, cols: 3, offset: OFFSET },
  { rows: 0, cols: 200, offset: { ...OFFSET, cx: 1e30 } },
  { rows: NaN, cols: Infinity, offset: OFFSET },
  { rows: 2, cols: 2, offset: OFFSET, colWidthsEmu: [10, 20], rowHeightsEmu: [30, -5] },
  { rows: 2, cols: 2, offset: OFFSET, colWidthsEmu: [10], rowHeightsEmu: [30, 40, 50] },
  {
    rows: 3,
    cols: 3,
    offset: OFFSET,
    cellProps: [
      [{ gridSpan: 5, rowSpan: 9, anchor: 'ctr' }, { hMerge: true }, { vMerge: true, anchor: 't' }],
      [undefined, { gridSpan: 1e9, anchor: 'b' }, { rowSpan: NaN }],
    ],
  },
]

const GRID_OPTS: NewTableGridOptions[] = [
  { offset: OFFSET, colWidthsEmu: [100, 200], rowHeightsEmu: [50, 60], cells: [[{}, {}], [{}, {}]] },
  {
    offset: OFFSET,
    colWidthsEmu: [1e30, 0],
    rowHeightsEmu: [50],
    border: { color: '#aabbccdd', widthEmu: 0.2 },
    cells: [
      [{ paragraphs: [para('x')], gridSpan: 9, fillColor: '#ff0000', anchor: 'ctr', marginsEmu: { l: 1, t: 2, r: 3, b: 4 } }, { hMerge: true }],
      [{ rowSpan: Infinity, vMerge: true, anchor: 'b', paragraphs: [] }, { fillColor: '#00ff0080', anchor: 't' }],
      [{}],
    ],
  },
  {
    offset: OFFSET,
    colWidthsEmu: [100, 100, 100],
    rowHeightsEmu: [10, 10],
    border: { color: 'abc', widthEmu: 5, scope: 'insideV' },
    cells: [
      [{}, {}, { hMerge: true }],
      [{}, { hMerge: true }, {}],
    ],
  },
  { offset: OFFSET, colWidthsEmu: [], rowHeightsEmu: [], cells: [] },
]

const PICTURES: NewPictureOptions[] = [
  { bytes: new Uint8Array(PNG), ext: 'png', offset: OFFSET },
  { bytes: new Uint8Array(PNG), ext: 'PNG', offset: OFFSET, name: 'Logo <1>', descr: 'a "b" & c' },
  { bytes: new Uint8Array([1, 2, 3]), ext: 'jpeg', offset: OFFSET, descr: '' },
  { bytes: new Uint8Array([4]), ext: 'tif', offset: OFFSET },
  { bytes: new Uint8Array([5]), ext: 'svg', offset: OFFSET },
  { bytes: new Uint8Array([6]), ext: 'a(b', offset: OFFSET },
  { bytes: new Uint8Array([7]), ext: 'constructor', offset: OFFSET },
]
const pictureArgs = (o: NewPictureOptions) => ({ ...o, bytes: [...o.bytes] })
const toBytes = (a: unknown) => new Uint8Array(a as number[])

const SMART: NewSmartArtOptions[] = ['list', 'process', 'cycle', 'hierarchy', 'pyramid', 'matrix', 'venn', 'other'].map(
  (layout, i) => ({
    layout: layout as NewSmartArtOptions['layout'],
    items: ['A', 'B & <C>', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].slice(0, [1, 2, 3, 4, 5, 6, 8, 9][i]),
    offset: OFFSET,
  }),
)

const withTwoGroups = `${rect(2, 0, 0, 100, 100)}${rect(3, 50, 50, 100, 100)}`

export const INSERT: CallSpec[] = [
  {
    fn: 'pptxInsert.insert.isLineKind',
    call: (text) => isLineKind(text),
    built: [
      'line', 'lineArrow', 'lineArrowDouble', 'lineBent', 'lineCurved', 'textbox', 'rect', '', 'Line',
      'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf',
    ].map((text) => ({ text })),
  },
  {
    fn: 'pptxInsert.insert.nextCNvPrId',
    call: (text, args) => deckOp(text, args, (opened, at) => nextCNvPrId(at.slide(0))),
    built: [
      deckInput(BLANK, { slide: 0 }),
      deckInput(GEN, { slide: 0 }),
      withSlide(`<p:sp><p:nvSpPr><p:cNvPr id='41' name="q"/></p:nvSpPr></p:sp>${rect(7, 0, 0, 1, 1)}`, {}),
      withSlide(`<p:sp><p:nvSpPr><p:cNvPr id="99999999999999999999" name="q"/></p:nvSpPr></p:sp>`, {}),
    ],
  },
  {
    fn: 'pptxInsert.insert.buildSpXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => buildSpXml(at.slide(0), args.opts as NewElementOptions)),
      ),
    built: [
      ...ELEMENT_OPTS.map((opts) => deckInput(GEN, { slide: 0, opts })),
      deckInput(BLANK, { slide: 0, opts: { kind: 'textbox', offset: { x: 1e30, y: NaN, cx: -5, cy: 1e30 } } }),
    ],
  },
  {
    fn: 'pptxInsert.insert.addElement',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => addElement(at.slide(0), args.opts as NewElementOptions)),
      ),
    built: ELEMENT_OPTS.map((opts) => deckInput(GEN, { slide: 0, opts })),
  },
  {
    fn: 'pptxInsert.insert.buildTableXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => buildTableXml(at.slide(0), args.opts as NewTableOptions)),
      ),
    built: TABLE_OPTS.map((opts) => deckInput(GEN, { slide: 0, opts })),
  },
  {
    fn: 'pptxInsert.insert.buildTableGridXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => buildTableGridXml(at.slide(0), args.opts as NewTableGridOptions)),
      ),
    built: GRID_OPTS.map((opts) => deckInput(GEN, { slide: 0, opts })),
  },
  {
    fn: 'pptxInsert.insert.addImageMediaAndRel',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        addImageMediaAndRel(opened, at.slide(0), toBytes(args.bytes), args.ext as string),
      ),
    built: [
      ...PICTURES.map((o) => deckInput(GEN, { slide: 0, bytes: [...o.bytes], ext: o.ext })),
      deckInput(BLANK, { slide: 0, bytes: PNG, ext: 'png' }),
    ],
  },
  {
    fn: 'pptxInsert.insert.addPicture',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => {
          const o = args.opts as Record<string, unknown>
          return addPicture(opened, at.slide(0), { ...o, bytes: toBytes(o.bytes) } as NewPictureOptions)
        }),
      ),
    built: PICTURES.map((o) => deckInput(GEN, { slide: 0, opts: pictureArgs(o) })),
  },
  {
    fn: 'pptxInsert.insert.deleteElement',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        deleteElement(opened, at.slide(0), at.element(0, args.element as number)),
      ),
    built: [
      deckInput(GEN, { slide: 0, element: 0 }),
      deckInput(GEN, { slide: 0, element: 1 }),
      deckInput(GEN, { slide: 0, element: 2 }),
      deckInput(GEN, { slide: 0, element: 99 }),
    ],
  },
  {
    fn: 'pptxInsert.insert.calcBoundingBox',
    call: (text, args) =>
      deckOp(text, args, (opened, at) => calcBoundingBox(at.slide(0).elements)),
    built: [
      deckInput(GEN, { slide: 0 }),
      deckInput(BLANK, { slide: 0 }),
      withSlide(withTwoGroups, {}),
    ],
  },
  {
    fn: 'pptxInsert.insert.buildGrpSpXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => buildGrpSpXml(at.slide(0), args.bbox as never, args.childrenXml as string)),
      ),
    built: [
      deckInput(GEN, { slide: 0, bbox: { x: 1, y: 2, cx: 3, cy: 4 }, childrenXml: '<p:sp/>' }),
      deckInput(BLANK, { slide: 0, bbox: { x: 0.5, y: -2, cx: 1e30, cy: 4 }, childrenXml: '' }),
    ],
  },
  {
    fn: 'pptxInsert.background-promote.promoteSlideBackground',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        promoteSlideBackground(at.slide(0), opened.deck.size),
      ),
    built: [
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')) + rect(3, 10, 10, 100, 100), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')) + rect(3, 0, 0, ...FULL, solid('445566FF')), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('11223380')), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:ln><a:noFill/></a:ln>`), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:ln w="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:ln w="9525"><a:solidFill><a:srgbClr val="00000000"/></a:solidFill></a:ln>`), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:effectLst><a:outerShdw blurRad="1"/></a:effectLst>`), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:p/>', '<a:p><a:r><a:t>hi</a:t></a:r></a:p>'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:p/>', '<a:p><a:r><a:t>  </a:t></a:r></a:p>'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:xfrm>', '<a:xfrm rot="60000">'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:xfrm>', '<a:xfrm flipH="1">'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:xfrm>', '<a:xfrm flipV="1">'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('prst="rect"', 'prst="ellipse"'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<p:nvPr/>', '<p:nvPr><p:ph type="title"/></p:nvPr>'), {}),
      withSlide(rect(2, 0, 0, ...FULL, '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs></a:gsLst></a:gradFill>'), {}),
      withSlide(rect(2, 0, 0, 100, 100, solid('112233')), {}),
      withSlide(rect(2, 0, 0, 12192000 * 1.2, 6858000 * 1.2, solid('112233')), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')) + rect(3, 0, 0, ...FULL, solid('445566')), {}),
      deckInput(BLANK, { slide: 0 }, { part: SLIDE_PART, text: slideXml(rect(2, 0, 0, ...FULL, solid('112233'))).replace('</p:cSld>', '</p:cSld><p:timing><p:tnLst><p:par><p:cTn><p:childTnLst><p:set><p:cBhvr><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>') }),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<p:cNvPr id="2" name="S2"/>', '<p:cNvPr name="S2"/>'), {}),
    ],
  },
  {
    fn: 'pptxInsert.background-promote.isBackgroundLikeElement',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        at.slide(0).elements.map((el) => isBackgroundLikeElement(el, opened.deck.size)),
      ),
    built: [
      deckInput(GEN, { slide: 0 }),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')), {}),
      withSlide(rect(2, 0, 0, ...FULL, '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs></a:gsLst></a:gradFill>'), {}),
      withSlide(rect(2, 0, 0, ...FULL), {}),
      withSlide(rect(2, 0, 0, ...FULL, `${solid('112233')}<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`), {}),
      withSlide(rect(2, 0, 0, 12192000 * 1.4, 6858000 * 1.4, solid('112233')), {}),
      withSlide(rect(2, 0, 0, 12192000 * 1.6, 6858000 * 1.6, solid('112233')), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:xfrm>', '<a:xfrm rot="60000">'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<a:p/>', '<a:p><a:r><a:t>x</a:t></a:r></a:p>'), {}),
      withSlide(rect(2, 0, 0, ...FULL, solid('112233')).replace('<p:nvPr/>', '<p:nvPr><p:ph type="title"/></p:nvPr>'), {}),
      withSlide(
        `<p:pic><p:nvPicPr><p:cNvPr id="2" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${FULL[0]}" cy="${FULL[1]}"/></a:xfrm></p:spPr></p:pic>`,
        {},
      ),
      withSlide(
        `<p:pic><p:nvPicPr><p:cNvPr id="2" name="P"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId2"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${FULL[0]}" cy="${FULL[1]}"/></a:xfrm><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:pic>`,
        {},
      ),
    ],
  },
  {
    fn: 'pptxInsert.headerfooter.applyHeaderFooter',
    call: async (text, args) =>
      noFieldGuid(
        await deckOp(text, args, (opened) =>
          fixed(args, () =>
            applyHeaderFooter(opened, args.opts as never, args.indexes as number[] | undefined),
          ),
        ),
      ),
    built: [
      deckInput(GEN, { opts: { footer: 'Foot & <er>', slideNum: true, date: '2026-11-12', dateAuto: true } }),
      deckInput(GEN, { opts: { footer: 'Foot', date: 'x' } }),
      deckInput(GEN, { opts: { slideNum: true }, indexes: [1] }),
      deckInput(GEN, { opts: {}, indexes: [0] }),
      deckInput(GEN, { opts: { footer: '', date: '', slideNum: false } }),
      deckInput(GEN, { opts: { footer: 'x' }, indexes: [5, -1, 0.5, 1] }),
      deckInput(GEN, { opts: { footer: null, date: null } }),
      deckInput(BLANK, { opts: { footer: '\u{1F600} f' }, indexes: [] }),
      deckInput(
        BLANK,
        { opts: { footer: 'new' } },
        {
          part: SLIDE_PART,
          text: slideXml(
            ['dt', 'ftr', 'sldNum']
              .map(
                (t, i) =>
                  `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="${t}"/><p:cNvSpPr/><p:nvPr><p:ph type="${t}" idx="${10 + i}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>old</a:t></a:r></a:p></p:txBody></p:sp>`,
              )
              .join('') + rect(9, 0, 0, 10, 10),
          ).replace(
            '</p:cSld>',
            '</p:cSld><p:timing><p:tnLst><p:par><p:cTn><p:childTnLst><p:set><p:cBhvr><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>',
          ),
        },
      ),
    ],
  },
  {
    fn: 'pptxInsert.headerfooter.readHeaderFooter',
    call: (text, args) => deckOp(text, args, (opened, at) => readHeaderFooter(at.slide(0))),
    built: [
      deckInput(GEN, { slide: 0 }),
      deckInput(BLANK, { slide: 0 }),
      ...[
        '<a:p><a:r><a:t> f1 </a:t></a:r></a:p><a:p><a:r><a:t>f2</a:t></a:r></a:p>',
        '<a:p/>',
        '<a:p><a:r><a:t>\u{1F600}</a:t></a:r></a:p>',
      ].map((body) =>
        withSlide(
          ['dt', 'ftr', 'sldNum']
            .map(
              (t, i) =>
                `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="${t}"/><p:cNvSpPr/><p:nvPr><p:ph type="${t}" idx="${10 + i}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`,
            )
            .join(''),
          { slide: 0 },
        ),
      ),
      withSlide(rect(2, 0, 0, 10, 10), { slide: 0 }),
    ],
  },
  {
    fn: 'pptxInsert.smartart.buildSmartArtXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        fixed(args, () => buildSmartArtXml(at.slide(0), args.opts as NewSmartArtOptions)),
      ),
    built: SMART.map((opts) => deckInput(GEN, { slide: 0, opts })),
  },
  {
    fn: 'pptxInsert.smartart.addSmartArt',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        fixed(args, () => {
          const r = addSmartArt(opened, args.slide as number, args.opts as NewSmartArtOptions)
          return r ? { elementId: r.elementId } : null
        }),
      ),
    built: [
      ...SMART.map((opts) => deckInput(GEN, { slide: 0, opts })),
      deckInput(GEN, { slide: 1, opts: SMART[0] }),
      deckInput(GEN, { slide: 9, opts: SMART[0] }),
      deckInput(GEN, { slide: 0, opts: { ...SMART[0], items: [] } }),
    ],
  },
]
