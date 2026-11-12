// Group `deckgroups` of comparison (f): index.ts of packages/pptx-engine,
// lines 4179-4841 (element clipboard, slide transitions, advance time, hidden
// slides, reassembleSlideXml, group / ungroup, in-group editing). The Rust side
// answers in crates/office-wasm/src/calls/pptx_deckgroups.rs to
// `pptxDeckgroups.index.<TypeScript name>`.
//
// Every input is the deck 'blank deck' with its first slide replaced by a slide
// written here (`textPart`): a group with scaled child coordinates holding a
// text box, a shape, a picture, a child without cNvPr, a nested group, a
// connector, a graphic frame and a markup-compatibility block.
//
// Private functions are proven through the export that reaches them:
//   elementEnd, patchElementXfrmDirect  -> groupChildSlices, ungroupElement
//   relTargetFromSlide, RID_ATTR_RE     -> copyElementData, pasteElements
//   modelStrokeToPatch (unreachable: nothing calls it)
import {
  copyElementData,
  editGroupChildFill,
  editGroupChildStroke,
  editGroupChildTransform,
  findGroupChild,
  getSlideAdvanceTime,
  getSlideHidden,
  getSlideTransition,
  groupChildSlices,
  groupElements,
  patchGroupChildText,
  patchGroupChildXml,
  pasteElements,
  reassembleSlideXml,
  setGroupChildFont,
  setGroupChildShapeAdjustValues,
  setGroupChildShapeCustomGeometry,
  setGroupChildShapePresetGeometry,
  setSlideAdvanceTime,
  setSlideHidden,
  setSlideTransition,
  strokePatchToModel,
  ungroupElement,
  type ElementClipboardItem,
} from '../../packages/pptx-engine/src/index'
import type { GroupElement, TextElement } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { type At, deckInput, deckOp } from './deck-ops'
import { withUuid } from './calls-leaves'

type Args = Record<string, unknown>
type Opened = Parameters<typeof copyElementData>[0]

const UUID = '6f1d2c3b-4a59-4687-9e0d-1c2b3a495867'
const SLIDE_PART = 'ppt/slides/slide1.xml'
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const xfrm = (x: number, y: number, cx: number, cy: number, attrs = '') =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

