/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { Lang } from '@genoffice/i18n'
import { LocaleProvider } from '../src/renderer/src/locale'
import { HelpScreen } from '../src/renderer/src/i18n/help/HelpScreen'
import { helpBody } from '../src/renderer/src/i18n/help/help-registry'

/**
 * The manual ships an edition per UI language, and every one of them has to be
 * reachable.
 *
 * The screen used to read `document.documentElement.lang`, which is the BCP-47
 * tag (`ko-KR`, `en-US`), and then pick a body from it, so an edition sat in
 * the bundle without ever being rendered. These assert on rendered output with
 * the document tag set to something the lookups have to reject.
 */

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

import gettingStarted from '../src/renderer/src/i18n/help/topics/getting-started.en.md?raw'
import gettingStartedKo from '../src/renderer/src/i18n/help/topics/getting-started.ko.md?raw'
import { topicTitle } from '../src/renderer/src/i18n/help/help-titles'

const TOPIC = 'getting-started'

/**
 * A run of prose lifted out of each edition of one topic, rather than a phrase
 * typed in here: the manual is edited, and a hand-copied sentence would fail
 * the moment a translator reworded it without saying anything about languages.
 *
 * Both the body and the title are looked up by short code, so both are what a
 * BCP-47 tag misses — the body falls back to English, and so does the title.
 */
function proseFrom(markdown: string): string {
  const line = markdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 60 && !/[#|*!`[\]]/.test(l))
  if (!line) throw new Error('no prose line to sample')
  // A slice from the middle: the start of a line tends to carry a heading or a
  // list the renderer rewrites. Collapsed first, because the renderer collapses
  // runs of whitespace and a sample spanning one would never match.
  const flat = line.replace(/\s+/g, ' ')
  const at = Math.floor(flat.length / 2)
  return flat.slice(at, at + 24).trim()
}

const BODIES: Partial<Record<Lang, string>> = {
  en: proseFrom(gettingStarted),
  ko: proseFrom(gettingStartedKo),
}

const TITLES: Partial<Record<Lang, string>> = {
  en: topicTitle(TOPIC, 'en'),
  ko: topicTitle(TOPIC, 'ko'),
}

beforeEach(() => {
  // jsdom implements neither of these, and the screen calls both on render
  Element.prototype.scrollTo ??= function scrollTo(): void {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/**
 * Wait for the screen to stop changing.
 *
 * The body arrives through a dynamic import and then a state update, so how
 * long that takes is not something a fixed number of ticks can promise — one
 * tick was enough for the first language and not the fifth. Polling until the
 * text stops growing is what the assertion actually depends on.
 */
/**
 * Wait until the article actually contains what the caller is about to assert.
 *
 * Polling for "the text stopped changing" was flaky: the sidebar is there from
 * the first paint and the body lands a tick or two later, so the screen can sit
 * unchanged for a turn and then change anyway. Waiting for the expected phrase
 * is the same thing the assertion does, and it cannot stop early.
 */
async function settle(host: HTMLDivElement, expected: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const text = host.querySelector('.help-article')?.textContent ?? ''
    if (text.includes(expected)) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
}

async function render(lang: Lang, expected: string, htmlLang = 'en-US'): Promise<HTMLDivElement> {
  // the document tag is the trap: it is always the BCP-47 form, and reading it
  // is exactly the bug. Every case sets it to something that would break.
  document.documentElement.lang = htmlLang
  act(() => root.unmount())
  root = createRoot(host)
  act(() => {
    root.render(
      createElement(LocaleProvider, { initial: lang, children: createElement(HelpScreen) }),
    )
  })
  // Open the topic by name rather than taking the one that happens to be first:
  // adding an article would otherwise move this test's subject out from under it.
  const button = [...host.querySelectorAll('button.help-topic')].find(
    (b) => b.textContent?.trim() === topicTitle(TOPIC, lang),
  )
  if (button) {
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  await settle(host, expected)
  return host
}

/** the article heading, which is the one place `topicTitle` drives */
function heading(root: HTMLDivElement): string {
  return root.querySelector('h1')?.textContent ?? ''
}

describe('the manual renders in the reader’s language', () => {
  it('resolves each topic body in the language asked for', async () => {
    for (const [lang, phrase] of Object.entries(BODIES) as Array<[Lang, string]>) {
      const body = await helpBody(TOPIC, lang)
      expect(body ?? '', `body for ${lang}`).toContain(phrase)
    }
  })

  it("titles the article in the shell's language, not the document tag's", async () => {
    // The wiring claim, on the heading alone. `topicTitle` has its own table
    // and the same failure mode — an unknown key misses every row and lands on
    // English — and the sidebar renders the same title through the same
    // function, so asserting on the whole screen would paper over a heading
    // that fell back.
    for (const [lang, title] of Object.entries(TITLES) as Array<[Lang, string]>) {
      // the document tag is deliberately a tag the lookups have to reject
      const view = await render(lang, title, `${lang}-XX`)
      expect(heading(view), `heading for ${lang}`).toBe(title)
    }
  })

  it("does not hand back another language's body", async () => {
    const korean = (await helpBody(TOPIC, 'ko')) ?? ''
    expect(korean).toContain(BODIES.ko!)
    expect(korean).not.toContain(BODIES.en!)
  })

  it('falls back to the English body for a language without an edition', async () => {
    const body = (await helpBody(TOPIC, 'ja')) ?? ''
    expect(body).toContain(BODIES.en!)
  })
})
