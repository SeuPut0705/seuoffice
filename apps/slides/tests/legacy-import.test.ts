import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  dir: '',
  handlers: new Map<string, (...args: never[]) => unknown>(),
  skip: false,
  warnings: [] as string[],
  bytes: new Uint8Array(),
  writeSkip: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => state.dir || tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    getAppPath: () => tmpdir(),
    getLocale: () => 'en-US',
    getSystemLocale: () => 'en-US',
    whenReady: async () => {},
    on: () => {},
    once: () => {},
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
  readLegacyImportSkip: () => state.skip,
  writeLegacyImportSkip: (...args: unknown[]) => state.writeSkip(...args),
  showSaveDialogWithMemory: (...args: unknown[]) => state.save(...args),
}))
vi.mock('../../../packages/ppt2pptx/src', async (original) => ({
  ...(await original<object>()),
  convertPptToPptx: async () => ({ bytes: state.bytes, warnings: state.warnings, slideCount: 1 }),
}))
vi.mock('../../../packages/odf2ooxml/src', async (original) => ({
  ...(await original<object>()),
  convertOdpToPptx: async () => ({ pptx: state.bytes }),
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
import { createBlankPptx } from '@genoffice/pptx-engine'
import { setUiLang } from '@genoffice/i18n'
import { registerSlidesIpc } from '../src/main/slides-main'
import { sessions } from '../src/main/session-state'

const sender = { id: 1, isDestroyed: () => false, once: () => {}, on: () => {}, send: () => {} }
async function openSource(ext = 'ppt') {
  const source = join(state.dir, `original.${ext}`)
  writeFileSync(source, 'original bytes')
  const fn = state.handlers.get('slides:open-path')! as (
    ...args: unknown[]
  ) => Promise<{ path: string } | null>
  return fn({ sender }, source, 1280)
}
beforeAll(async () => {
  registerSlidesIpc()
  state.bytes = await createBlankPptx()
})
beforeEach(() => {
  sessions.clear()
  state.dir = mkdtempSync(join(tmpdir(), 'slides-legacy-import-'))
  setUiLang('en')
  state.skip = false
  state.warnings = []
  state.message.mockReset().mockResolvedValue({ response: 0, checkboxChecked: true })
  state.writeSkip.mockReset()
  state.save.mockReset().mockResolvedValue({ canceled: true })
})
afterEach(() => {
  sessions.clear()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('legacy presentation loss disclosure', () => {
  it('always asks for a text-only PPT import even when skip was previously stored', async () => {
    state.skip = true
    await openSource()
    expect(state.message).toHaveBeenCalledTimes(1)
    expect(state.message.mock.calls[0]![0]).not.toHaveProperty('checkboxLabel')
    expect(state.writeSkip).not.toHaveBeenCalled()
  })
  it('suggests an explicitly text-only PPTX name and does not store PPT skip', async () => {
    await openSource()
    expect(state.save.mock.calls[0]![2].defaultPath).toBe(
      join(state.dir, 'original (text only).pptx'),
    )
    expect(state.writeSkip).not.toHaveBeenCalled()
  })
  it('shows converter warnings and opens the written copy', async () => {
    const target = join(state.dir, 'converted.pptx')
    state.save.mockResolvedValue({ canceled: false, filePath: target })
    state.warnings = ['repeated slide reference 7 was omitted']
    expect((await openSource())?.path).toBe(target)
    expect(readFileSync(target)).toEqual(Buffer.from(state.bytes))
    expect(
      state.message.mock.calls.some(
        ([box]) => box.type === 'warning' && box.detail.includes(state.warnings[0]),
      ),
    ).toBe(true)
  })
  it.each(['odp', 'otp'])('keeps %s skip and normal copy name unchanged', async (ext) => {
    await openSource(ext)
    expect(state.message.mock.calls[0]![0]).toHaveProperty('checkboxLabel')
    expect(state.writeSkip).toHaveBeenCalled()
    expect(state.save.mock.calls[0]![2].defaultPath).toBe(join(state.dir, 'original.pptx'))
    state.skip = true
    state.message.mockClear()
    await openSource(ext)
    expect(state.message).not.toHaveBeenCalled()
  })
})
