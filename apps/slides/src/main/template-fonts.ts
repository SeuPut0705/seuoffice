/**
 * The design templates' shared font set, wired to Electron: where the one shipped copy sits
 * (templateFontsDir), handing it to the font registry, and the "open fonts folder" channel.
 * The files are only read; nothing here copies, installs or downloads a font.
 */
import { app, ipcMain, shell } from 'electron'
import { templateFontsDir } from '@genoffice/electron-utils/template-fonts-dir'
import { setTemplateFontDir } from './fonts'

export function templateFontFolder(): string {
  return templateFontsDir({
    isPackaged: app.isPackaged,
    getAppPath: () => app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

/** Wire the folder into the font registry; call once at startup (resolved on first lookup). */
export function initTemplateFonts(): void {
  setTemplateFontDir(templateFontFolder)
}

/** Open the folder in Explorer; false when the OS could not open it. Takes no path from the renderer. */
export async function openTemplateFontsFolder(): Promise<boolean> {
  try {
    return (await shell.openPath(templateFontFolder())) === ''
  } catch {
    return false
  }
}

/** Register slides:open-template-fonts-folder (called from registerSlidesIpc, which the shell runs too). */
export function registerTemplateFontsIpc(): void {
  ipcMain.handle('slides:open-template-fonts-folder', () => openTemplateFontsFolder())
}
