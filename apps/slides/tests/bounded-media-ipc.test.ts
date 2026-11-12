import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  message: vi.fn(),
  pick: vi.fn(),
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: async () => {},
    once: () => {},
    on: () => {},
  },
  dialog: { showMessageBox: (...args: unknown[]) => state.message(...args) },
  clipboard: {},
  ipcMain: {
    handle: (key: string, fn: (...args: never[]) => unknown) => state.handlers.set(key, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
    static fromWebContents() {
      return null
    }
  },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  nativeImage: {},
  shell: {},
  desktopCapturer: {},
  WebContentsView: class {},
}))
vi.mock('@genoffice/electron-utils', async (original) => ({
  ...(await original<object>()),
  showOpenDialogWithMemory: (...args: unknown[]) => state.pick(...args),
}))
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => false,
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))
import { createBlankPptx, narrationSpids, openPptx } from '@genoffice/pptx-engine'
import { registerSlidesIpc } from '../src/main/slides-main'
import { sessions } from '../src/main/session-state'
import { setUiLang } from '@genoffice/i18n'
import { encodeWav } from '../src/renderer/narration/wav'

const LIMIT = 50 * 1024 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024
let dir: string
function call(channel: string, ...args: unknown[]): unknown {
  return (state.handlers.get(channel)! as (...args: unknown[]) => unknown)(
    { sender: { id: 1 } },
    ...args,
  )
}
function model(bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46])) {
  return { slideIndex: 0, bytes, name: 'model.glb', aspect: 1, fitWidthPx: 1280 }
}
function recording(wavBase64: string) {
  return { slideIndex: 0, wavBase64, durationMs: 1, advanceMs: 1 }
}
beforeAll(() => registerSlidesIpc())
beforeEach(async () => {
  sessions.clear()
  sessions.set(1, {
    path: '',
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  })
  dir = mkdtempSync(join(tmpdir(), 'slides-bounded-media-'))
  state.message.mockReset().mockResolvedValue({ response: 0 })
  state.pick.mockReset()
  vi.mocked(readFile).mockClear()
  setUiLang('en')
})
afterEach(() => {
  vi.restoreAllMocks()
  sessions.clear()
  rmSync(dir, { recursive: true, force: true })
})
function expectRefused() {
  expect(sessions.get(1)!.undoStack).toHaveLength(0)
  expect(state.message).toHaveBeenCalled()
  expect(state.message.mock.calls[0]![0]).toMatchObject({ type: 'error' })
}
describe('bounded model IPC', () => {
  it('refuses a GLB larger than 50 MiB without reading it', async () => {
    const path = join(dir, 'huge.glb')
    writeFileSync(path, '')
    truncateSync(path, LIMIT + 1)
    state.pick.mockResolvedValue({ canceled: false, filePaths: [path] })
    expect((await call('slides:pick-model3d')) === null).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    expectRefused()
  })
  it('returns a small picked model unchanged', async () => {
    const path = join(dir, 'small.glb')
    writeFileSync(path, model().bytes)
    state.pick.mockResolvedValue({ canceled: false, filePaths: [path] })
    expect(await call('slides:pick-model3d')).toMatchObject({ bytes: model().bytes })
  })
  it('rejects an oversized renderer GLB before a transaction', async () => {
    expect(await call('slides:add-model3d', model(new Uint8Array(LIMIT + 1)))).toBeNull()
    expectRefused()
  })
  it.each([0, 4])(
    'rejects an oversized poster before decoding (extra chars: %i)',
    async (extra) => {
      const from = vi.spyOn(Buffer, 'from')
      expect(
        await call('slides:add-model3d', {
          ...model(),
          posterBase64: 'A'.repeat(4 * Math.ceil(IMAGE_LIMIT / 3) + extra),
        }),
      ).toBeNull()
      expect(from.mock.calls.some((args) => args.at(1) === 'base64')).toBe(false)
      expectRefused()
    },
  )
  it('rejects an oversized replacement poster without changing history', () => {
    const added = call('slides:add-model3d', model()) as { sourceId: string }
    const history = sessions.get(1)!.undoStack.length
    const from = vi.spyOn(Buffer, 'from')
    expect(
      call('slides:set-model3d-view', {
        slideIndex: 0,
        sourceId: added.sourceId,
        rot: { ax: 0, ay: 0, az: 0 },
        posterBase64: 'A'.repeat(4 * Math.ceil(IMAGE_LIMIT / 3)),
      }),
    ).toBeNull()
    expect(from.mock.calls.some((args) => args.at(1) === 'base64')).toBe(false)
    expect(sessions.get(1)!.undoStack).toHaveLength(history)
    expect(state.message).toHaveBeenCalled()
  })
  it('keeps oversized embedded GLB bytes out of the response', async () => {
    const added = call('slides:add-model3d', model()) as { sourceId: string }
    expect(added).toBeTruthy()
    const session = sessions.get(1)!
    const element = session.opened.deck.slides[0]!.elements.find((el) => el.id === added.sourceId)!
    if (element.type !== 'picture' || !element.model3d?.target) throw new Error('missing model')
    session.opened.archive.entries.set(element.model3d.target, new Uint8Array(LIMIT + 1))
    expect((await call('slides:model3d-data', 0, added.sourceId)) === null).toBe(true)
    expect(state.message).toHaveBeenCalled()
  })
  it('round-trips a small model', () => {
    const added = call('slides:add-model3d', model()) as { sourceId: string }
    expect(call('slides:model3d-data', 0, added.sourceId)).toEqual(model().bytes)
  })
})
describe('bounded narration request', () => {
  it.each([0, 4])('rejects oversized base64 before decoding (extra chars: %i)', async (extra) => {
    const from = vi.spyOn(Buffer, 'from')
    expect(
      await call('slides:save-recording', {
        slides: [recording('A'.repeat(4 * Math.ceil(LIMIT / 3) + extra))],
      }),
    ).toBeNull()
    expect(from.mock.calls.some((args) => args.at(1) === 'base64')).toBe(false)
    expectRefused()
  })
  it('bounds the sum, not just each recording segment', async () => {
    const chunk = 'A'.repeat(4 * Math.ceil((LIMIT / 2 + 1) / 3))
    const from = vi.spyOn(Buffer, 'from')
    expect(
      await call('slides:save-recording', { slides: [recording(chunk), recording(chunk)] }),
    ).toBeNull()
    expect(from.mock.calls.some((args) => args.at(1) === 'base64')).toBe(false)
    expectRefused()
  })
  it('stores valid small narration in one undo step', () => {
    const wav = Buffer.from(encodeWav(new Float32Array([0, 0.1]), 24000)).toString('base64')
    expect(call('slides:save-recording', { slides: [recording(wav)] })).not.toBeNull()
    expect(narrationSpids(sessions.get(1)!.opened.deck.slides[0]!)).toHaveLength(1)
    expect(sessions.get(1)!.undoStack).toHaveLength(1)
  })
})
