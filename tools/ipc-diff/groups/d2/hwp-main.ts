/**
 * Group `d2/hwp-main`: the Hangul editor's open, save, close and recovery
 * channels (`apps/hwp/src/main/hwp-main.ts`, `recovery.ts`), configured as
 * the shell's entry configures them (`configureHwpRuntime`,
 * `setHwpFileSavedHook`). The libraries the Rust side puts behind
 * `HwpEngine` (tracked-changes.ts, file-parse's rhwp readers) and the crypto
 * UUIDs of the recovery store are fake modules under `hwp/`, answering from
 * the case's `hosts.d2.hwp` as the Rust fakes do; the runtime callbacks log
 * as `HwpShell`'s fake does.
 *
 * The recovery copy of a file is named after a hash of its full path, which
 * differs between the two sides' folders; the cases write untitled copies
 * only (crates/shell-ipc/d2/src/hwp/editor/tests.rs covers file copies).
 */
import { crc32 } from 'node:zlib'
import type { BrowserWindow as BrowserWindowT, WebContents } from 'electron'
import type { EventEmitter } from 'node:events'
import type * as ElectronUtils from '@seuoffice/electron-utils'
import type { FakeContents } from '../../fakes.ts'
import type * as HwpMainModule from '../../../../apps/hwp/src/main/hwp-main.ts'
import type * as RecoveryModule from '../../../../apps/hwp/src/main/recovery.ts'
import type { Call, Case, Group, LoadContext } from '../../types.ts'
import { appRequire, here, setUpCase, swap } from './hwp/common.ts'

type HwpMain = typeof HwpMainModule
type Recovery = typeof RecoveryModule

swap([
  {
    specifier: './tracked-changes',
    from: '/apps/hwp/src/main/hwp-main.ts',
    fake: here('tracked-changes.ts'),
  },
  {
    specifier: '@seuoffice/file-parse',
    from: '/apps/hwp/src/main/hwp-main.ts',
    fake: here('file-parse-text.ts'),
  },
  {
    specifier: '@seuoffice/file-parse',
    from: '/apps/hwp/src/main/memos.ts',
    fake: here('file-parse-text.ts'),
  },
  {
    specifier: 'node:crypto',
    from: '/electron-utils/src/recovery-store.ts',
    fake: here('crypto.ts'),
  },
])

// ---- bytes ----

/** an OLE compound-file header: what `bytesMatchFormat(bytes, 'hwp')` checks */
const HWP = 'd0cf11e0a1b11ae1000102030405'
/** a ZIP local header: an HWPX container to `bytesMatchFormat` */
const HWPX_MAGIC = '504b030409090909'

/** A stored (uncompressed) zip of the given entries */
function zip(entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end]).toString('hex')
}

/** an HWPX whose one body paragraph holds two tabs, the second without a width */
const HWPX_TABS = zip({
  mimetype: 'application/hwp+zip',
  'Contents/section0.xml':
    '<?xml version="1.0"?><hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tab width="400"/><hp:t>a</hp:t><hp:tab width="0" leader="0"/></hp:run></hp:p><hp:p/></hs:sec>',
})

// ---- calls ----

const HWP_VIEW = [{ view: 1, window: 1, surface: 'Hwp' }]
const invoke = (channel: string, args: unknown[] = [], buffers?: string[]): Call => ({
  channel,
  args,
  ...(buffers ? { buffers } : {}),
})
const send = (channel: string, args: unknown[] = []): Call => ({ channel, kind: 'send', args })
const bytes = (i = 0) => ({ $: 'b', k: 'u8', i })
const U = { $: 'u' }

const beginSave = (mode: unknown) => invoke('hwp:begin-save', [mode])
const commit = (hex: string, more: unknown[] = []) =>
  invoke('hwp:commit-save', [bytes(), ...more], [hex])
const saveTo = (...answers: (string | null)[]) => ({ shared: { dialogs: { save: answers } } })
const hwp = (answers: Record<string, unknown>) => ({ d2: { hwp: answers } })

