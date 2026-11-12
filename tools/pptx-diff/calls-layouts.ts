// Group `layouts` of comparison (f): layout.ts, builtin-layouts.ts, slide-transfer.ts
// and blank.ts of packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_layouts.rs to `pptxLayouts.<module>.<TypeScript name>`.
//
// A function on an archive: `args.parts` (`[name, text]` pairs) and the text under
// `args.textPart`, as calls-package.ts builds them; the answer is `{ value, entries }`
// with every entry of the archive after the call as `[name, text]`.
import { BLANK_SLIDE_XML, createBlankPptx } from '../../packages/pptx-engine/src/blank'
import {
  BUILTIN_LAYOUTS,
  builtinLayoutInfos,
  ensureBuiltinLayout,
  shouldOfferBuiltinLayouts,
} from '../../packages/pptx-engine/src/builtin-layouts'
import {
  listSlideLayouts,
  parseLayoutPlaceholders,
  placeholderSpXml,
  prepareInsertSlideWithLayout,
} from '../../packages/pptx-engine/src/layout'
import {
  chooseLayout,
  collectPart,
  collectSlideBundle,
  importClipboardParts,
  importSourceLayout,
  listLayouts,
  materializeSlideBundle,
  type SlideBundle,
} from '../../packages/pptx-engine/src/slide-transfer'
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { deckInput, deckNamed, deckOp } from './deck-ops'

type Parts = Array<[string, string]>
type Args = Record<string, unknown>

/** The private constructor, as `open` calls it once the zip is read. */
const Archive = PackageArchive as unknown as new (
  entries: Map<string, Uint8Array>,
  originalHash: string,
) => PackageArchive

/** `args.parts`, then the text under `args.textPart`: that part is what mutations change. */
function archiveOf(text: string, args: Args): PackageArchive {
  const encoder = new TextEncoder()
  const entries = new Map<string, Uint8Array>()
  for (const [name, part] of (args.parts ?? []) as Parts) entries.set(name, encoder.encode(part))
  if (typeof args.textPart === 'string') entries.set(args.textPart, encoder.encode(text))
  return new Archive(entries, 'gate')
}

/** What a function that changes an archive answers. */
function afterCall(archive: PackageArchive, value: unknown): unknown {
  return {
    value,
    entries: [...archive.entries].map(([name, bytes]) => [name, Buffer.from(bytes).toString('utf8')]),
  }
}

/** A value as it reaches Rust: the keys that hold undefined are gone. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const rels = (...items: string[]): string =>
  `${XML_DECL}<Relationships xmlns="${RELS_NS}">${items.join('')}</Relationships>`
const rel = (id: string, type: string, target: string, extra = ''): string =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${extra}/>`
const types = (...items: string[]): string =>
  `${XML_DECL}<Types xmlns="${CT_NS}">${items.join('')}</Types>`
const override = (part: string, type: string): string =>
  `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`
const dflt = (ext: string, type: string): string =>
  `<Default Extension="${ext}" ContentType="${type}"/>`

const PRES_RELS = 'ppt/_rels/presentation.xml.rels'
const CT = '[Content_Types].xml'
const SLIDE_PATH = 'ppt/slides/slide1.xml'
const LAYOUT_1 = 'ppt/slideLayouts/slideLayout1.xml'
const MASTER_1 = 'ppt/slideMasters/slideMaster1.xml'

/** One placeholder shape of a layout, geometry in an a:xfrm. */
const ph = (type: string, idx: string, x: number, y: number, cx: number, cy: number): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:sp>`

const layoutXml = (name: string, type: string, body: string): string =>
  `<p:sldLayout xmlns:a="a" xmlns:p="p" xmlns:r="r"${type ? ` type="${type}"` : ''}><p:cSld${name ? ` name="${name}"` : ''}><p:spTree>${body}</p:spTree></p:cSld></p:sldLayout>`

const presentation = (masters: string): string =>
  `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldMasterIdLst>${masters}</p:sldMasterIdLst>` +
  '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
  '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>'

const masterXml = (layoutIds: string): string =>
  `<p:sldMaster xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree/></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1"/>${layoutIds}<p:txStyles/></p:sldMaster>`

const LAYOUT_IDS = (...pairs: Array<[number, string]>): string =>
  `<p:sldLayoutIdLst>${pairs.map(([id, rid]) => `<p:sldLayoutId id="${id}" r:id="${rid}"/>`).join('')}</p:sldLayoutIdLst>`

const TITLE_LAYOUT = layoutXml(
  'Title Slide',
  'title',
  ph('ctrTitle', '', 1524000, 1122363, 9144000, 2387600) +
    ph('subTitle', '1', 1524000, 3602038, 9144000, 1655762) +
    ph('dt', '10', 1, 2, 3, 4),
)
const CONTENT_LAYOUT = layoutXml(
  'Title and Content',
  'obj',
  ph('title', '', 838200, 365125, 10515600, 1325563) +
    ph('', '1', 838200, 1825625, 10515600, 4351338),
)

/** A deck of two slides, two layouts, a master, a theme, media, a chart with its workbook. */
const DECK: Parts = [
  [
    CT,
    types(
      dflt('rels', 'application/vnd.openxmlformats-package.relationships+xml'),
      dflt('xml', 'application/xml'),
      dflt('png', 'image/png'),
      dflt('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      override('ppt/presentation.xml', 'presentationml.presentation.main'),
      override(SLIDE_PATH, 'presentationml.slide'),
      override('ppt/slides/slide2.xml', 'presentationml.slide'),
      override(LAYOUT_1, 'presentationml.slideLayout'),
      override('ppt/slideLayouts/slideLayout2.xml', 'presentationml.slideLayout'),
      override(MASTER_1, 'presentationml.slideMaster'),
      override('ppt/theme/theme1.xml', 'theme'),
      override('ppt/charts/chart1.xml', 'drawingml.chart'),
    ),
  ],
  ['ppt/presentation.xml', presentation('<p:sldMasterId id="2147483648" r:id="rId1"/>')],
  [
    PRES_RELS,
    rels(
      rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rId2', 'slide', 'slides/slide1.xml'),
      rel('rId3', 'slide', 'slides/slide2.xml'),
    ),
  ],
  [
    SLIDE_PATH,
    '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="a"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>',
  ],
  [
    'ppt/slides/_rels/slide1.xml.rels',
    rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId2', 'image', '../media/image1.png'),
      rel('rId3', 'hyperlink', 'https://example.com/a?b=1&amp;c=2', ' TargetMode="External"'),
      rel('rId4', 'notesSlide', '../notesSlides/notesSlide1.xml'),
      rel('rId5', 'chart', '../charts/chart1.xml'),
    ),
  ],
  ['ppt/slides/slide2.xml', '<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'],
  [
    'ppt/slides/_rels/slide2.xml.rels',
    rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml')),
  ],
  ['ppt/media/image1.png', 'PNG\u0001data'],
  ['ppt/notesSlides/notesSlide1.xml', '<p:notes/>'],
  ['ppt/charts/chart1.xml', '<c:chartSpace/>'],
  [
    'ppt/charts/_rels/chart1.xml.rels',
    rels(rel('rId1', 'package', '../embeddings/book1.xlsx')),
  ],
  ['ppt/embeddings/book1.xlsx', 'xlsx-bytes'],
  [LAYOUT_1, TITLE_LAYOUT],
  [
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
  ],
  ['ppt/slideLayouts/slideLayout2.xml', CONTENT_LAYOUT],
  [
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
  ],
  [MASTER_1, masterXml(LAYOUT_IDS([2147483649, 'rId1'], [2147483650, 'rId2']))],
  [
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId2', 'slideLayout', '../slideLayouts/slideLayout2.xml'),
      rel('rId3', 'theme', '../theme/theme1.xml'),
    ),
  ],
  ['ppt/theme/theme1.xml', '<a:theme name="Office"/>'],
]

const without = (parts: Parts, ...names: string[]): Parts =>
  parts.filter(([name]) => !names.includes(name))
