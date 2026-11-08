/**
 * The shell's half of the note of each PDF (reading-assist spec 4.9): the pdf
 * main process resolved a note path (a save-dialog pick or a note-links.json
 * entry) and asks to open it, or to put text at its end. The note's Markdown
 * tab (or detached window) is brought forward, else the file opens in a new
 * Markdown tab; the text is queued for that tab's webContents and taken by
 * its renderer, which appends it to the editor as an unsaved change. The
 * shell never writes the note file.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  queueMarkdownNoteAppendFor,
  type NoteAppendContents,
} from '../../../markdown/src/main/note-append'

export interface NoteTabHost {
  /** the Markdown tab or detached window showing this file, brought forward; undefined when none */
  focusExisting(path: string): NoteAppendContents | undefined
  /** open the file in a new Markdown tab; its webContents (undefined without a window) */
  openNew(path: string): NoteAppendContents | undefined
}

/** an absolute path of an existing .md file (checked again here, whatever the caller said) */
export function isNoteFile(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !/\.md$/i.test(path)) return false
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** bring the note's tab forward or open it; its webContents, null when it cannot be shown */
export function openNoteTab(host: NoteTabHost, path: string): NoteAppendContents | null {
  if (!isNoteFile(path)) return null
  return host.focusExisting(path) ?? host.openNew(path) ?? null
}

/** show the note's tab and hand it `text` to append at the end of its document */
export function insertIntoNoteTab(
  host: NoteTabHost,
  path: string,
  text: string,
  queue: (
    contents: NoteAppendContents,
    path: string,
    text: string,
  ) => void = queueMarkdownNoteAppendFor,
): boolean {
  if (typeof text !== 'string' || !text.trim()) return false
  const contents = openNoteTab(host, path)
  if (!contents || contents.isDestroyed()) return false
  queue(contents, path, text)
  return true
}
