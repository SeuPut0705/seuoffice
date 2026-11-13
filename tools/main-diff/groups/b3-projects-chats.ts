/**
 * Part `chats` of group `b3-projects`: apps/shell/src/main/projects/
 * chat-store.ts. The Rust side is crates/main-core/src/calls/b3_projects/
 * chats.rs.
 *
 * `chat-store.scenario` runs a list of operations over one `ProjectChatStore`
 * on one project folder (`root`, project id `projectId`), the way a window
 * would drive it, and answers `[[op, result], ..., ['final', { states,
 * scans }]]` where `result` is what the method answered, `{ error: message }`
 * where it threw, and null for the operations that only change the world.
 *
 * The scenario is `{ dir, root, projectId, installId, trust, platform,
 * unwritable, failWrites, trashFails, outsideFails, startMs, ids,
 * stateCacheLimit, foreignCacheLimit, selections, listeners, ops }`:
 * - the guide is a fake that answers from the scenario and logs each call as
 *   `['guide', name, ...args]`; `appendData` and `updateData` write the file
 *   for real (a failed write, or `failWrites`, marks the project unwritable
 *   and answers `unwritable`); `updateData` logs the file's text before the
 *   change runs, so a call the change makes (`installId`) follows it;
 * - `documentRelativePath` is `relativeInside` of the canonical root and the
 *   canonical document; `getSelection` answers the entry of `selections`
 *   (`[docPath, { projectId, initialChatId }]`) for the path, else nulls;
 * - the clock moves a second on each read, from `startMs`; `ids` are the new
 *   chat ids in order (an empty string after the last), `null` the default
 *   random ones (the answer of `newChat` is then `{ length, valid }`);
 * - `trash` logs `['host', 'trash', path]` and moves the file into
 *   `<dir>/trash/<n>-<name>`, or throws when `trashFails`;
 * - each `console.warn` is the log line `['console.warn', label, message]`;
 * - each listener of `listeners` (`'ok'`, or `'throws'`, which throws
 *   `boom`) logs `['listener', name, event, sender]`.
 * An operation is one of `newChat`, `list`, `chatInfo`, `open`, `append`
 * (`times` repeats it and answers the list), `rename`, `attach`, `delete`,
 * `chatForDocument`, `counts`, `unsubscribe` (a listener by index), and the
 * ones that change the world: `world` (`set` of the flags `unwritable`,
 * `trust`, `failWrites`, `trashFails`, `outsideFails`), `plant` (a file),
 * `remove`, `chmod`, `touch` (the file's mtime).
 *
 * Which functions need Electron: none, but folder-files.ts reaches
 * agent-sessions.ts, so the fake of electron-fake.ts is registered first.
 */
import '../electron-fake.ts'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

const chatStore = await import('../../../apps/shell/src/main/projects/chat-store.ts')
const folderFiles = await import('../../../apps/shell/src/main/projects/folder-files.ts')
const paths = await import('../../../apps/shell/src/main/projects/paths.ts')

interface Selection {
  projectId: string | null
  initialChatId: string | null
}

interface Scenario {
  dir: string
  root: string
  projectId: string
  installId: string
  trust: 'use' | 'without' | 'unconfirmed'
  platform: string
  unwritable: boolean
  failWrites: boolean
  trashFails: boolean
  outsideFails: boolean
  startMs: number
  ids: string[] | null
  stateCacheLimit: number | null
  foreignCacheLimit: number | null
  selections: [string, Selection][]
  listeners: string[]
  ops: Op[]
}

type Op = { op: string } & Record<string, unknown>

type Sender = { editor: unknown; docPath?: unknown; key?: unknown }

/** the writes the fake guide makes for real; false where one fails */
function writeFor(path: string, append: boolean, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (append) appendFileSync(path, text)
    else writeFileSync(path, text)
    return true
  } catch {
    return false
  }
}

