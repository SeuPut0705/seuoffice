import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateHandoff } from '../src/shared/generate-api'
import {
  dropGenerateHandoff,
  generateRunStartedEvents,
  queueGenerateHandoff,
  queueGenerateHandoffFor,
  queuedGenerateHandoffs,
  reportGenerateRunStarted,
  resetGenerateHandoffsForTest,
  setGenerateTabIdResolver,
  takeGenerateHandoff,
} from '../src/main/generate/handoff'

/** 8.5: the request is queued for one new tab and taken there exactly once */

const A = join(tmpdir(), 'a.docx')
const B = join(tmpdir(), 'b.pdf')

function handoff(overrides: Partial<GenerateHandoff> = {}): GenerateHandoff {
  return {
    id: 'h1',
    mode: 'ai',
    target: 'slides',
    materials: [
      { path: A, name: 'a.docx' },
      { path: B, name: 'b.pdf' },
    ],
    text: 'make it short',
    defaultText: false,
    createdAt: 1,
    ...overrides,
  }
}

class FakeContents extends EventEmitter {
  destroyed = false
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

afterEach(() => resetGenerateHandoffsForTest())

describe('taking the queued request', () => {
  it('hands the request to its tab once; a second take gets nothing', () => {
    queueGenerateHandoff(7, handoff())
    expect(takeGenerateHandoff('slides', 7)).toEqual(handoff())
    expect(takeGenerateHandoff('slides', 7)).toBeNull()
  })

  it('gives nothing to another tab, and leaves the request for its own', () => {
    queueGenerateHandoff(7, handoff())
    expect(takeGenerateHandoff('slides', 8)).toBeNull()
    expect(takeGenerateHandoff('slides', 7)?.id).toBe('h1')
  })

  it('gives nothing to an editor of another kind, and does not use the request up', () => {
    queueGenerateHandoff(7, handoff({ target: 'mindmap' }))
    expect(takeGenerateHandoff('html', 7)).toBeNull()
    expect(takeGenerateHandoff('slides', 7)).toBeNull()
    expect(takeGenerateHandoff('mindmap', 7)?.target).toBe('mindmap')
  })

  it('a reload after the take gets nothing', () => {
    queueGenerateHandoff(7, handoff())
    takeGenerateHandoff('slides', 7)
    // the renderer reloads and asks again
    expect(takeGenerateHandoff('slides', 7)).toBeNull()
  })

  it('drops the request when the tab closes before taking it', () => {
    const contents = new FakeContents(9)
    queueGenerateHandoffFor(contents, handoff({ target: 'html' }))
    expect(queuedGenerateHandoffs()).toEqual([{ webContentsId: 9, target: 'html', id: 'h1' }])
    contents.destroy()
    expect(queuedGenerateHandoffs()).toEqual([])
    expect(takeGenerateHandoff('html', 9)).toBeNull()
  })

  it('drops it when the tab manager removes the tab', () => {
    queueGenerateHandoff(9, handoff())
    dropGenerateHandoff(9)
    expect(takeGenerateHandoff('slides', 9)).toBeNull()
  })

  it('does not queue for a webContents that is already gone', () => {
    const contents = new FakeContents(3)
    contents.destroyed = true
    queueGenerateHandoffFor(contents, handoff())
    expect(queuedGenerateHandoffs()).toEqual([])
  })

  it('lists what waits without the request text', () => {
    queueGenerateHandoff(4, handoff({ id: 'x', text: 'private words' }))
    expect(JSON.stringify(queuedGenerateHandoffs())).not.toContain('private words')
  })
})

describe('run-started events', () => {
  it('records the tab, the attached handed-over sources and the mode, in memory', () => {
    setGenerateTabIdResolver((id) => (id === 7 ? 't3' : undefined))
    queueGenerateHandoff(7, handoff())
    takeGenerateHandoff('slides', 7)
    const event = reportGenerateRunStarted('slides', 7, [B, join(tmpdir(), 'other.txt')])
    expect(event).toMatchObject({
      tabId: 't3',
      webContentsId: 7,
      target: 'slides',
      mode: 'ai',
      sources: [B],
      handoffId: 'h1',
    })
    expect(generateRunStartedEvents()).toHaveLength(1)
    expect(generateRunStartedEvents()[0]).toMatchObject({ tabId: 't3', sources: [B] })
  })

  it('records nothing when no handed-over material was attached', () => {
    queueGenerateHandoff(7, handoff())
    takeGenerateHandoff('slides', 7)
    expect(reportGenerateRunStarted('slides', 7, [])).toBeNull()
    expect(reportGenerateRunStarted('slides', 7, [join(tmpdir(), 'mine.txt')])).toBeNull()
    expect(generateRunStartedEvents()).toEqual([])
    // the user attaches one of them later and runs: that run counts
    expect(reportGenerateRunStarted('slides', 7, [A])?.sources).toEqual([A])
  })

  it('records nothing for a tab that never took a request, or another kind', () => {
    expect(reportGenerateRunStarted('slides', 7, [A])).toBeNull()
    queueGenerateHandoff(7, handoff())
    expect(reportGenerateRunStarted('slides', 7, [A])).toBeNull() // queued, not taken
    takeGenerateHandoff('slides', 7)
    expect(reportGenerateRunStarted('html', 7, [A])).toBeNull()
    expect(generateRunStartedEvents()).toEqual([])
  })

  it('records the first run of a hand-off only', () => {
    queueGenerateHandoff(7, handoff())
    takeGenerateHandoff('slides', 7)
    expect(reportGenerateRunStarted('slides', 7, [A])).not.toBeNull()
    expect(reportGenerateRunStarted('slides', 7, [A])).toBeNull()
    expect(generateRunStartedEvents()).toHaveLength(1)
  })

  it('keeps events per tab apart', () => {
    queueGenerateHandoff(1, handoff({ id: 'one', target: 'html' }))
    queueGenerateHandoff(2, handoff({ id: 'two', target: 'mindmap' }))
    takeGenerateHandoff('html', 1)
    takeGenerateHandoff('mindmap', 2)
    reportGenerateRunStarted('mindmap', 2, [A])
    reportGenerateRunStarted('html', 1, [B])
    expect(
      generateRunStartedEvents().map((e) => [e.webContentsId, e.handoffId, e.sources]),
    ).toEqual([
      [2, 'two', [A]],
      [1, 'one', [B]],
    ])
  })

  it('shares one store across bundled copies of the module', () => {
    queueGenerateHandoff(5, handoff())
    const holder = (globalThis as Record<symbol, { queued: Map<number, unknown> }>)[
      Symbol.for('genoffice.generate-handoff')
    ]
    expect(holder.queued.has(5)).toBe(true)
  })
})
