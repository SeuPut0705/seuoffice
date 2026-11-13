/**
 * D2's Markdown editor: the `markdown:*` channels of
 * apps/markdown/src/main/markdown-main.ts (with its seed and note-append
 * channels) against crates/shell-ipc/d2/src/markdown.
 *
 * The module loads afresh for each case and registers its handlers through
 * `createMarkdownView(null)`, as the shell's first Markdown tab does; the
 * engines and shell hooks answer from `hosts.d2.markdown` and log what they
 * are handed, as the Rust fakes do (`crates/shell-ipc/d2/src/markdown/fake.rs`).
 * The wiki's vault is the default save folder, `$DIR/documents/SeuOffice`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as MarkdownMainModule from '../../../../apps/markdown/src/main/markdown-main.ts'
import { queueMarkdownNoteAppendFor } from '../../../../apps/markdown/src/main/note-append.ts'
import { queueMarkdownSeedFor } from '../../../../apps/markdown/src/main/seed-main.ts'
import type { Case, Group, LoadContext } from '../../types.ts'
import {
  type Outbound,
  type TextEditorElectron,
  answers,
  awaitStep,
  groupTriggers,
  setUpTextCase,
  triggerStep,
} from './text/fakes.ts'

const ENTRY = 'apps/markdown/src/main/markdown-main.ts'
type MarkdownMain = typeof MarkdownMainModule

const M = [{ view: 1, surface: 'Markdown' }]
const TWO = [
  { view: 1, surface: 'Markdown' },
  { view: 2, surface: 'Markdown' },
]
const call = (channel: string, ...args: unknown[]) => ({ channel, args })
const send = (channel: string, ...args: unknown[]) => ({ channel, kind: 'send' as const, args })
const dirty = send('markdown:dirty-changed', true)
const save = (request: unknown) => call('markdown:save', request)
const docs = (name: string) => `$DIR/documents/${name}`
const vault = (name: string) => `$DIR/documents/SeuOffice/${name}`
const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const PNG_HEX = Buffer.from(PNG, 'base64').toString('hex')
const NOW = 1_700_000_000_000
/** the n-th counted id of a case (`MarkdownShell::random_uuid`) */
const id = (n: number) => `${String(n).padStart(6, '0')}aa-0000-4000-8000-000000000000`
const SMMS = { kind: 'smms', token: 'tok' }

