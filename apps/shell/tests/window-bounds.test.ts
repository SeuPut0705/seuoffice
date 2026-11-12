import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyShellWindowState,
  installShellWindowBoundsPersistence,
  isShellWindowVisible,
  parseShellWindowState,
  readShellWindowState,
  SHELL_WINDOW_DEFAULT_HEIGHT,
  SHELL_WINDOW_DEFAULT_WIDTH,
  SHELL_WINDOW_MIN_HEIGHT,
  SHELL_WINDOW_MIN_WIDTH,
  WINDOW_BOUNDS_KEY,
  WINDOW_BOUNDS_SAVE_DEBOUNCE_MS,
  WINDOW_BOUNDS_SETTLE_MS,
  type WindowRect,
} from '../src/main/window-bounds'

/**
 * The shell window's geometry across sessions (genoffice#2049): what is stored,
 * what is trusted back, and the debounced/close save policy.
 *
 * The settings file is a plain JSON file a user can hand-edit, so reading it
 * has to survive anything that ends up in there — that is most of these tests.
 * No Electron is needed: the save path takes a window-shaped object and the
 * module never imports `electron` itself.
 */

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'window-bounds-'))
  settingsPath = join(dir, 'app-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function settingsFile(contents: unknown): string {
  writeFileSync(settingsPath, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return settingsPath
}

describe('parseShellWindowState', () => {
  it('parses a well-formed saved state', () => {
    expect(
      parseShellWindowState({ x: 100, y: 80, width: 1200, height: 800, maximized: true }),
    ).toEqual({ x: 100, y: 80, width: 1200, height: 800, maximized: true })
  })

  it('rounds fractional coordinates instead of rejecting them', () => {
    expect(parseShellWindowState({ x: 10.4, y: 20.6, width: 1200.2, height: 800.7 })).toEqual({
      x: 10,
      y: 21,
      width: 1200,
      height: 801,
      maximized: false,
    })
  })

  it('defaults the maximized flag and ignores non-boolean values', () => {
    expect(parseShellWindowState({ x: 0, y: 0, width: 1200, height: 800 })?.maximized).toBe(false)
    expect(
      parseShellWindowState({ x: 0, y: 0, width: 1200, height: 800, maximized: 'yes' })?.maximized,
    ).toBe(false)
  })

  it('rejects anything that is not a rectangle of finite numbers', () => {
    expect(parseShellWindowState(null)).toBeNull()
    expect(parseShellWindowState(42)).toBeNull()
    expect(parseShellWindowState('1200x800')).toBeNull()
    expect(parseShellWindowState([])).toBeNull()
    expect(parseShellWindowState({})).toBeNull()
    expect(parseShellWindowState({ x: 0, y: 0, width: 1200 })).toBeNull()
    expect(parseShellWindowState({ x: 0, y: 0, width: NaN, height: 800 })).toBeNull()
    expect(parseShellWindowState({ x: 0, y: 0, width: Infinity, height: 800 })).toBeNull()
    expect(parseShellWindowState({ x: '100', y: 0, width: 1200, height: 800 })).toBeNull()
  })

  it('rejects sizes a real window cannot have', () => {
    const rect = { x: 0, y: 0, width: SHELL_WINDOW_MIN_WIDTH, height: SHELL_WINDOW_MIN_HEIGHT }
    expect(parseShellWindowState(rect)).not.toBeNull()
    expect(parseShellWindowState({ ...rect, width: SHELL_WINDOW_MIN_WIDTH - 1 })).toBeNull()
    expect(parseShellWindowState({ ...rect, height: SHELL_WINDOW_MIN_HEIGHT - 1 })).toBeNull()
    // the largest real displays are 8K — beyond that the value is corrupt
    expect(parseShellWindowState({ ...rect, width: 9000 })).toBeNull()
    expect(parseShellWindowState({ ...rect, height: 9000 })).toBeNull()
  })

  it('accepts negative coordinates (a display left of the primary)', () => {
    expect(parseShellWindowState({ x: -1400, y: 100, width: 1200, height: 800 })).not.toBeNull()
  })
})

describe('isShellWindowVisible', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 }
  const secondary = { x: 1440, y: 0, width: 1920, height: 1080 }

  it('keeps a window inside the work area', () => {
    expect(isShellWindowVisible({ x: 100, y: 80, width: 1200, height: 800 }, [primary])).toBe(true)
  })

  it('keeps a window intentionally half off an edge, strip still showing', () => {
    // 240px of the window (and the whole title strip) stay on the display
    expect(isShellWindowVisible({ x: 1200, y: 80, width: 1360, height: 800 }, [primary])).toBe(true)
  })

  it('rejects a window saved on a monitor that is gone', () => {
    expect(isShellWindowVisible({ x: 2600, y: 100, width: 1200, height: 800 }, [primary])).toBe(
      false,
    )
  })

  it('accepts a window flush with the top, a few strip rows under the menu bar', () => {
    const belowMenuBar = { ...primary, y: 25, height: primary.height - 25 }
    expect(isShellWindowVisible({ x: 100, y: 0, width: 1200, height: 800 }, [belowMenuBar])).toBe(
      true,
    )
  })

  it('rejects a window pushed off the top — the strip is not reachable', () => {
    expect(isShellWindowVisible({ x: 100, y: -800, width: 1200, height: 800 }, [primary])).toBe(
      false,
    )
  })

  it('rejects a remaining sliver narrower than a grab', () => {
    // only 40px of the window's left edge shows
    expect(isShellWindowVisible({ x: 1400, y: 80, width: 1360, height: 800 }, [primary])).toBe(
      false,
    )
  })

  it('accepts a position on any of several displays', () => {
    expect(
      isShellWindowVisible({ x: 1600, y: 100, width: 1200, height: 800 }, [primary, secondary]),
    ).toBe(true)
  })
})

