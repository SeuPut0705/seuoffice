// Group `revision`: revision-xml.ts, accept / reject over raw WordprocessingML.
import {
  applyRevisionResolutions,
  applyTrackedChangesXml,
  cleanMoveRangeMarkers,
  countTrackedChangesXml,
  readPropChangeXml,
  resolvePropChangeXml,
  type RevisionResolution,
  type RevisionXmlFilter,
  type RevisionXmlMode,
} from './reference/revision-xml'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

const at = (id: string, author = 'kim', date = '2024-01-01T00:00:00Z'): string =>
  ` w:id="${id}" w:author="${author}" w:date="${date}"`
const run = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`
const para = (inner: string, pPr = ''): string => `<w:p>${pPr}${inner}</w:p>`
const markPPr = (marker: string, rPrBefore = ''): string =>
  `<w:pPr><w:jc w:val="left"/><w:rPr>${rPrBefore}${marker}</w:rPr></w:pPr>`
const tc = (tcPr: string, text: string): string => `<w:tc>${tcPr}${para(run(text))}</w:tc>`
const doc = (body: string): string =>
  `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:body></w:document>`

const INS = `<w:ins${at('1')}>${run('new')}</w:ins>`
const DEL =
  `<w:del${at('2', 'lee', '2023-06-01T10:00:00+09:00')}><w:r><w:delText xml:space="preserve">gone </w:delText>` +
  `<w:delInstrText> PAGE </w:delInstrText><w:delText/></w:r></w:del>`
const MOVE =
  `<w:moveFromRangeStart w:id="10" w:name="m"${at('10')}/>` +
  para(`<w:moveFrom${at('11')}>${run('moved')}</w:moveFrom>`) +
  `<w:moveFromRangeEnd w:id="10"/>` +
  `<w:moveToRangeStart w:id="12" w:name="m"${at('12', 'park')}/>` +
  para(`<w:moveTo${at('13', 'park')}>${run('moved')}</w:moveTo>`) +
  `<w:moveToRangeEnd w:id="12"/>`

const PARA_MARKS = (marker: string): string[] => [
  // a bookmark between, the next paragraph keeps its pPr
  para(run('a'), markPPr(marker)) +
    `<w:bookmarkEnd w:id="0"/><w:proofErr w:type="spellStart"/>` +
    para(run('b'), '<w:pPr><w:jc w:val="center"/></w:pPr>'),
  // rPr with other children, next paragraph without pPr
  para(run('a'), markPPr(marker, '<w:b/>')) + para(run('b')),
  para(run('a'), markPPr(marker)) + '<w:p/>',
  para(run('a'), markPPr(marker)) + `<w:tbl><w:tr>${tc('', 'c')}</w:tr></w:tbl>`,
  para(run('last'), markPPr(marker)),
  // a bookmarkStart then something that stops the search
  para(run('a'), markPPr(marker)) + `<w:bookmarkStart w:id="1"/><w:sdt/>` + para(run('b')),
]

const ROWS =
  `<w:tbl><w:tblPr><w:tblW w:w="0"/></w:tblPr>` +
  `<w:tr><w:trPr><w:cantSplit/><w:ins${at('30')}/></w:trPr>${tc('', 'r1')}</w:tr>` +
  `<w:tr><w:trPr><w:del${at('31')}/></w:trPr>${tc('', 'r2')}</w:tr>` +
  `<w:tr>${tc('<w:tcPr><w:cellIns' + at('32') + '/></w:tcPr>', 'c1')}` +
  `${tc('<w:tcPr><w:tcW w:w="5"/><w:cellDel' + at('33') + '/></w:tcPr>', 'c2')}` +
  `${tc('<w:tcPr><w:cellMerge' + at('34') + ' w:vMerge="cont" w:vMergeOrig="rest"/></w:tcPr>', 'c3')}</w:tr>` +
  `</w:tbl>`

const NUMBERING = para(
  run('item'),
  `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:numberingChange${at('40')} w:original="%1."/></w:numPr></w:pPr>`,
)

const RPR_CHANGES = [
  `<w:r><w:rPr><w:b/><w:rPrChange${at('50')}><w:rPr><w:i/><w:rStyle w:val="$&amp;$1"/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r>`,
  `<w:r><w:rPr><w:b/><w:rPrChange${at('51')}><w:rPr/></w:rPrChange></w:rPr><w:t>x</w:t></w:r>`,
  `<w:r><w:rPr><w:b/><w:rPrChange${at('52')}><w:rPr> </w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r>`,
  `<w:r><w:rPr><w:b/><w:rPrChange${at('53')}></w:rPrChange></w:rPr><w:t>x</w:t></w:r>`,
  `<w:r><w:rPr><w:b/><w:rPrChange${at('54')}/></w:rPr><w:t>x</w:t></w:r>`,
  // the record outside its holder
  `<w:r><w:rPrChange${at('55')}><w:rPr><w:i/></w:rPr></w:rPrChange><w:t>x</w:t></w:r>`,
]

const PPR_CHANGES = [
  para(
    run('p'),
    `<w:pPr><w:jc w:val="center"/><w:pPrChange${at('60')}><w:pPr><w:ind w:left="720"/></w:pPr></w:pPrChange>` +
      `<w:rPr><w:b/></w:rPr><w:sectPr><w:pgSz w:w="1"/></w:sectPr></w:pPr>`,
  ),
  para(
    run('p'),
    `<w:pPr><w:pPrChange${at('61')}><w:pPr/></w:pPrChange><w:jc w:val="center"/><w:rPr><w:ins${at('62')}/></w:rPr></w:pPr>`,
  ),
  para(run('p'), `<w:pPr><w:jc w:val="center"/><w:pPrChange${at('63')}/></w:pPr>`),
  // the record first in its holder: the restored properties and the record's removal share a start
  para(
    run('p'),
    `<w:pPr><w:pPrChange${at('64')}><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange></w:pPr>`,
  ),
]

// a mark written with a close tag (no paragraph-mark or cell marker) and the
// record after it: the mark's edit and the record's revert share a start, and
// the longer one, the revert, is the one kept
const SAME_START = (['Ins', 'Del'] as const).flatMap((mark) => [
  para(
    `<w:r><w:rPr><w:${mark.toLowerCase()}${at('120')}></w:${mark.toLowerCase()}>` +
      `<w:rPrChange${at('121')}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r>`,
  ),
  `<w:tbl><w:tr>${tc(
    `<w:tcPr><w:cell${mark}${at('122')}></w:cell${mark}>` +
      `<w:tcPrChange${at('123')}><w:tcPr><w:tcW w:w="9"/></w:tcPr></w:tcPrChange></w:tcPr>`,
    'c',
  )}</w:tr></w:tbl>`,
])

const afterMarkRPr = (rPr: string, before = ''): string =>
  para(
    run('p'),
    `<w:pPr>${before}${rPr}<w:pPrChange${at('135')}><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrChange></w:pPr>`,
  )

// a paragraph-mark rPr first in its pPr, before the record: where the reject
// removes that rPr whole, its removal starts where the old properties go in
const PPR_AFTER_MARK_RPR = [
  afterMarkRPr(`<w:rPr><w:ins${at('130')}/></w:rPr>`),
  afterMarkRPr(`<w:rPr><w:del${at('131')}/></w:rPr>`),
  afterMarkRPr(`<w:rPr><w:rPrChange${at('132')}><w:rPr/></w:rPrChange></w:rPr>`),
  // the rPr keeps a child, or white space stands before it
  afterMarkRPr(`<w:rPr><w:ins${at('133')}/><w:b/></w:rPr>`),
  afterMarkRPr(`<w:rPr><w:ins${at('134')}/></w:rPr>`, ' '),
]

const SECT_CHANGE =
  `<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgSz w:w="11906"/>` +
  `<w:footerReference w:type="first" r:id="rId2"/>` +
  `<w:sectPrChange${at('70')}><w:sectPr><w:pgSz w:w="12240"/></w:sectPr></w:sectPrChange></w:sectPr>`

const TABLE_CHANGES =
  `<w:tbl><w:tblPr><w:tblW w:w="100"/><w:tblPrChange${at('80')}><w:tblPr/></w:tblPrChange></w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="10"/><w:tblGridChange w:id="81"><w:tblGrid><w:gridCol w:w="20"/></w:tblGrid></w:tblGridChange></w:tblGrid>` +
  `<w:tr><w:tblPrEx><w:jc w:val="left"/><w:tblPrExChange${at('82')}><w:tblPrEx/></w:tblPrExChange></w:tblPrEx>` +
  `<w:trPr><w:jc w:val="left"/><w:ins${at('83')}/><w:trPrChange${at('84')}><w:trPr><w:cantSplit/></w:trPr></w:trPrChange></w:trPr>` +
  `${tc('<w:tcPr><w:tcW w:w="5"/><w:tcPrChange' + at('85') + '><w:tcPr><w:tcW w:w="9"/></w:tcPr></w:tcPrChange></w:tcPr>', 'c')}</w:tr>` +
  `<w:tr><w:trPr><w:trPrChange${at('86')}><w:trPr/></w:trPrChange></w:trPr>` +
  `${tc('<w:tcPr><w:tcPrChange' + at('87') + '/></w:tcPr>', 'd')}</w:tr></w:tbl>`

// a grid change whose old grid is empty: the grid stays on reject, where any
// other holder with nothing to restore is removed. Tables of their own, with
// no other change in them, so that no listed class sets them aside.
const EMPTY_GRID_CHANGES = ['<w:tblGrid/>', '<w:tblGrid> </w:tblGrid>'].map(
  (old) =>
    `<w:tbl><w:tblGrid><w:gridCol w:w="10"/><w:tblGridChange w:id="88">${old}</w:tblGridChange></w:tblGrid>` +
    `<w:tr>${tc('', 'g')}</w:tr></w:tbl>`,
)

const NESTED = [
  para(`<w:del${at('90')}><w:ins${at('91', 'lee')}>${run('both')}</w:ins></w:del>`),
  para(
    `<w:ins${at('92')}><w:r><w:rPr><w:rPrChange${at('93')}><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t>f</w:t></w:r></w:ins>`,
  ),
  `<w:sdt><w:sdtContent>${para(INS)}${para(DEL)}</w:sdtContent></w:sdt>`,
  `<w:tbl><w:tr>${tc('', 'x')
    .replace('<w:r>', `<w:ins${at('94')}><w:r>`)
    .replace('</w:r>', '</w:r></w:ins>')}</w:tr></w:tbl>`,
]

const ODD = [
  `<w:ins w:id="1"/>`,
  para(`<w:ins${at('100')}/>${run('x')}`),
  para(`<w:ins${at('101')}>${run('unclosed')}`),
  // an unclosed delText: the reject edit after it lands in the following text
  para(`<w:del${at('102')}><w:r><w:delText>한글 😀 텍스트 more</w:r></w:del>`),
  para(`<w:del${at('103')}><w:r><w:delText>😀</w:r></w:del>`),
  `<w:del${at('104')}><w:delText>`,
  `<w:del${at('105')}><w:delInstrText>가</w:del>`,
  `<w:p><w:ins${at('106')}></w:p></w:ins>`,
  `<w:p><w:ins w:author='kim' w:id = "3">${run('q')}</w:ins><w:ins\tw:id="4"\nw:author="KİM" w:date="">${run('r')}</w:ins></w:p>`,
  para(
    `<w:ins w:id="abc">${run('a')}</w:ins><w:ins w:id="">${run('b')}</w:ins><w:del w:id="abc">${run('c')}</w:del>`,
  ),
  para(`<w:ins${at('107')}>${run("$& $1 $' $`")}</w:ins>${run('$&')}`),
  `<w:ins w:id="1"`,
  `<<w:del>>${run('x')}`,
  `</w:ins>${run('x')}`,
  `<!-- <w:ins w:id="1">x</w:ins> --><![CDATA[<w:del w:id="2"/>]]><?pi <w:rPrChange/> ?>`,
  `<!-- <w:ins w:id="1"> -->${para(`<w:ins${at('108')}>${run('x')}</w:ins>`)}<![CDATA[</w:ins>]]>`,
  `<w:fooChange w:id="1"/>${run('x')}`,
  `<w:ins${at('109')}>`,
  '',
  'plain text',
]

const MOVE_EDGES = [
  // ends without starts and starts without ends
  `<w:moveFromRangeEnd w:id="1"/>${para(INS)}<w:moveToRangeStart w:id="2"/>`,
  // a moveFrom start and a moveTo end sharing an id
  `<w:moveFromRangeStart${at('5')}/>${para(INS)}<w:moveToRangeEnd w:id="5"/>`,
  // a duplicated start id, one end
  `<w:moveFromRangeStart${at('7')}/><w:moveFromRangeStart${at('7')}/>${para(INS)}<w:moveFromRangeEnd w:id="7"/>`,
  // quotes and spaces the attribute reader of the plan does not take
  `<w:moveFromRangeStart w:id='8' w:author="kim"/>${para(INS)}<w:moveFromRangeEnd w:id = "8"/>`,
  `<w:moveToRangeStart w:id='9'/>${para(run('x'))}<w:moveToRangeEnd w:id = '9'/>`,
  `<w:moveToRangeStart w:id="9"/><w:moveToRangeStart w:id="9"/><w:moveToRangeEnd w:id="9"/>`,
  `<w:moveFromRangeEnd w:id="9"/><w:moveFromRangeStart w:id="9"/>`,
  `<w:moveFromRangeStart w:id="3"></w:moveFromRangeStart>${para(DEL)}<w:moveFromRangeEnd/>`,
]

/** non-ASCII text before a delText that reject mode renames: code units and bytes part there */
const BEFORE_DEL_TEXT = [
  doc(para(run('한글')) + para(DEL)),
  doc(para(run('😀')) + para(DEL)),
  doc(para(run('한 😀')) + para(`<w:del${at('110')}><w:r><w:delText>x</w:r></w:del>`)),
]

const XMLS: string[] = [
  ...EMPTY_GRID_CHANGES.map(doc),
  doc(para(INS + run('old')) + para(DEL)),
  doc(MOVE),
  ...PARA_MARKS(`<w:ins${at('20')}/>`).map(doc),
  ...PARA_MARKS(`<w:del${at('21')}/>`).map(doc),
  doc(ROWS),
  doc(NUMBERING),
  ...RPR_CHANGES.map((r) => doc(para(r))),
  ...PPR_CHANGES.map(doc),
  ...SAME_START.map(doc),
  ...PPR_AFTER_MARK_RPR.map(doc),
  `<w:body>${para(run('s'))}${SECT_CHANGE}</w:body>`,
  doc(TABLE_CHANGES),
  ...NESTED.map(doc),
  ...ODD,
  ...MOVE_EDGES,
  ...BEFORE_DEL_TEXT,
]

const MODES: unknown[] = ['accept', 'reject', '', 'other', 5]

/** every revision type, author, w:date form and id the filters meet */
const DATED = doc(
  [
    para(`<w:ins${at('1', 'kim', '2023-12-31T23:00:00Z')}>${run('a')}</w:ins>`),
    para(`<w:del${at('2', 'KIM', '2024-01-01T08:00:00+09:00')}>${run('b')}</w:del>`),
    para(`<w:ins w:id="3" w:author="lee">${run('c')}</w:ins>`),
    para(`<w:ins${at('4', 'lee', '')}>${run('d')}</w:ins>`),
    para(`<w:ins${at('5', 'kİm', 'garbage')}>${run('e')}</w:ins>`),
    para(`<w:del${at('6', 'park', 'Jan 5 2024 GMT')}>${run('f')}</w:del>`),
    para(`<w:del${at('7', 'park', '2024-01-01T24:00:00Z')}>${run('g')}</w:del>`),
    para(`<w:ins${at('abc', 'kim', '2023-06-01')}>${run('h')}</w:ins>`),
    `<w:moveFromRangeStart${at('8', 'lee', '2023-01-01T00:00:00Z')}/>`,
    para(`<w:moveFrom${at('9', 'lee', '2023-01-01T00:00:00Z')}>${run('m')}</w:moveFrom>`),
    `<w:moveFromRangeEnd w:id="8"/>`,
    RPR_CHANGES[0]!.replace('<w:r>', '<w:p><w:r>').replace(/<\/w:r>$/, '</w:r></w:p>'),
    para(
      run('t'),
      `<w:pPr><w:rPr><w:ins${at('10', 'kim', 'Tue, 02 Jan 2024 00:00:00 GMT')}/></w:rPr></w:pPr>`,
    ),
  ].join(''),
)

const FILTERS: unknown[] = [
  null,
  'str',
  [],
  {},
  5,
  { ids: ['1'] },
  { ids: ['1', 'abc', '8', '9'] },
  { ids: [] },
  { ids: 'abc' },
  { ids: '10' },
  { ids: [1] },
  { ids: null },
  { ids: 5 },
  { author: 'kim' },
  { author: 'KİM' },
  { author: '' },
  { author: 5 },
  { author: null },
  { type: 'insertion' },
  { type: 'deletion' },
  { type: 'formatting' },
  { type: 'move' },
  { type: 'bogus' },
  { type: null },
  { date: '2023-12-31T23:00:00Z' },
  { date: '' },
  { date: 5 },
  { before: '2024-01-01T00:00:00Z' },
  { before: '2024-01-01T09:00:00+09:00' },
  { before: '2024-01-02' },
  { before: '2024' },
  { before: '2024-01' },
  { before: 'Jan 5 2024 GMT' },
  { before: 'Tue, 02 Jan 2024 00:00:00 GMT' },
  { before: '1/6/2024 UTC' },
  { before: '2024-01-01T24:00:00Z' },
  { before: '+002024-01-02T00:00:00.000Z' },
  { before: 'garbage' },
  { before: '' },
  { before: null },
  { before: ['2024-01-02'] },
  { before: {} },
  { type: 'insertion', author: 'kim', before: '2024-06-01' },
  { ids: ['2'], author: 5 },
  { author: 5, type: 'move' },
]

/** a range whose start a filter takes and whose end it does not: the end goes with its start */
const SHARED_START_ID = doc(
  `<w:moveFromRangeStart${at('7', 'kim', '2023-01-01T00:00:00Z')} w:name="a"/>` +
    `<w:moveFromRangeStart${at('7', 'lee', '2025-01-01T00:00:00Z')} w:name="b"/>` +
    para(INS) +
    `<w:moveFromRangeEnd w:id="7"/>`,
)

/** an author type error is reached only when a revision is consulted */
const UNCONSULTED = ['', 'plain', `<w:moveFromRangeEnd w:id="1"/>`, `<!-- <w:ins/> -->`]

const APPLY_INPUTS: Input[] = [
  ...XMLS.flatMap((text) => MODES.map((mode) => ({ text, args: { mode } }))),
  ...FILTERS.flatMap((filter) =>
    ['accept', 'reject'].map((mode) => ({ text: DATED, args: { mode, filter } })),
  ),
  ...UNCONSULTED.map((text) => ({ text, args: { mode: 'accept', filter: { author: 5, ids: 5 } } })),
  // only the formatting rejected: the paragraph-mark rPr stays, the old properties come back
  ...PPR_AFTER_MARK_RPR.slice(0, 2).map((p) => ({
    text: doc(p),
    args: { mode: 'reject', filter: { type: 'formatting' } },
  })),
  ...[
    { author: 'kim' },
    { before: '2024-01-01T00:00:00Z' },
    { date: '2023-01-01T00:00:00Z' },
  ].flatMap((filter) =>
    ['accept', 'reject'].map((mode) => ({ text: SHARED_START_ID, args: { mode, filter } })),
  ),
  // local time: the answer depends on the zone of the host
  {
    text: para(`<w:ins${at('1', 'kim', '2024-01-01T08:00:00')}>${run('a')}</w:ins>`),
    args: { mode: 'accept', filter: { before: '2024-01-01T00:00:00Z' } },
  },
  {
    text: para(`<w:ins${at('1', 'kim', '2024-01-01T08:00:00Z')}>${run('a')}</w:ins>`),
    args: { mode: 'accept', filter: { before: '2024-01-01T12:00:00' } },
  },
  {
    text: para(`<w:ins${at('1', 'kim', 'Jan 1 2024 08:00')}>${run('a')}</w:ins>`),
    args: { mode: 'accept', filter: { before: '2024-01-01T00:00:00Z' } },
  },
]

const RESOLUTIONS: unknown[] = [
  [],
  null,
  [{ mode: 'accept' }],
  [{ mode: 'reject' }],
  [{ mode: 'reject', filter: { ids: ['1'] } }, { mode: 'accept' }],
  [
    { mode: 'accept', filter: { type: 'deletion' } },
    { mode: 'reject', filter: { author: 'kim' } },
  ],
  [{ mode: 'accept', filter: { author: 5 } }],
  [null],
  [{ mode: 'accept' }, null],
  'ab',
  '',
  5,
  true,
  {},
  [5],
  ['accept'],
  [{ mode: 1 }],
  [[]],
]

const RESOLUTION_INPUTS: Input[] = [
  ...[DATED, doc(MOVE), doc(TABLE_CHANGES), ...PPR_CHANGES.map(doc), ''].flatMap((text) =>
    RESOLUTIONS.map((resolutions) => ({ text, args: { resolutions } })),
  ),
  { text: DATED },
  ...XMLS.map((text) => ({
    text,
    args: { resolutions: [{ mode: 'reject', filter: { type: 'formatting' } }, { mode: 'accept' }] },
  })),
]

const CHANGE_NAMES = [
  'w:tblPrChange',
  'w:trPrChange',
  'w:tcPrChange',
  'w:tblGridChange',
  'w:tblPrExChange',
  'w:sectPrChange',
  'w:numberingChange',
  'w:cellMerge',
  'w:pPrChange',
  'w:rPrChange',
]

const ODD_NAMES = ['constructor', 'toString', '__proto__', 'w:(', '', 'w:ins']

const PROP_FRAGMENTS: string[] = [
  ...elementFragments(TABLE_CHANGES, 'w:tblPr'),
  ...elementFragments(TABLE_CHANGES, 'w:tblGrid'),
  ...EMPTY_GRID_CHANGES.flatMap((table) => elementFragments(table, 'w:tblGrid')),
  ...elementFragments(TABLE_CHANGES, 'w:tblPrEx'),
  ...elementFragments(TABLE_CHANGES, 'w:trPr'),
  ...elementFragments(TABLE_CHANGES, 'w:tcPr'),
  ...elementFragments(ROWS, 'w:tcPr'),
  ...elementFragments(NUMBERING, 'w:numPr'),
  ...PPR_CHANGES.flatMap((p) => elementFragments(p, 'w:pPr').slice(0, 1)),
  ...RPR_CHANGES.flatMap((r) => elementFragments(r, 'w:rPr').slice(0, 1)),
  ...SAME_START.flatMap((x) => [
    ...elementFragments(x, 'w:rPr').slice(0, 1),
    ...elementFragments(x, 'w:tcPr').slice(0, 1),
  ]),
  ...PPR_AFTER_MARK_RPR.flatMap((p) => elementFragments(p, 'w:pPr').slice(0, 1)),
  SECT_CHANGE,
  `<w:tcPr><w:cellMerge w:id="1" w:author="a" w:date="" w16du:dateUtc="2024-01-01T00:00:00Z" w:vMerge="" w:vMergeOrig="cont"/></w:tcPr>`,
  `<w:tcPr><w:cellMerge w:author='x' w:vMerge="rest"></w:cellMerge><w:cellMerge w:id="2"/></w:tcPr>`,
  `<w:trPr><w:trPrChange w:id="1"><w:trPr>${run('$&')}</w:trPr></w:trPrChange><w:trPrChange w:id="2"/></w:trPr>`,
  `<w:rPr><constructor/><toString w:id="7"/></w:rPr>`,
  `<w:tblPr><!-- <w:tblPrChange w:id="1"/> --></w:tblPr>`,
  `<w:tblPr><w:tblPrChangeX w:id="1"/></w:tblPr>`,
  `<w:tblPrChange w:id="1"><w:tblPr><w:jc/></w:tblPr></w:tblPrChange>`,
  `<w:tblPr><w:tblPrChange w:id="1"><w:tblPr><w:jc/></w:tblPr>`,
  '',
]

const FRAGMENT_NAMES = [...CHANGE_NAMES, ...ODD_NAMES]

const HOLDERS = [
  'w:tblPr',
  'w:trPr',
  'w:tcPr',
  'w:tblGrid',
  'w:tblPrEx',
  'w:pPr',
  'w:sectPr',
  'w:numPr',
  'w:rPr',
]

const partsOf = (parts: ReadonlyMap<string, string>): string[] =>
  [...parts]
    .filter(([name]) =>
      /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(name),
    )
    .map(([, text]) => text)

/** property fragments that hold a record, each with the names it holds and one it lacks */
const fragmentInputs = (parts: ReadonlyMap<string, string>): Input[] =>
  partsOf(parts).flatMap((xml) =>
    HOLDERS.flatMap((holder) =>
      elementFragments(xml, holder)
        .filter((text) => text.includes('Change') || text.includes('w:cellMerge'))
        .slice(0, 10)
        .flatMap((text) =>
          [...CHANGE_NAMES.filter((name) => text.includes(`<${name}`)), 'w:tblGridChange'].map(
            (changeName) => ({ text, args: { changeName } }),
          ),
        ),
    ),
  )

export const REVISION: CallSpec[] = [
  {
    fn: 'revision.countTrackedChangesXml',
    call: (text) => countTrackedChangesXml(text),
    fromDocument: (parts) => partsOf(parts).map((text) => ({ text })),
    built: [...XMLS, DATED, ...UNCONSULTED].map((text) => ({ text })),
  },
  {
    fn: 'revision.applyTrackedChangesXml',
    call: (text, args) =>
      applyTrackedChangesXml(
        text,
        args.mode as RevisionXmlMode,
        args.filter as RevisionXmlFilter | undefined,
      ),
    fromDocument: (parts) =>
      partsOf(parts).flatMap((text) => [
        { text, args: { mode: 'accept' } },
        { text, args: { mode: 'reject' } },
        { text, args: { mode: 'reject', filter: { type: 'insertion' } } },
      ]),
    built: APPLY_INPUTS,
  },
  {
    fn: 'revision.applyRevisionResolutions',
    call: (text, args) =>
      applyRevisionResolutions(text, args.resolutions as RevisionResolution[] | undefined),
    fromDocument: (parts) =>
      partsOf(parts).map((text) => ({
        text,
        args: {
          resolutions: [{ mode: 'accept', filter: { type: 'formatting' } }, { mode: 'reject' }],
        },
      })),
    built: RESOLUTION_INPUTS,
  },
  {
    fn: 'revision.readPropChangeXml',
    call: (text, args) => readPropChangeXml(text, args.changeName as string),
    fromDocument: fragmentInputs,
    built: PROP_FRAGMENTS.flatMap((text) =>
      FRAGMENT_NAMES.map((changeName) => ({ text, args: { changeName } })),
    ),
  },
  {
    fn: 'revision.resolvePropChangeXml',
    call: (text, args) =>
      resolvePropChangeXml(text, args.changeName as string, args.mode as RevisionXmlMode),
    fromDocument: (parts) =>
      fragmentInputs(parts).flatMap((input) =>
        ['accept', 'reject'].map((mode) => ({ ...input, args: { ...input.args, mode } })),
      ),
    built: PROP_FRAGMENTS.flatMap((text) =>
      FRAGMENT_NAMES.flatMap((changeName) =>
        ['accept', 'reject', 'other'].map((mode) => ({ text, args: { changeName, mode } })),
      ),
    ),
  },
  {
    fn: 'revision.cleanMoveRangeMarkers',
    call: (text) => cleanMoveRangeMarkers(text),
    fromDocument: (parts) => partsOf(parts).map((text) => ({ text })),
    built: [...MOVE_EDGES, doc(MOVE), DATED, ...ODD].map((text) => ({ text })),
  },
]
