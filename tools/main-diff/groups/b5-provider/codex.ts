/**
 * Group `b5-provider`, part `codex` (Rust: crates/main-core/src/calls/b5_provider/codex.rs):
 * packages/ai-provider/src/codex-app-server.ts (codex-image.ts is an empty
 * module). Names are `codex.<export>`.
 *
 * The pure exports take their arguments as given. The ones that run a Codex
 * process (`streamCodexAppServer`, `chatCodexAppServer`, `readCodexAccount`,
 * `listCodexModels`, `listCodexSubscriptionModels`, `shutdownCodexAppServers`,
 * `setCodexAppServerRuntime`, `waitForTurn`, `parseCodexAppServerTurn`) run in
 * the scripted world of world.ts; their arguments are `[world, o]`.
 *
 * A scenario (`o.steps`) is a list of steps run one after the other in one
 * world, so a case can reuse a pooled process, change the login, or let the
 * idle timer end it: `{ stream: { config, system, messages, tools, maxTokens,
 * sessionId } }`, `{ chat: { config, system, user } }`, `{ account: { cliPath,
 * signal, aborted } }`, `{ models: { cliPath } }`, `{ subModels: { cliPath,
 * signal, aborted } }` (`signal`: the world's caller signal; `aborted`: a
 * signal that is aborted already), `{ forget: true }` (the session folders in the
 * temp folder are removed), `{ all: [steps] }` (the steps start together,
 * as `Promise.all` starts them), `{ login: true }` (the app ran Codex's own
 * login), `{ off: boolean }` (Codex turned off or on), `{ sleep: ms }`,
 * `{ shutdown: true }`. Every step answers `{ ok: true }`, `{ result }` or
 * `{ threw: { name, message, kind?, provider?, resetsAt? } }`; the
 * callbacks of a stream log `['delta', text]`, `['tool', call]`,
 * `['reasoning', text]`, `['usage', usage]` and `['activity']`. The scenario
 * ends with `shutdownCodexAppServers()`. `o.entry` is the program the
 * resolver finds (a step's `cliPath` wins), `o.resolveError` makes the resolver
 * throw, `o.hookKill` replaces `killTree` with a logger (`['killTree', pid]`).
 *
 * The world's children answer by script: the k-th write to stdin gets the
 * k-th reply. `Kid` below builds one with the request ids the client uses.
 * Its working directory is the case's folder (`TMPDIR`), where the session
 * folders are made with a counter for a name (`mkdtemp` is the world's).
 */
import '../../electron-fake.ts'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const mod = await import('../../../../packages/ai-provider/src/codex-app-server.ts')
const launch = await import('../../../../packages/ai-provider/src/subscription/launch.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const ENTRY = '/opt/codex/bin/codex'

// ---------------------------------------------------------------------------
// building the child's script
// ---------------------------------------------------------------------------

const line = (value: unknown): string => `${JSON.stringify(value)}\n`
const note = (method: string, params: unknown): string => line({ method, params })

interface Reply {
  stdout?: Chunk[]
  stderr?: Chunk[]
}

/** The replies of one child, with the ids of the requests the client writes. */
class Kid {
  replies: Reply[] = []
  private id = 0
  /** a request answered with `result`, then `after` (more lines of stdout) */
  req(result: unknown, after = ''): this {
    this.id += 1
    this.replies.push({ stdout: [line({ id: this.id, result }) + after] })
    return this
  }
  /** a request answered with an error */
  err(error: unknown): this {
    this.id += 1
    this.replies.push({ stdout: [line({ id: this.id, error })] })
    return this
  }
  /** a request nobody answers (it times out) */
  hang(): this {
    this.id += 1
    this.replies.push({})
    return this
  }
  /** a write that gets no answer: a notification, or an answer to the server */
  quiet(): this {
    this.replies.push({})
    return this
  }
  /** a reply that is not an answer: raw stdout for the write */
  raw(stdout: Chunk[], stderr?: Chunk[]): this {
    this.replies.push({ stdout, ...(stderr ? { stderr } : {}) })
    return this
  }
  /** initialize and initialized */
  start(): this {
    return this.req({ userAgent: 'codex/1.0' }).quiet()
  }
  /** account/read, config/read, thread/start, mcpServerStatus/list */
  open(o: Opening = {}): this {
    return this.req(o.account ?? CHATGPT)
      .req(o.config ?? { config: { mcp_servers: {} } })
      .req(o.thread ?? thread())
      .req(o.mcp ?? { data: [], nextCursor: null })
  }
  /** turn/start, answered with the turn and the notifications that follow */
  turn(notifications: string, turnId = 'turn-1'): this {
    return this.req({ turn: { id: turnId } }, notifications)
  }
  spec(more: Record<string, unknown> = {}): Record<string, unknown> {
    return { replies: this.replies, ...more }
  }
}

interface Opening {
  account?: unknown
  config?: unknown
  thread?: unknown
  mcp?: unknown
}

const CHATGPT = {
  account: { type: 'chatgpt', planType: 'plus', email: 'someone@example.com' },
  requiresOpenaiAuth: true,
}
const API_KEY = { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
const SIGNED_OUT = { account: null, requiresOpenaiAuth: true }

const thread = (id = 'thread-1', profile = 'seuoffice'): unknown => ({
  thread: { id },
  activePermissionProfile: { id: profile },
})

/** the notifications of a turn that answers `text` (and calls `toolCalls`) */
const done = (
  text: string,
  toolCalls: unknown[] = [],
  turnId = 'turn-1',
  threadId = 'thread-1',
): string =>
  note('turn/started', { threadId, turn: { id: turnId } }) +
  note('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', text: JSON.stringify({ text, toolCalls }) },
  }) +
  note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })

const rawAnswer = (text: string, turnId = 'turn-1', threadId = 'thread-1'): string =>
  note('turn/started', { threadId, turn: { id: turnId } }) +
  note('item/completed', {
    threadId,
    turnId,
    item: { type: 'agentMessage', text },
  }) +
  note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })

const failed = (error: unknown, turnId = 'turn-1', threadId = 'thread-1'): string =>
  note('turn/started', { threadId, turn: { id: turnId } }) +
  note('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error } })

/** a Codex that opens a thread and answers one turn */
const ok = (text = 'hello', extra = ''): Kid =>
  new Kid()
    .start()
    .open()
    .turn(done(text) + extra)

const w = (children: unknown[], more: Partial<World> = {}): World =>
  ({ children, env: { TMPDIR: '$DIR' }, ...more }) as World

const c = (...args: unknown[]): Case => ({ args })

// ---------------------------------------------------------------------------
// the scenario
// ---------------------------------------------------------------------------

type Cfg = { model?: string; cliPath?: string; effort?: string }
type Step =
  | {
      stream: {
        config?: Cfg
        system?: string
        messages?: unknown[]
        tools?: unknown[]
        maxTokens?: number
        sessionId?: string
      }
    }
  | { chat: { config?: Cfg; system?: string; user?: string } }
  | { account: { cliPath?: string; signal?: boolean; aborted?: boolean } }
  | { models: { cliPath?: string } }
  | { subModels: { cliPath?: string; signal?: boolean; aborted?: boolean } }
  | { all: Step[] }
  | { forget: true }
  | { login: true }
  | { off: boolean }
  | { sleep: number }
  | { shutdown: true }

interface Opts {
  steps?: Step[]
  entry?: string
  resolveError?: string
  hookKill?: boolean
}

const USER = { role: 'user', text: 'hi' }
const TOOLS = [
  {
    name: 'edit_doc',
    description: 'edit the document',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'read_doc', description: 'read the document', inputSchema: { type: 'object' } },
]

const configOf = (config: Cfg | undefined): Any => ({ model: 'gpt-5', ...(config ?? {}) })

function program(entry: string): Any {
  return { provider: 'codex', command: entry, prefixArgs: [], env: {}, entry, source: 'configured' }
}

function threw(error: unknown): unknown {
  const e = error as Any
  return {
    threw: {
      name: e?.name ?? null,
      message: e?.message ?? String(error),
      ...(e?.kind !== undefined ? { kind: e.kind } : {}),
      ...(e?.provider !== undefined ? { provider: e.provider } : {}),
      ...(e?.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}),
    },
  }
}

