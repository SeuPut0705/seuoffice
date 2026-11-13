/**
 * The Electron of one case, the TypeScript half of crates/ipc-probe/src/fakes.rs:
 * `ipcMain` collects the handlers the loaded modules register; the case's
 * views are `webContents` and `BrowserWindow`s whose `send` is recorded;
 * `dialog`, `shell`, `clipboard` and the web contents' own calls are logged
 * one line each, named and shaped as the Rust fakes log them, and answer
 * from the case's `hosts.shared` (README.md).
 */
import { join } from 'node:path'
import { Encoder } from '../../crates/shell/bridge/wire.ts'
import type { Case, View } from './types.ts'

type Fn = (...args: unknown[]) => unknown

export interface Recorded {
  view: number
  channel: string
  args: unknown
  buffers: string[]
}

export interface CaseElectron extends Record<string, unknown> {
  /** handlers by channel: `invoke` from `handle`, `on` from `on`/`once` */
  readonly handlers: { invoke: Map<string, Fn>; on: Map<string, Fn[]> }
  /** events sent to the views since the last `takeEvents` */
  takeEvents(): Recorded[]
  /** the host log of the case */
  readonly log: unknown[]
  /** the fake `webContents` of a view */
  contents(view: number): FakeContents
}

export interface FakeContents {
  id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  [key: string]: unknown
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** keys in Electron's order, absent and empty left out: what the Rust fakes write */
function pick(options: unknown, keys: readonly string[], lists: readonly string[] = []): unknown {
  const o = (options ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const v = o[key]
    if (v === undefined || v === null) continue
    if (lists.includes(key) && Array.isArray(v) && v.length === 0) continue
    out[key] = v
  }
  return out
}
const fileDialog = (o: unknown): unknown => {
  const picked = pick(
    o,
    ['title', 'defaultPath', 'buttonLabel', 'filters', 'properties'],
    ['filters', 'properties'],
  ) as Record<string, unknown>
  if (Array.isArray(picked.filters)) {
    picked.filters = (picked.filters as { name: string; extensions: string[] }[]).map((f) => ({
      name: f.name,
      extensions: f.extensions,
    }))
  }
  return picked
}
const messageBox = (o: unknown): unknown =>
  pick(
    o,
    ['type', 'title', 'message', 'detail', 'buttons', 'defaultId', 'cancelId', 'checkboxLabel'],
    ['buttons'],
  )

export function caseElectron(dir: string, c: Case): CaseElectron {
  const views: Required<View>[] = (c.views ?? [{ view: 1, window: 1, surface: 'Shell' }]).map(
    (v) => ({ view: v.view, window: v.window ?? v.view, surface: v.surface ?? 'Shell' }),
  )
  const shared = ((c.hosts ?? {}).shared ?? {}) as Record<string, Record<string, unknown>>
  const log: unknown[] = []
  let events: Recorded[] = []
  const invoke = new Map<string, Fn>()
  const on = new Map<string, Fn[]>()

  const zoom = new Map<number, number>()
  const contentsCase = shared.contents ?? {}
  const contents = new Map<number, FakeContents>()
  for (const v of views) {
    contents.set(v.view, {
      id: v.view,
      send(channel: string, ...args: unknown[]) {
        const e = new Encoder()
        const header = e.values(args)
        events.push({ view: v.view, channel, args: header, buffers: e.buffers.map(hex) })
      },
      isDestroyed: () => false,
      isCrashed: () => false,
      focus: () => log.push(['webContents.focus', v.view]),
      getZoomFactor: () =>
        zoom.get(v.view) ??
        (contentsCase.zoom as Record<string, number> | undefined)?.[String(v.view)] ??
        1,
      setZoomFactor: (f: number) => {
        log.push(['webContents.setZoomFactor', v.view, f])
        zoom.set(v.view, f)
      },
      capturePage: async () => {
        log.push(['webContents.capturePage', v.view])
        const png = Buffer.from(String(contentsCase.capturePng ?? ''), 'hex')
        return { toPNG: () => png, isEmpty: () => png.length === 0 }
      },
      printToPDF: async (options: unknown) => {
        log.push(['webContents.printToPDF', v.view, new Encoder().value(options)])
        if (typeof contentsCase.pdf !== 'string') throw new Error('printToPDF failed')
        return Buffer.from(contentsCase.pdf, 'hex')
      },
      print: (options: unknown, done?: (ok: boolean, reason: string) => void) => {
        log.push(['webContents.print', v.view, new Encoder().value(options)])
        done?.((contentsCase.print as boolean | undefined) ?? true, '')
      },
    })
  }
  const windowIds = [...new Set(views.map((v) => v.window))]
  const windows = new Map(
    windowIds.map((id) => {
      const first = views.find((v) => v.window === id)!
      const win = {
        id,
        webContents: contents.get(first.view)!,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        close: () => log.push(['BrowserWindow.close', id]),
        focus: () => {},
        show: () => {},
      }
      return [id, win] as const
    }),
  )
  const windowOf = (wc: unknown) => {
    const v = views.find((x) => contents.get(x.view) === wc)
    return v ? windows.get(v.window) : undefined
  }
  const parentOf = (args: unknown[]): [unknown, unknown] =>
    args.length >= 2 ? [(args[0] as { id?: number } | null)?.id ?? null, args[1]] : [null, args[0]]

  const dialogs = shared.dialogs ?? {}
  const queue = (key: string): unknown[] => [...((dialogs[key] as unknown[] | undefined) ?? [])]
  const opens = queue('open')
  const saves = queue('save')
  const messages = queue('message')
  const osShell = shared.osShell ?? {}
  const clip = shared.clipboard ?? {}
  const board = {
    text: String(clip.text ?? ''),
    html: String(clip.html ?? ''),
    png: Buffer.from(String(clip.imagePng ?? ''), 'hex') as Buffer,
    formats: (clip.formats as string[] | undefined) ?? [],
  }
  const image = (png: Buffer) => ({ toPNG: () => png, isEmpty: () => png.length === 0 })

  const electron: CaseElectron = {
    handlers: { invoke, on },
    log,
    takeEvents() {
      const out = events
      events = []
      return out
    },
    contents: (view) => contents.get(view)!,
    ipcMain: {
      handle: (ch: string, fn: Fn) => {
        if (invoke.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`)
        invoke.set(ch, fn)
      },
      handleOnce: (ch: string, fn: Fn) => invoke.set(ch, fn),
      removeHandler: (ch: string) => invoke.delete(ch),
      on: (ch: string, fn: Fn) => on.set(ch, [...(on.get(ch) ?? []), fn]),
      once: (ch: string, fn: Fn) => on.set(ch, [...(on.get(ch) ?? []), fn]),
      removeListener: (ch: string, fn: Fn) =>
        on.set(
          ch,
          (on.get(ch) ?? []).filter((f) => f !== fn),
        ),
      removeAllListeners: (ch?: string) => (ch === undefined ? on.clear() : on.delete(ch)),
    },
    webContents: {
      fromId: (id: number) => contents.get(id),
      getAllWebContents: () => views.map((v) => contents.get(v.view)),
      getFocusedWebContents: () => contents.get(views[0].view),
    },
    BrowserWindow: {
      getAllWindows: () => [...windows.values()],
      fromWebContents: (wc: unknown) => windowOf(wc) ?? null,
      fromId: (id: number) => windows.get(id) ?? null,
      getFocusedWindow: () => windows.get(views[0].window) ?? null,
    },
    app: {
      getPath: (name: string) => join(dir, name),
      getName: () => 'seuoffice',
      isPackaged: false,
      on: () => {},
      once: () => {},
      whenReady: () => Promise.resolve(),
    },
    dialog: {
      showOpenDialog: async (...args: unknown[]) => {
        const [parent, options] = parentOf(args)
        log.push(['dialog.showOpenDialog', parent, fileDialog(options)])
        const answer = opens.shift()
        return Array.isArray(answer)
          ? { canceled: false, filePaths: answer as string[] }
          : { canceled: true, filePaths: [] }
      },
      showSaveDialog: async (...args: unknown[]) => {
        const [parent, options] = parentOf(args)
        log.push(['dialog.showSaveDialog', parent, fileDialog(options)])
        const answer = saves.shift()
        return typeof answer === 'string'
          ? { canceled: false, filePath: answer }
          : { canceled: true, filePath: '' }
      },
      showMessageBox: async (...args: unknown[]) => {
        const [parent, options] = parentOf(args)
        log.push(['dialog.showMessageBox', parent, messageBox(options)])
        const answer = (messages.shift() ?? {}) as { response?: number; checkboxChecked?: boolean }
        return { response: answer.response ?? 0, checkboxChecked: answer.checkboxChecked ?? false }
      },
      showErrorBox: (title: string, content: string) =>
        log.push(['dialog.showErrorBox', title, content]),
    },
    shell: {
      openExternal: async (url: string) => {
        log.push(['shell.openExternal', url])
        if (typeof osShell.openExternalError === 'string')
          throw new Error(osShell.openExternalError)
      },
      openPath: async (path: string) => {
        log.push(['shell.openPath', path])
        return String(osShell.openPath ?? '')
      },
      showItemInFolder: (path: string) => log.push(['shell.showItemInFolder', path]),
      trashItem: async (path: string) => {
        log.push(['shell.trashItem', path])
        if (typeof osShell.trashError === 'string') throw new Error(osShell.trashError)
      },
    },
    clipboard: {
      readText: () => (log.push(['clipboard.readText']), board.text),
      writeText: (text: string) => {
        log.push(['clipboard.writeText', text])
        board.text = text
      },
      readHTML: () => (log.push(['clipboard.readHTML']), board.html),
      write: (data: { html?: string; text?: string }) => {
        log.push(['clipboard.write', { html: data.html, text: data.text ?? null }])
        if (data.html !== undefined) board.html = data.html
        if (data.text !== undefined) board.text = data.text
      },
      readImage: () => (log.push(['clipboard.readImage']), image(board.png)),
      writeImage: (img: { toPNG(): Buffer }) => {
        board.png = img.toPNG()
        log.push(['clipboard.writeImage', hex(board.png)])
      },
      availableFormats: () => (log.push(['clipboard.availableFormats']), board.formats),
    },
    nativeImage: {
      createFromBuffer: (png: Buffer) => image(Buffer.from(png)),
      createEmpty: () => image(Buffer.alloc(0)),
    },
  }
  return electron
}
