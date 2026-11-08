import type { Editor } from '@tiptap/core'
import {
  docxToOdt,
  isOdtOpenError,
  isProtectedCell,
  odtToDocx,
  parseKeepName,
  protectedCellsOf,
  saveOdt,
  type BridgeMap,
  type ConversionReport,
  type ObjectsExt,
  type ReportFeature,
} from '@genoffice/odt-engine'
import type { CommandContext } from '../registry'
import { CliError, EXIT } from '../result'

/**
 * A received OpenDocument text file is edited through the bridge docx the
 * Word editor opens (`odtToDocx`) and written back into the original package
 * with narrow patches (`saveOdt`): untouched parts keep their bytes. What the
 * ODT editor keeps off is refused here as `unsupported`, and edits that would
 * touch a cell the author locked or resize a locked object stand-in as
 * `op_rejected`, the same answers a person gets in the app.
 */

/** What an opened ODT needs to be saved back as itself. */
export interface OdtOrigin {
  originalOdt: Uint8Array
  bridge: BridgeMap
  report: ConversionReport
}

/** OdtOpenError → the CLI's error envelope; anything else is left to the caller. */
export function odtOpenFailure(err: unknown): CliError | null {
  if (!isOdtOpenError(err)) return null
  switch (err.code) {
    case 'encrypted':
      return new CliError(EXIT.file, 'the ODT document is password-protected', undefined, {
        reason: 'unsupported',
        suggestion:
          'remove the password in the program that set it (save a copy without a password), then retry with that copy',
      })
    case 'not-odt-text':
      return new CliError(EXIT.file, err.message, undefined, {
        reason: 'unsupported',
        suggestion: 'pass an OpenDocument text document (.odt)',
      })
    case 'zip-rejected':
      return new CliError(EXIT.file, err.message, undefined, { reason: 'resource_limit' })
    default:
      return new CliError(EXIT.conversion, `the ODT document could not be read: ${err.message}`)
  }
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw odtOpenFailure(err) ?? err
  }
}

/** A received ODT → the bridge docx plus what saving it back needs. */
export async function openOdtBytes(
  bytes: Uint8Array,
): Promise<{ docxBytes: Uint8Array; origin: OdtOrigin }> {
  const r = await mapped(() => odtToDocx(bytes))
  return {
    docxBytes: r.docxBytes,
    origin: { originalOdt: bytes, bridge: r.bridge, report: r.report },
  }
}

/** The edited bridge docx written back into the received ODT (original bytes when nothing changed). */
export function saveOdtBytes(origin: OdtOrigin, editedDocx: Uint8Array): Promise<Uint8Array> {
  return mapped(() =>
    saveOdt({ originalOdt: origin.originalOdt, bridge: origin.bridge, editedDocx }),
  )
}

/** A whole docx → a new ODT. */
export function docxBytesToOdt(
  docx: Uint8Array,
): Promise<{ odtBytes: Uint8Array; report: ConversionReport }> {
  return docxToOdt(docx)
}

// ---- conversion report → warnings ----

const FEATURE_LABEL: Record<ReportFeature, string> = {
  toc: 'table(s) of contents',
  chart: 'chart(s)',
  equation: 'equation(s)',
  shape: 'shape(s)',
  textbox: 'text box(es)',
  columns: 'multi-column section(s)',
  citation: 'citation field(s)',
  cross_reference: 'caption or cross-reference field(s)',
  page_color: 'page colour',
  mirror_margins: 'mirror margins',
  theme: 'document theme',
  comment: 'comment(s)',
  revision: 'tracked change(s)',
  ink: 'ink drawing(s)',
  watermark: 'watermark(s)',
  password: 'password',
  protection: 'protection setting(s)',
  form_field: 'form field(s)',
  object: 'embedded object(s)',
}

/**
 * One warning per report item (`odt_converted` / `odt_dropped`) through the
 * command's warning channel; the same facts go into `detail.odt_report`.
 */
