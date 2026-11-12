/**
 * The name a workbook goes by in the app. A workbook runs on a copy of the
 * file under the temp folder, and the engine names what it opened after the
 * file it was given, which is that copy. The name the renderer is told (the
 * status line's "Opened ...", the loading notices) is the name of the file
 * the person opened. The engine is a stub that names the workbook as the real
 * one does; the file and the copy are real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'
import type { WorkbookFile } from '../src/shared/desktop-api'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown

interface FakeContents {
  id: number
  isDestroyed(): boolean
  isCrashed(): boolean
  send(): void
  on(): void
  once(): void
  removeListener(): void
  setWindowOpenHandler(): void
  loadURL(): Promise<void>
}

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Handler>()
let nextContentsId = 5600

function fakeContents(): FakeContents {
  return {
    id: ++nextContentsId,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
    setWindowOpenHandler: () => {},
    loadURL: () => Promise.resolve(),
  }
}

const userDataDirRef = { value: '' }

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDirRef.value : tmpdir()),
    getName: () => 'sheets-test',
    getVersion: () => '0',
    getAppPath: () => tmpdir(),
    getLocale: () => 'en-US',
    getSystemLocale: () => 'en-US',
    isPackaged: false,
    on: () => {},
    once: () => {},
    quit: () => {},
    whenReady: () => new Promise(() => {}),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => listeners.set(channel, fn),
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static fromWebContents(): null {
      return null
    }
  },
  WebContentsView: class {
    webContents = fakeContents()
  },
  desktopCapturer: {},
  dialog: {},
  net: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

let openCount = 0
/** the files the engine was asked to open, most recent last */
const enginePaths = vi.hoisted(() => [] as string[])

vi.mock('../src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    start(): void {}
    onProcessExit(): void {}
    async close(): Promise<void> {}
    async open(path: string): Promise<unknown> {
      enginePaths.push(path)
      return {
        sessionId: `00000000-0000-4000-9000-${String(++openCount).padStart(12, '0')}`,
        name: basename(path),
        entryCount: 3,
        sheets: [
          {
            id: 'sheet-1',
            name: 'Data',
            rowCount: 4,
            columnCount: 3,
            columnWidths: [],
            defaultRowHeight: 15,
            defaultColumnWidth: 8.43,
            freeze: null,
            hidden: false,
            tabColor: null,
            showGridLines: true,
            tables: [],
            comments: [],
            pivotRanges: [],
          },
        ],
        activeTab: 0,
        styles: [],
        dxfStyles: [],
        visuals: [],
        definedNames: [],
      }
    }
  },
}))

vi.mock('@seuoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { createSheetsView } from '../src/main/sheets-main'

let dir: string

function call(contents: FakeContents, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve().then(() => fn({ sender: contents }, ...args))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seuoffice-sheets-name-'))
  userDataDirRef.value = mkdtempSync(join(tmpdir(), 'seuoffice-sheets-name-user-'))
  enginePaths.length = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDirRef.value, { recursive: true, force: true })
})

describe('the name of an opened workbook', () => {
  it('is the name of the file the person opened, not of the copy the engine reads', async () => {
    const path = join(dir, 'Budget 2026.xlsx')
    writeFileSync(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    const tab = createSheetsView({ includeAiHandlers: false })
      .webContents as unknown as FakeContents
    const opened = (await call(tab, IPC_CHANNELS.reopenWorkbook, path)) as WorkbookFile
    // the engine read a copy that goes by another name
    expect(enginePaths).toHaveLength(1)
    expect(basename(enginePaths[0] ?? '')).not.toBe('Budget 2026.xlsx')
    expect(opened.path).toBe(path)
    expect(opened.name).toBe('Budget 2026.xlsx')
  })
})
