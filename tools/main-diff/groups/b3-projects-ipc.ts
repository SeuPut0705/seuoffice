/**
 * Part `ipc` of group `b3-projects`: apps/shell/src/main/projects/
 * project-ipc.ts. The Rust side is crates/main-core/src/calls/b3_projects/
 * ipc.rs.
 *
 * `project-ipc.scenario` builds the real `registerProjectFolderIpc` over
 * fakes and runs a list of operations on it, the way the shell would drive
 * it, answering `[[label, result], ...]` (`result` is what the handler or
 * controller method answered, `{ error: message }` where it threw,
 * `{ undefined: true }` for `undefined` and `null` for the methods that
 * answer nothing). Each handler of `PROJECT_FOLDER_CHANNELS` is also a
 * function of its own, `project-ipc.<handler>`, with the arguments
 * `[world, sender, raw?, after?, lead?]`: the operations of `lead` (a list),
 * one `call` of that handler, then the operations of `after` (a list); the
 * lists are present only with `raw`.
 *
 * The world is `{ platform, windows, gone, answers, cloud, ops }`:
 * - `windows`: sender id -> `{ kind: 'home' }` or `{ kind: 'editor', editor,
 *   docPath }`, anything else (or none) is not an AI window;
 * - `gone`: the senders `send` answers false for; `platform`: `deps.platform`
 *   (null leaves it out); `cloud`: null leaves `resolveCloudOnly` out, else
 *   `{ answers?, fail? }`, a resolver that logs `['host', 'resolve', paths]`;
 * - `answers`: what each fake method answers, by `<fake>.<method>`. A fake
 *   method logs `[<fake>, <method>, ...args]` (the trust question left out),
 *   then answers the entry: a value as it is, `{ $throw }` (an `Error` with
 *   that message), `{ $seq: [...] }` (the nth call takes the nth entry, the
 *   last repeats), `{ $on, map, default? }` (`$on` is `kind` of the first
 *   argument, or `#n` for the nth argument; the entry of `map` at its text),
 *   `{ $ask: prompt, null, use, without }` (asks the trust question the
 *   guide was given with `prompt`, logs `['ask', key, answer]` and takes the
 *   entry named by the answer) and, for `chats.append` only, `{ $events:
 *   [{ event, key? }], then }` (the chat store's listener hears each event,
 *   with the sender's key unless the entry names one). A void method
 *   (`guide.removeFromList`, `guide.setPinned`, `host.openFolder`,
 *   `tools.closeScope`) needs no entry; `host.presetProjectOf` present
 *   gives the dependency (its entry is read by `deps.presetProjectOf`).
 *   `guide.aiVisibility` answers null or `{ root, ignore?, fold? }`, the
 *   guide's visibility of that rule.
 * - an operation is `{ op: 'call', name, sender, raw? }`, `{ op: 'listen',
 *   sender, method?, on? }`, `{ op: 'forget' | 'reset' | 'untitledProject' |
 *   'windowProject', sender }` or `{ op: 'set', answers?, windows?, gone? }`
 *   (merges into the world).
 *
 * `project-ipc.waitForPageReturn`: `[{ destroyed, events }]`, `events` the
 * page's `arm` (the timer), `focus`, `blur` and `destroyed`, answering what
 * the promise resolved with after each (`pending` before it settles).
 *
 * Which functions need Electron: none, but folder-files.ts reaches
 * agent-sessions.ts, so the fake of electron-fake.ts is registered first.
 */
import '../electron-fake.ts'
import { setImmediate } from 'node:timers/promises'
import { PROJECT_FOLDER_CHANNELS } from '../../../packages/project-store/src/folder-api.ts'
import type { ProjectAiVisibility } from '../../../apps/shell/src/main/projects/project-guide.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

const projectIpc = await import('../../../apps/shell/src/main/projects/project-ipc.ts')
const ignore = await import('../../../apps/shell/src/main/projects/ignore.ts')
const visibility = await import('../../../apps/shell/src/main/projects/visibility.ts')

type Json = unknown
type Op = { op: string } & Record<string, Json>

interface World {
  platform: string | null
  windows: Record<string, Json>
  gone: number[]
  answers: Record<string, Json>
  cloud: { answers?: Record<string, boolean>; fail?: string } | null
  ops: Op[]
}

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function runScenario(world: World, cx: TsContext): Promise<unknown> {
  const answers: Record<string, Json> = { ...world.answers }
  const windows: Record<string, Json> = { ...world.windows }
  let gone = [...world.gone]
  const counters = new Map<string, number>()
  const listeners: Array<(event: Json, sender: Json) => void> = []
  const handlers = new Map<string, (sender: number, raw: unknown) => unknown>()
  const log = (...line: unknown[]): void => cx.log(...line)

  type Step = { done: Json } | { next: Json } | { ask: Record<string, Json> }

  /** one rewrite of an answer entry: a marker taken apart, or the value */
  const step = (key: string, args: Json[], entry: Json): Step => {
    if (!isObject(entry)) return { done: entry }
    if ('$seq' in entry) {
      const list = entry.$seq as Json[]
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      return { next: list[Math.min(n, list.length - 1)] }
    }
    if ('$throw' in entry) throw new Error(entry.$throw as string)
    if ('$on' in entry) {
      const on = entry.$on as string
      const first = args[0]
      const text = on.startsWith('#')
        ? String(args[Number(on.slice(1))] ?? null)
        : String((first as Record<string, Json>)[on])
      const map = entry.map as Record<string, Json>
      if (Object.hasOwn(map, text)) return { next: map[text] }
      if ('default' in entry) return { next: entry.default }
      throw new Error(`no branch for ${text} of ${key}`)
    }
    if ('$events' in entry) {
      const sender = args[1] as Record<string, Json>
      for (const item of entry.$events as Array<{ event: Json; key?: Json }>) {
        for (const listener of listeners) {
          listener(item.event, { ...sender, ...('key' in item ? { key: item.key } : {}) })
        }
      }
      return { next: entry.then }
    }
    if ('$ask' in entry) return { ask: entry }
    return { done: entry }
  }

  const missing = (key: string): Error => new Error(`no answer for ${key}`)

  const answerSync = (key: string, args: Json[], optional = false): Json => {
    if (!(key in answers)) {
      if (optional) return undefined
      throw missing(key)
    }
    let entry = answers[key]
    for (;;) {
      const s = step(key, args, entry)
      if ('done' in s) return s.done
      if ('ask' in s) throw new Error(`${key} cannot ask`)
      entry = s.next
    }
  }

  const answerAsync = async (
    key: string,
    args: Json[],
    ask?: (prompt: never) => Promise<unknown>,
    optional = false,
  ): Promise<Json> => {
    if (!(key in answers)) {
      if (optional) return undefined
      throw missing(key)
    }
    let entry = answers[key]
    for (;;) {
      const s = step(key, args, entry)
      if ('done' in s) return s.done
      if ('ask' in s) {
        if (!ask) throw new Error(`${key} cannot ask`)
        const given = await ask(s.ask.$ask as never)
        const name = String(given ?? null)
        log('ask', key, name)
        if (!(name in s.ask)) throw new Error(`no branch ${name} of ${key}`)
        entry = s.ask[name]
        continue
      }
      entry = s.next
    }
  }

  /** a method that logs, takes the trust question when the last argument is one, answers */
  const method =
    (kind: string, name: string, optional = false) =>
    async (...given: Json[]): Promise<Json> => {
      const ask =
        typeof given.at(-1) === 'function'
          ? (given.pop() as (prompt: never) => Promise<unknown>)
          : undefined
      log(kind, name, ...given)
      return answerAsync(`${kind}.${name}`, given, ask, optional)
    }

  const syncMethod =
    (kind: string, name: string) =>
    (...given: Json[]): Json => {
      log(kind, name, ...given)
      return answerSync(`${kind}.${name}`, given)
    }

  const makeVis = (cfg: { root: string; ignore?: string; fold?: boolean }): ProjectAiVisibility => {
    const matcher = ignore.compileIgnore(cfg.ignore ?? '', { caseInsensitive: cfg.fold ?? false })
    return {
      root: cfg.root,
      matcher,
      isVisible: (rel: string, isDir = false) =>
        visibility.isAiVisiblePath(cfg.root, rel, matcher, isDir),
    }
  }

  const guide = {
    listProjects: method('guide', 'listProjects'),
    addFolder: method('guide', 'addFolder'),
    relocateProject: method('guide', 'relocateProject'),
    getDefaultParentFolder: method('guide', 'getDefaultParentFolder'),
    createProject: method('guide', 'createProject'),
    removeFromList: method('guide', 'removeFromList', true),
    setPinned: method('guide', 'setPinned', true),
    renameProject: method('guide', 'renameProject'),
    retryUnwritable: method('guide', 'retryUnwritable'),
    projectRoot: syncMethod('guide', 'projectRoot'),
    getSelection: method('guide', 'getSelection'),
    setSelection: method('guide', 'setSelection'),
    adoptFolderHint: method('guide', 'adoptFolderHint'),
    readContext: method('guide', 'readContext'),
    editMemory: method('guide', 'editMemory'),
    saveMemory: method('guide', 'saveMemory'),
    applyMemoryConsolidation: method('guide', 'applyMemoryConsolidation'),
    undoMemoryConsolidation: method('guide', 'undoMemoryConsolidation'),
    getProjectDetail: method('guide', 'getProjectDetail'),
    getSettings: method('guide', 'getSettings'),
    setSettings: method('guide', 'setSettings'),
    decideTrust: method('guide', 'decideTrust'),
    saveInstructions: method('guide', 'saveInstructions'),
    addIgnore: method('guide', 'addIgnore'),
    removeIgnore: method('guide', 'removeIgnore'),
    aiVisibility: async (id: string) => {
      log('guide', 'aiVisibility', id)
      const cfg = (await answerAsync('guide.aiVisibility', [id])) as {
        root: string
        ignore?: string
        fold?: boolean
      } | null
      return cfg === null ? null : makeVis(cfg)
    },
  }
  const chats = {
    newChat: method('chats', 'newChat'),
    listChats: method('chats', 'listChats'),
    openChat: method('chats', 'openChat'),
    append: method('chats', 'append'),
    renameChat: method('chats', 'renameChat'),
    deleteChat: method('chats', 'deleteChat'),
    attachDocument: method('chats', 'attachDocument'),
    chatForDocument: method('chats', 'chatForDocument'),
    chatInfo: method('chats', 'chatInfo'),
    onAppended: (listener: (event: Json, sender: Json) => void) => {
      listeners.push(listener)
      return () => undefined
    },
  }
  const tools = {
    openScope: method('tools', 'openScope'),
    closeScope: (...given: Json[]) => {
      log('tools', 'closeScope', ...given)
      return answerSync('tools.closeScope', given, true)
    },
    listFiles: method('tools', 'listFiles'),
    search: method('tools', 'search'),
    read: method('tools', 'read'),
  }
  const scopes = { projectOf: syncMethod('scopes', 'projectOf') }
  const dialogs = {
    pickFolder: method('dialogs', 'pickFolder'),
    confirmUseExisting: method('dialogs', 'confirmUseExisting'),
    askTrust: method('dialogs', 'askTrust'),
    waitForReturn: method('dialogs', 'waitForReturn'),
  }

  const controller = projectIpc.registerProjectFolderIpc({
    services: () => ({ guide, chats, tools, scopes }) as never,
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    windowOf: (sender) => (windows[String(sender)] ?? null) as never,
    send: (target, channel, payload) => {
      log('host', 'send', target, channel, payload)
      return !gone.includes(target)
    },
    dialogs: dialogs as never,
    legacyChatFor: syncMethod('host', 'legacyChatFor') as never,
    openFolder: async (path) => {
      log('host', 'openFolder', path)
      answerSync('host.openFolder', [path], true)
    },
    openDocument: syncMethod('host', 'openDocument') as never,
    showHome: syncMethod('host', 'showHome') as never,
    projectsChanged: () => log('host', 'projectsChanged'),
    ...(world.cloud === null
      ? {}
      : {
          resolveCloudOnly: async (paths: readonly string[]) => {
            log('host', 'resolve', [...paths])
            if (world.cloud?.fail !== undefined) throw new Error(world.cloud.fail)
            return new Map(Object.entries(world.cloud?.answers ?? {}))
          },
        }),
    ...('host.presetProjectOf' in answers
      ? {
          presetProjectOf: async (sender: number) => {
            log('host', 'presetProjectOf', sender)
            return (await answerAsync('host.presetProjectOf', [sender])) as never
          },
        }
      : {}),
    ...(world.platform === null ? {} : { platform: world.platform as NodeJS.Platform }),
  })

  const run = async (op: Op): Promise<unknown> => {
    const sender = op.sender as number
    switch (op.op) {
      case 'call': {
        const handler = handlers.get(
          (PROJECT_FOLDER_CHANNELS as Record<string, string>)[op.name as string]!,
        )
        if (!handler) throw new Error(`no handler ${String(op.name)}`)
        return handler(sender, 'raw' in op ? op.raw : undefined)
      }
      case 'listen':
        controller.listen(
          sender,
          'method' in op ? op.method : undefined,
          'on' in op ? op.on : undefined,
        )
        return null
      case 'forget':
        controller.forget(sender)
        return null
      case 'reset':
        controller.reset(sender)
        return null
      case 'untitledProject':
        return controller.untitledProject(sender)
      case 'windowProject':
        return controller.windowProject(sender)
      case 'set':
        Object.assign(answers, op.answers ?? {})
        Object.assign(windows, op.windows ?? {})
        if (op.gone) gone = op.gone as number[]
        return null
      default:
        throw new Error(`unknown operation ${op.op}`)
    }
  }

  const rows: unknown[] = []
  for (const op of world.ops) {
    let value: unknown
    try {
      value = await run(op)
    } catch (error) {
      value = { error: (error as Error).message }
    }
    rows.push([
      op.op === 'call' ? op.name : op.op,
      value === undefined ? { undefined: true } : value,
    ])
  }
  return rows
}

