/**
 * Group `b5-provider`, part `subscription` (Rust:
 * crates/main-core/src/calls/b5_provider/subscription.rs):
 * packages/ai-provider/src/subscription/{contract,env,models,old-names,
 * temp-dirs,leftovers,metered,locate,process}.ts. Names are
 * `subscription/<file>.<export>`.
 *
 * The pure functions take their arguments as given. The ones that touch the
 * machine run in the scripted world of world.ts (their first argument is the
 * world script, the second `o`, the call's options), and the files a case
 * names sit under `$DIR` (the case's folder, which the folder snapshot of the
 * comparison covers).
 *
 * What the TypeScript reads of its own process, and a case cannot set:
 * - `process.uptime()` is 5 s (the temp-dir records name their owner by it);
 * - `SUBSCRIPTION_OWNER_STARTED_AT` is a real clock reading: a record file
 *   writes `"$OWNER"` where it means it, and the number the two sides
 *   substitute while the call runs is put back as `"$OWNER"` after it;
 * - the TypeScript's module state (the shared child registry, the record
 *   directory, the model sources) is put back before each case.
 * - `mkdtemp` names a folder with a counter (`<prefix>000001`), as the Rust
 *   world does.
 * - `open` of a cmd-shim read is a read of the whole file (the world awaits
 *   `readFile`, not a file handle).
 *
 * Cases of `locate` always give the environment, `commonDirs` and
 * `applicationDirs`: the machine's own directories are never searched.
 */
import '../../electron-fake.ts'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import childProcess from 'node:child_process'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../../types.ts'
import { inWorld, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const SUB = '../../../../packages/ai-provider/src/subscription'
const contract = await import(`${SUB}/contract.ts`)
const envMod = await import(`${SUB}/env.ts`)
const modelsMod = await import(`${SUB}/models.ts`)
const oldNames = await import(`${SUB}/old-names.ts`)
const temp = await import(`${SUB}/temp-dirs.ts`)
const leftovers = await import(`${SUB}/leftovers.ts`)
const metered = await import(`${SUB}/metered.ts`)
const locate = await import(`${SUB}/locate.ts`)
const proc = await import(`${SUB}/process.ts`)

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const c = (...args: unknown[]): Case => ({ args })
const cf = (args: unknown[], files: Record<string, FileSpec>, note?: string): Case => ({
  args,
  files,
  ...(note ? { note } : {}),
})
const w = (more: Partial<World> = {}): World => more as World
const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [c()],
  single: 'a constant',
})

const DIR = '$DIR'
/** `Date.now()` of the world: the clock of the call */
const NOW = 1_794_452_400_000
const OWNER_TOKEN = '"$OWNER"'

// ---------------------------------------------------------------------------
// what the cases share
// ---------------------------------------------------------------------------

/** `process.uptime()` is 5 s while `body` runs */
async function withUptime<T>(body: () => Promise<T>): Promise<T> {
  const real = process.uptime
  process.uptime = () => 5
  try {
    return await body()
  } finally {
    process.uptime = real
  }
}

/** `mkdtemp` with a counter for the random part, as the Rust world names folders */
async function withFakeMkdtemp<T>(call: () => Promise<T>): Promise<T> {
  const real = fsp.mkdtemp
  ;(fsp as Any).mkdtemp = async (prefix: string): Promise<string> => {
    for (let n = 1; n < 1000; n++) {
      const path = `${prefix}${String(n).padStart(6, '0')}`
      try {
        mkdirSync(path)
        return path
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
      }
    }
    throw new Error('no free temp name')
  }
  syncBuiltinESMExports()
  try {
    return await call()
  } finally {
    ;(fsp as Any).mkdtemp = real
    syncBuiltinESMExports()
  }
}

/** `open(file).read(...)` as a whole-file read, which the world awaits */
async function withFakeOpen<T>(call: () => Promise<T>): Promise<T> {
  const real = fsp.open
  ;(fsp as Any).open = async (path: string) => {
    const data = await fsp.readFile(path)
    return {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.max(0, Math.min(length, data.length - position))
        data.copy(buffer, offset, position, position + bytesRead)
        return { bytesRead, buffer }
      },
      close: async () => undefined,
    }
  }
  syncBuiltinESMExports()
  try {
    return await call()
  } finally {
    ;(fsp as Any).open = real
    syncBuiltinESMExports()
  }
}

/** The files of `dir`: `from` is put back as `to` in each (a flat folder) */
function swapInFiles(dir: string | undefined, from: string, to: string): void {
  if (!dir || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes(from)) writeFileSync(file, text.split(from).join(to))
  }
}

/** a case's record files carry `"$OWNER"`: the TypeScript's real number is in them while the call runs */
async function withOwner<T>(dir: string | undefined, body: () => Promise<T>): Promise<T> {
  const owner = String(proc.SUBSCRIPTION_OWNER_STARTED_AT)
  swapInFiles(dir, OWNER_TOKEN, owner)
  try {
    return await body()
  } finally {
    swapInFiles(dir, owner, OWNER_TOKEN)
  }
}

/** the shared child registry and the record directories, as a fresh process has them */
async function resetShared(): Promise<void> {
  const registry = proc.sharedSubscriptionChildRegistry()
  await inWorld({}, { now: 0, log: () => undefined, dir: '' }, async () => {
    registry.recordIn(null)
    registry.shutdown()
    await registry.flushed()
  })
  temp.setSubscriptionTempRecordDir(undefined)
  for (const provider of ['claude-code', 'chatgpt', 'codex'])
    modelsMod.setSubscriptionModelSource(provider, null)
}

/** `os.tmpdir()` reads the real environment: here it reads the world's, as the Rust world does */
async function withFakeTmpdir<T>(body: () => Promise<T>): Promise<T> {
  const real = os.tmpdir
  ;(os as Any).tmpdir = (): string => {
    const read = (name: string): string => process.env[name] || ''
    const path = read('TMPDIR') || read('TMP') || read('TEMP') || '/tmp'
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  }
  syncBuiltinESMExports()
  try {
    return await body()
  } finally {
    ;(os as Any).tmpdir = real
    syncBuiltinESMExports()
  }
}
/** a call that leaves no module state behind: the TypeScript keeps it between cases, the Rust does not */
async function scoped<T>(body: () => Promise<T>): Promise<T> {
  await resetShared()
  try {
    return await withFakeTmpdir(body)
  } finally {
    await resetShared()
  }
}

/** the temp-dir records of `dir`, read and removed (their names carry the folder's real path) */
function takeTempRecords(dir: string | undefined): unknown[] {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return []
  const names = readdirSync(dir)
    .filter((name) => /^ai-temp-dir-[0-9a-f]{16}\.json$/.test(name))
    .sort()
  const records = names.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown)
  for (const name of names) rmSync(join(dir, name))
  return records
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

/** `spawn(command, [], {})` of the world: a child nobody has registered */
function childProcessSpawn(command: string): Any {
  return (childProcess as Any).spawn(command, [], {})
}

// ---------------------------------------------------------------------------
// contract.ts
// ---------------------------------------------------------------------------

const STATUS_OK = { provider: 'claude-code', state: 'ready', meteredAccepted: false }
const MODEL_LIST = [
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'opus' },
]

