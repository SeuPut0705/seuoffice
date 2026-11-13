// Group `packageparts`: notes.ts, sections.ts, comments.ts and resource-cleanup.ts of the slides
// engine, run on an opened deck through deckOp. The Rust side is
// crates/office-wasm/src/calls/pptx_packageparts.rs, `<ts-file>.<TypeScript name>`.
//
// The decks the gate has carry none of the parts these files write (no notes, no comments, no
// sections, no shared media), so every input builds its deck from the blank deck with the parts it
// needs written by hand (`build`), and `args.deck` carries that zip (deck-ops.ts reads it as it
// reads a named deck). `textPart` then puts the text of the input into the part the function reads.
//
// What the TypeScript draws at random or reads from the clock is made the same on both sides by the
// result itself: every GUID and every ISO timestamp of the answer is replaced by a placeholder
// (`scrub`), and the Rust side does the same to its answer.
import JSZip from 'jszip'
import {
  addSlideComment,
  deleteSlideComment,
  getSlideComments,
} from '../../packages/pptx-engine/src/comments'
import {
  addContentTypeOverride,
  appendRelationship,
  getSlideNotes,
  notesPathForSlide,
  setSlideNotes,
  unescapeXml,
} from '../../packages/pptx-engine/src/notes'
import {
  cleanupDeletedElementResources,
  cleanupSupersededSlideResources,
  removePartWithOwnedResources,
  removeRelationshipAndCollectOwnedTarget,
} from '../../packages/pptx-engine/src/resource-cleanup'
import {
  addSection,
  getSections,
  moveSection,
  moveSlide,
  normalizeSections,
  removeSection,
  renameSection,
  setSections,
} from '../../packages/pptx-engine/src/sections'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckNamed, deckOp } from './deck-ops'

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g

/** The answer of deckOp with every random GUID and every clock reading made one placeholder. */
async function run(
  text: string,
  args: Record<string, unknown>,
  op: Parameters<typeof deckOp>[2],
): Promise<unknown> {
  const result = await deckOp(text, args, op)
  return JSON.parse(JSON.stringify(result).replace(GUID, 'GUID').replace(ISO, 'DT')) as unknown
}

// ---- the decks

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const BASE = new Map<string, string>()
{
  const zip = await JSZip.loadAsync(Buffer.from(deckNamed('blank deck'), 'base64'))
  for (const name of Object.keys(zip.files)) BASE.set(name, await zip.files[name]!.async('string'))
}

type Edits = Record<string, string | Uint8Array | null>

/** The blank deck with `edits` applied (null removes a part), as the base64 of a zip. */
async function build(edits: Edits = {}): Promise<string> {
  const files = new Map<string, string | Uint8Array>(BASE)
  for (const [name, content] of Object.entries(edits)) {
    if (content === null) files.delete(name)
    else files.set(name, content)
  }
  const zip = new JSZip()
  for (const [name, content] of files) zip.file(name, content)
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' })
}

const rels = (...items: string[]): string =>
  `${DECL}<Relationships xmlns="${PKG_RELS}">${items.join('')}</Relationships>`
const rel = (id: string, type: string, target: string, extra = ''): string =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${extra}/>`

const CT = BASE.get('[Content_Types].xml')!
const withCt = (...extra: string[]): string => CT.replace('</Types>', () => `${extra.join('')}</Types>`)
const override = (part: string, type: string): string =>
  `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`
const SLIDE_CT = 'presentationml.slide+xml'
const COMMENTS_CT = 'presentationml.comments+xml'
const AUTHORS_CT = 'presentationml.commentAuthors+xml'
const CHART_CT = 'drawingml.chart+xml'
const NOTES_CT = 'presentationml.notesSlide+xml'

const SLIDE = BASE.get('ppt/slides/slide1.xml')!
const LAYOUT_REL = rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')
const slideRels = (...extra: string[]): string => rels(LAYOUT_REL, ...extra)
const SLIDE1_RELS = 'ppt/slides/_rels/slide1.xml.rels'
const PRES = 'ppt/presentation.xml'
const PRES_RELS = 'ppt/_rels/presentation.xml.rels'

const sldIds = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
/** presentation.xml of n slides (rId2..), with `ext` before the end and `mid` after the master list. */
const presXml = (n: number, ext = '', mid = ''): string =>
  `${DECL}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${mid}<p:sldIdLst>${sldIds(n)}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>${ext}</p:presentation>`
const presRels = (n: number, ...extra: string[]): string =>
  rels(
    rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
    ...Array.from({ length: n }, (_, i) => rel(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`)),
    ...extra,
  )

/** Edits for a deck of n slides, slide 2.. blank, with `presRelsExtra` after the slide relationships. */
const slidesEdits = (n: number, presRelsExtra: string[] = []): Edits => {
  const edits: Edits = { [PRES]: presXml(n), [PRES_RELS]: presRels(n, ...presRelsExtra) }
  const extraCt: string[] = []
  for (let i = 2; i <= n; i++) {
    edits[`ppt/slides/slide${i}.xml`] = SLIDE
    edits[`ppt/slides/_rels/slide${i}.xml.rels`] = slideRels()
    extraCt.push(override(`ppt/slides/slide${i}.xml`, SLIDE_CT))
  }
  edits['[Content_Types].xml'] = withCt(...extraCt)
  return edits
}

/** An input of the deck `deck`; `part` is the part `text` is written into. */
const inp = (
  deck: string,
  args: Record<string, unknown>,
  part?: string,
  text?: string,
): Input =>
  part === undefined
    ? { args: { deck, ...args } }
    : { text: text ?? '', args: { deck, ...args, textPart: part } }

const SLIDE_PATH = 'ppt/slides/slide1.xml'
const BLANK_DECK = await build()

// ---- notes

const NOTES1 = 'ppt/notesSlides/notesSlide1.xml'
const notesXml = (body: string): string =>
  `<p:notes ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:notes>`
const IMG_SP =
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="I"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
const bodySp = (txBody: string, ph = 'type="body" idx="1"'): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="N"/><p:cNvSpPr/><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr/>${txBody}</p:sp>`
const tx = (...paras: string[]): string => `<p:txBody><a:bodyPr/><a:lstStyle/>${paras.join('')}</p:txBody>`
const para = (...runs: string[]): string => `<a:p>${runs.join('')}</a:p>`
const run1 = (t: string): string => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`