// ---------------------------------------------------------------------------
// building cases
// ---------------------------------------------------------------------------

const NOW0 = '2026-01-01T00:00:00.000Z'
const HOME = 1
const DOCS = 2
const SHEETS = 3
const UNTITLED = 4
const EMPTY_DOC = 5
const PDF = 6
const STRANGER = 99
const ROOT = '$DIR/proj'
const DOC = `${ROOT}/draft.docx`

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  path: `/work/${id}`,
  pinned: false,
  lastUsedAt: NOW0,
  missing: false,
  unwritable: false,
  syncFolder: false,
  ...extra,
})
const added = (id: string, identity = 'new') => ({
  status: 'added',
  project: item(id),
  identity,
  notices: [],
})
const created = (id: string) => ({ status: 'created', project: item(id) })
const selection = (projectId: string | null, initialChatId: string | null = null) => ({
  projectId,
  initialChatId,
})
const ok = { status: 'ok' }
const unwritable = { status: 'unwritable' }
const settings = { memoryEnabled: true, readAgentsFiles: false }
const prompt = (over: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  name: 'Report',
  folderPath: ROOT,
  instructions: null,
  memory: null,
  agents: null,
  claude: null,
  foreignChats: [],
  ...over,
})
const asks = (use: unknown, over: Record<string, unknown> = {}) => ({
  $ask: prompt(over),
  null: { status: 'cancelled', stage: 'trust' },
  use,
  without: use,
})
const chatItem = (id: string) => ({
  id,
  title: id,
  updatedAt: NOW0,
  lastEditor: 'docs',
  foreign: false,
})
const detail = (id: string) => ({
  project: item(id),
  trust: 'use',
  settings,
  instructions: 'be brief',
  agents: null,
  claude: null,
  memory: '- a',
  memoryEntries: ['a'],
  memoryChars: 3,
  memoryConflictCopies: [],
})
const legacy = {
  chatId: 'old',
  updatedAt: NOW0,
  approxCount: 3,
  projectId: 'default',
}
const entry = (rel: string, mtimeMs: number, cloudOnly = false) => ({
  relPath: rel,
  ext: rel.slice(rel.lastIndexOf('.') + 1),
  sizeBytes: 10,
  mtimeMs,
  cloudOnly,
})
const ref = (chatId = 'c1', projectId = 'p1') => ({ projectId, chatId })
const message = (seq: number) => ({ seq, role: 'user', text: `m${seq}` })
const appended = (chatId = 'c1', seq = 1, projectId = 'p1') => ({
  projectId,
  chatId,
  message: message(seq),
})

const BASE_ANSWERS: Record<string, Json> = {
  'guide.listProjects': [item('p1'), item('p2', { pinned: true })],
  'guide.addFolder': asks(added('p1')),
  'guide.relocateProject': added('p1', 'moved'),
  'guide.getDefaultParentFolder': '/home/u/Documents/App',
  'guide.createProject': created('p2'),
  'guide.renameProject': ok,
  'guide.retryUnwritable': ok,
  'guide.projectRoot': { $on: '#0', map: { p1: ROOT }, default: null },
  'guide.getSelection': {
    $on: 'kind',
    map: { home: selection(null), document: selection('p1'), untitled: selection(null) },
  },
  'guide.setSelection': {
    $on: '#1',
    map: { p1: selection('p1'), null: selection(null) },
    default: selection('p2'),
  },
  'guide.adoptFolderHint': asks(added('p1')),
  'guide.readContext': { status: 'missing' },
  'guide.editMemory': { status: 'ok', change: { op: 'add', text: 'x' } },
  'guide.saveMemory': ok,
  'guide.applyMemoryConsolidation': {
    status: 'ok',
    before: 3,
    after: 2,
    backupName: 'memory.20260101-000000.bak.md',
  },
  'guide.undoMemoryConsolidation': { status: 'ok', entries: 2 },
  'guide.getProjectDetail': detail('p1'),
  'guide.getSettings': settings,
  'guide.setSettings': settings,
  'guide.decideTrust': {
    $ask: prompt(),
    null: { status: 'cancelled' },
    use: { status: 'ok', trust: 'use' },
    without: { status: 'ok', trust: 'without' },
  },
  'guide.saveInstructions': ok,
  'guide.addIgnore': ok,
  'guide.removeIgnore': ok,
  'guide.aiVisibility': null,
  'chats.newChat': { chatId: 'c9' },
  'chats.listChats': [chatItem('c1'), chatItem('c2')],
  'chats.openChat': { status: 'ok', info: { id: 'c1' }, messages: [message(1)], foreign: false },
  'chats.append': { status: 'saved', message: message(2) },
  'chats.renameChat': ok,
  'chats.deleteChat': ok,
  'chats.attachDocument': ok,
  'chats.chatForDocument': 'c-doc',
  'chats.chatInfo': { documents: ['draft.docx'], lastEditor: 'docs' },
  'tools.openScope': 'scope-1',
  'tools.listFiles': { files: [entry('a.docx', 1000)], total: 1 },
  'tools.search': { hits: [], total: 0 },
  'tools.read': { status: 'refused', reason: 'outside' },
  'scopes.projectOf': 'p1',
  'dialogs.pickFolder': '$DIR/picked',
  'dialogs.confirmUseExisting': true,
  'dialogs.askTrust': 'use',
  'dialogs.waitForReturn': true,
  'host.legacyChatFor': legacy,
  'host.openDocument': 50,
  'host.showHome': HOME,
}

const BASE_WINDOWS: Record<string, Json> = {
  [HOME]: { kind: 'home' },
  [DOCS]: { kind: 'editor', editor: 'docs', docPath: DOC },
  [SHEETS]: { kind: 'editor', editor: 'sheets', docPath: '$DIR/elsewhere/notes.xlsx' },
  [UNTITLED]: { kind: 'editor', editor: 'markdown', docPath: null },
  [EMPTY_DOC]: { kind: 'editor', editor: 'docs', docPath: '' },
  [PDF]: { kind: 'editor', editor: 'pdf', docPath: `${ROOT}/sub/a.pdf` },
}

