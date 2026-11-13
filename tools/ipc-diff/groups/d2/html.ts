/**
 * Group `d2/html`: the HTML editor (`apps/html/src/main/html-main.ts`,
 * `seed-main.ts`, `generate-handoff-ipc.ts`) against
 * `crates/shell-ipc/d2/src/html`. The entry registers its handlers with the
 * first `createHtmlView()`, as the shell's first HTML tab does; that view is
 * no case view, so a case view is untitled until it saves or a trigger opens
 * a file in it (`text/fakes.ts`). The engines (print, html2docx,
 * odt-engine, file-parse) and the shell hooks answer from `hosts.d2.html`
 * as the Rust fakes do (`crates/shell-ipc/d2/src/html/fake.rs`).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as HtmlMainModule from '../../../../apps/html/src/main/html-main.ts'
import { queueHtmlSeedFor } from '../../../../apps/html/src/main/seed-main.ts'
import type { Case, Group, LoadContext } from '../../types.ts'
import { type TextEditorElectron, answers, setUpTextCase } from './text/fakes.ts'

const ENTRY = 'apps/html/src/main/html-main.ts'
type HtmlMain = typeof HtmlMainModule
/** an outbound call by trigger name: the view it runs for and its arguments */
type Triggers = Record<string, (view: number, args: unknown[]) => Promise<unknown>>

const H = [{ view: 1, surface: 'Html' }]
const TWO = [
  { view: 1, surface: 'Html' },
  { view: 2, surface: 'Html' },
]
const call = (channel: string, ...args: unknown[]) => ({ channel, args })
const send = (channel: string, ...args: unknown[]) => ({ channel, kind: 'send' as const, args })
const dirty = send('html:dirty-changed', true)
const save = (request: unknown) => call('html:save', request)
const docs = (name: string) => `$DIR/documents/${name}`
const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const PNG_HEX = Buffer.from(PNG, 'base64').toString('hex')
const NOW = 1_700_000_000_000

