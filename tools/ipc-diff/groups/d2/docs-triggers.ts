/**
 * The Word editor as the shell calls it (trigger steps `d2/docs:<what>`):
 * the queues the shell fills before a tab's first request, the rename,
 * teardown and discard of a tab, crash recovery's contract (session end,
 * launch-list opens, untitled copies), the MCP write grant, and the AI's new
 * documents. These emit the events no renderer call emits: docs:opened,
 * docs:renamed, docs:teardown, docs:write-recovery-now,
 * docs:recovery-copy-dropped.
 *
 * The trigger step is being added to tools/ipc-diff (main.ts, ipc-probe):
 * until then these cases cannot run.
 */
import type { Case, Group, LoadContext } from '../../types.ts'
import { type DocsTriggers, docsTriggers, loadDocs } from './docs-load.ts'

const views = [{ view: 1, window: 1, surface: 'Docs' }]
const trigger = (name: string, args: unknown[] = [], view = 1) => ({
  kind: 'trigger',
  name: `d2/docs:${name}`,
  view,
  args,
})
const ab = { $: 'b', k: 'ab', i: 0 }
const hex = (text: string): string => Buffer.from(text).toString('hex')

const cases = [
  {
    note: 'a tab marked blank starts blank once',
    calls: [
      trigger('mark-new-blank'),
      { channel: 'docs:consume-new-blank', args: [] },
      { channel: 'docs:consume-new-blank', args: [] },
    ],
  },
  {
    note: 'a skill template copy is the tab\u2019s first document, once, with no file of its own',
    files: { 'tpl/report.docx': 'template' },
    calls: [
      trigger('queue-copy', [{ path: '$DIR/tpl/report.docx', name: 'Report.docx' }]),
      { channel: 'docs:consume-copy', args: [] },
      { channel: 'docs:consume-copy', args: [] },
    ],
  },
  {
    note: 'a launch-list open before the tab booted waits in the queue; after, it is sent as docs:opened',
    files: { 'docs/a.docx': 'PK a' },
    calls: [
      trigger('open-file-with-decision', [{ filePath: '$DIR/docs/a.docx', decision: 'original' }]),
      { channel: 'docs:consume-pending-open', args: [] },
      { channel: 'docs:consume-copy', args: [] },
      trigger('open-file-with-decision', [{ filePath: '$DIR/docs/a.docx', decision: 'original' }]),
    ],
  },
  {
    note: 'the MCP grant lets docs:save-to write a new file',
    calls: [
      trigger('authorize-mcp-doc-write', ['$DIR/mcp/out.docx']),
      { channel: 'docs:save-to', args: ['$DIR/mcp/out.docx', ab, false], buffers: [hex('mcp')] },
    ],
  },
  {
    note: 'a renamed file: the renderer hears it, the save grant follows the name',
    files: { 'docs/old.docx': 'PK', 'docs/new.docx': 'PK' },
    calls: [
      { channel: 'docs:open-path', args: ['$DIR/docs/old.docx'] },
      trigger('file-renamed', ['$DIR/docs/old.docx', '$DIR/docs/new.docx']),
      { channel: 'docs:save', args: ['$DIR/docs/new.docx', ab], buffers: [hex('renamed')] },
    ],
  },
  {
    note: 'a torn-down tab is told and loses its writes',
    files: { 'docs/t.docx': 'PK' },
    calls: [
      { channel: 'docs:open-path', args: ['$DIR/docs/t.docx'] },
      trigger('teardown'),
      { channel: 'docs:save', args: ['$DIR/docs/t.docx', ab], buffers: [hex('late')] },
      { channel: 'docs:password-intent-revision', args: [] },
    ],
  },
  {
    note: 'a discarded tab drops its untitled copy and tells the renderer',
    calls: [
      {
        channel: 'docs:write-recovery',
        args: [null, ab, { title: 'Draft' }],
        buffers: [hex('draft')],
      },
      trigger('recovery-identity'),
      trigger('discard-recovery'),
      {
        channel: 'docs:write-recovery',
        args: [null, ab, { title: 'Draft' }],
        buffers: [hex('again')],
      },
    ],
  },
  {
    note: 'session end: every booted tab is asked for a copy; one answers, the wait ends',
    calls: [{ channel: 'docs:consume-copy', args: [] }, trigger('write-copies-now')],
  },
  {
    note: 'an untitled copy restored into a tab that has booted',
    files: {
      'userData/docs-autosave/untitled/00000000-0000-4000-8000-0000000000aa.docx': 'kept draft',
      'userData/docs-autosave/untitled/00000000-0000-4000-8000-0000000000aa.docx.meta.json':
        '{"version":1,"kind":"docs","filePath":null,"untitledId":"00000000-0000-4000-8000-0000000000aa","title":"Kept","writtenAt":1,"runId":"x","state":"later"}',
    },
    calls: [
      { channel: 'docs:consume-copy', args: [] },
      trigger('open-untitled-copy', [
        {
          copy: { kind: 'docs', untitledId: '00000000-0000-4000-8000-0000000000aa', ext: '.docx' },
          title: '',
        },
      ]),
    ],
  },
  {
    note: 'another app asks for an AI document',
    calls: [trigger('create-ai-document', [{ type: 'md', title: 'Notes', content: '# n' }])],
  },
] as unknown as Case[]

let triggers: DocsTriggers = {}

export const group = {
  batch: 'D2',
  async load(cx: LoadContext) {
    triggers = docsTriggers(await loadDocs(cx), cx)
  },
  /** the TypeScript side of a trigger step */
  trigger: (name: string, view: number, args: unknown[]) =>
    triggers[name.replace(/^d2\/docs:/, '')]?.(view, args),
  cases: cases.map((c) => (c.views ? c : { ...c, views })),
} as Group
