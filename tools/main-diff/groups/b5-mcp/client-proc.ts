/**
 * Group `b5-mcp`, slice `client-proc` (Rust: crates/main-core/src/calls/b5_mcp/client_proc.rs):
 * `apps/shell/src/main/mcp-client/local.ts` (a "my PC" MCP server: launch,
 * stdio session, idle stop, failures) and `runtimes.ts` (the runtime kit and
 * the PC lookups). Functions are `<file>.<export>`.
 *
 * local.scenario(server, options, steps): the real module runs with a fake
 * `spawn` (a scripted child: the case's steps emit what the child writes),
 * fake timers (a case fires timer N by number), a fake registry, fake
 * `mkdir`/`mkdtemp`/`rm`, a fake `process.kill` and a fake taskkill. Every call
 * of a fake is one log line. A server of a case is the stored form (it goes
 * through normalizeMcpServersFile). The kit answers the case's resolutions in
 * order (the last one repeats) and logs `resolve`.
 *   options: platform, workRoot, idleMs, callTimeoutMs, startTimeoutMs,
 *   maxStartFailures, resultMaxChars, baseEnv, systemEnv, kit (a resolution or
 *   a list), lookupThrows (indexes of the lookups that throw), spawnFailures
 *   (per spawn: null or a message), workDirFails (the number of make attempts
 *   that fail), registry (false: none), appSignal (`live` or `aborted`),
 *   noPid (the child has no pid), killGroupThrows, taskkillThrows.
 *   Steps (a `label` names the call in `outcomes`; `signal` is `live`
 *   (a fresh controller), `aborted` or absent): ensure, list, call (tool,
 *   args), stop, abort (label), stdout/stderr (child?, text), reply (child?,
 *   id, result), init (child?, id?, instructions?), exit, close, childError
 *   (message), stdinError, destroyStdin, timer (n), setServer (server), retry,
 *   status, tail, planned, appAbort, listen/unlisten (id, kind state|tools).
 *   After each step the pending promises settle (a flush), as the Rust side
 *   runs each step to quiescence.
 * runtimes.scenario(options, steps): createMcpRuntimeKit over a real folder
 *   with fake fetch, fake uv, fake consent callbacks and a fake rename.
 * The PC lookups run over the case's folder tree.
 */
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import crypto, { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../../types.ts'

import {
  planFingerprint,
  serverLaunchFingerprint,
} from '../../../../apps/shell/src/main/mcp-client/fingerprint.ts'
import * as local from '../../../../apps/shell/src/main/mcp-client/local.ts'
import { prepareLocalLaunch } from '../../../../apps/shell/src/main/mcp-client/local-launch.ts'
import * as store from '../../../../apps/shell/src/main/mcp-client/store.ts'
import * as rt from '../../../../apps/shell/src/main/mcp-client/runtimes.ts'

type Any = any

const c = (args: unknown[], note?: string, files?: Record<string, FileSpec>): Case => ({
  args,
  ...(note ? { note } : {}),
  ...(files ? { files } : {}),
})

// ---------------------------------------------------------------------------
// local.ts
// ---------------------------------------------------------------------------

type LocalStep = {
  op: string
  label?: string
  signal?: 'live' | 'aborted'
  tool?: string
  args?: unknown
  child?: number
  text?: string
  id?: number
  result?: unknown
  instructions?: string
  message?: string
  n?: number
  server?: Record<string, unknown>
  kind?: 'state' | 'tools'
}

interface LocalOptions {
  platform?: string
  workRoot?: string
  idleMs?: number
  callTimeoutMs?: number
  startTimeoutMs?: number
  maxStartFailures?: number
  resultMaxChars?: number
  baseEnv?: Record<string, string>
  systemEnv?: string[]
  kit: unknown
  lookupThrows?: number[]
  spawnFailures?: (string | null)[]
  workDirFails?: number
  registry?: boolean
  appSignal?: 'live' | 'aborted'
  noPid?: boolean
  killGroupThrows?: boolean
  taskkillThrows?: boolean
}

interface FakeChild {
  emitter: EventEmitter & Any
  exited: boolean
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await nextTurn()
}

const initResult = (instructions?: string): unknown => ({
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: { tools: {} },
  serverInfo: { name: 'fake', version: '1.0.0' },
  ...(instructions === undefined ? {} : { instructions }),
})

const toServer = (stored: Record<string, unknown>): Any =>
  store.normalizeMcpServersFile({ servers: [stored] }).servers[0]

const errorOutcome = (error: unknown): unknown => {
  const e = error as Any
  if (e instanceof local.LocalMcpError) {
    return { error: 'LocalMcpError', reason: e.reason, message: e.message, problem: e.problem }
  }
  return { error: e.name, message: e.message }
}

async function localScenario(a: unknown[], cx: TsContext): Promise<unknown> {
  const [stored, o, steps] = a as [Record<string, unknown>, LocalOptions, LocalStep[]]
  const server = toServer(stored)
  const children: FakeChild[] = []
  const timers: { fn: () => void; active: boolean; id: number }[] = []
  const controllers = new Map<string, AbortController>()
  const listeners = new Map<string, () => void>()
  const outcomes: Record<string, unknown> = {}
  const results: unknown[] = []
  const kits = Array.isArray(o.kit) ? (o.kit as unknown[]) : [o.kit]
  let lookups = 0
  let spawns = 0
  let workDirs = 0
  let madeDirs = 0
  const lastChild = (): FakeChild => children[children.length - 1] as FakeChild
  const target = (step: LocalStep): FakeChild =>
    children[step.child ?? children.length - 1] as FakeChild

  const kit = {
    resolveCommand: async (command: string, options?: { offerDownload?: boolean }) => {
      cx.log('resolve', command, { offerDownload: options?.offerDownload })
      const index = lookups
      lookups += 1
      if ((o.lookupThrows ?? []).includes(index)) throw new Error('lookup failed')
      return (kits[Math.min(index, kits.length - 1)] ?? kits[0]) as never
    },
  }

  const fakeSpawn = (command: string, args: readonly string[], options: Any): Any => {
    cx.log('spawn', command, args, options)
    const failure = (o.spawnFailures ?? [])[spawns]
    spawns += 1
    if (failure !== null && failure !== undefined) throw new Error(failure)
    const index = children.length
    const emitter = new EventEmitter() as Any
    if (!o.noPid) emitter.pid = 4000 + index
    emitter.stdin = Object.assign(new EventEmitter(), {
      destroyed: false,
      write(data: string): boolean {
        cx.log('write', index, data)
        return true
      },
    })
    emitter.stdout = new EventEmitter()
    emitter.stderr = new EventEmitter()
    children.push({ emitter, exited: false })
    return emitter
  }

  const registry =
    o.registry === false
      ? null
      : {
          track(child: Any, info: unknown): () => void {
            cx.log('track', child.pid ?? null, info)
            return () => undefined
          },
        }

  const appController = o.appSignal ? new AbortController() : null
  if (o.appSignal === 'aborted') appController?.abort()

  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realKill = process.kill
  const realSpawn = childProcess.spawn
  const realMkdir = fsp.mkdir
  const realMkdtemp = fsp.mkdtemp
  const realRm = fsp.rm
  ;(globalThis as Any).setTimeout = (fn: () => void, ms: number) => {
    cx.log('setTimeout', ms)
    const timer = { fn, active: true, id: timers.length + 1, unref: () => undefined }
    timers.push(timer)
    return timer
  }
  ;(globalThis as Any).clearTimeout = (timer: { id: number; active: boolean }) => {
    cx.log('clearTimeout', timer.id)
    timer.active = false
  }
  ;(process as Any).kill = (pid: number, signal?: string) => {
    cx.log('kill', pid, signal ?? null)
    if (o.killGroupThrows && pid < 0) throw new Error('ESRCH')
    return true
  }
  ;(childProcess as Any).spawn = (command: string, args: string[], options: unknown) => {
    cx.log('taskkill', command, args, options)
    if (o.taskkillThrows) throw new Error('no taskkill')
    return Object.assign(new EventEmitter(), { unref: () => undefined })
  }
  ;(fsp as Any).mkdir = async (path: string) => {
    cx.log('mkdir', path)
    if (workDirs < (o.workDirFails ?? 0)) {
      workDirs += 1
      throw new Error('EACCES')
    }
  }
  ;(fsp as Any).mkdtemp = async (prefix: string) => {
    cx.log('mkdtemp', prefix)
    madeDirs += 1
    return `${prefix}${String(madeDirs).padStart(6, '0')}`
  }
  ;(fsp as Any).rm = async (path: string) => {
    cx.log('rm', path)
  }
  syncBuiltinESMExports()
  try {
    const conn = local.createLocalMcpConnection(server, {
      kit: kit as never,
      clientInfo: { name: 'seuoffice', version: '1.2.3' },
      registry: registry as never,
      ...(o.baseEnv ? { baseEnv: o.baseEnv } : {}),
      ...(o.systemEnv ? { systemEnv: o.systemEnv } : {}),
      ...(o.platform ? { platform: o.platform as NodeJS.Platform } : {}),
      ...(o.workRoot ? { workRoot: o.workRoot } : {}),
      ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
      ...(o.callTimeoutMs !== undefined ? { callTimeoutMs: o.callTimeoutMs } : {}),
      ...(o.startTimeoutMs !== undefined ? { startTimeoutMs: o.startTimeoutMs } : {}),
      ...(o.maxStartFailures !== undefined ? { maxStartFailures: o.maxStartFailures } : {}),
      ...(o.resultMaxChars !== undefined ? { resultMaxChars: o.resultMaxChars } : {}),
      ...(appController ? { appSignal: appController.signal } : {}),
      spawn: fakeSpawn,
    })
    const signalOf = (step: LocalStep): AbortSignal | undefined => {
      if (!step.signal) return undefined
      const controller = new AbortController()
      if (step.signal === 'aborted') controller.abort()
      controllers.set(step.label as string, controller)
      return controller.signal
    }
    const settle = <T>(label: string, promise: Promise<T>, show: (v: T) => unknown): void => {
      outcomes[label] = 'pending'
      promise.then(
        (value) => {
          outcomes[label] = { ok: show(value) }
        },
        (error: unknown) => {
          outcomes[label] = errorOutcome(error)
        },
      )
    }
    for (const step of steps) {
      let result: unknown = null
      switch (step.op) {
        case 'ensure':
          settle(step.label as string, conn.ensure(signalOf(step)), () => true)
          break
        case 'list':
          settle(step.label as string, conn.listTools(signalOf(step)), (v) => v)
          break
        case 'call':
          settle(
            step.label as string,
            conn.callTool(step.tool as string, (step.args ?? {}) as never, signalOf(step)),
            (v) => v,
          )
          break
        case 'stop':
          settle(step.label as string, conn.stop(), () => true)
          break
        case 'abort':
          controllers.get(step.label as string)?.abort()
          break
        case 'stdout':
          target(step).emitter.stdout.emit('data', Buffer.from(step.text as string))
          break
        case 'stderr':
          target(step).emitter.stderr.emit('data', Buffer.from(step.text as string))
          break
        case 'reply':
          target(step).emitter.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ jsonrpc: '2.0', id: step.id, result: step.result })}\n`,
            ),
          )
          break
        case 'init':
          target(step).emitter.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ jsonrpc: '2.0', id: step.id ?? 0, result: initResult(step.instructions) })}\n`,
            ),
          )
          break
        case 'exit':
          target(step).exited = true
          target(step).emitter.emit('exit', 0, null)
          break
        case 'close':
          target(step).emitter.emit('close', 0, null)
          break
        case 'childError':
          target(step).emitter.emit('error', new Error(step.message as string))
          break
        case 'stdinError':
          target(step).emitter.stdin.emit('error', new Error('write EPIPE'))
          break
        case 'destroyStdin':
          target(step).emitter.stdin.destroyed = true
          break
        case 'timer': {
          const timer = timers[(step.n as number) - 1]
          if (timer?.active) {
            timer.active = false
            timer.fn()
          }
          break
        }
        case 'setServer':
          conn.setServer(toServer(step.server as Record<string, unknown>))
          break
        case 'retry':
          conn.retry()
          break
        case 'status':
          result = conn.status()
          break
        case 'tail':
          result = conn.stderrTail()
          break
        case 'planned':
          result = await conn.plannedLaunch()
          break
        case 'appAbort':
          appController?.abort()
          break
        case 'listen': {
          const id = step.id as number
          listeners.set(
            `${step.kind}${id}`,
            step.kind === 'state'
              ? conn.onStateChanged((state) => cx.log('state', id, state))
              : conn.onToolsChanged(() => cx.log('tools', id)),
          )
          break
        }
        case 'unlisten':
          listeners.get(`${step.kind}${step.id}`)?.()
          break
        default:
          throw new Error(`unknown step ${step.op}`)
      }
      results.push(result)
      await flush()
    }
    void lastChild
    return { results, outcomes, status: conn.status(), tail: conn.stderrTail() }
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    process.kill = realKill
    ;(childProcess as Any).spawn = realSpawn
    ;(fsp as Any).mkdir = realMkdir
    ;(fsp as Any).mkdtemp = realMkdtemp
    ;(fsp as Any).rm = realRm
    syncBuiltinESMExports()
  }
}