const cases: Case[] = [
  {
    note: 'a view the shell gave no file: nothing queued, nothing kept',
    views: HWP_VIEW,
    calls: [
      invoke('hwp:consume-pending'),
      invoke('hwp:untitled-copy'),
      invoke('hwp:tracking-dropped'),
      invoke('hwp:structure-unverified'),
      invoke('hwp:memo-modal-state'),
      invoke('hwp:consume-headless-export'),
    ],
  },
  {
    note: 'read-file refuses a path the view was not given, of any type',
    views: HWP_VIEW,
    files: { 'a.hwp': { hex: HWP } },
    calls: [
      invoke('hwp:read-file', ['$DIR/a.hwp']),
      invoke('hwp:read-file', [5]),
      invoke('hwp:read-file', []),
    ],
  },
  {
    note: 'only a Hangul view the shell set up takes the memo lock',
    views: HWP_VIEW,
    calls: [send('hwp:memo-modal-open', [true]), invoke('hwp:memo-modal-state')],
  },
  {
    note: 'a new document asks where; cancelled, nothing is pending',
    views: HWP_VIEW,
    calls: [beginSave('save'), commit(HWP)],
  },
  {
    note: 'a new document saved: the file is written, the view follows it, the shell is told',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/out.hwp'),
    calls: [
      beginSave('save'),
      commit(HWP),
      invoke('hwp:consume-pending'),
      invoke('hwp:untitled-copy'),
      commit(HWP),
    ],
  },
  {
    note: 'Save As on an existing file keeps its old bytes beside it, once',
    views: HWP_VIEW,
    files: { 'old.hwp': { hex: '0000' } },
    hosts: saveTo('$DIR/old.hwp', '$DIR/old.hwp'),
    calls: [beginSave('saveAs'), commit(HWP), beginSave('saveAs'), commit(HWP + 'ff')],
  },
  {
    note: 'a bare name takes the format extension; Save As may pick PDF, which saves nothing',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/report', '$DIR/report.pdf'),
    calls: [beginSave('save'), beginSave('saveAs'), commit(HWP)],
  },
  {
    note: 'commit refuses bytes that are not the target format, empty bytes and no bytes',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/a.hwpx', '$DIR/a.hwpx', '$DIR/a.hwpx'),
    calls: [
      beginSave('save'),
      commit(HWP),
      beginSave('save'),
      invoke('hwp:commit-save', [bytes()], ['']),
      beginSave('save'),
      invoke('hwp:commit-save', ['nope']),
    ],
  },
  {
    note: 'an HWPX save with the memo list checks the written memos; the auto flag stands down nothing here',
    views: HWP_VIEW,
    hosts: {
      ...saveTo('$DIR/m.hwpx'),
      ...hwp({ hwp_memos_of: [[{ author: 'a', text: 'kept', place: 'body' }]] }),
    },
    calls: [
      beginSave('save'),
      commit(HWPX_MAGIC, [
        U,
        {
          auto: true,
          memos: [
            { author: 'a', date: null, text: 'kept', place: 'body', path: null },
            { author: 'a', date: null, text: 'lost', place: 'body' },
          ],
        },
      ]),
    ],
  },
  {
    note: 'a project folder of the view is where a new document is offered; in Korean',
    views: HWP_VIEW,
    files: { proj: { dir: true } },
    hosts: hwp({ new_document_dir: '$DIR/proj', ui_lang: 'ko' }),
    calls: [beginSave('save'), beginSave('saveAs')],
  },
  {
    note: 'the default format from Settings: hwpx',
    views: HWP_VIEW,
    files: { 'userData/app-settings.json': '{"hwpDefaultFormat":"hwpx"}' },
    calls: [beginSave('save')],
  },
  {
    note: 'new-tabs answers only during a save, for bytes of its format',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/t.hwpx'),
    calls: [
      invoke('hwp:new-tabs', [bytes(), 'hwpx'], [HWPX_TABS]),
      beginSave('save'),
      invoke('hwp:new-tabs', [bytes(), 'hwpx'], [HWPX_TABS]),
      invoke('hwp:new-tabs', [bytes(), 'hwp'], [HWPX_TABS]),
      invoke('hwp:new-tabs', ['x', 'hwpx']),
    ],
  },
  {
    note: 'abort-save drops the pending save',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/a.hwp'),
    calls: [beginSave('save'), send('hwp:abort-save'), commit(HWP)],
  },
  {
    note: "the editor's File menu sends what the keys send; one save at a time",
    views: HWP_VIEW,
    calls: [
      send('hwp:file-command', ['preview']),
      send('hwp:file-command', ['print']),
      send('hwp:file-command', ['pdf']),
      send('hwp:file-command', ['importPdf']),
      send('hwp:file-command', ['bogus']),
      send('hwp:file-command', ['saveAs']),
      send('hwp:file-command', ['save']),
    ],
  },
  {
    note: "a menu save ends with the renderer's begin-save cancel; the next one goes out",
    views: HWP_VIEW,
    calls: [
      send('hwp:file-command', ['save']),
      beginSave('save'),
      send('hwp:file-command', ['save']),
    ],
  },
  {
    note: 'answers nobody waits for change nothing',
    views: HWP_VIEW,
    calls: [
      send('hwp:close-save-result', [true]),
      send('hwp:read-bytes-result', [{ ok: true }]),
      send('hwp:headless-export-done', [{ ok: true }]),
      send('hwp:dirty-changed', [true]),
      send('hwp:dirty-changed', ['yes']),
      send('hwp:abort-save'),
      send('hwp:recovery-flushed', [1]),
      send('hwp:recovery-flushed', ['1']),
    ],
  },
  {
    note: 'a view the channels are not open to is refused',
    views: [{ view: 2, surface: 'Docs' }],
    calls: [beginSave('save'), send('hwp:dirty-changed', [true])],
  },

  // ---- recovery ----
  {
    note: "a new document's turn writes its untitled copy",
    views: HWP_VIEW,
    calls: [
      invoke('hwp:recovery-write', [bytes(), 'hwp', []], [HWP]),
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-new-tabs', [bytes(), 'hwp'], [HWP]),
      invoke('hwp:recovery-write', [bytes(), 'hwp', []], [HWP]),
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-write', [bytes(), 'hwp'], [HWP + 'aa']),
    ],
  },
  {
    note: 'a write in another format than the turn, or of no file, is refused',
    views: HWP_VIEW,
    calls: [
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-write', [bytes(), 'hwpx'], [HWPX_MAGIC]),
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-write', [bytes(), 'hwp'], ['00']),
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-write', ['x', 'hwp']),
    ],
  },
  {
    note: 'an HWPX new document: its turn finds the tabs of the copy',
    views: HWP_VIEW,
    files: { 'userData/app-settings.json': '{"hwpDefaultFormat":"hwpx"}' },
    calls: [
      invoke('hwp:recovery-new-tabs', [bytes(), 'hwpx'], [HWPX_TABS]),
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-new-tabs', [bytes(), 'hwpx'], [HWPX_TABS]),
    ],
  },
  {
    note: 'a password-protected document: one notice, then no copy',
    views: HWP_VIEW,
    calls: [
      invoke('hwp:recovery-opened', [false]),
      invoke('hwp:recovery-opened', [true]),
      invoke('hwp:recovery-opened', [true]),
      invoke('hwp:recovery-begin'),
    ],
  },
  {
    note: 'the notice in Korean',
    views: HWP_VIEW,
    hosts: hwp({ ui_lang: 'ko' }),
    calls: [invoke('hwp:recovery-opened', [true])],
  },
  {
    note: 'a headless export keeps no copy',
    views: HWP_VIEW,
    hosts: hwp({ is_headless_mode: true }),
    calls: [invoke('hwp:recovery-begin')],
  },
  {
    note: 'a save lands: the untitled copy goes',
    views: HWP_VIEW,
    hosts: saveTo('$DIR/s.hwp'),
    calls: [
      invoke('hwp:recovery-begin'),
      invoke('hwp:recovery-write', [bytes(), 'hwp'], [HWP]),
      beginSave('save'),
      commit(HWP),
      invoke('hwp:recovery-write', [bytes(), 'hwp'], [HWP]),
    ],
  },
]

