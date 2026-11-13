// Group `deckslides` of comparison (f): index.ts lines 1924-2385 (new slides,
// copy/paste, merge, delete, reorder) and 2408-2719 (connectors, layout, slide
// size) and embedded-fonts.ts of packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_deckslides.rs to
// `pptxDeckslides.<module>.<TypeScript name>`.
//
// Operations on an opened deck run through deckOp (deck-ops.ts). A second deck
// (the source of a merge or a paste) is `args.other`, a base64 zip. The decks
// the gate has hold no embedded font and no connector, so those inputs build
// their own deck (`custom`) or write the slide text (`textPart`).
//
// Private functions are proven through the export that reaches them:
// nextSlidePath, registerNewSlide, nextMediaPath, ensureDefaultContentType and
// importLayoutChain through duplicateSlide, pasteSlide, insertBlankSlide and
// mergeSlideFromSource; phSlotKey through setSlideLayout; connectionSiteLocal
// and connectionPoint through updateConnectorsForMoved; scaleOffset through
// setSlideSize; embeddedFontBlocks through staleEmbeddedTypefaces,
// stripEmbeddedFonts and runStyle/collectRuns through editedGlyphDemand.
import JSZip from 'jszip'
import {
  connectionSiteForSide,
  copySlide,
  deleteSlide,
  duplicateSlide,
  extractMergeSlideSource,
  insertBlankSlide,
  insertSlideWithLayout,
  mergeSlideFromPptx,
  mergeSlideFromSource,
  openPptx,
  pasteSlide,
  reorderElement,
  resetSlideLayout,
  setElementConnection,
  setSlideLayout,
  setSlideSize,
  updateConnectorsForMoved,
} from './reference/index'
import {
  demandKey,
  editedGlyphDemand,
  eotToSfnt,
  listEmbeddedFonts,
  sfntCmapLookup,
  staleEmbeddedTypefaces,
  stripEmbeddedFonts,
  stripStaleEmbeddedFonts,
} from './reference/embedded-fonts'
import type { SlideElement } from './reference/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckInput, deckNamed, deckOp } from './deck-ops'

type Args = Record<string, unknown>

const BLANK = 'blank deck'
const GEN = 'pptxgenjs text, shape, table and two slides'
const BIZ = 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'
const UNICODE = 'packages/pptx-engine/tests/fixtures/05_unicode_cjk_emoji.pptx'
const GAPS = 'packages/pptx-engine/tests/fixtures/06_corpus_gaps.pptx'

const SLIDE1 = 'ppt/slides/slide1.xml'
const PRES = 'ppt/presentation.xml'
const PRES_RELS = 'ppt/_rels/presentation.xml.rels'
const CT = '[Content_Types].xml'

// ── deck building ──────────────────────────────────────────────────────

const loadZip = (name: string): Promise<JSZip> =>
  JSZip.loadAsync(Buffer.from(deckNamed(name), 'base64'))

async function textOf(name: string, path: string): Promise<string> {
  return await (await loadZip(name)).file(path)!.async('string')
}

/** The deck `name` with `edit` applied to its zip, as `args.deck`. */
async function custom(name: string, edit: (zip: JSZip) => void | Promise<void>): Promise<string> {
  const zip = await loadZip(name)
  await edit(zip)
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' })).toString('base64')
}

/** An input over a deck of this file (not of DECKS): the text goes under `textPart`. */
function over(
  deck: string,
  rest: Args = {},
  textPart?: { part: string; text: string },
): { text?: string; args: Args } {
  if (!textPart) return { args: { deck, ...rest } }
  return { text: textPart.text, args: { deck, ...rest, textPart: textPart.part } }
}

