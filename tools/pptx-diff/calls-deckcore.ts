// Group `deckcore` of comparison (f): index.ts 1-1155 (open, reparse, save,
// commit, the slide patch, the backgrounds), `materializeSlide`,
// `appendRawElements` and `addTable`. The Rust side answers in
// crates/office-wasm/src/calls/pptx_deckcore.rs to `pptxDeckcore.index.<name>`.
//
// Every call opens a deck of DECKS through deck-ops.ts (read its header for
// the arguments and the answer). An edit is made before the operation through
// the model, as the Rust side makes it: `args.edits` is a list of
// `{ slide, element?, flags?, ppr?, set?, structure? }`:
//
//   flags      keys of the element set to true (dirty, dirtyTransform, dirtyFill,
//              dirtyStroke, dirtySrcRect)
//   ppr        the object of `dirtyPPr`
//   set        { field: fill | stroke | srcRect | offsetX | runText, value }
//   structure  the slide's `structureDirty`
//
// Private functions are proven through the exports that reach them:
// parseSlideFromArchive, partMediaRels, hfState, buildDecorations by
// openPptx and reparseDeck (the layout/master parts written by `textPart`);
// slideIsDirty by savePptx, commitSaved and materializeSlide; patchAnchorXml
// by patchedElementXml; imageRelFor by setSlideBackgroundImage;
// slideInheritanceCtx by resetSlideBackground and setSlideBgGraphicsHidden.
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import {
  addTable,
  appendRawElements,
  commitSaved,
  materializeSlide,
  openPptx,
  patchedElementXml,
  patchSlideXml,
  reparseDeck,
  resetSlideBackground,
  savePptx,
  setSlideBackground,
  setSlideBackgroundImage,
  setSlideBgGraphicsHidden,
  type OpenedPptx,
} from './reference/index'
import type { Slide } from './reference/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { type At, DECKS, deckInput, deckOp } from './deck-ops'

type Args = Record<string, unknown>

/** `withUuid` of calls-leaves.ts for an async run: the stub holds until the promise settles. */
async function withUuid<T>(uuid: string, run: () => Promise<T> | T): Promise<T> {
  const host = globalThis.crypto
  const own = Object.getOwnPropertyDescriptor(host, 'randomUUID')
  Object.defineProperty(host, 'randomUUID', {
    value: () => uuid,
    configurable: true,
    writable: true,
  })
  try {
    return await run()
  } finally {
    if (own) Object.defineProperty(host, 'randomUUID', own)
    else Reflect.deleteProperty(host, 'randomUUID')
  }
}

/** The uuid `crypto.randomUUID` answers while an edit's bytes are patched. */
const UUID = '0b8f1c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'

interface Edit {
  slide: number
  element?: number
  flags?: string[]
  ppr?: object
  set?: { field: string; value: unknown }
  structure?: boolean
}

type Loose = Record<string, any>

function applyEdits(opened: OpenedPptx, edits: Edit[] | undefined): void {
  for (const e of edits ?? []) {
    const slide = opened.deck.slides[e.slide]
    if (!slide) continue
    if (e.structure) slide.structureDirty = true
    if (e.element === undefined) continue
    const el = slide.elements[e.element] as unknown as Loose | undefined
    if (!el) continue
    for (const flag of e.flags ?? []) el[flag] = true
    if (e.ppr) el.dirtyPPr = { ...e.ppr }
    if (!e.set) continue
    switch (e.set.field) {
      // only where the model type has the field: a mutated slide moves the
      // element at an index to another type
      case 'fill':
      case 'stroke':
      case 'srcRect':
        if (
          !(e.set.field === 'srcRect' ? ['picture'] : ['text', 'shape', 'picture']).includes(
            el.type,
          )
        )
          break
        // a null value is no key: a Rust slot cannot hold null
        if (e.set.value === null) delete el[e.set.field]
        else el[e.set.field] = e.set.value
        break
      case 'offsetX':
        if (el.transform) el.transform.offset.x = e.set.value
        break
      case 'runText': {
        const run =
          el.type === 'text' || el.type === 'shape'
            ? el.text?.paragraphs?.[0]?.runs?.[0]
            : undefined
        if (run) run.text = e.set.value
        break
      }
    }
  }
}

const edits = (args: Args): Edit[] | undefined => args.edits as Edit[] | undefined

/** One input per deck of DECKS, `rest` as the arguments. */
const everyDeck = (rest: Args): Input[] => DECKS.map(([name]) => deckInput(name, rest))

/** What a saved zip holds: `[path, text | 'bytes <n> <sha-256>', deflated]` per file, in order. */
async function savedEntries(bytes: Uint8Array): Promise<Array<[string, string, boolean]>> {
  const zip = await JSZip.loadAsync(bytes)
  const out: Array<[string, string, boolean]> = []
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    const data = await file.async('uint8array')
    const lower = path.toLowerCase()
    const value =
      lower.endsWith('.xml') || lower.endsWith('.rels')
        ? new TextDecoder().decode(data)
        : `bytes ${data.length} ${createHash('sha256').update(data).digest('hex')}`
    // JSZip private field; an empty file is kept as a plain string with no compression object (stored, never deflated)
    const stored = (file as unknown as { _data: { compression?: { magic: string } } })._data
    out.push([path, value, data.length > 0 && stored.compression?.magic === '\x08\x00'])
  }
  return out
}

