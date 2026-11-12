import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openPptx } from '@seuoffice/pptx-engine'
import { buildRenderSlide, type RenderNode, type RenderSlide } from '@seuoffice/pptx-render'
import {
  LABEL,
  mutatedHiddenDeck,
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
  type StoryTag,
  type TagMutation,
} from '../../../packages/pptx-engine/tests/helpers/hidden-deck'
import { describeNode, promptLabel } from '../src/renderer/ai/edit-queue'
import { redactGuardFor } from '../src/renderer/ai/redact-guard'
import { redactLabelsOf, textForModel } from '../src/renderer/ai/redact-view'
import { screenshotAllowed } from '../src/renderer/ai/slide-qc'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'

/**
 * The hidden-deck fixture (body, table cell, grouped shape, field, each with a
 * run hidden from AI) with its tags written another valid way, read the way the
 * slide editor's AI reads a deck: the outline, read_slide, a script's element
 * list, the card text of a selection. No hidden word may reach the model.
 */

const VARIANTS: TagMutation[] = ['none', ...TAG_MUTATION_NAMES]

async function slidesOf(
  mutation: TagMutation,
  stories?: readonly StoryTag[],
): Promise<RenderSlide[] | null> {
  const dir = mkdtempSync(join(tmpdir(), 'slides-tag-mutations-'))
  const file = await mutatedHiddenDeck(dir, mutation, 'mutated.pptx', stories)
  // an editor that refuses the deck shows the model nothing
  const opened = await openPptx(new Uint8Array(readFileSync(file))).catch(() => null)
  if (!opened) return null
  return opened.deck.slides.map((slide) =>
    buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 1280 }),
  )
}

const access = (slides: RenderSlide[]): DeckAccess =>
  ({
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
  }) as unknown as DeckAccess

function everyNode(nodes: RenderNode[]): RenderNode[] {
  return nodes.flatMap((n) => [n, ...(n.type === 'group' ? everyNode(n.children) : [])])
}

describe.each(VARIANTS)('slide tags rewritten: %s', (mutation) => {
  it('the model is shown no hidden word', async () => {
    const slides = await slidesOf(mutation)
    if (!slides) {
      expect(mutation).not.toBe('none')
      return
    }
    const skill = createSlidesSkill(access(slides))
    const read = await skill.executeTool({ id: 't', name: 'read_slide', input: { slideIndex: 0 } })
    const script = await skill.executeTool({
      id: 't',
      name: 'execute_slide_script',
      input: { slideIndex: 0, code: 'return JSON.stringify(els.map((e) => e.text))' },
    })
    const outline = skill.buildContext!()
    const nodes = slides.flatMap((s) => everyNode(s.nodes))
    const cards = nodes.map((n) => promptLabel(describeNode(n)))
    const views = nodes.map((n) => textForModel(n))
    const shown = [outline, skill.systemPrompt, read.output, script.output, ...cards, ...views]
    for (const text of shown) expect(text).not.toContain(SECRET)

    // nothing goes missing: the shapes the model reads carry the placeholder
    const listed = nodes.some((n) => textForModel(n).includes('Edit me please'))
    if (mutation === 'none') expect(listed).toBe(true)
    if (listed) {
      // the pictures a person hid read as the marker, the others are listed as they are
      const pictures = nodes.filter((n) => n.type === 'picture')
      expect(pictures.filter((n) => n.redact).length).toBe(2)
      for (const hidden of pictures.filter((n) => n.redact)) {
        expect(textForModel(hidden)).toBe(PLACEHOLDER)
      }
      for (const plain of pictures.filter((n) => !n.redact)) {
        expect(read.output).toContain(plain.durableId ?? plain.sourceId)
      }
      // a hidden run written as written as long markup wraps, and reads as its marker on each line
      for (const story of ['Call', 'Tel', 'Group', 'Today']) {
        expect(read.output, story).toMatch(new RegExp(`${story}\\s+${PLACEHOLDER}`))
      }
    }
  })
})

