/**
 * The PPT editor's side of the generate hand-off (spec 8.5), main process: the
 * new tab takes the request the shell left for its webContents — once — and
 * reports a run that started with at least one handed-over material attached.
 * The queue itself is the shared module, run as is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  },
}))

import {
  generateRunStartedEvents,
  queueGenerateHandoff,
  resetGenerateHandoffsForTest,
  type GenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import {
  SLIDES_HANDOFF_RUN_STARTED,
  SLIDES_HANDOFF_TAKE,
  registerGenerateHandoffIpc,
} from '../src/main/generate-handoff-ipc'

const TAB = 41
const OTHER_TAB = 42

function handoff(over: Partial<GenerateHandoff> = {}): GenerateHandoff {
  return {
    id: 'h-1',
    mode: 'ai',
    target: 'slides',
    materials: [
      { path: 'C:\\work\\brief.docx', name: 'brief.docx' },
      { path: 'C:\\work\\plan.xmind', name: 'plan.xmind' },
    ],
    text: 'Make a deck for the kickoff',
    defaultText: false,
    createdAt: 1,
    ...over,
  }
}

type Take = (e: { sender: { id: number } }) => unknown
type Report = (e: { sender: { id: number } }, paths: unknown) => unknown

const take = (id: number) =>
  (handlers.get(SLIDES_HANDOFF_TAKE) as unknown as Take)({ sender: { id } })
const report = (id: number, paths: unknown) =>
  (handlers.get(SLIDES_HANDOFF_RUN_STARTED) as unknown as Report)({ sender: { id } }, paths)

beforeEach(() => {
  handlers.clear()
  resetGenerateHandoffsForTest()
  registerGenerateHandoffIpc()
})

afterEach(() => resetGenerateHandoffsForTest())

describe('slides hand-off channels', () => {
  it('carry the slides: prefix and stay clear of the template-selection channels', () => {
    expect(SLIDES_HANDOFF_TAKE).toBe('slides:handoff-take')
    expect(SLIDES_HANDOFF_RUN_STARTED).toBe('slides:handoff-run-started')
    expect([...handlers.keys()].sort()).toEqual([SLIDES_HANDOFF_RUN_STARTED, SLIDES_HANDOFF_TAKE])
    for (const channel of handlers.keys()) expect(channel).not.toMatch(/ai-template-selection/)
  })

  it('the tab takes its own request once: the text and the materials, nothing else', () => {
    queueGenerateHandoff(TAB, handoff())
    expect(take(TAB)).toEqual({
      id: 'h-1',
      text: 'Make a deck for the kickoff',
      materials: [
        { path: 'C:\\work\\brief.docx', name: 'brief.docx' },
        { path: 'C:\\work\\plan.xmind', name: 'plan.xmind' },
      ],
    })
    // a reload (same webContents) or a second take finds nothing
    expect(take(TAB)).toBeNull()
  })

  it('another tab, or a request made for another kind, takes nothing', () => {
    queueGenerateHandoff(TAB, handoff())
    expect(take(OTHER_TAB)).toBeNull()
    queueGenerateHandoff(OTHER_TAB, handoff({ id: 'h-2', target: 'html' }))
    expect(take(OTHER_TAB)).toBeNull()
    expect(take(TAB)).not.toBeNull()
  })

  it('a run with a handed-over material attached is recorded, once', () => {
    queueGenerateHandoff(TAB, handoff())
    take(TAB)
    expect(report(TAB, ['C:\\work\\plan.xmind', 'C:\\other\\notes.txt'])).toBe(true)
    expect(generateRunStartedEvents()).toEqual([
      expect.objectContaining({
        webContentsId: TAB,
        target: 'slides',
        mode: 'ai',
        sources: ['C:\\work\\plan.xmind'],
        handoffId: 'h-1',
      }),
    ])
    // the next run in the same tab is not a second start
    expect(report(TAB, ['C:\\work\\brief.docx'])).toBe(false)
    expect(generateRunStartedEvents()).toHaveLength(1)
  })

  it('a run with every handed-over material removed is not a start; a later one with them is', () => {
    queueGenerateHandoff(TAB, handoff())
    take(TAB)
    expect(report(TAB, [])).toBe(false)
    expect(report(TAB, ['C:\\other\\notes.txt'])).toBe(false)
    expect(generateRunStartedEvents()).toHaveLength(0)
    expect(report(TAB, ['C:\\work\\brief.docx'])).toBe(true)
    expect(generateRunStartedEvents()).toHaveLength(1)
  })

  it('a tab that took nothing reports nothing, and malformed reports are ignored', () => {
    queueGenerateHandoff(TAB, handoff())
    expect(report(TAB, ['C:\\work\\brief.docx'])).toBe(false)
    take(TAB)
    expect(report(OTHER_TAB, ['C:\\work\\brief.docx'])).toBe(false)
    expect(report(TAB, 'C:\\work\\brief.docx')).toBe(false)
    expect(report(TAB, [42, null])).toBe(false)
    expect(generateRunStartedEvents()).toHaveLength(0)
  })
})
