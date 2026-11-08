/**
 * The viewer search's "found in AI-read text" rule and the AI window's tool
 * that opens AI page reading (spec §7, §9).
 */
import { describe, expect, it, vi } from 'vitest'
import { aiReadOnlyPages, type SearchIndex } from '../src/renderer/search'
import { AGENT_TOOLS, executePdfTool, type PdfAiDeps } from '../src/renderer/ai/tools'
import { createPdfSkill } from '../src/renderer/ai/pdf-skill'

const page = (text: string) => ({ text, lower: text.toLowerCase(), items: [] })

/** page 1 has positioned text, page 2 is a scan whose OCR found other words, page 3 is a bare scan */
const INDEX: SearchIndex = [page('Annual report 2024'), page('Figure caption'), page('')]

describe('search: pages found only in AI-read text', () => {
  it('lists a page whose AI-read text has the query and whose positioned text has none', () => {
    const ai = new Map([
      [2, 'The harvest grew by a third.'],
      [3, 'Harvest tables follow.'],
    ])
    expect(aiReadOnlyPages(INDEX, ai, 'harvest')).toEqual([1, 2])
  })

  it('leaves out a page whose positioned text (text layer or OCR) already has a hit', () => {
    const ai = new Map([
      [1, 'Annual report 2024, read again by the AI.'],
      [2, 'Figure caption and more.'],
    ])
    expect(aiReadOnlyPages(INDEX, ai, 'annual report')).toEqual([])
    expect(aiReadOnlyPages(INDEX, ai, 'CAPTION')).toEqual([])
  })

  it('needs the query in the AI-read text itself', () => {
    const ai = new Map([[3, 'Harvest tables follow.']])
    expect(aiReadOnlyPages(INDEX, ai, 'rainfall')).toEqual([])
    expect(aiReadOnlyPages(INDEX, ai, '  ')).toEqual([])
    expect(aiReadOnlyPages(INDEX, new Map(), 'harvest')).toEqual([])
  })

  it('matches case-insensitively and answers pages in order', () => {
    const ai = new Map([
      [3, 'HARVEST'],
      [2, 'harvest'],
    ])
    expect(aiReadOnlyPages(INDEX, ai, 'Harvest')).toEqual([1, 2])
  })
})

const depsWith = (startAiPageReading?: PdfAiDeps['startAiPageReading']): PdfAiDeps =>
  ({
    pageCount: () => 5,
    ...(startAiPageReading ? { startAiPageReading } : {}),
  }) as unknown as PdfAiDeps

const call = (input: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'start_ai_page_reading',
  input,
})

describe('start_ai_page_reading tool', () => {
  it('is offered to the model and described in the skill prompt', () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toContain('start_ai_page_reading')
    const skill = createPdfSkill({ imageGenAvailable: () => true } as unknown as PdfAiDeps)
    expect(skill.systemPrompt).toContain('start_ai_page_reading')
  })

  it('only opens the window and returns at once, saying nothing was read yet', async () => {
    const open = vi.fn(() => ({ opened: true as const }))
    const result = await executePdfTool(depsWith(open), call({ pages: [4, 2, 2] }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith([2, 4])
    expect(result.isError).toBeUndefined()
    expect(result.output).toContain('nothing has been sent yet')
    expect(result.output).toContain('do not claim the pages were read')
  })

  it('preselects when no pages are named', async () => {
    const open = vi.fn(() => ({ opened: true as const }))
    await executePdfTool(depsWith(open), call())
    expect(open).toHaveBeenCalledWith(null)
  })

  it('reports the running job instead of starting another', async () => {
    const open = vi.fn(() => ({ running: { done: 3, total: 8 } }))
    const result = await executePdfTool(depsWith(open), call())
    expect(result.output).toContain('already running on this document (3/8)')
  })

  it('refuses pages outside the document without opening anything', async () => {
    const open = vi.fn(() => ({ opened: true as const }))
    const result = await executePdfTool(depsWith(open), call({ pages: [0, 6] }))
    expect(result.isError).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })

  it('says so where the window is not available', async () => {
    const result = await executePdfTool(depsWith(), call())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available')
  })
})

describe('edit tool errors', () => {
  it('point at search_text for the exact text', async () => {
    const doc = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Hello', hasEOL: true }] }),
        getAnnotations: async () => [],
        cleanup: () => {},
      }),
    }
    const deps = {
      doc: () => doc,
      pageCount: () => 1,
      readOnly: () => false,
      isDeleted: () => false,
      searchIndex: async () => [page('Hello')],
      ocrText: () => null,
      pageGeom: () => ({ w: 600, h: 800, rot: 0, ox: 0, oy: 0, uu: 1 }),
    } as unknown as PdfAiDeps
    const result = await executePdfTool(deps, {
      id: 't2',
      name: 'markup_text',
      input: { page: 1, text: 'absent words', type: 'highlight' },
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('use search_text to find the exact text')
    expect(result.output).not.toContain('read_pages to verify')
  })
})
