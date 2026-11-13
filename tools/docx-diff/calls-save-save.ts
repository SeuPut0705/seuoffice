// Group `save`, slice `save` (crates/docx-engine/src/save/save/): the
// helpers of patch.ts (through save-internals.ts, since it exports few of
// them), run-picture.ts, and the write halves of section.ts, notes.ts and
// xml-number.ts. `saveDocx` itself is compared whole by model-save.ts, comparison
// (i), over the corpus and edited models.
import { buildNotesXml, parseNotesXml } from './reference/notes'
import { editsOf, NOTE_PARTS } from './withheld-inputs'
import { missingHeadingLevels, nextFreeRelId, type SaveBlock } from './reference/patch'
import { patchHfPicturesXml, patchRunPictureXml } from './reference/run-picture'
import {
  applyPageNumType,
  applySectionSettings,
  applySectionStartType,
  applyTitlePg,
  injectIntoSectPr,
  pageBordersXml,
} from './reference/section'
import { usableNumber, usablePictureSize, usablePositionOffset } from './reference/xml-number'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { saveInternals } from './save-internals'

const internals = await saveInternals()

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const PG_SZ = '<w:pgSz w:w="12240" w:h="15840"/>'
const PG_MAR =
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'

const SECT_PRS: string[] = [
  '<w:sectPr/>',
  '<w:sectPr></w:sectPr>',
  `<w:sectPr>${PG_SZ}${PG_MAR}</w:sectPr>`,
  `<w:sectPr ${W}><w:headerReference w:type="default" r:id="rId1"/>${PG_SZ}${PG_MAR}<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>`,
  `<w:sectPr><w:type w:val="continuous"/>${PG_SZ}<w:pgMar w:top="-1440" w:right="1440" w:bottom="-720" w:left="1800"/><w:pgNumType w:fmt="upperRoman" w:start="2"/><w:cols w:num="2" w:space="425"/><w:titlePg/><w:bidi/></w:sectPr>`,
  `<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>${PG_MAR}<w:pgBorders w:offsetFrom="page"><w:top w:val="single" w:sz="4" w:space="24" w:color="auto"/></w:pgBorders><w:cols w:num="3" w:space="720" w:equalWidth="0"><w:col w:w="2000" w:space="500"/><w:col w:w="3000" w:space="500"/><w:col w:w="4000"/></w:cols><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>`,
  `<w:sectPr><w:pgSz w:w='12240' w:h='15840'/><w:pgMar w:top='1000.5' w:right='1440'/><w:cols w:num="2.0" w:space="720.7" w:w="3.5"/><w:bidi w:val="0"></w:bidi><w:pgNumType w:fmt="decimal"></w:pgNumType><w:titlePg w:val="0"/></w:sectPr>`,
  `<w:sectPr><w:footerReference w:type="even" r:id="rId9"/><w:pgSz w:w="1" w:h="2"/><w:pgMar w:top="a" w:header="9"/><w:cols/></w:sectPr>`,
  '<w:sectPr unclosed',
]

const SETTINGS = {
  pageWidth: 11906,
  pageHeight: 16838,
  orientation: 'portrait',
  marginTop: 1134,
  marginRight: 1134,
  marginBottom: 1134,
  marginLeft: 1134,
  pageBorder: false,
  columns: 1,
}

const BORDER_SIDE = { val: 'single', widthPt: 0.5, spacePt: 4, color: 'FF0000' }
const SETTINGS_VARIANTS: Array<Record<string, unknown>> = [
  SETTINGS,
  { ...SETTINGS, orientation: 'landscape', pageWidth: 16838, pageHeight: 11906 },
  { ...SETTINGS, gutter: 360, marginLeft: 1500, headerDist: 600, footerDist: 500 },
  {
    ...SETTINGS,
    gutter: 360,
    gutterAtTop: true,
    marginTop: 100,
    marginTopFixed: true,
    marginBottomFixed: true,
  },
  { ...SETTINGS, pageBorder: true },
  {
    ...SETTINGS,
    pageBorder: true,
    pageBorderProps: {
      spacePt: 4,
      widthPt: 0.5,
      sides: {
        top: BORDER_SIDE,
        left: { ...BORDER_SIDE, art: true, shadow: true },
        bottom: { ...BORDER_SIDE, frame: true, widthPt: 3 },
      },
      display: 'firstPage',
      offsetFrom: 'page',
      zOrder: 'back',
    },
  },
  { ...SETTINGS, pageBorder: true, pageBorderProps: { spacePt: 4, widthPt: 0.5 } },
  { ...SETTINGS, columns: 2 },
  { ...SETTINGS, columns: 2, colSpace: 300 },
  { ...SETTINGS, columns: 3, colWidths: [2000, 3000, 4000], colSpace: 500 },
  { ...SETTINGS, columns: 3, colWidths: [1000, 1000] },
  { ...SETTINGS, columns: 1, colSpace: 100 },
  { ...SETTINGS, bidi: true },
  { ...SETTINGS, bidi: false },
]