describe('readShellWindowState', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 }

  it('returns null when the file or the key is missing', () => {
    expect(readShellWindowState(settingsPath, [primary])).toBeNull()
    settingsFile({ language: 'en' })
    expect(readShellWindowState(settingsPath, [primary])).toBeNull()
    settingsFile('{broken')
    expect(readShellWindowState(settingsPath, [primary])).toBeNull()
  })

  it('returns the saved state when a display can show it', () => {
    settingsFile({
      [WINDOW_BOUNDS_KEY]: { x: 120, y: 90, width: 960, height: 640, maximized: true },
    })
    expect(readShellWindowState(settingsPath, [primary])).toEqual({
      x: 120,
      y: 90,
      width: 960,
      height: 640,
      maximized: true,
    })
  })

  it('returns null when the saved position is off every display', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: { x: 9000, y: 9000, width: 960, height: 640 } })
    expect(readShellWindowState(settingsPath, [primary])).toBeNull()
  })
})

/**
 * How a platform's window frame answers the geometry calls. The Windows
 * numbers were measured on Windows 11 with Electron 43.8.3 and the shell's
 * window options (`titleBarStyle: 'hidden'`, thick frame).
 */
interface FrameModel {
  /** device pixels per DIP */
  scale: number
  /** what the constructor adds to the asked size, as the content reads it back */
  createdContent: readonly [number, number]
  /** what the constructor adds to the asked size, as the window bounds read it back */
  createdBounds: readonly [number, number]
  /** how much larger than the content the window bounds are after `setContentBounds` */
  frame: readonly [number, number]
  /** in-between frames a maximize animates through before the window reports maximized */
  zoomSteps: number
}

const WINDOWS_125: FrameModel = {
  scale: 1.25,
  createdContent: [4, 4],
  createdBounds: [6, 4],
  frame: [2, 1],
  zoomSteps: 0,
}
const WINDOWS_100: FrameModel = {
  scale: 1,
  createdContent: [0, 0],
  createdBounds: [0, 0],
  frame: [0, 0],
  zoomSteps: 0,
}
/** macOS animates the zoom: `resize` fires for every in-between frame, none of them maximized. */
const MACOS: FrameModel = { ...WINDOWS_100, scale: 2, zoomSteps: 6 }

