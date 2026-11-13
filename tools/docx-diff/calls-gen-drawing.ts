// Group `genDrawing`: the picture and shape patches of generate.ts. A number
// argument may cross as text ('NaN', 'Infinity'); both sides read it with Number.
import {
  applyImageWrap,
  applyImageZOrder,
  applyShapeWrapAt,
  applyShapeZOrderAt,
  type ImagePatch,
  patchDrawingExtent,
  patchImageParagraphXml,
  patchShapeStyles,
  patchTextboxHeights,
  patchTextboxSizes,
  resizeAnchoredPictureXml,
  resizeInlinePictureXml,
  type ShapeDrawingLocation,
  type ShapeStylePatch,
  swapAnchorWrap,
  type TextboxSizePatch,
} from './reference/generate'
import { xmlSegments } from './reference/xml-tag'
import type { ImageWrap } from './reference/types'
import type { CallSpec, Input } from './calls-spec'

const n = (v: unknown): number => (typeof v === 'string' ? Number(v) : (v as number))
/** undefined stays undefined, null stays null */
const on = (v: unknown): number | null | undefined => (v == null ? (v as null | undefined) : n(v))

function numbersOf<T extends Record<string, unknown>>(o: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...o }
  for (const key of keys) if (key in out) out[key] = on(out[key])
  return out as T
}

const WRAPS: ImageWrap[] = [
  'square-left',
  'square-right',
  'tight-left',
  'tight-right',
  'through-left',
  'through-right',
  'topBottom',
  'behind',
  'front',
]

// ---- built drawings ----

const PIC_SPPR = (xfrm: string): string =>
  `<pic:spPr><a:xfrm${xfrm}><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
const GRAPHIC = (xfrm = '', extra = ''): string =>
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  `<pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>${PIC_SPPR(xfrm)}</pic:pic>${extra}</a:graphicData></a:graphic>`

const INLINE = (xfrm = '', effect = '<wp:effectExtent l="0" t="0" r="0" b="0"/>', docPr = true): string =>
  `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="476250"/>${effect}` +
  `${docPr ? '<wp:docPr id="1" name="Picture 1"/>' : ''}${GRAPHIC(xfrm)}</wp:inline></w:drawing>`

const POS =
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>12700</wp:posOffset></wp:positionH>' +
  '<wp:positionV relativeFrom="paragraph"><wp:posOffset>-25400</wp:posOffset></wp:positionV>'
const POS_ALIGN =
  '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>' +
  '<wp:positionV relativeFrom="margin"><wp:align>top</wp:align></wp:positionV>'

const TIGHT =
  '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="21600"/></wp:wrapPolygon></wp:wrapTight>'
const THROUGH =
  '<wp:wrapThrough wrapText="left"><wp:wrapPolygon edited="1"><wp:start x="1" y="1"/><wp:lineTo x="2" y="2"/></wp:wrapPolygon></wp:wrapThrough>'

const ANCHOR = (
  wrap: string,
  { pos = POS, attrs = 'behindDoc="0" relativeHeight="251659264"', xfrm = '', docPr = true, extra = '' } = {},
): string =>
  `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" ${attrs} locked="0" layoutInCell="1" allowOverlap="1">` +
  `${pos}<wp:extent cx="952500" cy="476250"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}` +
  `${docPr ? '<wp:docPr id="2" name="Picture 2"/>' : ''}${GRAPHIC(xfrm, extra)}</wp:anchor></w:drawing>`

const para = (inner: string, pPr = ''): string => `<w:p>${pPr}<w:r>${inner}</w:r></w:p>`

const TXBX = (text: string): string =>
  `<wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`

