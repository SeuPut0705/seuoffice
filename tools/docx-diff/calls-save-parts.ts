// Group `save`, slice `parts` (crates/docx-engine/src/save/parts/): the part
// writers of patch.ts (header and footer parts, comments, settings.xml, the
// personal-information scrub), style-upsert.ts, remove-parts.ts,
// resource-cleanup.ts and zip-splice.ts.
//
// patch.ts exports few of its functions: `saveInternals()` (save-internals.ts)
// is a copy of it that exports every top-level function and constant. A function over
// XML takes its text; a function that writes into a zip answers the parts of
// the zip after the call; bytes cross as arrays of numbers; a Set as its
// sorted values; a callback as the name of the one the spec stands in for it.
import JSZip from 'jszip'
import {
  applyRemoveParts,
  planRemoveParts,
  removePartsRefusalMessage,
  removePartsRefusalMessageFor,
} from './reference/remove-parts'
import { cleanupDocxOwnedResources, referencedRelationshipIds } from './reference/resource-cleanup'
import {
  builtInHeadingStyleUpsert,
  mergeDefaultFontsXml,
  mergeStyleXml,
  pendingHeadingLevel,
  upsertStyleXml,
  type StyleUpsert,
} from './reference/style-upsert'
import {
  bufferSource,
  lazyMediaHashesIn,
  materializeDocx,
  readZipEntries,
  slimDocx,
  writeZip,
  type ZipEntry,
  type ZipFile,
} from './reference/zip-splice'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { commentEntries } from './reference/comment-slices'
import { COMMENT_PARTS, editsOf, entrySlices } from './withheld-inputs'
import { saveInternals } from './save-internals'

// ---------------------------------------------------------------- the copy of patch.ts

const internals = await saveInternals()

const call = (name: string): ((...args: unknown[]) => unknown) => {
  const fn = internals[name]
  if (!fn) throw new Error(`patch.ts has no function ${name}`)
  return fn
}

// ---------------------------------------------------------------- helpers

/** The parts of a zip after a call: `[name, text]`, null for a folder. */
async function partsOf(zip: JSZip): Promise<Array<[string, string | null]>> {
  const out: Array<[string, string | null]> = []
  for (const [name, entry] of Object.entries(zip.files))
    out.push([name, entry.dir ? null : await entry.async('string')])
  return out
}

/** `[name, text]` of the text parts of a corpus document, small ones only (the call crosses the wire). */
function smallParts(parts: ReadonlyMap<string, string>, budget = 300_000): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let size = 0
  for (const [name, text] of parts) {
    size += text.length
    if (size > budget) continue
    out.push([name, text])
  }
  return out
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const partOf =
  (name: string, args: (text: string) => Record<string, unknown> = () => ({})) =>
  (parts: ReadonlyMap<string, string>): Input[] => {
    const text = parts.get(name)
    return text === undefined ? [] : [{ text, args: args(text) }]
  }

/** the parts of a document whose name satisfies `test`, one input each */
const eachPart =
  (
    test: (name: string) => boolean,
    args: (text: string, name: string) => Record<string, unknown> = () => ({}),
  ) =>
  (parts: ReadonlyMap<string, string>): Input[] =>
    [...parts]
      .filter(([name]) => test(name))
      .map(([name, text]) => ({ text, args: args(text, name) }))

const isXml = (name: string): boolean => /\.xml$/i.test(name)

// ---------------------------------------------------------------- settings.xml

const SETTINGS = (
  children: string,
  root = `<w:settings xmlns:w="${W}">`,
  close = '</w:settings>',
): string => `${DECL}${root}${children}${close}`

const SETTINGS_SAMPLES = [
  SETTINGS(
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>',
  ),
  SETTINGS(''),
  SETTINGS('', `<w:settings xmlns:w="${W}"/>`, ''),
  SETTINGS('', `<settings xmlns="${W}"/>`, ''),
  SETTINGS(
    '<zoom percent="100"/><defaultTabStop val="720"/>',
    `<settings xmlns="${W}">`,
    '</settings>',
  ),
  SETTINGS(
    '<w:mirrorMargins></w:mirrorMargins><w:zoom w:percent="90"/><w:trackRevisions/><w:evenAndOddHeaders w:val="1"></w:evenAndOddHeaders>',
  ),
  SETTINGS(
    '<w:documentProtection w:edit="readOnly" w:enforcement="1"></w:documentProtection><w:writeProtection w:recommended="1"/>',
  ),
  SETTINGS(
    '<w:documentProtection w:edit="forms"/><w:removePersonalInformation/><w:unknown/><w:compat/>',
  ),
  SETTINGS('<w:unknownOne/><w:unknownTwo/>'),
  SETTINGS(
    '<w:view w:val="print"/><w:zoom w:percent="100"/><w:revisionView w:markup="0"/><w:defaultTabStop w:val="720"/>',
  ),
  SETTINGS('<w:zoom w:percent="100"/>', `<w:settings xmlns:w="${W}" w:note="a > b">`),
  SETTINGS('<w:zoom w:percent="100"/>', `<w:settings xmlns:w="${W}" w:note='quoted > text'/>`, ''),
  SETTINGS('<w15:removePersonalInformation xmlns:w15="x"/>', `<w:settings xmlns:w="${W}">`),
  '<p:settings/>',
  'not xml at all',
  '',
]

const FLAG_TAGS = [
  'w:mirrorMargins',
  'w:trackRevisions',
  'w:displayBackgroundShape',
  'w:evenAndOddHeaders',
  'w:gutterAtTop',
]

const BOOLS = [true, false]

const SHA = { hash: 'aGFzaA==', salt: 'c2FsdA==', spinCount: 100000, algorithmSid: 14 }

// ---------------------------------------------------------------- the scrub

const PEOPLE = `${DECL}<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Ann"><w15:presenceInfo w15:providerId="None" w15:userId="Ann"/></w15:person><w15:person w15:author="Bob"/></w15:people>`
const PEOPLE_DEFAULT = `${DECL}<people xmlns="http://schemas.microsoft.com/office/word/2012/wordml"><person author="Ann"><presenceInfo/></person></people>`
const CORE = `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>Ann</dc:creator><cp:lastModifiedBy>Bob</cp:lastModifiedBy></cp:coreProperties>`
const APP = `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>X</Application><Company>ACME</Company><Manager>Boss</Manager></Properties>`
const COMMENTS_WITH_AUTHORS = `${DECL}<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Ann" w:date="2024-01-01T00:00:00Z" w:initials="AB"><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:comment><w:comment w:id='1' w:author='Bob "B"' w:initials='BB'><w:p/></w:comment></w:comments>`
const DEFAULT_NS_COMMENTS = `<comments xmlns="${W}"><comment id="0" author="Ann" initials="A"/></comments>`
const MIXED = `<w:root xmlns:w="${W}" xmlns:x="urn:x"><!-- w:author="keep" --><![CDATA[ w:author="keep" ]]><?pi w:author="keep"?><x:a w:author="Ann" author="skip"/><w:ins w:id="1" w:author = "Cy" w:initials = 'CC' author="no">w:author="text"</w:ins></w:root>`

const XML_SAMPLES = [
  PEOPLE,
  PEOPLE_DEFAULT,
  CORE,
  APP,
  COMMENTS_WITH_AUTHORS,
  DEFAULT_NS_COMMENTS,
  MIXED,
  '<a/>',
  '',
  '<w:x xmlns:w="urn:other" w:author="Ann"/>',
  `<w:a xmlns:w="${W}" xmlns:v="${W}" v:author="Ann" w:author="Bob" w:initials="X"/>`,
]

const OPAQUE_SAMPLES = [
  { text: '<!-- a --><b/>', start: 0 },
  { text: '<!-- a ', start: 0 },
  { text: 'xx<![CDATA[ <b/> ]]>yy', start: 2 },
  { text: '<![CDATA[ open', start: 0 },
  { text: '<?xml version="1.0"?><a/>', start: 0 },
  { text: '<? open', start: 0 },
  { text: '<!DOCTYPE a [<!ENTITY e "x>y">]><a/>', start: 0 },
  { text: '<!DOCTYPE a "q>" [ ]><a/>', start: 0 },
  { text: '<!DOCTYPE a ][ >', start: 0 },
  { text: '<!DOCTYPE open', start: 0 },
  { text: '<a href="x>y">text</a>', start: 0 },
  { text: 'é<!-- é --><é/>', start: 1 },
  { text: '<w:t>é😀</w:t><!-- 😀 -->', start: 11 },
]

const TAG_SAMPLES = [
  { text: '<a b="x>y" c=\'z>\'>t</a>', start: 0 },
  { text: '<a b="open', start: 0 },
  { text: '<a/><b>', start: 3 },
  { text: '<é a="😀">', start: 0 },
  { text: '<a', start: 0 },
]

// ---------------------------------------------------------------- header and footer parts

const PAGE = '\uE001'
const TOTAL = '\uE000'
const SECTION = '\uE002'

const HDR_ROOT = `<w:hdr xmlns:w="${W}" xmlns:r="${R}">`
const para = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const TBL = (cells: string[][]): string =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${cells[0]!.map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid>${cells
    .map(
      (row) =>
        `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${cell}</w:tc>`).join('')}</w:tr>`,
    )
    .join('')}</w:tbl>`
const WATERMARK = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" id="PowerPlusWaterMarkObject1"><v:textpath string="DRAFT"/></v:shape></w:pict></w:r></w:p>`
const LOGO = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="y"/></wp:inline></w:drawing></w:r></w:p>`
const SDT_BLOCK = (inner: string): string =>
  `<w:sdt><w:sdtPr><w:id w:val="7"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
const ORIGINALS: Array<string | null> = [
  null,
  `${DECL}${HDR_ROOT}${para('Old')}</w:hdr>`,
  `${DECL}${HDR_ROOT}${para('Old')}${TBL([[para('a'), para('b')]])}${para('Tail')}</w:hdr>`,
  `${DECL}${HDR_ROOT}${WATERMARK}${para('Old')}${LOGO}</w:hdr>`,
  `${DECL}<w:hdr xmlns:w="${W}">${TBL([[para('a')]])}${SDT_BLOCK(TBL([[para('x'), para('y')]]))}</w:hdr>`,
  `${DECL}<w:ftr xmlns:w="${W}" xmlns:r="${R}">${para('Foot')}${SDT_BLOCK(SDT_BLOCK(TBL([[para('deep')]])))}</w:ftr>`,
  `${DECL}<w:hdr xmlns:w="${W}" w:note="a > b">${para('Old')}${TBL([[para('a')]])}</w:hdr>`,
  `${DECL}<w:hdr xmlns:w="${W}"><w:sdt/></w:hdr>`,
  'not a part',
  '',
]

const run = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  text,
  ...extra,
})
const cell = (
  paras: Array<Array<Record<string, unknown>>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ paras, ...extra })

