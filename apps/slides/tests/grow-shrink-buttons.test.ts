/**
 * Ribbon Grow/Shrink Font with boxes selected but not entered: the buttons
 * are live and step every run of every selected box in one request, the
 * same path as ⇧⌘> / ⇧⌘<.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatCmdLive } from '../src/renderer/components/ribbon-shared'
import { onGrowShrinkFont } from '../src/renderer/style-actions'
import type { ActionCtx } from '../src/renderer/action-context'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatCmdLive', () => {
  it('Grow/Shrink work on a text selection without entering the box', () => {
    expect(formatCmdLive('fontSizeUp', false, true)).toBe(true)
    expect(formatCmdLive('fontSizeDown', false, true)).toBe(true)
  })

  it('stay off without text-capable elements selected', () => {
    expect(formatCmdLive('fontSizeUp', false, false)).toBe(false)
  })

  it('caret-only commands still need text editing', () => {
    for (const cmd of ['superscript', 'subscript', 'removeFormat'] as const) {
      expect(formatCmdLive(cmd, false, true)).toBe(false)
      expect(formatCmdLive(cmd, true, false)).toBe(true)
    }
  })
})

describe('onGrowShrinkFont', () => {
  it('steps all selected boxes along the ladder in one request', async () => {
    const result = { nodes: [] }
    const setElementFont = vi.fn(async () => result)
    vi.stubGlobal('slidesApi', { setElementFont })
    const applySlide = vi.fn()
    const ctx = {
      editing: null,
      editingCell: null,
      current: 2,
      selectedIds: ['t1', 't2', 't3'],
      groupIdOf: () => undefined,
      applySlide,
    } as unknown as ActionCtx

    onGrowShrinkFont(ctx, 'fontSizeUp')
    onGrowShrinkFont(ctx, 'fontSizeDown')
    await Promise.resolve()

    expect(setElementFont).toHaveBeenNthCalledWith(1, {
      slideIndex: 2,
      sourceIds: ['t1', 't2', 't3'],
      fontSizeStep: { dir: 1, mode: 'ladder' },
    })
    expect(setElementFont).toHaveBeenNthCalledWith(2, {
      slideIndex: 2,
      sourceIds: ['t1', 't2', 't3'],
      fontSizeStep: { dir: -1, mode: 'ladder' },
    })
    expect(applySlide).toHaveBeenCalledWith(2, result)
  })

  it('does nothing with no selection', () => {
    const setElementFont = vi.fn()
    vi.stubGlobal('slidesApi', { setElementFont })
    const ctx = { editing: null, editingCell: null, selectedIds: [] } as unknown as ActionCtx
    onGrowShrinkFont(ctx, 'fontSizeUp')
    expect(setElementFont).not.toHaveBeenCalled()
  })
})
