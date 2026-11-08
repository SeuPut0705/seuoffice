/// The editors' preloads expose the same three Drive calls (decision 0033).
/// Answers cross contextBridge as plain data; the AI skill in the renderer
/// checks their shape before use.
import { ipcRenderer } from 'electron'
import { DRIVE_AI_CHANNELS, driveAiOn, driveConnectedOf } from './drive-ai-channels'

export interface DriveAiBridge {
  driveAiEnabled(): Promise<boolean>
  driveSearch(query: string, limit: number): Promise<unknown>
  driveRead(fileId: string, offset: number): Promise<unknown>
  /** called with the new answer of driveAiEnabled whenever the Drive state changes */
  onDriveAiChanged(listener: (on: boolean) => void): () => void
  /** Drive is connected: the AI panel offers "Attach from Drive" */
  driveConnected(): Promise<boolean>
  onDriveConnectedChanged(listener: (connected: boolean) => void): () => void
  /** opens the attach-from-Drive window; resolves with the downloaded paths, or why not */
  drivePickAttachments(): Promise<unknown>
}

export function driveAiBridge(): DriveAiBridge {
  return {
    driveAiEnabled: async () =>
      (await ipcRenderer.invoke(DRIVE_AI_CHANNELS.enabled).catch(() => false)) === true,
    driveSearch: (query, limit) =>
      ipcRenderer.invoke(DRIVE_AI_CHANNELS.search, { q: String(query), limit: Number(limit) }),
    driveRead: (fileId, offset) =>
      ipcRenderer.invoke(DRIVE_AI_CHANNELS.read, { id: String(fileId), offset: Number(offset) }),
    onDriveAiChanged(listener) {
      const handler = (_event: unknown, state: unknown) => listener(driveAiOn(state))
      ipcRenderer.on(DRIVE_AI_CHANNELS.changed, handler)
      return () => {
        ipcRenderer.removeListener(DRIVE_AI_CHANNELS.changed, handler)
      }
    },
    driveConnected: async () =>
      (await ipcRenderer.invoke(DRIVE_AI_CHANNELS.connected).catch(() => false)) === true,
    onDriveConnectedChanged(listener) {
      const handler = (_event: unknown, state: unknown) => listener(driveConnectedOf(state))
      ipcRenderer.on(DRIVE_AI_CHANNELS.changed, handler)
      return () => {
        ipcRenderer.removeListener(DRIVE_AI_CHANNELS.changed, handler)
      }
    },
    drivePickAttachments: () =>
      ipcRenderer.invoke(DRIVE_AI_CHANNELS.pickAttachments).catch(() => ({
        ok: false,
        reason: 'cancelled',
      })),
  }
}
