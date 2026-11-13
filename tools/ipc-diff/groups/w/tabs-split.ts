/**
 * Group `w/tabs-split`: the two-pane split (`registerSplitIpc`, the split
 * entries of the tab menu) and the drag of a tab out of the strip
 * (`tabs:tear-off`, `tabs:drag-torn-window`, `tabs:dock-torn-window`,
 * `tabs:end-torn-drag`, `tabs:dock-index`) over the real tab manager and
 * detached-window modules. See `w/tabs` for the world.
 */
import type { Case, FileSpec, Group } from '../../types.ts'
import { invoke, send, withViews } from './tabs.ts'
import { koStrings } from './tabs-lib/strings.ts'
import { loadWorld, world } from './tabs-lib/world.ts'

const S = koStrings()
const files: Record<string, FileSpec> = { userData: { dir: true } }
const threeTabs = [invoke('home:new-doc'), invoke('home:new-markdown'), invoke('home:new-slide')]
const as = (view: number) => ({ view })
const menu = (picks: (string | null)[], more: Record<string, unknown> = {}) =>
  world({ menus: picks, ...more })
const tabMenu = (id: string) => invoke('tabs:show-tab-menu', id, 5, 6)
const splitState = invoke('tabs:get-split')
const role = (view: number) => ({ channel: 'app:get-split-role', ...as(view), args: [] })
const focusPane = (view: number) => ({
  channel: 'tabs:focus-pane',
  kind: 'send' as const,
  ...as(view),
  args: [],
})
const viewFocused = (view: number) => ({
  channel: 'app:view-focused',
  kind: 'send' as const,
  ...as(view),
  args: [],
})
const ratio = (value: unknown) => send('tabs:set-split-ratio', value)
const drag = (x: unknown, y: unknown) => send('tabs:drag-torn-window', x, y)
const tearOff = (id: unknown, x: unknown, y: unknown) => invoke('tabs:tear-off', id, x, y)

