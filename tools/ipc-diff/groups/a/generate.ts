/**
 * Group `a/generate`: the generate window ("make a new document from these
 * files", `apps/shell/src/main/generate/generate-window.ts`) and Home's two
 * ways into it, configured as the shell entry's `configureGenerateWindow({...})`
 * does it: the shell window is the parent, the language and theme come from
 * `hosts.a` (`lang`, `ko` by default, and `hosts.a.generate.theme`), the open
 * tabs are the list both the tab manager and the open-files source answer.
 *
 * The entry cannot be imported (it starts the whole app) and its
 * `configureGenerateWindow` statement is wired to the tab manager, so the deps
 * are built here from the same `hosts.a.generate` value the Rust fake reads
 * (crates/shell-ipc/a/src/probe/generate.rs, see its header for the keys), and
 * every host call logs the line the Rust fake logs:
 *
 * - the window: `["new BrowserWindow", id, options]` (the options without the
 *   preload path, `parent` as the window's id), `["win", id, what]`,
 *   `["nativeTheme.on", slot]`, `["nativeTheme.off", slot]`
 * - the deps: `["starredGroupPaths", group]`, `["openTargetTab", handoff, opener]`
 *   (the hand-off's id and time written `ID` and 0), `["webContentsFor", tabId]`,
 *   `["reveal", tabId]`, `["save", kind, wcId, path]` or
 *   `["save", kind, "contents:<wcId>"]`
 * - the reader: `["parseFileToText", path]`
 *
 * The reads of one batch start in an order the TypeScript side does not fix
 * (`inspectMaterial` runs in `Promise.all` over real `stat` calls), so a run of
 * `parseFileToText` lines is logged sorted by path, here and in the probe.
 *
 * Two modules are stood in for by resolve hooks that forward to one object per
 * case (`globalThis[Symbol.for('ipc-diff.a.generate')]`): `@seuoffice/file-parse`
 * (`parseFileToText`, which the Rust port reaches through its `GenerateShell`
 * host; everything else is the real module) and the renderer's
 * `strings-generate` (`generateText`, the host's `generate_text`; a text is its
 * key unless `hosts.a.generate.texts` names it).
 *
 * Not fired, because no channel call reaches them and the probe has no
 * trigger for batch A: `ready-to-show`, `focus`, the theme's `updated` and the
 * window open handler (the Rust unit tests run them). The window's `close()`
 * emits `closed`, as Electron's does. Conversions are not on offer
 * (`openConvertedTab` is not given), so their engines are never asked.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename } from 'node:path'
import { setOpenFilesSource } from '../../../../packages/electron-utils/src/unsaved-files.ts'
import type * as GenerateWindowModule from '../../../../apps/shell/src/main/generate/generate-window.ts'
import type { Call, Case, Group, View } from '../../types.ts'

const MODULE = 'apps/shell/src/main/generate/generate-window.ts'
type GenerateWindow = typeof GenerateWindowModule

type Fn = (...args: unknown[]) => unknown

interface TabSpec {
  id: string
  kind: string
  title?: string
  filePath?: string
  active?: boolean
  dirty?: boolean
}
interface ParseSpec {
  ok?: boolean
  kind?: string
  text?: string
  error?: string
}
/** `hosts.a.generate` */
interface Setup {
  windows?: number[]
  theme?: string
  dark?: boolean
  rendererUrl?: string
  minimized?: number[]
  texts?: Record<string, string>
  starred?: Record<string, string[]>
  tabs?: TabSpec[]
  contents?: Record<string, { id: number; destroyed?: boolean }>
  save?: string[]
  saveResult?: Record<string, false | string>
  cleanOnSave?: boolean
  openTarget?: string
  parse?: Record<string, ParseSpec | string>
}

/** the object the stubs forward to: the current case's stand-in */
const HOST = Symbol.for('ipc-diff.a.generate')

