import { describe, expect, it } from 'vitest'
import {
  chipsAfterListChange,
  filterPickerSkills,
  isMadeUpSkillName,
  pickerSkillsOf,
  removeSkillTrigger,
  skillChipRefsOf,
  skillDisplayName,
  skillNameBeside,
  skillPickerKeyAction,
  skillTriggerAt,
  withSkillChip,
  SKILL_CHIPS_MAX,
  type SkillPickerItem,
} from '../src/skill-picker-model'

const end = (value: string) => value.length

describe('skillTriggerAt (when the list opens)', () => {
  it('opens on / or $ at the start of the input', () => {
    expect(skillTriggerAt('/', 1)).toEqual({ char: '/', start: 0, end: 1, query: '' })
    expect(skillTriggerAt('$회의', end('$회의'))).toEqual({
      char: '$',
      start: 0,
      end: 3,
      query: '회의',
    })
  })

  it('opens right after whitespace, also at the start of a later line', () => {
    expect(skillTriggerAt('정리해 줘 /가정', end('정리해 줘 /가정'))?.query).toBe('가정')
    expect(skillTriggerAt('first line\n/min', end('first line\n/min'))?.start).toBe(11)
    expect(skillTriggerAt('tab\t$x', end('tab\t$x'))?.char).toBe('$')
  })

  it('does not open in the middle of a word (paths, URLs, amounts)', () => {
    expect(skillTriggerAt('a/b', 3)).toBeNull()
    expect(skillTriggerAt('see https://x.org/a', end('see https://x.org/a'))).toBeNull()
    expect(skillTriggerAt('price 10$', end('price 10$'))).toBeNull()
  })

  it('closes once a space follows the trigger', () => {
    expect(skillTriggerAt('/meet ', end('/meet '))).toBeNull()
    expect(skillTriggerAt('/ ', 2)).toBeNull()
  })

  it('reads only up to the caret', () => {
    expect(skillTriggerAt('/meeting', 3)).toEqual({ char: '/', start: 0, end: 3, query: 'me' })
    expect(skillTriggerAt('/meeting', 0)).toBeNull()
  })

  it('sheets: $ opens only at the very start of the input, / everywhere', () => {
    const sheets = { dollarAtStartOnly: true }
    expect(skillTriggerAt('$', 1, sheets)?.char).toBe('$')
    expect(skillTriggerAt('sum of $A', end('sum of $A'), sheets)).toBeNull()
    expect(skillTriggerAt('=SUM( $A$1', end('=SUM( $A$1'), sheets)).toBeNull()
    expect(skillTriggerAt('sum /x', end('sum /x'), sheets)?.char).toBe('/')
    // other panels open $ after whitespace too
    expect(skillTriggerAt('sum of $A', end('sum of $A'))?.query).toBe('A')
  })

  it('never opens while an input-method composition runs', () => {
    expect(skillTriggerAt('/가', 2, { composing: true })).toBeNull()
  })

  it('ignores a caret outside the text', () => {
    expect(skillTriggerAt('/a', 5)).toBeNull()
    expect(skillTriggerAt('/a', Number.NaN)).toBeNull()
  })

  it('takes the typed trigger out and puts the caret there', () => {
    const value = 'write /min please'
    const trigger = skillTriggerAt(value, 10)!
    expect(removeSkillTrigger(value, trigger)).toEqual({ value: 'write  please', caret: 6 })
  })
})

describe('skillPickerKeyAction (keys go to the open list first)', () => {
  const open = { open: true }
  it('moves, picks and closes while open', () => {
    expect(skillPickerKeyAction({ key: 'ArrowDown', ...open })).toBe('next')
    expect(skillPickerKeyAction({ key: 'ArrowUp', ...open })).toBe('prev')
    expect(skillPickerKeyAction({ key: 'Enter', ...open })).toBe('pick')
    expect(skillPickerKeyAction({ key: 'Tab', ...open })).toBe('pick')
    expect(skillPickerKeyAction({ key: 'Escape', ...open })).toBe('close')
  })

  it('leaves every key alone while closed (Enter sends, Esc stops as before)', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) {
      expect(skillPickerKeyAction({ key, open: false })).toBeNull()
    }
  })

  it('leaves keys alone during a composition and Shift+Enter for a new line', () => {
    expect(skillPickerKeyAction({ key: 'Enter', isComposing: true, ...open })).toBeNull()
    expect(skillPickerKeyAction({ key: 'Enter', shiftKey: true, ...open })).toBeNull()
    expect(skillPickerKeyAction({ key: 'a', ...open })).toBeNull()
  })
})

