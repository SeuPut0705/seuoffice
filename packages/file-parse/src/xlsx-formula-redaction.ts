import type { RangeBounds } from '@seuoffice/xlsx-gateway/domain/cell-address'
import { callEngine } from './engine'

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

/**
 * Where a pivot's output is and what it was computed from, read off its
 * `pivotTableDefinition` part (`truncated` when the part was larger than what
 * was read) and off the start of its cache definition. Either is undefined
 * when that part is missing. A pivot that does not say where its output is
 * withholds its whole sheet.
 */
export function pivotOutputOf(
  pivot: { readonly text: string; readonly truncated: boolean } | undefined,
  cacheXml: string | undefined,
): PivotOutput {
  return callEngine<PivotOutput>('pivotOutputOf', [pivot, cacheXml])
}
