/**
 * The displays and windows of the fake desktop the slides cases run on, the
 * TypeScript half of `FakeShell` in crates/shell-ipc/d1/src/slides/fake.rs: one
 * display, or two with `hosts.d1.slides.externalDisplay` (the second at x = 1920);
 * the audience window the presenter view opens is window and view 100; what the
 * presenter code asks of a window is logged as the Rust fake logs what its
 * `SlidesShell` is asked:
 *
 * - `new BrowserWindow(bounds)` of the audience: `["BrowserWindow.audience", displayId]`
 * - `setBounds` + `setSimpleFullScreen(true)` on it: `["fullScreenOnDisplay", window, displayId]`
 * - `setBounds` on the presenter window: `["movePresenterWindow", window, displayId]`
 * - `setSimpleFullScreen(on)` otherwise: `["showFullscreenWindow", window, on]`
 * - `close()` of the audience: `["closeAudienceWindow", window]`
 */
import type { LoadContext } from '../types.ts'

type Electron = LoadContext['electron']
type Fn = (...args: unknown[]) => unknown

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
interface Display {
  id: number
  bounds: Rect
  workArea: Rect
}

const AUDIENCE = 100

export function makeDesktop(e: Electron, external: boolean) {
  const rect = (x: number): Rect => ({ x, y: 0, width: 1920, height: 1080 })
  const displays: Display[] = [{ id: 1, bounds: rect(0), workArea: rect(0) }]
  if (external) displays.push({ id: 2, bounds: rect(1920), workArea: rect(1920) })
  const displayAt = (bounds: Rect): Display =>
    (bounds.x >= 1920 ? displays[1] : undefined) ?? displays[0]

  /** the state and the logging calls every fake window has */
  const dress = <W extends Record<string, unknown>>(win: W, id: number): W => {
    let simple = false
    let bounds = rect(id >= AUDIENCE ? 1920 : 0)
    let moved = false
    const listeners = new Map<string, Fn[]>()
    return Object.assign(win, {
      isFullScreen: () => false,
      isSimpleFullScreen: () => simple,
      setFullScreenable: () => {},
      setFullScreen: () => {},
      getBounds: () => bounds,
      setBounds: (next: Rect) => {
        bounds = next
        if (id < AUDIENCE) e.log.push(['movePresenterWindow', id, displayAt(next).id])
        else moved = true
      },
      setSimpleFullScreen: (on: boolean) => {
        simple = on
        if (id >= AUDIENCE && on && moved) {
          moved = false
          e.log.push(['fullScreenOnDisplay', id, displayAt(bounds).id])
        } else if (id < AUDIENCE) e.log.push(['showFullscreenWindow', id, on])
      },
      setTitle: () => {},
      show: () => {},
      focus: () => {},
      loadURL: async () => {},
      on: (name: string, fn: Fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
      once: (name: string, fn: Fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
      close: () => {
        if (id < AUDIENCE) return e.log.push(['BrowserWindow.close', id])
        e.log.push(['closeAudienceWindow', id])
        for (const fn of listeners.get('closed') ?? []) setImmediate(fn)
      },
    })
  }

  const real = e.BrowserWindow as Record<string, Fn>
  // the case's own windows answer what the presenter code asks of them
  const decorated = new Set<unknown>()
  const own = (win: unknown) => {
    if (win && !decorated.has(win)) {
      decorated.add(win)
      dress(win as Record<string, unknown>, (win as { id: number }).id)
    }
    return win
  }
  class FakeBrowserWindow {
    static getAllWindows = () => (real.getAllWindows() as unknown[]).map(own)
    static fromWebContents = (wc: unknown) => own(real.fromWebContents(wc))
    static fromId = (id: number) => own(real.fromId(id))
    static getFocusedWindow = () => null
    id = AUDIENCE
    webContents = e.contents(AUDIENCE)
    constructor(options: Rect) {
      e.log.push(['BrowserWindow.audience', displayAt(options).id])
      dress(this as unknown as Record<string, unknown>, AUDIENCE)
    }
    isDestroyed = () => false
  }

  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (bounds: Rect) => displayAt(bounds),
  }
  return { BrowserWindow: FakeBrowserWindow, screen }
}