const HFS: Array<Record<string, unknown>> = [
  { text: '' },
  { text: 'Plain' },
  { text: 'Page # of', pageNumber: true },
  { text: `Page ${PAGE} of ${TOTAL}`, pageNumber: true },
  { text: `${SECTION} and ${TOTAL} and ${PAGE}` },
  { text: 'x', pageNumber: true },
  { text: 'a # b # c', pageNumber: true },
  { text: '# only', pageNumber: false },
  { text: '', paras: [] },
  { text: '', paras: [{ runs: [run('Hello')] }] },
  {
    text: '',
    paras: [
      { runs: [run('Left', { bold: true })], align: 'left' },
      { runs: [run('Right')], align: 'right' },
    ],
  },
  { text: '', pageNumber: true, paras: [{ runs: [run('Page # here')] }] },
  { text: '', pageNumber: true, paras: [{ runs: [run('Page # and # again'), run('x # y')] }] },
  { text: '', pageNumber: true, paras: [{ runs: [run(`${PAGE}`)] }, { runs: [run('#')] }] },
  { text: '', paras: [{ runs: [run(`A${PAGE}B${TOTAL}C${SECTION}D`)] }] },
  { text: '', pageNumber: true, paras: [{ runs: [run('a # b')] }, { runs: [run(`${PAGE}x`)] }] },
  { text: '', paras: [{ runs: [] }] },
  { text: '', paras: [{ runs: [], lineOnly: true }, { runs: [run('Text')] }] },
  { text: '', paras: [{ runs: [run('RTL')], bidi: true, align: 'right' }] },
  {
    text: '',
    paras: [
      {
        runs: [],
        cells: [cell([[run('c1')]]), cell([[run('c2')], [run('c3')]])],
        row: { source: { tbl: 0, tr: 0 } },
      },
      { runs: [run('After')] },
    ],
  },
  {
    text: '',
    paras: [
      {
        runs: [],
        cells: [cell([[run('new a')]], { rewrite: true }), cell([[run('keep')]])],
        row: { source: { tbl: 0, tr: 0 } },
      },
      { runs: [run('Text')] },
    ],
  },
  {
    text: '',
    paras: [
      {
        runs: [],
        cells: [
          cell([[run('P # 1')], [run('second')]], {
            rewrite: true,
            rewriteFormat: [0],
            paraProps: [{ align: 'center' }, null],
            priorParaProps: [{ align: 'left' }],
          }),
        ],
        row: { source: { tbl: 0, tr: 0 } },
      },
    ],
    pageNumber: true,
  },
  {
    text: '',
    paras: [
      { runs: [], cells: [cell([], { rewrite: true })], row: { source: { tbl: 1, tr: 0 } } },
      {
        runs: [],
        cells: [cell([[run('q')]], { rewrite: true })],
        row: { source: { tbl: 1, tr: 1 } },
      },
    ],
  },
  {
    text: '',
    paras: [
      {
        runs: [
          run('One', {
            wrap: [
              { seq: 1, open: `<w:smartTag w:uri="urn:x" w:element="e">`, close: '</w:smartTag>' },
            ],
          }),
          run('Two'),
        ],
      },
    ],
  },
  {
    text: '',
    paras: [
      {
        runs: [
          run('R', {
            bold: true,
            italic: true,
            color: 'FF0000',
            sizeHalfPoints: 28,
            font: 'Arial',
          }),
        ],
      },
    ],
  },
  { text: '', paras: [{ runs: [run('a & <b>')] }] },
  { text: 'a & <b> \u0001 "q"' },
  { text: '', paras: [{ runs: [run('x')], align: 'left' }], revisionsResolved: [] },
]

const WATERMARK_XMLS: Array<string | undefined> = [
  undefined,
  '',
  '<w:p><w:r><w:pict><v:shape id="WM"><v:textpath string="SECRET"/></v:shape></w:pict></w:r></w:p>',
]

const KINDS = ['header', 'footer'] as const

const hfInputs = (): Input[] => {
  const out: Input[] = []
  for (const kind of KINDS) {
    HFS.forEach((hf, i) => {
      const original = ORIGINALS[i % ORIGINALS.length]
      out.push({ text: kind, args: { hf, originalXml: original, pageCount: 1 + (i % 4) } })
      out.push({ text: kind, args: { hf } })
    })
  }
  for (const wm of WATERMARK_XMLS) {
    for (const original of ORIGINALS) {
      out.push({
        text: 'header',
        args: {
          hf: { text: 'W', paras: [{ runs: [run('W')] }] },
          watermarkXml: wm,
          originalXml: original,
        },
      })
    }
  }
  out.push({ text: 'header', args: { hf: { text: 'x' }, originalXml: ORIGINALS[1], pageCount: 0 } })
  out.push({
    text: 'header',
    args: { hf: { text: 'x' }, originalXml: ORIGINALS[1], pageCount: 2.5 },
  })
  out.push({ text: 'header', args: { hf: { text: `${TOTAL}` }, pageCount: -3 } })
  out.push({ text: 'footer', args: { hf: { text: `${TOTAL}` }, pageCount: 1e21 } })
  return out
}

const REVISED_PART = `${DECL}${HDR_ROOT}<w:p><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:hdr>`

// ---------------------------------------------------------------- comments

const comment = (
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ id, author: 'Ann', text, ...extra })

const COMMENTS_ORIGINAL = `${DECL}<w:comments xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:comment w:id="0" w:author="Ann" w:initials="A"><w:p w14:paraId="0000000A"><w:r><w:t>First</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Bob"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold &amp; </w:t></w:r><w:r><w:t>text</w:t></w:r></w:p><w:p><w:r><w:t>Second para</w:t></w:r></w:p></w:comment><w:comment w:id="2" w:author="Cy"><w:p/></w:comment></w:comments>`
const COMMENTS_NO_NS = `<w:comments><w:comment w:id="0"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment></w:comments>`

const COMMENT_SETS: Array<Array<Record<string, unknown>>> = [
  [],
  [comment('0', 'First')],
  [comment('0', 'First'), comment('1', 'Bold & text\nSecond para')],
  [comment('0', 'Changed'), comment('1', 'Bold & text\nSecond para edited')],
  [comment('0', 'First'), comment('1', 'Different\nparagraph count\nchanged')],
  [
    comment('0', 'First', { paraId: '0000000A', initials: 'A', date: '2024-05-06T07:08:09Z' }),
    comment('3', 'New & <new>', { paraId: '0000000B', parentId: '0', done: true }),
  ],
  [
    comment('x"y', 'quote', { author: 'A"B', initials: '', date: '' }),
    comment('9', 'a\n\nb', { paraId: 'FFFFFFFF' }),
  ],
  [comment('2', 'now text'), comment('1', '')],
  [
    comment('0', 'a', { paraId: 'P1' }),
    comment('1', 'b', { paraId: 'P2', parentId: '0', done: false }),
    comment('2', 'c', { paraId: 'P3', parentId: 'missing' }),
    comment('3', 'd', { paraId: 'P4', parentId: '3' }),
  ],
  [comment('5', 'é 😀 text', { author: 'Zoë' })],
]

const IMAGE_RUNS: Array<Array<[string, string]> | undefined> = [
  undefined,
  [],
  [['1', '<w:r><w:drawing/></w:r>']],
  [
    ['0', '<w:r><w:drawing>img</w:drawing></w:r>'],
    ['3', '<w:r><w:pict/></w:r>'],
  ],
]

// ---------------------------------------------------------------- style-upsert

const STYLES = `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0" w:line="276" w:lineRule="auto"/><w:ind w:left="720" w:hanging="360"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:style><w:style w:type="character" w:styleId='Emph'><w:name w:val='Emph'/><w:rPr><w:i/></w:rPr></w:style></w:styles>`
const STYLES_BARE = `<w:styles xmlns:w="${W}"></w:styles>`
const STYLES_NO_DEFAULTS = `${DECL}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="A"/></w:styles>`

const UPSERTS: StyleUpsert[] = [
  { styleId: 'New' },
  {
    styleId: 'New2',
    type: 'character',
    name: 'My style',
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: false,
  },
  { styleId: 'BuiltIn', builtIn: true, name: 'Built in' },
  { styleId: 'Heading1', pPr: { align: 'center', spaceBeforeTwips: 120.5, lineSpacing: 1.5 } },
  {
    styleId: 'Heading1',
    rPr: {
      bold: false,
      italic: true,
      underline: true,
      strike: false,
      caps: true,
      smallCaps: false,
      color: 'FF0000',
      highlight: 'yellow',
      sizeHalfPoints: 1.4,
      font: 'Arial',
      eastAsiaFont: 'SimSun',
    },
  },
  {
    styleId: 'Heading1',
    rPr: {
      color: null,
      highlight: null,
      sizeHalfPoints: null,
      font: null,
      eastAsiaFont: null,
      underline: false,
    },
  },
  {
    styleId: 'Heading1',
    pPr: {
      align: null,
      spaceBeforeTwips: null,
      spaceAfterTwips: null,
      lineSpacing: null,
      indentLeftTwips: null,
      indentRightTwips: null,
      firstLineTwips: null,
      outlineLevel: null,
      keepNext: false,
      keepLines: true,
      pageBreakBefore: true,
    },
  },
  {
    styleId: 'Heading1',
    pPr: {
      indentLeftTwips: 100,
      indentRightTwips: 200,
      firstLineTwips: 300,
      outlineLevel: 3,
      numPr: { numId: '5', ilvl: 1 },
    },
  },
  { styleId: 'Heading1', pPr: { firstLineTwips: -240, align: 'justify', numPr: null } },
  {
    styleId: 'Heading1',
    pPr: {
      tabStops: [
        { pos: 720, val: 'left' },
        { pos: 1440.4, val: 'decimal', leader: 'dot' },
        { pos: 2000, val: 'right', leader: 'none' },
      ],
    },
  },
  { styleId: 'Heading1', pPr: { tabStops: [] } },
  { styleId: 'Heading1', pPr: { tabStops: null } },
  { styleId: 'Heading1', basedOn: null, next: null, quickFormat: true },
  { styleId: 'Emph', name: 'Emphasis', rPr: { bold: true } },
  { styleId: 'a"b<c', name: 'q"<', pPr: { spaceAfterTwips: 10 } },
  { styleId: 'a.b*c', name: 'dots' },
  { styleId: 'Normal', pPr: {}, rPr: {} },
  { styleId: 'Normal', pPr: { spaceBeforeTwips: Number.MAX_VALUE } },
  { styleId: 'Heading1', rPr: { sizeHalfPoints: 100000 } },
  { styleId: 'Heading1', rPr: { sizeHalfPoints: -5 } },
]

