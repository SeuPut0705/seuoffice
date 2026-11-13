/**
 * Part `index-store` of group `b3b4-rest`: the file index's decision-model
 * client, its store, its reranker and its indexer (`apps/shell/src/main/
 * file-index/{decider,store,rerank,indexer}.ts`) and `isCloudflareEndpoint`
 * of `shared/home-api.ts`. The Rust is crates/main-core/src/calls/
 * b3b4_rest/index_store.rs.
 *
 * - decider: the transport is scripted. A script is a list of steps, one per
 *   call of `send`: `{ status, body, retryAfter? }` answers, `{ throws }`
 *   rejects with that message; `{ always: step }` answers every call alike.
 *   Each call logs `send` with the URL, the body and the key. `Date.now()`
 *   reads the clock of the call. `fetchTransport` runs over a stub of the
 *   global `fetch` that logs `fetch` with the URL and the request.
 * - store: `store.FileIndexStore` is a scenario of steps over one database
 *   file under the case's folder (`open`, `close`, `upsert`, `remove`,
 *   `search`, `listAll`, `count`, `excerptsFor`, `pathsIndexedAsOnDisk`,
 *   `setMeta`); the answer is one result per step, a step that throws gives
 *   `{ error: message }`. The database files are removed when the scenario
 *   ends, so the folder holds only what the case put there. A text may be
 *   `{ repeat, times, then }`: `repeat` written `times` times, then `then`.
 * - rerank: `rerank.SearchReranker` is a scenario over a store, a scripted
 *   transport and, when `sendable` is set, a `sendable` callback that logs
 *   `sendable` and drops the paths of the last `drop` step; `unsaved` sets the
 *   open files source. `both` starts two requests before either settles.
 * - indexer: `indexer.FileIndexer` is a scenario over a fake worker, fake
 *   timers and a store. The worker, the timers (`setTimeout`, `clearTimeout`,
 *   `setImmediate`) and the sources are logged one line per call; the worker
 *   numbers 1, 2, ... in the order `new Worker` is called, the timers 1, 2,
 *   ... in the order they are set, and request ids are the indexer's own.
 *   The Rust plays the adapter that carries out the same calls.
 */
import { registerHooks } from 'node:module'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker as RealWorker, type WorkerOptions } from 'node:worker_threads'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'

// the worker the indexer starts is a fake while a scenario runs; the hook
// answers for the indexer's own import only, and the stub is the real module
// behind a proxy so that every other use of it is untouched.
//
// indexer.ts and extract-worker.ts share a folder, and Node's CommonJS
// resolve cache (keyed by folder and request) hands both the first fake of
// `node:worker_threads` that loads. So each fake answers `Worker` from
// WORKER_CLASS and `parentPort` from index-core's box, whichever one loaded.
const WORLD = Symbol.for('main-diff.indexer')
const WORKER_CLASS = Symbol.for('main-diff.indexer-worker')
/** the indexer's worker while a scenario runs; the real one otherwise */
class IndexerWorker {
  handlers: Record<string, (message?: unknown) => void> = {}
  constructor(path: string | URL, options?: WorkerOptions) {
    const world = (globalThis as Record<symbol, unknown>)[WORLD] as
      { spawn: (worker: IndexerWorker, options: unknown) => void } | undefined
    if (!world) return new RealWorker(path, options) as unknown as IndexerWorker
    world.spawn(this, options)
  }
  postMessage(message: unknown): void {
    ;(globalThis as Record<symbol, { post: (w: IndexerWorker, m: unknown) => void }>)[WORLD].post(
      this,
      message,
    )
  }
  terminate(): unknown {
    return (globalThis as Record<symbol, { terminate: (w: IndexerWorker) => unknown }>)[
      WORLD
    ].terminate(this)
  }
  on(event: string, handler: (message?: unknown) => void): this {
    this.handlers[event] = handler
    return this
  }
}
;(globalThis as Record<symbol, unknown>)[WORKER_CLASS] = IndexerWorker
const STUB_URL = 'main-diff:worker-threads'
const stubSource = [
  `const real = require('node:worker_threads')`,
  `const port = () => globalThis[Symbol.for('main-diff.index-core')]?.port ?? real.parentPort`,
  `const worker = () => globalThis[Symbol.for('main-diff.indexer-worker')] ?? real.Worker`,
  `module.exports = new Proxy(real, { get: (target, key) => (key === 'Worker' ? worker() : key === 'parentPort' ? port() : target[key]) })`,
].join('\n')
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'node:worker_threads' &&
      context.parentURL &&
      /\/file-index\/indexer\.ts/.test(context.parentURL)
    )
      return { url: STUB_URL, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === STUB_URL) return { format: 'commonjs', source: stubSource, shortCircuit: true }
    return next(url, context)
  },
})

const homeApi = await import('../../../../apps/shell/src/shared/home-api.ts')
const decider = await import('../../../../apps/shell/src/main/file-index/decider.ts')
const rerank = await import('../../../../apps/shell/src/main/file-index/rerank.ts')
const storeModule = await import('../../../../apps/shell/src/main/file-index/store.ts')
const indexerModule = await import('../../../../apps/shell/src/main/file-index/indexer.ts')
const unsaved = await import('../../../../packages/electron-utils/src/unsaved-files.ts')

type Opts = Parameters<typeof decider.endpointUrl>[0]
type Settings = Parameters<typeof rerank.probeDecision>[0]
type Transport = NonNullable<Parameters<typeof decider.evaluate>[3]>

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const errorOf = (e: unknown): { error: string } => ({
  error: e instanceof Error ? e.message : String(e),
})

// ---------------------------------------------------------------------------
// decider
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  'openrouter',
  'direct',
  'perplexity',
  'perplexity-v12',
  'perplexity-flash',
  'liquid',
  'liquid-ultra',
  'openai',
  'cloudflare',
  'cloudflare-flash',
  'kev',
  'rizzo',
  'custom',
]

const o = (endpoint: string, extra: Record<string, string> = {}): Opts =>
  ({
    endpoint,
    key: 'k',
    customBaseUrl: '',
    customModel: '',
    cloudflareAccountId: '',
    cloudflareModel: '',
    ...extra,
  }) as Opts

const everyUrl = {
  cloudflareAccountId: 'acct',
  customBaseUrl: 'https://models.example/v1/systemone',
  customModel: 'my-model',
}

const urlCases: Case[] = cases(
  ...ENDPOINTS.map((e) => [o(e, everyUrl)]),
  [o('custom')],
  [o('custom', { customBaseUrl: '   ' })],
  [o('custom', { customBaseUrl: 'not a url' })],
  [o('custom', { customBaseUrl: 'ftp://models.example/x' })],
  [o('custom', { customBaseUrl: 'http://models.example/x' })],
  [o('custom', { customBaseUrl: 'http://127.0.0.1:8000/v1' })],
  [o('custom', { customBaseUrl: '  http://localhost/v1  ' })],
  [o('custom', { customBaseUrl: 'http://[::1]:9000/' })],
  [o('custom', { customBaseUrl: 'HTTP://LOCALHOST:80/' })],
  [o('custom', { customBaseUrl: 'http://127.0.0.1.evil.example/' })],
  [o('custom', { customBaseUrl: 'http://0x7f.1/' })],
  [o('custom', { customBaseUrl: 'http://user:pw@localhost:3/' })],
  [o('custom', { customBaseUrl: 'javascript:alert(1)' })],
  [o('custom', { customBaseUrl: 'https:' })],
  [o('custom', { customBaseUrl: 'http://localhost.localdomain/' })],
  [o('cloudflare')],
  [o('cloudflare', { cloudflareAccountId: '  ' })],
  [
    o('cloudflare', {
      cloudflareAccountId: 'a b/c?d',
      cloudflareModel: ' @cf/cloudflare/clef-omni ',
    }),
  ],
  [o('cloudflare', { cloudflareAccountId: 'a', cloudflareModel: '  ' })],
  [o('cloudflare-flash', { cloudflareAccountId: 'a', cloudflareModel: '@cf/other/model' })],
  [o('cloudflare', { cloudflareAccountId: '\uc138\uc0c1', cloudflareModel: 'x' })],
)

const bodyModelCases: Case[] = cases(
  ...ENDPOINTS.map((e) => [o(e)]),
  [o('custom', { customModel: '  my-model ' })],
  [o('custom', { customModel: '   ' })],
  [o('cloudflare', { cloudflareModel: '@cf/cloudflare/clef-omni' })],
  [o('cloudflare', { cloudflareModel: '@cf/someone/gpt' })],
  [o('cloudflare', { cloudflareModel: 'clef' })],
  [o('cloudflare', { cloudflareModel: '@cf/cloudflare/' })],
  [o('cloudflare', { cloudflareModel: ' @cf/cloudflare/clef-flash ' })],
  [o('cloudflare', { cloudflareModel: '@cf/cloudflare/clef-flash/x' })],
  [o('cloudflare-flash', { cloudflareModel: '@cf/cloudflare/clef' })],
)

const doc = (title: string, text: string, heading = '') => ({ title, heading, text })
const DOCS = [
  doc('Report.docx', 'Quarterly revenue report', 'Finance'),
  doc('Budget.xlsx', 'Revenue forecast and cost centers', 'Finance'),
  doc('Minutes.md', 'Roadmap review, hiring plan', 'Team'),
]
const many = (n: number, text: string) =>
  Array.from({ length: n }, (_, i) => doc(`file-${i}.txt`, text, `folder ${i}`))

