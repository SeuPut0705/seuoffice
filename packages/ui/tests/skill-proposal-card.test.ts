/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_EDITORS, type SkillProposal } from '@genoffice/agent-core'
import { LANGS } from '@genoffice/i18n'
import { SkillProposalCard, SkillUsedNotes } from '../src/SkillProposalCard'
import { useSkillProposals, type SkillProposals } from '../src/use-skill-proposals'
import type { SkillCardBridge, StoredToolRecord } from '../src/skill-card-model'
import { skillEditorsText } from '../src/strings-skill-editors'

const NEW: SkillProposal = {
  key: 'call-1',
  title: 'Minutes',
  name: 'minutes',
  description: 'Writes minutes in our format.',
  body: '1. Date\n2. Decisions',
  wantsTemplate: false,
  target: undefined,
}

function fakeBridge(over: Partial<SkillCardBridge> = {}) {
  const bridge = {
    suggestName: vi.fn(async (title: string) => title.toLowerCase().replace(/\s+/g, '-')),
    checkName: vi.fn(async (name: string): Promise<unknown> =>
      /^[a-z0-9-]+$/.test(name) ? { ok: true } : { ok: false, problem: 'characters' },
    ),
    saveFromCard: vi.fn(async (): Promise<unknown> => ({ ok: true, id: 'app:minutes' })),
    openSettings: vi.fn(async () => {}),
    ...over,
  }
  return bridge
}

/** wait out the name check's delay and the answers */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320))
  })
  for (let i = 0; i < 4; i += 1) await act(async () => await Promise.resolve())
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const buttons = () => [...host.querySelectorAll('button')]
const button = (label: string) => buttons().find((b) => b.textContent === label)
const inputs = () => [...host.querySelectorAll<HTMLInputElement>('input[type="text"]')]
const titleInput = () => host.querySelector<HTMLInputElement>('input[data-field="title"]')!
const nameInput = () => host.querySelector<HTMLInputElement>('input[data-field="name"]')!

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function renderCard(
  proposal: SkillProposal,
  bridge: SkillCardBridge | null,
  extra: Record<string, unknown> = {},
) {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  act(() =>
    root.render(
      createElement(SkillProposalCard, {
        lang: 'en',
        proposal,
        bridge,
        onSaved,
        onCancel,
        ...extra,
      }),
    ),
  )
  return { onSaved, onCancel }
}

