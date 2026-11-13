/**
 * The page of `--measure-dialog` (crates/shell/src/measure.rs) loads this in
 * place of a preload: the same bridge as every surface, with the
 * `ipcRenderer` handed to the test page, so its round trips run through the
 * real frames.
 */
import { contextBridge, ipcRenderer } from './electron-entry'

contextBridge.exposeInMainWorld('measureIpc', {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  sendSync: (channel: string, ...args: unknown[]): unknown =>
    ipcRenderer.sendSync(channel, ...args),
})
