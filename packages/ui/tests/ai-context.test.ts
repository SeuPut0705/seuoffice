/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import { aiRunErrorText } from '../src/ai-subscription'
import { AiToolsUnsupportedNotice } from '../src/AiToolsUnsupportedNotice'
import {
  AI_CONTEXT_STRINGS,
  aiContextConfirmText,
  aiContextText,
  type AiContextStringKey,
} from '../src/strings-ai-context'

const KEYS = Object.keys(AI_CONTEXT_STRINGS.en) as AiContextStringKey[]

/** Languages written in another script: a value equal to the English one is an untranslated copy */
const NON_LATIN: readonly Lang[] = ['zh', 'ja', 'ko', 'th', 'ru', 'ar', 'he', 'hi', 'zh-TW']

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('AI_CONTEXT_STRINGS', () => {
  it('covers all 21 ui languages', () => {
    expect(LANGS).toHaveLength(21)
    expect(Object.keys(AI_CONTEXT_STRINGS).sort()).toEqual([...LANGS].sort())
  })

  it('has every key, non-empty, in every language', () => {
    for (const lang of LANGS) {
      const dict = AI_CONTEXT_STRINGS[lang] as Record<string, string>
      expect(Object.keys(dict).sort(), lang).toEqual([...KEYS].sort())
      for (const key of KEYS) {
        expect(dict[key]?.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('is translated, not copied from English, in every language', () => {
    for (const lang of LANGS) {
      if (lang === 'en') continue
      for (const key of KEYS) {
        expect(AI_CONTEXT_STRINGS[lang][key], `${lang}.${key}`).not.toBe(AI_CONTEXT_STRINGS.en[key])
      }
    }
  })

  it('carries text in the language’s own script in every non-Latin-script language', () => {
    // a sentence left in English would be all ASCII once the placeholders are removed
    for (const lang of NON_LATIN) {
      for (const key of KEYS) {
        const own = AI_CONTEXT_STRINGS[lang][key].replace(/\{\w+\}/g, '').replace(/[ -~]/g, '')
        expect(own.replace(/[·…%]/g, '').length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the same placeholders as English in every language', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(placeholders(AI_CONTEXT_STRINGS[lang][key]), `${lang}.${key}`).toEqual(
          placeholders(AI_CONTEXT_STRINGS.en[key]),
        )
      }
    }
  })

  it('words the tools-unsupported notice as the spec does', () => {
    expect(AI_CONTEXT_STRINGS.en.toolsUnsupported).toBe(
      'This model does not support tool calls. It will suggest text only and will not edit the document.',
    )
    expect(aiContextText('ko', 'toolsUnsupported')).toContain('도구 호출')
  })
})

describe('aiContextConfirmText', () => {
  const warning = { estimatedTokens: 3300, contextTokens: 4096, ratio: 3300 / 4096, known: true }

  it('names the estimate, the limit and the percentage', () => {
    const text = aiContextConfirmText('en', warning)
    expect(text).toContain('3,300')
    expect(text).toContain('4,096')
    expect(text).toContain('81')
    expect(text).not.toContain(AI_CONTEXT_STRINGS.en.contextUnknown)
  })

  it('adds the unknown-context sentence when the size was not confirmed', () => {
    const text = aiContextConfirmText('ko', { ...warning, known: false })
    expect(text).toContain(AI_CONTEXT_STRINGS.ko.contextUnknown.replace('{limit}', '4,096'))
    expect(text).toContain('문맥을 확인하지 못했습니다.')
  })

  it('uses the language’s digits and separators', () => {
    expect(aiContextConfirmText('en', warning)).toBe(
      'This request is close to the model’s context limit: about 3,300 of 4,096 tokens (81%). Send it anyway?',
    )
  })
})

describe('aiRunErrorText context-limit', () => {
  it('is the localized declined-run sentence, never undefined', () => {
    const en = aiRunErrorText('en', { kind: 'context-limit' })
    const ko = aiRunErrorText('ko', { kind: 'context-limit' })
    expect(en).toBe(AI_CONTEXT_STRINGS.en.errContextLimit)
    expect(ko).toBe(AI_CONTEXT_STRINGS.ko.errContextLimit)
    expect(en).toBeTruthy()
  })
})

describe('AiToolsUnsupportedNotice', () => {
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

  it('renders the notice in the requested language', () => {
    act(() => root.render(createElement(AiToolsUnsupportedNotice, { lang: 'en' })))
    expect(host.textContent).toBe(AI_CONTEXT_STRINGS.en.toolsUnsupported)
    expect(host.querySelector('[role="note"]')).not.toBeNull()

    act(() => root.render(createElement(AiToolsUnsupportedNotice, { lang: 'ja' })))
    expect(host.textContent).toBe(AI_CONTEXT_STRINGS.ja.toolsUnsupported)
  })
})