const contractFns: Group = {
  'subscription/contract.SUBSCRIPTION_IPC_CHANNELS': constant(contract.SUBSCRIPTION_IPC_CHANNELS),
  'subscription/contract.SUBSCRIPTION_INSTALL_COMMANDS': constant(
    contract.SUBSCRIPTION_INSTALL_COMMANDS,
  ),
  'subscription/contract.SUBSCRIPTION_MIN_VERSIONS': constant(contract.SUBSCRIPTION_MIN_VERSIONS),
  'subscription/contract.SUBSCRIPTION_UPDATE_COMMANDS': constant(
    contract.SUBSCRIPTION_UPDATE_COMMANDS,
  ),
  'subscription/contract.SUBSCRIPTION_INSTALL_URLS': constant(contract.SUBSCRIPTION_INSTALL_URLS),
  'subscription/contract.SUBSCRIPTION_CHATGPT_USAGE_URL': constant(
    contract.SUBSCRIPTION_CHATGPT_USAGE_URL,
  ),
  'subscription/contract.SUBSCRIPTION_ACCOUNT_MAX_LENGTH': constant(
    contract.SUBSCRIPTION_ACCOUNT_MAX_LENGTH,
  ),
  'subscription/contract.SUBSCRIPTION_MODELS_MAX': constant(contract.SUBSCRIPTION_MODELS_MAX),
  'subscription/contract.SUBSCRIPTION_LOGIN_ERROR_CODE': {
    ts: ([code]) => contract.SUBSCRIPTION_LOGIN_ERROR_CODE.test(code as string),
    cases: [
      c('access_denied'),
      c('a.b-c_9'),
      c(''),
      c('UPPER'),
      c('a'.repeat(64)),
      c('a'.repeat(65)),
      c('has space'),
      c('a\n'),
      c('é'),
    ],
  },
  'subscription/contract.subscriptionVersionOf': {
    ts: ([output]) => contract.subscriptionVersionOf(output as string),
    cases: [
      c('2.1.248 (Claude Code)'),
      c('1.2.3'),
      c('v10.20.30-beta'),
      c('1.2'),
      c(''),
      c('a1.2.3.4b'),
      c('version 0.1.2 and 3.4.5'),
      c('\uff11.\uff12.\uff13'),
      c('1..2.3'),
      c('codex-cli 0.130.0\n'),
    ],
  },
  'subscription/contract.subscriptionVersionAtLeast': {
    ts: ([version, minimum]) =>
      contract.subscriptionVersionAtLeast(version as string, minimum as string),
    cases: [
      c('2.1.248', '2.1.248'),
      c('2.1.249', '2.1.248'),
      c('2.1.247', '2.1.248'),
      c('2.2', '2.1.248'),
      c('3', '2.1.248'),
      c('2.1', '2.1.248'),
      c('x', '1.0.0'),
      c('1.0.0', 'x'),
      c('', '0.0.0'),
      c('1.0.0.5', '1.0.0'),
      c('1.0.0', '1.0.0.1'),
      c('10.0.0', '9.9.9'),
      c('1.0.0', ''),
      c('1.5', '1.5'),
    ],
  },
  'subscription/contract.checkingSubscriptionStatus': {
    ts: ([provider]) => contract.checkingSubscriptionStatus(provider as string),
    cases: [c('claude-code'), c('codex'), c('chatgpt')],
  },
  'subscription/contract.offSubscriptionStatus': {
    ts: ([provider]) => contract.offSubscriptionStatus(provider as string),
    cases: [c('claude-code'), c('codex')],
  },
  'subscription/contract.subscriptionStatusErrorText': {
    ts: ([kind, detail]) => contract.subscriptionStatusErrorText(kind as Any, detail as string),
    cases: [c('needs-update', '2.0.0 is older'), c('timeout', ''), c('failed', 'x: y')],
  },
  'subscription/contract.subscriptionStatusErrorKind': {
    ts: ([status]) => contract.subscriptionStatusErrorKind(status as Any),
    cases: [
      c({ state: 'ready' }),
      c({ state: 'error', error: 'needs-update: x' }),
      c({ state: 'error', error: 'timeout: x' }),
      c({ state: 'error' }),
      c({ state: 'error', error: 'other' }),
      c({ state: 'error', error: 'Needs-update: x' }),
      c({ state: 'signed-out', error: 'timeout:' }),
      c({ state: 'error', error: 'timeout' }),
    ],
  },
  'subscription/contract.subscriptionNeedsUpdate': {
    ts: ([status]) => contract.subscriptionNeedsUpdate(status as Any),
    cases: [
      c({ provider: 'claude-code', state: 'error', error: 'needs-update: old', version: '2.0.0' }),
      c({
        provider: 'claude-code',
        state: 'error',
        error: 'needs-update: old',
        version: '2.1.248',
      }),
      c({ provider: 'claude-code', state: 'error', error: 'needs-update: old', version: '2.1.9' }),
      c({ provider: 'codex', state: 'error', error: 'needs-update: old', version: '0.1.0' }),
      c({ provider: 'claude-code', state: 'error', error: 'needs-update: old' }),
      c({ provider: 'claude-code', state: 'error', error: 'timeout: x', version: '1.0.0' }),
      c({ provider: 'claude-code', state: 'ready', version: '1.0.0' }),
      c({
        provider: 'claude-code',
        state: 'error',
        error: 'needs-update: old',
        version: '1.0.0',
        programPath: '/opt/homebrew/Caskroom/claude-code/2.0.0/claude',
      }),
      c({
        provider: 'claude-code',
        state: 'error',
        error: 'needs-update: old',
        version: '1.0.0',
        programPath: '/opt/homebrew/Caskroom/claude-code@latest/2.0.0/claude',
      }),
      c({
        provider: 'claude-code',
        state: 'error',
        error: 'needs-update: old',
        version: '1.0.0',
        programPath: 'C:\\Homebrew\\Caskroom\\claude-code\\2.0\\claude.exe',
      }),
      c({
        provider: 'claude-code',
        state: 'error',
        error: 'needs-update: old',
        version: '1.0.0',
        programPath: '/opt/Caskroom/claude-code-nightly/1/claude',
      }),
      c({
        provider: 'codex',
        state: 'error',
        error: 'needs-update: old',
        version: '0.1.0',
        programPath: '/opt/Caskroom/claude-code/1/codex',
      }),
    ],
  },
  'subscription/contract.subscriptionProgramPathOf': {
    ts: ([value]) => contract.subscriptionProgramPathOf(value),
    cases: [
      c('/usr/bin/claude'),
      c('C:\\Program Files\\x.exe'),
      c('C:/x'),
      c('\\\\server\\share\\x'),
      c('relative/path'),
      c(''),
      c('/a\nb'),
      c('/a\u0085b'),
      c('/a\u200bb'),
      c(`/${'a'.repeat(32767)}`),
      c(`/${'a'.repeat(32766)}`),
      c(42),
      c(null),
      c('c:x'),
    ],
  },
  'subscription/contract.checkingSubscriptionStatuses': {
    ts: () => contract.checkingSubscriptionStatuses(),
    cases: [c()],
    single: 'no input',
  },
  'subscription/contract.isSubscriptionProviderId': {
    ts: ([value]) => contract.isSubscriptionProviderId(value),
    cases: [
      c('claude-code'),
      c('chatgpt'),
      c('codex'),
      c('other'),
      c(null),
      c(''),
      c('Claude-Code'),
      c(['codex']),
    ],
  },
  'subscription/contract.subscriptionAccountOf': {
    ts: ([value]) => contract.subscriptionAccountOf(value),
    cases: [
      c('a@b.co'),
      c('  a.b+c@example.com  '),
      c('a@b'),
      c('@b.co'),
      c('a@@b.co'),
      c('a b@c.de'),
      c('Name <a@b.co>'),
      c('a@b..co'),
      c('a@-b.co'),
      c('\u00e4@\u00fc.de'),
      c('a@b.c'),
      c(`${'a'.repeat(65)}@b.co`),
      c(`${'a'.repeat(64)}@b.co`),
      c(`a@${'b'.repeat(64)}.co`),
      c(`a@${'b'.repeat(63)}.co`),
      c(
        `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}`,
      ),
      c(5),
      c(null),
      c('x@y.z\n'),
      c('a_b%c-d@e-f.gh'),
      c('\u{1F600}@b.co'),
      c('a@b.\u{1D4B6}\u{1D4B7}'),
      c('a@b.co.'),
      c('a@.b.co'),
      c('a.b@c.d.e'),
      c(''),
    ],
  },
  'subscription/contract.subscriptionModelsOf': {
    ts: ([value]) => contract.subscriptionModelsOf(value),
    cases: [
      c('x'),
      c({}),
      c(null),
      c([]),
      c(MODEL_LIST),
      c([{ id: '', resolved: 'sonnet-4' }]),
      c([{ id: '' }]),
      c([{ id: '', resolved: 'bad id!' }]),
      c([{ id: 'a' }, { id: 'a', label: 'again' }, { id: 'b' }]),
      c([{ id: '-x' }, { id: 'a b' }, { id: ' padded ' }, { id: 5 }, { id: 'ok:v1[2]' }]),
      c([{ id: 'x'.repeat(128) }, { id: 'y'.repeat(129) }]),
      c([{ id: 'm', label: 'Line\none\ttwo   three' }]),
      c([{ id: 'm', label: `${'\u00e9'.repeat(100)}` }]),
      c([{ id: 'm', label: '  \u00a0 spaced \ufeff out  ' }]),
      c([{ id: 'm', efforts: ['bogus', 'high', 'low', ' medium '], defaultEffort: 'medium' }]),
      c([{ id: 'm', efforts: ['low'], defaultEffort: 'high' }]),
      c([{ id: 'm', efforts: ['bogus'], defaultEffort: 'low' }]),
      c([
        { id: 'm', isDefault: true },
        { id: 'n', isDefault: 'true' },
      ]),
      c([null, 'str', [1], 5, { id: 'k' }]),
      c(Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }))),
      c([
        { id: 'm', resolved: 'bad id!' },
        { id: 'n', resolved: ' fine ' },
      ]),
      c([
        { id: '', resolved: 'r1', label: '', isDefault: false },
        { id: 'a', label: '' },
      ]),
      c([{ id: 'm', label: 5 }]),
    ],
  },
  'subscription/contract.subscriptionLoginFailureOf': {
    ts: ([value]) => contract.subscriptionLoginFailureOf(value),
    cases: [
      c({ reason: 'timeout' }),
      c({ reason: 'denied', step: 'token-refused', httpStatus: 401, oauthError: 'invalid_grant' }),
      c({ reason: 'network', httpStatus: 99 }),
      c({ reason: 'network', httpStatus: 600 }),
      c({ reason: 'network', httpStatus: 599 }),
      c({ reason: 'network', httpStatus: 401.5 }),
      c({ reason: 'network', httpStatus: '401' }),
      c({ reason: 'no-plan', oauthError: 'Invalid Code' }),
      c({ reason: 'bogus' }),
      c({ reason: 'timeout', step: 'bogus' }),
      c(null),
      c([]),
      c('timeout'),
      c({ reason: 'timeout', step: 'browser', extra: 1 }),
    ],
  },
  'subscription/contract.subscriptionStatusMapOf': {
    ts: ([value]) => contract.subscriptionStatusMapOf(value),
    cases: [
      c(undefined),
      c(null),
      c('x'),
      c([]),
      c({}),
      c({ 'claude-code': STATUS_OK }),
      c({
        'claude-code': {
          ...STATUS_OK,
          account: ' me@example.com ',
          models: MODEL_LIST,
          version: '2.1.248',
          signingIn: 'browser',
          programPath: '/usr/bin/claude',
        },
        chatgpt: { provider: 'chatgpt', state: 'metered', meteredAccepted: true, account: 'x' },
        codex: { provider: 'codex', state: 'signed-out', meteredAccepted: false },
      }),
      c({ 'claude-code': { provider: 'claude-code', state: 'bogus' }, codex: 5, chatgpt: null }),
      c({ 'claude-code': [], codex: 'ready' }),
      c({
        'claude-code': {
          provider: 'claude-code',
          state: 'error',
          error: 'needs-update: old',
          programPath: '/usr/bin/claude',
          version: '1.0.0',
        },
        codex: {
          provider: 'codex',
          state: 'error',
          error: 'failed: x',
          programPath: '/usr/bin/codex',
        },
      }),
      c({
        'claude-code': {
          provider: 'claude-code',
          state: 'error',
          error: 'needs-update: old',
          programPath: 'relative',
        },
      }),
      c({
        codex: {
          provider: 'codex',
          state: 'off',
          meteredAccepted: 1,
          signingIn: 'window',
        },
        'claude-code': { provider: 'claude-code', state: 'checking', signingIn: 'window' },
      }),
      c({
        codex: {
          provider: 'codex',
          state: 'signed-out',
          loginUnfinished: true,
          loginFailure: { reason: 'denied', step: 'browser', httpStatus: 403, extra: 1 },
        },
        'claude-code': {
          provider: 'claude-code',
          state: 'ready',
          loginUnfinished: true,
          loginFailure: { reason: 'denied' },
        },
        chatgpt: {
          provider: 'chatgpt',
          state: 'signed-out',
          loginUnfinished: 'yes',
          loginFailure: { reason: 'denied' },
        },
      }),
      c({
        'claude-code': {
          state: 'ready',
          provider: 'other',
          meteredAccepted: 'yes',
          version: '1',
          account: 'bad',
          models: [],
        },
      }),
      c({
        'claude-code': {
          signingIn: 'x',
          loginFailure: { reason: 'timeout' },
          state: 'signed-out',
          loginUnfinished: true,
          loginMethod: 'none',
        },
      }),
    ],
  },
  'subscription/contract.subscriptionLaunchResultOf': {
    ts: ([value]) => contract.subscriptionLaunchResultOf(value),
    cases: [
      c({ ok: true }),
      c({ ok: 'true' }),
      c({ ok: false, reason: 'not-installed' }),
      c({ ok: false, reason: 'unsupported', installUrl: 'https://example.com/i', error: 'x' }),
      c({ ok: false, reason: 'bogus' }),
      c({ ok: false, installUrl: 5 }),
      c({ ok: false, reason: 'invalid', installUrl: '' }),
      c(undefined),
      c(null),
      c([]),
      c({ ok: true, reason: 'failed' }),
    ],
  },
  'subscription/contract.subscriptionMeteredResultOf': {
    ts: ([value]) => contract.subscriptionMeteredResultOf(value),
    cases: [
      c({ ok: true, statuses: { 'claude-code': STATUS_OK } }),
      c({ ok: 1, statuses: {} }),
      c({ ok: false }),
      c(null),
      c(undefined),
      c({ ok: true, statuses: 'x' }),
    ],
  },
  'subscription/contract.subscriptionOffResultOf': {
    ts: ([value]) => contract.subscriptionOffResultOf(value),
    cases: [
      c({ ok: true, statuses: { codex: { provider: 'codex', state: 'off' } } }),
      c({ ok: 'true', statuses: null }),
      c(null),
    ],
  },
}

// ---------------------------------------------------------------------------
// env.ts, old-names.ts
// ---------------------------------------------------------------------------

interface EnvOpts {
  base?: Record<string, string>
  platform?: string
  command?: string
  extra?: Record<string, string>
}

const ALL_STRIPPED = Object.fromEntries(
  envMod.SUBSCRIPTION_STRIPPED_ENV_VARS.map((name: string) => [name, 'secret']),
)

