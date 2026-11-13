/**
 * Group `w/editor-files`: the editors' file and window channels. `files:*`
 * and `win:*` are `registerDocsIpc()` of apps/docs/src/main/docs-main.ts, run
 * in shell mode (`setDocsShellHooks`); `shell:*` are `registerSheetsIpc()` of
 * apps/sheets/src/main/sheets-main.ts. Both are loaded as
 * `apps/shell/src/main/index.ts` configures them (app-main.ts).
 *
 * What the shell owns comes from `hosts.w`:
 * - `docsTabs`: `[{id, title, focused}]`, what `win:list` lists
 * - `lang`: `getUiLang()`, `ko` by default
 * - `now`: `Date.now()` while a pasted picture is saved
 * - `openFiles`: `setOpenFilesSource` (`[{filePath, dirty}]`, or `"fail"` when it throws)
 * - `sheetsTabs`: the views that are sheets tabs
 *
 * Text files stand for what `parseFileToText` reads (the Rust fake reads
 * UTF-8 text); `.drawio.*` names and formats that need a real parser are not
 * cased.
 */
import { createRequire } from 'node:module'
import { setOpenFilesSource } from '@seuoffice/electron-utils'
import type { Call, Case, FileSpec, Group, View } from '../../types.ts'
import { loadDocsMain, loadSheetsMain } from './app-main.ts'

/** the shape of `hosts.w` of this group */
interface WHosts {
  docsTabs?: { id: string; title: string; focused: boolean }[]
  lang?: 'ko' | 'en'
  now?: number
  openFiles?: { filePath?: string; dirty: boolean }[] | 'fail'
  sheetsTabs?: number[]
}

/** the instance of `@seuoffice/i18n` the apps' CommonJS modules read the language from */
const i18n = createRequire(import.meta.url)('@seuoffice/i18n') as {
  setUiLang: (lang: 'en' | 'ko', requested?: string) => void
}

const NOW = 1_800_000_000_000
const U = { $: 'u' }

const PNG = '89504e470d0a1a0a0000000d49484452'
const JPEG = 'ffd8ffe000104a464946'
const GIF = '474946383961010001000000'
const BIG = 'a'.repeat(5 * 1024 * 1024 + 1)
const HUGE = 'a'.repeat(20 * 1024 * 1024 + 1)

/** a docs view in a window of its own beside the shell's */
const docsViews: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
]
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })

const w = (hosts: WHosts, shared?: unknown) => ({ w: hosts, ...(shared ? { shared } : {}) })
const open = (...answers: (string[] | null)[]) => ({ dialogs: { open: answers } })

const pick = docs('files:pick')
const add = (...paths: unknown[]) => docs('files:add', paths)
const read = (path: unknown, ...rest: unknown[]) => docs('files:read', path, ...rest)
const readImage = (path: unknown) => docs('files:read-image', path)
const pasted = (hex: string, kind: 'u8' | 'ab', ext: unknown): Call => ({
  channel: 'files:add-pasted-image',
  view: 2,
  args: [{ $: 'b', k: kind, i: 0 }, ext],
  buffers: [hex],
})

const attachFiles: Record<string, FileSpec> = {
  'docs/a.txt': 'hello attach',
  'docs/b.csv': 'x,y\n1,2\n',
  'docs/pic.png': { hex: PNG },
  'docs/photo.JPG': { hex: JPEG },
  'docs/report.docx': { hex: '504b0304' },
  'docs/tool.exe': { hex: '4d5a' },
  'docs/README': 'no extension',
  'docs/dir.txt': { dir: true },
}

