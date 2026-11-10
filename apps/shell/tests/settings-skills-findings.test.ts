/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { skillEditorsText } from '@genoffice/ui'
import type {
  UserSkillImportCandidateView,
  UserSkillImportPreview,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import type { HomeApi } from '../src/shared/home-api'
import { DropToOpenOverlay } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SkillsPane } from '../src/renderer/src/skills/SkillsPane'
import { skillsText, type SkillsStringKey } from '../src/renderer/src/i18n/strings-skills'

/**
 * What a first-time user ran into in Settings → Skills (decision 0127): text
 * typed into the editor lost by a stray close, a row menu cut off at the
 * bottom, a preview that could not be read, an Install button off without a
 * reason, a dropped zip that did nothing, and a drop overlay that named only
 * documents.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const ko = (key: SkillsStringKey, params?: Record<string, string | number>) =>
  skillsText('ko', key, params)

let host: HTMLDivElement
let root: Root

const mine: UserSkillView = {
  id: 'app:home-letter',
  source: 'app',
  plugin: undefined,
  name: 'home-letter',
  title: 'home-letter',
  description: '학교 말투',
  enabled: true,
  invoke: 'auto',
  hidden: false,
  hasScripts: false,
  mcpServers: [],
  template: undefined,
  templateExists: false,
  agentOnly: false,
  unreadable: undefined,
  files: 1,
  bytes: 100,
  github: undefined,
  owned: true,
  can: {
    edit: true,
    copyToMine: false,
    export: true,
    checkUpdate: false,
    openFolder: true,
    remove: true,
    hide: false,
  },
  shadowedBy: undefined,
}

function candidate(
  partial: Partial<UserSkillImportCandidateView> & { key: string },
): UserSkillImportCandidateView {
  return {
    key: partial.key,
    rel: partial.key,
    name: partial.key,
    title: partial.key,
    description: `${partial.key} description`,
    files: 2,
    bytes: 2048,
    hasScripts: false,
    hasTemplate: false,
    urls: [],
    urlCount: 0,
    license: undefined,
    warnings: [],
    warningCount: 0,
    collision: false,
    emptyBody: false,
    problem: undefined,
    ...partial,
  }
}

function previewOf(candidates: UserSkillImportCandidateView[]): UserSkillImportPreview {
  return { token: 'tok-1', origin: { kind: 'zip' }, candidates, rootLicense: undefined }
}

function bridge(overrides: Record<string, unknown> = {}) {
  const dropped: Array<() => void> = []
  const api = {
    list: vi.fn(async () => [mine]),
    read: vi.fn(async (id: string) => ({
      ok: true,
      skill: {
        id,
        name: 'home-letter',
        title: 'home-letter',
        description: '학교 말투',
        body: '# 본문',
        template: undefined,
        files: [{ rel: 'SKILL.md', size: 10 }],
      },
    })),
    setState: vi.fn(async () => ({ ok: true })),
    checkName: vi.fn(async () => ({ ok: true })),
    save: vi.fn(async () => ({ ok: true, id: 'app:new-skill' })),
    importZip: vi.fn(async () => ({ ok: false, reason: 'no-skills' })),
    takeDropped: vi.fn(async () => ({ ok: true, preview: null })),
    cancelImport: vi.fn(async () => {}),
    install: vi.fn(async () => ({ ok: true, installed: [], skipped: [] })),
    readImport: vi.fn(async () => ({
      ok: true,
      content: {
        body: { text: 'Make the deck tidy.\n', truncated: false },
        files: [{ rel: 'reference/colors.md', size: 9 }],
      },
    })),
    readImportFile: vi.fn(async () => ({
      ok: true,
      file: { text: '# Colors\n', truncated: true },
    })),
    openFolder: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => undefined),
    onDropped: vi.fn((listener: () => void) => {
      dropped.push(listener)
      return () => undefined
    }),
    ...overrides,
  }
  return Object.assign(api, { fireDropped: () => dropped.forEach((listener) => listener()) })
}

type Bridge = ReturnType<typeof bridge>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.aiOffice = { openHelp: vi.fn(async () => {}) } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { aiOfficeUserSkills?: unknown }).aiOfficeUserSkills
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
    await Promise.resolve()
  })
  await flush()
}

function buttonWithText(text: string, scope: ParentNode = document.body) {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
}

async function renderPane(api: Bridge): Promise<void> {
  ;(window as unknown as { aiOfficeUserSkills?: unknown }).aiOfficeUserSkills = api
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: 'ko' }, createElement(SkillsPane)))
    await Promise.resolve()
  })
  await flush()
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

async function type(el: Element | null, value: string): Promise<void> {
  expect(el).toBeTruthy()
  const input = el as HTMLInputElement | HTMLTextAreaElement
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()
  })
  await flush()
}

async function clickOutside(): Promise<void> {
  const overlay = document.querySelector('.skl-overlay')
  expect(overlay).toBeTruthy()
  await act(async () => {
    overlay!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await Promise.resolve()
  })
  await flush()
}

describe('closing the skill editor by Escape, a click outside or Cancel', () => {
  async function openNew(api: Bridge) {
    await renderPane(api)
    await click(buttonWithText(ko('create')))
    expect(dialog()).toBeTruthy()
  }

  it('closes at once when nothing was typed', async () => {
    await openNew(bridge())
    await pressEscape()
    expect(dialog()).toBeNull()

    await click(buttonWithText(ko('create')))
    await clickOutside()
    expect(dialog()).toBeNull()
  })

  it('asks first when something was typed, and keeps the text when the person stays', async () => {
    await openNew(bridge())
    const body = dialog()!.querySelectorAll('textarea')[1]!
    await type(body, '회의록을 이렇게 정리한다')

    await pressEscape()
    expect(dialog()).toBeTruthy()
    expect(dialog()!.textContent).toContain(ko('discardAsk'))
    // a second Escape or a click outside while the question shows closes nothing
    await pressEscape()
    await clickOutside()
    expect(dialog()).toBeTruthy()

    await click(buttonWithText(ko('discardKeep'), dialog()!))
    expect(dialog()!.textContent).not.toContain(ko('discardAsk'))
    expect(dialog()!.querySelectorAll('textarea')[1]!.value).toBe('회의록을 이렇게 정리한다')

    await clickOutside()
    await click(buttonWithText(ko('discardClose'), dialog()!))
    expect(dialog()).toBeNull()
  })

  it('asks for a changed own skill but not for one only looked at', async () => {
    const api = bridge()
    await renderPane(api)
    const more = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"].skl-more')
    await click(more)
    await click(buttonWithText(ko('actEdit')))
    await pressEscape()
    expect(dialog()).toBeNull()

    await click(more)
    await click(buttonWithText(ko('actEdit')))
    await type(dialog()!.querySelector('textarea'), '바꾼 설명')
    await pressEscape()
    expect(dialog()!.textContent).toContain(ko('discardAsk'))
    // Cancel asks the same question: it sits beside Save and is easy to hit
    await click(buttonWithText(ko('discardKeep'), dialog()!))
    await click(buttonWithText(ko('cancel'), dialog()!))
    expect(dialog()!.textContent).toContain(ko('discardAsk'))
    expect(dialog()!.querySelector('textarea')!.value).toBe('바꾼 설명')
    await click(buttonWithText(ko('discardClose'), dialog()!))
    expect(dialog()).toBeNull()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('lets Cancel close at once when nothing was typed, and ask when something was', async () => {
    await openNew(bridge())
    await click(buttonWithText(ko('cancel'), dialog()!))
    expect(dialog()).toBeNull()

    await click(buttonWithText(ko('create')))
    const body = dialog()!.querySelectorAll('textarea')[1]!
    await type(body, '회의록을 이렇게 정리한다')
    await click(buttonWithText(ko('cancel'), dialog()!))
    expect(dialog()!.textContent).toContain(ko('discardAsk'))
    await click(buttonWithText(ko('discardKeep'), dialog()!))
    expect(dialog()!.querySelectorAll('textarea')[1]!.value).toBe('회의록을 이렇게 정리한다')
  })
})

describe('the row menu near the bottom of the window', () => {
  const VIEW = { width: 1000, height: 600 }
  const MENU = { width: 180, height: 200 }

  function fakeLayout(button: { top: number; bottom: number }) {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(VIEW.width)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(VIEW.height)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('skl-menu') ? MENU.width : 28
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('skl-menu') ? MENU.height : 28
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      ...button,
      left: 900,
      right: 928,
      width: 28,
      height: 28,
      x: 900,
      y: button.top,
      toJSON: () => ({}),
    }))
  }

  async function menuTop(button: { top: number; bottom: number }): Promise<number> {
    fakeLayout(button)
    await renderPane(bridge())
    await click(host.querySelector('button[aria-haspopup="menu"].skl-more'))
    const menu = document.querySelector<HTMLElement>('.skl-menu')
    expect(menu).toBeTruthy()
    // right-aligned under its button and inside the window on both sides
    expect(parseFloat(menu!.style.left)).toBe(928 - MENU.width)
    return parseFloat(menu!.style.top)
  }

  it('opens under the button when there is room', async () => {
    expect(await menuTop({ top: 100, bottom: 128 })).toBe(132)
  })

  it('opens above the button when it would run past the bottom, with every item in view', async () => {
    const top = await menuTop({ top: 560, bottom: 588 })
    expect(top).toBe(560 - 4 - MENU.height)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top + MENU.height).toBeLessThanOrEqual(VIEW.height)
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)
    expect(items).toEqual([
      ko('actView'),
      ko('actEdit'),
      skillEditorsText('ko', 'label'),
      ko('actExport'),
      ko('actOpenFolder'),
      ko('actRemove'),
    ])
  })
})

describe('reading a skill in the preview before installing', () => {
  async function openPreview(api: Bridge, candidates: UserSkillImportCandidateView[]) {
    api.takeDropped.mockResolvedValueOnce({ ok: true, preview: previewOf(candidates) } as never)
    await renderPane(api)
    expect(dialog()).toBeTruthy()
    return dialog()!
  }

  it('shows the name once', async () => {
    const box = await openPreview(bridge(), [candidate({ key: 'deck-polish' })])
    const head = box.querySelector('.skl-candidate .skl-row-head')!
    expect(head.textContent).toBe('deck-polish')
  })

  it('still shows the name a person chose beside a title that differs from it', async () => {
    const box = await openPreview(bridge(), [
      candidate({ key: 'home-letter', title: '가정통신문' }),
    ])
    const head = box.querySelector('.skl-candidate .skl-row-head')!
    expect(head.textContent).toBe('가정통신문home-letter')
  })

  it('leaves out a name the app made up: the title alone says what the skill is', async () => {
    const box = await openPreview(bridge(), [
      candidate({ key: 'skill-a8k2p1', title: '가정통신문' }),
    ])
    const head = box.querySelector('.skl-candidate .skl-row-head')!
    expect(head.textContent).toBe('가정통신문')
  })

  it('opens the SKILL.md body and a text file as read-only text, and says when there is more', async () => {
    const api = bridge()
    const box = await openPreview(api, [candidate({ key: 'deck-polish' })])
    expect(api.readImport).not.toHaveBeenCalled()

    await click(buttonWithText(ko('actView'), box))
    expect(api.readImport).toHaveBeenCalledWith('tok-1', 'deck-polish')
    const body = box.querySelector('.skl-read-text')!
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toBe('Make the deck tidy.\n')
    expect(box.textContent).not.toContain(ko('previewTruncated', { n: '20,000' }))

    await click([...box.querySelectorAll('.skl-files button')][0])
    expect(api.readImportFile).toHaveBeenCalledWith('tok-1', 'deck-polish', 'reference/colors.md')
    const file = box.querySelector('[data-file="reference/colors.md"]')!
    expect(file.querySelector('.skl-read-text')!.textContent).toBe('# Colors\n')
    expect(file.textContent).toContain(ko('previewTruncated', { n: '20,000' }))

    // looking installs nothing, and closing the text keeps what was read
    expect(api.install).not.toHaveBeenCalled()
    await click(buttonWithText(ko('close'), box.querySelector('.skl-read')!))
    expect(box.querySelector('.skl-read-text')).toBeNull()
    await click(buttonWithText(ko('actView'), box))
    expect(api.readImport).toHaveBeenCalledTimes(1)
  })

  it('shows skill text as text, never as markup', async () => {
    const api = bridge({
      readImport: vi.fn(async () => ({
        ok: true,
        content: { body: { text: '<img src=x onerror=alert(1)>', truncated: false }, files: [] },
      })),
    })
    const box = await openPreview(api, [candidate({ key: 'odd' })])
    await click(buttonWithText(ko('actView'), box))
    expect(box.querySelector('.skl-read-text')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(box.querySelector('img')).toBeNull()
  })

  it('marks a skill whose body is empty and still lets it be installed', async () => {
    const api = bridge({
      readImport: vi.fn(async () => ({
        ok: true,
        content: { body: { text: '', truncated: false }, files: [] },
      })),
    })
    const box = await openPreview(api, [candidate({ key: 'head-only', emptyBody: true })])
    expect(box.querySelector('.skl-candidate [data-empty-body]')!.textContent).toBe(
      ko('previewBodyEmpty'),
    )
    await click(buttonWithText(ko('actView'), box))
    expect(box.querySelector('.skl-read-box')!.textContent).toContain(ko('previewBodyEmpty'))
    const installButton = buttonWithText(ko('install'), box)!
    expect(installButton.disabled).toBe(false)
    await click(installButton)
    expect(api.install).toHaveBeenCalledWith('tok-1', ['head-only'], {})
  })

  it('offers no reading for a skill that is too large to take', async () => {
    const box = await openPreview(bridge(), [candidate({ key: 'huge', problem: 'too-large' })])
    expect(box.querySelector('.skl-read')).toBeNull()
  })

  it('says why a file cannot be read', async () => {
    const api = bridge({ readImport: vi.fn(async () => ({ ok: false, reason: 'unreadable' })) })
    const box = await openPreview(api, [candidate({ key: 'deck' })])
    await click(buttonWithText(ko('actView'), box))
    expect(box.querySelector('.skl-read [role="alert"]')!.textContent).toBe(
      ko('unreadableUnreadable'),
    )
  })
})

describe('installing a skill whose name is already taken', () => {
  it('says beside Install what is still to choose, and that Replace keeps the settings', async () => {
    const api = bridge()
    api.takeDropped.mockResolvedValueOnce({
      ok: true,
      preview: previewOf([
        candidate({ key: 'deck-polish', collision: true }),
        candidate({ key: 'weekly-report', collision: true }),
      ]),
    } as never)
    await renderPane(api)
    const box = dialog()!
    const footer = box.querySelector('.skl-dialog-footer')!
    const installButton = buttonWithText(ko('install'), box)!

    expect(installButton.disabled).toBe(true)
    expect(footer.textContent).toContain(ko('chooseCollision'))
    expect(box.querySelector('.skl-collision')!.textContent).toContain(ko('collisionKeeps'))

    const [first, second] = [...box.querySelectorAll('.skl-collision')]
    await click(buttonWithText(ko('collisionReplace'), first!))
    // one skill still has no answer
    expect(installButton.disabled).toBe(true)
    expect(footer.textContent).toContain(ko('chooseCollision'))

    await click(buttonWithText(ko('collisionSkip'), second!))
    expect(installButton.disabled).toBe(false)
    expect(footer.textContent).not.toContain(ko('chooseCollision'))
  })

  it('shows no such note when no name is taken', async () => {
    const api = bridge()
    api.takeDropped.mockResolvedValueOnce({
      ok: true,
      preview: previewOf([candidate({ key: 'fresh' })]),
    } as never)
    await renderPane(api)
    expect(dialog()!.textContent).not.toContain(ko('chooseCollision'))
    expect(dialog()!.textContent).not.toContain(ko('collisionKeeps'))
  })
})

describe('a dropped zip that holds no skill', () => {
  it('shows the notice the Add menu shows for such a zip', async () => {
    const api = bridge()
    api.takeDropped.mockResolvedValueOnce({ ok: false, reason: 'no-skills' } as never)
    await renderPane(api)
    const dropped = host.querySelector('.skl-notice')!.textContent

    await click(buttonWithText(ko('add')))
    await click(buttonWithText(ko('addZip')))
    expect(host.querySelector('.skl-notice')!.textContent).toBe(dropped)
    expect(dropped).toBe(ko('failNoSkills'))
    expect(dialog()).toBeNull()
  })

  it('does not hold up a skill file dropped right after it', async () => {
    const api = bridge()
    // both were queued before this page opened: the zip with no skill first
    api.takeDropped
      .mockResolvedValueOnce({ ok: false, reason: 'no-skills' } as never)
      .mockResolvedValueOnce({
        ok: true,
        preview: previewOf([candidate({ key: 'weekly-report' })]),
      } as never)
    await renderPane(api)
    expect(dialog()!.textContent).toContain('weekly-report')
  })

  it('stops asking when the window may not manage skills', async () => {
    const api = bridge({ takeDropped: vi.fn(async () => ({ ok: false, reason: 'not-allowed' })) })
    await renderPane(api)
    expect(api.takeDropped).toHaveBeenCalledTimes(1)
  })
})

describe('the drop overlay', () => {
  async function dragFilesOver(): Promise<void> {
    const event = new Event('dragenter')
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })
    await act(async () => {
      window.dispatchEvent(event)
      await Promise.resolve()
    })
  }

  it('says skill files are taken too, beside the document types', async () => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, { initial: 'ko' }, createElement(DropToOpenOverlay)),
      )
      await Promise.resolve()
    })
    expect(host.querySelector('.home-drop-overlay')).toBeNull()
    await dragFilesOver()
    const card = host.querySelector('.home-drop-card')!
    expect(card.textContent).toContain('.docx')
    expect(card.textContent).toContain(ko('dropOverlaySkills'))
  })

  it('names the two skill file kinds in every language', () => {
    for (const lang of LANGS) {
      const line = skillsText(lang, 'dropOverlaySkills')
      expect(line, lang).toContain('.zip')
      expect(line, lang).toContain('SKILL.md')
    }
  })
})
