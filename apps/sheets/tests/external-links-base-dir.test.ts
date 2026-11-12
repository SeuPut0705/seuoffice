/**
 * External links of a password workbook. Such a workbook runs on a decrypted
 * copy in a temp folder (decision 0041), while "Sales.xlsx beside this file"
 * means beside the file the person opened. The engine is a stub that resolves
 * a relative target the way the real one does: against the base folder it is
 * given, or the workbook's own folder when it is given none. The workbook
 * file, its encryption and the source beside it are real.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptOoxml } from '@seuoffice/electron-utils/office-encryption'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'
import type { ExternalLinksResult, ExternalLinksUpdateResult } from '../src/shared/desktop-api'

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
/** the files Locate showed in the file manager */
const revealed: string[] = []
let nextContentsId = 5200

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
  shell: { showItemInFolder: (path: string) => revealed.push(path) },
  systemPreferences: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

/** what the engine was asked for an update, most recent last */
const updates = vi.hoisted(() => [] as { allowRemoteSources?: boolean }[])

let openCount = 0

vi.mock('../src/main/xlsx-sidecar-client', () => {
  /** the one link of the test workbook, resolved as the engine resolves a relative target */
  const link = (input: { path: string; baseDir?: string }) => ({
    index: 1,
    rawTarget: 'Sales.xlsx',
    source: join(input.baseDir ?? dirname(input.path), 'Sales.xlsx'),
    sheetNames: ['Sheet1'],
  })
  return {
    XlsxSidecarClient: class {
      start(): void {}
      onProcessExit(): void {}
      async close(): Promise<void> {}
      async open(path: string): Promise<unknown> {
        return {
          sessionId: `00000000-0000-4000-9000-${String(++openCount).padStart(12, '0')}`,
          name: basename(path),
          entryCount: 3,
          sheets: [
            {
              id: 'sheet-1',
              name: 'Data',
              rowCount: 20,
              columnCount: 10,
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
      async listExternalLinks(input: {
        path: string
        baseDir?: string
      }): Promise<ExternalLinksResult> {
        return { links: [link(input)] }
      }
      async updateExternalLinks(input: {
        path: string
        baseDir?: string
        allowRemoteSources?: boolean
      }): Promise<ExternalLinksUpdateResult> {
        updates.push(input)
        const found = link(input)
        return { links: [{ ...found, reachable: existsSync(found.source) }], cells: [] }
      }
    },
  }
})

vi.mock('@seuoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { createSheetsView, setSheetsPasswordPrompt } from '../src/main/sheets-main'

// encryption treats the package as opaque bytes, and decryption only checks
// that what comes out starts like a zip
const PLAIN = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('secret-bytes')])

let dir: string
let source: string

function call(contents: FakeContents, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve().then(() => fn({ sender: contents }, ...args))
}

async function openWorkbook(path: string): Promise<{ tab: FakeContents; sessionId: string }> {
  const tab = createSheetsView({ includeAiHandlers: false }).webContents as unknown as FakeContents
  const opened = (await call(tab, IPC_CHANNELS.reopenWorkbook, path)) as { sessionId: string }
  return { tab, sessionId: opened.sessionId }
}

/** a workbook with an open password, in the folder that also holds its link's source */
function openProtected(): Promise<{ tab: FakeContents; sessionId: string }> {
  const path = join(dir, 'Report.xlsx')
  writeFileSync(path, encryptOoxml(PLAIN, 'pw'))
  return openWorkbook(path)
}

/** Locate is sent, not invoked: wait for the file manager to be asked */
async function locate(tab: FakeContents, sessionId: string): Promise<string | undefined> {
  revealed.length = 0
  listeners.get(IPC_CHANNELS.revealLinkSource)!({ sender: tab }, { sessionId, index: 1 })
  await vi.waitFor(() => expect(revealed).toHaveLength(1), { timeout: 2_000 }).catch(() => {})
  return revealed[0]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seuoffice-sheets-links-'))
  userDataDirRef.value = mkdtempSync(join(tmpdir(), 'seuoffice-sheets-links-user-'))
  source = join(dir, 'Sales.xlsx')
  writeFileSync(source, 'source-bytes')
  updates.length = 0
  setSheetsPasswordPrompt(() => ({ ask: async (retry) => (retry ? null : 'pw'), close: () => {} }))
})

afterEach(() => {
  setSheetsPasswordPrompt(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDirRef.value, { recursive: true, force: true })
})

// each case unlocks the file: the key derivation is deliberately slow
describe('a relative link of a password workbook', { timeout: 60_000 }, () => {
  it('is listed beside the file the person opened, not beside the decrypted copy', async () => {
    const { tab, sessionId } = await openProtected()
    const listing = (await call(tab, IPC_CHANNELS.listExternalLinks, {
      sessionId,
    })) as ExternalLinksResult
    expect(listing.links[0]?.source).toBe(source)
  })

  it('is found by Update', async () => {
    const { tab, sessionId } = await openProtected()
    const report = (await call(tab, IPC_CHANNELS.updateExternalLinks, {
      sessionId,
    })) as ExternalLinksUpdateResult
    expect(report.links[0]).toMatchObject({ source, reachable: true })
  })

  it('is shown by Locate', async () => {
    const { tab, sessionId } = await openProtected()
    expect(await locate(tab, sessionId)).toBe(source)
  })
})

describe('a workbook that is its own file', () => {
  it('still resolves a relative link beside itself', async () => {
    const path = join(dir, 'Plain.xlsx')
    writeFileSync(path, PLAIN)
    const { tab, sessionId } = await openWorkbook(path)
    const listing = (await call(tab, IPC_CHANNELS.listExternalLinks, {
      sessionId,
    })) as ExternalLinksResult
    expect(listing.links[0]?.source).toBe(source)
    expect(await locate(tab, sessionId)).toBe(source)
  })

  it('the Update button reads a source on another computer, as the person asked', async () => {
    const path = join(dir, 'Plain.xlsx')
    writeFileSync(path, PLAIN)
    const { tab, sessionId } = await openWorkbook(path)
    await call(tab, IPC_CHANNELS.updateExternalLinks, { sessionId })
    expect(updates.at(-1)?.allowRemoteSources).toBe(true)
  })
})