/** the one display: 2560x1440 at 125% with a taskbar */
const WORK_AREA: WindowRect = { x: 0, y: 0, width: 2048, height: 1104 }
/** where Windows parks a minimized window */
const MINIMIZED: WindowRect = { x: -32000, y: -32000, width: 160, height: 28 }

function between(from: WindowRect, to: WindowRect, t: number): WindowRect {
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t)
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
  }
}

/** A window that answers like a BrowserWindow on the modelled platform. */
class FakeShellWindow {
  destroyed = false
  private readonly handlers = new Map<string, Array<() => void>>()
  private content: WindowRect
  private bounds: WindowRect
  private transit: WindowRect | null = null
  private maximized = false
  private minimized = false
  private fullScreen = false

  constructor(
    private readonly model: FrameModel,
    options: { x?: number; y?: number; width: number; height: number },
  ) {
    const x = options.x ?? 120
    const y = options.y ?? 90
    const size = (extra: readonly [number, number]): WindowRect => ({
      x,
      y,
      width: options.width + extra[0],
      height: options.height + extra[1],
    })
    this.content = size(model.createdContent)
    this.bounds = size(model.createdBounds)
  }

  on(event: string, listener: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
  }

  emit(event: string): void {
    for (const listener of this.handlers.get(event) ?? []) listener()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** false while minimized, as Electron reports it even when the window will restore maximized */
  isMaximized(): boolean {
    return this.maximized && !this.minimized && !this.fullScreen
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isFullScreen(): boolean {
    return this.fullScreen
  }

  getContentBounds(): WindowRect {
    if (this.minimized) return { ...MINIMIZED }
    if (this.maximized || this.fullScreen) return { ...WORK_AREA }
    return { ...(this.transit ?? this.content) }
  }

  /** The normal-state window rectangle: what the save read before it stored the content. */
  getNormalBounds(): WindowRect {
    return { ...this.bounds }
  }

  /**
   * Exact when the left edge lands on a whole device pixel; otherwise the
   * content reads back one DIP further right and one DIP wider.
   */
  setContentBounds(rect: WindowRect): void {
    const before = this.content
    const snap = Number.isInteger(rect.x * this.model.scale) ? 0 : 1
    this.place({ x: rect.x + snap, y: rect.y, width: rect.width + snap, height: rect.height })
    if (before.width !== this.content.width || before.height !== this.content.height) {
      this.emit('resize')
    }
    if (before.x !== this.content.x || before.y !== this.content.y) this.emit('move')
  }

  maximize(): void {
    for (let step = 1; step <= this.model.zoomSteps; step++) {
      this.transit = between(this.content, WORK_AREA, step / (this.model.zoomSteps + 1))
      this.emit('resize')
      this.emit('move')
    }
    this.transit = null
    this.maximized = true
    this.emit('resize')
    this.emit('move')
  }

  unmaximize(): void {
    this.maximized = false
    this.emit('resize')
    this.emit('move')
  }

  minimize(): void {
    this.minimized = true
    this.emit('move')
    this.emit('resize')
  }

  setFullScreen(flag: boolean): void {
    this.fullScreen = flag
    this.emit('resize')
    this.emit('move')
  }

  /** the user drags an edge until the content has this size */
  userResize(width: number, height: number): void {
    this.place({ ...this.content, width, height })
    this.emit('resize')
  }

  /** the user drags the window until the content sits here */
  userMove(x: number, y: number): void {
    this.place({ ...this.content, x, y })
    this.emit('move')
  }

  /** the close event; a vetoed close (the unsaved-changes prompt) leaves the window alive */
  close(options: { vetoed?: boolean } = {}): void {
    this.emit('close')
    if (!options.vetoed) this.destroyed = true
  }

  private place(content: WindowRect): void {
    this.content = content
    this.bounds = {
      ...content,
      width: content.width + this.model.frame[0],
      height: content.height + this.model.frame[1],
    }
  }
}

/** One app start, in the order index.ts runs it: read, create, apply, install. */
function launch(model: FrameModel, path = settingsPath): FakeShellWindow {
  const restored = readShellWindowState(path, [WORK_AREA])
  const win = new FakeShellWindow(model, {
    width: restored?.width ?? SHELL_WINDOW_DEFAULT_WIDTH,
    height: restored?.height ?? SHELL_WINDOW_DEFAULT_HEIGHT,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
  })
  const baseline = applyShellWindowState(win, restored)
  installShellWindowBoundsPersistence(path, win, { restored, baseline })
  return win
}

function stored(): unknown {
  return JSON.parse(readFileSync(settingsPath, 'utf8'))[WINDOW_BOUNDS_KEY]
}

/** let a burst of move/resize events come to rest, as it does before a person's next action */
function settle(): void {
  vi.advanceTimersByTime(WINDOW_BOUNDS_SETTLE_MS)
}

function restartTimes(model: FrameModel, times: number, expected: unknown): void {
  for (let start = 1; start <= times; start++) {
    launch(model).close()
    expect(stored(), `start ${start}`).toEqual(expected)
  }
}

describe('the shell window across restarts', () => {
  const START = { x: 100, y: 80, width: 1200, height: 800, maximized: false }
  /** a left edge that is not a whole device pixel at 125% (837 * 1.25 = 1046.25) */
  const OFF_PIXEL = { x: 837, y: 0, width: 1217, height: 1105, maximized: false }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps its size over four starts on a 125% Windows display', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    restartTimes(WINDOWS_125, 4, START)
  })

  it('keeps its size over four starts on a 100% display', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    restartTimes(WINDOWS_100, 4, START)
  })

