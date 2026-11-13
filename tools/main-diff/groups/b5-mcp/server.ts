/**
 * Group `b5-mcp`, slice `server` (Rust: crates/main-core/src/calls/b5_mcp/server.rs
 * over shell/mcp/mcp_server.rs and packages/mcp_sdk/{server,streamable_http_server,sse_server}.rs).
 *
 * `mcp-server.scenario` starts the real McpServerService on a loopback port,
 * sends a script of HTTP requests to it with node:http and answers, per step,
 * what a client sees: the status, the headers the code or the SDK sets (not
 * Node's own Date, Content-Length, Transfer-Encoding, Keep-Alive, and
 * Connection unless the code sets it) and the body, with the logger lines of
 * the step. The Rust side drives the sans-IO service with the same script
 * through a fake host (calls/b5_mcp/server.rs).
 *
 * A case is `[scenario]`: `{ tools?, mode?, token?, version?, maxListenAttempts?,
 * listenRetryDelayMs?, start?, steps }`.
 * - tools: tool descriptors `{ name, description, schema?, handler }`; `schema`
 *   is a shape descriptor of zod.ts (`[[key, desc], ...]`), `handler` is
 *   `{ returns: v }`, `{ undefined: true }`, `{ throws: text }`, `{ echo: true }` or
 *   `{ counter: true }` (a number per call, one count per tool object) or
 *   `{ answers: true }` (the list of what its awaits answered). Any of them may
 *   be preceded by awaits: `{ awaits: [{ control, method, args? }], then: handler }`,
 *   each await a host call the script settles with a `resume` step (`call` its
 *   number in order of issue, `result` or `error`); `"$args"` in `args` is the
 *   tool's arguments. A call shows as `calls: ["call N: Control.method [args]"]`.
 * - mode: `tools` (the fixed set, the default), `factory` (`toolsFactory`, a
 *   fresh set per client session) or `server` (`serverFactory` over the SDK's
 *   low-level Server: `{ name, version, instructions?, capabilities?,
 *   tools: [{ name, description, inputSchema }], results: { name: result } }`).
 * - start: `true` (default) starts on port 0 before the steps; `false` leaves
 *   the service stopped for the lifecycle ops.
 * - steps: `http` (method, path, headers, `json` or `text` or `repeat` body,
 *   `open` to keep the stream under a name, `frames` to stop reading after
 *   that many SSE frames), `read` (more frames of an open stream), `close`,
 *   `tick` (ms of the fake clock: the heartbeats and the start retry delay),
 *   `block` / `unblock` (another program holds the fixed port), `start`
 *   (`fixed: true` for the blocked port; not awaited), `stop`, `state`, `settle`
 *   (a deferred server's call), `resume` (a tool's awaited host call).
 * Placeholders in headers and paths: `$PORT`, `$SID1`, `$SID2` (the session
 * ids in the order they first appear). The answers show the port as `$PORT`
 * and the ids as `<sid1>`, a duration as `<n>ms`.
 */
import http from 'node:http'
import net from 'node:net'
import { mock } from 'node:test'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { McpServerService } from '../../../../apps/shell/src/main/mcp/mcp-server.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'
import { shapeOf } from './zod.ts'

const realSetTimeout = globalThis.setTimeout

interface ToolSpec {
  name: string
  description: string
  schema?: unknown
  handler: Record<string, unknown>
}

interface ServerSpec {
  name: string
  version: string
  instructions?: string
  capabilities?: Record<string, unknown>
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  results: Record<string, unknown>
  /** tools whose calls answer later: a step `settle` resolves or rejects them */
  defer?: string[]
}

interface Deferred {
  calls: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[]
  aborts: string[]
}

interface Step {
  op: string
  [key: string]: unknown
}

interface Scenario {
  tools?: ToolSpec[]
  mode?: 'tools' | 'factory' | 'server'
  server?: ServerSpec
  token?: string
  version?: string
  maxListenAttempts?: number
  listenRetryDelayMs?: number
  start?: boolean
  steps: Step[]
}

interface AwaitSpec {
  control: string
  method: string
  args?: unknown[]
}

/** the host calls the tools await: the script settles them by `resume` steps */
interface HostCalls {
  pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[]
  lines: string[]
}

function handlerOf(
  spec: Record<string, unknown>,
  host: HostCalls,
): (args: Record<string, unknown>) => unknown {
  const then = thenOf(spec.then === undefined ? spec : (spec.then as Record<string, unknown>))
  const awaits = (spec.awaits ?? []) as AwaitSpec[]
  if (awaits.length === 0) return (args) => then(args, [])
  return async (args) => {
    const answers: unknown[] = []
    for (const a of awaits) {
      const callArgs = (a.args ?? []).map((v) => (v === '$args' ? args : v))
      host.lines.push(
        `call ${host.pending.length + 1}: ${a.control}.${a.method} ${JSON.stringify(callArgs)}`,
      )
      answers.push(await new Promise((resolve, reject) => host.pending.push({ resolve, reject })))
    }
    return then(args, answers)
  }
}

/** what a tool does after its awaits: answers them, or returns/throws what the case says */
function thenOf(
  spec: Record<string, unknown>,
): (args: Record<string, unknown>, answers: unknown[]) => unknown {
  if ('returns' in spec) return () => spec.returns
  if (spec.undefined === true) return () => undefined
  if ('throws' in spec) {
    return () => {
      throw new Error(String(spec.throws))
    }
  }
  if (spec.echo === true) return (args) => args
  if (spec.answers === true) return (_args, answers) => answers
  if (spec.counter === true) {
    let n = 0
    return () => ++n
  }
  throw new Error(`unknown handler ${JSON.stringify(spec)}`)
}

function toolsOf(specs: ToolSpec[], host: HostCalls) {
  return specs.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.schema !== undefined ? { inputSchema: shapeOf(t.schema) as z.ZodRawShape } : {}),
    handler: handlerOf(t.handler, host),
  }))
}

function sessionServerOf(spec: ServerSpec, deferred: Deferred) {
  const server = new Server(
    { name: spec.name, version: spec.version },
    {
      capabilities: (spec.capabilities ?? { tools: {} }) as never,
      ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {}),
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: spec.tools as never }))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const name = request.params.name
    if (spec.defer?.includes(name)) {
      const n = deferred.calls.length + 1
      return new Promise((resolve, reject) => {
        deferred.calls.push({ resolve: resolve as never, reject })
        extra.signal.addEventListener(
          'abort',
          () => {
            const why = extra.signal.reason
            deferred.aborts.push(`call ${n}: aborted${typeof why === 'string' ? ` ${why}` : ''}`)
          },
          { once: true },
        )
      })
    }
    if (!(name in spec.results)) {
      return { content: [{ type: 'text', text: `no tool ${name}` }], isError: true }
    }
    return spec.results[name] as never
  })
  return server
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const settle = (ms = 40): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))