const view = (over: Record<string, unknown>) => ({
  id: 'app:x',
  source: 'app',
  plugin: undefined,
  name: 'x',
  title: 'X',
  description: '',
  enabled: true,
  invoke: 'auto',
  hidden: false,
  hasScripts: false,
  template: undefined,
  templateExists: false,
  agentOnly: false,
  unreadable: undefined,
  github: undefined,
  ...over,
})

describe('pickerSkillsOf (what the list shows)', () => {
  const raw = [
    view({ id: 'app:on', name: 'on', title: '켜진 것' }),
    view({ id: 'app:manual', name: 'manual', invoke: 'manual' }),
    view({ id: 'user:off', source: 'user', name: 'off', enabled: false }),
    view({ id: 'builtin:find-skills', source: 'builtin', name: 'find-skills', agentOnly: true }),
    view({ id: 'builtin:hidden', source: 'builtin', name: 'hidden', hidden: true }),
    view({ id: 'app:broken', name: 'broken', unreadable: 'no-frontmatter' }),
    view({ id: 'user:IeumOffice', source: 'user', name: 'IeumOffice' }),
  ]

  it('lists enabled skills only, including ones used only when called', () => {
    expect(pickerSkillsOf(raw, 'ko').map((s) => s.id)).toEqual(['app:on', 'app:manual'])
  })

  it('shows agent-only skills in the agent window only', () => {
    expect(pickerSkillsOf(raw, 'ko', 'agent').map((s) => s.id)).toContain('builtin:find-skills')
    expect(pickerSkillsOf(raw, 'ko', 'panel').map((s) => s.id)).not.toContain('builtin:find-skills')
  })

  it('shows a builtin by its name, with its description in the UI language', () => {
    const [item] = pickerSkillsOf(
      [
        view({
          id: 'builtin:meeting-minutes',
          source: 'builtin',
          name: 'meeting-minutes',
          title: 'Meeting minutes',
        }),
      ],
      'en',
    )
    expect(item?.title).toBe('meeting-minutes')
    expect(item?.description).toMatch(/decisions and action items/)
    expect(item?.sourceLabel).toBe('Built-in')
  })

  it('shows a skill by the title its file carries, and by its name when it carries none', () => {
    const items = pickerSkillsOf(
      [
        view({ id: 'app:on', name: 'on', title: '켜진 것' }),
        view({ id: 'app:skill-a1b2c3', name: 'skill-a1b2c3', title: '가정통신문' }),
        view({ id: 'app:skill-d4e5f6', name: 'skill-d4e5f6', title: '' }),
        // the main process sends the name as the title of a skill that has none
        view({ id: 'app:plain', name: 'plain', title: 'plain' }),
        view({ id: 'user:theirs', source: 'user', name: 'theirs', title: '남의 스킬' }),
      ],
      'ko',
    )
    expect(items.map((i) => [i.title, i.name])).toEqual([
      ['켜진 것', 'on'],
      ['가정통신문', 'skill-a1b2c3'],
      ['skill-d4e5f6', 'skill-d4e5f6'],
      ['plain', 'plain'],
      ['남의 스킬', 'theirs'],
    ])
  })

  it('finds a titled skill by its title and by its name', () => {
    const items = pickerSkillsOf(
      [
        view({ id: 'app:home-letter', name: 'home-letter', title: '가정통신문' }),
        view({ id: 'app:minutes', name: 'minutes', title: 'minutes' }),
      ],
      'ko',
    )
    expect(filterPickerSkills(items, '가정').map((i) => i.id)).toEqual(['app:home-letter'])
    expect(filterPickerSkills(items, 'home').map((i) => i.id)).toEqual(['app:home-letter'])
  })

  it('labels the sources in plain text', () => {
    const items = pickerSkillsOf(
      [
        view({ id: 'app:a', name: 'a' }),
        view({ id: 'app:g', name: 'g', github: { repo: 'o/r' } }),
        view({ id: 'user:u', source: 'user', name: 'u' }),
        view({ id: 'plugin:pk:p', source: 'plugin', plugin: 'pk', name: 'p' }),
        view({ id: 'codex:c', source: 'codex', name: 'c' }),
        view({ id: 'project:j', source: 'project', name: 'j' }),
      ],
      'ko',
      'agent',
    )
    expect(items.map((i) => i.sourceLabel)).toEqual([
      '내 스킬',
      '내 스킬 · 깃허브',
      'Claude 스킬 폴더',
      'Claude 플러그인 · pk',
      'Codex 스킬 폴더',
      '',
    ])
  })

  it('marks a template only when its file is there', () => {
    const items = pickerSkillsOf(
      [
        view({ id: 'app:t', name: 't', template: 'assets/a.docx', templateExists: true }),
        view({ id: 'app:u', name: 'u', template: 'assets/b.docx', templateExists: false }),
      ],
      'ko',
    )
    expect(items.map((i) => i.template)).toEqual([true, false])
  })

  it('reads a malformed answer as no skills', () => {
    expect(pickerSkillsOf(null, 'ko')).toEqual([])
    expect(pickerSkillsOf([null, 3, { id: 'no-colon', name: 'x', source: 'app' }], 'ko')).toEqual(
      [],
    )
  })
})

