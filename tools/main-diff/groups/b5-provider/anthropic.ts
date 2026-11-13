/**
 * Group `b5-provider`, part `anthropic` (Rust: crates/main-core/src/calls/b5_provider/anthropic.rs):
 * packages/ai-provider/src/protocols/anthropic.ts, gemini.ts and
 * gemini-schema.ts. Names are `anthropic.<export>`, `gemini.<export>` and
 * `gemini-schema.<export>`.
 *
 * `streamAnthropic`, `chatAnthropic`, `streamGemini` and `chatGemini` run in
 * the scripted world of world.ts (the first argument). The second argument is
 * what the call is given: `config` (`{ apiKey, model }`), `system`,
 * `messages`, `tools`, `maxTokens`, `baseUrl`, `bodyExtras` (Anthropic),
 * `options` (Gemini's `omitTemperature`), `user` (the chat functions),
 * `sessionId`, `activity` (a callback that logs `['activity']` per chunk) and
 * `bare` (no stop-reason and usage callbacks). The callbacks log `['delta',
 * text]`, `['tool', call]`, `['stop', reason]`, `['usage', usage]`. The chat
 * functions run under the watchdog a caller makes (`createStreamWatchdog`)
 * and answer the `AiChatResponse`.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const anthropic = await import('../../../../packages/ai-provider/src/protocols/anthropic.ts')
const gemini = await import('../../../../packages/ai-provider/src/protocols/gemini.ts')
const geminiSchema = await import('../../../../packages/ai-provider/src/protocols/gemini-schema.ts')
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')
const watchdog = await import('../../../../packages/ai-provider/src/watchdog.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Opts {
  config?: Record<string, unknown>
  system?: string
  user?: string
  messages?: unknown[]
  tools?: unknown[]
  maxTokens?: number
  baseUrl?: string
  bodyExtras?: Record<string, unknown>
  options?: { omitTemperature?: boolean }
  sessionId?: string
  activity?: boolean
  bare?: boolean
}

const CONFIG = { apiKey: 'sk-test', model: 'model-1' }
const HI = [{ role: 'user', text: 'hi' }]

function setUp(): void {
  fetchMod.setRescueFetch(null)
  fetchMod.setAiFetch(null)
  fetchMod.setAiUserAgent('')
  fetchMod.setAiTransientRetryDelays(null)
}

function callbacks(o: Opts, cx: TsContext, signal: AbortSignal): Any {
  const cb: Any = {
    onDelta: (t: string) => cx.log('delta', t),
    onToolCall: (call: unknown) => cx.log('tool', call),
    signal,
  }
  if (!o.bare) {
    cb.onStopReason = (r: string) => cx.log('stop', r)
    cb.onUsage = (u: unknown) => cx.log('usage', u)
  }
  if (o.activity) cb.onActivity = () => cx.log('activity')
  if (o.sessionId !== undefined) cb.sessionId = o.sessionId
  return cb
}

const streamArgs = (o: Opts) =>
  [
    o.config ?? CONFIG,
    o.system ?? 'You help.',
    o.messages ?? HI,
    o.tools ?? [],
    o.maxTokens ?? 4096,
  ] as [Any, string, Any, Any, number]

// ---------------------------------------------------------------------------
// the world's answers
// ---------------------------------------------------------------------------

const SSE: [string, string][] = [['content-type', 'text/event-stream']]
const JSON_TYPE: [string, string][] = [['content-type', 'application/json']]
const sse = (...events: unknown[]): Chunk[] =>
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
const stream = (events: unknown[], status = 200) => ({ status, headers: SSE, body: sse(...events) })
const rawStream = (chunks: Chunk[]) => ({ status: 200, headers: SSE, body: chunks })
const jsonBody = (body: unknown, status = 200) => ({
  status,
  headers: JSON_TYPE,
  body: [typeof body === 'string' ? body : JSON.stringify(body)],
})
const plain = (text: string | null, status: number, headers: [string, string][] = []) => ({
  status,
  headers,
  body: text === null ? null : [text],
})
const html = (status: number, body: string) =>
  plain(body, status, [['content-type', 'text/html; charset=utf-8']])
const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World
const c = (...args: unknown[]): Case => ({ args })
const cn = (note: string, ...args: unknown[]): Case => ({ args, note })
const redirect = {
  status: 302,
  headers: [['location', 'https://evil.example.net/steal']],
  body: ['moved'],
}
const BUSY = plain('busy', 503)

// Anthropic events
const start = (usage: unknown = { input_tokens: 10, output_tokens: 1 }) => ({
  type: 'message_start',
  message: { id: 'msg_1', usage },
})
const blockStart = (index: number | undefined, block: unknown) => ({
  type: 'content_block_start',
  ...(index === undefined ? {} : { index }),
  content_block: block,
})
const textStart = (index = 0) => blockStart(index, { type: 'text', text: '' })
const toolStart = (index: number | undefined, id: string | undefined, name: string | undefined) =>
  blockStart(index, {
    type: 'tool_use',
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    input: {},
  })
const textDelta = (text: string, index = 0) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'text_delta', text },
})
const thinkingDelta = (thinking: string, index = 0) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking },
})
const jsonDelta = (partial: unknown, index?: number) => ({
  type: 'content_block_delta',
  ...(index === undefined ? {} : { index }),
  delta: { type: 'input_json_delta', partial_json: partial },
})
const blockStop = (index?: number) => ({
  type: 'content_block_stop',
  ...(index === undefined ? {} : { index }),
})
const msgDelta = (stopReason: unknown, usage?: unknown) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason },
  ...(usage === undefined ? {} : { usage }),
})
const msgStop = { type: 'message_stop' }
const ping = { type: 'ping' }
const textTurn = (...texts: string[]) => [
  start(),
  textStart(),
  ...texts.map((t) => textDelta(t)),
  blockStop(0),
  msgDelta('end_turn', { output_tokens: 7 }),
  msgStop,
]
const toolTurn = (id: string, name: string, ...pieces: string[]) => [
  start(),
  toolStart(0, id, name),
  ...pieces.map((p) => jsonDelta(p, 0)),
  blockStop(0),
  msgDelta('tool_use', { output_tokens: 20 }),
  msgStop,
]

// Gemini chunks
const part = (text: string) => ({ text })
const call = (name: unknown, args?: unknown, extra: Record<string, unknown> = {}) => ({
  functionCall: {
    ...(name === undefined ? {} : { name }),
    ...(args === undefined ? {} : { args }),
  },
  ...extra,
})
const chunk = (
  parts: unknown[] | undefined,
  finishReason?: unknown,
  usage?: unknown,
  extra: Record<string, unknown> = {},
) => ({
  candidates: [
    {
      ...(parts === undefined ? {} : { content: { parts } }),
      ...(finishReason === undefined ? {} : { finishReason }),
    },
  ],
  ...(usage === undefined ? {} : { usageMetadata: usage }),
  ...extra,
})
const gUsage = (prompt: number, out: number) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: out,
})

// ---------------------------------------------------------------------------
// shared request shapes
// ---------------------------------------------------------------------------

const ALL_ROLES = [
  { role: 'user', text: 'look', images: [{ mime: 'image/png', base64: 'AAAA' }] },
  {
    role: 'assistant',
    text: 'checking',
    toolCalls: [
      { id: 't1', name: 'search', input: { q: 'x' }, signature: 'sig-1' },
      { id: 't2', name: 'open', input: {} },
    ],
    reasoning: 'thought',
  },
  {
    role: 'tool',
    results: [
      { id: 't1', name: 'search', output: 'found' },
      { id: 't2', name: 'open', output: 'denied', isError: true },
      { id: 't3', name: 'quiet', output: 'fine', isError: false },
    ],
  },
  { role: 'assistant', text: '' },
  { role: 'user', text: 'again', images: [] },
  { role: 'user', text: '', images: [{ mime: 'image/jpeg', base64: 'BBBB' }] },
  { role: 'assistant', text: '', toolCalls: [{ id: 't4', name: 'late', input: { a: 1 } }] },
  { role: 'assistant', text: 'tail', toolCalls: [] },
  { role: 'user' },
]
const TOOLS = [
  {
    name: 'search',
    description: 'Find things',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  { name: 'noop', inputSchema: { type: 'object', properties: {} } },
]
const SIMPLE_OK = stream(textTurn('ok'))
const GEMINI_OK = stream([chunk([part('ok')], 'STOP', gUsage(3, 1))])

// ---------------------------------------------------------------------------
// protocols/anthropic.ts
// ---------------------------------------------------------------------------

const anthropicStream: Group = {
  'anthropic.ANTHROPIC_BASE_URL': {
    ts: () => anthropic.ANTHROPIC_BASE_URL,
    cases: [c()],
    single: 'a constant',
  },
  'anthropic.streamAnthropic': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const s = (o ?? {}) as Opts
        const [config, system, messages, tools, maxTokens] = streamArgs(s)
        await anthropic.streamAnthropic(
          config,
          system,
          messages,
          tools,
          maxTokens,
          callbacks(s, cx, signal),
          s.baseUrl,
          s.bodyExtras,
        )
      }),
    cases: [
      // ---- text, thinking and usage ----
      cn('a text turn with its usage and the activity ping', w([stream(textTurn('Hel', 'lo'))]), {
        activity: true,
      }),
      cn(
        'thinking, pings and signature deltas are not text',
        w([
          stream([
            start(),
            ping,
            blockStart(0, { type: 'thinking', thinking: '' }),
            thinkingDelta('hmm'),
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'abc' },
            },
            blockStop(0),
            textStart(1),
            textDelta('answer', 1),
            blockStop(1),
            msgDelta('end_turn', { output_tokens: 3 }),
            msgStop,
          ]),
        ]),
        {},
      ),
      cn(
        'cached input is added to the fresh input',
        w([
          stream([
            start({
              input_tokens: 4,
              output_tokens: 1,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 20,
            }),
            textDelta('x'),
            msgDelta('end_turn', { output_tokens: 9 }),
          ]),
        ]),
        {},
      ),
      cn(
        'only a cached input counts when the fresh one is missing',
        w([
          stream([
            start({ cache_read_input_tokens: 50 }),
            textDelta('x'),
            msgDelta('end_turn', { input_tokens: 'many', output_tokens: '12' }),
          ]),
        ]),
        {},
      ),
      cn(
        'usage with nothing countable fires no callback',
        w([
          stream([
            start({ input_tokens: -1, output_tokens: 'x' }),
            textDelta('x'),
            msgDelta('end_turn', null),
          ]),
        ]),
        {},
      ),
      cn(
        'message_delta usage supersedes message_start',
        w([
          stream([
            start({ input_tokens: 10, output_tokens: 1 }),
            textDelta('x'),
            msgDelta('end_turn', { input_tokens: 11, output_tokens: 30 }),
          ]),
        ]),
        {},
      ),
      cn('no stop or usage callbacks', w([stream(textTurn('quiet'))]), { bare: true }),
      cn(
        'an empty closing turn that carries its stop reason passes',
        w([stream([start(), msgDelta('end_turn', { output_tokens: 0 }), msgStop])]),
        {},
      ),
      cn(
        'a multibyte character cut between two chunks',
        w([
          rawStream([
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"',
            { hex: 'ed95' },
            { hex: '9c' },
            '"}}\n\n',
            ...sse(msgDelta('end_turn')),
          ]),
        ]),
        {},
      ),
      cn(
        'non-JSON keep-alives and a truncated frame are skipped',
        w([
          rawStream([
            ...sse('ping', '[DONE]', '{"type":"content_block_delta","delta":'),
            ...sse(textDelta('still here'), msgDelta('end_turn')),
            'event: message_stop\n',
          ]),
        ]),
        {},
      ),
      cn(
        'an event that is a plain value carries nothing',
        w([stream([5, 'text', [1], true, textDelta('after'), msgDelta('end_turn')])]),
        {},
      ),
      cn(
        'a null event throws on its type',
        w([stream([start(), 'null', msgDelta('end_turn')])]),
        {},
      ),

      // ---- tool use ----
      cn(
        'a tool call whose arguments arrive in pieces',
        w([stream(toolTurn('toolu_1', 'search', '{"q":', '"cats"', '}'))]),
        {},
      ),
      cn(
        'text, then a tool call; the calls are emitted at the end',
        w([
          stream([
            start(),
            textStart(0),
            textDelta('Let me look.'),
            blockStop(0),
            toolStart(1, 'toolu_2', 'open'),
            jsonDelta('{"path":"a.md"}', 1),
            blockStop(1),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'two tools interleaved by index',
        w([
          stream([
            start(),
            toolStart(1, 'a', 'one'),
            toolStart(2, 'b', 'two'),
            jsonDelta('{"x":', 1),
            jsonDelta('{"y":2}', 2),
            jsonDelta('1}', 1),
            blockStop(2),
            blockStop(1),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'events without an index follow the last started block',
        w([
          stream([
            start(),
            toolStart(3, 'a', 'one'),
            jsonDelta('{"x":'),
            jsonDelta('1}'),
            blockStop(),
            toolStart(undefined, 'b', 'two'),
            jsonDelta('{}'),
            blockStop(),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'a tool without an id gets one, a nameless one is dropped',
        w([
          stream([
            start(),
            toolStart(0, undefined, 'idless'),
            jsonDelta('{"a":1}', 0),
            blockStop(0),
            toolStart(1, 'x', undefined),
            jsonDelta('{}', 1),
            blockStop(1),
            toolStart(2, 'y', ''),
            blockStop(2),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'broken, repaired and non-object arguments',
        w([
          stream([
            start(),
            toolStart(0, 'a', 'broken'),
            jsonDelta('{"a":', 0),
            blockStop(0),
            toolStart(1, 'b', 'quotes'),
            jsonDelta('{"note":"he said "hi" to me","n":1}', 1),
            blockStop(1),
            toolStart(2, 'c', 'array'),
            jsonDelta('[1,2]', 2),
            blockStop(2),
            toolStart(3, 'd', 'empty'),
            blockStop(3),
            toolStart(4, 'e', 'blank'),
            jsonDelta('   ', 4),
            blockStop(4),
            toolStart(5, 'f', 'long'),
            jsonDelta(`{"x":${'y'.repeat(600)}`, 5),
            blockStop(5),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'a delta for a block that never started, a restarted index, a non-string fragment',
        w([
          stream([
            start(),
            jsonDelta('{"ghost":1}', 7),
            toolStart(0, 'a', 'first'),
            jsonDelta('{"old":', 0),
            toolStart(0, 'b', 'second'),
            jsonDelta(5, 0),
            jsonDelta(null, 0),
            blockStop(0),
            blockStop(9),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'indexes that are not numbers are Map keys of their own',
        w([
          stream([
            start(),
            blockStart('1' as unknown as number, { type: 'tool_use', id: 's', name: 'str' }),
            jsonDelta('{"a":1}', '1' as unknown as number),
            jsonDelta('{"b":2}', 1),
            blockStop('1' as unknown as number),
            blockStart(null as unknown as number, { type: 'tool_use', id: 'n', name: 'nul' }),
            jsonDelta('{"c":3}'),
            blockStop(),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'a max_tokens stop marks the last finished call as truncated',
        w([
          stream([
            start(),
            toolStart(0, 'a', 'one'),
            jsonDelta('{"k":1}', 0),
            blockStop(0),
            toolStart(1, 'b', 'two'),
            jsonDelta('{"k":2}', 1),
            blockStop(1),
            msgDelta('max_tokens'),
          ]),
        ]),
        {},
      ),
      cn(
        'a max_tokens stop cuts a call before its block stop',
        w([
          stream([
            start(),
            textDelta('partial'),
            toolStart(0, 'a', 'one'),
            jsonDelta('{"k":', 0),
            toolStart(1, 'b', ''),
            msgDelta('max_tokens'),
          ]),
        ]),
        {},
      ),
      cn(
        'a stop reason that is not max_tokens does not truncate',
        w([stream(toolTurn('a', 'one', '{"k":1}'))]),
        { maxTokens: 10 },
      ),
      cn(
        'the stream closed while a call was still arriving',
        w([
          stream([start(), toolStart(0, 'a', 'one'), jsonDelta('{"big":"', 0), jsonDelta('é', 0)]),
        ]),
        {},
      ),
      cn(
        'more than 100 tool calls in one turn',
        w([
          stream([
            start(),
            ...Array.from({ length: 101 }, (_, i) => toolStart(i, `t${i}`, 'many')),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'exactly 100 tool calls pass',
        w([
          stream([
            start(),
            ...Array.from({ length: 100 }, (_, i) => [
              toolStart(i, `t${i}`, 'many'),
              blockStop(i),
            ]).flat(),
            msgDelta('tool_use'),
          ]),
        ]),
        { bare: true },
      ),
      cn(
        'finished calls count against the budget too',
        w([
          stream([
            start(),
            ...Array.from({ length: 100 }, (_, i) => [
              toolStart(i, `t${i}`, 'many'),
              blockStop(i),
            ]).flat(),
            toolStart(100, 'last', 'many'),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'one call over the argument budget',
        w([
          stream([
            start(),
            toolStart(0, 'a', 'one'),
            jsonDelta('x'.repeat(512_000), 0),
            jsonDelta('y', 0),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),
      cn(
        'one call exactly at the argument budget',
        w([
          stream([
            start(),
            toolStart(0, 'a', 'one'),
            jsonDelta('x'.repeat(512_000), 0),
            blockStop(0),
            msgDelta('tool_use'),
          ]),
        ]),
        {},
      ),

      // ---- how a stream ends ----
      cn('a stream with no events at all', w([plain('', 200, SSE)]), {}),
      cn('a stream of only pings', w([stream([ping, ping])]), {}),
      cn('a message start and nothing else', w([stream([start()])]), {}),
      cn(
        'finished calls with no stop reason',
        w([stream([start(), toolStart(0, 'a', 'one'), jsonDelta('{"k":1}', 0), blockStop(0)])]),
        {},
      ),
      cn('text without a stop reason', w([stream([start(), textDelta('cut off')])]), {}),
      cn('a body of non-event lines', w([rawStream(['event: ping\n', ': comment\n\n'])]), {}),
      cn('a response with no body', w([plain(null, 200, SSE)]), {}),
      cn('an empty stop reason does not count', w([stream([textDelta('x'), msgDelta('')])]), {}),

      // ---- errors inside the stream ----
      cn(
        'an error event after some text',
        w([
          stream([
            start(),
            textDelta('partial'),
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            textDelta('never'),
          ]),
        ]),
        {},
      ),
      cn('an error event with no message', w([stream([{ type: 'error' }])]), {}),
      cn(
        'an error event with an unreadable message',
        w([stream([{ type: 'error', error: { code: 5 } }])]),
        {},
      ),
      cn(
        'a gateway error in another shape',
        w([stream([start(), { error: 'quota used up' }])]),
        {},
      ),
      cn(
        'a gateway error object',
        w([stream([{ error: { code: 429, detail: 'slow down' } }])]),
        {},
      ),
      cn(
        'an empty error is no error',
        w([stream([{ error: '', type: 'ping' }, textDelta('x'), msgDelta('end_turn')])]),
        {},
      ),
      cn(
        'an error key on a known event is not read',
        w([stream([{ ...textDelta('kept'), error: 'late' }, msgDelta('end_turn')])]),
        {},
      ),

      // ---- a JSON body instead of a stream ----
      cn(
        'a message delivered as plain JSON',
        w([
          jsonBody({
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'thinking', thinking: 'x' },
              { type: 'text', text: 'there' },
              { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'a' } },
              { type: 'tool_use', name: 'no_id' },
              { type: 'tool_use', id: 'tu_3' },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 4 },
          }),
        ]),
        {},
      ),
      cn(
        'a JSON body cut by max_tokens truncates its last call',
        w([
          jsonBody({
            content: [{ type: 'tool_use', id: 'a', name: 'one', input: { k: 1 } }],
            stop_reason: 'max_tokens',
          }),
        ]),
        {},
      ),
      cn(
        'a JSON body without a stop reason or usage',
        w([jsonBody({ content: [{ type: 'text', text: 'x' }] })]),
        { bare: true },
      ),
      cn('a JSON body that is an error', w([jsonBody({ error: { message: 'Overloaded' } })]), {}),
      cn('a JSON body error of another shape', w([jsonBody({ error: 'nope' })]), {}),
      cn(
        'a JSON body with no content',
        w([jsonBody({ content: [], stop_reason: 'end_turn' })]),
        {},
      ),
      cn(
        'a JSON body with blocks of no use',
        w([jsonBody({ content: [{ type: 'text', text: '' }, { type: 'thinking' }, 'str', 5] })]),
        {},
      ),
      cn('a JSON body that is not JSON', w([jsonBody('<<not json>>')]), {}),
      cn('a JSON body that is null', w([jsonBody('null')]), {}),
      cn('a JSON body that is an array', w([jsonBody('[1,2]')]), {}),
      cn('a JSON body with a null block', w([jsonBody({ content: [null] })]), {}),
      cn('a JSON body with content of the wrong type', w([jsonBody({ content: 5 })]), {}),
      cn('a JSON body with content that is a string', w([jsonBody({ content: 'text' })]), {}),
      cn(
        'a JSON body that is the credits notice',
        w([
          jsonBody({
            content: [{ type: 'text', text: 'Your credits have been exhausted. Top up.' }],
          }),
        ]),
        {},
      ),
      cn(
        'a JSON body over the tool budget',
        w([
          jsonBody({
            content: Array.from({ length: 101 }, (_, i) => ({
              type: 'tool_use',
              id: `t${i}`,
              name: 'many',
            })),
          }),
        ]),
        {},
      ),
      cn(
        'a JSON body with text and the tool budget exceeded after it',
        w([
          jsonBody({
            content: [
              { type: 'text', text: 'first' },
              ...Array.from({ length: 101 }, (_, i) => ({
                type: 'tool_use',
                id: `t${i}`,
                name: 'many',
              })),
            ],
          }),
        ]),
        {},
      ),

      // ---- HTTP errors ----
      cn(
        'a 400 with a JSON error',
        w([jsonBody({ type: 'error', error: { message: 'bad' } }, 400)]),
        {},
      ),
      cn('a 401 with a long body', w([plain('k'.repeat(900), 401)]), {}),
      cn('a 500 with no body text', w([plain('', 500)]), {}),
      cn('a 502 with no body at all', w([plain(null, 502)]), {}),
      cn(
        'a 403 block page of a CDN',
        w([
          html(
            403,
            '<html><head><title>Attention Required! | Cloudflare</title></head><body>Error code: 1020 Ray ID: 0123456789abcdef</body></html>',
          ),
        ]),
        {},
      ),
      cn('a 200 with no body', w([plain(null, 200, SSE)]), { activity: true }),
      cn('a 503 is asked again once', w([BUSY, SIMPLE_OK]), {}),
      cn('a 503 three times', w([BUSY, BUSY, BUSY]), {}),
      cn(
        'an error body over the size cap',
        w([plain('x', 500, [['content-length', '9999999']])]),
        {},
      ),
      cn('a JSON body of an empty object', w([jsonBody('{}', 200)]), { bare: true }),

      // ---- the request ----
      cn('every message role and a tool list', w([SIMPLE_OK]), {
        messages: ALL_ROLES,
        tools: TOOLS,
        system: 'Be brief.',
      }),
      cn('the route adds fields, one replaces a field of the request', w([SIMPLE_OK]), {
        bodyExtras: {
          output_config: { effort: 'high' },
          max_tokens: 99,
          stream: false,
          thinking: { type: 'enabled' },
        },
        tools: TOOLS,
      }),
      cn('a base URL with a path, a trailing slash and a query', w([SIMPLE_OK]), {
        baseUrl: 'https://gw.example.com/proxy/?api-version=2',
      }),
      cn('the default base URL', w([SIMPLE_OK]), {}),
      cn('an opencode gateway gets a session header', w([SIMPLE_OK]), {
        baseUrl: 'https://opencode.ai/zen/v1',
        sessionId: 'sess-1',
      }),
      cn('an opencode gateway without a session id draws one', w([SIMPLE_OK]), {
        baseUrl: 'https://opencode.ai/zen/v1',
      }),
      cn('an opencode gateway with an empty session id draws one', w([SIMPLE_OK]), {
        baseUrl: 'https://opencode.ai/zen/v1',
        sessionId: '',
      }),
      cn('a config without a key or a model', w([SIMPLE_OK]), { config: {} }),
      cn('a config whose key is not a string', w([SIMPLE_OK]), {
        config: { apiKey: null, model: 7 },
      }),
      cn('a tool whose schema is missing', w([SIMPLE_OK]), { tools: [{ name: 'bare' }] }),
      cn('Korean text in a user turn', w([SIMPLE_OK]), {
        messages: [{ role: 'user', text: '문서를 요약해 줘' }],
        system: '한국어로 답한다.',
      }),
      cn('an assistant turn with a tool call that has no input', w([SIMPLE_OK]), {
        messages: [{ role: 'assistant', text: 'x', toolCalls: [{ id: 'a', name: 'n' }] }],
      }),
      cn('messages that are not a list', w([SIMPLE_OK]), {
        messages: 'hello' as unknown as unknown[],
      }),
      cn('a null message', w([SIMPLE_OK]), { messages: [{ role: 'user', text: 'a' }, null] }),
      cn('a message of another kind is read as a tool turn', w([SIMPLE_OK]), {
        messages: [{ role: 'tool' }],
      }),
      cn('a tool turn whose results are not a list', w([SIMPLE_OK]), {
        messages: [{ role: 'tool', results: 'x' }],
      }),
      cn('a tool turn with a null result', w([SIMPLE_OK]), {
        messages: [{ role: 'tool', results: [null] }],
      }),
      cn('images of the wrong type', w([SIMPLE_OK]), {
        messages: [{ role: 'user', text: 'a', images: 'ab' }],
      }),
      cn('an image that is null', w([SIMPLE_OK]), {
        messages: [{ role: 'user', text: 'a', images: [null] }],
      }),
      cn('tool calls that are not a list', w([SIMPLE_OK]), {
        messages: [{ role: 'assistant', text: 'a', toolCalls: 5 }],
      }),
      cn('tool calls given as a string', w([SIMPLE_OK]), {
        messages: [{ role: 'assistant', text: 'a', toolCalls: 'ab' }],
      }),
      cn('a null tool call', w([SIMPLE_OK]), {
        messages: [{ role: 'assistant', text: 'a', toolCalls: [null] }],
      }),

      // ---- the connection ----
      cn(
        'a refused connection',
        w([{ reject: { class: 'TypeError', message: 'fetch failed' } }]),
        {},
      ),
      cn(
        'a refused connection with its cause',
        w([
          {
            reject: {
              class: 'TypeError',
              message: 'fetch failed',
              cause: { code: 'ECONNRESET', message: 'read ECONNRESET' },
            },
          },
        ]),
        {},
      ),
      cn(
        'a cause with a message only',
        w([{ reject: { message: 'down', cause: { message: 'dns lookup failed' } } }]),
        {},
      ),
      cn('a cause that is text', w([{ reject: { message: 'down', cause: 'plain cause' } }]), {}),
      cn('a cause that is an empty object', w([{ reject: { message: 'down', cause: {} } }]), {}),
      cn('a cause that is falsy', w([{ reject: { message: 'down', cause: '' } }]), {}),
      cn('an error with an empty message', w([{ reject: { message: '' } }]), {}),
      cn(
        'an error with an empty message and a name',
        w([{ reject: { message: '', name: 'ConnectError' } }]),
        {},
      ),
      cn('no fetch left in the script', w([]), {}),
      cn('a refused redirect is not a failed connection', w([redirect]), {}),
      cn(
        'a redirect to a relative address',
        w([{ status: 307, headers: [['location', '/v2/messages']], body: ['x'] }]),
        {},
      ),
      cn('a base URL that cannot be read', w([SIMPLE_OK]), { baseUrl: 'not a url' }),
      cn('a silent server: the connect timeout', w([{ hang: true }]), {}),
      cn('the caller cancels while it waits', w([{ hang: true }], { abortAt: 1000 }), {}),
    ],
  },
  'anthropic.chatAnthropic': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const s = (o ?? {}) as Opts
        const wd = watchdog.createStreamWatchdog(signal)
        return wd.guard(() =>
          anthropic.chatAnthropic(
            wd,
            (s.config ?? CONFIG) as Any,
            s.system ?? 'You help.',
            s.user ?? 'Say hi',
            s.baseUrl,
            s.bodyExtras,
          ),
        )
      }),
    cases: [
      cn(
        'the text of an answer',
        w([jsonBody({ content: [{ type: 'text', text: 'Hello.' }] })]),
        {},
      ),
      cn(
        'text blocks join, other blocks are left out',
        w([
          jsonBody({
            content: [
              { type: 'thinking', thinking: 'x' },
              { type: 'text', text: 'one ' },
              { type: 'text' },
              { type: 'text', text: 'two' },
              { type: 'text', text: 3 },
            ],
          }),
        ]),
        {},
      ),
      cn('a text that is a list', w([jsonBody({ content: [{ type: 'text', text: [1, 2] }] })]), {}),
      cn(
        'the request: base URL, extras and the session header',
        w([jsonBody({ content: [{ type: 'text', text: 'k' }] })]),
        {
          baseUrl: 'https://opencode.ai/zen/v1/',
          bodyExtras: { output_config: { effort: 'low' }, max_tokens: 5 },
          system: '시스템',
          user: '질문',
        },
      ),
      cn('an answer that is not JSON', w([plain('<<nope>>', 200)]), {}),
      cn(
        'a gateway shell page with a 200',
        w([html(200, '<!DOCTYPE html><html><head><title>Sign in</title></head></html>')]),
        {},
      ),
      cn('an empty body with a 200', w([plain('', 200)]), {}),
      cn('no content', w([jsonBody({ id: 'x' })]), {}),
      cn('empty content', w([jsonBody({ content: [] })]), {}),
      cn('content of null', w([jsonBody({ content: null })]), {}),
      cn('only an empty text', w([jsonBody({ content: [{ type: 'text', text: '' }] })]), {}),
      cn('a body that is null', w([jsonBody('null')]), {}),
      cn('a body that is a number', w([jsonBody('5')]), {}),
      cn('content that is a string', w([jsonBody({ content: 'text' })]), {}),
      cn('a block that is null', w([jsonBody({ content: [null] })]), {}),
      cn('a 401', w([jsonBody({ error: { message: 'invalid x-api-key' } }, 401)]), {}),
      cn('a 413 with a long body', w([plain('r'.repeat(700), 413)]), {}),
      cn(
        'a 503 is asked again',
        w([BUSY, jsonBody({ content: [{ type: 'text', text: 'late' }] })]),
        {},
      ),
      cn(
        'an error page of a CDN',
        w([
          html(
            403,
            '<html><head><title>Blocked</title></head><body>Cloudflare Ray ID: fedcba9876543210</body></html>',
          ),
        ]),
        {},
      ),
      cn('an error body over the cap', w([plain('x', 500, [['content-length', '9999999']])]), {}),
      cn('an answer over the cap', w([plain('x', 200, [['content-length', '9999999']])]), {}),
      cn(
        'a refused connection',
        w([{ reject: { class: 'TypeError', message: 'fetch failed' } }]),
        {},
      ),
      cn('a refused redirect', w([redirect]), {}),
      cn('a base URL that cannot be read', w([]), { baseUrl: '::' }),
      cn('a silent server', w([{ hang: true }]), {}),
      cn('the caller cancels', w([{ hang: true }], { abortAt: 500 }), {}),
    ],
  },
}

// ---------------------------------------------------------------------------
// protocols/gemini.ts
// ---------------------------------------------------------------------------

const geminiGroup: Group = {
  'gemini.GEMINI_BASE_URL': {
    ts: () => gemini.GEMINI_BASE_URL,
    cases: [c()],
    single: 'a constant',
  },
  'gemini.streamGemini': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const s = (o ?? {}) as Opts
        const [config, system, messages, tools, maxTokens] = streamArgs(s)
        await gemini.streamGemini(
          config,
          system,
          messages,
          tools,
          maxTokens,
          callbacks(s, cx, signal),
          s.baseUrl,
          s.options,
        )
      }),
    cases: [
      // ---- text and usage ----
      cn(
        'a text turn: later usage supersedes earlier',
        w([
          stream([
            chunk([part('Hel')], undefined, gUsage(5, 1)),
            chunk([part('lo')], undefined, gUsage(5, 2)),
            chunk([], 'STOP', gUsage(5, 4)),
          ]),
        ]),
        { activity: true },
      ),
      cn('no usage and no callbacks', w([stream([chunk([part('x')], 'STOP')])]), { bare: true }),
      cn(
        'usage with strings and bad counts',
        w([
          stream([
            chunk([part('x')], 'STOP', { promptTokenCount: '12', candidatesTokenCount: -3 }),
          ]),
        ]),
        {},
      ),
      cn('usage that is not an object', w([stream([chunk([part('x')], 'STOP', 'many')])]), {}),
      cn(
        'an empty turn that finished passes',
        w([stream([chunk(undefined, 'STOP', gUsage(2, 0))])]),
        {},
      ),
      cn('empty text parts are not content', w([stream([chunk([part('')], 'STOP')])]), {}),
      cn(
        'a max_tokens finish',
        w([stream([chunk([part('cut')], 'MAX_TOKENS', gUsage(1, 2))])]),
        {},
      ),
      cn('a safety finish after some text', w([stream([chunk([part('some')], 'SAFETY')])]), {}),
      cn('a safety finish with nothing before it', w([stream([chunk([], 'SAFETY')])]), {}),
      cn(
        'a recitation finish after a stop',
        w([stream([chunk([], 'RECITATION'), chunk([], 'STOP')])]),
        {},
      ),
      cn('a finish that is not text', w([stream([chunk([], 7)])]), {}),
      cn('an empty finish reason does not finish', w([stream([chunk([part('x')], '')])]), {}),
      cn('a stream with text and no finish', w([stream([chunk([part('cut off')])])]), {}),
      cn('an empty stream', w([plain('', 200, SSE)]), {}),
      cn('a chunk without candidates', w([stream([{ usageMetadata: gUsage(1, 1) }])]), {}),
      cn(
        'a multibyte character cut between two chunks',
        w([
          rawStream([
            'data: {"candidates":[{"content":{"parts":[{"text":"',
            { hex: 'ed95' },
            { hex: '9c' },
            '"}]},"finishReason":"STOP"}]}\n\n',
          ]),
        ]),
        {},
      ),
      cn(
        'keep-alives and a truncated frame are skipped',
        w([
          rawStream([
            ...sse('ping', '[DONE]', '{"candidates":'),
            ...sse(chunk([part('ok')], 'STOP')),
            ': keep\n',
          ]),
        ]),
        {},
      ),
      cn(
        'an event that is a plain value carries nothing',
        w([stream([5, 'str', [1], true, chunk([part('after')], 'STOP')])]),
        {},
      ),
      cn('a null event throws on its error', w([stream(['null', chunk([part('x')], 'STOP')])]), {}),
      cn(
        'candidates as an object with a key 0',
        w([
          stream([
            { candidates: { 0: { content: { parts: [part('odd')] }, finishReason: 'STOP' } } },
          ]),
        ]),
        {},
      ),
      cn('candidates that are text', w([stream([{ candidates: 'abc' }])]), {}),
      cn('parts that are not a list', w([stream([chunk(5 as unknown as unknown[], 'STOP')])]), {}),
      cn(
        'parts that are an object',
        w([stream([chunk({ a: 1 } as unknown as unknown[], 'STOP')])]),
        {},
      ),
      cn('parts that are text', w([stream([chunk('abc' as unknown as unknown[], 'STOP')])]), {}),
      cn('a part that is null', w([stream([chunk([null], 'STOP')])]), {}),

      // ---- tool calls ----
      cn(
        'a call with arguments and a signature, then text',
        w([
          stream([
            chunk(
              [call('search', { q: 'cats' }, { thoughtSignature: 'sig-a' }), part('after')],
              'STOP',
              gUsage(4, 4),
            ),
          ]),
        ]),
        {},
      ),
      cn(
        'a signature in snake_case',
        w([
          stream([
            chunk(
              [
                call('a', {}, { thought_signature: 'snake' }),
                call('b', { n: 1 }, { thoughtSignature: '', thought_signature: 'kept' }),
              ],
              'STOP',
            ),
          ]),
        ]),
        {},
      ),
      cn(
        'arguments of the wrong type',
        w([
          stream([
            chunk([call('s', 'text'), call('n', null), call('a', [1, 2]), call('x', 5)], 'STOP'),
          ]),
        ]),
        {},
      ),
      cn(
        'a long argument that is not an object',
        w([stream([chunk([call('s', 'z'.repeat(700))], 'STOP')])]),
        {},
      ),
      cn('a call with no arguments', w([stream([chunk([call('plain')], 'STOP')])]), {}),
      cn(
        'a call with no name is not a call',
        w([stream([chunk([call(undefined, { a: 1 }), call('', {}), call(0, {})], 'STOP')])]),
        {},
      ),
      cn('a name that is not text', w([stream([chunk([call(5, {})], 'STOP')])]), {}),
      cn(
        'calls over several chunks',
        w([stream([chunk([call('a', { n: 1 })]), chunk([call('b', { n: 2 })], 'STOP')])]),
        { activity: true },
      ),
      cn(
        'a call and a stop at the output cap',
        w([stream([chunk([call('a', {})], 'MAX_TOKENS')])]),
        {},
      ),
      cn(
        'more than 100 calls',
        w([
          stream([
            chunk(
              Array.from({ length: 101 }, (_, i) => call(`t${i}`, {})),
              'STOP',
            ),
          ]),
        ]),
        {},
      ),
      cn(
        'exactly 100 calls',
        w([
          stream([
            chunk(
              Array.from({ length: 100 }, (_, i) => call(`t${i}`, {})),
              'STOP',
            ),
          ]),
        ]),
        { bare: true },
      ),

      // ---- errors inside the stream ----
      cn('a blocked prompt', w([stream([{ promptFeedback: { blockReason: 'SAFETY' } }])]), {}),
      cn(
        'a block reason that is not text',
        w([stream([{ promptFeedback: { blockReason: 3 } }])]),
        {},
      ),
      cn(
        'an empty block reason is no block',
        w([stream([{ promptFeedback: { blockReason: '' } }, chunk([part('x')], 'STOP')])]),
        {},
      ),
      cn(
        'an error event',
        w([
          stream([
            chunk([part('before')]),
            { error: { code: 503, message: 'The model is overloaded' } },
          ]),
        ]),
        {},
      ),
      cn('an error event of text', w([stream([{ error: 'quota exceeded' }])]), {}),
      cn('an error event of no message', w([stream([{ error: { code: 400 } }])]), {}),
      cn(
        'an empty error is no error',
        w([stream([{ error: '' }, chunk([part('x')], 'STOP')])]),
        {},
      ),

      // ---- a JSON body instead of a stream ----
      cn(
        'an array of chunks as plain JSON',
        w([
          jsonBody([
            chunk([part('One ')], undefined, gUsage(3, 1)),
            chunk([part('two'), call('f', { a: 1 })], 'STOP', gUsage(3, 5)),
          ]),
        ]),
        {},
      ),
      cn(
        'one response object',
        w([jsonBody(chunk([part('single')], 'MAX_TOKENS', gUsage(1, 1)))]),
        {},
      ),
      cn('a response that is not a list or an object', w([jsonBody('5')]), {}),
      cn('a response with no content and no reason', w([jsonBody({ candidates: [] })]), {}),
      cn('a response blocked by safety', w([jsonBody([chunk([], 'SAFETY')])]), {}),
      cn(
        'a response with a blocked prompt',
        w([jsonBody({ promptFeedback: { blockReason: 'OTHER' } })]),
        {},
      ),
      cn(
        'a response that is an error',
        w([jsonBody({ error: { message: 'API key not valid' } })]),
        {},
      ),
      cn('a response that is an error of text', w([jsonBody([{ error: 'denied' }])]), {}),
      cn('a response that is not JSON', w([jsonBody('{{')]), {}),
      cn('a response that is null', w([jsonBody('null')]), {}),
      cn('a response with a null chunk', w([jsonBody([null])]), {}),
      cn(
        'a response that is the credits notice',
        w([
          jsonBody({
            candidates: [{ content: { parts: [{ text: 'Your credits have been exhausted.' }] } }],
          }),
        ]),
        {},
      ),
      cn(
        'a response over the tool budget',
        w([
          jsonBody(
            chunk(
              Array.from({ length: 101 }, (_, i) => call(`t${i}`, {})),
              'STOP',
            ),
          ),
        ]),
        {},
      ),
      cn(
        'a response with parts that are not a list',
        w([jsonBody({ candidates: [{ content: { parts: 5 } }] })]),
        {},
      ),
      cn(
        'a response without bytes of use',
        w([
          jsonBody({ candidates: [{ content: { parts: [{ text: '' }, { functionCall: {} }] } }] }),
        ]),
        { bare: true },
      ),

      // ---- HTTP errors ----
      cn(
        'a 400 with a JSON error',
        w([jsonBody({ error: { code: 400, message: 'bad' } }, 400)]),
        {},
      ),
      cn('a 422 with a long body', w([plain('q'.repeat(900), 422)]), {}),
      cn('a 404 with no body at all', w([plain(null, 404)]), {}),
      cn(
        'a block page',
        w([
          html(
            403,
            '<!doctype html><html><head><title>Access denied</title></head><body>Error code 1005</body></html>',
          ),
        ]),
        {},
      ),
      cn('a 503 is asked again', w([BUSY, GEMINI_OK]), {}),
      cn('a 200 with no body', w([plain(null, 200, SSE)]), {}),

      // ---- the request ----
      cn('every message role and a tool list', w([GEMINI_OK]), {
        messages: ALL_ROLES,
        tools: TOOLS,
        system: 'Be brief.',
      }),
      cn('the temperature is left out', w([GEMINI_OK]), { options: { omitTemperature: true } }),
      cn('the temperature stays when it is asked not to leave it out', w([GEMINI_OK]), {
        options: { omitTemperature: false },
        maxTokens: 64,
      }),
      cn('a base URL with a path and a query', w([GEMINI_OK]), {
        baseUrl: 'https://gw.example.com/g/v1beta/?api-version=3',
      }),
      cn('an opencode gateway with a session id', w([GEMINI_OK]), {
        baseUrl: 'https://opencode.ai/zen/v1',
        sessionId: 'sess-g',
      }),
      cn('an opencode gateway draws a session id', w([GEMINI_OK]), {
        baseUrl: 'https://opencode.ai/zen/v1',
      }),
      cn('a model with characters of a path', w([GEMINI_OK]), {
        config: { apiKey: 'k', model: 'tunedModels/my model#1' },
      }),
      cn('a config without a key or a model', w([GEMINI_OK]), { config: {} }),
      cn('a tool whose schema needs converting', w([GEMINI_OK]), {
        tools: [
          {
            name: 'rich',
            description: 'd',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                n: { type: ['number', 'null'] },
                list: { type: 'array' },
                pick: { enum: [1, 'b', null] },
                ref: { $ref: '#/definitions/thing', description: 'mine' },
              },
              definitions: { thing: { type: 'string', const: 'x' } },
            },
          },
        ],
      }),
      cn('a tool without a schema', w([GEMINI_OK]), {
        tools: [{ name: 'bare', description: 'x' }],
      }),
      cn('a schema that cannot be converted', w([GEMINI_OK]), {
        tools: [{ name: 'odd', inputSchema: { enum: [{ toString: 1 }] } }],
      }),
      cn('Korean text', w([GEMINI_OK]), {
        messages: [{ role: 'user', text: '요약' }],
        system: '한국어',
      }),
      cn('messages that are not a list', w([GEMINI_OK]), { messages: {} as unknown as unknown[] }),
      cn('a null message', w([GEMINI_OK]), { messages: [null] }),
      cn('a tool turn without results', w([GEMINI_OK]), { messages: [{ role: 'tool' }] }),
      cn('a tool turn with a null result', w([GEMINI_OK]), {
        messages: [{ role: 'tool', results: [null] }],
      }),
      cn('a tool result with nothing to say', w([GEMINI_OK]), {
        messages: [{ role: 'tool', results: [{}, { isError: true }] }],
      }),
      cn('images of the wrong type', w([GEMINI_OK]), {
        messages: [{ role: 'user', text: 'a', images: 'ab' }],
      }),
      cn('an image that is null', w([GEMINI_OK]), { messages: [{ role: 'user', images: [null] }] }),
      cn('tool calls of the wrong type', w([GEMINI_OK]), {
        messages: [{ role: 'assistant', toolCalls: 'ab' }],
      }),
      cn('tool calls that are a number', w([GEMINI_OK]), {
        messages: [{ role: 'assistant', toolCalls: 5 }],
      }),
      cn('a null tool call', w([GEMINI_OK]), {
        messages: [{ role: 'assistant', toolCalls: [null] }],
      }),
      cn('only the first call gets the bypass signature', w([GEMINI_OK]), {
        messages: [
          {
            role: 'assistant',
            toolCalls: [
              { name: 'a' },
              { name: 'b' },
              { name: 'c', signature: 'own' },
              { name: 'd', signature: '' },
            ],
          },
        ],
      }),
      cn('a first call with an empty signature gets none', w([GEMINI_OK]), {
        messages: [
          {
            role: 'assistant',
            toolCalls: [
              { name: 'a', signature: '' },
              { name: 'b', signature: null },
            ],
          },
        ],
      }),

      // ---- the connection ----
      cn(
        'a refused connection',
        w([{ reject: { class: 'TypeError', message: 'fetch failed' } }]),
        {},
      ),
      cn(
        'a refused connection with its cause',
        w([{ reject: { message: 'down', cause: { code: 'ETIMEDOUT' } } }]),
        {},
      ),
      cn('a refused redirect', w([redirect]), {}),
      cn('no fetch left in the script', w([]), {}),
      cn('a base URL that cannot be read', w([GEMINI_OK]), { baseUrl: 'nope' }),
      cn('a silent server', w([{ hang: true }]), {}),
      cn('the caller cancels', w([{ hang: true }], { abortAt: 1000 }), {}),
    ],
  },
  'gemini.chatGemini': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const s = (o ?? {}) as Opts
        const wd = watchdog.createStreamWatchdog(signal)
        return wd.guard(() =>
          gemini.chatGemini(
            wd,
            (s.config ?? CONFIG) as Any,
            s.system ?? 'You help.',
            s.user ?? 'Say hi',
            s.baseUrl,
            s.options,
          ),
        )
      }),
    cases: [
      cn(
        'the text of an answer',
        w([jsonBody({ candidates: [{ content: { parts: [{ text: 'Hello.' }] } }] })]),
        {},
      ),
      cn(
        'parts join, the first candidate only',
        w([
          jsonBody({
            candidates: [
              {
                content: {
                  parts: [{ text: 'a' }, {}, { text: 'b' }, { text: 4 }, { text: [1, 2] }],
                },
              },
              { content: { parts: [{ text: 'other' }] } },
            ],
          }),
        ]),
        {},
      ),
      cn(
        'candidates as an object with a key 0',
        w([jsonBody({ candidates: { 0: { content: { parts: [{ text: 'zero' }] } } } })]),
        {},
      ),
      cn(
        'no temperature, an opencode gateway',
        w([jsonBody({ candidates: [{ content: { parts: [{ text: 'k' }] } }] })]),
        {
          options: { omitTemperature: true },
          baseUrl: 'https://opencode.ai/zen/v1',
          system: '시스템',
          user: '질문',
        },
      ),
      cn(
        'the default base URL and a model with a path',
        w([jsonBody({ candidates: [{ content: { parts: [{ text: 'k' }] } }] })]),
        {
          config: { apiKey: 'k', model: 'tunedModels/x' },
        },
      ),
      cn('an answer that is not JSON', w([plain('<<nope>>', 200)]), {}),
      cn(
        'a shell page with a 200',
        w([html(200, '<html><head><title>Login</title></head></html>')]),
        {},
      ),
      cn('an empty body with a 200', w([plain('', 200)]), {}),
      cn('no candidates', w([jsonBody({})]), {}),
      cn('an empty candidate', w([jsonBody({ candidates: [{}] })]), {}),
      cn('an empty list of parts', w([jsonBody({ candidates: [{ content: { parts: [] } }] })]), {}),
      cn(
        'parts without text',
        w([jsonBody({ candidates: [{ content: { parts: [{ functionCall: { name: 'f' } }] } }] })]),
        {},
      ),
      cn('candidates of null', w([jsonBody({ candidates: null })]), {}),
      cn('candidates that are text', w([jsonBody({ candidates: 'abc' })]), {}),
      cn('a body that is null', w([jsonBody('null')]), {}),
      cn('a body that is a list', w([jsonBody('[1]')]), {}),
      cn('parts that are text', w([jsonBody({ candidates: [{ content: { parts: 'abc' } }] })]), {}),
      cn('parts that are a number', w([jsonBody({ candidates: [{ content: { parts: 5 } }] })]), {}),
      cn(
        'a part that is null',
        w([jsonBody({ candidates: [{ content: { parts: [null] } }] })]),
        {},
      ),
      cn('a 400', w([jsonBody({ error: { message: 'API key not valid' } }, 400)]), {}),
      cn('a 500 with a long body', w([plain('s'.repeat(800), 500)]), {}),
      cn(
        'a 503 is asked again',
        w([BUSY, jsonBody({ candidates: [{ content: { parts: [{ text: 'late' }] } }] })]),
        {},
      ),
      cn(
        'a block page',
        w([
          html(
            403,
            '<html><head><title>Blocked</title></head><body>Error code: 1020</body></html>',
          ),
        ]),
        {},
      ),
      cn('an answer over the cap', w([plain('x', 200, [['content-length', '9999999']])]), {}),
      cn(
        'a refused connection',
        w([{ reject: { class: 'TypeError', message: 'fetch failed' } }]),
        {},
      ),
      cn('a refused redirect', w([redirect]), {}),
      cn('a base URL that cannot be read', w([]), { baseUrl: '::' }),
      cn('a silent server', w([{ hang: true }]), {}),
      cn('the caller cancels', w([{ hang: true }], { abortAt: 500 }), {}),
    ],
  },
}

// ---------------------------------------------------------------------------
// protocols/gemini-schema.ts
// ---------------------------------------------------------------------------

const schema = (s: unknown): Case => ({ args: [s] })
const withNote = (note: string, c: Case): Case => ({ ...c, note })
const schemaGroup: Group = {
  'gemini-schema.toGeminiSchema': {
    ts: ([input]) => geminiSchema.toGeminiSchema(input as Record<string, unknown>),
    cases: [
      schema({
        type: 'object',
        properties: { q: { type: 'string', description: 'query' } },
        required: ['q'],
      }),
      schema({}),
      schema(null),
      schema(true),
      schema([1, 2]),
      schema('text'),
      withNote('keys the proto lacks are dropped, the rest keep their order', {
        args: [
          {
            $schema: 'http://json-schema.org/draft-07/schema#',
            title: 'T',
            type: 'object',
            additionalProperties: false,
            description: 'd',
            const: 'only',
            format: 'date',
            default: 3,
            example: [1],
            minimum: 0,
            maximum: 9,
            pattern: '^a',
            propertyOrdering: ['b', 'a'],
            minProperties: 1,
            maxProperties: 2,
            unevaluated: 1,
          },
        ],
      }),
      schema({ type: ['number', 'null'] }),
      schema({ type: ['null'] }),
      schema({ type: ['string', 'number'] }),
      schema({ type: ['string', 'number', 'null'], description: 'u' }),
      schema({ type: ['string', 'number'], anyOf: [{ type: 'boolean' }] }),
      schema({ type: ['string'], nullable: false }),
      schema({ type: [] }),
      schema({ type: [5, 'string', null, 'null'] }),
      schema({ type: 'string', nullable: true }),
      schema({ nullable: true, type: ['integer', 'null'], description: 'order' }),
      schema({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
      schema({ oneOf: [{ type: 'string' }], anyOf: [{ type: 'number' }] }),
      schema({ oneOf: 'x', anyOf: 'y' }),
      schema({
        anyOf: [{ type: ['string', 'null'] }, { $ref: '#/$defs/n' }],
        $defs: { n: { type: 'number' } },
      }),
      schema({ const: 5 }),
      schema({ const: null }),
      schema({ const: false, description: 'x' }),
      schema({ const: { a: 1 } }),
      schema({ const: 'a', enum: ['b'] }),
      schema({ enum: [1, 2.5, true, null, 'x', { a: 1 }, [1, 2], [], [null]] }),
      schema({ enum: 'abc' }),
      schema({ enum: [{ toString: 'x' }] }),
      schema({ enum: [[{ toString: 'x' }]] }),
      schema({
        type: 'object',
        properties: { a: { type: ['string', 'null'] }, b: { enum: [1] }, c: true, d: null, e: 'x' },
      }),
      schema({
        type: 'object',
        properties: { 2: { type: 'string' }, b: { type: 'number' }, 10: { type: 'null' }, a: {} },
      }),
      schema({ properties: [1, 2] }),
      schema({ properties: null }),
      schema({ properties: {} }),
      schema({ properties: { __proto__x: { type: 'string' } } }),
      schema(
        JSON.parse(
          '{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}',
        ),
      ),
      schema({ type: 'array' }),
      schema({ type: 'array', items: { type: 'string' } }),
      schema({ type: 'array', items: [{ type: 'string' }, { type: ['number', 'null'] }] }),
      schema({ type: 'array', items: [] }),
      schema({ type: 'array', items: null }),
      schema({ type: 'array', items: true }),
      schema({ items: { type: 'object' } }),
      schema({ type: ['array', 'null'] }),
      schema({ type: ['array'] }),
      schema({ properties: { list: { type: 'array', items: { type: 'array' } } } }),
      schema({
        type: 'object',
        properties: { id: { $ref: '#/definitions/id' } },
        definitions: { id: { type: 'string', description: 'plain' } },
      }),
      schema({
        $ref: '#/definitions/a',
        definitions: { a: { type: 'number', description: 'from target' } },
        description: 'sibling wins',
      }),
      schema({ $ref: '#/definitions/a', definitions: { a: { type: 'number' } }, minimum: 1 }),
      schema({
        properties: { x: { $ref: '#/$defs/a/properties/b' } },
        $defs: { a: { properties: { b: { type: 'integer' } } } },
      }),
      schema({
        properties: {
          x: { $ref: '#/definitions/tilde~0key' },
          y: { $ref: '#/definitions/slash~1key' },
        },
        definitions: { 'tilde~key': { type: 'string' }, 'slash/key': { type: 'boolean' } },
      }),
      schema({ properties: { x: { $ref: '#/definitions/missing' } } }),
      schema({
        properties: {
          x: { $ref: 'other.json#/a' },
          y: { $ref: '#' },
          z: { $ref: '#/' },
          w: { $ref: 5 },
        },
      }),
      schema({ properties: { x: { $ref: '#/definitions/x' } }, definitions: { x: 5 } }),
      schema({ properties: { x: { $ref: '#/definitions/x' } }, definitions: { x: [1] } }),
      schema({ properties: { x: { $ref: '#/definitions/x/y' } }, definitions: { x: 'text' } }),
      schema({ properties: { x: { $ref: '#/properties/y' }, y: { type: 'string' } } }),
      schema({
        properties: { x: { $ref: '#/definitions/a~01' } },
        definitions: { 'a~1': { type: 'string' }, 'a/': { type: 'boolean' } },
      }),
      withNote('a reference to itself is cut', {
        args: [
          {
            definitions: {
              a: { type: 'object', properties: { self: { $ref: '#/definitions/a' } } },
            },
            $ref: '#/definitions/a',
          },
        ],
      }),
      withNote('two definitions that refer to each other', {
        args: [
          {
            type: 'object',
            properties: { a: { $ref: '#/definitions/a' } },
            definitions: {
              a: { properties: { b: { $ref: '#/definitions/b' } } },
              b: { properties: { a: { $ref: '#/definitions/a' }, leaf: { type: 'string' } } },
            },
          },
        ],
      }),
      withNote('a reference to a name Object.prototype has', {
        args: [
          {
            properties: {
              a: { $ref: '#/__proto__', description: 'proto' },
              b: { $ref: '#/constructor' },
              c: { $ref: '#/toString/x' },
              d: { $ref: '#/__proto__/__proto__' },
              e: { $ref: '#/__proto__/constructor' },
              f: { $ref: '#/hasOwnProperty' },
            },
          },
        ],
      }),
      withNote('a reference to an own __proto__ key', {
        args: [
          JSON.parse(
            '{"properties":{"a":{"$ref":"#/__proto__"}},"__proto__":{"type":"string","description":"own"}}',
          ),
        ],
      }),
      withNote('a depth over the guard becomes an empty schema', {
        args: [
          (() => {
            let deep: Record<string, unknown> = { type: 'string' }
            for (let i = 0; i < 34; i++) deep = { type: 'object', properties: { n: deep } }
            return deep
          })(),
        ],
      }),
      withNote('a depth at the guard still converts', {
        args: [
          (() => {
            let deep: Record<string, unknown> = { type: 'string' }
            for (let i = 0; i < 32; i++) deep = { type: 'object', properties: { n: deep } }
            return deep
          })(),
        ],
      }),
      withNote('a long chain of references reaches the guard', {
        args: [
          {
            $ref: '#/definitions/a0',
            definitions: Object.fromEntries(
              Array.from({ length: 40 }, (_, i) => [
                `a${i}`,
                i === 39 ? { type: 'string' } : { $ref: `#/definitions/a${i + 1}` },
              ]),
            ),
          },
        ],
      }),
      schema({
        type: 'object',
        properties: { a: { anyOf: [{ type: 'string' }, { type: 'array' }, { const: 3 }, true] } },
      }),
      schema({ anyOf: 'text', oneOf: [{ type: 'string' }] }),
      schema({ anyOf: [] }),
    ],
  },
}

export const group: Group = { ...anthropicStream, ...geminiGroup, ...schemaGroup }
