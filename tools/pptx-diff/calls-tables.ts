// Group `tables` of comparison (f): table-edit.ts and theme-apply.ts of
// packages/pptx-engine. The Rust side answers in
// crates/office-wasm/src/calls/pptx_tables.rs to
// `pptxTables.<module>.<TypeScript name>`.
import {
  ensureTableStyleXml,
  findTableElementInSlide,
  patchTableStyleXml,
  TABLE_STYLE_PRESETS,
  type TableStyleEdit,
} from '../../packages/pptx-engine/src/table-edit'
import {
  applyThemeToArchive,
  buildColorMap,
  collectExplicitColors,
  patchThemeXml,
  recolorXml,
  remapDeckColors,
  type ThemeSpec,
} from '../../packages/pptx-engine/src/theme-apply'
import { PackageArchive } from '../../packages/pptx-engine/src/zip'
import type { CallSpec, Input } from '../docx-diff/calls-spec'

type Parts = Array<[string, string]>
type Opened = Parameters<typeof applyThemeToArchive>[0]
type FindSlide = Parameters<typeof findTableElementInSlide>[0]

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

/** The return value, then every entry after the call as `[name, text]`. */
const afterCall = (archive: PackageArchive, returned: number) => ({
  returned,
  entries: [...archive.entries.keys()].map((name) => [name, archive.readText(name)]),
})

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/
const SHAPE_TREE_PART = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/
const THEME_PART = /^ppt\/theme\/theme\d+\.xml$/

const partsMatching = (parts: ReadonlyMap<string, string>, name: RegExp): Parts =>
  [...parts].filter(([path]) => name.test(path))

/** What the theme functions read and write of a deck: themes, slides, the presentation. */
const deckParts = (parts: ReadonlyMap<string, string>): Parts =>
  [...parts].filter(
    ([path]) => /^ppt\/(?:theme|slides)\//.test(path) || path === 'ppt/presentation.xml',
  )

// ── Tables ────────────────────────────────────────────────────────────

const frame = (tbl: string): string =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr>' +
  '<a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic>' +
  `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData>` +
  '</a:graphic></p:graphicFrame>'

const tc = (text: string, tcPr = '', attrs = ''): string =>
  `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody>${tcPr}</a:tc>`

const tr = (...cells: string[]): string => `<a:tr h="370840">${cells.join('')}</a:tr>`

const GRID = '<a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>'

const table = (tblPr: string, ...rows: string[]): string =>
  frame(`<a:tbl>${tblPr}${GRID}${rows.join('')}</a:tbl>`)

const TC_PRS = [
  '<a:tcPr/>',
  '<a:tcPr marL="91440"/>',
  '<a:tcPr anchor="ctr"><a:lnL w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnL>' +
    '<a:lnR/><a:lnT w="1"/><a:lnB w="1"><a:noFill/></a:lnB>' +
    '<a:lnTlToBr w="1"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:lnTlToBr>' +
    '<a:cell3D/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:headers/>' +
    '<a:extLst><a:ext uri="x"/></a:extLst></a:tcPr>',
  '<a:tcPr><a:gradFill rotWithShape="1"><a:gsLst/></a:gradFill></a:tcPr>',
  '<a:tcPr><a:pattFill prst="pct5"><a:fgClr/></a:pattFill><a:noFill></a:noFill></a:tcPr>',
  '<a:tcPr><a:blipFill><a:blip/></a:blipFill><a:grpFill/></a:tcPr>',
  '<a:tcPr><a:noFill/><a:extLst/></a:tcPr>',
  '<a:tcPr>\n<a:lnBlToTr>\n<a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:lnBlToTr><a:noFill/>\n</a:tcPr>',
  '<a:tcPr><a:headers><a:header val="h"/></a:headers></a:tcPr>',
]

const ROWS = [
  tr(tc('a', TC_PRS[0]), tc('b', TC_PRS[2])),
  tr(tc('c'), tc('\u{1F600}\uD55C', TC_PRS[3])),
  tr(tc('d', TC_PRS[4], ' gridSpan="2"'), tc('e', TC_PRS[5], ' hMerge="1"')),
  tr(tc('f', TC_PRS[6]), tc('g', TC_PRS[7]), tc('h', TC_PRS[8])),
]

const STYLE_ID = '<a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>'

/** A tblPr in single quotes and with spaces around `=`. */
const QUOTED_TBL_PR = `<a:tblPr firstRow='1' bandRow = "1" lastCol='0'>${STYLE_ID}</a:tblPr>`

