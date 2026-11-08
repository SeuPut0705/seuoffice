/// Where the design templates' shared font set lives (the data list is
/// @genoffice/ui/template-fonts). The files ship once, as
/// resources/template-fonts beside the editor modules
/// (apps/shell/electron-builder.cjs); a dev run reads the checkout's folder.
/// No fs, no Electron: callers pass the app facts in, so code without
/// Electron (the CLI bundle) can resolve the same folder from its own
/// resources directory or repo root with the two constants.
import { join, resolve } from 'node:path'

/** the folder's name under the packaged app's resources */
export const TEMPLATE_FONTS_DIR_NAME = 'template-fonts'

/** the folder in the checkout, relative to the repo root */
export const TEMPLATE_FONTS_REPO_DIR = 'packages/ui/template-fonts'

/** the subset of Electron's `app` (plus `process.resourcesPath`) needed here */
export interface TemplateFontsHost {
  readonly isPackaged: boolean
  getAppPath(): string
  readonly resourcesPath: string
}

/**
 * The template font folder: `<resources>/template-fonts` in the installed app; in a
 * dev run the checkout's folder, found from the app path (`apps/<app>`, two levels
 * below the repo root, for the shell and every editor alike).
 */
export function templateFontsDir(host: TemplateFontsHost): string {
  if (host.isPackaged) return join(host.resourcesPath, TEMPLATE_FONTS_DIR_NAME)
  return resolve(host.getAppPath(), '..', '..', TEMPLATE_FONTS_REPO_DIR)
}
