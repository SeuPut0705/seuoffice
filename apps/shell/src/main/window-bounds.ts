/**
 * The shell window's geometry across sessions (issue genoffice#2049) — the
 * position and size the app reopens with.
 *
 * The state lives in userData/app-settings.json, the file the issue names,
 * under one key. What is stored is the window's CONTENT rectangle in its
 * normal state, with the maximized flag beside it, and the restore applies it
 * with `setContentBounds` after the window exists. The window's outer bounds
 * cannot make the round trip: on a scaled Windows display (measured at 125%
 * with the hidden title bar) the constructor makes the window a few DIPs
 * larger than asked (1200x800 comes out 1206x804), so saving the bounds and
 * handing them back to the constructor grew the window on every start.
 *
 * Two more rules keep the round trip exact:
 * - The content rectangle of a maximized, minimized or fullscreen window is
 *   not its normal one, so the normal rectangle is remembered while the
 *   window is normal, and that is what a save writes. A window that never
 *   was normal in a session writes back the rectangle it was restored with,
 *   so the stored rectangle never becomes a screen-sized one.
 * - `setContentBounds` is not exact either when the left edge falls between
 *   device pixels (1217 wide at x 837 reads back 1218 wide at x 838 on a 125%
 *   display). The restore therefore reads the content rectangle back right
 *   after applying it (the baseline), and a save writes the rectangle from
 *   the settings unchanged for as long as the window still reports that
 *   baseline. Only a real move or resize writes a new rectangle. Known and
 *   accepted: after such a move or resize the next start may show the window
 *   up to 1 DIP larger than written, once; it does not accumulate.
 *
 * A value stored by a version that saved the window bounds reads as a content
 * rectangle: the window opens at most 2x1 DIP larger than it was, once, and
 * then stays.
 *
 * Reading treats the file as untrusted (it is a plain JSON file a user can
 * edit): malformed geometry falls back to the default placement, and so does
 * a saved position no current display can show — a window whose monitor was
 * unplugged must not open where it cannot be grabbed. The title strip (the
 * tab bar) is what a user grabs to move the window, so that strip is what has
 * to land on some display's work area.
 */
import { readAppSettings, writeAppSetting } from './app-settings'

/** `app-settings.json` key holding the last session's window state. */
export const WINDOW_BOUNDS_KEY = 'windowBounds'

/**
 * Constructor values for the shell window (index.ts). They live here so the
 * creation defaults and the validation bounds cannot drift apart.
 */
export const SHELL_WINDOW_DEFAULT_WIDTH = 1360
export const SHELL_WINDOW_DEFAULT_HEIGHT = 900
export const SHELL_WINDOW_MIN_WIDTH = 720
export const SHELL_WINDOW_MIN_HEIGHT = 550

/**
 * A saved dimension beyond this is corrupt — the largest real displays are
 * 8K, and a giant window is worse than the default placement.
 */
const MAX_DIMENSION = 8192

/** How much of the title strip must show on a display for the window to count as reachable. */
const MIN_VISIBLE_WIDTH = 120
/**
 * How many rows of the strip must show. Less than the full strip, because a
 * window flush with the top of a display can sit a few rows under the menu
 * bar or a top-docked taskbar and still be grabbable.
 */
const MIN_VISIBLE_STRIP_HEIGHT = 12
const TITLE_STRIP_HEIGHT = 40

/**
 * How long a drag or resize must settle before the geometry is written. Long
 * enough that a whole drag is one write, short enough that a kill moments
 * after the drag still leaves the settled geometry behind.
 */
export const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS = 500

/**
 * How long a burst of move/resize events must rest before the window is asked
 * what state it is in. Shorter than any gap a person leaves between two
 * actions, longer than the gap between two frames of a transition.
 */
export const WINDOW_BOUNDS_SETTLE_MS = 100

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** The window's normal-state content rectangle and whether it was maximized. */
export interface ShellWindowState extends WindowRect {
  /** whether the window was maximized when its geometry was last saved */
  maximized: boolean
}

function sameRect(a: WindowRect, b: WindowRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The stored value as a state object, or null when it cannot be trusted.
 *
 * Fractional coordinates are rounded, not rejected: a hand-edited `x: 10.5`
 * still names a real position. Sizes below the window minimum or beyond any
 * display are rejected outright — they describe a window that cannot exist.
 */
export function parseShellWindowState(value: unknown): ShellWindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    !isFiniteNumber(record.width) ||
    !isFiniteNumber(record.height)
  ) {
    return null
  }
  const state: ShellWindowState = {
    x: Math.round(record.x),
    y: Math.round(record.y),
    width: Math.round(record.width),
    height: Math.round(record.height),
    maximized: record.maximized === true,
  }
  if (state.width < SHELL_WINDOW_MIN_WIDTH || state.height < SHELL_WINDOW_MIN_HEIGHT) return null
  if (state.width > MAX_DIMENSION || state.height > MAX_DIMENSION) return null
  return state
}

/**
 * Whether some display can still show the window's title strip — the part a
 * user grabs to bring the window back. The strip is the top of the window
 * (the tab bar doubles as the title bar on Windows/Linux); at least 120px of
 * it must overlap a work area, with most of its height inside. A window
 * whose visible remainder is a sliver of its bottom edge fails here on
 * purpose: nothing left to grab means the user cannot move it back.
 */
