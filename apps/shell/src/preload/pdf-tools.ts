import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  PdfBlankPagesResult,
  PdfPickResult,
  PdfToolRunRequest,
  PdfToolRunResult,
  PdfToolsInit,
  PdfToolsStart,
  PdfToolsTheme,
  PdfToolsWindowApi,
} from '../shared/pdf-tools-api'
import { PDF_TOOLS_CHANNELS } from '../shared/pdf-tools-api'

function themeOf(value: unknown): PdfToolsTheme {
  return value === 'light' || value === 'dark' ? value : 'system'
}

// The PDF tools window's narrow API: pick inputs through main's dialog, run a
// tool, open or reveal what it wrote, and the theme broadcast every window
// receives. Paths never cross into the page; it only sees ids and names.
const api: PdfToolsWindowApi = {
  async getInit() {
    const init = (await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.getInit)) as PdfToolsInit | null
    return { lang: init?.lang ?? 'en', theme: themeOf(init?.theme) }
  },
  onThemeChanged(handler) {
    const listener = (_event: IpcRendererEvent, theme: unknown) => handler(themeOf(theme))
    ipcRenderer.on('app:theme-changed', listener)
    return () => ipcRenderer.removeListener('app:theme-changed', listener)
  },
  async pickInputs(multi: boolean, kind = 'pdf', accept = 'pdf') {
    const result = (await ipcRenderer.invoke(
      PDF_TOOLS_CHANNELS.pickInputs,
      multi,
      kind,
      accept,
    )) as PdfPickResult | undefined
    return result ?? { inputs: [], rejected: [] }
  },
  async run(request: PdfToolRunRequest) {
    const result = (await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.run, request)) as
      PdfToolRunResult | undefined
    return result ?? { ok: false, error: 'failed' }
  },
  async openResult(id: string) {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.openResult, id)
  },
  async revealResult(id: string) {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.revealResult, id)
  },
  async openInEditor() {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.openInEditor)
  },
  async findBlankPages(inputId: string) {
    const result = (await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.findBlankPages, inputId)) as
      PdfBlankPagesResult | undefined
    return result ?? { ok: false, error: 'failed' }
  },
  async cancelRun() {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.cancelRun)
  },
  async cancelFind() {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.cancelFind)
  },
  onProgress(handler) {
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      const v = (value ?? {}) as { done?: unknown; total?: unknown }
      if (typeof v.done === 'number' && typeof v.total === 'number') handler(v.done, v.total)
    }
    ipcRenderer.on(PDF_TOOLS_CHANNELS.progress, listener)
    return () => ipcRenderer.removeListener(PDF_TOOLS_CHANNELS.progress, listener)
  },
  async takeStart() {
    const start = (await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.takeStart)) as PdfToolsStart | null
    return start ?? null
  },
  onStartReady(handler) {
    const listener = () => handler()
    ipcRenderer.on(PDF_TOOLS_CHANNELS.startReady, listener)
    return () => ipcRenderer.removeListener(PDF_TOOLS_CHANNELS.startReady, listener)
  },
  async close() {
    await ipcRenderer.invoke(PDF_TOOLS_CHANNELS.close)
  },
}

contextBridge.exposeInMainWorld('aiOfficePdfTools', api)