const b64 = (name: string): string => deckNamed(name)

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const slideXml = (shapes: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  `${shapes}</p:spTree></p:cSld></p:sld>`

const xfrm = (x: number, y: number, cx: number, cy: number, attrs = ''): string =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

const sp = (
  id: number,
  name: string,
  box: [number, number, number, number],
  prst: string,
  attrs = '',
  nvPr = '',
  text = '',
): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${nvPr}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${xfrm(...box, attrs)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom></p:spPr>${text}</p:sp>`

const cxn = (
  id: number,
  box: [number, number, number, number],
  cNvPr: string,
  attrs = '',
  closed = false,
): string =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/>` +
  (closed ? '<p:cNvCxnSpPr/>' : `<p:cNvCxnSpPr>${cNvPr}</p:cNvCxnSpPr>`) +
  `<p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(...box, attrs)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>`

const st = (id: number, idx: number): string => `<a:stCxn id="${id}" idx="${idx}"/>`
const en = (id: number, idx: number): string => `<a:endCxn id="${id}" idx="${idx}"/>`
const textBody = (text: string): string =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody>`

/** Two shapes (an ellipse and a rotated, flipped rectangle) and connectors over them. */
const CONNECTED = slideXml(
  sp(2, 'Ellipse', [1000000, 1000000, 2000000, 1000000], 'ellipse') +
    sp(3, 'Rect', [5000000, 2000000, 1000000, 2000000], 'rect', ' rot="2700000" flipH="1"') +
    sp(4, 'Rect flipped', [7000000, 500000, 800000, 600000], 'rect', ' flipV="1"') +
    cxn(10, [3000000, 1500000, 2000000, 1000000], st(2, 6) + en(3, 0)) +
    cxn(11, [0, 0, 100, 100], st(2, 3), ' flipH="1"') +
    cxn(12, [0, 0, 100, 100], en(4, 2), ' flipV="1"') +
    cxn(13, [0, 0, 100, 100], st(99, 1) + en(3, 7)) +
    cxn(14, [0, 0, 100, 100], '<a:cxnSpLocks noChangeShapeType="1"/>' + st(3, 1) + en(2, 1)) +
    cxn(15, [1, 2, 3, 4], '', '', true) +
    sp(5, 'Plain', [0, 0, 0, 0], 'rect'),
)

// ── the inputs of the slide operations ─────────────────────────────────

const SLIDE_DECKS = [BLANK, GEN, BIZ, UNICODE, GAPS]

/** A presentation.xml with no slide in its list. */
async function emptyDeck(): Promise<string> {
  const pres = await textOf(BLANK, PRES)
  const none = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst/>')
  return custom(BLANK, (zip) => {
    zip.file(PRES, none)
  })
}
const EMPTY = await emptyDeck()

/** A deck whose presentation parts lack what the slide registration needs. */
const NO_PRES_RELS = await custom(GEN, (zip) => {
  zip.remove(PRES_RELS)
})
const NO_CONTENT_TYPES = await custom(GEN, (zip) => {
  zip.remove(CT)
})
/** A deck with the slide list written by hand: odd quotes, an id at the ceiling, a missing relationship. */
const ODD_LIST = await (async () => {
  const pres = await textOf(GEN, PRES)
  const rels = await textOf(GEN, PRES_RELS)
  return custom(GEN, (zip) => {
    zip.file(
      PRES,
      pres.replace(
        /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        '<p:sldIdLst><p:sldId id=\'2147483647\' r:id=\'rId2\'/><p:sldId id="256" r:id="rId3"/></p:sldIdLst>',
      ),
    )
    zip.file(PRES_RELS, rels.replace(/Id="rId2"/, "Id='rId2'").replace(/Id="rId3"/, "Id='rId3'"))
  })
})()

/** The slide list written so the engine cannot add to it: an attribute on it, or no `p:` prefix. */
const ATTR_LIST = await (async () => {
  const pres = await textOf(GEN, PRES)
  return custom(GEN, (zip) => {
    zip.file(PRES, pres.replace('<p:sldIdLst>', '<p:sldIdLst xmlns:q="x">'))
  })
})()
const DEFAULT_NS_LIST = await (async () => {
  const pres = await textOf(GEN, PRES)
  return custom(GEN, (zip) => {
    zip.file(PRES, pres.replace(/<(\/?)p:(sldIdLst|sldId)\b/g, '<$1$2'))
  })
})()
/** Entries that hold an extension list, spaced and spelled ids: the list is walked, not matched by text. */
const EXT_LIST = await (async () => {
  const pres = await textOf(GEN, PRES)
  return custom(GEN, (zip) => {
    zip.file(
      PRES,
      pres.replace(
        /<p:sldId\b([^>]*?)\/>/g,
        '<p:sldId$1><p:extLst><p:ext uri="x"><x:y xmlns:x="z"/></p:ext></p:extLst></p:sldId>',
      ),
    )
  })
})()
const SPELLED_LIST = await (async () => {
  const pres = await textOf(GEN, PRES)
  const rels = await textOf(GEN, PRES_RELS)
  return custom(GEN, (zip) => {
    zip.file(
      PRES,
      pres.replace(/ r:id="rId2"/, ' r:id = "rId&#50;"').replace(/ id="(\d+)"/, ' id = "$1"'),
    )
    zip.file(PRES_RELS, rels.replace(/ Id="rId2"/, " Id = 'rId&#50;'"))
  })
})()
const LIST_FORMS = [ATTR_LIST, DEFAULT_NS_LIST, EXT_LIST, SPELLED_LIST]

const DUPLICATE: Input[] = [
  ...LIST_FORMS.flatMap((deck) => [
    over(deck, { slide: 0 }),
    over(deck, { slide: 1, clearText: true }),
  ]),
  ...SLIDE_DECKS.flatMap((name) => [
    deckInput(name, { slide: 0 }),
    deckInput(name, { slide: 1, clearText: true }),
    deckInput(name, { slide: 0, clearText: false }),
  ]),
  deckInput(GEN, { slide: 7 }),
  deckInput(GEN, { slide: -1 }),
  deckInput(GEN, { slide: 0.5 }),
  deckInput(GEN, { slide: null }),
  over(NO_PRES_RELS, { slide: 0 }),
  over(NO_CONTENT_TYPES, { slide: 1 }),
  over(ODD_LIST, { slide: 0 }),
  over(ODD_LIST, { slide: 1, clearText: true }),
  over(EMPTY, { slide: 0 }),
  deckInput(
    BLANK,
    { slide: 0, clearText: true },
    {
      part: SLIDE1,
      text: slideXml(
        sp(2, 'Text', [0, 0, 100, 100], 'rect', '', '', textBody('One &amp; two \u{1F600}')) +
          sp(3, 'Empty', [0, 0, 100, 100], 'rect') +
          cxn(4, [0, 0, 100, 100], '', '', true),
      ),
    },
  ),
]

const PASTE: Input[] = [
  ...LIST_FORMS.flatMap((deck) => [
    over(deck, { after: 0, from: 0 }),
    over(deck, { after: -1, from: 0, other: b64(BLANK) }),
  ]),
  ...[BLANK, GEN, BIZ, UNICODE].flatMap((name) => [
    deckInput(name, { after: 0, from: 0 }),
    deckInput(name, { after: -1, from: 0 }),
    deckInput(name, { after: 99, from: 0, keepSourceFormatting: true }),
    deckInput(name, { after: 0, from: 0, other: b64(GEN) }),
    deckInput(name, { after: 0, from: 1, other: b64(BIZ), keepSourceFormatting: true }),
    deckInput(name, { after: -1, from: 0, other: b64(UNICODE), keepSourceFormatting: true }),
    deckInput(name, { after: -5, from: 0, other: b64(GAPS) }),
  ]),
  deckInput(GEN, { after: 0, from: 9 }),
  over(EMPTY, { after: 0, from: 0, other: b64(GEN) }),
  over(NO_PRES_RELS, { after: 0, from: 0, other: b64(BLANK) }),
  over(NO_CONTENT_TYPES, { after: -1, from: 0, other: b64(BLANK) }),
]

const BLANK_INSERT: Input[] = [
  ...LIST_FORMS.flatMap((deck) => [over(deck, { slide: 0 }), over(deck, { slide: 1 })]),
  ...SLIDE_DECKS.flatMap((name) => [deckInput(name, { slide: 0 }), deckInput(name, { slide: 1 })]),
  deckInput(GEN, { slide: 9 }),
  deckInput(GEN, { slide: -1 }),
  over(NO_PRES_RELS, { slide: 0 }),
  over(NO_CONTENT_TYPES, { slide: 0 }),
  over(ODD_LIST, { slide: 1 }),
  deckInput(
    BLANK,
    { slide: 0 },
    { part: 'ppt/slides/_rels/slide1.xml.rels', text: '<Relationships/>' },
  ),
  deckInput(
    BLANK,
    { slide: 0 },
    {
      part: 'ppt/slides/_rels/slide1.xml.rels',
      text: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/a&amp;b&quot;.xml"/></Relationships>',
    },
  ),
]

/** A one-slide deck with media, a notes relationship and a hyperlink. */
const MEDIA_SOURCE = await (async () => {
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const rels = await textOf(BLANK, 'ppt/slides/_rels/slide1.xml.rels')
  return custom(BLANK, (zip) => {
    zip.file(
      SLIDE1,
      slideXml(
        '<p:pic><p:nvPicPr><p:cNvPr id="2" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
          '<p:blipFill><a:blip r:embed="rId5"/></p:blipFill><p:spPr/></p:pic>' +
          '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Q"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
          '<p:blipFill><a:blip r:embed="rId6" r:link="rId7"/></p:blipFill><p:spPr/></p:pic>',
      ),
    )
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      rels.replace(
        '</Relationships>',
        rel('rId5', 'image', '../media/a.PNG') +
          rel('rId6', 'image', '../media/b.weird') +
          rel('rId7', 'video', '../media/c.mp4') +
          rel('rId8', 'image', '../media/missing.png') +
          rel('rId9', 'notesSlide', '../notesSlides/notesSlide1.xml') +
          rel('rId10', 'hyperlink', 'https://example.com') +
          '</Relationships>',
      ),
    )
    zip.file('ppt/media/a.PNG', new Uint8Array([137, 80, 78, 71, 1, 2]))
    zip.file('ppt/media/b.weird', new Uint8Array([9, 9, 9]))
    zip.file('ppt/media/c.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]))
  })
})()

/** A source whose slide has no slideLayout relationship or no slide at all. */
const NO_LAYOUT_SOURCE = await custom(BLANK, (zip) => {
  zip.remove('ppt/slides/_rels/slide1.xml.rels')
})
const NO_SLIDE_SOURCE = EMPTY
const MISSING_SLIDE_SOURCE = await custom(BLANK, (zip) => {
  zip.remove(SLIDE1)
})

/** A source whose media ids swap under the new numbering, and whose extensions are inherited names. */
const SWAP_SOURCE = await (async () => {
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const layout = rel('rId9', 'slideLayout', '../slideLayouts/slideLayout1.xml')
  return custom(BLANK, (zip) => {
    zip.file(
      SLIDE1,
      slideXml(
        '<p:pic><p:nvPicPr><p:cNvPr id="2" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
          '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>' +
          '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Q"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed = \'rId1\' r:link = "rId&#50;"/></p:blipFill><p:spPr/></p:pic>' +
          '<p:pic><p:nvPicPr><p:cNvPr id="4" name="R"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr/></p:pic>',
      ),
    )
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layout}` +
        rel('rId2', 'image', '../media/a.png') +
        rel('rId1', 'image', '../media/b.png') +
        rel('rId3', 'image', '../media/c.constructor') +
        rel('rId4', 'image', '../media/d.__proto__') +
        '</Relationships>',
    )
    zip.file('ppt/media/a.png', new Uint8Array([1, 2, 3]))
    zip.file('ppt/media/b.png', new Uint8Array([4, 5, 6]))
    zip.file('ppt/media/c.constructor', new Uint8Array([7]))
    zip.file('ppt/media/d.__proto__', new Uint8Array([8]))
  })
})()

