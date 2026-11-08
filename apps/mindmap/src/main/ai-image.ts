/**
 * Image search/generation for the mind map's AI panel: the two channels the
 * renderer calls to bring a picture into the map file.
 *
 * The bytes are the renderer's business (it puts them into the document as a
 * new entry); this side only reaches the network. `generateImageTool` is the
 * same tool the other editors use, with the statuses of the process-wide
 * subscription service, and `fetchImageBytes` reads a web address or the file
 * the generator wrote into its own store — the generated-image store is the
 * only `file://` it answers.
 *
 * The channels are this editor's own (`mindmap:`); the shared `ai:*` and
 * subscription channels belong to the docs main and are never registered here.
 */
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { documentMediaRoots, generateImageTool, withMediaCallSignal } from '@genoffice/ai-search'
import { sharedSubscriptionStatuses } from '@genoffice/ai-provider/subscription'
import { fetchImageBytes } from '@genoffice/electron-utils/fetch-image-bytes'
import { MINDMAP_CHANNELS } from '../shared/ipc'

export interface MindmapImageIpcOptions {
  /** the map file this view has open, for the media roots; null while it has none */
  filePathOf(webContentsId: number): string | null
  /** where a pasted picture waits (the same folder the attachment reader uses) */
  pastedImageDir: string
}

const SETTINGS_PATH = (): string => join(app.getPath('userData'), 'ai-settings.json')

/** Registers the two picture channels. Called once, with the editor's other channels. */
export function registerMindmapImageIpc(options: MindmapImageIpcOptions): void {
  ipcMain.handle(
    MINDMAP_CHANNELS.aiGenerateImage,
    (e, op: { prompt?: unknown; aspectRatio?: unknown }) =>
      // ends with its tab, or when the tab's AI run is stopped
      withMediaCallSignal(e.sender, (signal) =>
        generateImageTool(
          SETTINGS_PATH(),
          {
            prompt: String(op?.prompt ?? ''),
            aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
          },
          {
            mediaRoots: documentMediaRoots(options.filePathOf(e.sender.id), options.pastedImageDir),
            // screen path: the statuses of the process-wide subscription service decide the route
            context: { path: 'screen', statuses: sharedSubscriptionStatuses() },
            signal,
          },
        ),
      ),
  )

  ipcMain.handle(MINDMAP_CHANNELS.fetchImage, (_e, url: unknown) => fetchImageBytes(url))
}
