/** read_comments tool + the deck-context comment hint. */
import { describe, it, expect } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AgentToolCall, SlideComment } from '../src/shared/ipc'

const slide = (hidden = false) =>
  ({ widthPx: 1280, heightPx: 720, nodes: [], hidden }) as unknown as RenderSlide

const comment = (over: Partial<SlideComment>): SlideComment => ({
  authorId: 0,
  author: 'Alice',
  initials: 'A',
  dt: '2026-10-19T01:02:03.000Z',
  idx: 1,
  text: 'hello',
  ...over,
})

function access(slides: RenderSlide[], all: SlideComment[][]): DeckAccess {
  const pages: number[] = []
  let total = 0
  all.forEach((list, i) => {
    if (list.length > 0) {
      pages.push(i + 1)
      total += list.length
    }
  })
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    getAllComments: async () => all,
    getCommentSummary: () => ({ total, pages }),
    applySlide: () => {},
    applyDeck: () => {},
  } as unknown as DeckAccess
}

const call = (name: string): AgentToolCall => ({ id: 't', name, input: {} })

describe('read_comments', () => {
  it('lists every page in order with ids, author and time', async () => {
    const a = access(
      [slide(), slide(true)],
      [
        [comment({ authorId: 2, idx: 3, author: 'Bob', text: 'check the title' })],
        [comment({ authorId: 0, idx: 1, text: 'page two note' })],
      ],
    )
    const r = await createSlidesSkill(a).executeTool(call('read_comments'))
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Page 1 (slideIndex=0):')
    expect(r.output).toContain('- 2:3 · Bob · 2026-10-19T01:02:03.000Z · check the title')
    expect(r.output).toContain('Page 2 (slideIndex=1, hidden):')
    expect(r.output).toContain('- 0:1 · Alice · 2026-10-19T01:02:03.000Z · page two note')
    expect(r.mutated).toBe(false)
  })

  it('normalizes a missing author and omits an empty time', async () => {
    const a = access([slide()], [[comment({ author: '  ', dt: '', text: 'no author' })]])
    const r = await createSlidesSkill(a).executeTool(call('read_comments'))
    expect(r.output).toContain('- 0:1 · Unknown author · no author')
  })

  it('says so when the deck has no comments', async () => {
    const a = access([slide()], [[]])
    const r = await createSlidesSkill(a).executeTool(call('read_comments'))
    expect(r.output).toBe('(the deck has no review comments)')
  })

  it('skips pages without comments', async () => {
    const a = access([slide(), slide(), slide()], [[], [comment({})], []])
    const r = await createSlidesSkill(a).executeTool(call('read_comments'))
    expect(r.output).not.toContain('Page 1')
    expect(r.output).toContain('Page 2 (slideIndex=1):')
    expect(r.output).not.toContain('Page 3')
  })
})

describe('deck context comment hint', () => {
  it('names the total and the 1-based pages', () => {
    const a = access(
      [slide(), slide(), slide()],
      [[comment({})], [], [comment({ idx: 2 }), comment({ idx: 3 })]],
    )
    const ctx = createSlidesSkill(a).buildContext!()
    expect(ctx).toContain(
      'The deck has 3 review comment(s) on page(s) 1, 3. Use read_comments to read them.',
    )
  })

  it('stays out when the deck has no comments', () => {
    const a = access([slide()], [[]])
    const ctx = createSlidesSkill(a).buildContext!()
    expect(ctx).not.toContain('review comment')
  })

  it('counts hidden pages in the hint', () => {
    const a = access([slide(), slide(true)], [[comment({})], [comment({ idx: 2 })]])
    const ctx = createSlidesSkill(a).buildContext!()
    expect(ctx).toContain(
      'The deck has 2 review comment(s) on page(s) 1, 2. Use read_comments to read them.',
    )
  })
})
