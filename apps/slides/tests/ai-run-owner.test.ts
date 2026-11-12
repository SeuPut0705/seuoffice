/**
 * AI edit review across windows and in-flight tool writes (real main-process handlers):
 * a window that goes away takes its run with it, and a tool write that finishes after the run
 * ended must not touch the held deck.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()
const remoteImage = vi.hoisted(() => ({
  release: null as null | (() => void),
  bytes: new Uint8Array(),
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
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  net: { fetch: async () => new Response() },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) }),
  },
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
// The download is the slow step of insert_web_image: the test decides when it finishes
vi.mock('@seuoffice/electron-utils', async () => {
  const actual = await vi.importActual<typeof import('@seuoffice/electron-utils')>(
    '@seuoffice/electron-utils',
  )
  return {
    ...actual,
    fetchRemoteImage: async () => {
      await new Promise<void>((resolve) => (remoteImage.release = resolve))
      return { ok: true }
    },
    readBodyCapped: async () => remoteImage.bytes,
  }
})
vi.mock('../src/main/media-mime', () => ({ rasterImageExt: () => 'png' }))

import { createBlankPptx, openPptx } from '@seuoffice/pptx-engine'
import { registerAiIpc } from '../src/main/ai-ipc'
import { applySessionTxn, registerSlidesIpc, trackSlidesWebContents } from '../src/main/slides-main'
import { sessions, takeSnapshot, type Session } from '../src/main/session-state'
import { trackWrite } from '../src/main/ai-proposal'

const OWNER = 1
const OTHER = 2
const eventOf = (id: number) => ({ sender: { id } }) as never

function ipc(id: number, channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return (fn as (...a: unknown[]) => unknown)(eventOf(id), ...args)
}

/** A window as the main process sees it: events plus the few methods the tracker calls */
function fakeWindow(id: number): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), {
    id,
    setWindowOpenHandler: () => {},
  })
}

let session: Session

beforeAll(() => {
  registerSlidesIpc()
  registerAiIpc()
})

beforeEach(async () => {
  sessions.clear()
  session = {
    path: '',
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(OWNER, session)
  // the same deck opened in a second window shares the session
  sessions.set(OTHER, session)
})

const slideCount = () => session.opened.deck.slides.length

/** An AI edit the way a tool makes it: a history step, then the change */
function aiEdit(): void {
  expect(
    applySessionTxn(session, {
      ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
    })?.applied,
  ).toBe(true)
}

describe('a window that goes away while it owns an AI run', () => {
  for (const event of ['destroyed', 'render-process-gone'] as const) {
    it(`${event}: the run is reverted and the other window is unlocked`, async () => {
      const wc = fakeWindow(OWNER)
      trackSlidesWebContents(wc as never)
      const before = slideCount()
      expect(await ipc(OWNER, 'slides:ai-run-begin')).toBe(true)
      aiEdit()
      expect(slideCount()).toBe(before + 1)

      wc.emit(event, {}, { reason: 'crashed' })

      expect(session.aiRun).toBeUndefined()
      expect(session.aiProposal).toBeUndefined()
      expect(slideCount()).toBe(before)
      // the other window can start its own run: it is not locked out
      expect(await ipc(OTHER, 'slides:ai-run-begin')).toBe(true)
    })
  }

  it('a reload of the owner drops its run too', async () => {
    const wc = fakeWindow(OWNER)
    trackSlidesWebContents(wc as never)
    const before = slideCount()
    await ipc(OWNER, 'slides:ai-run-begin')
    aiEdit()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(session.aiRun).toBeUndefined()
    expect(slideCount()).toBe(before)
  })

  it('a held proposal of the owner goes with it', async () => {
    const wc = fakeWindow(OWNER)
    trackSlidesWebContents(wc as never)
    await ipc(OWNER, 'slides:ai-run-begin')
    aiEdit()
    expect(await ipc(OWNER, 'slides:ai-run-hold')).not.toBeNull()
    expect(session.aiProposal).toBeDefined()
    wc.emit('destroyed')
    expect(session.aiProposal).toBeUndefined()
  })

  it('the other window closing leaves the owner run alone', async () => {
    const wc = fakeWindow(OTHER)
    trackSlidesWebContents(wc as never)
    await ipc(OWNER, 'slides:ai-run-begin')
    aiEdit()
    wc.emit('destroyed')
    expect(session.aiRun).toBeDefined()
  })

  for (const event of ['destroyed', 'render-process-gone'] as const) {
    it(`${event} while its run waits for a save: no run is begun for it`, async () => {
      const wc = fakeWindow(OWNER)
      trackSlidesWebContents(wc as never)
      // the project's TS lib predates Promise.withResolvers
      let finishWrite!: () => void
      const write = trackWrite(session, () => new Promise<void>((r) => (finishWrite = r)))
      // the begin handler reads the window, then waits for the save
      const begin = ipc(OWNER, 'slides:ai-run-begin') as Promise<boolean>

      wc.emit(event, {}, { reason: 'crashed' }) // the owner goes while the save still writes
      finishWrite()
      await write

      expect(await begin).toBe(false)
      expect(session.aiRun).toBeUndefined()
      // the surviving window is not locked out
      expect(await ipc(OTHER, 'slides:ai-run-begin')).toBe(true)
    })
  }
})

describe('a tool write that finishes after its run ended', () => {
  it('insert_web_image after a stop leaves the held proposal fresh', async () => {
    remoteImage.bytes = new Uint8Array([1, 2, 3])
    await ipc(OWNER, 'slides:ai-run-begin')
    aiEdit()
    const insert = ipc(OWNER, 'ai:insert-image-url', {
      slideIndex: 0,
      url: 'https://example.com/a.png',
      xPx: 0,
      yPx: 0,
      wPx: 100,
      hPx: 100,
      fitWidthPx: 1280,
    }) as Promise<unknown>
    await new Promise((r) => setTimeout(r, 0))
    // stop: the run ends while the download is still going
    expect(await ipc(OWNER, 'slides:ai-run-hold')).not.toBeNull()
    const undoLen = session.undoStack.length
    const held = takeSnapshot(session)
    remoteImage.release!()
    expect(await insert).toBeNull()
    expect(session.undoStack.length).toBe(undoLen)
    expect(takeSnapshot(session).slides).toEqual(held.slides)
    expect(await ipc(OWNER, 'slides:ai-proposal-accept')).not.toBeNull()
  })
})