const textSp = (id: number, name: string, x: number, y: number, text: string, link = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${xfrm(x, y, 900000, 300000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${link ? `<a:rPr lang="en-US"><a:hlinkClick r:id="${link}"/></a:rPr>` : '<a:rPr lang="en-US"/>'}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const shapeSp = (id: number, name: string, x: number, y: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${xfrm(x, y, 600000, 400000, ' rot="1200000"')}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 20000"/></a:avLst></a:prstGeom>` +
  `<a:solidFill><a:srgbClr val="336699"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>Shape ${id}</a:t></a:r></a:p></p:txBody></p:sp>`

const pic = (id: number, name: string, x: number, y: number) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
  `<p:blipFill><a:blip r:embed="rId77"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr>${xfrm(x, y, 500000, 500000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const bareSp = (x: number) =>
  `<p:sp><p:spPr>${xfrm(x, 100000, 100000, 100000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>`

const cxn = (id: number, x: number, y: number) =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
  `<p:spPr>${xfrm(x, y, 400000, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>`

const frame = (id: number, x: number, y: number) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="300000" cy="300000"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="urn:gate"/></a:graphic></p:graphicFrame>`

const compat = (id: number) =>
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
  `<mc:Choice Requires="p14">${shapeSp(id, `Choice ${id}`, 10, 10)}</mc:Choice>` +
  `<mc:Fallback>${shapeSp(id + 1, `Fallback ${id}`, 10, 10)}</mc:Fallback></mc:AlternateContent>`

const group = (
  id: number,
  name: string,
  box: [number, number, number, number],
  child: [number, number, number, number] | null,
  inner: string,
  attrs = '',
) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr>${
    child
      ? `<a:xfrm${attrs}><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/>` +
        `<a:chOff x="${child[0]}" y="${child[1]}"/><a:chExt cx="${child[2]}" cy="${child[3]}"/></a:xfrm>`
      : ''
  }</p:grpSpPr>${inner}</p:grpSp>`

const NESTED = group(
  20,
  'Nested',
  [100, 100, 400, 400],
  [0, 0, 200, 200],
  shapeSp(21, 'Inner shape', 20, 20) + cxn(22, 30, 30) + frame(23, 40, 40),
)

/** Top-level elements 0-9: text, shape, picture, hyperlinked text, group, empty group, bare group, connector, frame. */
const TREE =
  textSp(2, 'Text 2', 100000, 100000, 'First') +
  shapeSp(3, 'Shape 3', 1200000, 100000) +
  pic(4, 'Picture 4', 100000, 800000) +
  textSp(5, 'Link 5', 1200000, 800000, 'Link', 'rId1') +
  group(
    10,
    'Group 10',
    [2000000, 2000000, 4000000, 2000000],
    [0, 0, 2000000, 1000000],
    textSp(11, 'Child text', 100000, 100000, 'Child &amp; text') +
      shapeSp(12, 'Child shape', 800000, 100000) +
      pic(13, 'Child picture', 100000, 600000) +
      bareSp(5) +
      NESTED +
      compat(30),
    ' rot="900000" flipH="1"',
  ) +
  group(41, 'Empty group', [3000000, 100000, 100, 100], [0, 0, 100, 100], '') +
  group(42, 'Bare group', [0, 0, 0, 0], null, textSp(43, 'Orphan', 1, 1, 'Orphan')) +
  cxn(6, 3000000, 3000000) +
  frame(7, 4000000, 3000000)

const slideXml = (root = '', tail = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>', tree = TREE) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}${root}><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld>${tail}</p:sld>`

const BASE = slideXml()
const TIMED = slideXml(
  ' show="0"',
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition spd="med" advTm="3000"><p:wipe dir="r"/></p:transition><p:timing/>',
)
const MORPH = slideXml(
  '',
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" Requires="p159">' +
    '<p:transition spd="slow" advTm="1500"><p159:morph option="byObject"/></p:transition></mc:Choice>' +
    '<mc:Fallback><p:transition spd="slow" advTm="1500"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>',
)
const NO_SUFFIX_ANCHOR = slideXml('', '')
const EMPTY_TREE = slideXml('', '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>', '')

const input = (rest: Args, text: string = BASE): Input =>
  deckInput('blank deck', rest, { part: SLIDE_PART, text })

const groupOf = (opened: Opened, a: Args): GroupElement | undefined =>
  opened.deck.slides[a.slide as number]?.elements[a.element as number] as GroupElement | undefined

const groupId = (at: At, a: Args): string =>
  typeof a.groupId === 'string' ? a.groupId : at.element(a.slide as number, a.element as number)

const childId = (opened: Opened, a: Args): string =>
  typeof a.childId === 'string' ? a.childId : (groupOf(opened, a)?.children?.[a.child as number]?.id ?? '')

const spec = (
  fn: string,
  run: (opened: Opened, at: At, args: Args) => unknown,
  built: Input[],
): CallSpec => ({
  fn: `pptxDeckgroups.index.${fn}`,
  call: (text, args) => deckOp(text, args, (opened, at) => withUuid(UUID, () => run(opened, at, args))),
  built,
})

const everyChild = (rest: Args, count = 7): Input[] =>
  Array.from({ length: count }, (_, child) => input({ slide: 0, element: 4, child, ...rest }))

// ── clipboard ───────────────────────────────────────────────────────────
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
const LAYOUT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

const withCreation = (id: number) =>
  textSp(id, `Copy ${id}`, 500, 600, 'Pasted').replace(
    '/>',
    `><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"/></a:ext></a:extLst></p:cNvPr>`,
  )

const ITEM_PLAIN: ElementClipboardItem = { xml: withCreation(7), rels: [] }
const ITEM_PICTURE: ElementClipboardItem = {
  xml: pic(8, 'Pasted picture', 700, 800).replace('rId77', 'rId5'),
  rels: [{ rid: 'rId5', type: IMAGE, target: 'ppt/media/pasted.png' }],
  parts: { 'ppt/media/pasted.png': 'iVBORw0KGgo=' },
  contentTypes: { png: 'image/png' },
}
const ITEM_LINKS: ElementClipboardItem = {
  xml: textSp(9, 'Links', 5, 6, 'Links', 'rId7').replace(
    '</p:sp>',
    '<a:ext r:link="rId9" r:embed="rId9"/></p:sp>',
  ),
  rels: [
    { rid: 'rId7', type: HYPERLINK, target: 'https://example.com/?a=$&b=$$&c=<d>', external: true },
    { rid: 'rId9', type: LAYOUT, target: 'ppt/slideLayouts/slideLayout1.xml' },
    { rid: 'rId11', type: SLIDE_REL, target: 'ppt/slides/slide2.xml' },
  ],
}
const ITEM_GROUP: ElementClipboardItem = {
  xml: group(60, 'Pasted group', [10, 20, 30, 40], [1, 2, 3, 4], textSp(61, 'In', 1, 2, 'In')),
  rels: [],
  parts: { 'ppt/media/a.bin': 'AAEC', 'ppt/media/_rels/a.bin.rels': 'PFJlbGF0aW9uc2hpcHMvPg==' },
  contentTypes: { 'ppt/media/a.bin': 'application/x-gate', bin: 'application/octet-stream' },
}
const ITEM_MISSING: ElementClipboardItem = {
  xml: '<p:sp><p:nvSpPr><p:cNvPr id=\'9\' name="x"/></p:nvSpPr><a:off x="1" y="2"/><a:off x="3" y="4"/></p:sp>',
  rels: [{ rid: 'rId3', type: IMAGE, target: 'ppt/media/missing.png' }],
}

const SHIFT = { dx: 100, dy: -50 }

// ── in-group inputs ─────────────────────────────────────────────────────
const GRADIENT = {
  stops: [
    { pos: 0, color: '#FF0000' },
    { pos: 100000, color: '#0000FF80' },
  ],
  angle: 5400000,
}
const STROKE = { color: '#112233', widthEmu: 25400, dash: 'dash', cap: 'rnd', join: 'round', compound: 'dbl' }

export const DECKGROUPS: CallSpec[] = [
  spec(
    'copyElementData',
    (opened, _at, a) => {
      const slide = opened.deck.slides[a.slide as number]!
      return copyElementData(opened, slide, slide.elements[a.element as number]!)
    },
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map((element) => input({ slide: 0, element })),
  ),
  spec(
    'pasteElements',
    (opened, _at, a) => {
      const r = pasteElements(
        opened,
        a.slide as number,
        a.items as ElementClipboardItem[],
        a.shift as { dx: number; dy: number },
      )
      return r ? r.elementIds : null
    },
    [
      [ITEM_PLAIN],
      [ITEM_PICTURE],
      [ITEM_LINKS],
      [ITEM_GROUP],
      [ITEM_MISSING],
      [ITEM_PLAIN, ITEM_PICTURE, ITEM_LINKS, ITEM_GROUP, ITEM_MISSING],
      [],
    ].map((items) => input({ slide: 0, items, shift: SHIFT })),
  ),
  spec(
    'setSlideTransition',
    (opened, _at, a) => {
      setSlideTransition(opened.deck.slides[a.slide as number]!, a.kind as never)
      return null
    },
    [
      ...['none', 'fade', 'push', 'wipe', 'morph', 'zoom', 'random', 'dissolve'].flatMap((kind) =>
        [BASE, TIMED, MORPH, NO_SUFFIX_ANCHOR].map((text) => input({ slide: 0, kind }, text)),
      ),
    ],
  ),
  spec(
    'getSlideTransition',
    (opened, _at, a) => getSlideTransition(opened.deck.slides[a.slide as number]!),
    [BASE, TIMED, MORPH, NO_SUFFIX_ANCHOR].map((text) => input({ slide: 0 }, text)),
  ),
  spec(
    'setSlideAdvanceTime',
    (opened, _at, a) => {
      setSlideAdvanceTime(opened.deck.slides[a.slide as number]!, a.ms as number | null)
      return null
    },
    [null, 0, 1500, 4294967295, 99999999999, -5, 12.7].flatMap((ms) =>
      [BASE, TIMED, MORPH, NO_SUFFIX_ANCHOR].map((text) => input({ slide: 0, ms }, text)),
    ),
  ),
  spec(
    'getSlideAdvanceTime',
    (opened, _at, a) => getSlideAdvanceTime(opened.deck.slides[a.slide as number]!),
    [BASE, TIMED, MORPH, NO_SUFFIX_ANCHOR].map((text) => input({ slide: 0 }, text)),
  ),
  spec(
    'setSlideHidden',
    (opened, _at, a) => {
      setSlideHidden(opened.deck.slides[a.slide as number]!, a.hidden as boolean)
      return null
    },
    [true, false].flatMap((hidden) => [BASE, TIMED].map((text) => input({ slide: 0, hidden }, text))),
  ),
  spec(
    'getSlideHidden',
    (opened, _at, a) => getSlideHidden(opened.deck.slides[a.slide as number]!),
    [BASE, TIMED].map((text) => input({ slide: 0 }, text)),
  ),
  spec(
    'reassembleSlideXml',
    (opened, _at, a) => reassembleSlideXml(opened.deck.slides[a.slide as number]!),
    [BASE, TIMED, EMPTY_TREE].map((text) => input({ slide: 0 }, text)),
  ),
  // ── group / ungroup ──
  spec(
    'groupElements',
    (opened, at, a) => {
      const s = a.slide as number
      const ids = [
        ...((a.elements ?? []) as number[]).map((e) => at.element(s, e)),
        ...((a.refs ?? []) as string[]),
      ]
      const r = groupElements(opened, s, ids)
      return r ? r.groupId : null
    },
    [
      { elements: [0, 1] },
      { elements: [0, 1, 2] },
      { elements: [0, 1, 2, 3] },
      { elements: [1, 0, 1, 0] },
      { elements: [0] },
      { elements: [] },
      { elements: [0, 4] },
      { elements: [0, 7] },
      { elements: [0, 8] },
      { elements: [0, 40] },
      { elements: [0], refs: ['e_3'] },
      { elements: [], refs: ['e_2', 'e_3', 'e_999'] },
    ].map((rest) => input({ slide: 0, ...rest })),
  ),
  spec(
    'ungroupElement',
    (opened, at, a) => {
      const s = a.slide as number
      const id = typeof a.sourceId === 'string' ? a.sourceId : at.element(s, a.element as number)
      return ungroupElement(opened, s, id) !== null
    },
    [
      ...[0, 4, 5, 6, 7, 40].map((element) => input({ slide: 0, element })),
      input({ slide: 0, sourceId: 'nope' }),
      input({ slide: 9, element: 4 }),
      input({ slide: 0, element: 4 }, slideXml('', undefined, group(10, 'G', [0, 0, 100, 100], [0, 0, 0, 0], textSp(11, 'T', 1, 1, 't')))),
      input({ slide: 0, element: 0 }, slideXml('', undefined, group(10, 'G', [5, 5, 100, 100], [0, 0, 50, 50], textSp(11, 'T', 1, 1, 't') + group(12, 'N', [1, 1, 10, 10], null, '')))),
    ],
  ),
  // ── in-group editing ──
  {
    fn: 'pptxDeckgroups.index.groupChildSlices',
    call: (text) => groupChildSlices(text),
    built: [
      { text: NESTED },
      { text: group(10, 'G', [0, 0, 1, 1], [0, 0, 1, 1], textSp(11, 'A', 1, 1, '\u{1F600} \uD55C\uAE00') + NESTED + compat(30) + bareSp(3)) },
      { text: '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/><p:sp id="1"/><p:sp><p:sp></p:sp></p:sp></p:grpSp>' },
      { text: '<p:grpSp><p:grpSpPr></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="4" name="x"/></p:nvSpPr>' },
      { text: '<p:sp><p:cNvPr id="1"/></p:sp><p:pic><p:cNvPr name="n" id="9"/></p:pic><p:spx/>' },
      { text: '<p:grpSp><p:grpSpPr/><mc:AlternateContent><mc:Choice><p:sp><p:cNvPr id="1"/></p:sp></mc:Choice></mc:AlternateContent><p:cxnSp><p:cNvPr id="2"/></p:cxnSp><p:graphicFrame/></p:grpSp>' },
      { text: '' },
    ],
  },
  spec(
    'patchGroupChildXml',
    (opened, _at, a) => {
      const grp = groupOf(opened, a)!
      const child = grp.children[a.child as number]!
      return patchGroupChildXml(grp, child, (xml) => `<!--patched-->${xml}`)
    },
    everyChild({}),
  ),
  spec(
    'findGroupChild',
    (opened, at, a) => {
      const r = findGroupChild(opened.deck.slides[a.slide as number]!, groupId(at, a), childId(opened, a))
      return r ? [r.grp.id, r.child.id] : null
    },
    [
      ...everyChild({}),
      input({ slide: 0, element: 4, groupId: 'nope', childId: 'nope' }),
      input({ slide: 0, element: 0, child: 0 }),
      input({ slide: 0, element: 4, childId: 'nope' }),
    ],
  ),
  spec(
    'editGroupChildTransform',
    (opened, at, a) =>
      editGroupChildTransform(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.offset as { x: number; y: number; cx: number; cy: number },
        a.rotationDeg as number,
      ),
    [
      ...everyChild({ offset: { x: 5, y: 6, cx: 700, cy: 800 }, rotationDeg: 15.5 }),
      input({ slide: 0, element: 4, child: 0, offset: { x: -5, y: 0, cx: 1e12, cy: 0 }, rotationDeg: -90 }),
      input({ slide: 0, element: 4, child: 1, offset: { x: 1, y: 1, cx: 1, cy: 1 }, rotationDeg: 0 }),
      input({ slide: 0, element: 4, childId: 'nope', offset: { x: 1, y: 1, cx: 1, cy: 1 }, rotationDeg: 1 }),
    ],
  ),
  spec(
    'patchGroupChildText',
    (opened, at, a) => {
      const slide = opened.deck.slides[a.slide as number]!
      const grp = groupOf(opened, a)
      const child = grp?.children[a.child as number] as TextElement
      return patchGroupChildText(slide, groupId(at, a), child)
    },
    [
      input({ slide: 0, element: 4, child: 0 }),
      input({ slide: 0, element: 4, child: 1 }),
      input({ slide: 0, element: 4, child: 3 }),
      input({ slide: 0, element: 4, child: 0, groupId: 'nope' }),
      input({ slide: 0, element: 0, child: 0 }),
    ],
  ),
  spec(
    'setGroupChildFont',
    (opened, at, a) =>
      setGroupChildFont(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.patch as never,
        typeof a.grow === 'number' ? (pt: number | undefined) => (pt ?? 18) + (a.grow as number) : undefined,
      ),
    [
      ...everyChild({ patch: { fontFamily: 'Arial', bold: true, color: '#FF0000' } }),
      input({ slide: 0, element: 4, child: 0, patch: {}, grow: 6 }),
      input({ slide: 0, element: 4, child: 1, patch: { fontSizePt: 24, italic: true, underline: true, strike: true } }),
      input({ slide: 0, element: 4, child: 0, patch: { highlight: null, letterSpacingPt: 2 } }),
      input({ slide: 0, element: 4, child: 0, patch: { highlight: '#FFFF00', letterSpacingPt: null } }),
    ],
  ),
  spec(
    'editGroupChildFill',
    (opened, at, a) =>
      editGroupChildFill(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.fill as never,
      ),
    [
      ...[ 'none', '#00FF00', '#00FF0080', GRADIENT, { ...GRADIENT, radial: true }, { ...GRADIENT, path: 'rect', fillTo: { l: 0.2, t: 0.2, r: 0.8, b: 0.8 } }, { ...GRADIENT, radial: true, fillTo: { l: 0.5, t: 0.5, r: 0.5, b: 0.5 } }, { stops: [{ pos: 0, color: '#000000' }] }].flatMap((fill) =>
        [0, 1, 2, 3].map((child) => input({ slide: 0, element: 4, child, fill })),
      ),
      input({ slide: 0, element: 4, childId: 'nope', fill: '#00FF00' }),
    ],
  ),
  spec(
    'editGroupChildStroke',
    (opened, at, a) =>
      editGroupChildStroke(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.stroke as never,
      ),
    [
      ...[null, STROKE, { ...STROKE, dash: 'solid', compound: 'sng', cap: 'flat', join: 'miter' }, { color: '#000000', widthEmu: 0 }, { ...STROKE, cap: 'sq', join: 'bevel', compound: 'tri', gradient: GRADIENT }].flatMap((stroke) =>
        [0, 1, 2, 3, 4].map((child) => input({ slide: 0, element: 4, child, stroke })),
      ),
      input({ slide: 0, element: 4, childId: 'nope', stroke: null }),
    ],
  ),
  {
    fn: 'pptxDeckgroups.index.strokePatchToModel',
    call: (_text, args) => strokePatchToModel(args.stroke as never),
    built: [
      { stroke: STROKE },
      { stroke: { color: '#000000', widthEmu: 12700 } },
      { stroke: { ...STROKE, dash: 'solid', compound: 'sng' } },
      { stroke: { ...STROKE, gradient: { stops: [{ pos: 0, color: '#FFFFFF' }], angle: 5400000.6 } } },
      { stroke: { color: '#000000', widthEmu: 1, cap: 'flat', join: 'miter', compound: 'thinThick' } },
      { stroke: { color: '#000000', widthEmu: 1, cap: 'sq', join: 'bevel', compound: 'thickThin' } },
    ].map((args) => ({ args })),
  },
  spec(
    'setGroupChildShapeAdjustValues',
    (opened, at, a) =>
      setGroupChildShapeAdjustValues(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.adjust as Record<string, number>,
      ),
    [
      ...everyChild({ adjust: { adj: 33333.4 } }),
      input({ slide: 0, element: 4, child: 1, adjust: { adj1: 1, adj2: -2 } }),
      input({ slide: 0, element: 4, child: 1, adjust: {} }),
      input({ slide: 0, element: 4, child: 1, adjust: { 'a-b': 1 } }),
      input({ slide: 0, element: 4, child: 1, adjust: { constructor: 1, toString: 2 } }),
      input({ slide: 0, element: 4, child: 1, adjust: { adj: null } }),
    ],
  ),
  spec(
    'setGroupChildShapePresetGeometry',
    (opened, at, a) =>
      setGroupChildShapePresetGeometry(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.prst as string,
      ),
    [
      ...everyChild({ prst: 'ellipse' }),
      input({ slide: 0, element: 4, child: 1, prst: 'bad name' }),
      input({ slide: 0, element: 4, child: 1, prst: '' }),
      input({ slide: 0, element: 4, child: 1, prst: 'rect\n' }),
      input({ slide: 0, element: 4, child: 1, prst: 'roundRect' }),
    ],
  ),
  spec(
    'setGroupChildShapeCustomGeometry',
    (opened, at, a) =>
      setGroupChildShapeCustomGeometry(
        opened.deck.slides[a.slide as number]!,
        groupId(at, a),
        childId(opened, a),
        a.geom as never,
      ),
    [
      ...everyChild({
        geom: { w: 100, h: 100, cmds: [{ op: 'M', pts: [0, 0] }, { op: 'L', pts: [100, 0] }, { op: 'C', pts: [1, 2, 3, 4, 5, 6] }, { op: 'Z', pts: [] }] },
      }),
      input({ slide: 0, element: 4, child: 1, geom: { w: 0, h: 100, cmds: [{ op: 'M', pts: [0, 0] }] } }),
      input({ slide: 0, element: 4, child: 1, geom: { w: 10, h: 10, cmds: [] } }),
      input({ slide: 0, element: 4, child: 1, geom: { w: 10, h: 10, cmds: [{ op: 'L', pts: [1, 1] }] } }),
      input({ slide: 0, element: 4, child: 1, geom: { w: 10, h: 10, cmds: [{ op: 'M', pts: [1] }] } }),
      input({ slide: 0, element: 4, child: 1, geom: { w: 10, h: 10, cmds: [{ op: 'M', pts: [0.5, 1.5] }, { op: 'Q', pts: [1, 2, 3, 4] }] } }),
    ],
  ),
]