const TABLE_TEXTS: string[] = [
  table(`<a:tblPr firstRow="1" bandRow="1">${STYLE_ID}</a:tblPr>`, ...ROWS),
  table('<a:tblPr/>', ...ROWS.slice(0, 2)),
  table('<a:tblPr firstRow="1" bandCol="1"/>', ROWS[1]!),
  table('<a:tblPr bandRow="1" />', ROWS[0]!),
  table('', ...ROWS.slice(1)),
  frame(`<a:tbl xmlns:a="x">${GRID}${ROWS[0]}</a:tbl>`),
  table(
    `<a:tblPr rtl="1" firstRow="1">${STYLE_ID}<a:extLst><a:ext uri="y"/></a:extLst></a:tblPr>`,
    ...ROWS.slice(0, 2),
  ),
  table('<a:tblPr rtl="true"/>', ROWS[2]!),
  table('<a:tblPr rtl="0" bandRow="1"><a:extLst/></a:tblPr>', ROWS[3]!),
  table('<a:tblPr firstRow="1">', ROWS[0]!),
  table(QUOTED_TBL_PR, ROWS[0]!),
  table('<a:tblPr x="a>b" firstRow="1"></a:tblPr>', ROWS[1]!),
  table(`<a:tblPr rtl = '1' firstRow="1" firstRow='0'>${STYLE_ID}</a:tblPr>`, ROWS[0]!),
  table(`<a:tblPr x=" firstRow='1'" bandRow="1" rtl='true'/>`, ROWS[1]!),
  table(`<a:tblPr\tfirstRow\n=\n"1"\trtl\t=\t"&#49;"/>`, ROWS[2]!),
  table(`<a:tblPrX rtl="1"/><a:tblPr firstRow="1"/>`, ROWS[0]!),
  // a table nested in a cell: the a:tc span ends at the inner cell's close
  table(
    '<a:tblPr/>',
    tr(
      `<a:tc><a:txBody><a:p/></a:txBody><a:tbl>${tr(tc('inner', '<a:tcPr><a:noFill/></a:tcPr>'))}</a:tbl></a:tc>`,
      tc('outer', '<a:tcPr/>'),
    ),
  ),
  table('<a:tblPr>\n</a:tblPr>', tr(tc('x'), tc('y')), tr('<a:tc/>', tc('z'))),
  '',
]

/** The edit table-ops.ts builds for each preset name. */
const PRESET_EDITS: Array<Record<string, unknown>> = Object.values(TABLE_STYLE_PRESETS).map(
  (preset) => ({
    tblPrXml: preset.tblPrXml,
    clearDirectFormatting: true,
    ...(preset.border
      ? {
          borderPreset: 'all',
          borderColor: preset.border.color,
          borderWidthEmu: preset.border.widthEmu,
        }
      : {}),
  }),
)

