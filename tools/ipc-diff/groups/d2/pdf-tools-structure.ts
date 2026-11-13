/**
 * Group `d2/pdf-tools-structure`: the pdf editor's structure-job and
 * result-store channels (`apps/shell/src/main/pdf-structure-ipc.ts`,
 * `pdf-structure/handlers.ts`), registered as the shell entry registers them.
 * A pdf view is given its file by the `d2/pdf-tools:open-view` trigger (the
 * editor's `grantAndTrack`); the job process and the store answer from the
 * case (pdf-tools-fakes/).
 */
import { createHash } from 'node:crypto'
import type { Case, Group, View } from '../../types.ts'
import { loadPdfTools, trigger, triggers } from './pdf-tools-fakes/load.ts'

const PDF: View = { view: 5, window: 1, surface: 'Pdf' }
const OTHER: View = { view: 6, window: 1, surface: 'Pdf' }
const views = [PDF, OTHER]

const A = '$DIR/documents/a.pdf'
const A_TEXT = '%PDF-a'
/** the document hash the main process computes for a.pdf */
const HA = createHash('sha256').update(A_TEXT).digest('hex')
const files = {
  'documents/a.pdf': A_TEXT,
  'documents/b.pdf': '%PDF-b',
  out: { dir: true as const },
}

const call = (channel: string, ...args: unknown[]) => ({ channel, view: 5, args })
const from = (view: number, channel: string, ...args: unknown[]) => ({ channel, view, args })
const grant = trigger('open-view', 5, [A])
const docHash = call('pdf:store-doc-hash', A)
const write = (req: Record<string, unknown>) => call('pdf:store-write', { docHash: HA, ...req })
const key = { pageFingerprint: 'p1', textHash: 't1', occurrence: 0 }
const hosts = (tools: unknown, dialogs: unknown = {}) => ({
  shared: { dialogs },
  d2: { pdf: { tools } },
})