const prepareCases: Case[] = cases(
  ['', DOCS, o('kev')],
  ['   ', DOCS, o('kev')],
  ['revenue', [], o('kev')],
  ['revenue', DOCS, o('kev')],
  ['revenue', DOCS, o('direct')],
  ['revenue', DOCS, o('openrouter')],
  ['revenue', DOCS, o('openai')],
  ['revenue', DOCS, o('cloudflare', everyUrl)],
  ['revenue', DOCS, o('cloudflare', { cloudflareModel: '@cf/someone/gpt' })],
  ['revenue', [], o('cloudflare', { cloudflareModel: '@cf/someone/gpt' })],
  ['revenue', DOCS, o('custom', { customModel: ' served-model ' })],
  ['quote " and \\ and\nnewline \u2028 and \u{1f600}', DOCS, o('kev')],
  ['x'.repeat(600), [doc('t'.repeat(200), 'u'.repeat(1500), 'h'.repeat(200))], o('kev')],
  ['\uc138'.repeat(600), [doc('\u{1f600}'.repeat(200), '\u{1f600}'.repeat(1300))], o('openai')],
  ['revenue', many(25, 'short text'), o('kev')],
  ['revenue', many(20, 'x'.repeat(1200)), o('kev')],
  ['revenue', many(20, '\uc138'.repeat(1200)), o('direct')],
  ['revenue', many(20, '\uc138'.repeat(1200)), o('openai')],
  ['revenue', many(20, 'x'.repeat(1200)), o('openrouter')],
)

const score = (s: number, p0: number, p1: number, p2: number, confidence = 0.9) => ({
  type: 'score',
  score: s,
  confidence,
  probabilities: { 0: p0, 1: p1, 2: p2 },
})
const oaScore = (name: string, s: number, p0: number, p1: number, p2: number) => ({
  name,
  type: 'score',
  score: s,
  confidence: 0.8,
  probabilities: [
    { value: 0, label: '0', probability: p0 },
    { value: 1, label: '1', probability: p1 },
    { value: 2, label: '2', probability: p2 },
  ],
})
const GOOD = score(1.2, 0.1, 0.6, 0.3)
const ZERO = score(0, 1, 0, 0)
const sys = (answers: unknown, extra: Record<string, unknown> = {}) => ({ answers, ...extra })
const twoAnswers = sys({ d0: GOOD, d1: ZERO })
const oaTwo = {
  answers: [oaScore('d1', 0, 1, 0, 0), oaScore('d0', 1.2, 0.1, 0.6, 0.3)],
}

const validateCases: Case[] = cases(
  [twoAnswers, 2, 'kev'],
  [twoAnswers, 1, 'rizzo'],
  [twoAnswers, 3, 'kev'],
  [sys({ d0: GOOD }, { usage: { input_tokens: 120, cost: 0.002 } }), 1, 'perplexity'],
  [sys({ d0: GOOD }, { usage: { input_tokens: 1.5 } }), 1, 'liquid'],
  [sys({ d0: GOOD }, { usage: { input_tokens: -1 } }), 1, 'liquid'],
  [sys({ d0: GOOD }, { usage: { cost: -0.5 } }), 1, 'liquid'],
  [sys({ d0: GOOD }, { usage: null }), 1, 'liquid'],
  [sys({ d0: GOOD }, { usage: {} }), 1, 'liquid'],
  [sys({ d0: GOOD }, { usage: { input_tokens: '5' } }), 1, 'liquid'],
  [null, 1, 'kev'],
  [[], 1, 'kev'],
  ['text', 1, 'kev'],
  [{}, 1, 'kev'],
  [sys([]), 1, 'kev'],
  [sys({ d0: { ...GOOD, type: 'choice' } }), 1, 'kev'],
  [sys({ d0: score(2.5, 0, 0, 1) }), 1, 'kev'],
  [sys({ d0: score(1.2, 0.1, 0.6, 0.3, 1.5) }), 1, 'kev'],
  [sys({ d0: score(1.2, 0.1, 0.6, 0.35) }), 1, 'kev'],
  [sys({ d0: score(1.2, 0.1, 0.6, 0.31) }), 1, 'kev'],
  [sys({ d0: score(1.25, 0.1, 0.6, 0.3) }), 1, 'kev'],
  [sys({ d0: score(1.3, 0.1, 0.6, 0.3) }), 1, 'kev'],
  [sys({ d0: { ...GOOD, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3, 3: 0 } } }), 1, 'kev'],
  [sys({ d0: { ...GOOD, probabilities: { 0: 0.1, 1: 0.6 } } }), 1, 'kev'],
  [sys({ d0: { ...GOOD, probabilities: [0.1, 0.6, 0.3] } }), 1, 'kev'],
  [sys({ d0: { ...GOOD, probabilities: { 0: 0.1, 1: 0.6, 2: '0.3' } } }), 1, 'kev'],
  [sys({ d0: GOOD }, { model: 'jev-1.13.0' }), 1, 'direct'],
  [sys({ d0: GOOD }, { model: 'jev-1.13.1' }), 1, 'direct'],
  [sys({ d0: GOOD }), 1, 'direct'],
  [sys({ d0: GOOD }, { model: 'typesafe/jev-1.13' }), 1, 'openrouter'],
  [sys({ d0: GOOD }, { model: 'typesafe/jev-1.13-20261001' }), 1, 'openrouter'],
  [sys({ d0: GOOD }, { model: 'typesafe/jev-1.13-2026100' }), 1, 'openrouter'],
  [sys({ d0: GOOD }, { model: 'typesafe/jev-1.13', warnings: [] }), 1, 'openrouter'],
  [sys({ d0: GOOD }, { model: 'typesafe/jev-1.13', warnings: ['slow'] }), 1, 'openrouter'],
  [sys({ d0: GOOD }, { model: 7 }), 1, 'openrouter'],
  [{ result: twoAnswers }, 2, 'cloudflare'],
  [twoAnswers, 2, 'cloudflare-flash'],
  [{ result: null }, 1, 'cloudflare'],
  [{ result: [] }, 1, 'cloudflare'],
  [null, 1, 'cloudflare'],
  [{ result: twoAnswers }, 2, 'kev'],
  [oaTwo, 2, 'openai'],
  [{ ...oaTwo, usage: { input_tokens: 9 } }, 2, 'openai'],
  [oaTwo, 3, 'openai'],
  [twoAnswers, 2, 'openai'],
  [{ answers: [oaScore('d0', 1.2, 0.1, 0.6, 0.3), 5] }, 1, 'openai'],
  [{ answers: [{ type: 'score' }] }, 1, 'openai'],
  [{ answers: [oaScore('d0', 1.2, 0.1, 0.6, 0.3), oaScore('d0', 0, 1, 0, 0)] }, 1, 'openai'],
  [{ answers: [{ ...oaScore('d0', 1.2, 0.1, 0.6, 0.3), type: 'refusal' }] }, 1, 'openai'],
  [{ answers: [{ ...oaScore('d0', 1.2, 0.1, 0.6, 0.3), probabilities: {} }] }, 1, 'openai'],
  [
    {
      answers: [
        {
          ...oaScore('d0', 1.2, 0.1, 0.6, 0.3),
          probabilities: [
            { value: 0, probability: 0.1 },
            { value: 1, probability: 0.6 },
          ],
        },
      ],
    },
    1,
    'openai',
  ],
  [
    {
      answers: [
        {
          ...oaScore('d0', 1.2, 0.1, 0.6, 0.3),
          probabilities: [
            { value: 0, probability: 0.1 },
            { value: 1, probability: 0.6 },
            { value: 2, probability: 0.3 },
            { value: 0.5, probability: 0 },
          ],
        },
      ],
    },
    1,
    'openai',
  ],
  [
    {
      answers: [
        {
          ...oaScore('d0', 1.2, 0.1, 0.6, 0.3),
          probabilities: [
            { value: 0, probability: 0.1 },
            { value: 1, probability: 0.6 },
            { value: 2, probability: 0.5 },
          ],
        },
      ],
    },
    1,
    'openai',
  ],
  [{ answers: [oaScore('d0', 0.4, 0.1, 0.6, 0.3)] }, 1, 'openai'],
  [{ answers: [oaScore('d0', 1.2, 0.1, 0.6, 0.3)], usage: 5 }, 1, 'openai'],
  [sys({ d0: score(1.215, 0.1, 0.6, 0.3) }), 1, 'kev'],
  [sys({ d0: score(1.23, 0.1, 0.6, 0.315) }), 1, 'kev'],
  [sys({ d0: score(1.2, 0.1, 0.6, 0.3, 1) }), 1, 'kev'],
  [sys({ d0: score(1.2, 0.1, 0.6, 0.3, 0) }), 1, 'kev'],
  [sys({ d0: score(2, 0, 0, 1) }), 1, 'kev'],
  [sys({ d0: score(0, 1, 0, 0) }, { usage: { input_tokens: 0, cost: 0 } }), 1, 'kev'],
  [{ answers: [oaScore('d0', 1.215, 0.1, 0.6, 0.3)] }, 1, 'openai'],
  [{ answers: [oaScore('d0', 2, 0, 0, 1)], usage: { input_tokens: 3 } }, 1, 'openai'],
  [{ answers: [{ ...oaScore('d0', 1.2, 0.1, 0.6, 0.3), confidence: 1.5 }] }, 1, 'openai'],
  [{ answers: [{ ...oaScore('d0', 1.2, 0.1, 0.6, 0.3), confidence: 1 }] }, 1, 'openai'],
  [sys({ d0: score(2.015, 0, 0, 1) }), 1, 'kev'],
  [sys({ d0: score(2, 0, 0, 1) }), 1, 'kev'],
)

const jsonBody = (value: unknown): string => JSON.stringify(value)
const ok = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: jsonBody(sys(answers, extra)),
})
const OK2 = ok({ d0: GOOD, d1: ZERO })
const OK3 = ok({ d0: GOOD, d1: ZERO, d2: ZERO })
const D2 = DOCS.slice(0, 2)

