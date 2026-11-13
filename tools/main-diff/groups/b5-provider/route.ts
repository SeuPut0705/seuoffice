/**
 * Group `b5-provider`, part `route` (Rust: crates/main-core/src/calls/b5_provider/route.rs):
 * stream.ts, chat.ts and the endpoint resolution of registry.ts. The routes
 * of the key providers run in the world; the subscription bridges are
 * covered by their own parts.
 *
 * A turn's callbacks log `['delta', v]`, `['toolCall', c]`, `['stop', r]`,
 * `['usage', u]`. `o` of a case: `provider`, `config`, `maxTokens` (1000),
 * `timeoutMs`, `tools` (names), `system` ('sys'), `user`.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type World } from './world.ts'

// loaded after electron-fake.ts has registered its hooks
const stream = await import('../../../../packages/ai-provider/src/stream.ts')
const chat = await import('../../../../packages/ai-provider/src/chat.ts')
const registry = await import('../../../../packages/ai-provider/src/registry.ts')
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')
const compat = await import('../../../../packages/ai-provider/src/protocols/openai-compatible.ts')
const gateway = await import('../../../../packages/ai-provider/src/protocols/gateway-complete.ts')
const outputCap = await import('../../../../packages/ai-provider/src/output-cap.ts')

const { getProviderAdapter } = registry

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Opts {
  provider: string
  config?: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
  tools?: string[]
  system?: string
  user?: string
}

function setUp(): void {
  fetchMod.setRescueFetch(null)
  fetchMod.setAiFetch(null)
  fetchMod.setAiUserAgent('')
  fetchMod.setAiTransientRetryDelays([])
  compat.resetUsageRejectedGateways()
  gateway.setGatewayTokenProvider(null)
  outputCap.resetOutputCaps()
}

const c = (...args: unknown[]): Case => ({ args })
const sse = (...events: unknown[]): string[] => [
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''),
]
const ok = (body: string[], type = 'text/event-stream') => ({
  status: 200,
  headers: [['content-type', type]] as [string, string][],
  body,
})
const json = (value: unknown) => ok([JSON.stringify(value)], 'application/json')
const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World

const COMPAT = ok(sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }, '[DONE]'))
const ANTHROPIC = ok(
  sse(
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ),
)
const GEMINI = ok(
  sse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
)
const RESPONSES = ok(
  sse(
    { type: 'response.output_text.delta', delta: 'hi' },
    {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ),
)
const CAP_400 = {
  status: 400,
  headers: [],
  body: [
    '{"error":{"message":"max_tokens is too large: 8192. This model supports at most 4096 completion tokens"}}',
  ],
}

const toolDefs = (names: string[] = []) =>
  names.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object' } }))

const messages = [{ role: 'user', content: 'hello' }]

const turn = (
  provider: string,
  config: Record<string, unknown>,
  more: Partial<Opts> = {},
): Opts => ({
  provider,
  config,
  ...more,
})

const streamCases: Case[] = [
  c(w([COMPAT]), turn('openai', { apiKey: 'k', model: 'gpt-4o' })),
  c(
    w([COMPAT]),
    turn('openai', { apiKey: 'k', model: 'gpt-4o', baseUrl: 'https://proxy.example/v1#x' }),
  ),
  c(w([RESPONSES]), turn('openai', { apiKey: 'k', model: 'gpt-5.4' })),
  c(
    w([RESPONSES]),
    turn('openai', { apiKey: 'k', model: 'gpt-6-mini', baseUrl: 'https://p.example/v1' }),
  ),
  c(w([COMPAT]), turn('deepseek', { apiKey: 'k', model: 'deep-seek-v4.1-flash' })),
  c(w([COMPAT]), turn('deepseek', { apiKey: 'k', model: 'deepseek-v4-pro' })),
  c(w([COMPAT]), turn('kimi', { apiKey: 'k', model: 'kimi-k3' })),
  c(w([COMPAT]), turn('glm', { apiKey: 'k', model: 'glm-5.3' }, { tools: ['read'] })),
  c(w([COMPAT]), turn('openrouter', { apiKey: 'k', model: 'openai/gpt-5', effort: 'high' })),
  c(w([COMPAT]), turn('openrouter', { apiKey: 'k', model: 'x/y', effort: 'low' })),
  c(w([ANTHROPIC]), turn('anthropic', { apiKey: 'k', model: 'claude-opus-4' })),
  c(w([ANTHROPIC]), turn('anthropic', { apiKey: 'k', model: 'claude-opus-4', effort: 'high' })),
  c(w([GEMINI]), turn('gemini', { apiKey: 'k', model: 'gemini-3-pro' })),
  c(w([GEMINI]), turn('gemini', { apiKey: 'k', model: 'gemini-2.5-flash' })),
  c(w([ANTHROPIC]), turn('opencode-zen', { apiKey: 'k', model: 'claude-sonnet-4' })),
  c(w([GEMINI]), turn('opencode-zen', { apiKey: 'k', model: 'gemini-3-pro' })),
  c(
    w([COMPAT]),
    turn('opencode-zen', { apiKey: 'k', model: 'kimi-k2', baseUrl: 'https://opencode.ai/zen/v1/' }),
  ),
  c(w([ANTHROPIC]), turn('opencode-go', { apiKey: 'k', model: 'qwen3.8-flash' })),
  c(w([COMPAT]), turn('opencode-go', { apiKey: 'k', model: 'qwen3.8-flash-x' })),
  c(w([ANTHROPIC]), turn('commandcode', { apiKey: 'k', model: 'claude-x' })),
  c(
    w([COMPAT]),
    turn('custom', { apiKey: 'k', model: 'local', baseUrl: 'http://localhost:11434/v1?v=1' }),
  ),
  c(
    w([COMPAT]),
    turn('custom', { model: 'gpt-5', baseUrl: 'http://localhost:1/v1' }, { timeoutMs: 5000 }),
  ),
  c(w([]), turn('custom', { apiKey: 'k', model: 'local' })),
  c(w([]), turn('custom', { model: 'm', baseUrl: 'ftp://x.example' })),
  c(w([]), turn('custom', { model: 'm', baseUrl: 'https://user:pw@x.example' })),
  c(
    w([COMPAT], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'tok' } }),
    turn('gateway', { model: 'm', baseUrl: ' https://gw.example/v1 ' }, { timeoutMs: 2000 }),
  ),
  c(w([], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'tok' } }), turn('gateway', { model: 'm' })),
  c(w([CAP_400, COMPAT]), turn('openai', { apiKey: 'k', model: 'gpt-4o' }, { maxTokens: 8192 })),
  c(w([CAP_400, CAP_400]), turn('mistral', { apiKey: 'k', model: 'm' }, { maxTokens: 8192 })),
  c(w([]), turn('auto', { model: 'm' })),
  c(w([]), turn('nope', { model: 'm' })),
  c(w([]), turn('toString', { model: 'm' })),
  c(w([]), turn('constructor', { model: 'm' })),
]

const chatCases: Case[] = [
  c(
    w([json({ choices: [{ message: { content: 'hello' } }] })]),
    turn('openai', { apiKey: 'k', model: 'gpt-4o' }),
  ),
  c(
    w([json({ choices: [{ message: { content: [{ text: 'a' }] } }] })]),
    turn('xai', { apiKey: 'k', model: 'grok' }),
  ),
  c(
    w([json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'r' }] }] })]),
    turn('openai', { apiKey: 'k', model: 'gpt-5.5' }),
  ),
  c(
    w([json({ content: [{ type: 'text', text: 'claude' }], stop_reason: 'end_turn' })]),
    turn('anthropic', { apiKey: 'k', model: 'claude-opus-4', effort: 'max' }),
  ),
  c(
    w([json({ candidates: [{ content: { parts: [{ text: 'g' }] } }] })]),
    turn('gemini', { apiKey: 'k', model: 'gemini-3-pro' }),
  ),
  c(
    w([json({ choices: [{ message: { content: 'x' } }] })]),
    turn('openrouter', { apiKey: 'k', model: 'm', effort: 'high' }),
  ),
  c(w([]), turn('custom', { model: 'm' })),
  c(w([]), turn('auto', { model: 'm' })),
  c(w([]), turn('toString', { model: 'm' })),
  c(
    w([
      {
        status: 200,
        headers: [
          ['content-length', '99999999'],
          ['content-type', 'application/json'],
        ],
        body: ['{}'],
      },
    ]),
    turn('openai', { apiKey: 'k', model: 'gpt-4o' }),
  ),
  c(w([{ hang: true }], { abortAt: 1000 }), turn('openai', { apiKey: 'k', model: 'gpt-4o' })),
  c(w([{ hang: true }]), turn('openai', { apiKey: 'k', model: 'gpt-4o' })),
  c(
    w([], { env: { SEUOFFICE_AI_GATEWAY_TOKEN: 'tok' } }),
    turn('gateway', { model: 'm', baseUrl: 'https://gw.example' }),
  ),
]

function callbacks(cx: TsContext, signal: AbortSignal): Any {
  return {
    onDelta: (v: unknown) => cx.log('delta', v),
    onToolCall: (v: unknown) => cx.log('toolCall', v),
    onStopReason: (v: unknown) => cx.log('stop', v),
    onUsage: (v: unknown) => cx.log('usage', v),
    signal,
  }
}

export const group: Group = {
  'stream.streamForProvider': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const opts = o as Opts
        setUp()
        await stream.streamForProvider(
          opts.provider as Any,
          (opts.config ?? {}) as Any,
          opts.system ?? 'sys',
          messages as Any,
          toolDefs(opts.tools) as Any,
          opts.maxTokens ?? 1000,
          callbacks(cx, signal),
          opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
        )
      }),
    cases: streamCases,
  },
  'chat.chatForProvider': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const opts = o as Opts
        setUp()
        return chat.chatForProvider(
          opts.provider as Any,
          (opts.config ?? {}) as Any,
          opts.system ?? 'sys',
          opts.user ?? 'hello',
          signal,
        )
      }),
    cases: chatCases,
  },
  'registry.resolveEndpoint': {
    // the call written as stream.ts and chat.ts write it, so V8 words its TypeError the same
    ts: ([provider, config]) => getProviderAdapter(provider as Any).resolveEndpoint(config as Any),
    cases: registryCases(),
  },
  'registry.modelHasFixedSampling': {
    ts: ([m]) => registry.modelHasFixedSampling(m as string),
    cases: [
      'kimi-k3',
      'moonshot/Kimi-K3',
      'gpt-5',
      'gpt-4o',
      'gpt-50',
      'o1-mini',
      'o3',
      'o4-mini',
      'o2',
      'gemini-3',
      'gemini-2.5',
      'x/gemini-9-pro',
    ].map((m) => c(m)),
  },
  'registry.modelEchoesReasoning': {
    ts: ([m]) => registry.modelEchoesReasoning(m as string),
    cases: [
      'MiniMax-M3',
      'deepseek-v4-pro',
      'deep-seek-flash',
      'hy-3',
      'hy4-preview',
      'hy5',
      'gpt-4o',
      'a/minimax-m2',
    ].map((m) => c(m)),
  },
  'registry.modelUsesResponsesApi': {
    ts: ([m]) => registry.modelUsesResponsesApi(m as string),
    cases: [
      'gpt-5.4',
      'GPT-5.9-mini',
      'gpt-5.3',
      'gpt-6',
      'gpt-6.1-sol',
      'gpt-60',
      'openai/gpt-5.4',
    ].map((m) => c(m)),
  },
}

function registryCases(): Case[] {
  const ids = [
    'claude-code',
    'chatgpt',
    'codex',
    'anthropic',
    'gemini',
    'deepseek',
    'openai',
    'kimi',
    'glm',
    'qwen',
    'doubao',
    'mimo',
    'hunyuan',
    'ling',
    'spark',
    'longcat',
    'minimax',
    'xai',
    'mistral',
    'upstage',
    'exaone',
    'openrouter',
    'requesty',
    'opper',
    'cheaperinference',
    'atlascloud',
    'runcrate',
    'cloudgpu',
    'siliconflow',
    'ppio',
    'opencode-zen',
    'opencode-go',
    'commandcode',
    'custom',
    'gateway',
  ]
  return [
    ...ids.map((id) => c(id, { model: 'gpt-5', baseUrl: 'https://mirror.example/v1/' })),
    ...ids.map((id) => c(id, { model: 'm' })),
    c('deepseek', { model: 'deep-seek-v4.1-flash' }),
    c('opencode-zen', { model: '' }),
    c('opencode-zen', { model: 'kimi-k2', baseUrl: 'https://x.example/v1?k=1' }),
    c('opencode-go', {}),
    c('gateway', { baseUrl: '   ' }),
    c('gateway', { baseUrl: 5 }),
    c('openai', { model: 7 }),
    c('openai', {}),
    c('custom', { model: 'm', baseUrl: 'x'.repeat(3000) }),
    c('auto', {}),
    c('__proto__', {}),
    c('valueOf', {}),
    c('', {}),
  ]
}
