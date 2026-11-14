/**
 * Group `b5-provider`, part `keys` (Rust: crates/main-core/src/calls/b5_provider/keys.rs):
 * packages/ai-provider/src/{key-effort, key-models, key-model-refresh,
 * custom-models, local-models, local-ipc, local-test}.ts. Names are
 * `<file>.<export>`.
 *
 * The pure functions take their arguments as JSON. The async ones run in the
 * scripted world of world.ts (their first argument); the second argument
 * `o` is what the call is given:
 *
 * - `key-models.listKeyProviderModels` and `listKeyProviderModelListing`:
 *   `{ provider, apiKey = 'sk-test', baseUrl, fetch: 'net' }`.
 * - `key-model-refresh.createKeyModelRefresher`: `{ settings, steps, lists,
 *   readFails, writeFails }`. The settings are the file; `steps` are
 *   `['refresh']` (`refreshChanged()`), `['idle']`, `['sleep', ms]` and `['set',
 *   provider, field, value]` (the file changes under the refresher); the case
 *   ends with `idle()`. `lists` replaces the listing: the n-th call answers
 *   `{ after: ms, answer, reject }` (an array, `{ models, efforts }`, null).
 *   Every write is one log line `['write', 'same' | 'changed']`, every call of
 *   `lists` `['list', provider, apiKey, baseUrl]`. The answer is the file.
 * - `custom-models.*`: `{ baseUrl, apiKey }`, or the IPC payload itself.
 * - `local-models.*`: the request (`{ baseUrl, apiKey, model, server }`), with
 *   `o.signal` (the world's caller signal) for `listLocalModels`.
 * - `local-test.testLocalModel`: `{ input, signal: 'world' | 'aborted' }`.
 * - `local-ipc.testLocalModelForIpc` and `cancelLocalTestForIpc`: `{ input,
 *   owner, abort, second: { input, owner, at }, cancel: { input, owner, at }
 *   }`; the tests and the cancel run side by side in the world.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type World, type WorldRun } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test
const src = '../../../../packages/ai-provider/src'
const keyEffort = await import(`${src}/key-effort.ts`)
const keyModels = await import(`${src}/key-models.ts`)
const refresh = await import(`${src}/key-model-refresh.ts`)
const customModels = await import(`${src}/custom-models.ts`)
const localModels = await import(`${src}/local-models.ts`)
const localIpc = await import(`${src}/local-ipc.ts`)
const localTest = await import(`${src}/local-test.ts`)
const fetchMod = await import(`${src}/fetch.ts`)
const openAi = await import(`${src}/protocols/openai-compatible.ts`)

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** the module state every call starts from */
function setUp(): void {
  fetchMod.setRescueFetch(null)
  fetchMod.setAiFetch(null)
  fetchMod.setAiUserAgent('')
  fetchMod.setAiTransientRetryDelays(null)
  openAi.resetUsageRejectedGateways()
}

const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World
const c = (...args: unknown[]): Case => ({ args })
// the tsconfig of the tool has no `Promise.withResolvers` yet
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const JSON_TYPE: [string, string][] = [['content-type', 'application/json']]
/** an answer whose body is `value` as JSON */
const jsonOf = (value: unknown, status = 200) => ({
  status,
  headers: JSON_TYPE,
  body: [JSON.stringify(value)] as Chunk[],
})
/** an answer with these chunks */
const raw = (body: Chunk[] | null, status = 200, headers: [string, string][] = []) => ({
  status,
  headers,
  body,
})
const sse = (events: unknown[], done = true) => ({
  status: 200,
  headers: [['content-type', 'text/event-stream']] as [string, string][],
  body: [
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
  ] as Chunk[],
})
const redirect = (status: number, location: string) => ({
  status,
  headers: [['location', location]] as [string, string][],
  body: ['moved'] as Chunk[],
})
const hang = { hang: true }
const down = { reject: { class: 'TypeError', message: 'fetch failed' } }

// ---------------------------------------------------------------------------
// key-effort.ts
// ---------------------------------------------------------------------------

const TABLE = {
  'model-a': { efforts: ['low', 'high'], defaultEffort: 'high' },
  'model-b': { efforts: ['medium'] },
  'model-bad': { efforts: ['turbo'] },
  'model-no-effort': {},
  constructor: { efforts: ['low'] },
}

const keyEffortGroup: Group = {
  'key-effort.takesKeyEffort': {
    ts: ([provider]) => keyEffort.takesKeyEffort((provider ?? undefined) as Any),
    cases: [
      c('anthropic'),
      c('openrouter'),
      c('deepseek'),
      c('xai'),
      c('custom'),
      c('openai'),
      c('gemini'),
      c('auto'),
      c('constructor'),
      c('toString'),
      c('__proto__'),
      c(null),
      c(''),
    ],
  },
  'key-effort.keyModelEffort': {
    ts: ([config, model]) => keyEffort.keyModelEffort((config ?? undefined) as Any, model as Any),
    cases: [
      c({ modelEfforts: TABLE }, 'model-a'),
      c({ modelEfforts: TABLE }, '  model-a  '),
      c({ modelEfforts: TABLE }, 'model-b'),
      c({ modelEfforts: TABLE }, 'model-bad'),
      c({ modelEfforts: TABLE }, 'model-no-effort'),
      c({ modelEfforts: TABLE }, 'missing'),
      c({ modelEfforts: TABLE }, 'toString'),
      c({ modelEfforts: TABLE }, 'constructor'),
      c({ modelEfforts: TABLE }, '   '),
      c({ modelEfforts: TABLE }, ''),
      c({ modelEfforts: null }, 'model-a'),
      c({ modelEfforts: '' }, 'model-a'),
      c({}, 'model-a'),
      c(null, 'model-a'),
      c({ modelEfforts: TABLE }),
      c({ modelEfforts: TABLE }, null),
      c({ modelEfforts: TABLE }, 5),
      c({ modelEfforts: [{ efforts: ['low'] }] }, '0'),
    ],
  },
  'key-effort.keyProviderEffort': {
    ts: ([provider, config]) => keyEffort.keyProviderEffort(provider as Any, config as Any),
    cases: [
      c('anthropic', { model: 'model-a', effort: 'high', modelEfforts: TABLE }),
      c('anthropic', { model: 'model-a', effort: ' high ', modelEfforts: TABLE }),
      c('anthropic', { model: 'model-a', effort: 'max', modelEfforts: TABLE }),
      c('anthropic', { model: 'model-a', effort: 'turbo', modelEfforts: TABLE }),
      c('anthropic', { model: 'model-a', modelEfforts: TABLE }),
      c('anthropic', { model: 'other', effort: 'high', modelEfforts: TABLE }),
      c('openai', { model: 'model-a', effort: 'high', modelEfforts: TABLE }),
      c('custom', { model: 'model-b', effort: 'medium', modelEfforts: TABLE }),
      c('constructor', { model: 'model-a', effort: 'high', modelEfforts: TABLE }),
      c('anthropic', { effort: 'high', modelEfforts: TABLE }),
      c('anthropic', { model: 5, effort: 'high', modelEfforts: TABLE }),
      c('anthropic', { model: 5, modelEfforts: TABLE }),
    ],
  },
  'key-effort.keyEffortBody': {
    ts: ([provider, config, protocol]) =>
      keyEffort.keyEffortBody(provider as Any, config as Any, protocol as Any),
    cases: [
      c('anthropic', { model: 'model-a', effort: 'high', modelEfforts: TABLE }, 'anthropic'),
      c(
        'anthropic',
        { model: 'model-a', effort: 'high', modelEfforts: TABLE },
        'openai-compatible',
      ),
      c('anthropic', { model: 'model-a', effort: 'high', modelEfforts: TABLE }, 'gemini'),
      c(
        'openrouter',
        { model: 'model-a', effort: 'low', modelEfforts: TABLE },
        'openai-compatible',
      ),
      c('openrouter', { model: 'model-a', effort: 'low', modelEfforts: TABLE }, 'anthropic'),
      c('deepseek', { model: 'model-a', effort: 'high', modelEfforts: TABLE }, 'openai-compatible'),
      c('xai', { model: 'model-b', effort: 'medium', modelEfforts: TABLE }, 'openai-compatible'),
      c('custom', { model: 'model-b', effort: 'medium', modelEfforts: TABLE }, 'openai-compatible'),
      c('custom', { model: 'model-b', effort: 'medium', modelEfforts: TABLE }, 'gateway-complete'),
      c('deepseek', { model: 'model-a', effort: 'max', modelEfforts: TABLE }, 'openai-compatible'),
      c('openai', { model: 'model-a', effort: 'high', modelEfforts: TABLE }, 'openai-compatible'),
      c('toString', { model: 'model-a', effort: 'low', modelEfforts: TABLE }, 'openai-compatible'),
    ],
  },
}

// ---------------------------------------------------------------------------
// key-models.ts, the pure part
// ---------------------------------------------------------------------------

