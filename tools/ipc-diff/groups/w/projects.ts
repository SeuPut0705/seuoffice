/**
 * Group `w/projects`: the project folder bridge's requests that answer from
 * the guide and the tools (`registerProjectFolderChannels` in
 * `apps/shell/src/main/index.ts` over `project-ipc.ts`, `project-guide.ts`,
 * `project-tools.ts`): the list, the selection of a window, memory,
 * instructions, ignore, settings, the run scopes and the AI's file tools.
 * The world is projects-lib/load.ts; the Rust handlers run the same cases on
 * `crates/shell-ipc/w/src/projects`.
 *
 * Every random id is `n` bytes of the draw's number, so the first run scope is
 * 24 bytes of 0x01 (`SCOPE`).
 */
import type { Call, Case, Group } from '../../types.ts'
import {
  hostsOf,
  invoke,
  loadProjects,
  projectFolder,
  projectsSettings,
  request,
  send,
  triggers,
  withViews,
} from './projects-lib/load.ts'

const MTIME = 1_700_000_000_000
const doc = (n: number, text: string) => ({ text, mtimeMs: MTIME + n * 1000 })

/** the first scope `openScope` mints */
const SCOPE = '01'.repeat(24)

const alphaFiles = {
  'work/alpha/notes.md': doc(1, '# notes\nhello world\n'),
  'work/alpha/plan.txt': doc(2, 'plan: ship it\n'),
  'work/alpha/sub/deep.md': doc(3, 'deep note\n'),
  'work/alpha/.seuoffice/instructions.md': 'Answer briefly.\n',
  'work/alpha/.seuoffice/memory.md': '<!-- memory -->\n- likes tea\n- lives in Busan\n',
  'work/alpha/AGENTS.md': doc(4, 'agents file\n'),
}

/** two listed projects, the first with files */
const world = (
  extra: NonNullable<Case['files']> = {},
  projects: Record<string, unknown> = {},
): Case['files'] => ({
  ...projectsSettings(
    [
      { id: 'p1', path: '$DIR/work/alpha' },
      { id: 'p2', path: '$DIR/work/beta', pinned: true },
    ],
    projects,
  ),
  ...projectFolder('work/alpha', 'p1', 'Alpha', alphaFiles),
  ...projectFolder('work/beta', 'p2', 'Beta'),
  ...extra,
})

const listen = (method: string, view?: number): Call => ({
  channel: 'projectFolder:listen',
  kind: 'send',
  ...(view === undefined ? {} : { view }),
  args: [{ method, listening: true }],
})
const onChanged = listen('onProjectChanged')

/** the search index of the tools: two files of the alpha project, one elsewhere */
const index = {
  results: {
    tea: [
      {
        path: '$DIR/work/alpha/notes.md',
        name: 'notes.md',
        ext: 'md',
        mtimeMs: MTIME + 1000,
        snippet: [{ text: 'hello ' }, { text: 'tea' }],
      },
      {
        path: '$DIR/work/alpha/plan.txt',
        name: 'plan.txt',
        ext: 'txt',
        mtimeMs: MTIME + 2000,
        snippet: [{ text: 'ship' }],
      },
      {
        path: '$DIR/work/beta/other.md',
        name: 'other.md',
        ext: 'md',
        mtimeMs: MTIME + 3000,
        snippet: [{ text: 'elsewhere' }],
      },
    ],
  },
  indexedAsOnDisk: ['$DIR/work/alpha/notes.md'],
}

