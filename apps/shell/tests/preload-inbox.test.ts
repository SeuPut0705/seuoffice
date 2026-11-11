import { describe, expect, it, vi } from 'vitest'
import { createInbox } from '../src/preload/inbox'

describe('a pushed message and the page that listens for it', () => {
  it('reaches a subscriber that is already listening', () => {
    const inbox = createInbox<string>()
    const handler = vi.fn()
    inbox.subscribe(handler)
    inbox.push('skills')
    expect(handler).toHaveBeenCalledWith('skills')
  })

  it('waits for the first subscriber when it arrived before anyone listened', () => {
    const inbox = createInbox<string>()
    inbox.push('skills')
    const handler = vi.fn()
    inbox.subscribe(handler)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('skills')
  })

  it('hands over only the newest of several early messages, and only once', () => {
    const inbox = createInbox<string>()
    inbox.push('general')
    inbox.push('skills')
    const first = vi.fn()
    const second = vi.fn()
    inbox.subscribe(first)
    inbox.subscribe(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('skills')
    expect(second).not.toHaveBeenCalled()
  })

  it('stops delivering to a handler that unsubscribed', () => {
    const inbox = createInbox<string>()
    const handler = vi.fn()
    const off = inbox.subscribe(handler)
    off()
    inbox.push('skills')
    expect(handler).not.toHaveBeenCalled()
  })
})
