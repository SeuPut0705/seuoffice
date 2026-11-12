// Group `ident` of comparison (f): identity.ts, redaction-xml.ts and model3d.ts
// of packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_ident.rs to `pptxIdent.<module>.<TypeScript name>`.
import { XMLParser } from 'fast-xml-parser'
import type { GlbBounds } from '../../packages/pptx-engine/src/glb-bounds'
import {
  elementCNvPrId,
  elementDurableId,
  ensureCreationId,
  groupChildDurableId,
  matchesElementRef,
  slideDurableId,
} from '../../packages/pptx-engine/src/identity'
import {
  AM3D_NS,
  GLB_CONTENT_TYPE,
  MODEL3D_EMU_PER_METER,
  MODEL3D_FOV,
  MODEL3D_LIGHTS,
  MODEL3D_RATIO_ONE,
  MODEL3D_REL_TYPE,
  model3dFraming,
  model3dXml,
  type Model3dRotation,
  NO_ROTATION,
  readModel3dRotation,
  setModel3dRotationXml,
  syncModel3dFrame,
} from '../../packages/pptx-engine/src/model3d'
import {
  hasRedactExtIn,
  readRedactLabel,
  REDACT_EL,
  REDACT_EXT_URI,
  REDACT_NS,
  REDACT_PREFIX,
  redactExtXml,
  setRedactExt,
  stripRedactExt,
  syncRedactExt,
} from '../../packages/pptx-engine/src/redaction-xml'
import { scanSlide } from '../../packages/pptx-engine/src/scan'
import type { EmuRect, Slide, SlideElement } from '../../packages/pptx-engine/src/types'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { withUuid } from './calls-leaves'

type Args = Record<string, unknown>
type Parts = ReadonlyMap<string, string>

/** Entity references only: a numeric one could name a lone surrogate, which JSON cannot carry to Rust. */
const unescapeXml = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/

/** Every top-level shape of every slide, cut as scanSlide cuts them. */
function shapesOf(parts: Parts): string[] {
  const shapes: string[] = []
  for (const [path, text] of parts) {
    if (!SLIDE_PART.test(path)) continue
    try {
      for (const { start, end } of scanSlide(text).elements) shapes.push(text.slice(start, end))
    } catch {
      // a slide scanSlide refuses gives no shapes
    }
  }
  return shapes
}

/** Distinct matches of `re` over the slides, at most `cap`. */
function elementsOf(parts: Parts, re: RegExp, cap = 60): string[] {
  const found = new Set<string>()
  for (const [path, text] of parts) {
    if (!SLIDE_PART.test(path)) continue
    for (const [element] of text.matchAll(re)) {
      if (found.size >= cap) return [...found]
      found.add(element)
    }
  }
  return [...found]
}

const CNVPR = /<p:cNvPr\b[^>]*?\/>|<p:cNvPr\b[^>]*?>[\s\S]*?<\/p:cNvPr>/g
const RPR = /<a:rPr\b[^>]*?\/>|<a:rPr\b[^>]*?>[\s\S]*?<\/a:rPr>/g
const SPPR = /<p:spPr\b[^>]*?\/>|<p:spPr\b[^>]*?>[\s\S]*?<\/p:spPr>/g

/** The `id` of every `<p:cNvPr>` in `text`. */
const cNvPrIdsIn = (text: string): string[] =>
  [...text.matchAll(/<p:cNvPr\b[^>]*?\bid="([^"]*)"/g)].map((m) => m[1]!)

/** The element the Rust dispatch builds: `anchor.originalXml` is the text, no anchor with `noAnchor`. */
function elementOf(text: string, args: Args): SlideElement {
  return {
    id: args.elId,
    ...(args.noAnchor === true ? {} : { anchor: { originalXml: text } }),
    ...(args.nvId === undefined ? {} : { nvId: args.nvId }),
  } as unknown as SlideElement
}

/** A group child: the slice of its own is `args.childXml`, empty as parse.ts makes it. */
function childOf(args: Args): SlideElement {
  return {
    anchor: { originalXml: (args.childXml as string | undefined) ?? '' },
    ...(args.nvId === undefined ? {} : { nvId: args.nvId }),
  } as unknown as SlideElement
}

const constantOf = (table: Record<string, unknown>, args: Args): unknown => {
  const name = String(args.name)
  if (!Object.hasOwn(table, name)) throw new Error(`no constant ${name}`)
  return table[name]
}

const REDACTION_CONSTANTS: Record<string, unknown> = {
  REDACT_EXT_URI,
  REDACT_EL,
  REDACT_NS,
  REDACT_PREFIX,
}

const MODEL3D_CONSTANTS: Record<string, unknown> = {
  AM3D_NS,
  MODEL3D_REL_TYPE,
  GLB_CONTENT_TYPE,
  MODEL3D_RATIO_ONE,
  MODEL3D_EMU_PER_METER,
  MODEL3D_FOV,
  NO_ROTATION,
  MODEL3D_LIGHTS,
}

/** Names besides a table's own: unknown, and two every object inherits. */
const OTHER_NAMES = ['nothing', 'constructor', 'toString']

/**
 * The parser of packages/pptx-engine/src/parse.ts, which parses the `<a:rPr>`
 * and `<p:spPr>` nodes readRedactLabel is given. The Rust dispatch holds the
 * same list.
 */
const parseTsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  isArray: (name) =>
    [
      'a:p',
      'a:r',
      'a:br',
      'a:fld',
      'p:sp',
      'p:pic',
      'p:graphicFrame',
      'p:grpSp',
      'p:cxnSp',
      'a:tr',
      'a:tc',
      'a:gridCol',
    ].includes(name),
})

// ---- identity.ts