/** Edits whose fields arrive as JSON: `null` where the IPC type allows it. */
const EDITS: Array<Record<string, unknown>> = [
  {},
  ...PRESET_EDITS,
  { tblPrXml: '<a:tblPr rtl="0"/>' },
  { tblPrXml: "<a:tblPr rtl = '0'/>" },
  { tblPrXml: '<a:tblPr x=" rtl=\'1\'"/>' },
  { tblPrXml: '' },
  { tblPrXml: 'x<a:tblPr/>' },
  { tblPrXml: '<a:tblPr firstRow="1">$&</a:tblPr>' },
  { firstRow: true },
  { firstRow: false },
  { bandRow: true, lastRow: true, firstCol: false, lastCol: true, bandCol: false },
  { rtl: true },
  { rtl: false, bandRow: false },
  { styleId: '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}' },
  { styleId: 'a&"<b>\u{1F600}' },
  { styleId: '' },
  { styleId: '$&', firstRow: true },
  { tblPrXml: '<a:tblPr/>', firstRow: true, styleId: 'ignored' },
  { shadingColor: '#ff0000' },
  { shadingColor: 'none' },
  { shadingColor: null },
  { shadingColor: '' },
  { shadingColor: 'ab#cd' },
  { shadingColor: '\u00DF\u0131' },
  { borderPreset: 'all', borderColor: '#00f' },
  { borderPreset: 'all' },
  { borderPreset: 'all', borderColor: '' },
  { borderPreset: 'none' },
  { borderPreset: null },
  { borderPreset: 'other' },
  { borderPreset: 'all', borderColor: 'x', borderWidthEmu: 0.5 },
  { borderPreset: 'all', borderColor: 'x', borderWidthEmu: -1 },
  { borderPreset: 'all', borderColor: 'x', borderWidthEmu: 1e21 },
  { borderPreset: 'all', borderColor: 'x', borderWidthEmu: 0 },
  { borderPreset: 'all', borderColor: 'x', borderWidthEmu: null },
  { clearDirectFormatting: true },
  { clearDirectFormatting: false },
  { clearDirectFormatting: true, shadingColor: 'none', borderPreset: 'none' },
  { shadingColor: '#FFC000', cells: [{ row: 0, col: 0 }] },
  { shadingColor: '#FFC000', cells: [] },
  { shadingColor: '#FFC000', cells: null },
  {
    shadingColor: 'none',
    borderPreset: 'all',
    borderColor: '#123456',
    cells: [
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 0, col: 0 },
    ],
  },
  {
    shadingColor: '#000000',
    cells: [
      { row: 9, col: 0 },
      { row: 0, col: 9 },
    ],
  },
  {
    shadingColor: '#000000',
    cells: [
      { row: -1, col: 0 },
      { row: 0, col: -1 },
    ],
  },
  {
    shadingColor: '#000000',
    cells: [
      { row: 0.5, col: 0 },
      { row: 1, col: 1.5 },
    ],
  },
  {
    shadingColor: '#000000',
    cells: [
      { row: 1e300, col: 0 },
      { row: -1e300, col: 0 },
    ],
  },
  {
    shadingColor: '#111111',
    cells: [
      { row: 1, col: 0 },
      { row: 1, col: 0 },
    ],
  },
  {
    borderPreset: 'none',
    clearDirectFormatting: true,
    cells: [
      { row: 1, col: 0 },
      { row: 3, col: 2 },
    ],
  },
]

/**
 * `$` patterns in a color that is not a color: the tcPr a cell is given is
 * written as it is.
 */
const DOLLAR_EDITS: Array<Record<string, unknown>> = [
  { shadingColor: '$&', cells: [{ row: 1, col: 0 }] },
  {
    shadingColor: '$`',
    cells: [
      { row: 1, col: 0 },
      { row: 0, col: 0 },
    ],
  },
  { borderPreset: 'all', borderColor: "$'$$$1$0", cells: [{ row: 1, col: 0 }] },
]

const patchInputs: Input[] = [
  ...TABLE_TEXTS.flatMap((text) =>
    EDITS.map((edit): Input => ({ text, args: { edit } })),
  ),
  ...TABLE_TEXTS.slice(0, 3).flatMap((text) =>
    DOLLAR_EDITS.map((edit): Input => ({ text, args: { edit } })),
  ),
]

const CORPUS_EDITS: Array<Record<string, unknown>> = [
  {},
  ...PRESET_EDITS,
  { firstRow: false, bandCol: true },
  { styleId: '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}' },
  { rtl: true },
  {
    shadingColor: '#FFC000',
    cells: [
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    ],
  },
  { borderPreset: 'none' },
  { shadingColor: 'none', clearDirectFormatting: true },
]

/** Every graphicFrame of the slides that holds a table. */
const tableFrames = (parts: ReadonlyMap<string, string>): string[] =>
  partsMatching(parts, SLIDE_PART).flatMap(([, xml]) =>
    [...xml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)]
      .map(([frame]) => frame)
      .filter((frame) => frame.includes('<a:tbl>')),
  )

const STYLE_PRESETS = Object.values(TABLE_STYLE_PRESETS).filter((preset) => preset.styleId)

const EMPTY_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>'

const TABLE_STYLES_TEXTS = [
  EMPTY_STYLES,
  '',
  'no list here',
  '<a:tblStyleLst def="x"></a:tblStyleLst>',
  `<a:tblStyleLst def="x">${STYLE_PRESETS[0]!.styleDefXml}</a:tblStyleLst>`,
  '<a:tblStyleLst><a:tblStyle/></a:tblStyleLst></a:tblStyleLst>',
  '<a:tblStyleLst />',
  '<a:tblStyleLst def="a/b"/>',
  '<a:tblStyleLst def="x">',
  '<a:tblStyleLstX/>',
  '<a:tblStyleLst def="\u{1F600}"/><a:tblStyleLst/>',
  "<a:tblStyleLst def='x'>\n</a:tblStyleLst>",
]

