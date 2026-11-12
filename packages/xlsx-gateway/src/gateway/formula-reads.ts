/// Which cells a formula reads, and which formula cells therefore show a value
/// derived from a cell withheld from a model.
///
/// A privacy mark (`xlsx-redaction`) withholds a cell's own value. A formula
/// that reads the cell computes from it: `=B2` IS the value, `=SUM(B:B)` gives
/// it away by subtraction, and `=A1` where A1 is `=B2` does so one step
/// removed. Every reader that hands cells to a model has to withhold those
/// too, and the two that exist (the sheet editor's index and `file-parse`'s
/// `xlsxToText`) have to agree on which, so the rule lives here once.
///
/// ## The rule
///
/// A formula cell is withheld when any cell it reads, directly or through
/// other formulas, is withheld; and when the cells it reads cannot be listed.
/// "Cannot be listed" is decided here and nowhere else:
///
/// | In the formula                                   | What happens            |
/// | ------------------------------------------------ | ----------------------- |
/// | `A1`, `A1:B9`, `Sheet!A1`, `'My sheet'!A1:B9`    | read as written         |
/// | `A:C`, `3:7` (whole columns, whole rows)         | read as written         |
/// | a defined name                                   | its body is read too    |
/// | a name no definition is known for                | withheld                |
/// | a name whose body has an unqualified reference   | withheld                |
/// | `INDIRECT`, `OFFSET`, `GETPIVOTDATA`, `CELL`     | withheld                |
/// | a range built by `:` from anything but two cells | withheld                |
/// | `A1#`, `ANCHORARRAY` (a spill range)             | withheld                |
/// | `Table1[Column]`, `[@Column]` (structured)       | withheld                |
/// | `[1]Sheet!A1`, `'[Book.xlsx]Sheet'!A1` (external)| withheld                |
/// | `Sheet1:Sheet3!A1` (3-D)                         | withheld                |
/// | a sheet the workbook does not have               | withheld                |
/// | a function this file does not list               | withheld                |
/// | `LET`, `LAMBDA` and their helpers                | withheld (local names)  |
/// | anything the scanner does not recognise          | withheld                |
///
/// `INDEX`, `CHOOSE`, `IF`, `XLOOKUP` and the like return a reference, but only
/// one found inside their own arguments, which are listed; they turn
/// undeterminable only when `:` joins their result to something else, which
/// the `:` row covers. A function not in the list below may be a macro or an
/// add-in function reading any cell, so it is withheld rather than trusted.
///
/// Nothing is withheld in a workbook without marks, whatever its formulas say.

import type { RangeBounds } from '../domain/cell-address'
import { XLFN_FUNCTIONS, XLWS_FUNCTIONS } from './future-functions'

/** Excel's grid limits: a whole-column or whole-row reference runs to them. */
const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383

/** One rectangle a formula reads; `sheet` is the qualifier as written, absent for the formula's own sheet. */
export interface FormulaRead extends RangeBounds {
  readonly sheet?: string | undefined
}

export interface FormulaReads {
  readonly reads: readonly FormulaRead[]
  /** identifiers that are neither functions nor references: defined names, lowercased */
  readonly names: readonly string[]
  /** why the cells read cannot be listed; null when all of the formula was understood */
  readonly unknown: string | null
}