// ---------------------------------------------------------------------------
// local.scenario cases
// ---------------------------------------------------------------------------

const BASE = { PATH: '/usr/bin:/bin', HOME: '/h' }
const resolved = (command = '/usr/bin/tool', extra: Record<string, unknown> = {}) => ({
  ok: true,
  command,
  prefixArgs: [],
  env: {},
  pathPrepend: [],
  source: 'pc',
  runtime: null,
  ...extra,
})
const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'srv',
  name: 'files',
  kind: 'local',
  enabled: true,
  command: '/usr/bin/tool',
  args: ['--x'],
  env: { TOKEN: 't' },
  ...over,
})

/** the stored server with the approvals of the launch the kit's resolution gives */
async function approve(
  server: Record<string, unknown>,
  resolution: unknown,
  platform = 'linux',
  baseEnv: Record<string, string> = BASE,
): Promise<Record<string, unknown>> {
  const normal = toServer(server)
  const prepared = await prepareLocalLaunch(
    normal,
    { resolveCommand: async () => resolution as never },
    { platform: platform as NodeJS.Platform, baseEnv },
  )
  return {
    ...server,
    approvedLaunch: serverLaunchFingerprint(normal),
    approvedPlan: prepared.plan.ok ? planFingerprint(prepared.plan as never) : 'sha256:blocked',
  }
}

const OK = await approve(stored(), resolved())
const options = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  platform: 'linux',
  workRoot: '/w',
  baseEnv: BASE,
  kit: resolved(),
  registry: true,
  ...over,
})
const lc = (server: unknown, opts: unknown, steps: LocalStep[], note: string): Case =>
  c([server, opts, steps], note)

const init = (child?: number, instructions?: string): LocalStep => ({
  op: 'init',
  id: 0,
  ...(instructions === undefined ? {} : { instructions }),
  ...(child === undefined ? {} : { child }),
})
const reply = (id: number, result: unknown, child?: number): LocalStep => ({
  op: 'reply',
  id,
  result,
  ...(child === undefined ? {} : { child }),
})
const textResult = (text: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text }],
  ...extra,
})
const tools = (names: string[], nextCursor?: string) => ({
  tools: names.map((name) => ({ name, description: `d ${name}`, inputSchema: { type: 'object' } })),
  ...(nextCursor === undefined ? {} : { nextCursor }),
})
const step = (op: string, rest: Partial<LocalStep> = {}): LocalStep => ({ op, ...rest })
const list = (label: string, signal?: 'live' | 'aborted'): LocalStep =>
  step('list', { label, ...(signal ? { signal } : {}) })
const callStep = (
  label: string,
  tool = 'echo',
  args: unknown = { a: 1 },
  signal?: 'live' | 'aborted',
): LocalStep => step('call', { label, tool, args, ...(signal ? { signal } : {}) })
const timer = (n: number): LocalStep => step('timer', { n })
const stdout = (text: string, child?: number): LocalStep =>
  step('stdout', { text, ...(child === undefined ? {} : { child }) })
const stderr = (text: string, child?: number): LocalStep =>
  step('stderr', { text, ...(child === undefined ? {} : { child }) })
const exit = (child?: number): LocalStep => step('exit', child === undefined ? {} : { child })
const closeChild = (child?: number): LocalStep =>
  step('close', child === undefined ? {} : { child })

/** a running server: list answered, so ids 0 (initialize) and 1 (tools/list) are used */
const running = (): LocalStep[] => [list('boot'), init(), reply(1, tools(['echo']))]