interface Over {
  answers?: Record<string, Json>
  windows?: Record<string, Json>
  gone?: number[]
  cloud?: World['cloud']
  platform?: string | null
}

const makeWorld = (over: Over, ops: Op[]): World => ({
  platform: over.platform === undefined ? 'linux' : over.platform,
  windows: { ...BASE_WINDOWS, ...over.windows },
  gone: over.gone ?? [],
  answers: { ...BASE_ANSWERS, ...over.answers },
  cloud: over.cloud ?? null,
  ops,
})

const call = (name: string, sender: number, raw?: Json): Op =>
  raw === undefined ? { op: 'call', name, sender } : { op: 'call', name, sender, raw }
const listen = (sender: number, method: Json, on: Json = true): Op => ({
  op: 'listen',
  sender,
  method,
  on,
})
const listenAll = (sender: number): Op[] =>
  ['onChatMessageAppended', 'onOpenChat', 'onOpenProjectScreen', 'onProjectChanged'].map((m) =>
    listen(sender, m),
  )
const op = (name: string, sender: number): Op => ({ op: name, sender })
const set = (extra: Omit<Op, 'op'>): Op => ({ op: 'set', ...extra })

const scenarioCase = (over: Over, ops: Op[], files: Case['files'] = {}, note?: string): Case => ({
  args: [makeWorld(over, ops)],
  files: { proj: { dir: true }, ...files },
  ...(note === undefined ? {} : { note }),
})

type Before = Op[] & { before?: true }

/** operations that run before the call of a handler (a list tagged for `h`'s `after`) */
const before = (...ops: Op[]): Before => Object.assign(ops, { before: true as const })

/**
 * one call of a handler (args `[world, sender, raw?, after?, lead?]`): the
 * operations of `lead` run first, then the call, then those of `after`. An
 * `after` made by `before(...)` is a `lead`.
 */
const h = (
  over: Over,
  sender: number,
  raw?: Json,
  after: Before = [],
  files: Case['files'] = {},
  note?: string,
  pre: Op[] = [],
): Case => {
  const lead = after.before ? [...after, ...pre] : pre
  const tail = after.before ? [] : after
  return {
    args:
      raw === undefined && tail.length === 0 && lead.length === 0
        ? [makeWorld(over, []), sender]
        : [makeWorld(over, []), sender, raw ?? null, tail, lead],
    files: { proj: { dir: true }, ...files },
    ...(note === undefined ? {} : { note }),
  }
}
/** the same with a note first, for readability at the call sites */
const n = (note: string, c: Case): Case => ({ ...c, note })

const handlerFn = (name: string, cases: Case[]): FnSpec => ({
  ts: (args, cx) => {
    const [base, sender, raw, after, lead] = args as [
      World,
      number,
      Json,
      Op[] | undefined,
      Op[] | undefined,
    ]
    const first = args.length > 2 ? call(name, sender, raw) : call(name, sender)
    return runScenario({ ...base, ops: [...(lead ?? []), first, ...(after ?? [])] }, cx)
  },
  cases,
})

const P1 = { projectId: 'p1' }
const BAD = 'invalid project folder request'
const sent = (target: number, channel: string, payload: Json) => [
  'host',
  'send',
  target,
  channel,
  payload,
]

// ---------------------------------------------------------------------------
// handler cases
// ---------------------------------------------------------------------------

const instructionsPrompt = prompt({
  instructions: 'follow these',
  memory: '- m',
  agents: 'agents text',
  claude: null,
  foreignChats: [{ id: 'f1', title: 'other pc', updatedAt: NOW0 }],
})

const listProjects = handlerFn('listProjects', [
  h({}, HOME),
  h({ answers: { 'guide.listProjects': [] } }, STRANGER, { ignored: true }),
  h({ answers: { 'guide.listProjects': { $throw: 'store down' } } }, HOME),
])

const addFolder = handlerFn('addFolder', [
  n(
    'a closed picker cancels before the guide',
    h({ answers: { 'dialogs.pickFolder': null } }, HOME),
  ),
  n('an empty path is no pick', h({ answers: { 'dialogs.pickFolder': '' } }, HOME)),
  n('added: the list changed', h({}, HOME)),
  n(
    'the trust question answered no is cancelled at the trust stage, nothing changed',
    h({ answers: { 'dialogs.askTrust': null } }, DOCS),
  ),
  n(
    'refused is neither added nor cancelled',
    h({ answers: { 'guide.addFolder': { status: 'refused', reason: 'drive-root' } } }, HOME),
  ),
  n(
    '[view all] opens the quoted files, waits for the person, then asks again',
    h(
      {
        answers: {
          'guide.addFolder': asks(added('p1'), instructionsPrompt as never),
          'dialogs.askTrust': { $seq: ['view', 'without'] },
          'host.openDocument': { $seq: [50, null, 51] },
        },
      },
      HOME,
      undefined,
      [],
      { 'proj/.seuoffice': { dir: true } },
    ),
  ),
  n(
    '[view all] with nothing opened in the app does not wait, and asks again',
    h(
      {
        answers: {
          'guide.addFolder': asks(added('p1'), instructionsPrompt as never),
          'dialogs.askTrust': { $seq: ['view', 'use'] },
          'host.openDocument': null,
        },
      },
      HOME,
    ),
  ),
  n(
    'the page gone while [view all] waited cancels the addition',
    h(
      {
        answers: {
          'guide.addFolder': asks(added('p1'), instructionsPrompt as never),
          // a second question (only a fault asks it) gets a closed box, so a
          // fault that loops back to the question ends instead of hanging
          'dialogs.askTrust': { $seq: ['view', null] },
          'dialogs.waitForReturn': false,
        },
      },
      HOME,
    ),
  ),
  n(
    'the chats folder that cannot open is ignored',
    h(
      {
        answers: {
          'guide.addFolder': asks(added('p1'), {
            foreignChats: [{ id: 'f1', title: 't', updatedAt: NOW0 }],
          }),
          'dialogs.askTrust': { $seq: ['view', 'use'] },
          'host.openFolder': { $throw: 'no explorer' },
        },
      },
      HOME,
    ),
  ),
  n(
    'an older data folder names the files of the prompt',
    h(
      {
        answers: {
          'guide.addFolder': asks(added('p1'), {
            instructions: 'i',
            claude: 'c',
            foreignChats: [{ id: 'f1', title: 't', updatedAt: NOW0 }],
          }),
          'dialogs.askTrust': { $seq: ['view', 'use'] },
        },
      },
      HOME,
      undefined,
      [],
      {
        'proj/.ieumoffice': { dir: true },
        'proj/.ieumoffice/chats': { dir: true },
        'proj/.ieumoffice/x.md': 'x',
      },
    ),
  ),
  n('the guide throws', h({ answers: { 'guide.addFolder': { $throw: 'unknown project' } } }, HOME)),
  n('the picker throws', h({ answers: { 'dialogs.pickFolder': { $throw: 'no display' } } }, HOME)),
])

const getDefaultParentFolder = handlerFn('getDefaultParentFolder', [
  h({}, HOME),
  h({ answers: { 'guide.getDefaultParentFolder': { $throw: 'no documents' } } }, HOME),
])

const createProject = handlerFn('createProject', [
  n('no name', h({}, HOME, {})),
  n('a name that is not text', h({}, HOME, { name: 7 })),
  n(
    'a name of white space only (a byte order mark included)',
    h({}, HOME, { name: ' \u00a0\ufeff ' }),
  ),
  n('a request that is not an object', h({}, HOME, null)),
  n('a request that is a list', h({}, HOME, ['Report'])),
  n('created: the list changed, the name trimmed', h({}, HOME, { name: '  Report  ' })),
  n(
    'a path in the request is never read',
    h({}, HOME, { name: 'Report', parentDir: '/evil', useExisting: true }),
  ),
  n('"true" is not otherPlace', h({}, HOME, { name: 'Report', otherPlace: 'true' })),
  n(
    "otherPlace picks the parent in main's own picker",
    h({}, HOME, { name: 'Report', otherPlace: true }),
  ),
  n(
    'otherPlace with the picker closed',
    h({ answers: { 'dialogs.pickFolder': null } }, HOME, { name: 'Report', otherPlace: true }),
  ),
  n(
    'otherPlace with an empty pick',
    h({ answers: { 'dialogs.pickFolder': '' } }, HOME, { name: 'Report', otherPlace: true }),
  ),
  n(
    'a folder that exists: asked, then the same request with useExisting',
    h(
      {
        answers: {
          'guide.createProject': {
            $seq: [{ status: 'exists', folderPath: '/x/Report' }, added('p2')],
          },
        },
      },
      HOME,
      { name: 'Report', otherPlace: true },
    ),
  ),
  n(
    'a folder that exists and the person says no',
    h(
      {
        answers: {
          'guide.createProject': { status: 'exists', folderPath: '/x/Report' },
          'dialogs.confirmUseExisting': false,
        },
      },
      HOME,
      { name: 'Report' },
    ),
  ),
  n(
    'the second answer is not an addition: nothing changed',
    h(
      {
        answers: {
          'guide.createProject': {
            $seq: [{ status: 'exists', folderPath: '/x/Report' }, { status: 'unwritable' }],
          },
        },
      },
      HOME,
      { name: 'Report' },
    ),
  ),
  n(
    'unwritable, invalid-name and refused answers do not change the list',
    h({ answers: { 'guide.createProject': { status: 'invalid-name' } } }, HOME, { name: 'Report' }),
  ),
  n(
    'the guide asks the trust question while creating',
    h({ answers: { 'guide.createProject': asks(added('p2')) } }, DOCS, { name: 'Report' }),
  ),
  n(
    'the question to use the folder throws',
    h(
      {
        answers: {
          'guide.createProject': { status: 'exists', folderPath: '/x/Report' },
          'dialogs.confirmUseExisting': { $throw: 'dialog gone' },
        },
      },
      HOME,
      { name: 'Report' },
    ),
  ),
])

const listening = (sender: number): Before => before(listen(sender, 'onProjectChanged'))

