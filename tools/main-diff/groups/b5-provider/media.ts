/**
 * Group `b5-provider`, part `media` (Rust: crates/main-core/src/calls/b5_provider/media.rs):
 * packages/ai-provider/src/media-protocols.ts. Names are
 * `media-protocols.<export>`.
 *
 * An async function runs in the scripted world of world.ts (its first
 * argument). `o` is what the call is given: `provider`, `config` (`apiKey`
 * and `imageModel`/`analysisModel` default to `sk-test` and `''`; `baseUrl`
 * when given), `input` (`prompt`, `aspectRatio`, `transparent`, `references`;
 * `media`, `requirements`) and `noSignal` (the call is made without the
 * caller's signal). A blob is `{ mime, hex, pad, name }`: the bytes of `hex`
 * followed by `pad` bytes of 0x61. A blob answers `{ mime, length, hex }`,
 * `hex` the first 256 bytes.
 *
 * `tldts` has no Rust: both sides answer `getDomain` from one tiny table
 * (an IP address or a name of one label has no domain; `co.uk` and, with
 * `allowPrivateDomains`, `github.io` are suffixes; any other name's suffix
 * is its last label), so the check of a FLUX polling address is compared
 * over the same answers. The real list is engine-waiting.
 */
import '../../electron-fake.ts'
import { registerHooks } from 'node:module'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type World } from './world.ts'

