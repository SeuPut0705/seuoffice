/// CSV parsing for the import path. Values only: cells that look like plain
/// numbers become numeric, everything else stays text (leading zeros survive).
///
/// The sheets renderer imports this module (Data › From Text/CSV), so it stays
/// free of node APIs: the half that writes the xlsx archive lives in
/// csv-import-xlsx, which only the desktop path loads.

import { encodeXlsxEscapes } from './xlsx-escapes'

const DELIMITERS = [',', ';', '\t'] as const

/** Excel's sheet bounds; anything past them cannot land in a workbook anyway. */
export const MAX_CSV_ROWS = 1_048_576
export const MAX_CSV_COLS = 16_384

// Excel writes CSV in the system's legacy charset, not UTF-8 (GBK on Chinese
// Windows, Shift_JIS on Japanese), so decoding everything as UTF-8 turns every
// non-ASCII cell into replacement characters.
const LEGACY_CHARSETS = ['gb18030', 'shift_jis', 'big5', 'euc-kr', 'windows-1252'] as const

function decode(bytes: Uint8Array, charset: string, fatal = false): string | null {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

// The 700 most frequent Hangul syllables in general Korean prose (Korean Wikipedia
// articles); they cover over 99% of syllables in real text. GBK or Shift_JIS bytes read
// as EUC-KR also give Hangul, but mostly rare syllables outside this set.
const COMMON_HANGUL = new Set(
  '이다는의에한로을하가서기은대지고사어으국를인도시년과적수자정구제있부리학교전나일주되해스장역경라었화들원아중만공상계와며성관문동등여그보개선' +
    '유식용세비영민위조명회했게터산분치연소면방반거통된울미발음생업재행법월단진육체간드러운우포피종요것였양르할차무당강모신데실작커후오마심프현료' +
    '물내트따병표설특남외초야점같른력각타축건권함본또술형출안천립많때준려두류별더래바예록카급입호평금매태근능임크향불추최레목환결약파독루및군노까' +
    '합말북속않광배석론열격니직히처았언품판컴퓨달험증키받악활령규곳철디련접질편알존람높메족든확집청복습량늘없감변헌승저졌필던율총토난새항채택럽져' +
    '골쓰버팀름측순페코란쟁네박송림탄올날범번린칙참션볼베줄퍼브온창책투견백맞뒤균쳐황패글겨절색쪽농랑담티플효누억객칭넘픽왔득너뜻워께징률왕써갈찰' +
    '얻협밀낮탐츠획례앙암벌돌탈테랜념램충큰났검논망혁취응착친밖삼층융잡될완곡궁즈김락갖휘폐킥극널걸넓컵애살럼블침클못맥훈탕꾸케머앞움길찾먹링센떤' +
    '므막롯텔잔맹빈잠폭닌런털엔혼봉빌옮손슬잘찬허륙팅몇숙압킨템좌뿐염좋떻풍즉렸빠겼핵촉갔놓느잉웨넷끝희켰덕첫틴볶익윤욱켜먼녹턴잇춘씨팔째퇴긴흐둘' +
    '낸홍힘괄둔흔흥몰맛풋휴척릴맡톤렵슈헤렇괴섭쇄혹씩끼콩뉴캐넣섰릉웃뀌렌븐쳤몽밍벨즘벽떨엄섬냉콘돈옥액읍혈떠묘옛헐눈텍숫덜킹렀붙략귀뉘쿠겪촌녀쓴' +
    '읽푸틀밝앗랐웠싸값롭뉜갑왜졸랫콜셈킬잎혀룬혜곤슷텐욕랍컨릭큼홈칼얼듬헬셀끌엑님델폴놀십몸칠짓짧춰셔빛좁촬낱삶땅붕맺엇힌빼낙됨썼멘궐죄핑즐돕핸' +
    '윈뢰짐룹멸탁겸답뤄싱봄켓굴춤롤곽죽흑쇼냈닥낳핀혔섞샤멀꽃흡듣쉬폰뜨쿨굽뛰옐곧맨됐벗돼빚섯늦컬꼽풀칸밤꺼멈팬앤즌튜낼짜깔렬낀눌깊뚜싼찍빨젠뽑톨',
)

/**
 * Whether decoded text is clearly Korean: most non-ASCII characters are Hangul
 * syllables, and most of those are everyday syllables. Chinese or Japanese bytes
 * read as EUC-KR land on hanja, symbols, or rare syllables instead.
 */
export function looksKorean(text: string): boolean {
  let nonAscii = 0
  let hangul = 0
  let common = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x80) continue
    nonAscii += 1
    if (code < 0xac00 || code > 0xd7a3) continue
    hangul += 1
    if (COMMON_HANGUL.has(character)) common += 1
  }
  return hangul >= 6 && hangul / nonAscii >= 0.8 && common / hangul >= 0.75
}

