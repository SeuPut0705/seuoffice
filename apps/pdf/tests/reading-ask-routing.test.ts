/**
 * The "Ask AI" popover's chips (reading-assist spec 4.2): explain and translate
 * answer with a passage card; the passage summary, the rewrite chip and a typed
 * question still go to the AI window.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AiAskPopover } from '../src/renderer/AiAskPopover'
import { strings } from '../src/renderer/i18n/strings'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as Record<string, unknown>).pdfApi = { onLanguageChanged: () => () => {} }
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
})

async function mount(readOnly = false) {
  const onSend = vi.fn()
  const onCard = vi.fn()
  const onClose = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      createElement(AiAskPopover, {
        rect: { left: 10, top: 10, right: 50, bottom: 30 },
        excerpt: 'the passage',
        readOnly,
        onSend,
        onCard,
        onClose,
      }),
    ),
  )
  return { el: container, onSend, onCard, onClose }
}

/** the UI language of a bare LocaleProvider-less render is zh (the context default) */
const chip = (el: Element, text: string) =>
  [...el.querySelectorAll('.ai-ask-chip')].find((b) => b.textContent === text) as
    HTMLButtonElement | undefined

const send = (el: Element) => el.querySelector('.ai-ask-confirm') as HTMLButtonElement

describe('Ask AI popover routing', () => {
  it('explain and translate chips open passage cards, not the chat', async () => {
    const m = await mount()
    await act(async () => chip(m.el, strings.zh.aiChipExplain)!.click())
    expect(m.onCard).toHaveBeenCalledWith('explain')
    await act(async () => chip(m.el, strings.zh.aiChipTranslate)!.click())
    expect(m.onCard).toHaveBeenCalledWith('translate')
    expect(m.onSend).not.toHaveBeenCalled()
  })

  it('the passage summary chip still goes to the chat', async () => {
    const m = await mount()
    await act(async () => chip(m.el, strings.zh.aiChipSummarizePassage)!.click())
    await act(async () => send(m.el).click())
    expect(m.onSend).toHaveBeenCalledWith(strings.zh.aiChipSummarizePassage)
    expect(m.onCard).not.toHaveBeenCalled()
  })

  it('the rewrite chip still goes to the chat on an editable document', async () => {
    const m = await mount(false)
    await act(async () => chip(m.el, strings.zh.aiChipRewritePassage)!.click())
    await act(async () => send(m.el).click())
    expect(m.onSend).toHaveBeenCalledWith(strings.zh.aiChipRewritePassage)
    expect(m.onCard).not.toHaveBeenCalled()
  })

  it('a typed question goes to the chat', async () => {
    const m = await mount()
    const input = m.el.querySelector('.ai-ask-pop-input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Why does this matter?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => send(m.el).click())
    expect(m.onSend).toHaveBeenCalledWith('Why does this matter?')
    expect(m.onCard).not.toHaveBeenCalled()
  })

  it('keeps the explain and translate chips on a document that cannot be edited', async () => {
    const m = await mount(true)
    expect(chip(m.el, strings.zh.aiChipExplain)).toBeDefined()
    expect(chip(m.el, strings.zh.aiChipTranslate)).toBeDefined()
    expect(chip(m.el, strings.zh.aiChipRewritePassage)).toBeUndefined()
  })
})
