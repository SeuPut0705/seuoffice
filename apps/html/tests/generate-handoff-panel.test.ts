import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  defaultAiSettings,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type AiSubscriptionState,
} from '@genoffice/ai-provider'
import type { SubscriptionStatusMap } from '@genoffice/ai-provider/browser'
import { AiPanel, type HtmlAiDeps } from '../src/renderer/ai/AiPanel'
import { buildParseMap, type ParseMap } from '../src/renderer/document/parse-map'
import type { AttachmentMeta, HtmlGenerateHandoff } from '../src/shared/ipc'

/**
 * A new HTML tab opened by "make" (8.5): the panel takes the request left for
 * it, attaches the materials, puts the request in the composer and starts the
 * run through the shared send gate. Against a scripted main process; the
 * provider is never reached — the stream channel is the fake below.
 */

const BLANK = '<!doctype html><html><head><title></title></head><body></body></html>'
const LESSON = 'C:\\materials\\lesson.txt'
const NOTES = 'C:\\materials\\notes.md'
const MINE = 'C:\\elsewhere\\mine.txt'
const REQUEST = 'Make a one-page handout from these'

const meta = (path: string): AttachmentMeta => {
  const name = path.split('\\').pop()!
  return { path, name, ext: name.split('.').pop()!, sizeBytes: 1200 }
}

const statusMap = (
  claude: AiSubscriptionState,
  codex: AiSubscriptionState,
): SubscriptionStatusMap => ({
  'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
  codex: { provider: 'codex', state: codex, meteredAccepted: false },
})

const ready = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  subscriptionNoticeSeen: true,
  ...patch,
})

const handoff = (): HtmlGenerateHandoff => ({
  id: 'h1',
  text: REQUEST,
  materials: [
    { path: LESSON, name: 'lesson.txt' },
    { path: NOTES, name: 'notes.md' },
  ],
})

/**
 * The main process as the panel sees it. The queued request is handed out on
 * the first take only, as the shared queue does; `take` can also reject (no
 * handler: a standalone run).
 */