const lx = (id: string, created?: number, effort?: unknown) => ({
  id,
  ...(created !== undefined ? { created } : {}),
  ...(effort !== undefined ? { effort } : {}),
})
const LH = { efforts: ['low', 'high'], defaultEffort: 'high' }
const LM = { efforts: ['medium'] }

const modelIds: Group = {
  'key-models.MAX_KEY_PROVIDER_MODELS': {
    ts: () => keyModels.MAX_KEY_PROVIDER_MODELS,
    cases: [c()],
    single: 'a constant',
  },
  'key-models.keyModelIdsOf': {
    ts: ([provider, listed]) => keyModels.keyModelIdsOf(provider as Any, listed as Any),
    cases: [
      c('anthropic', [lx('claude-a', 100), lx('claude-b', 300), lx('claude-c', 200)]),
      c('anthropic', [lx('b'), lx('a'), lx('c', 5), lx('d')]),
      c('openai', [
        lx('gpt-6'),
        lx('gpt-5-pro'),
        lx('gpt-5-pro-2026-01-01'),
        lx('o3-pro'),
        lx('o3-pro-2025-06-10'),
        lx('o3'),
        lx('gpt-5-codex'),
        lx('gpt-6-codex-max'),
        lx('gpt-5.4-pro-2'),
      ]),
      c('opencode-zen', [
        lx('gpt-5'),
        lx('grok-4'),
        lx('muse-spark'),
        lx('claude-x'),
        lx('qwen-y'),
      ]),
      c('opencode-go', [lx('GPT-5'), lx('Grok-4'), lx('kimi-k3')]),
      c('mistral', [
        lx('text-embedding-3-small'),
        lx('whisper-1'),
        lx('tts-1'),
        lx('gpt-4o-transcribe'),
        lx('gpt-4o-realtime-preview'),
        lx('gemini-live-2'),
        lx('dall-e-3'),
        lx('gpt-image-1'),
        lx('imagen-4'),
        lx('flux-image-pro'),
        lx('veo-3'),
        lx('sora-2'),
        lx('omni-moderation'),
        lx('rerank-v3'),
        lx('gemini-robotics-1'),
        lx('aqa'),
        lx('aqa-2'),
        lx('nano-banana-2'),
        lx('lyria-2'),
        lx('computer-use-preview'),
        lx('o3-deep-research'),
        lx('mistral-ocr-2'),
        lx('babbage-002'),
        lx('davinci-002'),
        lx('live'),
        lx('my-live-model'),
        lx('mistral-large'),
        lx('olive-oil'),
        lx('aqaxx'),
        lx('pixtral-image'),
      ]),
      c('openai', [
        lx('gpt-4o', 10),
        lx('gpt-4o-2024-08-06', 20),
        lx('gpt-4o-20240806', 30),
        lx('gpt-4o-240806', 31),
        lx('gpt-4o-0613', 32),
        lx('gpt-4o-12345'),
        lx('solo-2025-01-01', 5),
        lx('gpt-4o:batch', 6),
        lx('batch-only:batch', 7),
      ]),
      c('deepseek', [lx('deepseek-chat', 1), lx('deepseek-reasoner', 2), lx('deepseek-flash', 3)]),
      c('glm', [lx('glm-5-turbo'), lx('glm-5.3-flash'), lx('glm-5.3-flash-2026-01-01')]),
      c('gemini', [lx('gemini-3.7-flash'), lx('gemini-3.8-flash'), lx('gemini-4-argon')]),
      c('anthropic', [
        lx('  padded  '),
        lx(''),
        lx('   '),
        lx('a'.repeat(256)),
        lx('a'.repeat(257)),
      ]),
      c('anthropic', [lx('x'), lx('x'), lx(' x ')]),
      c('anthropic', []),
      c(
        'openai',
        Array.from({ length: 2100 }, (_, i) => lx(`model-${String(i).padStart(4, '0')}`, i + 1)),
      ),
    ],
  },
  'key-models.keyModelListingOf': {
    ts: ([provider, listed]) => keyModels.keyModelListingOf(provider as Any, listed as Any),
    cases: [
      c('anthropic', [lx('a', 2, LH), lx('b', 3, LM), lx('c', 1)]),
      c('openrouter', [lx('a', 2, LH), lx('text-embedding-x', 3, LM)]),
      c('openai', [lx('a', 2, LH)]),
      c('deepseek', [
        lx('deepseek-chat', 1, LH),
        lx('deepseek-reasoner', 2, LM),
        lx('deepseek-flash', 3, LM),
      ]),
      c('xai', [lx('grok-a', 1, LH), lx('grok-a', 2, LM), lx(' grok-b ', 3, LM)]),
      c('custom', [lx('a', 1, LH)]),
      c('anthropic', [lx('__proto__', 1, LH), lx('ok', 2, LH)]),
      c('anthropic', [lx('a-2025-01-01', 1, LH), lx('a', 2)]),
      c('anthropic', []),
    ],
  },
  'key-models.listsKeyProviderModels': {
    ts: ([provider]) => keyModels.listsKeyProviderModels(provider as Any),
    cases: [
      c('anthropic'),
      c('gemini'),
      c('openai'),
      c('openrouter'),
      c('opencode-zen'),
      c('custom'),
      c('claude-code'),
      c('chatgpt'),
      c('codex'),
      c('gateway'),
      c('auto'),
      c('nope'),
      c('toString'),
      c('constructor'),
    ],
  },
}

// ---------------------------------------------------------------------------
// key-models.ts, the listing of a vendor
// ---------------------------------------------------------------------------

interface ListOpts {
  provider: string
  apiKey?: string
  baseUrl?: string
  fetch?: 'net'
}

const listConfig = (o: ListOpts) => ({
  apiKey: o.apiKey ?? 'sk-test',
  ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
})

const listing =
  (name: 'listKeyProviderModels' | 'listKeyProviderModelListing') =>
  ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run: WorldRun) => {
      setUp()
      const opts = o as ListOpts
      return keyModels[name](
        opts.provider as Any,
        listConfig(opts),
        opts.fetch === 'net' ? run.fetch('net') : undefined,
      )
    })

const A = (extra: Record<string, unknown> = {}) => ({ id: 'claude-sonnet-9', ...extra })
const ANTHROPIC_P1 = jsonOf({
  data: [
    A({
      created_at: '2026-05-01T00:00:00Z',
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          high: { supported: true },
          max: { supported: false },
          medium: {},
        },
      },
    }),
    { id: 'claude-haiku-9', created_at: '2026-06-01T00:00:00Z' },
    5,
    { id: 7 },
    null,
  ],
  has_more: true,
  last_id: 'claude haiku/9',
})
const ANTHROPIC_P2 = jsonOf({
  data: [
    {
      id: 'claude-opus-9',
      created_at: '2026-04-30T12:00:00.500Z',
      capabilities: {
        effort: { supported: true, medium: { supported: true }, xhigh: { supported: true } },
      },
    },
    { id: 'claude-text-embedding-1', created_at: 'garbage' },
  ],
  has_more: false,
})

const GEMINI_P1 = jsonOf({
  models: [
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent', 'x'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.5-pro' },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: [] },
    { name: 'gemini-3.7-flash' },
    { supportedGenerationMethods: ['generateContent'] },
    'x',
  ],
  nextPageToken: 'tok en/1',
})
const GEMINI_P2 = jsonOf({
  models: [
    { name: 'models/gemini-10-x' },
    { name: 'models/gemini-3.8-flash' },
    { name: 'models/aqa' },
  ],
})

const OPENAI_LIST = jsonOf({
  data: [
    { id: 'gpt-6', created: 1700000000 },
    { id: 'gpt-5-pro', created: 1700000100 },
    { id: 'o3-pro' },
    { id: 'gpt-5-codex' },
    { id: 'text-embedding-3-large' },
    { id: 'gpt-4o-2024-08-06', created: 1700000001000 },
    { id: 'gpt-4o', created: '2024-05-13T00:00:00Z' },
    { id: ' o4-mini ', created_at: '2025-04-16T00:00:00.000Z' },
    { id: 'x'.repeat(257) },
    { id: 'gpt-4.1', created: 'not a date' },
    { id: 'gpt-4.1-mini', created: -5 },
    { id: 12 },
    'nope',
  ],
})

const OPENROUTER_LIST = jsonOf({
  data: [
    {
      id: 'vendor/model-a',
      created: 1700000500,
      supported_parameters: ['tools', 'temperature'],
      reasoning: { supported_efforts: ['low', 'high', 'turbo'], default_effort: 'high' },
    },
    { id: 'vendor/no-tools', supported_parameters: ['temperature'], created: 1700000900 },
    { id: 'vendor/image-out', architecture: { output_modalities: ['image'] } },
    { id: 'vendor/text-out', architecture: { output_modalities: ['text', 'image'] } },
    { id: 'vendor/model-a:batch', created: 1700000400 },
    { id: 'vendor/null-levels', reasoning: { supported_efforts: null } },
    { id: 'vendor/empty-levels', reasoning: { supported_efforts: [] } },
    { id: 'vendor/typed', type: 'Embedding' },
    { id: 'vendor/chatty', type: 'chat', created_at: '2026-01-01T00:00:00Z' },
    { id: 'vendor/fn-off', capabilities: { function_calling: false } },
    { id: 'vendor/chat-off', capabilities: { completion_chat: false } },
    { id: 'vendor/caps-ok', capabilities: { function_calling: true, completion_chat: true } },
  ],
})