const OK_Y = await approve(stored({ args: ['--y'] }), resolved())
const OK_Z = await approve(stored({ args: ['--z'] }), resolved())
const localCases: Case[] = [
  lc(
    stored(),
    options(),
    [step('status'), list('l'), callStep('c'), step('ensure', { label: 'e' }), step('status')],
    'a launch never approved: review-required, nothing starts',
  ),
  lc(
    await approve(stored({ enabled: false }), resolved()),
    options(),
    [step('ensure', { label: 'e' }), list('l'), callStep('c'), step('status')],
    'a server turned off',
  ),
  lc(
    await approve(stored({ kind: 'remote', url: 'https://x.test/mcp', command: '' }), resolved()),
    options(),
    [step('ensure', { label: 'e' }), list('l'), callStep('c')],
    'a remote server is not a local one',
  ),
  lc(
    OK,
    options({ appSignal: 'aborted' }),
    [step('ensure', { label: 'e' }), callStep('c')],
    'the app is closing already',
  ),
  lc(
    OK,
    options(),
    [
      step('listen', { id: 1, kind: 'state' }),
      step('listen', { id: 2, kind: 'tools' }),
      list('l'),
      step('status'),
      init(undefined, 'be kind'),
      step('status'),
      reply(1, tools(['echo', 'ping'])),
      step('status'),
      callStep('c', 'echo', { text: 'hi' }),
      reply(2, textResult('hello')),
      stdout('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'),
      step('unlisten', { id: 2, kind: 'tools' }),
      stdout('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'),
    ],
    'start ok, list, call, tools changed notification, listener removed',
  ),
  lc(
    OK,
    options({ registry: false }),
    [...running(), callStep('c', 'echo', {}), reply(2, { content: [], isError: true })],
    'no registry; a tool error without a message',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      step('status'),
      timer(1),
      step('status'),
      exit(),
      closeChild(),
      step('status'),
      step('tail'),
    ],
    'start timeout: the process is ended, the wait for it ends with its close',
  ),
  lc(
    OK,
    options(),
    [list('l'), timer(1), timer(3), step('status')],
    'start timeout: the 5 s wait fires before the process is gone',
  ),
  lc(
    OK,
    options(),
    [list('l'), stderr('boom\n'), exit(), closeChild(), step('status'), step('tail')],
    'the child exits before the handshake: start failed, stderr kept',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      step('childError', { message: 'spawn ENOENT' }),
      step('status'),
      closeChild(),
      step('status'),
    ],
    'a child error with a pid: the transport closes, the process is awaited',
  ),
  lc(
    OK,
    options({ noPid: true }),
    [list('l'), step('childError', { message: 'spawn ENOENT' }), step('status'), step('tail')],
    'a child that never started (no pid): gone at once',
  ),
  lc(
    OK,
    options({ spawnFailures: ['no such file', 'no such file', 'no such file', null] }),
    [
      list('l1'),
      step('status'),
      list('l2'),
      step('status'),
      list('l3'),
      step('status'),
      list('l4'),
      step('retry'),
      step('status'),
      list('l5'),
      init(),
      reply(1, tools(['a'])),
    ],
    'three failed starts in a row: failed until retry',
  ),
  lc(
    OK,
    options({ maxStartFailures: 1, spawnFailures: ['x'] }),
    [list('l1'), step('status'), step('retry'), step('status')],
    'one failed start is enough',
  ),
  lc(
    OK,
    options({ spawnFailures: [], workDirFails: 1 }),
    [
      list('l1'),
      step('status'),
      list('l2'),
      step('status'),
      init(),
      reply(1, tools(['a'])),
      step('status'),
    ],
    'no working folder could be made, then it can',
  ),
  lc(OK, options({ lookupThrows: [0] }), [list('l1'), step('status')], 'the program lookup throws'),
  lc(
    await approve(stored(), {
      ok: false,
      reason: 'runtime-missing',
      detail: 'declined',
      runtime: 'node',
      downloads: [],
      message: 'downloading node was declined',
    }),
    options({
      kit: {
        ok: false,
        reason: 'runtime-missing',
        detail: 'declined',
        runtime: 'node',
        downloads: [],
        message: 'downloading node was declined',
      },
    }),
    [list('l'), step('status'), callStep('c'), step('retry'), step('status'), step('planned')],
    'runtime missing: failed at once; retry clears it',
  ),
  lc(
    OK,
    options({ platform: 'win32', kit: resolved('C:\\tools\\run.cmd') }),
    [list('l'), step('status')],
    'a Windows script cannot run without a command window',
  ),
  lc(
    OK,
    options({ kit: resolved('/usr/local/bin/other') }),
    [list('l'), step('status'), list('l2'), step('planned')],
    'the program resolves elsewhere since the approval: review-required',
  ),
  lc(
    OK,
    options({ kit: resolved('rel/tool') }),
    [list('l'), step('status'), step('planned')],
    'a relative program is not a program',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      stderr('one\ntwo\r\nthr'),
      stderr('ee\n\nfour'),
      step('tail'),
      init(),
      reply(1, tools(['a'])),
      step('tail'),
      stderr('five\n'),
      step('tail'),
      exit(),
      closeChild(),
      step('tail'),
    ],
    'standard error: lines, CRLF, a line split across chunks, a partial line',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      stderr(`${Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')}\n`),
      step('tail'),
      stderr(`${'x'.repeat(1500)}\n`),
      stderr('y'.repeat(1200)),
      step('tail'),
    ],
    'standard error: only the last 20 lines, a long line cut',
  ),
  lc(
    OK,
    options({ idleMs: 1000 }),
    [
      ...running(),
      step('listen', { id: 1, kind: 'state' }),
      timer(3),
      step('status'),
      exit(),
      closeChild(),
      step('status'),
      callStep('c'),
      init(1),
      reply(1, textResult('again'), 1),
    ],
    'idle: the server is ended, the next need starts it again',
  ),
  lc(
    OK,
    options(),
    [...running(), callStep('c1'), timer(3), reply(2, textResult('done')), step('status')],
    'a cleared idle timer never fires while a call is under way',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      callStep('c1'),
      callStep('c2', 'echo', { b: 2 }),
      step('ensure', { label: 'e' }),
      init(),
      reply(1, tools(['a'])),
      reply(2, textResult('one')),
      reply(3, textResult('two')),
    ],
    'calls that wait for one start share it',
  ),
  lc(
    OK,
    options(),
    [
      callStep('c1', 'echo', { n: 1 }, 'live'),
      callStep('c2', 'echo', { n: 2 }),
      list('l3', 'live'),
      list('l4'),
      init(),
      reply(1, textResult('2')),
      reply(2, tools(['b'])),
      reply(3, textResult('1')),
      reply(4, tools(['a'])),
    ],
    'waiters without a signal resume before those with one',
  ),
  lc(
    OK,
    options(),
    [
      list('l1'),
      step('ensure', { label: 'e', signal: 'live' }),
      step('abort', { label: 'e' }),
      init(),
      reply(1, tools(['a'])),
    ],
    'a waiter aborts: its call rejects, the start goes on',
  ),
  lc(
    OK,
    options(),
    [
      callStep('c', 'echo', {}, 'aborted'),
      list('l', 'aborted'),
      step('ensure', { label: 'e', signal: 'aborted' }),
      step('status'),
    ],
    'a signal aborted before the call: nothing starts',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c', 'echo', { a: 1 }, 'live'),
      step('abort', { label: 'c' }),
      step('abort', { label: 'c' }),
      reply(2, textResult('late')),
      step('status'),
    ],
    'a call aborts: cancelled to the server, AbortError, the server stays',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c', 'echo', { a: 1 }, 'live'),
      reply(2, textResult('fast')),
      step('abort', { label: 'c' }),
      list('l', 'live'),
      step('abort', { label: 'l' }),
    ],
    'an abort after the call finished still reaches the server (the SDK never removes its listener)',
  ),
  lc(
    OK,
    options(),
    [...running(), list('l2', 'live'), step('abort', { label: 'l2' }), reply(2, tools(['late']))],
    'a list aborts',
  ),
  lc(
    OK,
    options({ callTimeoutMs: 5000 }),
    [...running(), callStep('c'), timer(4), list('l'), timer(6), step('status')],
    'a call and a list over the time limit',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c'),
      reply(2, { content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }] }),
      callStep('c2'),
      reply(3, { nothing: 1 }),
      callStep('c3'),
      reply(4, { structuredContent: { a: 1 }, content: [] }),
    ],
    'results: non-text blocks, an unreadable result, structured content',
  ),
  lc(
    OK,
    options({ resultMaxChars: 10 }),
    [...running(), callStep('c'), reply(2, textResult('0123456789abcdef'))],
    'a long result is cut',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c'),
      {
        op: 'stdout',
        text: '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad args"}}\n',
      },
    ],
    'the server answers a call with an error',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      stdout('{"jsonrpc":"2.0","id":9,"method":"sampling/createMessage","params":{}}\n'),
      stdout(
        '{"jsonrpc":"2.0","id":10,"method":"roots/list"}\n{"jsonrpc":"2.0","id":11,"method":"ping"}\n',
      ),
      stdout(
        '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n',
      ),
      stdout('this is not json\n'),
      stdout('{"hello":1}\n'),
      stdout('{"jsonrpc":"2.0","id":99,"result":{}}\n'),
      stdout('{"jsonrpc":"2.0","method":"notifica'),
      stdout('tions/tools/list_changed"}\n'),
      step('listen', { id: 3, kind: 'tools' }),
      stdout('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'),
      step('status'),
    ],
    'what the server sends: requests are refused, noise is ignored, a notice split across chunks',
  ),
  lc(
    OK,
    options(),
    [...running(), step('destroyStdin'), callStep('c'), step('status')],
    'the stdin is destroyed: the call fails as a stopped server',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c'),
      step('stdinError'),
      step('status'),
      exit(),
      closeChild(),
      step('status'),
    ],
    'a stdin error ends the session; a call under way ends as a tool error',
  ),
  lc(
    OK,
    options(),
    [...running(), callStep('c1'), callStep('c2'), exit(), step('status'), closeChild()],
    'the process exits during calls: tool errors, idle',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      step('stop', { label: 's' }),
      exit(),
      closeChild(),
      step('status'),
      step('stop', { label: 's2' }),
    ],
    'stop: the process is ended and awaited',
  ),
  lc(
    OK,
    options(),
    [...running(), step('stop', { label: 's' }), timer(5), step('status')],
    'stop: the process never goes, the 5 s wait ends',
  ),
  lc(
    OK,
    options(),
    [list('l'), step('stop', { label: 's' }), step('status'), exit(), closeChild(), step('status')],
    'stop during a start: the start is given up',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      init(),
      step('stop', { label: 's' }),
      step('status'),
      exit(),
      closeChild(),
      step('status'),
    ],
    'stop right after the handshake started a call',
  ),
  lc(
    OK,
    options({ appSignal: 'live' }),
    [...running(), step('appAbort'), exit(), closeChild(), step('status'), callStep('c')],
    'the app quits: stopped, and later calls are refused',
  ),
  lc(
    OK,
    options(),
    [step('stop', { label: 's' }), step('status')],
    'stop of a server that never ran',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      step('setServer', { server: { ...OK, enabled: false } }),
      exit(),
      closeChild(),
      step('status'),
      list('l'),
    ],
    'setServer: turned off stops the process',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      step('setServer', { server: { ...OK, command: '/usr/bin/other' } }),
      step('status'),
    ],
    'setServer: the command changed, approval needed: stopped',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      step('setServer', { server: { ...OK, name: 'renamed', args: ['--x'] } }),
      step('status'),
      callStep('c'),
      reply(2, textResult('ok')),
    ],
    'setServer: nothing about the launch changed; the new name shows in errors',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      step('setServer', { server: { ...OK, env: { TOKEN: 'other' } } }),
      exit(),
      closeChild(),
      step('status'),
    ],
    'setServer: a changed env value restarts an idle server',
  ),
  lc(
    OK,
    options(),
    [
      ...running(),
      callStep('c'),
      step('setServer', { server: { ...OK, env: { TOKEN: 'other' } } }),
      step('status'),
      reply(2, textResult('ok')),
      exit(),
      closeChild(),
      step('status'),
    ],
    'setServer: a changed env waits for the call under way, then restarts',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      step('retry'),
      step('setServer', { server: { ...OK, env: { TOKEN: 'other' } } }),
      step('status'),
    ],
    'setServer while starting: env changed, not running',
  ),
  lc(
    OK,
    options({ kit: resolved('/usr/local/bin/other') }),
    [
      list('l'),
      step('status'),
      step('setServer', { server: OK }),
      step('status'),
      step('setServer', { server: { ...OK, approvedPlan: 'sha256:other' } }),
      step('status'),
    ],
    'setServer: a review the launcher found ends only with a new approval',
  ),
  lc(
    OK,
    options({ spawnFailures: ['x', 'x', 'x'] }),
    [
      list('l1'),
      list('l2'),
      list('l3'),
      step('status'),
      step('setServer', { server: OK_Y }),
      step('status'),
      step('setServer', { server: OK_Z }),
      step('status'),
    ],
    'setServer: a failed server is cleared by a new launch',
  ),
  lc(
    await approve(
      stored({ command: 'C:\\tools\\run.exe' }),
      resolved('C:\\tools\\run.exe'),
      'win32',
    ),
    options({ platform: 'win32', kit: resolved('C:\\tools\\run.exe') }),
    [...running(), step('stop', { label: 's' }), exit(), closeChild(), step('status')],
    'Windows: not detached, the tree is ended with taskkill',
  ),
  lc(
    await approve(
      stored({ command: 'C:\\tools\\run.exe' }),
      resolved('C:\\tools\\run.exe'),
      'win32',
    ),
    options({ platform: 'win32', kit: resolved('C:\\tools\\run.exe'), taskkillThrows: true }),
    [...running(), step('stop', { label: 's' }), exit(), closeChild()],
    'Windows: taskkill cannot run, the process is ended directly',
  ),
  lc(
    OK,
    options({ killGroupThrows: true }),
    [...running(), step('stop', { label: 's' }), timer(4), exit(), closeChild()],
    'POSIX: the process group cannot be signalled, the process is; the grace timer',
  ),
  lc(
    OK,
    options({ baseEnv: { PATH: '/usr/bin', HOME: '/h', LANG: 'ko' }, systemEnv: ['PATH', 'LANG'] }),
    [list('l'), step('status'), step('planned')],
    'systemEnv and baseEnv given: another launch plan than the approved one',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      init(),
      reply(1, {
        tools: [
          {
            name: 'a',
            description: 'da',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ],
        nextCursor: 'c1',
      }),
      reply(2, {
        tools: [
          { name: 'b', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
        ],
        nextCursor: '',
      }),
      step('status'),
      list('l2'),
      reply(3, tools(['c'], 'again')),
      reply(4, tools(['d'])),
    ],
    'tool list pages: cursors, an empty cursor ends it, optional fields',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      init(),
      ...Array.from({ length: 100 }, (_, i) => reply(i + 1, tools([`t${i}`], `c${i}`))),
      step('status'),
    ],
    'a server that never ends its tool list: 100 pages are read',
  ),
  lc(
    OK,
    options(),
    [
      list('l'),
      init(undefined, 'first'),
      reply(1, tools(['a'])),
      list('l2'),
      reply(2, { tools: 5 }),
      list('l3'),
      reply(3, { tools: [] }),
      list('l4'),
      reply(4, tools([])),
    ],
    'tool lists: a result that is no list, an empty list',
  ),
]

