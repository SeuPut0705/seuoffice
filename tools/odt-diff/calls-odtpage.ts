// Group `odtPage` of comparison (f): page/*.ts of packages/odt-engine (the
// functions whose arguments are plain data). The Rust side answers in
// crates/office-wasm/src/calls/odt_page.rs to `odtPage.<TypeScript name>`; the
// convention is at the top of calls-support.ts. Shapes particular to this group:
//
//   layoutGeometry, layoutOverrides, odfLengths   args `layout`: the OdtStyle of a page layout
//        (as `readOdtStyles` gives it: the fields `properties` is read from), absent for `undefined`;
//        `before`, `after`, `settings`: SectionSettings.
//   startTagAt, childElements   text the xml; args `prefixes` (the root attributes `[{ name, raw }]`),
//        `start` / `from`, `to`.
//   editLayoutXml, editMasterXml  args `prefixes` as above, `edit`, and `styleTag` for editMasterXml.
//   writePageExt       args `map` (`{ ext }`), `ext` (a PageExt): the `ext` of the map after the call.
//   readPageExt        args `map` (`{ ext }`).
//   (masterOf, regionsOf, titlePgOf, evenOddOf take a style or a master page record and are not in this group.)
//   stripPPrSectPr     text the pPr (`args.missing` for `undefined`).//
//   odtPage.constant   args `name`: the value of the exported constant of that name of the group (or the
//        answer of a function that takes nothing); the names are the keys of the spec at the end of this file.

import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { elementFragments } from '../docx-diff/fragments'
import { distinct, rootPrefixes, constantSpec } from './calls-support'
import { surrogateClasses } from './listed'
import * as ts from './ts'

const part = (parts: ReadonlyMap<string, string>, name: string): string | undefined =>
  parts.get(name)
const geometry = ts.pageGeometry
const odf = ts.pageOdf
const sect = ts.pageSectpr

const prefixMapOf = (list: unknown): ts.coreXml.PrefixMap =>
  new ts.coreXml.PrefixMap(
    ((list ?? []) as Array<{ name: string; raw: string }>).map((a) => ({
      name: a.name,
      raw: a.raw,
      nameStart: 0,
      valueStart: 0,
      valueEnd: 0,
    })),
  )

const STYLES = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'
const FO = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'
const PREFIXES = [
  { name: 'xmlns:style', raw: STYLES },
  { name: 'xmlns:fo', raw: FO },
  { name: 'xmlns:svg', raw: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0' },
]

const LAYOUTS: string[] = [
  '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21.000cm" fo:page-height="29.700cm" style:print-orientation="portrait" fo:margin-left="2.000cm" fo:margin-right="2.000cm" fo:margin-top="1.000cm" fo:margin-bottom="1.000cm"><style:columns fo:column-count="1"/></style:page-layout-properties><style:header-style><style:header-footer-properties svg:height="1.500cm"/></style:header-style><style:footer-style><style:header-footer-properties svg:height="1.000cm"/></style:footer-style></style:page-layout>',
  '<style:page-layout style:name="pm2"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm" style:print-orientation="landscape" fo:margin="1.5cm" style:num-format="i"><style:columns fo:column-count="2" fo:column-gap="0.5cm"/></style:page-layout-properties><style:header-style><style:header-footer-properties fo:min-height="1cm" fo:margin-bottom="0.25cm"/></style:header-style></style:page-layout>',
  '<style:page-layout style:name="pm3"><style:page-layout-properties fo:margin-top="1cm" fo:margin="3cm"/><style:footer-style><style:header-footer-properties svg:height="2cm" fo:margin-top="0.5cm"/></style:footer-style></style:page-layout>',
  '<style:page-layout style:name="pm4"/>',
  '<style:page-layout style:name="pm5"><style:page-layout-properties fo:page-width="bad" fo:page-height="1e1cm" style:num-format="1"><style:columns fo:column-count="x" fo:column-gap="1in"/></style:page-layout-properties><style:header-style/></style:page-layout>',
]

const STYLE_OF = (xml: string): Record<string, unknown> => {
  const wrapped = `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="${STYLES}" xmlns:fo="${FO}" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"><office:automatic-styles>${xml}</office:automatic-styles></office:document-styles>`
  const style = ts.coreStyles.readOdtStyles(wrapped, '').all[0]
  return style as unknown as Record<string, unknown>
}

const LAYOUT_STYLES = LAYOUTS.map(STYLE_OF)

const settings = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  pageWidth: 11906,
  pageHeight: 16838,
  orientation: 'portrait',
  marginTop: 1417,
  marginBottom: 1417,
  marginLeft: 1134,
  marginRight: 1134,
  headerDist: 567,
  footerDist: 567,
  ...extra,
})

