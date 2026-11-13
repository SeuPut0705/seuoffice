/**
 * Group `w/home-files`: the home screen's files and folders
 * (`apps/shell/src/main/index.ts` `registerHomeIpc` and the modules it
 * calls). The handlers register at the entry module's scope, so the entry is
 * loaded as the shell loads it (groups/w/shell-index.ts); what it keeps
 * before `app.whenReady()` (no shell window, no tab manager, no document
 * links) is what the Rust hosts answer: nothing open anywhere.
 *
 * What the entry reaches through modules this group cannot replace is faked
 * where the TypeScript runs, and the Rust fakes (crates/shell-ipc/w/src/
 * home_files.rs) answer from the same `hosts.w`:
 *
 * - the file index: `node:sqlite` is a database that opens or throws
 *   (`fileSearch.unavailable`), and the prototypes of `FileIndexStore`,
 *   `FileIndexer` and `SearchReranker` answer from `fileSearch` and log
 *   the call, as the Rust `FileSearch` fake does;
 * - the project store: `ProjectStore.prototype.knownFilePaths` answers
 *   `projectFiles`, `fileRenamed` logs;
 * - the folder watchers: `fs.watch` logs and reports the entries of
 *   `watch` (`{root, changed}` list) once, and the 250 ms debounce of `FolderWatcher` runs on
 *   the next turn;
 * - `Date.now()` is `nowMs`.
 *
 * `mainWindow` of the shared hosts names a window no case has, because the
 * TypeScript's `shellWindow` is null before `whenReady`: a dialog over the
 * shell window has no parent on both sides.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { FileIndexer } from '../../../../apps/shell/src/main/file-index/indexer.ts'
import { SearchReranker } from '../../../../apps/shell/src/main/file-index/rerank.ts'
import { FileIndexStore } from '../../../../apps/shell/src/main/file-index/store.ts'
import type { Case, Group, LoadContext } from '../../types.ts'
import { loadShellIndex } from './shell-index.ts'

const require = createRequire(import.meta.url)
/** the copy the CommonJS entry requires: an `import` of the package is another instance */
const { ProjectStore } = require('@seuoffice/project-store') as {
  ProjectStore: { prototype: object }
}

type Fn = (...args: unknown[]) => unknown

const globals = globalThis as Record<string, unknown>

/** the 250 ms debounce of `FolderWatcher` ends on the next turn, and can be cleared */
function patchTimers(): void {
  if (globals.ipcDiffTimers) return
  globals.ipcDiffTimers = true
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: Fn, ms?: number, ...rest: unknown[]) => {
    if (ms !== 250) return realSet(fn as () => void, ms, ...rest)
    const handle = { cancelled: false, unref() {}, ref() {}, hasRef: () => false }
    setImmediate(() => {
      if (!handle.cancelled) fn(...rest)
    })
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: { cancelled?: boolean } | undefined) => {
    if (handle && typeof handle === 'object' && 'cancelled' in handle) handle.cancelled = true
    else realClear(handle as never)
  }) as typeof clearTimeout
}

