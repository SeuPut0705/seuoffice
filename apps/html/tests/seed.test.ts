// @vitest-environment node
/**
 * A new HTML tab that starts with given text (a skill template's copy, spec
 * 5.7): the main side hands it to its own tab once; a view made for a file,
 * another tab, a second take or a tab that closed first gets nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  },
}))

import { HTML_CHANNELS } from '../src/shared/ipc'
import { queueHtmlSeedFor, registerHtmlSeedIpc } from '../src/main/seed-main'

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
  (handlers.get(HTML_CHANNELS.seedTake) as unknown as (e: { sender: { id: number } }) => unknown)({
    sender: { id },
  })

beforeEach(() => {
  handlers.clear()
  fileViews.clear()
  registerHtmlSeedIpc({ opensFile: (id) => fileViews.has(id) })
})

describe('the html seed', () => {
  it('hands the text to its own tab once', () => {
    queueHtmlSeedFor(new FakeContents(1), '<h1>Letter</h1>')
    expect(take(2)).toBeNull()
    expect(take(1)).toBe('<h1>Letter</h1>')
    expect(take(1)).toBeNull()
  })

  it('gives nothing to a view made for a file, or after its tab closed', () => {
    fileViews.add(3)
    queueHtmlSeedFor(new FakeContents(3), '<p>x</p>')
    expect(take(3)).toBeNull()
    const closed = new FakeContents(4)
    queueHtmlSeedFor(closed, '<p>y</p>')
    closed.destroy()
    expect(take(4)).toBeNull()
    const gone = new FakeContents(5)
    gone.destroyed = true
    queueHtmlSeedFor(gone, '<p>z</p>')
    expect(take(5)).toBeNull()
  })
})
