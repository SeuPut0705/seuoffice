/**
 * Group `w/projects-trust`: the requests that reach the first-time trust
 * prompt in the middle of the guide's call: add a folder, create a project,
 * relocate one, adopt the folder a document hints at, change a project's
 * trust. The prompt is a message box over the asking window (the shared
 * hosts' `dialogs.message`: 0 use, 1 use without instructions, 2 view all,
 * 3 cancel); [view all] opens the quoted files in the app and waits for the
 * person to come back to the page, which the cases drive with the
 * `w/projects:*` triggers while the request is deferred and other requests are
 * served. `project-ipc.ts` and `project-guide.ts` over the world of
 * projects-lib/load.ts.
 */
import type { Call, Case, Group } from '../../types.ts'
import {
  hostsOf,
  loadProjects,
  projectFolder,
  projectsSettings,
  request,
  trigger,
  triggers,
  withViews,
} from './projects-lib/load.ts'

const MTIME = 1_700_000_000_000
const doc = (n: number, text: string) => ({ text, mtimeMs: MTIME + n * 1000 })

/** a folder another install wrote instructions, memory and a chat into: the prompt quotes them */
const written = (folder: string, id: string, name: string, more: NonNullable<Case['files']> = {}) =>
  projectFolder(folder, id, name, {
    [`${folder}/.seuoffice/instructions.md`]: 'Use a formal tone.\n',
    [`${folder}/.seuoffice/memory.md`]: '<!-- memory -->\n- the client is Kim\n',
    [`${folder}/AGENTS.md`]: 'Read the style guide first.\n',
    [`${folder}/.seuoffice/chats/other.json`]: JSON.stringify({
      version: 1,
      id: 'other',
      projectId: id,
      title: 'From my laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      origin: 'laptop-install',
      lastEditor: 'docs',
      documents: [],
    }),
    [`${folder}/.seuoffice/chats/other.jsonl`]: `${JSON.stringify({
      seq: 0,
      ts: '2026-01-02T00:00:00.000Z',
      role: 'user',
      text: 'hi',
      editor: 'docs',
      origin: 'laptop-install',
    })}\n`,
    ...more,
  })

const world = (extra: NonNullable<Case['files']> = {}): Case['files'] => ({
  ...projectsSettings([
    { id: 'p1', path: '$DIR/work/alpha' },
    { id: 'p2', path: '$DIR/work/gone', pinned: true },
  ]),
  ...projectFolder('work/alpha', 'p1', 'Alpha', { 'work/alpha/notes.md': doc(1, '# notes\n') }),
  'save/keep.txt': '',
  ...extra,
})

/** what the person does: the folders the picker returns, the answers of the message boxes */
const person = (picks: (string | null)[], answers: number[]) => ({
  dialogs: {
    open: picks.map((pick) => (pick === null ? null : [pick])),
    message: answers.map((response) => ({ response })),
  },
})

const USE = 0
const WITHOUT = 1
const VIEW = 2
const CANCEL = 3

const deferred = (call: Call): Call => ({ ...call, defer: true })
const awaited = (index: number): Call => ({ channel: '', args: [], await: index })