export function reportOdtConversion(
  report: ConversionReport,
  target: string,
  ctx: Pick<CommandContext, 'warn'>,
): ConversionReport {
  for (const item of report) {
    const what = `${item.count} ${FEATURE_LABEL[item.feature] ?? item.feature}`
    ctx.warn(
      item.kind === 'converted'
        ? {
            code: 'odt_converted',
            message: `${what} (${item.feature}) changed form in the .${target} file`,
          }
        : {
            code: 'odt_dropped',
            message: `${what} (${item.feature}) could not be kept in the .${target} file`,
          },
    )
  }
  return report.map(({ kind, feature, count }) => ({ kind, feature, count }))
}

// ---- ops the ODT editor keeps off ----

/**
 * Ops of the features an ODT document keeps off (spec: comments, tracked
 * changes, tables of contents, equations, charts, shapes, text boxes,
 * columns, watermarks, page colour, protection / password, captions and
 * cross-references, citations). Shapes, page colour and protection have no
 * op in the catalog, so nothing reaches them.
 */
const ODT_DISABLED_OPS: Record<string, string> = {
  add_comment: 'comments',
  reply_comment: 'comments',
  resolve_comment: 'comments',
  delete_comment: 'comments',
  accept_changes: 'tracked changes',
  reject_changes: 'tracked changes',
  insertToc: 'tables of contents',
  insert_chart: 'charts',
  edit_chart: 'charts',
  insert_text_box: 'text boxes',
  set_watermark: 'watermarks',
  wrap_content_control: 'content controls',
  unwrap_content_control: 'content controls',
}

/** insertField types that make captions, cross-references, citations or tables of contents. */
const ODT_DISABLED_FIELDS = new Set([
  'SEQ',
  'REF',
  'PAGEREF',
  'NOTEREF',
  'STYLEREF',
  'CITATION',
  'BIBLIOGRAPHY',
  'TOC',
  'TOA',
  'TA',
  'TC',
  'INDEX',
  'XE',
])

/** Why an op cannot run on an ODT document, or null when it can. */
export function odtDisabledFeature(op: Record<string, unknown>): string | null {
  const name = typeof op.op === 'string' ? op.op : ''
  const fixed = ODT_DISABLED_OPS[name]
  if (fixed) return fixed
  if (name === 'set_page_setup' && op.columns !== undefined && op.columns !== null) {
    return 'text columns'
  }
  if ((name === 'insert_content' || name === 'replace_blocks') && typeof op.html === 'string') {
    if (/<formula\b/i.test(op.html)) return 'equations'
  }
  if (name === 'insertField' && typeof op.type === 'string') {
    if (ODT_DISABLED_FIELDS.has(op.type.trim().toUpperCase()))
      return 'captions, cross-references and citations'
  }
  return null
}

export function odtDisabledMessage(feature: string): string {
  return `${feature} are not available in an ODT document`
}

// ---- protected cells and locked object stand-ins ----

type PmNode = Editor['state']['doc']

/** Cell attributes that are part of what a person sees; widths and computed borders follow the table. */
const CELL_LOOK = [
  'colspan',
  'rowspan',
  'fill',
  'color',
  'bold',
  'align',
  'vAlign',
  'borders',
  'textDirection',
  'noWrap',
  'cellMar',
] as const

function cellPrint(cell: PmNode): string {
  const look: Record<string, unknown> = {}
  for (const key of CELL_LOOK) look[key] = cell.attrs[key] ?? null
  return JSON.stringify([look, cell.content.toJSON()])
}

interface GridCell {
  row: number
  col: number
  node: PmNode
}

/** Grid position of every cell (prosemirror-tables' TableMap rule: a cell takes the first free column). */
function tableGrid(table: PmNode): GridCell[] {
  const taken: boolean[][] = []
  const cells: GridCell[] = []
  table.forEach((row, _offset, r) => {
    let c = 0
    row.forEach((cell) => {
      while (taken[r]?.[c]) c++
      const rs = Math.max(1, Number(cell.attrs.rowspan) || 1)
      const cs = Math.max(1, Number(cell.attrs.colspan) || 1)
      for (let dr = 0; dr < rs; dr++) {
        const line = (taken[r + dr] ??= [])
        for (let dc = 0; dc < cs; dc++) line[c + dc] = true
      }
      cells.push({ row: r, col: c, node: cell })
      c += cs
    })
  })
  return cells
}

