/**
 * The quick-access row left of the ribbon tabs: which commands sit there, in
 * what order, and the Alt+digit chord that runs the Nth one (Excel's Quick
 * Access Toolbar). Pure so the catalog, the stored order and the key mapping
 * can be unit-tested; ExcelShell renders the row and dispatches.
 *
 * The choice is a per-PC preference in localStorage, like the status-bar
 * aggregates: it never travels with a workbook.
 */
import type { StringKey } from './i18n/locale'
import { PASTE_SPECIAL_OPEN_SHELL_COMMAND } from './paste-special'

export const QUICK_ACCESS_STORAGE_KEY = 'sheets.quickAccess'

/// One slot per Alt+digit: 1..9, then 0 for the tenth.
export const QUICK_ACCESS_MAX_ITEMS = 10

/// Handled by the shell's own props (save state, undo stack), not by a
/// ribbon command string.
export type QuickAccessBuiltin = 'save' | 'save-as' | 'undo' | 'redo'

export interface QuickAccessItem {
  readonly id: string
  readonly labelKey: StringKey
  /// Present for the four built-in buttons, which draw their own icons.
  readonly builtin?: QuickAccessBuiltin
  /// Ribbon command string, dispatched like a ribbon click.
  readonly command?: string
  /// Key into RIBBON_GLYPH_ICONS, the same glyph the ribbon button uses.
  readonly symbol?: string
}

export const QUICK_ACCESS_CATALOG: readonly QuickAccessItem[] = [
  { id: 'save', labelKey: 'appSaveTitle', builtin: 'save' },
  { id: 'save-as', labelKey: 'appSaveAs', builtin: 'save-as' },
  { id: 'undo', labelKey: 'appUndo', builtin: 'undo' },
  { id: 'redo', labelKey: 'appRedo', builtin: 'redo' },
  { id: 'sort-asc', labelKey: 'appSortAToZ', command: 'sort:asc', symbol: '↑' },
  { id: 'sort-desc', labelKey: 'appSortZToA', command: 'sort:desc', symbol: '↓' },
  { id: 'filter', labelKey: 'appFilter', command: 'filter-toggle', symbol: '▽' },
  { id: 'format-painter', labelKey: 'appFormatPainter', command: 'format-painter', symbol: '🖌' },
  { id: 'autosum', labelKey: 'appAutoSum', command: 'autofn:SUM', symbol: '∑' },
  {
    id: 'insert-function',
    labelKey: 'appInsertFunction',
    command: 'insert-function-open',
    symbol: 'ƒx',
  },
  {
    id: 'paste-special',
    labelKey: 'appPasteSpecial',
    command: PASTE_SPECIAL_OPEN_SHELL_COMMAND,
    symbol: '📋',
  },
  { id: 'merge-center', labelKey: 'appMergeCenter', command: 'merge:center', symbol: '⇔' },
  { id: 'wrap', labelKey: 'dlgFcWrapText', command: 'wrap', symbol: '↩' },
  { id: 'format-cells', labelKey: 'appFormatCells', command: 'format-cells', symbol: '🎨' },
  {
    id: 'conditional-formatting',
    labelKey: 'appConditionalFormatting',
    command: 'cf-open',
    symbol: '▤',
  },
  { id: 'insert-row', labelKey: 'appInsertRow', command: 'insert-row-here', symbol: '⤒' },
  { id: 'delete-row', labelKey: 'appDeleteRow', command: 'delete-row-here', symbol: '⤓' },
  { id: 'clear-formats', labelKey: 'appClearFormats', command: 'clear-formats', symbol: '⌫' },
  { id: 'freeze-panes', labelKey: 'appFreezePanes', command: 'freeze-here', symbol: '❄' },
  { id: 'find', labelKey: 'appFind', command: 'find', symbol: '🔍' },
  { id: 'replace', labelKey: 'appReplace', command: 'replace', symbol: '⇄' },
  { id: 'new-comment', labelKey: 'appNewComment', command: 'comment-new', symbol: '🗨' },
  { id: 'insert-picture', labelKey: 'appPictures', command: 'insert-picture', symbol: '🖼' },
  {
    id: 'recommended-charts',
    labelKey: 'appRecommendedCharts',
    command: 'recommended-charts-open',
    symbol: '📊',
  },
  { id: 'table', labelKey: 'appTableBtn', command: 'format-as-table', symbol: '▦' },
  { id: 'pivot-table', labelKey: 'appPivotTable', command: 'pivot-open', symbol: '⊞' },
  { id: 'data-validation', labelKey: 'appDataValidation', command: 'dv-open', symbol: '☑' },
  {
    id: 'remove-duplicates',
    labelKey: 'appRemoveDuplicates',
    command: 'remove-duplicates-open',
    symbol: '⧉',
  },
  { id: 'spell-check', labelKey: 'appSpellTitle', command: 'spell-check', symbol: '✓' },
  { id: 'calculate-now', labelKey: 'appCalculateNow', command: 'calculate-now', symbol: '⟳' },
]

