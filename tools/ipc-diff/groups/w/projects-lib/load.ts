/**
 * The world the `w/projects*` groups run `apps/shell/src/main/index.ts` in:
 * the tabs world (tabs-lib/world.ts: the real shell window and `TabManager`,
 * so `projectWindowOf` and `openDocument` answer as the app does) with what
 * the project folder bridge reaches through modules this group cannot replace
 * faked where the TypeScript runs. The Rust side of each fake is
 * `crates/shell-ipc/w/src/projects/probe.rs`, which answers from the same
 * `hosts.w.projects`:
 *
 * - the clock: `Date.now()` and `new Date()` are `hosts.w.nowMs`, the time
 *   zone is UTC;
 * - randomness: `crypto.randomBytes(n)` is `n` bytes of the draw's number among
 *   the draws of `n` bytes, from 1;
 * - `Intl.NumberFormat` and `Intl.DateTimeFormat` print `<lang>#<count>` and
 *   `<lang>@<ms>`;
 * - the file index: `node:sqlite` is a database that opens or throws and the
 *   prototypes of `FileIndexStore` and `FileIndexer` answer from
 *   `hosts.w.fileSearch` and `hosts.w.projects.files`, logging each call;
 * - the open documents `setOpenFilesSource` reads: `projects.openFiles`;
 * - the app-data project store behind "earlier chats of this document":
 *   `ProjectStore.prototype` answers from `projects.store.legacy`;
 * - timers: `setTimeout` of the app's own modules is logged, never run, and
 *   kept so the `w/projects:timer` trigger can fire it (the Rust fakes do the
 *   same); `clearTimeout` is logged;
 * - the page events of the shell view: `w/projects:<event>` triggers emit them
 *   on its fake `webContents`, whose listeners are logged as the tab views'
 *   are (the world's tab views keep none, so only the shell view reports).
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { FileIndexer } from '../../../../../apps/shell/src/main/file-index/indexer.ts'
import { SearchReranker } from '../../../../../apps/shell/src/main/file-index/rerank.ts'
import { FileIndexStore } from '../../../../../apps/shell/src/main/file-index/store.ts'
import type { Call, Case, Group, LoadContext, View } from '../../../types.ts'
import { koStrings } from '../tabs-lib/strings.ts'
import { loadWorld, world } from '../tabs-lib/world.ts'

const require = createRequire(import.meta.url)
/** the copies the CommonJS entry requires: an `import` of a package is another instance */
const { ProjectStore } = require('@seuoffice/project-store') as {
  ProjectStore: { prototype: object }
}
const { setOpenFilesSource } = require('@seuoffice/electron-utils') as {
  setOpenFilesSource(source: (() => Promise<unknown[]>) | null): void
}

// the time zone of the process: the Rust fake answers local dates in UTC
process.env.TZ = 'UTC'
// the folders of the cases are on a real path (no link on the way), as the
// project list keeps a folder by its real path
process.env.TMPDIR = realpathSync('/tmp')

type Json = Record<string, unknown>
type Fn = (...args: unknown[]) => unknown

export const NOW = 1_700_000_000_000

/** `value[key]` of an object of the case, `{}` when absent */
const part = (value: unknown, key: string): Json => (((value ?? {}) as Json)[key] ?? {}) as Json

const RealDate = globalThis.Date
const RealIntl = globalThis.Intl
/** the timers of the process before any case replaced them */
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetImmediate = globalThis.setImmediate

/** the timers the app's own modules set in this case, not yet fired */
const timers: { fn: Fn; ms: number }[] = []

/**
 * The `hosts` of a case: the tabs world (`more` its options, `nowMs` and
 * `defaultSaveDir` among them), `projects` the options of this area, `shared`
 * what the dialogs answer
 */
export function hostsOf(
  projects: Json = {},
  more: Json = {},
  shared: Json = {},
): { w: Json; shared?: Json } {
  const hosts = world({ nowMs: NOW, defaultSaveDir: '$DIR/save', ...more, projects })
  return Object.keys(shared).length > 0 ? { ...hosts, shared } : hosts
}

function installClock(nowMs: number): void {
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(nowMs)
      else super(...(args as [number]))
    }
    static now(): number {
      return nowMs
    }
  }
  globalThis.Date = FakeDate as DateConstructor
}

function installRandom(): () => void {
  const crypto = require('node:crypto') as { randomBytes: (n: number) => Buffer }
  const draws = new Map<number, number>()
  crypto.randomBytes = (n) => {
    const draw = (draws.get(n) ?? 0) + 1
    draws.set(n, draw)
    return Buffer.alloc(n, draw & 0xff)
  }
  return () => draws.clear()
}