const removeFromList = handlerFn('removeFromList', [
  n(
    'the list changed and every listening window hears it, the sender too',
    h(
      {},
      HOME,
      P1,
      before(
        listen(HOME, 'onProjectChanged'),
        listen(DOCS, 'onProjectChanged'),
        listen(SHEETS, 'onOpenChat'),
      ),
    ),
  ),
  n('no id', h({}, HOME, {})),
  n('an id that is not valid', h({}, HOME, { projectId: 'a b' })),
  n('an empty id', h({}, HOME, { projectId: '' })),
  n('an id that is a number', h({}, HOME, { projectId: 7 })),
  n('a request that is not an object', h({}, HOME, 'p1')),
  n(
    'the guide throws: nothing changed, nothing announced',
    h(
      { answers: { 'guide.removeFromList': { $throw: 'unknown project p1' } } },
      HOME,
      P1,
      listening(HOME),
    ),
  ),
  n(
    'a window that is gone when it is told is forgotten',
    h(
      { gone: [DOCS] },
      HOME,
      P1,
      [call('removeFromList', HOME, P1), call('removeFromList', HOME, P1)],
      {},
      undefined,
      [...listening(DOCS), ...listening(HOME)],
    ),
  ),
])

const setPinned = handlerFn('setPinned', [
  h({}, HOME, { projectId: 'p1', pinned: true }, listening(HOME)),
  h({}, HOME, { projectId: 'p1', pinned: false }),
  n('a flag that is a string', h({}, HOME, { projectId: 'p1', pinned: 'true' })),
  n('no flag', h({}, HOME, P1)),
  n('no id', h({}, HOME, { pinned: true })),
  n(
    'the guide throws',
    h(
      { answers: { 'guide.setPinned': { $throw: 'unknown project p1' } } },
      HOME,
      { projectId: 'p1', pinned: true },
      listening(HOME),
    ),
  ),
])

const renameProject = handlerFn('renameProject', [
  n('ok is announced', h({}, HOME, { projectId: 'p1', name: 'New' }, listening(HOME))),
  n(
    'unwritable is not',
    h(
      { answers: { 'guide.renameProject': unwritable } },
      HOME,
      { projectId: 'p1', name: 'New' },
      listening(HOME),
    ),
  ),
  n('a name that is not text never reaches the guide', h({}, HOME, { projectId: 'p1', name: 3 })),
  n('no id', h({}, HOME, { name: 'New' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.renameProject': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      name: 'New',
    }),
  ),
])

