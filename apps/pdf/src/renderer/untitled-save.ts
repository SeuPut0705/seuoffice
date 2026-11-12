/**
 * The first explicit save of an untitled copy (a skill template's, a recovered
 * untitled document). The copy is a working file outside the user's folders,
 * so the save asks where the document goes. That is asked before anything is
 * written: cancelling leaves the edits pending and undoable and the document
 * unsaved, instead of saving them into the working file and showing a clean
 * tab that closes without a question, taking the document with it.
 */
export interface UntitledSaveApi {
  /** the save dialog, answered in the main process; false when it was cancelled */
  pickUntitledCopyTarget(path: string, defaultName: string): Promise<boolean>
  /** copies the working file to the picked place, which becomes the tab's document */
  adoptUntitledCopy(path: string): Promise<string | null>
}

/**
 * Saves the untitled copy at `path` to a place the person picks. `saveEdits`
 * writes the pending edits into the copy; false when that failed. Resolves to
 * where the document is afterwards, or null when it stays where it was (the
 * dialog was cancelled, or the edits or the file could not be written).
 */
export async function saveUntitledCopy(
  api: UntitledSaveApi,
  path: string,
  defaultName: string,
  saveEdits: () => Promise<boolean>,
): Promise<string | null> {
  if (!(await api.pickUntitledCopyTarget(path, defaultName).catch(() => false))) return null
  if (!(await saveEdits())) return null
  return api.adoptUntitledCopy(path).catch(() => null)
}
