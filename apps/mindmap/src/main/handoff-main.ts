/**
 * A generation request handed over by the shell (spec 8.5), on the
 * main-process side of the mind map editor.
 *
 * The shell's "make" opens a new untitled map tab and queues one request for
 * that tab's webContents (`@genoffice/electron-utils/generate-handoff`). The
 * editor in the tab takes it here, once: a second take, a reload or another
 * tab gets nothing. A view made for a file never takes. Nothing here starts a
 * run; the renderer's AI panel starts it through its send gate, with the
 * provider chosen as usual.
 *
 * The renderer reports each run that started with handed-over files still
 * attached; the shared store records the first one (with which of those files
 * were attached) and ignores the rest. Both payloads come from an untrusted
 * renderer and are checked before they are used.
 */
import { ipcMain } from 'electron'
import {
  reportGenerateRunStarted,
  takeGenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import { MINDMAP_CHANNELS } from '../shared/ipc'
import type { MindmapHandoff } from '../shared/ipc'

/** more attachments than a panel would ever hold are not a real report */
const MAX_REPORTED_PATHS = 256
const MAX_PATH_CHARS = 4096

export interface MindmapHandoffIpcOptions {
  /** whether the view was made for a file (such a view is not a new map and never takes) */
  opensFile(webContentsId: number): boolean
}

/** The paths of a run-started report, or null when the report is not one. */
export function reportedPaths(report: unknown): { id: string; paths: string[] } | null {
  if (!report || typeof report !== 'object') return null
  const { id, attachedPaths } = report as { id?: unknown; attachedPaths?: unknown }
  if (typeof id !== 'string' || id === '' || !Array.isArray(attachedPaths)) return null
  const paths = attachedPaths
    .slice(0, MAX_REPORTED_PATHS)
    .filter((p): p is string => typeof p === 'string' && p !== '' && p.length <= MAX_PATH_CHARS)
  return paths.length > 0 ? { id, paths } : null
}

/** Registers `mindmap:handoff-take` and `mindmap:handoff-run-started`. Called once, with the editor's other channels. */
export function registerMindmapHandoffIpc(options: MindmapHandoffIpcOptions): void {
  /** the request each view took, by webContents id: a report must name it. One short entry per
      press of "make" at most, dropped at the recorded run (the shared store drops its own copy
      when the tab closes, so a stale entry here can never record anything). */
  const takenIdByWc = new Map<number, string>()

  ipcMain.handle(MINDMAP_CHANNELS.handoffTake, (e): MindmapHandoff | null => {
    const wcId = e.sender.id
    if (options.opensFile(wcId)) return null
    const handoff = takeGenerateHandoff('mindmap', wcId)
    if (!handoff) return null
    takenIdByWc.set(wcId, handoff.id)
    return {
      id: handoff.id,
      sourcePaths: handoff.materials.map((m) => m.path),
      prompt: handoff.text,
    }
  })

  ipcMain.on(MINDMAP_CHANNELS.handoffRunStarted, (e, report: unknown) => {
    const wcId = e.sender.id
    const reported = reportedPaths(report)
    if (!reported || takenIdByWc.get(wcId) !== reported.id) return
    // the store keeps the first run with at least one handed-over file attached
    if (reportGenerateRunStarted('mindmap', wcId, reported.paths)) takenIdByWc.delete(wcId)
  })
}
