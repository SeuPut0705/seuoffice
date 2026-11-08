/**
 * The page translation and edited blocks on the translation job (spec 4.5,
 * 5.3, 5.6): a 'translate-page' job keeps its own record and leaves the
 * translate record alone, writes the translation meta only when there is
 * none, edited blocks count as done, and a restart can keep them. Runs on
 * the real result store in a temp folder; the model is a fake.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentJobBusyError,
  DocumentJobRegistry,
  estimateTranslationJob,
  startDocumentJob,
  startTranslationJob,
} from '../src/jobs'
import {
  ResultStore,
  blockKeyString,
  translationBlockKeys,
  type StoredTranslation,
} from '../src/store'
import { sha256Hex, type DocumentTree, type InlineRun } from '../src/tree'
import {
  buildBilingualTree,
  buildTranslatedTree,
  translationJobParts,
  translationUnits,
  type TranslationModelRequest,
} from '../src/translate'
import { treeToMarkdown } from '../src/markdown'

const t = (text: string): InlineRun[] => [{ kind: 'text', text }]
const fp = (n: number) => sha256Hex(`page-${n}`)
const at = (page: number) => ({ page, pageFingerprint: fp(page), source: 'pdf' as const })
const CLAUDE = { provider: 'claude-code', model: 'opus' }
const CODEX = { provider: 'codex', model: 'gpt-x' }

function tree(): DocumentTree {
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 2,
    pages: [1, 2].map((page) => ({
      page,
      fingerprint: fp(page),
      status: 'text' as const,
      widthPt: 612,
      heightPt: 792,
    })),
    blocks: [
      { ...at(1), id: 'p1.0', kind: 'pageBreak' },
      { ...at(1), id: 'p1.1', kind: 'paragraph', runs: t('First one') },
      {
        ...at(1),
        id: 'p1.2',
        kind: 'paragraph',
        runs: [
          { kind: 'text', text: 'Bold ' },
          { kind: 'text', text: 'part', bold: true },
        ],
      },
      { ...at(2), id: 'p2.0', kind: 'pageBreak' },
      { ...at(2), id: 'p2.1', kind: 'paragraph', runs: t('Second page') },
    ],
    footnotes: [],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [],
    warnings: [],
  }
}

function sentBlocks(req: TranslationModelRequest): { id: string; text: string }[] {
  const json = /<document_blocks>\n([\s\S]*)\n<\/document_blocks>/.exec(req.prompt)?.[1]
  return (JSON.parse(json!) as { blocks: { id: string; text: string }[] }).blocks
}

/** a fake translator that logs the source texts it got */
function model(sent: string[]) {
  return async (req: TranslationModelRequest): Promise<string> => {
    const blocks = sentBlocks(req)
    sent.push(...blocks.map((b) => b.text))
    return JSON.stringify({
      translations: blocks.map((b) => ({
        id: b.id,
        text: b.text.replace(/(^|>)([^<]+)/g, (_m, e: string, s: string) => `${e}[ko]${s}`),
      })),
    })
  }
}

let root: string
let store: ResultStore
const DOC = sha256Hex('page-job-doc')
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-translate-page-'))
  store = new ResultStore(root)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function run(
  sent: string[],
  o: {
    kind?: 'translate' | 'translate-page'
    pages?: number[]
    restart?: boolean
    keepEdited?: boolean
    model?: { provider: string; model: string }
  } = {},
) {
  const parts = translationJobParts(tree(), {
    lang: 'ko',
    send: model(sent),
    ...(o.pages ? { pages: o.pages } : {}),
  })
  return startTranslationJob({
    docHash: DOC,
    lang: 'ko',
    model: o.model ?? CLAUDE,
    store,
    registry: new DocumentJobRegistry(),
    concurrency: 1,
    retryDelayMs: 0,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.restart ? { restart: true } : {}),
    ...(o.keepEdited ? { keepEdited: true } : {}),
    ...parts,
  })
}

const keys = () => translationBlockKeys(translationUnits(tree()))