interface Open {
  req: http.ClientRequest
  res?: http.IncomingMessage
  text: string
  ended: boolean
  failed: boolean
  taken: number
  status: number
  headers: Record<string, string>
  wake?: () => void
}

/** frames (text up to and including each blank line) in a stream's text */
function framesOf(text: string): string[] {
  const out: string[] = []
  let at = 0
  for (;;) {
    const end = text.indexOf('\n\n', at)
    if (end < 0) return out
    out.push(text.slice(at, end + 2))
    at = end + 2
  }
}

async function scenario(scenarioArg: unknown, cx: TsContext): Promise<unknown> {
  const spec = scenarioArg as Scenario
  const logs: string[] = []
  const ids: string[] = []
  let port = 0
  let fixedPort = 0
  let blocker: net.Server | undefined
  const streams = new Map<string, Open>()
  const starts: { settled: boolean; outcome?: string }[] = []
  const stops: { settled: boolean }[] = []

  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })

  const deferred: Deferred = { calls: [], aborts: [] }
  const host: HostCalls = { pending: [], lines: [] }
  const toolsFactory = () => toolsOf(spec.tools ?? [], host)
  const service = new McpServerService({
    port: 0,
    logger: (message) => logs.push(message),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.token !== undefined ? { token: spec.token } : {}),
    ...(spec.maxListenAttempts !== undefined ? { maxListenAttempts: spec.maxListenAttempts } : {}),
    ...(spec.listenRetryDelayMs !== undefined
      ? { listenRetryDelayMs: spec.listenRetryDelayMs }
      : {}),
    ...(spec.mode === 'server'
      ? { serverFactory: () => sessionServerOf(spec.server!, deferred) }
      : spec.mode === 'factory'
        ? { toolsFactory }
        : { tools: toolsFactory() }),
  })

  const norm = (text: string): string => {
    let out = text.replace(UUID, (id) => {
      let at = ids.indexOf(id)
      if (at < 0) at = ids.push(id) - 1
      return `<sid${at + 1}>`
    })
    for (const p of new Set([port, fixedPort])) {
      if (p) out = out.replace(new RegExp(`\\b${p}\\b`, 'g'), '$PORT')
    }
    return out.replace(/\((\d+)ms\)/g, '(<n>ms)')
  }
  const sub = (text: string): string =>
    text
      .replace(/\$PORT/g, String(port || fixedPort))
      .replace(/\$SID(\d+)/g, (_m, n: string) => ids[Number(n) - 1] ?? 'unknown')

  const headersOf = (raw: http.IncomingHttpHeaders): Record<string, string> => {
    const out: Record<string, string> = {}
    const sse = String(raw['content-type'] ?? '').startsWith('text/event-stream')
    for (const key of Object.keys(raw).sort()) {
      if (['date', 'content-length', 'transfer-encoding', 'keep-alive'].includes(key)) continue
      if (key === 'connection' && !sse) continue
      out[key] = norm(String(raw[key]))
    }
    return out
  }

  const send = (step: Step): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((step.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = sub(v)
      }
      let body: string | undefined
      if (step.json !== undefined) body = JSON.stringify(step.json)
      else if (typeof step.text === 'string') body = step.text
      else if (step.repeat !== undefined) {
        const [chunk, count] = step.repeat as [string, number]
        body = chunk.repeat(count)
      }
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
      const open: Open = {
        req: undefined as never,
        text: '',
        ended: false,
        failed: false,
        taken: 0,
        status: 0,
        headers: {},
      }
      const frames = typeof step.frames === 'number' ? step.frames : undefined
      const done = (): void => open.wake?.()
      open.req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: String(step.method),
          path: sub(String(step.path)),
          headers,
          agent: false,
        },
        (res) => {
          open.res = res
          open.status = res.statusCode ?? 0
          open.headers = headersOf(res.headers)
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            open.text += chunk
            done()
          })
          res.on('end', () => {
            open.ended = true
            done()
          })
          res.on('close', () => {
            if (!open.ended) open.failed = true
            done()
          })
          done()
        },
      )
      open.req.on('error', () => {
        open.failed = true
        done()
      })
      if (body !== undefined) open.req.write(body)
      open.req.end()

      const answer = (): void => {
        if (open.failed && !open.ended && open.status === 0) {
          resolve({ error: 'aborted' })
          return
        }
        const list = framesOf(open.text)
        const shown = frames !== undefined ? list.slice(0, frames) : undefined
        const out: Record<string, unknown> = { status: open.status, headers: open.headers }
        if (open.ended) out.body = norm(open.text)
        else if (shown) out.frames = shown.map(norm)
        else out.partial = norm(open.text)
        if (!open.ended) out.ended = false
        if (typeof step.open === 'string') {
          streams.set(step.open, open)
          open.taken = shown ? shown.length : list.length
        } else if (!open.ended) {
          open.req.destroy()
        }
        resolve(out)
      }
      // the answer waits for the end of the response, or for the stream to be
      // quiet; the frames asked for are taken from what came
      let quiet: ReturnType<typeof realSetTimeout> | undefined
      open.wake = () => {
        clearTimeout(quiet)
        if (open.ended || (open.failed && open.status === 0)) {
          open.wake = undefined
          answer()
          return
        }
        if (open.res) {
          quiet = realSetTimeout(() => {
            open.wake = undefined
            answer()
          }, 60)
        }
      }
      // a request that gets no answer at all (the connection is refused or cut) fails here
      realSetTimeout(() => open.wake?.(), 1500)
    })

  const results: unknown[] = []
  const outcome = (settled: boolean, text: string): string | undefined =>
    settled ? text : undefined

  try {
    if (spec.start !== false) {
      await service.start(0)
      port = service.getPort()
    }
    const first = logs.splice(0)
    results.push({ op: 'init', ...(first.length ? { logs: first.map(norm) } : {}) })

    for (const step of spec.steps) {
      const out: Record<string, unknown> = { op: step.op }
      switch (step.op) {
        case 'http': {
          Object.assign(out, await send(step))
          break
        }
        case 'read': {
          const open = streams.get(String(step.id))!
          await settle()
          const list = framesOf(open.text)
          const want = typeof step.frames === 'number' ? step.frames : list.length - open.taken
          const shown = list.slice(open.taken, open.taken + want)
          open.taken += shown.length
          out.frames = shown.map(norm)
          if (open.ended) out.ended = true
          break
        }
        case 'close': {
          const open = streams.get(String(step.id))!
          open.req.destroy()
          streams.delete(String(step.id))
          await settle()
          break
        }
        case 'tick': {
          mock.timers.tick(Number(step.ms))
          await settle()
          break
        }
        case 'block': {
          if (!fixedPort) {
            const probe = net.createServer()
            await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
            fixedPort = (probe.address() as net.AddressInfo).port
            await new Promise<void>((r) => probe.close(() => r()))
          }
          blocker = net.createServer()
          await new Promise<void>((r) => blocker!.listen(fixedPort, '127.0.0.1', () => r()))
          break
        }
        case 'unblock': {
          await new Promise<void>((r) => blocker!.close(() => r()))
          blocker = undefined
          break
        }
        case 'start': {
          if (step.fixed === true && !fixedPort) {
            const probe = net.createServer()
            await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
            fixedPort = (probe.address() as net.AddressInfo).port
            await new Promise<void>((r) => probe.close(() => r()))
          }
          const entry: { settled: boolean; outcome?: string } = { settled: false }
          starts.push(entry)
          const target = step.fixed === true ? fixedPort : 0
          service
            .start(target)
            .then(() => {
              entry.settled = true
              entry.outcome = 'resolved'
            })
            .catch((error: unknown) => {
              entry.settled = true
              entry.outcome = `rejected ${String(error)}`
            })
          await settle()
          if (service.isRunning()) port = service.getPort()
          break
        }
        case 'stop': {
          const entry = { settled: false }
          stops.push(entry)
          void service.stop().then(() => {
            entry.settled = true
          })
          await settle()
          break
        }
        case 'resume': {
          const call = host.pending[Number(step.call) - 1]
          if ('error' in step) call.reject(new Error(String(step.error)))
          else call.resolve(step.result)
          await settle()
          break
        }
        case 'settle': {
          const call = deferred.calls[Number(step.call) - 1]
          if ('error' in step) {
            const error = new Error(String(step.error))
            call.reject(step.code !== undefined ? Object.assign(error, { code: step.code }) : error)
          } else {
            call.resolve(step.result)
          }
          await settle()
          break
        }
        case 'state': {
          const p = service.getPort()
          out.running = service.isRunning()
          out.port = p !== 0 && (p === port || p === fixedPort) ? '$PORT' : p
          out.url = norm(service.getUrl())
          break
        }
        default:
          throw new Error(`unknown step ${step.op}`)
      }
      if (service.isRunning()) port = service.getPort()
      // what settled during the step
      for (const [i, entry] of starts.entries()) {
        if (entry.settled && entry.outcome !== undefined) {
          out[`start${i + 1}`] = norm(entry.outcome)
          entry.outcome = undefined
        }
      }
      for (const [i, entry] of stops.entries()) {
        if (entry.settled) {
          out[`stop${i + 1}`] = 'resolved'
          entry.settled = false
        }
      }
      void outcome
      if (deferred.aborts.length) out.aborts = deferred.aborts.splice(0)
      if (host.lines.length) out.calls = host.lines.splice(0)
      const lines = logs.splice(0)
      if (lines.length) out.logs = lines.map(norm)
      results.push(out)
    }
  } finally {
    for (const open of streams.values()) open.req.destroy()
    mock.timers.reset()
    await service.stop().catch(() => undefined)
    if (blocker) await new Promise<void>((r) => blocker!.close(() => r()))
  }
  void cx
  return results
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

