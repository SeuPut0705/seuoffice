/**
 * Group `b5-provider`, part `fetch` (Rust: crates/main-core/src/calls/b5_provider/fetch.rs):
 * packages/ai-provider/src/fetch.ts and protocols/shared.ts. Names are
 * `fetch.<export>` and `shared.<export>`.
 *
 * An async function runs in the scripted world of world.ts (its first
 * argument). `o` is what the call is given: `url`, `init` (`method`,
 * `headers` as a record, `body` a string or `bodyHex`, `redirect`), the
 * module state (`rescue`: a rescue fetch over `net`; `embed`: `setAiFetch`
 * over `embed`; `ua`; `delays`), `watch` (each resend logs `['resend',
 * why]`) and `base` (`ai`, `node`, `net`, `seeing` =
 * `fetchSeeingRedirects(net, node)`). A response answers `{ status, type,
 * text }`.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type Chunk, type World, type WorldRun } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')
const shared = await import('../../../../packages/ai-provider/src/protocols/shared.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Opts {
  url?: string
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    bodyHex?: string
    redirect?: RequestRedirect
  }
  rescue?: boolean
  embed?: boolean
  ua?: string
  delays?: number[] | null
  watch?: boolean
  base?: 'ai' | 'node' | 'net' | 'seeing'
  keyOutsideHeaders?: boolean
  maxBytes?: number
  truncate?: boolean
  onBytes?: boolean
}

const URL_A = 'https://api.example.com/v1/chat'

function setUp(run: WorldRun, o: Opts): void {
  fetchMod.setRescueFetch(o.rescue ? run.fetch('net') : null)
  fetchMod.setAiFetch(o.embed ? run.fetch('embed') : null)
  fetchMod.setAiUserAgent(o.ua ?? '')
  fetchMod.setAiTransientRetryDelays(o.delays ?? null)
}

function initOf(o: Opts, signal: AbortSignal): RequestInit {
  const i = o.init ?? {}
  const init: RequestInit = { signal }
  if (i.method !== undefined) init.method = i.method
  if (i.headers !== undefined) init.headers = { ...i.headers }
  if (i.body !== undefined) init.body = i.body
  if (i.bodyHex !== undefined) init.body = new Uint8Array(Buffer.from(i.bodyHex, 'hex'))
  if (i.redirect !== undefined) init.redirect = i.redirect
  return init
}

function baseOf(run: WorldRun, base: Opts['base']): Any {
  if (base === 'node') return run.fetch('node')
  if (base === 'net') return run.fetch('net')
  if (base === 'seeing') return fetchMod.fetchSeeingRedirects(run.fetch('net'), run.fetch('node'))
  return undefined
}

const watchOf = (o: Opts, cx: TsContext): Any =>
  o.watch ? { onResend: (why: string) => cx.log('resend', why) } : undefined

async function answer(r: Response): Promise<unknown> {
  return { status: r.status, type: r.type, text: await r.text() }
}

/** a fetch over Node's fetch in the world, then `read` of its response */
function withResponse(read: (r: Response, o: Opts, cx: TsContext) => Promise<unknown>) {
  return ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (_run, signal) => {
      const r = await fetch(URL_A, { signal })
      return read(r, (o ?? {}) as Opts, cx)
    })
}

const ok = (body: Chunk[] | null, headers: [string, string][] = [], status = 200) => ({
  status,
  headers,
  body,
})
const html403 = ok(['<html>blocked</html>'], [['content-type', 'text/html; charset=utf-8']], 403)
const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World
const c = (...args: unknown[]): Case => ({ args })

// ---------------------------------------------------------------------------
// protocols/shared.ts, the pure part
// ---------------------------------------------------------------------------

