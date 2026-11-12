/**
 * The shell's answer to every page that asks the system for something (the
 * microphone, the clipboard, full screen...): which addresses are the app's
 * own pages in this run. The decision itself is the shared guard's.
 */
import { app, session } from 'electron'
import { installPermissionGuard } from '../../../../packages/electron-utils/src/permission-guard'

/**
 * The dev server each editor's runtime is configured with (index.ts), by
 * renderer host. The diagram editor is not here: its tab lives in a session of
 * its own, with its own answers (diagram-session.ts).
 */
const DEV_URL_ENV = {
  shell: 'ELECTRON_RENDERER_URL',
  docs: 'DOCS_RENDERER_URL',
  sheets: 'SHEETS_RENDERER_URL',
  slides: 'SLIDES_RENDERER_URL',
  pdf: 'PDF_RENDERER_URL',
  markdown: 'MARKDOWN_RENDERER_URL',
  html: 'HTML_RENDERER_URL',
  mindmap: 'MINDMAP_RENDERER_URL',
  hwp: 'HWP_RENDERER_URL',
  epub: 'EPUB_RENDERER_URL',
} as const

export interface ShellPermissionGuardOptions {
  /** true while the slides editor in that webContents records narration */
  microphoneOpen: (webContentsId: number) => boolean
  /** the folder the shell's own windows are loaded from (`out/renderer`) */
  rendererDir: string
  env?: Readonly<Record<string, string | undefined>>
}

/** Call before app ready: every session, the default one included, is guarded from its creation. */
export function installShellPermissionGuard(options: ShellPermissionGuardOptions): void {
  const env = options.env ?? process.env
  installPermissionGuard(app, session, {
    pages: {
      devUrls: Object.fromEntries(
        Object.entries(DEV_URL_ENV).map(([page, name]) => [page, env[name]]),
      ),
      fileRoots: { shell: options.rendererDir },
    },
    microphoneOpen: options.microphoneOpen,
  })
}