const init = (version = '2025-06-18', id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'case', version: '1' },
  },
})
const rpc = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
})
const notice = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  method,
  ...(params !== undefined ? { params } : {}),
})

const get = (path: string, extra: Record<string, unknown> = {}): Step => ({
  op: 'http',
  method: 'GET',
  path,
  ...extra,
})

/** a POST to /mcp inside session `sid` (none: a request with no session header) */
const post = (
  body: unknown,
  sid?: number,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Step => ({
  op: 'http',
  method: 'POST',
  path: '/mcp',
  headers: { ...JSON_HEADERS, ...(sid ? { 'mcp-session-id': `$SID${sid}` } : {}), ...headers },
  json: body,
  ...extra,
})

const request = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Step => ({ op: 'http', method, path, headers, ...extra })

const TOOLS: ToolSpec[] = [
  {
    name: 'echo',
    description: 'Echo the arguments',
    schema: [['text', ['string', ['describe', 'what to echo']]]],
    handler: { echo: true },
  },
  {
    name: 'add',
    description: 'Add numbers',
    schema: [
      ['a', ['number', ['int']]],
      ['b', ['number', ['optional']]],
      ['mode', [['enum', ['fast', 'slow']], ['optional']]],
    ],
    handler: { echo: true },
  },
  { name: 'plain', description: 'Returns a string', handler: { returns: 'plain text' } },
  {
    name: 'object',
    description: 'Returns an object',
    handler: { returns: { ok: true, items: [1, 'two', null], nested: { k: 'v' } } },
  },
  { name: 'boom', description: 'Throws', handler: { throws: 'it broke' } },
  { name: 'nothing', description: 'Returns undefined', handler: { undefined: true } },
  { name: 'empty', description: 'Empty shape', schema: [], handler: { echo: true } },
  { name: 'count', description: 'A counter', handler: { counter: true } },
  {
    name: 'open_in_seuoffice',
    description: 'Open a file',
    schema: [['path', ['string']]],
    handler: { returns: 'opened' },
  },
]

/** an initialized session: session 1 after the first two steps */
const OPEN: Step[] = [post(init()), post(notice('notifications/initialized'), 1)]

const call = (id: number, name: string, args?: unknown, sid = 1, extra?: Record<string, unknown>) =>
  post(
    rpc(id, 'tools/call', { name, ...(args !== undefined ? { arguments: args } : {}), ...extra }),
    sid,
  )

const scenarios = (...list: Scenario[]): Case[] => list.map((s): Case => ({ args: [s] }))

const SERVER_SPEC: ServerSpec = {
  name: 'relay',
  version: '9.9.9',
  instructions: 'Notes from the server.',
  tools: [
    {
      name: 'lookup',
      description: 'Look a thing up',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ],
  results: {
    lookup: { content: [{ type: 'text', text: 'found' }], isError: false },
    extra: { content: [{ type: 'text', text: 'kept', extra: 1 }], note: 'loose' },
    bad: { content: [{ type: 'text' }] },
    empty: {},
    image: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
  },
}

const routing = scenarios({
  tools: TOOLS,
  steps: [
    get('/health'),
    get('/nothing'),
    request('POST', '/health'),
    get('/mcp/'),
    request('PUT', '/mcp'),
    request('OPTIONS', '/mcp'),
    request('HEAD', '/mcp'),
    request('DELETE', '/mcp'),
    get('/mcp'),
    get('/mcp', { headers: { 'mcp-session-id': 'nope', accept: 'text/event-stream' } }),
    request('DELETE', '/mcp', { 'mcp-session-id': 'nope' }),
    request('POST', '/sse'),
    request('GET', '/messages'),
    get('//'),
    get('/health?x=1#frag'),
    post(rpc(1, 'tools/list')),
    post(rpc(1, 'tools/list'), undefined, { 'mcp-session-id': 'nope' }),
    post(rpc(1, 'tools/list'), undefined, { 'mcp-session-id': '' }),
  ],
})

const guards = scenarios(
  {
    tools: TOOLS,
    steps: [
      get('/health', { headers: { host: 'evil.example:$PORT' } }),
      get('/health', { headers: { host: '127.0.0.1:1' } }),
      get('/health', { headers: { host: '127.0.0.1' } }),
      get('/health', { headers: { host: '' } }),
      get('/health', { headers: { host: 'localhost:$PORT' } }),
      get('/health', { headers: { host: 'LOCALHOST:$PORT' } }),
      get('/health', { headers: { host: '127.1:$PORT' } }),
      get('/health', { headers: { host: 'user@127.0.0.1:$PORT' } }),
      get('/health', { headers: { host: '[::1]:$PORT' } }),
      get('/health', { headers: { origin: 'http://evil.example' } }),
      get('/health', { headers: { origin: 'http://127.0.0.1:$PORT' } }),
      get('/health', { headers: { origin: 'https://localhost:$PORT' } }),
      get('/health', { headers: { origin: 'http://localhost:1' } }),
      get('/health', { headers: { origin: 'ftp://127.0.0.1:$PORT' } }),
      get('/health', { headers: { origin: 'null' } }),
      get('/health', { headers: { origin: '' } }),
      get('/health', { headers: { host: 'evil.example', origin: 'http://evil.example' } }),
      get('/sse', { headers: { origin: 'http://evil.example' } }),
      post(init(), undefined, { origin: 'http://evil.example' }),
    ],
  },
  {
    tools: TOOLS,
    token: 'sekrit',
    steps: [
      get('/health'),
      get('/health', { headers: { authorization: 'Bearer sekrit' } }),
      get('/health', { headers: { authorization: 'Bearer sekriT' } }),
      get('/health', { headers: { authorization: 'Bearer sekrit-and-more' } }),
      get('/health', { headers: { authorization: 'Bearer ' } }),
      get('/health', { headers: { authorization: 'sekrit' } }),
      get('/health', { headers: { host: 'evil.example', authorization: 'Bearer sekrit' } }),
      get('/health', { headers: { host: 'evil.example' } }),
      post(init(), undefined, { authorization: 'Bearer sekrit' }),
      post(init()),
      get('/sse'),
    ],
  },
)

const handshake = scenarios(
  {
    tools: TOOLS,
    version: '3.2.1',
    steps: [
      post(init('2025-11-25')),
      post(init('2025-06-18')),
      post(init('2025-03-26')),
      post(init('2024-11-05')),
      post(init('2024-10-07')),
      post(init('1999-01-01')),
      post(init('latest', 'abc')),
      post(init(), 1),
      post(init(), 1, { 'mcp-protocol-version': '2025-06-18' }),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      post([init(), rpc(2, 'ping')]),
      post(init(), undefined, { accept: 'application/json' }),
      post(init(), undefined, { accept: 'text/event-stream' }),
      post(init(), undefined, { accept: '' }),
      post(init(), undefined, { 'content-type': 'text/plain' }),
      post(init(), undefined, { 'content-type': 'application/jsonx' }),
      post(init(), undefined, { 'content-type': 'text/plain; a=application/json' }),
      post(init(), undefined, { 'content-type': 'APPLICATION/JSON; charset=utf-8' }),
      post(init(), undefined, { 'content-type': 'application/json;' }),
      post(init(), undefined, { 'content-type': 'application/json, text/plain' }),
      post(init(), undefined, { 'content-type': 'application/json; charset' }),
      post(init(), undefined, { 'content-type': '' }),
      post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      post({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      post(init(), undefined, { 'mcp-session-id': '' }),
      post(rpc(2, 'ping'), 1, { 'mcp-protocol-version': '2025-06-18' }),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      post(rpc(2, 'ping'), 1, { 'mcp-protocol-version': '2099-01-01' }),
      post(rpc(2, 'ping'), 1, { 'mcp-protocol-version': '2024-11-05' }),
      post(rpc(3, 'ping'), 1, { accept: 'application/json' }),
      post(rpc(3, 'ping'), 1, { 'content-type': 'text/plain' }),
      post(rpc(3, 'ping'), 1, { accept: '' }),
      post(rpc(4, 'ping')),
      post(rpc(5, 'ping'), undefined, { 'mcp-session-id': 'zzz' }),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {
            experimental: { x: {} },
            sampling: { tools: {} },
            elicitation: { form: { applyDefaults: true } },
            roots: { listChanged: true },
            tasks: { list: {}, requests: { sampling: { createMessage: {} } } },
            extensions: { 'a/b': {} },
          },
          clientInfo: { name: 'c', version: '1', title: 'T', icons: [{ src: 'x', theme: 'dark' }] },
        },
      }),
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { roots: { listChanged: 'yes' } },
          clientInfo: { name: 'c', version: '1' },
        },
      }),
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { experimental: { x: 1 } },
          clientInfo: { name: 'c', version: '1' },
        },
      }),
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c' } },
      }),
    ],
  },
)

