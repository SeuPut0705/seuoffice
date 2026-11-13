/**
 * Group `b5-provider`, part `openai` (Rust: crates/main-core/src/calls/b5_provider/openai.rs):
 * packages/ai-provider/src/{protocols/openai-compatible.ts,
 * protocols/openai-responses.ts, protocols/gateway-complete.ts, http-error.ts,
 * output-cap.ts}. Names are `<file>.<export>`.
 *
 * The streaming and one-shot functions run in the scripted world of world.ts
 * (the first argument). `o` is what the call is given: `baseUrl`, `config`
 * (default `{ model: 'gpt-4o', apiKey: 'sk-test' }`), `system`, `messages`
 * (default one user turn), `tools`, `maxTokens` (4096), `user` (one-shot chat),
 * `options` (the protocol's options object as the function takes it),
 * `sessionId`, `activity` (the callbacks log `['activity']`), `bare` (no
 * optional callbacks but `onActivity`), `delays` (`setAiTransientRetryDelays`)
 * and, for the gateway, `provider` (a token provider that asks the world's
 * `token` call). The callbacks log `['delta', text]`, `['toolCall', call]`,
 * `['reasoning', text]`, `['stop', reason]`, `['usage', usage]` and
 * `['activity']`. A one-shot chat answers its `AiChatResponse`.
 *
 * The scenarios (`openai-compatible.resetUsageRejectedGateways`,
 * `gateway-complete.setGatewayTokenProvider`, `output-cap.withOutputCapFallback`,
 * `output-cap.resetOutputCaps`) run their `steps` in one world and one set of
 * module state, and answer one entry per step.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type FetchSpec, type World, type WorldRun } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')
const compat = await import('../../../../packages/ai-provider/src/protocols/openai-compatible.ts')
const responses = await import('../../../../packages/ai-provider/src/protocols/openai-responses.ts')
const gateway = await import('../../../../packages/ai-provider/src/protocols/gateway-complete.ts')
const httpError = await import('../../../../packages/ai-provider/src/http-error.ts')
const outputCap = await import('../../../../packages/ai-provider/src/output-cap.ts')
const watchdog = await import('../../../../packages/ai-provider/src/watchdog.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Opts {
  baseUrl?: string
  config?: Record<string, unknown>
  system?: string
  messages?: unknown[]
  tools?: unknown[]
  maxTokens?: number
  user?: string
  options?: Record<string, unknown>
  sessionId?: string
  activity?: boolean
  bare?: boolean
  delays?: number[]
  provider?: boolean
}

const BASE = 'https://api.example.com/v1'
const DEFAULT_CONFIG = { model: 'gpt-4o', apiKey: 'sk-test' }
const DEFAULT_MESSAGES = [{ role: 'user', text: 'hi' }]

function setUp(o: Opts): void {
  fetchMod.setRescueFetch(null)
  fetchMod.setAiFetch(null)
  fetchMod.setAiUserAgent('')
  fetchMod.setAiTransientRetryDelays(o.delays ?? null)
  compat.resetUsageRejectedGateways()
  gateway.setGatewayTokenProvider(null)
}

function callbacksOf(o: Opts, cx: TsContext, signal: AbortSignal): Any {
  return {
    onDelta: (t: string) => cx.log('delta', t),
    onToolCall: (c: unknown) => cx.log('toolCall', c),
    ...(o.bare
      ? {}
      : {
          onReasoningDelta: (t: string) => cx.log('reasoning', t),
          onStopReason: (r: string) => cx.log('stop', r),
          onUsage: (u: unknown) => cx.log('usage', u),
        }),
    ...(o.activity ? { onActivity: () => cx.log('activity') } : {}),
    ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
    signal,
  }
}

type Streamer = (o: Opts, cb: Any, run: WorldRun) => Promise<void>

/** a streamed turn in the case's world; answers nothing but its log */
function streamSpec(call: Streamer) {
  return ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      const opts = (o ?? {}) as Opts
      setUp(opts)
      await call(opts, callbacksOf(opts, cx, signal), run)
    })
}

/** a one-shot chat in the case's world, under a watchdog as the callers hold one */
function chatSpec(call: (wd: Any, o: Opts, run: WorldRun) => Promise<unknown>) {
  return ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      const opts = (o ?? {}) as Opts
      setUp(opts)
      const wd = watchdog.createStreamWatchdog(signal)
      return wd.guard(() => call(wd, opts, run))
    })
}

const compatStream = (o: Opts, cb: Any): Promise<void> =>
  compat.streamOpenAiCompatible(
    o.baseUrl ?? BASE,
    (o.config ?? DEFAULT_CONFIG) as Any,
    o.system ?? 'sys',
    (o.messages ?? DEFAULT_MESSAGES) as Any,
    (o.tools ?? []) as Any,
    o.maxTokens ?? 4096,
    cb,
    (o.options ?? {}) as Any,
  )

const responsesStream: Streamer = (o, cb) =>
  responses.streamOpenAiResponses(
    o.baseUrl ?? BASE,
    (o.config ?? DEFAULT_CONFIG) as Any,
    o.system ?? 'sys',
    (o.messages ?? DEFAULT_MESSAGES) as Any,
    (o.tools ?? []) as Any,
    o.maxTokens ?? 4096,
    cb,
    (o.options ?? {}) as Any,
  )

const providerOf = (run: WorldRun, o: Opts): Any => (o.provider ? () => run.call('token')() : null)

const gatewayStream: Streamer = async (o, cb, run) => {
  gateway.setGatewayTokenProvider(providerOf(run, o))
  try {
    await gateway.streamGatewayComplete(
      o.baseUrl ?? BASE,
      (o.config ?? DEFAULT_CONFIG) as Any,
      o.system ?? 'sys',
      (o.messages ?? DEFAULT_MESSAGES) as Any,
      (o.tools ?? []) as Any,
      o.maxTokens ?? 4096,
      cb,
      (o.options ?? {}) as Any,
    )
  } finally {
    gateway.setGatewayTokenProvider(null)
  }
}

// ---------------------------------------------------------------------------
// the world's answers
// ---------------------------------------------------------------------------

