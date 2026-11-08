/**
 * The PPT editor's end of the generate hand-off (spec 8.5). The shell's "make"
 * window opens a new untitled slides tab and leaves a request for that tab's
 * webContents in the shared queue; the tab's renderer takes it here, once, and
 * reports here when a run started in the tab with a handed-over material
 * attached.
 *
 * Nothing in this file starts a run or reads a material: the renderer attaches
 * the materials through the ordinary attachment check (`slides:files-add`),
 * their text is only ever read through `slides:files-read` (unsaved files
 * refused), and the run goes through the panel's send gate with the provider
 * chosen as usual.
 *
 * Registered from `registerSlidesIpc`, so it also runs inside the shell (the
 * queue module keeps one store across bundled copies).
 */
import { ipcMain } from 'electron'
import {
  reportGenerateRunStarted,
  takeGenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import type { SlidesApi } from '../shared/ipc'

/** invoke → the request left for this tab, or null (none, already taken, another kind) */
export const SLIDES_HANDOFF_TAKE = 'slides:handoff-take'
/** invoke(attachedPaths) → true when this run was recorded as the hand-off's start */
export const SLIDES_HANDOFF_RUN_STARTED = 'slides:handoff-run-started'

/** what the renderer gets: the request text and the materials, nothing else */
type TakenHandoff = Awaited<ReturnType<NonNullable<SlidesApi['takeGenerateHandoff']>>>

/** a run carries at most this many attachment paths in one report */
const MAX_REPORTED_PATHS = 200

export function registerGenerateHandoffIpc(): void {
  ipcMain.handle(SLIDES_HANDOFF_TAKE, (e): TakenHandoff => {
    const handoff = takeGenerateHandoff('slides', e.sender.id)
    if (!handoff) return null
    return {
      id: handoff.id,
      text: handoff.text,
      materials: handoff.materials.map((m) => ({ path: m.path, name: m.name })),
    }
  })

  ipcMain.handle(SLIDES_HANDOFF_RUN_STARTED, (e, attachedPaths: unknown): boolean => {
    if (!Array.isArray(attachedPaths)) return false
    const paths = attachedPaths
      .slice(0, MAX_REPORTED_PATHS)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length === 0) return false
    return reportGenerateRunStarted('slides', e.sender.id, paths) !== null
  })
}