const NOTES_TEXTS: string[] = [
  notesXml(IMG_SP + bodySp(tx(para(run1('Hello')), para(run1('World &amp; &lt;x&gt; &#65;&#x42;'))))),
  notesXml(IMG_SP + bodySp(tx(para(run1('a')), para(), para(run1('b')), para(), para()))),
  notesXml(bodySp(tx(para(run1('x'))), `type='body' idx='1'`)),
  notesXml(IMG_SP),
  notesXml(bodySp('<p:txBody/>')),
  notesXml(bodySp(tx())),
  // `<a:t >` and `<a:t/>` are not text runs of the reader's pattern; `<a:t a="x/">` is
  notesXml(
    bodySp(
      tx(
        '<a:p><a:r><a:t xml:space="preserve"> sp </a:t></a:r><a:r><a:t/></a:r><a:r><a:t >z</a:t></a:r></a:p>',
      ),
    ),
  ),
  notesXml(bodySp(tx(para('<a:r><a:t a="x/">q</a:t></a:r>')))),
  notesXml(bodySp(tx(para('<a:r><a:t b="y/"/>skipped</a:t></a:r>')))),
  notesXml(
    IMG_SP +
      bodySp(tx(para(run1('first'))), 'type="title"') +
      bodySp(tx(para(run1('second')))),
  ),
  notesXml(bodySp(tx(para(run1('\u{1F600} non-BMP \u00e9 \ud55c\uae00'))))),
  // a `<p:sp>` with attributes is not the block the reader looks for
  notesXml(
    '<p:sp xmlns:x="y"><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>one</a:t></a:r></a:p></p:txBody></p:sp>',
  ),
  notesXml(
    bodySp(tx(para(run1('a')), para(run1('&#xD800;&#0;&#1114112;&#x110000;&#65;&#X43;&#;&#x;')))),
  ),
  notesXml(bodySp(tx(para(run1('CRLF\r\nline')), para(run1('&amp;lt; &amp;amp;'))))),
  '',
  '<p:notes/>',
  'not xml <p:sp>...',
]

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// the notes part binds its namespaces under other prefixes, or to the default one
NOTES_TEXTS.push(
  `<notes xmlns="${NS_P}" xmlns:a="${NS_A}"><cSld><spTree><sp><nvSpPr><nvPr><ph type="body"/></nvPr></nvSpPr><txBody><a:p><a:r><a:t>default &amp; bound</a:t></a:r></a:p><a:p><a:r><a:t>second</a:t></a:r></a:p></txBody></sp></spTree></cSld></notes>`,
  `<q:notes xmlns:q="${NS_P}" xmlns:w="${NS_A}"><q:cSld><q:spTree><q:sp><q:nvSpPr><q:nvPr><q:ph type='body'/></q:nvPr></q:nvSpPr><q:txBody><w:p><w:r><w:t>prefixed</w:t></w:r></w:p></q:txBody></q:sp></q:spTree></q:cSld></q:notes>`,
  `<q:notes xmlns:q="${NS_P}" xmlns:w="${NS_A}"><q:cSld><q:spTree><q:sp><q:nvSpPr><q:nvPr><q:ph type="sldImg"/></q:nvPr></q:nvSpPr></q:sp></q:spTree></q:cSld></q:notes>`,
  `<q:notes xmlns:q="${NS_P}" xmlns:w="${NS_A}"><q:cSld><q:spTree/></q:cSld></q:notes>`,
  `<q:notes xmlns:q="${NS_P}" xmlns:w="${NS_A}"><q:cSld><q:spTree></q:spTree></q:cSld></q:notes>`,
  `<p:notes xmlns:p="${NS_P}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>a unbound</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  `<p:notes xmlns:p="other" xmlns:a="${NS_A}"><p:cSld/></p:notes>`,
  // the body shape with attributes, the type spelled with a reference, text runs with attributes
  notesXml(
    '<p:sp xmlns:x="y" id="s"><p:nvSpPr><p:nvPr><p:ph idx="1" type = "b&#111;dy"/></p:nvPr></p:nvSpPr><p:txBody x="1"><a:p x="2"><a:r><a:t xml:space="preserve">kept </a:t></a:r><a:r><a:t x="z/">tail</a:t></a:r></a:p></p:txBody></p:sp>',
  ),
  notesXml('<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr></p:sp>'),
  notesXml('<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody/></p:sp>'),
  notesXml(
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>nested</a:t><a:t>two</a:t></a:r></a:p></p:txBody></p:sp>',
  ),
)

const NOTES_DECK = await build({
  [SLIDE1_RELS]: slideRels(rel('rId2', 'notesSlide', '../notesSlides/notesSlide1.xml')),
})
const NOTES_MISSING_DECK = await build({
  [SLIDE1_RELS]: slideRels(rel('rId2', 'notesSlide', '../notesSlides/gone.xml')),
})
const NOTES_EXTERNAL_DECK = await build({
  [SLIDE1_RELS]: slideRels(
    rel('rId2', 'notesSlide', 'http://example.com/n.xml', ' TargetMode="External"'),
  ),
})

const NOTES_RELS_TEXTS: string[] = [
  slideRels(rel('rId2', 'notesSlide', '../notesSlides/notesSlide1.xml')),
  slideRels(rel('rId2', 'notesSlide', '/ppt/notesSlides/notesSlide7.xml')),
  slideRels(rel('rId2', 'notesSlide', 'http://example.com/n.xml')),
  slideRels(
    rel('rId2', 'notesSlide', '../notesSlides/a.xml'),
    rel('rId3', 'notesSlide', '../notesSlides/b.xml'),
  ),
  slideRels(rel('rId2', 'notesMaster', '../notesMasters/m.xml')),
  slideRels(rel('rId2', 'notesSlide', '../notesSlides/a%20b.xml')),
  slideRels(rel('rId2', 'notesSlide', '%E0%A4%A.xml')),
  '<Relationships>',
  '',
  rels(),
]

const NOTE_TEXTS_SET = ['Hello', 'a\r\nb\rc\n\nd', '', '\n\n', '<&>"\'', '\u0001\u000b x \u000c', '\u{1F600} \u00e9']

// presentations that decide where the new notesMaster is registered
const PRES_NOTES: string[] = [
  presXml(1),
  `${DECL}<p:presentation ${NS}><p:sldIdLst>${sldIds(1)}</p:sldIdLst></p:presentation>`,
  presXml(1, '', '<p:notesMasterIdLst/>'),
  presXml(1, '', '<p:notesMasterIdLst><p:notesMasterId r:id="rId9"/></p:notesMasterIdLst>'),
  presXml(1, '', '<p:notesMasterIdLst xmlns:q="z"/>'),
  presXml(1, '', '<p:notesMasterIdLst>\n</p:notesMasterIdLst>'),
  `${DECL}<p:presentation ${NS}><p:sldSz cx="1" cy="1"/></p:presentation>`,
  // the list goes after sldMasterIdLst, under the prefixes the part binds
  `${DECL}<q:presentation xmlns:q="${NS_P}" xmlns:w="${NS_R}"><q:sldMasterIdLst/><q:sldIdLst>${sldIds(1).replace(/r:id/g, 'w:id')}</q:sldIdLst></q:presentation>`,
  `${DECL}<presentation xmlns="${NS_P}" xmlns:r="${NS_R}"><sldMasterIdLst/><sldIdLst/></presentation>`,
  `${DECL}<presentation xmlns="${NS_P}"><sldIdLst/></presentation>`,
  `${DECL}<q:presentation xmlns:q="${NS_P}" xmlns:p="other"><q:sldSz cx="1" cy="1"/><q:notesSz cx="1" cy="1"/></q:presentation>`,
  `${DECL}<q:presentation xmlns:q="${NS_P}"><q:notesSz cx="1" cy="1"/><q:handoutMasterIdLst/></q:presentation>`,
  `${DECL}<p:presentation xmlns:p="other"><p:sldMasterIdLst/></p:presentation>`,
  `${DECL}<p:presentation xmlns="${NS_P}" xmlns:p="${NS_P}"><p:sldMasterIdLst/></p:presentation>`,
  presXml(1, '', '<p:notesMasterIdLst a="1"><p:notesMasterId r:id="rId9"/></p:notesMasterIdLst>'),
  presXml(1, '', '<p:handoutMasterIdLst/>'),
  presXml(1, '', "<p:notesMasterIdLst r:x = 'a&amp;b'/>"),
]

// ---- sections

const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const EXT_URI = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}'
const section = (name: string | null, id: string | null, ids: string[] | null): string =>
  `<p14:section${name === null ? '' : ` name="${name}"`}${id === null ? '' : ` id="${id}"`}>${
    ids === null
      ? ''
      : `<p14:sldIdLst>${ids.map((i) => `<p14:sldId id="${i}"/>`).join('')}</p14:sldIdLst>`
  }</p14:section>`
const sectionExt = (...sections: string[]): string =>
  `<p:ext uri="${EXT_URI}"><p14:sectionLst xmlns:p14="${P14}">${sections.join('')}</p14:sectionLst></p:ext>`
const extLst = (...exts: string[]): string => `<p:extLst>${exts.join('')}</p:extLst>`
const OTHER_EXT = '<p:ext uri="{OTHER}"><x/></p:ext>'
const TWO = sectionExt(section('A', '{S1}', ['256', '257']), section('B &amp; C', '{S2}', ['258', '259']))

const SECTION_TEXTS: Record<string, string> = {
  none: presXml(4),
  two: presXml(4, extLst(TWO)),
  lead: presXml(4, extLst(sectionExt(section('A', '{S1}', ['257']), section('B', '{S2}', ['259'])))),
  three: presXml(
    4,
    extLst(
      sectionExt(
        section('A', '{S1}', ['256']),
        section('B', '{S2}', ['257', '258']),
        section('C', '{S3}', ['259']),
      ),
    ),
  ),
  rid: presXml(
    4,
    extLst(
      sectionExt(section('A', '{S1}', ['rId2', 'rId3']), section('B', '{S2}', ['rId4', 'rId5'])),
    ),
  ),
  stale: presXml(
    4,
    extLst(
      sectionExt(
        section('A', '{S1}', ['999', '257']),
        section('B', '{S2}', []),
        section('C', '{S3}', ['256', '300']),
      ),
    ),
  ),
  noids: presXml(
    4,
    extLst(
      sectionExt(
        section('No id', null, ['256']),
        '<p14:section id="{S9}"><p14:sldIdList/><p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section>',
      ),
    ),
  ),
  selfclosed: presXml(
    4,
    extLst(
      sectionExt(
        '<p14:section name="E" id="{E1}"/>',
        section('F', '{E2}', null),
        '<p14:section name="G" id="{E3}"><p14:sldIdLst/></p14:section>',
      ),
    ),
  ),
  other: presXml(4, extLst(OTHER_EXT, TWO)),
  after: presXml(4, extLst(TWO, OTHER_EXT)),
  emptyList: presXml(4, extLst(sectionExt())),
  selfList: presXml(
    4,
    extLst(`<p:ext uri="${EXT_URI}"><p14:sectionLst xmlns:p14="${P14}"/></p:ext>`),
  ),
  swapped: presXml(4, extLst(sectionExt(section('A', '{S1}', ['258']), section('B', '{S2}', ['256'])))),
  entity: presXml(
    4,
    extLst(
      sectionExt(
        section('a &amp; &lt;b&gt; &#65; &#x1F600; &quot;q&quot; &apos;', '{S1}', ['256', '259']),
        section('&amp;lt; \u{1F600} \ud55c\uae00', '{S2}', ['257']),
      ),
    ),
  ),
  emptyExt: presXml(4, '<p:extLst/>'),
  emptyExtLst: presXml(4, '<p:extLst></p:extLst>'),
  one: presXml(4, extLst(sectionExt(section('A', '{S1}', ['256'])))),
  attrs: presXml(
    4,
    extLst(
      `<p:ext uri="${EXT_URI}"><p14:sectionLst xmlns:p14="${P14}" foo="1">${section('A', '{S1}', ['256', '257', '258', '259'])}</p14:sectionLst></p:ext>`,
    ),
  ),
  // five sldIds for four slides: the id list and the deck disagree
  mismatch: presXml(5, extLst(TWO)),
}

const FOUR_DECK = await build(slidesEdits(4))

// the `??` of getSections: sldId 257 is in the deck's sldIdLst with no relationship (index -1),
// and the relationship Id "257" is another slide's (index 1)
const QUIRK_PRES = `${DECL}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="300" r:id="257"/><p:sldId id="257" r:id="rBad"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/>${extLst(
  sectionExt(
    section('X', '{X1}', ['257']),
    section('Y', '{Y1}', ['300']),
    section('Z', '{Z1}', ['256']),
  ),
)}</p:presentation>`
const QUIRK_DECK = await build({
  [PRES]: QUIRK_PRES,
  [PRES_RELS]: rels(
    rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
    rel('rId2', 'slide', 'slides/slide1.xml'),
    rel('257', 'slide', 'slides/slide2.xml'),
  ),
  'ppt/slides/slide2.xml': SLIDE,
  'ppt/slides/_rels/slide2.xml.rels': slideRels(),
})

SECTION_TEXTS.spaced = presXml(4, extLst(TWO)).replace('r:id="rId2"', "r:id = 'rId2'")
SECTION_TEXTS.referenced = presXml(4, extLst(TWO)).replace('r:id="rId3"', 'r:id="rId&#51;"')
SECTION_TEXTS.notlisted = presXml(4, extLst(TWO)).replace(/ r:id="rId4"/, '')

const sec = (name: string, args: Record<string, unknown> = {}): Input =>
  inp(FOUR_DECK, args, PRES, SECTION_TEXTS[name]!)

const SECS_A = [
  { id: '{N1}', name: 'First', slideIndices: [0, 1] },
  { id: '{N2}', name: 'Second', slideIndices: [2, 3] },
]
const SECS_ESC = [
  { id: '', name: 'a&b<c>"d\' \u0001 \u{1F600}', slideIndices: [0] },
  { id: '{N3}', name: '', slideIndices: [] },
  { id: '{N4}', name: 'oob', slideIndices: [7, 2, 2] },
]

const NORMALIZE: Array<[unknown[], number]> = [
  [[], 4],
  [[], 0],
  [
    [
      { id: 'a', name: 'A', slideIndices: [0, 1] },
      { id: 'b', name: 'B', slideIndices: [2, 3] },
    ],
    4,
  ],
  [
    [
      { id: 'a', name: 'A', slideIndices: [3, 2] },
      { id: 'b', name: 'B', slideIndices: [1, 0] },
    ],
    4,
  ],
  [
    [
      { id: 'a', name: 'A', slideIndices: [] },
      { id: 'b', name: 'B', slideIndices: [2] },
      { id: 'c', name: 'C', slideIndices: [] },
    ],
    4,
  ],
  [
    [
      { id: 'a', name: 'A', slideIndices: [1] },
      { id: 'b', name: 'B', slideIndices: [] },
    ],
    4,
  ],
  [
    [
      { id: 'a', name: 'A', slideIndices: [9, 12] },
      { id: 'b', name: 'B', slideIndices: [1] },
    ],
    4,
  ],
  [[{ id: 'a', name: 'A', slideIndices: [0, 0, 0] }], 1],
  [[{ id: 'a', name: 'A', slideIndices: [2] }], 0],
]

// ---- comments

const COMMENT1 = 'ppt/comments/comment1.xml'
const AUTHORS = 'ppt/commentAuthors.xml'
const authorsXml = (...authors: string[]): string =>
  `${DECL}<p:cmAuthorLst xmlns:p="${NS_P}">${authors.join('')}</p:cmAuthorLst>`
const author = (id: string | number, name: string, initials: string, lastIdx?: number): string =>
  `<p:cmAuthor id="${id}" name="${name}" initials="${initials}"${
    lastIdx === undefined ? '' : ` lastIdx="${lastIdx}"`
  } clrIdx="${id}"/>`
const cmLst = (...cms: string[]): string =>
  `${DECL}<p:cmLst xmlns:p="${NS_P}">${cms.join('')}</p:cmLst>`
const cm = (
  authorId: string | number | null,
  idx: string | number | null,
  text: string | null,
  dt: string | null = '2020-01-02T03:04:05.000',
): string =>
  `<p:cm${authorId === null ? '' : ` authorId="${authorId}"`}${dt === null ? '' : ` dt="${dt}"`}${
    idx === null ? '' : ` idx="${idx}"`
  }><p:pos x="10" y="10"/>${text === null ? '' : `<p:text>${text}</p:text>`}</p:cm>`

const AUTH_A = authorsXml(author(0, 'Ann Lee', 'AL', 3), author(1, 'Bob &amp; Co', 'B&amp;C', 1))
const AUTH_ENTITY = authorsXml(author(0, 'A&amp;B', 'AB'), author(2, 'Cy', 'C', 4))
const AUTH_ODD = authorsXml(
  '<p:cmAuthor id="x" name="bad"/>',
  '<p:cmAuthor name="noid"/>',
  author('99999999999999999999', 'Huge', 'H', 7),
  author('007', 'Zeros', 'Z', 2),
)

/** A deck whose slide 1 relates to the comments part, with `authors` (null: no author table). */
const commentsDeck = (authors: string | null, withRel = true, extra: Edits = {}): Promise<string> =>
  build({
    ...(withRel
      ? { [SLIDE1_RELS]: slideRels(rel('rId2', 'comments', '../comments/comment1.xml')) }
      : {}),
    ...(authors === null
      ? {}
      : {
          [AUTHORS]: authors,
          [PRES_RELS]: presRels(1, rel('rId9', 'commentAuthors', 'commentAuthors.xml')),
        }),
    '[Content_Types].xml': withCt(
      override(COMMENT1, COMMENTS_CT),
      ...(authors === null ? [] : [override(AUTHORS, AUTHORS_CT)]),
    ),
    ...extra,
  })

const CM_TEXTS: string[] = [
  cmLst(cm(0, 1, 'Hello &amp; &lt;b&gt; &#65;'), cm(1, 2, 'Second'), cm(0, 3, 'Third\nline')),
  cmLst(cm(null, 1, 'no author id'), cm(5, 2, 'unknown author'), cm(0, null, 'no idx')),
  cmLst(cm('99999999999999999999', '99999999999999999999', 'huge'), cm('007', '008', 'zeros')),
  cmLst(cm(0, 1, null), cm(0, 2, ''), cm(0, 3, null, null)),
  cmLst('<p:cm authorId="0" idx="1"/>', cm(0, 2, 'after the self-closed one')),
  cmLst(cm(0, 1, '&amp;lt; &amp;amp; \u{1F600} \ud55c\uae00 \u00e9')),
  cmLst(cm(0, 1, 'a<b'), '<p:cm authorId="0" idx="3">no end'),
  cmLst(),
  '',
  'not xml',
]

const COMMENT_OPTS: Array<Record<string, unknown>> = [
  { author: 'Ann Lee', text: 'Hello' },
  { author: 'Ann Lee', initials: '', text: 'empty initials' },
  { author: 'Ann Lee', initials: null, text: 'null initials' },
  { author: 'Dee Eff', initials: 'D.E.', text: 'given initials & <b>' },
  { author: '', text: 'no author' },
  { author: '  lead space', text: '&<>' },
  { author: '\u00e9lan vital', text: 'accent' },
  { author: '\u00df stra\u00dfe', text: 'sharp s' },
  { author: 'A&B', text: 'amp "q" \'s\'' },
  { author: 'Bob & Co', text: '\u0001\u000b ctl \u{1F600} \ud55c\uae00' },
  { author: 'x\u{1F600}y z', text: 'non-BMP inside a word' },
]

const NINE = cmLst(...Array.from({ length: 9 }, (_, i) => cm(0, i + 1, `c${i + 1}`)))

const CD_A = await commentsDeck(AUTH_A)
const CD_A_NO_REL = await commentsDeck(AUTH_A, false)
const CD_ONE_NO_REL = await commentsDeck(authorsXml(author(0, 'Ann Lee', 'AL')), false)
const CD_ENTITY_NO_REL = await commentsDeck(AUTH_ENTITY, false)
const CD_ODD_NO_REL = await commentsDeck(AUTH_ODD, false)
const CD_NONE_NO_REL = await commentsDeck(null, false)
const CD_EMPTY_AUTHORS = await commentsDeck('')
const CD_NO_TYPES = await commentsDeck(null, false, { '[Content_Types].xml': null })
const CD_OTHER_PART = await commentsDeck(null, false, { 'ppt/comments/comment4.xml': cmLst() })
const CD_BY_AUTHORS = await Promise.all(
  [AUTH_A, AUTH_ENTITY, AUTH_ODD, null, ''].map((authors) => commentsDeck(authors)),
)
/** Slide 1 and slide 2 both relate to the comments part. */
const CD_SHARED = await commentsDeck(AUTH_A, true, {
  ...slidesEdits(2),
  [SLIDE1_RELS]: slideRels(rel('rId2', 'comments', '../comments/comment1.xml')),
  'ppt/slides/_rels/slide2.xml.rels': slideRels(rel('rId2', 'comments', '../comments/comment1.xml')),
  '[Content_Types].xml': withCt(
    override('ppt/slides/slide2.xml', SLIDE_CT),
    override(COMMENT1, COMMENTS_CT),
  ),
})

// ---- resource cleanup

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const marker = (target: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="M" descr="aislides-3d:${target}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`
const pic = (rid: string): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="3" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic>`
const slideWith = (...inner: string[]): string =>
  SLIDE.replace('</p:spTree>', () => `${inner.join('')}</p:spTree>`)

interface ResOptions {
  /** slide 2 relates to image1 too */
  sharedImage?: boolean
  /** slide 2 relates to chart1 too */
  sharedChart?: boolean
  /** slide 2's XML holds a 3D marker for model1 */
  marker2?: boolean
  /** slide 1's XML holds a picture of rId2 */
  pic1?: boolean
  /** the ids and part names are spelled as XML allows: spaced `=`, single quotes, references */
  spelled?: boolean
}

/** A two-slide deck with media, a chart with its workbook, a notes part, orphans and 3D models. */
async function resDeck(o: ResOptions = {}): Promise<{ deck: string; slide1Rels: string }> {
  const plainRels = slideRels(
    rel('rId2', 'image', '../media/image1.png'),
    rel('rId3', 'chart', '../charts/chart1.xml'),
    rel('rId4', 'hyperlink', 'http://example.com/', ' TargetMode="External"'),
    rel('rId5', 'notesSlide', '../notesSlides/notesSlide1.xml'),
    rel('rId6', 'image', '../media/image2.png'),
    rel('rId7', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
  )
  const slide1Rels = o.spelled
    ? plainRels
        .replace(' Id="rId2"', ' Id = "rId&#50;"')
        .replace(' Id="rId3"', " Id = 'rId3'")
        .replace(' Id="rId6"', " Id='rId&#x36;'")
    : plainRels
  const override3 = (part: string, type: string): string =>
    o.spelled
      ? override(part, type).replace(`PartName="/${part}"`, `PartName = '/${part}'`)
      : override(part, type)
  const slide2Rels = slideRels(
    ...(o.sharedImage ? [rel('rId2', 'image', '../media/image1.png')] : []),
    ...(o.sharedChart ? [rel('rId3', 'chart', '../charts/chart1.xml')] : []),
    rel('rId4', 'image', '../media/image3.png'),
  )
  const deck = await build({
    ...slidesEdits(2),
    'ppt/slides/slide1.xml': o.pic1 ? slideWith(pic('rId2')) : SLIDE,
    'ppt/slides/slide2.xml': o.marker2 ? slideWith(marker('ppt/media/model1.glb')) : SLIDE,
    [SLIDE1_RELS]: slide1Rels,
    'ppt/slides/_rels/slide2.xml.rels': slide2Rels,
    'ppt/charts/chart1.xml': '<c:chartSpace/>',
    'ppt/charts/_rels/chart1.xml.rels': rels(
      rel('rId1', 'package', '../embeddings/book1.xlsx'),
      rel('rId2', 'image', '../media/image2.png'),
    ),
    'ppt/embeddings/book1.xlsx': PNG,
    'ppt/media/image1.png': PNG,
    'ppt/media/image2.png': PNG,
    'ppt/media/image3.png': PNG,
    'ppt/media/orphan.png': PNG,
    'ppt/media/model1.glb': PNG,
    'ppt/media/model2.glb': PNG,
    [NOTES1]: notesXml(IMG_SP),
    'ppt/notesSlides/_rels/notesSlide1.xml.rels': rels(
      rel('rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'),
      rel('rId2', 'slide', '../slides/slide1.xml'),
    ),
    '[Content_Types].xml': withCt(
      override3('ppt/slides/slide2.xml', SLIDE_CT),
      override3('ppt/charts/chart1.xml', CHART_CT),
      override3(NOTES1, NOTES_CT),
    ),
  })
  return { deck, slide1Rels }
}

const RES_VARIANTS: Array<[string, ResOptions]> = [
  ['plain', {}],
  ['sharedImage', { sharedImage: true }],
  ['sharedChart', { sharedChart: true }],
  ['marker2', { marker2: true }],
  ['everything shared', { sharedImage: true, sharedChart: true, marker2: true }],
  ['picture kept', { pic1: true }],
  ['spelled ids and part names', { spelled: true }],
  ['spelled and kept', { spelled: true, pic1: true }],
]
const RES = new Map<string, { deck: string; slide1Rels: string }>()
for (const [name, options] of RES_VARIANTS) RES.set(name, await resDeck(options))
const resNames = [...RES.keys()]

const PREVIOUS: string[] = [
  `<p:sld><p:pic><a:blip r:embed="rId2"/></p:pic><c:chart r:id="rId3"/></p:sld>`,
  `<p:sld><a:blip r:embed = "rId2" r:link='rId4'/><a:blip r:embed="rId6"/></p:sld>`,
  `<p:sld><p:cNvPr id="2" name="m" descr="aislides-3d:ppt/media/model1.glb"/><a:blip r:embed="rId5"/></p:sld>`,
  `<p:sld descr="aislides-3d:ppt/media/model1.glb aislides-3d:ppt/media/model2.glb;aislides-3d:ppt/media/model3.glb&amp;x"/>`,
  `<p:sld><a:blip r:embed="rId7"/><a:blip r:embed="rId99"/></p:sld>`,
  `<p:sld xmlns:r="x"/>`,
  // the ids as XML reads them: references, other quotes, other spacing
  `<p:sld><a:blip r:embed="rId&#50;" r:link = 'rId&#x34;'/><a:blip r:embed='rId6'/></p:sld>`,
  '',
]
const CURRENT: string[] = [
  '<p:sld/>',
  `<p:sld><a:blip r:embed="rId2"/></p:sld>`,
  `<p:sld><a:blip r:embed="rId6" r:id="rId3"/></p:sld>`,
  `<p:sld><p:cNvPr descr="aislides-3d:ppt/media/model1.glb"/></p:sld>`,
  `<p:sld><p:cNvPr descr="aislides-3d:ppt/media/model2.glb"/></p:sld>`,
  `<p:sld><a:blip r:embed="rId&#x32;"/><a:blip r:embed = 'rId&#54;'/></p:sld>`,
  '',
]

// ---- the specs

const slideArg = (args: Record<string, unknown>): number => args.slide as number
const pathArg = (args: Record<string, unknown>): string => args.path as string

export const PACKAGEPARTS: CallSpec[] = [
  // notes.ts
  {
    fn: 'pptxPackageparts.notes.unescapeXml',
    call: (text) => unescapeXml(text),
    mutation: 'none',
    built: [
      '',
      '&lt;&gt;&amp;&quot;&apos;',
      '&amp;lt; &amp;amp; &amp;#65; &amp;quot;',
      '&#65;&#x42;&#X43;&#0;&#xD800;&#xDFFF;&#1114111;&#1114112;&#x10FFFF;&#x110000;',
      '&#65&#;&#x;&#xg;&# 65;&#-1;&#00065;&#x0041;&#x1F600;&#128512;',
      '&LT;&Amp;&nbsp;&lt&amp',
      '\u{1F600}&amp;\ud55c\uae00 &lt;\u00e9&gt;',
      '&#99999999999999999999;&#xFFFFFFFFFFFFFFFFFFFF;',
      'plain text',
      '&&amp;;&amp;&amp;&lt;&lt;',
    ].map((text) => ({ text })),
  },
  {
    // a numeric reference that decodes to the start of a named one: read once, never again
    fn: 'pptxPackageparts.notes.unescapeXml',
    call: (text) => unescapeXml(text),
    mutation: 'none',
    built: ['&#38;lt;', '&#38;amp;', '&#x26;gt;&#34;', 'a&#38;quot;b&#38;apos;', '&#38;#38;lt;'].map(
      (text) => ({ text }),
    ),
  },
  {
    fn: 'pptxPackageparts.notes.notesPathForSlide',
    call: (text, args) =>
      run(text, args, (opened) => notesPathForSlide(opened.archive, pathArg(args))),
    built: [
      ...NOTES_RELS_TEXTS.map((text) => inp(BLANK_DECK, { path: SLIDE_PATH }, SLIDE1_RELS, text)),
      ...['ppt/slides/slide9.xml', '', '__proto__', 'ppt/slides/slide1.xml/'].map((path) =>
        inp(BLANK_DECK, { path }, SLIDE1_RELS, NOTES_RELS_TEXTS[0]),
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.notes.getSlideNotes',
    call: (text, args) => run(text, args, (opened) => getSlideNotes(opened.archive, pathArg(args))),
    built: [
      ...NOTES_TEXTS.map((text) => inp(NOTES_DECK, { path: SLIDE_PATH }, NOTES1, text)),
      inp(NOTES_DECK, { path: SLIDE_PATH }),
      inp(NOTES_MISSING_DECK, { path: SLIDE_PATH }),
      inp(NOTES_EXTERNAL_DECK, { path: SLIDE_PATH }),
      inp(BLANK_DECK, { path: SLIDE_PATH }),
      inp(NOTES_DECK, { path: 'ppt/slides/slide9.xml' }),
    ],
  },
  {
    fn: 'pptxPackageparts.notes.setSlideNotes',
    call: (text, args) =>
      run(text, args, (opened) => setSlideNotes(opened, slideArg(args), args.notes as string)),
    built: [
      // no notes slide yet: the part, its master and the registrations are created
      ...NOTE_TEXTS_SET.map((notes) => inp(BLANK_DECK, { slide: 0, notes })),
      ...PRES_NOTES.map((text) => inp(BLANK_DECK, { slide: 0, notes: 'created' }, PRES, text)),
      inp(BLANK_DECK, { slide: 3, notes: 'x' }),
      inp(BLANK_DECK, { slide: -1, notes: 'x' }),
      // a notes slide that is there: its body is patched
      ...NOTES_TEXTS.flatMap((text) =>
        ['Patched', 'l1\r\nl2\n\nl4', '', '<&>"'].map((notes) =>
          inp(NOTES_DECK, { slide: 0, notes }, NOTES1, text),
        ),
      ),
      inp(NOTES_MISSING_DECK, { slide: 0, notes: 'x' }),
      inp(NOTES_EXTERNAL_DECK, { slide: 0, notes: 'x' }),
      // a notes master and notes slides exist already: they are reused and numbered past
      inp(
        await build({
          'ppt/notesMasters/notesMaster3.xml': '<p:notesMaster/>',
          'ppt/notesSlides/notesSlide5.xml': notesXml(IMG_SP),
          'ppt/notesSlides/notesSlide12.xml': notesXml(IMG_SP),
        }),
        { slide: 0, notes: 'reuse' },
      ),
      // no theme to point the new master at
      inp(
        await build({
          'ppt/theme/theme1.xml': null,
          'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(
            rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
          ),
        }),
        { slide: 0, notes: 'no theme' },
      ),
      // no content types part, and a presentation rels with big and quoted ids
      inp(await build({ '[Content_Types].xml': null }), { slide: 0, notes: 'no types' }),
      inp(
        await build({
          [PRES_RELS]: presRels(
            1,
            `<Relationship Id='rId7' Type="${REL}/x" Target="x"/>`,
            rel('rId1000000000000000000000', 'x', 'y'),
          ),
        }),
        { slide: 0, notes: 'big ids' },
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.notes.addContentTypeOverride',
    call: (text, args) =>
      run(text, args, (opened) => {
        addContentTypeOverride(opened.archive, args.part as string, args.type as string)
        return null
      }),
    built: [
      ...[
        withCt(),
        withCt(override('ppt/x.xml', 'x')),
        withCt(`<Override PartName='/ppt/x.xml' ContentType="y"/>`),
        CT.replace('</Types>', ''),
        '',
        `<Types><Override PartName="/ppt/x.xml"/></Types></Types>`,
      ].flatMap((text) =>
        [
          ['ppt/x.xml', 'application/x'],
          ['ppt/y.xml', 'a$&b$1$$c$`d$\'e'],
          ['ppt/$&.xml', 'application/z'],
          ['', ''],
        ].map(([part, type]) => inp(BLANK_DECK, { part, type }, '[Content_Types].xml', text)),
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.notes.appendRelationship',
    call: (text, args) =>
      run(text, args, (opened) =>
        appendRelationship(
          opened.archive,
          args.part as string,
          args.type as string,
          args.target as string,
        ),
      ),
    built: [
      ...[
        slideRels(rel('rId2', 'image', '../media/a.png')),
        slideRels(rel('rId9', 'x', 'y'), rel('rId10', 'x', 'z')),
        slideRels(`<Relationship Id='rId4' Type="t" Target="u"/>`),
        slideRels(rel('rId1000000000000000000000', 'x', 'y')),
        slideRels(rel('rId99999999999999999999', 'x', 'y')),
        slideRels(rel('rIdx', 'x', 'y'), rel('rId', 'x', 'y')),
        '<Relationships>',
        '',
        rels(),
        '<Relationships xmlns="x"/>',
      ].flatMap((text) =>
        [
          ['ppt/slides/slide1.xml', 'T', 'a.xml'],
          ['ppt/slides/slide1.xml', 'T$&', 'x$&y$`z$\'w$$q$1'],
          ['ppt/slides/slide1.xml', 'T', 'a&b<c>"d$&.xml'],
        ].map(([part, type, target]) =>
          inp(BLANK_DECK, { part, type, target }, SLIDE1_RELS, text),
        ),
      ),
      // no rels part yet: created with the declaration
      inp(BLANK_DECK, { part: 'ppt/slides/slide7.xml', type: 'T', target: 'x' }),
      inp(BLANK_DECK, { part: 'ppt/slides/slide7.xml', type: 'T', target: '$&' }),
      inp(BLANK_DECK, { part: '', type: 'T', target: 'x' }),
      inp(BLANK_DECK, { part: 'a.xml', type: 'T', target: 'x' }),
    ],
  },

  // sections.ts
  {
    fn: 'pptxPackageparts.sections.getSections',
    call: (text, args) => run(text, args, (opened) => getSections(opened)),
    built: [
      ...Object.keys(SECTION_TEXTS).map((name) => sec(name)),
      inp(QUIRK_DECK, {}, PRES, QUIRK_PRES),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.setSections',
    call: (text, args) =>
      run(text, args, (opened) => {
        setSections(opened, args.sections as never)
        return null
      }),
    built: [
      ...['none', 'two', 'one', 'emptyExt', 'emptyExtLst', 'other', 'after', 'selfList', 'mismatch'].flatMap(
        (name) => [SECS_A, [], SECS_ESC].map((sections) => sec(name, { sections })),
      ),
      // no extLst, and no sldIdLst for the ids to come from
      inp(
        FOUR_DECK,
        { sections: SECS_A },
        PRES,
        `${DECL}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst></p:presentation>`,
      ),
      inp(
        FOUR_DECK,
        { sections: SECS_A },
        PRES,
        presXml(4).replace('</p:presentation>', '<p:extLst/></p:presentation>'),
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.normalizeSections',
    call: (_text, args) => normalizeSections(args.sections as never, args.total as number),
    mutation: 'none',
    built: NORMALIZE.map(([sections, total]) => ({ args: { sections, total } })),
  },
  {
    fn: 'pptxPackageparts.sections.addSection',
    call: (text, args) =>
      run(text, args, (opened) => addSection(opened, args.at as number, args.name as string)),
    built: [
      ...['none', 'two', 'lead', 'three', 'stale', 'swapped', 'rid', 'entity'].flatMap((name) =>
        [0, 1, 2, 3, 4, -1, 99].map((at) => sec(name, { at, name: 'New' })),
      ),
      sec('two', { at: 2, name: 'a & <b> "q" \u0001 \u{1F600} \ud55c\uae00' }),
      sec('none', { at: 1, name: '' }),
      sec('mismatch', { at: 2, name: 'N' }),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.renameSection',
    call: (text, args) =>
      run(text, args, (opened) => renameSection(opened, args.id as string, args.name as string)),
    built: [
      ...['two', 'three', 'lead', 'entity'].flatMap((name) =>
        ['{S1}', '{S2}', '{S3}', '{NONE}', ''].map((id) => sec(name, { id, name: 'Renamed &amp; x' })),
      ),
      sec('two', { id: '{S1}', name: '\u{1F600} <&> "q" \u0001' }),
      sec('none', { id: '{S1}', name: 'x' }),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.removeSection',
    call: (text, args) => run(text, args, (opened) => removeSection(opened, args.id as string)),
    built: [
      ...['two', 'three', 'lead', 'stale', 'swapped', 'one'].flatMap((name) =>
        ['{S1}', '{S2}', '{S3}', '{NONE}'].map((id) => sec(name, { id })),
      ),
      sec('none', { id: '{S1}' }),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.moveSlide',
    call: (text, args) =>
      run(text, args, (opened) => moveSlide(opened, args.from as number, args.to as number)),
    built: [
      ...['none', 'two', 'lead', 'three', 'swapped', 'mismatch'].flatMap((name) =>
        [
          [0, 3],
          [3, 0],
          [1, 2],
          [2, 1],
          [0, 0],
          [1, 99],
          [2, -5],
          [-1, 0],
          [9, 0],
          [0, 1],
          [3, 3],
        ].map(([from, to]) => sec(name, { from, to })),
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.sections.moveSection',
    call: (text, args) =>
      run(text, args, (opened) =>
        moveSection(opened, args.id as string, args.dir as 'up' | 'down'),
      ),
    built: [
      ...['two', 'lead', 'three', 'swapped', 'stale', 'mismatch', 'none'].flatMap((name) =>
        [
          ['{S1}', 'down'],
          ['{S2}', 'up'],
          ['{S1}', 'up'],
          ['{S2}', 'down'],
          ['{S3}', 'up'],
          ['{S3}', 'down'],
          ['{NONE}', 'up'],
        ].map(([id, dir]) => sec(name, { id, dir })),
      ),
    ],
  },

  // comments.ts
  {
    fn: 'pptxPackageparts.comments.getSlideComments',
    call: (text, args) =>
      run(text, args, (opened) => getSlideComments(opened.archive, pathArg(args))),
    built: [
      ...CD_BY_AUTHORS.flatMap((deck) =>
        CM_TEXTS.map((text) => inp(deck, { path: SLIDE_PATH }, COMMENT1, text)),
      ),
      // `&#38;amp;` is one `&amp;` text: read once
      ...[cmLst(cm(0, 1, '&#38;amp; &#38;lt;b&#38;gt;'))].map((text) =>
        inp(CD_A, { path: SLIDE_PATH }, COMMENT1, text),
      ),
      inp(CD_A, { path: SLIDE_PATH }),
      inp(CD_A_NO_REL, { path: SLIDE_PATH }),
      inp(CD_A, { path: 'ppt/slides/slide9.xml' }),
    ],
  },
  {
    fn: 'pptxPackageparts.comments.addSlideComment',
    call: (text, args) =>
      run(text, args, (opened) =>
        addSlideComment(opened, slideArg(args), args.opts as Parameters<typeof addSlideComment>[2]),
      ),
    built: [
      // no author table and no comments part: both are created
      ...COMMENT_OPTS.map((opts) => inp(CD_NONE_NO_REL, { slide: 0, opts })),
      // the author is there: its lastIdx is bumped (or added)
      ...COMMENT_OPTS.map((opts) => inp(CD_A_NO_REL, { slide: 0, opts })),
      ...COMMENT_OPTS.slice(0, 3).map((opts) => inp(CD_ONE_NO_REL, { slide: 0, opts })),
      ...COMMENT_OPTS.slice(7, 9).map((opts) => inp(CD_ENTITY_NO_REL, { slide: 0, opts })),
      ...COMMENT_OPTS.slice(0, 2).map((opts) => inp(CD_ODD_NO_REL, { slide: 0, opts })),
      // a comments part there: positions stagger by its count
      ...[cmLst(), NINE, CM_TEXTS[0]!, cmLst('<p:cm>'), '', 'no list'].map((text) =>
        inp(CD_A, { slide: 0, opts: COMMENT_OPTS[0] }, COMMENT1, text),
      ),
      // the relationship names a part that is not there, a table that is empty, no content types
      inp(CD_A, { slide: 0, opts: COMMENT_OPTS[0] }),
      inp(CD_EMPTY_AUTHORS, { slide: 0, opts: COMMENT_OPTS[0] }),
      inp(CD_NO_TYPES, { slide: 0, opts: COMMENT_OPTS[0] }),
      inp(CD_OTHER_PART, { slide: 0, opts: COMMENT_OPTS[0] }),
      inp(CD_NONE_NO_REL, { slide: 5, opts: COMMENT_OPTS[0] }),
      inp(CD_NONE_NO_REL, { slide: -1, opts: COMMENT_OPTS[0] }),
    ],
  },
  {
    fn: 'pptxPackageparts.comments.deleteSlideComment',
    call: (text, args) =>
      run(text, args, (opened) =>
        deleteSlideComment(opened, slideArg(args), args.ref as { authorId: number; idx: number }),
      ),
    built: [
      ...[
        cmLst(cm(0, 1, 'a'), cm(1, 2, 'b'), cm(0, 3, 'c')),
        cmLst(cm(0, 1, 'only')),
        cmLst(cm(null, 1, 'no author id'), cm('007', '008', 'zeros')),
        cmLst(cm(0, 1, 'a'), '<p:cm authorId="0" idx="1"/>'),
        cmLst(),
        '',
        'not xml',
      ].flatMap((text) =>
        [
          { authorId: 0, idx: 1 },
          { authorId: 1, idx: 2 },
          { authorId: 0, idx: 9 },
          { authorId: 9, idx: 9 },
          { authorId: -1, idx: 1 },
          { authorId: 7, idx: 8 },
        ].map((ref) => inp(CD_A, { slide: 0, ref }, COMMENT1, text)),
      ),
      // the part is also related from slide 2: it stays when slide 1 lets go of it
      ...[0, 1].map((slide) =>
        inp(CD_SHARED, { slide, ref: { authorId: 0, idx: 1 } }, COMMENT1, cmLst(cm(0, 1, 'shared'))),
      ),
      inp(CD_A_NO_REL, { slide: 0, ref: { authorId: 0, idx: 1 } }),
      inp(CD_A, { slide: 0, ref: { authorId: 0, idx: 1 } }),
      inp(CD_A, { slide: 4, ref: { authorId: 0, idx: 1 } }, COMMENT1, cmLst(cm(0, 1, 'a'))),
      inp(CD_A, { slide: -1, ref: { authorId: 0, idx: 1 } }, COMMENT1, cmLst(cm(0, 1, 'a'))),
    ],
  },

  // resource-cleanup.ts
  {
    fn: 'pptxPackageparts.resource-cleanup.cleanupSupersededSlideResources',
    call: (text, args) =>
      run(text, args, (opened, at) =>
        cleanupSupersededSlideResources(
          opened,
          at.slide(slideArg(args)),
          text,
          args.current as string,
        ),
      ),
    built: [
      ...resNames.flatMap((name) =>
        PREVIOUS.flatMap((previous) =>
          CURRENT.map((current) => ({
            text: previous,
            args: { deck: RES.get(name)!.deck, slide: 0, current },
          })),
        ),
      ),
      // slide 2, and a slide that is not there
      ...[1, 7].flatMap((slide) =>
        [0, 4].map((i) => ({
          text: PREVIOUS[i]!,
          args: { deck: RES.get('plain')!.deck, slide, current: CURRENT[0]! },
        })),
      ),
    ],
  },
  {
    fn: 'pptxPackageparts.resource-cleanup.cleanupDeletedElementResources',
    call: (text, args) =>
      run(text, args, (opened, at) =>
        cleanupDeletedElementResources(opened, at.slide(slideArg(args)), text),
      ),
    built: resNames.flatMap((name) =>
      PREVIOUS.flatMap((removed) =>
        [0, 1].map((slide) => ({
          text: removed,
          args: { deck: RES.get(name)!.deck, slide },
        })),
      ),
    ),
  },
  {
    fn: 'pptxPackageparts.resource-cleanup.removeRelationshipAndCollectOwnedTarget',
    call: (text, args) =>
      run(text, args, (opened) =>
        removeRelationshipAndCollectOwnedTarget(opened.archive, args.source as string, args.id as string),
      ),
    built: resNames.flatMap((name) => {
      const { deck, slide1Rels } = RES.get(name)!
      return [
        ['ppt/slides/slide1.xml', 'rId2'],
        ['ppt/slides/slide1.xml', 'rId3'],
        ['ppt/slides/slide1.xml', 'rId4'],
        ['ppt/slides/slide1.xml', 'rId5'],
        ['ppt/slides/slide1.xml', 'rId6'],
        ['ppt/slides/slide1.xml', 'rId7'],
        ['ppt/slides/slide1.xml', 'rId99'],
        ['ppt/slides/slide1.xml', '__proto__'],
        ['ppt/slides/slide2.xml', 'rId2'],
        ['ppt/slides/slide2.xml', 'rId4'],
        ['ppt/charts/chart1.xml', 'rId1'],
        ['ppt/charts/chart1.xml', 'rId2'],
        ['ppt/missing.xml', 'rId1'],
        ['', 'rId1'],
        ['ppt/presentation.xml', 'rId2'],
      ].map(([source, id]) => inp(deck, { source, id }, SLIDE1_RELS, slide1Rels))
    }),
  },
  {
    fn: 'pptxPackageparts.resource-cleanup.removePartWithOwnedResources',
    call: (text, args) =>
      run(text, args, (opened) => removePartWithOwnedResources(opened.archive, args.part as string)),
    built: resNames.flatMap((name) => {
      const { deck } = RES.get(name)!
      return [
        SLIDE,
        slideWith(marker('ppt/media/model1.glb')),
        slideWith(marker('ppt/media/model2.glb'), marker('ppt/media/orphan.png')),
      ].flatMap((text) =>
        [
          'ppt/slides/slide1.xml',
          'ppt/slides/slide2.xml',
          'ppt/charts/chart1.xml',
          NOTES1,
          'ppt/media/image1.png',
          'ppt/media/model1.glb',
          'ppt/missing.xml',
          'ppt/presentation.xml',
          '',
        ].map((part) => inp(deck, { part }, 'ppt/slides/slide1.xml', text)),
      )
    }),
  },
]