const SPPR = (inner: string): string => `<wps:spPr>${inner}</wps:spPr>`
const SHAPE = (
  id: string,
  spPr: string,
  body: string,
  { wrap = '<wp:wrapSquare wrapText="bothSides"/>', attrs = 'behindDoc="0" relativeHeight="251660288"', inline = false } = {},
): string => {
  const graphic =
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>' +
    `<wps:cNvPr id="${id}" name="Shape ${id}"/><wps:cNvSpPr/>${spPr}${body}<wps:bodyPr><a:spAutoFit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic>`
  return inline
    ? `<w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/><wp:docPr id="${id}" name="s"/>${graphic}</wp:inline></w:drawing>`
    : `<w:drawing><wp:anchor simplePos="0" ${attrs} locked="0">${POS}<wp:extent cx="1905000" cy="952500"/>${wrap}<wp:docPr id="${id}" name="s"/>${graphic}</wp:anchor></w:drawing>`
}
const XFRM_EXT = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>'
const FALLBACK = (style: string, text = 'box'): string =>
  `<mc:Fallback><w:pict><v:rect style="${style}"><v:textbox><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect></w:pict></mc:Fallback>`
const ALT = (choice: string, fallback: string): string =>
  `<mc:AlternateContent><mc:Choice Requires="wps">${choice}</mc:Choice>${fallback}</mc:AlternateContent>`

const BOX_A = SHAPE('7', SPPR(`${XFRM_EXT}<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`), TXBX('Hello'))
const BOX_B = SHAPE('8', SPPR(`<a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="100" cy="200"></a:ext></a:xfrm><a:noFill/>`), TXBX('Two &amp; more'))
const BOX_EMPTY = SHAPE('9', SPPR(`${XFRM_EXT}<a:noFill/>`), TXBX(''))
const LINE = SHAPE('10', SPPR(`${XFRM_EXT}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln>`), '')
const LINE_NOWRAP = SHAPE('11', SPPR('<a:prstGeom prst="line"/>'), '', { wrap: '<wp:wrapNone/>' })
const BOX_NOXFRM = SHAPE('12', SPPR('<a:prstGeom prst="rect"/>'), TXBX('noxfrm'))
const BOX_INLINE = SHAPE('13', SPPR(XFRM_EXT), TXBX('inline'), { inline: true })
const BOX_PIC = SHAPE(
  '14',
  SPPR(`<a:xfrm><a:off x="0" y="0"/><a:ext cx="300" cy="400"/></a:xfrm>`),
  `<wps:txbx><w:txbxContent><w:p><w:r>${INLINE()}<w:t>pic</w:t></w:r></w:p></w:txbxContent></wps:txbx>`,
  { attrs: 'relativeHeight="7"' },
)

const SHAPE_PARAS = [
  para(BOX_A + BOX_B),
  para(BOX_EMPTY + LINE + BOX_A),
  para(LINE_NOWRAP + BOX_NOXFRM + BOX_INLINE),
  para(BOX_PIC + BOX_B),
  para(ALT(BOX_A, FALLBACK('position:absolute;width:150pt;height:75pt')) + ALT(BOX_B, FALLBACK('width:200px;height: 100.5px', 'b'))),
  para(ALT(BOX_EMPTY, FALLBACK('width:1pt;height:1pt', '')) + ALT(LINE, FALLBACK('width:3pt;height:4pt'))),
  `<w:p><w:r>${BOX_A}</w:r><w:r><w:t>text <w:tab/></w:t></w:r></w:p>`,
]

const PIC_PARAS = [
  para(INLINE()),
  para(INLINE(' rot="5400000"'), '<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>'),
  para(INLINE(' rot="-60000" flipH="1"', '')),
  para(INLINE(" flipV='1'", '<wp:effectExtent l="9" t="9" r="9" b="9"/>', false), '<w:pPr/>'),
  `<w:p w:rsidR="1">${'<w:pPr><w:spacing w:after="0"/></w:pPr>'}<w:r>${INLINE(' rot="2700000"')}</w:r></w:p>`,
  para(ANCHOR(TIGHT)),
  para(ANCHOR(THROUGH, { attrs: 'relativeHeight="5"', docPr: false })),
  para(ANCHOR('<wp:wrapNone/>', { pos: POS_ALIGN, attrs: 'behindDoc="1" relativeHeight="251658245"', xfrm: ' rot="10800000"' })),
  para(ANCHOR('<wp:wrapSquare wrapText="largest"><wp:effectExtent l="1" t="1" r="1" b="1"/></wp:wrapSquare>')),
  para(ANCHOR('<wp:wrapTopAndBottom/>', { attrs: 'relativeHeight="251658240"' })),
  para(ANCHOR('', { extra: '<pic:pic/>' })),
  para(ANCHOR('<wp:wrapNone/>', { extra: '<wpg:grpSp/>' })),
  '<w:p><w:r><w:t>no drawing</w:t></w:r></w:p>',
]