type ScriptStep =
  | { status: number; body: string; retryAfter?: string }
  | { throws: string }
  | { always: ScriptStep }

/** a transport that logs each call and answers from the script */
function scripted(
  script: () => ScriptStep[],
  log: (...a: unknown[]) => void,
  hold = false,
): Transport {
  return async (url, body, key) => {
    log('send', url, body, key)
    if (hold) await new Promise<void>((resolve) => setImmediate(resolve))
    const steps = script()
    let next: ScriptStep | undefined = steps[0]
    if (next && 'always' in next) {
      while ('always' in next) next = next.always
    } else steps.shift()
    if (!next) throw new Error('script exhausted')
    if ('throws' in next) throw new Error(next.throws)
    return { status: next.status, retryAfter: next.retryAfter, body: next.body }
  }
}

async function withClock<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => now
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

const evaluateCase = (q: string, docs: unknown[], opts: Opts, script: ScriptStep[]): unknown[] => [
  q,
  docs,
  opts,
  script,
]
const KEV = o('kev', { key: '' })
const HOSTED = o('direct', { key: 'secret' })
const directOk = (answers: unknown) => ok(answers, { model: 'jev-1.13.0' })
const date = (offsetMs: number) => new Date(1_794_452_400_000 + offsetMs).toUTCString()

const evaluateCases: Case[] = cases(
  evaluateCase('revenue', D2, KEV, [OK2]),
  evaluateCase('revenue', DOCS, KEV, [OK3]),
  evaluateCase('revenue', D2, o('direct', { key: '  ' }), [OK2]),
  evaluateCase('revenue', D2, HOSTED, [directOk({ d0: GOOD, d1: ZERO, d2: ZERO })]),
  evaluateCase('revenue', D2, HOSTED, [ok({ d0: GOOD, d1: ZERO, d2: ZERO })]),
  evaluateCase('', D2, HOSTED, [OK2]),
  evaluateCase('revenue', D2, o('custom', { customBaseUrl: 'http://example.com' }), [OK2]),
  evaluateCase('revenue', D2, o('custom', { customBaseUrl: '' }), [OK2]),
  evaluateCase('revenue', D2, o('cloudflare', { cloudflareAccountId: 'acct' }), [
    { status: 200, body: jsonBody({ result: sys({ d0: GOOD, d1: ZERO, d2: ZERO }) }) },
  ]),
  evaluateCase('revenue', D2, o('cloudflare', { cloudflareAccountId: '' }), [OK2]),
  evaluateCase('revenue', D2, o('openai'), [
    {
      status: 200,
      body: jsonBody({
        answers: [
          oaScore('d2', 0, 1, 0, 0),
          oaScore('d0', 1.2, 0.1, 0.6, 0.3),
          oaScore('d1', 0, 1, 0, 0),
        ],
        usage: { input_tokens: 40 },
      }),
    },
  ]),
  evaluateCase('revenue', D2, KEV, [{ status: 500, body: '' }]),
  evaluateCase('revenue', D2, KEV, [{ status: 204, body: '' }]),
  evaluateCase('revenue', D2, KEV, [{ status: 200, body: 'not json' }]),
  evaluateCase('revenue', D2, KEV, [{ status: 200, body: 'x'.repeat(1024 * 1024 + 1) }]),
  evaluateCase('revenue', D2, KEV, [{ status: 200, body: '\u00e9'.repeat(524_289) }]),
  evaluateCase('revenue', D2, KEV, [{ status: 200, body: 'x'.repeat(1024 * 1024) }]),
  evaluateCase('revenue', D2, KEV, [{ throws: 'socket hang up' }]),
  evaluateCase('revenue', D2, KEV, [{ status: 200, body: jsonBody([1]) }]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: '0' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 529, body: '', retryAfter: '0.05' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '' }, OK2]),
  evaluateCase('revenue', D2, KEV, [
    { status: 429, body: '', retryAfter: '0' },
    { status: 429, body: '', retryAfter: '0' },
  ]),
  evaluateCase('revenue', D2, KEV, [
    { status: 429, body: '', retryAfter: '0' },
    { throws: 'reset' },
  ]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: '4' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: '5' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: '-5' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: 'Infinity' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: 'soon' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: date(-60_000) }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 429, body: '', retryAfter: date(10_000) }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ status: 503, body: '', retryAfter: '0' }, OK2]),
  evaluateCase('revenue', D2, KEV, [{ always: OK2 }]),
)

const fetchCases: Case[] = cases(
  ['http://127.0.0.1:8009/v1/systemone', '{"a":1}', '', { status: 200, body: 'ok' }],
  [
    'https://api.typesafe.ai/v1/systemone',
    '{"a":1}',
    '  secret-key \n',
    { status: 200, body: 'ok' },
  ],
  ['https://x.example/', 'b', 'k', { status: 429, body: '', retryAfter: '3' }],
  ['https://x.example/', 'b', 'k', { status: 429, body: 'slow', retryAfter: '' }],
  ['https://x.example/', 'b', 'k', { reject: 'network down' }],
  ['https://x.example/', 'b', '   ', { status: 200, body: 'ok' }],
)

async function fetchTransportCall(args: unknown[], cx: TsContext): Promise<unknown> {
  const [url, body, key, reply] = args as [
    string,
    string,
    string,
    { status: number; body: string; retryAfter?: string; reject?: string },
  ]
  const real = globalThis.fetch
  globalThis.fetch = (async (target: string, init: RequestInit) => {
    cx.log('fetch', target, { method: init.method, headers: init.headers, body: init.body })
    if (reply.reject !== undefined) throw new Error(reply.reject)
    const headers: Record<string, string> = {}
    if (reply.retryAfter !== undefined) headers['retry-after'] = reply.retryAfter
    return new Response(reply.body, { status: reply.status, headers })
  }) as never
  try {
    return await decider.fetchTransport(url, body, key, new AbortController().signal)
  } finally {
    globalThis.fetch = real
  }
}

// ---------------------------------------------------------------------------
// rerank: normalizeFileSearchSettings and probeDecision
// ---------------------------------------------------------------------------

const emptyKeys = rerank.DEFAULT_FILE_SEARCH_SETTINGS.keys
const withKey = (endpoint: string, key: string, over: Record<string, unknown> = {}): Settings =>
  ({
    ...rerank.DEFAULT_FILE_SEARCH_SETTINGS,
    rerank: true,
    endpoint,
    keys: { ...emptyKeys, [endpoint]: key },
    ...over,
  }) as Settings

const normalizeCases: Case[] = cases(
  [null],
  [{}],
  ['text'],
  [7],
  [[]],
  [[1, 2]],
  [{ rerank: true }],
  [{ rerank: 'true' }],
  [{ endpoint: 'kev', rerank: true, keys: { kev: ' k ' } }],
  [{ endpoint: 'bogus', keys: { openrouter: 'a' } }],
  [{ jevEndpoint: 'direct', jevKeys: { direct: 'd', openrouter: 'o' } }],
  [{ endpoint: 'bogus', jevEndpoint: 'direct' }],
  [{ endpoint: null, jevEndpoint: 'liquid' }],
  [{ keys: null, jevKeys: { direct: 'd' } }],
  [{ keys: 'abc', jevKeys: { direct: 'd' } }],
  [{ keys: { direct: 7, openrouter: '  ', liquid: 'x'.repeat(600), openai: 'o\n' } }],
  [{ customBaseUrl: '  https://x.example  ', customModel: ' m ', cloudflareAccountId: ' acct ' }],
  [
    {
      customBaseUrl: 'u'.repeat(600),
      customModel: 'm'.repeat(200),
      cloudflareAccountId: 'a'.repeat(200),
    },
  ],
  [{ cloudflareModel: '  ' }],
  [{ cloudflareModel: ' @cf/cloudflare/clef-flash ' }],
  [{ cloudflareModel: 'c'.repeat(300) }],
  [{ cloudflareModel: 5 }],
  [{ customBaseUrl: 5, customModel: null }],
  [Object.fromEntries(ENDPOINTS.map((e) => [e, e]))],
  [{ keys: Object.fromEntries(ENDPOINTS.map((e) => [e, `key-${e}`])) }],
)

const probeCases: Case[] = cases(
  [withKey('openrouter', ''), []],
  [withKey('openrouter', '   '), []],
  [withKey('kev', ''), [OK2]],
  [withKey('rizzo', ''), [{ status: 500, body: '' }]],
  [withKey('direct', 'k'), [directOk({ d0: GOOD, d1: ZERO })]],
  [
    withKey('openrouter', 'k'),
    [ok({ d0: GOOD, d1: ZERO }, { model: 'typesafe/jev-1.13-20261001' })],
  ],
  [withKey('openrouter', 'k'), [ok({ d0: GOOD, d1: ZERO }, { model: 'other' })]],
  [
    withKey('openrouter', 'k'),
    [ok({ d0: GOOD, d1: ZERO }, { model: 'typesafe/jev-1.13', warnings: ['x'] })],
  ],
  [withKey('openai', 'k'), [{ status: 200, body: jsonBody(oaTwo) }]],
  [withKey('openai', 'k'), [{ status: 401, body: '' }]],
  [withKey('direct', 'k'), [{ status: 200, body: 'nope' }]],
  [withKey('direct', 'k'), [{ status: 200, body: 'x'.repeat(1024 * 1024 + 1) }]],
  [withKey('direct', 'k'), [{ status: 429, body: '', retryAfter: '9' }]],
  [withKey('custom', 'k'), []],
  [withKey('custom', 'k', { customBaseUrl: 'ftp://x' }), []],
  [withKey('custom', 'k', { customBaseUrl: 'bad' }), []],
  [withKey('custom', '', { customBaseUrl: 'http://127.0.0.1:1/' }), [OK2]],
  [withKey('cloudflare', 'k'), []],
  [withKey('cloudflare', 'k', { cloudflareAccountId: 'a', cloudflareModel: '@cf/x/y' }), []],
  [
    withKey('cloudflare', 'k', { cloudflareAccountId: 'a' }),
    [{ status: 200, body: jsonBody({ result: sys({ d0: GOOD, d1: ZERO }) }) }],
  ],
  [withKey('direct', 'k'), [{ throws: 'boom' }]],
  [withKey('direct', 'k'), [{ throws: 'http-123' }]],
  [withKey('direct', 'k'), [{ throws: 'constructor' }]],
  [withKey('direct', 'k'), [{ throws: '__proto__' }]],
  [withKey('direct', 'k'), [{ throws: 'http-' }]],
  [withKey('direct', 'k'), []],
)

