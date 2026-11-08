/**
 * AI edit review fails closed: while an AI run's edits are in the deck and nobody has accepted
 * them, no save path writes them and the person cannot edit (so nothing of theirs is swept
 * into the revert). Drives the real main-process handlers and the renderer's read-only lock.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as setImmediatePromise } from 'node:timers/promises'
import JSZip from 'jszip'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: never[]) => unknown>(),
  /** what the main process pushed to the editor window, by channel */
  pushed: [] as Array<{ channel: string; payload: unknown }>,
  onPush: null as ((channel: string, payload: unknown) => void) | null,
}))
const handlers = hoisted.handlers

const showSaveDialog = vi.fn(async (..._args: unknown[]) => ({
  canceled: false,
  filePath: undefined as string | undefined,
}))
const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response: 0 }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? hoisted.userDataDir : tmpdir()),
    getName: () => 'slides-test',
    getVersion: () => '0',
    getAppPath: () => tmpdir(),
    getLocale: () => 'en-US',
    getSystemLocale: () => 'en-US',
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: () => {},
    once: () => {},
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
  },
  clipboard: { writeBuffer: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) =>
      hoisted.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => unknown) => hoisted.handlers.set(channel, fn),
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static getFocusedWindow(): null {
      return null
    }
    static fromWebContents(): null {
      return null
    }
  },
  webContents: {
    getAllWebContents: () => [],
    fromId: () => ({
      send: (channel: string, payload: unknown) => {
        hoisted.pushed.push({ channel, payload })
        hoisted.onPush?.(channel, payload)
      },
    }),
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  nativeImage: {},
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => false,
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import { createBlankPptx, openPptx } from '@genoffice/pptx-engine'
import {
  applySessionTxn,
  registerSlidesIpc,
  requestSlidesClose,
  runSlidesRecoveryPass,
  saveSessionDeckTo,
} from '../src/main/slides-main'
import { sessions, takeSnapshot, type Session } from '../src/main/session-state'
import type { HistoryChange } from '../src/shared/ipc'
import { setToastEmitter } from '../src/renderer/components/toast-bus'
import { setAiRunLocked } from '../src/renderer/ai-run-lock'

const WC = 1
const OTHER_WC = 2
const FIT = 1280
const event = (id: number) => ({ sender: { id } }) as never

function call(channel: string, ...args: unknown[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve((fn as (...a: unknown[]) => unknown)(event(WC), ...args))
}
function callFrom(id: number, channel: string, ...args: unknown[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve((fn as (...a: unknown[]) => unknown)(event(id), ...args))
}

const textbox = (y: number, text: string) => ({
  op: 'addElement',
  target: { slide: 0 },
  kind: 'textbox',
  offset: { x: 600000, y, cx: 6000000, cy: 800000 },
  paragraphs: [{ runs: [{ text }] }],
})

const AI_TEXT = 'AI wrote this'
const PERSON_TEXT = 'Person typed this'

let session: Session
let deckPath: string

/** The AI's edit, applied through the same transaction path its tools use */
function aiEdits(): void {
  expect(applySessionTxn(session, { ops: [textbox(4000000, AI_TEXT)] })?.applied).toBe(true)
}

/** Full deck state: slides, archive bytes and size */
function deckState() {
  const { slides, entries, size } = takeSnapshot(session)
  return { slides, entries, size }
}

async function slideXml(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  return zip.file('ppt/slides/slide1.xml')!.async('string')
}

/** Every recovery copy the app wrote, by file name */
function recoveryCopies(): Map<string, Buffer> {
  const dir = join(hoisted.userDataDir, 'slides-autosave')
  const out = new Map<string, Buffer>()
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (name.endsWith('.pptx')) out.set(name, readFileSync(join(dir, name)))
  }
  return out
}

function isHistoryChange(payload: unknown): payload is HistoryChange {
  return typeof payload === 'object' && payload !== null && 'aiRunActive' in payload
}

const tick = () => setImmediatePromise()

beforeAll(() => {
  hoisted.userDataDir = mkdtempSync(join(tmpdir(), 'slides-fail-closed-'))
  // registerSlidesIpc is guarded by a module-level flag, so it must run exactly once
  registerSlidesIpc()
})

beforeEach(async () => {
  sessions.clear()
  hoisted.pushed.length = 0
  hoisted.onPush = null
  showSaveDialog.mockClear()
  showMessageBox.mockClear()
  setAiRunLocked(false)
  deckPath = join(mkdtempSync(join(tmpdir(), 'slides-fail-closed-deck-')), 'deck.pptx')
  session = {
    path: deckPath,
    fitWidthPx: FIT,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(WC, session)
  const seeded = applySessionTxn(session, {
    ops: [textbox(400000, 'Title'), textbox(1600000, 'First point')],
  })
  expect(seeded?.applied).toBe(true)
})

describe('a save while an AI run is in flight', () => {
  it('writes nothing, then writes the pre-run deck once the run is held', async () => {
    await call('slides:ai-run-begin')
    aiEdits()

    expect(await call('slides:save')).toMatchObject({ ok: false, reason: 'ai-review' })
    expect(await call('slides:save', true)).toMatchObject({ ok: false, reason: 'ai-review' })
    expect(existsSync(deckPath)).toBe(false)

    expect(await call('slides:ai-run-hold')).not.toBeNull()
    expect(await call('slides:save')).toMatchObject({ ok: true })
    const xml = await slideXml(deckPath)
    expect(xml).toContain('Title')
    expect(xml).toContain('First point')
    expect(xml).not.toContain(AI_TEXT)
  })

  it('refuses Save As before it asks where, and writes nothing', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: deckPath })
    await call('slides:ai-run-begin')
    aiEdits()

    expect(await call('slides:save-as', 'deck.pptx')).toMatchObject({
      ok: false,
      reason: 'ai-review',
    })
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(existsSync(deckPath)).toBe(false)
  })

  it('writes no recovery copy: the copy on disk stays the pre-run deck', async () => {
    await runSlidesRecoveryPass()
    const before = recoveryCopies()
    expect(before.size).toBe(1)

    await call('slides:ai-run-begin')
    aiEdits()
    await runSlidesRecoveryPass()
    await runSlidesRecoveryPass(true)

    const after = recoveryCopies()
    expect([...after.keys()]).toEqual([...before.keys()])
    for (const [name, bytes] of before) expect(after.get(name)!.equals(bytes)).toBe(true)

    // once the run is held the pre-run deck is what the next copy holds
    await call('slides:ai-run-hold')
    await runSlidesRecoveryPass()
    for (const bytes of recoveryCopies().values()) {
      const zip = await JSZip.loadAsync(bytes)
      expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).not.toContain(AI_TEXT)
    }
  })

  it('refuses the MCP save and the template bytes', async () => {
    await call('slides:ai-run-begin')
    aiEdits()

    await expect(saveSessionDeckTo(session, join(tmpdir(), 'mcp-save.pptx'))).rejects.toThrow(
      /AI request/,
    )
    expect(existsSync(join(tmpdir(), 'mcp-save.pptx'))).toBe(false)
    expect(await call('slides:template-bytes')).toBeNull()

    await call('slides:ai-run-hold')
    expect((await call('slides:template-bytes'))?.bytes).toBeInstanceOf(Uint8Array)
  })

  it('keeps the window open when the close prompt chose Save', async () => {
    await call('slides:ai-run-begin')
    aiEdits()
    // the renderer's answer to the close guard: its save flow, reported back
    const contents = {
      id: WC,
      isDestroyed: () => false,
      send: (channel: string) => {
        if (channel !== 'slides:close-save-request') return
        void call('slides:save').then((r) =>
          callFrom(WC, 'slides:close-save-result', r.ok === true),
        )
      },
    }

    expect(await requestSlidesClose(contents as never)).toBe(false)
    expect(showMessageBox).toHaveBeenCalled()
    expect(existsSync(deckPath)).toBe(false)
  })
})

