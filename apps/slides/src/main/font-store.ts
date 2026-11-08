/** The install half of the font store, wired to Electron. */
import { join } from 'node:path'
import { app } from 'electron'
import {
  installLocalFontFiles as installIntoStore,
  type FontStoreEnv,
} from '@genoffice/electron-utils/font-store'
import { fontFileFamilies, setUserFontDir } from './fonts'

export function fontStoreDir(): string {
  return join(app.getPath('userData'), 'fonts')
}

/** Wire the store dir into the font registry; call once at startup. */
export function initFontStore(): void {
  setUserFontDir(fontStoreDir())
}

/** The store, described to the shared module in this app's terms. */
function storeEnv(): FontStoreEnv {
  return {
    dir: fontStoreDir(),
    fontFileFamilies,
  }
}

export function installLocalFontFiles(paths: string[]): string[] {
  return installIntoStore(storeEnv(), paths)
}
