import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import JSZip from 'jszip'
import { checkedHwpBytes, hwpMemosOf, hwpToText } from './reference/hwp'
import { buildZip } from '../docx-diff/package-zips'
import { hostileZipInputs } from './hostile'
import type { Input, Spec } from './spec'
import { fixtureBytes } from './zip-fixture'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = 'apps/hwp/tests/fixtures/'
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(REPO, path)))
const encoder = new TextEncoder()

/** The tracked `.hwp` and `.hwpx` files: what the corpus holds, and what the built inputs start from. */
function tracked(): string[] {
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).split('\0')
  return all.filter((path) => /\.hwpx?$/i.test(path))
}

const concat = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// ---- an HWPX written part by part, on the container and header of a tracked file ----

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface Template {
  parts: Map<string, string | Uint8Array>
  head: string
}

async function template(): Promise<Template> {
  const zip = await JSZip.loadAsync(read(`${FIXTURES}memo.hwpx`))
  const parts = new Map<string, string | Uint8Array>()
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]!.dir || name === 'META-INF/rhwp-hwp5-origin') continue
    parts.set(name, name === 'Preview/PrvImage.png' ? await zip.file(name)!.async('uint8array') : await zip.file(name)!.async('string'))
  }
  const section = parts.get('Contents/section0.xml') as string
  // the section start, and the paragraph that holds the section definition, closed
  const head = `${section.slice(0, section.indexOf('</hp:run>', section.indexOf('</hp:secPr>')) + '</hp:run>'.length)}</hp:p>`
  return { parts, head }
}

let nextId = 100
const paragraph = (...runs: string[]): string =>
  `<hp:p id="${nextId++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${runs.join('')}</hp:run></hp:p>`
const t = (text: string): string => `<hp:t>${escapeXml(text)}</hp:t>`
/** A paragraph of text only. */
const p = (text: string): string => paragraph(t(text))
const subList = (...paragraphs: string[]): string =>
  `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs.join('')}</hp:subList>`

interface Cell { row: number; col: number; rowSpan?: number; colSpan?: number; paragraphs: string[]; addr?: [col: number, row: number] }

/** A table as an inline control. `grid` is rows by columns as the table declares them; the cells are written row by row. */
function table(rows: number, cols: number, cells: Cell[], inline = true): string {
  const byRow = new Map<number, Cell[]>()
  for (const cell of cells) byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell])
  const trs = [...byRow.keys()].sort((a, b) => a - b).map((row) =>
    `<hp:tr>${byRow.get(row)!.map((cell) =>
      `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3">${subList(...cell.paragraphs)}` +
      `<hp:cellAddr colAddr="${cell.addr?.[0] ?? cell.col}" rowAddr="${cell.addr?.[1] ?? cell.row}"/><hp:cellSpan colSpan="${cell.colSpan ?? 1}" rowSpan="${cell.rowSpan ?? 1}"/>` +
      `<hp:cellSz width="${Math.floor(42520 / cols)}" height="1000"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`).join('')}</hp:tr>`).join('')
  return `<hp:tbl id="1" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="NONE" repeatHeader="0" rowCnt="${rows}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">` +
    '<hp:sz width="42520" widthRelTo="ABSOLUTE" height="1000" heightRelTo="ABSOLUTE" protect="0"/>' +
    `<hp:pos treatAsChar="${inline ? 1 : 0}" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PAGE" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    '<hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
    `${trs}</hp:tbl>`
}

/** A cell written as paragraph XML, not as text. */
interface Raw { raw: string[] }

/** Cells from rows of cell texts; an empty text is an empty cell, `null` leaves the place out. */
function grid(rows: Array<Array<string | string[] | Raw | null>>): string {
  const cells: Cell[] = []
  rows.forEach((row, r) => row.forEach((text, c) => {
    if (text === null) return
    const paragraphs = typeof text === 'object' && !Array.isArray(text) ? text.raw : (Array.isArray(text) ? text : [text]).map(p)
    cells.push({ row: r, col: c, paragraphs })
  }))
  return table(rows.length, rows[0]?.length ?? 0, cells)
}

