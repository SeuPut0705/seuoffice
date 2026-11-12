import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webContents: { getAllWebContents: () => [] } }))

import {
  canEndRendererProcess,
  releaseClosedRenderer,
  wasReleasedRenderer,
} from '../src/main/renderer-disposal'

/**
 * A closed docs tab's webContents is not closed while its page is live
 * (closing it wedged the UI thread): its renderer process is ended first, and
 * the webContents is destroyed once that process is gone, so a closed
 * document leaves neither its memory nor its page behind. A process that
 * Chromium shares with a live view must never be ended with it.
 */

let nextId = 5000

function fakeContents(pid: number, opts: { destroyed?: boolean } = {}) {
  let processId = pid
  let destroyed = opts.destroyed === true
  const gone: Array<() => void> = []
  return {
    id: nextId++,
    isDestroyed: vi.fn(() => destroyed),
    getOSProcessId: vi.fn(() => processId),
    forcefullyCrashRenderer: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'render-process-gone') gone.push(listener)
    }),
    close: vi.fn(() => {
      destroyed = true
    }),
    /** the process ended: Electron tells every webContents it hosted */
    endProcess() {
      processId = 0
      for (const listener of gone.splice(0)) listener()
    },
  }
}

/** let a deferred destruction run */
const settled = () => new Promise((resolve) => setImmediate(resolve))

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

  it('ends no process for a destroyed view or one with no process', () => {
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

  it('destroys a closed view once its renderer process is gone, not before', async () => {
    const closed = fakeContents(881)
    releaseClosedRenderer(closed, () => [closed])
    await settled()
    expect(closed.close).not.toHaveBeenCalled()
    closed.endProcess()
    await settled()
    expect(closed.close).toHaveBeenCalledTimes(1)
    expect(closed.isDestroyed()).toBe(true)
  })

  it('destroys at once a closed view that has no renderer process', async () => {
    // never loaded, or its renderer already gone: Electron reports process id 0
    const closed = fakeContents(0)
    releaseClosedRenderer(closed, () => [closed])
    await settled()
    expect(closed.close).toHaveBeenCalledTimes(1)
    expect(closed.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  it('destroys a view left in a shared process when that process ends', async () => {
    const first = fakeContents(883)
    const second = fakeContents(883)
    releaseClosedRenderer(first, () => [first, second])
    await settled()
    // its page is still live in the process the open view runs in
    expect(first.close).not.toHaveBeenCalled()
    releaseClosedRenderer(second, () => [first, second])
    first.endProcess()
    second.endProcess()
    await settled()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('leaves a view that was destroyed meanwhile alone', async () => {
    const closed = fakeContents(884)
    releaseClosedRenderer(closed, () => [closed])
    closed.close()
    closed.close.mockClear()
    closed.endProcess()
    await settled()
    expect(closed.close).not.toHaveBeenCalled()
  })
})