const sectBuilt = (extra: Array<Record<string, unknown>>): Input[] =>
  SECT_PRS.flatMap((text) => extra.map((args) => ({ text, args })))

const NOTE_ORIGINAL = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> kept</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:pPr/><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p></w:footnote><w:ins w:id="7001"/></w:footnotes>`
const NOTES_LISTS: Array<Array<Record<string, unknown>>> = [
  [],
  [{ id: '1', text: ' kept' }],
  [{ id: '1', text: 'changed' }],
  [{ id: '2', text: 'one\ntwo changed' }],
  [{ id: '2', text: 'only one paragraph' }],
  [{ id: '3', text: 'new\nnote' }],
  [
    {
      id: '4',
      text: '',
      richParas: [
        [
          {
            text: 'rich',
            bold: true,
            italic: true,
            underline: true,
            strike: true,
            color: 'ff0000',
            sizeHalfPoints: 30,
            fontAscii: 'Arial',
            font: 'MS Gothic',
          },
          { text: 'ins', ins: { author: 'A', date: '2024-01-01T00:00:00Z', id: '7001' } },
          { text: 'del', del: { author: 'B' } },
        ],
        [{ text: 'second' }],
      ],
    },
  ],
  [
    { id: '5', text: 'a & b < c', richParas: [] },
    { id: '6', text: '' },
  ],
  [
    {
      id: '7',
      text: '',
      richParas: [
        [{ text: 'a & b < c' }, { text: 'x < y & z', del: { author: 'B' } }],
        [{ text: '<w:t>&amp;</w:t>', bold: true }],
      ],
    },
  ],
]

/** Notes parts that hold hidden text, each with the edits a person can make to a note: unchanged, across words, a paragraph more or fewer. */
const HIDDEN_NOTES: Input[] = NOTE_PARTS.flatMap((text) =>
  parseNotesXml(text, 'footnote')
    .slice(0, 2)
    .flatMap((note) =>
      editsOf(note.text).flatMap((edited) =>
        (['footnote', 'endnote'] as const).map((kind) => ({
          text: kind === 'endnote' ? text.replaceAll('w:footnote', 'w:endnote') : text,
          args: {
            kind,
            notes: [
              { id: note.id, text: edited },
              { id: '99', text: 'a new note' },
            ],
            hasOriginal: true,
          },
        })),
      ),
    ),
)

const PICTURE_PART = `<w:hdr ${W}><w:p><w:r><w:drawing><wp:anchor simplePos="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:posOffset>1</wp:posOffset></wp:positionH><wp:positionV relativeFrom="margin"><wp:posOffset>2</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="952500"/><wp:wrapNone/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="952500" cy="952500"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:drawing><wp:anchor><wp:extent cx="2" cy="2"/><a:blip r:embed="rId2"/><pic:pic/></wp:anchor></w:drawing></w:r></w:p></w:hdr>`
const HF_EDITS: Array<Record<string, unknown>> = [
  {},
  { 0: { widthPx: 20, heightPx: 30 } },
  { 0: { posXPx: 10, posYPx: 20, widthPx: 30, heightPx: 40 } },
  { 0: { posXPx: 10, widthPx: 30, heightPx: 40 }, 2: { posYPx: 5, widthPx: 7, heightPx: 8 } },
  { 1: { posXPx: 10, widthPx: 30, heightPx: 40 } },
  { 0: { posXPx: 1e300, posYPx: 3, widthPx: 0, heightPx: 5 } },
]

