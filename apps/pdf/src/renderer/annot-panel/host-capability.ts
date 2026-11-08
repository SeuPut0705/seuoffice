/**
 * Whether this PDF window runs inside the shell (reading-assist spec 4.3, 6).
 * The preload exposes the same bridges in a standalone run, so their presence
 * says nothing; the result store channel, though, is registered by the shell
 * only, and a standalone window answers it with `not-available`. Asking it
 * for the cards of an empty hash reads and writes nothing (the shell refuses
 * an unknown hash at once). Making a Word document needs the shell too.
 */
import type { PdfStoreApi } from '../../shared/ipc'

export async function probeShellHost(
  store: Pick<PdfStoreApi, 'passages'> | null | undefined,
): Promise<boolean> {
  if (!store) return false
  try {
    const answer = await store.passages('')
    return answer.ok || answer.error !== 'not-available'
  } catch {
    return false
  }
}

let cached: Promise<boolean> | null = null

/** this window's answer, asked once */
export function shellHostOnce(): Promise<boolean> {
  cached ??= probeShellHost(typeof window === 'undefined' ? null : window.pdfApi?.store)
  return cached
}
