/**
 * The first explicit save of an untitled copy (a skill template's, a recovered
 * untitled document). The copy is a working file outside the user's folders,
 * so the save asks where the document goes. That is asked before anything is
 * written: cancelling leaves the edits pending and undoable.
 *
 * Whether the document counts as saved is not decided here. The main process
 * holds that: an untitled copy stays unsaved until it is at the place the
 * person chose, whatever was written into the working file on the way.
 */
import type { AdoptUntitledCopyResult } from '../shared/ipc'

export interface UntitledSaveApi {
  /** the save dialog, answered in the main process; false when it was cancelled */
  pickUntitledCopyTarget(path: string, defaultName: string): Promise<boolean>
  /** copies the working file to the picked place, which becomes the tab's document */
  adoptUntitledCopy(path: string): Promise<AdoptUntitledCopyResult>
}

export type UntitledSave =
  /** the document is at the place the person picked: `path` */
  | { saved: true; path: string }
  /** the dialog was cancelled (nothing was written), or the edits could not be written
   *  into the copy (their save said why) */
  | { saved: false; why: 'cancelled' | 'unsaved' }
  /** the edits are in the copy, but the copy could not be put at the picked place: the
   *  document is still untitled and unsaved, and `error` says why */
  | { saved: false; why: 'failed'; error: string }

export interface UntitledSaver {
  /**
   * The place is picked and the edits are being written into the copy. A save
   * request arriving now is not a first save: the caller writes it like any
   * save (it queues behind this write), and this save then moves the document.
   */
  readonly writing: boolean
  /**
   * Saves the untitled copy at `path` to a place the person picks. `saveEdits`
   * writes the pending edits into the copy; false when that failed. While the
   * place is still being asked for, a second request is this same save: one
   * dialog, one answer, and nothing written if it is cancelled.
   */
  save(path: string, defaultName: string, saveEdits: () => Promise<boolean>): Promise<UntitledSave>
}

export function createUntitledSaver(api: UntitledSaveApi): UntitledSaver {
  let running: Promise<UntitledSave> | null = null
  let writing = false

  const run = async (
    path: string,
    defaultName: string,
    saveEdits: () => Promise<boolean>,
  ): Promise<UntitledSave> => {
    if (!(await api.pickUntitledCopyTarget(path, defaultName).catch(() => false))) {
      return { saved: false, why: 'cancelled' }
    }
    writing = true
    if (!(await saveEdits())) return { saved: false, why: 'unsaved' }
    const adopted = await api
      .adoptUntitledCopy(path)
      .catch((err: unknown): AdoptUntitledCopyResult => ({ ok: false, error: String(err) }))
    return adopted.ok
      ? { saved: true, path: adopted.path }
      : { saved: false, why: 'failed', error: adopted.error }
  }

  return {
    get writing() {
      return writing
    },
    save(path, defaultName, saveEdits) {
      // registered before the flow starts: a request that arrives while the dialog is
      // being opened is this save too
      running ??= Promise.resolve()
        .then(() => run(path, defaultName, saveEdits))
        .finally(() => {
          running = null
          writing = false
        })
      return running
    },
  }
}