const replacing = (parts: Parts, name: string, text: string): Parts =>
  parts.map(([n, t]) => (n === name ? [n, text] : [n, t]))
const adding = (parts: Parts, ...more: Parts): Parts => [...parts, ...more]

/** The text of `name` as the text input, the rest as parts. */
const split = (parts: Parts, name: string, extra: Args = {}): Input => ({
  text: parts.find(([n]) => n === name)?.[1] ?? '',
  args: { parts: without(parts, name), textPart: name, ...extra },
})

const SIZE_169 = { cx: 12192000, cy: 6858000 }

/** The bundle of a slide of `parts`, as it crosses JSON. */
function bundleOf(parts: Parts, slidePath = SLIDE_PATH, slideXml = '<p:sld/>'): SlideBundle {
  return wire(collectSlideBundle(archiveOf('', { parts }), slidePath, slideXml))
}

// ── layout.ts ────────────────────────────────────────────────────────────────

const PLACEHOLDER_TEXTS: string[] = [
  '',
  TITLE_LAYOUT,
  CONTENT_LAYOUT,
  // graphicFrame and pic, with p:xfrm and a:xfrm
  '<p:graphicFrame><p:nvGraphicFramePr><p:nvPr><p:ph type="tbl" idx="3"/></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></p:xfrm></p:graphicFrame>' +
    '<p:pic><p:nvPicPr><p:nvPr><p:ph type="pic" idx="4"/></p:nvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:spPr></p:pic>' +
    '<p:pic><p:nvPicPr><p:nvPr><p:ph type="clipArt" idx="5"/></p:nvPr></p:nvPicPr><p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:spPr></p:pic>',
  // function types, missing xfrm, missing ph, incomplete geometry
  '<p:sp><p:nvPr><p:ph type="ftr"/></p:nvPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>' +
    '<p:sp><p:nvPr><p:ph type="sldNum"/></p:nvPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>' +
    '<p:sp><p:nvPr><p:ph type="body"/></p:nvPr></p:sp>' +
    '<p:sp><p:nvPr/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>' +
    '<p:sp><p:nvPr><p:ph type="body"/></p:nvPr><a:xfrm><a:off x="1" y="2"/></a:xfrm></p:sp>' +
    '<p:sp><p:nvPr><p:ph type="body"/></p:nvPr><a:xfrm><a:ext cx="3" cy="4"/></a:xfrm></p:sp>',
  // parseInt of everything an attribute can hold
  ['', ' 5', '+7', '-3', '1e3', '0x10', '12abc', 'abc', '1.9', '\u0663', '9'.repeat(400)]
    .map(
      (v) =>
        `<p:sp><p:nvPr><p:ph type="body" idx="${v.length}"/></p:nvPr><a:xfrm><a:off x="${v}" y="1"/><a:ext cx="2" cy="3"/></a:xfrm></p:sp>`,
    )
    .join(''),
  // names the hint table lacks, and ones it has
  ['custom', 'obj', 'subTitle', 'ctrTitle']
    .map(
      (t) =>
        `<p:sp><p:nvPr><p:ph type="${t}"/></p:nvPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>`,
    )
    .join(''),
  // ph forms: self-closing, spaced, no attributes, idx before type, a second xfrm in p:xfrm
  '<p:sp><p:ph/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>' +
    '<p:sp><p:ph idx="7" type="body" /><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>' +
    '<p:sp><p:ph type="body"></p:ph><p:xfrm><a:off x="5" y="6"/><a:ext cx="7" cy="8"/></p:xfrm></p:sp>' +
    '<p:sp><p:ph type="body"/><a:xfrm rot="5"><a:off x="9" y="9"/><a:ext cx="9" cy="9"/></a:xfrm><p:xfrm><a:off x="1" y="1"/><a:ext cx="1" cy="1"/></p:xfrm></p:sp>' +
    '<p:sp><p:ph type="body"/><a:xfrm><a:off x="1" y="2"></a:off><a:ext cx="3" cy="4"></a:ext></a:xfrm></p:sp>',
  // an unclosed shape, nested shapes, a shape in a group, non-BMP text
  '<p:sp><p:ph type="body"/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>',
  '<p:sp><p:sp><p:ph type="body"/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp></p:sp>',
  '<p:grpSp><p:sp><p:ph type="\u{1F600}x" idx="\u{1F600}"/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp></p:grpSp>',
  '<p:sp><p:ph type="a&amp;b" idx="&quot;"/><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>',
]

const LAYOUT_TEXTS: Input[] = [
  { text: layoutXml('Title Slide', 'title', ''), args: {} },
  { text: layoutXml('', '', ''), args: {} },
  { text: layoutXml('A"B', 'x', ''), args: {} },
  { text: '<p:cSld name="Z"/><p:sldLayout type="late"/>', args: {} },
  { text: '<p:cSld\tname="T"/><p:sldLayout\ntype="blank"/>', args: {} },
  { text: '<p:cSldname="no"/><p:sldLayoutX type="no"/>', args: {} },
  // the name as the reader has it: decoded once, any quotes, spaced `=`, other attributes first
  { text: '<p:sldLayout><p:cSld note="a>b" name = \'A &amp; B &#65;\'/></p:sldLayout>', args: {} },
  { text: '<p:sldLayout><p:cSld name="&amp;lt; &#x1F600;"/></p:sldLayout>', args: {} },
  { text: '<p:sldLayout><p:cSld name=""/></p:sldLayout>', args: {} },
  { text: '<p:sldLayout><p:cSld/></p:sldLayout>', args: {} },
  { text: '<p:sldLayout><p:cSldx name="no"/><p:cSld name="late"/></p:sldLayout>', args: {} },
]

const LAYOUT_DECK_ENTRIES: Parts = [
  ['ppt/slideLayouts/slideLayout10.xml', layoutXml('Ten', 'obj', '')],
  ['ppt/slideLayouts/slideLayout2.xml', layoutXml('Two', 'twoObj', ph('body', '1', 1, 2, 3, 4))],
  ['ppt/slideLayouts/slideLayout1.xml', layoutXml('', '', '')],
  ['ppt/slideLayouts/slideLayout3.xml', 'not xml at all'],
  ['ppt/slideLayouts/slideLayoutA.xml', layoutXml('A', 'a', '')],
  ['ppt/slideLayouts/slideLayout4.xml.rels', 'x'],
  ['ppt/slideLayouts/_rels/slideLayout5.xml.rels', 'x'],
  ['ppt/slideLayouts/slideLayout6.xml', ''],
  ['xppt/slideLayouts/slideLayout7.xml', layoutXml('X', 'x', '')],
  ['ppt/slideLayouts/slideLayout00.xml', layoutXml('Zero', 'z', '')],
  ['ppt/slideLayouts/slideLayout99999999999999999999999.xml', layoutXml('Big', 'b', '')],
  ['ppt/slideLayouts/slideLayout100000000000000000000000.xml', layoutXml('Bigger', 'b', '')],
]

// ── builtin-layouts.ts ───────────────────────────────────────────────────────

const BUILTIN_KEYS = ['titleSlide', 'titleContent', 'sectionHeader', 'twoContent', 'titleOnly', 'blank']

const sizes: Array<{ cx: number; cy: number }> = [
  SIZE_169,
  { cx: 9144000, cy: 6858000 },
  { cx: 12192000, cy: 0 },
  { cx: 1, cy: 1 },
  { cx: 25400000.5, cy: 14288000.25 },
  { cx: 1e21, cy: 1e300 },
]

const bareDeck = (extra: Parts = []): Parts => [
  [CT, types(dflt('xml', 'application/xml'), override(MASTER_1, 'presentationml.slideMaster'))],
  [MASTER_1, masterXml(LAYOUT_IDS([2147483649, 'rId1']))],
  [
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')),
  ],
  [LAYOUT_1, layoutXml('Foreign', 'custom', ph('body', '1', 1, 2, 3, 4))],
  [
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
  ],
  ...extra,
]

