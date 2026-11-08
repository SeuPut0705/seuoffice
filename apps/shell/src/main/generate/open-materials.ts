/**
 * The generate window's view of the open tabs: which tab holds a material,
 * saving that tab in place (8.4 "a button that saves it"), and following a
 * never-saved document until it gets a path.
 *
 * Saving reuses what each editor already offers the shell for a dialog-free
 * save of an open document: the docs / sheets / slides bridges' save to a
 * path (the same ones the in-app MCP server's save-and-close uses), and the
 * markdown / html / mind map editors' own Save. A tab whose format cannot be
 * written that way (a PDF, a legacy .doc / .ppt, a .csv sheet) is brought
 * forward instead, so the user saves it there with the editor's own flow.
 */
import { realpathSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { OpenDocumentTab } from '../../shared/tabs-api'

/** the part of an Electron webContents this module needs */
export interface MaterialContents {
  readonly id: number
  isDestroyed(): boolean
}

export interface OpenMaterialsDeps<C extends MaterialContents = MaterialContents> {
  /** every open document (shell tabs and detached windows), dirty state resolved */
  list(): Promise<OpenDocumentTab[]>
  webContentsFor(tabId: string): C | undefined
  /** bring a tab (and its window) forward */
  reveal(tabId: string): void
  save: {
    docs?: (webContentsId: number, path: string) => Promise<unknown>
    sheets?: (webContentsId: number, path: string) => Promise<unknown>
    slides?: (webContentsId: number, path: string) => Promise<unknown>
    markdown?: (contents: C) => Promise<boolean>
    html?: (contents: C) => Promise<boolean>
    mindmap?: (contents: C) => Promise<boolean>
  }
}

function pathKey(path: string): string {
  let resolved = resolve(path)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // moved or deleted: compare as resolved
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** formats each bridge writes; anything else is shown, not written */
const IN_PLACE_EXTS: Partial<Record<OpenDocumentTab['kind'], readonly string[]>> = {
  docs: ['docx'],
  sheets: ['xlsx'],
  slides: ['pptx'],
}

export function createOpenMaterials<C extends MaterialContents>(deps: OpenMaterialsDeps<C>) {
  const tabOfPath = async (path: string): Promise<OpenDocumentTab | undefined> => {
    const wanted = pathKey(path)
    return (await deps.list()).find((tab) => tab.filePath && pathKey(tab.filePath) === wanted)
  }

  const canSaveInPlace = (tab: OpenDocumentTab): boolean => {
    if (!tab.filePath) return false
    const ext = extname(tab.filePath).slice(1).toLowerCase()
    switch (tab.kind) {
      case 'docs':
      case 'sheets':
      case 'slides':
        return !!deps.save[tab.kind] && (IN_PLACE_EXTS[tab.kind] ?? []).includes(ext)
      case 'markdown':
      case 'html':
      case 'mindmap':
        return !!deps.save[tab.kind]
      default:
        return false
    }
  }

  const saveTab = async (tab: OpenDocumentTab, contents: C): Promise<boolean> => {
    const path = tab.filePath!
    switch (tab.kind) {
      case 'docs':
        await deps.save.docs!(contents.id, path)
        return true
      case 'sheets':
        await deps.save.sheets!(contents.id, path)
        return true
      case 'slides':
        await deps.save.slides!(contents.id, path)
        return true
      case 'markdown':
        return deps.save.markdown!(contents)
      case 'html':
        return deps.save.html!(contents)
      case 'mindmap':
        return deps.save.mindmap!(contents)
      default:
        return false
    }
  }

  return {
    async saveActionFor(path: string): Promise<'save' | 'show'> {
      const tab = await tabOfPath(path)
      return tab && canSaveInPlace(tab) ? 'save' : 'show'
    },

    async saveMaterial(path: string): Promise<'saved' | 'shown' | 'failed'> {
      const tab = await tabOfPath(path)
      // closed meanwhile, or already clean: nothing left to save
      if (!tab || !tab.dirty) return 'saved'
      const contents = deps.webContentsFor(tab.id)
      if (!contents || contents.isDestroyed()) return 'saved'
      if (!canSaveInPlace(tab)) {
        deps.reveal(tab.id)
        return 'shown'
      }
      try {
        return (await saveTab(tab, contents)) ? 'saved' : 'failed'
      } catch (error) {
        console.warn('[generate] saving a material failed:', error)
        return 'failed'
      }
    },

    async pathOfUntitled(webContentsId: number): Promise<string | null> {
      for (const tab of await deps.list()) {
        if (deps.webContentsFor(tab.id)?.id === webContentsId) return tab.filePath ?? null
      }
      return null
    },

    async showUntitled(webContentsId: number): Promise<void> {
      for (const tab of await deps.list()) {
        if (deps.webContentsFor(tab.id)?.id === webContentsId) {
          deps.reveal(tab.id)
          return
        }
      }
    },
  }
}
