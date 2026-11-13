import JSZip from 'jszip'
import { clipSheetXml, sheetXmlByteLimit, xlsxToText, xlsxWithheldCells } from './reference/xlsx'
import { UNKNOWN_CELL_MARKER } from './reference/xlsx-redaction'
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

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** Text cells from A1 over `rows` × `columns`, each naming its place, so a withheld one is seen by its absence. */
function grid(rows: number, columns: number): string {
  let out = ''
  for (let r = 1; r <= rows; r++) {
    let cells = ''
    for (let k = 0; k < columns; k++) cells += c(`${COLUMN_LETTERS[k]}${r}`, v(`g${COLUMN_LETTERS[k]}${r}`), ' t="str"')
    out += row(r, cells)
  }
  return out
}

/** A formula cell with the value it was last calculated to. */
const fc = (ref: string | null, formula: string, cached = '0', attrs = '') => c(ref, f(formula, attrs) + v(cached))
const marked = (sheets: Book['sheets'], marks: unknown, extra: Partial<Book> = {}): Book => ({
  ...extra,
  sheets,
  files: { 'xl/gxRedactions.json': part(marks), ...extra.files },
})
const PAY_B1 = [{ name: 'Pay', marks: [mark(0, 0, 1, 1, 'Salary')] }]
const rawRels = (items: Array<[id: string, type: string, target: string, mode?: string]>) =>
  `${DECL}<Relationships xmlns="${PKG}">${items
    .map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`)
    .join('')}</Relationships>`
const STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships'

const PIVOT_LOCATION = (ref: string, attrs = '') => `<location ref="${ref}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"${attrs}/>`
const PIVOT_PAGE_FIELDS = (count: number, prefix = '') =>
  count === 0 ? '' : `<${prefix}pageFields count="${count}">${`<${prefix}pageField fld="0" hier="-1"/>`.repeat(count)}</${prefix}pageFields>`
const pivotXml = (location: string, fields = '') =>
  `${DECL}<pivotTableDefinition xmlns="${S}" name="PivotTable1" cacheId="1">${location}<pivotFields count="1"><pivotField axis="axisRow" showAll="0"/></pivotFields>${fields}</pivotTableDefinition>`
const WORKSHEET_SOURCE = (attrs: string) => `<cacheSource type="worksheet"><worksheetSource ${attrs}/></cacheSource>`
const cacheXml = (source: string, { root = `xmlns="${S}" xmlns:r="${R}" r:id="rId1"`, before = '', after = '' } = {}) =>
  `${DECL}<pivotCacheDefinition ${root} refreshOnLoad="1">${before}${source}<cacheFields count="1"><cacheField name="Region" numFmtId="0"/></cacheFields>${after}</pivotCacheDefinition>`
const DATA_SHEET = sheet(
  row(1, c('A1', v('Region'), ' t="str"'), c('B1', v('Units'), ' t="str"'), c('C1', v('Amount'), ' t="str"')) +
  row(2, c('A2', v('East'), ' t="str"'), c('B2', v('3')), c('C2', v('300'))) +
  row(3, c('A3', v('West'), ' t="str"'), c('B3', v('4')), c('C3', v('400'))) +
  row(4, c('A4', v('North'), ' t="str"'), c('B4', v('5')), c('C4', v('500'))),
)
const REPORT_SHEET = sheet(grid(12, 4) + row(13, fc('A13', 'SUM(B4:B8)', '10'), fc('B13', 'SUM(D4:D8)', '1'), fc('C13', 'SUM(A1:A3)', '1')))
const DATA_C2 = [{ name: 'Data', marks: [mark(1, 1, 2, 2, 'Amount')] }]
const SALES_NAME = '<definedName name="Sales">Data!$A$1:$C$4</definedName>'

interface PivotSpec {
  pivot?: string | null
  pivotRels?: string | null
  cache?: string | null
  sheetRels?: string
  definedNames?: string
  /** `null`: no record of withheld cells is written */
  marks?: unknown
  files?: Record<string, string>
}
const PIVOT_PART = 'xl/pivotTables/pivotTable1.xml'
const CACHE_PART = 'xl/pivotCache/pivotCacheDefinition1.xml'
const PIVOT_RELS = rels([['rId1', 'pivotTable', '../pivotTables/pivotTable1.xml']])
const CACHE_RELS = rels([['rId1', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition1.xml']])
function pivotBook(spec: PivotSpec = {}): Book {
  const files: Record<string, string> = { 'xl/worksheets/_rels/sheet2.xml.rels': spec.sheetRels ?? PIVOT_RELS }
  if (spec.pivot !== null) files[PIVOT_PART] = spec.pivot ?? pivotXml(PIVOT_LOCATION('A3:B8'))
  if (spec.pivotRels !== null) files['xl/pivotTables/_rels/pivotTable1.xml.rels'] = spec.pivotRels ?? CACHE_RELS
  if (spec.cache !== null) files[CACHE_PART] = spec.cache ?? cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"'))
  const sheets: Book['sheets'] = [['Data', DATA_SHEET], ['Report', REPORT_SHEET]]
  const extra: Partial<Book> = {
    ...(spec.definedNames === undefined ? {} : { definedNames: spec.definedNames }),
    files: { ...files, ...spec.files },
  }
  return spec.marks === null ? { ...extra, sheets } : marked(sheets, spec.marks ?? DATA_C2, extra)
}

/** What the formula trace withholds beyond the marks, and what it leaves alone. */
async function derivedInputs(): Promise<Input[]> {
  const out: Input[] = []
  const add = async (label: string, spec: Book, args: Record<string, string> = {}, mutate = true) =>
    out.push({ label: `derived: ${label}`, bytes: await book(spec), args, ...(mutate ? {} : { mutate: false }) })

  // references: direct, absolute, chained, ranges, whole columns and rows
  await add('direct references and chains', marked([['Pay', sheet(
    row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1000'), fc('D1', '$B$1+1', '1001'), fc('E1', 'C1*2', '2000'), fc('F1', 'A1', '5'), fc('G1', 'b1', '1000'), fc('H1', 'B1:B2', '1000')) +
    row(2, c('A2', v('plain 2')), c('B2', v('2000')), fc('C2', 'SUM(B2:B3)', '2000'), fc('D2', 'SUM(A1:A9)', '6'), fc('E2', 'SUM(A1:C1)', '2000'), fc('F2', 'IF(A1="B1",1,2)', '2'), fc('G2', 'A1&amp;"x"', '5'), fc('H2', 'B2')) +
    row(3, fc('A3', 'E1', '2000'), fc('B3', 'A3+1', '2001'), fc('C3', 'F1', '5'), fc('D3', 'H1', '1000'), fc('E3', "'Pay'!B1", '1000'), fc('F3', 'Pay!$B$1', '1000'), fc('G3', '-B1', '-1000'), fc('H3', '(B1)', '1000')) +
    row(4, fc('A4', 'SUM(B:B)', '3000'), fc('B4', 'SUM(Z:Z)'), fc('C4', 'SUM(1:1)', '9'), fc('D4', 'SUM(9:9)'), fc('E4', 'SUM(A:C)', '5'), fc('F4', 'SUM(C:D)', '1'), fc('G4', 'SUM($A$9:$A$12)'), fc('H4', 'COUNT(B1,B2)', '2')),
  )]], PAY_B1))
  await add('rectangles, overlaps and distant rows', marked([['Pay', sheet(
    row(1, c('A1', v('plain')), c('D1', v('d1'))) +
    row(5, c('D5', v('hidden 1')), c('E5', v('hidden 2')), c('F5', v('open'))) +
    row(6, c('D6', v('hidden 3')), c('E6', v('hidden 4')), fc('F6', 'D5', '1')) +
    row(7, fc('A7', 'SUM(C4:D5)'), fc('B7', 'SUM(E6:F7)'), fc('C7', 'SUM(F6:G7)'), fc('D7', 'SUM(E6:D5)'), fc('E7', 'SUM(G9:H10)'), fc('F7', 'F6+1')) +
    row(300, c('A300', v('buried')), c('B300', v('hidden 5'))) +
    row(301, fc('A301', 'SUM(A1:A1000)'), fc('B301', 'SUM(B1:B299)'), fc('C301', 'SUM(B1:B5000)'), fc('D301', 'SUM(1:2)'), fc('E301', 'B300')) +
    row(5000, fc('A5000', 'SUM(A1:A4999)'), c('B5000', v('hidden 6'))) +
    row(5001, fc('A5001', 'SUM(B4:B6000)'), fc('B5001', 'SUM(A:A)'), fc('C5001', 'SUM(C:C)'), fc('D5001', 'A5001')) +
    row(1048576, c('A1048576', v('last row')), c('B1048576', v('hidden 7'))) +
    row(1048575, fc('A1048575', 'A1048576'), fc('B1048575', 'B1048576'), fc('C1048575', 'SUM(B1048570:B1048576)')),
  )]], [{ name: 'Pay', marks: [
    mark(4, 5, 3, 4, 'Block'), mark(299, 299, 1, 1, 'Buried'), mark(4999, 4999, 1, 1, 'Deep'), mark(1048575, 1048575, 1, 1, 'Last'),
  ] }]))
  await add('other sheets', marked([
    ['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'Report!A1', '1000'), fc('D1', 'Report!B9', '1')) + row(2, fc('A2', 'Report!A4', '1')))],
    ['Report', sheet(
      row(1, fc('A1', 'Pay!B1', '1000'), fc('B1', "'Pay'!B1", '1000'), fc('C1', 'PAY!b1', '1000'), fc('D1', 'Pay!B2', '1'), fc('E1', "'Pay'!A1:C1", '1')) +
      row(2, fc('A2', 'Gone!A1'), fc('B2', 'Pay!B1+Other!A1', '1'), fc('C2', 'Pay!A1', '1'), fc('D2', "'My sheet'!A1"), fc('E2', 'A1', '1')) +
      row(4, fc('A4', 'Pay!D1', '1'), fc('B4', 'Pay!C1', '1')) +
      row(9, fc('B9', 'Pay!D1', '1'), fc('C9', 'Pay!A2', '1')),
    )],
  ], PAY_B1))
  await add('sheet names that need quoting, entities and case', marked([
    ['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1000'))))],
    ["Q1 'Plan'", sheet(row(1, fc('A1', "Pay!B1", '1'), fc('B1', "'Q1 ''Plan'''!A1", '1'), fc('C1', "'Q1 ''PLAN'''!A2", '1'), fc('D1', "'Q1 '''!A1", '1')) + row(2, c('A2', v('own'))))],
    ['R&amp;D', sheet(row(1, fc('A1', "'R&amp;D'!B1", '1'), c('B1', v('lab')), fc('C1', "'Q1 ''Plan'''!A1", '1'), fc('D1', "'R&amp;D'!A1", '1')))],
    ['Données', sheet(row(1, c('A1', v('d')), fc('B1', 'DONNÉES!A1', '1'), fc('C1', 'données!A1+Pay!B1', '1'), fc('D1', 'Pay!B1:Données!A1', '1')))],
  ], [{ name: 'Pay', marks: [mark(0, 0, 1, 1, 'Salary')] }, { name: 'R&D', marks: [mark(0, 0, 1, 1, 'Lab')] }]))

  // defined names: resolved, unqualified, undefined, recursive, scoped
  const NAMES =
    '<definedName name="Secret">Pay!$B$1</definedName>' +
    '<definedName name="SecretRange" localSheetId="1">Pay!$A$1:$C$1</definedName>' +
    '<definedName name="Chain">Secret+1</definedName>' +
    '<definedName name="Local">$B$1</definedName>' +
    '<definedName name="Safe">Pay!$A$1</definedName>' +
    '<definedName name="Loop1">Loop2+1</definedName><definedName name="Loop2">Loop1+1</definedName>' +
    '<definedName name="Twice">Pay!$A$1</definedName><definedName name="Twice" localSheetId="0">Pay!$B$1</definedName>' +
    '<definedName name="Ext">[1]Sheet1!$A$1</definedName>' +
    '<definedName name="Fn">INDIRECT("B1")</definedName>' +
    '<definedName name="Bad">Gone!$A$1</definedName>' +
    '<definedName name="Const">42</definedName>' +
    '<definedName name="Text">"B1"</definedName>' +
    '<definedName name="Blank"/>' +
    '<definedName>no name</definedName>' +
    '<definedName name="Amp">Pay!$A$1&amp;Pay!$B$1</definedName>' +
    '<definedName name="Nested">Chain*Safe</definedName>'
  const nameFormulas = ['Secret', 'Secret*2', 'Chain', 'Local', 'Safe', 'Loop1', 'Twice', 'Ext', 'Fn', 'Bad', 'Const', 'Text', 'SECRET', 'Blank', 'Missing', 'Pay!Secret', "'Pay'!Secret", 'SecretRange', 'SUM(SecretRange)', 'Undefined1+Const', 'Amp', 'Nested', 'Safe+Const', 'Print_Area']
  const nameCells = nameFormulas.map((formula, i) => fc(`${COLUMN_LETTERS[i % 6]}${1 + Math.floor(i / 6)}`, formula, '1'))
  const nameSheets: Book['sheets'] = [
    ['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C1', v('open'))))],
    ['Report', sheet([0, 1, 2, 3].map(rowIndex => row(rowIndex + 1, ...nameCells.slice(rowIndex * 6, rowIndex * 6 + 6))).join(''))],
  ]
  await add('defined names', marked(nameSheets, PAY_B1, { definedNames: NAMES }))
  await add('defined names beside a mirror of the marks', { sheets: nameSheets, definedNames: NAMES + mirror(0, mirrorMark(0, [0, 1], [0, 1], 'Salary')) })
  await add('defined names with a mark that covers the name target', marked(nameSheets, [{ name: 'Pay', marks: [mark(0, 0, 0, 0, 'Plain')] }], { definedNames: NAMES }))
  await add('no defined name is known', marked(nameSheets, PAY_B1))

  // shared formulas, with their master, without it, and out of order
  await add('shared formulas', marked([['Rates', sheet(
    row(1, c('A1', v('plain')), c('B1', v('1')), fc('G1', 'SUM(A:A)', '1', ' t="shared" ref="G1:H1" si="3"'), c('H1', f('', ' t="shared" si="3"') + v('1'))) +
    row(2, c('B2', v('2')), fc('C2', 'B1+1', '2', ' t="shared" ref="C2:C5" si="0"'), c('D2', f('', ' t="shared" si="1"') + v('1')), c('E2', f('', ' t="shared" si="2"') + v('1'))) +
    row(3, c('B3', v('3')), c('C3', f('', ' t="shared" si="0"') + v('3')), c('E3', f('', ' t="shared" si="2"') + v('1')), fc('F3', 'B3', '1', ' t="shared"')) +
    row(4, c('B4', v('4')), c('C4', f('', ' t="shared" si="0"') + v('4')), fc('E4', 'B5*2', '1', ' t="shared" ref="E2:E4" si="2"')) +
    row(5, c('B5', v('5')), c('C5', f('', ' t="shared" si="0"') + v('5')), fc('A5', 'B3', '1', " si='5' t='shared'")) +
    row(6, c('A6', f('', " t = 'shared' si = '5'") + v('1')), fc('B7', 'A1+1', '1', ' t="shared" ref="A7:B7" si="6"'), c('A7', f('', ' t="shared" si="6"') + v('1')), c('C7', f('', ' t="shared" si=" 6"') + v('1'))) +
    row(8, fc('A8', 'D2', '1'), fc('B8', 'D3', '1'), fc('C8', 'C4', '1'), fc('D8', 'E3', '1'), fc('E8', 'F3', '1'), fc('F8', 'C1', '1')),
  )]], [{ name: 'Rates', marks: [mark(2, 2, 1, 1, 'Rate')] }]))
  await add('shared formula master withheld', marked([['Rates', SHARED_MASTER_SHEET], ['Other', sheet(row(1, fc('A1', 'Rates!A2', '1'), fc('B1', 'Rates!B2', '1')))]], [{ name: 'Rates', marks: [mark(0, 0, 0, 0, 'Rate')] }]))

  // array formulas and what-if data tables
  await add('array formulas', marked([['Pay', sheet(
    row(1, c('A1', v('plain')), c('B1', v('1')), fc('D1', 'B1:B3*2', '2', ' t="array" ref="D1:D3"'), fc('F1', 'A1', '1', ' t="array" ref="F1:F1"'), fc('G1', 'B3', '1', ' t="array" ref="G3:G1"'), fc('E1', 'D2', '2')) +
    row(2, c('B2', v('2')), c('D2', v('4')), fc('E2', 'D4', '1'), c('G2', v('inside'))) +
    row(3, c('B3', v('3')), c('D3', v('6')), c('G3', v('corner')), fc('E3', 'G2', '1')) +
    row(5, c('A5', f('', ' t="array" ref="A5:A6"') + v('1')), c('A6', v('under'))),
  )]], PAY_B1))
  await add('array formula without a range withholds the sheet', marked([['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1')), c('C1', f('B1*2', ' t="array"') + v('2'))))]], PAY_B1))
  await add('array formula with an unreadable range withholds the sheet', marked([['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1')), c('C1', f('B1*2', ' t="array" ref="C1:C"') + v('2'))))]], PAY_B1))
  await add('what-if data table', marked([['Pay', sheet(
    row(1, c('A1', v('plain')), c('B1', v('10')), fc('E1', 'C3', '1'), fc('F1', 'A1', '1')) +
    row(2, c('A2', v('plain 2')), c('B2', f('', ' t="dataTable" ref="B2:C3" dt2D="1" dtr="1" r1="A1" r2="A2"') + v('5')), c('C2', v('6')), fc('E2', 'B3', '1')) +
    row(3, c('B3', v('7')), c('C3', v('8')), fc('E3', 'SUM(B:B)', '1')),
  )]], PAY_B1))
  await add('data table without a range withholds the sheet', marked([['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('10')), c('C1', f('', ' t="dataTable"') + v('1'))))]], PAY_B1))
  await add('data table with an empty range withholds the sheet', marked([['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('10')), c('C1', f('', ' t="dataTable" ref=""') + v('1'))))]], PAY_B1))

  // reads that cannot be listed, and references out of the workbook
  const untraceable = [
    'INDIRECT("B1")', 'OFFSET(A1,0,1)', 'GETPIVOTDATA("Sales",A3)', 'CELL("contents",A1)', '_xlfn.ANCHORARRAY(A1)', 'A1#', 'SUM(A1:INDEX(B:B,3))', 'SUM(INDEX(B:B,3):A1)',
    'Table1[Amount]', 'Table1[[#This Row],[Amount]]', '[@Amount]', 'Unknown(1)', 'LET(x,1,x)', 'LAMBDA(x,x)(1)', "'Sheet1:Sheet3'!A1", 'Sheet1:Sheet3!A1',
    '[1]Sheet1!A1', "'[Book.xlsx]Sheet1'!A1", '[Book.xlsx]Sheet1!A1', '[1]!Name', 'SUM([1]Sheet1!A1:B2)', "'[1]Pay'!B1",
    'ZZZ1', 'A0', 'A1048577', '$A$1:$B', 'A1:B', 'A:B1', 'A1§', '~1', "'unterminated", '"unterminated', 'Pay!', 'Pay!#REF!+1', 'Pay!+1', "'Pay'!", '(A1', 'A1)', '[1]', '#', '1#', '$', 'A1 B2',
  ]
  const untraceableCells = untraceable.map((formula, i) => fc(`${COLUMN_LETTERS[i % 8]}${1 + Math.floor(i / 8)}`, formula, '1'))
  const untraceableRows = Array.from({ length: Math.ceil(untraceable.length / 8) }, (_, rowIndex) => row(rowIndex + 1, ...untraceableCells.slice(rowIndex * 8, rowIndex * 8 + 8))).join('')
  await add('formulas that cannot be traced', marked([['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1000'))))], ['Report', sheet(untraceableRows)]], PAY_B1))
  const traceable = [
    'A1', 'SUM(A1:A3)', 'IF(A1>1,B1,C1)', 'IF(A1&gt;1,"B1",C1)', '_xlfn.XLOOKUP(1,A1:A3,B1:B3)', '_xlfn._xlws.FILTER(A1:A3,B1:B3&gt;1)', '_xlfn.STDEV.S(A1:A3)', '{1,2;3,4}',
    '1+2', 'TRUE', 'false', '"B1"', '"say ""B1"""', '#REF!', 'A1+#N/A', '1E3', '.5', '5.', 'Rate2024.q', 'LOG10(100)', 'A1B', 'sum(a1)', 'A1:B2 B2:C3', '-A1%', 'A1^2', 'A1=B1', 'A1&lt;&gt;B1',
    'ROUND(A1,2)&amp;"%"', 'T(A1)', 'ÄÖ+1', '_xlfn.ZZZ_UNKNOWN(1)', 'INDEX(A1:A3,2)', 'CHOOSE(2,A1,B1)', 'N(B2)',
  ]
  const traceableCells = traceable.map((formula, i) => fc(`${COLUMN_LETTERS[i % 8]}${1 + Math.floor(i / 8)}`, formula, '1'))
  const traceableRows = Array.from({ length: Math.ceil(traceable.length / 8) }, (_, rowIndex) => row(rowIndex + 1, ...traceableCells.slice(rowIndex * 8, rowIndex * 8 + 8))).join('')
  await add('formulas that are traced', marked([['Report', sheet(traceableRows)], ['Pay', sheet(row(1, c('A1', v('plain')), c('B1', v('1000'))))]], PAY_B1))
  await add('formulas that read a cell that cannot be traced', marked([['Pay', sheet(
    row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'INDIRECT("A1")', '1'), fc('D1', 'C1+1', '1'), fc('E1', 'A1', '1')) +
    row(2, fc('A2', 'SUM(C:C)', '1'), fc('B2', 'SUM(E:E)', '1'), fc('C2', 'Report!A1', '1')),
  )], ['Report', sheet(row(1, fc('A1', 'Pay!D1', '1'), fc('B1', 'Pay!E1', '1'), fc('C1', 'Pay!C2', '1')))]], PAY_B1))

  // how the sheet XML is scanned
  const scanned = (label: string, xml: string, marks: unknown = PAY_B1) => add(label, marked([['Pay', xml]], marks))
  await scanned('formula in a cell without an address withholds the sheet', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c(null, f('B1') + v('1')), c('D1', v('late')))))
  await scanned('formula in a cell with an address that cannot be read withholds the sheet', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C0', f('B1') + v('1')), c('D1', v('late')))))
  await scanned('formula after a self-closed cell withholds the sheet', sheet(row(1, c('A1', v('plain')), '<c r="C1"/>' + '<f>B1</f>', c('D1', v('late')))))
  await scanned('formula outside any cell withholds the sheet', sheet(row(1, '<f>B1</f>', c('A1', v('plain')), c('B1', v('1000')))))
  await scanned('formula after the cell that closed reads as that cell', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C1', v('3')) + '<f>B1</f>', fc('D1', 'C1', '1'), fc('E1', 'A1', '1'))))
  await scanned('prefixed elements', `${DECL}<x:worksheet xmlns:x="${S}" xmlns:r="${R}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>plain</x:v></x:c><x:c r="B1"><x:v>1000</x:v></x:c><x:c r="C1"><x:f>B1</x:f><x:v>1</x:v></x:c><x:c r="D1"><x:f>A1</x:f><x:v>2</x:v></x:c><x:c r="E1"><x:f t="shared" si="0" ref="E1:F1">A1+B1</x:f></x:c><x:c r="F1"><x:f t="shared" si="0"/></x:c></x:row></x:sheetData></x:worksheet>`)
  await scanned('formula the scan cannot see', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C1', '<é:f>B1</é:f><v>1</v>'), c('D1', '<f>A1</f><v>2</v>'), fc('E1', 'C1', '3'))))
  await scanned('formula in a comment is scanned and the parser does not see it', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), '<!-- <c r="Z9"><f>B1</f></c> -->', fc('C1', 'Z9', '1'), fc('D1', 'Y9', '1'))))
  await scanned('self-closed formula in a cell', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C1', '<f/><v>1</v>'), c('D1', '<f /><v>1</v>'), c('E1', '<f t="shared" si="0"/>'), c('F1', '<f></f><v>1</v>'), fc('G1', 'C1', '1'))))
  await scanned('formula text with entities', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', '&#66;1', '1'), fc('D1', '&#x42;1', '1'), fc('E1', '&#x0042;&#49;', '1'), fc('F1', 'A1&amp;&quot;x&quot;&apos;y&apos;', '1'), fc('G1', '&nbsp;A1', '1'), fc('H1', '&amp;lt;', '1')) +
    row(2, fc('A2', 'A1&lt;B1', '1'), fc('B2', 'A&#49;', '1'), fc('C2', '&#X42;1', '1'), fc('D2', '&#65;&#32;1', '1'), fc('E2', '&B1;', '1'), fc('F2', '&#66', '1'), fc('G2', 'B1&', '1'), fc('H2', '&constructor;A1', '1'))))
  await scanned('formula text with a character reference past the last code point', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'A1&#1114112;', '1'))))
  await scanned('formula text with a hexadecimal reference past the last code point', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'A1&#x110000;', '1'))))
  await scanned('formula text with a huge hexadecimal reference', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', `A1&#x${'F'.repeat(40)};`, '1'))))
  await scanned('formula text with a huge decimal reference', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', `A1&#${'9'.repeat(30)};`, '1'))))
  await scanned('formula text in CDATA', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('C1', '<f><![CDATA[B1]]></f><v>1</v>'), fc('D1', 'A1', '1'))))
  await scanned('formula attributes in other quotes and orders', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')),
    c('C1', f('B1*2', " ca='1' t='normal'") + v('1')), c('D1', f('B1', ' t = "shared"  si = "0" ref="D1:E1"') + v('1')), c('E1', f('', ' si="0"  t="shared"') + v('1')),
    c('F1', f('A1', ' t="shared" xt="shared" si="1"') + v('1')), c('G1', f('B1', ' t="shared" ref="G1:H1" si=\'2\'') + v('1')), c('H1', f('', ' t="shared" si=\'2\'') + v('1')))))
  await scanned('formula text with surrounding space and breaks', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', ' \n\tB1 \r\n', '1'), fc('D1', '\u00a0B1\u00a0', '1'), fc('E1', '\ufeffB1', '1'), fc('F1', ' = B1', '1'), fc('G1', '=B1', '1'))))
  await scanned('formula text with astral characters', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', '"\u{1F600}"&amp;B1', '1'), fc('D1', '"\u{1F600}"&amp;A1', '1'), fc('E1', '\u{1F600}', '1'), fc('F1', "'\u{1F600}'!B1", '1'), fc('G1', '"\u{1F600}', '1'))))
  await scanned('no sheet data', `${DECL}<worksheet xmlns="${S}"/>`)
  await scanned('self-closed sheet data', `${DECL}<worksheet xmlns="${S}"><sheetData/></worksheet>`)
  await scanned('formulas after the sheet data are not scanned', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1')), '<f>B1</f><c r="D1"><f>B1</f></c>'))
  await scanned('sheet data close before its open', `${DECL}<worksheet xmlns="${S}"></sheetData><sheetData>${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData></worksheet>`)
  await scanned('sheet data without a close', `${DECL}<worksheet xmlns="${S}"><sheetData>${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</worksheet>`)
  await scanned('sheet data element with attributes', `${DECL}<worksheet xmlns="${S}"><sheetData\tx="1">${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData></worksheet>`)
  await scanned('cells with an address in lower case and spaces', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), c('c1', f('B1') + v('1')), c(' D1 ', f('B1') + v('1')), c('E1', f('b1') + v('1')))))
  await scanned('marks that cover only cells with no formula', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'A1', '1'))))
  await scanned('formulas on a sheet with a mark that covers the whole sheet', sheet(row(1, c('A1', v('plain')), fc('B1', 'A1', '1'))), [{ name: 'Pay', marks: [mark(0, 1048575, 0, 16383, 'All')] }])

  // a sheet past the scan limit is withheld whole, and so is every read of it
  const small = sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'), fc('D1', 'A1', '1'), fc('E1', 'Big!A1', '1')))
  const bigRows = Array.from({ length: 200 }, (_, index) => row(index + 1, c(`A${index + 1}`, v(`big ${index}`), ' t="str"'), fc(`B${index + 1}`, `SUM(A1:A${index + 1})`, '1'))).join('')
  const bigSheet = sheet(bigRows)
  const byteLength = (xml: string) => new TextEncoder().encode(xml).length
  const twoSheets = marked([['Pay', small], ['Big', bigSheet]], PAY_B1)
  for (const limit of [0, 1, 1000, byteLength(small) - 1, byteLength(small), byteLength(small) + 1, byteLength(bigSheet) - 1, byteLength(bigSheet), byteLength(bigSheet) + 1, 20_000, 1e9, Infinity, -Infinity, -1, Number.NaN, 0.5]) {
    await add(`scan limit ${limit}, a sheet beyond it`, twoSheets, { formulaScanMaxBytes: String(limit) })
  }
  out.push({ label: 'derived: scan limit 1000, a sheet stored beyond it', bytes: await book(twoSheets, 'STORE'), args: { formulaScanMaxBytes: '1000' } })
  const hugeRows = Array.from({ length: 1500 }, (_, index) => row(index + 1, c(`A${index + 1}`, v(`huge ${index}`), ' t="str"'), fc(`B${index + 1}`, `A${index + 1}`, '1'), fc(`C${index + 1}`, `SUM(A1:A${index + 1})`, '1'))).join('')
  const hugeSheet = sheet(hugeRows)
  const hugeBook = marked([['Pay', small], ['Big', hugeSheet]], PAY_B1)
  for (const [limit, compression] of [[20_000, 'STORE'], [20_000, 'DEFLATE'], [byteLength(hugeSheet), 'STORE'], [byteLength(hugeSheet) + 1, 'STORE'], [16_384, 'STORE'], [32_768, 'STORE']] as const) {
    out.push({ label: `derived: scan limit ${limit}, a larger sheet ${compression.toLowerCase()}d`, bytes: await book(hugeBook, compression), args: { formulaScanMaxBytes: String(limit) } })
  }
  await add('scan limit with a sheet that is missing', marked([['Pay', small], ['Missing', null]], PAY_B1), { formulaScanMaxBytes: '100' })
  await add('scan limit with budget', twoSheets, { formulaScanMaxBytes: '1000', maxChars: '300' })
  await add('scan limit and no marks', { sheets: [['Pay', small], ['Big', bigSheet]] }, { formulaScanMaxBytes: '1' })

  // reading budgets leave the trace over every sheet
  const budgeted = marked([
    ['Pay', sheet(row(1, c('A1', v('plain')), fc('B1', 'Third!A1', '1')) + row(2, c('A2', v('plain 2')), c('B2', v('1000'))))],
    ['Report', sheet(wideRows(60, n => `row ${n}`) + row(61, fc('A61', 'Pay!B2', '1'), fc('B61', 'Third!B1', '1')))],
    ['Third', sheet(row(1, c('A1', v('third')), fc('B1', 'Report!A61', '1')))],
  ], [{ name: 'Pay', marks: [mark(1, 1, 1, 1, 'Salary')] }, { name: 'Third', marks: [mark(0, 0, 0, 0, 'Name')] }])
  for (const maxChars of [1, 30, 200, 1500, 100000]) await add(`budget maxChars=${maxChars}`, budgeted, { maxChars: String(maxChars) })

  // sheets the trace has no part for
  await add('a sheet whose part is missing', marked([['Pay', small], ['Missing', null]], PAY_B1))
  await add('a sheet with no relationship', marked([['Pay', small], ['Other', sheet(row(1, c('A1', v('other'))))]], PAY_B1, {
    files: { 'xl/workbook.xml': `${DECL}<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Pay" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2"/></sheets></workbook>` },
  }))
  await add('a sheet whose part is empty', marked([['Pay', small], ['Empty', '']], PAY_B1))
  await add('a sheet whose part does not inflate', marked([['Pay', small], ['Other', sheet(row(1, c('A1', v('other'))) + ' '.repeat(200))]], PAY_B1))
  out.push({ label: 'derived: a sheet part that does not inflate', bytes: breakEntry(await book(marked([['Pay', small], ['Other', sheet(row(1, c('A1', v('other'))) + ' '.repeat(200))]], PAY_B1)), 'xl/worksheets/sheet2.xml') })
  out.push({ label: 'derived: a sheet part that does not inflate, scan limit 1', bytes: breakEntry(await book(marked([['Pay', small], ['Other', sheet(row(1, c('A1', v('other'))) + ' '.repeat(200))]], PAY_B1)), 'xl/worksheets/sheet2.xml'), args: { formulaScanMaxBytes: '1' } })
  await add('a sheet that does not parse', marked([['Pay', small], ['Broken', `${DECL}<worksheet xmlns="${S}"><sheetData><row><c r="A1"><f>B1</f></c>`]], PAY_B1))
  await add('a pivot relationship part that does not parse', pivotBook({ sheetRels: PIVOT_RELS.replace('</Relationships>', '<Relationship') }))

  // workbooks without marks read as before, whatever their formulas and pivots say
  await add('no part, formulas that cannot be traced', { sheets: [['Pay', sheet(row(1, c('A1', v('plain')), fc('B1', 'INDIRECT("A1")', '1'), fc('C1', 'Table1[Amount]', '1'), c(null, f('A1') + v('1'))))]] })
  await add('part without marks, formulas', { sheets: [['Pay', sheet(row(1, c('A1', v('plain')), fc('B1', 'A1', '1'), c('C1', f('A1', ' t="array"') + v('1'))))]], files: { 'xl/gxRedactions.json': part([{ name: 'Pay', marks: [] }]) } })
  await add('empty part, formulas', { sheets: [['Pay', sheet(row(1, c('A1', v('plain')), fc('B1', 'A1', '1'), c(null, f('A1') + v('1'))))]], files: { 'xl/gxRedactions.json': part([]) } })
  await add('no marks, a pivot with an unreadable source', pivotBook({ marks: null, cache: cacheXml('<cacheSource type="external"/>') }))
  await add('no marks, a pivot with a source in this workbook', pivotBook({ marks: null }))
  await add('no marks, a formula without an address and a defined name', { sheets: [['Pay', sheet(row(1, c('A1', v('plain')), c(null, f('Secret') + v('1')), c('B1', f('Secret') + v('2'))))]], definedNames: '<definedName name="Secret">Pay!$B$1</definedName>' })

  // PivotTables: where the output is, and what it was computed from
  const sources: Array<[string, string, string?]> = [
    ['source range of this workbook', 'ref="A1:C4" sheet="Data"'],
    ['source range that misses the mark', 'ref="A1:B4" sheet="Data"'],
    ['source range with dollars', 'ref="$A$1:$C$4" sheet="Data"'],
    ['source range that is the marked cell', 'ref="C2" sheet="Data"'],
    ['source range reversed', 'ref="C4:A1" sheet="Data"'],
    ['source sheet in another case', 'ref="A1:C4" sheet="DATA"'],
    ['source sheet that is not there', 'ref="A1:C4" sheet="Gone"'],
    ['source range that cannot be read', 'ref="A1:C" sheet="Data"'],
    ['source range of whole columns', 'ref="C:C" sheet="Data"'],
    ['source name that is defined', 'name="Sales"', SALES_NAME],
    ['source name that is a table', 'name="Table1"', SALES_NAME],
    ['source name defined without a sheet', 'name="Local"', '<definedName name="Local">$A$1:$C$4</definedName>'],
    ['source name of another sheet that misses the mark', 'name="Elsewhere"', '<definedName name="Elsewhere">Report!$A$1:$C$4</definedName>'],
    ['source range alone', 'ref="A1:C4"'],
    ['source sheet alone', 'sheet="Data"'],
    ['source name beside a range', 'name="Sales" ref="A1:C4"', SALES_NAME],
    ['source name beside a sheet', 'name="Sales" sheet="Data"', SALES_NAME],
    ['source with no attributes', ''],
    ['source sheet with a reference in its name', 'ref="A1:C4" sheet="Da&#116;a"'],
    ['source name with a reference in it', 'name="S&#97;les"', SALES_NAME],
    ['source sheet with a code point past the last', 'ref="A1:C4" sheet="Da&#1114112;ta"'],
    ['source name with a code point past the last', 'name="S&#x110000;les"', SALES_NAME],
    ['source attributes in single quotes', "ref='A1:C4' sheet='Data'"],
    ['source attributes with spaces around the sign', 'ref = "A1:C4"  sheet = "Data"'],
  ]
  for (const [label, attributes, definedNames] of sources) await add(`pivot, ${label}`, pivotBook({ cache: cacheXml(WORKSHEET_SOURCE(attributes)), ...(definedNames === undefined ? {} : { definedNames }) }))
  await add('pivot, source sheet with an apostrophe', marked([['Pay\'s Data', DATA_SHEET], ['Report', REPORT_SHEET]], [{ name: "Pay's Data", marks: [mark(1, 1, 2, 2, 'Amount')] }], {
    files: {
      'xl/worksheets/_rels/sheet2.xml.rels': PIVOT_RELS, [PIVOT_PART]: pivotXml(PIVOT_LOCATION('A3:B8')),
      'xl/pivotTables/_rels/pivotTable1.xml.rels': CACHE_RELS, [CACHE_PART]: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Pay&apos;s Data"')),
    },
  }))

  // a relationship on the source means another workbook, however it is written
  const externals: Array<[string, string, string?]> = [
    ['relationship id', ' r:id="rId1"'],
    ['relationship id in single quotes', " r:id='rId1'"],
    ['relationship id with spaces around the sign', ' r:id = "rId1"'],
    ['relationship id that is empty', ' r:id=""'],
    ['relationship prefix bound on the source', ` q:id="rId1" xmlns:q="${R}"`],
    ['relationship prefix bound on the root', ' q:id="rId1"', `xmlns="${S}" xmlns:q="${R}"`],
    ['relationship prefix bound to the strict namespace', ' s:id="rId1"', `xmlns="${S}" xmlns:s="${STRICT}"`],
    ['relationship prefix that nobody declares', ' r:id="rId1"', `xmlns="${S}"`],
    ['relationship prefix r bound to another namespace', ' r:id="rId1"', `xmlns="${S}" xmlns:r="urn:other"`],
    ['relationship prefix bound twice, relationships first', ' q:id="rId1" xmlns:q="urn:other"', `xmlns="${S}" xmlns:q="${R}"`],
    ['relationship prefix bound twice, relationships last', ` q:id="rId1" xmlns:q="${R}"`, `xmlns="${S}" xmlns:q="urn:other"`],
    ['revision id', ' xr:id="{0}"', `xmlns="${S}" xmlns:r="${R}" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"`],
    ['text that looks like an id in another attribute', ` title='x r:id="1"'`],
    ['id with no prefix', ' id="rId1"'],
    ['id in the name of another attribute', ' xr:rid="rId1"'],
    ['relationship id after a greater-than sign in a value', ' title="a>b" r:id="rId1"'],
  ]
  for (const [label, attributes, root] of externals) {
    await add(`pivot, source with ${label}`, pivotBook({ cache: cacheXml(WORKSHEET_SOURCE(`ref="A1:C4" sheet="Data"${attributes}`), root === undefined ? {} : { root }) }))
  }
  await add('pivot, source after elements that bind the prefix', pivotBook({ cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data" r:id="rId1"'), { root: `xmlns="${S}"`, before: `<x:a xmlns:r="${R}" r:id="rId2"/>` }) }))
  await add('pivot, source in a prefixed element', pivotBook({ cache: cacheXml(`<x:cacheSource type="worksheet"><x:worksheetSource ref="A1:C4" sheet="Data"/></x:cacheSource>`, { root: `xmlns:x="${S}" xmlns:r="${R}"` }) }))

  // sources that are not worksheets, and caches that cannot be read
  const caches: Array<[string, PivotSpec]> = [
    ['consolidation', { cache: cacheXml('<cacheSource type="consolidation"><consolidation autoPage="1"><pages count="1"/><rangeSets count="1"><rangeSet ref="A1:C4" sheet="Data"/></rangeSets></consolidation></cacheSource>') }],
    ['external connection', { cache: cacheXml('<cacheSource type="external" connectionId="1"/>') }],
    ['scenario', { cache: cacheXml('<cacheSource type="scenario"/>') }],
    ['source without a type', { cache: cacheXml('<cacheSource><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>') }],
    ['source with a type in other quotes', { cache: cacheXml(`<cacheSource type = 'worksheet'><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>`) }],
    ['worksheet source outside the cache source', { cache: cacheXml('<cacheSource type="worksheet"/><worksheetSource ref="A1:C4" sheet="Data"/>') }],
    ['worksheet source without a cache source', { cache: cacheXml('<worksheetSource ref="A1:C4" sheet="Data"/>') }],
    ['cache source without a worksheet source', { cache: cacheXml('<cacheSource type="worksheet"/>') }],
    ['two worksheet sources, the first misses', { cache: cacheXml('<cacheSource type="worksheet"><worksheetSource ref="A1:B4" sheet="Data"/><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>') }],
    ['source that is not an element of the document', { cache: `${DECL}<pivotCacheDefinition xmlns="${S}"><!-- <cacheSource type="worksheet"><worksheetSource ref="A1:B4" sheet="Data"/> --><cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource></pivotCacheDefinition>` }],
    ['no cache definition', { cache: null }],
    ['an empty cache definition', { cache: '' }],
    ['no relationship to the cache', { pivotRels: rels([]) }],
    ['no relationships of the pivot', { pivotRels: null }],
    ['relationships of the pivot that do not parse', { pivotRels: `${DECL}<Relationships><Relationship` }],
    ['relationship to the cache of another kind', { pivotRels: rels([['rId1', 'pivotCacheRecords', '../pivotCache/pivotCacheDefinition1.xml']]) }],
    ['relationship to the cache in the strict namespace', { pivotRels: rawRels([['rId1', `${STRICT}/pivotCacheDefinition`, '../pivotCache/pivotCacheDefinition1.xml']]) }],
    ['relationship to the cache that is external', { pivotRels: rels([['rId1', 'pivotCacheDefinition', 'https://example.com/cache.xml', 'External']]) }],
    ['relationship to the cache with no target', { pivotRels: rels([['rId1', 'pivotCacheDefinition', '  ']]) }],
    ['relationship to a cache that is not there', { pivotRels: rels([['rId1', 'pivotCacheDefinition', '../pivotCache/none.xml']]) }],
    ['relationship to the cache by an absolute target', { pivotRels: rels([['rId1', 'pivotCacheDefinition', '/xl/pivotCache/pivotCacheDefinition1.xml']]) }],
    ['relationship to the cache by an encoded target', { pivotRels: rels([['rId1', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition%31.xml']]) }],
    ['two relationships to caches, the first is missing', { pivotRels: rels([['rId1', 'pivotCacheDefinition', '../pivotCache/none.xml'], ['rId2', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition1.xml']]) }],
    ['two relationships to caches, the first is external', { pivotRels: rels([['rId1', 'pivotCacheDefinition', 'https://example.com/cache.xml', 'EXTERNAL'], ['rId2', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition1.xml']]) }],
    ['relationship to a URL target', { pivotRels: rels([['rId1', 'pivotCacheDefinition', 'https://example.com/cache.xml']]) }],
    ['no pivot part', { pivot: null }],
    ['an empty pivot part', { pivot: '' }],
    ['no relationships of the sheet', { sheetRels: rels([]) }],
    ['relationship to the pivot of another kind', { sheetRels: rels([['rId1', 'drawing', '../pivotTables/pivotTable1.xml']]) }],
    ['relationship to the pivot in the strict namespace', { sheetRels: rawRels([['rId1', `${STRICT}/pivotTable`, '../pivotTables/pivotTable1.xml']]) }],
    ['relationship to the pivot that is external', { sheetRels: rels([['rId1', 'pivotTable', '../pivotTables/pivotTable1.xml', 'External']]) }],
    ['relationship to the pivot with no target', { sheetRels: rels([['rId1', 'pivotTable', '']]) }],
    ['relationship to the pivot by an absolute target', { sheetRels: rels([['rId1', 'pivotTable', '/xl/pivotTables/pivotTable1.xml']]) }],
    ['relationship to the pivot that is not there', { sheetRels: rels([['rId1', 'pivotTable', '../pivotTables/none.xml']]) }],
    ['relationships of the sheet that do not parse', { sheetRels: `${DECL}<Relationships><Relationship Id=` }],
    ['two pivots, the second reads the mark', {
      sheetRels: rels([['rId1', 'pivotTable', '../pivotTables/pivotTable2.xml'], ['rId2', 'pivotTable', '../pivotTables/pivotTable1.xml']]),
      files: {
        'xl/pivotTables/pivotTable2.xml': pivotXml(PIVOT_LOCATION('C9:D12')), 'xl/pivotTables/_rels/pivotTable2.xml.rels': rels([['rId1', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition2.xml']]),
        'xl/pivotCache/pivotCacheDefinition2.xml': cacheXml(WORKSHEET_SOURCE('ref="A1:B4" sheet="Data"')),
      },
    }],
    ['two pivots, neither reads the mark', {
      sheetRels: rels([['rId1', 'pivotTable', '../pivotTables/pivotTable2.xml'], ['rId2', 'pivotTable', '../pivotTables/pivotTable1.xml']]),
      cache: cacheXml(WORKSHEET_SOURCE('ref="A1:B4" sheet="Data"')),
      files: {
        'xl/pivotTables/pivotTable2.xml': pivotXml(PIVOT_LOCATION('C9:D12')), 'xl/pivotTables/_rels/pivotTable2.xml.rels': rels([['rId1', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition2.xml']]),
        'xl/pivotCache/pivotCacheDefinition2.xml': cacheXml(WORKSHEET_SOURCE('ref="B1:B4" sheet="Data"')),
      },
    }],
    ['a pivot with a mark on its own sheet', { marks: [{ name: 'Data', marks: [mark(1, 1, 2, 2, 'Amount')] }, { name: 'Report', marks: [mark(8, 8, 3, 3, 'Own')] }] }],
    ['a pivot whose source holds no mark', { marks: [{ name: 'Report', marks: [mark(0, 0, 3, 3, 'Own')] }] }],
  ]
  for (const [label, spec] of caches) await add(`pivot, ${label}`, pivotBook(spec))

  // the cache definition is read as far as its head
  const padding = (bytes: number) => `<!--${'x'.repeat(bytes)}-->`
  await add('pivot, cache source before a megabyte of other content', pivotBook({ cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"'), { after: padding(1_200_000) }) }))
  await add('pivot, cache source after a megabyte of other content', pivotBook({ cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"'), { before: padding(1_100_000) }) }))
  await add('pivot, cache source just inside the head', pivotBook({ cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"'), { before: padding(1_048_576 - 700) }) }))
  await add('pivot, cache source just past the head', pivotBook({ cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"'), { before: padding(1_048_576 - 100) }) }))
  const headSource = WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"')
  const headRoom = 1_048_576 - byteLength(cacheXml(headSource))
  for (const extra of [-1, 0, 1]) {
    await add(`pivot, cache definition ${extra === 0 ? 'of exactly' : extra < 0 ? 'one byte under' : 'one byte over'} the head`, pivotBook({ cache: cacheXml(headSource, { after: padding(headRoom + extra - 7) }) }))
  }

  // report filters: how far above and beside the output the pivot reaches
  const pages: Array<[string, string, string]> = [
    ['no report filters', PIVOT_LOCATION('A6:C10'), ''],
    ['one filter above', PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['two filters in two rows', PIVOT_LOCATION('A6:C10', ' rowPageCount="2" colPageCount="1"'), PIVOT_PAGE_FIELDS(2)],
    ['two filters side by side', PIVOT_LOCATION('A6:A10', ' rowPageCount="1" colPageCount="2"'), PIVOT_PAGE_FIELDS(2)],
    ['three filters in a grid of four', PIVOT_LOCATION('B7:C10', ' rowPageCount="2" colPageCount="2"'), PIVOT_PAGE_FIELDS(3)],
    ['filters past the declared layout', PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"'), PIVOT_PAGE_FIELDS(2)],
    ['filters with no layout', PIVOT_LOCATION('A6:C10'), PIVOT_PAGE_FIELDS(2)],
    ['a layout with no filters', PIVOT_LOCATION('A6:C10', ' rowPageCount="2" colPageCount="1"'), ''],
    ['a layout of zero with no filters', PIVOT_LOCATION('A6:C10', ' rowPageCount="0" colPageCount="0"'), ''],
    ['one count only', PIVOT_LOCATION('A6:C10', ' rowPageCount="2"'), PIVOT_PAGE_FIELDS(1)],
    ['the other count only', PIVOT_LOCATION('A6:C10', ' colPageCount="2"'), PIVOT_PAGE_FIELDS(1)],
    ['a count that is not whole', PIVOT_LOCATION('A6:C10', ' rowPageCount="1.5" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a count in words', PIVOT_LOCATION('A6:C10', ' rowPageCount="two" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a count of zero', PIVOT_LOCATION('A6:C10', ' rowPageCount="0" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a negative count', PIVOT_LOCATION('A6:C10', ' rowPageCount="-1" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a count with spaces', PIVOT_LOCATION('A6:C10', ' rowPageCount=" 2 " colPageCount="1"'), PIVOT_PAGE_FIELDS(2)],
    ['a count in hexadecimal and one in exponent form', PIVOT_LOCATION('A6:C10', ' rowPageCount="0x2" colPageCount="1e0"'), PIVOT_PAGE_FIELDS(2)],
    ['a count that is not finite', PIVOT_LOCATION('A6:C10', ' rowPageCount="Infinity" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a layout wider than the output', PIVOT_LOCATION('A6:B10', ' rowPageCount="1" colPageCount="3"'), PIVOT_PAGE_FIELDS(1)],
    ['a layout taller than the sheet above', PIVOT_LOCATION('A3:C10', ' rowPageCount="5" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['a layout at the last columns', PIVOT_LOCATION('XFC6:XFD10', ' rowPageCount="1" colPageCount="3"'), PIVOT_PAGE_FIELDS(1)],
    ['an output that is one cell', PIVOT_LOCATION('B7', ' rowPageCount="1" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
    ['the filter list only, with no filter in it', PIVOT_LOCATION('A6:C10'), '<pageFields count="0"/>'],
    ['filters named in another prefix', PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"'), PIVOT_PAGE_FIELDS(2, 'x:')],
    ['filters named with no attributes', PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="2"'), '<pageFields><pageField/><pageField></pageField></pageFields>'],
    ['filter text that is not an element', PIVOT_LOCATION('A6:C10'), '<!-- <pageField fld="0"/> --><pageFieldX/>'],
    ['an output with dollars and reversed ends', PIVOT_LOCATION('$C$10:$A$6'), ''],
    ['an output in lower case', PIVOT_LOCATION('a6:c10'), ''],
    ['an output with spaces', PIVOT_LOCATION(' A6 : C10 '), ''],
    ['an output that is not a range', PIVOT_LOCATION('A6:'), ''],
    ['an output that is not an address', PIVOT_LOCATION('bad'), ''],
    ['an output of whole columns', PIVOT_LOCATION('A:C'), ''],
    ['an output of three corners', PIVOT_LOCATION('A6:C10:D12'), ''],
    ['an output with no reference', '<location firstHeaderRow="1"/>', ''],
    ['an output with an empty reference', '<location ref=""/>', ''],
    ['no output', '', ''],
    ['an output named in a prefix', '<x:location ref="A6:C10"/>', ''],
    ['an output with a reference in single quotes', "<location ref='A6:C10'/>", ''],
    ['an output with the reference after other attributes', '<location firstHeaderRow="1" ref = "A6:C10" firstDataRow="2"></location>', ''],
    ['an element that only starts like an output', '<locations ref="A1:A2"/>' + PIVOT_LOCATION('A6:C10'), ''],
    ['two outputs, the first counts', PIVOT_LOCATION('A6:B8') + PIVOT_LOCATION('A6:C10'), ''],
    ['an output in the pivot of an unreadable source', PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"'), PIVOT_PAGE_FIELDS(1)],
  ]
  for (const [label, location, fields] of pages) {
    await add(`pivot, ${label}`, pivotBook({ pivot: pivotXml(location, fields) }))
    await add(`pivot, ${label}, source from another workbook`, pivotBook({
      pivot: pivotXml(location, fields), cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data" r:id="rId1"')),
    }))
  }
  await add('pivot, output that no source reaches, filters above', pivotBook({
    pivot: pivotXml(PIVOT_LOCATION('A6:C10', ' rowPageCount="2" colPageCount="1"'), PIVOT_PAGE_FIELDS(2)), cache: cacheXml(WORKSHEET_SOURCE('ref="A1:B4" sheet="Data"')),
  }))

  // a pivot part is read up to 64 MB: what lies past that is not known
  const MEGABYTE = 1024 * 1024
  const past = padding(65 * MEGABYTE)
  await add('pivot, output past what was read', pivotBook({ pivot: `${DECL}<pivotTableDefinition xmlns="${S}" name="PivotTable1" cacheId="1">${past}${PIVOT_LOCATION('A6:C10')}</pivotTableDefinition>` }), {}, false)
  await add('pivot, filters past what was read', pivotBook({ pivot: `${DECL}<pivotTableDefinition xmlns="${S}" name="PivotTable1" cacheId="1">${PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"')}${past}${PIVOT_PAGE_FIELDS(2)}</pivotTableDefinition>` }), {}, false)
  await add('pivot, filters past what was read, source from another workbook', pivotBook({
    pivot: `${DECL}<pivotTableDefinition xmlns="${S}" name="PivotTable1" cacheId="1">${PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"')}${past}</pivotTableDefinition>`,
    cache: cacheXml(WORKSHEET_SOURCE('ref="A1:C4" sheet="Data" r:id="rId1"')),
  }), {}, false)
  await add('pivot, filters just inside what was read', pivotBook({ pivot: `${DECL}<pivotTableDefinition xmlns="${S}" name="PivotTable1" cacheId="1">${PIVOT_LOCATION('A6:C10', ' rowPageCount="1" colPageCount="1"')}${padding(64 * MEGABYTE - 4096)}${PIVOT_PAGE_FIELDS(1)}</pivotTableDefinition>` }), {}, false)
  return out
}

/** The record of withheld cells, and what computes from them, in a workbook whose tags are spelled another valid way. */
const REDACTION_REL_TYPE = 'https://schemas.genspark.ai/genoffice/2026/relationships/redactions'
const HIDDEN_LABEL = 'client phone'
const HIDDEN_SECRET = '13800138000'
const HIDDEN_LABEL_CELL = 'Name'
const FAKE_ENTRIES =
  '</sheetData></worksheet><worksheet><sheetData><row r="2"><c r="B2"><v>0</v></c></row>' +
  '<c r="C2"><f>1</f><v>1</v></c></definedNames>' +
  '<definedName name="_gxRedaction_9" hidden="1">"{""v"":1,""sheet"":1,""from"":[0,0],""to"":[0,0],""label"":""fake""}"</definedName>' +
  `<Relationship Id="rId9" Type="${REDACTION_REL_TYPE}" Target="fake.json"/>` +
  '<Override PartName="/xl/gxRedactions.json" ContentType="a"/><f>1</f>'

const inTags = (xml: string, edit: (tag: string) => string): string => xml.replace(/<[^>!?]+>/g, edit)
const ELEMENT_NAMES = 'c|f|row|definedName|sheet|Relationship|Override|sheetData|location|worksheetSource'
const decodeText = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')

const TAG_SPELLINGS: Record<string, (xml: string) => string> = {
  'single quotes': xml => inTags(xml, tag => tag.replace(/="([^"]*)"/g, "='$1'")),
  'spaces around =': xml => inTags(xml, tag => tag.replace(/(\s[\w:.-]+)=(["'])/g, '$1 = $2')),
  'newlines between attributes': xml => inTags(xml, tag => tag.replace(/(["'])\s+([\w:.-]+=)/g, '$1\r\n\t$2')),
  'reversed attribute order': xml =>
    inTags(xml, tag => {
      const head = /^<[\w:.-]+/.exec(tag)?.[0]
      if (head === undefined) return tag
      const attributes = [...tag.matchAll(/\s[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g)].map(match => match[0])
      return `${head}${attributes.reverse().join('')}${tag.endsWith('/>') ? '/>' : '>'}`
    }),
  '> and /> inside values': xml => xml.replace(new RegExp(`<((?:[\\w.-]+:)?(?:${ELEMENT_NAMES}))(?=[\\s/>])`, 'g'), '<$1 data-x="a/>b>c"'),
  comments: xml =>
    xml
      .replace(/<\/f>/g, '<!-- </f> --></f>')
      .replace(/<\/(t|v)>/g, '<!-- </$1> --></$1>')
      .replace(/<\/definedName>/g, '</definedName><!-- </definedName> -->')
      .replace(/(<c(?=\s)[^>/]*>)/g, '$1<!-- </c></row></sheetData> <c r="B2"><v>0</v></c> -->')
      .replace(/<definedNames>/, '<definedNames><!-- <definedName name="_gxRedaction_9" hidden="1">"{""v"":1,""sheet"":1,""from"":[0,0],""to"":[0,0],""label"":""fake""}"</definedName> -->')
      .replace(/<Relationships[^>]*>/g, tag => `${tag}<!-- <Relationship Type="${REDACTION_REL_TYPE}" Target="x"/> -->`),
  'fake markup in CDATA': xml =>
    xml
      .replaceAll(`<t>${HIDDEN_LABEL_CELL}</t>`, `<t><![CDATA[${FAKE_ENTRIES}]]></t>`)
      .replace('>"hello"</definedName>', () => `><![CDATA["${FAKE_ENTRIES.replaceAll('"', '""')}"]]></definedName>`),
  'space before > in end tags': xml => xml.replace(/<\/([\w:.-]+)>/g, '</$1 >'),
  'space before > in start tags': xml =>
    inTags(xml, tag => (/^<[\w:.-]/.test(tag) ? tag.replace(/(\/?)>$/, (_all, slash: string) => ` ${slash}>`) : tag)),
  CDATA: xml =>
    xml.replace(/<(f|t|v|definedName|formula1)((?:\s[^>]*)?)>([^<]+)<\/\1>/g, (_all, name: string, attributes: string, text: string) =>
      `<${name}${attributes}><![CDATA[${decodeText(text)}]]></${name}>`),
  'namespace prefix': xml =>
    /xmlns="(?:http:\/\/schemas\.openxmlformats\.org\/(?:spreadsheetml\/2006\/main|package\/2006\/(?:relationships|content-types)))"/.test(xml)
      ? xml.replace(/(<[\w:.-]+[^>]*?)\sxmlns="/, '$1 xmlns:x="').replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1x:$2')
      : xml,
}
TAG_SPELLINGS.all = xml =>
  ['single quotes', 'spaces around =', 'CDATA', 'comments', '> and /> inside values', 'space before > in end tags'].reduce(
    (out, name) => TAG_SPELLINGS[name]!(out), xml)

type RecordKind = 'part' | 'mirror' | 'both'
const HIDDEN_PAYLOAD = (sheetIndex: number, from: [number, number], to: [number, number], label: string) =>
  `"${JSON.stringify(mirrorMark(sheetIndex, from, to, label)).replaceAll('"', '""')}"`
const hiddenCell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`

/** Data (B2:B3 withheld, a formula, a text formula and a defined name over B2) and Report (a PivotTable over Data), each part as it is written. */
function hiddenParts(record: RecordKind, strings: 'shared' | 'inline'): Record<string, string> {
  const phone = strings === 'shared' ? '<c r="B2" t="s"><v>0</v></c>' : hiddenCell('B2', HIDDEN_SECRET)
  const data = sheet(
    row(1, hiddenCell('A1', HIDDEN_LABEL_CELL), hiddenCell('B1', 'Phone')) +
    row(2, hiddenCell('A2', 'Kim'), phone, c('C2', f('B2*2') + v('27600276000')), c('D2', f('B2&amp;"x"') + v(`${HIDDEN_SECRET}x`), ' t="str"'), c('E2', f('phone') + v(HIDDEN_SECRET))) +
    row(3, hiddenCell('A3', 'Lee'), hiddenCell('B3', 'second')) +
    row(5, c('C5', f('1+1') + v('2'))),
    '<dataValidations count="1"><dataValidation type="list" sqref="G2"><formula1>$B$2:$B$3</formula1></dataValidation></dataValidations>',
  )
  const report = sheet(
    row(3, hiddenCell('A3', 'Phone'), hiddenCell('B3', 'Total'), hiddenCell('D3', 'beside')) + row(4, hiddenCell('A4', HIDDEN_SECRET), c('B4', v('27600276000'))),
  )
  const names = '<definedName name="phone">Data!$B$2</definedName><definedName name="greeting">"hello"</definedName>' +
    (record === 'part' ? '' : mirror(0, mirrorMark(0, [1, 1], [2, 1], HIDDEN_LABEL)))
  return bookParts({
    sheets: [['Data', data], ['Report', report]],
    definedNames: names,
    extraRels: [['rId3', 'sharedStrings', 'sharedStrings.xml']],
    files: {
      'xl/sharedStrings.xml': sst(strings === 'shared' ? `<si><t>${HIDDEN_SECRET}</t></si>` : '<si><t>unused</t></si>'),
      ...(record === 'mirror' ? {} : { 'xl/gxRedactions.json': part([{ name: 'Data', marks: [mark(1, 2, 1, 1, HIDDEN_LABEL)] }]) }),
      'xl/worksheets/_rels/sheet2.xml.rels': PIVOT_RELS,
      [PIVOT_PART]: pivotXml(PIVOT_LOCATION('A3:B4')),
      'xl/pivotTables/_rels/pivotTable1.xml.rels': CACHE_RELS,
      [CACHE_PART]: cacheXml(WORKSHEET_SOURCE('ref="A1:B3" sheet="Data"')),
    },
  })
}

/** Every XML part of the workbook rewritten by `spelling` (the record's JSON part is left alone). */
const spelled = (parts: Record<string, string>, spelling: string | null): Record<string, string> =>
  Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, spelling === null || !/\.(?:xml|rels)$/.test(name) ? xml : TAG_SPELLINGS[spelling]!(xml)]))

async function spellingInputs(): Promise<Input[]> {
  const out: Input[] = []
  const add = async (label: string, bytes: Uint8Array | Book, mutate = false) =>
    out.push({ label, bytes: bytes instanceof Uint8Array ? bytes : await book(bytes), ...(mutate ? {} : { mutate: false }) })

  // the record is found, and the cells it hides stay hidden, however the tags are written
  for (const spelling of [null, ...Object.keys(TAG_SPELLINGS)]) {
    for (const record of ['part', 'mirror', 'both'] as const) {
      for (const strings of ['shared', 'inline'] as const) {
        await add(`withheld: spelled ${spelling ?? 'as written'}, record ${record}, ${strings} strings`, await zip(spelled(hiddenParts(record, strings), spelling)),
          spelling === 'all' && strings === 'shared')
      }
    }
  }

  // the mirrored names of the workbook, read as an XML parser reads them
  const PAYLOAD = HIDDEN_PAYLOAD(0, [1, 1], [2, 2], 'Salary')
  const OTHER = HIDDEN_PAYLOAD(1, [0, 0], [0, 0], 'Name')
  const two: Book['sheets'] = [['Pay', GRID_SHEET], ['Other', GRID_TWO]]
  const sheetElements = (open = '<sheet', close = '/>') => `${open} name="Pay" sheetId="1" r:id="rId1"${close}${open} name="Other" sheetId="2" r:id="rId2"${close}`
  const workbook = (inner: string, root = `xmlns="${S}" xmlns:r="${R}"`, tag = 'workbook', prolog = '') => `${DECL}${prolog}<${tag} ${root}>${inner}</${tag}>`
  const names = (inner: string) => `<sheets>${sheetElements()}</sheets><definedNames>${inner}</definedNames>`
  const withWorkbook = (xml: string, extra: Partial<Book> = {}): Book => ({ sheets: two, ...extra, files: { 'xl/workbook.xml': xml, ...extra.files } })
  const entry = (attributes: string, body: string, end = '</definedName>') => `<definedName ${attributes}>${body}${end}`
  const MIRROR = 'name="_gxRedaction_0" hidden="1"'
  const mirrored: Array<[string, string]> = [
    ['single quotes and spaces', entry(`hidden = '1'   name = '_gxRedaction_0'`, PAYLOAD, '</definedName >')],
    ['attributes over lines, reversed', entry('\r\n\thidden="1"\r\n\tname="_gxRedaction_0"\r\n', PAYLOAD)],
    ['a name given twice, the last read', entry('name="other" name="_gxRedaction_0"', PAYLOAD)],
    ['a name given twice, the last not a mirror', entry('name="_gxRedaction_0" name="other"', PAYLOAD)],
    ['formula in CDATA', entry(MIRROR, `<![CDATA[${PAYLOAD}]]>`)],
    ['formula in CDATA beside text', entry(MIRROR, `${PAYLOAD.slice(0, 1)}<![CDATA[${PAYLOAD.slice(1, -1)}]]>${PAYLOAD.slice(-1)}`)],
    ['formula with a comment in it', entry(MIRROR, `${PAYLOAD.slice(0, 1)}<!-- </definedName> -->${PAYLOAD.slice(1)}`)],
    ['formula with a child element in it', entry(MIRROR, `<b>x</b>${PAYLOAD}`)],
    ['formula with a processing instruction in it', entry(MIRROR, `<?x?>${PAYLOAD}`)],
    ['formula with named quotes', entry(MIRROR, PAYLOAD.replaceAll('"', '&quot;'))],
    ['formula with decimal quotes', entry(MIRROR, PAYLOAD.replaceAll('"', '&#34;'))],
    ['formula with hexadecimal quotes', entry(MIRROR, PAYLOAD.replaceAll('"', '&#x22;'))],
    ['formula with a reference that is not a character', entry(MIRROR, PAYLOAD.replace('Salary', 'Sal&#x110000;ary'))],
    ['formula with a reference that is not whole', entry(MIRROR, PAYLOAD.replace('Salary', 'Sal&#xZZ;ary&amp'))],
    ['formula with space around it', entry(MIRROR, `\r\n  ${PAYLOAD}\t `)],
    ['entry in a comment', `<!-- ${entry(MIRROR, PAYLOAD)} -->`],
    ['entry in CDATA', `<![CDATA[${entry(MIRROR, PAYLOAD)}]]>`],
    ['entry in a processing instruction', `<?x ${entry(MIRROR, PAYLOAD)}?>`],
    ['entry a comment follows', `${entry(MIRROR, PAYLOAD)}<!-- ${entry('name="_gxRedaction_1" hidden="1"', 'not json')} -->`],
    ['entry written empty', `<definedName ${MIRROR}></definedName>`],
    ['entry written self-closed with space', `<definedName ${MIRROR} />`],
    ['entry written self-closed in single quotes', `<definedName name='_gxRedaction_0'/>`],
    ['two entries, the second damaged', entry(MIRROR, PAYLOAD) + entry('name="_gxRedaction_1"', '"{oops}"')],
    ['two entries, one per sheet', entry(MIRROR, PAYLOAD) + entry('name="_gxRedaction_1"', OTHER)],
    ['two entries, the second of the first sheet', entry(MIRROR, PAYLOAD) + entry('name="_gxRedaction_1"', HIDDEN_PAYLOAD(0, [0, 0], [0, 0], 'Head'))],
    ['entry of a sheet no tab has', entry(MIRROR, HIDDEN_PAYLOAD(7, [0, 0], [0, 0], 'Gone'))],
    ['entry that is not a mirror in a name', entry('name="_gxRedaction_0X"', 'not json') + entry(MIRROR, PAYLOAD)],
    ['entry beside a comment that holds its end tag', entry(MIRROR, PAYLOAD) + '<!-- </definedName> -->' + entry('name="_gxRedaction_1"', OTHER)],
    ['entry in a prefix the root does not have', `<y:definedName ${MIRROR}>${PAYLOAD}</y:definedName>`],
    ['prefixed entry beside a plain one', `<y:definedName name="_gxRedaction_1">not json</y:definedName>${entry(MIRROR, PAYLOAD)}`],
  ]
  for (const [label, inner] of mirrored) await add(`withheld: spelled mirror, ${label}`, withWorkbook(workbook(names(inner))))
  for (const name of ['_gxRedaction_01', '_gxRedaction_', '_gxRedaction_0 ', ' _gxRedaction_0', '_GXREDACTION_0', '_gxRedaction_\uFF10', '_gxRedaction_0\n', 'x_gxRedaction_0', '_gxRedaction_12', '_gxRedaction_0_1', '_gxredaction_0']) {
    await add(`withheld: spelled mirror, name ${JSON.stringify(name)}`, withWorkbook(workbook(names(entry(`name="${name}"`, PAYLOAD)))))
  }
  await add('withheld: spelled mirror, plain elements of a prefixed workbook', withWorkbook(workbook(
    `<x:sheets>${sheetElements('<x:sheet')}</x:sheets><x:definedNames>${entry(`name="_gxRedaction_0"`, PAYLOAD).replaceAll('definedName', 'x:definedName')}<definedName name="_gxRedaction_1">not json</definedName></x:definedNames>`,
    `xmlns:x="${S}" xmlns:r="${R}"`, 'x:workbook')))
  await add('withheld: spelled mirror, prefixed elements of a plain workbook', withWorkbook(workbook(
    `<sheets>${sheetElements()}</sheets><definedNames>${entry(MIRROR, PAYLOAD)}<y:definedName name="_gxRedaction_1">not json</y:definedName></definedNames>`)))
  await add('withheld: spelled mirror, the sheets of another prefix are not the tabs', withWorkbook(workbook(
    `<sheets><y:sheet name="Decoy" sheetId="3"/>${sheetElements()}</sheets><definedNames>${entry(MIRROR, PAYLOAD)}</definedNames>`)))
  await add('withheld: spelled mirror, a comment before the root holds a start tag of another prefix', withWorkbook(workbook(names(entry(MIRROR, PAYLOAD)), undefined, undefined, '<!-- <x:a> -->')))
  await add('withheld: spelled mirror, a processing instruction before the root', withWorkbook(workbook(names(entry(MIRROR, PAYLOAD)), undefined, undefined, '<?xml-stylesheet href="a"?>')))
  await add('withheld: spelled mirror, a doctype before the root', withWorkbook(workbook(names(entry(MIRROR, PAYLOAD)), undefined, undefined, '<!DOCTYPE workbook>')))

  // the tabs the mirror counts in, read as an XML parser reads them
  const tabs = (inner: string) => withWorkbook(workbook(`<sheets>${inner}</sheets><definedNames>${entry(MIRROR, HIDDEN_PAYLOAD(1, [0, 0], [1, 1], 'Second'))}</definedNames>`))
  await add('withheld: spelled sheets, single quotes', tabs(`<sheet name='Pay' sheetId='1' r:id='rId1'/><sheet name='Other' sheetId='2' r:id='rId2'/>`))
  await add('withheld: spelled sheets, spaces around the sign', tabs(`<sheet name = "Pay" sheetId = "1" r:id = "rId1" /><sheet\r\n name\t=\t'Other'\r\n sheetId="2" r:id="rId2"></sheet >`))
  await add('withheld: spelled sheets, name after other attributes', tabs(`<sheet sheetId="1" r:id="rId1" name="Pay"/><sheet sheetId="2" r:id="rId2" name="Other"/>`))
  await add('withheld: spelled sheets, a tab with no name', tabs(`<sheet sheetId="1" r:id="rId1"/><sheet name="Pay" sheetId="2" r:id="rId2"/>`))
  await add('withheld: spelled sheets, a tab named twice', tabs(`<sheet name="x" name="Pay" sheetId="1" r:id="rId1"/><sheet name="Other" name="Other" sheetId="2" r:id="rId2"/>`))
  await add('withheld: spelled sheets, a tab in a comment', tabs(`<!-- <sheet name="Pay"/> --><sheet name="Pay" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/>`))
  await add('withheld: spelled sheets, a tab in CDATA', tabs(`<![CDATA[<sheet name="Pay"/>]]><sheet name="Pay" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/>`))
  await add('withheld: spelled sheets, a tab written with an end tag', tabs(`<sheet name="Pay" sheetId="1" r:id="rId1"></sheet><sheet name="Other" sheetId="2" r:id="rId2"><extLst/></sheet>`))
  await add('withheld: spelled sheets, a name with a greater-than sign', withWorkbook(workbook(`<sheets><sheet name="a&gt;b" sheetId="1" r:id="rId1"/><sheet name="c>d" sheetId="2" r:id="rId2"/></sheets><definedNames>${entry(MIRROR, HIDDEN_PAYLOAD(1, [0, 0], [1, 1], 'Second'))}</definedNames>`),
    { sheets: [['a>b', GRID_SHEET], ['c>d', GRID_TWO]] }))
  await add('withheld: spelled sheets, a name with references', withWorkbook(workbook(`<sheets><sheet name="R&amp;D &#x41;&#66;" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets><definedNames>${entry(MIRROR, PAYLOAD)}</definedNames>`),
    { sheets: [['R&D AB', GRID_SHEET], ['Other', GRID_TWO]] }))
  await add('withheld: spelled sheets, a part record beside names that are spelled another way', withWorkbook(workbook(`<sheets>${sheetElements()}</sheets>`),
    { files: { 'xl/gxRedactions.json': part([{ name: 'Pay', marks: [mark(1, 2, 1, 2, 'Salary')] }]) } }))

  // the formulas of a sheet, read as an XML parser reads them
  const scan = (label: string, xml: string, marks: unknown = PAY_B1) => add(`derived: spelled ${label}`, marked([['Pay', xml]], marks))
  const base = (...cells: string[]) => sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), ...cells))
  await scan('cells, a greater-than sign in an attribute value', sheet(row(1, c('A1', v('plain')), c('B1', v('1000')), '<c r="C1" data-x="a>b"><f t="normal" data-x="a>b">B1</f><v>1</v></c>', '<c data-x=\'>\' r="D1"><f data-x="/>">A1</f><v>1</v></c>', fc('E1', 'C1', '1'))))
  await scan('cells, addresses in single quotes and spaced', base('<c r=\'C1\'><f>B1</f><v>1</v></c>', '<c r = "D1" ><f >B1</f ><v>1</v></c >', '<c\r\n\tr="E1"\r\n><f\r\n>A1</f\r\n></c>'))
  await scan('cells, attributes reversed and quoted another way', base('<c t="n" s="1" r="C1"><f ca="1" t="normal">B1</f></c>', `<c t='n' r='D1'><f t='shared' ref='D1:E1' si='0'>B1</f></c>`, `<c r="E1"><f si="0" t="shared"/></c>`))
  await scan('cells, end tags with spaces', base('<c r="C1"><f>B1</f ><v>1</v></c >', '<c r="D1"><f>A1</f\n></c\t>'))
  await scan('cells, comments in the formula', base('<c r="C1"><f>B<!-- </f> -->1</f><v>1</v></c>', '<c r="D1"><f><!-- x -->A1<!-- <c r="B1"> --></f></c>'))
  await scan('cells, a comment that holds a cell', base('<!-- <c r="C1"><f>B1</f></c> -->', '<c r="D1"><v>3</v></c>', fc('E1', 'D1', '1')))
  await scan('cells, a comment that holds the end of the data', base('<!-- </sheetData> -->', fc('C1', 'B1', '1')))
  await scan('cells, a comment that holds the start of the data', `${DECL}<worksheet xmlns="${S}"><!-- <sheetData> -->${row(1, c('A1', v('plain')), fc('C1', 'B1', '1'))}</worksheet>`)
  await scan('cells, a comment never closed', base(fc('C1', 'B1', '1'), '<!-- <c r="D1"><f>B1</f></c>'))
  await scan('cells, formula text in CDATA', base('<c r="C1"><f><![CDATA[B1+"</f>"]]></f><v>1</v></c>', '<c r="D1"><f>A1<![CDATA[+&amp;<>]]>+A1</f></c>', '<c r="E1"><f><![CDATA[&#x110000;]]></f></c>'))
  await scan('cells, a formula that only looks like one in CDATA', base('<c r="C1" t="inlineStr"><is><t><![CDATA[<f>B1</f>]]></t></is></c>', '<c r="D1" t="inlineStr"><is><t><![CDATA[</sheetData><c r="Z1"><f>B1</f></c>]]></t></is></c>', fc('E1', 'A1', '1')))
  await scan('cells, CDATA outside a formula', base('<![CDATA[<f>B1</f>]]>', fc('C1', 'A1', '1')))
  await scan('cells, a processing instruction that holds a formula', base('<?x <c r="C1"><f>B1</f></c> ?>', fc('D1', 'A1', '1')))
  await scan('cells, a processing instruction in a formula', base('<c r="C1"><f>B<?x </f> ?>1</f></c>'))
  await scan('cells, formula in a prefix, cell in another', `${DECL}<worksheet xmlns="${S}" xmlns:y="${S}" xmlns:z="${S}"><y:sheetData><y:row r="1"><z:c r="A1"><z:v>plain</z:v></z:c><z:c r="B1"><z:v>1000</z:v></z:c><y:c r="C1"><z:f>B1</z:f></y:c><z:c r="D1"><y:f>A1</y:f></z:c></y:row></y:sheetData></worksheet>`)
  await scan('cells, a prefix with dots and dashes', `${DECL}<worksheet xmlns:a.b-c="${S}"><a.b-c:sheetData><a.b-c:row r="1"><a.b-c:c r="A1"><a.b-c:v>plain</a.b-c:v></a.b-c:c><a.b-c:c r="B1"><a.b-c:v>1000</a.b-c:v></a.b-c:c><a.b-c:c r="C1"><a.b-c:f>B1</a.b-c:f></a.b-c:c></a.b-c:row></a.b-c:sheetData></worksheet>`)
  await scan('cells, a prefix with a colon in it', `${DECL}<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>plain</v></c><c r="B1"><v>1000</v></c><a:b:c r="C1"><f>B1</f></a:b:c></row></sheetData></worksheet>`)
  await scan('cells, names that only start like the tags', base('<cc r="C1"><ff>B1</ff></cc>', '<c-x r="D1"><f-x>B1</f-x></c-x>', '<sheetDataX><f>B1</f></sheetDataX>', fc('E1', 'A1', '1')))
  await scan('cells, a cell tag that holds a slash before its end', base('<c r="C1" x=y/><f>B1</f>', '<c r="D1" />', fc('E1', 'A1', '1')))
  await scan('cells, a formula tag that ends in a slash after a value', base('<c r="C1"><f t="shared" si="0" /></c>', '<c r="D1"><f t="shared" si="0" ref="D1:E1">B1</f></c>', '<c r="E1"><f t="shared" si="0"/></c>'))
  await scan('cells, a formula tag that holds a slash in a value', base('<c r="C1"><f x="a/">B1</f></c>', '<c r="D1"><f x=\'/\'>A1</f></c>'))
  await scan('cells, a formula that is never closed', base('<c r="C1"><f>B1'))
  await scan('cells, a formula whose tag is never closed', base('<c r="C1"><f t="normal"'))
  await scan('cells, a cell whose tag is never closed', base('<c r="C1"'))
  await scan('cells, a quote that is never closed in a tag', base('<c r="C1" x="><f>B1</f></c>'))
  await scan('cells, a formula opened twice', base('<c r="C1"><f>A1<f>B1</f></c><c r="D1"><f>A1</f></c>'))
  await scan('cells, a formula closed twice', base('<c r="C1"><f>B1</f></f><c r="D1"><f>A1</f></c>'))
  await scan('cells, a formula whose cell is closed first', base('<c r="C1"><f>B1</c><c r="D1">A1</f></c>'))
  await scan('cells, a formula whose data is closed first', base('<c r="C1"><f>B1</sheetData></f><c r="D1"><f>B1</f></c>'))
  await scan('cells, a formula that holds a bad character reference', base('<c r="C1"><f>B1&#x110000;</f></c>'))
  await scan('cells, a formula that holds a bad character reference in a comment', base('<c r="C1"><f>B1<!-- &#x110000; --></f></c>'))
  await scan('cells, a bad character reference outside a formula', base('<c r="C1" t="str"><v>&#x110000;</v></c>', fc('D1', 'B1', '1')))
  await scan('cells, a bad character reference past a formula that is not closed', base('<c r="C1"><f>B1&#x110000;'))
  await scan('cells, text around a formula', base('<c r="C1">x<f>B1</f>y</c>', 'text<c r="D1">z<f>A1</f></c>text'))
  await scan('cells, a formula with a reference to the marked cell split across tags', base('<c r="C1"><f>B<!-- -->1</f></c>', '<c r="D1"><f>$B<![CDATA[$]]>1</f></c>'))
  await scan('cells, two data elements', `${DECL}<worksheet xmlns="${S}"><sheetData>${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData><sheetData>${row(2, fc('A2', 'B1', '1'))}</sheetData></worksheet>`)
  await scan('cells, a data element with spaces in its end tag', `${DECL}<worksheet xmlns="${S}"><sheetData >${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData ><x><f>B1</f></x></worksheet>`)
  await scan('cells, a data element written self-closed with a space', `${DECL}<worksheet xmlns="${S}"><sheetData /><row r="1"><c r="A1"><f>B1</f></c></row></worksheet>`)
  await scan('cells, a data element with an end tag that holds attributes', `${DECL}<worksheet xmlns="${S}"><sheetData>${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData x="1"><c r="D1"><f>B1</f></c></worksheet>`)
  await scan('cells, a data element that is a prefix of another', `${DECL}<worksheet xmlns="${S}"><sheetDataX>${row(1, fc('A1', 'B1', '1'))}</sheetDataX></worksheet>`)
  await scan('cells, data in a comment around the real one', `${DECL}<worksheet xmlns="${S}"><!-- <sheetData> --><sheetData>${row(1, c('A1', v('plain')), c('B1', v('1000')), fc('C1', 'B1', '1'))}</sheetData><!-- </sheetData> --></worksheet>`)
  await scan('cells, entities in the formula and its tag around a quote', base('<c r="C1" x="&quot;>"><f t="normal" x="&apos;">B1&amp;&quot;&gt;&quot;</f></c>'))
  await scan('cells, a tag name with a quote in it', base('<c"x r="C1"><f>B1</f></c"x>', fc('D1', 'A1', '1')))

  // a PivotTable and its cache, read as an XML parser reads them
  const pivot = (label: string, spec: PivotSpec) => add(`derived: spelled pivot, ${label}`, pivotBook(spec))
  const location = (attributes: string, tag = 'location') => `<${tag} ${attributes}/>`
  await pivot('location in single quotes and spaced', { pivot: pivotXml(`<location\r\n\tref = 'A6:C10'\r\n\trowPageCount = '1' colPageCount = "1" />`, PIVOT_PAGE_FIELDS(1)) })
  await pivot('location with its end tag', { pivot: pivotXml(`<location ref="A6:C10" rowPageCount="1" colPageCount="1"></location >`, PIVOT_PAGE_FIELDS(1)) })
  await pivot('location that is not an element', { pivot: pivotXml(`<!-- <location ref="A1:A2"/> --><![CDATA[<location ref="A1:A2"/>]]>${location('ref="A6:C10"')}`) })
  await pivot('location in a comment only', { pivot: pivotXml('<!-- <location ref="A6:C10"/> -->') })
  await pivot('location in CDATA only', { pivot: pivotXml('<![CDATA[<location ref="A6:C10"/>]]>') })
  await pivot('location in a processing instruction only', { pivot: pivotXml('<?x <location ref="A6:C10"/> ?>') })
  await pivot('location with a greater-than sign in a value', { pivot: pivotXml('<location title="a>b" ref="A6:C10" data-x=\'>\'/>') })
  await pivot('location with a reference written with entities', { pivot: pivotXml(location('ref="A&#54;:C&#x31;0" rowPageCount="&#49;" colPageCount="&#x31;"'), PIVOT_PAGE_FIELDS(1)) })
  await pivot('location with a reference given twice, the last read', { pivot: pivotXml(location('ref="A1:A2" ref=\'A6:C10\'')) })
  await pivot('location with a reference given twice, the last unreadable', { pivot: pivotXml(location('ref="A6:C10" ref="bad"')) })
  await pivot('location with a count that carries no value', { pivot: pivotXml(location('ref="A6:C10" rowPageCount colPageCount="1"'), PIVOT_PAGE_FIELDS(1)) })
  await pivot('location in a prefix with the filters in another', { pivot: pivotXml(location('ref="A6:C10" rowPageCount="1" colPageCount="2"', 'x:location'), PIVOT_PAGE_FIELDS(2, 'y:')) })
  await pivot('location inside another element', { pivot: pivotXml(`<ext>${location('ref="A6:C10"')}</ext>`) })
  await pivot('location after one that is never closed', { pivot: pivotXml(`<location ref="A6:B8">${location('ref="A6:C10"')}`) })
  await pivot('location that is never finished', { pivot: pivotXml('<location ref="A6:C10"') })
  await pivot('location whose value is never closed', { pivot: pivotXml(`<location ref="A6:C10 firstHeaderRow="1"/>`) })
  await pivot('filters spelled with spaces and end tags', { pivot: pivotXml(location('ref="A6:C10" rowPageCount="1" colPageCount="2"'), '<pageFields count="2"><pageField fld="0" /><pageField fld="1"></pageField ></pageFields>') })
  await pivot('filters in comments and CDATA', { pivot: pivotXml(location('ref="A6:C10"'), '<!-- <pageField fld="0"/> --><![CDATA[<pageField fld="0"/>]]><?x <pageField/> ?>') })
  await pivot('filters in a prefix', { pivot: pivotXml(location('ref="A6:C10" rowPageCount="1" colPageCount="1"'), '<x:pageFields><x:pageField fld="0"/></x:pageFields>') })
  await pivot('filters that only start like one', { pivot: pivotXml(location('ref="A6:C10"'), '<pageFieldX/><pageFields/><pageField-x/>') })
  await pivot('filters with a greater-than sign in a value', { pivot: pivotXml(location('ref="A6:C10" rowPageCount="1" colPageCount="1"'), '<pageField title="a>b"/>') })
  await pivot('filters after a tag whose name holds a quote', { pivot: pivotXml(location('ref="A6:C10" rowPageCount="1" colPageCount="1"'), '<a"b c="d"/><pageField fld="0"/>') })
  const source = (attributes: string, root?: string, before = '') => cacheXml(WORKSHEET_SOURCE(attributes), { ...(root === undefined ? {} : { root }), before })
  await pivot('source in a comment and CDATA first', { cache: cacheXml('<!-- <cacheSource type="worksheet"><worksheetSource ref="A1:B4" sheet="Data"/></cacheSource> --><![CDATA[<worksheetSource ref="A1:B4" sheet="Data"/>]]>' + WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"')) })
  await pivot('source in a comment only', { cache: cacheXml('<!-- <cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource> -->') })
  await pivot('source with end tags spaced', { cache: cacheXml('<cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"></worksheetSource ></cacheSource >') })
  await pivot('source with a type in single quotes and spaced', { cache: cacheXml(`<cacheSource\r\n type = 'worksheet' ><worksheetSource\r\n ref = 'A1:C4'\r\n sheet = 'Data' /></cacheSource>`) })
  await pivot('source with a type given twice, the last read', { cache: cacheXml('<cacheSource type="external" type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>') })
  await pivot('source with a type given twice, the last not a worksheet', { cache: cacheXml('<cacheSource type="worksheet" type="external"><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>') })
  await pivot('source with names given twice, the last read', { cache: cacheXml('<cacheSource type="worksheet"><worksheetSource ref="A1:B4" ref="A1:C4" sheet="Gone" sheet="Data"/></cacheSource>') })
  await pivot('source with a name and an empty sheet', { cache: source('name="Sales" sheet=""'), definedNames: SALES_NAME })
  await pivot('source with an empty reference and a sheet', { cache: source('ref="" sheet="Data"') })
  await pivot('source with an empty name', { cache: source('name=""') })
  await pivot('source with references in the sheet and range', { cache: source('ref="A1:&#67;4" sheet="Da&#x74;a"') })
  await pivot('source with a sheet whose reference is not a character', { cache: source('ref="A1:C4" sheet="Da&#xD800;ta"') })
  await pivot('source with a sheet that has quotes in it', { cache: source('ref="A1:C4" sheet="Pa&apos;y&quot;s &amp;apos; &amp;amp;"') })
  await pivot('source with a greater-than sign in a value', { cache: source('title="a>b" ref="A1:C4" sheet="Data" other=\'>\'') })
  await pivot('source with a relationship after a greater-than sign in single quotes', { cache: source(`ref="A1:C4" sheet="Data" title='a>b' r:id='rId1'`) })
  await pivot('source with a relationship id spaced and over lines', { cache: source('ref="A1:C4" sheet="Data"\r\n\tr:id\r\n\t=\r\n\t"rId1"') })
  await pivot('source with a relationship id with no value', { cache: source('ref="A1:C4" sheet="Data" r:id') })
  await pivot('source in prefixed elements with another prefix for the relationships', { cache: cacheXml(`<x:cacheSource type="worksheet"><x:worksheetSource ref="A1:C4" sheet="Data" q:id="rId1" xmlns:q="${R}"/></x:cacheSource>`, { root: `xmlns:x="${S}"` }) })
  await pivot('source in prefixed elements, the relationships bound in a comment', { cache: cacheXml(`<!-- xmlns:q="${R}" --><x:cacheSource type="worksheet"><x:worksheetSource ref="A1:C4" sheet="Data" q:id="rId1"/></x:cacheSource>`, { root: `xmlns:x="${S}" xmlns:q="urn:other"` }) })
  await pivot('source after a tag whose name holds a quote', { cache: cacheXml(`<a"b c="d"/>${WORKSHEET_SOURCE('ref="A1:C4" sheet="Data"')}`) })
  await pivot('source whose cache source is never closed', { cache: cacheXml('<cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"/>') })
  await pivot('source that is never finished', { cache: `${DECL}<pivotCacheDefinition xmlns="${S}"><cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"` })
  await pivot('source of a cache that holds a sheet in single quotes', { cache: source(`ref='A1:C4' sheet='Pay"s Data'`) })
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
  out.push(...await spellingInputs())
  out.push(...await derivedInputs())
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

type Query = [sheet: string, ref: string, hasFormula: boolean]

const NO_SUCH_SHEET = 'No such sheet'
const ODD_REFS = [
  '', 'ZZ9999', 'A1048576', 'XFD1048576', 'A1048577', 'A9999999', 'A10000000', 'A0', 'A01', 'AAAA1', '1A', 'A', '$A$1', ' A1', 'A1 ', 'A1\n',
  'a1', 'b2', 'xfd7', 'zz9999', '\uFF21' + '1', 'A' + '\uFF11', '\u017F1',
]
const MAX_QUERY_REFS = 150

const decodeAttribute = (text: string) =>
  text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|lt|gt|amp));/gi, (_, hex?: string, decimal?: string, named?: string) =>
    named === undefined ? String.fromCodePoint(Number.parseInt(hex ?? decimal!, hex === undefined ? 10 : 16)) : { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[named.toLowerCase()]!)

async function partText(zip: JSZip, name: string): Promise<string> {
  try {
    return (await zip.file(name)?.async('string')) ?? ''
  } catch {
    return ''
  }
}

/** Every cell the workbook's worksheets write, asked about under every sheet name, with and without a formula, beside refs no sheet has and names no sheet carries. */
async function withheldQueries(bytes: Uint8Array): Promise<Query[]> {
  const names: string[] = []
  const cellRefs: string[] = []
  try {
    const zip = await JSZip.loadAsync(bytes)
    for (const [, name, single] of (await partText(zip, 'xl/workbook.xml')).matchAll(/<(?:[\w.-]+:)?sheet\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) names.push(decodeAttribute(name ?? single!))
    for (const part of Object.keys(zip.files).filter(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) {
      for (const [, ref, single] of (await partText(zip, part)).matchAll(/<(?:[\w.-]+:)?c\b[^>]*?\br\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) cellRefs.push(decodeAttribute(ref ?? single!))
    }
  } catch {
    // not a workbook this reads: only the refs and names that need no workbook are asked
  }
  const written = [...new Set(cellRefs)].slice(0, MAX_QUERY_REFS)
  const refs = [...new Set([...written, ...written.slice(0, 12).map(ref => ref.toLowerCase()), ...ODD_REFS])]
  const known = [...new Set(names)]
  const sheets = [...known, ...known.slice(0, 1).map(name => name.toLowerCase()), NO_SUCH_SHEET, '']
  return sheets.flatMap(sheet =>
    (known.includes(sheet) ? refs : refs.slice(-ODD_REFS.length)).flatMap((ref): Query[] => [[sheet, ref, false], [sheet, ref, true]]))
}

async function withheldInputs(): Promise<Input[]> {
  const seeds = (await inputs()).filter(({ label, args = {} }) =>
    !('formulaScanMaxBytes' in args) && (/^(withheld|derived): /.test(label) || [
      'values and shared strings', 'formulas cached, uncomputed and shared', 'workbook missing', 'workbook unclosed tag', 'not a zip', 'empty bytes',
    ].includes(label)))
  const same = await book(marked([['Pay', GRID_SHEET], ['Pay', sheet(row(1, fc('A1', 'B2', '1'), c('B2', v('later')), fc('C1', 'B1', '2')))]], [{ name: 'Pay', marks: [mark(1, 1, 1, 1, 'Salary')] }]))
  const all: Input[] = [...seeds.map(({ label, bytes, mutate }) => ({ label: `queries: ${label}`, bytes, ...(mutate === false ? { mutate } : {}) })),
    { label: 'queries: two sheets of one name, the first answers', bytes: same }]
  return Promise.all(all.map(async input => ({ ...input, args: { queries: await withheldQueries(input.bytes!) } })))
}

export const SPECS: Spec[] = [
  {
    fn: 'xlsxToText',
    extensions: ['xlsx', 'xlsm'],
    built: inputs,
    call: ({ bytes = new Uint8Array(0), args = {} }) =>
      xlsxToText(bytes, {
        ...('maxChars' in args ? { maxChars: Number(args.maxChars) } : {}),
        ...('formulaScanMaxBytes' in args ? { formulaScanMaxBytes: Number(args.formulaScanMaxBytes) } : {}),
      }),
  },
  {
    fn: 'xlsxWithheldCells',
    extensions: ['xlsx', 'xlsm'],
    built: withheldInputs,
    call: async ({ bytes = new Uint8Array(0), args = {} }) => {
      const marker = await xlsxWithheldCells(bytes)
      return marker === null ? null : ((args.queries ?? []) as Query[]).map(([sheet, ref, hasFormula]) => marker(sheet, ref, hasFormula))
    },
  },
  {
    fn: 'unknownCellMarker',
    extensions: [],
    mutation: 'none',
    constant: true,
    built: () => [{ label: 'the marker of a cell that cannot be checked' }],
    call: () => UNKNOWN_CELL_MARKER,
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