/// Excel 2007's own functions and the compatibility ones it kept. Later
/// functions come from `future-functions`, which the save path already keeps
/// current. The four that return a reference outside their arguments, and
/// `CELL` (which reads the last changed cell when given no reference), are
/// left out on purpose.
const CLASSIC_FUNCTIONS =
  'ABS ACOS ACOSH ASIN ASINH ATAN ATAN2 ATANH CEILING COMBIN COS COSH DEGREES EVEN EXP FACT ' +
  'FACTDOUBLE FLOOR GCD INT ISO.CEILING LCM LN LOG LOG10 MDETERM MINVERSE MMULT MOD MROUND ' +
  'MULTINOMIAL ODD PI POWER PRODUCT QUOTIENT RADIANS RAND RANDBETWEEN ROMAN ROUND ROUNDDOWN ' +
  'ROUNDUP SERIESSUM SIGN SIN SINH SQRT SQRTPI SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ ' +
  'SUMX2MY2 SUMX2PY2 SUMXMY2 TAN TANH TRUNC ' +
  'AVEDEV AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS BETADIST BETAINV BINOMDIST CHIDIST CHIINV ' +
  'CHITEST CONFIDENCE CORREL COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS COVAR CRITBINOM DEVSQ ' +
  'EXPONDIST FDIST FINV FISHER FISHERINV FORECAST FREQUENCY FTEST GAMMADIST GAMMAINV GAMMALN ' +
  'GEOMEAN GROWTH HARMEAN HYPGEOMDIST INTERCEPT KURT LARGE LINEST LOGEST LOGINV LOGNORMDIST ' +
  'MAX MAXA MEDIAN MIN MINA MODE NEGBINOMDIST NORMDIST NORMINV NORMSDIST NORMSINV PEARSON ' +
  'PERCENTILE PERCENTRANK PERMUT POISSON PROB QUARTILE RANK RSQ SKEW SLOPE SMALL STANDARDIZE ' +
  'STDEV STDEVA STDEVP STDEVPA STEYX TDIST TINV TREND TRIMMEAN TTEST VAR VARA VARP VARPA ' +
  'WEIBULL ZTEST ' +
  'ASC BAHTTEXT CHAR CLEAN CODE CONCATENATE DBCS DOLLAR EXACT FIND FINDB FIXED JIS LEFT LEFTB ' +
  'LEN LENB LOWER MID MIDB PHONETIC PROPER REPLACE REPLACEB REPT RIGHT RIGHTB SEARCH SEARCHB ' +
  'SUBSTITUTE T TEXT TRIM UPPER USDOLLAR VALUE ' +
  'DATE DATEDIF DATEVALUE DAY DAYS360 EDATE EOMONTH HOUR MINUTE MONTH NETWORKDAYS NOW SECOND ' +
  'TIME TIMEVALUE TODAY WEEKDAY WEEKNUM WORKDAY YEAR YEARFRAC ' +
  'AND FALSE IF IFERROR NOT OR TRUE ' +
  'ADDRESS AREAS CHOOSE COLUMN COLUMNS HLOOKUP HYPERLINK INDEX LOOKUP MATCH ROW ROWS RTD ' +
  'TRANSPOSE VLOOKUP ' +
  'ERROR.TYPE INFO ISBLANK ISERR ISERROR ISEVEN ISLOGICAL ISNA ISNONTEXT ISNUMBER ISODD ISREF ' +
  'ISTEXT N NA TYPE ' +
  'DAVERAGE DCOUNT DCOUNTA DGET DMAX DMIN DPRODUCT DSTDEV DSTDEVP DSUM DVAR DVARP ' +
  'ACCRINT ACCRINTM AMORDEGRC AMORLINC COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD ' +
  'CUMIPMT CUMPRINC DB DDB DISC DOLLARDE DOLLARFR DURATION EFFECT FV FVSCHEDULE INTRATE IPMT ' +
  'IRR ISPMT MDURATION MIRR NOMINAL NPER NPV ODDFPRICE ODDFYIELD ODDLPRICE ODDLYIELD PMT PPMT ' +
  'PRICE PRICEDISC PRICEMAT PV RATE RECEIVED SLN SYD TBILLEQ TBILLPRICE TBILLYIELD VDB XIRR ' +
  'XNPV YIELD YIELDDISC YIELDMAT ' +
  'BESSELI BESSELJ BESSELK BESSELY BIN2DEC BIN2HEX BIN2OCT COMPLEX CONVERT DEC2BIN DEC2HEX ' +
  'DEC2OCT DELTA ERF ERFC GESTEP HEX2BIN HEX2DEC HEX2OCT IMABS IMAGINARY IMARGUMENT ' +
  'IMCONJUGATE IMCOS IMDIV IMEXP IMLN IMLOG10 IMLOG2 IMPOWER IMPRODUCT IMREAL IMSIN IMSQRT ' +
  'IMSUB IMSUM OCT2BIN OCT2DEC OCT2HEX ' +
  'CUBEKPIMEMBER CUBEMEMBER CUBEMEMBERPROPERTY CUBERANKEDMEMBER CUBESET CUBESETCOUNT CUBEVALUE ' +
  // Microsoft 365 functions the save path has no storage marker for.
  'ARRAYTOTEXT VALUETOTEXT FIELDVALUE GROUPBY PIVOTBY PERCENTOF TRIMRANGE REGEXTEST ' +
  'REGEXEXTRACT REGEXREPLACE TRANSLATE DETECTLANGUAGE'

