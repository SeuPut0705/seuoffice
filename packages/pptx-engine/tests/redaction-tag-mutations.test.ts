import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { openPptx, replaceAllInDeck, savePptx, type OpenedPptx } from '../src/index'
import type { SlideElement, TextRun } from '../src/types'
import {
  LABEL,
  mutatedHiddenDeck,
  SECRET,
  SECRET_RUNS,
  STORY_TAGS,
  TAG_MUTATION_NAMES,
  type TagMutation,
} from './helpers/hidden-deck'

/**
 * The hidden-deck fixture (body, table cell, grouped shape, field, notes, modern
 * comment, each with a run hidden from AI) with its tags written another valid
 * way: the engine either reads every hidden run as hidden, or refuses the deck.
 * Saving the deck after an edit elsewhere keeps every hidden run's words and mark.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'pptx-tag-mutations-'))

function runsOf(el: SlideElement): TextRun[] {
  const paragraphs =
    el.type === 'text' || el.type === 'shape'
      ? (el.text?.paragraphs ?? [])
      : el.type === 'table'
        ? el.rows.flatMap((row) => row.flatMap((cell) => cell.text?.paragraphs ?? []))
        : []
  const own = paragraphs.flatMap((p) => p.runs)
  return el.type === 'group' ? el.children.flatMap(runsOf) : own
}

const deckRuns = (opened: OpenedPptx) =>
  opened.deck.slides.flatMap((slide) => slide.elements.flatMap(runsOf))

/** the saved file's slide and notes parts, one string */
async function slideParts(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const parts = Object.keys(zip.files).filter((p) =>
    /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(p),
  )
  return (await Promise.all(parts.map((p) => zip.file(p)!.async('string')))).join('\n')
}

/** Spellings the engine cannot read a deck in at all: it names the main namespace's prefix. */
const BLIND = new Set<string>(['namespace prefix a'])
/** A deck whose presentation part the engine refuses. */
const REFUSED = new Set<string>(['namespace prefix p'])

async function open(mutation: TagMutation): Promise<OpenedPptx | null> {
  const file = await mutatedHiddenDeck(dir(), mutation)
  const bytes = new Uint8Array(readFileSync(file))
  if (REFUSED.has(mutation)) {
    await expect(openPptx(bytes)).rejects.toThrow()
    return null
  }
  return openPptx(bytes)
}

describe.each(TAG_MUTATION_NAMES)('tags rewritten: %s', (mutation) => {
  it('every run holding a hidden word is read as hidden', async () => {
    const opened = await open(mutation)
    if (!opened) return
    const holding = deckRuns(opened).filter((r) => r.text.includes(SECRET))
    if (!BLIND.has(mutation)) expect(holding.length).toBe(SECRET_RUNS)
    for (const run of holding) expect(run.redact, run.text).toBe(LABEL)
  })

  it('a chart whose title and axis title runs are hidden is a hidden element, the plain one is not', async () => {
    const opened = await open(mutation)
    if (!opened || BLIND.has(mutation)) return
    const charts = opened.deck.slides[0]!.elements.filter((el) => el.type === 'chart')
    expect(charts.map((el) => [el.name, el.redact])).toEqual([
      ['Chart', LABEL],
      ['Plain chart', undefined],
    ])
  })

  it('an edit elsewhere is saved, with every hidden run, its words and its mark', async () => {
    const opened = await open(mutation)
    if (!opened || BLIND.has(mutation)) return
    expect(replaceAllInDeck(opened.deck, 'Edit me', 'Edited').count).toBe(1)
    const saved = await savePptx(opened)
    const parts = await slideParts(saved)
    for (const tag of STORY_TAGS.filter((t) => t !== 'C')) {
      expect(parts, `${SECRET}${tag} is kept`).toContain(`${SECRET}${tag}`)
    }
    const again = await openPptx(saved)
    expect(deckRuns(again).some((r) => r.text === 'Edited please')).toBe(true)
    const holding = deckRuns(again).filter((r) => r.text.includes(SECRET))
    expect(holding.length).toBe(SECRET_RUNS)
    for (const run of holding) expect(run.redact, run.text).toBe(LABEL)
  })

  it('a change to the words around a hidden run is saved and keeps the run hidden', async () => {
    const opened = await open(mutation)
    if (!opened || BLIND.has(mutation)) return
    expect(replaceAllInDeck(opened.deck, 'Call ', 'Ring ').count).toBe(1)
    const saved = await savePptx(opened)
    const again = await openPptx(saved)
    expect(deckRuns(again).some((r) => r.text === 'Ring ')).toBe(true)
    const holding = deckRuns(again).filter((r) => r.text.includes(SECRET))
    expect(holding.length).toBe(SECRET_RUNS)
    for (const run of holding) expect(run.redact, run.text).toBe(LABEL)
  })
})