async function probeCall(args: unknown[], cx: TsContext): Promise<unknown> {
  const [settings, script] = args as [Settings, ScriptStep[]]
  const steps = [...script]
  return withClock(cx.now, () =>
    rerank.probeDecision(
      settings,
      scripted(() => steps, cx.log),
    ),
  )
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

type Text = string | null | { repeat: string; times: number; then?: string }
const textOf = (text: Text): string | null =>
  text !== null && typeof text === 'object'
    ? text.repeat.repeat(text.times) + (text.then ?? '')
    : text

/** a file of the corpus; `$DIR` is the case's folder */
const NOW = 1_700_000_000_000
const upsert = (
  path: string,
  text: Text,
  extra: { age?: number; status?: string; size?: number } = {},
) => ({
  op: 'upsert',
  path: `$DIR/${path}`,
  mtimeMs: NOW + (extra.age ?? 0),
  sizeBytes: extra.size ?? (typeof text === 'string' ? text.length : 100),
  text,
  status: extra.status ?? 'ok',
})
const open = (name = 'index.db') => ({ op: 'open', path: `$DIR/${name}` })
const search = (q: string, opts: Record<string, unknown> = {}) => ({ op: 'search', q, opts })

const CORPUS = [
  upsert(
    'docs/report-2026.docx',
    'Quarterly revenue report for the finance team. Revenue grew 12 percent.',
    { age: 5 },
  ),
  upsert('docs/budget.xlsx', 'budget revenue forecast cost center', { age: 3 }),
  upsert('docs/minutes.md', 'meeting minutes: roadmap review, hiring plan', { age: 1 }),
  upsert(
    'notes/\ud55c\uae00\ubb38\uc11c.hwpx',
    '\ub300\ud55c\ubbfc\uad6d \ud5cc\ubc95 \uc81c1\uc870 \ubbfc\uc8fc\uacf5\ud654\uad6d\uc774\ub2e4',
    { age: 2 },
  ),
  upsert(
    'notes/\ud68c\uc758\ub85d.docx',
    '\ubd84\uae30 \ud68c\uc758\ub85d \uc548\uac74 \uc608\uc0b0 \uac80\ud1a0',
    { age: 4 },
  ),
  upsert('sub/slides.pptx', 'revenue deck for the board', { age: 6 }),
  upsert(
    'notes/\u65e5\u672c\u8a9e.txt',
    '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 \u6771\u4eac\u30bf\u30ef\u30fc',
    { age: 7 },
  ),
  upsert('docs/scan.pdf', null, { status: 'name-only', age: 8 }),
  upsert('docs/diagram.drawio.svg', 'revenue flow diagram', { age: 9 }),
  upsert('docs/Revenue Review.docx', 'a file whose name starts with revenue', { age: 0 }),
  upsert('docs/caf\u00e9.md', 'r\u00e9sum\u00e9 caf\u00e9 notes', { age: 11 }),
  upsert('docs/totals.txt', 'sub total figures', { age: 20 }),
  upsert('notes/\ubd84\ub9ac.txt', '\ud68c\uc758 alpha \uc758\ub85d', { age: 12 }),
]

const searchSteps = (...qs: Array<string | [string, Record<string, unknown>]>) =>
  qs.map((q) => (typeof q === 'string' ? search(q) : search(q[0], q[1])))

const storeCases: Case[] = [
  {
    note: 'empty index: counts, lists, queries with nothing searchable',
    args: [
      [
        open(),
        { op: 'count' },
        { op: 'listAll' },
        search('revenue'),
        search(''),
        search('   '),
        search('"" -'),
        { op: 'remove', paths: ['$DIR/none'] },
        { op: 'remove', paths: [] },
      ],
    ],
  },
  {
    note: 'phrase, prefix, any-term fallback, exclusion',
    args: [
      [
        open(),
        ...CORPUS,
        { op: 'count' },
        { op: 'listAll' },
        ...searchSteps(
          'revenue',
          '"revenue report"',
          '"report revenue"',
          'rev',
          'r',
          'revenue budget',
          'revenue roadmap',
          'revenue -budget',
          '-revenue',
          'revenue -budget -report',
          'zzzz',
          'Revenue',
          'REVENUE BUDGET',
          '"quarterly revenue"',
          '"quarterly rev"',
          'rev*',
          'drawio',
          'diagram.drawio.svg',
          'minutes meeting',
          'cafe',
          'resume',
          'sub',
          'revenue -report -budget',
        ),
      ],
    ],
  },
  {
    note: 'Hangul and CJK: bigrams, a single character, relaxed matching',
    args: [
      [
        open(),
        ...CORPUS,
        ...searchSteps(
          '\ud5cc\ubc95',
          '\ud55c',
          '\ub300\ud55c\ubbfc\uad6d\ud5cc\ubc95',
          '\ub300\ud55c\ubbfc\uad6d',
          '\ubbfc\uad6d \ud5cc\ubc95',
          '\ud68c\uc758',
          '\ud68c',
          '\u6771\u4eac',
          '\u65e5\u672c\u8a9e',
          '\u30c6\u30ad\u30b9\u30c8',
          '\u65e5',
          '"\ud68c\uc758\ub85d \uc548\uac74"',
          '\ud55c\uae00 -\ud68c\uc758',
          '\ud55c\uae00\ubb38\uc11c',
          '\ubbfc\uc8fc\uacf5\ud654\uad6d\uc774\ub2e4\uc548',
          '\uc608\uc0b0 revenue',
          '\ubbfc\uc8fc\uacf5\ud654\uad6d\uc774\ub2e4',
          '\ud68c\uc758\ub85d',
          '\ud68c\uc758\ub85d\ubc14\uc0ac\uc544\uc790\ucc28',
          '\ub300\ud55c\ubbfc\uad6d\ud5cc\ubc95 \uc608\uc0b0',
        ),
      ],
    ],
  },
  {
    note: 'type filter, paging, limit and offset clamps',
    args: [
      [
        open(),
        ...CORPUS,
        ...searchSteps(
          ['revenue', { exts: ['docx'] }],
          ['revenue', { exts: ['DOCX', 'xlsx'] }],
          ['revenue', { exts: [] }],
          ['revenue', { exts: ['pdf'] }],
          ['revenue roadmap', { exts: ['md'] }],
          ['revenue', { exts: ['drawio.svg'] }],
          ['revenue', { limit: 2 }],
          ['revenue', { limit: 2, offset: 2 }],
          ['revenue', { limit: 2, offset: 100 }],
          ['revenue', { limit: 0 }],
          ['revenue', { limit: -3 }],
          ['revenue', { limit: 1000 }],
          ['revenue', { limit: 1.5, offset: 0.5 }],
          ['revenue', { limit: null, offset: null }],
          ['revenue', { offset: -4 }],
        ),
      ],
    ],
  },
  {
    note: 'within applies before ranking and paging; excerpt and snippet',
    args: [
      [
        open(),
        ...CORPUS,
        ...searchSteps(
          ['revenue', { within: { prefix: '$DIR/docs/' } }],
          ['revenue', { within: { prefix: '$DIR/docs/' }, limit: 1 }],
          ['revenue roadmap', { within: { prefix: '$DIR/sub/' } }],
          ['revenue', { within: { prefix: '$DIR/nowhere/' } }],
          ['revenue', { excerptChars: 30 }],
          ['revenue', { excerptChars: 0 }],
          ['\ubbfc\uad6d', { excerptChars: 12 }],
          ['forecast', { excerptChars: 1200, exts: ['xlsx'] }],
          ['scan', { excerptChars: 20 }],
        ),
      ],
    ],
  },
  {
    note: 'upsert replaces, remove drops, statuses and bodies',
    args: [
      [
        open(),
        ...CORPUS,
        upsert('docs/budget.xlsx', 'replaced body about payroll', { age: 50 }),
        { op: 'count' },
        search('forecast'),
        search('payroll'),
        search('budget'),
        { op: 'remove', paths: ['$DIR/docs/budget.xlsx', '$DIR/missing', '$DIR/sub/slides.pptx'] },
        { op: 'count' },
        search('payroll'),
        search('deck'),
        upsert('cloud/remote.docx', null, { status: 'cloud' }),
        upsert('cloud/failed.docx', null, { status: 'error' }),
        upsert('cloud/empty.txt', '', { status: 'ok' }),
        { op: 'listAll' },
        search('remote'),
        search('failed cloud'),
      ],
    ],
  },
  {
    note: 'a body is cut at 1,000,000 UTF-16 units',
    args: [
      [
        open(),
        upsert('big.txt', { repeat: 'ab ', times: 333_330, then: ' keepword dropword' }),
        search('keepword'),
        search('dropword'),
        { op: 'count' },
      ],
    ],
  },
  {
    note: 'excerptsFor keeps the order of the paths and skips unknown ones',
    args: [
      [
        open(),
        ...CORPUS,
        { op: 'excerptsFor', paths: [], q: 'revenue', chars: 40 },
        {
          op: 'excerptsFor',
          paths: ['$DIR/docs/budget.xlsx', '$DIR/none', '$DIR/docs/report-2026.docx'],
          q: 'revenue',
          chars: 40,
        },
        {
          op: 'excerptsFor',
          paths: ['$DIR/docs/scan.pdf', '$DIR/docs/budget.xlsx', '$DIR/docs/scan.pdf'],
          q: 'forecast',
          chars: 1200,
        },
        {
          op: 'excerptsFor',
          paths: ['$DIR/docs/report-2026.docx'],
          q: '\ud55c "finance team"',
          chars: 24,
        },
        { op: 'excerptsFor', paths: ['$DIR/docs/report-2026.docx'], q: '', chars: 24 },
        {
          op: 'excerptsFor',
          paths: ['$DIR/docs/report-2026.docx'],
          q: '"team finance"',
          chars: 24,
        },
        { op: 'excerptsFor', paths: ['$DIR/docs/report-2026.docx'], q: 'zzz', chars: 10 },
      ],
    ],
  },
  {
    note: 'versions: a stale tokenizer or extract stamp rebuilds the index',
    args: [
      [
        open(),
        ...CORPUS,
        { op: 'count' },
        { op: 'close' },
        open(),
        { op: 'count' },
        search('revenue'),
        { op: 'close' },
        { op: 'setMeta', path: '$DIR/index.db', key: 'tokenizer', value: '1' },
        open(),
        { op: 'count' },
        search('revenue'),
        ...CORPUS.slice(0, 2),
        { op: 'close' },
        { op: 'setMeta', path: '$DIR/index.db', key: 'extract', value: '1' },
        open(),
        { op: 'count' },
        ...CORPUS.slice(0, 2),
        { op: 'close' },
        { op: 'setMeta', path: '$DIR/index.db', key: 'extract', value: null },
        open(),
        { op: 'count' },
        ...CORPUS.slice(0, 3),
        { op: 'close' },
        open(),
        { op: 'count' },
        search('roadmap'),
      ],
    ],
  },
  {
    note: 'an unreadable path and a closed store throw',
    args: [
      [
        open('missing/index.db'),
        { op: 'count' },
        open(),
        upsert('a.txt', 'x'),
        { op: 'close' },
        { op: 'count' },
        { op: 'close' },
      ],
    ],
  },
  {
    note: 'pathsIndexedAsOnDisk: same mtime and size only',
    files: {
      'same.txt': { text: 'hello', mtimeMs: 1_700_000_100_000 },
      'grown.txt': { text: 'hello world', mtimeMs: 1_700_000_100_000 },
      'touched.txt': { text: 'abc', mtimeMs: 1_700_000_200_000 },
      'unindexed.txt': { text: 'zzz', mtimeMs: 1_700_000_100_000 },
      dir: { dir: true },
    },
    args: [
      [
        open(),
        {
          op: 'upsert',
          path: '$DIR/same.txt',
          mtimeMs: 1_700_000_100_000,
          sizeBytes: 5,
          text: 'hello',
          status: 'ok',
        },
        {
          op: 'upsert',
          path: '$DIR/grown.txt',
          mtimeMs: 1_700_000_100_000,
          sizeBytes: 5,
          text: 'hello',
          status: 'ok',
        },
        {
          op: 'upsert',
          path: '$DIR/touched.txt',
          mtimeMs: 1_700_000_100_000,
          sizeBytes: 3,
          text: 'abc',
          status: 'ok',
        },
        {
          op: 'upsert',
          path: '$DIR/gone.txt',
          mtimeMs: 1_700_000_100_000,
          sizeBytes: 5,
          text: 'bye',
          status: 'ok',
        },
        {
          op: 'upsert',
          path: '$DIR/dir',
          mtimeMs: 1_700_000_100_000,
          sizeBytes: 0,
          text: null,
          status: 'name-only',
        },
        { op: 'pathsIndexedAsOnDisk', paths: [] },
        {
          op: 'pathsIndexedAsOnDisk',
          paths: [
            '$DIR/same.txt',
            '$DIR/grown.txt',
            '$DIR/touched.txt',
            '$DIR/gone.txt',
            '$DIR/unindexed.txt',
            '$DIR/dir',
            '$DIR/same.txt',
          ],
        },
      ],
    ],
  },
  {
    note: 'more candidates than one fetch chunk',
    args: [
      [
        open(),
        ...Array.from({ length: 520 }, (_, i) =>
          upsert(`many/file-${i}.txt`, `common word item${i}`, { age: i }),
        ),
        search('common'),
        search('common', { limit: 200, offset: 300 }),
        search('common -item7'),
        {
          op: 'pathsIndexedAsOnDisk',
          paths: Array.from({ length: 600 }, (_, i) => `$DIR/many/file-${i}.txt`),
        },
      ],
    ],
  },
  {
    note: 'a stamp that is current keeps the index',
    args: [
      [
        open(),
        ...CORPUS.slice(0, 2),
        { op: 'close' },
        { op: 'setMeta', path: '$DIR/index.db', key: 'tokenizer', value: '2' },
        { op: 'setMeta', path: '$DIR/index.db', key: 'extract', value: '2' },
        open(),
        { op: 'count' },
        search('revenue'),
      ],
    ],
  },
  {
    note: 'a name starting with the query comes before a newer, shorter name',
    args: [
      [
        open(),
        upsert('rank/alpha-one-two-three-four-five.txt', 'x', { age: 0 }),
        upsert('rank/zz-alpha.txt', 'x', { age: 100 }),
        search('alpha'),
        { op: 'remove', paths: ['$DIR/rank/alpha-one-two-three-four-five.txt'] },
        upsert('rank/one-alpha-two-three-four-five.txt', 'x', { age: 0 }),
        search('alpha'),
      ],
    ],
  },
  {
    note: 'when no file holds every term, the file holding more terms comes first',
    args: [
      [
        open(),
        upsert('rank2/zz-tokenone.txt', 'nothing here', { age: 0 }),
        upsert('rank2/plain.txt', 'tokenone tokentwo here', { age: 0 }),
        search('tokenone tokentwo tokenthree'),
      ],
    ],
  },
  {
    note: 'a page holds at most 200 hits however large the limit',
    args: [
      [
        open(),
        ...Array.from({ length: 260 }, (_, i) =>
          upsert(`cap/f${i}.txt`, `capword n${i}`, { age: i }),
        ),
        search('capword', { limit: 1000 }),
        search('capword', { limit: 1000, offset: 100 }),
      ],
    ],
  },
]

async function storeScenario(args: unknown[], cx: TsContext): Promise<unknown> {
  const steps = args[0] as Array<Record<string, unknown>>
  const out: unknown[] = []
  const opened = new Set<string>()
  const held: { store: InstanceType<typeof storeModule.FileIndexStore> | null } = { store: null }
  try {
    for (const step of steps) {
      try {
        out.push(storeStep(step))
      } catch (e) {
        out.push(errorOf(e))
      }
    }
  } finally {
    try {
      held.store?.close()
    } catch {
      // closed by the scenario already
    }
    for (const path of opened)
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
  void cx
  return out

  function storeStep(step: Record<string, unknown>): unknown {
    const op = step.op as string
    if (op === 'open') {
      held.store?.close()
      held.store = null
      opened.add(step.path as string)
      held.store = new storeModule.FileIndexStore(step.path as string)
      return null
    }
    if (op === 'setMeta') {
      const db = new DatabaseSync(step.path as string)
      try {
        if (step.value === null)
          db.prepare('DELETE FROM meta WHERE key = ?').run(step.key as string)
        else
          db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
            step.key as string,
            step.value as string,
          )
      } finally {
        db.close()
      }
      return null
    }
    if (op === 'close') {
      const s = held.store
      held.store = null
      s?.close()
      return null
    }
    const store = held.store
    if (!store) throw new Error('no store')
    switch (op) {
      case 'upsert':
        store.upsert(
          {
            path: step.path as string,
            mtimeMs: step.mtimeMs as number,
            sizeBytes: step.sizeBytes as number,
          },
          textOf(step.text as Text),
          step.status as never,
        )
        return null
      case 'remove':
        store.remove(step.paths as string[])
        return null
      case 'search': {
        const opts = { ...(step.opts as Record<string, unknown>) }
        const within = opts.within as { prefix: string } | undefined
        if (within) opts.within = (path: string) => path.startsWith(within.prefix)
        return store.search(step.q as string, opts as never)
      }
      case 'listAll':
        return [...store.listAll().values()]
      case 'count':
        return store.count()
      case 'excerptsFor':
        return store.excerptsFor(step.paths as string[], step.q as string, step.chars as number)
      case 'pathsIndexedAsOnDisk':
        return store.pathsIndexedAsOnDisk(step.paths as string[])
      default:
        throw new Error(`no such step: ${op}`)
    }
  }
}

// ---------------------------------------------------------------------------
// rerank: SearchReranker
// ---------------------------------------------------------------------------

const idx = (name: string, text: string, age = 0) => ({
  op: 'index',
  path: `$DIR/docs/${name}`,
  text,
  age,
})
const PATH = (name: string) => `$DIR/docs/${name}`
const RE_DOCS = [
  idx('a.txt', 'alpha revenue notes for the quarter'),
  idx('b.txt', 'beta revenue forecast and budget'),
  idx('c.txt', 'gamma meeting minutes about revenue'),
  idx('d.txt', 'delta unrelated roadmap'),
]
const abc = [PATH('a.txt'), PATH('b.txt'), PATH('c.txt')]
const exact = (s: number) => score(s, s === 0 ? 1 : 0, s === 1 ? 1 : 0, s === 2 ? 1 : 0)
const three = (a: number, b: number, c: number) => ok({ d0: exact(a), d1: exact(b), d2: exact(c) })
const kevOn = withKey('kev', '')
const rr = (q: string, paths: string[], settings: Settings, script: ScriptStep[]) => ({
  op: 'rerank',
  q,
  paths,
  settings,
  script,
})

const rerankCases: Case[] = [
  {
    note: 'order by score, cache, expiry',
    args: [
      {
        steps: [
          ...RE_DOCS,
          rr('revenue', abc, kevOn, [three(0, 2, 1)]),
          rr('revenue', abc, kevOn, []),
          { op: 'clock', ms: 29 * 60 * 1000 },
          rr('revenue', abc, kevOn, []),
          { op: 'clock', ms: 31 * 60 * 1000 },
          rr('revenue', abc, kevOn, [three(2, 2, 0)]),
          rr('revenue', [...abc].reverse(), kevOn, [three(1, 1, 1)]),
          rr('other', abc, kevOn, [three(2, 0, 0)]),
          rr('revenue', abc, { ...kevOn, customModel: 'x' }, [three(0, 0, 2)]),
        ],
      },
    ],
  },
  {
    note: 'refusals before any call',
    args: [
      {
        steps: [
          ...RE_DOCS,
          rr('revenue', abc, { ...kevOn, rerank: false }, [three(0, 2, 1)]),
          rr('revenue', abc, withKey('openrouter', ''), [three(0, 2, 1)]),
          rr('revenue', abc, withKey('custom', '', { customBaseUrl: '  ' }), [three(0, 2, 1)]),
          rr('revenue', abc, withKey('cloudflare', 'k', { cloudflareAccountId: ' ' }), [
            three(0, 2, 1),
          ]),
          rr('revenue', abc, withKey('cloudflare-flash', 'k', { cloudflareAccountId: ' ' }), [
            three(0, 2, 1),
          ]),
          rr('revenue', [], kevOn, [three(0, 2, 1)]),
          rr('revenue', [PATH('a.txt')], kevOn, [three(0, 2, 1)]),
          rr('revenue', [PATH('a.txt'), PATH('none.txt')], kevOn, [three(0, 2, 1)]),
          rr('revenue', abc, withKey('direct', 'k'), [
            ok({ d0: GOOD, d1: ZERO, d2: ZERO }, { model: 'jev-1.13.0' }),
          ]),
        ],
      },
    ],
  },
  {
    note: 'files with unsaved changes and the sendable filter stay out',
    args: [
      {
        sendable: true,
        steps: [
          ...RE_DOCS,
          { op: 'unsaved', paths: [PATH('a.txt')] },
          rr('revenue', abc, kevOn, [ok({ d0: GOOD, d1: ZERO })]),
          rr('revenue', [PATH('a.txt'), PATH('b.txt')], kevOn, [ok({ d0: GOOD, d1: ZERO })]),
          { op: 'unsaved', paths: 'throws' },
          rr('revenue', abc, kevOn, [ok({ d0: GOOD, d1: ZERO })]),
          { op: 'unsaved', paths: null },
          { op: 'drop', paths: [PATH('b.txt')] },
          rr('revenue', abc, kevOn, [ok({ d0: ZERO, d1: GOOD })]),
          { op: 'drop', paths: [PATH('b.txt'), PATH('c.txt')] },
          rr('revenue', abc, kevOn, [ok({ d0: ZERO, d1: GOOD })]),
          { op: 'drop', paths: [] },
          rr('revenue', [PATH('d.txt'), ...abc], kevOn, [ok({ d0: ZERO, d1: GOOD, d2: GOOD })]),
        ],
      },
    ],
  },
  {
    note: 'a failed call is not cached; tied scores keep the local order',
    args: [
      {
        steps: [
          ...RE_DOCS,
          rr('revenue', abc, kevOn, [{ status: 500, body: '' }]),
          rr('revenue', abc, kevOn, [{ throws: 'socket hang up' }]),
          rr('revenue', abc, kevOn, [three(1, 1, 1)]),
          rr('revenue', abc, kevOn, []),
          rr('revenue minutes', abc, kevOn, [three(2, 0, 2)]),
          rr('revenue budget', abc, withKey('direct', 'k'), [ok({ d0: ZERO, d1: ZERO, d2: ZERO })]),
        ],
      },
    ],
  },
  {
    note: 'a second request for a key still out joins it',
    args: [
      {
        sendable: true,
        steps: [
          ...RE_DOCS,
          {
            op: 'both',
            calls: [
              { q: 'revenue', paths: abc },
              { q: 'revenue', paths: abc },
            ],
            settings: kevOn,
            script: [three(0, 2, 1)],
          },
          {
            op: 'both',
            calls: [
              { q: 'minutes', paths: abc },
              { q: 'budget', paths: abc },
            ],
            settings: kevOn,
            script: [three(2, 1, 0), three(0, 1, 2)],
          },
          {
            op: 'both',
            calls: [
              { q: 'roadmap', paths: abc },
              { q: 'roadmap', paths: abc },
            ],
            settings: kevOn,
            script: [{ status: 500, body: '' }],
          },
          {
            op: 'both',
            calls: [
              { q: 'roadmap', paths: abc },
              { q: 'roadmap', paths: abc },
            ],
            settings: kevOn,
            script: [three(1, 0, 2)],
          },
        ],
      },
    ],
  },
  {
    note: 'only the first 20 paths are judged and a size budget cuts the rest',
    args: [
      {
        steps: [
          ...Array.from({ length: 24 }, (_, i) => idx(`n${i}.txt`, `common note ${i}`)),
          rr(
            'common',
            Array.from({ length: 24 }, (_, i) => PATH(`n${i}.txt`)),
            kevOn,
            [ok(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`d${i}`, exact(i % 3)])))],
          ),
          ...Array.from({ length: 8 }, (_, i) =>
            idx(`cjk${i}.txt`, `rare ${'\uc138'.repeat(1250)} ${i}`),
          ),
          rr(
            'rare',
            Array.from({ length: 8 }, (_, i) => PATH(`cjk${i}.txt`)),
            kevOn,
            [
              {
                always: ok(
                  Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`d${i}`, exact(1)])),
                ),
              },
            ],
          ),
        ],
      },
    ],
  },
  {
    note: 'the cache holds 200 judgements, the oldest leaves first',
    args: [
      {
        steps: [
          ...RE_DOCS,
          {
            op: 'repeat',
            times: 201,
            q: 'q',
            paths: [PATH('a.txt'), PATH('b.txt')],
            settings: kevOn,
            script: [{ always: ok({ d0: ZERO, d1: GOOD }) }],
          },
          rr('q0', [PATH('a.txt'), PATH('b.txt')], kevOn, [{ always: ok({ d0: GOOD, d1: ZERO }) }]),
          rr('q2', [PATH('a.txt'), PATH('b.txt')], kevOn, []),
          rr('q200', [PATH('a.txt'), PATH('b.txt')], kevOn, []),
        ],
      },
    ],
  },
  {
    note: 'a blank account or custom URL is refused before the sendable filter runs',
    args: [
      {
        sendable: true,
        steps: [
          ...RE_DOCS,
          rr('revenue', abc, withKey('cloudflare', 'k', { cloudflareAccountId: '   ' }), [
            three(0, 2, 1),
          ]),
          rr('revenue', abc, withKey('custom', '', { customBaseUrl: '   ' }), [three(0, 2, 1)]),
          rr('revenue', abc, withKey('cloudflare-flash', 'k', { cloudflareAccountId: '\t' }), []),
          rr('revenue', abc, withKey('custom', 'k', { customBaseUrl: '\n' }), []),
          rr('revenue', abc, withKey('kev', ''), [three(0, 2, 1)]),
        ],
      },
    ],
  },
  {
    note: 'a 21st path is not judged and does not change the cache key',
    args: [
      {
        steps: [
          ...Array.from({ length: 21 }, (_, i) => idx(`m${i}.txt`, `common note ${i}`)),
          rr(
            'common',
            Array.from({ length: 21 }, (_, i) => PATH(`m${i}.txt`)),
            kevOn,
            [ok(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`d${i}`, exact(i % 3)])))],
          ),
          rr(
            'common',
            Array.from({ length: 20 }, (_, i) => PATH(`m${i}.txt`)),
            kevOn,
            [],
          ),
        ],
      },
    ],
  },
]