function installIntl(): void {
  class NumberFormat {
    constructor(private lang: string) {}
    format(count: number): string {
      return `${this.lang}#${count}`
    }
  }
  class DateTimeFormat {
    constructor(private lang: string) {}
    format(at: Date | number): string {
      return `${this.lang}@${new RealDate(at).getTime()}`
    }
  }
  globalThis.Intl = Object.assign(Object.create(RealIntl), {
    NumberFormat,
    DateTimeFormat,
  }) as typeof Intl
}

interface IndexHit extends Json {
  path: string
}

function installIndex(cx: LoadContext, w: Json): void {
  const search = part(w, 'fileSearch')
  const files = part(part(w, 'projects'), 'files')
  const log = cx.electron.log
  // a database that opens or throws, then answers from the case
  const sqlite = require('node:sqlite') as { DatabaseSync: unknown }
  sqlite.DatabaseSync = class {
    constructor() {
      if (search.unavailable === true) throw new Error('unable to open database file')
    }
    exec() {}
    close() {}
    prepare() {
      return { get: () => undefined, run() {}, all: () => [] }
    }
  }
  Object.assign(FileIndexStore.prototype, {
    search(
      q: string,
      opts: { exts?: string[]; offset: number; limit: number; within?: (path: string) => boolean },
    ) {
      log.push([
        'fileIndexStore.search',
        q,
        { ...(opts.exts ? { exts: opts.exts } : {}), offset: opts.offset, limit: opts.limit },
      ])
      const hits = (part(files, 'results')[q] ?? []) as IndexHit[]
      const kept = hits.filter((hit) => (opts.within ? opts.within(hit.path) : true))
      return { hits: kept.slice(opts.offset, opts.offset + opts.limit), total: kept.length }
    },
    pathsIndexedAsOnDisk: (paths: string[]) =>
      paths.filter((p) => ((files.indexedAsOnDisk ?? []) as string[]).includes(p)),
    count: () => 0,
  })
  Object.assign(FileIndexer.prototype, {
    refreshIfStale: (ms: number) => log.push(['fileIndexer.refreshIfStale', ms]),
    refresh: () => log.push(['fileIndexer.refresh']),
    progress: () => ({ indexed: 0, pending: 0, scanning: false }),
  })
  Object.assign(SearchReranker.prototype, { rerank: async () => null })
}

/** `legacyDocumentChatFor` over a store whose answers are the case's */
function installStore(w: Json): void {
  const legacy = part(part(part(w, 'projects'), 'store'), 'legacy') as Record<string, Json>
  Object.assign(ProjectStore.prototype, {
    knownFilePaths: () => w.projectFiles ?? [],
    fileRenamed: () => {},
    listProjects: () => [],
    chatIdForPath: (path: string, projectId: string) => `${projectId}|${path}`,
    listChats: (projectId: string) =>
      Object.entries(legacy)
        .filter(([, meta]) => meta.projectId === projectId)
        .map(([path, meta]) => ({
          chatId: `${projectId}|${path}`,
          updatedAt: meta.updatedAt,
          approxCount: meta.approxCount,
        })),
  })
}

/**
 * The listeners of the case's views: the fake `webContents` has no `off`, and
 * the world logs the listeners of the tab views it makes (`on`, `once`), so
 * every other view logs them the same way
 */
function installPages(cx: LoadContext): void {
  const log = cx.electron.log
  for (const { view } of cx.case.views ?? [{ view: 1 }]) {
    const contents = cx.electron.contents(view)
    const listen = contents.on.bind(contents)
    const wrapped = new Map<Fn, Fn>()
    const removed = new Set<Fn>()
    const add = (kind: 'on' | 'once') => (event: string, listener: Fn) => {
      log.push([kind, view, event])
      const wrap: Fn = (...args) => (removed.has(wrap) ? undefined : listener(...args))
      wrapped.set(listener, wrap)
      listen(event, wrap)
      return contents
    }
    contents.on = add('on')
    contents.once = add('once')
    contents.off = (event: string, listener: Fn) => {
      log.push(['off', view, event])
      const wrap = wrapped.get(listener)
      if (wrap) removed.add(wrap)
      return contents
    }
  }
}

/** the function that called the faked timer is a module of the app */
const calledByApp = (): boolean =>
  /\/apps\/[a-z]+\/src\//.test((new Error().stack ?? '').split('\n')[3] ?? '')