const relocateProject = handlerFn('relocateProject', [
  n('added: the list changed', h({}, HOME, P1)),
  n('the picker closed', h({ answers: { 'dialogs.pickFolder': null } }, HOME, P1)),
  n('no id: no picker', h({}, HOME, {})),
  n(
    'not added: the list did not change',
    h(
      { answers: { 'guide.relocateProject': { status: 'refused', reason: 'not-a-folder' } } },
      HOME,
      P1,
    ),
  ),
  n(
    'the trust question answered no',
    h(
      {
        answers: { 'guide.relocateProject': asks(added('p1', 'moved')), 'dialogs.askTrust': null },
      },
      DOCS,
      P1,
    ),
  ),
  n(
    'the guide throws',
    h({ answers: { 'guide.relocateProject': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const openInFileManager = handlerFn('openInFileManager', [
  n('the folder opens', h({}, HOME, P1)),
  n('a project that is not listed', h({}, HOME, { projectId: 'zz' })),
  n('an empty root opens nothing', h({ answers: { 'guide.projectRoot': '' } }, HOME, P1)),
  n('no id', h({}, HOME, {})),
  n(
    'the file manager fails',
    h({ answers: { 'host.openFolder': { $throw: 'no handler' } } }, HOME, P1),
  ),
])

const retryUnwritable = handlerFn('retryUnwritable', [
  h({}, HOME, P1),
  h({ answers: { 'guide.retryUnwritable': unwritable } }, HOME, P1),
  n('an id that is not valid', h({}, HOME, { projectId: '../x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.retryUnwritable': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const getSelection = handlerFn('getSelection', [
  n('the home panel', h({}, HOME)),
  n('a saved document: the guide asked for its path, the chat for the document found', h({}, DOCS)),
  n('a chat the document has none of', h({ answers: { 'chats.chatForDocument': null } }, DOCS)),
  n(
    'a document of no project has no chat asked for',
    h({ answers: { 'guide.getSelection': selection(null) } }, DOCS),
  ),
  n(
    'an untitled window: the preset of a create flow',
    h(
      { answers: { 'host.presetProjectOf': 'p2', 'guide.getSelection': selection('p2') } },
      UNTITLED,
    ),
  ),
  n(
    'an untitled window with no preset',
    h({ answers: { 'host.presetProjectOf': null } }, UNTITLED),
  ),
  n('an untitled window where the shell passes no preset', h({}, UNTITLED)),
  n(
    'the preset throws',
    h({ answers: { 'host.presetProjectOf': { $throw: 'preset failed' } } }, UNTITLED),
  ),
  n('a window with an empty document path is untitled', h({}, EMPTY_DOC)),
  n('a window that is not an AI window', h({}, STRANGER)),
  n('the guide throws', h({ answers: { 'guide.getSelection': { $throw: 'folder gone' } } }, HOME)),
  n(
    'the chat store throws',
    h({ answers: { 'chats.chatForDocument': { $throw: 'chat store down' } } }, DOCS),
  ),
  n(
    'a selection with a hint keeps it and the chat',
    h(
      {
        answers: {
          'guide.getSelection': {
            projectId: 'p1',
            initialChatId: null,
            unregisteredProjectHint: { name: 'n', folderPath: '/f' },
          },
        },
      },
      DOCS,
    ),
  ),
])

const setSelection = handlerFn('setSelection', [
  n('a project', h({}, HOME, P1)),
  n('no project', h({}, HOME, { projectId: null }, [call('listChats', HOME, P1)])),
  n(
    'a project of an untitled window is kept for it',
    h({}, UNTITLED, P1, [op('untitledProject', UNTITLED), call('getSelection', UNTITLED)]),
  ),
  n(
    'no project of an untitled window is kept as null',
    h({}, UNTITLED, { projectId: null }, [
      op('untitledProject', UNTITLED),
      call('getSelection', UNTITLED),
    ]),
  ),
  n('a document: its chat is found', h({}, DOCS, P1)),
  n('no key is not null', h({}, HOME, {})),
  n('an id that is not valid', h({}, HOME, { projectId: 'a/b' })),
  n('an id that is a number', h({}, HOME, { projectId: 5 })),
  n('a window that is not an AI window', h({}, STRANGER, P1)),
  n(
    'the guide throws and nothing is kept',
    h({ answers: { 'guide.setSelection': { $throw: 'unknown project p1' } } }, UNTITLED, P1, [
      op('untitledProject', UNTITLED),
    ]),
  ),
  n(
    'the project the guide answers is the one chosen',
    h({}, UNTITLED, { projectId: 'p7' }, [op('windowProject', UNTITLED)]),
  ),
])

const adoptFolderHint = handlerFn('adoptFolderHint', [
  n('a window with no saved document', h({}, HOME)),
  n('an untitled window', h({}, UNTITLED)),
  n('an empty document path', h({}, EMPTY_DOC)),
  n('added: the list changed', h({}, DOCS)),
  n('the trust question answered no', h({ answers: { 'dialogs.askTrust': null } }, DOCS)),
  n('a window that is not an AI window', h({}, STRANGER)),
  n(
    'the guide throws',
    h({ answers: { 'guide.adoptFolderHint': { $throw: 'not a folder' } } }, DOCS),
  ),
])

const readContext = handlerFn('readContext', [
  h({}, HOME, P1),
  h({ answers: { 'guide.readContext': { status: 'unknown' } } }, HOME, P1),
  n('an id that is not valid', h({}, HOME, { projectId: '' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.readContext': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const passThrough = (name: string, other: Json): FnSpec =>
  handlerFn(name, [
    n('the request goes through as it is', h({}, DOCS, { scope: 's1', query: 'q', offset: 0 })),
    n('no request', h({}, HOME)),
    n('a request that is text', h({}, HOME, 'scope')),
    n('another answer', h({ answers: { [`tools.${name}`]: other } }, SHEETS, { scope: 's2' })),
    n(
      'the tools throw',
      h({ answers: { [`tools.${name}`]: { $throw: 'project scope is not open' } } }, DOCS, {
        scope: 's1',
      }),
    ),
  ])

const openScope = passThrough('openScope', 'scope-2')
const listFiles = passThrough('listFiles', { files: [], total: 0 })
const search = passThrough('search', {
  hits: [
    {
      relPath: 'a.docx',
      name: 'a.docx',
      ext: 'docx',
      mtimeMs: 1000,
      cloudOnly: false,
      snippet: 's',
    },
  ],
  total: 1,
})
const read = passThrough('read', { status: 'ok', text: 't', totalChars: 1, offset: 0 })
const closeScope = handlerFn('closeScope', [
  n('the request goes through; the answer is nothing', h({}, DOCS, { scope: 's1' })),
  n('no request', h({}, HOME)),
  n('another window', h({}, SHEETS, { scope: 's3' })),
])

const remember = handlerFn('remember', [
  n(
    "the project is the scope's: announced as memory",
    h({}, DOCS, { scope: 's1', change: { op: 'add', text: 'x' } }, listening(HOME)),
  ),
  n('no scope in the request', h({}, DOCS, { change: { op: 'add', text: 'x' } })),
  n(
    'a scope that is null is still a scope',
    h({ answers: { 'scopes.projectOf': null } }, DOCS, {
      scope: null,
      change: { op: 'add', text: 'x' },
    }),
  ),
  n(
    'the scope names no project',
    h({ answers: { 'scopes.projectOf': null } }, DOCS, {
      scope: 's1',
      change: { op: 'add', text: 'x' },
    }),
  ),
  n(
    'an empty project',
    h({ answers: { 'scopes.projectOf': '' } }, DOCS, {
      scope: 's1',
      change: { op: 'add', text: 'x' },
    }),
  ),
  n(
    'a scope main does not hold',
    h({ answers: { 'scopes.projectOf': { $throw: 'knowledge-base scope is not open' } } }, DOCS, {
      scope: 's1',
      change: { op: 'add', text: 'x' },
    }),
  ),
  n('a change that is not valid', h({}, DOCS, { scope: 's1', change: { op: 'drop', text: 'x' } })),
  n('no change', h({}, DOCS, { scope: 's1' })),
  n(
    'a refusal is not announced',
    h(
      { answers: { 'guide.editMemory': { status: 'refused', reason: 'disabled' } } },
      DOCS,
      { scope: 's1', change: { op: 'add', text: 'x' } },
      listening(HOME),
    ),
  ),
  n('a request that is not an object', h({}, DOCS, 's1')),
  n(
    'the guide throws',
    h({ answers: { 'guide.editMemory': { $throw: 'unknown project p1' } } }, DOCS, {
      scope: 's1',
      change: { op: 'remove', text: 'x' },
    }),
  ),
])

const editMemory = handlerFn('editMemory', [
  n(
    'add, announced',
    h({}, HOME, { projectId: 'p1', change: { op: 'add', text: 'a' } }, listening(HOME)),
  ),
  n('remove', h({}, HOME, { projectId: 'p1', change: { op: 'remove', text: 'a' } })),
  n(
    'replace',
    h({}, HOME, { projectId: 'p1', change: { op: 'replace', old: 'a', new: 'b', extra: 1 } }),
  ),
  n('an add without text', h({}, HOME, { projectId: 'p1', change: { op: 'add' } })),
  n('an add with a number', h({}, HOME, { projectId: 'p1', change: { op: 'add', text: 1 } })),
  n('a remove without text', h({}, HOME, { projectId: 'p1', change: { op: 'remove' } })),
  n(
    'a replace without the new text',
    h({}, HOME, { projectId: 'p1', change: { op: 'replace', old: 'a' } }),
  ),
  n(
    'a replace without the old text',
    h({}, HOME, { projectId: 'p1', change: { op: 'replace', new: 'a' } }),
  ),
  n('an op that is not known', h({}, HOME, { projectId: 'p1', change: { op: 'wipe' } })),
  n('a change that is a string', h({}, HOME, { projectId: 'p1', change: 'add' })),
  n('no change', h({}, HOME, P1)),
  n('no id', h({}, HOME, { change: { op: 'add', text: 'a' } })),
  n(
    'refused: not announced',
    h(
      { answers: { 'guide.editMemory': { status: 'refused', reason: 'unwritable' } } },
      HOME,
      { projectId: 'p1', change: { op: 'add', text: 'a' } },
      listening(HOME),
    ),
  ),
  n(
    'the guide throws',
    h({ answers: { 'guide.editMemory': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      change: { op: 'add', text: 'a' },
    }),
  ),
])

const saveMemory = handlerFn('saveMemory', [
  n('announced', h({}, HOME, { projectId: 'p1', text: '- a' }, listening(HOME))),
  n('empty text is text', h({}, HOME, { projectId: 'p1', text: '' })),
  n('text that is not text', h({}, HOME, { projectId: 'p1', text: 4 })),
  n(
    'unwritable: not announced',
    h(
      { answers: { 'guide.saveMemory': unwritable } },
      HOME,
      { projectId: 'p1', text: 'x' },
      listening(HOME),
    ),
  ),
  n('no id', h({}, HOME, { text: 'x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.saveMemory': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      text: 'x',
    }),
  ),
])

const applyMemoryConsolidation = handlerFn('applyMemoryConsolidation', [
  n('announced', h({}, HOME, { projectId: 'p1', entries: ['a', 'b'] }, listening(HOME))),
  n(
    'entries that are not text go to the guide as they are',
    h({}, HOME, { projectId: 'p1', entries: ['a', 2, null, { k: 1 }] }),
  ),
  n('no entries', h({}, HOME, P1)),
  n('entries that are not a list', h({}, HOME, { projectId: 'p1', entries: 'a' })),
  n('no id', h({}, HOME, { entries: [] })),
  n(
    'unwritable: not announced',
    h(
      { answers: { 'guide.applyMemoryConsolidation': unwritable } },
      HOME,
      { projectId: 'p1', entries: [] },
      listening(HOME),
    ),
  ),
  n(
    'the guide throws',
    h(
      {
        answers: {
          'guide.applyMemoryConsolidation': { $throw: 'entries must be a list of strings' },
        },
      },
      HOME,
      { projectId: 'p1', entries: [1] },
    ),
  ),
])

const undoMemoryConsolidation = handlerFn('undoMemoryConsolidation', [
  n(
    'announced',
    h({}, HOME, { projectId: 'p1', backupName: 'memory.20260101-000000.bak.md' }, listening(HOME)),
  ),
  n(
    'no backup: not announced',
    h(
      { answers: { 'guide.undoMemoryConsolidation': { status: 'no-backup' } } },
      HOME,
      { projectId: 'p1', backupName: 'x' },
      listening(HOME),
    ),
  ),
  n('a name that is not text', h({}, HOME, { projectId: 'p1', backupName: 1 })),
  n('no id', h({}, HOME, { backupName: 'x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.undoMemoryConsolidation': { $throw: 'invalid backup' } } }, HOME, {
      projectId: 'p1',
      backupName: 'x',
    }),
  ),
])

const listChats = handlerFn('listChats', [
  n('a document window brings its earlier chat', h({}, DOCS, P1)),
  n('the home panel has none', h({}, HOME, P1)),
  n('an untitled window has none', h({}, UNTITLED, P1)),
  n('an empty document path has none', h({}, EMPTY_DOC, P1)),
  n('no earlier chat', h({ answers: { 'host.legacyChatFor': null } }, DOCS, P1)),
  n(
    'the lookup throws: none',
    h({ answers: { 'host.legacyChatFor': { $throw: 'bad file' } } }, DOCS, P1),
  ),
  n('no chats', h({ answers: { 'chats.listChats': [] } }, HOME, P1)),
  n('a window that is not an AI window', h({}, STRANGER, P1)),
  n('an id that is not valid: the window is not asked', h({}, STRANGER, { projectId: '.' })),
  n(
    'the chat store throws',
    h({ answers: { 'chats.listChats': { $throw: 'project is not listed' } } }, HOME, P1),
  ),
])

const newChat = handlerFn('newChat', [
  n(
    'the window shows the new chat: a message another window records reaches it',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c9') }],
            then: { status: 'saved', message: message(1) },
          },
        },
      },
      HOME,
      P1,
      [
        ...listenAll(HOME),
        call('appendChat', DOCS, { projectId: 'p1', chatId: 'c9', role: 'user', text: 'hi' }),
      ],
    ),
  ),
  n('another id', h({ answers: { 'chats.newChat': { chatId: 'c-other' } } }, HOME, P1)),
  n('an id that is not valid', h({}, HOME, { projectId: 'p 1' })),
  n('no request', h({}, HOME)),
  n(
    'the chat store throws',
    h({ answers: { 'chats.newChat': { $throw: 'invalid project id' } } }, HOME, P1),
  ),
])

const openChat = handlerFn('openChat', [
  n('a limit', h({}, HOME, { projectId: 'p1', chatId: 'c1', limit: 5 })),
  n('a limit that is text is left out', h({}, HOME, { projectId: 'p1', chatId: 'c1', limit: '5' })),
  n('no limit', h({}, HOME, ref())),
  n('extra keys are left out', h({}, HOME, { chatId: 'c1', projectId: 'p1', other: true })),
  n(
    'not found: the window shows nothing',
    h({ answers: { 'chats.openChat': { status: 'not-found' } } }, HOME, ref()),
  ),
  n(
    'the window now shows the chat',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c1') }],
            then: { status: 'saved', message: message(1) },
          },
        },
      },
      HOME,
      ref(),
      [
        ...listenAll(HOME),
        call('appendChat', DOCS, { projectId: 'p1', chatId: 'c1', role: 'user', text: 'hi' }),
      ],
    ),
  ),
  n('no chat id', h({}, HOME, P1)),
  n('a chat id that is not valid', h({}, HOME, { projectId: 'p1', chatId: 'c/1' })),
  n(
    'the chat store throws',
    h({ answers: { 'chats.openChat': { $throw: 'invalid chat id' } } }, HOME, ref()),
  ),
])

const appendRaw = { projectId: 'p1', chatId: 'c1', role: 'user', text: 'hello' }
const appendChat = handlerFn('appendChat', [
  n(
    'saved: announced as chats; the sender is the home panel',
    h({}, HOME, appendRaw, listening(HOME)),
  ),
  n('a document window: its editor and path', h({}, DOCS, appendRaw)),
  n('an untitled window', h({}, UNTITLED, appendRaw)),
  n(
    'pending is not announced',
    h(
      { answers: { 'chats.append': { status: 'pending', message: message(3) } } },
      DOCS,
      appendRaw,
      listening(HOME),
    ),
  ),
  n('unwritable', h({ answers: { 'chats.append': unwritable } }, DOCS, appendRaw)),
  n(
    'keys of the request keep their order, the ids win',
    h(
      {},
      DOCS,
      { text: 'x', chatId: 'zz', role: 'assistant', tools: [], projectId: 'p1', extra: { a: 1 } },
      [],
    ),
  ),
  n('the ids put in a request without them', h({}, DOCS, { projectId: 'p1', chatId: 'c1' })),
  n('a request that has no valid ids', h({}, DOCS, { projectId: 'p1', chatId: '' })),
  n('a window that is not an AI window', h({}, STRANGER, appendRaw)),
  n(
    'the other windows showing the chat hear the message, not the sender',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c1') }],
            then: { status: 'saved', message: message(1) },
          },
        },
      },
      DOCS,
      appendRaw,
      [
        ...listenAll(HOME),
        ...listenAll(DOCS),
        call('openChat', HOME, ref()),
        call('openChat', SHEETS, ref()),
        call('openChat', DOCS, ref()),
      ],
    ),
  ),
  n(
    'the chat store throws',
    h({ answers: { 'chats.append': { $throw: 'invalid role' } } }, DOCS, appendRaw),
  ),
  n(
    'the store throws after its listener heard the message',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c1') }],
            then: { $throw: 'invalid role' },
          },
        },
      },
      DOCS,
      appendRaw,
      [call('openChat', HOME, ref())],
    ),
  ),
])

