// @vitest-environment jsdom
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY } from '@univerjs/core'
import { IRenderManagerService } from '@univerjs/engine-render'
import { IEditorBridgeService } from '@univerjs/sheets-ui'
import { BehaviorSubject } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installFormulaBarAutosize } from '../src/renderer/formula-bar-autosize'
import type { UniverRuntime } from '../src/renderer/univer-state'

vi.mock('../src/renderer/i18n/locale', () => ({ t: () => 'Formula Bar' }))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ''
})

function setup(mounted = true) {
  document.body.innerHTML = '<div id="univer-container"><div id="workbench"></div></div>'
  const workbench = document.getElementById('workbench')!
  Object.defineProperty(document.getElementById('univer-container')!, 'clientHeight', {
    value: 600,
  })
  const bar = document.createElement('div')
  bar.dataset.uComp = 'formula-bar'
  bar.className = 'univer-h-7'
  const canvas = document.createElement('canvas')
  bar.appendChild(canvas)
  Object.defineProperty(bar, 'offsetHeight', {
    get: () =>
      Number.parseFloat(bar.style.height) || (bar.classList.contains('univer-h-20') ? 80 : 28),
  })
  // Exercise the interface zoom, where pointer deltas are twice CSS deltas.
  bar.getBoundingClientRect = () => ({ height: bar.offsetHeight * 2 }) as DOMRect
  if (mounted) workbench.appendChild(bar)
  const selection = new BehaviorSubject<unknown>(null)
  const viewport = { viewportScrollY: 0, scrollToViewportPos: vi.fn() }
  const renderManager = {
    getRenderById: vi.fn(() => ({
      engine: { getCanvas: () => ({ getCanvasEle: () => canvas }) },
      scene: { getViewport: () => viewport },
    })),
  }
  const runtime = {
    univer: {
      __getInjector: () => ({
        get: (key: unknown) => {
          if (key === IEditorBridgeService) return { currentEditCellState$: selection }
          if (key === IRenderManagerService) return renderManager
          throw new Error('Unexpected dependency')
        },
      }),
    },
  } as unknown as UniverRuntime
  dispose = installFormulaBarAutosize(runtime).dispose
  const grip = () => bar.querySelector<HTMLElement>('[role="separator"]')!
  return { bar, canvas, workbench, selection, viewport, renderManager, grip }
}

function pointer(target: EventTarget, type: string, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  target.dispatchEvent(event)
}

describe('formula bar height and scrolling', () => {
  it('keeps its height when selecting long text, including after a manual resize', () => {
    const { bar, selection, grip } = setup()
    selection.next({ text: 'line\n'.repeat(100) })
    expect(bar.offsetHeight).toBe(28)
    pointer(grip(), 'pointerdown', 56)
    pointer(document, 'pointermove', 256)
    pointer(document, 'pointerup', 256)
    expect(bar.offsetHeight).toBe(128)
    selection.next({ text: 'short' })
    selection.next({ text: 'line\n'.repeat(200) })
    expect(bar.offsetHeight).toBe(128)
    pointer(document, 'pointermove', 400)
    expect(bar.offsetHeight).toBe(128)
  })

  it('scrolls preview content without starting an edit or moving the grid', () => {
    const { bar, canvas, viewport, renderManager } = setup()
    viewport.viewportScrollY = 40
    const bubble = vi.fn()
    document.addEventListener('wheel', bubble)
    const wheel = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    canvas.dispatchEvent(wheel)
    expect(viewport.scrollToViewportPos).toHaveBeenCalledWith({ viewportScrollY: 100 })
    expect(renderManager.getRenderById).toHaveBeenCalledWith(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    expect(wheel.defaultPrevented).toBe(true)
    expect(bubble).not.toHaveBeenCalled()
    expect(bar.offsetHeight).toBe(28)
    document.removeEventListener('wheel', bubble)
  })

  it('leaves zoom gestures and wheel input over other controls alone', () => {
    const { bar, canvas, viewport } = setup()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, ctrlKey: true, bubbles: true }))
    bar.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }))
    expect(viewport.scrollToViewportPos).not.toHaveBeenCalled()
  })

  it('clamps dragging to leave space for the grid and stops on cancellation', () => {
    const { bar, grip } = setup()
    pointer(grip(), 'pointerdown', 56)
    pointer(document, 'pointermove', 5000, 2)
    expect(bar.offsetHeight).toBe(28)
    pointer(document, 'pointermove', 5000)
    expect(bar.offsetHeight).toBe(300)
    pointer(document, 'pointermove', -1000)
    expect(bar.offsetHeight).toBe(28)
    pointer(document, 'pointercancel', -1000)
    pointer(document, 'pointermove', 200)
    expect(bar.offsetHeight).toBe(28)
  })

  it('lets the native fold arrow reset a custom height', async () => {
    const { bar, grip } = setup()
    grip().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(bar.offsetHeight).toBe(300)
    bar.className = 'univer-h-20'
    await Promise.resolve()
    expect(bar.style.height).toBe('')
    expect(bar.offsetHeight).toBe(80)
    bar.className = 'univer-h-7'
    await Promise.resolve()
    expect(bar.offsetHeight).toBe(28)
  })

  it('attaches after mounting and removes active drag listeners on disposal', async () => {
    const { bar, workbench, grip } = setup(false)
    expect(grip()).toBeNull()
    workbench.appendChild(bar)
    await Promise.resolve()
    expect(grip()).not.toBeNull()
    pointer(grip(), 'pointerdown', 56)
    pointer(document, 'pointermove', 156)
    expect(bar.offsetHeight).toBe(78)
    dispose!()
    dispose = undefined
    expect(grip()).toBeNull()
    expect(bar.style.height).toBe('')
    pointer(document, 'pointermove', 400)
    expect(bar.style.height).toBe('')
  })
})