const envFns: Group = {
  'subscription/env.SUBSCRIPTION_STRIPPED_ENV_VARS': constant(
    envMod.SUBSCRIPTION_STRIPPED_ENV_VARS,
  ),
  'subscription/old-names.OLD_TRACKED_TEMP_PREFIXES': constant(oldNames.OLD_TRACKED_TEMP_PREFIXES),
  'subscription/env.subscriptionChildEnv': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const opts = (o ?? {}) as EnvOpts
        const env = envMod.subscriptionChildEnv({
          base: opts.base,
          platform: opts.platform as Any,
          command: opts.command,
          extra: opts.extra,
        })
        return Object.entries(env)
      }),
    cases: [
      c(w(), {
        base: { ...ALL_STRIPPED, KEEP: '1', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
        platform: 'linux',
      }),
      c(w(), {
        base: { anthropic_api_key: 'x', Openai_Api_Key: 'y', Path: 'C:\\a', codex_api_key: 'z' },
        platform: 'win32',
      }),
      c(w(), {
        base: { anthropic_api_key: 'x', Openai_Api_Key: 'y', codex_api_key: 'z' },
        platform: 'linux',
      }),
      c(w(), { base: { USERPROFILE: 'C:\\Users\\me' }, platform: 'win32' }),
      c(w(), { base: { USERPROFILE: 'C:\\Users\\me', HOME: 'D:\\home' }, platform: 'win32' }),
      c(w(), { base: { USERPROFILE: 'C:\\Users\\me', HOME: '' }, platform: 'win32' }),
      c(w(), { base: { HOME: '' }, platform: 'win32' }),
      c(w(), { base: { USERPROFILE: 'C:\\Users\\me' }, platform: 'linux' }),
      c(w(), { base: { PATH: '/usr/bin' }, platform: 'linux', command: '/opt/claude/bin/claude' }),
      c(w(), {
        base: { Path: '/usr/bin', PATH: '/x' },
        platform: 'win32',
        command: '/opt/c/claude',
      }),
      c(w(), { base: { path: '/usr/bin' }, platform: 'win32', command: '/opt/c/claude' }),
      c(w(), { base: { A: '1' }, platform: 'linux', command: '/opt/claude/bin/claude' }),
      c(w(), { base: { PATH: '/usr/bin' }, platform: 'linux', command: 'claude' }),
      c(w(), { base: { PATH: '/usr/bin' }, platform: 'linux', command: '' }),
      c(w(), {
        base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x' },
        platform: 'linux',
        command: '/opt/c/claude',
        extra: { ANTHROPIC_API_KEY: 'from-launch', PATH: '/override', ELECTRON_RUN_AS_NODE: '1' },
      }),
      c(w(), { base: { b: '1', '2': 'x', '1': 'y', a: '0' }, platform: 'linux' }),
      c(
        w({
          env: { ANTHROPIC_API_KEY: 'x', OPENAI_BASE_URL: 'y', HOME: '/home/me', PATH: '/bin' },
          platform: 'linux',
        }),
        { command: '/opt/codex/bin/codex' },
      ),
      c(w({ env: { ANTHROPIC_PROFILE: 'p', USERPROFILE: 'C:\\U' }, platform: 'win32' }), {}),
      c(w(), { base: {}, platform: 'linux', extra: { X: 'y' } }),
    ],
  },
}

// ---------------------------------------------------------------------------
// models.ts
// ---------------------------------------------------------------------------

interface ModelsOpts {
  provider: string
  source?: 'ok' | 'hang' | 'none' | 'removed' | 'other'
  timeoutMs?: number
  configuredPath?: string
}

const modelsFns: Group = {
  'subscription/models.SUBSCRIPTION_MODELS_TIMEOUT_MS': constant(
    modelsMod.SUBSCRIPTION_MODELS_TIMEOUT_MS,
  ),
  'subscription/models.listSubscriptionModels': {
    ts: ([world, o], cx) =>
      scoped(() =>
        inWorld(world as World, cx, async (run) => {
          const opts = o as ModelsOpts
          const source = opts.source ?? 'ok'
          if (source !== 'none') {
            modelsMod.setSubscriptionModelSource(
              source === 'other' ? 'codex' : opts.provider,
              async ({
                configuredPath,
                signal,
              }: {
                configuredPath?: string
                signal: AbortSignal
              }) => {
                signal.addEventListener('abort', () => cx.log('aborted'))
                if (source === 'hang') return new Promise(() => undefined)
                return run.call('modelSource')(configuredPath)
              },
            )
            if (source === 'removed') modelsMod.setSubscriptionModelSource(opts.provider, null)
          }
          return await modelsMod.listSubscriptionModels(opts.provider as Any, {
            configuredPath: opts.configuredPath,
            timeoutMs: opts.timeoutMs,
          })
        }),
      ),
    cases: [
      c(w({ calls: [MODEL_LIST] }), { provider: 'claude-code' }),
      c(w({ calls: [MODEL_LIST] }), { provider: 'codex', configuredPath: '/opt/codex' }),
      c(w({ calls: ['not an array'] }), { provider: 'claude-code' }),
      c(w({ calls: [[]] }), { provider: 'claude-code' }),
      c(w({ calls: [{ reject: 'boom' }] }), { provider: 'claude-code' }),
      c(w({ calls: [[{ id: 'bad id!' }, { id: 'ok' }]] }), { provider: 'claude-code' }),
      c(w(), { provider: 'claude-code', source: 'hang' }),
      c(w(), { provider: 'claude-code', source: 'hang', timeoutMs: 50 }),
      c(w({ calls: [MODEL_LIST] }), { provider: 'claude-code', source: 'none' }),
      c(w({ calls: [MODEL_LIST] }), { provider: 'claude-code', source: 'removed' }),
      c(w({ calls: [MODEL_LIST] }), { provider: 'claude-code', source: 'other' }),
      c(w({ calls: [MODEL_LIST] }), { provider: 'claude-code', timeoutMs: 0 }),
    ],
  },
}

// ---------------------------------------------------------------------------
// temp-dirs.ts
// ---------------------------------------------------------------------------

interface TempOpts {
  prefix?: string
  tempRoot?: string
  moduleDir?: string
  recordDir?: string
  ownerPid?: number
  remove?: 'created' | 'missing' | 'twice'
  dir?: string
  alive?: number[]
  system?: boolean
}

const CLAUDE_PREFIX = 'seuoffice-claude-code-'
const CODEX_PREFIX = 'seuoffice-codex-app-server-'

async function tempCall<T>(
  world: unknown,
  o: TempOpts,
  cx: TsContext,
  body: () => Promise<T>,
): Promise<T> {
  return scoped(() =>
    withUptime(() =>
      withFakeMkdtemp(() =>
        inWorld(world as World, cx, async () => {
          temp.setSubscriptionTempRecordDir(o.moduleDir)
          return await body()
        }),
      ),
    ),
  )
}

const TMP: Record<string, FileSpec> = { tmp: { dir: true } }

/** one record of a case: the folder it names, its owner, when the owner started */
const record = (path: string, ownerPid: number, ownerStartedAt: number, more: object = {}) =>
  JSON.stringify({ version: 1, path, ownerPid, ownerStartedAt, ...more })

const OLD_START = 1
const OWN_START = NOW - 5000