const FONT_SETS = [
  { font: 'Arial' },
  { eastAsiaFont: 'SimSun' },
  { font: 'Arial', eastAsiaFont: 'SimSun' },
  { font: null, eastAsiaFont: null },
  {},
  { font: 'A"B' },
]

const PENDING_CASES: Array<{
  styleId: string
  pending: Record<string, unknown>
  existing: Record<string, unknown>
}> = [
  { styleId: 'Heading2', pending: { Heading2: { styleId: 'Heading2' } }, existing: {} },
  { styleId: 'X', pending: { X: { styleId: 'X', name: 'heading 3' } }, existing: {} },
  { styleId: 'X', pending: { X: { styleId: 'X', name: 'Heading  4' } }, existing: {} },
  { styleId: 'X', pending: { X: { styleId: 'X', pPr: { outlineLevel: 5 } } }, existing: {} },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', pPr: { outlineLevel: null } } },
    existing: { X: { headingLevel: 2 } },
  },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X' } },
    existing: { X: { headingLevel: 2, headingOutlineOff: true } },
  },
  { styleId: 'X', pending: { X: { styleId: 'X' } }, existing: { X: { headingLevel: 2 } } },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', basedOn: 'P' } },
    existing: { X: { headingLevel: 2 }, P: { headingLevel: 4 } },
  },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', basedOn: 'P' } },
    existing: { X: { headingLevel: 2, headingLevelInherited: true }, P: { headingLevel: 4 } },
  },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', basedOn: null } },
    existing: { X: { basedOn: 'P' }, P: { headingLevel: 4 } },
  },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X' } },
    existing: { X: { basedOn: 'P' }, P: { headingLevel: 4 } },
  },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', basedOn: 'Y' }, Y: { styleId: 'Y', basedOn: 'X' } },
    existing: {},
  },
  { styleId: 'X', pending: { X: { styleId: 'X', basedOn: 'Heading6' } }, existing: {} },
  { styleId: 'X', pending: {}, existing: { X: { headingLevel: 7 } } },
  { styleId: 'X', pending: {}, existing: {} },
  {
    styleId: 'X',
    pending: { X: { styleId: 'X', basedOn: '' } },
    existing: { X: { headingLevel: 0 } },
  },
]

// ---------------------------------------------------------------- packages

const CT = (extra = ''): string =>
  `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="x"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${extra}</Types>`
const RELS = (rels: Array<[string, string, string, string?]>): string =>
  `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`,
    )
    .join('')}</Relationships>`
const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DOC = (body: string): string =>
  `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${body}</w:body></w:document>`

type Files = Array<[string, string]>

const BASE: Files = [
  ['[Content_Types].xml', CT()],
  ['_rels/.rels', RELS([['rId1', `${T}/officeDocument`, 'word/document.xml']])],
  ['word/document.xml', DOC('<w:p/>')],
  ['word/_rels/document.xml.rels', RELS([])],
]

const withFiles = (extra: Files, replace: Files = []): Files => [
  ...BASE.map(([name, text]): [string, string] => [
    name,
    replace.find(([n]) => n === name)?.[1] ?? text,
  ]),
  ...extra,
]

const ITEM_PROPS = (id: string): string =>
  `${DECL}<ds:datastoreItem ds:itemID="${id}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`
const BOUND_SDT = (id: string): string =>
  `<w:sdt><w:sdtPr><w:alias w:val="A"/><w:tag w:val="bound"/><w:id w:val="42"/><w:dataBinding w:prefixMappings="" w:xpath="/a" w:storeItemID="${id}"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>v</w:t></w:r></w:p></w:sdtContent></w:sdt>`

const CUSTOM_XML: Files = [
  ['customXml/item1.xml', '<a/>'],
  ['customXml/itemProps1.xml', ITEM_PROPS('{AAAA-1111}')],
  ['customXml/_rels/item1.xml.rels', RELS([['rId1', `${T}/customXmlProps`, 'itemProps1.xml']])],
  ['customXml/item2.xml', '<b/>'],
  ['customXml/itemProps2.xml', ITEM_PROPS('{bbbb-2222}')],
  ['customXml/readme.txt', 'text'],
  ['word/webextensions/webextension1.xml', '<we/>'],
  ['word/webextensions/taskpanes.xml', '<tp/>'],
  ['word/webextensions/_rels/taskpanes.xml.rels', RELS([['rId1', 'x', 'webextension1.xml']])],
]

const CUSTOM_RELS: Array<[string, string, string, string?]> = [
  ['rId1', `${T}/customXml`, '../customXml/item1.xml'],
  ['rId2', `${T}/customXml`, '../customXml/item2.xml'],
  [
    'rId3',
    'http://schemas.microsoft.com/office/2011/relationships/webextension',
    'webextensions/webextension1.xml',
  ],
  ['rId4', `${T}/hyperlink`, 'https://example.com', 'External'],
  ['rId5', `${T}/styles`, 'styles.xml'],
]

const CUSTOM_CT = CT(
  '<Override PartName="/customXml/itemProps1.xml" ContentType="p"/><Override PartName="/customXml/itemProps2.xml" ContentType="p"/><Override PartName="/word/webextensions/webextension1.xml" ContentType="w"/><Default Extension="txt" ContentType="t"/>',
)

const WITH_CUSTOM = (body = '<w:p/>'): Files =>
  withFiles(
    [
      ...CUSTOM_XML,
      ['word/styles.xml', '<w:styles/>'],
      ['docProps/core.xml', CORE],
      ['folder/', ''],
      ['empty/', ''],
      ['empty/deeper/', ''],
    ],
    [
      ['[Content_Types].xml', CUSTOM_CT],
      ['word/_rels/document.xml.rels', RELS(CUSTOM_RELS)],
      ['word/document.xml', DOC(body)],
    ],
  )

const REMOVE_OPTIONS: Array<Record<string, unknown>> = [
  { kinds: ['customXml'] },
  { kinds: ['webExtensions'] },
  { kinds: ['customXml', 'webExtensions', 'unknown'] },
  { paths: ['customXml/item1.xml'] },
  {
    paths: [
      'customXml/item1.xml',
      'nothing.xml',
      '/customXml/item2.xml',
      '../x',
      '',
      'customXml//item2.xml',
      'customXml\\itemProps2.xml',
    ],
  },
  {
    paths: [
      'word/document.xml',
      '[Content_Types].xml',
      '_rels/.rels',
      'word/styles.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/theme/theme1.xml',
    ],
  },
  { paths: ['customXml/readme.txt'] },
  { paths: ['word/webextensions/'], kinds: ['webExtensions'] },
  { kinds: ['customXml'], dataBinding: 'strip' },
  { kinds: ['customXml'], dataBinding: 'refuse' },
  { paths: ['customXml/item2.xml'], dataBinding: 'strip' },
  { paths: ['docProps/core.xml', 'folder', 'empty/'] },
  {},
]

const BINDING_BODIES = [
  '<w:p/>',
  BOUND_SDT('{aaaa-1111}'),
  BOUND_SDT('{BBBB-2222}') + BOUND_SDT('AAAA-1111'),
  BOUND_SDT('{cccc-3333}'),
  // a GUID with white space around it still names the store (normalizeItemId trims it)
  BOUND_SDT(' \t{aaaa-1111}\n '),
  `<w:sdt><w:sdtPr><w:id w:val="9"/><w15:dataBinding xmlns:w15="x" w:storeItemID='{aaaa-1111}'/></w:sdtPr><w:sdtContent/></w:sdt>`,
]

const BINDINGS = [
  [],
  [{ part: 'word/document.xml', storeItemID: '{A}', itemPropsPath: 'customXml/itemProps1.xml' }],
  [
    {
      part: 'word/header1.xml',
      tag: 'T',
      controlId: '5',
      storeItemID: '{A}',
      itemPropsPath: 'customXml/itemProps1.xml',
    },
    {
      part: 'word/document.xml',
      tag: '',
      controlId: '',
      storeItemID: '{B}',
      itemPropsPath: 'customXml/itemProps2.xml',
    },
  ],
]

// resource cleanup

const DRAWING = (rid: string): string =>
  `<w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="${rid}"/></w:drawing></w:r></w:p>`
const RESOURCE_RELS: Array<[string, string, string, string?]> = [
  ['rId1', `${T}/image`, 'media/image1.png'],
  ['rId2', `${T}/image`, 'media/image2.png'],
  ['rId3', `${T}/chart`, 'charts/chart1.xml'],
  ['rId4', `${T}/hyperlink`, 'https://example.com', 'External'],
  ['rId5', `${T}/hyperlink`, 'bookmark'],
  ['rId6', `${T}/diagramData`, 'diagrams/data1.xml'],
  ['rId7', `${T}/diagramDrawing`, 'diagrams/drawing1.xml'],
  ['rId8', `${T}/diagramLayout`, 'diagrams/layout1.xml'],
  ['rId9', `${T}/styles`, 'styles.xml'],
  ['rId10', `${T}/oleObject`, 'embeddings/obj1.bin'],
  ['rId11', `${T}/image`, 'media/shared.png'],
  ['rId12', `${T}/image`, '../outside.png'],
]

