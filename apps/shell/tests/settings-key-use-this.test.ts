/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

/**
 * Saving a key in Advanced ▸ AI model never selects that provider: key
 * providers run only while the user picks them. The pane offers "Use this AI"
 * for a saved key that is not in use, so the key can be put to work where it
 * was entered. These cases pin when the button shows and what it writes.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let stored: AiSettings
let setAiSettings: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function settingsWithKey(provider: AiSettings['provider'], apiKey = 'sk-test'): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = provider
  settings.providers.openai = { apiKey, model: 'gpt-test' }
  return settings
}

function installApi(settings: AiSettings): void {
  stored = settings
  setAiSettings = vi.fn(async (next: AiSettings) => {
    stored = next
  })
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAiPanelPrefs: async () => ({ fontSize: 'medium', customFontSize: 14, spellcheck: true }),
    setAiPanelPrefs: async (patch: unknown) => patch,
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    getAiProviders: () => [
      {
        id: 'openai',
        label: 'OpenAI',
        models: ['gpt-test'],
        defaultModel: 'gpt-test',
        keyPlaceholder: 'k',
        defaultBaseUrl: '',
      },
    ],
    getAiSettings: async () => stored,
    setAiSettings,
  } as unknown as HomeApi
}

async function openAiPane(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, { onClose: vi.fn() }),
      ),
    )
    await Promise.resolve()
  })
  const nav = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
    (button) => button.textContent?.trim() === 'AI',
  )
  await click(nav!)
  await click(host.querySelector<HTMLButtonElement>('.set-adv-toggle')!)
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

/** let the queued read-change-write run out */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function paneButton(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.set-pane-actions button')).find(
    (button) => button.textContent?.trim() === label,
  )
}

describe('"Use this AI" in Advanced ▸ AI model', () => {
  it('selects a saved key that is not in use, and writes nothing else', async () => {
    installApi(settingsWithKey('auto'))
    await openAiPane()
    const use = paneButton('Use this AI')
    expect(use).toBeDefined()
    // opening the pane wrote nothing
    expect(setAiSettings).not.toHaveBeenCalled()

    await click(use!)
    await settle()
    expect(setAiSettings).toHaveBeenCalledTimes(1)
    const written = setAiSettings.mock.calls[0]![0] as AiSettings
    expect(written.provider).toBe('openai')
    expect(written.providers.openai).toEqual({ apiKey: 'sk-test', model: 'gpt-test' })
  })

  it('is absent while the provider is already in use', async () => {
    installApi(settingsWithKey('openai'))
    await openAiPane()
    expect(paneButton('Use this AI')).toBeUndefined()
  })

  it('waits for an edit to be saved before offering the provider', async () => {
    installApi(settingsWithKey('auto', ''))
    await openAiPane()
    expect(paneButton('Use this AI')).toBeUndefined()

    const key = host.querySelector<HTMLInputElement>('#set-ai-key')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(key, 'sk-new')
      key.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    // a typed key is a draft: nothing to select until it is written
    expect(paneButton('Use this AI')).toBeUndefined()

    await click(paneButton('Save')!)
    await settle()
    expect(paneButton('Use this AI')).toBeDefined()
    // saving alone kept the AI in use as it was
    expect((setAiSettings.mock.calls[0]![0] as AiSettings).provider).toBe('auto')
  })
})
