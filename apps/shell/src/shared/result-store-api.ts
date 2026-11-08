/**
 * Settings → General: the PDF result store (AI-read pages, translations and
 * unfinished job records kept on this PC, spec §6). The settings screen shows
 * how much space it takes and deletes all of it after the user confirms.
 */
export const RESULT_STORE_CHANNELS = {
  size: 'home:result-store-size',
  deleteAll: 'home:result-store-delete-all',
} as const

export interface ResultStoreApi {
  /** bytes the store takes on disk; 0 when it does not exist yet */
  size(): Promise<number>
  /** remove the whole store folder (and nothing outside it) */
  deleteAll(): Promise<void>
}