function shapeOf(cells: GridCell[]): string {
  return cells
    .map((c) => `${c.row}:${c.col}:${c.node.attrs.rowspan ?? 1}:${c.node.attrs.colspan ?? 1}`)
    .join(',')
}

interface PrintedCell {
  row: number
  col: number
  print: string
}

interface TableSnapshot {
  index: number
  shape: string
  locked: PrintedCell[]
  counts: Map<string, number>
  /** every cell of the grid with its print, and the grid's size */
  cells: PrintedCell[]
  size: GridSize
}

interface GridSize {
  rows: number
  cols: number
}

function gridSize(grid: readonly GridCell[]): GridSize {
  let rows = 0
  let cols = 0
  for (const g of grid) {
    rows = Math.max(rows, g.row + Math.max(1, Number(g.node.attrs.rowspan) || 1))
    cols = Math.max(cols, g.col + Math.max(1, Number(g.node.attrs.colspan) || 1))
  }
  return { rows, cols }
}

const printed = (grid: readonly GridCell[]): PrintedCell[] =>
  grid.map((g) => ({ row: g.row, col: g.col, print: cellPrint(g.node) }))

/** One signature per grid row (`by: 'row'`) or column: the prints of the cells starting there. */
function lineSignatures(cells: readonly PrintedCell[], by: 'row' | 'col'): string[] {
  const other = by === 'row' ? 'col' : 'row'
  const lines: PrintedCell[][] = []
  for (const c of cells) (lines[c[by]] ??= []).push(c)
  return Array.from(lines, (line) =>
    (line ?? [])
      .slice()
      .sort((a, b) => a[other] - b[other])
      .map((c) => `${c[other]}:${c.print}`)
      .join('|'),
  )
}

/**
 * before line index → after line index: identical lines matched in order
 * (longest common subsequence), then the lines of a gap paired in order when
 * the gap has as many lines on both sides (a line whose span changed).
 */
function alignLines(before: readonly string[], after: readonly string[]): Map<number, number> {
  const n = before.length
  const m = after.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const pairs: Array<[number, number]> = []
  for (let i = 0, j = 0; i < n && j < m;) {
    if (before[i] === after[j]) pairs.push([i++, j++])
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++
    else j++
  }
  const out = new Map<number, number>(pairs)
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [n, m]]
  for (let k = 1; k < anchors.length; k++) {
    const [i0, j0] = anchors[k - 1]!
    const [i1, j1] = anchors[k]!
    if (i1 - i0 === j1 - j0) for (let d = 1; i0 + d < i1; d++) out.set(i0 + d, j0 + d)
  }
  return out
}

/**
 * A locked cell the op moved or removed, following it through inserted or
 * deleted rows (or columns) by lining the grids up; null when every locked
 * cell is still there, unchanged. Undefined when neither the rows nor the
 * columns of the two grids line up (the caller falls back to counting).
 */
function movedLockedCell(
  snap: TableSnapshot,
  now: PrintedCell[],
  size: GridSize,
): PrintedCell | null | undefined {
  const at = (cells: PrintedCell[], row: number, col: number) =>
    cells.find((c) => c.row === row && c.col === col)
  const sameRows = snap.size.rows === size.rows
  const sameCols = snap.size.cols === size.cols
  if (sameRows && sameCols) {
    // spans changed in place (merge, split): locked cells stay where they were
    return snap.locked.find((c) => at(now, c.row, c.col)?.print !== c.print) ?? null
  }
  if (!sameRows && !sameCols) return undefined
  const by = sameCols ? 'row' : 'col'
  const map = alignLines(lineSignatures(snap.cells, by), lineSignatures(now, by))
  return (
    snap.locked.find((c) => {
      const line = map.get(c[by])
      if (line === undefined) return true
      const moved = by === 'row' ? at(now, line, c.col) : at(now, c.row, line)
      return moved?.print !== c.print
    }) ?? null
  )
}

