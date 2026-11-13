/**
 * Group `b5-mcp`, slice `client-net` (Rust: crates/main-core/src/calls/b5_mcp/client_net.rs):
 * `mcp-client/{oauth-loopback,oauth,remote}.ts`, the remote MCP connection, its
 * browser sign-in and the loopback server the browser returns to. The names
 * are `<file>.<export>`.
 *
 * The real modules run on the TypeScript side over a scripted world; the Rust
 * drives its state machines with the same script through a fake host. What is
 * compared is what the two sides do to the world, step by step. After each
 * step the answer holds six lists, each compared in its own order:
 * - `net`: `['fetch', url, method, headers, body, redirect, limitMs]` (headers
 *   as `Object.fromEntries(new Headers(...))`, `limitMs` the 20 s of the
 *   sign-in requests, else null), `['resolve', host]`, `['cancel', stream]`,
 *   `['abort', stream]`;
 * - `timers`: `['setTimeout', n, ms]` and `['clearTimeout', n]`, timers
 *   counting from 1 in the order they were made;
 * - `store`: `['writeTokens', text]`;
 * - `server`: `['listen', 0, '127.0.0.1']`, `['respond', port, status,
 *   [[name, value], ...], body]`, `['close' | 'closeIdle' | 'closeAll', port]`,
 *   servers listening on 40001, 40002, ... in the order they were made;
 * - `browser`: `['open', url]`;
 * - `events`: what the modules reported (settled operations, a changed tool
 *   list, a receiver's outcome).
 *
 * Scripted fetch (`fetches`, one answer per call in order, a call past the end
 * rejects with a TypeError): `{ status, statusText, headers, body | hex, stream,
 * url, redirected, opaque, reject, limit }`. `stream: true` makes the body a
 * stream that the steps `chunk`, `end` and `streamError` feed (streams count
 * from 1). `reject` is `{ typeError | name, message, cause }`. `limit: true`
 * is a request that hangs until its time limit passes (the 20 s of a sign-in
 * request, the 5 s the end of a session is given): the request rejects with
 * `TimeoutError` (20 s) or `AbortError` (5 s). `resolve` is the name table of
 * the resolver (a name that is not there does not resolve); randomness is a
 * fixed walk through 0..255 (`seed`); `now` is the clock a step `now` moves.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import * as loopback from '../../../../apps/shell/src/main/mcp-client/oauth-loopback.ts'
import * as oauth from '../../../../apps/shell/src/main/mcp-client/oauth.ts'
import * as remote from '../../../../apps/shell/src/main/mcp-client/remote.ts'
import type { McpSecretCodec } from '../../../../apps/shell/src/main/mcp-client/secrets.ts'
import * as store from '../../../../apps/shell/src/main/mcp-client/store.ts'
import type { Case, FnSpec, Group } from '../../types.ts'

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))
const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

// ---------------------------------------------------------------------------
// the world: a scripted fetch, a resolver, fake timers, a fake http server
// ---------------------------------------------------------------------------

interface FetchSpec {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string
  hex?: string
  stream?: boolean
  url?: string
  redirected?: boolean
  opaque?: boolean
  limit?: boolean
  reject?: {
    typeError?: boolean
    name?: string
    message: string
    cause?: { name?: string; message: string }
  }
}

interface WorldCfg {
  fetches?: FetchSpec[]
  resolve?: Record<string, string[]>
  now?: number
  seed?: number
  oauth?: { clientId: string; clientSecret: string; tokens: string } | null
  failWrite?: number[]
  listenFails?: boolean
}

type Cat = 'net' | 'timers' | 'store' | 'server' | 'browser' | 'events'
type Out = Record<Cat, unknown[][]>
const emptyOut = (): Out => ({
  net: [],
  timers: [],
  store: [],
  server: [],
  browser: [],
  events: [],
})

interface FakeReq {
  method: string
  url: string
}
interface FakeRes {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

const PAGES = {
  done: { lang: 'en', title: 'Signed in', body: 'You can close this tab & return.' },
  failed: { lang: 'en', title: 'Not signed in', body: 'Try <again>.' },
}

interface World {
  clock: number
  log: (cat: Cat, ...x: unknown[]) => void
  flush: () => Out
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  resolver: (host: string) => Promise<string[]>
  access: oauth.McpOAuthAccess
  fire: (n: number) => void
  settle: () => Promise<void>
  openExternal: (url: string) => Promise<unknown>
  openFails: boolean
  table: Record<string, string[]>
  request: (method: string, target: string, index?: number, force?: boolean) => void
  stream: (
    n: number,
  ) => { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean } | undefined
}

async function withWorld<T>(cfg: WorldCfg, body: (world: World) => Promise<T>): Promise<T> {
  let current = emptyOut()
  const log = (cat: Cat, ...x: unknown[]): void => {
    current[cat].push(x)
  }
  const world = {
    clock: cfg.now ?? 1_000_000,
    openFails: false,
  } as World
  world.log = log
  world.flush = () => {
    const out = current
    current = emptyOut()
    return out
  }

  // timers
  const pending: Array<{ callback: () => void; ms: number }> = []
  const live = new Set<number>()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    pending.push({ callback, ms: ms ?? 0 })
    const n = pending.length
    live.add(n)
    log('timers', 'setTimeout', n, ms ?? 0)
    const handle = {
      n,
      unref: () => handle,
      ref: () => handle,
      hasRef: () => false,
      [Symbol.toPrimitive]: () => n,
    }
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    const n =
      typeof handle === 'object' && handle !== null
        ? (handle as { n: number }).n
        : (handle as number)
    live.delete(n)
    log('timers', 'clearTimeout', n)
  }) as unknown as typeof clearTimeout
  world.fire = (n) => {
    const entry = pending[n - 1]
    if (!entry || !live.delete(n)) return
    entry.callback()
  }
  const fireRace = (): void => {
    for (let n = pending.length; n >= 1; n--) {
      if (live.has(n) && pending[n - 1]?.ms === 5000) {
        world.fire(n)
        return
      }
    }
  }
  // the PKCE challenge is a real crypto.subtle.digest, which answers from a thread: a step
  // also waits a moment of real time so what it started has ended before the next step
  world.settle = async () => {
    const turns = async (): Promise<void> => {
      for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
    }
    await turns()
    await new Promise((resolve) => realSetTimeout(resolve, 30))
    await turns()
  }

  // AbortSignal.timeout: the 20 s limit of a sign-in request
  const limits = new Map<AbortSignal, { ms: number; controller: AbortController }>()
  const realTimeout = AbortSignal.timeout
  ;(AbortSignal as unknown as { timeout: unknown }).timeout = (ms: number) => {
    const controller = new AbortController()
    limits.set(controller.signal, { ms, controller })
    return controller.signal
  }

  // randomness
  let state = cfg.seed ?? 1
  const walk = (size: number): Uint8Array => {
    const out = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      state = (state * 73 + 41) % 256
      out[i] = state
    }
    return out
  }
  const cryptoObject = crypto as unknown as { randomBytes: unknown }
  const realRandomBytes = cryptoObject.randomBytes
  cryptoObject.randomBytes = (size: number) => Buffer.from(walk(size))
  syncBuiltinESMExports()
  const webCrypto = globalThis.crypto as unknown as { getRandomValues: unknown }
  const realGetRandomValues = Object.getOwnPropertyDescriptor(webCrypto, 'getRandomValues')
  Object.defineProperty(webCrypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: (array: Uint8Array) => {
      array.set(walk(array.length))
      return array
    },
  })

  // the http server of the loopback receiver
  interface FakeServer {
    port: number
    closed: boolean
    handler: (req: FakeReq, res: FakeRes) => void
  }
  const servers: FakeServer[] = []
  let listened = 0
  const realCreateServer = http.createServer
  ;(http as unknown as { createServer: unknown }).createServer = (
    handler: (req: FakeReq, res: FakeRes) => void,
  ) => {
    const errorListeners: Array<(error: Error) => void> = []
    const fake: FakeServer = { port: 0, closed: false, handler }
    const server = {
      once(event: string, listener: (error: Error) => void) {
        if (event === 'error') errorListeners.push(listener)
        return server
      },
      off(event: string, listener: (error: Error) => void) {
        if (event === 'error') errorListeners.splice(errorListeners.indexOf(listener), 1)
        return server
      },
      listen(_port: number, _host: string, callback: () => void) {
        log('server', 'listen', 0, '127.0.0.1')
        if (cfg.listenFails) {
          queueMicrotask(() => {
            for (const listener of [...errorListeners]) listener(new Error('listen failed'))
          })
          return server
        }
        listened += 1
        fake.port = 40000 + listened
        servers.push(fake)
        queueMicrotask(callback)
        return server
      },
      address: () => ({ port: fake.port }),
      close() {
        log('server', 'close', fake.port)
        fake.closed = true
      },
      closeIdleConnections() {
        log('server', 'closeIdle', fake.port)
      },
      closeAllConnections() {
        log('server', 'closeAll', fake.port)
      },
    }
    return server
  }
  syncBuiltinESMExports()
  world.request = (method, target, index, force) => {
    const server = index === undefined ? servers[servers.length - 1] : servers[index]
    if (!server || (server.closed && !force)) return
    let status = 0
    let headers: Record<string, string> = {}
    const res: FakeRes = {
      writeHead(code, given) {
        status = code
        headers = given
      },
      end(text) {
        log('server', 'respond', server.port, status, Object.entries(headers), text ?? null)
      },
    }
    server.handler({ method, url: target }, res)
  }

  // the network
  const streams = new Map<
    number,
    { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }
  >()
  let streamCount = 0
  const queue = [...(cfg.fetches ?? [])]
  world.stream = (n) => streams.get(n)
  world.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as URL | Request) instanceof URL
          ? (input as URL).href
          : (input as Request).url
    const headers = Object.fromEntries(new Headers(init?.headers))
    const limit = init?.signal ? (limits.get(init.signal)?.ms ?? null) : null
    log(
      'net',
      'fetch',
      url,
      init?.method ?? 'GET',
      headers,
      init?.body === undefined || init.body === null ? null : String(init.body),
      init?.redirect ?? null,
      limit,
    )
    const spec = queue.shift()
    if (!spec) throw new TypeError('no scripted response')
    if (spec.limit) {
      const entry = init?.signal ? limits.get(init.signal) : undefined
      if (entry) {
        entry.controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        )
        throw entry.controller.signal.reason
      }
      fireRace()
      throw new DOMException('This operation was aborted', 'AbortError')
    }
    if (spec.reject) {
      const make = spec.reject.typeError
        ? new TypeError(spec.reject.message)
        : Object.assign(new Error(spec.reject.message), { name: spec.reject.name ?? 'Error' })
      if (spec.reject.cause) {
        make.cause = Object.assign(new Error(spec.reject.cause.message), {
          name: spec.reject.cause.name ?? 'Error',
        })
      }
      throw make
    }
    const status = spec.status ?? 200
    const nullBody = status === 204 || status === 205 || status === 304
    let payload: BodyInit | null = null
    if (spec.stream) {
      streamCount += 1
      const id = streamCount
      payload = new ReadableStream<Uint8Array>({
        start(controller) {
          const entry = { controller, closed: false }
          streams.set(id, entry)
          init?.signal?.addEventListener('abort', () => {
            if (entry.closed) return
            entry.closed = true
            log('net', 'abort', id)
            controller.error(init.signal?.reason)
          })
        },
        cancel() {
          const entry = streams.get(id)
          if (entry) entry.closed = true
          log('net', 'cancel', id)
        },
      })
    } else if (!nullBody && spec.hex !== undefined)
      payload = new Uint8Array(Buffer.from(spec.hex, 'hex'))
    else if (!nullBody && spec.body !== undefined) payload = spec.body
    const response = new Response(payload, {
      status,
      statusText: spec.statusText ?? '',
      headers: spec.headers ?? {},
    })
    if (spec.url !== undefined) Object.defineProperty(response, 'url', { value: spec.url })
    if (spec.redirected) Object.defineProperty(response, 'redirected', { value: true })
    if (spec.opaque) {
      Object.defineProperties(response, {
        type: { value: 'opaqueredirect' },
        status: { value: 0 },
        ok: { value: false },
      })
    }
    return response
  }
  const table = { ...(cfg.resolve ?? {}) }
  world.table = table
  world.resolver = async (host) => {
    log('net', 'resolve', host)
    const found = table[host]
    if (!found) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
    return found
  }

  // the person's OAuth values
  let held = cfg.oauth ?? null
  let writes = 0
  world.access = {
    read: () => (held ? { ...held } : null),
    writeTokens: async (tokens) => {
      const index = writes++
      log('store', 'writeTokens', tokens)
      if (cfg.failWrite?.includes(index)) throw new Error('disk full')
      held = { clientId: held?.clientId ?? '', clientSecret: held?.clientSecret ?? '', tokens }
    },
  }
  world.openExternal = async (url) => {
    log('browser', 'open', url)
    if (world.openFails) throw new Error('no browser')
    return undefined
  }

  try {
    return await body(world)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    ;(AbortSignal as unknown as { timeout: unknown }).timeout = realTimeout
    cryptoObject.randomBytes = realRandomBytes
    if (realGetRandomValues)
      Object.defineProperty(webCrypto, 'getRandomValues', realGetRandomValues)
    else delete (webCrypto as { getRandomValues?: unknown }).getRandomValues
    ;(http as unknown as { createServer: unknown }).createServer = realCreateServer
    syncBuiltinESMExports()
  }
}

const bytesOf = (text: string | { hex: string }): Buffer =>
  typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text.hex, 'hex')

interface Step {
  op: string
  [key: string]: unknown
}

/** the steps every runner shares: timers, streams, the clock, the loopback server */
function commonStep(world: World, step: Step): boolean {
  switch (step.op) {
    case 'timer':
      world.fire((step.n as number | undefined) ?? 1)
      return true
    case 'now':
      world.clock = step.ms as number
      return true
    case 'loopback':
      world.request(
        (step.method as string | undefined) ?? 'GET',
        step.target as string,
        step.server as number | undefined,
        step.force === true,
      )
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// oauth-loopback.ts
// ---------------------------------------------------------------------------

interface LoopbackCase {
  state: string
  timeoutMs: number
  aborted?: boolean
  listenFails?: boolean
  steps: Step[]
}

async function runLoopback(cfg: LoopbackCase): Promise<unknown> {
  return withWorld({ listenFails: cfg.listenFails === true }, async (world) => {
    const out: Out[] = []
    const controller = new AbortController()
    if (cfg.aborted) controller.abort()
    let receiver: loopback.LoopbackReceiver | undefined
    for (const step of cfg.steps) {
      if (commonStep(world, step)) {
        // handled
      } else if (step.op === 'start') {
        try {
          const started = await loopback.startLoopbackReceiver({
            state: cfg.state,
            pages: PAGES,
            timeoutMs: cfg.timeoutMs,
            signal: controller.signal,
          })
          receiver = started
          world.log('events', 'started', started.redirectUri)
          void started.outcome.then((outcome) => world.log('events', 'outcome', outcome))
        } catch (error) {
          world.log('events', 'startError', (error as Error).message)
        }
      } else if (step.op === 'abort') {
        controller.abort()
      } else if (step.op === 'close') {
        receiver?.close()
      } else throw new Error(`no such step: ${step.op}`)
      await world.settle()
      out.push(world.flush())
    }
    return plain(out)
  })
}

const callback = (state: string, extra = ''): string => `/callback?state=${state}${extra}`

const loopbackCases: unknown[] = [
  {
    // a request that is still on a connection of the closed server (`force`) meets the settled receiver
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'loopback', target: callback('abc', '&code=ok') },
      { op: 'loopback', force: true, target: callback('abc', '&code=again') },
      { op: 'loopback', force: true, target: callback('abc') },
    ],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [{ op: 'start' }, { op: 'loopback', target: callback('abcd', '&code=x') }],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [{ op: 'start' }, { op: 'loopback', target: callback('abc', '&code=the-code') }],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'loopback', target: '/favicon.ico' },
      { op: 'loopback', method: 'POST', target: callback('abc', '&code=x') },
      { op: 'loopback', target: callback('wrong', '&code=x') },
      { op: 'loopback', target: '/callback?code=x' },
      { op: 'loopback', target: '/callback/?state=abc&code=x' },
      { op: 'loopback', target: callback('abc', '&code=ok') },
      { op: 'loopback', target: callback('abc', '&code=again') },
    ],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [{ op: 'start' }, { op: 'loopback', target: callback('abc', '&error=access_denied') }],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [{ op: 'start' }, { op: 'loopback', target: callback('abc', '&code=') }],
  },
  {
    state: 's t&te',
    timeoutMs: 600000,
    steps: [{ op: 'start' }, { op: 'loopback', target: '/callback?state=s+t%26te&code=a%20b%2Bc' }],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'loopback', target: 'http://other.example/callback?state=abc&code=abs' },
    ],
  },
  {
    state: 'abc',
    timeoutMs: 1500,
    steps: [
      { op: 'start' },
      { op: 'timer', n: 1 },
      { op: 'loopback', target: callback('abc', '&code=late') },
    ],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'abort' },
      { op: 'loopback', target: callback('abc', '&code=late') },
    ],
  },
  { state: 'abc', timeoutMs: 600000, aborted: true, steps: [{ op: 'start' }] },
  { state: 'abc', timeoutMs: 600000, steps: [{ op: 'start' }, { op: 'close' }, { op: 'close' }] },
  { state: 'abc', timeoutMs: 600000, listenFails: true, steps: [{ op: 'start' }] },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'loopback', target: callback('abc', '&code=1') },
      { op: 'close' },
      { op: 'timer', n: 1 },
    ],
  },
  {
    state: 'abc',
    timeoutMs: 600000,
    steps: [
      { op: 'start' },
      { op: 'start' },
      { op: 'loopback', server: 0, target: callback('abc', '&code=first') },
      { op: 'loopback', server: 1, target: callback('abc', '&code=second') },
    ],
  },
]

