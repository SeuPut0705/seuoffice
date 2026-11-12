// Group `save`, slice `features` (crates/docx-engine/src/save/features/): the
// redline of two documents (compare.ts), the mail merge (mail-merge.ts), content
// controls, the docProps and Zotero writers, and the chart, bibliography, theme
// and watermark writers. A function over XML takes its text; a Map crosses as its
// entries; a function that writes into a zip answers the parts of the zip after
// the call; a workbook answered in base64 is compared by the parts it holds
// (the compressed bytes are the deflater's own).
import JSZip from 'jszip'
import {
  applyPropertyChanges,
  parsePropertyChanges,
  patchAppPropertiesXml,
  patchCorePropertiesXml,
  patchCustomPropertiesXml,
  type PropertyChanges,
  type PropertyValue,
} from './reference/doc-properties'
import {
  buildChartPartXml,
  buildChartWorkbookXlsxBase64,
  patchChartPartXml,
  patchChartWorkbookXlsxBase64,
  type ChartPatch,
} from './reference/chart'
import { compareBlocks, type CompareOptions } from './reference/compare'
import {
  buildContentControlXml,
  isContentControlLock,
  nextContentControlId,
  type ContentControlSpec,
} from './reference/content-control'
import {
  compareOperands,
  conditionHolds,
  controlEffect,
  ifBranch,
  mergeBlockTree,
  mergeDataFromRows,
  mergeFieldInstruction,
  mergeFieldName,
  mergeFieldSwitches,
  mergeFieldText,
  mergeOutputFileName,
  mergeRecords,
  placeholderText,
  splitInstruction,
  valueOf,
  type MergeData,
  type MergeRecord,
} from './reference/mail-merge'
import type { ParsedDocFull } from './reference/patch'
import { buildSourcesItemPropsXml, buildSourcesXml, parseSourcesXml } from './reference/sources'
import { applyThemeColors, applyThemeFonts, buildThemeXml } from './reference/theme'
import type { Block, ParsedDoc, SourceInfo, ThemeColors, ThemeFonts } from './reference/types'
import {
  pictureWatermarkParagraphXml,
  watermarkParagraphXml,
  type PictureWatermarkSpec,
  type WatermarkSpec,
} from './reference/watermark'
import { revisionDateBefore } from './reference/revision-xml'
import { parseLazyMediaUrl } from './reference/lazy-media'
import { patchZoteroDocumentDataXml } from './reference/zotero-doc-props'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { compareCharAstral, mergeFileNameLongAstral } from './listed'

/** The value as it crosses the wire. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The value as it crosses the wire, with data URLs cut short: they only make inputs large. */
const slim = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && item.startsWith('data:') && item.length > 256
        ? item.slice(0, 64)
        : item,
    ),
  ) as T

const part =
  (name: string) =>
  (parts: ReadonlyMap<string, string>): Input[] => {
    const text = parts.get(name)
    return text === undefined ? [] : [{ text }]
  }

/** The parts of a zip after a call: `[name, text]`, null for a folder. */
async function partsOf(zip: JSZip): Promise<Array<[string, string | null]>> {
  const out: Array<[string, string | null]> = []
  for (const [name, entry] of Object.entries(zip.files))
    out.push([name, entry.dir ? null : await entry.async('string')])
  return out
}

/** What a workbook in base64 holds. */
async function workbookParts(
  base64: string | null,
): Promise<Array<[string, string | null]> | null> {
  return base64 === null ? null : partsOf(await JSZip.loadAsync(Buffer.from(base64, 'base64')))
}

// ---------------------------------------------------------------- compare

const DATE = '2024-05-06T07:08:09.000Z'

let nextId = 0
const para = (...texts: Array<string | Record<string, unknown>>): Block =>
  ({
    id: `built-${nextId}`,
    type: 'paragraph',
    docxIndex: nextId++,
    originalXml: null,
    runs: texts.map((text) => (typeof text === 'string' ? { text } : text)),
  }) as unknown as Block

const COMPARE_OPTIONS: Array<CompareOptions | undefined> = [
  { date: DATE },
  { author: ' Rev ', date: DATE, granularity: 'char' },
  { date: DATE, ignore: ['case', 'whitespace'] },
  { date: DATE, ignore: ['formatting'], author: '' },
  { date: DATE, granularity: 'word', ignore: ['formatting', 'case', 'whitespace'] },
]

const LEFT_TEXTS = [
  para('The quick brown fox jumps over the lazy dog.'),
  para('Second paragraph stays the same.'),
  para('Third paragraph to be deleted completely and entirely.'),
  para({ text: 'Bold start ', bold: true }, 'plain end'),
  para('Alpha beta gamma delta epsilon.'),
  para('   spaced   out   text   '),
  para('Straße CASE Text'),
  para('Emoji 😀 text 𝒳𝒴'),
]
const RIGHT_TEXTS = [
  para('The quick red fox leaps over the lazy dog!'),
  para('Second paragraph stays the same.'),
  para('Inserted paragraph that is entirely new.'),
  para({ text: 'Bold start ', bold: false }, 'plain end'),
  para('Alpha gamma beta delta epsilon.'),
  para('spaced out text'),
  para('STRASSE case TEXT'),
  para('Emoji 😁 text 𝒳𝒴'),
]

const TABLE_BLOCK = (cells: string[][]): Block =>
  ({
    id: `table-${nextId}`,
    type: 'table',
    docxIndex: nextId++,
    originalXml: '<w:tbl/>',
    table: { rows: cells.map((row) => row.map((text) => ({ paras: [text] }))) },
  }) as Block
const IMAGE_BLOCK = (url: string | undefined, xml: string | null): Block =>
  ({
    id: `image-${nextId}`,
    type: 'image',
    docxIndex: nextId++,
    originalXml: xml,
    ...(url ? { imageDataUrl: url } : {}),
  }) as Block
const FIELD_BLOCK = (preview: string | undefined): Block =>
  ({
    id: `field-${nextId}`,
    type: 'passthrough',
    docxIndex: nextId++,
    originalXml: '<w:p/>',
    ...(preview ? { previewText: preview } : {}),
  }) as Block

const compareCase = (
  original: Block[],
  revised: Block[],
  options?: CompareOptions,
  documentXml = '',
): Input => ({
  args: {
    original: wire(original),
    revised: wire(revised),
    documentXml,
    ...(options ? { options } : {}),
  },
})