const RESOURCE_FILES: Files = [
  ['word/media/image1.png', 'png1'],
  ['word/media/image2.png', 'png2'],
  ['word/media/shared.png', 'shared'],
  ['word/charts/chart1.xml', '<c/>'],
  [
    'word/charts/_rels/chart1.xml.rels',
    RELS([
      ['rId1', `${T}/package`, '../embeddings/book1.xlsx'],
      ['rId2', `${T}/image`, '../media/shared.png'],
    ]),
  ],
  ['word/embeddings/book1.xlsx', 'xlsx'],
  ['word/embeddings/obj1.bin', 'bin'],
  ['word/diagrams/data1.xml', '<d/>'],
  ['word/diagrams/drawing1.xml', '<dr/>'],
  ['word/diagrams/layout1.xml', '<l/>'],
  ['word/styles.xml', '<w:styles/>'],
  [
    'word/header1.xml',
    `<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rId1"/></w:drawing></w:r></w:p></w:hdr>`,
  ],
  ['word/_rels/header1.xml.rels', RELS([['rId1', `${T}/image`, 'media/shared.png']])],
]

const RESOURCE_CT = CT(
  '<Override PartName="/word/charts/chart1.xml" ContentType="c"/><Override PartName="/word/diagrams/data1.xml" ContentType="d"/><Override PartName="/word/media/image1.png" ContentType="i"/><Override PartName="/word/embeddings/obj1.bin" ContentType="o"/>',
)

const resourceFiles = (body: string, rels = RESOURCE_RELS): Files =>
  withFiles(RESOURCE_FILES, [
    ['[Content_Types].xml', RESOURCE_CT],
    ['word/_rels/document.xml.rels', RELS(rels)],
    ['word/document.xml', DOC(body)],
  ])

const ALL_REFS =
  DRAWING('rId1') +
  DRAWING('rId2') +
  DRAWING('rId3') +
  DRAWING('rId6') +
  DRAWING('rId8') +
  DRAWING('rId10') +
  DRAWING('rId11')

const REF_XML = [
  DOC(
    `<w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rId1" r:link='rId2'/></w:drawing></w:r></w:p>`,
  ),
  `<w:document xmlns:w="${W}" xmlns:rel="${R}"><rel:x rel:id="rId5" r:id="rId9"/></w:document>`,
  `<v:shape xmlns:v="urn:v" xmlns:o="urn:o" o:relid="rId7" o:title="rId8" id="rIdx"/>`,
  `<a xmlns:r="${R}" xmlns:s='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><b r:id="rId&amp;1" s:embed='rId3'/></a>`,
  `<a x="RID5" y='rid6' z="rId" w="xrId1"/>`,
  `<a xmlns:r="urn:not-a-rel" r:id="rId2"/>`,
  '',
  'no xml',
  `<a xmlns:r.v="${R}" r.v:id="rId4"/>`,
]

const PARTS_VARIANTS: Array<{
  label: string
  files: Files
  documentPath: string
  sourceReferencedIds?: string[]
}> = [
  { label: 'all referenced', files: resourceFiles(ALL_REFS), documentPath: 'word/document.xml' },
  { label: 'none referenced', files: resourceFiles('<w:p/>'), documentPath: 'word/document.xml' },
  {
    label: 'one image dropped',
    files: resourceFiles(
      DRAWING('rId2') + DRAWING('rId3') + DRAWING('rId6') + DRAWING('rId10') + DRAWING('rId11'),
    ),
    documentPath: 'word/document.xml',
  },
  {
    label: 'source orphans kept',
    files: resourceFiles('<w:p/>'),
    documentPath: 'word/document.xml',
    sourceReferencedIds: [
      'rId1',
      'rId2',
      'rId3',
      'rId6',
      'rId7',
      'rId8',
      'rId10',
      'rId11',
      'rId12',
    ],
  },
  {
    label: 'all source ids',
    files: resourceFiles('<w:p/>'),
    documentPath: 'word/document.xml',
    sourceReferencedIds: [],
  },
  {
    label: 'diagram data referenced',
    files: resourceFiles(DRAWING('rId6')),
    documentPath: 'word/document.xml',
  },
  {
    label: 'diagram drawing alone',
    files: resourceFiles(DRAWING('rId7')),
    documentPath: 'word/document.xml',
  },
  {
    label: 'shared media in a header',
    files: resourceFiles(DRAWING('rId2')),
    documentPath: 'word/document.xml',
  },
  { label: 'missing document', files: resourceFiles('<w:p/>'), documentPath: 'word/other.xml' },
  {
    label: 'no rels',
    files: BASE.filter(([name]) => name !== 'word/_rels/document.xml.rels'),
    documentPath: 'word/document.xml',
  },
  {
    label: 'odd targets',
    files: resourceFiles('<w:p/>', [
      ['rId1', `${T}/image`, '/word/media/image1.png'],
      ['rId2', `${T}/image`, 'media%2Fimage2.png'],
      ['rId3', `${T}/chart`, 'charts/../charts/chart1.xml#frag'],
      ['rId4', `${T}/image`, 'media/image%ZZ.png'],
      ['rId5', `${T}/image`, 'http://example.com/a.png'],
      ['rId6', `${T}/diagramDrawing`, 'diagrams/other.xml'],
      ['rId7', `${T}/image`, ''],
    ]),
    documentPath: 'word/document.xml',
  },
  {
    label: 'no content types',
    files: resourceFiles('<w:p/>').filter(([name]) => name !== '[Content_Types].xml'),
    documentPath: 'word/document.xml',
  },
]

// zips

const FIXED = new Date('2024-01-02T03:04:05Z')

async function zipBytes(
  files: Array<[string, string]>,
  options: { streamFiles?: boolean; compress?: boolean } = {},
): Promise<number[]> {
  const zip = new JSZip()
  for (const [name, text] of files) zip.file(name, text, { date: FIXED })
  return Array.from(
    await zip.generateAsync({
      type: 'uint8array',
      streamFiles: options.streamFiles ?? false,
      compression: options.compress ? 'DEFLATE' : 'STORE',
    }),
  )
}

const HASH_A = 'a'.repeat(64)
const HASH_B = `${'0123456789abcdef'.repeat(4)}`
const placeholder = (hash: string): string => `SEUOFFICE-LAZY-MEDIA\n${hash}\n`

const MEDIA = 'M'.repeat(5000)

const ZIPS: Array<{
  label: string
  files: Array<[string, string]>
  options?: { streamFiles?: boolean; compress?: boolean }
}> = [
  {
    label: 'plain',
    files: [
      ['a.txt', 'hello'],
      ['b/c.txt', 'world'],
    ],
  },
  {
    label: 'deflate',
    files: [
      ['a.txt', 'hello '.repeat(200)],
      ['word/media/image1.png', MEDIA],
    ],
    options: { compress: true },
  },
  {
    label: 'descriptors',
    files: [
      ['a.txt', 'hello'],
      ['word/media/image1.png', MEDIA],
    ],
    options: { streamFiles: true, compress: true },
  },
  {
    label: 'folders',
    files: [
      ['d/', ''],
      ['d/e.txt', 'x'],
      ['é.txt', 'unicode name'],
    ],
  },
  {
    label: 'media',
    files: [
      ['word/document.xml', '<w:document/>'],
      ['word/media/image1.png', MEDIA],
      ['word/media/photo.JPG', MEDIA],
      ['word/media/vector.emf', MEDIA],
      ['word/media/small.gif', 'g'],
      ['word/media/sp ace.png', MEDIA],
      ['word/media/empty.png', ''],
    ],
  },
  { label: 'empty', files: [] },
  {
    label: 'placeholders',
    files: [
      ['a.txt', 'a'],
      ['word/media/image1.png', placeholder(HASH_A)],
      ['word/media/image2.png', placeholder(HASH_A)],
      ['word/media/image3.png', placeholder(HASH_B)],
      ['word/media/fake.png', placeholder(HASH_A.toUpperCase())],
    ],
  },
]

const zips = await Promise.all(
  ZIPS.map(async (z) => ({ ...z, bytes: await zipBytes(z.files, z.options) })),
)
const byLabel = (label: string): number[] => zips.find((z) => z.label === label)!.bytes

const concat = (...parts: number[][]): number[] => parts.flat()
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const u16 = (n: number): number[] => [n & 255, (n >>> 8) & 255]

/** a one-entry archive with the given central directory fields, for the readers' refusals */
function crafted(fields: {
  flags?: number
  method?: number
  usize?: number
  csize?: number
  offset?: number
  count?: number
  cdOffsetShift?: number
  sigCentral?: number
  zip64Locator?: boolean
  name?: string
}): number[] {
  const name = [...Buffer.from(fields.name ?? 'a.txt')]
  const data = [...Buffer.from('hello')]
  const local = concat(
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(5),
    u32(5),
    u16(name.length),
    u16(0),
    name,
    data,
  )
  const central = concat(
    u32(fields.sigCentral ?? 0x02014b50),
    u16(20),
    u16(20),
    u16(fields.flags ?? 0),
    u16(fields.method ?? 0),
    u16(0),
    u16(0),
    u32(0),
    u32(fields.csize ?? 5),
    u32(fields.usize ?? 5),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(fields.offset ?? 0),
    name,
  )
  const locator = fields.zip64Locator ? concat(u32(0x07064b50), u32(0), u32(0), u32(1)) : []
  const cdOffset = local.length + (fields.cdOffsetShift ?? 0) + locator.length * 0
  const eocd = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(fields.count ?? 1),
    u16(fields.count ?? 1),
    u32(central.length),
    u32(cdOffset),
    u16(0),
  )
  return concat(local, central, locator, eocd)
}

