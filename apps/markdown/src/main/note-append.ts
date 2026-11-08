/**
 * "Add to note" from the PDF editor (reading-assist spec 4.9): the shell
 * opens or brings forward the Markdown tab of a PDF's note and queues text
 * for that tab's webContents, then nudges it. The renderer takes the queue
 * once it is ready and puts the text at the END of its editor document,
 * marking it changed. Nothing here writes the note file: saving stays with
 * the person in the note tab (the editor does not re-read its file, so a
 * direct write would split the tab from the disk).
 *
 * Only the tab showing that very note file takes the text; an untitled tab,
 * a tab showing another file, a reload after the take or a tab that closed
 * first gets nothing. Modeled on seed-main.ts, for an existing file tab.
 */
import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import { MARKDOWN_CHANNELS } from '../shared/ipc'

/** the webContents calls this module makes */
export interface NoteAppendContents {
  readonly id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string): void
}

/** queued texts by webContents id, for one note path */
const pending = new Map<number, { path: string; texts: string[] }>()
const watched = new Set<number>()

function samePath(a: string, b: string): boolean {
  const key = (p: string) => {
    const full = resolve(p)
    return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
  }
  return key(a) === key(b)
}

/** queue text for the tab showing `notePath` and nudge its renderer */
export function queueMarkdownNoteAppendFor(
  contents: NoteAppendContents,
  notePath: string,
  text: string,
): void {
  if (contents.isDestroyed()) return
  const id = contents.id
  const entry = pending.get(id)
  if (entry && samePath(entry.path, notePath)) entry.texts.push(text)
  else pending.set(id, { path: notePath, texts: [text] })
  if (!watched.has(id)) {
    watched.add(id)
    contents.once('destroyed', () => {
      pending.delete(id)
      watched.delete(id)
    })
  }
  contents.send(MARKDOWN_CHANNELS.noteAppendReady)
}

/** the texts queued for this view, once, while it shows the note they were queued for */
export function takeMarkdownNoteAppend(
  webContentsId: number,
  documentPath: string | null,
): string[] {
  const entry = pending.get(webContentsId)
  if (!entry || !documentPath || !samePath(entry.path, documentPath)) return []
  pending.delete(webContentsId)
  return entry.texts
}

export interface MarkdownNoteAppendIpcOptions {
  /** the file the view shows now; null for an untitled document */
  documentPath(webContentsId: number): string | null
}

/** Registers `markdown:note-append-take`. Called once, with the editor's other channels. */
export function registerMarkdownNoteAppendIpc(options: MarkdownNoteAppendIpcOptions): void {
  ipcMain.handle(MARKDOWN_CHANNELS.noteAppendTake, (e): string[] =>
    takeMarkdownNoteAppend(e.sender.id, options.documentPath(e.sender.id)),
  )
}