const cases: Case[] = [
  {
    note: 'job channels refuse a bad job id, a request that is not an object, a file not granted',
    views,
    files,
    calls: [
      call('pdf:structure-tree', null),
      call('pdf:structure-tree', { jobId: 'bad id', path: A }),
      call('pdf:structure-tree', { jobId: 't', path: A }),
      call('pdf:structure-text', { path: A }),
      call('pdf:structure-text', { jobId: 't', path: 5 }),
      call('pdf:structure-convert', { jobId: 'c', path: A, format: 'md' }),
      call('pdf:structure-convert', 'x'),
      call('pdf:structure-extract-images', { jobId: 'i', path: A }),
      call('pdf:structure-extract-images', {}),
      call('pdf:structure-write-back', { jobId: 'w', path: A }),
      call('pdf:structure-write-back', { jobId: '' }),
      call('pdf:structure-pick-target', null),
      call('pdf:structure-pick-target', { kind: 'md', path: A }),
      call('pdf:structure-cancel', 'j'),
      call('pdf:structure-cancel', 5),
    ],
  },
  {
    note: 'store channels take only a hash the main process computed for the view',
    views,
    files,
    calls: [
      call('pdf:store-doc-hash', A),
      call('pdf:store-doc-hash', 5),
      call('pdf:store-ai-read-pages', HA),
      call('pdf:store-translations', HA),
      call('pdf:store-translation', HA, 'en'),
      call('pdf:store-unfinished-jobs', HA),
      call('pdf:store-passages', HA),
      call('pdf:store-highlight-runs', HA),
      call('pdf:store-highlight-blocks', HA, 'r'),
      call('pdf:store-latest-highlight', HA),
      call('pdf:store-insights', HA, 'en'),
      call('pdf:store-delete-counts', HA),
      call('pdf:store-translation-recency', HA),
      call('pdf:store-delete-document', HA),
      call('pdf:store-write', null),
      call('pdf:store-write', { kind: 'job', docHash: HA, job: {} }),
      call('pdf:store-migrate', [1]),
      call('pdf:store-migrate', { oldDocHash: HA, path: A }),
      call('pdf:store-page-fingerprints', null),
      call('pdf:store-page-fingerprints', { path: A }),
    ],
  },
  {
    note: 'the hash of the granted file opens the store; reads, their argument checks, their order',
    views,
    files,
    hosts: hosts({
      'store.listTranslations': [['en', 'ko'], ['en'], ['en', 'ko']],
      'store.readTranslation': [
        { lang: 'en', provider: 'p', blocks: [{ key: 'k', text: 'x', savedAt: 5 }] },
        { lang: 'en', blocks: [{ savedAt: 3 }, { savedAt: 7 }] },
        null,
      ],
      'store.unfinishedJobs': [[{ kind: 'translate', state: 'running' }]],
      'store.readAiReadPages': [
        [
          { fingerprint: 'f1', page: 1, blocks: [{ key: 'b', text: 'x' }] },
          { fingerprint: 'f2', page: 2, blocks: [] },
        ],
      ],
      'store.readPassages': [[{ id: 'c1' }]],
      'store.listHighlightRuns': [
        [
          { runId: 'b', createdAt: 1 },
          { runId: 'A', createdAt: 2 },
          { runId: 'a', createdAt: 1 },
        ],
        [{ runId: 'r', createdAt: 1 }],
      ],
      'store.readHighlightBlocks': [[{ key: 1 }], [{ key: 2 }, { key: 3 }]],
      'store.readInsights': [{ summary: 's' }],
      'store.countEditedTranslationBlocks': [2, 3],
      'store.countPassages': [4],
    }),
    calls: [
      grant,
      docHash,
      call('pdf:store-ai-read-pages', HA),
      call('pdf:store-ai-read-pages', HA),
      from(6, 'pdf:store-ai-read-pages', HA),
      call('pdf:store-translations', HA),
      call('pdf:store-translations', HA, 'easy'),
      call('pdf:store-translations', HA, 'plain'),
      call('pdf:store-translation', HA, 'en'),
      call('pdf:store-translation', HA, 'e n'),
      call('pdf:store-translation', HA, 'en', 3),
      call('pdf:store-translation-recency', HA, 'easy'),
      call('pdf:store-translation-recency', HA, null),
      call('pdf:store-unfinished-jobs', HA),
      call('pdf:store-passages', HA),
      call('pdf:store-highlight-runs', HA),
      call('pdf:store-highlight-blocks', HA, 'r1'),
      call('pdf:store-highlight-blocks', HA, 'r 1'),
      call('pdf:store-latest-highlight', HA),
      call('pdf:store-insights', HA, 'en'),
      call('pdf:store-insights', HA, 5),
      call('pdf:store-delete-counts', HA),
      call('pdf:store-delete-document', HA),
      from(6, 'pdf:store-passages', HA),
    ],
  },
  {
    note: 'store writes: each kind with its checks',
    views,
    files,
    hosts: hosts({
      'store.heartbeatJob': [false, true],
      'store.setHighlightSuggestionStates': [false],
      'store.deleteTranslationExceptEdited': [2],
    }),
    calls: [
      grant,
      docHash,
      write({ kind: 'aiReadPage', pageFingerprint: 'p1', payload: { a: 1 }, provider: 'x' }),
      write({ kind: 'aiReadPage', pageFingerprint: 'p1', payload: {}, model: 5 }),
      write({ kind: 'translationMeta', lang: 'en', provider: 'p', model: 'm', mode: 'easy' }),
      write({ kind: 'translationBlocks', lang: 'en', blocks: [{ a: 1 }] }),
      write({ kind: 'translationBlocks', lang: 'en', blocks: [1] }),
      write({ kind: 'deleteTranslation', lang: 'en' }),
      write({ kind: 'job', job: { kind: 'translate' } }),
      write({ kind: 'job', job: 'x' }),
      write({ kind: 'heartbeat', job: 'translate', lang: 'en' }),
      write({ kind: 'heartbeat', job: 'highlight', runId: 'r', mode: 'easy' }),
      write({ kind: 'heartbeat', job: 'nope' }),
      write({ kind: 'passage', card: { id: 'c' } }),
      write({ kind: 'deletePassage', id: 'c1' }),
      write({ kind: 'deletePassage', id: 'c 1' }),
      write({ kind: 'highlightRun', run: { runId: 'r' } }),
      write({ kind: 'highlightBlocks', runId: 'r', blocks: [{ key }] }),
      write({ kind: 'highlightBlocks', runId: 'r', blocks: [{ key: { ...key, occurrence: -1 } }] }),
      write({ kind: 'highlightSuggestionStates', runId: 'r', key, states: { s1: 'accepted' } }),
      write({ kind: 'highlightSuggestionStates', runId: 'r', key, states: { s1: 'maybe' } }),
      write({ kind: 'deleteHighlightRun', runId: 'r' }),
      write({ kind: 'insights', entry: { a: 1 } }),
      write({ kind: 'editedTranslationBlock', lang: 'en', key, text: 't', mode: 'easy' }),
      write({ kind: 'editedTranslationBlock', lang: 'en', key, text: 5 }),
      write({ kind: 'deleteTranslationExceptEdited', lang: 'en' }),
      write({ kind: 'nope' }),
      write({ kind: 'job', job: {}, mode: 'x' }),
    ],
  },
  {
    note: 'what the store throws: a failed write, a type error, anything else',
    views,
    files,
    hosts: hosts({
      'store.writeJob': [{ $error: 'write', message: 'disk full' }],
      'store.writePassage': [{ $error: 'type', message: 'bad card' }],
      'store.readInsights': [{ $error: 'other', message: 'boom' }],
      'store.readAiReadPages': [{ $error: 'type', message: 'bad page' }],
    }),
    calls: [
      grant,
      docHash,
      write({ kind: 'job', job: {} }),
      write({ kind: 'passage', card: {} }),
      call('pdf:store-insights', HA, 'en'),
      call('pdf:store-ai-read-pages', HA),
    ],
  },
  {
    note: 'a tree job with progress, then the cached tree; text jobs by pages',
    views,
    files,
    hosts: hosts({
      run_job: [
        {
          value: {
            docHash: HA,
            tree: { blocks: [{ kind: 'image', data: { $u8: [1, 2] } }, { kind: 'text' }] },
            fingerprints: [
              { page: 2, fingerprint: 'f2' },
              { page: 1, fingerprint: 'f1' },
            ],
          },
          progress: [[1, 2]],
        },
        {
          value: {
            docHash: HA,
            pages: [{ page: 1 }],
            extracted: { tree: { blocks: [] }, fingerprints: [] },
          },
        },
        { value: { docHash: HA, pages: [] } },
      ],
    }),
    calls: [
      grant,
      call('pdf:structure-tree', { jobId: 't1', path: A }),
      call('pdf:structure-tree', { jobId: 't2', path: A, imageData: true }),
      call('pdf:store-page-fingerprints', { path: A }),
      call('pdf:structure-text', { jobId: 'x1', path: A, pages: [2, 1, 2] }),
      call('pdf:structure-text', { jobId: 'x2', path: A, pages: [1, 2], password: 'pw' }),
      call('pdf:structure-tree', { jobId: 't3', path: A, pages: [0] }),
      call('pdf:structure-tree', { jobId: 't3', path: A, password: 5 }),
      call('pdf:store-migrate', { oldDocHash: HA, path: A }),
    ],
  },
  {
    note: 'page fingerprints from a job, then from the cache; a migration to new bytes moves job records',
    views,
    files,
    hosts: hosts({
      run_job: [
        { value: { docHash: 'old1', fingerprints: ['x'] } },
        { value: { docHash: HA, fingerprints: ['f'] } },
        { error: 'corrupt', message: 'bad' },
      ],
      'store.migrateDocument': [{ aiReadPages: 1, translationBlocks: 2, languages: ['en'] }],
      'store.listJobs': [
        [{ kind: 'translate', lang: 'en', state: 'idle', outputs: [], updatedAt: 5, mode: 'easy' }],
      ],
      'store.readJob': [{ state: 'running', updatedAt: 1 }, { state: 'idle' }],
    }),
    calls: [
      grant,
      call('pdf:store-page-fingerprints', { path: A, password: 'pw' }),
      call('pdf:store-migrate', { oldDocHash: 'old1', path: A }),
      call('pdf:store-page-fingerprints', { path: A }),
      call('pdf:store-page-fingerprints', { path: '$DIR/documents/b.pdf' }),
    ],
  },
  {
    note: 'a conversion writes only to a target picked for the view and kind, and uses it once',
    views,
    files,
    hosts: hosts(
      {
        run_job: [
          { value: { docHash: 'h2', outPath: 'x' } },
          { value: { docHash: 'h3', outDir: 'y', images: [] } },
          { error: 'unsupported', message: 'encrypted source' },
        ],
      },
      {
        save: ['$DIR/out/book.epub', '$DIR/out/t.pdf', A, null],
        open: [['$DIR/out']],
      },
    ),
    calls: [
      grant,
      call('pdf:structure-pick-target', { kind: 'epub', path: A, defaultName: 'a:b', title: 'T' }),
      from(6, 'pdf:structure-convert', {
        jobId: 'c0',
        path: A,
        format: 'epub',
        outPath: '$DIR/out/book.epub',
        epub: { title: 'T' },
      }),
      call('pdf:structure-convert', {
        jobId: 'c1',
        path: A,
        format: 'pdf',
        outPath: '$DIR/out/book.epub',
      }),
      call('pdf:structure-convert', {
        jobId: 'c1',
        path: A,
        format: 'epub',
        outPath: '$DIR/out/book.epub',
      }),
      call('pdf:structure-convert', {
        jobId: 'c1',
        path: A,
        format: 'epub',
        outPath: '$DIR/out/book.epub',
        translation: { lang: 'en', bilingual: 'yes' },
      }),
      call('pdf:structure-convert', {
        jobId: 'c1',
        path: A,
        format: 'epub',
        outPath: '$DIR/out/book.epub',
        epub: { title: 'T', cover: true, language: 'ko', pageBreaks: false },
        translation: { lang: 'en', bilingual: true },
      }),
      call('pdf:structure-convert', {
        jobId: 'c2',
        path: A,
        format: 'epub',
        outPath: '$DIR/out/book.epub',
        epub: { title: 'T' },
      }),
      call('pdf:structure-pick-target', { kind: 'folder', path: A }),
      call('pdf:structure-extract-images', {
        jobId: 'i1',
        path: A,
        outDir: '$DIR/out',
        minImagePx: 0,
      }),
      call('pdf:structure-extract-images', {
        jobId: 'i1',
        path: A,
        outDir: '$DIR/out',
        minImagePx: 64,
        baseName: 'pic',
      }),
      call('pdf:structure-pick-target', { kind: 'pdf', path: A, defaultName: 'Translated.PDF' }),
      call('pdf:structure-write-back', {
        jobId: 'w1',
        path: A,
        outPath: '$DIR/out/t.pdf',
        payload: { lang: 'ko', bilingual: true },
      }),
      call('pdf:structure-write-back', {
        jobId: 'w2',
        path: A,
        outPath: '$DIR/out/t.pdf',
        payload: { lang: 'k' },
      }),
      call('pdf:structure-pick-target', { kind: 'md', path: A }),
      call('pdf:structure-pick-target', { kind: 'md', path: A }),
      call('pdf:store-passages', 'h2'),
    ],
  },
  {
    note: 'Save As grants a Markdown target to the view, never its source',
    views,
    files,
    hosts: hosts({ run_job: [{ value: { docHash: 'h', outPath: 'o' } }] }),
    calls: [
      trigger('grant-structure-target', 5, [A, '$DIR/out/a.md', 'md']),
      grant,
      trigger('grant-structure-target', 5, [A, A, 'md']),
      trigger('grant-structure-target', 5, [A, '$DIR/out/a.md', 'epub']),
      trigger('grant-structure-target', 5, [A, '$DIR/out/a.md', 'md']),
      call('pdf:structure-convert', {
        jobId: 'm',
        path: A,
        format: 'md',
        outPath: '$DIR/out/a.md',
      }),
      trigger('cancel-all', 5),
    ],
  },
]

export const group: Group = {
  batch: 'D2',
  load: loadPdfTools,
  cases,
  single: {
    'pdf:structure-cancel':
      'a job answers before the next call runs in both harnesses, so a cancel never finds one: false',
  },
  triggers,
}
