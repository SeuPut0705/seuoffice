// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installScreenTips } from '../src/screentip'

// A ribbon button at y 40..70 and a 80x24 tip. jsdom lays nothing out, so the
// boxes are given; the tip's own box is the one it is measured with.
const BUTTON = { left: 100, right: 140, top: 40, bottom: 70, width: 40, height: 30 }
const TIP = { left: 0, right: 80, top: 0, bottom: 24, width: 80, height: 24 }

let uninstall: () => void
let button: HTMLButtonElement
const innerHeight = window.innerHeight

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.classList.contains('ui-screentip') ? TIP : BUTTON
    return { ...box, x: box.left, y: box.top, toJSON: () => box } as DOMRect
  })
  uninstall = installScreenTips()
  button = document.createElement('button')
  button.setAttribute('data-tip', 'Gridlines')
  document.body.appendChild(button)
})

afterEach(() => {
  uninstall()
  button.remove()
  document.documentElement.style.removeProperty('--os-pointer-size')
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const tipTop = () =>
  Number.parseFloat(document.querySelector<HTMLElement>('.ui-screentip')!.style.top)

function hoverAt(x: number, y: number): void {
  button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: x, clientY: y }))
  vi.advanceTimersByTime(500)
}

describe('screentip and the pointer picture', () => {
  it('stays under the control when the pointer rests well above its bottom edge', () => {
    hoverAt(120, 42)
    expect(tipTop()).toBe(76)
  })

  it('drops below a standard pointer that would cover it', () => {
    hoverAt(120, 65)
    expect(tipTop()).toBe(65 + 32 + 2)
  })

  it('drops below the pointer size the system reports', () => {
    document.documentElement.style.setProperty('--os-pointer-size', '128px')
    hoverAt(120, 65)
    expect(tipTop()).toBe(65 + 128 + 2)
  })

  it('follows the pointer to where it rests before the tip shows', () => {
    document.documentElement.style.setProperty('--os-pointer-size', '128px')
    button.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, clientX: 120, clientY: 42 }),
    )
    button.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 60 }),
    )
    vi.advanceTimersByTime(500)
    expect(tipTop()).toBe(60 + 128 + 2)
  })

  it('goes above the control when the window ends below the pointer', () => {
    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true })
    document.documentElement.style.setProperty('--os-pointer-size', '128px')
    hoverAt(120, 65)
    expect(tipTop()).toBe(40 - 24 - 6)
  })

  it('keeps the usual place when keyboard focus opened it', () => {
    document.documentElement.style.setProperty('--os-pointer-size', '128px')
    button.focus()
    vi.advanceTimersByTime(500)
    expect(tipTop()).toBe(76)
  })
})