const ENSURE: Input[] = [
  ...BUILTIN_KEYS.map((key) => ({ args: { parts: DECK, size: SIZE_169, key } })),
  ...sizes.map((size) => ({ args: { parts: bareDeck(), size, key: 'twoContent' } })),
  { args: { parts: DECK, size: SIZE_169, key: 'nope' } },
  { args: { parts: DECK, size: SIZE_169, key: 'constructor' } },
  { args: { parts: DECK, size: SIZE_169, key: '' } },
  // the layout exists already, by name
  { args: { parts: bareDeck(), size: SIZE_169, key: 'titleSlide' } },
  {
    args: {
      parts: replacing(bareDeck(), LAYOUT_1, layoutXml('Title Slide', 'title', '')),
      size: SIZE_169,
      key: 'titleSlide',
    },
  },
  // no master at all, a master without rels, a master part empty
  { args: { parts: [[CT, types()]], size: SIZE_169, key: 'blank' } },
  { args: { parts: without(bareDeck(), MASTER_1), size: SIZE_169, key: 'blank' } },
  {
    args: {
      parts: without(bareDeck(), 'ppt/slideMasters/_rels/slideMaster1.xml.rels'),
      size: SIZE_169,
      key: 'blank',
    },
  },
  { args: { parts: replacing(bareDeck(), MASTER_1, ''), size: SIZE_169, key: 'blank' } },
  // the master found by its file name: no layout rels, masters sorted as text
  {
    args: {
      parts: [
        [CT, types()],
        ['ppt/slideMasters/slideMaster2.xml', masterXml('')],
        ['ppt/slideMasters/slideMaster10.xml', masterXml(LAYOUT_IDS([2147483700, 'rId9']))],
        ['ppt/slideMasters/_rels/slideMaster10.xml.rels', rels(rel('rId1', 'theme', 'x.xml'))],
        ['ppt/slideMasters/_rels/slideMaster2.xml.rels', rels(rel('rId5', 'theme', 'x.xml'))],
      ],
      size: SIZE_169,
      key: 'titleOnly',
    },
  },
  // a layout whose master rel is external, and one found first without a master type
  {
    args: {
      parts: replacing(
        bareDeck(),
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        rels(
          rel('rId1', 'slideMaster', 'https://example.com/m.xml', ' TargetMode="External"'),
          rel('rId2', 'theme', 'x.xml'),
        ),
      ),
      size: SIZE_169,
      key: 'blank',
    },
  },
  {
    args: {
      parts: replacing(
        bareDeck(),
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        rels(rel('rId1', 'theme', 'x.xml')),
      ),
      size: SIZE_169,
      key: 'blank',
    },
  },
  // a master part named with `&` and `$&`: written escaped into the layout rels, and as typed elsewhere
  {
    args: {
      parts: [
        [CT, types(dflt('xml', 'application/xml'))],
        ['ppt/slideMasters/m&1$&.xml', masterXml(LAYOUT_IDS([2147483649, 'rId1']))],
        ['ppt/slideMasters/_rels/m&1$&.xml.rels', rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))],
        [LAYOUT_1, layoutXml('Foreign', 'custom', '')],
        [
          'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
          rels(rel('rId1', 'slideMaster', '../slideMasters/m&amp;1$&amp;.xml')),
        ],
      ],
      size: SIZE_169,
      key: 'twoContent',
    },
  },
  // a master whose clrMap holds `$` forms, and none of the layout id list
  {
    args: {
      parts: replacing(
        bareDeck(),
        MASTER_1,
        '<p:sldMaster xmlns:a="a" xmlns:p="p" xmlns:r="r"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="$&amp;" note="$1$$"/></p:sldMaster>',
      ),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  // content types: missing, empty, an override present already, no </Types>
  { args: { parts: without(bareDeck(), CT), size: SIZE_169, key: 'twoContent' } },
  { args: { parts: replacing(bareDeck(), CT, ''), size: SIZE_169, key: 'twoContent' } },
  {
    args: {
      parts: replacing(
        bareDeck(),
        CT,
        types(override('ppt/slideLayouts/slideLayout2.xml', 'presentationml.slideLayout')),
      ),
      size: SIZE_169,
      key: 'twoContent',
    },
  },
  { args: { parts: replacing(bareDeck(), CT, '<Types>'), size: SIZE_169, key: 'twoContent' } },
  // master: no sldLayoutIdLst, ids below and above the floor, ids with other attributes, no clrMap
  {
    args: {
      parts: replacing(bareDeck(), MASTER_1, masterXml('')),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  {
    args: {
      parts: replacing(
        bareDeck(),
        MASTER_1,
        masterXml(LAYOUT_IDS([5, 'rId1'], [2147483900, 'rId2'], [2147483700, 'rId3'])),
      ),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  {
    args: {
      parts: replacing(
        bareDeck(),
        MASTER_1,
        '<p:sldMaster xmlns:r="r"><p:sldLayoutIdLst><p:sldLayoutId  r:id="rId1" id="2147483655"/><p:sldLayoutId id="99999999999999999999999" r:id="rId2"/></p:sldLayoutIdLst></p:sldMaster>',
      ),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  {
    args: {
      parts: replacing(bareDeck(), MASTER_1, '<p:sldMaster><p:cSld/></p:sldMaster>'),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  {
    args: {
      parts: replacing(
        bareDeck(),
        MASTER_1,
        '<p:sldMaster><p:clrMap a="1"/><p:clrMap b="2"/></p:sldMaster>',
      ),
      size: SIZE_169,
      key: 'titleContent',
    },
  },
  // master rels: high rIds, a quoted id, huge numbers, a layout with another number
  {
    args: {
      parts: replacing(
        bareDeck(),
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        rels(
          rel('rId7', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
          rel('rId99999999999999999999999', 'theme', 'x.xml'),
        ),
      ),
      size: SIZE_169,
      key: 'titleOnly',
    },
  },
  {
    args: {
      parts: adding(bareDeck(), ['ppt/slideLayouts/slideLayout12.xml', layoutXml('Twelve', 'x', '')]),
      size: SIZE_169,
      key: 'titleOnly',
    },
  },
  // text of the master is what mutations change
  split(bareDeck(), MASTER_1, { size: SIZE_169, key: 'sectionHeader' }),
  split(bareDeck(), CT, { size: SIZE_169, key: 'sectionHeader' }),
  split(bareDeck(), 'ppt/slideMasters/_rels/slideMaster1.xml.rels', { size: SIZE_169, key: 'twoContent' }),
]

// ── slide-transfer.ts ────────────────────────────────────────────────────────

const collectInput = (
  parts: Parts,
  partPath: string,
  extra: Args = {},
): Input => ({ args: { parts, partPath, ...extra } })

const CYCLE: Parts = [
  [CT, types(dflt('xml', 'application/xml'))],
  ['ppt/a.xml', 'A'],
  ['ppt/_rels/a.xml.rels', rels(rel('rId1', 'x', 'b.xml'), rel('rId2', 'x', 'a.xml'))],
  ['ppt/b.xml', 'B'],
  ['ppt/_rels/b.xml.rels', rels(rel('rId1', 'x', 'a.xml'), rel('rId2', 'x', 'c.xml'))],
  ['ppt/c.xml', 'C'],
]

/** Parts that name the properties a plain object inherits, and awkward extensions. */
const ODD_NAMES: Parts = [
  [
    CT,
    types(
      dflt('constructor', 'application/x-c'),
      dflt('__proto__', 'application/x-p'),
      dflt('PNG', 'image/png'),
      dflt('xml', 'application/xml'),
      override('ppt/ov.xml', 'x'),
      override('ppt/o.v.xml', 'x'),
    ),
  ],
  ['ppt/a.constructor', 'c'],
  ['ppt/a.__proto__', 'p'],
  ['ppt/a.PNG', 'png'],
  ['ppt/a.', 'dot'],
  ['ppt/noext', 'noext'],
  ['ppt/ov.xml', 'ov'],
  ['ppt/o.v.xml', 'ov2'],
  ['ppt/ovxxml', 'x'],
  ['ppt/b[1].xml', 'b'],
  ['constructor', 'cc'],
  ['__proto__', 'pp'],
  ['toString', 'ts'],
  ['ppt/_rels/a.xml.rels', rels(rel('rId1', 'x', 'a.constructor'), rel('rId2', 'x', 'a.__proto__'))],
  ['ppt/a.xml', 'a'],
  ['ppt/_rels/ov.xml.rels', rels(rel('rId1', 'x', '../constructor'), rel('rId2', 'x', '../toString'), rel('rId3', 'x', '../__proto__'), rel('rId4', 'x', 'a.PNG'), rel('rId5', 'x', 'noext'), rel('rId6', 'x', 'a.'))],
  ['ppt/_rels/o.v.xml.rels', rels(rel('rId1', 'x', 'ovxxml'), rel('rId2', 'x', 'b[1].xml'))],
]

/** Content types spelled the way XML allows: spaced `=`, single quotes, references, other attributes. */
const NEW_FORMS: Parts = [
  [
    CT,
    `<Types><Override ContentType="x/q&amp;a" PartName = '/ppt/q&amp;a.xml'/>` +
      `<Override PartName="/ppt/note.xml" ContentType = 'x/&#110;ote' note="a>b"/>` +
      `<Default note="a>b" Extension = 'BIN' ContentType = 'application/x-b&quot;'/>` +
      `<Default Extension="__proto__" ContentType="text/p"/><Default Extension="constructor" ContentType=""/></Types>`,
  ],
  ['ppt/q&a.xml', 'q'],
  ['ppt/note.xml', 'n'],
  ['ppt/a.bin', 'b'],
  ['ppt/a.__proto__', 'p'],
  ['ppt/a.constructor', 'c'],
  ['ppt/_rels/q&a.xml.rels', rels(rel('rId1', 'x', 'a.bin'), rel('rId2', 'x', 'a.__proto__'))],
]

const COLLECT_INPUTS: Input[] = [
  collectInput(DECK, 'ppt/media/image1.png'),
  collectInput(DECK, 'ppt/charts/chart1.xml'),
  collectInput(DECK, LAYOUT_1),
  collectInput(DECK, MASTER_1),
  ...['ppt/q&a.xml', 'ppt/note.xml', 'ppt/a.bin', 'ppt/a.__proto__', 'ppt/a.constructor'].map((path) =>
    collectInput(NEW_FORMS, path),
  ),
  collectInput(DECK, 'ppt/missing.xml'),
  collectInput(DECK, ''),
  collectInput(CYCLE, 'ppt/a.xml'),
  collectInput(ODD_NAMES, 'ppt/a.xml'),
  collectInput(ODD_NAMES, 'ppt/ov.xml'),
  collectInput(ODD_NAMES, 'ppt/o.v.xml'),
  collectInput(ODD_NAMES, 'ppt/a.constructor'),
  collectInput(ODD_NAMES, 'ppt/a.__proto__'),
  collectInput(ODD_NAMES, 'ppt/a.PNG'),
  collectInput(ODD_NAMES, 'ppt/a.'),
  collectInput(ODD_NAMES, 'ppt/noext'),
  collectInput(ODD_NAMES, 'constructor'),
  collectInput(ODD_NAMES, '__proto__'),
  collectInput(ODD_NAMES, 'toString'),
  collectInput(DECK, 'ppt/media/image1.png', { parts: without(DECK, CT) }),
  collectInput(replacing(DECK, CT, ''), 'ppt/media/image1.png'),
  // an empty part in a cycle: the walk never ends, as a stack overflow
  {
    args: {
      parts: [
        ['ppt/e.xml', ''],
        ['ppt/_rels/e.xml.rels', rels(rel('rId1', 'x', 'f.xml'))],
        ['ppt/f.xml', ''],
        ['ppt/_rels/f.xml.rels', rels(rel('rId1', 'x', 'e.xml'))],
      ],
      partPath: 'ppt/e.xml',
    },
    seed: false,
  },
  // an extension that is no pattern
  {
    args: {
      parts: [
        [CT, types(dflt('xml', 'application/xml'))],
        ['ppt/x.(', 'x'],
      ],
      partPath: 'ppt/x.(',
    },
  },
  {
    args: {
      parts: [
        [CT, types(dflt('xml', 'application/xml'))],
        ['ppt/x.[', 'x'],
      ],
      partPath: 'ppt/x.[',
    },
  },
  // an empty content types part: no pattern is built
  {
    args: {
      parts: [
        [CT, ''],
        ['ppt/x.(', 'x'],
      ],
      partPath: 'ppt/x.(',
    },
  },
  // quotes, single-quoted attributes and the order of the attributes of an Override
  {
    args: {
      parts: [
        [
          CT,
          `${XML_DECL}<Types><Override ContentType='text/x' PartName='/ppt/q.xml'/><Override PartName="/ppt/r.xml" Other="1" ContentType="text/r"/><Default ContentType="image/jpeg" Extension="jpg"/><Default Extension="gif" ContentType="image/gif"/></Types>`,
        ],
        ['ppt/q.xml', 'q'],
        ['ppt/r.xml', 'r'],
        ['ppt/s.jpg', 'j'],
        ['ppt/s.GIF', 'g'],
        ['ppt/s.gif', 'g'],
      ],
      partPath: 'ppt/q.xml',
    },
  },
  {
    args: {
      parts: [
        [CT, ''],
        ['ppt/q.xml', 'q'],
        ['ppt/s.jpg', 'j'],
        ['ppt/s.GIF', 'g'],
      ],
      partPath: 'ppt/s.jpg',
    },
  },
  {
    args: {
      parts: [
        [CT, `<Types><Default Extension="gif" ContentType="image/gif"/></Types>`],
        ['ppt/s.GIF', 'g'],
        ['ppt/\u{1F600}.GIF', 'g'],
        ['ppt/\u{1F600}.\u0130', 'g'],
      ],
      partPath: 'ppt/s.GIF',
    },
  },
]

/** A target to paste into: its own media, rels, content types. */
const TARGET: Parts = [
  [
    CT,
    types(
      dflt('rels', 'application/vnd.openxmlformats-package.relationships+xml'),
      dflt('xml', 'application/xml'),
      override('ppt/presentation.xml', 'presentationml.presentation.main'),
      override(MASTER_1, 'presentationml.slideMaster'),
      override(LAYOUT_1, 'presentationml.slideLayout'),
    ),
  ],
  ['ppt/presentation.xml', presentation('<p:sldMasterId id="2147483648" r:id="rId1"/>')],
  [PRES_RELS, rels(rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'))],
  [LAYOUT_1, layoutXml('Other', 'obj', '')],
  [
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
  ],
  [MASTER_1, masterXml(LAYOUT_IDS([2147483649, 'rId1']))],
  [
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels(
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId2', 'theme', '../theme/theme1.xml'),
    ),
  ],
  ['ppt/theme/theme1.xml', '<a:theme name="Target"/>'],
  ['ppt/media/image1.png', 'OTHER'],
  ['ppt/charts/chart1.xml', '<c:chartSpace/>'],
]

const BUNDLE = bundleOf(DECK, SLIDE_PATH, '<p:sld><p:cSld/></p:sld>')
const BUNDLE_BY_NAME = { ...BUNDLE, layoutName: 'Other' }

const bundleInputs = (bundle: unknown, parts: Parts, extra: Args = {}): Input => ({
  args: { parts, bundle, ...extra },
})

/** The clipboard parts of a copy within the same deck, and of one into another deck. */
const CLIP = { parts: BUNDLE.parts, contentTypes: BUNDLE.contentTypes }

/** The slide of the deck without its notes, layout or media rel. */
const SLIDE_VARIANTS: Array<[string, Parts]> = [
  ['no rels', without(DECK, 'ppt/slides/_rels/slide1.xml.rels')],
  ['broken presentation', replacing(DECK, 'ppt/presentation.xml', '<p:presentation')],
  ['no presentation', without(DECK, 'ppt/presentation.xml')],
  [
    'rel to a missing part',
    replacing(
      DECK,
      'ppt/slides/_rels/slide1.xml.rels',
      rels(
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout9.xml'),
        rel('rId2', 'image', '../media/missing.png'),
      ),
    ),
  ],
  [
    'two layout rels',
    replacing(
      DECK,
      'ppt/slides/_rels/slide1.xml.rels',
      rels(
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
        rel('rId2', 'slideLayout', '../slideLayouts/slideLayout9.xml'),
      ),
    ),
  ],
  [
    'layout without a name',
    replacing(DECK, LAYOUT_1, '<p:sldLayout><p:cSld><p:spTree/></p:cSld></p:sldLayout>'),
  ],
  ['layout with an empty name', replacing(DECK, LAYOUT_1, layoutXml('', 'x', '').replace('<p:cSld>', '<p:cSld name="">'))],
  ['empty layout', replacing(DECK, LAYOUT_1, '')],
  ['no master rel', without(DECK, 'ppt/slideLayouts/_rels/slideLayout1.xml.rels')],
  ['no theme rel', replacing(DECK, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')))],
  [
    'rels with an absolute target',
    replacing(
      DECK,
      'ppt/slides/_rels/slide1.xml.rels',
      rels(
        rel('rId1', 'slideLayout', '/ppt/slideLayouts/slideLayout1.xml'),
        rel('rId2', 'image', '/ppt/media/image1.png'),
        rel('rId3', 'oleObject', 'file:///c:/x.xlsx', ' TargetMode="External"'),
      ),
    ),
  ],
]

const COLLECT_BUNDLE_INPUTS: Input[] = [
  { args: { parts: DECK, slidePath: SLIDE_PATH, slideXml: '<p:sld/>' } },
  { args: { parts: DECK, slidePath: 'ppt/slides/slide2.xml', slideXml: '' } },
  { args: { parts: DECK, slidePath: 'ppt/slides/missing.xml', slideXml: 'x\u{1F600}' } },
  ...SLIDE_VARIANTS.map(([, parts]) => ({
    args: { parts, slidePath: SLIDE_PATH, slideXml: '<p:sld/>' },
  })),
  { args: { parts: CYCLE, slidePath: 'ppt/a.xml', slideXml: '<p:sld/>' } },
  { args: { parts: ODD_NAMES, slidePath: 'ppt/ov.xml', slideXml: '<p:sld/>' } },
  { args: { parts: ODD_NAMES, slidePath: 'ppt/o.v.xml', slideXml: '<p:sld/>' } },
  // the size of the source: given, malformed or absent
  {
    args: {
      parts: replacing(DECK, 'ppt/presentation.xml', presentation('').replace('12192000', '0')),
      slidePath: SLIDE_PATH,
      slideXml: '<p:sld/>',
    },
  },
]

const IMPORT_CLIP_INPUTS: Input[] = [
  // the same deck: nothing to write
  { args: { parts: DECK, clip: CLIP } },
  // another deck: the media and the chart land under free names
  { args: { parts: TARGET, clip: CLIP } },
  { args: { parts: without(TARGET, 'ppt/media/image1.png'), clip: CLIP } },
  { args: { parts: without(TARGET, CT), clip: CLIP } },
  { args: { parts: replacing(TARGET, CT, ''), clip: CLIP } },
  { args: { parts: TARGET, clip: { parts: {}, contentTypes: {} } } },
  // identical parts whose rels differ, or whose dependencies differ
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/charts/_rels/chart1.xml.rels',
        rels(rel('rId1', 'package', '../embeddings/book2.xlsx')),
      ),
      clip: CLIP,
    },
  },
  { args: { parts: replacing(DECK, 'ppt/embeddings/book1.xlsx', 'other'), clip: CLIP } },
  { args: { parts: without(DECK, 'ppt/charts/_rels/chart1.xml.rels'), clip: CLIP } },
  {
    args: {
      parts: adding(without(TARGET, 'ppt/charts/chart1.xml'), [
        'ppt/charts/_rels/chart1.xml.rels',
        rels(rel('rId1', 'package', '../embeddings/book1.xlsx')),
      ]),
      clip: CLIP,
    },
  },
  // the clipboard holds a part twice, a rels part, an empty part, root parts
  {
    args: {
      parts: TARGET,
      clip: {
        parts: {
          'ppt/media/image1.png': 'AAEC',
          'ppt/media/_rels/image1.png.rels': Buffer.from(rels(rel('rId1', 'x', 'image2.png'))).toString('base64'),
          'ppt/media/image2.png': '',
          'ppt/media/image3': 'Zm9v',
          'ppt/new.bin': 'Zm9v-_',
          '_rels/.rels': Buffer.from(rels()).toString('base64'),
          'a.bin': '!!Zm9v==ignored',
        },
        contentTypes: {
          'ppt/media/image1.png': 'image/png',
          png: 'image/png',
          bin: 'application/octet-stream',
          'ppt/new.bin': 'application/x-new',
          PNG: 'image/x',
          constructor: 'application/x-c',
          ['__proto__']: 'application/x-p',
        },
      },
    },
  },
  // a rels part pointing at other clipboard parts, at an external target, with escapes
  {
    args: {
      parts: TARGET,
      clip: {
        parts: {
          'ppt/media/image1.png': Buffer.from('other').toString('base64'),
          'ppt/charts/chart1.xml': Buffer.from('<chart/>').toString('base64'),
          'ppt/charts/_rels/chart1.xml.rels': Buffer.from(
            rels(
              rel('rId1', 'image', '../media/image1.png'),
              rel('rId2', 'hyperlink', 'https://example.com/?a=1&amp;b=2', ' TargetMode="External"'),
              rel('rId3', 'x', 'mailto:a@b.c'),
              rel('rId4', 'x', '../media/missing.png'),
              rel('rId5', 'x', '../charts/chart1.xml'),
            ),
          ).toString('base64'),
        },
        contentTypes: { 'ppt/charts/chart1.xml': 'application/x-chart', png: 'image/png' },
      },
    },
  },
  // a part path without a slash, with a stem ending in digits, with a newline
  {
    args: {
      parts: [
        [CT, types(dflt('xml', 'application/xml'))],
        ['plain', 'x'],
        ['ppt/media/image7.png', 'x'],
        ['ppt/media/a\nb1.png', 'x'],
        ['ppt/media/img.2.png', 'x'],
        ['ppt/media/image1.png', 'x'],
        ['ppt/media/image2.png', 'x'],
        ['ppt/media/.hidden', 'x'],
      ],
      clip: {
        parts: {
          plain: 'AQID',
          'ppt/media/image7.png': 'AQID',
          'ppt/media/a\nb1.png': 'AQID',
          'ppt/media/img.2.png': 'AQID',
          'ppt/media/image1.png': 'AQID',
          'ppt/media/.hidden': 'AQID',
          'p2': 'AQID',
          'ppt/media/noext5': 'AQID',
        },
        contentTypes: { png: 'image/png' },
      },
    },
  },
  // keys that are indexes: they come first in the record
  {
    args: {
      parts: TARGET,
      clip: {
        parts: { b: 'AQID', '10': 'AQID', '2': 'AQID', a: 'AQID' },
        contentTypes: { '2': 'image/x', z: 'image/z' },
      },
    },
  },
  // content types: a key that is a pattern, quotes, dollars in a content type
  {
    args: {
      parts: TARGET,
      clip: { parts: {}, contentTypes: { 'a(': 'image/x' } },
    },
  },
  {
    args: {
      parts: TARGET,
      clip: { parts: {}, contentTypes: { 'a+b': 'image/x', 'a.b': 'image/y', q: 'a"b' } },
    },
  },
  {
    args: {
      parts: replacing(TARGET, CT, `<Types><Default Extension='png' ContentType='image/png'/></Types>`),
      clip: { parts: { 'ppt/media/new.png': 'AQID' }, contentTypes: { png: 'image/png', jpg: 'image/jpeg', 'ppt/media/new.png': 'image/x' } },
    },
  },
  // an inherited name as a dependency of an identical part: the TypeScript throws
  {
    args: {
      parts: [
        [CT, types()],
        ['ppt/a.bin', 'AAA'],
        ['ppt/_rels/a.bin.rels', rels(rel('rId1', 'x', '../constructor'))],
        ['constructor', 'x'],
      ],
      clip: {
        parts: {
          'ppt/a.bin': Buffer.from('AAA').toString('base64'),
          'ppt/_rels/a.bin.rels': Buffer.from(rels(rel('rId1', 'x', '../constructor'))).toString('base64'),
        },
        contentTypes: {},
      },
    },
    seed: false,
  },
  {
    args: {
      parts: [
        [CT, types()],
        ['ppt/a.bin', 'AAA'],
        ['ppt/_rels/a.bin.rels', rels(rel('rId1', 'x', '../b.bin'))],
        ['ppt/b.bin', 'BBB'],
        ['ppt/_rels/b.bin.rels', rels(rel('rId1', 'x', 'a.bin'))],
      ],
      clip: {
        parts: {
          'ppt/a.bin': Buffer.from('AAA').toString('base64'),
          'ppt/_rels/a.bin.rels': Buffer.from(rels(rel('rId1', 'x', '../b.bin'))).toString('base64'),
          'ppt/b.bin': Buffer.from('BBB').toString('base64'),
          'ppt/_rels/b.bin.rels': Buffer.from(rels(rel('rId1', 'x', 'a.bin'))).toString('base64'),
        },
        contentTypes: {},
      },
    },
  },
]

const MATERIALIZE_INPUTS: Input[] = [
  bundleInputs(BUNDLE, TARGET, { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 }),
  bundleInputs(BUNDLE, DECK, { slidePath: 'ppt/slides/slide3.xml', layoutPath: 'ppt/slideLayouts/slideLayout2.xml' }),
  bundleInputs(BUNDLE, without(TARGET, CT), { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 }),
  bundleInputs(BUNDLE, TARGET, { slidePath: 'ppt/slides/sub/slide1.xml', layoutPath: 'ppt/a&b<c>"d".xml' }),
  bundleInputs(BUNDLE, TARGET, { slidePath: 'slide.xml', layoutPath: 'layout.xml' }),
  bundleInputs(BUNDLE, TARGET, { slidePath: 'ppt/slides/slide1.xml', layoutPath: '' }),
  bundleInputs(
    { ...BUNDLE, rels: [], parts: {}, contentTypes: {} },
    TARGET,
    { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 },
  ),
  bundleInputs(
    {
      ...BUNDLE,
      rels: [
        { id: 'rId1', type: `${REL}/hyperlink`, target: 'https://e.com/?a=1&b=<2>"3"', external: true },
        { id: 'rId2', type: `${REL}/image`, target: 'ppt/media/not-in-parts.png' },
        { id: 'rId3', type: `${REL}/slideLayout`, target: 'ppt/slideLayouts/slideLayout1.xml', layout: true },
        { id: 'rId4', type: `${REL}/image`, target: 'ppt/media/image1.png' },
      ],
    },
    TARGET,
    { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 },
  ),
  // ids and content types read decoded are written escaped, and `$` stays as typed
  bundleInputs(
    {
      ...BUNDLE,
      rels: [
        { id: 'a&b"<c>', type: `${REL}/hyperlink`, target: 'https://e.com/', external: true },
        { id: "i'd", type: `${REL}/slideLayout`, target: 'ppt/slideLayouts/slideLayout1.xml', layout: true },
        { id: 'rId4', type: `${REL}/image`, target: 'ppt/media/image1.png' },
      ],
      parts: { 'ppt/media/image1.png': 'AQID', 'ppt/media/new$&.x&y': 'AQID', 'ppt/z.a$&b': 'AQID' },
      contentTypes: { 'ppt/media/new$&.x&y': 'image/x&y"<z>', 'a$&b': 'text/$&"q"', 'x&y': 'a/b' },
    },
    TARGET,
    { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 },
  ),
  bundleInputs(
    { ...BUNDLE, contentTypes: { png: 'image/png', 'a$&b': 'text/$$' }, parts: { ...BUNDLE.parts, 'ppt/z.a$&b': 'AQID' } },
    replacing(TARGET, CT, `<Types><Default Extension = 'png' ContentType='image/png'/><Default Extension="BIN" ContentType="x/y"/></Types>`),
    { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 },
  ),
  // the bundle holds a name the target already has, a root part, an empty rels part
  bundleInputs(
    {
      ...BUNDLE,
      parts: { 'ppt/media/image1.png': 'AQID', 'ppt/media/_rels/image1.png.rels': '', '_rels/.rels': 'AQID' },
      contentTypes: { png: 'image/png' },
      rels: [{ id: 'rId1', type: `${REL}/image`, target: 'ppt/media/image1.png' }],
    },
    TARGET,
    { slidePath: 'ppt/slides/slide1.xml', layoutPath: LAYOUT_1 },
  ),
]


const IMPORT_SOURCE_INPUTS: Input[] = [
  bundleInputs(BUNDLE, DECK),
  bundleInputs(BUNDLE, TARGET),
  bundleInputs(BUNDLE, without(TARGET, CT)),
  bundleInputs(BUNDLE, without(TARGET, 'ppt/presentation.xml')),
  bundleInputs(BUNDLE, without(TARGET, PRES_RELS)),
  bundleInputs(BUNDLE, replacing(TARGET, 'ppt/presentation.xml', '<p:presentation/>')),
  bundleInputs(BUNDLE, replacing(TARGET, 'ppt/presentation.xml', '')),
  bundleInputs(
    BUNDLE,
    replacing(
      TARGET,
      'ppt/presentation.xml',
      presentation('<p:sldMasterId id="2147483700" r:id="rId1"/><p:sldMasterId id="5" r:id="rId9"/>'),
    ),
  ),
  bundleInputs(
    BUNDLE,
    replacing(TARGET, PRES_RELS, rels(rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'), rel('rId99999999999999999999999', 'x', 'y'))),
  ),
  // no chain, no theme, a chain part missing, a chain that is an inherited name
  { args: { parts: TARGET, bundle: { ...BUNDLE, chain: undefined } } },
  bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, themePath: undefined } }, TARGET),
  bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, themePath: undefined } }, DECK),
  bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, themePath: 'ppt/theme/none.xml' } }, TARGET),
  bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, layoutPath: 'ppt/none.xml' } }, TARGET),
  bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, masterPath: 'ppt/none.xml' } }, TARGET),
  {
    ...bundleInputs({ ...BUNDLE, chain: { ...BUNDLE.chain!, masterPath: 'constructor' } }, TARGET),
    seed: false,
  },
  // the target has the master and the theme of the chain, but another layout, or none
  bundleInputs(BUNDLE, replacing(DECK, LAYOUT_1, layoutXml('Changed', 'x', ''))),
  bundleInputs(BUNDLE, replacing(DECK, 'ppt/theme/theme1.xml', '<a:theme name="Changed"/>')),
  bundleInputs(
    BUNDLE,
    replacing(DECK, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))),
  ),
  bundleInputs(
    BUNDLE,
    replacing(DECK, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(rel('rId1', 'theme', '../theme/none.xml'), rel('rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml'))),
  ),
  bundleInputs(
    BUNDLE,
    replacing(DECK, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(rel('rId1', 'theme', 'https://e.com/t.xml', ' TargetMode="External"'))),
  ),
  // the master text is what mutations change
  split(TARGET, MASTER_1, { bundle: BUNDLE }),
  split(TARGET, 'ppt/presentation.xml', { bundle: BUNDLE }),
  split(TARGET, CT, { bundle: BUNDLE }),
]