const COMPARE_BUILT: Input[] = [
  ...COMPARE_OPTIONS.map((options) =>
    compareCase(LEFT_TEXTS, RIGHT_TEXTS, options, '<w:ins w:id="12"/><w:del w:id = \'9500\'/>'),
  ),
  ...COMPARE_OPTIONS.map((options) => compareCase(LEFT_TEXTS, LEFT_TEXTS, options)),
  compareCase([], RIGHT_TEXTS, { date: DATE }),
  compareCase(LEFT_TEXTS, [], { date: DATE }),
  compareCase([], [], { date: DATE }),
  compareCase(
    [TABLE_BLOCK([['a', 'b']]), IMAGE_BLOCK('data:image/png;base64,AAAA', '<w:drawing/>')],
    [TABLE_BLOCK([['a', 'b']]), IMAGE_BLOCK('data:image/png;base64,AAAA', '<w:drawing/>')],
    { date: DATE },
  ),
  compareCase(
    [TABLE_BLOCK([['a', 'b']]), IMAGE_BLOCK('data:image/png;base64,AAAA', '<w:drawing/>')],
    [
      TABLE_BLOCK([['a', 'c']]),
      IMAGE_BLOCK(
        'data:image/png;base64,BBBB',
        '<w:drawing><wp:inline/></w:drawing><w:pict/><w:object/>',
      ),
    ],
    { date: DATE },
  ),
  compareCase(
    [IMAGE_BLOCK(undefined, '<w:p><w:drawing/></w:p>'), FIELD_BLOCK('TOC'), FIELD_BLOCK(undefined)],
    [FIELD_BLOCK('TOC'), FIELD_BLOCK(undefined), IMAGE_BLOCK(undefined, '<w:p><w:pict/></w:p>')],
    { date: DATE },
  ),
  compareCase(
    [
      para('keep'),
      para(
        { text: '', image: { dataUrl: 'data:image/png;base64,AAAA', xml: '<w:drawing/>' } },
        ' and text',
      ),
    ],
    [
      para('keep'),
      para(
        { text: '', image: { dataUrl: 'data:image/png;base64,AAAA', xml: '<w:drawing/>' } },
        ' and more text',
      ),
    ],
    { date: DATE },
  ),
  compareCase(
    [
      para({ text: 'deleted', del: { author: 'x', date: DATE, id: '1' } }, 'visible'),
      para({ text: 'now plain', ins: { author: 'x', date: DATE, id: '2' } }),
    ],
    [para('visible'), para('now plain')],
    { date: DATE },
  ),
  compareCase(
    [
      {
        ...para('control'),
        sdtShell: {
          alias: '',
          tag: '',
          controlType: 'text',
          lock: '',
          id: '',
          openXml: '<w:sdt><w:sdtPr/><w:sdtContent>',
          closeXml: '</w:sdtContent></w:sdt>',
        },
      } as unknown as Block,
      para('gone with control'),
    ],
    [para('control changed')],
    { date: DATE },
  ),
  compareCase(
    [
      { ...para('hidden'), hidden: true } as Block,
      { ...para('deleted'), blockRevision: { kind: 'del', author: 'a' } } as unknown as Block,
      para('shown'),
    ],
    [para('shown')],
    { date: DATE },
  ),
  compareCase(
    [
      {
        ...para('H'),
        type: 'heading',
        level: 2,
        styleId: 'Heading2',
        bookmarks: ['b'],
        commentStarts: ['1'],
      } as Block,
      { ...para('item'), type: 'listItem', list: { kind: 'bullet', numId: '1', ilvl: 0 } } as Block,
    ],
    [
      {
        ...para('H2'),
        type: 'heading',
        level: 2,
        styleId: 'Heading2',
        bookmarks: ['b'],
        commentStarts: ['1'],
      } as Block,
      {
        ...para('item'),
        type: 'listItem',
        list: { kind: 'ordered', numId: '2', ilvl: 1 },
      } as Block,
    ],
    { date: DATE },
  ),
  compareCase([para('x', 'y'), para('same')], [para('xy'), para('same')], {
    date: DATE,
    ignore: ['whitespace'],
  }),
  compareCase([para('a'.repeat(300) + ' b')], [para('a'.repeat(300) + ' c')], {
    date: DATE,
    granularity: 'char',
  }),
]