const c = (...args: unknown[]): Case => ({ args })
const w = (fetches: FetchSpec[], more: Partial<World> = {}): World =>
  ({ fetches, ...more }) as World
const SSE: [string, string][] = [['content-type', 'text/event-stream']]
const JSON_CT: [string, string][] = [['content-type', 'application/json']]
const frame = (e: unknown): string => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`
/** an SSE answer: one network chunk per event */
const sse = (events: unknown[], status = 200): FetchSpec => ({
  status,
  headers: SSE,
  body: events.map(frame),
})
/** an SSE answer cut into the given network chunks */
const sseChunks = (chunks: Chunk[]): FetchSpec => ({ status: 200, headers: SSE, body: chunks })
const json = (value: unknown, status = 200): FetchSpec => ({
  status,
  headers: JSON_CT,
  body: [typeof value === 'string' ? value : JSON.stringify(value)],
})
const plain = (body: string | null, status: number, type = 'text/plain'): FetchSpec => ({
  status,
  headers: [['content-type', type]],
  body: body === null ? null : [body],
})
const DONE = '[DONE]'

// Chat Completions events
const choice = (delta: unknown, finish: string | null = null): unknown => ({
  choices: [{ delta, finish_reason: finish }],
})
const txt = (s: unknown): unknown => choice({ content: s })
const think = (s: string): unknown => choice({ reasoning_content: s })
const tool = (index: number | undefined, id?: string, name?: string, args?: string): unknown =>
  choice({
    tool_calls: [
      {
        ...(index !== undefined ? { index } : {}),
        ...(id !== undefined ? { id } : {}),
        function: {
          ...(name !== undefined ? { name } : {}),
          ...(args !== undefined ? { arguments: args } : {}),
        },
      },
    ],
  })
const fin = (reason: string): unknown => choice({}, reason)
const usage = (prompt: unknown, completion: unknown): unknown => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
})
const message = (m: unknown, finish: string | null = 'stop', extra: object = {}): unknown => ({
  choices: [{ message: m, finish_reason: finish }],
  ...extra,
})

// Responses events
const ev = (type: string, rest: object = {}): unknown => ({ type, ...rest })
const rtext = (d: string): unknown => ev('response.output_text.delta', { delta: d })
const rsum = (d: string): unknown => ev('response.reasoning_summary_text.delta', { delta: d })
const added = (id?: string): unknown =>
  ev('response.output_item.added', { item: { type: 'function_call', ...(id ? { id } : {}) } })
const argd = (id: string | undefined, d: string): unknown =>
  ev('response.function_call_arguments.delta', {
    ...(id !== undefined ? { item_id: id } : {}),
    delta: d,
  })
const itemDone = (item: unknown): unknown => ev('response.output_item.done', { item })
const completed = (response: unknown): unknown => ev('response.completed', { response })
const fcall = (id: string, callId: string | undefined, name: string, args: string): unknown => ({
  type: 'function_call',
  id,
  ...(callId !== undefined ? { call_id: callId } : {}),
  name,
  arguments: args,
})
const rmsg = (t: string): unknown => ({
  type: 'message',
  content: [{ type: 'output_text', text: t }],
})
const rsn = (id: string, enc: string, summary: unknown[] = []): unknown => ({
  type: 'reasoning',
  id,
  encrypted_content: enc,
  summary,
})

const richMessages = [
  { role: 'user', text: 'look', images: [{ mime: 'image/png', base64: 'AAAA' }] },
  { role: 'user', text: '', images: [{ mime: 'image/jpeg', base64: 'BBBB' }] },
  { role: 'user', text: 'plain' },
  { role: 'user', text: '', images: [] },
  {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
    reasoning: 'thinking',
  },
  {
    role: 'tool',
    results: [
      { id: 'c1', name: 'read_file', output: 'contents', isError: false },
      { id: 'c2', name: 'x', output: 'bad', isError: true },
    ],
  },
  { role: 'assistant', text: '' },
  { role: 'assistant', text: 'done', toolCalls: [], reasoning: 'r2' },
  { role: 'assistant', text: 'with calls', toolCalls: [{ id: 'c3', name: 'noop', input: {} }] },
]

const toolDefs = [
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  { name: 'noop', description: 'Nothing', inputSchema: { type: 'object' } },
]

const ok = (events: unknown[]): FetchSpec => sse([...events, DONE])

// ---------------------------------------------------------------------------
// http-error.ts, output-cap.ts
// ---------------------------------------------------------------------------

const cf = (title: string, code: string, ray: string): string =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>Error code <span>${code}</span></h1><p>Ray ID: <strong>${ray}</strong></p></body></html>`

const errors: Group = {
  'http-error.httpBodyDetail': {
    ts: ([body]) => httpError.httpBodyDetail(body as string),
    cases: [
      c('{"error":{"message":"bad key"}}'),
      c(''),
      c('x'.repeat(600)),
      c('  \n <!doctype html><html></html>'),
      c(cf('Attention Required! | Cloudflare', '1020', 'a1b2c3d4e5f60718')),
      c('<HTML><HEAD><TITLE>  Access   denied  </TITLE></HEAD></HTML>'),
      c(`<html><head><title>${'T'.repeat(80)}</title></head></html>`),
      c('<html><head><title></title></head><body>Error code: 502</body></html>'),
      c('<body>ray id: deadbeefdeadbeef</body>'),
      c('<head><title>x</title></head><body>error code <b>5xx</b> <i> 403</i></body>'),
      c('<html>no markers at all</html>'),
      c('<p>not a page</p><html>'),
      c('한글 오류 본문'.repeat(100)),
      c(`<html>${'<a>'.repeat(40)}error code ${'<b>'.repeat(40)}999</html>`),
    ],
  },
}

const CAP_MESSAGE =
  'HTTP 400: max_tokens is too large: 32768. This model supports at most 8192 completion tokens'

interface CapStep {
  reset?: boolean
  baseUrl?: string
  model?: string
  requested?: number
  /** what the k-th call of `run` throws: a message, `{ value }` for a thrown string, null to succeed */
  fail?: (string | { value: string } | null)[]
}