const tempFns: Group = {
  'subscription/temp-dirs.TRACKED_TEMP_PREFIXES': constant(temp.TRACKED_TEMP_PREFIXES),
  'subscription/temp-dirs.createTrackedTempDir': {
    ts: ([world, o], cx) =>
      tempCall(world, o as TempOpts, cx, async () => {
        const opts = o as TempOpts
        const path = await temp.createTrackedTempDir(opts.prefix as Any, {
          tempRoot: opts.tempRoot,
          recordDir: opts.recordDir,
          ownerPid: opts.ownerPid,
        })
        return { path, records: takeTempRecords(opts.recordDir ?? opts.moduleDir) }
      }),
    cases: [
      cf([w(), { prefix: CLAUDE_PREFIX, tempRoot: `${DIR}/tmp`, moduleDir: `${DIR}/rec` }], TMP),
      cf([w(), { prefix: CODEX_PREFIX, tempRoot: `${DIR}/tmp` }], TMP, 'no record directory'),
      cf(
        [
          w(),
          {
            prefix: CLAUDE_PREFIX,
            tempRoot: `${DIR}/tmp`,
            moduleDir: `${DIR}/rec`,
            recordDir: `${DIR}/other`,
          },
        ],
        TMP,
        'the option wins over the module directory',
      ),
      cf(
        [
          w(),
          {
            prefix: CLAUDE_PREFIX,
            tempRoot: `${DIR}/tmp`,
            recordDir: `${DIR}/rec`,
            ownerPid: 4321,
          },
        ],
        TMP,
      ),
      cf(
        [w(), { prefix: CLAUDE_PREFIX, tempRoot: `${DIR}/tmp`, recordDir: `${DIR}/rec` }],
        { ...TMP, rec: 'a file where the record directory should be' },
        'the record cannot be written: the folder is still made',
      ),
      cf(
        [w({ env: { TMPDIR: `${DIR}/tmp` } }), { prefix: CLAUDE_PREFIX, moduleDir: `${DIR}/rec` }],
        TMP,
        'the system temporary directory',
      ),
      cf(
        [
          w(),
          { prefix: CLAUDE_PREFIX, tempRoot: `${DIR}/tmp`, recordDir: '', moduleDir: `${DIR}/rec` },
        ],
        TMP,
        'an empty record directory is none',
      ),
      cf(
        [w(), { prefix: CLAUDE_PREFIX, tempRoot: `${DIR}/tmp`, moduleDir: `${DIR}/rec` }],
        { ...TMP, 'tmp/seuoffice-claude-code-000001': { dir: true } },
        'the first name is taken',
      ),
    ],
  },
  'subscription/temp-dirs.removeTrackedTempDir': {
    ts: ([world, o], cx) =>
      tempCall(world, o as TempOpts, cx, async () => {
        const opts = o as TempOpts
        const options = { tempRoot: opts.tempRoot, recordDir: opts.recordDir }
        const path = await temp.createTrackedTempDir(opts.prefix as Any, options)
        writeFileSync(join(path, 'inner.txt'), 'x')
        const target = opts.remove === 'missing' ? `${opts.tempRoot}/does-not-exist` : path
        await temp.removeTrackedTempDir(target, options)
        if (opts.remove === 'twice') await temp.removeTrackedTempDir(target, options)
        return {
          existsAfter: existsSync(path),
          records: takeTempRecords(opts.recordDir ?? opts.moduleDir).length,
        }
      }),
    cases: [
      cf([w(), { prefix: CLAUDE_PREFIX, tempRoot: `${DIR}/tmp`, moduleDir: `${DIR}/rec` }], TMP),
      cf([w(), { prefix: CODEX_PREFIX, tempRoot: `${DIR}/tmp` }], TMP, 'no record directory'),
      cf(
        [
          w(),
          {
            prefix: CLAUDE_PREFIX,
            tempRoot: `${DIR}/tmp`,
            recordDir: `${DIR}/rec`,
            remove: 'missing',
          },
        ],
        TMP,
        'another folder is removed: the record of the made one stays',
      ),
      cf(
        [
          w(),
          {
            prefix: CLAUDE_PREFIX,
            tempRoot: `${DIR}/tmp`,
            moduleDir: `${DIR}/rec`,
            remove: 'twice',
          },
        ],
        TMP,
      ),
    ],
  },
  'subscription/temp-dirs.cleanupTrackedTempDirs': {
    ts: ([world, o], cx) =>
      tempCall(world, o as TempOpts, cx, async () => {
        const opts = o as TempOpts
        const calls: number[] = []
        // `system`: the module's own processAlive, through the world's process.kill
        const removed = await temp.cleanupTrackedTempDirs(opts.dir as string, {
          tempRoot: opts.tempRoot,
          ...(opts.system
            ? {}
            : {
                alive: (pid: number) => {
                  calls.push(pid)
                  return (opts.alive ?? []).includes(pid)
                },
              }),
        })
        return { removed, aliveCalls: calls.sort((a, b) => a - b) }
      }),
    cases: [
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/inner/file.txt`]: 'x',
        },
        'a dead owner: the folder and its record go',
      ),
      cf(
        [
          w({ killFails: [77] } as Any),
          { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp`, system: true },
        ],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/inner/file.txt`]: 'x',
        },
        'the system says the owner is gone (ESRCH): the folder and its record go',
      ),
      cf(
        [
          w({ killDenied: [77] } as Any),
          { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp`, system: true },
        ],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/inner/file.txt`]: 'x',
        },
        'the owner belongs to another user (EPERM): alive, the folder stays',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp`, system: true }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/inner/file.txt`]: 'x',
        },
        'the system says the owner runs: the folder stays',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp`, alive: [77] }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/file.txt`]: 'x',
        },
        'a live owner: kept, record and all',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 1000, OWN_START),
          'rec/ai-temp-dir-bbbb.json': record(`${DIR}/tmp/${CODEX_PREFIX}bbb`, 1000, OLD_START),
          [`tmp/${CLAUDE_PREFIX}aaa/file.txt`]: 'x',
          [`tmp/${CODEX_PREFIX}bbb/file.txt`]: 'x',
        },
        'this process, this run: kept; this pid, an earlier run: removed',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(
            `${DIR}/tmp/${CLAUDE_PREFIX}aaa`,
            1000,
            OWN_START + 9999,
          ),
          'rec/ai-temp-dir-bbbb.json': record(
            `${DIR}/tmp/${CODEX_PREFIX}bbb`,
            1000,
            OWN_START + 10001,
          ),
          [`tmp/${CLAUDE_PREFIX}aaa/file.txt`]: 'x',
          [`tmp/${CODEX_PREFIX}bbb/file.txt`]: 'x',
        },
        'the start slack of the owner is 10 s',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-1.json': 'not json',
          'rec/ai-temp-dir-2.json': 'null',
          'rec/ai-temp-dir-3.json': '[]',
          'rec/ai-temp-dir-4.json': '"text"',
          'rec/ai-temp-dir-5.json': JSON.stringify({ ownerPid: 1, ownerStartedAt: 1 }),
          'rec/ai-temp-dir-6.json': record('', 1, 1),
          'rec/ai-temp-dir-7.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}x`, 1.5, 1),
          'rec/ai-temp-dir-8.json': JSON.stringify({
            path: `${DIR}/tmp/${CLAUDE_PREFIX}x`,
            ownerPid: 1,
            ownerStartedAt: 'now',
          }),
          'rec/ai-temp-dir-9.json': '',
          [`tmp/${CLAUDE_PREFIX}x/file.txt`]: 'x',
        },
        'malformed records go, the folder they name stays',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/other/${CLAUDE_PREFIX}x`, 77, 1),
          'rec/ai-temp-dir-bbbb.json': record(`${DIR}/tmp/sub/${CLAUDE_PREFIX}x`, 77, 1),
          'rec/ai-temp-dir-cccc.json': record(`${DIR}/tmp/other-prefix-x`, 77, 1),
          'rec/ai-temp-dir-dddd.json': record(`${DIR}/tmp`, 77, 1),
          [`other/${CLAUDE_PREFIX}x/file.txt`]: 'x',
          [`tmp/sub/${CLAUDE_PREFIX}x/file.txt`]: 'x',
          'tmp/other-prefix-x/file.txt': 'x',
        },
        'not directly under the temporary directory, or not this app prefix: the record goes, the folder stays',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/genoffice-codex-app-server-old`, 77, 1),
          'rec/ai-temp-dir-bbbb.json': record(`${DIR}/tmp/genoffice-claude-code-old`, 77, 1),
          'rec/ai-temp-dir-cccc.json': record(`${DIR}/tmp/../tmp/${CODEX_PREFIX}dots`, 77, 1),
          'tmp/genoffice-codex-app-server-old/file.txt': 'x',
          'tmp/genoffice-claude-code-old/file.txt': 'x',
          [`tmp/${CODEX_PREFIX}dots/file.txt`]: 'x',
        },
        'the old names are removed too; a path is resolved first',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}gone`, 77, 1),
          'rec/ai-temp-dir-bbbb.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}file`, 77, 1),
          [`tmp/${CLAUDE_PREFIX}file`]: 'a file, not a folder',
        },
        'the folder is gone already (the record goes, nothing is counted); the path is a file',
      ),
      cf(
        [w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp`, alive: [88] }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}a`, 77, 1),
          'rec/ai-temp-dir-bbbb.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}b`, 88, 1),
          'rec/ai-temp-dir-cccc.json': record(`${DIR}/tmp/${CODEX_PREFIX}c`, 99, 1),
          'rec/notes.json': '{}',
          'rec/ai-temp-dir-dddd.txt': 'x',
          'rec/other-aaaa.json': 'x',
          [`tmp/${CLAUDE_PREFIX}a/x`]: 'x',
          [`tmp/${CLAUDE_PREFIX}b/x`]: 'x',
          [`tmp/${CODEX_PREFIX}c/x`]: 'x',
        },
        'several records; files that are no records are left alone',
      ),
      cf([w(), { dir: `${DIR}/missing`, tempRoot: `${DIR}/tmp` }], TMP, 'no record directory'),
      cf([w(), { dir: `${DIR}/rec`, tempRoot: `${DIR}/tmp` }], { ...TMP, rec: { dir: true } }),
      cf(
        [w({ env: { TMPDIR: `${DIR}/tmp` } }), { dir: `${DIR}/rec` }],
        {
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}aaa`, 77, 1, {
            version: 3,
          }),
          [`tmp/${CLAUDE_PREFIX}aaa/file.txt`]: 'x',
        },
        'the system temporary directory is the default root',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// metered.ts
// ---------------------------------------------------------------------------

interface MeteredOpts {
  dir: string
  steps: ([string] | [string, Record<string, unknown>])[]
}

const METERED = (loginKind: string, loginMethod?: string) => ({
  provider: 'claude-code',
  state: 'metered',
  loginMethod,
  loginKind,
})

const meteredFns: Group = {
  'subscription/metered.SUBSCRIPTION_METERED_FILE': constant(metered.SUBSCRIPTION_METERED_FILE),
  'subscription/metered.METERED_LOGIN_FINGERPRINTS': constant(metered.METERED_LOGIN_FINGERPRINTS),
  'subscription/metered.meteredLoginFingerprint': {
    ts: ([detection]) => metered.meteredLoginFingerprint(detection as Any),
    cases: [
      c(METERED('api_key/firstParty', 'metered')),
      c(METERED('api_key/firstParty')),
      c(METERED('unknown:oauth_token/firstParty', 'unknown')),
      c(METERED('not-a-kind', 'metered')),
      c(METERED('chatgpt', 'metered')),
      c(METERED('unknown', 'other')),
      c({ provider: 'claude-code', state: 'ready', loginKind: 'chatgpt' }),
      c({ provider: 'claude-code', state: 'signed-out' }),
      c({ provider: 'claude-code', state: 'metered' }),
    ],
  },
  'subscription/metered.reconcileMeteredAcceptance': {
    ts: ([detection, stored]) =>
      metered.reconcileMeteredAcceptance(detection as Any, stored as Any),
    cases: [
      c(METERED('api_key/firstParty', 'metered'), {
        accepted: true,
        fingerprint: 'metered:api_key/firstParty',
      }),
      c(METERED('api_key/firstParty', 'metered'), {
        accepted: true,
        fingerprint: 'metered:unknown',
      }),
      c(METERED('api_key/firstParty', 'metered'), {
        accepted: false,
        fingerprint: 'metered:api_key/firstParty',
      }),
      c(METERED('api_key/firstParty', 'metered'), { accepted: true }),
      c(METERED('api_key/firstParty', 'metered'), { accepted: false }),
      c(METERED('api_key/firstParty', 'unknown'), {
        accepted: true,
        fingerprint: 'metered:api_key/firstParty',
      }),
      c(
        { provider: 'claude-code', state: 'ready' },
        { accepted: true, fingerprint: 'metered:unknown' },
      ),
      c({ provider: 'claude-code', state: 'ready' }, { accepted: false }),
      c({ provider: 'claude-code', state: 'signed-out' }, { accepted: false, fingerprint: 'x' }),
      c(
        { provider: 'claude-code', state: 'error' },
        { accepted: true, fingerprint: 'metered:unknown' },
      ),
      c({ provider: 'claude-code', state: 'not-installed' }, { accepted: true }),
      c(METERED('unknown', 'metered'), { accepted: false, fingerprint: '' }),
    ],
  },
  'subscription/metered.createMeteredAcceptanceFileStore': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const opts = o as MeteredOpts
        const store = metered.createMeteredAcceptanceFileStore(opts.dir)
        const results: unknown[] = []
        for (const [step, record] of opts.steps) {
          if (step === 'read') results.push(await store.read())
          else {
            await store.write(record as Any)
            results.push(null)
          }
        }
        return results
      }),
    cases: [
      c(w(), { dir: `${DIR}/data`, steps: [['read']] }),
      c(w(), {
        dir: `${DIR}/data`,
        steps: [
          ['write', { codex: 'metered:unknown', 'claude-code': 'unknown:chatgpt' }],
          ['read'],
        ],
      }),
      c(w(), {
        dir: `${DIR}/data`,
        steps: [
          [
            'write',
            {
              codex: 'bogus',
              chatgpt: 'metered:unknown',
              other: 'metered:unknown',
              'claude-code': '',
            },
          ],
          ['read'],
        ],
      }),
      c(w(), { dir: `${DIR}/a/b/data`, steps: [['write', {}], ['read']] }),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        { 'data/subscription-metered.json': 'not json' },
        'corrupt',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        {
          'data/subscription-metered.json': JSON.stringify({
            codex: 'metered:unknown',
            'claude-code': 'metered:nope',
            chatgpt: 5,
            other: 'metered:unknown',
          }),
        },
        'values an earlier build wrote are no acceptance',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        {
          'data/subscription-metered.json':
            '{"codex":"metered:unknown","claude-code":"unknown:unknown"}',
        },
        'the order of the providers, not of the file',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        { 'data/subscription-metered.json': '[]' },
        'an array',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        { 'data/subscription-metered.json': 'null' },
        'null',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        { 'data/subscription-metered.json': '42' },
        'a number',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['read']] }],
        { 'data/subscription-metered.json': '\ufeff{"codex":"metered:unknown"}' },
        'a byte order mark',
      ),
      cf(
        [w(), { dir: `${DIR}/data`, steps: [['write', { codex: 'unknown:unknown' }], ['read']] }],
        { 'data/subscription-metered.json': '{"codex":"metered:unknown"}' },
        'written over',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// locate.ts
// ---------------------------------------------------------------------------

interface LocateOpts {
  provider: string
  configured?: string
  env: Record<string, string>
  platform?: string
  arch?: string
  node?: { command: string; electron?: boolean }
  managed?: string
  apps?: string[]
  common?: string[]
  versions?: [string, string][]
}

function locateOptions(o: LocateOpts, cx: TsContext): Any {
  return {
    configuredPath: o.configured,
    env: o.env,
    platform: o.platform,
    arch: o.arch,
    nodeRuntime: o.node,
    managedInstallRoot: o.managed,
    applicationDirs: o.apps ?? [],
    commonDirs: o.common ?? [],
    readVersion: o.versions
      ? async (program: { entry: string }) => {
          cx.log('version', program.entry)
          return o.versions?.find(([entry]) => entry === program.entry)?.[1]
        }
      : undefined,
  }
}

const EXE: FileSpec = { text: '#!/bin/sh\n', mode: 0o755 }
const exe = (mtimeMs: number): FileSpec => ({ text: '#!/bin/sh\n', mode: 0o755, mtimeMs })
const PLAIN: FileSpec = { text: 'not executable', mode: 0o644 }

const HOME = `${DIR}/home`
const posixEnv = (path: string, more: Record<string, string> = {}) => ({
  HOME,
  PATH: path,
  ...more,
})
const winEnv = (path: string, more: Record<string, string> = {}) => ({
  USERPROFILE: HOME,
  APPDATA: `${DIR}/appdata`,
  LOCALAPPDATA: `${DIR}/local`,
  PATH: path,
  ...more,
})
const CLAUDE = (more: Partial<LocateOpts> = {}): LocateOpts => ({
  provider: 'claude-code',
  env: posixEnv(`${DIR}/bin`),
  ...more,
})
const CODEX = (more: Partial<LocateOpts> = {}): LocateOpts => ({
  provider: 'codex',
  env: posixEnv(`${DIR}/bin`),
  ...more,
})
const WIN_CLAUDE = (more: Partial<LocateOpts> = {}): LocateOpts => ({
  provider: 'claude-code',
  platform: 'win32',
  arch: 'x64',
  env: winEnv(`${DIR}/bin`),
  node: { command: '/opt/node/node', electron: false },
  ...more,
})
const WIN_CODEX = (more: Partial<LocateOpts> = {}): LocateOpts => ({
  ...WIN_CLAUDE(),
  provider: 'codex',
  ...more,
})

const CLAUDE_EXE_SHIM =
  '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
const CODEX_JS_SHIM = '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
const NPM_CODEX = 'npm/node_modules/@openai/codex'
const VENDOR_LINUX_ARM = 'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl'

/** the world's two answers of a version run: `2.0.0` and `2.1.300` */
const VERSION_KIDS = [
  { stdout: ['claude 2.0.0\n'], closeOn: 'start' as const },
  { stdout: ['2.1.300 (Claude Code)\n'], closeOn: 'start' as const },
]

const locateCases: Case[] = [
  cf([w(), CLAUDE()], { 'bin/claude': EXE }, 'one copy on PATH: its version is not read'),
  cf([w(), CODEX()], { 'bin/codex': PLAIN }, 'not executable'),
  cf([w(), CODEX()], { bin: { dir: true } }, 'no program at all'),
  cf(
    [w(), CODEX({ env: posixEnv(`${DIR}/none:${DIR}/bin2:${DIR}/bin`) })],
    { 'bin/codex': EXE, 'bin2/codex': EXE },
    'the first directory with one wins',
  ),
  cf(
    [w(), CODEX({ env: posixEnv(`relative:/:${DIR}/bin: :"${DIR}/bin"`) })],
    { 'bin/codex': EXE },
    'relative and empty entries are left out; quotes are taken off',
  ),
  cf(
    [
      w(),
      CLAUDE({
        env: posixEnv(`${DIR}/bin1:${DIR}/bin2`),
        versions: [
          [`${DIR}/bin1/claude`, '2.0.0'],
          [`${DIR}/bin2/claude`, '2.1.300'],
        ],
      }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE },
    'two copies: the first one too old, the second new enough',
  ),
  cf(
    [
      w(),
      CLAUDE({
        env: posixEnv(`${DIR}/bin1:${DIR}/bin2`),
        versions: [
          [`${DIR}/bin1/claude`, '1.0.0'],
          [`${DIR}/bin2/claude`, '2.1.247'],
        ],
      }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE },
    'both too old: the first',
  ),
  cf(
    [
      w(),
      CLAUDE({
        env: posixEnv(`${DIR}/bin1:${DIR}/bin2`),
        versions: [
          [`${DIR}/bin1/claude`, '2.1.248'],
          [`${DIR}/bin2/claude`, '3.0.0'],
        ],
      }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE },
    'the first new enough: the second is never asked',
  ),
  cf(
    [
      w(),
      CLAUDE({
        env: posixEnv(`${DIR}/bin1:${DIR}/bin2:${DIR}/bin3`),
        versions: [
          [`${DIR}/bin1/claude`, '1.0.0'],
          [`${DIR}/bin3/claude`, '2.5.0'],
        ],
      }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE, 'bin3/claude': EXE },
    'three copies: the third is the first new enough; an unknown version is too old',
  ),
  cf(
    [
      w(),
      CLAUDE({
        env: posixEnv(`${DIR}/bin:${DIR}/bin`),
        common: [`${DIR}/bin`],
        versions: [[`${DIR}/bin/claude`, '1.0.0']],
      }),
    ],
    { 'bin/claude': EXE },
    'one file reached three ways is one copy',
  ),
  cf(
    [
      w({ children: VERSION_KIDS, env: { HOME: '/h', PATH: '/p', ANTHROPIC_API_KEY: 'k' } }),
      CLAUDE({ env: posixEnv(`${DIR}/bin1:${DIR}/bin2`) }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE },
    'the version is the CLI own `--version` run',
  ),
  cf(
    [
      w({
        children: [
          { stdout: ['no version here'], closeOn: 'start' },
          { stdout: ['x'], closeOn: 'start' },
        ],
      }),
      CLAUDE({ env: posixEnv(`${DIR}/bin1:${DIR}/bin2`) }),
    ],
    { 'bin1/claude': EXE, 'bin2/claude': EXE },
    'no version printed: both too old',
  ),
  cf(
    [w(), CLAUDE({ env: posixEnv(`${DIR}/none`), common: [`${DIR}/common`] })],
    { 'common/claude': EXE },
    'the common directories after PATH',
  ),
  cf([w(), CLAUDE({ env: posixEnv(`${DIR}/none`), common: [`${DIR}/c1`, `${DIR}/c2`] })], {
    'c1/claude': PLAIN,
    'c2/claude': EXE,
  }),
  cf(
    [w(), CODEX({ configured: `${DIR}/mine/codex` })],
    { 'mine/codex': EXE, 'bin/codex': EXE },
    'a configured file wins',
  ),
  cf(
    [w(), CODEX({ configured: `  "${DIR}/mine"  ` })],
    { 'mine/codex': EXE, 'bin/codex': EXE },
    'a configured directory, quoted',
  ),
  cf(
    [w(), CODEX({ configured: `${DIR}/nowhere/codex` })],
    { 'bin/codex': EXE },
    'a configured path that is gone is automatic',
  ),
  cf(
    [w(), CODEX({ configured: 'mycodex', env: posixEnv(`${DIR}/bin`) })],
    { 'bin/mycodex': EXE, 'bin/codex': EXE },
    'a bare command name',
  ),
  cf(
    [w(), CODEX({ configured: 'mycodex.exe', env: posixEnv(`${DIR}/bin`) })],
    { 'bin/mycodex': EXE },
    'a bare name with .exe',
  ),
  cf(
    [w(), CODEX({ configured: 'missing', env: posixEnv(`${DIR}/bin`) })],
    { 'bin/codex': EXE },
    'a bare name that is not there: automatic',
  ),
  cf(
    [w(), CODEX({ configured: '~/bin/codex', env: posixEnv(`${DIR}/none`) })],
    { 'home/bin/codex': EXE },
    'the home directory',
  ),
  cf(
    [w(), CODEX({ configured: '~', env: posixEnv(`${DIR}/none`) })],
    { 'home/codex': EXE },
    'the home directory itself is a directory',
  ),
  cf(
    [w(), CODEX({ configured: `${DIR}/mine/codex` })],
    { mine: { dir: true } },
    'neither a file nor a directory there',
  ),
  cf(
    [w(), CODEX({ managed: `${DIR}/managed`, env: posixEnv(`${DIR}/bin`) })],
    {
      'managed/aaa/codex': exe(1_700_000_000_000),
      'managed/bbb/codex': exe(1_700_000_100_000),
      'managed/note.txt': 'a file among the releases',
      'bin/codex': EXE,
    },
    'the Codex app tree: the newest release wins over PATH',
  ),
  cf(
    [w(), CODEX({ managed: `${DIR}/managed` })],
    {
      'managed/aaa/codex': exe(1_700_000_000_000),
      'managed/bbb/codex': exe(1_700_000_000_000),
    },
    'the same time: the path that sorts later',
  ),
  cf(
    [w(), CODEX({ managed: `${DIR}/managed`, configured: `${DIR}/managed/aaa/codex` })],
    { 'managed/aaa/codex': exe(1_700_000_000_000), 'bin/codex': EXE },
    'a configured path inside the tree is automatic',
  ),
  cf(
    [w(), CLAUDE({ managed: `${DIR}/managed` })],
    { 'managed/aaa/codex': exe(1_700_000_000_000), 'bin/claude': EXE },
    'the tree is for Codex only',
  ),
  cf(
    [w(), CODEX({ platform: 'darwin', apps: [`${DIR}/apps`] })],
    {
      'apps/Codex.app/Contents/Resources/codex': exe(1_700_000_100_000),
      'bin/codex': exe(1_700_000_000_000),
    },
    'macOS: the app copy is newer than the one on PATH',
  ),
  cf(
    [w(), CODEX({ platform: 'darwin', apps: [`${DIR}/apps`] })],
    {
      'apps/Codex.app/Contents/Resources/codex': exe(1_700_000_000_000),
      'bin/codex': exe(1_700_000_100_000),
    },
    'macOS: updating the CLI yourself wins',
  ),
  cf(
    [w(), CODEX({ platform: 'darwin', apps: [`${DIR}/apps`] })],
    { 'apps/Codex.app/Contents/Resources/codex': exe(1_700_000_000_000) },
    'macOS: no CLI on PATH',
  ),
  cf(
    [w(), CODEX({ platform: 'darwin', apps: [`${DIR}/apps`, `${DIR}/apps2`] })],
    {
      'apps/Codex.app/Contents/Resources/codex': exe(1_700_000_000_000),
      'apps/ChatGPT.app/Contents/Resources/codex': exe(1_700_000_050_000),
      'apps2/Codex.app/Contents/Resources/codex': exe(1_700_000_050_000),
    },
    'macOS: the newest bundle, the earlier one on a tie',
  ),
  cf(
    [w(), CODEX({ platform: 'darwin', apps: [`${DIR}/apps`] })],
    {
      'apps/Codex.app/Contents/Resources/codex': {
        text: 'x',
        mode: 0o644,
        mtimeMs: 1_700_000_000_000,
      },
    },
    'macOS: a bundle that cannot run',
  ),
  cf(
    [w(), CLAUDE({ platform: 'darwin', apps: [`${DIR}/apps`] })],
    { 'apps/Codex.app/Contents/Resources/codex': exe(1_700_000_000_000) },
    'macOS: the app is for Codex only',
  ),
  cf(
    [
      w(),
      CODEX({
        platform: 'linux',
        arch: 'arm64',
        configured: `${DIR}/npm/@openai/codex/bin/codex.js`,
      }),
    ],
    {
      'npm/@openai/codex/bin/codex.js': 'js',
      [`npm/@openai/codex/${VENDOR_LINUX_ARM}/bin/codex`]: EXE,
    },
    'npm package: the native binary under its own node_modules',
  ),
  cf(
    [
      w(),
      CODEX({
        platform: 'linux',
        arch: 'arm64',
        configured: `${DIR}/npm/@openai/codex/bin/codex.js`,
      }),
    ],
    {
      'npm/@openai/codex/bin/codex.js': 'js',
      'npm/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex': EXE,
    },
    'npm package: the sibling platform package',
  ),
  cf(
    [
      w(),
      CODEX({
        platform: 'linux',
        arch: 'x64',
        configured: `${DIR}/npm/@openai/codex/bin/codex.js`,
      }),
    ],
    {
      'npm/@openai/codex/bin/codex.js': 'js',
      'npm/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex': EXE,
    },
    'npm package: its own vendor tree',
  ),
  cf(
    [
      w(),
      CODEX({
        platform: 'linux',
        arch: 'ia32',
        configured: `${DIR}/npm/@openai/codex/bin/codex.js`,
      }),
    ],
    { 'npm/@openai/codex/bin/codex.js': 'js' },
    'no native binary for this CPU: the file as it is',
  ),
  cf(
    [w(), CODEX({ platform: 'linux', arch: 'x64', configured: `${DIR}/npm/other/cli.js` })],
    { 'npm/other/cli.js': 'js' },
    'not the known layout',
  ),
  cf(
    [
      w(),
      CODEX({
        platform: 'linux',
        arch: 'x64',
        configured: `${DIR}/npm/@openai/codex/bin/codex.js`,
      }),
    ],
    { 'npm/@openai/codex/bin/codex.js': 'js' },
    'the layout without a vendor tree',
  ),
  cf([w(), WIN_CLAUDE()], { 'bin/claude.exe': 'MZ' }, 'Windows: a native program on PATH'),
  cf(
    [w(), WIN_CLAUDE()],
    {
      'bin/claude.cmd': CLAUDE_EXE_SHIM,
      'bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe': 'MZ',
    },
    'Windows: the program behind a .cmd shim',
  ),
  cf(
    [w(), WIN_CLAUDE()],
    {
      'bin/claude.cmd':
        '@ECHO off\r\n"%dp0%\\..\\evil.exe" %*\r\n"%~dp0\\node_modules\\x\\y.js"\r\n',
      'evil.exe': 'MZ',
      'bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe': 'MZ',
    },
    'Windows: a target with .. is left out; the shim own package path is the fallback',
  ),
  cf(
    [w(), WIN_CLAUDE()],
    { 'bin/claude.cmd': 'nothing useful in here', 'bin/other': 'x' },
    'Windows: a shim that leads nowhere',
  ),
  cf(
    [w(), WIN_CLAUDE()],
    {
      'bin/claude.cmd':
        '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"\r\n',
      'bin/node.exe': 'MZ',
      'bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe': 'MZ',
    },
    'Windows: the shim own node.exe is not the CLI',
  ),
  cf(
    [w(), WIN_CODEX({ arch: 'x64' })],
    {
      'bin/codex.cmd': CODEX_JS_SHIM,
      [`bin/${NPM_CODEX.replace('npm/', '')}/bin/codex.js`]: 'js',
      'bin/node.exe': 'MZ',
    },
    'Windows: a JS entry runs on the node.exe next to the shim',
  ),
  cf(
    [w(), WIN_CODEX({ arch: 'x64', node: { command: '/opt/electron/app', electron: true } })],
    {
      'bin/codex.cmd': CODEX_JS_SHIM,
      [`bin/${NPM_CODEX.replace('npm/', '')}/bin/codex.js`]: 'js',
    },
    'Windows: a JS entry on the app own runtime (Electron as Node)',
  ),
  cf(
    [w(), WIN_CODEX({ arch: 'x64' })],
    {
      'bin/codex.cmd': CODEX_JS_SHIM,
      'bin/node_modules/@openai/codex/bin/codex.js': 'js',
      'bin/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe':
        'MZ',
    },
    'Windows: the native binary the launcher would start',
  ),
  cf(
    [w(), WIN_CODEX({ arch: 'arm64' })],
    {
      'bin/codex.cmd': CODEX_JS_SHIM,
      'bin/node_modules/@openai/codex/bin/codex.js': 'js',
      'bin/node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/codex/codex.exe': 'MZ',
    },
    'Windows: the older vendor layout is started directly too',
  ),
  cf(
    [w(), WIN_CLAUDE({ env: winEnv('') })],
    { 'appdata/npm/claude.exe': 'MZ' },
    'Windows: the npm directory off PATH',
  ),
  cf(
    [w(), WIN_CLAUDE({ env: winEnv('') })],
    { 'home/.local/bin/claude.exe': 'MZ', 'appdata/npm/claude.exe': 'MZ' },
    'Windows: the vendor installer directory comes first for Claude Code',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('') })],
    { 'home/.local/bin/codex.exe': 'MZ' },
    'Windows: the installer directory is Claude Code only',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('') })],
    { 'local/Microsoft/WinGet/Links/codex.exe': 'MZ' },
    'Windows: the winget links directory',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('', { NPM_CONFIG_PREFIX: `${DIR}/prefix` }) })],
    { 'prefix/codex.exe': 'MZ' },
    'Windows: a moved npm prefix is the directory itself',
  ),
  cf(
    [w(), WIN_CODEX({ env: { PATH: '' } })],
    { 'x/y': 'z' },
    'Windows: nothing known about the user',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/bin/codex.ps1` })],
    {
      'bin/codex.ps1': 'ps',
      'bin/codex.cmd': CODEX_JS_SHIM,
      'bin/node_modules/@openai/codex/bin/codex.js': 'js',
    },
    'Windows: npm .ps1 shim leads to its .cmd',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/bin/codex` })],
    {
      'bin/codex': 'sh',
      'bin/codex.cmd': CODEX_JS_SHIM,
      'bin/node_modules/@openai/codex/bin/codex.js': 'js',
    },
    'Windows: the extension-less sh shim leads to its .cmd',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/bin/tool.ps1` })],
    { 'bin/tool.ps1': 'ps' },
    'Windows: a .ps1 without a .cmd',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/entry/codex.js` })],
    { 'entry/codex.js': 'js' },
    'Windows: a configured JS entry',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/bin/readme.txt` })],
    { 'bin/readme.txt': 'x' },
    'Windows: a file that is no program',
  ),
  cf(
    [w(), WIN_CODEX({ configured: `${DIR}/mine`, env: winEnv('') })],
    { 'mine/codex.exe': 'MZ', 'mine/codex.cmd': CODEX_JS_SHIM },
    'Windows: a configured directory: .exe before .cmd',
  ),
  cf(
    [w(), WIN_CODEX({ configured: 'mycodex.cmd', env: winEnv(`${DIR}/bin`) })],
    { 'bin/mycodex.exe': 'MZ' },
    'Windows: a bare .cmd name is searched without its extension',
  ),
  cf(
    [w(), WIN_CODEX()],
    {
      'local/OpenAI/Codex/bin/aaa/codex.exe': { text: 'MZ', mtimeMs: 1_700_000_000_000 },
      'local/OpenAI/Codex/bin/aaa/codex-code-mode-host.exe': 'MZ',
      'local/OpenAI/Codex/bin/bbb/codex.exe': { text: 'MZ', mtimeMs: 1_700_000_100_000 },
      'local/OpenAI/Codex/bin/bbb/codex-code-mode-host.exe': 'MZ',
      'bin/codex.exe': 'MZ',
    },
    'Windows: the Codex app tree, newest first',
  ),
  cf(
    [w(), WIN_CODEX()],
    {
      'local/OpenAI/Codex/bin/aaa/codex.exe': { text: 'MZ', mtimeMs: 1_700_000_000_000 },
      'local/OpenAI/Codex/bin/aaa/codex-code-mode-host.exe': 'MZ',
      'local/OpenAI/Codex/bin/bbb/codex.exe': { text: 'MZ', mtimeMs: 1_700_000_100_000 },
    },
    'Windows: a release without its helper is only taken when no other is complete',
  ),
  cf(
    [w(), WIN_CODEX()],
    { 'local/OpenAI/Codex/bin/bbb/codex.exe': { text: 'MZ', mtimeMs: 1_700_000_100_000 } },
    'Windows: the only release has no helper',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('', { LOCALAPPDATA: '' }) })],
    { 'x/y': 'z' },
    'Windows: an empty LOCALAPPDATA is none',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('') })],
    { 'local/Microsoft/WinGet/Packages/OpenAI.Codex_abc/codex.exe': 'MZ' },
    'Windows: the winget package directory',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv('') })],
    {
      'local/Microsoft/WinGet/Packages/OpenAI.Codex_abc/codex-code-mode-host.exe': 'MZ',
      'local/Microsoft/WinGet/Packages/OpenAI.Codex_abc/codex-sandbox.exe': 'MZ',
      'local/Microsoft/WinGet/Packages/Other.Tool_1/codex.exe': 'MZ',
    },
    'Windows: helper programs of the package are not the CLI',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv(''), arch: 'arm64' })],
    {
      'local/Microsoft/WinGet/Packages/openai.codex_zzz/codex-aarch64-pc-windows-msvc.exe': 'MZ',
      'local/Microsoft/WinGet/Packages/OpenAI.Codex_aaa/codex-x86_64-pc-windows-msvc.exe': 'MZ',
    },
    'Windows: the package file named for this CPU',
  ),
  cf(
    [w(), WIN_CODEX({ env: winEnv(''), arch: 'riscv64' })],
    { 'local/Microsoft/WinGet/Packages/OpenAI.Codex_aaa/codex-x86_64-pc-windows-msvc.exe': 'MZ' },
    'Windows: no known CPU name',
  ),
]

