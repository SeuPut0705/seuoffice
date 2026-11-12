/**
 * Review › Change Password in the main process: the length Excel accepts is
 * the length this accepts, and what the tab is told is what happened to the
 * file. The spreadsheet engine and the archive writer are stubs; the workbook
 * file and its encryption are real.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptOfficeFile, encryptOoxml } from '@genoffice/electron-utils/office-encryption'
import { WORKBOOK_PASSWORD_MAX_LENGTH } from '../src/shared/desktop-api'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

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
let nextContentsId = 700

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
    on: () => {},
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

/**
 * How the next write of the workbook file ends: as it does, or failing after
 * the new bytes are on the disk (the cleanup behind the rename), or failing
 * before anything was written.
 */
const nextWrite = vi.hoisted(() => ({ fails: 'no' as 'no' | 'after-landing' | 'before-writing' }))

vi.mock('../src/main/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/atomic-write')>()
  return {
    atomicWriteFile: async (path: string, data: Buffer) => {
      const fails = nextWrite.fails
      nextWrite.fails = 'no'
      if (fails === 'before-writing') throw new Error('EACCES: the folder is read-only')
      await actual.atomicWriteFile(path, data)
      if (fails === 'after-landing') throw new Error('EIO: cleanup after the write failed')
    },
  }
})

let openCount = 0

vi.mock('../src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    start(): void {}
    onProcessExit(): void {}
    async close(): Promise<void> {}
    async open(path: string): Promise<unknown> {
      return {
        sessionId: `00000000-0000-4000-8000-${String(++openCount).padStart(12, '0')}`,
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
  },
}))

// the archive writer is stubbed: it lands the bytes it read plus a mark
vi.mock('@genoffice/xlsx-gateway/gateway/xlsx-package-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveWorkbookViaSidecar: async (request: { sourcePath: string; targetPath: string }) => {
    const bytes = await readFile(request.sourcePath)
    await writeFile(request.targetPath, Buffer.concat([bytes, Buffer.from('-saved')]))
    return { touchedEntries: [], removedEntries: [], addedEntries: [] }
  },
}))

vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))

import { createSheetsView, setSheetsPasswordPrompt } from '../src/main/sheets-main'

// encryption treats the package as opaque bytes, and decryption only checks
// that what comes out starts like a zip
const PLAIN = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('secret-bytes')])
const OLD = 'first-password'
const NEW = 'second-password'

let dir: string
let path: string

function call(contents: FakeContents, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve().then(() => fn({ sender: contents }, ...args))
}

/** a tab with the password workbook open, as the person who knows `OLD` has it */
async function openProtected(): Promise<{ tab: FakeContents; sessionId: string }> {
  const tab = createSheetsView({ includeAiHandlers: false }).webContents as unknown as FakeContents
  const opened = (await call(tab, IPC_CHANNELS.reopenWorkbook, path)) as { sessionId: string }
  return { tab, sessionId: opened.sessionId }
}

function changePassword(tab: FakeContents, sessionId: string, newPassword: string) {
  return call(tab, IPC_CHANNELS.updateWorkbookPassword, { sessionId, newPassword })
}

/** the password the file on disk opens with */
async function opensWith(password: string): Promise<boolean> {
  try {
    return (await decryptOfficeFile(readFileSync(path), password)).length > 0
  } catch {
    return false
  }
}

function saveRequest(sessionId: string): unknown {
  return {
    sessionId,
    mode: 'save',
    edits: [{ sheetId: 'sheet-1', row: 0, column: 0, writeValue: true, value: 'edited' }],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    visualAdditions: [],
    tableAdditions: [],
    pivotAdditions: [],
    sheetOps: [],
    sheetOrder: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    pageSetupStates: [],
    noteStates: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    sheetProtections: [],
    sparklineAdditions: [],
    definedNamesState: null,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-sheets-password-'))
  userDataDirRef.value = mkdtempSync(join(tmpdir(), 'genoffice-sheets-password-user-'))
  path = join(dir, 'secret.xlsx')
  writeFileSync(path, encryptOoxml(PLAIN, OLD))
  nextWrite.fails = 'no'
  setSheetsPasswordPrompt(() => ({ ask: async (retry) => (retry ? null : OLD), close: () => {} }))
})

afterEach(() => {
  setSheetsPasswordPrompt(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDirRef.value, { recursive: true, force: true })
})

// every case unlocks or locks the file several times: the key derivation is deliberately slow
describe('changing the open password of a workbook', { timeout: 120_000 }, () => {
  it('takes the longest password Excel accepts', async () => {
    const { tab, sessionId } = await openProtected()
    const longest = 'x'.repeat(WORKBOOK_PASSWORD_MAX_LENGTH)
    await changePassword(tab, sessionId, longest)
    expect(await opensWith(longest)).toBe(true)
  })

  it('refuses one character more and leaves the file as it was', async () => {
    const { tab, sessionId } = await openProtected()
    const before = readFileSync(path)
    await expect(
      changePassword(tab, sessionId, 'x'.repeat(WORKBOOK_PASSWORD_MAX_LENGTH + 1)),
    ).rejects.toThrow()
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('reports the change when the write fails after the new bytes are on the disk', async () => {
    const { tab, sessionId } = await openProtected()
    nextWrite.fails = 'after-landing'
    // the file now opens only with the new password: "failed" would send the
    // person back to a password that no longer opens it
    await expect(changePassword(tab, sessionId, NEW)).resolves.toBeUndefined()
    expect(await opensWith(NEW)).toBe(true)
    expect(await opensWith(OLD)).toBe(false)

    // and the session follows the file: the next save is not refused as a
    // change made behind its back, and keeps the new password
    const saved = (await call(tab, IPC_CHANNELS.saveWorkbook, saveRequest(sessionId))) as {
      canceled: boolean
    }
    expect(saved.canceled).toBe(false)
    expect(await opensWith(NEW)).toBe(true)
    expect(await opensWith(OLD)).toBe(false)
  })

  it('still reports a failure when the write left the file as it was', async () => {
    const { tab, sessionId } = await openProtected()
    const before = readFileSync(path)
    nextWrite.fails = 'before-writing'
    await expect(changePassword(tab, sessionId, NEW)).rejects.toThrow(/read-only/)
    expect(readFileSync(path).equals(before)).toBe(true)

    // the session still holds the password the file has
    const saved = (await call(tab, IPC_CHANNELS.saveWorkbook, saveRequest(sessionId))) as {
      canceled: boolean
    }
    expect(saved.canceled).toBe(false)
    expect(await opensWith(OLD)).toBe(true)
  })
})