export async function load(cx: LoadContext): Promise<void> {
  const w = ((cx.case.hosts ?? {}).w ?? {}) as Record<string, any>
  const search = (w.fileSearch ?? {}) as Record<string, any>
  const log = cx.electron.log
  Date.now = () => (w.nowMs as number | undefined) ?? 1_700_000_000_000
  patchTimers()

  // the file index: a database that opens or throws, then answers from the case
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
    search(q: unknown, opts: { exts?: string[]; offset: number; limit: number }) {
      log.push([
        'fileIndexStore.search',
        q,
        { exts: opts.exts, offset: opts.offset, limit: opts.limit },
      ])
      const result = (search.results ?? {})[q as string] ?? {}
      return { hits: result.hits ?? [], total: result.total ?? 0 }
    },
    pathsIndexedAsOnDisk: (paths: string[]) =>
      paths.filter((p) => ((search.indexedAsOnDisk ?? []) as string[]).includes(p)),
    count: () => 0,
  })
  Object.assign(FileIndexer.prototype, {
    refreshIfStale: (ms: number) => log.push(['fileIndexer.refreshIfStale', ms]),
    refresh: () => log.push(['fileIndexer.refresh']),
    progress: () => ({
      indexed: search.progress?.indexed ?? 0,
      pending: search.progress?.pending ?? 0,
      scanning: search.progress?.scanning ?? false,
    }),
  })
  Object.assign(SearchReranker.prototype, {
    rerank: async (q: unknown, paths: unknown) => {
      log.push(['searchReranker.rerank', q, paths])
      return search.rerank ?? null
    },
  })

  // the project store: the paths it keys on, and the rename it is told of
  Object.assign(ProjectStore.prototype, {
    knownFilePaths: () => w.projectFiles ?? [],
    fileRenamed: (from: string, to: string) => log.push(['projectStore.fileRenamed', from, to]),
  })

  // the folder watchers
  const watched = (w.watch ?? []) as { root: string; changed: string[] }[]
  ;(fs as unknown as Record<string, unknown>).watch = (
    root: string,
    options: unknown,
    callback: (event: string, filename: string) => void,
  ) => {
    log.push(['fs.watch', root, options])
    setImmediate(() => {
      for (const rel of watched.find((x) => x.root === root)?.changed ?? []) callback('change', rel)
    })
    return { on() {}, close: () => log.push(['fsWatcher.close', root]) }
  }

  await loadShellIndex(cx)
}

const MTIME = 1_700_000_000_000
const doc = (n: number) => ({ text: `doc ${n}`, mtimeMs: MTIME + n * 1000 })
const settings = (extra: Record<string, unknown> = {}) => ({
  'userData/app-settings.json': JSON.stringify({
    language: 'ko',
    defaultSaveDir: '$DIR/save',
    ...extra,
  }),
})
/** the shell window is null on the TypeScript side: no host window has this id */
const noShellWindow = { shared: { mainWindow: { view: 99, window: 99 } } }
const call = (channel: string, ...args: unknown[]) => ({ channel, args })

const recent = [
  '$DIR/save/a.docx',
  '$DIR/save/b.xlsx',
  '$DIR/elsewhere/gone.pdf',
  '$DIR/save/sub/c.md',
  '$DIR/elsewhere/d.pptx',
]
const files = {
  ...settings(),
  'save/a.docx': doc(1),
  'save/b.xlsx': doc(2),
  'save/sub/c.md': doc(3),
  'elsewhere/d.pptx': doc(4),
  'userData/recent.json': JSON.stringify(recent),
  'userData/starred.json': JSON.stringify({
    version: 1,
    items: [
      { path: '$DIR/save/b.xlsx', group: 'work' },
      { path: '$DIR/save/sub/c.md' },
      { path: '$DIR/elsewhere/d.pptx', group: 'work' },
      { path: '$DIR/elsewhere/lost.hwp', group: 'old' },
    ],
  }),
}

const hits = [
  {
    path: '$DIR/save/a.docx',
    name: 'a.docx',
    ext: 'docx',
    mtimeMs: MTIME,
    sizeBytes: 5,
    starred: false,
    snippet: null,
    needles: ['a'],
  },
  {
    path: '$DIR/save/b.xlsx',
    name: 'b.xlsx',
    ext: 'xlsx',
    mtimeMs: MTIME,
    sizeBytes: 5,
    starred: false,
    snippet: [{ text: 'sum', hit: true }],
    needles: ['sum'],
  },
]
const indexed = {
  fileSearch: {
    results: { report: { hits, total: 7 } },
    progress: { indexed: 12, pending: 3, scanning: true },
  },
}

const searchCase = (
  note: string,
  calls: Case['calls'],
  w: Record<string, unknown> = indexed,
): Case => ({
  note,
  files,
  hosts: { ...noShellWindow, w },
  calls,
})

const renameFiles = {
  ...files,
  'save/c.md': doc(5),
  'save/taken.docx': doc(6),
  'save/Report.pdf': doc(7),
  'save/deck.pptx': doc(8),
  'save/sub': { dir: true as const },
}

