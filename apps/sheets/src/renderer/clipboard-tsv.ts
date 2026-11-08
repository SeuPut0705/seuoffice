/**
 * Clipboard plain-text interop. Univer's copy joins raw cell text with
 * tabs — booleans land as 1/0 and embedded newlines go out unquoted (as bare
 * \r), so Excel/Numbers/scripts mis-parse the paste. Wrap the clipboard
 * service's content generation and rebuild the plain slice with Excel's TSV
 * conventions: TRUE/FALSE for booleans, CSV-style quoting for fields carrying
 * tabs/newlines/quotes, newlines normalized to \n.
 */
import {
  CellModeEnum,
  CellValueType,
  IUniverInstanceService,
  extractPureTextFromCell,
  type ICellData,
} from '@univerjs/core'
import { ISheetClipboardService } from '@univerjs/preset-sheets-core'

import type { UniverRuntime } from './univer-state'

type ClipboardCell = ICellData & { displayV?: string }

/// One TSV field: booleans as TRUE/FALSE, newlines normalized to \n, and
/// CSV-style quoting when the text carries tabs/newlines/quotes.
export function clipboardField(cell: ClipboardCell | null | undefined): string {
  if (!cell) return ''
  if (
    cell.t === CellValueType.BOOLEAN &&
    (cell.v === null || cell.v === undefined || cell.v === '')
  ) {
    return ''
  }
  const text =
    cell.t === CellValueType.BOOLEAN
      ? Number(cell.v) === 0
        ? 'FALSE'
        : 'TRUE'
      : (cell.displayV ??
        // extractPureTextFromCell strips \r line breaks — keep string values
        // verbatim so embedded newlines survive to be quoted below
        (typeof cell.v === 'string' ? cell.v : extractPureTextFromCell(cell)))
  // Only normalize line endings: trailing newlines are significant cell
  // content and must survive (quoted) instead of being stripped.
  const normalized = text.replace(/\r\n|\r/g, '\n')
  return /[\t\n"]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized
}

/// The whole plain-text clipboard slice: fields per (row, column) of the
/// copied discrete range (absolute coordinates, filtered rows already gone).
export function plainTextFromCells(
  rows: readonly number[],
  columns: readonly number[],
  cellAt: (row: number, column: number) => ClipboardCell | null | undefined,
): string {
  return rows
    .map((row) => columns.map((column) => clipboardField(cellAt(row, column))).join('\t'))
    .join('\n')
}

interface CopyContent {
  plain: string
  discreteRange: { rows: number[]; cols: number[] }
}

interface CellBounds {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

interface CellMatrixLike {
  getValue(row: number, column: number): ClipboardCell | null | undefined
}

interface MatrixSource {
  getMatrixWithMergedCells(
    row: number,
    column: number,
    endRow: number,
    endColumn: number,
    dataMode?: CellModeEnum,
  ): CellMatrixLike
}

/// Runs `generate` (Univer's copy) while recording the merged-cell matrix it
/// reads in both-value mode. Reading it a second time for the plain slice runs
/// every copied cell through the interceptor chain again — on a large bordered
/// range with formatting rules that was a sizable share of the copy freeze.
/// The recording is returned only when it covers `bounds()`.
export function generateWithCapturedMatrix<T>(
  worksheet: MatrixSource,
  generate: () => T,
  bounds: (result: T) => CellBounds | null,
): { result: T; matrix: CellMatrixLike | null } {
  let captured: { area: CellBounds; matrix: CellMatrixLike } | null = null
  const read = worksheet.getMatrixWithMergedCells
  const recorder: MatrixSource['getMatrixWithMergedCells'] = function (
    this: MatrixSource,
    row,
    column,
    endRow,
    endColumn,
    dataMode,
  ) {
    const matrix = read.call(this, row, column, endRow, endColumn, dataMode)
    if (!captured && dataMode === CellModeEnum.Both) {
      captured = { area: { startRow: row, endRow, startColumn: column, endColumn }, matrix }
    }
    return matrix
  }
  Object.defineProperty(worksheet, 'getMatrixWithMergedCells', {
    value: recorder,
    configurable: true,
    writable: true,
  })
  let result: T
  try {
    result = generate()
  } finally {
    // drop the shadow so the prototype method shows through again
    delete (worksheet as Partial<MatrixSource>).getMatrixWithMergedCells
  }
  const wanted = bounds(result)
  const hit = captured as { area: CellBounds; matrix: CellMatrixLike } | null
  const covers =
    hit !== null &&
    wanted !== null &&
    hit.area.startRow <= wanted.startRow &&
    hit.area.endRow >= wanted.endRow &&
    hit.area.startColumn <= wanted.startColumn &&
    hit.area.endColumn >= wanted.endColumn
  return { result, matrix: covers ? hit.matrix : null }
}

function discreteBounds(content: CopyContent | null | undefined): CellBounds | null {
  const rows = content?.discreteRange.rows
  const cols = content?.discreteRange.cols
  if (!rows?.length || !cols?.length) return null
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...cols),
    endColumn: Math.max(...cols),
  }
}

export function installTsvClipboardFix(runtime: UniverRuntime): { dispose(): void } {
  const injector = runtime.univer.__getInjector()
  const instanceService = injector.get(IUniverInstanceService)
  const clipboardService = injector.get(ISheetClipboardService) as {
    generateCopyContent(
      workbookId: string,
      worksheetId: string,
      range: unknown,
      options?: { copyHookType?: string },
    ): CopyContent | null | undefined
  }
  const original = clipboardService.generateCopyContent.bind(clipboardService)
  clipboardService.generateCopyContent = (workbookId, worksheetId, range, options) => {
    // Special copies (formula-only) keep Univer's plain text.
    if (options?.copyHookType && options.copyHookType !== 'default-copy') {
      return original(workbookId, worksheetId, range, options)
    }
    const worksheet = instanceService
      .getUniverSheetInstance(workbookId)
      ?.getSheetBySheetId(worksheetId)
    if (!worksheet) return original(workbookId, worksheetId, range, options)
    const { result: content, matrix: captured } = generateWithCapturedMatrix(
      worksheet as unknown as MatrixSource,
      () => original(workbookId, worksheetId, range, options),
      discreteBounds,
    )
    if (!content) return content
    try {
      const { rows, cols } = content.discreteRange
      const bounds = discreteBounds(content)
      if (!bounds) return content
      const matrix =
        captured ??
        worksheet.getMatrixWithMergedCells(
          bounds.startRow,
          bounds.startColumn,
          bounds.endRow,
          bounds.endColumn,
          CellModeEnum.Both,
        )
      const plain = plainTextFromCells(
        rows,
        cols,
        (row, column) => matrix.getValue(row, column) ?? null,
      )
      return { ...content, plain }
    } catch {
      return content
    }
  }
  return {
    dispose: () => {
      clipboardService.generateCopyContent = original
    },
  }
}
