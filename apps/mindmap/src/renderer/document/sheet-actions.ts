/**
 * Deleting a sheet, with the question that comes first.
 *
 * A deleted sheet cannot be brought back with undo, so the user is asked
 * before anything is removed. The last sheet of a file is refused without a
 * question: a file holds at least one sheet.
 */
import type { DocumentSession } from './session'

export type SheetDeleteOutcome = 'deleted' | 'cancelled' | 'last-sheet' | 'no-such-sheet'

/** `confirm` is shown the sheet's title and answers whether to go on. */
export async function deleteSheetAfterConfirm(
  session: DocumentSession,
  key: string,
  confirm: (title: string) => Promise<boolean>,
): Promise<SheetDeleteOutcome> {
  const tabs = session.tabs()
  const tab = tabs.find((candidate) => candidate.key === key)
  if (!tab) return 'no-such-sheet'
  if (tabs.length === 1) return 'last-sheet'
  if (!(await confirm(tab.title))) return 'cancelled'
  const result = session.deleteSheet(key)
  if (result.ok) return 'deleted'
  return result.problem === 'last-sheet' ? 'last-sheet' : 'no-such-sheet'
}