/**
 * The Codex app tree orders its releases by the newer of the program's and
 * the folder's time: the folders of a case carry the time of the program
 * inside, set last, so neither side reads the time the case was made.
 */
function withReleaseDirTimes(files: Record<string, FileSpec>): Record<string, FileSpec> {
  const out = { ...files }
  for (const [path, spec] of Object.entries(files)) {
    if (typeof spec === 'string' || spec.mtimeMs === undefined) continue
    if (!/(^managed\/[^/]+|OpenAI\/Codex\/bin\/[^/]+)\//.test(path)) continue
    out[path.slice(0, path.lastIndexOf('/'))] = { dir: true, mtimeMs: spec.mtimeMs }
  }
  return out
}
for (const locateCase of locateCases) {
  if (locateCase.files) locateCase.files = withReleaseDirTimes(locateCase.files)
}

const locateFns: Group = {
  'subscription/locate.locateSubscriptionProgram': {
    ts: ([world, o], cx) =>
      scoped(() =>
        withFakeOpen(() =>
          inWorld(world as World, cx, async () =>
            locate.locateSubscriptionProgram(
              (o as LocateOpts).provider,
              locateOptions(o as LocateOpts, cx),
            ),
          ),
        ),
      ),
    cases: locateCases,
  },
  'subscription/locate.resolveSubscriptionProgram': {
    ts: ([world, o], cx) =>
      scoped(() =>
        withFakeOpen(() =>
          inWorld(world as World, cx, async () =>
            locate.resolveSubscriptionProgram(
              (o as LocateOpts).provider,
              locateOptions(o as LocateOpts, cx),
            ),
          ),
        ),
      ),
    cases: [
      cf([w(), CODEX()], { 'bin/codex': EXE }, 'found'),
      cf([w(), CODEX()], { bin: { dir: true } }, 'not installed'),
      cf([w(), CLAUDE()], { bin: { dir: true } }, 'not installed: Claude Code'),
      cf(
        [w(), CODEX({ provider: 'chatgpt' })],
        { bin: { dir: true } },
        'a provider without a program',
      ),
    ],
  },
  'subscription/locate.subscriptionProviderLabel': {
    ts: ([provider]) => locate.subscriptionProviderLabel(provider as Any),
    cases: [c('claude-code'), c('codex'), c('chatgpt'), c('other')],
  },
}

// ---------------------------------------------------------------------------
// process.ts: spawnSubscriptionProgram, runSubscriptionProgram, the registry
// ---------------------------------------------------------------------------

const PROGRAM = {
  provider: 'claude-code',
  command: '/opt/claude/bin/claude',
  prefixArgs: [] as string[],
  env: {} as Record<string, string>,
  entry: '/opt/claude/bin/claude',
  source: 'path',
}

interface RunOpts {
  program?: Partial<typeof PROGRAM>
  args?: string[]
  timeoutMs?: number
  cwd?: string
  baseEnv?: Record<string, string>
  preAborted?: boolean
  worldSignal?: boolean
  slim?: boolean
}

const WORLD_ENV = {
  HOME: '/home/me',
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_BASE_URL: 'u',
}

const runFns: Group = {
  'subscription/process.runSubscriptionProgram': {
    ts: ([world, o], cx) =>
      scoped(() =>
        inWorld(world as World, cx, async (_run, signal) => {
          const opts = o as RunOpts
          const result = await proc.runSubscriptionProgram(
            { ...PROGRAM, ...opts.program } as Any,
            opts.args ?? ['--version'],
            {
              signal: opts.preAborted
                ? abortedSignal()
                : opts.worldSignal
                  ? signal
                  : new AbortController().signal,
              timeoutMs: opts.timeoutMs ?? 5000,
              cwd: opts.cwd,
              baseEnv: opts.baseEnv,
            },
          )
          if (!opts.slim) return result
          return {
            code: result.code,
            length: result.stdout.length,
            head: result.stdout.slice(0, 3),
            tail: result.stdout.slice(-3),
            stderr: result.stderr,
          }
        }),
      ),
    cases: [
      c(
        w({
          env: WORLD_ENV,
          children: [{ stdout: ['2.1.248 (Claude Code)\n'], closeOn: 'start' }],
        }),
        {},
      ),
      c(
        w({
          env: WORLD_ENV,
          children: [
            { stderr: ['bad flag\n'], stdout: ['x'], exit: { code: 3 }, closeOn: 'start' },
          ],
        }),
        { args: ['auth', 'status'] },
      ),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'never' }] }), { timeoutMs: 50 }),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'never' }], abortAt: 20 }), {
        worldSignal: true,
      }),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'start' }] }), { preAborted: true }),
      c(w({ env: WORLD_ENV }), {}),
      c(
        w({
          env: WORLD_ENV,
          children: [
            {
              stdout: [{ fill: 120, size: 200000 }, { fill: 121, size: 200000 }, 'zzz'],
              closeOn: 'start',
            },
          ],
        }),
        { slim: true },
      ),
      c(w({ env: WORLD_ENV, children: [{ stdout: ['x'], closeOn: 'start' }] }), {
        program: {
          provider: 'codex',
          command: '/opt/electron/app',
          prefixArgs: ['/opt/codex/bin/codex.js'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          entry: '/opt/codex/bin/codex.js',
        },
        args: ['login', 'status'],
      }),
      c(w({ env: WORLD_ENV, children: [{ stdout: ['x'], closeOn: 'start' }] }), {
        cwd: '/work',
        baseEnv: { PATH: '/base', CODEX_API_KEY: 'k', Z: '1' },
      }),
      c(
        w({
          env: { USERPROFILE: 'C:\\U', Path: 'C:\\bin' },
          platform: 'win32',
          children: [{ closeOn: 'start' }],
        }),
        {},
      ),
      c(
        w({
          env: { TMPDIR: '/var/tmp/' },
          children: [
            { stdout: [{ hex: 'e282' }, { hex: 'ac20e2' }, { hex: '82ac' }], closeOn: 'start' },
          ],
        }),
        {},
      ),
      c(
        w({ env: WORLD_ENV, children: [{ error: { message: 'spawn EACCES', code: 'EACCES' } }] }),
        {},
      ),
      c(
        w({
          env: WORLD_ENV,
          children: [{ pid: null, error: { message: 'spawn x ENOENT', code: 'ENOENT' } }],
        }),
        {
          timeoutMs: 10,
        },
      ),
    ],
  },
}

