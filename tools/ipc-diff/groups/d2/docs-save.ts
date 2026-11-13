/**
 * The Word editor's saves: `docs:save` (with the external-change guard),
 * Save As in its two steps, the first save into the default folder or a
 * project, the MCP save to a path, the open password, the marked-ODT box,
 * pictures put back, and the crash-recovery copies.
 */
import type { Case, Call, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]
const two = [
  { view: 1, window: 1, surface: 'Docs' },
  { view: 2, window: 2, surface: 'Docs' },
]

/** a call whose arguments end with one ArrayBuffer of `text` (or bytes in hex) */
function withBytes(channel: string, args: unknown[], text: string, view?: number): Call {
  return {
    channel,
    ...(view === undefined ? {} : { view }),
    args: args.map((a) => (a === BYTES ? { $: 'b', k: 'ab', i: 0 } : a)),
    buffers: [Buffer.from(text).toString('hex')],
  }
}
const BYTES = Symbol('bytes')

const open = (path: string, view?: number): Call => ({
  channel: 'docs:open-path',
  ...(view === undefined ? {} : { view }),
  args: [path],
})

const cases: Case[] = [
  {
    note: 'save refuses a path this view did not open, and a path that is no string',
    files: { 'docs/a.docx': 'PK a' },
    calls: [
      withBytes('docs:save', ['$DIR/docs/a.docx', BYTES], 'mine'),
      withBytes('docs:save', [3, BYTES], 'mine'),
    ],
  },
  {
    note: 'open then save: the file is written and its recent entry stays first',
    files: { 'docs/a.docx': 'PK a' },
    calls: [
      open('$DIR/docs/a.docx'),
      withBytes('docs:save', ['$DIR/docs/a.docx', BYTES], 'saved body'),
    ],
  },
  {
    note: 'save of bytes of the other format is refused with the reason',
    files: { 'docs/b.odt': 'odt' },
    calls: [
      open('$DIR/docs/b.odt'),
      withBytes('docs:save', ['$DIR/docs/b.odt', BYTES], 'not a zip'),
    ],
  },
  {
    note: 'another window changed the file: autosave refuses, a manual save asks (cancel, then overwrite)',
    views: two,
    files: { 'docs/a.docx': 'PK a' },
    hosts: { shared: { dialogs: { message: [{ response: 1 }, { response: 0 }] } } },
    calls: [
      open('$DIR/docs/a.docx'),
      open('$DIR/docs/a.docx', 2),
      withBytes('docs:save', ['$DIR/docs/a.docx', BYTES], 'from window two, longer', 2),
      { ...withBytes('docs:save', ['$DIR/docs/a.docx', BYTES, true], 'auto'), view: 1 },
      withBytes('docs:save', ['$DIR/docs/a.docx', BYTES], 'mine'),
      withBytes('docs:save', ['$DIR/docs/a.docx', BYTES], 'mine'),
    ],
  },
  {
    note: 'Save As: the dialog cancelled, a pick, a write to another path refused, the pick written once',
    hosts: {
      shared: { dialogs: { save: [null, '$DIR/out/report'] } },
      d2: { docs: { file_saved: '$DIR/out/filed.docx' } },
    },
    files: { out: { dir: true } },
    calls: [
      { channel: 'docs:save-as-pick', args: ['report.docx'] },
      { channel: 'docs:save-as-pick', args: ['report.docx'] },
      withBytes('docs:save-as', ['$DIR/out/other.docx', BYTES], 'x'),
      withBytes('docs:save-as', ['$DIR/out/report.docx', BYTES], 'report body'),
      withBytes('docs:save-as', ['$DIR/out/report.docx', BYTES], 'again'),
    ],
  },
  {
    note: 'Save As of an ODT document from its file, with exports offered: the ODT filter first',
    files: { 'docs/b.odt': 'odt' },
    hosts: { shared: { dialogs: { save: ['$DIR/docs/b-copy.odt'] } } },
    calls: [{ channel: 'docs:save-as-pick', args: ['b.odt', '$DIR/docs/b.odt', 'odt', true] }],
  },
  {
    note: 'Save As picks of the exports: PDF authorized, page images get a temp PDF and their folder',
    hosts: { shared: { dialogs: { save: ['$DIR/out/d.pdf', '$DIR/out/pages.png'] } } },
    calls: [
      { channel: 'docs:save-as-pick', args: ['d.docx', null, 'docx', true] },
      { channel: 'docs:save-as-pick', args: ['d.docx', null, 'docx', true] },
    ],
  },
  {
    note: 'Save As of a never-saved document in a project: offered in the project folder',
    hosts: {
      shared: { dialogs: { save: [null] } },
      d2: { docs: { new_document_dir: '$DIR/project' } },
    },
    calls: [
      { channel: 'docs:save-as-pick', args: ['Untitled.docx'] },
      { channel: 'docs:save-as-pick', args: [42] },
    ],
  },
  {
    note: 'first saves land in the default folder under a free name; then the file is this view\u2019s',
    calls: [
      withBytes('docs:save-new', ['Doc.docx', BYTES], 'one'),
      withBytes('docs:save-new', ['Doc.docx', BYTES], 'two'),
      withBytes('docs:save', ['$DIR/documents/SeuOffice/Doc.docx', BYTES], 'three'),
      withBytes('docs:save-new', [5, BYTES], 'bad'),
    ],
  },
  {
    note: 'save-into-project without a project, with a bad request, written by the shell, then skipped',
    hosts: { d2: { docs: { write_new_document: [null, '$DIR/project/My_ Doc.docx'] } } },
    files: { project: { dir: true } },
    calls: [
      withBytes('docs:save-into-project', ['n', 'docx', BYTES], 'x'),
      { channel: 'docs:save-into-project', args: ['n', 'docx', 'not bytes'] },
      withBytes('docs:save-into-project', ['dir/My: Doc.docx', 'docx', BYTES], 'body'),
      withBytes('docs:save-into-project', ['n', 'docx', BYTES], 'x'),
    ],
  },
  {
    note: 'save-into-project when the shell has no project hook',
    hosts: { d2: { docs: { write_new_document: 'none' } } },
    calls: [withBytes('docs:save-into-project', ['n', 'odt', BYTES], 'x')],
  },
  {
    // the MCP grant (authorizeMcpDocWrite) is a shell call: needs trigger: d2/docs:authorize-mcp-doc-write
    note: 'save-to: an absolute .docx path this view may write; an existing file needs overwrite',
    files: { 'docs/m.docx': 'PK m' },
    calls: [
      withBytes('docs:save-to', ['rel.docx', BYTES, false], 'x'),
      withBytes('docs:save-to', ['$DIR/docs/m.txt', BYTES, false], 'x'),
      withBytes('docs:save-to', ['$DIR/docs/new.docx', BYTES, false], 'x'),
      open('$DIR/docs/m.docx'),
      withBytes('docs:save-to', ['$DIR/docs/m.docx', BYTES, false], 'x'),
      withBytes('docs:save-to', ['$DIR/docs/m.docx', BYTES, true], 'mcp body'),
    ],
  },
  {
    note: 'the open password: refused arguments, set for the open file, then the save is encrypted',
    files: { 'docs/p.docx': 'PK p' },
    calls: [
      { channel: 'docs:set-password', args: ['$DIR/docs/p.docx', 'pw'] },
      open('$DIR/docs/p.docx'),
      { channel: 'docs:set-password', args: ['$DIR/docs/p.docx', ''] },
      { channel: 'docs:set-password', args: [5, 'pw'] },
      { channel: 'docs:set-password', args: ['$DIR/docs/p.docx', 'pw'] },
      { channel: 'docs:password-intent-revision', args: [] },
      withBytes('docs:save', ['$DIR/docs/p.docx', BYTES], 'secret'),
      { channel: 'docs:password-intent-revision', args: [] },
    ],
  },
  {
    note: 'a password intent discarded through its revision: the first save is plain',
    calls: [
      { channel: 'docs:discard-password-intents', args: [-1] },
      { channel: 'docs:discard-password-intents', args: [1.5] },
      { channel: 'docs:discard-password-intents', args: ['1'] },
      { channel: 'docs:set-password', args: [null, 'pw'] },
      { channel: 'docs:discard-password-intents', args: [1] },
      withBytes('docs:save-new', ['plain.docx', BYTES], 'plain'),
    ],
  },
  {
    note: 'a pending password of a new document encrypts its first save',
    calls: [
      { channel: 'docs:set-password', args: [null, 'pw'] },
      withBytes('docs:save-new', ['enc.docx', BYTES], 'secret'),
    ],
  },
  {
    note: 'the marked-ODT box answers the button pressed',
    hosts: {
      shared: { dialogs: { message: [{ response: 0 }, { response: 1 }, { response: 2 }] } },
    },
    calls: [
      { channel: 'docs:confirm-marked-odt', args: [] },
      { channel: 'docs:confirm-marked-odt', args: [] },
      { channel: 'docs:confirm-marked-odt', args: [] },
    ],
  },
  {
    note: 'materialize takes an ArrayBuffer only; a failing picture step answers null',
    hosts: {
      d2: {
        docs: { materialize_lazy_docx: [{ bytes: 'whole', hashes: ['h'] }, { error: 'zip' }] },
      },
    },
    calls: [
      { channel: 'docs:materialize-docx', args: [{ $: 'b', k: 'u8', i: 0 }], buffers: ['6869'] },
      withBytes('docs:materialize-docx', [BYTES], 'slim'),
      withBytes('docs:materialize-docx', [BYTES], 'slim'),
    ],
  },
  {
    note: 'lazy pictures absorbed by a save point at the saved file',
    files: { 'docs/l.docx': 'PK l' },
    hosts: {
      d2: { docs: { materialize_lazy_docx: { bytes: 'whole doc', hashes: ['h1', 'h2'] } } },
    },
    calls: [open('$DIR/docs/l.docx'), withBytes('docs:save', ['$DIR/docs/l.docx', BYTES], 'slim')],
  },
  {
    note: 'recovery copies: refused without a grant or bytes; an untitled document writes its slot',
    calls: [
      withBytes('docs:write-recovery', ['$DIR/docs/x.docx', BYTES], 'x'),
      { channel: 'docs:write-recovery', args: [null, 'text'] },
      withBytes('docs:write-recovery', [null, BYTES, { title: 'Draft', format: 'docx' }], 'draft'),
      withBytes(
        'docs:write-recovery',
        [null, BYTES, { title: 'Draft 2', format: 'docx' }],
        'draft 2',
      ),
    ],
  },
  {
    note: 'an untitled ODT copy refuses docx bytes and keeps its own',
    calls: [
      withBytes('docs:write-recovery', [null, BYTES, { title: 'O', format: 'odt' }], 'not odt'),
    ],
  },
  {
    note: 'a new document waiting for its first password save writes no plain copy',
    calls: [
      { channel: 'docs:set-password', args: [null, 'pw'] },
      withBytes('docs:write-recovery', [null, BYTES, { title: 'S' }], 'secret'),
    ],
  },
  {
    note: 'the first save drops the untitled copy',
    calls: [
      withBytes('docs:write-recovery', [null, BYTES, { title: 'T', originalPath: '' }], 'draft'),
      withBytes('docs:save-new', ['T.docx', BYTES], 'saved'),
    ],
  },
  {
    note: 'a write-recovery-now token nobody waits for',
    calls: [
      {
        channel: 'docs:write-recovery-now-done',
        kind: 'send',
        args: ['00000000-0000-4000-8000-000000000001'],
      },
      { channel: 'docs:write-recovery-now-done', kind: 'send', args: [7] },
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    await loadDocs(cx)
  },
  single: {
    'docs:write-recovery-now-done':
      'a send: it answers nothing; the waiter it resumes comes from writeCopiesNow (a trigger)',
  },
  cases: cases.map((c) => (c.views ? c : { ...c, views })),
}
