import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { abortMediaCalls, withMediaCallSignal, type MediaCallSender } from '../src'

let nextId = 9000
/** a window as the helper sees it: an id and the `destroyed` event */
class FakeSender extends EventEmitter implements MediaCallSender {
  readonly id = ++nextId
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

/** a media tool call that stays in flight until the test settles it */
function pendingCall(sender: MediaCallSender) {
  let signal!: AbortSignal
  let settle!: (value: string) => void
  let fail!: (error: Error) => void
  const result = withMediaCallSignal(sender, (s) => {
    signal = s
    return new Promise<string>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
  })
  return { signal, settle, fail, result }
}

describe('withMediaCallSignal', () => {
  it('hands the call a live signal and passes its answer through', async () => {
    const sender = new FakeSender()
    const call = pendingCall(sender)
    expect(call.signal).toBeInstanceOf(AbortSignal)
    expect(call.signal.aborted).toBe(false)
    call.settle('answer')
    await expect(call.result).resolves.toBe('answer')
    expect(call.signal.aborted).toBe(false)
  })

  it('aborts when the window that asked goes away', async () => {
    const sender = new FakeSender()
    const call = pendingCall(sender)
    sender.destroy()
    expect(call.signal.aborted).toBe(true)
    call.settle('late')
    await call.result
  })

  it('starts aborted for a window that is already gone', async () => {
    const sender = new FakeSender()
    sender.destroy()
    const call = pendingCall(sender)
    expect(call.signal.aborted).toBe(true)
    call.settle('late')
    await call.result
  })

  it('aborts every call of the window whose AI run was stopped, and no other window', async () => {
    const stopped = new FakeSender()
    const other = new FakeSender()
    const first = pendingCall(stopped)
    const second = pendingCall(stopped)
    const unrelated = pendingCall(other)
    abortMediaCalls(stopped.id)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(unrelated.signal.aborted).toBe(false)
    for (const call of [first, second, unrelated]) call.settle('done')
    await Promise.all([first.result, second.result, unrelated.result])
  })

  it('does not abort another window when one window goes away', async () => {
    const closed = new FakeSender()
    const other = new FakeSender()
    const gone = pendingCall(closed)
    const unrelated = pendingCall(other)
    closed.destroy()
    expect(gone.signal.aborted).toBe(true)
    expect(unrelated.signal.aborted).toBe(false)
    gone.settle('done')
    unrelated.settle('done')
    await Promise.all([gone.result, unrelated.result])
  })

  it('forgets a call once it settled: nothing is left to abort and no listener stays behind', async () => {
    const sender = new FakeSender()
    const answered = pendingCall(sender)
    answered.settle('answer')
    await answered.result
    const failed = pendingCall(sender)
    failed.fail(new Error('provider down'))
    await expect(failed.result).rejects.toThrow('provider down')
    expect(sender.listenerCount('destroyed')).toBe(0)
    abortMediaCalls(sender.id)
    sender.destroy()
    expect(answered.signal.aborted).toBe(false)
    expect(failed.signal.aborted).toBe(false)
  })

  it('a stop with nothing in flight is a no-op', () => {
    expect(() => abortMediaCalls(123_456)).not.toThrow()
  })
})