function callbacks(cx: TsContext, signal: AbortSignal, sessionId?: string): Any {
  return {
    signal,
    ...(sessionId !== undefined ? { sessionId } : {}),
    onDelta: (t: string) => cx.log('delta', t),
    onToolCall: (call: unknown) => cx.log('tool', call),
    onReasoningDelta: (t: string) => cx.log('reasoning', t),
    onSubscriptionUsage: (u: unknown) => cx.log('usage', u),
    onActivity: () => cx.log('activity'),
  }
}

async function runStep(step: Step, cx: TsContext, signal: AbortSignal): Promise<unknown> {
  try {
    if ('forget' in step) {
      // the session folders are gone (the person cleaned the temp folder)
      const root = os.tmpdir()
      for (const name of await fsp.readdir(root))
        if (name.startsWith('seuoffice-codex-app-server-'))
          await fsp.rm(join(root, name), { recursive: true, force: true })
      return null
    }
    if ('all' in step) {
      // started together, as `Promise.all` does
      return await Promise.all(step.all.map((one) => runStep(one, cx, signal)))
    }
    if ('stream' in step) {
      const s = step.stream
      await mod.streamCodexAppServer(
        configOf(s.config),
        s.system ?? 'sys',
        (s.messages ?? [USER]) as Any,
        (s.tools ?? []) as Any,
        s.maxTokens ?? 4096,
        callbacks(cx, signal, s.sessionId),
      )
      return { ok: true }
    }
    if ('chat' in step) {
      const s = step.chat
      return {
        result: await mod.chatCodexAppServer(
          configOf(s.config),
          s.system ?? 'sys',
          s.user ?? 'hi',
          signal,
        ),
      }
    }
    if ('account' in step) {
      const s = step.account
      const given = s.aborted ? abortedSignal() : s.signal ? signal : undefined
      return { result: await mod.readCodexAccount(s.cliPath, given) }
    }
    if ('models' in step) return { result: await mod.listCodexModels(step.models.cliPath) }
    if ('subModels' in step) {
      const s = step.subModels
      const given = s.aborted ? abortedSignal() : s.signal ? signal : undefined
      return { result: await mod.listCodexSubscriptionModels(s.cliPath, given) }
    }
    if ('login' in step) launch.notifySubscriptionLoginChange('codex')
    else if ('off' in step) launch.notifySubscriptionOffChange({ provider: 'codex', off: step.off })
    else if ('sleep' in step) await new Promise((r) => setTimeout(r, step.sleep))
    else mod.shutdownCodexAppServers()
    return null
  } catch (error) {
    return threw(error)
  }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

/**
 * The module keeps `statusLoginKind` between calls, which a fresh Rust state
 * does not: a read that fails before it answers puts it back to undefined.
 */
async function resetModule(cx: TsContext): Promise<void> {
  mod.shutdownCodexAppServers()
  launch.notifySubscriptionOffChange({ provider: 'codex', off: false })
  const restore = mod.setCodexAppServerRuntime({ resolve: async () => program(ENTRY) } as Any)
  try {
    await inWorld({}, { ...cx, log: () => undefined }, () =>
      mod.readCodexAccount(ENTRY).catch(() => undefined),
    )
  } finally {
    restore()
  }
  mod.shutdownCodexAppServers()
}

function scenario([world, opts]: unknown[], cx: TsContext): Promise<unknown> {
  const o = (opts ?? {}) as Opts
  return (async () => {
    await resetModule(cx)
    const restore = mod.setCodexAppServerRuntime({
      resolve: async (_provider: string, options?: { configuredPath?: string }) => {
        if (o.resolveError !== undefined) throw new Error(o.resolveError)
        return program(options?.configuredPath ?? o.entry ?? ENTRY)
      },
      ...(o.hookKill
        ? { killTree: (child: { pid?: number }) => cx.log('killTree', child.pid ?? null) }
        : {}),
    } as Any)
    try {
      return await inWorld(world as World, cx, async (_run, signal) => {
        const out: unknown[] = []
        for (const step of o.steps ?? []) out.push(await runStep(step, cx, signal))
        mod.shutdownCodexAppServers()
        return out
      })
    } finally {
      restore()
      launch.notifySubscriptionOffChange({ provider: 'codex', off: false })
      mod.shutdownCodexAppServers()
    }
  })()
}

const stream = (s: Extract<Step, { stream: unknown }>['stream'] = {}): Step => ({ stream: s })
const chat = (s: Extract<Step, { chat: unknown }>['chat'] = {}): Step => ({ chat: s })
const steps = (...list: Step[]): Opts => ({ steps: list })

// ---------------------------------------------------------------------------
// the pure exports
// ---------------------------------------------------------------------------

const err = (error: unknown): unknown => {
  const e = error as Any
  return {
    name: e.name,
    message: e.message,
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.provider !== undefined ? { provider: e.provider } : {}),
    ...(e.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}),
  }
}

const mcpOff = { a: { enabled: false }, 'b c': { enabled: false } }

const MODEL_PAGE = {
  data: [
    {
      id: 'gpt-5',
      model: 'gpt-5-2025',
      displayName: 'GPT-5',
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'fast' },
        { reasoningEffort: 'high', description: 'thorough' },
        { reasoningEffort: 'bogus' },
      ],
      defaultReasoningEffort: 'low',
    },
    { id: 'hidden-one', hidden: true },
    { model: 'gpt-5-mini', displayName: 'Mini' },
  ],
}

