import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applyImageWrap,
  applyImageZOrder,
  applyShapeZOrderAt,
  buildAnchoredTextboxParagraphXml,
  buildLineParagraphXml,
  buildShapeParagraphXml,
  buildTextboxParagraphXml,
  buildWordArtParagraphXml,
  inlinePictureDrawingXml,
  patchDrawingExtent,
  patchShapeStyles,
  patchTextboxHeights,
  patchTextboxSizes,
  resizeAnchoredPictureXml,
  resizeInlinePictureXml,
  swapAnchorWrap,
  type AnchoredTextboxOptions,
} from '../src/generate'
import { anchoredInkRunXml } from '../src/ink'

/**
 * A number that cannot be written as an integer attribute (NaN, an infinity,
 * or a value whose decimal form needs an exponent) must never reach the XML.
 * A patch keeps what the XML held; a builder refuses the call.
 */

const NON_FINITE = [NaN, Infinity, -Infinity] as const
const UNREPRESENTABLE = [NaN, Infinity, -Infinity, 1e20] as const

const expectClean = (xml: string) => expect(xml).not.toMatch(/NaN|Infinity|\de\+\d/)

const expectRefusal = (build: () => unknown, option: string) => {
  let thrown: unknown
  try {
    build()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(RangeError)
  expect((thrown as RangeError).message).toBe(`a non-finite number: ${option}`)
}

const PIC_INLINE = `<w:p><w:r>${inlinePictureDrawingXml({ rId: 'rId1', docPrId: 1, widthPx: 100, heightPx: 50 })}</w:r></w:p>`
const PIC_ANCHOR = applyImageWrap(PIC_INLINE, 'square-left', { x: 12700, y: 25400 }, undefined, 4)
const SHAPE = buildShapeParagraphXml({ prst: 'rect', withTextbox: true })

const TXBX = '<w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent>'
/** an anchored textbox with the VML twin Word writes, sized in points */
const TEXTBOX =
  '<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
  '<mc:Choice Requires="wps"><w:drawing>' +
  '<wp:anchor behindDoc="0" simplePos="0" relativeHeight="251658240" locked="0" layoutInCell="1" allowOverlap="1">' +
  '<wp:simplePos x="0" y="0"/><wp:extent cx="6038850" cy="1704975"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6038850" cy="1704975"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
  `<wps:txbx>${TXBX}</wps:txbx><wps:bodyPr><a:spAutoFit/></wps:bodyPr></wps:wsp>` +
  '</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>' +
  '<mc:Fallback><w:pict>' +
  '<v:rect xmlns:v="urn:schemas-microsoft-com:vml" style="position:absolute;width:475.5pt;height:134.25pt">' +
  `<v:textbox>${TXBX}</v:textbox></v:rect>` +
  '</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>'

describe('patches keep the XML when a number is not representable', () => {
  it.each(UNREPRESENTABLE)('applyImageWrap posOffset.x = %s keeps the anchor positionH', (x) => {
    const out = applyImageWrap(PIC_ANCHOR, 'square-left', { x, y: 25400 }, undefined, 4)
    expect(out).toBe(PIC_ANCHOR)
    expectClean(out)
  })

  it.each(UNREPRESENTABLE)('applyImageWrap posOffset.y = %s keeps the anchor positionV', (y) => {
    const out = applyImageWrap(PIC_ANCHOR, 'square-left', { x: 12700, y }, undefined, 4)
    expect(out).toBe(PIC_ANCHOR)
    expectClean(out)
  })

  it.each(UNREPRESENTABLE)('applyImageWrap posOffset.x = %s on an inline picture', (x) => {
    const out = applyImageWrap(PIC_INLINE, 'square-left', { x, y: 25400 })
    const expected = applyImageWrap(PIC_INLINE, 'square-left', { x: 0, y: 25400 }).replace(
      '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>',
      '<wp:positionH relativeFrom="column"><wp:align>left</wp:align></wp:positionH>',
    )
    expect(out).toBe(expected)
    expectClean(out)
  })

  it.each(UNREPRESENTABLE)('applyImageWrap zOrder = %s keeps the anchor rank', (z) => {
    const out = applyImageWrap(PIC_ANCHOR, 'square-left', { x: 12700, y: 25400 }, undefined, z)
    expect(out).toBe(PIC_ANCHOR)
  })

  it.each(UNREPRESENTABLE)(
    'applyImageWrap zOrder = %s on an inline picture is the base rank',
    (z) => {
      const out = applyImageWrap(PIC_INLINE, 'square-left', undefined, undefined, z)
      expect(out).toBe(applyImageWrap(PIC_INLINE, 'square-left'))
      expectClean(out)
    },
  )

  it.each(UNREPRESENTABLE)('applyImageZOrder zOrder = %s', (z) => {
    expect(applyImageZOrder(PIC_ANCHOR, z)).toBe(PIC_ANCHOR)
  })

  it.each(UNREPRESENTABLE)('applyShapeZOrderAt zOrder = %s', (z) => {
    expect(applyShapeZOrderAt(SHAPE, { boxIndex: 0 }, z)).toBe(SHAPE)
  })

  it.each(UNREPRESENTABLE)('swapAnchorWrap zOrder = %s still swaps the wrap', (z) => {
    const out = swapAnchorWrap(SHAPE, 'behind', z)
    expect(out).toBe(swapAnchorWrap(SHAPE, 'behind'))
    expect(out).toContain('behindDoc="1"')
    expectClean(out)
  })

  it.each([NaN, Infinity])('patchTextboxHeights height = %s', (h) => {
    expect(patchTextboxHeights(TEXTBOX, [h])).toBe(TEXTBOX)
  })

  // the twins agree: DrawingML clamps to 1 EMU, VML to its two-decimal 0pt
  it('patchTextboxHeights height = -Infinity writes the clamped size into both twins', () => {
    const out = patchTextboxHeights(TEXTBOX, [-Infinity])
    expect(out).toBe(
      TEXTBOX.replaceAll('cy="1704975"', 'cy="1"').replace('height:134.25pt', 'height:0pt'),
    )
    expectClean(out)
  })

  // 1e20 px has VML points in plain digits but no EMU: neither twin changes
  it.each([1e20, 1e22])('patchTextboxHeights height = %s changes neither twin', (h) => {
    expect(patchTextboxHeights(TEXTBOX, [h])).toBe(TEXTBOX)
  })

  // 1e22 px: neither the EMU extent nor the VML points have plain-digit text
  it.each([NaN, Infinity, 1e20, 1e22])('patchTextboxSizes width = %s', (w) => {
    const out = patchTextboxSizes(TEXTBOX, [{ wPx: w, hPx: 240 }])
    expect(out).toBe(patchTextboxSizes(TEXTBOX, [{ hPx: 240 }]))
    expectClean(out)
  })

  it.each([NaN, Infinity, 1e20, 1e22])('patchTextboxSizes height = %s', (h) => {
    const out = patchTextboxSizes(TEXTBOX, [{ wPx: 300, hPx: h }])
    expect(out).toBe(patchTextboxSizes(TEXTBOX, [{ wPx: 300 }]))
    expect(out).toContain('<a:spAutoFit/>')
    expectClean(out)
  })

  it('patchTextboxSizes -Infinity writes the clamped size into both twins', () => {
    expect(patchTextboxSizes(TEXTBOX, [{ wPx: -Infinity }])).toBe(
      TEXTBOX.replaceAll('cx="6038850"', 'cx="1"').replace('width:475.5pt', 'width:0pt'),
    )
    expect(patchTextboxSizes(TEXTBOX, [{ hPx: -Infinity }])).toBe(
      TEXTBOX.replaceAll('cy="1704975"', 'cy="1"')
        .replace('<a:spAutoFit/>', '<a:noAutofit/>')
        .replace('height:134.25pt', 'height:0pt'),
    )
  })

  it.each(NON_FINITE)('patchShapeStyles rotDeg = %s', (rotDeg) => {
    expect(patchShapeStyles(SHAPE, [{ rotDeg }])).toBe(SHAPE)
    const rotated = patchShapeStyles(SHAPE, [{ rotDeg: 90 }])
    expect(patchShapeStyles(rotated, [{ rotDeg }])).toBe(rotated)
    const out = patchShapeStyles(SHAPE, [{ rotDeg, fillHex: 'FF0000' }])
    expect(out).toBe(patchShapeStyles(SHAPE, [{ fillHex: 'FF0000' }]))
    expectClean(out)
  })

  it.each([NaN, Infinity, 1e20])('patchShapeStyles borderWidthPx = %s', (borderWidthPx) => {
    expect(patchShapeStyles(SHAPE, [{ borderWidthPx }])).toBe(SHAPE)
    const sized = patchShapeStyles(SHAPE, [{ borderWidthPx: 2 }])
    expect(patchShapeStyles(sized, [{ borderWidthPx }])).toBe(sized)
    const line = buildLineParagraphXml({ kind: 'line' }).replace('<a:ln w="12700">', '<a:ln>')
    expect(patchShapeStyles(line, [{ borderWidthPx }])).toBe(line)
  })

  it('patchShapeStyles borderWidthPx = -Infinity keeps the clamped 1 EMU', () => {
    expect(patchShapeStyles(SHAPE, [{ borderWidthPx: -Infinity }])).toBe(
      patchShapeStyles(SHAPE, [{ borderWidthPx: 0 }]),
    )
  })

  it.each([NaN, Infinity, 1e20])('patchDrawingExtent dimension = %s', (bad) => {
    const wide = patchDrawingExtent(PIC_INLINE, bad, 60)
    expect(wide).toBe(patchDrawingExtent(PIC_INLINE, 100, 60))
    expectClean(wide)
    expect(patchDrawingExtent(PIC_INLINE, 120, bad)).toBe(patchDrawingExtent(PIC_INLINE, 120, 50))
  })

  it('patchDrawingExtent -Infinity keeps the clamped 1 EMU', () => {
    expect(patchDrawingExtent(PIC_INLINE, -Infinity, 60)).toBe(
      patchDrawingExtent(PIC_INLINE, 0, 60),
    )
  })

  it.each(UNREPRESENTABLE)('resizeInlinePictureXml dimension = %s', (bad) => {
    const wide = resizeInlinePictureXml(PIC_INLINE, bad, 60)
    expect(wide).toBe(bad > 0 ? resizeInlinePictureXml(PIC_INLINE, 100, 60) : PIC_INLINE)
    expectClean(wide)
    expect(resizeInlinePictureXml(PIC_INLINE, 120, bad)).toBe(
      bad > 0 ? resizeInlinePictureXml(PIC_INLINE, 120, 50) : PIC_INLINE,
    )
  })

  it.each(UNREPRESENTABLE)('resizeAnchoredPictureXml dimension = %s', (bad) => {
    const wide = resizeAnchoredPictureXml(PIC_ANCHOR, bad, 60)
    expect(wide).toBe(bad > 0 ? resizeAnchoredPictureXml(PIC_ANCHOR, 100, 60) : PIC_ANCHOR)
    expectClean(wide)
    expect(resizeAnchoredPictureXml(PIC_ANCHOR, 120, bad)).toBe(
      bad > 0 ? resizeAnchoredPictureXml(PIC_ANCHOR, 120, 50) : PIC_ANCHOR,
    )
  })
})

const ANCHORED_BASE: AnchoredTextboxOptions = {
  anchor: 'paragraph',
  xEmu: 0,
  yEmu: 0,
  widthEmu: 1000000,
  heightEmu: 500000,
  paragraphs: [{ runs: [{ text: 'x' }] }],
}
const INSETS = { l: 0, t: 0, r: 0, b: 0 }

/** [builder, option, call with that option set to the value] */
const BUILDER_NUMBERS: Array<[string, string, (v: number) => string]> = [
  [
    'buildLineParagraphXml',
    'widthEmu',
    (v) => buildLineParagraphXml({ kind: 'line', widthEmu: v }),
  ],
  [
    'buildLineParagraphXml',
    'heightEmu',
    (v) => buildLineParagraphXml({ kind: 'line', heightEmu: v }),
  ],
  [
    'inlinePictureDrawingXml',
    'widthPx',
    (v) => inlinePictureDrawingXml({ rId: 'rId1', docPrId: 1, widthPx: v, heightPx: 10 }),
  ],
  [
    'inlinePictureDrawingXml',
    'heightPx',
    (v) => inlinePictureDrawingXml({ rId: 'rId1', docPrId: 1, widthPx: 10, heightPx: v }),
  ],
  [
    'inlinePictureDrawingXml',
    'rotDeg',
    (v) =>
      inlinePictureDrawingXml({ rId: 'rId1', docPrId: 1, widthPx: 10, heightPx: 10, rotDeg: v }),
  ],
  ['buildTextboxParagraphXml', 'widthEmu', (v) => buildTextboxParagraphXml({ widthEmu: v })],
  ['buildTextboxParagraphXml', 'heightEmu', (v) => buildTextboxParagraphXml({ heightEmu: v })],
  ...(
    [
      'xEmu',
      'yEmu',
      'widthEmu',
      'heightEmu',
      'zOrder',
      'holderLineTwips',
      'holderSpacingBeforeTwips',
    ] as const
  ).map((option): [string, string, (v: number) => string] => [
    'buildAnchoredTextboxParagraphXml',
    option,
    (v) => buildAnchoredTextboxParagraphXml({ ...ANCHORED_BASE, [option]: v }),
  ]),
  ...(['l', 't', 'r', 'b'] as const).map((side): [string, string, (v: number) => string] => [
    'buildAnchoredTextboxParagraphXml',
    `insetsEmu.${side}`,
    (v) =>
      buildAnchoredTextboxParagraphXml({ ...ANCHORED_BASE, insetsEmu: { ...INSETS, [side]: v } }),
  ]),
  [
    'buildShapeParagraphXml',
    'widthEmu',
    (v) => buildShapeParagraphXml({ prst: 'rect', widthEmu: v }),
  ],
  [
    'buildShapeParagraphXml',
    'heightEmu',
    (v) => buildShapeParagraphXml({ prst: 'rect', heightEmu: v }),
  ],
  ['buildWordArtParagraphXml', 'widthEmu', (v) => buildWordArtParagraphXml({ widthEmu: v })],
  ['buildWordArtParagraphXml', 'heightEmu', (v) => buildWordArtParagraphXml({ heightEmu: v })],
  ['anchoredInkRunXml', 'offsetXPx', (v) => inkRun({ offsetXPx: v })],
  ['anchoredInkRunXml', 'offsetYPx', (v) => inkRun({ offsetYPx: v })],
  ['anchoredInkRunXml', 'widthPx', (v) => inkRun({ widthPx: v })],
  ['anchoredInkRunXml', 'heightPx', (v) => inkRun({ heightPx: v })],
]

const BUILDER_IDS: Array<[string, string, (v: number) => string]> = [
  ['buildLineParagraphXml', 'id', (v) => buildLineParagraphXml({ kind: 'line', id: v })],
  [
    'inlinePictureDrawingXml',
    'docPrId',
    (v) => inlinePictureDrawingXml({ rId: 'rId1', docPrId: v, widthPx: 10, heightPx: 10 }),
  ],
  ['buildTextboxParagraphXml', 'id', (v) => buildTextboxParagraphXml({ id: v })],
  [
    'buildAnchoredTextboxParagraphXml',
    'id',
    (v) => buildAnchoredTextboxParagraphXml({ ...ANCHORED_BASE, id: v }),
  ],
  ['buildShapeParagraphXml', 'id', (v) => buildShapeParagraphXml({ prst: 'rect', id: v })],
  ['buildWordArtParagraphXml', 'id', (v) => buildWordArtParagraphXml({ id: v })],
  ['anchoredInkRunXml', 'docPrId', (v) => anchoredInkRunXml(INK, 'rId1', v)],
]

const INK = { widthPx: 10, heightPx: 10, offsetXPx: 0, offsetYPx: 0 }
function inkRun(change: Partial<typeof INK>): string {
  return anchoredInkRunXml({ ...INK, ...change }, 'rId1', 1)
}

/**
 * Calls whose result today already carries no NaN/Infinity (a clamp, a
 * fallback, a falsy skip, or a rotation folded into one turn): they stay.
 */
const KEPT_TODAY = [
  'inlinePictureDrawingXml widthPx -Infinity',
  'inlinePictureDrawingXml heightPx -Infinity',
  'inlinePictureDrawingXml rotDeg NaN',
  'inlinePictureDrawingXml rotDeg 100000000000000000000',
  'buildAnchoredTextboxParagraphXml holderSpacingBeforeTwips NaN',
  ...['offsetXPx', 'offsetYPx', 'widthPx', 'heightPx'].flatMap((option) =>
    NON_FINITE.map((v) => `anchoredInkRunXml ${option} ${v}`),
  ),
]

describe('builders refuse a number they cannot write', () => {
  const cases = BUILDER_NUMBERS.flatMap(([builder, option, build]) =>
    UNREPRESENTABLE.map((v) => [`${builder} ${option} ${v}`, option, build, v] as const),
  )

  it.each(cases)('%s', (label, option, build, v) => {
    if (KEPT_TODAY.includes(label)) expectClean(build(v))
    else expectRefusal(() => build(v), option)
  })

  it.each(
    BUILDER_IDS.flatMap(([builder, option, build]) =>
      [NaN, Infinity, -Infinity, 2.5, 1e21].map(
        (v) => [`${builder} ${option} ${v}`, option, build, v] as const,
      ),
    ),
  )('%s', (_label, option, build, v) => {
    expectRefusal(() => build(v), option)
  })

  it('keeps the results that never carried a non-finite number', () => {
    const picture = (o: { widthPx?: number; rotDeg?: number }) =>
      inlinePictureDrawingXml({ rId: 'rId1', docPrId: 1, widthPx: 10, heightPx: 10, ...o })
    expect(picture({ widthPx: -Infinity })).toContain('<wp:extent cx="1" cy="95250"/>')
    expect(picture({ rotDeg: NaN })).toBe(picture({}))
    expect(
      buildAnchoredTextboxParagraphXml({ ...ANCHORED_BASE, holderSpacingBeforeTwips: NaN }),
    ).toBe(buildAnchoredTextboxParagraphXml({ ...ANCHORED_BASE, holderSpacingBeforeTwips: 0 }))
    expect(inkRun({ offsetXPx: NaN })).toBe(inkRun({ offsetXPx: 0 }))
    expect(inkRun({ widthPx: Infinity })).toContain('<wp:extent cx="1" cy="95250"/>')
  })

  it('rounds a fractional size instead of writing it verbatim', () => {
    expect(buildShapeParagraphXml({ prst: 'rect', widthEmu: 2.5 })).toContain(
      '<wp:extent cx="3" cy="1080000"/>',
    )
  })
})

/** One finite call per function; the digests were taken before the guard landed. */
const FINITE: Array<[string, () => string]> = [
  ['applyImageWrap', () => PIC_ANCHOR],
  ['applyImageZOrder', () => applyImageZOrder(PIC_ANCHOR, 7)],
  ['applyShapeZOrderAt', () => applyShapeZOrderAt(SHAPE, { boxIndex: 0 }, 3)],
  ['swapAnchorWrap', () => swapAnchorWrap(SHAPE, 'behind', 2)],
  ['patchTextboxHeights', () => patchTextboxHeights(TEXTBOX, [240])],
  ['patchTextboxSizes', () => patchTextboxSizes(TEXTBOX, [{ wPx: 300.3, hPx: 240 }])],
  ['patchShapeStyles', () => patchShapeStyles(SHAPE, [{ rotDeg: 45.5, borderWidthPx: 2 }])],
  ['patchDrawingExtent', () => patchDrawingExtent(PIC_INLINE, 120, 60)],
  ['resizeInlinePictureXml', () => resizeInlinePictureXml(PIC_INLINE, 120.5, 60)],
  ['resizeAnchoredPictureXml', () => resizeAnchoredPictureXml(PIC_ANCHOR, 120, 60)],
  [
    'buildLineParagraphXml',
    () => buildLineParagraphXml({ kind: 'lineArrow', widthEmu: 1905000, heightEmu: 114300, id: 7 }),
  ],
  [
    'inlinePictureDrawingXml',
    () =>
      inlinePictureDrawingXml({
        rId: 'rId3',
        docPrId: 5,
        widthPx: 120.4,
        heightPx: 60,
        rotDeg: 30,
        flipH: true,
        altText: 'a',
      }),
  ],
  [
    'buildTextboxParagraphXml',
    () => buildTextboxParagraphXml({ widthEmu: 1800000, heightEmu: 1080000, id: 3 }),
  ],
  [
    'buildAnchoredTextboxParagraphXml',
    () =>
      buildAnchoredTextboxParagraphXml({
        ...ANCHORED_BASE,
        xEmu: 91440.4,
        yEmu: 12700,
        widthEmu: 2000000,
        heightEmu: 800000,
        id: 4,
        zOrder: 2,
        insetsEmu: { l: 1.4, t: 2, r: 3, b: 4.6 },
        holderLineTwips: 20.6,
        holderSpacingBeforeTwips: 240,
        cornerRadiusEmu: 100000,
        fillHex: 'FFFFFF',
        borderHex: '000000',
      }),
  ],
  [
    'buildShapeParagraphXml',
    () =>
      buildShapeParagraphXml({
        prst: 'ellipse',
        widthEmu: 1000000,
        heightEmu: 500000,
        id: 9,
        withTextbox: true,
      }),
  ],
  [
    'buildWordArtParagraphXml',
    () =>
      buildWordArtParagraphXml({
        text: 'Hi',
        widthEmu: 2700000,
        heightEmu: 720000,
        id: 2,
        italic: true,
      }),
  ],
  [
    'anchoredInkRunXml',
    () =>
      anchoredInkRunXml(
        { widthPx: 200.4, heightPx: 100, offsetXPx: 10.6, offsetYPx: -20, payload: 'p' },
        'rId7',
        3,
      ),
  ],
]

const TODAY: Record<string, string> = {
  applyImageWrap: 'd51353da87e53fae6ff019d9f00fe8a8bf1b1f870c8b2557f0d173cfabe066e0',
  applyImageZOrder: '20cb6d8906018dd2c58948b5216080ac24ceb1f2588c18bdfe7deb6551d19952',
  applyShapeZOrderAt: 'b7c6c9c955e459d4abec81ddef851268d38e3ecca715d6359f0031813e54fa95',
  swapAnchorWrap: '86fa179d966fca71d3b34e48a008caaf7a395689cac3960f49b04bcfba037c33',
  patchTextboxHeights: '6a160a44a0d92104540899cd9df78df0cf0472a11b6aaf132356adcd4915e5ee',
  patchTextboxSizes: '6d13813a8ff2a4733843c910e9aa738802fae5a0b8d1ff003633bb937095d431',
  patchShapeStyles: 'caf0558b4b1826f36e20c188e9dea7f1bb0d2154a2da3f7b0991c2ef1e41e5c0',
  patchDrawingExtent: 'd1563963adb1be83a5cef62959ac90a06236574674eed835d447cc9db388b896',
  resizeInlinePictureXml: 'feb50f0baa726f720c33fadc58c26693e399ec87f54e47e1c2e60ac091a0e4d2',
  resizeAnchoredPictureXml: 'c5e47dba6eebf06c7f659736c79412e42ea0c4bf79a82cd042c77cdd84cdca12',
  buildLineParagraphXml: '5e6ff0e9ec0fc9aeb47b8d4470f44fef8a3ba9e737e9da7ff3c0e090eb3fc35d',
  inlinePictureDrawingXml: '7a0a8e118d76ccba4069d2028686b0c5c6bc8f79a98c5356fd5cdc10839f6393',
  buildTextboxParagraphXml: '1c8a679a04d967bb71a3daf3650652e236b9970457aebda99cc410ecaaf0abb6',
  buildAnchoredTextboxParagraphXml:
    '7e391e43597f7be33ef81822437ec3417acebceedb9f99fe276a4cc360378386',
  buildShapeParagraphXml: '0f4019451822841831644c8e249012ef09b40683649e61127a35dbc889bfbf4c',
  buildWordArtParagraphXml: 'ce890dd02950eb5f8f360141ee1e4be540c0296e6a4329eb99f9eb03c095bb32',
  anchoredInkRunXml: '0dea4097f55bf34be02edb4999d5739640bfbdaa6d47217440e0a4f82989dfe4',
}

describe('finite input keeps its bytes', () => {
  it.each(FINITE)('%s', (name, run) => {
    expect(createHash('sha256').update(run()).digest('hex')).toBe(TODAY[name])
  })
})