const loopbackSpec: FnSpec = {
  ts: ([cfg]) => runLoopback(cfg as LoopbackCase),
  cases: cases(...loopbackCases.map((c) => [c])),
}

// ---------------------------------------------------------------------------
// fixtures: an MCP server, its authorization server, the stored sign-in
// ---------------------------------------------------------------------------

const SRV = 'https://mcp.example/mcp'
const INIT = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'srv', version: '1.0.0' },
  instructions: 'use me',
}
const rpc = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: number, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})
const json = (value: unknown, status = 200, headers: Record<string, string> = {}): FetchSpec => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})
const sse = (messages: unknown[], headers: Record<string, string> = {}): FetchSpec => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream', ...headers },
  body: messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''),
})
const SESSION = { 'mcp-session-id': 's1' }
const initPost = (): FetchSpec => json(rpc(0, INIT), 200, SESSION)
const accepted: FetchSpec = { status: 202 }
const noStream: FetchSpec = { status: 405, statusText: 'Method Not Allowed' }
/** initialize, initialized, the GET stream the server does not offer */
const CONNECT: FetchSpec[] = [initPost(), accepted, noStream]
const TOOL = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }

const AS = 'https://as.example'
const META = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  revocation_endpoint: `${AS}/revoke`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
}
const RESOURCE = {
  resource: SRV,
  authorization_servers: [AS],
  scopes_supported: ['read', 'write'],
}
const CLIENT = { client_id: 'cid-registered', redirect_uris: ['http://127.0.0.1:40001/callback'] }
const TOKENS = {
  access_token: 'at-1',
  token_type: 'Bearer',
  refresh_token: 'rt-1',
  expires_in: 3600,
}
const challenge = (extra = ''): FetchSpec => ({
  status: 401,
  statusText: 'Unauthorized',
  headers: {
    'www-authenticate': `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"${extra}`,
  },
  body: 'no',
})

