import JSZip from 'jszip'
import { clipSheetXml, sheetXmlByteLimit, xlsxToText } from '../../packages/file-parse/src/xlsx'
import { hostileZipInputs } from './hostile'
import type { Input, Spec } from './spec'
import { fixtureBytes } from './zip-fixture'

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const REL = `${R}/`
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

type Rel = [id: string, type: string, target: string, mode?: string]
const rels = (items: Rel[]) =>
  `${DECL}<Relationships xmlns="${PKG}">${items
    .map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`)
    .join('')}</Relationships>`

const c = (ref: string | null, inner: string, attrs = '') => `<c${ref === null ? '' : ` r="${ref}"`}${attrs}>${inner}</c>`
const v = (value: string) => `<v>${value}</v>`
const f = (formula: string, attrs = '') => `<f${attrs}>${formula}</f>`
const row = (n: number, ...cells: string[]) => `<row r="${n}">${cells.join('')}</row>`
const sheet = (rows: string, extra = '') => `${DECL}<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData>${rows}</sheetData>${extra}</worksheet>`
const sst = (...items: string[]) => `${DECL}<sst xmlns="${S}" count="${items.length}">${items.join('')}</sst>`

interface Book {
  sheets: Array<[name: string, xml: string | null]>
  pr?: string
  definedNames?: string
  extraRels?: Rel[]
  files?: Record<string, string>
  rels?: string | null
}

function bookParts({ sheets, pr = '', definedNames = '', extraRels = [], files = {}, rels: relsXml }: Book): Record<string, string> {
  const parts: Record<string, string> = {
    'xl/workbook.xml': `${DECL}<workbook xmlns="${S}" xmlns:r="${R}">${pr}<sheets>${sheets
      .map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ''}</workbook>`,
  }
  const items: Rel[] = sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`])
  if (relsXml !== null) parts['xl/_rels/workbook.xml.rels'] = relsXml ?? rels([...items, ...extraRels])
  sheets.forEach(([, xml], i) => {
    if (xml !== null) parts[`xl/worksheets/sheet${i + 1}.xml`] = xml
  })
  return { ...parts, ...files }
}

async function zip(parts: Record<string, string | Uint8Array>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE'): Promise<Uint8Array> {
  const archive = new JSZip()
  for (const [name, data] of Object.entries(parts)) archive.file(name, data)
  return fixtureBytes(archive, compression)
}

const book = (spec: Book, compression?: 'STORE' | 'DEFLATE') => zip(bookParts(spec), compression)

/** Flips one byte of an entry's data: `at` counts from its start, a negative `at` from its end. */
function breakEntry(bytes: Uint8Array, name: string, at = 0): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer)
  const wanted = new TextEncoder().encode(name)
  for (let header = 0; header + 30 < out.length; header++) {
    if (view.getUint32(header, true) !== 0x04034b50) continue
    const nameLen = view.getUint16(header + 26, true)
    const extraLen = view.getUint16(header + 28, true)
    const found = out.subarray(header + 30, header + 30 + nameLen)
    if (nameLen === wanted.length && found.every((b, i) => b === wanted[i])) {
      const start = header + 30 + nameLen + extraLen
      const size = view.getUint32(header + 18, true)
      const index = at < 0 ? start + size + at : start + at
      out[index] ^= 0xff
      return out
    }
  }
  throw new Error(`entry ${name} not found`)
}

const STYLES = `${DECL}<styleSheet xmlns="${S}"><numFmts count="5">
<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="[h]:mm"/>
<numFmt numFmtId="166" formatCode="0.00"/><numFmt numFmtId="14" formatCode="0"/><numFmt numFmtId="-0" formatCode="hh:mm"/>
</numFmts><cellXfs count="9"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/>
<xf numFmtId="166"/><xf numFmtId="22"/><xf/><xf numFmtId="0x16"/><xf numFmtId=" 47 "/></cellXfs></styleSheet>`

const RICH_SST = sst(
  '<si><t>plain</t></si>',
  '<si><r><t>Bold</t></r><r><rPr><b/></rPr><t xml:space="preserve"> run</t></r></si>',
  '<si><r><t>1</t></r><t>2</t><r><t>3</t></r></si>',
  '<si><t>line_x000D_break _x005F_x0041_ _xD800_ _x0041_</t><rPh><t>phonetic</t></rPh></si>',
  '<si>bare text</si>',
  '<si/>',
  '<si><t>&amp;&lt;&#x41;&#66;</t></si>',
  '<si><t>  spaced  </t></si>',
)

