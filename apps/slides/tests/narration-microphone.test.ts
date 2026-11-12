/**
 * Slide Show > Record and the microphone (real main-process handlers and the real permission
 * guard): a page may open the microphone only in the slides editor that started a recording, and
 * only until that recording stops, by whatever way it stops.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// hoisted: the main module registers a listener while it is being imported
const handlers = vi.hoisted(() => new Map<string, (...args: never[]) => unknown>())
const mac = vi.hoisted(() => ({
  status: 'granted' as 'granted' | 'denied' | 'not-determined',
  /** settles the OS question; null while nobody was asked */
  answer: null as null | ((allowed: boolean) => void),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
    once: () => {},
    on: () => {},
  },
  dialog: {},
  clipboard: { writeBuffer: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    removeHandler: () => {},
  },
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  systemPreferences: {
    getMediaAccessStatus: () => mac.status,
    askForMediaAccess: () => new Promise<boolean>((resolve) => (mac.answer = resolve)),
  },
  net: { fetch: async () => new Response() },
  nativeImage: {},
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import { createBlankPptx, openPptx } from '@seuoffice/pptx-engine'
import {
  permissionCheckHandler,
  permissionRequestHandler,
} from '../../../packages/electron-utils/src/permission-guard'
import {
  registerSlidesIpc,
  slidesMicrophoneOpen,
  trackSlidesWebContents,
} from '../src/main/slides-main'
import { sessions } from '../src/main/session-state'

const EDITOR = 1
const OTHER_EDITOR = 2
const NO_DECK = 3
const SLIDES_PAGE = 'genoffice-app://slides/index.html?mode=tab'
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

const eventOf = (id: number) => ({ sender: { id } }) as never
function ipc(id: number, channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return (fn as (...a: unknown[]) => unknown)(eventOf(id), ...args)
}

/** The app's guard, asking the slides main process whether a recording runs */
const policy = { pages: {}, microphoneOpen: slidesMicrophoneOpen }
const onRequest = permissionRequestHandler(policy)
const onCheck = permissionCheckHandler(policy)

/** getUserMedia({ audio }) from the top frame of the slides editor in webContents `id` */
function microphoneOpens(id: number): boolean {
  let answer = false
  onRequest({ id }, 'media', (granted) => (answer = granted), {
    isMainFrame: true,
    requestingUrl: SLIDES_PAGE,
    mediaTypes: ['audio'],
  })
  const checked = onCheck({ id }, 'media', 'genoffice-app://slides', {
    isMainFrame: true,
    requestingUrl: SLIDES_PAGE,
    mediaType: 'audio',
  })
  expect(checked, 'the check answers as the request does').toBe(answer)
  return answer
}

/** A tab as the main process tracks it: its events, and the one method the tracker calls */
function trackedTab(id: number): EventEmitter {
  const wc = Object.assign(new EventEmitter(), { id, setWindowOpenHandler: () => {} })
  trackSlidesWebContents(wc as never)
  return wc
}

const platform = process.platform
function onPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name })
}

beforeAll(() => registerSlidesIpc())

beforeEach(async () => {
  sessions.clear()
  const deck = { path: '', fitWidthPx: 1280, undoStack: [], redoStack: [] }
  sessions.set(EDITOR, { ...deck, opened: await openPptx(await createBlankPptx()) })
  sessions.set(OTHER_EDITOR, { ...deck, opened: await openPptx(await createBlankPptx()) })
  mac.status = 'granted'
  mac.answer = null
  onPlatform('linux')
})

afterEach(() => {
  // every case ends its own recording; a leak here would open the next case's microphone
  for (const id of [EDITOR, OTHER_EDITOR, NO_DECK]) ipc(id, 'slides:microphone-release')
  vi.useRealTimers()
  onPlatform(platform)
})

