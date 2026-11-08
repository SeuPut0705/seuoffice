/**
 * Generation with a chosen design template (spec section 6): the deck style
 * comes from the document's selection, the requests the user added ride along,
 * and naming a template in conversation changes the selection. Every model
 * call is a fake on DeckAccess; nothing here reaches a provider.
 */
import { describe, expect, it, vi } from 'vitest'
import { listSlideTemplates } from '@genoffice/pipelines/slides/templates'
import type { RenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import {
  createTemplateSelectionState,
  styleWithRequests,
} from '../src/renderer/ai/template-selection-state'
import {
  normalizeTemplateSelection,
  type TemplateSelection,
} from '../src/shared/template-selection'
import type { AgentToolCall } from '../src/shared/ipc'

const builtin = listSlideTemplates()[0]!

interface SavedFile {
  topic: string
  styleSkill: string
  createdAt: string
  layout?: unknown
  basedOn?: string
}

type PageArgs = Parameters<NonNullable<DeckAccess['generatePageLocal']>>[0]

const page = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

function makeDeck(opts?: {
  selected?: { kind: 'builtin' | 'saved'; key: string; adjustments?: string[] }
  saved?: Record<string, SavedFile>
  /** false: an environment with no selection state at all */
  withState?: boolean
  slides?: RenderSlide[]
  /** the main process cannot write what it is asked to remember */
  memoryFails?: boolean
}) {
  let stored: TemplateSelection | null = opts?.selected
    ? normalizeTemplateSelection(opts.selected, 1)
    : null
  let clock = 1
  const saved: Record<string, SavedFile> = { ...(opts?.saved ?? {}) }
  const pageCalls: PageArgs[] = []
  const planStyles: Array<string | undefined> = []
  const stages: string[] = []
  const landModes: string[] = []
  const generateStyleSkill = vi.fn(async (a: { topic: string; styleHint?: string }) => ({
    ok: true,
    styleSkill: 'INVENTED_FOR:' + a.topic,
  }))
  const templateSelection = createTemplateSelectionState({
    getTemplateSelection: async () => stored,
    setTemplateSelection: async (input) => {
      if (opts?.memoryFails) throw new Error('cannot write')
      if (input === null) stored = null
      else stored = normalizeTemplateSelection(input, ++clock) ?? stored
      return stored
    },
    loadStyleTemplate: async (name) => ({ ok: name in saved }),
  })
  const changes: Array<string | null> = []
  templateSelection.subscribe(() => changes.push(templateSelection.current()?.key ?? null))
  const access: DeckAccess = {
    getSlides: () => opts?.slides ?? [],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
    retryBackoffMs: 0,
    onProgress: (event) => stages.push(event.stage),
    landGeneratedPages: async (markers, mode = 'replace') => {
      landModes.push(mode)
      return { ok: true, pages: markers.length, appendedFrom: 0 }
    },
    regenerateSlide: async () => ({ ok: true }),
    generatePageLocal: async (args) => {
      pageCalls.push(args)
      return { ok: true, marker: `localpptx:PAGE${args.pageIndex}` }
    },
    generateStyleSkill,
    planDeckOutline: async (a) => {
      planStyles.push(a.styleSkill)
      return {
        ok: true,
        outline: {
          core_hook: 'CH',
          pages: Array.from({ length: a.count }, (_, i) => ({
            title: `P${a.startPage + i}`,
            brief: 'b',
            layout: 'data',
            image_queries: [],
          })),
        },
      }
    },
    saveStyleTemplate: async (name, data) => {
      saved[name] = data
      return { ok: true }
    },
    listStyleTemplates: async () =>
      Object.entries(saved).map(([name, s]) => ({
        name,
        topic: s.topic,
        createdAt: s.createdAt,
      })),
    loadStyleTemplate: async (name) => {
      const s = saved[name]
      if (!s) return { ok: false, error: `Template "${name}" not found` }
      return {
        ok: true,
        styleSkill: s.styleSkill,
        topic: s.topic,
        ...(s.layout ? { layout: s.layout as never } : {}),
        ...(s.basedOn ? { basedOn: s.basedOn } : {}),
      }
    },
    ...(opts?.withState === false ? {} : { templateSelection }),
  }
  return {
    access,
    skill: createSlidesSkill(access),
    templateSelection,
    stored: () => stored,
    saved,
    pageCalls,
    planStyles,
    stages,
    landModes,
    changes,
    generateStyleSkill,
  }
}

const call = (name: string, input: Record<string, unknown>): AgentToolCall => ({
  id: 'c',
  name,
  input,
})

const topicCall = (extra?: Record<string, unknown>): AgentToolCall =>
  call('generate_deck', { topic: 'Quarterly review', approx_pages: 2, ...(extra ?? {}) })

const pagesCall = (extra?: Record<string, unknown>): AgentToolCall =>
  call('generate_deck', {
    core_hook: 'Hook',
    pages: [{ title: 'New page', brief: 'b', layout: 'data' }],
    ...(extra ?? {}),
  })

type ToolResult = { output: string; isError?: boolean; summary: string }
const run = async (deck: ReturnType<typeof makeDeck>, c: AgentToolCall) =>
  (await deck.skill.executeTool(c)) as ToolResult

const plainSaved: SavedFile = {
  topic: 'Tech',
  styleSkill: 'PLAIN SAVED STYLE',
  createdAt: '2026-01-02T03:04:05.000Z',
}

describe('no selection (6.1)', () => {
  it('the style is invented for the topic and the page writer gets no template flag', async () => {
    const deck = makeDeck()
    const res = await run(deck, topicCall())
    expect(res.isError).toBeFalsy()
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.stages).toContain('style')
    expect(deck.pageCalls).toHaveLength(2)
    for (const args of deck.pageCalls) {
      expect(args.style).toBe('INVENTED_FOR:Quarterly review')
      expect(args).not.toHaveProperty('templateDevices')
    }
    expect(res.output).not.toContain('Note:')
  })

  it('a style the model passes is not kept as a request', async () => {
    const deck = makeDeck()
    await run(deck, pagesCall({ style: 'Deep navy + gold' }))
    expect(deck.stored()).toBeNull()
    expect(deck.pageCalls[0]!.style).toBe('Deep navy + gold')
    expect(deck.changes).toEqual([])
  })

  it('an environment without the selection state behaves the same', async () => {
    const deck = makeDeck({ withState: false })
    await run(deck, topicCall({ style: 'warm tones' }))
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
    expect(deck.skill.buildContext?.() ?? '').not.toContain('design-template')
  })
})

