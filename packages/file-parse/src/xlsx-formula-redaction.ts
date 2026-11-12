import type { RangeBounds } from '@seuoffice/xlsx-gateway/domain/cell-address'
import { offsetFormulaRefs } from '@seuoffice/xlsx-gateway/domain/formula-shift'
import {
  areaLookup,
  cellsDerivedFromWithheld,
  type NameDefinition,
  type ReadsSheet,
} from '@seuoffice/xlsx-gateway/gateway/formula-reads'
import { relationshipIdOf } from '@seuoffice/xlsx-gateway/gateway/xlsx-namespace'

/**
 * The formula cells of a workbook whose value comes from a withheld cell.
 *
 * A mark withholds the cell it covers. A formula that reads that cell holds a
 * value computed from it, in the file as the cached result of the last
 * calculation: `=B2` is the value, `=SUM(B:B)` gives it away. The sheet editor
 * withholds such cells from its own model, so this reader does too, by the
 * same rule (`formula-reads` in the workbook gateway, which also says what is
 * withheld because it cannot be traced).
 *
 * This reader has no formula engine, only the text of each `<f>`. The formulas
 * of EVERY sheet have to be known before the first cell is handed over, also
 * of sheets the character budget never reaches, because a chain may pass
 * through them. So the sheets are scanned here for their `<f>` elements
 * without building their DOM (which costs about 1 GB for 100,000 rows), and
 * only in a workbook that has marks: one without marks is read as before.
 *
 * Where the scan cannot answer, it withholds:
 *
 * - a sheet whose XML is larger than the scan limit is withheld whole;
 * - so is a sheet with a formula cell that has no readable address, or an
 *   array formula without its range;
 * - a follower of a shared formula whose master is missing, a formula with no
 *   text, and every cell of a what-if data table are withheld;
 * - a formula cell the worksheet parser sees and this scan did not is withheld
 *   (`knownFormula`), so the two can never disagree in the open direction.
 *
 * The output of a PivotTable is traced the same way (`pivotOutputOf`): its
 * cells are constants, but they are the labels and totals of its source.
 */

/** Sheet XML above this size is not scanned; the sheet is withheld whole instead. */
export const FORMULA_SCAN_MAX_BYTES = 64 * 1024 * 1024

const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383
const WHOLE_SHEET: RangeBounds = {
  startRow: 0,
  endRow: MAX_ROW,
  startColumn: 0,
  endColumn: MAX_COLUMN,
}

/** an opening `<c …>`, or an `<f …>` with its body, each with any namespace prefix */
const CELL_OR_FORMULA =
  /<(?:[\w.-]+:)?c(?=[\s/>])([^>]*)>|<(?:[\w.-]+:)?f(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?f>)/g
const SHEET_DATA_OPEN = /<(?:[\w.-]+:)?sheetData(?=[\s>])/
const SHEET_DATA_CLOSE = /<\/(?:[\w.-]+:)?sheetData>/
const CELL_REF = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)
  return match ? (match[1] ?? match[2]) : undefined
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)))
    return NAMED_ENTITIES[body] ?? whole
  })
}

function cellAt(ref: string | undefined): { row: number; column: number } | null {
  const at = ref === undefined ? null : CELL_REF.exec(ref.trim())
  if (!at) return null
  let column = 0
  for (const letter of at[1]!.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64)
  return { row: Number(at[2]) - 1, column: column - 1 }
}

function rangeAt(ref: string | undefined): RangeBounds | null {
  const [first, second = first] = (ref ?? '').replaceAll('$', '').split(':')
  const from = cellAt(first)
  const to = cellAt(second)
  if (!from || !to) return null
  return {
    startRow: Math.min(from.row, to.row),
    endRow: Math.max(from.row, to.row),
    startColumn: Math.min(from.column, to.column),
    endColumn: Math.max(from.column, to.column),
  }
}

const cellArea = (at: { row: number; column: number }): RangeBounds => ({
  startRow: at.row,
  endRow: at.row,
  startColumn: at.column,
  endColumn: at.column,
})

const cellKey = (row: number, column: number): number => row * (MAX_COLUMN + 1) + column

interface SheetFormulas {
  readonly formulas: { area: RangeBounds; formula: string }[]
  readonly unknown: RangeBounds[]
  /** every cell that carries an `<f>`, so the worksheet parser can be checked against the scan */
  readonly formulaCells: Set<number>
}

const UNSCANNED: SheetFormulas = { formulas: [], unknown: [WHOLE_SHEET], formulaCells: new Set() }

