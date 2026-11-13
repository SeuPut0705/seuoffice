/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSubscriptionState, SubscriptionStatusMap } from '@seuoffice/ai-provider/browser'
import { LANGS } from '@seuoffice/i18n'
import { aiSubscriptionText } from '@seuoffice/ui'
import { Onboarding } from '../src/renderer/src/Onboarding'
import { LocaleProvider } from '../src/renderer/src/locale'
import {
  isLastOnboardingStep,
  nextOnboardingStep,
  onboardingSteps,
  previousOnboardingStep,
} from '../src/renderer/src/onboarding-steps'
import type { DefaultAppStatus } from '../src/shared/home-api'
import { strings } from '../src/renderer/src/strings'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function statuses(claude: AiSubscriptionState, codex: AiSubscriptionState): SubscriptionStatusMap {
  return {
    'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
    codex: { provider: 'codex', state: codex, meteredAccepted: false },
  }
}

function connectionOf(
  map: SubscriptionStatusMap,
  extra: Partial<SubscriptionConnection> = {},
): SubscriptionConnection {
  return {
    statuses: map,
    busy: false,
    failed: {},
    codexImageAvailable: false,
    install: vi.fn(),
    login: vi.fn(),
    switchAccount: vi.fn(),
    logout: vi.fn(),
    recheck: vi.fn(),
    refresh: vi.fn(),
    acceptMetered: vi.fn(async () => undefined),
    openInstallHelp: vi.fn(),
    ...extra,
  }
}

interface RenderOptions {
  onDone?: () => Promise<boolean>
  connection?: SubscriptionConnection
  noticeDue?: boolean
  onNoticeAcknowledge?: () => void
  defaultApp?: DefaultAppStatus | null
  covered?: boolean
}

function renderOnboarding(options: RenderOptions = {}): void {
  act(() => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(Onboarding, {
          onDone: options.onDone ?? vi.fn(async () => true),
          connection: options.connection ?? connectionOf(statuses('not-installed', 'signed-out')),
          noticeDue: options.noticeDue ?? false,
          onNoticeAcknowledge: options.onNoticeAcknowledge ?? vi.fn(),
          defaultApp: options.defaultApp ?? null,
          ...(options.covered === undefined ? {} : { covered: options.covered }),
        }),
      ),
    )
  })
}