describe('skillDisplayName', () => {
  it('shows the title the person gave, in any language, for a skill that is not builtin', () => {
    for (const source of ['app', 'user', 'plugin', 'codex', 'project', undefined]) {
      expect(skillDisplayName({ name: 'meeting-minutes', title: '회의록 정리', source })).toBe(
        '회의록 정리',
      )
    }
    expect(skillDisplayName({ name: 'skill-a1b2c3-2', title: ' 가정통신문 ', source: 'app' })).toBe(
      '가정통신문',
    )
  })

  it('shows the name of a skill without a title', () => {
    expect(skillDisplayName({ name: 'humanizer', source: 'app' })).toBe('humanizer')
    expect(skillDisplayName({ name: 'skill-a1b2c3', title: '  ', source: 'app' })).toBe(
      'skill-a1b2c3',
    )
  })

  it('shows a builtin by its name whatever title its file carries', () => {
    expect(
      skillDisplayName({ name: 'meeting-minutes', title: '회의록 정리', source: 'builtin' }),
    ).toBe('meeting-minutes')
  })
})

describe('skillNameBeside (the name a list shows beside a title)', () => {
  it('is the name a person chose, beside the title shown in its place', () => {
    expect(skillNameBeside({ name: 'home-letter', title: '가정통신문', source: 'app' })).toBe(
      'home-letter',
    )
  })

  it('leaves out a name the app made up: it says nothing to a reader', () => {
    expect(skillNameBeside({ name: 'skill-ehef0a', title: '가정통신문', source: 'app' })).toBe('')
    expect(skillNameBeside({ name: 'skill-ehef0a-2', title: '가정통신문', source: 'app' })).toBe('')
  })

  it('is nothing when the name itself is what the list shows', () => {
    expect(skillNameBeside({ name: 'home-letter', title: '', source: 'app' })).toBe('')
    expect(skillNameBeside({ name: 'home-letter', title: 'home-letter', source: 'app' })).toBe('')
    // a made-up name with no title is still the only thing to call the skill by
    expect(skillDisplayName({ name: 'skill-ehef0a', title: '', source: 'app' })).toBe(
      'skill-ehef0a',
    )
    expect(skillNameBeside({ name: 'meeting-minutes', title: '회의록', source: 'builtin' })).toBe(
      '',
    )
  })
})

describe('isMadeUpSkillName', () => {
  it('knows the names the app makes up, and not names that only look similar', () => {
    expect(isMadeUpSkillName('skill-a1b2c3')).toBe(true)
    expect(isMadeUpSkillName('skill-a1b2c3-2')).toBe(true)
    for (const name of ['skill-notes', 'skill-a1b2c3d', 'my-skill-a1b2c3', 'minutes']) {
      expect(isMadeUpSkillName(name)).toBe(false)
    }
  })
})

const item = (id: string, title: string, description = '', name = id): SkillPickerItem => ({
  id,
  source: 'app',
  plugin: undefined,
  name,
  title,
  description,
  sourceLabel: '내 스킬',
  hasScripts: false,
  template: false,
})

describe('filterPickerSkills', () => {
  const items = [
    item('app:a', '회의록 정리', '회의 메모를 정리합니다', 'minutes'),
    item('app:b', '가정통신문', '학부모 안내문', 'letter'),
    item('app:c', 'Copy editing', 'Tighter English', 'copy-editing'),
  ]

  it('finds a part of a Korean title', () => {
    expect(filterPickerSkills(items, '가정').map((i) => i.id)).toEqual(['app:b'])
    expect(filterPickerSkills(items, '통신').map((i) => i.id)).toEqual(['app:b'])
  })

  it('finds by name and description, ignoring case', () => {
    expect(filterPickerSkills(items, 'MINUTES').map((i) => i.id)).toEqual(['app:a'])
    expect(filterPickerSkills(items, 'english').map((i) => i.id)).toEqual(['app:c'])
  })

  it('puts title and name matches before description matches', () => {
    const list = [item('app:d', 'Plain', 'about copy'), item('app:e', 'Copy rules')]
    expect(filterPickerSkills(list, 'copy').map((i) => i.id)).toEqual(['app:e', 'app:d'])
  })

  it('returns everything for an empty query and nothing when nothing matches', () => {
    expect(filterPickerSkills(items, '')).toHaveLength(3)
    expect(filterPickerSkills(items, 'zzz')).toEqual([])
  })
})