async function runScenario(spec: Scenario, cx: TsContext): Promise<unknown> {
  const flags = {
    unwritable: spec.unwritable,
    trust: spec.trust,
    failWrites: spec.failWrites,
    trashFails: spec.trashFails,
    outsideFails: spec.outsideFails,
  }
  let clock = spec.startMs
  let trashed = 0
  let nextId = 0
  const note = (...line: unknown[]): void => cx.log(...line)

  const pathOf = (id: string, rel: string, dataDir: string | undefined): string | null =>
    id === spec.projectId
      ? join(spec.root, dataDir ?? folderFiles.dataDirName(spec.root), rel)
      : null

  const guide = {
    appendData: async (id: string, rel: string, text: string, dataDir?: string) => {
      note('guide', 'appendData', id, rel, text, dataDir ?? null)
      const path = pathOf(id, rel, dataDir)
      if (path === null || flags.failWrites || !writeFor(path, true, text)) {
        flags.unwritable = true
        return { status: 'unwritable' as const }
      }
      return { status: 'ok' as const }
    },
    updateData: async (
      id: string,
      rel: string,
      change: (current: string | null) => string | null | undefined,
      dataDir?: string,
    ) => {
      const path = pathOf(id, rel, dataDir)
      let current: string | null = null
      if (path !== null) {
        try {
          current = readFileSync(path, 'utf8')
        } catch {
          current = null
        }
      }
      note('guide', 'updateData', id, rel, dataDir ?? null, current)
      if (path === null) {
        flags.unwritable = true
        return { status: 'unwritable' as const }
      }
      const next = change(current)
      if (typeof next === 'string' && (flags.failWrites || !writeFor(path, false, next))) {
        flags.unwritable = true
        return { status: 'unwritable' as const }
      }
      return { status: 'ok' as const, written: typeof next === 'string', text: next ?? null }
    },
    dataPath: (id: string, rel: string, dataDir?: string) => {
      // a random id (no ids given) is written as `<random>`, the same on both sides
      const shown = spec.ids === null ? rel.replace(/^chats\/[^.]+/, 'chats/<random>') : rel
      note('guide', 'dataPath', id, shown, dataDir ?? null)
      return pathOf(id, rel, dataDir)
    },
    installId: () => {
      note('guide', 'installId')
      return spec.installId
    },
    trustState: (id: string) => {
      note('guide', 'trustState', id)
      return flags.trust
    },
    isUnwritable: (id: string) => {
      note('guide', 'isUnwritable', id)
      return flags.unwritable
    },
    markUnwritable: (id: string) => {
      note('guide', 'markUnwritable', id)
      flags.unwritable = true
    },
    projectRoot: (id: string) => {
      note('guide', 'projectRoot', id)
      return id === spec.projectId ? spec.root : null
    },
    recordOutsideChat: async (doc: string, projectId: string, chatId: string) => {
      note('guide', 'recordOutsideChat', doc, projectId, chatId)
      if (flags.outsideFails) throw new Error('outside failed')
    },
    documentRelativePath: (id: string, doc: string) => {
      note('guide', 'documentRelativePath', id, doc)
      return id === spec.projectId
        ? paths.relativeInside(paths.canonicalPath(spec.root), paths.canonicalPath(doc), platform)
        : null
    },
    getSelection: async (target: { kind: string; path: string }) => {
      note('guide', 'getSelection', target)
      const hit = spec.selections.find(([path]) => path === target.path)
      return hit ? hit[1] : { projectId: null, initialChatId: null }
    },
  }

  const trash = async (path: string): Promise<void> => {
    note('host', 'trash', path)
    if (flags.trashFails) throw new Error('trash failed')
    const to = join(spec.dir, 'trash')
    mkdirSync(to, { recursive: true })
    renameSync(path, join(to, `${++trashed}-${basename(path)}`))
  }

  const ids = spec.ids
  const platform = (spec.platform === 'host' ? process.platform : spec.platform) as NodeJS.Platform
  const store = new chatStore.ProjectChatStore({
    guide: guide as never,
    trash,
    now: () => new Date((clock += 1000)),
    ...(ids !== null ? { newId: () => ids[nextId++] ?? '' } : {}),
    ...(spec.platform !== 'host' ? { platform } : {}),
    ...(spec.stateCacheLimit !== null ? { stateCacheLimit: spec.stateCacheLimit } : {}),
    ...(spec.foreignCacheLimit !== null ? { foreignCacheLimit: spec.foreignCacheLimit } : {}),
  })

  const unsubscribe: Array<() => void> = []
  for (const name of spec.listeners) {
    unsubscribe.push(
      store.onAppended((event, sender) => {
        note('listener', name, event, sender)
        if (name === 'throws') throw new Error('boom')
      }),
    )
  }

  const senderOf = (value: unknown): never => {
    const s = (value ?? {}) as Sender
    return {
      editor: s.editor,
      docPath: s.docPath === undefined ? null : s.docPath,
      ...('key' in s ? { key: s.key } : {}),
    } as never
  }

  const run = async (op: Op): Promise<unknown> => {
    switch (op.op) {
      case 'newChat': {
        const made = await store.newChat(op.projectId as string)
        return ids === null
          ? { length: made.chatId.length, valid: /^[A-Za-z0-9_-]{16}$/.test(made.chatId) }
          : made
      }
      case 'list':
        return store.listChats(op.projectId as string)
      case 'chatInfo':
        return store.chatInfo(op.ref as never)
      case 'open':
        return store.openChat(op.args as never)
      case 'append': {
        if (typeof op.times !== 'number') return store.append(op.args as never, senderOf(op.sender))
        const out: unknown[] = []
        for (let i = 0; i < op.times; i++) {
          out.push(await store.append(op.args as never, senderOf(op.sender)))
        }
        return out
      }
      case 'rename':
        return store.renameChat(op.args as never)
      case 'attach':
        return store.attachDocument(op.ref as never, op.docPath as string)
      case 'delete':
        return store.deleteChat(op.ref as never)
      case 'chatForDocument':
        return store.chatForDocument(op.projectId as string, op.docPath as string)
      case 'counts':
        return { states: store.heldStateCount(), scans: store.heldForeignScanCount() }
      case 'unsubscribe':
        unsubscribe[op.index as number]!()
        return null
      case 'world':
        Object.assign(flags, op.set as object)
        return null
      case 'plant':
        mkdirSync(dirname(op.path as string), { recursive: true })
        writeFileSync(op.path as string, op.text as string)
        return null
      case 'remove':
        rmSync(op.path as string, { recursive: true, force: true })
        return null
      case 'chmod':
        chmodSync(op.path as string, op.mode as number)
        return null
      case 'touch': {
        const seconds = (op.mtimeMs as number) / 1000
        utimesSync(op.path as string, seconds, seconds)
        return null
      }
      default:
        throw new Error(`unknown operation ${op.op}`)
    }
  }

  const real = console.warn
  console.warn = (...line: unknown[]) =>
    cx.log('console.warn', ...line.map((part) => (part instanceof Error ? part.message : part)))
  try {
    const results: unknown[] = []
    for (const op of spec.ops) {
      let value: unknown
      try {
        value = await run(op)
      } catch (error) {
        value = { error: (error as Error).message }
      }
      results.push([op.op, value ?? null])
    }
    results.push(['final', { states: store.heldStateCount(), scans: store.heldForeignScanCount() }])
    return results
  } finally {
    console.warn = real
  }
}

// ---------------------------------------------------------------------------
// building cases
// ---------------------------------------------------------------------------

const P = 'p1'
const NOW0 = '2026-01-01T00:00:00.000Z'
const CHATS = 'proj/.seuoffice/chats'
const CHATS_ABS = '$DIR/proj/.seuoffice/chats'

const BASE: Omit<Scenario, 'ops'> = {
  dir: '$DIR',
  root: '$DIR/proj',
  projectId: P,
  installId: 'install-A',
  trust: 'use',
  platform: 'linux',
  unwritable: false,
  failWrites: false,
  trashFails: false,
  outsideFails: false,
  startMs: Date.UTC(2026, 9, 29, 12, 0, 0),
  ids: ['chat1', 'chat2', 'chat3', 'chat4', 'chat5'],
  stateCacheLimit: null,
  foreignCacheLimit: null,
  selections: [],
  listeners: [],
}

const scenario = (
  world: Partial<Omit<Scenario, 'ops'>>,
  ops: Op[],
  files: Case['files'] = {},
  note?: string,
): Case => ({
  args: [{ ...BASE, ...world, ops }],
  files: { proj: { dir: true }, ...files },
  ...(note !== undefined ? { note } : {}),
})

const ref = (chat: string, projectId: string = P) => ({ projectId, chatId: chat })
const HOME = { editor: 'home', docPath: null }
const inDocs = (rel: string, editor = 'docs') => ({ editor, docPath: `$DIR/proj/${rel}` })

const append = (
  chat: string,
  role: unknown,
  text: unknown,
  extra: Record<string, unknown> = {},
  sender: Sender = HOME,
  more: Record<string, unknown> = {},
): Op => ({
  op: 'append',
  args: { projectId: P, chatId: chat, role, text, ...extra },
  sender,
  ...more,
})
const user = (chat: string, text: unknown, extra?: Record<string, unknown>, sender?: Sender): Op =>
  append(chat, 'user', text, extra, sender)