/** The formulas of one worksheet part, from its raw XML. */
export function scanSheetFormulas(xml: string): SheetFormulas {
  const open = SHEET_DATA_OPEN.exec(xml)
  if (!open) return { formulas: [], unknown: [], formulaCells: new Set() }
  const close = SHEET_DATA_CLOSE.exec(xml)
  const data = xml.slice(open.index, close ? close.index : xml.length)

  const result: SheetFormulas = { formulas: [], unknown: [], formulaCells: new Set() }
  const masters = new Map<string, { formula: string; row: number; column: number }>()
  const followers: { si: string; row: number; column: number }[] = []
  /** the address of the cell being read; null between cells and for one that has none */
  let current: { row: number; column: number } | null | undefined
  CELL_OR_FORMULA.lastIndex = 0
  for (let match = CELL_OR_FORMULA.exec(data); match; match = CELL_OR_FORMULA.exec(data)) {
    if (match[1] !== undefined) {
      // a self-closed cell holds no formula
      current = match[1].endsWith('/') ? undefined : cellAt(attribute(match[1], 'r'))
      continue
    }
    // An `<f>` outside a cell, or in a cell that cannot be placed: nothing on
    // this sheet can be said to be free of it.
    if (!current) return UNSCANNED
    const at = current
    result.formulaCells.add(cellKey(at.row, at.column))
    const attributes = match[2] ?? ''
    const kind = attribute(attributes, 't')
    const text = decodeEntities(match[3] ?? '').trim()
    if (kind === 'dataTable') {
      const table = rangeAt(attribute(attributes, 'ref'))
      if (!table) return UNSCANNED
      result.unknown.push(table)
      continue
    }
    if (kind === 'shared') {
      const si = attribute(attributes, 'si')
      if (si === undefined) result.unknown.push(cellArea(at))
      else if (text === '') followers.push({ si, ...at })
      else {
        masters.set(si, { formula: text, ...at })
        result.formulas.push({ area: cellArea(at), formula: text })
      }
      continue
    }
    if (text === '') {
      result.unknown.push(cellArea(at))
      continue
    }
    if (kind === 'array') {
      const filled = rangeAt(attribute(attributes, 'ref'))
      if (!filled) return UNSCANNED
      result.formulas.push({ area: filled, formula: text })
      continue
    }
    result.formulas.push({ area: cellArea(at), formula: text })
  }
  for (const follower of followers) {
    const master = masters.get(follower.si)
    if (!master) {
      result.unknown.push(cellArea(follower))
      continue
    }
    result.formulas.push({
      area: cellArea(follower),
      formula: offsetFormulaRefs(
        master.formula,
        follower.row - master.row,
        follower.column - master.column,
      ),
    })
  }
  return result
}

/** What the cell loop asks about one sheet. */
export interface DerivedSheet {
  /** the sheet has at least one such cell */
  readonly any: boolean
  /** the cell shows a value derived from a withheld cell, or one that cannot be traced */
  readonly withheld: (row: number, column: number) => boolean
  /** the scan saw the formula of this cell */
  readonly knownFormula: (row: number, column: number) => boolean
}

/**
 * The cells one PivotTable fills on a sheet. They are plain cells holding the
 * labels and totals of the pivot's source, so they are traced like a formula
 * that reads the source; `formula` is null when the source cannot be told, and
 * the cells are then withheld untraced.
 */
export interface PivotOutput {
  readonly area: RangeBounds
  readonly formula: string | null
}