describe('SkillProposalCard', () => {
  it('shows the proposal in editable fields and writes nothing before Save', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    expect(host.textContent).toContain('New skill')
    // the title comes first, then the name; both always shown (no Advanced section)
    expect(inputs()).toEqual([titleInput(), nameInput()])
    expect(titleInput().value).toBe('Minutes')
    expect(nameInput().value).toBe('minutes')
    expect(host.querySelector('details')).toBeNull()
    expect(host.textContent).toContain('Shown in lists, in any language')
    expect(host.textContent).toContain('Shown in the skill list')
    expect(host.querySelectorAll('textarea')[1]!.value).toBe('1. Date\n2. Decisions')
    expect(bridge.saveFromCard).not.toHaveBeenCalled()
    expect(button('Save')!.disabled).toBe(false)
    // no template box where the document cannot be a template
    expect(host.textContent).not.toContain('Save this document along as a template')
  })

  it('saves the edited fields with when the skill is used', async () => {
    const bridge = fakeBridge()
    const { onSaved } = renderCard(NEW, bridge)
    await settle()
    act(() => setValue(nameInput(), 'team-minutes'))
    await settle()
    const manual = host.querySelector<HTMLInputElement>('input[value="manual"]')!
    act(() => manual.click())
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith({
      title: 'Minutes',
      name: 'team-minutes',
      description: 'Writes minutes in our format.',
      body: '1. Date\n2. Decisions',
      invoke: 'manual',
      editors: 'all',
    })
    expect(onSaved).toHaveBeenCalledWith(
      'app:minutes',
      expect.objectContaining({ invoke: 'manual' }),
    )
  })

  it('blocks Save with the reason when the name breaks the rule', async () => {
    const bridge = fakeBridge()
    renderCard({ ...NEW, name: 'Bad Name' }, bridge)
    await settle()
    expect(button('Save')!.disabled).toBe(true)
    expect(host.textContent).toContain(
      'The name can use only lowercase English letters, digits and hyphens (-)',
    )
    act(() => setValue(nameInput(), 'good-name'))
    await settle()
    expect(button('Save')!.disabled).toBe(false)
  })

  it('points to the title field when the name is typed in another script', async () => {
    renderCard(NEW, fakeBridge())
    await settle()
    act(() => setValue(nameInput(), '회의록'))
    await settle()
    expect(button('Save')!.disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'A title in your own language goes in the Title field above',
    )
  })

  it('saves the title the person typed, and none when they emptied it', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    act(() => setValue(titleInput(), '회의록 정리'))
    await settle()
    // the model gave a name: a new title leaves it alone
    expect(nameInput().value).toBe('minutes')
    expect(bridge.suggestName).not.toHaveBeenCalled()
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '회의록 정리', name: 'minutes' }),
    )

    act(() => setValue(titleInput(), '  '))
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '', name: 'minutes' }),
    )
  })

  it('fills the name from the title until the person types a name', async () => {
    const madeUp = ['skill-a1b2c3', 'skill-d4e5f6', 'skill-g7h8i9']
    const bridge = fakeBridge({
      // the shell's rule: a slug of the Latin letters and digits, else a made-up name
      suggestName: vi.fn(async (title: string) => {
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
        return slug || madeUp.shift()!
      }),
    })
    renderCard({ ...NEW, title: '', name: '' }, bridge)
    await settle()
    expect(nameInput().value).toBe('')

    act(() => setValue(titleInput(), 'Weekly report'))
    await settle()
    expect(nameInput().value).toBe('weekly-report')

    // a title no name can be made from: a made-up name, and the same one as typing goes on
    act(() => setValue(titleInput(), '주간'))
    await settle()
    expect(nameInput().value).toBe('skill-a1b2c3')
    act(() => setValue(titleInput(), '주간 보고'))
    await settle()
    expect(nameInput().value).toBe('skill-a1b2c3')

    // the person's own name stays whatever the title becomes
    act(() => setValue(nameInput(), 'weekly'))
    await settle()
    act(() => setValue(titleInput(), 'Another title'))
    await settle()
    expect(nameInput().value).toBe('weekly')
  })

  it('starts a change of my own skill with the title it has', async () => {
    const target = { id: 'app:minutes', name: 'minutes', owned: true, source: 'app' }
    renderCard(
      { ...NEW, title: '', name: '', target: { ...target, title: '회의록 정리' } },
      fakeBridge(),
    )
    await settle()
    expect(titleInput().value).toBe('회의록 정리')
    expect(nameInput().value).toBe('minutes')
    act(() => root.unmount())
    root = createRoot(host)

    // a skill without a title is listed by its name: the title field starts empty
    renderCard(
      { ...NEW, title: '', name: '', target: { ...target, title: 'minutes' } },
      fakeBridge(),
    )
    await settle()
    expect(titleInput().value).toBe('')
  })

  it('asks before saving under a name another enabled skill has, then turns that one off', async () => {
    const saveFromCard = vi
      .fn<(input: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, reason: 'same-name-on', problem: 'builtin,plugin:pk' })
      .mockResolvedValue({ ok: true, id: 'app:minutes' })
    const bridge = fakeBridge({ saveFromCard })
    const { onSaved } = renderCard(NEW, bridge)
    await settle()
    await act(async () => button('Save')!.click())
    await settle()
    expect(onSaved).not.toHaveBeenCalled()
    expect(saveFromCard.mock.calls[0]![0]).not.toHaveProperty('turnOffSameName')
    const question = host.querySelector('[data-skill-card-same-name]')!
    expect(question.textContent).toContain('A skill of the same name is on')
    expect(question.textContent).toContain('Built-in')
    expect(question.textContent).toContain('pk')
    expect(question.textContent).toContain('that one is turned off')

    await act(async () => button('Save and turn that one off')!.click())
    await settle()
    expect(saveFromCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'minutes', turnOffSameName: true }),
    )
    expect(onSaved).toHaveBeenCalledWith('app:minutes', expect.anything())
  })

  it('withdraws that question when the name changes', async () => {
    const saveFromCard = vi
      .fn<(input: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, reason: 'same-name-on', problem: 'builtin' })
      .mockResolvedValue({ ok: true, id: 'app:my-minutes' })
    renderCard(NEW, fakeBridge({ saveFromCard }))
    await settle()
    await act(async () => button('Save')!.click())
    await settle()
    expect(host.querySelector('[data-skill-card-same-name]')).not.toBeNull()
    act(() => setValue(nameInput(), 'my-minutes'))
    await settle()
    expect(host.querySelector('[data-skill-card-same-name]')).toBeNull()
    await act(async () => button('Save')!.click())
    await settle()
    expect(saveFromCard.mock.calls[1]![0]).not.toHaveProperty('turnOffSameName')
  })

  it('blocks Save on an empty body', async () => {
    renderCard({ ...NEW, body: '   ' }, fakeBridge())
    await settle()
    expect(button('Save')!.disabled).toBe(true)
    expect(host.textContent).toContain('Enter the instructions')
  })

  it('saves a proposal that has a name but no title', async () => {
    const bridge = fakeBridge()
    renderCard({ ...NEW, title: '' }, bridge)
    await settle()
    expect(bridge.suggestName).not.toHaveBeenCalled()
    expect(button('Save')!.disabled).toBe(false)
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({ title: '', name: 'minutes' }),
    )
  })

  it('suggests a name from the title when the model gave none', async () => {
    const bridge = fakeBridge()
    renderCard({ ...NEW, name: '' }, bridge)
    await settle()
    expect(bridge.suggestName).toHaveBeenCalledWith('Minutes')
    expect(nameInput().value).toBe('minutes')
  })

  it('changes my own skill with Replace', async () => {
    const bridge = fakeBridge()
    renderCard(
      {
        ...NEW,
        name: '',
        target: {
          id: 'app:minutes',
          name: 'minutes',
          title: 'Minutes',
          owned: true,
          source: 'app',
        },
      },
      bridge,
    )
    await settle()
    expect(host.textContent).toContain('Change skill')
    expect(bridge.checkName).toHaveBeenCalledWith('minutes', 'app:minutes')
    await act(async () => button('Replace')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'app:minutes', name: 'minutes' }),
    )
    expect(bridge.saveFromCard.mock.calls[0]![0]).not.toHaveProperty('overwrite')
  })

  it('copies another source’s skill into mine, replacing my skill of that name', async () => {
    const bridge = fakeBridge({
      checkName: vi.fn(async () => ({ ok: false, problem: 'taken' })),
    })
    renderCard(
      {
        ...NEW,
        name: '',
        target: {
          id: 'builtin:meeting-notes',
          name: 'meeting-notes',
          title: 'Meeting notes',
          owned: false,
          source: 'builtin',
        },
      },
      bridge,
    )
    await settle()
    expect(host.textContent).toContain(
      'A copy is saved to my skills, and the original skill is turned off',
    )
    expect(host.textContent).toContain('saving replaces it')
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'builtin:meeting-notes',
        name: 'meeting-notes',
        overwrite: true,
      }),
    )
  })

  it('shows the shell’s refusal and keeps the card open', async () => {
    const bridge = fakeBridge({
      saveFromCard: vi.fn(async () => ({ ok: false, reason: 'name-taken' })),
    })
    const { onSaved } = renderCard(NEW, bridge)
    await settle()
    await act(async () => button('Save')!.click())
    await settle()
    expect(onSaved).not.toHaveBeenCalled()
    expect(host.textContent).toContain('My skills already have a skill with this name')
  })

  it('cannot save in a window without the skills bridge', async () => {
    renderCard(NEW, null)
    await settle()
    expect(button('Save')!.disabled).toBe(true)
    expect(host.textContent).toContain('Skills cannot be saved in this window')
  })

  it('offers the template box where the document can be a template, and its two slots', async () => {
    const renderTemplateActions = vi.fn(() => createElement('span', null, 'template-slot'))
    renderCard({ ...NEW, wantsTemplate: true }, fakeBridge(), {
      canBeTemplate: true,
      renderTemplateActions,
    })
    await settle()
    expect(host.textContent).toContain('Save this document along as a template')
    expect(host.textContent).toContain('template-slot')
    expect(button('Save')).toBeUndefined()
    expect(renderTemplateActions).toHaveBeenLastCalledWith(
      expect.objectContaining({ blocked: null, busy: false, save: expect.any(Function) }),
    )
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => box.click())
    expect(button('Save')).toBeDefined()
  })

  it('shows the two template buttons, inactive, when no slot is given', async () => {
    renderCard({ ...NEW, wantsTemplate: true }, fakeBridge(), { canBeTemplate: true })
    await settle()
    expect(button('Make a blank template')!.disabled).toBe(true)
    expect(button('Save the document as it is')!.disabled).toBe(true)
  })
})