  it('keeps a rectangle whose left edge is between device pixels over five starts', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: OFF_PIXEL })
    restartTimes(WINDOWS_125, 5, OFF_PIXEL)
  })

  it('stores what a first start opened with, and later starts keep it', () => {
    const win = launch(WINDOWS_125)
    const opened = win.getContentBounds()
    win.close()
    expect(stored()).toEqual({ ...opened, maximized: false })
    restartTimes(WINDOWS_125, 4, { ...opened, maximized: false })
  })

  it('stores a resize once, and later starts keep it', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: OFF_PIXEL })
    const win = launch(WINDOWS_125)
    win.userResize(1300, 900)
    const resized = { ...win.getContentBounds(), maximized: false }
    win.close()
    expect(stored()).toEqual(resized)
    expect(resized).toMatchObject({ width: 1300, height: 900 })
    restartTimes(WINDOWS_125, 4, resized)
  })

  it('stores a move once, and later starts keep it', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: OFF_PIXEL })
    const win = launch(WINDOWS_125)
    win.userMove(401, 33)
    const moved = { ...win.getContentBounds(), maximized: false }
    win.close()
    expect(stored()).toEqual(moved)
    expect(moved).toMatchObject({ x: 401, y: 33 })
    restartTimes(WINDOWS_125, 4, moved)
  })

  it.each([
    ['a 125% Windows display', WINDOWS_125],
    ['a 100% display', WINDOWS_100],
    ['macOS', MACOS],
  ])('reopens maximized and keeps the normal rectangle on %s', (_name, model) => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    const first = launch(model)
    first.maximize()
    first.close()
    expect(stored()).toEqual({ ...START, maximized: true })

    for (let start = 1; start <= 4; start++) {
      const win = launch(model)
      expect(win.isMaximized(), `start ${start}`).toBe(true)
      win.close()
      expect(stored(), `start ${start}`).toEqual({ ...START, maximized: true })
    }
  })

  it.each([
    ['a 125% Windows display', WINDOWS_125],
    ['macOS, where the zoom animates', MACOS],
  ])('stores a resize made before maximizing in the same run on %s', (_name, model) => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    const win = launch(model)
    win.userResize(1300, 850)
    settle()
    win.maximize()
    win.close()
    expect(stored()).toEqual({ x: 100, y: 80, width: 1300, height: 850, maximized: true })
  })

  it('keeps the normal rectangle when a maximized start is closed untouched', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: { ...START, maximized: true } })
    const win = launch(WINDOWS_125)
    // the debounced save lands while the window is still maximized
    win.emit('resize')
    vi.advanceTimersByTime(WINDOW_BOUNDS_SAVE_DEBOUNCE_MS)
    expect(stored()).toEqual({ ...START, maximized: true })
    win.close()
    expect(stored()).toEqual({ ...START, maximized: true })
  })

  it('goes back to the stored rectangle when a maximized start is restored', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: { ...START, maximized: true } })
    const win = launch(WINDOWS_125)
    win.unmaximize()
    win.close()
    expect(stored()).toEqual(START)
    restartTimes(WINDOWS_125, 2, START)
  })

  it('keeps the last visible maximized flag and the normal rectangle when closed minimized', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    const maximizedThenHidden = launch(WINDOWS_125)
    maximizedThenHidden.maximize()
    settle()
    maximizedThenHidden.minimize()
    maximizedThenHidden.close()
    expect(stored()).toEqual({ ...START, maximized: true })

    const resizedThenHidden = launch(WINDOWS_125)
    resizedThenHidden.unmaximize()
    resizedThenHidden.userResize(1300, 850)
    settle()
    resizedThenHidden.minimize()
    resizedThenHidden.close()
    expect(stored()).toEqual({ x: 100, y: 80, width: 1300, height: 850, maximized: false })
  })

  it('stores the last normal rectangle when closed in fullscreen', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    const win = launch(WINDOWS_125)
    win.userResize(1300, 850)
    settle()
    win.setFullScreen(true)
    win.close()
    expect(stored()).toMatchObject({ x: 100, y: 80, width: 1300, height: 850 })
  })

  it('reopens a window left at its minimum size where it was', () => {
    settingsFile({ [WINDOW_BOUNDS_KEY]: START })
    const win = launch(WINDOWS_125)
    // the window is at its minimum, so its content is a frame narrower and shorter
    win.userResize(SHELL_WINDOW_MIN_WIDTH - 2, SHELL_WINDOW_MIN_HEIGHT - 1)
    win.close()
    const atMinimum = {
      x: 100,
      y: 80,
      width: SHELL_WINDOW_MIN_WIDTH,
      height: SHELL_WINDOW_MIN_HEIGHT,
      maximized: false,
    }
    expect(readShellWindowState(settingsPath, [WORK_AREA])).toEqual(atMinimum)
    restartTimes(WINDOWS_125, 3, atMinimum)
  })

  it('keeps unrelated settings keys', () => {
    settingsFile({ language: 'ja' })
    launch(WINDOWS_125).close()
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).language).toBe('ja')
  })
})