const UUID = '6f1d2c3b-4a59-4687-9e0d-1c2b3a495867'
const UUIDS = [UUID, '00000000-0000-4000-8000-000000000000', 'ABCDEF01-2345-4678-9ABC-DEF012345678']

const GUID = '{3A8B1C2D-4E5F-4061-8273-94A5B6C7D8E9}'
const A16 = 'xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main"'
const creation = (guid = GUID, quote = '"'): string =>
  `<a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId ${A16} id=${quote}${guid}${quote}/></a:ext>`
const OTHER_EXT =
  '<a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="0"/></a:ext>'

const cNvPr = (attrs: string, inner?: string): string =>
  inner === undefined ? `<p:cNvPr ${attrs}/>` : `<p:cNvPr ${attrs}>${inner}</p:cNvPr>`

const shape = (nv: string): string =>
  `<p:sp><p:nvSpPr>${nv}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>` +
  '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'

const group = (nv: string, ...children: string[]): string =>
  `<p:grpSp><p:nvGrpSpPr>${nv}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${children.join('')}</p:grpSp>`

/** Element slices for every branch of the cNvPr and creationId readers. */
const ELEMENT_TEXTS: string[] = [
  '',
  'no cNvPr here',
  shape(cNvPr('id="5" name="Title 1"')),
  shape(cNvPr('id="5" name="Title 1" ')),
  cNvPr('id="5" name="Alone"'),
  // the group's own cNvPr is a pair without a creationId; a child has one
  group(
    cNvPr('id="20" name="Group"', '<a:hlinkClick r:id=""/>'),
    shape(cNvPr('id="21" name="Child"', `<a:extLst>${creation()}</a:extLst>`)),
  ),
  shape(cNvPr('id="6" name="A"', `<a:extLst>${creation()}</a:extLst>`)),
  shape(
    cNvPr(
      'id="6" name="A"',
      `<a:extLst>${creation('3a8b1c2d-4e5f-4061-8273-94a5b6c7d8e9')}</a:extLst>`,
    ),
  ),
  shape(
    cNvPr(
      'id="6" name="A"',
      `<a:extLst>${creation('{3A8B1C2D-4E5F-4061-8273-94A5B6C7D8E}')}</a:extLst>`,
    ),
  ),
  shape(cNvPr('id="6" name="A"', `<a:extLst>${creation(GUID, "'")}</a:extLst>`)),
  shape(
    cNvPr(
      'id="6" name="A"',
      `<a:extLst>${creation('{ZZZZZZZZ-4E5F-4061-8273-94A5B6C7D8E9}')}</a:extLst>`,
    ),
  ),
  shape(
    cNvPr(
      'id="7" name="B"',
      '<a:hlinkClick r:id=""><a:extLst><a:ext uri="{x}"/></a:extLst></a:hlinkClick>',
    ),
  ),
  shape(
    cNvPr(
      'id="7" name="B"',
      `<a:hlinkClick r:id=""><a:extLst>${creation()}</a:extLst></a:hlinkClick>`,
    ),
  ),
  shape(cNvPr('id="7" name="B"', `<a:hlinkClick r:id=""/><a:extLst>${OTHER_EXT}</a:extLst>`)),
  shape(cNvPr('id="7" name="B"', `<a:extLst>${OTHER_EXT}</a:extLst>\r\n  `)),
  shape(cNvPr('id="7" name="B"', `<a:extLst>${OTHER_EXT}</a:extLst><a:hlinkHover r:id=""/>`)),
  shape(cNvPr('id="7" name="B"', '<a:hlinkClick r:id=""><a:extLst/></a:hlinkClick>')),
  shape(cNvPr('id="8" name="C"', '')),
  `<p:cNvPr id="3"><a:extLst>${creation()}</a:extLst>`,
  `${'x'.repeat(20)}<p:cNvPr id="3"><a:extLst>${creation()}</a:extLst>`,
  shape(cNvPr('name="NoId"')),
  shape(cNvPr('id="abc" name="D"')),
  shape(cNvPr("id='9' name='E'")),
  shape(cNvPr('r:id="7" id="5" name="F"')),
  shape(cNvPr('xid="4" id="11" name="G"')),
  shape(cNvPr(`id="12" name="H" descr='<a16:creationId id="${GUID}"'`)),
  `<p:cNvPrX id="1"/>${shape(cNvPr('id="13" name="I"'))}`,
  `\u{1F600}\uD55C${shape(cNvPr('id="14" name="\u{1F600}"', `<a:extLst>${creation()}</a:extLst>`))}`,
  group(
    cNvPr('id="20" name="Group"'),
    shape(cNvPr('id="21" name="Child"', `<a:extLst>${creation()}</a:extLst>`)),
  ),
  group(
    cNvPr(
      'id="20" name="Group"',
      `<a:extLst>${creation('{AAAAAAAA-0000-4000-8000-000000000000}')}</a:extLst>`,
    ),
    shape(cNvPr('id="21" name="Child"', `<a:extLst>${creation()}</a:extLst>`)),
  ),
  shape(cNvPr(`id="${'9'.repeat(25)}" name="J"`)),
  shape(cNvPr('id="0" name="K"')),
  shape(cNvPr('id="-1" name="L"')),
  shape(cNvPr('id="15" name="a>b"')),
  shape(cNvPr('id="16" name="a/>b"', `<a:extLst>${creation()}</a:extLst>`)),
  shape(cNvPr('id="17"\nname="M"\t', `\n<a:extLst>${OTHER_EXT}</a:extLst>\n`)),
]

/**
 * ledger cnvpr-own-extlst-forms: cNvPr's own extLst written self-closing or
 * with white space before the `>` of its closing tag. The TypeScript's
 * ensureCreationId adds a second extLst there; the Rust merges into it.
 */
