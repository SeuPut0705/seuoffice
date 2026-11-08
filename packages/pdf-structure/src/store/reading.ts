/**
 * Entries of the reading assistant in the result store (reading-assist spec
 * 5.2): passage cards, AI highlight runs and their blocks, and insights.
 * Types and shape checks only; the store reads and writes them (store.ts).
 * Pure: no Node APIs.
 *
 * Layout under `docs/<docHash>/`:
 *
 *   passages/<id>.json
 *   highlights/<runId>/run.json
 *   highlights/<runId>/blocks/<pageFp>/<textHash>.<occurrence>.json
 *   insights/<lang>.json
 *
 * A file holds the entry plus the store's `format`; a run and an insights
 * entry also hold the time of their last write (`savedAt`), which only the
 * migration reads.
 */
import type { TranslationBlockKey } from './keys'
import { normalizeLabelName } from '../highlight/run-id'

// ── entry types ──

/** an AI explanation or translation of a selected passage, kept beside the page */
export interface PassageCard {
  /** random, unique per document; a path segment */
  id: string
  kind: 'explain' | 'translate'
  /** 1-based original page at creation; found again by pageFingerprint on open */
  page: number
  pageFingerprint: string
  /** PDF user space, the same shape as MarkupInput.quads */
  quads: number[][]
  /** the selected text */
  excerpt: string
  /** hash of the normalized excerpt; the dedup key with pageFingerprint + kind + lang */
  passageHash: string
  /** translate only: target language code */
  lang?: string
  /** the answer */
  text: string
  provider: string
  model: string
  createdAt: number
  /** last write; the newer card wins when a migration meets an existing one */
  savedAt: number
  /** only after a PDF save that contained the note succeeded */
  savedAsNote?: true
}

/** what a caller writes: the store stamps savedAt */
export type PassageCardInput = Omit<PassageCard, 'savedAt'>

export const HIGHLIGHT_PRESET_IDS = ['research', 'contract', 'textbook', 'custom'] as const
export type HighlightPresetId = (typeof HIGHLIGHT_PRESET_IDS)[number]

/** labels per run */
export const HIGHLIGHT_MAX_LABELS = 5

export interface HighlightLabel {
  id: string
  name: string
  /** rgb, each 0-1 */
  color: [number, number, number]
}

/** one AI highlight run: a preset and its labels over the pages the person chose */
export interface HighlightRun {
  /** hash of presetId + the ordered label names; a path segment */
  runId: string
  presetId: HighlightPresetId
  /** 1..HIGHLIGHT_MAX_LABELS */
  labels: HighlightLabel[]
  /** 1-based original pages the person chose; the resume offer reopens the start window with them */
  pages: number[]
  provider: string
  model: string
  createdAt: number
}

export type HighlightSuggestionState = 'pending' | 'accepted' | 'dismissed'

export interface HighlightSuggestion {
  id: string
  labelId: string
  quote: string
  state: HighlightSuggestionState
}

/** the suggestions for one text block; keyed like a translation block */
export interface HighlightBlockEntry {
  key: TranslationBlockKey
  status: 'done' | 'failed'
  suggestions: HighlightSuggestion[]
  savedAt: number
}

/** what a caller writes: the store stamps savedAt */
export type HighlightBlockInput = Omit<HighlightBlockEntry, 'savedAt'>

/** the document overview in one language */
export interface InsightsEntry {
  lang: string
  summary3: [string, string, string]
  summary: string
  terms: { term: string; meaning: string; page: number }[]
  provider: string
  model: string
  createdAt: number
  /** every page whose text was sent */
  pageFingerprints: string[]
}

// ── shape checks ──

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/
const SUGGESTION_STATES: readonly string[] = ['pending', 'accepted', 'dismissed']

export const isSegment = (v: unknown): v is string => typeof v === 'string' && SEGMENT.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isPage = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1
const isUnit = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1

/** a card as written or read, or null when it does not have the shape */
export function asPassageCard(raw: unknown): PassageCard | null {
  if (!isRecord(raw)) return null
  const r = raw
  if (!isSegment(r.id) || (r.kind !== 'explain' && r.kind !== 'translate')) return null
  if (!isPage(r.page) || !isSegment(r.pageFingerprint)) return null
  if (!Array.isArray(r.quads) || !r.quads.every((q) => Array.isArray(q) && q.every(isNum))) {
    return null
  }
  if (!isStr(r.excerpt) || !isStr(r.passageHash) || !isStr(r.text)) return null
  if (!isStr(r.provider) || !isStr(r.model) || !isNum(r.createdAt) || !isNum(r.savedAt)) {
    return null
  }
  if (r.kind === 'translate' ? !isSegment(r.lang) : r.lang !== undefined && !isSegment(r.lang)) {
    return null
  }
  if (r.savedAsNote !== undefined && r.savedAsNote !== true) return null
  const card: PassageCard = {
    id: r.id,
    kind: r.kind,
    page: r.page,
    pageFingerprint: r.pageFingerprint,
    quads: (r.quads as number[][]).map((q) => [...q]),
    excerpt: r.excerpt,
    passageHash: r.passageHash,
    text: r.text,
    provider: r.provider,
    model: r.model,
    createdAt: r.createdAt,
    savedAt: r.savedAt,
  }
  if (isStr(r.lang)) card.lang = r.lang
  if (r.savedAsNote === true) card.savedAsNote = true
  return card
}

