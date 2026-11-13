/**
 * Group `w/tabs`: the tab strip of `registerTabsIpc` in
 * `apps/shell/src/main/index.ts` over the real `tab-manager.ts` and
 * `detached-windows.ts`: open tabs, list, activate, reorder, close with an
 * editor's answer, detach, the native menus. The world (Electron, the editor
 * modules, the screen) is `tabs-lib/world.ts`; the Rust handlers run the same
 * scenario on `crates/shell-ipc/w/src/tabs`.
 */
import type { Call, Case, Group, View } from '../../types.ts'
import { koStrings } from './tabs-lib/strings.ts'
import { loadWorld, world } from './tabs-lib/world.ts'

// the tab menu shortens a path longer than 80 characters: keep the case folders short
process.env.TMPDIR = '/tmp'

const S = koStrings()

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

const list = invoke('tabs:list')
const newDoc = invoke('home:new-doc')
const newMarkdown = invoke('home:new-markdown')
const newSlide = invoke('home:new-slide')
const newSheetless = [newDoc, newMarkdown, newSlide]
const files = { 'documents/notes.md': '# notes\n', 'documents/report.docx': 'PK' }
const dropNotes = send('app:open-dropped-files', ['$DIR/documents/notes.md'])
const menuFor = (picks: (string | null)[], more: Record<string, unknown> = {}) =>
  world({
    menus: picks,
    homeKinds: ['docx', 'xlsx', 'pptx', 'md', 'html', 'xmind', 'drawio', 'hwp', 'pdf'],
    ...more,
  })