describe('the save policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounces a burst of moves and resizes into a save after it settles', () => {
    const win = launch(WINDOWS_100)
    win.userMove(300, 200)
    win.userResize(1000, 700)
    win.userMove(40, 50)
    vi.advanceTimersByTime(WINDOW_BOUNDS_SAVE_DEBOUNCE_MS - 1)
    expect(existsSync(settingsPath)).toBe(false)

    vi.advanceTimersByTime(1)
    expect(stored()).toEqual({ x: 40, y: 50, width: 1000, height: 700, maximized: false })
  })

  it('saves immediately on close and drops a pending debounce', () => {
    const win = launch(WINDOWS_100)
    win.userMove(40, 50)
    win.userResize(1000, 700)
    // a vetoed close: the window lives on, so a pending debounce could still fire
    win.close({ vetoed: true })
    expect(stored()).toEqual({ x: 40, y: 50, width: 1000, height: 700, maximized: false })

    rmSync(settingsPath)
    vi.advanceTimersByTime(WINDOW_BOUNDS_SAVE_DEBOUNCE_MS * 4)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('skips a destroyed window', () => {
    const win = launch(WINDOWS_100)
    win.userMove(40, 50)
    win.destroyed = true
    expect(() => win.emit('close')).not.toThrow()
    expect(() => vi.advanceTimersByTime(WINDOW_BOUNDS_SAVE_DEBOUNCE_MS)).not.toThrow()
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('warns instead of throwing when the settings file is unwritable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    const win = launch(WINDOWS_100, blocked)
    expect(() => win.close()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