const CRAFTED: Array<{ label: string; bytes: number[] }> = [
  { label: 'ok', bytes: crafted({}) },
  { label: 'encrypted', bytes: crafted({ flags: 1 }) },
  { label: 'utf8 flag', bytes: crafted({ flags: 0x800, name: 'ü.txt' }) },
  { label: 'latin1 name', bytes: crafted({ name: 'ü.txt' }) },
  { label: 'zip64 size', bytes: crafted({ usize: 0xffffffff }) },
  { label: 'zip64 count', bytes: crafted({ count: 0xffff }) },
  { label: 'bad central signature', bytes: crafted({ sigCentral: 1 }) },
  { label: 'cd offset past end', bytes: crafted({ cdOffsetShift: 1000 }) },
  { label: 'csize past end', bytes: crafted({ csize: 100000 }) },
  { label: 'count too high', bytes: crafted({ count: 3 }) },
  { label: 'too big', bytes: crafted({ usize: 600 * 1024 * 1024 }) },
  { label: 'local offset past end', bytes: crafted({ offset: 100000 }) },
  { label: 'local offset not a header', bytes: crafted({ offset: 10 }) },
  { label: 'zip64 locator', bytes: crafted({ zip64Locator: true }) },
  { label: 'empty bytes', bytes: [] },
  { label: 'short bytes', bytes: [80, 75, 5, 6] },
  { label: 'garbage', bytes: Array.from({ length: 100 }, (_, i) => (i * 7) & 255) },
]

const WRITE_ENTRIES = [
  {
    meta: {
      name: 'a.txt',
      nameBytes: [...Buffer.from('a.txt')],
      flags: 0x808,
      method: 0,
      time: 1,
      date: 2,
      crc: 3,
      csize: 5,
      usize: 5,
      verMade: 20,
      verNeed: 20,
      intAttr: 0,
      extAttr: 0,
    },
    data: [...Buffer.from('hello')],
  },
  {
    meta: {
      name: 'dir/',
      nameBytes: [...Buffer.from('dir/')],
      flags: 0,
      method: 0,
      time: 0,
      date: 0,
      crc: 0,
      csize: 0,
      usize: 0,
      verMade: 0,
      verNeed: 10,
      intAttr: 1,
      extAttr: 16,
    },
    data: [],
  },
]

// ---------------------------------------------------------------- the specs

const mapOf = (pairs: Array<[string, string]> | undefined): Map<string, string> | undefined =>
  pairs === undefined ? undefined : new Map(pairs)

/** the original zip entries as the TS side reads them: a Buffer is its bytes */
const jsonEntry = (entry: Record<string, unknown>): Record<string, unknown> => ({
  ...entry,
  nameBytes: [...(entry.nameBytes as Buffer)],
})

const TS_ZIPFILE = async (bytes: number[]): Promise<ZipFile> => {
  const buf = Buffer.from(bytes)
  const src = bufferSource(buf)
  const entries = new Map<string, ZipEntry>()
  for (const e of await readZipEntries(src)) entries.set(e.name, e)
  return { ...src, entries, close: async () => {} }
}