interface SpawnOpts {
  program?: Partial<typeof PROGRAM>
  args?: string[]
  options?: {
    cwd?: string
    stdio?: string[]
    baseEnv?: Record<string, string>
    env?: Record<string, string>
    platform?: string
    registry?: 'shared' | 'none' | 'own'
  }
  record?: string
  exit?: boolean
}

const spawnFns: Group = {
  'subscription/process.spawnSubscriptionProgram': {
    ts: ([world, o], cx) =>
      scoped(() =>
        withOwner((o as SpawnOpts).record, () =>
          inWorld(world as World, cx, async () => {
            const opts = o as SpawnOpts
            const shared = proc.sharedSubscriptionChildRegistry()
            if (opts.record) shared.recordIn(opts.record)
            const own =
              opts.options?.registry === 'own' ? proc.createSubscriptionChildRegistry() : undefined
            const child = proc.spawnSubscriptionProgram(
              { ...PROGRAM, ...opts.program } as Any,
              opts.args ?? ['--version'],
              {
                cwd: opts.options?.cwd,
                stdio: opts.options?.stdio as Any,
                baseEnv: opts.options?.baseEnv,
                env: opts.options?.env,
                platform: opts.options?.platform as Any,
                registry: own ?? (opts.options?.registry === 'none' ? null : undefined),
              },
            )
            const out: Record<string, unknown> = {
              pid: child.pid ?? null,
              size: shared.size,
              ownSize: own?.size ?? null,
            }
            if (opts.exit) {
              await new Promise((resolve) => child.once('close', resolve))
              out.sizeAfterExit = shared.size
              out.ownSizeAfterExit = own?.size ?? null
            }
            await shared.flushed()
            return out
          }),
        ),
      ),
    cases: [
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'never' }] }), {}),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'start' }] }), { exit: true }),
      c(w({ env: WORLD_ENV, children: [{ pid: null, closeOn: 'start' }] }), { exit: true }),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'start' }] }), {
        exit: true,
        options: { registry: 'none' },
      }),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'start' }] }), {
        exit: true,
        options: { registry: 'own' },
      }),
      c(w({ env: WORLD_ENV, children: [{ closeOn: 'never' }] }), {
        options: {
          cwd: '/work',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { EXTRA: '1', PATH: '/mine' },
        },
        program: { prefixArgs: ['/x/cli.js'], env: { ELECTRON_RUN_AS_NODE: '1', EXTRA: '0' } },
        args: ['a', 'b'],
      }),
      c(w({ env: WORLD_ENV, platform: 'win32', children: [{ closeOn: 'never' }] }), {
        options: { platform: 'win32' },
      }),
      c(w({ env: WORLD_ENV, platform: 'win32', children: [{ closeOn: 'never' }] }), {
        options: { platform: 'linux', baseEnv: { A: '1' } },
      }),
      cf(
        [
          w({ env: WORLD_ENV, children: [{ closeOn: 'start' }] }),
          { exit: true, record: `${DIR}/rec` },
        ],
        { rec: { dir: true } },
        'the record on disk follows the child out',
      ),
      cf(
        [w({ env: WORLD_ENV, children: [{ closeOn: 'never' }] }), { record: `${DIR}/rec` }],
        { rec: { dir: true } },
        'the record holds the running child',
      ),
    ],
  },
}