async function rerankScenario(args: unknown[], cx: TsContext): Promise<unknown> {
  const spec = args[0] as { db: string; sendable?: boolean; steps: Array<Record<string, unknown>> }
  const dbPath = spec.db
  let clock = cx.now
  let script: ScriptStep[] = []
  let dropped: string[] = []
  const store = new storeModule.FileIndexStore(dbPath)
  const reranker = new rerank.SearchReranker(
    store,
    scripted(() => script, cx.log, true),
    spec.sendable
      ? async (paths) => {
          cx.log('sendable', paths)
          return paths.filter((p) => !dropped.includes(p))
        }
      : undefined,
  )
  const realNow = Date.now
  Date.now = () => clock
  const out: unknown[] = []
  try {
    for (const step of spec.steps) {
      const op = step.op as string
      if (op === 'index') {
        const text = step.text as string
        store.upsert(
          {
            path: step.path as string,
            mtimeMs: NOW + (step.age as number),
            sizeBytes: text.length,
          },
          text,
          'ok',
        )
      } else if (op === 'clock') {
        clock = cx.now + (step.ms as number)
      } else if (op === 'drop') {
        dropped = step.paths as string[]
      } else if (op === 'unsaved') {
        const paths = step.paths as string[] | 'throws' | null
        if (paths === null) unsaved.setOpenFilesSource(null)
        else if (paths === 'throws')
          unsaved.setOpenFilesSource(() => {
            throw new Error('source failed')
          })
        else unsaved.setOpenFilesSource(() => paths.map((filePath) => ({ filePath, dirty: true })))
      } else if (op === 'rerank') {
        script = [...(step.script as ScriptStep[])]
        out.push(
          await reranker.rerank(
            step.q as string,
            step.paths as string[],
            step.settings as Settings,
          ),
        )
      } else if (op === 'repeat') {
        script = [...(step.script as ScriptStep[])]
        for (let i = 0; i < (step.times as number); i++)
          await reranker.rerank(
            `${step.q as string}${i}`,
            step.paths as string[],
            step.settings as Settings,
          )
        out.push(null)
      } else if (op === 'both') {
        script = [...(step.script as ScriptStep[])]
        const calls = step.calls as Array<{ q: string; paths: string[] }>
        const settings = step.settings as Settings
        out.push(await Promise.all(calls.map((c) => reranker.rerank(c.q, c.paths, settings))))
      } else throw new Error(`no such step: ${op}`)
    }
  } finally {
    Date.now = realNow
    unsaved.setOpenFilesSource(null)
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  }
  return out
}

