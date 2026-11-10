/**
 * Keeping the app's save journal (renderer/edit-journal.ts) exact while the
 * co-editing adapter reverts and replays this page's unconfirmed edits.
 *
 * The journal is an overwrite record fed by every mutation that runs. That is
 * right for remote and replayed mutations, which are the edits themselves, but
 * the mutations that revert an edit are not edits: a cell cleared and set back
 * journals as "reset this cell's style and write the old value" (the old
 * style travels as a style id, which the journal does not read), and a full
 * restore of a sheet's merges journals every merge once more. A file saved
 * from such a journal differs from the screen and from every other page's
 * file. So the adapter takes a mark right before each local mutation runs,
 * and once it has reverted that mutation it puts the journal back to the mark:
 * the journal then holds the log in server order, as on a page that only ever
 * applied it.
 */
import type { EditJournal, JournalEntry } from '../renderer/edit-journal'
import { type Mutation, SET_RANGE_VALUES } from './collab-mutations'

/** Puts the journal back to where it was when the mark was taken; runs at most once */
export type JournalRevert = () => void

/**
 * A full copy. Cell entries are never changed in place (every journal write
 * allocates a new entry), so the cell maps are copied one level deep; the rest
 * is small and cloned whole.
 */
function copyOf(journal: EditJournal): EditJournal {
  const { cells, ...rest } = journal
  return {
    ...structuredClone(rest),
    cells: new Map(Array.from(cells, ([sheetId, entries]) => [sheetId, new Map(entries)])),
  }
}

/** Make `live` hold what `saved` holds, keeping the identity of every container the journal owns */
function refill(live: object, saved: object): void {
  const target = live as Record<string, unknown>
  const source = saved as Record<string, unknown>
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key]
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (current instanceof Map && value instanceof Map) {
      current.clear()
      for (const [k, v] of value) current.set(k, v)
    } else if (current instanceof Set && value instanceof Set) {
      current.clear()
      for (const v of value) current.add(v)
    } else if (Array.isArray(current) && Array.isArray(value)) {
      current.length = 0
      for (const item of value) current.push(item)
    } else if (current && value && typeof current === 'object' && typeof value === 'object') {
      refill(current, value)
    } else {
      target[key] = value
    }
  }
}

/**
 * The mark of `journal` before `mutation` (in the form `ICommandService` runs)
 * is recorded. A cell write only ever touches the entries of its own cells, so
 * its mark is those entries; every other mutation may shift or rewrite
 * anything (rows and columns move cell entries, fills, links, page breaks and
 * drawing anchors), so its mark is the whole journal.
 */
export function journalMark(journal: EditJournal, mutation: Mutation): JournalRevert {
  if (mutation.id !== SET_RANGE_VALUES) {
    const copy = copyOf(journal)
    return () => refill(journal, copy)
  }
  const sheetId = String(mutation.params.subUnitId)
  const entries = journal.cells.get(sheetId)
  const before: [string, JournalEntry | undefined][] = []
  const cells = (mutation.params.cellValue ?? {}) as Record<
    string,
    Record<string, unknown> | null | undefined
  >
  for (const [row, columns] of Object.entries(cells)) {
    for (const column of Object.keys(columns ?? {})) {
      const key = `${Number(row)}:${Number(column)}`
      before.push([key, entries?.get(key)])
    }
  }
  return () => {
    const live = journal.cells.get(sheetId) ?? new Map<string, JournalEntry>()
    for (const [key, entry] of before) {
      if (entry) live.set(key, entry)
      else live.delete(key)
    }
    if (live.size > 0) journal.cells.set(sheetId, live)
    else journal.cells.delete(sheetId)
  }
}