const reply = (chat: string, text: unknown, extra?: Record<string, unknown>, sender?: Sender): Op =>
  append(chat, 'assistant', text, extra, sender)
const list = (): Op => ({ op: 'list', projectId: P })
const open = (chat: string, extra: Record<string, unknown> = {}): Op => ({
  op: 'open',
  args: { projectId: P, chatId: chat, ...extra },
})
const rename = (chat: string, title: unknown): Op => ({
  op: 'rename',
  args: { projectId: P, chatId: chat, title },
})
const attach = (chat: string, docPath: string): Op => ({
  op: 'attach',
  ref: ref(chat),
  docPath,
})
const del = (chat: string): Op => ({ op: 'delete', ref: ref(chat) })
const info = (chat: string): Op => ({ op: 'chatInfo', ref: ref(chat) })
const forDoc = (docPath: string): Op => ({ op: 'chatForDocument', projectId: P, docPath })
const newChat = (): Op => ({ op: 'newChat', projectId: P })
const counts = (): Op => ({ op: 'counts' })
const world = (set: Record<string, unknown>): Op => ({ op: 'world', set })
const plant = (path: string, text: string): Op => ({ op: 'plant', path, text })

const chatInfo = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    id,
    projectId: P,
    title: id,
    createdAt: NOW0,
    updatedAt: NOW0,
    origin: 'install-A',
    lastEditor: 'docs',
    documents: [],
    ...extra,
  })

const chatLine = (seq: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    seq,
    ts: NOW0,
    role: typeof seq === 'number' && seq % 2 === 0 ? 'user' : 'assistant',
    text: `m${String(seq)}`,
    editor: 'docs',
    origin: 'install-A',
    ...extra,
  })

/** a chat's two files; the messages end with `tail` */
const planted = (
  id: string,
  infoExtra: Record<string, unknown>,
  lines: string[],
  tail = '\n',
  mtimeMs?: number,
): Case['files'] => ({
  [`${CHATS}/${id}.json`]: chatInfo(id, infoExtra),
  [`${CHATS}/${id}.jsonl`]:
    mtimeMs === undefined ? lines.join('\n') + tail : { text: lines.join('\n') + tail, mtimeMs },
})

const lines = (count: number, extra: Record<string, unknown> = {}): string[] =>
  Array.from({ length: count }, (_, seq) => chatLine(seq, extra))

/** a constant: its second case puts a file in the folder, so the two answers differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    single: 'a constant',
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const BIG_LINE = 178_481
/** a message line of exactly `length` bytes (with its newline) */
function exactLine(seq: number, length: number): string {
  const bare = chatLine(seq, { text: '' })
  return chatLine(seq, { text: 'a'.repeat(length - 1 - Buffer.byteLength(bare)) })
}

const manyTools = [
  ...Array.from({ length: 10 }, (_, i) => `not a tool ${i}`),
  ...Array.from({ length: 70 }, (_, i) => ({ name: `t${i}`, summary: `s${i}` })),
]

