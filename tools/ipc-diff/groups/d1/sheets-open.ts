/**
 * Group `d1/sheets-open`: how a sheets tab opens, re-opens, merges and closes
 * a workbook (`apps/sheets/src/main/sheets-main.ts`: `workbook:select`,
 * `workbook:reopen`, the merge pickers, `workbook:update-password`,
 * `workbook:auto-rename`, `workbook:close`, the queue and headless flags),
 * loaded as the shell loads it (`d1/sheets-host.ts`).
 *
 * Not reachable by a call, so not covered here: `workbook:sidecar-crashed`
 * (the sidecar process dying: `client.onProcessExit`), `workbook:close-save-request`
 * and `workbook:recovery-write-now` (the shell's `requestSheetsClose` and
 * `writeSheetsCopiesNow`), which tabs, menus and the OS shutdown call. The
 * tabs that went away (`destroyed`) cannot be made to go by a call either:
 * the unit tests of the Rust handlers cover that end.
 */
import { loadSheets } from '../../d1/sheets-host.ts'
import {
  S1,
  S2,
  NOBODY,
  SELECT,
  call,
  queued,
  send,
  sheetsCase,
  tab,
} from '../../d1/sheets-cases.ts'
import type { Case, Group } from '../../types.ts'

const COPY1 = '$DIR/temp/seuoffice-imports/11111111-0000-4000-8000-000000000001'

