/**
 * Group `w/projects-chats`: the chats of a project folder and the events the
 * bridge sends (`projectFolder:event:*`): which window shows which chat, a
 * message one window records reaching the others, "open this chat" and "show
 * the project screen" held for a window that does not listen yet, and what a
 * reload or a close of a window forgets. `project-ipc.ts`,
 * `chat-store.ts` and `new-documents.ts` over the world of projects-lib/load.ts.
 *
 * The chat ids are `AQEBAQEBAQEBAQEB` (12 bytes of 0x01, base64url), then
 * `AgICAgICAgICAgIC`: each draw of 12 bytes counts up.
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
  trigger,
  triggers,
  withViews,
} from './projects-lib/load.ts'

const MTIME = 1_700_000_000_000
const doc = (n: number, text: string) => ({ text, mtimeMs: MTIME + n * 1000 })

const C1 = 'AQEBAQEBAQEBAQEB'
const C2 = 'AgICAgICAgICAgIC'
const ref = (chatId: string, projectId = 'p1') => ({ projectId, chatId })

const world = (extra: NonNullable<Case['files']> = {}): Case['files'] => ({
  ...projectsSettings([
    { id: 'p1', path: '$DIR/work/alpha' },
    { id: 'p2', path: '$DIR/work/beta' },
  ]),
  ...projectFolder('work/alpha', 'p1', 'Alpha', {
    'work/alpha/notes.md': doc(1, '# notes\n'),
    'work/alpha/sub/deep.md': doc(2, 'deep\n'),
  }),
  ...projectFolder('work/beta', 'p2', 'Beta'),
  'elsewhere/loose.md': doc(3, 'loose\n'),
  ...extra,
})

const listen = (method: string, view?: number, on: unknown = true): Call => ({
  channel: 'projectFolder:listen',
  kind: 'send',
  ...(view === undefined ? {} : { view }),
  args: [{ method, listening: on }],
})
const user = (chatId: string, text: string, projectId = 'p1') => ({
  projectId,
  chatId,
  role: 'user',
  text,
})
const reply = (chatId: string, text: string, projectId = 'p1') => ({
  projectId,
  chatId,
  role: 'assistant',
  text,
  tools: [{ name: 'project_read', summary: 'read notes.md' }],
})

const cases: Case[] = [
  {
    note: 'a chat from its start: the first message waits, the reply saves both; list, open, rename, delete',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      listen('onProjectChanged'),
      request('newChat', 1, { projectId: 'p1' }),
      request('appendChat', 1, user(C1, 'hello')),
      request('appendChat', 1, reply(C1, 'hi there')),
      request('listChats', 1, { projectId: 'p1' }),
      request('openChat', 1, ref(C1)),
      request('openChat', 1, { ...ref(C1), limit: 1 }),
      request('renameChat', 1, { ...ref(C1), title: '  Greeting  ' }),
      request('listChats', 1, { projectId: 'p1' }),
      request('deleteChat', 1, ref(C1)),
      request('listChats', 1, { projectId: 'p1' }),
      request('openChat', 1, ref(C1)),
    ],
  },
  {
    note: 'bad requests: ids that are no ids, an unknown project, a bad role, a bad title',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('newChat', 1, { projectId: 'nope' }),
      request('newChat', 1, { projectId: 'bad id!' }),
      request('newChat', 1),
      request('listChats', 1, { projectId: 'p1' }),
      request('listChats', 1, {}),
      request('openChat', 1, { projectId: 'p1', chatId: 'x/y' }),
      request('openChat', 1, ref('missing')),
      request('appendChat', 1, { ...user(C1, 'x'), role: 'system' }),
      request('appendChat', 1, { ...user(C1, 'x'), text: 5 }),
      request('appendChat', 1, user('x y', 'x')),
      request('renameChat', 1, { ...ref(C1), title: 5 }),
      request('renameChat', 1, { ...ref(C1), title: '   ' }),
      request('deleteChat', 1, { projectId: 'p1' }),
      request('deleteChat', 1, ref('missing')),
    ],
  },
  {
    note: 'two windows on one chat: a message one records reaches the other; a window with no project stops hearing it',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      invoke('home:new-doc'),
      request('newChat', 1, { projectId: 'p1' }),
      request('appendChat', 1, user(C1, 'first')),
      request('appendChat', 1, reply(C1, 'second')),
      request('openChat', 100, ref(C1)),
      request('appendChat', 1, user(C1, 'third')),
      request('appendChat', 100, reply(C1, 'fourth')),
      request('setSelection', 100, { projectId: null }),
      request('appendChat', 1, user(C1, 'fifth')),
      request('appendChat', 100, user(C1, 'sixth')),
    ],
  },
  {
    note: 'a chat of a saved document records the document; opening it from the project screen opens the document',
    views: withViews(2),
    files: world(),
    hosts: hostsOf(),
    calls: [
      send('app:open-dropped-files', ['$DIR/work/alpha/notes.md']),
      request('newChat', 100, { projectId: 'p1' }),
      request('appendChat', 100, user(C1, 'about this document')),
      request('appendChat', 100, reply(C1, 'ok')),
      request('listChats', 1, { projectId: 'p1' }),
      listen('onOpenChat', 100),
      request('openDocumentChat', 1, ref(C1)),
      request('openDocumentChat', 1, ref('missing')),
      request('openDocumentChat', 1, {}),
    ],
  },
  {
    note: 'the chat of a document that is closed: the document opens, the event waits until its panel listens',
    views: withViews(2),
    files: world(),
    hosts: hostsOf(),
    calls: [
      send('app:open-dropped-files', ['$DIR/work/alpha/sub/deep.md']),
      request('newChat', 100, { projectId: 'p1' }),
      request('appendChat', 100, user(C1, 'about deep')),
      request('appendChat', 100, reply(C1, 'noted')),
      invoke('tabs:close', 't1'),
      request('openDocumentChat', 1, ref(C1)),
      listen('onOpenChat', 100),
      listen('onOpenChat', 100, false),
    ],
  },
  {
    note: 'a chat last used at home opens at home; the project screen request is held until home listens',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('newChat', 1, { projectId: 'p1' }),
      request('appendChat', 1, user(C1, 'at home')),
      request('appendChat', 1, reply(C1, 'yes')),
      request('openDocumentChat', 1, ref(C1)),
      request('openProjectScreen', 1, { projectId: 'p1', section: 'memory' }),
      request('openProjectScreen', 1, { projectId: 'p2', section: 'instructions' }),
      listen('onOpenChat', 1),
      listen('onOpenProjectScreen', 1),
      request('openProjectScreen', 1, { projectId: 'p1', section: 'other' }),
      request('openProjectScreen', 1, { section: 'memory' }),
    ],
  },
  {
    note: 'listening: a bad method or flag is ignored, stopping stops, a reload forgets what a window listened to',
    views: withViews(0),
    files: world(),
    hosts: hostsOf(),
    calls: [
      listen('onProjectChanged'),
      listen('onNothing'),
      { channel: 'projectFolder:listen', kind: 'send', args: [{ method: 5, listening: true }] },
      { channel: 'projectFolder:listen', kind: 'send', args: ['onProjectChanged'] },
      { channel: 'projectFolder:listen', kind: 'send', args: [] },
      request('setPinned', 1, { projectId: 'p1', pinned: true }),
      listen('onProjectChanged', 1, 'yes'),
      request('setPinned', 1, { projectId: 'p1', pinned: false }),
      listen('onProjectChanged'),
      trigger('navigate-same'),
      request('setPinned', 1, { projectId: 'p1', pinned: true }),
      trigger('navigate'),
      request('setPinned', 1, { projectId: 'p1', pinned: false }),
      listen('onProjectChanged'),
      request('setPinned', 1, { projectId: 'p1', pinned: true }),
      trigger('destroyed'),
      listen('onProjectChanged'),
      request('setPinned', 1, { projectId: 'p1', pinned: false }),
    ],
  },
  {
    note: 'a window that closed with an event held for it hears nothing when its id comes again',
    views: withViews(0),
    files: world(),
    hosts: hostsOf(),
    calls: [
      request('openProjectScreen', 1, { projectId: 'p1' }),
      trigger('destroyed'),
      listen('onOpenProjectScreen'),
    ],
  },
  {
    note: 'attach an untitled document to a chat once it is saved: nothing without a saved document',
    views: withViews(3),
    files: world(),
    hosts: hostsOf(),
    calls: [
      invoke('home:new-doc'),
      send('app:open-dropped-files', ['$DIR/work/alpha/notes.md']),
      request('newChat', 100, { projectId: 'p1' }),
      request('appendChat', 100, user(C1, 'an untitled one')),
      request('appendChat', 100, reply(C1, 'ok')),
      request('attachDocument', 100, ref(C1)),
      request('attachDocument', 101, ref(C1)),
      request('openChat', 101, ref(C1)),
      request('attachDocument', 1, ref(C1)),
      request('attachDocument', 101, { projectId: 'p1' }),
      request('attachDocument', 102, ref(C1)),
    ],
  },
  {
    note: 'the earlier chat of a document in the app-data store is listed beside the project chats',
    views: withViews(2),
    files: world(),
    hosts: hostsOf({
      store: {
        legacy: {
          '$DIR/work/alpha/notes.md': {
            projectId: 'default',
            chatId: 'ignored',
            updatedAt: '2025-12-01T00:00:00.000Z',
            approxCount: 4,
          },
        },
      },
    }),
    calls: [
      send('app:open-dropped-files', ['$DIR/work/alpha/notes.md']),
      request('listChats', 100, { projectId: 'p1' }),
      request('listChats', 1, { projectId: 'p1' }),
      request('listChats', 101, { projectId: 'p1' }),
    ],
  },
  {
    note: 'a message recorded outside the project list: a document outside every project keeps its chat',
    views: withViews(1),
    files: world(),
    hosts: hostsOf(),
    calls: [
      send('app:open-dropped-files', ['$DIR/elsewhere/loose.md']),
      request('setSelection', 100, { projectId: 'p1' }),
      request('newChat', 100, { projectId: 'p1' }),
      request('appendChat', 100, user(C1, 'loose chat')),
      request('appendChat', 100, reply(C1, 'fine')),
      request('getSelection', 100),
      request('newChat', 100, { projectId: 'p1' }),
      request('getSelection', 100),
    ],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadProjects(),
  triggers,
  cases,
  single: {
    'projectFolder:listen': 'a send; the events it lets through show what it did',
  },
}

void C2