// ── Parts the inputs write ─────────────────────────────────────────────

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

const SLIDE_PART = 'ppt/slides/slide1.xml'
const SLIDE_RELS = 'ppt/slides/_rels/slide1.xml.rels'
const LAYOUT_PART = 'ppt/slideLayouts/slideLayout1.xml'
const MASTER_PART = 'ppt/slideMasters/slideMaster1.xml'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'

const slide = (body: string, opts: { bg?: string; attrs?: string } = {}): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS} ${MC}${opts.attrs ?? ''}>` +
  `<p:cSld>${opts.bg ?? ''}<p:spTree>${TREE_HEAD}${body}</p:spTree></p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

const xfrm = (x: number): string =>
  `<a:xfrm><a:off x="${x}" y="100"/><a:ext cx="1000" cy="500"/></a:xfrm>`

const TEXT =
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
  `<p:spPr>${xfrm(1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p>' +
  '<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>World</a:t></a:r></a:p></p:txBody></p:sp>'

const SHAPE =
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Rect 2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  `<p:spPr>${xfrm(2000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
  '<a:solidFill><a:srgbClr val="336699"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:sp>'

const SHAPE_SELF_CLOSING =
  '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Empty"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>'

const PICTURE =
  '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="rId9"/><a:srcRect l="1000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
  `<p:spPr>${xfrm(3000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const TABLE =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic>' +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>' +
  '<a:tblGrid><a:gridCol w="100"/></a:tblGrid><a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
  '<a:p><a:endParaRPr lang="en-US"/></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

const CONNECTOR =
  '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Connector 6"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
  `<p:spPr>${xfrm(4000)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr></p:cxnSp>`

const choiceShape = (id: number, name: string, x: number): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${xfrm(x)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr>` +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>alt</a:t></a:r></a:p></p:txBody></p:sp>'

const ALTERNATE =
  `<mc:AlternateContent><mc:Choice Requires="a14">${choiceShape(8, 'Choice', 5000)}</mc:Choice>` +
  `<mc:Fallback>${choiceShape(8, 'Fallback', 5000)}</mc:Fallback></mc:AlternateContent>`

const ALTERNATE_FRAME =
  '<mc:AlternateContent><mc:Choice Requires="a14"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Frame"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="x"/></a:graphic></p:graphicFrame></mc:Choice>' +
  `<mc:Fallback>${choiceShape(9, 'FrameFallback', 6000)}</mc:Fallback></mc:AlternateContent>`

const BG_SOLID =
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'

const EVERYTHING = slide(
  TEXT + SHAPE + SHAPE_SELF_CLOSING + PICTURE + TABLE + CONNECTOR + ALTERNATE + ALTERNATE_FRAME,
  { bg: BG_SOLID },
)

const layout = (bg: string, body: string, attrs = '', hf = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout ${NS} type="blank"${attrs}>` +
  `<p:cSld name="Blank">${bg}<p:spTree>${TREE_HEAD}${body}</p:spTree></p:cSld>${hf}</p:sldLayout>`

const master = (bg: string, body: string, hf = ''): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster ${NS}>` +
  `<p:cSld>${bg}<p:spTree>${TREE_HEAD}${body}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  `${hf}</p:sldMaster>`

const LOGO = (id: number): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Logo ${id}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>` +
  `<p:spPr>${xfrm(500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="AA5500"/></a:solidFill></p:spPr></p:sp>`

const FOOTER = (id: number, type: string, text: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type} ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}" sz="quarter" idx="${id}"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr>${xfrm(700)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p>` +
  (type === 'sldNum'
    ? '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>'
    : `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`) +
  '</a:p></p:txBody></p:sp>'

const HF_ALL = '<p:hf ftr="1" sldNum="1" dt="1"/>'
const HF_OFF = '<p:hf ftr="0" sldNum="0" dt="false"/>'
const HF_SOME = '<p:hf sldNum="true"/>'

const BG_GRADIENT =
  '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>'
const BG_REF = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
const BG_REF_STYLE = '<p:bg><p:bgRef idx="2"><a:srgbClr val="445566"/></p:bgRef></p:bg>'
const BG_BLIP =
  '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>'

/** The slide rels the blank deck has, plus `extra`. */
const slideRels = (extra: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${extra}</Relationships>`

const rel = (id: string, kind: string, target: string, mode = ''): string =>
  `<Relationship Id="${id}" Type="${kind}" Target="${target}"${mode}/>`

/** Every relationship kind parseSlideFromArchive reads, over parts the blank deck has. */
const ALL_RELS = slideRels(
  rel('rId2', `${REL}/hyperlink`, 'https://example.com/', ' TargetMode="External"') +
    rel('rId3', `${REL}/slide`, 'slide1.xml') +
    rel('rId4', `${REL}/slide`, 'missing.xml') +
    rel('rId5', `${REL}/image`, '../theme/theme1.xml') +
    rel('rId6', `${REL}/video`, 'https://example.com/v.mp4', ' TargetMode="External"') +
    rel('rId7', `${REL}/audio`, '../theme/theme1.xml') +
    rel('rId8', `${REL}/media`, '../theme/theme1.xml') +
    rel(
      'rId9',
      'http://schemas.microsoft.com/office/2017/06/relationships/model3d',
      '../theme/theme1.xml',
    ) +
    rel('rId10', `${REL}/chart`, '../theme/theme1.xml') +
    rel('rId11', `${REL}/chartEx`, '../slideMasters/slideMaster1.xml') +
    rel('rId12', `${REL}/diagramData`, '../theme/theme1.xml') +
    rel('rId13', `${REL}/diagramLayout`, '../theme/theme1.xml') +
    rel('rId14', `${REL}/diagramColors`, '../theme/theme1.xml') +
    rel('rId15', `${REL}/vmlDrawing`, '../theme/theme1.xml') +
    rel('rId16', `${REL}/image`, 'slide1.xml') +
    rel('rId17', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'),
)

/** A diagram data part naming its drawing relationship, so the data part's own rels are read. */
const DIAGRAM_DATA =
  '<dgm:dataModel xmlns:dgm="d"><dgm:extLst><a:ext xmlns:a="a"><dsp:dataModelExt xmlns:dsp="x" relId="rId15"/></a:ext></dgm:extLst></dgm:dataModel>'

/**
 * A deck whose OLE preview (VML) and SmartArt data name their relationships the way XML allows:
 * spaced `=`, single quotes, references, ids that are not `rId<number>`, other attributes first.
 */
const SPELLED_PARTS = await (async () => {
  const zip = await JSZip.loadAsync(
    Buffer.from(DECKS.find(([name]) => name === 'blank deck')![1], 'base64'),
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    slideRels(
      rel('rId15', `${REL}/vmlDrawing`, '../drawings/vmlDrawing1.xml') +
        rel('rId12', `${REL}/diagramData`, '../diagrams/data1.xml') +
        rel('R20', `${REL}/diagramDrawing`, '../diagrams/drawing1.xml') +
        rel('rId30', `${REL}/oleObject`, '../embeddings/o.bin') +
        rel('rId17', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'),
    ),
  )
  zip.file(
    'ppt/drawings/vmlDrawing1.xml',
    '<xml xmlns:v="v" xmlns:o="o"><v:shape note="a>b" id = \'spid&#49;\' o:spid = "_x0001"><v:imagedata note="x>y" o:relid = \'img&amp;1\'/></v:shape></xml>',
  )
  zip.file(
    'ppt/drawings/_rels/vmlDrawing1.xml.rels',
    slideRels(rel('img&amp;1', `${REL}/image`, '../theme/theme1.xml')),
  )
  zip.file(
    'ppt/diagrams/data1.xml',
    '<dgm:dataModel xmlns:dgm="d"><dgm:extLst><a:ext xmlns:a="a"><dsp:dataModelExt xmlns:dsp="x" note="a>b" relId = \'R&#50;0\'/></a:ext></dgm:extLst></dgm:dataModel>',
  )
  zip.file('ppt/diagrams/drawing1.xml', '<dsp:drawing xmlns:dsp="x"/>')
  zip.file('ppt/embeddings/o.bin', new Uint8Array([1, 2, 3]))
  zip.file(
    'ppt/slides/slide1.xml',
    slide(
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Ole"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj spid="spid1" name="X" r:id="rId30" progId="x"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>',
    ),
  )
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' })).toString('base64')
})()

/** The slide of a deck rewritten to `xml`, with the slide's rels `rels` where given. */
const asSlide = (xml: string, rest: Args = {}): Input =>
  deckInput('blank deck', rest, { part: SLIDE_PART, text: xml })

const asRels = (rels: string, rest: Args = {}): Input =>
  deckInput('blank deck', rest, { part: SLIDE_RELS, text: rels })

const asLayout = (xml: string, rest: Args = {}): Input =>
  deckInput('blank deck', rest, { part: LAYOUT_PART, text: xml })

const asMaster = (xml: string, rest: Args = {}): Input =>
  deckInput('blank deck', rest, { part: MASTER_PART, text: xml })

/** Inputs whose parts make the open reach every branch of the parse of one slide. */
const OPEN_INPUTS: Input[] = [
  ...everyDeck({}),
  asSlide(EVERYTHING),
  asSlide(slide(TEXT, { attrs: ' showMasterSp="0"' })),
  asSlide(slide(TEXT, { attrs: " showMasterSp='false'" })),
  asSlide(slide(FOOTER(11, 'ftr', 'own footer') + FOOTER(12, 'sldNum', ''))),
  asSlide(''),
  asSlide('<p:sld'),
  asRels(ALL_RELS),
  asRels(slideRels('<Relationship Id="rId2" Type="x/hyperlink"/>')),
  asRels(''),
  asLayout(layout(BG_SOLID, LOGO(20) + FOOTER(21, 'ftr', 'layout footer'), '', HF_ALL)),
  asLayout(
    layout(BG_GRADIENT, LOGO(20) + FOOTER(21, 'sldNum', '') + FOOTER(22, 'dt', '2026'), '', HF_ALL),
  ),
  asLayout(layout(BG_REF, LOGO(20), '', HF_OFF)),
  asLayout(layout(BG_REF_STYLE, LOGO(20) + FOOTER(21, 'ftr', 'x'), '', HF_SOME)),
  asLayout(layout(BG_BLIP, LOGO(20), ' showMasterSp="0"', HF_ALL)),
  asLayout(layout('', LOGO(20), " showMasterSp='false'")),
  asLayout('<p:sldLayout'),
  asLayout(''),
  asMaster(
    master(
      BG_REF,
      LOGO(30) + FOOTER(31, 'ftr', 'master footer') + FOOTER(32, 'sldNum', ''),
      HF_ALL,
    ),
  ),
  asMaster(master(BG_SOLID, LOGO(30) + FOOTER(31, 'dt', '1 Jan'), HF_SOME)),
  asMaster(master('', LOGO(30), HF_OFF)),
  asMaster(master(BG_BLIP, LOGO(30))),
  asMaster('<p:sldMaster'),
  asMaster(''),
  deckInput('blank deck', {}, { part: 'ppt/presentation.xml', text: '<p:presentation' }),
  deckInput('blank deck', {}, { part: 'ppt/presentation.xml', text: '' }),
  deckInput('blank deck', {}, { part: 'ppt/theme/theme1.xml', text: '<a:theme' }),
  deckInput('blank deck', {}, { part: 'ppt/theme/theme1.xml', text: '' }),
  deckInput('blank deck', {}, { part: 'ppt/tableStyles.xml', text: '<a:tblStyleLst/>' }),
  deckInput('blank deck', {}, { part: 'ppt/slides/_rels/slide1.xml.rels', text: ALL_RELS }),
  deckInput('blank deck', {}, { part: 'ppt/theme/theme2.xml', text: 'x' }),
  deckInput('blank deck', {}, { part: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', text: '' }),
  deckInput('blank deck', {}, { part: 'ppt/diagrams/data1.xml', text: DIAGRAM_DATA }),
  { args: { deck: SPELLED_PARTS } },
  // a part the diagram data names through the slide rels
  asRels(
    slideRels(
      rel('rId12', `${REL}/diagramData`, '../diagrams/data1.xml') +
        rel('rId15', `${REL}/diagramDrawing`, '../theme/theme1.xml'),
    ),
  ),
]

/** Edits that make every kind of element dirty, one flag at a time, on `EVERYTHING`. */
const EDIT_SETS: Array<Edit[]> = [
  [{ slide: 0, element: 0, flags: ['dirty'] }],
  [
    {
      slide: 0,
      element: 0,
      flags: ['dirty'],
      set: { field: 'runText', value: 'Changed <&> text' },
    },
  ],
  [{ slide: 0, element: 0, flags: ['dirtyPPr'], ppr: { align: true, level: true } }],
  [{ slide: 0, element: 0, flags: [], ppr: { indents: true, paraIndices: [1] } }],
  [{ slide: 0, element: 1, flags: ['dirtyTransform'], set: { field: 'offsetX', value: 1234 } }],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill'],
      set: { field: 'fill', value: { type: 'solid', color: '#00FF00' } },
    },
  ],
  [{ slide: 0, element: 1, flags: ['dirtyFill'], set: { field: 'fill', value: { type: 'none' } } }],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill'],
      set: { field: 'fill', value: { type: 'solid', color: 'none' } },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill'],
      set: {
        field: 'fill',
        value: {
          type: 'gradient',
          stops: [
            { pos: 0, color: '#FF0000' },
            { pos: 1, color: '#0000FF' },
          ],
          angle: 90,
          path: 'circle',
          fillTo: { l: 0.5, t: 0.5, r: 0.5, b: 0.5 },
        },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill'],
      set: { field: 'fill', value: { type: 'gradient', stops: [{ pos: 0, color: '#FF0000' }] } },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill'],
      set: {
        field: 'fill',
        value: { type: 'pattern', fg: '#000000', bg: '#FFFFFF', preset: 'pct5' },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyStroke'],
      set: {
        field: 'stroke',
        value: {
          fill: { type: 'solid', color: '#0000FF' },
          width: 25400,
          dash: 'dash',
          cap: 'round',
          join: 'bevel',
          compound: 'thickThin',
        },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyStroke'],
      set: {
        field: 'stroke',
        value: {
          fill: {
            type: 'gradient',
            stops: [
              { pos: 0, color: '#112233' },
              { pos: 1, color: '#445566' },
            ],
            angle: 45,
          },
          width: 12700,
          cap: 'flat',
          join: 'miter',
          compound: 'sng',
        },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyStroke'],
      set: {
        field: 'stroke',
        value: { fill: { type: 'gradient', stops: [] }, width: 1, cap: 'square', compound: 'dbl' },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyStroke'],
      set: { field: 'stroke', value: { fill: { type: 'none' }, width: 1 } },
    },
  ],
  [
    {
      slide: 0,
      element: 1,
      flags: ['dirtyStroke'],
      set: {
        field: 'stroke',
        value: { fill: { type: 'solid', color: '#000000' }, width: 1, compound: 'tri' },
      },
    },
  ],
  [
    {
      slide: 0,
      element: 3,
      flags: ['dirtySrcRect'],
      set: { field: 'srcRect', value: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 } },
    },
  ],
  [{ slide: 0, element: 3, flags: ['dirtySrcRect'], set: { field: 'srcRect', value: null } }],
  [
    {
      slide: 0,
      element: 3,
      flags: ['dirtyTransform', 'dirtyStroke'],
      set: { field: 'offsetX', value: 77 },
    },
  ],
  [{ slide: 0, element: 4, flags: ['dirtyTransform'], set: { field: 'offsetX', value: 555 } }],
  [{ slide: 0, element: 4, flags: ['dirty', 'dirtyFill', 'dirtyStroke', 'dirtySrcRect'] }],
  [{ slide: 0, element: 5, flags: ['dirtyTransform'], set: { field: 'offsetX', value: 4321 } }],
  [
    {
      slide: 0,
      element: 2,
      flags: ['dirtyFill', 'dirtyStroke'],
      set: { field: 'fill', value: { type: 'solid', color: '#ABCDEF' } },
    },
  ],
  [
    {
      slide: 0,
      element: 6,
      flags: ['dirty', 'dirtyFill', 'dirtyTransform', 'dirtyStroke'],
      set: { field: 'offsetX', value: 99 },
    },
  ],
  [
    {
      slide: 0,
      element: 6,
      flags: ['dirtyFill'],
      set: { field: 'fill', value: { type: 'solid', color: '#010203' } },
    },
  ],
  [{ slide: 0, element: 7, flags: ['dirtyTransform'], set: { field: 'offsetX', value: 31 } }],
  [{ slide: 0, element: 6, flags: ['dirtyPPr'], ppr: { spcBef: true } }],
  [{ slide: 0, structure: true }],
  [
    { slide: 0, element: 0, flags: ['dirty'] },
    {
      slide: 0,
      element: 1,
      flags: ['dirtyFill', 'dirtyTransform'],
      set: { field: 'offsetX', value: 8 },
    },
    {
      slide: 0,
      element: 3,
      flags: ['dirtySrcRect'],
      set: { field: 'srcRect', value: { l: 0.5, t: 0, r: 0, b: 0 } },
    },
  ],
]

/** An edited slide of `EVERYTHING`, plus the same edits on every deck's first slide. */
const editedInputs = (rest: Args = {}): Input[] => [
  ...EDIT_SETS.map((set) => asSlide(EVERYTHING, { ...rest, edits: set })),
  ...[0, 1, 2, 3].flatMap((element) =>
    DECKS.map(([name]) =>
      deckInput(name, {
        ...rest,
        edits: [{ slide: 0, element, flags: ['dirty', 'dirtyTransform', 'dirtyFill'] }],
      }),
    ),
  ),
  ...DECKS.map(([name]) =>
    deckInput(name, {
      ...rest,
      edits: [
        { slide: 0, structure: true },
        { slide: 1, structure: true },
      ],
    }),
  ),
]

// A 1x1 PNG, as the list of its bytes.
const PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]

const bg = (value: unknown): Args => ({ fill: value })

const FILLS: unknown[] = [
  '#FF8800',
  '#12345678',
  'none',
  '',
  {
    stops: [
      { pos: 0, color: '#FF0000' },
      { pos: 1, color: '#0000FF' },
    ],
    angle: 45.6,
  },
  {
    stops: [
      { pos: 0, color: '#FF0000' },
      { pos: 0.5, color: '#00FF00' },
      { pos: 1, color: '#0000FF' },
    ],
    radial: true,
    angle: 90,
  },
  { stops: [{ pos: 0, color: '#FF0000' }] },
  { stops: [], path: 'rect', fillTo: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 } },
]

/** Layout and master backgrounds that `resetSlideBackground` falls back to. */
const INHERITED: Input[] = [
  deckInput('blank deck', { slide: 0 }),
  asLayout(layout(BG_SOLID, ''), { slide: 0 }),
  asLayout(layout(BG_GRADIENT, ''), { slide: 0 }),
  asLayout(layout(BG_REF, ''), { slide: 0 }),
  asLayout(layout(BG_REF_STYLE, ''), { slide: 0 }),
  asLayout(layout(BG_BLIP, ''), { slide: 0 }),
  asLayout(layout('', ''), { slide: 0 }),
  asLayout('', { slide: 0 }),
  asMaster(master(BG_REF, ''), { slide: 0 }),
  asMaster(master(BG_SOLID, ''), { slide: 0 }),
  asMaster(master(BG_BLIP, ''), { slide: 0 }),
  asMaster(master('', ''), { slide: 0 }),
  asMaster('', { slide: 0 }),
  deckInput('blank deck', { slide: 0 }, { part: 'ppt/theme/theme1.xml', text: '' }),
  deckInput('blank deck', { slide: 0 }, { part: 'ppt/presentation.xml', text: '' }),
  deckInput('blank deck', { slide: 0 }, { part: SLIDE_RELS, text: '' }),
  asSlide(slide(TEXT, { bg: BG_SOLID }), { slide: 0 }),
  asSlide(slide(TEXT, { bg: BG_GRADIENT }), { slide: 0 }),
  asSlide(slide(TEXT, { bg: BG_REF, attrs: ' showMasterSp="0"' }), { slide: 0 }),
  ...DECKS.map(([name]) => deckInput(name, { slide: 0 })),
  ...DECKS.map(([name]) => deckInput(name, { slide: 1 })),
  deckInput('blank deck', { slide: 5 }),
]

export const DECKCORE: CallSpec[] = [
  {
    fn: 'pptxDeckcore.index.openPptx',
    call: (text, args) => deckOp(text, args, () => null),
    built: OPEN_INPUTS,
  },
  {
    fn: 'pptxDeckcore.index.reparseDeck',
    call: (text, args) =>
      deckOp(text, args, (opened) => {
        applyEdits(opened, edits(args))
        // what a save bakes in is what a reparse reads: reparse after the entries changed
        opened.deck = reparseDeck(opened).deck
        return null
      }),
    built: [...OPEN_INPUTS, ...EDIT_SETS.map((set) => asSlide(EVERYTHING, { edits: set }))],
  },
  {
    fn: 'pptxDeckcore.index.savePptx',
    call: (text, args) =>
      deckOp(text, args, async (opened) =>
        withUuid(UUID, async () => {
          applyEdits(opened, edits(args))
          return savedEntries(await savePptx(opened))
        }),
      ),
    built: [...OPEN_INPUTS, ...editedInputs()],
  },
  {
    fn: 'pptxDeckcore.index.commitSaved',
    call: (text, args) =>
      deckOp(text, args, async (opened) =>
        withUuid(UUID, async () => {
          applyEdits(opened, edits(args))
          if (args.save !== false) await savePptx(opened)
          // an edit made while the stream was running stays dirty
          applyEdits(opened, args.afterSave as Edit[] | undefined)
          commitSaved(opened)
          // a second save writes what the commit baked in
          return args.again === true ? savedEntries(await savePptx(opened)) : null
        }),
      ),
    built: [
      ...editedInputs(),
      ...EDIT_SETS.slice(0, 6).map((set) => asSlide(EVERYTHING, { edits: set, again: true })),
      ...EDIT_SETS.slice(0, 6).map((set) => asSlide(EVERYTHING, { edits: set, save: false })),
      asSlide(EVERYTHING, {
        edits: [{ slide: 0, element: 0, flags: ['dirty'] }],
        afterSave: [
          {
            slide: 0,
            element: 1,
            flags: ['dirtyFill'],
            set: { field: 'fill', value: { type: 'solid', color: '#778899' } },
          },
        ],
      }),
      asSlide(EVERYTHING, {
        edits: [{ slide: 0, element: 0, flags: ['dirty'] }],
        afterSave: [
          { slide: 0, element: 0, flags: ['dirty'], set: { field: 'runText', value: 'after' } },
        ],
        again: true,
      }),
    ],
  },
  {
    fn: 'pptxDeckcore.index.patchSlideXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) =>
        withUuid(UUID, () => {
          applyEdits(opened, edits(args))
          return patchSlideXml(at.slide(args.slide as number))
        }),
      ),
    built: [
      ...EDIT_SETS.map((set) => asSlide(EVERYTHING, { slide: 0, edits: set })),
      ...DECKS.map(([name]) => deckInput(name, { slide: 0 })),
      ...DECKS.map(([name]) =>
        deckInput(name, {
          slide: 0,
          edits: [
            { slide: 0, element: 0, flags: ['dirty'] },
            { slide: 0, element: 1, flags: ['dirtyTransform'] },
          ],
        }),
      ),
    ],
  },
  {
    fn: 'pptxDeckcore.index.patchedElementXml',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) =>
        withUuid(UUID, () => {
          applyEdits(opened, edits(args))
          const el = opened.deck.slides[args.slide as number]!.elements[args.element as number]!
          return patchedElementXml(el)
        }),
      ),
    built: [
      ...EDIT_SETS.flatMap((set) =>
        [0, 1, 2, 3, 4, 5, 6, 7].map((element) =>
          asSlide(EVERYTHING, { slide: 0, element, edits: set }),
        ),
      ),
      ...DECKS.flatMap(([name]) =>
        [0, 1, 2].map((element) =>
          deckInput(name, {
            slide: 0,
            element,
            edits: [
              { slide: 0, element, flags: ['dirty', 'dirtyTransform', 'dirtyFill', 'dirtyStroke'] },
            ],
          }),
        ),
      ),
    ],
  },
  {
    fn: 'pptxDeckcore.index.setSlideBackground',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) =>
        withUuid(UUID, () => {
          applyEdits(opened, edits(args))
          setSlideBackground(opened, at.slide(args.slide as number), args.fill as string)
          return null
        }),
      ),
    built: [
      ...FILLS.flatMap((fill) => [
        deckInput('blank deck', { slide: 0, ...bg(fill) }),
        asSlide(EVERYTHING, { slide: 0, ...bg(fill) }),
        asSlide(slide(TEXT, { bg: BG_BLIP }), { slide: 0, ...bg(fill) }),
      ]),
      ...DECKS.map(([name]) => deckInput(name, { slide: 0, ...bg('#102030') })),
      ...DECKS.map(([name]) => deckInput(name, { slide: 1, ...bg(FILLS[4]) })),
      asSlide(EVERYTHING, {
        slide: 0,
        ...bg('#102030'),
        edits: [{ slide: 0, element: 0, flags: ['dirty'] }],
      }),
      asSlide(slide(TEXT, { bg: '<p:bg bwMode="auto"/>' }), { slide: 0, ...bg('#102030') }),
      asSlide('<p:sld>', { slide: 0, ...bg('#102030') }),
    ],
  },
  {
    fn: 'pptxDeckcore.index.setSlideBackgroundImage',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) => {
        // JSON carries the bytes as a list; the API takes a Uint8Array
        const given = args.source as { bytes: number[]; ext: string } | { mediaPath: string }
        const source =
          'bytes' in given ? { bytes: Uint8Array.from(given.bytes), ext: given.ext } : given
        return withUuid(UUID, () =>
          setSlideBackgroundImage(
            opened,
            at.slide(args.slide as number),
            source,
            args.tile as boolean | undefined,
          ),
        )
      }),
    built: [
      ...[undefined, true, false].flatMap((tile) => [
        deckInput('blank deck', { slide: 0, source: { bytes: PNG, ext: 'png' }, tile }),
        deckInput('blank deck', { slide: 0, source: { bytes: PNG, ext: 'PNG' }, tile }),
        deckInput('blank deck', { slide: 0, source: { bytes: PNG, ext: 'exe' }, tile }),
        deckInput('blank deck', { slide: 0, source: { bytes: [], ext: 'png' }, tile }),
        deckInput('blank deck', { slide: 0, source: { bytes: PNG, ext: '' }, tile }),
        deckInput('blank deck', { slide: 0, source: { mediaPath: 'ppt/missing.png' }, tile }),
        deckInput('blank deck', { slide: 0, source: { mediaPath: LAYOUT_PART }, tile }),
        deckInput('blank deck', { slide: 0, source: { mediaPath: 'ppt/theme/theme1.xml' }, tile }),
        asRels(ALL_RELS, { slide: 0, source: { mediaPath: SLIDE_PART }, tile }),
        asRels(slideRels(rel('rId5', `${REL}/image`, '../theme/theme1.xml')), {
          slide: 0,
          source: { mediaPath: 'ppt/theme/theme1.xml' },
          tile,
        }),
        // an image rel with an empty id: no rel to point at, so nothing changes
        asRels(slideRels(rel('', `${REL}/image`, '../theme/theme1.xml')), {
          slide: 0,
          source: { mediaPath: 'ppt/theme/theme1.xml' },
          tile,
        }),
        asRels('', { slide: 0, source: { mediaPath: 'ppt/theme/theme1.xml' }, tile }),
        asRels('<Relationships></Relationships>', {
          slide: 0,
          source: { mediaPath: 'ppt/theme/theme1.xml' },
          tile,
        }),
        asRels(slideRels(rel('rId99999999999999999999', `${REL}/image`, 'x.png')), {
          slide: 0,
          source: { mediaPath: 'ppt/theme/theme1.xml' },
          tile,
        }),
        asSlide(EVERYTHING, { slide: 0, source: { bytes: PNG, ext: 'png' }, tile }),
      ]),
      ...DECKS.map(([name]) =>
        deckInput(name, { slide: 0, source: { bytes: PNG, ext: 'png' }, tile: true }),
      ),
      ...DECKS.map(([name]) =>
        deckInput(name, { slide: 1, source: { mediaPath: 'ppt/presentation.xml' } }),
      ),
    ],
  },
  {
    fn: 'pptxDeckcore.index.resetSlideBackground',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) =>
        withUuid(UUID, () => {
          applyEdits(opened, edits(args))
          resetSlideBackground(opened, at.slide(args.slide as number))
          return null
        }),
      ),
    built: INHERITED,
  },
  {
    fn: 'pptxDeckcore.index.setSlideBgGraphicsHidden',
    call: (text, args) =>
      deckOp(text, args, (opened, at: At) =>
        withUuid(UUID, () => {
          setSlideBgGraphicsHidden(opened, at.slide(args.slide as number), args.hidden as boolean)
          return null
        }),
      ),
    built: [
      ...[true, false].flatMap((hidden) => [
        ...INHERITED.map((input) => ({ ...input, args: { ...input.args, hidden } })),
        asLayout(layout(BG_SOLID, LOGO(20) + FOOTER(21, 'ftr', 'f'), '', HF_ALL), {
          slide: 0,
          hidden,
        }),
        asMaster(master(BG_SOLID, LOGO(30) + FOOTER(31, 'dt', 'd'), HF_ALL), { slide: 0, hidden }),
        asSlide(slide(TEXT, { attrs: ' showMasterSp="0"' }), { slide: 0, hidden }),
        asSlide(slide(TEXT, { attrs: ' showMasterSp="1" foo="bar"' }), { slide: 0, hidden }),
        asSlide(slide(TEXT, { attrs: " showMasterSp='0'" }), { slide: 0, hidden }),
        asSlide('<p:sld>', { slide: 0, hidden }),
        asSlide('', { slide: 0, hidden }),
        asSlide(slide(FOOTER(11, 'ftr', 'own')), { slide: 0, hidden }),
      ]),
    ],
  },
  {
    fn: 'pptxDeckcore.index.materializeSlide',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuid(UUID, () => {
          applyEdits(opened, edits(args))
          return materializeSlide(opened, args.slide as number) !== null
        }),
      ),
    built: [
      ...EDIT_SETS.map((set) => asSlide(EVERYTHING, { slide: 0, edits: set })),
      ...DECKS.map(([name]) => deckInput(name, { slide: 0 })),
      ...DECKS.map(([name]) =>
        deckInput(name, { slide: 1, edits: [{ slide: 1, element: 0, flags: ['dirty'] }] }),
      ),
      deckInput('blank deck', { slide: 7 }),
      deckInput('blank deck', { slide: -1 }),
    ],
  },
  {
    fn: 'pptxDeckcore.index.appendRawElements',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuid(UUID, () => {
          const r = appendRawElements(opened, args.slide as number, args.xmls as string[])
          return r ? r.elementIds : null
        }),
      ),
    built: [
      ...[
        [TEXT],
        [SHAPE, TABLE],
        [SHAPE_SELF_CLOSING, PICTURE, CONNECTOR],
        [ALTERNATE],
        [],
        ['<p:sp'],
        [''],
        ['text outside any shape'],
      ].flatMap((xmls) => [
        deckInput('blank deck', { slide: 0, xmls }),
        asSlide(EVERYTHING, { slide: 0, xmls }),
        asSlide(EVERYTHING, {
          slide: 0,
          xmls,
          edits: [{ slide: 0, element: 0, flags: ['dirty'] }],
        }),
      ]),
      ...DECKS.map(([name]) => deckInput(name, { slide: 0, xmls: [SHAPE, TEXT] })),
      deckInput('blank deck', { slide: 4, xmls: [TEXT] }),
    ],
  },
  {
    fn: 'pptxDeckcore.index.addTable',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        withUuid(UUID, () => {
          const r = addTable(opened, args.slide as number, args.opts as never)
          return r ? r.elementId : null
        }),
      ),
    built: [
      ...[
        { rows: 2, cols: 3, offset: { x: 100, y: 200, cx: 3000, cy: 1000 } },
        { rows: 1, cols: 1, offset: { x: 0, y: 0, cx: 1, cy: 1 } },
        {
          rows: 3,
          cols: 2,
          offset: { x: 0, y: 0, cx: 6000, cy: 3000 },
          colWidthsEmu: [1000, 5000],
          rowHeightsEmu: [1, 2, 3],
        },
        { rows: 0, cols: -5, offset: { x: 0, y: 0, cx: 0, cy: 0 } },
        { rows: 1e9, cols: 2, offset: { x: 0, y: 0, cx: 1e30, cy: 1 } },
      ].flatMap((opts) => [
        deckInput('blank deck', { slide: 0, opts }),
        asSlide(EVERYTHING, { slide: 0, opts }),
      ]),
      ...DECKS.map(([name]) =>
        deckInput(name, {
          slide: 0,
          opts: { rows: 2, cols: 2, offset: { x: 0, y: 0, cx: 2000, cy: 1000 } },
        }),
      ),
      deckInput('blank deck', {
        slide: 3,
        opts: { rows: 1, cols: 1, offset: { x: 0, y: 0, cx: 1, cy: 1 } },
      }),
    ],
  },
]

export type { Slide }