const cases: Case[] = [
  {
    note: 'the strip starts with home only',
    views: withViews(0),
    hosts: world(),
    calls: [list],
  },
  {
    note: 'open three tabs, list, activate each, an unknown id',
    views: withViews(3),
    hosts: world(),
    calls: [
      ...newSheetless,
      list,
      invoke('tabs:activate', 't1'),
      invoke('tabs:activate', 'home'),
      invoke('tabs:activate', 'nope'),
      invoke('tabs:activate', ''),
      invoke('tabs:activate', 7),
      list,
    ],
  },
  {
    note: 'reorder: to the end, to the front of the documents, a fraction, a bad id',
    views: withViews(3),
    hosts: world(),
    calls: [
      ...newSheetless,
      invoke('tabs:reorder', 't1', 3),
      list,
      invoke('tabs:reorder', 't3', 1),
      list,
      invoke('tabs:reorder', 't3', 2.5),
      invoke('tabs:reorder', 7, 1),
      invoke('tabs:reorder', 'nope', 1),
      invoke('tabs:reorder', 't2', 0),
      list,
    ],
  },
  {
    note: 'close a clean tab, an unknown one, bad ids',
    views: withViews(2),
    hosts: world(),
    calls: [
      newMarkdown,
      newSlide,
      invoke('tabs:close', 't1'),
      invoke('tabs:close', 't1'),
      invoke('tabs:close', ''),
      invoke('tabs:close', 7),
      invoke('tabs:close', 'home'),
      list,
    ],
  },
  {
    note: 'a dirty markdown tab: the editor cancels the close, then agrees',
    views: withViews(1),
    hosts: world({ views: { '100': { dirty: true } }, closeAnswers: [false, true] }),
    calls: [newMarkdown, invoke('tabs:close', 't1'), list, invoke('tabs:close', 't1'), list],
  },
  {
    note: 'a dirty docs tab asks the renderer first; the prompt then answers',
    views: withViews(1),
    hosts: world({ views: { '100': { dirty: true } }, closeAnswers: [true] }),
    calls: [newDoc, invoke('tabs:close', 't1'), list],
  },
  {
    note: 'a clean docs tab closes without a prompt',
    views: withViews(1),
    hosts: world(),
    calls: [newDoc, invoke('tabs:close', 't1'), list],
  },
  {
    note: 'the docs dirty query fails: the invoke rejects',
    views: withViews(1),
    hosts: world({ views: { '100': { queryFails: true } } }),
    calls: [newDoc, invoke('tabs:close', 't1'), list],
  },
  {
    note: 'the close prompt throws',
    views: withViews(1),
    hosts: world({ views: { '100': { dirty: true } }, closeAnswers: ['throws'] }),
    calls: [newMarkdown, invoke('tabs:close', 't1'), list],
  },
  {
    note: 'a sheets tab with a pending edit asks before it closes',
    views: withViews(1),
    hosts: world({ views: { '100': { pending: 2 } }, closeAnswers: [false] }),
    calls: [invoke('home:new-hwp'), invoke('tabs:close', 't1'), list],
  },
  {
    note: 'detach a tab into its own window, then one that cannot be, then an unknown id',
    views: withViews(3),
    hosts: world(),
    calls: [
      ...newSheetless,
      invoke('tabs:detach', 't2'),
      list,
      invoke('tabs:detach', 'home'),
      invoke('tabs:detach', 'nope'),
      invoke('tabs:detach', 7),
      invoke('tabs:detach', 't1'),
      list,
    ],
  },
  {
    note: 'the chrome press reaches every view but the sender',
    views: withViews(2),
    hosts: world(),
    calls: [
      send('tabs:chrome-pressed'),
      { channel: 'tabs:chrome-pressed', kind: 'send', view: 100, args: [] },
    ],
  },
  // ---- the native menus ----
  {
    note: 'the tab list: pick a tab, dismiss, no position',
    views: withViews(3),
    hosts: menuFor(['제목 없는 문서', null, '제목 없는 문서']),
    calls: [
      ...newSheetless,
      invoke('tabs:show-menu', 10.4, 20.6),
      list,
      invoke('tabs:show-menu', 10, 20),
      invoke('tabs:show-menu'),
      invoke('tabs:show-menu', 'x', 5),
      list,
    ],
  },
  {
    note: 'the tab context menu: rename, close, move right, close the others',
    views: withViews(3),
    hosts: menuFor([S.menuTabRename, S.menuClose, S.menuTabMoveRight, S.menuTabCloseOthers]),
    calls: [
      ...newSheetless,
      invoke('tabs:show-tab-menu', 't2', 5, 6),
      invoke('tabs:show-tab-menu', 't3', 5, 6),
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      list,
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      list,
    ],
  },
  {
    note: 'the tab menu of home, an unknown tab and a bad id opens nothing',
    views: withViews(1),
    hosts: menuFor([]),
    calls: [
      newDoc,
      invoke('tabs:show-tab-menu', 'home', 1, 2),
      invoke('tabs:show-tab-menu', 'nope', 1, 2),
      invoke('tabs:show-tab-menu', 7, 1, 2),
    ],
  },
  {
    note: 'a file tab: the menu offers the file; copy its path, its name, reveal, open',
    views: withViews(2),
    files,
    hosts: menuFor([S.menuTabCopyPath, S.menuTabCopyName, S.menuTabReveal, S.menuTabOpenDefault]),
    calls: [
      dropNotes,
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      invoke('tabs:show-tab-menu', 't1', 5, 6),
    ],
  },
  {
    note: 'duplicate the saved file: the copy opens in a tab of its own',
    views: withViews(2),
    files,
    hosts: menuFor([S.menuTabDuplicate]),
    calls: [dropNotes, invoke('tabs:show-tab-menu', 't1', 5, 6), list],
  },
  {
    note: 'save from the menu of a docs tab, a split beside, in a new window',
    views: withViews(2),
    hosts: menuFor([S.menuTabSave, S.menuTabSplitBeside, S.menuOpenInNewWindow]),
    calls: [
      newDoc,
      invoke('tabs:show-tab-menu', 't1', 5, 6),
      newDoc,
      invoke('tabs:show-tab-menu', 't2', 5, 6),
      list,
    ],
    // the window the second pick opens is the third tab's
  },
  {
    note: 'reopen a closed file tab from the menu',
    views: withViews(3),
    files,
    hosts: menuFor([S.menuTabReopen]),
    calls: [
      dropNotes,
      invoke('tabs:close', 't1'),
      newDoc,
      invoke('tabs:show-tab-menu', 't2', 5, 6),
      list,
    ],
  },
  {
    note: 'the new-document menu: a new tab, dismissed, every kind hidden but one',
    views: withViews(2),
    hosts: menuFor(['AI Docs', null, '열기…']),
    calls: [invoke('tabs:show-new-menu', 3, 4), invoke('tabs:show-new-menu', 3, 4), list],
  },
  {
    note: 'the new-document menu with only pdf',
    views: withViews(1),
    files: {
      'userData/app-settings.json': JSON.stringify({
        homeKinds: {
          order: [
            'docx',
            'xlsx',
            'pptx',
            'md',
            'html',
            'xmind',
            'drawio',
            'hwp',
            'pdf',
            'pdfTools',
          ],
          hidden: ['docx', 'xlsx', 'pptx', 'md', 'html', 'xmind', 'drawio', 'hwp'],
        },
      }),
    },
    hosts: menuFor([null], { homeKinds: ['pdf'] }),
    calls: [invoke('tabs:show-new-menu')],
  },
  {
    note: 'the application menu: pick an entry of a submenu, then dismiss',
    views: withViews(1),
    hosts: menuFor(['파일 열기', null], {
      strings: { ...S, menuCheckUpdates: '업데이트 확인…' },
      appMenu: [
        {
          label: '파일',
          submenu: [
            { label: '파일 열기' },
            { type: 'separator' },
            { label: '닫기', enabled: false },
          ],
        },
        { label: '도움말', submenu: [{ label: '정보' }] },
        { label: '창', enabled: false },
      ],
    }),
    calls: [invoke('tabs:show-app-menu', 7.5, 9.5), invoke('tabs:show-app-menu')],
  },
  {
    note: 'no application menu: nothing pops up',
    views: withViews(0),
    hosts: menuFor([]),
    calls: [invoke('tabs:show-app-menu', 1, 2)],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadWorld,
  cases,
  single: {
    'tabs:activate': 'answers nothing; the tab list shows what it did',
    'tabs:close': 'answers nothing; the tab list shows what it did',
    'tabs:reorder': 'answers nothing; the tab list shows what it did',
    'tabs:detach': 'answers nothing; the tab list shows what it did',
    'tabs:show-menu': 'answers nothing once the menu closed; the log shows the menu',
    'tabs:show-tab-menu': 'answers nothing once the menu closed; the log shows the menu',
    'tabs:show-new-menu': 'answers nothing once the menu closed; the log shows the menu',
    'tabs:show-app-menu': 'answers nothing once the menu closed; the log shows the menu',
    'tabs:chrome-pressed': 'a send',
  },
}
