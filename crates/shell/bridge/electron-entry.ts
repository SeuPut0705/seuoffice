/**
 * What the preloads import as `electron` (the stage 3 shell contract, section
 * 4): the bridge of `electron.ts` over the Tauri transport of `tauri.ts`,
 * built once per page. `preloads.mjs` bundles every preload with `electron`
 * aliased to this file.
 */
import { IpcRenderer, makeContextBridge, makeWebUtils } from './electron'
import { tauriTransport } from './tauri'

const transport = tauriTransport()

export const ipcRenderer = new IpcRenderer(transport)
export const contextBridge = makeContextBridge(window)
export const webUtils = makeWebUtils(transport, window)

let spellWarned = false
function noSpellEngine(): void {
  if (spellWarned) return
  spellWarned = true
  console.warn('[shell bridge] webFrame has no spell engine in the CEF shell yet')
}

/**
 * `webFrame` as the preloads use it. The zoom factor goes to the shell. The
 * spell engine (sheets' `nativeSpell`) is not reachable from a CEF page: the
 * words are all taken as spelled right until the shell answers it.
 */
export const webFrame = {
  setZoomFactor: (factor: number): void => transport.setZoomFactor(factor),
  getZoomFactor: (): number => transport.zoomFactor(),
  isWordMisspelled: (_word: string): boolean => {
    noSpellEngine()
    return false
  },
  getWordSuggestions: (_word: string): string[] => {
    noSpellEngine()
    return []
  },
}

export type { IpcRendererEvent } from './electron'