interface RegistryStep {
  spawn?: { command?: string }
  track?: { child: number; provider?: string; command?: string; startedAt?: number }
  forget?: number
  wait?: boolean
  size?: boolean
  shutdown?: boolean
  flush?: boolean
  record?: string | null
}

const registryFns: Group = {
  'subscription/process.trackSubscriptionChild': {
    ts: ([world, o], cx) =>
      scoped(() =>
        withOwner((o as { dir?: string }).dir, () =>
          inWorld(world as World, cx, async () => {
            const shared = proc.sharedSubscriptionChildRegistry()
            const kids: Any[] = []
            const forgets: Array<() => void> = []
            const answers: unknown[] = []
            for (const step of (o as { steps: RegistryStep[] }).steps) {
              if (step.spawn) {
                const kid = childProcessSpawn(step.spawn.command ?? '/opt/mcp/server')
                kids.push(kid)
                answers.push(kid.pid ?? null)
              } else if (step.track) {
                forgets.push(
                  proc.trackSubscriptionChild(kids[step.track.child], {
                    provider: (step.track.provider ?? 'user-mcp') as Any,
                    command: step.track.command ?? '/opt/mcp/server',
                    startedAt: step.track.startedAt,
                  }),
                )
                answers.push(proc.trackedSubscriptionChildCount())
              } else if (step.forget !== undefined) {
                forgets[step.forget]?.()
                answers.push(proc.trackedSubscriptionChildCount())
              } else if (step.wait) {
                await new Promise((resolve) => setTimeout(resolve, 0))
                answers.push(proc.trackedSubscriptionChildCount())
              } else if (step.shutdown) {
                proc.shutdownSubscriptionChildren()
                answers.push(proc.trackedSubscriptionChildCount())
              } else if (step.flush) {
                await shared.flushed()
                answers.push(null)
              } else if (step.record !== undefined) {
                shared.recordIn(step.record)
                answers.push(null)
              } else {
                answers.push(shared.size)
              }
            }
            await shared.flushed()
            return answers
          }),
        ),
      ),
    cases: [
      c(w({ children: [{ closeOn: 'never' }] }), {
        steps: [{ spawn: {} }, { track: { child: 0 } }, { size: true }, { shutdown: true }],
      }),
      c(w({ children: [{ closeOn: 'start' }] }), {
        steps: [{ spawn: {} }, { track: { child: 0 } }, { wait: true }],
      }),
      c(w({ children: [{ closeOn: 'never' }] }), {
        steps: [{ spawn: {} }, { track: { child: 0 } }, { forget: 0 }, { forget: 0 }],
      }),
      c(w({ children: [{ pid: null, closeOn: 'never' }] }), {
        steps: [{ spawn: {} }, { track: { child: 0 } }, { forget: 0 }],
      }),
      c(
        w({
          children: [
            { pid: 700, closeOn: 'never' },
            { pid: 700, closeOn: 'never' },
          ],
        }),
        {
          steps: [
            { spawn: {} },
            { track: { child: 0 } },
            { spawn: {} },
            { track: { child: 1 } },
            { forget: 0 },
            { shutdown: true },
          ],
        },
      ),
      c(
        w({
          children: [
            { pid: 710, closeOn: 'never' },
            { pid: 711, closeOn: 'never' },
          ],
        }),
        {
          steps: [
            { spawn: {} },
            { track: { child: 0 } },
            { spawn: {} },
            { track: { child: 1, provider: 'codex' } },
            { shutdown: true },
            { shutdown: true },
          ],
        },
      ),
      c(
        w({
          platform: 'win32',
          env: { SystemRoot: 'D:\\Win' },
          children: [{ pid: 720, closeOn: 'never' }],
        }),
        {
          steps: [{ spawn: {} }, { track: { child: 0 } }, { shutdown: true }, { wait: true }],
        },
      ),
      cf(
        [
          w({
            pid: 1234,
            children: [
              { pid: 730, closeOn: 'never' },
              { pid: 731, closeOn: 'start' },
            ],
          }),
          {
            dir: `${DIR}/rec`,
            steps: [
              { record: `${DIR}/rec` },
              { spawn: {} },
              {
                track: {
                  child: 0,
                  provider: 'claude-code',
                  command: '/opt/claude',
                  startedAt: 1700000000000,
                },
              },
              { spawn: {} },
              { track: { child: 1 } },
              { wait: true },
              { flush: true },
            ],
          },
        ],
        { rec: { dir: true } },
        'the record on disk: the first child stays, the second left',
      ),
      cf(
        [
          w({ pid: 1234, children: [{ pid: 740, closeOn: 'never' }] }),
          {
            dir: `${DIR}/rec`,
            steps: [
              { record: `${DIR}/rec` },
              { spawn: {} },
              { track: { child: 0 } },
              { flush: true },
              { shutdown: true },
              { flush: true },
              { record: null },
            ],
          },
        ],
        { rec: { dir: true } },
        'shutdown removes the record',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// leftovers.ts
// ---------------------------------------------------------------------------

const T0 = 1_794_452_000_000

const leftoverRecord = (ownerPid: number, ownerStartedAt: unknown, children: unknown[]) =>
  JSON.stringify({ version: 1, owner: { pid: ownerPid, startedAt: ownerStartedAt }, children })
const kid = (pid: unknown, more: Record<string, unknown> = {}) => ({
  pid,
  provider: 'claude-code',
  command: '/opt/claude/bin/claude',
  startedAt: T0,
  ...more,
})
const REC = (pid: number) => `rec/subscription-children-${pid}.json`

interface LeftoverOpts {
  dir: string
  platform?: string
  ownerPid?: number
  /** the inspector's answers: [pid, startedAt (null: unreadable), image], or 'throws' */
  inspect?: [number, number | null, string][] | 'throws'
  defaultInspect?: boolean
  tempRoot?: string
}

function leftoverDeps(o: LeftoverOpts, cx: TsContext): Any {
  return {
    platform: o.platform,
    ownerPid: o.ownerPid,
    inspect: o.defaultInspect
      ? undefined
      : async (pids: number[]) => {
          cx.log('inspect', pids)
          if (o.inspect === 'throws') throw new Error('boom')
          const found = new Map<number, { startedAt: number; image: string }>()
          for (const [pid, startedAt, image] of o.inspect ?? []) {
            if (pids.includes(pid)) found.set(pid, { startedAt: startedAt ?? Number.NaN, image })
          }
          return found
        },
    killTree: (pid: number) => cx.log('killTree', pid),
  }
}

const leftoverCases: Case[] = [
  cf([w(), { dir: `${DIR}/rec`, inspect: [] }], { x: 'y' }, 'no record directory'),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [] }],
    { rec: { dir: true }, 'rec/other.json': '{}' },
    'no record',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [[700, T0, '/opt/claude/bin/claude']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'a dead owner: the child is verified and ended, the record goes',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [[700, T0, '/usr/bin/other']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'another program on the pid',
  ),
  cf(
    [
      w(),
      {
        dir: `${DIR}/rec`,
        inspect: [
          [700, T0 + 1500, '/opt/claude/bin/claude'],
          [701, T0 + 1501, '/opt/claude/bin/claude'],
          [702, T0 - 10000, '/opt/claude/bin/claude'],
          [703, T0 - 10001, '/opt/claude/bin/claude'],
        ],
      },
    ],
    {
      [REC(555)]: leftoverRecord(555, 1000, [kid(700), kid(701), kid(702), kid(703)]),
    },
    'the start time: 1.5 s after and 10 s before are the edges',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [[700, null, '/opt/claude/bin/claude']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'a start time that could not be read',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [[700, T0, '']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'an image that could not be read',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'the child is gone already',
  ),
  cf(
    [
      w(),
      {
        dir: `${DIR}/rec`,
        inspect: [
          [555, 1000, '/opt/app'],
          [700, T0, '/opt/claude/bin/claude'],
        ],
      },
    ],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'the owner is alive and started when recorded: the record is left alone',
  ),
  cf(
    [
      w(),
      {
        dir: `${DIR}/rec`,
        inspect: [
          [555, 1000 + 10000, '/opt/app'],
          [556, 1000 + 10001, '/opt/app'],
          [700, T0, '/opt/claude/bin/claude'],
          [701, T0, '/opt/claude/bin/claude'],
        ],
      },
    ],
    {
      [REC(555)]: leftoverRecord(555, 1000, [kid(700)]),
      [REC(556)]: leftoverRecord(556, 1000, [kid(701)]),
    },
    'the owner pid was reused: 10 s of slack on its start',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, ownerPid: 555, inspect: [[700, T0, '/opt/claude/bin/claude']] }],
    { [REC(555)]: leftoverRecord(555, '$OWNER', [kid(700)]) },
    'the record of this process, this run, is no leftover: kept, nothing asked',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, ownerPid: 555, inspect: [[700, T0, '/opt/claude/bin/claude']] }],
    { [REC(555)]: leftoverRecord(555, 5, [kid(700)]) },
    'this pid, an earlier run: a leftover; the owner is not asked about',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: 'throws' }],
    {
      [REC(555)]: leftoverRecord(555, 1000, [kid(700), kid(701)]),
      [REC(556)]: leftoverRecord(556, 1000, [kid(702)]),
    },
    'nothing can be verified: nothing is ended, the records stay',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [] }],
    {
      [REC(1)]: 'not json',
      [REC(2)]: 'null',
      [REC(3)]: '[]',
      [REC(4)]: JSON.stringify({ owner: { pid: 0, startedAt: 1 }, children: [] }),
      [REC(5)]: JSON.stringify({ owner: { pid: 5, startedAt: 'x' }, children: [] }),
      [REC(6)]: JSON.stringify({ children: [] }),
      'rec/subscription-children-x.json': 'x',
      'rec/subscription-children-7.json.tmp': 'x',
      'rec/subscription-children-8.txt': 'x',
    },
    'unreadable records go; files that are no records stay',
  ),
  cf(
    [
      w(),
      {
        dir: `${DIR}/rec`,
        inspect: [
          [700, T0, '/opt/claude/bin/claude'],
          [701, T0, '/opt/x'],
          [702, T0, '/opt/y'],
          [703, T0, '/opt/z'],
        ],
      },
    ],
    {
      [REC(555)]: leftoverRecord(555, 1000, [
        kid(700),
        kid(701, { provider: 'user-mcp', command: '/opt/x' }),
        kid(702, { provider: 'other', command: '/opt/y' }),
        kid(703, { command: '' }),
        kid(704, { startedAt: 'x' }),
        kid(1.5),
        kid(-3),
        null,
        5,
        kid(705, { command: 7 }),
      ]),
    },
    'the lines of a record that are no child of this app are dropped',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, ownerPid: 700, inspect: [[700, T0, '/opt/claude/bin/claude']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'the pid of the calling process is never ended',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, platform: 'win32', inspect: [[700, T0, 'c:/tools/codex.exe']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700, { command: 'C:\\Tools\\Codex.EXE' })]) },
    'Windows: the program file is compared without case and slash',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, platform: 'linux', inspect: [[700, T0, 'c:/tools/codex.exe']] }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700, { command: 'C:\\Tools\\Codex.EXE' })]) },
    'elsewhere the path is compared as it is',
  ),
  cf(
    [w(), { dir: `${DIR}/rec`, inspect: [[700, T0, `${DIR}/real/claude`]] }],
    {
      [REC(555)]: leftoverRecord(555, 1000, [kid(700, { command: `${DIR}/real/claude` })]),
      'real/claude': EXE,
    },
    'the same file',
  ),
  cf(
    [
      w(),
      {
        dir: `${DIR}/rec`,
        inspect: [
          [700, T0, '/opt/claude/bin/claude'],
          [701, T0, '/opt/claude/bin/claude'],
        ],
      },
    ],
    {
      [REC(555)]: leftoverRecord(555, 1000, [kid(700)]),
      [REC(556)]: leftoverRecord(556, 1000, [kid(700), kid(701)]),
    },
    'a pid in two records is asked once, ended in each',
  ),
  cf(
    [
      w({
        platform: 'darwin',
        children: [
          { stdout: ['  700 Thu Nov 12 02:53:20 2026 /opt/claude/bin/claude\n'], closeOn: 'start' },
        ],
      }),
      { dir: `${DIR}/rec`, defaultInspect: true },
    ],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700, { startedAt: 1_794_452_000_000 })]) },
    'the system is asked (ps): the answer is the TypeScript own',
  ),
  cf(
    [w({ platform: 'darwin' }), { dir: `${DIR}/rec`, defaultInspect: true }],
    { [REC(555)]: leftoverRecord(555, 1000, [kid(700)]) },
    'the system tool cannot start: nothing verified',
  ),
]