const pure: Group = {
  'codex.MAX_RPC_LINE_BYTES': {
    ts: () => mod.MAX_RPC_LINE_BYTES,
    single: 'a constant',
    cases: [c()],
  },
  'codex.CODEX_CONFIG_OVERRIDES': {
    ts: () => [...mod.CODEX_CONFIG_OVERRIDES],
    single: 'a constant',
    cases: [c()],
  },
  'codex.codexAppServerLaunchArgs': {
    ts: () => mod.codexAppServerLaunchArgs(),
    single: 'takes no input',
    cases: [c()],
  },
  'codex.codexAppServerOutputSchema': {
    ts: ([tools]) => mod.codexAppServerOutputSchema(tools as Any),
    cases: [c([]), c(TOOLS), c([{ name: 'only' }]), c([{ description: 'unnamed' }])],
  },
  'codex.buildCodexAppServerPrompt': {
    ts: ([system, messages, tools, maxTokens]) =>
      mod.buildCodexAppServerPrompt(
        system as string,
        messages as Any,
        tools as Any,
        maxTokens as number,
      ),
    cases: [
      c('be brief', [USER], [], 1024),
      c(
        'use tools',
        [
          USER,
          {
            role: 'assistant',
            text: 'ok',
            toolCalls: [{ id: 't1', name: 'edit_doc', input: { text: 'x' }, extra: 1 }],
          },
          { role: 'tool', results: [{ id: 't1', content: 'done' }] },
        ],
        TOOLS,
        4096,
      ),
      c(
        'with images',
        [
          {
            role: 'user',
            text: 'look',
            images: [
              { mime: 'image/png', base64: 'aGk=' },
              { mime: 'image/gif', base64: 'aGk=' },
            ],
          },
          { role: 'user', text: 'again', images: [{ mime: 'image/png', base64: 'aGk=' }] },
          { role: 'user', text: 'none', images: [] },
        ],
        [],
        1.5,
      ),
      c(
        'empty assistant',
        [
          { role: 'assistant', text: '', toolCalls: [] },
          { role: 'assistant', toolCalls: [{ id: 'a' }] },
        ],
        [],
        1e21,
      ),
      c('', [], [{ name: 'n', description: 'd', inputSchema: { type: 'object' }, other: 1 }], 0),
    ],
  },
  'codex.codexThreadStartParams': {
    ts: ([cfg, tempDir, mode, mcp]) =>
      mod.codexThreadStartParams(cfg as Any, tempDir as string, mode as Any, mcp as Any),
    cases: [
      c({ model: ' gpt-5 ' }, '/tmp/codex-1', 'profile', {}),
      c({ model: '  ' }, '/tmp/codex-1', 'profile', {}),
      c({ model: 'gpt-5' }, '/tmp/codex-1', 'profile', mcpOff),
      c({ model: 'gpt-5' }, '/tmp/codex-1', 'read-only', {}),
      c({ model: 'm' }, '/tmp/codex-1', 'read-only', mcpOff),
      c({ model: 'm' }, ':minimal', 'profile', {}),
      c({}, '/tmp/x', 'profile', {}),
      c(null, '/tmp/x', 'read-only', {}),
      c({ model: null }, '/tmp/x', 'profile', {}),
      c({ model: 5 }, '/tmp/x', 'profile', {}),
      c('text', '/tmp/x', 'profile', {}),
    ],
  },
  'codex.activePermissionProfileId': {
    ts: ([result]) => mod.activePermissionProfileId(result) ?? null,
    cases: [
      c({ activePermissionProfile: { id: 'seuoffice' } }),
      c({ activePermissionProfile: { id: 5 } }),
      c({ activePermissionProfile: null }),
      c({}),
      c(null),
      c('text'),
      c({ activePermissionProfile: { id: '' } }),
    ],
  },
  'codex.codexMcpServerOverrides': {
    ts: ([read]) => mod.codexMcpServerOverrides(read),
    cases: [
      c({ config: { mcp_servers: { fs: { command: 'x' }, web: { url: 'y' } } } }),
      c({ config: {} }),
      c({ config: { mcp_servers: null } }),
      c({ config: { mcp_servers: ['a', 'b'] } }),
      c({ config: { mcp_servers: { b: 1, 2: 2, a: 3, 1: 4 } } }),
      c({}),
      c(null),
      c({ config: [] }),
    ],
  },
  'codex.codexAttachedMcpServers': {
    ts: ([list]) => mod.codexAttachedMcpServers(list),
    cases: [
      c({ data: [] }),
      c({
        data: [
          { name: 'fs', runtimeStatus: 'disabled' },
          { name: 'web', runtimeStatus: 'ready' },
        ],
      }),
      c({
        data: [
          { name: 'idle', runtimeStatus: 'disabled', tools: { read: {} } },
          { runtimeStatus: 'starting' },
        ],
      }),
      c({
        data: [
          { name: 'x', tools: {} },
          { name: 5, tools: { a: 1 } },
        ],
      }),
      c({ data: [{ name: 'x' }, [], { name: 'y', tools: ['t'] }] }),
      c({ data: [{ name: 'x' }, null] }),
      c({ data: {} }),
      c(null),
    ],
  },
  'codex.codexSubscriptionUsage': {
    ts: ([snapshot]) => mod.codexSubscriptionUsage(snapshot),
    cases: [
      c({
        limitId: 'codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 },
        secondary: { usedPercent: 150, windowDurationMins: 10080, resetsAt: 1700100000 },
      }),
      c({ primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1700000000 } }),
      c({
        limitId: 'other',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1700000000 },
      }),
      c({
        limitId: null,
        primary: { usedPercent: -5, windowDurationMins: 300, resetsAt: 1700000000 },
      }),
      c({ primary: { usedPercent: 10, windowDurationMins: 43200, resetsAt: 1700000000 } }),
      c({ primary: { usedPercent: 10, windowDurationMins: 300 } }),
      c({ primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 0 } }),
      c({ primary: { usedPercent: 'x', windowDurationMins: 300, resetsAt: 1 } }),
      c({
        primary: null,
        secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1700100000.5 },
      }),
      c(null),
    ],
  },
  'codex.codexRunError': {
    ts: ([turnError, rateLimits]) => err(mod.codexRunError(turnError, rateLimits)),
    cases: [
      c({ message: 'boom' }),
      c(null),
      c({ message: '' }),
      c({ message: 'limit', codexErrorInfo: 'usageLimitExceeded' }),
      c(
        { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1700000000 },
          secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1700500000 },
        },
      ),
      c(
        { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1700000000 } },
      ),
      c({ message: 'no', codexErrorInfo: 'unauthorized' }),
      c({ message: 'http', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }),
      c({
        message: 'http',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      }),
      c({ message: 'arr', codexErrorInfo: [{ httpStatusCode: 401 }] }),
      c('text'),
    ],
  },
  'codex.codexListedEffort': {
    ts: ([listed, model, configured]) =>
      mod.codexListedEffort(listed, model as string, configured) ?? null,
    cases: [
      c(MODEL_PAGE, 'gpt-5', 'high'),
      c(MODEL_PAGE, 'gpt-5', ' low '),
      c(MODEL_PAGE, 'gpt-5', 'medium'),
      c(MODEL_PAGE, 'gpt-5-2025', 'high'),
      c(MODEL_PAGE, 'gpt-5-mini', 'high'),
      c(MODEL_PAGE, 'hidden-one', 'high'),
      c(MODEL_PAGE, 'gpt-5', 'bogus'),
      c(MODEL_PAGE, 'gpt-5', null),
      c({ data: 'x' }, 'gpt-5', 'high'),
      c(null, 'gpt-5', 'high'),
      c({ data: [null, { id: 'm', supportedReasoningEfforts: 'nope' }] }, 'm', 'high'),
    ],
  },
  'codex.codexSubscriptionModels': {
    ts: ([entries]) => mod.codexSubscriptionModels(entries),
    cases: [
      c(MODEL_PAGE.data),
      c([
        { id: 'a', displayName: 'A' },
        { id: 'b', isDefault: true },
        { id: 'c', isDefault: true },
      ]),
      c([{ id: 'x' }, { id: 'x', displayName: 'dup' }, { model: 'y', displayName: 5 }, { id: '' }]),
      c([
        {
          id: 'm',
          model: 'm',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          defaultReasoningEffort: 'high',
        },
      ]),
      c([
        {
          id: 'm',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          defaultReasoningEffort: 'high',
        },
      ]),
      c([null, 'x', { hidden: true, id: 'h' }, []]),
      c([]),
      c('x'),
      c(null),
    ],
  },
}

// ---------------------------------------------------------------------------
// the bounded stdout reader
// ---------------------------------------------------------------------------

type Event = { data: Chunk } | { end: true } | { close: true }

const bytesOf = (chunk: Chunk): Buffer =>
  typeof chunk === 'string'
    ? Buffer.from(chunk, 'utf8')
    : 'hex' in chunk
      ? Buffer.from(chunk.hex, 'hex')
      : Buffer.alloc(chunk.size, chunk.fill)

