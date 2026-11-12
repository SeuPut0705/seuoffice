/**
 * Opening a .pptx that is a compound file: a password-protected deck asks for its password
 * and opens; one whose container does not hold is damaged, which no password opens, so the
 * person is told the file is damaged and is not asked for one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  dir: '',
  handlers: new Map<string, (...args: never[]) => unknown>(),
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
import { encryptOoxml } from '@genoffice/electron-utils/office-encryption'
import { setUiLang } from '@genoffice/i18n'
import { tm } from '../src/main/i18n-main'
import { registerSlidesIpc, setSlidesPasswordPrompt } from '../src/main/slides-main'
import { sessions } from '../src/main/session-state'
import {
  END,
  FAT_SECTOR,
  chained,
  rawCompound,
} from '../../../packages/compound-file/tests/helpers/raw-compound'

const sender = { id: 1, isDestroyed: () => false, once: () => {}, on: () => {}, send: () => {} }
const PASSWORD = 'open sesame'
let protectedDeck: Buffer
/** every time the open path asked for a password */
const asked = vi.fn(async (_retry: boolean): Promise<string | null> => PASSWORD)

async function open(name: string, bytes: Uint8Array): Promise<{ path: string } | null> {
  const path = join(state.dir, name)
  writeFileSync(path, bytes)
  const fn = state.handlers.get('slides:open-path')! as (
    ...args: unknown[]
  ) => Promise<{ path: string } | null>
  return fn({ sender }, path, 1280)
}

/** What the one dialog shown said. */
function shown(): { message: string; detail: string } {
  expect(state.message).toHaveBeenCalledTimes(1)
  const box = state.message.mock.calls[0]!.find(
    (arg: unknown) => typeof arg === 'object' && arg !== null && 'detail' in arg,
  ) as { message: string; detail: string }
  return box
}

beforeAll(async () => {
  registerSlidesIpc()
  protectedDeck = encryptOoxml(Buffer.from(await createBlankPptx()), PASSWORD)
})
beforeEach(() => {
  sessions.clear()
  state.dir = mkdtempSync(join(tmpdir(), 'slides-damaged-open-'))
  setUiLang('en')
  state.message.mockReset().mockResolvedValue({ response: 0 })
  asked.mockClear()
  setSlidesPasswordPrompt(() => ({ ask: asked, close: () => {} }))
})
afterEach(() => {
  setSlidesPasswordPrompt(null)
  sessions.clear()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('opening a .pptx that is a compound file', () => {
  it('asks for the password of a protected deck and opens it', async () => {
    const opened = await open('protected.pptx', protectedDeck)
    expect(opened?.path).toBe(join(state.dir, 'protected.pptx'))
    expect(asked).toHaveBeenCalledTimes(1)
    expect(state.message).not.toHaveBeenCalled()
  })

  it('says a damaged one is damaged, and asks for no password', async () => {
    const damaged = Buffer.from(protectedDeck)
    // the header counts one FAT sector more than the file lists
    damaged.writeUInt32LE(damaged.readUInt32LE(44) + 1, 44)
    expect(await open('damaged.pptx', damaged)).toBeNull()
    expect(asked).not.toHaveBeenCalled()
    const box = shown()
    expect(box.detail).toBe(tm('pptImportFailedBody'))
    expect(box.message).not.toBe(tm('encryptedPptxTitle'))
    expect(box.detail).not.toBe(tm('encryptedPptxBody'))
  })

  it('says it in the language of the interface', async () => {
    setUiLang('ko')
    const damaged = Buffer.from(protectedDeck)
    damaged.writeUInt32LE(damaged.readUInt32LE(44) + 1, 44)
    await open('damaged.pptx', damaged)
    expect(shown().detail).toMatch(/[가-힣]/)
  })

  it('still tells a sound legacy presentation under a .pptx name what it is', async () => {
    const legacy = rawCompound({
      sectors: 10,
      fat: { 0: FAT_SECTOR, 1: END, ...chained(2, 8) },
      entries: [
        { name: 'Root Entry', type: 5, child: 1 },
        { name: 'PowerPoint Document', type: 2, start: 2, size: 4096 },
      ],
    })
    expect(await open('renamed.pptx', legacy)).toBeNull()
    expect(asked).not.toHaveBeenCalled()
    const box = shown()
    expect(box.message).toBe(tm('legacyPptTitle'))
    expect(box.detail).toBe(tm('legacyPptBody'))
  })
})
