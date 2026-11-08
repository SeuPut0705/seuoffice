import { webContents } from 'electron'

import { execFileRunner, parseRegValue } from './default-app'

/**
 * The size of the system mouse pointer, for renderers that place things next
 * to it (the shared ScreenTip keeps clear of the pointer's picture).
 *
 * Windows keeps it as `CursorBaseSize` (32 by default, up to 256 when
 * "Mouse pointer size" is raised). Cursors scale with the display, so the
 * stored value is already the size in CSS pixels. macOS and Linux have no
 * setting read here; renderers fall back to the standard size.
 */

export const POINTER_SIZE_VAR = '--os-pointer-size'

const CURSORS_KEY = 'HKCU\\Control Panel\\Cursors'
const MIN_PX = 16
const MAX_PX = 512

/** `CursorBaseSize    REG_DWORD    0x40` → 64. Anything implausible is null. */
export function parseCursorBaseSize(output: string): number | null {
  const value = parseRegValue(output)
  if (!value) return null
  const px = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value)
  return Number.isInteger(px) && px >= MIN_PX && px <= MAX_PX ? px : null
}

export async function readPointerSize(
  run: (cmd: string, args: string[]) => Promise<string> = execFileRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (platform !== 'win32') return null
  try {
    return parseCursorBaseSize(await run('reg', ['query', CURSORS_KEY, '/v', 'CursorBaseSize']))
  } catch {
    // no such value on this machine: the standard pointer
    return null
  }
}

/** Inline on `documentElement`, as the interface scale is (see ui-scale.ts). */
export function applyPointerSizeTo(contents: Electron.WebContents, px: number): void {
  if (contents.isDestroyed()) return
  void contents
    .executeJavaScript(
      `document.documentElement.style.setProperty('${POINTER_SIZE_VAR}', '${px}px')`,
    )
    .catch(() => {
      // A renderer torn down mid-call has nothing left to style.
    })
}

let current: number | null = null

/** Every window gets the size on load; the shell re-reads it when it regains focus. */
export function installPointerSize(app: Electron.App): void {
  const refresh = async (): Promise<void> => {
    const px = await readPointerSize()
    if (px === current) return
    current = px
    if (px === null) return
    for (const contents of webContents.getAllWebContents()) applyPointerSizeTo(contents, px)
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
      if (current !== null) applyPointerSizeTo(contents, current)
    })
  })
  // Settings changes the size while the app runs; coming back to the app is the
  // moment the reader looks at a tip again.
  app.on('browser-window-focus', () => void refresh())
  void refresh()
}
