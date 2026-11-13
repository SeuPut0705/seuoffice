/**
 * Group `b5-provider`, part `agent` (Rust: crates/main-core/src/calls/b5_provider/agent.rs):
 * packages/ai-provider/src/agent-session/{codex,codex-sandbox-probe,messages,types}.ts
 * (agent-session.ts only re-exports them). Names are
 * `agent-session/<file>.<export>`.
 *
 * - the pure functions take the TypeScript's arguments as JSON; `options` is
 *   the session options object (`projectRoot`, `openDocuments`, ...), and the
 *   Rust side fills what a case leaves out.
 * - `codexAgentReadableDirs(pathValue, options, platform, existing)`: `exists`
 *   is `(dir) => existing.includes(dir)`.
 * - `probeCodexSandbox(world, o)`: `o` is `{ filesystem, probeDir, timeoutMs,
 *   network, killTree }`; the program is the one `o.cliPath` resolves to
 *   (a file of the case). `killTree: 'log'` replaces the default by a log
 *   line `['log', 'info', 'killtree', pid]`.
 * - `startCodexAgentSession(world, sc)`: a scenario. `sc.options` are the
 *   session options plus `meteredAccepted`, `webSearch`, `network`;
 *   `sc.deps` is `{ platform, idleMs, threadStartTimeoutMs, killTree: 'log',
 *   probe: 'contained' | 'not-contained' | 'unavailable' }` (`probe` replaces
 *   the sandbox check by a function that logs `['log', 'info', 'probe',
 *   filesystem, probeDir, network]`); `sc.steps` run in order after the start:
 *   `{ send }`, `{ answer: id, allow }`, `{ docs }`, `{ sleep }`, `{ stop }`.
 *   Every session event is the log line `['log', 'info', 'event', event]`; the
 *   outcome of a step, `['log', 'info', 'sent']` or `['log', 'info',
 *   'send-failed', error]`; a failed start `['log', 'info', 'start-failed',
 *   error]` with the error as `{ name, message, kind, problem, code,
 *   provider }` (what is there). The program is the one `options.cliPath`
 *   resolves to; the world's first child is the program (the sandbox check's
 *   child first on win32 without `probe`). The child answers the k-th write
 *   to its stdin with `replies[k]`: `replies(stages, more)` builds them with
 *   the request ids the session counts (the `initialized` notification is
 *   the second write, without an answer).
 */