const OWN_EXTLST_FORMS: string[] = [
  '<p:cNvPr id="16" name="M"><a:extLst/></p:cNvPr>',
  `<p:cNvPr id="17" name="N"><a:extLst>${OTHER_EXT}</a:extLst ></p:cNvPr>`,
  shape(cNvPr('id="18" name="O"', '<a:hlinkClick r:id=""/><a:extLst xmlns:x="urn:x" />')),
]

/** An element without a slice of its own, as a group child is, named by nvId. */
const NV_ID_INPUTS: Input[] = [
  { args: { noAnchor: true } },
  { args: { noAnchor: true, nvId: '7' } },
  { args: { noAnchor: true, nvId: 12 } },
  { args: { noAnchor: true, nvId: 1.5 } },
  { args: { noAnchor: true, nvId: '' } },
  { args: { noAnchor: true, nvId: null } },
  { args: { noAnchor: true, nvId: 'constructor' } },
  { text: '', args: { nvId: '9' } },
  { text: '', args: {} },
]

/** Each element text alone, some with an nvId beside, and nvId-only elements. */
const ELEMENT_INPUTS: Input[] = [
  ...ELEMENT_TEXTS.map((text) => ({ text })),
  ...ELEMENT_TEXTS.slice(2, 8).map((text) => ({ text, args: { nvId: '99' } })),
  ...NV_ID_INPUTS,
  ...OWN_EXTLST_FORMS.map((text) => ({ text })),
]

/** Shapes, cNvPr elements and nvId-only elements of the corpus. */
function elementsOfDocument(parts: Parts): Input[] {
  const shapes = shapesOf(parts)
  const cNvPrs = elementsOf(parts, CNVPR)
  const ids = [...new Set(cNvPrs.flatMap(cNvPrIdsIn))].slice(0, 20)
  return [
    ...shapes.map((text) => ({ text })),
    ...cNvPrs.map((text) => ({ text })),
    ...ids.map((nvId) => ({ args: { noAnchor: true, nvId } })),
  ]
}

const SLIDE_PATHS = [
  'ppt/slides/slide1.xml',
  'ppt/slides/slide12.xml',
  'ppt/slides/slide007.xml',
  'ppt/slides/slide.xml',
  'ppt/slides/Slide3.xml',
  'ppt/slides/slide3.XML',
  'ppt/slides/slide3.xml.rels',
  'ppt/slides/_rels/slide3.xml.rels',
  'ppt/slides/slide-4.xml',
  'ppt/slides/slide1.xmlslide2.xml',
  'ppt/slideLayouts/slideLayout2.xml',
  'slide5.xml',
  `ppt/slides/slide${'9'.repeat(30)}.xml`,
  'ppt/slides/slide\u0661.xml',
  'ppt/slides/\u{1F600}.xml',
  'ppt/slides/caf\u00e9.xml',
  'ppt/slides/a b\r\n.xml',
  'ppt\\slides\\slide2.xml',
  'ppt/slides/slide2.xml\n',
  '',
  'constructor',
  '__proto__',
]

const REF_SHAPE = shape(cNvPr('id="6" name="A"', `<a:extLst>${creation()}</a:extLst>`))
const PLAIN_SHAPE = shape(cNvPr('id="5" name="T"'))
const REF_INPUTS: Input[] = [
  { text: PLAIN_SHAPE, args: { elId: 'sp-1', id: 'sp-1' } },
  { text: PLAIN_SHAPE, args: { elId: 'sp-1', id: 'e_5' } },
  { text: PLAIN_SHAPE, args: { elId: 'sp-1', id: 'e_6' } },
  { text: PLAIN_SHAPE, args: { elId: 'sp-1', id: '' } },
  { text: REF_SHAPE, args: { elId: 'sp-1', id: 'e_3a8b1c2d' } },
  { text: REF_SHAPE, args: { elId: 'sp-1', id: 'e_3A8B1C2D' } },
  { text: REF_SHAPE, args: { elId: 'sp-1', id: 'e_6' } },
  { text: REF_SHAPE, args: { elId: 'sp-1', id: 'e_5' } },
  { text: '', args: { elId: '', id: '' } },
  { text: '', args: { elId: 'sp-2', id: '' } },
  { text: '', args: { elId: 'sp-2', id: 'e_null' } },
  { args: { elId: 'sp-3', noAnchor: true, nvId: '7', id: 'e_7' } },
  { args: { elId: 'sp-3', noAnchor: true, nvId: 7, id: 'e_7' } },
  { args: { elId: 'sp-3', noAnchor: true, nvId: '7', id: 'e_8' } },
  { text: 'no cNvPr', args: { elId: 'sp-4', id: 'e_4' } },
  { text: shape(cNvPr('name="NoId"')), args: { elId: 'constructor', id: 'constructor' } },
]

/** Shapes of the corpus against their own durable id, their cNvPr form and a foreign id. */
function refsOfDocument(parts: Parts): Input[] {
  return shapesOf(parts).flatMap((text) => {
    const element = elementOf(text, {})
    return [
      { text, args: { elId: 'sp-0', id: elementDurableId(element) ?? 'none' } },
      { text, args: { elId: 'sp-0', id: elementCNvPrId(element) ?? 'none' } },
      { text, args: { elId: 'sp-0', id: 'e_0' } },
    ]
  })
}

const GROUP = group(
  cNvPr('id="20" name="Group"'),
  shape(cNvPr('id="21" name="Child A"', `<a:extLst>${creation()}</a:extLst>`)),
  shape(cNvPr('id="22" name="Child B"')),
  shape(cNvPr('id="23" name="Child C"', `<a:extLst>${OTHER_EXT}</a:extLst>`)),
  shape(
    cNvPr(
      'name="Child D" id="24"',
      `<a:extLst>${creation('{BBBBBBBB-1111-4111-8111-111111111111}')}</a:extLst>`,
    ),
  ),
)

