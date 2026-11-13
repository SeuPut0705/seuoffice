/**
 * The scripted world of group `b5-provider`: the network, the timers, the
 * child processes, the clock and the randomness the AI runtime of
 * packages/ai-provider awaits. The Rust side (calls/b5_provider/world.rs)
 * drives `ai_provider::task::Runtime` over the same script and writes the
 * same log lines.
 *
 * How a call runs: every scripted answer comes at once; when nothing is left
 * to do but wait, the earliest timer fires (the clock jumps to it). The call
 * must end that way, or the case fails with "the call never ended".
 *
 * The script (`World`, a case's JSON):
 * - `fetches`: one answer per fetch, in order. `{ status=200, statusText='',
 *   headers: [[name, value]], body: chunks | null, type='basic', url='',
 *   redirected=false }`, where a chunk is a string (UTF-8), `{ hex }` or
 *   `{ fill: byte, size: n }` (n copies of one byte) and
 *   `body` absent is no chunk at all (an empty body); or `{ reject: { class,
 *   name, message, code, cause } }` (`cause`: any JSON, the error's `cause`);
 *   or `{ hang: true }`: no answer until its signal
 *   aborts. A fetch past the end rejects with `TypeError: fetch failed`.
 * - `children`: one per spawn, in order. `{ pid=4242+i | null, error:
 *   { message, code }, stdout: chunks, stderr: chunks, replies: [{ stdout,
 *   stderr }] (the k-th after the k-th write to stdin), exit: { code=0,
 *   signal=null }, closeOn: 'start' | 'end' | 'kill' | n (after n writes) |
 *   'never' (default 'end') }`. A spawn past the end is a child that did not
 *   start (`spawn ENOENT`).
 * - `calls`: the answers of the functions the caller passed in (`openBrowser`
 *   and the like), in order: a value, or `{ reject: message }`.
 * - `requests`: loopback HTTP requests a caller's browser would make: `{
 *   afterCall: k, method='GET', url, headers: [[name, value]] }` is handed
 *   to the newest open server (`http.createServer`) after the k-th call has
 *   answered (calls count from 0); `$state` in `url` is the `state` query
 *   parameter of the first argument of that call. A server listens on port
 *   40001 and answers `listen` at once, or fails it with `listenError: {
 *   message, code }`. A body chunk `{ error: message }` makes the stream fail
 *   when it is read.
 * - `env` (`process.env`), `platform` (default `linux`), `pid` (1000),
 *   `abortAt`: the virtual time at which the caller's signal aborts.
 * - the case's folder: calls of `node:fs/promises` (`FS_CALLS`) run for real
 *   on it, on both sides; the TypeScript's call is not over while one is in
 *   flight, and the Rust world answers them at once (no log line).
 *
 * Log lines: `['fetch', i, via, url, method, headers, body, redirect]` (via
 * `node`, `net` or `embed`; the body a string, `{ hex }`, `{ form }` or null),
 * `['cancel', i]`, `['timer', n, ms]`, `['clear', n]`, `['spawn', i, command,
 * args, options]`, `['stdin', i, text]`, `['end', i]`, `['kill', i, signal]`,
 * `['killpid', pid, signal]`, `['call', name, args]`, `['log', level,
 * ...args]`, `['listen', host, port]`, `['respond', n, status, headers,
 * body]` (the n-th request, from 0), `['close-server']`; fetches, timers
 * and children count from 0, 1 and 0. A string or bytes request body of more
 * than 1 MiB is logged as `{ big: { bytes, head, tail, fnv } }` (the length,
 * the first and last 32 bytes in hex, and the FNV-1a 32-bit hash of all).
 */
import childProcess from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { TsContext } from '../../types.ts'

/** the `node:fs/promises` calls a call under test may make on the case's folder */
const FS_CALLS = [
  'mkdir',
  'writeFile',
  'readFile',
  'readdir',
  'stat',
  'lstat',
  'realpath',
  'readlink',
  'rename',
  'rm',
  'chmod',
  'mkdtemp',
  'access',
]

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

