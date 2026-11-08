/**
 * Reading the published list of locked cells from a bridge map, for the
 * editor and the command line (no conversion context needed).
 */
import type { BridgeMap } from '../core/convert'
import type { NestedStep, ProtectedCellRef, TableExt } from './model'

/** Every cell Hancom locked, as published by the table layer (empty when none). */
export function protectedCellsOf(map: Pick<BridgeMap, 'ext'>): ProtectedCellRef[] {
  const ext = map.ext.table as unknown as TableExt | undefined
  return ext?.protectedCells ?? []
}

const samePath = (a: readonly NestedStep[], b: readonly NestedStep[]) =>
  a.length === b.length &&
  a.every((s, i) => s.row === b[i].row && s.col === b[i].col && s.index === b[i].index)

/**
 * Whether a cell is locked. Address it by grid position (`col`) or by its
 * `w:tc` index in the row (`tc`), in the top-level table whose `w:tbl` is
 * bridge element `table`, through `path` for nested tables.
 */
export function isProtectedCell(
  map: Pick<BridgeMap, 'ext'>,
  cell: { table: number; path?: readonly NestedStep[]; row: number } & (
    { col: number } | { tc: number }
  ),
): boolean {
  const path = cell.path ?? []
  return protectedCellsOf(map).some(
    (p) =>
      p.table === cell.table &&
      p.row === cell.row &&
      samePath(p.path, path) &&
      ('col' in cell ? p.col === cell.col : p.tc === cell.tc),
  )
}