describe('chips', () => {
  const a = { id: 'app:a', source: 'app', title: 'A' }
  it('keeps one chip per skill', () => {
    const once = withSkillChip([], a)
    expect(withSkillChip(once, a)).toHaveLength(1)
    expect(withSkillChip(once, { ...a, id: 'user:a' })).toHaveLength(2)
  })

  it('drops a chip whose skill was turned off or removed', () => {
    const chips = [a, { id: 'app:b', source: 'app', title: 'B' }]
    expect(chipsAfterListChange(chips, [item('app:b', 'B2')])).toEqual([
      expect.objectContaining({ id: 'app:b', title: 'B2', missing: false }),
    ])
  })

  it('reads stored chips back, well-formed and bounded', () => {
    const many = Array.from({ length: SKILL_CHIPS_MAX + 5 }, (_, i) => ({
      id: `app:s${i}`,
      source: 'app',
      title: `S${i}`,
    }))
    expect(skillChipRefsOf(many)).toHaveLength(SKILL_CHIPS_MAX)
    expect(skillChipRefsOf([a, a, { id: 'bad' }, null, { id: 'user:x', title: 3 }])).toEqual([
      a,
      { id: 'user:x', source: '', title: 'user:x' },
    ])
    expect(skillChipRefsOf('x')).toEqual([])
  })
})

describe('pickerSkillsOf with two enabled skills of one name', () => {
  // the main process names the winner on the one that lost (`shadowedBy`)
  const mine = view({ id: 'app:meeting-minutes', name: 'meeting-minutes', title: '' })
  const builtin = view({
    id: 'builtin:meeting-minutes',
    source: 'builtin',
    name: 'meeting-minutes',
    shadowedBy: 'app:meeting-minutes',
  })
  const ids = (
    raw: unknown[],
    surface: Parameters<typeof pickerSkillsOf>[2] = 'panel',
    editor?: Parameters<typeof pickerSkillsOf>[3],
  ) => pickerSkillsOf(raw, 'ko', surface, editor).map((s) => s.id)

  it('lists the name once: the skill that won it', () => {
    expect(ids([builtin, mine])).toEqual(['app:meeting-minutes'])
    expect(ids([builtin, mine], 'panel', 'docs')).toEqual(['app:meeting-minutes'])
    expect(ids([builtin, mine], 'agent')).toEqual(['app:meeting-minutes'])
  })

  it('lists the other again once the winner is off (nothing names a winner then)', () => {
    const off = { ...mine, enabled: false }
    expect(ids([{ ...builtin, shadowedBy: undefined }, off])).toEqual(['builtin:meeting-minutes'])
  })

  it('lists the other in an editor the winner is not used in', () => {
    const slidesOnly = { ...mine, editors: ['slides'] }
    expect(ids([builtin, slidesOnly], 'panel', 'slides')).toEqual(['app:meeting-minutes'])
    expect(ids([builtin, slidesOnly], 'panel', 'docs')).toEqual(['builtin:meeting-minutes'])
    // no editor (home ask): both are used there, so the winner alone
    expect(ids([builtin, slidesOnly])).toEqual(['app:meeting-minutes'])
  })
})

describe('pickerSkillsOf in an editor', () => {
  const raw = [
    view({ id: 'app:deck', name: 'deck', editors: ['slides'] }),
    view({ id: 'app:notes', name: 'notes' }),
  ]
  const ids = (
    surface: Parameters<typeof pickerSkillsOf>[2],
    editor?: Parameters<typeof pickerSkillsOf>[3],
  ) => pickerSkillsOf(raw, 'ko', surface, editor).map((s) => s.id)

  it('lists a slides skill in the slides panel and leaves it out of the sheets panel', () => {
    expect(ids('panel', 'slides')).toEqual(['app:deck', 'app:notes'])
    expect(ids('panel', 'sheets')).toEqual(['app:notes'])
  })

  it('lists it where no editor is given (home ask) and in the agent window', () => {
    expect(ids('panel')).toEqual(['app:deck', 'app:notes'])
    expect(ids('agent', 'sheets')).toEqual(['app:deck', 'app:notes'])
  })
})