async function capSteps(steps: CapStep[]): Promise<unknown[]> {
  outputCap.resetOutputCaps()
  const out: unknown[] = []
  for (const step of steps) {
    if (step.reset) {
      outputCap.resetOutputCaps()
      out.push('reset')
      continue
    }
    const calls: number[] = []
    try {
      const result = await outputCap.withOutputCapFallback(
        step.baseUrl ?? BASE,
        step.model ?? 'gpt-4o',
        step.requested ?? 32768,
        async (max) => {
          const k = calls.length
          calls.push(max)
          const fail = step.fail?.[k] ?? null
          if (fail === null) return `ok:${max}`
          if (typeof fail === 'string') throw new Error(fail)
          throw fail.value
        },
      )
      out.push({ calls, result })
    } catch (e) {
      out.push({ calls, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

const capCases = (ceilingMessage: string): CapStep[][] => [
  [{ fail: [ceilingMessage] }],
  [{ fail: [ceilingMessage] }, { fail: [] }, { requested: 4096 }, { requested: 100000, fail: [] }],
  [{ fail: ['HTTP 500: server down'] }],
  [{ fail: [ceilingMessage, ceilingMessage] }],
  [{ fail: [{ value: 'plain string' }] }],
  [{ fail: ['HTTP 400: max_tokens must be at most 8192'] }, { reset: true }, {}],
  [{ fail: [ceilingMessage] }, { model: 'other', fail: [] }, { baseUrl: 'https://b.example/v1' }],
]

const caps: Group = {
  'output-cap.parseOutputCapRejection': {
    ts: ([message, requested]) =>
      outputCap.parseOutputCapRejection(message as string, requested as number),
    cases: [
      c(CAP_MESSAGE, 32768),
      c('HTTP 422: Invalid max_completion_tokens: valid range is [1, 8,192]', 32768),
      c('HTTP 400: output tokens exceed the maximum of 128,000 (requested 200000)', 200000),
      c('HTTP 400: max_tokens 2024 is not allowed', 32768),
      c('HTTP 400: max_tokens 8192 is not allowed', 8192),
      c('HTTP 400: max_tokens 64000 and 16000 and 8192', 70000),
      c('HTTP 401: invalid api key', 32768),
      c('HTTP 429: too many requests, max_tokens 8192', 32768),
      c('400 max_tokens 8192', 32768),
      c('HTTP 400: some unrelated problem with 8192 widgets', 32768),
      c('HTTP 400: MAX_TOKENS above 4000', 32768),
      c('HTTP 400: maxOutputTokens must be <= 1000', 32768),
      c('HTTP 400: max_tokens 1000000000000000000000000 and 1024', 32768),
    ],
  },
  'output-cap.withOutputCapFallback': {
    ts: ([steps]) => capSteps(steps as CapStep[]),
    cases: capCases(CAP_MESSAGE).map((steps) => c(steps)),
  },
  'output-cap.resetOutputCaps': {
    ts: ([steps]) => capSteps(steps as CapStep[]),
    cases: [
      c([{ fail: [CAP_MESSAGE] }, { reset: true }, {}]),
      c([{ fail: [CAP_MESSAGE] }, {}, { reset: true }, { reset: true }, {}]),
    ],
  },
}

// ---------------------------------------------------------------------------
// protocols/openai-compatible.ts
// ---------------------------------------------------------------------------

const manyTools = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => tool(i, `call_${i}`, 'noop', '{}'))

const compatCases: Case[] = [
  // text, usage, [DONE]
  c(w([ok([txt('Hel'), txt('lo'), fin('stop'), usage(12, 3)])]), { activity: true }),
  c(w([ok([txt('Hi'), fin('stop')])]), { bare: true }),
  c(
    w([
      ok([
        txt('a'),
        { ...(txt('b') as object), usage: { prompt_tokens: '7', completion_tokens: 2 } },
        fin('stop'),
      ]),
    ]),
  ),
  c(w([ok([txt('x'), fin('stop'), usage('nope', -1)])])),
  c(w([ok([txt('x'), fin('stop'), usage(5, undefined)])])),
  c(w([ok([txt('x'), fin('stop'), { choices: [], usage: {} }])])),
  c(w([ok([think('hm '), choice({ reasoning: 'or ' }), txt('answer'), fin('stop')])])),
  c(
    w([
      ok([
        choice({ reasoning_content: '', content: 'body' }),
        choice({ reasoning_content: 5 }),
        fin('stop'),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        choice({ content: [{ type: 'text', text: 'par' }, { text: 'ts' }, { type: 'image' }] }),
        fin('stop'),
      ]),
    ]),
  ),
  c(w([ok([choice({ content: [{ type: 'image' }] }), fin('stop')])])),
  // tool calls in fragments
  c(
    w([
      ok([
        txt('calling'),
        tool(0, 'call_1', 'read_file', ''),
        tool(0, undefined, undefined, '{"pa'),
        tool(0, undefined, undefined, 'th":"a.txt"}'),
        tool(1, 'call_2', 'noop', '{}'),
        fin('tool_calls'),
        usage(40, 9),
      ]),
    ]),
    { tools: toolDefs },
  ),
  c(
    w([
      ok([
        tool(0, 'c1', 'read_file', '{"path":"x"}'),
        tool(0, 'c1', 'read_file', ''),
        fin('tool_calls'),
      ]),
    ]),
  ),
  c(w([ok([tool(0, 'c1', 'read_', '{}'), tool(0, undefined, 'file', ''), fin('tool_calls')])])),
  c(
    w([
      ok([
        tool(1, 'c2', 'second', '{"b":2}'),
        tool(0, 'c1', 'first', '{"a":1}'),
        fin('tool_calls'),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        tool(10, 'c10', 'ten', '{}'),
        tool(2, 'c2', 'two', '{}'),
        tool(1, 'c1', 'one', '{}'),
        fin('tool_calls'),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        tool(undefined, 'c1', 'noid', '{"a":'),
        tool(undefined, undefined, undefined, '1}'),
        fin('tool_calls'),
      ]),
    ]),
  ),
  c(w([ok([tool(0, undefined, 'anon', '{}'), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', '', '{}'), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', 'bad', '{"a": oops'), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', 'quotes', '{"note":"he said "hi" ok"}'), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', 'arr', '[1,2]'), fin('tool_calls')])])),
  c(
    w([
      ok([
        tool(0, 'c1', 'two_flushes', '{}'),
        fin('tool_calls'),
        tool(1, 'c2', 'late', '{}'),
        fin('stop'),
      ]),
    ]),
  ),
  // finish edge cases
  c(w([ok([txt('cut'), fin('length')])])),
  c(w([ok([tool(0, 'c1', 'big', '{"a":'), tool(1, 'c2', 'last', '{"b":'), fin('length')])])),
  c(w([ok([fin('content_filter')])])),
  c(w([ok([txt('partial'), fin('content_filter')])])),
  c(w([ok([fin('stop')])])),
  c(w([ok([])])),
  c(w([sse([txt('no done'), fin('stop')])])),
  c(w([sse([txt('cut off')])])),
  c(w([sse([tool(0, 'c1', 'read_file', '{"path":"half')])])),
  c(
    w([
      sse([
        tool(0, 'c1', 'read_file', '{"path":"half'),
        tool(1, 'c2', 'second', '{"q":'),
        tool(2, 'c3', 'ok', '{}'),
      ]),
    ]),
  ),
  c(w([sse([tool(0, 'c1', 'complete', '{"a":1}')])])),
  c(w([sse([])])),
  c(w([sse([txt('then done'), DONE])])),
  c(w([sse([choice({}), DONE])])),
  c(w([sse([{ choices: [] }, { notChoices: true }])])),
  // malformed events and error events
  c(
    w([
      sseChunks([
        'data: ping\n\n',
        ': comment\n\n',
        'data: {"choices":[{"delta":{"con',
        'tent":"x"}}]}\n\n',
        frame(fin('stop')),
        frame(DONE),
      ]),
    ]),
  ),
  c(
    w([
      sseChunks([
        'data: {"choices":[{"delta":\ndata: {"content":"joined"}}]}\n\n',
        frame(fin('stop')),
        frame(DONE),
      ]),
    ]),
  ),
  c(w([ok([txt('a'), { error: { message: 'upstream exploded' } }])])),
  c(w([ok([{ error: 'plain text failure' }])])),
  c(w([ok([{ error: { code: 429 } }])])),
  c(w([ok([{ error: '', choices: [] }, txt('after'), fin('stop')])])),
  c(w([sseChunks(['data: null\n\n'])])),
  c(w([sseChunks(['data: 5\n\n', frame(txt('five')), frame(fin('stop'))])])),
  // a JSON body instead of SSE
  c(
    w([
      json(
        message(
          {
            content: 'whole',
            reasoning_content: 'because',
            tool_calls: [
              { id: 'j1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
              { function: { name: 'noop', arguments: '' } },
              { id: 'skip', function: {} },
              { id: 'j3', function: { name: 'bad', arguments: '{' } },
            ],
          },
          'stop',
          { usage: { prompt_tokens: 10, completion_tokens: '4' } },
        ),
      ),
    ]),
  ),
  c(
    w([
      json(
        message(
          {
            content: 'cut',
            tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"a":' } }],
          },
          'length',
        ),
      ),
    ]),
  ),
  c(w([json(message({ content: [{ text: 'parts ' }, { text: 'joined' }] }))])),
  c(w([json(message({ content: 'x' }, 'length', { usage: { prompt_tokens: 'bad' } }))])),
  c(w([json(message({ content: 'x' }, 'stop', { usage: { prompt_tokens: 1 } }))])),
  c(w([json(message({ content: '' }))])),
  c(w([json({ choices: [] })])),
  c(w([json({})])),
  c(w([json({ error: { message: 'model overloaded' } })])),
  c(w([json({ error: 'string error' })])),
  c(w([json('[1,2]')])),
  c(w([json('null')])),
  c(w([json('{"truncated":')])),
  c(w([plain('<html><head><title>Login</title></head></html>', 200, 'application/json')])),
  c(w([json({ content: [{ text: 'Your credits have been exhausted. Top up.' }] })])),
  c(w([json({ choices: [{ message: { content: 'x' } }], note: 'insufficient credit' })])),
  c(
    w([
      json(
        message({
          tool_calls: Array.from({ length: 101 }, (_, i) => ({
            id: `t${i}`,
            function: { name: 'f', arguments: '{}' },
          })),
        }),
      ),
    ]),
  ),
  c(
    w([
      json(
        message({
          tool_calls: Array.from({ length: 100 }, (_, i) => ({
            id: `t${i}`,
            function: { name: 'f', arguments: '{}' },
          })),
        }),
      ),
    ]),
  ),
  c(w([json(message({ tool_calls: [{ function: { name: 'f', arguments: '{}' } }] }))])),
  c(w([json(message({ tool_calls: 5 }))])),
  c(w([json(message({ tool_calls: [{ function: { name: 'f', arguments: 5 } }] }))])),
  // HTTP errors
  c(w([plain('{"error":{"message":"invalid api key"}}', 401, 'application/json')])),
  c(
    w([
      plain(
        '<html><head><title>Just a moment...</title></head><body>Error code 1015 Ray ID: 0123456789abcdef</body></html>',
        403,
        'text/html',
      ),
    ]),
  ),
  c(w([plain('', 500)])),
  c(w([plain(null, 502)])),
  c(w([{ status: 200, headers: SSE, body: null }])),
  c(w([plain('x'.repeat(900), 400)])),
  c(w([plain('big', 200, 'text/plain')]), { options: {} }),
  c(w([{ status: 500, headers: [['content-length', '99999999']], body: ['x'] }])),
  c(w([{ reject: { class: 'TypeError', message: 'fetch failed' } }])),
  c(w([{ status: 302, headers: [['location', 'https://evil.example.net/x']], body: ['moved'] }])),
  c(w([plain('busy', 503), ok([txt('after retry'), fin('stop')])]), { delays: [10] }),
  // stream_options rejection
  c(
    w([
      plain(
        '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}',
        400,
        'application/json',
      ),
      ok([txt('retried'), fin('stop')]),
    ]),
  ),
  c(
    w([
      plain('HTTP 400 ... stream_options not allowed', 400),
      plain('{"error":{"message":"still stream_options"}}', 400),
    ]),
  ),
  c(w([plain('{"error":"unknown parameter stream_options"}', 500), ok([txt('no'), fin('stop')])])),
  c(w([plain('{"error":"bad max_tokens"}', 400)])),
  // watchdog
  c(w([{ hang: true }])),
  c(w([{ hang: true }]), { options: { timeoutMs: 2500 } }),
  c(w([{ hang: true }]), { options: { timeoutMs: 100 } }),
  c(w([{ hang: true }], { abortAt: 500 })),
  c(w([ok([txt('a'), fin('stop')])]), { options: { timeoutMs: 50000 }, activity: true }),
  // budgets
  c(w([ok([...manyTools(101), fin('tool_calls')])])),
  c(w([ok([...manyTools(100), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', 'huge', 'x'.repeat(512001)), fin('tool_calls')])])),
  c(w([ok([tool(0, 'c1', 'edge', 'x'.repeat(512000)), fin('tool_calls')])])),
  // the request as sent
  c(w([ok([txt('ok'), fin('stop')])]), { options: { omitTemperature: true } }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    options: { useMaxCompletionTokens: true, temperature: 0 },
  }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    options: { temperature: 0.9, maxTokens: 123 },
    maxTokens: 999,
  }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    options: {
      bodyExtras: {
        thinking: { type: 'enabled' },
        temperature: 1,
        stream: false,
        5: 'five',
        stream_options: 'x',
      },
    },
  }),
  c(w([ok([txt('ok'), fin('stop')])]), { config: { model: 'm' }, tools: toolDefs }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    config: { model: 'deepseek-v4-pro', apiKey: 'k' },
    messages: richMessages,
    tools: toolDefs,
  }),
  c(w([ok([txt('ok'), fin('stop')])]), { messages: richMessages }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    baseUrl: 'https://opencode.ai/zen/v1',
    sessionId: 'chat-7',
  }),
  c(w([ok([txt('ok'), fin('stop')])]), { baseUrl: 'https://opencode.ai/zen/v1' }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    baseUrl: 'https://api.example.com/v1?api-version=1',
    sessionId: 'x',
  }),
  c(w([ok([txt('ok'), fin('stop')])]), { system: '', messages: [] }),
  c(w([]), { baseUrl: 'not a url' }),
  c(w([ok([txt('ok'), fin('stop')])]), { messages: [{ role: 'tool' }] }),
  c(w([ok([txt('ok'), fin('stop')])]), {
    messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/png' }] }],
  }),
]

interface Step extends Opts {
  reset?: boolean
}

const rejected = plain('{"error":"unknown stream_options"}', 400, 'application/json')
const accepted = ok([txt('ok'), fin('stop')])

const compatGroup: Group = {
  'openai-compatible.streamOpenAiCompatible': {
    ts: streamSpec(compatStream),
    cases: compatCases,
  },
  'openai-compatible.resetUsageRejectedGateways': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const steps = ((o as { steps?: Step[] } | null)?.steps ?? []) as Step[]
        setUp({})
        const out: unknown[] = []
        for (const step of steps) {
          if (step.reset) {
            compat.resetUsageRejectedGateways()
            out.push('reset')
            continue
          }
          try {
            await compatStream(step, callbacksOf(step, cx, signal))
            out.push('ok')
          } catch (e) {
            out.push({ error: e instanceof Error ? e.message : String(e) })
          }
        }
        return out
      }),
    cases: [
      // rejected once, remembered: the second turn skips the extra round trip
      c(w([rejected, accepted, accepted]), { steps: [{}, {}] }),
      // reset: the next turn asks for usage again
      c(w([rejected, accepted, rejected, accepted]), { steps: [{}, { reset: true }, {}] }),
      // another gateway is asked on its own
      c(w([rejected, accepted, accepted]), {
        steps: [{}, { baseUrl: 'https://other.example.com/v1' }],
      }),
      c(w([accepted, accepted]), { steps: [{ reset: true }, {}] }),
    ],
  },
  'openai-compatible.chatOpenAiCompatible': {
    ts: chatSpec((wd, o) =>
      compat.chatOpenAiCompatible(
        wd,
        o.baseUrl ?? BASE,
        (o.config ?? DEFAULT_CONFIG) as Any,
        o.system ?? 'sys',
        o.user ?? 'question',
        (o.options ?? {}) as Any,
      ),
    ),
    cases: [
      c(w([json({ choices: [{ message: { content: 'answer' } }] })])),
      c(w([json({ choices: [{ message: { content: '' } }] })])),
      c(w([json({ choices: [] })])),
      c(w([json({})])),
      c(w([json('null')])),
      c(w([json('[1]')])),
      c(w([plain('<html>gateway page</html>', 200, 'text/html')])),
      c(w([plain('', 200)])),
      c(w([plain(null, 200)])),
      c(w([plain('{"error":"nope"}', 429, 'application/json')])),
      c(w([plain('<html><head><title>Blocked</title></head></html>', 403, 'text/html')])),
      c(w([plain(null, 500)])),
      c(w([json({ choices: [{ message: { content: 'x' } }] })]), {
        options: { maxTokens: 64, temperature: 0.1 },
      }),
      c(w([json({ choices: [{ message: { content: 'x' } }] })]), {
        options: { omitTemperature: true, bodyExtras: { top_p: 0.5 } },
      }),
      c(w([json({ choices: [{ message: { content: 'x' } }] })]), {
        config: { model: 'm' },
        baseUrl: 'https://opencode.ai/zen/v1',
      }),
      c(w([json({ choices: [{ message: { content: 'x' } }] })]), { options: { timeoutMs: 5000 } }),
      c(w([{ hang: true }]), { options: { timeoutMs: 2500 } }),
      c(w([{ hang: true }])),
      c(w([{ hang: true }], { abortAt: 700 }), { options: { timeoutMs: 5000 } }),
      c(w([{ reject: { message: 'boom' } }])),
      c(w([]), { baseUrl: 'nope' }),
      c(w([{ status: 307, headers: [['location', '/elsewhere']], body: [] }])),
      c(w([{ status: 500, headers: [['content-length', '99999999']], body: ['x'] }])),
      c(w([{ status: 200, headers: [['content-length', '99999999']], body: ['x'] }])),
    ],
  },
}

