/**
 * Group `b5-mcp`, slice `agent` (Rust: crates/main-core/src/calls/b5_mcp/agent.rs
 * over shell/agent/{agent_mcp,agent_mcp_relay}.rs): apps/shell/src/main/agent/
 * agent-mcp.ts and agent-mcp-relay.ts.
 *
 * Plain functions:
 * - `agent-mcp.skillCall` builds `createAgentSkillTools(hooks, openTabs)` over
 *   fakes the case describes and calls one tool (or lists them, as the SDK
 *   lists tools). Each call of a fake is a log line. Hooks `{ propose, install,
 *   readTabs }` (`propose` and `install` are a `Val`: `{ value }`, `{ undef }`
 *   or `{ throws }`; `readTabs` makes `proposeSkill` read the context's
 *   `openTabs()` and log what it answered); no `hooks` is the default
 *   (`NO_WINDOW`). `tabs` is `{ list }` or `{ throws }`, none the default.
 * - `agent-mcp.withholdingSlides` and `agent-mcp.withholdingOpenDocuments` run
 *   a script of steps over a fake control and answer each step's value or what
 *   it threw. The file-parse functions `redactMarkdownSource` and
 *   `redactHtmlSource` are replaced (for agent-mcp.ts alone) by fakes that log
 *   their input and answer `md<..>` and `html<..>`: they are engine-waiting on
 *   the Rust side.
 * - `agent-mcp.build` builds `buildAgentMcpTools(deps, root, platform)` and
 *   lists the names (in order), or calls one tool's handler. The readers of
 *   pdf-tools and hwp-tools are the fakes of tools-docs.ts.
 * - `agentRelayPlans`, `relayResultOf`, `RELAY_TEXT` as they are; `objectSchema`
 *   is not exported and shows in the relay scenario's `tools/list`.
 *
 * Scenarios start the real services on loopback and send them JSON-RPC over
 * HTTP with node:http, as mcp-server.scenario does, and answer per step what a
 * client sees (status, content type, the session header, the JSON-RPC
 * messages of the stream) with the fakes' log lines:
 * - `agent-mcp.scenario`: `startAgentMcpServer(deps, root)`; steps `rpc`
 *   (`method`, `params`, `id`, `session`, `auth: good|bad|none`, `namesOnly`
 *   shows `tools/list` as names, `open` keeps the stream under a name),
 *   `notify`, `read`, `close`, `stop`.
 * - `agent-mcp-relay.scenario`: `startAgentMcpRelays` over a scripted hub
 *   (`list` of server views, `editorList` steps change it; `call` returns a
 *   promise that `hubAnswer { n, answer | reject }` settles) and a scripted
 *   card (`askAnswer { n, answer | reject }` settles the n-th). Fake calls are
 *   log lines: `hub.editorList`, `hub.call`, `hub.cancel`, `ask`, `ask.abort`.
 *   The step `relay` picks the relay (1-based) a request goes to, `stop` stops
 *   the relays.
 * The answers show the port as `$PORT`, tokens as `<tokenN>` and ids as `<idN>`.
 */
import http from 'node:http'
import { registerHooks } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentMcpServer } from '../../../../apps/shell/src/main/agent/agent-mcp.ts'
import type { AgentMcpRelays } from '../../../../apps/shell/src/main/agent/agent-mcp-relay.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'

// the PDF and HWP readers of pdf-tools.ts and hwp-tools.ts are replaced by the registration of
// tools-docs.ts, which must run before agent-mcp.ts loads them: a static import cannot be ordered
await import('./tools-docs.ts')
const PDF_BOX = Symbol.for('main-diff.pdf-text')
const HWP_BOX = Symbol.for('main-diff.hwp-text')
const REDACT_BOX = Symbol.for('main-diff.redact')
const REDACT_URL = 'main-diff:file-parse-redact'
registerHooks({
  resolve(specifier, context, next) {
    if (
      (context.parentURL ?? '').endsWith('/agent/agent-mcp.ts') &&
      specifier === '@seuoffice/file-parse'
    ) {
      return { url: REDACT_URL, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === REDACT_URL) {
      const source = [
        `export const redactMarkdownSource = (s) => globalThis[Symbol.for('main-diff.redact')].markdown(s)`,
        `export const redactHtmlSource = (s) => globalThis[Symbol.for('main-diff.redact')].html(s)`,
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, context)
  },
})

const agentMcp = await import('../../../../apps/shell/src/main/agent/agent-mcp.ts')
const relay = await import('../../../../apps/shell/src/main/agent/agent-mcp-relay.ts')

// any: the cases describe fakes and answers of every shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Spec = Record<string, Any>
type Log = (...args: unknown[]) => void

const realSetTimeout = globalThis.setTimeout
const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const constant = (value: unknown, why: string): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: why,
})

/** a scripted answer: `{ value }`, `{ undef: true }` or `{ throws }` */
function answer(val: Spec | undefined): unknown {
  if (val?.throws !== undefined) throw new Error(val.throws)
  return val?.undef ? undefined : val?.value
}