const DEEPSEEK_LIST = jsonOf({
  data: [
    { id: 'deepseek-v4-pro', effort: { supported_levels: ['high', 'max'], default_level: 'max' } },
    { id: 'deepseek-chat', effort: { supported_levels: ['low'], default_level: 'bogus' } },
    { id: 'deepseek-reasoner', effort: { supported_levels: ['max'] } },
    { id: 'deepseek-flash' },
  ],
})

const XAI_SHORT = jsonOf({
  data: [
    {
      id: 'grok-5',
      capabilities: { reasoning_effort: ['low', 'high'], default_reasoning_effort: 'low' },
    },
    { id: 'grok-5-mini' },
    { id: 'grok-4' },
  ],
})
const XAI_FULL = jsonOf({
  models: [
    { id: 'grok-5-mini', capabilities: { reasoning_effort: ['medium'] } },
    { id: 'grok-5', capabilities: { reasoning_effort: ['max'] } },
    { id: 'grok-4' },
    { id: 7 },
    null,
  ],
})

const listCases: Case[] = [
  // Anthropic
  c(w([ANTHROPIC_P1, ANTHROPIC_P2]), { provider: 'anthropic' }),
  c(w([ANTHROPIC_P1, ANTHROPIC_P2]), {
    provider: 'anthropic',
    apiKey: '  sk-padded  ',
    baseUrl: 'https://gw.example.com/anthropic',
  }),
  c(w([1, 2, 3, 4, 5, 6].map(() => jsonOf({ data: [{ id: 'a' }], has_more: true, last_id: '' }))), {
    provider: 'anthropic',
  }),
  c(w([jsonOf({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }), jsonOf([])]), {
    provider: 'anthropic',
  }),
  c(w([jsonOf([])]), { provider: 'anthropic' }),
  c(w([jsonOf({ data: 'x' })]), { provider: 'anthropic' }),
  c(
    w([
      jsonOf({
        data: [
          { id: 'x1', capabilities: { effort: { supported: false, low: { supported: true } } } },
          {
            id: 'x2',
            capabilities: { effort: { supported: false } },
            reasoning: { supported_efforts: ['low', 'bogus'], default_effort: 'low' },
          },
          {
            id: 'x3',
            capabilities: { effort: { supported: true } },
            effort: { supported_levels: ['max'] },
          },
          { id: 'x4', capabilities: { reasoning_effort: ['high'] } },
          {
            id: 'x5',
            reasoning: { supported_efforts: ['bogus'] },
            effort: { supported_levels: ['low'] },
          },
        ],
      }),
    ]),
    { provider: 'anthropic' },
  ),
  c(w([ANTHROPIC_P1]), { provider: 'anthropic', fetch: 'net' }),
  // Gemini
  c(w([GEMINI_P1, GEMINI_P2]), { provider: 'gemini' }),
  c(w([jsonOf({ models: [{ name: 'models/gemini-3.5-flash' }], nextPageToken: '' }), GEMINI_P2]), {
    provider: 'gemini',
  }),
  c(w([jsonOf({ models: 'x' })]), { provider: 'gemini' }),
  c(w([jsonOf({ models: [{ name: 'models/text-embedding-004' }] })]), { provider: 'gemini' }),
  // OpenAI-compatible vendors
  c(w([OPENAI_LIST]), { provider: 'openai' }),
  c(w([OPENAI_LIST]), { provider: 'openai', baseUrl: 'https://proxy.example.com/v1/' }),
  c(w([OPENAI_LIST]), { provider: 'openai', baseUrl: 'ftp://nope.example.com' }),
  c(w([OPENROUTER_LIST]), { provider: 'openrouter' }),
  c(w([DEEPSEEK_LIST]), { provider: 'deepseek' }),
  c(w([XAI_SHORT, XAI_FULL]), { provider: 'xai' }),
  c(w([XAI_SHORT, jsonOf({}, 500)]), { provider: 'xai' }),
  c(w([XAI_SHORT, raw(['not json'])]), { provider: 'xai' }),
  c(w([XAI_SHORT, hang]), { provider: 'xai' }),
  c(
    w([
      jsonOf({
        data: [
          { id: 'grok-5', capabilities: { reasoning_effort: ['low'] } },
          { id: 'grok-4', capabilities: { reasoning_effort: ['high'] } },
        ],
      }),
    ]),
    { provider: 'xai' },
  ),
  c(w([XAI_SHORT, redirect(302, 'https://elsewhere.example.com/x')]), { provider: 'xai' }),
  c(
    w([
      jsonOf({
        data: [
          { id: 'big-model', created: 1700000000 },
          { id: 'gpt-5', created: 1700000001 },
          { id: 'grok-4' },
          { id: 'muse-spark' },
          { id: 'minimax-m3' },
        ],
      }),
    ]),
    { provider: 'opencode-zen' },
  ),
  c(w([jsonOf({ data: [{ id: 'gpt-5' }, { id: 'kimi-k3' }] })]), { provider: 'opencode-go' }),
  c(
    w([
      jsonOf({
        data: [
          { id: 'mistral-large', created_at: '2026-03-01T10:00:00Z', type: 'Chat' },
          { id: 'mistral-embed', type: 'embedding' },
          { id: 'codestral', created_at: '2026-03-01T10:00:00+02:00', type: 'text' },
          { id: 'pixtral', capabilities: { completion_chat: false } },
        ],
      }),
    ]),
    { provider: 'mistral' },
  ),
  c(w([jsonOf({ data: {} })]), { provider: 'mistral' }),
  c(w([jsonOf(null)]), { provider: 'mistral' }),
  c(w([jsonOf({ data: [{ id: 'whisper-1' }, { id: 'text-embed' }] })]), { provider: 'mistral' }),
  c(w([OPENAI_LIST]), { provider: 'mistral', fetch: 'net' }),
  c(
    w([
      jsonOf({
        data: Array.from({ length: 2105 }, (_, i) => ({
          id: `m-${String(i).padStart(4, '0')}`,
          created: i + 1,
        })),
      }),
    ]),
    { provider: 'openai' },
  ),
  // what goes wrong
  c(w([jsonOf({ error: 'no' }, 401)]), { provider: 'openai' }),
  c(w([jsonOf({}, 404)]), { provider: 'mistral' }),
  c(w([raw(['<html>'], 200, [['content-type', 'text/html']])]), { provider: 'mistral' }),
  c(w([raw(['{"data":[{"id":"m1"}]}'], 200, [['content-length', '9000000']])]), {
    provider: 'mistral',
  }),
  c(w([jsonOf({ data: [{ id: 'm1' }] }, 500)]), { provider: 'mistral' }),
  c(
    w([
      jsonOf({ data: [{ id: 'a' }], has_more: false, last_id: 'a' }),
      jsonOf({ data: [{ id: 'b' }] }),
    ]),
    {
      provider: 'anthropic',
    },
  ),
  c(
    w([
      jsonOf({
        data: [
          { id: 'ms-model', created: 1700000001000 },
          { id: 's-model', created: 1700000002 },
        ],
      }),
    ]),
    {
      provider: 'mistral',
    },
  ),
  c(w([down]), { provider: 'mistral' }),
  c(w([hang]), { provider: 'mistral' }),
  c(w([raw(['{"data":[{"id":"a"}]}'])], { abortAt: 0 }), { provider: 'mistral' }),
  c(w([redirect(302, 'https://elsewhere.example.com/x')]), { provider: 'mistral' }),
  c(w([redirect(307, '/v2/models')]), { provider: 'anthropic' }),
  c(w([]), { provider: 'gemini' }),
  // no list to be had without a request
  c(w([OPENAI_LIST]), { provider: 'openai', apiKey: '' }),
  c(w([OPENAI_LIST]), { provider: 'openai', apiKey: '   ' }),
  c(w([OPENAI_LIST]), { provider: 'custom' }),
  c(w([OPENAI_LIST]), { provider: 'claude-code' }),
  c(w([OPENAI_LIST]), { provider: 'chatgpt' }),
  c(w([OPENAI_LIST]), { provider: 'codex' }),
  c(w([OPENAI_LIST]), { provider: 'gateway' }),
  c(w([OPENAI_LIST]), { provider: 'nope' }),
  c(w([OPENAI_LIST]), { provider: 'toString' }),
  c(w([OPENAI_LIST]), { provider: 'toString', apiKey: '' }),
]

const listings: Group = {
  'key-models.listKeyProviderModelListing': {
    ts: listing('listKeyProviderModelListing'),
    cases: listCases,
  },
  'key-models.listKeyProviderModels': {
    ts: listing('listKeyProviderModels'),
    cases: [
      c(w([ANTHROPIC_P1, ANTHROPIC_P2]), { provider: 'anthropic' }),
      c(w([GEMINI_P1, GEMINI_P2]), { provider: 'gemini' }),
      c(w([DEEPSEEK_LIST]), { provider: 'deepseek' }),
      c(w([jsonOf({}, 500)]), { provider: 'deepseek' }),
      c(w([OPENAI_LIST]), { provider: 'custom' }),
      c(w([OPENAI_LIST]), { provider: 'toString' }),
    ],
  },
}

