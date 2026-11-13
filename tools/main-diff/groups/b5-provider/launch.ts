/**
 * Group `b5-provider`, part `launch` (Rust: crates/main-core/src/calls/b5_provider/launch.rs):
 * packages/ai-provider/src/subscription/{launch,status,service,ipc}.ts. The names are
 * `subscription/<file>.<export>`.
 *
 * The async functions run in the scripted world of world.ts (the first
 * argument; the second is `o`, what the call is given). The child processes a
 * launcher starts are the world's `children`, in spawn order. A program that
 * the CLI lookup finds is `locate`: `{ program }` (`ProgSpec`: `provider`,
 * `command`, `prefixArgs`, `env`, `entry`, `source`), `{ program: null }` or
 * `{ reject, code }`; the stand-in logs `['locate', provider, configuredPath]`.
 *
 * - launcher cases (`launch.*`): `o` is `provider`, `locate`, `configuredPath`,
 *   `platform`, `env`, `baseEnv`, `window`, `windowText`, `registry` (`none`),
 *   `timeoutMs`, `started` (`log`: the `onStarted` hook logs `['started']`;
 *   `stop`: and calls the stop it was given), `exit` (`onExit` logs
 *   `['exit']`), `killTree` (the stand-in logs `['killtree', pid]`), `listen`
 *   (a login listener logs `['login-change', provider]`).
 * - listener cases: `[ops]`, each `['on', name, 'throws'?]`, `['off', name]`,
 *   `['notify', provider]` or `['notifyOff', provider, off]`; a listener logs
 *   `['login' | 'off', name, value]`.
 * - detect cases: `o` is `provider`, `configuredPath`, `timeoutMs`, `locate`,
 *   `registered` (a Codex account source set with `setCodexAccountSource`),
 *   `account` (`off` or a source for this call): `{ value }` or `{ reject }`,
 *   logging `['account', configuredPath]`. A detection is written with its
 *   keys in the order of the interface.
 * - service, ipc cases: `o` is `ServiceOpts` (the settings, the acceptance
 *   record, the detections and model lists each provider answers in turn, the
 *   failures of the stand-ins) and `steps`, run one after the other (`par`:
 *   at the same time). Every stand-in logs its call.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const launch = await import('../../../../packages/ai-provider/src/subscription/launch.ts')
const statusMod = await import('../../../../packages/ai-provider/src/subscription/status.ts')
const serviceMod = await import('../../../../packages/ai-provider/src/subscription/service.ts')
const ipcMod = await import('../../../../packages/ai-provider/src/subscription/ipc.ts')
const contract = await import('../../../../packages/ai-provider/src/subscription/contract.ts')
const chatConn = await import('../../../../packages/ai-provider/src/chatgpt/connection.ts')
const chatCred = await import('../../../../packages/ai-provider/src/chatgpt/credentials.ts')
const imageBackend = await import('../../../../packages/ai-provider/src/image-backend.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const c = (...args: unknown[]): Case => ({ args })
const cn = (note: string, ...args: unknown[]): Case => ({ args, note })
/**
 * The world of a case. A program started without a stdin pipe (every launcher
 * here) is never told to end by the world, so a child that does not say how
 * it ends closes right after its output.
 */
const w = (more: Partial<World> = {}): World =>
  ({
    ...more,
    children: more.children?.map((child) =>
      child.error || child.closeOn !== undefined ? child : { ...child, closeOn: 'start' },
    ),
  }) as World

// ---------------------------------------------------------------------------
// what the cases share
// ---------------------------------------------------------------------------

interface ProgSpec {
  provider: string
  command: string
  prefixArgs?: string[]
  env?: Record<string, string>
  entry?: string
  source?: string
}
type LocateSpec = { program: ProgSpec | null } | { reject: string; code?: string }

const CLAUDE: ProgSpec = { provider: 'claude-code', command: '/opt/claude/bin/claude' }
const CODEX: ProgSpec = { provider: 'codex', command: '/opt/codex/bin/codex' }
const CODEX_NPM: ProgSpec = {
  provider: 'codex',
  command: '/usr/bin/node',
  prefixArgs: ['/home/u/.npm/node_modules/@openai/codex/bin/codex.js'],
  entry: '/home/u/.npm/node_modules/@openai/codex/bin/codex.js',
  env: { ELECTRON_RUN_AS_NODE: '1' },
  source: 'npm',
}
const CODEX_WINGET: ProgSpec = {
  provider: 'codex',
  command: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_x\\codex.exe',
  source: 'winget',
}
const CLAUDE_WIN: ProgSpec = {
  provider: 'claude-code',
  command: 'C:\\Users\\u\\.local\\bin\\claude.exe',
  prefixArgs: ['--flag'],
  env: { EXTRA: 'a b' },
}
const CODEX_WIN: ProgSpec = {
  provider: 'codex',
  command: 'C:\\Program Files\\Codex\\codex.exe',
  source: 'managed',
}
const found = (program: ProgSpec): LocateSpec => ({ program })
const none: LocateSpec = { program: null }

const progOf = (p: ProgSpec): Any => ({
  provider: p.provider,
  command: p.command,
  prefixArgs: p.prefixArgs ?? [],
  env: p.env ?? {},
  entry: p.entry ?? p.command,
  source: p.source ?? 'path',
})

function errorOf(message: string, code?: string): Error {
  const e = new Error(message)
  if (code !== undefined) (e as Any).code = code
  return e
}

function locatorOf(spec: LocateSpec | undefined, cx: TsContext): Any {
  if (!spec) return undefined
  return async (provider: string, options?: { configuredPath?: string }) => {
    cx.log('locate', provider, options?.configuredPath ?? null)
    if ('reject' in spec) throw errorOf(spec.reject, spec.code)
    return spec.program ? progOf(spec.program) : null
  }
}

/** one locator for several providers: `{ 'claude-code': spec, codex: spec }` */
function locatorBy(map: Record<string, LocateSpec> | undefined, cx: TsContext): Any {
  if (!map) return undefined
  return async (provider: string, options?: { configuredPath?: string }) => {
    cx.log('locate', provider, options?.configuredPath ?? null)
    const spec = map[provider] ?? none
    if ('reject' in spec) throw errorOf(spec.reject, spec.code)
    return spec.program ? progOf(spec.program) : null
  }
}

/** A detection with its keys in the order of the interface, none undefined */
function detectionLine(d: Any): unknown {
  const out: Record<string, unknown> = { provider: d.provider, state: d.state }
  for (const key of [
    'version',
    'loginMethod',
    'planName',
    'error',
    'programPath',
    'loginKind',
    'account',
  ]) {
    if (d[key] !== undefined) out[key] = d[key]
  }
  return out
}

const WIN_ENV = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', PATH: 'C:\\Windows' }
const WIN: Partial<World> = { platform: 'win32', env: WIN_ENV }
const MAC: Partial<World> = { platform: 'darwin', env: { HOME: '/Users/u', PATH: '/usr/bin' } }

// ---------------------------------------------------------------------------
// launch.ts, the pure part
// ---------------------------------------------------------------------------

function listeners(kind: 'login' | 'off') {
  return ([ops]: unknown[], cx: TsContext): null => {
    const fns = new Map<string, Any>()
    const removers = new Map<string, () => unknown>()
    const on = kind === 'login' ? launch.onSubscriptionLoginChange : launch.onSubscriptionOffChange
    for (const op of ops as unknown[][]) {
      const [what, a, b] = op as [string, string, unknown]
      if (what === 'on') {
        let fn = fns.get(a)
        if (!fn) {
          fn = (value: unknown) => {
            cx.log(kind, a, value)
            if (b === 'throws') throw new Error('listener')
          }
          fns.set(a, fn)
        }
        removers.set(a, on(fn))
      } else if (what === 'off') removers.get(a)?.()
      else if (what === 'notify') launch.notifySubscriptionLoginChange(a as Any)
      else launch.notifySubscriptionOffChange({ provider: a as Any, off: b === true })
    }
    for (const remove of removers.values()) remove()
    return null
  }
}

const loginOps: Case[] = [
  c([
    ['on', 'a'],
    ['notify', 'claude-code'],
  ]),
  c([
    ['on', 'a'],
    ['on', 'b'],
    ['notify', 'codex'],
    ['off', 'a'],
    ['notify', 'codex'],
  ]),
  cn('a listener that throws does not stop the others', [
    ['on', 'a', 'throws'],
    ['on', 'b'],
    ['notify', 'claude-code'],
  ]),
  cn('the same function added twice is told once', [
    ['on', 'a'],
    ['on', 'a'],
    ['notify', 'codex'],
    ['off', 'a'],
    ['notify', 'codex'],
  ]),
  c([
    ['notify', 'codex'],
    ['off', 'zzz'],
    ['on', 'a'],
    ['off', 'a'],
    ['off', 'a'],
    ['notify', 'codex'],
  ]),
]
const offOps: Case[] = [
  c([
    ['on', 'a'],
    ['notifyOff', 'codex', true],
  ]),
  c([
    ['on', 'a'],
    ['on', 'b'],
    ['notifyOff', 'claude-code', false],
    ['off', 'b'],
    ['notifyOff', 'codex', true],
  ]),
  cn('a listener that throws does not stop the others', [
    ['on', 'a', 'throws'],
    ['on', 'b'],
    ['notifyOff', 'codex', true],
  ]),
  c([
    ['notifyOff', 'codex', false],
    ['on', 'a'],
    ['on', 'a'],
    ['off', 'a'],
    ['notifyOff', 'codex', false],
  ]),
]