const DRAWINGS = [
  INLINE(),
  INLINE(' rot="5400000"'),
  ANCHOR(TIGHT),
  ANCHOR(THROUGH, { attrs: 'relativeHeight="5"' }),
  ANCHOR('<wp:wrapNone/>', { attrs: 'relativeHeight="251658245"', docPr: false }),
  ANCHOR('<wp:wrapSquare wrapText="bothSides"/>', { attrs: 'relativeHeight="9"' }).replace(' behindDoc="0"', ''),
  ANCHOR('', { extra: '<pic:pic/>' }),
  ANCHOR('<wp:wrapNone/>', { extra: '<wpg:grpSp/>' }),
  BOX_A,
  LINE,
]

// ---- corpus ----

const BODY_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/
const CAP = 24

function corpusOf(parts: ReadonlyMap<string, string>): { paras: string[]; drawings: string[] } {
  const paras = new Set<string>()
  const drawings = new Set<string>()
  for (const [name, xml] of parts) {
    if (!BODY_PARTS.test(name)) continue
    for (const seg of xmlSegments(xml, 'w:p', 0, xml.length)) {
      const p = xml.slice(seg.start, seg.end)
      if (!p.includes('<w:drawing')) continue
      if (paras.size < CAP) paras.add(p)
      for (const d of xmlSegments(p, 'w:drawing', 0, p.length))
        if (drawings.size < CAP) drawings.add(p.slice(d.start, d.end))
    }
  }
  return { paras: [...paras], drawings: [...drawings] }
}

let lastParts: ReadonlyMap<string, string> | undefined
let lastCorpus: { paras: string[]; drawings: string[] } = { paras: [], drawings: [] }
const corpus = (parts: ReadonlyMap<string, string>) => {
  if (parts !== lastParts) {
    lastParts = parts
    lastCorpus = corpusOf(parts)
  }
  return lastCorpus
}

const fromParas =
  (argSets: Array<Record<string, unknown>>) =>
  (parts: ReadonlyMap<string, string>): Input[] =>
    corpus(parts).paras.flatMap((text) => argSets.map((args) => ({ text, args })))
const fromDrawings =
  (argSets: Array<Record<string, unknown>>) =>
  (parts: ReadonlyMap<string, string>): Input[] =>
    corpus(parts).drawings.flatMap((text) => argSets.map((args) => ({ text, args })))
const cross = (texts: string[], argSets: Array<Record<string, unknown>>): Input[] =>
  texts.flatMap((text) => argSets.map((args) => ({ text, args })))

// ---- argument sets ----

const IMAGE_PATCHES: Array<Record<string, unknown>> = [
  { widthPx: 200, heightPx: 100 },
  { widthPx: 33.3, heightPx: 0.01 },
  { widthPx: 'Infinity', heightPx: 50 },
  { widthPx: 'NaN', heightPx: 50 },
  { widthPx: 0, heightPx: 50 },
  { widthPx: 1e18, heightPx: 2e17 },
  { rotDeg: 90 },
  { rotDeg: -90.5 },
  { rotDeg: 360 },
  { rotDeg: 0 },
  { rotDeg: 'NaN' },
  { rotDeg: 45, widthPx: 120, heightPx: 80 },
  { flipH: true },
  { flipH: false, flipV: true },
  { flipV: false },
  { align: 'center' },
  { align: 'right' },
  { align: 'left' },
  { align: null },
  { align: '' },
  { align: '$&$1$$' },
  { posOffsetX: 914400, posOffsetY: -12.5 },
  { posOffsetX: 'Infinity', posOffsetY: 2.5 },
  { posOffsetY: 'NaN' },
  {},
  // fractional rotations: Math.round, not truncation, decides the degree
  ...[45.6, 45.5, -45.5, -0.5, 359.5, 359.6, 719.7].map((rotDeg) => ({ rotDeg })),
]