const cases: Case[] = [
  // ---- files:pick ----
  {
    note: 'the dialog is cancelled',
    views: docsViews,
    calls: [pick],
  },
  {
    note: 'three picks and a folder: accepted, unsupported, missing, not a file',
    views: docsViews,
    files: attachFiles,
    hosts: w(
      {},
      open(['$DIR/docs/a.txt', '$DIR/docs/tool.exe', '$DIR/docs/gone.md', '$DIR/docs/dir.txt']),
    ),
    calls: [pick],
  },
  {
    note: 'the dialog remembers the folder of the last pick',
    views: docsViews,
    files: { ...attachFiles, 'other/c.txt': 'c' },
    hosts: w({}, open(['$DIR/docs/a.txt'], ['$DIR/other/c.txt'], null)),
    calls: [pick, pick, pick, pick],
  },
  {
    note: 'English texts',
    views: docsViews,
    files: attachFiles,
    hosts: w({ lang: 'en' }, open(['$DIR/docs/tool.exe', '$DIR/docs/gone.md'])),
    calls: [pick],
  },
  {
    note: 'a picked list that is empty counts as cancelled',
    views: docsViews,
    hosts: w({}, open([])),
    calls: [pick],
  },
  {
    note: 'the shell surface is not let in',
    views: docsViews,
    calls: [{ channel: 'files:pick', view: 1, args: [] }],
  },

  // ---- files:add ----
  {
    note: 'no paths',
    views: docsViews,
    calls: [add()],
  },
  {
    note: 'every kind of path',
    views: docsViews,
    files: {
      ...attachFiles,
      'docs/old.xmind': { hex: '504b' },
      'docs/Mixed.TXT': 'upper',
      'docs/pic.webp': { hex: '5249464600' },
      'docs/x.y.z.md': '# md',
    },
    calls: [
      add(
        '$DIR/docs/a.txt',
        '$DIR/docs/b.csv',
        '$DIR/docs/pic.png',
        '$DIR/docs/photo.JPG',
        '$DIR/docs/report.docx',
        '$DIR/docs/tool.exe',
        '$DIR/docs/README',
        '$DIR/docs/dir.txt',
        '$DIR/docs/gone.txt',
        '$DIR/docs/old.xmind',
        '$DIR/docs/Mixed.TXT',
        '$DIR/docs/pic.webp',
        '$DIR/docs/x.y.z.md',
      ),
    ],
  },
  {
    note: 'English texts',
    views: docsViews,
    files: attachFiles,
    hosts: w({ lang: 'en' }),
    calls: [
      add('$DIR/docs/tool.exe', '$DIR/docs/dir.txt', '$DIR/docs/gone.txt', '$DIR/docs/a.txt'),
    ],
  },
  {
    note: 'a picture past 5 MB',
    views: docsViews,
    files: { 'big.png': BIG, 'ok.png': { hex: PNG } },
    calls: [add('$DIR/big.png', '$DIR/ok.png')],
  },
  {
    note: 'a list that is not a list, and a path that is not a string',
    views: docsViews,
    calls: [docs('files:add', 5), docs('files:add', [5]), docs('files:add', [U])],
  },

  // ---- files:read ----
  {
    note: 'a whole text, then a slice of it',
    views: docsViews,
    files: { 'a.txt': '안녕하세요 hello' },
    calls: [read('$DIR/a.txt', 0, 100), read('$DIR/a.txt', 2, 3), read('$DIR/a.txt', 50, 3)],
  },
  {
    note: 'offsets and lengths count UTF-16 units',
    views: docsViews,
    files: { 'e.txt': '😀ab😀' },
    calls: [read('$DIR/e.txt', 0, 2), read('$DIR/e.txt', 2, 10), read('$DIR/e.txt', 3, 3)],
  },
  {
    note: 'offset and length are clamped',
    views: docsViews,
    files: { 'long.txt': 'x'.repeat(50_000), 'c.txt': 'abcdef' },
    calls: [
      read('$DIR/long.txt', 0, 1_000_000_000),
      read('$DIR/c.txt', 0, 0),
      read('$DIR/c.txt', -3, -5),
      read('$DIR/c.txt', 1.9, 2.9),
      read('$DIR/c.txt', '1', '2'),
      read('$DIR/c.txt', U, U),
      read('$DIR/c.txt', null, null),
      read('$DIR/c.txt', 'x', 'y'),
      read('$DIR/c.txt'),
    ],
  },
  {
    note: 'files that are not read as text',
    views: docsViews,
    files: { 'a.exe': 'MZ', 'pic.png': { hex: PNG }, README: 'readme', 'B.TXT': 'upper' },
    calls: [
      read('$DIR/a.exe'),
      read('$DIR/pic.png'),
      read('$DIR/README'),
      read('$DIR/B.TXT', 0, 9),
    ],
  },
  {
    note: 'English texts',
    views: docsViews,
    files: { 'a.exe': 'MZ', 'pic.png': { hex: PNG } },
    hosts: w({ lang: 'en' }),
    calls: [read('$DIR/a.exe', 0, 9), read('$DIR/pic.png', 0, 9)],
  },
  {
    note: 'a missing file',
    views: docsViews,
    calls: [read('$DIR/missing.txt', 0, 9)],
  },
  {
    note: 'a file open with unsaved changes is not read',
    views: docsViews,
    files: { 'a.txt': 'dirty', 'b.txt': 'clean', 'c.txt': 'untitled' },
    hosts: w({
      openFiles: [
        { filePath: '$DIR/a.txt', dirty: true },
        { filePath: '$DIR/b.txt', dirty: false },
        { dirty: true },
      ],
    }),
    calls: [read('$DIR/a.txt', 0, 9), read('$DIR/b.txt', 0, 9), read('$DIR/c.txt', 0, 9)],
  },
  {
    note: 'a source that cannot say counts as unsaved',
    views: docsViews,
    files: { 'a.txt': 'x' },
    hosts: w({ openFiles: 'fail' }),
    calls: [read('$DIR/a.txt', 0, 9)],
  },
  {
    note: 'a path that is not a string',
    views: docsViews,
    calls: [read(5, 0, 9), read(null, 0, 9), read(U, 0, 9)],
  },

  // ---- files:read-image ----
  {
    note: 'pictures by extension',
    views: docsViews,
    files: {
      'a.png': { hex: PNG },
      'b.JPG': { hex: JPEG },
      'c.jpeg': { hex: JPEG },
      'd.gif': { hex: GIF },
      'e.webp': { hex: '52494646' },
      'f.txt': 'not a picture',
    },
    calls: ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.txt'].map((f) =>
      readImage(`$DIR/${f}`),
    ),
  },
  {
    note: 'a missing file, a folder, a picture past 5 MB',
    views: docsViews,
    files: { 'd.png': { dir: true }, 'big.png': BIG },
    calls: [readImage('$DIR/gone.png'), readImage('$DIR/d.png'), readImage('$DIR/big.png')],
  },
  {
    note: 'English texts',
    views: docsViews,
    files: { 'f.txt': 'x' },
    hosts: w({ lang: 'en' }),
    calls: [readImage('$DIR/f.txt'), readImage('$DIR/gone.png')],
  },
  {
    note: 'a path that is not a string',
    views: docsViews,
    calls: [readImage(5), readImage(U)],
  },

  // ---- files:add-pasted-image ----
  {
    note: 'pasted pictures are saved under temp, numbered in the order they come',
    views: docsViews,
    hosts: w({ now: NOW }),
    calls: [pasted(PNG, 'u8', 'png'), pasted(JPEG, 'ab', 'JPG'), pasted(GIF, 'u8', 'gif')],
  },
  {
    note: 'what is not a picture is turned away',
    views: docsViews,
    hosts: w({ now: NOW }),
    calls: [
      pasted(PNG, 'u8', 'exe'),
      pasted('', 'u8', 'png'),
      pasted(PNG, 'u8', U),
      docs('files:add-pasted-image', 'text', 'png'),
      docs('files:add-pasted-image', U, U),
    ],
  },
  {
    note: 'English text of the refusal',
    views: docsViews,
    hosts: w({ lang: 'en', now: NOW }),
    calls: [pasted(PNG, 'u8', 'bmp')],
  },
  {
    note: 'files older than a week are pruned on the first save, only then',
    views: docsViews,
    files: {
      'temp/seuoffice-pasted/old.png': { hex: PNG, mtimeMs: 1_700_000_000_000 },
      'temp/seuoffice-pasted/recent.png': { hex: PNG, mtimeMs: 1_799_900_000_000 },
      'temp/seuoffice-pasted/sub': { dir: true },
    },
    hosts: w({ now: NOW }),
    calls: [pasted(PNG, 'u8', 'png')],
  },
  {
    note: 'temp is a file: the folder cannot be made',
    views: docsViews,
    files: { temp: 'in the way' },
    hosts: w({ now: NOW }),
    calls: [pasted(PNG, 'u8', 'png')],
  },
  {
    note: 'the folder cannot be written',
    views: docsViews,
    files: { 'temp/seuoffice-pasted': { dir: true, mode: 0o555 } },
    hosts: w({ now: NOW }),
    calls: [pasted(PNG, 'u8', 'png')],
  },

  // ---- win:* ----
  {
    note: 'no docs tab, then docs tabs',
    views: docsViews,
    calls: [docs('win:list')],
  },
  {
    note: 'the tabs the shell lists',
    views: docsViews,
    hosts: w({
      docsTabs: [
        { id: '3', title: '보고서.docx', focused: false },
        { id: '4', title: 'Untitled', focused: true },
      ],
    }),
    calls: [docs('win:list')],
  },
  {
    note: 'a new tab: blank without a path, the path when there is one',
    views: docsViews,
    calls: [
      docs('win:new', null),
      docs('win:new', '$DIR/a.docx'),
      docs('win:new', ''),
      docs('win:new', U),
      docs('win:new'),
    ],
  },
  {
    note: 'focus a tab',
    views: docsViews,
    calls: [docs('win:focus', '3'), docs('win:focus', 'x'), docs('win:focus', '')],
  },
  {
    note: 'the shell surface is not let in',
    views: docsViews,
    calls: [
      { channel: 'win:list', view: 1, args: [] },
      { channel: 'win:new', view: 1, args: [null] },
      { channel: 'win:focus', view: 1, args: ['3'] },
    ],
  },
]

