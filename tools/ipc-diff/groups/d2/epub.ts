/**
 * Group `d2/epub`: the EPUB editor's channels (`apps/epub/src/main/epub-main.ts`
 * and `ai-attachments.ts`), configured as `apps/shell/src/main/index.ts`
 * configures them. The libraries the Rust module keeps behind its host
 * traits (the EPUB engine, file-parse, the result store) are replaced for this
 * process by `epub-fakes/modules.ts`, which answers from the case's
 * `hosts.d2.epub.engine` as the Rust `FakeEngine` does; what the shell gave the
 * editor (`configureEpubRuntime`, `setEpubFileSavedHook`, the save-conflict
 * probe, the open-files source, the UI language, the clock and the random
 * tokens) answers from `hosts.d2.epub.shell` as the Rust `FakeShell` does.
 *
 * A view is set up by the shell (`createEpubView(openPath)`): the
 * `d2/epub:open-view` trigger. A call the shell makes that waits for the
 * renderer (`requestEpubSave`, `requestEpubClose`, `epubReadText`,
 * `epubSaveToPath`) answers at once; `d2/epub:outcome` then tells what it
 * settled to (`null` while it waits).
 *
 * `ai-attachments.ts` keeps its module state for the whole process (the
 * pasted pictures' counter): only one case pastes.
 */
import crypto from 'node:crypto'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setOpenFilesSource, setOpenPathProbe } from '@seuoffice/electron-utils'
import { createRequire } from 'node:module'
import type * as EpubMainModule from '../../../../apps/epub/src/main/epub-main.ts'
import type { Call, Case, Group, TriggerContext } from '../../types.ts'
import { useCase } from './epub-fakes/modules.ts'

const MODULE = 'apps/epub/src/main/epub-main.ts'
type EpubMain = typeof EpubMainModule

// ── the libraries, for this process ──

const FAKES = pathToFileURL(join(import.meta.dirname, 'epub-fakes', 'modules.ts')).href
const REPLACED = new Set([
  '@seuoffice/epub-engine',
  '@seuoffice/file-parse',
  '@seuoffice/pdf-structure/store',
])
registerHooks({
  resolve(specifier, context, next) {
    if (REPLACED.has(specifier)) return { url: FAKES, shortCircuit: true }
    return next(specifier, context)
  },
})

// ── the clock and the random tokens of the case ──

let now = 0
const RealDate = Date
class CaseDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(now)
    else super(...(args as [number]))
  }
  static now(): number {
    return now
  }
}
globalThis.Date = CaseDate as DateConstructor

let tokens = 0
const realRandomBytes = crypto.randomBytes
// `randomBytes(16).toString('hex')`: the asset token and the flush request id
Object.assign(crypto, {
  randomBytes: (size: number, ...rest: unknown[]): unknown => {
    if (size !== 16 || rest.length > 0)
      return Reflect.apply(realRandomBytes, crypto, [size, ...rest])
    const bytes = Buffer.alloc(16)
    bytes.writeBigUInt64BE(BigInt(++tokens), 8)
    return bytes
  },
})
syncBuiltinESMExports()

// ── the case's editor ──

let main: EpubMain
/** the view `createEpubView` makes next takes these contents */
let nextContents: unknown
/** what the last waiting shell call settled to; undefined while it waits */
let outcome: unknown

interface Contents {
  id: number
  [key: string]: unknown
}

/** a fake view's contents with what `grantAndTrack` and `createEpubView` use */
function viewContents(contents: Contents): Contents {
  const added: Record<string, unknown> = {
    setWindowOpenHandler: () => {},
    on: () => contents,
    once: () => contents,
    loadURL: async () => {},
    getURL: () => '',
  }
  for (const [key, value] of Object.entries(added)) {
    if (!(key in contents)) contents[key] = value
  }
  return contents
}

/** starts a shell call that waits; `d2/epub:outcome` tells what it settled to */
function waiting(run: Promise<unknown>): undefined {
  outcome = undefined
  run.then(
    (value) => (outcome = { value }),
    (err: unknown) => (outcome = { error: String(err) }),
  )
  return undefined
}

