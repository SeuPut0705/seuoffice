/**
 * Group `w/quick-look`: Quick Look's home-side preview and settings and the
 * preview window's own channels
 * (`apps/shell/src/main/quick-look/quick-look-window.ts`), configured as
 * `apps/shell/src/main/index.ts` configures it: the settings live under
 * `quickLook` in userData/app-settings.json.
 *
 * The preview window opens when the Windows Explorer hook reports a space, so
 * a case that needs one sets `hosts.w.quickLook.windows` and lists what the
 * hook reports in `script` (support/quick-look.ts): the window, its log lines
 * and its events are then what the first call finds. The file reader is
 * `parseFileToText` of the case's `hosts.w.quickLook.parse`.
 */
import { join } from 'node:path'
import { readAppSettings, writeAppSetting } from '../../../../apps/shell/src/main/app-settings.ts'
import { normalizeQuickLookSettings } from '../../../../apps/shell/src/shared/quick-look-home.ts'
import { quickLookBox } from '../../support/quick-look-box.ts'
import { specOf, standIn, waitOutExit, waitOutHook } from '../../support/quick-look.ts'
import type { Case, Group, View } from '../../types.ts'

const MODULE = 'apps/shell/src/main/quick-look/quick-look-window.ts'
type QuickLookWindow =
  typeof import('../../../../apps/shell/src/main/quick-look/quick-look-window.ts')

const get = { channel: 'quick-look:get-settings', args: [] }
const set = (partial: unknown) => ({ channel: 'quick-look:set-settings', args: [partial] })
const saved = (quickLook: unknown) => ({
  'userData/app-settings.json': JSON.stringify({ lang: 'ko', quickLook }),
})

const MTIME = 1_700_000_000_000
const file = (text: string) => ({ text, mtimeMs: MTIME })
const bytes = (hex: string) => ({ hex, mtimeMs: MTIME })
const PNG = '89504e470d0a1a0a00112233'

const settingsCases: Case[] = [
  { note: 'no settings file: the defaults', calls: [get] },
  {
    note: 'saved settings',
    files: saved({ explorerSpacePreview: false, keepInTray: true }),
    calls: [get],
  },
  {
    note: 'a saved value of the wrong type falls back',
    files: saved({ explorerSpacePreview: 'no' }),
    calls: [get],
  },
  {
    note: 'a corrupt file reads as empty',
    files: { 'userData/app-settings.json': '{oops' },
    calls: [get],
  },
  {
    note: 'set one flag, keep the other, then read back',
    files: { 'userData/app-settings.json': '{"lang":"en"}' },
    calls: [set({ keepInTray: true }), get],
  },
  {
    note: 'set the other flag: the saved one stays',
    files: saved({ explorerSpacePreview: false, keepInTray: true }),
    calls: [set({ explorerSpacePreview: true })],
  },
  {
    note: 'set both on a missing file',
    files: { userData: { dir: true } },
    calls: [set({ explorerSpacePreview: false, keepInTray: true })],
  },
  {
    note: 'a non-boolean flag is ignored',
    files: { userData: { dir: true } },
    calls: [set({ keepInTray: 'yes', explorerSpacePreview: 0 })],
  },
  {
    note: 'null and a string are not objects',
    files: { userData: { dir: true } },
    calls: [set(null), set('x')],
  },
  {
    note: 'no argument at all',
    files: { userData: { dir: true } },
    calls: [{ channel: 'quick-look:set-settings', args: [] }],
  },
  {
    note: 'the folder is missing: the write fails',
    calls: [set({ keepInTray: true })],
  },
  {
    note: 'a deferred invoke answers at its await step, after the call in between',
    files: { userData: { dir: true } },
    calls: [
      { ...get, defer: true },
      set({ keepInTray: true }),
      { channel: '', args: [], await: 0 },
    ],
  },
  {
    note: 'awaiting a call that was not deferred',
    calls: [get, { channel: '', args: [], await: 0 }],
  },
  {
    note: 'a view the channel is not open to is refused',
    views: [{ view: 2, surface: 'ShellQuickLook' }],
    calls: [get],
  },
]

// ---- the preview window ----

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const PREVIEW: View = { view: 2, window: 2, surface: 'ShellQuickLook' }
const OTHER_PREVIEW: View = { view: 3, window: 3, surface: 'ShellQuickLook' }
const VIEWS = [SHELL, PREVIEW, OTHER_PREVIEW]

const files = {
  'a.txt': file('first file'),
  'b.md': file('# Second\n- item\ntext'),
  'c.csv': file('x,y\n1,2'),
  'data.bin': file('not previewable'),
  'userData/app-settings.json': file('{"lang":"ko"}'),
}

const hosts = (quickLook: Record<string, unknown>) => ({ w: { quickLook } })
/** `parse` is a list so that its paths take `$DIR` (an object's keys do not) */
const parses = (byPath: Record<string, unknown>) =>
  Object.entries(byPath).map(([path, spec]) => ({ path, ...(spec as object) }))