// ---------------------------------------------------------------------------
// protocols/openai-responses.ts
// ---------------------------------------------------------------------------

const respItems = (items: unknown[]): unknown => ({ status: 'completed', output: items })
const RSIG = 'oai-rs:{"id":"rs_1","encrypted":"ENC"}'

const responsesCases: Case[] = [
  c(
    w([
      ok([
        rtext('Hel'),
        rtext('lo'),
        completed({ status: 'completed', usage: { input_tokens: 11, output_tokens: '2' } }),
      ]),
    ]),
    { activity: true },
  ),
  c(w([ok([rtext('x'), completed({ status: 'completed' })])]), { bare: true }),
  c(
    w([
      ok([
        rsum('think '),
        rsum('hard'),
        rtext('answer'),
        completed({ status: 'completed', usage: { input_tokens: 'x' } }),
      ]),
    ]),
  ),
  c(w([ok([rtext('x'), rtext(''), completed({ usage: { input_tokens: 1 } })])])),
  // function calls
  c(
    w([
      ok([
        rsum('plan'),
        added('fc_1'),
        argd('fc_1', '{"path":'),
        argd('fc_1', '"a.txt"}'),
        itemDone(rsn('rs_9', 'ENC9', [{ text: 'plan' }])),
        itemDone(fcall('fc_1', 'call_1', 'read_file', '{"path":"a.txt"}')),
        added('fc_2'),
        itemDone(fcall('fc_2', undefined, 'noop', '')),
        completed({ status: 'completed', usage: { input_tokens: 30, output_tokens: 12 } }),
      ]),
    ]),
    { tools: toolDefs },
  ),
  c(
    w([
      ok([
        itemDone(fcall('fc', 'call', 'last', '{"a":')),
        completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        rtext('cut'),
        ev('response.incomplete', {
          response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        }),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        rtext('cut'),
        ev('response.incomplete', {
          response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
        }),
      ]),
    ]),
  ),
  c(w([ok([itemDone(fcall('fc', undefined, 'bad', '{oops')), completed(respItems([]))])])),
  c(
    w([
      ok([
        itemDone(rsn('rs_1', 'E')),
        itemDone({ type: 'function_call', name: 'nameless-id', arguments: '{}' }),
        completed({}),
      ]),
    ]),
  ),
  c(
    w([
      ok([
        itemDone({ type: 'function_call', id: 'only_id', name: 'f', arguments: '{}' }),
        completed({}),
      ]),
    ]),
  ),
  c(w([ok([itemDone({ type: 'function_call', name: 'f', arguments: '{}' }), completed({})])])),
  c(w([ok([itemDone({ type: 'function_call', arguments: '{}' }), completed({})])])),
  c(
    w([
      ok([
        itemDone(rmsg('only the item')),
        itemDone(rsn('r', 'e', [{ text: 'sum' }, {}])),
        completed({}),
      ]),
    ]),
  ),
  c(w([ok([rtext('streamed'), itemDone(rmsg('streamed')), completed({})])])),
  c(
    w([
      ok([
        itemDone({
          type: 'message',
          content: [{ type: 'refusal', text: 'no' }, { type: 'output_text' }],
        }),
        completed({ status: 'completed' }),
      ]),
    ]),
  ),
  c(w([ok([ev('response.created'), ev('response.in_progress'), rtext('x'), completed({})])])),
  c(w([sse([rtext('after done'), DONE])])),
  c(w([ok([completed({ status: 'completed' })])])),
  c(w([ok([ev('response.completed')])])),
  c(w([ok([ev('response.incomplete', { response: { status: 'incomplete' } })])])),
  // terminal edge cases
  c(w([ok([])])),
  c(w([sse([rtext('cut')])])),
  c(w([sse([rsum('only thinking')])])),
  c(w([sse([added('fc_1'), argd('fc_1', '{"a')])])),
  c(w([sse([itemDone(fcall('fc', 'c', 'f', '{}'))])])),
  c(w([sse([itemDone(rmsg('no terminal'))])])),
  c(w([sse([itemDone(rsn('r', 'e'))])])),
  // errors
  c(w([ok([ev('response.failed', { response: { error: { message: 'quota exceeded' } } })])])),
  c(w([ok([ev('response.failed', { response: { error: 'plain failure' } })])])),
  c(w([ok([ev('response.failed', { response: {} })])])),
  c(w([ok([ev('response.failed')])])),
  c(w([ok([ev('error', { error: { message: 'stream broke' } })])])),
  c(w([ok([ev('error', { message: 'top-level message' })])])),
  c(w([ok([ev('error', { error: null, message: null })])])),
  c(w([ok([ev('error', { error: '' })])])),
  c(
    w([
      sseChunks([
        'data: ping\n\n',
        'data: {"type":"response.output_text.delta","delta":"a"}\n\n',
        frame(completed({})),
      ]),
    ]),
  ),
  c(w([sseChunks(['data: null\n\n'])])),
  c(w([sseChunks(['data: 5\n\n', frame(rtext('x')), frame(completed({}))])])),
  // a JSON body instead of SSE
  c(
    w([
      json({
        status: 'completed',
        output: [
          rsn('rs_j', 'ENCJ', [{ text: 'json thinking' }]),
          rmsg('json answer'),
          fcall('fc_j', 'call_j', 'read_file', '{"path":"j"}'),
          fcall('fc_k', 'call_k', 'noop', ''),
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    ]),
  ),
  c(
    w([
      json({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [fcall('f', 'c', 'cut', '{"a"')],
      }),
    ]),
  ),
  c(w([json({ status: 'completed', output: [] })])),
  c(w([json({ status: 'completed' })])),
  c(w([json({ error: { message: 'json failure' } })])),
  c(w([json({ error: 'string failure' })])),
  c(w([json('null')])),
  c(w([json('[]')])),
  c(w([json('{"output":5}')])),
  c(w([json('{"trunc')])),
  c(w([plain('<html><body>shell</body></html>', 200, 'application/json')])),
  c(w([json({ output: [rmsg('Your credits have been exhausted.')] })])),
  c(
    w([
      json({ output: Array.from({ length: 101 }, (_, i) => fcall(`f${i}`, `c${i}`, 'f', '{}')) }),
    ]),
  ),
  c(w([json({ output: [null] })])),
  // HTTP errors
  c(w([plain('{"error":{"message":"invalid key"}}', 401, 'application/json')])),
  c(w([plain('<html><head><title>Blocked</title></head></html>', 403, 'text/html')])),
  c(w([plain(null, 500)])),
  c(w([{ status: 200, headers: SSE, body: null }])),
  c(w([{ reject: { message: 'network down' } }])),
  c(w([plain('busy', 503), ok([rtext('after'), completed({})])]), { delays: [5] }),
  // watchdog
  c(w([{ hang: true }])),
  c(w([{ hang: true }]), { options: { idleTimeoutMs: 2000 } }),
  c(w([{ hang: true }], { abortAt: 400 })),
  c(w([ok([rtext('a'), completed({})])]), { options: { idleTimeoutMs: 5000 }, activity: true }),
  // budgets
  c(w([ok(Array.from({ length: 101 }, (_, i) => added(`f${i}`)))])),
  c(w([ok([...Array.from({ length: 100 }, (_, i) => added(`f${i}`)), completed({})])])),
  c(w([ok([added('f'), argd('f', 'x'.repeat(512001))])])),
  c(
    w([
      ok([
        added('f'),
        argd('f', 'x'.repeat(256000)),
        argd('f', 'x'.repeat(256000)),
        argd('f', 'y'),
        completed({}),
      ]),
    ]),
  ),
  c(w([ok([added(), added(), argd(undefined, 'ab'), argd('f', 'c'), completed({})])])),
  // the request as sent
  c(w([ok([rtext('ok'), completed({})])]), { options: { reasoningEffort: 'high' } }),
  c(w([ok([rtext('ok'), completed({})])]), { options: { reasoningEffort: '' } }),
  c(w([ok([rtext('ok'), completed({})])]), {
    options: {
      bodyExtras: { service_tier: 'flex', store: true, stream: false, max_output_tokens: 1 },
    },
  }),
  c(w([ok([rtext('ok'), completed({})])]), {
    options: {
      headers: {
        'x-extra': '1',
        Authorization: 'Bearer override',
        'Content-Type': 'application/x-custom',
      },
    },
  }),
  c(w([ok([rtext('ok'), completed({})])]), { config: { model: 'gpt-5.4' }, tools: toolDefs }),
  c(w([ok([rtext('ok'), completed({})])]), { messages: richMessages, tools: toolDefs }),
  c(w([ok([rtext('ok'), completed({})])]), {
    messages: [
      { role: 'user', text: 'go' },
      {
        role: 'assistant',
        text: 'calling',
        toolCalls: [
          { id: 'c1', name: 'f', input: { a: 1 }, signature: RSIG },
          { id: 'c2', name: 'g', input: {} },
        ],
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c3', name: 'h', input: {}, signature: 'oai-rs:{bad' }],
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c4', name: 'h', input: {}, signature: 'oai-rs:{"id":1,"encrypted":"x"}' },
        ],
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c5', name: 'h', input: {}, signature: 'oai-rs:null' }],
      },
      {
        role: 'assistant',
        text: 'x',
        toolCalls: [{ id: 'c6', name: 'h', input: {}, signature: 'gemini-sig' }],
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c7', name: 'h', input: {}, signature: RSIG }],
      },
      { role: 'tool', results: [{ id: 'c1', name: 'f', output: 'out', isError: true }] },
    ],
  }),
  c(w([ok([rtext('ok'), completed({})])]), {
    messages: [
      { role: 'user', text: '', images: [] },
      { role: 'user', text: 'x', images: [{ mime: 'image/png', base64: 'QQ==' }] },
      { role: 'user', text: '', images: [{ mime: 'image/png', base64: 'Qg==' }] },
    ],
  }),
  c(w([ok([rtext('ok'), completed({})])]), { messages: [{ role: 'tool' }] }),
  c(w([ok([rtext('ok'), completed({})])]), {
    baseUrl: 'https://api.example.com/v1/?x=1#frag',
    config: {},
  }),
  c(w([]), { baseUrl: '::' }),
]

const respGroup: Group = {
  'openai-responses.streamOpenAiResponses': {
    ts: streamSpec(responsesStream),
    cases: responsesCases,
  },
  'openai-responses.chatOpenAiResponses': {
    ts: chatSpec((wd, o) =>
      responses.chatOpenAiResponses(
        wd,
        o.baseUrl ?? BASE,
        (o.config ?? DEFAULT_CONFIG) as Any,
        o.system ?? 'sys',
        o.user ?? 'question',
        (o.options ?? {}) as Any,
      ),
    ),
    cases: [
      c(w([json({ output: [rmsg('answer'), { type: 'reasoning' }, rmsg(' two')] })])),
      c(
        w([
          json({
            output: [
              {
                type: 'message',
                content: [
                  { type: 'output_text', text: 'a' },
                  { type: 'other', text: 'b' },
                  { type: 'output_text' },
                ],
              },
            ],
          }),
        ]),
      ),
      c(w([json({ output: [{ type: 'message' }] })])),
      c(w([json({ output: [] })])),
      c(w([json({})])),
      c(w([json({ error: { message: 'bad' } })])),
      c(w([json({ error: 'plain' })])),
      c(w([json({ error: {} })])),
      c(w([json('null')])),
      c(w([json('[1]')])),
      c(w([json('{"output":"x"}')])),
      c(w([json('{"output":[null]}')])),
      c(w([plain('<html>page</html>', 200, 'text/html')])),
      c(w([plain('', 200)])),
      c(w([plain('{"error":"auth"}', 401, 'application/json')])),
      c(w([plain('<html><head><title>WAF</title></head></html>', 403, 'text/html')])),
      c(w([plain(null, 500)])),
      c(w([json({ output: [rmsg('x')] })]), {
        options: {
          reasoningEffort: 'low',
          headers: { 'x-a': 'b' },
          bodyExtras: { metadata: { a: 1 } },
        },
      }),
      c(w([{ hang: true }])),
      c(w([{ hang: true }], { abortAt: 300 })),
      c(w([{ reject: { message: 'down' } }])),
      c(w([]), { baseUrl: 'bad' }),
      c(w([plain('busy', 503), json({ output: [rmsg('later')] })]), { delays: [3] }),
    ],
  },
}

// ---------------------------------------------------------------------------
// protocols/gateway-complete.ts
// ---------------------------------------------------------------------------

const GW = 'https://gateway.example.com/v1'
const gwOk = ok([txt('gateway says hi'), fin('stop'), usage(3, 1)])
const gwChat = json({ choices: [{ message: { content: 'gateway answer' } }] })

interface GwStep {
  provider?: boolean | 'clear'
  request?: boolean
  baseUrl?: string
  config?: Record<string, unknown>
}

const gatewayGroup: Group = {
  'gateway-complete.GATEWAY_TOKEN_ENV': {
    ts: () => gateway.GATEWAY_TOKEN_ENV,
    cases: [c()],
    single: 'a constant',
  },
  'gateway-complete.streamGatewayComplete': {
    ts: streamSpec(gatewayStream),
    cases: [
      c(w([gwOk], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: ' env-token ' } }), { baseUrl: GW }),
      c(w([gwOk], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'env-token' } }), {
        baseUrl: GW,
        config: { model: 'gw', apiKey: 'settings-key' },
      }),
      c(w([gwOk], { calls: ['  provider-token\n'] }), {
        baseUrl: GW,
        provider: true,
        activity: true,
      }),
      c(w([gwOk], { calls: ['tok'], env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'env-ignored' } }), {
        baseUrl: GW,
        provider: true,
      }),
      c(w([]), { baseUrl: '' }),
      c(w([]), { baseUrl: GW }),
      c(w([], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: '   ' } }), { baseUrl: GW }),
      c(w([], { calls: ['  '] }), { baseUrl: GW, provider: true }),
      c(w([], { calls: [{ reject: 'token service down' }] }), { baseUrl: GW, provider: true }),
      c(w([gwOk], { calls: ['t'] }), { baseUrl: GW, provider: true, options: { timeoutMs: 3000 } }),
      c(w([{ hang: true }], { calls: ['t'] }), {
        baseUrl: GW,
        provider: true,
        options: { timeoutMs: 3000 },
      }),
      c(w([plain('{"error":"unauthorized"}', 401, 'application/json')], { calls: ['t'] }), {
        baseUrl: GW,
        provider: true,
      }),
      c(w([rejected, gwOk], { calls: ['t'] }), { baseUrl: GW, provider: true }),
    ],
  },
  'gateway-complete.chatGatewayComplete': {
    ts: chatSpec(async (wd, o, run) => {
      gateway.setGatewayTokenProvider(providerOf(run, o))
      try {
        return await gateway.chatGatewayComplete(
          wd,
          o.baseUrl ?? BASE,
          (o.config ?? DEFAULT_CONFIG) as Any,
          o.system ?? 'sys',
          o.user ?? 'question',
        )
      } finally {
        gateway.setGatewayTokenProvider(null)
      }
    }),
    cases: [
      c(w([gwChat], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'env-token' } }), { baseUrl: GW }),
      c(w([gwChat], { calls: ['provider-token'] }), { baseUrl: GW, provider: true }),
      c(w([]), { baseUrl: '' }),
      c(w([]), { baseUrl: GW }),
      c(w([], { calls: [{ reject: 'token service down' }] }), { baseUrl: GW, provider: true }),
      c(w([], { calls: [' '] }), { baseUrl: GW, provider: true }),
      c(w([plain('{"error":"no"}', 403, 'application/json')], { calls: ['t'] }), {
        baseUrl: GW,
        provider: true,
      }),
      c(w([json({ choices: [] })], { calls: ['t'] }), { baseUrl: GW, provider: true }),
    ],
  },
  'gateway-complete.setGatewayTokenProvider': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run) => {
        const steps = ((o as { steps?: GwStep[] } | null)?.steps ?? []) as GwStep[]
        setUp({})
        const out: unknown[] = []
        for (const step of steps) {
          if (step.provider === true) {
            gateway.setGatewayTokenProvider(() => run.call('token')() as Promise<string>)
            out.push('provider set')
          } else if (step.provider === 'clear') {
            gateway.setGatewayTokenProvider(null)
            out.push('provider cleared')
          }
          if (step.request) {
            const wd = watchdog.createStreamWatchdog()
            out.push(
              await wd.guard(() =>
                gateway.chatGatewayComplete(
                  wd,
                  step.baseUrl ?? GW,
                  (step.config ?? DEFAULT_CONFIG) as Any,
                  'sys',
                  'question',
                ),
              ),
            )
          }
        }
        gateway.setGatewayTokenProvider(null)
        return out
      }),
    cases: [
      c(
        w([gwChat, gwChat], {
          calls: ['from-provider'],
          env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'from-env' },
        }),
        {
          steps: [{ request: true }, { provider: true, request: true }],
        },
      ),
      c(w([gwChat, gwChat], { calls: ['p1'], env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'from-env' } }), {
        steps: [
          { provider: true, request: true },
          { provider: 'clear', request: true },
        ],
      }),
      c(w([], { calls: ['a', 'b'] }), {
        steps: [{ provider: true }, { provider: 'clear', request: true }],
      }),
    ],
  },
}

export const group: Group = {
  ...errors,
  ...caps,
  ...compatGroup,
  ...respGroup,
  ...gatewayGroup,
}
