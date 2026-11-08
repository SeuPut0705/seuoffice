/**
 * Keep formula-bar height independent of the selected cell's contents.
 * Univer scrolls the editor canvas internally; only the fold arrow or the
 * bottom resize handle should move the grid below it.
 */
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY } from '@univerjs/core'
import { IRenderManagerService } from '@univerjs/engine-render'
import { IEditorBridgeService } from '@univerjs/sheets-ui'

import { t } from './i18n/locale'
import type { UniverRuntime } from './univer-state'

const COLLAPSED_PX = 28
const EXPANDED_PX = 80
const MAX_PX = 400

export function installFormulaBarAutosize(runtime: UniverRuntime): { dispose(): void } {
  const injector = runtime.univer.__getInjector()
  const bridge = injector.get(IEditorBridgeService)
  const renderManager = injector.get(IRenderManagerService)
  let observedBar: HTMLElement | null = null
  let handle: HTMLElement | null = null
  let classObserver: MutationObserver | null = null
  let expanded = false
  let height: number | null = null
  let drag: { pointerId: number; startY: number; startHeight: number; scale: number } | null = null

  const maxHeight = () => {
    const available = document.getElementById('univer-container')?.clientHeight ?? 0
    return available > 0 ? Math.max(EXPANDED_PX, Math.min(MAX_PX, available / 2)) : MAX_PX
  }

  const setHeight = (next: number | null) => {
    height = next === null ? null : Math.round(Math.min(maxHeight(), Math.max(COLLAPSED_PX, next)))
    if (!observedBar || !handle) return
    observedBar.style.height = height === null ? '' : `${height}px`
    handle.setAttribute('aria-valuenow', String(height ?? (expanded ? EXPANDED_PX : COLLAPSED_PX)))
    handle.setAttribute('aria-valuemax', String(maxHeight()))
  }

  const stopDrag = () => {
    drag = null
    handle?.classList.remove('dragging')
    document.removeEventListener('pointermove', moveDrag)
    document.removeEventListener('pointerup', endDrag)
    document.removeEventListener('pointercancel', endDrag)
    window.removeEventListener('blur', stopDrag)
  }

  const moveDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    event.preventDefault()
    setHeight(drag.startHeight + (event.clientY - drag.startY) / drag.scale)
  }

  const endDrag = (event: PointerEvent) => {
    if (event.pointerId === drag?.pointerId) stopDrag()
  }

  const scroll = (event: WheelEvent) => {
    if (event.ctrlKey) return
    const render = renderManager.getRenderById(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    const canvas = render?.engine.getCanvas().getCanvasEle()
    if (!canvas?.contains(event.target as Node)) return
    const viewport = render?.scene.getViewport('viewMain')
    if (!viewport) return
    // Univer normally accepts wheel input only for the focused document.
    // Previewing a selected cell must also scroll without entering edit mode.
    const step = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? observedBar!.clientHeight : 1
    viewport.scrollToViewportPos({
      viewportScrollY: viewport.viewportScrollY + event.deltaY * step,
    })
    event.preventDefault()
    event.stopPropagation()
  }

  const watch = () => {
    const bar = document.querySelector<HTMLElement>('[data-u-comp="formula-bar"]')
    if (!bar || observedBar === bar) return
    stopDrag()
    classObserver?.disconnect()
    handle?.remove()
    if (observedBar) {
      observedBar.removeEventListener('wheel', scroll, true)
      observedBar.style.height = ''
    }
    observedBar = bar
    expanded = bar.classList.contains('univer-h-20')
    handle = document.createElement('div')
    handle.className = 'formula-bar-resize-handle'
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-label', t('appFormulaBar'))
    handle.setAttribute('aria-orientation', 'horizontal')
    handle.setAttribute('aria-valuemin', String(COLLAPSED_PX))
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const rect = bar.getBoundingClientRect()
      drag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: bar.offsetHeight,
        // Pointer coordinates include the app's interface zoom; CSS heights do not.
        scale: bar.offsetHeight > 0 ? rect.height / bar.offsetHeight || 1 : 1,
      }
      handle?.classList.add('dragging')
      document.addEventListener('pointermove', moveDrag, { passive: false })
      document.addEventListener('pointerup', endDrag)
      document.addEventListener('pointercancel', endDrag)
      window.addEventListener('blur', stopDrag)
    })
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      setHeight(
        event.key === 'Home'
          ? COLLAPSED_PX
          : event.key === 'End'
            ? maxHeight()
            : bar.offsetHeight + (event.key === 'ArrowDown' ? 20 : -20),
      )
    })
    bar.addEventListener('wheel', scroll, { capture: true, passive: false })
    bar.appendChild(handle)
    setHeight(height)
    classObserver = new MutationObserver(() => {
      const nextExpanded = bar.classList.contains('univer-h-20')
      if (expanded === nextExpanded) return
      expanded = nextExpanded
      stopDrag()
      // Keep the existing fold arrow and Ctrl+Shift+U in charge of their presets.
      setHeight(null)
    })
    classObserver.observe(bar, { attributes: true, attributeFilter: ['class'] })
  }

  // Selection updates also cover a workbench remount, without resizing for content.
  const editCellSub = bridge.currentEditCellState$.subscribe(watch)
  const host = document.getElementById('univer-container')
  const mountObserver = new MutationObserver(watch)
  if (host) mountObserver.observe(host, { childList: true, subtree: true })
  watch()

  return {
    dispose() {
      stopDrag()
      editCellSub.unsubscribe()
      mountObserver.disconnect()
      classObserver?.disconnect()
      handle?.remove()
      if (observedBar) {
        observedBar.removeEventListener('wheel', scroll, true)
        observedBar.style.height = ''
      }
    },
  }
}
