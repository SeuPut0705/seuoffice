/**
 * The shell's side of the provenance records (spec 9) and of the editors'
 * File-menu entry "make another document from this one" (spec 8.2): one
 * record store for the app, fed by the editors' save hooks, the in-app
 * rename/move notification and the hand-off store's events; the File-menu
 * entries every editor shows; the make window opened for one document.
 *
 * index.ts supplies how to find tabs, windows and menus (`configureDocumentLinks`).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import type { TabKind } from '../shared/tabs-api'
import { openGenerateWindowForDocument } from './generate/generate-window'
import {
  DOCUMENT_LINKS_FILE,
  documentLinkMenuModel,
  documentLinksAt,
  isFreshlySavedPath,
  watchMakeEvents,
  type DocumentLinks,
} from './document-links'
import { documentLinkMenuItems, type DocumentLinkMenuLabels } from './document-links-menu'

/** an open document as a menu or the make window sees it */
export interface LinkedDocument {
  webContents: WebContents
  filePath?: string
  /** the tab or window title; what the make window lists an unsaved document as */
  title: string
}

export interface DocumentLinksShellDeps {
  userDataPath(): string
  /** the document a kind's File menu acts on (the focused detached window of that kind, else the active tab of that kind) */
  activeDocument(kind: TabKind): LinkedDocument | undefined
  /** the document behind a webContents, in a tab or a detached window */
  documentFor(webContents: WebContents): LinkedDocument | undefined
  /** the window the make window sits above */
  parentFor(webContents: WebContents): BrowserWindow | null
  /** the usual path → tab route */
  openPath(path: string): void
  labels(): DocumentLinkMenuLabels
  /** the shell tab id behind a webContents, for the hand-off store */
  tabIdFor(webContentsId: number): string | undefined
  /** the kind whose menu is the application menu now */
  menuKind(): TabKind | undefined
  /** build that kind's menu again */
  applyMenu(kind: TabKind): void
}

const EDITOR_KINDS: ReadonlySet<TabKind> = new Set([
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
  'mindmap',
])

let deps: DocumentLinksShellDeps | null = null
let links: DocumentLinks | null = null
/** what the last built File menu showed: rebuilt only when this changes */
let shownSignature = ''

export function configureDocumentLinks(next: DocumentLinksShellDeps): void {
  deps = next
  links = documentLinksAt(join(next.userDataPath(), DOCUMENT_LINKS_FILE))
  watchMakeEvents(next.tabIdFor, () => links?.sync())
  links.onChange(() => refreshDocumentLinkMenu())
  refreshDocumentLinkMenu()
}

/** the app's record store, once configured */
export function documentLinks(): DocumentLinks | null {
  return links
}

/**
 * An editor's save hook: the tab's document landed on a path (first save or
 * Save As). Only a tab's first path can carry a record. `mayBeOpen` is for a
 * hook that also fires when an existing file is opened into the tab (slides):
 * such a path counts only when it is a save happening now.
 */
export function noteDocumentSaved(
  contents: WebContents,
  path: string,
  options?: { mayBeOpen?: boolean },
): void {
  if (!links || contents.isDestroyed()) return
  const fresh = options?.mayBeOpen ? isFreshlySavedPath(path, Date.now()) : true
  links.noteTabPath(contents, path, { fresh })
}

/** the in-app rename/move notification */
export function documentLinkFileMoved(oldPath: string, newPath: string): void {
  links?.fileMoved(oldPath, newPath)
}

/** every path the records mention, for folder moves */
export function documentLinkPaths(): string[] {
  return links?.paths() ?? []
}

/** a run start or conversion may be waiting for a save that already happened */
export function syncDocumentLinks(): void {
  links?.sync()
}

function signature(kind: TabKind, doc: LinkedDocument | undefined): string {
  if (!doc || !links) return `${kind}|`
  return `${kind}|${doc.webContents.id}|${doc.filePath ?? ''}|${links.version}`
}

/** "make another document from this one" for the document behind this webContents */
export function makeFromDocument(contents: WebContents): void {
  const d = deps
  if (!d || contents.isDestroyed()) return
  const doc = d.documentFor(contents)
  if (!doc) return
  openGenerateWindowForDocument({
    webContentsId: contents.id,
    ...(doc.filePath ? { filePath: doc.filePath } : {}),
    title: doc.title,
    parent: d.parentFor(contents),
  })
}

/** the File-menu entries for the open document of this kind, led by a separator */
export function documentLinkFileMenuItems(kind: TabKind): MenuItemConstructorOptions[] {
  const d = deps
  if (!d || !links) return []
  const doc = d.activeDocument(kind)
  shownSignature = signature(kind, doc)
  if (!doc) return []
  const contents = doc.webContents
  return documentLinkMenuItems({
    model: documentLinkMenuModel(doc.filePath, links, existsSync),
    labels: d.labels(),
    isMac: process.platform === 'darwin',
    onMake: () => makeFromDocument(contents),
    onOpen: (path) => openListedFile(d, path),
  })
}

/**
 * A listed file was picked. Presence is checked when the menu is built, so a
 * file deleted since then can still be picked: it is then not opened, and the
 * menu is built again to show it dimmed.
 */
function openListedFile(d: DocumentLinksShellDeps, path: string): void {
  if (existsSync(path)) {
    d.openPath(path)
    return
  }
  shownSignature = ''
  refreshDocumentLinkMenu()
}

/**
 * Rebuild the application menu when what its File-menu entries would show
 * changed: another document, a new path, or other records.
 */
export function refreshDocumentLinkMenu(): void {
  const d = deps
  if (!d) return
  const kind = d.menuKind()
  if (!kind || !EDITOR_KINDS.has(kind)) return
  if (signature(kind, d.activeDocument(kind)) === shownSignature) return
  d.applyMenu(kind)
}
