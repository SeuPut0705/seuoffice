import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generateRunStartedEvents,
  queueGenerateHandoff,
  resetGenerateHandoffsForTest,
  type GenerateHandoff,
} from '@genoffice/electron-utils/generate-handoff'
import { registerHtmlHandoffIpc } from '../src/main/generate-handoff-ipc'
import { HTML_HANDOFF_CHANNELS } from '../src/shared/ipc'

/**
 * The HTML editor's side of the generate hand-off (8.5) in the main process:
 * its two channels over the shared queue. No AI runs here; the take only hands
 * over what "make" left for this tab, and the report only records it.
 */

const A = join(tmpdir(), 'lesson.txt')
const B = join(tmpdir(), 'notes.md')

const handoff = (patch: Partial<GenerateHandoff> = {}): GenerateHandoff => ({
  id: 'h1',
  mode: 'ai',
  target: 'html',
  materials: [
    { path: A, name: 'lesson.txt' },
    { path: B, name: 'notes.md' },
  ],
  text: 'Make a page from these',
  defaultText: false,
  createdAt: 1,
  ...patch,
})

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

/** an ipcMain stand-in: the channels the module registers, called as a renderer would */
function fakeIpc(fileTabs: number[] = []) {
  const handlers = new Map<string, Handler>()
  registerHtmlHandoffIpc(
    {
      handle: (channel: string, handler: Handler) => {
        if (handlers.has(channel)) throw new Error(`second handler for ${channel}`)
        handlers.set(channel, handler)
      },
    },
    (webContentsId) => fileTabs.includes(webContentsId),
  )
  const call = (channel: string, webContentsId: number, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({ sender: { id: webContentsId } }, ...args)
  }
  return {
    channels: [...handlers.keys()],
    take: (webContentsId: number) => call(HTML_HANDOFF_CHANNELS.take, webContentsId),
    runStarted: (webContentsId: number, paths: unknown) =>
      call(HTML_HANDOFF_CHANNELS.runStarted, webContentsId, paths),
  }
}

afterEach(() => resetGenerateHandoffsForTest())

describe('html hand-off channels', () => {
  it('registers two html-prefixed channels', () => {
    const ipc = fakeIpc()
    expect(ipc.channels.sort()).toEqual(['html:handoff-run-started', 'html:handoff-take'])
  })

  it('hands the request to the tab it was queued for, once', () => {
    const ipc = fakeIpc()
    queueGenerateHandoff(7, handoff())
    expect(ipc.take(8)).toBeNull()
    expect(ipc.take(7)).toEqual({
      id: 'h1',
      text: 'Make a page from these',
      materials: [
        { path: A, name: 'lesson.txt' },
        { path: B, name: 'notes.md' },
      ],
    })
    // a reload or a second mount of the panel takes nothing
    expect(ipc.take(7)).toBeNull()
  })

  it('never hands a request made for another kind', () => {
    const ipc = fakeIpc()
    queueGenerateHandoff(7, handoff({ target: 'slides' }))
    expect(ipc.take(7)).toBeNull()
  })

  it('a tab opened on a file never takes', () => {
    const ipc = fakeIpc([7])
    queueGenerateHandoff(7, handoff())
    expect(ipc.take(7)).toBeNull()
  })

  it('takes nothing when nothing was queued (standalone, a plain new tab)', () => {
    expect(fakeIpc().take(1)).toBeNull()
  })

  it('records a run that started with a handed-over material, the first one only', () => {
    const ipc = fakeIpc()
    queueGenerateHandoff(7, handoff())
    ipc.take(7)
    expect(ipc.runStarted(7, [join(tmpdir(), 'mine.txt')])).toBe(false)
    expect(ipc.runStarted(7, [])).toBe(false)
    expect(generateRunStartedEvents()).toEqual([])
    expect(ipc.runStarted(7, [B, join(tmpdir(), 'mine.txt')])).toBe(true)
    expect(generateRunStartedEvents()).toMatchObject([
      { webContentsId: 7, target: 'html', mode: 'ai', sources: [B], handoffId: 'h1' },
    ])
    expect(ipc.runStarted(7, [A])).toBe(false)
    expect(generateRunStartedEvents()).toHaveLength(1)
  })

  it('records nothing for a tab that did not take, or for a malformed report', () => {
    const ipc = fakeIpc()
    queueGenerateHandoff(7, handoff())
    expect(ipc.runStarted(7, [A])).toBe(false) // queued, not taken
    ipc.take(7)
    expect(ipc.runStarted(9, [A])).toBe(false)
    expect(ipc.runStarted(7, 'not a list')).toBe(false)
    expect(ipc.runStarted(7, [42, null])).toBe(false)
    expect(generateRunStartedEvents()).toEqual([])
  })
})