const STYLE_IDS: Array<[string, string]> = [
  ...STYLE_PRESETS.map((preset): [string, string] => [preset.styleId!, preset.styleDefXml!]),
  ['', '<a:tblStyle/>'],
  ['constructor', '<a:tblStyle styleId="constructor"/>'],
  ['tblStyleLst', '<a:tblStyle/>'],
  ['{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', '<a:tblStyle/>'],
]

/** `$` patterns of the text a replacement writes. */
const DOLLAR_DEF = '<a:tblStyle styleId="Z">$&|$`|$\'|$$|$1</a:tblStyle>'

const ensureInputs: Input[] = [
  ...TABLE_STYLES_TEXTS.flatMap((text) =>
    STYLE_IDS.map(([styleId, styleDefXml]) => ({ text, args: { styleId, styleDefXml } })),
  ),
  { text: 'x', args: { styleId: STYLE_IDS[0]![0], styleDefXml: 'd', nullish: 'null' } },
  { text: 'x', args: { styleId: STYLE_IDS[0]![0], styleDefXml: 'd', nullish: 'undefined' } },
  { text: 'x', args: { styleId: '', styleDefXml: 'd', nullish: 'null' } },
  // the callback form expands nothing: the same on both sides
  // a mutation that breaks the closing tag would send it to a replacement string
  {
    text: '<a:tblStyleLst def="x"></a:tblStyleLst>',
    args: { styleId: 'Z', styleDefXml: DOLLAR_DEF },
  },
  {
    text: '<a:tblStyleLst xmlns:x="urn:x$&" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>',
    args: { styleId: 'Z', styleDefXml: '<a:tblStyle/>' },
  },
  { text: EMPTY_STYLES, args: { styleId: 'Z', styleDefXml: DOLLAR_DEF } },
]

const ELEMENTS = [
  { id: '1', type: 'shape', name: 'Title' },
  { type: 'table', id: '2', name: 'first' },
  { id: '2', type: 'table', name: 'second', rows: [[1]] },
  { id: '3', type: 'Table' },
  { id: 'constructor', type: 'table' },
  { id: '', type: 'table', x: 1.5 },
  { id: '\u{1F600}', type: 'table' },
]

const SOURCE_IDS = ['2', '1', '3', '9', '', 'constructor', ' 2', '\u{1F600}', 'toString']

/** The elements of each slide: cNvPr ids, `table` where the graphicFrame holds a:tbl. */
function slidesOf(parts: ReadonlyMap<string, string>): Input[] {
  const inputs: Input[] = []
  for (const [, xml] of partsMatching(parts, SLIDE_PART)) {
    const tables = new Set(
      [...xml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)]
        .filter(([frame]) => frame.includes('<a:tbl>'))
        .map(([frame]) => /<p:cNvPr id="([^"]*)"/.exec(frame)?.[1]),
    )
    const elements = [...xml.matchAll(/<p:cNvPr id="([^"]*)" name="([^"]*)"/g)].map(
      ([, id, name]) => ({ id: id!, type: tables.has(id) ? 'table' : 'shape', name: name! }),
    )
    for (const text of [...elements.map(({ id }) => id), 'missing'])
      inputs.push({ text, args: { slide: { elements } } })
  }
  return inputs
}

// ── Themes ────────────────────────────────────────────────────────────

const SCHEME =
  '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'

const FONTS =
  '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/>' +
  '<a:ea typeface=""/><a:cs typeface=""/><a:font script="Hang" typeface="\uB9D1\uC740 \uACE0\uB515"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/>' +
  '<a:cs typeface=""/></a:minorFont></a:fontScheme>'

const theme = (scheme: string, fonts: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">' +
  `<a:themeElements>${scheme}${fonts}<a:fmtScheme name="Office"/></a:themeElements></a:theme>`

const THEME = theme(SCHEME, FONTS)

const THEME_TEXTS = [
  THEME,
  theme(SCHEME.replace('<a:clrScheme name="Office">', "<a:clrScheme name='Office'>"), FONTS),
  theme(SCHEME.replace('<a:dk1>', '<a:dk1 >').replace('<a:lt2>', '<a:lt2><a:lt2>'), FONTS),
  theme(SCHEME + SCHEME, FONTS),
  // no latin typeface in majorFont: the lazy match runs on into minorFont
  theme(
    SCHEME,
    FONTS.replace('<a:latin typeface="Calibri Light" panose="020F0302020204030204"/>', ''),
  ),
  theme(SCHEME, FONTS.replace('typeface="Calibri"', 'panose="0" typeface="\u{1F600}"')),
  theme('', ''),
  '',
]

const COLORS = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#1F3864',
  lt2: '#EDEDED',
  accent1: '#4472C4',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#5B9BD5',
  accent6: '#70AD47',
  hlink: '#0563C1',
  folHlink: '#954F72',
}