const Z = [{}, { zOrder: 3 }, { zOrder: -251658240 }, { zOrder: 1.5 }, { zOrder: 0 }]

const WRAP_ARGS: Array<Record<string, unknown>> = [
  { wrap: null },
  ...WRAPS.map((wrap) => ({ wrap })),
  { wrap: 'tight-right', zOrder: 4 },
  { wrap: 'square-left', posOffset: { x: 12.5, y: -3.5 } },
  { wrap: 'front', posOffset: { x: 0, y: -0.5, relativeTo: 'page' } },
  { wrap: 'behind', posOffset: { x: 100, y: 200, relativeTo: '$&' } },
  { wrap: 'through-left', marginAlign: { h: 'right', v: 'bottom' } },
  { wrap: 'topBottom', marginAlign: { h: 'center', v: '$`' }, zOrder: 2 },
]

const LOCATIONS: Array<Record<string, unknown>> = [
  { boxIndex: 0 },
  { boxIndex: 1 },
  { boxIndex: 2 },
  { boxIndex: -1 },
  { boxIndex: 0.5 },
  { shapeId: '8', boxIndex: 0 },
  { shapeId: '13', boxIndex: 0 },
  { shapeId: 'missing', boxIndex: 0 },
  { shapeId: '', boxIndex: 1 },
]

const HEIGHTS: Array<Record<string, unknown>> = [
  { heightsPx: [] },
  { heightsPx: [null, null] },
  { heightsPx: [40] },
  { heightsPx: [null, 12.345] },
  { heightsPx: [0, 25] },
  { heightsPx: [0, 66.6, 10] },
]

const SIZES: Array<Record<string, unknown>> = [
  { sizes: [] },
  { sizes: [null, {}] },
  { sizes: [{ wPx: 100 }] },
  { sizes: [{ hPx: 50.5 }, { wPx: 10, hPx: 20 }] },
  { sizes: [null, { wPx: 64 }, { hPx: 1e6 }] },
  { sizes: [{ wPx: 0, hPx: -3 }, null, { wPx: 77.77 }] },
]

const STYLES: Array<Record<string, unknown>> = [
  { styles: [] },
  { styles: [null, {}] },
  { styles: [{ fillHex: '00FF00' }] },
  { styles: [{ fillHex: null }, { fillHex: '' }] },
  { styles: [{ borderHex: 'ABCDEF' }, { borderHex: null }, { borderHex: '123456' }] },
  { styles: [{ borderHex: '' }, { fillHex: '$&$`' }] },
  { styles: [{ rotDeg: 90 }, { rotDeg: null }, { rotDeg: 0 }] },
  { styles: [{ rotDeg: -45.5 }, { rotDeg: 360 }, { rotDeg: -720 }] },
  { styles: [{ borderWidthPx: 2 }, { borderWidthPx: null }, { borderWidthPx: 0.01 }] },
  { styles: [{ borderWidthPx: 1.5, fillHex: 'C0C0C0', borderHex: 'FF00FF', rotDeg: 30 }] },
  // rotations whose 60000ths have a fraction: Math.round decides the last unit and the 360 wrap
  { styles: [{ rotDeg: 30.00001 }, { rotDeg: -0.000013 }, { rotDeg: 359.99999 }] },
  { styles: [{ rotDeg: 359.999999 }, { rotDeg: 12.3456789 }, { rotDeg: -179.000009 }] },
]

const EXTENTS: Array<Record<string, unknown>> = [
  { wPx: 100, hPx: 50 },
  { wPx: 0, hPx: -1 },
  { wPx: 1e9, hPx: 0.001 },
  { wPx: 640.5, hPx: 480.25 },
]
const PICTURE_SIZES: Array<Record<string, unknown>> = [
  { widthPx: 100, heightPx: 50 },
  { widthPx: 200, heightPx: 50 },
  { widthPx: 0, heightPx: 50 },
  { widthPx: -5, heightPx: 50 },
  { widthPx: 1e9, heightPx: 7 },
  { widthPx: 33.33, heightPx: 66.67 },
  // non-finite sizes where the TypeScript leaves the drawing as it is
  { widthPx: 'NaN', heightPx: 50 },
  { widthPx: 30, heightPx: '-Infinity' },
]

