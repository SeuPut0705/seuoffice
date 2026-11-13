/**
 * Group `d2/pdf-tools-window`: the PDF tools window's channels
 * (`apps/shell/src/main/pdf-tools/pdf-tools-window.ts`), configured as the
 * shell entry configures it; the window is the case's `ShellPdfTools` view
 * 900, opened from the shell view 1. The loader and its fakes are in
 * `pdf-tools-fakes/`. Picked files and outputs get the ids
 * `00000000-0000-4000-8000-00000000000N` in the order they are handed out.
 */
import type { Case, Group, View } from '../../types.ts'
import { loadPdfTools, trigger, triggers } from './pdf-tools-fakes/load.ts'

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const PDF: View = { view: 5, window: 1, surface: 'Pdf' }
const TOOLS: View = { view: 900, window: 900, surface: 'ShellPdfTools' }
const views = [SHELL, TOOLS]

const call = (channel: string, view: number, args: unknown[] = []) => ({ channel, view, args })
const open = call('pdf-tools:open', 1)
const pick = (...args: unknown[]) => call('pdf-tools:pick-inputs', 900, args)
const run = (request: unknown) => call('pdf-tools:run', 900, [request])
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hosts = (tools: unknown, dialogs: unknown = {}) => ({
  shared: { dialogs },
  d2: { pdf: { tools } },
})
const A = '$DIR/documents/a.pdf'
const B = '$DIR/documents/b.pdf'
const files = {
  'documents/a.pdf': '%PDF-a',
  'documents/b.pdf': '%PDF-bb',
  out: { dir: true as const },
}