const pure: Group = {
  'shared.endpointUrl': {
    ts: ([base, path, search]) =>
      shared.endpointUrl(base as string, path as string, search as string | undefined),
    cases: [
      c('https://api.example.com/v1', 'chat/completions'),
      c('https://api.example.com/v1/', '/chat/completions'),
      c('https://api.example.com/v1///', '//models'),
      c('https://api.example.com', 'models'),
      c('https://api.example.com/v1?api-version=2024-01', 'chat'),
      c('https://api.example.com/v1#frag', 'chat'),
      c('https://api.example.com/v1?x=1', 'chat', ''),
      c('https://api.example.com/v1?x=1', 'chat', '?key=k'),
      c('https://api.example.com/v1', 'chat', 'alt=sse'),
      c('https://api.example.com/v1', ''),
      c('https://api.example.com/a b', 'c d'),
      c('not a url', 'chat'),
      c('', 'chat'),
      c('mailto:someone@example.com', 'x'),
      c('http://localhost:11434/v1/', 'chat/completions'),
    ],
  },
  'shared.openAiContentText': {
    ts: ([content]) => shared.openAiContentText(content),
    cases: [
      c('hello'),
      c(''),
      c([{ text: 'a' }, { text: 'b' }, { type: 'image' }, null, { text: 3 }]),
      c([]),
      c(null),
      c(5),
      c({ text: 'x' }),
    ],
  },
  'shared.sseErrorText': {
    ts: ([error, fallback]) => shared.sseErrorText(error, fallback as string),
    cases: [
      c('quota exhausted', 'fb'),
      c('', 'fb'),
      c({ message: 'bad gateway' }, 'fb'),
      c({ message: '', code: 1 }, 'fb'),
      c({ code: 'x' }, 'fb'),
      c(['a', 1], 'fb'),
      c(42, 'fb'),
      c(null, 'fb'),
      c(true, 'fb'),
    ],
  },
  'shared.usageCount': {
    ts: ([value]) => shared.usageCount(value) ?? null,
    cases: [
      c(12),
      c('34'),
      c(' 7 '),
      c(''),
      c('x'),
      c(-1),
      c(0),
      c(true),
      c(null),
      c(1.5),
      c('1e3'),
    ],
  },
  'shared.parseToolInput': {
    ts: ([json]) => shared.parseToolInput(json as string),
    cases: [
      c(''),
      c('   '),
      c('{"a":1,"b":[2]}'),
      c('[1,2]'),
      c('"text"'),
      c('{"note":"he said "hi" to me","n":1}'),
      c('{"a":'),
      c('{"a":"x\\"y"}'),
      c(`{"bad":${'x'.repeat(600)}}`),
      c('{"k":"한글 "따옴표" 문장"}'),
      c('null'),
    ],
  },
  'shared.throwIfCreditsNotice': {
    ts: ([body]) => shared.throwIfCreditsNotice(body as string),
    cases: [
      c('{"content":[{"text":"Your credits have been exhausted. Top up."}]}'),
      c('{"error":"Insufficient CREDIT balance"}'),
      c('{"a":"credit ok"}'),
      c('not json'),
      c('["x",["credits exhausted"]]'),
      c('"credit insufficient"'),
      c('{}'),
    ],
  },
  'shared.throwIfToolJsonOverBudget': {
    ts: ([n, provider]) => shared.throwIfToolJsonOverBudget(n as number, provider as string),
    cases: [c(512000, 'anthropic'), c(512001, 'anthropic'), c(0, 'x'), c(1e9, 'gemini')],
  },
  'shared.throwIfToolCountOverBudget': {
    ts: ([n, provider]) => shared.throwIfToolCountOverBudget(n as number, provider as string),
    cases: [c(100, 'openai'), c(101, 'openai'), c(1, 'x')],
  },
}

// ---------------------------------------------------------------------------
// protocols/shared.ts, the body readers
// ---------------------------------------------------------------------------