export function isShellWindowVisible(state: WindowRect, workAreas: readonly WindowRect[]): boolean {
  const strip = Math.min(state.height, TITLE_STRIP_HEIGHT)
  return workAreas.some((area) => {
    const overlapWidth =
      Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)
    const overlapHeight =
      Math.min(state.y + strip, area.y + area.height) - Math.max(state.y, area.y)
    return (
      overlapWidth >= MIN_VISIBLE_WIDTH &&
      overlapHeight >= Math.min(strip, MIN_VISIBLE_STRIP_HEIGHT)
    )
  })
}

/**
 * The saved state when it exists, parses, and some display can still show it;
 * null means "open at the default placement".
 */
export function readShellWindowState(
  settingsPath: string,
  workAreas: readonly WindowRect[],
): ShellWindowState | null {
  const parsed = parseShellWindowState(readAppSettings(settingsPath)[WINDOW_BOUNDS_KEY])
  if (!parsed) return null
  return isShellWindowVisible(parsed, workAreas) ? parsed : null
}

/** The members the restore needs off a new window (BrowserWindow satisfies this). */
export interface ShellWindowTarget {
  setContentBounds(bounds: WindowRect): void
  getContentBounds(): WindowRect
  maximize(): void
}

/**
 * Give a freshly created window the state read from the settings: the content
 * rectangle first, then the maximized flag, so a maximized session reopens
 * maximized over its normal rectangle instead of as a screen-sized ordinary
 * window.
 *
 * Returns the baseline: the content rectangle the window reports once the
 * stored one is applied, read before the window is maximized. Null when
 * there was no state to apply.
 */
export function applyShellWindowState(
  win: ShellWindowTarget,
  state: ShellWindowState | null,
): WindowRect | null {
  if (!state) return null
  win.setContentBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
  const { x, y, width, height } = win.getContentBounds()
  if (state.maximized) win.maximize()
  return { x, y, width, height }
}

/** How this session's window started: what `applyShellWindowState` was given and what it returned. */
export interface ShellWindowLaunch {
  /** the state read from the settings, null when the window opened at the default placement */
  restored: ShellWindowState | null
  /** the content rectangle the window reported once `restored` was applied */
  baseline: WindowRect | null
}

/** The members the save path needs off a live window (BrowserWindow satisfies this). */
export interface ShellWindowSource {
  isMaximized(): boolean
  isMinimized?(): boolean
  isFullScreen?(): boolean
  getContentBounds(): WindowRect
}

function writeShellWindowState(settingsPath: string, state: ShellWindowState): void {
  writeAppSetting(settingsPath, WINDOW_BOUNDS_KEY, {
    x: Math.round(state.x),
    y: Math.round(state.y),
    // The content of a window at its minimum size can be a frame narrower or
    // shorter than that minimum, which the parser rejects as a window that
    // cannot exist; the minimum is what such a window comes back with.
    width: Math.max(SHELL_WINDOW_MIN_WIDTH, Math.round(state.width)),
    height: Math.max(SHELL_WINDOW_MIN_HEIGHT, Math.round(state.height)),
    maximized: state.maximized,
  })
}

/**
 * Wire the save policy onto a live window: debounced while the user drags or
 * resizes — a crash or a kill then still leaves the last settled arrangement
 * behind — plus once on close, which is the moment the issue asks for and the
 * one that lands while a debounce is still pending. A vetoed close (the
 * unsaved-changes prompt) saves too; the geometry it is asking about has not
 * moved since, so the write is the same either way.
 *
 * Fullscreen is deliberately not remembered: it reads as a transient mode for
 * presenting, not as a window arrangement to come back to.
 */
export function installShellWindowBoundsPersistence(
  settingsPath: string,
  win: ShellWindowSource & {
    on(event: string, listener: () => void): unknown
    isDestroyed(): boolean
  },
  launch: ShellWindowLaunch,
): void {
  const { restored, baseline } = launch
  // the normal-state content rectangle last seen; the baseline until the
  // window is seen normal, so a session that stays maximized keeps its start
  let normal: WindowRect | null = baseline
  let maximized = restored?.maximized ?? false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const observe = (): void => {
    // A minimized window reports isMaximized() false even when it will restore
    // maximized, and its rectangle is no place on a display: keep the flag and
    // the rectangle seen while it was visible.
    if (win.isMinimized?.()) return
    maximized = win.isMaximized()
    if (maximized || win.isFullScreen?.()) return
    const { x, y, width, height } = win.getContentBounds()
    normal = { x, y, width, height }
  }
  const save = (): void => {
    clearTimeout(settleTimer)
    clearTimeout(saveTimer)
    if (win.isDestroyed()) return
    try {
      observe()
      if (!normal) return
      // still where the restore put it: the window reports the baseline, and
      // the rectangle that produced the baseline is the one to keep
      const rect = restored && baseline && sameRect(normal, baseline) ? restored : normal
      writeShellWindowState(settingsPath, { ...rect, maximized })
    } catch (err) {
      // an unwritable settings file must not take the close (or the app) down
      console.warn('[shell] window bounds were not saved:', err)
    }
  }
  // The window is asked once a burst of events has come to rest, not inside
  // each event. macOS animates a zoom through in-between frames, each with its
  // own `resize` and none of them maximized yet, and a Linux window manager
  // can deliver the new size before the new state: read inside the event, the
  // last such frame would be remembered as the normal rectangle.
  const schedule = (): void => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      if (!win.isDestroyed()) observe()
    }, WINDOW_BOUNDS_SETTLE_MS)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, WINDOW_BOUNDS_SAVE_DEBOUNCE_MS)
  }
  observe()
  win.on('move', schedule)
  win.on('resize', schedule)
  win.on('close', save)
}