describe('page translation job', () => {
  it('records under translate-page.<lang> and never touches translate.<lang>', async () => {
    await store.writeJob(DOC, {
      kind: 'translate',
      lang: 'ko',
      state: 'stopped',
      last_error: 'rate-limit',
      progress: { done: 0, total: 3 },
    })
    const before = await store.readJob(DOC, 'translate', 'ko')
    const sent: string[] = []
    const handle = run(sent, { kind: 'translate-page', pages: [2] })
    expect(handle.kind).toBe('translate-page')
    const summary = await handle.result
    expect(summary.state).toBe('complete')
    expect(sent).toEqual(['Second page'])
    expect(await store.readJob(DOC, 'translate', 'ko')).toEqual(before)
    expect(await store.readJob(DOC, 'translate-page', 'ko')).toMatchObject({
      kind: 'translate-page',
      lang: 'ko',
      state: 'complete',
      progress: { done: 1, total: 1 },
    })
    // the blocks land where the document translation keeps them
    const stored = await store.readTranslation(DOC, 'ko')
    expect(stored?.blocks.get(blockKeyString(keys()[2]!))?.text).toBe('[ko]Second page')
  })

  it('writes the translation meta only when there is none', async () => {
    const first = run([], { kind: 'translate-page', pages: [1], model: CODEX })
    await first.result
    expect(await store.readTranslation(DOC, 'ko')).toMatchObject({ provider: 'codex' })
    const second = run([], { kind: 'translate-page', pages: [2], model: CLAUDE })
    await second.result
    const stored = await store.readTranslation(DOC, 'ko')
    expect(stored).toMatchObject({ provider: 'codex', model: 'gpt-x' })
    expect(stored?.blocks.size).toBe(3)
    // the document translation still records who continues it
    const whole = run([], { kind: 'translate', model: CLAUDE, restart: true })
    await whole.result
    expect(await store.readTranslation(DOC, 'ko')).toMatchObject({ provider: 'claude-code' })
  })

  it('a document translation never writes the translate-page record', async () => {
    await run([], { pages: [1] }).result
    expect(existsSync(store.jobPath(DOC, 'translate-page', 'ko'))).toBe(false)
    expect((await store.readJob(DOC, 'translate', 'ko')).state).toBe('complete')
  })

  it('a page translation does not restart', () => {
    expect(() => run([], { kind: 'translate-page', pages: [1], restart: true })).toThrow(TypeError)
  })
})