/** logs one read, keeping the run of read lines at the log's end sorted by path */
function pushRead(log: unknown[], path: string): void {
  let start = log.length
  while (start > 0 && (log[start - 1] as unknown[])[0] === 'parseFileToText') start -= 1
  const run = log.splice(start) as [string, string][]
  run.push(['parseFileToText', path])
  run.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  log.push(...run)
}

const realImmediate = globalThis.setImmediate

/**
 * Until the disk work the module started (`inspectMaterial`'s `stat`) is done:
 * the harness waits only a few ticks, which a loaded machine can outrun, while
 * the Rust side is always drained before it answers
 */
async function quiet(): Promise<void> {
  for (let calm = 0, round = 0; calm < 6 && round < 20_000; round++) {
    await new Promise<void>((resolve) => realImmediate(resolve))
    const busy = process
      .getActiveResourcesInfo()
      .some((name) => name.startsWith('FSReq') || name === 'CloseReq')
    calm = busy ? 0 : calm + 1
    if (busy) await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

const FILE_PARSE = 'ipc-diff:file-parse'
const STRINGS = 'ipc-diff:strings-generate'
const realFile = new URL('../../../../packages/file-parse/src/index.ts', import.meta.url).href
const SOURCES: Record<string, string> = {
  [FILE_PARSE]: [
    `export * from ${JSON.stringify(realFile)}`,
    `export const parseFileToText = (...args) => globalThis[Symbol.for('ipc-diff.a.generate')].parseFileToText(...args)`,
  ].join('\n'),
  [STRINGS]: [
    `export const generateText = (lang, key) => globalThis[Symbol.for('ipc-diff.a.generate')].text(key)`,
  ].join('\n'),
}

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@seuoffice/file-parse') return { url: FILE_PARSE, shortCircuit: true }
    if (specifier.endsWith('/i18n/strings-generate')) return { url: STRINGS, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = SOURCES[url]
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return next(url, context)
  },
})

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Shell' },
  { view: 50, window: 50, surface: 'ShellGenerate' },
  { view: 51, window: 51, surface: 'ShellGenerate' },
]
/** from the shell window's own page (Home) */
const home = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
/** from another page of the shell surface */
const other = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
/** from the generate window's page (the first, or the second window made) */
const win = (channel: string, ...args: unknown[]): Call => ({ channel, view: 50, args })
const win2 = (channel: string, ...args: unknown[]): Call => ({ channel, view: 51, args })
const open = (...paths: unknown[]): Call => home('generate:open-with-paths', paths)
const state = (): Call => win('generate:get-state')

const text = (s: string) => ({ text: s })
const files = {
  'a.txt': text('alpha'),
  'b.txt': text('bravo'),
  'c.txt': text('charlie'),
}
const generate = (setup: Setup, rest: Record<string, unknown> = {}) => ({
  a: { generate: setup, ...rest },
})
const dialogs = (...opens: unknown[]) => ({ shared: { dialogs: { open: opens } } })

const deck = '$DIR/deck.docx'
const note = '$DIR/note.md'
const docTab = (dirty = true): TabSpec => ({
  id: 't1',
  kind: 'docs',
  title: 'deck',
  filePath: deck,
  dirty,
})
const docContents = { t1: { id: 40 } }