const GROUP_CHILD_INPUTS: Input[] = [
  ...['21', 21, '22', '23', '24', '20', '99', '2', '', null, 'constructor', '__proto__'].map(
    (nvId) => ({ text: GROUP, args: { nvId } }),
  ),
  { text: GROUP, args: {} },
  { text: GROUP, args: { nvId: '21', grpNoAnchor: true } },
  { text: '', args: { nvId: '21' } },
  { text: '', args: {} },
  { text: GROUP, args: { nvId: '21', childXml: shape(cNvPr('id="30" name="X"')) } },
  { text: GROUP, args: { nvId: '99', childXml: shape(cNvPr('id="30" name="X"')) } },
  { text: GROUP, args: { childXml: REF_SHAPE } },
  { text: `<p:cNvPr id="21"><a:extLst>${creation()}</a:extLst>`, args: { nvId: '21' } },
  {
    text: `${'x'.repeat(30)}<p:cNvPr id="21"><a:extLst>${creation()}</a:extLst>`,
    args: { nvId: '21' },
  },
  // ledger group-child-nvid-pattern: the TypeScript pastes the nvId into a pattern unescaped
  ...['2.', '2[12]', '+21', '21|x', '2\\d', '(', '[', ']', '{', '2{2}', '\\'].map(
    (nvId): Input => ({ text: GROUP, args: { nvId }, seed: false }),
  ),
  {
    text: group(
      cNvPr('id="20" name="Group"'),
      shape(cNvPr('id="+21" name="Child"', `<a:extLst>${creation()}</a:extLst>`)),
    ),
    args: { nvId: '+21' },
    seed: false,
  },
]

/** Every cNvPr id inside each group of the corpus, against that group. */
function groupChildrenOfDocument(parts: Parts): Input[] {
  return shapesOf(parts)
    .filter((text) => text.startsWith('<p:grpSp'))
    .flatMap((text) => cNvPrIdsIn(text).map((nvId) => ({ text, args: { nvId } })))
}

/**
 * ledger redact-strip-drops-extlst-attributes and
 * redact-self-closing-ext-swallows-next: a list with attributes that still
 * holds something once our extension is gone, and a self-closing extension
 * of ours before another one. The TypeScript drops the attributes of the
 * first and takes the neighbour of the second; neither seeds a mutation.
 */
const LISTED_SHAPE =
  /<a:extLst\s[^>]*[^/>]>|<a:ext\b[^>]*\buri="\{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D\}"[^>]*\/>[\s\S]*<\/a:ext>/
const unseeded = (inputs: Input[]): Input[] =>
  inputs.map((input) => (LISTED_SHAPE.test(input.text ?? '') ? { ...input, seed: false } : input))

// ---- redaction-xml.ts

const OURS = redactExtXml('Name')
const OTHER =
  '<a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"><a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/></a:ext>'
const SP_PR =
  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

/** Run and shape properties: our mark, theirs, both, neither, in every form. */
const PROPS: string[] = [
  '<a:rPr lang="en-US"/>',
  '<a:rPr lang="en-US" />',
  '<a:rPr lang="en-US"></a:rPr>',
  '<a:rPr lang="en-US" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>',
  `<a:rPr lang="en-US"><a:extLst>${OURS}</a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst>${OTHER}${OURS}</a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst>${OURS}${OTHER}</a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst>${OTHER}</a:extLst></a:rPr>`,
  '<a:rPr lang="en-US"><a:extLst/></a:rPr>',
  '<a:rPr lang="en-US"><a:extLst xmlns:x="urn:x"><a:ext uri="{X}"><x:y/></a:ext></a:extLst></a:rPr>',
  '<a:rPr lang="en-US"><a:extLst>  </a:extLst></a:rPr>',
  `<a:rPr lang="en-US"><a:extLst>\r\n${OURS}\r\n</a:extLst>  </a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI}"/>${OTHER}</a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI}"/></a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst><a:ext xmlns:go="${REDACT_NS}" uri="${REDACT_EXT_URI}"><go:redact label="x"/></a:ext></a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst><a:ext uri='${REDACT_EXT_URI}'><go:redact label="x"/></a:ext></a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI.toLowerCase()}"><go:redact label="x"/></a:ext></a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:extLst>${OURS}</a:extLst></a:rPr>`,
  `<p:spPr>${SP_PR}<a:extLst>${OURS}</a:extLst></p:spPr>`,
  `<p:spPr>${SP_PR}</p:spPr>`,
  '<p:spPr/>',
  '<a:rPr lang="en-US">text</a:rPr>',
  '<a:rPr lang="x" >\t </a:rPr>',
  '</a:rPr><a:rPr>',
  '<a:rPr>',
  'no tag',
  '',
  `<a:rPr lang="en-US"><a:t> </a:t><a:extLst>${OURS}</a:extLst></a:rPr>`,
  `<a:rPr lang="\u{1F600}"><a:extLst>${OURS}</a:extLst></a:rPr>`,
  `<a:rPr><a:extLst>${OURS}</a:extLst></a:rPr><a:rPr><a:extLst>${OURS}</a:extLst></a:rPr>`,
  `<a:rPr lang="en-US"><a:extLst>${redactExtXml('<&>"\u{1F600}')}</a:extLst></a:rPr>`,
]

const LABELS = ['Name', 'Other label', '', '<&>"\'', '\u{1F600}\uD55C', 'toString']

/**
 * ledger redact-label-dollar: a label holding `$$`, `$&`, `` $` `` or `$'`,
 * set where the props already hold an `<a:extLst>`. The TypeScript reads it as
 * a replacement pattern; the Rust writes it as given.
 */
const DOLLAR_LABELS = ['a$$b', 'a$&b', 'a$`b', "a$'b", '$1']