const cases: Case[] = [
  // ---- open, read, save ----
  {
    note: 'an untitled view has nothing pending and no grant',
    views: M,
    files: { 'documents/a.md': '# a' },
    calls: [
      call('markdown:consume-pending'),
      call('markdown:read-file', docs('a.md')),
      call('markdown:read-file'),
      call('markdown:read-file', 42),
    ],
  },
  {
    note: 'an untitled save asks for a path; the view then reads and saves it in place',
    views: M,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('saved.md')] } } },
    calls: [
      dirty,
      save({ text: '# one', mode: 'save' }),
      call('markdown:consume-pending'),
      call('markdown:read-file', docs('saved.md')),
      save({ text: '# two' }),
    ],
  },
  {
    note: 'a cancelled dialog writes nothing; Save As of a rendered note offers the exports',
    views: M,
    hosts: { shared: { dialogs: { save: [null, null] } }, d2: { markdown: { ui_lang: 'ko' } } },
    calls: [
      save({ text: 'x' }),
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>x</p>', defaultName: 'My: note' }),
    ],
  },
  {
    note: 'a bare name picked in the dialog becomes Markdown',
    views: M,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('bare')] } } },
    calls: [save({ text: 'b', mode: 'saveAs' }), call('markdown:consume-pending')],
  },
  {
    note: 'bad save requests',
    views: M,
    calls: [
      save(null),
      save({ text: 1 }),
      save({ text: 'x', imageSources: 'a.png' }),
      save({ text: 'x', imageSources: ['a.png', 2] }),
      call('markdown:save'),
    ],
  },
  {
    note: 'the AI names an untitled note: a silent save in the default folder, the next free name',
    views: M,
    files: { 'documents/SeuOffice/Plan.md': 'taken' },
    calls: [save({ text: 'new', suggestedName: 'Plan' }), call('markdown:consume-pending')],
  },
  {
    note: 'the AI names a note while its panel has a project: the project writes it',
    views: M,
    files: { project: { dir: true } },
    hosts: { d2: { markdown: { write_new_document: '$DIR/project' } } },
    calls: [save({ text: 'p', suggestedName: 'In project' }), call('markdown:consume-pending')],
  },
  {
    note: 'an untitled note starts in the project folder the shell names',
    views: M,
    hosts: {
      d2: { markdown: { new_document_dir: '$DIR/project' } },
      shared: { dialogs: { save: [null] } },
    },
    calls: [save({ text: 'x' })],
  },
  {
    note: 'a sibling pane changed the file: a manual save asks, an automatic one defers',
    views: M,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('c.md')], message: [{ response: 1 }] } },
      d2: { markdown: { open_elsewhere: [docs('c.md')] } },
    },
    calls: [save({ text: 'a' }), save({ text: 'b', auto: true }), save({ text: 'c' })],
  },
  {
    note: 'Save As a PDF prints the screen; the note keeps no path',
    views: M,
    files: { documents: { dir: true } },
    hosts: {
      shared: { dialogs: { save: [docs('p.pdf')] } },
      d2: { markdown: { open_generated_path: true } },
    },
    calls: [
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>pdf</p>' }),
      call('markdown:consume-pending'),
    ],
  },
  {
    note: 'Save As a PDF of a marked note: the renderer exports to the approved path',
    views: M,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('m.pdf')], message: [{ response: 1 }] } } },
    calls: [
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>m</p>', holdsHiddenContent: true }),
      call('markdown:confirm-marked-export', 'pdf'),
      call('markdown:export-pdf', { html: '<p>clear</p>', saveAsTarget: docs('other.pdf') }),
      call('markdown:export-pdf', { html: '<p>clear</p>', saveAsTarget: docs('m.pdf') }),
      call('markdown:export-pdf', { html: '<p>clear</p>', saveAsTarget: docs('m.pdf') }),
    ],
  },
  {
    note: 'Save As Word and ODT: one approved export each, taken once',
    views: M,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('w.docx'), docs('o.odt')] } } },
    calls: [
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>x</p>' }),
      call('markdown:export-docx', { base64: 'UEsDBA==', saveAsTarget: docs('w.docx') }),
      call('markdown:export-docx', { base64: 'UEsDBA==', saveAsTarget: docs('w.docx') }),
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>x</p>' }),
      call('markdown:export-odt', { base64: 'UEsDBA==', saveAsTarget: docs('w.odt') }),
      call('markdown:export-odt', { base64: 'UEsDBA==', saveAsTarget: docs('o.odt') }),
    ],
  },
  {
    note: 'Save As to another folder carries the owned pictures along',
    views: M,
    files: { documents: { dir: true }, 'pics/p.png': { hex: PNG_HEX }, other: { dir: true } },
    hosts: {
      shared: {
        dialogs: { save: [docs('a.md'), '$DIR/other/b.md'], open: [['$DIR/pics/p.png']] },
      },
    },
    calls: [
      save({ text: 'a' }),
      call('markdown:pick-image'),
      save({ text: '![p](assets/p.png)' }),
      save({ text: '![p](assets/p.png)', mode: 'saveAs' }),
      call('markdown:consume-pending'),
    ],
  },
  // ---- pictures ----
  {
    note: 'pictures need a saved note',
    views: M,
    files: { documents: { dir: true }, 'pics/p.png': { hex: PNG_HEX } },
    hosts: { shared: { dialogs: { save: [docs('i.md')], open: [['$DIR/pics/p.png'], null] } } },
    calls: [
      call('markdown:pick-image'),
      call('markdown:save-image', { base64: PNG, ext: 'png' }),
      save({ text: '# i' }),
      call('markdown:pick-image'),
      call('markdown:pick-image'),
      call('markdown:save-image', { base64: PNG, ext: 'PNG' }),
      call('markdown:save-image', { base64: PNG, ext: 'svg' }),
      call('markdown:save-image', { base64: '', ext: 'png' }),
      call('markdown:save-image', null),
      call('markdown:read-image', 'assets/p.png'),
      call('markdown:read-image', 'assets/image.png'),
      call('markdown:read-image', 'http://127.0.0.1/y.png'),
      call('markdown:read-image', 'file:///etc/passwd'),
      call('markdown:read-image', '../pics/p.png'),
      call('markdown:read-image', 5),
    ],
  },
  {
    note: 'Save Image As: a picture beside the note, or nothing',
    views: M,
    files: {
      documents: { dir: true },
      'documents/assets/p.png': { hex: PNG_HEX },
      out: { dir: true },
    },
    hosts: { shared: { dialogs: { save: [docs('s.md'), '$DIR/out/copy.png', null] } } },
    calls: [
      save({ text: '![p](assets/p.png)' }),
      call('markdown:save-image-as', docs('assets/p.png')),
      call('markdown:save-image-as', 'data:image/png;base64,' + PNG),
      call('markdown:save-image-as', 3),
    ],
  },
  // ---- image host ----
  {
    note: 'the image host: none, an incomplete form, then one kept and cleared',
    views: M,
    files: { 'userData/markdown-settings.json': '{"markdownTheme":"sepia"}' },
    calls: [
      call('markdown:get-image-host'),
      call('markdown:set-image-host', { kind: 's3', endpoint: 'http://x' }),
      call('markdown:set-image-host', 'smms'),
      call('markdown:set-image-host', { ...SMMS, token: '  tok  ', extra: 1 }),
      call('markdown:get-image-host'),
      call('markdown:set-image-host', null),
      call('markdown:get-image-host'),
    ],
  },
  {
    note: 'uploads: checked first, then sent to the host',
    views: M,
    files: { 'userData/markdown-settings.json': JSON.stringify({ imageHost: SMMS }) },
    hosts: {
      d2: {
        markdown: {
          upload_fetch: [
            null,
            { status: 200, text: '{"success":true,"data":{"url":"https://i.example/p.png"}}' },
            { status: 500, text: 'nope' },
          ],
        },
      },
    },
    calls: [
      call('markdown:upload-image', { base64: PNG, ext: 'bmp' }),
      call('markdown:upload-image', { ext: 'png' }),
      call('markdown:upload-image', { base64: PNG, ext: 'png' }),
      call('markdown:upload-image', { base64: PNG, ext: 'PNG', name: 'p' }),
      call('markdown:upload-image', { base64: PNG, ext: 'png' }),
    ],
  },
  {
    note: 'an upload with no host configured',
    views: M,
    calls: [call('markdown:upload-image', { base64: PNG, ext: 'png' })],
  },
  // ---- wiki ----
  {
    note: 'the vault: notes, links, headings, backlinks, the graph and tags',
    views: M,
    files: {
      'documents/SeuOffice/a.md': '# A\n\nSee [[b]] and [[c#Two]]. #plan\n',
      'documents/SeuOffice/b.md': '# B\n\n## One\n\n## Two\n\nBack to [[a]]. #plan #todo\n',
      'documents/SeuOffice/sub/c.md': '# C\n\n## Two\n',
      'documents/SeuOffice/pic.png': { hex: PNG_HEX },
    },
    calls: [
      call('markdown:list-wiki-notes'),
      call('markdown:resolve-wiki-links', {
        fromPath: vault('a.md'),
        targets: ['b', 'c', 'missing', 'sub/c#Two', 7],
      }),
      call('markdown:resolve-wiki-links', null),
      call('markdown:wiki-heads', { target: 'b', fromPath: vault('a.md') }),
      call('markdown:wiki-heads', { target: 'nope' }),
      call('markdown:wiki-backlinks', vault('a.md')),
      call('markdown:wiki-backlinks', 1),
      call('markdown:wiki-graph'),
      call('markdown:wiki-tags'),
    ],
  },
  {
    note: 'an empty vault',
    views: M,
    calls: [
      call('markdown:list-wiki-notes'),
      call('markdown:wiki-graph'),
      call('markdown:wiki-tags'),
      call('markdown:wiki-backlinks', vault('a.md')),
    ],
  },
  {
    note: 'a link to a missing note creates it beside the note, or in the vault',
    views: M,
    files: { 'documents/SeuOffice/notes/n.md': '# n', 'documents/SeuOffice/taken.md': 't' },
    hosts: { shared: { dialogs: { save: [vault('notes/n.md')] } } },
    calls: [
      call('markdown:create-wiki-note', { target: 'Loose' }),
      save({ text: '# n' }),
      call('markdown:create-wiki-note', { target: 'Beside' }),
      call('markdown:create-wiki-note', { target: 'deep/Inner' }),
      call('markdown:create-wiki-note', { target: 'taken' }),
      call('markdown:create-wiki-note', { target: '' }),
      call('markdown:create-wiki-note', null),
    ],
  },
  {
    note: 'a heading fragment is kept for the note it opens, once',
    views: M,
    calls: [
      call('markdown:remember-wiki-fragment', vault('a.md'), 'Two'),
      call('markdown:remember-wiki-fragment', vault('b.md'), 3),
      call('markdown:take-wiki-fragment', vault('a.md')),
      call('markdown:take-wiki-fragment', vault('a.md')),
      call('markdown:take-wiki-fragment', null),
    ],
  },
  // ---- exports ----
  {
    note: 'Word: a dialog named after the suggestion; cancel and bad requests',
    views: M,
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { save: ['$DIR/out/w.docx', null] } } },
    calls: [
      call('markdown:export-docx', { base64: 'UEsDBA==', suggestedName: 'A/B: c' }),
      call('markdown:export-docx', { base64: 'UEsDBA==' }),
      call('markdown:export-docx', { base64: '' }),
      call('markdown:export-docx', null),
    ],
  },
  {
    note: 'Word opened in Docs: a cached conversion the shell routes',
    views: M,
    hosts: { d2: { markdown: { now: NOW } } },
    calls: [
      call('markdown:export-docx', { base64: 'UEsDBA==', mode: 'openInDocs', suggestedName: 'N' }),
      call('markdown:export-docx', { base64: 'UEsDBA==', mode: 'openInDocs' }),
    ],
  },
  {
    note: 'ODT: a conversion report is confirmed, a failed conversion reported',
    views: M,
    files: { out: { dir: true } },
    hosts: {
      shared: {
        dialogs: {
          save: ['$DIR/out/a.odt', '$DIR/out/b.odt', '$DIR/out/c.odt', null],
          message: [{ response: 0 }, { response: 1 }],
        },
      },
      d2: {
        markdown: {
          docx_to_odt: [
            { odt: 'ODT1', report: [{ kind: 'converted', feature: 'chart', count: 3 }] },
            { report: [{ kind: 'dropped', feature: 'comment' }] },
            { error: 'conversion failed' },
          ],
        },
      },
    },
    calls: [
      call('markdown:export-odt', { base64: 'UEsDBA==', suggestedName: 'One' }),
      call('markdown:export-odt', { base64: 'UEsDBA==' }),
      call('markdown:export-odt', { base64: 'UEsDBA==' }),
      call('markdown:export-odt', { base64: 'UEsDBA==' }),
      call('markdown:export-odt', {}),
    ],
  },
  {
    note: 'PDF: printed, written and revealed; a failed print reports its error',
    views: M,
    files: { out: { dir: true } },
    hosts: {
      shared: { dialogs: { save: ['$DIR/out/e.pdf', '$DIR/out/f.pdf', null] } },
      d2: { markdown: { print_pdf: ['%PDF-1', { error: 'printToPDF failed' }] } },
    },
    calls: [
      call('markdown:export-pdf', { html: '<p>pdf</p>', suggestedName: 'Doc' }),
      call('markdown:export-pdf', { html: '<p>pdf</p>' }),
      call('markdown:export-pdf', { html: '<p>pdf</p>' }),
      call('markdown:export-pdf', { html: '' }),
    ],
  },
  {
    note: 'headless: the PDF takes the given path, a marked export is cancelled unasked',
    views: M,
    files: { out: { dir: true } },
    hosts: { d2: { markdown: { is_headless: true } } },
    calls: [
      call('markdown:export-pdf', { html: '<p>h</p>', outPath: '$DIR/out/h.pdf' }),
      call('markdown:confirm-marked-export', 'odt'),
    ],
  },
  {
    note: 'a marked export asks with the format named',
    views: M,
    hosts: {
      shared: { dialogs: { message: [{ response: 0 }, { response: 1 }, { response: 2 }] } },
      d2: { markdown: { ui_lang: 'ko' } },
    },
    calls: [
      call('markdown:confirm-marked-export', 'odt'),
      call('markdown:confirm-marked-export', 'pdf'),
      call('markdown:confirm-marked-export', 'png'),
      call('markdown:confirm-marked-export', 'docx'),
      call('markdown:confirm-marked-export'),
    ],
  },
  {
    note: 'page images: a folder chosen, pages written in order, finished and revealed',
    views: M,
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { open: [['$DIR/out']] } } },
    calls: [
      call('markdown:prepare-image-export', { html: '<p>1</p>', suggestedName: 'Pages' }),
      call('markdown:write-export-image', id(2), 2, PNG),
      call('markdown:write-export-image', id(2), 1, 'bm90IGEgcG5n'),
      call('markdown:write-export-image', id(2), 1, PNG),
      call('markdown:write-export-image', id(2), 2, PNG),
      call('markdown:write-export-image', 'other', 3, PNG),
      call('markdown:finish-image-export', id(2), true),
      call('markdown:finish-image-export', id(2), true),
    ],
  },
  {
    note: 'page images: a cancelled folder, an empty export, a bad request',
    views: M,
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { open: [null, ['$DIR/out']] } } },
    calls: [
      call('markdown:prepare-image-export', { html: '<p>1</p>' }),
      call('markdown:prepare-image-export', { html: '<p>1</p>' }),
      call('markdown:finish-image-export', id(2), true),
      call('markdown:prepare-image-export', { html: '' }),
    ],
  },
  {
    note: 'page images: an abandoned export leaves nothing',
    views: M,
    files: { out: { dir: true } },
    hosts: { shared: { dialogs: { open: [['$DIR/out']] } } },
    calls: [
      call('markdown:prepare-image-export', { html: '<p>1</p>', suggestedName: 'Gone' }),
      call('markdown:write-export-image', id(2), 1, PNG),
      call('markdown:finish-image-export', id(2), false),
    ],
  },
  {
    note: 'Save As page images: the pages take the typed name',
    views: M,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('shot.png')] } } },
    calls: [
      save({ text: 'x', mode: 'saveAs', pdfHtml: '<p>x</p>' }),
      call('markdown:prepare-image-export', { html: '<p>x</p>', saveAsTarget: docs('no.png') }),
      call('markdown:prepare-image-export', { html: '<p>x</p>', saveAsTarget: docs('shot.png') }),
      call('markdown:write-export-image', id(2), 1, PNG),
      call('markdown:write-export-image', id(2), 2, PNG),
      call('markdown:finish-image-export', id(2), true),
    ],
  },
  // ---- seed, note append, headless ----
  {
    note: 'nothing seeded, appended or exported waits on a plain view',
    views: M,
    calls: [
      call('markdown:seed-take'),
      call('markdown:note-append-take'),
      call('markdown:consume-headless-export'),
      send('markdown:headless-export-done', { ok: true }),
      send('markdown:headless-export-done', null),
    ],
  },
  // ---- renderer answers with nothing waiting ----
  {
    note: 'answers nobody waits for are dropped',
    views: M,
    calls: [
      send('markdown:close-save-result', true),
      send('markdown:save-request-ack', false),
      send('markdown:read-text-result', { text: 'x' }),
      send('markdown:dirty-changed', 'yes'),
    ],
  },
  // ---- recovery ----
  {
    note: 'recovery copies: an untracked view skips; the open question tracks a saved note',
    views: M,
    files: { documents: { dir: true } },
    hosts: { d2: { markdown: { now: NOW } }, shared: { dialogs: { save: [docs('rc.md')] } } },
    calls: [
      call('markdown:recovery-write', 'early'),
      save({ text: 'saved' }),
      call('markdown:recovery-open'),
      call('markdown:recovery-write', 'clean'),
      dirty,
      call('markdown:recovery-write', null),
      call('markdown:recovery-write', '# copy'),
      call('markdown:recovery-write', '# copy'),
      call('markdown:recovery-write', 7),
      // the copy's name hashes the absolute path, which differs per side: the save drops it
      save({ text: 'final' }),
    ],
  },
  // ---- the channels are the Markdown editor's ----
  {
    note: 'a view that did not load the Markdown editor is refused',
    views: [{ view: 3, surface: 'Html' }],
    calls: [
      call('markdown:consume-pending'),
      call('markdown:list-wiki-notes'),
      call('markdown:remember-wiki-fragment', 'a.md', 'x'),
      call('markdown:get-image-host'),
      call('markdown:seed-take'),
      call('markdown:note-append-take'),
      call('markdown:confirm-marked-export', 'odt'),
      send('markdown:dirty-changed', true),
      send('markdown:close-save-result', true),
      send('markdown:save-request-ack', true),
      send('markdown:read-text-result', { text: 't' }),
      send('markdown:headless-export-done', { ok: true }),
    ],
  },
]