const TLDTS = 'main-diff:tldts'
const TLDTS_SOURCE = `
export function getDomain(host, options) {
  if (/^\\d+(\\.\\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return null
  const labels = host.toLowerCase().split('.')
  const tail = labels.slice(-2).join('.')
  const suffix = tail === 'co.uk' || (options?.allowPrivateDomains && tail === 'github.io') ? 2 : 1
  return labels.length <= suffix ? null : labels.slice(-(suffix + 1)).join('.')
}
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'tldts') return { url: TLDTS, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === TLDTS) return { format: 'module', source: TLDTS_SOURCE, shortCircuit: true }
    return next(url, context)
  },
})

// loaded after the hooks are registered: a static import would resolve before them
const media = await import('../../../../packages/ai-provider/src/media-protocols.ts')
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface BlobSpec {
  mime: string
  hex?: string
  pad?: number
  name?: string
}

interface Opts {
  provider?: string
  config?: { apiKey?: string; baseUrl?: string; imageModel?: string; analysisModel?: string }
  input?: {
    prompt?: string
    aspectRatio?: string
    transparent?: boolean
    references?: BlobSpec[]
    media?: BlobSpec[]
    requirements?: string
  }
  noSignal?: boolean
}

function blobOf(b: BlobSpec): Any {
  return {
    bytes: new Uint8Array(
      Buffer.concat([Buffer.from(b.hex ?? '', 'hex'), Buffer.alloc(b.pad ?? 0, 0x61)]),
    ),
    mime: b.mime,
    ...(b.name !== undefined ? { name: b.name } : {}),
  }
}

function configOf(o: Opts): Any {
  const c = o.config ?? {}
  return {
    apiKey: c.apiKey ?? 'sk-test',
    imageModel: c.imageModel ?? '',
    analysisModel: c.analysisModel ?? '',
    ...(c.baseUrl !== undefined ? { baseUrl: c.baseUrl } : {}),
  }
}

function blobAnswer(blob: { bytes: Uint8Array; mime: string }): unknown {
  return {
    mime: blob.mime,
    length: blob.bytes.length,
    hex: Buffer.from(blob.bytes.subarray(0, 256)).toString('hex'),
  }
}

/** a call in the world, over the module state a fresh process has */
function run<T>(
  world: unknown,
  cx: TsContext,
  body: (signal: AbortSignal | undefined) => Promise<T>,
  noSignal: boolean,
): Promise<T> {
  return inWorld(world as World, cx, async (_run, signal) => {
    fetchMod.setRescueFetch(null)
    fetchMod.setAiFetch(null)
    fetchMod.setAiUserAgent('')
    fetchMod.setAiTransientRetryDelays(null)
    return body(noSignal ? undefined : signal)
  })
}

const c = (...args: unknown[]): Case => ({ args })

// ---------------------------------------------------------------------------
// bytes and base64 (pure)
// ---------------------------------------------------------------------------

const PNG = '89504e470d0a1a0a0001'
const JPG = 'ffd8ffe000104a46'
const GIF = '47494638396101'
const WEBP = '52494646240000005745425056503820'
const RAW = '0102030405060708090a'
const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')

const pure: Group = {
  'media-protocols.bytesToBase64': {
    ts: ([hex]) => media.bytesToBase64(new Uint8Array(Buffer.from(hex as string, 'hex'))),
    cases: [c(''), c('00'), c('0102'), c('010203'), c(PNG), c('fbff'), c('ffffff'), c('4d616e')],
  },
  'media-protocols.base64ToBytes': {
    ts: ([text]) => Buffer.from(media.base64ToBytes(text as string)).toString('hex'),
    cases: [
      c(''),
      c('AQID'),
      c('AQI='),
      c('AQ=='),
      c('AQ'),
      c('A'),
      c('-_8='),
      c('+/8='),
      c('AQ ID\n'),
      c('AQ=ID'),
      c('!!AQID!!'),
      c(b64(PNG)),
      c('=AQID'),
    ],
  },
  'media-protocols.sniffImageMime': {
    ts: ([hex, fallback]) =>
      media.sniffImageMime(
        new Uint8Array(Buffer.from(hex as string, 'hex')),
        fallback as string | undefined,
      ),
    cases: [
      c(PNG),
      c(PNG, 'x/fb'),
      c('89504e470d0a1a0a', 'x/fb'),
      c('89504e470d0a1a0a00', 'x/fb'),
      c('89504e0000000000000000', 'x/fb'),
      c('89504f470d0a1a0a00', 'x/fb'),
      c('895047', 'x/fb'),
      c(JPG, 'x/fb'),
      c('ffd8ff', 'x/fb'),
      c('ffd8ffe0', 'x/fb'),
      c('ffd8', 'x/fb'),
      c('ffd9ffe0', 'x/fb'),
      c(GIF, 'x/fb'),
      c('474946383961', 'x/fb'),
      c('47494600000000', 'x/fb'),
      c('474a46383961', 'x/fb'),
      c(WEBP, 'x/fb'),
      c('52494646240000005745425056', 'x/fb'),
      c('524946462400000057454250', 'x/fb'),
      c('5249464624000000574542', 'x/fb'),
      c('52494646240000005745425a56503820', 'x/fb'),
      c('00000000000000004142435056503820', 'x/fb'),
      c(RAW),
      c(RAW, 'image/bmp'),
      c(''),
      c('', ''),
      c(RAW, ''),
    ],
  },
}

// ---------------------------------------------------------------------------
// the world's answers
// ---------------------------------------------------------------------------

const reply = (body: Chunk[] | null, headers: [string, string][] = [], status = 200) => ({
  status,
  headers,
  body,
})
const json = (value: unknown, status = 200, headers: [string, string][] = []) =>
  reply([JSON.stringify(value)], headers, status)
const bytes = (hex: string, type = 'image/png') => reply([{ hex }], [['content-type', type]])
const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World

const html403 = reply(
  [
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Error code: 1020 Ray ID: 0123456789abcdef</body></html>',
  ],
  [['content-type', 'text/html']],
  403,
)
const apiError = json({ error: { message: 'Invalid API key' } }, 401)
const longBody = reply(['x'.repeat(600)], [], 500)
const hang = { hang: true }

const PNG_B64 = b64(PNG)
const png = { mime: 'image/png', hex: PNG }
const jpg = { mime: 'image/jpeg', hex: JPG, name: 'photo.jpg' }

const g = (provider: string, world: World, input: Opts['input'], config: Opts['config'] = {}) =>
  c(world, { provider, config, input })

// ---------------------------------------------------------------------------
// generateImageWithProvider
// ---------------------------------------------------------------------------

const BFL_QUEUED = { id: 'job 1/2', polling_url: 'https://api.bfl.ai/v1/get_result?id=job1' }
const READY = json({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/out.png' } })
const PENDING = json({ status: 'Pending' })

const openai: Case[] = [
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'a cat',
    aspectRatio: '1:1',
  }),
  g('openai', w([json({ data: [{ b64_json: b64(JPG) }] })]), {
    prompt: 'a cat',
    aspectRatio: '16:9',
  }),
  g('openai', w([json({ data: [{ b64_json: b64(RAW) }] })]), { prompt: 'a cat' }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '21:9' }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: 'auto' }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '' }),
  g(
    'openai',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: '3:4' },
    { apiKey: '' },
  ),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', transparent: true }),
  g(
    'openai',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', transparent: true },
    { imageModel: 'GPT-Image-1.5' },
  ),
  g(
    'openai',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', transparent: true },
    { imageModel: 'dall-e-3' },
  ),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'p',
    aspectRatio: 'constructor',
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'p',
    aspectRatio: '__proto__',
  }),
  g(
    'openai',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p' },
    { baseUrl: 'https://gw.example.com/openai/v1/?api-version=2' },
  ),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p' }, { baseUrl: '' }),
  g(
    'openai',
    w([json({ data: [{ url: 'https://cdn.example.com/a.png' }] }), bytes(PNG, 'image/jpeg')]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/a.bin' }] }),
      bytes(RAW, 'application/octet-stream'),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([json({ data: [{ url: 'https://cdn.example.com/a.bin' }] }), reply([{ hex: RAW }])]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ b64_json: '', url: 'https://cdn.example.com/a.webp' }] }),
      bytes(WEBP, 'image/png'),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/gone.png' }] }),
      json({ error: 'expired' }, 404),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([{ hex: PNG }], [['content-length', '60000000']]),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([{ hex: PNG }], [['content-length', '52428800']]),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([{ hex: PNG }], [['content-length', 'x']]),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([{ fill: 97, size: 52428800 }]),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([{ fill: 97, size: 52428801 }]),
    ]),
    { prompt: 'p' },
  ),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/big.png' }] }),
      reply([
        { fill: 97, size: 30000000 },
        { fill: 97, size: 22428801 },
      ]),
    ]),
    { prompt: 'p' },
  ),
  g('openai', w([json({ data: [{ url: 'https://cdn.example.com/big.png' }] }), reply(null)]), {
    prompt: 'p',
  }),
  g(
    'openai',
    w([
      json({ data: [{ url: 'https://cdn.example.com/slow.png' }] }),
      { reject: { message: 'socket hang up' } },
    ]),
    { prompt: 'p' },
  ),
  g('openai', w([json({ data: { 0: { b64_json: PNG_B64 } } })]), { prompt: 'p' }),
  g('openai', w([json({ data: 'abc' })]), { prompt: 'p' }),
  g('openai', w([json({ data: [] })]), { prompt: 'p' }),
  g('openai', w([json({})]), { prompt: 'p' }),
  g('openai', w([json([1, 2])]), { prompt: 'p' }),
  g('openai', w([reply(['7'])]), { prompt: 'p' }),
  g('openai', w([reply(['null'])]), { prompt: 'p' }),
  g('openai', w([reply(['<html><body>maintenance</body></html>'])]), { prompt: 'p' }),
  g('openai', w([reply(['{"data":[{"b64_json":"' + PNG_B64.slice(0, 8)])]), { prompt: 'p' }),
  g('openai', w([reply([''])]), { prompt: 'p' }),
  g('openai', w([apiError]), { prompt: 'p' }),
  g('openai', w([html403]), { prompt: 'p' }),
  g('openai', w([longBody]), { prompt: 'p' }),
  g('openai', w([reply(['{"error":"x"}'], [], 400)]), { prompt: 'p' }),
  g('openai', w([reply(null, [], 500)]), { prompt: 'p' }),
  g('openai', w([reply([{ fill: 120, size: 70000 }], [], 502)]), { prompt: 'p' }),
  g('openai', w([reply(['busy'], [], 503), json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'retry',
  }),
  g('openai', w([{ reject: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' } }]), {
    prompt: 'p',
  }),
  g('openai', w([hang]), { prompt: 'p' }),
  g('openai', w([hang], { abortAt: 5000 }), { prompt: 'p' }),
  c(w([hang], { abortAt: 5000 }), {
    provider: 'openai',
    config: {},
    input: { prompt: 'p' },
    noSignal: true,
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })], { abortAt: 0 }), { prompt: 'p' }),
  // edits: multipart
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'edit', references: [png] }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    aspectRatio: '4:3',
    transparent: true,
    references: [jpg, png],
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    aspectRatio: 'constructor',
    references: [{ mime: 'image/jpeg', hex: JPG }],
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    aspectRatio: '__proto__',
    references: [{ mime: 'IMAGE/PNG', hex: PNG }],
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    references: [
      { mime: 'noslash', hex: PNG },
      { mime: 'image/', hex: PNG, name: '' },
      { mime: 'a/b/c', hex: PNG },
    ],
  }),
  g('openai', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    references: [
      { mime: 'image/png', hex: PNG, name: 'écran.png' },
      { mime: 'image/\u00e9', hex: PNG },
    ],
  }),
  g('openai', w([apiError]), { prompt: 'edit', references: [png] }),
  g('openai', w([json({ data: [{ url: 'https://cdn.example.com/e.png' }] }), bytes(PNG)]), {
    prompt: 'edit',
    references: [png],
  }),
  g('openai', w([json({})]), { prompt: 'edit', references: [png] }),
  g('openai', w([reply(['busy'], [], 503), json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'edit',
    references: [png],
  }),
  g('openai', w([]), { prompt: 'p', references: [] }),
  // the other OpenAI-shaped vendors
  g('doubao', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p' }),
  g('doubao', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '21:9' }),
  g('doubao', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '5:4' }),
  g(
    'doubao',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: 'auto', transparent: true },
    { imageModel: 'gpt-image-x' },
  ),
  g('doubao', w([json({ data: [{ b64_json: PNG_B64 }] })]), {
    prompt: 'p',
    aspectRatio: '9:16',
    references: [png, jpg],
  }),
  g('doubao', w([apiError]), { prompt: 'p', references: [png] }),
  g('glm', w([json({ data: [{ url: 'https://cdn.example.com/g.png' }] }), bytes(PNG)]), {
    prompt: 'p',
    aspectRatio: '4:3',
  }),
  g('glm', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '21:9' }),
  g('glm', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: 'valueOf' }),
  g('glm', w([]), { prompt: 'p', references: [png] }),
  g('xai', w([json({ data: [{ b64_json: PNG_B64 }] })]), { prompt: 'p', aspectRatio: '16:9' }),
  g('xai', w([]), { prompt: 'p', references: [png] }),
  g(
    'custom',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: '2:3' },
    { baseUrl: 'https://gw.example.com/v1///', imageModel: 'my-image' },
  ),
  g(
    'custom',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', references: [png] },
    { baseUrl: 'http://localhost:8080', imageModel: 'my-image', apiKey: '' },
  ),
  g('custom', w([]), { prompt: 'p' }, { imageModel: 'my-image' }),
  g('custom', w([]), { prompt: 'p' }, { baseUrl: '', imageModel: 'my-image' }),
  g('custom', w([]), { prompt: 'p' }, { baseUrl: 'https://gw.example.com/v1' }),
  g('custom', w([]), { prompt: 'p' }, { baseUrl: 'not a url', imageModel: 'my-image' }),
]

const qwen: Case[] = [
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [
            { message: { content: [{ text: 'x' }, { image: 'https://cdn.example.com/q.png' }] } },
          ],
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p', aspectRatio: '16:9' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [{ message: { content: [{ image: 'https://cdn.example.com/q.png' }] } }],
        },
      }),
      bytes(JPG, 'image/png'),
    ]),
    { prompt: 'p' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [{ message: { content: [{ image: 'https://cdn.example.com/q.png' }] } }],
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p', aspectRatio: '21:9' },
    { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [{ message: { content: [{ image: 'https://cdn.example.com/q.png' }] } }],
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p', aspectRatio: '1:1' },
    { baseUrl: 'https://gw.example.com/ai/api/v1?token=1' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [{ message: { content: [{ image: 'https://cdn.example.com/q.png' }] } }],
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p', aspectRatio: 'constructor' },
    { baseUrl: 'https://gw.example.com' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: [{ message: { content: [{ image: 'https://cdn.example.com/q.png' }] } }],
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p', aspectRatio: '__proto__' },
  ),
  g('qwen', w([json({ code: 'InvalidApiKey', message: 'bad key' })]), { prompt: 'p' }),
  g('qwen', w([json({ code: 'Throttled' })]), { prompt: 'p' }),
  g('qwen', w([json({ code: '', output: {} })]), { prompt: 'p' }),
  g('qwen', w([json({ output: { choices: [{ message: { content: 'text only' } }] } })]), {
    prompt: 'p',
  }),
  g(
    'qwen',
    w([
      json({
        output: { choices: [{ message: { content: [{ image: 5 }, null, { text: 'x' }] } }] },
      }),
    ]),
    { prompt: 'p' },
  ),
  g(
    'qwen',
    w([
      json({
        output: {
          choices: { 0: { message: { content: [{ image: 'https://cdn.example.com/o.png' }] } } },
        },
      }),
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g('qwen', w([json({})]), { prompt: 'p' }),
  g('qwen', w([apiError]), { prompt: 'p' }),
  g('qwen', w([reply(['nope'])]), { prompt: 'p' }),
  g('qwen', w([]), { prompt: 'p', references: [png] }),
  g('qwen', w([]), { prompt: 'p' }, { baseUrl: 'ht!tp://bad' }),
]

const minimax: Case[] = [
  g('minimax', w([json({ data: { image_base64: [PNG_B64] }, base_resp: { status_code: 0 } })]), {
    prompt: 'p',
    aspectRatio: '21:9',
  }),
  g('minimax', w([json({ data: { image_base64: [PNG_B64] } })]), {
    prompt: 'p',
    aspectRatio: 'auto',
  }),
  g('minimax', w([json({ data: { image_base64: [PNG_B64] } })]), {
    prompt: 'p',
    aspectRatio: '5:4',
  }),
  g(
    'minimax',
    w([json({ data: { image_base64: [b64(JPG)] } })]),
    { prompt: 'p', aspectRatio: '3:4' },
    { baseUrl: 'https://gw.example.com/minimax/' },
  ),
  g('minimax', w([json({ data: { image_urls: ['https://cdn.example.com/m.png'] } }), bytes(PNG)]), {
    prompt: 'p',
  }),
  g(
    'minimax',
    w([
      json({ data: { image_base64: [], image_urls: ['https://cdn.example.com/m.png'] } }),
      bytes(WEBP, 'image/webp'),
    ]),
    { prompt: 'p' },
  ),
  g(
    'minimax',
    w([
      json({ data: { image_base64: ['', 'x'], image_urls: ['https://cdn.example.com/m.png'] } }),
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g('minimax', w([json({ data: { image_base64: 'QUJD' } })]), { prompt: 'p' }),
  g('minimax', w([json({ data: { image_urls: 'https://cdn.example.com/m.png' } })]), {
    prompt: 'p',
  }),
  g('minimax', w([json({ base_resp: { status_code: 1004, status_msg: 'login fail' } })]), {
    prompt: 'p',
  }),
  g('minimax', w([json({ base_resp: { status_code: 2013 } })]), { prompt: 'p' }),
  g('minimax', w([json({ base_resp: { status_code: '5' }, data: {} })]), { prompt: 'p' }),
  g('minimax', w([json({ base_resp: { status_code: 0 }, data: { image_base64: [] } })]), {
    prompt: 'p',
  }),
  g('minimax', w([json({ data: [] })]), { prompt: 'p' }),
  g('minimax', w([apiError]), { prompt: 'p' }),
  g('minimax', w([reply(['<html>x</html>'])]), { prompt: 'p' }),
  g('minimax', w([]), { prompt: 'p', references: [png] }),
]

const gemini: Case[] = [
  g(
    'gemini',
    w([
      json({
        candidates: [
          {
            content: {
              parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }],
            },
          },
        ],
      }),
    ]),
    { prompt: 'p', aspectRatio: '4:5' },
  ),
  g(
    'gemini',
    w([
      json({
        candidates: [
          { content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64(RAW) } }] } },
        ],
      }),
    ]),
    { prompt: 'p', aspectRatio: '1:1' },
  ),
  g(
    'gemini',
    w([json({ candidates: [{ content: { parts: [{ inlineData: { data: b64(RAW) } }] } }] })]),
    { prompt: 'p', aspectRatio: 'auto' },
  ),
  g(
    'gemini',
    w([
      json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: null, inline_data: { data: PNG_B64 } },
                { inlineData: { data: 5 } },
              ],
            },
          },
        ],
      }),
    ]),
    { prompt: 'p', aspectRatio: '7:5' },
  ),
  g(
    'gemini',
    w([
      json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: 5 } },
                { inlineData: { data: PNG_B64, mimeType: 'image/x-odd' } },
              ],
            },
          },
        ],
      }),
    ]),
    { prompt: 'p' },
  ),
  g(
    'gemini',
    w([json({ candidates: [{ content: { parts: [{ inlineData: { data: PNG_B64 } }] } }] })]),
    { prompt: 'edit', references: [png, jpg] },
    { baseUrl: 'https://gw.example.com/g/v1beta/' },
  ),
  g(
    'gemini',
    w([
      json({
        candidates: [
          {
            finishReason: 'SAFETY',
            content: { parts: [{ text: ' no ' }, { text: 'sorry' }, { notText: 1 }] },
          },
        ],
      }),
    ]),
    { prompt: 'p' },
  ),
  g(
    'gemini',
    w([
      json({
        promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
        candidates: [{ finishReason: 'SAFETY' }],
      }),
    ]),
    { prompt: 'p' },
  ),
  g(
    'gemini',
    w([
      json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'y'.repeat(300) }] } }],
      }),
    ]),
    { prompt: 'p' },
  ),
  g('gemini', w([json({ candidates: [{ finishReason: 5 }] })]), { prompt: 'p' }),
  g('gemini', w([json({ candidates: [{ content: { parts: 'nope' } }] })]), { prompt: 'p' }),
  g('gemini', w([json({ candidates: [] })]), { prompt: 'p' }),
  g(
    'gemini',
    w([json({ candidates: { 0: { content: { parts: [{ inlineData: { data: PNG_B64 } }] } } } })]),
    { prompt: 'p' },
  ),
  g('gemini', w([json({})]), { prompt: 'p' }),
  g('gemini', w([apiError]), { prompt: 'p' }),
  g('gemini', w([reply(['not json at all'])]), { prompt: 'p' }),
  g(
    'gemini',
    w([json({ predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: 'image/png' }] })]),
    { prompt: 'p', aspectRatio: '16:9' },
    { imageModel: 'imagen-4.0-generate-001' },
  ),
  g(
    'gemini',
    w([json({ predictions: [{ bytesBase64Encoded: b64(RAW), mimeType: 'image/webp' }] })]),
    { prompt: 'p', aspectRatio: '9:3' },
    { imageModel: 'imagen-4.0-fast' },
  ),
  g(
    'gemini',
    w([json({ predictions: [{ bytesBase64Encoded: b64(RAW), mimeType: '' }] })]),
    { prompt: 'p' },
    { imageModel: 'imagen-4.0-fast' },
  ),
  g(
    'gemini',
    w([json({ predictions: [{ bytesBase64Encoded: b64(RAW) }] })]),
    { prompt: 'p', references: [png] },
    { imageModel: 'imagen-3' },
  ),
  g(
    'gemini',
    w([json({ predictions: [{ bytesBase64Encoded: '' }] })]),
    { prompt: 'p' },
    { imageModel: 'imagen-3' },
  ),
  g(
    'gemini',
    w([json({ predictions: [{ mimeType: 'image/png' }] })]),
    { prompt: 'p' },
    { imageModel: 'imagen-3' },
  ),
  g('gemini', w([json({ predictions: [] })]), { prompt: 'p' }, { imageModel: 'imagen-3' }),
  g('gemini', w([apiError]), { prompt: 'p' }, { imageModel: 'imagen-3' }),
]

const stability: Case[] = [
  g('stability', w([bytes(PNG)]), { prompt: 'p', aspectRatio: '16:9' }),
  g(
    'stability',
    w([bytes(JPG, 'image/png')]),
    { prompt: 'p', aspectRatio: 'auto' },
    { imageModel: 'stable-image-core' },
  ),
  g(
    'stability',
    w([bytes(RAW, 'image/webp')]),
    { prompt: 'p', aspectRatio: '21:9' },
    { imageModel: 'stable-image-ultra' },
  ),
  g(
    'stability',
    w([bytes(RAW, 'image/webp')]),
    { prompt: 'p', aspectRatio: '2:3' },
    { imageModel: 'sd3.5-large' },
  ),
  g(
    'stability',
    w([bytes(PNG)]),
    { prompt: 'p', aspectRatio: '3:2' },
    { imageModel: 'sd3.5-large-turbo' },
  ),
  g(
    'stability',
    w([bytes(PNG)]),
    { prompt: 'p' },
    { imageModel: 'sd3.5-medium', baseUrl: 'https://gw.example.com/stab//' },
  ),
  g('stability', w([reply([{ hex: RAW }])]), { prompt: 'p' }),
  g('stability', w([reply([{ fill: 97, size: 52428800 }])]), { prompt: 'p' }),
  g('stability', w([reply([{ fill: 97, size: 52428801 }])]), { prompt: 'p' }),
  g('stability', w([reply([{ hex: PNG }], [['content-length', '99999999']])]), { prompt: 'p' }),
  g('stability', w([reply(null)]), { prompt: 'p' }),
  g('stability', w([json({ errors: ['content flagged'], name: 'content_moderation' }, 403)]), {
    prompt: 'p',
  }),
  g('stability', w([html403]), { prompt: 'p' }),
  g('stability', w([]), { prompt: 'p' }, { imageModel: 'sd3.5-xl' }),
  g('stability', w([]), { prompt: 'p' }, { imageModel: 'constructor' }),
  g('stability', w([]), { prompt: 'p', references: [png] }),
  g('stability', w([hang], { abortAt: 100 }), { prompt: 'p' }),
]

const BFL_ID = { id: 'job 1/2' }
const bfl: Case[] = [
  g('bfl', w([json(BFL_QUEUED), PENDING, READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '16:9' }),
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      json({ status: 'Ready', sample_url: 'https://delivery.bfl.ai/s.png' }),
      bytes(WEBP),
    ]),
    { prompt: 'p', aspectRatio: '9:16' },
  ),
  g(
    'bfl',
    w([
      json({ ...BFL_ID, polling_url: 'https://api.eu1.bfl.ai/v1/get_result?id=1' }),
      READY,
      bytes(PNG, 'image/png'),
    ]),
    { prompt: 'p', aspectRatio: '21:9' },
  ),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '1:1' }),
  g('bfl', w([json({}), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '1:100' }),
  g('bfl', w([json({ id: 5 }), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '100:1' }),
  g('bfl', w([json({ id: 'a&b=c', polling_url: '' }), READY, bytes(PNG)]), {
    prompt: 'p',
    aspectRatio: '16x9',
  }),
  g('bfl', w([json({ id: 'x', polling_url: 5 }), READY, bytes(PNG)]), {
    prompt: 'p',
    aspectRatio: '0:5',
  }),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), {
    prompt: 'p',
    aspectRatio: '9'.repeat(400) + ':' + '9'.repeat(400),
  }),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), {
    prompt: 'p',
    aspectRatio: '9'.repeat(400) + ':1',
  }),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '4:3\n' }),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: '٣:٤' }),
  g('bfl', w([json(BFL_ID), READY, bytes(PNG)]), { prompt: 'p', aspectRatio: 'auto' }),
  g(
    'bfl',
    w([json(BFL_ID), READY, bytes(PNG)]),
    { prompt: 'p', aspectRatio: '16:9' },
    { imageModel: 'flux-3-image' },
  ),
  g(
    'bfl',
    w([json(BFL_ID), READY, bytes(PNG)]),
    { prompt: 'p', aspectRatio: 'whatever' },
    { imageModel: 'flux-3-image' },
  ),
  g(
    'bfl',
    w([json(BFL_ID), READY, bytes(PNG)]),
    { prompt: 'p', aspectRatio: 'auto' },
    { imageModel: 'flux-3-image' },
  ),
  g(
    'bfl',
    w([json(BFL_ID), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://gw.example.com/bfl/', imageModel: 'flux-pro-1.1' },
  ),
  // polling address held to the provider's own
  g('bfl', w([json({ polling_url: 'https://evil.example.net/steal' })]), { prompt: 'p' }),
  g('bfl', w([json({ polling_url: 'http://api.bfl.ai/v1/get_result?id=1' })]), { prompt: 'p' }),
  g('bfl', w([json({ polling_url: 'https://api.bfl.ai.evil.com/x' })]), { prompt: 'p' }),
  g('bfl', w([json({ polling_url: 'https://evil.example.net:8443/x' })]), { prompt: 'p' }),
  g('bfl', w([json({ polling_url: 'https://' + 'h'.repeat(150) + '.example.net/x' })]), {
    prompt: 'p',
  }),
  g('bfl', w([json({ polling_url: 'not a url' })]), { prompt: 'p' }),
  g('bfl', w([json({ polling_url: '/v1/get_result?id=1' })]), { prompt: 'p' }),
  g(
    'bfl',
    w([json({ polling_url: 'https://bob.github.io/get' })]),
    { prompt: 'p' },
    { baseUrl: 'https://alice.github.io/bfl' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://alice.github.io/other' }), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://alice.github.io/bfl' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://api.eu.example.co.uk/get' }), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://gw.example.co.uk' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://other.co.uk/get' })]),
    { prompt: 'p' },
    { baseUrl: 'https://gw.example.co.uk' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://127.0.0.1:9/get' }), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://127.0.0.1:9' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://127.0.0.2/get' })]),
    { prompt: 'p' },
    { baseUrl: 'https://127.0.0.1' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://other/get' })]),
    { prompt: 'p' },
    { baseUrl: 'https://intranet' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://intranet/get' }), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://intranet' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://[::1]/get' }), READY, bytes(PNG)]),
    { prompt: 'p' },
    { baseUrl: 'https://[::1]' },
  ),
  g(
    'bfl',
    w([json({ polling_url: 'https://[::2]/get' })]),
    { prompt: 'p' },
    { baseUrl: 'https://[::1]' },
  ),
  g('bfl', w([]), { prompt: 'p' }, { baseUrl: 'nope' }),
  // the job
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      PENDING,
      json({ status: 'Pending' }),
      json({ status: 'Task not found' }),
      READY,
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g('bfl', w([json(BFL_QUEUED), json({})]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'Error' })]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'Failed' })]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'No Card Generated' })]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'Content Moderated' })]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'Request Moderated' })]), { prompt: 'p' }),
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      json({ status: 'ready' }),
      json({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/a.png' } }),
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g('bfl', w([json(BFL_QUEUED), json({ status: 'Ready' })]), { prompt: 'p' }),
  g(
    'bfl',
    w([json(BFL_QUEUED), json({ status: 'Ready', result: { sample: '' }, sample_url: '' })]),
    { prompt: 'p' },
  ),
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      json({ status: 'Ready', result: 'x', sample_url: 'https://delivery.bfl.ai/b.png' }),
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      json({ status: 'Ready', result: null, sample_url: 'https://delivery.bfl.ai/b.png' }),
      bytes(PNG),
    ]),
    { prompt: 'p' },
  ),
  g(
    'bfl',
    w([
      json(BFL_QUEUED),
      json({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/c.png' } }),
      json({ error: 'gone' }, 410),
    ]),
    { prompt: 'p' },
  ),
  g('bfl', w([json(BFL_QUEUED), reply(['x'], [], 500)]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), reply(['<html>x</html>'])]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), { reject: { message: 'poll failed' } }]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED)]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), PENDING, PENDING, PENDING], { abortAt: 2000 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), PENDING, PENDING, PENDING], { abortAt: 3000 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), PENDING, PENDING, PENDING], { abortAt: 1500 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), PENDING, PENDING, PENDING], { abortAt: 0 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), hang], { abortAt: 1600 }), { prompt: 'p' }),
  g('bfl', w([hang], { abortAt: 10 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), READY, hang], { abortAt: 5000 }), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), ...Array(405).fill(PENDING)]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), ...Array(5).fill(PENDING), READY, bytes(PNG)]), { prompt: 'p' }),
  g('bfl', w([json(BFL_QUEUED), READY, bytes(PNG)], { abortAt: 0 }), { prompt: 'p' }),
  g('bfl', w([apiError]), { prompt: 'p' }),
  g('bfl', w([html403]), { prompt: 'p' }),
  g('bfl', w([reply(['<html>x</html>'])]), { prompt: 'p' }),
  g('bfl', w([reply(['{"id":'])]), { prompt: 'p' }),
  g('bfl', w([]), { prompt: 'p', references: [png] }),
]

const microsoft: Case[] = [
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: '16:9' },
    { baseUrl: 'https://mai.example.com/' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: b64(JPG) }] })]),
    { prompt: 'p', aspectRatio: '1:1' },
    { baseUrl: 'https://mai.example.com', imageModel: 'MAI-Image-2.5' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: 'auto' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: '21:9' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'p', aspectRatio: '3:2' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([]),
    { prompt: 'p', aspectRatio: 'constructor' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([]),
    { prompt: 'p', aspectRatio: '__proto__', references: [png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'edit', references: [png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: PNG_B64 }] })]),
    { prompt: 'edit', aspectRatio: '16:9', references: [png, jpg, png, jpg, png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([]),
    { prompt: 'edit', references: [png, png, png, png, png, png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([apiError]),
    { prompt: 'edit', references: [png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ url: 'https://cdn.example.com/m.png' }] })]),
    { prompt: 'p' },
    { baseUrl: 'https://mai.example.com' },
  ),
  g(
    'microsoft',
    w([json({ data: [{ b64_json: '' }] })]),
    { prompt: 'edit', references: [png] },
    { baseUrl: 'https://mai.example.com' },
  ),
  g('microsoft', w([apiError]), { prompt: 'p' }, { baseUrl: 'https://mai.example.com' }),
  g('microsoft', w([reply(['oops'])]), { prompt: 'p' }, { baseUrl: 'https://mai.example.com' }),
  g('microsoft', w([]), { prompt: 'p' }),
  g('microsoft', w([]), { prompt: 'p' }, { baseUrl: '' }),
]

const dispatch: Case[] = [
  g('deepseek', w([]), { prompt: 'p' }),
  g('nope', w([]), { prompt: 'p' }),
  g('', w([]), { prompt: 'p' }),
  g('constructor', w([]), { prompt: 'p' }),
  g('codex', w([]), { prompt: 'p' }),
]

// ---------------------------------------------------------------------------
// analyzeMediaWithProvider
// ---------------------------------------------------------------------------

const chat = (content: unknown) => json({ choices: [{ message: { content } }] })
const a = (provider: string, world: World, input: Opts['input'], config: Opts['config'] = {}) =>
  c(world, { provider, config, input })
const video = { mime: 'video/mp4', hex: '0000001866747970', name: 'clip.mp4' }
const audio = { mime: 'audio/mpeg', hex: '494433' }
const reqs = 'describe it'

const GEMINI_LIMIT = 18 * 1024 * 1024
const bigVideo = { mime: 'video/mp4', hex: '00000018', pad: GEMINI_LIMIT - 4 }
const bigOver = { mime: 'video/mp4', hex: '00000018', pad: GEMINI_LIMIT - 3 }
const START = [
  [
    'x-goog-upload-url',
    'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1',
  ],
] as [string, string][]
const FILE_ACTIVE = json({
  file: {
    name: 'files/abc',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
    state: 'ACTIVE',
    mimeType: 'video/mp4',
  },
})
const FILE_PROCESSING = json({ file: { name: 'files/abc', state: 'PROCESSING' } })
const GEMINI_ANSWER = json({
  candidates: [{ content: { parts: [{ text: ' seen ' }, { text: 'it' }] } }],
})

const analyze: Group = {
  'media-protocols.analyzeMediaWithProvider': {
    ts: ([world, o], cx) => {
      const opts = o as Opts
      return run(
        world,
        cx,
        (signal) =>
          media.analyzeMediaWithProvider(
            opts.provider as Any,
            configOf(opts),
            {
              media: (opts.input?.media ?? []).map(blobOf),
              requirements: opts.input?.requirements ?? reqs,
            },
            signal,
          ),
        opts.noSignal === true,
      )
    },
    cases: [
      a('openai', w([chat('a cat')]), { media: [png] }),
      a(
        'openai',
        w([chat('a cat')]),
        { media: [png, jpg] },
        { analysisModel: 'gpt-x', baseUrl: 'https://gw.example.com/v1/' },
      ),
      a('openai', w([chat('  padded \n')]), { media: [], requirements: '' }),
      a('openai', w([chat([{ text: 'one ' }, { text: 'two' }, { type: 'image' }])]), {
        media: [png],
      }),
      a('openai', w([chat('')]), { media: [png] }),
      a('openai', w([chat('   ')]), { media: [png] }),
      a('openai', w([chat(null)]), { media: [png] }),
      a('openai', w([json({ choices: [] })]), { media: [png] }),
      a('openai', w([json({ choices: { 0: { message: { content: 'obj' } } } })]), { media: [png] }),
      a('openai', w([json({})]), { media: [png] }),
      a('openai', w([apiError]), { media: [png] }),
      a('openai', w([html403]), { media: [png] }),
      a('openai', w([reply(['plain'])]), { media: [png] }),
      a('openai', w([reply(['<html></html>'])]), { media: [png] }),
      a('openai', w([reply(['[1]'])]), { media: [png] }),
      a('openai', w([reply(['busy'], [], 503), chat('later')]), { media: [png] }),
      a('openai', w([hang], { abortAt: 1000 }), { media: [png] }),
      a('openai', w([hang]), { media: [png] }),
      a('openai', w([]), { media: [video] }),
      a('openai', w([]), { media: [png, { mime: 'video/webm', hex: '00' }] }),
      a('openai', w([]), { media: [audio] }),
      a('openai', w([]), { media: [{ mime: 'application/pdf', hex: '25504446', name: '' }] }),
      a('openai', w([]), { media: [{ mime: 'text/plain', hex: '41' }] }),
      a('deepseek', w([chat('ok')]), { media: [png] }),
      a('deepseek', w([]), { media: [video] }),
      a('doubao', w([chat('video seen')]), { media: [video, png] }),
      a('doubao', w([]), { media: [audio] }),
      a('glm', w([chat('ok')]), { media: [video] }),
      a('xai', w([]), { media: [video] }),
      a('qwen', w([chat('qwen sees')]), { media: [png] }),
      a(
        'qwen',
        w([chat('qwen sees')]),
        { media: [video] },
        { baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1/' },
      ),
      a('qwen', w([]), { media: [] }, { baseUrl: 'bad base' }),
      a('minimax', w([chat('mm')]), { media: [video] }),
      a(
        'custom',
        w([chat('c')]),
        { media: [png] },
        { baseUrl: 'https://gw.example.com/v1', analysisModel: 'm', apiKey: '' },
      ),
      a('custom', w([]), { media: [png] }, { analysisModel: 'm' }),
      a('custom', w([]), { media: [png] }, { baseUrl: 'https://gw.example.com/v1' }),
      a(
        'custom',
        w([]),
        { media: [video] },
        { baseUrl: 'https://gw.example.com/v1', analysisModel: 'm' },
      ),
      a('stability', w([]), { media: [png] }),
      a('bfl', w([]), { media: [png] }),
      a('microsoft', w([]), { media: [png] }, { baseUrl: 'https://mai.example.com' }),
      a('microsoft', w([]), { media: [png] }),
      a('nope', w([]), { media: [png] }),
      // Gemini, inline
      a('gemini', w([GEMINI_ANSWER]), { media: [png, video] }),
      a(
        'gemini',
        w([
          json({ candidates: [{ content: { parts: [{ text: 'a' }, { x: 1 }, { text: 'b' }] } }] }),
        ]),
        { media: [] },
        { baseUrl: 'https://gw.example.com/g/v1beta' },
      ),
      a('gemini', w([json({ candidates: [{ finishReason: 'SAFETY' }] })]), { media: [png] }),
      a('gemini', w([json({ promptFeedback: { blockReason: 'OTHER' } })]), { media: [png] }),
      a(
        'gemini',
        w([json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '  ' }] } }] })]),
        { media: [png] },
      ),
      a(
        'gemini',
        w([json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })]),
        { media: [png] },
        { analysisModel: 'gemini-x' },
      ),
      a('gemini', w([json({})]), { media: [png] }),
      a('gemini', w([apiError]), { media: [png] }),
      a('gemini', w([reply(['nope'])]), { media: [png] }),
      a('gemini', w([hang], { abortAt: 50 }), { media: [png] }),
      a('gemini', w([json({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })]), {
        media: [{ mime: 'video/mp4', hex: '00', pad: GEMINI_LIMIT - 1 }],
      }),
      a(
        'gemini',
        w([reply([], START), FILE_ACTIVE, reply([], START), FILE_ACTIVE, GEMINI_ANSWER]),
        {
          media: [
            { mime: 'video/mp4', hex: '00', pad: 1000 },
            { mime: 'video/mp4', hex: '00', pad: GEMINI_LIMIT - 1001 },
          ],
        },
      ),
      // Gemini, Files API
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { name: 'files/abc', uri: 'https://x/files/abc', state: 'ACTIVE' } }),
          reply([], START),
          FILE_ACTIVE,
          GEMINI_ANSWER,
        ]),
        { media: [bigVideo, png] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { name: 'files/abc', uri: 'https://x/files/abc', state: 'ACTIVE' } }),
          reply([], START),
          json({
            file: {
              name: 'files/def',
              uri: 'https://x/files/def',
              state: 'ACTIVE',
              mimeType: 'image/png',
            },
          }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver, png] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          FILE_PROCESSING,
          FILE_PROCESSING,
          json({ name: 'files/abc', state: 'PROCESSING' }),
          json({ name: 'files/abc', uri: 'https://x/f', state: 'ACTIVE', mimeType: 'video/mp4' }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([reply([], START), FILE_PROCESSING, json({ name: 'files/abc', state: 'FAILED' })]),
        { media: [bigOver] },
      ),
      a('gemini', w([reply([], START), FILE_PROCESSING, json({ error: 'gone' }, 404)]), {
        media: [bigOver],
      }),
      a('gemini', w([reply([], START), FILE_PROCESSING, reply(['<html>x</html>'])]), {
        media: [bigOver],
      }),
      a('gemini', w([reply([], START), json({ file: {} })]), { media: [bigOver] }),
      a('gemini', w([reply([], START), json({ file: { state: 'ACTIVE' } })]), { media: [bigOver] }),
      a('gemini', w([reply([], START), json({ file: { state: 'ACTIVE', uri: 5 } })]), {
        media: [bigOver],
      }),
      a('gemini', w([reply([], START), json({ file: { state: 'FAILED' } })]), { media: [bigOver] }),
      a('gemini', w([reply([], START), json({ file: { state: null, uri: 'https://x/f' } })]), {
        media: [bigOver],
      }),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { state: 'ACTIVE', uri: 'https://x/f', mimeType: null } }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { name: 'files/a b', state: 'PROCESSING' } }),
          json({ name: 'files/a b', uri: 'https://x/f', state: 'ACTIVE' }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { state: 'PROCESSING' } }),
          json({ state: 'ACTIVE', uri: 'https://x/f' }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { name: 'files/abc', state: 'PROCESSING' } }),
          ...Array(95).fill(json({ name: 'files/abc', state: 'PROCESSING' })),
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { name: 'files/abc', state: 'PROCESSING' } }),
          ...Array(80).fill(json({ name: 'files/abc', state: 'PROCESSING' })),
          json({ name: 'files/abc', state: 'ACTIVE', uri: 'https://x/f' }),
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([reply([], START), json({ file: { name: 'files/abc', state: 'PROCESSING' } }), hang], {
          abortAt: 2500,
        }),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w(
          [
            reply([], START),
            json({ file: { name: 'files/abc', state: 'PROCESSING' } }),
            json({ state: 'PROCESSING', name: 'files/abc' }),
          ],
          { abortAt: 1000 },
        ),
        { media: [bigOver] },
      ),
      a('gemini', w([reply([], [['x-goog-upload-url', 'https://evil.example.net/upload']])]), {
        media: [bigOver],
      }),
      a(
        'gemini',
        w([reply([], [['x-goog-upload-url', 'http://generativelanguage.googleapis.com/upload']])]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply(
            [],
            [['x-goog-upload-url', 'https://generativelanguage.googleapis.com:444/upload']],
          ),
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply([], [['x-goog-upload-url', 'https://' + 'h'.repeat(150) + '.example.net/upload']]),
        ]),
        { media: [bigOver] },
      ),
      a('gemini', w([reply([], [['x-goog-upload-url', 'not a url']])]), { media: [bigOver] }),
      a('gemini', w([reply([], [['x-goog-upload-url', '/upload/relative']])]), {
        media: [bigOver],
      }),
      a('gemini', w([reply([], [['x-goog-upload-url', 'data:text/plain,x']])]), {
        media: [bigOver],
      }),
      a('gemini', w([reply([], [])]), { media: [bigOver] }),
      a('gemini', w([reply([], [['x-goog-upload-url', '']])]), { media: [bigOver] }),
      a('gemini', w([apiError]), { media: [bigOver] }),
      a('gemini', w([reply([], START), apiError]), { media: [bigOver] }),
      a('gemini', w([reply([], START), reply(['not json'])]), { media: [bigOver] }),
      a(
        'gemini',
        w([
          reply([], START),
          json({ file: { state: 'ACTIVE', uri: 'https://x/f' } }),
          json({ candidates: [] }),
        ]),
        { media: [bigOver] },
      ),
      a(
        'gemini',
        w([
          reply(
            [],
            [['x-goog-upload-url', 'https://gw.example.com/google/upload/v1beta/files?id=1']],
          ),
          FILE_ACTIVE,
          GEMINI_ANSWER,
        ]),
        { media: [{ ...bigOver, name: 'big.mp4' }] },
        { baseUrl: 'https://gw.example.com/google/v1beta' },
      ),
      a(
        'gemini',
        w([
          reply([], [['x-goog-upload-url', 'https://gw.example.com/up']]),
          FILE_ACTIVE,
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
        { baseUrl: 'https://gw.example.com/google/v1/' },
      ),
      a(
        'gemini',
        w([
          reply([], [['x-goog-upload-url', 'https://gw.example.com/up']]),
          FILE_ACTIVE,
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
        { baseUrl: 'https://gw.example.com' },
      ),
      a(
        'gemini',
        w([
          reply([], [['x-goog-upload-url', 'https://gw.example.com/up']]),
          FILE_ACTIVE,
          GEMINI_ANSWER,
        ]),
        { media: [bigOver] },
        { baseUrl: 'https://gw.example.com/g/v1?key=1' },
      ),
      a('gemini', w([]), { media: [bigOver] }, { baseUrl: 'mailto:x@example.com/v1' }),
      a('gemini', w([]), { media: [bigOver] }, { baseUrl: 'bad base' }),
      a('gemini', w([]), { media: [] }, { baseUrl: 'bad base' }),
    ],
  },
}

// ---------------------------------------------------------------------------
// testMediaProvider
// ---------------------------------------------------------------------------

const t = (
  provider: string,
  world: World,
  config: Opts['config'] = {},
  extra: Partial<Opts> = {},
) => c(world, { provider, config, ...extra })
const BUSY = reply(['busy'], [], 503)
const RATE = reply(['slow down'], [], 429)

const testing: Group = {
  'media-protocols.testMediaProvider': {
    ts: ([world, o], cx) => {
      const opts = o as Opts
      return run(
        world,
        cx,
        (signal) => media.testMediaProvider(opts.provider as Any, configOf(opts), signal),
        opts.noSignal === true,
      )
    },
    cases: [
      t('openai', w([json({ data: [] })])),
      t('openai', w([json({ data: [] })]), { apiKey: '' }),
      t('openai', w([json({ data: [] })]), { baseUrl: 'https://gw.example.com/v1/' }),
      t('openai', w([reply(['x'], [], 404)])),
      t('openai', w([reply(['x'], [], 405)])),
      t('openai', w([apiError])),
      t('openai', w([reply(['x'], [], 403)])),
      t('openai', w([reply([], [], 401)])),
      t('openai', w([reply(null, [], 400)])),
      t('openai', w([html403])),
      t('openai', w([longBody])),
      t('openai', w([reply([{ fill: 120, size: 70000 }], [], 422)])),
      t('openai', w([RATE, RATE, RATE])),
      t('openai', w([reply([], [], 429), reply([], [], 429), reply([], [], 429)])),
      t('openai', w([reply(['teapot'], [], 418)])),
      t('openai', w([BUSY, BUSY, BUSY])),
      t('openai', w([reply([], [], 500), reply([], [], 500)])),
      t('openai', w([reply(['boom'], [], 500)])),
      t('openai', w([reply(['err'], [], 599)])),
      t('openai', w([BUSY, json({ data: [] })])),
      t(
        'openai',
        w([{ reject: { message: 'getaddrinfo ENOTFOUND api.openai.com', code: 'ENOTFOUND' } }]),
      ),
      t('openai', w([{ reject: { class: 'TypeError', message: 'fetch failed' } }])),
      t('openai', w([hang])),
      t('openai', w([hang], { abortAt: 5000 })),
      t('openai', w([hang], { abortAt: 5000 }), {}, { noSignal: true }),
      t('openai', w([hang], { abortAt: 30000 })),
      t('openai', w([json({ data: [] })], { abortAt: 0 })),
      t('openai', w([]), { baseUrl: 'bad base' }),
      t('qwen', w([json({ data: [] })])),
      t('qwen', w([reply(['x'], [], 404)]), {
        baseUrl: 'https://gw.example.com/compatible-mode/v1?x=1',
      }),
      t('deepseek', w([json({ data: [] })])),
      t('custom', w([json({ data: [] })]), { baseUrl: 'https://gw.example.com/v1' }),
      t('custom', w([])),
      t('custom', w([]), { baseUrl: '' }),
      t('gemini', w([json({ models: [] })])),
      t('gemini', w([json({ models: [] })]), {
        baseUrl: 'https://gw.example.com/google/v1beta/?key=1&pageSize=5&x=a%20b&pageSize=7',
      }),
      t('gemini', w([json({ models: [] })]), {
        baseUrl: 'https://gw.example.com/g?a=1+2&b=%E2%82%AC&c',
      }),
      t('gemini', w([json({ models: [] })]), {
        baseUrl: 'https://gw.example.com/g?x=1&pageSize=3',
      }),
      t('gemini', w([json({ models: [] })]), { baseUrl: 'https://gw.example.com/g?' }),
      t('gemini', w([json({ models: [] })]), { baseUrl: 'https://gw.example.com/g#frag' }),
      t('gemini', w([reply(['x'], [], 404)])),
      t('gemini', w([reply(['x'], [], 405)])),
      t('gemini', w([json({ error: { message: 'API key not valid' } }, 400)])),
      t('gemini', w([apiError])),
      t('gemini', w([]), { baseUrl: 'nope' }),
      t('bfl', w([json({ credits: 3 })])),
      t('bfl', w([json({ credits: 3 })]), { baseUrl: 'https://gw.example.com/bfl/' }),
      t('bfl', w([reply(['x'], [], 404)])),
      t('bfl', w([reply(['x'], [], 405)])),
      t('bfl', w([json({ detail: 'Not authenticated' }, 403)])),
      t('bfl', w([json({ detail: [{ msg: 'bad key' }] }, 422)])),
      t('bfl', w([html403])),
      t('microsoft', w([json({ data: [] })]), { baseUrl: 'https://mai.example.com/' }),
      t('microsoft', w([reply(['x'], [], 404)]), { baseUrl: 'https://mai.example.com' }),
      t('microsoft', w([apiError]), { baseUrl: 'https://mai.example.com' }),
      t('microsoft', w([]), {}),
      t('nope', w([])),
      t('', w([])),
      t('stability', w([json({ data: [] })])),
      t('stability', w([reply(['x'], [], 404)])),
      t('minimax', w([json({ data: [] })])),
      t('xai', w([json({ data: [] })])),
      t('doubao', w([reply(['x'], [], 401)])),
      t('glm', w([json({ data: [] })])),
    ],
  },
}

export const group: Group = {
  ...pure,
  'media-protocols.generateImageWithProvider': {
    ts: ([world, o], cx) => {
      const opts = o as Opts
      const input = opts.input ?? {}
      return run(
        world,
        cx,
        async (signal) =>
          blobAnswer(
            await media.generateImageWithProvider(
              opts.provider as Any,
              configOf(opts),
              {
                prompt: input.prompt ?? '',
                ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
                ...(input.transparent !== undefined ? { transparent: input.transparent } : {}),
                ...(input.references !== undefined
                  ? { references: input.references.map(blobOf) }
                  : {}),
              },
              signal,
            ),
          ),
        opts.noSignal === true,
      )
    },
    cases: [
      ...openai,
      ...qwen,
      ...minimax,
      ...gemini,
      ...stability,
      ...bfl,
      ...microsoft,
      ...dispatch,
    ],
  },
  ...analyze,
  ...testing,
}