const element = (name: string): RegExp => new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])([^>]*)>`)
const LOCATION = element('location')
const CACHE_SOURCE = element('cacheSource')
const WORKSHEET_SOURCE = element('worksheetSource')
const PAGE_FIELD = /<(?:[\w.-]+:)?pageField(?=[\s/>])/g

/**
 * Where a pivot's output is and what it was computed from, read off its
 * `pivotTableDefinition` part (`truncated` when the part was larger than what
 * was read) and off the start of its cache definition. Either is undefined
 * when that part is missing.
 *
 * The source is followed when it is a range of a sheet of this workbook, or a
 * name (a defined name is resolved by the trace; a table name is not one, and
 * is withheld there). Anything else cannot be told: another workbook
 * (`r:id`), a connection, consolidated ranges, a cache that is not there or
 * does not open with its source. A pivot that does not say where its output
 * is withholds its whole sheet.
 */
export function pivotOutputOf(
  pivot: { readonly text: string; readonly truncated: boolean } | undefined,
  cacheXml: string | undefined,
): PivotOutput {
  const pivotXml = pivot?.text ?? ''
  const location = LOCATION.exec(pivotXml)?.[1]
  const output = rangeAt(location === undefined ? undefined : attribute(location, 'ref'))
  if (location === undefined || output === null) return { area: WHOLE_SHEET, formula: null }
  const upToOutputEnd = { ...output, startRow: 0, startColumn: 0, endColumn: WHOLE_SHEET.endColumn }
  // The filters are listed after the fields and their items, megabytes into a
  // large pivot. In a part that was not read to its end they may be in the
  // rest, so their number is not known, and neither is whether the layout
  // holds them all.
  if (pivot?.truncated === true) {
    return { area: upToOutputEnd, formula: pivotSourceFormula(cacheXml) }
  }
  // Report filters sit above the output: per row of them a label and the chosen item for
  // each filter, a blank column between two filters, then a blank row. The location says
  // how many rows and how many side by side. Nothing declared and no filters: there are
  // none. A layout that is not two counts, or does not hold every filter, leaves their
  // extent unknown, and it is not guessed: every row from the top of the sheet down to the
  // end of the output is the pivot's, in every column.
  const filters = pivotXml.match(PAGE_FIELD)?.length ?? 0
  const count = (name: string): number => {
    const value = Number(attribute(location, name) ?? '')
    return Number.isInteger(value) && value > 0 ? value : 0
  }
  const pageRows = count('rowPageCount')
  const pageColumns = count('colPageCount')
  const area: RangeBounds =
    filters === 0 && pageRows === 0 && pageColumns === 0
      ? output
      : pageRows === 0 || pageColumns === 0 || pageRows * pageColumns < filters
        ? upToOutputEnd
        : {
            ...output,
            startRow: Math.max(0, output.startRow - pageRows - 1),
            endColumn: Math.min(
              WHOLE_SHEET.endColumn,
              Math.max(output.endColumn, output.startColumn + pageColumns * 3 - 2),
            ),
          }
  return { area, formula: pivotSourceFormula(cacheXml) }
}

function pivotSourceFormula(cacheXml: string | undefined): string | null {
  const cacheSource = CACHE_SOURCE.exec(cacheXml ?? '')?.[1]
  const sourceElement = WORKSHEET_SOURCE.exec(cacheXml ?? '')
  const source = sourceElement?.[1]
  if (cacheSource === undefined || sourceElement === null || source === undefined) return null
  if (attribute(cacheSource, 'type') !== 'worksheet') return null
  // A relationship on the source: the range is in another workbook. Told the
  // way the workbook gateway tells it for the editor, so the two agree.
  const before = (cacheXml ?? '').slice(0, sourceElement.index)
  if (relationshipIdOf(sourceElement[0], before) !== undefined) return null
  const ref = attribute(source, 'ref')
  const sheet = attribute(source, 'sheet')
  const name = attribute(source, 'name')
  if (ref !== undefined && sheet !== undefined) {
    if (rangeAt(ref) === null) return null
    return `='${decodeEntities(sheet).replaceAll("'", "''")}'!${ref.replaceAll('$', '')}`
  }
  if (ref === undefined && sheet === undefined && name !== undefined) {
    return `=${decodeEntities(name)}`
  }
  return null
}

export interface DerivedInput {
  readonly name: string
  /** the sheet's XML up to the scan limit, or undefined when the part is missing */
  readonly xml: (() => Promise<{ text: string; truncated: boolean } | undefined>) | undefined
  readonly marks: readonly RangeBounds[]
  /** the PivotTables that put their output on this sheet */
  readonly pivots?: (() => Promise<readonly PivotOutput[]>) | undefined
}

/**
 * Scan every sheet and trace the marks through the formulas. Returns one entry
 * per sheet, in the order given. Call it only for a workbook that has marks.
 */
export async function readDerivedCells(
  sheets: readonly DerivedInput[],
  names: readonly NameDefinition[],
): Promise<DerivedSheet[]> {
  const scanned: SheetFormulas[] = []
  for (const sheet of sheets) {
    const raw = await sheet.xml?.()
    const found =
      raw === undefined
        ? { formulas: [], unknown: [], formulaCells: new Set<number>() }
        : raw.truncated
          ? UNSCANNED
          : scanSheetFormulas(raw.text)
    const pivots = (await sheet.pivots?.()) ?? []
    scanned.push(
      pivots.length === 0
        ? found
        : {
            formulaCells: found.formulaCells,
            unknown: [
              ...found.unknown,
              ...pivots.flatMap((pivot) => (pivot.formula === null ? [pivot.area] : [])),
            ],
            formulas: [
              ...found.formulas,
              ...pivots.flatMap((pivot) =>
                pivot.formula === null ? [] : [{ area: pivot.area, formula: pivot.formula }],
              ),
            ],
          },
    )
  }
  const traced = cellsDerivedFromWithheld(
    sheets.map((sheet, index): ReadsSheet => ({
      name: sheet.name,
      marks: sheet.marks,
      unknown: scanned[index]!.unknown,
      formulas: scanned[index]!.formulas,
    })),
    names,
  )
  return scanned.map((sheet, index) => {
    const areas = traced.bySheet[index]!
    return {
      any: areas.length > 0,
      withheld: areaLookup(areas),
      knownFormula: (row, column) => sheet.formulaCells.has(cellKey(row, column)),
    }
  })
}