/** a `d2/markdown:<what>` step: the shell's or another area's call into the editor */
const trigger = (what: string, args: unknown[] = [], more: { view?: number; defer?: true } = {}) =>
  triggerStep('markdown', what, args, more)

/**
 * The cases of the shell's and the other areas' calls into the editor
 * (`d2/markdown:<what>`, crates/shell-ipc/d2/src/markdown `probe_trigger`).
 * A call that waits for the renderer is deferred, answered, then awaited.
 * They run once ipc-probe routes `d2/` triggers.
 */
export const triggerCases: Case[] = [
  // needs trigger: open-view (createMarkdownView on a file), the per-view grant
  {
    note: 'a view the shell opened on a note reads it and saves to it',
    views: M,
    files: { 'documents/o.md': '# o' },
    calls: [
      trigger('open-view', [docs('o.md')]),
      call('markdown:consume-pending'),
      call('markdown:read-file', docs('o.md')),
      save({ text: '# o2' }),
    ],
  },
  // needs trigger: request-save, the save-request event and its two answers
  {
    note: 'a menu save waits for the renderer: the ack declines, the save resolves',
    views: M,
    files: { 'documents/m.md': 'm' },
    calls: [
      trigger('open-view', [docs('m.md')]),
      dirty,
      trigger('request-save', ['saveAs'], { defer: true }),
      send('markdown:save-request-ack', false),
      awaitStep(2),
      trigger('request-save', ['save'], { defer: true }),
      save({ text: 'saved' }),
      awaitStep(5),
      trigger('request-save', ['save']),
    ],
  },
  // needs trigger: request-close, the close-save-request event
  {
    note: 'closing a dirty note asks; Save waits for the renderer, Cancel keeps it',
    views: M,
    hosts: { shared: { dialogs: { message: [{ response: 0 }, { response: 2 }] } } },
    calls: [
      dirty,
      trigger('request-close', [], { defer: true }),
      send('markdown:close-save-result', true),
      awaitStep(1),
      trigger('request-close'),
    ],
  },
  // needs trigger: read-text, the read-text-request event
  {
    note: 'MCP reads the live text: an odd answer is text, none is an error',
    views: M,
    calls: [
      trigger('read-text', [], { defer: true }),
      send('markdown:read-text-result', { text: 42 }),
      awaitStep(0),
      trigger('read-text', [], { defer: true }),
      send('markdown:read-text-result', null),
      awaitStep(3),
    ],
  },
  // needs trigger: save-to-path, file-renamed, export-request, the file-renamed and export-request events
  {
    note: 'MCP saves to a path; the file is renamed; the menu exports',
    views: M,
    files: { 'documents/r.md': 'r' },
    calls: [
      trigger('open-view', [docs('r.md')]),
      trigger('save-to-path', [docs('mcp.md')], { defer: true }),
      save({ text: 'via mcp' }),
      awaitStep(1),
      trigger('file-renamed', [docs('mcp.md'), docs('moved.md')]),
      trigger('export-request', ['pdf']),
      trigger('is-dirty'),
    ],
  },
  // needs trigger: write-copies-now, the recovery-flush-request event
  {
    note: 'the OS ends the session: each dirty view is asked for its copy',
    views: M,
    hosts: { d2: { markdown: { now: NOW } } },
    calls: [
      call('markdown:recovery-open'),
      dirty,
      trigger('write-copies-now', [], { defer: true }),
      call('markdown:recovery-write', 'flushed'),
      awaitStep(2),
      trigger('discard-pending-assets'),
    ],
  },
  // needs trigger: queue-seed, queue-note-append (the note-append-ready event)
  {
    note: 'a seeded tab, and text queued for an open note, taken once',
    views: TWO,
    files: { documents: { dir: true } },
    hosts: { shared: { dialogs: { save: [docs('n.md')] } } },
    calls: [
      trigger('queue-seed', ['# seed']),
      call('markdown:seed-take'),
      call('markdown:seed-take'),
      { ...save({ text: '# n' }), view: 2 },
      trigger('queue-note-append', [docs('n.md'), 'one'], { view: 2 }),
      trigger('queue-note-append', [docs('n.md'), 'two'], { view: 2 }),
      trigger('queue-note-append', [docs('other.md'), 'three'], { view: 1 }),
      { ...call('markdown:note-append-take'), view: 2 },
      { ...call('markdown:note-append-take'), view: 2 },
      call('markdown:note-append-take'),
    ],
  },
  // needs trigger: export-pdf-headless
  {
    note: 'a headless PDF export hands its target once and settles on the report',
    views: TWO,
    files: { 'documents/h.md': '# h', out: { dir: true } },
    calls: [
      trigger('export-pdf-headless', [docs('h.md'), '$DIR/out/h.pdf', 5000], {
        view: 2,
        defer: true,
      }),
      { ...call('markdown:consume-headless-export'), view: 2 },
      { ...call('markdown:consume-headless-export'), view: 2 },
      { ...send('markdown:headless-export-done', { ok: false, error: 'boom' }), view: 2 },
      awaitStep(0),
    ],
  },
]