const MERGE_TARGETS = [BLANK, GEN, BIZ]
const MERGE: Input[] = [
  ...[BLANK, GEN].map((name) => deckInput(name, { other: SWAP_SOURCE })),
  ...LIST_FORMS.map((deck) => over(deck, { other: b64(BLANK) })),
  ...MERGE_TARGETS.flatMap((name) => [
    deckInput(name, { other: b64(BLANK) }),
    deckInput(name, { other: b64(GEN) }),
    deckInput(name, { other: b64(BIZ) }),
    deckInput(name, { other: MEDIA_SOURCE }),
    deckInput(name, { other: MEDIA_SOURCE, layoutFrom: 0 }),
    deckInput(name, { other: MEDIA_SOURCE, layoutFrom: 9 }),
    deckInput(name, { other: NO_LAYOUT_SOURCE }),
    deckInput(name, { other: NO_SLIDE_SOURCE }),
    deckInput(name, { other: MISSING_SLIDE_SOURCE }),
  ]),
  over(EMPTY, { other: b64(BLANK) }),
  over(EMPTY, { other: MEDIA_SOURCE }),
  over(EMPTY, { other: NO_LAYOUT_SOURCE }),
  over(NO_CONTENT_TYPES, { other: MEDIA_SOURCE }),
  over(NO_PRES_RELS, { other: MEDIA_SOURCE }),
  deckInput(
    BLANK,
    { other: MEDIA_SOURCE },
    {
      part: CT,
      text:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="png" ContentType="image/png"/></Types>',
    },
  ),
]

const LAYOUTS = [
  'ppt/slideLayouts/slideLayout1.xml',
  'ppt/slideLayouts/slideLayout2.xml',
  'ppt/slideLayouts/slideLayout7.xml',
  'ppt/slideLayouts/missing.xml',
  'ppt/slideMasters/slideMaster1.xml',
  '',
]

const INSERT_LAYOUT: Input[] = [
  ...LIST_FORMS.map((deck) =>
    over(deck, { slide: 0, layout: 'ppt/slideLayouts/slideLayout1.xml' }),
  ),
  ...[BLANK, GEN, BIZ, UNICODE, GAPS].flatMap((name) =>
    LAYOUTS.flatMap((layout, i) =>
      i % 2 === 0 || name === GEN ? [deckInput(name, { slide: 0, layout })] : [],
    ),
  ),
  deckInput(GEN, { slide: 1, layout: LAYOUTS[0] }),
  deckInput(GEN, { slide: 5, layout: LAYOUTS[0] }),
  deckInput(GEN, { slide: -1, layout: LAYOUTS[0] }),
  over(NO_PRES_RELS, { slide: 0, layout: LAYOUTS[0] }),
  over(NO_CONTENT_TYPES, { slide: 0, layout: LAYOUTS[0] }),
  over(ODD_LIST, { slide: 0, layout: LAYOUTS[0] }),
]

const DELETE: Input[] = [
  ...LIST_FORMS.flatMap((deck) => [over(deck, { slide: 0 }), over(deck, { slide: 1 })]),
  ...[GEN, BIZ, UNICODE, GAPS].flatMap((name) => [
    deckInput(name, { slide: 0 }),
    deckInput(name, { slide: 1 }),
    deckInput(name, { slide: 99 }),
    deckInput(name, { slide: -1 }),
    deckInput(name, { slide: 0.5 }),
  ]),
  deckInput(BLANK, { slide: 0 }),
  over(NO_PRES_RELS, { slide: 0 }),
  over(ODD_LIST, { slide: 0 }),
  over(ODD_LIST, { slide: 1 }),
  deckInput(
    GEN,
    { slide: 0 },
    {
      part: PRES,
      text: '<p:presentation xmlns:p="x" xmlns:r="y"><p:sldIdLst><p:sldId id="256" r:id="rIdX"/></p:sldIdLst></p:presentation>',
    },
  ),
  deckInput(GEN, { slide: 1 }, { part: PRES_RELS, text: '<Relationships/>' }),
]

const REORDER: Input[] = [0, 1, 2, 3, 9, -1].flatMap((element) =>
  ['front', 'back', 'forward', 'backward', 'sideways'].map((dir) =>
    over(b64(GEN), { slide: 0, element, dir }),
  ),
)
const REORDER_ALL: Input[] = [
  ...REORDER,
  ...[BIZ, UNICODE].flatMap((name) =>
    ['front', 'back', 'forward', 'backward'].map((dir) =>
      deckInput(name, { slide: 0, element: 1, dir }),
    ),
  ),
  deckInput(GEN, { slide: 99, element: 0, dir: 'front' }),
  deckInput(BLANK, { slide: 0, element: 0, dir: 'front' }, { part: SLIDE1, text: CONNECTED }),
  deckInput(BLANK, { slide: 0, element: 5, dir: 'backward' }, { part: SLIDE1, text: CONNECTED }),
  deckInput(BLANK, { slide: 0, element: 2, dir: 'forward' }, { part: SLIDE1, text: CONNECTED }),
]

// ── layout and size ────────────────────────────────────────────────────

const PLACEHOLDERS = slideXml(
  sp(2, 'Title', [100, 200, 300, 400], 'rect', '', '<p:ph type="title"/>', textBody('Title')) +
    sp(3, 'Body', [100, 200, 300, 400], 'rect', '', '<p:ph idx="1"/>', textBody('Body')) +
    sp(
      4,
      'Footer',
      [100, 200, 300, 400],
      'rect',
      '',
      '<p:ph type="ftr" idx="11"/>',
      textBody('f'),
    ) +
    sp(5, 'Sub', [0, 0, 0, 0], 'rect', '', '<p:ph type="subTitle" idx="1"/>') +
    sp(6, 'Center', [100, 200, 300, 400], 'rect', '', '<p:ph type="ctrTitle"/>') +
    sp(9, 'Number', [100, 200, 300, 400], 'rect', '', '<p:ph type="sldNum" idx="12"/>') +
    sp(7, 'Plain', [100, 200, 300, 400], 'rect', '', '', textBody('plain')) +
    sp(8, 'Odd', [100, 200, 300, 400], 'rect', '', "<p:ph type='obj' idx='2'/>"),
)

/** A deck with a layout part whose name holds `$&` and `&`: written as typed, escaped in the rels. */
const DOLLAR_LAYOUT = await custom(BLANK, async (zip) => {
  const layout = await zip.file('ppt/slideLayouts/slideLayout1.xml')!.async('string')
  zip.file('ppt/slideLayouts/a$&b&c.xml', layout)
})

const SET_LAYOUT: Input[] = [
  over(DOLLAR_LAYOUT, { slide: 0, layout: 'ppt/slideLayouts/a$&b&c.xml' }),
  over(
    DOLLAR_LAYOUT,
    { slide: 0, layout: 'ppt/slideLayouts/a$&b&c.xml' },
    { part: 'ppt/slides/_rels/slide1.xml.rels', text: '<Relationships/>' },
  ),
  ...[BLANK, GEN, BIZ, UNICODE, GAPS].flatMap((name) =>
    LAYOUTS.map((layout) => deckInput(name, { slide: 0, layout })),
  ),
  deckInput(GEN, { slide: 1, layout: LAYOUTS[1] }),
  deckInput(GEN, { slide: 9, layout: LAYOUTS[0] }),
  deckInput(GEN, { slide: -1, layout: LAYOUTS[0] }),
  deckInput(BLANK, { slide: 0, layout: LAYOUTS[1] }, { part: SLIDE1, text: PLACEHOLDERS }),
  deckInput(GEN, { slide: 0, layout: LAYOUTS[0] }, { part: SLIDE1, text: PLACEHOLDERS }),
  deckInput(GEN, { slide: 0, layout: LAYOUTS[2] }, { part: SLIDE1, text: PLACEHOLDERS }),
  // a slide whose rels carry no slideLayout: the relationship is added; with an odd Target, rewritten
  deckInput(
    BLANK,
    { slide: 0, layout: LAYOUTS[0] },
    { part: 'ppt/slides/_rels/slide1.xml.rels', text: '<Relationships/>' },
  ),
  deckInput(
    BLANK,
    { slide: 0, layout: LAYOUTS[0] },
    {
      part: 'ppt/slides/_rels/slide1.xml.rels',
      text: '<Relationships><Relationship Id="rId1" Type="x/slideLayout" Target="a&amp;b.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout9.xml"/></Relationships>',
    },
  ),
  deckInput(
    BLANK,
    { slide: 0, layout: LAYOUTS[0] },
    { part: 'ppt/slides/_rels/slide1.xml.rels', text: '' },
  ),
  deckInput(
    BLANK,
    { slide: 0, layout: LAYOUTS[0] },
    {
      part: 'ppt/slides/_rels/slide1.xml.rels',
      text: '<Relationships><Relationship Id="rId1" Type="x/image" Target="../media/slideLayout.png"/></Relationships>',
    },
  ),
]

