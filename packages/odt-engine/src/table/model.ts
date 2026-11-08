/**
 * The table layer's slot in the bridge map: `BridgeMap.ext.table`.
 *
 * Everything here is plain JSON (it crosses IPC between open and save).
 * Offsets index the decoded content.xml string of the ORIGINAL ODT, like
 * every other offset of the bridge.
 *
 * Addressing: a top-level table is the bridge element (`BridgeMap.elements`
 * index) of its `w:tbl`; a cell is (grid row, grid column) of that table,
 * header rows included, 0-based. Tables nested in cells are reached through a
 * `path` of host cells. `protectedCells` is the published list of cells
 * Hancom locked; the editor and the CLI read it to refuse edits there.
 */
import type { JsonValue } from '../core/convert'

export const TABLE_OWNER = 'table'
export const TABLE_EXT_VERSION = 1

/** A source range in content.xml. */
export interface RangeRecord {
  start: number
  end: number
}

/** A source range with the end of the start tag and the start of the end tag. */
export interface ElementRecord extends RangeRecord {
  openEnd: number
  closeStart: number
  selfClosing: boolean
}

/** One step from a table into a table nested in one of its cells. */
export interface NestedStep {
  /** grid row of the host cell */
  row: number
  /** grid column of the host cell */
  col: number
  /** which table of the host cell (0-based, in reading order) */
  index: number
}

/**
 * A cell Hancom locked (`table:protected="true"` on the cell, a cell style
 * whose `style:cell-protect` protects it, or `table:protected="true"` on the
 * whole table). Nothing may change its content or its place in the grid.
 */
export interface ProtectedCellRef {
  /** bridge element id (`BridgeMap.elements` index) of the top-level `w:tbl` */
  table: number
  /** host cells leading into nested tables, outermost first; `[]` for the top-level table */
  path: NestedStep[]
  /** grid row in the innermost table (0-based, header rows included) */
  row: number
  /** grid column of the cell's first column (0-based) */
  col: number
  /** index of the cell's `w:tc` in its `w:tr` (`TableModel.rows[row][tc]` of the docx engine) */
  tc: number
}

/** One unit of a cell's (or the body's) content as the bridge shows it. */
export type UnitRecord =
  /** a paragraph (`text:p`/`text:h`), possibly inside a list in the cell */
  | { kind: 'p'; paragraph: number; start: number; end: number }
  /** a table placed directly in the cell */
  | { kind: 't'; table: number; start: number; end: number }
  /** a paragraph holding tables in frames (`text:p > draw:frame > draw:text-box > table:table`) */
  | {
      kind: 'f'
      start: number
      end: number
      /** the paragraph's own text as a bridge paragraph, or null when it holds nothing else */
      paragraph: number | null
      /** the paragraph's text is shown before its tables (else after them) */
      paragraphFirst: boolean
      tables: number[]
    }

/** What the bridge wrote into the cell's `w:tcPr`, in the docx engine's model shape. */
/** A real cell (`table:table-cell`); it anchors its own merge. Defaults are omitted. */
export interface AnchorCellRecord extends ElementRecord {
  kind: 'cell'
  /** index of the cell's `w:tc` in its `w:tr` */
  tc: number
  /** decoded `table:style-name` */
  style: string | null
  /** content units */
  units: UnitRecord[]
  /** merge size; omitted when 1 */
  colSpan?: number
  rowSpan?: number
  /** Hancom locked the cell; omitted when not */
  protected?: true
  /**
   * The bridge added an empty `w:p` the ODT does not have: `trailing` after a
   * last nested table (OOXML cells end with a paragraph), `empty` in a cell
   * with no paragraph at all. Omitted when none.
   */
  synthetic?: 'trailing' | 'empty'
}

/** A grid position hidden by the merge of the cell at `anchor` (`table:covered-table-cell`). */
export interface CoveredCellRecord extends RangeRecord {
  kind: 'covered'
  /** grid position of the merged cell covering this one */
  anchor: [number, number]
  /** a vertical merge continues here as its own `w:tc` (`w:vMerge`), else null */
  tc: number | null
}