const listing = scenarios(
  { tools: TOOLS, steps: [...OPEN, post(rpc(2, 'tools/list'), 1)] },
  {
    tools: [TOOLS[0], { ...TOOLS[8], name: 'open_in_genoffice' }],
    steps: [...OPEN, post(rpc(2, 'tools/list'), 1)],
  },
  {
    tools: [TOOLS[8], { ...TOOLS[8], name: 'open_in_genoffice' }],
    steps: [
      ...OPEN,
      post(rpc(2, 'tools/list'), 1),
      call(3, 'open_in_genoffice', { path: 'a' }),
      call(4, 'open_in_seuoffice', { path: 'a' }),
    ],
  },
  {
    tools: [],
    steps: [...OPEN, post(rpc(2, 'tools/list'), 1), call(3, 'echo', { text: 'x' })],
  },
  {
    tools: [TOOLS[0], TOOLS[0]],
    steps: [post(init()), post(init())],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      post(rpc(2, 'tools/list', { cursor: 'abc' }), 1),
      post(rpc(3, 'tools/list', { cursor: 5 }), 1),
      post(rpc(4, 'tools/list', { _meta: { progressToken: 'p' } }), 1),
    ],
  },
)

const calling = scenarios(
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      call(2, 'echo', { text: 'hello' }),
      call(3, 'echo', { text: 'hello', extra: 1 }),
      call(4, 'echo', { text: 5 }),
      call(5, 'echo'),
      call(6, 'echo', {}),
      call(7, 'add', { a: 1.5 }),
      call(8, 'add', { a: 1, b: 2, mode: 'fast' }),
      call(9, 'add', { a: 1, mode: 'medium' }),
      call(10, 'plain'),
      call(11, 'object'),
      call(12, 'boom'),
      call(13, 'nothing'),
      call(14, 'empty', { x: 1 }),
      call(15, 'count'),
      call(16, 'count'),
      call(17, 'missing'),
      call(18, 'constructor'),
      call(19, '__proto__'),
      call(20, 'toString'),
      call(21, 'open_in_genoffice', { path: 'a' }),
      call(22, 'open_in_seuoffice', { path: 'a' }),
      call(23, 'open_in_genoffice', {}),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      post(rpc(2, 'tools/call'), 1),
      post(rpc(3, 'tools/call', {}), 1),
      post(rpc(4, 'tools/call', { name: 5, arguments: [] }), 1),
      post(rpc(5, 'tools/call', { name: 'plain', arguments: null }), 1),
      post(rpc(6, 'tools/call', { name: 'plain', arguments: 'x' }), 1),
      post(rpc(7, 'tools/call', { name: 'plain', task: 5 }), 1),
      post(rpc(8, 'tools/call', { name: 'plain', task: { ttl: 'x' } }), 1),
      post(rpc(9, 'tools/call', { name: 'plain', task: {} }), 1),
      post(rpc(10, 'tools/call', { name: 'plain', _meta: { progressToken: 7 } }), 1),
      post(rpc(11, 'tools/call', { name: 'plain', unknown: true }), 1),
      post(rpc(12, 'tools/call', { name: 'nothing' }), 1),
      post(rpc('s', 'tools/call', { name: 'plain' }), 1),
    ],
  },
  {
    tools: TOOLS,
    mode: 'factory',
    steps: [
      post(init()),
      post(init()),
      call(2, 'count', undefined, 1),
      call(3, 'count', undefined, 1),
      call(4, 'count', undefined, 2),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      post(init()),
      post(init()),
      call(2, 'count', undefined, 1),
      call(3, 'count', undefined, 2),
      call(4, 'count', undefined, 1),
    ],
  },
)