/**
 * A memo: `body` are its paragraphs, `anchor` the text it covers, `filetime` the low and high
 * DWORD of its UTC FILETIME in the command (`MEMO/shape/number/low/high/author`).
 */
function memo(author: string, number: number, body: string[], anchor = '메모 앵커', filetime: [bigint, bigint] = [BigInt(number), 1n]): string {
  return '<hp:ctrl>' +
    `<hp:fieldBegin id="${number}" type="MEMO" name="" editable="1" dirty="1"><hp:parameters cnt="6" name=""><hp:integerParam name="Prop">0</hp:integerParam>` +
    `<hp:stringParam name="Command">MEMO/65535/${number}/${filetime[0]}/${filetime[1]}/${escapeXml(author)}/\\;;</hp:stringParam><hp:stringParam name="ID">memo${number}</hp:stringParam>` +
    `<hp:integerParam name="Number">${number}</hp:integerParam><hp:stringParam name="Author">${escapeXml(author)}</hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535</hp:stringParam></hp:parameters>` +
    `${subList(...body.map(p))}</hp:fieldBegin></hp:ctrl>${t(anchor)}<hp:ctrl><hp:fieldEnd beginIDRef="${number}"/></hp:ctrl>`
}

/** A text box holding `paragraphs` (paragraph XML), written inline. */
function textBox(...paragraphs: string[]): string {
  return '<hp:rect id="2112117672" zOrder="0" numberingType="NONE" textWrap="SQUARE" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="1038375849" ratio="0">' +
    '<hp:offset x="0" y="0"/><hp:orgSz width="8000" height="3000"/><hp:curSz width="8000" height="3000"/><hp:flip horizontal="0" vertical="0"/>' +
    '<hp:rotationInfo angle="0" centerX="4000" centerY="1500" rotateimage="0"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
    '<hp:lineShape color="#000000" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>' +
    '<hc:fillBrush><hc:winBrush faceColor="#FFFFFF" hatchColor="#000000" alpha="0"/></hc:fillBrush>' +
    `<hp:drawText lastWidth="8000" name="" editable="0">${subList(...paragraphs)}<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>` +
    '<hc:pt0 x="0" y="0"/><hc:pt1 x="8000" y="0"/><hc:pt2 x="8000" y="3000"/><hc:pt3 x="0" y="3000"/>' +
    '<hp:sz width="8000" widthRelTo="ABSOLUTE" height="3000" heightRelTo="ABSOLUTE" protect="0"/>' +
    '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
    '<hp:outMargin left="283" right="283" top="283" bottom="283"/></hp:rect>'
}

async function hwpx(base: Template, body: string, edit: (parts: Map<string, string | Uint8Array>) => void = () => {}): Promise<Uint8Array> {
  const parts = new Map(base.parts)
  parts.set('Contents/section0.xml', `${base.head}${body}</hs:sec>`)
  edit(parts)
  const zip = new JSZip()
  for (const [name, data] of parts) zip.file(name, data, name === 'mimetype' ? { compression: 'STORE' } : {})
  return fixtureBytes(zip)
}

