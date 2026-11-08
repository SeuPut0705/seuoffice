import { Spreadsheet, SpreadsheetSkeleton } from '@univerjs/engine-render'
import { describe, expect, it, vi } from 'vitest'

import {
  blitOnlyFrame,
  installStylesCacheReuse,
  type ViewportFrameInfo,
} from '../src/renderer/styles-cache-reuse'

const clean: ViewportFrameInfo = {
  viewportKey: 'viewMain',
  cacheCanvas: {},
  isDirty: 0,
  isForceDirty: false,
  diffX: 0,
  diffY: 0,
  diffBounds: [],
}

describe('blit-only frame detection', () => {
  it('reuses the styles cache only when the cached canvas is copied as is', () => {
    expect(blitOnlyFrame(clean, false, false)).toBe(true)
    expect(blitOnlyFrame({ ...clean, viewportKey: 'viewMainLeftTop' }, false, false)).toBe(true)
  })

  it('rebuilds for any frame that paints', () => {
    expect(blitOnlyFrame({ ...clean, isDirty: 2 }, false, false)).toBe(false)
    expect(blitOnlyFrame({ ...clean, isForceDirty: true }, false, false)).toBe(false)
    expect(blitOnlyFrame(clean, true, false)).toBe(false)
    expect(blitOnlyFrame(clean, false, true)).toBe(false)
    expect(blitOnlyFrame({ ...clean, diffY: 20 }, false, false)).toBe(false)
    expect(blitOnlyFrame({ ...clean, diffX: -64 }, false, false)).toBe(false)
    expect(blitOnlyFrame({ ...clean, diffBounds: [{}] }, false, false)).toBe(false)
  })

  it('rebuilds without a cache canvas or outside the content viewports', () => {
    expect(blitOnlyFrame({ ...clean, cacheCanvas: undefined }, false, false)).toBe(false)
    expect(blitOnlyFrame({ ...clean, viewportKey: 'viewRowTop' }, false, false)).toBe(false)
    const { viewportKey: _key, ...unkeyed } = clean
    expect(blitOnlyFrame(unkeyed, false, false)).toBe(false)
    expect(blitOnlyFrame(undefined, false, false)).toBe(false)
  })
})

describe('installed styles cache reuse', () => {
  function fixture(dirty: boolean) {
    // No worksheet data: the stock setStylesCache returns before touching the
    // visible range, so a recorded updateVisibleRange call means "skipped".
    const skeleton = Object.create(SpreadsheetSkeleton.prototype) as SpreadsheetSkeleton & {
      updateVisibleRange: ReturnType<typeof vi.fn>
    }
    Object.defineProperty(skeleton, 'updateVisibleRange', { value: vi.fn(() => true) })
    Object.defineProperty(skeleton, 'rowColumnSegment', { get: () => undefined })
    const component = Object.create(Spreadsheet.prototype) as Spreadsheet
    Object.defineProperties(component, {
      visible: { value: true },
      getSkeleton: { value: () => skeleton },
      isDirty: { value: () => dirty },
      isForceDirty: { value: () => false },
    })
    return { skeleton, component }
  }

  it('records the viewport instead of rebuilding on a blit-only frame', () => {
    installStylesCacheReuse()
    const { skeleton, component } = fixture(false)
    component.render({} as never, clean as never)
    expect(skeleton.updateVisibleRange).toHaveBeenCalledWith(clean)
  })

  it('runs the stock rebuild when the component is dirty', () => {
    installStylesCacheReuse()
    const { skeleton, component } = fixture(true)
    component.render({} as never, clean as never)
    expect(skeleton.updateVisibleRange).not.toHaveBeenCalled()
  })

  it('leaves direct setStylesCache calls outside a render untouched', () => {
    installStylesCacheReuse()
    const { skeleton } = fixture(false)
    skeleton.setStylesCache(clean as never)
    expect(skeleton.updateVisibleRange).not.toHaveBeenCalled()
  })
})