const RESET: Input[] = [
  ...[BLANK, GEN, BIZ, UNICODE, GAPS].flatMap((name) => [
    deckInput(name, { slide: 0 }),
    deckInput(name, { slide: 1 }),
  ]),
  deckInput(GEN, { slide: 9 }),
  deckInput(BLANK, { slide: 0 }, { part: SLIDE1, text: PLACEHOLDERS }),
  deckInput(
    BLANK,
    { slide: 0 },
    {
      part: SLIDE1,
      text: slideXml(
        sp(2, 'Title', [1, 2, 3, 4], 'rect', '', '<p:ph type="title"/>', textBody('T')) +
          sp(3, 'NoXfrm', [0, 0, 0, 0], 'rect', '', '<p:ph idx="1"/>').replace(
            /<a:xfrm>[\s\S]*?<\/a:xfrm>/,
            '',
          ),
      ),
    },
  ),
]

const SIZES: Array<[number, number]> = [
  [9144000, 6858000],
  [12192000, 6858000],
  [6858000, 9144000],
  [1, 1],
  [0, 0],
  [12192000, 0],
  [123456789012, 987654321],
  [1e21, 5],
  [12192000.5, 6858000.5],
]

const SET_SIZE: Input[] = await (async () => {
  const pres = await textOf(BLANK, PRES)
  const withSz = (tag: string): string => pres.replace(/<p:sldSz\b[^>]*?\/?>/, tag)
  const out: Input[] = [
    ...[BLANK, GEN, BIZ, UNICODE, GAPS].flatMap((name) =>
      SIZES.slice(0, 5).map(([cx, cy]) => deckInput(name, { cx, cy })),
    ),
    ...SIZES.map(([cx, cy]) => deckInput(GEN, { cx, cy })),
    deckInput(BLANK, { cx: 9144000, cy: 5143500 }, { part: SLIDE1, text: CONNECTED }),
    deckInput(BLANK, { cx: 4572000, cy: 3429000 }, { part: SLIDE1, text: PLACEHOLDERS }),
    deckInput(
      BLANK,
      { cx: 12192000, cy: 6858000 },
      { part: PRES, text: withSz("<p:sldSz cx='9144000' cy='6858000' type='screen4x3'/>") },
    ),
    deckInput(
      BLANK,
      { cx: 1000, cy: 2000 },
      { part: PRES, text: withSz('<p:sldSz cx="9144000"/>') },
    ),
    deckInput(
      BLANK,
      { cx: 1000, cy: 2000 },
      { part: PRES, text: withSz('<p:sldSz cy="6858000"/>') },
    ),
    deckInput(BLANK, { cx: 1000, cy: 2000 }, { part: PRES, text: withSz('<p:sldSz/>') }),
    deckInput(BLANK, { cx: 1000, cy: 2000 }, { part: PRES, text: withSz('') }),
    deckInput(
      BLANK,
      { cx: 1000, cy: 2000 },
      { part: PRES, text: withSz('<p:sldSz cx="1.5E6" cy="0x10"/>') },
    ),
    deckInput(
      BLANK,
      { cx: 9144000, cy: 6858000 },
      { part: PRES, text: withSz('<p:sldSz cx="9144000" cy="6858000"></p:sldSz>') },
    ),
    deckInput(
      BLANK,
      { cx: 1000, cy: 2000 },
      { part: PRES, text: withSz('<p:sldSz cx="" cy="6858000" cx="3"/>') },
    ),
  ]
  return out
})()

// ── connectors ─────────────────────────────────────────────────────────

const SIDES = ['top', 'left', 'bottom', 'right']

const SITE_FOR_SIDE: Input[] = [
  ...[0, 1, 2, 3].flatMap((element) =>
    SIDES.map((side) =>
      deckInput(BLANK, { slide: 0, element, side }, { part: SLIDE1, text: CONNECTED }),
    ),
  ),
  ...SIDES.map((side) => deckInput(GEN, { slide: 0, element: 1, side })),
  ...SIDES.map((side) => deckInput(GEN, { slide: 0, element: 2, side })),
  ...SIDES.map((side) =>
    deckInput(
      BLANK,
      { slide: 0, element: 0, side },
      {
        part: SLIDE1,
        text: slideXml(
          '<p:pic><p:nvPicPr><p:cNvPr id="2" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/>' +
            '<p:spPr><a:prstGeom prst="ellipse"/></p:spPr></p:pic>' +
            sp(3, 'Text', [0, 0, 1, 1], 'ellipse', '', '<p:ph/>', textBody('x')),
        ),
      },
    ),
  ),
]

const MOVES: number[][] = [[0], [1], [2], [0, 1, 2], [3], [4], [5], [9], [], [0, 0], [1, 7]]

const UPDATE_CONNECTORS: Input[] = [
  ...MOVES.map((moved) => deckInput(BLANK, { slide: 0, moved }, { part: SLIDE1, text: CONNECTED })),
  // a connector that is itself the target of an earlier one
  deckInput(
    BLANK,
    { slide: 0, moved: [0] },
    {
      part: SLIDE1,
      text: slideXml(
        sp(2, 'A', [1000, 1000, 2000, 1000], 'ellipse') +
          cxn(3, [0, 0, 10, 10], st(2, 0) + en(2, 4)) +
          cxn(4, [0, 0, 10, 10], st(3, 0) + en(2, 2), ' rot="5400000"'),
      ),
    },
  ),
  // two shapes that share a cNvPr id, an id of 0, a huge id and a repeated id
  deckInput(
    BLANK,
    { slide: 0, moved: [0, 1] },
    {
      part: SLIDE1,
      text: slideXml(
        sp(7, 'A', [1000, 1000, 2000, 1000], 'rect') +
          sp(7, 'B', [5000, 1000, 2000, 1000], 'ellipse', ' rot="-1800000"') +
          sp(0, 'Z', [0, 0, 50, 50], 'rect') +
          cxn(3, [0, 0, 10, 10], st(7, 0) + en(0, 3)) +
          cxn(4, [0, 0, 10, 10], st(7, 8) + en(7, 9999)),
      ),
    },
  ),
  deckInput(GEN, { slide: 0, moved: [0, 1, 2] }),
  deckInput(BIZ, { slide: 0, moved: [0, 1, 2, 3] }),
  deckInput(GEN, { slide: 99, moved: [0] }),
]

const patch = (start: unknown, end: unknown): Args => {
  const out: Args = {}
  if (start !== undefined) out.start = start
  if (end !== undefined) out.end = end
  return out
}

const CONNECTION_PATCHES: Array<[unknown, unknown]> = [
  [undefined, undefined],
  [{ id: 4, idx: 2 }, undefined],
  [undefined, { id: 4, idx: 0 }],
  [
    { id: 3, idx: 1 },
    { id: 2, idx: 3 },
  ],
  [null, undefined],
  [undefined, null],
  [null, null],
  [
    { id: 2.5, idx: 1e21 },
    { id: -1, idx: 0 },
  ],
]