/** Several one-paragraph-per-argument documents and the single-section ones; every one is read by both sides. */
async function documents(): Promise<Input[]> {
  const base = await template()
  const inputs: Input[] = []
  const add = async (label: string, body: string, edit?: (parts: Map<string, string | Uint8Array>) => void) =>
    inputs.push({ label: `hwpx: ${label}`, bytes: await hwpx(base, body, edit) })

  // paragraphs, their whitespace, and the lines the engine writes them on
  await add('plain paragraphs', p('첫째 줄') + p('') + p('셋째 줄'))
  await add('only an empty paragraph', p(''))
  await add('no paragraph at all', '')
  await add('whitespace runs', p('  가  \t 나\u00a0다\u3000라\ufeff마 ') + p('\u0085x\u0085') + p('a\u2028b') + p('   '))
  await add('soft line break and tab', paragraph(t('앞'), '<hp:lineBreak/>', t('뒤'), '<hp:tab width="4000" leader="0" type="1"/>', t('탭 뒤')))
  await add('carriage returns in text', p('첫\r\n둘\r셋\n넷'))
  await add('repeated line', p('같은 줄') + p('같은 줄') + p('같은 줄'))
  await add('ampersand and angle text', p('A & B < C > D "q" \'s\''))
  await add('long paragraph', p('긴 문장 '.repeat(4000)))

  // numeric references the engine's plain-text export writes, and text that only looks like one
  await add('character outside cp949', p('◦ 항목 ◦'))
  await add('astral character', p('😀 웃음 𠀀'))
  await add('literal decimal reference', p('&#65; and &#x41; and &#X41;'))
  await add('literal reference without digits', p('&#; &#x; &#xZ; &#12 &#x1G;'))
  await add('literal reference to zero', p('a&#0;b'))
  await add('literal surrogate pair of references', p('&#xD83D;&#xDE00; &#55357;&#56832;'))
  await add('literal lone surrogate reference', p('x&#55357;y'))
  await add('literal reversed surrogate references', p('&#xDE00;&#xD83D;'))
  await add('literal reference past the last code point', p('&#1114112;'))
  await add('literal huge decimal reference', p('&#99999999999999999999;'))
  await add('literal huge hex reference', p('&#xFFFFFFFFFFFFFFFFFFFFFFFF;'))
  await add('literal reference with leading zeros', p('&#x0041;&#00065;'))
  await add('references in a table cell', grid([['◦ a', '&#66;'], ['b', 'c']]))

  // tables: rows, layout tables, merged and forged cells
  await add('2x2 data table', p('앞') + grid([['이름', '값'], ['가', '1'], ['나', '2']]) + p('뒤'))
  await add('table with empty cells and trailing places', grid([['a', '', 'c', '', ''], ['', '', '', '', ''], ['x', 'y', '', '', '']]))
  await add('table of only empty cells', grid([['', ''], ['', '']]))
  await add('one column table', grid([['위'], ['아래']]))
  await add('table with a cell of three paragraphs', grid([[['하나', '둘', '셋'], 'b'], ['c', 'd']]))
  await add('table with a cell of four paragraphs', grid([[['하나', '둘', '셋', '넷'], 'b'], ['c', 'd']]))
  await add('cell with blank paragraphs and spaces', grid([[['  ', '', ' 가  나 '], 'b']]))
  await add('multi-line cell text', table(1, 2, [{ row: 0, col: 0, paragraphs: [paragraph(t('윗줄'), '<hp:lineBreak/>', t('아랫줄'))] }, { row: 0, col: 1, paragraphs: [p('x')] }]))
  await add('merged cell across columns', table(2, 3, [
    { row: 0, col: 0, colSpan: 2, paragraphs: [p('합침')] }, { row: 0, col: 2, paragraphs: [p('c')] },
    { row: 1, col: 0, paragraphs: [p('d')] }, { row: 1, col: 1, paragraphs: [p('e')] }, { row: 1, col: 2, paragraphs: [p('f')] },
  ]))
  await add('merged cell down rows', table(3, 2, [
    { row: 0, col: 0, rowSpan: 2, paragraphs: [p('세로')] }, { row: 0, col: 1, paragraphs: [p('b')] },
    { row: 1, col: 1, paragraphs: [p('d')] },
    { row: 2, col: 0, paragraphs: [p('e')] }, { row: 2, col: 1, paragraphs: [p('f')] },
  ]))
  await add('cell addressed past the last row', table(1, 2, [
    { row: 0, col: 0, paragraphs: [p('a')] }, { row: 0, col: 1, paragraphs: [p('b')], addr: [1, 5] },
  ]))
  await add('cell addressed past the last column', table(1, 2, [
    { row: 0, col: 0, paragraphs: [p('a')] }, { row: 0, col: 1, paragraphs: [p('b')], addr: [7, 0] },
  ]))
  await add('table declaring more rows than it holds', table(4, 2, [{ row: 0, col: 0, paragraphs: [p('a')] }, { row: 0, col: 1, paragraphs: [p('b')] }]))
  await add('table with no cell', table(2, 2, []))
  await add('table declared with no column', table(1, 0, [{ row: 0, col: 0, paragraphs: [p('a')] }]))
  await add('two tables in one paragraph', paragraph(grid([['a', 'b']]), t('가운데'), grid([['c', 'd']])))
  await add('table nested in a cell', grid([[{ raw: [paragraph(grid([['안1', '안2'], ['안3', '안4']]), t('옆 글')), p('둘째')] }, 'x'], ['y', 'z']]))
  await add('table inside a table cell paragraph', table(1, 2, [
    { row: 0, col: 0, paragraphs: [`<hp:p id="901" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${grid([['n1', 'n2']])}${t('옆')}</hp:run></hp:p>`] },
    { row: 0, col: 1, paragraphs: [p('b')] },
  ]))
  await add('layout table of one column holding running text', grid([[['머리 문단', '이어지는 문단입니다. '.repeat(20), '또 하나', '넷째']]]))

  // text boxes, which only the plain-text export reaches
  await add('text box in a paragraph', paragraph(t('앞'), textBox(p('상자 글'), p('둘째 줄')), t('뒤')))
  await add('text box whose text repeats the body', p('같은 글') + paragraph(textBox(p('같은 글'))))
  await add('text box in a table cell', table(1, 2, [{ row: 0, col: 0, paragraphs: [paragraph(textBox(p('칸 안 상자')))] }, { row: 0, col: 1, paragraphs: [p('b')] }]))

  // the cells of a table inside a table cell reach the plain-text export on one line, tab-separated
  const tab = '<hp:tab width="4000" leader="0" type="1"/>'
  await add('text box with a tab', paragraph(textBox(paragraph(t('가'), tab, t('나')))))
  await add('text box with tabs and empty places', paragraph(textBox(paragraph(t('  가 '), tab, tab, t(' 나'), tab, tab), paragraph(tab, t('끝')), paragraph(tab))))
  await add('text box line that is tabs only', paragraph(textBox(paragraph(tab, tab))))
  await add('text box with a tab line the body also holds', p('가\t나') + paragraph(textBox(paragraph(t('가'), tab, t('나')))))

  // memos
  await add('one memo', paragraph(memo('작성자', 1, ['메모 글'])))
  await add('memo of two paragraphs', paragraph(memo('작성자', 1, ['첫 줄', '둘째 줄'])))
  await add('memo with blank paragraphs', paragraph(memo('작성자', 1, ['위', '', '아래', '', ''])))
  await add('memo with an empty body', paragraph(memo('작성자', 1, [])))
  await add('memo with an empty paragraph only', paragraph(memo('작성자', 1, [''])))
  await add('memo without an author', paragraph(memo('', 1, ['글'])))
  await add('memo with a blank author', paragraph(memo('   ', 1, ['글'])))
  await add('memo with a padded author', paragraph(memo('  홍길동  ', 1, ['글'])))
  await add('memo with a leading blank line', paragraph(memo('작성자', 1, ['', '', '글'])))
  await add('memo with line breaks in a paragraph', paragraph(memo('작성자', 1, ['a\r\nb\nc'])))
  await add('memo with a reference in its text', paragraph(memo('작성자', 1, ['◦ &#65; 글'])))
  await add('memos in several places', paragraph(memo('가', 1, ['첫째'])) + paragraph(memo('나', 2, ['둘째'])) + grid([[{ raw: [paragraph(memo('다', 3, ['칸']))] }, 'b']]))
  await add('memo and a table', paragraph(memo('가', 1, ['글'])) + grid([['a', 'b']]))
  // memo dates are the host's local time (fileparse.localOffsetSeconds): the gate job runs in a
  // zone with daylight saving time, and these sit on both sides of its changes in 2026
  const at = (iso: string): [bigint, bigint] => {
    const ticks = BigInt(Date.parse(iso) / 1000) * 10_000_000n + 116_444_736_000_000_000n
    return [ticks & 0xffff_ffffn, ticks >> 32n]
  }
  for (const iso of ['2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '1601-01-01T00:00:01Z']) {
    await add(`memo dated ${iso}`, paragraph(memo('작성자', 1, ['글'], '메모 앵커', at(iso))))
  }
  await add('memo over an empty anchor', paragraph(memo('작성자', 1, ['글'], '')))
  await add('memo in a text box', paragraph(textBox(paragraph(memo('상자', 1, ['상자 메모'])))))
  // the page of a memo is the page the engine lays it on
  await add('memo in a header', paragraph('<hp:ctrl><hp:header id="1" applyPageType="BOTH">' + subList(paragraph(memo('머리', 1, ['머리 메모']))) + '</hp:header></hp:ctrl>', t('본문')))
  await add('memo in a footnote', paragraph(t('각주 앞'), '<hp:ctrl><hp:footNote number="1" suffixChar=")" instId="1">' + subList(paragraph(memo('각주', 1, ['각주 메모']))) + '</hp:footNote></hp:ctrl>'))
  await add('memo on the second page', Array.from({ length: 120 }, (_, k) => p(`줄 ${k}`)).join('') + paragraph(memo('뒤쪽', 1, ['둘째 쪽 메모'])))

  // sections and the package around them
  await add('two sections', p('첫 구역'), (parts) => {
    parts.set('Contents/section1.xml', `${base.head}${p('둘째 구역')}</hs:sec>`)
    parts.set('Contents/content.hpf', (parts.get('Contents/content.hpf') as string)
      .replace('<opf:item id="settings"', '<opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/><opf:item id="settings"')
      .replace('<opf:itemref idref="section0" linear="yes"/>', '<opf:itemref idref="section0" linear="yes"/><opf:itemref idref="section1" linear="yes"/>'))
  })
  await add('section missing from the package', p('글'), (parts) => parts.delete('Contents/section0.xml'))
  await add('section that is not XML', '', (parts) => parts.set('Contents/section0.xml', 'not xml at all'))
  await add('empty section', '', (parts) => parts.set('Contents/section0.xml', ''))
  await add('section cut in the middle of a tag', p('글'), (parts) => parts.set('Contents/section0.xml', `${base.head}${p('글')}`.slice(0, -20)))
  await add('header missing', p('글'), (parts) => parts.delete('Contents/header.xml'))
  await add('header that is not XML', p('글'), (parts) => parts.set('Contents/header.xml', '<<<'))
  await add('manifest missing', p('글'), (parts) => parts.delete('Contents/content.hpf'))
  await add('mimetype wrong', p('글'), (parts) => parts.set('mimetype', 'application/zip'))
  await add('mimetype missing', p('글'), (parts) => parts.delete('mimetype'))
  await add('version missing', p('글'), (parts) => parts.delete('version.xml'))
  await add('only the section', p('글'), (parts) => { for (const name of [...parts.keys()]) if (name !== 'Contents/section0.xml') parts.delete(name) })
  await add('hwp5 origin marker', p('글'), (parts) => parts.set('META-INF/rhwp-hwp5-origin', '2:paragraph-utf16'))
  await add('password entry in the manifest', p('글'), (parts) => parts.set('META-INF/manifest.xml', '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry odf:full-path="Contents/section0.xml" odf:media-type="application/xml"><odf:encryption-data/></odf:file-entry></odf:manifest>'))
  return inputs
}

// ---- Hangul 5 files rewritten: the file header the engine reads first ----

function withHeader(bytes: Uint8Array, change: (header: Buffer) => void): Uint8Array {
  const file = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const entry = CFB.find(file, '/FileHeader')!
  const header = Buffer.from(entry.content as Uint8Array)
  change(header)
  entry.content = header
  return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
}

/** Truncation, the first sector, and the sizes of one compound file. */
function cutsOf(label: string, bytes: Uint8Array): Input[] {
  const cuts = [0, 1, 7, 8, 100, 511, 512, 513, 1024, Math.floor(bytes.length / 2), bytes.length - 1].filter((at) => at < bytes.length)
  return cuts.map((at) => ({ label: `${label} cut at ${at}`, bytes: bytes.slice(0, at) }))
}

/** The records of a body stream: [tag, level, data offset, size]. */
function records(data: Buffer): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  for (let at = 0; at + 4 <= data.length;) {
    const header = data.readUInt32LE(at)
    let size = header >>> 20
    let body = at + 4
    if (size === 0xfff) { size = data.readUInt32LE(at + 4); body += 4 }
    out.push([header & 0x3ff, (header >>> 10) & 0x3ff, body, size])
    at = body + size
  }
  return out
}