const messages = scenarios(
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      post(rpc(2, 'foo/bar'), 1),
      post(rpc(3, 'resources/list'), 1),
      post(notice('notifications/initialized'), 1),
      post(notice('notifications/cancelled', { requestId: 1, reason: 'x' }), 1),
      post(notice('notifications/progress', { progressToken: 1, progress: 1 }), 1),
      post(notice('notifications/whatever'), 1),
      post({ jsonrpc: '2.0', id: 9, result: {} }, 1),
      post({ jsonrpc: '2.0', id: 9, error: { code: -1, message: 'no' } }, 1),
      post(rpc(4, 'ping'), 1),
      post({ jsonrpc: '2.0', id: 0, method: 'ping' }, 1),
      post({ jsonrpc: '2.0', id: 1.5, method: 'ping' }, 1),
      post({ jsonrpc: '1.0', id: 1, method: 'ping' }, 1),
      post({ jsonrpc: '2.0', id: 1, method: 'ping', foo: 1 }, 1),
      post({ jsonrpc: '2.0', id: 1, method: 'ping', params: 5 }, 1),
      post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { progressToken: 1.5 } } }, 1),
      post({ jsonrpc: '2.0', id: null, method: 'ping' }, 1),
      post(5, 1),
      post('ping', 1),
      post(true, 1),
      post(null, 1),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      post([rpc(2, 'ping'), rpc(3, 'ping')], 1),
      post([rpc(2, 'tools/call', { name: 'plain' }), rpc(3, 'ping')], 1),
      post([rpc(2, 'ping'), rpc(3, 'tools/call', { name: 'plain' })], 1),
      post([rpc(2, 'tools/list'), rpc(3, 'foo'), rpc(4, 'ping')], 1),
      post(
        [
          rpc(2, 'tools/call', { name: 'echo', arguments: { text: 'a' } }),
          rpc(3, 'tools/call', { name: 'plain' }),
          rpc(4, 'tools/call', { name: 'echo', arguments: { text: 1 } }),
          rpc(5, 'tools/call', { name: 'boom' }),
          rpc(6, 'tools/call', { name: 'missing' }),
          rpc(7, 'tools/call', { name: 'nothing' }),
          rpc(8, 'tools/call', {}),
          rpc(9, 'tools/list'),
        ],
        1,
      ),
      post([notice('notifications/initialized'), rpc(2, 'ping')], 1),
      post(
        [notice('notifications/initialized'), notice('notifications/cancelled', { requestId: 1 })],
        1,
      ),
      post([], 1),
      post([rpc(2, 'ping'), { bad: true }], 1),
      post([rpc(2, 'ping'), rpc(2, 'ping')], 1),
      post([rpc(2, 'ping'), rpc('2', 'ping')], 1),
      post(
        Array.from({ length: 100 }, (_v, i) => rpc(i + 1, 'ping')),
        1,
      ),
      post(
        Array.from({ length: 101 }, (_v, i) => rpc(i + 1, 'ping')),
        1,
      ),
      post([init()], 1),
      post([init(), rpc(5, 'ping')], 1),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      { ...post(undefined, 1), json: undefined, text: '{x' },
      { ...post(undefined, 1), json: undefined, text: ' ' },
      { ...post(undefined, 1), json: undefined, text: '' },
      { ...post(undefined, 1), json: undefined, text: '[1,2' },
      { ...post(undefined, 1), json: undefined, text: '{"a":1}}' },
      { ...post(undefined, 1), json: undefined, text: 'nul' },
      { ...post(undefined, 1), json: undefined, text: '\u0000' },
      { ...post(undefined, 1), json: undefined, text: '"x' },
      { ...post(undefined, 1), json: undefined, text: '{"a":1,}' },
      { ...post(undefined, undefined), json: undefined, text: '{x' },
      { ...post(undefined, undefined), json: undefined, text: '' },
      { ...post(undefined, undefined), json: undefined, text: 'null' },
      { ...post(undefined, 1), json: undefined, text: 'null' },
      { ...post(undefined, 1), json: undefined, repeat: ['x', 33554433] },
      { ...post(undefined, 1), json: undefined, repeat: ['x', 33554432] },
      { ...post(undefined, undefined), json: undefined, repeat: [' ', 33554433] },
    ],
  },
)

