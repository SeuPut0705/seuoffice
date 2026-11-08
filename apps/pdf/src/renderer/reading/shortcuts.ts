/**
 * Selection-bar shortcuts (reading-assist spec 4.1): while the markup bar over
 * a text selection is visible, one plain key runs one of its actions. Keys are
 * judged by `KeyboardEvent.code` (the physical key), so the same key works
 * with a Korean (or any other) input method active. Pure: the caller passes
 * the event and whether the bar is up and the document can be edited.
 */

export type SelectionBarAction =
  'highlight' | 'underline' | 'strikeout' | 'note' | 'explain' | 'translate' | 'ask'

/** the physical key of each action and the key name shown in tooltips */
export const SELECTION_BAR_KEYS: Readonly<
  Record<SelectionBarAction, { codes: readonly string[]; label: string }>
> = {
  highlight: { codes: ['KeyH'], label: 'H' },
  underline: { codes: ['KeyU'], label: 'U' },
  strikeout: { codes: ['KeyS'], label: 'S' },
  note: { codes: ['KeyN'], label: 'N' },
  explain: { codes: ['KeyE'], label: 'E' },
  translate: { codes: ['KeyT'], label: 'T' },
  ask: { codes: ['Enter', 'NumpadEnter'], label: 'Enter' },
}

/** actions that change the file: refused on a document that cannot be edited */
const FILE_EDITS: ReadonlySet<SelectionBarAction> = new Set([
  'highlight',
  'underline',
  'strikeout',
  'note',
])

const BY_CODE = new Map<string, SelectionBarAction>(
  (
    Object.entries(SELECTION_BAR_KEYS) as [SelectionBarAction, { codes: readonly string[] }][]
  ).flatMap(([action, { codes }]) => codes.map((code) => [code, action] as const)),
)

/** the fields of a keydown the judgement reads */
export interface SelectionBarKeyEvent {
  code: string
  key?: string
  isComposing?: boolean
  repeat?: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  target: EventTarget | null
}

export type SelectionBarKeyVerdict =
  | { action: SelectionBarAction }
  /** the key names a file edit on a document that cannot be edited */
  | { blocked: SelectionBarAction; reason: 'read-only' }

/** focus in a text field, a select or an editable region: keys belong to it */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { closest?: (s: string) => Element | null }) | null
  if (!el || typeof el !== 'object') return false
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return !!el.closest?.('[contenteditable]:not([contenteditable="false"])')
}

const isActivatable = (target: EventTarget | null): boolean => {
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null
  return !!el && typeof el === 'object' && !!el.closest?.('button, a[href], [role="button"]')
}

/**
 * What a keydown does while the selection bar may be visible; null when the
 * key is not a bar shortcut or must be left alone (bar hidden, an input method
 * composing, focus in an editable field, a modifier held, a held-down repeat).
 */
export function selectionBarKey(
  e: SelectionBarKeyEvent,
  ctx: { visible: boolean; readOnly: boolean },
): SelectionBarKeyVerdict | null {
  if (!ctx.visible) return null
  // an IME keydown during composition reports isComposing, or key 'Process' in Chromium
  if (e.isComposing || e.key === 'Process') return null
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.repeat) return null
  if (isEditableTarget(e.target)) return null
  const action = BY_CODE.get(e.code)
  if (!action) return null
  // Enter on a focused button or link activates it, not the bar
  if (action === 'ask' && isActivatable(e.target)) return null
  if (ctx.readOnly && FILE_EDITS.has(action)) return { blocked: action, reason: 'read-only' }
  return { action }
}

/** a tooltip or accessible name with its key, e.g. "Highlight (H)" */
export function labelWithKey(
  t: (key: 'rdWithKey', params: { label: string; key: string }) => string,
  label: string,
  action: SelectionBarAction,
): string {
  return t('rdWithKey', { label, key: SELECTION_BAR_KEYS[action].label })
}