/** what the SDK lists of tools registered as mcp-server.ts registers them */
async function listed(tools: Spec[]): Promise<unknown> {
  const server = new McpServer({ name: 'main-diff', version: '1' })
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      },
      (async () => ({ content: [] })) as never,
    )
  }
  const handlers = (server.server as Any)._requestHandlers as Map<string, Any>
  const out = await handlers.get('tools/list')({ method: 'tools/list' }, {})
  return out.tools.map((t: Spec) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

async function callTool(tools: Spec[], name: string, args: unknown): Promise<unknown> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return await tool.handler(args ?? {})
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const tab = (
  id: string,
  kind: string,
  title: string,
  filePath?: string,
  dirty = false,
  active = false,
): Spec => ({
  id,
  kind,
  title,
  ...(filePath ? { filePath } : {}),
  active,
  dirty,
})

function openControl(spec: Spec, log: Log): Any {
  return {
    list: async () => {
      log('control.list')
      if (!Array.isArray(spec.list)) throw new Error(spec.list?.throws ?? '')
      return spec.list
    },
    read: async (t: Spec) => {
      log('control.read', t.id)
      return answer(spec.read)
    },
    close: async (t: Spec, options: Spec) => {
      log('control.close', t.id, options)
      return answer(spec.close) ?? {}
    },
    save: async (t: Spec) => {
      log('control.save', t.id)
      return answer(spec.save) ?? { savedPath: '' }
    },
  }
}

function slidesControl(spec: Spec, log: Log): Any {
  const control: Spec = {
    openBlankTab: async () => {
      log('slides.open')
      return answer(spec.open) ?? 3
    },
    runTxn: async (wc: number, req: unknown) => {
      log('slides.txn', wc, req)
      return answer(spec.txn)
    },
    readDeck: async (wc: number, options?: unknown) => {
      log('slides.read', wc, options ?? null)
      return answer(spec.read)
    },
    saveDeck: async (wc: number, path: string, overwrite: boolean) => {
      log('slides.save', wc, path, overwrite)
      if (spec.saveThrows !== undefined) throw new Error(spec.saveThrows)
      return { path: spec.savePath ?? path }
    },
  }
  if ('withholds' in spec) {
    control.deckWithholds = async (wc: number) => {
      log('slides.withholds', wc)
      return answer(spec.withholds)
    }
  }
  return control
}

function sheetsControl(spec: Spec, log: Log): Any {
  return {
    openBlankTab: async () => {
      log('sheets.open')
      return 5
    },
    runCommand: async (wc: number, command: string, payload: unknown) => {
      log('sheets.run', wc, command, payload)
      return answer(spec.run)
    },
  }
}

function docsControl(spec: Spec, log: Log): Any {
  return {
    openBlankTab: async () => {
      log('docs.open')
      return 1
    },
    runCommand: async (wc: number, command: string, payload: unknown) => {
      log('docs.run', wc, command, payload)
      return answer(spec.run)
    },
  }
}

function hooksOf(spec: Spec, log: Log): Any {
  return {
    proposeSkill: async (input: unknown, context: { openTabs(): Promise<unknown[]> }) => {
      log('hooks.proposeSkill', input)
      if (spec.readTabs) {
        try {
          const tabs = (await context.openTabs()) as Spec[]
          log(
            'tabs',
            tabs.map((t) => ({
              title: t.title,
              ...(t.filePath !== undefined ? { filePath: t.filePath } : {}),
              dirty: t.dirty,
            })),
          )
        } catch (error) {
          log('tabs threw', (error as Error).message)
        }
      }
      answer(spec.propose)
    },
    proposeInstall: async (address: string) => {
      log('hooks.proposeInstall', address)
      answer(spec.install)
    },
  }
}

function tabsReader(spec: Spec, log: Log): () => Promise<Any[]> {
  return async () => {
    log('openTabs')
    if (spec.throws !== undefined) throw new Error(spec.throws)
    return spec.list
  }
}

function depsOf(spec: Spec, log: Log): Any {
  const deps: Spec = { version: spec.version ?? '9.9.9', defaultSaveDir: () => '/save' }
  if (spec.docs) deps.docsControl = docsControl(spec.docs, log)
  if (spec.slides) deps.slidesControl = slidesControl(spec.slides, log)
  if (spec.sheets) deps.sheetsControl = sheetsControl(spec.sheets, log)
  if (spec.open) deps.openDocumentsControl = openControl(spec.open, log)
  if (spec.resolve) {
    deps.resolveTarget = async (target: string, family: string) => {
      log('resolve', target, family)
      return answer(spec.resolve)
    }
  }
  if (spec.skill) deps.skillTools = hooksOf(spec.skill, log)
  return deps
}

const box = globalThis as Record<symbol, unknown>

/** the engines of the tools the case reaches: the redactor, the PDF and HWP readers */
function withEngines<T>(spec: Spec, log: Log, run: () => Promise<T>): Promise<T> {
  box[REDACT_BOX] = {
    markdown: (source: string) => {
      log('redactMarkdownSource', source)
      return `md<${source}>`
    },
    html: (source: string) => {
      log('redactHtmlSource', source)
      return `html<${source}>`
    },
  }
  const world = spec.pdf ?? {}
  box[PDF_BOX] = async (bytes: Uint8Array, options: Spec) => {
    log('readPdfText', Buffer.from(bytes).toString('utf8'), options)
    if (options.charBudget === 0) {
      return { pageCount: world.pageCount ?? 1, info: {}, pages: [], truncated: false }
    }
    return {
      pageCount: world.pageCount ?? 1,
      info: world.info ?? {},
      pages: world.pages ?? [],
      truncated: false,
    }
  }
  box[HWP_BOX] = async (bytes: Uint8Array) => {
    log('hwpToText', Buffer.from(bytes).toString('utf8'))
    return spec.hwp ?? 'hwp text'
  }
  return run().finally(() => {
    delete box[REDACT_BOX]
    delete box[PDF_BOX]
    delete box[HWP_BOX]
  })
}

// ---------------------------------------------------------------------------
// the plain functions
// ---------------------------------------------------------------------------

async function skillCall(spec: Spec, cx: TsContext): Promise<unknown> {
  const hooks = spec.hooks ? hooksOf(spec.hooks, cx.log) : undefined
  const open = spec.tabs ? tabsReader(spec.tabs, cx.log) : undefined
  const tools = agentMcp.createAgentSkillTools(hooks, open) as Spec[]
  if (spec.list) return await listed(tools)
  return await callTool(tools, spec.tool, spec.args)
}

/** a step's answer: its value, or what it threw */
async function stepAnswer(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await run()
    return value === undefined ? { undef: true } : { value }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function slidesScript(spec: Spec, cx: TsContext): Promise<unknown> {
  const control = slidesControl(spec.control, cx.log)
  const wrapped = agentMcp.withholdingSlides(control) as Any
  const out: unknown[] = []
  for (const step of spec.steps as Spec[]) {
    out.push(
      await stepAnswer(async () => {
        switch (step.op) {
          case 'open':
            return await wrapped.openBlankTab()
          case 'read':
            return await wrapped.readDeck(step.wc, step.options)
          case 'txn':
            return await wrapped.runTxn(step.wc, step.req)
          case 'save':
            return await wrapped.saveDeck(step.wc, step.path, step.overwrite)
          case 'withholds':
            return wrapped.deckWithholds ? await wrapped.deckWithholds(step.wc) : 'absent'
          default:
            throw new Error(`unknown step ${step.op}`)
        }
      }),
    )
  }
  return out
}

async function openScript(spec: Spec, cx: TsContext): Promise<unknown> {
  const control = openControl(spec.control, cx.log)
  const wrapped = agentMcp.withholdingOpenDocuments(control) as Any
  const out: unknown[] = []
  await withEngines({}, cx.log, async () => {
    for (const step of spec.steps as Spec[]) {
      out.push(
        await stepAnswer(async () => {
          switch (step.op) {
            case 'list':
              return await wrapped.list()
            case 'read':
              return await wrapped.read(step.tab)
            case 'close':
              return await wrapped.close(step.tab, { unsaved: step.unsaved ?? 'save' })
            case 'save':
              return await wrapped.save(step.tab)
            default:
              throw new Error(`unknown step ${step.op}`)
          }
        }),
      )
    }
  })
  return out
}

async function build(spec: Spec, cx: TsContext): Promise<unknown> {
  const deps = depsOf(spec.deps ?? {}, cx.log)
  const tools = agentMcp.buildAgentMcpTools(deps, spec.root, spec.platform) as Spec[]
  return await withEngines(spec, cx.log, async () => {
    if (spec.tool === undefined) return tools.map((tool) => tool.name)
    return await callTool(tools, spec.tool, spec.args)
  })
}

// ---------------------------------------------------------------------------
// the HTTP client of the scenarios
// ---------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const settle = (ms = 40): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))

interface Open {
  req: http.ClientRequest
  text: string
  ended: boolean
  failed: boolean
  taken: number
  status: number
  headers: http.IncomingHttpHeaders
  namesOnly: boolean
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

interface Target {
  port: number
  token: string
}

class Net {
  ids: string[] = []
  ports = new Set<number>()
  tokens: string[] = []
  /** the session ids of each service, in the order they first appeared */
  sessions: string[][] = []
  streams = new Map<string, Open>()

  norm(text: string): string {
    let out = text
    for (const [i, token] of this.tokens.entries()) out = out.split(token).join(`<token${i + 1}>`)
    out = out.replace(UUID, (id) => {
      let at = this.ids.indexOf(id)
      if (at < 0) at = this.ids.push(id) - 1
      return `<id${at + 1}>`
    })
    for (const port of this.ports) out = out.replace(new RegExp(`\\b${port}\\b`, 'g'), '$PORT')
    return out
  }

  /** a frame as its JSON-RPC message, with `tools/list` shown as names when asked */
  frameValue(frame: string, namesOnly: boolean): unknown {
    const line = /^data: (.*)$/m.exec(frame)
    if (!line) return this.norm(frame)
    const value = JSON.parse(this.norm(line[1]!)) as Spec
    if (namesOnly && Array.isArray(value.result?.tools)) {
      value.result.tools = value.result.tools.map((t: Spec) => t.name)
    }
    return value
  }

  send(step: Spec, index: number, target: Target | undefined): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (!target) {
        resolve({ error: 'aborted' })
        return
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      if (step.auth === undefined || step.auth === 'good') {
        headers.authorization = `Bearer ${target.token}`
      } else if (step.auth === 'bad') headers.authorization = 'Bearer nope'
      if (step.session)
        headers['mcp-session-id'] = this.sessions[index]?.[step.session - 1] ?? 'unknown'
      const method = String(step.method ?? 'POST')
      let body: string | undefined
      if (step.op === 'rpc' || step.op === 'notify') {
        body = JSON.stringify({
          jsonrpc: '2.0',
          ...(step.op === 'rpc' ? { id: step.id ?? 1 } : {}),
          method: step.rpc,
          ...(step.params !== undefined ? { params: step.params } : {}),
        })
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
        namesOnly: step.namesOnly === true,
      }
      const done = (): void => open.wake?.()
      open.req = http.request(
        { host: '127.0.0.1', port: target.port, method, path: '/mcp', headers, agent: false },
        (res) => {
          open.status = res.statusCode ?? 0
          open.headers = res.headers
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

      const finish = (): void => {
        if (open.failed && !open.ended && open.status === 0) {
          resolve({ error: 'aborted' })
          return
        }
        const out: Record<string, unknown> = { status: open.status }
        const type = open.headers['content-type']
        if (type) out.type = String(type)
        const sid = open.headers['mcp-session-id']
        if (sid) {
          const known = (this.sessions[index] ??= [])
          if (!known.includes(String(sid))) known.push(String(sid))
          out.session = this.norm(String(sid))
        }
        const list = framesOf(open.text)
        if (String(type ?? '').startsWith('text/event-stream')) {
          out.frames = list.map((f) => this.frameValue(f, open.namesOnly))
        } else if (open.text) {
          out.json = JSON.parse(this.norm(open.text))
        }
        if (!open.ended) out.ended = false
        if (typeof step.open === 'string') {
          this.streams.set(step.open, open)
          open.taken = list.length
        } else if (!open.ended) {
          open.req.destroy()
        }
        resolve(out)
      }
      let quiet: ReturnType<typeof realSetTimeout> | undefined
      open.wake = () => {
        clearTimeout(quiet)
        if (open.ended || (open.failed && open.status === 0)) {
          open.wake = undefined
          finish()
          return
        }
        if (open.status !== 0) {
          quiet = realSetTimeout(() => {
            open.wake = undefined
            finish()
          }, 60)
        }
      }
      realSetTimeout(() => open.wake?.(), 1500)
    })
  }

  async read(id: string): Promise<Record<string, unknown>> {
    const open = this.streams.get(id)!
    await settle()
    const list = framesOf(open.text)
    const shown = list.slice(open.taken)
    open.taken = list.length
    const out: Record<string, unknown> = {
      frames: shown.map((f) => this.frameValue(f, open.namesOnly)),
    }
    if (open.ended || open.failed) out.closed = true
    return out
  }

  async close(id: string): Promise<void> {
    this.streams.get(id)!.req.destroy()
    this.streams.delete(id)
    await settle()
  }

  destroyAll(): void {
    for (const open of this.streams.values()) open.req.destroy()
  }
}

/** the steps both scenarios share; `undefined` when the step is not one of them */
async function httpStep(
  net: Net,
  step: Spec,
  targets: (Target | undefined)[],
  out: Record<string, unknown>,
): Promise<boolean> {
  const index = Math.max(0, (step.relay ?? 1) - 1)
  switch (step.op) {
    case 'rpc':
    case 'notify':
      Object.assign(out, await net.send(step, index, targets[index]))
      return true
    case 'read':
      Object.assign(out, await net.read(String(step.id)))
      return true
    case 'close':
      await net.close(String(step.id))
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// agent-mcp.scenario
// ---------------------------------------------------------------------------

async function agentScenario(spec: Spec, cx: TsContext): Promise<unknown> {
  void cx
  const logs: unknown[][] = []
  const log: Log = (...args) => logs.push(args)
  const net = new Net()
  const results: unknown[] = []
  const deps = depsOf(spec.deps ?? {}, log)
  const root = String(spec.root)
  let server = undefined as AgentMcpServer | undefined
  let target: Target | undefined
  const flush = (out: Record<string, unknown>): void => {
    if (logs.length) out.logs = logs.splice(0).map((line) => line.map(normValue))
  }
  const normValue = (value: unknown): unknown =>
    JSON.parse(net.norm(JSON.stringify(value) ?? 'null'))
  try {
    await withEngines(spec, log, async () => {
      server = await agentMcp.startAgentMcpServer(deps, root)
      const port = Number(new URL(server.url).port)
      net.ports.add(port)
      net.tokens.push(server.token)
      target = { port, token: server.token }
      results.push({ op: 'init', url: net.norm(server.url), token: net.norm(server.token) })
      for (const step of spec.steps as Spec[]) {
        const out: Record<string, unknown> = { op: step.op }
        if (!(await httpStep(net, step, [target], out))) {
          if (step.op === 'stop') {
            await server.stop()
            target = undefined
          } else throw new Error(`unknown step ${step.op}`)
        }
        flush(out)
        results.push(out)
      }
    })
  } finally {
    net.destroyAll()
    await server?.stop().catch(() => undefined)
  }
  return results
}

// ---------------------------------------------------------------------------
// agent-mcp-relay.scenario
// ---------------------------------------------------------------------------

async function relayScenario(spec: Spec, cx: TsContext): Promise<unknown> {
  void cx
  const logs: unknown[][] = []
  const log: Log = (...args) => logs.push(args)
  const net = new Net()
  const results: unknown[] = []
  let list = JSON.parse(JSON.stringify(spec.list ?? [])) as Spec[]
  const calls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  const asks: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  const hub = {
    editorList: () => {
      log('hub.editorList')
      return JSON.parse(JSON.stringify(list))
    },
    call: (caller: string, server: string, tool: string, input: unknown, callId: string) => {
      log('hub.call', caller, server, tool, input, callId)
      return new Promise<unknown>((resolve, reject) => calls.push({ resolve, reject }))
    },
    cancel: (caller: string, callId: string) => {
      log('hub.cancel', caller, callId)
    },
  }
  const ask = (request: unknown, signal: AbortSignal) => {
    const n = asks.length + 1
    log('ask', n, request)
    signal.addEventListener('abort', () => log('ask.abort', n), { once: true })
    return new Promise<unknown>((resolve, reject) => asks.push({ resolve, reject }))
  }
  const normValue = (value: unknown): unknown =>
    JSON.parse(net.norm(JSON.stringify(value) ?? 'null'))
  const flush = (out: Record<string, unknown>): void => {
    if (logs.length) out.logs = logs.splice(0).map((line) => line.map(normValue))
  }
  let relays: AgentMcpRelays | undefined
  try {
    relays = await relay.startAgentMcpRelays({
      hub: hub as never,
      ask: ask as never,
      caller: spec.caller ?? 'win1',
      version: spec.version ?? '1.0.0',
    })
    const targets: Target[] = []
    for (const r of relays.relays) {
      const port = Number(new URL(r.url).port)
      net.ports.add(port)
      net.tokens.push(r.token)
      targets.push({ port, token: r.token })
    }
    const init: Record<string, unknown> = {
      op: 'init',
      relays: relays.relays.map((r) => ({
        name: r.name,
        url: net.norm(r.url),
        token: net.norm(r.token),
        tools: r.tools,
      })),
      keepResultsInside: relays.keepResultsInside,
    }
    flush(init)
    results.push(init)
    let live: (Target | undefined)[] = targets
    for (const step of spec.steps as Spec[]) {
      const out: Record<string, unknown> = { op: step.op }
      if (!(await httpStep(net, step, live, out))) {
        switch (step.op) {
          case 'editorList':
            list = JSON.parse(JSON.stringify(step.list))
            break
          case 'askAnswer': {
            const entry = asks[Number(step.n) - 1]!
            if (step.reject) entry.reject(new Error('asker failed'))
            else entry.resolve(step.answer)
            await settle()
            break
          }
          case 'hubAnswer': {
            const entry = calls[Number(step.n) - 1]!
            if (step.reject) entry.reject(new Error('hub failed'))
            else entry.resolve(step.answer)
            await settle()
            break
          }
          case 'stop':
            await relays.stop()
            live = []
            break
          default:
            throw new Error(`unknown step ${step.op}`)
        }
      }
      flush(out)
      results.push(out)
    }
  } finally {
    net.destroyAll()
    await relays?.stop().catch(() => undefined)
  }
  return results
}

// ---------------------------------------------------------------------------
// cases: the skill tools
// ---------------------------------------------------------------------------

const PROPOSE = (args: Spec, extra: Spec = {}, note?: string): Case => ({
  args: [{ tool: 'propose_skill', args, hooks: {}, ...extra }],
  ...(note ? { note } : {}),
})
const INSTALL = (args: Spec, extra: Spec = {}, note?: string): Case => ({
  args: [{ tool: 'propose_skill_install', args, hooks: {}, ...extra }],
  ...(note ? { note } : {}),
})
const FULL = {
  title: 'Meeting minutes',
  name: 'meeting-minutes',
  description: 'Write minutes.',
  body: '# Steps\n1. list decisions',
  wantsTemplate: true,
  targetId: 'app:meeting-minutes',
  suggestedTemplatePath: '/proj/minutes.docx',
}
const TABS = {
  list: [
    { title: 'Report', filePath: '/proj/a.docx', dirty: true },
    { title: 'Untitled', dirty: false },
  ],
}

const skillCases: Case[] = [
  { args: [{ list: true, hooks: {} }], note: 'the tools as the SDK lists them' },
  PROPOSE(FULL, {}, 'every field'),
  PROPOSE({ title: 'T', description: 'D', body: 'B' }, {}, 'only the required fields'),
  PROPOSE(FULL, { hooks: { readTabs: true }, tabs: TABS }, 'the hook reads the open tabs'),
  PROPOSE(FULL, { hooks: { readTabs: true } }, 'no tab reader: the default answers nothing'),
  PROPOSE(
    FULL,
    { hooks: { readTabs: true }, tabs: { throws: 'tabs are gone' } },
    'the tab reader throws',
  ),
  PROPOSE(FULL, { hooks: { propose: { throws: 'the window is closed' } } }, 'the hook refuses'),
  PROPOSE(FULL, { hooks: undefined }, 'no hooks: the card is not available'),
  PROPOSE({ title: '', description: 'D', body: 'B' }, {}, 'an empty title'),
  PROPOSE({ title: '  \t ', description: 'D', body: 'B' }, {}, 'a blank title'),
  PROPOSE({ title: 'T', description: 'D', body: '' }, {}, 'an empty body'),
  PROPOSE({ title: 'T', description: 'D', body: ' \n\t' }, {}, 'a blank body'),
  PROPOSE({ title: 'T', description: 'D', body: ' x ' }, {}, 'the body is not trimmed'),
  PROPOSE(
    { title: '\u00a0\ufeff T \u2003', name: ' n ', description: '\n D \n', body: 'B' },
    {},
    'trimmed with the JS white space',
  ),
  PROPOSE(
    {
      title: 'a'.repeat(498) + '\u{1F600}b',
      name: 'n'.repeat(250),
      description: 'd'.repeat(6000),
      body: 'b'.repeat(300_000),
      targetId: 't'.repeat(600),
      suggestedTemplatePath: 'p'.repeat(5000),
    },
    {},
    'every text cut to its length',
  ),
  PROPOSE({ ...FULL, wantsTemplate: false }, {}, 'wantsTemplate false'),
  PROPOSE({ ...FULL, wantsTemplate: 'true' }, {}, 'wantsTemplate is only true when it is'),
  PROPOSE({ title: 'Quote "me"', description: 'D', body: 'B' }, {}, 'the title is quoted as JSON'),
  PROPOSE({ title: 'Line\nbreak', description: 'D', body: 'B' }, {}, 'a title with a line break'),
  INSTALL({ address: 'https://github.com/o/r/tree/main/skills/x' }, {}, 'an address'),
  INSTALL({ address: '  o/r@skill  ' }, {}, 'an address with spaces'),
  INSTALL({ address: '' }, {}, 'an empty address'),
  INSTALL({ address: ' \n ' }, {}, 'a blank address'),
  INSTALL({ address: 'a'.repeat(2100) }, {}, 'an address cut to 2048'),
  INSTALL({ address: 'o/r' }, { hooks: { install: { throws: 'refused' } } }, 'the hook refuses'),
  INSTALL({ address: 'o/r' }, { hooks: undefined }, 'no hooks: no install proposals'),
  { args: [{ tool: 'nope', args: {}, hooks: {} }], note: 'a tool that is not there' },
]
// `hooks: undefined` is dropped by JSON: the key is left out for the default
skillCases.forEach((c) => {
  const spec = c.args[0] as Spec
  if (!('hooks' in spec) || spec.hooks === undefined) delete spec.hooks
})

// ---------------------------------------------------------------------------
// cases: withholdingSlides
// ---------------------------------------------------------------------------

const slidesCase = (control: Spec, steps: Spec[], note: string): Case => ({
  args: [{ control, steps }],
  note,
})
const TXN = { ops: [{ type: 'add' }], isolation: 'atomic', dryRun: true }

const slidesCases: Case[] = [
  slidesCase({ read: { value: { slides: [] } } }, [{ op: 'read', wc: 3 }], 'reads withhold'),
  slidesCase(
    { read: { value: 'deck' } },
    [{ op: 'read', wc: 4, options: { withhold: false } }],
    'the caller options are ignored',
  ),
  slidesCase({ read: { throws: 'no deck' } }, [{ op: 'read', wc: 3 }], 'the read throws'),
  slidesCase(
    { withholds: { value: false }, txn: { value: { ok: true } } },
    [{ op: 'txn', wc: 3, req: TXN }],
    'a deck that withholds nothing is edited',
  ),
  slidesCase(
    { withholds: { value: true }, txn: { value: { ok: true } } },
    [{ op: 'txn', wc: 3, req: TXN }],
    'a deck that withholds is not edited',
  ),
  slidesCase(
    { txn: { value: { ok: true } } },
    [{ op: 'txn', wc: 3, req: { ops: [] } }],
    'no way to tell: the deck is taken to withhold',
  ),
  slidesCase(
    { withholds: { throws: 'cannot tell' }, txn: { value: 1 } },
    [{ op: 'txn', wc: 3, req: { ops: [] } }],
    'the check throws',
  ),
  slidesCase(
    { withholds: { value: false }, txn: { throws: 'bad op' } },
    [{ op: 'txn', wc: 3, req: { ops: [1] } }],
    'the transaction throws',
  ),
  slidesCase(
    { withholds: { value: false }, txn: { undef: true } },
    [{ op: 'txn', wc: 3, req: { ops: [], isolation: 'per_op' } }],
    'the transaction answers nothing',
  ),
  slidesCase(
    { withholds: { value: true } },
    [
      { op: 'open' },
      { op: 'save', wc: 3, path: '/a.pptx', overwrite: true },
      { op: 'withholds', wc: 3 },
    ],
    'the other methods pass through',
  ),
  slidesCase(
    {},
    [
      { op: 'withholds', wc: 3 },
      { op: 'save', wc: 1, path: '/b.pptx', overwrite: false },
    ],
    'no deckWithholds on the control',
  ),
  slidesCase(
    { saveThrows: 'disk full' },
    [{ op: 'save', wc: 2, path: '/c.pptx', overwrite: false }],
    'save throws',
  ),
  slidesCase({ open: { throws: 'no tab' } }, [{ op: 'open' }], 'open throws'),
]

// ---------------------------------------------------------------------------
// cases: withholdingOpenDocuments
// ---------------------------------------------------------------------------

const openCase = (control: Spec, steps: Spec[], note: string): Case => ({
  args: [{ control, steps }],
  note,
})
const T = {
  md: tab('m1', 'markdown', 'Notes', '/p/n.md'),
  html: tab('h1', 'html', 'Page', '/p/p.html'),
  docs: tab('d1', 'docs', 'Report', '/p/r.docx', true),
  slides: tab('s1', 'slides', 'Deck'),
  sheets: tab('x1', 'sheets', 'Budget'),
}

const openCases: Case[] = [
  openCase({ list: [T.md, T.docs] }, [{ op: 'list' }], 'the list passes through'),
  openCase({ list: { throws: 'no tabs' } }, [{ op: 'list' }], 'the list throws'),
  openCase(
    { read: { value: '# Title {{secret}}' } },
    [{ op: 'read', tab: T.md }],
    'markdown is redacted',
  ),
  openCase({ read: { value: '<p>x</p>' } }, [{ op: 'read', tab: T.html }], 'html is redacted'),
  openCase({ read: { value: 'plain' } }, [{ op: 'read', tab: T.docs }], 'other kinds are not'),
  openCase(
    { read: { value: { a: 1 } } },
    [{ op: 'read', tab: T.sheets }],
    'an object passes through',
  ),
  openCase(
    { read: { value: 'deck' } },
    [{ op: 'read', tab: T.slides }],
    'a deck is read with read_deck',
  ),
  openCase(
    { read: { undef: true } },
    [{ op: 'read', tab: T.md }],
    'markdown of nothing is "undefined"',
  ),
  openCase({ read: { value: null } }, [{ op: 'read', tab: T.html }], 'html of null is "null"'),
  openCase({ read: { value: 42 } }, [{ op: 'read', tab: T.md }], 'a number is written out'),
  openCase(
    { read: { value: { a: 1 } } },
    [{ op: 'read', tab: T.md }],
    'an object is "[object Object]"',
  ),
  openCase({ read: { value: [1, [2, 3]] } }, [{ op: 'read', tab: T.html }], 'an array is joined'),
  openCase({ read: { throws: 'gone' } }, [{ op: 'read', tab: T.md }], 'the read throws'),
  openCase(
    { close: { value: { savedPath: '/p/x.md' } } },
    [
      { op: 'close', tab: T.md, unsaved: 'save' },
      { op: 'close', tab: T.docs, unsaved: 'discard' },
    ],
    'closing is refused',
  ),
  openCase(
    { save: { value: { savedPath: '/p/x.md' } } },
    [{ op: 'save', tab: T.md }],
    'saving is refused',
  ),
]

// ---------------------------------------------------------------------------
// cases: buildAgentMcpTools
// ---------------------------------------------------------------------------

const buildCase = (spec: Spec, note: string): Case => ({
  args: [{ root: '$DIR/proj', ...spec }],
  files: {
    'proj/a.pdf': 'PDFBYTES',
    'proj/sub/b.hwp': 'HWPBYTES',
    'outside/c.pdf': 'OUTSIDE',
    'outside/d.hwp': 'OUTSIDE',
    'proj2/e.pdf': 'SIBLING',
  },
  note,
})
const ALL = {
  docs: {},
  slides: { withholds: { value: false } },
  sheets: {},
  open: { list: [T.md, T.docs, T.slides] },
  skill: {},
}
const PDF_WORLD = {
  pdf: {
    pageCount: 1,
    info: { title: 'The Paper' },
    pages: [{ page: 1, widthPt: 595, heightPt: 842, chars: 4, text: 'text', hasTextLayer: true }],
  },
}

const buildCases: Case[] = [
  buildCase({}, 'no controls: the tools that exist without them'),
  buildCase({ deps: ALL }, 'every control: the allowlist, in the order of the tool sets'),
  buildCase({ deps: { open: ALL.open } }, 'only the open-documents control'),
  buildCase({ deps: { docs: {}, resolve: { value: 1 } } }, 'docs and a target resolver'),
  buildCase(
    { deps: ALL, tool: 'open_documents', args: { action: 'list' } },
    'open_documents lists',
  ),
  buildCase(
    {
      deps: { open: { list: [T.md], read: { value: '# {{x}}' } } },
      tool: 'open_documents',
      args: { action: 'read', target: 'm1' },
    },
    'open_documents reads markdown redacted',
  ),
  buildCase(
    {
      deps: { open: { list: [T.md], close: { value: {} } } },
      tool: 'open_documents',
      args: { action: 'close', target: 'm1' },
    },
    'open_documents cannot close',
  ),
  buildCase(
    {
      deps: { open: { list: [T.md], save: { value: { savedPath: '/x' } } } },
      tool: 'open_documents',
      args: { action: 'save', target: 'm1' },
    },
    'open_documents cannot save',
  ),
  buildCase(
    {
      deps: { open: { list: [T.slides] } },
      tool: 'open_documents',
      args: { action: 'read', target: 's1' },
    },
    'open_documents does not read a deck',
  ),
  buildCase(
    {
      deps: { skill: { readTabs: true }, open: { list: [T.docs, T.md] } },
      tool: 'propose_skill',
      args: { title: 'T', description: 'D', body: 'B' },
    },
    'propose_skill sees the open tabs through the control',
  ),
  buildCase(
    { deps: { skill: {} }, tool: 'propose_skill_install', args: { address: 'o/r@s' } },
    'an install proposal',
  ),
  buildCase(
    { deps: {}, tool: 'propose_skill_install', args: { address: 'o/r@s' } },
    'no skill hooks',
  ),
  buildCase({ tool: 'create_docx', args: { title: 'x' } }, 'a tool the allowlist drops'),
  buildCase(
    { tool: 'read_pdf', args: { path: '$DIR/proj/a.pdf' }, ...PDF_WORLD },
    'read_pdf inside the project',
  ),
  buildCase(
    { tool: 'read_pdf', args: { path: '$DIR/outside/c.pdf' } },
    'read_pdf outside the project',
  ),
  buildCase(
    { tool: 'read_pdf', args: { path: '$DIR/proj2/e.pdf' } },
    'read_pdf in a sibling folder of the same prefix',
  ),
  buildCase(
    { tool: 'read_pdf', args: { path: '$DIR/proj/../outside/c.pdf' } },
    'read_pdf through ..',
  ),
  buildCase(
    { tool: 'read_pdf', args: { path: '$DIR/proj' }, ...PDF_WORLD },
    'read_pdf of the project folder itself',
  ),
  buildCase({ tool: 'read_pdf', args: { path: '' } }, 'read_pdf of an empty path'),
  buildCase({ tool: 'read_pdf', args: { path: 5 } }, 'read_pdf of a number'),
  buildCase({ tool: 'read_pdf', args: {} }, 'read_pdf without a path'),
  buildCase(
    { tool: 'read_pdf', args: { path: 'a.pdf' } },
    'read_pdf of a relative path resolves under the root',
  ),
  buildCase(
    { tool: 'read_hwp', args: { path: '$DIR/proj/sub/b.hwp' }, hwp: 'text of it' },
    'read_hwp inside the project',
  ),
  buildCase(
    { tool: 'read_hwp', args: { path: '$DIR/outside/d.hwp' } },
    'read_hwp outside the project',
  ),
  buildCase(
    { tool: 'read_hwp', args: { path: 'sub/b.hwp' }, hwp: 'relative' },
    'read_hwp of a relative path',
  ),
  buildCase(
    {
      platform: 'win32',
      root: 'C:\\Work\\Proj',
      tool: 'read_pdf',
      args: { path: 'c:/work/proj/a.pdf' },
    },
    'win32: inside, any case and slash',
  ),
  buildCase(
    {
      platform: 'win32',
      root: 'C:\\Work\\Proj',
      tool: 'read_pdf',
      args: { path: 'C:\\Work\\Proj2\\a.pdf' },
    },
    'win32: a sibling of the same prefix',
  ),
  buildCase(
    {
      platform: 'win32',
      root: 'C:\\Work\\Proj',
      tool: 'read_pdf',
      args: { path: 'D:\\Work\\Proj\\a.pdf' },
    },
    'win32: another drive',
  ),
  buildCase(
    {
      platform: 'win32',
      root: 'C:\\Work\\Proj',
      tool: 'read_hwp',
      args: { path: 'C:\\Work\\Proj\\..\\x.hwp' },
    },
    'win32: out through ..',
  ),
  buildCase(
    {
      platform: 'win32',
      root: 'C:\\Work\\Proj',
      tool: 'read_hwp',
      args: { path: '\\\\server\\share\\a.hwp' },
    },
    'win32: a share',
  ),
  buildCase(
    { platform: 'linux', root: '/Work/Proj', tool: 'read_pdf', args: { path: '/work/proj/a.pdf' } },
    'posix: case matters',
  ),
  buildCase(
    { platform: 'linux', root: '/Work/Proj', tool: 'read_pdf', args: { path: '/Work/Proj/a.pdf' } },
    'posix: inside',
  ),
  buildCase(
    {
      platform: 'linux',
      root: '/Work/Proj',
      tool: 'read_pdf',
      args: { path: '/Work/Proj/../Other/a.pdf' },
    },
    'posix: out through ..',
  ),
  buildCase(
    {
      platform: 'linux',
      root: '/Work/Proj',
      tool: 'read_pdf',
      args: { path: '/Work/Proj/..foo/a.pdf' },
    },
    'posix: a folder that starts with two dots',
  ),
]

// ---------------------------------------------------------------------------
// cases: agent-mcp.scenario
// ---------------------------------------------------------------------------

const INIT = (id = 1): Spec => ({
  op: 'rpc',
  rpc: 'initialize',
  id,
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'case', version: '1' },
  },
})
const NOTICE: Spec = { op: 'notify', rpc: 'notifications/initialized', session: 1 }
const OPEN: Spec[] = [INIT(), NOTICE]
const tcall = (id: number, tool: string, args: unknown, extra: Spec = {}): Spec => ({
  op: 'rpc',
  rpc: 'tools/call',
  id,
  session: 1,
  params: { name: tool, arguments: args },
  ...extra,
})
const agentCase = (spec: Spec, note: string): Case => ({
  args: [{ root: '$DIR/proj', ...spec }],
  files: { 'proj/a.pdf': 'PDFBYTES', 'proj/sub/b.hwp': 'HWPBYTES', 'outside/c.pdf': 'OUTSIDE' },
  note,
})

const agentCases: Case[] = [
  agentCase(
    {
      deps: ALL,
      steps: [...OPEN, { op: 'rpc', rpc: 'tools/list', id: 2, session: 1, namesOnly: true }],
    },
    'a session lists the allowlisted tools',
  ),
  agentCase(
    {
      deps: {},
      steps: [...OPEN, { op: 'rpc', rpc: 'tools/list', id: 2, session: 1, namesOnly: true }],
    },
    'no controls',
  ),
  agentCase(
    {
      deps: ALL,
      steps: [...OPEN, { op: 'rpc', rpc: 'tools/list', id: 2, session: 1 }],
    },
    'the full listing of every tool',
  ),
  agentCase(
    { steps: [INIT(), { ...INIT(2), auth: 'none' }, { ...INIT(3), auth: 'bad' }] },
    'the token is required',
  ),
  agentCase(
    { deps: ALL, steps: [...OPEN, tcall(2, 'open_documents', { action: 'list' })] },
    'open_documents',
  ),
  agentCase(
    {
      deps: { open: { list: [T.md], read: { value: '# {{x}}' } } },
      steps: [...OPEN, tcall(2, 'open_documents', { action: 'read', target: 'm1' })],
    },
    'markdown is redacted',
  ),
  agentCase(
    {
      deps: { open: { list: [T.md], close: { value: {} } } },
      steps: [...OPEN, tcall(2, 'open_documents', { action: 'close', target: 'm1' })],
    },
    'closing is refused: a tool error',
  ),
  agentCase(
    {
      deps: { skill: { readTabs: true }, open: { list: [T.docs] } },
      steps: [...OPEN, tcall(2, 'propose_skill', { title: 'T', description: 'D', body: 'B' })],
    },
    'propose_skill',
  ),
  agentCase(
    {
      deps: { skill: {} },
      steps: [
        ...OPEN,
        tcall(2, 'propose_skill', { title: '', description: 'D', body: 'B' }),
        tcall(3, 'propose_skill_install', { address: 'o/r@s' }),
      ],
    },
    'a refused card, an install proposal',
  ),
  agentCase(
    {
      steps: [
        ...OPEN,
        tcall(2, 'propose_skill_install', { address: 'o/r@s' }),
        tcall(3, 'propose_skill', {}),
      ],
    },
    'no window; arguments the schema refuses',
  ),
  agentCase(
    {
      ...PDF_WORLD,
      steps: [
        ...OPEN,
        tcall(2, 'read_pdf', { path: '$DIR/proj/a.pdf' }),
        tcall(3, 'read_pdf', { path: '$DIR/outside/c.pdf' }),
      ],
    },
    'read_pdf only inside the project',
  ),
  agentCase(
    {
      hwp: 'hangul',
      steps: [
        ...OPEN,
        tcall(2, 'read_hwp', { path: '$DIR/proj/sub/b.hwp' }),
        tcall(3, 'read_hwp', { path: '$DIR/outside/c.pdf' }),
      ],
    },
    'read_hwp only inside the project',
  ),
  agentCase(
    { steps: [...OPEN, tcall(2, 'create_docx', { title: 'x' }), tcall(3, 'nope', {})] },
    'tools the session does not have',
  ),
  agentCase(
    {
      deps: ALL,
      steps: [...OPEN, { op: 'stop' }, { op: 'rpc', rpc: 'tools/list', id: 3, session: 1 }],
    },
    'stopped: the connection is refused',
  ),
  agentCase(
    {
      deps: ALL,
      steps: [
        INIT(),
        { ...INIT(2), session: undefined },
        { op: 'notify', rpc: 'notifications/initialized', session: 2 },
        { op: 'rpc', rpc: 'tools/list', id: 3, session: 2, namesOnly: true },
      ],
    },
    'two sessions get a tool set each',
  ),
]

// ---------------------------------------------------------------------------
// cases: agent-mcp-relay.scenario
// ---------------------------------------------------------------------------

const rtool = (name: string, server: string, permission: string, extra: Spec = {}): Spec => ({
  name,
  exposedName: `mcp__${server}__${name}`,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  permission,
  pending: false,
  ...extra,
})
const rserver = (name: string, tools: Spec[], extra: Spec = {}): Spec => ({
  name,
  status: 'connected',
  newToolCount: 0,
  keepResultsInside: true,
  instructions: null,
  tools,
  ...extra,
})

const NOTES = rserver('notes', [
  rtool('read', 'notes', 'always'),
  rtool('write', 'notes', 'ask'),
  rtool('wipe', 'notes', 'off'),
])
const OPENED: Spec[] = [INIT(), NOTICE]
const rcall = (id: number, tool: string, args: unknown = { q: 'x' }, extra: Spec = {}): Spec =>
  tcall(id, tool, args, extra)
const relayCase = (spec: Spec, note: string): Case => ({ args: [spec], note })
const ANSWER = { ok: true, output: 'done', isError: false }

const relayCases: Case[] = [
  relayCase({ list: [], steps: [] }, 'nothing to relay'),
  relayCase(
    { list: [NOTES], steps: [...OPENED, { op: 'rpc', rpc: 'tools/list', id: 2, session: 1 }] },
    'a relay lists its tools: the off one is not offered',
  ),
  relayCase(
    {
      list: [
        NOTES,
        rserver('ghost', [rtool('x', 'ghost', 'off')]),
        rserver('Notes', [rtool('y', 'Notes', 'always')]),
        rserver('off', [rtool('z', 'off', 'always')], { status: 'disabled' }),
      ],
      steps: [...OPENED],
    },
    'servers that get no relay',
  ),
  relayCase(
    {
      list: [
        rserver('a', [rtool('t', 'a', 'always')], {
          instructions: 'Use me well.',
          keepResultsInside: false,
        }),
        rserver('b', [rtool('t', 'b', 'ask')], { instructions: '   ' }),
      ],
      steps: [
        INIT(),
        { ...INIT(2), relay: 2 },
        { ...NOTICE },
        { op: 'rpc', rpc: 'tools/list', id: 3, session: 1 },
      ],
    },
    'two relays: instructions, keepResultsInside, a token each',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        { op: 'rpc', rpc: 'tools/list', id: 2, session: 1 },
        {
          op: 'editorList',
          list: [
            rserver('notes', [
              rtool('read', 'notes', 'off'),
              rtool('write', 'notes', 'always', { pending: true }),
              rtool('wipe', 'notes', 'ask'),
            ]),
          ],
        },
        { op: 'rpc', rpc: 'tools/list', id: 3, session: 1 },
        { op: 'editorList', list: [] },
        { op: 'rpc', rpc: 'tools/list', id: 4, session: 1 },
        { op: 'editorList', list: [rserver('notes', [rtool('read', 'notes', 'always')])] },
        { op: 'rpc', rpc: 'tools/list', id: 5, session: 1 },
      ],
    },
    'the listing reads the hub again: a tool that changes drops out and comes back',
  ),
  relayCase(
    {
      list: [
        rserver('s', [
          rtool('a', 's', 'always', { inputSchema: { type: 'object', properties: {} } }),
          rtool('b', 's', 'always', { inputSchema: { type: 'string' } }),
          rtool('c', 's', 'always', { inputSchema: { properties: { x: 1 }, type: 'array' } }),
          rtool('d', 's', 'always', { inputSchema: [1, 2] }),
          rtool('e', 's', 'always', { inputSchema: null }),
          rtool('f', 's', 'always', { inputSchema: {} }),
          rtool('g', 's', 'always', { inputSchema: 5 }),
          rtool('h', 's', 'always', { inputSchema: { type: 'object', title: 'kept' } }),
        ]),
      ],
      steps: [...OPENED, { op: 'rpc', rpc: 'tools/list', id: 2, session: 1 }],
    },
    'objectSchema over every shape of schema',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'hello' }),
        { op: 'hubAnswer', n: 1, answer: ANSWER },
      ],
    },
    'an always tool: the call goes to the hub and the answer comes back',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'hello' }, { open: 'c1' }),
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
        rcall(3, 'read', undefined, { open: 'c2' }),
        { op: 'hubAnswer', n: 2, answer: { ok: false, error: 'notes: failed' } },
        { op: 'read', id: 'c2' },
        rcall(4, 'read', { q: 1 }, { open: 'c3' }),
        { op: 'hubAnswer', n: 3, reject: true },
        { op: 'read', id: 'c3' },
        rcall(5, 'read', {}, { open: 'c4' }),
        { op: 'hubAnswer', n: 4, answer: 'garbage' },
        { op: 'read', id: 'c4' },
      ],
    },
    'the hub refuses, rejects or answers nonsense',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [...OPENED, rcall(2, 'nope', {}), rcall(3, 'x'.repeat(100), {}), rcall(4, 'wipe', {})],
    },
    'a tool the session does not have, one that is off',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        {
          op: 'editorList',
          list: [rserver('notes', [rtool('read', 'notes', 'always', { pending: true })])],
        },
        rcall(2, 'read', {}),
      ],
    },
    'a tool that changed needs review: the hub is not reached',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        { op: 'editorList', list: [] },
        rcall(2, 'read', {}, { open: 'c1' }),
        { op: 'hubAnswer', n: 1, answer: { ok: false, error: 'notes: the tool is gone' } },
        { op: 'read', id: 'c1' },
      ],
    },
    'a tool that is gone goes on to the hub',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'write', { q: 'a' }, { open: 'c1' }),
        { op: 'askAnswer', n: 1, answer: { allow: true, scope: 'once' } },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
        rcall(3, 'write', { q: 'b' }, { open: 'c2' }),
        { op: 'askAnswer', n: 2, answer: { allow: true, scope: 'once' } },
        { op: 'hubAnswer', n: 2, answer: ANSWER },
        { op: 'read', id: 'c2' },
      ],
    },
    'an ask tool allowed once: the next call asks again',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'write', { q: 'a' }, { open: 'c1' }),
        { op: 'askAnswer', n: 1, answer: { allow: true, scope: 'session' } },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
        rcall(3, 'write', { q: 'b' }, { open: 'c2' }),
        { op: 'hubAnswer', n: 2, answer: ANSWER },
        { op: 'read', id: 'c2' },
        {
          op: 'rpc',
          rpc: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'two', version: '1' },
          },
        },
        { op: 'notify', rpc: 'notifications/initialized', session: 2 },
        { ...rcall(4, 'write', { q: 'c' }, { open: 'c3' }), session: 2 },
        { op: 'hubAnswer', n: 3, answer: ANSWER },
        { op: 'read', id: 'c3' },
      ],
    },
    'allowed for the session: no card again, not even from another client session',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'write', {}, { open: 'c1' }),
        { op: 'askAnswer', n: 1, answer: { allow: false } },
        { op: 'read', id: 'c1' },
        rcall(3, 'write', {}, { open: 'c2' }),
        { op: 'askAnswer', n: 2, reject: true },
        { op: 'read', id: 'c2' },
        rcall(4, 'write', {}, { open: 'c3' }),
        { op: 'askAnswer', n: 3, answer: { allow: false } },
        { op: 'read', id: 'c3' },
      ],
    },
    'denied; the card fails: both are a refusal and the hub is never called',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'write', { q: 'a' }, { open: 'c1' }),
        {
          op: 'notify',
          rpc: 'notifications/cancelled',
          session: 1,
          params: { requestId: 2, reason: 'user' },
        },
        { op: 'askAnswer', n: 1, answer: { allow: true, scope: 'once' } },
        { op: 'read', id: 'c1' },
      ],
    },
    'cancelled while the card waits: allowed afterwards, the hub is not called',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'write', { q: 'a' }, { open: 'c1' }),
        { op: 'notify', rpc: 'notifications/cancelled', session: 1, params: { requestId: 2 } },
        { op: 'askAnswer', n: 1, answer: { allow: true, scope: 'session' } },
        rcall(3, 'write', { q: 'b' }, { open: 'c2' }),
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c2' },
      ],
    },
    'allowed for the session after the call was cancelled: the allowance stands',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'slow' }, { open: 'c1' }),
        {
          op: 'notify',
          rpc: 'notifications/cancelled',
          session: 1,
          params: { requestId: 2, reason: 'enough' },
        },
        { op: 'hubAnswer', n: 1, answer: { ok: false, error: 'notes: cancelled' } },
        { op: 'read', id: 'c1' },
      ],
    },
    'cancelled during the call: the hub call is cancelled',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'slow' }, { open: 'c1' }),
        { op: 'notify', rpc: 'notifications/cancelled', session: 1, params: { requestId: 2 } },
        { op: 'notify', rpc: 'notifications/cancelled', session: 1, params: { requestId: 2 } },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
      ],
    },
    'cancelled twice: one hub cancel',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'one' }, { open: 'c1' }),
        rcall(3, 'write', { q: 'two' }, { open: 'c2' }),
        { op: 'stop' },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'askAnswer', n: 1, answer: { allow: true, scope: 'once' } },
        { op: 'read', id: 'c1' },
        { op: 'read', id: 'c2' },
        { op: 'rpc', rpc: 'tools/list', id: 4, session: 1 },
      ],
    },
    'stop with a call in flight and a card waiting',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        rcall(2, 'read', { q: 'done' }, { open: 'c1' }),
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
        { op: 'stop' },
      ],
    },
    'stop after the call finished: nothing to cancel',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [...OPENED, { op: 'stop' }, { op: 'stop' }],
    },
    'stop twice',
  ),
  relayCase(
    {
      list: [NOTES, rserver('other', [rtool('go', 'other', 'always')])],
      steps: [
        INIT(),
        { ...INIT(2), relay: 2 },
        NOTICE,
        { op: 'notify', rpc: 'notifications/initialized', session: 1, relay: 2 },
        rcall(3, 'read', { q: 'n' }, { open: 'c1' }),
        { ...rcall(3, 'go', { q: 'o' }, { open: 'c2' }), relay: 2 },
        { op: 'rpc', ...rcall(4, 'go', {}), relay: 1 },
        { op: 'hubAnswer', n: 2, answer: { ok: true, output: 'other done', isError: true } },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        { op: 'read', id: 'c1' },
        { op: 'read', id: 'c2' },
      ],
    },
    'two relays: each call goes to its own server, a tool of the other relay is unknown',
  ),
  relayCase(
    {
      list: [rserver('notes', [rtool('read', 'notes', 'always')])],
      caller: 'win9',
      version: '3.1.4',
      steps: [
        ...OPENED,
        { op: 'rpc', rpc: 'tools/call', id: 2, session: 1, params: { name: 'read' } },
        { op: 'hubAnswer', n: 1, answer: ANSWER },
        {
          op: 'rpc',
          rpc: 'tools/call',
          id: 3,
          session: 1,
          params: { name: 'read', arguments: null },
        },
      ],
    },
    'a call with no arguments; the caller and version of the session',
  ),
  relayCase(
    {
      list: [NOTES],
      steps: [
        ...OPENED,
        { ...rcall(2, 'read', {}), auth: 'none' },
        { ...rcall(3, 'read', {}), auth: 'bad' },
      ],
    },
    'a relay wants its token too',
  ),
]