/** Props with our mark, with another extension, and with a self-closing list: both replace sites. */
const DOLLAR_PROPS = (): string[] => [PROPS[4]!, PROPS[5]!, PROPS[8]!]

const run = (rPr: string): string => `<a:r>${rPr}<a:t>word</a:t></a:r>`
const runShape = (rPr: string): string =>
  `<p:sp><p:nvSpPr>${cNvPr('id="2" name="T"')}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>` +
  `<p:txBody><a:bodyPr/><a:p>${run(rPr)}${run('<a:rPr lang="en-US"/>')}</a:p></p:txBody></p:sp>`

const SYNC_TEXTS: Array<[string, string]> = [
  ...PROPS.slice(0, 12).map((rPr): [string, string] => [runShape(rPr), 'a:rPr']),
  ...PROPS.slice(18, 21).map((spPr): [string, string] => [
    `<p:pic><p:nvPicPr>${cNvPr('id="3" name="P"')}<p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rId2"/></p:blipFill>${spPr}</p:pic>`,
    'p:spPr',
  ]),
  [run('<a:rPr lang="en-US"/>'), 'a:rPr'],
  [run('<a:rPr lang="en-US"/>'), 'a:r'],
  [runShape(PROPS[4]!), 'a:endParaRPr'],
  [runShape(PROPS[4]!), ''],
  ['', 'a:rPr'],
]

const SYNC_INPUTS: Input[] = [
  ...SYNC_TEXTS.flatMap(([text, tag]) => [
    { text, args: { tag } },
    { text, args: { tag, label: 'Name' } },
    { text, args: { tag, label: 'Other' } },
    { text, args: { tag, label: '' } },
    { text, args: { tag, label: null } },
  ]),
  // the tag goes into a pattern unescaped
  ...['(', 'a:rPr|p:spPr', 'a:r.r'].map((tag) => ({
    text: runShape(PROPS[4]!),
    args: { tag, label: 'Name' },
  })),
  // ledger redact-label-dollar: `$$`, `$&`, `` $` ``, `$'` in the label are read as replacement patterns by the TypeScript
  ...DOLLAR_PROPS().flatMap((rPr) =>
    DOLLAR_LABELS.map((label): Input => ({
      text: runShape(rPr),
      args: { tag: 'a:rPr', label },
      seed: false,
    })),
  ),
]

const labelled = (label: string): string =>
  `<a:rPr lang="en-US"><a:extLst>${redactExtXml(label)}</a:extLst></a:rPr>`

const LABEL_INPUTS: Input[] = [
  ...[
    'Name',
    '  spaced  ',
    '&',
    '0',
    '123',
    'toString',
    '__proto__',
    '\u{1F600}',
    '',
    'a\r\nb',
  ].map((label) => ({ text: labelled(label), args: { name: 'a:rPr' } })),
  ...[
    '<go:redact/>',
    '<go:redact label=""/>',
    '<go:redact label="x">text</go:redact>',
    '<go:redact label="a"/><go:redact label="b"/>',
    '<go:redact go:label="x"/>',
    "<go:redact label='single'/>",
    '<go:redact label="&#65;&lt;"/>',
    '<go:redact>plain</go:redact>',
    '<redact label="x"/>',
    '<toString label="x"/><go:redact label="y"/>',
  ].map((redact) => ({
    text: `<a:rPr lang="en-US"><a:extLst><a:ext uri="${REDACT_EXT_URI}" xmlns:go="${REDACT_NS}">${redact}</a:ext></a:extLst></a:rPr>`,
    args: { name: 'a:rPr' },
  })),
  ...PROPS.map((text) => ({ text, args: { name: 'a:rPr' } })),
  ...PROPS.slice(18, 21).map((text) => ({ text, args: { name: 'p:spPr' } })),
  {
    text: `<a:rPr><a:extLst>${OTHER}${OURS}</a:extLst><a:extLst>${OURS}</a:extLst></a:rPr>`,
    args: { name: 'a:rPr' },
  },
  {
    text: `<a:rPr><a:extLst>${OURS}${redactExtXml('Second')}</a:extLst></a:rPr>`,
    args: { name: 'a:rPr' },
  },
  {
    text: `<a:rPr><a:extLst>${redactExtXml('First')}</a:extLst></a:rPr><a:rPr/>`,
    args: { name: 'a:rPr' },
  },
  { text: labelled('Name'), args: { name: 'p:spPr' } },
  { text: labelled('Name'), args: { name: 'a:r' } },
  // texts the parser refuses
  { text: '<a:rPr><a:extLst></a:rPr', args: { name: 'a:rPr' } },
  { text: '<a:rPr><constructor/></a:rPr>', args: { name: 'a:rPr' } },
  { text: '<a:rPr><!-- </a:rPr>', args: { name: 'a:rPr' } },
]

const SET_INPUTS: Input[] = [
  ...PROPS.flatMap((text) => LABELS.map((label) => ({ text, args: { label } }))),
  // two nodes of the name: the closing tag is the last one
  { text: '<a:rPr lang="en-US"></a:rPr><a:rPr></a:rPr>', args: { label: 'Name' } },
  {
    text: '<a:rPr lang="en-US"><a:latin typeface="x"/></a:rPr><a:t>w</a:t><a:rPr/>',
    args: { label: 'Name' },
  },
  // ledger redact-label-dollar: `$$`, `$&`, `` $` ``, `$'` in the label are read as replacement patterns by the TypeScript
  ...DOLLAR_PROPS().flatMap((text) =>
    DOLLAR_LABELS.map((label): Input => ({ text, args: { label }, seed: false })),
  ),
]

// ---- model3d.ts

const OFFSET: EmuRect = { x: 838200, y: 1371600, cx: 3048000, cy: 2286000 }

