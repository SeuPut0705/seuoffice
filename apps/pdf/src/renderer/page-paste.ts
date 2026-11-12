/**
 * Paste of the copied pages (thumbnail sidebar). The pages land in the file at
 * once, so the paste goes the way of the other page operations written in
 * place: the file from before it is kept for Undo, and a file too large to
 * keep is asked about first.
 */
import type { PastePagesRequest, PastePagesResult } from '../shared/ipc'
import type { PdfFileChunkApi } from './file-bytes'
import { writeInPlace, type NoUndoGate, type PendingEdits } from './written-history'

export interface PagePasteApi extends PdfFileChunkApi {
  copiedPageCount?(): Promise<number>
  pastePages(request: PastePagesRequest): Promise<PastePagesResult>
}

export type PagePaste =
  /** nothing was pasted: no page is copied, the person chose not to go on, or the pending
   *  edits could not be saved */
  | { pasted: false; why: 'empty' | 'declined' | 'unsaved' }
  /** `protected`: the file is password-protected or encrypted */
  | { pasted: false; why: 'failed'; error: string; protected: boolean }
  /** `before`: the file from before the paste, null when it was too large to keep for Undo */
  | { pasted: true; count: number; before: Uint8Array | null }

/** Pastes the copied pages after a page of the file as saved; -1 = front of the document */
export async function pasteCopiedPages(
  api: PagePasteApi,
  path: string,
  afterPageIndex: number,
  gate: NoUndoGate,
  pending?: PendingEdits,
): Promise<PagePaste> {
  // nothing to paste: no question about Undo, and the pending edits stay pending
  if (((await api.copiedPageCount?.()) ?? 0) === 0) return { pasted: false, why: 'empty' }
  const change = await writeInPlace(
    api,
    path,
    () => api.pastePages({ path, afterPageIndex }),
    gate,
    pending,
  )
  if (change.status !== 'run') return { pasted: false, why: change.status }
  const { result, before } = change
  if (!result.ok) {
    return {
      pasted: false,
      why: 'failed',
      error: result.error,
      protected: result.protected === true,
    }
  }
  // the copied pages went away meanwhile: the file was not written, there is no step to keep
  if (result.insertedCount === 0) return { pasted: false, why: 'empty' }
  return { pasted: true, count: result.insertedCount, before }
}