const triggers: Group['triggers'] = {
  'd2/epub:open-view': (cx: TriggerContext, view, args) => {
    nextContents = viewContents(cx.contents(view) as unknown as Contents)
    main.createEpubView(args[0] as string)
    return undefined
  },
  'd2/epub:request-save': (cx, view, args) =>
    waiting(main.requestEpubSave(cx.contents(view) as never, args[0] as 'save' | 'saveAs')),
  'd2/epub:request-close': (cx, view, args) => {
    const windows = cx.electron.BrowserWindow as { fromId(id: number): unknown }
    const parent = typeof args[0] === 'number' ? windows.fromId(args[0]) : null
    return waiting(main.requestEpubClose(cx.contents(view) as never, parent as never))
  },
  'd2/epub:read-text': (cx, view) => waiting(main.epubReadText(cx.contents(view) as never)),
  'd2/epub:save-to-path': (cx, view, args) =>
    waiting(main.epubSaveToPath(cx.contents(view) as never, args[0] as string)),
  'd2/epub:outcome': () => outcome ?? null,
  'd2/epub:file-renamed': (cx, view, args) => {
    main.epubFileRenamed(cx.contents(view) as never, args[0] as string, args[1] as string)
    return undefined
  },
  'd2/epub:menu-command': (cx, view, args) => {
    main.sendEpubMenuCommand(cx.contents(view) as never, args[0] as never)
    return undefined
  },
  'd2/epub:is-dirty': (_cx, view) => main.epubIsDirty(view),
  'd2/epub:is-translation-locked': (_cx, view) => main.epubIsTranslationLocked(view),
  'd2/epub:file-path': (_cx, view) => main.epubFilePath(view),
}

// ── cases ──

const EPUB = [{ view: 1, window: 1, surface: 'Epub' }]
const TWO = [...EPUB, { view: 2, window: 2, surface: 'Epub' }]
const BOOK = '$DIR/book.epub'
const book = { 'book.epub': 'BOOK' }
/**
 * The reading file cannot be written (the app data folder is a file):
 * positions are keyed by the case-folded path, which the comparison cannot
 * write back as `$DIR`; the copy in memory still answers
 */
const unwritableReading = { userData: 'not a folder' }

const inv = (channel: string, ...args: unknown[]): Call => ({ channel, kind: 'invoke', args })
const snd = (channel: string, ...args: unknown[]): Call => ({ channel, kind: 'send', args })
const trig = (what: string, ...args: unknown[]): Call => ({
  channel: `d2/epub:${what}`,
  kind: 'trigger',
  name: `d2/epub:${what}`,
  args,
})
const on = (view: number, call: Call): Call => ({ ...call, view })
const UNDEFINED = { $: 'u' }
const openView = (path: unknown = BOOK) => trig('open-view', path)
const open = (path: unknown = BOOK) => inv('epub:open-file', path)
const edit = (op: Record<string, unknown>, spineIndex: unknown = 0) =>
  inv('epub:apply-edits', { spineIndex, edits: [op] })
const replace = (version: unknown, start: number, end: number, text: string) =>
  inv('epub:replace-ranges', { spineIndex: 0, version, replacements: [{ start, end, text }] })
const epub = (engine: unknown = {}, shell: unknown = {}, shared: unknown = {}) => ({
  shared,
  d2: { epub: { engine, shell } },
})
/** a book whose one chapter is `text` */
const chapter = (text: string) => ({ readText: { 'OEBPS/c1.xhtml': text } })

