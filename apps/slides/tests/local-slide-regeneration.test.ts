/**
 * Slide (re)generation runs on the local pipeline only: the model writes a
 * slide spec, the spec is built into a one-slide pptx, and that page is landed
 * in place. No cloud generation, no cloud status to ask for first.
 *
 * The pipeline here is the real one behind a fake model: regenerate_slide →
 * generatePageLocal (spec JSON → parsePageSpec → buildPagePptx) → a marker →
 * regenerateSlide redeems the marker for the bytes, which are reopened.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openPptx, type TextElement } from '@genoffice/pptx-engine'
import type { RenderSlide } from '@genoffice/pptx-render'
import { buildPagePptx, parsePageSpec } from '@genoffice/pipelines/slides'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { AgentToolCall } from '../src/shared/ipc'

const page = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

const call = (name: string, input: Record<string, unknown>): AgentToolCall => ({
  id: 't',
  name,
  input,
})

/** What the model would answer: one slide spec carrying the brief's title */
const specFor = (title: string): string =>
  JSON.stringify({
    background: '#0E1A2B',
    elements: [
      {
        type: 'text',
        x: 80,
        y: 60,
        w: 800,
        h: 90,
        paragraphs: [{ runs: [{ text: title, sizePt: 36, bold: true, color: '#FFFFFF' }] }],
      },
    ],
  })

/** The local pipeline with a fake model in front and an in-memory marker store behind */
function localPipeline(model: (title: string) => string) {
  const issued = new Map<string, Uint8Array>()
  const landed: Array<{ slideIndex: number; bytes: Uint8Array }> = []
  const generatePageLocal: NonNullable<DeckAccess['generatePageLocal']> = vi.fn(async (args) => {
    const parsed = parsePageSpec(model(args.title))
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const { bytes } = await buildPagePptx(parsed.spec, { fetchImage: async () => null })
    const marker = `cloudpptx:/tmp/page-${issued.size + 1}.pptx`
    issued.set(marker, bytes)
    return { ok: true, marker }
  })
  const regenerateSlide: NonNullable<DeckAccess['regenerateSlide']> = vi.fn(
    async (slideIndex, marker) => {
      const bytes = issued.get(marker)
      if (!bytes) return { ok: false, error: 'unknown page marker' }
      landed.push({ slideIndex, bytes })
      return { ok: true }
    },
  )
  return { generatePageLocal, regenerateSlide, landed }
}

function mkAccess(slides: RenderSlide[], overrides: Partial<DeckAccess>): DeckAccess {
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
    retryBackoffMs: 0,
    ...overrides,
  }
}

beforeEach(() => {
  // any question about a cloud route fails the test: there is none to ask
  ;(window as unknown as { slidesApi: unknown }).slidesApi = new Proxy(
    {},
    {
      get(_target, prop) {
        if (/cloud/i.test(String(prop))) throw new Error(`cloud bridge call: ${String(prop)}`)
        return undefined
      },
    },
  )
})

describe('slide regeneration through the local pipeline', () => {
  it('redoes one slide in place: spec → one-slide pptx → landed at the same index', async () => {
    const pipeline = localPipeline(specFor)
    const skill = createSlidesSkill(mkAccess([page, page, page], pipeline))
    const r = await skill.executeTool!(
      call('regenerate_slide', {
        slideIndex: 1,
        title: 'Quarterly Wins',
        brief: 'Redo as a bold title page',
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(r.mutated).toBe(true)
    expect(pipeline.generatePageLocal).toHaveBeenCalledOnce()
    expect(pipeline.landed).toHaveLength(1)
    expect(pipeline.landed[0]!.slideIndex).toBe(1)

    // the landed page is a real one-slide deck carrying the brief's title
    const opened = await openPptx(pipeline.landed[0]!.bytes)
    expect(opened.deck.slides).toHaveLength(1)
    const texts = opened.deck.slides[0]!.elements.filter((e): e is TextElement => e.type === 'text')
    expect(texts[0]!.text!.paragraphs[0]!.runs[0]!.text).toBe('Quarterly Wins')
  })

  it('a rejected spec is retried once, then the page is left untouched', async () => {
    const pipeline = localPipeline(() => 'sorry, I cannot')
    const skill = createSlidesSkill(mkAccess([page], pipeline))
    const r = await skill.executeTool!(call('regenerate_slide', { slideIndex: 0, brief: 'redo' }))
    expect(r.isError).toBe(true)
    expect(pipeline.generatePageLocal).toHaveBeenCalledTimes(2)
    expect(pipeline.regenerateSlide).not.toHaveBeenCalled()
    expect(pipeline.landed).toEqual([])
  })

  it('generate_deck builds every page through the same local pipeline', async () => {
    const pipeline = localPipeline(specFor)
    const landedDeck: string[][] = []
    const skill = createSlidesSkill(
      mkAccess([], {
        generatePageLocal: pipeline.generatePageLocal,
        landGeneratedPages: async (markers, mode = 'replace') => {
          landedDeck.push([mode, ...markers])
          return { ok: true, pages: landedDeck.length }
        },
      }),
    )
    const r = await skill.executeTool!(
      call('generate_deck', {
        core_hook: 'h',
        style: 's',
        pages: [
          { title: 'One', brief: 'first', layout: 'cover', image_queries: [] },
          { title: 'Two', brief: 'second', layout: 'content', image_queries: [] },
        ],
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(pipeline.generatePageLocal).toHaveBeenCalledTimes(2)
    expect(landedDeck.map(([mode]) => mode)).toEqual(['replace', 'append'])
    expect(r.output).toContain('2/2')
  })
})

describe('the cloud generation route is gone', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src')
  const read = (file: string) => readFileSync(join(src, file), 'utf-8')

  it('no cloud page channel is registered, exposed or declared', () => {
    for (const file of ['main/slides-main.ts', 'preload/index.ts', 'shared/ipc.ts']) {
      const text = read(file)
      expect(text, file).not.toMatch(/slides:cloud-/)
      expect(text, file).not.toMatch(/cloudGenStatus|cloudGeneratePage|cloudPageCancel/)
      expect(text, file).not.toMatch(/GENOFFICE_CLOUD_SLIDE/)
    }
  })

  it('the local page channel is still there, end to end', () => {
    expect(read('main/slides-main.ts')).toContain("'slides:local-page-generate'")
    expect(read('preload/index.ts')).toContain("'slides:local-page-generate'")
    expect(read('renderer/ai/AiPanel.tsx')).toContain('localGeneratePage')
  })

  it('the skill has one page generator and no cloud predicate', () => {
    const skill = read('renderer/ai/slides-skill.ts')
    expect(skill).not.toMatch(/generatePageCloud|isCloudPageGenEnabled/)
    expect(skill).toContain('generatePageLocal')
  })
})
