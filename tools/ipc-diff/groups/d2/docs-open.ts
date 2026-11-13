/**
 * The Word editor: opening documents (the dialog, a path, a password, a
 * legacy .doc converted first, a recovery copy offered), the first-document
 * queues, recent files, the headless export's two channels.
 *
 * The queues are filled only by the shell (`markDocsNewBlank`,
 * `queueDocsCopy`, `createDocsView(openPath)`, `exportDocsHeadless`): their
 * filled answers need a trigger step; here they answer as an empty queue.
 */
import type { Case, Group } from '../../types.ts'
import { loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]

const docCase = (c: Omit<Case, 'views'>): Case => ({ views, ...c })

export const group: Group = {
  batch: 'D2',
  async load(cx) {
    await loadDocs(cx)
  },
  single: {
    'docs:headless-export-done':
      'without the shell headless export (a trigger) no waiter takes the report: every call answers nothing',
  },
  cases: [
    docCase({
      note: 'no recent files yet',
      calls: [{ channel: 'docs:recent', args: [] }],
    }),
    docCase({
      note: 'recent.json as the shell home and File menu share it, no existence filter',
      files: { 'userData/recent.json': '["/gone/a.docx","$DIR/b.odt"]' },
      calls: [{ channel: 'docs:recent', args: [] }],
    }),
    docCase({
      note: 'a corrupted recent.json reads as none',
      files: { 'userData/recent.json': '{not json' },
      calls: [{ channel: 'docs:recent', args: [] }],
    }),
    docCase({
      note: 'a path opens: hand-off URL, hash, original archived, recent entry, the shell told',
      files: { 'docs/a.docx': 'PK plain docx' },
      calls: [
        { channel: 'docs:open-path', args: ['$DIR/docs/a.docx'] },
        { channel: 'docs:recent', args: [] },
      ],
    }),
    docCase({
      note: 'an ODT opens whole (no lazy pictures)',
      files: { 'docs/b.odt': 'odt bytes' },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/b.odt'] }],
    }),
    docCase({
      note: 'a lazily opened docx carries the slim bytes and the hash of the whole file',
      files: { 'docs/big.docx': 'the whole file' },
      hosts: { d2: { docs: { open_lazy_docx: { bytes: 'slim', hash: 'abc123' } } } },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/big.docx'] }],
    }),
    docCase({
      note: 'what is no Word document, or not there, or not a string, opens nothing',
      files: { 'docs/notes.txt': 'x' },
      calls: [
        { channel: 'docs:open-path', args: ['$DIR/docs/notes.txt'] },
        { channel: 'docs:open-path', args: ['$DIR/docs/missing.docx'] },
        { channel: 'docs:open-path', args: [7] },
        { channel: 'docs:open-path', args: [] },
      ],
    }),
    docCase({
      note: 'a compound file that is no sound container is refused with an error box',
      files: { 'docs/broken.docx': { hex: `d0cf11e0a1b11ae1${'00'.repeat(24)}` } },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/broken.docx'] }],
    }),
    docCase({
      note: 'the open dialog cancelled, then a pick',
      files: { 'docs/c.docx': 'PK c' },
      hosts: { shared: { dialogs: { open: [null, ['$DIR/docs/c.docx']] } } },
      calls: [
        { channel: 'docs:open', args: [] },
        { channel: 'docs:open', args: [] },
      ],
    }),
    docCase({
      note: 'Korean UI: the open dialog in Korean',
      hosts: { d2: { docs: { ui_lang: 'ko' } } },
      calls: [{ channel: 'docs:open', args: [] }],
    }),
    docCase({
      note: 'a legacy .doc: confirmed, converted into the picked .docx, then opened',
      files: { 'docs/old.doc': 'word97 bytes' },
      hosts: {
        shared: {
          dialogs: {
            message: [{ response: 0, checkboxChecked: true }],
            save: ['$DIR/docs/new.docx'],
          },
        },
        d2: { docs: { convert_legacy_doc: 'converted docx' } },
      },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/old.doc'] }],
    }),
    docCase({
      note: 'a legacy .doc: the conversion box cancelled',
      files: { 'docs/old.dot': 'word97' },
      hosts: { shared: { dialogs: { message: [{ response: 1 }] } } },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/old.dot'] }],
    }),
    docCase({
      note: 'a legacy .doc: the original refused as the target, then a name without .docx gets it',
      files: {
        'docs/old.doc': 'word97',
        'userData/app-settings.json': '{"legacyImportSkipConfirm":{"word97":true}}',
      },
      hosts: {
        shared: {
          dialogs: { message: [{ response: 0 }], save: ['$DIR/docs/OLD.DOC', '$DIR/docs/copy'] },
        },
      },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/old.doc'] }],
    }),
    docCase({
      note: 'a legacy .doc the converter refuses',
      files: { 'docs/bad.doc': 'nope' },
      hosts: {
        shared: { dialogs: { message: [{ response: 0 }], save: ['$DIR/docs/bad.docx'] } },
        d2: { docs: { convert_legacy_doc: { error: 'not a Word 97 file' } } },
      },
      calls: [{ channel: 'docs:open-path', args: ['$DIR/docs/bad.doc'] }],
    }),
    docCase({
      note: 'open-decrypt: its argument checks, a missing file, a plain file opens',
      files: { 'docs/plain.docx': 'PK' },
      calls: [
        { channel: 'docs:open-decrypt', args: ['$DIR/docs/plain.docx', ''] },
        { channel: 'docs:open-decrypt', args: [1, 'pw'] },
        { channel: 'docs:open-decrypt', args: ['$DIR/docs/missing.docx', 'pw'] },
        { channel: 'docs:open-decrypt', args: ['$DIR/docs/plain.docx', 'pw'] },
      ],
    }),
    docCase({
      // a copy's file name hashes its document's absolute path, which differs
      // between the two sides' folders: the case saves, so no copy remains
      note: 'a crash copy of the file is offered when it opens: restored, then saved',
      files: { 'docs/r.docx': 'on disk' },
      hosts: { shared: { dialogs: { message: [{ response: 0 }] } } },
      calls: [
        { channel: 'docs:open-path', args: ['$DIR/docs/r.docx'] },
        {
          channel: 'docs:write-recovery',
          args: ['$DIR/docs/r.docx', { $: 'b', k: 'ab', i: 0 }],
          buffers: [Buffer.from('unsaved edits').toString('hex')],
        },
        { channel: 'docs:open-path', view: 2, args: ['$DIR/docs/r.docx'] },
        {
          channel: 'docs:save',
          view: 2,
          args: ['$DIR/docs/r.docx', { $: 'b', k: 'ab', i: 0 }],
          buffers: [Buffer.from('saved edits').toString('hex')],
        },
      ],
      views: [
        { view: 1, window: 1, surface: 'Docs' },
        { view: 2, window: 2, surface: 'Docs' },
      ],
    } as Case),
    docCase({
      note: 'a crash copy discarded at the prompt: the file opens and the copy goes',
      files: { 'docs/r.docx': 'on disk' },
      hosts: { shared: { dialogs: { message: [{ response: 1 }] } } },
      calls: [
        { channel: 'docs:open-path', args: ['$DIR/docs/r.docx'] },
        {
          channel: 'docs:write-recovery',
          args: ['$DIR/docs/r.docx', { $: 'b', k: 'ab', i: 0 }],
          buffers: [Buffer.from('edits').toString('hex')],
        },
        { channel: 'docs:open-path', view: 2, args: ['$DIR/docs/r.docx'] },
      ],
      views: [
        { view: 1, window: 1, surface: 'Docs' },
        { view: 2, window: 2, surface: 'Docs' },
      ],
    } as Case),
    docCase({
      note: 'the first-document queues answer empty without the shell having filled them',
      calls: [
        { channel: 'docs:consume-pending-open', args: [] },
        { channel: 'docs:consume-new-blank', args: [] },
        { channel: 'docs:consume-copy', args: [] },
        { channel: 'docs:consume-headless-export', args: [] },
        { channel: 'docs:headless-export-done', kind: 'send', args: [{ ok: true }] },
      ],
    }),
    {
      note: 'a channel of the Word editor is refused from another surface',
      views: [{ view: 1, window: 1, surface: 'Shell' }],
      calls: [{ channel: 'docs:recent', args: [] }],
    },
  ].map((c) => (c.views ? c : { ...c, views })),
}