const attach = {
  'codex.attachBoundedRpcStdout': {
    ts: ([events, throwOn]: unknown[], cx: TsContext) => {
      const listeners: Record<string, ((chunk?: Buffer) => void)[]> = {}
      const stdout = {
        on: (event: string, listener: (chunk?: Buffer) => void) => {
          ;(listeners[event] ??= []).push(listener)
          return stdout
        },
      }
      const child = { stdout, kill: () => cx.log('kill') }
      mod.attachBoundedRpcStdout(
        child as Any,
        (text) => {
          cx.log('line', text)
          if ((throwOn as unknown[] | undefined)?.includes(text)) throw new Error('write failed')
          if ((throwOn as unknown[] | undefined)?.includes(`!${text}`)) throw 'plain'
        },
        (error) => cx.log('overflow', error.message),
      )
      for (const event of events as Event[]) {
        if ('data' in event) for (const l of listeners.data ?? []) l(bytesOf(event.data))
        else if ('end' in event) for (const l of listeners.end ?? []) l()
        else for (const l of listeners.close ?? []) l()
      }
      return null
    },
    cases: [
      c([{ data: 'a\nb\nc' }, { end: true }]),
      c([{ data: 'one\r\ntwo\r\n' }, { close: true }, { data: 'late\n' }]),
      c([{ data: { hex: '61e2' } }, { data: { hex: '82ac0a' } }, { end: true }]),
      c([{ data: { hex: '61e282' } }, { end: true }]),
      c([{ data: '' }, { end: true }]),
      c([{ data: { hex: 'efbbbf610a' } }, { end: true }]),
      c([{ data: { hex: 'efbb' } }, { data: { hex: 'bf620a63' } }, { end: true }]),
      c([{ data: 'x\ny\nz\n' }, { data: 'tail' }], ['y']),
      c([{ data: 'x\ny\nz\n' }, { end: true }], ['!x']),
      c([{ data: 'tail' }, { end: true }], ['tail']),
      c([{ data: { fill: 97, size: 4194304 } }, { data: 'x\n' }, { end: true }]),
      c([{ data: { fill: 97, size: 4194305 } }, { data: 'x\n' }, { end: true }]),
      c([
        { data: { fill: 97, size: 3000000 } },
        { data: { fill: 98, size: 3000000 } },
        { end: true },
      ]),
      c([{ data: { fill: 97, size: 5000000 } }, { data: 'x\n' }]),
    ],
  },
}

// ---------------------------------------------------------------------------
// waitForTurn over a scripted transport
// ---------------------------------------------------------------------------

interface TurnScript {
  /** the notifications and closings, at virtual times */
  events: (
    { at: number; notify: { method: string; params?: unknown } } | { at: number; close: string }
  )[]
  /** the answers of the requests, by method: a value, `{ reject }` or `'hang'` */
  answers?: Record<string, unknown>
  noClose?: boolean
  threadId?: string
}

const T = 'thread-1'
const n = (at: number, method: string, params?: unknown): TurnScript['events'][number] => ({
  at,
  notify: { method, ...(params !== undefined ? { params } : {}) },
})
const answerOf = (text: string): unknown => ({ type: 'agentMessage', text })
const waitCases: Case[] = [
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(10, 'turn/started', { threadId: T, turn: { id: 'u1' } }),
      n(20, 'item/reasoning/summaryTextDelta', { threadId: T, turnId: 'u1', delta: 'thinking' }),
      n(30, 'item/completed', { threadId: T, turnId: 'u1', item: answerOf('final') }),
      n(40, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'completed',
          items: [
            { type: 'userMessage' },
            { type: 'agentMessage', text: 'from items' },
            { type: 'agentMessage', text: 5 },
          ],
        },
      }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'item/completed', { threadId: 'other', turnId: 'u1', item: answerOf('wrong thread') }),
      n(6, 'item/completed', { threadId: T, turnId: 'u2', item: answerOf('wrong turn') }),
      n(7, 'item/completed', { threadId: T, turnId: 'u1', item: answerOf('right') }),
      n(8, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'error', { threadId: T, willRetry: true, error: { message: 'Reconnecting... 1/5' } }),
      n(6, 'error', { threadId: T, willRetry: false, error: { message: 'warning only' } }),
      n(7, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'error', { threadId: T, willRetry: false, error: { message: 'model overloaded' } }),
      n(6, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'failed' } }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'error', { threadId: T, error: { message: 'unauth', codexErrorInfo: 'unauthorized' } }),
      n(6, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'failed',
          error: {
            message: 'real',
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
          },
        },
      }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'account/rateLimits/updated', {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1700003600 },
        },
      }),
      n(6, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'failed',
          error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        },
      }),
    ],
  }),
  c(w([]), {
    answers: {
      'turn/start': { turn: { id: 'u1' } },
      'account/rateLimits/read': {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1700600000 },
        },
      },
    },
    events: [
      n(6, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'failed',
          error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        },
      }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } }, 'account/rateLimits/read': 'hang' },
    events: [
      n(6, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'failed',
          error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        },
      }),
    ],
  }),
  c(w([]), {
    answers: {
      'turn/start': { turn: { id: 'u1' } },
      'account/rateLimits/read': { reject: 'no limits' },
    },
    events: [
      n(6, 'turn/completed', {
        threadId: T,
        turn: {
          id: 'u1',
          status: 'failed',
          error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
        },
      }),
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'error', {
        threadId: T,
        error: { message: 'quota', codexErrorInfo: 'usageLimitExceeded' },
      }),
      { at: 9, close: 'Codex app-server exited (1)' },
    ],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [{ at: 9, close: 'Codex app-server exited (1)' }],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    noClose: true,
    events: [
      { at: 9, close: 'never heard' },
      n(20, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } }),
    ],
  }),
  c(w([]), { answers: { 'turn/start': { reject: 'start refused' } }, events: [] }),
  c(w([], { abortAt: 15 }), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [n(5, 'turn/started', { threadId: T, turn: { id: 'u1' } })],
  }),
  c(w([], { abortAt: 15 }), {
    answers: { 'turn/start': 'hang' },
    events: [],
  }),
  c(w([], { abortAt: 0 }), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [n(100, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } })],
  }),
  c(w([]), {
    answers: { 'turn/start': { turn: { id: 'u1' } } },
    events: [
      n(5, 'turn/started', { threadId: T, turn: { id: 'u1' } }),
      n(6, 'item/completed', { threadId: T, item: { type: 'reasoning' } }),
      n(7, 'turn/started', { threadId: T, turn: { id: 'u2' } }),
      n(8, 'turn/completed', { threadId: T, turn: { id: 'u1', status: 'completed' } }),
    ],
  }),
]

const waits = {
  'codex.waitForTurn': {
    ts: ([world, script]: unknown[], cx: TsContext) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const s = script as TurnScript
        const listeners = new Set<(m: Any) => void>()
        const closers = new Set<(e: Error) => void>()
        const transport: Any = {
          request: async (method: string, params: unknown) => {
            cx.log('request', method, params ?? null)
            const answer = (s.answers ?? {})[method] as Any
            if (answer === 'hang') return new Promise(() => undefined)
            if (answer && typeof answer === 'object' && 'reject' in answer)
              throw new Error(answer.reject)
            return answer ?? {}
          },
          onNotification: (l: (m: Any) => void) => {
            listeners.add(l)
            return () => listeners.delete(l)
          },
          ...(s.noClose
            ? {}
            : {
                onClose: (l: (e: Error) => void) => {
                  closers.add(l)
                  return () => closers.delete(l)
                },
              }),
        }
        for (const event of s.events) {
          setTimeout(() => {
            if ('notify' in event) for (const l of [...listeners]) l(event.notify)
            else for (const l of [...closers]) l(new Error(event.close))
          }, event.at)
        }
        const cb = callbacks(cx, signal)
        try {
          return {
            text: await mod.waitForTurn(
              transport,
              s.threadId ?? 'thread-1',
              () => transport.request('turn/start', { threadId: s.threadId ?? 'thread-1' }),
              signal,
              cb,
            ),
          }
        } catch (error) {
          return threw(error)
        }
      }),
    cases: waitCases,
  },
}

