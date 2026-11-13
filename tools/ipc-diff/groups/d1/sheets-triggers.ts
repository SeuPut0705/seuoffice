/**
 * Group `d1/sheets-triggers`: what the shell does to the sheets tabs outside
 * any channel, through the same function on both sides
 * (`d1/sheets-host.ts` `sheetsTriggers`, `probe_trigger` of sheets/mod.rs):
 *
 * - `d1/workbook:request-sheets-close` (`requestSheetsClose`), which asks the
 *   renderer to save with `workbook:close-save-request` and waits for its
 *   `workbook:close-save-result`;
 * - `d1/workbook:write-sheets-copies-now` (`writeSheetsCopiesNow`), which asks
 *   every live tab with `workbook:recovery-write-now` and waits for each
 *   `workbook:recovery-write-now-done`;
 * - `d1/workbook:sidecar-exit` (the sidecar process dying, which tells every
 *   tab with `workbook:sidecar-crashed`);
 * - `d1/workbook:render-process-gone`, `mark-sheets-shutting-down`,
 *   `reset-sheets-shutting-down` and `discard-sheets-recovery`
 *   (`markSheetsShuttingDown`, `resetSheetsShuttingDown`,
 *   `discardSheetsRecovery`);
 * - `d1/workbook:timeout-elapsed`: the 120 s wait of a close and the 8 s wait
 *   of a flush are held on both sides until this says they ran.
 *
 * The waits are deferred (`defer`), answered by the renderer's own send, and
 * taken with `settled(i)`, so the round trips are compared on their full path.
 * The tab ids are the views of the case; a flush asks each tab with a nonce
 * drawn from the shared UUID counter (`11111111-0000-4000-8000-…01`, `…02`).
 */
import { loadSheets, sheetsTriggers } from '../../d1/sheets-host.ts'
import {
  NOBODY,
  S1,
  SELECT,
  call,
  queued,
  saveRequest,
  send,
  settled,
  sheetsCase,
  tab,
  trigger,
} from '../../d1/sheets-cases.ts'
import type { Case, Group } from '../../types.ts'

const A = queued([1, 'a.xlsx'])
const NONCE1 = '11111111-0000-4000-8000-000000000001'
const NONCE2 = '11111111-0000-4000-8000-000000000002'
const CLOSE = 'd1/workbook:request-sheets-close'
const FLUSH = 'd1/workbook:write-sheets-copies-now'
const SHORT = 8_000
const LONG = 120_000
const TWO = [tab(1), tab(2)]
const dirty = (count = 2) => send('workbook:pending-edits', [count])
const answered = (ok: boolean, view = 1) => send('workbook:close-save-result', [ok], view)

const cases: Case[] = [
  // ---- requestSheetsClose ----
  sheetsCase('a clean tab closes without asking', { d1: A }, [
    SELECT,
    trigger(CLOSE),
    dirty(0),
    trigger(CLOSE),
  ]),
  sheetsCase(
    'Save: the renderer is asked to save, and its answer closes or keeps the tab',
    { d1: A, messages: [0, 0, 0] },
    [
      SELECT,
      dirty(),
      trigger(CLOSE, [], { defer: true }),
      answered(true),
      settled(2),
      trigger(CLOSE, [1], { defer: true }),
      answered(false),
      settled(5),
      trigger(CLOSE, [], { defer: true }),
      answered(true, 2),
      answered(true),
      settled(8),
    ],
    { views: TWO },
  ),
  sheetsCase(
    'Save: a renderer that never answers keeps the tab after the wait',
    { d1: A, messages: [0] },
    [
      SELECT,
      dirty(),
      trigger(CLOSE, [], { defer: true }),
      trigger('d1/workbook:timeout-elapsed', [LONG]),
      settled(2),
      answered(true),
    ],
  ),
  sheetsCase(
    "Don't Save drops the tab's copies, Cancel keeps the tab",
    { d1: A, messages: [1, 2] },
    [
      SELECT,
      call('workbook:write-recovery', [saveRequest(S1, 'save')]),
      dirty(),
      trigger(CLOSE),
      trigger(CLOSE),
    ],
  ),
  sheetsCase(
    'a close while the app is ending asks nothing, and asks again once the quit is vetoed',
    { d1: A, messages: [2] },
    [
      SELECT,
      dirty(),
      trigger('d1/workbook:mark-sheets-shutting-down'),
      trigger(CLOSE),
      trigger('d1/workbook:reset-sheets-shutting-down'),
      trigger(CLOSE),
    ],
  ),

  // ---- writeSheetsCopiesNow ----
  sheetsCase(
    'a flush asks every tab and ends when each has answered',
    { d1: A },
    [
      trigger(FLUSH, [], { defer: true, view: 1 }),
      send('workbook:recovery-write-now-done', [NONCE2], 2),
      send('workbook:recovery-write-now-done', [NONCE1], 2),
      send('workbook:recovery-write-now-done', [NONCE1], 1),
      send('workbook:recovery-write-now-done', [NONCE2], 2),
      settled(0),
    ],
    { views: TWO },
  ),
  sheetsCase(
    'a tab that does not answer holds the flush until its wait is over',
    { d1: A },
    [
      trigger(FLUSH, [], { defer: true }),
      send('workbook:recovery-write-now-done', [NONCE1], 1),
      trigger('d1/workbook:timeout-elapsed', [SHORT]),
      settled(0),
    ],
    { views: TWO },
  ),
  sheetsCase(
    'a tab whose renderer died is not asked',
    { d1: A },
    [
      trigger('d1/workbook:render-process-gone', [], { view: 2 }),
      trigger(FLUSH, [], { defer: true }),
      send('workbook:recovery-write-now-done', [NONCE1], 1),
      settled(1),
    ],
    { views: TWO },
  ),
  sheetsCase('with no tab there is nothing to flush', {}, [trigger(FLUSH)], {
    views: [{ view: 1, window: 1, surface: 'Shell' }],
  }),

  // ---- the sidecar ----
  sheetsCase(
    'the sidecar dying is told to every tab, every time',
    { d1: A },
    [SELECT, trigger('d1/workbook:sidecar-exit'), trigger('d1/workbook:sidecar-exit')],
    { views: TWO },
  ),

  // ---- discardSheetsRecovery ----
  sheetsCase(
    "a tab's copies are dropped, and a tab with none loses nothing",
    { d1: A },
    [
      SELECT,
      call('workbook:write-recovery', [saveRequest(S1, 'save')]),
      trigger('d1/workbook:discard-sheets-recovery'),
      trigger('d1/workbook:discard-sheets-recovery'),
      call('workbook:write-recovery', [saveRequest(NOBODY, 'save')]),
      trigger('d1/workbook:discard-sheets-recovery', [], { view: 2 }),
      call('workbook:close', [S1]),
    ],
    { views: TWO },
  ),
]

export const group: Group = {
  batch: 'D1',
  load: loadSheets,
  triggers: sheetsTriggers,
  cases,
  single: {},
}