/** A step that runs a call of the shell into the editor (tools/ipc-diff's `trigger`) */
const trigger = (what: string, view: number, args: unknown[] = []) => ({
  kind: 'trigger',
  name: `d2/hwp:${what}`,
  view,
  args,
})
const openView = (view: number, path: string | null) => trigger('open-view', view, [path])
const TWO_PANES = [
  { view: 1, window: 1, surface: 'Hwp' },
  { view: 2, window: 1, surface: 'Hwp' },
]

/**
 * The cases that need a view the shell set up on a file, or a call of the
 * shell into the editor: they join `cases` once tools/ipc-diff runs
 * `trigger` steps.
 */
export const triggerCases = [
  {
    note: 'a tab on a file reads it, and only it',
    views: HWP_VIEW,
    files: { 'a.hwp': { hex: HWP }, 'b.hwp': { hex: HWP } },
    calls: [
      openView(1, '$DIR/a.hwp'),
      invoke('hwp:consume-pending'),
      invoke('hwp:read-file', ['$DIR/a.hwp']),
      invoke('hwp:read-file', ['$DIR/b.hwp']),
      invoke('hwp:tracking-dropped'),
    ],
  },
  {
    note: 'tracked changes taken out on read; a save of the opened file is refused when they cannot be',
    views: HWP_VIEW,
    files: { 'a.hwp': { hex: HWP } },
    hosts: hwp({ tracked_changes_of: ['tracked', 'tracked'], without_tracked_changes: [null] }),
    calls: [
      openView(1, '$DIR/a.hwp'),
      invoke('hwp:read-file', ['$DIR/a.hwp']),
      invoke('hwp:tracking-dropped'),
      beginSave('save'),
    ],
  },
  {
    note: 'an open memo editor blocks the menu save and begin-save',
    views: HWP_VIEW,
    calls: [
      openView(1, null),
      send('hwp:memo-modal-open', [true]),
      invoke('hwp:memo-modal-state'),
      send('hwp:file-command', ['save']),
      beginSave('save'),
      send('hwp:file-command', ['importPdf']),
    ],
  },
  {
    note: 'closing a dirty tab asks; Save asks the renderer, which answers',
    views: HWP_VIEW,
    hosts: { shared: { dialogs: { message: [{ response: 0 }] } } },
    calls: [
      openView(1, null),
      send('hwp:dirty-changed', [true]),
      trigger('request-close', 1, [1]),
      send('hwp:close-save-result', [true]),
    ],
  },
  {
    note: 'the open document read as text: the renderer hands its bytes',
    views: HWP_VIEW,
    hosts: hwp({ hwp_to_text: 'hello' }),
    calls: [
      openView(1, null),
      trigger('read-text', 1),
      send('hwp:read-bytes-result', [{ ok: true, bytes: bytes() }]),
    ],
  },
  {
    note: 'the OS session ends: a dirty tab is asked for its copy',
    views: TWO_PANES,
    calls: [
      openView(1, null),
      openView(2, null),
      send('hwp:dirty-changed', [true]),
      trigger('write-copies-now', 1),
      send('hwp:recovery-flushed', [1]),
    ],
  },
  {
    note: 'a save removes the copy two panes of one file shared; the other pane is told',
    views: TWO_PANES,
    files: { 'a.hwp': { hex: HWP } },
    calls: [
      openView(1, '$DIR/a.hwp'),
      openView(2, '$DIR/a.hwp'),
      invoke('hwp:recovery-begin', [], undefined),
      invoke('hwp:recovery-write', [bytes(), 'hwp'], [HWP]),
      beginSave('save'),
      commit(HWP + 'ee'),
    ],
  },
  {
    note: 'a headless export hands its target once and ends with the report',
    views: [...HWP_VIEW, { view: 900, surface: 'Hwp' }],
    files: { 'in.hwp': { hex: HWP } },
    calls: [
      trigger('export-hwp-pdf-headless', 1, ['$DIR/in.hwp', '$DIR/out.pdf']),
      { ...invoke('hwp:consume-headless-export'), view: 900 },
      { ...invoke('hwp:consume-headless-export'), view: 900 },
      { ...send('hwp:headless-export-done', [{ ok: false, error: 'no pages' }]), view: 900 },
    ],
  },
  {
    note: 'the recovery slot of a tab, and the shell renaming its file',
    views: HWP_VIEW,
    files: { 'a.hwp': { hex: HWP } },
    calls: [
      openView(1, '$DIR/a.hwp'),
      trigger('recovery-identity', 1),
      trigger('file-renamed', 1, ['$DIR/a.hwp', '$DIR/b.hwp']),
      invoke('hwp:consume-pending'),
      trigger('is-dirty', 1),
      trigger('export-request', 1, ['pdf']),
      trigger('request-preview', 1, ['print']),
    ],
  },
]