const streams = scenarios(
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      get('/mcp', { headers: { 'mcp-session-id': '$SID1' } }),
      get('/mcp', { headers: { 'mcp-session-id': '$SID1', accept: 'application/json' } }),
      get('/mcp', {
        headers: {
          'mcp-session-id': '$SID1',
          accept: 'text/event-stream',
          'mcp-protocol-version': '1',
        },
      }),
      get('/mcp', {
        headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' },
        open: 'standalone',
        frames: 1,
      }),
      get('/mcp', { headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' } }),
      get('/mcp', { headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' } }),
      post(rpc(2, 'ping'), 1),
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 'standalone' },
      { op: 'tick', ms: 30000 },
      { op: 'read', id: 'standalone' },
      request('DELETE', '/mcp', { 'mcp-session-id': '$SID1', 'mcp-protocol-version': '2099' }),
      request('DELETE', '/mcp', { 'mcp-session-id': '$SID1' }),
      { op: 'read', id: 'standalone' },
      { op: 'tick', ms: 15000 },
      request('DELETE', '/mcp', { 'mcp-session-id': '$SID1' }),
      post(rpc(3, 'ping'), 1),
      get('/mcp', { headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' } }),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      get('/mcp', {
        headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' },
        open: 'a',
        frames: 1,
      }),
      { op: 'close', id: 'a' },
      get('/mcp', {
        headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' },
        open: 'b',
        frames: 1,
      }),
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 'b' },
      { op: 'close', id: 'b' },
      { op: 'tick', ms: 15000 },
      post(rpc(2, 'ping'), 1),
    ],
  },
)

const legacyPost = (
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  path = '/messages?sessionId=$SID1',
): Step => ({
  op: 'http',
  method: 'POST',
  path,
  headers,
  ...(typeof body === 'string' ? { text: body } : { json: body }),
})

const legacy = scenarios(
  {
    tools: TOOLS,
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost(init()),
      { op: 'read', id: 's' },
      legacyPost(notice('notifications/initialized')),
      legacyPost(rpc(2, 'tools/list')),
      legacyPost(rpc(3, 'tools/call', { name: 'echo', arguments: { text: 'a' } })),
      legacyPost(rpc(4, 'tools/call', { name: 'boom' })),
      legacyPost(rpc(5, 'foo')),
      legacyPost(rpc(6, 'ping')),
      { op: 'read', id: 's' },
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 's' },
      { op: 'tick', ms: 30000 },
      { op: 'read', id: 's' },
      { op: 'close', id: 's' },
      { op: 'tick', ms: 15000 },
      legacyPost(rpc(7, 'ping')),
    ],
  },
  {
    tools: TOOLS,
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost(''),
      legacyPost('null'),
      legacyPost('"hello"'),
      legacyPost(JSON.stringify(rpc(2, 'ping'))),
      legacyPost(JSON.stringify(JSON.stringify(rpc(2, 'ping')))),
      legacyPost(JSON.stringify(JSON.stringify({ a: 1 }))),
      legacyPost('{bad'),
      legacyPost(5 as never),
      legacyPost(true as never),
      legacyPost([1, { a: 1 }, null, [2, 3]] as never),
      legacyPost({ a: 1 } as never),
      legacyPost([rpc(2, 'ping')] as never),
      legacyPost(rpc(2, 'ping'), {}),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'text/plain' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json; charset=bad' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json;' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json; a="b\\"c"; D=e' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json; a="b' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'APPLICATION/json' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'json' }),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json' }, '/messages'),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json' }, '/messages?sessionId='),
      legacyPost(rpc(2, 'ping'), { 'content-type': 'application/json' }, '/messages?sessionId=zzz'),
      legacyPost(init(), { 'content-type': 'application/json' }, '/messages?x=1&sessionId=$SID1'),
      {
        op: 'http',
        method: 'POST',
        path: '/messages?sessionId=$SID1',
        headers: { 'content-type': 'application/json' },
        repeat: ['x', 33554433],
      },
      { op: 'read', id: 's' },
    ],
  },
  {
    tools: TOOLS,
    steps: [
      get('/sse', { open: 's1', frames: 1 }),
      get('/sse', { open: 's2', frames: 1 }),
      legacyPost(init(), { 'content-type': 'application/json' }, '/messages?sessionId=$SID1'),
      legacyPost(init(), { 'content-type': 'application/json' }, '/messages?sessionId=$SID2'),
      { op: 'read', id: 's1' },
      { op: 'read', id: 's2' },
      { op: 'close', id: 's1' },
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 's2' },
      legacyPost(
        rpc(3, 'ping'),
        { 'content-type': 'application/json' },
        '/messages?sessionId=$SID2',
      ),
      { op: 'read', id: 's2' },
    ],
  },
  {
    tools: TOOLS,
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c' } },
      }),
      legacyPost({ jsonrpc: '2.0', id: 2, method: 'initialize' }),
      legacyPost({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} }),
      legacyPost({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 1 } }),
      legacyPost(init('1999-01-01', 5)),
      legacyPost(rpc(6, 'tools/call', { name: 'nothing' })),
      { op: 'read', id: 's' },
    ],
  },
)

const modes = scenarios(
  {
    mode: 'server',
    server: SERVER_SPEC,
    steps: [
      post(init()),
      post(notice('notifications/initialized'), 1),
      post(rpc(2, 'tools/list'), 1),
      post(rpc(3, 'tools/call', { name: 'lookup', arguments: { q: 'x' } }), 1),
      post(rpc(4, 'tools/call', { name: 'extra' }), 1),
      post(rpc(5, 'tools/call', { name: 'bad' }), 1),
      post(rpc(6, 'tools/call', { name: 'empty' }), 1),
      post(rpc(7, 'tools/call', { name: 'image' }), 1),
      post(rpc(8, 'tools/call', { name: 'nope' }), 1),
      post(rpc(9, 'tools/call', { name: 'lookup', task: {} }), 1),
      post(rpc(10, 'resources/list'), 1),
      post(rpc(11, 'ping'), 1),
      post(rpc(12, 'tools/call'), 1),
    ],
  },
  {
    mode: 'server',
    server: { ...SERVER_SPEC, instructions: undefined, version: '1.0.0' },
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost(init()),
      legacyPost(rpc(2, 'tools/list')),
      legacyPost(rpc(3, 'tools/call', { name: 'lookup' })),
      { op: 'read', id: 's' },
    ],
  },
  {
    mode: 'server',
    server: { ...SERVER_SPEC, instructions: '' },
    steps: [post(init())],
  },
  {
    mode: 'server',
    server: { ...SERVER_SPEC, capabilities: { tools: { listChanged: true }, logging: {} } },
    steps: [post(init()), post(rpc(2, 'tools/list'), 1)],
  },
  {
    tools: [TOOLS[0]],
    version: '2.0.0',
    steps: [post(init()), post(rpc(2, 'tools/list'), 1)],
  },
)

const RELAY: ServerSpec = {
  ...SERVER_SPEC,
  defer: ['slow', 'slow2'],
  results: { ...SERVER_SPEC.results, fast: { content: [{ type: 'text', text: 'fast' }] } },
}
const slow = (id: number | string, name = 'slow', open?: string, sid = 1) =>
  post(rpc(id, 'tools/call', { name }), sid, {}, open ? { open } : {})
const settleWith = (call: number, result: unknown): Step => ({ op: 'settle', call, result })
const text = (value: string) => ({ content: [{ type: 'text', text: value }] })
const cancel = (requestId: unknown, reason?: string): Step =>
  post(
    notice('notifications/cancelled', { requestId, ...(reason !== undefined ? { reason } : {}) }),
    1,
  )