// ---------------------------------------------------------------------------
// runtimes.ts: the PC lookups
// ---------------------------------------------------------------------------

const EXE: FileSpec = { text: '#!/bin/sh\n', mode: 0o755 }
const PLAIN: FileSpec = { text: 'x', mode: 0o644 }
const FOLDER: FileSpec = { dir: true }

type LookupArgs = {
  env?: Record<string, string>
  platform?: string
  fallbackDirs?: string[]
  extensions?: string[]
  extraDirs?: string[]
  skip?: boolean
}

const lookupOf = (o: LookupArgs): Any => ({
  ...(o.env ? { env: o.env } : {}),
  ...(o.platform ? { platform: o.platform } : {}),
  ...(o.fallbackDirs ? { fallbackDirs: o.fallbackDirs } : {}),
  ...(o.extensions ? { extensions: o.extensions } : {}),
  ...(o.extraDirs ? { extraDirs: o.extraDirs } : {}),
  ...(o.skip ? { skipDir: (dir: string) => dir.toLowerCase().includes('windowsapps') } : {}),
})

const lk = (args: unknown[], note: string, files?: Record<string, FileSpec>): Case =>
  c(args, note, files)

const POSIX_ENV = { PATH: '$DIR/a:$DIR/b', HOME: '$DIR/home' }
const WIN_ENV = { PATH: '$DIR/a;$DIR/b', USERPROFILE: '$DIR/home' }

