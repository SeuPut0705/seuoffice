// Group pptxPackage of comparison (f): zip.ts of the slides engine.
import JSZip from 'jszip'
import {
  assertZipWithinLimits,
  PackageArchive,
  PPTX_ZIP_LIMITS,
  relsPathFor,
  resolveTarget,
} from './reference/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Parts = Array<[string, string]>

/** The private constructor, as `open` calls it once the zip is read. */
const Archive = PackageArchive as unknown as new (
  entries: Map<string, Uint8Array>,
  originalHash: string,
) => PackageArchive

/** `args.parts`, then the text under `args.textPart`: that part is what mutations change. */
function archiveOf(text: string, args: Record<string, unknown>): PackageArchive {
  const encoder = new TextEncoder()
  const entries = new Map<string, Uint8Array>()
  for (const [name, part] of (args.parts ?? []) as Parts) entries.set(name, encoder.encode(part))
  if (typeof args.textPart === 'string') entries.set(args.textPart, encoder.encode(text))
  return new Archive(entries, 'gate')
}

const path = (args: Record<string, unknown>): string => args.path as string

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (...items: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
const rel = (id: string, type: string, target: string, extra = ''): string =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${extra}/>`

const PRES_RELS = 'ppt/_rels/presentation.xml.rels'
const presentation = (body: string, prefix = 'p:'): string =>
  `<${prefix}presentation xmlns:p="x" xmlns:r="y">${body}</${prefix}presentation>`

/** A deck whose chain is whole: slide → layout → master → theme. */
const DECK: Parts = [
  [
    'ppt/presentation.xml',
    presentation(
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
        '<p:sldSz cx="12192000" cy="6858000"/>',
    ),
  ],
  [
    PRES_RELS,
    rels(
      rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rId2', 'slide', 'slides/slide1.xml'),
      rel('rId3', 'slide', 'slides/slide2.xml'),
    ),
  ],
  ['ppt/slides/slide1.xml', '<p:sld><p:sp><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:sp></p:sld>'],
  [
    'ppt/slides/_rels/slide1.xml.rels',
    rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')),
  ],
  ['ppt/slides/slide2.xml', '<p:sld><p:sp><p:ph type="ctrTitle"/></p:sp></p:sld>'],
  [
    'ppt/slideMasters/slideMaster1.xml',
    '<p:sldMaster><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId2"/><p:sldLayoutId id="2" r:id="rId3"/></p:sldLayoutIdLst></p:sldMaster>',
  ],
  [
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels(
      rel('rId1', 'theme', '../theme/theme1.xml'),
      rel('rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel('rId3', 'slideLayout', '../slideLayouts/slideLayout2.xml'),
    ),
  ],
  ['ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout type="obj"/>'],
  ['ppt/slideLayouts/slideLayout2.xml', '<p:sldLayout preserve="1" type="title"/>'],
  [
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
  ],
  [
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    rels(rel('rId1', 'slideMaster', '/ppt/slideMasters/slideMaster1.xml')),
  ],
]

const without = (parts: Parts, ...names: string[]): Parts =>
  parts.filter(([name]) => !names.includes(name))
const replacing = (parts: Parts, name: string, text: string): Parts => [
  ...without(parts, name),
  [name, text],
]

/** The text of `name` as the text input, the rest as parts. */
const split = (parts: Parts, name: string, extra: Record<string, unknown> = {}): Input => ({
  text: parts.find(([n]) => n === name)?.[1] ?? '',
  args: { parts: without(parts, name), textPart: name, ...extra },
})

const RELS_TEXTS = [
  rels(
    rel('rId1', 'slide', 'a.xml'),
    rel('rId1', 'theme', 'b.xml'),
    rel('rId2', 'x', 'c', ' TargetMode="External"'),
  ),
  '<Relationships><Relationship Id="a"/><Relationship Type="t" Target="u" TargetMode=""/></Relationships>',
  '<Relationships><Relationship>7</Relationship><Relationship Id="  spaced  "/></Relationships>',
  '<Relationships>text only</Relationships>',
  '<Relationships/>',
  '<Relationships><Relationship Id="x"></Relationships>',
  '<Relationships><Relationship Id="1"/><Relationship Id="0"/><Relationship Id="b"/></Relationships>',
  '<Relationships><Relationship Id="&amp;&#65;" Target="%41"/></Relationships><Relationships/>',
  '<Other><Relationship Id="a"/></Other>',
  '',
]

const PRESENTATIONS = [
  presentation(
    '<p:sldSz cx="9906000" cy="6858000"/><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst>',
  ),
  // ledger presentation-default-namespace-slide-list: the TypeScript loses this slide
  presentation('<sldSz cx="1" cy="2"/><sldIdLst><sldId r:id="rId2"/></sldIdLst>', ''),
  presentation(
    '<p:sldSz cx="12.9e3" cy="-5"/><p:sldIdLst><p:sldId id="rId3"/><p:sldId r:id=""/><p:sldId r:id="rId9"/></p:sldIdLst>',
  ),
  presentation('<p:sldSz cx="abc"/><p:sldIdLst/>'),
  presentation('<p:sldSz/><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId2"/></p:sldIdLst>'),
  presentation(''),
  '<p:presentation/>',
  '<presentation>0</presentation>',
  '<other/>',
  '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"></p:sldIdLst></p:presentation>',
  '',
]

/** A zip of `parts` in the order given, made once: `open` reads its bytes. */
async function zipBytes(parts: Parts, options: JSZip.JSZipFileOptions = {}): Promise<number[]> {
  const zip = new JSZip()
  for (const [name, text] of parts) zip.file(name, text, options)
  return [...(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))]
}

const OPENED: Input[] = [
  { args: { bytes: await zipBytes(DECK) } },
  {
    args: {
      bytes: await zipBytes([
        ['10', 'b'],
        ['2', 'a'],
        ['dir/x.xml', '<x/>'],
        ['', 'empty name'],
      ]),
    },
  },
  { args: { bytes: await zipBytes([['a.xml', '\uFEFF<a/>']], { createFolders: true }) } },
  { args: { bytes: [80, 75, 5, 6, ...new Array<number>(18).fill(0)] } },
  { args: { bytes: [1, 2, 3] } },
]

/** A damaged deflate stream: refused by the gate before JSZip reads it. */
{
  const bytes = [...(OPENED[0]!.args!.bytes as number[])]
  bytes[60] = bytes[60]! ^ 0xff
  OPENED.push({ args: { bytes } })
}

const TARGETS: Array<[string, string]> = [
  ['ppt/slides/slide1.xml', '../slideLayouts/slideLayout1.xml'],
  ['ppt/presentation.xml', 'slides/slide1.xml'],
  ['ppt/presentation.xml', '/ppt/slides/slide1.xml'],
  ['ppt/presentation.xml', '\\ppt\\slides\\a.xml'],
  ['ppt/presentation.xml', '../../../../x.xml'],
  ['ppt/presentation.xml', 'http://example.com/a'],
  ['ppt/presentation.xml', 'C:/x.xml'],
  ['ppt/presentation.xml', 'a%20b.xml'],
  // decoded before the path is split: an escaped slash separates, escaped dots climb
  ['ppt/slides/slide1.xml', 'a%2Fb.xml'],
  ['ppt/slides/slide1.xml', '%2E%2E/media/x%2Ey.png'],
  ['ppt/slides/slide1.xml', '%5Croot.xml'],
  ['ppt/presentation.xml', '%E0%A4%A'],
  ['ppt/presentation.xml', '%ED%A0%80'],
  ['ppt/presentation.xml', './a//./b/../c.xml'],
  ['presentation.xml', 'a.xml'],
  ['', '..'],
  ['/x.xml', '1:2'],
  ['ppt/a.xml', '9abc:x'],
]

const SIZE = PPTX_ZIP_LIMITS.maxPartBytes
const declaredInputs: Array<Array<[string, boolean, number | null]>> = [
  [
    ['a', false, 10],
    ['b/', true, SIZE * 9],
  ],
  [['a', false, SIZE + 1]],
  [
    ['a', false, SIZE],
    ['b', false, SIZE],
    ['c', false, SIZE],
    ['d', false, 1],
  ],
  [
    ['a', false, SIZE],
    ['b', false, SIZE],
    ['c', false, SIZE],
    ['d', false, -5],
  ],
  [
    ['a', false, null],
    ['10', false, SIZE + 2],
    ['2', false, SIZE + 3],
  ],
  [
    ['x', false, SIZE + 5],
    ['x', false, 1],
  ],
  [],
  // the part count at its limit and one past it: a fault of `>` for `>=` passed without these
  Array.from({ length: PPTX_ZIP_LIMITS.maxParts }, (_, index): [string, boolean, number] => [
    `p${index}`,
    false,
    1,
  ]),
  Array.from({ length: PPTX_ZIP_LIMITS.maxParts + 1 }, (_, index): [string, boolean, number] => [
    `p${index}`,
    false,
    1,
  ]),
  // folders do not count
  [
    ...Array.from({ length: PPTX_ZIP_LIMITS.maxParts }, (_, index): [string, boolean, number] => [
      `p${index}`,
      false,
      1,
    ]),
    ['folder/', true, 0],
  ],
]

/** The chains a deck gives: a damaged copy of DECK for each way to lose a link. */
const CHAINS: Input[] = [
  { args: { parts: DECK, path: 'ppt/slides/slide1.xml' } },
  { args: { parts: DECK, path: 'ppt/slides/slide2.xml' } },
  {
    args: {
      parts: replacing(DECK, 'ppt/slideLayouts/slideLayout2.xml', '<p:sldLayout type="obj"/>'),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(DECK, 'ppt/slides/slide2.xml', '<p:sld/>'),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/slideMasters/slideMaster1.xml',
        '<p:sldMaster><p:sldLayoutIdLst/></p:sldMaster>',
      ),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/slideMasters/slideMaster1.xml',
        '<p:sldMaster><p:sldLayoutId r:id="rId9"/><p:sldLayoutId r:id="rId3"/></p:sldMaster>',
      ),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/presentation.xml',
        presentation('<p:sldMasterIdLst><p:sldMasterId r:id="rId9"/></p:sldMasterIdLst>'),
      ),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(DECK, 'ppt/presentation.xml', presentation('')),
      path: 'ppt/slides/slide2.xml',
    },
  },
  {
    args: {
      parts: replacing(DECK, PRES_RELS, rels(rel('rId1', 'slideMaster', 'http://x/m.xml'))),
      path: 'ppt/slides/slide2.xml',
    },
  },
  { args: { parts: without(DECK, 'ppt/presentation.xml'), path: 'ppt/slides/slide2.xml' } },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/slides/_rels/slide1.xml.rels',
        rels(
          rel('rId1', 'slideLayout', 'https://x/l.xml'),
          rel('rId2', 'slideLayout', '../slideLayouts/slideLayout2.xml'),
        ),
      ),
      path: 'ppt/slides/slide1.xml',
    },
  },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        rels(rel('rId1', 'slideMaster', 'mailto:x')),
      ),
      path: 'ppt/slides/slide1.xml',
    },
  },
  {
    args: {
      parts: replacing(
        DECK,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        rels(
          rel('rId1', 'theme', '%zz'),
          rel('rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
        ),
      ),
      path: 'ppt/slides/slide1.xml',
    },
  },
  { args: { parts: [], path: 'ppt/slides/slide1.xml' } },
  { args: { parts: DECK, path: 'ppt/slides/none.xml' } },
  // mutations reach the slide's rels through the text
  split(DECK, 'ppt/slides/_rels/slide1.xml.rels', { path: 'ppt/slides/slide1.xml' }),
  split(DECK, 'ppt/slideMasters/slideMaster1.xml', { path: 'ppt/slides/slide2.xml' }),
]

const relsTexts = (parts: ReadonlyMap<string, string>): Input[] =>
  [...parts.keys()]
    .filter((name) => name.endsWith('.rels'))
    .map((name) => ({
      text: parts.get(name)!,
      args: { textPart: name, path: name.replace(/_rels\/([^/]*)\.rels$/, '$1') },
    }))

const corpusParts = (parts: ReadonlyMap<string, string>): Parts => [...parts]

export const PACKAGE: CallSpec[] = [
  {
    fn: 'pptxPackage.open',
    // a Uint8Array crosses JSON as an object of indexes: both sides give its bytes as a list
    call: async (_text, args) => {
      const archive = await PackageArchive.open(new Uint8Array(args.bytes as number[]))
      return {
        entries: [...archive.entries].map(([name, bytes]) => [name, [...bytes]]),
        originalHash: archive.originalHash,
      }
    },
    built: OPENED,
    mutation: 'none',
  },
  {
    fn: 'pptxPackage.has',
    call: (text, args) => archiveOf(text, args).has(path(args)),
    fromDocument: (parts) => [
      { args: { parts: corpusParts(parts), path: 'ppt/presentation.xml' } },
      { args: { parts: corpusParts(parts), path: 'ppt/missing.xml' } },
    ],
    built: [
      { args: { parts: DECK, path: 'ppt/slides/' } },
      { text: '', args: { textPart: '', path: '' } },
      { args: { parts: [['constructor', 'x']], path: 'toString' } },
    ],
    mutation: 'none',
  },
  {
    fn: 'pptxPackage.readText',
    call: (text, args) => archiveOf(text, args).readText(path(args)),
    fromDocument: (parts) => [
      { text: parts.get('ppt/presentation.xml') ?? '', args: { textPart: 'p', path: 'p' } },
    ],
    built: [
      { text: '\uFEFF<a/>\u00e9', args: { textPart: 'a', path: 'a' } },
      { text: '', args: { textPart: 'a', path: 'a' } },
      { text: 'x', args: { textPart: 'a', path: 'b' } },
    ],
  },
  {
    fn: 'pptxPackage.readBytes',
    call: (text, args) => {
      const bytes = archiveOf(text, args).readBytes(path(args))
      return bytes && [...bytes]
    },
    built: [
      { text: 'h\u00e9', args: { textPart: 'a', path: 'a' } },
      { text: '', args: { textPart: 'a', path: 'a' } },
      { text: 'x', args: { textPart: 'a', path: '__proto__' } },
    ],
  },
  {
    fn: 'pptxPackage.readRels',
    call: (text, args) => archiveOf(text, args).readRels(path(args)),
    fromDocument: relsTexts,
    built: [
      ...RELS_TEXTS.map((text) => ({
        text,
        args: { textPart: 'ppt/slides/_rels/s.xml.rels', path: 'ppt/slides/s.xml' },
      })),
      { text: RELS_TEXTS[0], args: { textPart: '_rels/.rels', path: '' } },
      { text: RELS_TEXTS[0], args: { textPart: '_rels/.rels', path: 'ppt/a.xml' } },
    ],
  },
  {
    fn: 'pptxPackage.readPresentation',
    call: (text, args) => archiveOf(text, args).readPresentation(),
    fromDocument: (parts) => {
      const text = parts.get('ppt/presentation.xml')
      if (text === undefined) return []
      return [
        {
          text,
          args: {
            parts: corpusParts(parts).filter(([n]) => n !== 'ppt/presentation.xml'),
            textPart: 'ppt/presentation.xml',
          },
        },
      ]
    },
    built: [
      ...PRESENTATIONS.map((text): Input => ({
        text,
        args: {
          parts: replacing(DECK, 'ppt/presentation.xml', ''),
          textPart: 'ppt/presentation.xml',
        },
        ...(text.includes('<sldId r:id') ? { seed: false } : {}),
      })),
      split(DECK, 'ppt/presentation.xml'),
      {
        text: PRESENTATIONS[0],
        args: { parts: [[PRES_RELS, '<Relationships><']], textPart: 'ppt/presentation.xml' },
      },
      { text: PRESENTATIONS[0], args: { textPart: 'ppt/presentation.xml' } },
      { text: PRESENTATIONS[0], args: { textPart: 'ppt/other.xml' } },
    ],
  },
  {
    fn: 'pptxPackage.resolveSlideChain',
    call: (text, args) => archiveOf(text, args).resolveSlideChain(path(args)),
    fromDocument: (parts) =>
      [...parts.keys()]
        .filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name))
        .map((name) => ({ args: { parts: corpusParts(parts), path: name } })),
    built: CHAINS,
  },
  {
    fn: 'pptxPackage.relsPathFor',
    call: (text) => relsPathFor(text),
    fromDocument: (parts) => [...parts.keys()].map((text) => ({ text })),
    built: ['ppt/slides/slide1.xml', 'a.xml', '', '/a.xml', 'a/', 'a//b'].map((text) => ({ text })),
  },
  {
    fn: 'pptxPackage.resolveTarget',
    call: (text, args) => resolveTarget(args.base as string, text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => name.endsWith('.rels'))
        .flatMap(([name, xml]) =>
          [...xml.matchAll(/\bTarget="([^"]*)"/g)].map((m) => ({
            text: m[1]!,
            args: { base: name.replace(/_rels\/([^/]*)\.rels$/, '$1') },
          })),
        ),
    built: TARGETS.map(([base, text]) => ({ text, args: { base } })),
  },
  {
    fn: 'pptxPackage.assertZipWithinLimits',
    call: (_text, args) => {
      const files: Record<string, unknown> = {}
      for (const [name, dir, size] of args.files as Array<[string, boolean, number | null]>)
        files[name] = { name, dir, ...(size === null ? {} : { _data: { uncompressedSize: size } }) }
      assertZipWithinLimits({ files } as unknown as JSZip)
    },
    built: declaredInputs.map((files) => ({ args: { files } })),
    mutation: 'none',
  },
]
