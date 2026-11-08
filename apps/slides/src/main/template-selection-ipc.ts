/**
 * The remembered design template of each open deck, wired to Electron: the two
 * IPC calls the renderer makes, and the hooks the main process calls where it
 * gives a document another path. The renderer never passes a file path: which
 * document is meant comes from the calling window's session.
 *
 * Every function here is safe to call from a save path: none of them throws.
 */
import { app, ipcMain } from 'electron'
import {
  TEMPLATE_SELECTION_GET_CHANNEL,
  TEMPLATE_SELECTION_SET_CHANNEL,
  type TemplateSelection,
} from '../shared/template-selection'
import { sessions, type Session } from './session-state'
import { TemplateSelectionMemory } from './template-selection-store'

let memory: TemplateSelectionMemory | null = null

/** Created on first use: the shell settles the user-data folder before any window asks */
function templateSelectionMemory(): TemplateSelectionMemory {
  if (!memory) memory = new TemplateSelectionMemory(app.getPath('userData'))
  return memory
}

/** Run a hook without letting it break the save or rename it is called from */
function guarded(what: string, run: (memory: TemplateSelectionMemory) => void): void {
  try {
    run(templateSelectionMemory())
  } catch (err) {
    console.warn(`[slides] template selection: ${what} failed:`, err)
  }
}

/**
 * Registered from registerSlidesOnlyAiIpc so the channels exist inside the
 * shell too. A window with no document answers null.
 */
export function registerTemplateSelectionIpc(): void {
  ipcMain.handle(TEMPLATE_SELECTION_GET_CHANNEL, (event): TemplateSelection | null => {
    try {
      const session = sessions.get(event.sender.id)
      return session ? templateSelectionMemory().get(session) : null
    } catch {
      return null
    }
  })

  ipcMain.handle(
    TEMPLATE_SELECTION_SET_CHANNEL,
    (event, selection: unknown): TemplateSelection | null => {
      try {
        const session = sessions.get(event.sender.id)
        return session ? templateSelectionMemory().set(session, selection) : null
      } catch {
        return null
      }
    },
  )
}

/**
 * Call where a session is re-pointed to another file, once that file is
 * written: `fromPath` is the path it had ('' when it was never saved). The
 * record is written under `toPath`; the one under `fromPath` stays.
 */
export function followTemplateSelection(session: Session, fromPath: string, toPath: string): void {
  guarded('follow', (m) => m.follow(session, fromPath, toPath))
}

/** Call where a new session object replaces `previous` in its window: it starts with what the old one had. */
export function inheritTemplateSelection(
  previous: Session | undefined,
  replacement: Session,
): void {
  guarded('inherit', (m) => m.inherit(previous, replacement))
}

/** Shell notification: a file was renamed or moved inside the app. The record moves with it. */
export function moveSlidesTemplateSelection(oldPath: string, newPath: string): void {
  guarded('move', (m) => m.moved(oldPath, newPath))
}