const cases: Case[] = [
  // ---- the list ----
  {
    note: 'the list: a pinned project whose folder is gone, one that is there',
    views: withViews(1),
    files: {
      ...projectsSettings([
        { id: 'p1', path: '$DIR/work/alpha' },
        { id: 'p2', path: '$DIR/work/gone', pinned: true },
      ]),
      ...projectFolder('work/alpha', 'p1', 'Alpha'),
      'save/keep.txt': '',
    },
    hosts: hostsOf(),
    calls: [request('listProjects', 1), request('getDefaultParentFolder', 1)],
  },
  {
    note: 'remove a project from the list: every listening window hears it, the list follows',
    views: withViews(2),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      { ...onChanged, view: 100 },
      request('removeFromList', 1, { projectId: 'p2' }),
      request('listProjects', 1),
      request('removeFromList', 1, { projectId: 'nope' }),
      request('removeFromList', 1, {}),
      request('removeFromList', 1),
    ],
  },
  {
    note: 'pin and unpin; a bad flag and an unknown project',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('setPinned', 1, { projectId: 'p1', pinned: true }),
      request('setPinned', 1, { projectId: 'p2', pinned: false }),
      request('listProjects', 1),
      request('setPinned', 1, { projectId: 'p1', pinned: 'yes' }),
      request('setPinned', 1, { projectId: 'nope', pinned: true }),
    ],
  },
  {
    note: 'rename: the new name, a blank one, a path-like one, a name that is no text',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('renameProject', 1, { projectId: 'p1', name: '  Alpha two  ' }),
      request('renameProject', 1, { projectId: 'p1', name: '   ' }),
      request('renameProject', 1, { projectId: 'p1', name: 'a/b' }),
      request('renameProject', 1, { projectId: 'p1', name: 5 }),
      request('renameProject', 1, { projectId: 'nope', name: 'x' }),
      request('listProjects', 1),
    ],
  },
  {
    note: 'open the folder in the file manager: a listed project, an unknown one',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('openInFileManager', 1, { projectId: 'p1' }),
      request('openInFileManager', 1, { projectId: 'nope' }),
      request('openInFileManager', 1, {}),
    ],
  },
  {
    note: 'retry a write: nothing was unwritable; an unknown project throws',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('retryUnwritable', 1, { projectId: 'p1' }),
      request('retryUnwritable', 1, { projectId: 'nope' }),
    ],
  },

  // ---- the selection of a window ----
  {
    note: 'home: the selection starts empty, the person picks a project, then none',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('getSelection', 1),
      request('setSelection', 1, { projectId: 'p1' }),
      request('getSelection', 1),
      request('setSelection', 1, { projectId: null }),
      request('getSelection', 1),
      request('setSelection', 1, { projectId: 'nope' }),
      request('setSelection', 1, { projectId: 'bad id!' }),
      request('setSelection', 1, {}),
    ],
  },
  {
    note: 'a saved document inside the project, an untitled one, a window that is no AI window',
    views: withViews(3),
    files: world(),
    hosts: hostsOf(),
    calls: [
      send('app:open-dropped-files', ['$DIR/work/alpha/notes.md']),
      invoke('home:new-doc'),
      request('getSelection', 100),
      request('setSelection', 100, { projectId: 'p2' }),
      request('getSelection', 100),
      request('getSelection', 101),
      request('setSelection', 101, { projectId: 'p1' }),
      request('getSelection', 101),
      request('getSelection', 102),
    ],
  },
  {
    note: 'a saved document outside every project: the unregistered folder is hinted',
    views: withViews(1),
    files: {
      ...world(),
      ...projectFolder('elsewhere/gamma', 'p9', 'Gamma', {
        'elsewhere/gamma/doc.md': doc(4, 'a doc\n'),
      }),
    },
    hosts: hostsOf(),
    calls: [
      send('app:open-dropped-files', ['$DIR/elsewhere/gamma/doc.md']),
      request('getSelection', 100),
      request('setSelection', 100, { projectId: 'p1' }),
      request('getSelection', 100),
    ],
  },

  // ---- context, memory, instructions ----
  {
    note: 'read the context of a project: instructions, memory, the file names',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('readContext', 1, { projectId: 'p1' }),
      request('readContext', 1, { projectId: 'p2' }),
      request('readContext', 1, { projectId: 'nope' }),
      request('readContext', 1, {}),
    ],
  },
  {
    note: 'edit the memory: add, replace, remove; a refusal and bad requests',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('editMemory', 1, { projectId: 'p1', change: { op: 'add', text: 'drinks coffee' } }),
      request('editMemory', 1, {
        projectId: 'p1',
        change: { op: 'replace', old: 'likes tea', new: 'likes green tea' },
      }),
      request('editMemory', 1, {
        projectId: 'p1',
        change: { op: 'remove', text: 'lives in Busan' },
      }),
      request('editMemory', 1, { projectId: 'p1', change: { op: 'remove', text: 'never there' } }),
      request('editMemory', 1, { projectId: 'p1', change: { op: 'bad' } }),
      request('editMemory', 1, { projectId: 'nope', change: { op: 'add', text: 'x' } }),
      request('getProjectDetail', 1, { projectId: 'p1' }),
    ],
  },
  {
    note: 'save the memory whole, then consolidate it and undo',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('saveMemory', 1, { projectId: 'p1', text: '- one\n- two\n' }),
      request('applyMemoryConsolidation', 1, { projectId: 'p1', entries: ['merged', 'kept'] }),
      request('undoMemoryConsolidation', 1, {
        projectId: 'p1',
        backupName: 'memory.20231114-221320.bak.md',
      }),
      request('undoMemoryConsolidation', 1, { projectId: 'p1', backupName: 'x' }),
      request('applyMemoryConsolidation', 1, { projectId: 'p1', entries: [1] }),
      request('applyMemoryConsolidation', 1, { projectId: 'p1' }),
      request('saveMemory', 1, { projectId: 'p1', text: 5 }),
      request('getProjectDetail', 1, { projectId: 'p1' }),
    ],
  },
  {
    note: 'instructions and ignore lines: save, add, remove, list what the AI may not see',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('saveInstructions', 1, { projectId: 'p1', text: 'Be brief.\n' }),
      request('addIgnore', 1, { projectId: 'p1', relPath: 'plan.txt' }),
      request('listIgnoredFiles', 1, { projectId: 'p1' }),
      request('removeIgnore', 1, { projectId: 'p1', relPath: 'plan.txt' }),
      request('listIgnoredFiles', 1, { projectId: 'p1' }),
      request('addIgnore', 1, { projectId: 'p1', relPath: 5 }),
      request('removeIgnore', 1, { projectId: 'p1', relPath: 5 }),
      request('listIgnoredFiles', 1, { projectId: 'nope' }),
      request('saveInstructions', 1, { projectId: 'p1' }),
      request('getProjectDetail', 1, { projectId: 'p1' }),
    ],
  },
  {
    note: 'the project settings: read, change one switch, change both, a non-boolean is left alone',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('getSettings', 1, { projectId: 'p1' }),
      request('setSettings', 1, { projectId: 'p1', settings: { memoryEnabled: false } }),
      request('setSettings', 1, {
        projectId: 'p1',
        settings: { memoryEnabled: true, readAgentsFiles: false },
      }),
      request('setSettings', 1, { projectId: 'p1', settings: { readAgentsFiles: 'no' } }),
      request('getSettings', 1, { projectId: 'p1' }),
      request('getSettings', 1, {}),
    ],
  },

  // ---- the AI's tools ----
  {
    note: 'a run scope: open it, list the files, close it; a closed scope and another window are refused',
    views: withViews(2),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('listFiles', 1, { scope: SCOPE }),
      request('listFiles', 1, { scope: SCOPE, prefix: 'sub', limit: 1 }),
      request('listFiles', 100, { scope: SCOPE }),
      request('closeScope', 100, { scope: SCOPE }),
      request('listFiles', 1, { scope: SCOPE, limit: 1 }),
      request('closeScope', 1, { scope: SCOPE }),
      request('listFiles', 1, { scope: SCOPE }),
      request('listFiles', 1, {}),
      request('openScope', 1, { projectId: 'nope' }),
      request('openScope', 1, {}),
    ],
  },
  {
    note: 'search the project: the index ranks the files the AI may see, a quotable excerpt, other exts',
    views: withViews(1),
    files: world(),
    hosts: hostsOf({ files: index }, { fileSearch: {} }),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('search', 1, { scope: SCOPE, query: ' tea ' }),
      request('search', 1, { scope: SCOPE, query: 'tea', exts: ['.TXT', 7], limit: 1, offset: 0 }),
      request('search', 1, { scope: SCOPE, query: '   ' }),
      request('search', 1, { scope: SCOPE }),
      request('search', 1, { scope: 'other', query: 'tea' }),
    ],
  },
  {
    note: 'search: a file open with unsaved changes is not quoted',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(
      {
        files: index,
        openFiles: [{ filePath: '$DIR/work/alpha/notes.md', dirty: true }],
      },
      { fileSearch: {} },
    ),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('search', 1, { scope: SCOPE, query: 'tea' }),
    ],
  },
  {
    note: 'read a file: a page, further on, a hidden one, a path outside, a missing one',
    views: withViews(1),
    files: world({ 'work/alpha/.hidden.md': doc(5, 'hidden\n') }),
    hosts: hostsOf(),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('read', 1, { scope: SCOPE, relPath: 'notes.md' }),
      request('read', 1, { scope: SCOPE, relPath: 'notes.md', offset: 3 }),
      request('read', 1, { scope: SCOPE, relPath: 'sub/deep.md', offset: 99999 }),
      request('read', 1, { scope: SCOPE, relPath: '$DIR/work/alpha/plan.txt' }),
      request('read', 1, { scope: SCOPE, relPath: '.hidden.md' }),
      request('read', 1, { scope: SCOPE, relPath: '../beta/x.md' }),
      request('read', 1, { scope: SCOPE, relPath: 'nope.md' }),
      request('read', 1, { scope: SCOPE, relPath: 'sub' }),
      request('read', 1, { scope: SCOPE, relPath: 'image.png' }),
      request('read', 1, { scope: SCOPE }),
    ],
  },
  {
    note: 'read a file open with unsaved changes: refused',
    views: withViews(1),
    files: world(),
    hosts: hostsOf({ openFiles: [{ filePath: '$DIR/work/alpha/notes.md', dirty: true }] }),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('read', 1, { scope: SCOPE, relPath: 'notes.md' }),
      request('read', 1, { scope: SCOPE, relPath: 'plan.txt' }),
    ],
  },
  {
    note: 'read when the open documents cannot be listed: every file counts as unsaved',
    views: withViews(1),
    files: world(),
    hosts: hostsOf({ openFilesFail: true }),
    calls: [
      request('openScope', 1, { projectId: 'p1' }),
      request('read', 1, { scope: SCOPE, relPath: 'notes.md' }),
    ],
  },
  {
    note: 'remember: the AI writes a memory line through its scope; no scope, a foreign scope',
    views: withViews(2),
    files: world(),
    hosts: hostsOf(),
    calls: [
      onChanged,
      request('openScope', 1, { projectId: 'p1' }),
      request('remember', 1, { scope: SCOPE, change: { op: 'add', text: 'speaks Korean' } }),
      request('remember', 100, { scope: SCOPE, change: { op: 'add', text: 'x' } }),
      request('remember', 1, { change: { op: 'add', text: 'x' } }),
      request('remember', 1, { scope: SCOPE, change: { op: 'nope' } }),
      request('getProjectDetail', 1, { projectId: 'p1' }),
    ],
  },
  {
    note: 'the use time of a project: the first use is written, the next waits for its timer',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('setSelection', 1, { projectId: 'p1' }),
      request('setSelection', 1, { projectId: 'p1' }),
      request('listProjects', 1),
      { channel: 'w/projects:timer', kind: 'trigger', name: 'w/projects:timer', args: [] },
      request('listProjects', 1),
    ],
  },
  {
    note: 'a project folder of a case with no listed project: bad ids and the AI windows',
    views: withViews(1),
    files: { 'userData/app-settings.json': JSON.stringify({ language: 'ko' }) },
    hosts: hostsOf(),
    calls: [
      request('listProjects', 1),
      request('getProjectDetail', 1, { projectId: 'nope' }),
      request('getProjectDetail', 1, { projectId: '../x' }),
      request('getProjectDetail', 1),
    ],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadProjects(),
  triggers,
  cases,
  single: {
    'projectFolder:closeScope': 'answers nothing; a later call shows whether the scope is held',
  },
}