const cases: Case[] = [
  {
    note: 'a view the shell did not set up: nothing open, nothing granted',
    views: EPUB,
    calls: [
      inv('epub:consume-pending'),
      open(),
      open(42),
      inv('epub:read-chapter', 0),
      inv('epub:apply-edits', { spineIndex: 0, edits: [] }),
      inv('epub:replace-ranges', {}),
      inv('epub:set-translation-lock', true),
      inv('epub:save', { mode: 'save' }),
      inv('epub:document-hash'),
      inv('epub:translation-units', {}),
      inv('epub:pick-result-path', { kind: 'translated', lang: 'de' }),
      inv('epub:pick-result-target', { kind: 'translated', lang: 'de' }),
      inv('epub:write-translated', { kind: 'translated' }),
      inv('epub:store-translations', 'abc'),
      inv('epub:store-unfinished-jobs', 'abc'),
      snd('epub:dirty-changed', true),
      snd('epub:flush-result', 'x', true),
      snd('epub:close-save-result', true),
      snd('epub:save-request-ack', true),
      snd('epub:set-read-position', { spineIndex: 0, blockId: null }),
      trig('is-dirty'),
      trig('file-path'),
    ],
  },
  {
    note: 'a channel of another surface is refused',
    views: [{ view: 1, surface: 'Docs' }],
    calls: [inv('epub:consume-pending')],
  },
  {
    note: 'the shell sets the view up with its file: it opens; another path does not',
    views: EPUB,
    files: { ...book, 'other.epub': 'OTHER' },
    hosts: epub(),
    calls: [
      openView(),
      inv('epub:consume-pending'),
      open('$DIR/other.epub'),
      // not open yet: the renderer's flag is dropped, and stays dropped once it opens
      snd('epub:dirty-changed', true),
      open(),
      inv('epub:document-hash'),
      inv('epub:read-chapter', 0),
      inv('epub:read-chapter', 3),
      inv('epub:read-chapter', '0'),
      trig('file-path'),
      trig('is-dirty'),
    ],
  },
  {
    note: 'a set-up path that does not exist is not granted',
    views: EPUB,
    calls: [openView('$DIR/missing.epub'), inv('epub:consume-pending'), open('$DIR/missing.epub')],
  },
  {
    note: 'the engine refuses the book: nothing is written, the renderer dirty flag does not count',
    views: EPUB,
    files: book,
    hosts: epub({ open: [{ refused: 'drm' }] }),
    calls: [
      openView(),
      open(),
      snd('epub:dirty-changed', true),
      trig('is-dirty'),
      inv('epub:save', {}),
      inv('epub:read-chapter', 0),
      trig('file-path'),
    ],
  },
  {
    note: 'a file that cannot be read',
    views: EPUB,
    files: { 'book.epub': { dir: true } },
    calls: [openView(), open()],
  },
  {
    note: 'a fixed-layout book with its own document hash',
    views: EPUB,
    files: book,
    hosts: epub({
      open: [
        {
          docHash: 'fixed1',
          summary: {
            opfPath: 'content.opf',
            version: '2',
            metadata: { title: 'T' },
            manifest: [
              {
                id: 'c1',
                href: 'c1.xhtml',
                path: 'c1.xhtml',
                mediaType: 'application/xhtml+xml',
                properties: [],
              },
            ],
            spine: [
              {
                index: 0,
                idref: 'c1',
                path: 'c1.xhtml',
                mediaType: 'application/xhtml+xml',
                linear: true,
                properties: ['page-spread-left'],
                layout: 'pre-paginated',
                fixedLayout: true,
              },
            ],
            pageProgressionDirection: 'rtl',
            toc: { source: 'ncx', entries: [{ label: 'One', href: 'c1.xhtml', depth: 0 }] },
            fixedLayout: true,
            verticalWriting: true,
          },
        },
      ],
    }),
    calls: [
      openView(),
      open(),
      inv('epub:read-chapter', 0),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      inv('epub:document-hash'),
    ],
  },
  {
    note: 'edit, dirty, save writes the edited bytes and moves the stored results; a clean save writes nothing',
    views: EPUB,
    files: book,
    hosts: epub(),
    calls: [
      openView(),
      open(),
      inv('epub:document-hash'),
      edit({ op: 'replace', blockId: 'b1', text: 'hello' }),
      trig('is-dirty'),
      inv('epub:save', { mode: 'save', auto: 'yes' }),
      trig('is-dirty'),
      inv('epub:save'),
      inv('epub:document-hash'),
      inv('epub:consume-pending'),
    ],
  },
  {
    note: 'edits are checked; a running translation locks them',
    views: EPUB,
    files: book,
    hosts: epub(),
    calls: [
      openView(),
      open(),
      inv('epub:apply-edits', { spineIndex: 0, edits: 'no' }),
      inv('epub:apply-edits', {
        spineIndex: 0,
        edits: [{ op: 'replace', blockId: '', text: 'x' }],
      }),
      inv('epub:apply-edits', null),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }, 9),
      edit({ op: 'merge', blockId: 'b1', with: 'next' }),
      inv('epub:set-translation-lock', true),
      trig('is-translation-locked'),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      inv('epub:set-translation-lock', 'yes'),
      edit({ op: 'split', blockId: 'b1', offset: 1 }),
    ],
  },
  {
    note: 'the engine refuses or throws on block edits',
    views: EPUB,
    files: book,
    hosts: epub({
      applyBlockEdits: [
        { refusal: { code: 'no-block', message: 'no such block' }, index: 0 },
        { throw: 'bad edit' },
      ],
    }),
    calls: [
      openView(),
      open(),
      edit({ op: 'delete', blockId: 'b1' }),
      edit({ op: 'delete', blockId: 'b1' }),
    ],
  },
  {
    note: 'deleting the last block, inserting, then a range replacement that splits a block: fresh ids go on',
    views: EPUB,
    files: book,
    hosts: epub(chapter('<p>a</p><p>b</p>')),
    calls: [
      openView(),
      open(),
      inv('epub:read-chapter', 0),
      edit({ op: 'delete', blockId: 'b2' }),
      edit({ op: 'insert_after', blockId: 'b1', text: 'c' }),
      replace(2, 12, 12, '</p><p>d'),
      inv('epub:save', {}),
    ],
  },
  {
    note: 'range replacements: stale, malformed, overlapping, outside the blocks, and back to an old text',
    views: EPUB,
    files: book,
    hosts: epub(),
    calls: [
      openView(),
      open(),
      edit({ op: 'replace', blockId: 'b1', text: 'hello' }),
      replace(0, 3, 8, 'x'),
      replace('1', 3, 8, 'x'),
      inv('epub:replace-ranges', {
        spineIndex: 0,
        version: 1,
        replacements: [{ start: 3, end: 2, text: '' }],
      }),
      replace(1, 0, 1, '<'),
      replace(1, 3, 8, 'OEBPS/c1.xhtml'),
      replace(2, 3, 3, ''),
      inv('epub:read-chapter', 0),
    ],
  },
  {
    note: 'a broken chapter and one not valid in its encoding are read only',
    views: EPUB,
    files: book,
    hosts: epub({
      readText: {
        'OEBPS/c1.xhtml': '<broken',
        'OEBPS/c2.xhtml': { text: '<p>x</p>', valid: false },
      },
      open: [
        {
          summary: {
            opfPath: 'OEBPS/content.opf',
            version: '3',
            metadata: {},
            manifest: [],
            spine: [
              {
                index: 0,
                idref: 'c1',
                path: 'OEBPS/c1.xhtml',
                mediaType: 'application/xhtml+xml',
                linear: true,
                properties: [],
                layout: null,
                fixedLayout: false,
              },
              {
                index: 1,
                idref: 'c2',
                path: 'OEBPS/c2.xhtml',
                mediaType: 'application/xhtml+xml',
                linear: false,
                properties: [],
                layout: null,
                fixedLayout: false,
              },
            ],
            pageProgressionDirection: null,
            toc: { source: 'spine', entries: [] },
            fixedLayout: false,
            verticalWriting: false,
          },
        },
      ],
    }),
    calls: [
      openView(),
      open(),
      inv('epub:read-chapter', 0),
      inv('epub:read-chapter', 1),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }, 1),
    ],
  },
  {
    note: 'the engine refuses the save, then throws',
    views: EPUB,
    files: book,
    hosts: epub({
      save: [{ refused: { reason: 'zip', detail: 'bad entry' } }, { throw: 'disk full' }],
    }),
    calls: [
      openView(),
      open(),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      inv('epub:save', {}),
      inv('epub:save', {}),
      trig('is-dirty'),
    ],
  },
  {
    note: 'save as: cancelled, then a new path without the extension; the shell is told',
    views: EPUB,
    files: book,
    hosts: epub({}, {}, { dialogs: { save: [null, '$DIR/copy'] } }),
    calls: [
      openView(),
      open(),
      inv('epub:save', { mode: 'saveAs' }),
      inv('epub:save', { mode: 'saveAs' }),
      inv('epub:consume-pending'),
      trig('file-path'),
      open('$DIR/copy.epub'),
    ],
  },
  {
    note: 'a menu save waits for the renderer: its save, then its declined ack',
    views: EPUB,
    files: book,
    hosts: epub(),
    calls: [
      openView(),
      open(),
      trig('request-save', 'save'),
      trig('outcome'),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      trig('request-save', 'save'),
      trig('outcome'),
      inv('epub:save', {}),
      trig('outcome'),
      trig('request-save', 'saveAs'),
      snd('epub:save-request-ack', 'yes'),
      trig('outcome'),
    ],
  },
  {
    note: 'closing a dirty book: cancel, do not save, save',
    views: EPUB,
    files: book,
    hosts: epub(
      {},
      {},
      { dialogs: { message: [{ response: 2 }, { response: 1 }, { response: 0 }] } },
    ),
    calls: [
      openView(),
      open(),
      trig('request-close', null),
      trig('outcome'),
      snd('epub:dirty-changed', true),
      trig('is-dirty'),
      trig('request-close', null),
      trig('outcome'),
      trig('request-close', 1),
      trig('outcome'),
      trig('request-close', 1),
      trig('outcome'),
      snd('epub:close-save-result', true),
      trig('outcome'),
      snd('epub:dirty-changed', false),
      trig('is-dirty'),
    ],
  },
  {
    note: 'the close question in Korean, answered false by the renderer',
    views: EPUB,
    files: book,
    hosts: epub({}, { uiLang: 'ko' }),
    calls: [
      openView(),
      open(),
      snd('epub:dirty-changed', true),
      trig('request-close', 1),
      snd('epub:close-save-result', 'true'),
      trig('outcome'),
    ],
  },
  {
    note: 'the MCP read flushes first: done, typing, a stale id, and a book that never opened',
    views: EPUB,
    files: book,
    hosts: epub(chapter('<p>one</p><p>two</p>')),
    calls: [
      openView(),
      trig('read-text'),
      trig('outcome'),
      open(),
      edit({ op: 'replace', blockId: 'b2', text: 'TWO' }),
      trig('read-text'),
      snd('epub:flush-result', '00000000000000000000000000000002', true),
      trig('outcome'),
      trig('read-text'),
      snd('epub:flush-result', 'other', true),
      trig('outcome'),
      snd('epub:flush-result', '00000000000000000000000000000003', 'composing'),
      trig('outcome'),
      trig('read-text'),
      snd('epub:flush-result', '00000000000000000000000000000004', false),
      trig('outcome'),
    ],
  },
  {
    note: 'the MCP save to a path: refused for a book that did not open, then saved there',
    views: EPUB,
    files: book,
    hosts: epub(),
    calls: [
      openView(),
      trig('save-to-path', '$DIR/x.epub'),
      trig('outcome'),
      open(),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      trig('save-to-path', '$DIR/elsewhere.epub'),
      inv('epub:save', {}),
      trig('outcome'),
      trig('file-path'),
      trig('save-to-path', '$DIR/third.epub'),
      snd('epub:save-request-ack', false),
      trig('outcome'),
      trig('file-path'),
    ],
  },
  {
    note: 'the file is renamed on disk; the menu sends commands',
    views: EPUB,
    files: { ...book, ...unwritableReading },
    hosts: epub(),
    calls: [
      openView(),
      open(),
      snd('epub:set-read-position', { spineIndex: 0, blockId: 'b1' }),
      trig('file-renamed', BOOK, '$DIR/renamed.epub'),
      inv('epub:consume-pending'),
      trig('file-path'),
      inv('epub:get-reading-state'),
      trig('menu-command', 'undo'),
      trig('menu-command', 'translate-book'),
    ],
  },
  {
    note: 'view settings go to every other book',
    views: TWO,
    files: { ...book, 'second.epub': 'SECOND' },
    hosts: epub(),
    calls: [
      openView(),
      on(2, openView('$DIR/second.epub')),
      open(),
      inv('epub:get-reading-state'),
      inv('epub:set-view-prefs', { fontScale: 9, lineHeight: 1.5, dark: true }),
      on(2, inv('epub:set-view-prefs', { lineHeight: null, fontScale: 'big' })),
      on(2, inv('epub:set-view-prefs', null)),
      inv('epub:get-reading-state'),
    ],
  },
  {
    note: 'positions are kept per file, in memory when the file cannot be written',
    views: TWO,
    files: { ...book, 'second.epub': 'SECOND', ...unwritableReading },
    hosts: epub(),
    calls: [
      openView(),
      on(2, openView('$DIR/second.epub')),
      open(),
      snd('epub:set-read-position', { spineIndex: 0, blockId: 'b1' }),
      snd('epub:set-read-position', { spineIndex: 4, blockId: null }),
      snd('epub:set-read-position', { spineIndex: -1 }),
      inv('epub:get-reading-state'),
      on(2, inv('epub:get-reading-state')),
      inv('epub:set-view-prefs', { dark: true }),
    ],
  },
  {
    note: 'saved reading state is read once',
    views: EPUB,
    files: {
      ...book,
      'userData/epub-reading.json': JSON.stringify({
        version: 1,
        viewPrefs: { fontScale: 2, lineHeight: 2, dark: false },
        positions: { '$DIR/book.epub': { spineIndex: 0, blockId: 'b9', updatedAt: 5 } },
      }),
    },
    hosts: epub(),
    calls: [openView(), open(), inv('epub:get-reading-state')],
  },
  {
    note: 'links: a safe one opens; an unsafe one, a non-string and a failing one do not',
    views: EPUB,
    files: book,
    hosts: epub({}, {}, { osShell: {} }),
    calls: [
      openView(),
      inv('epub:open-link', ' https://example.org/a '),
      inv('epub:open-link', 'mailto:a@b.c'),
      inv('epub:open-link', 'javascript:alert(1)'),
      inv('epub:open-link', 'file:///etc/passwd'),
      inv('epub:open-link', 7),
    ],
  },
  {
    note: 'opening a link fails at the OS',
    views: EPUB,
    hosts: epub({}, {}, { osShell: { openExternalError: 'no browser' } }),
    calls: [openView(null), inv('epub:open-link', 'https://example.org')],
  },
  {
    note: 'result paths: never the book, a file open in a tab, a relative or non-EPUB path',
    views: TWO,
    files: { ...book, 'second.epub': 'SECOND' },
    hosts: epub({}, { openInTab: ['$DIR/tab.epub'] }),
    calls: [
      openView(),
      on(2, openView('$DIR/second.epub')),
      open(),
      inv('epub:check-result-path', 'rel.epub'),
      inv('epub:check-result-path', '$DIR/a.txt'),
      inv('epub:check-result-path', BOOK),
      inv('epub:check-result-path', '$DIR/second.epub'),
      inv('epub:check-result-path', '$DIR/tab.epub'),
      inv('epub:check-result-path', '$DIR/free.EPUB'),
      inv('epub:check-result-path', 5),
    ],
  },
  {
    note: 'a probe that throws counts as open',
    views: EPUB,
    files: book,
    hosts: epub({}, { openInTab: 'throws' }),
    calls: [openView(), open(), inv('epub:check-result-path', '$DIR/free.epub')],
  },
  {
    note: 'picking a result book: bad requests, the book itself, a granted path, a suggested name',
    views: EPUB,
    files: book,
    hosts: epub(
      {},
      { uiLang: 'ko' },
      {
        dialogs: { save: [BOOK, '$DIR/out', null, '$DIR/named.epub'] },
      },
    ),
    calls: [
      openView(),
      inv('epub:pick-result-target', { kind: 'translated', lang: 'de' }),
      open(),
      inv('epub:pick-result-target', { kind: 'other', lang: 'de' }),
      inv('epub:pick-result-target', { kind: 'translated', lang: 'd' }),
      inv('epub:pick-result-target', { kind: 'translated', lang: 'de' }),
      inv('epub:pick-result-path', { kind: 'bilingual', lang: 'pt-BR' }),
      inv('epub:pick-result-path', { kind: 'translated', lang: 'de' }),
      inv('epub:pick-result-target', { kind: 'translated', lang: 'de', defaultName: 'a/b:c?.txt' }),
    ],
  },
  {
    note: 'writing a translated book: every refusal, then the book, then the path is spent',
    views: EPUB,
    files: book,
    hosts: epub(
      {
        open: [{ docHash: 'h1' }],
        readTranslation: { provider: 'p', model: 'm', blocks: [{ id: 'b1' }, { id: 'b2' }] },
      },
      {},
      { dialogs: { save: ['$DIR/out.epub'] } },
    ),
    calls: [
      openView(),
      open(),
      inv('epub:pick-result-path', { kind: 'translated', lang: 'de' }),
      inv('epub:write-translated', 'x'),
      inv('epub:write-translated', { kind: 'x' }),
      inv('epub:write-translated', { kind: 'translated', mode: 'loud' }),
      inv('epub:write-translated', { kind: 'translated', lang: '1' }),
      inv('epub:write-translated', { kind: 'translated', lang: 'de', chapters: [3] }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/x.epub',
        docHash: 'h1',
      }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h2',
      }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h1',
        chapters: [0],
        mode: 'easy',
      }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h1',
      }),
    ],
  },
  {
    note: 'the engine refuses the translated book; the book went stale after a save',
    views: EPUB,
    files: book,
    hosts: epub(
      {
        open: [{ docHash: 'h1' }, { docHash: 'h2' }],
        buildTranslated: [{ refused: { reason: 'drm', detail: 'locked' } }, { throw: 'boom' }],
      },
      {},
      { dialogs: { save: ['$DIR/out.epub'] } },
    ),
    calls: [
      openView(),
      open(),
      inv('epub:pick-result-path', { kind: 'translated', lang: 'de' }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h1',
      }),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h1',
      }),
      edit({ op: 'replace', blockId: 'b1', text: 'x' }),
      inv('epub:save', {}),
      inv('epub:write-translated', {
        kind: 'translated',
        lang: 'de',
        path: '$DIR/out.epub',
        docHash: 'h1',
      }),
    ],
  },
  {
    note: 'translation units: bad chapters, the units, and an engine failure',
    views: EPUB,
    files: book,
    hosts: epub({
      translationUnits: [
        { units: [{ id: 'u1', text: 'a' }], skipped: [{ spineIndex: 0, reason: 'x' }] },
        { throw: 'parse' },
      ],
    }),
    calls: [
      openView(),
      open(),
      inv('epub:translation-units', { chapters: [1] }),
      inv('epub:translation-units', { chapters: 'all' }),
      inv('epub:translation-units', { chapters: [0] }),
      inv('epub:translation-units'),
    ],
  },
  {
    note: "the result store answers only for the view's hashes",
    views: TWO,
    files: book,
    hosts: epub({
      open: [{ docHash: 'h1' }],
      listTranslations: [['de', 'ko']],
      readTranslation: [{ provider: 'p', model: null, blocks: [{ id: 'b1', text: 't' }] }, null],
      unfinishedJobs: [[{ kind: 'translate', lang: 'de' }]],
      deleteTranslationExceptEdited: [3],
      heartbeatJob: [false],
    }),
    calls: [
      openView(),
      on(2, openView(null)),
      open(),
      inv('epub:document-hash'),
      on(2, inv('epub:store-translations', 'h1')),
      inv('epub:store-translations', 'h1'),
      inv('epub:store-translations', 'h1', 'loud'),
      inv('epub:store-translation', 'h1', 'de', 'easy'),
      inv('epub:store-translation', 'h1', 'de'),
      inv('epub:store-translation', 'h1', 'd e'),
      inv('epub:store-unfinished-jobs', 'h1'),
      inv('epub:store-write', 'x'),
      inv('epub:store-write', {
        kind: 'translationMeta',
        docHash: 'h1',
        lang: 'de',
        provider: 'p',
        model: 'm',
        mode: 'easy',
      }),
      inv('epub:store-write', {
        kind: 'translationBlocks',
        docHash: 'h1',
        lang: 'de',
        blocks: [{ id: 'b1' }],
      }),
      inv('epub:store-write', {
        kind: 'translationBlocks',
        docHash: 'h1',
        lang: 'de',
        blocks: [1],
      }),
      inv('epub:store-write', { kind: 'deleteTranslation', docHash: 'h1', lang: 'de' }),
      inv('epub:store-write', { kind: 'deleteTranslationExceptEdited', docHash: 'h1', lang: 'de' }),
      inv('epub:store-write', {
        kind: 'job',
        docHash: 'h1',
        lang: 'de',
        job: { kind: 'translate', lang: 'de' },
      }),
      inv('epub:store-write', {
        kind: 'job',
        docHash: 'h1',
        lang: 'de',
        job: { kind: 'translate', lang: 'ko' },
      }),
      inv('epub:store-write', { kind: 'heartbeat', docHash: 'h1', lang: 'de', job: 'translate' }),
      inv('epub:store-write', { kind: 'heartbeat', docHash: 'h1', lang: 'de', job: 'translate' }),
      inv('epub:store-write', { kind: 'other', docHash: 'h1', lang: 'de' }),
    ],
  },
  {
    note: 'attachments: kinds and sizes, in Korean; the dialog cancelled and picked',
    views: EPUB,
    files: {
      'notes.txt': 'abcdefgh',
      'tool.exe': 'x',
      'pic.png': 'png',
      sub: { dir: true },
      'diagram.drawio.png': 'png',
    },
    hosts: epub(
      { pictureHoldsDiagram: [false] },
      { uiLang: 'ko' },
      {
        dialogs: { open: [null, ['$DIR/notes.txt', '$DIR/tool.exe']] },
      },
    ),
    calls: [
      openView(null),
      inv('epub:files-add', [
        '$DIR/notes.txt',
        '$DIR/tool.exe',
        '$DIR/gone.txt',
        '$DIR/pic.png',
        5,
        '',
        '$DIR/sub',
      ]),
      inv('epub:files-add', '$DIR/notes.txt'),
      inv('epub:files-add', ['$DIR/diagram.drawio.png']),
      inv('epub:files-pick'),
      inv('epub:files-pick'),
      inv('epub:files-read-image', '$DIR/pic.png'),
      inv('epub:files-read-image', '$DIR/notes.txt'),
      inv('epub:files-read-image', '$DIR/gone.png'),
      inv('epub:files-read-image', 3),
    ],
  },
  {
    note: 'reading an attachment a page at a time; pictures and unknown kinds are not read',
    views: EPUB,
    files: { 'notes.md': 'abcdefgh', 'data.bin': 'x' },
    hosts: epub({
      parseFileToText: ['abcdefgh', { error: 'locked file' }, { error: 'x', damaged: true }],
    }),
    calls: [
      openView(null),
      inv('epub:files-read', '$DIR/notes.md', 2, '3'),
      inv('epub:files-read', '$DIR/notes.md', UNDEFINED, 1e9),
      inv('epub:files-read', '$DIR/notes.md', -4, 0),
      inv('epub:files-read', '$DIR/a.png', 0, 10),
      inv('epub:files-read', '$DIR/data.bin', 0, 10),
      inv('epub:files-read', ''),
      inv('epub:files-read', '$DIR/gone.txt', 0, 10),
    ],
  },
  {
    note: 'the parser fails: its error, or the generic one for a damaged file',
    views: EPUB,
    files: { 'a.md': 'a', 'b.md': 'b' },
    hosts: epub({ parseFileToText: [{ error: 'locked file' }, { error: 'x', damaged: true }] }),
    calls: [
      openView(null),
      inv('epub:files-read', '$DIR/a.md', 0, 5),
      inv('epub:files-read', '$DIR/b.md', 0, 5),
    ],
  },
  {
    note: 'a file open with unsaved changes is not read; a source that fails blocks every read',
    views: EPUB,
    files: { 'draft.txt': 'secret', 'clean.txt': 'ok' },
    hosts: epub({}, { openFiles: [{ filePath: '$DIR/draft.txt', dirty: true }] }),
    calls: [
      openView(null),
      inv('epub:files-read', '$DIR/draft.txt', 0, 10),
      inv('epub:files-read', '$DIR/clean.txt', 0, 10),
    ],
  },
  {
    note: 'pasted pictures land in the temporary folder (the only pasting case: the counter lives for the process)',
    views: EPUB,
    hosts: epub(),
    calls: [
      openView(null),
      {
        ...inv('epub:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'PNG'),
        buffers: ['010203'],
      },
      { ...inv('epub:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'bmp'), buffers: ['01'] },
      { ...inv('epub:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'gif'), buffers: [''] },
      inv('epub:files-add-pasted-image', 'x', 'png'),
      { ...inv('epub:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'webp'), buffers: ['ff'] },
      inv('epub:files-read-image', '$DIR/temp/seuoffice-pasted/pasted-20240101-000000-1.png'),
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    const hosts = (cx.case.hosts ?? {}) as {
      d2?: { epub?: { engine?: unknown; shell?: Record<string, unknown> } }
    }
    const given = hosts.d2?.epub ?? {}
    const shell = given.shell ?? {}
    useCase(given.engine, cx.electron.log)
    now = typeof shell.now === 'number' ? shell.now : 1_704_067_200_000
    tokens = 0
    outcome = undefined
    // the instance the editor reads: the CommonJS app requires its own copy
    const i18n = createRequire(join(process.cwd(), MODULE))('@seuoffice/i18n') as {
      setUiLang(lang: 'en' | 'ko'): void
    }
    i18n.setUiLang(shell.uiLang === 'ko' ? 'ko' : 'en')
    setOpenPathProbe(() => shell.openElsewhere === true)
    const files = shell.openFiles
    setOpenFilesSource(
      files === undefined
        ? null
        : () => {
            if (!Array.isArray(files)) throw new Error('the open files are not known')
            return files as { filePath?: string; dirty: boolean }[]
          },
    )
    cx.install({
      protocol: { handle() {}, registerSchemesAsPrivileged() {} },
      WebContentsView: class {
        webContents = nextContents
      },
    })
    main = await cx.fresh<EpubMain>(MODULE)
    const log = cx.electron.log
    main.configureEpubRuntime({
      preloadPath: '',
      userDataDir: () => join(cx.dir, 'userData'),
      migrateJobRecords: async (_store, oldDocHash, newDocHash) => {
        log.push(['migrateJobRecords', oldDocHash, newDocHash])
        return 0
      },
      isPathOpenInTab: (path) => {
        if (shell.openInTab === 'throws') throw new Error('the tabs are not known')
        return Array.isArray(shell.openInTab) && shell.openInTab.includes(path)
      },
    })
    main.setEpubFileSavedHook((wc, path) => log.push(['fileSavedHook', wc.id, path]))
    // the IPC registers with the first view; this one is no case's and is gone
    nextContents = viewContents({ id: 0, isDestroyed: () => true, send: () => {} })
    main.createEpubView(null as unknown as string)
  },
  triggers,
  cases,
  single: {
    'epub:dirty-changed': 'a send answers nothing; its effect shows in is-dirty and save',
    'epub:flush-result': 'a send answers nothing; its effect shows in the read-text outcome',
    'epub:close-save-result':
      'a send answers nothing; its effect shows in the request-close outcome',
    'epub:save-request-ack': 'a send answers nothing; its effect shows in the request-save outcome',
    'epub:set-read-position': 'a send answers nothing; its effect shows in get-reading-state',
  },
}
