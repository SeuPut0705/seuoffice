/**
 * What a co-editing page may still do outside Univer's commands.
 *
 * The adapter shares an edit only as the Univer mutations it runs
 * (collab-adapter.ts). Much of the app writes its save journal or other
 * per-page state directly instead: charts, shapes, pictures, sparklines,
 * pivots, tables, hyperlinks, page setup, protection, themes, outlines,
 * threaded comments. Such an edit would show on one page and be in that
 * page's saved file only, so while co-editing it is refused where it starts.
 *
 * The renderer asks `editRefusal(kind)` (renderer/sheet-protection.ts) at its
 * entry points: the ribbon and context-menu dispatch (the command string), the
 * operation executor that the ribbon, dialogs and the AI panel share
 * (`op:<kind>`), and the handlers that edit on the grid without a command
 * (`direct:<what>`). Everything not listed below is refused: a command added
 * upstream stays off until someone has checked that it only runs mutations.
 */

/**
 * Ribbon and context-menu commands that change nothing a save writes, or change
 * it only through Univer commands. An entry also covers `entry:<argument>`.
 * Commands of Univer features the adapter cannot carry (filters, conditional
 * formats, data validation, notes) are left out too: they would be refused at
 * their Univer command anyway.
 */
const SHARED_COMMANDS = new Set([
  // looking, moving, copying out
  'copy',
  'find',
  'replace',
  'goto-open',
  'scroll-to-active',
  'page-row',
  'page-col',
  'zoom',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'zoom-to-selection',
  'trace-precedents',
  'trace-dependents',
  'remove-arrows',
  'watch-window',
  'workbook-statistics',
  'error-checking',
  'error',
  'toggle-cross-highlight',
  'toggle-formula-bar',
  'formula-bar-toggle',
  'dv-dropdown-open',
  'note-open',
  'note-prev',
  'note-next',
  'export-pdf',
  'calc-mode',
  'calculate-now',
  'calculate-sheet',
  // the AI panel itself: what it applies goes through the operation executor, and an agent
  // run, which takes the workbook for itself, is refused where it starts (`direct:ai-run`)
  'ai-open-panel',
  'ai-toggle-panel',
  'ai-ask-selection',
  // history and the clipboard
  'undo',
  'redo',
  'redo-or-repeat',
  'cut',
  'paste',
  'paste-special',
  'paste-special-open',
  'format-painter',
  // cell formats; the Format Cells dialog sends these same commands
  'format-cells',
  'bold',
  'italic',
  'underline',
  'strike',
  'superscript',
  'subscript',
  'align',
  'valign',
  'wrap',
  'indent',
  'indent-step',
  'rotate',
  'format',
  'decimal-inc',
  'decimal-dec',
  'font-family',
  'font-size',
  'font-size-step',
  'font-color',
  'fill',
  'border',
  'cell-style',
  'merge',
  // cell contents
  'clear-contents',
  'clear-formats',
  'clear-all',
  'fill-down',
  'fill-right',
  'fill-up',
  'fill-left',
  'flash-fill',
  'autofn',
  'insert-now',
  'copy-above',
  'insert-symbol',
  'insert-function-open',
  'use-in-formula',
  'import-csv',
  'sort',
  'sort-custom',
  'sort-custom-open',
  'remove-duplicates',
  'remove-duplicates-open',
  'text-to-columns',
  'name-manager-open',
  'create-names',
  // rows, columns, sheets and the sheet view
  'insert-cells',
  'delete-cells',
  'insert-row-here',
  'delete-row-here',
  'insert-col-here',
  'delete-col-here',
  'insert-sheet',
  'row-height',
  'row-height-open',
  'col-width',
  'col-width-open',
  'autofit-row-height',
  'autofit-col-width',
  'freeze-here',
  'freeze-top-row',
  'freeze-first-col',
  'unfreeze',
  'toggle-gridlines',
  'toggle-right-to-left',
])

/** Executor operations (`op.op`) that only call the Univer facade */
const SHARED_OPERATIONS = new Set([
  'insert_rows',
  'delete_rows',
  'insert_cols',
  'delete_cols',
  'merge_cells',
  'unmerge_cells',
  'set_row_height',
  'set_col_width',
  'set_rows_hidden',
  'set_cols_hidden',
  'add_sheet',
  'delete_sheet',
  'move_sheet',
  'set_sheet_hidden',
  'set_freeze',
  'add_defined_name',
  'delete_defined_name',
])

/**
 * Refused without a word: the rest of the edit runs as mutations and is
 * shared, only this page-local part of it is left out. A full-column format
 * also records a column default in the journal; no page records it now.
 */
const SILENT = new Set(['direct:column-default-style'])

/** Whether a co-editing page may run `kind` (see the file comment for the three forms) */
export function sharedWhileCoEditing(kind: string): boolean {
  if (kind.startsWith('op:')) return SHARED_OPERATIONS.has(kind.slice('op:'.length))
  if (kind.startsWith('direct:')) return false
  const argument = kind.indexOf(':')
  return SHARED_COMMANDS.has(argument === -1 ? kind : kind.slice(0, argument))
}

/** Whether refusing `kind` should tell the person */
export function refusalIsSilent(kind: string): boolean {
  return SILENT.has(kind)
}
