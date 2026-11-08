/**
 * A new markdown tab that starts with given text (spec 8.6, "convert without
 * AI": a map's outline text). The shell opens a new untitled markdown tab and
 * queues the text for that tab's webContents in the same tick, before its
 * renderer can ask; the renderer takes it once after mounting, puts it in the
 * editor as a NEW, UNSAVED document (no path, so Save asks for one) and marks
 * it changed.
 *
 * A second take, a reload, another tab or a view made for a file gets
 * nothing; a tab that closes first drops its text. Nothing here runs an AI.
 */
import { ipcMain } from 'electron'
import type { HandoffWebContents } from '@genoffice/electron-utils/generate-handoff'
import { MARKDOWN_CHANNELS } from '../shared/ipc'

/** queued text by webContents id: one per new tab at most */
const seeds = new Map<number, string>()

/** queue text for a new tab; dropped when the tab goes away before taking it */
export function queueMarkdownSeedFor(contents: HandoffWebContents, text: string): void {
  if (contents.isDestroyed()) return
  const id = contents.id
  seeds.set(id, text)
  contents.once('destroyed', () => seeds.delete(id))
}

/** the text queued for this webContents, once; null afterwards and for any other view */
export function takeMarkdownSeed(webContentsId: number): string | null {
  const text = seeds.get(webContentsId) ?? null
  seeds.delete(webContentsId)
  return text
}

export interface MarkdownSeedIpcOptions {
  /** whether the view was made for a file (such a view never takes) */
  opensFile(webContentsId: number): boolean
}

/** Registers `markdown:seed-take`. Called once, with the editor's other channels. */
export function registerMarkdownSeedIpc(options: MarkdownSeedIpcOptions): void {
  ipcMain.handle(MARKDOWN_CHANNELS.seedTake, (e): string | null =>
    options.opensFile(e.sender.id) ? null : takeMarkdownSeed(e.sender.id),
  )
}