const cases: Case[] = [
  {
    note: 'add a folder: the picker is closed; a plain folder is added at once; a protected folder is refused',
    views: withViews(1),
    files: world({
      ...projectFolder('work/plain', 'p3', 'Plain'),
      'work/bare/file.md': doc(2, 'bare\n'),
    }),
    hosts: hostsOf(
      {},
      {},
      person([null, '$DIR/work/plain', '$DIR/work/bare', '$DIR/userData'], []),
    ),
    calls: [
      request('addFolder', 1),
      request('addFolder', 1),
      request('listProjects', 1),
      request('addFolder', 1),
      request('addFolder', 1),
      request('listProjects', 1),
    ],
  },
  {
    note: 'add a folder with instructions another install wrote: use, use without, cancel',
    views: withViews(1),
    files: world({
      ...written('work/gamma', 'g1', 'Gamma'),
      ...written('work/delta', 'd1', 'Delta'),
      ...written('work/eps', 'e1', 'Epsilon'),
    }),
    hosts: hostsOf(
      {},
      {},
      person(['$DIR/work/gamma', '$DIR/work/delta', '$DIR/work/eps'], [USE, WITHOUT, CANCEL]),
    ),
    calls: [
      request('addFolder', 1),
      request('addFolder', 1),
      request('addFolder', 1),
      request('listProjects', 1),
      request('getProjectDetail', 1, { projectId: 'g1' }),
      request('getProjectDetail', 1, { projectId: 'd1' }),
    ],
  },
  {
    note: 'the prompt closed by a key: a closed prompt cancels; the same folder asks again the next time',
    views: withViews(1),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma', '$DIR/work/gamma'], [7, USE])),
    calls: [request('addFolder', 1), request('addFolder', 1), request('listProjects', 1)],
  },
  {
    note: '[view all]: the files open in the app, the request waits; the person blurs, comes back, and chooses',
    views: withViews(3),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [VIEW, USE])),
    calls: [
      deferred(request('addFolder', 1)),
      request('listProjects', 1),
      trigger('blur'),
      request('listProjects', 1),
      trigger('focus'),
      awaited(0),
      request('listProjects', 1),
    ],
  },
  {
    note: '[view all]: a focus right after the box closed is no return until the timer ran; then it is',
    views: withViews(3),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [VIEW, WITHOUT])),
    calls: [
      deferred(request('addFolder', 1)),
      request('listProjects', 1),
      trigger('focus'),
      request('listProjects', 1),
      trigger('timer'),
      trigger('focus'),
      awaited(0),
    ],
  },
  {
    note: '[view all], then the page goes away: the addition is cancelled',
    views: withViews(3),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [VIEW])),
    calls: [
      deferred(request('addFolder', 1)),
      request('listProjects', 1),
      trigger('destroyed'),
      awaited(0),
      request('listProjects', 1),
    ],
  },
  {
    note: '[view all] twice: the prompt shows again after each return',
    views: withViews(4),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [VIEW, VIEW, CANCEL])),
    calls: [
      deferred(request('addFolder', 1)),
      request('listProjects', 1),
      trigger('blur'),
      trigger('focus'),
      request('listProjects', 1),
      trigger('blur'),
      trigger('focus'),
      awaited(0),
    ],
  },
  {
    note: '[view all] of a folder with only chats: nothing opens in the app, the prompt shows again at once',
    views: withViews(1),
    files: world(
      projectFolder('work/gamma', 'g1', 'Gamma', {
        'work/gamma/.seuoffice/chats/other.json': JSON.stringify({
          version: 1,
          id: 'other',
          projectId: 'g1',
          title: 'From my laptop',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          origin: 'laptop-install',
          lastEditor: 'docs',
          documents: [],
        }),
        'work/gamma/.seuoffice/chats/other.jsonl': `${JSON.stringify({
          seq: 0,
          ts: '2026-01-02T00:00:00.000Z',
          role: 'user',
          text: 'hi',
          editor: 'docs',
          origin: 'laptop-install',
        })}\n`,
      }),
    ),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [VIEW, USE])),
    calls: [request('addFolder', 1), request('listProjects', 1)],
  },
  {
    note: 'create a project: the default place, a blank name, a name that exists and the person confirms, or declines',
    views: withViews(1),
    files: world({
      'save/Taken/old.md': doc(3, 'old\n'),
      'save/Twice/old.md': doc(3, 'old\n'),
    }),
    hosts: hostsOf({}, {}, person([], [USE, CANCEL])),
    calls: [
      request('createProject', 1, { name: ' New one ' }),
      request('createProject', 1, { name: '   ' }),
      request('createProject', 1, {}),
      request('createProject', 1, { name: 'Taken' }),
      request('createProject', 1, { name: 'Twice' }),
      request('listProjects', 1),
    ],
  },
  {
    note: 'create a project somewhere else: the person picks the parent, or closes the picker',
    views: withViews(1),
    files: world({ 'elsewhere/keep.txt': '' }),
    hosts: hostsOf({}, {}, person(['$DIR/elsewhere', null], [])),
    calls: [
      request('createProject', 1, { name: 'Over there', otherPlace: true }),
      request('createProject', 1, { name: 'Nowhere', otherPlace: true }),
      request('createProject', 1, { name: 'Default place', otherPlace: 'yes' }),
      request('listProjects', 1),
    ],
  },
  {
    note: 'create a project from an existing folder with instructions: the prompt asks after the confirmation',
    views: withViews(1),
    files: world(written('save/Written', 'w1', 'Written')),
    hosts: hostsOf({}, {}, person([], [USE, USE])),
    calls: [request('createProject', 1, { name: 'Written' }), request('listProjects', 1)],
  },
  {
    note: 'relocate a project whose folder is gone: the picker, a folder of another project, a closed picker',
    views: withViews(1),
    files: world({
      ...projectFolder('work/moved', 'p2', 'Moved'),
      ...projectFolder('work/other', 'p8', 'Other'),
    }),
    hosts: hostsOf({}, {}, person(['$DIR/work/other', '$DIR/work/moved', null], [])),
    calls: [
      request('relocateProject', 1, { projectId: 'p2' }),
      request('relocateProject', 1, { projectId: 'p2' }),
      request('relocateProject', 1, { projectId: 'p2' }),
      request('relocateProject', 1, { projectId: 'nope' }),
      request('relocateProject', 1, {}),
      request('listProjects', 1),
    ],
  },
  {
    note: 'adopt the folder a document hints at: a document with no hint, a hinted folder that asks, one that does not',
    views: withViews(3),
    files: world({
      ...written('elsewhere/gamma', 'g1', 'Gamma', { 'elsewhere/gamma/doc.md': doc(4, 'doc\n') }),
      ...projectFolder('elsewhere/plain', 'p5', 'Plain', {
        'elsewhere/plain/doc.md': doc(5, 'doc\n'),
      }),
      'loose/doc.md': doc(6, 'loose\n'),
    }),
    hosts: hostsOf({}, {}, person([], [USE])),
    calls: [
      request('adoptFolderHint', 1),
      { channel: 'app:open-dropped-files', kind: 'send', args: [['$DIR/loose/doc.md']] },
      request('adoptFolderHint', 100),
      { channel: 'app:open-dropped-files', kind: 'send', args: [['$DIR/elsewhere/gamma/doc.md']] },
      request('adoptFolderHint', 101),
      { channel: 'app:open-dropped-files', kind: 'send', args: [['$DIR/elsewhere/plain/doc.md']] },
      request('adoptFolderHint', 102),
      request('listProjects', 1),
      request('getSelection', 101),
    ],
  },
  {
    note: 'decide trust from the project screen: without applies at once, use asks again, a closed prompt changes nothing',
    views: withViews(1),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [WITHOUT, CANCEL, USE])),
    calls: [
      request('addFolder', 1),
      request('decideTrust', 1, { projectId: 'g1', decision: 'without' }),
      request('decideTrust', 1, { projectId: 'g1', decision: 'use' }),
      request('getProjectDetail', 1, { projectId: 'g1' }),
      request('decideTrust', 1, { projectId: 'g1', decision: 'use' }),
      request('getProjectDetail', 1, { projectId: 'g1' }),
      request('decideTrust', 1, { projectId: 'g1', decision: 'maybe' }),
      request('decideTrust', 1, { projectId: 'nope', decision: 'use' }),
      request('decideTrust', 1, { projectId: 'p1', decision: 'use' }),
    ],
  },
  {
    note: 'a prompt over an editor window sits over the shell window too; the answer reaches its own request',
    views: withViews(2),
    files: world(written('work/gamma', 'g1', 'Gamma')),
    hosts: hostsOf({}, {}, person(['$DIR/work/gamma'], [USE])),
    calls: [
      { channel: 'home:new-doc', args: [] },
      request('addFolder', 100),
      request('listProjects', 100),
    ],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadProjects(25),
  triggers,
  cases,
  single: {
    'projectFolder:addFolder': 'takes no arguments; the picker and the prompt decide the answer',
    'projectFolder:adoptFolderHint': 'takes no arguments; the window decides the answer',
  },
}
