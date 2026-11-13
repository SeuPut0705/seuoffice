/**
 * Group `b5-provider`, part `claude` (Rust: crates/main-core/src/calls/b5_provider/claude.rs):
 * packages/ai-provider/src/claude-code-cli.ts. Names are
 * `claude-code-cli.<export>`.
 *
 * The pure functions take their inputs directly. The functions that start the
 * CLI run in the scripted world of world.ts (the first argument); the CLI is
 * a scripted child: its `replies[0]` answers the first stdin line (the setup
 * request), `replies[1]` the second (the user message). `o` is the call's
 * options: `config` (the AiProviderConfig), `system`, `tools`, `messages`,
 * `maxTokens`, `user` (chat), `cliPath`/`timeoutMs` (the model list),
 * `graceMs`, `resolveError` (the program finder throws it), `preAborted`,
 * `baseEnv`. The program finder is a stand-in that logs `['resolve',
 * cliPath]` and answers `/opt/claude/bin/claude`.
 *
 * A call's answer is `{ ok: true }` or `{ threw }` where `threw` describes the
 * error (`name`, `message`, `kind`, `provider`, `resetsAt`, `code`, whether it
 * has a `cause`). The callbacks log `delta`, `tool`, `reasoning`, `stop`,
 * `usage`, `subusage`, `truncated` and `activity`. The temporary folder the
 * run makes has a random name: the log shows it as `seuoffice-claude-code-XXXXXX`.
 */
import childProcess from 'node:child_process'
import '../../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'
import { inWorld, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const mod = await import('../../../../packages/ai-provider/src/claude-code-cli.ts')
const watchdog = await import('../../../../packages/ai-provider/src/watchdog.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const PROGRAM = {
  provider: 'claude-code',
  command: '/opt/claude/bin/claude',
  prefixArgs: [] as string[],
  env: {} as Record<string, string>,
  entry: '/opt/claude/bin/claude',
  source: 'path',
}

const TMP_NAME = /seuoffice-claude-code-[A-Za-z0-9]{6}/g
const scrub = (v: unknown): unknown =>
  typeof v === 'string'
    ? v.replace(TMP_NAME, 'seuoffice-claude-code-XXXXXX')
    : Array.isArray(v)
      ? v.map(scrub)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
        : v
const scrubbed = (cx: TsContext): TsContext => ({
  ...cx,
  log: (...args: unknown[]) => cx.log(...args.map(scrub)),
})

function describe(e: unknown): Record<string, unknown> {
  const x = e as Record<string, unknown>
  const out: Record<string, unknown> = { name: x.name, message: x.message }
  for (const key of ['kind', 'provider', 'resetsAt', 'code']) {
    if (x[key] !== undefined) out[key] = x[key]
  }
  out.cause = x.cause !== undefined
  return out
}

interface Opts {
  config?: Record<string, unknown>
  system?: string
  tools?: unknown[]
  messages?: unknown[]
  maxTokens?: number
  user?: string
  cliPath?: string
  timeoutMs?: number
  graceMs?: number
  resolveError?: string
  preAborted?: boolean
  baseEnv?: Record<string, string>
}

function depsOf(o: Opts, cx: TsContext): Any {
  return {
    resolveProgram: async (cliPath: string | undefined) => {
      cx.log('resolve', cliPath ?? null)
      if (o.resolveError) throw new Error(o.resolveError)
      return PROGRAM
    },
    baseEnv: o.baseEnv ?? { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'secret' },
    exitGraceMs: o.graceMs,
  }
}

function callbacksOf(cx: TsContext, signal: AbortSignal): Any {
  return {
    signal,
    onDelta: (t: string) => cx.log('delta', t),
    onToolCall: (call: unknown) => cx.log('tool', call),
    onReasoningDelta: (t: string) => cx.log('reasoning', t),
    onStopReason: (r: string) => cx.log('stop', r),
    onUsage: (u: unknown) => cx.log('usage', u),
    onSubscriptionUsage: (u: unknown) => cx.log('subusage', u),
    onInputTruncated: () => cx.log('truncated'),
    onActivity: () => cx.log('activity'),
  }
}

const TOOLS = [
  {
    name: 'insert_content',
    description: 'Insert content',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'array' },
        mode: { type: 'string' },
        meta: { type: 'object' },
        either: { type: ['string', 'array'] },
        count: { type: 'number' },
      },
    },
  },
  { name: 'read_document', description: 'Read the document', inputSchema: { type: 'object' } },
]
const MESSAGES = [{ role: 'user', text: 'Write a haiku' }]

/** the case of a call that runs in a world: the world's folder is the temporary directory */
const run = (world: World | null, o: Opts, note?: string): Case => ({
  args: [
    { env: { TMPDIR: '$DIR', PATH: '/usr/bin' }, ...(world ?? {}) },
    {
      config: { model: 'sonnet' },
      system: 'You are an editor',
      tools: TOOLS,
      messages: MESSAGES,
      maxTokens: 4096,
      user: 'Say hi',
      ...o,
    },
  ],
  ...(note ? { note } : {}),
})
const c = (...args: unknown[]): Case => ({ args })

// ---------------------------------------------------------------------------
// scripted CLI output
// ---------------------------------------------------------------------------

const lines = (...events: unknown[]): string =>
  events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const initOk = {
  type: 'control_response',
  response: { subtype: 'success', request_id: 'initialize', response: {} },
}
const sysInit = (tools: unknown = ['StructuredOutput'], more: object = {}) => ({
  type: 'system',
  subtype: 'init',
  tools,
  mcp_servers: [],
  ...more,
})
const ev = (event: unknown) => ({ type: 'stream_event', event })
const msgStart = ev({ type: 'message_start' })
const blockStart = (index: number, block: unknown) =>
  ev({ type: 'content_block_start', index, content_block: block })
const inputDelta = (index: number, json: string) =>
  ev({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  })
const textDelta = (text: string) =>
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const thinkDelta = (thinking: string) =>
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })
const SO_BLOCK = { type: 'tool_use', id: 'toolu_so', name: 'StructuredOutput', input: {} }
const assistant = (content: unknown[], more: object = {}, top: object = {}) => ({
  type: 'assistant',
  ...top,
  message: { role: 'assistant', content, ...more },
})
const resultOf = (id: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }],
  },
})
const soResult = resultOf('toolu_so')
const done = (more: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  ...more,
})
const USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 100,
  output_tokens: 20,
}
const limitInfo = {
  status: 'rejected',
  rateLimitType: 'five_hour',
  utilization: 1,
  resetsAt: 1700003600,
  unifiedWindows: {
    five_hour: { utilization: 1.2, resetsAt: 1700003600 },
    seven_day: { utilization: 0.3, resetsAt: 1700600000 },
  },
}
const rateLimit = (info: object = limitInfo) => ({
  type: 'rate_limit_event',
  rate_limit_info: info,
})

/** a child that accepts the setup, then answers the user message with `turn` */
const cli = (
  turn: string | string[],
  more: object = {},
  first: unknown[] = [initOk, sysInit()],
) => ({
  replies: [{ stdout: [lines(...first)] }, { stdout: Array.isArray(turn) ? turn : [turn] }],
  ...more,
})
/** a child of a plain turn (chat): no tool at all */
const plain = (turn: string | string[], more: object = {}) => cli(turn, more, [initOk, sysInit([])])
/** a child that accepts the setup, then leaves after the user message with `stderr` */
const leaves = (stderr: string[], exit: object, first: unknown[] = [initOk, sysInit()]) => ({
  replies: [{ stdout: [lines(...first)] }, { stderr }],
  closeOn: 2,
  exit,
})
const answer = (text: string, toolCalls: unknown[] = []) => ({ text, toolCalls })
const wc = (...children: object[]): World => ({ children }) as World
const big = (n: number): string => 'a'.repeat(n)

