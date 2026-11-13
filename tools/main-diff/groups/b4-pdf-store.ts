/**
 * Group `b4-pdf-store`: the result store of `packages/pdf-structure/src/store/`
 * (decision 0030, batch B4) and the small pieces it imports: `tree/hash`,
 * `tree/inline` (`runsText`) and `highlight/run-id`.
 *
 * `pdf-structure/store.<method>` runs one method of a `ResultStore` over the
 * case's real folder: its first argument is `{ dir, runningWindowMs? }` (the
 * user-data folder and the store's options) and its clock is the call's. The
 * rest are the method's own arguments; a `null` is an argument left out (the
 * wrapper hands the TypeScript `undefined`). A `Map` answer is an array of
 * `[key, value]` pairs. The files a case needs are written out as the store
 * writes them, so a read sees what an earlier run left; a case's answer and
 * the folder after the call are the comparison.
 *
 * The Rust types the enumerations the TypeScript checks at run time (job
 * kind, translation mode, block status, job state, highlight status and
 * state, passage kind), so no case passes an invalid one.
 *
 * Temp and lock files of the writers are gone when a call ends, so the
 * folder after it holds only entries. A stale lock is made by an old
 * modification time or a pid no process has.
 */
import {
  fileExists,
  folderSize,
  isTempName,
  listNames,
  lockPathOf,
  readJson,
  removeEntry,
  removeFolder,
  writeJsonAtomic,
} from '../../../packages/pdf-structure/src/store/files.ts'
import {
  blockKeyString,
  normalizeSourceText,
  translationBlockKeys,
} from '../../../packages/pdf-structure/src/store/keys.ts'
import { asNoteLinks } from '../../../packages/pdf-structure/src/store/note-links.ts'
import {
  asHighlightBlock,
  asHighlightRun,
  asInsights,
  asPassageCard,
  isSegment,
} from '../../../packages/pdf-structure/src/store/reading.ts'
import {
  sentenceEndsPair,
  validSentenceEnds,
} from '../../../packages/pdf-structure/src/store/sentence-ends.ts'
import { ResultStore } from '../../../packages/pdf-structure/src/store/store.ts'
import {
  highlightRunId,
  normalizeLabelName,
} from '../../../packages/pdf-structure/src/highlight/run-id.ts'
import { sha256Hex } from '../../../packages/pdf-structure/src/tree/hash.ts'
import { runsText } from '../../../packages/pdf-structure/src/tree/inline.ts'
import type { InlineRun } from '../../../packages/pdf-structure/src/tree/types.ts'
import type { Case, FileSpec, FnSpec, Group } from '../types.ts'

type Files = Record<string, FileSpec>

/** the clock of every call (main.ts): 2026-11-12T03:00:00.000Z */
const NOW = 1_794_452_400_000

// ── the wrapper of a store method ──

interface StoreOptions {
  dir: string
  runningWindowMs?: number
}

type StoreMethod = (...args: unknown[]) => unknown

/** Maps become arrays of `[key, value]` pairs, as the Rust side answers them */
function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([k, v]) => [k, plain(v)])
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

function store(method: string): FnSpec['ts'] {
  return async (args, cx) => {
    const [options, ...rest] = args as [StoreOptions, ...unknown[]]
    const s = new ResultStore(options.dir, {
      now: () => cx.now,
      runningWindowMs: options.runningWindowMs,
    })
    const call = (s as unknown as Record<string, StoreMethod>)[method]!
    return plain(
      await call.apply(
        s,
        rest.map((a) => (a === null ? undefined : a)),
      ),
    )
  }
}

// ── builders ──

const O: StoreOptions = { dir: '$DIR' }
const S = 'pdf-store'
const D1 = 'docOld'
const D2 = 'docNew'

const c = (args: unknown[], files?: Files, note?: string): Case => ({ args, files, note })
const j = (v: unknown): string => JSON.stringify(v)
const merge = (...parts: Files[]): Files => Object.assign({}, ...parts)

const K = (pageFingerprint = 'fpA', textHash = 'h1', occurrence = 0) => ({
  pageFingerprint,
  textHash,
  occurrence,
})

const docDir = (doc: string): string => `${S}/docs/${doc}`

// AI-read pages
const aiPath = (doc: string, fp: string): string => `${docDir(doc)}/ai-read/${fp}.json`
const aiRecord = (fp: string, savedAt: number, extra: Record<string, unknown> = {}) => ({
  format: 1,
  pageFingerprint: fp,
  payload: { version: 1, body: `page ${fp}` },
  savedAt,
  ...extra,
})
const aiFile = (doc: string, fp: string, savedAt: number, extra = {}): Files => ({
  [aiPath(doc, fp)]: j(aiRecord(fp, savedAt, extra)),
})

// translations
const trDir = (doc: string, lang: string, mode = 'translate'): string =>
  `${docDir(doc)}/${mode === 'easy' ? 'easy' : 'translations'}/${lang}`
const metaFile = (doc: string, lang: string, savedAt: number, mode = 'translate'): Files => ({
  [`${trDir(doc, lang, mode)}/translation.json`]: j({
    format: 1,
    lang,
    provider: 'openai',
    model: 'm1',
    savedAt,
  }),
})
const blkPath = (doc: string, lang: string, k: ReturnType<typeof K>, mode = 'translate'): string =>
  `${trDir(doc, lang, mode)}/blocks/${k.pageFingerprint}/${k.textHash}.${k.occurrence}.json`
const blkFile = (
  doc: string,
  lang: string,
  k: ReturnType<typeof K>,
  over: Record<string, unknown> = {},
  mode = 'translate',
): Files => ({
  [blkPath(doc, lang, k, mode)]: j({
    format: 1,
    key: k,
    status: 'translated',
    savedAt: NOW - 1000,
    text: 'hello',
    ...over,
  }),
})

// job records
const jobPath = (doc: string, name: string): string => `${docDir(doc)}/jobs/${name}.json`
const jobRecord = (kind: string, over: Record<string, unknown> = {}) => ({
  format: 1,
  kind,
  state: 'running',
  outputs: [],
  updatedAt: NOW - 1000,
  ...over,
})
const jobFile = (doc: string, name: string, kind: string, over = {}): Files => ({
  [jobPath(doc, name)]: j(jobRecord(kind, over)),
})

// reading entries
/** what a caller writes: the store stamps savedAt */
function withoutSavedAt<T extends { savedAt: number }>(entry: T): Omit<T, 'savedAt'> {
  const { savedAt: _stamped, ...rest } = entry
  return rest
}
const card = (id: string, fp: string, savedAt: number, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'explain',
  page: 1,
  pageFingerprint: fp,
  quads: [[1, 2, 3, 4, 5, 6, 7, 8]],
  excerpt: 'excerpt',
  passageHash: 'ph',
  text: 'answer',
  provider: 'p',
  model: 'm',
  createdAt: NOW - 5000,
  savedAt,
  ...over,
})
const cardFile = (doc: string, cd: ReturnType<typeof card>): Files => ({
  [`${docDir(doc)}/passages/${cd.id}.json`]: j({ format: 1, ...cd }),
})
const run = (runId = 'run1', over: Record<string, unknown> = {}) => ({
  runId,
  presetId: 'research',
  labels: [{ id: 'l1', name: 'Claim', color: [1, 0.5, 0] }],
  pages: [1, 2],
  provider: 'p',
  model: 'm',
  createdAt: NOW - 9000,
  ...over,
})
const runFile = (doc: string, r: ReturnType<typeof run>, savedAt: number): Files => ({
  [`${docDir(doc)}/highlights/${r.runId}/run.json`]: j({ format: 1, ...r, savedAt }),
})
const hBlock = (k: ReturnType<typeof K>, over: Record<string, unknown> = {}) => ({
  key: k,
  status: 'done',
  suggestions: [
    { id: 's1', labelId: 'l1', quote: 'q1', state: 'pending' },
    { id: 's2', labelId: 'l1', quote: 'q2', state: 'pending' },
  ],
  savedAt: NOW - 4000,
  ...over,
})
const hBlockPath = (doc: string, runId: string, k: ReturnType<typeof K>): string =>
  `${docDir(doc)}/highlights/${runId}/blocks/${k.pageFingerprint}/${k.textHash}.${k.occurrence}.json`
const hBlockFile = (doc: string, runId: string, b: ReturnType<typeof hBlock>): Files => ({
  [hBlockPath(doc, runId, b.key)]: j({ format: 1, ...b }),
})
const insights = (lang = 'en', fps = ['fpA'], over: Record<string, unknown> = {}) => ({
  lang,
  summary3: ['a', 'b', 'c'],
  summary: 'summary',
  terms: [{ term: 't', meaning: 'm', page: 1 }],
  provider: 'p',
  model: 'm',
  createdAt: NOW - 3000,
  pageFingerprints: fps,
  ...over,
})
const insFile = (doc: string, ins: ReturnType<typeof insights>, savedAt: number): Files => ({
  [`${docDir(doc)}/insights/${ins.lang}.json`]: j({ format: 1, ...ins, savedAt }),
})

// note links: the notes are files every machine has, so a fixture can name them
const NOTE_A = '/etc/hosts'
const NOTE_B = '/etc/passwd'
const GONE = '/nonexistent-main-diff/note.md'
const PDF_A = '/tmp/main-diff-pdfs/a.pdf'
const PDF_B = '/tmp/main-diff-pdfs/b.pdf'
const linksFile = (links: Record<string, unknown>): Files => ({
  [`${S}/note-links.json`]: j({ version: 1, links }),
})
const link = (notePath: string, docHash: string, updatedAt: number) => ({
  notePath,
  docHash,
  updatedAt,
})

// the document `migrateDocument` starts from
const oldDocument = (): Files =>
  merge(
    aiFile(D1, 'fpA', NOW - 5000),
    aiFile(D1, 'fpB', NOW - 5000),
    aiFile(D1, 'fpC', NOW - 5000),
    metaFile(D1, 'en', NOW - 5000),
    blkFile(D1, 'en', K('fpA', 'h1', 0), { savedAt: NOW - 5000 }),
    blkFile(D1, 'en', K('fpB', 'h2', 0), { savedAt: NOW - 5000, edited: true }),
    blkFile(D1, 'en', K('fpC', 'h3', 0), { savedAt: NOW - 5000 }),
    metaFile(D1, 'ko', NOW - 5000, 'easy'),
    blkFile(D1, 'ko', K('fpA', 'h1', 0), { savedAt: NOW - 5000 }, 'easy'),
    cardFile(D1, card('c1', 'fpA', NOW - 5000)),
    cardFile(D1, card('c2', 'fpC', NOW - 5000)),
    runFile(D1, run('run1'), NOW - 5000),
    hBlockFile(D1, 'run1', hBlock(K('fpA', 'h1', 0), { savedAt: NOW - 5000 })),
    hBlockFile(D1, 'run1', hBlock(K('fpC', 'h3', 0), { savedAt: NOW - 5000 })),
    insFile(D1, insights('en', ['fpA', 'fpB']), NOW - 5000),
    insFile(D1, insights('ko', ['fpA', 'fpC']), NOW - 5000),
  )

const BLOCKED: Files = { [S]: 'a file where the store folder goes' }

const MIGRATE = { oldDocHash: D1, newDocHash: D2, pageFingerprints: ['fpA', 'fpB'] }

const text = (t: string): InlineRun => ({ kind: 'text', text: t }) as InlineRun

// ── the specs ──