const deferred = scenarios(
  {
    mode: 'server',
    server: RELAY,
    steps: [
      ...OPEN,
      slow(2, 'slow', 'a'),
      slow(3, 'slow2', 'b'),
      post(rpc(4, 'tools/call', { name: 'fast' }), 1),
      slow(5, 'slow', 'c'),
      slow(6, 'slow', 'd'),
      slow(7, 'slow', 'e'),
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 'a' },
      settleWith(2, text('two')),
      { op: 'read', id: 'b' },
      { op: 'read', id: 'a' },
      { op: 'settle', call: 1, error: 'denied', code: -32001 },
      { op: 'read', id: 'a' },
      settleWith(1, text('again')),
      settleWith(3, { content: [{ type: 'text' }] }),
      { op: 'read', id: 'c' },
      { op: 'settle', call: 4, error: 'plain failure' },
      { op: 'read', id: 'd' },
      { op: 'settle', call: 5, error: 'odd code', code: 1.5 },
      { op: 'read', id: 'e' },
      { op: 'tick', ms: 30000 },
      { op: 'read', id: 'e' },
      post(rpc(8, 'ping'), 1),
    ],
  },
  {
    mode: 'server',
    server: RELAY,
    steps: [
      ...OPEN,
      slow(2, 'slow', 'a'),
      slow(3, 'slow', 'b'),
      slow('4', 'slow', 'c'),
      slow(5, 'slow', 'd'),
      slow(0, 'slow', 'e'),
      cancel(2, 'user stopped'),
      cancel(2, 'again'),
      cancel(99),
      cancel(0),
      cancel(''),
      cancel({}),
      cancel(4),
      cancel('4'),
      post(notice('notifications/cancelled', {}), 1),
      post(notice('notifications/cancelled'), 1),
      settleWith(1, text('late')),
      { op: 'read', id: 'a' },
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 'a' },
      settleWith(2, text('three')),
      { op: 'read', id: 'b' },
      settleWith(3, text('four')),
      { op: 'read', id: 'c' },
      settleWith(5, text('zero')),
      { op: 'read', id: 'e' },
      post(rpc(6, 'ping'), 1),
      request('DELETE', '/mcp', { 'mcp-session-id': '$SID1' }),
      { op: 'read', id: 'a' },
      { op: 'read', id: 'd' },
      settleWith(4, text('after delete')),
      { op: 'read', id: 'd' },
    ],
  },
  {
    mode: 'server',
    server: RELAY,
    steps: [
      ...OPEN,
      post(
        [rpc(2, 'ping'), rpc(3, 'tools/call', { name: 'slow' }), rpc(4, 'ping')],
        1,
        {},
        {
          open: 'batch',
          frames: 2,
        },
      ),
      { op: 'tick', ms: 15000 },
      { op: 'read', id: 'batch' },
      settleWith(1, text('batched')),
      { op: 'read', id: 'batch' },
      post(
        [rpc(5, 'tools/call', { name: 'slow' }), rpc(6, 'tools/call', { name: 'slow2' })],
        1,
        {},
        {
          open: 'two',
        },
      ),
      settleWith(3, text('second first')),
      { op: 'read', id: 'two' },
      settleWith(2, text('then first')),
      { op: 'read', id: 'two' },
    ],
  },
  {
    mode: 'server',
    server: RELAY,
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost(init()),
      legacyPost(rpc(2, 'tools/call', { name: 'slow' })),
      legacyPost(rpc(3, 'tools/call', { name: 'fast' })),
      legacyPost(rpc(4, 'tools/call', { name: 'slow' })),
      { op: 'read', id: 's' },
      settleWith(2, text('legacy two')),
      { op: 'read', id: 's' },
      legacyPost(notice('notifications/cancelled', { requestId: 2, reason: 'no thanks' })),
      settleWith(1, text('late')),
      { op: 'read', id: 's' },
      legacyPost(rpc(5, 'tools/call', { name: 'slow2' })),
      { op: 'close', id: 's' },
      settleWith(3, text('after close')),
      legacyPost(rpc(6, 'ping')),
    ],
  },
  {
    mode: 'server',
    server: RELAY,
    steps: [
      ...OPEN,
      slow(2, 'slow', 'a'),
      get('/sse', { open: 's', frames: 1 }),
      {
        op: 'http',
        method: 'POST',
        path: '/messages?sessionId=$SID2',
        headers: { 'content-type': 'application/json' },
        json: init(),
      },
      legacyPost(
        rpc(3, 'tools/call', { name: 'slow' }),
        { 'content-type': 'application/json' },
        '/messages?sessionId=$SID2',
      ),
      { op: 'state' },
      { op: 'stop' },
      { op: 'read', id: 'a' },
      settleWith(1, text('after stop')),
      settleWith(2, text('after stop too')),
      { op: 'state' },
      { op: 'start' },
      post(init()),
      slow(2, 'slow', 'z', 3),
      settleWith(3, text('new session')),
      { op: 'read', id: 'z' },
    ],
  },
)

const await1 = (method: string, ...args: unknown[]) => ({ control: 'DocsControl', method, args })
const AWAIT_TOOLS: ToolSpec[] = [
  {
    name: 'read',
    description: 'Reads through a control',
    schema: [['path', ['string']]],
    handler: { awaits: [await1('read', '$args')], then: { answers: true } },
  },
  {
    name: 'two',
    description: 'Two awaits',
    handler: {
      awaits: [await1('first'), { control: 'SlidesControl', method: 'second', args: [1, 'x'] }],
      then: { answers: true },
    },
  },
  {
    name: 'finally_throws',
    description: 'Throws after an await',
    handler: { awaits: [await1('check')], then: { throws: 'failed after await' } },
  },
  {
    name: 'plain_after',
    description: 'A string after an await',
    handler: { awaits: [await1('ping')], then: { returns: 'done' } },
  },
  { name: 'now', description: 'No await', handler: { returns: 'immediately' } },
  { name: 'count', description: 'A counter', handler: { counter: true } },
]
const tool = (id: number, name: string, args?: unknown, open?: string, sid = 1) =>
  post(
    rpc(id, 'tools/call', { name, ...(args !== undefined ? { arguments: args } : {}) }),
    sid,
    {},
    open ? { open } : {},
  )
const resume = (call: number, result?: unknown): Step => ({
  op: 'resume',
  call,
  ...(result !== undefined ? { result } : {}),
})
const resumeError = (call: number, error: string): Step => ({ op: 'resume', call, error })