/** The fake `webContents` members hwp-main.ts and recovery.ts reach beyond fakes.ts */
function extendContents(cx: LoadContext, headless: { view: number | null }): void {
  for (const v of cx.case.views ?? [{ view: 1 }]) {
    const wc = cx.electron.contents(v.view) as FakeContents & Record<string, unknown>
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const add = (name: string, fn: (...a: unknown[]) => void) =>
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    Object.assign(wc, {
      on: (name: string, fn: (...a: unknown[]) => void) => (add(name, fn), wc),
      once: (name: string, fn: (...a: unknown[]) => void) => (add(name, fn), wc),
      emit: (name: string, ...a: unknown[]) => {
        for (const fn of listeners.get(name) ?? []) fn(...a)
      },
      setWindowOpenHandler: () => {},
      loadURL: async () => {
        if (headless.view === v.view) cx.electron.log.push(['webContents.loadURL', v.view])
      },
      reload: () => cx.electron.log.push(['webContents.reload', v.view]),
      copy: () => cx.electron.log.push(['webContents.copy', v.view]),
      cut: () => cx.electron.log.push(['webContents.cut', v.view]),
      mainFrame: undefined,
    })
  }
}

/** What a case's triggers reach: its loaded entry and its views as Electron's `WebContents` */
interface Entry {
  main: HwpMain
  recovery: Recovery
  /** the fake contents of a view, standing for Electron's */
  wc(view: number): WebContents
  BrowserWindow: { fromId(id: number): BrowserWindowT | null }
  /** the view the next `new WebContentsView` takes (createHwpView) */
  next: { view: number }
}
let entry: Entry | null = null

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    const w = setUpCase(cx)
    const headless: { view: number | null } = { view: null }
    extendContents(cx, headless)
    const BrowserWindow = Object.assign(function () {
      w.log.push(['new BrowserWindow'])
      const made = w.answers.next('create_headless_view')
      const view = typeof made === 'number' ? made : 900
      headless.view = view
      let destroyed = false
      return {
        id: view,
        webContents: cx.electron.contents(view),
        isDestroyed: () => destroyed,
        destroy: () => {
          w.log.push(['BrowserWindow.destroy', view])
          destroyed = true
        },
      }
    }, cx.electron.BrowserWindow as object)
    // hwp-main.ts registers its channels with its first view (registerHwpIpc is
    // not exported); the shell registers them at start. A destroyed view 0,
    // in no case, stands for that first view.
    const first = {
      id: 0,
      isDestroyed: () => true,
      send: () => {},
      on: () => first,
      once: () => first,
      setWindowOpenHandler: () => {},
      loadURL: async () => {},
    }
    const next = { view: 0 }
    const WebContentsView = function () {
      return { webContents: next.view === 0 ? first : cx.electron.contents(next.view) }
    }
    cx.install({ BrowserWindow, WebContentsView })
    const utils = appRequire('@seuoffice/electron-utils') as typeof ElectronUtils
    utils.setOpenPathProbe((path) => {
      w.log.push(['openPathProbe', path])
      return w.answers.next('is_path_open_elsewhere') === true
    })
    const main = await cx.fresh<HwpMain>('apps/hwp/src/main/hwp-main.ts')
    main.configureHwpRuntime({
      preloadPath: '',
      openFileDialog: () => void w.log.push(['runtime.openFileDialog']),
      goHome: () => void w.log.push(['runtime.goHome']),
      newDocument: () => void w.log.push(['runtime.newDocument']),
      importPdf: () => void w.log.push(['runtime.importPdf']),
      newDocumentDir: async (id) => {
        w.log.push(['runtime.newDocumentDir', id])
        const dir = w.answers.next('new_document_dir')
        return typeof dir === 'string' ? dir : null
      },
    })
    main.setHwpFileSavedHook((wc, path) => void w.log.push(['fileSavedHook', wc.id, path]))
    main.createHwpView(null)
    // the fake contents stand for Electron's in the module's signatures
    const contents = cx.electron.contents as unknown as (view: number) => WebContents
    entry = {
      main,
      recovery: appRequire('./recovery') as Recovery,
      wc: contents,
      BrowserWindow: cx.electron.BrowserWindow as Entry['BrowserWindow'],
      next,
    }
  },
  cases,
  single: {
    'hwp:abort-save': 'a send: it answers nothing; the next commit-save shows its effect',
    'hwp:close-save-result': 'a send: settles a close the shell asked for (a trigger)',
    'hwp:read-bytes-result': 'a send: settles a read the shell asked for (a trigger)',
    'hwp:headless-export-done': 'a send: settles a headless export (a trigger)',
    'hwp:dirty-changed': 'a send: its effect shows through the close guard (a trigger)',
    'hwp:file-command': 'a send: what it does shows as the events it emits',
    'hwp:memo-modal-open': 'a send: its effect shows in memo-modal-state and begin-save',
    'hwp:recovery-flushed': 'a send: settles a flush the shell asked for (a trigger)',
  },
}