// ---------------------------------------------------------------------------
// the pure part
// ---------------------------------------------------------------------------

const toolsOf = (names: string[]) =>
  names.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object' } }))

const images = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ mime: 'image/png', base64: `B${i}` }))

const pure: Group = {
  'claude-code-cli.MAX_CLAUDE_CODE_IMAGES': {
    ts: () => mod.MAX_CLAUDE_CODE_IMAGES,
    cases: [c()],
    single: 'a constant',
  },
  'claude-code-cli.MODEL_NAME': {
    ts: ([v]) => mod.MODEL_NAME.test(v as string),
    cases: [
      c('sonnet'),
      c('claude-opus-4-1'),
      c('opus[1m]'),
      c('default'),
      c(''),
      c('-bad'),
      c('--model'),
      c('a'.repeat(128)),
      c('a'.repeat(129)),
      c('with space'),
      c('x:y.z_1'),
      c('Ünï'),
      c('a\n'),
    ],
  },
  'claude-code-cli.claudeCodeCliLaunchArgs': {
    ts: ([model, schema, effort]) =>
      mod.claudeCodeCliLaunchArgs(
        model as string,
        (schema ?? undefined) as Any,
        (effort ?? undefined) as Any,
      ),
    cases: [
      c('sonnet'),
      c('  sonnet  '),
      c(''),
      c('   '),
      c('--evil'),
      c(`${'x'.repeat(100)} bad`),
      c('sonnet', { type: 'object', properties: { a: { type: 'string' } } }),
      c('opus', null, 'high'),
      c('', null, 'max'),
      c('opus', null, 'none'),
      c('opus', null, 'bogus'),
      c('opus', null, ' xhigh '),
      c('opus', null, 'low'),
      c('opus', null, 5),
      c('opus', {}, 'medium'),
    ],
  },
  'claude-code-cli.claudeCodeEffort': {
    ts: ([v]) => mod.claudeCodeEffort(v),
    cases: [
      c('high'),
      c(' low '),
      c('none'),
      c('minimal'),
      c('max'),
      c('xhigh'),
      c('medium'),
      c('HIGH'),
      c(5),
      c(null),
      c(''),
      c({ a: 1 }),
    ],
  },
  'claude-code-cli.claudeCodeOutputSchema': {
    ts: ([names]) => mod.claudeCodeOutputSchema(toolsOf(names as string[]) as Any),
    cases: [
      c([]),
      c(['a']),
      c(['insert_content', 'replace_blocks']),
      c(['a-b_C9']),
      c(['bad name']),
      c(['x'.repeat(64)]),
      c(['x'.repeat(65)]),
      c(['']),
      c(['ok', 'not ok']),
      c(['dup', 'dup']),
    ],
  },
  'claude-code-cli.buildClaudeCodeInput': {
    ts: ([system, messages, tools, maxTokens]) =>
      mod.buildClaudeCodeInput(
        system as string,
        messages as Any,
        tools as Any,
        maxTokens as number,
      ),
    cases: [
      c('You are an editor', MESSAGES, TOOLS, 4096),
      c('', MESSAGES, [], 100),
      c('  ', [{ role: 'user', text: 'x' }], toolsOf(['a']), 1e21),
      c(
        'sys',
        [
          { role: 'user', text: 'insert a paragraph' },
          {
            role: 'assistant',
            text: 'ok',
            toolCalls: [{ id: 't1', name: 'insert_content', input: { blocks: ['p'] }, extra: 1 }],
          },
          { role: 'tool', results: [{ id: 't1', output: 'inserted', isError: false }] },
          { role: 'assistant', text: 'done', toolCalls: [] },
          { role: 'assistant' },
        ],
        TOOLS,
        2048,
      ),
      c('sys', [{ role: 'user', text: 'look', images: images(2) }, { role: 'user' }], TOOLS, 10),
      c('sys', [{ role: 'user', text: 'look', images: images(100) }], [], 10),
      c(
        'sys',
        [
          { role: 'user', text: 'old', images: images(60) },
          { role: 'user', text: 'new', images: images(41) },
        ],
        [],
        10,
      ),
      c('sys', MESSAGES, toolsOf(['bad name']), 10),
      c('sys', [], [], 0),
    ],
  },
  'claude-code-cli.ClaudeCodeStructureError': {
    ts: () => {
      const e = new mod.ClaudeCodeStructureError('x')
      return { name: e.name, message: e.message, isError: e instanceof Error }
    },
    cases: [c()],
    single: 'a constant',
  },
  'claude-code-cli.claudeCodeUsage': {
    ts: ([info]) => mod.claudeCodeUsage(info),
    cases: [
      c({
        unifiedWindows: {
          five_hour: { utilization: 0.25, resetsAt: 1700003600 },
          seven_day: { utilization: 1.7, resetsAt: 1700600000 },
        },
      }),
      c({ unifiedWindows: { five_hour: { utilization: 0.5 }, seven_day: { resetsAt: 5 } } }),
      c({ unifiedWindows: { five_hour: { utilization: -1, resetsAt: 5 } } }),
      c({ unifiedWindows: { five_hour: { utilization: '0.5', resetsAt: 5 } } }),
      c({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 0 } } }),
      c({ unifiedWindows: { five_hour: 'x', other: { utilization: 1, resetsAt: 5 } } }),
      c({ unifiedWindows: {} }),
      c({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1700000000.0005 } } }),
      c({ rateLimitType: 'five_hour', utilization: 0.4, resetsAt: 1700003600 }),
      c({ rateLimitType: 'seven_day', utilization: 2, resetsAt: 1700003600 }),
      c({ rateLimitType: 'monthly', utilization: 0.4, resetsAt: 1700003600 }),
      c({ rateLimitType: 'five_hour', utilization: 0.4 }),
      c({ unifiedWindows: [], rateLimitType: 'five_hour', utilization: 0.4, resetsAt: 9 }),
      c(null),
      c('x'),
      c([]),
    ],
  },
  'claude-code-cli.reportedFailure': {
    ts: ([code, status, text, info]) =>
      describe(
        mod.reportedFailure(
          (code ?? undefined) as Any,
          status,
          text as string,
          (info ?? undefined) as Any,
        ),
      ),
    cases: [
      c('authentication_failed', null, 'Invalid token'),
      c(null, 401, ''),
      c('rate_limit', null, 'You hit the limit', { status: 'rejected', resetsAt: 1700003600 }),
      c(null, 429, 'slow down', { status: 'allowed', resetsAt: 1700003600 }),
      c('rate_limit', null, 'x', { status: 'rejected', resetsAt: 0 }),
      c('rate_limit', null, 'x', { status: 'rejected', resetsAt: 'soon' }),
      c('rate_limit', null, 'x'),
      c('rate_limit', null, 'x', { status: 'rejected', resetsAt: 1700003600.0005 }),
      c('overloaded', null, 'busy'),
      c(null, 529, 'busy'),
      c(null, 503, 'unavailable'),
      c(null, 500, 'fetch failed'),
      c(null, null, 'Connection error.'),
      c(null, null, 'Unable to connect to API'),
      c(null, null, 'Request timed out'),
      c(null, null, 'timeout while reading'),
      c('unknown', null, 'Not logged in · Please run /login'),
      c(null, null, 'Invalid API key'),
      c('model_not_found', null, 'authentication failed for model'),
      c('', null, 'authentication required'),
      c(null, null, '   '),
      c(null, null, 'something else'),
      c(null, 400, '  padded  '),
    ],
  },
  'claude-code-cli.exitFailure': {
    ts: ([code, stderr]) => describe(mod.exitFailure(code as number | null, stderr as string)),
    cases: [
      c(1, 'error: unknown option --restricted'),
      c(1, 'Unrecognized option "--x"'),
      c(2, 'unknown argument'),
      c(1, 'Not logged in'),
      c(1, 'Please run /login to authenticate'),
      c(1, 'authentication failed for alice@example.com'),
      c(3, ''),
      c(3, '   boom  '),
      c(null, ''),
      c(null, 'trace'),
      c(0, 'invalid api key'),
    ],
  },
  'claude-code-cli.startFailure': {
    ts: ([spec]) => {
      const s = spec as { message?: string; code?: string; raw?: unknown }
      const error =
        'raw' in s ? s.raw : Object.assign(new Error(s.message), s.code ? { code: s.code } : {})
      return describe(mod.startFailure(error))
    },
    cases: [
      c({ message: 'spawn claude ENOENT', code: 'ENOENT' }),
      c({ message: 'spawn claude EACCES', code: 'EACCES' }),
      c({ message: 'boom' }),
      c({ raw: 'a string' }),
      c({ raw: 5 }),
      c({ raw: null }),
      c({ raw: { code: 'ENOENT' } }),
    ],
  },
  'claude-code-cli.directCallInput': {
    ts: ([tool, input]) => mod.directCallInput((tool ?? undefined) as Any, input),
    cases: [
      c(TOOLS[0], { blocks: ['a'], mode: 'append' }),
      c(TOOLS[0], { inputJson: '{"blocks":["a"]}' }),
      c(TOOLS[0], { inputJson: 5 }),
      c(TOOLS[0], { inputJson: '{}', other: 1 }),
      c(TOOLS[0], { blocks: '["a","b"]', mode: 'append', meta: '{"k":1}' }),
      c(TOOLS[0], { blocks: 'not json', meta: '[1]', mode: '{"a":1}' }),
      c(TOOLS[0], { either: '["x"]', count: '5' }),
      c(TOOLS[0], { blocks: '{"a":1}', meta: '[1,2]' }),
      c(null, { a: 1 }),
      c({ name: 'x' }, { a: '[1]' }),
      c({ name: 'x', inputSchema: { properties: 5 } }, { a: '[1]' }),
      c({ name: 'x', inputSchema: { properties: { a: 'oops', b: {} } } }, { a: '[1]', b: '[1]' }),
      c(TOOLS[0], null),
      c(TOOLS[0], [1]),
      c(TOOLS[0], 'x'),
      c(TOOLS[0], {}),
      c(TOOLS[0], { mode: '[1,2]', blocks: '[3]' }),
    ],
  },
  'claude-code-cli.claudeCodeModels': {
    ts: ([v]) => mod.claudeCodeModels(v),
    cases: [
      c({
        models: [
          {
            value: 'default',
            displayName: 'Default (recommended)',
            resolvedModel: 'claude-sonnet-4-5',
            supportedEffortLevels: ['low', 'medium', 'high'],
          },
          {
            value: 'opus',
            displayName: ' Opus ',
            supportedEffortLevels: ['low', 'xhigh', 'max', 'bogus', 'none'],
          },
          { value: 'bad name', displayName: 'x' },
          { value: '--x' },
          { value: 'sonnet', supportsEffort: false, supportedEffortLevels: ['high'] },
          { value: 'opus', displayName: 'Dup' },
          { value: 'haiku', resolvedModel: 'bad resolved', supportedEffortLevels: ['none'] },
          { value: ' sonnet[1m] ', resolvedModel: ' claude-sonnet-4-5[1m] ' },
          5,
          null,
          { value: 7 },
        ],
        account: { email: 'someone@example.com' },
      }),
      c({ models: [{ value: 'default' }, { value: 'default', resolvedModel: 'x' }] }),
      c({
        models: [
          { value: 'default', resolvedModel: 'm' },
          { value: 'default', resolvedModel: 'n' },
        ],
      }),
      c({ models: 'x' }),
      c({}),
      c(null),
      c([]),
      c({ models: [] }),
    ],
  },
}