// ---------------------------------------------------------------------------
// key-model-refresh.ts
// ---------------------------------------------------------------------------

const settingsOf = (providers: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  provider: 'anthropic',
  ...more,
  providers,
})
const SETS = {
  both: settingsOf({
    anthropic: { apiKey: 'k-a', model: 'claude-sonnet-9' },
    openai: { apiKey: 'k-o', model: 'gpt-6', baseUrl: 'https://proxy.example.com/v1' },
    gemini: { apiKey: '', model: 'gemini-3.8-flash' },
    custom: { apiKey: 'k-c', model: 'x', baseUrl: 'http://localhost:1/v1' },
    'claude-code': { apiKey: 'k-cli', model: 'x' },
  }),
  one: settingsOf({ openai: { apiKey: 'k-o', model: 'gpt-6' } }),
  stored: settingsOf({
    openai: {
      apiKey: 'k-o',
      model: 'gpt-6',
      models: ['old-1', 'old-2'],
      modelEfforts: { 'old-1': { efforts: ['low'] } },
      extra: 1,
    },
  }),
  same: settingsOf({
    openai: { apiKey: 'k-o', model: 'gpt-6', models: ['gpt-6', 'gpt-5'], note: 'kept' },
  }),
  two: settingsOf({
    openai: { apiKey: 'k-o', model: 'gpt-6' },
    mistral: { apiKey: 'k-m', model: 'mistral-large' },
  }),
  untrimmed: settingsOf({
    openai: { apiKey: ' k-o ', model: 'gpt-6', baseUrl: ' https://proxy.example.com/v1 ' },
  }),
  hostile: settingsOf({ toString: { apiKey: 'k', model: 'x' } }),
  nullish: settingsOf({
    openai: null,
    mistral: { apiKey: null, model: 'm' },
    deepseek: { model: 'm' },
    glm: 5,
  }),
  numericKey: settingsOf({ openai: { apiKey: 5, model: 'm' } }),
  numericBase: settingsOf({ openai: { apiKey: 'k', model: 'm', baseUrl: 5 } }),
}

const LIST_OPENAI = jsonOf({
  data: [
    { id: 'gpt-6', created: 1700000000 },
    { id: 'gpt-5', created: 1700000001 },
  ],
})
const LIST_MISTRAL = jsonOf({ data: [{ id: 'mistral-large' }, { id: 'mistral-small' }] })

interface RefreshOpts {
  settings: unknown
  steps: unknown[][]
  lists?: { after?: number; answer?: unknown; reject?: string }[]
  readFails?: boolean
  writeFails?: boolean
}

const refresher: Group = {
  'key-model-refresh.createKeyModelRefresher': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        setUp()
        const opts = o as RefreshOpts
        let file: Any = structuredClone(opts.settings)
        let calls = 0
        const deps: Any = {
          read: () => {
            if (opts.readFails) throw new Error('read failed')
            return file
          },
          write: (update: (latest: Any) => Any) => {
            if (opts.writeFails) throw new Error('write failed')
            const next = update(file)
            cx.log('write', next === file ? 'same' : 'changed')
            file = next
          },
        }
        const lists = opts.lists
        if (lists) {
          deps.list = async (provider: string, config: Any) => {
            const spec = lists[calls++] ?? {}
            cx.log('list', provider, config.apiKey, config.baseUrl ?? null)
            if (spec.after) await sleep(spec.after)
            if (spec.reject) throw new Error(spec.reject)
            return spec.answer ?? null
          }
        }
        const refresher = refresh.createKeyModelRefresher(deps)
        for (const step of opts.steps) {
          if (step[0] === 'refresh') refresher.refreshChanged()
          else if (step[0] === 'idle') await refresher.idle()
          else if (step[0] === 'sleep') await sleep(step[1] as number)
          else if (step[0] === 'set') file.providers[step[1] as string][step[2] as string] = step[3]
        }
        await refresher.idle()
        return file
      }),
    cases: [
      c(w([LIST_OPENAI, LIST_MISTRAL]), { settings: SETS.two, steps: [['refresh']] }),
      c(w([LIST_OPENAI, LIST_MISTRAL]), {
        settings: SETS.two,
        steps: [['refresh'], ['idle'], ['refresh']],
      }),
      c(w([]), { settings: SETS.both, steps: [['refresh']], lists: [{ answer: ['m-1', 'm-2'] }] }),
      c(w([]), {
        settings: SETS.both,
        steps: [['refresh'], ['idle'], ['set', 'anthropic', 'apiKey', 'k-a2'], ['refresh']],
        lists: [{ answer: ['a-1'] }, { answer: ['o-1'] }, { answer: ['a-2'] }],
      }),
      c(w([]), {
        settings: SETS.both,
        steps: [['refresh'], ['set', 'openai', 'apiKey', 'k-new'], ['refresh']],
        lists: [
          { after: 50, answer: ['a-1'] },
          { after: 100, answer: ['o-old'] },
          { after: 10, answer: ['o-new'] },
        ],
      }),
      c(w([]), {
        settings: SETS.one,
        steps: [['refresh'], ['set', 'openai', 'apiKey', 'k-new'], ['idle']],
        lists: [{ after: 20, answer: ['stale'] }],
      }),
      c(w([]), {
        settings: SETS.one,
        steps: [
          ['refresh'],
          ['idle'],
          ['set', 'openai', 'apiKey', ''],
          ['refresh'],
          ['set', 'openai', 'apiKey', 'k-o'],
          ['refresh'],
        ],
        lists: [{ answer: ['o-1'] }, { answer: ['o-2'] }],
      }),
      c(w([]), {
        settings: SETS.one,
        steps: [
          ['refresh'],
          ['idle'],
          ['set', 'openai', 'baseUrl', 'https://b.example.com/v1'],
          ['refresh'],
        ],
        lists: [{ answer: ['o-1'] }, { answer: ['o-2'] }],
      }),
      c(w([]), {
        settings: SETS.stored,
        steps: [['refresh']],
        lists: [{ answer: { models: ['n-1'], efforts: { 'n-1': { efforts: ['high'] } } } }],
      }),
      c(w([]), {
        settings: SETS.stored,
        steps: [['refresh']],
        lists: [{ answer: ['n-1', 'n-2'] }],
      }),
      c(w([]), {
        settings: SETS.stored,
        steps: [['refresh']],
        lists: [{ answer: { models: ['n-1'], efforts: {} } }],
      }),
      c(w([]), {
        settings: SETS.stored,
        steps: [['refresh']],
        lists: [{ answer: null }],
      }),
      c(w([]), { settings: SETS.stored, steps: [['refresh']], lists: [{ reject: 'boom' }] }),
      c(w([]), {
        settings: SETS.same,
        steps: [['refresh']],
        lists: [{ answer: ['gpt-6', 'gpt-5'] }],
      }),
      c(w([]), { settings: SETS.same, steps: [['refresh']], lists: [{ answer: [] }] }),
      c(w([]), { settings: SETS.same, steps: [['refresh']], lists: [{ answer: ['  ', 7] }] }),
      c(w([]), {
        settings: SETS.one,
        steps: [['refresh']],
        readFails: true,
        lists: [{ answer: ['x'] }],
      }),
      c(w([]), {
        settings: SETS.one,
        steps: [['refresh']],
        writeFails: true,
        lists: [{ answer: ['x'] }],
      }),
      c(w([]), { settings: SETS.untrimmed, steps: [['refresh']], lists: [{ answer: ['x'] }] }),
      c(w([]), { settings: SETS.nullish, steps: [['refresh']], lists: [{ answer: ['x'] }] }),
      c(w([]), { settings: SETS.hostile, steps: [['refresh']], lists: [{ answer: ['x'] }] }),
      c(w([]), { settings: SETS.numericKey, steps: [['refresh']], lists: [{ answer: ['x'] }] }),
      c(w([]), { settings: SETS.numericBase, steps: [['refresh']], lists: [{ answer: ['x'] }] }),
      c(w([LIST_OPENAI]), { settings: SETS.one, steps: [['refresh'], ['idle']] }),
      c(w([jsonOf({}, 401)]), { settings: SETS.one, steps: [['refresh']] }),
      c(w([hang]), { settings: SETS.one, steps: [['refresh']] }),
    ],
  },
  'key-model-refresh.withKeyProviderModels': {
    ts: ([settings, provider, models, ...rest]) => {
      const r = refresh.withKeyProviderModels(
        settings as Any,
        provider as Any,
        models as Any,
        rest.length > 0 ? (rest[0] as Any) : undefined,
      )
      return { unchanged: r === settings, settings: r }
    },
    cases: [
      c(SETS.stored, 'openai', ['n-1', 'n-2']),
      c(SETS.stored, 'openai', ['n-1'], { 'n-1': { efforts: ['high'], defaultEffort: 'high' } }),
      c(SETS.stored, 'openai', ['old-1', 'old-2']),
      c(SETS.stored, 'openai', ['old-1', 'old-2'], { 'old-1': { efforts: ['low'] } }),
      c(SETS.stored, 'openai', ['old-1', 'old-2'], {}),
      c(SETS.stored, 'openai', [], null),
      c(SETS.stored, 'openai', []),
      c(SETS.same, 'openai', ['gpt-6', 'gpt-5']),
      c(SETS.same, 'openai', ['gpt-6', 'gpt-5'], { 'gpt-6': { efforts: ['low', 'bogus'] } }),
      c(SETS.same, 'openai', ['gpt-6', 'gpt-5', 'gpt-6', ' gpt-5 ']),
      c(SETS.same, 'openai', []),
      c(SETS.same, 'mistral', ['a']),
      c(SETS.same, 'openai', [7, null, '', ' ok ']),
      c(settingsOf({ openai: { apiKey: 'k', models: 'abc' } }), 'openai', ['a']),
      c(settingsOf({ openai: { apiKey: 'k', models: ['a', null, 3] } }), 'openai', ['a', '3']),
      c(settingsOf({ openai: { apiKey: 'k', models: ['a'], modelEfforts: 5 } }), 'openai', ['a']),
      c(settingsOf({ openai: 'text' }), 'openai', ['a']),
      c(settingsOf({ openai: 0 }), 'openai', ['a']),
      c(settingsOf({ openai: { models: ['a'] } }, { keep: true }), 'openai', ['b']),
      c({ provider: 'x' }, 'openai', ['a']),
    ],
  },
  'key-model-refresh.withStoredKeyModels': {
    ts: ([next, stored]) => refresh.withStoredKeyModels(next as Any, stored as Any),
    cases: [
      c(SETS.one, SETS.stored),
      c(SETS.stored, SETS.one),
      c(
        settingsOf({
          custom: {
            apiKey: 'k',
            model: 'm',
            models: ['sent'],
            modelEfforts: { m: { efforts: ['low'] } },
          },
          openai: {
            apiKey: 'k',
            model: 'm',
            models: ['sent'],
            modelEfforts: { m: { efforts: ['low'] } },
          },
        }),
        settingsOf({
          custom: {
            apiKey: 'k',
            model: 'm',
            models: ['s'],
            modelEfforts: { s: { efforts: ['high'] } },
          },
          openai: {
            apiKey: 'k',
            model: 'm',
            models: ['s'],
            modelEfforts: { s: { efforts: ['high'] } },
          },
        }),
      ),
      c(settingsOf({ openai: null, mistral: { apiKey: 'k' } }), SETS.stored),
      c({ provider: 'x' }, SETS.stored),
    ],
  },
  'key-model-refresh.withStoredMainFields': {
    ts: ([next, stored]) => refresh.withStoredMainFields(next as Any, stored as Any),
    cases: [
      c(SETS.one, { ...SETS.stored, subscriptionOff: { 'claude-code': true } }),
      c(SETS.one, SETS.stored),
      c({ ...SETS.one, subscriptionOff: { codex: true } }, SETS.stored),
      c({ ...SETS.one, subscriptionOff: { codex: true } }, { ...SETS.stored, subscriptionOff: {} }),
    ],
  },
}

