// @vitest-environment node
/**
 * A new markdown tab that starts with given text (spec 8.6, "convert without
 * AI"): only the tab it was queued for takes it, once; a reload, another tab
 * or a view made for a file gets nothing, and a tab that closes first drops it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  },
}))

import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import { queueMarkdownSeedFor, registerMarkdownSeedIpc } from '../src/main/seed-main'

class FakeContents {
  destroyed = false
  private onDestroyed: (() => void) | null = null
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  once(_event: 'destroyed', listener: () => void): void {
    this.onDestroyed = listener
  }
  destroy(): void {
    this.destroyed = true
    this.onDestroyed?.()
  }
}

const fileViews = new Set<number>()
const take = (id: number) =>
  (
    handlers.get(MARKDOWN_CHANNELS.seedTake) as unknown as (e: {
      sender: { id: number }
    }) => unknown
  )({ sender: { id } })

beforeEach(() => {
  handlers.clear()
  fileViews.clear()
  registerMarkdownSeedIpc({ opensFile: (id) => fileViews.has(id) })
})

describe('markdown:seed-take', () => {
  it('hands the queued text to its own tab once; a reload takes nothing', () => {
    const tab = new FakeContents(11)
    queueMarkdownSeedFor(tab, '# Plan\n\n- Trip\n')
    expect(take(12)).toBeNull()
    expect(take(11)).toBe('# Plan\n\n- Trip\n')
    expect(take(11)).toBeNull()
  })

  it('never hands text to a view made for a file', () => {
    const tab = new FakeContents(21)
    queueMarkdownSeedFor(tab, 'text')
    fileViews.add(21)
    expect(take(21)).toBeNull()
  })

  it('drops the text of a tab that closed before taking it', () => {
    const tab = new FakeContents(31)
    queueMarkdownSeedFor(tab, 'text')
    tab.destroy()
    expect(take(31)).toBeNull()
  })
})