function installTimers(cx: LoadContext): void {
  timers.length = 0
  let next = 1000
  const log = cx.electron.log
  globalThis.setTimeout = ((fn: Fn, ms?: number, ...rest: unknown[]) => {
    if (!calledByApp()) return realSetTimeout(fn as () => void, ms, ...rest)
    log.push(['setTimeout', ms])
    timers.push({ fn, ms: ms ?? 0 })
    return next++
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer: never) => {
    if (!calledByApp()) return realClearTimeout(timer)
    log.push(['clearTimeout'])
    return undefined
  }) as typeof clearTimeout
}

/**
 * A turn of the harness's `settle` waits this long, so a flow of the TypeScript
 * that runs on file reads (it opens the quoted files of a trust prompt) ends
 * inside the call that started it, as the Rust handlers do: `settleMs` 0 leaves
 * the harness's own turns.
 */
function installSettle(settleMs: number): void {
  if (settleMs === 0) return
  globalThis.setImmediate = ((fn: Fn, ...rest: unknown[]) =>
    calledByApp()
      ? (realSetImmediate as unknown as (fn: Fn, ...args: unknown[]) => unknown)(fn, ...rest)
      : realSetTimeout(() => fn(...rest), settleMs)) as unknown as typeof setImmediate
}

export function loadProjects(settleMs = 0): (cx: LoadContext) => Promise<void> {
  return async (cx) => {
    const w = (cx.case.hosts?.w ?? {}) as Json
    const p = part(w, 'projects')
    installClock((w.nowMs as number | undefined) ?? NOW)
    const resetDraws = installRandom()
    installIntl()
    installIndex(cx, w)
    installStore(w)
    setOpenFilesSource(async () => {
      if (p.openFilesFail === true) throw new Error('open files unavailable')
      return (p.openFiles ?? []) as unknown[]
    })
    await loadWorld(cx)
    // the modules the entry loaded drew some ids of their own
    resetDraws()
    installPages(cx)
    installTimers(cx)
    installSettle(settleMs)
  }
}

/** the page events and timers of the case, as the Rust host reports them */
export const triggers: NonNullable<Group['triggers']> = {
  'w/projects:blur': async (cx, view) => void (await cx.contents(view).emit('blur')),
  'w/projects:focus': async (cx, view) => void (await cx.contents(view).emit('focus')),
  'w/projects:destroyed': async (cx, view) => void (await cx.contents(view).emit('destroyed')),
  'w/projects:navigate': async (cx, view) =>
    void (await cx
      .contents(view)
      .emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })),
  'w/projects:navigate-same': async (cx, view) =>
    void (await cx
      .contents(view)
      .emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })),
  'w/projects:timer': () => {
    for (const timer of timers.splice(0)) timer.fn()
  },
}

// ---- what the cases share ----

export const S = koStrings()

/** the shell view and `n` editor views (the ids the world gives the views it makes) */
export const withViews = (n: number): View[] => [
  { view: 1, window: 1, surface: 'Shell' },
  ...Array.from({ length: n }, (_, i) => ({ view: 100 + i, window: 1, surface: 'Docs' })),
]

export const invoke = (channel: string, ...args: unknown[]): Call => ({ channel, args })
export const send = (channel: string, ...args: unknown[]): Call => ({
  channel,
  kind: 'send',
  args,
})
export const request = (name: string, view: number | undefined, raw?: unknown): Call => ({
  channel: `projectFolder:${name}`,
  ...(view === undefined ? {} : { view }),
  args: raw === undefined ? [] : [raw],
})
export const trigger = (what: string, view = 1): Call => ({
  channel: `w/projects:${what}`,
  kind: 'trigger',
  name: `w/projects:${what}`,
  view,
  args: [],
})

type Files = NonNullable<Case['files']>

/** a project folder of a case: `.seuoffice/project.json` and the files given */
export function projectFolder(folder: string, id: string, name: string, more: Files = {}): Files {
  return {
    [`${folder}/.seuoffice/project.json`]: JSON.stringify({
      version: 1,
      id,
      name,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    ...more,
  }
}

/** `projects` of `app-settings.json` listing the folders given (`$DIR` paths) */
export function projectsSettings(
  list: { id: string; path: string; pinned?: boolean; lastUsedAt?: string }[],
  more: Json = {},
): Files {
  return {
    'userData/app-settings.json': JSON.stringify({
      language: 'ko',
      defaultSaveDir: '$DIR/save',
      projects: {
        installId: 'install-1',
        list: list.map((entry) => ({
          pinned: false,
          lastUsedAt: '2026-01-02T00:00:00.000Z',
          ...entry,
        })),
        trust: {},
        outsideDocuments: {},
        optedOutDocuments: {},
        settings: {},
        ...more,
      },
    }),
  }
}