const pure: Group = {
  'subscription/launch.constants': {
    ts: () => ({
      logoutTimeout: launch.SUBSCRIPTION_LOGOUT_TIMEOUT_MS,
      loginExe: launch.SUBSCRIPTION_LOGIN_EXE_ENV,
      loginArgs: launch.SUBSCRIPTION_LOGIN_ARGS_ENV,
      loginTitle: launch.SUBSCRIPTION_LOGIN_TITLE_ENV,
      loginGuide: launch.SUBSCRIPTION_LOGIN_GUIDE_ENV,
      loginClosing: launch.SUBSCRIPTION_LOGIN_CLOSING_ENV,
      updateExe: launch.SUBSCRIPTION_UPDATE_EXE_ENV,
      updateArgs: launch.SUBSCRIPTION_UPDATE_ARGS_ENV,
      codexUpdate: launch.SUBSCRIPTION_CODEX_UPDATE_COMMANDS,
    }),
    single: 'constants',
    cases: [c()],
  },
  'subscription/launch.onSubscriptionLoginChange': { ts: listeners('login'), cases: loginOps },
  'subscription/launch.notifySubscriptionLoginChange': { ts: listeners('login'), cases: loginOps },
  'subscription/launch.onSubscriptionOffChange': { ts: listeners('off'), cases: offOps },
  'subscription/launch.notifySubscriptionOffChange': { ts: listeners('off'), cases: offOps },
  'subscription/launch.subscriptionInstallCommandLine': {
    ts: ([provider, env]) => launch.subscriptionInstallCommandLine(provider as Any, env as Any),
    cases: [
      c('claude-code', WIN_ENV),
      c('codex', WIN_ENV),
      c('codex', { windir: 'D:\\Win' }),
      cn('a relative SystemRoot is not taken', 'codex', {
        SystemRoot: 'Windows',
        SYSTEMROOT: 'E:\\Sys\\',
      }),
      c('claude-code', {}),
    ],
  },
  'subscription/launch.subscriptionUpdatePlan': {
    ts: ([program]) => launch.subscriptionUpdatePlan(progOf(program as ProgSpec)),
    cases: [
      c(CLAUDE),
      c(CODEX_NPM),
      c(CODEX_WINGET),
      c(CODEX),
      c({ ...CODEX, command: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe' }),
      c({ ...CODEX, entry: 'C:\\x\\NODE_MODULES\\@OPENAI\\CODEX\\bin\\codex.js' }),
    ],
  },
  'subscription/launch.subscriptionUpdateCommandLine': {
    ts: ([plan, env]) => launch.subscriptionUpdateCommandLine(plan as Any, env as Any),
    cases: [
      c({ kind: 'program', args: ['update'] }, WIN_ENV),
      c({ kind: 'command', command: launch.SUBSCRIPTION_CODEX_UPDATE_COMMANDS.npm }, WIN_ENV),
      c(
        { kind: 'command', command: launch.SUBSCRIPTION_CODEX_UPDATE_COMMANDS.winget },
        { windir: 'D:\\Win' },
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// launch.ts, the launchers
// ---------------------------------------------------------------------------

interface LaunchOpts {
  provider: string
  locate?: LocateSpec
  configuredPath?: string
  platform?: string
  env?: Record<string, string>
  baseEnv?: Record<string, string>
  window?: 'hidden' | 'visible'
  windowText?: { title?: string; guide?: string; closing?: string }
  registry?: 'none'
  timeoutMs?: number
  started?: 'log' | 'stop'
  exit?: boolean
  killTree?: boolean
  listen?: boolean
}

/** runs `call` in the world, with a login listener while it runs when asked */
function launcher(call: (o: LaunchOpts, cx: TsContext) => Promise<unknown>) {
  return async ([world, o]: unknown[], cx: TsContext): Promise<unknown> => {
    const opts = o as LaunchOpts
    const remove = opts.listen
      ? launch.onSubscriptionLoginChange((p) => cx.log('login-change', p))
      : undefined
    return inWorld(world as World, cx, () => call(opts, cx)).finally(() => remove?.())
  }
}

const GONE = { exit: { code: 0 }, closeOn: 'start' as const }
const LOGIN_CLAUDE = { ...CLAUDE, entry: undefined }

const loginCases: Case[] = [
  cn(
    'posix: the CLI opens the browser itself',
    w({ ...MAC, children: [{ pid: 7001, closeOn: 'never' }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
    },
  ),
  cn(
    'the child exits: the listener and onExit hear of it',
    w({ ...MAC, children: [{ pid: 7001, ...GONE }] }),
    {
      provider: 'codex',
      locate: found(CODEX),
      configuredPath: '/custom/codex',
      listen: true,
      exit: true,
    },
  ),
  cn('a program that is not installed', w(MAC), { provider: 'codex', locate: none }),
  cn('the lookup throws', w(MAC), {
    provider: 'codex',
    locate: { reject: 'EACCES: denied', code: 'EACCES' },
  }),
  cn('ChatGPT has no program', w(MAC), { provider: 'chatgpt', locate: found(CLAUDE) }),
  cn(
    'a program that cannot be started',
    w({ ...MAC, children: [{ error: { message: 'spawn EACCES', code: 'EACCES' } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
    },
  ),
  cn(
    'no pid and no error: the wait ends',
    w({ ...MAC, children: [{ pid: null, closeOn: 'never' }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
    },
  ),
  cn('the spawn fails outright', w(MAC), { provider: 'codex', locate: found(CODEX) }),
  cn('stop kills the process group', w({ ...MAC, children: [{ pid: 7003, closeOn: 'never' }] }), {
    provider: 'codex',
    locate: found(CODEX),
    started: 'stop',
  }),
  cn('stop through the stand-in', w({ ...MAC, children: [{ pid: 7004, closeOn: 'never' }] }), {
    provider: 'codex',
    locate: found(CODEX),
    started: 'stop',
    killTree: true,
  }),
  cn(
    'registry none, a started hook that only looks',
    w({ ...MAC, children: [{ pid: 7005, closeOn: 'never' }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
      registry: 'none',
      started: 'log',
      baseEnv: { ANTHROPIC_API_KEY: 'k', HOME: '/h' },
    },
  ),
  cn(
    'windows: the visible window with the guide',
    w({ ...WIN, children: [{ pid: 8001, closeOn: 'never' }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE_WIN),
      windowText: { title: 'Sign in', guide: "It's here", closing: 'Press Enter' },
    },
  ),
  cn(
    'windows: hidden, the words are left out',
    w({ ...WIN, children: [{ pid: 8002, closeOn: 'never' }] }),
    {
      provider: 'codex',
      locate: found(CODEX_WIN),
      window: 'hidden',
      windowText: { title: 'Sign in' },
      started: 'log',
    },
  ),
  cn('windows: an empty word is left out', w({ ...WIN, children: [{ pid: 8003, ...GONE }] }), {
    provider: 'claude-code',
    locate: found({ ...CLAUDE_WIN, prefixArgs: ['a b', 'say "hi"', 'dir\\', 'x\\"y'] }),
    window: 'visible',
    windowText: { title: '', guide: 'g' },
    listen: true,
    exit: true,
  }),
  cn(
    'windows: stop ends the launcher tree with taskkill',
    w({
      ...WIN,
      children: [
        { pid: 8004, closeOn: 'never' },
        { pid: 8005, closeOn: 'start' },
      ],
    }),
    { provider: 'codex', locate: found(CODEX_WIN), started: 'stop' },
  ),
  cn(
    'windows: taskkill cannot start, the launcher is ended directly',
    w({
      ...WIN,
      children: [
        { pid: 8006, closeOn: 'never' },
        { error: { message: 'spawn taskkill ENOENT', code: 'ENOENT' } },
      ],
    }),
    { provider: 'codex', locate: found(CODEX_WIN), started: 'stop' },
  ),
  cn(
    'windows: a launcher that cannot start',
    w({ ...WIN, children: [{ error: { message: 'spawn powershell ENOENT', code: 'ENOENT' } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE_WIN),
    },
  ),
]

const logoutCases: Case[] = [
  cn('exit code 0', w({ ...MAC, children: [{ pid: 7101, exit: { code: 0 } }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
    listen: true,
  }),
  cn('exit code 1', w({ ...MAC, children: [{ pid: 7102, exit: { code: 1 }, stderr: ['no'] }] }), {
    provider: 'codex',
    locate: found(CODEX),
    configuredPath: '/custom/codex',
    listen: true,
  }),
  cn(
    'a signal name beside the exit code',
    w({ ...MAC, children: [{ pid: 7103, exit: { code: 9, signal: 'SIGTERM' } }] }),
    {
      provider: 'codex',
      locate: found(CODEX),
    },
  ),
  cn('the command outlasts the time', w({ ...MAC, children: [{ pid: 7104, closeOn: 'never' }] }), {
    provider: 'codex',
    locate: found(CODEX),
    timeoutMs: 500,
    listen: true,
  }),
  cn('the default time', w({ ...MAC, children: [{ pid: 7105, closeOn: 'never' }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
  }),
  cn(
    'the program cannot start',
    w({ ...MAC, children: [{ error: { message: 'spawn EACCES', code: 'EACCES' } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
      listen: true,
    },
  ),
  cn('not installed', w(MAC), { provider: 'codex', locate: none, listen: true }),
  cn('the lookup throws', w(MAC), {
    provider: 'codex',
    locate: { reject: 'lookup failed' },
    listen: true,
  }),
  cn('ChatGPT', w(MAC), { provider: 'chatgpt', locate: found(CODEX), listen: true }),
  cn(
    'the base environment is cleaned',
    w({ ...MAC, children: [{ pid: 7106, exit: { code: 0 } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
      baseEnv: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', KEEP: '1' },
    },
  ),
]

const installCases: Case[] = [
  cn('posix: no vendor command', w(MAC), { provider: 'claude-code' }),
  cn('windows: the window opens', w({ ...WIN, children: [{ pid: 8101, closeOn: 'never' }] }), {
    provider: 'claude-code',
  }),
  cn(
    'windows: codex with the env of the call',
    w({ ...WIN, children: [{ pid: 8102, closeOn: 'never' }] }),
    {
      provider: 'codex',
      env: { windir: 'D:\\Win', PATH: 'D:\\Win' },
    },
  ),
  cn('the platform of the call', w(MAC), { provider: 'codex', platform: 'win32' }),
  cn('the platform of the call is not windows', w(WIN), { provider: 'codex', platform: 'linux' }),
  cn(
    'windows: the shell cannot start',
    w({ ...WIN, children: [{ error: { message: 'spawn cmd ENOENT', code: 'ENOENT' } }] }),
    {
      provider: 'claude-code',
    },
  ),
  cn('windows: no pid and no error', w({ ...WIN, children: [{ pid: null, closeOn: 'never' }] }), {
    provider: 'codex',
  }),
  cn('ChatGPT has nothing to install', w(WIN), { provider: 'chatgpt' }),
  cn('windows: spawn throws', w(WIN), { provider: 'codex' }),
]

const updateCases: Case[] = [
  cn('posix: unsupported', w(MAC), { provider: 'claude-code', locate: found(CLAUDE) }),
  cn('windows: claude updates itself', w({ ...WIN, children: [{ pid: 8201, closeOn: 'never' }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE_WIN),
  }),
  cn('windows: codex from npm', w({ ...WIN, children: [{ pid: 8202, closeOn: 'never' }] }), {
    provider: 'codex',
    locate: found({
      ...CODEX_NPM,
      command: 'C:\\nodejs\\node.exe',
      entry: 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    }),
    configuredPath: 'D:\\codex',
  }),
  cn('windows: codex from winget', w({ ...WIN, children: [{ pid: 8203, closeOn: 'never' }] }), {
    provider: 'codex',
    locate: found(CODEX_WINGET),
    env: { windir: 'D:\\Win' },
  }),
  cn('windows: no way to tell how it was installed', w(WIN), {
    provider: 'codex',
    locate: found(CODEX_WIN),
  }),
  cn('windows: not installed', w(WIN), { provider: 'codex', locate: none }),
  cn('windows: the lookup throws', w(WIN), {
    provider: 'claude-code',
    locate: { reject: 'broken' },
  }),
  cn('the platform of the call', w(MAC), {
    provider: 'claude-code',
    platform: 'win32',
    locate: found(CLAUDE_WIN),
  }),
  cn(
    'windows: the window cannot start',
    w({ ...WIN, children: [{ error: { message: 'spawn cmd ENOENT' } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE_WIN),
    },
  ),
  cn('ChatGPT', w(WIN), { provider: 'chatgpt', locate: found(CLAUDE_WIN) }),
]

const launchers: Group = {
  'subscription/launch.launchSubscriptionLogin': {
    ts: launcher((o, cx) =>
      launch.launchSubscriptionLogin(o.provider as Any, {
        configuredPath: o.configuredPath,
        window: o.window,
        windowText: o.windowText,
        platform: o.platform as Any,
        baseEnv: o.baseEnv,
        registry: o.registry === 'none' ? null : undefined,
        onStarted: o.started
          ? (stop) => {
              cx.log('started')
              if (o.started === 'stop') stop()
            }
          : undefined,
        onExit: o.exit ? () => cx.log('exit') : undefined,
        killTree: o.killTree ? (child) => cx.log('killtree', child.pid ?? null) : undefined,
        locate: locatorOf(o.locate, cx),
      }),
    ),
    cases: loginCases,
  },
  'subscription/launch.launchSubscriptionLogout': {
    ts: launcher((o, cx) =>
      launch.launchSubscriptionLogout(o.provider as Any, {
        configuredPath: o.configuredPath,
        timeoutMs: o.timeoutMs,
        baseEnv: o.baseEnv,
        locate: locatorOf(o.locate, cx),
      }),
    ),
    cases: logoutCases,
  },
  'subscription/launch.launchSubscriptionInstall': {
    ts: launcher((o) =>
      launch.launchSubscriptionInstall(o.provider as Any, {
        platform: o.platform as Any,
        env: o.env,
      }),
    ),
    cases: installCases,
  },
  'subscription/launch.launchSubscriptionUpdate': {
    ts: launcher((o, cx) =>
      launch.launchSubscriptionUpdate(o.provider as Any, {
        configuredPath: o.configuredPath,
        platform: o.platform as Any,
        env: o.env,
        locate: locatorOf(o.locate, cx),
      }),
    ),
    cases: updateCases,
  },
}
void LOGIN_CLAUDE

// ---------------------------------------------------------------------------
// status.ts
// ---------------------------------------------------------------------------

const claudeJson = (o: Record<string, unknown>): string => JSON.stringify(o)

interface DetectOpts {
  provider: string
  configuredPath?: string
  timeoutMs?: number
  locate?: LocateSpec
  locateBy?: Record<string, LocateSpec>
  registered?: { value?: unknown; reject?: string }
  account?: 'off' | { value?: unknown; reject?: string }
  configuredPaths?: Record<string, string | undefined>
  stubs?: Record<string, Record<string, unknown>>
}

function accountSource(spec: { value?: unknown; reject?: string }, cx: TsContext): Any {
  return async (ctx: { configuredPath?: string }) => {
    cx.log('account', ctx.configuredPath ?? null)
    if (spec.reject !== undefined) throw new Error(spec.reject)
    return spec.value
  }
}

function detectOptions(o: DetectOpts, cx: TsContext): Any {
  const options: Any = {
    configuredPath: o.configuredPath,
    timeoutMs: o.timeoutMs,
    locate: o.locateBy ? locatorBy(o.locateBy, cx) : locatorOf(o.locate, cx),
  }
  if (o.account !== undefined) {
    options.codexAccount = o.account === 'off' ? null : accountSource(o.account, cx)
  }
  return options
}

const chatGptNone = (): void => chatConn.setChatGptConnection(null)

function detecting(
  call: (o: DetectOpts, cx: TsContext) => Promise<unknown>,
): (args: unknown[], cx: TsContext) => Promise<unknown> {
  return ([world, o], cx) =>
    inWorld(world as World, cx, async () => {
      const opts = o as DetectOpts
      chatGptNone()
      statusMod.setCodexAccountSource(opts.registered ? accountSource(opts.registered, cx) : null)
      try {
        return await call(opts, cx)
      } finally {
        statusMod.setCodexAccountSource(null)
      }
    })
}

const CLAUDE_VERSION_OK = { pid: 9001, stdout: ['2.1.300 (Claude Code)\n'] }
const claudeStatus = (o: Record<string, unknown>) => ({ pid: 9002, stdout: [claudeJson(o)] })
const SUBSCRIPTION_CLAUDE = claudeStatus({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
  email: 'me@example.com',
})
const codexVersion = { pid: 9101, stdout: ['codex-cli 0.46.0\n'] }
const codexStatus = (line: string) => ({ pid: 9102, stderr: [line + '\n'] })

const detectCases: Case[] = [
  cn('claude: a subscription', w({ ...MAC, children: [CLAUDE_VERSION_OK, SUBSCRIPTION_CLAUDE] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
  }),
  cn(
    'claude: signed out',
    w({ ...MAC, children: [CLAUDE_VERSION_OK, claudeStatus({ loggedIn: false })] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
      configuredPath: '/x/claude',
    },
  ),
  cn(
    'claude: an API key is metered',
    w({
      ...MAC,
      children: [
        CLAUDE_VERSION_OK,
        claudeStatus({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
      ],
    }),
    { provider: 'claude-code', locate: found(CLAUDE) },
  ),
  cn('claude: not installed', w(MAC), { provider: 'claude-code', locate: none }),
  cn('claude: the lookup throws with a code', w(MAC), {
    provider: 'claude-code',
    locate: { reject: 'EACCES: /secret/path', code: 'EACCES' },
  }),
  cn('claude: the lookup throws without one', w(MAC), {
    provider: 'claude-code',
    locate: { reject: 'plain' },
  }),
  cn('claude: too old', w({ ...MAC, children: [{ pid: 9001, stdout: ['2.0.1\n'] }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
  }),
  cn('claude: no version printed', w({ ...MAC, children: [{ pid: 9001, stdout: ['hello\n'] }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
  }),
  cn(
    'claude: the version command cannot run',
    w({ ...MAC, children: [{ error: { message: 'spawn EACCES', code: 'EACCES' } }] }),
    {
      provider: 'claude-code',
      locate: found(CLAUDE),
    },
  ),
  cn(
    'claude: the status command cannot run',
    w({
      ...MAC,
      children: [CLAUDE_VERSION_OK, { error: { message: 'spawn x', code: 'lowercase' } }],
    }),
    { provider: 'claude-code', locate: found(CLAUDE) },
  ),
  cn(
    'claude: the status is not JSON',
    w({
      ...MAC,
      children: [CLAUDE_VERSION_OK, { pid: 9002, stdout: ['no json here'], exit: { code: 3 } }],
    }),
    { provider: 'claude-code', locate: found(CLAUDE) },
  ),
  cn(
    'claude: an unknown subcommand',
    w({
      ...MAC,
      children: [
        CLAUDE_VERSION_OK,
        { pid: 9002, stderr: ['error: unknown command auth'], exit: { code: 1 } },
      ],
    }),
    { provider: 'claude-code', locate: found(CLAUDE) },
  ),
  cn(
    'claude: no exit code',
    w({
      ...MAC,
      children: [
        CLAUDE_VERSION_OK,
        { pid: 9002, stdout: ['x'], exit: { code: 9, signal: 'SIGKILL' }, closeOn: 'start' },
      ],
    }),
    { provider: 'claude-code', locate: found(CLAUDE) },
  ),
  cn(
    'claude: the status outlasts the time',
    w({
      ...MAC,
      children: [CLAUDE_VERSION_OK, { pid: 9002, closeOn: 'never' }],
    }),
    { provider: 'claude-code', locate: found(CLAUDE), timeoutMs: 1500 },
  ),
  cn('claude: the default time', w({ ...MAC, children: [{ pid: 9001, closeOn: 'never' }] }), {
    provider: 'claude-code',
    locate: found(CLAUDE),
  }),
  cn(
    'codex: a ChatGPT login',
    w({ ...MAC, children: [codexVersion, codexStatus('Logged in using ChatGPT')] }),
    {
      provider: 'codex',
      locate: found(CODEX),
    },
  ),
  cn(
    'codex: the account source adds the plan and the account',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using ChatGPT')],
    }),
    {
      provider: 'codex',
      locate: found(CODEX),
      configuredPath: '/c/codex',
      registered: {
        value: {
          account: { type: 'chatgpt', planType: 'plus', email: 'a@b.co' },
          requiresOpenaiAuth: true,
        },
      },
    },
  ),
  cn(
    'codex: the source says metered',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using ChatGPT')],
    }),
    {
      provider: 'codex',
      locate: found(CODEX),
      registered: { value: { account: { type: 'apiKey' } } },
    },
  ),
  cn(
    'codex: the source is switched off for the call',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using an API key - sk-***')],
    }),
    { provider: 'codex', locate: found(CODEX), registered: { value: {} }, account: 'off' },
  ),
  cn(
    'codex: the call brings its own source',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using ChatGPT')],
    }),
    {
      provider: 'codex',
      locate: found(CODEX),
      registered: { reject: 'never used' },
      account: { value: { account: { type: 'chatgpt', planType: 'unknown' } } },
    },
  ),
  cn(
    'codex: the source fails',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using ChatGPT')],
    }),
    { provider: 'codex', locate: found(CODEX), registered: { reject: 'app-server down' } },
  ),
  cn(
    'codex: the source says signed out',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using ChatGPT')],
    }),
    {
      provider: 'codex',
      locate: found(CODEX),
      registered: { value: { account: null, requiresOpenaiAuth: true } },
    },
  ),
  cn(
    'codex: not logged in',
    w({ ...MAC, children: [codexVersion, codexStatus('Not logged in')] }),
    {
      provider: 'codex',
      locate: found(CODEX),
    },
  ),
  cn(
    'codex: the version command fails, the status goes on',
    w({
      ...MAC,
      children: [{ error: { message: 'x' } }, codexStatus('Logged in using Amazon Bedrock')],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: the status command fails',
    w({
      ...MAC,
      children: [codexVersion, { error: { message: 'spawn EPERM', code: 'EPERM' } }],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: a helper answers an unknown subcommand without a version',
    w({
      ...MAC,
      children: [
        { pid: 9101, stdout: [''] },
        { pid: 9102, stderr: ['unrecognized subcommand login'] },
      ],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: an old one rejects the subcommand',
    w({
      ...MAC,
      children: [
        codexVersion,
        { pid: 9102, stderr: ['error: unexpected argument status'], exit: { code: 2 } },
      ],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: nothing recognisable',
    w({
      ...MAC,
      children: [codexVersion, { pid: 9102, stderr: ['something else'], exit: { code: 4 } }],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: a login kind it does not know',
    w({
      ...MAC,
      children: [codexVersion, codexStatus('Logged in using a magic wand')],
    }),
    { provider: 'codex', locate: found(CODEX) },
  ),
  cn(
    'codex: both outlast the time',
    w({
      ...MAC,
      children: [
        { pid: 9101, closeOn: 'never' },
        { pid: 9102, closeOn: 'never' },
      ],
    }),
    { provider: 'codex', locate: found(CODEX), timeoutMs: 800 },
  ),
  cn('ChatGPT without a connection is signed out', w(MAC), { provider: 'chatgpt' }),
]

// ---------------------------------------------------------------------------
// service.ts and ipc.ts: the stand-ins a scenario builds
// ---------------------------------------------------------------------------

interface ServiceOpts {
  settings?: Record<string, unknown>
  record?: Record<string, string>
  detect?: Record<string, unknown[]>
  models?: Record<string, unknown[]>
  noOff?: boolean
  noModels?: boolean
  timeoutMs?: number
  failGet?: number[]
  failSet?: boolean
  failRead?: boolean
  failWrite?: boolean
  failOff?: boolean
  steps?: unknown[][]
  // ipc
  launch?: Record<string, { result?: unknown; reject?: string }>
  broadcast?: boolean
  codexImage?: boolean
  // createSubscriptionIpcDeps
  locate?: LocateSpec
  platform?: string
  killTree?: boolean
  hiddenMs?: number
  windowText?: { title?: string; guide?: string; closing?: string } | 'throws'
  /** the folder the metered record is kept in: `$DIR`, which both sides read from the argument */
  dataDir?: string
}

interface Bench {
  settings: Record<string, any>
  record: Record<string, string>
  deps: Any
  detect: Any
  listModels: Any
}

function sequence(list: unknown[] | undefined, index: Map<string, number>, key: string): unknown {
  const at = index.get(key) ?? 0
  index.set(key, at + 1)
  if (!list || list.length === 0) return undefined
  return list[Math.min(at, list.length - 1)]
}

/** The stand-ins of the status service, each logging its call */
function bench(o: ServiceOpts, cx: TsContext): Bench {
  const b: Bench = {
    settings: structuredClone(o.settings ?? {}),
    record: structuredClone(o.record ?? {}),
    deps: undefined,
    detect: undefined,
    listModels: undefined,
  }
  let gets = 0
  const detectAt = new Map<string, number>()
  const modelsAt = new Map<string, number>()
  b.detect = async (
    provider: string,
    options?: { configuredPath?: string; timeoutMs?: number },
  ) => {
    cx.log('detect', provider, options?.configuredPath ?? null, options?.timeoutMs ?? null)
    const next = sequence(o.detect?.[provider], detectAt, provider) as Any
    if (next && typeof next === 'object' && 'reject' in next) throw new Error(next.reject)
    return next ?? { provider, state: 'signed-out' }
  }
  b.listModels = async (provider: string, options?: { configuredPath?: string }) => {
    cx.log('models', provider, options?.configuredPath ?? null)
    const next = sequence(o.models?.[provider], modelsAt, provider) as Any
    if (next && typeof next === 'object' && 'reject' in next) throw new Error(next.reject)
    return next
  }
  b.deps = {
    getSettings: () => {
      gets += 1
      cx.log('getSettings')
      if (o.failGet?.includes(gets)) throw new Error('settings')
      return structuredClone(b.settings)
    },
    setMeteredAccepted: (provider: string, accepted: boolean) => {
      cx.log('setMetered', provider, accepted)
      if (o.failSet) throw new Error('write settings')
      b.settings.meteredAccepted = { ...b.settings.meteredAccepted, [provider]: accepted }
    },
    setSubscriptionOff: o.noOff
      ? undefined
      : (provider: string, off: boolean) => {
          cx.log('setOff', provider, off)
          if (o.failOff) throw new Error('write off')
          b.settings.subscriptionOff = { ...b.settings.subscriptionOff, [provider]: off }
        },
    acceptanceStore: {
      read: async () => {
        cx.log('read')
        if (o.failRead) throw new Error('read record')
        return structuredClone(b.record)
      },
      write: async (record: Record<string, string>) => {
        cx.log('write', record)
        if (o.failWrite) throw new Error('write record')
        b.record = structuredClone(record)
      },
    },
    detect: b.detect,
    listModels: o.noModels ? undefined : b.listModels,
    onChange: (statuses: unknown) => cx.log('change', statuses),
    timeoutMs: o.timeoutMs,
  }
  return b
}

/** one step of a service scenario */
async function serviceStep(
  service: Any,
  b: Bench,
  step: unknown[],
  cx: TsContext,
  extras: { listeners: Map<string, () => void> },
): Promise<unknown> {
  const [what, a, x, y] = step as [string, Any, Any, Any]
  switch (what) {
    case 'check':
      return service.check(a ?? undefined, x ? { fresh: true } : undefined)
    case 'metered':
      return service.setMeteredAccepted(a, x)
    case 'clear':
      return (await service.clearMeteredAcceptance(a)) ?? null
    case 'off':
      return service.setOff(a, x)
    case 'isOff':
      return service.isOff(a)
    case 'signing':
      return service.setSigningIn(a, x ?? undefined) ?? null
    case 'unfinished':
      return service.setLoginUnfinished(a, x, y ?? undefined) ?? null
    case 'statuses':
      return service.getStatuses()
    case 'settings':
      Object.assign(b.settings, a)
      return null
    case 'record':
      b.record = structuredClone(a)
      return null
    case 'listen':
      extras.listeners.set(
        a,
        service.onChange((s: unknown) => cx.log('listen', a, s)),
      )
      return null
    case 'unlisten':
      extras.listeners.get(a)?.()
      return null
    case 'settle':
      await new Promise((resolve) => setTimeout(resolve, 0))
      return null
    case 'par':
      return Promise.all(
        (step.slice(1) as unknown[][]).map((s) => serviceStep(service, b, s, cx, extras)),
      )
    default:
      throw new Error(`no such step ${what}`)
  }
}

function serviceScenario() {
  return ([world, o]: unknown[], cx: TsContext): Promise<unknown> =>
    inWorld(world as World, cx, async () => {
      const opts = o as ServiceOpts
      chatGptNone()
      const b = bench(opts, cx)
      const service = serviceMod.createSubscriptionStatusService(b.deps)
      const extras = { listeners: new Map<string, () => void>() }
      const removeOff = launch.onSubscriptionOffChange((change) => cx.log('off-change', change))
      try {
        const results: unknown[] = []
        for (const step of opts.steps ?? [])
          results.push(await serviceStep(service, b, step, cx, extras))
        return { results, statuses: service.getStatuses() }
      } finally {
        removeOff()
      }
    })
}

const det = (provider: string, state: string, more: Record<string, unknown> = {}) => ({
  provider,
  state,
  ...more,
})
const READY = (provider = 'claude-code') =>
  det(provider, 'ready', {
    version: '2.1.300',
    loginMethod: 'subscription',
    planName: 'max',
    loginKind: 'claude.ai/firstParty',
    account: 'me@example.com',
  })
const METERED = (provider = 'claude-code') =>
  det(provider, 'metered', {
    version: '2.1.300',
    loginMethod: 'metered',
    loginKind: 'api_key/firstParty',
    account: 'bad address',
  })
const MODELS = [
  { id: 'opus', label: 'Opus', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'sonnet', label: 'Sonnet' },
]
const MODELS_2 = [{ id: 'haiku', label: 'Haiku' }]
const ERR_DETECTION = det('claude-code', 'error', {
  error: 'needs-update: Claude Code 2.0.0 is too old',
  version: '2.0.0',
  programPath: '/opt/homebrew/Caskroom/claude-code/2.0.0/claude',
})
const MAP_KEYS = ['claude-code', 'chatgpt', 'codex']
void MAP_KEYS

const serviceCases: Case[] = [
  cn('the first status of everything is checking', w(), {
    steps: [['statuses']],
  }),
  cn('a check of one provider: a subscription, with its models', w(), {
    settings: { providers: { 'claude-code': { cliPath: '/p/claude' } } },
    detect: { 'claude-code': [READY()] },
    models: { 'claude-code': [MODELS] },
    steps: [['check', ['claude-code']], ['settle'], ['statuses']],
  }),
  cn('both providers', w(), {
    detect: { 'claude-code': [READY()], codex: [det('codex', 'not-installed')] },
    steps: [['check'], ['check', []]],
  }),
  cn('overlapping checks share one run', w(), {
    detect: { 'claude-code': [READY(), det('claude-code', 'signed-out')] },
    steps: [
      ['par', ['check', ['claude-code']], ['check', ['claude-code']]],
      ['check', ['claude-code']],
    ],
  }),
  cn('a fresh check waits for the one under way, then asks again', w(), {
    detect: { 'claude-code': [READY(), det('claude-code', 'signed-out')] },
    steps: [['par', ['check', ['claude-code']], ['check', ['claude-code'], true]]],
  }),
  cn('a metered login is not offered models until accepted', w(), {
    detect: { 'claude-code': [METERED()] },
    models: { 'claude-code': [MODELS] },
    steps: [
      ['check', ['claude-code']],
      ['settle'],
      ['metered', 'claude-code', true],
      ['settle'],
      ['statuses'],
    ],
  }),
  cn('an accepted metered login is kept by the same kind of login', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:api_key/firstParty' },
    detect: { 'claude-code': [METERED()] },
    models: { 'claude-code': [MODELS] },
    steps: [['check', ['claude-code']], ['settle']],
  }),
  cn('an acceptance with no remembered kind is cleared', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    detect: { 'claude-code': [METERED()] },
    steps: [['check', ['claude-code']]],
  }),
  cn('an acceptance for another kind of login is cleared', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:bedrock' },
    detect: { 'claude-code': [READY()] },
    steps: [['check', ['claude-code']]],
  }),
  cn('the settings cannot be read back: not accepted', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:api_key/firstParty' },
    detect: { 'claude-code': [METERED()] },
    failGet: [2],
    steps: [['check', ['claude-code']]],
  }),
  cn('an error and a signed-out check leave an acceptance alone and drop the models', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:api_key/firstParty' },
    detect: { 'claude-code': [METERED(), ERR_DETECTION, det('claude-code', 'signed-out')] },
    models: { 'claude-code': [MODELS] },
    steps: [
      ['check', ['claude-code']],
      ['settle'],
      ['check', ['claude-code']],
      ['check', ['claude-code']],
    ],
  }),
  cn('the settings cannot be read: a fixed error', w(), {
    failGet: [1],
    steps: [['check', ['claude-code']]],
  }),
  cn('the detector rejects: a fixed error', w(), {
    detect: { codex: [{ reject: 'boom' }] },
    steps: [['check', ['codex']]],
  }),
  cn('a CLI turned off is not asked', w(), {
    settings: { subscriptionOff: { codex: true } },
    steps: [
      ['check', ['codex']],
      ['isOff', 'codex'],
      ['isOff', 'claude-code'],
    ],
  }),
  cn('turned back on while the check ran', w(), {
    settings: { subscriptionOff: { codex: true } },
    steps: [
      ['par', ['check', ['codex']], ['settings', { subscriptionOff: { codex: false } }]],
      ['check', ['codex']],
    ],
  }),
  cn('turned off while the program was asked: its answer is not used', w(), {
    detect: {
      codex: [det('codex', 'ready', { loginMethod: 'subscription', loginKind: 'chatgpt' })],
    },
    steps: [
      ['par', ['check', ['codex']], ['settings', { subscriptionOff: { codex: true } }]],
      ['statuses'],
    ],
  }),
  cn('setOff stores, shows off, tells the bridges, and back on asks again', w(), {
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      ['off', 'codex', true],
      ['isOff', 'codex'],
      ['off', 'codex', false],
      ['settle'],
      ['statuses'],
    ],
  }),
  cn('setOff without a writer', w(), { noOff: true, steps: [['off', 'codex', true]] }),
  cn('setOff when the setting cannot be written', w(), {
    failOff: true,
    steps: [['off', 'codex', true], ['statuses']],
  }),
  cn('setOff back on without having been off', w(), {
    steps: [['off', 'claude-code', false], ['settle']],
  }),
  cn('accepting needs a metered login', w(), {
    detect: { 'claude-code': [READY()] },
    steps: [
      ['metered', 'claude-code', true],
      ['check', ['claude-code']],
      ['metered', 'claude-code', true],
    ],
  }),
  cn('withdrawing an acceptance', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:api_key/firstParty', codex: 'metered:api-key' },
    detect: { 'claude-code': [METERED()] },
    steps: [
      ['check', ['claude-code']],
      ['metered', 'claude-code', false],
      ['metered', 'claude-code', false],
    ],
  }),
  cn('the record cannot be written', w(), {
    detect: { 'claude-code': [METERED()] },
    failWrite: true,
    steps: [['check', ['claude-code']], ['metered', 'claude-code', true], ['statuses']],
  }),
  cn('the settings cannot be written', w(), {
    detect: { 'claude-code': [METERED()] },
    failSet: true,
    steps: [
      ['check', ['claude-code']],
      ['metered', 'claude-code', true],
    ],
  }),
  cn('the record cannot be read', w(), {
    detect: { 'claude-code': [METERED()] },
    failRead: true,
    steps: [
      ['check', ['claude-code']],
      ['metered', 'claude-code', true],
      ['clear', 'claude-code'],
    ],
  }),
  cn('clearing an accepted login', w(), {
    settings: { meteredAccepted: { 'claude-code': true } },
    record: { 'claude-code': 'metered:api_key/firstParty' },
    detect: { 'claude-code': [METERED()] },
    steps: [
      ['check', ['claude-code']],
      ['clear', 'claude-code'],
      ['clear', 'claude-code'],
      ['statuses'],
    ],
  }),
  cn('clearing when nothing was accepted writes nothing', w(), {
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      ['check', ['codex']],
      ['clear', 'codex'],
    ],
  }),
  cn('model lists: a later reading that differs is added, one that is the same is not', w(), {
    detect: { 'claude-code': [READY()] },
    models: { 'claude-code': [MODELS, MODELS, MODELS_2, { reject: 'cli' }, 'not a list'] },
    steps: [
      ['check', ['claude-code']],
      ['settle'],
      ['check', ['claude-code']],
      ['settle'],
      ['check', ['claude-code']],
      ['settle'],
      ['check', ['claude-code']],
      ['settle'],
      ['check', ['claude-code']],
      ['settle'],
      ['statuses'],
    ],
  }),
  cn('no model lister: nothing is read', w(), {
    noModels: true,
    detect: { 'claude-code': [READY()] },
    steps: [['check', ['claude-code']], ['settle']],
  }),
  cn('listeners: a second one, then it stops listening', w(), {
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      ['listen', 'a'],
      ['signing', 'codex', 'browser'],
      ['unlisten', 'a'],
      ['signing', 'codex', null],
      ['signing', 'codex', null],
    ],
  }),
  cn('signing in is laid over the statuses, except for a program that is off', w(), {
    settings: { subscriptionOff: { codex: true } },
    steps: [
      ['check', ['codex']],
      ['signing', 'codex', 'window'],
      ['signing', 'claude-code', 'browser'],
      ['signing', 'claude-code', 'browser'],
      ['statuses'],
    ],
  }),
  cn('a login that did not finish, and why', w(), {
    detect: { 'claude-code': [det('claude-code', 'signed-out'), READY()] },
    steps: [
      ['unfinished', 'claude-code', true, { reason: 'timeout', step: 'token' }],
      ['unfinished', 'claude-code', true, { reason: 'timeout', step: 'token' }],
      ['signing', 'claude-code', 'window'],
      ['statuses'],
      ['signing', 'claude-code', null],
      ['check', ['claude-code']],
      ['unfinished', 'claude-code', false],
      ['unfinished', 'claude-code', false],
      ['unfinished', 'claude-code', true],
      ['statuses'],
    ],
  }),
  cn('a sign-in found by a check ends an unfinished login', w(), {
    detect: { 'claude-code': [READY()] },
    steps: [['unfinished', 'claude-code', true], ['check', ['claude-code']], ['statuses']],
  }),
  cn('a needs-update error carries the program path', w(), {
    detect: { 'claude-code': [ERR_DETECTION] },
    steps: [['check', ['claude-code']]],
  }),
  cn('a detection from a stand-in is checked again', w(), {
    detect: {
      codex: [
        det('codex', 'ready', {
          account: 'not an address',
          loginMethod: 'subscription',
          planName: '',
          version: '',
          loginKind: 'x',
          programPath: '/p',
        }),
      ],
    },
    steps: [['check', ['codex']]],
  }),
  cn('the timeout reaches the detector', w(), { timeoutMs: 1234, steps: [['check', ['codex']]] }),
  cn('a check of a provider turned on after being off reads checking, then asks', w(), {
    settings: { subscriptionOff: { 'claude-code': true } },
    detect: { 'claude-code': [READY()] },
    steps: [
      ['check', ['claude-code']],
      ['settings', { subscriptionOff: { 'claude-code': false } }],
      ['off', 'claude-code', false],
      ['settle'],
      ['statuses'],
    ],
  }),
]

// ---------------------------------------------------------------------------
// ipc.ts
// ---------------------------------------------------------------------------

const channelOf = (key: string): string =>
  (contract.SUBSCRIPTION_IPC_CHANNELS as Record<string, string>)[key] ?? key

function stubLaunch(o: ServiceOpts, cx: TsContext, name: string, label: string) {
  return async (provider: string, mode?: string): Promise<unknown> => {
    cx.log(label, provider, mode ?? null)
    const spec = o.launch?.[name]
    if (spec?.reject !== undefined) throw new Error(spec.reject)
    return spec?.result ?? { ok: true }
  }
}

function ipcScenario() {
  return ([world, o]: unknown[], cx: TsContext): Promise<unknown> =>
    inWorld(world as World, cx, async () => {
      const opts = o as ServiceOpts
      chatGptNone()
      imageBackend.setCodexImageGenerationAvailable(opts.codexImage === true)
      const b = bench(opts, cx)
      const service = serviceMod.createSubscriptionStatusService(b.deps)
      const handlers = new Map<string, Any>()
      const ipcMain = { handle: (channel: string, fn: Any) => void handlers.set(channel, fn) }
      const unregister = ipcMod.registerSubscriptionIpc(ipcMain, {
        service,
        launchLogin: stubLaunch(opts, cx, 'login', 'launchLogin') as Any,
        launchLogout: stubLaunch(opts, cx, 'logout', 'launchLogout') as Any,
        launchInstall: stubLaunch(opts, cx, 'install', 'launchInstall') as Any,
        launchUpdate: stubLaunch(opts, cx, 'update', 'launchUpdate') as Any,
        cancelLogin: stubLaunch(opts, cx, 'cancel', 'cancelLogin') as Any,
        broadcast: opts.broadcast
          ? (channel, payload) => cx.log('broadcast', channel, payload)
          : undefined,
      })
      const extras = { listeners: new Map<string, () => void>() }
      const run = async (step: unknown[]): Promise<unknown> => {
        const [what, a, payload] = step as [string, string, unknown]
        if (what === 'invoke') {
          const handler = handlers.get(channelOf(a))
          if (!handler) return { noHandler: true }
          return handler({}, payload)
        }
        if (what === 'loginChange') {
          launch.notifySubscriptionLoginChange(a as Any)
          await new Promise((resolve) => setTimeout(resolve, 0))
          return null
        }
        if (what === 'unregister') return unregister() ?? null
        if (what === 'par') return Promise.all((step.slice(1) as unknown[][]).map(run))
        return serviceStep(service, b, step, cx, extras)
      }
      try {
        const results: unknown[] = []
        for (const step of opts.steps ?? []) results.push(await run(step))
        return { channels: [...handlers.keys()], results, statuses: service.getStatuses() }
      } finally {
        unregister()
        imageBackend.setCodexImageGenerationAvailable(false)
      }
    })
}

const FAILED = { ok: false, reason: 'failed', error: 'launcher down' }
const ipcCases: Case[] = [
  cn('the channels the handlers register', w(), { steps: [] }),
  cn('statuses: the first window starts the first check', w(), {
    detect: { 'claude-code': [READY()], codex: [det('codex', 'not-installed')] },
    steps: [['invoke', 'statuses'], ['settle'], ['invoke', 'statuses']],
    broadcast: true,
  }),
  cn('recheck: the providers asked, unknown ones left out', w(), {
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      ['invoke', 'recheck', { providers: ['codex', 'nope', 3] }],
      ['invoke', 'recheck', { providers: 'codex' }],
      ['invoke', 'recheck', { providers: [] }],
      ['invoke', 'recheck'],
      ['invoke', 'recheck', null],
    ],
  }),
  cn('login: an unknown provider is invalid', w(), {
    steps: [
      ['invoke', 'login'],
      ['invoke', 'login', { provider: 'nope' }],
      ['invoke', 'login', 'codex'],
      ['invoke', 'login', []],
    ],
  }),
  cn('login: only `window` is a mode', w(), {
    steps: [
      ['invoke', 'login', { provider: 'codex' }],
      ['invoke', 'login', { provider: 'codex', mode: 'window' }],
      ['invoke', 'login', { provider: 'claude-code', mode: 'browser' }],
      ['invoke', 'login', { provider: 'chatgpt', mode: 7 }],
    ],
  }),
  cn('login: a CLI turned off is refused', w(), {
    settings: { subscriptionOff: { codex: true } },
    steps: [
      ['invoke', 'login', { provider: 'codex' }],
      ['invoke', 'login', { provider: 'claude-code' }],
    ],
  }),
  cn('login: a launcher that rejects is a failed result', w(), {
    launch: { login: { reject: 'launcher down' } },
    steps: [
      ['invoke', 'login', { provider: 'codex' }],
      ['invoke', 'login', { provider: 'chatgpt' }],
    ],
  }),
  cn('logout: the provider is looked at again after it, also when it failed', w(), {
    launch: { logout: { reject: 'launcher down' } },
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      ['invoke', 'logout', { provider: 'codex' }],
      ['invoke', 'logout', { provider: 'bogus' }],
    ],
  }),
  cn('logout: a result of the launcher is passed on', w(), {
    launch: { logout: { result: { ok: false, reason: 'failed' } } },
    steps: [['invoke', 'logout', { provider: 'claude-code' }]],
  }),
  cn('install and update', w(), {
    launch: {
      update: { result: { ok: false, reason: 'unsupported', installUrl: 'https://x.example' } },
    },
    steps: [
      ['invoke', 'install', { provider: 'codex' }],
      ['invoke', 'update', { provider: 'claude-code' }],
      ['invoke', 'install', {}],
    ],
  }),
  cn('install of a CLI turned off is refused, cancel is not', w(), {
    settings: { subscriptionOff: { 'claude-code': true } },
    steps: [
      ['invoke', 'install', { provider: 'claude-code' }],
      ['invoke', 'cancelLogin', { provider: 'claude-code' }],
      ['invoke', 'cancelLogin', { provider: 'x' }],
    ],
  }),
  cn('cancel: a launcher that rejects', w(), {
    launch: { cancel: { reject: 'launcher down' } },
    steps: [['invoke', 'cancelLogin', { provider: 'codex' }]],
  }),
  cn('metered: consent is a real boolean', w(), {
    detect: { 'claude-code': [METERED()] },
    steps: [
      ['check', ['claude-code']],
      ['invoke', 'metered', { provider: 'claude-code', accepted: 'true' }],
      ['invoke', 'metered', { provider: 'bogus', accepted: true }],
      ['invoke', 'metered', null],
      ['invoke', 'metered', { provider: 'claude-code', accepted: true }],
      ['invoke', 'metered', { provider: 'claude-code', accepted: false }],
    ],
  }),
  cn('metered: a CLI turned off is refused', w(), {
    settings: { subscriptionOff: { codex: true } },
    steps: [['invoke', 'metered', { provider: 'codex', accepted: true }]],
  }),
  cn('off: the payload is checked, a sign-in the app started ends with it', w(), {
    steps: [
      ['invoke', 'off', { provider: 'codex', off: true }],
      ['invoke', 'off', { provider: 'chatgpt', off: true }],
      ['invoke', 'off', { provider: 'codex', off: 'yes' }],
      ['invoke', 'off', { provider: 'codex', off: false }],
      ['invoke', 'off', null],
    ],
  }),
  cn('off: no writer, a writer that fails', w(), {
    noOff: true,
    steps: [['invoke', 'off', { provider: 'codex', off: true }]],
  }),
  cn('off: the setting cannot be written', w(), {
    failOff: true,
    steps: [['invoke', 'off', { provider: 'codex', off: true }]],
  }),
  cn('off: a launcher that rejects on cancel is ignored', w(), {
    launch: { cancel: { reject: 'launcher down' } },
    steps: [['invoke', 'off', { provider: 'claude-code', off: true }]],
  }),
  cn('codexImage', w(), { codexImage: true, steps: [['invoke', 'codexImage']] }),
  cn('codexImage is off by default, and a channel that is not registered has no handler', w(), {
    steps: [
      ['invoke', 'codexImage'],
      ['invoke', 'changed'],
      ['invoke', 'bogus'],
    ],
  }),
  cn(
    'a login or logout the app ran withdraws the acceptance, until the registration is undone',
    w(),
    {
      settings: { meteredAccepted: { 'claude-code': true } },
      record: { 'claude-code': 'metered:api_key/firstParty' },
      detect: { 'claude-code': [METERED()] },
      broadcast: true,
      steps: [
        ['check', ['claude-code']],
        ['loginChange', 'claude-code'],
        ['check', ['claude-code']],
        ['unregister'],
        ['signing', 'claude-code', 'browser'],
        ['loginChange', 'claude-code'],
      ],
    },
  ),
  cn('the failure of a launcher names the install page of a CLI', w(), {
    launch: { install: { reject: 'launcher down' }, update: { result: FAILED } },
    steps: [
      ['invoke', 'install', { provider: 'claude-code' }],
      ['invoke', 'install', { provider: 'chatgpt' }],
      ['invoke', 'update', { provider: 'codex' }],
    ],
  }),
  cn('overlapping requests', w(), {
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [
      [
        'par',
        ['invoke', 'recheck', { providers: ['codex'] }],
        ['invoke', 'logout', { provider: 'codex' }],
      ],
    ],
  }),
]

// ---------------------------------------------------------------------------
// ipc.ts: createSubscriptionIpcDeps, ensureSubscriptionIpc
// ---------------------------------------------------------------------------

function ipcSetup(opts: ServiceOpts, b: Bench, cx: TsContext): Any {
  const setup: Any = {
    getSettings: b.deps.getSettings,
    setMeteredAccepted: b.deps.setMeteredAccepted,
    setSubscriptionOff: b.deps.setSubscriptionOff,
    dataDir: opts.dataDir,
    broadcast: opts.broadcast
      ? (channel: string, payload: unknown) => cx.log('broadcast', channel, payload)
      : undefined,
    detect: b.detect,
    listModels: opts.noModels ? undefined : b.listModels,
    locate: locatorOf(opts.locate, cx),
    platform: opts.platform,
    killTree: opts.killTree ? (child: Any) => cx.log('killtree', child.pid ?? null) : undefined,
    hiddenLoginTimeoutMs: opts.hiddenMs,
    chatGptConnection: chatConn.createChatGptConnection({
      store: chatCred.createChatGptConnectionMemoryStore(),
      agentName: 'SeuOffice',
    }),
  }
  if (opts.windowText !== undefined) {
    setup.loginWindowText = (provider: string) => {
      cx.log('windowText', provider)
      if (opts.windowText === 'throws') throw new Error('words')
      return opts.windowText
    }
  }
  return setup
}

function depsScenario() {
  return ([world, o]: unknown[], cx: TsContext): Promise<unknown> =>
    inWorld(world as World, cx, async () => {
      const opts = o as ServiceOpts
      chatGptNone()
      const b = bench(opts, cx)
      const deps = ipcMod.createSubscriptionIpcDeps(ipcSetup(opts, b, cx))
      const extras = { listeners: new Map<string, () => void>() }
      const run = async (step: unknown[]): Promise<unknown> => {
        const [what, a, x] = step as [string, string, string | undefined]
        if (what === 'login') return deps.launchLogin(a as Any, x as Any)
        if (what === 'logout') return deps.launchLogout(a as Any)
        if (what === 'install') return deps.launchInstall(a as Any)
        if (what === 'update') return deps.launchUpdate(a as Any)
        if (what === 'cancel') return deps.cancelLogin(a as Any)
        if (what === 'sleep') {
          await new Promise((resolve) => setTimeout(resolve, Number(a)))
          return null
        }
        if (what === 'par') return Promise.all((step.slice(1) as unknown[][]).map(run))
        return serviceStep(deps.service, b, step, cx, extras)
      }
      try {
        const results: unknown[] = []
        for (const step of opts.steps ?? []) results.push(await run(step))
        return { results, statuses: deps.service.getStatuses() }
      } finally {
        chatGptNone()
      }
    })
}

const DOWN = { pid: 5001, closeOn: 'never' as const }
const SIGNED_OUT = det('claude-code', 'signed-out')
const CLAUDE_CHILD_EXITS = { pid: 5002, exit: { code: 0 }, closeOn: 'start' as const }

const depsCases: Case[] = [
  cn(
    'login in the browser: the card shows it, the program is looked for with the configured path',
    w({ ...MAC, children: [DOWN] }),
    {
      settings: { providers: { 'claude-code': { cliPath: '/c/claude' } } },
      locate: found(CLAUDE),
      steps: [['login', 'claude-code'], ['statuses']],
    },
  ),
  cn('a second press while it runs changes nothing on posix', w({ ...MAC, children: [DOWN] }), {
    locate: found(CLAUDE),
    steps: [
      ['login', 'claude-code'],
      ['login', 'claude-code'],
      ['login', 'claude-code', 'window'],
      ['statuses'],
    ],
  }),
  cn(
    'on windows a press asks for the window',
    w({
      ...WIN,
      children: [DOWN, { pid: 5003, closeOn: 'never' }, { pid: 5004, closeOn: 'start' }],
    }),
    {
      platform: 'win32',
      locate: found(CLAUDE_WIN),
      windowText: { title: 'Sign in', guide: 'g' },
      steps: [
        ['login', 'claude-code'],
        ['login', 'claude-code'],
        ['login', 'claude-code'],
        ['statuses'],
      ],
    },
  ),
  cn('on windows the window can be asked for first', w({ ...WIN, children: [DOWN] }), {
    platform: 'win32',
    locate: found(CODEX_WIN),
    windowText: 'throws',
    steps: [['login', 'codex', 'window'], ['statuses']],
  }),
  cn(
    'the login ends on its own and the provider is still signed out: the card offers the window',
    w({ ...MAC, children: [CLAUDE_CHILD_EXITS] }),
    {
      locate: found(CLAUDE),
      detect: { 'claude-code': [SIGNED_OUT] },
      steps: [['login', 'claude-code'], ['settle'], ['statuses']],
    },
  ),
  cn(
    'the login ends on its own and the sign-in is found',
    w({ ...MAC, children: [CLAUDE_CHILD_EXITS] }),
    {
      locate: found(CLAUDE),
      detect: { 'claude-code': [READY()] },
      steps: [['login', 'claude-code'], ['settle'], ['statuses']],
    },
  ),
  cn('a program that is not installed ends the login at once', w(MAC), {
    locate: none,
    steps: [['login', 'codex'], ['statuses']],
  }),
  cn('the settings cannot be read', w(MAC), {
    failGet: [1, 2, 3],
    locate: found(CODEX),
    steps: [['login', 'codex']],
  }),
  cn('a browser sign-in nobody finishes is ended after the time', w({ ...MAC, children: [DOWN] }), {
    locate: found(CODEX),
    hiddenMs: 2000,
    killTree: true,
    steps: [['login', 'codex'], ['sleep', 2500], ['statuses']],
  }),
  cn('cancel ends the login and looks again', w({ ...MAC, children: [DOWN] }), {
    locate: found(CODEX),
    killTree: true,
    detect: { codex: [det('codex', 'signed-out')] },
    steps: [['login', 'codex'], ['cancel', 'codex'], ['cancel', 'codex'], ['settle'], ['statuses']],
  }),
  cn(
    'cancel before the program was found: it ends once it starts',
    w({ ...MAC, children: [DOWN] }),
    {
      locate: found(CODEX),
      killTree: true,
      steps: [['par', ['login', 'codex'], ['cancel', 'codex']], ['statuses']],
    },
  ),
  cn('logout of ChatGPT', w(MAC), { steps: [['logout', 'chatgpt'], ['statuses']] }),
  cn('ChatGPT login without a sign-in setup is unsupported', w(MAC), {
    steps: [
      ['login', 'chatgpt'],
      ['login', 'chatgpt'],
      ['cancel', 'chatgpt'],
      ['logout', 'chatgpt'],
    ],
  }),
  cn(
    'install and update',
    w({
      ...WIN,
      children: [
        { pid: 5020, closeOn: 'never' },
        { pid: 5021, closeOn: 'never' },
      ],
    }),
    {
      platform: 'win32',
      settings: { providers: { 'claude-code': { cliPath: 'C:\\c\\claude.exe' } } },
      locate: found(CLAUDE_WIN),
      steps: [
        ['install', 'claude-code'],
        ['update', 'claude-code'],
        ['install', 'chatgpt'],
        ['update', 'chatgpt'],
      ],
    },
  ),
  cn('install on posix', w(MAC), {
    steps: [
      ['install', 'codex'],
      ['update', 'codex'],
    ],
  }),
  cn('the service built over the settings', w(MAC), {
    detect: { 'claude-code': [READY()], codex: [det('codex', 'signed-out')] },
    models: { 'claude-code': [MODELS] },
    broadcast: true,
    steps: [['check'], ['settle'], ['statuses']],
  }),
  cn('the default model lister has no sources', w(MAC), {
    noModels: true,
    detect: { 'claude-code': [READY()] },
    steps: [['check', ['claude-code']], ['settle']],
  }),
]

// ensureSubscriptionIpc and the rest of the shared registration
function sharedScenario() {
  return ([world, o]: unknown[], cx: TsContext): Promise<unknown> =>
    inWorld(world as World, cx, async () => {
      const opts = o as ServiceOpts
      chatGptNone()
      ipcMod.resetSharedSubscriptionIpc()
      const b = bench(opts, cx)
      const extras = { listeners: new Map<string, () => void>() }
      const ipcMain = { handle: (channel: string) => cx.log('handle', channel) }
      let first: Any
      let current: Any
      const results: unknown[] = []
      try {
        for (const step of opts.steps ?? []) {
          const [what] = step as [string]
          if (what === 'ensure') {
            const deps = ipcMod.ensureSubscriptionIpc(ipcMain, ipcSetup(opts, b, cx), (setup) => {
              cx.log('createDeps')
              return ipcMod.createSubscriptionIpcDeps(setup)
            })
            first ??= deps
            current = deps
            results.push({ same: deps === first })
          } else if (what === 'shared') results.push(ipcMod.sharedSubscriptionStatuses())
          else if (what === 'reset') results.push(ipcMod.resetSharedSubscriptionIpc() ?? null)
          else if (what === 'forget') {
            first = undefined
            results.push(null)
          } else {
            // the service of the registration the last `ensure` answered
            results.push(await serviceStep(current.service, b, step, cx, extras))
          }
        }
        return results
      } finally {
        ipcMod.resetSharedSubscriptionIpc()
        chatGptNone()
      }
    })
}

const sharedCases: Case[] = [
  cn('nothing is registered before the first call', w(), { steps: [['shared']] }),
  cn('the first call registers, the next ones get the same dependencies', w(), {
    steps: [['ensure'], ['ensure'], ['shared'], ['shared']],
  }),
  cn('reset drops it, the next call registers again', w(), {
    steps: [['ensure'], ['reset'], ['shared'], ['ensure'], ['forget'], ['ensure']],
  }),
  cn('the statuses the main process decides on leave the account out', w(), {
    detect: { 'claude-code': [READY()] },
    steps: [['ensure'], ['check', ['claude-code']], ['shared']],
  }),
]

for (const c of [...depsCases, ...sharedCases]) (c.args[1] as ServiceOpts).dataDir = '$DIR'

const group: Group = {
  ...pure,
  ...launchers,
  'subscription/status.constants': {
    ts: () => ({
      timeout: statusMod.SUBSCRIPTION_STATUS_TIMEOUT_MS,
      kinds: statusMod.SUBSCRIPTION_LOGIN_KINDS,
    }),
    single: 'constants',
    cases: [c()],
  },
  'subscription/status.subscriptionLoginKind': {
    ts: ([value]) => statusMod.subscriptionLoginKind(value),
    cases: [
      c('claude.ai/firstParty'),
      c('api_key/bedrock'),
      c('unknown/unknown'),
      c('chatgpt'),
      c('no-account'),
      c('claude.ai'),
      c(''),
      c(null),
      c(7),
      c('CHATGPT'),
    ],
  },
  'subscription/status.parseClaudeAuthStatus': {
    ts: ([stdout]) => statusMod.parseClaudeAuthStatus(stdout as string),
    cases: [
      c(
        claudeJson({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
          email: 'me@example.com',
        }),
      ),
      c(claudeJson({ loggedIn: false })),
      c(claudeJson({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' })),
      c(
        claudeJson({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'bedrock',
          subscriptionType: 'max',
        }),
      ),
      c(claudeJson({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'brand-new' })),
      c(
        claudeJson({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: '',
          subscriptionType: 'Free Text Plan',
        }),
      ),
      c(
        claudeJson({
          loggedIn: true,
          authMethod: 'oauth_token',
          apiProvider: 'firstParty',
          email: 'not an email',
        }),
      ),
      c(claudeJson({ loggedIn: true, authMethod: 'helper', apiProvider: 'firstParty' })),
      c(
        claudeJson({
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'pro',
          email: 'a@b.co',
        }),
      ),
      c(claudeJson({ loggedIn: 'yes' })),
      c('banner ' + claudeJson({ loggedIn: true, authMethod: 'third_party' }) + ' trailer'),
      c('{ not json }'),
      c('}{'),
      c('{}'),
      c('[]'),
      c(''),
      c(
        '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"a-b_c9"}',
      ),
    ],
  },
  'subscription/status.parseCodexLoginStatus': {
    ts: ([output]) => statusMod.parseCodexLoginStatus(output as string),
    cases: [
      c('Logged in using ChatGPT'),
      c('Logged in using an API key - sk-***'),
      c('Logged in using Amazon Bedrock'),
      c('Logged in using workload identity'),
      c('Logged in using access token'),
      c('Logged in using Personal Access Token\n'),
      c('Logged in using something new'),
      c('Logged in using'),
      c('Not logged in'),
      c('NOT LOGGED IN\nLogged in using ChatGPT'),
      c('Logged in using chatgptx'),
      c('Logged in using API key'),
      c('nothing here'),
      c(''),
      c('\r\nlogged in using chatgpt\r\n'),
    ],
  },
  'subscription/status.codexAccountInfo': {
    ts: ([value]) => statusMod.codexAccountInfo(value),
    cases: [
      c({ account: { type: 'chatgpt', planType: 'plus', email: 'a@b.co' } }),
      c({ account: { type: 'chatgpt', planType: 'unknown' } }),
      c({ account: { type: 'chatgpt', planType: 'free form', email: 'x' } }),
      c({ account: { type: 'apiKey' } }),
      c({ account: { type: 'other' } }),
      c({ account: null, requiresOpenaiAuth: true }),
      c({ account: null, requiresOpenaiAuth: false }),
      c({}),
      c([]),
      c(null),
      c('text'),
      c({ account: [], requiresOpenaiAuth: true }),
    ],
  },
  'subscription/status.detectSubscriptionLogin': {
    ts: detecting((o, cx) =>
      statusMod
        .detectSubscriptionLogin(o.provider as Any, detectOptions(o, cx))
        .then(detectionLine),
    ),
    cases: detectCases,
  },
  'subscription/status.detectSubscriptionLogins': {
    ts: detecting(async (o, cx) => {
      const options: Any = {
        ...detectOptions(o, cx),
        configuredPaths: o.configuredPaths,
      }
      if (o.configuredPaths === undefined) delete options.configuredPaths
      if (o.stubs) {
        options.detect = async (provider: string, own: { configuredPath?: string }) => {
          cx.log('stub', provider, own.configuredPath ?? null)
          return o.stubs?.[provider] ?? { provider, state: 'signed-out' }
        }
      }
      const out = await statusMod.detectSubscriptionLogins(options)
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, detectionLine(v)]))
    }),
    cases: [
      cn('the stand-in sees one path per provider', w(), {
        provider: '',
        configuredPath: '/all',
        configuredPaths: { codex: '/c' },
        stubs: { codex: { provider: 'codex', state: 'ready' } },
      }),
      cn('the common path when none is given per provider', w(), {
        provider: '',
        configuredPath: '/all',
        stubs: {},
      }),
      cn('an empty record overrides the common path', w(), {
        provider: '',
        configuredPath: '/all',
        configuredPaths: {},
      }),
      cn(
        'both providers over the world, ChatGPT without a connection',
        w({
          ...MAC,
          children: [
            CLAUDE_VERSION_OK,
            SUBSCRIPTION_CLAUDE,
            codexVersion,
            codexStatus('Not logged in'),
          ],
        }),
        { provider: '', locateBy: { 'claude-code': found(CLAUDE), codex: found(CODEX) } },
      ),
      cn('neither is installed', w(MAC), { provider: '', locateBy: {} }),
    ],
  },
  'subscription/status.setCodexAccountSource': {
    ts: detecting((o, cx) =>
      statusMod
        .detectSubscriptionLogin(o.provider as Any, detectOptions(o, cx))
        .then(detectionLine),
    ),
    cases: [
      cn(
        'a registered source is read',
        w({ ...MAC, children: [codexVersion, codexStatus('Logged in using ChatGPT')] }),
        {
          provider: 'codex',
          locate: found(CODEX),
          registered: { value: { account: { type: 'chatgpt', planType: 'pro', email: 'z@y.io' } } },
        },
      ),
      cn(
        'none registered',
        w({ ...MAC, children: [codexVersion, codexStatus('Logged in using ChatGPT')] }),
        {
          provider: 'codex',
          locate: found(CODEX),
        },
      ),
    ],
  },
  'subscription/service.createSubscriptionStatusService': {
    ts: serviceScenario(),
    cases: serviceCases,
  },
  'subscription/ipc.HIDDEN_LOGIN_TIMEOUT_MS': {
    ts: () => ipcMod.HIDDEN_LOGIN_TIMEOUT_MS,
    single: 'constant',
    cases: [c()],
  },
  'subscription/ipc.registerSubscriptionIpc': { ts: ipcScenario(), cases: ipcCases },
  'subscription/ipc.createSubscriptionIpcDeps': { ts: depsScenario(), cases: depsCases },
  'subscription/ipc.ensureSubscriptionIpc': { ts: sharedScenario(), cases: sharedCases },
  'subscription/ipc.sharedSubscriptionStatuses': { ts: sharedScenario(), cases: sharedCases },
  'subscription/ipc.resetSharedSubscriptionIpc': { ts: sharedScenario(), cases: sharedCases },
}

export { group }