/** how plausible a decoding is: CJK/ASCII good, replacement chars and control bytes bad */
function score(text: string): number {
  let value = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (character === '�') value -= 20
    else if (code < 0x20 && character !== '\n' && character !== '\r' && character !== '\t')
      value -= 10
    else if (code < 0x7f) value += 1
    // half-width katakana is the signature of double-byte text misread as
    // Shift_JIS, and near-absent from real spreadsheets — never a good sign
    else if (code >= 0xff61 && code <= 0xff9f) value -= 2
    else if (
      (code >= 0x3000 && code <= 0x9fff) || // CJK punctuation, kana, unified ideographs
      (code >= 0xac00 && code <= 0xd7af) || // hangul
      (code >= 0xff00 && code <= 0xffef) // full-width forms
    )
      value += 2
  }
  return value
}

/**
 * Decodes CSV bytes: BOM, then strict UTF-8, then the legacy charsets Excel
 * writes. `preferred` (from the UI language) breaks the ties those charsets
 * produce — GBK and Shift_JIS both decode the same bytes to plausible-looking
 * but different CJK.
 */
/**
 * UTF-16 without a BOM (Excel writes it; editors strip it): NUL bytes then
 * interleave the text, which strict UTF-8 accepts — so this must run before
 * the UTF-8 attempt or the NULs survive as garbage. NUL bytes never occur in
 * UTF-8/legacy CSV text (GBK/Shift_JIS trail bytes exclude 0x00), so any
 * meaningful NUL presence means UTF-16, with the NUL-heavy side picking the
 * byte order (ties go LE, Excel's order).
 */
function sniffUtf16WithoutBom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024))
  let pairs = 0
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i + 1 < sample.length; i += 2) {
    pairs += 1
    if (sample[i] === 0) evenNul += 1
    if (sample[i + 1] === 0) oddNul += 1
  }
  if (pairs < 2) return null
  if ((evenNul + oddNul) / (pairs * 2) < 0.05) return null
  return oddNul >= evenNul ? 'utf-16le' : 'utf-16be'
}

export function decodeCsvBuffer(bytes: Uint8Array, preferred?: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decode(bytes.subarray(3), 'utf-8') ?? ''
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode(bytes.subarray(2), 'utf-16le') ?? ''
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode(bytes.subarray(2), 'utf-16be') ?? ''
  const bomless = sniffUtf16WithoutBom(bytes)
  if (bomless) return decode(bytes, bomless) ?? ''

  const utf8 = decode(bytes, 'utf-8', true)
  if (utf8 !== null) return utf8

  // Korean Excel CSVs (code page 949) decode as plausible GBK too, so without a
  // Korean locale they came out as Chinese. Pick Korean from the bytes alone, but
  // only when the machine's language does not already claim another charset that
  // reads the bytes cleanly, and the text is overwhelmingly Hangul.
  if (!preferred || preferred === 'euc-kr' || decode(bytes, preferred, true) === null) {
    const korean = decode(bytes, 'euc-kr', true)
    if (korean !== null && looksKorean(korean)) return korean
  }

  let best = decode(bytes, 'utf-8') ?? ''
  let bestScore = score(best)
  const utf16 = ['utf-16le', 'utf-16be'] as const
  const candidates = preferred ? [preferred, ...LEGACY_CHARSETS] : LEGACY_CHARSETS
  // CJK-only UTF-16 carries too few NUL bytes for the sniffer above; let the scorer pick.
  for (const charset of [...utf16, ...candidates]) {
    const candidate = decode(bytes, charset)
    if (candidate === null) continue
    const candidateScore = score(candidate)
    if (candidateScore > bestScore) {
      best = candidate
      bestScore = candidateScore
    }
  }
  return best
}

/// Excel's own hint line: a first line of exactly `sep=<char>` names the
/// delimiter and is not data. Excel writes it for CSV exports in locales
/// that use ";" and honours it on open.
const SEP_DECLARATION = /^\uFEFF?sep=(.)\r?\n/i

export function splitSepDeclaration(text: string): { text: string; delimiter?: string } {
  const match = SEP_DECLARATION.exec(text)
  if (!match) return { text }
  return { text: text.slice(match[0].length), delimiter: match[1]! }
}

