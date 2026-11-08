import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }))

import {
  canEndRendererProcess,
  releaseClosedRenderer,
  wasReleasedRenderer,
} from '../src/main/renderer-disposal'

/**
 * A closed docs tab keeps its webContents (closing it wedges the UI thread),
 * but its renderer process must end so the memory comes back. A process that
 * Chromium shares with a live view must never be ended with it.
 */

let nextId = 5000

function fakeContents(pid: number, opts: { destroyed?: boolean } = {}) {
  return {
    id: nextId++,
    isDestroyed: vi.fn(() => opts.destroyed === true),
    getOSProcessId: vi.fn(() => pid),
    forcefullyCrashRenderer: vi.fn(),
  }
}

describe('releaseClosedRenderer', () => {
  it('ends the process of a closed view that has it to itself', () => {
    const closed = fakeContents(111)
    const other = fakeContents(222)
    expect(releaseClosedRenderer(closed, () => [closed, other])).toBe(true)
    expect(closed.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(other.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(wasReleasedRenderer(closed.id)).toBe(true)
    expect(wasReleasedRenderer(other.id)).toBe(false)
  })

  it('leaves a process that a live view shares', () => {
    const closed = fakeContents(333)
    const live = fakeContents(333)
    expect(releaseClosedRenderer(closed, () => [closed, live])).toBe(false)
    expect(closed.forcefullyCrashRenderer).not.toHaveBeenCalled()
    // its exit, whenever the shared process ends, is still not a crash
    expect(wasReleasedRenderer(closed.id)).toBe(true)
    expect(wasReleasedRenderer(live.id)).toBe(false)
  })

  it('ends a shared process when the last view in it closes', () => {
    const first = fakeContents(444)
    const second = fakeContents(444)
    expect(releaseClosedRenderer(first, () => [first, second])).toBe(false)
    expect(releaseClosedRenderer(second, () => [first, second])).toBe(true)
    expect(second.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(canEndRendererProcess(fakeContents(444), [first, second])).toBe(true)
  })

  it('does nothing for a destroyed view or one with no process', () => {
    const destroyed = fakeContents(555, { destroyed: true })
    const gone = fakeContents(0)
    expect(releaseClosedRenderer(destroyed, () => [destroyed])).toBe(false)
    expect(releaseClosedRenderer(gone, () => [gone])).toBe(false)
    expect(destroyed.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(gone.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  it('ends a process only once', () => {
    const closed = fakeContents(666)
    expect(releaseClosedRenderer(closed, () => [closed])).toBe(true)
    expect(releaseClosedRenderer(closed, () => [closed])).toBe(false)
    expect(closed.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
  })

  it('swallows a view that throws (torn down meanwhile)', () => {
    const closed = fakeContents(777)
    closed.getOSProcessId.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(releaseClosedRenderer(closed, () => [closed])).toBe(false)
  })
})