export const cases: Case[] = [
  // ---- recents ----
  {
    note: 'no recent file: an empty page',
    files: settings(),
    calls: [call('home:recents'), call('home:recents', {})],
  },
  {
    note: 'recents: the page, an unavailable path flagged, stars marked',
    files,
    calls: [
      call('home:recents', { offset: 0, limit: 3 }),
      call('home:recents', { offset: 3, limit: 50 }),
    ],
  },
  {
    note: 'recents: extension families and sloppy queries',
    files,
    calls: [
      call('home:recents', { ext: 'docx' }),
      call('home:recents', { ext: ' .XLSX ' }),
      call('home:recents', { ext: 'pptx', limit: 0 }),
      call('home:recents', { offset: '1', limit: '1' }),
      call('home:recents', { offset: -5, limit: 9999 }),
      call('home:recents', { offset: { $: 'n', v: 'NaN' }, limit: { $: 'u' } }),
      call('home:recents', null),
    ],
  },
  {
    note: 'recents: a filter that names a member of Object.prototype throws',
    files,
    calls: [call('home:recents', { ext: 'constructor' })],
  },
  {
    note: 'recents: a corrupt list is empty',
    files: { ...files, 'userData/recent.json': '{oops' },
    calls: [call('home:recents')],
  },

  // ---- starred ----
  {
    note: 'starred: newest first, groups, the star of a missing file kept',
    files,
    calls: [call('home:starred'), call('home:starred', { limit: 2, offset: 1 })],
  },
  {
    note: 'starred: one group, a family, nothing',
    files,
    calls: [
      call('home:starred', { group: 'work' }),
      call('home:starred', { group: 'old', ext: 'hwp' }),
      call('home:starred', { ext: 'md' }),
      call('home:starred', { limit: 0 }),
      call('home:starred', { group: '' }),
      call('home:starred', { ext: 'constructor' }),
    ],
  },
  {
    note: 'starred groups, in first-seen order',
    files,
    calls: [call('home:starred-groups')],
  },
  {
    note: 'no starred file',
    files: settings(),
    calls: [call('home:starred'), call('home:starred-groups')],
  },
  {
    note: 'set a group, clear it, and a name that trims away',
    files,
    calls: [
      call('home:set-starred-group', ['$DIR/save/sub/c.md', '$DIR/nowhere'], '  team  '),
      call('home:starred-groups'),
      call('home:set-starred-group', ['$DIR/save/b.xlsx'], null),
      call('home:set-starred-group', ['$DIR/save/b.xlsx'], ''),
      call('home:set-starred-group', [], 'x'),
      call('home:set-starred-group', 'not a list', 7),
      call('home:starred-groups'),
    ],
  },
  {
    note: 'toggle a star on and off, a legacy flat file is migrated on the write',
    files: { ...files, 'userData/starred.json': JSON.stringify(['$DIR/save/a.docx', 7]) },
    calls: [
      call('home:toggle-star', '$DIR/save/b.xlsx'),
      call('home:toggle-star', '$DIR/save/a.docx'),
      call('home:toggle-star', 5),
      call('home:starred'),
    ],
  },
  {
    note: 'toggle a star with no starred file yet',
    files: settings(),
    calls: [call('home:toggle-star', '$DIR/save/a.docx')],
  },
  {
    note: 'unstar in bulk: nothing matched writes nothing',
    files,
    calls: [
      call('home:unstar-paths', ['$DIR/nowhere']),
      call('home:unstar-paths', ['$DIR/save/b.xlsx', '$DIR/elsewhere/lost.hwp']),
      call('home:unstar-paths', 'x'),
      call('home:starred'),
    ],
  },
  {
    note: 'stat paths: present, missing, starred, and capped at 200',
    files,
    calls: [
      call('home:stat-paths', ['$DIR/save/a.docx', '$DIR/save/b.xlsx', '$DIR/nope.docx']),
      call(
        'home:stat-paths',
        Array.from({ length: 205 }, (_, i) => `$DIR/many/${i}.docx`),
      ),
      call('home:stat-paths', [1, 'x.md']),
      call('home:stat-paths', 'x'),
    ],
  },

  // ---- remove from recents ----
  {
    note: 'remove from recents: an existing file keeps its star, a missing one loses it',
    files,
    calls: [
      call('home:remove-recent', ['$DIR/save/b.xlsx', '$DIR/elsewhere/gone.pdf']),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'remove from recents: a star whose file is gone leaves with the entry',
    files,
    calls: [call('home:remove-recent', ['$DIR/elsewhere/lost.hwp']), call('home:remove-recent', 7)],
  },
  {
    note: 'remove from recents with no recent file writes an empty list',
    files: settings(),
    calls: [call('home:remove-recent', ['$DIR/x.docx'])],
  },

  // ---- search ----
  searchCase(
    'search: a query, the stars marked, the index progress',
    [
      call('home:search-files', { q: ' report ' }),
      call('home:search-files', { q: 'report', ext: 'docx', offset: 2.9, limit: 5 }),
    ],
    {
      ...indexed,
      fileSearch: {
        ...indexed.fileSearch,
        results: { report: { hits: [{ ...hits[1], starred: false }, hits[0]], total: 2 } },
      },
    },
  ),
  searchCase('search: filters, bad numbers, an empty query', [
    call('home:search-files', { q: 'report', ext: 'all' }),
    call('home:search-files', {
      q: 'report',
      ext: 'zip',
      offset: -3,
      limit: { $: 'n', v: 'Infinity' },
    }),
    call('home:search-files', { q: 'report', offset: '4', limit: { $: 'n', v: 'NaN' } }),
    call('home:search-files', { q: '   ' }),
    call('home:search-files', { q: 5 }),
    call('home:search-files', 'report'),
    call('home:search-files'),
  ]),
  searchCase('search: a long query is cut at 200', [
    call('home:search-files', { q: 'x'.repeat(260) }),
  ]),
  searchCase(
    'search: the index cannot open',
    [
      call('home:search-files', { q: 'report' }),
      call('home:search-files', { q: 'other', ext: 'xlsx' }),
    ],
    { fileSearch: { unavailable: true } },
  ),
  searchCase('rerank: off by default', [
    call('home:rerank-search', { q: 'report', paths: ['a', 'b'] }),
  ]),
  {
    note: 'rerank: on, with the judged order',
    files: {
      ...files,
      ...settings({ fileSearch: { rerank: true } }),
    },
    hosts: {
      w: {
        fileSearch: {
          rerank: {
            order: ['$DIR/save/b.xlsx', '$DIR/save/a.docx'],
            scores: { '$DIR/save/b.xlsx': 1.5 },
          },
          indexedAsOnDisk: [
            '$DIR/save/a.docx',
            '$DIR/save/b.xlsx',
            ...Array.from({ length: 30 }, (_, i) => `$DIR/save/${i}.docx`),
          ],
        },
      },
    },
    calls: [
      call('home:rerank-search', {
        q: ' report ',
        paths: ['$DIR/save/a.docx', '$DIR/save/b.xlsx', '$DIR/gone', 3],
      }),
      call('home:rerank-search', { q: 'report', paths: ['$DIR/save/a.docx'] }),
      call('home:rerank-search', { q: '', paths: ['a', 'b'] }),
      call('home:rerank-search', { q: 'report', paths: 'no' }),
      call('home:rerank-search', 'x'),
      call('home:rerank-search', {
        q: 'report',
        paths: Array.from({ length: 30 }, (_, i) => `$DIR/save/${i}.docx`),
      }),
    ],
  },
  {
    note: 'rerank: on, the index cannot open, and no judgement answers',
    files: { ...files, ...settings({ fileSearch: { rerank: true } }) },
    hosts: { w: { fileSearch: { unavailable: true } } },
    calls: [call('home:rerank-search', { q: 'report', paths: ['a', 'b'] })],
  },
  {
    note: 'rerank: on, the model gives no order',
    files: { ...files, ...settings({ fileSearch: { rerank: true } }) },
    hosts: { w: { fileSearch: { rerank: null } } },
    calls: [call('home:rerank-search', { q: 'report', paths: ['a', 'b'] })],
  },
  {
    note: 'rerank: a flag that is not true stays off',
    files: { ...files, ...settings({ fileSearch: { rerank: 'yes' } }) },
    calls: [call('home:rerank-search', { q: 'report', paths: ['a', 'b'] })],
  },

  // ---- open, browse, reveal, trash ----
  searchCase('open: a path asks the index to rescan once the index exists', [
    call('home:open-path', '$DIR/save/a.docx'),
    call('home:search-files', { q: 'report' }),
    call('home:open-path', '$DIR/save/a.docx'),
    call('home:open-path', ''),
    call('home:open-path', 'x'.repeat(4097)),
    call('home:open-path', 'y'.repeat(4096)),
    call('home:open-path', 5),
    call('home:open-path'),
  ]),
  {
    note: 'browse: the picker, then the folder of the last pick',
    files,
    hosts: {
      shared: {
        dialogs: {
          open: [['$DIR/save/a.docx', '$DIR/save/b.xlsx'], null, ['$DIR/elsewhere/d.pptx']],
        },
      },
    },
    calls: [call('home:browse'), call('home:browse'), call('home:browse'), call('home:browse')],
  },
  {
    note: 'browse: from another window',
    files,
    views: [
      { view: 1, window: 1, surface: 'Shell' },
      { view: 2, window: 7, surface: 'Shell' },
    ],
    hosts: { shared: { dialogs: { open: [['$DIR/save/a.docx']] } } },
    calls: [{ channel: 'home:browse', view: 2, args: [] }],
  },
  {
    note: 'reveal in the file manager: an existing path only',
    files,
    calls: [
      call('home:reveal-path', '$DIR/save/a.docx'),
      call('home:reveal-path', '$DIR/save'),
      call('home:reveal-path', '$DIR/nope.docx'),
      call('home:reveal-path', 7),
      call('home:reveal-path'),
    ],
  },
  { note: 'open the trash folder', files: settings(), calls: [call('home:open-trash')] },

  // ---- rename, duplicate, delete ----
  {
    note: 'rename: a file inside the save folder, then the lists follow',
    files: {
      ...renameFiles,
      'userData/recent.json': JSON.stringify(['$DIR/save/c.md', '$DIR/save/a.docx']),
    },
    hosts: { w: { projectFiles: ['$DIR/save/c.md'] } },
    calls: [
      call('home:rename-file', '$DIR/save/c.md', 'notes.md'),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'rename: a starred recent outside the tree keeps its place and group',
    files: renameFiles,
    calls: [
      call('home:rename-file', '$DIR/elsewhere/d.pptx', 'deck2.pptx'),
      call('home:starred'),
      call('home:recents'),
    ],
  },
  {
    note: 'rename: a file only the project store and the slides list know',
    files: {
      ...renameFiles,
      'proj/p.md': doc(1),
      'slides/s.md': doc(2),
      'userData/slides-recent.json': JSON.stringify(['$DIR/slides/s.md']),
    },
    hosts: {
      w: { projectFiles: ['$DIR/proj/p.md'], slidesRecentFile: '$DIR/userData/slides-recent.json' },
    },
    calls: [
      call('home:rename-file', '$DIR/proj/p.md', 'p2.md'),
      call('home:rename-file', '$DIR/slides/s.md', 's2.md'),
      call('home:rename-file', '$DIR/slides/other.md', 'x.md'),
    ],
  },
  {
    note: 'rename: the name is refused',
    files: renameFiles,
    calls: [
      call('home:rename-file', '$DIR/save/c.md', 'report '),
      call('home:rename-file', '$DIR/save/c.md', ' report'),
      call('home:rename-file', '$DIR/save/c.md', ''),
      call('home:rename-file', '$DIR/save/c.md', 'a/b.md'),
      call('home:rename-file', '$DIR/save/c.md', 'CON.md'),
      call('home:rename-file', '$DIR/save/c.md', 'dot.'),
      call('home:rename-file', '$DIR/save/c.md', 'x'.repeat(256)),
    ],
  },
  {
    note: 'rename: arguments of the wrong type, a missing file, a file nobody lists',
    files: renameFiles,
    calls: [
      call('home:rename-file', 5, 'x.md'),
      call('home:rename-file', '$DIR/save/c.md', 5),
      call('home:rename-file', '$DIR/save/none.md', 'x.md'),
      call('home:rename-file', '$DIR/stranger/none.md', 'x.md'),
    ],
  },
  {
    note: 'rename: an extension the app would not open, and one it keeps',
    files: renameFiles,
    calls: [
      call('home:rename-file', '$DIR/save/a.docx', 'a.odt'),
      call('home:rename-file', '$DIR/save/b.xlsx', 'b.ods'),
      call('home:rename-file', '$DIR/save/deck.pptx', 'deck.ppt'),
      call('home:rename-file', '$DIR/save/c.md', 'c.txt'),
    ],
  },
  {
    note: 'rename: to its own name, onto another file, and by case only',
    files: renameFiles,
    calls: [
      call('home:rename-file', '$DIR/save/c.md', 'c.md'),
      call('home:rename-file', '$DIR/save/a.docx', 'taken.docx'),
      call('home:rename-file', '$DIR/save/Report.pdf', 'report.pdf'),
    ],
  },
  {
    note: 'rename onto a hard link of the file itself',
    files: { ...renameFiles, 'save/hl.md': { link: 'save/c.md' } },
    calls: [call('home:rename-file', '$DIR/save/c.md', 'hl.md')],
  },
  {
    note: 'rename a presentation: the template choice follows through the hooks nobody provides here',
    files: renameFiles,
    hosts: { w: { projectFiles: ['$DIR/save/deck.pptx'] } },
    calls: [call('home:rename-file', '$DIR/save/deck.pptx', 'deck-final.pptx')],
  },
  {
    note: 'rename: the recent list cannot be written',
    files: {
      ...renameFiles,
      'userData/recent.json': { text: '["$DIR/save/c.md"]', mode: 0o444 },
      userData: { dir: true as const, mode: 0o555 },
    },
    calls: [call('home:rename-file', '$DIR/save/c.md', 'late.md')],
  },
  {
    note: 'duplicate: the first copy and the next free name',
    files: renameFiles,
    calls: [
      call('home:duplicate-file', '$DIR/save/c.md'),
      call('home:duplicate-file', '$DIR/save/c.md'),
    ],
  },
  {
    note: 'duplicate: a missing file, a file nobody lists, a wrong type',
    files: { ...renameFiles, 'stranger/x.md': doc(9) },
    calls: [
      call('home:duplicate-file', '$DIR/save/none.md'),
      call('home:duplicate-file', '$DIR/stranger/x.md'),
      call('home:duplicate-file', 5),
      call('home:duplicate-file'),
    ],
  },
  {
    note: 'duplicate in English',
    files: { ...renameFiles, ...settings({ language: 'en' }) },
    calls: [call('home:duplicate-file', '$DIR/save/c.md')],
  },
  {
    note: 'delete: to the trash, off the lists; a folder and a stranger stay',
    files: renameFiles,
    calls: [
      call('home:delete-files', [
        '$DIR/save/a.docx',
        '$DIR/elsewhere/gone.pdf',
        '$DIR/save/sub',
        '$DIR/stranger/z.md',
        5,
      ]),
      call('home:recents'),
      call('home:starred'),
    ],
  },
  {
    note: 'delete: the trash refuses, the lists are still cleaned',
    files: renameFiles,
    hosts: { shared: { osShell: { trashError: 'no trash' } } },
    calls: [call('home:delete-files', ['$DIR/save/b.xlsx']), call('home:recents')],
  },
  {
    note: 'delete: nothing to delete, and not a list',
    files: renameFiles,
    calls: [
      call('home:delete-files', []),
      call('home:delete-files', 'x'),
      call('home:delete-files'),
    ],
  },

  // ---- roots ----
  {
    note: 'roots: the save folder, an added folder, and the folder watchers',
    files: {
      ...settings({ folderRoots: ['$DIR/extra', '$DIR/save', 'relative', 7, '$DIR/extra'] }),
      'extra/x.docx': doc(1),
    },
    hosts: {
      w: {
        watch: [
          { root: '$DIR/save', changed: ['a.docx', 'sub'] },
          { root: '$DIR/extra', changed: ['x.docx', ''] },
        ],
      },
    },
    calls: [call('home:folder-roots'), call('home:folder-roots')],
  },
  {
    note: 'roots: an added folder that is gone is listed unreadable',
    files: settings({ folderRoots: ['$DIR/gone'] }),
    calls: [call('home:folder-roots')],
  },
  {
    note: 'roots: the Documents folder is unusable, so new files go to the home folder, said once',
    files: {
      documents: 'not a folder',
      'home/x': { dir: true as const },
      'userData/app-settings.json': '{"language":"ko"}',
    },
    hosts: noShellWindow,
    calls: [call('home:folder-roots'), call('home:folder-roots')],
  },
  {
    note: 'roots: the same in English',
    files: { documents: 'not a folder', 'userData/app-settings.json': '{"language":"en"}' },
    hosts: noShellWindow,
    calls: [call('home:folder-roots')],
  },
  {
    note: 'add a root: picked, then the same folder again, the save folder, a file',
    files: { ...files, 'extra/x.docx': doc(1) },
    hosts: {
      ...noShellWindow,
      shared: {
        ...noShellWindow.shared,
        dialogs: {
          open: [['$DIR/extra'], ['$DIR/extra'], ['$DIR/save'], ['$DIR/save/a.docx'], null, []],
        },
      },
      w: { watch: [{ root: '$DIR/extra', changed: ['x.docx'] }] },
    },
    calls: [
      call('home:folder-root-add'),
      call('home:folder-root-add'),
      call('home:folder-root-add'),
      call('home:folder-root-add'),
      call('home:folder-root-add'),
      call('home:folder-root-add'),
    ],
  },
  {
    note: 'add a root: the index rescans once it exists, and the new root is watched',
    files: { ...files, 'extra/x.docx': doc(1) },
    hosts: {
      ...noShellWindow,
      shared: { ...noShellWindow.shared, dialogs: { open: [['$DIR/extra']] } },
      w: { ...indexed, watch: [{ root: '$DIR/extra', changed: ['x.docx'] }] },
    },
    calls: [call('home:search-files', { q: 'report' }), call('home:folder-root-add')],
  },
  {
    note: 'drop on the roots: folders join, files go to the open pipeline, nothing at all',
    files: { ...files, 'extra/x.docx': doc(1), 'extra2/y.docx': doc(2) },
    hosts: { w: { watch: [{ root: '$DIR/extra', changed: ['x.docx'] }] } },
    calls: [
      call('home:folder-root-drop', [
        '$DIR/extra',
        '$DIR/save/a.docx',
        '$DIR/extra2',
        '$DIR/extra',
      ]),
      call('home:folder-root-drop', ['$DIR/save']),
      call('home:folder-root-drop', []),
      call('home:folder-root-drop', 'x'),
    ],
  },
  {
    note: 'drop a file on the roots',
    files,
    calls: [call('home:folder-root-drop', ['$DIR/save/a.docx'])],
  },
  {
    note: 'remove a root: the listed one, one nobody added, not a path',
    files: {
      ...settings({ folderRoots: ['$DIR/extra', '$DIR/extra2'] }),
      'extra/x.docx': doc(1),
      'extra2/y.docx': doc(2),
    },
    hosts: { w: { watch: [{ root: '$DIR/extra', changed: ['x.docx'] }] } },
    calls: [
      call('home:folder-roots'),
      call('home:folder-root-remove', '$DIR/extra2'),
      call('home:folder-root-remove', '$DIR/extra2'),
      call('home:folder-root-remove', 5),
      call('home:folder-root-remove'),
      call('home:folder-roots'),
    ],
  },
  {
    note: 'a call from a window the channel is not open to is refused',
    files,
    views: [{ view: 2, surface: 'ShellQuickLook' }],
    calls: [call('home:recents')],
  },
]

const answersNothing =
  'answers undefined whatever the arguments: its effect is the folder and the host log after'

export const group: Group = {
  batch: 'W',
  load,
  cases,
  single: Object.fromEntries(
    [
      'home:remove-recent',
      'home:set-starred-group',
      'home:toggle-star',
      'home:unstar-paths',
      'home:open-path',
      'home:reveal-path',
      'home:folder-root-remove',
      'home:duplicate-file',
      'home:delete-files',
    ].map((channel) => [channel, answersNothing]),
  ),
}