describe('a built-in template is selected (6.2)', () => {
  it('skips the style invention and uses the template’s style text for every page', async () => {
    const deck = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    const res = await run(deck, topicCall())
    expect(res.isError).toBeFalsy()
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
    expect(deck.stages).not.toContain('style')
    expect(deck.planStyles).toEqual([builtin.styleSheet])
    expect(deck.pageCalls).toHaveLength(2)
    for (const args of deck.pageCalls) {
      expect(args.style).toBe(builtin.styleSheet)
      expect(args.templateDevices).toBe(true)
    }
  })

  it('adding pages later uses the same style and exemption', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await run(deck, pagesCall({ insert_mode: 'append' }))
    expect(deck.landModes).toEqual(['append'])
    expect(deck.pageCalls[0]!.style).toBe(styleWithRequests(builtin.styleSheet, ['mostly blue']))
    expect(deck.pageCalls[0]!.templateDevices).toBe(true)
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
  })

  it('redoing one slide uses the selection’s style and requests, not this window’s last style', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
      slides: [page, page],
    })
    const res = await run(deck, call('regenerate_slide', { slideIndex: 1, brief: 'Redo it' }))
    expect(res.isError).toBeFalsy()
    expect(deck.pageCalls).toHaveLength(1)
    expect(deck.pageCalls[0]!.style).toBe(styleWithRequests(builtin.styleSheet, ['mostly blue']))
    expect(deck.pageCalls[0]!.templateDevices).toBe(true)
  })

  it('without a selection, redoing a slide still uses the last style of this window', async () => {
    const deck = makeDeck({ slides: [page, page] })
    await run(deck, topicCall())
    deck.pageCalls.length = 0
    await run(deck, call('regenerate_slide', { slideIndex: 0, brief: 'Redo it' }))
    expect(deck.pageCalls[0]!.style).toBe('INVENTED_FOR:Quarterly review')
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
  })
})

