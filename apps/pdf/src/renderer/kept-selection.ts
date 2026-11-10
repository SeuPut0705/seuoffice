/**
 * Which selection survives a change that arrives from outside the person's own
 * action (web co-editing: another person's edit lands while something is
 * selected). The selection stays while the item it names is still pending.
 */
import type { AnnotSelection, EditSnapshot } from './edit-state'

/** The pending-edit lists a selection can name an item of, by selection kind */
const LISTS = {
  markup: 'markups',
  drawing: 'drawings',
  textEdit: 'textEdits',
  textInsert: 'textInserts',
  imageEdit: 'imageEdits',
} as const satisfies Record<string, keyof EditSnapshot>

/** `selection` when what it names is still in `s`, else null */
export function keptSelection(
  selection: AnnotSelection | null,
  s: EditSnapshot,
): AnnotSelection | null {
  if (!selection) return null
  switch (selection.kind) {
    // what the opened file holds: no pending edit of someone else removes it
    case 'savedMarkup':
    case 'pageImage':
      return selection
    case 'stamp':
      return s.stampCfg ? selection : null
    default:
      return s[LISTS[selection.kind]].some((item) => item.id === selection.id) ? selection : null
  }
}

/** A context menu on a pending markup stays while that markup is still in `s` */
export function keptMarkupMenu<Menu extends { kind: 'pending'; id: string } | { kind: 'saved' }>(
  menu: Menu | null,
  s: EditSnapshot,
): Menu | null {
  if (!menu || menu.kind === 'saved') return menu
  return s.markups.some((markup) => markup.id === menu.id) ? menu : null
}
