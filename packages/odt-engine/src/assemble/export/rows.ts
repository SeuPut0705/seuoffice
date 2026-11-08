/**
 * Row height floors for exported tables.
 *
 * Word grows a row to hold its cells: every cell paragraph takes its spacing
 * before, its lines and its spacing after. Hancom, reading an ODT, drops the
 * last paragraph's bottom spacing and the extra line spacing of the last line
 * in a cell, so a table without row heights comes out much shorter there (a
 * 12pt cell line is a 12pt row). Hancom's own ODT files state a minimum height
 * for every row; this does the same with a floor that never exceeds what Word
 * lays out: one line per paragraph at the faces' single line (the font size
 * for faces not listed) times the line spacing, cell margins, and the
 * paragraph spacing. Content taller than the floor still grows the row, in
 * every reader.
 */
import type {
  ParaFormat,
  ParsedDoc,
  Run,
  StyleDisplay,
  TableCell,
  TableModel,
  TableParagraph,
  TableStyleDisplay,
} from '@genoffice/docx-engine'
import { documentDefaults } from './styles'

type TableSpacing = NonNullable<TableStyleDisplay['paraSpacing']>

/**
 * The table with a minimum height on every row that Word would lay out taller
 * than the row's own height; exact heights stay.
 */
export function withRowFloors(model: TableModel, parsed: ParsedDoc): TableModel {
  const table = model.tblStyleId ? parsed.styles.get(model.tblStyleId)?.tableDisplay : undefined
  const heights = [...(model.rowHeightsTwips ?? [])]
  const rules = [...(model.rowHeightRules ?? [])]
  let changed = false
  model.rows.forEach((row, r) => {
    if (rules[r] === 'exact') return
    let floor = 0
    for (const cell of row) {
      // merged cells spread over rows, vertical text runs across: no floor from them
      if (cell.gridGap || cell.vMerge || cell.hMerge === 'continue') continue
      if (cell.textDirection === 'tbRl' || cell.textDirection === 'btLr') continue
      floor = Math.max(floor, cellFloor(model, cell, table, parsed))
    }
    floor = Math.floor(floor)
    if (floor <= 0 || floor <= (heights[r] ?? 0)) return
    heights[r] = floor
    rules[r] = 'atLeast'
    changed = true
  })
  if (!changed) return model
  while (heights.length < model.rows.length) heights.push(null)
  while (rules.length < model.rows.length) rules.push(null)
  return { ...model, rowHeightsTwips: heights, rowHeightRules: rules }
}

function cellFloor(
  model: TableModel,
  cell: TableCell,
  table: TableStyleDisplay | undefined,
  parsed: ParsedDoc,
): number {
  const paras: TableParagraph[] = cell.richParas ?? cell.paras.map((text) => ({ runs: [{ text }] }))
  if (!paras.length) return 0
  const margins = cell.cellMarTwips ?? model.cellMarTwips
  let height = Math.max(0, margins?.top ?? 0) + Math.max(0, margins?.bottom ?? 0)
  for (const para of paras) height += paragraphFloor(para, table, parsed)
  return height
}

/** One paragraph's least height in Word: one line and its spacing. */
function paragraphFloor(
  para: TableParagraph,
  table: TableStyleDisplay | undefined,
  parsed: ParsedDoc,
): number {
  const base = documentDefaults(parsed.docDefaults)
  const styleId = para.styleId ?? defaultParagraphStyle(parsed)
  const display: StyleDisplay = (styleId ? parsed.styles.get(styleId)?.display : undefined) ?? {}
  const spacing = table?.paraSpacing
  // a table style's paragraph spacing sits between the defaults and the
  // paragraph style; either may win, so the floor takes the smaller one
  const space = (
    direct: number | undefined,
    auto: boolean | undefined,
    style: number | undefined,
    fallback: number,
    fromTable: number | undefined,
  ) => {
    if (auto) return 0
    if (direct !== undefined) return Math.max(0, direct)
    const own = style ?? fallback
    return Math.max(0, Math.min(own, fromTable ?? own))
  }
  const contextual = para.contextualSpacing ?? display.contextualSpacing ?? false
  const before = contextual
    ? 0
    : space(
        para.spaceBefore,
        para.spaceBeforeAuto ?? display.spaceBeforeAuto,
        display.spaceBeforeTwips,
        base.para.spaceBefore ?? 0,
        spacing?.beforeTwips,
      )
  const after = contextual
    ? 0
    : space(
        para.spaceAfter,
        para.spaceAfterAuto ?? display.spaceAfterAuto,
        display.spaceAfterTwips,
        base.para.spaceAfter ?? 0,
        spacing?.afterTwips,
      )

  // a table style may set a smaller size its runs do not carry
  let styleSize = display.sizeHalfPoints ?? base.text.sizeHalfPoints ?? 20
  for (const f of [table?.wholeTable, table?.firstRow, table?.lastRow, table?.firstCol])
    if (f?.sizeHalfPoints) styleSize = Math.min(styleSize, f.sizeHalfPoints)
  const natural = naturalLine(para.runs, {
    size: styleSize,
    latin: display.fontAscii ?? display.font ?? base.text.fontAscii,
    eastAsia: display.eastAsiaFont ?? base.text.eastAsiaFont,
  })
  const own = lineFloor(lineOf(para, display, base.para), natural)
  const fromTable =
    spacing && !para.lineRule && para.lineSpacing === undefined
      ? lineFloor(tableLine(spacing), natural)
      : own
  return before + after + Math.min(own, fromTable)
}