// ---- shell:* (sheets) ----

const sheetsViews: View[] = [
  { view: 1, window: 1, surface: 'Sheets' },
  { view: 2, window: 2, surface: 'Docs' },
  { view: 3, window: 3, surface: 'Sheets' },
]
const sheets = (channel: string, view: number, ...args: unknown[]): Call => ({
  channel,
  view,
  args,
})
const trusted = w({ sheetsTabs: [1] })
const external = (url: unknown, view = 1) => sheets('shell:open-external', view, url)
const localImage = (input: unknown, view = 1) => sheets('shell:read-local-image', view, input)
const reveal = (input: unknown, view = 1): Call => ({
  channel: 'shell:reveal-link-source',
  kind: 'send',
  view,
  args: [input],
})
const UUID = '11111111-1111-4111-8111-111111111111'

cases.push(
  {
    note: 'open an address: trimmed, logged',
    views: sheetsViews,
    hosts: trusted,
    calls: [
      external('https://example.com/a'),
      external('  http://example.com/b?x=1  '),
      external('mailto:a@example.com'),
      external('javascript:alert(1)'),
      external('not a url'),
      external(5),
      external(U),
    ],
  },
  {
    note: 'the system fails to open it',
    views: sheetsViews,
    hosts: w({ sheetsTabs: [1] }, { osShell: { openExternalError: 'no browser' } }),
    calls: [external('https://example.com/')],
  },
  {
    note: 'a sheets view that is not a tab, and a view of another app',
    views: sheetsViews,
    hosts: trusted,
    calls: [external('https://example.com/', 3), external('https://example.com/', 2)],
  },
  {
    note: 'local pictures by what is inside',
    views: sheetsViews,
    hosts: trusted,
    files: {
      'p.png': { hex: PNG },
      'p.jpg': { hex: JPEG },
      'p.gif': { hex: GIF },
      'short.png': { hex: '89504e47' },
      'home/me.png': { hex: PNG },
      'note.txt': 'not a picture',
      'dir.png': { dir: true },
    },
    calls: [
      localImage({ path: '$DIR/p.png' }),
      localImage({ path: '$DIR/p.jpg' }),
      localImage({ path: '$DIR/p.gif' }),
      localImage({ path: '~/me.png' }),
      localImage({ path: '$DIR/short.png' }),
      localImage({ path: '$DIR/note.txt' }),
      localImage({ path: '$DIR/dir.png' }),
      localImage({ path: '$DIR/gone.png' }),
      localImage({ path: 'p.png' }),
      localImage({ path: '~me.png' }),
    ],
  },
  {
    note: 'English texts',
    views: sheetsViews,
    hosts: w({ sheetsTabs: [1], lang: 'en' }),
    files: { 'note.txt': 'not a picture' },
    calls: [
      localImage({ path: '$DIR/note.txt' }),
      localImage({ path: '$DIR/gone.png' }),
      localImage({ path: 'p.png' }),
    ],
  },
  {
    note: 'a picture past 20 MB',
    views: sheetsViews,
    hosts: trusted,
    files: { 'huge.png': HUGE },
    calls: [localImage({ path: '$DIR/huge.png' })],
  },
  {
    note: 'a request that is not {path}',
    views: sheetsViews,
    hosts: trusted,
    calls: [
      localImage(U),
      localImage(null),
      localImage(5),
      localImage('str'),
      localImage([]),
      localImage({}),
      localImage({ path: '' }),
      localImage({ path: 5 }),
      localImage({ path: null }),
      localImage({ path: 'x'.repeat(1025) }),
      localImage({ path: '/x', extra: 1 }),
      localImage({ other: 1, more: 2 }),
    ],
  },
  {
    note: 'a sender that is not a sheets tab',
    views: sheetsViews,
    hosts: trusted,
    calls: [localImage({ path: '$DIR/p.png' }, 3), localImage({ path: '$DIR/p.png' }, 2)],
  },
  {
    note: 'reveal a link source: nothing to find without a session, never an answer',
    views: sheetsViews,
    hosts: trusted,
    calls: [
      reveal({ sessionId: UUID, index: 1 }),
      reveal({ sessionId: UUID, index: 0 }),
      reveal({ sessionId: 'x', index: 1 }),
      reveal({ sessionId: UUID }),
      reveal({ sessionId: UUID, index: 1, extra: 1 }),
      reveal(U),
      reveal({ sessionId: UUID, index: 1 }, 3),
      reveal({ sessionId: UUID, index: 1 }, 2),
    ],
  },
)