describe('SkillUsedNotes', () => {
  it('shows a line for each skill the turn used, not for failed or other tools', () => {
    act(() =>
      root.render(
        createElement(SkillUsedNotes, {
          tools: [
            { name: 'use_skill', summary: '회의록 정리 스킬을 썼습니다' },
            { name: 'use_skill', summary: 'refused', isError: true },
            { name: 'use_skill', summary: 'use skill', running: true },
            { name: 'read_skill_file', summary: 'notes.md' },
          ],
        }),
      ),
    )
    const notes = [...host.querySelectorAll('.ai-skill-used-note')].map((n) => n.textContent)
    expect(notes).toEqual(['회의록 정리 스킬을 썼습니다'])
  })
})

describe('useSkillProposals', () => {
  let handles: SkillProposals
  let persisted: StoredToolRecord[]

  function Panel({ bridge, keys }: { bridge: SkillCardBridge; keys: string[] }): ReactNode {
    handles = useSkillProposals({
      lang: 'ko',
      bridge,
      persistSaved: (record) => persisted.push(record),
    })
    return createElement(
      'div',
      null,
      keys.map((key) => createElement('div', { key }, handles.render(key))),
    )
  }

  beforeEach(() => {
    persisted = []
  })

  it('opens a card, and a cancel leaves it as an unsaved proposal', async () => {
    const bridge = fakeBridge()
    act(() => root.render(createElement(Panel, { bridge, keys: ['call-1'] })))
    act(() => handles.add(NEW))
    await settle()
    expect(host.textContent).toContain('스킬 만들기')
    act(() => button('취소')!.click())
    // the closed card names the proposal by its title
    expect(host.textContent).toContain('저장하지 않은 스킬 제안 · Minutes')
    expect(bridge.saveFromCard).not.toHaveBeenCalled()
    expect(persisted).toEqual([])
  })

  it('a save shows "saved · view in settings" and stores the saved record', async () => {
    const bridge = fakeBridge()
    act(() => root.render(createElement(Panel, { bridge, keys: ['call-1'] })))
    act(() => handles.add(NEW))
    await settle()
    await act(async () => button('저장')!.click())
    await settle()
    expect(host.textContent).toContain('저장했습니다 · Minutes')
    expect(persisted).toEqual([
      { name: 'propose_skill', summary: 'Minutes', output: 'skill-card-saved:app:minutes' },
    ])
    act(() => button('설정에서 보기')!.click())
    expect(bridge.openSettings).toHaveBeenCalled()
  })

  it('names a card by the name when the proposal gave no title', async () => {
    const bridge = fakeBridge()
    act(() => root.render(createElement(Panel, { bridge, keys: ['call-1'] })))
    act(() => handles.add({ ...NEW, title: '' }))
    await settle()
    act(() => button('취소')!.click())
    expect(host.textContent).toContain('저장하지 않은 스킬 제안 · minutes')
  })

  it('reads a stored conversation back with closed cards and without saved records', () => {
    const bridge = fakeBridge()
    act(() => root.render(createElement(Panel, { bridge, keys: [] })))
    let restored: Array<{ skillProposals?: string[] }> = []
    act(() => {
      restored = handles.restore([
        { role: 'user', text: 'make it a skill' },
        {
          role: 'assistant',
          text: 'card',
          tools: [
            {
              name: 'propose_skill',
              summary: 's',
              input: JSON.stringify({ title: 'Minutes', description: 'd', body: 'b' }),
            },
          ],
        },
      ])
    })
    const keys = restored.flatMap((m) => m.skillProposals ?? [])
    expect(keys).toHaveLength(1)
    act(() => root.render(createElement(Panel, { bridge, keys })))
    expect(host.textContent).toContain('저장하지 않은 스킬 제안 · Minutes')
    expect(host.querySelector('textarea')).toBeNull()
  })
})