// ---------------------------------------------------------------------------
// custom-models.ts
// ---------------------------------------------------------------------------

interface CustomOpts {
  baseUrl: string
  apiKey?: string
}

const customCases: Case[] = [
  c(
    w([
      jsonOf({
        data: [
          { id: 'llama3:8b' },
          { id: ' qwen3 ' },
          { id: 'llama3:8b' },
          { id: '' },
          { id: '   ' },
          { id: 7 },
          { name: 'x' },
          null,
          'str',
          [1],
          { id: 'z' },
        ],
      }),
    ]),
    { baseUrl: 'http://localhost:11434/v1' },
  ),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), {
    baseUrl: ' http://localhost:11434/v1/// ',
    apiKey: ' secret ',
  }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: 'http://localhost:11434/v1', apiKey: '   ' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: 'http://localhost:11434' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: '' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: ' / ' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: 'not a url' }),
  c(w([jsonOf({ data: [{ id: 'm' }] })]), { baseUrl: 'http://localhost:11434/v1?x=1#frag' }),
  c(w([jsonOf({}, 500)]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf({}, 401)]), { baseUrl: 'http://localhost:11434/v1', apiKey: 'bad' }),
  c(w([raw(['nope'])]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf({ data: {} })]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf({ models: [] })]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf(null)]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf([{ id: 'a' }])]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf('text')]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([jsonOf({ data: [] })]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([raw(['{"data":[{"id":"m"}]}'], 200, [['content-length', '3000000']])]), {
    baseUrl: 'http://localhost:11434/v1',
  }),
  c(w([jsonOf({ data: [{ id: 'm' }] }, 503)]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([raw([{ hex: '7b2264617461223a5b' }, 'x'.repeat(10)], 200)]), {
    baseUrl: 'http://localhost:11434/v1',
  }),
  c(w([down]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([hang]), { baseUrl: 'http://localhost:11434/v1' }),
  c(w([redirect(302, 'http://other.example.com/models')]), {
    baseUrl: 'http://localhost:11434/v1',
  }),
  c(w([jsonOf({ data: [{ id: 'm' }] })], { abortAt: 0 }), { baseUrl: 'http://localhost:11434/v1' }),
  c(
    w([
      jsonOf({
        data: Array.from({ length: 2300 }, (_, i) => ({ id: `id-${i}` })),
      }),
    ]),
    { baseUrl: 'https://gw.example.com/v1', apiKey: 'k' },
  ),
  c(
    w([
      jsonOf({
        data: [
          ...Array.from({ length: 1999 }, (_, i) => ({ id: `id-${i}` })),
          { id: 7 },
          { id: 'last' },
          { id: 'over' },
        ],
      }),
    ]),
    { baseUrl: 'https://gw.example.com/v1' },
  ),
]

const custom: Group = {
  'custom-models.listCustomModels': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        setUp()
        const opts = o as CustomOpts
        return customModels.listCustomModels(opts.baseUrl, opts.apiKey)
      }),
    cases: customCases,
  },
  'custom-models.listCustomModelsForIpc': {
    ts: ([world, input], cx) =>
      inWorld(world as World, cx, async () => {
        setUp()
        return customModels.listCustomModelsForIpc(input)
      }),
    cases: [
      c(w([jsonOf({ data: [{ id: 'a' }] })]), { baseUrl: 'http://localhost:1/v1', apiKey: 'k' }),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), { baseUrl: 'http://localhost:1/v1', apiKey: 5 }),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), { baseUrl: 5, apiKey: 'k' }),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), { apiKey: 'k' }),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), null),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), 'http://localhost:1/v1'),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), ['http://localhost:1/v1']),
      c(w([jsonOf({ data: [{ id: 'a' }] })]), 42),
      c(w([jsonOf({ data: [{ id: 'a' }] })])),
    ],
  },
}

// ---------------------------------------------------------------------------
// local-models.ts
// ---------------------------------------------------------------------------

const BASE = 'http://localhost:11434/v1'
const TAGS = jsonOf({
  models: [
    {
      name: 'llama3:8b',
      size: 4661224676,
      details: { parameter_size: '8.0B', quantization_level: 'Q4_0' },
    },
    { name: ' qwen3:8b ', size: -1, details: { parameter_size: ' ', quantization_level: 7 } },
    { name: 'llama3:8b' },
    { name: '' },
    { name: 5 },
    'bad',
    null,
    { name: 'tiny', size: 0, details: 'x' },
    { name: 'inf', size: Number('1e999') },
  ],
})
const MODELS = jsonOf({
  data: [{ id: 'a' }, { id: ' b ' }, { id: 'a' }, { id: '' }, { id: 3 }, 'x', null],
})
const NO_ROUTE = jsonOf({ error: 'not found' }, 404)
const html = raw(['<html>hello</html>'], 200, [['content-type', 'text/html']])

interface LocalOpts {
  request: Any
  signal?: boolean
}