const TABLE_TAG = 0x4d
const LIST_HEADER_TAG = 0x48

/**
 * The first body section of a Hangul 5 file with its tables rewritten: `change` gets the
 * TABLE record (row count at 4, column count at 6) and the cell list headers that follow it
 * (column at 8, row at 10, spans at 12 and 14).
 */
function withTables(bytes: Uint8Array, change: (table: Buffer, cells: Buffer[]) => void): Uint8Array {
  const file = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const section = CFB.find(file, '/BodyText/Section0')!
  const data = Buffer.from(inflateRawSync(Buffer.from(section.content as Uint8Array)))
  const all = records(data)
  all.forEach(([tag, , at, size], index) => {
    if (tag !== TABLE_TAG) return
    const cells: Buffer[] = []
    for (let next = index + 1; next < all.length && all[next]![0] !== TABLE_TAG && cells.length < 64; next++) {
      const [nextTag, , nextAt, nextSize] = all[next]!
      if (nextTag === LIST_HEADER_TAG && nextSize >= 16) cells.push(data.subarray(nextAt, nextAt + nextSize))
    }
    change(data.subarray(at, at + size), cells)
  })
  section.content = deflateRawSync(data)
  return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
}

/** Rewrites of the tables of three tracked files: where a cell sits, how many rows and columns the table has. */
function tableRewrites(): Input[] {
  const inputs: Input[] = []
  const sources = ['nested-form.hwp', 'format-copy-table.hwp', 'memo.hwp'].map((name): [string, Uint8Array] => [name, read(`${FIXTURES}${name}`)])
  const rewrites: Array<[string, (table: Buffer, cells: Buffer[]) => void]> = [
    ['first cell on row 7', (_, cells) => cells[0]?.writeUInt16LE(7, 10)],
    ['first cell on column 9', (_, cells) => cells[0]?.writeUInt16LE(9, 8)],
    ['every cell at 0,0', (_, cells) => cells.forEach((cell) => { cell.writeUInt16LE(0, 8); cell.writeUInt16LE(0, 10) })],
    ['last cell past both ends', (_, cells) => { cells.at(-1)?.writeUInt16LE(500, 8); cells.at(-1)?.writeUInt16LE(500, 10) }],
    ['cells in reverse rows', (table, cells) => cells.forEach((cell, k) => cell.writeUInt16LE(Math.max(0, table.readUInt16LE(4) - 1 - k), 10))],
    ['cell spans 0', (_, cells) => cells.forEach((cell) => { cell.writeUInt16LE(0, 12); cell.writeUInt16LE(0, 14) })],
    ['cell spans 300', (_, cells) => cells.forEach((cell) => { cell.writeUInt16LE(300, 12); cell.writeUInt16LE(300, 14) })],
    ['no rows', (table) => table.writeUInt16LE(0, 4)],
    ['no columns', (table) => table.writeUInt16LE(0, 6)],
    ['one column', (table) => table.writeUInt16LE(1, 6)],
    ['three columns', (table) => table.writeUInt16LE(3, 6)],
    ['hundred rows', (table) => table.writeUInt16LE(100, 4)],
    ['thousand columns', (table) => table.writeUInt16LE(1000, 6)],
    ['65535 rows', (table) => table.writeUInt16LE(0xffff, 4)],
    ['65535 columns', (table) => { table.writeUInt16LE(1, 4); table.writeUInt16LE(0xffff, 6) }],
  ]
  for (const [name, source] of sources) {
    for (const [what, change] of rewrites) {
      try { inputs.push({ label: `${name} with ${what}`, bytes: withTables(source, change) }) } catch { /* a file with no body section to rewrite */ }
    }
  }
  return inputs
}

