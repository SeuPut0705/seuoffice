// @vitest-environment node
/**
 * The renderer's one place for "which design template is this document made
 * with, and what did the user ask for on top of it". The bridge is a fake of
 * the two preload calls that validates like the real store does.
 */
import { describe, expect, it, vi } from 'vitest'
import { listSlideTemplates } from '@genoffice/pipelines/slides/templates'
import {
  createTemplateSelectionState,
  resolveAppliedTemplate,
  styleWithRequests,
  withAddedRequest,
  type TemplateSelectionBridge,
} from '../src/renderer/ai/template-selection-state'
import {
  normalizeTemplateSelection,
  TEMPLATE_ADJUSTMENTS_MAX_CHARS,
  type TemplateSelection,
} from '../src/shared/template-selection'

const builtin = listSlideTemplates()[0]!

function fakeBridge(opts?: { stored?: TemplateSelection | null; saved?: string[] }) {
  let stored: TemplateSelection | null = opts?.stored ?? null
  const saved = new Set(opts?.saved ?? [])
  let clock = 1000
  const bridge: TemplateSelectionBridge = {
    getTemplateSelection: vi.fn(async () => stored),
    setTemplateSelection: vi.fn(async (input) => {
      if (input === null) stored = null
      else stored = normalizeTemplateSelection(input, ++clock) ?? stored
      return stored
    }),
    loadStyleTemplate: vi.fn(async (name: string) => ({ ok: saved.has(name) })),
  }
  return { bridge, saved, stored: () => stored }
}

const remembered = (
  kind: 'builtin' | 'saved',
  key: string,
  adjustments: string[] = [],
): TemplateSelection => ({ kind, key, adjustments, updatedAt: 1 })

describe('template selection state', () => {
  it('starts with no selection and reads the document’s one on refresh', async () => {
    const { bridge } = fakeBridge({ stored: remembered('builtin', builtin.id, ['mostly blue']) })
    const state = createTemplateSelectionState(bridge)
    expect(state.current()).toBeNull()
    const read = await state.refresh()
    expect(read).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: ['mostly blue'] })
    expect(state.current()).toBe(read)
  })

  it('selecting remembers it through the preload call and tells subscribers', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    const seen: Array<string | null> = []
    const off = state.subscribe(() => seen.push(state.current()?.key ?? null))
    await state.select('builtin', builtin.id)
    expect(stored()).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: [] })
    expect(state.current()).toMatchObject({ kind: 'builtin', key: builtin.id })
    expect(seen).toEqual([builtin.id])
    off()
    await state.remove()
    expect(seen).toEqual([builtin.id])
  })

  it('added requests accumulate in order and stay with the selection', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    await state.addRequest('mostly blue')
    await state.addRequest('  rounder   cards\n please ')
    expect(state.current()?.adjustments).toEqual(['mostly blue', 'rounder cards please'])
    expect(stored()?.adjustments).toEqual(['mostly blue', 'rounder cards please'])
  })

  it('a request stated again moves to the end instead of being stored twice', async () => {
    const { bridge } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    await state.addRequest('mostly blue')
    await state.addRequest('serif titles')
    await state.addRequest('Mostly Blue')
    expect(state.current()?.adjustments).toEqual(['serif titles', 'Mostly Blue'])
  })

  it('drops the oldest requests beyond the cap', async () => {
    const { bridge } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    const long = (ch: string) => ch.repeat(TEMPLATE_ADJUSTMENTS_MAX_CHARS / 2 - 10)
    await state.addRequest(long('a'))
    await state.addRequest(long('b'))
    await state.addRequest(long('c'))
    expect(state.current()?.adjustments).toEqual([long('b'), long('c')])
  })

  it('a request without a selection is not kept', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    expect(await state.addRequest('mostly blue')).toBeNull()
    expect(stored()).toBeNull()
    expect(bridge.setTemplateSelection).not.toHaveBeenCalled()
  })

  it('clearing the requests keeps the selection', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    await state.addRequest('mostly blue')
    const after = await state.clearRequests()
    expect(after).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: [] })
    expect(stored()).toMatchObject({ kind: 'builtin', key: builtin.id, adjustments: [] })
  })

  it('changing the selection removes the requests; selecting the same one again keeps them', async () => {
    const { bridge, saved } = fakeBridge()
    saved.add('My Style')
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    await state.addRequest('mostly blue')
    await state.select('builtin', builtin.id)
    expect(state.current()?.adjustments).toEqual(['mostly blue'])
    await state.select('saved', 'My Style')
    expect(state.current()).toMatchObject({ kind: 'saved', key: 'My Style', adjustments: [] })
  })

  it('removing the selection removes the requests with it', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    await state.select('builtin', builtin.id)
    await state.addRequest('mostly blue')
    await state.remove()
    expect(state.current()).toBeNull()
    expect(stored()).toBeNull()
    await state.select('builtin', builtin.id)
    expect(state.current()?.adjustments).toEqual([])
  })

  it('a template id this version does not have reads as no selection', async () => {
    const { bridge, stored } = fakeBridge({ stored: remembered('builtin', 'not-in-this-version') })
    const state = createTemplateSelectionState(bridge)
    expect(await state.refresh()).toBeNull()
    expect(state.current()).toBeNull()
    // what is remembered is left alone: a later version may have that template
    expect(stored()).toMatchObject({ key: 'not-in-this-version' })
  })

  it('a deleted saved style reads as no selection', async () => {
    const { bridge, saved } = fakeBridge({ stored: remembered('saved', 'Gone') })
    const state = createTemplateSelectionState(bridge)
    expect(await state.refresh()).toBeNull()
    saved.add('Gone')
    expect(await state.refresh()).toMatchObject({ kind: 'saved', key: 'Gone' })
  })

  it('a built-in id that does not exist cannot be selected', async () => {
    const { bridge, stored } = fakeBridge()
    const state = createTemplateSelectionState(bridge)
    expect(await state.select('builtin', 'not-in-this-version')).toBeNull()
    expect(stored()).toBeNull()
  })

  it('a main process that does not answer leaves the state as it was, without throwing', async () => {
    const state = createTemplateSelectionState({
      getTemplateSelection: async () => {
        throw new Error('no handler')
      },
      setTemplateSelection: async () => {
        throw new Error('no handler')
      },
      loadStyleTemplate: async () => {
        throw new Error('no handler')
      },
    })
    expect(await state.refresh()).toBeNull()
    expect(await state.select('builtin', builtin.id)).toBeNull()
    await expect(state.remove()).resolves.toBeUndefined()
    expect(await state.addRequest('mostly blue')).toBeNull()
  })

  it('a refresh that was overtaken by a change does not put the old value back', async () => {
    const { bridge } = fakeBridge()
    let release: (value: TemplateSelection | null) => void = () => {}
    bridge.getTemplateSelection = () => new Promise((resolve) => (release = resolve))
    const state = createTemplateSelectionState(bridge)
    const reading = state.refresh()
    await state.select('builtin', builtin.id)
    release(null)
    await reading
    expect(state.current()).toMatchObject({ kind: 'builtin', key: builtin.id })
  })
})