/** a stored sign-in as `oauth.tokens` keeps it */
function stored(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    tokens: { access_token: 'at-old', token_type: 'Bearer', refresh_token: 'rt-old' },
    expiresAt: null,
    authorizationServerUrl: AS,
    metadata: META,
    resource: SRV,
    registeredClient: { client_id: 'cid-registered' },
    ...extra,
  }
}
const heldOf = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  clientId: '',
  clientSecret: '',
  tokens: JSON.stringify(value),
  ...extra,
})

// ---------------------------------------------------------------------------
// oauth.ts: what is kept, the fetch, refresh and revoke
// ---------------------------------------------------------------------------

const parseSpec: FnSpec = {
  ts: ([text]) => oauth.parseStoredOAuth(text as string),
  cases: cases(
    [JSON.stringify(stored())],
    [JSON.stringify(stored({ expiresAt: 1234, registeredClient: null, resource: null }))],
    [JSON.stringify(stored({ registeredClient: { nope: 1 } }))],
    [JSON.stringify(stored({ expiresAt: '5' }))],
    [JSON.stringify(stored({ v: 2 }))],
    [JSON.stringify(stored({ tokens: { refresh_token: 'x' } }))],
    [JSON.stringify(stored({ tokens: [] }))],
    [JSON.stringify(stored({ authorizationServerUrl: 5 }))],
    [JSON.stringify(stored({ metadata: { issuer: 'x' } }))],
    [JSON.stringify(stored({ metadata: null }))],
    [''],
    ['not json'],
    ['[]'],
    ['null'],
    [JSON.stringify({ ...stored(), extra: { a: 1 } })],
    [
      '{"v":1,"tokens":{"access_token":"a","n":1e999},"authorizationServerUrl":"u","metadata":{"token_endpoint":"t"},"expiresAt":1e999}',
    ],
  ),
}

const serializeSpec: FnSpec = {
  ts: ([value]) => oauth.serializeStoredOAuth(value as oauth.StoredOAuth),
  cases: cases(
    [stored()],
    [stored({ expiresAt: 99, registeredClient: null, resource: null })],
    [{ ...stored(), tokens: { access_token: 'é\u2028"' } }],
    [stored({ expiresAt: 1e21 })],
  ),
}

const expiredSpec: FnSpec = {
  ts: ([value, now]) => oauth.accessTokenExpired(value as oauth.StoredOAuth, now as number),
  cases: [
    [stored(), 5],
    [stored({ expiresAt: 100_000 }), 39_999],
    [stored({ expiresAt: 100_000 }), 40_000],
    [stored({ expiresAt: 100_000 }), 40_001],
    [stored({ expiresAt: 0 }), 0],
    [stored({ expiresAt: 100_000 }), 200_000],
  ].map((args): Case => ({ args })),
}

interface AuthFetchCase extends WorldCfg {
  steps: Array<{ url: string; init?: Record<string, unknown> }>
}

const authFetchSpec: FnSpec = {
  ts: ([cfg]) =>
    withWorld(cfg as AuthFetchCase, async (world) => {
      const c = cfg as AuthFetchCase
      const af = oauth.authFetch(world.fetch, world.resolver)
      const out: Out[] = []
      for (const step of c.steps) {
        try {
          const response = await af(step.url, step.init as RequestInit | undefined)
          world.log('events', 'response', response.status)
        } catch (error) {
          const e = error as Error
          world.log('events', 'error', e.name, e.message)
        }
        await world.settle()
        out.push(world.flush())
      }
      return plain(out)
    }),
  cases: cases(
    [
      {
        fetches: [{ status: 200, body: 'ok' }],
        steps: [
          {
            url: 'https://as.example/token',
            init: {
              method: 'POST',
              body: 'a=b',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            },
          },
        ],
      },
    ],
    [
      {
        fetches: [{ status: 200 }],
        steps: [
          { url: 'http://8.8.8.8/x' },
          { url: 'http://10.0.0.5/x' },
          { url: 'ftp://as.example/x' },
        ],
      },
    ],
    [
      {
        resolve: { 'intranet.lan': ['192.168.1.10'], 'mixed.lan': ['192.168.1.10', '8.8.8.8'] },
        fetches: [{ status: 200 }],
        steps: [
          { url: 'http://intranet.lan/x' },
          { url: 'http://mixed.lan/x' },
          { url: 'http://gone.lan/x' },
        ],
      },
    ],
    [
      {
        fetches: [
          { status: 302, headers: { location: 'https://evil.example/' } },
          { limit: true },
          { reject: { typeError: true, message: 'fetch failed' } },
        ],
        steps: [
          { url: 'https://as.example/a' },
          { url: 'https://as.example/b', init: { signal: undefined } },
          { url: 'https://as.example/c' },
        ],
      },
    ],
    [
      {
        fetches: [{ status: 200 }],
        steps: [{ url: 'not a url' }, { url: 'https://as.example/a#frag' }],
      },
    ],
  ),
}