// ---------------------------------------------------------------------------
// indexer: FileIndexer
// ---------------------------------------------------------------------------

interface FakeWorker {
  n: number
  handlers: Record<string, (message?: unknown) => void>
}

const file = (path: string, mtimeMs: number, sizeBytes: number) => ({ path, mtimeMs, sizeBytes })
const scanReply = (id: number, files: unknown[], truncated?: boolean) => ({
  op: 'message',
  worker: 1,
  msg: { id, type: 'scan', files, ...(truncated === undefined ? {} : { truncated }) },
})
const extractReply = (id: number, result: unknown, worker = 1) => ({
  op: 'message',
  worker,
  msg: { id, type: 'extract', result },
})
const MT = 1_700_000_100_000
const fileSpec = (text: string) => ({ text, mtimeMs: MT })
const stat = (name: string, text: string) => file(`$DIR/root/${name}`, MT, text.length)

const baseFiles = {
  'root/a.txt': fileSpec('alpha'),
  'root/b.md': fileSpec('beta'),
  'root/c.docx': fileSpec('gamma'),
}
const A = stat('a.txt', 'alpha')
const B = stat('b.md', 'beta')
const C = stat('c.docx', 'gamma')

const indexerCases: Case[] = [
  {
    note: 'a scan walks the root and extracts each changed file in turn',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          extractReply(2, { kind: 'text', text: 'alpha text' }),
          { op: 'progress' },
          extractReply(3, { kind: 'name-only' }),
          extractReply(4, { kind: 'error', error: 'bad' }),
          { op: 'progress' },
          { op: 'running' },
          { op: 'listAll' },
          { op: 'timer', n: 99 },
          { op: 'timer', n: 6 },
          { op: 'running' },
          { op: 'exit', worker: 1 },
        ],
      },
    ],
  },
  {
    note: 'refresh debounces; a refresh mid-scan runs after it; unchanged files are skipped',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'refresh' },
          { op: 'refresh' },
          { op: 'timer', n: 2 },
          { op: 'refresh' },
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'beta' }),
          extractReply(4, { kind: 'text', text: 'gamma' }),
          { op: 'scan' },
          scanReply(5, [A, B, C]),
          { op: 'refreshIfStale', maxAgeMs: 10_000 },
          { op: 'clock', ms: 20_000 },
          { op: 'refreshIfStale', maxAgeMs: 10_000 },
          scanReply(6, [A, B, C]),
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'vanished files are dropped only after a complete walk',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'beta' }),
          { op: 'scan' },
          scanReply(4, [A], true),
          { op: 'progress' },
          { op: 'scan' },
          scanReply(5, [A]),
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'a crashed or wedged worker fails its request, the queue moves on',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        requestTimeoutMs: 500,
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          { op: 'error', worker: 1 },
          { op: 'exit', worker: 1 },
          { op: 'running' },
          { op: 'timer', n: 5 },
          { op: 'exit', worker: 2 },
          { op: 'running' },
          {
            op: 'message',
            worker: 3,
            msg: { id: 4, type: 'extract', result: { kind: 'text', text: 'late' } },
          },
          extractReply(4, { kind: 'text', text: 'gamma' }, 3),
        ],
      },
    ],
  },
  {
    note: 'a walk that fails leaves the index alone',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'beta' }),
          extractReply(4, { kind: 'text', text: 'gamma' }),
          { op: 'roots', roots: ['$DIR/root', '$DIR/elsewhere'] },
          { op: 'scan' },
          scanReply(5, [A]),
          { op: 'error', worker: 1 },
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'a file changed in size only, or in time only, is extracted again',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'beta' }),
          extractReply(4, { kind: 'text', text: 'gamma' }),
          { op: 'scan' },
          scanReply(5, [file(A.path, MT, 6), file(B.path, MT + 1000, B.sizeBytes), C]),
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'a file already queued is not queued twice',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B]),
          { op: 'scan' },
          scanReply(3, [A, B]),
          { op: 'progress' },
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(4, { kind: 'text', text: 'beta' }),
          extractReply(5, { kind: 'text', text: 'alpha again' }),
          { op: 'progress' },
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'an idle worker is retired, a busy one is not',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        workerIdleMs: 1000,
        steps: [
          { op: 'scan' },
          scanReply(1, [A]),
          { op: 'timer', n: 3 },
          { op: 'running' },
          extractReply(2, { kind: 'text', text: 'alpha' }),
          { op: 'timer', n: 4 },
          { op: 'running' },
          { op: 'exit', worker: 1 },
          { op: 'scan' },
          { op: 'running' },
        ],
      },
    ],
  },
  {
    note: 'the nameOnly source: some files by name only, a failing source, a pending answer',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { answer: ['$DIR/root/b.md'] },
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B, C]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'gamma' }),
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'a failing nameOnly source leaves every file name-only; a cloud file is looked at again',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { throws: true },
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B]),
          { op: 'listAll' },
          { op: 'nameOnlyMode', mode: { answer: ['$DIR/root/a.txt'] } },
          { op: 'scan' },
          scanReply(2, [A, B]),
          extractReply(3, { kind: 'text', text: 'beta' }),
          { op: 'listAll' },
          { op: 'nameOnlyMode', mode: { answer: [] } },
          { op: 'scan' },
          scanReply(4, [A, B]),
          extractReply(5, { kind: 'text', text: 'alpha' }),
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'a pending nameOnly decision holds the diff until it is answered',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: 'pending',
        steps: [
          { op: 'scan' },
          scanReply(1, [A, B]),
          { op: 'progress' },
          { op: 'scan' },
          { op: 'nameOnly', answer: ['$DIR/root/a.txt'] },
          extractReply(2, { kind: 'text', text: 'beta' }),
          { op: 'progress' },
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'extra paths are indexed when they are supported files and exist',
    files: { ...baseFiles, 'extra/x.docx': fileSpec('xx'), 'extra/y.zip': fileSpec('yy') },
    args: [
      {
        roots: ['$DIR/root'],
        extra: ['$DIR/extra/x.docx', '$DIR/extra/y.zip', '$DIR/extra/none.docx', '$DIR/root/a.txt'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'xx' }),
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'a file that vanished or changed while queued is re-stat-ed',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A, file('$DIR/root/ghost.txt', MT, 3), B]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          extractReply(3, { kind: 'text', text: 'beta' }),
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'a worker that cannot start or post answers as an extraction error; stop ends it',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'failNext', spawn: 'no thread' },
          { op: 'scan' },
          { op: 'progress' },
          { op: 'running' },
          { op: 'failNext', post: 'channel closed' },
          { op: 'scan' },
          { op: 'running' },
          { op: 'scan' },
          scanReply(3, [A, B]),
          { op: 'stop' },
          { op: 'running' },
          { op: 'progress' },
          { op: 'refresh' },
          { op: 'scan' },
          extractReply(4, { kind: 'text', text: 'alpha' }),
        ],
      },
    ],
  },
  {
    note: 'name-only rows yield to the event loop every 64',
    files: Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`root/f${i}.txt`, fileSpec(`t${i}`)]),
    ),
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { answer: Array.from({ length: 70 }, (_, i) => `$DIR/root/f${i}.txt`) },
        steps: [
          { op: 'scan' },
          scanReply(
            1,
            Array.from({ length: 70 }, (_, i) => stat(`f${i}.txt`, `t${i}`)),
          ),
          { op: 'progress' },
          { op: 'immediate' },
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'a scan stamps its time: refreshIfStale skips a fresh index and rescans a stale one',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        steps: [
          { op: 'scan' },
          scanReply(1, [A]),
          extractReply(2, { kind: 'text', text: 'alpha' }),
          { op: 'refreshIfStale', maxAgeMs: 10_000 },
          { op: 'progress' },
          { op: 'clock', ms: 20_000 },
          { op: 'refreshIfStale', maxAgeMs: 10_000 },
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'nameOnly is asked only when a scan has files to index; an unchanged scan does not ask',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { answer: [] },
        steps: [
          { op: 'scan' },
          scanReply(1, []),
          { op: 'scan' },
          scanReply(2, [A]),
          extractReply(3, { kind: 'text', text: 'alpha' }),
          { op: 'scan' },
          scanReply(4, [A]),
          { op: 'listAll' },
        ],
      },
    ],
  },
  {
    note: 'a worker that never answers: the request times out and the worker is retired',
    files: baseFiles,
    args: [
      {
        roots: ['$DIR/root'],
        requestTimeoutMs: 500,
        steps: [
          { op: 'scan' },
          scanReply(1, [A]),
          { op: 'running' },
          { op: 'timer', n: 2 },
          { op: 'running' },
          { op: 'listAll' },
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'name-only rows queued behind an extraction yield after the 64th',
    files: Object.fromEntries(
      Array.from({ length: 71 }, (_, i) => [`root/f${i}.txt`, fileSpec(`t${i}`)]),
    ),
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { answer: Array.from({ length: 70 }, (_, i) => `$DIR/root/f${i + 1}.txt`) },
        steps: [
          { op: 'scan' },
          scanReply(
            1,
            Array.from({ length: 71 }, (_, i) => stat(`f${i}.txt`, `t${i}`)),
          ),
          { op: 'progress' },
          extractReply(2, { kind: 'text', text: 't0' }),
          { op: 'progress' },
          { op: 'immediate' },
          { op: 'progress' },
        ],
      },
    ],
  },
  {
    note: 'exactly 64 name-only rows behind an extraction: the 64th yields with nothing left',
    files: Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`root/f${i}.txt`, fileSpec(`t${i}`)]),
    ),
    args: [
      {
        roots: ['$DIR/root'],
        nameOnly: { answer: Array.from({ length: 64 }, (_, i) => `$DIR/root/f${i + 1}.txt`) },
        steps: [
          { op: 'scan' },
          scanReply(
            1,
            Array.from({ length: 65 }, (_, i) => stat(`f${i}.txt`, `t${i}`)),
          ),
          extractReply(2, { kind: 'text', text: 't0' }),
          { op: 'progress' },
          { op: 'immediate' },
          { op: 'progress' },
        ],
      },
    ],
  },
]