// ---------------------------------------------------------------------------
// the functions that run a Codex process
// ---------------------------------------------------------------------------

const toolAnswer = (text: string, calls: unknown[]): Kid =>
  new Kid().start().open().turn(done(text, calls))

const modelPages = (): Kid =>
  new Kid()
    .start()
    .req(CHATGPT)
    .req({ data: MODEL_PAGE.data.slice(0, 2), nextCursor: 'page-2' })
    .req({ data: MODEL_PAGE.data.slice(2), nextCursor: null })

const scenarioSpec = {
  ts: scenario,
}

const streams: Group = {
  'codex.streamCodexAppServer': {
    ...scenarioSpec,
    cases: [
      // a reused session, then the end of a run that keeps its thread
      c(w([ok('hello').spec()]), steps(stream({ sessionId: 's1' }))),
      // no session id: the thread and its folder are dropped
      c(w([ok('one shot').spec()]), steps(stream())),
      // tool calls: a valid one, one without an id, one with broken JSON
      c(
        w([
          toolAnswer('calling', [
            { id: 'call-1', name: 'edit_doc', inputJson: '{"text":"a"}' },
            { id: '', name: 'read_doc', inputJson: '' },
            { name: 'edit_doc', inputJson: '{"text":' },
          ]).spec(),
        ]),
        steps(stream({ tools: TOOLS, sessionId: 's' })),
      ),
      // a tool that was not listed
      c(
        w([toolAnswer('x', [{ id: 'c', name: 'format_disk', inputJson: '{}' }]).spec()]),
        steps(stream({ tools: TOOLS })),
      ),
      // a configured effort the model lists: read once, passed on
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req(MODEL_PAGE)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('with effort'))
            .spec(),
        ]),
        steps(stream({ config: { model: 'gpt-5', effort: 'high' } })),
      ),
      // an effort the model does not list, and a list that cannot be read
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req(MODEL_PAGE)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('no effort'))
            .spec(),
        ]),
        steps(stream({ config: { model: 'gpt-5-mini', effort: 'high' } })),
      ),
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .err({ code: -32601, message: 'Method not found' })
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('list failed'))
            .spec(),
        ]),
        steps(stream({ config: { model: 'gpt-5', effort: 'low' } })),
      ),
      // no model configured: the default of the list
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ data: [{ id: 'm1' }, { id: 'm2', isDefault: true }] })
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('default model'))
            .spec(),
        ]),
        steps(stream({ config: { model: ' ' } })),
      ),
      // no model configured and an empty list
      c(
        w([new Kid().start().req(CHATGPT).req({ data: [] }).spec()]),
        steps(stream({ config: { model: '' } })),
      ),
      // a Codex too old to list models
      c(
        w([
          new Kid().start().req(CHATGPT).err({ code: -32601, message: 'Method not found' }).spec(),
        ]),
        steps(stream({ config: { model: '' } })),
      ),
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .err({ code: 5, message: 'nope', data: { a: 1 } })
            .spec(),
        ]),
        steps(stream({ config: { model: '' } })),
      ),
      // signed out
      c(w([new Kid().start().req(SIGNED_OUT).spec()]), steps(stream())),
      // no account and none required: another provider; the run goes on
      c(
        w([
          new Kid()
            .start()
            .req({ account: null, requiresOpenaiAuth: false })
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('other provider'))
            .spec(),
        ]),
        steps(stream()),
      ),
      // a metered login the status check did not see
      c(w([new Kid().start().req(CHATGPT).req(API_KEY).spec()]), steps({ account: {} }, stream())),
      // a metered login the status check saw
      c(
        w([
          new Kid()
            .start()
            .req(API_KEY)
            .req(API_KEY)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('metered ok'))
            .spec(),
        ]),
        steps({ account: {} }, stream()),
      ),
      // an MCP server in the configuration is switched off; the thread still has it
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: { fs: { command: 'x' } } } })
            .req(thread())
            .req({ data: [{ name: 'fs', runtimeStatus: 'ready' }] })
            .spec(),
        ]),
        steps(stream({ sessionId: 'mcp' })),
      ),
      // the check cannot be made
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .err({ code: -32603, message: 'status failed' })
            .spec(),
        ]),
        steps(stream()),
      ),
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [], nextCursor: 'more' })
            .req({ data: [], nextCursor: 'more2' })
            .spec(),
        ]),
        steps(stream()),
      ),
      // the configuration cannot be read
      c(
        w([new Kid().start().req(CHATGPT).err({ message: 'config broken' }).spec()]),
        steps(stream()),
      ),
      c(w([new Kid().start().req(CHATGPT).req({}).spec()]), steps(stream())),
      // the profile is ignored: its thread is discarded and the sandbox is used
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread('thread-0', 'other'))
            .req({})
            .req(thread('thread-1', 'read-only'))
            .req({ data: [] })
            .turn(done('sandboxed'))
            .spec(),
        ]),
        steps(stream({ sessionId: 'sb' })),
      ),
      // the profile is refused
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: { fs: {} } } })
            .err({ code: -32602, message: 'unknown field permissions' })
            .req(thread('thread-1', 'x'))
            .req({ data: [{ name: 'fs', runtimeStatus: 'disabled' }] })
            .turn(done('fallback'))
            .spec(),
        ]),
        steps(stream({ sessionId: 'refused' })),
      ),
      // no thread id in the answer
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req({ thread: {}, activePermissionProfile: { id: 'seuoffice' } })
            .req({})
            .spec(),
        ]),
        steps(stream()),
      ),
      // a server request is refused, the run goes on
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT, line({ id: 'srv-1', method: 'item/tool/call', params: {} }))
            .quiet()
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('refused a request'))
            .spec(),
        ]),
        steps(stream()),
      ),
      // an MCP server starts after the switch-off
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req(
              { data: [] },
              note('mcpServer/startupStatus/updated', { name: 'fs', status: 'starting' }),
            )
            .spec(),
        ]),
        steps(stream()),
      ),
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('fine') + note('mcpServer/startupStatus/updated', { status: 'failed' }))
            .spec(),
        ]),
        steps(stream()),
      ),
      // a line that is no JSON is only noted; `null` stops the reader
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT, 'not json at all\n[1,2]\n42\n"text"\n{}\n')
            .req({ config: { mcp_servers: {} } })
            .req(thread())
            .req({ data: [] })
            .turn(done('noise'))
            .spec(),
        ]),
        steps(stream()),
      ),
      c(w([new Kid().start().req(CHATGPT, 'null\n').spec()]), steps(stream())),
      // a line without a newline that is too long
      c(
        w([
          new Kid()
            .start()
            .raw([{ fill: 97, size: 4194305 }])
            .spec(),
        ]),
        steps(stream()),
      ),
      // a turn failed for good
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(failed({ message: 'sign in again', codexErrorInfo: 'unauthorized' }))
            .spec(),
        ]),
        steps(stream()),
      ),
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(
              failed({
                message: 'server error',
                codexErrorInfo: { internalServerError: { httpStatusCode: 500 } },
              }),
            )
            .spec(),
        ]),
        steps(stream()),
      ),
      c(w([new Kid().start().open().turn(failed(undefined)).spec()]), steps(stream())),
      // a used-up limit: the snapshot came with the turn
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(
              note('account/rateLimits/updated', {
                rateLimits: {
                  limitId: 'codex',
                  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1700003600 },
                  secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1700900000 },
                },
              }) + failed({ message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }),
            )
            .spec(),
        ]),
        steps(stream()),
      ),
      // a used-up limit: Codex is asked for the reset time
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(failed({ message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }))
            .req({
              rateLimits: {
                primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1700600000 },
              },
            })
            .spec(),
        ]),
        steps(stream()),
      ),
      // ... and does not answer in time
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(failed({ message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }))
            .hang()
            .spec(),
        ]),
        steps(stream()),
      ),
      // reconnect notices are no data; reasoning and usage go on to the callbacks
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(
              note('account/rateLimits/updated', {
                rateLimits: {
                  primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1700003600 },
                },
              }) +
                note('error', {
                  threadId: 'thread-1',
                  willRetry: true,
                  error: { message: 'Reconnecting... 1/5' },
                }) +
                note('item/reasoning/summaryTextDelta', { threadId: 'thread-1', delta: 'hm' }) +
                done('after retry'),
            )
            .spec(),
        ]),
        steps(stream()),
      ),
      // an answer that is no structured response
      c(w([new Kid().start().open().turn(rawAnswer('plain words')).spec()]), steps(stream())),
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(rawAnswer('```json\n{"text":"fenced","toolCalls":[]}\n```'))
            .spec(),
        ]),
        steps(stream()),
      ),
      c(
        w([new Kid().start().open().turn(rawAnswer('{"text":"","toolCalls":[]}')).spec()]),
        steps(stream()),
      ),
      c(
        w([new Kid().start().open().turn(rawAnswer('{"text":5,"toolCalls":[]}')).spec()]),
        steps(stream()),
      ),
      c(
        w([new Kid().start().open().turn(rawAnswer('{"text":"x","toolCalls":{}}')).spec()]),
        steps(stream()),
      ),
      c(w([new Kid().start().open().turn(rawAnswer('[1]')).spec()]), steps(stream())),
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(
              rawAnswer(
                JSON.stringify({
                  text: 'x',
                  toolCalls: Array.from({ length: 101 }, () => ({
                    id: 'a',
                    name: 'edit_doc',
                    inputJson: '{}',
                  })),
                }),
              ),
            )
            .spec(),
        ]),
        steps(stream({ tools: TOOLS })),
      ),
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(rawAnswer(JSON.stringify({ text: 'x', toolCalls: [null] })))
            .spec(),
        ]),
        steps(stream({ tools: TOOLS })),
      ),
      // the caller cancels in the middle of a turn
      c(
        w(
          [
            new Kid()
              .start()
              .open()
              .turn(note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }))
              .quiet()
              .spec(),
          ],
          { abortAt: 2000 },
        ),
        steps(stream({ sessionId: 'cancel' })),
      ),
      // the turn is silent: the watchdog ends it
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }))
            .spec(),
        ]),
        steps(stream({ sessionId: 'silent' })),
      ),
      // never an answer to turn/start: the request times out
      c(w([new Kid().start().open().hang().spec()]), steps(stream())),
      // Codex is not installed
      c(w([]), steps(stream())),
      c(w([{ error: { message: 'spawn EACCES', code: 'EACCES' } }]), steps(stream())),
      c(w([]), { ...steps(stream()), resolveError: 'Codex CLI was not found' }),
      // the process ends in the middle of a turn
      c(
        w([
          {
            replies: new Kid()
              .start()
              .open()
              .turn(note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })).replies,
            closeOn: 7,
            exit: { code: 3 },
            stderr: ['segfault in codex\n'],
          },
        ]),
        steps(stream()),
      ),
      c(
        w([
          {
            replies: new Kid()
              .start()
              .open()
              .turn(
                note('error', {
                  threadId: 'thread-1',
                  error: { message: 'quota gone', codexErrorInfo: 'usageLimitExceeded' },
                }),
              ).replies,
            closeOn: 7,
            exit: { code: 1 },
          },
        ]),
        steps(stream()),
      ),
      c(
        w([
          {
            replies: new Kid().start().replies,
            closeOn: 2,
            exit: { code: 9, signal: 'SIGKILL' },
          },
        ]),
        steps(stream()),
      ),
      // images are written next to the thread
      c(
        w([ok('saw them').spec()]),
        steps(
          stream({
            messages: [
              {
                role: 'user',
                text: 'look',
                images: [
                  { mime: 'image/png', base64: 'aGk=' },
                  { mime: 'image/JPEG', base64: 'aGk=' },
                ],
              },
              { role: 'assistant', text: 'ok' },
              {
                role: 'user',
                text: 'more',
                images: [
                  { mime: 'image/webp', base64: 'aGk=' },
                  { mime: 'text/plain', base64: '' },
                  { mime: 'image/gif', base64: 'aGk=' },
                ],
              },
            ],
          }),
        ),
      ),
      // a second run on the same session sends only the new messages
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(done('first'), 'turn-1')
            .req(CHATGPT)
            .turn(done('second', [], 'turn-2'), 'turn-2')
            .spec(),
        ]),
        steps(
          stream({ sessionId: 'same' }),
          stream({
            sessionId: 'same',
            messages: [
              USER,
              { role: 'assistant', text: 'first' },
              { role: 'user', text: 'and then?' },
            ],
          }),
        ),
      ),
      // another system prompt: the thread is replaced. Nothing answers the delete of the old
      // thread: its answer would race the real file system call that follows it
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(done('first'))
            .req(CHATGPT)
            .hang()
            .req({ config: { mcp_servers: {} } })
            .req(thread('thread-2'))
            .req({ data: [] })
            .turn(done('second', [], 'turn-2', 'thread-2'), 'turn-2')
            .spec(),
        ]),
        steps(
          stream({ sessionId: 'same' }),
          { forget: true },
          stream({ sessionId: 'same', system: 'another' }),
        ),
      ),
      // fewer messages than the session has seen: new thread as well
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(done('first'))
            .req(CHATGPT)
            .hang()
            .req({ config: { mcp_servers: {} } })
            .req(thread('thread-2'))
            .req({ data: [] })
            .turn(done('again', [], 'turn-2', 'thread-2'), 'turn-2')
            .spec(),
        ]),
        steps(
          stream({
            sessionId: 'same',
            messages: [USER, { role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }],
          }),
          { forget: true },
          stream({ sessionId: 'same', messages: [USER] }),
        ),
      ),
      // a failed turn drops the session
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(rawAnswer('nonsense'))
            .req({})
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread('thread-2'))
            .req({ data: [] })
            .turn(done('recovered', [], 'turn-2', 'thread-2'), 'turn-2')
            .spec(),
        ]),
        // the dropped session's folder is removed by a file system call that runs on its own:
        // the sleep lets it end, so that the second thread's folder has the same name on both sides
        steps(stream({ sessionId: 's' }), { sleep: 1 }, stream({ sessionId: 's' })),
      ),
      // Codex turned off: the process serves the run and ends
      c(w([ok('while off').spec()]), steps({ off: true }, stream({ sessionId: 'off' }))),
      c(
        w([ok('turned back on').spec()]),
        steps({ off: true }, { off: false }, stream({ sessionId: 'on' })),
      ),
      // the login changed after the first run: the idle process ends, the next run starts another
      c(
        w([ok('first').spec(), ok('second').spec()]),
        steps(stream({ sessionId: 'a' }), { login: true }, stream({ sessionId: 'b' })),
      ),
      // the pool: one process serves two runs
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(done('first'))
            .req(CHATGPT)
            .req({ config: { mcp_servers: {} } })
            .req(thread('thread-2'))
            .req({ data: [] })
            .turn(done('second', [], 'turn-2', 'thread-2'), 'turn-2')
            .spec(),
        ]),
        steps(stream({ sessionId: 'a' }), stream({ sessionId: 'b' })),
      ),
      // idle shutdown
      c(
        w([ok('then idle').spec(), ok('after idle').spec()]),
        steps(stream({ sessionId: 'a' }), { sleep: 130000 }, stream({ sessionId: 'a' })),
      ),
      c(w([ok('busy').spec()]), steps(stream({ sessionId: 'a' }), { sleep: 100000 })),
      // Windows: the program entry is lower case in the pool
      c(w([ok('windows').spec()], { platform: 'win32' }), {
        ...steps(stream({ sessionId: 'w' })),
        entry: 'C:\\Tools\\Codex.EXE',
      }),
    ],
  },
}