const SETTINGS_PAIRS: Array<[Record<string, unknown>, Record<string, unknown>]> = [
  [settings(), settings()],
  [settings(), settings({ marginLeft: 1701 })],
  [
    settings(),
    settings({
      marginRight: 1134.4,
      pageWidth: 16838,
      pageHeight: 11906,
      orientation: 'landscape',
    }),
  ],
  [settings(), settings({ marginTop: 2000, headerDist: 700 })],
  [settings(), settings({ marginBottom: 100, footerDist: 5000 })],
  [settings({ headerDist: undefined }), settings({ marginTop: 3000, headerDist: undefined })],
  [settings(), settings({ marginTop: 0, marginBottom: 0, headerDist: 0, footerDist: 0 })],
  [settings(), settings({ pageWidth: 11906.4, pageHeight: 20000 })],
]

function layoutsFromDocument(
  parts: ReadonlyMap<string, string>,
): Array<Record<string, unknown> | undefined> {
  const content = part(parts, 'content.xml')
  if (content === undefined) return []
  const table = ts.coreStyles.readOdtStyles(part(parts, 'styles.xml') ?? null, content)
  return table.all.filter((s) => s.kind === 'page-layout').slice(0, 10) as unknown as Array<
    Record<string, unknown>
  >
}

const withLayout = (
  layout: Record<string, unknown> | undefined,
  rest: Record<string, unknown> = {},
): Input => ({ args: layout === undefined ? { ...rest } : { layout, ...rest } })

const PAGE_PARAS = [
  '<w:p><w:pPr><w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>x</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="a"/><w:jc w:val="left"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>',
  '<w:p w14:paraId="1"><w:pPr/></w:p>',
  '<w:p><w:pPr><w:sectPr/></w:pPr></w:p>',
  '<w:p><w:pPr><w:jc w:val="center"/><w:sectPr w:rsidR="1"><w:pgSz/></w:sectPr></w:pPr></w:p>',
  '<w:p><w:pPr></w:pPr></w:p>',
  '<w:pPr/>',
  '<w:tbl/>',
  '',
  '<w:p/>',
  '<w:p><w:pPr><w:sectPr><w:pgSz w:w="1"/></w:sectPr><w:jc w:val="left"/></w:pPr><w:r><w:t>\ud55c\uae00</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:rPr/><w:sectPr/><w:sectPr/></w:pPr></w:p>',
]

const SECT = '<w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr>'

const geo = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  width: 11906,
  height: 16838,
  landscape: false,
  top: 1417,
  bottom: 1417,
  left: 1134,
  right: 1134,
  header: 567,
  footer: 567,
  columns: 1,
  columnGap: 0,
  numFormat: null,
  ...extra,
})

const SPECS: Array<Record<string, unknown>> = [
  { references: [], continuous: false, geometry: geo(), pageNumber: {}, titlePg: false },
  {
    references: [
      '<w:headerReference w:type="default" r:id="rId1"/>',
      '<w:footerReference w:type="default" r:id="rId2"/>',
    ],
    continuous: true,
    geometry: geo({ landscape: true, columns: 3, columnGap: 360 }),
    pageNumber: { fmt: 'lowerRoman', start: 3 },
    titlePg: true,
  },
  {
    references: [],
    continuous: false,
    geometry: geo({ columns: 2, columnGap: 100 }),
    columns: { count: 4, gap: 50 },
    pageNumber: { start: 0 },
    titlePg: false,
  },
  {
    references: [],
    continuous: false,
    geometry: geo({ columns: 3 }),
    columns: { count: 1, gap: 50 },
    pageNumber: { fmt: 'decimal' },
    titlePg: true,
  },
  {
    references: ['<x/>'],
    continuous: false,
    geometry: geo({ width: 1, height: 2, top: -5 }),
    pageNumber: { fmt: '', start: undefined },
    titlePg: false,
  },
]