const CHOOSE_INPUTS: Input[] = [
  bundleInputs(BUNDLE, DECK),
  bundleInputs(BUNDLE_BY_NAME, DECK),
  bundleInputs({ ...BUNDLE, layoutName: 'Title Slide' }, DECK),
  bundleInputs({ ...BUNDLE, layoutName: 'Title Slide' }, DECK, { neighbour: 'ppt/slides/slide2.xml' }),
  bundleInputs({ ...BUNDLE, layoutName: 'Missing' }, DECK, { neighbour: 'ppt/slides/slide2.xml' }),
  bundleInputs({ ...BUNDLE, layoutName: 'Missing' }, DECK, { neighbour: 'ppt/slides/none.xml' }),
  bundleInputs({ ...BUNDLE, layoutName: '' }, DECK, { neighbour: '' }),
  bundleInputs({ ...BUNDLE, layoutName: undefined }, DECK, { neighbour: SLIDE_PATH }),
  bundleInputs(BUNDLE, [[CT, types()]]),
  bundleInputs(BUNDLE, [[CT, types()]], { neighbour: SLIDE_PATH }),
  bundleInputs(BUNDLE, without(DECK, 'ppt/presentation.xml'), { neighbour: 'ppt/slides/none.xml' }),
  bundleInputs(BUNDLE, replacing(DECK, 'ppt/slides/_rels/slide2.xml.rels', '<Relationships'), { neighbour: 'ppt/slides/slide2.xml' }),
  // layouts without a name (name undefined), and with an empty one
  bundleInputs({ ...BUNDLE, layoutName: 'Two' }, adding(LAYOUT_DECK_ENTRIES)),
  bundleInputs({ ...BUNDLE, layoutName: 'Ten' }, adding(LAYOUT_DECK_ENTRIES)),
  bundleInputs({ ...BUNDLE, layoutName: undefined }, adding(LAYOUT_DECK_ENTRIES)),
  bundleInputs(BUNDLE, LAYOUT_DECK_ENTRIES),
  split(LAYOUT_DECK_ENTRIES, 'ppt/slideLayouts/slideLayout2.xml', {
    bundle: { ...BUNDLE, layoutName: 'Two' },
  }),
]