const ANCHOR = (h: string, v: string, wrap = '<wp:wrapSquare wrapText="right"/>'): string =>
  `<w:drawing><wp:anchor distT="0"><wp:positionH relativeFrom="column">${h}</wp:positionH><wp:positionV relativeFrom="paragraph">${v}</wp:positionV><wp:extent cx="952500" cy="476250"/>${wrap}<wp:docPr id="1" name="x"/><a:graphic><a:graphicData><pic:pic><a:blip r:embed="rId5"/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`
const INLINE =
  '<w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="y"/><a:graphic><a:graphicData><pic:pic><a:blip r:embed="rId5"/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
const PICTURES: string[] = [
  ANCHOR('<wp:posOffset>100</wp:posOffset>', '<wp:posOffset>200</wp:posOffset>'),
  ANCHOR(
    '<wp:align>left</wp:align>',
    '<wp:align>top</wp:align>',
    '<wp:wrapTight wrapText="left"><wp:wrapPolygon edited="0"/></wp:wrapTight>',
  ),
  ANCHOR('<wp:posOffset>5</wp:posOffset>', '<wp:posOffset>6</wp:posOffset>', '<wp:wrapNone/>'),
  INLINE,
  '<w:pict><v:shape/></w:pict>',
  'no drawing',
]
const GEOMETRIES: Array<Record<string, unknown>> = [
  {},
  { widthPx: 20, heightPx: 10 },
  { wrap: 'square-left' },
  { wrap: 'square-right', offsetXEmu: 300, offsetYEmu: 400, relH: 'margin', relV: 'page' },
  { wrap: 'tight-left', widthPx: 5, heightPx: 5 },
  { wrap: 'behind', offsetXEmu: 1, offsetYEmu: 2 },
  { wrap: 'front', lineCenterV: true, offsetYEmu: 7, relV: 'line' },
  { wrap: 'topBottom', offsetXEmu: 1e300 },
  { wrap: null, offsetXEmu: 10 },
  { widthPx: 0, heightPx: 9, offsetXEmu: null },
]

const PARTS_WITH_MEDIA: Array<Array<[string, string]>> = [
  [],
  [
    ['word/media/aidocs3.png', 'x'],
    ['word/media/aidocs12.jpg', 'y'],
    ['word/media/image1.png', 'z'],
  ],
  [
    ['word/media/aidocs9.', 'x'],
    ['xword/media/aidocs99.png', 'y'],
  ],
]

const STORY_PARTS: Array<[string, string]> = [
  [
    'word/document.xml',
    '<w:document><w:body><w:p><w:moveFromRangeStart w:id="1" w:name="m"/><w:moveFromRangeEnd w:id="1"/><w:moveToRangeStart w:id="2" w:name="n"/></w:p></w:body></w:document>',
  ],
  ['word/header1.xml', '<w:hdr><w:p><w:moveToRangeEnd w:id="3"/></w:p></w:hdr>'],
  ['word/footnotes.xml', '<w:footnotes/>'],
  ['word/comments2.xml', '<w:comments w:id="12"/>'],
  ['word/media/x.xml', '<a/>'],
  [
    'word/glossary/document.xml',
    '<w:document><w:moveFromRangeStart w:id="4" w:name="g"/></w:document>',
  ],
  ['customXml/item1.xml', '<w:id w:id="99"/>'],
]

const PARAS_REVISION = [
  '<w:p/>',
  '<w:p><w:r><w:t>plain</w:t></w:r></w:p>',
  '<w:p w14:paraId="1"><w:pPr><w:jc w:val="left"/></w:pPr><w:ins w:id="1"><w:r><w:t>i</w:t></w:r></w:ins></w:p>',
  '<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:del w:id="2"><w:r><w:delText>d</w:delText></w:r></w:del></w:p>',
  '<w:p><w:pPr><w:rPr><w:ins w:id="5" w:author="x"/></w:rPr></w:pPr><w:ins><w:r/></w:ins></w:p>',
  '<w:p><w:pPr><w:pPrChange w:id="3"/></w:pPr></w:p>',
  '<w:p><w:pPr><w:rPr/></w:pPr></w:p>',
  '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>',
  '<w:p><w:pPr></w:p>',
]

const NUMBERING = `<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0" w:tplc="X"/></w:abstractNum></w:numbering>`
const LEVELS = [
  { numFmt: 'decimal', lvlText: '%1.', indentLeft: 720 },
  { numFmt: 'bullet', lvlText: '•', indentLeft: 360, hanging: 180, start: 3 },
]