// ---------------------------------------------------------------------------
// cases: the pure functions of the relay
// ---------------------------------------------------------------------------

const planCase = (list: Spec[], note: string): Case => ({ args: [list], note })
const planCases: Case[] = [
  planCase([], 'no servers'),
  planCase([NOTES], 'a server with an always tool, an ask tool and an off one'),
  planCase(
    [rserver('a', [rtool('t', 'a', 'always')], { instructions: 'hi', keepResultsInside: false })],
    'instructions, keepResultsInside off',
  ),
  planCase(
    [rserver('a', [rtool('t', 'a', 'always')], { status: 'disabled' })],
    'a disabled server',
  ),
  planCase(
    [rserver('a', [rtool('t', 'a', 'always')], { status: 'failed' })],
    'a failed server is still planned',
  ),
  planCase([rserver('a__b', [rtool('t', 'a__b', 'always')])], 'a name with two underscores'),
  planCase(
    [rserver('x'.repeat(25), [rtool('t', 'x'.repeat(25), 'always')])],
    'a name that is too long',
  ),
  planCase(
    [rserver('x'.repeat(24), [rtool('t', 'x'.repeat(24), 'always')])],
    'a name of the longest length',
  ),
  planCase(
    [rserver('seuoffice-editor', [rtool('t', 'seuoffice-editor', 'always')])],
    'a reserved name',
  ),
  planCase(
    [rserver('SEUOFFICE-EDITOR', [rtool('t', 'SEUOFFICE-EDITOR', 'always')])],
    'a reserved name in capitals',
  ),
  planCase([rserver('', [rtool('t', '', 'always')])], 'an empty name'),
  planCase([rserver('my server', [rtool('t', 'my server', 'always')])], 'a name with a space'),
  planCase(
    [
      rserver('Notes', [rtool('a', 'Notes', 'always')]),
      rserver('notes', [rtool('b', 'notes', 'always')]),
    ],
    'the same name without case: the first one',
  ),
  planCase(
    [
      rserver('Notes', [rtool('a', 'Notes', 'off')]),
      rserver('notes', [rtool('b', 'notes', 'always')]),
    ],
    'a server with no tool does not hold its name',
  ),
  planCase(
    [
      rserver('notes', [
        rtool('a', 'notes', 'always'),
        rtool('b', 'notes', 'off'),
        rtool('c', 'notes', 'ask', { pending: true }),
        rtool('d', 'notes', 'always', { unusable: 'name' }),
        rtool('e', 'notes', 'always', { unusable: '' }),
      ]),
    ],
    'tools that are off, pending, unusable (an empty reason is none)',
  ),
  planCase(
    [
      rserver('notes', [
        rtool('a', 'notes', 'always', { exposedName: 'mcp__other__a' }),
        rtool('b', 'notes', 'always', { exposedName: 'mcp__notes__' }),
        rtool('c', 'notes', 'always', { exposedName: 'mcp__Notes__c' }),
        rtool('d', 'notes', 'always', { exposedName: 'mcp__notes__d__e' }),
      ]),
    ],
    'exposed names that do not fit the server',
  ),
  planCase(
    [
      rserver('notes', [
        rtool('a b', 'notes', 'ask', {
          exposedName: 'mcp__notes__a_b',
          description: 'spaced',
          inputSchema: { type: 'string' },
        }),
      ]),
    ],
    'the relay name is the exposed one',
  ),
  planCase([rserver('notes', [rtool('a', 'notes', 'maybe')])], 'a permission that is neither'),
  planCase(
    [
      rserver('a', [rtool('t', 'a', 'always')], { keepResultsInside: false }),
      rserver('b', [rtool('t', 'b', 'always')]),
    ],
    'one keeps results inside',
  ),
]

