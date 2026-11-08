/**
 * A new HTML tab that starts with given text (a skill template's copy, spec
 * 5.7). The shell opens a new untitled HTML tab and queues the text for that
 * tab's webContents in the same tick, before its renderer can ask; the
 * renderer takes it once after mounting and shows it as a NEW, UNSAVED page
 * (no path, so Save asks for one).
 *
 * A second take, a reload, another tab or a view made for a file gets
 * nothing; a tab that closes first drops its text. Nothing here runs an AI.
 */
import { ipcMain } from 'electron'
import type { HandoffWebContents } from '@genoffice/electron-utils/generate-handoff'
import { HTML_CHANNELS } from '../shared/ipc'

/** queued text by webContents id: one per new tab at most */
const seeds = new Map<number, string>()

/** queue text for a new tab; dropped when the tab goes away before taking it */
export function queueHtmlSeedFor(contents: HandoffWebContents, text: string): void {
  if (contents.isDestroyed()) return
  const id = contents.id
  seeds.set(id, text)
  contents.once('destroyed', () => seeds.delete(id))
}

/** the text queued for this webContents, once; null afterwards and for any other view */
export function takeHtmlSeed(webContentsId: number): string | null {
  const text = seeds.get(webContentsId) ?? null
  seeds.delete(webContentsId)
  return text
}

export interface HtmlSeedIpcOptions {
  /** whether the view was made for a file (such a view never takes) */
  opensFile(webContentsId: number): boolean
}

/** Registers `html:seed-take`. Called once, with the editor's other channels. */
export function registerHtmlSeedIpc(options: HtmlSeedIpcOptions): void {
  ipcMain.handle(HTML_CHANNELS.seedTake, (e): string | null =>
    options.opensFile(e.sender.id) ? null : takeHtmlSeed(e.sender.id),
  )
}