// ── specs ────────────────────────────────────────────────────────────────────

const partsOf = (parts: ReadonlyMap<string, string>, name: RegExp): Array<[string, string]> =>
  [...parts].filter(([path]) => name.test(path))

const LAYOUT_PART = /^ppt\/slide(?:Layouts|Masters)\/[^/]+\.xml$/

/** presentation.xml of the blank deck written so the slide list can or cannot take a new slide. */
const BLANK_PRES = (await PackageArchive.open(Buffer.from(deckNamed('blank deck'), 'base64'))).readText(
  'ppt/presentation.xml',
)!
const PRES_FORMS: string[] = [
  BLANK_PRES.replace('<p:sldIdLst>', '<p:sldIdLst xmlns:q="x">'),
  BLANK_PRES.replace(/<(\/?)p:(sldIdLst|sldId)\b/g, '<$1$2'),
  BLANK_PRES.replace(/<p:sldId\b([^>]*?)\/>/g, '<p:sldId$1><p:extLst><p:ext uri="x"/></p:extLst></p:sldId>'),
  BLANK_PRES.replace(/ r:id="(rId\d+)"/, " r:id = '$1'"),
  BLANK_PRES.replace('<p:sldIdLst>', '<p:sldIdLst >'),
  BLANK_PRES.replace('</p:sldIdLst>', '</p:sldIdLst >'),
]

