/**
 * "In the file" states are confirmed by a successful PDF save (reading-assist
 * spec 3.5). A feature that adds an annotation for something it keeps in the
 * result store (a passage card kept as a note, an accepted AI highlight)
 * registers a confirmation under the annotation's pending id. When a save that
 * wrote that annotation succeeds, and after the store migration moved the
 * results to the saved file's hash, the confirmation runs with that new hash
 * and writes the confirmed state there. Until then the screen shows "waiting
 * for save"; a document closed without saving writes nothing, because the
 * confirmations only live in the tab.
 *
 * The save path holds what a successful save wrote before it reloads the
 * document: the reload drops those annotations from the editing document,
 * and a feature that sees its annotation gone would otherwise cancel the
 * confirmation as "removed before any save". A held confirmation ignores
 * `cancel` and keeps showing "waiting for save" until it runs.
 *
 * One instance per tab; not tied to any feature.
 */

/** writes the confirmed state under the saved file's document hash */
export type SaveConfirmation = (docHash: string) => Promise<void> | void

export interface SaveConfirmations {
  /** wait for a save that writes annotation `annotId`; replaces an earlier one for the same id */
  register(annotId: string, confirm: SaveConfirmation): void
  /** forget a waiting confirmation (the annotation was removed before any save); a held one stays */
  cancel(annotId: string): void
  /**
   * A save that wrote these annotations succeeded: keep their waiting
   * confirmations from `cancel` until one runs (called before the reload)
   */
  hold(written: Iterable<string>): void
  /** the annotation is in the saved file and its confirmation waits for the migration */
  isHeld(annotId: string): boolean
  isPending(annotId: string): boolean
  pendingIds(): string[]
  /** told when the waiting set changes */
  subscribe(listener: () => void): () => void
  /**
   * After a successful PDF save and the store migration: run the confirmations
   * of the annotations the save wrote, and of held ones an earlier save left
   * waiting, under the hash `docHash` resolves to (asked only when one is
   * due): the hash the completed migration moved the store to. When it
   * resolves to null nothing runs and they keep waiting (held ones stay held).
   * A failing confirmation does not stop the others.
   */
  afterSave(written: Iterable<string>, docHash: () => Promise<string | null>): Promise<void>
}

export function createSaveConfirmations(): SaveConfirmations {
  const waiting = new Map<string, SaveConfirmation>()
  /** waiting ids whose annotation a successful save already wrote */
  const held = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    register(annotId, confirm) {
      waiting.set(annotId, confirm)
      notify()
    },
    cancel(annotId) {
      if (held.has(annotId)) return
      if (waiting.delete(annotId)) notify()
    },
    hold(written) {
      let changed = false
      for (const id of written) {
        if (!waiting.has(id) || held.has(id)) continue
        held.add(id)
        changed = true
      }
      if (changed) notify()
    },
    isHeld: (annotId) => held.has(annotId),
    isPending: (annotId) => waiting.has(annotId),
    pendingIds: () => [...waiting.keys()],
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async afterSave(written, docHash) {
      const writtenSet = new Set(written)
      const due = [...waiting].filter(([id]) => writtenSet.has(id) || held.has(id))
      if (due.length === 0) return
      const hash = await docHash().catch(() => null)
      if (!hash) return
      for (const [id, confirm] of due) {
        // a later registration for the same id (written by a later save) stays
        if (waiting.get(id) === confirm) {
          waiting.delete(id)
          held.delete(id)
        }
      }
      notify()
      for (const [, confirm] of due) {
        try {
          await confirm(hash)
        } catch {
          // the annotation is in the file either way; the store just does not say so
        }
      }
      notify()
    },
  }
}