/**
 * Each number has at most 15 significant digits and a decimal exponent within
 * 22 of them, or is a power of ten: serde_json without `float_roundtrip` reads
 * only those exactly, and an argument has to reach Rust as the same double.
 */
const BOUNDS: Array<GlbBounds | null> = [
  null,
  { center: [0, 0, 0], size: [1, 1, 1] },
  { center: [0.5, -0.25, 0.125], size: [2, 1, 0.5] },
  { center: [0, 0.1, 0], size: [0.5, 0.25, 0.1] },
  { center: [0, 0, 0], size: [0, 0, 0] },
  { center: [1, 2, 3], size: [-1, -2, -3] },
  { center: [0, 0, 0], size: [0, -1, 0] },
  { center: [1e300, -1e300, 0], size: [1e300, 1e300, 1e300] },
  { center: [0, 0, 0], size: [1e308, 1e308, 1e308] },
  { center: [1e-7, 0, 0], size: [1e-20, 1e-20, 1e-20] },
  { center: [3.3333, 7.77777, -12.5], size: [123.456, 78.9, 0.001] },
  { center: [0.5, -0.5, 1.5], size: [1, 1, 1] },
  // preTrans of -70312.5 and -210937.5: Math.round takes a tie up
  { center: [0.001953125, -0.001953125, 0.005859375], size: [1, 1, 1] },
  // meterPerModelUnit.n of round(1e6 / -640), a tie at -1562.5
  { center: [0, 0, 0], size: [-640, -700, -800] },
  { center: [0, 0, 0], size: [1.0078125, 1, 1] },
  { center: [0, 0, 0], size: [0.8, 0.3, 0.2] },
  { center: [-0.5, 0, 0], size: [2.5e-7, 1e-7, 1e-7] },
]

const ROTATIONS: Model3dRotation[] = [
  { ax: 60000, ay: -120000, az: 5400000 },
  { ax: -0.5, ay: 0.5, az: 2.5 },
  { ax: 1e21, ay: -1e-7, az: 0.49999 },
  { ax: -2.5, ay: -1.5, az: -21600000 },
]

const modelArgs = (over: Args = {}): Args => ({
  id: 4,
  offset: OFFSET,
  modelRId: 'rId2',
  posterRId: 'rId3',
  bounds: null,
  uuid: UUID,
  ...over,
})

const MODEL_INPUTS: Input[] = [
  { text: '3D Model 4', args: modelArgs() },
  { text: 'Fox & <Hound> "q"', args: modelArgs({ bounds: BOUNDS[2], rot: ROTATIONS[0] }) },
  { text: '', args: modelArgs({ id: 0, offset: { x: 0, y: 0, cx: 0, cy: 0 }, uuid: UUIDS[1] }) },
  {
    text: '\u{1F600}\u0001\u000b\uD55C',
    args: modelArgs({
      id: 2147483647,
      offset: { x: -1, y: 0.5, cx: 1e21, cy: 2 },
      bounds: BOUNDS[5],
      rot: ROTATIONS[1],
      uuid: UUIDS[2],
    }),
  },
  {
    text: 'm',
    args: modelArgs({
      id: 1.5,
      offset: { x: 1, y: 2, cx: 3, cy: 3 },
      modelRId: 'rId"1',
      posterRId: '<',
      bounds: BOUNDS[3],
      rot: ROTATIONS[2],
    }),
  },
  {
    text: 'tall',
    args: modelArgs({ offset: { x: 5, y: 6, cx: 100, cy: 2000 }, rot: ROTATIONS[3] }),
  },
  ...BOUNDS.map((bounds) => ({ text: 'framed', args: modelArgs({ bounds }) })),
  {
    text: 'no bounds key',
    args: { id: 9, offset: OFFSET, modelRId: 'rId9', posterRId: 'rId8', uuid: UUID },
  },
]

/** Names and ids of the corpus's shapes, each as a new model would take them. */
function modelsOfDocument(parts: Parts): Input[] {
  return elementsOf(parts, CNVPR, 10).map((element) => {
    const name = /\bname="([^"]*)"/.exec(element)?.[1] ?? ''
    const id = Number(/\bid="(\d+)"/.exec(element)?.[1] ?? 1)
    return { text: unescapeXml(name), args: modelArgs({ id }) }
  })
}

const callModel3dXml = (text: string, args: Args): string =>
  withUuid(args.uuid as string, () =>
    model3dXml({
      id: args.id as number,
      name: text,
      offset: args.offset as EmuRect,
      modelRId: args.modelRId as string,
      posterRId: args.posterRId as string,
      bounds: args.bounds as GlbBounds | null,
      ...(args.rot === undefined ? {} : { rot: args.rot as Model3dRotation }),
    }),
  )

const MODEL_XML = callModel3dXml('Model', modelArgs())
const ROTATED_XML = callModel3dXml('Model', modelArgs({ bounds: BOUNDS[2], rot: ROTATIONS[0] }))

/** The model with the Fallback picture's `<a:xfrm>` replaced, as the editor moves it. */
function withFallbackXfrm(xml: string, xfrm: string): string {
  const fallback = xml.indexOf('<mc:Fallback>')
  const start = xml.indexOf('<a:xfrm', fallback)
  const end = xml.indexOf('</a:xfrm>', start) + '</a:xfrm>'.length
  return xml.slice(0, start) + xfrm + xml.slice(end)
}

const MOVED = '<a:xfrm><a:off x="100" y="200"/><a:ext cx="4000000" cy="1000000"/></a:xfrm>'

