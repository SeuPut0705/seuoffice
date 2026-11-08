/**
 * Result store entries of the reading assistant (spec 5.2-5.5): passage
 * cards, AI highlight runs and blocks, insights, edited translation blocks,
 * the five job kinds and their second key, migration of the new folders,
 * the counts of the delete confirmation and the note links.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JOB_FILE,
  JOB_KINDS,
  ResultStore,
  blockKeyString,
  jobKeyOf,
  noteLinkKey,
  translationBlockKeys,
  type HighlightRun,
  type InsightsEntry,
  type PassageCardInput,
  type TranslationBlockKey,
} from '../src/store'
import { sha256Hex } from '../src/tree'
import type { InlineRun, TextUnit } from '../src/tree'

const t = (text: string): InlineRun[] => [{ kind: 'text', text }]
const fp = (n: number) => sha256Hex(`page-${n}`)
const DOC_A = sha256Hex('doc-a')
const DOC_B = sha256Hex('doc-b')
const RUN = sha256Hex('research|claim|method')
const RUN2 = sha256Hex('contract|duty')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-store-reading-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function unit(key: string, pageFp: string, text: string): TextUnit {
  return { key, runs: t(text), blockId: key, page: 1, pageFingerprint: pageFp }
}

function card(id: string, pageN: number, extra: Partial<PassageCardInput> = {}): PassageCardInput {
  return {
    id,
    kind: 'explain',
    page: pageN,
    pageFingerprint: fp(pageN),
    quads: [[1, 2, 3, 4, 5, 6, 7, 8]],
    excerpt: `excerpt ${id}`,
    passageHash: sha256Hex(`excerpt ${id}`),
    text: `answer ${id}`,
    provider: 'claude-code',
    model: 'opus',
    createdAt: 10,
    ...extra,
  }
}

const RUN_ENTRY: HighlightRun = {
  runId: RUN,
  presetId: 'research',
  labels: [
    { id: 'l1', name: 'claim', color: [1, 0.9, 0.2] },
    { id: 'l2', name: 'method', color: [0.4, 0.8, 1] },
  ],
  pages: [1, 2, 3],
  provider: 'codex',
  model: 'gpt-x',
  createdAt: 5,
}

function insights(lang: string, pages: number[]): InsightsEntry {
  return {
    lang,
    summary3: ['one', 'two', 'three'],
    summary: 'a summary',
    terms: [{ term: 'term', meaning: 'meaning', page: 1 }],
    provider: 'claude-code',
    model: 'opus',
    createdAt: 7,
    pageFingerprints: pages.map(fp),
  }
}

const keyOn = (pageN: number, text: string): TranslationBlockKey =>
  translationBlockKeys([unit('a', fp(pageN), text)])[0]!

// ── passage cards ──

describe('passage cards', () => {
  it('round-trip with savedAt stamped by the store; delete removes one card', async () => {
    const store = new ResultStore(root, { now: () => 123 })
    await store.writePassage(DOC_A, card('c1', 1))
    await store.writePassage(
      DOC_A,
      card('c2', 2, { kind: 'translate', lang: 'ko', savedAsNote: true }),
    )
    expect(await store.readPassage(DOC_A, 'c1')).toEqual({ ...card('c1', 1), savedAt: 123 })
    const all = await store.readPassages(DOC_A)
    expect(all.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(all.find((c) => c.id === 'c2')).toMatchObject({
      kind: 'translate',
      lang: 'ko',
      savedAsNote: true,
    })
    expect(existsSync(join(store.documentDir(DOC_A), 'passages', 'c1.json'))).toBe(true)

    await store.deletePassage(DOC_A, 'c1')
    expect(await store.readPassage(DOC_A, 'c1')).toBeNull()
    expect((await store.readPassages(DOC_A)).map((c) => c.id)).toEqual(['c2'])
    // deleting a missing card is not an error
    await store.deletePassage(DOC_A, 'nope')
  })

  it('a corrupt or wrong-shaped card reads as absent; invalid input is refused', async () => {
    const store = new ResultStore(root)
    await store.writePassage(DOC_A, card('c1', 1))
    const dir = join(store.documentDir(DOC_A), 'passages')
    writeFileSync(join(dir, 'bad.json'), '{"format":1,')
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ format: 1, id: 'odd', kind: 'x' }))
    expect((await store.readPassages(DOC_A)).map((c) => c.id)).toEqual(['c1'])
    expect(await store.readPassage(DOC_A, 'bad')).toBeNull()
    await expect(
      store.writePassage(DOC_A, { ...card('c3', 1), kind: 'x' as never }),
    ).rejects.toThrow(TypeError)
    await expect(store.writePassage(DOC_A, card('../x', 1))).rejects.toThrow(TypeError)
    expect(await store.readPassages('not a hash')).toEqual([])
  })
})

// ── AI highlights ──

describe('highlight runs and blocks', () => {
  it('round-trip the run and its blocks under the translation block key shape', async () => {
    const store = new ResultStore(root, { now: () => 50 })
    await store.writeHighlightRun(DOC_A, RUN_ENTRY)
    expect(await store.readHighlightRun(DOC_A, RUN)).toEqual(RUN_ENTRY)
    expect((await store.listHighlightRuns(DOC_A)).map((r) => r.runId)).toEqual([RUN])

    const k1 = keyOn(1, 'One')
    const k2 = keyOn(2, 'Two')
    await store.writeHighlightBlocks(DOC_A, RUN, [
      {
        key: k1,
        status: 'done',
        suggestions: [{ id: 's1', labelId: 'l1', quote: 'One', state: 'pending' }],
      },
      { key: k2, status: 'failed', suggestions: [] },
    ])
    expect(
      existsSync(
        join(
          store.documentDir(DOC_A),
          'highlights',
          RUN,
          'blocks',
          k1.pageFingerprint,
          `${k1.textHash}.0.json`,
        ),
      ),
    ).toBe(true)
    const blocks = await store.readHighlightBlocks(DOC_A, RUN)
    expect(blocks.size).toBe(2)
    expect(blocks.get(blockKeyString(k1))).toEqual({
      key: k1,
      status: 'done',
      suggestions: [{ id: 's1', labelId: 'l1', quote: 'One', state: 'pending' }],
      savedAt: 50,
    })
    expect(await store.readHighlightBlock(DOC_A, RUN, k2)).toMatchObject({ status: 'failed' })
  })

  it('updates suggestion states in place', async () => {
    const store = new ResultStore(root)
    const k1 = keyOn(1, 'One')
    await store.writeHighlightBlock(DOC_A, RUN, {
      key: k1,
      status: 'done',
      suggestions: [
        { id: 's1', labelId: 'l1', quote: 'One', state: 'pending' },
        { id: 's2', labelId: 'l2', quote: 'Two', state: 'pending' },
      ],
    })
    expect(
      await store.setHighlightSuggestionStates(DOC_A, RUN, k1, { s2: 'dismissed', zz: 'accepted' }),
    ).toBe(true)
    const block = await store.readHighlightBlock(DOC_A, RUN, k1)
    expect(block?.suggestions.map((s) => s.state)).toEqual(['pending', 'dismissed'])
    expect(
      await store.setHighlightSuggestionStates(DOC_A, RUN, keyOn(9, 'none'), { s1: 'accepted' }),
    ).toBe(false)
  })

  it('concurrent state changes of one block all land (no lost update)', async () => {
    const store = new ResultStore(root)
    const k1 = keyOn(1, 'One')
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`)
    await store.writeHighlightBlock(DOC_A, RUN, {
      key: k1,
      status: 'done',
      suggestions: ids.map((id) => ({ id, labelId: 'l1', quote: id, state: 'pending' as const })),
    })
    await Promise.all(
      ids.map((id, i) =>
        store.setHighlightSuggestionStates(DOC_A, RUN, k1, {
          [id]: i % 2 === 0 ? 'accepted' : 'dismissed',
        }),
      ),
    )
    const block = await store.readHighlightBlock(DOC_A, RUN, k1)
    expect(block?.suggestions.map((s) => s.state)).toEqual(
      ids.map((_, i) => (i % 2 === 0 ? 'accepted' : 'dismissed')),
    )
  })

  it('refuses a run whose label names are empty or the same after normalizing', async () => {
    const store = new ResultStore(root)
    const named = (a: string, b: string) => ({
      ...RUN_ENTRY,
      labels: [
        { id: 'l1', name: a, color: [1, 0.9, 0.2] as [number, number, number] },
        { id: 'l2', name: b, color: [0.4, 0.8, 1] as [number, number, number] },
      ],
    })
    await expect(store.writeHighlightRun(DOC_A, named('claim', '  '))).rejects.toThrow(TypeError)
    await expect(store.writeHighlightRun(DOC_A, named('claim', ' claim '))).rejects.toThrow(
      TypeError,
    )
    await expect(store.writeHighlightRun(DOC_A, named('a  b', 'a b'))).rejects.toThrow(TypeError)
    // a stored run with such labels reads as absent
    const dir = join(store.documentDir(DOC_A), 'highlights', RUN2)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ format: 1, ...named('x', 'x'), runId: RUN2, savedAt: 1 }),
    )
    expect(await store.readHighlightRun(DOC_A, RUN2)).toBeNull()
  })

  it('refuses a run with too many labels or a bad preset; unreadable runs are absent', async () => {
    const store = new ResultStore(root)
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `l${i}`,
      name: `n${i}`,
      color: [0, 0, 0] as [number, number, number],
    }))
    await expect(store.writeHighlightRun(DOC_A, { ...RUN_ENTRY, labels: six })).rejects.toThrow(
      TypeError,
    )
    await expect(
      store.writeHighlightRun(DOC_A, { ...RUN_ENTRY, presetId: 'other' as never }),
    ).rejects.toThrow(TypeError)
    const dir = join(store.documentDir(DOC_A), 'highlights', RUN2)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run.json'), 'not json')
    expect(await store.readHighlightRun(DOC_A, RUN2)).toBeNull()
    expect(await store.listHighlightRuns(DOC_A)).toEqual([])
  })

  it('deleting a run removes its folder and its job record, nothing else', async () => {
    const store = new ResultStore(root)
    await store.writeHighlightRun(DOC_A, RUN_ENTRY)
    await store.writeHighlightRun(DOC_A, { ...RUN_ENTRY, runId: RUN2, presetId: 'contract' })
    await store.writeHighlightBlock(DOC_A, RUN, {
      key: keyOn(1, 'One'),
      status: 'done',
      suggestions: [],
    })
    await store.writeJob(DOC_A, { kind: 'highlight', runId: RUN, state: 'stopped' })
    await store.writeJob(DOC_A, { kind: 'highlight', runId: RUN2, state: 'stopped' })
    await store.writeJob(DOC_A, { kind: 'translate', lang: 'en', state: 'stopped' })

    await store.deleteHighlightRun(DOC_A, RUN)
    expect(existsSync(store.highlightRunDir(DOC_A, RUN))).toBe(false)
    expect(existsSync(store.jobPath(DOC_A, 'highlight', RUN))).toBe(false)
    expect((await store.listHighlightRuns(DOC_A)).map((r) => r.runId)).toEqual([RUN2])
    expect(
      (await store.listJobs(DOC_A)).map((j) => `${j.kind}:${jobKeyOf(j) ?? ''}`).sort(),
    ).toEqual([`highlight:${RUN2}`, 'translate:en'])
  })
})

// ── insights ──

describe('insights', () => {
  it('round-trip one entry per language; delete removes it', async () => {
    const store = new ResultStore(root)
    await store.writeInsights(DOC_A, insights('ko', [1, 2]))
    await store.writeInsights(DOC_A, insights('en', [1]))
    expect(await store.readInsights(DOC_A, 'ko')).toEqual(insights('ko', [1, 2]))
    expect((await store.listInsights(DOC_A)).sort()).toEqual(['en', 'ko'])
    await store.deleteInsights(DOC_A, 'en')
    expect(await store.readInsights(DOC_A, 'en')).toBeNull()
    await expect(
      store.writeInsights(DOC_A, { ...insights('ko', [1]), summary3: ['a', 'b'] as never }),
    ).rejects.toThrow(TypeError)
  })
})

// ── edited translation blocks ──

describe('edited translation blocks', () => {
  it('keep edited through write and read; the edited write drops runs', async () => {
    const store = new ResultStore(root)
    const k1 = keyOn(1, 'One')
    const k2 = keyOn(2, 'Two')
    await store.writeTranslationBlock(DOC_A, 'ko', {
      key: k1,
      status: 'translated',
      text: 'machine',
      runs: t('machine'),
    })
    await store.writeEditedTranslationBlock(DOC_A, 'ko', k1, 'by hand')
    await store.writeTranslationBlock(DOC_A, 'ko', {
      key: k2,
      status: 'translated',
      text: 'also by hand',
      edited: true,
    })
    const ko = await store.readTranslation(DOC_A, 'ko')
    expect(ko?.blocks.get(blockKeyString(k1))).toMatchObject({
      status: 'translated',
      text: 'by hand',
      edited: true,
    })
    expect(ko?.blocks.get(blockKeyString(k1))?.runs).toBeUndefined()
    expect(ko?.blocks.get(blockKeyString(k2))?.edited).toBe(true)

    // an edited block is translated text without marks
    await expect(
      store.writeTranslationBlock(DOC_A, 'ko', {
        key: k2,
        status: 'failed',
        reason: 'x',
        edited: true,
      }),
    ).rejects.toThrow(TypeError)
    await expect(
      store.writeTranslationBlock(DOC_A, 'ko', {
        key: k2,
        status: 'translated',
        text: 'x',
        runs: t('x'),
        edited: true,
      }),
    ).rejects.toThrow(TypeError)
  })

  it('an edited block must have text', async () => {
    const store = new ResultStore(root)
    const k1 = keyOn(1, 'One')
    await expect(store.writeEditedTranslationBlock(DOC_A, 'ko', k1, '')).rejects.toThrow(TypeError)
    await expect(store.writeEditedTranslationBlock(DOC_A, 'ko', k1, ' \n ')).rejects.toThrow(
      TypeError,
    )
    expect(await store.readTranslation(DOC_A, 'ko')).toBeNull()
  })

  it('survive migration', async () => {
    let clock = 1
    const store = new ResultStore(root, { now: () => clock })
    const k1 = keyOn(1, 'One')
    await store.writeTranslationMeta(DOC_A, 'ko', { provider: 'codex', model: '' })
    await store.writeEditedTranslationBlock(DOC_A, 'ko', k1, 'by hand')
    clock = 2
    await store.migrateDocument({ oldDocHash: DOC_A, newDocHash: DOC_B, pageFingerprints: [fp(1)] })
    const moved = await store.readTranslation(DOC_B, 'ko')
    expect(moved?.blocks.get(blockKeyString(k1))).toMatchObject({ text: 'by hand', edited: true })
  })

  it('a restart that keeps edited blocks removes only the others', async () => {
    const store = new ResultStore(root)
    const k1 = keyOn(1, 'One')
    const k2 = keyOn(2, 'Two')
    const k3 = keyOn(3, 'Three')
    await store.writeTranslationMeta(DOC_A, 'ko', { provider: 'codex', model: '' })
    await store.writeEditedTranslationBlock(DOC_A, 'ko', k1, 'by hand')
    await store.writeTranslationBlock(DOC_A, 'ko', { key: k2, status: 'translated', text: 'm' })
    await store.writeTranslationBlock(DOC_A, 'ko', { key: k3, status: 'failed', reason: 'x' })
    expect(await store.deleteTranslationExceptEdited(DOC_A, 'ko')).toBe(2)
    const ko = await store.readTranslation(DOC_A, 'ko')
    expect([...ko!.blocks.keys()]).toEqual([blockKeyString(k1)])
    expect(ko?.provider).toBe('codex')
  })

  it('a restart keeping edited blocks never removes an edit written while it runs', async () => {
    const store = new ResultStore(root)
    const keys = Array.from({ length: 12 }, (_, i) => keyOn(i + 1, `Block ${i}`))
    await store.writeTranslationMeta(DOC_A, 'ko', { provider: 'codex', model: '' })
    for (const key of keys) {
      await store.writeTranslationBlock(DOC_A, 'ko', { key, status: 'translated', text: 'm' })
    }
    await Promise.all([
      store.deleteTranslationExceptEdited(DOC_A, 'ko'),
      ...keys.map((key, i) => store.writeEditedTranslationBlock(DOC_A, 'ko', key, `hand ${i}`)),
    ])
    const ko = await store.readTranslation(DOC_A, 'ko')
    expect(ko?.blocks.size).toBe(keys.length)
    expect([...ko!.blocks.values()].every((b) => b.edited)).toBe(true)
  })

  it('are counted over every language for the delete confirmation', async () => {
    const store = new ResultStore(root)
    await store.writeEditedTranslationBlock(DOC_A, 'ko', keyOn(1, 'One'), 'a')
    await store.writeEditedTranslationBlock(DOC_A, 'ko', keyOn(2, 'Two'), 'b')
    await store.writeEditedTranslationBlock(DOC_A, 'en', keyOn(1, 'One'), 'c')
    await store.writeTranslationBlock(DOC_A, 'en', {
      key: keyOn(2, 'Two'),
      status: 'translated',
      text: 'm',
    })
    await store.writePassage(DOC_A, card('c1', 1))
    await store.writePassage(DOC_A, card('c2', 1))
    expect(await store.countEditedTranslationBlocks(DOC_A)).toBe(3)
    expect(await store.countEditedTranslationBlocks(DOC_A, 'en')).toBe(1)
    expect(await store.countPassages(DOC_A)).toBe(2)
    expect(await store.countEditedTranslationBlocks(DOC_B)).toBe(0)
    expect(await store.countPassages(DOC_B)).toBe(0)
  })
})

// ── job kinds ──

describe('job kinds', () => {
  it('are exactly the five, each with its file name', () => {
    const store = new ResultStore(root)
    expect([...JOB_KINDS]).toEqual([
      'ai-read',
      'translate',
      'translate-page',
      'highlight',
      'summary',
    ])
    const name = (p: string) => p.split(/[\\/]/).at(-1)
    expect(name(store.jobPath(DOC_A, 'ai-read'))).toBe('ai-read.json')
    expect(name(store.jobPath(DOC_A, 'translate', 'ko'))).toBe('translate.ko.json')
    expect(name(store.jobPath(DOC_A, 'translate-page', 'ko'))).toBe('translate-page.ko.json')
    expect(name(store.jobPath(DOC_A, 'highlight', RUN))).toBe(`highlight.${RUN}.json`)
    expect(name(store.jobPath(DOC_A, 'summary', 'en'))).toBe('summary.en.json')
    for (const n of [
      'ai-read.json',
      'translate.ko.json',
      'translate-page.ko.json',
      `highlight.${RUN}.json`,
      'summary.en.json',
    ]) {
      expect(JOB_FILE.test(n)).toBe(true)
    }
    expect(JOB_FILE.test('translate.json')).toBe(false)
    expect(JOB_FILE.test('other.ko.json')).toBe(false)
  })

  it('write, read, heartbeat and list every kind under its second key', async () => {
    let clock = 1_000
    const store = new ResultStore(root, { now: () => clock })
    await store.writeJob(DOC_A, { kind: 'ai-read', state: 'complete' })
    await store.writeJob(DOC_A, { kind: 'translate', lang: 'ko', state: 'stopped' })
    await store.writeJob(DOC_A, {
      kind: 'translate-page',
      lang: 'ko',
      state: 'running',
      progress: { done: 1, total: 2 },
    })
    await store.writeJob(DOC_A, { kind: 'highlight', runId: RUN, state: 'running' })
    await store.writeJob(DOC_A, { kind: 'summary', lang: 'en', state: 'running' })

    const page = await store.readJob(DOC_A, 'translate-page', 'ko')
    expect(page).toMatchObject({ kind: 'translate-page', lang: 'ko', state: 'running' })
    expect(page.runId).toBeUndefined()
    const hl = await store.readJob(DOC_A, 'highlight', RUN)
    expect(hl).toMatchObject({ kind: 'highlight', runId: RUN, state: 'running' })
    expect(hl.lang).toBeUndefined()
    expect(await store.readJob(DOC_A, 'highlight', RUN2)).toEqual({
      kind: 'highlight',
      runId: RUN2,
      state: 'idle',
      outputs: [],
    })
    expect(await store.readJob(DOC_A, 'summary', 'ko')).toMatchObject({
      kind: 'summary',
      lang: 'ko',
      state: 'idle',
    })
    // the translate record is untouched by the page translation
    expect((await store.readJob(DOC_A, 'translate', 'ko')).state).toBe('stopped')

    const listed = (await store.listJobs(DOC_A)).map(
      (j) => `${j.kind}:${jobKeyOf(j) ?? ''}:${j.state}`,
    )
    expect(listed.sort()).toEqual(
      [
        'ai-read::complete',
        'translate:ko:stopped',
        'translate-page:ko:running',
        `highlight:${RUN}:running`,
        'summary:en:running',
      ].sort(),
    )

    clock += 60_000
    expect(await store.heartbeatJob(DOC_A, 'highlight', RUN)).toBe(true)
    expect((await store.readJob(DOC_A, 'highlight', RUN)).state).toBe('running')
    expect((await store.readJob(DOC_A, 'summary', 'en')).state).toBe('stopped')
    expect(await store.heartbeatJob(DOC_A, 'highlight', RUN2)).toBe(false)
  })

  it('needs the right second key per kind', async () => {
    const store = new ResultStore(root)
    await expect(
      store.writeJob(DOC_A, { kind: 'translate-page', state: 'running' }),
    ).rejects.toThrow(TypeError)
    await expect(store.writeJob(DOC_A, { kind: 'summary', state: 'running' })).rejects.toThrow(
      TypeError,
    )
    await expect(
      store.writeJob(DOC_A, { kind: 'highlight', lang: 'ko', state: 'running' }),
    ).rejects.toThrow(TypeError)
    await expect(
      store.writeJob(DOC_A, { kind: 'other' as never, state: 'running' }),
    ).rejects.toThrow(TypeError)
  })

  it('a record under another file name or key reads as absent', async () => {
    const store = new ResultStore(root)
    await store.writeJob(DOC_A, { kind: 'highlight', runId: RUN, state: 'stopped' })
    const dir = join(store.documentDir(DOC_A), 'jobs')
    // a highlight record copied under another run id
    writeFileSync(
      join(dir, `highlight.${RUN2}.json`),
      JSON.stringify({
        format: 1,
        kind: 'highlight',
        runId: RUN,
        state: 'stopped',
        outputs: [],
        updatedAt: 1,
      }),
    )
    expect((await store.readJob(DOC_A, 'highlight', RUN2)).state).toBe('idle')
    expect((await store.listJobs(DOC_A)).length).toBe(1)
  })

  it('jobKeyOf gives the language, the run id or nothing', () => {
    expect(jobKeyOf({ kind: 'translate', lang: 'ko' })).toBe('ko')
    expect(jobKeyOf({ kind: 'summary', lang: 'en' })).toBe('en')
    expect(jobKeyOf({ kind: 'highlight', runId: RUN })).toBe(RUN)
    expect(jobKeyOf({ kind: 'ai-read' })).toBeUndefined()
  })
})

// ── migration of the new folders ──

describe('migration of reading results', () => {
  it('moves cards, highlight runs and blocks of surviving pages, and complete insights', async () => {
    let clock = 100
    const store = new ResultStore(root, { now: () => clock })
    await store.writePassage(DOC_A, card('keep', 1))
    await store.writePassage(DOC_A, card('lost', 2))
    await store.writeHighlightRun(DOC_A, RUN_ENTRY)
    const k1 = keyOn(1, 'One')
    const k2 = keyOn(2, 'Two')
    await store.writeHighlightBlock(DOC_A, RUN, { key: k1, status: 'done', suggestions: [] })
    await store.writeHighlightBlock(DOC_A, RUN, { key: k2, status: 'done', suggestions: [] })
    await store.writeInsights(DOC_A, insights('ko', [1, 3]))
    await store.writeInsights(DOC_A, insights('en', [1, 2]))
    await store.writeJob(DOC_A, { kind: 'highlight', runId: RUN, state: 'stopped' })

    clock = 200
    const result = await store.migrateDocument({
      oldDocHash: DOC_A,
      newDocHash: DOC_B,
      pageFingerprints: [fp(3), fp(1)],
    })
    expect(result).toMatchObject({ passages: 1, highlightBlocks: 1, insights: 1 })
    expect((await store.readPassages(DOC_B)).map((c) => c.id)).toEqual(['keep'])
    expect(await store.readHighlightRun(DOC_B, RUN)).toEqual(RUN_ENTRY)
    expect([...(await store.readHighlightBlocks(DOC_B, RUN)).keys()]).toEqual([blockKeyString(k1)])
    expect(await store.readInsights(DOC_B, 'ko')).toEqual(insights('ko', [1, 3]))
    expect(await store.readInsights(DOC_B, 'en')).toBeNull()
    // job records are the shell's job; old entries stay
    expect(await store.listJobs(DOC_B)).toEqual([])
    expect((await store.readPassages(DOC_A)).length).toBe(2)
  })

  it('a newer card in the new document wins; an older one is replaced', async () => {
    let clock = 100
    const store = new ResultStore(root, { now: () => clock })
    await store.writePassage(DOC_B, card('c1', 1, { text: 'older in new' }))
    clock = 200
    await store.writePassage(DOC_A, card('c1', 1, { text: 'newer in old' }))
    await store.writePassage(DOC_A, card('c2', 1, { text: 'older in old' }))
    clock = 300
    await store.writePassage(DOC_B, card('c2', 1, { text: 'newer in new' }))
    await store.migrateDocument({ oldDocHash: DOC_A, newDocHash: DOC_B, pageFingerprints: [fp(1)] })
    expect((await store.readPassage(DOC_B, 'c1'))?.text).toBe('newer in old')
    expect((await store.readPassage(DOC_B, 'c2'))?.text).toBe('newer in new')
  })

  it('reports nothing extra when there is nothing to move', async () => {
    const store = new ResultStore(root)
    const result = await store.migrateDocument({
      oldDocHash: DOC_A,
      newDocHash: DOC_B,
      pageFingerprints: [fp(1)],
    })
    expect(result).toEqual({ aiReadPages: 0, translationBlocks: 0, languages: [] })
  })
})

// ── deleting the document ──

describe('deleting a document', () => {
  it('removes cards, highlights and insights with it, and keeps the note links', async () => {
    const store = new ResultStore(root)
    const note = join(root, 'note.md')
    writeFileSync(note, '# note')
    await store.writePassage(DOC_A, card('c1', 1))
    await store.writeHighlightRun(DOC_A, RUN_ENTRY)
    await store.writeInsights(DOC_A, insights('ko', [1]))
    await store.setNoteLink(join(root, 'a.pdf'), { notePath: note, docHash: DOC_A })
    await store.deleteDocument(DOC_A)
    expect(existsSync(store.documentDir(DOC_A))).toBe(false)
    expect(await store.findNoteLink(join(root, 'a.pdf'), DOC_A)).toMatchObject({ notePath: note })
    expect(readdirSync(store.dir)).toContain('note-links.json')
  })
})

// ── note links ──

describe('note links', () => {
  it('keys a PDF by its resolved path, lower-cased on Windows', () => {
    expect(noteLinkKey('C:\\Docs\\A.pdf', 'win32')).toBe(resolve('C:\\Docs\\A.pdf').toLowerCase())
    expect(noteLinkKey('/tmp/A.pdf', 'linux')).toBe(resolve('/tmp/A.pdf'))
  })

  it('finds by path first, then the most recent link of the same document hash', async () => {
    let clock = 1
    const store = new ResultStore(root, { now: () => clock })
    const n1 = join(root, 'one.md')
    const n2 = join(root, 'two.md')
    const n3 = join(root, 'three.md')
    for (const n of [n1, n2, n3]) writeFileSync(n, '')
    const pdfA = join(root, 'a.pdf')
    const pdfB = join(root, 'b.pdf')
    const pdfC = join(root, 'c.pdf')
    await store.setNoteLink(pdfA, { notePath: n1, docHash: DOC_A })
    clock = 2
    await store.setNoteLink(pdfB, { notePath: n2, docHash: DOC_B })
    clock = 3
    await store.setNoteLink(pdfC, { notePath: n3, docHash: DOC_B })

    expect(await store.findNoteLink(pdfA, DOC_B)).toMatchObject({
      notePath: n1,
      docHash: DOC_A,
      matchedBy: 'path',
    })
    // a copy of b.pdf elsewhere: the most recent link with its hash
    expect(await store.findNoteLink(join(root, 'copy.pdf'), DOC_B)).toMatchObject({
      notePath: n3,
      matchedBy: 'docHash',
    })
    expect(await store.findNoteLink(join(root, 'copy.pdf'), sha256Hex('x'))).toBeNull()

    // a note file that is gone counts as no link
    rmSync(n3)
    expect(await store.findNoteLink(join(root, 'copy.pdf'), DOC_B)).toMatchObject({
      notePath: n2,
    })
    rmSync(n1)
    expect(await store.findNoteLink(pdfA, DOC_A)).toBeNull()
  })

  it('updates the document hash of a path after a save', async () => {
    let clock = 1
    const store = new ResultStore(root, { now: () => clock })
    const note = join(root, 'n.md')
    writeFileSync(note, '')
    const pdf = join(root, 'a.pdf')
    await store.setNoteLink(pdf, { notePath: note, docHash: DOC_A })
    clock = 5
    expect(await store.updateNoteLinkDocHash(pdf, DOC_B)).toBe(true)
    const links = await store.readNoteLinks()
    expect(links.version).toBe(1)
    expect(links.links[noteLinkKey(pdf)]).toEqual({ notePath: note, docHash: DOC_B, updatedAt: 5 })
    expect(await store.updateNoteLinkDocHash(join(root, 'other.pdf'), DOC_B)).toBe(false)
    expect(await store.findNoteLink(join(root, 'copy.pdf'), DOC_B)).toMatchObject({
      notePath: note,
    })
  })

  it('reads an unreadable file as no links and refuses a relative note path', async () => {
    const store = new ResultStore(root)
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(join(store.dir, 'note-links.json'), '{oops')
    expect(await store.readNoteLinks()).toEqual({ version: 1, links: {} })
    await expect(
      store.setNoteLink(join(root, 'a.pdf'), { notePath: 'rel.md', docHash: DOC_A }),
    ).rejects.toThrow(TypeError)
  })

  it('serializes concurrent updates in one process', async () => {
    const store = new ResultStore(root)
    const note = join(root, 'n.md')
    writeFileSync(note, '')
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.setNoteLink(join(root, `p${i}.pdf`), { notePath: note, docHash: DOC_A }),
      ),
    )
    expect(Object.keys((await store.readNoteLinks()).links)).toHaveLength(8)
  })
})