/// Functions whose result is a reference (or a value) taken from outside their
/// arguments. `ANCHORARRAY` is the stored form of the `#` spill operator.
const OPAQUE_FUNCTIONS = new Set(['INDIRECT', 'OFFSET', 'GETPIVOTDATA', 'CELL', 'ANCHORARRAY'])

const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(
  [...CLASSIC_FUNCTIONS.split(' '), ...XLFN_FUNCTIONS, ...XLWS_FUNCTIONS].filter(
    (name) => !OPAQUE_FUNCTIONS.has(name),
  ),
)

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?[0-9]{1,7}`
const WHITESPACE = /\s+/y
const STRING_LITERAL = /"(?:[^"]|"")*"/y
const QUOTED_QUALIFIER = /'((?:[^']|'')*)'!/y
const ERROR_LITERAL =
  /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!|PYTHON!|EXTERNAL!)/y
/// `Sheet!` (optional), then a cell, a cell range, whole columns or whole rows.
/// The lookahead keeps a longer word (`LOG10(`, `A1B`, `Rate2024.q`) or a spill
/// `#` from being cut into a reference.
const REFERENCE = new RegExp(
  String.raw`(?:([\p{L}_][\p{L}\p{N}_.]*)!)?` +
    String.raw`(${CELL}(?::${CELL})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[0-9]{1,7}:\$?[0-9]{1,7})` +
    String.raw`(?![\p{L}\p{N}_.(\\?!$#])`,
  'uy',
)
const NUMBER = /(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y
const IDENTIFIER = /[\p{L}_\\][\p{L}\p{N}_.\\?]*/uy
const CALL_OPEN = /\s*\(/y
const PLAIN_OPERATORS = new Set('+-*/^&=<>%,;(){}@')
/// Storage markers Excel puts before later functions (`_xlfn.`, `_xlfn._xlws.`)
/// and before a LAMBDA parameter (`_xlpm.`).
const STORAGE_MARKER = /^(?:_xlfn\.|_xlws\.)+/i

function columnOf(letters: string): number {
  let column = 0
  for (const letter of letters.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64)
  return column - 1
}

/** The rectangle of a reference token (`$B$2`, `A1:C9`, `A:C`, `3:7`); null when it is off the grid. */
function boundsOf(token: string): RangeBounds | null {
  const [first = '', second = first] = token.replaceAll('$', '').split(':')
  const columns = /^[A-Za-z]+$/
  const rows = /^[0-9]+$/
  let bounds: RangeBounds
  if (columns.test(first) && columns.test(second)) {
    bounds = {
      startRow: 0,
      endRow: MAX_ROW,
      startColumn: Math.min(columnOf(first), columnOf(second)),
      endColumn: Math.max(columnOf(first), columnOf(second)),
    }
  } else if (rows.test(first) && rows.test(second)) {
    bounds = {
      startRow: Math.min(Number(first), Number(second)) - 1,
      endRow: Math.max(Number(first), Number(second)) - 1,
      startColumn: 0,
      endColumn: MAX_COLUMN,
    }
  } else {
    const cells = [first, second].map((cell) => /^([A-Za-z]+)([0-9]+)$/.exec(cell))
    const [a, b] = cells
    if (!a || !b) return null
    bounds = {
      startRow: Math.min(Number(a[2]), Number(b[2])) - 1,
      endRow: Math.max(Number(a[2]), Number(b[2])) - 1,
      startColumn: Math.min(columnOf(a[1]!), columnOf(b[1]!)),
      endColumn: Math.max(columnOf(a[1]!), columnOf(b[1]!)),
    }
  }
  if (bounds.startRow < 0 || bounds.endRow > MAX_ROW || bounds.endColumn > MAX_COLUMN) return null
  return bounds
}

/**
 * List what a formula reads. `formula` is the text with or without its
 * leading `=`, as a file or the grid holds it (A1 notation, `,` separators).
 *
 * The scan is total: every character belongs to a token it recognises, or the
 * result says `unknown`. It never guesses at a part it skipped.
 */
export function formulaReads(formula: string): FormulaReads {
  const text = formula.startsWith('=') ? formula.slice(1) : formula
  const reads: FormulaRead[] = []
  const names: string[] = []
  const unknown = (why: string): FormulaReads => ({ reads, names, unknown: why })
  const at = (pattern: RegExp, index: number): RegExpExecArray | null => {
    pattern.lastIndex = index
    return pattern.exec(text)
  }
  if (text.trim() === '') return unknown('no formula text')

  let index = 0
  /** a quoted `'Sheet name'!` waiting for the reference it qualifies */
  let qualifier: string | undefined
  while (index < text.length) {
    const space = at(WHITESPACE, index)
    if (space && qualifier === undefined) {
      index += space[0].length
      continue
    }
    if (qualifier === undefined) {
      const literal = at(STRING_LITERAL, index) ?? at(ERROR_LITERAL, index)
      if (literal) {
        index += literal[0].length
        continue
      }
      const quoted = at(QUOTED_QUALIFIER, index)
      if (quoted) {
        const sheet = quoted[1]!.replaceAll("''", "'")
        if (sheet.includes('[')) return unknown('a reference into another workbook')
        if (sheet.includes(':')) return unknown('a reference across several sheets')
        qualifier = sheet
        index += quoted[0].length
        continue
      }
    }
    const reference = at(REFERENCE, index)
    if (reference && !(qualifier !== undefined && reference[1] !== undefined)) {
      const bounds = boundsOf(reference[2]!)
      // A token off the grid (`ZZZ1`) is a name to Excel, and one nobody defined here.
      if (!bounds) return unknown('a reference outside the grid')
      reads.push({ ...bounds, sheet: qualifier ?? reference[1] })
      qualifier = undefined
      index += reference[0].length
      continue
    }
    if (qualifier !== undefined) {
      // `'Sheet'!#REF!` reads nothing; `'Sheet'!Name` is a sheet-scoped name.
      const broken = at(ERROR_LITERAL, index)
      if (broken) {
        qualifier = undefined
        index += broken[0].length
        continue
      }
      const scoped = at(IDENTIFIER, index)
      if (!scoped) return unknown('a sheet name with no reference after it')
      names.push(scoped[0].toLowerCase())
      qualifier = undefined
      index += scoped[0].length
      continue
    }
    const number = at(NUMBER, index)
    if (number) {
      index += number[0].length
      continue
    }
    const word = at(IDENTIFIER, index)
    if (word) {
      index += word[0].length
      if (text[index] === '!') {
        // `Sheet!Name`, or `Sheet!#REF!`: the reference form was tried above.
        const broken = at(ERROR_LITERAL, index + 1)
        const scoped = broken ? null : at(IDENTIFIER, index + 1)
        if (broken) index += 1 + broken[0].length
        else if (scoped) {
          names.push(scoped[0].toLowerCase())
          index += 1 + scoped[0].length
        } else return unknown('a sheet name with no reference after it')
        continue
      }
      const call = at(CALL_OPEN, index)
      const name = word[0].replace(STORAGE_MARKER, '').toUpperCase()
      if (call) {
        if (!KNOWN_FUNCTIONS.has(name)) return unknown(`the function ${name}`)
        continue
      }
      if (name !== 'TRUE' && name !== 'FALSE') names.push(word[0].toLowerCase())
      continue
    }
    const character = text[index]!
    if (PLAIN_OPERATORS.has(character)) {
      index += 1
      continue
    }
    if (character === ':') return unknown('a range built from computed ends')
    if (character === '[') return unknown('a table or another workbook')
    if (character === '#') return unknown('a spill range')
    return unknown(`the character ${character}`)
  }
  if (qualifier !== undefined) return unknown('a sheet name with no reference after it')
  return { reads, names, unknown: null }
}

/** A defined name and the formula it stands for (its `refers to`, with or without `=`). */
export interface NameDefinition {
  readonly name: string
  readonly formula: string
}

/** One sheet as a reader knows it, in the coordinates the reader asks about cells in. */
export interface ReadsSheet {
  /** the name formulas qualify references with; compared without case, as Excel does */
  readonly name: string
  /** the rectangles a mark withholds */
  readonly marks: readonly RangeBounds[]
  /**
   * Cells whose formulas this reader could not list (a formula the session
   * only holds a cached value of, a sheet too large to scan). They are
   * withheld, and so is everything that reads them.
   */
  readonly unknown: readonly RangeBounds[]
  /** every formula; `area` is its cell, or the whole range an array formula fills */
  readonly formulas: readonly { readonly area: RangeBounds; readonly formula: string }[]
}

export interface DerivedCells {
  /** per sheet, in the order given: the cells to withhold beyond the marks */
  readonly bySheet: readonly (readonly RangeBounds[])[]
  /** the workbook was too entangled to trace within the budget: every formula is withheld */
  readonly overBudget: boolean
}

/**
 * How many "does this reference cover that cell" checks one trace may make.
 * Past it every formula of the workbook is withheld: the trace only runs out
 * when most formulas are already known to depend on a withheld cell (it costs
 * dependent cells × the references that span many rows).
 */
export const DERIVED_CHECK_BUDGET = 20_000_000

const BUCKET_ROWS = 256
/// A reference spanning more buckets than this is kept in one list per sheet
/// and compared against every traced cell (`A:A`, a running total's range).
const MAX_BUCKETS_PER_READ = 16

function intersects(a: RangeBounds, b: RangeBounds): boolean {
  return (
    a.startRow <= b.endRow &&
    a.endRow >= b.startRow &&
    a.startColumn <= b.endColumn &&
    a.endColumn >= b.startColumn
  )
}

interface PlacedRead extends RangeBounds {
  readonly owner: number
}

/**
 * The cells to withhold because of what their formula reads.
 *
 * Traced forwards from the withheld cells, not backwards from every formula:
 * a workbook where one hidden cell feeds three totals costs three steps
 * however many formulas it has.
 */
export function cellsDerivedFromWithheld(
  sheets: readonly ReadsSheet[],
  names: readonly NameDefinition[] = [],
  budget = DERIVED_CHECK_BUDGET,
): DerivedCells {
  const none: DerivedCells = { bySheet: sheets.map(() => []), overBudget: false }
  if (sheets.every((sheet) => sheet.marks.length === 0)) return none

  const sheetIndex = new Map(sheets.map((sheet, index) => [sheet.name.toLowerCase(), index]))
  const definitions = new Map<string, string[]>()
  for (const { name, formula } of names) {
    const key = name.toLowerCase()
    definitions.set(key, [...(definitions.get(key) ?? []), formula])
  }

  const parsed = new Map<string, FormulaReads>()
  const readsOf = (formula: string): FormulaReads => {
    let reads = parsed.get(formula)
    if (!reads) {
      reads = formulaReads(formula)
      parsed.set(formula, reads)
    }
    return reads
  }

  /** what a name reads, every definition of it at any scope together; null when it cannot be listed */
  const nameReads = new Map<string, readonly FormulaRead[] | null>()
  const readsOfName = (name: string, open: ReadonlySet<string>): readonly FormulaRead[] | null => {
    const known = nameReads.get(name)
    if (known !== undefined) return known
    const bodies = definitions.get(name)
    // undefined here, or a name defined through itself
    if (!bodies || open.has(name)) return null
    const inside = new Set(open).add(name)
    const all: FormulaRead[] = []
    let listed = true
    for (const body of bodies) {
      const reads = readsOf(body)
      // A name is used from any sheet, so a reference without one has no fixed place.
      if (reads.unknown !== null || reads.reads.some((read) => read.sheet === undefined)) {
        listed = false
        break
      }
      all.push(...reads.reads)
      for (const inner of reads.names) {
        const more = readsOfName(inner, inside)
        if (more === null) listed = false
        else all.push(...more)
      }
      if (!listed) break
    }
    const result = listed ? all : null
    nameReads.set(name, result)
    return result
  }

  /** a place a value comes from: a withheld area, or a formula cell found to depend on one */
  interface Source {
    readonly sheet: number
    readonly area: RangeBounds
  }
  const nodes: Source[] = []
  const tainted: boolean[] = []
  const pending: Source[] = []
  const taint = (node: number): void => {
    if (tainted[node]) return
    tainted[node] = true
    pending.push(nodes[node]!)
  }
  /** per sheet: the references into it, by the row buckets they cover */
  const buckets = sheets.map(() => new Map<number, PlacedRead[]>())
  const tall = sheets.map((): PlacedRead[] => [])

  sheets.forEach((sheet, own) => {
    for (const { area, formula } of sheet.formulas) {
      const node = nodes.length
      nodes.push({ sheet: own, area })
      tainted.push(false)
      const reads = readsOf(formula)
      let unlisted = reads.unknown !== null
      const all: FormulaRead[] = [...reads.reads]
      for (const name of unlisted ? [] : reads.names) {
        const more = readsOfName(name, new Set())
        if (more === null) {
          unlisted = true
          break
        }
        all.push(...more)
      }
      const placed: { target: number; read: FormulaRead }[] = []
      for (const read of unlisted ? [] : all) {
        const target = read.sheet === undefined ? own : sheetIndex.get(read.sheet.toLowerCase())
        if (target === undefined) {
          unlisted = true
          break
        }
        placed.push({ target, read })
      }
      if (unlisted) {
        taint(node)
        continue
      }
      // Its reads are kept even when one already lies on a mark: the trace
      // below finds that, in one pass over the marks instead of one per read.
      for (const { target, read } of placed) {
        const entry: PlacedRead = { ...read, owner: node }
        const first = Math.floor(read.startRow / BUCKET_ROWS)
        const last = Math.floor(read.endRow / BUCKET_ROWS)
        if (last - first >= MAX_BUCKETS_PER_READ) {
          tall[target]!.push(entry)
          continue
        }
        for (let bucket = first; bucket <= last; bucket += 1) {
          const list = buckets[target]!.get(bucket)
          if (list) list.push(entry)
          else buckets[target]!.set(bucket, [entry])
        }
      }
    }
  })

  // The marks and the unlisted areas are where the trace starts.
  sheets.forEach((sheet, index) => {
    for (const area of sheet.marks) pending.push({ sheet: index, area })
    for (const area of sheet.unknown) pending.push({ sheet: index, area })
  })
  let checks = 0
  const reach = (reads: readonly PlacedRead[], area: RangeBounds): void => {
    checks += reads.length
    for (const read of reads) if (!tainted[read.owner] && intersects(read, area)) taint(read.owner)
  }
  while (pending.length > 0 && checks <= budget) {
    const { sheet, area } = pending.pop()!
    reach(tall[sheet]!, area)
    const first = Math.floor(area.startRow / BUCKET_ROWS)
    const last = Math.floor(area.endRow / BUCKET_ROWS)
    if (last - first >= MAX_BUCKETS_PER_READ) {
      for (const list of buckets[sheet]!.values()) reach(list, area)
    } else {
      for (let bucket = first; bucket <= last; bucket += 1) {
        const list = buckets[sheet]!.get(bucket)
        if (list) reach(list, area)
      }
    }
  }
  const overBudget = pending.length > 0

  const bySheet = sheets.map((sheet): RangeBounds[] => [...sheet.unknown])
  nodes.forEach((node, index) => {
    if (overBudget || tainted[index]) bySheet[node.sheet]!.push(node.area)
  })
  return { bySheet, overBudget }
}

/** `(row, column) => is it in one of these areas`, for a reader that asks cell by cell. */
export function areaLookup(
  areas: readonly RangeBounds[],
): (row: number, column: number) => boolean {
  const cells = new Set<number>()
  const ranges: RangeBounds[] = []
  for (const area of areas) {
    if (area.startRow === area.endRow && area.startColumn === area.endColumn) {
      cells.add(area.startRow * (MAX_COLUMN + 1) + area.startColumn)
    } else ranges.push(area)
  }
  return (row, column) =>
    cells.has(row * (MAX_COLUMN + 1) + column) ||
    ranges.some(
      (area) =>
        row >= area.startRow &&
        row <= area.endRow &&
        column >= area.startColumn &&
        column <= area.endColumn,
    )
}