// ---------------------------------------------------------------------------
// parseClaudeCodeTurn and TurnTextScanner
// ---------------------------------------------------------------------------

const calls = (n: number, text: string) =>
  JSON.stringify({
    text,
    toolCalls: Array.from({ length: n }, () => ({ name: 'a', inputJson: '{}' })),
  })

const parse: Group = {
  'claude-code-cli.parseClaudeCodeTurn': {
    ts: ([world, raw, names, prefix], cx) =>
      inWorld(world as World, cx, async () => {
        try {
          return {
            turn: mod.parseClaudeCodeTurn(
              raw as string,
              toolsOf(names as string[]) as Any,
              (prefix ?? undefined) as Any,
            ),
          }
        } catch (e) {
          return { threw: describe(e), structure: e instanceof mod.ClaudeCodeStructureError }
        }
      }),
    cases: [
      c(null, '{"text":"hello","toolCalls":[]}', ['a']),
      c(null, '{"text":"hello"}', ['a']),
      c(null, '{"text":"hello","toolCalls":null}', ['a']),
      c(null, '  ```json\n{"text":"fenced","toolCalls":[]}\n```  ', ['a']),
      c(null, '```{"text":"bare fence"}```', ['a']),
      c(
        null,
        'Here you go: {"text":"inside","toolCalls":[{"name":"a","inputJson":"{\\"x\\":1}"}]} thanks',
        ['a'],
      ),
      c(null, 'done', ['a']),
      c(null, '  all finished  ', ['a']),
      c(null, '', ['a']),
      c(null, '   ', ['a']),
      c(null, '{"text":', ['a']),
      c(null, 'x } y { z', ['a']),
      c(null, 'no braces but } stray', ['a']),
      c(null, '{broken json}', ['a']),
      c(null, '[1,2]', ['a']),
      c(null, '"a string"', ['a']),
      c(null, 'null', ['a']),
      c(null, '{"text":5}', ['a']),
      c(null, '{"toolCalls":[]}', ['a']),
      c(null, '{"text":"x","toolCalls":"nope"}', ['a']),
      c(null, '{"text":"x","toolCalls":{"name":"a"}}', ['a']),
      c(
        null,
        '{"text":"two","toolCalls":[{"name":"a","inputJson":"{\\"k\\":\\"v\\"}"},{"name":"b","inputJson":"{}"}]}',
        ['a', 'b'],
      ),
      c(null, '{"text":"obj","toolCalls":[{"name":"a","input":{"k":[1,2]}}]}', ['a']),
      c(null, '{"text":"nul","toolCalls":[{"name":"a","input":null}]}', ['a']),
      c(null, '{"text":"nul","toolCalls":[{"name":"a","inputJson":null,"input":{"z":1}}]}', ['a']),
      c(null, '{"text":"none","toolCalls":[{"name":"a"}]}', ['a']),
      c(null, '{"text":"num","toolCalls":[{"name":"a","inputJson":5}]}', ['a']),
      c(null, '{"text":"bad","toolCalls":[{"name":"a","inputJson":"{not json"}]}', ['a']),
      c(null, '{"text":"arr","toolCalls":[{"name":"a","inputJson":"[1]"}]}', ['a']),
      c(
        null,
        '{"text":"quote","toolCalls":[{"name":"a","inputJson":"{\\"s\\":\\"say \\"hi\\" now\\"}"}]}',
        ['a'],
      ),
      c(null, '{"text":"u","toolCalls":[{"name":"zzz","inputJson":"{}"}]}', ['a', 'b']),
      c(null, '{"text":"u","toolCalls":[{"name":"zzz"}]}', []),
      c(null, `{"text":"u","toolCalls":[{"name":"${'n'.repeat(300)}"}]}`, ['a', 'a']),
      c(null, '{"text":"u","toolCalls":[{"inputJson":"{}"}]}', ['a']),
      c(null, '{"text":"u","toolCalls":[{"name":"","inputJson":"{}"}]}', ['a']),
      c(null, '{"text":"u","toolCalls":[{"name":5}]}', ['a']),
      c(null, '{"text":"u","toolCalls":["a"]}', ['a']),
      c(null, '{"text":"u","toolCalls":[null]}', ['a']),
      c(
        null,
        '{"text":"mix","toolCalls":[{"name":"zzz"},{"name":"a","inputJson":"{}"},{"name":"a"}]}',
        ['a'],
      ),
      c(null, '{"text":"p","toolCalls":[{"name":"a","inputJson":"{}"}]}', ['a'], 'seuoffice'),
      c(null, calls(100, 'many'), ['a']),
      c(null, calls(101, 'too many'), ['a']),
      c(
        null,
        JSON.stringify({
          text: 'huge',
          toolCalls: [{ name: 'a', inputJson: 'x'.repeat(512_001) }],
        }),
        ['a'],
      ),
      c(
        null,
        JSON.stringify({
          text: 'big ok',
          toolCalls: [{ name: 'a', inputJson: '{"a":"' + 'x'.repeat(1000) + '"}' }],
        }),
        ['a'],
      ),
    ],
  },
  'claude-code-cli.TurnTextScanner': {
    ts: ([chunks]) => {
      const scanner = new mod.TurnTextScanner()
      return (chunks as string[]).map((chunk) => {
        const out = scanner.push(chunk)
        return [out, scanner.started, scanner.complete]
      })
    },
    cases: [
      c(['{"text":"hello world","toolCalls":[]}']),
      c(['{"te', 'xt":"he', 'llo"', ',"toolCalls":[]}']),
      c(['{"text":"a\\nb\\tc\\\\d\\"e\\/f"}']),
      c(['{"text":"a\\', 'nb"}']),
      c(['{"text":"\\u00', 'e9 caf\\u00e9"}']),
      c(['{"text":"\\ud83d\\ude00 ok"}']),
      c(['{"text":"\\ud83d', '\\ude00 ok"}']),
      c(['{"text":"\\ud83d\\', 'ude00 ok"}']),
      c(['{"text":"\\ud83d\\u', 'de00 ok"}']),
      c(['{"text":"\\ud83d\\ude', '00 ok"}']),
      c(['{"text":"\\ud83', 'd\\ude00"}']),
      c(['{"text":"\\u', '0041"}']),
      c(['{"text":"\\q \\b\\f\\r end"}']),
      c(['{"text":"bad \\uZZZZ end"}']),
      c(['{"text":"half \\u12', 'zz"}']),
      c(['{"text":"😀 raw astral 안녕"}']),
      c(['{"text":"😀', ' next"}']),
      c(['  \n```json\n{ "text" : "fenced"}']),
      c(['```\n  {', '"text"', ':"x"}']),
      c(['{"text":"', 'x']),
      c(['{"text":""}']),
      c(['{"text":"x"}', 'ignored after complete "]']),
      c(['{"toolCalls":[]}', ' more']),
      c(['{"toolCalls":[], "padding":"' + 'p'.repeat(300) + '"}', '{"text":"late"}']),
      c(['{"text":"' + 'long '.repeat(100) + '"}']),
      c(['   ', '  ', '  {"text"', ':"x"}']),
      c(['hello']),
      c(['']),
      c([]),
      c(['{"text":"a', '', 'b"}']),
      c(['{"TEXT":"x"}']),
      c(['{"text":"\\u00e9\\u00', '"}']),
      c([' '.repeat(256), '{"text":"x"}']),
      c([' '.repeat(257), '{"text":"x"}']),
    ],
  },
}