const EDIT_LAYOUT_TARGETS = LAYOUTS

const HF_BOX = {
  widthPx: 120,
  heightPx: 40,
  behind: false,
  posH: 'left',
  posV: 'top',
  posXPx: 4,
  posYPx: 8,
  posHRel: 'margin',
  posVRel: 'paragraph',
  wrap: 'square',
  id: 1,
  insets: [7, 4, 7, 4],
  vAlign: 'center',
  nowrap: false,
  autofit: true,
  anchorPara: 0,
  rotDeg: 0,
  borderWidthPx: 1,
  borderColor: '000000',
}
const hfPara = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  runs: [{ text: 'h' }],
  align: 'center',
  ...extra,
})

const MASTERS: string[] = [
  '<style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p>h</text:p></style:header><style:footer><text:p>f</text:p></style:footer></style:master-page>',
  '<style:master-page style:name="M2" style:page-layout-name="pm2"/>',
  '<style:master-page style:name="M3" style:display-name="Third" style:next-style-name="M3" style:page-layout-name="pm1"><style:header-first><text:p>1</text:p></style:header-first><style:footer-left><text:p>l</text:p></style:footer-left></style:master-page>',
  '<style:master-page style:name="M4" style:page-layout-name="pm1"><style:header/><style:header-left><text:p/></style:header-left><style:footer-first/></style:master-page>',
]

const MASTER_EDITS: Array<Record<string, unknown>> = [
  {},
  { name: 'New' },
  { name: 'New', layout: 'pm9' },
  { regions: { header: '<text:p>H</text:p>' } },
  { regions: { header: null, footer: '' } },
  { regions: { 'header-first': '<text:p>F</text:p>', 'footer-left': '', 'header-left': null } },
  { regions: { footer: '<text:p>x &amp; y</text:p>', 'footer-first': '<text:p/>' } },
  { name: '\ud55c\uae00', regions: { 'header-left': '<text:p>\ud83d\ude00</text:p>' } },
]

const LAYOUT_EDITS: Array<Record<string, unknown>> = [
  {},
  { name: 'pm9' },
  { page: { 'fo:margin-left': '3.000cm' } },
  {
    page: { 'fo:page-width': null, 'style:print-orientation': 'landscape' },
    header: { 'svg:height': '2cm' },
    footer: { 'svg:height': null },
  },
  { header: { 'fo:min-height': '1cm' }, footer: { 'svg:height': '0.5cm' } },
  { name: 'a&b', page: { 'fo:margin-top': '1cm', 'style:num-format': null } },
]

const pageExt = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  defaultMaster: 'Standard',
  evenAndOdd: false,
  runs: [
    {
      master: 'Standard',
      layout: 'pm1',
      startParagraph: null,
      startBlock: null,
      startStyle: null,
      startFamily: null,
      hidden: false,
      slots: { header: 'rId1' },
    },
  ],
  sections: [
    {
      run: 0,
      region: null,
      continuous: false,
      first: 0,
      last: 2,
      carrier: null,
      sectPr: '<w:sectPr/>',
    },
  ],
  parts: {
    rId1: {
      rId: 'rId1',
      path: 'word/header1.xml',
      kind: 'header',
      master: 'Standard',
      region: 'header',
      fill: 'content',
      paragraphs: [0],
      xml: '<w:hdr/>',
    },
  },
  ...extra,
})

function pageExtMap(ext: unknown): Record<string, unknown> {
  return { ext: { page: ext } }
}