interface Snapshot {
  tables: Map<number, TableSnapshot>
  /** placeholder name → node print; block placeholders keyed `block:<docxIndex>` */
  objects: Map<string, string>
}

/** `wp:docPr` names of locked object stand-ins inside a node's raw drawing XML */
const KEEP_NAMES = /\bname="(odt-keep:[^"]+)"/g

function topTables(doc: PmNode): Map<number, { node: PmNode; index: number }> {
  const out = new Map<number, { node: PmNode; index: number }>()
  doc.forEach((child, _offset, index) => {
    const dx = child.attrs?.docxIndex
    if (child.type.name === 'docTable' && typeof dx === 'number' && !out.has(dx)) {
      out.set(dx, { node: child, index })
    }
  })
  return out
}

/**
 * Before/after check around each op: a protected cell of a received ODT
 * (Hancom `table:protected`, cell-protect styles) must come out of the op
 * unchanged, and a locked object stand-in (`odt-keep:` picture) may be
 * deleted but not resized or replaced. The engine would silently keep the
 * original on save; refusing the op tells the caller instead.
 */
export class OdtEditGuard {
  /** top-level table (docxIndex) → grid cells to keep; null = every cell of it */
  private readonly lockedCells = new Map<number, Array<{ row: number; col: number }> | null>()
  private readonly blockObjects: number[]
  readonly active: boolean

  constructor(bridge: BridgeMap, doc: PmNode) {
    const refs = protectedCellsOf(bridge)
    const tables = topTables(doc)
    for (const table of new Set(refs.map((r) => r.table))) {
      const found = tables.get(table)
      if (!found) continue
      const grid = tableGrid(found.node)
      // a locked cell of a nested table is read-only inside its host cell: the host is kept
      const keep = grid.filter(
        (g) =>
          isProtectedCell(bridge, { table, row: g.row, col: g.col }) ||
          refs.some(
            (r) =>
              r.table === table && r.path[0] && r.path[0].row === g.row && r.path[0].col === g.col,
          ),
      )
      const placed = refs
        .filter((r) => r.table === table)
        .every((r) => {
          const at = r.path[0] ?? r
          return keep.some((k) => k.row === at.row && k.col === at.col)
        })
      // a grid this reading cannot line up with the engine's: keep the whole table
      this.lockedCells.set(table, placed ? keep.map((k) => ({ row: k.row, col: k.col })) : null)
    }
    const objects = bridge.ext.objects as unknown as ObjectsExt | undefined
    this.blockObjects = (objects?.placeholders ?? [])
      .filter((p) => p.element !== null && p.element !== undefined)
      .map((p) => p.element as number)
    this.active =
      this.lockedCells.size > 0 ||
      this.blockObjects.length > 0 ||
      (objects?.placeholders.length ?? 0) > 0
  }

  snapshot(doc: PmNode): Snapshot {
    const tables = new Map<number, TableSnapshot>()
    const top = topTables(doc)
    for (const [table, keep] of this.lockedCells) {
      const found = top.get(table)
      if (!found) continue
      const grid = tableGrid(found.node)
      const counts = new Map<string, number>()
      const prints = new Map<string, string>()
      for (const g of grid) {
        const print = cellPrint(g.node)
        prints.set(`${g.row}:${g.col}`, print)
        counts.set(print, (counts.get(print) ?? 0) + 1)
      }
      const cells = keep ?? grid.map((g) => ({ row: g.row, col: g.col }))
      tables.set(table, {
        index: found.index,
        shape: shapeOf(grid),
        locked: cells.map((c) => ({ ...c, print: prints.get(`${c.row}:${c.col}`) ?? '' })),
        counts,
        cells: printed(grid),
        size: gridSize(grid),
      })
    }
    return { tables, objects: this.objectPrints(doc) }
  }