const renameChat = handlerFn('renameChat', [
  n(
    'announced as chats',
    h({}, HOME, { projectId: 'p1', chatId: 'c1', title: 'New' }, listening(HOME)),
  ),
  n(
    'unwritable is not',
    h(
      { answers: { 'chats.renameChat': unwritable } },
      HOME,
      { projectId: 'p1', chatId: 'c1', title: 'New' },
      listening(HOME),
    ),
  ),
  n(
    'a title that is not text never reaches the store',
    h({}, HOME, { projectId: 'p1', chatId: 'c1', title: 1 }),
  ),
  n(
    'a title with other keys of the request left out',
    h({}, HOME, { projectId: 'p1', chatId: 'c1', title: '', other: 1 }),
  ),
  n('no ids', h({}, HOME, { title: 'x' })),
  n(
    'the chat store throws',
    h({ answers: { 'chats.renameChat': { $throw: 'a chat title cannot be empty' } } }, HOME, {
      projectId: 'p1',
      chatId: 'c1',
      title: '',
    }),
  ),
])

const deleteChat = handlerFn('deleteChat', [
  n('announced as chats', h({}, HOME, ref(), listening(HOME))),
  n(
    'the window showing the chat stops showing it',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c1') }],
            then: { status: 'saved', message: message(1) },
          },
        },
      },
      HOME,
      ref(),
      [
        call('openChat', HOME, ref()),
        call('deleteChat', HOME, ref()),
        ...listenAll(DOCS),
        call('openChat', DOCS, ref()),
        call('appendChat', SHEETS, { ...ref(), role: 'user', text: 'x' }),
      ],
    ),
  ),
  n(
    'a window showing another chat keeps it',
    h(
      {
        answers: {
          'chats.append': {
            $events: [{ event: appended('c1') }],
            then: { status: 'saved', message: message(1) },
          },
        },
      },
      HOME,
      ref('c2'),
      [
        ...listenAll(HOME),
        call('openChat', HOME, ref('c1')),
        call('deleteChat', HOME, ref('c2')),
        call('appendChat', SHEETS, { ...ref('c1'), role: 'user', text: 'x' }),
      ],
    ),
  ),
  n(
    'unwritable: not announced, still shown',
    h({ answers: { 'chats.deleteChat': unwritable } }, HOME, ref(), listening(HOME)),
  ),
  n('no chat id', h({}, HOME, P1)),
  n(
    'the chat store throws',
    h({ answers: { 'chats.deleteChat': { $throw: 'project is not listed' } } }, HOME, ref()),
  ),
])

const attachDocument = handlerFn('attachDocument', [
  n('a document window: its path', h({}, DOCS, ref())),
  n('the home panel has no document: nothing attached', h({}, HOME, ref())),
  n('an untitled window', h({}, UNTITLED, ref())),
  n('an empty document path', h({}, EMPTY_DOC, ref())),
  n('unwritable', h({ answers: { 'chats.attachDocument': unwritable } }, DOCS, ref())),
  n('a window that is not an AI window', h({}, STRANGER, ref())),
  n('no chat id', h({}, DOCS, P1)),
  n(
    'the chat store throws',
    h(
      { answers: { 'chats.attachDocument': { $throw: 'expected an absolute document path' } } },
      DOCS,
      ref(),
    ),
  ),
])

const chatAt = (documents: string[], lastEditor = 'docs') => ({
  'chats.chatInfo': { documents, lastEditor },
})
const openDoc = (rel: string, over: Over = {}, extra: Op[] = []) =>
  h({ ...over, answers: { ...chatAt([rel]), ...over.answers } }, HOME, ref(), extra)
const openDocumentChat = handlerFn('openDocumentChat', [
  n('the latest document opens and hears the chat', h({}, HOME, ref(), [...listenAll(50)])),
  n('a chat that is not visible', h({ answers: { 'chats.chatInfo': null } }, HOME, ref())),
  n(
    'the latest of several documents',
    h({ answers: chatAt(['a.docx', 'sub/b.docx']) }, HOME, ref()),
  ),
  n(
    'a chat last used at home opens the home tab',
    h({ answers: chatAt(['draft.docx'], 'home') }, HOME, ref()),
  ),
  n('a chat with no document opens the home tab', h({ answers: chatAt([]) }, HOME, ref())),
  n(
    'a project with no folder opens the home tab',
    h({ answers: { 'guide.projectRoot': null } }, HOME, ref()),
  ),
  n('an empty folder opens the home tab', h({ answers: { 'guide.projectRoot': '' } }, HOME, ref())),
  n(
    'a document that does not open falls back to the home tab',
    h({ answers: { 'host.openDocument': null } }, HOME, ref()),
  ),
  n(
    'no home tab either: nothing is sent',
    h(
      { answers: { 'host.openDocument': null, 'host.showHome': null } },
      HOME,
      ref(),
      listenAll(HOME),
    ),
  ),
  n(
    'a window not listening yet is held for, and told when it listens',
    h({}, HOME, ref(), [listen(50, 'onOpenChat'), listen(50, 'onOpenChat')]),
  ),
  n(
    'the latest window of the same kind wins while held',
    h({ answers: { 'host.openDocument': 50 } }, HOME, ref('c1'), [
      call('openDocumentChat', HOME, ref('c2')),
      listen(50, 'onOpenChat'),
    ]),
  ),
  openDoc('../outside.docx'),
  openDoc('sub/../x.docx'),
  openDoc('./x.docx'),
  openDoc('/abs/x.docx'),
  openDoc('C:\\x.docx'),
  openDoc('c:x.docx'),
  openDoc(''),
  openDoc('//'),
  openDoc('sub\\deep//x.docx'),
  openDoc('a b/x y.docx'),
  openDoc('é.docx', { platform: 'darwin' }),
  n(
    'the window is not asked: a chat of a project with no AI window still opens',
    h({}, STRANGER, ref()),
  ),
  n('no chat id', h({}, HOME, P1)),
  n(
    'the chat store throws',
    h({ answers: { 'chats.chatInfo': { $throw: 'invalid chat id' } } }, HOME, ref()),
  ),
])