export const SAVE_PARTS: CallSpec[] = [
  // ------------------------------------------------------------ settings.xml
  {
    fn: 'save.settingsChildRank',
    call: (text) => call('settingsChildRank')(text),
    built: [
      { text: 'writeProtection' },
      { text: 'view' },
      { text: 'zoom' },
      { text: 'documentProtection' },
      { text: 'listSeparator' },
      { text: 'decimalSymbol' },
      { text: 'unknown' },
      { text: '' },
      { text: 'w:zoom' },
      { text: 'constructor' },
      { text: 'ZOOM' },
    ],
    mutation: 'none',
  },
  {
    fn: 'save.insertSettingsChild',
    call: (text, args) => call('insertSettingsChild')(text, args.localName, args.childXml),
    fromDocument: partOf('word/settings.xml', () => ({
      localName: 'removePersonalInformation',
      childXml: '<w:removePersonalInformation/>',
    })),
    built: [
      ...[
        'zoom',
        'writeProtection',
        'trackRevisions',
        'documentProtection',
        'listSeparator',
        'unknown',
        'mirrorMargins',
        'view',
        'evenAndOddHeaders',
      ].flatMap((localName) =>
        SETTINGS_SAMPLES.map((text): Input => ({
          text,
          args: { localName, childXml: `<w:${localName}/>` },
        })),
      ),
    ],
  },
  {
    fn: 'save.applySettingsFlag',
    call: (text, args) => call('applySettingsFlag')(text, args.tag, args.on),
    fromDocument: partOf('word/settings.xml', () => ({ tag: 'w:mirrorMargins', on: true })),
    built: FLAG_TAGS.flatMap((tag) =>
      BOOLS.flatMap((on) => SETTINGS_SAMPLES.map((text): Input => ({ text, args: { tag, on } }))),
    ),
  },
  {
    fn: 'save.applyEvenAndOddHeaders',
    call: (text, args) => call('applyEvenAndOddHeaders')(text, args.on),
    fromDocument: partOf('word/settings.xml', () => ({ on: true })),
    built: BOOLS.flatMap((on) => SETTINGS_SAMPLES.map((text): Input => ({ text, args: { on } }))),
  },
  {
    fn: 'save.applyPageColor',
    call: (text, args) => call('applyPageColor')(text, args.color ?? null),
    fromDocument: partOf('word/document.xml', () => ({ color: 'FFEEDD' })),
    built: [
      ...[null, 'FF0000', '', 'a"b<c'].flatMap((color) =>
        [
          DOC('<w:p/>'),
          `${DECL}<w:document xmlns:w="${W}"><w:background w:color="00FF00"/><w:body/></w:document>`,
          `${DECL}<w:document xmlns:w="${W}"><w:background w:color="00FF00" w:themeColor="x"><v:background xmlns:v="urn:v" id="bg"><v:fill/></v:background></w:background><w:body/></w:document>`,
          `${DECL}<w:document xmlns:w="${W}" w:note="a>b"><w:body/></w:document>`,
          `${DECL}<w:document xmlns:w="${W}"/>`,
          `<w:wrong/>`,
          '',
        ].map((text): Input => ({ text, args: color === null ? {} : { color } })),
      ),
    ],
  },
  {
    fn: 'save.applyProtection',
    call: (text, args) => call('applyProtection')(text, args.protection ?? null),
    fromDocument: partOf('word/settings.xml', () => ({
      protection: { edit: 'readOnly', enforced: true, ...SHA },
    })),
    built: [
      null,
      { edit: 'readOnly', enforced: true },
      { edit: 'forms', enforced: false },
      { edit: 'comments', enforced: true, ...SHA },
      { edit: 'a"b', enforced: true, hash: 'h"h', salt: 's<s' },
      { edit: 'trackedChanges', enforced: true, hash: 'aGFzaA==' },
      { edit: 'readOnly', enforced: true, hash: 'x', spinCount: 5, algorithmSid: 1 },
      { edit: 'readOnly', enforced: true, hash: '' },
      { edit: 'readOnly', enforced: true, spinCount: 0, algorithmSid: 0, hash: 'x' },
    ].flatMap((protection) =>
      SETTINGS_SAMPLES.map((text): Input => ({
        text,
        args: protection === null ? {} : { protection },
      })),
    ),
  },
  {
    fn: 'save.applyWriteProtection',
    call: (text, args) => call('applyWriteProtection')(text, args.writeProtection ?? null),
    fromDocument: partOf('word/settings.xml', () => ({ writeProtection: { recommended: true } })),
    built: [
      null,
      {},
      { recommended: true },
      { recommended: false },
      { hash: 'aGFzaA==', salt: 'c2FsdA==' },
      { recommended: true, ...SHA },
      { hash: 'a"b', salt: '', spinCount: 7, algorithmSid: 3 },
      { recommended: false, hash: '' },
    ].flatMap((writeProtection) =>
      SETTINGS_SAMPLES.map((text): Input => ({
        text,
        args: writeProtection === null ? {} : { writeProtection },
      })),
    ),
  },
  {
    fn: 'save.applyRemovePersonalInfo',
    call: (text, args) => call('applyRemovePersonalInfo')(text, args.on),
    fromDocument: partOf('word/settings.xml', () => ({ on: true })),
    built: BOOLS.flatMap((on) => SETTINGS_SAMPLES.map((text): Input => ({ text, args: { on } }))),
  },
  // ------------------------------------------------------------ the scrub
  {
    fn: 'save.opaqueMarkupEnd',
    call: (text, args) => call('opaqueMarkupEnd')(text, args.start),
    built: OPAQUE_SAMPLES.map(({ text, start }): Input => ({ text, args: { start } })),
    mutation: 'none',
  },
  {
    fn: 'save.xmlTagEnd',
    call: (text, args) => call('xmlTagEnd')(text, args.start),
    built: TAG_SAMPLES.map(({ text, start }): Input => ({ text, args: { start } })),
    mutation: 'none',
  },
  {
    fn: 'save.namespacePrefixes',
    call: (text, args) => call('namespacePrefixes')(text, args.namespaces),
    fromDocument: eachPart(
      (name) =>
        name === 'word/document.xml' || name === 'word/comments.xml' || name === 'word/people.xml',
      () => ({ namespaces: [W, 'http://purl.oclc.org/ooxml/wordprocessingml/main'] }),
    ),
    built: [
      ...XML_SAMPLES.flatMap((text): Input[] => [
        { text, args: { namespaces: [W] } },
        {
          text,
          args: {
            namespaces: [
              'http://schemas.microsoft.com/office/word/2012/wordml',
              'http://purl.org/dc/elements/1.1/',
            ],
          },
        },
        { text, args: { namespaces: [] } },
      ]),
      {
        text: `<a xmlns:p="${W}" xmlns:p="${W}" xmlns:q='${W}' xmlns = "${W}" xmlns:x=  "urn:x"/>`,
        args: { namespaces: [W] },
      },
      { text: `<a  xmlns:p="${W}" b:xmlns:q="${W}" xmlnsx="${W}"/>`, args: { namespaces: [W] } },
    ],
  },
  {
    fn: 'save.mapXmlStartTags',
    call: (text, args) => {
      const rewrite =
        args.rewrite === 'upper'
          ? (tag: string) => tag.toUpperCase()
          : args.rewrite === 'underscore'
            ? (tag: string) => tag.replace(/ /g, '_')
            : (tag: string) => tag
      return call('mapXmlStartTags')(text, rewrite)
    },
    built: [
      ...[
        ...XML_SAMPLES,
        '<a b="x>y">t</a><!-- <c d="e"> -->',
        '<a',
        '<!DOCTYPE a [<!ENTITY e "x">]><a b="c d"/>',
        'plain text only',
        '<a/><b c="1 2"/>é<é a="😀 b"/>',
      ].flatMap((text): Input[] =>
        ['upper', 'underscore', 'identity'].map((rewrite) => ({ text, args: { rewrite } })),
      ),
    ],
  },
  {
    fn: 'save.replaceQualifiedAttributes',
    call: (text, args) =>
      call('replaceQualifiedAttributes')(text, args.prefixes, args.replacements),
    built: XML_SAMPLES.flatMap((text): Input[] => [
      { text, args: { prefixes: ['w'], replacements: { author: 'Author', initials: 'A' } } },
      { text, args: { prefixes: ['', 'w15', 'v'], replacements: { author: 'X' } } },
      { text, args: { prefixes: [''], replacements: { author: 'X' } } },
      { text, args: { prefixes: ['w'], replacements: { 'a.b': 'x', '1': 'one', author: '$&' } } },
    ]),
  },
  {
    fn: 'save.replaceUnqualifiedAttributes',
    call: (text, args) => call('replaceUnqualifiedAttributes')(text, args.replacements),
    built: XML_SAMPLES.flatMap((text): Input[] => [
      { text, args: { replacements: { author: 'Author', initials: 'A' } } },
      { text, args: { replacements: { id: '0' } } },
      { text, args: { replacements: { 'a+b': 'x(y)' } } },
    ]),
  },
  {
    fn: 'save.clearQualifiedElements',
    call: (text, args) => call('clearQualifiedElements')(text, args.namespaces, args.localNames),
    fromDocument: partOf('docProps/core.xml', () => ({
      namespaces: ['http://purl.org/dc/elements/1.1/'],
      localNames: ['creator'],
    })),
    built: [
      ...[
        CORE,
        APP,
        PEOPLE,
        '<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"/>',
        `<r xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>a</dc:creator><dc:creator>b</dc:creator><dc:creator/><dc:creator>c`,
        `<r xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:e="http://purl.org/dc/elements/1.1/"><dc:creator a="x>y">a</dc:creator ><e:creator>b</e:creator></r>`,
        `<r xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Manager>m</Manager><Company> c </Company><Managers>x</Managers></r>`,
      ].flatMap((text): Input[] => [
        {
          text,
          args: { namespaces: ['http://purl.org/dc/elements/1.1/'], localNames: ['creator'] },
        },
        {
          text,
          args: {
            namespaces: ['http://schemas.openxmlformats.org/package/2006/metadata/core-properties'],
            localNames: ['lastModifiedBy'],
          },
        },
        {
          text,
          args: {
            namespaces: [
              'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
              'http://purl.oclc.org/ooxml/officeDocument/extendedProperties',
            ],
            localNames: ['Manager', 'Company'],
          },
        },
        { text, args: { namespaces: [], localNames: ['creator'] } },
        { text, args: { namespaces: ['http://purl.org/dc/elements/1.1/'], localNames: [] } },
      ]),
    ],
  },
  {
    fn: 'save.scrubWordprocessingMetadata',
    call: (text) => call('scrubWordprocessingMetadata')(text),
    fromDocument: eachPart(
      (name) =>
        isXml(name) &&
        /^word\/(document|comments|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(name),
    ),
    built: XML_SAMPLES.map((text): Input => ({ text })),
  },
  {
    fn: 'save.scrubPeopleMetadata',
    call: (text) => call('scrubPeopleMetadata')(text),
    fromDocument: partOf('word/people.xml'),
    built: [
      ...XML_SAMPLES,
      `<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:p="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person a="1"/><p:person><x/></p:person><w15:personx/></w15:people>`,
    ].map((text): Input => ({ text })),
  },
  {
    fn: 'save.scrubPersonalMetadata',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      await call('scrubPersonalMetadata')(zip)
      return partsOf(zip)
    },
    fromDocument: (parts) => [{ args: { parts: smallParts(parts) } }],
    built: [
      {
        args: {
          parts: withFiles([
            ['word/comments.xml', COMMENTS_WITH_AUTHORS],
            ['word/people.xml', PEOPLE],
            ['docProps/core.xml', CORE],
            ['docProps/app.xml', APP],
            [
              'docProps/custom.xml',
              `<Properties><property name="a" w:author="keep"/></Properties>`,
            ],
            ['customXml/item1.xml', `<w:x xmlns:w="${W}" w:author="keep"/>`],
            ['word/header1.xml', `<w:hdr xmlns:w="${W}"><w:ins w:author="Ann"/></w:hdr>`],
            ['word/media/image1.png', 'binary'],
            ['word/notes.XML', `<w:x xmlns:w="${W}" w:author="Ann"/>`],
            ['dir/', ''],
          ]),
        },
      },
      {
        args: {
          parts: withFiles([
            ['word/comments.xml', DEFAULT_NS_COMMENTS],
            ['docProps/core.xml', CORE.replace('<dc:creator>Ann</dc:creator>', '<dc:creator/>')],
          ]),
        },
      },
      { args: { parts: [] } },
    ],
    mutation: 'none',
  },
  {
    fn: 'save.regexEscape',
    call: (text) => call('regexEscape')(text),
    // the TypeScript does not escape `/`, the shared jscompat::regex_escape does (the same pattern)
    built: ['a.b', 'a+b*c?', '(x)[y]{z}', '^$|\\', 'plain', '', 'w:p', 'a-b', 'é😀'].map(
      (text): Input => ({ text }),
    ),
    mutation: 'none',
  },
  // ------------------------------------------------------------ header and footer parts
  {
    fn: 'save.headerFooterPartXml',
    call: (text, args) =>
      call('headerFooterPartXml')(
        text,
        args.hf,
        args.watermarkXml,
        args.originalXml ?? null,
        args.pageCount,
      ),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => /^word\/(header|footer)\d*\.xml$/.test(name))
        .flatMap(([name, xml]): Input[] => {
          const kind = name.includes('footer') ? 'footer' : 'header'
          return [
            { text: kind, args: { hf: { text: 'Page #', pageNumber: true }, originalXml: xml } },
            {
              text: kind,
              args: { hf: { text: '', paras: [{ runs: [run('Replaced')] }] }, originalXml: xml },
            },
            {
              text: kind,
              args: {
                hf: { text: `${PAGE}`, paras: [{ runs: [run(`${PAGE} / ${TOTAL}`)] }] },
                originalXml: xml,
                pageCount: 3,
              },
            },
          ]
        }),
    built: hfInputs(),
    argMutation: true,
  },
  {
    fn: 'save.withWatermarkNs',
    call: (text) => call('withWatermarkNs')(text),
    built: [
      `<w:hdr xmlns:w="${W}">`,
      `<w:hdr xmlns:w="${W}" xmlns:r="${R}" xmlns:v="urn:schemas-microsoft-com:vml">`,
      `<w:hdr xmlns:w="${W}" xmlns:v='x' xmlns:o="y" xmlns:w10="z" xmlns:r="q">`,
      `<w:hdr xmlns:w="${W}"/>`,
      '<w:hdr>',
      '',
      '<w:hdr xmlns:w10 = "z">',
      `<w:hdr xmlns:w="${W}" xmlns:rr="x">`,
    ].map((text): Input => ({ text })),
  },
  {
    fn: 'save.hfOriginalXml',
    call: (_text, args) => call('hfOriginalXml')(args.hf, args.originalXml ?? null),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => /^word\/(header|footer)\d*\.xml$/.test(name))
        .map(([, xml]): Input => ({ args: { hf: { text: 'x' }, originalXml: xml } })),
    built: [
      { hf: { text: '' } },
      { hf: { text: '' }, originalXml: REVISED_PART },
      { hf: { text: '' }, originalXml: '' },
      { hf: { text: '', revisionsResolved: [] }, originalXml: REVISED_PART },
      {
        hf: { text: '', revisionsResolved: [{ mode: 'accept', filter: { ids: ['1'] } }] },
        originalXml: REVISED_PART,
      },
      {
        hf: {
          text: '',
          revisionsResolved: [
            { mode: 'reject', filter: { ids: ['2'] } },
            { mode: 'reject', filter: { ids: ['1'] } },
          ],
        },
        originalXml: REVISED_PART,
      },
      {
        hf: { text: '', revisionsResolved: [{ mode: 'accept', filter: { ids: ['99'] } }] },
        originalXml: REVISED_PART,
      },
      {
        hf: { text: '', revisionsResolved: [{ mode: 'accept', filter: { ids: ['1'] } }] },
        originalXml: null,
      },
    ].map((args): Input => ({ args })),
    mutation: 'none',
  },
  {
    fn: 'save.patchWatermarkInPart',
    call: (text, args) => call('patchWatermarkInPart')(text, args.watermarkXml),
    fromDocument: eachPart(
      (name) => /^word\/header\d*\.xml$/.test(name),
      () => ({ watermarkXml: WATERMARK_XMLS[2] }),
    ),
    built: ORIGINALS.flatMap((text): Input[] =>
      WATERMARK_XMLS.map((watermarkXml) => ({
        text: text ?? '',
        args: { watermarkXml: watermarkXml ?? '' },
      })),
    ),
  },
  {
    fn: 'save.removeHfReference',
    call: (text, args) => call('removeHfReference')(text, args.kind, args.variant),
    fromDocument: eachPart(
      (name) => name === 'word/document.xml',
      () => ({ kind: 'header', variant: 'default' }),
    ),
    built: (() => {
      const SECT = [
        `<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:headerReference w:type="first" r:id="rId2"/><w:headerReference w:type="even" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:pgSz/></w:sectPr>`,
        `<w:sectPr><w:headerReference r:id="rId1"/><w:headerReference w:type="odd" r:id="rId2"/><w:headerReference w:type='first' r:id="rId3"/></w:sectPr>`,
        `<w:sectPr><w:headerReference w:type="" r:id="rId1"/><w:headerReference w:type='' r:id="rId2"/><w:headerReference w:type="DEFAULT"/></w:sectPr>`,
        `<w:sectPr><w:headerReference w:type="default" r:id="rId1"></w:headerReference></w:sectPr>`,
        `<w:sectPr/>`,
        '',
      ]
      return SECT.flatMap((text) =>
        KINDS.flatMap((kind) =>
          ['default', 'first', 'even'].map((variant): Input => ({ text, args: { kind, variant } })),
        ),
      )
    })(),
  },
  // ------------------------------------------------------------ comments
  {
    fn: 'save.buildCommentsXml',
    call: (_text, args) =>
      call('buildCommentsXml')(
        args.comments,
        args.originalXml ?? null,
        mapOf(args.imageRuns as Array<[string, string]> | undefined),
        mapOf(args.keptImageRuns as Array<[string, string]> | undefined),
      ),
    fromDocument: (parts) => {
      const xml = parts.get('word/comments.xml')
      if (xml === undefined) return []
      const comments: Array<Record<string, unknown>> = []
      for (const m of xml.match(/<w:comment\s[^>]*>[\s\S]*?<\/w:comment>/g) ?? []) {
        const id = /w:id="([^"]+)"/.exec(m)?.[1]
        if (!id) continue
        comments.push({
          id,
          author: /w:author="([^"]*)"/.exec(m)?.[1] ?? '',
          text: (call('commentPlainText')(m) as string) + '!',
        })
      }
      return [
        { args: { comments, originalXml: xml } },
        {
          args: {
            comments: comments.map((c) => ({ ...c, text: String(c.text).slice(0, -1) })),
            originalXml: xml,
          },
        },
      ]
    },
    built: [
      ...[COMMENTS_ORIGINAL, COMMENTS_NO_NS, null, '', 'not xml'].flatMap((originalXml) =>
        COMMENT_SETS.map((comments): Input => ({
          args: { comments, ...(originalXml === null ? {} : { originalXml }) },
        })),
      ),
      // hidden from AI: every spelling of the mark and every tag mutation, each comment with the edits a person can make
      ...COMMENT_PARTS.flatMap((originalXml): Input[] => {
        const entries = commentEntries(originalXml).slice(0, 2)
        return entries.flatMap(({ id, xml }) =>
          editsOf(call('commentPlainText')(xml) as string).map((text) => ({
            args: {
              comments: [
                { id, author: 'Kim', text },
                { id: '99', author: 'Kim', text: 'new' },
              ],
              originalXml,
            },
          })),
        )
      }),
      ...IMAGE_RUNS.flatMap((imageRuns): Input[] =>
        [COMMENT_SETS[2]!, COMMENT_SETS[3]!, COMMENT_SETS[5]!].flatMap((comments) =>
          [undefined, [['0', '<w:r><w:t>kept</w:t></w:r>']] as Array<[string, string]>].map(
            (keptImageRuns): Input => ({
              args: {
                comments,
                originalXml: COMMENTS_ORIGINAL,
                ...(imageRuns ? { imageRuns } : {}),
                ...(keptImageRuns ? { keptImageRuns } : {}),
              },
            }),
          ),
        ),
      ),
    ],
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.buildCommentsExtendedXml',
    call: (_text, args) => call('buildCommentsExtendedXml')(args.comments),
    built: COMMENT_SETS.map((comments): Input => ({ args: { comments } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.commentPlainText',
    call: (text) => call('commentPlainText')(text),
    fromDocument: (parts) => {
      const xml = parts.get('word/comments.xml')
      return xml === undefined
        ? []
        : (xml.match(/<w:comment\s[^>]*>[\s\S]*?<\/w:comment>/g) ?? []).map((text): Input => ({
            text,
          }))
    },
    built: [
      COMMENTS_ORIGINAL,
      '',
      '<w:p/>',
      '<w:p w:x="1"/><w:p><w:r><w:t>a</w:t></w:r></w:p>',
      '<w:p><w:r><w:t xml:space="preserve"> a &lt;b&gt; &amp;amp; &quot;q&quot; &apos;s&apos; </w:t></w:r><w:r><w:t>c</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>&#65;&amp;lt;</w:t></w:r></w:p>',
      '<w:pPr/><w:p><w:pPr/><w:r><w:t/></w:r></w:p><w:p>',
      '<w:p><w:r><w:tab/><w:t>x</w:t><w:t>y</w:t></w:r></w:p><w:p></w:p>',
      '<w:pp>text</w:pp><w:p>a</w:p>',
      '<w:p><w:r><w:t>é 😀</w:t></w:r></w:p>',
      // a comment as the parser reads it: marks, CDATA, a comment faking an end tag
      ...COMMENT_PARTS.flatMap((part) => entrySlices(part, 'w:comment')),
    ].map((text): Input => ({ text })),
  },
  {
    fn: 'save.removeDeletedCommentMarkers',
    call: (text, args) =>
      call('removeDeletedCommentMarkers')(text, new Set(args.liveIds as string[])),
    fromDocument: (parts) => {
      const xml = parts.get('word/document.xml')
      if (xml === undefined) return []
      const ids = [
        ...new Set(
          [...xml.matchAll(/<w:commentRangeStart\b[^>]*\bw:id="([^"]*)"/g)].map((m) => m[1]!),
        ),
      ]
      return [
        { text: xml, args: { liveIds: [] } },
        { text: xml, args: { liveIds: ids } },
        { text: xml, args: { liveIds: ids.slice(0, 1) } },
      ]
    },
    built: (() => {
      const BODY = `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>a</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p><w:p><w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id='1'/><w:r><w:commentReference w:id='1'/></w:r></w:p><w:commentRangeStart w:id=" 2"/>`
      return [
        BODY,
        `<w:commentRangeStart w:id="0"></w:commentRangeStart><w:commentRangeEnd w:id="0">  </w:commentRangeEnd ><w:commentReference w:id="0"> </w:commentReference>x<w:commentRangeStart w:id="0"> t </w:commentRangeStart>`,
        `<!-- <w:commentRangeStart w:id="0"/> --><![CDATA[<w:commentRangeStart w:id="0"/>]]><?pi <w:commentReference w:id="0"/>?><w:commentRangeStart w:id="0"/>`,
        `<w:commentRangeStart w:id="0" w:x="a>b"/><w:commentRangeStart w:note="a>b" w:id="0"/><w:commentRangeStart/><w:commentRangeStartX w:id="0"/><w:commentReference  w:id = "0" />`,
        `<w:commentRangeStart w:id="0"`,
        'plain text é 😀 <w:commentRangeStart w:id="0"/>',
        '',
        `<w:p><w:r><w:t>no markers</w:t></w:r></w:p>`,
        `<w:commentRangeStart w:id="7"/><w:commentRangeEnd w:id="7"/>`,
      ].flatMap((text): Input[] => [
        { text, args: { liveIds: [] } },
        { text, args: { liveIds: ['0', '7'] } },
        { text, args: { liveIds: ['1'] } },
      ])
    })(),
  },
  // ------------------------------------------------------------ style-upsert.ts
  {
    fn: 'save.mergeStyleXml',
    call: (_text, args) =>
      mergeStyleXml((args.existing as string | null | undefined) ?? null, args.up as StyleUpsert),
    fromDocument: (parts) => {
      const xml = parts.get('word/styles.xml')
      if (xml === undefined) return []
      const styles = (xml.match(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g) ?? []).slice(0, 12)
      return styles.flatMap((existing): Input[] =>
        [
          { styleId: 'X', name: 'Renamed', pPr: { align: 'center' } },
          { styleId: 'X', rPr: { bold: true, font: 'Arial' }, basedOn: null },
        ].map((up) => ({ args: { existing, up } })),
      )
    },
    built: [
      ...UPSERTS.map((up): Input => ({ args: { up } })),
      ...[
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/><w:ind w:left="720" w:hanging="360"/><w:tabs><w:tab w:val="left" w:pos="1"/></w:tabs></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="X" w:asciiTheme="majorHAnsi"/><w:sz w:val="32"/></w:rPr></w:style>`,
        `<w:style w:type="character" w:styleId="E"/>`,
        `<w:style w:type="table" w:styleId="T"><w:name w:val="T"/><w:tblPr/><w:trPr/><w:tcPr/><w:tblStylePr w:type="firstRow"/><w:uiPriority w:val="1"/><w:link w:val="L"/><w:rsid w:val="1"/></w:style>`,
        `<w:style w:type="paragraph" w:styleId='S' w:customStyle='1' w:x="a'b"><w:name w:val='S'/><w:qFormat/></w:style>`,
        `<w:style w:type="paragraph" w:styleId="S"><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:eastAsia="SimSun" w:eastAsiaTheme="minorEastAsia"/></w:rPr></w:style>`,
      ].flatMap((existing) =>
        UPSERTS.slice(0, 18).map((up): Input => ({ args: { existing, up } })),
      ),
      { args: { existing: 'not an element', up: { styleId: 'X' } } },
      { args: { existing: '<w:style w:type="paragraph"', up: { styleId: 'X' } } },
      { args: { existing: '<w:style w:type="paragraph">', up: { styleId: 'X' } } },
      { args: { existing: '', up: { styleId: 'X' } } },
    ],
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.upsertStyleXml',
    call: (text, args) => upsertStyleXml(text, args.up as StyleUpsert),
    fromDocument: partOf('word/styles.xml', () => ({
      up: { styleId: 'SeuNew', name: 'Seu new', pPr: { align: 'center' }, rPr: { bold: true } },
    })),
    built: [
      STYLES,
      STYLES_BARE,
      STYLES_NO_DEFAULTS,
      `<w:styles xmlns:w="${W}"/>`,
      'no styles',
      '',
    ].flatMap((text) => UPSERTS.map((up): Input => ({ text, args: { up } }))),
    argMutation: true,
  },
  {
    fn: 'save.mergeDefaultFontsXml',
    call: (text, args) =>
      mergeDefaultFontsXml(text, args.fonts as Parameters<typeof mergeDefaultFontsXml>[1]),
    fromDocument: partOf('word/styles.xml', () => ({
      fonts: { font: 'Arial', eastAsiaFont: 'SimSun' },
    })),
    built: [
      STYLES,
      STYLES_BARE,
      STYLES_NO_DEFAULTS,
      `${DECL}<w:styles xmlns:w="${W}" w:x="a>b"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="X" w:hAnsi="X" w:eastAsia="Y"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults><w:latentStyles/></w:styles>`,
      `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults/></w:styles>`,
      `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault/></w:docDefaults></w:styles>`,
      `<w:styles/>`,
      'no styles at all',
      '',
    ].flatMap((text) => FONT_SETS.map((fonts): Input => ({ text, args: { fonts } }))),
    argMutation: true,
  },
  {
    fn: 'save.builtInHeadingStyleUpsert',
    call: (_text, args) =>
      builtInHeadingStyleUpsert(
        args.level as number,
        args.defaultParagraphStyleId as string | undefined,
      ),
    built: [1, 2, 3, 4, 5, 6, 7, 9, 0, -1, 10, 100, 1.4, 1.5, 2.5, 0.4, 0.5].flatMap((level) =>
      [undefined, 'Normal', '', 'a"b'].map((defaultParagraphStyleId): Input => ({
        args: {
          level,
          ...(defaultParagraphStyleId === undefined ? {} : { defaultParagraphStyleId }),
        },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.pendingHeadingLevel',
    call: (text, args) => {
      const pending = args.pending as Record<string, StyleUpsert>
      const existing = args.existing as Record<
        string,
        {
          name?: string
          basedOn?: string
          headingLevel?: number
          headingLevelInherited?: boolean
          headingOutlineOff?: boolean
        }
      >
      return pendingHeadingLevel(
        text,
        (id) => (Object.hasOwn(pending, id) ? pending[id] : undefined),
        (id) => (Object.hasOwn(existing, id) ? existing[id] : undefined),
      )
    },
    built: PENDING_CASES.map(({ styleId, pending, existing }): Input => ({
      text: styleId,
      args: { pending, existing },
    })),
    mutation: 'none',
    argMutation: true,
  },
  // ------------------------------------------------------------ remove-parts.ts
  {
    fn: 'save.planRemoveParts',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      const bytes = await zip.generateAsync({ type: 'uint8array' })
      return planRemoveParts(bytes, args.options as Parameters<typeof planRemoveParts>[1])
    },
    fromDocument: (parts) => [
      { args: { parts: smallParts(parts), options: { kinds: ['customXml', 'webExtensions'] } } },
      {
        args: {
          parts: smallParts(parts),
          options: { paths: ['customXml/item1.xml', 'word/document.xml', 'docProps/app.xml'] },
        },
      },
    ],
    built: BINDING_BODIES.flatMap((body) =>
      REMOVE_OPTIONS.map((options): Input => ({ args: { parts: WITH_CUSTOM(body), options } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.applyRemoveParts',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      const plan = await applyRemoveParts(
        zip,
        args.options as Parameters<typeof applyRemoveParts>[1],
      )
      return { plan, parts: await partsOf(zip) }
    },
    fromDocument: (parts) => [
      { args: { parts: smallParts(parts), options: { kinds: ['customXml', 'webExtensions'] } } },
    ],
    built: [
      ...BINDING_BODIES.flatMap((body) =>
        REMOVE_OPTIONS.map((options): Input => ({ args: { parts: WITH_CUSTOM(body), options } })),
      ),
      { args: { parts: BASE, options: { kinds: ['customXml'] } } },
      {
        args: {
          parts: BASE.filter(([name]) => name !== 'word/document.xml'),
          options: { paths: ['word/other.xml'] },
        },
      },
      {
        args: {
          parts: withFiles(
            [
              ['customXml/item1.xml', '<a/>'],
              ['customXml/_rels/item1.xml.rels', 'not xml'],
            ],
            [['_rels/.rels', 'garbage']],
          ),
          options: { kinds: ['customXml'] },
        },
      },
    ],
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.removePartsRefusalMessage',
    call: (_text, args) =>
      removePartsRefusalMessage(args.bindings as Parameters<typeof removePartsRefusalMessage>[0]),
    built: BINDINGS.map((bindings): Input => ({ args: { bindings } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.removePartsRefusalMessageFor',
    call: (_text, args) => removePartsRefusalMessageFor(args.refusedPaths as string[]),
    built: [[], ['word/document.xml'], ['a', 'b', 'c'], ['é', '😀']].map((refusedPaths): Input => ({
      args: { refusedPaths },
    })),
    mutation: 'none',
    argMutation: true,
  },
  // ------------------------------------------------------------ resource-cleanup.ts
  {
    fn: 'save.referencedRelationshipIds',
    call: (text) => [...referencedRelationshipIds(text)].sort(),
    fromDocument: eachPart((name) => /^word\/[^/]+\.xml$/.test(name)),
    built: REF_XML.map((text): Input => ({ text })),
  },
  {
    fn: 'save.cleanupDocxOwnedResources',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      const ids = args.sourceReferencedIds as string[] | undefined
      await cleanupDocxOwnedResources(
        zip,
        args.documentPath as string,
        ids === undefined ? undefined : new Set(ids),
      )
      return partsOf(zip)
    },
    fromDocument: (parts) => [
      { args: { parts: smallParts(parts), documentPath: 'word/document.xml' } },
      {
        args: {
          parts: smallParts(parts),
          documentPath: 'word/document.xml',
          sourceReferencedIds: [],
        },
      },
    ],
    built: PARTS_VARIANTS.map(({ files, documentPath, sourceReferencedIds }): Input => ({
      args: { parts: files, documentPath, ...(sourceReferencedIds ? { sourceReferencedIds } : {}) },
    })),
    mutation: 'none',
  },
  // ------------------------------------------------------------ zip-splice.ts
  {
    fn: 'save.readZipEntries',
    call: async (_text, args) =>
      (await readZipEntries(bufferSource(Buffer.from(args.bytes as number[])))).map((e) =>
        jsonEntry(e as unknown as Record<string, unknown>),
      ),
    built: [
      ...zips.map((z): Input => ({ args: { bytes: z.bytes } })),
      ...CRAFTED.map((c): Input => ({ args: { bytes: c.bytes } })),
    ],
    mutation: 'none',
  },
  {
    fn: 'save.writeZip',
    call: (_text, args) => [
      ...writeZip(
        (args.entries as typeof WRITE_ENTRIES).map((e) => ({
          meta: { ...e.meta, nameBytes: Buffer.from(e.meta.nameBytes) },
          data: Buffer.from(e.data),
        })),
      ),
    ],
    built: [
      { entries: WRITE_ENTRIES },
      { entries: [WRITE_ENTRIES[0]] },
      { entries: [] },
      {
        entries: [
          { ...WRITE_ENTRIES[0]!, meta: { ...WRITE_ENTRIES[0]!.meta, flags: 0x800 } },
          WRITE_ENTRIES[1],
        ],
      },
    ].map((args): Input => ({ args })),
    mutation: 'none',
  },
  {
    fn: 'save.slimDocx',
    call: async (_text, args) => {
      const zip = await TS_ZIPFILE(args.bytes as number[])
      const slim = await slimDocx(zip, args.hash as string, args.minBytes as number)
      return slim === null ? null : { bytes: [...slim.bytes], lazyParts: slim.lazyParts }
    },
    built: [
      ...['media', 'plain', 'deflate', 'descriptors', 'folders', 'empty'].flatMap((label) =>
        [0, 1, 5000, 10000, 15000, 1e9].map((minBytes): Input => ({
          args: { bytes: byLabel(label), hash: HASH_A, minBytes },
        })),
      ),
      { args: { bytes: byLabel('media'), hash: 'not a hash', minBytes: 0 } },
      { args: { bytes: byLabel('media'), hash: HASH_A.toUpperCase(), minBytes: 0 } },
      { args: { bytes: byLabel('media'), hash: HASH_B, minBytes: 100 } },
    ],
    mutation: 'none',
  },
  {
    fn: 'save.lazyMediaHashesIn',
    call: async (_text, args) =>
      [...(await lazyMediaHashesIn(Buffer.from(args.bytes as number[])))].sort(),
    built: [
      ...zips.map((z): Input => ({ args: { bytes: z.bytes } })),
      ...CRAFTED.map((c): Input => ({ args: { bytes: c.bytes } })),
    ],
    mutation: 'none',
  },
  {
    fn: 'save.materializeDocx',
    call: async (_text, args) => {
      const sources = new Map(
        (args.sources as Array<[string, number[] | null]>).map(([hash, bytes]) => [hash, bytes]),
      )
      const out = await materializeDocx(Buffer.from(args.bytes as number[]), async (hash) => {
        const bytes = sources.get(hash)
        return bytes ? TS_ZIPFILE(bytes) : null
      })
      return [...out]
    },
    built: (() => {
      const originalBytes = byLabel('media')
      const sources = (...hashes: string[]): Array<[string, number[] | null]> =>
        hashes.map((hash) => [hash, originalBytes])
      return [
        { bytes: byLabel('placeholders'), sources: sources(HASH_A, HASH_B) },
        { bytes: byLabel('placeholders'), sources: sources(HASH_A) },
        {
          bytes: byLabel('placeholders'),
          sources: [
            [HASH_A, null],
            [HASH_B, originalBytes],
          ],
        },
        { bytes: byLabel('plain'), sources: [] },
        { bytes: byLabel('media'), sources: sources(HASH_A) },
        { bytes: byLabel('empty'), sources: [] },
        { bytes: CRAFTED[0]!.bytes, sources: [] },
        { bytes: CRAFTED[1]!.bytes, sources: [] },
        { bytes: byLabel('deflate'), sources: [] },
      ].map((args): Input => ({ args }))
    })(),
    mutation: 'none',
  },
]
