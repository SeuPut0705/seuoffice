/**
 * What the MCP bridge's commands do to the open workbook (see mcp-bridge.ts for
 * the transport). Kept out of App.tsx so the answers an external agent gets can
 * be exercised without mounting the app; App supplies the live refs.
 */
import type { CellScalar } from '@genoffice/xlsx-gateway/domain/workbook.types'
import { readCells, type WorkbookReadContext } from './ai/workbook-readers'
import { modelCellValue } from './univer-sync'

/** One cell as `read_sheet` reports it. */
export interface McpCell {
  readonly value: CellScalar
  /** the rendered text, when it differs from the model value */
  readonly display?: CellScalar
  readonly formula?: string
}

/**
 * `read_sheet` for a list of addresses.
 *
 * The MCP read is machine-facing: `value` is the model value, not the rendered
 * text a number format or a narrow column produced. The rendered text rides
 * along as `display` when the two differ, so a caller can still see what the
 * user sees (see modelCellValue). A withheld cell arrives from the reader as
 * its placeholder and nothing else.
 */
export function readCellsForMcp(
  ctx: WorkbookReadContext,
  addresses: readonly string[],
  sheetId?: string,
): Record<string, McpCell> {
  const cells = readCells(ctx, addresses, sheetId)
  return Object.fromEntries(
    Object.entries(cells).map(([address, cell]) => {
      const value = modelCellValue(cell)
      return [
        address,
        {
          value,
          ...(cell.value !== value ? { display: cell.value } : {}),
          ...(cell.formula === undefined ? {} : { formula: cell.formula }),
        },
      ]
    }),
  )
}