export const group: Group = {
  // ── the store ──
  'pdf-structure/store.ResultStore': {
    ts: (args, cx) => {
      const [options] = args as [StoreOptions]
      const s = new ResultStore(options.dir, { now: () => cx.now })
      return { dir: s.dir }
    },
    cases: [
      c([O], undefined, 'an absolute folder'),
      c([{ dir: 'relative/dir' }], undefined, 'a relative folder is refused'),
      c([{ dir: '$DIR/.genoffice' }], undefined, 'the upstream home is refused'),
      c([{ dir: '$DIR/.GenOffice/x' }], undefined, 'also in another case, deeper down'),
      c([{ dir: '$DIR/gen.office' }], undefined, 'a name that only looks like it'),
    ],
  },

  // paths
  'pdf-structure/store.documentDir': {
    ts: store('documentDir'),
    cases: [
      c([O, D1]),
      c([O, 'bad/hash']),
      c([O, '']),
      c([O, 'x'.repeat(128)], undefined, 'longest segment'),
      c([O, 'x'.repeat(129)], undefined, 'one too long'),
    ],
  },
  'pdf-structure/store.aiReadPagePath': {
    ts: store('aiReadPagePath'),
    cases: [
      c([O, D1, 'fpA']),
      c([O, D1, 'a/b']),
      c([O, 'bad hash', 'a/b'], undefined, 'document first'),
    ],
  },
  'pdf-structure/store.translationDir': {
    ts: store('translationDir'),
    cases: [
      c([O, D1, 'en']),
      c([O, D1, 'en', 'easy']),
      c([O, D1, 'e n']),
      c([O, 'bad hash', 'e n'], undefined, 'document first'),
    ],
  },
  'pdf-structure/store.translationMetaPath': {
    ts: store('translationMetaPath'),
    cases: [c([O, D1, 'en']), c([O, D1, 'en', 'easy']), c([O, D1, ''])],
  },
  'pdf-structure/store.translationBlockPath': {
    ts: store('translationBlockPath'),
    cases: [
      c([O, D1, 'en', K()]),
      c([O, D1, 'en', K('fpA', 'h1', 7), 'easy']),
      c([O, D1, 'en', K('fpA', 'h1', -1)], undefined, 'negative occurrence'),
      c([O, D1, 'en', K('fpA', 'h1', 1.5)], undefined, 'fractional occurrence'),
      c([O, 'bad hash', 'e n', K('fpA', 'h1', -1)], undefined, 'occurrence before the rest'),
      c([O, D1, 'en', K('fpA', 'h/1', 0)], undefined, 'text hash'),
      c([O, D1, 'en', K('f p', 'h1', 0)], undefined, 'page fingerprint'),
      c([O, D1, 'e n', K()], undefined, 'language'),
    ],
  },
  'pdf-structure/store.jobPath': {
    ts: store('jobPath'),
    cases: [
      c([O, D1, 'ai-read']),
      c([O, D1, 'ai-read', 'ignored'], undefined, 'ai-read has no key'),
      c([O, D1, 'translate', 'en']),
      c([O, D1, 'translate', 'en', 'easy']),
      c([O, D1, 'translate-page', 'en', 'easy']),
      c([O, D1, 'highlight', 'run1']),
      c([O, D1, 'summary', 'ko']),
      c([O, D1, 'summary', 'ko', 'easy'], undefined, 'summary has no easy mode'),
      c([O, D1, 'highlight', 'run1', 'easy'], undefined, 'nor highlight'),
      c([O, D1, 'translate'], undefined, 'no language'),
      c([O, D1, 'highlight', 'run 1'], undefined, 'run id'),
      c([O, 'bad hash', 'translate', 'e n'], undefined, 'key before document'),
      c([O, 'bad hash', 'translate', 'en'], undefined, 'document'),
    ],
  },
  'pdf-structure/store.passagePath': {
    ts: store('passagePath'),
    cases: [c([O, D1, 'card1']), c([O, D1, 'a.b'])],
  },
  'pdf-structure/store.highlightRunDir': {
    ts: store('highlightRunDir'),
    cases: [c([O, D1, 'run1']), c([O, D1, 'run/1']), c([O, 'bad hash', 'run 1'])],
  },
  'pdf-structure/store.highlightBlockPath': {
    ts: store('highlightBlockPath'),
    cases: [
      c([O, D1, 'run1', K()]),
      c([O, D1, 'run1', K('fpA', 'h1', -2)], undefined, 'occurrence'),
      c([O, D1, 'run 1', K('fpA', 'h1', -2)], undefined, 'run before occurrence'),
      c([O, D1, 'run1', K('fpA', 'h 1', 0)], undefined, 'text hash'),
    ],
  },
  'pdf-structure/store.insightsPath': {
    ts: store('insightsPath'),
    cases: [c([O, D1, 'en']), c([O, D1, 'e.n'])],
  },
  'pdf-structure/store.noteLinksPath': {
    ts: store('noteLinksPath'),
    cases: [c([O]), c([{ dir: '$DIR/inner' }])],
  },

  // AI-read pages
  'pdf-structure/store.writeAiReadPage': {
    ts: store('writeAiReadPage'),
    cases: [
      c(
        [O, D1, 'fpA', { version: 1, body: 'x' }, { provider: 'openai', model: 'm1' }],
        undefined,
        'fresh with meta',
      ),
      c([O, D1, 'fpA', { version: 2, body: 'x' }], undefined, 'no meta'),
      c([O, D1, 'fpA', { version: 1 }, { provider: 'only' }], undefined, 'a provider alone'),
      c(
        [O, D1, 'fpA', { version: 1, n: [1, { a: 'b' }] }, { model: 'only' }],
        undefined,
        'a model alone',
      ),
      c([O, D1, 'fpA', { version: 3, body: 'new' }], aiFile(D1, 'fpA', 5), 'replaces the page'),
      c([O, D1, 'fpA', { body: 'x' }], undefined, 'no version'),
      c([O, D1, 'fpA', { version: '1' }], undefined, 'a version that is no number'),
      c([O, D1, 'fpA', null], undefined, 'no payload'),
      c([O, D1, 'fpA', [1, 2]], undefined, 'an array payload'),
      c([O, D1, 'a/b', { version: 1 }], undefined, 'page fingerprint'),
      c([O, 'bad hash', 'fpA', { version: 1 }], undefined, 'document hash'),
      c([O, D1, 'fpA', { version: 1 }], BLOCKED, 'the store folder is a file'),
    ],
  },
  'pdf-structure/store.readAiReadPage': {
    ts: store('readAiReadPage'),
    cases: [
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW - 5, { provider: 'openai', model: 'm1' })),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW - 5), 'no meta'),
      c([O, D1, 'fpA'], undefined, 'missing'),
      c([O, 'bad hash', 'fpA'], undefined, 'document hash'),
      c([O, D1, 'a/b'], undefined, 'page fingerprint'),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW, { format: 2 }), 'other format'),
      c([O, D1, 'fpA'], { [aiPath(D1, 'fpA')]: j(aiRecord('fpB', NOW)) }, 'other page'),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW, { provider: 7 }), 'provider that is no string'),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW, { model: null }), 'a null model'),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW, { payload: { version: '1' } }), 'payload version'),
      c([O, D1, 'fpA'], aiFile(D1, 'fpA', NOW, { savedAt: 'x' }), 'savedAt'),
      c([O, D1, 'fpA'], { [aiPath(D1, 'fpA')]: '{"format":1,' }, 'cut off'),
      c(
        [O, D1, 'fpA'],
        { [aiPath(D1, 'fpA')]: `\uFEFF${j(aiRecord('fpA', NOW))}` },
        'a byte-order mark',
      ),
    ],
  },
  'pdf-structure/store.readAiReadPages': {
    ts: store('readAiReadPages'),
    cases: [
      c(
        [O, D1],
        merge(
          aiFile(D1, 'fpB', NOW - 2),
          aiFile(D1, 'fpA', NOW - 1, { provider: 'p' }),
          { [aiPath(D1, 'notes.txt').replace('.json', '')]: 'not json' },
          { [`${docDir(D1)}/ai-read/.fpC.json.lock`]: '{}' },
          { [aiPath(D1, 'bad name')]: j(aiRecord('bad name', NOW)) },
          { [aiPath(D1, 'fpD')]: j(aiRecord('fpA', NOW)) },
          { [`${docDir(D1)}/ai-read/fpE.json/inner`]: 'a folder named like a page' },
        ),
        'names sorted, the others skipped',
      ),
      c([O, D1], undefined, 'no folder'),
      c([O, 'bad hash'], aiFile('bad hash', 'fpA', NOW), 'document hash'),
    ],
  },

  // translations
  'pdf-structure/store.writeTranslationMeta': {
    ts: store('writeTranslationMeta'),
    cases: [
      c([O, D1, 'en', { provider: 'openai', model: 'm1' }]),
      c([O, D1, 'en', { provider: 'openai', model: 'm1' }, 'easy']),
      c([O, D1, 'en', { provider: 'anthropic', model: 'm2' }], metaFile(D1, 'en', 5), 'replaces'),
      c([O, D1, 'e n', { provider: 'openai', model: 'm1' }], undefined, 'language'),
      c([O, D1, 'en', { provider: 'openai', model: 'm1' }], BLOCKED, 'the store folder is a file'),
    ],
  },
  'pdf-structure/store.writeTranslationBlock': {
    ts: store('writeTranslationBlock'),
    cases: [
      c([O, D1, 'en', { key: K(), status: 'translated', text: 'hello' }]),
      c([O, D1, 'en', { key: K(), status: 'translated', text: 'hello' }, 'easy']),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K('fpA', 'h1', 3),
            status: 'translated',
            text: 'hi',
            runs: [{ kind: 'text', text: 'hi' }],
          },
        ],
        undefined,
        'with runs',
      ),
      c([O, D1, 'en', { key: K(), status: 'failed', reason: 'rate-limit' }]),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'failed',
            text: 'half',
            runs: [{ kind: 'text', text: 'half' }],
            reason: 'cut',
          },
        ],
        undefined,
        'a failed block keeps what it has',
      ),
      c([O, D1, 'en', { key: K(), status: 'translated' }], undefined, 'no text'),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: 'my edit', edited: true }],
        undefined,
        'an edit',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: 'my edit', edited: false }],
        undefined,
        'edited false',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'failed', text: 'my edit', edited: true }],
        undefined,
        'edited and failed',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: 'my edit', edited: true, runs: [] }],
        undefined,
        'edited with runs',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: '  \n ', edited: true }],
        undefined,
        'edited blank',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'failed', edited: true }],
        undefined,
        'edited failed without text',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'translated',
            text: 'Hello world',
            sourceSentenceEnds: [6, 12],
            sentenceEnds: [5, 11],
          },
        ],
        undefined,
        'sentence ends kept',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'translated',
            text: '😀 hi',
            sourceSentenceEnds: [3, 7],
            sentenceEnds: [2, 5],
          },
        ],
        undefined,
        'ends in UTF-16 units',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'translated',
            text: 'Hello world',
            sourceSentenceEnds: [6, 12],
            sentenceEnds: [5, 10],
          },
        ],
        undefined,
        'ends that stop short are dropped',
      ),
      c(
        [
          O,
          D1,
          'en',
          { key: K(), status: 'translated', text: 'Hello world', sentenceEnds: [5, 11] },
        ],
        undefined,
        'one list alone is dropped',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'translated',
            text: 'Hello world',
            sourceSentenceEnds: [6],
            sentenceEnds: [11],
          },
        ],
        undefined,
        'a list of one is dropped',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'translated',
            text: 'Hello world',
            sourceSentenceEnds: [6, 12, 20],
            sentenceEnds: [5, 11],
          },
        ],
        undefined,
        'lists of different length',
      ),
      c(
        [
          O,
          D1,
          'en',
          {
            key: K(),
            status: 'failed',
            text: 'Hello world',
            sourceSentenceEnds: [6, 12],
            sentenceEnds: [5, 11],
          },
        ],
        undefined,
        'ends of a failed block are dropped',
      ),
      c(
        [O, D1, 'en', { key: K('fpA', 'h1', 1.5), status: 'translated', text: 'x' }],
        undefined,
        'occurrence',
      ),
      c([O, D1, 'e n', { key: K(), status: 'translated', text: 'x' }], undefined, 'language'),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: 'new' }],
        blkFile(D1, 'en', K(), { text: 'old' }),
        'replaces',
      ),
      c(
        [O, D1, 'en', { key: K(), status: 'translated', text: 'x' }],
        BLOCKED,
        'the store folder is a file',
      ),
    ],
  },
  'pdf-structure/store.writeEditedTranslationBlock': {
    ts: store('writeEditedTranslationBlock'),
    cases: [
      c([O, D1, 'en', K(), 'fixed by hand']),
      c([O, D1, 'en', K(), 'fixed by hand', 'easy']),
      c([O, D1, 'en', K(), ' \t '], undefined, 'blank'),
      c(
        [O, D1, 'en', K(), 'edit'],
        blkFile(D1, 'en', K(), { runs: [] }),
        'replaces a machine translation',
      ),
    ],
  },
  'pdf-structure/store.writeTranslationBlocks': {
    ts: store('writeTranslationBlocks'),
    cases: [
      c([
        O,
        D1,
        'en',
        [
          { key: K('fpA', 'h1', 0), status: 'translated', text: 'one' },
          { key: K('fpB', 'h2', 0), status: 'failed', reason: 'x' },
        ],
      ]),
      c(
        [
          O,
          D1,
          'en',
          [
            { key: K('fpA', 'h1', 0), status: 'translated', text: 'one' },
            { key: K('fpB', 'h2', 0), status: 'translated' },
            { key: K('fpC', 'h3', 0), status: 'translated', text: 'three' },
          ],
        ],
        undefined,
        'the second fails, the first stays written',
      ),
      c([O, D1, 'en', []]),
      c([O, D1, 'en', [{ key: K(), status: 'translated', text: 'one' }], 'easy']),
    ],
  },
  'pdf-structure/store.readTranslation': {
    ts: store('readTranslation'),
    cases: [
      c(
        [O, D1, 'en'],
        merge(
          metaFile(D1, 'en', NOW - 9),
          blkFile(D1, 'en', K('fpB', 'h2', 0), {
            runs: [{ kind: 'text', text: 'hello' }],
            reason: 'why',
          }),
          blkFile(D1, 'en', K('fpA', 'h1', 1), {
            status: 'failed',
            text: undefined,
            reason: 'rate-limit',
          }),
          blkFile(D1, 'en', K('fpA', 'h1', 0)),
          blkFile(D1, 'en', K('fpA', 'h9', 0), {
            text: 'Hello world',
            sourceSentenceEnds: [6, 12],
            sentenceEnds: [5, 11],
          }),
          blkFile(D1, 'en', K('fpA', 'h13', 12)),
        ),
        'meta and blocks in directory order',
      ),
      c([O, D1, 'en'], blkFile(D1, 'en', K()), 'no record of the provider'),
      c([O, D1, 'en'], undefined, 'no such translation'),
      c(
        [O, D1, 'en', 'easy'],
        merge(metaFile(D1, 'en', NOW), blkFile(D1, 'en', K())),
        'only plain stored: no easy',
      ),
      c(
        [O, D1, 'ko', 'easy'],
        merge(
          metaFile(D1, 'ko', NOW, 'easy'),
          blkFile(D1, 'ko', K(), { text: '쉬운 설명' }, 'easy'),
        ),
        'easy',
      ),
      c([O, 'bad hash', 'en'], undefined, 'document hash'),
      c([O, D1, 'e n'], undefined, 'language'),
      c(
        [O, D1, 'en'],
        merge(
          metaFile(D1, 'en', NOW),
          blkFile(D1, 'en', K('fpA', 'h1', 0), {
            edited: true,
            runs: [{ kind: 'text', text: 'x' }],
            text: 'by hand',
          }),
          blkFile(D1, 'en', K('fpA', 'h2', 0), {
            status: 'failed',
            edited: true,
            text: 'ignored edit',
          }),
          blkFile(D1, 'en', K('fpA', 'h3', 0), {
            edited: true,
            text: 'Hello world',
            sourceSentenceEnds: [6, 12],
            sentenceEnds: [5, 11],
          }),
          blkFile(D1, 'en', K('fpA', 'h4', 0), { status: 'bogus' }),
          blkFile(D1, 'en', K('fpA', 'h5', 0), { text: undefined }),
          blkFile(D1, 'en', K('fpA', 'h6', 0), { runs: 'x' }),
          blkFile(D1, 'en', K('fpA', 'h7', 0), { format: 2 }),
          blkFile(D1, 'en', K('fpA', 'h8', 0), { key: K('fpA', 'other', 0) }),
          blkFile(D1, 'en', K('fpA', 'h10', 0), { savedAt: 'x' }),
          blkFile(D1, 'en', K('fpA', 'h11', 0), { reason: 3 }),
          { [`${trDir(D1, 'en')}/blocks/fpA/notes.txt`]: 'x' },
          { [`${trDir(D1, 'en')}/blocks/bad dir/h1.0.json`]: j({ format: 1 }) },
          { [`${trDir(D1, 'en')}/blocks/fpA/h12.1234567890.json`]: j({ format: 1 }) },
        ),
        'what is read and what is not',
      ),
    ],
  },
  'pdf-structure/store.listTranslations': {
    ts: store('listTranslations'),
    cases: [
      c(
        [O, D1],
        merge(
          metaFile(D1, 'ko', 1),
          metaFile(D1, 'en', 1),
          {
            [`${docDir(D1)}/translations/stray.json`]: '{}',
            [`${docDir(D1)}/translations/e n/translation.json`]: '{}',
          },
          metaFile(D1, 'fr', 1, 'easy'),
        ),
        'plain',
      ),
      c(
        [O, D1, 'easy'],
        merge(metaFile(D1, 'ko', 1), metaFile(D1, 'fr', 1, 'easy'), metaFile(D1, 'de', 1, 'easy')),
        'easy',
      ),
      c([O, D1], undefined, 'none'),
      c([O, 'bad hash'], metaFile('bad hash', 'en', 1), 'document hash'),
    ],
  },
  'pdf-structure/store.deleteTranslation': {
    ts: store('deleteTranslation'),
    cases: [
      c(
        [O, D1, 'en'],
        merge(
          metaFile(D1, 'en', 1),
          blkFile(D1, 'en', K()),
          metaFile(D1, 'ko', 1),
          metaFile(D1, 'en', 1, 'easy'),
        ),
        'only that language, only plain',
      ),
      c(
        [O, D1, 'en', 'easy'],
        merge(
          metaFile(D1, 'en', 1),
          metaFile(D1, 'en', 1, 'easy'),
          blkFile(D1, 'en', K(), {}, 'easy'),
        ),
        'easy',
      ),
      c([O, D1, 'en'], undefined, 'nothing there'),
      c([O, D1, 'e n'], undefined, 'language'),
      c(
        [O, D1, 'en'],
        {
          [`${docDir(D1)}/translations/en/blocks/fpA/x.json`]: { text: '{}', mode: 0o444 },
          [`${docDir(D1)}/translations/en/blocks/fpA`]: { dir: true, mode: 0o555 },
        },
        'cannot delete from a read-only folder',
      ),
    ],
  },
  'pdf-structure/store.deleteTranslationExceptEdited': {
    ts: store('deleteTranslationExceptEdited'),
    cases: [
      c(
        [O, D1, 'en'],
        merge(
          metaFile(D1, 'en', 1),
          blkFile(D1, 'en', K('fpA', 'h1', 0)),
          blkFile(D1, 'en', K('fpA', 'h2', 0), { edited: true, text: 'mine' }),
          blkFile(D1, 'en', K('fpB', 'h3', 0), { status: 'failed' }),
          blkFile(D1, 'en', K('fpB', 'h4', 0), {
            edited: true,
            status: 'failed',
            text: 'not an edit',
          }),
          { [`${trDir(D1, 'en')}/blocks/fpB/h5.0.json`]: 'unreadable junk' },
          { [`${trDir(D1, 'en')}/blocks/fpB/notes.txt`]: 'kept: no block name' },
          { [`${trDir(D1, 'en')}/blocks/bad dir/h1.0.json`]: '{}' },
        ),
        'edits stay, the rest goes',
      ),
      c(
        [O, D1, 'en', 'easy'],
        merge(
          blkFile(D1, 'en', K(), {}, 'easy'),
          blkFile(D1, 'en', K('fpA', 'h2', 0), {}, 'easy'),
          blkFile(D1, 'en', K('fpA', 'h3', 0)),
          blkFile(D1, 'en', K('fpA', 'h4', 0), { edited: true }, 'easy'),
        ),
        'easy only',
      ),
      c([O, D1, 'en'], undefined, 'nothing there'),
      c([O, D1, 'e n'], undefined, 'language'),
    ],
  },
  'pdf-structure/store.countEditedTranslationBlocks': {
    ts: store('countEditedTranslationBlocks'),
    cases: [
      c(
        [O, D1, 'en'],
        merge(
          blkFile(D1, 'en', K('fpA', 'h1', 0), { edited: true }),
          blkFile(D1, 'en', K('fpA', 'h2', 0)),
          blkFile(D1, 'ko', K('fpA', 'h3', 0), { edited: true }),
        ),
        'one language',
      ),
      c(
        [O, D1],
        merge(
          metaFile(D1, 'en', 1),
          metaFile(D1, 'ko', 1),
          blkFile(D1, 'en', K('fpA', 'h1', 0), { edited: true }),
          blkFile(D1, 'ko', K('fpA', 'h3', 0), { edited: true }),
          blkFile(D1, 'fr', K('fpA', 'h4', 0), { edited: true }, 'easy'),
        ),
        'all languages',
      ),
      c(
        [O, D1, null, 'easy'],
        merge(
          blkFile(D1, 'fr', K('fpA', 'h4', 0), { edited: true }, 'easy'),
          blkFile(D1, 'en', K('fpA', 'h1', 0), { edited: true }),
        ),
        'all easy languages',
      ),
      c([O, D1, 'e n'], undefined, 'a language that is no key counts nothing'),
      c([O, 'bad hash'], undefined, 'document hash'),
      c([O, D1, 'en'], undefined, 'none'),
    ],
  },

  // job records
  'pdf-structure/store.writeJob': {
    ts: store('writeJob'),
    cases: [
      c([O, D1, { kind: 'ai-read', state: 'running' }]),
      c([
        O,
        D1,
        {
          kind: 'translate',
          lang: 'en',
          state: 'running',
          outputs: ['a.json'],
          progress: { done: 2, total: 9, extra: 1 },
        },
      ]),
      c(
        [
          O,
          D1,
          {
            kind: 'translate',
            lang: 'en',
            mode: 'easy',
            state: 'stopped',
            last_error: 'rate-limit',
            resetsAt: NOW + 5000,
          },
        ],
        undefined,
        'easy',
      ),
      c(
        [O, D1, { kind: 'translate', lang: 'en', mode: 'translate', state: 'complete' }],
        undefined,
        'an explicit plain mode writes no field',
      ),
      c([O, D1, { kind: 'translate-page', lang: 'ko', state: 'complete' }]),
      c([O, D1, { kind: 'highlight', runId: 'run1', lang: 'ignored', state: 'running' }]),
      c([O, D1, { kind: 'summary', lang: 'en', runId: 'ignored', state: 'stopped' }]),
      c([O, D1, { kind: 'ai-read', lang: 'ignored', state: 'complete' }]),
      c([O, D1, { kind: 'translate', state: 'running' }], undefined, 'no language'),
      c([O, D1, { kind: 'translate', lang: 'e n', state: 'running' }], undefined, 'language'),
      c([O, D1, { kind: 'summary', state: 'running' }], undefined, 'summary needs one too'),
      c([O, D1, { kind: 'highlight', state: 'running' }], undefined, 'no run id'),
      c([O, D1, { kind: 'highlight', runId: 'r/1', state: 'running' }], undefined, 'run id'),
      c(
        [O, D1, { kind: 'highlight', runId: 'run1', mode: 'easy', state: 'running' }],
        undefined,
        'no easy highlight',
      ),
      c(
        [O, D1, { kind: 'summary', lang: 'en', mode: 'easy', state: 'running' }],
        undefined,
        'no easy summary',
      ),
      c([O, D1, { kind: 'ai-read', state: 'idle' }], undefined, 'idle is only derived'),
      c([O, 'bad hash', { kind: 'ai-read', state: 'running' }], undefined, 'document hash'),
      c(
        [O, D1, { kind: 'ai-read', state: 'running', outputs: ['x'] }],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: 1 }),
        'replaces',
      ),
      c([O, D1, { kind: 'ai-read', state: 'running' }], BLOCKED, 'the store folder is a file'),
    ],
  },
  'pdf-structure/store.heartbeatJob': {
    ts: store('heartbeatJob'),
    cases: [
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: 5, outputs: ['a'] }),
        'a running job is refreshed',
      ),
      c(
        [O, D1, 'translate', 'en'],
        jobFile(D1, 'translate.en', 'translate', {
          lang: 'en',
          updatedAt: 5,
          progress: { done: 1, total: 2 },
          last_error: 'cancelled',
          resetsAt: 9,
        }),
        'with every field',
      ),
      c(
        [O, D1, 'translate', 'en', 'easy'],
        jobFile(D1, 'translate.en.easy', 'translate', { lang: 'en', mode: 'easy', updatedAt: 5 }),
        'easy keeps its mode',
      ),
      c(
        [O, D1, 'highlight', 'run1'],
        jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1', updatedAt: 5 }),
      ),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { state: 'stopped' }), 'stopped'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { state: 'complete' }), 'complete'),
      c([O, D1, 'ai-read'], undefined, 'missing'),
      c([O, D1, 'ai-read'], { [jobPath(D1, 'ai-read')]: 'junk' }, 'unreadable'),
      c([O, D1, 'translate', 'e n'], undefined, 'language'),
      c([O, D1, 'translate'], undefined, 'no language'),
      c(
        [O, D1, 'translate', 'en'],
        jobFile(D1, 'translate.en.easy', 'translate', { lang: 'en', mode: 'easy' }),
        'only the easy record is there',
      ),
      c([O, D1, 'summary', 'en', 'easy'], undefined, 'no such mode'),
      c([O, 'bad hash', 'ai-read'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.readJob': {
    ts: store('readJob'),
    cases: [
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { outputs: ['a.json'] }),
        'running now',
      ),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: NOW - 60_000 }),
        'running, not refreshed: interrupted',
      ),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: NOW - 60_000, last_error: 'rate-limit' }),
        'an error it named stays',
      ),
      c(
        [{ dir: '$DIR', runningWindowMs: 500 }, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: NOW - 1000 }),
        'a shorter window',
      ),
      c(
        [{ dir: '$DIR', runningWindowMs: 500 }, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { updatedAt: NOW - 500 }),
        'exactly the window',
      ),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { state: 'stopped', updatedAt: NOW - 60_000 }),
        'stopped stays stopped',
      ),
      c(
        [O, D1, 'translate', 'en'],
        jobFile(D1, 'translate.en', 'translate', {
          lang: 'en',
          state: 'complete',
          progress: { done: 3, total: 3 },
          resetsAt: 7,
        }),
        'complete',
      ),
      c(
        [O, D1, 'translate', 'en', 'easy'],
        jobFile(D1, 'translate.en.easy', 'translate', {
          lang: 'en',
          mode: 'easy',
          state: 'stopped',
          last_error: 'failures',
        }),
        'easy',
      ),
      c(
        [O, D1, 'highlight', 'run1'],
        jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1' }),
        'highlight',
      ),
      c([O, D1, 'ai-read'], undefined, 'idle'),
      c([O, D1, 'translate', 'en'], undefined, 'idle with a language'),
      c([O, D1, 'translate', 'en', 'easy'], undefined, 'idle easy'),
      c([O, D1, 'highlight', 'run1'], undefined, 'idle with a run'),
      c([O, D1, 'summary', 'en', 'easy'], undefined, 'idle: no easy summary'),
      c([O, D1, 'ai-read', 'ignored'], undefined, 'ai-read has no key'),
      c(
        [O, D1, 'translate', 'e n'],
        undefined,
        'idle: a language that is no key stays on the answer',
      ),
      c(
        [O, D1, 'translate', 'en'],
        jobFile(D1, 'translate.en', 'translate', { lang: 'ko' }),
        'a record of another language',
      ),
      c(
        [O, D1, 'translate', 'en'],
        jobFile(D1, 'translate.en', 'translate', { lang: 'en', mode: 'easy' }),
        'a plain record with a mode',
      ),
      c(
        [O, D1, 'translate', 'en', 'easy'],
        jobFile(D1, 'translate.en.easy', 'translate', { lang: 'en' }),
        'an easy record without it',
      ),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { lang: 'en' }),
        'ai-read with a language',
      ),
      c(
        [O, D1, 'translate-page', 'en'],
        jobFile(D1, 'translate-page.en', 'translate-page', { lang: 'en', runId: 'x' }),
        'a run id that does not belong',
      ),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { state: 'idle' }), 'idle on disk'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { outputs: [1] }), 'outputs'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { updatedAt: 'x' }), 'updatedAt'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { last_error: 4 }), 'last_error'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { resetsAt: 'x' }), 'resetsAt'),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { progress: { done: 1 } }),
        'progress',
      ),
      c(
        [O, D1, 'ai-read'],
        jobFile(D1, 'ai-read', 'ai-read', { progress: 3 }),
        'progress that is no record',
      ),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { kind: 'summary' }), 'another kind'),
      c([O, D1, 'ai-read'], jobFile(D1, 'ai-read', 'ai-read', { format: 2 }), 'other format'),
    ],
  },
  'pdf-structure/store.listJobs': {
    ts: store('listJobs'),
    cases: [
      c(
        [O, D1],
        merge(
          jobFile(D1, 'ai-read', 'ai-read'),
          jobFile(D1, 'translate.en', 'translate', { lang: 'en', state: 'complete' }),
          jobFile(D1, 'translate.en.easy', 'translate', {
            lang: 'en',
            mode: 'easy',
            state: 'stopped',
          }),
          jobFile(D1, 'translate-page.ko', 'translate-page', {
            lang: 'ko',
            updatedAt: NOW - 99_000,
          }),
          jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1' }),
          jobFile(D1, 'summary.en', 'summary', { lang: 'en', state: 'complete' }),
          jobFile(D1, 'summary.fr.easy', 'summary', { lang: 'fr', mode: 'easy' }),
          jobFile(D1, 'highlight.run2.easy', 'highlight', { runId: 'run2', mode: 'easy' }),
          jobFile(D1, 'translate.de', 'translate', { lang: 'xx' }),
          { [jobPath(D1, 'translate.it')]: 'junk' },
          { [`${docDir(D1)}/jobs/notes.txt`]: 'x' },
        ),
        'every kind, easy and plain, the broken ones skipped',
      ),
      c([O, D1], undefined, 'none'),
      c([O, 'bad hash'], jobFile('bad hash', 'ai-read', 'ai-read'), 'document hash'),
    ],
  },
  'pdf-structure/store.unfinishedJobs': {
    ts: store('unfinishedJobs'),
    cases: [
      c(
        [O, D1],
        merge(
          jobFile(D1, 'ai-read', 'ai-read', { state: 'complete' }),
          jobFile(D1, 'translate.en', 'translate', { lang: 'en', state: 'stopped' }),
          jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1', updatedAt: NOW - 99_000 }),
          jobFile(D1, 'summary.en', 'summary', { lang: 'en' }),
        ),
        'complete is left out',
      ),
      c([O, D1], jobFile(D1, 'ai-read', 'ai-read', { state: 'complete' }), 'all complete'),
      c([O, D1], undefined, 'none'),
    ],
  },

  // passage cards
  'pdf-structure/store.writePassage': {
    ts: store('writePassage'),
    cases: [
      c([O, D1, withoutSavedAt(card('c1', 'fpA', 0))]),
      c(
        [
          O,
          D1,
          withoutSavedAt(
            card('c2', 'fpA', 0, { kind: 'translate', lang: 'ko', savedAsNote: true }),
          ),
        ],
        undefined,
        'translate with a language',
      ),
      c(
        [O, D1, withoutSavedAt(card('c1', 'fpB', 0, { quads: [[1, 2], [3]], page: 4 }))],
        cardFile(D1, card('c1', 'fpA', 5)),
        'replaces',
      ),
      c(
        [O, D1, withoutSavedAt(card('c1', 'fpA', 0, { kind: 'translate' }))],
        undefined,
        'translate without a language',
      ),
      c(
        [O, D1, withoutSavedAt(card('c1', 'fpA', 0, { lang: 'e n' }))],
        undefined,
        'a language that is no key',
      ),
      c([O, D1, withoutSavedAt(card('c 1', 'fpA', 0))], undefined, 'id'),
      c([O, D1, withoutSavedAt(card('c1', 'fpA', 0, { page: 0 }))], undefined, 'page'),
      c([O, D1, withoutSavedAt(card('c1', 'fp A', 0))], undefined, 'page fingerprint'),
      c(
        [O, D1, withoutSavedAt(card('c1', 'fpA', 0, { savedAsNote: false }))],
        undefined,
        'savedAsNote false',
      ),
      c([O, 'bad hash', withoutSavedAt(card('c1', 'fpA', 0))], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.readPassage': {
    ts: store('readPassage'),
    cases: [
      c([O, D1, 'c1'], cardFile(D1, card('c1', 'fpA', NOW - 1))),
      c(
        [O, D1, 'c1'],
        cardFile(
          D1,
          card('c1', 'fpA', NOW - 1, { kind: 'translate', lang: 'ko', savedAsNote: true }),
        ),
        'translate',
      ),
      c([O, D1, 'c1'], undefined, 'missing'),
      c(
        [O, D1, 'c1'],
        { [`${docDir(D1)}/passages/c1.json`]: j({ format: 1, ...card('c2', 'fpA', NOW) }) },
        'card of another id',
      ),
      c(
        [O, D1, 'c1'],
        { [`${docDir(D1)}/passages/c1.json`]: j({ ...card('c1', 'fpA', NOW) }) },
        'no format',
      ),
      c(
        [O, D1, 'c1'],
        { [`${docDir(D1)}/passages/c1.json`]: j({ format: 2, ...card('c1', 'fpA', NOW) }) },
        'other format',
      ),
      c([O, D1, 'c1'], cardFile(D1, card('c1', 'fpA', NOW, { quads: [['x']] })), 'quads'),
      c([O, 'bad hash', 'c1'], undefined, 'document hash'),
      c([O, D1, 'c 1'], undefined, 'id'),
    ],
  },
  'pdf-structure/store.readPassages': {
    ts: store('readPassages'),
    cases: [
      c(
        [O, D1],
        merge(cardFile(D1, card('c2', 'fpA', 2)), cardFile(D1, card('c1', 'fpB', 1)), {
          [`${docDir(D1)}/passages/broken.json`]: 'junk',
          [`${docDir(D1)}/passages/c9.json`]: j({ format: 1, ...card('c8', 'fpA', 1) }),
          [`${docDir(D1)}/passages/note.txt`]: 'x',
        }),
        'sorted, the broken skipped',
      ),
      c([O, D1], undefined, 'none'),
      c([O, 'bad hash'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.deletePassage': {
    ts: store('deletePassage'),
    cases: [
      c(
        [O, D1, 'c1'],
        merge(cardFile(D1, card('c1', 'fpA', 1)), cardFile(D1, card('c2', 'fpA', 1))),
        'one of two',
      ),
      c([O, D1, 'c1'], undefined, 'missing'),
      c([O, D1, 'c 1'], undefined, 'id'),
    ],
  },
  'pdf-structure/store.countPassages': {
    ts: store('countPassages'),
    cases: [
      c(
        [O, D1],
        merge(cardFile(D1, card('c1', 'fpA', 1)), cardFile(D1, card('c2', 'fpA', 1)), {
          [`${docDir(D1)}/passages/junk.json`]: 'x',
        }),
      ),
      c([O, D1], undefined, 'none'),
    ],
  },

  // AI highlights
  'pdf-structure/store.writeHighlightRun': {
    ts: store('writeHighlightRun'),
    cases: [
      c([O, D1, run('run1')]),
      c(
        [
          O,
          D1,
          run('run1', {
            presetId: 'custom',
            labels: [
              { id: 'l1', name: 'A', color: [0, 0, 0] },
              { id: 'l2', name: 'B', color: [1, 1, 1] },
            ],
            pages: [],
          }),
        ],
        runFile(D1, run('run1'), 5),
        'replaces',
      ),
      c([O, D1, run('run1', { presetId: 'bogus' })], undefined, 'preset'),
      c([O, D1, run('run1', { labels: [] })], undefined, 'no labels'),
      c(
        [
          O,
          D1,
          run('run1', {
            labels: [1, 2, 3, 4, 5, 6].map((n) => ({
              id: `l${n}`,
              name: `n${n}`,
              color: [0, 0, 0],
            })),
          }),
        ],
        undefined,
        'six labels',
      ),
      c(
        [
          O,
          D1,
          run('run1', {
            labels: [1, 2, 3, 4, 5].map((n) => ({ id: `l${n}`, name: `n${n}`, color: [0, 0, 0] })),
          }),
        ],
        undefined,
        'five labels',
      ),
      c(
        [O, D1, run('run1', { labels: [{ id: '', name: 'A', color: [0, 0, 0] }] })],
        undefined,
        'empty label id',
      ),
      c(
        [O, D1, run('run1', { labels: [{ id: 'l1', name: ' \t ', color: [0, 0, 0] }] })],
        undefined,
        'blank name',
      ),
      c(
        [
          O,
          D1,
          run('run1', {
            labels: [
              { id: 'l1', name: 'A  b', color: [0, 0, 0] },
              { id: 'l2', name: ' A b', color: [0, 0, 0] },
            ],
          }),
        ],
        undefined,
        'names that count as one',
      ),
      c(
        [O, D1, run('run1', { labels: [{ id: 'l1', name: 'A', color: [0, 0, 2] }] })],
        undefined,
        'a colour out of range',
      ),
      c(
        [O, D1, run('run1', { labels: [{ id: 'l1', name: 'A', color: [0, 0, -0.5] }] })],
        undefined,
        'a negative colour',
      ),
      c([O, D1, run('run1', { pages: [1, 0] })], undefined, 'page'),
      c([O, D1, run('run1', { pages: [1.5] })], undefined, 'fractional page'),
      c([O, D1, run('run 1')], undefined, 'run id'),
      c([O, 'bad hash', run('run1')], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.readHighlightRun': {
    ts: store('readHighlightRun'),
    cases: [
      c([O, D1, 'run1'], runFile(D1, run('run1'), NOW - 1)),
      c([O, D1, 'run1'], undefined, 'missing'),
      c(
        [O, D1, 'run1'],
        {
          [`${docDir(D1)}/highlights/run1/run.json`]: j({
            format: 1,
            ...run('run2'),
            savedAt: NOW,
          }),
        },
        'another run',
      ),
      c(
        [O, D1, 'run1'],
        { [`${docDir(D1)}/highlights/run1/run.json`]: j({ ...run('run1'), savedAt: NOW }) },
        'no format',
      ),
      c(
        [O, D1, 'run1'],
        { [`${docDir(D1)}/highlights/run1/run.json`]: j({ format: 1, ...run('run1') }) },
        'no savedAt',
      ),
      c([O, D1, 'run1'], runFile(D1, run('run1', { presetId: 'x' }), NOW), 'preset'),
      c([O, D1, 'run 1'], undefined, 'run id'),
      c([O, 'bad hash', 'run1'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.listHighlightRuns': {
    ts: store('listHighlightRuns'),
    cases: [
      c(
        [O, D1],
        merge(runFile(D1, run('runB'), 1), runFile(D1, run('runA'), 2), {
          [`${docDir(D1)}/highlights/runC/run.json`]: 'junk',
          [`${docDir(D1)}/highlights/stray.json`]: '{}',
          [`${docDir(D1)}/highlights/run D/run.json`]: '{}',
        }),
        'sorted, the broken skipped',
      ),
      c([O, D1], undefined, 'none'),
      c([O, 'bad hash'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.writeHighlightBlock': {
    ts: store('writeHighlightBlock'),
    cases: [
      c([O, D1, 'run1', withoutSavedAt(hBlock(K()))]),
      c(
        [O, D1, 'run1', { key: K('fpA', 'h1', 2), status: 'failed', suggestions: [] }],
        undefined,
        'failed',
      ),
      c(
        [
          O,
          D1,
          'run1',
          {
            key: K(),
            status: 'done',
            suggestions: [{ id: 's1', labelId: 'l1', quote: 'new', state: 'accepted' }],
          },
        ],
        hBlockFile(D1, 'run1', hBlock(K())),
        'replaces',
      ),
      c([O, D1, 'run 1', { key: K(), status: 'done', suggestions: [] }], undefined, 'run id'),
      c(
        [O, D1, 'run1', { key: K('fpA', 'h1', -1), status: 'done', suggestions: [] }],
        undefined,
        'occurrence',
      ),
      c(
        [O, D1, 'run1', { key: K('fp A', 'h1', 0), status: 'done', suggestions: [] }],
        undefined,
        'page fingerprint',
      ),
      c(
        [O, 'bad hash', 'run1', { key: K(), status: 'done', suggestions: [] }],
        undefined,
        'document hash',
      ),
      c(
        [O, D1, 'run1', { key: K(), status: 'done', suggestions: [] }],
        BLOCKED,
        'the store folder is a file',
      ),
    ],
  },
  'pdf-structure/store.writeHighlightBlocks': {
    ts: store('writeHighlightBlocks'),
    cases: [
      c([
        O,
        D1,
        'run1',
        [
          { key: K('fpA', 'h1', 0), status: 'done', suggestions: [] },
          { key: K('fpB', 'h2', 0), status: 'failed', suggestions: [] },
        ],
      ]),
      c(
        [
          O,
          D1,
          'run1',
          [
            { key: K('fpA', 'h1', 0), status: 'done', suggestions: [] },
            { key: K('fpB', 'h2', -1), status: 'failed', suggestions: [] },
            { key: K('fpC', 'h3', 0), status: 'done', suggestions: [] },
          ],
        ],
        undefined,
        'the second fails, the first stays written',
      ),
      c([O, D1, 'run1', []]),
    ],
  },
  'pdf-structure/store.readHighlightBlock': {
    ts: store('readHighlightBlock'),
    cases: [
      c([O, D1, 'run1', K()], hBlockFile(D1, 'run1', hBlock(K()))),
      c([O, D1, 'run1', K()], undefined, 'missing'),
      c(
        [O, D1, 'run1', K()],
        hBlockFile(D1, 'run1', hBlock(K(), { status: 'failed', suggestions: [] })),
        'failed',
      ),
      c(
        [O, D1, 'run1', K()],
        { [hBlockPath(D1, 'run1', K())]: j({ ...hBlock(K()) }) },
        'no format',
      ),
      c(
        [O, D1, 'run1', K()],
        hBlockFile(D1, 'run1', hBlock(K(), { key: K('fpA', 'h1', 1) })),
        'another key',
      ),
      c(
        [O, D1, 'run1', K()],
        hBlockFile(
          D1,
          'run1',
          hBlock(K(), { suggestions: [{ id: 's', labelId: 'l', quote: 'q', state: 'maybe' }] }),
        ),
        'a state that is none',
      ),
      c(
        [O, D1, 'run1', K()],
        hBlockFile(D1, 'run1', hBlock(K(), { suggestions: 'x' })),
        'suggestions',
      ),
      c([O, D1, 'run1', K('fpA', 'h1', -1)], undefined, 'occurrence'),
      c([O, D1, 'run1', K('fpA', 'h 1', 0)], undefined, 'text hash'),
      c([O, D1, 'run 1', K()], undefined, 'run id'),
      c([O, 'bad hash', 'run1', K()], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.readHighlightBlocks': {
    ts: store('readHighlightBlocks'),
    cases: [
      c(
        [O, D1, 'run1'],
        merge(
          hBlockFile(D1, 'run1', hBlock(K('fpB', 'h2', 0))),
          hBlockFile(D1, 'run1', hBlock(K('fpA', 'h1', 1))),
          hBlockFile(D1, 'run1', hBlock(K('fpA', 'h1', 0))),
          {
            [hBlockPath(D1, 'run1', K('fpA', 'h3', 0))]: 'junk',
            [`${docDir(D1)}/highlights/run1/blocks/fpA/note.txt`]: 'x',
            [hBlockPath(D1, 'run1', K('fpA', 'h4', 0))]: j(hBlock(K('fpA', 'h4', 0))),
          },
        ),
        'sorted, the broken skipped',
      ),
      c([O, D1, 'run1'], undefined, 'none'),
      c([O, D1, 'run 1'], undefined, 'run id'),
      c([O, 'bad hash', 'run1'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.setHighlightSuggestionStates': {
    ts: store('setHighlightSuggestionStates'),
    cases: [
      c(
        [O, D1, 'run1', K(), { s1: 'accepted' }],
        hBlockFile(D1, 'run1', hBlock(K())),
        'one suggestion',
      ),
      c(
        [O, D1, 'run1', K(), { s1: 'dismissed', s2: 'accepted', unknown: 'accepted' }],
        hBlockFile(D1, 'run1', hBlock(K())),
        'two, and an unknown id',
      ),
      c([O, D1, 'run1', K(), {}], hBlockFile(D1, 'run1', hBlock(K())), 'none'),
      c([O, D1, 'run1', K(), { s1: 'accepted' }], undefined, 'no such block'),
      c([O, D1, 'run1', K('fpA', 'h1', -1), { s1: 'accepted' }], undefined, 'an invalid key'),
      c(
        [O, D1, 'run1', K(), { s1: 'accepted' }],
        hBlockFile(D1, 'run1', hBlock(K(), { suggestions: 'x' })),
        'unreadable block',
      ),
      c(
        [O, D1, 'run1', K(), { s1: 'accepted' }],
        hBlockFile(
          D1,
          'run1',
          hBlock(K(), {
            suggestions: [{ id: 's1', labelId: 'l1', quote: 'q', state: 'pending' }],
            status: 'failed',
          }),
        ),
        'a failed block stays failed',
      ),
    ],
  },
  'pdf-structure/store.deleteHighlightRun': {
    ts: store('deleteHighlightRun'),
    cases: [
      c(
        [O, D1, 'run1'],
        merge(
          runFile(D1, run('run1'), 1),
          hBlockFile(D1, 'run1', hBlock(K())),
          jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1' }),
          runFile(D1, run('run2'), 1),
          jobFile(D1, 'highlight.run2', 'highlight', { runId: 'run2' }),
        ),
        'the run and its job, not another',
      ),
      c(
        [O, D1, 'run1'],
        jobFile(D1, 'highlight.run1', 'highlight', { runId: 'run1' }),
        'the job alone',
      ),
      c([O, D1, 'run1'], undefined, 'nothing there'),
      c([O, D1, 'run 1'], undefined, 'run id'),
      c([O, 'bad hash', 'run1'], undefined, 'document hash'),
    ],
  },

  // insights
  'pdf-structure/store.writeInsights': {
    ts: store('writeInsights'),
    cases: [
      c([O, D1, insights('en')]),
      c(
        [O, D1, insights('ko', ['fpA', 'fpB'], { terms: [] })],
        insFile(D1, insights('ko'), 5),
        'replaces',
      ),
      c([O, D1, insights('e n')], undefined, 'language'),
      c([O, D1, insights('en', ['fpA'], { summary3: ['a', 'b'] })], undefined, 'two summaries'),
      c(
        [O, D1, insights('en', ['fpA'], { terms: [{ term: 't', meaning: 'm', page: 0 }] })],
        undefined,
        'term page',
      ),
      c([O, D1, insights('en', ['f p'])], undefined, 'page fingerprint'),
      c([O, 'bad hash', insights('en')], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.readInsights': {
    ts: store('readInsights'),
    cases: [
      c([O, D1, 'en'], insFile(D1, insights('en'), NOW - 1)),
      c([O, D1, 'en'], undefined, 'missing'),
      c(
        [O, D1, 'en'],
        { [`${docDir(D1)}/insights/en.json`]: j({ format: 1, ...insights('ko'), savedAt: NOW }) },
        'another language',
      ),
      c(
        [O, D1, 'en'],
        { [`${docDir(D1)}/insights/en.json`]: j({ ...insights('en'), savedAt: NOW }) },
        'no format',
      ),
      c(
        [O, D1, 'en'],
        { [`${docDir(D1)}/insights/en.json`]: j({ format: 1, ...insights('en') }) },
        'no savedAt',
      ),
      c([O, D1, 'en'], insFile(D1, insights('en', ['fpA'], { summary: 3 }), NOW), 'summary'),
      c([O, D1, 'e n'], undefined, 'language'),
      c([O, 'bad hash', 'en'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.listInsights': {
    ts: store('listInsights'),
    cases: [
      c(
        [O, D1],
        merge(insFile(D1, insights('ko'), 1), insFile(D1, insights('en'), 1), {
          [`${docDir(D1)}/insights/note.txt`]: 'x',
          [`${docDir(D1)}/insights/e n.json`]: '{}',
          [`${docDir(D1)}/insights/xx.json`]: 'junk',
        }),
        'sorted; a broken file still names a language',
      ),
      c([O, D1], undefined, 'none'),
      c([O, 'bad hash'], undefined, 'document hash'),
    ],
  },
  'pdf-structure/store.deleteInsights': {
    ts: store('deleteInsights'),
    cases: [
      c(
        [O, D1, 'en'],
        merge(insFile(D1, insights('en'), 1), insFile(D1, insights('ko'), 1)),
        'one of two',
      ),
      c([O, D1, 'en'], undefined, 'missing'),
      c([O, D1, 'e n'], undefined, 'language'),
    ],
  },

  // note links
  'pdf-structure/store.readNoteLinks': {
    ts: store('readNoteLinks'),
    cases: [
      c([O], linksFile({ [PDF_A]: link(NOTE_A, D1, 5), [PDF_B]: link(NOTE_B, D2, 6) })),
      c([O], undefined, 'no file'),
      c([O], { [`${S}/note-links.json`]: 'junk' }, 'unreadable'),
      c(
        [O],
        { [`${S}/note-links.json`]: j({ version: 2, links: { [PDF_A]: link(NOTE_A, D1, 5) } }) },
        'other version',
      ),
      c(
        [O],
        linksFile({
          [PDF_A]: link('', D1, 5),
          [PDF_B]: link(NOTE_B, 'bad hash', 6),
          '/c.pdf': { notePath: NOTE_A, docHash: D1, updatedAt: 'x' },
          '/d.pdf': 3,
          '/e.pdf': link(NOTE_A, D1, 7),
        }),
        'only the readable links',
      ),
    ],
  },
  'pdf-structure/store.findNoteLink': {
    ts: store('findNoteLink'),
    cases: [
      c([O, PDF_A, D1], linksFile({ [PDF_A]: link(NOTE_A, D1, 5) }), 'by path'),
      c([O, PDF_A, D1], linksFile({ [PDF_A]: link(GONE, D1, 5) }), 'its note is gone'),
      c(
        [O, PDF_A, D1],
        linksFile({ [PDF_A]: link(GONE, D1, 5), [PDF_B]: link(NOTE_B, D1, 6) }),
        'another PDF with the same hash',
      ),
      c(
        [O, PDF_A, D1],
        linksFile({
          '/tmp/x/old.pdf': link(NOTE_A, D1, 5),
          '/tmp/x/new.pdf': link(NOTE_B, D1, 9),
          '/tmp/x/other.pdf': link(NOTE_B, D2, 99),
        }),
        'the most recent of the same hash',
      ),
      c(
        [O, PDF_A, D1],
        linksFile({ '/tmp/x/old.pdf': link(NOTE_A, D1, 5), '/tmp/x/new.pdf': link(GONE, D1, 9) }),
        'the most recent has no note: the older one',
      ),
      c([O, PDF_A, D1], linksFile({ '/tmp/x/new.pdf': link(GONE, D1, 9) }), 'every note gone'),
      c([O, PDF_A, D1], linksFile({ [PDF_B]: link(NOTE_B, D2, 6) }), 'no link of that hash'),
      c(
        [O, PDF_A, 'bad hash'],
        linksFile({ [PDF_B]: link(NOTE_B, 'bad hash', 6) }),
        'document hash',
      ),
      c(
        [O, PDF_A, 'bad hash'],
        linksFile({ [PDF_A]: link(NOTE_A, D1, 5) }),
        'document hash, but the path matches',
      ),
      c([O, PDF_A, D1], undefined, 'no links'),
      c(
        [O, '/tmp/main-diff-pdfs/../main-diff-pdfs/a.pdf', D1],
        linksFile({ [PDF_A]: link(NOTE_A, D1, 5) }),
        'the key is the resolved path',
      ),
    ],
  },
  'pdf-structure/store.setNoteLink': {
    ts: store('setNoteLink'),
    cases: [
      c([O, PDF_A, { notePath: '$DIR/note.md', docHash: D1 }]),
      c(
        [O, PDF_A, { notePath: '$DIR/new.md', docHash: D2 }],
        linksFile({ [PDF_A]: link(NOTE_A, D1, 5), [PDF_B]: link(NOTE_B, D1, 6) }),
        'replaces, the other link stays',
      ),
      c([O, PDF_A, { notePath: 'relative/note.md', docHash: D1 }], undefined, 'relative note path'),
      c([O, PDF_A, { notePath: '$DIR/note.md', docHash: 'bad hash' }], undefined, 'document hash'),
      c(
        [O, PDF_A, { notePath: '$DIR/note.md', docHash: D1 }],
        { [`${S}/note-links.json`]: 'junk' },
        'an unreadable file is started over',
      ),
      c(
        [O, PDF_A, { notePath: '$DIR/note.md', docHash: D1 }],
        BLOCKED,
        'the store folder is a file',
      ),
    ],
  },
  'pdf-structure/store.updateNoteLinkDocHash': {
    ts: store('updateNoteLinkDocHash'),
    cases: [
      c(
        [O, PDF_A, D2],
        linksFile({ [PDF_A]: link(NOTE_A, D1, 5), [PDF_B]: link(NOTE_B, D1, 6) }),
        'the hash changes, the time too',
      ),
      c([O, PDF_A, D2], linksFile({ [PDF_B]: link(NOTE_B, D1, 6) }), 'no link of that path'),
      c([O, PDF_A, D2], undefined, 'no links'),
      c([O, PDF_A, 'bad hash'], linksFile({ [PDF_A]: link(NOTE_A, D1, 5) }), 'document hash'),
    ],
  },

  // migration, delete and size
  'pdf-structure/store.migrateDocument': {
    ts: store('migrateDocument'),
    cases: [
      c([O, MIGRATE], oldDocument(), 'everything that survives'),
      c(
        [O, { ...MIGRATE, keepBlockKeys: [K('fpA', 'h1', 0)] }],
        oldDocument(),
        'only the kept translation blocks',
      ),
      c([O, { ...MIGRATE, keepBlockKeys: [] }], oldDocument(), 'none kept'),
      c(
        [O, { ...MIGRATE, pageFingerprints: ['fpA', 'fpB', 'fpC'] }],
        oldDocument(),
        'every page survives, so every insights entry',
      ),
      c([O, { ...MIGRATE, pageFingerprints: [] }], oldDocument(), 'no page survives'),
      c(
        [O, { ...MIGRATE, pageFingerprints: ['fpA', 'f p'] }],
        oldDocument(),
        'a fingerprint that is no key',
      ),
      c(
        [O, MIGRATE],
        merge(
          oldDocument(),
          aiFile(D2, 'fpA', NOW),
          metaFile(D2, 'en', NOW),
          blkFile(D2, 'en', K('fpA', 'h1', 0), { savedAt: NOW, text: 'newer' }),
          cardFile(D2, card('c1', 'fpA', NOW)),
          runFile(D2, run('run1'), NOW),
          hBlockFile(D2, 'run1', hBlock(K('fpA', 'h1', 0), { savedAt: NOW })),
          insFile(D2, insights('en', ['fpA', 'fpB']), NOW),
          metaFile(D2, 'ko', NOW, 'easy'),
          blkFile(D2, 'ko', K('fpA', 'h1', 0), { savedAt: NOW }, 'easy'),
        ),
        'entries of the new document that are newer stay',
      ),
      c(
        [O, MIGRATE],
        merge(
          oldDocument(),
          aiFile(D2, 'fpA', 1),
          metaFile(D2, 'en', 1),
          blkFile(D2, 'en', K('fpA', 'h1', 0), { savedAt: 1, text: 'older' }),
          cardFile(D2, card('c1', 'fpA', 1)),
          runFile(D2, run('run1'), 1),
          hBlockFile(D2, 'run1', hBlock(K('fpA', 'h1', 0), { savedAt: 1 })),
          insFile(D2, insights('en', ['fpA', 'fpB']), 1),
        ),
        'older ones are replaced',
      ),
      c(
        [O, MIGRATE],
        merge(
          oldDocument(),
          aiFile(D2, 'fpA', NOW - 5000),
          metaFile(D2, 'en', NOW - 5000),
          blkFile(D2, 'en', K('fpA', 'h1', 0), { savedAt: NOW - 5000, text: 'same time' }),
          cardFile(D2, card('c1', 'fpA', NOW - 5000)),
          hBlockFile(D2, 'run1', hBlock(K('fpA', 'h1', 0), { savedAt: NOW - 5000 })),
          insFile(D2, insights('en', ['fpA', 'fpB']), NOW - 5000),
        ),
        'the same time is not newer',
      ),
      c(
        [O, { oldDocHash: D1, newDocHash: D1, pageFingerprints: ['fpA'] }],
        oldDocument(),
        'the same hash',
      ),
      c(
        [O, { oldDocHash: 'bad hash', newDocHash: D2, pageFingerprints: ['fpA'] }],
        undefined,
        'old hash that is no key',
      ),
      c(
        [O, { oldDocHash: D1, newDocHash: 'bad hash', pageFingerprints: ['fpA'] }],
        oldDocument(),
        'new hash that is no key',
      ),
      c(
        [O, { oldDocHash: D1, newDocHash: 'bad hash', pageFingerprints: ['fpA'] }],
        undefined,
        'new hash that is no key, nothing to move',
      ),
      c([O, MIGRATE], undefined, 'nothing stored'),
      c(
        [O, MIGRATE],
        merge(aiFile(D1, 'fpA', 5, { provider: 'p', model: 'm' }), aiFile(D1, 'fpZ', 5), {
          [aiPath(D1, 'fpB')]: 'junk',
        }),
        'AI-read pages only',
      ),
      c(
        [O, MIGRATE],
        merge(metaFile(D1, 'en', 5), { [`${trDir(D1, 'en')}/translation.json`]: 'junk' }),
        'an unreadable provider record',
      ),
      c(
        [O, MIGRATE],
        blkFile(D1, 'en', K('fpA', 'h1', 0), {
          runs: [{ kind: 'text', text: 'hello' }],
          reason: 'r',
          text: 'Hello world',
          sourceSentenceEnds: [6, 12],
          sentenceEnds: [5, 11],
        }),
        'a block with runs, reason and sentence ends',
      ),
      c(
        [O, MIGRATE],
        merge(
          blkFile(D1, 'en', K('fpA', 'h1', 0), { edited: true, text: 'by hand' }),
          blkFile(D1, 'en', K('fpA', 'h2', 0), { status: 'failed', reason: 'x' }),
        ),
        'edited and failed blocks',
      ),
      c(
        [O, MIGRATE],
        merge(oldDocument(), { [`${docDir(D2)}/ai-read`]: 'a file where the new folder goes' }),
        'the new document cannot be written',
      ),
    ],
  },
  'pdf-structure/store.deleteDocument': {
    ts: store('deleteDocument'),
    cases: [
      c([O, D1], merge(oldDocument(), aiFile(D2, 'fpA', 1)), 'one document, not the other'),
      c([O, D1], undefined, 'nothing there'),
      c([O, 'bad hash'], undefined, 'document hash'),
      c(
        [O, D1],
        {
          [`${docDir(D1)}/ai-read/x.json`]: { text: '{}', mode: 0o444 },
          [`${docDir(D1)}/ai-read`]: { dir: true, mode: 0o555 },
        },
        'cannot delete from a read-only folder',
      ),
    ],
  },
  'pdf-structure/store.deleteAll': {
    ts: store('deleteAll'),
    cases: [
      c(
        [O],
        merge(oldDocument(), aiFile(D2, 'fpA', 1), linksFile({ [PDF_A]: link(NOTE_A, D1, 5) }), {
          outside: 'stays: not in the store folder',
        }),
        'the store, not the folder around it',
      ),
      c([O], undefined, 'nothing there'),
      c([O], BLOCKED, 'the store folder is a file'),
    ],
  },
  'pdf-structure/store.size': {
    ts: store('size'),
    cases: [
      c([O], merge(oldDocument(), aiFile(D2, 'fpA', 1)), 'the whole store'),
      c([O, D1], merge(oldDocument(), aiFile(D2, 'fpA', 1)), 'one document'),
      c([O, D2], merge(oldDocument(), aiFile(D2, 'fpA', 1)), 'the other one'),
      c([O], undefined, 'empty'),
      c([O, 'bad hash'], oldDocument(), 'document hash'),
      c(
        [O, D1],
        merge(oldDocument(), {
          [`${docDir(D1)}/x/unreadable`]: { text: 'twelve bytes', mode: 0o000 },
        }),
        'an entry that cannot be read still counts',
      ),
      c(
        [O],
        merge(aiFile(D1, 'fpA', 1), {
          [`${S}/.hidden.tmp`]: 'dot files count as well',
          [`${S}/empty`]: { dir: true },
        }),
        'dot files and folders',
      ),
    ],
  },

  // ── the file primitives ──
  'pdf-structure/files.isTempName': {
    ts: (args) => isTempName(args[0] as string),
    cases: [c(['.entry.json.tmp']), c(['entry.json']), c(['']), c(['a.b'])],
  },
  'pdf-structure/files.lockPathOf': {
    ts: (args) => lockPathOf(args[0] as string),
    cases: [c(['/a/b/entry.json']), c(['entry.json']), c(['/a/b/'])],
  },
  'pdf-structure/files.writeJsonAtomic': {
    ts: (args) => writeJsonAtomic(args[0] as string, args[1]),
    cases: [
      c(
        ['$DIR/x/y/entry.json', { a: 1, b: [1, 'two', null], c: { d: true } }],
        undefined,
        'folders made on the way',
      ),
      c(['$DIR/entry.json', { new: true }], { 'entry.json': '{"old":true}' }, 'replaces'),
      c(['$DIR/entry.json', 'text with \u2028 and 한글'], undefined, 'a string'),
      c(['$DIR/entry.json', null], undefined, 'null'),
      c(
        ['$DIR/entry.json', { a: 1 }],
        {
          'entry.json': '{"old":true}',
          '.entry.json.lock': { text: '{"pid":1,"id":"x"}', mtimeMs: 1_000_000_000_000 },
        },
        'a lock left behind long ago',
      ),
      c(
        ['$DIR/entry.json', { a: 1 }],
        { '.entry.json.lock': '{"pid":2147483000,"id":"x"}' },
        'a lock of a process that is gone',
      ),
      c(['$DIR/blocker/entry.json', { a: 1 }], { blocker: 'a file' }, 'a file where a folder goes'),
      c(
        ['$DIR/ro/entry.json', { a: 1 }],
        { 'ro/other.json': '{}', ro: { dir: true, mode: 0o555 } },
        'a read-only folder',
      ),
      c(
        ['$DIR/entry.json', { a: 1 }],
        { 'entry.json': { dir: true } },
        'a folder where the entry goes',
      ),
    ],
  },
  'pdf-structure/files.readJson': {
    ts: (args) => readJson(args[0] as string),
    cases: [
      c(['$DIR/a.json'], { 'a.json': '{"a":[1,2,{"b":null}]}' }),
      c(['$DIR/a.json'], { 'a.json': '"text"' }, 'a string'),
      c(['$DIR/a.json'], undefined, 'missing'),
      c(['$DIR/a.json'], { 'a.json': '{"a":' }, 'cut off'),
      c(['$DIR/a.json'], { 'a.json': '' }, 'empty'),
      c(['$DIR/a.json'], { 'a.json': '\uFEFF{"a":1}' }, 'a byte-order mark'),
      c(['$DIR/a.json'], { 'a.json': { dir: true } }, 'a folder'),
      c(['$DIR/a.json'], { 'a.json': { hex: 'ff7b7d', mode: 0o644 } }, 'bytes that are no UTF-8'),
      c(['$DIR/a.json'], { 'a.json': { text: '{"a":1}', mode: 0o000 } }, 'unreadable'),
    ],
  },
  'pdf-structure/files.listNames': {
    ts: (args) => listNames(args[0] as string, args[1] as 'file' | 'dir'),
    cases: [
      c(
        ['$DIR/d', 'file'],
        {
          'd/b.json': '{}',
          'd/a.json': '{}',
          'd/.hidden': '{}',
          'd/sub/x': '{}',
          'd/Z.json': '{}',
        },
        'files, sorted, no dot names',
      ),
      c(
        ['$DIR/d', 'dir'],
        { 'd/b.json': '{}', 'd/sub/x': '{}', 'd/alpha/x': '{}', 'd/.dot/x': '{}' },
        'folders',
      ),
      c(['$DIR/d', 'file'], undefined, 'missing'),
      c(['$DIR/d', 'file'], { d: 'a file' }, 'not a folder'),
      c(['$DIR/d', 'file'], { 'd/a': 'x', 'd/link': { link: 'd/a' } }, 'a hard link is a file'),
    ],
  },
  'pdf-structure/files.folderSize': {
    ts: (args) => folderSize(args[0] as string),
    cases: [
      c(['$DIR/d'], { 'd/a.json': '12345', 'd/sub/b.json': '1234567', 'd/sub/deeper/c': '12' }),
      c(['$DIR/d'], undefined, 'missing'),
      c(['$DIR/d'], { 'd/empty': { dir: true } }, 'empty'),
      c(['$DIR/d'], { d: 'a file' }, 'a file'),
      c(['$DIR/d'], { 'd/a': 'abc', 'd/b': { link: 'd/a' } }, 'each name counts'),
    ],
  },
  'pdf-structure/files.fileExists': {
    ts: (args) => fileExists(args[0] as string),
    cases: [
      c(['$DIR/a.json'], { 'a.json': '{}' }),
      c(['$DIR/a.json'], undefined, 'missing'),
      c(['$DIR/a.json'], { 'a.json': { dir: true } }, 'a folder'),
      c(['$DIR/a.json'], { 'a.json': { text: '', mode: 0o000 } }, 'unreadable'),
    ],
  },
  'pdf-structure/files.removeEntry': {
    ts: (args) => removeEntry(args[0] as string),
    cases: [
      c(['$DIR/d/a.json'], { 'd/a.json': '{}', 'd/b.json': '{}' }, 'one of two'),
      c(['$DIR/d/a.json'], undefined, 'missing'),
      c(['$DIR/d/a.json'], { d: 'a file' }, 'the folder is a file'),
      c(
        ['$DIR/d/a.json'],
        {
          'd/a.json': '{}',
          'd/.a.json.lock': { text: '{"pid":1,"id":"x"}', mtimeMs: 1_000_000_000_000 },
        },
        'a lock left behind long ago',
      ),
      c(
        ['$DIR/d/a.json'],
        { 'd/a.json': '{}', 'd/.a.json.lock': '{"pid":2147483000,"id":"x"}' },
        'a lock of a process that is gone',
      ),
    ],
  },
  'pdf-structure/files.removeFolder': {
    ts: (args) => removeFolder(args[0] as string),
    cases: [
      c(['$DIR/d'], { 'd/a.json': '{}', 'd/sub/b.json': '{}', keep: 'x' }, 'a tree'),
      c(['$DIR/d'], undefined, 'missing'),
      c(['$DIR/d'], { d: 'a file' }, 'a file'),
      c(
        ['$DIR/d'],
        { 'd/sub/a.json': { text: '{}', mode: 0o444 }, 'd/sub': { dir: true, mode: 0o555 } },
        'a read-only folder inside',
      ),
    ],
  },

  // ── pieces of the store ──
  'pdf-structure/keys.normalizeSourceText': {
    ts: (args) => normalizeSourceText(args[0] as InlineRun[]),
    cases: [
      c([[text('  Hello   world \n')]]),
      c([
        [
          text('a'),
          { kind: 'lineBreak' } as InlineRun,
          text('b'),
          { kind: 'math', latex: 'x^2' } as InlineRun,
          { kind: 'footnoteRef' } as InlineRun,
        ],
      ]),
      c([[text('e\u0301')]], undefined, 'decomposed text is composed'),
      c([[text('\u00a0a\u3000b\t')]], undefined, 'other spaces'),
      c([[]], undefined, 'no runs'),
    ],
  },
  'pdf-structure/keys.translationBlockKeys': {
    ts: (args) => translationBlockKeys(args[0] as Parameters<typeof translationBlockKeys>[0]),
    cases: [
      c(
        [
          [
            { runs: [text('a')], pageFingerprint: 'fpA' },
            { runs: [text('b')], pageFingerprint: 'fpA' },
            { runs: [text(' a ')], pageFingerprint: 'fpA' },
            { runs: [text('a')], pageFingerprint: 'fpB' },
            { runs: [text('a')], pageFingerprint: 'fpA' },
          ],
        ],
        undefined,
        'occurrences count per page and text',
      ),
      c([[]], undefined, 'none'),
      c(
        [
          [
            { runs: [], pageFingerprint: 'fpA' },
            { runs: [], pageFingerprint: 'fpA' },
          ],
        ],
        undefined,
        'empty runs',
      ),
    ],
  },
  'pdf-structure/keys.blockKeyString': {
    ts: (args) => blockKeyString(args[0] as ReturnType<typeof K>),
    cases: [c([K()]), c([K('fpB', 'h9', 12)])],
  },
  'pdf-structure/sentence-ends.validSentenceEnds': {
    ts: (args) => validSentenceEnds(args[0], (args[1] ?? undefined) as number | undefined),
    cases: [
      c([[3, 7]]),
      c([[3, 7], 7], undefined, 'the length'),
      c([[3, 7], 8], undefined, 'not the length'),
      c([[3]], undefined, 'one'),
      c([[3, 3]], undefined, 'not rising'),
      c([[0, 3]], undefined, 'zero'),
      c([[1.5, 3]], undefined, 'fraction'),
      c([[1, 'x']], undefined, 'text'),
      c(['3,7'], undefined, 'no list'),
      c([[9007199254740991, 9007199254740992]], undefined, 'beyond the safe integers'),
      c([null], undefined, 'null'),
    ],
  },
  'pdf-structure/sentence-ends.sentenceEndsPair': {
    ts: (args) => sentenceEndsPair(args[0], args[1], args[2] as number),
    cases: [
      c([[6, 12], [5, 11], 11]),
      c([[6, 12], [5, 11], 12], undefined, 'translated length'),
      c([[6, 12, 20], [5, 11], 11], undefined, 'lists of different length'),
      c([[6], [5, 11], 11], undefined, 'a source list that is too short'),
      c([null, [5, 11], 11], undefined, 'no source list'),
      c([[6, 12], null, 11], undefined, 'no list'),
    ],
  },
  'pdf-structure/reading.isSegment': {
    ts: (args) => isSegment(args[0]),
    cases: [c(['abc_-9']), c(['a b']), c(['']), c([7]), c([null]), c(['é'])],
  },
  'pdf-structure/reading.asPassageCard': {
    ts: (args) => asPassageCard(args[0]),
    cases: [
      c([card('c1', 'fpA', 5)]),
      c(
        [card('c1', 'fpA', 5, { kind: 'translate', lang: 'ko', savedAsNote: true, extra: 1 })],
        undefined,
        'translate',
      ),
      c([card('c1', 'fpA', 5, { kind: 'translate' })], undefined, 'translate without a language'),
      c([card('c1', 'fpA', 5, { lang: 'e n' })], undefined, 'a language that is no key'),
      c([card('c1', 'fpA', 5, { lang: 'ko' })], undefined, 'explain with a language'),
      c([card('c1', 'fpA', 5, { savedAsNote: false })], undefined, 'savedAsNote false'),
      c([card('c1', 'fpA', 5, { kind: 'x' })], undefined, 'kind'),
      c([card('c1', 'fpA', 5, { page: 1.5 })], undefined, 'page'),
      c([card('c1', 'fpA', 5, { quads: 'x' })], undefined, 'quads'),
      c([card('c1', 'fpA', 5, { quads: [[1, 'x']] })], undefined, 'a quad of text'),
      c([card('c1', 'fpA', 5, { quads: [] })], undefined, 'no quads'),
      c([card('c1', 'fpA', 5, { excerpt: 1 })], undefined, 'excerpt'),
      c([card('c1', 'fpA', 5, { createdAt: 'x' })], undefined, 'createdAt'),
      c([card('c1', 'fpA', 5, { savedAt: null })], undefined, 'savedAt'),
      c([[1, 2]], undefined, 'an array'),
      c([null], undefined, 'null'),
    ],
  },
  'pdf-structure/reading.asHighlightRun': {
    ts: (args) => asHighlightRun(args[0]),
    cases: [
      c([run()]),
      c(
        [
          run('run1', {
            presetId: 'textbook',
            pages: [],
            labels: [
              { id: 'l1', name: 'A', color: [0, 1, 0.25] },
              { id: 'l2', name: 'B', color: [1, 1, 1] },
            ],
          }),
        ],
        undefined,
        'other preset, two labels',
      ),
      c([run('run1', { presetId: 'x' })], undefined, 'preset'),
      c([run('run 1')], undefined, 'run id'),
      c([run('run1', { labels: [] })], undefined, 'no labels'),
      c(
        [
          run('run1', {
            labels: [1, 2, 3, 4, 5, 6].map((n) => ({
              id: `l${n}`,
              name: `n${n}`,
              color: [0, 0, 0],
            })),
          }),
        ],
        undefined,
        'six labels',
      ),
      c(
        [run('run1', { labels: [{ id: 'l1', name: 'A', color: [0, 0] }] })],
        undefined,
        'a colour of two',
      ),
      c(
        [run('run1', { labels: [{ id: 'l1', name: 'A', color: [0, 0, 1.1] }] })],
        undefined,
        'a colour out of range',
      ),
      c(
        [run('run1', { labels: [{ id: 'l1', name: 'A', color: [0, 0, 'x'] }] })],
        undefined,
        'a colour of text',
      ),
      c(
        [
          run('run1', {
            labels: [
              { id: 'l1', name: 'A', color: [0, 0, 1] },
              { id: 'l2', name: 'A', color: [0, 0, 1] },
            ],
          }),
        ],
        undefined,
        'the same name twice',
      ),
      c(
        [
          run('run1', {
            labels: [
              { id: 'l1', name: 'e\u0301', color: [0, 0, 1] },
              { id: 'l2', name: '\u00e9', color: [0, 0, 1] },
            ],
          }),
        ],
        undefined,
        'the same name composed',
      ),
      c(
        [run('run1', { labels: [{ id: 'l1', name: '', color: [0, 0, 1] }] })],
        undefined,
        'no name',
      ),
      c(
        [run('run1', { labels: [{ id: 3, name: 'A', color: [0, 0, 1] }] })],
        undefined,
        'a label id that is no text',
      ),
      c(
        [run('run1', { labels: [{ id: 'l1', name: 3, color: [0, 0, 1] }] })],
        undefined,
        'a name that is no text',
      ),
      c([run('run1', { labels: ['x'] })], undefined, 'a label that is no record'),
      c([run('run1', { pages: [0] })], undefined, 'page'),
      c([run('run1', { pages: 'x' })], undefined, 'pages'),
      c([run('run1', { provider: 1 })], undefined, 'provider'),
      c([run('run1', { createdAt: null })], undefined, 'createdAt'),
      c([null], undefined, 'null'),
    ],
  },
  'pdf-structure/reading.asHighlightBlock': {
    ts: (args) => asHighlightBlock(args[0], args[1] as ReturnType<typeof K>),
    cases: [
      c([hBlock(K()), K()]),
      c([hBlock(K(), { status: 'failed', suggestions: [] }), K()], undefined, 'failed'),
      c(
        [
          hBlock(K(), {
            suggestions: [{ id: 's', labelId: 'l', quote: 'q', state: 'accepted', extra: 1 }],
          }),
          K(),
        ],
        undefined,
        'a suggestion with an extra field',
      ),
      c([hBlock(K()), K('fpB')], undefined, 'another page'),
      c([hBlock(K()), K('fpA', 'h2')], undefined, 'another hash'),
      c([hBlock(K()), K('fpA', 'h1', 1)], undefined, 'another occurrence'),
      c([hBlock(K(), { key: 'x' }), K()], undefined, 'a key that is no record'),
      c([hBlock(K(), { status: 'x' }), K()], undefined, 'status'),
      c([hBlock(K(), { savedAt: 'x' }), K()], undefined, 'savedAt'),
      c([hBlock(K(), { suggestions: 'x' }), K()], undefined, 'suggestions'),
      c([hBlock(K(), { suggestions: [3] }), K()], undefined, 'a suggestion that is no record'),
      c(
        [
          hBlock(K(), { suggestions: [{ id: 's', labelId: 'l', quote: 3, state: 'pending' }] }),
          K(),
        ],
        undefined,
        'a quote that is no text',
      ),
      c(
        [hBlock(K(), { suggestions: [{ id: 's', labelId: 'l', quote: 'q', state: 'x' }] }), K()],
        undefined,
        'state',
      ),
      c([null, K()], undefined, 'null'),
    ],
  },
  'pdf-structure/reading.asInsights': {
    ts: (args) => asInsights(args[0]),
    cases: [
      c([insights()]),
      c([insights('ko', ['fpA', 'fpB'], { terms: [], extra: 1 })], undefined, 'no terms'),
      c([insights('e n')], undefined, 'language'),
      c([insights('en', ['fpA'], { summary3: ['a', 'b'] })], undefined, 'two summaries'),
      c(
        [insights('en', ['fpA'], { summary3: ['a', 'b', 3] })],
        undefined,
        'a summary that is no text',
      ),
      c([insights('en', ['fpA'], { summary: 3 })], undefined, 'summary'),
      c([insights('en', ['fpA'], { terms: 'x' })], undefined, 'terms'),
      c(
        [insights('en', ['fpA'], { terms: [{ term: 't', meaning: 'm', page: 0 }] })],
        undefined,
        'term page',
      ),
      c(
        [insights('en', ['fpA'], { terms: [{ term: 1, meaning: 'm', page: 1 }] })],
        undefined,
        'a term that is no text',
      ),
      c([insights('en', ['fpA'], { terms: [5] })], undefined, 'a term that is no record'),
      c([insights('en', ['f p'])], undefined, 'page fingerprint'),
      c([insights('en', ['fpA'], { pageFingerprints: 'x' })], undefined, 'pageFingerprints'),
      c([insights('en', ['fpA'], { model: 3 })], undefined, 'model'),
      c([null], undefined, 'null'),
    ],
  },
  'pdf-structure/note-links.asNoteLinks': {
    ts: (args) => asNoteLinks(args[0]),
    cases: [
      c([
        { version: 1, links: { '/a.pdf': link('/n.md', D1, 5), '/b.pdf': link('/m.md', D2, 6) } },
      ]),
      c([{ version: 2, links: {} }], undefined, 'version'),
      c([{ version: 1, links: [] }], undefined, 'links as a list'),
      c(
        [
          {
            version: 1,
            links: {
              '/a.pdf': link('', D1, 5),
              '/b.pdf': link('/m.md', 'bad hash', 6),
              '/c.pdf': { notePath: '/m.md', docHash: D1, updatedAt: 'x' },
              '/d.pdf': null,
              '/e.pdf': { notePath: 3, docHash: D1, updatedAt: 1 },
              '/f.pdf': { ...link('/m.md', D1, 7), extra: 1 },
            },
          },
        ],
        undefined,
        'only the readable links',
      ),
      c([null], undefined, 'null'),
      c(['text'], undefined, 'text'),
      c(
        [
          {
            version: 1,
            links: {
              '2': link('/n.md', D1, 1),
              b: link('/n.md', D1, 2),
              '1': link('/n.md', D1, 3),
            },
          },
        ],
        undefined,
        'index keys come first',
      ),
    ],
  },
  'tree/hash.sha256Hex': {
    ts: (args) => sha256Hex(args[0] as string),
    cases: [c(['']), c(['abc']), c(['한글 text \u{1F600}']), c(['a'.repeat(200)]), c(['\u0000'])],
  },
  'tree/inline.runsText': {
    ts: (args) => runsText(args[0] as InlineRun[]),
    cases: [
      c([[text('a'), { kind: 'lineBreak' } as InlineRun, text('b')]]),
      c([
        [
          { kind: 'math', latex: 'x^2' } as InlineRun,
          { kind: 'footnoteRef' } as InlineRun,
          text('!'),
        ],
      ]),
      c([[]]),
    ],
  },
  'highlight/run-id.normalizeLabelName': {
    ts: (args) => normalizeLabelName(args[0] as string),
    cases: [c(['  Claim   one \n']), c(['e\u0301']), c(['\u00e9']), c(['']), c(['\u00a0a\u2003b'])],
  },
  'highlight/run-id.highlightRunId': {
    ts: (args) => highlightRunId(args[0] as string, args[1] as string[]),
    cases: [
      c(['research', ['Claim', 'Evidence']]),
      c(['research', ['Evidence', 'Claim']], undefined, 'the order counts'),
      c(['custom', ['Claim', 'Evidence']], undefined, 'the preset counts'),
      c(['research', ['  Claim ', 'Evidence']], undefined, 'spaces do not'),
      c(['research', []], undefined, 'no labels'),
      c(['research', ['한글', 'a"b']], undefined, 'text that JSON writes with an escape'),
    ],
  },
}