const SET_CONNECTION: Input[] = [
  ...[0, 3, 4, 5, 6, 7, 9].flatMap((element) =>
    CONNECTION_PATCHES.slice(0, 5).map(([start, end]) =>
      deckInput(
        BLANK,
        { slide: 0, element, ...patch(start, end) },
        { part: SLIDE1, text: CONNECTED },
      ),
    ),
  ),
  ...CONNECTION_PATCHES.map(([start, end]) =>
    deckInput(
      BLANK,
      { slide: 0, element: 3, ...patch(start, end) },
      { part: SLIDE1, text: CONNECTED },
    ),
  ),
  deckInput(GEN, { slide: 0, element: 0, start: { id: 2, idx: 1 } }),
  deckInput(GEN, { slide: 0, element: 99, start: { id: 2, idx: 1 } }),
  deckInput(GEN, { slide: 99, element: 0, start: { id: 2, idx: 1 } }),
  // a connector written with a locks element and an extLst, an open and a closed form
  deckInput(
    BLANK,
    { slide: 0, element: 0, start: { id: 5, idx: 2 }, end: { id: 6, idx: 0 } },
    {
      part: SLIDE1,
      text: slideXml(
        cxn(
          3,
          [0, 0, 10, 10],
          '<a:cxnSpLocks noGrp="1"><a:extLst/></a:cxnSpLocks><a:extLst><a:ext uri="x"/></a:extLst>' +
            st(1, 1) +
            en(9, 9),
        ),
      ),
    },
  ),
  deckInput(
    BLANK,
    { slide: 0, element: 0, start: { id: 5, idx: 2 } },
    {
      part: SLIDE1,
      text: slideXml(cxn(3, [0, 0, 10, 10], '<a:cxnSpLocks noGrp="1"/>', '', false)),
    },
  ),
  deckInput(
    BLANK,
    { slide: 0, element: 0, start: { id: 5, idx: 2 }, end: null },
    {
      part: SLIDE1,
      text: slideXml(cxn(3, [0, 0, 10, 10], '', '', true)),
    },
  ),
  // a shape that is not a connector: no cNvCxnSpPr, nothing to write
  deckInput(
    BLANK,
    { slide: 0, element: 0, start: { id: 5, idx: 2 } },
    { part: SLIDE1, text: slideXml(sp(2, 'S', [0, 0, 5, 5], 'rect')) },
  ),
  // a dirty connector: its pending patches are materialized first
  deckInput(
    BLANK,
    { slide: 0, element: 0, start: { id: 5, idx: 2 }, dirty: true },
    { part: SLIDE1, text: slideXml(cxn(3, [0, 0, 10, 10], '', '', true)) },
  ),
]

// ── embedded fonts ─────────────────────────────────────────────────────

type Bytes = number[]
const u16 = (v: number): Bytes => [(v >> 8) & 0xff, v & 0xff]
const u32 = (v: number): Bytes => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const u32le = (v: number): Bytes => u32(v).reverse()
const tag = (t: string): Bytes => [...t].map((c) => c.charCodeAt(0))

/** cmap format 4 over segments; `glyphs` give a segment its own glyph id array. */
function format4(
  segs: Array<{ start: number; end: number; delta?: number; glyphs?: number[] }>,
): Bytes {
  const n = segs.length
  const ends = segs.flatMap((s) => u16(s.end))
  const starts = segs.flatMap((s) => u16(s.start))
  const deltas = segs.flatMap((s) => u16(s.delta ?? 0))
  let glyphBytes = 0
  const offsets = segs.map((s, k) => {
    if (!s.glyphs) return 0
    const at = n * 2 - k * 2 + glyphBytes
    glyphBytes += s.glyphs.length * 2
    return at
  })
  const rangeOffsets = offsets.flatMap((o) => u16(o))
  const glyphs = segs.flatMap((s) => (s.glyphs ?? []).flatMap((g) => u16(g)))
  const body = [...ends, ...u16(0), ...starts, ...deltas, ...rangeOffsets, ...glyphs]
  return [
    ...u16(4),
    ...u16(14 + body.length - 2 + 2),
    ...u16(0),
    ...u16(n * 2),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...body,
  ]
}

/** cmap format 12 over groups. */
function format12(groups: Array<[number, number, number]>): Bytes {
  const body = groups.flatMap(([a, b, g]) => [...u32(a), ...u32(b), ...u32(g)])
  return [
    ...u16(12),
    ...u16(0),
    ...u32(16 + body.length),
    ...u32(0),
    ...u32(groups.length),
    ...body,
  ]
}

/** A cmap table of subtables, each in a (platform 3, encoding 1) record. */
function cmapTable(subtables: Bytes[], tamper?: (bytes: Bytes) => void): Bytes {
  const head = 4 + 8 * subtables.length
  let at = head
  const records = subtables.flatMap((s) => {
    const rec = [...u16(3), ...u16(1), ...u32(at)]
    at += s.length
    return rec
  })
  const out = [...u16(0), ...u16(subtables.length), ...records, ...subtables.flat()]
  tamper?.(out)
  return out
}

/** An sfnt with a cmap table; `ttc` puts it behind a collection header; `tableTag` renames the table. */
function sfnt(cmap: Bytes, options: { ttc?: boolean; tableTag?: string } = {}): Bytes {
  const base = options.ttc ? 16 : 0
  const dir = [...u32(0x00010000), ...u16(1), ...u16(16), ...u16(0), ...u16(0)]
  const record = [
    ...tag(options.tableTag ?? 'cmap'),
    ...u32(0),
    ...u32(base + 12 + 16),
    ...u32(cmap.length),
  ]
  const header = options.ttc ? [...tag('ttcf'), ...u32(0x00010000), ...u32(1), ...u32(16)] : []
  return [...header, ...dir, ...record, ...cmap]
}

/** An EOT container: a 32-byte header and the payload at the tail. */
function eot(payload: Bytes, flags = 0, declared?: { size?: number; data?: number }): Bytes {
  const body = flags & 0x10000000 ? payload.map((b) => b ^ 0x50) : payload
  const total = 32 + body.length
  return [
    ...u32le(declared?.size ?? total),
    ...u32le(declared?.data ?? body.length),
    ...u32le(0x00020002),
    ...u32le(flags),
    ...new Array<number>(16).fill(0),
    ...body,
  ]
}

const CAPITALS = cmapTable([
  format4([
    { start: 0x41, end: 0x5a },
    { start: 0x100, end: 0x102, glyphs: [5, 0, 7] },
  ]),
])
const ABC_12 = cmapTable([
  format12([
    [0x41, 0x43, 1],
    [0x1f600, 0x1f602, 30],
    [0x61, 0x61, 0],
  ]),
])
const BOTH = cmapTable([
  format4([{ start: 0x30, end: 0x39, delta: 0xffff }]),
  format12([[0x4e00, 0x4e10, 9]]),
])
const GAP_TABLE = cmapTable([format4([{ start: 0x41, end: 0x41, delta: 0x10000 - 0x41 }])])
const OTHER_FORMAT = cmapTable([
  [...u16(6), ...u16(10), ...u16(0), ...u16(0x41), ...u16(1), ...u16(3)],
])

const sfntBytes: Record<string, Bytes> = {
  capitals: sfnt(CAPITALS),
  abc12: sfnt(ABC_12),
  both: sfnt(BOTH),
  ttc: sfnt(CAPITALS, { ttc: true }),
  noCmap: sfnt(CAPITALS, { tableTag: 'head' }),
  gap: sfnt(GAP_TABLE),
  other: sfnt(OTHER_FORMAT),
}

const PROBES = [
  0x20, 0x30, 0x39, 0x41, 0x43, 0x5a, 0x61, 0x100, 0x101, 0x102, 0x103, 0x4e00, 0x4e10, 0x4e11,
  0xffff, 0x1f600, 0x1f602, 0x1f603, 0x10ffff,
]

const damage = (bytes: Bytes, at: number, value: number): Bytes => {
  const out = [...bytes]
  out[at] = value
  return out
}

const SFNT_INPUTS: Input[] = [
  ...Object.values(sfntBytes).map((bytes) => ({ args: { bytes, probes: PROBES } })),
  { args: { bytes: sfntBytes.capitals!.slice(0, 20), probes: PROBES } },
  { args: { bytes: sfntBytes.capitals!.slice(0, 3), probes: PROBES } },
  { args: { bytes: [], probes: PROBES } },
  // a table directory of 16 records that runs past the end, an offset past the end, a segment count past the end
  { args: { bytes: damage(sfntBytes.capitals!, 5, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.capitals!, 5, 0x20), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.capitals!, 31, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.capitals!, 45, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.capitals!, 33, 0x7f), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.capitals!, 34, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.abc12!, 45, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.abc12!, 43, 0x7f), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.ttc!, 15, 0xff), probes: PROBES } },
  { args: { bytes: damage(sfntBytes.ttc!, 12, 0x7f), probes: PROBES } },
  // the glyph id array runs past the end
  { args: { bytes: sfntBytes.capitals!.slice(0, sfntBytes.capitals!.length - 3), probes: PROBES } },
]