const ph1 = { type: 'title', idx: '', x: 1, y: 2, cx: 3, cy: 4, hint: 'Click to add title' }

// PH_HINT_MAP is read through ownValue: a placeholder type named like an inherited member gets the
// default hint
const INHERITED_HINT_TEXT = ['constructor', 'toString', 'hasOwnProperty', 'valueOf']
  .map(
    (t) =>
      `<p:sp><p:nvPr><p:ph type="${t}"/></p:nvPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:sp>`,
  )
  .join('')

export const LAYOUTS: CallSpec[] = [
  {
    fn: 'pptxLayouts.layout.parseLayoutPlaceholders',
    call: (text) => parseLayoutPlaceholders(text),
    fromDocument: (parts) =>
      partsOf(parts, LAYOUT_PART)
        .slice(0, 40)
        .map(([, text]) => ({ text })),
    built: [
      ...PLACEHOLDER_TEXTS.map((text) => ({ text })),
      { text: INHERITED_HINT_TEXT },
    ],
  },
  {
    fn: 'pptxLayouts.layout.listSlideLayouts',
    call: (text, args) => listSlideLayouts(archiveOf(text, args)),
    fromDocument: (parts) => [
      {
        text: parts.get('ppt/slideLayouts/slideLayout1.xml') ?? '',
        args: {
          parts: [...parts].filter(
            ([name]) => name !== 'ppt/slideLayouts/slideLayout1.xml',
          ),
          textPart: 'ppt/slideLayouts/slideLayout1.xml',
        },
      },
    ],
    built: [
      { args: { parts: [] } },
      { args: { parts: DECK } },
      { args: { parts: LAYOUT_DECK_ENTRIES } },
      { args: { parts: [...LAYOUT_DECK_ENTRIES].reverse() } },
      ...LAYOUT_TEXTS.map((input) => ({
        text: input.text,
        args: { parts: [], textPart: 'ppt/slideLayouts/slideLayout1.xml' },
      })),
      { text: '', args: { parts: [], textPart: 'ppt/slideLayouts/slideLayout1.xml' } },
      { text: '\uFEFF<p:cSld name="Bom"/>', args: { parts: [], textPart: 'ppt/slideLayouts/slideLayout1.xml' } },
    ],
  },
  {
    fn: 'pptxLayouts.layout.placeholderSpXml',
    call: (_text, args) => placeholderSpXml(args.ph as typeof ph1, args.id as number),
    mutation: 'none',
    built: [
      { args: { ph: ph1, id: 2 } },
      { args: { ph: { ...ph1, type: '', idx: '' }, id: 0 } },
      { args: { ph: { ...ph1, type: 'a"b<c>&d', idx: 'x"y<z>&w' }, id: -0 } },
      { args: { ph: { ...ph1, type: '\u0001\u{1F600}', idx: '1' }, id: 1.5 } },
      { args: { ph: { ...ph1, x: 1e21, y: -1e-7, cx: 0.5, cy: 123456789012345680000 }, id: 1e21 } },
      { args: { ph: { ...ph1, x: -5, y: 0, cx: 1e300, cy: 1 / 3 }, id: 2 ** 53 } },
      { args: { ph: { ...ph1, idx: '0' }, id: 7 } },
    ],
  },
  {
    fn: 'pptxLayouts.layout.prepareInsertSlideWithLayout',
    call: (text, args) =>
      deckOp(text, args, (opened) =>
        prepareInsertSlideWithLayout(
          opened.archive,
          opened.deck,
          args.sourceIndex as number,
          args.layoutPath as string,
        ),
      ),
    built: [
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: 0,
        layoutPath: 'ppt/slideLayouts/slideLayout1.xml',
      }),
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: 1,
        layoutPath: 'ppt/slideLayouts/slideLayout2.xml',
      }),
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: 5,
        layoutPath: 'ppt/slideLayouts/slideLayout1.xml',
      }),
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: -1,
        layoutPath: 'ppt/slideLayouts/slideLayout1.xml',
      }),
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: 0.5,
        layoutPath: 'ppt/slideLayouts/slideLayout1.xml',
      }),
      deckInput('pptxgenjs text, shape, table and two slides', {
        sourceIndex: 0,
        layoutPath: 'ppt/slideLayouts/missing.xml',
      }),
      // a layout with placeholders of every kind, and a path that is no 'ppt/' path
      ...PLACEHOLDER_TEXTS.map((text) =>
        deckInput(
          'blank deck',
          { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
          { part: 'ppt/slideLayouts/slideLayout1.xml', text },
        ),
      ),
      ...PRES_FORMS.map((text) =>
        deckInput(
          'blank deck',
          { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
          { part: 'ppt/presentation.xml', text },
        ),
      ),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' }),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'ppt/slideMasters/slideMaster1.xml' }),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'ppt/presentation.xml' }),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'ppt/theme/theme1.xml' }),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'ppt/a"b&c<d>.xml' }),
      deckInput('blank deck', { sourceIndex: 0, layoutPath: 'xy' }),
      // the slide's sldId is found by its relationship; the part named in the text is what mutations change
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        {
          part: 'ppt/presentation.xml',
          text: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="300" r:id="rId9"/></p:sldIdLst></p:presentation>',
        },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        { part: 'ppt/presentation.xml', text: '<p:presentation xmlns:p="p" xmlns:r="r"/>' },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        {
          part: 'ppt/presentation.xml',
          text: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="2147483647" r:id="rId2"/></p:sldIdLst></p:presentation>',
        },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        { part: PRES_RELS, text: '' },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        {
          part: PRES_RELS,
          text: rels(
            rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
            rel('rId2', 'slide', 'slides/slide1.xml'),
            rel('rId77', 'slide', 'slides/slide9.xml'),
          ),
        },
      ),
      // a source slide id that is no pattern
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        {
          part: PRES_RELS,
          text: rels(
            rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
            rel('r(', 'slide', 'slides/slide1.xml'),
          ),
        },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        {
          part: PRES_RELS,
          text: rels(
            rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
            rel('', 'slide', 'slides/slide1.xml'),
          ),
        },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        { part: CT, text: '' },
      ),
      deckInput(
        'blank deck',
        { sourceIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout1.xml' },
        { part: CT, text: '<Types><Override PartName="/ppt/slides/slide2.xml" ContentType="x"/></Types>' },
      ),
    ],
  },
  {
    fn: 'pptxLayouts.builtin-layouts.BUILTIN_LAYOUTS',
    call: () => BUILTIN_LAYOUTS,
    mutation: 'none',
    built: [{ args: {} }],
  },
  {
    fn: 'pptxLayouts.builtin-layouts.shouldOfferBuiltinLayouts',
    call: (_text, args) => shouldOfferBuiltinLayouts(args.layouts as never),
    mutation: 'none',
    built: [
      { args: { layouts: [] } },
      { args: { layouts: [{ path: 'a', name: 'Blank', layoutType: 'blank', placeholders: [] }] } },
      {
        args: {
          layouts: [{ path: 'a', name: 'Title Slide', layoutType: 'title', placeholders: [ph1] }],
        },
      },
      {
        args: {
          layouts: [
            { path: 'a', name: 'Title Slide', layoutType: 'title', placeholders: [ph1] },
            { path: 'b', name: 'Foreign', layoutType: 'x', placeholders: [ph1] },
          ],
        },
      },
      { args: { layouts: [{ path: 'b', name: 'Foreign', layoutType: 'x', placeholders: [] }] } },
      {
        args: {
          layouts: BUILTIN_LAYOUTS.map((d) => ({
            path: d.key,
            name: d.name,
            layoutType: d.type,
            placeholders: [ph1],
          })),
        },
      },
      { args: { layouts: [{ path: 'b', name: 'title slide', layoutType: 'x', placeholders: [ph1] }] } },
    ],
  },
  {
    fn: 'pptxLayouts.builtin-layouts.builtinLayoutInfos',
    call: (_text, args) =>
      builtinLayoutInfos(
        args.size as { cx: number; cy: number },
        new Set(args.existing as string[]),
      ),
    mutation: 'none',
    built: [
      ...sizes.map((size) => ({ args: { size, existing: [] } })),
      { args: { size: SIZE_169, existing: ['Blank', 'Title Slide'] } },
      { args: { size: SIZE_169, existing: BUILTIN_LAYOUTS.map((d) => d.name) } },
      { args: { size: SIZE_169, existing: ['blank', 'Title'] } },
      { args: { size: { cx: 9144000, cy: 5143500 }, existing: ['Two Content'] } },
      { args: { size: { cx: -1, cy: -1 }, existing: [] } },
    ],
  },
  {
    fn: 'pptxLayouts.builtin-layouts.ensureBuiltinLayout',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const value = ensureBuiltinLayout(archive, args.size as { cx: number; cy: number }, args.key as string)
      return afterCall(archive, value)
    },
    built: ENSURE,
  },
  {
    fn: 'pptxLayouts.slide-transfer.collectPart',
    call: (text, args) => {
      const parts: Record<string, string> = {}
      const contentTypes: Record<string, string> = {}
      collectPart(archiveOf(text, args), args.partPath as string, parts, contentTypes)
      return { parts, contentTypes }
    },
    fromDocument: (parts) => [
      {
        args: {
          parts: [...parts],
          partPath: 'ppt/slides/slide1.xml',
        },
      },
    ],
    built: [
      ...COLLECT_INPUTS,
      split(DECK, CT, { partPath: 'ppt/media/image1.png' }),
      split(DECK, 'ppt/charts/_rels/chart1.xml.rels', { partPath: 'ppt/charts/chart1.xml' }),
      split(DECK, 'ppt/slides/_rels/slide1.xml.rels', { partPath: SLIDE_PATH }),
    ],
  },
  {
    fn: 'pptxLayouts.slide-transfer.collectSlideBundle',
    call: (text, args) =>
      collectSlideBundle(archiveOf(text, args), args.slidePath as string, args.slideXml as string),
    fromDocument: (parts) => [
      {
        args: {
          parts: [...parts],
          slidePath: 'ppt/slides/slide1.xml',
          slideXml: parts.get('ppt/slides/slide1.xml') ?? '',
        },
      },
    ],
    built: [
      ...COLLECT_BUNDLE_INPUTS,
      split(DECK, 'ppt/slides/_rels/slide1.xml.rels', { slidePath: SLIDE_PATH, slideXml: '<p:sld/>' }),
      split(DECK, 'ppt/presentation.xml', { slidePath: SLIDE_PATH, slideXml: '<p:sld/>' }),
      split(DECK, LAYOUT_1, { slidePath: SLIDE_PATH, slideXml: '<p:sld/>' }),
    ],
  },
  {
    fn: 'pptxLayouts.slide-transfer.listLayouts',
    call: (text, args) => listLayouts(archiveOf(text, args)),
    fromDocument: (parts) => [{ args: { parts: [...parts] } }],
    built: [
      { args: { parts: [] } },
      { args: { parts: DECK } },
      { args: { parts: LAYOUT_DECK_ENTRIES } },
      ...LAYOUT_TEXTS.map((input) => ({
        text: input.text,
        args: { parts: [], textPart: 'ppt/slideLayouts/slideLayout1.xml' },
      })),
      { text: '', args: { parts: [], textPart: 'ppt/slideLayouts/slideLayout1.xml' } },
    ],
  },
  {
    fn: 'pptxLayouts.slide-transfer.importClipboardParts',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const clip = args.clip as { parts: Record<string, string>; contentTypes: Record<string, string> }
      const value = importClipboardParts(archive, clip.parts, clip.contentTypes)
      return afterCall(archive, value)
    },
    built: IMPORT_CLIP_INPUTS,
  },
  {
    fn: 'pptxLayouts.slide-transfer.materializeSlideBundle',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const value = materializeSlideBundle(
        archive,
        args.bundle as SlideBundle,
        args.slidePath as string,
        args.layoutPath as string,
      )
      return afterCall(archive, value)
    },
    built: MATERIALIZE_INPUTS,
  },
  {
    fn: 'pptxLayouts.slide-transfer.importSourceLayout',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const value = importSourceLayout(archive, args.bundle as SlideBundle)
      return afterCall(archive, value)
    },
    built: IMPORT_SOURCE_INPUTS,
  },
  {
    fn: 'pptxLayouts.slide-transfer.chooseLayout',
    call: (text, args) =>
      chooseLayout(
        archiveOf(text, args),
        args.bundle as SlideBundle,
        args.neighbour as string | undefined,
      ),
    built: CHOOSE_INPUTS,
  },
  {
    fn: 'pptxLayouts.blank.BLANK_SLIDE_XML',
    call: () => BLANK_SLIDE_XML,
    mutation: 'none',
    built: [{ args: {} }],
  },
  {
    // the zip is not compared, its entries are: path and text, in archive order
    fn: 'pptxLayouts.blank.createBlankPptx',
    call: async () => {
      const archive = await PackageArchive.open(await createBlankPptx())
      return [...archive.entries].map(([name, bytes]) => [name, Buffer.from(bytes).toString('utf8')])
    },
    mutation: 'none',
    built: [{ args: {} }],
  },
]