const cases: Case[] = [
  {
    note: 'the shell view opens the window, which reads its settings; opening again shows it',
    views,
    hosts: hosts({ lang: 'ko', theme: 'dark' }),
    calls: [
      call('pdf-tools:get-init', 900),
      open,
      call('pdf-tools:get-init', 900),
      open,
      call('pdf-tools:take-start', 900),
    ],
  },
  {
    note: 'a pdf tab may not open the window; the window may not ask before it is open',
    views: [SHELL, PDF, TOOLS],
    calls: [call('pdf-tools:open', 5), pick(true), call('pdf-tools:get-init', 900)],
  },
  {
    note: 'picked files become ids; unusable ones say why',
    views,
    files,
    hosts: hosts(
      { inspect_pdf: [{ pages: 3 }, { problem: 'encrypted' }] },
      { open: [[A, B, '$DIR/documents/gone.pdf'], null] },
    ),
    calls: [open, pick(true), pick(false)],
  },
  {
    note: 'pictures for images-to-pdf; one that is not a picture',
    views,
    files,
    hosts: hosts({ is_image: [true, false] }, { open: [[A, B]] }),
    calls: [open, pick(true, 'image')],
  },
  {
    note: 'remove-password takes only protected files; repair takes unreadable ones',
    views,
    files,
    hosts: hosts(
      {
        inspect_pdf: [{ problem: 'encrypted' }, { pages: 2 }, { problem: 'unreadable' }],
        encrypted_page_count: 7,
      },
      { open: [[A, B], [A]] },
    ),
    calls: [open, pick(true, 'pdf', 'encrypted'), pick(false, 'pdf', 'damaged')],
  },
  {
    note: 'a run writes where the user picked; its result opens and shows by id',
    views,
    files,
    hosts: hosts(
      { run_tool: [{ outputs: [{ $u8: [1, 2, 3] }] }] },
      { open: [[A]], save: ['$DIR/out/turned'] },
    ),
    calls: [
      open,
      pick(),
      run({ tool: 'rotate', inputIds: [id(1)], options: { rotation: 270 } }),
      call('pdf-tools:reveal-result', 900, [id(2)]),
      call('pdf-tools:open-result', 900, [id(2)]),
      call('pdf-tools:open-result', 900, ['nope']),
      call('pdf-tools:reveal-result', 900, [7]),
    ],
  },
  {
    note: 'requests the tools refuse before running',
    views,
    files,
    hosts: hosts({ inspect_pdf: { pages: 3 } }, { open: [[A]] }),
    calls: [
      open,
      pick(),
      run(null),
      run({ tool: 'rotate', inputIds: [] }),
      run({ tool: 'merge', inputIds: [id(1)] }),
      run({ tool: 'overlay', inputIds: [id(1)] }),
      run({ tool: 'imagesToPdf', inputIds: [id(1)] }),
      run({ tool: 'extract', inputIds: [id(1)], options: { pages: '2-9' } }),
      run({ tool: 'encrypt', inputIds: [id(1)], options: { password: '' } }),
      run({ tool: 'blankPages', inputIds: [id(1)], options: { removePages: '2' } }),
    ],
  },
  {
    note: 'never over a source, never over a file open with unsaved changes; a cancelled save',
    views,
    files,
    hosts: hosts(
      { unsavedFiles: ['$DIR/out/x.pdf'] },
      { open: [[A]], save: [A, '$DIR/out/x.pdf'] },
    ),
    calls: [
      open,
      pick(),
      run({ tool: 'reverse', inputIds: [id(1)] }),
      run({ tool: 'reverse', inputIds: [id(1)] }),
      run({ tool: 'reverse', inputIds: [id(1)] }),
    ],
  },
  {
    note: 'split asks for a folder and takes free names in it',
    views,
    files: { ...files, 'out/a-1.pdf': 'old' },
    hosts: hosts(
      { run_tool: [{ outputs: [{ $u8: [1] }, { $u8: [2, 2] }] }] },
      { open: [[A], ['$DIR/out']] },
    ),
    calls: [open, pick(), run({ tool: 'split', inputIds: [id(1)], options: { chunkSize: 1 } })],
  },
  {
    note: 'merge two, overlay on a background; a refusal and a failure; compress reports progress',
    views,
    files,
    hosts: hosts(
      {
        run_tool: [
          { outputs: [{ $u8: [5] }] },
          { outputs: [{ $u8: [6] }] },
          { refusal: 'no-annots' },
          { error: 'boom' },
          {
            outputs: [{ $u8: [7] }],
            progress: [
              [1, 2],
              [2, 2],
            ],
          },
        ],
      },
      { open: [[A, B]], save: ['$DIR/out/m.pdf', '$DIR/out/o.pdf', '$DIR/out/c.pdf'] },
    ),
    calls: [
      open,
      pick(true),
      run({ tool: 'merge', inputIds: [id(2), id(1)] }),
      run({ tool: 'overlay', inputIds: [id(1)], backgroundId: id(2), options: { layer: 'front' } }),
      run({ tool: 'stripAnnots', inputIds: [id(1)], options: { annotKinds: ['links'] } }),
      run({ tool: 'nup', inputIds: [id(1)], options: { perSheet: 4 } }),
      run({ tool: 'compress', inputIds: [id(1)], options: { compressLevel: 'strong' } }),
    ],
  },
  {
    note: 'add a password: the job answers a protected file, which is written',
    views,
    files,
    hosts: hosts(
      {
        inspect_pdf: [{ pages: 2 }, { pages: 2 }, { problem: 'encrypted' }],
        run_job: [{ value: { bytes: { $u8: [9, 9] } } }],
      },
      { open: [[A]], save: ['$DIR/out/locked.pdf'] },
    ),
    calls: [
      open,
      pick(),
      run({
        tool: 'encrypt',
        inputIds: [id(1)],
        options: { password: 'pw', restrict: true, permissionPassword: 'owner' },
      }),
    ],
  },
  {
    note: 'password jobs that fail: a file that still opens, a wrong password, a cancel',
    views,
    files,
    hosts: hosts(
      {
        encrypted_page_count: 3,
        inspect_pdf: [{ problem: 'encrypted' }, { pages: 1 }, { problem: 'encrypted' }],
        run_job: [
          { value: { bytes: { $u8: [1] } } },
          { error: 'password-required' },
          { error: 'cancelled' },
          { value: { nothing: true } },
        ],
      },
      { open: [[A]] },
    ),
    calls: [
      open,
      pick(false, 'pdf', 'encrypted'),
      run({ tool: 'encrypt', inputIds: [id(1)], options: { password: 'a' } }),
      run({ tool: 'decrypt', inputIds: [id(1)], options: { password: 'b' } }),
      run({ tool: 'repair', inputIds: [id(1)] }),
      run({ tool: 'repair', inputIds: [id(1)] }),
    ],
  },
  {
    note: 'the blank-page search: its candidates, then only those pages are removed',
    views,
    files,
    hosts: hosts(
      {
        inspect_pdf: { pages: 4 },
        run_job: [
          {
            value: {
              pageCount: 4,
              candidates: [
                {
                  page: 3,
                  reason: 'nearly-white',
                  thumb: { width: 1, height: 1, bgra: { $u8: [0, 0, 0, 255] } },
                },
                { page: 2, reason: 'empty', thumb: null },
              ],
            },
            progress: [[2, 4]],
          },
        ],
      },
      { open: [[A]], save: ['$DIR/out/clean.pdf'] },
    ),
    calls: [
      open,
      pick(),
      call('pdf-tools:find-blank-pages', 900, ['nope']),
      call('pdf-tools:find-blank-pages', 900, [id(1)]),
      run({ tool: 'blankPages', inputIds: [id(1)], options: { removePages: '1' } }),
      run({ tool: 'blankPages', inputIds: [id(1)], options: { removePages: '3, 2' } }),
    ],
  },
  {
    note: 'blank-page searches that fail: a job error, a cancel, an answer of the wrong shape',
    views,
    files,
    hosts: hosts(
      {
        run_job: [
          { error: 'corrupt', message: 'bad file' },
          { error: 'cancelled' },
          { value: { pageCount: 2, candidates: [{ page: 3, reason: 'empty' }] } },
        ],
      },
      { open: [[A]] },
    ),
    calls: [
      open,
      pick(),
      call('pdf-tools:find-blank-pages', 900, [id(1)]),
      call('pdf-tools:find-blank-pages', 900, [id(1)]),
      call('pdf-tools:find-blank-pages', 900, [id(1)]),
    ],
  },
  {
    note: 'cancel with nothing running, open a PDF in the editor, close the window',
    views,
    files,
    hosts: hosts({}, { open: [[A], null] }),
    calls: [
      open,
      call('pdf-tools:cancel-run', 900),
      call('pdf-tools:cancel-find', 900),
      call('pdf-tools:open-in-editor', 900),
      call('pdf-tools:open-in-editor', 900),
      call('pdf-tools:close', 900),
    ],
  },
  {
    note: 'the editor ribbon hands a file over; the window takes the task once',
    views,
    files,
    hosts: hosts({ inspect_pdf: { pages: 2 } }),
    calls: [
      trigger('open-with-file', 1, [A, 'imagesToPdf']),
      trigger('open-with-file', 1, [A, 'compress']),
      call('pdf-tools:take-start', 900),
      call('pdf-tools:take-start', 900),
    ],
  },
  {
    note: 'a hand-over to an open window tells it a task waits',
    views,
    files,
    calls: [open, trigger('open-with-file', 1, [B, 'rotate']), trigger('open-window', 1)],
  },
]

export const group: Group & { triggers: typeof triggers } = {
  batch: 'D2',
  load: loadPdfTools,
  cases,
  single: {
    'pdf-tools:open-result': 'answers undefined; what it opens is in the host log',
    'pdf-tools:reveal-result': 'answers undefined; what it shows is in the host log',
  },
  triggers,
}
