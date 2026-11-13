// Group `deckshape`: index.ts 1155-1923 (shape geometry, text body, effects, fill, pictures),
// run on an opened deck through deckOp. Each op answers { r, xml }: the result and
// patchSlideXml of the slide afterwards. The Rust side is
// crates/office-wasm/src/calls/pptx_deckshape.rs, `index.<TypeScript name>`.
import {
  autofitGeneratedTextBoxes,
  editPictureSrcRect,
  replacePictureBytes,
  setElementEffects,
  setElementFill,
  setElementImageFill,
  setElementRedaction,
  setElementTextAnchor,
  setElementTextBodyProps,
  setPictureOpacity,
  setShapeAdjustValues,
  setShapeCustomGeometry,
  setShapePresetGeometry,
  patchSlideXml,
} from './reference/index'
import type { CallSpec } from '../docx-diff/calls-spec'
import { deckInput, deckOp } from './deck-ops'

const PART = 'ppt/slides/slide1.xml'
const BLANK = 'blank deck'
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const sp = (id: number, spPr: string, body = '<a:bodyPr/>', extra = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr${extra}/><p:nvPr/></p:nvSpPr><p:spPr>${spPr}</p:spPr><p:txBody>${body}<a:lstStyle/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`
const XFRM = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>'
const pic = (id: number, blip: string, extra = ''): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="P${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${XFRM}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${extra}</p:spPr></p:pic>`
const slideXml = (...shapes: string[]): string =>
  `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`
const grp = (id: number, child: string): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:effectLst/></p:grpSpPr>${child}</p:grpSp>`

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]
const PNG2 = [137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]
const BLIP = '<a:blip r:embed="rId9"/>'
const PIC_TEXTS = [
  slideXml(pic(2, BLIP), sp(3, XFRM + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>')),
  slideXml(pic(2, '<a:blip r:embed="rId9" r:link="rId8"/>')),
  slideXml(pic(2, '<a:blip r:link="rId8"/>')),
  slideXml(pic(2, '<a:blip/>')),
  slideXml(pic(2, '<a:blip r:embed="rId9"><a:alphaModFix amt="40000"/></a:blip>')),
  slideXml(pic(2, '<a:blip r:embed="rId9"></a:blip>')),
  slideXml(
    pic(
      2,
      '<a:blip r:embed="rId9"><a:extLst><a:ext uri="{x}"><asvg:svgBlip xmlns:asvg="s" r:embed="rId9"/></a:ext></a:extLst></a:blip>',
      '<a:extLst><a:ext uri="{y}"/></a:extLst>',
    ),
  ),
  slideXml(
    '<p:pic><p:nvPicPr><p:cNvPr id="2" name="no blip"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>',
  ),
  // a 3D model: the Choice caches its rendering in am3d:blip, which a picture swap re-points too
  slideXml(
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      '<mc:Choice Requires="am3d" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d">' +
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="3D"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic>' +
      '<a:graphicData uri="http://schemas.microsoft.com/office/drawing/2017/model3d">' +
      '<am3d:model3d r:embed="rId7"><am3d:raster rName="Office3DEngine" rVer="16.0.8326"><am3d:blip r:embed="rId9"/></am3d:raster></am3d:model3d>' +
      '</a:graphicData></a:graphic></p:graphicFrame></mc:Choice>' +
      `<mc:Fallback>${pic(2, BLIP)}</mc:Fallback></mc:AlternateContent>`,
  ),
  // the references as XML allows: spaced `=`, single quotes, a reference, an extra attribute first
  slideXml(pic(2, '<a:blip r:embed = \'rId9\' r:link = "rId8"/>')),
  slideXml(pic(2, '<a:blip r:embed="rId&#57;"/>')),
  slideXml(pic(2, '<a:blip note="a>b" r:link = \'rId8\'/>')),
  slideXml(
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      '<mc:Choice Requires="am3d" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d">' +
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="3D"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic>' +
      '<a:graphicData uri="http://schemas.microsoft.com/office/drawing/2017/model3d">' +
      '<am3d:model3d r:embed="rId7"><am3d:raster rName="Office3DEngine" rVer="16.0.8326"><am3d:blip r:embed = \'rId&#57;\'/><am3d:blip note="a>b" r:embed="rId9"/><am3d:blip r:embed="rId7"/></am3d:raster></am3d:model3d>' +
      '</a:graphicData></a:graphic></p:graphicFrame></mc:Choice>' +
      `<mc:Fallback>${pic(2, "<a:blip r:embed = 'rId&#57;'/>")}</mc:Fallback></mc:AlternateContent>`,
  ),
]
const SHAPES = slideXml(
  sp(
    2,
    XFRM +
      '<a:prstGeom prst="rect"><a:avLst><a:gd name="adj" fmla="val 1"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
  ),
  sp(
    3,
    XFRM,
    '<a:bodyPr wrap="none" lIns="1"><a:normAutofit fontScale="50000"/></a:bodyPr>',
    ' txBox="1"',
  ),
  sp(
    4,
    XFRM + '<a:custGeom><a:pathLst/></a:custGeom><a:ln><a:effectLst/></a:ln>',
    '<a:bodyPr anchor="b"/>',
  ),
  sp(
    5,
    XFRM +
      '<a:prstGeom prst="rect"/><a:effectLst><a:outerShdw blurRad="1"/><a:fillOverlay/><a:glow rad="1"/></a:effectLst><a:scene3d/>',
    '<a:bodyPr><a:prstTxWarp prst="textPlain"/></a:bodyPr>',
  ),
  sp(
    6,
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>',
    '<a:bodyPr><a:noAutofit/></a:bodyPr>',
    ' txBox="1"',
  ),
  sp(7, XFRM, '<a:bodyPr/>', ' txBox="1"'),
  grp(8, sp(9, XFRM)),
  sp(10, '', '<a:bodyPr vert="vert"></a:bodyPr>', ' txBox="1"'),
)
const at = (slide: number, element: number, rest: Record<string, unknown> = {}, text?: string) =>
  deckInput(BLANK, { slide, element, ...rest }, { part: PART, text: text ?? SHAPES })

const sid = (o: Parameters<Parameters<typeof deckOp>[2]>[1], args: Record<string, unknown>) =>
  o.element(args.slide as number, args.element as number)
const bytes = (v: unknown) => (v ? Uint8Array.from(v as number[]) : undefined)

const ELEMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 99]

interface Ctx {
  opened: Parameters<typeof setElementFill>[0]
  slide: Parameters<typeof setElementFill>[1]
  id: string
  a: Parameters<Parameters<typeof deckOp>[2]>[1]
}
type Args = Record<string, any> // the arguments of an input are JSON the spec itself wrote

const run = (text: string, args: Record<string, unknown>, f: (c: Ctx, x: Args) => unknown) =>
  deckOp(text, args, (opened, a) => {
    const slide = a.slide(args.slide as number)
    const r = f({ opened, slide, id: sid(a, args), a }, args as Args)
    return { r, xml: patchSlideXml(opened.deck.slides[args.slide as number]!) }
  })

export const DECKSHAPE: CallSpec[] = [
  {
    fn: 'pptxDeckshape.index.editPictureSrcRect',
    call: (t, a) => run(t, a, (c, x) => editPictureSrcRect(c.slide, c.id, x.srcRect ?? null)),
    built: PIC_TEXTS.slice(0, 1).flatMap((t) =>
      [
        null,
        { l: 0, t: 0, r: 0, b: 0 },
        { l: 1000, t: 0, r: 0, b: 0 },
        { l: 1, t: 2, r: 3, b: 4 },
      ].flatMap((srcRect) => [0, 1, 99].map((e) => at(0, e, { srcRect }, t))),
    ),
  },
  {
    fn: 'pptxDeckshape.index.setShapePresetGeometry',
    call: (t, a) => run(t, a, (c, x) => setShapePresetGeometry(c.slide, c.id, x.prst)),
    built: ['ellipse', 'roundRect', 'nope', '', 'constructor', '__proto__'].flatMap((prst) =>
      ELEMENTS.map((e) => at(0, e, { prst })),
    ),
  },
  {
    fn: 'pptxDeckshape.index.setShapeCustomGeometry',
    call: (t, a) => run(t, a, (c, x) => setShapeCustomGeometry(c.slide, c.id, x.geom)),
    built: [
      {
        w: 100,
        h: 50,
        cmds: [
          { op: 'M', pts: [0, 0] },
          { op: 'L', pts: [100, 50] },
          { op: 'Z', pts: [] },
        ],
      },
      {
        w: 100,
        h: 50,
        cmds: [
          { op: 'M', pts: [0, 0] },
          { op: 'C', pts: [1, 2, 3, 4, 5, 6] },
        ],
      },
      { w: 0, h: 50, cmds: [{ op: 'M', pts: [0, 0] }] },
      { w: 1, h: 1, cmds: [] },
      { w: 1, h: 1, cmds: [{ op: 'L', pts: [0, 0] }] },
      { w: 1, h: 1, cmds: [{ op: 'M', pts: [0] }] },
      { w: 1, h: 1, cmds: [null] },
      null,
    ].flatMap((geom) => ELEMENTS.map((e) => at(0, e, { geom }))),
  },
  {
    fn: 'pptxDeckshape.index.setShapeAdjustValues',
    call: (t, a) => run(t, a, (c, x) => setShapeAdjustValues(c.slide, c.id, x.adjust)),
    built: [
      { adj: 12345.6 },
      { adj1: 1, adj2: -2.5 },
      {},
      { 'a b': 1 },
      { adj: 1e21 },
      { '': 1 },
    ].flatMap((adjust) => ELEMENTS.map((e) => at(0, e, { adjust }))),
  },
  {
    fn: 'pptxDeckshape.index.setElementTextAnchor',
    call: (t, a) => run(t, a, (c, x) => setElementTextAnchor(c.slide, c.id, x.anchor)),
    built: ['top', 'middle', 'bottom'].flatMap((anchor) =>
      ELEMENTS.map((e) => at(0, e, { anchor })),
    ),
  },
  {
    fn: 'pptxDeckshape.index.autofitGeneratedTextBoxes',
    call: (t, a) => run(t, a, (c) => autofitGeneratedTextBoxes(c.slide)),
    built: [
      at(0, 0),
      at(
        0,
        1,
        {},
        slideXml(
          sp(2, XFRM, '<a:bodyPr/>', ' txBox="1"'),
          sp(3, XFRM, '<a:bodyPr></a:bodyPr>', ' txBox="1"'),
        ),
      ),
    ],
  },
  {
    fn: 'pptxDeckshape.index.setElementTextBodyProps',
    call: (t, a) => run(t, a, (c, x) => setElementTextBodyProps(c.slide, c.id, x.patch)),
    built: [
      {},
      { vert: 'horz' },
      { vert: 'eaVert' },
      { vert: 'wordArtVert' },
      { autofit: 'none' },
      { autofit: 'shrink' },
      { autofit: 'resize' },
      { wrap: true },
      { wrap: false },
      { insets: { l: 1.5, t: -3, r: 0, b: 7 } },
      { insets: {} },
      { vert: 'vert270', wrap: true, autofit: 'shrink', insets: { l: 10, b: 20 } },
    ].flatMap((patch) => ELEMENTS.map((e) => at(0, e, { patch }))),
  },
  {
    fn: 'pptxDeckshape.index.setElementEffects',
    call: (t, a) => run(t, a, (c, x) => setElementEffects(c.slide, c.id, x.patch)),
    built: [
      {},
      { shadow: { color: '#112233', blurRad: 5.5, dist: 3, dirDeg: -45 } },
      {
        shadow: {
          color: '#11223380',
          blurRad: 0,
          dist: 0,
          dirDeg: 400,
          sx: 2,
          sy: 1,
          kxDeg: 3,
          kyDeg: 4,
          algn: 'tl',
        },
      },
      { shadow: { color: 'zz', blurRad: 1, dist: 1, dirDeg: 0, inner: true, sx: 2 } },
      { shadow: null },
      { glow: { color: '#FF0000', radius: 12.4 } },
      { glow: null },
      { reflection: { blurRad: 3, startA: 0.5, endPos: 2, dist: 1 } },
      { reflection: { blurRad: 0, startA: -1, endPos: 0.3, dist: 0 } },
      { reflection: null },
      { softEdge: 5.5 },
      { softEdge: -2 },
      { softEdge: null },
      { shadow: null, glow: null, reflection: null, softEdge: null },
    ]
      .flatMap((patch) => [...ELEMENTS, 8].map((e) => at(0, e, { patch })))
      .concat(
        [
          { shadow: { color: '#000000', blurRad: 1, dist: 1, dirDeg: 1 }, softEdge: 3 },
          { softEdge: null },
        ].map((patch) => at(0, 0, { patch }, PIC_TEXTS[0]!)),
        [0, 1].map((e) =>
          at(0, e, { patch: { glow: { color: '#00FF00', radius: 1 } } }, PIC_TEXTS[0]!),
        ),
      ),
  },
  {
    fn: 'pptxDeckshape.index.setElementFill',
    call: (t, a) =>
      run(t, a, (c, x) =>
        setElementFill(
          c.opened,
          c.slide,
          c.id,
          x.fill,
          x.groupId ? { groupId: c.a.slide(x.slide).elements[x.group]?.id ?? '' } : {},
        ),
      ),
    built: [
      'none',
      '#00FF00',
      '#00FF0080',
      {
        stops: [
          { pos: 0, color: '#FF0000' },
          { pos: 1, color: '#0000FF' },
        ],
        angle: 5400000,
      },
      {
        stops: [
          { pos: 0, color: '#FF0000' },
          { pos: 1, color: '#0000FF' },
        ],
        radial: true,
      },
      {
        stops: [{ pos: 0, color: '#FF0000' }],
        path: 'rect',
        fillTo: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 },
      },
    ]
      .flatMap((fill) => [...ELEMENTS, 8].map((e) => at(0, e, { fill })))
      .concat(
        [6, 7].flatMap((_) => [
          at(0, 0, { fill: '#123456', groupId: true, group: 6 }),
          at(0, 0, { fill: 'none', groupId: true, group: 0 }),
          at(0, 0, { fill: 'none', groupId: true, group: 99 }),
        ]),
      ),
  },
  {
    fn: 'pptxDeckshape.index.setElementImageFill',
    call: (t, a) =>
      run(t, a, (c, x) =>
        setElementImageFill(
          c.opened,
          c.slide,
          c.id,
          x.mediaPath !== undefined
            ? { mediaPath: x.mediaPath }
            : { bytes: bytes(x.bytes)!, ext: x.ext },
          {
            ...(x.tile !== undefined ? { tile: x.tile } : {}),
            ...(x.groupId ? { groupId: c.a.slide(x.slide).elements[x.group]?.id ?? '' } : {}),
          },
        ),
      ),
    built: [
      { bytes: PNG, ext: 'png' },
      { bytes: PNG, ext: 'PNG', tile: true },
      { bytes: PNG, ext: 'xyz' },
      { mediaPath: 'ppt/media/missing.png' },
      { mediaPath: 'ppt/media/image1.png' },
      { bytes: PNG2, ext: 'jpg', tile: false },
    ]
      .flatMap((rest) => [0, 1, 6, 7, 99].map((e) => at(0, e, rest)))
      .concat([
        at(0, 0, { bytes: PNG, ext: 'png', groupId: true, group: 6 }),
        at(0, 0, { bytes: PNG, ext: 'png', groupId: true, group: 0 }),
      ]),
  },
  {
    fn: 'pptxDeckshape.index.setElementRedaction',
    call: (t, a) => run(t, a, (c, x) => setElementRedaction(c.slide, c.id, x.label ?? null)),
    built: [null, '', '  ', 'secret', ' a<b>"c" ', '\u{1F600}'].flatMap((label) =>
      [0, 1, 99].map((e) => at(0, e, { label }, PIC_TEXTS[0]!)),
    ),
  },
  {
    fn: 'pptxDeckshape.index.setPictureOpacity',
    call: (t, a) => run(t, a, (c, x) => setPictureOpacity(c.slide, c.id, x.opacity)),
    built: [0.5, 0, 1, 1.5, -1, 0.9995, 0.3333333].flatMap((opacity) =>
      PIC_TEXTS.flatMap((t) => [0, 99].map((e) => at(0, e, { opacity }, t))),
    ),
  },
  {
    fn: 'pptxDeckshape.index.replacePictureBytes',
    call: (t, a) =>
      run(t, a, (c, x) =>
        replacePictureBytes(
          c.opened,
          c.slide,
          c.id,
          bytes(x.bytes)!,
          x.ext,
          x.keep === undefined ? undefined : { keepSrcRect: x.keep },
        ),
      ),
    built: PIC_TEXTS.flatMap((t) =>
      [
        { bytes: PNG, ext: 'png' },
        { bytes: PNG2, ext: 'jpeg', keep: true },
        { bytes: PNG, ext: 'bad' },
      ].flatMap((rest) => [0, 99].map((e) => at(0, e, rest, t))),
    ),
  },
]