/// Counts delimiter occurrences outside quotes over the first lines and
/// picks the most frequent one; ties favor the comma. A `sep=` line wins.
export function sniffDelimiter(input: string): string {
  const { text, delimiter } = splitSepDeclaration(input)
  if (delimiter !== undefined) return delimiter
  const sample = text
    .slice(0, 64 * 1024)
    .split(/\r?\n/)
    .slice(0, 20)
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]))
  // Quote state carries across lines: a quoted field may span line breaks,
  // and delimiters inside it must never be counted.
  let quoted = false
  for (const line of sample) {
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      if (character === undefined) continue
      if (character === '"') {
        // An escaped quote ("") stays inside the quoted field; only a lone
        // quote toggles quoting, mirroring parseCsv below.
        if (quoted && line[index + 1] === '"') {
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (!quoted && counts.has(character)) {
        counts.set(character, (counts.get(character) ?? 0) + 1)
      }
    }
  }
  let best: string = DELIMITERS[0]
  let bestCount = -1
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/**
 * The grid's rows, one at a time.
 *
 * The import never holds the whole grid: a 40 MB CSV is millions of cells, and
 * a `string[][]` of them costs more than the file itself — the worksheet XML
 * they become costs several times more again. Callers that only need the
 * extent count the rows and drop them; the conversion streams them.
 */
export function* csvRows(input: string, delimiter: string): Generator<string[]> {
  const stripped = splitSepDeclaration(input).text
  const text = stripped.startsWith('﻿') ? stripped.slice(1) : stripped
  const fail = (msg: string): never => {
    throw new Error(`CSV import rejected: ${msg}`)
  }
  let row: string[] = []
  let field = ''
  // A trailing newline produces one empty row — drop it. Empty rows are held
  // back until a row with content proves they were trailing.
  let held: string[][] = []
  let rows = 0
  const pushField = (): void => {
    row.push(field)
    if (row.length > MAX_CSV_COLS) fail(`too many columns (cap ${MAX_CSV_COLS})`)
    field = ''
  }
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else if (character === '\r') {
        if (text[index + 1] === '\n') index += 1
        field += '\n'
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field === '') {
      quoted = true
    } else if (character === delimiter) {
      pushField()
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      pushField()
      rows += 1
      if (rows > MAX_CSV_ROWS) fail(`too many rows (cap ${MAX_CSV_ROWS})`)
      const finished = row
      row = []
      if (finished.every((cell) => cell === '')) {
        held.push(finished)
        continue
      }
      for (const pending of held) yield pending
      held = []
      yield finished
    } else {
      field += character
    }
  }
  if (field !== '' || row.length > 0) {
    pushField()
    rows += 1
    if (rows > MAX_CSV_ROWS) fail(`too many rows (cap ${MAX_CSV_ROWS})`)
    const finished = row
    // trailing empty rows are dropped: the held ones and this one
    if (!finished.every((cell) => cell === '')) {
      for (const pending of held) yield pending
      yield finished
    }
  }
}

export function parseCsv(input: string, delimiter = sniffDelimiter(input)): string[][] {
  return [...csvRows(input, delimiter)]
}

/// Plain decimal numbers only (".5", "1." and "-.5" count, as in Excel); leading
/// zeros ("007") and a "+" sign ("+86") stay text so codes and phone numbers
/// survive the import. Integers past Excel's 15-digit precision stay text too,
/// so long IDs are not corrupted on open.
export function isNumericCell(value: string): boolean {
  if (!/^-?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value))
    return false
  if (!/[.eE]/.test(value) && value.replace(/^-/, '').length > 15) return false
  return Number.isFinite(Number(value))
}

/// The text of a `="..."` cell, the way systems export codes and numbers to
/// CSV or HTML so Excel keeps them as written ("0123" with its zero, a long
/// ID without rounding). Excel evaluates that one formula on open and shows
/// the quoted text, as text; nothing else that looks like a formula is
/// evaluated here. Null when the value is anything else.
export function quotedTextFormula(value: string): string | null {
  const match = /^="((?:[^"]|"")*)"$/.exec(value)
  return match ? match[1]!.replace(/""/g, '"') : null
}

/** the XML escapes a cell text needs; shared with the archive writer */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function columnLabel(column: number): string {
  let label = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26)
  }
  return label
}

/** How far the grid reaches: how many rows, and how many columns carry a value. */
export interface CsvGridShape {
  readonly rows: number
  readonly columns: number
}

/** The widest column that holds a value, counted like the worksheet's
 *  dimension: an empty trailing cell does not make the sheet wider. */
function noteColumn(columns: number, row: readonly string[]): number {
  for (let index = row.length - 1; index >= 0; index -= 1) {
    if (row[index] !== '') return Math.max(columns, index + 1)
  }
  return columns
}