const SPECS: ThemeSpec[] = [
  { name: 'Office 2013', colors: COLORS },
  {
    name: 'Lower',
    colors: Object.fromEntries(
      Object.entries(COLORS).map(([key, value]) => [key, value.slice(1).toLowerCase()]),
    ),
    majorFont: 'Georgia',
    minorFont: 'Verdana & "Co" <x>',
  },
  {
    name: 'Partial & "quoted" <name>',
    colors: { accent1: '#C00000', lt1: '#FAFAFA' },
    majorFont: '',
  },
  {
    name: '\u{1F600}\uD55C',
    colors: {
      dk1: '',
      lt1: null as unknown as string,
      dk2: '#12',
      lt2: '##ABCDEF',
      accent1: 'abcdefgh',
      accent2: '\u00DF\u00DF\u00DF',
      accent3: '\u{1F600}abcd',
      accent4: 'red',
      accent5: '-0f0f0',
      accent6: '0x1234',
      hlink: ' 1a2b3c',
      folHlink: '#ff0000',
      constructor: '#FFFFFF',
    },
    minorFont: 'Noto Sans',
  },
  { name: '', colors: {} },
  { name: 'Office', colors: {} },
]

/**
 * `$` patterns in a color that is not a color: the scheme slot is written as it is.
 */
const DOLLAR_COLORS: ThemeSpec = {
  name: 'Dollar colors',
  colors: { accent1: '$&1234', accent2: "$'", dk1: '$$' },
}

/** `$` patterns of the name and fonts are written as they are. */
const DOLLAR_SPECS: ThemeSpec[] = [
  { name: "Q3 $& $1 $$ $' $`", colors: {} },
  { name: 'Fonts', colors: {}, majorFont: '$&', minorFont: '$1x$2' },
  DOLLAR_COLORS,
]

const patchThemeInputs: Input[] = [
  ...THEME_TEXTS.flatMap((text) => SPECS.map((spec) => ({ text, args: { spec } }))),
  ...DOLLAR_SPECS.map((spec): Input => ({ text: THEME, args: { spec } })),
]

const THEME_PARTS: Parts = [
  ['[Content_Types].xml', '<Types/>'],
  ['ppt/theme/theme1.xml', THEME],
  ['ppt/theme/theme2.xml', THEME_TEXTS[2]!],
  ['ppt/theme/theme10.xml', THEME_TEXTS[5]!],
  ['ppt/theme/themeA.xml', THEME],
  ['ppt/theme/_rels/theme1.xml.rels', '<Relationships/>'],
  ['ppt/theme/theme3.xml', ''],
  ['ppt/Theme/theme4.xml', THEME],
  ['xppt/theme/theme5.xml', THEME],
  ['ppt/theme/theme6.xml', 'no scheme here'],
  ['ppt/theme/theme7.xml.bak', THEME],
]

const applyInputs: Input[] = [
  ...SPECS.map((spec) => ({ args: { parts: THEME_PARTS, spec } })),
  ...SPECS.slice(0, 3).map((spec) => ({
    text: THEME_TEXTS[1]!,
    args: { parts: THEME_PARTS, textPart: 'ppt/theme/theme1.xml', spec },
  })),
  { text: THEME, args: { parts: THEME_PARTS, textPart: 'ppt/theme/theme99.xml', spec: SPECS[0] } },
  { args: { parts: [['ppt/slides/slide1.xml', THEME]], spec: SPECS[0] } },
  { text: THEME, args: { textPart: 'ppt/theme/theme1.xml', spec: { name: 'Office', colors: {} } } },
  ...DOLLAR_SPECS.map((spec): Input => ({
    text: THEME,
    args: { parts: THEME_PARTS, textPart: 'ppt/theme/theme1.xml', spec },
  })),
]

const colorSlide = (...hexes: string[]): string =>
  '<p:sld><p:cSld><p:spTree>' +
  hexes
    .map(
      (hex, i) =>
        `<p:sp><p:spPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></p:spPr><a:t>${i}</a:t></p:sp>`,
    )
    .join('') +
  '</p:spTree></p:cSld></p:sld>'