const FRAME_TEXTS: string[] = [
  MODEL_XML,
  withFallbackXfrm(MODEL_XML, MOVED),
  withFallbackXfrm(ROTATED_XML, MOVED),
  withFallbackXfrm(
    MODEL_XML,
    '<a:xfrm rot="5400000" flipH="1"><a:off x="-5" y="0"/><a:ext cx="10" cy="99999"/></a:xfrm>',
  ),
  withFallbackXfrm(MODEL_XML, '<a:xfrm><a:ext cy="1" cx="2"/><a:off x="1" y="1"/></a:xfrm>'),
  withFallbackXfrm(MODEL_XML, '<a:xfrm><a:off x="0" y="0"/><a:ext cx="-5" cy="7"/></a:xfrm>'),
  withFallbackXfrm(
    MODEL_XML,
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${'9'.repeat(25)}" cy="1"/></a:xfrm>`,
  ),
  withFallbackXfrm(MODEL_XML, '<a:xfrm><a:off x="0" y="0"/><a:ext  cx="5" cy="6"/></a:xfrm>'),
  withFallbackXfrm(MODEL_XML, '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>'),
  withFallbackXfrm(MODEL_XML, '<a:xfrm/>'),
  MODEL_XML.replace('<mc:Fallback>', '<mc:Fallback >'),
  MODEL_XML.replace(/<mc:Fallback>[\s\S]*<\/mc:Fallback>/, ''),
  MODEL_XML.replace('<mc:Choice ', '<mc:Choic '),
  withFallbackXfrm(MODEL_XML.replace('<p:graphicFrame>', '\r\n  <p:graphicFrame>'), MOVED),
  withFallbackXfrm(MODEL_XML.replace('<p:graphicFrame>', '<p:sp/><p:graphicFrame>'), MOVED),
  withFallbackXfrm(MODEL_XML.replace('<am3d:spPr>', '<am3d:spPr >'), MOVED),
  withFallbackXfrm(MODEL_XML.replace(/<am3d:objViewport[^>]*\/>/, ''), MOVED),
  '<mc:AlternateContent><mc:Choice Requires="am3d"><p:graphicFrame><p:xfrm><a:off x="1" y="1"/><a:ext cx="1" cy="1"/></p:xfrm></p:graphicFrame></mc:Choice>' +
    '<mc:Fallback><p:pic><p:spPr><a:xfrm><a:off x="2" y="3"/><a:ext cx="4" cy="5"/></a:xfrm></p:spPr></p:pic></mc:Fallback></mc:AlternateContent>',
  '<mc:Fallback><a:xfrm><a:ext cx="4" cy="5"/></a:xfrm></mc:Fallback><mc:Choice><p:graphicFrame><p:xfrm/>' +
    '<p:xfrm></p:xfrm></p:graphicFrame></mc:Choice>',
  `\u{1F600}${withFallbackXfrm(callModel3dXml('\u{1F600}\uD55C', modelArgs()), MOVED)}`,
  '',
  'plain',
]

const ROTATION_TEXTS: string[] = [
  MODEL_XML,
  ROTATED_XML,
  '<am3d:rot ax="1" ay="2" az="3"/>',
  '<am3d:rot az="-7"/>',
  '<am3d:rot/>',
  '<am3d:rot ax="-60000" ay="-1" az="-2147483648"/>',
  '<am3d:rot ax=\'5\' ay="6"/>',
  '<am3d:rot ax="1.5" ay="+5" az="-0"/>',
  `<am3d:rot ax="${'9'.repeat(30)}" ay="-${'1'.repeat(17)}" az="9007199254740993"/>`,
  '<am3d:rot data-ax="4" xay="5" az ="6"/>',
  '<am3d:rot ax="1"></am3d:rot>',
  '<am3d:rotX ax="9"/><am3d:rot ax="8"/>',
  '<am3d:rot\nax="2"\tay="3"\r\naz="4" />',
  '<am3d:rot ax="1" ax="2"/>',
  '<am3d:rot ax="0x10" ay="1e3" az=""/>',
  '',
  'no rotation',
]

const SET_ROTATION_TEXTS: string[] = [
  MODEL_XML,
  ROTATED_XML,
  '<am3d:trans><am3d:scale/><am3d:postTrans dx="0" dy="0" dz="0"/></am3d:trans>',
  '<am3d:trans><am3d:scale/></am3d:trans>',
  '<am3d:trans><am3d:rot ax="1"></am3d:rot><am3d:postTrans/></am3d:trans>',
  '<am3d:rot ax="1" /><am3d:rot ax="2"/>',
  '<am3d:postTransX/>',
  '<x/>',
  '',
]

const SET_ROTATION_INPUTS: Input[] = SET_ROTATION_TEXTS.flatMap((text) =>
  [NO_ROTATION, ...ROTATIONS].map((rot) => ({ text, args: { rot } })),
)