export const group: Group = {
  batch: 'W',
  async load(cx) {
    // the case's own shape (WHosts), written by this file
    const hosts = (cx.case.hosts?.w ?? {}) as WHosts
    i18n.setUiLang(hosts.lang ?? 'ko')
    const source = hosts.openFiles
    setOpenFilesSource(
      source === 'fail'
        ? () => {
            throw new Error('the tabs could not be read')
          }
        : () => source ?? [],
    )
    const log = cx.electron.log
    await loadDocsMain(cx, {
      openTab: (path, options) => log.push(['docs.openTab', path ?? null, options ?? null]),
      listTabs: () => hosts.docsTabs ?? [],
      focusTab: (id) => log.push(['docs.focusTab', id]),
    })
    await loadSheetsMain(cx, hosts.sheetsTabs ?? [])

    // a pasted picture's file is named after the clock: both sides read `hosts.w.now`
    const invoke = cx.electron.handlers.invoke
    const save = invoke.get('files:add-pasted-image')
    if (save) {
      invoke.set('files:add-pasted-image', (...args: unknown[]) => {
        const Real = globalThis.Date
        const now = hosts.now ?? NOW
        class Fixed extends Real {
          constructor(...a: unknown[]) {
            // `new Date()` is the fixed moment; any other form is Date's own
            if (a.length === 0) super(now)
            else super(...(a as [number]))
          }
          static override now(): number {
            return now
          }
        }
        globalThis.Date = Fixed as DateConstructor
        try {
          return save(...args)
        } finally {
          globalThis.Date = Real
        }
      })
    }
  },
  cases,
}