const RELS = [
  '',
  '<Relationships/>',
  '<Relationships><Relationship Id="rId1" Type="t" Target="a"/><Relationship Id="rId3" Type="t" Target="b"/></Relationships>',
  `<Relationships><Relationship Id='rId2' Type='t' Target='a'/><Relationship Id = "rId4" Target="z"/><Relationship Id="rId5"></Relationship><Relationship Id="rId02" Type="t" Target="b"/><Relationship Id="rId9x" Target="q"/></Relationships>`,
  '<Relationship Id="rId1" Target="a"/><Relationship Id="rId1"/> <Relationship Id="rId2" Target="a">',
]

const SAVE_BLOCKS: SaveBlock[][] = [
  [],
  [{ kind: 'original', docxIndex: 1 }],
  [{ kind: 'generated', block: { type: 'heading', level: 2, runs: [] } }],
  [
    { kind: 'generated', block: { type: 'heading', level: 12, runs: [] } },
    { kind: 'generated', block: { type: 'heading', level: 0, runs: [] } },
  ],
  [
    { kind: 'generated', block: { type: 'heading', level: 1, styleId: 'H', runs: [] } },
    { kind: 'generated', block: { type: 'heading', level: 4, outlineOnly: true, runs: [] } },
    { kind: 'generated', block: { type: 'paragraph', runs: [] } },
    { kind: 'xml', xml: '<w:p/>' },
  ],
  [
    { kind: 'generated', block: { type: 'heading', runs: [] } },
    { kind: 'generated', block: { type: 'heading', level: 1.5, runs: [] } },
    { kind: 'generated', block: { type: 'heading', level: 9, runs: [] } },
  ],
]

const IMAGES: Array<Record<string, unknown>> = [
  { base64: 'AAAA', mime: 'image/png', widthPx: 10, heightPx: 20 },
  { base64: '', mime: 'image/jpeg', widthPx: 0, heightPx: 5, rotDeg: 1e300, zOrder: 1e300 },
  {
    base64: 'AA',
    mime: 'image/gif',
    widthPx: -3,
    heightPx: 4,
    rotDeg: 45,
    zOrder: 2,
    posOffsetEmu: { x: 1e300, y: 0 },
  },
  {
    base64: 'AA',
    mime: 'image/png',
    widthPx: 1e300,
    heightPx: 3,
    posOffsetEmu: { x: 5, y: 6, relativeTo: 'page' },
    paraSpacing: { beforeTwips: 1e300, afterTwips: 12, lineTwips: 240, lineRule: 'exact' },
  },
  { base64: 'AA', mime: 'image/png', widthPx: 8, heightPx: 3, paraSpacing: {} },
]

const NUMBERS = [0, 1, -1, 2.5, 1e15, 1e300, 3e9, -3e9, null, 9525, 27273042316900, 2147483647.4]