describe('what a selection means for generation', () => {
  it('a built-in template: its style text, and its devices override the ban rules', async () => {
    const applied = await resolveAppliedTemplate(remembered('builtin', builtin.id, ['mostly blue']))
    expect(applied).toEqual({
      kind: 'builtin',
      key: builtin.id,
      name: builtin.name,
      styleText: builtin.styleSheet,
      basedOn: builtin.id,
      requests: ['mostly blue'],
    })
  })

  it('a plain saved style: its text and layout skeleton, no exemption', async () => {
    const layout = { version: 1 } as never
    const applied = await resolveAppliedTemplate(remembered('saved', 'Mine'), async () => ({
      ok: true,
      styleSkill: 'SAVED TEXT',
      layout,
    }))
    expect(applied).toEqual({
      kind: 'saved',
      key: 'Mine',
      name: 'Mine',
      styleText: 'SAVED TEXT',
      layout,
      requests: [],
    })
    expect(applied).not.toHaveProperty('basedOn')
  })

  it('a style saved from a built-in template carries the exemption along', async () => {
    const applied = await resolveAppliedTemplate(remembered('saved', 'Mine'), async () => ({
      ok: true,
      styleSkill: 'SAVED TEXT',
      basedOn: builtin.id,
    }))
    expect(applied?.basedOn).toBe(builtin.id)
  })

  it('a basedOn naming a template this version does not have is no exemption', async () => {
    const applied = await resolveAppliedTemplate(remembered('saved', 'Mine'), async () => ({
      ok: true,
      styleSkill: 'SAVED TEXT',
      basedOn: 'not-in-this-version',
    }))
    expect(applied).not.toBeNull()
    expect(applied).not.toHaveProperty('basedOn')
  })

  it('nothing selected, or something that no longer exists, is no template', async () => {
    expect(await resolveAppliedTemplate(null)).toBeNull()
    expect(await resolveAppliedTemplate(remembered('builtin', 'not-in-this-version'))).toBeNull()
    expect(await resolveAppliedTemplate(remembered('saved', 'Gone'))).toBeNull()
    expect(
      await resolveAppliedTemplate(remembered('saved', 'Gone'), async () => ({ ok: false })),
    ).toBeNull()
    expect(
      await resolveAppliedTemplate(remembered('saved', 'Broken'), async () => {
        throw new Error('unreadable')
      }),
    ).toBeNull()
  })

  it('one more request: appended, restated ones moved last, the oldest dropped beyond the cap', () => {
    expect(withAddedRequest(['a'], ' b\n c ')).toEqual(['a', 'b c'])
    expect(withAddedRequest(['a', 'b'], 'A')).toEqual(['b', 'A'])
    expect(withAddedRequest(['a'], '   ')).toEqual(['a'])
    const long = 'x'.repeat(TEMPLATE_ADJUSTMENTS_MAX_CHARS - 1)
    expect(withAddedRequest(['a', 'b'], long)).toEqual(['b', long])
    expect(withAddedRequest(['a', 'bb'], long)).toEqual([long])
    expect(withAddedRequest([], long + 'yy')).toEqual([long + 'y'])
  })

  it('the style text alone when there are no requests', () => {
    expect(styleWithRequests('STYLE', [])).toBe('STYLE')
  })

  it('requests follow the style text as a separate block that says who wins', () => {
    const text = styleWithRequests('STYLE', ['mostly blue', 'serif titles'])
    expect(text.startsWith('STYLE\n\n## Requests the user added')).toBe(true)
    expect(text).toContain('the request wins')
    expect(text).toContain('the later one wins')
    expect(text).toContain('keep its fonts and its layouts')
    expect(text.endsWith('1. mostly blue\n2. serif titles')).toBe(true)
  })
})