const EOT_INPUTS: Input[] = [
  { args: { bytes: sfntBytes.capitals } },
  { args: { bytes: sfntBytes.ttc } },
  { args: { bytes: [0x4f, 0x54, 0x54, 0x4f, ...new Array<number>(20).fill(1)] } },
  { args: { bytes: [0x74, 0x72, 0x75, 0x65, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
  { args: { bytes: [0x74, 0x74, 0x63, 0x66, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
  { args: { bytes: eot(sfntBytes.capitals!) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0x10000000) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0x10000004) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0x00000004) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0x14000000) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0, { size: 999 }) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0, { data: 0 }) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0, { data: 99999 }) } },
  { args: { bytes: eot(sfntBytes.capitals!, 0, { data: sfntBytes.capitals!.length + 1 }) } },
  { args: { bytes: eot([1, 2, 3, 4, 5, 6, 7, 8]) } },
  { args: { bytes: eot([0x00, 0x01, 0x00, 0x00]) } },
  { args: { bytes: eot([0x00, 0x01, 0x00]) } },
  { args: { bytes: eot([0x00, 0x01]) } },
  { args: { bytes: eot([0x00]) } },
  { args: { bytes: eot([0x00, 0x01, 0x00, 0x00], 0x10000000) } },
  { args: { bytes: eot([0x50 ^ 0, 0x50 ^ 1, 0x50 ^ 0, 0x50 ^ 0], 0x10000000) } },
  { args: { bytes: new Array<number>(15).fill(0) } },
  { args: { bytes: [] } },
]

const KEY_INPUTS: Input[] = [
  ...['regular', 'bold', 'italic', 'boldItalic'].flatMap((style) => [
    { text: 'Calibri', args: { style } },
    { text: '', args: { style } },
    { text: 'ΑΣ İ \u{1F600} Σ', args: { style } },
  ]),
]