export type Chunk = string | { hex: string } | { fill: number; size: number }

/** a chunk of a response body: bytes, or a failure of the stream */
export type BodyChunk = Chunk | { error: string }

export interface FetchSpec {
  status?: number
  statusText?: string
  headers?: [string, string][]
  body?: BodyChunk[] | null
  type?: string
  url?: string
  redirected?: boolean
  reject?: { class?: string; name?: string; message: string; code?: string; cause?: unknown }
  hang?: boolean
}

export interface ChildSpec {
  pid?: number | null
  error?: { message: string; code?: string }
  stdout?: Chunk[]
  stderr?: Chunk[]
  replies?: { stdout?: Chunk[]; stderr?: Chunk[] }[]
  exit?: { code?: number | null; signal?: string | null }
  closeOn?: 'start' | 'end' | 'kill' | 'never' | number
}

export interface World {
  fetches?: FetchSpec[]
  children?: ChildSpec[]
  calls?: unknown[]
  env?: Record<string, string>
  platform?: string
  pid?: number
  abortAt?: number
  requests?: RequestSpec[]
  listenError?: { message: string; code?: string }
}

export interface RequestSpec {
  afterCall: number
  method?: string
  url: string
  headers?: [string, string][]
}

const bytesOf = (chunk: Chunk): Uint8Array =>
  typeof chunk === 'string'
    ? new TextEncoder().encode(chunk)
    : 'fill' in chunk
      ? new Uint8Array(chunk.size).fill(chunk.fill)
      : new Uint8Array(Buffer.from(chunk.hex, 'hex'))

/** a request body of more than this many bytes is logged as a digest (`{ big }`) */
const BIG_BODY = 1 << 20

function bigLine(bytes: Uint8Array): unknown {
  let fnv = 0x811c9dc5
  for (const b of bytes) fnv = Math.imul(fnv ^ b, 0x01000193)
  return {
    big: {
      bytes: bytes.length,
      head: Buffer.from(bytes.subarray(0, 32)).toString('hex'),
      tail: Buffer.from(bytes.subarray(bytes.length - 32)).toString('hex'),
      fnv: fnv >>> 0,
    },
  }
}

/** The UUID the n-th `randomUUID()` answers, on both sides */
export const uuidOf = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A thrown value as the log writes it */
export function errorLine(e: unknown): unknown {
  if (e instanceof Error) {
    const out: Record<string, unknown> = { name: e.name, message: e.message }
    const code = (e as { code?: unknown }).code
    if (code !== undefined) out.code = code
    return out
  }
  return { value: e ?? null }
}

function errorOfSpec(r: NonNullable<FetchSpec['reject']>): Error {
  let e: Error
  if (r.class === 'DOMException') return new DOMException(r.message, r.name ?? 'Error')
  else if (r.class === 'TypeError') e = new TypeError(r.message)
  else e = new Error(r.message)
  if (r.name) e.name = r.name
  if (r.code !== undefined) (e as Any).code = r.code
  if (r.cause !== undefined) (e as Any).cause = r.cause
  return e
}

function bodyLine(body: unknown): unknown {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') {
    return Buffer.byteLength(body) > BIG_BODY ? bigLine(Buffer.from(body)) : body
  }
  if (body instanceof FormData) {
    const parts: unknown[] = []
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') parts.push([name, value])
      else parts.push([name, { mime: value.type, name: (value as File).name ?? null }])
    }
    return { form: parts }
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength > BIG_BODY
      ? bigLine(new Uint8Array(body))
      : { hex: Buffer.from(body).toString('hex') }
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return bytes.length > BIG_BODY ? bigLine(bytes) : { hex: Buffer.from(bytes).toString('hex') }
  }
  return { other: String(body) }
}