const resultCases = cases(
  [null],
  [{ ok: true, output: 'text', isError: false }],
  [{ ok: true, output: 'bad', isError: true }],
  [{ ok: true, output: '' }],
  [{ ok: true, output: 5 }],
  [{ ok: true }],
  [{ ok: false, error: 'server failed' }],
  [{ ok: false }],
  [{ ok: false, error: '' }],
  [{ ok: false, error: 3 }],
  [{ ok: 'yes' }],
  [{}],
  ['plain text'],
  [42],
  [[1]],
  [true],
  [{ ok: true, output: 'x', isError: 'true' }],
)

const textCases = cases(
  ['needsReview', 'notes', 'write'],
  ['needsReview', 'notes', 'w'.repeat(100)],
  ['needsReview', 'notes', 'a"b\\c\n'],
  // the 80-unit cut halves the pair: divergences.json, relay-text-cuts-a-surrogate-pair-3
  ['needsReview', 'notes', 'a'.repeat(79) + '\u{1F600}'],
  ['needsReview', 'notes', 'a'.repeat(80) + 'b'],
  ['unknownTool', 'notes', 'nope'],
  ['unknownTool', 'notes', ''],
  ['unknownTool', 'n', 'x'.repeat(81)],
  ['declined'],
  ['stopped', 'notes'],
  ['stopped', ''],
  ['needsReview', 'notes', 'a'.repeat(78) + '\u{1F600}'],
  ['needsReview', 'notes', 'a'.repeat(78) + '\u{1F600}b'],
)