const cases: Case[] = [
  {
    note: 'Home opens the window with its files: the window, its page loaded, the state pushed; the page reads the state and the theme',
    views,
    files,
    hosts: generate({ theme: 'dark', windows: [50] }),
    calls: [
      open('$DIR/a.txt', '$DIR/b.txt', 'relative.txt', 5, '', '$DIR/a.txt'),
      state(),
      win('generate:get-theme'),
    ],
  },
  {
    note: 'a dark theme, a renderer dev server and texts: the window title, the loaded address, English',
    views,
    files,
    hosts: generate(
      {
        dark: true,
        rendererUrl: 'http://localhost:5173',
        texts: { windowTitle: 'Make' },
      },
      { lang: 'en' },
    ),
    calls: [open('$DIR/a.txt'), state()],
  },
  {
    note: 'before the window exists its channels answer nothing; only Home opens it, and only with a list',
    views,
    files,
    calls: [
      state(),
      win('generate:get-theme'),
      win('generate:make', 'x'),
      win('generate:refresh'),
      win('generate:cancel'),
      other('generate:open-with-paths', ['$DIR/a.txt']),
      other('generate:open-with-group', 'g'),
      home('generate:open-with-paths', 'not a list'),
      state(),
    ],
  },
  {
    note: 'the page of another window, and Home, are not the generate window',
    views,
    files,
    hosts: generate({ windows: [50, 51], theme: 'dark' }),
    calls: [
      open('$DIR/a.txt'),
      win2('generate:get-state'),
      win2('generate:get-theme'),
      win2('generate:set-kind', 'html'),
      state(),
    ],
  },
  {
    note: 'a kind to make, a conversion that is not on offer, removing a row, a key that is no row',
    views,
    files,
    hosts: generate({}),
    calls: [
      open('$DIR/a.txt', '$DIR/b.txt'),
      win('generate:set-kind', 'html'),
      win('generate:set-kind', 'nope'),
      win('generate:set-kind', 5),
      win('generate:set-convert', null),
      win('generate:set-convert', 'mindmap-to-markdown'),
      win('generate:remove-material', '$DIR/a.txt'),
      win('generate:remove-material', '$DIR/nothing.txt'),
      win('generate:remove-material', 7),
      state(),
    ],
  },
  {
    note: 'a markdown file offers a conversion only when the shell can open its result: not here',
    views,
    files: { 'note.md': text('# note') },
    calls: [open(note), state(), win('generate:set-convert', 'markdown-to-mindmap'), state()],
  },
  {
    note: 'rows left out, each for its reason: missing, unsupported, too large for a picture, unreadable, an image, a folder',
    views,
    files: {
      'a.txt': text('alpha'),
      'x.exe': text('binary'),
      'bad.txt': text('x'),
      'throws.txt': text('x'),
      'pic.png': text('x'),
      'dir.txt': { dir: true },
    },
    hosts: generate({
      parse: {
        'bad.txt': { ok: false, error: 'no' },
        'throws.txt': 'throws',
        'pic.png': { ok: true, kind: 'image' },
      },
    }),
    calls: [
      open(
        '$DIR/a.txt',
        '$DIR/gone.txt',
        '$DIR/x.exe',
        '$DIR/bad.txt',
        '$DIR/throws.txt',
        '$DIR/pic.png',
        '$DIR/dir.txt',
      ),
      state(),
    ],
  },
  {
    note: 'a file picked in the window joins the list; cancelling adds nothing; a page that is not the window never reaches the picker',
    views,
    files,
    hosts: { ...generate({}), ...dialogs(['$DIR/c.txt', '$DIR/a.txt'], null) },
    calls: [
      open('$DIR/a.txt'),
      win('generate:add-materials'),
      state(),
      win('generate:add-materials'),
      state(),
      other('generate:open-with-paths', []),
    ],
  },
  {
    note: 'a Starred group opens with its files; an empty name or one that is no text opens nothing',
    views,
    files,
    hosts: generate({ starred: { g1: ['$DIR/a.txt', '$DIR/b.txt'] } }),
    calls: [
      home('generate:open-with-group', ''),
      home('generate:open-with-group', 9),
      other('generate:open-with-group', 'g1'),
      home('generate:open-with-group', 'g1'),
      state(),
      home('generate:open-with-group', 'g2'),
      state(),
    ],
  },
  {
    note: 'opened again with the window up it starts over (a minimized window is restored); one made, closed, and made again is a window of its own',
    views,
    files,
    hosts: generate({ windows: [50, 51], minimized: [50] }),
    calls: [
      open('$DIR/a.txt'),
      open('$DIR/b.txt', '$DIR/c.txt'),
      state(),
      win('generate:cancel'),
      state(),
      open('$DIR/c.txt'),
      win2('generate:get-state'),
    ],
  },
  {
    note: 'make hands the request to a new tab and closes the window: the words trimmed, the materials in order, the opener Home',
    views,
    files,
    hosts: generate({ windows: [50] }),
    calls: [
      open('$DIR/a.txt', '$DIR/b.txt'),
      win('generate:make', '  a deck of two parts  '),
      state(),
      win('generate:cancel'),
    ],
  },
  {
    note: 'make with the box left empty asks for the kind default, in Korean and in English',
    views,
    files,
    hosts: generate({ windows: [50, 51] }),
    calls: [
      open('$DIR/a.txt'),
      win('generate:set-kind', 'mindmap'),
      win('generate:make', '   '),
      open('$DIR/b.txt'),
      win2('generate:make', ''),
    ],
  },
  {
    note: 'make that cannot be: nothing readable, text that is no string, no tab that can open (the window stays, the failure is shown)',
    views,
    files,
    hosts: generate({ openTarget: 'throws' }),
    calls: [
      open('$DIR/gone.txt'),
      win('generate:make', 'x'),
      win('generate:make', 3),
      win('generate:make'),
      win('generate:remove-material', '$DIR/gone.txt'),
      win('generate:add-materials'),
      state(),
    ],
  },
  {
    note: 'make that cannot open a tab keeps the window and says so',
    views,
    files,
    hosts: generate({ openTarget: 'throws' }),
    calls: [open('$DIR/a.txt'), win('generate:make', 'x'), state(), win('generate:make', 'x')],
  },
  {
    note: 'a file open with unsaved changes waits to be saved: the editor is asked, the row is read again and becomes ready',
    views,
    files: { 'deck.docx': text('deck text') },
    hosts: generate({
      tabs: [docTab()],
      contents: docContents,
      save: ['docs'],
    }),
    calls: [
      open(deck),
      state(),
      win('generate:save-material', deck),
      state(),
      win('generate:save-material', deck),
      win('generate:save-material', '$DIR/nothing.docx'),
    ],
  },
  {
    note: 'the editor failed to save, or refused: the failure is shown and the row stays unsaved',
    views,
    files: { 'deck.docx': text('deck text') },
    hosts: generate({
      tabs: [docTab()],
      contents: docContents,
      save: ['docs'],
      saveResult: { docs: 'throws' },
    }),
    calls: [open(deck), win('generate:save-material', deck), state()],
  },
  {
    note: 'a tab that still shows its changes a moment after the save is looked at again',
    views,
    files: { 'deck.docx': text('deck text') },
    hosts: generate({
      tabs: [docTab()],
      contents: docContents,
      save: ['docs'],
      cleanOnSave: false,
    }),
    calls: [open(deck), win('generate:save-material', deck), state()],
  },
  {
    note: "a markdown tab is saved by the editor's own Save; a tab whose format cannot be written in place is brought forward",
    views,
    files: { 'note.md': text('# note'), 'old.doc': text('doc') },
    hosts: generate({
      tabs: [
        { id: 'm1', kind: 'markdown', title: 'note', filePath: note, dirty: true },
        { id: 'd1', kind: 'docs', title: 'old', filePath: '$DIR/old.doc', dirty: true },
      ],
      contents: { m1: { id: 41 }, d1: { id: 42 } },
      save: ['markdown', 'docs'],
    }),
    calls: [
      open(note, '$DIR/old.doc'),
      state(),
      win('generate:save-material', note),
      win('generate:save-material', '$DIR/old.doc'),
      state(),
    ],
  },
  {
    note: 'a tab with no save command is shown, not saved; a tab whose page is gone counts as saved',
    views,
    files: { 'note.md': text('# note'), 'deck.docx': text('x') },
    hosts: generate({
      tabs: [{ id: 'm1', kind: 'markdown', title: 'note', filePath: note, dirty: true }, docTab()],
      contents: { m1: { id: 41 }, t1: { id: 40, destroyed: true } },
    }),
    calls: [
      open(note, deck),
      state(),
      win('generate:save-material', note),
      win('generate:save-material', deck),
      state(),
    ],
  },
  {
    note: 'refresh reads every row again: the missing file stays missing, the readable one is parsed once more',
    views,
    files,
    hosts: generate({}),
    calls: [
      open('$DIR/a.txt', '$DIR/missing.txt'),
      win('generate:refresh'),
      other('generate:open-with-paths', []),
      state(),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as { lang?: string; generate?: Setup }
    const spec = hostsA.generate ?? {}
    const lang = hostsA.lang ?? 'ko'
    const log = cx.electron.log
    const globals = globalThis as Record<symbol, unknown>

    // the open tabs: the list the tab manager and the open-files source answer, kept per case
    const tabs = (spec.tabs ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title ?? '',
      ...(t.filePath !== undefined ? { filePath: t.filePath } : {}),
      active: t.active ?? false,
      dirty: t.dirty ?? false,
    }))
    const list = () => tabs.map((t) => ({ ...t }))
    setOpenFilesSource(async () => list())

    globals[HOST] = {
      text: (key: string) => spec.texts?.[key] ?? key,
      parseFileToText(path: string) {
        pushRead(log, path)
        const named = spec.parse?.[basename(path)]
        if (typeof named === 'string') throw new Error('parse failed')
        if (named !== undefined) return { ...named }
        return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
      },
    }

    // the shell window: the shared mainWindow host, the first Shell view by default
    const caseViews = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
    const shared = (cx.case.hosts?.shared ?? {}) as { mainWindow?: Record<string, unknown> }
    const named = shared.mainWindow
    const main =
      typeof named?.view === 'number' && typeof named?.window === 'number'
        ? caseViews.find((v) => v.view === named.view && (v.window ?? v.view) === named.window)
        : caseViews.find((v) => (v.surface ?? 'Shell') === 'Shell')
    const base = cx.electron.BrowserWindow as { fromId(id: number): unknown }
    const shellWindow = main ? base.fromId(main.window ?? main.view) : null

    // `new BrowserWindow(options)`: the n-th window made is the case's n-th generate window
    let made = 0
    class FakeWindow {
      readonly id: number
      readonly webContents: Record<string, unknown>
      private destroyed = false
      private readonly closed: Fn[] = []
      constructor(options: Record<string, unknown>) {
        this.id = spec.windows?.[made] ?? 50 + made
        made += 1
        this.webContents = cx.electron.contents(this.id) as unknown as Record<string, unknown>
        this.webContents.setWindowOpenHandler = () => {}
        const { parent, webPreferences, ...rest } = options as {
          parent?: { id: number }
          webPreferences: Record<string, unknown>
          [key: string]: unknown
        }
        const shown: Record<string, unknown> = {}
        // the keys in the order of the literal; `preload` is the host's addition, `parent` its id
        for (const key of Object.keys(options)) {
          if (key === 'parent') shown.parent = parent?.id
          else if (key === 'webPreferences') {
            const { preload: _preload, ...kept } = webPreferences
            shown.webPreferences = kept
          } else shown[key] = rest[key]
        }
        log.push(['new BrowserWindow', this.id, shown])
      }
      private note(what: string, ...more: unknown[]) {
        log.push(['win', this.id, what, ...more])
      }
      removeMenu() {
        this.note('removeMenu')
      }
      isDestroyed() {
        return this.destroyed
      }
      isMinimized() {
        return spec.minimized?.includes(this.id) === true
      }
      restore() {
        this.note('restore')
      }
      show() {
        this.note('show')
      }
      focus() {
        this.note('focus')
      }
      close() {
        this.note('close')
        this.destroyed = true
        for (const listener of this.closed) listener()
      }
      setTitleBarOverlay(overlay: unknown) {
        this.note('setTitleBarOverlay', overlay)
      }
      loadURL(url: string) {
        this.note('loadURL', url)
        return Promise.resolve()
      }
      loadFile() {
        this.note('loadFile')
        return Promise.resolve()
      }
      on(event: string, listener: Fn) {
        if (event === 'closed') this.closed.push(listener)
        return this
      }
      once() {
        return this
      }
    }
    Object.assign(FakeWindow, base)

    const watchers: (Fn | null)[] = []
    const nativeTheme = {
      get shouldUseDarkColors() {
        return spec.dark === true
      },
      on(event: string, listener: Fn) {
        if (event !== 'updated') return
        watchers.push(listener)
        log.push(['nativeTheme.on', watchers.length])
      },
      off(event: string, listener: Fn) {
        if (event !== 'updated') return
        const at = watchers.indexOf(listener)
        if (at < 0) return
        watchers[at] = null
        log.push(['nativeTheme.off', at + 1])
      },
    }
    cx.install({ BrowserWindow: FakeWindow, nativeTheme })
    if (spec.rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = spec.rendererUrl

    // an editor's save: the tab it shows is clean afterwards unless the case says it lags
    const result = (kind: string): boolean => {
      const r = spec.saveResult?.[kind]
      if (typeof r === 'string') throw new Error(`${kind} save failed`)
      return r !== false
    }
    const clean = (wcId: number) => {
      if (spec.cleanOnSave === false) return
      for (const t of tabs) if (spec.contents?.[t.id]?.id === wcId) t.dirty = false
    }
    const toPath = (kind: string) => async (wcId: number, path: string) => {
      log.push(['save', kind, wcId, path])
      result(kind)
      clean(wcId)
    }
    const ownSave = (kind: string) => async (contents: { id: number }) => {
      log.push(['save', kind, `contents:${contents.id}`])
      const saved = result(kind)
      if (saved) clean(contents.id)
      return saved
    }
    const saves: Record<string, Fn> = {
      docs: toPath('docs') as Fn,
      sheets: toPath('sheets') as Fn,
      slides: toPath('slides') as Fn,
      markdown: ownSave('markdown') as Fn,
      html: ownSave('html') as Fn,
      mindmap: ownSave('mindmap') as Fn,
    }
    const save = Object.fromEntries((spec.save ?? []).map((kind) => [kind, saves[kind]]))

    const mod = await cx.fresh<GenerateWindow>(MODULE)
    mod.configureGenerateWindow({
      parentWindow: () => shellWindow as never,
      lang: () => lang as never,
      theme: () => (spec.theme ?? 'light') as never,
      openTargetTab: (handoff, opener) => {
        // the id is random and the time the clock's: both are written fixed
        log.push(['openTargetTab', { ...handoff, id: 'ID', createdAt: 0 }, opener])
        if (spec.openTarget === 'throws') throw new Error('no tab could open')
      },
      starredGroupPaths: (group) => {
        log.push(['starredGroupPaths', group])
        return spec.starred?.[group] ?? []
      },
      tabIdFor: () => undefined,
      openMaterials: {
        list: async () => list() as never,
        webContentsFor: (tabId) => {
          log.push(['webContentsFor', tabId])
          const c = spec.contents?.[tabId]
          return c ? ({ id: c.id, isDestroyed: () => c.destroyed === true } as never) : undefined
        },
        reveal: (tabId) => {
          log.push(['reveal', tabId])
        },
        save: save as never,
      },
    })
    // every handler answers once the disk work it started is done
    const invoke = cx.electron.handlers.invoke
    for (const [channel, handler] of [...invoke]) {
      invoke.set(channel, async (...args: unknown[]) => {
        try {
          return await handler(...args)
        } finally {
          await quiet()
        }
      })
    }
  },
  cases,
  single: {
    'generate:set-kind':
      'answers undefined whatever the kind; the pushed state tells the cases apart',
    'generate:set-convert':
      'answers undefined whatever the kind; the pushed state tells the cases apart',
    'generate:add-materials':
      'answers undefined whatever the picker answers; the pushed state and the dialog log tell the cases apart',
    'generate:remove-material':
      'answers undefined whatever the key; the pushed state tells the cases apart',
    'generate:save-material':
      'answers undefined whatever the editor does; the pushed state and the host log tell the cases apart',
    'generate:open-with-paths':
      'answers undefined whoever asks and whatever it is given; the window opened, the state pushed and the host log tell the cases apart',
    'generate:open-with-group':
      'answers undefined whoever asks and whatever it is given; the window opened, the state pushed and the host log tell the cases apart',
  },
}