const readers: Group = {
  'shared.readCappedResponseText': {
    ts: withResponse((r, o, cx) =>
      shared.readCappedResponseText(r, {
        ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
        ...(o.truncate ? { onOverflow: 'truncate' as const } : {}),
        ...(o.onBytes ? { onBytes: () => cx.log('bytes') } : {}),
      }),
    ),
    cases: [
      c(w([ok(['hello ', 'world'])]), { onBytes: true }),
      c(w([ok(null)]), {}),
      c(w([ok([])]), {}),
      c(w([ok(['abc'], [['content-length', '100']])]), { maxBytes: 10 }),
      c(w([ok(['abc'], [['content-length', '100']])]), { maxBytes: 10, truncate: true }),
      c(w([ok(['abc'], [['content-length', 'x']])]), { maxBytes: 10 }),
      c(w([ok(['12345', '67890', 'abc'])]), { maxBytes: 8 }),
      c(w([ok(['12345', '67890', 'abc'])]), { maxBytes: 8, truncate: true, onBytes: true }),
      c(w([ok(['1234567890'])]), { maxBytes: 10, truncate: true }),
      c(w([ok([{ hex: 'ed959c' }, { hex: 'eab880' }])]), {}),
      c(w([ok([{ hex: 'ed95' }, { hex: '9ceab8' }])]), { maxBytes: 4, truncate: true }),
      c(w([ok([{ hex: 'ff41' }, { hex: 'e2' }])]), {}),
      c(w([ok([{ hex: 'efbbbf41' }])]), {}),
      c(w([ok(['a', 'b'])], { abortAt: 0 }), {}),
    ],
  },
  'shared.sseLines': {
    ts: withResponse(async (r, o, cx) => {
      const lines: string[] = []
      for await (const line of shared.sseLines(
        r.body!,
        o.onBytes ? () => cx.log('bytes') : undefined,
      ))
        lines.push(line)
      return lines
    }),
    cases: [
      c(w([ok(['data: a\n\ndata: b\n', 'data: c'])]), { onBytes: true }),
      c(w([ok(['par', 'tial\nline\r\n', '\n'])]), {}),
      c(w([ok([{ hex: '646174613a20ed95' }, { hex: '9c0a' }])]), {}),
      c(w([ok([{ hex: '41ed95' }])]), {}),
      c(w([ok([])]), {}),
      c(w([ok(['\n\n\n'])]), {}),
    ],
  },
  'shared.sseDataEvents': {
    ts: withResponse(async (r, o, cx) => {
      const events: unknown[] = []
      for await (const e of shared.sseDataEvents(
        r.body!,
        o.onBytes ? () => cx.log('bytes') : undefined,
      ))
        events.push([e.raw, e.json === undefined ? '<undefined>' : e.json])
      return events
    }),
    cases: [
      c(w([ok(['data: {"a":1}\n\ndata: [DONE]\n\n'])]), {}),
      c(w([ok(['data: {"a":\n', 'data: 1}\n\n'])]), {}),
      c(w([ok(['data: {"a":\nevent: x\ndata: 2\n'])]), { onBytes: true }),
      c(w([ok(['data: ping\ndata:   \ndata:{"b":[1]}\n'])]), {}),
      c(w([ok(['data: [1,\ndata: 2]\ndata: keep\n'])]), {}),
      c(w([ok(['data: {"x"\ndata: oops'])]), {}),
      c(w([ok([': comment\ndata: "str"\n'])]), {}),
    ],
  },
  'shared.jsonBodyInsteadOfSse': {
    ts: withResponse((r) => shared.jsonBodyInsteadOfSse(r)),
    cases: [
      c(w([ok(['{"a":1}'], [['content-type', 'Application/JSON; charset=utf-8']])]), {}),
      c(w([ok(['data: x'], [['content-type', 'text/event-stream']])]), {}),
      c(w([ok(['x'])]), {}),
    ],
  },
}

// ---------------------------------------------------------------------------
// fetch.ts
// ---------------------------------------------------------------------------

const BUSY = ok(['busy'], [], 503)
const RATE = ok(['slow down'], [], 429)
const FREE_DAY = ok(['Rate limit exceeded: free-models-per-day. Add credits'], [], 429)
const redirect = (status: number, location: string | null, body: string[] | null = ['moved']) => ({
  status,
  headers: location === null ? [] : [['location', location]],
  body,
})
const cancelled = { reject: { message: 'Redirect was cancelled' } }