/** emits a `webContents` event on a view's fake contents */
function emit(view: number, name: string, ...args: unknown[]): void {
  ;(entry!.wc(view) as unknown as EventEmitter).emit(name, ...args)
}

/**
 * The shell's calls into the editor, by trigger name (`d2/hwp:<what>`), as
 * `crates/shell-ipc/d2/src/hwp/probe.rs` runs them
 */
export const triggers: Record<string, (view: number, args: unknown[]) => Promise<unknown>> = {
  'open-view': async (view, args) => {
    const e = entry!
    e.next.view = view
    const option = args[1]
    e.main.createHwpView((args[0] as string | null | undefined) ?? null, {
      untitledCopy:
        option === true
          ? true
          : option && typeof option === 'object'
            ? (option as { baseName: string })
            : undefined,
    })
  },
  'request-save': (view, args) =>
    entry!.main.requestHwpSave(entry!.wc(view), args[0] === 'saveAs' ? 'saveAs' : 'save'),
  'request-close': (view, args) => {
    const parent = typeof args[0] === 'number' ? entry!.BrowserWindow.fromId(args[0]) : null
    return entry!.main.requestHwpClose(entry!.wc(view), parent)
  },
  'read-text': (view) => entry!.main.hwpReadText(entry!.wc(view)),
  'file-renamed': async (view, args) =>
    entry!.main.hwpFileRenamed(entry!.wc(view), String(args[0]), String(args[1])),
  // DocumentEditors' export request: the File menu's PDF export
  'export-request': async (view, args) => {
    if (args[0] === 'pdf') entry!.main.requestHwpPrint(entry!.wc(view), 'pdf')
  },
  'request-preview': async (view, args) =>
    entry!.main.requestHwpPreview(entry!.wc(view), args[0] === 'print' ? 'print' : 'open'),
  'is-dirty': async (view) => entry!.main.hwpIsDirty(view),
  'memo-modal-open': async (view) => entry!.main.hwpMemoModalOpen(view),
  'recovery-identity': async (view) => entry!.main.hwpRecoveryIdentity(entry!.wc(view)),
  'set-recovery-title': async (view, args) =>
    entry!.main.setHwpRecoveryTitle(entry!.wc(view), String(args[0] ?? '')),
  'discard-recovery-copy': async (view) => entry!.main.hwpDiscardRecoveryCopy(entry!.wc(view)),
  'write-copies-now': async () => {
    // the flushes go out; the Rust side does not wait for their answers either
    void entry!.recovery.hwpRecoveryContract.writeCopiesNow()
  },
  'open-file-with-decision': async (view, args) =>
    entry!.recovery.hwpRecoveryContract.openFileWithDecision(entry!.wc(view), {
      filePath: String(args[0] ?? ''),
      decision: args[1] === 'restore' ? 'restore' : 'original',
    }),
  'render-process-gone': async (view, args) =>
    emit(view, 'render-process-gone', {}, { reason: args[0] ?? 'crashed' }),
  'did-start-navigation': async (view, args) =>
    emit(view, 'did-start-navigation', {
      isMainFrame: args[0] === true,
      isSameDocument: args[1] === true,
    }),
  'export-hwp-pdf-headless': (_view, args) =>
    entry!.main.exportHwpPdfHeadless(
      String(args[0] ?? ''),
      String(args[1] ?? ''),
      typeof args[2] === 'number' ? args[2] : undefined,
    ),
}