/** what a case loaded: the module, its context, the views it steers */
interface Loaded {
  mod: MarkdownMain
  cx: LoadContext
  steer: TextEditorElectron
}

const wc = (l: Loaded, view: number) => l.cx.electron.contents(view) as never
const str = (v: unknown) => String(v ?? '')

/** the shell's and the other areas' calls into the editor, by trigger `<what>` */
const OUTBOUND: Outbound<Loaded> = {
  'open-view': (l, view, [path]) => {
    l.steer.nextView = view
    l.mod.createMarkdownView(typeof path === 'string' ? path : null)
  },
  'request-save': (l, view, [mode]) =>
    l.mod.requestMarkdownSave(wc(l, view), mode === 'saveAs' ? 'saveAs' : 'save'),
  'request-close': (l, view) => {
    const windows = l.cx.electron.BrowserWindow as { fromWebContents(wc: unknown): unknown }
    return l.mod.requestMarkdownClose(wc(l, view), windows.fromWebContents(wc(l, view)) as never)
  },
  'read-text': (l, view) => l.mod.markdownReadText(wc(l, view)),
  'save-to-path': (l, view, [path]) => l.mod.markdownSaveToPath(wc(l, view), str(path)),
  'file-renamed': (l, view, [from, to]) =>
    l.mod.markdownFileRenamed(wc(l, view), str(from), str(to)),
  'export-request': (l, view, [format]) =>
    l.mod.sendMarkdownExportRequest(wc(l, view), str(format) as never),
  'discard-pending-assets': (l, view) => l.mod.markdownDiscardPendingAssets(wc(l, view)),
  'is-dirty': (l, view) => l.mod.markdownIsDirty(view),
  'write-copies-now': (l) => l.mod.markdownRecoveryEditor.writeCopiesNow(),
  'queue-seed': (l, view, [text]) => queueMarkdownSeedFor(wc(l, view), str(text)),
  'queue-note-append': (l, view, [path, text]) =>
    queueMarkdownNoteAppendFor(wc(l, view), str(path), str(text)),
  'export-pdf-headless': (l, view, [input, out, timeout]) => {
    l.steer.nextHidden = view
    return l.mod.exportMarkdownPdfHeadless(str(input), str(out), Number(timeout))
  },
}