const listLocal: Case[] = [
  c(w([TAGS]), { request: { baseUrl: BASE } }),
  c(w([TAGS]), { request: { baseUrl: ` ${BASE}/// `, apiKey: ' key ' } }),
  c(w([TAGS]), { request: { baseUrl: 'http://localhost:11434/v1/?x=1#h', apiKey: '' } }),
  c(w([TAGS]), { request: { baseUrl: 'http://localhost:11434' } }),
  c(w([TAGS]), { request: { baseUrl: 'http://localhost:11434/proxy/v1' } }),
  c(w([TAGS]), { request: { baseUrl: 'https://u:p@host.example.com:8443/V1/' } }),
  c(w([NO_ROUTE, MODELS]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, MODELS]), { request: { baseUrl: BASE, apiKey: 'k' } }),
  c(w([html, MODELS]), { request: { baseUrl: BASE } }),
  c(w([jsonOf({ models: 'x' }), MODELS]), { request: { baseUrl: BASE } }),
  c(w([jsonOf([]), MODELS]), { request: { baseUrl: BASE } }),
  c(w([down, MODELS]), { request: { baseUrl: BASE } }),
  c(w([hang, MODELS]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, jsonOf({ data: [] })]), { request: { baseUrl: BASE } }),
  c(w([TAGS]), { request: { baseUrl: '' } }),
  c(w([TAGS]), { request: { baseUrl: 'localhost:11434' } }),
  c(w([TAGS]), { request: { baseUrl: 'ftp://localhost' } }),
  c(w([TAGS]), { request: { baseUrl: '///' } }),
  // which failure says more about the address
  c(w([NO_ROUTE, jsonOf({}, 500)]), { request: { baseUrl: BASE } }),
  c(w([jsonOf({}, 500), NO_ROUTE]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, NO_ROUTE]), { request: { baseUrl: BASE } }),
  c(w([jsonOf({}, 401), jsonOf({}, 403)]), { request: { baseUrl: BASE } }),
  c(w([jsonOf({}, 403), jsonOf({}, 401)]), { request: { baseUrl: BASE } }),
  c(w([html, NO_ROUTE]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, html]), { request: { baseUrl: BASE } }),
  c(w([html, hang]), { request: { baseUrl: BASE } }),
  c(w([hang, html]), { request: { baseUrl: BASE } }),
  c(w([hang, NO_ROUTE]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, hang]), { request: { baseUrl: BASE } }),
  c(w([hang, hang]), { request: { baseUrl: BASE } }),
  c(w([down, down]), { request: { baseUrl: BASE } }),
  c(w([down, NO_ROUTE]), { request: { baseUrl: BASE } }),
  c(w([NO_ROUTE, down]), { request: { baseUrl: BASE } }),
  c(w([jsonOf({}, 503), hang]), { request: { baseUrl: BASE } }),
  c(w([raw(['{"models":[{"name":"x"}]}'], 200, [['content-length', '9999999']]), MODELS]), {
    request: { baseUrl: BASE },
  }),
  c(w([raw(['{"models":[{"name":"x"}]}'], 200, [['content-length', '9999999']]), NO_ROUTE]), {
    request: { baseUrl: BASE },
  }),
  c(w([redirect(302, 'http://elsewhere.example.com/api/tags'), MODELS]), {
    request: { baseUrl: BASE },
  }),
  c(w([jsonOf({ models: Array.from({ length: 2100 }, (_, i) => ({ name: `m${i}` })) })]), {
    request: { baseUrl: BASE },
  }),
  c(w([NO_ROUTE, jsonOf({ data: Array.from({ length: 2100 }, (_, i) => ({ id: `m${i}` })) })]), {
    request: { baseUrl: BASE },
  }),
  // a cancelled caller
  c(w([hang, MODELS], { abortAt: 100 }), { request: { baseUrl: BASE }, signal: true }),
  c(w([NO_ROUTE, hang], { abortAt: 100 }), { request: { baseUrl: BASE }, signal: true }),
  c(w([TAGS], { abortAt: 100 }), { request: { baseUrl: BASE }, signal: true }),
  c(w([NO_ROUTE, MODELS], { abortAt: 0 }), { request: { baseUrl: BASE }, signal: true }),
  c(w([TAGS]), { request: { baseUrl: BASE }, signal: true }),
]

const SHOW = jsonOf({
  capabilities: ['completion', 'tools', 'vision', 'thinking'],
  thinking: { values: ['high', 'low', 'bogus', 'low'], default: 'high' },
  model_info: {
    'general.architecture': 'llama',
    'llama.context_length': 8192,
    'x.context_length': 1,
  },
})
const PS = jsonOf({
  models: [
    { name: 'other', context_length: 1 },
    { name: 'a', model: 'llama3:8b', context_length: 4096 },
    7,
  ],
})

const inspectCases: Case[] = [
  c(w([SHOW, PS]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([SHOW, PS]), { baseUrl: BASE, model: ' llama3:8b ', server: 'ollama', apiKey: 'k' }),
  c(w([]), { baseUrl: BASE, model: 'x', server: 'openai-compatible' }),
  c(w([]), { baseUrl: 'localhost:1', model: 'x', server: 'ollama' }),
  c(w([]), { baseUrl: '', model: 'x' }),
  c(w([TAGS, SHOW, PS]), { baseUrl: BASE, model: 'llama3:8b' }),
  c(w([NO_ROUTE]), { baseUrl: BASE, model: 'x' }),
  c(w([jsonOf({}, 405)]), { baseUrl: BASE, model: 'x' }),
  c(w([jsonOf({}, 500)]), { baseUrl: BASE, model: 'x' }),
  c(w([jsonOf({}, 401)]), { baseUrl: BASE, model: 'x' }),
  c(w([html]), { baseUrl: BASE, model: 'x' }),
  c(w([jsonOf({ models: 'x' })]), { baseUrl: BASE, model: 'x' }),
  c(w([hang]), { baseUrl: BASE, model: 'x' }),
  c(w([down]), { baseUrl: BASE, model: 'x' }),
  c(w([TAGS, jsonOf({}, 500)]), { baseUrl: BASE, model: 'x' }),
  c(w([TAGS, html]), { baseUrl: BASE, model: 'x' }),
  c(w([TAGS, jsonOf([1])]), { baseUrl: BASE, model: 'x' }),
  c(w([jsonOf({}), PS]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([jsonOf({ capabilities: [] }), PS]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([jsonOf({ capabilities: ['tools'] }), PS]), {
    baseUrl: BASE,
    model: 'llama3:8b',
    server: 'ollama',
  }),
  c(w([jsonOf({ capabilities: ['thinking'] }), PS]), {
    baseUrl: BASE,
    model: 'zzz',
    server: 'ollama',
  }),
  c(w([jsonOf({ capabilities: 'tools' }), PS]), { baseUrl: BASE, model: 'zzz', server: 'ollama' }),
  c(
    w([jsonOf({ capabilities: ['thinking'], thinking: { values: ['low'], default: 'high' } }), PS]),
    { baseUrl: BASE, model: 'zzz', server: 'ollama' },
  ),
  c(w([jsonOf({ thinking: { values: [] } }), PS]), {
    baseUrl: BASE,
    model: 'zzz',
    server: 'ollama',
  }),
  c(w([jsonOf({ thinking: { values: ['bogus'] }, capabilities: ['x'] }), PS]), {
    baseUrl: BASE,
    model: 'zzz',
    server: 'ollama',
  }),
  c(
    w([
      jsonOf({ thinking: 'x', model_info: { 'a.context_length': 0, 'b.context_length': 5 } }),
      PS,
    ]),
    {
      baseUrl: BASE,
      model: 'zzz',
      server: 'ollama',
    },
  ),
  c(w([jsonOf({ model_info: { '2.context_length': 7, 'a.context_length': 5 } }), PS]), {
    baseUrl: BASE,
    model: 'zzz',
    server: 'ollama',
  }),
  c(w([jsonOf({ model_info: { context_length: 9, 'a.context_length': 'x' } }), PS]), {
    baseUrl: BASE,
    model: 'zzz',
    server: 'ollama',
  }),
  c(w([jsonOf({ model_info: [1] }), PS]), { baseUrl: BASE, model: 'zzz', server: 'ollama' }),
  c(w([SHOW]), { baseUrl: BASE, model: '   ', server: 'ollama' }),
  c(w([SHOW, jsonOf({}, 404)]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([SHOW, jsonOf({ models: 'x' })]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([SHOW, jsonOf({ models: [{ name: 'llama3:8b', context_length: -1 }] })]), {
    baseUrl: BASE,
    model: 'llama3:8b',
    server: 'ollama',
  }),
  c(w([SHOW, jsonOf({ models: [{ model: 'llama3:8b', context_length: 2048 }] })]), {
    baseUrl: BASE,
    model: 'llama3:8b',
    server: 'ollama',
  }),
  c(w([SHOW, hang]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([SHOW, down]), { baseUrl: BASE, model: 'llama3:8b', server: 'ollama' }),
  c(w([jsonOf({}, 404)]), { baseUrl: BASE, model: 'x', server: 'ollama' }),
  c(w([raw(['{"a":'])]), { baseUrl: BASE, model: 'x', server: 'ollama' }),
  c(w([raw(['{"a":1}'], 200, [['content-length', '9999999']])]), {
    baseUrl: BASE,
    model: 'x',
    server: 'ollama',
  }),
]

const localModelsGroup: Group = {
  'local-models.listLocalModels': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const opts = o as LocalOpts
        return localModels.listLocalModels(opts.request, opts.signal ? { signal } : undefined)
      }),
    cases: listLocal,
  },
  'local-models.inspectLocalModel': {
    ts: ([world, request], cx) =>
      inWorld(world as World, cx, async () => {
        setUp()
        return localModels.inspectLocalModel(request as Any)
      }),
    cases: inspectCases,
  },
}

// ---------------------------------------------------------------------------
// local-test.ts
// ---------------------------------------------------------------------------

const TEST_INPUT = { baseUrl: BASE, model: 'llama3:8b' }
const CHAT_OK = jsonOf({ choices: [{ message: { content: 'pong' } }] })
const TOOL_STREAM = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'seuoffice_probe', arguments: '{"ok":true}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  },
])
const TEXT_STREAM = sse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }])
const WRONG_TOOL = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'other_tool', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  },
])
const CUT_TOOL = sse(
  [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'seuoffice_probe', arguments: '{"ok":true}' },
              },
            ],
          },
        },
      ],
    },
  ],
  false,
)
const GOOD = [TAGS, CHAT_OK, TOOL_STREAM]
const MODELS_B = jsonOf({ data: [{ id: 'llama3:8b' }, { id: 'other' }] })