export const IDENT: CallSpec[] = [
  {
    fn: 'pptxIdent.identity.elementDurableId',
    call: (text, args) => elementDurableId(elementOf(text, args)),
    fromDocument: elementsOfDocument,
    built: ELEMENT_INPUTS,
  },
  {
    fn: 'pptxIdent.identity.slideDurableId',
    call: (text) => slideDurableId({ path: text } as Slide),
    fromDocument: (parts) => [...parts.keys()].map((text) => ({ text })),
    built: SLIDE_PATHS.map((text) => ({ text })),
  },
  {
    fn: 'pptxIdent.identity.elementCNvPrId',
    call: (text, args) => elementCNvPrId(elementOf(text, args)),
    fromDocument: elementsOfDocument,
    built: ELEMENT_INPUTS,
  },
  {
    fn: 'pptxIdent.identity.matchesElementRef',
    call: (text, args) => matchesElementRef(elementOf(text, args), args.id as string),
    fromDocument: refsOfDocument,
    built: REF_INPUTS,
  },
  {
    fn: 'pptxIdent.identity.ensureCreationId',
    call: (text, args) =>
      withUuid(args.uuid as string, () => {
        const element = elementOf(text, args)
        ensureCreationId(element)
        return element.anchor
      }),
    fromDocument: (parts) =>
      [...shapesOf(parts), ...elementsOf(parts, CNVPR)].map((text) => ({
        text,
        args: { uuid: UUID },
      })),
    built: [
      ...ELEMENT_TEXTS.map((text, index) => ({
        text,
        args: { uuid: UUIDS[index % UUIDS.length] },
      })),
      { args: { uuid: UUID, noAnchor: true } },
      // ledger cnvpr-own-extlst-forms: the TypeScript adds a second extLst to cNvPr, the Rust merges into its own
      ...OWN_EXTLST_FORMS.map((text): Input => ({ text, args: { uuid: UUIDS[1] }, seed: false })),
    ],
  },
  {
    fn: 'pptxIdent.identity.groupChildDurableId',
    call: (text, args) =>
      groupChildDurableId(elementOf(text, { noAnchor: args.grpNoAnchor }), childOf(args)),
    fromDocument: groupChildrenOfDocument,
    built: GROUP_CHILD_INPUTS,
  },
  {
    fn: 'pptxIdent.redaction-xml.constants',
    call: (_text, args) => constantOf(REDACTION_CONSTANTS, args),
    built: [...Object.keys(REDACTION_CONSTANTS), ...OTHER_NAMES].map((name) => ({
      args: { name },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxIdent.redaction-xml.redactExtXml',
    call: (text) => redactExtXml(text),
    fromDocument: (parts) =>
      [
        ...new Set(
          elementsOf(parts, CNVPR).map((element) => /\bname="([^"]*)"/.exec(element)?.[1] ?? ''),
        ),
      ].map((name) => ({ text: unescapeXml(name) })),
    built: [...LABELS, ...DOLLAR_LABELS, '\u0000a\u0001\u000b\u000c\ufffe', 'a\r\nb'].map(
      (text) => ({ text }),
    ),
  },
  {
    fn: 'pptxIdent.redaction-xml.hasRedactExtIn',
    call: (text) => hasRedactExtIn(text),
    fromDocument: (parts) =>
      [...shapesOf(parts), ...elementsOf(parts, RPR)].map((text) => ({ text })),
    built: [...PROPS, ...SYNC_TEXTS.map(([text]) => text)].map((text) => ({ text })),
  },
  {
    fn: 'pptxIdent.redaction-xml.syncRedactExt',
    call: (text, args) => syncRedactExt(text, args.tag as string, args.label as string | undefined),
    fromDocument: (parts) =>
      shapesOf(parts).flatMap((text) =>
        text.startsWith('<p:pic')
          ? [
              { text, args: { tag: 'p:spPr', label: 'Name' } },
              { text, args: { tag: 'p:spPr' } },
            ]
          : [
              { text, args: { tag: 'a:rPr', label: 'Name' } },
              { text, args: { tag: 'a:rPr' } },
            ],
      ),
    built: unseeded(SYNC_INPUTS),
  },
  {
    fn: 'pptxIdent.redaction-xml.readRedactLabel',
    call: (text, args) =>
      readRedactLabel((parseTsParser.parse(text) as Record<string, unknown>)[args.name as string]),
    fromDocument: (parts) => [
      ...elementsOf(parts, RPR).map((text) => ({ text, args: { name: 'a:rPr' } })),
      ...elementsOf(parts, SPPR).map((text) => ({ text, args: { name: 'p:spPr' } })),
    ],
    built: LABEL_INPUTS,
  },
  {
    fn: 'pptxIdent.redaction-xml.stripRedactExt',
    call: (text) => stripRedactExt(text),
    fromDocument: (parts) =>
      [...elementsOf(parts, RPR), ...shapesOf(parts)].map((text) => ({ text })),
    built: unseeded(
      [...PROPS, ...SYNC_TEXTS.map(([text]) => text), `<a:t> </a:t><a:b></a:c>`].map((text) => ({
        text,
      })),
    ),
  },
  {
    fn: 'pptxIdent.redaction-xml.setRedactExt',
    call: (text, args) => setRedactExt(text, args.label as string),
    fromDocument: (parts) =>
      [...elementsOf(parts, RPR), ...elementsOf(parts, SPPR)].map((text) => ({
        text,
        args: { label: 'Name' },
      })),
    built: unseeded(SET_INPUTS),
  },
  {
    fn: 'pptxIdent.model3d.constants',
    call: (_text, args) => constantOf(MODEL3D_CONSTANTS, args),
    built: [...Object.keys(MODEL3D_CONSTANTS), ...OTHER_NAMES].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'pptxIdent.model3d.model3dFraming',
    call: (_text, args) => model3dFraming(args.bounds as GlbBounds | null),
    built: [{}, ...BOUNDS.map((bounds) => ({ args: { bounds } }))],
    mutation: 'none',
  },
  {
    fn: 'pptxIdent.model3d.model3dXml',
    call: callModel3dXml,
    fromDocument: modelsOfDocument,
    built: MODEL_INPUTS,
  },
  {
    fn: 'pptxIdent.model3d.syncModel3dFrame',
    call: (text) => syncModel3dFrame(text),
    fromDocument: (parts) => shapesOf(parts).map((text) => ({ text })),
    built: FRAME_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxIdent.model3d.readModel3dRotation',
    call: (text) => readModel3dRotation(text),
    fromDocument: (parts) => shapesOf(parts).map((text) => ({ text })),
    built: ROTATION_TEXTS.map((text) => ({ text })),
  },
  {
    fn: 'pptxIdent.model3d.setModel3dRotationXml',
    call: (text, args) => setModel3dRotationXml(text, args.rot as Model3dRotation),
    fromDocument: (parts) => shapesOf(parts).map((text) => ({ text, args: { rot: ROTATIONS[0] } })),
    built: SET_ROTATION_INPUTS,
  },
]