const cases: Case[] = [
  // ---- select ----
  sheetsCase(
    'a queued file opens without a dialog and is consumed',
    { d1: queued([1, 'a.xlsx']) },
    [call('sheets:has-queued-workbook'), SELECT, call('sheets:has-queued-workbook'), SELECT],
  ),
  sheetsCase('the picker, then a cancelled picker', { opens: [['$DIR/b.xlsx']] }, [SELECT, SELECT]),
  sheetsCase(
    'a legacy .xls opens as a converted copy that wants a Save As',
    { d1: queued([1, 'old.xls']) },
    [SELECT],
  ),
  sheetsCase('an .ods keeps the original it came from', { d1: queued([1, 'sheet.ods']) }, [SELECT]),
  sheetsCase(
    'a CSV keeps its identity, and reports its progress',
    { d1: { ...queued([1, 't.csv']), progress: { phase: 'rows', done: 1, total: 2 } } },
    [SELECT],
  ),
  sheetsCase('an empty CSV and a .tsv', { d1: queued([1, 'empty.csv']) }, [
    SELECT,
    call('workbook:close', [S1]),
  ]),
  sheetsCase('a .tsv is split on tabs', { d1: queued([1, 'tab.tsv']) }, [SELECT]),
  sheetsCase(
    'a delimited file past the limit is refused before it is read',
    { d1: { ...queued([1, 'big.csv']), importLimit: 1024 } },
    [SELECT],
  ),
  sheetsCase(
    'a 0-byte .xlsx opens as a blank workbook that writes back to it',
    { d1: queued([1, 'empty.xlsx']) },
    [SELECT],
  ),
  sheetsCase(
    'the engine cannot open the file',
    { d1: { ...queued([1, 'a.xlsx']), open: { error: 'broken archive' } } },
    [SELECT],
  ),
  sheetsCase('a file that is gone', { d1: queued([1, 'missing.xlsx']) }, [SELECT]),

  // ---- encrypted workbooks ----
  sheetsCase(
    'an encrypted .xlsx asks for its password and opens a decrypted copy',
    { d1: { ...queued([1, 'enc.xlsx']), password: 'secret' } },
    [SELECT],
  ),
  sheetsCase(
    'an encrypted .xls converts, and keeps the password it was opened with',
    { d1: { ...queued([1, 'enc.xls']), password: 'secret' } },
    [SELECT],
  ),
  sheetsCase(
    'no prompt: the person is told the file cannot be unlocked',
    { d1: queued([1, 'enc.xlsx']) },
    [SELECT],
  ),
  sheetsCase('a headless run asks no one', { d1: { ...queued([1, 'enc.xlsx']), headless: true } }, [
    SELECT,
  ]),

  // ---- reopen ----
  sheetsCase(
    'a plain path opens again; a file that is gone and a foreign extension are refused',
    { d1: queued([1, 'a.xlsx']) },
    [
      SELECT,
      call('workbook:reopen', ['$DIR/a.xlsx']),
      call('workbook:reopen', ['$DIR/missing.xlsx']),
      call('workbook:reopen', ['$DIR/doc.docx']),
      call('workbook:reopen', ['']),
      call('workbook:reopen', [3]),
    ],
  ),
  sheetsCase('a converted copy re-opens as the same kind of copy', { d1: queued([1, 'old.xls']) }, [
    SELECT,
    call('workbook:reopen', [`${COPY1}/old.xlsx`]),
  ]),
  sheetsCase('a re-open without a queue never asks for a file', { opens: [['$DIR/b.xlsx']] }, [
    call('workbook:reopen', ['$DIR/b.xlsx']),
  ]),

  // ---- merge sources ----
  sheetsCase(
    'the merge picker opens every pick, and a cancelled one nothing',
    { opens: [['$DIR/a.xlsx', '$DIR/b.xlsx'], null, []] },
    [
      call('workbook:select-for-merge'),
      call('workbook:select-for-merge'),
      call('workbook:select-for-merge'),
    ],
  ),
  sheetsCase(
    'a failing source closes the ones opened before it',
    { opens: [['$DIR/a.xlsx', '$DIR/missing.xlsx']] },
    [call('workbook:select-for-merge')],
  ),
  sheetsCase(
    'attachments open as merge sources without a dialog',
    { d1: { unsaved: ['$DIR/b.xlsx'] } },
    [
      call('workbook:open-for-merge', [['$DIR/a.xlsx', '$DIR/t.csv']]),
      call('workbook:open-for-merge', [['$DIR/doc.docx']]),
      call('workbook:open-for-merge', [['$DIR/missing.xlsx']]),
      call('workbook:open-for-merge', [['$DIR/b.xlsx']]),
      call('workbook:open-for-merge', [[]]),
      call('workbook:open-for-merge', [3]),
    ],
  ),

  // ---- password change ----
  sheetsCase(
    'Change Password rewrites the encrypted file; a plain workbook has no password',
    { d1: { ...queued([1, 'enc.xlsx']), password: 'secret' } },
    [
      SELECT,
      call('workbook:update-password', [{ sessionId: S1, newPassword: 'fresh' }]),
      call('workbook:update-password', [{ sessionId: NOBODY, newPassword: 'fresh' }]),
      call('workbook:update-password', [{ sessionId: S1, newPassword: '' }]),
    ],
  ),
  sheetsCase('a workbook without a password cannot change it', { d1: queued([1, 'a.xlsx']) }, [
    SELECT,
    call('workbook:update-password', [{ sessionId: S1, newPassword: 'fresh' }]),
  ]),

  // ---- flags and the queue ----
  sheetsCase('a new blank workbook is signalled once', { d1: { startup: { newBlank: true } } }, [
    call('sheets:consume-new-blank'),
    call('sheets:consume-new-blank'),
  ]),
  sheetsCase(
    'a headless run hands its target to the hidden view once, and settles on its answer',
    { d1: { startup: { headless: [{ view: 2, input: '$DIR/a.xlsx', out: '$DIR/out.pdf' }] } } },
    [
      call('sheets:consume-headless-export'),
      call('sheets:consume-headless-export', [], { view: 2 }),
      call('sheets:has-queued-workbook', [], { view: 2 }),
      call('sheets:consume-headless-export', [], { view: 2 }),
      send('sheets:headless-export-done', [{ ok: true }], 2),
      send('sheets:headless-export-done', [{ ok: false, error: 'late' }], 2),
    ],
    { views: [tab(1), tab(2)] },
  ),
  sheetsCase('a view the batch does not know of: only sheets views reach these channels', {}, [
    call('workbook:cancel-import'),
  ]),

  // ---- auto rename ----
  sheetsCase(
    'a workbook the shell named is renamed after the AI run, once',
    {
      d1: {
        ...queued([1, 'a.xlsx']),
        startup: { queued: [{ view: 1, path: '$DIR/a.xlsx' }], untitled: ['$DIR/a.xlsx'] },
      },
    },
    [
      SELECT,
      call('workbook:auto-rename', [S1, 'Q3 Report']),
      call('workbook:auto-rename', [S2, 'Q3 Report']),
      call('workbook:auto-rename', ['not-a-uuid', 'x']),
    ],
  ),
  sheetsCase(
    'a taken name gets a number; an unusable one renames nothing',
    {
      d1: {
        startup: {
          queued: [{ view: 1, path: '$DIR/a.xlsx' }],
          untitled: ['$DIR/a.xlsx', '$DIR/b.xlsx'],
        },
      },
    },
    [
      SELECT,
      call('workbook:auto-rename', [S1, 'b']),
      call('workbook:auto-rename', [S1, '???']),
      call('workbook:auto-rename', [S1, 'x'.repeat(101)]),
      call('workbook:auto-rename', [S1, '']),
    ],
  ),

  // ---- close ----
  sheetsCase(
    'a closed session is gone, and closing it again changes nothing',
    { d1: queued([1, 'a.xlsx']) },
    [
      SELECT,
      call('workbook:close', [S1]),
      call('workbook:close', [S1]),
      call('workbook:close', ['x']),
      call('workbook:cancel-import'),
    ],
  ),
]

export const group: Group = {
  batch: 'D1',
  load: loadSheets,
  cases,
  single: {
    'sheets:headless-export-done':
      'a send answers nothing; the later consume shows what it settled',
    'workbook:cancel-import': 'its answer is undefined; what it stops shows in the progress events',
  },
}