/** Paragraphs without a VML fallback, whose style a non-finite size would write NaN into. */
const NO_FALLBACK_PARAS = SHAPE_PARAS.filter((p) => !p.includes('<mc:Fallback>'))

const location = (args: Record<string, unknown>): ShapeDrawingLocation => {
  const l = args.location as Record<string, unknown>
  return { ...l, boxIndex: n(l.boxIndex) } as ShapeDrawingLocation
}
const withLocation = (sets: Array<Record<string, unknown>>) =>
  LOCATIONS.flatMap((loc) => sets.map((s) => ({ ...s, location: loc })))

export const GEN_DRAWING: CallSpec[] = [
  {
    fn: 'genDrawing.patchImageParagraphXml',
    argMutation: true,
    call: (text, args) =>
      patchImageParagraphXml(
        text,
        numbersOf(args.patch as Record<string, unknown>, ['widthPx', 'heightPx', 'posOffsetX', 'posOffsetY', 'rotDeg']) as ImagePatch,
      ),
    fromDocument: fromParas(IMAGE_PATCHES.slice(0, 8).map((patch) => ({ patch }))),
    built: cross(PIC_PARAS, IMAGE_PATCHES.map((patch) => ({ patch }))),
  },
  {
    fn: 'genDrawing.applyImageZOrder',
    argMutation: true,
    call: (text, args) => applyImageZOrder(text, on(args.zOrder) ?? undefined),
    fromDocument: fromDrawings(Z.slice(0, 2)),
    built: cross(DRAWINGS, Z),
  },
  {
    fn: 'genDrawing.applyImageWrap',
    argMutation: true,
    call: (text, args) => {
      const pos = args.posOffset as Record<string, unknown> | undefined
      return applyImageWrap(
        text,
        args.wrap as ImageWrap | null,
        pos === undefined ? undefined : ({ ...pos, x: n(pos.x), y: n(pos.y) } as { x: number; y: number }),
        args.marginAlign as { h: 'left'; v: 'top' } | undefined,
        on(args.zOrder) ?? undefined,
      )
    },
    fromDocument: fromDrawings(WRAP_ARGS.slice(0, 4)),
    built: cross(DRAWINGS, WRAP_ARGS),
  },
  {
    fn: 'genDrawing.applyShapeZOrderAt',
    argMutation: true,
    call: (text, args) => applyShapeZOrderAt(text, location(args), n(args.zOrder)),
    fromDocument: fromParas([{ location: { boxIndex: 0 }, zOrder: 2 }]),
    built: cross(SHAPE_PARAS, withLocation([{ zOrder: 5 }, { zOrder: -2.5 }])),
  },
  {
    fn: 'genDrawing.applyShapeWrapAt',
    argMutation: true,
    call: (text, args) =>
      applyShapeWrapAt(text, location(args), args.wrap as ImageWrap | null, on(args.zOrder) ?? undefined),
    fromDocument: fromParas([{ location: { boxIndex: 0 }, wrap: null }, { location: { boxIndex: 0 }, wrap: 'behind' }]),
    built: cross(
      SHAPE_PARAS,
      withLocation([{ wrap: null }, { wrap: 'front' }, { wrap: 'topBottom', zOrder: 1 }, { wrap: 'tight-left' }, { wrap: 'behind' }]),
    ),
  },
  {
    fn: 'genDrawing.swapAnchorWrap',
    argMutation: true,
    call: (text, args) => swapAnchorWrap(text, args.wrap as ImageWrap, on(args.zOrder) ?? undefined),
    fromDocument: fromDrawings([{ wrap: 'behind' }, { wrap: 'square-left', zOrder: 2 }]),
    built: cross(DRAWINGS, [...WRAPS.map((wrap) => ({ wrap })), { wrap: 'front', zOrder: 7 }, { wrap: 'topBottom', zOrder: 0 }]),
  },
  {
    fn: 'genDrawing.patchTextboxHeights',
    argMutation: true,
    call: (text, args) => patchTextboxHeights(text, (args.heightsPx as unknown[]).map(on)),
    fromDocument: fromParas(HEIGHTS.slice(2, 4)),
    built: [
      ...cross(SHAPE_PARAS, HEIGHTS),
      // valid TypeScript output: -Infinity clamps to 1 EMU, NaN is skipped
      ...cross(NO_FALLBACK_PARAS, [{ heightsPx: ['-Infinity'] }, { heightsPx: [10, '-Infinity'] }, { heightsPx: ['NaN', 30] }]),
    ],
  },
  {
    fn: 'genDrawing.patchTextboxSizes',
    argMutation: true,
    call: (text, args) =>
      patchTextboxSizes(
        text,
        (args.sizes as Array<Record<string, unknown> | null>).map((s) =>
          s == null ? s : (numbersOf(s, ['wPx', 'hPx']) as TextboxSizePatch),
        ),
      ),
    fromDocument: fromParas(SIZES.slice(2, 4)),
    built: [
      ...cross(SHAPE_PARAS, SIZES),
      // valid TypeScript output: -Infinity clamps to 1 EMU
      ...cross(NO_FALLBACK_PARAS, [{ sizes: [{ wPx: '-Infinity' }, { hPx: '-Infinity', wPx: 12 }] }]),
      // a non-finite width, then a finite height: the TypeScript's own cx="NaN"
      // stops the height reaching the shape's a:ext; the other order does not
      ...cross(SHAPE_PARAS, [
        { sizes: [{ wPx: 'NaN', hPx: 40 }, { wPx: 'Infinity', hPx: 12.5 }] },
        { sizes: [{ wPx: 20, hPx: 'NaN' }, { wPx: 'Infinity', hPx: '-Infinity' }] },
      ]),
    ],
  },
  {
    fn: 'genDrawing.patchShapeStyles',
    argMutation: true,
    call: (text, args) =>
      patchShapeStyles(
        text,
        (args.styles as Array<Record<string, unknown> | null>).map((s) =>
          s == null ? s : (numbersOf(s, ['rotDeg', 'borderWidthPx']) as ShapeStylePatch),
        ),
      ),
    fromDocument: fromParas(STYLES.slice(2, 5)),
    built: cross(SHAPE_PARAS, [
      ...STYLES,
      // valid TypeScript output: -Infinity clamps to w="1"
      { styles: [{ borderWidthPx: '-Infinity' }, { borderWidthPx: '-Infinity', fillHex: 'ABCDEF' }] },
    ]),
  },
  {
    fn: 'genDrawing.patchDrawingExtent',
    argMutation: true,
    call: (text, args) => patchDrawingExtent(text, n(args.wPx), n(args.hPx)),
    fromDocument: fromParas(EXTENTS.slice(0, 1)),
    built: cross([...PIC_PARAS, ...SHAPE_PARAS], [
      ...EXTENTS,
      // valid TypeScript output: -Infinity clamps to 1 EMU
      { wPx: '-Infinity', hPx: '-Infinity' },
      { wPx: '-Infinity', hPx: 20 },
    ]),
  },
  {
    fn: 'genDrawing.resizeInlinePictureXml',
    argMutation: true,
    call: (text, args) => resizeInlinePictureXml(text, n(args.widthPx), n(args.heightPx)),
    fromDocument: fromDrawings(PICTURE_SIZES.slice(0, 2)),
    built: cross(DRAWINGS, PICTURE_SIZES),
  },
  {
    fn: 'genDrawing.resizeAnchoredPictureXml',
    argMutation: true,
    call: (text, args) => resizeAnchoredPictureXml(text, n(args.widthPx), n(args.heightPx)),
    fromDocument: fromDrawings(PICTURE_SIZES.slice(0, 2)),
    built: cross(DRAWINGS, PICTURE_SIZES),
  },
]