const programCases: Case[] = [
  lk(
    ['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'the first directory wins',
    { 'a/tool': EXE, 'b/tool': EXE },
  ),
  lk(['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'the second directory', {
    'b/tool': EXE,
  }),
  lk(
    ['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'a file that cannot run is skipped',
    { 'a/tool': PLAIN, 'b/tool': EXE },
  ),
  lk(
    ['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'a folder of that name is not a program',
    { 'a/tool': FOLDER, 'b/tool': EXE },
  ),
  lk(['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'nothing found', {
    'a/other': EXE,
  }),
  lk(
    [
      'tool',
      { env: { PATH: 'rel:.:$DIR/b', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: [] },
    ],
    'relative PATH entries are never searched',
    { 'b/tool': EXE },
  ),
  lk(
    [
      'tool',
      { env: { PATH: '', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: ['$DIR/fb'] },
    ],
    'empty PATH, a fallback directory',
    { 'fb/tool': EXE },
  ),
  lk(
    ['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: ['rel', '$DIR/a', '$DIR/fb'] }],
    'a relative fallback is left out, a duplicate counts once',
    { 'fb/tool': EXE },
  ),
  lk(
    [
      'tool',
      {
        env: { PATH: '"$DIR/a":\'$DIR/b\'', HOME: '$DIR/home' },
        platform: 'linux',
        fallbackDirs: [],
      },
    ],
    'quoted PATH entries',
    { 'a/tool': EXE },
  ),
  lk(
    ['tool', { env: { path: '$DIR/b' }, platform: 'linux', fallbackDirs: [] }],
    'PATH under another spelling',
    { 'b/tool': EXE },
  ),
  lk(
    ['a/tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'a name with a slash is not looked up',
    { 'a/tool': EXE },
  ),
  lk(['', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'an empty name'),
  lk(
    ['tool', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [], extraDirs: ['$DIR/x'] }],
    'extra directories are ignored when fallbackDirs is given',
    { 'x/tool': EXE },
  ),
  lk(['tool', { env: WIN_ENV, platform: 'win32' }], 'Windows: .exe by default', {
    'b/tool.exe': PLAIN,
    'a/tool.cmd': PLAIN,
  }),
  lk(
    ['tool.EXE', { env: WIN_ENV, platform: 'win32' }],
    'Windows: the name carries the extension (any case)',
    { 'a/tool.EXE': PLAIN },
  ),
  lk(
    ['tool', { env: WIN_ENV, platform: 'win32', extensions: ['.cmd', '.exe'] }],
    'Windows: extensions are tried in order',
    { 'a/tool.exe': PLAIN, 'a/tool.cmd': PLAIN },
  ),
  lk(
    ['tool', { env: WIN_ENV, platform: 'win32', extensions: ['.cmd', '.exe'] }],
    'Windows: the next directory after a miss',
    { 'b/tool.exe': PLAIN },
  ),
  lk(
    ['tool', { env: WIN_ENV, platform: 'win32', extraDirs: ['$DIR/x', 'rel'] }],
    'Windows: extra directories after PATH',
    { 'x/tool.exe': PLAIN },
  ),
  lk(
    [
      'tool',
      { env: { PATH: '$DIR/a;$DIR/Microsoft/WindowsApps;$DIR/b' }, platform: 'win32', skip: true },
    ],
    'a skipped directory',
    { 'Microsoft/WindowsApps/tool.exe': PLAIN, 'b/tool.exe': PLAIN },
  ),
  lk(
    ['tool', { env: { PATH: '$DIR/a;$DIR/Microsoft/WindowsApps' }, platform: 'win32' }],
    'not skipped when the case does not skip',
    { 'Microsoft/WindowsApps/tool.exe': PLAIN },
  ),
  lk(['tool', { env: { Path: '$DIR/b' }, platform: 'win32' }], 'Windows: Path', {
    'b/tool.exe': PLAIN,
  }),
]

const nodeCases: Case[] = [
  lk(
    [{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'node with npm beside it (posix layout)',
    {
      'a/node': EXE,
      'lib/node_modules/npm/bin/npm-cli.js': PLAIN,
      'lib/node_modules/npm/bin/npx-cli.js': PLAIN,
    },
  ),
  lk(
    [{ env: { PATH: '$DIR/n/bin', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: [] }],
    'node with npm under the prefix',
    {
      'n/bin/node': EXE,
      'n/lib/node_modules/npm/bin/npm-cli.js': PLAIN,
      'n/lib/node_modules/npm/bin/npx-cli.js': PLAIN,
    },
  ),
  lk(
    [{ env: { PATH: '$DIR/n/bin', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: [] }],
    'node with npm but no npx',
    {
      'n/bin/node': EXE,
      'n/lib/node_modules/npm/bin/npm-cli.js': PLAIN,
    },
  ),
  lk(
    [{ env: { PATH: '$DIR/n/bin', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: [] }],
    'node alone',
    { 'n/bin/node': EXE },
  ),
  lk(
    [
      {
        env: { PATH: '$DIR/n/bin:$DIR/m/bin', HOME: '$DIR/home' },
        platform: 'linux',
        fallbackDirs: [],
      },
    ],
    'an npm named after its script is no link to it',
    {
      'n/bin/node': EXE,
      'n/bin/npm': EXE,
    },
  ),
  lk([{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'no node'),
  lk(
    [{ env: { PATH: '$DIR/w', HOME: '$DIR/home' }, platform: 'win32' }],
    'Windows: node.exe with npm beside it',
    {
      'w/node.exe': PLAIN,
      'w/node_modules/npm/bin/npm-cli.js': PLAIN,
      'w/node_modules/npm/bin/npx-cli.js': PLAIN,
    },
  ),
  lk(
    [{ env: { PATH: '', ProgramFiles: '$DIR/pf' }, platform: 'win32' }],
    'Windows: Program Files',
    {
      'pf/nodejs/node.exe': PLAIN,
      'pf/nodejs/node_modules/npm/bin/npm-cli.js': PLAIN,
    },
  ),
  lk([{ env: { PATH: '', PROGRAMFILES: '$DIR/pf' }, platform: 'win32' }], 'Windows: PROGRAMFILES', {
    'pf/nodejs/node.exe': PLAIN,
  }),
  lk([{ env: { PATH: '', ProgramFiles: '' }, platform: 'win32' }], 'Windows: no Program Files'),
  lk(
    [{ env: { PATH: '', HOME: '$DIR/home' }, platform: 'linux', fallbackDirs: ['$DIR/fb'] }],
    'node in a fallback directory',
    {
      'fb/node': EXE,
    },
  ),
]

const uvCases: Case[] = [
  lk([{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'uv with uvx beside it', {
    'a/uv': EXE,
    'a/uvx': EXE,
  }),
  lk([{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'uv without uvx', { 'a/uv': EXE }),
  lk([{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'a uvx that cannot run', {
    'a/uv': EXE,
    'a/uvx': PLAIN,
  }),
  lk([{ env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'no uv', { 'a/uvx': EXE }),
  lk(
    [{ env: { PATH: '', USERPROFILE: '$DIR/home' }, platform: 'win32' }],
    'Windows: uv in .local/bin',
    { 'home/.local/bin/uv.exe': PLAIN, 'home/.local/bin/uvx.exe': PLAIN },
  ),
  lk(
    [{ env: { PATH: '', USERPROFILE: '$DIR/home' }, platform: 'win32' }],
    'Windows: uv in .cargo/bin',
    { 'home/.cargo/bin/uv.exe': PLAIN },
  ),
  lk(
    [{ env: { PATH: '', USERPROFILE: '', HOME: '$DIR/home' }, platform: 'win32' }],
    'Windows: an empty USERPROFILE is not a home',
    { 'home/.cargo/bin/uv.exe': PLAIN },
  ),
]

const pythonCases: Case[] = [
  lk(['python', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'python', {
    'a/python': EXE,
    'a/python3': EXE,
  }),
  lk(['python3', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'python3 first', {
    'a/python': EXE,
    'a/python3': EXE,
  }),
  lk(
    ['python3', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'python3 asked, only python there',
    { 'b/python': EXE },
  ),
  lk(
    ['python', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }],
    'python asked, only python3 there',
    { 'b/python3': EXE },
  ),
  lk(['python', { env: POSIX_ENV, platform: 'linux', fallbackDirs: [] }], 'none'),
  lk(
    ['python3', { env: { PATH: '$DIR/a;$DIR/Microsoft/WindowsApps;$DIR/b' }, platform: 'win32' }],
    'Windows: the store stub is not a Python',
    { 'Microsoft/WindowsApps/python.exe': PLAIN, 'b/python.exe': PLAIN },
  ),
  lk(
    ['python', { env: { PATH: '$DIR/Microsoft/WindowsApps/' }, platform: 'win32' }],
    'Windows: only the store stub',
    { 'Microsoft/WindowsApps/python.exe': PLAIN },
  ),
  lk(
    ['python3', { env: { PATH: '$DIR/b' }, platform: 'win32' }],
    'Windows: python3 is looked up as python',
    { 'b/python3.exe': PLAIN, 'b/python.exe': PLAIN },
  ),
  lk(
    ['python3', { env: { PATH: '/usr/bin' }, platform: 'darwin', fallbackDirs: [] }],
    'macOS: the developer-tools stub of /usr/bin',
  ),
  lk(
    ['python3', { env: POSIX_ENV, platform: 'darwin', fallbackDirs: [] }],
    'macOS: a python that is no stub',
    { 'a/python3': EXE },
  ),
]

const commandCases: Case[] = [
  ...[
    'node',
    'npx',
    'npm',
    'uv',
    'uvx',
    'python',
    'python3',
    'tool',
    '',
    '  node  ',
    './node',
    '/usr/bin/node',
    'C:\\node',
    'nodes',
    'Node',
  ].map((command) => c([command, 'linux'], `linux: ${JSON.stringify(command)}`)),
  ...[
    'node.exe',
    'NODE.EXE',
    'npx.cmd',
    'NPM.Bat',
    'uvx.com',
    'Python.exe',
    'python3.EXE',
    'node.sh',
    'python3.exe.exe',
    'tool.exe',
    '.exe',
    'node.',
    'x\\node.exe',
  ].map((command) => c([command, 'win32'], `win32: ${JSON.stringify(command)}`)),
]

// ---------------------------------------------------------------------------
// runtimes.ts: the kit
// ---------------------------------------------------------------------------

/** a zip as JSZip writes it, with Unix permissions */
async function zipHex(entries: { name: string; data?: string; perms?: number }[]): Promise<string> {
  const zip = new JSZip()
  for (const e of entries) {
    zip.file(e.name, e.data ?? '', {
      createFolders: false,
      ...(e.perms !== undefined ? { unixPermissions: e.perms } : {}),
    })
  }
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
  })
  return bytes.toString('hex')
}

const NPM_JS = 'node-v1/lib/node_modules/npm/bin'
const ARCHIVES = {
  nodePosix: await zipHex([
    { name: 'node-v1/bin/node', data: 'node', perms: 0o755 },
    { name: `${NPM_JS}/npm-cli.js`, data: 'npm' },
    { name: `${NPM_JS}/npx-cli.js`, data: 'npx' },
  ]),
  nodeWin: await zipHex([
    { name: 'node-v1/node.exe', data: 'node' },
    { name: 'node-v1/node_modules/npm/bin/npm-cli.js', data: 'npm' },
    { name: 'node-v1/node_modules/npm/bin/npx-cli.js', data: 'npx' },
  ]),
  nodeBroken: await zipHex([
    { name: 'node-v1/bin/node', data: 'node', perms: 0o755 },
    { name: `${NPM_JS}/npm-cli.js`, data: 'npm' },
  ]),
  uvPosix: await zipHex([
    { name: 'uv-x/uv', data: 'uv', perms: 0o755 },
    { name: 'uv-x/uvx', data: 'uvx', perms: 0o755 },
  ]),
  uvWin: await zipHex([
    { name: 'uv-x/uv.exe', data: 'uv' },
    { name: 'uv-x/uvx.exe', data: 'uvx' },
  ]),
}
const sha = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
const archiveOf = (url: string, hex: string, root: string): Record<string, unknown> => ({
  url,
  sha256: sha(hex),
  bytes: hex.length / 2,
  format: 'zip',
  root,
})
const urlOf = (name: string): string => `https://example.test/${name}.zip`
const pinsOf = (nodePosix = ARCHIVES.nodePosix): Record<string, unknown> => ({
  node: {
    version: '1.0.0',
    archives: {
      'win32-x64': archiveOf(urlOf('node-win'), ARCHIVES.nodeWin, 'node-v1'),
      'darwin-arm64': archiveOf(urlOf('node-posix'), nodePosix, 'node-v1'),
      'darwin-x64': archiveOf(urlOf('node-posix'), nodePosix, 'node-v1'),
      'linux-x64': archiveOf(urlOf('node-posix'), nodePosix, 'node-v1'),
    },
  },
  uv: {
    version: '2.0.0',
    archives: {
      'win32-x64': archiveOf(urlOf('uv-win'), ARCHIVES.uvWin, 'uv-x'),
      'darwin-arm64': archiveOf(urlOf('uv-posix'), ARCHIVES.uvPosix, 'uv-x'),
      'darwin-x64': archiveOf(urlOf('uv-posix'), ARCHIVES.uvPosix, 'uv-x'),
      'linux-x64': archiveOf(urlOf('uv-posix'), ARCHIVES.uvPosix, 'uv-x'),
    },
  },
  python: {
    version: '3.13.2',
    bytes: { 'win32-x64': 1000, 'darwin-arm64': 2000, 'darwin-x64': 3000, 'linux-x64': 4000 },
  },
})
const split = (hex: string): string[] => [hex.slice(0, 20), hex.slice(20)]
const ROUTES: Record<string, unknown> = {
  [urlOf('node-win')]: { chunks: split(ARCHIVES.nodeWin) },
  [urlOf('node-posix')]: { chunks: split(ARCHIVES.nodePosix) },
  [urlOf('uv-win')]: { chunks: split(ARCHIVES.uvWin) },
  [urlOf('uv-posix')]: { chunks: split(ARCHIVES.uvPosix) },
}

type KitStep =
  | { op: 'resolve'; command: string; offerDownload?: boolean }
  | { op: 'resolveAll'; commands: string[] }

interface KitOptions {
  platform: string
  arch: string
  root: string
  env: Record<string, string>
  fallbackDirs?: string[]
  pins?: unknown
  allowed?: string[]
  ask?: (boolean | 'throw')[]
  allowedThrows?: boolean
  recordThrows?: boolean
  fetch?: Record<
    string,
    { status?: number; chunks?: string[]; reject?: string; midError?: string; noBody?: boolean }
  >
  uvFind?: { code: number; stdout: string }[]
  uvInstall?: { code: number; stdout: string }[]
  uvThrows?: boolean
  renameFailures?: (string | null)[]
}

const resolutionOut = (r: Any): unknown => r

async function kitScenario(a: unknown[], cx: TsContext): Promise<unknown> {
  const [o, steps] = a as [KitOptions, KitStep[]]
  const allowed = new Set(o.allowed ?? [])
  let asks = 0
  let finds = 0
  let installs = 0
  let renames = 0
  const fetchImpl = async (url: string): Promise<Response> => {
    cx.log('fetch', url)
    const spec = (o.fetch ?? {})[url]
    if (!spec) throw new Error('no route')
    if (spec.reject !== undefined) throw new Error(spec.reject)
    const chunks = (spec.chunks ?? []).map((h) => new Uint8Array(Buffer.from(h, 'hex')))
    let next = 0
    const body = spec.noBody
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (next < chunks.length) controller.enqueue(chunks[next++]!)
            else if (spec.midError !== undefined) controller.error(new Error(spec.midError))
            else controller.close()
          },
        })
    return new Response(body, { status: spec.status ?? 200 })
  }
  const realSetTimeout = globalThis.setTimeout
  const realRename = fsp.rename
  const realRandomBytes = crypto.randomBytes
  ;(globalThis as Any).setTimeout = (fn: () => void, ms: number) => {
    cx.log('sleep', ms)
    queueMicrotask(fn)
    return {}
  }
  ;(fsp as Any).rename = async (from: string, to: string) => {
    cx.log('rename', from, to)
    const code = (o.renameFailures ?? [])[renames]
    renames += 1
    if (code) throw Object.assign(new Error(`${code}: rename failed`), { code })
    return realRename(from, to)
  }
  ;(crypto as Any).randomBytes = () => Buffer.from([0xab, 0xcd, 0x12, 0x34])
  syncBuiltinESMExports()
  try {
    const kit = rt.createMcpRuntimeKit({
      runtimesRoot: o.root,
      isRuntimeAllowed: (id) => {
        cx.log('allowed?', id)
        if (o.allowedThrows) throw new Error('store')
        return allowed.has(id)
      },
      recordRuntimeAllowed: async (id) => {
        cx.log('record', id)
        if (o.recordThrows) throw new Error('write')
        allowed.add(id)
      },
      askDownload: async (question) => {
        cx.log('ask', question)
        const answers = o.ask ?? [false]
        const answer = answers[Math.min(asks, answers.length - 1)]
        asks += 1
        if (answer === 'throw') throw new Error('ui')
        return answer === true
      },
      fetch: fetchImpl as never,
      env: o.env,
      platform: o.platform as NodeJS.Platform,
      arch: o.arch,
      ...(o.fallbackDirs ? { fallbackDirs: o.fallbackDirs } : {}),
      pins: o.pins as never,
      runUv: async (uv, args, options) => {
        cx.log('runUv', uv, args, options.env, options.cwd)
        if (o.uvThrows) throw new Error('uv')
        if (args[1] === 'find') {
          const list = o.uvFind ?? [{ code: 1, stdout: '' }]
          const answer = list[Math.min(finds, list.length - 1)] as { code: number; stdout: string }
          finds += 1
          return answer
        }
        const list = o.uvInstall ?? [{ code: 0, stdout: '' }]
        const answer = list[Math.min(installs, list.length - 1)] as { code: number; stdout: string }
        installs += 1
        return answer
      },
    })
    const results: unknown[] = []
    for (const step of steps) {
      const one = async (command: string, offerDownload?: boolean): Promise<unknown> => {
        try {
          return resolutionOut(
            await kit.resolveCommand(command, offerDownload === undefined ? {} : { offerDownload }),
          )
        } catch {
          return { rejected: true }
        }
      }
      if (step.op === 'resolve') results.push(await one(step.command, step.offerDownload))
      else {
        // which of the concurrent lookups reaches the queue first depends on the thread pool's
        // completion order, so the answers are listed in sorted order
        const all = await Promise.all(step.commands.map((command) => one(command)))
        results.push(all.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)))
      }
    }
    return { results }
  } finally {
    globalThis.setTimeout = realSetTimeout
    ;(fsp as Any).rename = realRename
    ;(crypto as Any).randomBytes = realRandomBytes
    syncBuiltinESMExports()
  }
}

const POSIX_BASE = { PATH: '$DIR/none', HOME: '$DIR/home', LANG: 'ko_KR.UTF-8', SECRET: 'no' }
const kitOptions = (over: Partial<KitOptions> = {}): KitOptions => ({
  platform: 'linux',
  arch: 'x64',
  root: '$DIR/rt',
  env: POSIX_BASE,
  fallbackDirs: [],
  fetch: ROUTES as never,
  pins: pinsOf(),
  ...over,
})
const kc = (
  opts: KitOptions,
  steps: KitStep[],
  note: string,
  files?: Record<string, FileSpec>,
): Case => c([opts, steps], note, files)
const rs = (command: string, offerDownload?: boolean): KitStep => ({
  op: 'resolve',
  command,
  ...(offerDownload === undefined ? {} : { offerDownload }),
})

const PC_NODE: Record<string, FileSpec> = {
  'pc/bin/node': EXE,
  'pc/lib/node_modules/npm/bin/npm-cli.js': PLAIN,
  'pc/lib/node_modules/npx/placeholder': PLAIN,
  'pc/lib/node_modules/npm/bin/npx-cli.js': PLAIN,
}
const PC_ENV = { ...POSIX_BASE, PATH: '$DIR/pc/bin:$DIR/pcp' }

const kitCases: Case[] = [
  kc(
    kitOptions({ env: PC_ENV }),
    [rs('node'), rs('npx'), rs('npm'), rs('NPX')],
    'the PC has Node: it is used, no question',
    PC_NODE,
  ),
  kc(
    kitOptions({ env: PC_ENV }),
    [rs('npx', true)],
    'the PC has Node but its npm lacks npx: the app Node is asked for',
    { 'pc/bin/node': EXE, 'pc/lib/node_modules/npm/bin/npm-cli.js': PLAIN },
  ),
  kc(
    kitOptions({ ask: [true] }),
    [rs('node'), rs('npx'), rs('npm'), rs('node')],
    'no Node: asked once, downloaded, later found installed',
  ),
  kc(kitOptions({ allowed: ['node'] }), [rs('npx')], 'already allowed: no question'),
  kc(kitOptions({ ask: [false] }), [rs('node'), rs('node')], 'declined, twice'),
  kc(kitOptions({ ask: ['throw'] }), [rs('node')], 'the question fails: declined'),
  kc(kitOptions({ ask: [true] }), [rs('node', false)], 'a download is not offered'),
  kc(
    kitOptions({ ask: [true], recordThrows: true }),
    [rs('node')],
    'the permission cannot be recorded: the lookup is rejected',
  ),
  kc(
    kitOptions({ allowedThrows: true }),
    [rs('node')],
    'the allowed state cannot be read: the lookup is rejected',
  ),
  kc(kitOptions({ ask: [true], fetch: {} }), [rs('node')], 'the download has no route: offline'),
  kc(
    kitOptions({
      ask: [true],
      fetch: { [urlOf('node-posix')]: { reject: 'getaddrinfo ENOTFOUND' } },
    }),
    [rs('node')],
    'the download is refused: offline',
  ),
  kc(
    kitOptions({ ask: [true], fetch: { [urlOf('node-posix')]: { status: 404, chunks: [] } } }),
    [rs('node')],
    'HTTP 404: offline',
  ),
  kc(
    kitOptions({
      ask: [true],
      fetch: { [urlOf('node-posix')]: { chunks: split(ARCHIVES.nodePosix).slice(0, 1) } },
    }),
    [rs('node')],
    'a short download: hash mismatch',
  ),
  kc(
    kitOptions({
      ask: [true],
      fetch: {
        [urlOf('node-posix')]: { chunks: split(ARCHIVES.nodePosix), midError: 'socket hang up' },
      },
    }),
    [rs('node')],
    'the download breaks off: offline',
  ),
  kc(
    kitOptions({
      ask: [true],
      pins: pinsOf(ARCHIVES.nodeBroken),
      fetch: { [urlOf('node-posix')]: { chunks: split(ARCHIVES.nodeBroken) } },
    }),
    [rs('node')],
    'the archive lacks npx: extract failed, nothing left behind',
  ),
  kc(
    kitOptions({ allowed: ['node'], renameFailures: ['EBUSY', 'EPERM', null] }),
    [rs('node')],
    'the unpacked folder is held briefly: the rename is retried',
  ),
  kc(
    kitOptions({
      allowed: ['node'],
      renameFailures: ['EACCES', 'EACCES', 'EACCES', 'EACCES', 'EACCES', 'EACCES', 'EACCES'],
    }),
    [rs('node')],
    'the rename never works',
  ),
  kc(
    kitOptions({ allowed: ['node'], renameFailures: ['ENOENT'] }),
    [rs('node')],
    'a rename failure that is not retried',
  ),
  kc(kitOptions({ allowed: ['node'] }), [rs('node')], 'older versions and leftovers are removed', {
    'rt/node-0.9.0/bin/node': PLAIN,
    'rt/.download-node-1.0.0-ffff': PLAIN,
    'rt/.staging-node-1.0.0-ffff/x': PLAIN,
    'rt/uv-1.0.0/uv': PLAIN,
    'rt/nodes-keep/x': PLAIN,
    'rt/node-x/y': PLAIN,
  }),
  kc(
    kitOptions({ allowed: ['node'] }),
    [rs('node')],
    'an installed Node is kept, other versions and leftovers go',
    {
      'rt/node-1.0.0/bin/node': PLAIN,
      'rt/node-1.0.0/lib/node_modules/npm/bin/npm-cli.js': PLAIN,
      'rt/node-1.0.0/lib/node_modules/npm/bin/npx-cli.js': PLAIN,
      'rt/node-0.9.0/bin/node': PLAIN,
      'rt/.staging-node-0.9.0-aa/x': PLAIN,
    },
  ),
  kc(
    kitOptions({ arch: 'arm64', ask: [true] }),
    [rs('node'), rs('uvx'), rs('python')],
    'no pinned download for this chip',
  ),
  kc(
    kitOptions({
      platform: 'win32',
      arch: 'x64',
      allowed: ['node'],
      env: { ...POSIX_BASE, PATH: '$DIR/none' },
    }),
    [rs('node.exe'), rs('NPM.CMD'), rs('npx')],
    'Windows: the layout of the zip',
  ),
  kc(kitOptions({ platform: 'darwin', arch: 'arm64', allowed: ['node'] }), [rs('npm')], 'macOS'),
  kc(
    kitOptions({ ask: [true] }),
    [{ op: 'resolveAll', commands: ['node', 'node', 'node'] }],
    'concurrent lookups are queued: one question, one download',
  ),
  kc(
    kitOptions({ ask: [false, true] }),
    [{ op: 'resolveAll', commands: ['node', 'node'] }],
    'concurrent lookups: the second asks again after a no',
  ),
  // uv and python
  kc(
    kitOptions({ env: { ...POSIX_BASE, PATH: '$DIR/pc' } }),
    [rs('uv'), rs('uvx'), rs('python'), rs('python3')],
    'the PC has uv, uvx and Python',
    {
      'pc/uv': EXE,
      'pc/uvx': EXE,
      'pc/python': EXE,
      'pc/python3': EXE,
    },
  ),
  kc(
    kitOptions({ env: { ...POSIX_BASE, PATH: '$DIR/pc' }, ask: [true] }),
    [rs('uvx')],
    'the PC has uv without uvx: the app uv, and its Python is found',
    {
      'pc/uv': EXE,
      'pc/python': EXE,
    },
  ),
  kc(
    kitOptions({ env: { ...POSIX_BASE, PATH: '$DIR/pc' }, ask: [true] }),
    [rs('uv')],
    'uv from the PC, no Python on the PC: uv reports none, so the Python is asked for and installed',
    {
      'pc/uv': EXE,
    },
  ),
  kc(
    kitOptions({
      env: { ...POSIX_BASE, PATH: '$DIR/pc' },
      ask: [true],
      uvFind: [
        { code: 1, stdout: '' },
        { code: 0, stdout: '$DIR/py/bin/python3\nignored' },
      ],
    }),
    [rs('python3'), rs('python')],
    'python through uv: installed, then found',
    { 'pc/uv': EXE, 'py/bin/python3': EXE },
  ),
  kc(
    kitOptions({
      env: { ...POSIX_BASE, PATH: '$DIR/pc' },
      ask: [true],
      uvFind: [{ code: 0, stdout: '$DIR/py/bin/python3\r\n' }],
    }),
    [rs('python')],
    'python through uv: uv already has it',
    { 'pc/uv': EXE, 'py/bin/python3': EXE },
  ),
  kc(
    kitOptions({
      env: { ...POSIX_BASE, PATH: '$DIR/pc' },
      ask: [true],
      uvInstall: [{ code: 2, stdout: '' }],
    }),
    [rs('python')],
    'python through uv: the install fails',
    { 'pc/uv': EXE },
  ),
  kc(
    kitOptions({
      env: { ...POSIX_BASE, PATH: '$DIR/pc' },
      ask: [true],
      uvFind: [{ code: 0, stdout: 'relative/python' }],
    }),
    [rs('python')],
    'python through uv: uv names no usable path after the install',
    { 'pc/uv': EXE },
  ),
  kc(
    kitOptions({ env: { ...POSIX_BASE, PATH: '$DIR/pc' }, ask: [true], uvThrows: true }),
    [rs('python')],
    'python through uv: the run of uv fails: the lookup is rejected',
    { 'pc/uv': EXE },
  ),
  kc(
    kitOptions({
      ask: [true],
      uvFind: [{ code: 0, stdout: '$DIR/rt/uv-data/python/cpython-3.13.2-linux/bin/python3' }],
    }),
    [rs('python'), rs('uv')],
    'no uv on the PC: the app uv, then its Python',
    { 'rt/uv-data/python/cpython-3.13.2-linux/bin/python3': EXE },
  ),
  kc(
    kitOptions({
      allowed: ['uv', 'python'],
      uvFind: [{ code: 0, stdout: '$DIR/rt/uv-data/python/cpython-3.13.2-linux/bin/python3' }],
    }),
    [rs('uvx'), rs('uvx')],
    'the app uv, its Python folder present: nothing to ask, the second time uv is installed',
    { 'rt/uv-data/python/cpython-3.13.2-linux/bin/python3': EXE },
  ),
  kc(
    kitOptions({ allowed: ['uv'], uvFind: [{ code: 0, stdout: '$DIR/py3' }] }),
    [rs('uv')],
    'the app uv, an installed uv, the Python still to be found',
    {
      'rt/uv-2.0.0/uv': EXE,
      'rt/uv-2.0.0/uvx': EXE,
      'rt/uv-data/python/cpython-3.13.2-linux/bin/python3': EXE,
      py3: EXE,
    },
  ),
  kc(
    kitOptions({
      platform: 'win32',
      allowed: ['uv'],
      env: { ...POSIX_BASE, PATH: '$DIR/none' },
      uvFind: [{ code: 0, stdout: '$DIR/py3' }],
    }),
    [rs('uvx.exe')],
    'Windows: uv.exe and uvx.exe',
    {
      'rt/uv-data/python/cpython-3.13.2-win/python.exe': PLAIN,
      py3: EXE,
    },
  ),
  kc(
    kitOptions({ ask: [true], allowed: ['python'] }),
    [rs('python', false), rs('uv', false)],
    'uv and Python: a download is not offered',
  ),
  kc(
    kitOptions({
      ask: [true],
      allowed: ['uv'],
      uvFind: [
        { code: 1, stdout: '' },
        { code: 0, stdout: '$DIR/py3' },
      ],
    }),
    [rs('python')],
    'only some of the downloads are allowed: asked, the rest recorded',
    { py3: EXE },
  ),
  // other commands
  kc(
    kitOptions({ env: { ...POSIX_BASE, PATH: '$DIR/pc' } }),
    [
      rs('tool'),
      rs(' tool '),
      rs('missing'),
      rs('$DIR/abs/tool'),
      rs('$DIR/abs/nothing'),
      rs('rel/tool'),
      rs('/'),
      rs(''),
    ],
    'other commands: PATH, a full path, a relative path',
    {
      'pc/tool': EXE,
      'abs/tool': EXE,
    },
  ),
  kc(
    kitOptions({ platform: 'win32', env: { ...POSIX_BASE, PATH: '$DIR/pc' } }),
    [rs('tool'), rs('script'), rs('prog.exe')],
    'other commands on Windows try .exe, .com, .cmd, .bat',
    {
      'pc/tool.cmd': PLAIN,
      'pc/script.bat': PLAIN,
      'pc/prog.exe': PLAIN,
    },
  ),
]

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

const lookupFn = (call: (a: unknown[], lookup: Any) => unknown, cases: Case[]): FnSpec => ({
  ts: (a) => call(a, lookupOf(a[a.length - 1] as LookupArgs)),
  cases,
})

export const group: Group = {
  'local.MCP_LOCAL_IDLE_MS': constant(local.MCP_LOCAL_IDLE_MS),
  'local.MCP_LOCAL_START_TIMEOUT_MS': constant(local.MCP_LOCAL_START_TIMEOUT_MS),
  'local.MCP_LOCAL_MAX_START_FAILURES': constant(local.MCP_LOCAL_MAX_START_FAILURES),
  'local.MCP_STDERR_TAIL_LINES': constant(local.MCP_STDERR_TAIL_LINES),
  'local.scenario': { ts: (a, cx) => localScenario(a, cx), cases: localCases },
  'runtimes.MCP_RUNTIMES_DIR_NAME': constant(rt.MCP_RUNTIMES_DIR_NAME),
  'runtimes.mcpRuntimesRoot': {
    ts: (a) => rt.mcpRuntimesRoot(a[0] as string),
    cases: [c(['/data']), c(['/data/']), c(['C:\\data']), c(['']), c(['rel/dir'])],
  },
  'runtimes.runtimeInstallDir': {
    ts: (a) => rt.runtimeInstallDir(a[0] as string, a[1] as 'node' | 'uv', a[2] as string),
    cases: [
      c(['/r', 'node', '26.1.0']),
      c(['/r/', 'uv', '0.13.6']),
      c(['', 'node', '']),
      c(['/r', 'uv', '1/../2']),
    ],
  },
  'runtimes.uvDataEnv': {
    ts: (a) => rt.uvDataEnv(a[0] as string),
    cases: [c(['/r']), c(['/r/mcp-runtimes/']), c([''])],
  },
  'runtimes.runtimeForCommand': {
    ts: (a) => rt.runtimeForCommand(a[0] as string, a[1] as NodeJS.Platform),
    cases: commandCases,
  },
  'runtimes.findProgramOnPath': lookupFn(
    (a, l) => rt.findProgramOnPath(a[0] as string, l),
    programCases,
  ),
  'runtimes.findPcNode': lookupFn((_a, l) => rt.findPcNode(l), nodeCases),
  'runtimes.findPcUv': lookupFn((_a, l) => rt.findPcUv(l), uvCases),
  'runtimes.findPcPython': lookupFn(
    (a, l) => rt.findPcPython(a[0] as 'python' | 'python3', l),
    pythonCases,
  ),
  'runtimes.scenario': { ts: (a, cx) => kitScenario(a, cx), cases: kitCases },
}