export const PAGE: CallSpec[] = [
  {
    fn: 'odtPage.twipsToLength',
    call: (_t, args) => geometry.twipsToLength(args.value as number),
    built: [
      0, 1, 567, 1134, 11906, 16838, 1440, 1417, 1701, -567, 0.5, 283.46, 566.9, 1e6, 8503, 11905.5,
    ].map((value) => ({ args: { value } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.layoutGeometry',
    call: (_t, args) => geometry.layoutGeometry(args.layout as never),
    fromDocument: (parts) => layoutsFromDocument(parts).map((layout) => withLayout(layout)),
    built: [withLayout(undefined), ...LAYOUT_STYLES.map((layout) => withLayout(layout))],
    mutation: 'none',
  },
  {
    fn: 'odtPage.columnsOf',
    call: (_t, args) => geometry.columnsOf(args.cols as never),
    built: (
      [
        {},
        { 'fo:column-count': '2', 'fo:column-gap': '0.5cm' },
        { 'fo:column-count': '0' },
        { 'fo:column-count': '3x', 'fo:column-gap': '1in' },
        { 'fo:column-count': '-2' },
        { 'fo:column-gap': 'bad' },
      ] as Array<Record<string, string>>
    )
      .map((cols): Input => ({ args: { cols } }))
      .concat([{ args: {} }]),
    mutation: 'none',
  },
  {
    fn: 'odtPage.isEmptyOverrides',
    call: (_t, args) => geometry.isEmptyOverrides(args.o as never),
    built: [
      { page: {}, header: {}, footer: {} },
      { page: { a: 'b' }, header: {}, footer: {} },
      { page: {}, header: { a: null }, footer: {} },
      { page: {}, header: {}, footer: { x: 'y' } },
    ].map((o) => ({ args: { o } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.layoutOverrides',
    call: (_t, args) =>
      geometry.layoutOverrides(args.layout as never, args.before as never, args.after as never),
    fromDocument: (parts) =>
      layoutsFromDocument(parts).flatMap((layout) =>
        SETTINGS_PAIRS.slice(1, 5).map(([before, after]) => withLayout(layout, { before, after })),
      ),
    built: [undefined, ...LAYOUT_STYLES].flatMap((layout) =>
      SETTINGS_PAIRS.map(([before, after]) => withLayout(layout, { before, after })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtPage.odfLengths',
    call: (_t, args) => geometry.odfLengths(args.layout as never, args.settings as never),
    built: [undefined, ...LAYOUT_STYLES].flatMap((layout) =>
      SETTINGS_PAIRS.map(([, after]) => withLayout(layout, { settings: after })),
    ),
    mutation: 'none',
  },
  {
    fn: 'odtPage.startTagAt',
    listed: surrogateClasses,
    call: (text, args) => odf.startTagAt(text, args.start as number, prefixMapOf(args.prefixes)),
    fromDocument: (parts) => {
      const styles = part(parts, 'styles.xml')
      if (styles === undefined) return []
      const prefixes = rootPrefixes(styles)
      return distinct(
        [...styles.matchAll(/<style:[\w-]+/g)].map((m) => m.index!),
        25,
      ).map((start) => ({ text: styles, args: { start, prefixes } }))
    },
    built: [
      ['<style:a b="1"/>', 0],
      ['<style:a b="1">x', 0],
      ['x<style:a b="1">', 1],
      ['x<style:a', 1],
      ['</style:a>', 0],
      ['', 0],
      ['<a>', 5],
      ['<s:a x="&amp;">', 0],
      ["<style:a  \n x='1' >", 0],
      ['<\ud55c b="1">', 0],
    ].map(([text, start]) => ({
      text: text as string,
      args: { start, prefixes: [...PREFIXES, { name: 'xmlns:s', raw: STYLES }] },
    })),
  },
  {
    fn: 'odtPage.childElements',
    listed: surrogateClasses,
    call: (text, args) =>
      odf.childElements(text, prefixMapOf(args.prefixes), args.from as number, args.to as number),
    fromDocument: (parts) => {
      const styles = part(parts, 'styles.xml')
      if (styles === undefined) return []
      const prefixes = rootPrefixes(styles)
      return [
        ...elementFragments(styles, 'style:master-page').slice(0, 6),
        ...elementFragments(styles, 'style:page-layout').slice(0, 6),
      ].map((xml) => {
        const from = xml.indexOf('>') + 1
        return { text: xml, args: { prefixes, from, to: xml.lastIndexOf('</') } }
      })
    },
    built: [
      ['<a><b/><c>x<d/></c>t<e></e></a>', 3, 28],
      ['<a><b/><c>x<d/></c>t<e></e></a>', 0, 31],
      ['<b/><c/>', 0, 8],
      ['', 0, 0],
      ['<a>', 3, 3],
      ['<a><b></a>', 3, 6],
      ['<a>\ud55c<b/>\ud83d\ude00<c/></a>', 3, 20],
    ].map(([text, from, to]) => ({ text: text as string, args: { from, to, prefixes: [] } })),
  },
  {
    fn: 'odtPage.editLayoutXml',
    call: (text, args) => odf.editLayoutXml(text, prefixMapOf(args.prefixes), args.edit as never),
    fromDocument: (parts) => {
      const styles = part(parts, 'styles.xml')
      if (styles === undefined) return []
      const prefixes = rootPrefixes(styles)
      return elementFragments(styles, 'style:page-layout')
        .slice(0, 6)
        .flatMap((text, i) =>
          LAYOUT_EDITS.slice(i % 3, (i % 3) + 3).map((edit) => ({
            text,
            args: { prefixes, edit },
          })),
        )
    },
    built: EDIT_LAYOUT_TARGETS.flatMap((text) =>
      LAYOUT_EDITS.map((edit) => ({ text, args: { prefixes: PREFIXES, edit } })),
    ),
  },
  {
    fn: 'odtPage.editMasterXml',
    call: (text, args) =>
      odf.editMasterXml(
        text,
        prefixMapOf(args.prefixes),
        args.styleTag as string,
        args.edit as never,
      ),
    fromDocument: (parts) => {
      const styles = part(parts, 'styles.xml')
      if (styles === undefined) return []
      const prefixes = rootPrefixes(styles)
      return elementFragments(styles, 'style:master-page')
        .slice(0, 6)
        .flatMap((text, i) =>
          MASTER_EDITS.slice(i % 4, (i % 4) + 4).map((edit) => ({
            text,
            args: { prefixes, styleTag: 'style', edit },
          })),
        )
    },
    built: MASTERS.flatMap((text) =>
      MASTER_EDITS.map((edit) => ({ text, args: { prefixes: PREFIXES, styleTag: 'style', edit } })),
    ),
  },
  {
    fn: 'odtPage.readPageExt',
    call: (_t, args) => ts.pageModel.readPageExt(args.map as never),
    built: [
      { ext: {} },
      pageExtMap(pageExt()),
      pageExtMap(pageExt({ version: 2 })),
      pageExtMap(
        pageExt({ evenAndOdd: true, defaultMaster: null, runs: [], sections: [], parts: {} }),
      ),
      { ext: { table: { x: 1 } } },
    ].map((map) => ({ args: { map } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.writePageExt',
    call: (_t, args) => {
      const map = JSON.parse(JSON.stringify(args.map)) as { ext: Record<string, never> }
      ts.pageModel.writePageExt(map, args.ext as never)
      return map.ext
    },
    built: [
      [{ ext: {} }, pageExt()],
      [
        { ext: { page: pageExt({ evenAndOdd: true }), table: { a: 1 } } },
        pageExt({ defaultMaster: null }),
      ],
      [{ ext: { other: 1 } }, pageExt({ runs: [], sections: [], parts: {} })],
    ].map(([map, ext]) => ({ args: { map, ext } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.hfFormat',
    call: (_t, args) => ts.pageHf.hfFormat(args.p as never),
    fromModel: (doc) =>
      distinct(
        Object.values(doc.hfParts ?? {})
          .flatMap((hf) => (hf.paras ?? []).slice(0, 4))
          .map((p) => ({ args: { p } })),
        30,
      ),
    built: [
      hfPara(),
      hfPara({ indentLeft: 720, spaceAfter: undefined }),
      hfPara({ box: HF_BOX, frameXAlign: 'left', ptabAligns: ['left'], boxAnchored: true }),
      { runs: [] },
      hfPara({ lineSpacing: 1.5, tabStops: [{ pos: 1, val: 'left' }] }),
    ].map((p) => ({ args: { p } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.pairParagraphs',
    call: (_t, args) =>
      ts.pageHf.pairParagraphs(args.original as string[], args.edited as string[]),
    fromModel: (doc) => {
      const parts = Object.values(doc.hfParts ?? {}).map((hf) =>
        (hf.paras ?? []).map((p) => p.runs.map((r) => r.text).join('')),
      )
      return parts.slice(1).map((edited, i) => ({ args: { original: parts[i], edited } }))
    },
    built: [
      [[], []],
      [['a'], []],
      [[], ['a']],
      [
        ['a', 'b'],
        ['a', 'b'],
      ],
      [
        ['a', 'b', 'c'],
        ['a', 'c'],
      ],
      [
        ['a', 'b'],
        ['x', 'y'],
      ],
      [
        ['a', 'b', 'c'],
        ['x', 'b', 'y', 'z'],
      ],
      [['a', 'a'], ['a']],
      [['\ud55c', '\uae00'], ['\uae00']],
      [
        ['a', 'b', 'c', 'd'],
        ['d', 'c', 'b', 'a'],
      ],
      [['', ''], ['x']],
    ].map(([original, edited]) => ({ args: { original, edited } })),
    mutation: 'none',
  },
  {
    fn: 'odtPage.buildSectPr',
    call: (_t, args) => sect.buildSectPr(args.spec as never),
    built: SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'odtPage.injectParagraphSectPr',
    call: (text, args) => sect.injectParagraphSectPr(text, args.sectPr as string),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:p')
            .slice(0, 20)
            .map((text) => ({ text, args: { sectPr: SECT } })),
        ),
    built: PAGE_PARAS.flatMap((text) =>
      [SECT, '<w:sectPr/>'].map((sectPr) => ({ text, args: { sectPr } })),
    ),
  },
  {
    fn: 'odtPage.paragraphSectPr',
    call: (text) => sect.paragraphSectPr(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:p')
            .slice(0, 40)
            .map((text) => ({ text })),
        ),
    built: PAGE_PARAS.map((text) => ({ text })),
  },
  {
    fn: 'odtPage.stripParagraphSectPr',
    call: (text) => sect.stripParagraphSectPr(text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:p')
            .filter((p) => p.includes('<w:sectPr'))
            .slice(0, 20)
            .map((text) => ({ text })),
        ),
    built: PAGE_PARAS.map((text) => ({ text })),
  },
  {
    fn: 'odtPage.stripPPrSectPr',
    call: (text, args) => sect.stripPPrSectPr(args.missing ? undefined : text),
    fromDocument: (parts) =>
      [...parts]
        .filter(([n]) => n === 'word/document.xml')
        .flatMap(([, xml]) =>
          elementFragments(xml, 'w:pPr')
            .filter((p) => p.includes('<w:sectPr'))
            .slice(0, 20)
            .map((text) => ({ text })),
        ),
    built: [
      '',
      '<w:pPr/>',
      `<w:pPr>${SECT}</w:pPr>`,
      `<w:pPr><w:jc w:val="left"/>${SECT}</w:pPr>`,
      `<w:pPr>  ${SECT}  </w:pPr>`,
      '<w:pPr><w:sectPr/></w:pPr>',
      '<w:pPr w:x="1"><w:sectPr></w:sectPr></w:pPr>',
      '<w:pPr><w:jc/></w:pPr>',
      `<w:pPr>${SECT}${SECT}</w:pPr>`,
    ]
      .map((text) => ({ text }))
      .concat([{ text: '', args: { missing: true } } as never]),
  },
  constantSpec('odtPage', {
    PAGE_EXT_KEY: () => ts.pageModel.PAGE_EXT_KEY,
    PAGE_OWNER: () => ts.pageModel.PAGE_OWNER,
    HF_REGIONS: () => ts.pageModel.HF_REGIONS,
    LAYOUT_PROPS: () => geometry.LAYOUT_PROPS,
    LAYOUT_COLUMNS: () => geometry.LAYOUT_COLUMNS,
    HEADER_PROPS: () => geometry.HEADER_PROPS,
    FOOTER_PROPS: () => geometry.FOOTER_PROPS,
    FORCE_MARK: () => ts.pageRegister.FORCE_MARK,
  }),
]