const cases: Case[] = [
  // ---- the life of a chat ----
  scenario(
    {},
    [
      newChat(),
      user('chat1', '  Hello   world\n'),
      list(),
      open('chat1'),
      info('chat1'),
      counts(),
      reply('chat1', 'Hi there'),
      user('chat1', 'next question'),
      list(),
      open('chat1'),
      info('chat1'),
      counts(),
    ],
    {},
    'a user message waits in memory, the first reply writes both files',
  ),
  scenario(
    { listeners: ['ok', 'throws'] },
    [
      user('chat1', 'one'),
      user('chat1', 'two'),
      reply('chat1', 'three'),
      { op: 'unsubscribe', index: 1 },
      reply('chat1', 'four'),
    ],
    {},
    'two listeners, one throws; the pending messages go out in order with the reply',
  ),
  scenario(
    {},
    [
      user('chat1', '😀'.repeat(45)),
      reply('chat1', 'a'),
      user('chat2', ' \t\n\u00a0\u3000\ufeffone\u2028two   three'),
      reply('chat2', 'a'),
      user('chat3', `${'a'.repeat(39)}   tail of the title`),
      reply('chat3', 'a'),
      user('chat4', '한'.repeat(60)),
      reply('chat4', 'a'),
      user('chat5', '   \n  '),
      reply('chat5', 'a'),
      list(),
    ],
    {},
    'automatic titles: 40 code points, collapsed white space, trimmed after the cut',
  ),
  scenario(
    {},
    [
      user('chat1', 'Question'),
      reply('chat1', 'Answer'),
      rename('chat1', 'My title'),
      user('chat1', 'again'),
      reply('chat1', 'once more'),
      rename('chat1', `${'long\n'.repeat(60)}`),
      rename('chat1', '   '),
      rename('chat1', 5),
      { op: 'rename', args: { projectId: P, chatId: 'chat1' } },
      { op: 'rename', args: { projectId: 'nope', chatId: 'chat1', title: 'x' } },
      list(),
    ],
    {},
    'a rename is kept, the automatic title never replaces it',
  ),
  scenario(
    {},
    [
      user('chat1', 'Question'),
      rename('chat1', 'Early'),
      counts(),
      reply('chat1', 'Answer'),
      list(),
      world({ unwritable: true }),
      rename('chat1', 'Blocked'),
      world({ unwritable: false }),
      user('chat1', 'after'),
      list(),
    ],
    {},
    'a rename before the first write waits; an unwritable folder keeps it for the next write',
  ),

  // ---- what is stored of a message ----
  scenario(
    {},
    [
      reply('chat1', `${'a'.repeat(32_000)}bcd`),
      reply('chat1', 'b'.repeat(32_000)),
      reply('chat1', '', { tools: [] }),
    ],
    {},
    'text past 32000 units is cut and marked; exactly 32000 stays',
  ),
  scenario(
    {},
    [
      reply('chat1', 'tools', { tools: manyTools }),
      reply('chat1', 'tool fields', {
        tools: [
          { name: 'n'.repeat(250), summary: 's'.repeat(2500), isError: true },
          { name: 'a', summary: 'b', isError: 'yes' },
          { name: 'obj', summary: '', input: { a: 1, b: [2, 'x'] }, output: 5 },
          { input: null, output: 'o'.repeat(17_000) },
          { name: 'str', summary: 'x', input: 'i'.repeat(17_000) },
          { input: true, output: [] },
          [],
          null,
          'text',
          7,
          { name: 5, summary: null, isError: false },
        ],
      }),
      reply('chat1', 'tools not a list', { tools: { name: 'x' } }),
    ],
    {},
    'tool activity: non-objects dropped before the 64 cap, fields cut, objects as JSON text',
  ),
  scenario(
    {},
    [
      reply('chat1', 'attachments', {
        attachments: [
          { name: 'a.pdf', path: '/x/a.pdf', ext: 'pdf', sizeBytes: 1200 },
          { name: 'n'.repeat(1500), path: 'p'.repeat(1500), ext: 'e'.repeat(1500) },
          { name: 'b', path: 5, ext: null, sizeBytes: '12' },
          { name: 'c', sizeBytes: -5.5 },
          { name: 'd', sizeBytes: 0 },
          { sizeBytes: 3 },
          'text',
          null,
          [],
        ],
      }),
      reply('chat1', 'many', {
        attachments: [
          'not an attachment',
          null,
          'again',
          7,
          ...Array.from({ length: 40 }, (_, i) => ({ name: `f${i}` })),
        ],
      }),
      reply('chat1', 'empty', { attachments: [] }),
      reply('chat1', 'null', { attachments: null }),
      reply('chat1', 'text', { attachments: 'x' }),
      reply('chat1', 'object', { attachments: { name: 'x' } }),
    ],
    {},
    'attachments: kept even empty, capped at 32, fields cut, a size only when it is a number',
  ),
  scenario(
    {},
    [
      user('chat1', 'scope', { scope: { label: 'L'.repeat(300), text: 't'.repeat(500) } }),
      user('chat1', 'scope label only', { scope: { label: 'label' } }),
      user('chat1', 'scope label number', { scope: { label: 5, text: 7 } }),
      user('chat1', 'scope text', { scope: 'text' }),
      user('chat1', 'scope list', { scope: [] }),
      user('chat1', 'scope null', { scope: null }),
      user('chat1', 'scope empty text', { scope: { label: 'x', text: '' } }),
    ],
    {},
    'scope: an object or a list makes one; the label and text are cut',
  ),
  scenario(
    {},
    [
      reply('chat1', 'skills', {
        skills: [
          { id: 'a', source: 's', title: 't' },
          'text',
          null,
          { id: '' },
          { id: 'x'.repeat(513) },
          { id: 'y'.repeat(512), source: 'z'.repeat(300), title: 5 },
          { id: 5 },
          { source: 's' },
          [],
        ],
      }),
      reply('chat1', 'many skills', {
        skills: Array.from({ length: 40 }, (_, i) => ({
          id: `s${i}`,
          source: 'u',
          title: `T${i}`,
        })),
      }),
      reply('chat1', 'empty skills', { skills: [] }),
      reply('chat1', 'no valid skills', { skills: ['x', {}] }),
      reply('chat1', 'null skills', { skills: null }),
      reply('chat1', 'text skills', { skills: 'x' }),
    ],
    {},
    'skill chips: malformed entries are dropped, none left means no key',
  ),
  scenario(
    {},
    [
      reply('chat1', 'all fields', {
        tools: [{ name: 't', summary: 's', isError: false, input: 'i', output: 'o' }],
        attachments: [{ name: 'a' }],
        scope: { label: 'l', text: 't' },
        skills: [{ id: 'k', source: 's', title: 't' }],
      }),
      reply('chat1', 'file ref', {}, inDocs('Report.docx')),
      reply('chat1', 'outside', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/Outside.pdf' }),
    ],
    {},
    'the key order of a stored message, with a document inside and one outside',
  ),

  // ---- refusals ----
  scenario(
    {},
    [
      newChat(),
      { op: 'newChat', projectId: 'bad id' },
      { op: 'newChat', projectId: 'p9' },
      {
        op: 'append',
        args: { projectId: 'bad id', chatId: 'chat1', role: 'user', text: 'x' },
        sender: HOME,
      },
      {
        op: 'append',
        args: { projectId: P, chatId: 'bad id', role: 'user', text: 'x' },
        sender: HOME,
      },
      {
        op: 'append',
        args: { projectId: 5, chatId: 'chat1', role: 'user', text: 'x' },
        sender: HOME,
      },
      { op: 'append', args: { chatId: 'chat1', role: 'user', text: 'x' }, sender: HOME },
      append('chat1', 'system', 'x'),
      { op: 'append', args: { projectId: P, chatId: 'chat1', text: 'x' }, sender: HOME },
      append('chat1', 'user', 5),
      { op: 'append', args: { projectId: P, chatId: 'chat1', role: 'user' }, sender: HOME },
      append('chat1', 'user', 'x', {}, { editor: 'nope', docPath: null }),
      append('chat1', 'user', 'x', {}, { editor: 5, docPath: null }),
      append('chat1', 'user', 'x', {}, { editor: 'docs', docPath: 'relative/a.docx' }),
      append('chat1', 'user', 'x', {}, { editor: 'docs', docPath: '' }),
      append('chat1', 'user', 'x', {}, { editor: 'docs', docPath: 5 }),
      {
        op: 'append',
        args: { projectId: 'p9', chatId: 'chat1', role: 'user', text: 'x' },
        sender: HOME,
      },
      list(),
      { op: 'list', projectId: 'bad id' },
      { op: 'list', projectId: 'p9' },
      { op: 'chatInfo', ref: ref('chat1', 'bad id') },
      { op: 'chatInfo', ref: ref('bad id') },
      { op: 'chatInfo', ref: ref('chat1', 'p9') },
      { op: 'open', args: { projectId: 'bad id', chatId: 'chat1' } },
      { op: 'open', args: { projectId: P, chatId: '' } },
      { op: 'open', args: { projectId: 'p9', chatId: 'chat1' } },
      { op: 'delete', ref: ref('bad id') },
      { op: 'delete', ref: ref('chat1', 'p9') },
      attach('chat1', 'relative.docx'),
      { op: 'attach', ref: ref('chat1', 'p9'), docPath: '$DIR/proj/a.docx' },
      { op: 'chatForDocument', projectId: P, docPath: 'relative.docx' },
      { op: 'chatForDocument', projectId: 'bad id', docPath: '$DIR/proj/a.docx' },
      { op: 'chatForDocument', projectId: 'p9', docPath: '$DIR/proj/a.docx' },
      { op: 'rename', args: { projectId: P, chatId: 'bad id', title: 'x' } },
    ],
    {},
    'every refusal and its message, and the unknown project answers',
  ),
  scenario(
    { ids: ['chat1', 'chat2'] },
    [newChat(), newChat(), newChat(), newChat()],
    {},
    'the ids run out: an empty one is not an id',
  ),
  scenario(
    { ids: ['chat1', 'chat1', 'chat2', 'chat3', 'chat4'] },
    [user('chat1', 'held in memory'), newChat(), newChat(), newChat()],
    planted('chat2', {}, [chatLine(0)]),
    'an id held in memory, or with a file on disk, is skipped',
  ),
  scenario(
    { ids: ['chat1', 'chat2', 'chat3'] },
    [newChat(), newChat()],
    {
      [`${CHATS}/chat1.jsonl`]: `${chatLine(0)}\n`,
      [`${CHATS}/chat2.json`]: { dir: true },
    },
    'a messages file alone, or an info folder, makes the id taken',
  ),
  scenario(
    { ids: null },
    [newChat(), newChat()],
    {},
    'the default random ids are 16 URL-safe characters',
  ),

  // ---- documents ----
  scenario(
    {},
    [
      reply('c1', 'a', {}, inDocs('A.docx')),
      reply('c1', 'b', {}, inDocs('sub/B.docx')),
      reply('c1', 'c', {}, inDocs('A.docx')),
      reply('c1', 'd', {}, inDocs('a.docx')),
      info('c1'),
      forDoc('$DIR/proj/A.docx'),
      forDoc('$DIR/proj/A.DOCX'),
      forDoc('$DIR/proj/sub/B.docx'),
      forDoc('$DIR/proj/none.docx'),
    ],
    { 'proj/sub': { dir: true } },
    'documents move to the end; on linux a name that differs in case is another document',
  ),
  scenario(
    { platform: 'darwin' },
    [
      reply('c1', 'a', {}, inDocs('A.docx')),
      reply('c1', 'b', {}, inDocs('sub/B.docx')),
      reply('c1', 'c', {}, inDocs('A.docx')),
      reply('c1', 'd', {}, inDocs('a.docx')),
      info('c1'),
      forDoc('$DIR/proj/A.docx'),
      forDoc('$DIR/proj/A.DOCX'),
      forDoc('$DIR/proj/sub/B.docx'),
    ],
    { 'proj/sub': { dir: true } },
    'on darwin a name that differs in case is the same document',
  ),
  scenario(
    { platform: 'win32' },
    [reply('c1', 'a', {}, inDocs('sub/B.docx')), attach('c1', '$DIR/proj/SUB/b.docx'), info('c1')],
    { 'proj/sub': { dir: true } },
    'win32 folds case too (the path itself is read as the host reads it)',
  ),
  scenario(
    { listeners: ['ok'] },
    [
      user('c1', 'q', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf', key: 'win-1' }),
      reply('c1', 'a', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf', key: { w: 2 } }),
      reply('c1', 'again', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf' }),
      reply('c2', 'other chat', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf' }),
      reply('c2', 'two docs', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/y.pdf' }),
      info('c1'),
    ],
    {},
    'a document outside the folder is recorded once per chat; the sender tag comes back to the listener',
  ),
  scenario(
    { outsideFails: true },
    [
      reply('c1', 'a', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf' }),
      world({ outsideFails: false }),
      reply('c1', 'b', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf' }),
      reply('c1', 'c', {}, { editor: 'pdf', docPath: '$DIR/elsewhere/x.pdf' }),
    ],
    {},
    'a failed record is warned about and tried again with the next write',
  ),
  // ---- an unwritable folder ----
  scenario(
    { unwritable: true, listeners: ['ok'] },
    [
      user('c1', 'a'),
      reply('c1', 'b'),
      counts(),
      world({ unwritable: false }),
      reply('c1', 'c'),
      open('c1'),
      list(),
    ],
    {},
    'an unwritable project keeps the messages in memory; a later write puts all of them on disk',
  ),
  scenario(
    { failWrites: true },
    [
      reply('c1', 'a'),
      reply('c1', 'b'),
      world({ failWrites: false }),
      reply('c1', 'c'),
      world({ unwritable: false }),
      reply('c1', 'd'),
      open('c1'),
    ],
    {},
    'a failed write marks the project unwritable for the rest of the run',
  ),
  scenario(
    {},
    [
      reply('c1', 'a'),
      reply('c1', 'b'),
      world({ unwritable: false }),
      { op: 'chmod', path: '$DIR/proj/.seuoffice/chats', mode: 0o755 },
      reply('c1', 'c'),
      open('c1'),
    ],
    { [CHATS]: { dir: true, mode: 0o555 } },
    'a chats folder the guide cannot write into, made writable later',
  ),
  scenario(
    { listeners: ['ok'] },
    [
      reply('c1', 'answer'),
      info('c1'),
      world({ unwritable: false }),
      { op: 'chmod', path: `${CHATS_ABS}/c1.json`, mode: 0o644 },
      user('c1', 'catch up'),
      info('c1'),
    ],
    { [`${CHATS}/c1.json`]: { text: chatInfo('c1', { title: '' }), mode: 0o444 } },
    'the messages are written, the info is not: it catches up with the next write',
  ),
  scenario(
    {},
    [
      open('c1'),
      world({ unwritable: true }),
      user('c1', 'held in memory'),
      reply('c1', 'also held'),
      open('c1'),
      list(),
    ],
    planted('c1', {}, lines(2)),
    'messages of this run that could not be written show after the stored ones',
  ),
  scenario(
    {},
    [
      append('c1', 'user', 'm', {}, HOME, { times: 205 }),
      counts(),
      list(),
      open('c1', { limit: 3 }),
      open('c1'),
    ],
    {},
    'the opening messages written early at 200 instead of dropped',
  ),
  scenario(
    { unwritable: true },
    [
      append('c1', 'user', 'm', {}, HOME, { times: 203 }),
      world({ unwritable: false }),
      user('c1', 'after'),
      open('c1', { limit: 3 }),
    ],
    {},
    'at the cap an unwritable project still holds everything',
  ),

  // ---- opening a chat ----
  scenario(
    {},
    [
      open('c1'),
      open('c1', { limit: 3 }),
      open('c1', { limit: 0 }),
      open('c1', { limit: -5 }),
      open('c1', { limit: 2.7 }),
      open('c1', { limit: 'x' }),
      open('c1', { limit: 1e9 }),
      open('c1', { limit: null }),
      open('c1', { limit: 1e-9 }),
      open('nope'),
    ],
    planted('c1', {}, lines(10)),
    'the limit: default, cut, at least one, a fraction floored, not a number',
  ),
  scenario(
    {},
    [
      list(),
      open('c1'),
      open('c2'),
      open('c3'),
      info('c3'),
      reply('c3', 'hello'),
      info('c3'),
      open('c3'),
      reply('c1', 'after messy lines'),
      open('c1', { limit: 3 }),
    ],
    {
      ...planted(
        'c1',
        {},
        [
          [
            chatLine(5),
            'not json',
            '',
            '   ',
            '[1,2]',
            '7',
            'null',
            '{"seq":"1","role":"user","text":"x"}',
            '{"seq":1,"role":5,"text":"x"}',
            '{"seq":1,"role":"user"}',
            '{"role":"user","text":"no seq"}',
            JSON.stringify({
              text: 'first',
              role: 'user',
              seq: 1.5,
              extra: { a: 1 },
              editor: 'nope',
            }),
            '{"seq":-2,"role":"system","text":"negative","origin":7}',
            chatLine(3, { editor: 'hwp', origin: 'install-B', unknownKey: [1, 2] }),
            chatLine(3, { text: 'duplicate seq' }),
            '{"seq":2,"role":"user","text":"proto","__proto__":{"x":1},"editor":"pdf"}',
            '{"seq":1e400,"role":"user","text":"infinite"}',
            `  ${chatLine(4)}   `,
          ].join('\r\n'),
        ],
        '\r\n',
      ),
      [`${CHATS}/c2.json`]: chatInfo('c2'),
      [`${CHATS}/c2.jsonl`]: {
        hex: Buffer.concat([
          Buffer.from(`\ufeff${chatLine(0)}\n`),
          Buffer.from(chatLine(1, { text: 'ok ' }).split('"text":"ok ')[0]! + '"text":"ok '),
          Buffer.from([0xff, 0xfe]),
          Buffer.from(` tail${chatLine(1, { text: 'ok ' }).split('"text":"ok ')[1]!}\n`),
          Buffer.from(`${chatLine(2, { text: '한글 text' })}\n`),
        ]).toString('hex'),
      },
      [`${CHATS}/c3.json`]: JSON.stringify({
        zzz: 'first',
        version: 7,
        id: 'c3',
        projectId: P,
        title: 12,
        createdAt: null,
        updatedAt: '2026-02-02T00:00:00.000Z',
        origin: 'install-A',
        lastEditor: 'nope',
        documents: [1, 'a.docx', null, 'b.docx'],
        extra: { deep: [1, { x: null }], empty: [], none: {} },
        '10': 'integer key',
        '2': 'two',
      }),
    },
    'lenient reading: broken lines skipped, extra keys kept, a BOM or a bad byte, an info of odd types',
  ),
  scenario(
    {},
    [
      list(),
      info('c4'),
      info('c5'),
      info('c6'),
      info('c7'),
      info('c8'),
      info('c9'),
      open('c4'),
      user('c4', 'over a broken info'),
      info('c4'),
    ],
    {
      [`${CHATS}/c4.json`]: '{',
      [`${CHATS}/c5.json`]: chatInfo('someone-else'),
      [`${CHATS}/c6.json`]: chatInfo('c6', { projectId: 'bad id' }),
      [`${CHATS}/c7.json`]: '[1]',
      [`${CHATS}/c8.json`]: '5',
      [`${CHATS}/c9.json`]: 'null',
    },
    'an info that is broken, for another id, or without a project id reads as absent',
  ),
  scenario(
    {},
    [list(), info('b'), info('empty')],
    {
      ...planted('b', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('B', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('a_1', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('a-1', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('A2', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('a2', { updatedAt: '2026-03-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('new', { updatedAt: '2026-05-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('old', { updatedAt: '2025-01-01T00:00:00.000Z' }, [chatLine(0)]),
      ...planted('empty', { updatedAt: '' }, [chatLine(0)]),
      [`${CHATS}/.json`]: chatInfo(''),
      [`${CHATS}/bad id.json`]: chatInfo('bad id'),
      [`${CHATS}/notes.txt`]: 'x',
      [`${CHATS}/dir.json`]: { dir: true },
      [`${CHATS}/x.json.bak`]: chatInfo('x'),
    },
    'the list: newest first, ties by id in the collation order, entries that are not chats left out',
  ),

  // ---- chats of other installs and other projects ----
  scenario(
    {},
    [
      list(),
      counts(),
      open('theirs'),
      open('mixed'),
      world({ trust: 'without' }),
      list(),
      open('theirs'),
      open('mixed'),
      open('mine'),
      info('theirs'),
      info('mine'),
      world({ trust: 'unconfirmed' }),
      list(),
      world({ trust: 'use' }),
      list(),
    ],
    {
      ...planted('mine', {}, lines(2)),
      ...planted('theirs', { origin: 'install-B' }, lines(2, { origin: 'install-B' })),
      ...planted('mixed', {}, [chatLine(0), chatLine(1, { origin: 'install-C' })]),
      ...planted('nomsg', {}, []),
      [`${CHATS}/infoonly.json`]: chatInfo('infoonly'),
    },
    'chats of another install: listed and marked under use, hidden otherwise',
  ),
  scenario(
    {},
    [
      list(),
      plant(
        `${CHATS_ABS}/mixed.jsonl`,
        `${chatLine(0)}\n${chatLine(1, { origin: 'install-A' })}\n`,
      ),
      { op: 'touch', path: `${CHATS_ABS}/mixed.jsonl`, mtimeMs: 1_700_000_000_000 },
      list(),
      { op: 'touch', path: `${CHATS_ABS}/mixed.jsonl`, mtimeMs: 1_700_000_001_000 },
      list(),
      counts(),
    ],
    planted(
      'mixed',
      {},
      [chatLine(0), chatLine(1, { origin: 'install-C' })],
      '\n',
      1_700_000_000_000,
    ),
    'a scan is reused while size and time stay the same, and made again when one changes',
  ),
  scenario(
    { foreignCacheLimit: 2 },
    [
      list(),
      counts(),
      plant(`${CHATS_ABS}/a.jsonl`, `${chatLine(0, { origin: 'install-X' })}\n`),
      { op: 'touch', path: `${CHATS_ABS}/a.jsonl`, mtimeMs: 1_700_000_000_000 },
      plant(`${CHATS_ABS}/c.jsonl`, `${chatLine(0, { origin: 'install-X' })}\n`),
      { op: 'touch', path: `${CHATS_ABS}/c.jsonl`, mtimeMs: 1_700_000_000_000 },
      list(),
      counts(),
    ],
    {
      ...planted('a', {}, [chatLine(0)], '\n', 1_700_000_000_000),
      ...planted('b', {}, [chatLine(0)], '\n', 1_700_000_000_000),
      ...planted('c', {}, [chatLine(0)], '\n', 1_700_000_000_000),
      ...planted('d', {}, [chatLine(0)], '\n', 1_700_000_000_000),
    },
    'the scans kept are the most recent ones; an older one is scanned again',
  ),
  scenario(
    {},
    [
      list(),
      info('x'),
      open('x'),
      user('x', 'hi'),
      reply('x', 'hello'),
      rename('x', 'title'),
      attach('x', '$DIR/proj/a.docx'),
      del('x'),
      counts(),
    ],
    planted('x', { projectId: 'p2' }, lines(2)),
    'a chat of a copied folder (another project id): hidden, never written, delete leaves it',
  ),

  // ---- attaching a document ----
  scenario(
    {},
    [
      attach('c1', '$DIR/proj/Doc.docx'),
      attach('c1', '$DIR/proj/Doc.docx'),
      attach('c1', '$DIR/proj/sub/Other.docx'),
      attach('c1', '$DIR/elsewhere/z.docx'),
      user('c1', 'q'),
      reply('c1', 'a', {}, inDocs('Third.docx')),
      info('c1'),
      attach('c1', '$DIR/proj/Doc.docx'),
      info('c1'),
      world({ unwritable: true }),
      attach('c1', '$DIR/proj/New.docx'),
      world({ unwritable: false }),
      attach('c1', '$DIR/proj/Last.docx'),
      info('c1'),
    ],
    { 'proj/sub': { dir: true } },
    'attaching: kept with the first write, written at once to a chat on disk, nothing outside the folder',
  ),

  // ---- deleting ----
  scenario(
    {},
    [
      info('c1'),
      del('c1'),
      list(),
      open('c1'),
      counts(),
      user('c2', 'x'),
      del('c2'),
      user('c2', 'y'),
      del('c3'),
      world({ unwritable: true }),
      del('c4'),
      world({ unwritable: false, trashFails: true }),
      del('c4'),
      del('c4'),
      world({ unwritable: false, trashFails: false }),
      del('c4'),
      del('missing'),
    ],
    {
      ...planted('c1', {}, lines(3)),
      ...planted('c4', {}, lines(1)),
      [`${CHATS}/c3.json`]: chatInfo('c3'),
      [`${CHATS}/c3.jsonl`]: { dir: true },
    },
    'delete moves the files to the trash and drops the chat; a failed move marks the project unwritable',
  ),

  // ---- the chat a document opens with ----
  scenario(
    {
      selections: [
        ['$DIR/elsewhere/out.docx', { projectId: P, initialChatId: 'd1' }],
        ['$DIR/elsewhere/other.docx', { projectId: 'p2', initialChatId: 'd1' }],
        ['$DIR/elsewhere/gone.docx', { projectId: P, initialChatId: 'zz' }],
        ['$DIR/elsewhere/bad.docx', { projectId: P, initialChatId: 'bad id' }],
        ['$DIR/elsewhere/none.docx', { projectId: P, initialChatId: null }],
        ['$DIR/elsewhere/foreign.docx', { projectId: P, initialChatId: 'd3' }],
      ],
    },
    [
      forDoc('$DIR/proj/A.docx'),
      forDoc('$DIR/proj/C.docx'),
      forDoc('$DIR/proj/sub/A.docx'),
      forDoc('$DIR/proj/never.docx'),
      forDoc('$DIR/elsewhere/out.docx'),
      forDoc('$DIR/elsewhere/other.docx'),
      forDoc('$DIR/elsewhere/gone.docx'),
      forDoc('$DIR/elsewhere/bad.docx'),
      forDoc('$DIR/elsewhere/none.docx'),
      forDoc('$DIR/elsewhere/unknown.docx'),
      forDoc('$DIR/elsewhere/foreign.docx'),
      world({ trust: 'without' }),
      forDoc('$DIR/proj/C.docx'),
      forDoc('$DIR/elsewhere/foreign.docx'),
      forDoc('$DIR/elsewhere/out.docx'),
    ],
    {
      'proj/sub': { dir: true },
      ...planted('d1', { documents: ['A.docx'], updatedAt: '2026-01-02T00:00:00.000Z' }, [
        chatLine(0),
      ]),
      ...planted(
        'd2',
        { documents: ['sub/A.docx', 'A.docx'], updatedAt: '2026-01-03T00:00:00.000Z' },
        [chatLine(0)],
      ),
      ...planted(
        'd3',
        { documents: ['C.docx'], origin: 'install-B', updatedAt: '2026-01-04T00:00:00.000Z' },
        [chatLine(0, { origin: 'install-B' })],
      ),
    },
    'the chat for a document: the newest visible one that holds it, or the one recorded for it outside',
  ),

  // ---- the states kept in memory ----
  scenario(
    { stateCacheLimit: 2 },
    [
      reply('c1', 'a'),
      reply('c2', 'a'),
      counts(),
      reply('c3', 'a'),
      counts(),
      user('held', 'only in memory'),
      reply('c4', 'a'),
      counts(),
      reply('c5', 'a'),
      counts(),
      reply('c1', 'again'),
      open('c1'),
      counts(),
      reply('held', 'now written'),
      reply('c6', 'a'),
      counts(),
    ],
    {},
    'past the limit the idle states least recently used go; one with unwritten messages stays; a dropped chat is read again',
  ),
  scenario(
    {},
    [
      open('c1'),
      reply('c1', 'old dir'),
      user('c2', 'held'),
      plant('$DIR/proj/.seuoffice/memory.md', 'x'),
      open('c1'),
      reply('c1', 'new dir'),
      reply('c2', 'flush held'),
      open('c2'),
      list(),
      counts(),
    ],
    {
      [`proj/.ieumoffice/chats/c1.json`]: chatInfo('c1'),
      [`proj/.ieumoffice/chats/c1.jsonl`]: `${chatLine(0)}\n${chatLine(1)}\n`,
    },
    'the data folder changes under a chat: a chat on disk is read again, one in memory keeps its messages',
  ),

  // ---- the end of a messages file ----
  scenario(
    {},
    [
      reply('c1', 'after a last line without a newline'),
      reply('c2', 'after a cut line'),
      reply('c3', 'after a whole file'),
      reply('c4', 'after a fraction'),
      reply('c5', 'after an empty file'),
      reply('c6', 'after a number only'),
      open('c1'),
      open('c2'),
      open('c4'),
    ],
    {
      ...planted('c1', {}, [chatLine(0), chatLine(41)], ''),
      ...planted('c2', {}, [chatLine(0), '{"seq":1,"role":"us'], ''),
      ...planted('c3', {}, [chatLine(0), chatLine(1)]),
      ...planted('c4', {}, [chatLine(2.5)]),
      ...planted('c5', {}, [], ''),
      ...planted('c6', {}, ['7'], '\n'),
    },
    'the next number comes from the file; a missing newline is added before the new line',
  ),
  scenario(
    {},
    [
      open('c1', { limit: 1 }),
      reply('c1', 'after a window that starts on a line'),
      open('c1', { limit: 1 }),
    ],
    {
      [`${CHATS}/c1.json`]: chatInfo('c1'),
      [`${CHATS}/c1.jsonl`]: `${[
        chatLine(0, { text: 'before the window' }),
        exactLine(1000, BIG_LINE),
        ...Array.from({ length: 46 }, (_, i) => exactLine(i + 1, BIG_LINE)),
      ].join('\n')}\n`,
    },
    'the window of 8 MiB begins exactly on a line: that line is kept',
  ),
  scenario(
    {},
    [reply('c1', 'after one long last line')],
    {
      [`${CHATS}/c1.json`]: chatInfo('c1'),
      [`${CHATS}/c1.jsonl`]: `${chatLine(0)}\n${chatLine(1, { text: 'b'.repeat(8_389_000) })}`,
    },
    'a last record longer than the window widens it',
  ),
  scenario(
    {},
    [reply('c1', 'after one long last line and its newline')],
    {
      [`${CHATS}/c1.json`]: chatInfo('c1'),
      [`${CHATS}/c1.jsonl`]: `${chatLine(0)}\n${chatLine(1, { text: 'b'.repeat(8_389_000) })}\n`,
    },
    'a last record longer than the window, newline included, widens it',
  ),
  scenario(
    {},
    [
      reply('c1', 'mine'),
      plant(`${CHATS_ABS}/c1.json`, chatInfo('c1', { projectId: 'p2' })),
      reply('c1', 'after the swap'),
      info('c1'),
      list(),
    ],
    {},
    'an info that names another project by the time it is written is left alone',
  ),
  scenario(
    {},
    [
      list(),
      plant(
        `${CHATS_ABS}/mixed.jsonl`,
        `${chatLine(0, { text: 'longer text now' })}\n${chatLine(1, { origin: 'install-A' })}\n`,
      ),
      { op: 'touch', path: `${CHATS_ABS}/mixed.jsonl`, mtimeMs: 1_700_000_000_000 },
      list(),
    ],
    planted(
      'mixed',
      {},
      [chatLine(0), chatLine(1, { origin: 'install-C' })],
      '\n',
      1_700_000_000_000,
    ),
    'a scan is made again when the size changes though the time does not',
  ),
  scenario(
    { stateCacheLimit: 2 },
    [
      reply('u', 'one', {}, inDocs('U.docx')),
      rename('r', 'Kept'),
      attach('a', '$DIR/proj/Kept.docx'),
      world({ unwritable: false }),
      reply('p1', 'x'),
      reply('p2', 'x'),
      reply('p3', 'x'),
      counts(),
      { op: 'chmod', path: `${CHATS_ABS}/u.json`, mode: 0o644 },
      user('u', 'later'),
      user('r', 'later'),
      user('a', 'later'),
      info('u'),
      info('r'),
      info('a'),
    ],
    {
      ...planted('r', {}, [chatLine(0)]),
      ...planted('a', {}, [chatLine(0)]),
      [`${CHATS}/u.json`]: { text: chatInfo('u'), mode: 0o444 },
      [`${CHATS}/u.jsonl`]: `${chatLine(0)}\n`,
      'proj/sub': { dir: true },
    },
    'a state with a rename, an attached document or an unwritten info is not dropped',
  ),
  scenario(
    {},
    [
      attach('c1', '$DIR/proj/sub/B.docx'),
      info('c1'),
      attach('c1', '$DIR/proj/\u00e9.docx'),
      info('c1'),
    ],
    {
      ...planted('c1', { documents: ['sub\\B.docx', 'e\u0301.docx'] }, [chatLine(0)]),
      'proj/sub': { dir: true },
    },
    'a document is the same one with a backslash or a decomposed letter',
  ),
  scenario(
    {},
    [
      open('c1'),
      list(),
      reply('c1', 'unreadable'),
      world({ unwritable: false }),
      { op: 'chmod', path: `${CHATS_ABS}/c1.jsonl`, mode: 0o644 },
      reply('c1', 'readable'),
      open('c1'),
    ],
    {
      [`${CHATS}/c1.json`]: chatInfo('c1'),
      [`${CHATS}/c1.jsonl`]: { text: `${lines(2).join('\n')}\n`, mode: 0 },
    },
    'a messages file that cannot be read: warned about, read as empty, the append fails',
  ),
  scenario(
    { platform: 'host' },
    [reply('c1', 'a', {}, inDocs('A.docx')), reply('c1', 'b', {}, inDocs('a.docx')), info('c1')],
    {},
    'the platform of the host decides whether a name differing in case is the same document',
  ),
  scenario(
    {},
    [reply('c1', 'after a window that cuts a line'), open('c1', { limit: 1 })],
    {
      [`${CHATS}/c1.json`]: chatInfo('c1'),
      [`${CHATS}/c1.jsonl`]: `${[
        chatLine(500, { text: 'cut away' }),
        ...Array.from({ length: 80 }, (_, i) => exactLine(i, 130_000)),
      ].join('\n')}\n`,
    },
    'the window of 8 MiB begins inside a line: the cut line is dropped',
  ),
  scenario(
    {},
    [
      attach('c1', '$DIR/proj/A.docx'),
      attach('c1', '$DIR/proj/B.docx'),
      reply('c1', 'first', {}, inDocs('C.docx')),
      info('c1'),
      reply('c1', 'second', {}, inDocs('D.docx')),
      info('c1'),
    ],
    {},
    'documents attached before the first write are written once, not again after the next message',
  ),
]

export const chats: Group = {
  'chat-store.scenario': {
    ts: (args, cx) => runScenario(args[0] as Scenario, cx),
    cases,
  },
  'chat-store.CHAT_TITLE_CHARS': constant(chatStore.CHAT_TITLE_CHARS),
  'chat-store.CHAT_TITLE_MAX_CHARS': constant(chatStore.CHAT_TITLE_MAX_CHARS),
  'chat-store.MAX_PENDING_OPENING_MESSAGES': constant(chatStore.MAX_PENDING_OPENING_MESSAGES),
  'chat-store.CHAT_STATE_CACHE_LIMIT': constant(chatStore.CHAT_STATE_CACHE_LIMIT),
  'chat-store.FOREIGN_SCAN_CACHE_LIMIT': constant(chatStore.FOREIGN_SCAN_CACHE_LIMIT),
}