let loaded: Loaded | null = null

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    const steer = setUpTextCase(cx, 'markdown')
    const a = answers()
    const log = cx.electron.log
    const mod = await cx.fresh<MarkdownMain>(ENTRY)
    const runtime: Parameters<MarkdownMain['configureMarkdownRuntime']>[0] = {
      preloadPath: 'preload.js',
    }
    if (a.has('open_generated_path'))
      runtime.openGeneratedPath = (path) => {
        log.push(['openGeneratedPath', path])
        return a.bool('open_generated_path', false)
      }
    if (a.has('new_document_dir'))
      runtime.newDocumentDir = async (wcId) => {
        log.push(['newDocumentDir', wcId])
        return a.string('new_document_dir')
      }
    if (a.has('write_new_document'))
      runtime.writeNewDocument = async (wcId, name, bytes) => {
        log.push(['writeNewDocument', wcId, name])
        const dir = a.string('write_new_document')
        if (dir === null) return null
        const path = join(dir, name)
        writeFileSync(path, bytes)
        return path
      }
    mod.configureMarkdownRuntime(runtime)
    mod.setMarkdownFileSavedHook((wc, path) => log.push(['fileSavedHook', wc.id, path]))
    mod.setMarkdownDocxExportedHook((path) => log.push(['docxExportedHook', path]))
    // the shell's first Markdown tab registers the editor's handlers
    mod.createMarkdownView(null)
    loaded = { mod, cx, steer }
  },
  triggers: groupTriggers('markdown', OUTBOUND, () => {
    if (!loaded) throw new Error('no d2/markdown case is loaded')
    return loaded
  }),
  cases,
  single: {},
}