function headersLine(headers: unknown): [string, string][] {
  if (!headers) return []
  if (headers instanceof Headers) return [...headers.entries()]
  if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k), String(v)])
  return Object.entries(headers as Record<string, string>).map(([k, v]) => [k, String(v)])
}

interface Timer {
  n: number
  at: number
  fn: () => void
}

/** The world's state while one call runs. */
export class WorldRun {
  now: number
  private timers: Timer[] = []
  private timerCount = 0
  private fetchCount = 0
  private childCount = 0
  private callCount = 0
  private requestCount = 0
  private servers: { handler: (req: Any, res: Any) => void; open: boolean }[] = []
  private uuidCount = 0
  private randomCount = 0
  private cancelled = new Set<number>()
  /** asynchronous emits not done yet */
  private pendingEmits = 0
  /** real file system calls in flight: the call is not over while one is */
  private pendingIo = 0
  readonly abort = new AbortController()

  constructor(
    readonly world: World,
    readonly cx: TsContext,
  ) {
    this.now = cx.now
  }

  log(...line: unknown[]): void {
    this.cx.log(...line)
  }

  private cancel(i: number): void {
    if (this.cancelled.has(i)) return
    this.cancelled.add(i)
    this.log('cancel', i)
  }

  setTimeout = (fn: () => void, ms?: number): Any => {
    this.timerCount += 1
    const n = this.timerCount
    const wait = Number(ms ?? 0)
    this.log('timer', n, wait)
    this.timers.push({ n, at: this.now + (Number.isFinite(wait) && wait > 0 ? wait : 0), fn })
    const handle = {
      n,
      unref: () => handle,
      ref: () => handle,
      hasRef: () => true,
      refresh: () => handle,
      [Symbol.toPrimitive]: () => n,
    }
    return handle
  }

  clearTimeout = (handle: unknown): void => {
    const n = (handle as { n?: number } | null | undefined)?.n
    const at = this.timers.findIndex((t) => t.n === n)
    if (at < 0) return
    this.timers.splice(at, 1)
    this.log('clear', n)
  }