const cases: Case[] = [
  {
    note: 'split from the tab menu: the state, the roles, which pane has focus',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitRight]),
    calls: [
      ...threeTabs,
      splitState,
      role(100),
      tabMenu('t2'),
      splitState,
      role(100),
      role(101),
      role(102),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'the focus moves between the panes; the divider moves; a bad ratio is ignored',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitDown]),
    calls: [
      ...threeTabs,
      tabMenu('t3'),
      focusPane(100),
      role(100),
      role(102),
      viewFocused(102),
      role(102),
      ratio(0.3),
      splitState,
      ratio('0.4'),
      ratio({ $: 'n', v: 'NaN' }),
      ratio({ $: 'n', v: 'Infinity' }),
      ratio(0.9),
      splitState,
    ],
  },
  {
    note: 'a tab of the split in the menu: unsplit, split on the other edge',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitRight, S.menuUnsplit, S.menuSplitDown, S.menuSplitRight]),
    calls: [
      ...threeTabs,
      tabMenu('t2'),
      tabMenu('t2'),
      splitState,
      tabMenu('t1'),
      tabMenu('t1'),
      splitState,
    ],
  },
  {
    note: 'close a tab of the split: the split goes with it',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitRight]),
    calls: [
      ...threeTabs,
      tabMenu('t2'),
      invoke('tabs:close', 't3'),
      splitState,
      invoke('tabs:close', 't2'),
      splitState,
    ],
  },
  {
    note: 'the focus pings of a view that is not in a split change nothing',
    views: withViews(2),
    files,
    hosts: world(),
    calls: [
      invoke('home:new-doc'),
      focusPane(100),
      viewFocused(100),
      role(100),
      splitState,
      ratio(0.5),
    ],
  },
  // ---- drag a tab out of the strip ----
  {
    note: 'tear a tab off, drag it over the middle, release: a window of its own',
    views: withViews(3),
    files,
    hosts: world({ cursor: { x: 400, y: 300 } }),
    calls: [
      ...threeTabs,
      tearOff('t2', 400, 300),
      invoke('tabs:list'),
      drag(500, 320),
      drag(520, 340),
      invoke('tabs:end-torn-drag'),
      invoke('tabs:end-torn-drag'),
    ],
  },
  {
    note: 'tear a tab off and drag it to the right edge: the hint, then the split on release',
    views: withViews(3),
    files,
    hosts: world({ cursor: { x: 1190, y: 400 } }),
    calls: [
      ...threeTabs,
      tearOff('t2', 400, 300),
      drag(1190, 400),
      drag(1190, 402),
      drag(600, 400),
      drag(1190, 400),
      invoke('tabs:end-torn-drag'),
      splitState,
      invoke('tabs:list'),
    ],
  },
  {
    note: 'the bottom edge: a stack split; a pointer over the strip shows no hint',
    views: withViews(3),
    files,
    hosts: world({ cursor: { x: 600, y: 795 } }),
    calls: [
      ...threeTabs,
      tearOff('t1', 100, 100),
      drag(600, 20),
      drag(600, 795),
      invoke('tabs:dock-torn-window', 1),
      splitState,
      invoke('tabs:list'),
    ],
  },
  {
    note: 'tear off and dock back at a slot of the strip; without an index; nothing torn',
    views: withViews(3),
    files,
    hosts: world(),
    calls: [
      ...threeTabs,
      tearOff('t3', 300, 200),
      send('tabs:dock-index', 1),
      invoke('tabs:dock-torn-window', 1),
      invoke('tabs:list'),
      tearOff('t1', 300, 200),
      invoke('tabs:dock-torn-window'),
      invoke('tabs:list'),
      invoke('tabs:dock-torn-window', 0),
      send('tabs:dock-index', 1.5),
      send('tabs:dock-index', 'x'),
    ],
  },
  {
    note: 'bad arguments, home, a tab already torn off, a second tear-off',
    views: withViews(3),
    files,
    hosts: world(),
    calls: [
      ...threeTabs,
      tearOff('t2', 'x', 1),
      tearOff(7, 1, 1),
      tearOff('t2', { $: 'n', v: 'NaN' }, 1),
      tearOff('home', 1, 1),
      tearOff('nope', 1, 1),
      tearOff('t2', 400, 300),
      tearOff('t1', 400, 300),
      drag('x', 1),
      drag({ $: 'n', v: 'NaN' }, 1),
      drag(410, 310),
      invoke('tabs:end-torn-drag'),
      tearOff('t1', 400, 300),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'tear a pane tab out of a split, drop it back on the same edge',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitRight], { cursor: { x: 1190, y: 400 } }),
    calls: [
      ...threeTabs,
      tabMenu('t2'),
      splitState,
      tearOff('t2', 400, 300),
      splitState,
      drag(1190, 400),
      invoke('tabs:end-torn-drag'),
      splitState,
      invoke('tabs:list'),
    ],
  },
  {
    note: 'tear a pane tab out and drop it on the other edge: the orientation flips',
    views: withViews(3),
    files,
    hosts: menu([S.menuSplitRight]),
    calls: [
      ...threeTabs,
      tabMenu('t2'),
      tearOff('t3', 400, 300),
      drag(600, 795),
      invoke('tabs:end-torn-drag'),
      splitState,
    ],
  },
  {
    note: 'split beside: two windows share the screen; the cursor is over the strip',
    views: withViews(3),
    files,
    hosts: menu([S.menuTabSplitBeside], {
      cursor: { x: 600, y: 20 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    }),
    calls: [...threeTabs, tabMenu('t2'), invoke('tabs:list')],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadWorld,
  cases,
  single: {
    'tabs:dock-torn-window': 'answers nothing; the tab list shows what it did',
    'tabs:end-torn-drag': 'answers nothing; the tab list shows what it did',
    'tabs:drag-torn-window': 'a send',
    'tabs:dock-index': 'a send',
    'tabs:set-split-ratio': 'a send',
    'tabs:focus-pane': 'a send',
    'app:view-focused': 'a send',
  },
}