describe('edited blocks in the translation job', () => {
  it('count as done and are never sent again', async () => {
    const [k1] = keys()
    await store.writeEditedTranslationBlock(DOC, 'ko', k1!, 'by hand')
    const sent: string[] = []
    const summary = await run(sent).result
    expect(summary.skippedItems).toBe(1)
    expect(sent).not.toContain('First one')
    const stored = await store.readTranslation(DOC, 'ko')
    expect(stored?.blocks.get(blockKeyString(k1!))).toMatchObject({
      text: 'by hand',
      edited: true,
    })
  })

  it('a restart keeping edited blocks re-sends only the others; a full restart drops them', async () => {
    const [k1] = keys()
    await run([]).result
    await store.writeEditedTranslationBlock(DOC, 'ko', k1!, 'by hand')

    const parts = translationJobParts(tree(), { lang: 'ko', send: model([]) })
    const estimate = await estimateTranslationJob({
      ...parts,
      docHash: DOC,
      lang: 'ko',
      model: CODEX,
      store,
      restart: true,
      keepEdited: true,
    })
    expect(estimate).toMatchObject({ pending: 2, done: 1, total: 3, providerChange: null })

    const kept: string[] = []
    const summary = await run(kept, { restart: true, keepEdited: true, model: CODEX }).result
    expect(summary.skippedItems).toBe(1)
    expect(kept).toEqual(['Bold <b>part</b>', 'Second page'])
    const stored = await store.readTranslation(DOC, 'ko')
    expect(stored?.blocks.get(blockKeyString(k1!))).toMatchObject({ text: 'by hand', edited: true })
    expect(stored?.provider).toBe('codex')

    const all: string[] = []
    await run(all, { restart: true }).result
    expect(all).toHaveLength(3)
    const after = await store.readTranslation(DOC, 'ko')
    expect(after?.blocks.get(blockKeyString(k1!))?.edited).toBeUndefined()
  })

  it('keeping edited blocks needs a store that can do it', async () => {
    const { deleteTranslationExceptEdited: _drop, ...rest } = {
      readTranslation: store.readTranslation.bind(store),
      writeTranslationMeta: store.writeTranslationMeta.bind(store),
      writeTranslationBlocks: store.writeTranslationBlocks.bind(store),
      deleteTranslation: store.deleteTranslation.bind(store),
      deleteTranslationExceptEdited: store.deleteTranslationExceptEdited.bind(store),
      writeJob: store.writeJob.bind(store),
    }
    await store.writeEditedTranslationBlock(DOC, 'ko', keys()[0]!, 'by hand')
    const parts = translationJobParts(tree(), { lang: 'ko', send: model([]) })
    const handle = startTranslationJob({
      ...parts,
      docHash: DOC,
      lang: 'ko',
      model: CLAUDE,
      store: rest,
      registry: new DocumentJobRegistry(),
      restart: true,
      keepEdited: true,
    })
    await expect(handle.result).rejects.toThrow(TypeError)
    // nothing was deleted
    expect((await store.readTranslation(DOC, 'ko'))?.blocks.size).toBe(1)
  })
})

describe('highlight jobs in the lock and the record', () => {
  it('carry the run id', async () => {
    const registry = new DocumentJobRegistry()
    const RUN = sha256Hex('run')
    const handle = startDocumentJob<number, number>(
      { docHash: DOC, kind: 'highlight', runId: RUN, registry, retryDelayMs: 0 },
      async () => ({
        store,
        units: [1],
        total: 1,
        callModel: async (u) => u,
        persist: async () => {
          expect(registry.running(DOC)).toMatchObject({ kind: 'highlight', runId: RUN })
          let busy: unknown
          try {
            registry.acquire(
              { docHash: DOC, kind: 'ai-read', progress: { done: 0, total: 0 } },
              () => {},
            )
          } catch (e) {
            busy = e
          }
          expect(busy).toBeInstanceOf(DocumentJobBusyError)
          expect((busy as DocumentJobBusyError).running.runId).toBe(RUN)
        },
      }),
    )
    expect(handle.runId).toBe(RUN)
    expect((await handle.result).state).toBe('complete')
    expect(await store.readJob(DOC, 'highlight', RUN)).toMatchObject({
      kind: 'highlight',
      runId: RUN,
      state: 'complete',
    })
  })
})

describe('outputs of edited blocks', () => {
  it('use the edited text, never runs, in the translated and bilingual trees and Markdown', () => {
    const src = tree()
    const [, k2] = keys()
    const stored: StoredTranslation = {
      lang: 'ko',
      provider: 'codex',
      model: '',
      blocks: new Map([
        [
          blockKeyString(k2!),
          {
            key: k2!,
            status: 'translated',
            text: 'Edited plain',
            // stale marks a careless producer left behind lose to the edit
            runs: [{ kind: 'text', text: 'stale', bold: true }],
            edited: true,
            savedAt: 1,
          },
        ],
      ]),
    }
    const translated = buildTranslatedTree(src, 'ko', stored)
    expect(translated.blocks.find((b) => b.id === 'p1.2@ko')).toMatchObject({
      runs: t('Edited plain'),
    })
    const bilingual = buildBilingualTree(src, 'ko', stored)
    expect(bilingual.blocks.find((b) => b.id === 'p1.2@ko')).toMatchObject({
      runs: t('Edited plain'),
    })
    const md = treeToMarkdown(translated).markdown
    expect(md).toContain('Edited plain')
    expect(md).not.toContain('stale')
  })
})