// ---------------------------------------------------------------------------
// readLines
// ---------------------------------------------------------------------------

const lineReader: Group = {
  'claude-code-cli.readLines': {
    ts: ([world], cx) =>
      inWorld(world as World, cx, async () => {
        const child = childProcess.spawn('reader', [], {}) as Any
        child.stdin.end()
        const seen: string[] = []
        let overflow = 0
        const shown = (line: string) => (line.length > 100 ? `<${line.length}>` : line)
        mod.readLines(
          child.stdout,
          (line) => {
            seen.push(shown(line))
            cx.log('line', shown(line))
          },
          () => {
            overflow += 1
            cx.log('overflow')
          },
        )
        // the target library predates Promise.withResolvers
        await new Promise<void>((resolve) => child.once('close', () => resolve()))
        return { lines: seen, overflow }
      }),
    cases: [
      { args: [wc({ stdout: ['one\ntwo\n'] })] },
      { args: [wc({ stdout: ['on', 'e\ntw', 'o\nthr', 'ee'] })] },
      { args: [wc({ stdout: ['\n\n  \n\t\nx\n   \n'] })] },
      { args: [wc({ stdout: ['a\r\nb\r\n'] })] },
      { args: [wc({ stdout: ['last without newline'] })] },
      { args: [wc({ stdout: ['   '] })] },
      {
        args: [
          wc({ stdout: [{ hex: '61c3' }, { hex: 'a9' }, '\n', { hex: 'e2' }, { hex: '82ac0a' }] }),
        ],
      },
      { args: [wc({ stdout: [{ hex: '61c3' }] })] },
      { args: [wc({ stdout: [{ hex: 'ff0a6f6b0a' }] })] },
      { args: [wc({ stdout: [] })] },
      { args: [wc({ stdout: [{ hex: 'efbbbf6869' }, '\n', { hex: 'efbbbf0a' }, 'ok\n'] })] },
      { args: [wc({ stdout: [{ hex: 'efbb' }, { hex: 'bf6869' }] })] },
      { args: [wc({ stdout: ['x\n' + big(4 * 1024 * 1024 + 1)] })], note: 'a line past the cap' },
      {
        args: [
          wc({
            stdout: [
              big(1_200_000),
              big(1_200_000),
              big(1_200_000),
              big(1_200_000),
              'tail\nnext\n',
            ],
          }),
        ],
        note: 'the cap counts the bytes of a line across chunks',
      },
      {
        args: [
          wc({
            stdout: [big(1_000_000), big(1_000_000), 'x\n', big(1_000_000), big(1_000_000), 'y\n'],
          }),
        ],
        note: 'a newline resets the count',
      },
      { args: [wc({ stdout: [big(4 * 1024 * 1024)] })], note: 'exactly the cap' },
      {
        args: [wc({ stdout: [big(4 * 1024 * 1024 + 1), 'ignored\n'] })],
        note: 'after the overflow',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// the turn
// ---------------------------------------------------------------------------

const withCalls = answer('I will insert it.', [
  { name: 'insert_content', inputJson: '{"blocks":["a"]}' },
])
const streamed = (json: string[], extra: unknown[] = [], resultMore: object = {}): string[] => [
  lines(msgStart, blockStart(0, SO_BLOCK)),
  lines(...json.map((j) => inputDelta(0, j)), ...extra, done(resultMore)),
]

const stream: FnSpec = {
  ts: ([world, o], cx) => {
    const opts = (o ?? {}) as Opts
    const lcx = scrubbed(cx)
    return inWorld(world as World, lcx, async (r, signal) => {
      if (opts.preAborted) r.abort.abort()
      try {
        await mod.streamClaudeCodeCli(
          opts.config as Any,
          opts.system as string,
          opts.messages as Any,
          opts.tools as Any,
          opts.maxTokens as number,
          callbacksOf(lcx, signal),
          depsOf(opts, lcx),
        )
        return { ok: true }
      } catch (e) {
        return { threw: describe(e) }
      }
    })
  },
  cases: [],
}
const T = stream.cases

// the answers that arrive
T.push(
  run(
    wc(
      cli([
        lines(
          msgStart,
          rateLimit({ status: 'allowed', unifiedWindows: limitInfo.unifiedWindows }),
          thinkDelta('let me think'),
          thinkDelta(''),
          blockStart(0, SO_BLOCK),
        ),
        lines(
          inputDelta(0, '{"te'),
          inputDelta(0, 'xt":"I will ins'),
          inputDelta(
            0,
            'ert it.","toolCalls":[{"name":"insert_content","inputJson":"{\\"blocks\\":[\\"a\\"]}"}]}',
          ),
          assistant([SO_BLOCK], { usage: USAGE }),
          soResult,
          done({ structured_output: withCalls, stop_reason: 'tool_use', usage: USAGE }),
        ),
      ]),
    ),
    {},
    'text streamed as it is written, a tool call, usage, the limit report',
  ),
  run(
    wc(
      cli(
        lines(
          assistant([{ ...SO_BLOCK, input: answer('All done') }]),
          soResult,
          done({ stop_reason: 'end_turn', usage: { output_tokens: 3 } }),
        ),
      ),
    ),
    {},
    'only whole messages, no stream events',
  ),
  run(
    wc(
      cli(
        lines(
          done({
            structured_output: answer('x', [
              { name: 'nope', inputJson: '{}' },
              { name: 'insert_content', inputJson: '{bad' },
            ]),
            stop_reason: 'tool_use',
            usage: { input_tokens: '7', output_tokens: -1 },
          }),
        ),
      ),
    ),
    {},
    'the result carries the answer: an unknown tool, bad input',
  ),
  run(
    wc(
      cli(
        streamed(['{"text":"안녕 \\ud83d\\u', 'de00 \\u00e9\\n","toolCalls":[]}'], [soResult], {
          structured_output: answer('안녕 😀 é\n'),
          stop_reason: 'end_turn',
        }),
      ),
    ),
    {},
    'escapes split in the stream',
  ),
  run(
    wc(
      cli([
        lines(msgStart, blockStart(0, SO_BLOCK), inputDelta(0, '{"text":"Hel')),
        lines(
          msgStart,
          blockStart(0, SO_BLOCK),
          inputDelta(0, '{"text":"Hello world","toolCalls":[]}'),
          done({ structured_output: answer('Hello world'), stop_reason: 'end_turn' }),
        ),
      ]),
    ),
    {},
    'the CLI sends the answer again: what was passed on is skipped',
  ),
  run(
    wc(cli(streamed(['just some prose'], [], { stop_reason: 'end_turn' }))),
    {},
    'an answer that is prose',
  ),
  run(
    wc(
      cli(
        streamed(['{"text":"abc","toolCalls":[]}'], [], { stop_reason: 'end_turn', usage: USAGE }),
      ),
    ),
    {},
    'the streamed answer without the CLI answer',
  ),
  run(
    wc(
      cli([
        lines(blockStart(0, SO_BLOCK), textDelta('prose beside the call, never the answer')),
        lines(
          inputDelta(0, '{"text":"real","toolCalls":[]}'),
          done({ structured_output: answer('real') }),
        ),
      ]),
    ),
    {},
    'text beside the StructuredOutput call is ignored; no stop reason',
  ),
  run(
    wc(
      cli(
        'not json\n' +
          lines(
            { type: 'mystery' },
            { no: 'type' },
            [1, 2],
            'a string',
            done({ structured_output: answer('after noise') }),
          ),
      ),
    ),
    {},
    'lines that are not events are passed over',
  ),
)

// answers that are not usable
T.push(
  run(wc(cli(streamed(['{"text":5}']))), {}, 'invalid, nothing delivered'),
  run(wc(cli(streamed(['{"toolCalls":[]}']))), {}, 'no text, nothing delivered'),
  run(
    wc(cli(streamed(['{"text":"par'], [], { stop_reason: 'end_turn' }))),
    {},
    'broke off after text was delivered',
  ),
  run(
    wc(cli(streamed(['{"text":"partial prose'], [], { stop_reason: 'max_tokens' }))),
    {},
    'cut by the output limit inside the text',
  ),
  run(
    wc(
      cli(
        streamed(['{"text":"hi","toolCalls":[{"name":"insert_content","inputJson":"{\\"bl'], [], {
          stop_reason: 'max_tokens',
        }),
      ),
    ),
    {},
    'cut by the output limit inside a tool call: the call goes on as truncated',
  ),
  run(
    wc(
      cli(
        streamed(['{"text":"hi","toolCalls":[{"name":"nope","inputJson":"{\\"bl'], [], {
          stop_reason: 'max_tokens',
        }),
      ),
    ),
    {},
    'cut inside a call to an unknown tool',
  ),
  run(
    wc(cli(streamed(['{"text":"hi","toolCalls":[{"x"'], [], { stop_reason: 'max_tokens' }))),
    {},
    'cut where no tool name was written',
  ),
  run(
    wc(
      cli(streamed(['{"toolCalls":[{"name":"insert_content"'], [], { stop_reason: 'max_tokens' })),
    ),
    {},
    'cut before any text',
  ),
  run(
    wc(
      cli(
        lines(
          done({
            structured_output: {
              text: 'x',
              toolCalls: Array.from({ length: 101 }, () => ({ name: 'a' })),
            },
          }),
        ),
      ),
    ),
    {},
    'too many tool calls',
  ),
)

// the model calls an app tool itself
const direct = (input: unknown, name = 'insert_content', content: unknown[] = []) =>
  assistant([...content, { type: 'tool_use', id: 'toolu_a', name, input }], { usage: USAGE })
T.push(
  run(
    wc(
      cli(
        lines(
          direct({ inputJson: '{"blocks":["x"]}' }, 'insert_content', [
            { type: 'text', text: ' Inserting. ' },
          ]),
        ),
        { closeOn: 'never' },
      ),
    ),
    {},
    'a direct call with the input wrapped as inputJson; the CLI is ended at once',
  ),
  run(
    wc(
      cli(
        lines(
          blockStart(1, { type: 'tool_use', id: 'toolu_a', name: 'insert_content', input: {} }),
          inputDelta(1, '{"blocks":'),
          direct({ blocks: '["a","b"]', mode: 'append', meta: '{"k":1}', count: '5' }),
        ),
        { closeOn: 'never' },
      ),
    ),
    {},
    'a direct call after stream events; fields written as strings are undone',
  ),
  run(
    wc(
      cli(
        lines(
          assistant([
            { type: 'tool_use', id: 'a', name: 'insert_content', input: { mode: 'x' } },
            { type: 'tool_use', id: 'b', name: 'read_document', input: {} },
          ]),
        ),
        { closeOn: 'never' },
      ),
    ),
    {},
    'two direct calls',
  ),
  run(
    wc(cli(lines(direct({}, 'Bash')), { closeOn: 'never' })),
    {},
    'a direct call to a tool of the CLI is refused',
  ),
  run(
    wc(
      cli(
        lines(
          assistant([SO_BLOCK, { type: 'tool_use', id: 'x', name: 'read_document', input: {} }]),
          soResult,
          done({ structured_output: answer('through StructuredOutput'), stop_reason: 'end_turn' }),
        ),
      ),
    ),
    {},
    'a direct call beside StructuredOutput is not taken',
  ),
  run(
    wc(
      cli(
        lines(
          blockStart(1, { type: 'tool_use', id: 'toolu_app', name: 'read_document', input: {} }),
          inputDelta(1, '{}'),
          resultOf('toolu_app', true),
          done({ structured_output: answer('ok anyway'), stop_reason: 'end_turn' }),
        ),
      ),
    ),
    {},
    "the CLI's error for an app tool is expected",
  ),
  run(
    wc(
      cli(
        lines(
          blockStart(1, { type: 'tool_use', id: 'toolu_app', name: 'read_document', input: {} }),
          resultOf('toolu_app', false),
          done({ structured_output: answer('x') }),
        ),
      ),
    ),
    {},
    'a result of an app tool that is no error: a tool ran',
  ),
)

// the CLI is not what the run requires
const first = (...events: unknown[]) => events
T.push(
  run(wc(cli('', {}, first(initOk, sysInit(['Bash', 'StructuredOutput'])))), {}, 'two tools'),
  run(wc(cli('', {}, first(initOk, sysInit([])))), {}, 'no tool'),
  run(
    wc(cli('', {}, first(initOk, sysInit(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'.repeat(100)])))),
    {},
    'many tools: five are named',
  ),
  run(
    wc(cli('', {}, first(initOk, sysInit(['a', 'b'])))),
    {},
    'two tools that are not the one: no ellipsis',
  ),
  run(wc(cli('', {}, first(initOk, sysInit('x')))), {}, 'the tool list is not a list'),
  run(
    wc(cli('', {}, first(initOk, sysInit(['StructuredOutput'], { mcp_servers: [{ name: 'x' }] })))),
    {},
    'an MCP server',
  ),
  run(
    wc(cli('', {}, first(initOk, sysInit(['StructuredOutput'], { mcp_servers: 'x' })))),
    {},
    'an MCP server as a string',
  ),
  run(
    wc(
      cli(
        lines(msgStart, inputDelta(0, '')),
        {},
        first(initOk, sysInit(['StructuredOutput'], { mcp_servers: null })),
      ),
    ),
    {},
    'mcp_servers null is none; a delta for a block never started',
  ),
  run(wc(cli(lines(msgStart), {}, first(initOk))), {}, 'an answer before the tool list'),
  run(wc(cli(lines(done()), {}, first(initOk))), {}, 'a result before the tool list'),
  run(
    wc(cli(lines(assistant([])), {}, first(initOk))),
    {},
    'an assistant message before the tool list',
  ),
  run(
    wc(cli(lines(blockStart(0, { type: 'tool_use', id: 'x', name: 'Bash' })))),
    {},
    'the CLI starts a tool of its own',
  ),
  run(
    wc(cli(lines(blockStart(0, { type: 'mcp_tool_use', id: 'x', name: 'mcp__x__y' })))),
    {},
    'an MCP tool block',
  ),
  run(
    wc(cli(lines(blockStart(0, { type: 'server_tool_use', id: 'x' })))),
    {},
    'a server tool block without a name',
  ),
  run(
    wc(cli(lines(assistant([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }])))),
    {},
    'a whole message that calls a tool of the CLI',
  ),
  run(
    wc(cli(lines(assistant([{ type: 'tool_result', tool_use_id: 'x' }])))),
    {},
    'a whole message with a tool result',
  ),
  run(wc(cli(lines(resultOf('unknown_id')))), {}, 'a tool ran'),
  run(
    wc(
      cli(
        lines(
          { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
          done({ structured_output: answer('fine') }),
        ),
      ),
    ),
    {},
    'a user message without a tool result is fine',
  ),
  run(
    wc(
      cli(
        lines({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } }),
      ),
    ),
    {},
    'a permission request',
  ),
  run(
    wc(
      cli(
        lines(
          { type: 'control_request', request_id: 'r1', request: { subtype: 'hook_callback' } },
          { type: 'control_request', request: 5 },
          done({ structured_output: answer('went on') }),
        ),
      ),
    ),
    {},
    'any other request is answered with an error',
  ),
  run(
    wc(cli(lines(blockStart(0, SO_BLOCK), inputDelta(5, '{}')))),
    {},
    'a delta for another block',
  ),
  run(
    wc(
      cli(
        lines(
          blockStart(0, SO_BLOCK),
          ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } }),
        ),
      ),
    ),
    {},
    'a delta without its JSON',
  ),
)

// the CLI reports a failure
T.push(
  run(
    wc(
      cli(
        '',
        {},
        first({
          type: 'control_response',
          response: { subtype: 'error', request_id: 'initialize', error: 'no' },
        }),
      ),
    ),
    {},
    'the CLI does not accept the setup',
  ),
  run(
    wc(
      cli(
        lines(done({ structured_output: answer('after two setups') })),
        {},
        first(
          { type: 'control_response', response: { subtype: 'success', request_id: 'other' } },
          { type: 'control_response' },
          initOk,
          initOk,
          sysInit(),
        ),
      ),
    ),
    {},
    'a response to another request, a second setup answer',
  ),
  run(
    wc(
      cli(
        lines(
          rateLimit(),
          assistant([{ type: 'text', text: "You've hit your limit" }], {}, { error: 'rate_limit' }),
          done({
            subtype: 'error',
            is_error: true,
            result: "You've hit your limit",
            api_error_status: 429,
          }),
        ),
      ),
    ),
    {},
    'the limit that rejected the run',
  ),
  run(
    wc(
      cli(
        lines(
          rateLimit({ status: 'allowed', utilization: 0.1 }),
          assistant([{ type: 'text', text: 'slow down' }], {}, { error: 'rate_limit' }),
          done({ is_error: true, result: '' }),
        ),
      ),
    ),
    {},
    'a rate limit without a reset time',
  ),
  run(
    wc(
      cli(
        lines(
          assistant(
            [{ type: 'text', text: 'Please run /login' }],
            {},
            { error: 'authentication_failed' },
          ),
          done({ is_error: true, result: 'Please run /login' }),
        ),
      ),
    ),
    {},
    'signed out',
  ),
  run(
    wc(
      cli(
        lines(
          assistant([], {}, { error: 'overloaded' }),
          done({ is_error: true, result: 'Overloaded' }),
        ),
      ),
    ),
    {},
    'overloaded',
  ),
  run(
    wc(
      cli(
        lines(
          done({
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['first', 'second', null, 5, [1, 2], { a: 1 }],
          }),
        ),
      ),
    ),
    {},
    'the errors of the result',
  ),
  run(
    wc(cli(lines(done({ subtype: 'error_max_turns', is_error: false, errors: 'x' })))),
    {},
    'a result that is no success',
  ),
  run(
    wc(cli(lines(done({ is_error: true, result: 'API Error: Connection error.' })))),
    {},
    'a connection error',
  ),
  run(wc(cli(lines(done({ is_error: true, result: 'Request timed out' })))), {}, 'a timeout'),
  run(wc(cli(lines(done({ is_error: true, result: 'ECONNRESET' })))), {}, 'a network error code'),
  run(
    wc(cli(lines(done({ is_error: true, api_error_status: 401, result: 'x' })))),
    {},
    'status 401',
  ),
  run(
    wc(cli(lines(done({ is_error: true, api_error_status: 503, result: 'unavailable' })))),
    {},
    'status 503',
  ),
  run(wc(cli(lines(done({ is_error: true, result: 'Something odd' })))), {}, 'an unknown failure'),
  run(
    wc(
      cli(
        lines(
          assistant([{ type: 'text', text: 'Not logged in' }], {}, { error: 'unknown' }),
          done({ is_error: true }),
        ),
      ),
    ),
    {},
    'unknown code, signed-out text from the assistant message',
  ),
  run(
    wc(
      cli(
        lines(
          assistant([{ type: 'text', text: 'from the assistant' }], {}, { error: 'rate_limit' }),
          done({ is_error: true, result: 'from the result' }),
        ),
      ),
    ),
    {},
    'the result text wins over the assistant text',
  ),
  run(
    wc({
      replies: [
        { stdout: [lines(initOk, sysInit())] },
        {
          stdout: [
            lines(
              assistant([{ type: 'text', text: 'Too many requests' }], {}, { error: 'rate_limit' }),
            ),
          ],
        },
      ],
      closeOn: 2,
    }),
    {},
    'the CLI leaves after its own report, with no result',
  ),
  run(
    wc({
      replies: [
        { stdout: [lines(initOk, sysInit())] },
        { stdout: [lines(assistant([], {}, { error: '' }))] },
      ],
      closeOn: 2,
      exit: { code: 2 },
    }),
    {},
    'an empty error code is no report',
  ),
)

// the CLI exits without a result
T.push(
  run(wc(leaves(["error: unknown option '--restricted'\n"], { code: 1 })), {}, 'too old'),
  run(wc(leaves(['Not logged in\n'], { code: 1 })), {}, 'signed out'),
  run(wc(leaves(['boom\n'], { code: 3 })), {}, 'a plain failure'),
  run(wc(leaves([], { code: 137, signal: 'SIGKILL' })), {}, 'ended by a signal'),
  run(wc(leaves([], { code: 0 })), {}, 'no stderr'),
  run(
    wc(leaves(['x'.repeat(5000) + 'END'], { code: 1 })),
    {},
    'the diagnostic keeps its last 4000 characters',
  ),
  run(
    wc(
      leaves(
        ['one ', 'two ', { hex: 'e282' } as unknown as string, { hex: 'ac' } as unknown as string],
        { code: 4 },
      ),
    ),
    {},
    'stderr in pieces, a character split',
  ),
  run(
    wc({ stderr: ['Please run /login\n'], closeOn: 'start', exit: { code: 1 } }),
    {},
    'it exits before the setup',
  ),
  run(wc({ closeOn: 'start', exit: { code: 0 } }), {}, 'it exits at once'),
  run(null, {}, 'the program cannot be started (ENOENT)'),
  run(
    wc({ error: { message: 'spawn /opt/claude/bin/claude EACCES', code: 'EACCES' } }),
    {},
    'the program cannot be started',
  ),
  run(wc({ error: { message: 'weird' } }), {}, 'the start failed without a code'),
  run(
    wc({ pid: null, stdout: [lines(initOk, sysInit())], closeOn: 'start' }),
    {},
    'no pid, but it started',
  ),
  run(wc({ stdout: [big(4 * 1024 * 1024 + 1)] }), {}, 'a line past the cap'),
  run(
    wc({ stdout: [lines(initOk, sysInit()), big(4 * 1024 * 1024 + 1)] }),
    {},
    'a line past the cap after the setup lines',
  ),
)

// the caller gives up, the watchdog, the grace period
T.push(
  run(
    { abortAt: 100, children: [{ closeOn: 'kill' }] } as World,
    {},
    'the caller aborts while the CLI is silent',
  ),
  run(wc({ closeOn: 'kill' }), {}, 'the connection times out'),
  run(
    wc(cli([], { closeOn: 'kill' })),
    {},
    'the CLI goes silent after the tool list: the idle timeout',
  ),
  run(
    {
      abortAt: 50,
      children: [
        cli([lines(msgStart, blockStart(0, SO_BLOCK), inputDelta(0, '{"text":"par'))], {
          closeOn: 'kill',
        }),
      ],
    } as World,
    {},
    'the caller aborts after part of the text',
  ),
  run(wc({ closeOn: 'kill' }), { preAborted: true }, 'aborted before it started'),
  run(
    wc(cli(lines(done({ structured_output: answer('done') })), { closeOn: 'never' })),
    { graceMs: 250 },
    'the CLI does not leave after its input ends: ended after the grace period',
  ),
  run(
    wc(cli(lines(done({ structured_output: answer('done') })))),
    {},
    'the CLI leaves by itself: the grace timer is cleared',
  ),
  run(
    wc(cli(lines(done({ structured_output: answer('done') })), { closeOn: 'never' })),
    {},
    'the default grace period',
  ),
)

// what the call is given
T.push(
  run(
    wc(cli(lines(done({ structured_output: answer('hi') })))),
    { config: { model: ' opus[1m] ', effort: 'high', cliPath: '/custom/claude' } },
    'model, effort and the configured path',
  ),
  run(
    wc(cli(lines(done({ structured_output: answer('hi') })))),
    { config: { model: '', effort: 'none' } },
    'no model, an effort the CLI does not take',
  ),
  run(wc(cli('')), { config: { model: '--evil' } }, 'a model name that could read as an option'),
  run(
    wc(cli('')),
    { tools: [{ name: 'bad name', description: '', inputSchema: {} }] },
    'a tool name that cannot go on the command line',
  ),
  run(wc(cli('')), { resolveError: 'no cli here' }, 'the program finder fails'),
  run(
    wc(cli(lines(done({ structured_output: answer('hi') })))),
    {
      messages: [
        { role: 'user', text: 'a', images: images(101) },
        { role: 'user', text: 'b' },
      ],
    },
    'more images than the CLI takes',
  ),
  run(
    wc(cli(lines(done({ structured_output: answer('hi') })))),
    {
      messages: [
        { role: 'user', text: 'insert' },
        {
          role: 'assistant',
          text: 'ok',
          toolCalls: [{ id: 't', name: 'insert_content', input: {} }],
        },
        { role: 'tool', results: [{ id: 't', output: 'done' }] },
      ],
      system: '',
      tools: [],
    },
    'a conversation with tool results, no system prompt, no tools',
  ),
  run(
    wc(cli(lines(done({ structured_output: answer('hi') })))),
    {
      baseEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'x',
        CLAUDE_CODE_USE_BEDROCK: '1',
        OPENAI_API_KEY: 'k',
        KEEP: 'me',
      },
    },
    'the sanitised environment',
  ),
)

// ---------------------------------------------------------------------------
// the one-shot chat
// ---------------------------------------------------------------------------

const chat: FnSpec = {
  ts: ([world, o], cx) => {
    const opts = (o ?? {}) as Opts
    const lcx = scrubbed(cx)
    return inWorld(world as World, lcx, async (r, signal) => {
      if (opts.preAborted) r.abort.abort()
      const wd = watchdog.createStreamWatchdog(signal)
      try {
        const response = await wd.guard(() =>
          mod.chatClaudeCodeCli(
            wd,
            opts.config as Any,
            opts.system as string,
            opts.user as string,
            depsOf(opts, lcx),
          ),
        )
        return { response }
      } catch (e) {
        return { threw: describe(e) }
      }
    })
  },
  cases: [
    run(
      wc(
        plain(
          lines(
            msgStart,
            textDelta('Hel'),
            textDelta('lo'),
            assistant([{ type: 'text', text: 'Hello' }]),
            done({ result: 'Hello', stop_reason: 'end_turn', usage: USAGE }),
          ),
        ),
      ),
      {},
      'text deltas',
    ),
    run(wc(plain(lines(done({ result: 'only the result' })))), {}, 'the result text only'),
    run(
      wc(
        plain(
          lines(
            assistant([
              { type: 'text', text: 'whole ' },
              { type: 'text', text: 'message' },
            ]),
            done(),
          ),
        ),
      ),
      {},
      'a whole message',
    ),
    run(wc(plain(lines(done()))), {}, 'no content'),
    run(
      wc(
        plain([
          lines(msgStart, textDelta('Hello wor')),
          lines(msgStart, textDelta('Hello world'), done({ result: 'Hello world' })),
        ]),
      ),
      {},
      'the CLI sends the answer again',
    ),
    run(
      wc(plain(lines(thinkDelta('hmm'), textDelta('ok'), done()))),
      {},
      'thinking is not in the answer',
    ),
    run(wc(cli(lines(done()))), {}, 'a tool list that is not empty'),
    run(wc(plain(lines(done({ is_error: true, result: 'Connection error' })))), {}, 'a failure'),
    run(wc(plain(lines(blockStart(0, SO_BLOCK)))), {}, 'a tool of the CLI in a plain turn'),
    run(wc({ closeOn: 'kill' }), {}, 'the connection times out'),
    run(wc(plain([], { closeOn: 'kill' })), {}, 'the idle timeout'),
    run(null, {}, 'the program cannot be started'),
    run(wc(plain('')), { config: { model: 'bad name' } }, 'a bad model name'),
    run(
      wc(plain(lines(textDelta('x'), done()))),
      { user: '', system: '' },
      'empty system prompt and message',
    ),
    run(wc({ closeOn: 'kill' }), { preAborted: true }, 'aborted before it started'),
  ],
}

// ---------------------------------------------------------------------------
// the model list
// ---------------------------------------------------------------------------

const list: FnSpec = {
  ts: ([world, o], cx) => {
    const opts = (o ?? {}) as Opts
    const lcx = scrubbed(cx)
    return inWorld(world as World, lcx, async (r, signal) => {
      if (opts.preAborted) r.abort.abort()
      try {
        const models = await mod.listClaudeCodeModels(
          { cliPath: opts.cliPath, signal, timeoutMs: opts.timeoutMs },
          depsOf(opts, lcx),
        )
        return { models }
      } catch (e) {
        return { threw: describe(e) }
      }
    })
  },
  cases: [],
}
const listed = (response: object, more: object = {}) => ({
  replies: [
    {
      stdout: [
        lines({ type: 'control_response', response: { request_id: 'initialize', ...response } }),
      ],
    },
  ],
  ...more,
})
const ok = (response: unknown) => listed({ subtype: 'success', response })
const L = list.cases
L.push(
  run(
    wc(
      ok({
        models: [
          {
            value: 'default',
            displayName: 'Default',
            resolvedModel: 'claude-sonnet-4-5',
            supportedEffortLevels: ['low', 'high'],
          },
          { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['max', 'bogus'] },
          { value: 'bad name' },
        ],
        account: { email: 'someone@example.com' },
      }),
    ),
    {},
    'the models; the setup request is the only line written',
  ),
  run(wc(ok({ models: [] })), { cliPath: '/custom/claude' }, 'no model, a configured path'),
  run(wc(ok({})), {}, 'no models field'),
  run(
    wc(listed({ subtype: 'error', error: 'unknown' })),
    {},
    'an older CLI does not accept the request',
  ),
  run(
    wc({
      replies: [
        {
          stdout: [
            lines(
              { type: 'control_response', response: { request_id: 'other', subtype: 'success' } },
              { type: 'control_response' },
              { type: 'system', subtype: 'init' },
              { type: 'rate_limit_event' },
            ),
          ],
        },
      ],
      stdout: ['not json\n', '[1]\n'],
    }),
    {},
    'lines that are not the answer are passed over; nothing answers: the timeout',
  ),
  run(wc({ closeOn: 'kill' }), { timeoutMs: 200 }, 'the CLI does not answer in time'),
  run(wc({ closeOn: 'kill' }), {}, 'the default timeout'),
  run({ abortAt: 50, children: [{ closeOn: 'kill' }] } as World, {}, 'the caller gives up'),
  run(wc({ closeOn: 'kill' }), { preAborted: true }, 'aborted before it started'),
  run(wc(ok({ models: [] })), { resolveError: 'no cli here' }, 'the program finder fails'),
  run(
    wc({
      replies: [{ stdout: [lines({ type: 'assistant', message: { content: [] } })] }],
      closeOn: 'kill',
    }),
    {},
    'the CLI answers with an assistant message',
  ),
  run(
    wc({
      replies: [
        { stdout: [lines({ type: 'control_request', request: { subtype: 'can_use_tool' } })] },
      ],
      closeOn: 'kill',
    }),
    {},
    'the CLI asks for something',
  ),
  run(
    wc({ replies: [{ stdout: [lines({ type: 'stream_event', event: {} })] }], closeOn: 'kill' }),
    {},
    'the CLI streams',
  ),
  run(
    wc({ replies: [{ stdout: [lines({ type: 'user' })] }], closeOn: 'kill' }),
    {},
    'a user event',
  ),
  run(
    wc({ replies: [{ stdout: [lines({ type: 'result', subtype: 'success' })] }], closeOn: 'kill' }),
    {},
    'a result',
  ),
  run(
    wc({ closeOn: 'start', exit: { code: 1 }, stderr: ['Not logged in\n'] }),
    {},
    'the CLI exits before it lists',
  ),
  run(null, {}, 'the program cannot be started (ENOENT)'),
  run(
    wc({ error: { message: 'spawn EPERM', code: 'EPERM' } }),
    {},
    'the program cannot be started',
  ),
  run(wc({ stdout: [big(4 * 1024 * 1024 + 1)] }), {}, 'an endless line'),
  run(wc(ok({ models: [{ value: 'sonnet' }] })), {}, 'the CLI leaves by itself after the answer'),
  run(
    wc({
      ...ok({ models: [{ value: 'sonnet' }] }),
      stdout: [{ hex: 'efbbbf' }, '{"type":"assistant"}\n'],
    }),
    {},
    'a byte order mark stays on the first line, which then is no event',
  ),
  run(
    wc({ ...ok({ models: [{ value: 'sonnet' }] }), closeOn: 'never' }),
    { graceMs: 300 },
    'the CLI does not leave: ended after the grace period',
  ),
  run(
    wc({ ...ok({ models: [{ value: 'sonnet' }] }), closeOn: 'never' }),
    {},
    'the default grace period',
  ),
  run(
    wc({
      replies: [
        {
          stdout: [
            lines({
              type: 'control_response',
              response: {
                request_id: 'initialize',
                subtype: 'success',
                response: { models: [{ value: 'a' }] },
              },
            }),
            lines({ type: 'result' }),
          ],
        },
      ],
    }),
    {},
    'what comes after the answer is not read',
  ),
)

export const group: Group = {
  ...pure,
  ...parse,
  ...lineReader,
  'claude-code-cli.streamClaudeCodeCli': stream,
  'claude-code-cli.chatClaudeCodeCli': chat,
  'claude-code-cli.listClaudeCodeModels': list,
}
