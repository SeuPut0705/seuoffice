import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  USER_SKILLS_BRIDGE_KEY,
  USER_SKILLS_CHANNELS,
  cardSaveInputOf,
  installRequestOf,
  saveInputOf,
  skillIdOf,
  skillViewsOf,
  skillsResultOf,
  statePatchOf,
} from '../src/user-skills-channels'
import { userSkillsBridge } from '../src/user-skills-bridge'

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}))

beforeEach(() => {
  electronMocks.invoke.mockReset()
  electronMocks.on.mockReset()
  electronMocks.removeListener.mockReset()
})

describe('user skills channels', () => {
  it('shares one bridge name and prefixes every channel with skills:', () => {
    expect(USER_SKILLS_BRIDGE_KEY).toBe('aiOfficeUserSkills')
    const names = Object.values(USER_SKILLS_CHANNELS)
    expect(names.every((name) => name.startsWith('skills:'))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it('takes identifiers that are short text with a colon', () => {
    expect(skillIdOf('app:notes')).toBe('app:notes')
    expect(skillIdOf('notes')).toBeUndefined()
    expect(skillIdOf(3)).toBeUndefined()
    expect(skillIdOf(`app:${'x'.repeat(600)}`)).toBeUndefined()
  })

  it('keeps only on/off and when-used in a state change', () => {
    expect(statePatchOf({ enabled: false, invoke: 'manual', extra: 1 })).toEqual({
      enabled: false,
      invoke: 'manual',
    })
    expect(statePatchOf({ invoke: 'sometimes' })).toBeUndefined()
    expect(statePatchOf(null)).toBeUndefined()
  })

  it('reads a settings save and refuses missing text', () => {
    expect(saveInputOf({ title: 'T', description: 'D', body: 'B' })).toEqual({
      id: undefined,
      title: 'T',
      name: undefined,
      description: 'D',
      body: 'B',
    })
    expect(saveInputOf({ title: 'T', description: 'D' })).toBeUndefined()
    expect(saveInputOf({ id: 'bad', title: 'T', description: 'D', body: 'B' })).toBeUndefined()
  })

  it('reads a card save with a template given as bytes or as a file', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      cardSaveInputOf({
        title: 'Letter',
        name: 'home-letter',
        description: 'Writes letters',
        body: 'Steps',
        invoke: 'manual',
        template: { bytes, fileName: 'form.hwpx' },
        targetId: 'builtin:x',
      }),
    ).toMatchObject({ invoke: 'manual', template: { bytes, fileName: 'form.hwpx' } })
    expect(
      cardSaveInputOf({
        title: 'L',
        name: 'l',
        description: 'd',
        body: 'b',
        template: { sourcePath: 'C:\\docs\\a.docx', fileName: 'a.docx' },
      }),
    ).toBeUndefined()
    // a template is its bytes: a path from a window is not taken
    expect(
      cardSaveInputOf({
        title: 'L',
        name: 'l',
        description: 'd',
        body: 'b',
        template: { fileName: 'a.docx' },
      }),
    ).toBeUndefined()
  })

  it('reads an install request and drops unknown collision choices', () => {
    expect(
      installRequestOf({
        token: 't',
        selected: ['a', 4, 'b'],
        onCollision: { a: 'replace', b: 'merge' },
      }),
    ).toEqual({ token: 't', selected: ['a', 'b'], onCollision: { a: 'replace' } })
    expect(installRequestOf({ selected: [] })).toBeUndefined()
  })

  it('reads answers defensively', () => {
    expect(skillViewsOf('x')).toEqual([])
    expect(skillViewsOf([{ id: 'app:a', name: 'a' }, { id: 1 }])).toHaveLength(1)
    expect(skillsResultOf(undefined)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('userSkillsBridge', () => {
  it('lists through the list channel and answers [] without a shell', async () => {
    electronMocks.invoke.mockResolvedValueOnce([{ id: 'app:a', name: 'a' }])
    await expect(userSkillsBridge().list()).resolves.toHaveLength(1)
    expect(electronMocks.invoke).toHaveBeenCalledWith(USER_SKILLS_CHANNELS.list)
    electronMocks.invoke.mockRejectedValueOnce(new Error('no handler'))
    await expect(userSkillsBridge().list()).resolves.toEqual([])
  })

  it('passes the AI reads through with their arguments', async () => {
    electronMocks.invoke.mockResolvedValue({ ok: true, text: 'hi' })
    await expect(userSkillsBridge().aiReadFile('app:a', 'refs/x.md')).resolves.toEqual({
      ok: true,
      text: 'hi',
    })
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      USER_SKILLS_CHANNELS.aiReadFile,
      'app:a',
      'refs/x.md',
    )
  })

  it('turns a failed invoke into a failure result', async () => {
    electronMocks.invoke.mockRejectedValue(new Error('no handler'))
    await expect(userSkillsBridge().remove('app:a')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    })
    await expect(userSkillsBridge().agentNotice()).resolves.toBe(false)
  })

  it('sends the install choices as one request', async () => {
    electronMocks.invoke.mockResolvedValue({ ok: true, installed: [], skipped: [] })
    await userSkillsBridge().install('tok', ['a'], { a: 'skip' })
    expect(electronMocks.invoke).toHaveBeenCalledWith(USER_SKILLS_CHANNELS.install, {
      token: 'tok',
      selected: ['a'],
      onCollision: { a: 'skip' },
    })
  })

  it('subscribes to and unsubscribes from the change broadcast', () => {
    const listener = vi.fn()
    const off = userSkillsBridge().onChanged(listener)
    const [channel, handler] = electronMocks.on.mock.calls[0]!
    expect(channel).toBe(USER_SKILLS_CHANNELS.changed)
    handler({}, 'ignored')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(USER_SKILLS_CHANNELS.changed, handler)
  })
})