const fetches: Group = {
  'fetch.withUserAgent': {
    ts: ([headers, ua]) => {
      fetchMod.setAiUserAgent(ua as string)
      try {
        const init = fetchMod.withUserAgent({
          method: 'POST',
          ...(headers === null ? {} : { headers: headers as Record<string, string> }),
        })
        return Object.entries(init.headers as Record<string, string>)
      } finally {
        fetchMod.setAiUserAgent('')
      }
    },
    cases: [
      c({ 'Content-Type': 'application/json' }, ''),
      c({ 'user-AGENT': 'mine' }, 'custom/1'),
      c(null, 'custom/2'),
      c({ b: '1', a: '2' }, ''),
    ],
  },
  'fetch.aiFetch': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = (o ?? {}) as Opts
        setUp(run, opts)
        return answer(
          await fetchMod.aiFetch(opts.url ?? URL_A, initOf(opts, signal), watchOf(opts, cx)),
        )
      }),
    cases: [
      c(w([ok(['fine'])]), {}),
      c(w([ok(['fine'])]), { init: { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{}' } }),
      c(w([BUSY, ok(['now'])]), { watch: true }),
      c(w([BUSY, BUSY, BUSY]), { watch: true }),
      c(w([BUSY, ok(['now'])]), { delays: [10, 20] }),
      c(w([BUSY, ok(['now'])]), { delays: [] }),
      c(w([RATE, ok(['now'])]), { delays: [5] }),
      c(w([FREE_DAY, ok(['no'])]), { delays: [5] }),
      c(w([ok(['x'], [['retry-after', '1']], 529), ok(['now'])]), {}),
      c(w([ok(['x'], [['retry-after', '30']], 503), ok(['now'])]), {}),
      c(w([ok(['x'], [['retry-after', 'Tue, 14 Nov 2023 22:13:30 GMT']], 503), ok(['now'])]), {}),
      c(w([ok(['x'], [['retry-after', 'soon']], 503), ok(['now'])]), { delays: [7] }),
      c(w([BUSY, ok(['now'])]), { init: { method: 'POST', bodyHex: '0102' } }),
      c(w([BUSY, ok(['now'])], { abortAt: 1000 }), {}),
      c(w([{ reject: { class: 'TypeError', message: 'fetch failed' } }, ok(['rescued'])]), {
        rescue: true,
        watch: true,
      }),
      c(w([{ reject: { class: 'TypeError', message: 'fetch failed' } }]), {}),
      c(w([{ reject: { message: 'boom' } }, { reject: { message: 'rescue down' } }]), {
        rescue: true,
      }),
      c(w([{ reject: { message: 'boom' } }, cancelled]), { rescue: true }),
      c(w([html403, ok(['rescued'])]), { rescue: true, watch: true }),
      c(w([html403, html403]), { rescue: true }),
      c(w([html403, { reject: { message: 'down' } }]), { rescue: true }),
      c(w([html403]), {}),
      c(w([html403, ok(['rescued'])]), { rescue: true, init: { bodyHex: '00' } }),
      c(w([ok(['web'])]), { embed: true, ua: 'Web/1' }),
      c(w([ok(['ua'])]), { init: { headers: { 'User-Agent': 'given' } } }),
      c(w([BUSY, BUSY, ok(['third'])], { abortAt: 2500 }), { watch: true }),
    ],
  },
  'fetch.keyedFetch': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = (o ?? {}) as Opts
        setUp(run, opts)
        return answer(
          await fetchMod.keyedFetch(
            opts.url ?? URL_A,
            initOf(opts, signal),
            watchOf(opts, cx),
            baseOf(run, opts.base),
          ),
        )
      }),
    cases: [
      c(w([ok(['fine'])]), {}),
      c(w([redirect(302, 'https://evil.example.net/steal')]), {}),
      c(w([redirect(307, '/v2/chat')]), { watch: true }),
      c(w([redirect(302, null)]), {}),
      c(w([redirect(301, 'http://[bad')]), {}),
      c(w([{ status: 200, type: 'opaqueredirect', body: null }]), {}),
      c(w([redirect(304, 'https://x.example/')]), {}),
      c(w([cancelled]), { base: 'net' }),
      c(w([{ reject: { message: 'Attempted to redirect, but redirect policy was manual' } }]), {
        base: 'net',
      }),
      c(w([{ reject: { message: 'other failure' } }]), { base: 'node' }),
      c(w([cancelled, redirect(302, 'https://cdn.example.org/a')]), { base: 'seeing' }),
      c(w([cancelled, ok(['seen'])]), { base: 'seeing' }),
      c(w([ok(['via node'])]), { base: 'node' }),
      c(w([BUSY, ok(['now'])]), { delays: [1], watch: true }),
      c(w([redirect(302, `https://${'h'.repeat(120)}.example/`)]), {}),
    ],
  },
  'fetch.keyedDownload': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = (o ?? {}) as Opts
        setUp(run, opts)
        return answer(
          await fetchMod.keyedDownload(opts.url ?? URL_A, initOf(opts, signal), {
            ...(opts.base !== undefined && opts.base !== 'ai'
              ? { base: baseOf(run, opts.base) }
              : {}),
            ...(opts.keyOutsideHeaders !== undefined
              ? { keyOutsideHeaders: opts.keyOutsideHeaders }
              : {}),
          }),
        )
      }),
    cases: [
      c(w([ok(['bytes'])]), {}),
      c(w([redirect(302, 'https://storage.example.org/f?sig=1'), ok(['file'])]), {
        init: {
          headers: {
            Authorization: 'Bearer t',
            Accept: 'application/octet-stream',
            'x-goog-api-key': 'k',
            Range: 'bytes=0-',
          },
        },
      }),
      c(w([redirect(302, '/same/origin'), ok(['file'])]), {
        init: { headers: { Authorization: 'Bearer t' } },
      }),
      c(w([redirect(303, 'https://storage.example.org/f'), ok(['file'])]), {
        init: {
          method: 'post',
          headers: { 'Content-Type': 'text/plain', Accept: '*/*' },
          body: 'x',
        },
      }),
      c(w([redirect(302, '/again'), ok(['file'])]), {
        init: { method: 'POST', headers: { 'Content-Length': '1' }, body: 'x' },
      }),
      c(w([redirect(307, 'https://other.example.org/f')]), {
        init: { method: 'POST', body: 'x' },
      }),
      c(w([redirect(307, '/same'), ok(['file'])]), { init: { method: 'PUT', body: 'x' } }),
      c(w([redirect(302, 'http://insecure.example.org/f')]), {}),
      c(w([redirect(302, 'http://127.0.0.1:9/f'), ok(['local'])]), {
        url: 'http://localhost:8080/a',
      }),
      c(w([redirect(302, 'http://example.org/f')]), { url: 'http://localhost:8080/a' }),
      c(w([redirect(302, 'https://x.example/1')]), { url: 'https://a.example/f?api_key=1' }),
      c(w([redirect(302, 'https://x.example/1')]), { url: 'https://a.example/f?Access-Token=1' }),
      c(w([redirect(302, 'https://x.example/1')]), { url: 'https://user:pw@a.example/f' }),
      c(w([redirect(302, 'https://x.example/1')]), { keyOutsideHeaders: true }),
      c(w([redirect(302, null)]), {}),
      c(w([{ status: 200, type: 'opaqueredirect', body: null }]), {}),
      c(w([redirect(302, 'http://[x')]), {}),
      c(
        w([
          redirect(302, '/1'),
          redirect(302, '/2'),
          redirect(302, '/3'),
          redirect(302, '/4'),
          redirect(302, '/5'),
          redirect(302, '/6'),
        ]),
        {},
      ),
      c(w([redirect(302, 'https://b.example/x'), redirect(302, URL_A), ok(['back'])]), {
        init: { headers: { Authorization: 'Bearer t', 'User-Agent': 'u' } },
      }),
      c(w([ok(['x'])]), { url: 'nope' }),
      c(w([cancelled, redirect(302, 'https://cdn.example.org/a'), cancelled, ok(['cdn'])]), {
        base: 'seeing',
      }),
      c(w([cancelled]), { base: 'net' }),
    ],
  },
}

