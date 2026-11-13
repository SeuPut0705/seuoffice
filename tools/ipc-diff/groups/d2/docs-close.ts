/**
 * The Word editor's close guard and View menu: `docs:confirm-document-replace`
 * on its no-reply path (the renderer's answer cannot reach an invoke still
 * waiting in one case), the replies with no waiter, and the View-menu state
 * patching the live menu for the active tab only.
 *
 * Its round trips (close-check -> close-check-result, close-save-request ->
 * close-save-result) resume an invoke that waits: they are the Rust unit
 * tests' (crates/shell-ipc/d2/src/docs/tests.rs) until a case can defer an
 * invoke. The events emitted only by shell calls (docs:opened, docs:renamed,
 * docs:teardown, docs:write-recovery-now, docs:recovery-copy-dropped) need
 * trigger steps.
 */
import type { Case, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]
const two = [
  { view: 1, window: 1, surface: 'Docs' },
  { view: 2, window: 2, surface: 'Docs' },
]
const state = (aiSidebar: unknown, darkCanvas: unknown, odt: unknown) => ({
  aiSidebar,
  darkCanvas,
  odt,
})

const cases: Case[] = [
  {
    note: 'a renderer that never answers the close check: Cancel keeps the document',
    hosts: { shared: { dialogs: { message: [{ response: 1 }] } } },
    calls: [{ channel: 'docs:confirm-document-replace', args: [] }],
  },
  {
    note: 'a renderer that never answers the close check: Close Anyway lets another document in',
    files: { 'docs/a.docx': 'PK' },
    hosts: { shared: { dialogs: { message: [{ response: 0 }] } } },
    calls: [
      { channel: 'docs:open-path', args: ['$DIR/docs/a.docx'] },
      { channel: 'docs:confirm-document-replace', args: [] },
    ],
  },
  {
    note: 'close replies with no close in progress change nothing',
    calls: [
      {
        channel: 'docs:close-check-result',
        kind: 'send',
        args: [{ dirty: true, autoSave: false }],
      },
      { channel: 'docs:close-check-result', kind: 'send', args: [false] },
      { channel: 'docs:close-save-result', kind: 'send', args: [true] },
      { channel: 'docs:close-save-result', kind: 'send', args: [] },
    ],
  },
  {
    note: 'the View menu follows the active tab only; non-booleans read as off',
    views: two,
    hosts: { d2: { docs: { active_docs_view: 1 } } },
    calls: [
      { channel: 'docs:view-menu-state', kind: 'send', view: 2, args: [state(true, true, true)] },
      { channel: 'docs:view-menu-state', kind: 'send', view: 1, args: [state(true, false, true)] },
      { channel: 'docs:view-menu-state', kind: 'send', view: 1, args: [state('yes', 1, false)] },
      { channel: 'docs:view-menu-state', kind: 'send', view: 1, args: [null] },
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    await loadDocs(cx)
  },
  single: {
    'docs:close-check-result':
      'a send: it answers nothing; what it resumes is a pending close (unit tests)',
    'docs:close-save-result':
      'a send: it answers nothing; what it resumes is a pending save (unit tests)',
    'docs:view-menu-state':
      'a send: it answers nothing; the menu items it sets are in the host log',
  },
  cases: cases.map((c) => (c.views ? c : { ...c, views })),
}