describe('a saved style is selected (6.3)', () => {
  it('a plain saved style: its text and skeleton, the ban rules as usual', async () => {
    const layout = {
      canvas: { w: 1280, h: 720 },
      cover: { title: { x: 80, y: 60, w: 800, h: 90, sizePt: 40 } },
    }
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine' },
      saved: { Mine: { ...plainSaved, layout } },
    })
    await run(deck, topicCall())
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
    for (const args of deck.pageCalls) {
      expect(args.style).toBe('PLAIN SAVED STYLE')
      expect(args).not.toHaveProperty('templateDevices')
    }
    expect(deck.pageCalls.find((a) => a.pageIndex === 1)!.skeleton).toContain('title box: x=80')
  })

  it('a style saved from a built-in template keeps the exemption', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine' },
      saved: { Mine: { ...plainSaved, basedOn: builtin.id } },
      slides: [page],
    })
    await run(deck, topicCall())
    for (const args of deck.pageCalls) expect(args.templateDevices).toBe(true)
    deck.pageCalls.length = 0
    await run(deck, call('regenerate_slide', { slideIndex: 0, brief: 'Redo it' }))
    expect(deck.pageCalls[0]!.templateDevices).toBe(true)
  })

  it('the same holds when the saved style is named through style_template', async () => {
    const based = makeDeck({ saved: { Mine: { ...plainSaved, basedOn: builtin.id } } })
    await run(based, topicCall({ style_template: 'Mine' }))
    expect(based.pageCalls[0]!.templateDevices).toBe(true)
    const plain = makeDeck({ saved: { Mine: plainSaved } })
    await run(plain, topicCall({ style_template: 'Mine' }))
    expect(plain.pageCalls[0]).not.toHaveProperty('templateDevices')
  })
})

describe('added requests (6.4)', () => {
  it('with a selection, a style the model passes is kept and reaches the page writer', async () => {
    const deck = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    await run(deck, topicCall({ style: 'mostly blue' }))
    expect(deck.stored()).toMatchObject({ key: builtin.id, adjustments: ['mostly blue'] })
    const expected = styleWithRequests(builtin.styleSheet, ['mostly blue'])
    expect(deck.pageCalls[0]!.style).toBe(expected)
    expect(expected.startsWith(`${builtin.styleSheet}\n\n## Requests the user added`)).toBe(true)
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
  })

  it('requests accumulate over calls, in order', async () => {
    const deck = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    await run(deck, topicCall({ style: 'mostly blue' }))
    await run(deck, pagesCall({ insert_mode: 'append', style: 'serif titles' }))
    expect(deck.stored()?.adjustments).toEqual(['mostly blue', 'serif titles'])
    expect(deck.pageCalls.at(-1)!.style).toBe(
      styleWithRequests(builtin.styleSheet, ['mostly blue', 'serif titles']),
    )
  })

  it('a request that could not be remembered still shapes the deck it was made for', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
      memoryFails: true,
    })
    const res = await run(deck, topicCall({ style: 'serif titles' }))
    expect(res.isError).toBeFalsy()
    expect(deck.stored()?.adjustments).toEqual(['mostly blue'])
    expect(deck.pageCalls[0]!.style).toBe(
      styleWithRequests(builtin.styleSheet, ['mostly blue', 'serif titles']),
    )
  })

  it('a named template that could not be remembered is used, and no request lands on the old selection', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine', adjustments: ['old request'] },
      saved: { Mine: plainSaved },
      memoryFails: true,
    })
    await run(deck, topicCall({ style_template: builtin.id, style: 'mostly blue' }))
    expect(deck.stored()).toMatchObject({ key: 'Mine', adjustments: ['old request'] })
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
    expect(deck.pageCalls[0]!.templateDevices).toBe(true)
  })

  it('a call without a style adds nothing', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await run(deck, topicCall())
    expect(deck.stored()?.adjustments).toEqual(['mostly blue'])
  })

  it('clearing the requests keeps the template; the next deck is the plain template again', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await deck.templateSelection.refresh()
    await deck.templateSelection.clearRequests()
    await run(deck, topicCall())
    expect(deck.stored()).toMatchObject({ key: builtin.id, adjustments: [] })
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
  })

  it('removing the selection goes back to an invented style', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await deck.templateSelection.refresh()
    await deck.templateSelection.remove()
    await run(deck, topicCall())
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
  })
})