/** The line rule a paragraph uses: its own, its style's, the defaults'. */
function lineOf(para: ParaFormat, display: StyleDisplay, base: ParaFormat): ParaFormat {
  if (para.lineRule || para.lineSpacing !== undefined) return para
  if (display.lineRule === 'exact' || display.lineRule === 'atLeast')
    return { lineRule: display.lineRule, lineRawTwips: display.lineRawTwips }
  if (display.lineSpacing) return { lineRule: 'auto', lineSpacing: display.lineSpacing }
  return base
}

function tableLine(spacing: TableSpacing): ParaFormat {
  if (spacing.lineRule === 'exact' || spacing.lineRule === 'atLeast')
    return { lineRule: spacing.lineRule, lineRawTwips: spacing.lineRawTwips }
  if (spacing.lineRawTwips) return { lineRule: 'auto', lineSpacing: spacing.lineRawTwips / 240 }
  return { lineRule: 'auto', lineSpacing: 1 }
}

/** The line a rule gives over the faces' single line. */
function lineFloor(f: ParaFormat, natural: number): number {
  if (f.lineRule === 'exact') return Math.max(0, f.lineRawTwips ?? 0)
  if (f.lineRule === 'atLeast') return Math.max(f.lineRawTwips ?? 0, natural)
  return natural * Math.max(0, f.lineSpacing ?? 1)
}

/**
 * A face's single line over its size, as Windows measures it (OS/2 winAscent +
 * winDescent; Word's line is never shorter). Faces not listed count as 1.
 */
const FACE_LINE: Record<string, number> = {
  calibri: 1.2207,
  'calibri light': 1.2207,
  cambria: 1.1724,
  arial: 1.1172,
  'times new roman': 1.1074,
  'malgun gothic': 1.3301,
  '맑은 고딕': 1.3301,
  'microsoft yahei': 1.3198,
  微软雅黑: 1.3198,
}

const faceLine = (face: string | undefined) => (face && FACE_LINE[face.toLowerCase()]) || 1

const LATIN = /[\u0021-\u007e\u00a0-\u024f]/
const EAST_ASIAN = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/**
 * The tallest single line of the paragraph's text, in twips: each run's size
 * times the line of the face its characters use. An empty paragraph has its
 * mark's size.
 */
function naturalLine(
  runs: Run[],
  style: { size: number; latin: string | undefined; eastAsia: string | undefined },
): number {
  let line = 0
  for (const run of runs) {
    if (run.image || !run.text) continue
    const size = (run.sizeHalfPoints ?? style.size) * 10
    let ratio = 1
    if (LATIN.test(run.text)) ratio = Math.max(ratio, faceLine(run.fontAscii ?? style.latin))
    if (EAST_ASIAN.test(run.text))
      ratio = Math.max(ratio, faceLine(run.eastAsiaFont ?? style.eastAsia))
    line = Math.max(line, size * ratio)
  }
  return line || style.size * 10
}

function defaultParagraphStyle(parsed: ParsedDoc): string | undefined {
  for (const s of parsed.styles.values())
    if (s.type === 'paragraph' && s.isDefault) return s.styleId
  return parsed.styles.has('Normal') ? 'Normal' : undefined
}
