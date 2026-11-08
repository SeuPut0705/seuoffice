/**
 * A new map tab that starts with given content (spec 8.6, "convert without
 * AI": a markdown document read as an outline, 4.9), on the main-process side
 * of the mind map editor.
 *
 * The shell opens a new untitled map tab and queues the outline text for that
 * tab's webContents in the same tick, before its renderer can ask. The editor
 * takes it here, once — like the generate hand-off take: a second take, a
 * reload or another tab gets nothing, and a view made for a file never takes.
 * The renderer builds the map from the text with the engine's reader and
 * opens it as a NEW, UNSAVED map (saving asks for a path).
 *
 * Nothing here runs an AI.
 */
import { ipcMain } from 'electron'
import type { HandoffWebContents } from '@genoffice/electron-utils/generate-handoff'
import { MINDMAP_CHANNELS, type MindmapSeed } from '../shared/ipc'

/** queued content by webContents id: one per new tab at most */
const seeds = new Map<number, MindmapSeed>()

/** queue content for a new tab; dropped when the tab goes away before taking it */
export function queueMindmapSeedFor(contents: HandoffWebContents, seed: MindmapSeed): void {
  if (contents.isDestroyed()) return
  const id = contents.id
  seeds.set(id, seed)
  contents.once('destroyed', () => seeds.delete(id))
}

/** the content queued for this webContents, once; null afterwards and for any other view */
export function takeMindmapSeed(webContentsId: number): MindmapSeed | null {
  const seed = seeds.get(webContentsId) ?? null
  seeds.delete(webContentsId)
  return seed
}

export interface MindmapSeedIpcOptions {
  /** whether the view was made for a file (such a view is not a new map and never takes) */
  opensFile(webContentsId: number): boolean
}

/** Registers `mindmap:seed-take`. Called once, with the editor's other channels. */
export function registerMindmapSeedIpc(options: MindmapSeedIpcOptions): void {
  ipcMain.handle(MINDMAP_CHANNELS.seedTake, (e): MindmapSeed | null =>
    options.opensFile(e.sender.id) ? null : takeMindmapSeed(e.sender.id),
  )
}