const getProjectDetail = handlerFn('getProjectDetail', [
  h({}, HOME, P1),
  h({ answers: { 'guide.getProjectDetail': detail('p2') } }, HOME, { projectId: 'p2' }),
  n('an id that is not valid', h({}, HOME, { projectId: ' ' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.getProjectDetail': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const getSettings = handlerFn('getSettings', [
  h({}, HOME, P1),
  h(
    { answers: { 'guide.getSettings': { memoryEnabled: false, readAgentsFiles: true } } },
    HOME,
    P1,
  ),
  n('no id', h({}, HOME, {})),
  n(
    'the guide throws',
    h({ answers: { 'guide.getSettings': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const setSettings = handlerFn('setSettings', [
  n(
    'both flags, announced',
    h(
      {},
      HOME,
      { projectId: 'p1', settings: { memoryEnabled: false, readAgentsFiles: true } },
      listening(HOME),
    ),
  ),
  n('one flag', h({}, HOME, { projectId: 'p1', settings: { readAgentsFiles: true } })),
  n(
    'a flag that is not a boolean is left out',
    h({}, HOME, {
      projectId: 'p1',
      settings: { memoryEnabled: 'yes', readAgentsFiles: 1, other: true },
    }),
  ),
  n('settings that are not an object', h({}, HOME, { projectId: 'p1', settings: [true] })),
  n('no settings', h({}, HOME, P1)),
  n(
    'announced whatever the answer',
    h(
      { answers: { 'guide.setSettings': { memoryEnabled: false, readAgentsFiles: false } } },
      HOME,
      { projectId: 'p1', settings: {} },
      listening(HOME),
    ),
  ),
  n('no id', h({}, HOME, { settings: {} })),
  n(
    'the guide throws: not announced',
    h(
      { answers: { 'guide.setSettings': { $throw: 'unknown project p1' } } },
      HOME,
      { projectId: 'p1', settings: {} },
      listening(HOME),
    ),
  ),
])

const decideTrust = handlerFn('decideTrust', [
  n(
    'use: the question is asked when the guide wants it, announced',
    h({}, DOCS, { projectId: 'p1', decision: 'use' }, listening(HOME)),
  ),
  n('without', h({}, DOCS, { projectId: 'p1', decision: 'without' })),
  n(
    'the question answered no',
    h(
      { answers: { 'dialogs.askTrust': null } },
      DOCS,
      { projectId: 'p1', decision: 'use' },
      listening(HOME),
    ),
  ),
  n(
    '[view all] then the answer',
    h(
      {
        answers: {
          'dialogs.askTrust': { $seq: ['view', 'use'] },
          'guide.decideTrust': {
            $ask: instructionsPrompt,
            null: { status: 'cancelled' },
            use: { status: 'ok', trust: 'use' },
          },
        },
      },
      DOCS,
      { projectId: 'p1', decision: 'use' },
    ),
  ),
  n('a decision that is not known', h({}, DOCS, { projectId: 'p1', decision: 'view' })),
  n('no decision', h({}, DOCS, P1)),
  n('no id', h({}, DOCS, { decision: 'use' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.decideTrust': { $throw: 'unknown project p1' } } }, DOCS, {
      projectId: 'p1',
      decision: 'use',
    }),
  ),
])

const saveInstructions = handlerFn('saveInstructions', [
  n(
    'announced as instructions',
    h({}, HOME, { projectId: 'p1', text: 'be brief' }, listening(HOME)),
  ),
  n(
    'unwritable',
    h(
      { answers: { 'guide.saveInstructions': unwritable } },
      HOME,
      { projectId: 'p1', text: '' },
      listening(HOME),
    ),
  ),
  n('text that is not text', h({}, HOME, { projectId: 'p1', text: null })),
  n('no id', h({}, HOME, { text: 'x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.saveInstructions': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      text: 'x',
    }),
  ),
])

const addIgnore = handlerFn('addIgnore', [
  n(
    'announced as settings',
    h({}, HOME, { projectId: 'p1', relPath: 'private/' }, listening(HOME)),
  ),
  n(
    'unwritable',
    h(
      { answers: { 'guide.addIgnore': unwritable } },
      HOME,
      { projectId: 'p1', relPath: 'x' },
      listening(HOME),
    ),
  ),
  n('a path that is not text', h({}, HOME, { projectId: 'p1', relPath: ['x'] })),
  n('no id', h({}, HOME, { relPath: 'x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.addIgnore': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      relPath: 'x',
    }),
  ),
])

const removeIgnore = handlerFn('removeIgnore', [
  n(
    'announced as settings',
    h({}, HOME, { projectId: 'p1', relPath: 'private/' }, listening(HOME)),
  ),
  n(
    'unwritable',
    h(
      { answers: { 'guide.removeIgnore': unwritable } },
      HOME,
      { projectId: 'p1', relPath: 'x' },
      listening(HOME),
    ),
  ),
  n('a path that is not text', h({}, HOME, { projectId: 'p1', relPath: 1 })),
  n('no id', h({}, HOME, { relPath: 'x' })),
  n(
    'the guide throws',
    h({ answers: { 'guide.removeIgnore': { $throw: 'unknown project p1' } } }, HOME, {
      projectId: 'p1',
      relPath: 'x',
    }),
  ),
])

const IGNORED_FILES: Case['files'] = {
  'proj/a.docx': { text: 'a', mtimeMs: 1_000_000 },
  'proj/secret/b.docx': { text: 'bb', mtimeMs: 2_000_000 },
  'proj/c.secret.xlsx': { text: 'ccc', mtimeMs: 3_000_000 },
  'proj/readme.unknown': 'x',
}
const visOf = (ignoreText: string) => ({ 'guide.aiVisibility': { root: ROOT, ignore: ignoreText } })
const listIgnoredFiles = handlerFn('listIgnoredFiles', [
  n('a project that is not listed: nothing', h({}, HOME, P1)),
  n(
    'the files the rule keeps from the AI, newest first, with no resolver',
    h({ answers: visOf('secret/\n*.secret.*') }, HOME, P1, [], IGNORED_FILES),
  ),
  n(
    'with a resolver: marked by it',
    h(
      {
        answers: visOf('secret/\n*.secret.*'),
        cloud: { answers: { '$DIR/proj/secret/b.docx': true, '$DIR/proj/c.secret.xlsx': false } },
      },
      HOME,
      P1,
      [],
      IGNORED_FILES,
    ),
  ),
  n(
    'a resolver that fails marks every file as not on this PC',
    h({ answers: visOf('secret/'), cloud: { fail: 'detector down' } }, HOME, P1, [], IGNORED_FILES),
  ),
  n(
    'a rule that ignores nothing lists nothing',
    h({ answers: visOf('') }, HOME, P1, [], IGNORED_FILES),
  ),
  n(
    'the resolver is not asked for no files',
    h({ answers: visOf(''), cloud: { answers: {} } }, HOME, P1, [], IGNORED_FILES),
  ),
  n('no id', h({}, HOME, {})),
  n(
    'the guide throws',
    h({ answers: { 'guide.aiVisibility': { $throw: 'unknown project p1' } } }, HOME, P1),
  ),
])

const openProjectScreen = handlerFn('openProjectScreen', [
  n(
    'the home tab hears it, with the instructions section',
    h({}, HOME, { projectId: 'p1', section: 'instructions' }, listenAll(HOME)),
  ),
  n('the memory section', h({}, HOME, { projectId: 'p1', section: 'memory' }, listenAll(HOME))),
  n(
    'a section that is not known is left out',
    h({}, HOME, { projectId: 'p1', section: 'chats' }, listenAll(HOME)),
  ),
  n('no section', h({}, HOME, P1, listenAll(HOME))),
  n(
    'held for a home tab that is not listening yet',
    h({}, HOME, { projectId: 'p1', section: 'memory' }, [listen(HOME, 'onOpenProjectScreen')]),
  ),
  n(
    'the latest request is the one held',
    h({}, HOME, { projectId: 'p1', section: 'memory' }, [
      call('openProjectScreen', HOME, { projectId: 'p2' }),
      listen(HOME, 'onOpenProjectScreen'),
    ]),
  ),
  n('no home tab', h({ answers: { 'host.showHome': null } }, HOME, P1, listenAll(HOME))),
  n('no id', h({}, HOME, {})),
  n(
    'the home tab is gone when told',
    h({ gone: [HOME] }, HOME, P1, [...listenAll(HOME), call('openProjectScreen', HOME, P1)]),
  ),
])

// ---------------------------------------------------------------------------
// scenarios: what the layer keeps between requests
// ---------------------------------------------------------------------------

const SAVED = {
  $events: [{ event: appended('c1') }],
  then: { status: 'saved', message: message(1) },
}
const post = (sender: number, chatId = 'c1', projectId = 'p1'): Op =>
  call('appendChat', sender, { projectId, chatId, role: 'user', text: 'hi' })

const scenarios: Case[] = [
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [
      ...listenAll(HOME),
      ...listenAll(SHEETS),
      call('openChat', HOME, ref()),
      call('openChat', SHEETS, ref()),
      post(DOCS),
    ],
    {},
    'a message reaches the windows showing the chat, not the sender',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [
      ...listenAll(HOME),
      call('openChat', HOME, ref()),
      call('openChat', HOME, ref('c2')),
      post(DOCS),
      post(DOCS, 'c2'),
    ],
    {},
    'a window shows one chat at a time',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [...listenAll(HOME), call('openChat', HOME, ref()), call('openChat', HOME, ref()), post(DOCS)],
    {},
    'opening the same chat twice leaves it shown once',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [
      ...listenAll(HOME),
      ...listenAll(SHEETS),
      call('openChat', HOME, ref()),
      call('openChat', SHEETS, ref()),
      call('openChat', HOME, ref()),
      post(DOCS),
    ],
    {},
    'a window opening the chat it shows keeps its place among the windows',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED }, gone: [HOME] },
    [
      ...listenAll(HOME),
      ...listenAll(SHEETS),
      call('openChat', HOME, ref()),
      call('openChat', SHEETS, ref()),
      post(DOCS),
      set({ gone: [] }),
      post(DOCS),
      call('openChat', HOME, ref()),
      post(DOCS),
    ],
    {},
    'a window that is gone is forgotten: it hears nothing more, and lost what it was told it listened to',
  ),
  scenarioCase(
    {
      answers: {
        'chats.append': {
          $events: [{ event: appended('c1'), key: 'x' }],
          then: { status: 'saved', message: message(1) },
        },
      },
    },
    [
      ...listenAll(HOME),
      ...listenAll(DOCS),
      call('openChat', HOME, ref()),
      call('openChat', DOCS, ref()),
      post(DOCS),
    ],
    {},
    "a key that is not the window's number is nobody's: every window shows it",
  ),
  scenarioCase(
    {
      answers: {
        'chats.append': {
          $events: [{ event: appended('c1'), key: null }],
          then: { status: 'saved', message: message(1) },
        },
      },
    },
    [call('openChat', HOME, ref()), call('openChat', DOCS, ref()), post(DOCS)],
    {},
    "a null key is nobody's too",
  ),
  scenarioCase(
    {
      answers: {
        'chats.append': {
          $events: [
            { event: appended('c1') },
            { event: appended('c1', 2) },
            { event: appended('other', 3) },
          ],
          then: { status: 'saved', message: message(1) },
        },
      },
    },
    [...listenAll(HOME), call('openChat', HOME, ref()), post(DOCS)],
    {},
    'every event is forwarded in order, to the windows showing its own chat',
  ),
  scenarioCase(
    {},
    [
      listen(HOME, 'onProjectChanged'),
      listen(DOCS, 'onProjectChanged'),
      listen(SHEETS, 'onOpenChat'),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
      listen(DOCS, 'onProjectChanged', false),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'y' }),
      listen(DOCS, 'onProjectChanged', 'true'),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'z' }),
      listen(DOCS, 'onProjectChanged', true),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'w' }),
    ],
    {},
    'a window hears a change while it listens to it; only true listens',
  ),
  scenarioCase(
    {},
    [
      listen(HOME, 'onNothing'),
      listen(HOME, 7),
      { op: 'listen', sender: HOME },
      { op: 'listen', sender: HOME, method: 'onProjectChanged' },
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
      listen(HOME, 'constructor'),
      listen(HOME, 'onProjectChangedAndMore'),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
      listen(HOME, 'onProjectChanged', 1),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
    ],
    {},
    'a method that is not one of the events is no listening; so is anything but true',
  ),
  scenarioCase(
    {},
    [
      call('openProjectScreen', HOME, { projectId: 'p1', section: 'memory' }),
      call('openProjectScreen', HOME, { projectId: 'p2' }),
      call('openDocumentChat', HOME, ref()),
      listen(50, 'onOpenChat'),
      listen(HOME, 'onOpenProjectScreen'),
      listen(HOME, 'onOpenProjectScreen'),
    ],
    {},
    'what is held for a window is the latest of each kind, told once when it listens',
  ),
  scenarioCase(
    { gone: [HOME] },
    [
      call('openProjectScreen', HOME, { projectId: 'p1' }),
      listen(HOME, 'onOpenProjectScreen', false),
      listen(HOME, 'onOpenProjectScreen'),
      call('openProjectScreen', HOME, { projectId: 'p2' }),
      listen(HOME, 'onOpenProjectScreen'),
      call('openProjectScreen', HOME, { projectId: 'p3' }),
      listen(HOME, 'onOpenProjectScreen'),
    ],
    {},
    'a held event for a window that is gone is lost, and the window forgotten',
  ),
  scenarioCase(
    {},
    [
      call('openProjectScreen', HOME, { projectId: 'p1' }),
      op('reset', HOME),
      listen(HOME, 'onOpenProjectScreen'),
      op('forget', HOME),
      listen(HOME, 'onOpenProjectScreen'),
    ],
    {},
    'a reload keeps what is held, a close forgets it',
  ),
  scenarioCase(
    {},
    [
      ...listenAll(HOME),
      op('reset', HOME),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
      ...listenAll(HOME),
      op('forget', HOME),
      call('saveInstructions', HOME, { projectId: 'p1', text: 'x' }),
    ],
    {},
    'reset and forget end the listening',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [
      ...listenAll(HOME),
      call('openChat', HOME, ref()),
      op('reset', HOME),
      post(DOCS),
      call('openChat', HOME, ref()),
      op('forget', HOME),
      post(DOCS),
    ],
    {},
    'reset and forget stop a window showing its chat',
  ),
  scenarioCase(
    {},
    [
      op('untitledProject', UNTITLED),
      call('setSelection', UNTITLED, { projectId: 'p1' }),
      op('untitledProject', UNTITLED),
      op('reset', UNTITLED),
      op('untitledProject', UNTITLED),
      call('setSelection', UNTITLED, { projectId: 'p1' }),
      op('forget', UNTITLED),
      op('untitledProject', UNTITLED),
      op('untitledProject', STRANGER),
    ],
    {},
    'the project an untitled window chose, until it reloads',
  ),
  scenarioCase(
    { answers: { 'host.presetProjectOf': 'p2' } },
    [
      call('getSelection', UNTITLED),
      call('setSelection', UNTITLED, { projectId: null }),
      call('getSelection', UNTITLED),
      op('untitledProject', UNTITLED),
    ],
    {},
    'an untitled window that chose no project is asked no more for the preset',
  ),
  scenarioCase(
    { answers: { 'guide.getSelection': { $seq: [selection('p1'), { $throw: 'folder gone' }] } } },
    [
      op('windowProject', HOME),
      op('windowProject', HOME),
      call('getSelection', HOME),
      op('windowProject', HOME),
    ],
    {},
    'the project of a window: asked from the guide until the panel has an answer; a failing guide is no project',
  ),
  scenarioCase(
    {},
    [
      op('windowProject', STRANGER),
      op('windowProject', DOCS),
      op('windowProject', UNTITLED),
      call('setSelection', DOCS, { projectId: 'p2' }),
      op('windowProject', DOCS),
      op('reset', DOCS),
      op('windowProject', DOCS),
    ],
    {},
    "the panel's last answer, the starting selection, no window, a reload",
  ),
  scenarioCase(
    { answers: { 'host.presetProjectOf': { $throw: 'preset failed' } } },
    [op('windowProject', UNTITLED), op('windowProject', HOME)],
    {},
    'a preset that throws is no project',
  ),
  scenarioCase(
    {},
    [
      call('getSelection', DOCS),
      op('windowProject', DOCS),
      call('setSelection', DOCS, { projectId: null }),
      op('windowProject', DOCS),
      set({ windows: { 2: null } }),
      op('windowProject', DOCS),
      call('getSelection', DOCS),
    ],
    {},
    'a chosen null is an answer; a window that is not one answers null',
  ),
  scenarioCase(
    { answers: { 'chats.append': SAVED } },
    [
      ...listenAll(SHEETS),
      call('newChat', SHEETS, P1),
      call('setSelection', SHEETS, { projectId: null }),
      post(DOCS, 'c9'),
      call('newChat', SHEETS, P1),
      post(DOCS, 'c9'),
    ],
    {},
    'choosing no project stops a window showing its chat',
  ),
  scenarioCase(
    { platform: null },
    [call('openDocumentChat', HOME, ref())],
    { 'proj/draft.docx': 'd' },
    'the platform of the host when none is given',
  ),
  scenarioCase(
    { platform: 'darwin' },
    [call('openDocumentChat', HOME, ref())],
    {},
    'a platform that folds case',
  ),
  scenarioCase({}, [call('noSuchRequest', HOME, {})], {}, 'a request that has no handler'),
  scenarioCase(
    { gone: [HOME], answers: { 'chats.chatInfo': { documents: [], lastEditor: 'home' } } },
    [
      call('openProjectScreen', HOME, P1),
      call('openDocumentChat', HOME, ref()),
      listen(HOME, 'onOpenProjectScreen'),
      listen(HOME, 'onOpenChat'),
    ],
    {},
    'an event that finds its window gone drops the window and all that was held for it',
  ),
  scenarioCase(
    {},
    [call('openProjectScreen', HOME, P1), op('forget', HOME), listen(HOME, 'onOpenProjectScreen')],
    {},
    'a closed window keeps nothing that was held for it',
  ),
  scenarioCase(
    {
      answers: {
        'chats.append': {
          $events: [{ event: appended('c9') }],
          then: { status: 'saved', message: message(1) },
        },
      },
    },
    [
      ...listenAll(SHEETS),
      call('newChat', SHEETS, P1),
      post(DOCS, 'c9'),
      call('setSelection', SHEETS, { projectId: null }),
      post(DOCS, 'c9'),
    ],
    {},
    'choosing no project stops a window showing the chat it opened (the event is of that chat)',
  ),
]

