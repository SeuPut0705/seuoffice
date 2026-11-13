/**
 * The shapes of tools/ipc-diff (README.md): a group is the cases of some
 * channels of one batch, with how to load the TypeScript that answers them.
 */
import type { FileSpec } from '../main-diff/types.ts'
import type { CaseElectron, FakeContents } from './fakes.ts'

export type { FileSpec }

/** A webview of the case: Electron's `webContents.id`, its window, its preload */
export interface View {
  view: number
  /** `BrowserWindow.id`; the view's id when left out */
  window?: number
  /** a `Surface` of crates/shell-contract, e.g. `Shell`, `Docs`, `ShellDocPicker` */
  surface?: string
}

export interface Call {
  /** the channel called; a `trigger` has none: write its name here as well (it is left out of the coverage of channels) */
  channel: string
  /** `trigger`: not a message of the renderer but an event of the shell (a menu click, a right-click) that both sides run; see README.md */
  kind?: 'invoke' | 'send' | 'sendSync' | 'trigger'
  /** `trigger`: `<batch>/<what>`, the key of `Group.triggers` and what the batch's `probe_trigger` is given */
  name?: string
  /** the sender; the case's first view when left out. For a trigger, the view the menu's events go to */
  view?: number
  /** the arguments in the wire form of crates/shell/bridge/wire.ts; `$DIR` in a string is the case's folder */
  args: unknown[]
  /** the buffers the arguments point at, as hex */
  buffers?: string[]
}

export interface Case {
  note?: string
  /** `[{view: 1, window: 1, surface: 'Shell'}]` when left out */
  views?: View[]
  /** the case's folder before the first call, relative paths (`app.getPath(name)` is `$DIR/<name>`) */
  files?: Record<string, FileSpec>
  /** what the fake hosts answer: `shared` for W's shared hosts (README.md), `u`, `a`, `m`, `w`, `d1`, `d2` for each batch's */
  hosts?: Record<string, unknown>
  /** run in order on one world; every call's answer and events are compared */
  calls: Call[]
}

export interface LoadContext {
  /** the case's folder */
  dir: string
  /** the case, `$DIR` replaced */
  case: Case
  /** the Electron of this case (fakes.ts): `ipcMain` collects the handlers */
  electron: CaseElectron
  /** adds or replaces Electron names for this case; call before loading the module */
  install(names: Record<string, unknown>): void
  /**
   * imports a module afresh for this case (its own module state); the modules
   * it imports are shared by the group's cases, as the module cache keeps them
   */
  fresh<T = unknown>(path: string): Promise<T>
}

export interface TriggerContext extends LoadContext {
  /** the fake `webContents` of a view */
  contents(view: number): FakeContents
}

export interface Group {
  /** `U`, `A`, `M`, `W`, `D1`, `D2` */
  batch: string
  /**
   * Registers the TypeScript handlers for one case: install fakes on
   * `cx.electron`, then import the module(s) that call `ipcMain.handle/on`
   * (with `cx.fresh` when their state must start over for each case)
   */
  load(cx: LoadContext): Promise<void>
  /**
   * The TypeScript side of each `trigger` the group's cases call, by name:
   * runs after `load`; the value it resolves to is the answer, a throw is
   * `{error: String(err)}`
   */
  triggers?: Record<
    string,
    (cx: TriggerContext, view: number, args: unknown[]) => Promise<unknown> | unknown
  >
  cases: Case[]
  /** channels whose single answer is all there is, with why (the floor of two answers is waived) */
  single?: Record<string, string>
}