describe('the microphone while Slide Show > Record runs', () => {
  it('is shut until a recording starts', () => {
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  it('opens for the editor that started the recording, and for no other', async () => {
    expect(await ipc(EDITOR, 'slides:microphone-access')).toBe(true)
    expect(microphoneOpens(EDITOR)).toBe(true)
    expect(microphoneOpens(OTHER_EDITOR)).toBe(false)
  })

  it('does not open for a page with no deck', async () => {
    expect(await ipc(NO_DECK, 'slides:microphone-access')).toBe(false)
    expect(microphoneOpens(NO_DECK)).toBe(false)
  })

  it('shuts when the page says the recording stopped', async () => {
    await ipc(EDITOR, 'slides:microphone-access')
    ipc(EDITOR, 'slides:microphone-release')
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  it('is not shut by another editor', async () => {
    await ipc(EDITOR, 'slides:microphone-access')
    ipc(OTHER_EDITOR, 'slides:microphone-release')
    expect(microphoneOpens(EDITOR)).toBe(true)
  })

  it('shuts when the recording is saved, even one that names no slide of the deck', async () => {
    await ipc(EDITOR, 'slides:microphone-access')
    expect(await ipc(EDITOR, 'slides:save-recording', { slides: [] })).toBeNull()
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  for (const [what, leave] of [
    ['the tab closes', (wc: EventEmitter) => wc.emit('destroyed')],
    ['the page crashes', (wc: EventEmitter) => wc.emit('render-process-gone', {}, {})],
    [
      'the page reloads',
      (wc: EventEmitter) =>
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    ],
  ] as const) {
    it(`shuts when ${what}, without a word from the page`, async () => {
      const wc = trackedTab(EDITOR)
      await ipc(EDITOR, 'slides:microphone-access')
      leave(wc)
      expect(microphoneOpens(EDITOR)).toBe(false)
    })
  }

  it('stays open through navigations that keep the page', async () => {
    const wc = trackedTab(EDITOR)
    await ipc(EDITOR, 'slides:microphone-access')
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(microphoneOpens(EDITOR)).toBe(true)
  })

  it('shuts by itself after four hours if the page never says it stopped', async () => {
    vi.useFakeTimers()
    await ipc(EDITOR, 'slides:microphone-access')
    vi.advanceTimersByTime(FOUR_HOURS_MS - 1000)
    expect(microphoneOpens(EDITOR)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  it('counts the four hours from the latest recording', async () => {
    vi.useFakeTimers()
    await ipc(EDITOR, 'slides:microphone-access')
    vi.advanceTimersByTime(FOUR_HOURS_MS - 1000)
    ipc(EDITOR, 'slides:microphone-release')
    await ipc(EDITOR, 'slides:microphone-access')
    vi.advanceTimersByTime(2000)
    expect(microphoneOpens(EDITOR)).toBe(true)
  })
})

describe('where the OS asks first (macOS)', () => {
  beforeEach(() => onPlatform('darwin'))

  it('stays shut when the person refuses', async () => {
    mac.status = 'not-determined'
    const asked = ipc(EDITOR, 'slides:microphone-access')
    expect(microphoneOpens(EDITOR)).toBe(false)
    mac.answer!(false)
    expect(await asked).toBe(false)
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  it('opens once the person allows it', async () => {
    mac.status = 'not-determined'
    const asked = ipc(EDITOR, 'slides:microphone-access')
    mac.answer!(true)
    expect(await asked).toBe(true)
    expect(microphoneOpens(EDITOR)).toBe(true)
  })

  it('stays shut when the tab closed before the person answered', async () => {
    mac.status = 'not-determined'
    const wc = trackedTab(EDITOR)
    const asked = ipc(EDITOR, 'slides:microphone-access')
    wc.emit('destroyed')
    mac.answer!(true)
    expect(await asked).toBe(false)
    expect(microphoneOpens(EDITOR)).toBe(false)
  })

  for (const [what, stop] of [
    ['stopped', () => ipc(EDITOR, 'slides:microphone-release')],
    [
      'reloaded',
      (wc: EventEmitter) =>
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    ],
  ] as const) {
    it(`stays shut when the recording ${what} before the person answered`, async () => {
      mac.status = 'not-determined'
      const wc = trackedTab(EDITOR)
      const asked = ipc(EDITOR, 'slides:microphone-access')
      stop(wc)
      mac.answer!(true)
      expect(await asked).toBe(false)
      expect(microphoneOpens(EDITOR)).toBe(false)
    })
  }
})