interface RefreshCase extends WorldCfg {
  stored: Record<string, unknown>
  config?: { clientId: string; clientSecret: string; tokens: string } | null
}

const refreshSpec: FnSpec = {
  ts: ([cfg]) =>
    withWorld(cfg as RefreshCase, async (world) => {
      const c = cfg as RefreshCase
      const result = await oauth.refreshStoredOAuth(
        c.stored as unknown as oauth.StoredOAuth,
        (c.config ?? null) as never,
        world.fetch as never,
        () => world.clock,
      )
      return { result: plain(result), ...(plain({ out: world.flush() }) as object) }
    }),
  cases: cases(
    [
      {
        stored: stored(),
        fetches: [json({ access_token: 'at-2', token_type: 'Bearer', expires_in: 60 })],
      },
    ],
    [
      {
        stored: stored(),
        fetches: [json({ access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-2' })],
        now: 5,
      },
    ],
    [
      {
        stored: stored({ registeredClient: null }),
        config: { clientId: 'mine', clientSecret: 'sec', tokens: '' },
        fetches: [json({ access_token: 'at-2', token_type: 'Bearer', expires_in: 10 })],
      },
    ],
    [
      {
        stored: stored({ registeredClient: null }),
        config: { clientId: 'mine', clientSecret: '', tokens: '' },
        fetches: [json({ access_token: 'at-2', token_type: 'Bearer' })],
      },
    ],
    [{ stored: stored({ registeredClient: null }), config: null }],
    [
      {
        stored: stored({ registeredClient: null }),
        config: { clientId: '', clientSecret: 's', tokens: '' },
      },
    ],
    [{ stored: stored({ tokens: { access_token: 'a' } }) }],
    [{ stored: stored({ tokens: { access_token: 'a', refresh_token: '' } }) }],
    [
      {
        stored: stored({ resource: null }),
        fetches: [json({ access_token: 'at-2', token_type: 'Bearer' })],
      },
    ],
    [{ stored: stored({ resource: 'not a url' }) }],
    [
      {
        stored: stored(),
        fetches: [json({ error: 'invalid_grant', error_description: 'expired' }, 400)],
      },
    ],
    [{ stored: stored(), fetches: [json({ error: 'invalid_client' }, 401)] }],
    [{ stored: stored(), fetches: [json({ error: 'unauthorized_client' }, 400)] }],
    [{ stored: stored(), fetches: [json({ error: 'invalid_request' }, 400)] }],
    [{ stored: stored(), fetches: [{ status: 500, body: 'oops' }] }],
    [{ stored: stored(), fetches: [{ reject: { typeError: true, message: 'fetch failed' } }] }],
    [{ stored: stored(), fetches: [json({ nope: true })] }],
  ),
}

interface RevokeCase extends WorldCfg {
  stored: Record<string, unknown>
  config?: { clientId: string; clientSecret: string; tokens: string } | null
}

const revokeSpec: FnSpec = {
  ts: ([cfg]) =>
    withWorld(cfg as RevokeCase, async (world) => {
      const c = cfg as RevokeCase
      const result = await oauth.revokeStoredOAuth(
        c.stored as unknown as oauth.StoredOAuth,
        (c.config ?? null) as never,
        world.fetch as never,
      )
      await world.settle()
      return { result, out: plain(world.flush()) }
    }),
  cases: cases(
    [{ stored: stored(), fetches: [{ status: 200 }] }],
    [{ stored: stored({ tokens: { access_token: 'only-access' } }), fetches: [{ status: 200 }] }],
    [
      {
        stored: stored({ tokens: { access_token: 'a b&c', refresh_token: '' } }),
        fetches: [{ status: 200 }],
      },
    ],
    [
      {
        stored: stored({ registeredClient: { client_id: 'cid', client_secret: 's e+c' } }),
        fetches: [{ status: 200 }],
      },
    ],
    [
      {
        stored: stored({ registeredClient: null }),
        config: { clientId: 'mine', clientSecret: 'sec', tokens: '' },
        fetches: [{ status: 200 }],
      },
    ],
    [{ stored: stored({ registeredClient: null }), config: null, fetches: [{ status: 200 }] }],
    [{ stored: stored({ metadata: { ...META, revocation_endpoint: undefined } }) }],
    [{ stored: stored({ metadata: { ...META, revocation_endpoint: '' } }) }],
    [{ stored: stored({ metadata: { ...META, revocation_endpoint: 5 } }) }],
    [{ stored: stored(), fetches: [{ status: 400 }] }],
    [{ stored: stored(), fetches: [{ reject: { typeError: true, message: 'fetch failed' } }] }],
    [{ stored: stored({ metadata: { ...META, revocation_endpoint: 'not a url' } }) }],
    [
      {
        stored: stored({ tokens: { access_token: 'a', refresh_token: null } }),
        fetches: [{ status: 200, stream: true }],
      },
    ],
  ),
}

// ---------------------------------------------------------------------------
// oauth.ts: signInToServer
// ---------------------------------------------------------------------------

interface SignInCase extends WorldCfg {
  serverUrl?: string
  resourceMetadataUrl?: string
  scope?: string
  config?: { clientId: string; clientSecret: string; tokens: string } | null
  clientName?: string
  timeoutMs?: number
  aborted?: boolean
  openFails?: boolean
  steps: Step[]
}

async function runSignIn(cfg: SignInCase): Promise<unknown> {
  return withWorld(cfg, async (world) => {
    const out: Out[] = []
    const controller = new AbortController()
    if (cfg.aborted) controller.abort()
    world.openFails = cfg.openFails === true
    for (const step of cfg.steps) {
      if (commonStep(world, step)) {
        // handled
      } else if (step.op === 'start') {
        const context = {
          serverUrl: cfg.serverUrl ?? SRV,
          resourceMetadataUrl: cfg.resourceMetadataUrl
            ? new URL(cfg.resourceMetadataUrl)
            : undefined,
          scope: cfg.scope,
          config: cfg.config ?? null,
          clientName: cfg.clientName ?? 'SeuOffice',
          openExternal: world.openExternal,
          pages: PAGES,
          signal: controller.signal,
          timeoutMs: cfg.timeoutMs,
          fetch: oauth.authFetch(world.fetch, world.resolver),
          resolve: world.resolver,
          now: () => world.clock,
        }
        oauth.signInToServer(context as never).then(
          (result) => world.log('events', 'signIn', plain(result)),
          (error: unknown) => world.log('events', 'signIn', { threw: String(error) }),
        )
      } else if (step.op === 'abort') {
        controller.abort()
      } else throw new Error(`no such step: ${step.op}`)
      await world.settle()
      out.push(world.flush())
    }
    return plain(out)
  })
}

/** the fetches of a sign-in that goes through: discovery, registration, the token exchange */
const SIGN_IN_OK: FetchSpec[] = [json(RESOURCE), json(META), json(CLIENT), json(TOKENS)]
const CODE = { op: 'loopback', target: '/callback?state=__STATE__&code=the-code' }

/** the state the fixed walk makes: base64url of the first 24 bytes */
const STATE = (() => {
  let s = 1
  const bytes = Buffer.alloc(24)
  for (let i = 0; i < 24; i++) {
    s = (s * 73 + 41) % 256
    bytes[i] = s
  }
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
})()
const back = (extra: string): Step => ({
  op: 'loopback',
  target: `/callback?state=${STATE}${extra}`,
})
const START: Step = { op: 'start' }

const signInCases: SignInCase[] = [
  { fetches: SIGN_IN_OK, steps: [START, back('&code=the-code')] },
  {
    fetches: [json(RESOURCE), json(META), json({ ...TOKENS, expires_in: undefined })],
    config: { clientId: 'mine', clientSecret: 'sec', tokens: '' },
    scope: 'files',
    now: 5000,
    steps: [START, back('&code=the-code')],
  },
  {
    fetches: [{ status: 404 }, { status: 404 }, json(META), json(CLIENT), json(TOKENS)],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource/mcp',
    steps: [START, back('&code=c')],
  },
  {
    fetches: [json(RESOURCE), json({ ...META, code_challenge_methods_supported: ['plain'] })],
    steps: [START],
  },
  {
    fetches: [json(RESOURCE), json({ ...META, code_challenge_methods_supported: undefined })],
    steps: [START],
  },
  {
    fetches: [json(RESOURCE), json({ ...META, response_types_supported: ['token'] })],
    steps: [START],
  },
  {
    fetches: [json({ ...RESOURCE, resource: 'https://other.example/mcp' }), json(META)],
    steps: [START],
  },
  {
    fetches: [
      json(RESOURCE),
      json({ ...META, authorization_endpoint: 'http://8.8.8.8/authorize' }),
    ],
    steps: [START],
  },
  {
    fetches: [
      json(RESOURCE),
      json({ ...META, authorization_endpoint: 'http://gone.lan/authorize' }),
    ],
    steps: [START],
  },
  { fetches: [{ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 }], steps: [START] },
  {
    fetches: [
      { reject: { typeError: true, message: 'fetch failed' } },
      { reject: { typeError: true, message: 'fetch failed' } },
      { reject: { typeError: true, message: 'x' } },
      { reject: { typeError: true, message: 'x' } },
    ],
    steps: [START],
  },
  { serverUrl: 'http://8.8.8.8/mcp', fetches: [json(RESOURCE), json(META)], steps: [START] },
  {
    fetches: [json(RESOURCE), json({ ...META, registration_endpoint: undefined })],
    steps: [START],
  },
  {
    fetches: [
      json(RESOURCE),
      json(META),
      json({ error: 'invalid_client_metadata', error_description: 'no' }, 400),
    ],
    steps: [START],
  },
  { fetches: [json(RESOURCE), json(META), { status: 500 }], steps: [START] },
  { fetches: [json(RESOURCE), json(META), json(CLIENT)], openFails: true, steps: [START] },
  { fetches: [json(RESOURCE), json(META), json(CLIENT)], listenFails: true, steps: [START] },
  {
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [START, back('&error=access_denied')],
  },
  { fetches: [json(RESOURCE), json(META), json(CLIENT)], steps: [START, { op: 'abort' }] },
  { fetches: [json(RESOURCE), json(META), json(CLIENT)], aborted: true, steps: [START] },
  {
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    timeoutMs: 2000,
    steps: [START, { op: 'timer', n: 1 }],
  },
  {
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [
      START,
      { op: 'loopback', target: '/callback?state=wrong&code=x' },
      { op: 'timer', n: 1 },
    ],
  },
  {
    fetches: [
      ...SIGN_IN_OK.slice(0, 3),
      json({ error: 'invalid_grant', error_description: 'bad code' }, 400),
    ],
    steps: [START, back('&code=bad')],
  },
  { fetches: [...SIGN_IN_OK.slice(0, 3), { status: 502 }], steps: [START, back('&code=c')] },
  {
    fetches: [...SIGN_IN_OK.slice(0, 3), { reject: { typeError: true, message: 'down' } }],
    steps: [START, back('&code=c')],
  },
  { fetches: [...SIGN_IN_OK.slice(0, 3), json({ nope: 1 })], steps: [START, back('&code=c')] },
  {
    fetches: [
      ...SIGN_IN_OK.slice(0, 3),
      json({ access_token: 'a', token_type: 'Bearer', expires_in: 'soon' }),
    ],
    steps: [START, back('&code=c')],
  },
  { fetches: [json(RESOURCE), json(META), { limit: true }], steps: [START] },
  {
    fetches: [json({ ...RESOURCE, scopes_supported: [] }), json(META), json(CLIENT), json(TOKENS)],
    steps: [START, back('&code=c')],
  },
  {
    fetches: [
      json({ resource: SRV }),
      json({ ...META, scopes_supported: ['a'] }),
      json(CLIENT),
      json(TOKENS),
    ],
    steps: [START, back('&code=c')],
  },
  {
    fetches: [{ status: 404 }, json(META), json(CLIENT), json(TOKENS)],
    steps: [START, back('&code=c')],
  },
  {
    fetches: [json(RESOURCE), json(META)],
    config: { clientId: 'mine', clientSecret: '', tokens: '' },
    steps: [START, { op: 'abort' }, { op: 'timer', n: 1 }],
  },
  { fetches: SIGN_IN_OK, seed: 7, steps: [START, back('&code=c')] },
]

// the state of a walk that starts at another seed is not STATE: those cases send what the walk makes
signInCases.splice(signInCases.length - 1, 1, {
  fetches: SIGN_IN_OK,
  seed: 7,
  steps: [START, { op: 'loopback', target: '/callback?state=wrong&code=c' }],
})

const signInSpec: FnSpec = {
  ts: ([cfg]) => runSignIn(cfg as SignInCase),
  cases: signInCases.map((c): Case => ({ args: [c] })),
}

// ---------------------------------------------------------------------------
// oauth.ts: storeOAuthAccess over a real store
// ---------------------------------------------------------------------------

const FILE_SERVER = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `srv-${id}`,
  kind: 'remote',
  url: 'https://example.com/mcp',
  headers: {},
  ...extra,
})
const storeFile = (...servers: unknown[]): string => JSON.stringify({ version: 1, servers })

const noSeal: McpSecretCodec = {
  canSeal: () => false,
  seal: () => {
    throw new Error('cannot seal')
  },
  open: () => null,
}

const storeAccessSpec: FnSpec = {
  ts: async ([file, steps]) => {
    const mcp = store.createMcpServersStore(file as string, noSeal)
    const out: unknown[] = []
    for (const step of steps as Step[]) {
      const access = oauth.storeOAuthAccess(mcp, step.id as string)
      if (step.op === 'load') {
        await mcp.load()
        out.push('loaded')
      } else if (step.op === 'read') out.push(plain(access.read()))
      else if (step.op === 'write') {
        await access.writeTokens(step.tokens as string)
        out.push('written')
      } else if (step.op === 'file') {
        out.push(existsSync(file as string) ? readFileSync(file as string, 'utf8') : null)
      } else throw new Error(`no such step: ${step.op}`)
    }
    return out
  },
  cases: [
    {
      args: [
        '$DIR/mcp-servers.json',
        [
          { op: 'load' },
          { op: 'read', id: 'a' },
          { op: 'write', id: 'a', tokens: 'T1' },
          { op: 'read', id: 'a' },
          { op: 'write', id: 'a', tokens: '' },
          { op: 'read', id: 'a' },
          { op: 'file' },
        ],
      ],
      files: { 'mcp-servers.json': storeFile(FILE_SERVER('a')) },
    },
    {
      args: [
        '$DIR/mcp-servers.json',
        [
          { op: 'load' },
          { op: 'read', id: 'b' },
          { op: 'write', id: 'b', tokens: 'NEW' },
          { op: 'read', id: 'b' },
          { op: 'write', id: 'nobody', tokens: 'X' },
          { op: 'read', id: 'nobody' },
          { op: 'file' },
        ],
      ],
      files: {
        'mcp-servers.json': storeFile(
          FILE_SERVER('b', { oauth: { clientId: 'cid', clientSecret: 'sec', tokens: 'OLD' } }),
        ),
      },
    },
    {
      args: [
        '$DIR/mcp-servers.json',
        [
          { op: 'load' },
          { op: 'write', id: 'c', tokens: '' },
          { op: 'read', id: 'c' },
          { op: 'file' },
        ],
      ],
      files: { 'mcp-servers.json': storeFile(FILE_SERVER('c')) },
    },
  ],
}

// ---------------------------------------------------------------------------
// remote.ts
// ---------------------------------------------------------------------------

interface RemoteCase extends WorldCfg {
  server: { name: string; url: string; transport?: string; headers?: Record<string, string> }
  clientInfo?: { name?: string; version: string }
  callTimeoutMs?: number
  steps: Step[]
}

const errorOf = (error: unknown): Record<string, unknown> =>
  error instanceof remote.RemoteMcpError
    ? { remote: error.reason, message: error.message }
    : { failed: String(error) }

async function runRemote(cfg: RemoteCase): Promise<unknown> {
  return withWorld(cfg, async (world) => {
    const out: Out[] = []
    const conn = remote.createRemoteMcpConnection({
      server: {
        name: cfg.server.name,
        url: cfg.server.url,
        transport: (cfg.server.transport ?? 'auto') as never,
        headers: cfg.server.headers ?? {},
      },
      oauth: world.access,
      clientInfo: (cfg.clientInfo ?? { version: '1.0.0' }) as never,
      fetch: world.fetch,
      resolve: world.resolver,
      ...(cfg.callTimeoutMs === undefined ? {} : { callTimeoutMs: cfg.callTimeoutMs }),
      now: () => world.clock,
    })
    const controllers = new Map<string, AbortController>()
    const signalOf = (step: Step): AbortSignal | undefined => {
      if (typeof step.signal !== 'string') return undefined
      let controller = controllers.get(step.signal)
      if (!controller) {
        controller = new AbortController()
        controllers.set(step.signal, controller)
        if (step.aborted === true) controller.abort()
      }
      return controller.signal
    }
    const unsubscribers = new Map<string, () => void>()
    const track = (id: string, promise: Promise<unknown>): void => {
      promise.then(
        (value) => world.log('events', 'settle', id, 'ok', plain(value)),
        (error: unknown) => world.log('events', 'settle', id, 'error', errorOf(error)),
      )
    }
    for (const step of cfg.steps) {
      if (commonStep(world, step)) {
        // handled
      } else {
        const id = (step.id as string | undefined) ?? step.op
        switch (step.op) {
          case 'connect':
            track(id, conn.connect(signalOf(step)))
            break
          case 'list':
            track(id, conn.listTools(signalOf(step)))
            break
          case 'call':
            track(
              id,
              conn.callTool(
                step.name as string,
                (step.args ?? {}) as Record<string, unknown>,
                signalOf(step),
              ),
            )
            break
          case 'signIn':
            world.openFails = step.openFails === true
            track(
              id,
              conn.signIn({
                openExternal: world.openExternal,
                pages: PAGES,
                signal: signalOf(step),
                timeoutMs: step.timeoutMs as number | undefined,
              }),
            )
            break
          case 'revoke':
            track(id, conn.revoke())
            break
          case 'close':
            track(id, conn.close())
            break
          case 'needs':
            world.log('events', 'needsSignIn', conn.needsSignIn())
            break
          case 'subscribe':
            unsubscribers.set(
              step.name as string,
              conn.onToolsChanged(() => world.log('events', 'toolsChanged', step.name)),
            )
            break
          case 'unsubscribe':
            unsubscribers.get(step.name as string)?.()
            break
          case 'abort':
            controllers.get(step.signal as string)?.abort()
            break
          case 'resolve': {
            for (const key of Object.keys(world.table)) delete world.table[key]
            Object.assign(world.table, step.table as Record<string, string[]>)
            break
          }
          case 'chunk': {
            const entry = world.stream((step.stream as number | undefined) ?? 1)
            if (entry && !entry.closed)
              entry.controller.enqueue(new Uint8Array(bytesOf((step.text as string) ?? '')))
            break
          }
          case 'end': {
            const entry = world.stream((step.stream as number | undefined) ?? 1)
            if (entry && !entry.closed) {
              entry.closed = true
              entry.controller.close()
            }
            break
          }
          case 'streamError': {
            const entry = world.stream((step.stream as number | undefined) ?? 1)
            if (entry && !entry.closed) {
              entry.closed = true
              entry.controller.error(
                Object.assign(new Error(step.text as string), {
                  name: (step.name as string | undefined) ?? 'Error',
                }),
              )
            }
            break
          }
          default:
            throw new Error(`no such step: ${step.op}`)
        }
      }
      await world.settle()
      out.push(world.flush())
    }
    return plain(out)
  })
}

const server = (extra: Record<string, unknown> = {}) => ({ name: 'web', url: SRV, ...extra })
const POST_LIST = (id: number, tools: unknown[], nextCursor?: string) =>
  json(rpc(id, nextCursor === undefined ? { tools } : { tools, nextCursor }))
const call = (id: string, name = 'echo', args: Record<string, unknown> = {}): Step => ({
  op: 'call',
  id,
  name,
  args,
})
const connect: Step = { op: 'connect', id: 'c' }
const listStep: Step = { op: 'list', id: 'l' }

/** the SSE transport's first steps: the stream opens, then the endpoint arrives */
const ENDPOINT = { op: 'chunk', stream: 1, text: 'event: endpoint\ndata: /messages?sid=1\n\n' }
const streamMessage = (message: unknown): Step => ({
  op: 'chunk',
  stream: 1,
  text: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
})
const SSE_OPEN: FetchSpec = {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  stream: true,
}

const remoteCases: RemoteCase[] = [
  // plain connect, answers as JSON and as SSE
  { server: server(), fetches: CONNECT, steps: [connect, { op: 'needs' }] },
  {
    server: server(),
    fetches: [
      ...CONNECT,
      POST_LIST(1, [TOOL]),
      json(rpc(2, { content: [{ type: 'text', text: 'hi' }] })),
    ],
    steps: [connect, listStep, call('k', 'echo', { text: 'hi' })],
  },
  {
    server: server(),
    fetches: [
      sse([rpc(0, INIT)], SESSION),
      accepted,
      noStream,
      sse([rpc(1, { tools: [TOOL] })]),
      sse([rpc(2, { content: [{ type: 'text', text: 'streamed' }], isError: true })]),
    ],
    steps: [listStep, call('k')],
  },
  {
    server: server({
      headers: {
        'X-Key': 'k1',
        'Content-Type': 'text/plain',
        Accept: 'x',
        'MCP-Session-Id': 'evil',
        'X-Other': 'v',
      },
    }),
    fetches: [...CONNECT, POST_LIST(1, [])],
    steps: [listStep],
  },
  { server: server({ headers: { 'Bad Name': 'x' } }), fetches: CONNECT, steps: [connect] },
  { server: server({ headers: { 'X-Bad': 'line\nbreak' } }), fetches: CONNECT, steps: [connect] },
  {
    server: server({ headers: { 'X-Wide': 'caf\u00e9 \u20ac' } }),
    fetches: CONNECT,
    steps: [connect],
  },
  { server: server({ headers: { 'X-Latin': 'caf\u00e9' } }), fetches: CONNECT, steps: [connect] },
  { server: { name: 'web', url: 'not a url' }, steps: [] },
  {
    server: server(),
    clientInfo: { name: 'Mine', version: '9.9' },
    fetches: CONNECT,
    steps: [connect],
  },
  // fallback to SSE
  {
    server: server(),
    fetches: [
      { status: 405, statusText: 'Method Not Allowed', body: 'no' },
      SSE_OPEN,
      accepted,
      accepted,
    ],
    steps: [connect, ENDPOINT, streamMessage(rpc(0, INIT)), { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [{ status: 404, body: 'nf' }, SSE_OPEN, accepted, accepted, accepted],
    steps: [
      connect,
      ENDPOINT,
      streamMessage(rpc(0, INIT)),
      listStep,
      streamMessage(rpc(1, { tools: [TOOL] })),
    ],
  },
  {
    server: server(),
    fetches: [{ status: 200, headers: { 'content-type': 'text/html' }, body: '<html/>' }, SSE_OPEN],
    steps: [connect, ENDPOINT],
  },
  {
    server: server(),
    fetches: [
      { status: 404, body: 'nf' },
      { status: 404, body: 'nf' },
    ],
    steps: [connect],
  },
  { server: server(), fetches: [{ status: 500, body: 'boom' }], steps: [connect] },
  {
    server: server(),
    fetches: [{ reject: { typeError: true, message: 'fetch failed' } }],
    steps: [connect],
  },
  {
    server: server({ transport: 'sse' }),
    fetches: [SSE_OPEN, accepted, accepted],
    steps: [connect, ENDPOINT, streamMessage(rpc(0, INIT))],
  },
  {
    server: server({ transport: 'sse' }),
    fetches: [{ status: 404, body: 'nf' }],
    steps: [connect],
  },
  // redirects
  {
    server: server(),
    fetches: [{ status: 307, headers: { location: 'https://evil.example/mcp' } }],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [{ status: 302, headers: { location: 'http://mcp.example/mcp' }, body: 'moved' }],
    steps: [connect],
  },
  { server: server(), fetches: [{ status: 301 }], steps: [connect] },
  { server: server(), fetches: [{ opaque: true }], steps: [connect] },
  {
    server: server(),
    fetches: [{ status: 307, headers: { location: '/mcp2' } }, initPost(), accepted, noStream],
    steps: [connect],
  },
  {
    server: server(),
    fetches: [...CONNECT, { status: 307, headers: { location: 'https://evil.example/' } }],
    steps: [connect, listStep],
  },
  // address refusals
  { server: { name: 'web', url: 'http://203.0.113.5/mcp' }, steps: [connect] },
  { server: { name: 'web', url: 'ftp://mcp.example/mcp' }, steps: [connect] },
  {
    server: { name: 'web', url: 'http://public.example/mcp' },
    resolve: { 'public.example': ['8.8.8.8'] },
    steps: [connect],
  },
  { server: { name: 'web', url: 'http://gone.example/mcp' }, steps: [connect] },
  {
    server: { name: 'web', url: 'http://lan.example/mcp' },
    resolve: { 'lan.example': ['192.168.1.10'] },
    fetches: [initPost(), accepted, noStream],
    steps: [
      connect,
      { op: 'resolve', table: { 'lan.example': ['8.8.8.8'] } },
      listStep,
      { op: 'resolve', table: {} },
      listStep,
    ],
  },
  { server: { name: 'web', url: 'http://127.0.0.1:3000/mcp' }, fetches: CONNECT, steps: [connect] },
  {
    server: { name: 'web', url: 'http://localhost/mcp' },
    resolve: { localhost: ['127.0.0.1', '::1'] },
    fetches: CONNECT,
    steps: [connect],
  },
  // 401: without a token, with a refresh
  {
    server: server(),
    fetches: [challenge(', scope="read write"')],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [{ status: 401, body: 'no' }],
    steps: [connect, { op: 'needs' }, connect],
  },
  {
    server: server(),
    oauth: heldOf(
      stored({ expiresAt: null, tokens: { access_token: 'at-old', refresh_token: 'rt-old' } }),
    ),
    fetches: [...CONNECT, POST_LIST(1, [TOOL])],
    steps: [connect, listStep],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [
      challenge(),
      json({
        access_token: 'at-new',
        token_type: 'Bearer',
        refresh_token: 'rt-new',
        expires_in: 120,
      }),
      ...CONNECT,
    ],
    now: 10_000,
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [challenge(), json({ error: 'invalid_grant', error_description: 'revoked' }, 400)],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [challenge(), { status: 503, body: 'down' }],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [challenge(), { limit: true }],
    steps: [connect],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [challenge(), json({ access_token: 'at-new', token_type: 'Bearer' }), challenge()],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    failWrite: [0],
    fetches: [challenge(), json({ access_token: 'at-new', token_type: 'Bearer' })],
    steps: [connect],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    failWrite: [0],
    fetches: [challenge(), json({ error: 'invalid_grant' }, 400)],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored({ expiresAt: 100_000 })),
    now: 50_000,
    fetches: [
      json({ access_token: 'at-fresh', token_type: 'Bearer', expires_in: 3600 }),
      ...CONNECT,
      POST_LIST(1, []),
    ],
    steps: [{ op: 'now', ms: 90_000 }, connect, listStep],
  },
  {
    server: server(),
    oauth: heldOf(stored({ expiresAt: 100_000 })),
    now: 150_000,
    fetches: [json({ error: 'invalid_grant' }, 400)],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(stored({ expiresAt: 100_000, tokens: { access_token: 'a' } })),
    now: 150_000,
    fetches: [],
    steps: [connect, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: { clientId: '', clientSecret: '', tokens: 'not json' },
    fetches: [challenge()],
    steps: [connect],
  },
  {
    server: server({ headers: { Authorization: 'Bearer pasted' } }),
    oauth: heldOf(stored()),
    fetches: [challenge()],
    steps: [connect, { op: 'needs' }, { op: 'signIn', id: 's' }],
  },
  {
    server: server({ headers: { authorization: 'Basic abc' } }),
    fetches: [...CONNECT, POST_LIST(1, [])],
    steps: [listStep],
  },
  // listing
  {
    server: server(),
    fetches: [
      ...CONNECT,
      POST_LIST(
        1,
        [TOOL, { name: 'b', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
        'p2',
      ),
      POST_LIST(
        2,
        [{ name: 'c', description: '', inputSchema: { type: 'object', properties: {} } }],
        'p3',
      ),
      POST_LIST(3, []),
    ],
    steps: [listStep],
  },
  {
    server: server(),
    fetches: [
      ...CONNECT,
      POST_LIST(1, [TOOL], 'again'),
      POST_LIST(2, [{ name: 'b', inputSchema: { type: 'object' } }], 'again'),
    ],
    steps: [listStep],
  },
  {
    server: server(),
    fetches: [...CONNECT, POST_LIST(1, [TOOL], ''), POST_LIST(2, [])],
    steps: [listStep],
  },
  {
    server: server(),
    fetches: [...CONNECT, json(rpcError(1, -32601, 'no tools'))],
    steps: [listStep],
  },
  { server: server(), fetches: [...CONNECT, json(rpc(1, { nope: true }))], steps: [listStep] },
  {
    server: server(),
    fetches: [...CONNECT, { status: 500, body: 'oops' }],
    steps: [listStep, call('k')],
  },
  // calls
  {
    server: server(),
    fetches: [
      ...CONNECT,
      json(rpcError(1, -32602, 'bad args')),
      json(rpc(2, { content: [], isError: true })),
    ],
    steps: [connect, call('a'), call('b')],
  },
  {
    server: server(),
    callTimeoutMs: 5000,
    fetches: [
      ...CONNECT,
      { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true },
      accepted,
    ],
    steps: [connect, call('k'), { op: 'timer', n: 2 }],
  },
  {
    server: server(),
    fetches: [
      ...CONNECT,
      { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true },
      accepted,
    ],
    steps: [
      connect,
      call('k', 'echo', {}),
      { op: 'abort', signal: 'x' },
      { op: 'call', id: 'k2', name: 'echo', signal: 'x' },
      { op: 'abort', signal: 'x' },
    ],
  },
  {
    server: server(),
    fetches: [
      ...CONNECT,
      { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true },
      accepted,
    ],
    steps: [
      connect,
      { op: 'call', id: 'k', name: 'echo', signal: 'x' },
      { op: 'abort', signal: 'x' },
      { op: 'needs' },
    ],
  },
  {
    server: server(),
    fetches: [...CONNECT, accepted],
    steps: [connect, { op: 'call', id: 'k', name: 'echo', signal: 'x', aborted: true }],
  },
  {
    server: server(),
    fetches: CONNECT,
    steps: [{ op: 'connect', id: 'c', signal: 'x', aborted: true }, connect],
  },
  {
    server: server(),
    fetches: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true }],
    steps: [{ op: 'connect', id: 'c', signal: 'x' }, { op: 'abort', signal: 'x' }, { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: true }],
    callTimeoutMs: 3000,
    steps: [connect, { op: 'timer', n: 1 }],
  },
  {
    server: server(),
    fetches: [...CONNECT, { reject: { typeError: true, message: 'fetch failed' } }],
    steps: [connect, call('k')],
  },
  // two callers, one connection
  {
    server: server(),
    fetches: [...CONNECT, POST_LIST(1, [TOOL]), json(rpc(2, { content: [] }))],
    steps: [
      { op: 'connect', id: 'c1' },
      { op: 'list', id: 'l1' },
      { op: 'call', id: 'k1', name: 'echo' },
    ],
  },
  {
    server: server({ transport: 'sse' }),
    fetches: [SSE_OPEN, accepted, accepted, accepted],
    steps: [
      { op: 'connect', id: 'c1' },
      { op: 'list', id: 'l1', signal: 'a' },
      { op: 'list', id: 'l2', signal: 'b' },
      { op: 'abort', signal: 'a' },
      ENDPOINT,
      streamMessage(rpc(0, INIT)),
      streamMessage(rpc(1, { tools: [TOOL] })),
    ],
  },
  // close
  {
    server: server({ transport: 'sse' }),
    fetches: [SSE_OPEN, accepted, accepted],
    steps: [
      connect,
      { op: 'close', id: 'x' },
      ENDPOINT,
      streamMessage(rpc(0, INIT)),
      { op: 'needs' },
    ],
  },
  {
    server: server(),
    fetches: [...CONNECT, { status: 200 }],
    steps: [connect, { op: 'close', id: 'x' }, { op: 'close', id: 'y' }],
  },
  {
    server: server(),
    fetches: [...CONNECT, { status: 405 }, initPost(), accepted, noStream],
    steps: [connect, { op: 'close', id: 'x' }, { op: 'connect', id: 'c2' }],
  },
  {
    server: server(),
    fetches: [...CONNECT, { limit: true }],
    steps: [connect, { op: 'close', id: 'x' }],
  },
  {
    server: server(),
    fetches: [...CONNECT, { status: 500, body: 'no' }],
    steps: [connect, { op: 'close', id: 'x' }],
  },
  {
    server: server(),
    fetches: [...CONNECT, { reject: { typeError: true, message: 'gone' } }],
    steps: [connect, { op: 'close', id: 'x' }],
  },
  {
    server: server({ transport: 'sse' }),
    fetches: [SSE_OPEN, accepted, accepted],
    steps: [connect, ENDPOINT, streamMessage(rpc(0, INIT)), { op: 'close', id: 'x' }],
  },
  { server: server(), steps: [{ op: 'close', id: 'x' }] },
  // the server says its tools changed
  {
    server: server(),
    fetches: [initPost(), accepted, SSE_OPEN],
    steps: [
      { op: 'subscribe', name: 'a' },
      { op: 'subscribe', name: 'b' },
      connect,
      {
        op: 'chunk',
        stream: 1,
        text: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      },
      { op: 'unsubscribe', name: 'a' },
      {
        op: 'chunk',
        stream: 1,
        text: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      },
    ],
  },
  // sign-in through the connection
  {
    server: server(),
    fetches: [
      challenge(', scope="files"'),
      json(RESOURCE),
      json(META),
      json(CLIENT),
      json(TOKENS),
      ...CONNECT,
      POST_LIST(1, [TOOL]),
    ],
    steps: [
      connect,
      { op: 'needs' },
      { op: 'signIn', id: 's' },
      back('&code=the-code'),
      { op: 'needs' },
      connect,
      listStep,
    ],
  },
  {
    server: server(),
    fetches: [
      ...CONNECT,
      json(RESOURCE),
      json(META),
      json(CLIENT),
      json(TOKENS),
      initPost(),
      accepted,
      noStream,
    ],
    steps: [connect, { op: 'signIn', id: 's' }, back('&code=the-code'), connect],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [{ op: 'signIn', id: 's1' }, { op: 'signIn', id: 's2' }, { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [
      { op: 'signIn', id: 's', signal: 'x' },
      { op: 'abort', signal: 'x' },
    ],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [
      { op: 'signIn', id: 's' },
      { op: 'close', id: 'x' },
    ],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [
      { op: 'signIn', id: 's', timeoutMs: 1000 },
      { op: 'timer', n: 1 },
    ],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [{ op: 'signIn', id: 's' }, back('&error=access_denied')],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json({ ...META, code_challenge_methods_supported: [] })],
    steps: [{ op: 'signIn', id: 's' }],
  },
  {
    server: server(),
    fetches: [
      json(RESOURCE),
      json({ ...META, authorization_endpoint: 'http://8.8.8.8/authorize' }),
    ],
    steps: [{ op: 'signIn', id: 's' }],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json({ error: 'invalid_redirect_uri' }, 400)],
    steps: [{ op: 'signIn', id: 's' }],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json({ ...META, registration_endpoint: undefined })],
    steps: [{ op: 'signIn', id: 's' }],
  },
  {
    server: server(),
    oauth: { clientId: 'mine', clientSecret: 'sec', tokens: '' },
    fetches: [json(RESOURCE), json({ ...META, registration_endpoint: undefined }), json(TOKENS)],
    steps: [{ op: 'signIn', id: 's' }, back('&code=c')],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT), json({ error: 'invalid_grant' }, 400)],
    steps: [{ op: 'signIn', id: 's' }, back('&code=c')],
  },
  {
    server: server(),
    failWrite: [0],
    fetches: [json(RESOURCE), json(META), json(CLIENT), json(TOKENS)],
    steps: [{ op: 'signIn', id: 's' }, back('&code=c'), { op: 'needs' }],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    listenFails: true,
    steps: [{ op: 'signIn', id: 's' }],
  },
  {
    server: server(),
    fetches: [json(RESOURCE), json(META), json(CLIENT)],
    steps: [{ op: 'signIn', id: 's', openFails: true }],
  },
  {
    server: server(),
    fetches: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
    steps: [{ op: 'signIn', id: 's' }],
  },
  // revoke
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [{ status: 200 }],
    steps: [{ op: 'revoke', id: 'r' }, { op: 'needs' }],
  },
  {
    server: server(),
    oauth: heldOf(
      stored({
        tokens: { access_token: 'only' },
        metadata: { ...META, revocation_endpoint: undefined },
      }),
    ),
    steps: [{ op: 'revoke', id: 'r' }],
  },
  {
    server: server(),
    oauth: heldOf(stored(), { clientId: 'mine', clientSecret: 'sec' }),
    fetches: [{ status: 500 }],
    steps: [{ op: 'revoke', id: 'r' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    failWrite: [0],
    fetches: [{ reject: { typeError: true, message: 'down' } }],
    steps: [{ op: 'revoke', id: 'r' }],
  },
  { server: server(), steps: [{ op: 'revoke', id: 'r' }] },
  {
    server: server(),
    oauth: { clientId: 'x', clientSecret: '', tokens: '' },
    steps: [{ op: 'revoke', id: 'r' }],
  },
  {
    server: server(),
    oauth: heldOf(stored()),
    fetches: [...CONNECT, { status: 200 }, { status: 200 }],
    steps: [connect, { op: 'revoke', id: 'r' }],
  },
  {
    server: server(),
    oauth: { clientId: '', clientSecret: '', tokens: 'junk' },
    steps: [{ op: 'revoke', id: 'r' }],
  },
]

const remoteSpec: FnSpec = {
  ts: ([cfg]) => runRemote(cfg as RemoteCase),
  cases: remoteCases.map((c): Case => ({ args: [c] })),
}

const REASONS = [
  'unreachable',
  'http-error',
  'timeout',
  'aborted',
  'refused-redirect',
  'insecure-address',
  'login-required',
  'server-error',
]

const statusFailureSpec: FnSpec = {
  ts: ([reason]) => {
    const error =
      reason === 'plain'
        ? new Error('x')
        : new remote.RemoteMcpError('web', reason as remote.RemoteMcpErrorReason)
    return remote.statusFailureOf(error)
  },
  cases: [...REASONS, 'plain'].map((r): Case => ({ args: [r] })),
}

const remoteErrorSpec: FnSpec = {
  ts: ([name, reason]) => {
    const error = new remote.RemoteMcpError(name as string, reason as remote.RemoteMcpErrorReason)
    return {
      name: error.name,
      message: error.message,
      reason: error.reason,
      serverName: error.serverName,
    }
  },
  cases: cases(['web', 'unreachable'], ['', 'aborted'], ['a: b', 'login-required']),
}

export const group: Group = {
  'oauth-loopback.scenario': loopbackSpec,
  'oauth.parseStoredOAuth': parseSpec,
  'oauth.serializeStoredOAuth': serializeSpec,
  'oauth.accessTokenExpired': expiredSpec,
  'oauth.authFetch': authFetchSpec,
  'oauth.refreshStoredOAuth': refreshSpec,
  'oauth.revokeStoredOAuth': revokeSpec,
  'oauth.signIn': signInSpec,
  'oauth.storeOAuthAccess': storeAccessSpec,
  'oauth.MCP_SIGN_IN_TIMEOUT_MS': {
    ts: () => oauth.MCP_SIGN_IN_TIMEOUT_MS,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'remote.scenario': remoteSpec,
  'remote.statusFailureOf': statusFailureSpec,
  'remote.RemoteMcpError': remoteErrorSpec,
}