describe('naming a template in the conversation (6.5)', () => {
  it('a built-in id: the deck is made with it and it becomes the selection', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine', adjustments: ['mostly blue'] },
      saved: { Mine: plainSaved },
    })
    const res = await run(deck, topicCall({ style_template: builtin.id }))
    expect(res.output).not.toContain('Note:')
    expect(deck.stored()).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: [] })
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
    expect(deck.pageCalls[0]!.templateDevices).toBe(true)
    expect(deck.changes.at(-1)).toBe(builtin.id)
  })

  it('a built-in name in another letter case', async () => {
    const deck = makeDeck()
    await run(deck, topicCall({ style_template: `  ${builtin.name.toUpperCase()} ` }))
    expect(deck.stored()).toMatchObject({ kind: 'builtin', key: builtin.id })
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
  })

  it('a saved style’s name', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
      saved: { Mine: plainSaved },
    })
    await run(deck, topicCall({ style_template: 'Mine' }))
    expect(deck.stored()).toMatchObject({ kind: 'saved', key: 'Mine', adjustments: [] })
    expect(deck.pageCalls[0]!.style).toBe('PLAIN SAVED STYLE')
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
  })

  it('a saved style’s name in another letter case selects it under its own name', async () => {
    const deck = makeDeck({ saved: { Mine: plainSaved } })
    await run(deck, topicCall({ style_template: 'mine' }))
    expect(deck.stored()).toMatchObject({ kind: 'saved', key: 'Mine' })
  })

  it('a built-in template wins over a saved style of the same name', async () => {
    const deck = makeDeck({ saved: { [builtin.name]: plainSaved } })
    await run(deck, topicCall({ style_template: builtin.name }))
    expect(deck.stored()).toMatchObject({ kind: 'builtin', key: builtin.id })
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
  })

  it('no selection, a built-in named with a style: the style is ignored and nothing is kept', async () => {
    // the model was never told about a template, so its style is its own design system
    const deck = makeDeck()
    await run(deck, topicCall({ style_template: builtin.id, style: 'Deep navy + gold system' }))
    expect(deck.stored()).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: [] })
    for (const args of deck.pageCalls) {
      expect(args.style).toBe(builtin.styleSheet)
      expect(args.style).not.toContain('Requests the user added')
    }
    expect(deck.generateStyleSkill).not.toHaveBeenCalled()
  })

  it('no selection, a saved style named with a style: the style is ignored, as before', async () => {
    const deck = makeDeck({ saved: { Mine: plainSaved } })
    await run(deck, pagesCall({ style_template: 'Mine', style: 'Deep navy + gold system' }))
    expect(deck.stored()).toMatchObject({ kind: 'saved', key: 'Mine', adjustments: [] })
    expect(deck.pageCalls[0]!.style).toBe('PLAIN SAVED STYLE')
  })

  it('another template named over a selection: requests cleared, the style of this call not kept', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine', adjustments: ['old request'] },
      saved: { Mine: plainSaved },
    })
    await run(deck, topicCall({ style_template: builtin.id, style: 'mostly blue' }))
    expect(deck.stored()).toMatchObject({ key: builtin.id, adjustments: [] })
    expect(deck.pageCalls[0]!.style).toBe(builtin.styleSheet)
  })

  it('the selected template named again with a style: the request is kept and applied', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await run(deck, topicCall({ style_template: builtin.name, style: 'serif titles' }))
    expect(deck.stored()?.adjustments).toEqual(['mostly blue', 'serif titles'])
    expect(deck.pageCalls[0]!.style).toBe(
      styleWithRequests(builtin.styleSheet, ['mostly blue', 'serif titles']),
    )
  })

  it('naming what is already selected keeps its requests', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await run(deck, topicCall({ style_template: builtin.name }))
    expect(deck.stored()?.adjustments).toEqual(['mostly blue'])
    expect(deck.pageCalls[0]!.style).toBe(styleWithRequests(builtin.styleSheet, ['mostly blue']))
  })

  it('an unknown name: the selection stays, the note lists usable names, generation goes on with the selection', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
      saved: { Mine: plainSaved },
    })
    const res = await run(deck, topicCall({ style_template: 'no-such-template' }))
    expect(res.isError).toBeFalsy()
    expect(deck.stored()).toMatchObject({ key: builtin.id, adjustments: ['mostly blue'] })
    expect(deck.changes).toEqual([builtin.id])
    expect(res.output).toContain('"no-such-template"')
    expect(res.output).toContain('was not changed')
    expect(res.output).toContain(builtin.id)
    expect(res.output).toContain(builtin.name)
    expect(res.output).toContain('Mine')
    expect(deck.pageCalls).toHaveLength(2)
    expect(deck.pageCalls[0]!.style).toBe(styleWithRequests(builtin.styleSheet, ['mostly blue']))
  })

  it('an unknown name on a call that fails early: the failure still names the usable templates', async () => {
    const deck = makeDeck({ saved: { Mine: plainSaved } })
    // no topic and no pages: refused before any planning
    const res = await run(
      deck,
      call('generate_deck', { core_hook: 'Hook', style_template: 'no-such-template' }),
    )
    expect(res.isError).toBe(true)
    expect(res.output).toContain('generate_deck requires')
    expect(res.output).toContain('"no-such-template"')
    expect(res.output).toContain(builtin.id)
    expect(res.output).toContain('Mine')
    expect(deck.pageCalls).toHaveLength(0)
  })

  it('an unknown name with no selection: generation goes on as with no template', async () => {
    const deck = makeDeck()
    const res = await run(deck, topicCall({ style_template: 'no-such-template' }))
    expect(res.isError).toBeFalsy()
    expect(deck.stored()).toBeNull()
    expect(res.output).toContain('"no-such-template"')
    expect(res.output).toContain(builtin.id)
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.pageCalls[0]!.style).toBe('INVENTED_FOR:Quarterly review')
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
  })
})