interface TestOpts {
  input: unknown
  signal?: 'world' | 'aborted'
}

const testCases: Case[] = [
  c(w(GOOD), { input: TEST_INPUT }),
  c(w([NO_ROUTE, MODELS_B, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, apiKey: ' key ' } }),
  c(w([NO_ROUTE, MODELS, CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([NO_ROUTE, MODELS, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, typed: true } }),
  c(w([NO_ROUTE, MODELS_B, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, typed: true } }),
  c(w([jsonOf({ models: [] }), CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([NO_ROUTE, jsonOf({ data: [] }), CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([down, down, CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([jsonOf({}, 401), jsonOf({}, 401), CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([html, NO_ROUTE, CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([hang, hang, CHAT_OK, TOOL_STREAM]), { input: TEST_INPUT }),
  // the chat check
  c(w([TAGS, jsonOf({ error: 'boom' }, 500), TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, raw(['<html>'], 200), TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, jsonOf({ choices: [{ message: { content: '   ' } }] }), TOOL_STREAM]), {
    input: TEST_INPUT,
  }),
  c(w([TAGS, jsonOf({}), TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, jsonOf({ choices: [{ message: { content: ' ok ' } }] }), TOOL_STREAM]), {
    input: TEST_INPUT,
  }),
  c(w([TAGS, down, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, hang, TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, jsonOf({}, 404), TOOL_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, raw(['x'], 200, [['content-length', '9999999']]), TOOL_STREAM]), {
    input: TEST_INPUT,
  }),
  // the tool check
  c(w([TAGS, CHAT_OK, TEXT_STREAM]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, WRONG_TOOL]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, CUT_TOOL]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, jsonOf({ error: 'nope' }, 401)]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, down]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, hang]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK, raw(['not json at all'], 200, JSON_TYPE)]), { input: TEST_INPUT }),
  c(
    w([
      TAGS,
      CHAT_OK,
      jsonOf({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 't', function: { name: 'seuoffice_probe', arguments: '{"ok":true}' } },
              ],
            },
          },
        ],
      }),
    ]),
    { input: TEST_INPUT },
  ),
  c(w([TAGS, CHAT_OK, jsonOf({ choices: [{ message: { content: 'hi' } }] })]), {
    input: TEST_INPUT,
  }),
  c(w([TAGS, CHAT_OK, sse([{ error: { message: 'model crashed' } }])]), { input: TEST_INPUT }),
  c(w([TAGS, CHAT_OK]), { input: TEST_INPUT }),
  // the budget
  c(w([hang, hang, hang]), { input: { ...TEST_INPUT, timeoutMs: 60000 } }),
  c(w([TAGS, hang, hang]), { input: { ...TEST_INPUT, timeoutMs: 100 } }),
  c(w([TAGS, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, timeoutMs: 999999 } }),
  c(w([TAGS, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, timeoutMs: 61234.6 } }),
  c(w([TAGS, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, timeoutMs: 'soon' } }),
  c(w([TAGS, CHAT_OK, TOOL_STREAM]), { input: { ...TEST_INPUT, timeoutMs: null } }),
  c(w([hang, jsonOf({}, 500), hang]), { input: { ...TEST_INPUT, timeoutMs: 60000 } }),
  // a cancelled test
  c(w([hang, MODELS, CHAT_OK, TOOL_STREAM], { abortAt: 100 }), {
    input: TEST_INPUT,
    signal: 'world',
  }),
  c(w([TAGS, hang, TOOL_STREAM], { abortAt: 100 }), { input: TEST_INPUT, signal: 'world' }),
  c(w([TAGS, CHAT_OK, hang], { abortAt: 100 }), { input: TEST_INPUT, signal: 'world' }),
  c(w(GOOD, { abortAt: 100 }), { input: TEST_INPUT, signal: 'world' }),
  c(w(GOOD), { input: TEST_INPUT, signal: 'aborted' }),
  c(w(GOOD), { input: TEST_INPUT, signal: 'world' }),
  // input the four checks cannot run against
  c(w(GOOD), { input: null }),
  c(w(GOOD), { input: 'x' }),
  c(w(GOOD), { input: [] }),
  c(w(GOOD), { input: { baseUrl: BASE } }),
  c(w(GOOD), { input: { model: 'm' } }),
  c(w(GOOD), { input: { baseUrl: 'localhost:11434', model: 'm' } }),
  c(w(GOOD), { input: { baseUrl: `http://h.example/${'a'.repeat(2048)}`, model: 'm' } }),
  c(w(GOOD), { input: { baseUrl: BASE, model: 'm'.repeat(257) } }),
  c(w(GOOD), { input: { baseUrl: BASE, model: 'm'.repeat(256) } }),
  c(w(GOOD), { input: { baseUrl: `http://h.example/${'a'.repeat(2031)}`, model: 'm' } }),
  c(w(GOOD), { input: { baseUrl: BASE, model: '   ' } }),
  c(w(GOOD), { input: { baseUrl: BASE, model: 5 } }),
  c(w(GOOD), { input: { ...TEST_INPUT, apiKey: 5 } }),
  c(w(GOOD), { input: { ...TEST_INPUT, apiKey: null } }),
  c(w(GOOD), { input: { ...TEST_INPUT, apiKey: 'k'.repeat(8193) } }),
  c(w(GOOD), { input: { ...TEST_INPUT, typed: 'yes' } }),
]

const localTestGroup: Group = {
  'local-test.testLocalModel': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        const opts = o as TestOpts
        let given: AbortSignal | undefined
        if (opts.signal === 'world') given = signal
        if (opts.signal === 'aborted') {
          const controller = new AbortController()
          controller.abort()
          given = controller.signal
        }
        return localTest.testLocalModel(opts.input as Any, given ? { signal: given } : undefined)
      }),
    cases: testCases,
  },
}

// ---------------------------------------------------------------------------
// local-ipc.ts
// ---------------------------------------------------------------------------

const ipcParse =
  (name: 'parseLocalDiscoveryInput' | 'parseLocalInspectionInput' | 'parseLocalTestInput') =>
  ([raw]: unknown[]) =>
    localIpc[name](raw)

const baseCases: unknown[] = [
  { baseUrl: BASE },
  { baseUrl: ` ${BASE}/// `, apiKey: ' key ' },
  { baseUrl: BASE, apiKey: '' },
  { baseUrl: BASE, apiKey: '   ' },
  { baseUrl: BASE, apiKey: 5 },
  { baseUrl: BASE, apiKey: null },
  { baseUrl: BASE, apiKey: 'k'.repeat(8192) },
  { baseUrl: BASE, apiKey: 'k'.repeat(8193) },
  { baseUrl: BASE, apiKey: ` ${'k'.repeat(8192)} ` },
  { baseUrl: 'localhost:11434' },
  { baseUrl: 'ftp://host' },
  { baseUrl: `http://h.example/${'a'.repeat(2048)}` },
  { baseUrl: `http://h.example/${'a'.repeat(2020)}` },
  { baseUrl: `http://h.example/${'a'.repeat(2031)}` },
  { baseUrl: '' },
  { baseUrl: 5 },
  {},
  null,
  [],
  'text',
  5,
]

const inspectBase = { baseUrl: BASE, model: 'llama3:8b' }
const testBase = { baseUrl: BASE, model: 'llama3:8b' }

const ipcWorld =
  (body: (run: WorldRun, signal: AbortSignal, input: Any) => Promise<unknown>) =>
  ([world, input]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      setUp()
      return body(run, signal, input)
    })

interface IpcTestOpts {
  input?: unknown
  owner?: string | number
  abort?: boolean
  second?: { input: unknown; owner?: string | number; at?: number }
  cancel?: { input: unknown; owner?: string | number; at?: number }
}

/** the tests and the cancel of a case, side by side in the world */
async function ipcScenario(signal: AbortSignal, opts: IpcTestOpts): Promise<unknown[]> {
  const start = (input: unknown, owner: string | number | undefined, aborts: boolean) =>
    localIpc.testLocalModelForIpc(input, {
      ...(owner !== undefined ? { owner } : {}),
      ...(aborts ? { signal } : {}),
    })
  const jobs: Promise<unknown>[] = []
  if (opts.input !== undefined) jobs.push(start(opts.input, opts.owner, opts.abort === true))
  if (opts.second) {
    const second = opts.second
    jobs.push(
      (async () => {
        if (second.at) await sleep(second.at)
        return start(second.input, second.owner, false)
      })(),
    )
  }
  if (opts.cancel) {
    const cancel = opts.cancel
    jobs.push(
      (async () => {
        if (cancel.at) await sleep(cancel.at)
        return localIpc.cancelLocalTestForIpc(cancel.input, cancel.owner)
      })(),
    )
  }
  return Promise.all(jobs)
}

