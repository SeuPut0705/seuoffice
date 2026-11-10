import type { CollabAdapter, CollabSession, CollabStatus } from '@seuoffice/collab/client'
import { collabLink, reportCollabStatus } from './collab-link'
import { onHostSaveRequest, reportDirty, reportError, saveToHost } from './embed-channel'

export interface PageCollab<Handles> {
  /** the bytes the editor must open: the epoch base, which may be a peer's file rather than the host's */
  baseBytes: Uint8Array
  /** the renderer calls this once the editor shows `baseBytes`; later calls do nothing */
  attach(handles: Handles): Promise<void>
  /** what a host save request does: the file of one exact version, stored by the host */
  save(): Promise<void>
}

declare global {
  interface Window {
    /** set while the page co-edits: the renderer's one way into the session */
    seuCollab?: { attach(handles: unknown): Promise<void> }
  }
}

/**
 * Join the host's co-editing session before the editor opens anything.
 * Null when the host did not ask for co-editing; rejects with the engine's
 * `CollabError` when the session cannot be joined.
 *
 * From the join on, a host save request is answered by the session: the
 * engine freezes input, confirms every local edit, and produces the file of
 * one exact version, which goes to the host with that version and is then
 * reported to the server as stored. The app's own save handler is replaced:
 * a co-edited document must never be saved from a state the log does not hold.
 * The host's unsaved flag follows the session (edits in the log that no stored
 * file holds), so the app must not report its own. When the adapter cannot be
 * built the page leaves the session and reports `collab_unavailable`.
 */
export async function joinPageCollab<Handles, Op>(options: {
  format: { name: string; schema: number }
  fileName: string
  bytes: Uint8Array
  /** may settle later, for an editor that has to finish showing the document first */
  adapter(handles: Handles): CollabAdapter<Op> | Promise<CollabAdapter<Op>>
}): Promise<PageCollab<Handles> | null> {
  const link = collabLink()
  if (!link) return null
  // pages that never co-edit never load the engine
  const { joinCollab } = await import('@seuoffice/collab/client')
  const join = await joinCollab(link, { format: options.format, bytes: options.bytes })
  let session: CollabSession | null = null
  let attaching: Promise<void> | null = null

  const save = async (): Promise<void> => {
    if (!session) throw new Error('the document is not open yet')
    const saved = await session.save()
    await saveToHost(options.fileName, saved.bytes, { version: saved.version })
    session.reportSaved(saved.version)
  }
  onHostSaveRequest(save)

  const attach = (handles: Handles): Promise<void> => {
    attaching ??= (async () => {
      let adapter: CollabAdapter<Op>
      try {
        adapter = await options.adapter(handles)
      } catch (error) {
        // never edit a document the log cannot follow: leave the session and let the host reopen
        link.close()
        reportError('collab_unavailable', error instanceof Error ? error.message : String(error))
        return
      }
      const joined = join.attach(adapter)
      session = joined
      const report = (status: CollabStatus): void => {
        reportCollabStatus(status)
        // unsaved means the log holds edits no stored file has
        reportDirty(status.version > status.saved)
      }
      joined.subscribe(report)
      report(joined.status())
    })()
    return attaching
  }
  window.seuCollab = { attach: (handles) => attach(handles as Handles) }
  return { baseBytes: join.baseBytes, attach, save }
}