/// The row every install starts with: the four buttons it always had.
export const DEFAULT_QUICK_ACCESS: readonly string[] = ['save', 'save-as', 'undo', 'redo']

const CATALOG_BY_ID = new Map(QUICK_ACCESS_CATALOG.map((item) => [item.id, item]))

export function quickAccessItem(id: string): QuickAccessItem | undefined {
  return CATALOG_BY_ID.get(id)
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/// Known ids only, first occurrence wins, capped at the Alt+digit slots. An
/// id a later version drops (or a hand-edited value) falls out silently.
function sanitize(ids: readonly unknown[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !CATALOG_BY_ID.has(id) || out.includes(id)) continue
    out.push(id)
    if (out.length === QUICK_ACCESS_MAX_ITEMS) break
  }
  return out
}

export function parseQuickAccess(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [...DEFAULT_QUICK_ACCESS]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_QUICK_ACCESS]
    // an empty row is a choice (every button removed), not a broken value
    return sanitize(parsed)
  } catch {
    return [...DEFAULT_QUICK_ACCESS]
  }
}

export function readQuickAccess(storage: StorageLike | null | undefined): string[] {
  try {
    return parseQuickAccess(storage?.getItem(QUICK_ACCESS_STORAGE_KEY))
  } catch {
    return [...DEFAULT_QUICK_ACCESS]
  }
}

export function writeQuickAccess(
  storage: StorageLike | null | undefined,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(QUICK_ACCESS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Storage may be full or disabled; the in-memory choice still applies.
  }
}

/// Removes the id when present, appends it otherwise. A full row refuses the
/// append, so every button on it keeps an Alt+digit.
export function toggleQuickAccess(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id)
  if (!CATALOG_BY_ID.has(id) || ids.length >= QUICK_ACCESS_MAX_ITEMS) return [...ids]
  return [...ids, id]
}

/// Swaps the id with its neighbour: -1 toward the first slot, 1 away from it.
export function moveQuickAccess(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const next = [...ids]
  next[from] = ids[to]!
  next[to] = id
  return next
}

/// The digit a slot answers to: 1..9 for the first nine, 0 for the tenth.
export function quickAccessDigit(index: number): string | null {
  if (index < 0 || index >= QUICK_ACCESS_MAX_ITEMS) return null
  return index === 9 ? '0' : String(index + 1)
}

export interface QuickAccessKeyEvent {
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly defaultPrevented: boolean
}

/**
 * The slot a keydown addresses, or null: Alt plus a top-row digit, nothing
 * else held. Windows and Linux only — on a Mac Option+digit types a
 * character. AltGr reports Ctrl+Alt and the numpad keeps its Alt codes, so
 * neither lands here.
 */
export function quickAccessSlotForKey(event: QuickAccessKeyEvent, isMac: boolean): number | null {
  if (isMac || event.defaultPrevented) return null
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  const match = /^Digit([0-9])$/.exec(event.code)
  if (!match) return null
  const digit = Number(match[1])
  return digit === 0 ? 9 : digit - 1
}