/** `TZ` is UTC while `body` runs: `ps` writes a local time */
async function inUtc<T>(body: () => Promise<T>): Promise<T> {
  const real = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    return await body()
  } finally {
    if (real === undefined) delete process.env.TZ
    else process.env.TZ = real
  }
}

interface InspectOpts {
  pids: number[]
  platform?: string
  env?: Record<string, string>
}

const leftoverFns: Group = {
  'subscription/leftovers.cleanupLeftoverSubscriptionChildren': {
    ts: ([world, o], cx) =>
      scoped(() =>
        inUtc(() =>
          withOwner((o as LeftoverOpts).dir, () =>
            inWorld(world as World, cx, async () => {
              const opts = o as LeftoverOpts
              return leftovers.cleanupLeftoverSubscriptionChildren(opts.dir, leftoverDeps(opts, cx))
            }),
          ),
        ),
      ),
    cases: leftoverCases,
  },
  'subscription/leftovers.initSubscriptionChildTracking': {
    ts: ([world, o], cx) =>
      scoped(() =>
        withUptime(() =>
          withFakeMkdtemp(() =>
            withOwner((o as LeftoverOpts).dir, () =>
              inWorld(world as World, cx, async () => {
                const opts = o as LeftoverOpts
                const result = await leftovers.initSubscriptionChildTracking(
                  opts.dir,
                  leftoverDeps(opts, cx),
                )
                // the record directory is the one the init set
                const made = await temp.createTrackedTempDir(CLAUDE_PREFIX)
                const records = takeTempRecords(opts.dir)
                const shared = proc.sharedSubscriptionChildRegistry()
                await shared.flushed()
                return { result, made, records, size: shared.size }
              }),
            ),
          ),
        ),
      ),
    cases: [
      cf(
        [
          w({ env: { TMPDIR: `${DIR}/tmp` } }),
          { dir: `${DIR}/rec`, inspect: [[700, T0, '/opt/claude/bin/claude']] },
        ],
        {
          [REC(555)]: leftoverRecord(555, 1000, [kid(700)]),
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}old`, 1000, 1),
          [`tmp/${CLAUDE_PREFIX}old/file.txt`]: 'x',
        },
        'a previous run: its child ended, its temporary folder removed, this run recorded',
      ),
      cf(
        [w({ env: { TMPDIR: `${DIR}/tmp` } }), { dir: `${DIR}/fresh`, inspect: [] }],
        { tmp: { dir: true } },
        'a first start: nothing to clean, the directory is made for the records',
      ),
      cf(
        [w({ env: { TMPDIR: `${DIR}/tmp` } }), { dir: `${DIR}/rec`, inspect: 'throws' }],
        {
          [REC(555)]: leftoverRecord(555, 1000, [kid(700)]),
          'rec/ai-temp-dir-aaaa.json': record(`${DIR}/tmp/${CLAUDE_PREFIX}old`, 77, 1),
          [`tmp/${CLAUDE_PREFIX}old/file.txt`]: 'x',
        },
        'nothing verified: the records stay; the temporary folder of a pid the world calls alive stays too',
      ),
    ],
  },
  'subscription/leftovers.inspectProcesses': {
    ts: ([world, o], cx) =>
      scoped(() =>
        inUtc(() =>
          inWorld(world as World, cx, async () => {
            const opts = o as InspectOpts
            const found = await leftovers.inspectProcesses(opts.pids, {
              platform: opts.platform as Any,
              env: opts.env,
            })
            return [...found.entries()]
          }),
        ),
      ),
    cases: [
      c(w({ platform: 'darwin' }), { pids: [] }),
      c(w({ platform: 'darwin' }), { pids: [0, -1, 1.5] }),
      c(w({ platform: 'linux' }), { pids: [999999991, 999999992, 999999991] }),
      c(
        w({
          platform: 'win32',
          env: { SystemRoot: 'C:\\Windows', A: '1' },
          children: [
            {
              stdout: [
                '1234|1700000000000|C:\\x\\codex.exe\r\n5678||\r\nbad|1|x\r\n  90|123|a|b|c\r\n|1|2\r\n77\r\n',
              ],
              closeOn: 'start',
            },
          ],
        }),
        { pids: [1234, 5678, 90, 77, 1234] },
      ),
      c(
        w({
          platform: 'darwin',
          env: { SystemRoot: 'D:\\Win' },
          children: [{ stdout: ['1|2|C:\\x\r\n'], closeOn: 'start' }],
        }),
        { pids: [1], platform: 'win32', env: { SystemRoot: 'D:\\Win', Z: '9' } },
      ),
      c(w({ platform: 'win32', env: { SystemRoot: 'relative\\path' } }), { pids: [5] }),
      c(
        w({
          platform: 'darwin',
          env: { LANG: 'ko_KR.UTF-8', HOME: '/h' },
          children: [
            {
              stdout: [
                '  123 Thu Nov 12 03:00:00 2026 /usr/bin/claude\n 456 Wed Jan  1 00:00:00 2025   /Applications/Foo.app/Contents/MacOS/foo bar  \nnot a line\n  789 Foo Bar Baz Qux 99 /x\n',
              ],
              closeOn: 'start',
            },
          ],
        }),
        { pids: [123, 456, 789] },
      ),
      c(w({ platform: 'freebsd', children: [{ stdout: [''], closeOn: 'start' }] }), {
        pids: [1, 2],
      }),
      c(w({ platform: 'darwin', children: [{ closeOn: 'never' }] }), { pids: [1] }),
      c(w({ platform: 'darwin' }), { pids: [1] }),
      c(
        w({
          platform: 'darwin',
          children: [
            {
              stdout: [{ fill: 120, size: 1_500_000 }, '  9 Thu Nov 12 03:00:00 2026 /x\n'],
              closeOn: 'start',
            },
          ],
        }),
        { pids: [9] },
      ),
    ],
  },
}

export const group: Group = {
  ...contractFns,
  ...envFns,
  ...modelsFns,
  ...tempFns,
  ...meteredFns,
  ...locateFns,
  ...runFns,
  ...spawnFns,
  ...registryFns,
  ...leftoverFns,
}