  /** A sentence naming what the op changed that it must not, or null. */
  violation(before: Snapshot, doc: PmNode): string | null {
    const top = topTables(doc)
    for (const [table, snap] of before.tables) {
      const found = top.get(table)
      if (!found) {
        return `it removes or rebuilds the table at block ${snap.index}, which holds cells the document's author locked`
      }
      const grid = tableGrid(found.node)
      if (shapeOf(grid) === snap.shape) {
        for (const cell of snap.locked) {
          const now = grid.find((g) => g.row === cell.row && g.col === cell.col)
          if (!now || cellPrint(now.node) !== cell.print) return lockedCell(snap.index, cell)
        }
        continue
      }
      // rows or columns moved: follow every locked cell to its new place
      const moved = movedLockedCell(snap, printed(grid), gridSize(grid))
      if (moved) return lockedCell(snap.index, moved)
      if (moved === null) continue
      // neither rows nor columns line up: every locked print must still be there as often
      const counts = new Map<string, number>()
      for (const g of grid) {
        const print = cellPrint(g.node)
        counts.set(print, (counts.get(print) ?? 0) + 1)
      }
      for (const cell of snap.locked) {
        if ((counts.get(cell.print) ?? 0) < (snap.counts.get(cell.print) ?? 0)) {
          return lockedCell(snap.index, cell)
        }
      }
    }
    const after = this.objectPrints(doc)
    for (const [name, print] of before.objects) {
      const now = after.get(name)
      if (now !== undefined && now !== print) {
        const kind = name.startsWith('block:')
          ? 'locked object'
          : (parseKeepName(name)?.kind ?? 'locked object')
        return `it resizes or changes a locked ${kind} stand-in (${name}); such objects can only be deleted as a whole in an ODT document`
      }
    }
    return null
  }

  /** Follow protected cells only after an op was accepted; rejected ops keep the old coordinates. */
  accept(before: Snapshot, doc: PmNode): void {
    const top = topTables(doc)
    for (const [table, snap] of before.tables) {
      if (this.lockedCells.get(table) === null) continue
      const found = top.get(table)
      if (!found) continue
      const grid = tableGrid(found.node)
      if (shapeOf(grid) === snap.shape) continue
      const now = printed(grid)
      const size = gridSize(grid)
      const sameRows = snap.size.rows === size.rows
      const sameCols = snap.size.cols === size.cols
      if (sameRows && sameCols) continue
      if (sameRows || sameCols) {
        const by = sameCols ? 'row' : 'col'
        const map = alignLines(lineSignatures(snap.cells, by), lineSignatures(now, by))
        this.lockedCells.set(
          table,
          snap.locked.map((cell) => ({
            row: by === 'row' ? map.get(cell.row)! : cell.row,
            col: by === 'col' ? map.get(cell.col)! : cell.col,
          })),
        )
      } else {
        // A rebuild that changes both axes was checked by print counts. Keep every
        // matching position protected rather than guessing between identical cells.
        const keep = new Set(snap.locked.map((cell) => cell.print))
        this.lockedCells.set(
          table,
          now.filter((cell) => keep.has(cell.print)).map(({ row, col }) => ({ row, col })),
        )
      }
    }
  }

  private objectPrints(doc: PmNode): Map<string, string> {
    const out = new Map<string, string>()
    if (this.blockObjects.length) {
      doc.forEach((child) => {
        const dx = child.attrs?.docxIndex
        if (typeof dx === 'number' && this.blockObjects.includes(dx)) {
          out.set(`block:${dx}`, JSON.stringify(child.toJSON()))
        }
      })
    }
    doc.descendants((node) => {
      const xml = node.attrs?.xml
      if (typeof xml !== 'string') return true
      const print = JSON.stringify(node.attrs)
      for (const m of xml.matchAll(KEEP_NAMES)) if (!out.has(m[1]!)) out.set(m[1]!, print)
      return false
    })
    return out
  }
}

function lockedCell(blockIndex: number, cell: { row: number; col: number }): string {
  return `it changes a protected cell (table at block ${blockIndex}, row ${cell.row}, column ${cell.col}) that the document's author locked`
}