const windows = (script: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  hosts({ windows: true, script, ...extra })

const space = (path: string) => ({ op: 'space', path })
const navigate = (path: string) => ({ op: 'navigate', path })
const escape = { op: 'escape' }
const notify = { op: 'notify' }

const fromPreview = (channel: string, view = 2) => ({ channel, view, args: [] })
const init = fromPreview('quick-look:get-init')
const close = fromPreview('quick-look:close')
const openInEditor = fromPreview('quick-look:open-in-editor')
const reveal = fromPreview('quick-look:reveal-in-folder')
const inspect = (path: unknown) => ({ channel: 'quick-look:home-inspect', args: [path] })

const windowCases: Case[] = [
  {
    note: 'no window yet: the init is null',
    views: VIEWS,
    files,
    calls: [init, close, openInEditor, reveal],
  },
  {
    note: 'a space on a file opens the window; the preview reads its init',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')]),
    calls: [init, fromPreview('quick-look:get-init', 3), fromPreview('quick-look:get-init', 1)],
  },
  {
    note: 'English and a dark theme, another preview view',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/b.md')], { lang: 'en', theme: 'dark', view: 3 }),
    calls: [fromPreview('quick-look:get-init', 3), init],
  },
  {
    note: 'a second file on the open window: will-show, payload, title',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt'), space('$DIR/b.md')]),
    calls: [init],
  },
  {
    note: 'a space on the file shown closes the window',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt'), space('$DIR/a.txt')]),
    calls: [init],
  },
  {
    note: 'a space on a file that cannot be previewed',
    views: VIEWS,
    files: { ...files, 'folder.txt': { dir: true } },
    hosts: windows([space('$DIR/data.bin'), space('$DIR/missing.txt'), space('$DIR/folder.txt')]),
    calls: [init],
  },
  {
    note: 'navigation moves the shown file; the same file and a bad one do not',
    views: VIEWS,
    files,
    hosts: windows([
      navigate('$DIR/b.md'),
      space('$DIR/a.txt'),
      navigate('$DIR/b.md'),
      navigate('$DIR/b.md'),
      navigate('$DIR/data.bin'),
      navigate('$DIR/c.csv'),
    ]),
    calls: [init],
  },
  {
    note: 'escape hides the window after the exit animation',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt'), escape, escape]),
    calls: [init],
  },
  {
    note: 'a space and then a navigation while the window is leaving',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt'), space('$DIR/a.txt'), navigate('$DIR/b.md')]),
    calls: [init],
  },
  {
    note: 'the file shown again after the window hid',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt'), escape, space('$DIR/a.txt')]),
    calls: [init],
  },
  {
    note: 'the language switch reaches the open window, and only then',
    views: VIEWS,
    files,
    hosts: windows([notify, space('$DIR/a.txt'), notify], { lang: 'en', theme: 'system' }),
    calls: [init],
  },
  {
    note: 'close from the window sends will-hide once',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')]),
    calls: [close, close, init],
  },
  {
    note: 'close from another view does nothing',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')]),
    calls: [fromPreview('quick-look:close', 3), init],
  },
  {
    note: 'open in editor closes the window and hands the file over',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/b.md')]),
    calls: [openInEditor, openInEditor, init],
  },
  {
    note: 'open in editor from another view does nothing',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/b.md')]),
    calls: [fromPreview('quick-look:open-in-editor', 3), init],
  },
  {
    note: 'reveal in folder shows the file, from the window only',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/c.csv')]),
    calls: [reveal, fromPreview('quick-look:reveal-in-folder', 3), init],
  },
  {
    note: 'reveal after the window closed has no file',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/c.csv'), escape]),
    calls: [reveal],
  },
  {
    note: 'turning the Explorer preview off drops the window',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')]),
    calls: [set({ explorerSpacePreview: false }), init, set({ explorerSpacePreview: true })],
  },
  {
    note: 'saving settings with the preview on keeps the window',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')]),
    calls: [set({ keepInTray: true }), init],
  },
  {
    note: 'the preview off from the start: the hook is told, nothing opens',
    views: VIEWS,
    files: {
      ...files,
      'userData/app-settings.json': file(
        JSON.stringify({ quickLook: { explorerSpacePreview: false } }),
      ),
    },
    hosts: windows([space('$DIR/a.txt')]),
    calls: [init, set({ explorerSpacePreview: true }), init],
  },
  {
    note: 'a file whose text cannot be read still opens the window',
    views: VIEWS,
    files,
    hosts: windows([space('$DIR/a.txt')], {
      parse: parses({ '$DIR/a.txt': { ok: false, error: 'damaged file' } }),
    }),
    calls: [init],
  },
]

// ---- the home-side preview ----

const bigText = 'y'.repeat(13000)
const inspectCases: Case[] = [
  {
    note: 'a text file',
    files,
    calls: [inspect('$DIR/a.txt'), inspect('$DIR/b.md'), inspect('$DIR/c.csv')],
  },
  {
    note: 'the same file twice reads it once',
    files,
    calls: [inspect('$DIR/a.txt'), inspect('$DIR/a.txt'), inspect('$DIR/b.md')],
  },
  {
    note: 'the reader answers for the path, not the file',
    files: { 'a.txt': file('on disk') },
    hosts: hosts({ parse: parses({ '$DIR/a.txt': { ok: true, text: 'from the reader' } }) }),
    calls: [inspect('$DIR/a.txt')],
  },
  {
    note: 'what cannot be previewed',
    files: { ...files, 'folder.txt': { dir: true } },
    calls: [
      inspect(''),
      inspect('   '),
      inspect(null),
      inspect(42),
      inspect('relative.txt'),
      inspect('$DIR/missing.txt'),
      inspect('$DIR/data.bin'),
      inspect('$DIR/folder.txt'),
    ],
  },
  {
    note: 'no argument at all',
    files,
    calls: [{ channel: 'quick-look:home-inspect', args: [] }],
  },
  {
    note: 'an image is shown as it is',
    files: { 'p.png': bytes(PNG), 'q.jpg': bytes('ffd8ff00aa') },
    calls: [inspect('$DIR/p.png'), inspect('$DIR/q.jpg')],
  },
  {
    note: 'text past the cap is cut',
    files: { 'long.txt': file('x') },
    hosts: hosts({ parse: parses({ '$DIR/long.txt': { ok: true, text: bigText } }) }),
    calls: [inspect('$DIR/long.txt')],
  },
  {
    note: 'what the reader reports',
    files: { 'a.txt': file('x'), 'b.txt': file('x'), 'c.txt': file('x'), 'd.txt': file('x') },
    hosts: hosts({
      parse: parses({
        '$DIR/a.txt': { throws: 'boom' },
        '$DIR/b.txt': { ok: false, error: 'file is password protected' },
        '$DIR/c.txt': { ok: false },
        '$DIR/d.txt': { ok: true },
      }),
    }),
    calls: [
      inspect('$DIR/a.txt'),
      inspect('$DIR/b.txt'),
      inspect('$DIR/c.txt'),
      inspect('$DIR/d.txt'),
    ],
  },
  {
    note: 'sheets, slides, mind maps and documents are cut into cards',
    files: {
      'a.xlsx': file('PK'),
      'a.pptx': file('PK'),
      'a.xmind': file('PK'),
      'a.docx': file('PK'),
      'a.pdf': file('%PDF'),
    },
    hosts: hosts({
      parse: parses({
        '$DIR/a.xlsx': { ok: true, text: '# S\na | b\n1 | 2' },
        '$DIR/a.pptx': { ok: true, text: '## Slide 1\nTitle\nBullet\n### Notes\nsay' },
        '$DIR/a.xmind': { ok: true, text: '# Map\n- root\n  - child' },
        '$DIR/a.docx': { ok: true, text: '# H\nbody\na | b' },
        '$DIR/a.pdf': { ok: true, text: 'page' },
      }),
    }),
    calls: [
      inspect('$DIR/a.xlsx'),
      inspect('$DIR/a.pptx'),
      inspect('$DIR/a.xmind'),
      inspect('$DIR/a.docx'),
      inspect('$DIR/a.pdf'),
    ],
  },
  {
    note: 'a view the channel is not open to is refused',
    views: [{ view: 2, surface: 'ShellQuickLook' }],
    files,
    calls: [inspect('$DIR/a.txt')],
  },
]

export const group: Group = {
  batch: 'W',
  async load(cx) {
    const spec = specOf(cx)
    const box = standIn(cx)
    const settingsPath = join(cx.dir, 'userData', 'app-settings.json')
    const mod = await cx.fresh<QuickLookWindow>(MODULE)
    box.notify = mod.notifyQuickLookLangOrThemeChanged
    mod.configureQuickLookWindow({
      parentWindow: () => null,
      lang: () => spec.lang ?? 'ko',
      theme: () => (spec.theme ?? 'light') as 'light' | 'dark' | 'system',
      trayIcon: () => null,
      readSettings: () => normalizeQuickLookSettings(readAppSettings(settingsPath).quickLook),
      writeSettings: (next) => writeAppSetting(settingsPath, 'quickLook', next),
      openInEditor: (filePath) => cx.electron.log.push(['deps.openInEditor', filePath]),
      showShellWindow: () => {},
      quitApp: () => {},
    })
    // what the Explorer hook reports once it is enabled, before the first call
    await quickLookBox().played
    waitOutExit(cx, ['quick-look:close', 'quick-look:open-in-editor'])
    waitOutHook(cx, ['quick-look:set-settings'])
  },
  cases: [...settingsCases, ...windowCases, ...inspectCases],
}