/**
 * A covered cell no merge explains (`orphan`) or a position its row leaves
 * out (`filler`, no element: start = end = -1). The bridge shows an empty
 * cell; nothing typed there is written.
 */
export interface EmptyCellRecord extends RangeRecord {
  kind: 'orphan' | 'filler'
  tc: number
}

export type CellRecord = AnchorCellRecord | CoveredCellRecord | EmptyCellRecord

/** Grid position of the cell that owns position (`row`, `col`). */
export const anchorOf = (cell: CellRecord, row: number, col: number): [number, number] =>
  cell.kind === 'covered' ? cell.anchor : [row, col]

/** Merge size of a cell record (1×1 for anything but a merged real cell). */
export const spanOf = (cell: CellRecord): { colSpan: number; rowSpan: number } =>
  cell.kind === 'cell'
    ? { colSpan: cell.colSpan ?? 1, rowSpan: cell.rowSpan ?? 1 }
    : { colSpan: 1, rowSpan: 1 }

export interface RowRecord extends ElementRecord {
  /** inside `table:table-header-rows` */
  header: boolean
  /** decoded `table:style-name` */
  style: string | null
  /** row height from its style (`style:row-height`, else `style:min-row-height`) in cm, or null */
  heightCm: number | null
}

export interface ColumnRecord extends ElementRecord {
  /** decoded `table:style-name` */
  style: string | null
  /** the element carries `table:number-columns-repeated` (it stands for several grid columns) */
  repeated: boolean
  /** width written into the bridge grid (twips) */
  widthTwips: number
}

/** The frame a table sits in: `text:p > draw:frame > draw:text-box > table:table`. */
export interface FrameRecord {
  /** the paragraph holding the frame */
  paragraph: RangeRecord
  /** the `draw:frame` element */
  frame: ElementRecord
  /** decoded `draw:style-name` of the frame */
  style: string | null
  /** `text:anchor-type` of the frame */
  anchor: string | null
}

export interface TableRecord extends ElementRecord {
  /** index in `TableExt.tables` */
  id: number
  /** bridge block that converted the table (or its frame paragraph) */
  block: number
  /** bridge element id of the top-level `w:tbl`; null for nested tables */
  element: number | null
  /** for a nested table: the host cell and the table's index there */
  host: { table: number; row: number; col: number; index: number } | null
  frame: FrameRecord | null
  /** the `table:table-header-rows` element, or null */
  headerRows: ElementRecord | null
  rows: RowRecord[]
  /** one per grid column */
  columns: ColumnRecord[]
  /** `[row][col]` for every grid position */
  cells: CellRecord[][]
  /** total grid width (twips) */
  widthTwips: number
  /** why structural rewrites are refused (row groups, repeated rows/cells), or null */
  structureLocked: string | null
}

export interface TableExt {
  version: typeof TABLE_EXT_VERSION
  /** every converted table, top-level and nested, in conversion order */
  tables: TableRecord[]
  /** bridge element id (as a string key) → table id, for top-level tables */
  elements: Record<string, number>
  /** cells Hancom locked; see `ProtectedCellRef` */
  protectedCells: ProtectedCellRef[]
}

/** `BridgeBlock.data` of a block the table owner converted. */
export interface TableBlockData {
  /** a bare `table:table`, or a paragraph holding framed tables */
  kind: 'table' | 'frames'
  /** the frame paragraph's own text record (mixed paragraphs), else null */
  paragraph: number | null
  /** the paragraph's text is shown before its tables (else after them) */
  paragraphFirst: boolean
  tables: number[]
}

export function emptyTableExt(): TableExt {
  return { version: TABLE_EXT_VERSION, tables: [], elements: {}, protectedCells: [] }
}

/** Casts a record to the JSON value type of the bridge map. */
export const asJson = <T>(value: T): JsonValue => value as unknown as JsonValue