/**
 * Whatever else holds a hidden run, each place text lives is a place that has to
 * be known to withhold on its own: a deck whose only hidden run is in a table
 * cell, a group or a field is as hidden as any other. The slide is not pictured
 * to the model, the instruction names the placeholder, and the write guard keeps
 * the model's hands off the words.
 */
const STORIES = [
  ['body text', 'B', 0],
  ['table cell', 'T', 2],
  ['shape in a group', 'G', 3],
  ['field', 'F', 4],
  ['run of the placeholder words', 'E', 5],
  ['picture', 'P', 6],
  ['picture in a group', 'Q', 3],
  ['shape filled with a picture', 'S', 8],
] as const

describe.each(STORIES)('a hidden run in a %s, on its own', (_place, tag, at) => {
  it('is not pictured to the model', async () => {
    const slides = (await slidesOf('none', [tag]))!
    expect(screenshotAllowed(slides[0]!)).toBe(false)
  })

  it('is named in the model instruction', async () => {
    const slides = (await slidesOf('none', [tag]))!
    expect(redactLabelsOf(slides[0]!)).toEqual([LABEL])
    const skill = createSlidesSkill(access(slides))
    expect(skill.systemPrompt).toContain('## Private placeholders')
    expect(skill.systemPrompt).not.toContain(SECRET)
  })

  it('is kept from a replacement and a page delete by the write guard', async () => {
    const slides = (await slidesOf('none', [tag]))!
    const node = slides[0]!.nodes[at]!
    // the id the model addresses the element by: the one the outline lists
    const el = node.durableId ?? node.sourceId
    // the words of the echo are the placeholder's own: marked, not the words, decide
    const needle = tag === 'E' ? '{{client' : SECRET.slice(0, 5)
    expect(redactGuardFor({ op: 'findReplace', find: needle }, slides)).not.toBeNull()
    // as the executor reads an op: the slide by its index or its durable id
    expect(redactGuardFor({ op: 'deleteSlide', target: { slide: 0 } }, slides)).not.toBeNull()
    expect(redactGuardFor({ op: 'deleteSlide', target: { slide: 's_1' } }, slides)).not.toBeNull()
    expect(redactGuardFor({ op: 'deleteElement', target: { slide: 0, el } }, slides)).not.toBeNull()
    if (node.type === 'table') {
      expect(
        redactGuardFor({ op: 'setTableCell', target: { slide: 0, el } }, slides),
      ).not.toBeNull()
    }
  })
})

describe.each(STORIES.filter(([, tag]) => ['B', 'G', 'F', 'S', 'E'].includes(tag)))(
  'a script rewriting a %s with a hidden run in it',
  (_place, tag, at) => {
    it('is refused and the deck is left as it was', async () => {
      const slides = (await slidesOf('none', [tag]))!
      const applyEditScript = vi.fn(async () => ({ error: 'unexpected' }))
      ;(window as unknown as { slidesApi: unknown }).slidesApi = { applyEditScript }
      const node = slides[0]!.nodes[at]!
      const el = node.type === 'group' ? node.children[0]! : node
      const id = el.durableId ?? el.sourceId
      const result = await createSlidesSkill(access(slides)).executeTool({
        id: 't',
        name: 'execute_slide_script',
        input: { slideIndex: 0, code: `setText('${id}', 'New words')` },
      })
      expect(result.isError).toBe(true)
      expect(applyEditScript).not.toHaveBeenCalled()
    })
  },
)

describe.each(STORIES)('a page redo of a page with a hidden run in a %s', (_place, tag) => {
  it('is refused before anything is generated', async () => {
    const slides = (await slidesOf('none', [tag]))!
    const regenerateSlide = vi.fn()
    const generatePageLocal = vi.fn()
    const result = await createSlidesSkill({
      ...access(slides),
      regenerateSlide,
      generatePageLocal,
    } as unknown as DeckAccess).executeTool({
      id: 't',
      name: 'regenerate_slide',
      input: { slideIndex: 0, brief: 'Make the page cleaner' },
    })
    expect(result.isError).toBe(true)
    expect(generatePageLocal).not.toHaveBeenCalled()
    expect(regenerateSlide).not.toHaveBeenCalled()
  })
})