const SLIDE_TEXTS = [
  colorSlide(
    'FF0000',
    'ff0000',
    'CC0000',
    'FF8000',
    '00FF00',
    '0000FF',
    'FFFFFF',
    '000000',
    '808080',
  ),
  colorSlide(
    'FF00FF',
    'FF0040',
    '00FFFF',
    'FFFF00',
    '8000FF',
    '0080FF',
    '40FF80',
    'F2F2F2',
    '404040',
  ),
  colorSlide('336699', '336699', '996633') +
    '<a:srgbClr val="12345"/><a:srgbClr val="1234567"/><a:srgbClr  val="123456"/>' +
    '<a:srgbClr val=\'123456\'/><a:srgbClr val="ABCDEF">\u{1F600}<a:srgbClr val="abcdef"/>',
  '',
  colorSlide(
    'D9D9D9',
    'DADADA',
    '8C8C8C',
    '8D8D8D',
    '474747',
    '484848',
    '7F7F7F',
    'F3F3F3',
    '111111',
  ),
]

const SLIDE_PARTS: Parts = [
  ['ppt/presentation.xml', '<p:presentation/>'],
  ['ppt/slides/slide1.xml', SLIDE_TEXTS[0]!],
  ['ppt/slides/slide2.xml', SLIDE_TEXTS[1]!],
  ['ppt/slides/slide3.xml', SLIDE_TEXTS[2]!],
  ['ppt/slides/slide4.xml', ''],
  ['ppt/slideLayouts/slideLayout1.xml', SLIDE_TEXTS[0]!],
]

const DECK_SLIDES = [
  'ppt/slides/slide1.xml',
  'ppt/slides/slide2.xml',
  'ppt/slides/slide3.xml',
  'ppt/slides/slide4.xml',
]

const REMAP_SPECS: ThemeSpec[] = [
  ...SPECS,
  {
    name: 'No accents',
    colors: { dk1: '#101010', lt1: '#FEFEFE', dk2: '#202020', lt2: '#E0E0E0' },
  },
  { name: 'One accent', colors: { accent3: '#00B050' } },
  { name: 'Empty lt1', colors: { lt1: '', accent1: '#7030A0' } },
]

const remapInputs: Input[] = [
  ...REMAP_SPECS.map((spec) => ({ args: { parts: SLIDE_PARTS, slides: DECK_SLIDES, spec } })),
  { args: { parts: SLIDE_PARTS, slides: DECK_SLIDES, spec: DOLLAR_COLORS } },
  {
    text: SLIDE_TEXTS[4]!,
    args: {
      parts: SLIDE_PARTS,
      textPart: 'ppt/slides/slide2.xml',
      slides: DECK_SLIDES,
      spec: SPECS[0],
    },
  },
  // a slide listed twice is counted twice and recolored twice
  {
    args: {
      parts: SLIDE_PARTS,
      slides: ['ppt/slides/slide1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/missing.xml'],
      spec: SPECS[0],
    },
  },
  { args: { parts: SLIDE_PARTS, slides: [], spec: SPECS[0] } },
  {
    args: {
      parts: [['ppt/slides/slide1.xml', colorSlide('000000')]],
      slides: ['ppt/slides/slide1.xml'],
      spec: { name: 'x', colors: { dk1: '#000000' } },
    },
  },
  {
    args: {
      parts: [['ppt/slides/slide1.xml', colorSlide('FF0000')]],
      slides: ['ppt/slides/slide1.xml'],
      spec: { name: 'x', colors: {} },
    },
  },
]

const COUNTS: Array<Array<[string, number]>> = [
  [],
  [
    ['FFFFFF', 3],
    ['000000', 2],
    ['808080', 1],
    ['7F7F7F', 1],
    ['F2F2F2', 1],
    ['404040', 1],
    ['D9D9D9', 1],
    ['DADADA', 1],
    ['8C8C8C', 1],
    ['8D8D8D', 1],
    ['474747', 1],
    ['484848', 1],
    ['F3F3F3', 1],
    ['111111', 1],
    ['121212', 1],
    ['B3A6A6', 1],
  ],
  [
    ['FF0000', 5],
    ['CC0000', 3],
    ['FF8000', 3],
    ['00FF00', 3],
    ['0000FF', 2],
    ['FF00FF', 2],
    ['FF0040', 2],
    ['00FFFF', 1],
    ['FFFF00', 1],
    ['8000FF', 1],
    ['0080FF', 1],
    ['40FF80', 1],
    ['80C0FF', 1],
    ['4472C4', 1],
  ],
  [
    ['#FF0000', 1],
    ['red', 1],
    ['-f0f00', 1],
    ['-0f0f0', 1],
    ['0x1234', 1],
    ['', 1],
    ['\u{1F600}\u{1F600}\u{1F600}', 1],
    ['\uFFFF', 1],
    ['abc', 1],
    ['constructor', 1],
    ['__proto__', 1],
    ['\uD55C\uAE00', 1],
    ['ff0000', 1],
  ],
  [
    ['336699', 1.5],
    ['996633', -2],
    ['669933', 1e300],
    ['339966', 0],
    ['663399', 1.5],
  ],
]