const NF_INLINE =
  '<w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
const NF_ANCHOR =
  '<w:drawing><wp:anchor simplePos="0" relativeHeight="251659264" behindDoc="0"><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="476250"/><wp:wrapNone/><wp:docPr id="2" name="Picture 2"/><a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>'
const NF_BOX_PARA =
  '<w:p><w:r><w:drawing><wp:anchor relativeHeight="251660288" behindDoc="0"><wp:extent cx="1905000" cy="952500"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="7" name="Text Box 7"/><a:graphic><a:graphicData><wps:wsp><wps:cNvPr id="7" name="Text Box 7"/><wps:spPr><a:xfrm><a:ext cx="1905000" cy="952500"/></a:xfrm><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'
/** A text box with a VML fallback: its style takes the size as text, a negative infinity too. */
const NF_FALLBACK_PARA = para(ALT(BOX_A, FALLBACK('width:150pt;height:75pt')))

/** One input per argument where the TypeScript writes NaN or Infinity into the XML and the Rust ignores the value. */
export const NON_FINITE_DRAWING: Array<{ fn: string; text: string; args: Record<string, unknown> }> = [
  { fn: 'genDrawing.applyImageWrap', text: NF_INLINE, args: { wrap: 'front', posOffset: { x: 'NaN', y: 0 } } },
  { fn: 'genDrawing.applyImageWrap', text: NF_INLINE, args: { wrap: 'front', posOffset: { x: 0, y: 'Infinity' } } },
  { fn: 'genDrawing.applyImageWrap', text: NF_INLINE, args: { wrap: 'square-left', zOrder: 'NaN' } },
  { fn: 'genDrawing.applyImageZOrder', text: NF_ANCHOR, args: { zOrder: 'NaN' } },
  { fn: 'genDrawing.applyShapeZOrderAt', text: NF_BOX_PARA, args: { location: { boxIndex: 0 }, zOrder: 'NaN' } },
  { fn: 'genDrawing.swapAnchorWrap', text: NF_ANCHOR, args: { wrap: 'behind', zOrder: 'NaN' } },
  { fn: 'genDrawing.patchTextboxHeights', text: NF_BOX_PARA, args: { heightsPx: ['Infinity'] } },
  { fn: 'genDrawing.patchTextboxSizes', text: NF_BOX_PARA, args: { sizes: [{ wPx: 'NaN' }] } },
  { fn: 'genDrawing.patchTextboxSizes', text: NF_BOX_PARA, args: { sizes: [{ hPx: 'Infinity' }] } },
  { fn: 'genDrawing.patchTextboxHeights', text: NF_FALLBACK_PARA, args: { heightsPx: ['-Infinity'] } },
  { fn: 'genDrawing.patchTextboxSizes', text: NF_FALLBACK_PARA, args: { sizes: [{ wPx: '-Infinity' }] } },
  { fn: 'genDrawing.patchTextboxSizes', text: NF_FALLBACK_PARA, args: { sizes: [{ hPx: '-Infinity' }] } },
  { fn: 'genDrawing.patchShapeStyles', text: NF_BOX_PARA, args: { styles: [{ rotDeg: 'NaN' }] } },
  { fn: 'genDrawing.patchShapeStyles', text: NF_BOX_PARA, args: { styles: [{ borderWidthPx: 'Infinity' }] } },
  { fn: 'genDrawing.patchDrawingExtent', text: `<w:p><w:r>${NF_INLINE}</w:r></w:p>`, args: { wPx: 'NaN', hPx: 50 } },
  { fn: 'genDrawing.patchDrawingExtent', text: `<w:p><w:r>${NF_INLINE}</w:r></w:p>`, args: { wPx: 100, hPx: 'Infinity' } },
  { fn: 'genDrawing.resizeInlinePictureXml', text: NF_INLINE, args: { widthPx: 'Infinity', heightPx: 50 } },
  { fn: 'genDrawing.resizeInlinePictureXml', text: NF_INLINE, args: { widthPx: 100, heightPx: 'Infinity' } },
  { fn: 'genDrawing.resizeAnchoredPictureXml', text: NF_ANCHOR, args: { widthPx: 'Infinity', heightPx: 50 } },
  { fn: 'genDrawing.resizeAnchoredPictureXml', text: NF_ANCHOR, args: { widthPx: 100, heightPx: 'Infinity' } },
]

// The non-finite inputs are built inputs of the comparison; the mutations
// carry their numbers to other places.
for (const spec of GEN_DRAWING) {
  const listed = NON_FINITE_DRAWING.filter(({ fn }) => fn === spec.fn)
  if (listed.length === 0) continue
  spec.built.push(...listed.map(({ text, args }) => ({ text, args })))
}
