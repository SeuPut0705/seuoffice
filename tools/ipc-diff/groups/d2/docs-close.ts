/**
 * The Word editor's close guard and View menu: `docs:confirm-document-replace`
 * on its no-reply path and on its renderer round trips (a deferred invoke
 * resumed by close-check-result, then by close-save-result when the close
 * saves), the replies with no waiter, and the View-menu state patching the
 * live menu for the active tab only.
 */
import type { Call, Case, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const ab = { $: 'b', k: 'ab', i: 0 }
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

/** the deferred close at `index` answers now */
const awaitCall = (index: number): Call => ({ channel: '', args: [], await: index })
const replace: Call = { channel: 'docs:confirm-document-replace', args: [], defer: true }
const check = (state: unknown): Call => ({
  channel: 'docs:close-check-result',
  kind: 'send',
  args: [state],
})
const saved = (ok: unknown): Call => ({
  channel: 'docs:close-save-result',
  kind: 'send',
  args: [ok],
})
const opened: Call = { channel: 'docs:open-path', args: ['$DIR/docs/a.docx'] }
const file = { 'docs/a.docx': 'PK' }
/** the dialog buttons of a dirty close: Save, Don't Save, Cancel */
const answers = (...response: number[]) => ({
  shared: { dialogs: { message: response.map((r) => ({ response: r })) } },
})

const cases: Case[] = [
  {
    note: 'a clean close check lets another document in, with no prompt',
    files: file,
    calls: [opened, replace, check({ dirty: false, autoSave: false }), awaitCall(1)],
  },
  {
    note: 'a dirty close check (the boolean form): Don\u2019t Save drops the copies and lets it in',
    files: file,
    hosts: answers(1),
    calls: [
      opened,
      {
        channel: 'docs:write-recovery',
        args: ['$DIR/docs/a.docx', ab, null],
        buffers: [Buffer.from('edits').toString('hex')],
      },
      replace,
      check(true),
      awaitCall(2),
    ],
  },
  {
    note: 'a dirty close check: Cancel keeps the document',
    hosts: answers(2),
    calls: [replace, check({ dirty: true, autoSave: false }), awaitCall(0)],
  },
  {
    note: 'a dirty close check: Save asks the renderer, whose save lets it in',
    files: file,
    hosts: answers(0),
    calls: [
      opened,
      replace,
      check({ dirty: true, autoSave: false, filePath: '$DIR/docs/a.docx' }),
      saved(true),
      awaitCall(1),
    ],
  },
  {
    note: 'a dirty close check: Save, and a failed save (a non-boolean reads as failed) keeps it',
    hosts: answers(0),
    calls: [replace, check({ dirty: true, filePath: 7 }), saved('yes'), awaitCall(0)],
  },
  {
    note: 'autosave on: a dirty close saves with no prompt',
    calls: [replace, check({ dirty: true, autoSave: true }), saved(true), awaitCall(0)],
  },
  {
    note: 'autosave on and its save fails: the prompt follows, Cancel keeps it',
    hosts: answers(2),
    calls: [replace, check({ dirty: true, autoSave: true }), saved(false), awaitCall(0)],
  },
  {
    note: 'a second replace while the first waits joins it: one close check, one answer for both',
    calls: [replace, replace, check({ dirty: false }), awaitCall(0), awaitCall(1)],
  },
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
      'a send: it answers nothing; what it resumes is the deferred close it answers',
    'docs:close-save-result':
      'a send: it answers nothing; what it resumes is the deferred close it answers',
    'docs:view-menu-state':
      'a send: it answers nothing; the menu items it sets are in the host log',
  },
  cases: cases.map((c) => (c.views ? c : { ...c, views })),
}
