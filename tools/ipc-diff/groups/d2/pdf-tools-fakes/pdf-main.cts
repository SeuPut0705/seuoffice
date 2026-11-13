/**
 * The one export of `apps/pdf/src/main/pdf-main.ts` the PDF tools read: the
 * editor's grant table, written by the `d2/pdf-tools:open-view` trigger as
 * `grantAndTrack` writes it.
 */
import { existsSync } from 'node:fs'
import { state } from './state.cts'

export function pdfPathGranted(webContentsId: number, path: unknown): path is string {
  return typeof path === 'string' && !!state().grants.get(webContentsId)?.has(path)
}

/** `grantAndTrack(wc, openPath)`: the view's only grant is its file, when it exists */
export function grantAndTrack(webContentsId: number, openPath: unknown): void {
  const allowed = new Set<string>()
  if (typeof openPath === 'string' && openPath && existsSync(openPath)) allowed.add(openPath)
  state().grants.set(webContentsId, allowed)
}
