// Table layer of the ODT bridge: body tables, Hancom's framed tables
// (`text:p > draw:frame > draw:text-box > table:table`) and nested tables,
// both directions, with cell-level write-back and Hancom's locked cells.
import type { ConversionRegistry } from '../core/convert'
import { tableBlockConverter, tableFreeWriter } from './converter'

export { tableBlockConverter, tableFreeWriter } from './converter'
export {
  type CellProps,
  borderFromOdf,
  cellBordersXml,
  cellPropsFromOdf,
  convertTable,
  type ConvertedTable,
  type TableEnv,
} from './forward'
export {
  type AnchorCellRecord,
  type CoveredCellRecord,
  type EmptyCellRecord,
  anchorOf,
  spanOf,
  type CellRecord,
  type ColumnRecord,
  type ElementRecord,
  type FrameRecord,
  type NestedStep,
  type ProtectedCellRef,
  type RangeRecord,
  type RowRecord,
  type TableBlockData,
  type TableExt,
  type TableRecord,
  type UnitRecord,
  TABLE_EXT_VERSION,
  TABLE_OWNER,
  emptyTableExt,
} from './model'
export {
  type FrameHost,
  type OdfGrid,
  type TableFrame,
  cellIsProtected,
  frameHostOf,
  readGrid,
  tableFrameOf,
} from './odf-read'
export { type OxCell, type OxTable, editedGrid, segmentTable } from './ooxml-read'
export {
  type EditedTable,
  type TableResult,
  borderToOdf,
  mapSequence,
  newTableOdf,
  writeTable,
} from './reverse'
export { protectedCellsOf, isProtectedCell } from './protected'

/**
 * Registers the table owner: body tables and framed-table paragraphs (both
 * directions) and new tables. Register after the text layer.
 */
export function registerTableConverters(registry: ConversionRegistry): ConversionRegistry {
  return registry.addBlock(tableBlockConverter).addFreeWriter(tableFreeWriter)
}