import '../../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'
import { inWorld, uuidOf, type Chunk, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const codex = await import('../../../../packages/ai-provider/src/agent-session/codex.ts')
const probe =
  await import('../../../../packages/ai-provider/src/agent-session/codex-sandbox-probe.ts')
const messages = await import('../../../../packages/ai-provider/src/agent-session/messages.ts')
const types = await import('../../../../packages/ai-provider/src/agent-session/types.ts')
const locate = await import('../../../../packages/ai-provider/src/subscription/locate.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const c = (...args: unknown[]): Case => ({ args })
const single = (why: string, ...args: unknown[]): Pick<FnSpec, 'cases' | 'single'> => ({
  single: why,
  cases: [c(...args)],
})

// ---------------------------------------------------------------------------
// the pure part
// ---------------------------------------------------------------------------

const ROOT = '/work/project'
const options = (over: Record<string, unknown> = {}) => ({
  projectRoot: ROOT,
  openDocuments: [`${ROOT}/a.docx`, '/docs/b.docx'],
  protectedPaths: ['/home/u/.codex', '/secret'],
  skillBundleDir: '/skills',
  ...over,
})

const relay = (
  name: string,
  tools: string[] = ['search'],
  extra: Record<string, unknown> = {},
) => ({
  name,
  url: `http://127.0.0.1:9/${name}`,
  token: `tok-${name}`,
  tools,
  ...extra,
})

const pure: Group = {
  'agent-session/codex.codexAgentLaunchArgs': {
    ts: ([webSearch]) => codex.codexAgentLaunchArgs(webSearch as Any),
    cases: [c(), c('cached'), c('live'), c('disabled'), c('bogus'), c(null), c(5)],
  },
  'agent-session/codex.codexAgentApprovalPolicy': {
    ts: ([mode]) => codex.codexAgentApprovalPolicy(mode as Any),
    cases: [c('ask-commands'), c('ask-writes'), c('trust-project')],
  },
  'agent-session/codex.codexAgentFilesystem': {
    ts: ([o, readable]) => codex.codexAgentFilesystem(o as Any, readable as Any),
    cases: [
      c(options()),
      c(options(), ['/usr/bin', '/opt/node/bin']),
      c(options({ skillBundleDir: undefined, openDocuments: [] }), []),
      c(options({ skillBundleDir: '' })),
      c(options({ openDocuments: [ROOT] })),
      c(options({ protectedPaths: [ROOT] })),
      c(options(), [ROOT, '/skills']),
      c(options({ openDocuments: ['/home/u/.codex'] })),
    ],
  },
  'agent-session/codex.codexProfilePathsLiteral': {
    ts: ([filesystem]) => codex.codexProfilePathsLiteral(filesystem as Any),
    cases: [
      c({ ':minimal': 'read', '/p': 'write' }),
      c({ ':minimal': 'read', '/p/*.txt': 'write' }),
      c({ ':minimal': 'read', '/p/a?b': 'read' }),
      c({ ':minimal': 'read', '/p/[x]': 'deny' }),
      c({ ':minimal': 'read', '/p/]': 'deny' }),
      c({}),
      c({ '/ok/dir': 'read', '/p/a[': 'read' }),
    ],
  },
  'agent-session/codex.codexAgentReadableDirs': {
    ts: ([pathValue, o, platform, existing]) =>
      codex.codexAgentReadableDirs(pathValue as Any, o as Any, platform as Any, (dir) =>
        (existing as string[]).includes(dir),
      ),
    cases: [
      c(
        '/usr/bin:/usr/local/bin:"/opt/x":relative/bin:/:/work/project/tools:/work/project:/secret/bin:/missing:/usr/bin:/a*b:/usr/bin/: /opt/y ::',
        options(),
        'linux',
        [
          '/usr/bin',
          '/usr/local/bin',
          '/opt/x',
          '/work/project/tools',
          '/secret/bin',
          '/usr/bin/',
          '/opt/y',
        ],
      ),
      c(null, options(), 'linux', []),
      c('', options(), 'darwin', ['']),
      c('/usr/bin:/bin', options(), 'darwin', ['/usr/bin']),
      c('/usr/bin:/bin', options(), 'linux', ['/usr/bin', '/bin']),
      c('"/quoted"', options(), 'linux', ['/quoted']),
      c('/a/../b:/b', options(), 'linux', ['/a/../b', '/b']),
      c(
        'C:\\Windows;C:\\Tools;"D:\\Apps\\bin";C:\\;c:\\windows;C:\\work\\project\\inner;C:\\Secret\\x;\\\\server\\share;rel\\dir;C:/Slash/Dir',
        options({
          projectRoot: 'C:\\work\\project',
          protectedPaths: ['C:\\Secret'],
          openDocuments: [],
        }),
        'win32',
        [
          'C:\\Windows',
          'C:\\Tools',
          'D:\\Apps\\bin',
          'C:\\',
          'c:\\windows',
          'C:\\work\\project\\inner',
          'C:\\Secret\\x',
          '\\\\server\\share',
          'C:/Slash/Dir',
        ],
      ),
      c('/usr/bin:/bin', options({ protectedPaths: ['/usr'] }), 'linux', ['/usr/bin', '/bin']),
    ],
  },
  'agent-session/codex.codexAgentThreadParams': {
    ts: ([o, model, userMcp, readable]) =>
      codex.codexAgentThreadParams(o as Any, model as string, userMcp as Any, readable as Any),
    cases: [
      c(options({ instructions: 'Be brief.', mode: 'ask-commands' }), 'gpt-5', {}),
      c(options({ instructions: 'x', mode: 'trust-project', network: true }), 'gpt-5', {
        docs: { enabled: false },
      }),
      c(options({ instructions: 'x', mode: 'ask-writes', network: false }), 'm', {}, ['/usr/bin']),
      c(
        options({
          instructions: 'with app',
          mode: 'ask-commands',
          appMcp: { url: 'http://127.0.0.1:1/mcp', token: 'app-token' },
        }),
        'gpt-5',
        {},
      ),
      c(
        options({
          instructions: 'relays',
          mode: 'ask-commands',
          userMcpRelays: [
            relay('notes'),
            relay('Notes'),
            relay('bad__name'),
            relay('seuoffice-editor'),
            relay('SEUOFFICE-EDITOR'),
            relay('_edge'),
            relay('edge_'),
            relay('ok-1'),
            relay('has space'),
          ],
          appMcp: { url: 'http://127.0.0.1:1/mcp', token: 'app-token' },
        }),
        'gpt-5',
        { notes: { enabled: false }, other: { enabled: false } },
      ),
      c(
        options({
          instructions: 'ordering',
          mode: 'ask-commands',
          userMcpRelays: [relay('5')],
        }),
        'gpt-5',
        { zeta: { enabled: false }, '10': { enabled: false }, '2': { enabled: false } },
      ),
      c(options({ instructions: '', mode: 'ask-commands', skillBundleDir: undefined }), '', {}),
    ],
  },
  'agent-session/codex.codexAgentAction': {
    ts: ([method, params, paths]) =>
      codex.codexAgentAction(
        method as string,
        params as Any,
        new Map(Object.entries((paths ?? {}) as Record<string, string[]>)),
      ),
    cases: [
      c('item/commandExecution/requestApproval', {
        command: 'ls -la',
        cwd: '/work/project',
        reason: 'list files',
        commandActions: [{ command: 'ls' }, { command: 'cat a' }],
      }),
      c('item/commandExecution/requestApproval', {}),
      c('item/commandExecution/requestApproval', {
        command: '',
        cwd: 5,
        reason: '',
        commandActions: [null, 'x', { command: '' }, { command: 3 }, []],
      }),
      c('item/commandExecution/requestApproval', { command: 'x', commandActions: 'no' }),
      c(
        'item/fileChange/requestApproval',
        { itemId: 'i1', grantRoot: '/work', reason: 'edit' },
        { i1: ['/work/project/a.txt'] },
      ),
      c('item/fileChange/requestApproval', { itemId: 'zzz' }, { i1: ['/x'] }),
      c('item/fileChange/requestApproval', {}),
      c('item/fileChange/requestApproval', { itemId: 'i2', grantRoot: '' }, { i2: [] }),
      c('item/permissions/requestApproval', { reason: 'more' }),
      c('mcpServer/elicitation/request', {}),
    ],
  },
  'agent-session/codex.codexDeclineDecision': {
    ts: ([params]) => codex.codexDeclineDecision(params as Any),
    cases: [
      c({}),
      c({ availableDecisions: ['accept', 'decline'] }),
      c({ availableDecisions: ['cancel'] }),
      c({ availableDecisions: [] }),
      c({ availableDecisions: 'decline' }),
      c({ availableDecisions: [{ decision: 'decline' }] }),
    ],
  },
  'agent-session/codex.codexAppMcpExtraTools': {
    ts: ([statusList, relays]) => codex.codexAppMcpExtraTools(statusList as Any, relays as Any),
    cases: [
      c(null),
      c({ data: 'x' }),
      c({}),
      c({ data: [] }),
      c({
        data: [
          {
            name: 'seuoffice-editor',
            tools: {
              read_document: {},
              'mcp__seuoffice-editor__apply_ops': {},
              delete_everything: {},
              'mcp__seuoffice-editor__rm': {},
            },
          },
        ],
      }),
      c({ data: [{ name: 'seuoffice-editor', tools: null }, { name: 'seuoffice-editor' }] }),
      c(
        {
          data: [
            {
              name: 'notes',
              tools: { search: {}, mcp__notes__search: {}, mcp__notes__write: {}, write: {} },
            },
            { name: 'other', tools: { anything: {} } },
            null,
            'x',
            { name: 5, tools: { x: {} } },
            { tools: { y: {} } },
            { name: 'bad__name', tools: { z: {} } },
          ],
        },
        [relay('notes', ['search']), relay('bad__name', [])],
      ),
      c({ data: [{ name: 'notes', tools: { mcp__other__x: {} } }] }, [relay('notes', [])]),
      c({ data: [{ name: 'notes', tools: { search: {} } }] }, [relay('notes', ['search'])]),
      c({ data: [{ name: 'seuoffice-editor', tools: { 'mcp__seuoffice-editor__': {} } }] }, []),
    ],
  },
  'agent-session/codex.codexElicitationAnswer': {
    ts: ([params, relays]) => codex.codexElicitationAnswer(params as Any, relays as Any),
    cases: [
      c({
        serverName: 'seuoffice-editor',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
      c({
        serverName: 'seuoffice-editor',
        mode: 'url',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
      c({ serverName: 'seuoffice-editor', mode: 'form', _meta: { codex_approval_kind: 'other' } }),
      c({ serverName: 'seuoffice-editor', mode: 'form' }),
      c({ serverName: 'seuoffice-editor', mode: 'form', _meta: 'x' }),
      c({ serverName: 'seuoffice-editor', mode: 'form', _meta: [] }),
      c({ serverName: 'other', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } }),
      c({ serverName: 'notes', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } }, [
        relay('notes'),
      ]),
      c({ serverName: 'notes', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } }, [
        relay('bad__name'),
      ]),
      c(
        { serverName: 'bad__name', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } },
        [relay('bad__name')],
      ),
      c({}),
    ],
  },
  'agent-session/codex.THREAD_START_TIMEOUT_MS': {
    ts: () => codex.THREAD_START_TIMEOUT_MS,
    ...single('a constant'),
  },
  'agent-session/codex.CODEX_AGENT_PROFILE': {
    ts: () => codex.CODEX_AGENT_PROFILE,
    ...single('a constant'),
  },
  'agent-session/codex.AgentSandboxUnavailableError': {
    ts: () => {
      const e = new codex.AgentSandboxUnavailableError()
      return { name: e.name, message: e.message, kind: e.kind, isError: e instanceof Error }
    },
    ...single('a class with no input'),
  },
  'agent-session/codex-sandbox-probe.tomlInlineTable': {
    ts: ([values]) => probe.tomlInlineTable(values as Any),
    cases: [
      c({}),
      c({ ':minimal': 'read' }),
      c({ '/p': 'write', '/q"x': 'deny', 'C:\\dir': 'read', '/ü/日本': 'read' }),
      c({ '10': 'read', a: 'write', '2': 'deny' }),
    ],
  },
  'agent-session/codex-sandbox-probe.codexSandboxProbeArgs': {
    ts: ([filesystem, dir, network]) =>
      probe.codexSandboxProbeArgs(filesystem as Any, dir as string, network as Any),
    cases: [
      c({ ':minimal': 'read', '/work': 'write' }, '/tmp/probe'),
      c({ ':minimal': 'read' }, '/tmp/probe', true),
      c({ ':minimal': 'read' }, '/tmp/probe', false),
      c({ '/tmp/probe': 'write', '/tmp/probe/denied': 'write' }, '/tmp/probe'),
      c({}, '/a b/probe/'),
    ],
  },
  'agent-session/codex-sandbox-probe.codexSandboxProbeVerdict': {
    ts: ([stdout]) => probe.codexSandboxProbeVerdict(stdout as string),
    cases: [
      c(''),
      c('C:\\x\\seuoffice-probe-readable.txt\r\n'),
      c('C:\\x\\seuoffice-probe-readable.txt\r\nC:\\x\\denied\\seuoffice-probe-denied.txt\r\n'),
      c('C:\\X\\DENIED\\SEUOFFICE-PROBE-DENIED.TXT'),
      c('/x/seuoffice-probe-readable.txt\n/x/denied/seuoffice-probe-denied.txt'),
      c('seuoffice-probe-readable.txt'),
      c('xseuoffice-probe-readable.txt'),
      c('  C:\\y\\seuoffice-probe-readable.txt  \n\n'),
      c('Access is denied.\r\nFINDSTR: Cannot open C:\\x\\denied\\seuoffice-probe-denied.txt'),
      c('\ufeffC:\\y\\seuoffice-probe-readable.txt'),
      c('C:\\y\\seuoffice-probe-readable.txt\u2028'),
    ],
  },
  'agent-session/messages.DECLINED_BY_PERSON': {
    ts: () => messages.DECLINED_BY_PERSON,
    ...single('a constant'),
  },
  'agent-session/messages.denyMessage': {
    ts: ([reason]) => messages.denyMessage(reason as Any),
    cases: [c('open-document'), c('outside-project'), c('protected-path')],
  },
  'agent-session/types.AGENT_PERMISSION_MODES': {
    ts: () => [...types.AGENT_PERMISSION_MODES],
    ...single('a constant'),
  },
  'agent-session/types.DEFAULT_AGENT_PERMISSION_MODE': {
    ts: () => types.DEFAULT_AGENT_PERMISSION_MODE,
    ...single('a constant'),
  },
  'agent-session/types.AGENT_CODEX_WEB_SEARCH': {
    ts: () => [...types.AGENT_CODEX_WEB_SEARCH],
    ...single('a constant'),
  },
  'agent-session/types.isAgentPermissionMode': {
    ts: ([value]) => types.isAgentPermissionMode(value),
    cases: [
      c('ask-commands'),
      c('ask-writes'),
      c('trust-project'),
      c('Ask-Commands'),
      c(''),
      c(null),
      c(5),
      c(['ask-commands']),
      c({}),
      c(true),
    ],
  },
}

// ---------------------------------------------------------------------------
// the worlds: the sandbox check and the sessions
// ---------------------------------------------------------------------------

const CLI_FILES = { 'bin/codex': { text: '#!/bin/sh\nexit 0\n', mode: 0o755 } }
const CLI = '$DIR/bin/codex'
const PATHS = { PATH: '$DIR/bin:/usr/bin' }

const w = (children: unknown[], more: Partial<World> = {}): World =>
  ({ children, env: { ...PATHS }, ...more }) as World

const line = (...objects: unknown[]): Chunk => objects.map((o) => `${JSON.stringify(o)}\n`).join('')
type Reply = { stdout?: Chunk[]; stderr?: Chunk[] }
type Stage = { result: unknown } | { error: unknown } | null
const ok = (result: unknown): Stage => ({ result })
const fail = (code: number, message: string): Stage => ({ error: { code, message } })

/**
 * The child's answers to the writes of a start: one stage per request, in
 * order (null: no answer), the `initialized` notification after the first;
 * `more` are the answers to the writes after them.
 */
function replies(stages: Stage[], more: Reply[] = []): Reply[] {
  const out: Reply[] = []
  stages.forEach((stage, i) => {
    const id = i + 1
    if (stage === null) out.push({})
    else if ('error' in stage) out.push({ stdout: [line({ id, error: stage.error })] })
    else out.push({ stdout: [line({ id, result: stage.result })] })
    if (i === 0) out.push({})
  })
  return [...out, ...more]
}
const said = (...chunks: Chunk[]): Reply => ({ stdout: chunks })

const INIT = ok({ userAgent: 'codex/0.0' })
const ACCOUNT = ok({
  account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' },
  requiresOpenaiAuth: true,
})
const API_KEY = ok({ account: { type: 'apiKey' }, requiresOpenaiAuth: false })
const CONFIG = ok({ config: { mcp_servers: { docs: { command: 'x' }, 'seuoffice-editor': {} } } })
const thread = (over: Record<string, unknown> = {}) =>
  ok({
    approvalPolicy: 'untrusted',
    activePermissionProfile: { id: 'seuoffice-agent' },
    sandbox: { networkAccess: false },
    thread: { id: 'thr-1' },
    ...over,
  })
const STATUS = ok({
  data: [
    { name: 'seuoffice-editor', runtimeStatus: 'ready', tools: { read_document: {} } },
    { name: 'docs', runtimeStatus: 'disabled', tools: {} },
  ],
  nextCursor: null,
})
const HAPPY: Stage[] = [INIT, ACCOUNT, CONFIG, thread(), STATUS]
/** the thread of a session that trusts the project: Codex asks nothing */
const NEVER: Stage[] = [INIT, ACCOUNT, CONFIG, thread({ approvalPolicy: 'never' }), STATUS]
/** the id of the request after the stages */
const next = (stages: Stage[]): number => stages.length + 1

const turnOk = (id: number): Chunk => line({ id, result: { turn: { id: 'turn-1' } } })
const started: Chunk = line({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
const done = (status = 'completed', error?: unknown): Chunk =>
  line({
    method: 'turn/completed',
    params: { turn: { id: 'turn-1', status, ...(error ? { error } : {}) } },
  })
const approval = (id: string, method: string, params: Record<string, unknown>): Chunk =>
  line({ id, method, params })
const cmdApproval = (id: string, command: string, over: Record<string, unknown> = {}): Chunk =>
  approval(id, 'item/commandExecution/requestApproval', {
    command,
    cwd: '$DIR/project',
    reason: 'because',
    commandActions: [{ command }],
    ...over,
  })

const session = (over: Record<string, unknown> = {}) => ({
  projectRoot: '$DIR/project',
  mode: 'ask-commands',
  model: 'gpt-test',
  instructions: 'Be brief.',
  openDocuments: ['$DIR/project/open.docx'],
  protectedPaths: ['$DIR/secret'],
  sessionDir: '$DIR/session',
  meteredAccepted: false,
  cliPath: CLI,
  ...over,
})

interface Scenario {
  options: Record<string, unknown>
  deps?: Record<string, unknown>
  steps?: Record<string, unknown>[]
}
const sc = (
  o: Record<string, unknown> = {},
  steps: Record<string, unknown>[] = [],
  deps: Record<string, unknown> = {},
): Scenario => ({ options: session(o), steps, deps })

const errInfo = (e: unknown): Record<string, unknown> => {
  const x = e as Any
  const out: Record<string, unknown> = { name: x?.name, message: x?.message }
  if (x?.kind !== undefined) out.kind = x.kind
  if (x?.problem !== undefined) out.problem = x.problem
  if (x?.code !== undefined) out.code = x.code
  if (x?.provider !== undefined) out.provider = x.provider
  return out
}

const killTreeLog = (child: { pid?: number }) => console.info('killtree', child.pid ?? null)

function depsOf(d: Record<string, unknown> = {}): Any {
  const out: Any = {}
  if (d.platform !== undefined) out.platform = d.platform
  if (d.idleMs !== undefined) out.idleMs = d.idleMs
  if (d.threadStartTimeoutMs !== undefined) out.threadStartTimeoutMs = d.threadStartTimeoutMs
  if (d.killTree === 'log') out.killTree = killTreeLog
  if (d.probe !== undefined) {
    out.probeSandbox = async (filesystem: unknown, probeDir: string, network: boolean) => {
      console.info('probe', filesystem, probeDir, network)
      return d.probe
    }
  }
  return out
}

async function runScenario(world: World, s: Scenario, cx: TsContext): Promise<unknown> {
  return inWorld(world, cx, async () => {
    let started: Any
    try {
      started = await codex.startCodexAgentSession(
        s.options as Any,
        (event) => console.info('event', event),
        depsOf(s.deps),
      )
    } catch (e) {
      console.info('start-failed', errInfo(e))
      return { started: false }
    }
    for (const step of s.steps ?? []) {
      if ('send' in step) {
        try {
          await started.send(step.send as string)
          console.info('sent')
        } catch (e) {
          console.info('send-failed', errInfo(e))
        }
      } else if ('answer' in step) {
        started.answer(
          step.answer as string,
          step.allow ? { allow: true } : { allow: false, message: 'no' },
        )
      } else if ('docs' in step) started.setOpenDocuments(step.docs as string[])
      else if ('sleep' in step) await new Promise((r) => setTimeout(r, step.sleep as number))
      else if ('stop' in step) started.stop()
    }
    return { started: true }
  })
}

interface ProbeOpts {
  cliPath: string
  probeDir: string
  filesystem?: Record<string, string>
  timeoutMs?: number
  network?: boolean
  killTree?: 'log'
}
const po = (over: Record<string, unknown> = {}) => ({
  cliPath: CLI,
  probeDir: '$DIR/probe',
  ...over,
})

const found = (name: string, dir = 'C:\\p'): string => `${dir}\\${name}\r\n`
const readableFound = found('seuoffice-probe-readable.txt')
const deniedFound = found('seuoffice-probe-denied.txt', 'C:\\p\\denied')
const WIN = { platform: 'win32' }
/** the sandbox check's child: prints, then ends */
const probeChild = (stdout: Chunk[], over: Record<string, unknown> = {}) => ({
  stdout,
  closeOn: 'start',
  ...over,
})
const withCli = (args: Case): Case => ({ ...args, files: CLI_FILES })

const nid = (n: number): string => uuidOf(n)
const noop: Reply = {}

const itemStarted = (item: Record<string, unknown>): Chunk =>
  line({ method: 'item/started', params: { item } })
const itemDone = (item: Record<string, unknown>): Chunk =>
  line({ method: 'item/completed', params: { item } })
const cmdItem = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id,
  command: 'ls',
  cwd: '$DIR/project',
  commandActions: [{ command: 'ls' }],
  ...over,
})
const fileItem = (id: string, paths: string[], over: Record<string, unknown> = {}) => ({
  type: 'fileChange',
  id,
  changes: paths.map((path) => ({ path, kind: 'update' })),
  ...over,
})
const fileApproval = (id: string, itemId: string, over: Record<string, unknown> = {}): Chunk =>
  approval(id, 'item/fileChange/requestApproval', { itemId, ...over })

/** a session over the stages, one send, and the answers of the turn */
const turn = (stages: Stage[], ...chunks: Chunk[]): Reply[] =>
  replies(stages, [said(turnOk(next(stages)), started, ...chunks)])

const starts = (
  children: unknown[],
  over: Record<string, unknown> = {},
  steps: Record<string, unknown>[] = [{ send: 'hello' }],
  deps: Record<string, unknown> = {},
  world: Partial<World> = {},
): Case => withCli(c(w(children, world), sc(over, steps, deps)))
const live = (stages: Stage[], ...chunks: Chunk[]) => ({ replies: turn(stages, ...chunks) })
const startOnly = (stages: Stage[], over: Record<string, unknown> = {}) =>
  starts([{ replies: replies(stages) }], over, [], {})

const modelList = (entries: unknown[], nextCursor: unknown = null): Stage =>
  ok({ data: entries, nextCursor })
const effortEntry = (id: string, efforts: string[], over: Record<string, unknown> = {}) => ({
  id,
  model: id,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  ...over,
})
const statusOf = (...data: unknown[]): Stage => ok({ data })
const MCP_UP = (name: string, status: string): Chunk =>
  line({ method: 'mcpServer/startupStatus/updated', params: { name, status } })
const ELICIT_OK = { mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } }

const worlds: Group = {
  'agent-session/codex-sandbox-probe.probeCodexSandbox': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const opts = o as ProbeOpts
        const program = await locate.resolveSubscriptionProgram('codex', {
          configuredPath: opts.cliPath,
        })
        const deps: Any = {}
        if (opts.timeoutMs !== undefined) deps.timeoutMs = opts.timeoutMs
        if (opts.network !== undefined) deps.network = opts.network
        if (opts.killTree === 'log') deps.killTree = killTreeLog
        return probe.probeCodexSandbox(
          program,
          (opts.filesystem ?? { ':minimal': 'read' }) as Any,
          opts.probeDir,
          deps,
        )
      }),
    cases: [
      withCli(c(w([probeChild([readableFound])]), po())),
      withCli(c(w([probeChild([readableFound, deniedFound])]), po())),
      withCli(c(w([probeChild([''])]), po())),
      withCli(c(w([probeChild([readableFound.slice(0, 20), readableFound.slice(20)])]), po())),
      withCli(c(w([probeChild([readableFound], { stderr: ['noise'] })]), po({ network: true }))),
      withCli(c(w([{ error: { message: 'spawn codex ENOENT', code: 'ENOENT' } }]), po())),
      withCli(c(w([]), po())),
      withCli(
        c(
          w([{ stdout: [readableFound], closeOn: 'never' }]),
          po({ timeoutMs: 5000, killTree: 'log' }),
        ),
      ),
      withCli(c(w([{ closeOn: 'never' }]), po({ timeoutMs: 5000 }))),
      withCli(c(w([probeChild([readableFound, 'x'.repeat(20000), deniedFound])]), po())),
      withCli(c(w([probeChild([readableFound], { exit: { code: 1 } })]), po())),
      withCli(
        c(
          w([probeChild([readableFound])]),
          po({
            filesystem: { ':minimal': 'read', '/work': 'write' },
            probeDir: '$DIR/deep/er/probe',
          }),
        ),
      ),
    ],
  },
  'agent-session/codex.startCodexAgentSession': {
    ts: ([world, s], cx) => runScenario(world as World, s as Scenario, cx),
    cases: [
      // ---- the start ----
      starts([live(HAPPY)]),
      starts([live(HAPPY, itemDone({ type: 'agentMessage', text: 'Hello there' }), done())]),
      starts([live(HAPPY)], { webSearch: 'live' }, []),
      starts([live(HAPPY)], { webSearch: 'disabled' }, []),
      starts([live(HAPPY)], { webSearch: 'nonsense', network: true }, []),
      starts([live(HAPPY)], { effort: '' }, []),
      starts([live(HAPPY)], {}, [], { killTree: 'log' }),
      starts([]),
      starts([{ error: { message: 'spawn codex EPERM', code: 'EPERM' } }]),
      starts([{ closeOn: 'start', stderr: ['boom: no network\n'], exit: { code: 3 } }]),
      starts([{ closeOn: 'start', stderr: ['x'.repeat(5000), 'tail'], exit: { code: 1 } }]),
      starts([{ closeOn: 'start', exit: { signal: 'SIGTERM' } }]),
      starts([{ replies: replies([null]) }], {}, [], {}),
      // ---- the login ----
      startOnly([INIT, ok({ requiresOpenaiAuth: true })]),
      startOnly([INIT, ok(null)]),
      startOnly([INIT, API_KEY]),
      startOnly([INIT, API_KEY, CONFIG, thread(), STATUS], { meteredAccepted: true }),
      startOnly([INIT, ok({}), CONFIG, thread(), STATUS], { meteredAccepted: true }),
      startOnly([INIT, ok({})]),
      startOnly([INIT, ok({ account: { type: 'other' } })]),
      startOnly([INIT, fail(-32000, 'login failed')]),
      // ---- the configuration ----
      startOnly([INIT, ACCOUNT, fail(-1, 'no config')]),
      startOnly([INIT, ACCOUNT, ok({})]),
      startOnly([INIT, ACCOUNT, ok({ config: {} }), thread(), STATUS]),
      startOnly([
        INIT,
        ACCOUNT,
        ok({ config: { mcp_servers: { b: {}, a: {}, '3': {} } } }),
        thread(),
        STATUS,
      ]),
      // ---- the model ----
      startOnly(
        [
          INIT,
          ACCOUNT,
          CONFIG,
          modelList([{ id: 'hidden-one', hidden: true }, { id: '', model: 'm2' }, { id: 'm3' }]),
          thread(),
          STATUS,
        ],
        { model: '  ' },
      ),
      startOnly(
        [
          INIT,
          ACCOUNT,
          CONFIG,
          modelList([{ id: 'm1' }, { id: 'm2', isDefault: true }]),
          thread(),
          STATUS,
        ],
        { model: '' },
      ),
      startOnly([INIT, ACCOUNT, CONFIG, modelList([{ id: 'm1', hidden: true }, null, 5])], {
        model: '',
      }),
      startOnly([INIT, ACCOUNT, CONFIG, modelList([])], { model: '' }),
      startOnly([INIT, ACCOUNT, CONFIG, ok(null)], { model: '' }),
      startOnly([INIT, ACCOUNT, CONFIG, fail(-1, 'no models')], { model: '' }),
      startOnly(
        [
          INIT,
          ACCOUNT,
          CONFIG,
          modelList([effortEntry('gpt-test', ['low', 'high'])]),
          thread(),
          STATUS,
        ],
        { effort: 'high' },
      ),
      starts(
        [
          live([
            INIT,
            ACCOUNT,
            CONFIG,
            modelList([effortEntry('gpt-test', ['low', 'high'])]),
            thread(),
            STATUS,
          ]),
        ],
        { effort: 'high' },
      ),
      starts(
        [
          live([
            INIT,
            ACCOUNT,
            CONFIG,
            modelList([effortEntry('gpt-test', ['low'])]),
            thread(),
            STATUS,
          ]),
        ],
        { effort: 'high' },
      ),
      starts(
        [
          live([
            INIT,
            ACCOUNT,
            CONFIG,
            modelList([effortEntry('m-default', ['medium'], { isDefault: true })]),
            thread(),
            STATUS,
          ]),
        ],
        { model: '', effort: 'medium' },
      ),
      starts([live([INIT, ACCOUNT, CONFIG, fail(-1, 'no list'), thread(), STATUS])], {
        effort: 'high',
      }),
      starts(
        [
          live([
            INIT,
            ACCOUNT,
            CONFIG,
            modelList([effortEntry('gpt-test', ['high'])]),
            thread(),
            STATUS,
          ]),
        ],
        { effort: 'bogus' },
      ),
      startOnly([INIT, ACCOUNT, CONFIG, null, thread(), STATUS], { effort: 'high' }),
      // ---- the thread ----
      startOnly([INIT, ACCOUNT, CONFIG, thread({ activePermissionProfile: { id: 'other' } })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ activePermissionProfile: undefined })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ approvalPolicy: 'never' })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ approvalPolicy: 'never' }), STATUS], {
        mode: 'trust-project',
      }),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ sandbox: { networkAccess: true } })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ sandbox: { networkAccess: true } }), STATUS], {
        network: true,
      }),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ sandbox: 'x' }), STATUS]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ thread: {} })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread({ thread: { id: 5 } })]),
      startOnly([INIT, ACCOUNT, CONFIG, ok(null)]),
      startOnly([INIT, ACCOUNT, CONFIG, fail(-32600, 'bad profile')]),
      startOnly([INIT, ACCOUNT, CONFIG, null]),
      starts([{ replies: replies([INIT, ACCOUNT, CONFIG, null]) }], {}, [], {
        threadStartTimeoutMs: 2000,
      }),
      // ---- the MCP servers ----
      startOnly([INIT, ACCOUNT, CONFIG, thread(), ok({ data: 'x' })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), statusOf(5)]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), ok(null)]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        statusOf({ name: 'docs', runtimeStatus: 'ready' }),
      ]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), statusOf({ name: 'evil', tools: { x: {} } })]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), statusOf({ runtimeStatus: 'ready' })]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        statusOf({ name: 'docs', runtimeStatus: 'disabled' }),
      ]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        statusOf({
          name: 'seuoffice-editor',
          runtimeStatus: 'ready',
          tools: { read_document: {}, rm: {}, 'mcp__seuoffice-editor__x': {} },
        }),
      ]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        statusOf({
          name: 'seuoffice-editor',
          runtimeStatus: 'ready',
          tools: { 'mcp__seuoffice-editor__apply_ops': {} },
        }),
      ]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        ok({ data: [{ name: 'seuoffice-editor', tools: {} }], nextCursor: 'c2' }),
        ok({ data: [{ name: 'docs', runtimeStatus: 'disabled' }], nextCursor: '' }),
      ]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        ok({ data: [], nextCursor: 'c2' }),
        ok({ data: [{ name: 'evil', runtimeStatus: 'ready' }], nextCursor: null }),
      ]),
      startOnly([
        INIT,
        ACCOUNT,
        CONFIG,
        thread(),
        ...Array.from({ length: 10 }, (_, i) => ok({ data: [], nextCursor: `c${i}` })),
      ]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), fail(-1, 'no status')]),
      startOnly([INIT, ACCOUNT, CONFIG, thread(), null]),
      // ---- relays and the app's own server ----
      starts(
        [
          live([
            INIT,
            ACCOUNT,
            ok({ config: { mcp_servers: { notes: {}, docs: {}, 'seuoffice-editor': {} } } }),
            thread(),
            statusOf(
              {
                name: 'notes',
                runtimeStatus: 'ready',
                tools: { search: {}, mcp__notes__search: {} },
              },
              { name: 'seuoffice-editor', runtimeStatus: 'ready', tools: { read_pdf: {} } },
              { name: 'docs', runtimeStatus: 'disabled' },
            ),
          ]),
        ],
        {
          userMcpRelays: [relay('notes'), relay('bad__name')],
          appMcp: { url: 'http://127.0.0.1:1/mcp', token: 'app-token' },
        },
      ),
      startOnly(
        [
          INIT,
          ACCOUNT,
          CONFIG,
          thread(),
          statusOf({ name: 'notes', runtimeStatus: 'ready', tools: { search: {}, write: {} } }),
        ],
        { userMcpRelays: [relay('notes')] },
      ),
      startOnly(
        [INIT, ACCOUNT, CONFIG, thread(), statusOf({ name: 'bad__name', runtimeStatus: 'ready' })],
        { userMcpRelays: [relay('bad__name')] },
      ),
      starts(
        [
          {
            replies: replies(
              [INIT, ACCOUNT, CONFIG, thread(), STATUS],
              [said(MCP_UP('evil', 'starting'))],
            ),
          },
        ],
        {},
        [{ send: 'hi' }],
      ),
      starts([
        {
          replies: replies(
            [INIT, ACCOUNT, CONFIG, thread()],
            [
              said(
                MCP_UP('seuoffice-editor', 'ready'),
                MCP_UP('docs', 'failed'),
                MCP_UP('evil', 'ready'),
              ),
            ],
          ),
        },
      ]),
      // ---- paths Codex reads as patterns ----
      starts([], { projectRoot: '$DIR/pro*ject' }, []),
      starts([], { protectedPaths: ['$DIR/sec[ret]'] }, []),
      starts([], { openDocuments: ['$DIR/project/a?.docx'] }, []),
      starts([live(HAPPY)], { skillBundleDir: '$DIR/skills' }, []),
      // ---- the sandbox check (Windows) ----
      starts([probeChild([readableFound]), live(HAPPY)], {}, [{ send: 'hello' }], WIN),
      starts([probeChild([readableFound]), live(HAPPY)], { network: true }, [], WIN),
      starts([probeChild([readableFound, deniedFound])], {}, [], WIN),
      starts([probeChild([''])], {}, [], WIN),
      starts([probeChild([readableFound]), live(HAPPY)], {}, [{ send: 'x' }, { stop: true }], WIN),
      starts([{ stdout: [readableFound], closeOn: 'never' }], {}, [], { ...WIN, killTree: 'log' }),
      starts([live(HAPPY)], {}, [], { platform: 'darwin' }),
      starts([live(HAPPY)], {}, [], { platform: 'win32', probe: 'contained' }),
      starts([], {}, [], { platform: 'win32', probe: 'unavailable' }),
      starts([], {}, [], { platform: 'win32', probe: 'not-contained' }),
      starts([live(HAPPY)], { network: true }, [], { platform: 'win32', probe: 'contained' }),
      // ---- a turn ----
      starts([
        live(
          HAPPY,
          itemDone({ type: 'agentMessage', text: '   ' }),
          itemDone({ type: 'agentMessage', text: 'Done. ' }),
          done(),
        ),
      ]),
      starts([
        live(
          HAPPY,
          itemStarted(cmdItem('c1')),
          itemDone(cmdItem('c1', { status: 'completed' })),
          itemStarted(cmdItem('c2', { command: '' })),
          itemDone(cmdItem('c2', { status: 'failed' })),
          itemStarted(fileItem('f1', ['$DIR/project/a.txt', '$DIR/project/b.txt'])),
          itemDone(fileItem('f1', ['$DIR/project/a.txt'], { status: 'declined' })),
          itemStarted({ type: 'webSearch', id: 'w1', query: 'weather' }),
          itemDone({ type: 'webSearch', id: 'w1', query: '', status: 'completed' }),
          itemStarted({
            type: 'mcpToolCall',
            id: 'm1',
            server: 'seuoffice-editor',
            tool: 'read_document',
          }),
          itemDone({ type: 'mcpToolCall', id: 'm1' }),
          itemStarted({ type: 'reasoning', id: 'r1' }),
          itemDone({ type: 'reasoning', id: 'r1' }),
          itemStarted({ id: 'x' }),
          line({ method: 'item/started', params: {} }),
          line({ method: 'item/completed', params: { item: 5 } }),
          done(),
        ),
      ]),
      starts([
        live(
          HAPPY,
          done('failed', { message: 'Usage limit hit', codexErrorInfo: 'usageLimitExceeded' }),
        ),
      ]),
      starts([
        live(HAPPY, done('failed', { message: 'Bad token', codexErrorInfo: 'unauthorized' })),
      ]),
      starts([
        live(
          HAPPY,
          done('failed', {
            message: 'Rejected',
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
          }),
        ),
      ]),
      starts([live(HAPPY, done('failed', { codexErrorInfo: 'other' }))]),
      starts([live(HAPPY, done('failed'))]),
      starts([
        live(
          HAPPY,
          line({
            method: 'error',
            params: { error: { message: 'stream broke' }, willRetry: false },
          }),
          done('failed'),
        ),
      ]),
      starts([
        live(
          HAPPY,
          line({ method: 'error', params: { message: 'warning shaped', willRetry: false } }),
          done('failed'),
          started,
          done('completed'),
        ),
      ]),
      starts([
        live(
          HAPPY,
          line({ method: 'error', params: { error: { message: 'retrying' }, willRetry: true } }),
          done('failed'),
        ),
      ]),
      starts([live(HAPPY, done('interrupted'))]),
      starts([live(HAPPY, done('weird'))]),
      starts([
        live(
          HAPPY,
          line({ method: 'turn/started', params: {} }),
          line({ method: 'turn/completed', params: {} }),
        ),
      ]),
      starts([live(HAPPY, line({ method: 'unknown/method', params: { a: 1 } }))]),
      // lines the reader does not understand
      starts([
        live(
          HAPPY,
          'not json\n',
          '[1,2]\n',
          '"x"\n',
          '5\n',
          'null\n',
          line({ id: 99, result: {} }),
          line({ id: 'x', result: {} }),
          line({ method: 5 }),
          done(),
        ),
      ]),
      starts([live(HAPPY, '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}')]),
      starts(
        [
          {
            replies: replies(HAPPY, [
              said(line({ id: next(HAPPY), error: { code: -32000, message: 'busy now' } })),
              said(turnOk(next(HAPPY) + 1)),
            ]),
          },
        ],
        {},
        [{ send: 'a' }, { send: 'b' }],
      ),
      starts(
        [
          {
            replies: replies(HAPPY, [
              said(line({ id: next(HAPPY), error: { code: 1.5, message: 5 } })),
              said(line({ id: next(HAPPY) + 1, error: 'plain' })),
              said(line({ id: next(HAPPY) + 2, error: { code: -1 } })),
            ]),
          },
        ],
        {},
        [{ send: 'a' }, { send: 'b' }, { send: 'c' }],
      ),
      starts([live(HAPPY)], {}, [{ send: 'a' }, { send: 'b' }]),
      starts([{ replies: replies(HAPPY, [noop]) }], {}, [{ send: 'a' }]),
      starts([live(HAPPY, done())], {}, [{ send: 'a' }, { send: 'b' }]),
      // ---- approvals ----
      starts(
        [
          live(
            HAPPY,
            cmdApproval('a1', 'ls -la'),
            cmdApproval('a2', 'make test', { availableDecisions: ['cancel'] }),
            cmdApproval(7 as unknown as string, 'echo 7'),
          ),
        ],
        {},
        [
          { send: 'go' },
          { answer: nid(1), allow: true },
          { answer: nid(2), allow: false },
          { answer: nid(1), allow: true },
          { answer: 'nope', allow: true },
          { answer: nid(3), allow: false },
        ],
      ),
      starts(
        [
          live(
            NEVER,
            cmdApproval('t1', 'rm -rf /'),
            cmdApproval('t2', 'cat $DIR/secret/token.txt'),
            cmdApproval('t3', 'cat "$DIR/secret/token.txt"', { availableDecisions: ['cancel'] }),
          ),
        ],
        { mode: 'trust-project' },
        [{ send: 'go' }],
      ),
      starts(
        [
          live(
            HAPPY,
            itemStarted(fileItem('f1', ['$DIR/project/new.txt'])),
            fileApproval('f-in', 'f1'),
            fileApproval('f-out', 'zzz', { grantRoot: '$DIR/other' }),
            fileApproval('f-open', 'zzz', { grantRoot: '$DIR/project/open.docx' }),
            fileApproval('f-secret', 'zzz', { grantRoot: '$DIR/secret' }),
            fileApproval('f-root', 'zzz', { grantRoot: '$DIR/project' }),
            fileApproval('f-cancel', 'zzz', {
              grantRoot: '$DIR/other',
              availableDecisions: ['cancel'],
            }),
            fileApproval('f-none', 'unknown'),
          ),
        ],
        {},
        [{ send: 'go' }],
      ),
      starts(
        [
          live(
            HAPPY,
            itemStarted(fileItem('f1', ['$DIR/project/new.txt'])),
            fileApproval('w1', 'f1'),
          ),
        ],
        { mode: 'ask-writes' },
        [{ send: 'go' }, { answer: nid(1), allow: true }],
      ),
      starts(
        [
          {
            replies: replies(HAPPY, [
              said(turnOk(next(HAPPY)), started, done()),
              said(
                turnOk(next(HAPPY) + 1),
                started,
                fileApproval('late', 'zzz', { grantRoot: '$DIR/project/new.docx' }),
              ),
            ]),
          },
        ],
        {},
        [{ send: 'one' }, { docs: ['$DIR/project/new.docx'] }, { send: 'two' }],
      ),
      starts(
        [
          live(
            HAPPY,
            approval('p1', 'item/permissions/requestApproval', { reason: 'more' }),
            approval('p2', 'item/tool/requestUserInput', {}),
            line({ id: 'p3', method: 'account/chatgptAuthTokens/refresh' }),
            approval('e1', 'mcpServer/elicitation/request', {
              serverName: 'seuoffice-editor',
              ...ELICIT_OK,
            }),
            approval('e2', 'mcpServer/elicitation/request', { serverName: 'docs', ...ELICIT_OK }),
            approval('e3', 'mcpServer/elicitation/request', { serverName: 'notes', ...ELICIT_OK }),
            line({ id: 'e4', method: 'mcpServer/elicitation/request', params: 'x' }),
            line({ id: 'e5', method: 'item/commandExecution/requestApproval', params: 'x' }),
          ),
        ],
        { userMcpRelays: [relay('notes')] },
        [{ send: 'go' }],
      ),
      // ---- the end ----
      starts([live(HAPPY, done())], {}, [{ send: 'a' }, { sleep: 1500 }, { send: 'b' }], {
        idleMs: 1000,
      }),
      starts([live(HAPPY, done())], {}, [{ send: 'a' }, { sleep: 1500 }], {
        idleMs: 1000,
        killTree: 'log',
      }),
      starts([live(HAPPY)], {}, [{ sleep: 1500 }], { idleMs: 1000 }),
      starts([live(HAPPY, done())], {}, [{ sleep: 900 }, { send: 'a' }, { sleep: 900 }], {
        idleMs: 1000,
      }),
      starts([live(HAPPY)], {}, [{ send: 'a' }, { stop: true }, { stop: true }, { send: 'b' }], {
        killTree: 'log',
      }),
      starts([live(HAPPY, done())], {}, [{ send: 'a' }, { stop: true }]),
      starts([live(HAPPY)], {}, [{ stop: true }, { answer: nid(1), allow: true }]),
      starts(
        [
          {
            replies: replies(HAPPY, [said(turnOk(next(HAPPY)), started)]),
            closeOn: next(HAPPY) + 1,
            exit: { code: 2 },
            stderr: ['crash log\n'],
          },
        ],
        {},
        [{ send: 'a' }, { sleep: 10 }],
      ),
      starts(
        [
          {
            replies: replies(HAPPY, [said(turnOk(next(HAPPY)), started)]),
            closeOn: next(HAPPY) + 1,
            exit: { signal: 'SIGKILL' },
          },
        ],
        {},
        [{ send: 'a' }, { sleep: 10 }, { send: 'b' }],
      ),
      starts(
        [
          {
            replies: replies(HAPPY, [said(turnOk(next(HAPPY)), started)]),
            closeOn: next(HAPPY) + 2,
          },
        ],
        {},
        [{ send: 'a' }, { stop: true }, { sleep: 10 }],
      ),
      starts(
        [{ replies: replies(HAPPY, [noop]), closeOn: next(HAPPY) + 1, exit: { code: 7 } }],
        {},
        [{ send: 'a' }],
      ),
    ],
  },
}

export const group: Group = { ...pure, ...worlds }