// ---------------------------------------------------------------------------
// the runtime's combinators: what Promise.race and Promise.all leave running
// ---------------------------------------------------------------------------

/** a fetch of the n-th answer, read to its end, logged when done */
async function readOne(n: number, cx: TsContext, signal: AbortSignal): Promise<string> {
  const r = await fetch(`${URL_A}/${n}`, { signal })
  const text = await r.text()
  cx.log('done', n, text)
  if (text.startsWith('fail')) throw new Error(`failed ${n}`)
  return text
}

const runtime: Group = {
  'task.race': {
    ts: ([world, n], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const all = Array.from({ length: n as number }, (_, k) => readOne(k, cx, signal))
        return Promise.race(all)
      }),
    cases: [
      c(w([ok(['a']), ok(['b1', 'b2', 'b3'])]), 2),
      c(w([ok(['a1', 'a2', 'a3']), ok(['b'])]), 2),
      c(w([ok(['fail'])]), 1),
    ],
  },
  'task.all': {
    ts: ([world, n], cx) =>
      inWorld(world as World, cx, async (_run, signal) => {
        const all = Array.from({ length: n as number }, (_, k) => readOne(k, cx, signal))
        return Promise.all(all)
      }),
    cases: [
      c(w([ok(['a']), ok(['b1', 'b2'])]), 2),
      c(w([ok(['fail', 'x']), ok(['b']), ok(['c1', 'c2', 'c3'])]), 3),
      c(w([ok(['a1', 'a2']), ok(['fail'])]), 2),
      c(w([]), 0),
    ],
  },
}

export const group: Group = { ...pure, ...readers, ...fetches, ...runtime }