const awaiting = scenarios(
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'read', { path: 'a.docx' }, 'a'),
      resume(1, { text: 'hello', n: 2 }),
      { op: 'read', id: 'a' },
      tool(3, 'read', { path: 5 }),
      tool(4, 'plain_after', undefined, 'b'),
      resume(2),
      { op: 'read', id: 'b' },
      tool(5, 'plain_after', undefined, 'c'),
      resume(3, null),
      { op: 'read', id: 'c' },
      tool(6, 'now'),
      resume(1, 'again'),
    ],
  },
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'finally_throws', undefined, 'a'),
      resume(1, 'ok'),
      { op: 'read', id: 'a' },
      tool(3, 'read', { path: 'b' }, 'b'),
      resumeError(2, 'renderer gone'),
      { op: 'read', id: 'b' },
      tool(4, 'two', undefined, 'c'),
      resume(3, 'one'),
      resumeError(4, 'second failed'),
      { op: 'read', id: 'c' },
    ],
  },
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'two', undefined, 'a'),
      { op: 'tick', ms: 15000 },
      resume(1, 'one'),
      { op: 'read', id: 'a' },
      resume(2, { k: [1, 2] }),
      { op: 'read', id: 'a' },
      resume(2, 'second time'),
      resume(1, 'second time'),
    ],
  },
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'read', { path: 'a' }, 'a'),
      tool(3, 'two', undefined, 'b'),
      tool(4, 'now'),
      tool(5, 'read', { path: 'c' }, 'c'),
      resume(3, 'c answer'),
      { op: 'read', id: 'c' },
      resume(2, 'b one'),
      resume(4, 'b second'),
      { op: 'read', id: 'b' },
      resume(1, 'a answer'),
      { op: 'read', id: 'a' },
      post(
        [
          rpc(6, 'tools/call', { name: 'read', arguments: { path: 'x' } }),
          rpc(7, 'tools/call', { name: 'now' }),
          rpc(8, 'ping'),
        ],
        1,
        {},
        { open: 'batch', frames: 2 },
      ),
      resume(5, 'batched'),
      { op: 'read', id: 'batch' },
    ],
  },
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'two', undefined, 'a'),
      tool(3, 'read', { path: 'z' }, 'z'),
      post(notice('notifications/cancelled', { requestId: 2, reason: 'stop' }), 1),
      resume(1, 'one'),
      resume(2, 'second'),
      { op: 'read', id: 'a' },
      resume(3, 'still answered'),
      { op: 'read', id: 'z' },
      tool(4, 'read', { path: 'd' }, 'd'),
      request('DELETE', '/mcp', { 'mcp-session-id': '$SID1' }),
      resume(4, 'late'),
      { op: 'read', id: 'd' },
      tool(5, 'now', undefined, undefined, 1),
    ],
  },
  {
    tools: AWAIT_TOOLS,
    steps: [
      ...OPEN,
      tool(2, 'two', undefined, 'a'),
      tool(3, 'read', { path: 'z' }, 'z'),
      { op: 'stop' },
      { op: 'read', id: 'a' },
      resume(1, 'after stop'),
      resume(2, 'after stop too'),
      resume(3, 'orphan'),
      { op: 'start' },
      post(init()),
      tool(2, 'read', { path: 'new' }, 'n', 2),
      resume(4, 'fresh'),
      { op: 'read', id: 'n' },
    ],
  },
  {
    tools: AWAIT_TOOLS,
    mode: 'factory',
    steps: [
      get('/sse', { open: 's', frames: 1 }),
      legacyPost(init()),
      legacyPost(rpc(2, 'tools/call', { name: 'two' })),
      legacyPost(rpc(3, 'tools/call', { name: 'read', arguments: { path: 'q' } })),
      resume(1, 'legacy one'),
      resume(3, 'q answer'),
      { op: 'read', id: 's' },
      resume(2, 'legacy second'),
      { op: 'read', id: 's' },
      legacyPost(rpc(4, 'tools/call', { name: 'finally_throws' })),
      { op: 'close', id: 's' },
      resume(4, 'x'),
    ],
  },
)

const lifecycle = scenarios(
  {
    tools: TOOLS,
    start: false,
    steps: [
      { op: 'state' },
      { op: 'stop' },
      { op: 'state' },
      { op: 'start' },
      { op: 'state' },
      { op: 'start' },
      get('/health'),
      { op: 'stop' },
      { op: 'state' },
      { op: 'start' },
      get('/health'),
      { op: 'stop' },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 3,
    listenRetryDelayMs: 100,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'state' },
      { op: 'tick', ms: 99 },
      { op: 'tick', ms: 1 },
      { op: 'unblock' },
      { op: 'tick', ms: 100 },
      { op: 'state' },
      get('/health'),
      { op: 'stop' },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 2,
    listenRetryDelayMs: 100,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'tick', ms: 100 },
      { op: 'state' },
      { op: 'tick', ms: 500 },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'tick', ms: 1499 },
      { op: 'tick', ms: 1 },
      { op: 'unblock' },
      { op: 'tick', ms: 1500 },
      { op: 'state' },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 1,
    steps: [{ op: 'block' }, { op: 'start', fixed: true }, { op: 'state' }],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 0,
    steps: [{ op: 'start', fixed: true }, { op: 'state' }],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 3,
    listenRetryDelayMs: 100,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'stop' },
      { op: 'tick', ms: 100 },
      { op: 'state' },
      { op: 'unblock' },
      { op: 'tick', ms: 100 },
      { op: 'state' },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 3,
    listenRetryDelayMs: 100,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'unblock' },
      { op: 'stop' },
      { op: 'tick', ms: 100 },
      { op: 'state' },
      { op: 'tick', ms: 1000 },
    ],
  },
  {
    tools: TOOLS,
    start: false,
    maxListenAttempts: 5,
    listenRetryDelayMs: 50,
    steps: [
      { op: 'block' },
      { op: 'start', fixed: true },
      { op: 'start', fixed: true },
      { op: 'unblock' },
      { op: 'tick', ms: 50 },
      { op: 'tick', ms: 50 },
      { op: 'state' },
    ],
  },
  {
    tools: TOOLS,
    steps: [
      ...OPEN,
      get('/mcp', {
        headers: { 'mcp-session-id': '$SID1', accept: 'text/event-stream' },
        open: 'standalone',
        frames: 1,
      }),
      get('/sse', { open: 'legacy', frames: 1 }),
      { op: 'state' },
      { op: 'stop' },
      { op: 'read', id: 'standalone' },
      { op: 'read', id: 'legacy' },
      { op: 'tick', ms: 60000 },
      { op: 'state' },
      get('/health'),
    ],
  },
)

const scenarioSpec: FnSpec = {
  ts: (args, cx) => scenario(args[0], cx),
  cases: [
    ...routing,
    ...guards,
    ...handshake,
    ...listing,
    ...calling,
    ...messages,
    ...streams,
    ...legacy,
    ...modes,
    ...deferred,
    ...awaiting,
    ...lifecycle,
  ],
}

export const group: Group = { 'mcp-server.scenario': scenarioSpec }
export { scenario }