/** a run as written or read, or null when it does not have the shape */
export function asHighlightRun(raw: unknown): HighlightRun | null {
  if (!isRecord(raw)) return null
  const r = raw
  if (!isSegment(r.runId)) return null
  if (!(HIGHLIGHT_PRESET_IDS as readonly unknown[]).includes(r.presetId)) return null
  if (!Array.isArray(r.labels) || r.labels.length < 1 || r.labels.length > HIGHLIGHT_MAX_LABELS) {
    return null
  }
  const labels: HighlightLabel[] = []
  const names = new Set<string>()
  for (const l of r.labels as unknown[]) {
    if (!isRecord(l) || !isStr(l.id) || l.id === '' || !isStr(l.name)) return null
    if (!Array.isArray(l.color) || l.color.length !== 3 || !l.color.every(isUnit)) return null
    // a name counts as the run id counts it; an empty or repeated one is no category
    const name = normalizeLabelName(l.name)
    if (name === '' || names.has(name)) return null
    names.add(name)
    labels.push({ id: l.id, name: l.name, color: [l.color[0], l.color[1], l.color[2]] })
  }
  if (!Array.isArray(r.pages) || !r.pages.every(isPage)) return null
  if (!isStr(r.provider) || !isStr(r.model) || !isNum(r.createdAt)) return null
  return {
    runId: r.runId,
    presetId: r.presetId as HighlightPresetId,
    labels,
    pages: [...(r.pages as number[])],
    provider: r.provider,
    model: r.model,
    createdAt: r.createdAt,
  }
}

const sameKey = (k: unknown, expect: TranslationBlockKey): boolean =>
  isRecord(k) &&
  k.pageFingerprint === expect.pageFingerprint &&
  k.textHash === expect.textHash &&
  k.occurrence === expect.occurrence

/** a highlight block stored under `expect`, or null when it does not have the shape */
export function asHighlightBlock(
  raw: unknown,
  expect: TranslationBlockKey,
): HighlightBlockEntry | null {
  if (!isRecord(raw) || !sameKey(raw.key, expect) || !isNum(raw.savedAt)) return null
  if (raw.status !== 'done' && raw.status !== 'failed') return null
  if (!Array.isArray(raw.suggestions)) return null
  const suggestions: HighlightSuggestion[] = []
  for (const s of raw.suggestions as unknown[]) {
    if (!isRecord(s) || !isStr(s.id) || !isStr(s.labelId) || !isStr(s.quote)) return null
    if (!SUGGESTION_STATES.includes(s.state as string)) return null
    suggestions.push({
      id: s.id,
      labelId: s.labelId,
      quote: s.quote,
      state: s.state as HighlightSuggestionState,
    })
  }
  return { key: { ...expect }, status: raw.status, suggestions, savedAt: raw.savedAt }
}

/** an insights entry as written or read, or null when it does not have the shape */
export function asInsights(raw: unknown): InsightsEntry | null {
  if (!isRecord(raw)) return null
  const r = raw
  if (!isSegment(r.lang) || !isStr(r.summary)) return null
  if (!Array.isArray(r.summary3) || r.summary3.length !== 3 || !r.summary3.every(isStr)) {
    return null
  }
  if (!Array.isArray(r.terms)) return null
  const terms: InsightsEntry['terms'] = []
  for (const term of r.terms as unknown[]) {
    if (!isRecord(term) || !isStr(term.term) || !isStr(term.meaning) || !isPage(term.page)) {
      return null
    }
    terms.push({ term: term.term, meaning: term.meaning, page: term.page })
  }
  if (!isStr(r.provider) || !isStr(r.model) || !isNum(r.createdAt)) return null
  if (!Array.isArray(r.pageFingerprints) || !r.pageFingerprints.every(isSegment)) return null
  const [a, b, c] = r.summary3 as string[]
  return {
    lang: r.lang,
    summary3: [a!, b!, c!],
    summary: r.summary,
    terms,
    provider: r.provider,
    model: r.model,
    createdAt: r.createdAt,
    pageFingerprints: [...(r.pageFingerprints as string[])],
  }
}