  /** A fetch that goes through `via`. */
  fetch(via: string): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return (input, init = {}) => {
      const signal = init.signal ?? undefined
      // an aborted signal ends the call before it is a request
      if (signal?.aborted) return Promise.reject(signal.reason)
      const i = this.fetchCount++
      const url = String(input instanceof Request ? input.url : input)
      this.log(
        'fetch',
        i,
        via,
        url,
        init.method ?? null,
        headersLine(init.headers),
        bodyLine(init.body),
        init.redirect ?? null,
      )
      const spec = this.world.fetches?.[i]
      if (!spec) return Promise.reject(new TypeError('fetch failed'))
      if (spec.reject) return Promise.reject(errorOfSpec(spec.reject))
      if (spec.hang) {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            this.cancel(i)
            reject(signal.reason)
          })
        })
      }
      const chunks = spec.body === null ? null : [...(spec.body ?? [])]
      let stream: ReadableStream<Uint8Array> | null = null
      if (chunks) {
        let open = true
        stream = new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              signal?.addEventListener('abort', () => {
                if (!open) return
                open = false
                this.cancel(i)
                controller.error(signal.reason)
              })
            },
            pull: (controller) => {
              const next = chunks.shift()
              if (next === undefined) {
                open = false
                controller.close()
              } else if (typeof next === 'object' && 'error' in next) {
                open = false
                controller.error(new Error(next.error))
              } else controller.enqueue(bytesOf(next))
            },
            cancel: () => {
              if (!open) return
              open = false
              this.cancel(i)
            },
          },
          { highWaterMark: 0 },
        )
      }
      const status = spec.status ?? 200
      const response = new Response(stream, {
        status: status >= 200 && status <= 599 ? status : 200,
        statusText: spec.statusText ?? '',
        headers: spec.headers ?? [],
      })
      const own = (key: string, value: unknown): void => {
        Object.defineProperty(response, key, { value, configurable: true })
      }
      if (status < 200 || status > 599) {
        own('status', status)
        own('ok', false)
      }
      own('type', spec.type ?? 'basic')
      own('url', spec.url ?? '')
      own('redirected', spec.redirected ?? false)
      return Promise.resolve(response)
    }
  }

  /** `await fn(...args)` of a function the caller passed in */
  call(name: string): (...args: unknown[]) => Promise<unknown> {
    return (...args) => {
      this.log('call', name, JSON.parse(JSON.stringify(args)))
      const k = this.callCount++
      for (const spec of this.world.requests ?? [])
        if (spec.afterCall === k) this.emitLater(() => this.deliver(spec, args))
      const answer = this.world.calls?.[k]
      const r = answer as { reject?: string } | null
      if (r && typeof r === 'object' && typeof r.reject === 'string')
        return Promise.reject(new Error(r.reject))
      return Promise.resolve(answer)
    }
  }

  /** `http.createServer(handler)`: listens on port 40001 */
  createServer = (handler: (req: Any, res: Any) => void): Any => {
    const server: Any = new EventEmitter()
    const state = { handler, open: false }
    server.listen = (port: number, host: string, callback?: () => void) => {
      this.log('listen', host, port)
      const failure = this.world.listenError
      if (!failure) {
        state.open = true
        this.servers.push(state)
      }
      Promise.resolve().then(() => {
        if (!failure) return callback?.()
        const e: Any = new Error(failure.message)
        if (failure.code) e.code = failure.code
        server.emit('error', e)
      })
      return server
    }
    server.address = () => ({ port: 40001, address: '127.0.0.1', family: 'IPv4' })
    server.close = () => {
      if (state.open) {
        state.open = false
        this.log('close-server')
      }
      return server
    }
    server.closeAllConnections = () => undefined
    return server
  }

  /** A scripted request reaching the newest open server */
  private deliver(spec: RequestSpec, args: unknown[]): void {
    const server = [...this.servers].reverse().find((s) => s.open)
    if (!server) return
    let state = ''
    try {
      state = new URL(String(args[0])).searchParams.get('state') ?? ''
    } catch {
      // an argument that is no address names no state
    }
    const n = this.requestCount++
    let status = 0
    let headers: [string, string][] = []
    const res = {
      writeHead: (code: number, given: Record<string, string> = {}) => {
        status = code
        headers = Object.entries(given).map(([k, v]) => [k, String(v)])
        return res
      },
      end: (body?: string) => {
        this.log('respond', n, status, headers, body ?? '')
      },
    }
    const lower = (spec.headers ?? []).map(([k, v]) => [k.toLowerCase(), v])
    server.handler(
      {
        method: spec.method ?? 'GET',
        url: spec.url.split('$state').join(state),
        headers: Object.fromEntries(lower),
      },
      res,
    )
  }

  private emitLater(fn: () => void): void {
    this.pendingEmits += 1
    setImmediate(() => {
      this.pendingEmits -= 1
      fn()
    })
  }

  /** `spawn(command, args, options)` */
  spawn = (command: string, args: readonly string[] = [], options: Any = {}): Any => {
    const i = this.childCount++
    const env = options.env
      ? Object.entries(options.env as Record<string, string | undefined>).filter(
          ([, v]) => v !== undefined,
        )
      : null
    const stdio =
      typeof options.stdio === 'string'
        ? [options.stdio, options.stdio, options.stdio]
        : (options.stdio ?? ['pipe', 'pipe', 'pipe'])
    this.log('spawn', i, command, [...args], {
      cwd: options.cwd ?? null,
      env,
      stdio,
      detached: options.detached === true,
      windowsHide: options.windowsHide === true,
      shell: typeof options.shell === 'string' ? options.shell : null,
    })
    const spec: ChildSpec = this.world.children?.[i] ?? {
      pid: null,
      error: { message: `spawn ${command} ENOENT`, code: 'ENOENT' },
    }
    const child: Any = new EventEmitter()
    const stream = () => Object.assign(new EventEmitter(), { resume: () => undefined })
    child.stdout = stdio[1] === 'pipe' ? stream() : null
    child.stderr = stdio[2] === 'pipe' ? stream() : null
    let closed = false
    let writes = 0
    const exit = spec.exit ?? {}
    const close = (signal?: string | null): void => {
      if (closed) return
      closed = true
      const code = signal ? null : (exit.code ?? 0)
      const sig = signal ?? exit.signal ?? null
      if (child.stdin) child.stdin.writable = false
      child.emit('exit', code, sig)
      child.stdout?.emit('end')
      child.stdout?.emit('close')
      child.stderr?.emit('end')
      child.stderr?.emit('close')
      child.emit('close', code, sig)
    }
    const out = (stream: 'stdout' | 'stderr', chunks: Chunk[] | undefined): void => {
      for (const chunk of chunks ?? []) child[stream]?.emit('data', Buffer.from(bytesOf(chunk)))
    }
    child.stdin =
      stdio[0] === 'pipe'
        ? Object.assign(new EventEmitter(), {
            writable: true,
            write: (data: unknown) => {
              this.log('stdin', i, String(data))
              writes += 1
              const reply = spec.replies?.[writes - 1]
              const closeNow = spec.closeOn === writes
              this.emitLater(() => {
                if (closed) return
                if (reply) {
                  out('stdout', reply.stdout)
                  out('stderr', reply.stderr)
                }
                if (closeNow) close()
              })
              return true
            },
            end: () => {
              this.log('end', i)
              child.stdin.writable = false
              if ((spec.closeOn ?? 'end') === 'end') this.emitLater(() => close())
            },
          })
        : null
    child.pid = spec.error ? undefined : spec.pid === null ? undefined : (spec.pid ?? 4242 + i)
    child.killed = false
    child.kill = (signal?: string) => {
      this.log('kill', i, signal ?? null)
      child.killed = true
      if (spec.closeOn === 'kill') this.emitLater(() => close(signal ?? 'SIGTERM'))
      return true
    }
    child.unref = () => undefined
    child.ref = () => undefined
    this.emitLater(() => {
      if (spec.error) {
        const e: Any = new Error(spec.error.message)
        if (spec.error.code) e.code = spec.error.code
        child.emit('error', e)
        closed = true
        child.emit('close', -2, null)
        return
      }
      out('stdout', spec.stdout)
      out('stderr', spec.stderr)
      if (spec.closeOn === 'start') close()
    })
    return child
  }

  kill = (pid: number, signal?: string | number): true => {
    this.log('killpid', pid, signal ?? null)
    return true
  }

  randomUUID = (): string => uuidOf(++this.uuidCount)

  randomBytes = (n: number): Buffer => {
    const out = Buffer.alloc(n)
    for (let k = 0; k < n; k++) out[k] = this.randomCount++ % 256
    return out
  }

  /** Runs `call` to its end in the world; what it returned or threw. */
  async drive<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const real = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      fetch: globalThis.fetch,
      now: Date.now,
      timeout: AbortSignal.timeout,
      randomUUID: crypto.randomUUID,
      globalRandomUUID: globalThis.crypto.randomUUID,
      randomBytes: crypto.randomBytes,
      spawn: childProcess.spawn,
      createServer: http.createServer,
      kill: process.kill,
      env: process.env,
      platform: process.platform,
      pid: process.pid,
      console: { log: console.log, warn: console.warn, error: console.error, info: console.info },
    }
    const env: Record<string, string> = { ...(this.world.env ?? {}) }
    const realFs: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const name of FS_CALLS) realFs[name] = (fsPromises as Any)[name]
    try {
      globalThis.setTimeout = this.setTimeout as Any
      globalThis.clearTimeout = this.clearTimeout as Any
      globalThis.fetch = this.fetch('node') as Any
      Date.now = () => this.now
      AbortSignal.timeout = (ms: number) => {
        const c = new AbortController()
        this.setTimeout(
          () =>
            c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
          ms,
        )
        return c.signal
      }
      ;(crypto as Any).randomUUID = this.randomUUID
      ;(globalThis.crypto as Any).randomUUID = this.randomUUID
      ;(crypto as Any).randomBytes = this.randomBytes
      ;(childProcess as Any).spawn = this.spawn
      ;(http as Any).createServer = this.createServer
      ;(process as Any).kill = this.kill
      process.env = env
      Object.defineProperty(process, 'platform', {
        value: this.world.platform ?? 'linux',
        configurable: true,
      })
      Object.defineProperty(process, 'pid', {
        value: this.world.pid ?? 1000,
        configurable: true,
        writable: true,
      })
      for (const level of ['log', 'warn', 'error', 'info'] as const)
        console[level] = (...args: unknown[]) =>
          this.log('log', level, ...args.map((a) => (a instanceof Error ? errorLine(a) : a)))
      // a real file system call (the case's folder) is awaited like a scripted emit
      for (const [name, fn] of Object.entries(realFs)) {
        ;(fsPromises as Any)[name] = (...args: unknown[]) => {
          this.pendingIo += 1
          return fn(...args).finally(() => (this.pendingIo -= 1))
        }
      }
      syncBuiltinESMExports()
      if (this.world.abortAt !== undefined)
        this.timers.push({ n: 0, at: this.world.abortAt, fn: () => this.abort.abort() })
      let outcome: { value: T } | { error: unknown } | undefined
      call(this.abort.signal).then(
        (value) => (outcome = { value }),
        (error: unknown) => (outcome = { error }),
      )
      for (let turns = 0; turns < 100_000; turns++) {
        // let every promise and every scripted emit run
        let quiet = 0
        while (quiet < 3) {
          const before = this.pendingEmits + this.pendingIo
          await new Promise((r) => setImmediate(r))
          quiet = before === 0 && this.pendingEmits === 0 && this.pendingIo === 0 ? quiet + 1 : 0
        }
        if (outcome) break
        if (this.timers.length === 0) break
        let next = 0
        for (let k = 1; k < this.timers.length; k++)
          if (this.timers[k].at < this.timers[next].at) next = k
        const [timer] = this.timers.splice(next, 1)
        if (timer.at > this.now) this.now = timer.at
        timer.fn()
      }
      if (!outcome) throw new Error('the call never ended')
      if ('error' in outcome) throw outcome.error
      return outcome.value
    } finally {
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.fetch = real.fetch
      Date.now = real.now
      AbortSignal.timeout = real.timeout
      ;(crypto as Any).randomUUID = real.randomUUID
      ;(globalThis.crypto as Any).randomUUID = real.globalRandomUUID
      ;(crypto as Any).randomBytes = real.randomBytes
      ;(childProcess as Any).spawn = real.spawn
      ;(http as Any).createServer = real.createServer
      ;(process as Any).kill = real.kill
      process.env = real.env
      Object.defineProperty(process, 'platform', { value: real.platform, configurable: true })
      Object.defineProperty(process, 'pid', { value: real.pid, configurable: true, writable: true })
      Object.assign(console, real.console)
      for (const [name, fn] of Object.entries(realFs)) (fsPromises as Any)[name] = fn
      syncBuiltinESMExports()
    }
  }
}

/** Runs `call` in the world `world` (the case's script). */
export function inWorld<T>(
  world: World | undefined,
  cx: TsContext,
  call: (run: WorldRun, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const run = new WorldRun(world ?? {}, cx)
  return run.drive((signal) => call(run, signal))
}
