/**
 * The read_url tool: reads one web page through the ai:read-url bridge and hands
 * the model the same windowed text the shared tool shapes (readUrlModelText in
 * packages/ai-search). A successful read also counts as a web read for the
 * figure-provenance gate — see data-source-gate.test.ts for that side.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide } from '@genoffice/pptx-render'

const deck = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

function mkAccess(extra: Record<string, unknown> = {}): DeckAccess {
  return {
    getSlides: () => [deck],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
    retryBackoffMs: 0,
    ...extra,
  } as unknown as DeckAccess
}

const okPage = (over: Record<string, unknown> = {}) => ({
  ok: true,
  url: 'https://example.com/page',
  title: 'Example page',
  text: 'page text',
  offset: 0,
  totalChars: 9,
  truncated: false,
  ...over,
})

const call = (input: Record<string, unknown>) => ({ id: 't', name: 'read_url', input })

beforeEach(() => {
  ;(window as any).slidesApi = { readUrl: vi.fn(async () => okPage()) }
})

describe('the read_url tool', () => {
  it('is offered whatever the image/media capability gates say', () => {
    const names = createSlidesSkill(
      mkAccess({ imageGenAvailable: () => false, mediaAnalysisAvailable: () => false }),
    ).tools.map((t) => t.name)
    expect(names).toContain('read_url')
    expect(names).not.toContain('generate_image')
    expect(names).not.toContain('analyze_media')
  })

  it('carries the tool description and needs only url', () => {
    const tool = createSlidesSkill(mkAccess()).tools.find((t) => t.name === 'read_url')!
    expect(tool).toBeTruthy()
    expect(tool.inputSchema.required).toEqual(['url'])
    expect(String(tool.description)).toContain('Read the text of a web page')
    expect(String(tool.description)).toContain('50,000 characters')
    expect(String(tool.description)).toContain('SKILL.md')
  })

  it('tells the skill prompt how to read pages and skills', () => {
    const prompt = createSlidesSkill(mkAccess()).systemPrompt
    expect(prompt).toContain('## Reading web pages')
    expect(prompt).toContain('read_url')
  })

  it('returns the windowed model text the shared tool shapes', async () => {
    const r = await createSlidesSkill(mkAccess()).executeTool!(
      call({ url: 'https://example.com/page' }),
    )
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(false)
    expect(r.output).toBe(
      'Example page — characters 0..9 of 9 (end)\nhttps://example.com/page\n\npage text',
    )
    expect(r.summary).toContain('example.com')
    expect(r.summary).toContain('9')
  })

  it('marks a long page as continue-with-offset', async () => {
    ;(window as any).slidesApi.readUrl = vi.fn(async () =>
      okPage({ text: 'abcde', offset: 1, totalChars: 50001, truncated: true, nextOffset: 6 }),
    )
    const r = await createSlidesSkill(mkAccess()).executeTool!(
      call({ url: 'https://example.com/page', offset: 1 }),
    )
    expect(r.output).toBe(
      'Example page — characters 1..6 of 50001 (continue with offset)\nhttps://example.com/page\n\nabcde',
    )
  })

  it('falls back to the final host when the page carries no title', async () => {
    ;(window as any).slidesApi.readUrl = vi.fn(async () =>
      okPage({ url: 'https://raw.example/x', title: undefined }),
    )
    const r = await createSlidesSkill(mkAccess()).executeTool!(
      call({ url: 'https://example.com/page' }),
    )
    expect(r.output.startsWith('raw.example — characters 0..9 of 9 (end)')).toBe(true)
  })

  it('floors a numeric offset and never sends a negative one', async () => {
    const readUrl = vi.fn(async () => okPage())
    ;(window as any).slidesApi.readUrl = readUrl
    const skill = createSlidesSkill(mkAccess())
    await skill.executeTool!(call({ url: 'https://example.com/page', offset: 3.9 }))
    expect(readUrl).toHaveBeenLastCalledWith('https://example.com/page', 3)
    await skill.executeTool!(call({ url: 'https://example.com/page', offset: -7 }))
    expect(readUrl).toHaveBeenLastCalledWith('https://example.com/page', 0)
    await skill.executeTool!(call({ url: 'https://example.com/page' }))
    expect(readUrl).toHaveBeenLastCalledWith('https://example.com/page', 0)
  })

  it('turns a bridge failure into a failed result carrying its English sentence', async () => {
    ;(window as any).slidesApi.readUrl = vi.fn(async () => ({
      ok: false,
      error:
        'Refused to fetch that address: it is, or redirects to, a private or loopback address.',
      errorCode: 'blocked',
    }))
    const r = await createSlidesSkill(mkAccess()).executeTool!(
      call({ url: 'https://example.com/page' }),
    )
    expect(r.isError).toBe(true)
    expect(r.mutated).toBe(false)
    expect(r.output).toContain('Refused to fetch that address')
    expect(r.summary).toBeTruthy()
  })
})