const cases: Case[] = [
  // ---- open, read, save ----
  {
    note: 'an untitled view has nothing pending and no grant',
    views: H,
    files: { 'documents/a.html': '<p>a</p>' },
    calls: [
      call('html:consume-pending'),
      call('html:read-file', docs('a.html')),
      call('html:read-file'),
      call('html:read-file', 42),
    ],
  },
  {
    note: 'an untitled save asks for a path; the view then reads and reopens it',
    views: H,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('saved.html')] } } },
    calls: [
      dirty,
      save({ text: '<p>one</p>', mode: 'save' }),
      call('html:consume-pending'),
      call('html:read-file', docs('saved.html')),
      save({ text: '<p>two</p>' }),
    ],
  },
  {
    note: 'a cancelled dialog writes nothing; Save As offers the exports',
    views: H,
    hosts: { shared: { dialogs: { save: [null, null] } }, d2: { html: { ui_lang: 'ko' } } },
    calls: [save({ text: 'x' }), save({ text: 'x', mode: 'saveAs', defaultName: 'My: page' })],
  },
  {
    note: 'bad save requests',
    views: H,
    calls: [
      save(null),
      save({ text: 1 }),
      save({ text: 'x', imageSources: 'a.png' }),
      save({ text: 'x', imageSources: ['a.png', 2] }),
      call('html:save'),
    ],
  },
  {
    note: 'the AI names an untitled page: a silent save in the default folder, the next free name',
    views: H,
    files: { 'documents/SeuOffice/Plan.html': 'taken' },
    calls: [save({ text: 'new', suggestedName: 'Plan' }), call('html:consume-pending')],
  },
  {
    note: 'the AI names a page while its panel has a project: the project writes it',
    views: H,
    files: { project: { dir: true } },
    hosts: { d2: { html: { write_new_document: '$DIR/project' } } },
    calls: [save({ text: 'p', suggestedName: 'In project' }), call('html:consume-pending')],
  },
  {
    note: 'an untitled page starts in the project folder the shell names',
    views: H,
    hosts: {
      d2: { html: { new_document_dir: '$DIR/project' } },
      shared: { dialogs: { save: [null] } },
    },
    calls: [save({ text: 'x' })],
  },
  {
    note: 'Save As to a page beside: the assets move and the answer lists the rewrites',
    views: H,
    files: {
      'documents/a.html': '<img src="assets/p.png">',
      'documents/assets/p.png': { hex: PNG_HEX },
      'other/x': 'x',
    },
    hosts: { shared: { dialogs: { save: [docs('a.html'), '$DIR/other/b.html'] } } },
    calls: [
      save({ text: '<img src="assets/p.png">', mode: 'saveAs' }),
      save({ text: '<img src="assets/p.png">', mode: 'saveAs' }),
    ],
  },
  {
    note: 'a sibling pane changed the file: a manual save asks, an automatic one defers',
    views: H,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('c.html')], message: [{ response: 1 }] } },
      d2: { html: { open_elsewhere: [docs('c.html')] } },
    },
    calls: [save({ text: 'a' }), save({ text: 'b', auto: true }), save({ text: 'c' })],
  },
  {
    note: 'Save As a PDF is the export, the page keeps its path',
    views: H,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('p.pdf')] } } },
    calls: [save({ text: '\ufeff<p>pdf</p>\r\n', mode: 'saveAs' }), call('html:consume-pending')],
  },
  {
    note: 'Save As a Word file goes through html2docx, prepared and opened by the shell',
    views: H,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('w.docx')] } },
      d2: { html: { docx_exported: true, docx_export_prepare: true } },
    },
    calls: [save({ text: '<p>word</p>\n', mode: 'saveAs' })],
  },
  {
    note: 'Save As ODT with a report the person declines',
    views: H,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('o.odt')], message: [{ response: 1 }] } },
      d2: { html: { docx_to_odt: { report: [{ kind: 'dropped', feature: 'ink', count: 2 }] } } },
    },
    calls: [save({ text: '<p>odt</p>', mode: 'saveAs' })],
  },
  // ---- pictures ----
  {
    note: 'pictures need a saved page and an editable format',
    views: H,
    files: { documents: { dir: true }, 'pics/p.png': { hex: PNG_HEX } },
    hosts: { shared: { dialogs: { save: [docs('i.html')], open: [['$DIR/pics/p.png'], null] } } },
    calls: [
      call('html:pick-image'),
      call('html:save-image', { base64: PNG, ext: 'png' }),
      save({ text: '<p>i</p>' }),
      call('html:pick-image'),
      call('html:pick-image'),
      call('html:save-image', { base64: PNG, ext: 'PNG' }),
      call('html:save-image', { base64: PNG, ext: 'svg' }),
      call('html:save-image', { base64: '', ext: 'png' }),
      call('html:save-image', null),
      call('html:read-image', 'assets/p.png'),
      call('html:read-image', 'assets/image.png'),
      call('html:read-image', 'https://x/y.png'),
      call('html:read-image', '../pics/p.png'),
      call('html:read-image', 5),
    ],
  },
  {
    note: 'an extensionless picture is typed by its signature',
    views: H,
    files: {
      documents: { dir: true },
      'documents/page_files/pic': { hex: PNG_HEX },
      'documents/page_files/text': 'hello',
    },
    hosts: { shared: { dialogs: { save: [docs('page.html')] } } },
    calls: [
      save({ text: 'x' }),
      call('html:read-image', 'page_files/pic'),
      call('html:read-image', 'page_files/text'),
    ],
  },
  {
    note: 'remote pictures: nothing a case can fetch',
    views: H,
    calls: [call('html:fetch-image', 1), call('html:fetch-image', 'ftp://x/y.png')],
  },
  // ---- exports ----
  {
    note: 'exports ask for a target named after the suggestion',
    views: H,
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/e.pdf', null, '$DIR/out/e.html', null] } },
      d2: { html: { open_generated_path: true } },
    },
    calls: [
      call('html:export-pdf', { html: '<p>pdf</p>', suggestedName: 'A/B: c' }),
      call('html:export-pdf', { html: '<p>pdf</p>' }),
      call('html:export-html', { html: '<p>single</p>', suggestedName: 'Page' }),
      call('html:export-html', { html: '<p>single</p>' }),
      call('html:export-pdf', {}),
      call('html:export-html', null),
      call('html:export-docx', { html: 1 }),
      call('html:export-odt'),
    ],
  },
  {
    note: 'a failed print reports its error',
    views: H,
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/f.pdf'] } },
      d2: { html: { print_pdf: { error: 'printToPDF failed' } } },
    },
    calls: [call('html:export-pdf', { html: '<p>x</p>' })],
  },
  {
    note: 'Word: written and revealed; a marked page asks first',
    views: H,
    files: { out: { dir: true } },
    hosts: {
      shared: {
        dialogs: { save: ['$DIR/out/w.docx', '$DIR/out/m.docx', '$DIR/out/n.docx'] },
        message: [{ response: 1 }, { response: 0 }],
      },
    },
    calls: [
      call('html:export-docx', { html: '<p>w</p>', suggestedName: 'W' }),
      call('html:export-docx', { html: '<p data-gx-redact>secret</p>' }),
      call('html:export-docx', { html: '<p data-gx-redact>secret</p><p>kept</p>' }),
    ],
  },
  {
    note: 'Word: the shell keeps a docs tab open on the target, nothing is written',
    views: H,
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/w.docx'] } },
      d2: { html: { docx_export_prepare: false } },
    },
    calls: [call('html:export-docx', { html: '<p>w</p>' })],
  },
  {
    note: 'headless exports take the given path, refuse marked pages and reveal nothing',
    views: H,
    files: { out: { dir: true } },
    hosts: { d2: { html: { is_headless: true } } },
    calls: [
      call('html:export-pdf', { html: '<p>h</p>', outPath: '$DIR/out/h.pdf' }),
      call('html:export-docx', { html: '<p>h</p>', outPath: '$DIR/out/h.docx' }),
      call('html:export-docx', { html: '<p data-gx-redact>s</p>', outPath: '$DIR/out/s.docx' }),
      call('html:export-odt', { html: '<p data-gx-redact>s</p>', outPath: '$DIR/out/s.odt' }),
      call('html:export-odt', { html: '<p>h</p>', outPath: '$DIR/out/h.odt' }),
      call('html:export-html', { html: '<p>h</p>', outPath: '$DIR/out/h.html' }),
    ],
  },
  {
    note: 'ODT: a conversion report is confirmed, a failed conversion reported',
    views: H,
    files: { out: { dir: true } },
    hosts: {
      shared: {
        dialogs: {
          save: ['$DIR/out/a.odt', '$DIR/out/b.odt', '$DIR/out/c.odt', null],
          message: [{ response: 0 }, { response: 1 }],
        },
      },
      d2: {
        html: {
          docx_to_odt: [
            { odt: 'ODT1', report: [{ kind: 'converted', feature: 'chart', count: 3 }] },
            { report: [{ kind: 'dropped', feature: 'comment' }] },
            { error: 'conversion failed' },
          ],
        },
      },
    },
    calls: [
      call('html:export-odt', { html: '<p>1</p>', suggestedName: 'One' }),
      call('html:export-odt', { html: '<p>2</p>' }),
      call('html:export-odt', { html: '<p>3</p>' }),
      call('html:export-odt', { html: '<p>4</p>' }),
    ],
  },
  {
    note: 'single-file export inlines pictures and refuses the open page',
    views: H,
    files: {
      documents: { dir: true },
      'documents/assets/p.png': { hex: PNG_HEX },
      out: { dir: true },
    },
    hosts: {
      shared: { dialogs: { save: [docs('s.html'), docs('s.html'), '$DIR/out/one.html'] } },
    },
    calls: [
      save({ text: '<img src="assets/p.png">' }),
      call('html:export-html', { html: '<img src="assets/p.png"><img src="gone.png">' }),
      call('html:export-html', { html: '<img src="assets/p.png"><img src="gone.png">' }),
    ],
  },
  // ---- seed, hand-off, headless ----
  {
    note: 'a hand-off is taken once by the view it was queued for',
    views: TWO,
    hosts: {
      d2: {
        html: {
          take_generate_handoff: {
            '1': { id: 'h1', text: 'make a page', materials: [{ path: '/m.pdf', name: 'm.pdf' }] },
          },
          report_generate_run_started: [false, true],
        },
      },
    },
    calls: [
      call('html:handoff-take'),
      call('html:handoff-take'),
      { ...call('html:handoff-take'), view: 2 },
      call('html:seed-take'),
      call('html:handoff-run-started', 'not a list'),
      call('html:handoff-run-started', ['/m.pdf', 3]),
      call('html:handoff-run-started', []),
    ],
  },
  {
    note: 'a view made for a file takes no hand-off',
    views: H,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('f.html')] } },
      d2: { html: { take_generate_handoff: { '1': { id: 'h', text: 't' } } } },
    },
    calls: [save({ text: 'x' }), call('html:handoff-take'), call('html:seed-take')],
  },
  {
    note: 'no headless export waits on a plain view',
    views: H,
    calls: [
      call('html:consume-headless-export'),
      send('html:headless-export-done', { ok: true }),
      send('html:headless-export-done', null),
    ],
  },
  // ---- preview, present, title ----
  {
    note: 'the preview text and the present views',
    views: [
      { view: 1, surface: 'Html' },
      { view: 7, surface: 'Html' },
    ],
    hosts: { d2: { html: { open_present_window: 7 } } },
    calls: [
      send('html:preview-update', '<p>live</p>'),
      send('html:preview-update', 5),
      call('html:preview-info'),
      call('html:present-new-tab', 'Deck'),
      { ...call('html:preview-info'), view: 7 },
      call('html:present-new-tab', 42),
    ],
  },
  {
    note: 'the shell opens the present tab itself',
    views: H,
    hosts: { d2: { html: { present_open_tab: true } } },
    calls: [call('html:present-new-tab', 'Tab')],
  },
  {
    note: 'present full screen snaps the window',
    views: H,
    calls: [call('html:present-fullscreen', true)],
  },
  {
    note: 'leaving full screen waits for the release timer (nothing within the call)',
    views: H,
    calls: [call('html:present-fullscreen', 'no')],
  },
  {
    note: 'a provisional title names only an untitled page, collapsed and cut',
    views: H,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('t.html')] } } },
    calls: [
      send('html:provisional-title', `  A\n  plan ${'x'.repeat(100)}`),
      send('html:provisional-title', '   '),
      send('html:provisional-title', 3),
      save({ text: 'x' }),
      send('html:provisional-title', 'Ignored'),
    ],
  },
  // ---- renderer answers with nothing waiting ----
  {
    note: 'answers nobody waits for are dropped',
    views: H,
    calls: [
      send('html:close-save-result', true),
      send('html:save-request-ack', false),
      send('html:read-text-result', { text: 'x' }),
      send('html:dirty-changed', 'yes'),
    ],
  },
  // ---- recovery ----
  {
    note: 'recovery copies: an untracked view skips; the open question tracks a saved page',
    views: H,
    files: { documents: { dir: true } },
    hosts: { d2: { html: { now: NOW } }, shared: { dialogs: { save: [docs('rc.html')] } } },
    calls: [
      call('html:recovery-write', 'early'),
      save({ text: 'saved' }),
      call('html:recovery-open'),
      call('html:recovery-write', 'clean'),
      dirty,
      call('html:recovery-write', null),
      call('html:recovery-write', '<p>copy</p>'),
      call('html:recovery-write', '<p>copy</p>'),
      call('html:recovery-write', 7),
      // the copy's name hashes the absolute path, which differs per side: the save drops it
      save({ text: 'final' }),
    ],
  },
  {
    note: 'a save drops the copy the untitled page had',
    views: H,
    files: { documents: { dir: true } },
    hosts: { d2: { html: { now: NOW } }, shared: { dialogs: { save: [docs('r.html')] } } },
    calls: [
      call('html:recovery-open'),
      dirty,
      call('html:recovery-write', 'draft'),
      save({ text: 'draft' }),
      call('html:recovery-write', 'after'),
    ],
  },
  // ---- chat attachments ----
  {
    note: 'attachments: by type and size',
    views: H,
    files: {
      'files/notes.txt': 'abcdef',
      'files/tool.exe': 'x',
      'files/pic.png': { hex: PNG_HEX },
      'files/sub': { dir: true },
    },
    calls: [
      call('html:files-add', [
        '$DIR/files/notes.txt',
        '$DIR/files/tool.exe',
        5,
        '$DIR/files/pic.png',
      ]),
      call('html:files-add', 'not a list'),
      call('html:files-add', ['$DIR/files/missing.md', '$DIR/files/sub.txt']),
    ],
  },
  {
    note: 'attachments picked in the dialog',
    views: H,
    files: { 'files/a.md': '# a' },
    hosts: {
      shared: { dialogs: { open: [['$DIR/files/a.md'], null] } },
      d2: { html: { ui_lang: 'ko' } },
    },
    calls: [call('html:files-pick'), call('html:files-pick')],
  },
  {
    note: 'a pasted picture lands in the temp folder',
    views: H,
    hosts: { d2: { html: { now: NOW } } },
    calls: [
      {
        ...call('html:files-add-pasted-image', { $: 'b', k: 'ab', i: 0 }, 'PNG'),
        buffers: [PNG_HEX],
      },
      {
        ...call('html:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'jpg'),
        buffers: [PNG_HEX],
      },
      { ...call('html:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'png'), buffers: [''] },
      call('html:files-add-pasted-image', null, 'png'),
      {
        ...call('html:files-add-pasted-image', { $: 'b', k: 'u8', i: 0 }, 'bmp'),
        buffers: [PNG_HEX],
      },
    ],
  },
  {
    note: 'reading an attachment: a slice of its text, cached; pictures and failures',
    views: H,
    files: { 'files/n.txt': 'abcdef', 'files/p.png': { hex: PNG_HEX }, 'files/big.bin': 'x' },
    hosts: {
      d2: {
        html: {
          parse_file_to_text: [
            { ok: true, kind: 'text', text: 'abcdefghij' },
            { ok: false, error: 'bad zip' },
          ],
        },
      },
    },
    calls: [
      call('html:files-read', '$DIR/files/n.txt', 2, 3),
      call('html:files-read', '$DIR/files/n.txt', -5, 0),
      call('html:files-read', '$DIR/files/n.txt', '1', 100000),
      call('html:files-read', '$DIR/files/p.png', 0, 10),
      call('html:files-read', '$DIR/files/big.bin', 0, 10),
      call('html:files-read', '$DIR/files/gone.md', 0, 10),
      call('html:files-read'),
    ],
  },
  {
    note: 'a file open with unsaved changes is not read; a damaged one says so',
    views: H,
    files: { 'files/u.md': 'u', 'files/d.docx': 'd' },
    hosts: {
      d2: {
        html: {
          unsaved_files: ['$DIR/files/u.md'],
          parse_file_to_text: { ok: false, damaged: true, error: 'zip' },
        },
      },
    },
    calls: [
      call('html:files-read', '$DIR/files/u.md', 0, 10),
      call('html:files-read', '$DIR/files/d.docx', 0, 10),
    ],
  },
  {
    note: 'attachment pictures as base64, at most 5 MB',
    views: H,
    files: { 'files/p.png': { hex: PNG_HEX }, 'files/q.webp': 'w', 'files/t.txt': 't' },
    calls: [
      call('html:files-read-image', '$DIR/files/p.png'),
      call('html:files-read-image', '$DIR/files/q.webp'),
      call('html:files-read-image', '$DIR/files/t.txt'),
      call('html:files-read-image', '$DIR/files/gone.gif'),
      call('html:files-read-image', null),
    ],
  },
  // ---- the channels are the HTML editor's ----
  {
    note: 'a view that did not load the HTML editor is refused',
    views: [{ view: 3, surface: 'Markdown' }],
    calls: [
      call('html:consume-pending'),
      call('html:present-fullscreen', true),
      call('html:present-new-tab', 'x'),
      call('html:preview-info'),
      call('html:fetch-image', 'https://x'),
      send('html:dirty-changed', true),
      send('html:close-save-result', true),
      send('html:save-request-ack', true),
      send('html:read-text-result', { text: 't' }),
      send('html:preview-update', 't'),
      send('html:provisional-title', 't'),
      send('html:headless-export-done', { ok: true }),
    ],
  },
]

/**
 * Steps that run the shell's and the other areas' calls into the editor
 * (`d2/html:<what>`, crates/shell-ipc/d2/src/html `probe_trigger`); they wait
 * for the gate's `trigger` step kind.
 */
export const triggerCases: unknown[] = [
  // needs trigger: open-view (createHtmlView on a file), the per-view grant
  {
    note: 'a view the shell opened on a file reads it and saves to it',
    views: H,
    files: { 'documents/o.html': '<p>o</p>' },
    calls: [
      { kind: 'trigger', name: 'd2/html:open-view', view: 1, args: [docs('o.html')] },
      call('html:consume-pending'),
      call('html:read-file', docs('o.html')),
      save({ text: '<p>saved</p>' }),
    ],
  },
  // needs trigger: request-save, the save-request event and its two answers
  {
    note: 'a menu save waits for the renderer; the ack declines',
    views: H,
    files: { 'documents/m.html': 'm' },
    calls: [
      { kind: 'trigger', name: 'd2/html:open-view', view: 1, args: [docs('m.html')] },
      dirty,
      { kind: 'trigger', name: 'd2/html:request-save', view: 1, args: ['saveAs'] },
      send('html:save-request-ack', false),
      { kind: 'trigger', name: 'd2/html:request-save', view: 1, args: ['save'] },
      save({ text: 'saved' }),
    ],
  },
  // needs trigger: request-close, the close-save-request event
  {
    note: 'closing a dirty page asks; Save waits for the renderer',
    views: H,
    hosts: { shared: { dialogs: { message: [{ response: 0 }, { response: 2 }] } } },
    calls: [
      dirty,
      { kind: 'trigger', name: 'd2/html:request-close', view: 1, args: [] },
      send('html:close-save-result', true),
      { kind: 'trigger', name: 'd2/html:request-close', view: 1, args: [] },
    ],
  },
  // needs trigger: read-text, the read-text-request event
  {
    note: 'MCP reads the live text',
    views: H,
    calls: [
      { kind: 'trigger', name: 'd2/html:read-text', view: 1, args: [] },
      send('html:read-text-result', { text: 42 }),
      { kind: 'trigger', name: 'd2/html:read-text', view: 1, args: [] },
      send('html:read-text-result', null),
    ],
  },
  // needs trigger: save-to-path, file-renamed, export-request, the file-renamed and export-request events
  {
    note: 'MCP saves to a path; the file is renamed; the menu exports',
    views: H,
    files: { 'documents/r.html': 'r' },
    calls: [
      { kind: 'trigger', name: 'd2/html:open-view', view: 1, args: [docs('r.html')] },
      { kind: 'trigger', name: 'd2/html:save-to-path', view: 1, args: [docs('mcp.html')] },
      save({ text: 'via mcp' }),
      {
        kind: 'trigger',
        name: 'd2/html:file-renamed',
        view: 1,
        args: [docs('mcp.html'), docs('moved.html')],
      },
      { kind: 'trigger', name: 'd2/html:export-request', view: 1, args: ['pdf'] },
    ],
  },
  // needs trigger: write-copies-now, the recovery-flush-request event
  {
    note: 'the OS ends the session: each dirty view is asked for its copy',
    views: H,
    hosts: { d2: { html: { now: NOW } } },
    calls: [
      call('html:recovery-open'),
      dirty,
      { kind: 'trigger', name: 'd2/html:write-copies-now', view: 1, args: [] },
      call('html:recovery-write', 'flushed'),
    ],
  },
  // needs trigger: queue-seed, export-headless
  {
    note: 'a seeded tab and a headless export',
    views: TWO,
    files: { 'documents/h.html': 'h', out: { dir: true } },
    calls: [
      { kind: 'trigger', name: 'd2/html:queue-seed', view: 1, args: ['<p>seed</p>'] },
      call('html:seed-take'),
      call('html:seed-take'),
      {
        kind: 'trigger',
        name: 'd2/html:export-headless',
        view: 2,
        args: [docs('h.html'), '$DIR/out/h.pdf', 'pdf', 5000],
      },
      { ...call('html:consume-headless-export'), view: 2 },
      { ...send('html:headless-export-done', { ok: false, error: 'boom' }), view: 2 },
    ],
  },
]

/** the outbound calls by trigger name, on the module the case loaded */
function triggers(mod: HtmlMain, cx: LoadContext, steer: TextEditorElectron): Triggers {
  const wc = (view: number) => cx.electron.contents(view) as never
  const str = (v: unknown) => String(v ?? '')
  return {
    'open-view': async (view, [path]) => {
      steer.nextView = view
      mod.createHtmlView(typeof path === 'string' ? path : null)
    },
    'request-save': (view, [mode]) =>
      mod.requestHtmlSave(wc(view), mode === 'saveAs' ? 'saveAs' : 'save'),
    'request-close': (view) => {
      const windows = cx.electron.BrowserWindow as { fromWebContents(wc: unknown): unknown }
      return mod.requestHtmlClose(wc(view), windows.fromWebContents(wc(view)) as never)
    },
    'read-text': (view) => mod.htmlReadText(wc(view)),
    'save-to-path': (view, [path]) => mod.htmlSaveToPath(wc(view), str(path)),
    'file-renamed': async (view, [from, to]) => mod.htmlFileRenamed(wc(view), str(from), str(to)),
    'export-request': async (view, [format]) =>
      mod.sendHtmlExportRequest(wc(view), str(format) as never),
    'discard-pending-assets': (view) => mod.htmlDiscardPendingAssets(wc(view)),
    'is-dirty': async (view) => mod.htmlIsDirty(view),
    'write-copies-now': () => mod.htmlRecoveryEditor.writeCopiesNow(),
    'queue-seed': async (view, [text]) => queueHtmlSeedFor(wc(view), str(text)),
    'export-headless': (view, [input, out, format, timeout]) => {
      steer.nextHidden = view
      return mod.exportHtmlHeadless(str(input), str(out), str(format) as never, Number(timeout))
    },
  }
}

let current: Triggers = {}

export const group: Group & {
  trigger(name: string, view: number, args: unknown[]): Promise<unknown>
} = {
  batch: 'D2',
  async load(cx) {
    const steer = setUpTextCase(cx, 'html')
    const a = answers()
    const log = cx.electron.log
    const mod = await cx.fresh<HtmlMain>(ENTRY)
    const runtime: Parameters<HtmlMain['configureHtmlRuntime']>[0] = { preloadPath: 'preload.js' }
    if (a.has('open_generated_path'))
      runtime.openGeneratedPath = (path) => {
        log.push(['openGeneratedPath', path])
        return a.bool('open_generated_path', false)
      }
    if (a.has('new_document_dir'))
      runtime.newDocumentDir = async (id) => {
        log.push(['newDocumentDir', id])
        return a.string('new_document_dir')
      }
    if (a.has('write_new_document'))
      runtime.writeNewDocument = async (id, name, bytes) => {
        log.push(['writeNewDocument', id, name])
        const dir = a.string('write_new_document')
        if (dir === null) return null
        const path = join(dir, name)
        writeFileSync(path, bytes)
        return path
      }
    mod.configureHtmlRuntime(runtime)
    mod.setHtmlFileSavedHook((wc, path) => log.push(['fileSavedHook', wc.id, path]))
    mod.setHtmlProvisionalTitleHook((wc, title) => log.push(['provisionalTitleHook', wc.id, title]))
    if (a.bool('docx_exported', false))
      mod.setHtmlDocxExportedHook((path) => log.push(['docxExportedHook', path]))
    if (a.has('docx_export_prepare'))
      mod.setHtmlDocxExportPrepareHook(async (path) => {
        log.push(['docxExportPrepareHook', path])
        return a.bool('docx_export_prepare', true)
      })
    mod.setHtmlPresentHooks({
      setBleed: (wc, on) => log.push(['presentHooks.setBleed', wc.id, on]),
      ...(a.has('present_open_tab')
        ? {
            openTab: (owner, title) => {
              log.push(['presentHooks.openTab', owner.id, title])
              return a.bool('present_open_tab', false)
            },
          }
        : {}),
    })
    // the shell's first HTML tab registers the editor's handlers
    mod.createHtmlView(null)
    current = triggers(mod, cx, steer)
  },
  async trigger(name, view, args) {
    const run = current[name.replace(/^d2\/html:/, '')]
    if (!run) throw new Error(`no trigger ${name}`)
    return run(view, args)
  },
  cases,
  single: {
    'html:fetch-image':
      'no case reaches a picture: the network is off on both sides and the generated-image store lives in the real temp folder',
    'html:present-fullscreen':
      'answers undefined; the refusal of another surface is its second answer',
  },
}