const manySessions = (): Case => {
  const kid = new Kid().start()
  const list: Step[] = []
  for (let i = 0; i < 65; i++) {
    kid
      .req(CHATGPT)
      .req({ config: { mcp_servers: {} } })
      .req(thread(`thread-${i}`))
      .req({ data: [] })
    // the 65th session pushes the oldest out: its thread is deleted
    if (i === 64) kid.hang()
    kid.turn(done(`r${i}`, [], `turn-${i}`, `thread-${i}`), `turn-${i}`)
    list.push(stream({ sessionId: `s${i}` }))
  }
  return c(w([kid.spec()]), { steps: list })
}

const mcpPages = (last: string | null): Kid => {
  const kid = new Kid()
    .start()
    .req(CHATGPT)
    .req({ config: { mcp_servers: {} } })
    .req(thread())
  for (let page = 0; page < 10; page++)
    kid.req({ data: [], nextCursor: page < 9 ? `p${page}` : last })
  return kid.turn(done('paged'))
}

const started = note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })

const moreStreamCases: Case[] = [
  // a byte order mark at the start of stdout is part of the first line
  c(w([ok('bom').spec({ stdout: [{ hex: 'efbbbf' }] })]), steps(stream())),
  // two runs started together share one process. Both are signed out: a run that goes on makes a
  // folder, and a real file system call is slower than the answers of a scripted child, so the
  // order of two runs that go on would depend on the file system
  c(
    w([new Kid().start().req(SIGNED_OUT).req(SIGNED_OUT).spec()]),
    steps({ all: [stream({ sessionId: 'a' }), stream({ sessionId: 'b' })] }),
  ),
  c(
    w([new Kid().start().req(CHATGPT).req(CHATGPT).req(MODEL_PAGE).req(MODEL_PAGE).spec()]),
    steps({ all: [{ models: {} }, { models: {} }] }),
  ),
  // the process cannot be started: both runs fail
  c(w([]), steps({ all: [stream({ sessionId: 'a' }), stream({ sessionId: 'b' })] })),
  // the idle timer is not up yet
  c(w([ok('idle').spec()]), steps(stream({ sessionId: 'a' }), { sleep: 115000 })),
  c(
    w([ok('idle').spec(), ok('again').spec()]),
    steps(stream({ sessionId: 'a' }), { sleep: 121000 }, stream({ sessionId: 'a' })),
  ),
  manySessions(),
  // ten pages of MCP servers, all checked; and one more page than is read
  c(w([mcpPages(null).spec()]), steps(stream())),
  c(w([mcpPages('more').spec()]), steps(stream())),
  // the stderr tail of an exit is bounded
  c(
    w([
      {
        replies: new Kid().start().open().turn(started).replies,
        closeOn: 7,
        stderr: [{ fill: 97, size: 20000 }, '\ntail\n'],
      },
    ]),
    steps(stream()),
  ),
  // an MCP server that is ready after the switch-off
  c(
    w([
      new Kid()
        .start()
        .req(CHATGPT)
        .req({ config: { mcp_servers: {} } })
        .req(thread())
        .req({ data: [] }, note('mcpServer/startupStatus/updated', { status: 'ready' }))
        .spec(),
    ]),
    steps(stream()),
  ),
  // the same messages again: nothing new to send
  c(
    w([
      new Kid()
        .start()
        .open()
        .turn(done('first'))
        .req(CHATGPT)
        .turn(done('second', [], 'turn-2'), 'turn-2')
        .spec(),
    ]),
    steps(stream({ sessionId: 'eq' }), stream({ sessionId: 'eq' })),
  ),
  // Windows compares program paths without case
  c(
    w(
      [
        new Kid()
          .start()
          .open()
          .turn(done('first'))
          .req(CHATGPT)
          .req({ config: { mcp_servers: {} } })
          .req(thread('thread-2'))
          .req({ data: [] })
          .turn(done('second', [], 'turn-2', 'thread-2'), 'turn-2')
          .spec(),
      ],
      { platform: 'win32' },
    ),
    steps(
      stream({ config: { cliPath: 'C:\\Tools\\Codex.EXE' }, sessionId: 'a' }),
      stream({ config: { cliPath: 'c:\\tools\\codex.exe' }, sessionId: 'b' }),
    ),
  ),
]
streams['codex.streamCodexAppServer']!.cases.push(...moreStreamCases)

