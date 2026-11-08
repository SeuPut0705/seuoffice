/**
 * "In the file" states are confirmed only by a successful PDF save (reading-
 * assist spec 3.5): a confirmation waits for a save that wrote its annotation,
 * runs after the store migration under the saved file's hash, and nothing is
 * written when the document closes unsaved.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSaveConfirmations } from '../src/renderer/reading/save-confirmations'

describe('save confirmations', () => {
  it('runs nothing before a save', () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('note-1', confirm)
    expect(c.isPending('note-1')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('runs a confirmation once a save wrote its annotation, under the hash resolved after it', async () => {
    const c = createSaveConfirmations()
    const order: string[] = []
    const confirm = vi.fn(async (hash: string) => {
      order.push(`confirm ${hash}`)
    })
    c.register('note-1', confirm)
    const hash = vi.fn(async () => {
      order.push('hash')
      return 'new-hash'
    })
    await c.afterSave(['note-1', 'other'], hash)
    expect(confirm).toHaveBeenCalledWith('new-hash')
    expect(order).toEqual(['hash', 'confirm new-hash'])
    expect(c.isPending('note-1')).toBe(false)
    // once only
    await c.afterSave(['note-1'], hash)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('leaves confirmations whose annotation the save did not write', async () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('note-1', confirm)
    const hash = vi.fn(async () => 'h')
    await c.afterSave(['markup-9'], hash)
    expect(confirm).not.toHaveBeenCalled()
    expect(hash).not.toHaveBeenCalled()
    expect(c.isPending('note-1')).toBe(true)
  })

  it('keeps a confirmation pending when the saved file has no hash to write under', async () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('note-1', confirm)
    await c.afterSave(['note-1'], async () => null)
    expect(confirm).not.toHaveBeenCalled()
    expect(c.isPending('note-1')).toBe(true)
  })

  it('a failing confirmation does not stop the others', async () => {
    const c = createSaveConfirmations()
    const ok = vi.fn()
    c.register('a', async () => {
      throw new Error('disk full')
    })
    c.register('b', ok)
    await c.afterSave(['a', 'b'], async () => 'h')
    expect(ok).toHaveBeenCalledWith('h')
  })

  it('cancel and re-register replace the waiting confirmation; listeners hear changes', async () => {
    const c = createSaveConfirmations()
    const listener = vi.fn()
    const off = c.subscribe(listener)
    const first = vi.fn()
    const second = vi.fn()
    c.register('n', first)
    c.register('n', second)
    expect(c.pendingIds()).toEqual(['n'])
    await c.afterSave(['n'], async () => 'h')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    c.register('m', first)
    c.cancel('m')
    expect(c.isPending('m')).toBe(false)
    expect(listener).toHaveBeenCalled()
    off()
  })

  it('a hold from a successful save keeps a confirmation from being cancelled until afterSave', async () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('m1', confirm)
    c.register('m2', vi.fn())
    c.hold(['m1', 'unknown'])
    expect(c.isHeld('m1')).toBe(true)
    expect(c.isHeld('m2')).toBe(false)
    expect(c.isHeld('unknown')).toBe(false)
    // the post-save reload drops the annotation from the editing document: the
    // highlight sync and the card would cancel it now, and must not
    c.cancel('m1')
    c.cancel('m2')
    expect(c.isPending('m1')).toBe(true)
    expect(c.isPending('m2')).toBe(false)
    await c.afterSave(['m1'], async () => 'new-hash')
    expect(confirm).toHaveBeenCalledWith('new-hash')
    expect(c.isHeld('m1')).toBe(false)
    expect(c.isPending('m1')).toBe(false)
  })

  it('held confirmations keep waiting when the migration gave no hash, and run after the next save', async () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('m1', confirm)
    c.hold(['m1'])
    await c.afterSave(['m1'], async () => null)
    expect(confirm).not.toHaveBeenCalled()
    expect(c.isPending('m1')).toBe(true)
    // still held: the annotation is in the file, only its state is not written yet
    c.cancel('m1')
    expect(c.isPending('m1')).toBe(true)
    // a later save (of something else) whose migration did complete confirms it
    await c.afterSave(['other'], async () => 'later-hash')
    expect(confirm).toHaveBeenCalledWith('later-hash')
    expect(c.isPending('m1')).toBe(false)
  })

  it('a document closed unsaved writes nothing: the confirmations just go away with the tab', () => {
    const c = createSaveConfirmations()
    const confirm = vi.fn()
    c.register('note-1', confirm)
    // no afterSave ever happens
    expect(confirm).not.toHaveBeenCalled()
  })
})
