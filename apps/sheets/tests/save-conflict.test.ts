/**
 * The split-view save guard for the sheets main process: when the same
 * workbook is open in another pane and the disk moved past what this copy
 * read, a manual save asks before overwriting and a background (quiet) save
 * defers silently — while a path open nowhere else keeps the legacy
 * external-change refusal exactly as before. The sidecar, the gateway save
 * and the overwrite dialog are stubs; the files on disk are real.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let lastContents: unknown

interface SaveResult {
  canceled: boolean
  file?: { sessionId: string }
}

const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response: 0 }))

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
    webContents = (lastContents = {
      id: 901,
      isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    })
  },
  desktopCapturer: {},
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  net: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))

/** the per-test userData folder the mocked app reads through getPath */
const userDataDirRef = { value: '' }

// no spreadsheet engine process: a tab only needs a client object to exist,
// and opening a workbook answers with canned metadata
let openCount = 0
function mockOpenResult(): unknown {
  return {
    sessionId: `00000000-0000-4000-8000-${String(++openCount).padStart(12, '0')}`,
    name: 'book.xlsx',
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

vi.mock('../src/main/xlsx-sidecar-client', () => ({
  XlsxSidecarClient: class {
    start(): void {}
    onProcessExit(): void {}
    close(): void {}
    async open(): Promise<unknown> {
      return mockOpenResult()
    }
  },
}))

// the save pipeline's archive writer is stubbed: it lands different bytes on
// the target (an edit is what a real save would carry) without touching the
// engine, which the xlsx-roundtrip tests cover.
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

import { setOpenPathProbe } from '@genoffice/electron-utils'
import { createSheetsView } from '../src/main/sheets-main'

let dir: string

function call(channel: string, ...args: unknown[]): unknown {
  if (!lastContents) createSheetsView({ includeAiHandlers: false })
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return fn({ sender: lastContents as { id: number } }, ...args)
}

function writeWorkbook(name = 'book.xlsx', bytes = 'original-bytes'): string {
  const path = join(dir, name)
  writeFileSync(path, Buffer.from(bytes))
  return path
}

async function openWorkbook(path: string): Promise<{ sessionId: string }> {
  return (await call(IPC_CHANNELS.reopenWorkbook, path)) as { sessionId: string }
}

/** an in-place save with one real cell edit, the way the renderer sends it */
function saveRequest(sessionId: string, extra: Record<string, unknown> = {}): unknown {
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
    ...extra,
  }
}

async function saveWorkbook(
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<SaveResult> {
  return (await call(IPC_CHANNELS.saveWorkbook, saveRequest(sessionId, extra))) as SaveResult
}

const externalBytes = Buffer.from('a different program wrote here')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-sheets-conflict-'))
  userDataDirRef.value = mkdtempSync(join(tmpdir(), 'genoffice-sheets-conflict-user-'))
  showMessageBox.mockReset()
  showMessageBox.mockResolvedValue({ response: 0 })
})

afterEach(() => {
  setOpenPathProbe(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDirRef.value, { recursive: true, force: true })
})

describe('split-view save guard (sheets)', () => {
  it('asks before a manual save overwrites a sibling copy, and cancelling keeps the disk bytes', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)
    writeFileSync(path, externalBytes)

    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await saveWorkbook(opened.sessionId)).toEqual({ canceled: true })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(readFileSync(path)).toEqual(externalBytes)
  })

  it('writes after the user confirms the overwrite', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)
    writeFileSync(path, externalBytes)

    const result = await saveWorkbook(opened.sessionId)
    expect(result.canceled).toBe(false)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(readFileSync(path)).not.toEqual(externalBytes)
  })

  it('leaves a path open nowhere else alone: no dialog, the save simply writes', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)

    // even a dialog answer that would cancel must never be consulted
    showMessageBox.mockResolvedValue({ response: 1 })
    const result = await saveWorkbook(opened.sessionId)
    expect(result.canceled).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('keeps the legacy refusal for a sibling-less manual save of a changed file', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    writeFileSync(path, externalBytes)

    await expect(saveWorkbook(opened.sessionId)).rejects.toThrow()
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(externalBytes)
  })

  it('defers a quiet (AutoSave) save silently while a sibling copy changed the file', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)
    writeFileSync(path, externalBytes)

    expect(await saveWorkbook(opened.sessionId, { quiet: true })).toEqual({ canceled: true })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(externalBytes)
  })

  it('keeps the legacy quiet-save refusal when no sibling copy holds the path', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    writeFileSync(path, externalBytes)

    await expect(saveWorkbook(opened.sessionId, { quiet: true })).rejects.toThrow()
    expect(readFileSync(path)).toEqual(externalBytes)
  })

  it('does not ask when the disk still matches what this copy read', async () => {
    const path = writeWorkbook()
    const opened = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)

    const result = await saveWorkbook(opened.sessionId)
    expect(result.canceled).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('refreshes the recorded state after a successful save', async () => {
    const path = writeWorkbook()
    const first = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)

    const saved = await saveWorkbook(first.sessionId)
    expect(saved.canceled).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()

    // the save wrote different bytes (the stub appends '-saved'); a second
    // save must compare against the saved state, not the open-time one
    const second = await saveWorkbook(saved.file!.sessionId)
    expect(second.canceled).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()

    // and once the disk moves again, the guard wakes back up
    writeFileSync(path, externalBytes)
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await saveWorkbook(second.file!.sessionId)).toEqual({ canceled: true })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(readFileSync(path)).toEqual(externalBytes)
  })

  it('guards the CSV write-back of a converted CSV session', async () => {
    const path = writeWorkbook('table.csv', 'a,b\n1,2\n')
    const opened = await openWorkbook(path)
    setOpenPathProbe((p) => p === path)
    writeFileSync(path, externalBytes)

    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await saveWorkbook(opened.sessionId, { csvContent: 'x,y\r\n' })).toEqual({
      canceled: true,
    })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(readFileSync(path)).toEqual(externalBytes)
  })
})