/** The shape of a grid that is already in memory. */
function shapeOfRows(rows: readonly (readonly string[])[]): CsvGridShape {
  let columns = 1
  for (const row of rows) columns = noteColumn(columns, row)
  return { rows: rows.length, columns }
}

/**
 * The grid's extent, read from the text in one pass: the rows are counted and
 * dropped. The worksheet's dimension has to name the extent before the first
 * row is written, so the conversion reads the shape first and streams the rows
 * after it.
 */
export function csvGridShape(input: string, delimiter: string): CsvGridShape {
  let rows = 0
  let columns = 1
  for (const row of csvRows(input, delimiter)) {
    rows += 1
    columns = noteColumn(columns, row)
  }
  return { rows, columns }
}

/**
 * The worksheet XML, chunk by chunk. A 40 MB CSV becomes a worksheet several
 * times its size, and building that as one string is what made the import
 * need a gigabyte of memory; the chunks go into the archive as they come.
 * `merges` (A1 ranges, from the HTML table import) close the sheet.
 */
export function* worksheetXmlChunks(
  rows: Iterable<readonly string[]>,
  shape: CsvGridShape,
  merges: readonly string[] = [],
): Generator<string> {
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  let columns = Math.max(shape.columns, 1)
  let lastRow = Math.max(shape.rows, 1)
  // A merge can cover empty cells past the last value, and Excel expects the
  // sheet dimension to reach its far corner.
  for (const merge of merges) {
    const end = merge.slice(merge.lastIndexOf(':') + 1)
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(end)
    if (!match) continue
    columns = Math.max(columns, columnIndexFromLabel(match[1]!) + 1)
    lastRow = Math.max(lastRow, Number(match[2]))
  }
  yield `<dimension ref="A1:${columnLabel(columns - 1)}${lastRow}"/>`
  yield '<sheetData>'
  let rowIndex = 0
  for (const row of rows) {
    const cells: string[] = []
    row.forEach((value, columnIndex) => {
      if (value === '') return
      const reference = `${columnLabel(columnIndex)}${rowIndex + 1}`
      const quoted = quotedTextFormula(value)
      cells.push(
        quoted === null && isNumericCell(value)
          ? `<c r="${reference}"><v>${Number(value)}</v></c>`
          : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(encodeXlsxEscapes(quoted ?? value))}</t></is></c>`,
      )
    })
    if (cells.length > 0) yield `<row r="${rowIndex + 1}">${cells.join('')}</row>`
    rowIndex += 1
  }
  yield '</sheetData>'
  if (merges.length > 0) {
    yield `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
  }
  yield '</worksheet>'
}

export function buildWorksheetXml(
  rows: readonly (readonly string[])[],
  merges: readonly string[] = [],
): string {
  return [...worksheetXmlChunks(rows, shapeOfRows(rows), merges)].join('')
}

function columnIndexFromLabel(label: string): number {
  let index = 0
  for (const character of label) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

/**
 * Delimiter for the open-file path. The sniffer counts raw occurrences, so a
 * single-column prose file whose notes hold more semicolons/tabs than commas
 * ("hello; world") mis-sniffs and shatters into phantom columns — the same
 * trap sheetCsvToXlsxBuffer avoids by pinning comma for the AI grid path.
 * Guard: when the sniffed delimiter opens a single-field header row, the
 * body rows do not agree on a field count, and a comma parse stays
 * single-column throughout, the file is prose, not delimited data — keep it
 * one column. A genuine table keeps its delimiter: multi-field header, or a
 * title row over body rows that mostly share the same width (a comma-free
 * `;`/tab table must not collapse just because its first line is a title).
 * A `sep=` line is Excel's own declaration and skips the guard.
 */
export function resolveImportDelimiter(csvText: string): string {
  const declared = splitSepDeclaration(csvText).delimiter
  if (declared !== undefined) return declared
  const sniffed = sniffDelimiter(csvText)
  if (sniffed === ',') return sniffed
  const sniffedRows = parseCsv(csvText, sniffed)
  if (sniffedRows.length === 0 || sniffedRows[0]!.length !== 1) return sniffed
  if (bodyRowsAgreeOnWidth(sniffedRows.slice(1))) return sniffed
  if (parseCsv(csvText, ',').every((row) => row.length === 1)) return ','
  return sniffed
}

const TABLE_WIDTH_AGREEMENT = 0.6

function bodyRowsAgreeOnWidth(rows: readonly (readonly string[])[]): boolean {
  const widths = new Map<number, number>()
  for (const row of rows)
    if (row.length > 1) widths.set(row.length, (widths.get(row.length) ?? 0) + 1)
  const dominant = Math.max(0, ...widths.values())
  return dominant >= 2 && dominant >= rows.length * TABLE_WIDTH_AGREEMENT
}