async function indexerScenario(args: unknown[], cx: TsContext): Promise<unknown> {
  const spec = args[0] as {
    db: string
    roots: string[]
    extra?: string[]
    nameOnly?: unknown
    requestTimeoutMs?: number
    workerIdleMs?: number
    steps: Array<Record<string, unknown>>
  }
  const dbPath = spec.db
  const log = cx.log
  const realSetImmediate = globalThis.setImmediate
  const saved = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setImmediate: globalThis.setImmediate,
    now: Date.now,
  }
  let clock = cx.now
  let nextTimer = 1
  const timers = new Map<number, () => void>()
  let immediates: Array<() => void> = []
  const workers: FakeWorker[] = []
  let nextSpawn: string | null = null
  let nextPost: string | null = null
  let nameOnlyMode = spec.nameOnly
  const nameOnlyHolder: {
    pendingNameOnly: { resolve: (v: Set<string>) => void; reject: (e: Error) => void } | null
  } = { pendingNameOnly: null }
  const wrapped = new WeakMap<object, FakeWorker>()
  const byRef = new Map<number, object>()
  const world = {
    spawn(
      ref: { handlers: FakeWorker['handlers'] },
      options: { resourceLimits?: { maxOldGenerationSizeMb?: number } },
    ) {
      const n = workers.length + 1
      log('spawn', n, options.resourceLimits?.maxOldGenerationSizeMb)
      if (nextSpawn !== null) {
        const message = nextSpawn
        nextSpawn = null
        throw new Error(message)
      }
      const w: FakeWorker = { n, handlers: ref.handlers }
      workers.push(w)
      wrapped.set(ref, w)
      byRef.set(n, ref)
    },
    post(ref: object, message: unknown) {
      const w = wrapped.get(ref)!
      log('post', w.n, message)
      if (nextPost !== null) {
        const text = nextPost
        nextPost = null
        throw new Error(text)
      }
    },
    terminate(ref: object) {
      log('terminate', wrapped.get(ref)!.n)
      return Promise.resolve(0)
    },
  }
  ;(globalThis as Record<symbol, unknown>)[WORLD] = world
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const n = nextTimer++
    timers.set(n, fn)
    log('setTimeout', n, ms)
    return { n, unref() {} }
  }) as never
  globalThis.clearTimeout = ((handle: { n: number }) => {
    log('clearTimeout', handle.n)
    timers.delete(handle.n)
  }) as never
  globalThis.setImmediate = ((fn: () => void) => {
    immediates.push(fn)
    log('setImmediate')
  }) as never
  Date.now = () => clock
  const flush = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve))

  const store = new storeModule.FileIndexStore(dbPath)
  let roots = spec.roots
  const sources = {
    roots: () => {
      log('roots')
      return roots
    },
    extraPaths: () => {
      log('extraPaths')
      return spec.extra ?? []
    },
    ...(spec.nameOnly === undefined
      ? {}
      : {
          nameOnly: (paths: readonly string[]) => {
            log('nameOnly', paths)
            const mode = nameOnlyMode as 'pending' | { answer?: string[]; throws?: boolean }
            if (mode === 'pending')
              return new Promise<Set<string>>((resolve, reject) => {
                nameOnlyHolder.pendingNameOnly = { resolve, reject }
              })
            if (mode.throws) return Promise.reject(new Error('source failed'))
            return Promise.resolve(new Set(mode.answer ?? []))
          },
        }),
  }
  const indexer = new indexerModule.FileIndexer(
    store,
    '/worker.js',
    sources,
    spec.requestTimeoutMs,
    undefined,
    spec.workerIdleMs,
  )
  const out: unknown[] = []
  try {
    for (const step of spec.steps) {
      const op = step.op as string
      let result: unknown = null
      switch (op) {
        case 'refresh':
          indexer.refresh()
          break
        case 'refreshIfStale':
          indexer.refreshIfStale(step.maxAgeMs as number)
          break
        case 'scan':
          void indexer.scan().catch(() => {})
          break
        case 'stop':
          indexer.stop()
          break
        case 'clock':
          clock = cx.now + (step.ms as number)
          break
        case 'timer': {
          const fn = timers.get(step.n as number)
          if (fn) {
            timers.delete(step.n as number)
            fn()
          }
          break
        }
        case 'immediate': {
          const run = immediates
          immediates = []
          for (const fn of run) fn()
          break
        }
        case 'message':
          workers.find((w) => w.n === step.worker)?.handlers.message?.(step.msg)
          break
        case 'error':
          workers.find((w) => w.n === step.worker)?.handlers.error?.(new Error('worker crashed'))
          break
        case 'exit':
          workers.find((w) => w.n === step.worker)?.handlers.exit?.(1)
          break
        case 'failNext':
          if (step.spawn !== undefined) nextSpawn = step.spawn as string
          if (step.post !== undefined) nextPost = step.post as string
          break
        case 'nameOnlyMode':
          nameOnlyMode = step.mode
          break
        case 'nameOnly': {
          const pending = nameOnlyHolder.pendingNameOnly
          nameOnlyHolder.pendingNameOnly = null
          if (pending) pending.resolve(new Set(step.answer as string[]))
          break
        }
        case 'roots':
          roots = step.roots as string[]
          break
        case 'progress':
          result = indexer.progress()
          break
        case 'running':
          result = indexer.workerIsRunning()
          break
        case 'listAll':
          result = [...store.listAll().values()]
          break
        default:
          throw new Error(`no such step: ${op}`)
      }
      await flush()
      out.push(result)
    }
    return out
  } finally {
    indexer.stop()
    delete (globalThis as Record<symbol, unknown>)[WORLD]
    globalThis.setTimeout = saved.setTimeout
    globalThis.clearTimeout = saved.clearTimeout
    globalThis.setImmediate = saved.setImmediate
    Date.now = saved.now
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  }
}