async function containers(): Promise<Input[]> {
  const inputs: Input[] = []
  const add = (label: string, bytes: Uint8Array) => inputs.push({ label, bytes })
  const memoHwp = read(`${FIXTURES}memo.hwp`)
  const memoHwpx = read(`${FIXTURES}memo.hwpx`)
  const blank = read('apps/hwp/src/renderer/assets/blank.hwp')

  // nothing, and what is not a Hangul file
  add('empty', new Uint8Array())
  add('one byte of a zip', Uint8Array.of(0x50))
  add('one byte of a compound file', Uint8Array.of(0xd0))
  add('PK header only', concat(Uint8Array.of(0x50, 0x4b, 3, 4), new Uint8Array(10)))
  add('PK and nothing else', Uint8Array.of(0x50, 0x4b))
  add('compound signature of four bytes', Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0))
  add('compound signature, zeros', concat(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), new Uint8Array(504)))
  add('plain text', encoder.encode('hello world'))
  add('hwp3 signature and zeros', concat(encoder.encode('HWP Document File'), new Uint8Array(100)))
  add('hwp3 signature, wrong version', concat(encoder.encode('HWP Document File V9.99'), new Uint8Array(512)))
  add('hwp3 signature cut', encoder.encode('HWP Document Fil'))
  add('png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13))
  add('a Hangul 5 file named by a zip header', concat(Uint8Array.of(0x50, 0x4b, 3, 4), memoHwp.slice(4)))
  add('a zip named by a compound header', concat(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0), memoHwpx.slice(4)))

  // a zip that is not an HWPX
  const plainZip = new JSZip()
  plainZip.file('a.txt', 'not a document')
  add('zip of a text file', await fixtureBytes(plainZip))
  const emptyZip = new JSZip()
  add('zip of nothing', await fixtureBytes(emptyZip))
  const docxLike = new JSZip()
  docxLike.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  docxLike.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>')
  add('zip of a word document', await fixtureBytes(docxLike))
  const mimeOnly = new JSZip()
  mimeOnly.file('mimetype', 'application/hwp+zip', { compression: 'STORE' })
  add('zip of the mimetype only', await fixtureBytes(mimeOnly))

  // an HWPX whose zip fails the gate
  const parts = [...(await JSZip.loadAsync(memoHwpx)).filter(() => true)]
  const entries = await Promise.all(parts.filter((file) => !file.dir).map(async (file) => ({ name: file.name, data: await file.async('uint8array') })))
  add('hwpx rebuilt by the zip writer', buildZip(entries))
  add('hwpx declaring 600MB for a part', buildZip([...entries, { name: 'Contents/big.bin', data: 'x', declaredSize: 600_000_000 }]))
  add('hwpx declaring four large parts', buildZip([...entries, ...[1, 2, 3, 4].map((n) => ({ name: `Contents/part${n}.bin`, data: 'x', declaredSize: 450_000_000 }))]))
  add('hwpx inflating beyond what a part declares', buildZip([...entries, { name: 'Contents/lie.bin', data: 'x'.repeat(1536 * 1024), method: 8, declaredSize: 300 }]))
  add('hwpx with an encrypted entry', buildZip([...entries.slice(0, -1), { name: entries.at(-1)!.name, data: entries.at(-1)!.data, flags: 1 }]))
  add('hwpx with an unknown compression method', buildZip([...entries.slice(0, -1), { name: entries.at(-1)!.name, data: entries.at(-1)!.data, method: 99 }]))
  add('hwpx with more parts than the gate allows', buildZip([...entries, ...Array.from({ length: 10_001 }, (_, k) => ({ name: `pad/${k}.txt`, data: '' }))]))
  add('hwpx with a part the gate lets through and the engine cannot read', buildZip([...entries.slice(0, -1), { name: entries.at(-1)!.name, data: 'x'.repeat(40), method: 8, payload: Uint8Array.of(0xff, 0xff, 0xff, 0xff) }]))
  for (const input of hostileZipInputs()) inputs.push({ label: `hostile zip: ${input.label}`, bytes: input.bytes })

  // truncated and broken files
  inputs.push(...cutsOf('memo.hwp', memoHwp), ...cutsOf('blank.hwp', blank))
  inputs.push(...cutsOf('memo.hwpx', memoHwpx).filter((input) => input.bytes!.length > 0))
  add('memo.hwp with trailing bytes', concat(memoHwp, new Uint8Array(1024)))
  add('memo.hwpx with trailing bytes', concat(memoHwpx, encoder.encode('trailing')))
  add('memo.hwpx with a prefix', concat(encoder.encode('prefix'), memoHwpx))

  // the header of a Hangul 5 file
  const flags = [0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 64, 65, 128, 129, 256, 257, 512, 513, 1024, 1025, 2048, 0x8000_0000, 0xffff_ffff]
  for (const value of flags) add(`memo.hwp with file header flags ${value}`, withHeader(memoHwp, (header) => header.writeUInt32LE(value, 36)))
  for (const value of [0, 0x0100_0000, 0x0500_0000, 0x0501_0000, 0x0501_0600, 0x0600_0000, 0x0a00_0000, 0xffff_ffff]) {
    add(`memo.hwp with version ${value.toString(16)}`, withHeader(memoHwp, (header) => header.writeUInt32LE(value, 32)))
  }
  add('memo.hwp with a changed signature', withHeader(memoHwp, (header) => header.write('HWP Document Fail', 0, 'latin1')))
  add('memo.hwp with an empty file header', withHeader(memoHwp, (header) => header.fill(0)))
  add('memo.hwp with a short file header', (() => {
    const file = CFB.read(Buffer.from(memoHwp), { type: 'buffer' })
    CFB.find(file, '/FileHeader')!.content = Buffer.from('HWP Document File')
    return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
  })())
  add('memo.hwp without a body', (() => {
    const file = CFB.read(Buffer.from(memoHwp), { type: 'buffer' })
    CFB.utils.cfb_del(file, '/BodyText/Section0')
    return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
  })())
  add('memo.hwp without a document info stream', (() => {
    const file = CFB.read(Buffer.from(memoHwp), { type: 'buffer' })
    CFB.utils.cfb_del(file, '/DocInfo')
    return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
  })())
  add('memo.hwp with a body of zeros', (() => {
    const file = CFB.read(Buffer.from(memoHwp), { type: 'buffer' })
    const section = CFB.find(file, '/BodyText/Section0')!
    section.content = Buffer.alloc((section.content as Uint8Array).length)
    return new Uint8Array(CFB.write(file, { type: 'buffer' }) as Buffer)
  })())
  inputs.push(...tableRewrites())
  return inputs
}

