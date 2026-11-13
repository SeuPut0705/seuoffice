/**
 * What the MCP bridge's commands do to the open workbook (see mcp-bridge.ts for
 * the transport). Kept out of App.tsx so the answers an external agent gets can
 * be exercised without mounting the app; App supplies the live refs.
 */
import type { WorkbookOperation } from '@seuoffice/xlsx-gateway/domain/workbook-dsl'
import type {
  ApplyOutcome,
  CellScalar,
  CellState,
  ChangePlan,
} from '@seuoffice/xlsx-gateway/domain/workbook.types'
import { redactionIndexOf, type RedactionLoad } from './ai/redact-load'
import { redactGuardForOps, type GuardTable } from './ai/redact-guard'
import type { SheetRef } from './mcp-sheet-refs'
import { awaitFormulaValues, formulaTargetsFromOps, rememberFormulaValue } from './formula-values'
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

/** The live workbook services the MCP apply command needs. */
export interface McpApplyContext {
  readonly redactionLoad: () => RedactionLoad
  readonly sheets: () => readonly SheetRef[]
  /** the tables of a sheet, for the write guard */
  readonly tablesOf?: (sheetId: string) => readonly GuardTable[]
  readonly plan: (ops: readonly WorkbookOperation[]) => ChangePlan
  readonly apply: (ops: readonly WorkbookOperation[]) => Promise<ApplyOutcome>
  readonly readCells: (addresses: readonly string[], sheetId: string) => Record<string, CellState>
}

/** Plan or apply one external agent batch, including computed formula readback. */
export async function applyOpsForMcp(
  ctx: McpApplyContext,
  ops: readonly WorkbookOperation[],
  dryRun: boolean,
): Promise<unknown> {
  // Check before planning too: a dry-run preview can contain values read from
  // the grid, and formula readback can publish a withheld source in its target.
  const load = ctx.redactionLoad()
  if (load.status === 'not-loaded') {
    return { ok: false, reason: 'The workbook privacy marks are still loading; retry the batch.' }
  }
  const sheets = ctx.sheets()
  const refusal = redactGuardForOps(
    ops,
    redactionIndexOf(load),
    (id) => sheets.find((sheet) => sheet.id === id)?.name,
    (name) =>
      sheets.find((sheet) => sheet.name === name)?.id ??
      sheets.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase())?.id,
    ctx.tablesOf,
  )
  if (refusal) {
    return {
      ok: false,
      reason:
        `Rejected — none of the ${ops.length} operation(s) were applied ` +
        `(a batch is all-or-nothing): ${refusal.reason}`,
    }
  }
  if (dryRun) {
    try {
      const plan = ctx.plan(ops)
      return {
        ok: true,
        dryRun: true,
        structuralChanges: plan.structuralChanges.map((change) => change.label),
        formatChanges: plan.formatChanges.map((change) => change.label),
        cellChanges: plan.cellChanges
          .slice(0, 100)
          .map((change) => ({ address: change.address, after: change.after.value })),
        cellChangeCount: plan.cellChanges.length,
        sheetRenames: plan.sheetRenames.map((rename) => `${rename.before} -> ${rename.after}`),
      }
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const outcome = await ctx.apply(ops)
  if (!outcome.ok) return outcome
  // Formula text lands synchronously; its computed value arrives asynchronously.
  const targets = formulaTargetsFromOps(ops)
  if (targets.length === 0) return outcome
  const values = await awaitFormulaValues(targets, ctx.readCells)
  for (const cell of values) {
    rememberFormulaValue(cell.sheetId, cell.address, { formula: cell.formula ?? '' })
  }
  return { ...outcome, formulaValues: values }
}
