// @vitest-environment node
/**
 * "Add to note" from the PDF editor (reading-assist spec 4.9), the main
 * side: text queued for a note tab is taken by that tab only while it shows
 * that note file, in order, once; an untitled tab never takes it, and a tab
 * that closes first drops it. A queued text nudges a mounted renderer.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  },
}))

import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import { queueMarkdownNoteAppendFor, registerMarkdownNoteAppendIpc } from '../src/main/note-append'

class FakeContents {
  destroyed = false
  sent: string[] = []
  private onDestroyed: Array<() => void> = []
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  once(_event: 'destroyed', listener: () => void): void {
    this.onDestroyed.push(listener)
  }
  send(channel: string): void {
    this.sent.push(channel)
  }
  destroy(): void {
    this.destroyed = true
    for (const listener of this.onDestroyed) listener()
  }
}

const documentPaths = new Map<number, string>()
const take = (id: number) =>
  (
    handlers.get(MARKDOWN_CHANNELS.noteAppendTake) as unknown as (e: {
      sender: { id: number }
    }) => unknown
  )({ sender: { id } })

beforeEach(() => {
  handlers.clear()
  documentPaths.clear()
  registerMarkdownNoteAppendIpc({ documentPath: (id) => documentPaths.get(id) ?? null })
})

describe('markdown:note-append-take', () => {
  it('hands the queued texts to the note’s tab in order, once, and nudges it', () => {
    const tab = new FakeContents(41)
    documentPaths.set(41, 'C:\\notes\\a 노트.md')
    queueMarkdownNoteAppendFor(tab, 'C:\\notes\\a 노트.md', 'first')
    queueMarkdownNoteAppendFor(tab, 'C:\\notes\\a 노트.md', 'second')
    expect(tab.sent).toEqual([MARKDOWN_CHANNELS.noteAppendReady, MARKDOWN_CHANNELS.noteAppendReady])
    expect(take(42)).toEqual([])
    expect(take(41)).toEqual(['first', 'second'])
    expect(take(41)).toEqual([])
  })

  it('never hands text to an untitled tab or one showing another file', () => {
    const untitled = new FakeContents(51)
    queueMarkdownNoteAppendFor(untitled, 'C:\\notes\\n.md', 'text')
    expect(take(51)).toEqual([])
    const other = new FakeContents(52)
    documentPaths.set(52, 'C:\\notes\\other.md')
    queueMarkdownNoteAppendFor(other, 'C:\\notes\\n.md', 'text')
    expect(take(52)).toEqual([])
  })

  it('compares the note path as the file system does', () => {
    const tab = new FakeContents(61)
    documentPaths.set(61, process.platform === 'win32' ? 'c:\\Notes\\N.md' : '/notes/./n.md')
    queueMarkdownNoteAppendFor(
      tab,
      process.platform === 'win32' ? 'C:\\notes\\n.md' : '/notes/n.md',
      'x',
    )
    expect(take(61)).toEqual(['x'])
  })

  it('drops the texts of a tab that closed before taking them', () => {
    const tab = new FakeContents(71)
    documentPaths.set(71, 'C:\\n.md')
    queueMarkdownNoteAppendFor(tab, 'C:\\n.md', 'x')
    tab.destroy()
    expect(take(71)).toEqual([])
  })

  it('ignores a tab that is already gone', () => {
    const tab = new FakeContents(81)
    tab.destroyed = true
    documentPaths.set(81, 'C:\\n.md')
    queueMarkdownNoteAppendFor(tab, 'C:\\n.md', 'x')
    expect(tab.sent).toEqual([])
    expect(take(81)).toEqual([])
  })
})

describe('wiring', () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('the preload takes and listens on the note channels, surviving a missing handler', () => {
    const preload = source('../src/preload/index.ts')
    expect(preload).toMatch(
      /takeNoteAppend:[\s\S]*?MARKDOWN_CHANNELS\.noteAppendTake[\s\S]*?catch\(\(\) => \[\]\)/,
    )
    expect(preload).toMatch(/onNoteAppendReady:[\s\S]*?MARKDOWN_CHANNELS\.noteAppendReady/)
  })

  it('the main process answers with the view’s save path (absent for an untitled tab)', () => {
    const main = source('../src/main/markdown-main.ts')
    expect(main).toContain(
      'registerMarkdownNoteAppendIpc({ documentPath: (wcId) => savePathByWc.get(wcId) ?? null })',
    )
  })

  it('the editor takes only for a loaded Markdown file, appends, marks changed and never saves', () => {
    const app = source('../src/renderer/App.tsx')
    const start = app.indexOf('const takeNoteAppends = useCallback(')
    const block = app.slice(start, app.indexOf('}, [flushSource, markDirty])', start))
    expect(start).toBeGreaterThan(0)
    expect(block).toMatch(/statusRef\.current !== 'ready' \|\| !path \|\| isSourceMode/)
    expect(block).toContain('appendMarkdownAtEnd(current, text)')
    expect(block).toContain('markDirty()')
    expect(block).not.toMatch(/markdownApi\.save|doSave/)
    expect(app).toContain('window.markdownApi.onNoteAppendReady?.(')
  })
})