// ---------------------------------------------------------------------------
// waitForPageReturn
// ---------------------------------------------------------------------------

interface PageRun {
  destroyed: boolean
  events: string[]
}

/** the page's `on`/`off` and the timer of `armAfterMs`, driven by the case */
async function runPage(spec: PageRun): Promise<unknown> {
  const listeners = new Map<string, Set<() => void>>()
  const page = {
    isDestroyed: () => spec.destroyed,
    on: (event: string, listener: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return page
    },
    off: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener)
      return page
    },
  }
  const timer: { fire: (() => void) | null } = { fire: null }
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void) => {
    timer.fire = fn
    return 1
  }) as never
  globalThis.clearTimeout = (() => {
    timer.fire = null
  }) as never
  let outcome: boolean | 'pending' = 'pending'
  try {
    projectIpc.waitForPageReturn(page as never).then((back) => {
      outcome = back
    })
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  const answers: unknown[] = []
  const settle = () => setImmediate()
  await settle()
  answers.push(['start', outcome])
  for (const event of spec.events) {
    if (event === 'arm') timer.fire?.()
    else for (const listener of [...(listeners.get(event) ?? [])]) listener()
    await settle()
    answers.push([event, outcome])
  }
  answers.push(['listeners', [...listeners.values()].reduce((sum, set) => sum + set.size, 0)])
  return answers
}

const pageCase = (destroyed: boolean, events: string[], note: string): Case => ({
  args: [{ destroyed, events }],
  note,
})

const waitForPageReturn: FnSpec = {
  ts: (args) => runPage(args[0] as PageRun),
  cases: [
    pageCase(true, [], 'a page that is gone answers false at once'),
    pageCase(false, [], 'pending'),
    pageCase(
      false,
      ['focus'],
      'a focus before the timer and the blur is the dialog handing it back',
    ),
    pageCase(false, ['blur', 'focus'], 'a focus after a blur is a return'),
    pageCase(false, ['arm', 'focus'], 'a focus after the timer is a return'),
    pageCase(false, ['destroyed'], 'the page gone first'),
    pageCase(false, ['blur', 'destroyed', 'focus'], 'nothing counts after the page is gone'),
    pageCase(false, ['blur', 'focus', 'destroyed', 'blur'], 'nothing counts after the return'),
    pageCase(
      false,
      ['focus', 'focus', 'arm', 'focus'],
      'a focus that does not count leaves it pending',
    ),
  ],
}

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  single: 'a constant',
  cases: [
    { args: [] },
    { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
  ],
})

export const ipc: Group = {
  'project-ipc.PROJECT_IPC_BAD_REQUEST': constant(projectIpc.PROJECT_IPC_BAD_REQUEST),
  'project-ipc.PROJECT_IPC_UNKNOWN_WINDOW': constant(projectIpc.PROJECT_IPC_UNKNOWN_WINDOW),
  'project-ipc.TRUST_RETURN_ARM_MS': constant(projectIpc.TRUST_RETURN_ARM_MS),
  'project-ipc.scenario': { ts: (args, cx) => runScenario(args[0] as World, cx), cases: scenarios },
  'project-ipc.waitForPageReturn': waitForPageReturn,
  'project-ipc.listProjects': listProjects,
  'project-ipc.addFolder': addFolder,
  'project-ipc.getDefaultParentFolder': getDefaultParentFolder,
  'project-ipc.createProject': createProject,
  'project-ipc.removeFromList': removeFromList,
  'project-ipc.setPinned': setPinned,
  'project-ipc.renameProject': renameProject,
  'project-ipc.relocateProject': relocateProject,
  'project-ipc.openInFileManager': openInFileManager,
  'project-ipc.retryUnwritable': retryUnwritable,
  'project-ipc.getSelection': getSelection,
  'project-ipc.setSelection': setSelection,
  'project-ipc.adoptFolderHint': adoptFolderHint,
  'project-ipc.readContext': readContext,
  'project-ipc.openScope': openScope,
  'project-ipc.closeScope': closeScope,
  'project-ipc.listFiles': listFiles,
  'project-ipc.search': search,
  'project-ipc.read': read,
  'project-ipc.remember': remember,
  'project-ipc.editMemory': editMemory,
  'project-ipc.saveMemory': saveMemory,
  'project-ipc.applyMemoryConsolidation': applyMemoryConsolidation,
  'project-ipc.undoMemoryConsolidation': undoMemoryConsolidation,
  'project-ipc.listChats': listChats,
  'project-ipc.newChat': newChat,
  'project-ipc.openChat': openChat,
  'project-ipc.appendChat': appendChat,
  'project-ipc.renameChat': renameChat,
  'project-ipc.deleteChat': deleteChat,
  'project-ipc.attachDocument': attachDocument,
  'project-ipc.openDocumentChat': openDocumentChat,
  'project-ipc.getProjectDetail': getProjectDetail,
  'project-ipc.getSettings': getSettings,
  'project-ipc.setSettings': setSettings,
  'project-ipc.decideTrust': decideTrust,
  'project-ipc.saveInstructions': saveInstructions,
  'project-ipc.addIgnore': addIgnore,
  'project-ipc.removeIgnore': removeIgnore,
  'project-ipc.listIgnoredFiles': listIgnoredFiles,
  'project-ipc.openProjectScreen': openProjectScreen,
}