const chats: Group = {
  'codex.chatCodexAppServer': {
    ...scenarioSpec,
    cases: [
      c(w([ok('a short answer').spec()]), steps(chat())),
      c(
        w([ok('another answer').spec()]),
        steps(chat({ system: 'be terse', user: 'ping', config: { model: 'o3' } })),
      ),
      c(w([new Kid().start().req(SIGNED_OUT).spec()]), steps(chat())),
      c(
        w([new Kid().start().open().turn(rawAnswer('{"text":"","toolCalls":[]}')).spec()]),
        steps(chat()),
      ),
      c(
        w([
          new Kid()
            .start()
            .open()
            .turn(rawAnswer('{"text":"x","toolCalls":[{"id":"a","name":"t","inputJson":"{}"}]}'))
            .spec(),
        ]),
        steps(chat()),
      ),
      c(
        w(
          [
            new Kid()
              .start()
              .open()
              .turn(note('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }))
              .quiet()
              .spec(),
          ],
          { abortAt: 500 },
        ),
        steps(chat()),
      ),
      c(w([]), steps(chat())),
    ],
  },
  'codex.readCodexAccount': {
    ...scenarioSpec,
    cases: [
      c(w([new Kid().start().req(CHATGPT).spec()]), steps({ account: {} })),
      c(
        w([new Kid().start().req(API_KEY).spec()]),
        steps({ account: { cliPath: '/custom/codex' } }),
      ),
      c(w([new Kid().start().req(SIGNED_OUT).spec()]), steps({ account: { signal: true } })),
      c(
        w([
          new Kid()
            .start()
            .req({ account: { type: 'enterprise' } })
            .spec(),
        ]),
        steps({ account: {} }),
      ),
      c(w([new Kid().start().req('not an account').spec()]), steps({ account: {} })),
      c(
        w([new Kid().start().err({ code: -32000, message: 'account failed' }).spec()]),
        steps({ account: {} }),
      ),
      c(w([new Kid().start().hang().spec()]), steps({ account: {} })),
      c(w([]), steps({ account: {} })),
      c(w([new Kid().start().req(CHATGPT).spec()]), steps({ account: { aborted: true } })),
      c(w([new Kid().start().hang().spec()], { abortAt: 0 }), steps({ account: { signal: true } })),
      c(
        w([new Kid().start().req(CHATGPT).spec()], { abortAt: 100000 }),
        steps({ account: { signal: true } }),
      ),
      // a failed read forgets the login kind the status check saw
      c(
        w([new Kid().start().req(API_KEY).err({ message: 'second failed' }).spec()]),
        steps({ account: {} }, { account: {} }, { account: {} }),
      ),
      c(
        w([new Kid().start().req(CHATGPT).req(API_KEY).req(API_KEY).spec()]),
        steps({ account: {} }, { account: {} }, { account: {} }),
      ),
    ],
  },
  'codex.listCodexModels': {
    ...scenarioSpec,
    cases: [
      c(w([modelPages().spec()]), steps({ models: {} })),
      c(
        w([new Kid().start().req(CHATGPT).req({ data: [] }).spec()]),
        steps({ models: { cliPath: '/custom/codex' } }),
      ),
      c(w([new Kid().start().req(SIGNED_OUT).spec()]), steps({ models: {} })),
      c(
        w([
          new Kid()
            .start()
            .req(CHATGPT)
            .req({
              data: [
                { id: 'a' },
                { id: 'a', isDefault: true },
                { model: 'b', isDefault: true },
                { id: '' },
                { id: 'c', isDefault: true },
                null,
                5,
              ],
            })
            .spec(),
        ]),
        steps({ models: {} }),
      ),
      c(
        w([
          new Kid()
            .start()
            .req({ requiresOpenaiAuth: true, account: { type: 'chatgpt' } })
            .req({ data: [{ id: 'x' }], nextCursor: '' })
            .spec(),
        ]),
        steps({ models: {} }),
      ),
      c(
        w([
          (() => {
            const kid = new Kid().start().req(CHATGPT)
            for (let page = 0; page < 11; page++)
              kid.req({ data: [{ id: `m${page}` }], nextCursor: `p${page}` })
            return kid.spec()
          })(),
        ]),
        steps({ models: {} }),
      ),
      c(
        w([
          new Kid().start().req(CHATGPT).err({ code: -32601, message: 'Method not found' }).spec(),
        ]),
        steps({ models: {} }),
      ),
      c(w([new Kid().start().req('junk').req({ data: 'junk' }).spec()]), steps({ models: {} })),
      c(w([]), steps({ models: {} })),
    ],
  },
  'codex.listCodexSubscriptionModels': {
    ...scenarioSpec,
    cases: [
      c(w([new Kid().start().req(MODEL_PAGE).spec()]), steps({ subModels: {} })),
      c(
        w([
          new Kid()
            .start()
            .req({ data: [{ id: 'one' }] })
            .spec(),
        ]),
        steps({ subModels: { cliPath: '/custom/codex', signal: true } }),
      ),
      c(w([new Kid().start().req({ data: [] }).spec()]), steps({ subModels: {} })),
      c(w([new Kid().start().req(MODEL_PAGE).spec()]), steps({ subModels: { aborted: true } })),
      c(
        w([new Kid().start().hang().spec()], { abortAt: 0 }),
        steps({ subModels: { signal: true } }),
      ),
      c(
        w([new Kid().start().err({ code: -32601, message: 'Method not found' }).spec()]),
        steps({ subModels: {} }),
      ),
      c(
        w([
          new Kid()
            .start()
            .req({ data: [{ id: 'a' }], nextCursor: 'n' })
            .req({ data: [{ id: 'b', isDefault: true }] })
            .spec(),
        ]),
        steps({ subModels: {} }, { subModels: {} }),
      ),
      c(w([]), steps({ subModels: {} })),
      c(
        w(
          [
            new Kid()
              .start()
              .req({ data: [{ id: 'a' }] })
              .spec(),
          ],
          { abortAt: 100000 },
        ),
        steps({ subModels: { signal: true } }),
      ),
    ],
  },
  'codex.shutdownCodexAppServers': {
    ...scenarioSpec,
    cases: [
      c(w([]), steps({ shutdown: true })),
      c(w([ok('kept').spec()]), steps(stream({ sessionId: 'a' }), { shutdown: true })),
      c(
        w([
          modelPages().spec(),
          new Kid()
            .start()
            .req(CHATGPT)
            .req({ data: [{ id: 'z' }] })
            .spec(),
        ]),
        steps(
          { models: {} },
          { models: { cliPath: '/other/codex' } },
          { shutdown: true },
          { sleep: 200000 },
        ),
      ),
      c(
        w([ok('busy').spec()]),
        steps(
          stream({ sessionId: 'a' }),
          { sleep: 10 },
          { shutdown: true },
          stream({ sessionId: 'b' }),
        ),
      ),
    ],
  },
  'codex.setCodexAppServerRuntime': {
    ...scenarioSpec,
    cases: [
      // the resolver is replaced: its failure reaches the caller
      c(w([]), { ...steps(stream()), resolveError: 'no such program' }),
      c(w([]), { ...steps({ models: {} }), resolveError: 'resolver down' }),
      // the process-ending call is replaced
      c(w([ok('hooked').spec()]), {
        ...steps(stream({ sessionId: 'a' }), { login: true }),
        hookKill: true,
      }),
      c(w([ok('hooked').spec()]), {
        ...steps(stream({ sessionId: 'a' }), { shutdown: true }),
        hookKill: true,
      }),
      c(w([ok('unhooked').spec()]), steps(stream({ sessionId: 'a' }), { shutdown: true })),
    ],
  },
  'codex.parseCodexAppServerTurn': {
    ts: ([world, o]: unknown[], cx: TsContext) =>
      inWorld(world as World, cx, async () => {
        const { raw, tools } = o as { raw: string; tools?: string[] }
        try {
          return mod.parseCodexAppServerTurn(raw, (tools ?? []).map((name) => ({ name })) as Any)
        } catch (error) {
          return threw(error)
        }
      }),
    cases: [
      c(w([]), { raw: '{"text":"hi","toolCalls":[]}' }),
      c(w([]), { raw: '  ```json\n{"text":"fenced","toolCalls":[]}\n```  ' }),
      c(w([]), { raw: '```\n{"text":"bare fence","toolCalls":[]}```' }),
      c(w([]), { raw: '```JSON {"text":"upper","toolCalls":[]}' }),
      c(w([]), {
        raw: '{"text":"","toolCalls":[{"id":"a","name":"edit","inputJson":"{\\"x\\":1}"},{"name":"edit","inputJson":"not json"},{"id":"","name":"edit"},{"id":7,"name":"edit","inputJson":"[1]"}]}',
        tools: ['edit'],
      }),
      c(w([]), { raw: '{"text":"","toolCalls":[]}' }),
      c(w([]), {
        raw: '{"text":"x","toolCalls":[{"id":"a","name":"nope","inputJson":"{}"}]}',
        tools: ['edit'],
      }),
      c(w([]), { raw: '{"text":"x","toolCalls":[{"id":"a","name":5}]}', tools: ['edit'] }),
      c(w([]), { raw: '{"text":"x","toolCalls":["a"]}', tools: ['edit'] }),
      c(w([]), { raw: '{"text":"x"}' }),
      c(w([]), { raw: '{"toolCalls":[]}' }),
      c(w([]), { raw: 'null' }),
      c(w([]), { raw: '[]' }),
      c(w([]), { raw: '{"text":' }),
      c(w([]), { raw: '' }),
      c(w([]), {
        raw: `{"text":"x","toolCalls":[{"id":"a","name":"edit","inputJson":"${'a'.repeat(512001)}"}]}`,
        tools: ['edit'],
      }),
    ],
  },
}

export const group: Group = { ...pure, ...attach, ...waits, ...streams, ...chats }
