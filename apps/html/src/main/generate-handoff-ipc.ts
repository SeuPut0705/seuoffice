import {
  reportGenerateRunStarted,
  takeGenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import { HTML_HANDOFF_CHANNELS } from '../shared/ipc'
import type { HtmlGenerateHandoff } from '../shared/ipc'

/**
 * The HTML editor's side of the generate hand-off (8.5). The shell queues a
 * request for a new untitled tab; the panel in that tab takes it here, once,
 * and reports when a run started with handed-over material attached. Nothing
 * here starts a run or picks a provider: the panel sends through its own gate.
 *
 * No Electron value import, so the tests drive it with a stand-in for ipcMain.
 */

type HandoffEvent = { sender: { id: number } }

/** the part of ipcMain this module needs */
export interface HandoffIpc {
  handle(channel: string, handler: (event: HandoffEvent, ...args: unknown[]) => unknown): void
}

/**
 * Register `html:handoff-take` and `html:handoff-run-started`. `openedOnFile`
 * tells whether a view was opened on an existing file: such a tab never takes.
 */
export function registerHtmlHandoffIpc(
  ipc: HandoffIpc,
  openedOnFile: (webContentsId: number) => boolean,
): void {
  ipc.handle(HTML_HANDOFF_CHANNELS.take, (event): HtmlGenerateHandoff | null => {
    const id = event.sender.id
    if (openedOnFile(id)) return null
    const handoff = takeGenerateHandoff('html', id)
    if (!handoff) return null
    return {
      id: handoff.id,
      text: handoff.text,
      materials: handoff.materials.map((m) => ({ path: m.path, name: m.name })),
    }
  })

  ipc.handle(HTML_HANDOFF_CHANNELS.runStarted, (event, attachedPaths): boolean => {
    if (!Array.isArray(attachedPaths)) return false
    const paths = attachedPaths.filter((p): p is string => typeof p === 'string')
    return reportGenerateRunStarted('html', event.sender.id, paths) !== null
  })
}
