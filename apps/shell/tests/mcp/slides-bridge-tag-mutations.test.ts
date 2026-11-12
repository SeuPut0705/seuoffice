/**
 * The slides bridge's readout for agent sessions, over a real parsed deck: the
 * hidden-deck fixture (body, table cell, grouped shape, field, each with a run
 * hidden from AI) with its tags written another valid way. A withholding
 * readout gives the placeholder for every hidden run, whatever the tags looked
 * like, and a deck the editor refuses is read as nothing.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openPptx } from '@seuoffice/pptx-engine'
import {
  mutatedHiddenDeck,
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
  type TagMutation,
} from '../../../../packages/pptx-engine/tests/helpers/hidden-deck'

const sessions = new Map<number, unknown>()

vi.mock('electron', () => ({ webContents: { fromId: () => null } }))
vi.mock('../../../slides/src/main/slides-main', () => ({
  applySessionTxn: vi.fn(),
  saveSessionDeckTo: vi.fn(),
}))
vi.mock('../../../slides/src/main/session-state', () => ({
  sessions,
  attachedIds: () => [],
}))

const { createSlidesControl } = await import('../../src/main/mcp/slides-bridge')
const control = createSlidesControl({ openBlankTab: () => 1 })

interface ReadElement {
  text?: string
  children?: ReadElement[]
}

const VARIANTS: TagMutation[] = ['none', ...TAG_MUTATION_NAMES]

describe.each(VARIANTS)('slide tags rewritten: %s', (mutation) => {
  it('a withholding readout hands over no hidden word', async () => {
    const file = await mutatedHiddenDeck(
      mkdtempSync(join(tmpdir(), 'bridge-tag-mutations-')),
      mutation,
    )
    // an editor that refuses the deck has no session to read
    const opened = await openPptx(new Uint8Array(readFileSync(file))).catch(() => null)
    if (!opened) {
      expect(mutation).not.toBe('none')
      return
    }
    sessions.set(1, { opened })
    const readout = await control.readDeck(1, { withhold: true })
    expect(JSON.stringify(readout)).not.toContain(SECRET)

    const walk = (els: ReadElement[]): string[] =>
      els.flatMap((el) => [...(el.text ? [el.text] : []), ...walk(el.children ?? [])])
    const slides = (readout as { slides: Array<{ elements: ReadElement[] }> }).slides
    const texts = walk(slides[0]!.elements)
    // a deck whose tags read as no text at all lists nothing
    if (!texts.some((t) => t.includes('Edit me please'))) {
      expect(mutation).not.toBe('none')
      return
    }
    expect(texts).toContain(`Call ${PLACEHOLDER} now`)
    expect(texts).toContain(`Phone | Tel ${PLACEHOLDER}`)
    expect(texts).toContain(`Group ${PLACEHOLDER}`)
    expect(texts).toContain(`Today ${PLACEHOLDER}`)
    expect(await control.deckWithholds!(1)).toBe(true)
  })
})
