import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/i18n/locale', () => ({
  useI18n: () => ({ t: (key: string) => key, lang: 'en' }),
}))
vi.mock('mathlive', () => {
  class Field extends HTMLElement {
    static fontsDirectory: string | null
    static soundsDirectory: string | null
    value = ''
    set menuItems(_items: unknown[]) {
      if (!this.isConnected) throw new Error('Mathfield not mounted')
    }
    mathVirtualKeyboardPolicy = 'manual'
    setValue(value: string) {
      this.value = value
    }
    insert(value: string) {
      this.value += value
    }
  }
  customElements.define('test-math-field', Field)
  return { MathfieldElement: Field }
})

import { MathDialog } from '../src/renderer/extensions/math/MathDialog'
import { useMathExtension } from '../src/renderer/extensions/math/useMathExtension'
import { buildParseMap } from '../src/renderer/document/parse-map'
import { mathHtml } from '../src/renderer/extensions/math/html-adapter'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'mathVirtualKeyboard', {
    configurable: true,
    value: { hide: vi.fn(), show: vi.fn(), visible: false },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
})

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name)!
async function mount(latex: string, apply = vi.fn(() => true), cancel = vi.fn()) {
  await act(() =>
    root.render(
      createElement(MathDialog, {
        initial: { latex, display: false },
        editing: false,
        onApply: apply,
        onCancel: cancel,
      }),
    ),
  )
  return { apply, cancel }
}
async function typeSource(value: string) {
  const textarea = container.querySelector('textarea')!
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('math editing sessions', () => {
  it('synchronizes visual input and source without recreating the visual field', async () => {
    const { apply } = await mount('x')
    const field = container.querySelector('test-math-field') as HTMLElement & { value: string }
    await act(() => {
      field.value = String.raw`\frac{a}{b}`
      field.dispatchEvent(new Event('input'))
    })
    expect(container.querySelector('textarea')!.value).toBe(String.raw`\frac{a}{b}`)
    await typeSource(String.raw`\sqrt{x}`)
    expect(field.value).toBe(String.raw`\sqrt{x}`)
    expect(container.querySelector('test-math-field')).toBe(field)
    await act(() => button('mathApply').click())
    expect(apply).toHaveBeenCalledWith({ latex: String.raw`\sqrt{x}`, display: false })
  })

  it('allows correction of unsupported input and never applies when cancelled', async () => {
    const { apply, cancel } = await mount(String.raw`\unsupported{x}`)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('mathUnsupported')
    expect(button('mathApply').disabled).toBe(false)
    await act(() => button('cancel').click())
    expect(cancel).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects blank input and retains the draft when the host reports a conflict', async () => {
    const { apply } = await mount(
      '',
      vi.fn(() => false),
    )
    expect(button('mathApply').disabled).toBe(true)
    await typeSource('x+1')
    await act(() => button('mathApply').click())
    expect(apply).toHaveBeenCalledOnce()
    expect(container.querySelector('textarea')!.value).toBe('x+1')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('mathStale')
  })

  it('handles apply shortcut and Escape without treating plain Enter as apply', async () => {
    const { apply, cancel } = await mount('x')
    const textarea = container.querySelector('textarea')!
    await act(() =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    expect(apply).not.toHaveBeenCalled()
    await act(() =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
        }),
      ),
    )
    expect(apply).not.toHaveBeenCalled()
    await act(() =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      ),
    )
    expect(apply).toHaveBeenCalledOnce()
    await act(() =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses applying to a changed source or a different file and ignores stale preview clicks', async () => {
    const source = `<html><body>${mathHtml({ latex: 'x', display: true })}</body></html>`
    const map = buildParseMap(source, 1)
    const sid = map.elements.find((e) => source.slice(...e.startTag).includes('data-latex'))!.sid
    let current = { source, map, sid, identity: 'first.html' }
    const apply = vi.fn(() => true)
    function Host() {
      const extension = useMathExtension({
        read: () => current,
        flush: () => {},
        apply,
        unavailable: () => {},
      })
      return createElement(
        'div',
        null,
        createElement('button', { onClick: () => extension.openRef.current(sid, 0) }, 'stale'),
        createElement('button', { onClick: () => extension.openRef.current(sid, 1) }, 'open'),
        extension.dialog,
      )
    }
    await act(() => root.render(createElement(Host)))
    await act(() => button('stale').click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => {
      button('open').click()
      await new Promise((r) => setTimeout(r, 50))
    })
    await typeSource('x+2')
    current = { ...current, identity: 'second.html' }
    await act(() => button('mathApply').click())
    expect(apply).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')!.value).toBe('x+2')
    await act(() => button('cancel').click())
    current = { source, map, sid, identity: 'first.html' }
    await act(() => button('open').click())
    await typeSource('x+3')
    current = { ...current, source: source + '<!-- external edit -->' }
    await act(() => button('mathApply').click())
    expect(apply).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')!.value).toBe('x+3')
  })
})
