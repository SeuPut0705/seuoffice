/**
 * "Is this file open somewhere with unsaved changes?" — asked before a file is
 * read as another document's material (a chat attachment, a knowledge-base read
 * or excerpt).
 *
 * Why it matters: what a reader withholds from a model is a mark stored *in the
 * file*, and it only gets there on save. A file that was just marked in one tab
 * and attached in another would be read from disk as it was before the mark, so
 * the words would go out. Such a file is not read until it is saved.
 *
 * The shell is the one place that knows every open tab, so it supplies the list
 * (`setOpenFilesSource`); the editor mains, which run in the shell's process,
 * ask through the functions below. An editor running on its own has no source
 * and nothing is blocked.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** what the host knows about one open document */
export interface OpenFileState {
  /** absent for a document that was never saved */
  filePath?: string
  dirty: boolean
}

export type OpenFilesSource = () => Promise<readonly OpenFileState[]> | readonly OpenFileState[]

/** what a refused read answers with; the caller's own error path carries it */
export const UNSAVED_CHANGES_MESSAGE =
  'This file is open with unsaved changes. Save it, then try again.'

// Symbol.for: the source survives multiple bundled copies of this module (see
// navigation-guard.ts), so the copy the shell sets is the one an editor reads
const SOURCE = Symbol.for('genoffice.open-files-source')

function holder(): Record<symbol, OpenFilesSource | null | undefined> {
  return globalThis as unknown as Record<symbol, OpenFilesSource | null | undefined>
}

/** the host's list of open documents; null removes it */
export function setOpenFilesSource(source: OpenFilesSource | null): void {
  holder()[SOURCE] = source
}

/** one spelling per file: resolved, through links, case-folded where the disk is */
function pathKey(value: string): string {
  let resolved = resolve(value)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // moved or deleted file: compare the resolved path as-is
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The files open with unsaved changes, or 'unknown' when the host could not
 * say. Unknown counts as unsaved everywhere below: reading on would be the
 * guess that sends unmarked words out.
 */
async function unsavedKeys(): Promise<Set<string> | 'unknown' | null> {
  const source = holder()[SOURCE]
  if (!source) return null
  try {
    const keys = new Set<string>()
    for (const doc of await source()) {
      if (doc.dirty && doc.filePath) keys.add(pathKey(doc.filePath))
    }
    return keys
  } catch {
    return 'unknown'
  }
}

export async function fileHasUnsavedChanges(filePath: string): Promise<boolean> {
  const keys = await unsavedKeys()
  if (keys === null) return false
  return keys === 'unknown' || keys.has(pathKey(filePath))
}

/** throws `UNSAVED_CHANGES_MESSAGE` for a file that must be saved before it is read */
export async function assertFileSaved(filePath: string): Promise<void> {
  if (await fileHasUnsavedChanges(filePath)) throw new Error(UNSAVED_CHANGES_MESSAGE)
}

/** the items whose file is not open with unsaved changes, in their order */
export async function withoutUnsavedFiles<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
): Promise<T[]> {
  const keys = await unsavedKeys()
  if (keys === null) return [...items]
  if (keys === 'unknown') return []
  return items.filter((item) => !keys.has(pathKey(pathOf(item))))
}
