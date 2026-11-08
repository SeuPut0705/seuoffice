import type { IpcMain } from 'electron'
import { ResultStore } from '../../../../packages/pdf-structure/src/store'
import { RESULT_STORE_CHANNELS } from '../shared/result-store-api'

/**
 * Settings → General: size and delete-all of the PDF result store. The store
 * lives in `<userData>/pdf-store`; the terminal command writes the same folder.
 * Deleting only runs when the settings screen asks for it, after the user
 * confirmed there.
 */
export function registerResultStoreIpc(
  ipc: Pick<IpcMain, 'handle'>,
  userDataDir: () => string,
): void {
  // built per call: the user-data folder is only final once the app is ready
  const store = () => new ResultStore(userDataDir())
  ipc.handle(RESULT_STORE_CHANNELS.size, (): Promise<number> => store().size())
  ipc.handle(RESULT_STORE_CHANNELS.deleteAll, (): Promise<void> => store().deleteAll())
}