function compareInputs(doc: ParsedDoc): Input[] {
  const blocks = slim(doc.blocks.slice(0, 40))
  if (blocks.length === 0 || JSON.stringify(blocks).length > 400_000) return []
  const ids = [...doc.internal.documentXml.matchAll(/\bw:id\s*=\s*["']\d+["']/g)]
    .map((m) => m[0])
    .join(' ')
  const edited = blocks.map((block, i) => {
    if (i !== blocks.findIndex((b) => Array.isArray(b.runs) && b.runs.length > 0)) return block
    const runs = block.runs!.map((run, k) =>
      k === 0 ? { ...run, text: `${run.text} changed` } : run,
    )
    return { ...block, runs }
  })
  const swapped = blocks.length > 1 ? [blocks[1]!, blocks[0]!, ...blocks.slice(2)] : blocks
  const inserted = [...blocks.slice(0, 2), para('An inserted paragraph.'), ...blocks.slice(2)]
  const dropped = blocks.filter((_, i) => i !== 1)
  const revisions: Block[][] = [edited, swapped, inserted, dropped]
  return [
    compareCase(blocks, blocks, { date: DATE }, ids),
    ...revisions.flatMap((revised) => [
      compareCase(blocks, revised, { date: DATE }, ids),
      compareCase(blocks, revised, { date: DATE, granularity: 'char', ignore: ['case'] }, ids),
    ]),
  ]
}

const compareSpec: CallSpec = {
  fn: 'save.compareBlocks',
  call: (_text, args) => {
    const documentXml = String(args.documentXml ?? '')
    const side = (blocks: unknown): ParsedDocFull =>
      ({ blocks, internal: { documentXml } }) as unknown as ParsedDocFull
    return compareBlocks(
      side(wire(args.original)),
      side(wire(args.revised)),
      args.options as CompareOptions | undefined,
    )
  },
  listed: compareCharAstral,
  fromModel: compareInputs,
  built: COMPARE_BUILT,
  mutation: 'none',
}

// ---------------------------------------------------------------- mail merge

const RECORDS: MergeRecord[] = [
  {
    Name: 'ada lovelace',
    'Postal Address': '12 St, Town',
    First: 'Ada',
    Paid: 'yes',
    Status: 'Active',
    A: 'x',
    B: 'y',
    Age: '42',
    Zero: '0',
  },
  {},
  { Name: '', Paid: '', Status: 'active', Age: ' 7 ', First: 'B' },
  { constructor: 'c', Name: "ÉCOLE-élan o'neil", toString: 'ts', ÄÖ: 'ääö öö' },
  { Name: 'ß straße', Paid: '0', Age: '7.50', Status: 'Active', A: '1e3', B: '1000' },
]

const INSTRUCTIONS = [
  'MERGEFIELD Name',
  'MERGEFIELD "Postal Address" \\* MERGEFORMAT',
  ' mergefield  First  \\b "Mr. " \\f " " \\* Upper',
  'MERGEFIELD Name \\* FirstCap',
  'MERGEFIELD Name \\* Caps',
  'MERGEFIELD Name \\* lower \\* MERGEFORMAT',
  'MERGEFIELD "ÄÖ" \\* Caps \\b x',
  'MERGEFIELD Name\t\\f x',
  'MERGEFIELD',
  'MERGEFIELD ""',
  'MERGEFIELD Missing \\b "(" \\f ")"',
  'MERGEFIELD Name \\* CHARFORMAT',
  'NEXT',
  'next',
  'NEXTIF Name = "x"',
  'SKIPIF «Paid» = "yes"',
  'SKIPIF 1 > 2',
  'SKIPIF «Age» >= 18',
  'IF «Status» = "Active" "Welcome" "Goodbye"',
  'IF «Paid» "yes" "no"',
  'IF «Missing» "yes" "no"',
  'IF «Zero» "yes" "no"',
  'IF 9 < 50 "small" "big"',
  'IF «A» <> «B» "diff" "same"',
  'IF «A» = «B» "diff" "same"',
  'IF Name = "Name" "t" "f"',
  'IF «Age» >= 18 "adult" "minor"',
  'IF «Age» <= 7 "young" "old"',
  'IF "a b" = "a b" "x y" "z"',
  'IF MERGEFIELD Name = "ada lovelace" "«Name»!" ""',
  'IF MERGEFIELD "Postal Address" <> "" "«Postal Address»" "none"',
  'IF a=b "1" "2"',
  'IF «Name» < "B" "1" "2"',
  'IF «Name» > "B" "1" "2"',
  'IF 2 = 2.0 "eq" "ne"',
  'IF "10" < "9" "lt" "ge"',
  'IF « Name » = "x" "1" "2"',
  'IF «Name» == "x" "1" "2"',
  'IF  ',
  'IF',
  'PAGE',
  'DATE \\@ "yyyy"',
  '',
  '   ',
  '"quoted" = "quoted" "yes" "no"',
]

const mergeCases = (
  names: string[],
  extra: (name: string, record: MergeRecord) => Record<string, unknown> = () => ({}),
): Input[] =>
  names.flatMap((text) =>
    RECORDS.map((record) => ({ text, args: { record, ...extra(text, record) } })),
  )

const MERGE_BLOCKS: Block[] = [
  para('Dear ', { text: '', instrField: 'MERGEFIELD Name', fldDirty: true, bold: true }, ','),
  para({ text: '', instrField: 'NEXT' }),
  para('Status: ', { text: '', instrField: 'IF «Paid» = "yes" "paid" "unpaid"' }, ' ', {
    text: '',
    instrField: 'PAGE',
  }),
  para({ text: '', instrField: 'SKIPIF «Name» = ""' }, { text: '', instrField: 'NEXT' }),
  para({ text: '', instrField: 'SKIPIF «Zero» = "9"' }),
  { id: 'empty', type: 'paragraph', docxIndex: 8, originalXml: null } as Block,
  { id: 'norun', type: 'paragraph', docxIndex: 9, originalXml: null, runs: [] } as Block,
  para(
    { text: 'plain' },
    { text: '', image: { dataUrl: 'data:image/png;base64,AAAA', xml: '<w:drawing/>' } },
    { text: '', instrField: 'IF «Age» "x" ""' },
  ),
  {
    ...para('with control', {
      text: 'in sdt',
      wrap: [
        {
          seq: 1,
          open: '<w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtContent>',
          close: '</w:sdtContent></w:sdt>',
        },
      ],
    }),
    inlineContentControls: [{ tag: '', title: '', lock: '', id: '', text: 'in sdt' }],
  } as unknown as Block,
  {
    id: 'table',
    type: 'table',
    docxIndex: 10,
    originalXml: null,
    runs: [{ text: '', instrField: 'MERGEFIELD First' }],
    table: {
      rows: [
        [
          {
            paras: ['x'],
            richParas: [
              { runs: [{ text: 'Name: ' }, { text: '', instrField: 'MERGEFIELD Name' }] },
              {
                runs: [
                  { text: '', instrField: 'NEXT' },
                  {
                    text: 'after',
                    wrap: [
                      {
                        seq: 2,
                        open: '<w:sdt><w:sdtPr><w:id w:val="6"/></w:sdtPr><w:sdtContent>',
                        close: '</w:sdtContent></w:sdt>',
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { paras: ['plain'] },
        ],
        [
          {
            paras: [''],
            richParas: [{ runs: [] }, { runs: [{ text: '', instrField: 'IF «Status» "A" "B"' }] }],
          },
        ],
      ],
    },
  } as unknown as Block,
]
const MERGE_DATA: MergeData[] = [
  { fields: ['Name', 'Paid', 'Zero'], records: RECORDS },
  { fields: [], records: [] },
  { fields: ['Name'], records: [{ Name: 'One' }] },
  {
    fields: ['Name', 'Zero'],
    records: [
      { Name: 'a', Zero: '9' },
      { Name: 'b', Zero: '0' },
      { Name: 'c', Zero: '9' },
      { Name: '', Zero: '0' },
    ],
  },
]

function mergeModelInputs(doc: ParsedDoc): Input[] {
  const blocks = slim(doc.blocks.slice(0, 30))
  if (blocks.length === 0 || JSON.stringify(blocks).length > 300_000) return []
  const data = { fields: ['Name'], records: [{ Name: 'Ada' }, { Name: 'Bo' }] }
  return [{ args: { blocks, data } }]
}

const ROWS: string[][][] = [
  [],
  [['Name', 'Email'], ['Ada', 'ada@x.org'], ['Bo']],
  [[' Name ', ' Name ', 'constructor', '__proto__'], ['a', 'b', 'c', 'd', 'extra'], []],
  [['only header']],
  [
    ['', ''],
    ['x', 'y'],
  ],
]

const FILE_NAME_PATTERNS = [
  '',
  'Name',
  '{Name}-{Missing}',
  'a/b:c*d?',
  '..hidden',
  '   ',
  'x'.repeat(200),
  '{ Name }',
  '\u0001ctl\u007f',
  ' Postal Address ',
  'First',
  '{Name}{',
  '{}',
  '😀'.repeat(70),
  'ä'.repeat(121),
  '. . .',
  'Name.',
]

const mailMergeSpecs: CallSpec[] = [
  {
    fn: 'save.splitInstruction',
    call: (text) => splitInstruction(text),
    built: INSTRUCTIONS.map((text) => ({ text })),
  },
  {
    fn: 'save.mergeFieldName',
    call: (text) => mergeFieldName(text),
    built: INSTRUCTIONS.map((text) => ({ text })),
  },
  {
    fn: 'save.placeholderText',
    call: (text) => placeholderText(text),
    built: ['Name', '', '«', 'a b'].map((text) => ({ text })),
  },
  {
    fn: 'save.mergeFieldInstruction',
    call: (text) => mergeFieldInstruction(text),
    built: ['Name', 'a "b" c', '', '"', '\\'].map((text) => ({ text })),
  },
  {
    fn: 'save.mergeOutputFileName',
    call: (text, args) =>
      mergeOutputFileName(text, args.record as MergeRecord, args.fields as string[]),
    listed: mergeFileNameLongAstral,
    built: FILE_NAME_PATTERNS.flatMap((text) =>
      RECORDS.flatMap((record) =>
        [['Name', 'First'], [], ['Postal Address']].map((fields) => ({
          text,
          args: { record, fields },
        })),
      ),
    ),
  },
  {
    fn: 'save.mergeFieldSwitches',
    call: (text) => mergeFieldSwitches(text),
    built: INSTRUCTIONS.map((text) => ({ text })),
  },
  {
    fn: 'save.mergeFieldText',
    call: (text, args) => mergeFieldText(text, args.record as MergeRecord),
    built: mergeCases(INSTRUCTIONS),
  },
  {
    fn: 'save.valueOf',
    call: (text, args) => valueOf(args.record as MergeRecord, text),
    built: mergeCases([
      'Name',
      'Missing',
      '',
      'constructor',
      '__proto__',
      'toString',
      'Postal Address',
    ]),
  },
  {
    fn: 'save.compareOperands',
    call: (_text, args) =>
      compareOperands(
        String(args.left),
        String(args.op),
        String(args.right),
        args.record as MergeRecord,
      ),
    built: [
      ['«Age»', '"42"', '«Zero»'],
      ['9', '50', '«A»'],
      ['"a b"', '«Name»', '"A"'],
      ['«A»', '«B»', '1e3'],
      ['x', '"x"', ''],
      [' 7 ', '7.0', '«Age»'],
      ['.5', '0.50', '-.5'],
      ['+3', '3', '"3"'],
      ['«Name»', '"ß straße"', '«Missing»'],
    ].flatMap(([left, other, third]) =>
      ['=', '<>', '<', '<=', '>', '>=', '==', '', '!='].flatMap((op) =>
        RECORDS.flatMap((record) => [
          { args: { left, op, right: other, record } },
          { args: { left: third, op, right: left, record } },
        ]),
      ),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.conditionHolds',
    call: (text, args) => conditionHolds(text, args.record as MergeRecord),
    built: mergeCases(INSTRUCTIONS),
  },
  {
    fn: 'save.ifBranch',
    call: (text, args) => ifBranch(text, args.record as MergeRecord),
    built: mergeCases(INSTRUCTIONS),
  },
  {
    fn: 'save.controlEffect',
    call: (text, args) => controlEffect(text, args.record as MergeRecord),
    built: mergeCases(INSTRUCTIONS),
  },
  {
    fn: 'save.mergeRecords',
    call: (_text, args) =>
      mergeRecords(
        wire(args.blocks) as Block[],
        args.data as MergeData,
        args.startIndex as number | undefined,
      ),
    fromModel: mergeModelInputs,
    built: MERGE_DATA.flatMap((data) =>
      [undefined, 0, 1, 3, 99].map((startIndex) => ({
        args: {
          blocks: wire(MERGE_BLOCKS),
          data,
          ...(startIndex === undefined ? {} : { startIndex }),
        },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.mergeBlockTree',
    call: (_text, args) => mergeBlockTree(wire(args.blocks) as Block[], args.data as MergeData),
    fromModel: mergeModelInputs,
    built: MERGE_DATA.flatMap((data) =>
      [MERGE_BLOCKS, MERGE_BLOCKS.slice(0, 3), MERGE_BLOCKS.slice(7)].map((blocks) => ({
        args: { blocks: wire(blocks), data },
      })),
    ),
    mutation: 'none',
  },
  {
    fn: 'save.mergeDataFromRows',
    call: (_text, args) => mergeDataFromRows(args.rows as string[][]),
    built: ROWS.map((rows) => ({ args: { rows } })),
    mutation: 'none',
  },
]

// ---------------------------------------------------------------- content controls

const CONTENT_CONTROL_SPECS: ContentControlSpec[] = [
  {},
  { tag: 'tag-1', title: 'Title & <more> "q"', id: '123', lock: 'sdtLocked' },
  { lock: 'none', tag: 'only tag' },
  { lock: 'contentLocked', title: 'x' },
  { lock: 'sdtContentLocked', id: 'a&b' },
  { tag: '', title: '', id: '', lock: 'none' },
  { lock: 'bogus' as never, tag: 't' },
  { tag: 'ünï', title: '😀' },
]

const SDT_DOCUMENTS = [
  '<w:body><w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr></w:sdt><w:sdt><w:sdtPr><w:alias w:val="x"/><w:id w:val=\'41\'/></w:sdtPr></w:sdt></w:body>',
  '<w:sdtPr><w:id w:val="-5"/></w:sdtPr><w:sdtPr><w:id w:val="x"/></w:sdtPr>',
  '<w:sdtPr/><w:sdtPr><w:id/></w:sdtPr>',
  '<w:sdtPr><w:id w:val="99999999999999999999"/></w:sdtPr>',
  '<w:sdtPr><w:id w:val="3"/><w:id w:val="9"/></w:sdtPr>',
  '',
]

const contentControlSpecs: CallSpec[] = [
  {
    fn: 'save.buildContentControlXml',
    call: (_text, args) => buildContentControlXml(args.spec as ContentControlSpec),
    built: CONTENT_CONTROL_SPECS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.nextContentControlId',
    call: (text) => nextContentControlId(text),
    fromDocument: part('word/document.xml'),
    built: SDT_DOCUMENTS.map((text) => ({ text })),
  },
  {
    fn: 'save.isContentControlLock',
    call: (_text, args) => isContentControlLock(args.value),
    built: [
      'none',
      'sdtLocked',
      'contentLocked',
      'sdtContentLocked',
      'x',
      '',
      'None',
      1,
      null,
      true,
      ['none'],
    ].map((value) => ({ args: { value } })),
    mutation: 'none',
  },
]

// ---------------------------------------------------------------- docProps and Zotero

const VT = 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"'
const FMTID = 'fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"'
const CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Old &amp; Title</dc:title><dc:creator>Kim</dc:creator><cp:revision>3</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2020-01-01T00:00:00Z</dcterms:created></cp:coreProperties>'
const CORE_BARE = '<coreProperties><title>x</title><title>y</title></coreProperties>'
const APP =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>Normal.dotm</Template><Pages>1</Pages><Application>Word</Application><DocSecurity>0</DocSecurity></Properties>'
const APP_EMPTY =
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>'
const CUSTOM =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ${VT}>` +
  `<property ${FMTID} pid="2" name="Count"><vt:i4>5</vt:i4></property>` +
  `<property ${FMTID} pid="3" name="Flag"><vt:bool>true</vt:bool></property>` +
  `<property ${FMTID} pid="4" name="Ratio"><vt:r8>1.5</vt:r8></property>` +
  `<property ${FMTID} pid="5" name="When"><vt:filetime>2020-01-01T00:00:00Z</vt:filetime></property>` +
  `<property ${FMTID} pid="6" name="Text"><vt:lpwstr>t</vt:lpwstr></property>` +
  `<property ${FMTID} pid="7" name="Small"><vt:i1>5</vt:i1></property>` +
  `<property ${FMTID} pid="8" name="ZOTERO_PREF_1"><vt:lpwstr>old</vt:lpwstr></property></Properties>`
const CUSTOM_PREFIXED = `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:v="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property ${FMTID} pid="9" name="A"><v:i4>1</v:i4></property></Properties>`
const CUSTOM_EMPTY = `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ${VT}/>`

const CORE_CHANGES: Array<Record<string, string | null>> = [
  { title: 'New <T>', creator: null },
  { subject: 'S', keywords: 'k1; k2', description: 'd & d', lastModifiedBy: 'LM', revision: '4' },
  { created: '2024-01-01T00:00:00Z', modified: '2024-02-02T00:00:00Z' },
  { category: 'c', contentStatus: 'draft', identifier: 'id', language: 'en-US', version: '1' },
  { title: null, creator: null, revision: null },
  { constructor: 'x', ['__proto__']: 'y', unknown: 'z', title: 'ok' },
  {},
]
const APP_CHANGES: Array<Record<string, string | null>> = [
  { company: 'Acme & Co', manager: 'M' },
  { template: null, pages: '9', words: '100', characters: '500' },
  { application: 'SeuOffice', appVersion: '0.1', docSecurity: '1', totalTime: '5' },
  {
    lines: '2',
    paragraphs: '3',
    scaleCrop: 'false',
    linksUpToDate: 'false',
    sharedDoc: 'false',
    hyperlinksChanged: 'false',
    charactersWithSpaces: '1',
  },
  { constructor: 'x', company: null },
]
const CUSTOM_CHANGES: Array<Record<string, PropertyValue | null>> = [
  { Count: 7, Flag: false, Ratio: 2.25, Text: 'new', Small: 500 },
  { Count: 3000000000, Small: 'x', Flag: 'TRUE', Ratio: '1e3', When: '2024-03-04', Text: 5 },
  {
    Count: '12',
    Flag: 1,
    Ratio: Infinity as never,
    When: '2024-03-04T05:06:07.123+02:00',
    Text: true,
  },
  {
    Brand: 'new',
    Num: 5,
    Big: 2 ** 40,
    Float: 0.5,
    Yes: true,
    NaNValue: NaN as never,
    Huge: 1e30,
    Neg: -2147483649,
  },
  { Count: null, Flag: null, Missing: null },
  { ZOTERO_PREF_1: 'x', constructor: 'c' },
  { When: 'tomorrow', Ratio: 'abc' },
]

const PROPERTY_PACKAGES: Array<Array<[string, string]>> = [
  [],
  [
    ['docProps/core.xml', CORE],
    ['docProps/app.xml', APP],
    ['docProps/custom.xml', CUSTOM],
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://x/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
  ],
  [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    ],
  ],
  [
    ['docProps/core.xml', CORE_BARE],
    ['docProps/app.xml', APP_EMPTY],
    ['docProps/custom.xml', CUSTOM_EMPTY],
  ],
  [
    ['docProps/custom.xml', CUSTOM_PREFIXED],
    [
      '[Content_Types].xml',
      '<Types><Override PartName="/docProps/core.xml" ContentType="x"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    ],
  ],
]
const PACKAGE_CHANGES: PropertyChanges[] = [
  { core: { title: 'T', creator: 'C' } },
  { app: { company: 'Co' }, custom: { Count: 5, Name: 'n' } },
  { clear: 'all' },
  { clear: 'all', core: { title: 'after clear' }, custom: { K: 1 } },
  { core: { title: null }, app: {}, custom: {} },
  { custom: { Flag: true } },
  {},
]

const wireChanges = (changes: unknown): PropertyChanges => wire(changes) as PropertyChanges

const PARSE_INPUTS: Array<Record<string, unknown>> = [
  {
    core: { title: 'T', creator: null },
    app: { company: 'C' },
    custom: { n: 1, b: true, s: 'x', z: null },
  },
  { clear: 'all' },
  { clear: 'all', core: { title: 'x' } },
  { clear: 'nothing' },
  { clear: null },
  {},
  { core: {} },
  { core: null },
  { core: [] },
  { core: 'x' },
  { app: { bogus: 'x' } },
  { core: { bogus: 'x' } },
  { core: { title: 5 } },
  { app: { company: true } },
  { custom: { x: {} } },
  { custom: { x: [1] } },
  { custom: { 2: 'b', 1: 'a', z: 'c' } },
  { core: { revision: '1' }, custom: { __proto__x: 1 } },
  { custom: { constructor: 'c', ['__proto__']: 'p' } },
  { custom: 0 },
  { custom: '' },
  { app: false },
  { core: { title: null, subject: null }, app: { manager: null } },
]

const ZOTERO_DATA = [
  '',
  'short',
  'x'.repeat(255),
  'x'.repeat(256),
  `${'a'.repeat(254)}😀b`,
  `${'a'.repeat(255)}😀b`,
  '😀'.repeat(300),
  '<b> & "q"',
  'x'.repeat(2000),
]

const CHART_RIDS = [undefined, 'rId5', '', 'a"b']

const docPropsSpecs: CallSpec[] = [
  {
    fn: 'save.patchZoteroDocumentDataXml',
    call: (text, args) =>
      patchZoteroDocumentDataXml(args.absent === true ? null : text, String(args.data)),
    fromDocument: (parts) => {
      const text = parts.get('docProps/custom.xml')
      return text === undefined
        ? []
        : [
            { text, args: { data: 'Zotero data & <x>' } },
            { text, args: { data: 'y'.repeat(600) } },
          ]
    },
    built: [
      ...ZOTERO_DATA.flatMap((data) => [
        { text: CUSTOM, args: { data } },
        { text: CUSTOM_PREFIXED, args: { data } },
        { text: CUSTOM_EMPTY, args: { data } },
        { text: '', args: { absent: true, data } },
        { text: '<Properties>', args: { data } },
      ]),
      { text: '<a:Properties xmlns:a="x"/>', args: { data: 'p' } },
      { text: '<a:Properties xmlns:a="x"></a:Properties >', args: { data: 'p' } },
      {
        text: `<Properties>${'<property pid="x" name="ZOTERO_PREF"><vt:lpwstr>l</vt:lpwstr></property>'}<property pid="99999999999999999999" name="n"/></Properties>`,
        args: { data: 'q' },
      },
    ],
  },
  {
    fn: 'save.patchCorePropertiesXml',
    call: (text, args) =>
      patchCorePropertiesXml(text, wire(args.changes) as Record<string, string | null>),
    fromDocument: (parts) => {
      const text = parts.get('docProps/core.xml')
      return text === undefined
        ? []
        : CORE_CHANGES.slice(0, 4).map((changes) => ({ text, args: { changes } }))
    },
    built: [CORE, CORE_BARE, '', '<cp:coreProperties/>'].flatMap((text) =>
      CORE_CHANGES.map((changes) => ({ text, args: { changes } })),
    ),
    argMutation: true,
  },
  {
    fn: 'save.patchAppPropertiesXml',
    call: (text, args) =>
      patchAppPropertiesXml(text, wire(args.changes) as Record<string, string | null>),
    fromDocument: (parts) => {
      const text = parts.get('docProps/app.xml')
      return text === undefined
        ? []
        : APP_CHANGES.slice(0, 4).map((changes) => ({ text, args: { changes } }))
    },
    built: [
      APP,
      APP_EMPTY,
      '',
      '<Properties><AppVersion>1</AppVersion><Template>t</Template></Properties>',
    ].flatMap((text) => APP_CHANGES.map((changes) => ({ text, args: { changes } }))),
    argMutation: true,
  },
  {
    fn: 'save.patchCustomPropertiesXml',
    call: (text, args) =>
      patchCustomPropertiesXml(text, wire(args.changes) as Record<string, PropertyValue | null>),
    fromDocument: (parts) => {
      const text = parts.get('docProps/custom.xml')
      return text === undefined
        ? []
        : [
            { text, args: { changes: { Brand: 'x', Num: 5 } } },
            { text, args: { changes: { Brand: null } } },
          ]
    },
    built: [CUSTOM, CUSTOM_PREFIXED, CUSTOM_EMPTY, ''].flatMap((text) =>
      CUSTOM_CHANGES.map((changes) => ({ text, args: { changes } })),
    ),
    argMutation: true,
  },
  {
    fn: 'save.parsePropertyChanges',
    call: (_text, args) => parsePropertyChanges(wire(args.input) as Record<string, unknown>),
    built: PARSE_INPUTS.map((input) => ({ args: { input } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.applyPropertyChanges',
    call: async (_text, args) => {
      const zip = zipOf(args.parts)
      await applyPropertyChanges(zip, wireChanges(args.changes))
      return partsOf(zip)
    },
    fromDocument: (parts) => {
      const picked = [...parts].filter(
        ([name]) =>
          name.startsWith('docProps/') || name === '[Content_Types].xml' || name === '_rels/.rels',
      )
      return picked.length === 0
        ? []
        : [{ args: { parts: picked, changes: { core: { title: 'T' }, custom: { Count: 1 } } } }]
    },
    built: PROPERTY_PACKAGES.flatMap((packageParts) =>
      PACKAGE_CHANGES.map((changes) => ({ args: { parts: packageParts, changes } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
]

// ---------------------------------------------------------------- chart

const CHARTS = [
  {
    kind: 'bar',
    title: 'Sales & <Costs>',
    categories: ['Q1', 'Q2', 'Q3'],
    series: [
      { name: 'A', values: [1, 2.5, null] },
      { name: 'B & b', values: [3, 4, 5, 6] },
    ],
  },
  { kind: 'line', categories: ['x'], series: [{ name: 'S', values: [] }] },
  { kind: 'pie', title: '', categories: ['a', 'b'], series: [{ name: 'P', values: [10, 20] }] },
  { kind: 'bar', categories: [], series: [] },
  {
    kind: 'line',
    title: 'T',
    categories: ['a', 'b', 'c'],
    series: Array.from({ length: 27 }, (_, i) => ({ name: `s${i}`, values: [i, -i, 1e21] })),
  },
  { kind: 'pie', categories: ['Ä', '😀'], series: [{ name: 'q', values: [0.1 + 0.2, -0, 1e-7] }] },
]

const CHART_PART = (title: string, series: string) =>
  `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>${title}<c:plotArea><c:barChart>${series}</c:barChart></c:plotArea></c:chart></c:chartSpace>`
const CHART_SER = (idx: number, name: string, cats: string[], vals: Array<number | null>) =>
  `<c:ser><c:idx val="${idx}"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="${cats.length}"/>${cats.map((c, i) => `<c:pt idx="${i}"><c:v>${c}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache></c:numRef></c:val></c:ser>`
const TITLE_RICH =
  '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Old</a:t></a:r><a:r><a:t> Title</a:t></a:r></a:p></c:rich></c:tx></c:title>'
const TITLE_EMPTY =
  '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:endParaRPr lang="en-US"/></a:p></c:rich></c:tx></c:title>'
const TITLE_STR =
  '<c:title><c:tx><c:strRef><c:f>S!$A$1</c:f><c:strCache><c:pt idx="0"><c:v>Cached</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title>'
const TITLE_BARE = '<c:title><c:overlay val="0"/></c:title>'
const TITLE_NOF = '<c:title><c:tx><c:strRef><c:f>S!$A$1</c:f></c:strRef></c:tx></c:title>'
const CHART_PARTS = [
  CHART_PART(
    TITLE_RICH,
    CHART_SER(0, 'S1', ['a', 'b', 'c'], [1, 2, 3]) +
      CHART_SER(1, 'S2', ['a', 'b', 'c'], [4, null, 6]),
  ),
  CHART_PART(TITLE_EMPTY, CHART_SER(0, 'S1', ['a', 'b'], [1])),
  CHART_PART(TITLE_STR, CHART_SER(0, 'S1', ['a'], [1])),
  CHART_PART(TITLE_BARE, ''),
  CHART_PART(TITLE_NOF, CHART_SER(0, 'S1', ['a', 'b'], [1, 2])),
  CHART_PART('', CHART_SER(0, 'S1', ['a'], [1])),
  '<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p/></c:rich></c:tx></c:title></c:chart></c:chartSpace>',
  '<c:chartSpace><c:chart><c:title></c:title></c:chart></c:chartSpace>',
  '<c:txPr/><c:tx/>',
  '',
]
const CHART_PATCHES: ChartPatch[] = [
  { title: 'New & Title' },
  { categories: ['A', null, 'C'] },
  { series: [{ name: 'N1', values: [10, null, 30] }, null] },
  { series: [null, { name: 'N2' }, { name: 'ignored', values: [1] }] },
  { title: '', categories: [], series: [] },
  {
    title: 'T',
    categories: ['x', 'y', 'z'],
    series: [{ name: 'a & b', values: [1.5, 2.5, 3.5] }, { values: [] }],
  },
  {},
]

let WORKBOOKS: string[]
let WORKBOOK_ARGS: Array<{
  categories: string[]
  series: Array<{ name: string; values: Array<number | null> }>
}> = []
{
  WORKBOOK_ARGS = [
    {
      categories: ['A', 'B', 'C'],
      series: [
        { name: 'S1', values: [1, 2, 3] },
        { name: 'S2', values: [4, null, 6] },
      ],
    },
    { categories: [], series: [] },
    { categories: ['only'], series: [{ name: 'x & y', values: [] }] },
    {
      categories: ['Ä', '😀'],
      series: Array.from({ length: 28 }, (_, i) => ({ name: `s${i}`, values: [i, 0.5] })),
    },
  ]
  WORKBOOKS = await Promise.all(
    WORKBOOK_ARGS.map((arg) => buildChartWorkbookXlsxBase64(arg.categories, arg.series)),
  )
}

const chartSpecs: CallSpec[] = [
  {
    fn: 'save.buildChartPartXml',
    call: (_text, args) =>
      buildChartPartXml(wire(args.chart) as never, args.externalDataRId as string | undefined),
    built: CHARTS.flatMap((chart) =>
      CHART_RIDS.map((externalDataRId) => ({
        args: { chart, ...(externalDataRId === undefined ? {} : { externalDataRId }) },
      })),
    ),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.patchChartPartXml',
    call: (text, args) => patchChartPartXml(text, wire(args.patch) as ChartPatch),
    fromDocument: (parts) =>
      [...parts]
        .filter(([name]) => /^word\/charts\/chart\d*\.xml$/.test(name))
        .flatMap(([, text]) =>
          CHART_PATCHES.slice(0, 4).map((patch) => ({ text, args: { patch } })),
        ),
    built: CHART_PARTS.flatMap((text) => CHART_PATCHES.map((patch) => ({ text, args: { patch } }))),
    argMutation: true,
  },
  {
    fn: 'save.buildChartWorkbookXlsxBase64',
    call: async (_text, args) =>
      workbookParts(
        await buildChartWorkbookXlsxBase64(args.categories as string[], wire(args.series) as never),
      ),
    built: WORKBOOK_ARGS.map((arg) => ({ args: arg })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.patchChartWorkbookXlsxBase64',
    call: async (_text, args) =>
      workbookParts(
        await patchChartWorkbookXlsxBase64(
          String(args.base64),
          args.categories as string[],
          wire(args.series) as never,
        ),
      ),
    built: [
      ...WORKBOOKS.flatMap((base64) => WORKBOOK_ARGS.map((arg) => ({ args: { base64, ...arg } }))),
      { args: { base64: 'not base64 !!', categories: ['a'], series: [] } },
      { args: { base64: '', categories: [], series: [] } },
      { args: { base64: 'UEsDBA==', categories: ['a'], series: [] } },
    ],
    mutation: 'none',
  },
]

// ---------------------------------------------------------------- bibliography, theme, watermark

const SOURCES_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
const SOURCES_XML =
  `<b:Sources SelectedStyle="\\IEEE2006OfficeOnline.xsl" StyleName="IEEE" Version="2006" xmlns:b="${SOURCES_NS}" xmlns="${SOURCES_NS}">` +
  '<b:Source><b:Tag>Smi20</b:Tag><b:SourceType>Book</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Smith</b:Last><b:First>A</b:First></b:Person><b:Person><b:Last>Doe</b:Last></b:Person></b:NameList></b:Author></b:Author><b:Title>T &amp; U</b:Title><b:Year>2020</b:Year><b:Publisher>P</b:Publisher><b:Pages>1-2</b:Pages></b:Source>' +
  '<b:Source><b:Tag>Lee21</b:Tag><b:SourceType>JournalArticle</b:SourceType><b:Author><b:Author><b:Corporate>Org</b:Corporate></b:Author></b:Author><b:Title>J</b:Title><b:Year>2021</b:Year><b:JournalName>Jrnl</b:JournalName></b:Source>' +
  '</b:Sources>'
const SOURCE_LIST: SourceInfo[] = [
  { tag: 'Smi20', type: 'Book', author: 'Smith, A', title: 'T & U', year: '2020', publisher: 'P' },
  {
    tag: 'New1',
    type: 'InternetSite',
    author: 'Brown',
    title: 'Site <1>',
    year: '2024',
    publisher: 'S',
    url: 'https://x.org/?a=1&b=2',
  },
  {
    tag: 'New2',
    type: 'Report',
    author: ', Only First',
    title: '',
    year: '',
    publisher: undefined,
  },
  {
    tag: 'New3',
    type: 'JournalArticle',
    author: 'A,B,C',
    title: 't',
    year: 'y',
    publisher: 'J',
    url: '',
  },
  { tag: 'New4', type: 'Misc', author: ' Last ,  First ', title: 'x', year: '1' },
  {
    tag: 'Smi20',
    type: 'Book',
    author: 'Smith, A',
    title: 'Changed',
    year: '2020',
    publisher: 'P',
  },
]
const sourceArgs = (xml: string | null): Input[] =>
  [[], SOURCE_LIST.slice(0, 1), SOURCE_LIST.slice(1), SOURCE_LIST, [SOURCE_LIST[5]!]].map(
    (sources) => ({
      text: xml ?? '',
      args: { sources, ...(xml === null ? { absent: true } : {}) },
    }),
  )

const THEME_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
const THEME_NO_EA =
  '<a:theme><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="A"/></a:majorFont><a:minorFont><a:latin typeface="B"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
const THEME_FONTS: ThemeFonts[] = [
  { major: 'Cambria', minor: 'Arial' },
  { major: 'Ma$&jor', minor: 'Mi"n<or>', eastAsia: 'SimSun' },
  { major: '$1$2', minor: '$$', eastAsia: "$'$`" },
  { major: '', minor: '', eastAsia: '' },
  { major: 'Ünï 😀', minor: 'x', eastAsia: 'MS Mincho' },
]
const THEME_COLOR_SETS: ThemeColors[] = [
  { accent1: 'FF0000', accent2: '00FF00', dk2: '112233' },
  { name: 'My & Scheme', lt2: 'abcdef', accent6: '$&$&' },
  { name: 'Q"uote', dk1: '000001', lt1: 'FFFFFE', hlink: '123456', folHlink: '654321' },
  { name: '', accent3: '' },
  {},
]

const themeSpecs: CallSpec[] = [
  {
    fn: 'save.applyThemeFonts',
    call: (text, args) => applyThemeFonts(text, wire(args.fonts) as ThemeFonts),
    fromDocument: (parts) => {
      const text = parts.get('word/theme/theme1.xml')
      return text === undefined
        ? []
        : THEME_FONTS.slice(0, 2).map((fonts) => ({ text, args: { fonts } }))
    },
    built: [THEME_XML, THEME_NO_EA, '', '<a:majorFont/>'].flatMap((text) =>
      THEME_FONTS.map((fonts) => ({ text, args: { fonts } })),
    ),
    argMutation: true,
  },
  {
    fn: 'save.applyThemeColors',
    call: (text, args) => applyThemeColors(text, wire(args.colors) as ThemeColors),
    fromDocument: (parts) => {
      const text = parts.get('word/theme/theme1.xml')
      return text === undefined
        ? []
        : THEME_COLOR_SETS.slice(0, 2).map((colors) => ({ text, args: { colors } }))
    },
    built: [THEME_XML, THEME_NO_EA, ''].flatMap((text) =>
      THEME_COLOR_SETS.map((colors) => ({ text, args: { colors } })),
    ),
    argMutation: true,
  },
  {
    fn: 'save.buildThemeXml',
    call: (_text, args) =>
      buildThemeXml(wire(args.fonts) as ThemeFonts, wire(args.colors) as ThemeColors),
    built: THEME_FONTS.flatMap((fonts) =>
      THEME_COLOR_SETS.map((colors) => ({ args: { fonts, colors } })),
    ),
    mutation: 'none',
    argMutation: true,
  },
]

const TEXT_WATERMARKS: Array<string | WatermarkSpec> = [
  'DRAFT',
  '',
  'A & <B> "C"',
  { text: 'CONFIDENTIAL' },
  {
    text: 'x',
    fontFamily: 'Arial',
    colorHex: '#FF0000',
    opacity: 0.25,
    diagonal: false,
    bold: true,
    italic: true,
  },
  { text: 'y', colorHex: 'abcdef', opacity: 2, diagonal: true },
  { text: 'z', opacity: -1, fontFamily: '"Q"', colorHex: '' },
  { text: 'boxed', boxPt: { widthPt: 300.5, heightPt: 50 }, sizePt: 40 },
  { text: 'tall text that is long enough to widen the automatic box', bold: true },
  { text: '😀', fontFamily: '' },
]
const PICTURES: PictureWatermarkSpec[] = [
  { image: { base64: 'AAAA', mime: 'image/png', widthPx: 300, heightPx: 200 } },
  {
    image: { base64: 'AAAA', mime: 'image/jpeg', widthPx: 96, heightPx: 96 },
    scale: 50,
    washout: false,
  },
  { image: { base64: 'AAAA', mime: 'image/gif', widthPx: 1, heightPx: 1 }, scale: 0 },
  { image: { base64: 'AAAA', mime: 'image/png', widthPx: 3000, heightPx: 10 }, washout: true },
  { image: { base64: 'AAAA', mime: 'image/png', widthPx: 0, heightPx: 0 } },
]
const MARGIN_BOXES = [
  undefined,
  { widthPt: 400, heightPt: 600 },
  { widthPt: 0, heightPt: 0 },
  { widthPt: 100.123, heightPt: 33.333 },
]

const watermarkSpecs: CallSpec[] = [
  {
    fn: 'save.watermarkParagraphXml',
    call: (_text, args) => watermarkParagraphXml(wire(args.spec) as WatermarkSpec | string),
    built: TEXT_WATERMARKS.map((spec) => ({ args: { spec } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'save.pictureWatermarkParagraphXml',
    call: (_text, args) =>
      pictureWatermarkParagraphXml(
        wire(args.spec) as PictureWatermarkSpec,
        String(args.rId),
        (args.marginBox ?? null) as { widthPt: number; heightPt: number } | null,
      ),
    built: PICTURES.flatMap((spec) =>
      ['rId1', 'a"b&c', ''].flatMap((rId) =>
        MARGIN_BOXES.map((marginBox) => ({
          args: { spec, rId, ...(marginBox ? { marginBox } : {}) },
        })),
      ),
    ),
    mutation: 'none',
    argMutation: true,
  },
]

const bibliographySpecs: CallSpec[] = [
  {
    fn: 'save.buildSourcesXml',
    call: (text, args) =>
      buildSourcesXml(wire(args.sources) as SourceInfo[], args.absent === true ? null : text),
    fromDocument: (parts) =>
      [...parts]
        .filter(
          ([name, text]) => /^customXml\/item\d+\.xml$/.test(name) && text.includes('<b:Sources'),
        )
        .flatMap(([, text]) => [
          { text, args: { sources: parseSourcesXml(text) } },
          { text, args: { sources: [...parseSourcesXml(text).slice(1), SOURCE_LIST[1]!] } },
        ]),
    built: [
      ...sourceArgs(SOURCES_XML),
      ...sourceArgs(null),
      ...sourceArgs(''),
      ...sourceArgs('<b:Sources/>'),
      ...sourceArgs(
        '<b:Sources><b:Source><b:Tag>Smi20</b:Tag></b:Source><b:Source><b:Tag></b:Tag></b:Source></b:Sources>',
      ),
    ],
    argMutation: true,
  },
  {
    fn: 'save.buildSourcesItemPropsXml',
    call: () => buildSourcesItemPropsXml(),
    built: [{ args: {} }],
    mutation: 'none',
  },
]

const HASH = 'ab'.repeat(32)
const indexSpecs: CallSpec[] = [
  {
    fn: 'save.parseLazyMediaUrl',
    call: (text) => parseLazyMediaUrl(text),
    built: [
      `seuoffice-docx-media://${HASH}/word/media/image1.png`,
      `seuoffice-docx-media://${HASH}/word/media/ä%20b%23.png`,
      `seuoffice-docx-media://${HASH}/word/media/%E0%A4%A.png`,
      `seuoffice-docx-media://${HASH}/word/../x.png`,
      `seuoffice-docx-media://${HASH}/word/%2e%2e/x.png`,
      `seuoffice-docx-media://${HASH}/%00`,
      `seuoffice-docx-media://${HASH}/${'a'.repeat(513)}`,
      `seuoffice-docx-media://${HASH}/${'a'.repeat(512)}`,
      `seuoffice-docx-media://${HASH}/`,
      `seuoffice-docx-media://${HASH.toUpperCase()}/x`,
      `seuoffice-docx-media://${HASH.slice(1)}/x`,
      `seuoffice-docx-media://${HASH}/a\nb`,
      `other://${HASH}/x`,
      '',
    ].map((text) => ({ text })),
  },
  {
    fn: 'save.revisionDateBefore',
    call: (text, args) =>
      revisionDateBefore(
        args.absent === true ? undefined : text,
        args.beforeMs === null ? NaN : (args.beforeMs as number),
      ),
    built: [
      '2024-01-01T00:00:00Z',
      '2024-01-01 00:00',
      '2024-01-01T00:00:00.5+02:00',
      'not a date',
      '',
      '2024-13-01T00:00:00Z',
      'Mon, 01 Jan 2024 00:00:00 GMT',
    ].flatMap((text) =>
      [0, 1704067200000, 1704067199999, 4102444800000, null, -1].flatMap((beforeMs) => [
        { text, args: { beforeMs } },
        { text, args: { beforeMs, absent: true } },
      ]),
    ),
    mutation: 'none',
  },
]

export const SAVE_FEATURES: CallSpec[] = [
  ...indexSpecs,
  compareSpec,
  ...mailMergeSpecs,
  ...contentControlSpecs,
  ...docPropsSpecs,
  ...chartSpecs,
  ...bibliographySpecs,
  ...themeSpecs,
  ...watermarkSpecs,
]