const MAP_SPECS: ThemeSpec[] = [...REMAP_SPECS, DOLLAR_SPECS[0]!, DOLLAR_COLORS]

const buildMapInputs: Input[] = COUNTS.flatMap((counts) =>
  MAP_SPECS.map((spec) => ({ args: { counts, spec } })),
)

const MAPS: Array<Array<[string, string]>> = [
  [],
  [['FF0000', '00FF00']],
  [
    ['FF0000', '00FF00'],
    ['00FF00', '0000FF'],
    ['336699', 'ABCDEF'],
  ],
  [['ff0000', '111111']],
  [['FF0000', '']],
  [['__proto__', '123456']],
]

/** `$` patterns in the color a map gives. */
const DOLLAR_MAPS: Array<Array<[string, string]>> = [
  [['FF0000', '$&']],
  [['FF0000', '$`']],
  [['336699', "$'"]],
  [['ABCDEF', '$$$1']],
]

/** The spec a deck's own theme gives: each slot's srgbClr val or sysClr lastClr. */
function themeSpecOf(xml: string): ThemeSpec {
  const colors: Record<string, string> = {}
  for (const key of Object.keys(COLORS)) {
    const hex = new RegExp(`<a:${key}>[\\s\\S]*?(?:srgbClr val|lastClr)="([0-9A-Fa-f]{6})"`).exec(
      xml,
    )?.[1]
    if (hex !== undefined) colors[key] = `#${hex}`
  }
  return { name: 'Deck', colors }
}

const deckSpecs = (parts: ReadonlyMap<string, string>): ThemeSpec[] => [
  ...partsMatching(parts, THEME_PART).map(([, xml]) => themeSpecOf(xml)),
  SPECS[0]!,
  REMAP_SPECS[REMAP_SPECS.length - 3]!,
]

const deckCounts = (parts: ReadonlyMap<string, string>): Array<[string, number]> => [
  ...collectExplicitColors(
    [...partsMatching(parts, SHAPE_TREE_PART), ...partsMatching(parts, THEME_PART)].map(
      ([, xml]) => xml,
    ),
  ),
]