describe('what is remembered no longer exists (section 7)', () => {
  it('a template id this version does not have behaves as no selection', async () => {
    const deck = makeDeck({ selected: { kind: 'builtin', key: 'not-in-this-version' } })
    const res = await run(deck, topicCall({ style: 'warm tones' }))
    expect(res.isError).toBeFalsy()
    expect(res.output).not.toContain('Note:')
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.pageCalls[0]).not.toHaveProperty('templateDevices')
    // nothing is added to, or removed from, what is remembered
    expect(deck.stored()).toMatchObject({ key: 'not-in-this-version', adjustments: [] })
    expect(deck.skill.buildContext?.() ?? '').not.toContain('design-template')
  })

  it('a deleted saved style behaves as no selection', async () => {
    const deck = makeDeck({ selected: { kind: 'saved', key: 'Gone' } })
    await run(deck, topicCall())
    expect(deck.generateStyleSkill).toHaveBeenCalledOnce()
    expect(deck.skill.buildContext?.() ?? '').not.toContain('design-template')
  })
})

describe('the context block for the model', () => {
  it('is absent without a selection and the system prompt never changes', async () => {
    const none = makeDeck()
    await none.templateSelection.refresh()
    const selected = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    await selected.templateSelection.refresh()
    expect(none.skill.buildContext?.() ?? '').not.toContain('design-template')
    expect(selected.skill.systemPrompt).toBe(none.skill.systemPrompt)
    expect(selected.skill.systemPrompt).not.toContain('design-template')
  })

  it('with a built-in template: no style questions, style_template and style stay empty', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    await deck.templateSelection.refresh()
    const ctx = deck.skill.buildContext?.() ?? ''
    expect(ctx).toContain('<deck outline>')
    const block = ctx.slice(ctx.indexOf('<design-template>'), ctx.indexOf('</design-template>'))
    expect(block).toContain(`"${builtin.name}"`)
    expect(block).toContain(`id "${builtin.id}"`)
    expect(block).toContain('Do not ask the user about style')
    expect(block).toContain("Leave generate_deck's style_template empty")
    expect(block).toContain("Leave generate_deck's style empty")
    expect(block).toContain("in the user's own terms")
    expect(block).toContain('1. mostly blue')
  })

  it('with a saved style it names the style', async () => {
    const deck = makeDeck({ selected: { kind: 'saved', key: 'Mine' }, saved: { Mine: plainSaved } })
    await deck.templateSelection.refresh()
    const ctx = deck.skill.buildContext?.() ?? ''
    expect(ctx).toContain('<design-template>')
    expect(ctx).toContain('the saved style "Mine"')
    expect(ctx).not.toContain('Requests the user already added')
  })

  it('disappears when the selection is removed', async () => {
    const deck = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    await deck.templateSelection.refresh()
    expect(deck.skill.buildContext?.() ?? '').toContain('<design-template>')
    await deck.templateSelection.remove()
    expect(deck.skill.buildContext?.() ?? '').not.toContain('design-template')
  })

  it('plan_deck tells the model to leave style out only when a template is selected', async () => {
    const plan = call('plan_deck', {
      core_hook: 'Hook',
      style: 'as the template',
      pages: [{ title: 'A', brief: 'b', layout: 'data' }],
    })
    const none = makeDeck()
    expect((await run(none, plan)).output).toContain('passing core_hook + style + all 1 pages')
    const selected = makeDeck({ selected: { kind: 'builtin', key: builtin.id } })
    const out = (await run(selected, plan)).output
    expect(out).not.toContain('passing core_hook + style + all')
    expect(out).toContain('leave style empty')
  })
})

