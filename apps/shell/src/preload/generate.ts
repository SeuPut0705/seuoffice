import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AiTargetKind, GenerateWindowApi, GenerateWindowState } from '../shared/generate-api'
import { GENERATE_CHANNELS } from '../shared/generate-api'

type Theme = 'light' | 'dark' | 'system'

function themeOf(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : 'system'
}

// The generate window's narrow API: its own state, its own actions, and the
// theme broadcast every window receives. Nothing else from the shell.
const api: GenerateWindowApi = {
  async getState() {
    const result: unknown = await ipcRenderer.invoke(GENERATE_CHANNELS.getState)
    return (result ?? null) as GenerateWindowState | null
  },
  onState(handler) {
    const listener = (_event: IpcRendererEvent, state: GenerateWindowState) => handler(state)
    ipcRenderer.on(GENERATE_CHANNELS.state, listener)
    return () => ipcRenderer.removeListener(GENERATE_CHANNELS.state, listener)
  },
  async getTheme() {
    return themeOf(await ipcRenderer.invoke(GENERATE_CHANNELS.getTheme))
  },
  onThemeChanged(handler) {
    const listener = (_event: IpcRendererEvent, theme: unknown) => handler(themeOf(theme))
    ipcRenderer.on('app:theme-changed', listener)
    return () => ipcRenderer.removeListener('app:theme-changed', listener)
  },
  async setKind(kind: AiTargetKind) {
    await ipcRenderer.invoke(GENERATE_CHANNELS.setKind, kind)
  },
  async setConvert(kind) {
    await ipcRenderer.invoke(GENERATE_CHANNELS.setConvert, kind)
  },
  async addMaterials() {
    await ipcRenderer.invoke(GENERATE_CHANNELS.addMaterials)
  },
  async removeMaterial(key) {
    await ipcRenderer.invoke(GENERATE_CHANNELS.removeMaterial, key)
  },
  async saveMaterial(key) {
    await ipcRenderer.invoke(GENERATE_CHANNELS.saveMaterial, key)
  },
  async refresh() {
    await ipcRenderer.invoke(GENERATE_CHANNELS.refresh)
  },
  async make(text) {
    return (await ipcRenderer.invoke(GENERATE_CHANNELS.make, text)) === true
  },
  async cancel() {
    await ipcRenderer.invoke(GENERATE_CHANNELS.cancel)
  },
}

contextBridge.exposeInMainWorld('aiOfficeGenerateWindow', api)