describe('the person edits while an AI run is in flight', () => {
  /** The editor window's side: the history notice the main process sends turns the lock on and off */
  function attachEditorWindow(): void {
    hoisted.onPush = (channel, payload) => {
      if (channel === 'slides:history-changed' && isHistoryChange(payload)) {
        setAiRunLocked(payload.aiRunActive)
      }
    }
  }

  /** A canvas control: clicking it makes the person's edit, through the ordinary edit IPC */
  function personsControl(): HTMLElement {
    const button = document.createElement('button')
    button.addEventListener('click', () => {
      void call('slides:apply-txn', { ops: [textbox(5000000, PERSON_TEXT)] })
    })
    document.body.append(button)
    return button
  }

  it('is blocked, and after Reject the deck equals the pre-run deck', async () => {
    attachEditorWindow()
    const toasts: string[] = []
    setToastEmitter((toast) => toasts.push(toast.text))
    const control = personsControl()
    const before = deckState()

    await call('slides:ai-run-begin')
    await tick()
    aiEdits()

    control.click()
    await tick()
    expect(JSON.stringify(deckState().slides)).not.toContain(PERSON_TEXT)
    expect(toasts).toHaveLength(1)
    // the history notice reached the window while the run was open
    expect(
      hoisted.pushed.filter((p) => p.channel === 'slides:history-changed').at(-1)?.payload,
    ).toMatchObject({ aiRunActive: true })

    // undo would swap the history the revert depends on: the main process refuses it too
    const undoDepth = session.undoStack.length
    expect(await call('slides:undo')).toBeNull()
    expect(await call('slides:redo')).toBeNull()
    expect(session.undoStack).toHaveLength(undoDepth)

    expect(await call('slides:ai-run-hold')).not.toBeNull()
    await tick()
    expect(deckState()).toEqual(before)
    expect(await call('slides:ai-proposal-reject')).toBe(true)
    expect(deckState()).toEqual(before)

    // the run is over: the person's click edits again
    expect(
      hoisted.pushed.filter((p) => p.channel === 'slides:history-changed').at(-1)?.payload,
    ).toMatchObject({ aiRunActive: false })
    control.click()
    await tick()
    expect(JSON.stringify(deckState().slides)).toContain(PERSON_TEXT)
    setToastEmitter(null)
  })

  it('cannot be begun by a second window while the first window runs', async () => {
    sessions.set(OTHER_WC, session)
    expect(await call('slides:ai-run-begin')).toBe(true)
    aiEdits()
    const during = deckState()

    expect(await callFrom(OTHER_WC, 'slides:ai-run-begin')).toBe(false)
    // and the second window cannot revert the first window's run either
    expect(await callFrom(OTHER_WC, 'slides:ai-run-hold')).toBeNull()
    expect(session.aiRun).toBeDefined()
    expect(deckState()).toEqual(during)
  })

  it('cannot be begun while the deck is in master view', async () => {
    session.masterEdit = {
      partPath: 'ppt/slideMasters/slideMaster1.xml',
      slide: undefined as never,
    }
    expect(await call('slides:ai-run-begin')).toBe(false)
    expect(session.aiRun).toBeUndefined()
  })
})

describe('a run that is never held cleanly still ends reverted', () => {
  it('reverts when the run left its history batch open', async () => {
    const before = deckState()
    await call('slides:history-batch-begin')
    await call('slides:ai-run-begin')
    aiEdits()

    // the renderer never ended the batch
    expect(await call('slides:ai-run-hold')).not.toBeNull()
    expect(session.historyBatch).toBeUndefined()
    expect(session.aiRun).toBeUndefined()
    expect(deckState()).toEqual(before)
  })

  it('reverts a run whose panel is gone before the next run starts from the deck', async () => {
    const before = deckState()
    await call('slides:ai-run-begin')
    aiEdits()

    // the first panel never held its run; the next run begins first
    expect(await call('slides:ai-run-begin')).toBe(true)
    expect(deckState()).toEqual(before)
    expect(await call('slides:ai-run-hold')).toBeNull()
    expect(deckState()).toEqual(before)
  })
})