const ipcTestCases: Case[] = [
  c(w(GOOD), { input: testBase }),
  c(w(GOOD), { input: { ...testBase, testId: 'abc-1', typed: true, timeoutMs: 120000 } }),
  c(w(GOOD), { input: { ...testBase, apiKey: ' k ', testId: 'abc-1' }, owner: 7 }),
  c(w(GOOD), { input: { ...testBase, timeoutMs: 59999 } }),
  c(w(GOOD), { input: { ...testBase, timeoutMs: 600001 } }),
  c(w(GOOD), { input: { ...testBase, timeoutMs: 1.5 } }),
  c(w(GOOD), { input: { ...testBase, timeoutMs: '70000' } }),
  c(w(GOOD), { input: { ...testBase, typed: 1 } }),
  c(w(GOOD), { input: { ...testBase, testId: 'bad id' } }),
  c(w(GOOD), { input: { ...testBase, testId: '' } }),
  c(w(GOOD), { input: { ...testBase, testId: null } }),
  c(w(GOOD), { input: { ...testBase, testId: 'x'.repeat(129) } }),
  c(w(GOOD), { input: null }),
  c(w(GOOD), { input: { baseUrl: BASE } }),
  c(w(GOOD), { input: { ...testBase, apiKey: 5 } }),
  c(w(GOOD), { input: { ...testBase, model: 'm'.repeat(257) } }),
  // the card is closed: the window's own signal
  c(w([hang, MODELS, CHAT_OK, TOOL_STREAM], { abortAt: 100 }), {
    input: { ...testBase, testId: 't1' },
    abort: true,
  }),
  c(w(GOOD), { input: { ...testBase, testId: 't1' }, abort: true }),
  // the same id again replaces the earlier test
  c(w([hang, hang, hang, hang, TAGS, CHAT_OK, TOOL_STREAM]), {
    input: { ...testBase, testId: 'same' },
    owner: 1,
    second: { input: { ...testBase, testId: 'same' }, owner: 1, at: 50 },
  }),
  c(w([hang, TAGS, CHAT_OK, TOOL_STREAM, hang, TAGS, CHAT_OK, TOOL_STREAM]), {
    input: { ...testBase, testId: 'same' },
    owner: 1,
    second: { input: { ...testBase, testId: 'same' }, owner: 2, at: 50 },
  }),
]

const ipcCancelCases: Case[] = [
  c(w([hang, hang, hang, hang]), {
    input: { ...testBase, testId: 't1' },
    owner: 1,
    cancel: { input: { testId: 't1' }, owner: 1, at: 100 },
  }),
  c(w([hang, hang, hang, hang]), {
    input: { ...testBase, testId: 't1' },
    owner: 1,
    cancel: { input: 't1', owner: 1, at: 100 },
  }),
  c(w([hang, hang, hang, hang], { abortAt: 5000 }), {
    input: { ...testBase, testId: 't1' },
    owner: 1,
    cancel: { input: { testId: 't1' }, owner: 2, at: 100 },
  }),
  c(w([hang, hang, hang, hang], { abortAt: 5000 }), {
    input: { ...testBase, testId: 't1' },
    cancel: { input: { testId: 't1' }, owner: 1, at: 100 },
  }),
  c(w([hang, hang, hang, hang], { abortAt: 5000 }), {
    input: { ...testBase, testId: 't1' },
    owner: 'win-1',
    cancel: { input: { testId: 't2' }, owner: 'win-1', at: 100 },
  }),
  c(w(GOOD), {
    input: { ...testBase, testId: 't1' },
    owner: 1,
    cancel: { input: { testId: 't1' }, owner: 1, at: 100000 },
  }),
  c(w([hang, hang, hang, hang], { abortAt: 5000 }), {
    input: { ...testBase, testId: 't1' },
    owner: 1,
    cancel: { input: { testId: 'bad id' }, owner: 1, at: 100 },
  }),
  c(w([]), { cancel: { input: { testId: 't1' } } }),
  c(w([]), { cancel: { input: null } }),
  c(w([]), { cancel: { input: 5 } }),
  c(w([]), { cancel: { input: { testId: 5 } } }),
  c(w([]), { cancel: { input: [] } }),
  c(w([]), { cancel: { input: { testId: 'ok' }, owner: 'x' } }),
]

const ipc: Group = {
  'local-ipc.parseLocalDiscoveryInput': {
    ts: ipcParse('parseLocalDiscoveryInput'),
    cases: baseCases.map((raw) => c(raw)),
  },
  'local-ipc.parseLocalInspectionInput': {
    ts: ipcParse('parseLocalInspectionInput'),
    cases: [
      ...baseCases.map((raw) =>
        c(
          raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...raw, model: 'm' }
            : raw,
        ),
      ),
      c(inspectBase),
      c({ ...inspectBase, server: 'ollama' }),
      c({ ...inspectBase, server: 'openai-compatible' }),
      c({ ...inspectBase, server: 'vllm' }),
      c({ ...inspectBase, server: null }),
      c({ ...inspectBase, server: 5 }),
      c({ ...inspectBase, model: ' padded ' }),
      c({ ...inspectBase, model: '' }),
      c({ ...inspectBase, model: 'm'.repeat(256) }),
      c({ ...inspectBase, model: 'm'.repeat(257) }),
      c({ ...inspectBase, model: 5 }),
      c({ baseUrl: BASE }),
    ],
  },
  'local-ipc.parseLocalTestInput': {
    ts: ipcParse('parseLocalTestInput'),
    cases: [
      ...baseCases.map((raw) =>
        c(
          raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...raw, model: 'm' }
            : raw,
        ),
      ),
      c(testBase),
      c({ ...testBase, typed: true }),
      c({ ...testBase, typed: false }),
      c({ ...testBase, typed: 'true' }),
      c({ ...testBase, typed: null }),
      c({ ...testBase, timeoutMs: 60000 }),
      c({ ...testBase, timeoutMs: 600000 }),
      c({ ...testBase, timeoutMs: 59999 }),
      c({ ...testBase, timeoutMs: 600001 }),
      c({ ...testBase, timeoutMs: 90000.5 }),
      c({ ...testBase, timeoutMs: '90000' }),
      c({ ...testBase, timeoutMs: null }),
      c({ ...testBase, testId: 'abc_DEF-123' }),
      c({ ...testBase, testId: 'has space' }),
      c({ ...testBase, testId: 'x'.repeat(128) }),
      c({ ...testBase, testId: 'x'.repeat(129) }),
      c({ ...testBase, testId: 5 }),
      c({ ...testBase, testId: null }),
      c({ ...testBase, apiKey: ' k ', typed: true, timeoutMs: 100000, testId: 'id' }),
      c({ ...testBase, model: '' }),
    ],
  },
  'local-ipc.listLocalModelsForIpc': {
    ts: ipcWorld((_run, _signal, input) => localIpc.listLocalModelsForIpc(input)),
    cases: [
      c(w([TAGS]), { baseUrl: BASE }),
      c(w([NO_ROUTE, MODELS]), { baseUrl: BASE, apiKey: ' k ' }),
      c(w([TAGS]), { baseUrl: 'localhost:11434' }),
      c(w([TAGS]), { baseUrl: BASE, apiKey: 5 }),
      c(w([TAGS]), null),
      c(w([TAGS]), 'text'),
      c(w([down, down]), { baseUrl: BASE }),
    ],
  },
  'local-ipc.inspectLocalModelForIpc': {
    ts: ipcWorld((_run, _signal, input) => localIpc.inspectLocalModelForIpc(input)),
    cases: [
      c(w([SHOW, PS]), { ...inspectBase, server: 'ollama' }),
      c(w([TAGS, SHOW, PS]), inspectBase),
      c(w([]), { ...inspectBase, server: 'openai-compatible' }),
      c(w([NO_ROUTE]), inspectBase),
      c(w([]), { ...inspectBase, server: 'vllm' }),
      c(w([]), { ...inspectBase, model: '' }),
      c(w([]), { baseUrl: BASE }),
      c(w([]), []),
      c(w([hang]), inspectBase),
    ],
  },
  'local-ipc.testLocalModelForIpc': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        return ipcScenario(signal, o as IpcTestOpts)
      }),
    cases: ipcTestCases,
  },
  'local-ipc.cancelLocalTestForIpc': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        setUp()
        return ipcScenario(signal, o as IpcTestOpts)
      }),
    cases: ipcCancelCases,
  },
}

export const group: Group = {
  ...keyEffortGroup,
  ...modelIds,
  ...listings,
  ...refresher,
  ...custom,
  ...localModelsGroup,
  ...localTestGroup,
  ...ipc,
}