async function click(selector: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(selector)
  expect(button, selector).not.toBeNull()
  await act(async () => {
    button!.click()
    // let a finish (persist, then re-enable the buttons) settle
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const activeStep = (): string | null =>
  host.querySelector<HTMLElement>('.onb-slide.active')?.dataset.step ?? null

const OTHER_MANUAL: DefaultAppStatus = { state: 'other', others: ['Word'], manualOnly: true }
const OTHER_CLAIMABLE: DefaultAppStatus = {
  state: 'other',
  others: ['WPS Office'],
  manualOnly: false,
}
const IS_DEFAULT: DefaultAppStatus = { state: 'default', others: [], manualOnly: false }

describe('onboarding steps', () => {
  it('offer the default-app step only while another app or nobody known holds the documents', () => {
    const withStep = ['welcome', 'connect', 'defaultApp', 'done']
    const without = ['welcome', 'connect', 'done']
    expect(onboardingSteps({ defaultApp: OTHER_MANUAL })).toEqual(withStep)
    expect(onboardingSteps({ defaultApp: OTHER_CLAIMABLE })).toEqual(withStep)
    expect(
      onboardingSteps({ defaultApp: { state: 'unknown', others: [], manualOnly: true } }),
    ).toEqual(withStep)
    expect(onboardingSteps({ defaultApp: IS_DEFAULT })).toEqual(without)
    expect(
      onboardingSteps({ defaultApp: { state: 'unsupported', others: [], manualOnly: false } }),
    ).toEqual(without)
    // still being read when the guide opened
    expect(onboardingSteps({ defaultApp: null })).toEqual(without)
  })

  it.each([
    ['three', onboardingSteps({ defaultApp: null })],
    ['four', onboardingSteps({ defaultApp: OTHER_MANUAL })],
  ])('advance and go back one by one over %s steps', (_count, steps) => {
    const last = steps.length - 1
    for (let i = 0; i < last; i++) {
      expect(nextOnboardingStep(i, steps)).toBe(i + 1)
      expect(isLastOnboardingStep(i, steps)).toBe(false)
    }
    expect(nextOnboardingStep(last, steps)).toBeNull()
    expect(isLastOnboardingStep(last, steps)).toBe(true)
    for (let i = last; i > 0; i--) expect(previousOnboardingStep(i, steps)).toBe(i - 1)
    expect(previousOnboardingStep(0, steps)).toBe(0)
  })
})

describe('Onboarding default-app step', () => {
  function stubDefaultApp(read: DefaultAppStatus, set: () => Promise<DefaultAppStatus>) {
    const api = {
      getDefaultAppStatus: vi.fn(async () => read),
      setDefaultApp: vi.fn(set),
    }
    vi.stubGlobal('aiOffice', api)
    return api
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const step = () => host.querySelector<HTMLElement>('.onb-slide[data-step="defaultApp"]')!
  const button = () => step().querySelector<HTMLButtonElement>('.onb-default-app-btn')!
  const state = () => step().querySelector<HTMLElement>('.onb-default-app')!.dataset.state

  async function goToDefaultAppStep(): Promise<void> {
    await click('.onb-next')
    await click('.onb-next')
    expect(activeStep()).toBe('defaultApp')
  }

  it('sits between connect and done, with a dot of its own, and never holds Next', async () => {
    stubDefaultApp(OTHER_MANUAL, async () => OTHER_MANUAL)
    renderOnboarding({ defaultApp: OTHER_MANUAL })
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('.onb-slide')).map((el) => el.dataset.step),
    ).toEqual(['welcome', 'connect', 'defaultApp', 'done'])
    expect(host.querySelectorAll('.onb-dot')).toHaveLength(4)
    await goToDefaultAppStep()
    expect(host.querySelector<HTMLButtonElement>('.onb-next')!.disabled).toBe(false)
    await click('.onb-next')
    expect(activeStep()).toBe('done')
  })

  it('on Windows opens the system page, explains it, and notices the change on return', async () => {
    const api = stubDefaultApp(OTHER_MANUAL, async () => OTHER_MANUAL)
    renderOnboarding({ defaultApp: OTHER_MANUAL })
    await goToDefaultAppStep()
    expect(step().querySelector('.onb-default-app-status')!.textContent).toContain('Word')
    expect(step().querySelectorAll('.onb-default-app-steps li')).toHaveLength(2)

    await click('.onb-slide[data-step="defaultApp"] .onb-default-app-btn')
    expect(api.setDefaultApp).toHaveBeenCalledTimes(1)
    expect(state()).toBe('other')

    api.getDefaultAppStatus.mockResolvedValue({ ...IS_DEFAULT, manualOnly: true })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(state()).toBe('default')
    expect(button().disabled).toBe(true)
    expect(step().querySelector('.onb-default-app-steps')).toBeNull()
    expect(step().querySelector('.onb-default-app-failed')).toBeNull()
  })

  it('on the Mac claims the documents in one click', async () => {
    const api = stubDefaultApp(OTHER_CLAIMABLE, async () => IS_DEFAULT)
    renderOnboarding({ defaultApp: OTHER_CLAIMABLE })
    await goToDefaultAppStep()
    expect(step().querySelector('.onb-default-app-steps')).toBeNull()

    await click('.onb-slide[data-step="defaultApp"] .onb-default-app-btn')
    expect(api.setDefaultApp).toHaveBeenCalledTimes(1)
    expect(state()).toBe('default')
    expect(button().disabled).toBe(true)
    expect(step().querySelector('.onb-default-app-failed')).toBeNull()
  })

  it('on the Mac says so when the claim did not stick', async () => {
    stubDefaultApp(OTHER_CLAIMABLE, async () => OTHER_CLAIMABLE)
    renderOnboarding({ defaultApp: OTHER_CLAIMABLE })
    await goToDefaultAppStep()
    await click('.onb-slide[data-step="defaultApp"] .onb-default-app-btn')
    expect(state()).toBe('other')
    expect(step().querySelector('.onb-default-app-failed')).not.toBeNull()
    expect(button().disabled).toBe(false)
  })
})

describe('Onboarding', () => {
  it('shows three steps: welcome first, one dot each', () => {
    renderOnboarding()
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('.onb-slide')).map((el) => el.dataset.step),
    ).toEqual(['welcome', 'connect', 'done'])
    expect(host.querySelectorAll('.onb-dot')).toHaveLength(3)
    expect(activeStep()).toBe('welcome')
  })

  it('describes the product plainly on the welcome step', () => {
    renderOnboarding()
    const step = host.querySelector<HTMLElement>('.onb-slide[data-step="welcome"]')!
    expect(step.querySelector('.onb-subtitle')!.textContent).toBe(strings.en.onbWelcomeSubtitle)
    expect(step.querySelector('.onb-body')!.textContent).toBe(strings.en.onbWelcomeBody)
    // no superlative of its own
    expect(step.textContent).not.toMatch(/\b(first|best|leading|most|only)\b|AI-native/i)
    expect(strings.en.onbWelcomeSubtitle).toBe('A source-available office suite')
  })

  it('can be completed without connecting a subscription', async () => {
    const onDone = vi.fn(async () => true)
    const connection = connectionOf(statuses('not-installed', 'not-installed'))
    renderOnboarding({ onDone, connection })

    await click('.onb-next')
    expect(activeStep()).toBe('connect')
    expect(host.querySelector<HTMLButtonElement>('.onb-next')!.disabled).toBe(false)
    expect(host.textContent).toContain(strings.en.onbConnectSkipNote)

    await click('.onb-next')
    expect(activeStep()).toBe('done')
    expect(host.textContent).toContain(strings.en.onbDoneNotConnected)
    expect(onDone).not.toHaveBeenCalled()

    await click('.onb-next')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(connection.install).not.toHaveBeenCalled()
    expect(connection.login).not.toHaveBeenCalled()
  })

  it('lets Skip and Escape finish from any step', async () => {
    const onDone = vi.fn(async () => true)
    renderOnboarding({ onDone })

    await click('.onb-skip')
    expect(onDone).toHaveBeenCalledTimes(1)

    await click('.onb-next')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(onDone).toHaveBeenCalledTimes(2)
  })

  it('leaves the keyboard alone while Settings is open above it, and is still there after', async () => {
    const onDone = vi.fn(async () => true)
    renderOnboarding({ onDone, covered: true })
    const press = async (key: string) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }))
        await Promise.resolve()
      })

    // Escape closes the dropped skill's preview, Enter is typed in a field there
    await press('Escape')
    await press('Enter')
    await press('ArrowRight')
    expect(onDone).not.toHaveBeenCalled()
    expect(activeStep()).toBe('welcome')

    renderOnboarding({ onDone, covered: false })
    await press('Escape')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('asks which AI the user has on the connect step, then walks that one path on the live status', async () => {
    const connection = connectionOf(statuses('not-installed', 'signed-out'))
    renderOnboarding({ connection })
    await click('.onb-next')

    const step = host.querySelector<HTMLElement>('.onb-slide[data-step="connect"]')!
    const cards = () =>
      Array.from(step.querySelectorAll<HTMLElement>('.ai-sub-card')).map((card) => [
        card.dataset.provider,
        card.dataset.state,
      ])
    expect(step.querySelector('.ai-sub-guide-question')!.textContent).toBe(
      aiSubscriptionText('en', 'guideQuestion'),
    )
    expect(
      Array.from(step.querySelectorAll<HTMLElement>('.ai-sub-guide-path')).map(
        (el) => el.dataset.path,
      ),
    ).toEqual(['claude-code', 'chatgpt', 'free'])
    expect(cards()).toEqual([])
    // the ChatGPT answer connects directly: the line about Codex belongs to the Codex way alone
    expect(step.querySelector('.ai-sub-codex')).toBeNull()

    await click('.onb-slide[data-step="connect"] [data-path="claude-code"]')
    expect(cards()).toEqual([['claude-code', 'not-installed']])
    await click(
      '.onb-slide[data-step="connect"] [data-provider="claude-code"] [data-action="install"]',
    )
    expect(connection.install).toHaveBeenCalledWith('claude-code')
    await click('.onb-slide[data-step="connect"] [data-action="guide-back"]')
    await click('.onb-slide[data-step="connect"] [data-path="chatgpt"]')
    await click('.onb-slide[data-step="connect"] [data-action="guide-alternate"]')
    expect(cards()).toEqual([['codex', 'signed-out']])
    expect(step.querySelector('.ai-sub-codex')!.textContent).toBe(
      aiSubscriptionText('en', 'codexNotice'),
    )
    await click('.onb-slide[data-step="connect"] [data-provider="codex"] [data-action="login"]')
    expect(connection.login).toHaveBeenCalledWith('codex')
  })

  it('says a launch could not start, under the card of that path', async () => {
    renderOnboarding({
      connection: connectionOf(statuses('not-installed', 'signed-out'), {
        failed: { codex: 'login' },
      }),
    })
    await click('.onb-next')
    expect(host.querySelector('.onb-connect-failed')).toBeNull()
    await click('.onb-slide[data-step="connect"] [data-path="chatgpt"]')
    await click('.onb-slide[data-step="connect"] [data-action="guide-alternate"]')
    const failed = host.querySelector<HTMLElement>('.onb-connect-failed')!
    expect(failed.dataset.provider).toBe('codex')
    expect(failed.textContent).toBe(strings.en.setSubLoginFailed)
  })

  it('names the connected subscription on the last step', async () => {
    renderOnboarding({ connection: connectionOf(statuses('ready', 'signed-out')) })
    await click('.onb-next')
    await click('.onb-next')
    expect(host.querySelector('.onb-slide.active .onb-subtitle')!.textContent).toBe(
      'AI is connected: Claude.',
    )
  })

  it('offers the free connections on the connect step and names a made one on the last step', async () => {
    const connectFreeAi = vi.fn(async () => ({
      ok: true as const,
      provider: 'gemini' as const,
      model: 'm',
    }))
    vi.stubGlobal('aiOffice', {
      getAiSettings: async () => ({
        providers: {
          openrouter: { apiKey: 'sk-or-v1-x', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
        },
      }),
      onAiSettingsChanged: () => () => {},
      getFreeAiQuota: async () => ({ used: 9, limit: 50, remaining: 41 }),
      connectFreeAi,
    })
    try {
      renderOnboarding()
      await click('.onb-next')
      const step = host.querySelector('.onb-slide.active')!
      // a free connection already made opens the free path by itself
      expect(step.querySelector('.ai-sub-guide-open')!.getAttribute('data-path')).toBe('free')
      // the free cards say what free use means themselves: no line of the guide repeats it
      expect(step.querySelector('.ai-sub-guide-need')).toBeNull()
      expect(
        [...step.querySelectorAll<HTMLElement>('.free-ai-card')].map((el) => [
          el.dataset.provider,
          el.dataset.state,
        ]),
      ).toEqual([
        ['openrouter', 'connected'],
        ['gemini', 'idle'],
      ])
      expect(step.textContent).toContain('41 of 50 free requests left today')
      await click('.onb-next')
      expect(host.querySelector('.onb-slide.active .onb-subtitle')!.textContent).toBe(
        'AI is connected: OpenRouter.',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the first-connection notice for the connect step and reports its acknowledgement', async () => {
    const onNoticeAcknowledge = vi.fn()
    const onDone = vi.fn(async () => true)
    renderOnboarding({
      onDone,
      noticeDue: true,
      onNoticeAcknowledge,
      connection: connectionOf(statuses('ready', 'signed-out')),
    })
    expect(host.querySelector('.first-notice')).toBeNull()

    await click('.onb-next')
    const notice = host.querySelector<HTMLElement>('.first-notice')!
    expect(notice.textContent).toContain(aiSubscriptionText('en', 'noticeSend'))
    expect(notice.textContent).toContain(aiSubscriptionText('en', 'noticeTraining'))
    expect(notice.textContent).toContain(aiSubscriptionText('en', 'noticeCodexHistory'))

    // the notice owns the keyboard: the onboarding behind it neither skips nor advances
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      await Promise.resolve()
    })
    expect(activeStep()).toBe('connect')
    expect(onDone).not.toHaveBeenCalled()

    await click('.first-notice .ai-sub-btn')
    expect(onNoticeAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('carries no credits offer, community call, star hint or statistics notice', async () => {
    renderOnboarding({
      connection: connectionOf(statuses('ready', 'ready')),
      defaultApp: OTHER_MANUAL,
    })
    const text = () => host.textContent ?? ''
    const count = host.querySelectorAll('.onb-dot').length
    for (let step = 0; step < count; step++) {
      expect(text()).not.toMatch(/credit|github|\bstars?\b|statistic|analytics/i)
      if (step < count - 1) await click('.onb-next')
    }
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('.onb-offer, .onb-star, .onb-consent, .onb-join')).toBeNull()
  })
})

describe('welcome copy', () => {
  it('exists in every UI language, as a translation', () => {
    for (const lang of LANGS) {
      const { onbWelcomeSubtitle, onbWelcomeBody } = strings[lang]
      expect(onbWelcomeSubtitle.trim(), lang).not.toBe('')
      expect(onbWelcomeBody.trim(), lang).not.toBe('')
      if (lang === 'en') continue
      expect(onbWelcomeSubtitle, lang).not.toBe(strings.en.onbWelcomeSubtitle)
      expect(onbWelcomeBody, lang).not.toBe(strings.en.onbWelcomeBody)
    }
    expect(new Set(LANGS.map((lang) => strings[lang].onbWelcomeBody)).size).toBe(LANGS.length)
  })

  it.each(LANGS)('names every document kind and both subscriptions in %s', (lang) => {
    const body = strings[lang].onbWelcomeBody
    for (const name of ['Word', 'Excel', 'PowerPoint', 'PDF', 'Markdown', 'HTML']) {
      expect(body, name).toContain(name)
    }
    expect(body).toContain('Claude')
    expect(body).toContain('ChatGPT')
    // the product is named by the title above, and no vendor of the suite is named at all
    expect(`${strings[lang].onbWelcomeSubtitle} ${body}`).not.toMatch(/seuoffice/i)
  })
})