const VALUES_SHEET = sheet(
  row(1, c('A1', v('0'), ' t="s"'), c('B1', v('1'), ' t="s"'), c('C1', v('2'), ' t="s"'), c('D1', v('3'), ' t="s"'),
    c('E1', v('4'), ' t="s"'), c('F1', v('5'), ' t="s"'), c('G1', v('6'), ' t="s"'), c('H1', v('7'), ' t="s"')) +
  row(2, c('A2', v(' 1 '), ' t="s"'), c('B2', v('1.5'), ' t="s"'), c('C2', v('-1'), ' t="s"'), c('D2', v('99'), ' t="s"'),
    c('E2', v(''), ' t="s"'), c('F2', '', ' t="s"'), c('G2', v('1e0'), ' t="s"'), c('H2', v('0x1'), ' t="s"')) +
  row(3, c('A3', v('1'), ' t="b"'), c('B3', v(' TRUE '), ' t="b"'), c('C3', v('0'), ' t="b"'), c('D3', v('yes'), ' t="b"'), c('E3', '', ' t="b"')) +
  row(4, c('A4', '<is><t>inline</t></is>', ' t="inlineStr"'), c('B4', '<is><r><t>in</t></r><r><t>line</t></r></is>', ' t="inlineStr"'),
    c('C4', '', ' t="inlineStr"'), c('D4', '<is>bare</is>', ' t="inlineStr"'), c('E4', v('ignored'), ' t="inlineStr"')) +
  row(5, c('A5', v('a_x000A_b'), ' t="str"'), c('B5', v('  12.50  ')), c('C5', v('1e3'), ' t="n"'), c('D5', v('#N/A'), ' t="e"'),
    c('E5', '<v>x</v><v>y</v>'), c('F5', '<v a="1">attr</v>'), c('G5', v('&#x1F600;'), ' t="str"')) +
  row(6, '<c>5</c>', '<c/>', c('C6', v('tail')))
)

const FORMULA_SHEET = sheet(
  row(1, c('A1', f('1+1') + v('2')), c('B1', f('SUM(A1:A3)')), c('C1', f('  ') + v('')), c('D1', f('NOW()') + v('   '))) +
  // the dependents come before their master in document order
  row(2, c('B2', f('', ' t="shared" si="0"')), c('C2', f('', ' t="shared" si="0"')), c('D2', f('', ' t="shared" si="9"'))) +
  row(3, c('A3', f('A1*$B$1+Sheet2!C1+\'Bob\'\'s\'!D4+"A1"+Table1[Q1]+SUM(B:B)+SUM(2:4)+$A1+A$1', ' t="shared" ref="A3:C9" si="0"') + v('7'))) +
  row(4, c('B4', f('', ' t="shared" si="0"')), c('a5', f('', ' t="shared" si="0"')), c(null, f('', ' t="shared" si="0"'))) +
  row(5, c('C5', f('A1048576+XFD1', ' t="shared" si="1"')), c('D6', f('', ' t="shared" si="1"')), c('B4', f('', ' t="shared" si="1"'))) +
  row(6, c('A0', f('A1', ' t="shared" si="2"')), c('B6', f('', ' t="shared" si="2"')), c('C6', f('Z1', ' t="shared" si="3"')), c('$D$7', f('', ' t="shared" si="3"'))) +
  row(7, c('A7', '<f t="shared" si="4">B1</f><f>C1</f>'), c('B7', f('', ' si="4"')), c('C7', f('lower(a1)+zz1+aaa1', ' t="shared" si="5"')), c('D8', f('', ' t="shared" si="5"')))
)

const NAN_ROW_SHEET = sheet(
  row(1, c(`A${'9'.repeat(400)}`, f('A1+1:2', ' t="shared" si="0"')), c(`B${'9'.repeat(400)}`, f('', ' t="shared" si="0"'))),
)
const NAN_COLUMN_SHEET = sheet(
  row(1, c(`${'A'.repeat(300)}1`, f('A1', ' t="shared" si="0"')), c(`${'B'.repeat(300)}2`, f('', ' t="shared" si="0"'))),
)

const DATE_SHEET = sheet(
  row(1, c('A1', v('45292'), ' s="1"'), c('B1', v('45292.5'), ' s="2"'), c('C1', v('1.75'), ' s="3"'), c('D1', v('3.14159'), ' s="4"'),
    c('E1', v('45292.25'), ' s="5"'), c('F1', v('0.5'), ' s="6"'), c('G1', v('45292'), ' s="7"'), c('H1', v('0.5'), ' s="8"')) +
  row(2, c('A2', v('45292'), ' s=" 2 "'), c('B2', v('45292'), ' s="2.0"'), c('C2', v('45292'), ' s="-0"'), c('D2', v('45292'), ' s="99"'),
    c('E2', v('45292'), ' s="2" t="n"'), c('F2', v('0'), ' s="2" t="s"'), c('G2', v(' '), ' s="2"'), c('H2', v('abc'), ' s="2"')) +
  row(3, c('A3', v('60'), ' s="2"'), c('B3', v('0'), ' s="2"'), c('C3', v('-1'), ' s="2"'), c('D3', v('1e20'), ' s="2"'), c('E3', v('2958466'), ' s="2"'),
    c('F3', f('TODAY()'), ' s="2"'), c('G3', v('45292'), ' s="1" t="str"'))
)