/** A deck with embedded fonts: each face its own mix of parts. */
async function fontDeck(
  faces: Array<{ typeface: string; parts: Array<[string, string]> }>,
  files: Record<string, Bytes>,
  options: { root?: boolean; rels?: Record<string, string>; noCt?: boolean; self?: boolean } = {},
): Promise<string> {
  const pres = await textOf(BLANK, PRES)
  const rels = await textOf(BLANK, PRES_RELS)
  const ct = await textOf(BLANK, CT)
  const list =
    '<p:embeddedFontLst>' +
    faces
      .map(
        (f) =>
          `<p:embeddedFont><p:font typeface="${f.typeface}" pitchFamily="34"/>` +
          f.parts.map(([style, id]) => `<p:${style} r:id="${id}"/>`).join('') +
          '</p:embeddedFont>',
      )
      .join('') +
    '</p:embeddedFontLst>'
  const flagged =
    options.root === false
      ? pres
      : pres.replace(
          '<p:presentation ',
          '<p:presentation embedTrueTypeFonts="1" saveSubsetFonts="1" ',
        )
  const next = flagged.includes('<p:defaultTextStyle')
    ? flagged.replace('<p:defaultTextStyle', `${list}<p:defaultTextStyle`)
    : flagged.replace('</p:presentation>', `${list}</p:presentation>`)
  const relEntries = Object.entries(options.rels ?? {})
    .map(
      ([id, target]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${target}"/>`,
    )
    .join('')
  return custom(BLANK, (zip) => {
    zip.file(PRES, next)
    zip.file(PRES_RELS, rels.replace('</Relationships>', `${relEntries}</Relationships>`))
    if (!options.noCt) {
      const overrides = Object.keys(files)
        .map((path) => `<Override PartName="/${path}" ContentType="application/x-fontdata"/>`)
        .join('')
      zip.file(
        CT,
        ct.replace(
          '</Types>',
          `<Default Extension="fntdata" ContentType="application/x-fontdata"/>${overrides}</Types>`,
        ),
      )
    }
    for (const [path, bytes] of Object.entries(files)) zip.file(path, new Uint8Array(bytes))
  })
}

const FONT_FILES: Record<string, Bytes> = {
  'ppt/fonts/font1.fntdata': eot(sfntBytes.capitals!),
  'ppt/fonts/font2.fntdata': eot(sfntBytes.abc12!, 0x10000000),
  'ppt/fonts/font3.fntdata': sfntBytes.both!,
  'ppt/fonts/font4.fntdata': eot(sfntBytes.capitals!, 0x4),
  'ppt/fonts/font5.fntdata': sfntBytes.noCmap!,
}
const FONT_RELS = {
  rIdF1: 'fonts/font1.fntdata',
  rIdF2: 'fonts/font2.fntdata',
  rIdF3: 'fonts/font3.fntdata',
  rIdF4: 'fonts/font4.fntdata',
  rIdF5: 'fonts/font5.fntdata',
  rIdF6: 'fonts/missing.fntdata',
}

const FONTS_MANY = await fontDeck(
  [
    {
      typeface: 'Face A',
      parts: [
        ['regular', 'rIdF1'],
        ['bold', 'rIdF2'],
        ['boldItalic', 'rIdF3'],
      ],
    },
    { typeface: 'Face B', parts: [['regular', 'rIdF4']] },
    {
      typeface: 'Face C',
      parts: [
        ['regular', 'rIdF6'],
        ['italic', 'rIdF5'],
      ],
    },
    { typeface: 'Face D', parts: [] },
    { typeface: 'Face E', parts: [['regular', 'rIdNone']] },
    {
      typeface: 'Face F',
      parts: [
        ['italic', 'rIdF3'],
        ['italic', 'rIdF1'],
      ],
    },
  ],
  FONT_FILES,
  { rels: FONT_RELS },
)
const FONTS_ONE = await fontDeck(
  [{ typeface: 'Only', parts: [['regular', 'rIdF1']] }],
  { 'ppt/fonts/font1.fntdata': FONT_FILES['ppt/fonts/font1.fntdata']! },
  { rels: { rIdF1: 'fonts/font1.fntdata' } },
)
const FONTS_NO_ATTRS = await fontDeck(
  [{ typeface: 'Only', parts: [['regular', 'rIdF1']] }],
  { 'ppt/fonts/font1.fntdata': FONT_FILES['ppt/fonts/font1.fntdata']! },
  { rels: { rIdF1: 'fonts/font1.fntdata' }, root: false },
)
const FONTS_NO_CT = await fontDeck(
  [{ typeface: 'Only', parts: [['regular', 'rIdF1']] }],
  { 'ppt/fonts/font1.fntdata': FONT_FILES['ppt/fonts/font1.fntdata']! },
  { rels: { rIdF1: 'fonts/font1.fntdata' }, noCt: true },
)
/** A font part of three bytes: eotToSfnt refuses it (the size checks pass, the magic needs four bytes). */
const FONTS_SHORT = await fontDeck(
  [{ typeface: 'Short', parts: [['regular', 'rIdF1']] }],
  { 'ppt/fonts/font1.fntdata': eot([0, 1, 0]) },
  { rels: { rIdF1: 'fonts/font1.fntdata' } },
)
/** Two same-named faces in different case, one stripped through a lower-case name. */
const FONTS_CASE = await fontDeck(
  [
    { typeface: 'Mixed Case', parts: [['regular', 'rIdF1']] },
    { typeface: 'MIXED CASE', parts: [['bold', 'rIdF2']] },
    { typeface: 'Other', parts: [['regular', 'rIdF3']] },
  ],
  FONT_FILES,
  { rels: FONT_RELS },
)

const FONT_DECKS: Array<[string, string]> = [
  ['many', FONTS_MANY],
  ['one', FONTS_ONE],
  ['noAttrs', FONTS_NO_ATTRS],
  ['noCt', FONTS_NO_CT],
  ['case', FONTS_CASE],
]

/** Slide text: runs of both styles in several faces, with East Asian and non-BMP text. */
const run = (text: string, rPr = '', latin = ''): string =>
  `<a:r><a:rPr lang="en-US"${rPr}>${latin}</a:rPr><a:t>${text}</a:t></a:r>`
const latinOf = (face: string): string => `<a:latin typeface="${face}"/>`
const eaOf = (face: string): string => `<a:ea typeface="${face}"/>`
const para = (...runs: string[]): string => `<a:p>${runs.join('')}</a:p>`
const shapeWithText = (id: number, ...paragraphs: string[]): string =>
  sp(
    id,
    `Text ${id}`,
    [0, 0, 100, 100],
    'rect',
    '',
    '',
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody>`,
  )

const DEMAND_SLIDE = slideXml(
  shapeWithText(
    2,
    para(run('ABC xyz', '', latinOf('Face A')), run('DEF', ' b="1"', latinOf('Face A'))),
    para(run('GH', ' i="1"', latinOf('Face A')), run('IJ', ' b="1" i="1"', latinOf('Face A'))),
  ) +
    shapeWithText(
      3,
      para(run('Face B text', '', latinOf('Face B'))),
      para(run('\u4e2d\u6587 Latin', '', latinOf('Face A') + eaOf('Face C'))),
      para(run('\u{1F600} \u0100\u0101 \u3042\u30a2\uac00 \uff21', '', latinOf('Face A'))),
      para(run('plain default', '')),
    ) +
    shapeWithText(4, para(run('   \t\u00a0', '', latinOf('Face A')))),
)

const DIRTY_MODES = [
  { dirty: 'slide' },
  { dirty: 'element', dirtyElement: 0 },
  { dirty: 'element', dirtyElement: 1 },
  { dirty: 'element', dirtyElement: 2 },
  { dirty: 'element', dirtyElement: 9 },
  {},
]

const GLYPH_DEMAND: Input[] = [
  ...DIRTY_MODES.map((mode) =>
    deckInput(BLANK, { slide: 0, ...mode }, { part: SLIDE1, text: DEMAND_SLIDE }),
  ),
  ...DIRTY_MODES.slice(0, 3).map((mode) => deckInput(GEN, { slide: 0, ...mode })),
  ...DIRTY_MODES.slice(0, 3).map((mode) => deckInput(GEN, { slide: 1, ...mode })),
  ...DIRTY_MODES.slice(0, 2).map((mode) => deckInput(BIZ, { slide: 2, ...mode })),
  ...DIRTY_MODES.slice(0, 2).map((mode) => deckInput(UNICODE, { slide: 0, ...mode })),
  deckInput(BLANK, { slide: 0, dirty: 'slide' }, { part: SLIDE1, text: slideXml('') }),
]

const demandOf = (cps: Record<string, number[]>): Array<[string, number[]]> => Object.entries(cps)

const DEMANDS: Array<Array<[string, number[]]>> = [
  [],
  demandOf({ 'face a|regular': [0x41, 0x42, 0x43] }),
  demandOf({ 'face a|regular': [0x41, 0x5b] }),
  demandOf({ 'face a|bold': [0x41, 0x43], 'face a|italic': [0x41] }),
  demandOf({ 'face a|bold': [0x44] }),
  demandOf({ 'face a|boldItalic': [0x30, 0x4e00], 'face a|italic': [0x61] }),
  demandOf({ '*|regular': [0x41], '*|bold': [0x1f600] }),
  demandOf({ '*|regular': [0x4e00], 'face a|regular': [0x41] }),
  demandOf({ 'face b|regular': [0x41] }),
  demandOf({ 'face c|regular': [0x41], 'face c|italic': [0x41] }),
  demandOf({ 'face d|regular': [0x41] }),
  demandOf({ 'face e|regular': [0x41] }),
  demandOf({ 'face f|italic': [0x41] }),
  demandOf({ 'face f|italic': [0x100, 0x101, 0x102] }),
  demandOf({ 'face a|regular': [0x101] }),
  demandOf({ 'FACE A|regular': [0x5a] }),
  demandOf({ 'mixed case|regular': [0x41], 'mixed case|bold': [0x41] }),
  demandOf({ 'mixed case|bold': [0x44] }),
]

const STALE: Input[] = [
  ...DEMANDS.map((demand) => deckInput(BLANK, { demand })),
  ...FONT_DECKS.flatMap(([, deck]) => DEMANDS.map((demand) => over(deck, { demand }))),
  over(FONTS_SHORT, { demand: demandOf({ 'short|regular': [0x41] }) }),
  over(FONTS_SHORT, { demand: [] }),
  ...DEMANDS.slice(0, 3).map((demand) => deckInput(GEN, { demand })),
  over(
    FONTS_ONE,
    { demand: demandOf({ 'only|regular': [0x41] }) },
    {
      part: PRES,
      text: '<p:presentation xmlns:p="x" xmlns:r="y"><p:embeddedFontLst><p:embeddedFont></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
]

const TYPEFACE_SETS: Array<string[] | undefined> = [
  undefined,
  [],
  ['Face A'],
  ['face a', 'FACE B'],
  ['Face A', 'Face B', 'Face C', 'Face D', 'Face E', 'Face F'],
  ['Nothing'],
  ['mixed case'],
  ['Only'],
  ['Other'],
]

const STRIP: Input[] = [
  ...FONT_DECKS.flatMap(([, deck]) =>
    TYPEFACE_SETS.map((typefaces) => over(deck, typefaces ? { typefaces } : {})),
  ),
  ...TYPEFACE_SETS.slice(0, 2).map((typefaces) => deckInput(BLANK, typefaces ? { typefaces } : {})),
  over(FONTS_SHORT, {}),
  // the font list written in its other forms
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation xmlns:p="x" xmlns:r="y" embedTrueTypeFonts="1"><p:embeddedFontLst/></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation xmlns:p="x" xmlns:r="y" embedTrueTypeFonts="1" saveSubsetFonts="0"><p:embeddedFontLst><p:embeddedFont><p:font typeface="Only"/><p:regular r:id="rIdF1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    { typefaces: ['Only'] },
    {
      part: PRES_RELS,
      text: '<Relationships><Relationship Id=\'rIdF1\' Type=\'http://x/font\' Target=\'fonts/font1.fntdata\'/><Relationship Id="rIdF9" Type="http://x/image" Target="media/x.png"/><Relationship Id="rIdF8" Type="http://x/font" Target="%66onts/font1.fntdata"/><Relationship Id="rIdF7" Type="http://x/font"/></Relationships>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: CT,
      text: '<Types><Default Extension="fntdata" ContentType="x"/><Override PartName="ppt/fonts/font1.fntdata" ContentType="y"/><Override PartName="/ppt/fonts/font1.fntdata" ContentType="y"/></Types>',
    },
  ),
]

const STALE_STRIP: Input[] = [
  ...FONT_DECKS.flatMap(([, deck]) =>
    DIRTY_MODES.map((mode) =>
      over(deck, { slide: 0, ...mode }, { part: SLIDE1, text: DEMAND_SLIDE }),
    ),
  ),
  ...DIRTY_MODES.map((mode) => over(FONTS_MANY, { slide: 0, ...mode })),
  over(FONTS_SHORT, { slide: 0, dirty: 'slide' }, { part: SLIDE1, text: DEMAND_SLIDE }),
  deckInput(BLANK, { slide: 0, dirty: 'slide' }, { part: SLIDE1, text: DEMAND_SLIDE }),
  deckInput(GEN, { slide: 0, dirty: 'slide' }),
]

const LIST: Input[] = [
  ...FONT_DECKS.map(([, deck]) => over(deck)),
  over(FONTS_SHORT),
  deckInput(BLANK),
  deckInput(GEN),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font typeface=""/><p:regular r:id="rIdF1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font typeface="A"/><p:regular/><p:bold r:id="rIdF1"/><p:italic r:id=""/></p:embeddedFont><p:embeddedFont><p:regular r:id="rIdF1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font typeface="Single"/><p:regular r:id="rIdF1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    { part: PRES, text: '<p:presentation><p:embeddedFontLst/></p:presentation>' },
  ),
  over(FONTS_ONE, {}, { part: PRES, text: 'embeddedFont <p:presentation>' }),
  over(FONTS_ONE, {}, { part: PRES, text: '<p:presentation><p:embeddedFont' }),
  over(FONTS_ONE, {}, { part: PRES, text: '<root embeddedFont/>' }),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: "<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font typeface = 'Single'/><p:regular r:id = 'rIdF1'/></p:embeddedFont></p:embeddedFontLst></p:presentation>",
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font typeface="Si&#110;gle"/><p:regular r:id="rId&#70;1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
  over(
    FONTS_ONE,
    {},
    {
      part: PRES,
      text: '<p:presentation><p:embeddedFontLst><p:embeddedFont><p:font note="a>b" typeface="Single"/><p:regular note="x>y" r:id="rIdF1"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    },
  ),
]

// ── the specs ──────────────────────────────────────────────────────────

/** `args.slide` as a number; null reaches the function as it is. */
const s = (args: Args): number => args.slide as number

const placeOpts = (args: Args) =>
  args.keepSourceFormatting === undefined
    ? undefined
    : { keepSourceFormatting: args.keepSourceFormatting as boolean }

/** A value with every byte array a list, as the Rust side gives it. */
function toLists(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? [...v] : v)))
}

function markDirty(opened: Parameters<typeof copySlide>[0], args: Args): void {
  const slide = opened.deck.slides[s(args)]
  if (!slide) return
  if (args.dirty === 'slide') slide.structureDirty = true
  if (args.dirty === 'element') {
    const el = slide.elements[args.dirtyElement as number]
    if (el) el.dirty = true
  }
}

const demandMap = (demand: unknown): Map<string, Set<number>> =>
  new Map((demand as Array<[string, number[]]>).map(([k, v]) => [k, new Set(v)]))

const mergeOptions = (opened: Parameters<typeof copySlide>[0], args: Args) => {
  const from =
    args.layoutFrom === undefined ? undefined : opened.deck.slides[args.layoutFrom as number]
  return from ? { layoutFrom: from } : {}
}

export const DECKSLIDES: CallSpec[] = [
  {
    fn: 'pptxDeckslides.index.duplicateSlide',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        duplicateSlide(
          opened,
          s(args),
          args.clearText === undefined ? undefined : { clearText: args.clearText as boolean },
        ),
      ),
    built: DUPLICATE,
  },
  {
    fn: 'pptxDeckslides.index.copySlide',
    call: (text, args) => deckOp(text, args, (opened) => copySlide(opened, s(args))),
    built: [
      ...SLIDE_DECKS.flatMap((name) => [
        deckInput(name, { slide: 0 }),
        deckInput(name, { slide: 1 }),
      ]),
      deckInput(GEN, { slide: 9 }),
      deckInput(GEN, { slide: -1 }),
      over(NO_PRES_RELS, { slide: 0 }),
      over(MEDIA_SOURCE, { slide: 0 }),
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.index.pasteSlide',
    call: async (text, args) => {
      // the source deck opens before the target: its ids come first on both sides
      const other = args.other
        ? await openPptx(Buffer.from(args.other as string, 'base64'))
        : undefined
      return deckOp(text, args, async (opened) => {
        const source = other ?? opened
        const bundle = copySlide(source, args.from as number)
        if (!bundle) throw new Error('no bundle')
        return pasteSlide(opened, args.after as number, bundle, placeOpts(args))
      })
    },
    built: PASTE,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.index.insertBlankSlide',
    call: (text, args) => deckOp(text, args, (opened) => insertBlankSlide(opened, s(args))),
    built: BLANK_INSERT,
  },
  {
    fn: 'pptxDeckslides.index.mergeSlideFromPptx',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        mergeSlideFromPptx(
          opened,
          Buffer.from(args.other as string, 'base64'),
          mergeOptions(opened, args),
        ),
      ),
    built: MERGE,
  },
  {
    fn: 'pptxDeckslides.index.extractMergeSlideSource',
    call: async (_text, args) =>
      toLists(await extractMergeSlideSource(Buffer.from(args.other as string, 'base64'))),
    built: [
      { args: { other: b64(BLANK) } },
      { args: { other: b64(GEN) } },
      { args: { other: b64(BIZ) } },
      { args: { other: b64(UNICODE) } },
      { args: { other: MEDIA_SOURCE } },
      { args: { other: NO_LAYOUT_SOURCE } },
      { args: { other: NO_SLIDE_SOURCE } },
      { args: { other: MISSING_SLIDE_SOURCE } },
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.index.mergeSlideFromSource',
    call: async (text, args) => {
      const source = await extractMergeSlideSource(Buffer.from(args.other as string, 'base64'))
      return deckOp(text, args, (opened) => {
        if (!source) throw new Error('no source')
        return mergeSlideFromSource(opened, source, mergeOptions(opened, args))
      })
    },
    built: MERGE,
  },
  {
    fn: 'pptxDeckslides.index.insertSlideWithLayout',
    call: (text, args) =>
      deckOp(text, args, (opened) => insertSlideWithLayout(opened, s(args), args.layout as string)),
    built: INSERT_LAYOUT,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.index.deleteSlide',
    call: (text, args) => deckOp(text, args, (opened) => deleteSlide(opened, s(args))),
    built: DELETE,
  },
  {
    fn: 'pptxDeckslides.index.reorderElement',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        reorderElement(
          at.slide(s(args)),
          at.element(s(args), args.element as number),
          args.dir as never,
        ),
      ),
    built: REORDER_ALL,
  },
  {
    fn: 'pptxDeckslides.index.setSlideLayout',
    call: (text, args) =>
      deckOp(text, args, (opened) => setSlideLayout(opened, s(args), args.layout as string)),
    built: SET_LAYOUT,
  },
  {
    fn: 'pptxDeckslides.index.resetSlideLayout',
    call: (text, args) => deckOp(text, args, (opened) => resetSlideLayout(opened, s(args))),
    built: RESET,
  },
  {
    fn: 'pptxDeckslides.index.setSlideSize',
    call: (text, args) =>
      deckOp(text, args, (opened) => setSlideSize(opened, args.cx as number, args.cy as number)),
    built: SET_SIZE,
  },
  {
    fn: 'pptxDeckslides.index.connectionSiteForSide',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        const el = opened.deck.slides[s(args)]?.elements[args.element as number] as SlideElement
        return connectionSiteForSide(el, args.side as never)
      }),
    built: SITE_FOR_SIDE,
  },
  {
    fn: 'pptxDeckslides.index.updateConnectorsForMoved',
    call: (text, args) =>
      deckOp(text, args, (opened, at) =>
        updateConnectorsForMoved(
          at.slide(s(args)),
          (args.moved as number[]).map((e) => at.element(s(args), e)),
        ),
      ),
    built: UPDATE_CONNECTORS,
  },
  {
    fn: 'pptxDeckslides.index.setElementConnection',
    call: (text, args) =>
      deckOp(text, args, (opened, at) => {
        if (args.dirty) {
          const el = opened.deck.slides[s(args)]?.elements[args.element as number]
          if (el) el.dirtyTransform = true
        }
        const patchArg: {
          start?: { id: number; idx: number } | null
          end?: { id: number; idx: number } | null
        } = {}
        if ('start' in args) patchArg.start = args.start as never
        if ('end' in args) patchArg.end = args.end as never
        return setElementConnection(
          at.slide(s(args)),
          at.element(s(args), args.element as number),
          patchArg,
        )
      }),
    built: SET_CONNECTION,
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.eotToSfnt',
    call: (_text, args) => {
      const out = eotToSfnt(new Uint8Array(args.bytes as number[]))
      return out ? [...out] : null
    },
    built: EOT_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.demandKey',
    call: (text, args) => demandKey(text, args.style as never),
    built: KEY_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.editedGlyphDemand',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        markDirty(opened, args)
        return editedGlyphDemand(opened.deck)
      }),
    built: GLYPH_DEMAND,
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.sfntCmapLookup',
    call: (_text, args) => {
      const lookup = sfntCmapLookup(new Uint8Array(args.bytes as number[]))
      return lookup ? (args.probes as number[]).map((cp) => lookup(cp)) : null
    },
    built: SFNT_INPUTS,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.staleEmbeddedTypefaces',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        staleEmbeddedTypefaces(opened.archive, demandMap(args.demand)),
      ),
    built: STALE,
    mutation: 'none',
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.stripEmbeddedFonts',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        stripEmbeddedFonts(
          opened.archive,
          args.typefaces ? new Set(args.typefaces as string[]) : undefined,
        ),
      ),
    built: STRIP,
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.stripStaleEmbeddedFonts',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        markDirty(opened, args)
        return stripStaleEmbeddedFonts(opened.deck, opened.archive)
      }),
    built: STALE_STRIP,
  },
  {
    fn: 'pptxDeckslides.embeddedFonts.listEmbeddedFonts',
    call: (text, args) =>
      deckOp(text, args, (opened) => toLists(listEmbeddedFonts(opened.archive))),
    built: LIST,
  },
]
