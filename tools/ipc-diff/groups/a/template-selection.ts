/**
 * Group `a/template-selection`: the design template a slides window remembers
 * for its deck (`apps/slides/src/main/template-selection-ipc.ts`). The
 * handlers and the lazily made memory are the module's own statements; they
 * run over the real store (`template-selection-store.ts`) in the case's user
 * data folder and over `session-state.ts`'s `sessions`, stood in by the
 * case's decks: `hosts.a.slidesDocs` maps a view to `{ id, path }` (`path` ''
 * for a deck never saved), as crates/shell-ipc/a/src/probe/template_selection.rs
 * provides them to the Rust port. `hosts.a.now` pins `Date.now()` on both
 * sides (the `updatedAt` a set stamps).
 */
import {
  TEMPLATE_SELECTION_GET_CHANNEL,
  TEMPLATE_SELECTION_SET_CHANNEL,
} from '../../../../apps/slides/src/shared/template-selection.ts'
import { TemplateSelectionMemory } from '../../../../apps/slides/src/main/template-selection-store.ts'
import type { Call, Case, Group, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const ipcCode = entryStatements('apps/slides/src/main/template-selection-ipc.ts', [
  'let memory:',
  'function templateSelectionMemory(',
  'export function registerTemplateSelectionIpc(',
]).replace(/^export /gm, '')

const REAL_DATE_NOW = Date.now
const NOW = 1_700_000_000_000

const views: View[] = [
  { view: 1, window: 1, surface: 'Slides' },
  { view: 2, window: 2, surface: 'Slides' },
  { view: 3, window: 3, surface: 'Slides' },
]
const get = (view: number): Call => ({ channel: TEMPLATE_SELECTION_GET_CHANNEL, view, args: [] })
const set = (view: number, selection: unknown): Call => ({
  channel: TEMPLATE_SELECTION_SET_CHANNEL,
  view,
  args: [selection],
})
const builtin = { kind: 'builtin', key: 'coral', adjustments: ['bigger titles'] }
const saved = { kind: 'saved', key: 'my style' }
const decks = (docs: Record<string, { id: number; path: string }>) => ({
  a: { now: NOW, slidesDocs: docs },
})

const cases: Case[] = [
  {
    note: 'a window without a deck answers null to both',
    views,
    hosts: decks({}),
    calls: [get(1), set(1, builtin)],
  },
  {
    note: 'a saved deck remembers its template in the user data file; null forgets it',
    views,
    hosts: decks({ '1': { id: 11, path: '$DIR/decks/a.pptx' } }),
    calls: [get(1), set(1, builtin), get(1), set(1, saved), get(1), set(1, null), get(1)],
  },
  {
    note: 'input that is not a selection is ignored and answers what is stored',
    views,
    hosts: decks({ '1': { id: 11, path: '$DIR/decks/a.pptx' } }),
    calls: [
      set(1, builtin),
      set(1, { kind: 'other', key: 'x' }),
      set(1, { kind: 'builtin', key: '' }),
      set(1, { kind: 'builtin', key: 'x'.repeat(200) }),
      set(1, { kind: 'builtin', key: 'k', adjustments: 'not a list' }),
      set(1, 'coral'),
      set(1),
      get(1),
    ],
  },
  {
    note: 'two windows on the same file share the record; an unsaved deck keeps its own in memory',
    views,
    hosts: decks({
      '1': { id: 11, path: '$DIR/decks/a.pptx' },
      '2': { id: 12, path: '$DIR/decks/a.pptx' },
      '3': { id: 13, path: '' },
    }),
    calls: [set(1, builtin), get(2), set(3, saved), get(3), get(1), set(3, null), get(3)],
  },
  {
    note: 'a corrupt store reads as empty and is replaced by the next set',
    views,
    files: { 'userData/slides-template-selections.json': '{oops' },
    hosts: decks({ '1': { id: 11, path: '$DIR/decks/a.pptx' } }),
    calls: [get(1), set(1, saved), get(1)],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as {
      now?: number
      slidesDocs?: Record<string, { id: number; path: string }>
    }
    if (hostsA.now !== undefined) {
      const now = hostsA.now
      Date.now = () => now
    } else {
      Date.now = REAL_DATE_NOW
    }
    const sessions = new Map<number, { id: number; path: string }>()
    for (const [view, doc] of Object.entries(hostsA.slidesDocs ?? {})) {
      sessions.set(Number(view), { id: doc.id, path: doc.path })
    }
    runWith(`${ipcCode}\nregisterTemplateSelectionIpc()`, {
      app: cx.electron.app,
      ipcMain: cx.electron.ipcMain,
      sessions,
      TemplateSelectionMemory,
      TEMPLATE_SELECTION_GET_CHANNEL,
      TEMPLATE_SELECTION_SET_CHANNEL,
    })
  },
  cases,
}