describe('SkillProposalCard: where the skill is used', () => {
  const checkbox = (editor: string) =>
    host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${editor}"]`)
  const radio = (label: string) =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent === label)!
      .querySelector<HTMLInputElement>('input')!

  it('starts at every editor when the model named none', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    expect(radio('Every editor').checked).toBe(true)
    expect(checkbox('slides')).toBeNull()
  })

  it('starts at the editors the model named and saves the person’s change', async () => {
    const bridge = fakeBridge()
    renderCard({ ...NEW, editors: ['slides'] }, bridge)
    await settle()
    expect(radio('Only these editors').checked).toBe(true)
    expect(checkbox('slides')!.checked).toBe(true)
    expect(checkbox('sheets')!.checked).toBe(false)
    act(() => checkbox('sheets')!.click())
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({ editors: ['sheets', 'slides'] }),
    )
  })

  it('starts with no editor checked when the person goes from every editor to only some', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    act(() => radio('Only these editors').click())
    const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes().length).toBeGreaterThan(5)
    expect(boxes().some((box) => box.checked)).toBe(false)
    // nothing to save yet, and the chooser says what is missing
    expect(button('Save')!.disabled).toBe(true)
    expect(host.textContent).toContain('Choose at least one editor')
    // the usual wish, one editor, is one click
    act(() => checkbox('slides')!.click())
    await act(async () => button('Save')!.click())
    await settle()
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({ editors: ['slides'] }),
    )
  })

  it('checks every editor or none with the two small buttons', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    act(() => radio('Only these editors').click())
    const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]

    act(() => button('Check all')!.click())
    expect(boxes().every((box) => box.checked)).toBe(true)
    expect(button('Check all')!.disabled).toBe(true)
    // leaving one out of all of them is one more click
    act(() => checkbox('pdf')!.click())
    expect(
      boxes()
        .filter((box) => !box.checked)
        .map((box) => box.value),
    ).toEqual(['pdf'])

    act(() => button('Clear all')!.click())
    expect(boxes().some((box) => box.checked)).toBe(false)
    expect(button('Clear all')!.disabled).toBe(true)
    expect(button('Save')!.disabled).toBe(true)
  })

  it('saves with every editor checked', async () => {
    const bridge = fakeBridge()
    renderCard(NEW, bridge)
    await settle()
    act(() => radio('Only these editors').click())
    act(() => button('Check all')!.click())
    await act(async () => button('Save')!.click())
    await settle()
    // the main process writes a full list as "every editor" (user-skills-editors.test.ts)
    expect(bridge.saveFromCard).toHaveBeenCalledWith(
      expect.objectContaining({ editors: [...SKILL_EDITORS] }),
    )
  })

  it('has the two buttons in every language, as translations', () => {
    for (const lang of LANGS) {
      const words = [skillEditorsText(lang, 'checkAll'), skillEditorsText(lang, 'clearAll')]
      expect(words[0], lang).not.toBe(words[1])
      for (const word of words) expect(word.trim(), lang).not.toBe('')
      if (lang !== 'en') expect(words, lang).not.toEqual(['Check all', 'Clear all'])
    }
  })

  it('does not save while no editor is checked', async () => {
    const bridge = fakeBridge()
    renderCard({ ...NEW, editors: ['slides'] }, bridge)
    await settle()
    act(() => checkbox('slides')!.click())
    expect(button('Save')!.disabled).toBe(true)
    expect(host.textContent).toContain('Choose at least one editor')
    act(() => radio('Every editor').click())
    expect(button('Save')!.disabled).toBe(false)
  })
})
