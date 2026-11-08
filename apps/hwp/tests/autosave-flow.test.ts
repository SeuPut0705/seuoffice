/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_INTERVAL_MS, startAutosave } from '../src/renderer/autosave-flow'

describe('HWP autosave scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves on a tick when the document has unsaved changes', async () => {
    const save = vi.fn(async () => true)
    const handle = startAutosave({ shouldSave: () => true, save })
    await handle.tick()
    expect(save).toHaveBeenCalledOnce()
    handle.stop()
  })

  it('does nothing while the guard says the document is not ready', async () => {
    const save = vi.fn(async () => true)
    const handle = startAutosave({ shouldSave: () => false, save })
    await handle.tick()
    expect(save).not.toHaveBeenCalled()
    handle.stop()
  })

  it('backs off when the guard itself fails', async () => {
    const save = vi.fn(async () => true)
    const handle = startAutosave({
      shouldSave: () => {
        throw new Error('editor is gone')
      },
      save,
      backoffTicks: 1,
    })
    await handle.tick()
    expect(save).not.toHaveBeenCalled()
    await handle.tick()
    await handle.tick()
    expect(save).not.toHaveBeenCalled()
    handle.stop()
  })

  it('backs off for a few turns after a failed save', async () => {
    const save = vi.fn(async () => false)
    const handle = startAutosave({ shouldSave: () => true, save, backoffTicks: 2 })
    await handle.tick()
    expect(save).toHaveBeenCalledTimes(1)
    await handle.tick()
    await handle.tick()
    expect(save).toHaveBeenCalledTimes(1)
    await handle.tick()
    expect(save).toHaveBeenCalledTimes(2)
    handle.stop()
  })

  it('saves on window blur when the guard allows it', async () => {
    const save = vi.fn(async () => true)
    const handle = startAutosave({ shouldSave: () => true, save })
    window.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledOnce()
    handle.stop()
  })

  it('stop detaches the interval and the blur listener', async () => {
    const save = vi.fn(async () => true)
    const handle = startAutosave({ shouldSave: () => true, save })
    handle.stop()
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2)
    window.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(0)
    expect(save).not.toHaveBeenCalled()
  })
})