export const group: Group = {
  'agent-mcp.AGENT_MCP_TOOL_NAMES': constant(agentMcp.AGENT_MCP_TOOL_NAMES, 'a constant'),
  'agent-mcp.skillCall': { ts: (a, cx) => skillCall(a[0] as Spec, cx), cases: skillCases },
  'agent-mcp.withholdingSlides': {
    ts: (a, cx) => slidesScript(a[0] as Spec, cx),
    cases: slidesCases,
  },
  'agent-mcp.withholdingOpenDocuments': {
    ts: (a, cx) => openScript(a[0] as Spec, cx),
    cases: openCases,
  },
  'agent-mcp.build': { ts: (a, cx) => build(a[0] as Spec, cx), cases: buildCases },
  'agent-mcp.scenario': { ts: (a, cx) => agentScenario(a[0] as Spec, cx), cases: agentCases },
  'agent-mcp-relay.agentRelayPlans': {
    ts: (a) => relay.agentRelayPlans(a[0] as never),
    cases: planCases,
  },
  'agent-mcp-relay.relayResultOf': { ts: (a) => relay.relayResultOf(a[0]), cases: resultCases },
  'agent-mcp-relay.RELAY_TEXT': {
    ts: (a) => {
      const [name, ...rest] = a as string[]
      const entry = (relay.RELAY_TEXT as Record<string, unknown>)[name!]
      return typeof entry === 'function' ? (entry as (...x: string[]) => string)(...rest) : entry
    },
    cases: textCases,
  },
  'agent-mcp-relay.scenario': {
    ts: (a, cx) => relayScenario(a[0] as Spec, cx),
    cases: relayCases,
  },
}