function fakeMain(opts: {
  settings: AiSettings
  statuses: SubscriptionStatusMap
  queued?: HtmlGenerateHandoff | null
  takeRejects?: boolean
}) {
  const settings = opts.settings
  let statuses = opts.statuses
  let queued = opts.queued ?? null
  const statusListeners = new Set<(next: SubscriptionStatusMap) => void>()
  let streamListener: ((chunk: AiStreamChunk) => void) | null = null
  const requests: AiStreamRequest[] = []
  const reports: string[][] = []
  const takes = vi.fn(async () => {
    if (opts.takeRejects) throw new Error('No handler registered for html:handoff-take')
    const next = queued
    queued = null
    return next
  })
  const htmlApi = {
    getAiSettings: async () => settings,
    setAiSettings: async () => undefined,
    onAiSettingsChanged: () => () => undefined,
    openAiModelSettings: vi.fn(async () => undefined),
    setAiPanelPrefs: vi.fn(async () => ({})),
    subscription: {
      statuses: vi.fn(async () => statuses),
      recheck: vi.fn(async () => statuses),
      login: vi.fn(async () => ({ ok: true })),
      install: vi.fn(async () => ({ ok: true })),
      setMeteredAccepted: vi.fn(async () => ({ ok: true, statuses })),
      onChanged: (listener: (next: SubscriptionStatusMap) => void) => {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
      openInstallHelp: vi.fn(async () => undefined),
    },
    onAiStream: (listener: (chunk: AiStreamChunk) => void) => {
      streamListener = listener
      return () => {
        streamListener = null
      }
    },
    aiStream: async (request: AiStreamRequest) => {
      requests.push(request)
      for (const chunk of [{ type: 'delta', text: 'ok' }, { type: 'done' }]) {
        streamListener?.({ requestId: request.requestId, ...chunk } as AiStreamChunk)
      }
    },
    aiStreamCancel: async () => undefined,
    // the attachments route the user's own picks and drops take
    addAttachmentPaths: vi.fn(async (paths: string[]) => ({
      accepted: paths.map(meta),
      rejected: [],
    })),
    readAttachmentImage: vi.fn(async () => ({ ok: false })),
    takeGenerateHandoff: takes,
    reportGenerateRunStarted: vi.fn(async (paths: string[]) => {
      reports.push(paths)
      return true
    }),
  }
  return {
    htmlApi,
    requests,
    reports,
    takes,
    setStatuses: (next: SubscriptionStatusMap) => {
      statuses = next
      for (const listener of statusListeners) listener(next)
    },
  }
}

function fakeDeps(): HtmlAiDeps {
  let map: ParseMap | null = null
  return {
    access: {
      getText: () => BLANK,
      getVersion: () => 1,
      getMap: () => (map ??= buildParseMap(BLANK, 1, null)),
      getLastManualVersion: () => 0,
      getFilePath: () => null,
      getSelectedSid: () => null,
      applyOps: () => ({ ok: true, ranges: [] }),
      replaceAll: () => undefined,
    },
    getSnapshot: () => ({ text: BLANK }),
    restoreSnapshot: () => undefined,
    onPrompt: () => undefined,
    onRunDone: () => undefined,
    clearHighlights: () => undefined,
    navigateTo: () => undefined,
    onBriefConfirmed: () => undefined,
    previewDraft: () => undefined,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { htmlApi?: unknown }).htmlApi
  vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function panel(filePath: string | null, onGenerateHandoff?: () => void) {
  return createElement(AiPanel, {
    deps: fakeDeps(),
    filePath,
    editQueue: [],
    onQueueEditInstruction: () => undefined,
    onQueueRemove: () => undefined,
    onQueueClear: () => undefined,
    onQueueFocus: () => undefined,
    onQueueConsume: () => undefined,
    onCollapse: () => undefined,
    onGenerateHandoff,
  })
}

async function mountPanel(
  main: ReturnType<typeof fakeMain>,
  filePath: string | null = null,
  onGenerateHandoff?: () => void,
) {
  Object.assign(window, { htmlApi: main.htmlApi })
  act(() => root.render(panel(filePath, onGenerateHandoff)))
  await settle()
}

const composer = () => host.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!
/** the chips in the composer (not the read-only echo on a sent message) */
const composerChips = () =>
  [...host.querySelectorAll('.ai-attachments .ai-attachment-card-name')].map((n) => n.textContent)
const sentChips = () =>
  [...host.querySelectorAll('.ai-msg-attachments .ai-attachment-card-name')].map(
    (n) => n.textContent,
  )
const userBubbles = () => host.querySelectorAll('.ai-msg-user')

async function pressSend() {
  act(() => host.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
  await settle()
}

function removeChip(name: string) {
  const chip = [...host.querySelectorAll('.ai-attachments .ai-attachment-card')].find(
    (c) => c.querySelector('.ai-attachment-card-name')?.textContent === name,
  )!
  act(() => chip.querySelector<HTMLButtonElement>('.ai-attachment-thumb-remove')!.click())
}

describe('a new HTML tab that takes a handed-over request', () => {
  it('attaches the materials, sends the request once with the designed-page intent, and reports the run', async () => {
    const opened = vi.fn()
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('ready', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main, null, opened)

    expect(main.takes).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledTimes(1)
    // the materials went the way a user's own attachments go
    expect(main.htmlApi.addAttachmentPaths).toHaveBeenCalledWith([LESSON, NOTES])
    // exactly one run, carrying the request and the attachment list
    expect(main.requests).toHaveLength(1)
    const sent = JSON.stringify(main.requests[0])
    expect(sent).toContain(REQUEST)
    expect(sent).toContain('lesson.txt')
    expect(sent).toContain('notes.md')
    // the blank-document intent is the designed page, not "write content"
    expect(sent).not.toContain('WRITE CONTENT')
    // the message consumed the composer: echoed on the bubble, composer cleared
    expect(userBubbles()).toHaveLength(1)
    expect(sentChips()).toEqual(['lesson.txt', 'notes.md'])
    expect(composerChips()).toEqual([])
    expect(composer().value).toBe('')
    expect(main.reports).toEqual([[LESSON, NOTES]])
  })

  it('a blocked gate keeps the request and the materials in the panel and starts nothing', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('signed-out', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)

    expect(main.requests).toHaveLength(0)
    expect(host.querySelector('.ai-sub-prompt')).not.toBeNull()
    expect(composer().value).toBe(REQUEST)
    expect(composerChips()).toEqual(['lesson.txt', 'notes.md'])
    expect(userBubbles()).toHaveLength(0)
    expect(main.reports).toEqual([])

    // connecting does not start it by itself: only the user's send does
    act(() => main.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    expect(main.requests).toHaveLength(0)
    expect(composer().value).toBe(REQUEST)

    // the user sends from this tab: that run counts as the start
    await pressSend()
    expect(main.requests).toHaveLength(1)
    expect(JSON.stringify(main.requests[0])).toContain(REQUEST)
    expect(sentChips()).toEqual(['lesson.txt', 'notes.md'])
    expect(main.reports).toEqual([[LESSON, NOTES]])
  })

  it('a send held by the status check starts by itself once a provider can run', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('checking', 'checking'),
      queued: handoff(),
    })
    await mountPanel(main)
    expect(main.requests).toHaveLength(0)
    expect(composer().value).toBe(REQUEST)
    expect(composerChips()).toEqual(['lesson.txt', 'notes.md'])

    act(() => main.setStatuses(statusMap('signed-out', 'ready')))
    await settle()
    expect(main.requests).toHaveLength(1)
    expect(composer().value).toBe('')
    expect(sentChips()).toEqual(['lesson.txt', 'notes.md'])
    expect(main.reports).toEqual([[LESSON, NOTES]])
  })

  it('a first subscription use shows the notice and waits for it, keeping the request', async () => {
    const main = fakeMain({
      settings: ready({ subscriptionNoticeSeen: false }),
      statuses: statusMap('ready', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    expect(main.requests).toHaveLength(0)
    expect(composer().value).toBe(REQUEST)
    expect(composerChips()).toEqual(['lesson.txt', 'notes.md'])
    expect(main.reports).toEqual([])
  })

  it('a run sent with every handed-over material removed is not reported', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('signed-out', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    removeChip('lesson.txt')
    removeChip('notes.md')
    expect(composerChips()).toEqual([])

    act(() => main.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    await pressSend()
    expect(main.requests).toHaveLength(1)
    expect(main.reports).toEqual([])
  })

  it('a run with one handed-over material left is reported', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('signed-out', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    removeChip('lesson.txt')
    act(() => main.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    await pressSend()
    expect(main.requests).toHaveLength(1)
    expect(main.reports).toEqual([[NOTES]])
  })

  it('a follow-up message with nothing attached is not another start', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('ready', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    expect(main.reports).toEqual([[LESSON, NOTES]])
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(composer(), 'and a second page')
      composer().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await pressSend()
    expect(main.requests).toHaveLength(2)
    expect(main.reports).toEqual([[LESSON, NOTES]])
  })

  it("a pasted file of the user's own alone does not count as a start", async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('signed-out', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    removeChip('lesson.txt')
    removeChip('notes.md')
    // the user drops a file of their own instead
    main.htmlApi.addAttachmentPaths.mockImplementationOnce(async () => ({
      accepted: [meta(MINE)],
      rejected: [],
    }))
    Object.assign(main.htmlApi, { getPathForFile: () => MINE })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(drop, {
      dataTransfer: { files: [new File(['x'], 'mine.txt')], types: ['Files'] },
    })
    await act(async () => {
      host.querySelector('aside')!.dispatchEvent(drop)
    })
    await settle()
    expect(composerChips()).toEqual(['mine.txt'])
    act(() => main.setStatuses(statusMap('ready', 'not-installed')))
    await settle()
    await pressSend()
    expect(main.requests).toHaveLength(1)
    expect(main.reports).toEqual([])
  })

  it('a remount or a reload takes nothing and starts nothing', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('ready', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main)
    expect(main.requests).toHaveLength(1)

    act(() => root.unmount())
    root = createRoot(host)
    await mountPanel(main)
    expect(main.takes).toHaveBeenCalledTimes(2)
    expect(main.requests).toHaveLength(1)
    expect(composer().value).toBe('')
    expect(composerChips()).toEqual([])
    expect(main.reports).toEqual([[LESSON, NOTES]])
  })

  it('a tab opened on a file never takes', async () => {
    const opened = vi.fn()
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('ready', 'not-installed'),
      queued: handoff(),
    })
    await mountPanel(main, 'C:\\docs\\page.html', opened)
    expect(main.takes).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(main.requests).toHaveLength(0)
    expect(composer().value).toBe('')
  })

  it('an ordinary new tab (nothing queued) and a standalone run start nothing', async () => {
    for (const takeRejects of [false, true]) {
      const main = fakeMain({
        settings: ready(),
        statuses: statusMap('ready', 'not-installed'),
        queued: null,
        takeRejects,
      })
      await mountPanel(main)
      expect(main.takes).toHaveBeenCalledTimes(1)
      expect(main.requests).toHaveLength(0)
      expect(main.htmlApi.addAttachmentPaths).not.toHaveBeenCalled()
      expect(composer().value).toBe('')
      act(() => root.unmount())
      root = createRoot(host)
    }
  })

  it('an ordinary send in a tab that took nothing is never reported', async () => {
    const main = fakeMain({
      settings: ready(),
      statuses: statusMap('ready', 'not-installed'),
      queued: null,
    })
    await mountPanel(main)
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(composer(), 'make it blue')
      composer().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await pressSend()
    expect(main.requests).toHaveLength(1)
    expect(main.htmlApi.reportGenerateRunStarted).not.toHaveBeenCalled()
  })
})