const PR = (flag: string) => `<workbookPr date1904="${flag}"/>`

function wideRows(count: number, text: (n: number) => string): string {
  let out = ''
  for (let n = 1; n <= count; n++) out += row(n, c(`A${n}`, v(text(n))), c(`B${n}`, v(String(n))))
  return out
}

const drawing = (pictures: number) =>
  `${DECL}<xdr:wsDr xmlns:xdr="${XDR}">${'<xdr:oneCellAnchor><xdr:pic><xdr:nvPicPr/></xdr:pic></xdr:oneCellAnchor>'.repeat(pictures)}<xdr:twoCellAnchor><xdr:sp/></xdr:twoCellAnchor></xdr:wsDr>`
const drawingSheet = (rows = '', attrs = ' r:id="rId1"') => sheet(rows, `<drawing${attrs}/>`)
const sheetRels = (target: string, id = 'rId1') => rels([[id, 'drawing', target]])

/** A defined name that mirrors one mark, as the gateway's `applyRedactionNameMirror` writes it. */
const mirror = (index: number, payload: unknown, escapeQuotes = false) => {
  const formula = `"${JSON.stringify(payload).replaceAll('"', '""')}"`
  const body = formula.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<definedName name="_gxRedaction_${index}" hidden="1">${escapeQuotes ? body.replaceAll('"', '&quot;') : body}</definedName>`
}
const mirrorMark = (sheet: number, from: [number, number], to: [number, number], label: string) => ({ v: 1, sheet, from, to, label })
const part = (sheets: unknown) => JSON.stringify({ version: 1, sheets })
const mark = (startRow: number, endRow: number, startColumn: number, endColumn: number, label: string, extra: Record<string, unknown> = {}) =>
  ({ startRow, endRow, startColumn, endColumn, label, ...extra })

const GRID_SHEET = sheet(
  row(1, c('A1', v('a1')), c('B1', v('b1')), c('C1', v('c1')), c('D1', v('d1'))) +
  row(2, c('A2', v('a2')), c('B2', v('secret b2')), c('C2', v('secret c2')), c('D2', v('d2'))) +
  row(3, c('A3', v('a3')), c('B3', v('secret b3')), c('C3', f('B2*2') + v('42')), c('D3', v('d3'))) +
  row(4, c('A4', v('a4')), c('b4', v('lower ref')), c(null, v('no ref')), c('C0', v('bad ref')), c('D4', v('1'), ' t="b"'))
)
const GRID_TWO = sheet(row(1, c('A1', v('other a1')), c('B1', v('other b1'))) + row(7, c('XFD7', v('far right'))))
const SHARED_MASTER_SHEET = sheet(
  row(1, c('A1', f('SECRET_RATE*B1', ' t="shared" ref="A1:A3" si="0"') + v('99'))) +
  row(2, c('A2', f('', ' t="shared" si="0"'))) +
  row(3, c('A3', f('', ' t="shared" si="0"') + v('3')))
)

async function redactionInputs(): Promise<Input[]> {
  const out: Input[] = []
  const add = async (label: string, spec: Book, maxChars?: number) =>
    out.push({ label: `withheld: ${label}`, bytes: await book(spec), args: maxChars === undefined ? {} : { maxChars: String(maxChars) } })
  const two: Book['sheets'] = [['Pay', GRID_SHEET], ['Other', GRID_TWO]]
  const withPart = (json: string, extra: Partial<Book> = {}): Book => ({ sheets: two, files: { 'xl/gxRedactions.json': json }, ...extra })

  await add('part rectangle B2:C3 on the first sheet', withPart(part([{ name: 'Pay', marks: [mark(1, 2, 1, 2, 'Salary')] }])))
  await add('part single cell A1 and far column on the second sheet', withPart(part([{ name: 'Other', marks: [mark(0, 0, 0, 0, 'Name'), mark(6, 6, 16383, 16383, 'Far')] }])))
  await add('part marks on both sheets, first mark wins on overlap', withPart(part([
    { name: 'Pay', marks: [mark(1, 1, 1, 1, 'First'), mark(0, 3, 0, 3, 'Whole')] },
    { name: 'Other', marks: [mark(0, 0, 1, 1, 'B1 only')] },
  ])))
  await add('part withholds cells without a readable ref', withPart(part([{ name: 'Pay', marks: [mark(99, 99, 99, 99, 'Elsewhere')] }])))
  await add('part lower-case ref is covered', withPart(part([{ name: 'Pay', marks: [mark(3, 3, 1, 1, 'Lower')] }])))
  await add('part withholds formula and cached value', withPart(part([{ name: 'Pay', marks: [mark(2, 2, 2, 2, 'Calc')] }])))
  await add('part withholds a boolean', withPart(part([{ name: 'Pay', marks: [mark(3, 3, 3, 3, 'Flag')] }])))
  await add('part labels are sanitized', withPart(part([{ name: 'Pay', marks: [
    mark(0, 0, 0, 0, 'a*b/c{d}<e>="f\''), mark(0, 0, 1, 1, '  \t '), mark(0, 0, 2, 2, 'x'.repeat(39) + '\u{1F600}tail'), mark(0, 0, 3, 3, '*/'),
  ] }])))
  await add('part duplicate sheet entries accumulate', withPart(part([
    { name: 'Pay', marks: [mark(1, 1, 1, 1, 'One')] }, { name: 'Pay', marks: [mark(2, 2, 1, 1, 'Two')] },
  ])))
  await add('part empty marks on an unknown sheet', withPart(part([{ name: 'Gone', marks: [] }])))
  await add('part all marks empty', withPart(part([{ name: 'Pay', marks: [] }])))
  await add('part previousFill and extra keys', withPart(part([{ name: 'Pay', extra: true, marks: [mark(1, 1, 1, 1, 'Fill', { previousFill: 'FFFF0000', other: [1] })] }])))
  await add('part shared formula master withheld', { sheets: [['Rates', SHARED_MASTER_SHEET]], files: { 'xl/gxRedactions.json': part([{ name: 'Rates', marks: [mark(0, 0, 0, 0, 'Rate')] }]) } })
  await add('part keys a sheet name with edge spaces', {
    sheets: [['  Pay ', GRID_SHEET]],
    files: { 'xl/gxRedactions.json': part([{ name: '  Pay ', marks: [mark(1, 1, 1, 1, 'Spaced')] }]) },
  })
  await add('part keys the trimmed name of a spaced sheet', {
    sheets: [['  Pay ', GRID_SHEET]],
    files: { 'xl/gxRedactions.json': part([{ name: 'Pay', marks: [mark(1, 1, 1, 1, 'Trimmed')] }]) },
  })
  await add('mirror on a sheet whose name has edge spaces', { sheets: [[' Pay\t', GRID_SHEET]], definedNames: mirror(0, mirrorMark(0, [1, 1], [1, 1], 'Spaced')) })
  await add('part sheet name with entities', {
    sheets: [['R&amp;D &lt;1&gt;', GRID_SHEET]],
    files: { 'xl/gxRedactions.json': part([{ name: 'R&D <1>', marks: [mark(1, 1, 1, 1, 'Lab')] }]) },
  })
  await add('part withheld cells within a budget', withPart(part([{ name: 'Pay', marks: [mark(1, 2, 1, 2, 'Salary')] }])), 40)

  // the defined-name copy answers when the part is missing or damaged
  await add('mirror only', { sheets: two, definedNames: mirror(0, mirrorMark(0, [1, 1], [2, 2], 'Salary')) + mirror(1, mirrorMark(1, [0, 1], [0, 1], 'B1')) })
  await add('mirror with escaped quotes', { sheets: two, definedNames: mirror(3, mirrorMark(0, [1, 1], [1, 1], 'Q"uote'), true) })
  await add('mirror beside other defined names', { sheets: two, definedNames: `<definedName name="Print_Area">Pay!$A$1:$B$2</definedName>${mirror(0, mirrorMark(0, [1, 2], [1, 2], 'C2'))}<definedName name="_gxRedactionX">junk</definedName>` })
  await add('mirror sheet position through encoded names', {
    sheets: [['A&amp;B', GRID_TWO], ['P&#x61;y', GRID_SHEET]],
    definedNames: mirror(0, mirrorMark(1, [1, 1], [1, 1], 'Encoded')),
  })
  await add('part damaged, mirror readable', withPart('{"version":1,', { definedNames: mirror(0, mirrorMark(0, [1, 1], [1, 1], 'From mirror')) }))
  await add('part readable, mirror damaged', withPart(part([{ name: 'Pay', marks: [mark(1, 1, 1, 1, 'From part')] }]), { definedNames: '<definedName name="_gxRedaction_0">not json</definedName>' }))
  await add('part readable and empty, mirror has marks', withPart(part([]), { definedNames: mirror(0, mirrorMark(0, [1, 1], [1, 1], 'Ignored')) }))

  // unreadable records refuse the workbook
  const refusals: Array<[string, Book]> = [
    ['part damaged, no mirror', withPart('not json')],
    ['part damaged, mirror empty', withPart('[]')],
    ['part version 2', withPart(JSON.stringify({ version: 2, sheets: [] }))],
    ['part version as text', withPart(JSON.stringify({ version: '1', sheets: [] }))],
    ['part sheets not an array', withPart(JSON.stringify({ version: 1, sheets: {} }))],
    ['part sheet without name', withPart(part([{ marks: [] }]))],
    ['part sheet as array', withPart(part([['Pay']]))],
    ['part marks missing', withPart(part([{ name: 'Pay' }]))],
    ['part mark negative', withPart(part([{ name: 'Pay', marks: [mark(-1, 1, 1, 1, 'x')] }]))],
    ['part mark fraction', withPart(part([{ name: 'Pay', marks: [mark(1.5, 2, 1, 1, 'x')] }]))],
    ['part mark ends before it starts', withPart(part([{ name: 'Pay', marks: [mark(2, 1, 1, 1, 'x')] }]))],
    ['part mark empty label', withPart(part([{ name: 'Pay', marks: [mark(1, 1, 1, 1, '')] }]))],
    ['part mark coordinate as text', withPart(part([{ name: 'Pay', marks: [{ ...mark(1, 1, 1, 1, 'x'), startRow: '1' }] }]))],
    ['part names a sheet the workbook lacks', withPart(part([{ name: 'Renamed', marks: [mark(0, 0, 0, 0, 'x')] }]))],
    ['mirror not json', { sheets: two, definedNames: '<definedName name="_gxRedaction_0" hidden="1">"{oops}"</definedName>' }],
    ['mirror self-closing', { sheets: two, definedNames: '<definedName name="_gxRedaction_0"/>' }],
    ['mirror version 2', { sheets: two, definedNames: mirror(0, { ...mirrorMark(0, [0, 0], [0, 0], 'x'), v: 2 }) }],
    ['mirror sheet position out of range', { sheets: two, definedNames: mirror(0, mirrorMark(2, [0, 0], [0, 0], 'x')) }],
    ['mirror corner of three', { sheets: two, definedNames: mirror(0, { ...mirrorMark(0, [0, 0], [0, 0], 'x'), from: [0, 0, 0] }) }],
    ['mirror ends before it starts', { sheets: two, definedNames: mirror(0, mirrorMark(0, [2, 2], [1, 1], 'x')) }],
    ['mirror without label', { sheets: two, definedNames: mirror(0, { v: 1, sheet: 0, from: [0, 0], to: [0, 0] }) }],
  ]
  for (const [label, spec] of refusals) await add(label, spec)

  const unreadablePart = await book(withPart(part([{ name: 'Pay', marks: [mark(1, 1, 1, 1, 'x')] }]) + ' '.repeat(200)))
  out.push({ label: 'withheld: part that does not inflate, no mirror', bytes: breakEntry(unreadablePart, 'xl/gxRedactions.json') })
  const unreadableWithMirror = await book(withPart(part([]) + ' '.repeat(200), { definedNames: mirror(0, mirrorMark(0, [1, 1], [1, 1], 'Mirror')) }))
  out.push({ label: 'withheld: part that does not inflate, mirror readable', bytes: breakEntry(unreadableWithMirror, 'xl/gxRedactions.json') })

  // JSON the two parsers read differently; both readers stay closed in Rust
  await add('part number beyond double range in an ignored key', withPart(`{"version":1,"sheets":[{"name":"Pay","marks":[{"startRow":1,"endRow":1,"startColumn":1,"endColumn":1,"label":"Big","previousFill":1e400}]}]}`))
  await add('part lone surrogate label', withPart(`{"version":1,"sheets":[{"name":"Pay","marks":[{"startRow":1,"endRow":1,"startColumn":1,"endColumn":1,"label":"\\ud800x"}]}]}`))
  await add('part nested deeper than 128', withPart(`{"version":1,"x":${'['.repeat(200)}${']'.repeat(200)},"sheets":[{"name":"Pay","marks":[{"startRow":1,"endRow":1,"startColumn":1,"endColumn":1,"label":"Deep"}]}]}`))
  return out
}

async function inputs(): Promise<Input[]> {
  const out: Input[] = []
  const add = (label: string, bytes: Uint8Array, maxChars?: number) =>
    out.push({ label, bytes, args: maxChars === undefined ? {} : { maxChars: String(maxChars) } })

  // values, shared strings, styles
  const values = await book({ sheets: [['Values', VALUES_SHEET]], files: { 'xl/sharedStrings.xml': RICH_SST } })
  add('values and shared strings', values)
  add('shared strings found through rels', await book({
    sheets: [['Values', VALUES_SHEET]], extraRels: [['rIdS', 'sharedStrings', 'strings/custom.xml']], files: { 'xl/strings/custom.xml': RICH_SST },
  }))
  add('external shared strings ignored', await book({
    sheets: [['Values', VALUES_SHEET]], extraRels: [['rIdS', 'sharedStrings', 'strings/custom.xml', 'External']],
    files: { 'xl/strings/custom.xml': RICH_SST, 'xl/sharedStrings.xml': sst('<si><t>default</t></si>') },
  }))
  add('formulas cached, uncomputed and shared', await book({ sheets: [['Formulas', FORMULA_SHEET], ['Sheet2', sheet(row(1, c('A1', v('x'))))]] }))
  add('shared formula row beyond doubles', await book({ sheets: [['Rows', NAN_ROW_SHEET]] }))
  add('shared formula column beyond doubles throws', await book({ sheets: [['Columns', NAN_COLUMN_SHEET]] }))
  for (const [label, pr] of [['1900', ''], ['1904 one', PR('1')], ['1904 true', PR(' TRUE ')], ['1904 false', PR('false')], ['1904 zero', PR('0')], ['1904 two prs', PR('1') + PR('1')]] as const) {
    add(`dates ${label}`, await book({ sheets: [['Dates', DATE_SHEET]], pr, files: { 'xl/styles.xml': STYLES } }))
  }
  add('styles found through rels', await book({ sheets: [['Dates', DATE_SHEET]], extraRels: [['rIdX', 'styles', '../custom/st.xml']], files: { 'custom/st.xml': STYLES } }))
  add('styles part empty', await book({ sheets: [['Dates', DATE_SHEET]], files: { 'xl/styles.xml': '' } }))
  add('styles without cellXfs', await book({ sheets: [['Dates', DATE_SHEET]], files: { 'xl/styles.xml': `<styleSheet xmlns="${S}"><numFmts><numFmt numFmtId="164" formatCode="yyyy"/></numFmts></styleSheet>` } }))

  // relationships
  const one = sheet(row(1, c('A1', v('found'))))
  const ws = (rId: string, attr = 'r:id') => `<sheet name="S" sheetId="1" ${attr}="${rId}"/>`
  const wb = (sheetsXml: string) => `<workbook xmlns="${S}" xmlns:r="${R}" xmlns:x="${R}"><sheets>${sheetsXml}</sheets></workbook>`
  const relCases: Array<[string, string, string | null, Record<string, string>]> = [
    ['other relationship prefix', wb(ws('rId1', 'x:id')), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': one }],
    ['plain id attribute', wb(ws('rId1', 'id')), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': one }],
    ['absolute and escaped target', wb(ws('rId1')), rels([['rId1', 'worksheet', '/xl/my%20sheets/a.xml']]), { 'xl/my sheets/a.xml': one }],
    ['parent target', wb(ws('rId1')), rels([['rId1', 'worksheet', '../outside/a.xml']]), { 'outside/a.xml': one }],
    ['target with spaces trimmed', wb(ws(' rId1 ')), `<Relationships xmlns="${PKG}"><Relationship Id=" rId1 " Target=" worksheets/a.xml "/></Relationships>`, { 'xl/worksheets/a.xml': one }],
    ['duplicate relationship ids', wb(ws('rId1')), rels([['rId1', 'worksheet', 'worksheets/a.xml'], ['rId1', 'worksheet', 'worksheets/b.xml']]), { 'xl/worksheets/a.xml': one, 'xl/worksheets/b.xml': sheet(row(1, c('A1', v('second')))) }],
    ['empty target', wb(ws('rId1')), rels([['rId1', 'worksheet', '']]), { 'xl/worksheets/a.xml': one }],
    ['url target', wb(ws('rId1')), rels([['rId1', 'worksheet', 'https://example.com/a.xml']]), {}],
    ['sheet without relationship', wb('<sheet name="S" sheetId="1"/>'), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': one }],
    ['sheet part missing', wb(ws('rId1')), rels([['rId1', 'worksheet', 'worksheets/none.xml']]), {}],
    ['rels missing', wb(ws('rId1') + ws('rId2')), null, { 'xl/worksheets/sheet1.xml': one }],
    ['rels empty', wb(ws('rId1')), '', { 'xl/worksheets/sheet1.xml': one }],
    ['no sheets', wb(''), rels([]), {}],
    ['sheet element as text', wb('<sheet>text</sheet>'), rels([]), {}],
    ['sheet part empty', wb(ws('rId1')), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': '' }],
    ['sheet part is a folder', wb(ws('rId1')), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml/inner.xml': one }],
    ['prefixed sheet keeps its name as written', `<x:workbook xmlns:x="${S}" xmlns:r="${R}"><x:sheets><x:sheet name="  S  " r:id=" rId1 "/></x:sheets></x:workbook>`, rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': one }],
    ['sheet name trimmed only on sheet elements', wb('<sheet name=" A " r:id="rId1"/><sheetX name=" B "/><a.sheet name=" C " r:id="rId1"/>'), rels([['rId1', 'worksheet', 'worksheets/a.xml']]), { 'xl/worksheets/a.xml': one }],
  ]
  for (const [label, workbookXml, relsXml, files] of relCases) {
    add(`relationships: ${label}`, await zip({ 'xl/workbook.xml': workbookXml, ...(relsXml === null ? {} : { 'xl/_rels/workbook.xml.rels': relsXml }), ...files }))
  }

  // sparse columns and collisions
  add('sparse columns', await book({ sheets: [['Sparse', sheet(
    row(1, c('A1', v('a')), c('C1', v('c')), c('M1', v('m')), c('XFD1', v('last'))) +
    row(2, c('XXXXXX99', v('wild')), c('1A', v('digit first')), c(null, v('no ref')), c('B2', v('b'))) +
    row(3, c(null, v('first')), c('A3', v('claims A')), c('A3', v('again')), c('A3', v('')), c('A3', v('after empty'))) +
    row(4, c('XFE4', v('past grid')), c('ß4', v('eszett')), c(' c4 ', v('trimmed ref')), c('', v('empty ref'))) +
    row(5, c('E5', v('   ')), c('F5', v('')), c('Z5', v('z'))) +
    '<row/><row r="7">text</row>',
  )]] }))
  add('ref given as an element', await book({ sheets: [['Elements', sheet(row(1, '<c><@_r>B1</@_r><v>one</v></c>'))]] }))
  add('ref given as two elements', await book({ sheets: [['Elements', sheet(row(1, '<c><@_r>B1</@_r><@_r>C1</@_r><v>two</v></c>'))]] }))

  // clipping and budgets
  const many = wideRows(60, n => `row ${n} \uD55C\uAE00 text`)
  const rowsBook = await book({ sheets: [['First', sheet(many)], ['Second', sheet(many)], ['Third', sheet(row(1, c('A1', v('third'))))]] })
  for (const maxChars of [0, 1, 5, 10, 50, 200, 1500, 4000, 1e300, -1, Number.NaN, Infinity, -Infinity]) add(`budget maxChars=${maxChars}`, rowsBook, maxChars)
  add('budget none', rowsBook)
  const big = sheet(wideRows(9000, n => `${'\uD55C'.repeat(n % 7)}\u{1F600}${'x'.repeat(20)}`))
  const bigDeflate = await book({ sheets: [['Big', big], ['After', sheet(row(1, c('A1', v('after'))))]] })
  const bigStore = await book({ sheets: [['Big', big]] }, 'STORE')
  for (const maxChars of [1, 100, 2000, 40000, Infinity]) {
    add(`prefix deflate maxChars=${maxChars}`, bigDeflate, maxChars)
    add(`prefix store maxChars=${maxChars}`, bigStore, maxChars)
  }
  add('prefix exactly at the limit', await book({ sheets: [['Exact', sheet('').slice(0, -1).padEnd(262_152 - 1, ' ') + '>']] }), 1)
  add('byte order mark in sheet, unlimited', await book({ sheets: [['Bom', '\uFEFF' + sheet(row(1, c('A1', v('bom'))))]] }))
  add('byte order mark in sheet, limited', await book({ sheets: [['Bom', '\uFEFF' + sheet(row(1, c('A1', v('bom'))))]] }), 100)
  add('prefixed rows clipped', await book({ sheets: [['Prefixed', `<x:worksheet xmlns:x="${S}"><x:sheetData>${wideRows(40000, n => `p${n}`).replaceAll('<row', '<x:row').replaceAll('</row>', '</x:row>').replaceAll('<c', '<x:c').replaceAll('</c>', '</x:c>').replaceAll('<v>', '<x:v>').replaceAll('</v>', '</x:v>')}</x:sheetData></x:worksheet>`]] }), 10)
  const lateDamage = await book({ sheets: [['Big', big]] })
  add('sheet damaged past the prefix', breakEntry(lateDamage, 'xl/worksheets/sheet1.xml', -2), 1)
  add('sheet damaged past the prefix, unlimited', breakEntry(lateDamage, 'xl/worksheets/sheet1.xml', -2))
  add('sheet damaged at the start', breakEntry(lateDamage, 'xl/worksheets/sheet1.xml'), 1)

  // pictures
  const pics = (count: number) => ({ 'xl/worksheets/_rels/sheet1.xml.rels': sheetRels('../drawings/drawing1.xml'), 'xl/drawings/drawing1.xml': drawing(count) })
  add('image-only two pictures', await book({ sheets: [['Pics', drawingSheet()]], files: pics(2) }))
  add('image-only one picture', await book({ sheets: [['Pics', drawingSheet(row(1, c('A1', v('  '))))]], files: pics(1) }))
  add('image-only no pictures', await book({ sheets: [['Pics', drawingSheet()]], files: pics(0) }))
  add('image-only drawing without rels', await book({ sheets: [['Pics', drawingSheet()]] }))
  add('image-only drawing rel missing target', await book({ sheets: [['Pics', drawingSheet()]], files: { 'xl/worksheets/_rels/sheet1.xml.rels': sheetRels('../drawings/none.xml') } }))
  add('image-only drawing with other id', await book({ sheets: [['Pics', drawingSheet('', ' r:id="rId9"')]], files: pics(2) }))
  add('drawing element without attributes', await book({ sheets: [['Pics', drawingSheet('', '')]], files: pics(2) }))
  add('image-only beside a data sheet', await book({ sheets: [['Pics', drawingSheet()], ['Data', sheet(row(1, c('A1', v('data'))))]], files: pics(3) }))
  add('two image-only sheets', await book({ sheets: [['P1', drawingSheet()], ['P2', drawingSheet()]], files: {
    ...pics(1), 'xl/worksheets/_rels/sheet2.xml.rels': sheetRels('/xl/drawings/drawing1.xml'),
  } }))

  // parts that do not parse or inflate
  add('workbook missing', await zip({ 'xl/worksheets/sheet1.xml': one }))
  add('workbook empty', await zip({ 'xl/workbook.xml': '' }))
  add('workbook unclosed tag', await zip({ 'xl/workbook.xml': `<workbook xmlns="${S}"><sheets><sheet name="S"` }))
  add('workbook doctype', await zip({ 'xl/workbook.xml': `<!DOCTYPE workbook><workbook xmlns="${S}"/>` }))
  add('sheet with a reserved name', await book({ sheets: [['Proto', sheet(row(1, '<__proto__/>'))]] }))
  add('sheet with toString element', await book({ sheets: [['Renamed', sheet(row(1, c('A1', '<toString/>' + v('kept'))))]] }))
  add('sheet text after the root closed', await book({ sheets: [['Late', sheet(row(1, c('A1', v('x')))) + 'tail<x/>']] }))
  add('styles do not parse', await book({ sheets: [['S', one]], files: { 'xl/styles.xml': '<styleSheet><numFmts>' } }))
  add('shared strings do not inflate', breakEntry(await book({ sheets: [['S', one]], files: { 'xl/sharedStrings.xml': RICH_SST } }), 'xl/sharedStrings.xml'))
  add('drawing rels do not inflate', breakEntry(await book({ sheets: [['Pics', drawingSheet()]], files: { ...pics(1), 'xl/worksheets/_rels/sheet1.xml.rels': sheetRels('../drawings/drawing1.xml') + ' '.repeat(200) } }), 'xl/worksheets/_rels/sheet1.xml.rels'))
  add('not a zip', new TextEncoder().encode('not a zip at all'))
  add('empty bytes', new Uint8Array(0))
  add('empty archive', await zip({}))

  out.push(...await redactionInputs())
  out.push(...hostileZipInputs())
  return out
}

const BUDGETS = [0, 1, 0.5, -1, 1e308, -1e308, 123456789, -32768, -32761.875, Number.NaN, Infinity, -Infinity, 2 ** 53]

const CLIP_XML: Array<[string, string]> = [
  ['rows', `<worksheet><sheetData>${'<row r="1"><c><v>1</v></c></row>'.repeat(6)}</sheetData></worksheet>`],
  ['prefixed', `<x:worksheet><x:sheetData>${'<x:row><x:c/></x:row>'.repeat(6)}</x:sheetData></x:worksheet>`],
  ['dotted prefix', `<a.b-c:worksheet><a.b-c:sheetData>${'<a.b-c:row/></a.b-c:row>'.repeat(3)}</a.b-c:sheetData></a.b-c:worksheet>`],
  ['double prefix', `<worksheet><sheetData><row></a:b:row></row></sheetData></worksheet>`],
  ['no sheetData', `<worksheet>${'<row></row>'.repeat(4)}</worksheet>`],
  ['row before sheetData', `<worksheet><row></row><sheetData></sheetData></worksheet>`],
  ['sheetData self-closing', `<worksheet><sheetData/></worksheet>`],
  ['sheetData with attributes', `<worksheet><sheetData\tx="1"><row/></row></sheetData></worksheet>`],
  ['astral text', `<worksheet><sheetData>${'<row><c><v>\u{1F600}\uD55C</v></c></row>'.repeat(5)}</sheetData></worksheet>`],
  ['crlf', `<worksheet>\r\n<sheetData>\r\n${'<row>\r\n</row>\r\n'.repeat(4)}</sheetData></worksheet>`],
  ['empty', ''],
]

function clipInputs(): Input[] {
  const out: Input[] = []
  for (const [label, xml] of CLIP_XML) {
    const units = xml.length
    const cuts = [units, units - 1, Math.floor(units / 2), 30, 23, 1, 0, -5]
    const budgets = [...cuts.map(cut => (cut - 262_144) / 8), 1, Number.NaN, -40_000, Infinity, -Infinity]
    for (const budget of budgets) {
      for (const truncated of [false, true]) {
        out.push({ label: `${label} budget=${budget} truncated=${truncated}`, text: xml, args: { budget: String(budget), truncated } })
      }
    }
  }
  return out
}

export const SPECS: Spec[] = [
  {
    fn: 'xlsxToText',
    extensions: ['xlsx', 'xlsm'],
    built: inputs,
    call: ({ bytes = new Uint8Array(0), args = {} }) =>
      xlsxToText(bytes, 'maxChars' in args ? { maxChars: Number(args.maxChars) } : {}),
  },
  {
    fn: 'sheetXmlByteLimit',
    extensions: [],
    mutation: 'none',
    built: () => BUDGETS.map(budget => ({ label: `budget ${budget}`, text: String(budget) })),
    call: ({ text = '' }) => sheetXmlByteLimit(Number(text)),
  },
  {
    fn: 'clipSheetXml',
    extensions: [],
    mutateText: true,
    built: clipInputs,
    call: ({ text = '', args = {} }) => clipSheetXml(text, Number(args.budget), args.truncated === true),
  },
]