export const SAVE_SAVE: CallSpec[] = [
  {
    fn: 'save.applyPageNumType',
    call: (text, args) =>
      applyPageNumType(text, args.fmt as string | undefined, args.start as number | undefined),
    built: sectBuilt([
      {},
      { fmt: 'decimal' },
      { start: 3 },
      { fmt: 'lowerRoman', start: 0 },
      { fmt: '', start: -2.5 },
    ]),
  },
  {
    fn: 'save.injectIntoSectPr',
    call: (text, args) => injectIntoSectPr(text, args.tag as string),
    built: [...SECT_PRS, 'no sectPr', '<w:p><w:pPr><w:sectPr/></w:pPr></w:p>'].flatMap((text) =>
      ['<w:headerReference w:type="default" r:id="rId1"/>', '$&$1'].map((tag) => ({
        text,
        args: { tag },
      })),
    ),
  },
  {
    fn: 'save.pageBordersXml',
    call: (_text, args) => pageBordersXml(args.props as Parameters<typeof pageBordersXml>[0]),
    built: SETTINGS_VARIANTS.map((settings) => ({
      args: { props: settings.pageBorderProps ?? null },
    })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.applySectionSettings',
    call: (text, args) =>
      applySectionSettings(text, args.settings as Parameters<typeof applySectionSettings>[1]),
    built: sectBuilt(SETTINGS_VARIANTS.map((settings) => ({ settings }))),
    argMutation: true,
  },
  {
    fn: 'save.applySectionStartType',
    call: (text, args) =>
      applySectionStartType(text, args.type as Parameters<typeof applySectionStartType>[1]),
    built: sectBuilt(
      ['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn'].map((type) => ({ type })),
    ),
  },
  {
    fn: 'save.applyTitlePg',
    call: (text, args) => applyTitlePg(text, args.on as boolean),
    built: sectBuilt([{ on: true }, { on: false }]),
  },
  {
    fn: 'save.buildNotesXml',
    call: (text, args) =>
      buildNotesXml(
        args.kind as 'footnote' | 'endnote',
        args.notes as Parameters<typeof buildNotesXml>[1],
        args.hasOriginal ? text : null,
      ),
    built: NOTES_LISTS.flatMap((notes): Input[] =>
      (['footnote', 'endnote'] as const).flatMap((kind): Input[] => [
        { text: NOTE_ORIGINAL, args: { kind, notes, hasOriginal: true } },
        {
          text: NOTE_ORIGINAL.replaceAll('w:footnote', 'w:endnote'),
          args: { kind, notes, hasOriginal: true },
        },
        { text: '', args: { kind, notes } },
      ]),
    ).concat(HIDDEN_NOTES),
    argMutation: true,
  },
  {
    fn: 'save.patchHfPicturesXml',
    call: (text, args) =>
      patchHfPicturesXml(text, args.edits as Parameters<typeof patchHfPicturesXml>[1]),
    built: HF_EDITS.map((edits) => ({ text: PICTURE_PART, args: { edits } })),
    argMutation: true,
  },
  {
    fn: 'save.patchRunPictureXml',
    call: (text, args) =>
      patchRunPictureXml(text, args.next as Parameters<typeof patchRunPictureXml>[1]),
    built: PICTURES.flatMap((text) => GEOMETRIES.map((next) => ({ text, args: { next } }))),
    argMutation: true,
  },
  {
    fn: 'save.usableNumber',
    call: (_text, args) => usableNumber(args.value, args.emuPerUnit as number | undefined),
    built: NUMBERS.flatMap((value) =>
      [{}, { emuPerUnit: 9525 }, { emuPerUnit: 635 }].map((more) => ({ args: { value, ...more } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.usablePictureSize',
    call: (_text, args) => usablePictureSize(args.widthPx, args.heightPx),
    built: NUMBERS.flatMap((widthPx) =>
      [1, 0, null, 5e9, 1e300].map((heightPx) => ({ args: { widthPx, heightPx } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.usablePositionOffset',
    call: (_text, args) => usablePositionOffset(args.value, args.emuPerUnit as number | undefined),
    built: NUMBERS.flatMap((value) =>
      [{}, { emuPerUnit: 9525 }].map((more) => ({ args: { value, ...more } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.nextFreeRelId',
    call: (text) => nextFreeRelId(text),
    built: RELS.map((text) => ({ text })),
  },
  {
    fn: 'save.occupiedRelIds',
    call: (text) => [...(internals.occupiedRelIds!(text) as Set<string>)].sort(),
    built: RELS.map((text) => ({ text })),
  },
  {
    fn: 'save.missingHeadingLevels',
    call: (_text, args) =>
      missingHeadingLevels(
        args.blocks as SaveBlock[],
        new Map(args.headingStyleIds as Array<[number, string]>),
      ),
    built: SAVE_BLOCKS.flatMap((blocks) =>
      [
        [],
        [[1, 'Heading1']],
        [
          [2, 'H2'],
          [3, 'H3'],
        ],
        [[4, 'x']],
      ].map((headingStyleIds) => ({ args: { blocks, headingStyleIds } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.usableNewImage',
    call: (_text, args) => internals.usableNewImage!(args.image),
    built: IMAGES.map((image) => ({ args: { image } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.saveBlockDocxIndex',
    call: (_text, args) => internals.saveBlockDocxIndex!(args.block),
    built: [
      { kind: 'original', docxIndex: 3 },
      { kind: 'generated', block: { type: 'paragraph', runs: [] }, docxIndex: 4 },
      { kind: 'generated', block: { type: 'paragraph', runs: [] } },
      { kind: 'xml', xml: '<w:p/>', docxIndex: 0 },
      { kind: 'xml', xml: '<w:p/>' },
      { kind: 'image', image: IMAGES[0] },
      { kind: 'images', images: [IMAGES[0]] },
      { kind: 'chart', chart: { kind: 'bar', categories: [], series: [] } },
    ].map((block) => ({ args: { block } })),
    mutation: 'none',
  },
  {
    fn: 'save.replaceAbstractNumLevel',
    call: (text, args) =>
      internals.replaceAbstractNumLevel!(text, args.abstractNumId, args.ilvl, args.level),
    built: [NUMBERING, '<w:numbering/>', ''].flatMap((text) =>
      ['1', '2', '3', 'a.b'].flatMap((abstractNumId) =>
        [0, 1, 2, 5].flatMap((ilvl) =>
          LEVELS.map((level) => ({ text, args: { abstractNumId, ilvl, level } })),
        ),
      ),
    ),
    argMutation: true,
  },
  {
    fn: 'save.patchCoreProps',
    call: (text, args) => internals.patchCoreProps!(text, args.savedAt),
    built: [
      '<cp:coreProperties><dcterms:modified xsi:type="dcterms:W3CDTF">2020-01-01T00:00:00Z</dcterms:modified><cp:revision>4</cp:revision></cp:coreProperties>',
      '<cp:coreProperties><dcterms:modified/><cp:revision>x</cp:revision></cp:coreProperties>',
      '<cp:coreProperties/>',
      '<cp:coreProperties><cp:revision>99999999999999999999</cp:revision></cp:coreProperties>',
    ].flatMap((text) =>
      ['2024-05-06T07:08:09.123Z', '2024-05-06T07:08:09Z', '$&-$1', 'text'].map((savedAt) => ({
        text,
        args: { savedAt },
      })),
    ),
  },
  {
    fn: 'save.defaultParagraphStyleId',
    call: (_text, args) =>
      internals.defaultParagraphStyleId!(new Map(args.styles as Array<[string, unknown]>)),
    built: [
      [],
      [['A', { styleId: 'A', name: 'A', type: 'paragraph' }]],
      [
        ['A', { styleId: 'A', name: 'A', type: 'paragraph' }],
        ['B', { styleId: 'B', name: 'B', type: 'paragraph', isDefault: true }],
      ],
      [['C', { styleId: 'C', name: 'C', type: 'character', isDefault: true }]],
    ].map((styles) => ({ args: { styles } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.insertBeforeClosingTag',
    call: (text, args) => internals.insertBeforeClosingTag!(text, args.content),
    built: ['<w:p><w:r/></w:p>', '<w:p/>', 'no tags', '', '</w:p></w:p>'].flatMap((text) =>
      ['<w:r/>', '$&'].map((content) => ({ text, args: { content } })),
    ),
  },
  {
    fn: 'save.markParagraphRevision',
    call: (text, args) => internals.markParagraphRevision!(text, args.kind, args.attrs),
    built: PARAS_REVISION.flatMap((text) =>
      (['ins', 'del'] as const).map((kind) => ({
        text,
        args: { kind, attrs: ' w:id="1" w:author="A"' },
      })),
    ),
  },
  {
    fn: 'save.fillRevisionIds',
    call: (text, args) =>
      internals.fillRevisionIds!(
        text,
        (
          (n) => () =>
            String(n++)
        )(args.start as number),
      ),
    built: [
      '<w:ins w:id="" w:author="a"/><w:del w:author="b" w:id=""/><w:cellIns w:id=""/><w:cellDel w:id="1"/>',
      '<w:insX w:id=""/><w:ins w:id=\'\'/><w:ins w:id="">',
      'none',
    ].flatMap((text) => [1, 9001, 0].map((start) => ({ text, args: { start } }))),
  },
  {
    fn: 'save.maxBookmarkId',
    call: (text) => internals.maxBookmarkId!(text),
    built: [
      '<w:bookmarkStart w:id="4" w:name="a"/><w:bookmarkEnd w:id="4"/><w:bookmarkStart w:name="b" w:id="12"/>',
      "<w:bookmarkStart w:id='7'/>",
      '<w:bookmarkStartX w:id="9"/>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'save.maxRelId',
    call: (text, args) => internals.maxRelId!(args.absent ? null : text),
    built: [...RELS.map((text) => ({ text })), { text: '', args: { absent: true } }],
  },
  {
    fn: 'save.maxDocPrId',
    call: (text) => internals.maxDocPrId!(text),
    built: [
      '<wp:docPr id="5" name="a"/><wp:docPr name="b" id="12"/>',
      "<wp:docPr id='9002'/>",
      '<wp:docPrX id="9"/>',
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'save.nextImageSeq',
    call: (_text, args) => internals.nextImageSeq!(zipOf(args.parts)),
    built: PARTS_WITH_MEDIA.map((parts) => ({ args: { parts } })),
    mutation: 'none',
  },
  {
    fn: 'save.nextDocPrSeq',
    call: (text, args) => internals.nextDocPrSeq!(zipOf(args.parts), text),
    built: PARTS_WITH_MEDIA.flatMap((parts) =>
      ['', '<wp:docPr id="9050"/>', '<wp:docPr id="5"/>'].map((text) => ({
        text,
        args: { parts },
      })),
    ),
  },
  {
    fn: 'save.retargetImageBlip',
    call: (text, args) => internals.retargetImageBlip!(text, args.rId),
    built: [
      '<w:drawing><a:blip r:embed="rId5" r:link="rId6"/><a:srcRect l="10"/><a:fillRect l="5"/><a:extLst><a:ext uri="x"><asvg:svgBlip r:embed="rId7"/></a:ext></a:extLst></w:drawing>',
      '<a:blip r:link="rId6"/>',
      '<a:blip/>',
      '<a:blip r:embed="rId5"></a:blip><a:fillRect/>',
      'no blip',
    ].flatMap((text) => ['rId11', '$&'].map((rId) => ({ text, args: { rId } }))),
  },
  {
    fn: 'save.carriesMoveRanges',
    call: (_text, args) => internals.carriesMoveRanges!(args.name, args.documentPath),
    built: [
      'word/document.xml',
      'WORD/Header2.XML',
      'word/footer.xml',
      'word/footnotes.xml',
      'word/endnotes.XML',
      'word/glossary/document.xml',
      'word/comments.xml',
      'word/header1.rels',
      'word/headerx/y.xml',
      'word/main.xml',
    ].map((name) => ({ args: { name, documentPath: 'word/main.xml' } })),
    mutation: 'none',
  },
  {
    fn: 'save.hasOrphanMoveRanges',
    call: (_text, args) => internals.hasOrphanMoveRanges!(zipOf(args.parts), args.documentPath),
    built: [STORY_PARTS, STORY_PARTS.slice(2), STORY_PARTS.slice(4), STORY_PARTS.slice(2, 5)].map(
      (parts) => ({ args: { parts, documentPath: 'word/document.xml' } }),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.cleanStoryMoveRanges',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      await internals.cleanStoryMoveRanges!(zip, args.documentPath)
      return Promise.all(
        Object.keys(zip.files)
          .filter((name) => !zip.files[name]!.dir)
          .map(async (name) => [name, await zip.file(name)!.async('string')]),
      )
    },
    built: [STORY_PARTS, STORY_PARTS.slice(1)].map((parts) => ({
      args: { parts, documentPath: 'word/document.xml' },
    })),
    mutation: 'none',
  },
  {
    fn: 'save.nextRevisionIdAllocator',
    call: (_text, args) => {
      const next = internals.nextRevisionIdAllocator!(args.partsXml, args.floor) as () => string
      return [next(), next(), next()]
    },
    built: [
      [],
      ['<w:ins w:id="12"/>', "<w:del w:id='9005'/><w:ins w:id='x'/>"],
      ['<w:ins w:id="99999999999"/>'],
    ].flatMap((partsXml) =>
      [{}, { floor: 5 }, { floor: 20000 }].map((more) => ({ args: { partsXml, ...more } })),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.nextBookmarkIdAllocator',
    call: (text) => {
      const next = internals.nextBookmarkIdAllocator!(text) as (name: string) => number
      return [next('a'), next('b'), next('c')]
    },
    built: ['', '<w:bookmarkStart w:id="4"/>', "<w:bookmarkEnd w:id='40'/>"].map((text) => ({
      text,
    })),
  },
  {
    fn: 'save.storyPartsXml',
    call: async (_text, args) => internals.storyPartsXml!(zipOf(args.parts)),
    built: [STORY_PARTS, [], STORY_PARTS.slice(2)].map((parts) => ({ args: { parts } })),
    mutation: 'none',
  },
]