export const TABLES: CallSpec[] = [
  {
    fn: 'pptxTables.table-edit.TABLE_STYLE_PRESETS',
    // own keys only: table-ops.ts reads TABLE_STYLE_PRESETS[String(op.styleName)]
    call: (text) =>
      Object.hasOwn(TABLE_STYLE_PRESETS, text) ? TABLE_STYLE_PRESETS[text] : undefined,
    built: [
      ...Object.keys(TABLE_STYLE_PRESETS),
      '',
      'None',
      'zebra',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
    ].map((text) => ({ text })),
  },
  {
    fn: 'pptxTables.table-edit.ensureTableStyleXml',
    call: (text, args) =>
      ensureTableStyleXml(
        args.nullish === 'null' ? null : args.nullish === 'undefined' ? undefined : text,
        args.styleId as string,
        args.styleDefXml as string,
      ),
    fromDocument: (parts) => {
      const text = parts.get('ppt/tableStyles.xml')
      if (text === undefined) return []
      return STYLE_IDS.map(([styleId, styleDefXml]) => ({ text, args: { styleId, styleDefXml } }))
    },
    built: ensureInputs,
  },
  {
    fn: 'pptxTables.table-edit.patchTableStyleXml',
    call: (text, args) => patchTableStyleXml(text, args.edit as TableStyleEdit),
    fromDocument: (parts) =>
      tableFrames(parts).flatMap((text) => CORPUS_EDITS.map((edit) => ({ text, args: { edit } }))),
    built: patchInputs,
  },
  {
    fn: 'pptxTables.table-edit.findTableElementInSlide',
    call: (text, args) => findTableElementInSlide(args.slide as FindSlide, text),
    fromDocument: slidesOf,
    built: [
      ...SOURCE_IDS.map((text) => ({ text, args: { slide: { elements: ELEMENTS } } })),
      { text: '2', args: { slide: { elements: [] } } },
      { text: '2', args: { slide: { elements: [...ELEMENTS].reverse() } } },
    ],
  },
  {
    fn: 'pptxTables.theme-apply.patchThemeXml',
    call: (text, args) => patchThemeXml(text, args.spec as ThemeSpec),
    fromDocument: (parts) =>
      partsMatching(parts, THEME_PART).flatMap(([, text]) =>
        [...deckSpecs(parts), ...SPECS].map((spec) => ({ text, args: { spec } })),
      ),
    built: patchThemeInputs,
  },
  {
    fn: 'pptxTables.theme-apply.applyThemeToArchive',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const patched = applyThemeToArchive({ archive } as unknown as Opened, args.spec as ThemeSpec)
      return afterCall(archive, patched)
    },
    fromDocument: (parts) =>
      partsMatching(parts, THEME_PART).flatMap(([textPart, text]) =>
        [SPECS[0]!, SPECS[1]!, SPECS[SPECS.length - 1]!].map((spec) => ({
          text,
          args: { parts: deckParts(parts), textPart, spec },
        })),
      ),
    built: applyInputs,
  },
  {
    fn: 'pptxTables.theme-apply.collectExplicitColors',
    call: (text, args) =>
      collectExplicitColors(args.empty === true ? [] : [...((args.xmls ?? []) as string[]), text]),
    fromDocument: (parts) => {
      const xmls = [...partsMatching(parts, SHAPE_TREE_PART), ...partsMatching(parts, THEME_PART)]
      return [
        ...xmls.map(([, text]) => ({ text })),
        { text: '', args: { xmls: xmls.map(([, xml]) => xml) } },
      ]
    },
    built: [
      ...SLIDE_TEXTS.map((text) => ({ text })),
      { text: SLIDE_TEXTS[1]!, args: { xmls: [SLIDE_TEXTS[0], SLIDE_TEXTS[0], ''] } },
      { text: SLIDE_TEXTS[0]!, args: { empty: true } },
      { text: THEME },
    ],
  },
  {
    fn: 'pptxTables.theme-apply.buildColorMap',
    call: (_text, args) =>
      buildColorMap(new Map(args.counts as Array<[string, number]>), args.spec as ThemeSpec),
    fromDocument: (parts) => {
      const counts = deckCounts(parts)
      return deckSpecs(parts).map((spec) => ({ args: { counts, spec } }))
    },
    built: buildMapInputs,
    mutation: 'none',
  },
  {
    fn: 'pptxTables.theme-apply.recolorXml',
    call: (text, args) => recolorXml(text, new Map(args.map as Array<[string, string]>)),
    fromDocument: (parts) => {
      const counts = new Map(deckCounts(parts))
      const maps = deckSpecs(parts).map((spec) => [...buildColorMap(counts, spec)])
      return partsMatching(parts, SHAPE_TREE_PART).flatMap(([, text]) =>
        maps.map((map) => ({ text, args: { map } })),
      )
    },
    built: [
      ...SLIDE_TEXTS.flatMap((text) => MAPS.map((map): Input => ({ text, args: { map } }))),
      ...SLIDE_TEXTS.slice(0, 3).flatMap((text) =>
        DOLLAR_MAPS.map((map): Input => ({ text, args: { map } })),
      ),
    ],
  },
  {
    fn: 'pptxTables.theme-apply.remapDeckColors',
    call: (text, args) => {
      const archive = archiveOf(text, args)
      const deck = { slides: (args.slides as string[]).map((path) => ({ path })) }
      const mapped = remapDeckColors({ archive, deck } as unknown as Opened, args.spec as ThemeSpec)
      return afterCall(archive, mapped)
    },
    fromDocument: (parts) => {
      const slides = [...parts.keys()]
        .filter((path) => SLIDE_PART.test(path))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
      const first = slides.find((path) => (parts.get(path) ?? '').length > 0)
      if (first === undefined) return []
      return deckSpecs(parts).map((spec) => ({
        text: parts.get(first)!,
        args: { parts: deckParts(parts), textPart: first, slides, spec },
      }))
    },
    built: remapInputs,
  },
]
