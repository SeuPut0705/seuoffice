/**
 * What the quick-look group loads `apps/shell/src/main/quick-look` with. The
 * hosts the module reaches are stood in for as the Rust probe stands in for
 * them (`crates/shell-ipc/w/src/quick_look/probe.rs`), from the case's
 * `hosts.w.quickLook`:
 *
 * - `windows`: the Explorer hook exists (`process.platform` is `win32` while
 *   the case runs);
 * - `view`: the view the preview window opens as (2 by default); `lang`,
 *   `theme`: what the app answers (`ko`, `light`);
 * - `parse`: what `parseFileToText` answers, `[{ path, ok, text, error }]` or
 *   `[{ path, throws }]` (quick-look-parse.ts);
 * - `script`: what the Explorer hook reports once enabled (quick-look-hook.ts).
 *
 * `new BrowserWindow` is a window whose calls are log lines named as the
 * Electron call; the hook and the file reader are replaced where
 * `quick-look-window.ts` and `extract.ts` import them.
 */
import { registerHooks } from 'node:module'
import type { LoadContext } from '../types.ts'
import {
  quickLookBox,
  setQuickLookBox,
  type ParseSpec,
  type QuickLookBox,
  type ScriptOp,
} from './quick-look-box.ts'

const PARSE = new URL('./quick-look-parse.ts', import.meta.url).href
const HOOK = new URL('./quick-look-hook.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (specifier === '@seuoffice/file-parse' && /\/quick-look\/extract\.ts/.test(parent)) {
      return next(PARSE, context)
    }
    if (specifier === './win-explorer-hook' && /\/quick-look\/quick-look-window\.ts/.test(parent)) {
      return next(HOOK, context)
    }
    return next(specifier, context)
  },
})

interface QuickLookSpec {
  windows?: boolean
  view?: number
  lang?: 'ko' | 'en'
  theme?: string
  parse?: (ParseSpec & { path: string })[]
  script?: ScriptOp[]
}

export const specOf = (cx: LoadContext): QuickLookSpec =>
  ((cx.case.hosts?.w ?? {}) as { quickLook?: QuickLookSpec }).quickLook ?? {}

/** `new BrowserWindow(options)` options as the log lines carry them, in Electron's order */
const WINDOW_KEYS = [
  'width',
  'height',
  'minWidth',
  'minHeight',
  'show',
  'center',
  'frame',
  'transparent',
  'backgroundColor',
  'hasShadow',
  'alwaysOnTop',
  'minimizable',
  'maximizable',
  'fullscreenable',
  'autoHideMenuBar',
  'title',
]

const REAL_PLATFORM = process.platform
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The preview window's exit animation (155 ms) and a margin, waited after a call that starts it */
const EXIT_PAUSE_MS = 220

/** Installs the stand-ins for this case and returns the box the stand-in modules read */
export function standIn(cx: LoadContext): QuickLookBox {
  const spec = specOf(cx)
  const log = cx.electron.log
  const box: QuickLookBox = {
    log,
    parse: Object.fromEntries((spec.parse ?? []).map((p) => [p.path, p])),
    script: spec.script ?? [],
    notify: () => {},
    started: false,
  }
  setQuickLookBox(box)
  Object.defineProperty(process, 'platform', {
    value: spec.windows ? 'win32' : REAL_PLATFORM,
    configurable: true,
  })

  const contents = cx.electron.contents(spec.view ?? 2) as Record<string, unknown> | undefined
  const statics = cx.electron.BrowserWindow as Record<string, unknown>
  class FakeBrowserWindow {
    static getAllWindows = statics.getAllWindows
    static fromWebContents = statics.fromWebContents
    static fromId = statics.fromId
    static getFocusedWindow = statics.getFocusedWindow

    readonly webContents = contents
    private visible = false
    private destroyed = false

    constructor(options: Record<string, unknown>) {
      log.push([
        'new BrowserWindow',
        Object.fromEntries(WINDOW_KEYS.filter((k) => k in options).map((k) => [k, options[k]])),
      ])
      if (contents) contents.setWindowOpenHandler = () => {}
    }
    removeMenu(): void {}
    once(event: string, listener: () => void): void {
      // the page is up once the constructor's caller returns
      if (event === 'ready-to-show') setImmediate(listener)
    }
    on(): void {}
    loadFile(): void {}
    loadURL(): void {}
    isDestroyed(): boolean {
      return this.destroyed
    }
    isVisible(): boolean {
      return this.visible
    }
    setTitle(title: string): void {
      log.push(['BrowserWindow.setTitle', title])
    }
    showInactive(): void {
      log.push(['BrowserWindow.showInactive'])
      this.visible = true
    }
    hide(): void {
      log.push(['BrowserWindow.hide'])
      this.visible = false
    }
    destroy(): void {
      log.push(['BrowserWindow.destroy'])
      this.destroyed = true
      this.visible = false
    }
  }
  cx.install({ BrowserWindow: FakeBrowserWindow })
  return box
}

/** Makes a handler wait out the preview window's exit animation after it answers */
export function waitOutExit(cx: LoadContext, channels: string[]): void {
  for (const channel of channels) {
    const handler = cx.electron.handlers.invoke.get(channel)
    if (!handler) continue
    cx.electron.handlers.invoke.set(channel, async (...args: unknown[]) => {
      const answer = await handler(...args)
      await sleep(EXIT_PAUSE_MS)
      return answer
    })
  }
}

/** Makes a handler wait for the Explorer hook's report when the call has just enabled the hook */
export function waitOutHook(cx: LoadContext, channels: string[]): void {
  for (const channel of channels) {
    const handler = cx.electron.handlers.invoke.get(channel)
    if (!handler) continue
    cx.electron.handlers.invoke.set(channel, async (...args: unknown[]) => {
      const answer = await handler(...args)
      await quickLookBox().played
      return answer
    })
  }
}