describe('the three tools (6.6)', () => {
  it('list_style_templates answers with both groups, told apart', async () => {
    const deck = makeDeck({ saved: { Mine: plainSaved } })
    const res = await run(deck, call('list_style_templates', {}))
    const builtinAt = res.output.indexOf('Built-in design templates')
    const savedAt = res.output.indexOf('Saved styles')
    expect(builtinAt).toBeGreaterThanOrEqual(0)
    expect(savedAt).toBeGreaterThan(builtinAt)
    const builtinPart = res.output.slice(builtinAt, savedAt)
    for (const tpl of listSlideTemplates()) {
      expect(builtinPart).toContain(`id: ${tpl.id}`)
      expect(builtinPart).toContain(tpl.name)
      expect(builtinPart).toContain(tpl.description)
      expect(builtinPart).toContain(`scheme: ${tpl.scheme}`)
    }
    const savedPart = res.output.slice(savedAt)
    expect(savedPart).toContain('Mine')
    expect(savedPart).toContain('topic: Tech')
    expect(savedPart).toContain('2026-01-02T03:04:05.000Z')
    expect(builtinPart).not.toContain('Mine')
  })

  it('list_style_templates still lists the built-in templates when nothing is saved', async () => {
    const deck = makeDeck()
    const res = await run(deck, call('list_style_templates', {}))
    expect(res.output).toContain(`id: ${builtin.id}`)
    expect(res.output).toContain('Saved styles (0)')
  })

  it.each([
    ['its id', builtin.id],
    ['its id in another case', builtin.id.toUpperCase()],
    ['its name', builtin.name],
    ['its name in another case', ` ${builtin.name.toLowerCase()} `],
  ])('save_style_template refuses a built-in template’s name (%s)', async (_what, name) => {
    const deck = makeDeck()
    await run(deck, topicCall())
    const res = await run(deck, call('save_style_template', { name }))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('built-in design template')
    expect(res.output).toContain(builtin.id)
    expect(Object.keys(deck.saved)).toEqual([])
  })

  it('saving with a built-in template selected stores its text merged with the requests, and where it came from', async () => {
    const deck = makeDeck({
      selected: { kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] },
    })
    // no deck was generated in this window: the selection is what gets saved
    const res = await run(deck, call('save_style_template', { name: 'My Coral' }))
    expect(res.isError).toBeFalsy()
    expect(deck.saved['My Coral']).toMatchObject({
      styleSkill: styleWithRequests(builtin.styleSheet, ['mostly blue']),
      basedOn: builtin.id,
    })
    // and using it later carries the exemption along
    const later = makeDeck({ saved: deck.saved })
    await run(later, topicCall({ style_template: 'My Coral' }))
    expect(later.pageCalls[0]!.templateDevices).toBe(true)
    expect(later.pageCalls[0]!.style).toBe(styleWithRequests(builtin.styleSheet, ['mostly blue']))
  })

  it('saving with a saved style selected after reopening stores its text merged with the requests', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine', adjustments: ['bigger titles'] },
      saved: { Mine: plainSaved },
    })
    // a reopened document: this window has generated nothing yet
    const res = await run(deck, call('save_style_template', { name: 'Mine v2' }))
    expect(res.isError).toBeFalsy()
    expect(deck.saved['Mine v2']).toMatchObject({
      styleSkill: styleWithRequests('PLAIN SAVED STYLE', ['bigger titles']),
    })
    expect(deck.saved['Mine v2']).not.toHaveProperty('basedOn')
  })

  it('saving a selected saved style that came from a built-in template keeps the origin', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine' },
      saved: { Mine: { ...plainSaved, basedOn: builtin.id } },
    })
    const res = await run(deck, call('save_style_template', { name: 'Copy' }))
    expect(res.isError).toBeFalsy()
    expect(deck.saved['Copy']).toMatchObject({
      styleSkill: 'PLAIN SAVED STYLE',
      basedOn: builtin.id,
    })
  })

  it('saving without a selection stores this window’s last style and no origin', async () => {
    const deck = makeDeck()
    await run(deck, topicCall())
    await run(deck, call('save_style_template', { name: 'Invented' }))
    expect(deck.saved['Invented']!.styleSkill).toBe('INVENTED_FOR:Quarterly review')
    expect(deck.saved['Invented']).not.toHaveProperty('basedOn')
  })

  it('a deck made with a style that came from a built-in template keeps the origin when saved again', async () => {
    const deck = makeDeck({
      selected: { kind: 'saved', key: 'Mine' },
      saved: { Mine: { ...plainSaved, basedOn: builtin.id } },
    })
    await run(deck, topicCall())
    await run(deck, call('save_style_template', { name: 'Copy' }))
    expect(deck.saved['Copy']).toMatchObject({
      styleSkill: 'PLAIN SAVED STYLE',
      basedOn: builtin.id,
    })
  })
})