async function built(): Promise<Input[]> {
  return [...(await containers()), ...(await documents())]
}

/** Every Hangul file the repository tracks, once under each name a caller might give it. */
async function checkedInputs(): Promise<Input[]> {
  const seeds = [...(await built()), ...tracked().map((path): Input => ({ label: path, bytes: read(path) }))]
  const inputs: Input[] = []
  for (const seed of seeds) {
    for (const name of ['hwp', 'hwpx']) inputs.push({ label: `${seed.label} as .${name}`, bytes: seed.bytes, args: { ext: name } })
  }
  // the names no Hangul file has
  for (const name of ['doc', '', 'HWP', 'hwpx ', 'toString', '__proto__']) {
    for (const seed of seeds.filter((_, k) => k % 9 === 0)) inputs.push({ label: `${seed.label} as .${name}`, bytes: seed.bytes, args: { ext: name } })
  }
  return inputs
}

export const SPECS: Spec[] = [
  {
    fn: 'hwpToText',
    extensions: ['hwp', 'hwpx'],
    built,
    call: (input) => hwpToText(input.bytes!),
  },
  {
    fn: 'hwpMemosOf',
    extensions: ['hwp', 'hwpx'],
    built,
    call: (input) => hwpMemosOf(input.bytes!),
  },
  {
    fn: 'checkedHwpBytes',
    extensions: [],
    built: checkedInputs,
    call: async (input) => Array.from(await checkedHwpBytes(input.bytes!, input.args!.ext as string)),
    mutation: 'none',
  },
]
