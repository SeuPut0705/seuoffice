/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS, PRODUCT_CONTACT_EMAIL, PRODUCT_REPO_SLUG } from '@genoffice/i18n'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'
import { strings } from '../src/renderer/src/strings'

/**
 * Settings → About: a plain link to the product's repository, the
 * acknowledgement of the project this one is based on, the bundled license
 * notices, the rights contact, and the trademark and no-warranty notices.
 * Nothing asks for a star, and the upstream vendor is not named.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let openGitHubRepo: ReturnType<typeof vi.fn<() => Promise<void>>>
let openLicenseNotices: ReturnType<typeof vi.fn<() => Promise<void>>>
let openRightsContact: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  openGitHubRepo = vi.fn(async () => undefined)
  openLicenseNotices = vi.fn(async () => undefined)
  openRightsContact = vi.fn(async () => undefined)
  const known: Record<string, unknown> = {
    getTheme: async () => 'system',
    getDocumentTheme: async () => 'follow',
    getDefaultSaveDir: async () => '',
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    getDefaultAppStatus: async () => ({ state: 'unsupported', others: [], manualOnly: false }),
    getAiPanelPrefs: async () => ({ fontSize: 'default', customFontSize: 14, spellcheck: true }),
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.2.3',
    openGitHubRepo,
    openLicenseNotices,
    openRightsContact,
  }
  // every other call answers with something harmless
  window.aiOffice = new Proxy(known, {
    get: (target, name: string) =>
      target[name] ?? (name.startsWith('on') ? () => () => undefined : async () => null),
  }) as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function openAbout(lang: Lang = 'en'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: lang },
        createElement(SettingsModal, { onClose: vi.fn(), target: { section: 'about' } }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const buttonLabeled = (label: string): HTMLButtonElement =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.set-btn')).find(
    (button) => button.textContent === label,
  )!

const repoButton = (): HTMLButtonElement => buttonLabeled(strings.en.viewOnGitHub)

describe('Settings → About', () => {
  it('links to the product repository with a neutral label', async () => {
    await openAbout()
    expect(host.querySelector('.set-pane-title')!.textContent).toBe(strings.en.setSecAbout)
    expect(host.textContent).toContain(`github.com/${PRODUCT_REPO_SLUG}`)
    expect(strings.en.viewOnGitHub).toBe('View on GitHub')

    await act(async () => {
      repoButton().click()
      await Promise.resolve()
    })
    expect(openGitHubRepo).toHaveBeenCalledTimes(1)
  })

  it('asks for no star and names the upstream project only in the acknowledgement', async () => {
    await openAbout()
    const pane = host.querySelector<HTMLElement>('.set-pane-title')!.parentElement!
    const text = pane.textContent ?? ''
    expect(text).not.toMatch(/\bstars?\b|starred/i)
    expect(text).toContain('Based on the open-source project GenOffice (Apache License 2.0).')
    // the acknowledgement is the one place the upstream name appears
    expect(text.match(/GenOffice/g)).toHaveLength(1)
  })

  it('opens the bundled license notices and starts a mail to the rights contact', async () => {
    await openAbout()
    expect(host.textContent).toContain(PRODUCT_CONTACT_EMAIL)
    await act(async () => {
      buttonLabeled(strings.en.setLicensesOpen).click()
      buttonLabeled(strings.en.setRightsContactSend).click()
      await Promise.resolve()
    })
    expect(openLicenseNotices).toHaveBeenCalledTimes(1)
    expect(openRightsContact).toHaveBeenCalledTimes(1)
  })

  it('shows the trademark, HWP and no-warranty notices under the product name', async () => {
    await openAbout('ko')
    const text =
      host.querySelector<HTMLElement>('.set-pane-title')!.parentElement!.textContent ?? ''
    // the wording Hancom asks software built on its published HWP document to carry
    expect(text).toContain(
      '본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.',
    )
    expect(text).toContain('rhwp')
    expect(text).toContain('이음오피스는 Microsoft, 한글과컴퓨터')
    expect(text).toContain('이음오피스는 Apache License 2.0에 따라 있는 그대로 제공되며')
  })

  it('has every notice in every UI language, each naming the product by token', () => {
    const keys = [
      'setLicenses',
      'setLicensesDesc',
      'setLicensesOpen',
      'setRightsContact',
      'setRightsContactDesc',
      'setRightsContactSend',
      'setTrademarks',
      'setHwpNotice',
      'setDisclaimer',
    ] as const
    for (const lang of LANGS) {
      for (const key of keys) expect(strings[lang][key], `${lang}.${key}`).not.toBe('')
      expect(strings[lang].setTrademarks, lang).toContain('GenOffice')
      expect(strings[lang].setHwpNotice, lang).toContain('rhwp')
      expect(strings[lang].setDisclaimer, lang).toContain('Apache License 2.0')
      if (lang !== 'en')
        expect(strings[lang].setTrademarks, lang).not.toBe(strings.en.setTrademarks)
    }
  })

  it('has the link label in every UI language, none of them about stars', () => {
    expect(LANGS).toHaveLength(21)
    for (const lang of LANGS) {
      const label = strings[lang].viewOnGitHub
      expect(label, lang).toContain('GitHub')
      if (lang !== 'en') expect(label, lang).not.toBe(strings.en.viewOnGitHub)
    }
    // the two Chinese scripts and the two Malay-family languages may share a wording
    const distinct = new Set(LANGS.map((lang) => strings[lang].viewOnGitHub))
    expect(distinct.size).toBeGreaterThanOrEqual(LANGS.length - 2)
  })
})