// ---------------------------------------------------------------------------
// the part
// ---------------------------------------------------------------------------

/** the scenario's database file lies in the case's folder */
const withDb = (list: Case[], name: string): Case[] =>
  list.map((c) => ({ ...c, args: [{ ...(c.args[0] as object), db: `$DIR/${name}` }] }))

const asc = (name: string, fn: FnSpec['ts'], cs: Case[], single?: string): [string, FnSpec] => [
  name,
  { ts: fn, cases: cs, ...(single ? { single } : {}) },
]

export const part: Group = Object.fromEntries([
  asc(
    'home-api.isCloudflareEndpoint',
    (a) => homeApi.isCloudflareEndpoint(a[0] as never),
    cases(...ENDPOINTS.map((e) => [e])),
  ),
  asc(
    'decider.isLocalEndpoint',
    (a) => decider.isLocalEndpoint(a[0] as never),
    cases(...ENDPOINTS.map((e) => [e])),
  ),
  asc('decider.endpointUrl', (a) => decider.endpointUrl(a[0] as Opts), urlCases),
  asc('decider.bodyModel', (a) => decider.bodyModel(a[0] as Opts), bodyModelCases),
  asc('decider.MAX_DOCS', () => decider.MAX_DOCS, cases([]), 'a constant'),
  asc(
    'decider.prepare',
    (a) => decider.prepare(a[0] as string, a[1] as never, a[2] as Opts),
    prepareCases,
  ),
  asc(
    'decider.validate',
    (a) => decider.validate(a[0], a[1] as number, a[2] as never),
    validateCases,
  ),
  asc('decider.fetchTransport', fetchTransportCall, fetchCases),
  asc(
    'decider.evaluate',
    (a, cx) => {
      const script = [...(a[3] as ScriptStep[])]
      return withClock(cx.now, () =>
        decider.evaluate(
          a[0] as string,
          a[1] as never,
          a[2] as Opts,
          scripted(() => script, cx.log),
        ),
      )
    },
    evaluateCases,
  ),
  asc(
    'rerank.DEFAULT_FILE_SEARCH_SETTINGS',
    () => rerank.DEFAULT_FILE_SEARCH_SETTINGS,
    cases([]),
    'a constant',
  ),
  asc(
    'rerank.normalizeFileSearchSettings',
    (a) => rerank.normalizeFileSearchSettings(a[0]),
    normalizeCases,
  ),
  asc('rerank.probeDecision', probeCall, probeCases),
  asc('rerank.SearchReranker', rerankScenario, withDb(rerankCases, 'rerank.db')),
  asc('store.FileIndexStore', storeScenario, storeCases),
  asc('indexer.FileIndexer', indexerScenario, withDb(indexerCases, 'index.db')),
])
