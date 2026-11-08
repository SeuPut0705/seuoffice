// @vitest-environment node
/**
 * Split-view copy pairs (decision 0036): while the same map is open in two
 * panes, a save from one copy must not silently clobber a write the sibling
 * pane made in the meantime. A manual save asks first and cancel keeps the
 * disk copy; an automatic save defers silently. Without a copy pair the save
 * behaves exactly as before, and the bytes written are untouched by the guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const showMessageBox = vi.fn()
const showSaveDialog = vi.fn()

interface FakeContents {
  id: number
  sent: Array<[string, ...unknown[]]>
  destroyed: boolean
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null
  listeners: Map<string, (...args: unknown[]) => void>
  isDestroyed(): boolean
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void
  loadURL(url: string): Promise<void>
  getURL(): string
  send(channel: string, ...args: unknown[]): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
}

let nextId = 1
function fakeContents(): FakeContents {
  const contents: FakeContents = {
    id: nextId++,
    sent: [],
    destroyed: false,
    windowOpenHandler: null,
    listeners: new Map(),
    isDestroyed: () => contents.destroyed,
    setWindowOpenHandler: (handler) => {
      contents.windowOpenHandler = handler
    },
    loadURL: async () => {},
    getURL: () => '',
    send: (channel, ...args) => {
      contents.sent.push([channel, ...args])
    },
    on: (event, listener) => {
      contents.listeners.set(event, listener)
    },
    once: (event, listener) => {
      contents.listeners.set(event, listener)
    },
  }
  return contents
}

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: () => new Promise(() => {}),
    getPath: (name: string) => join(tmpdir(), `mindmap-test-${name}`),
    getLocale: () => 'en-US',
  },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
  },
  shell: { openExternal: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  net: {},
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  WebContentsView: class {
    webContents = fakeContents()
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: vi.fn(),
  },
}))

import { setOpenPathProbe } from '@genoffice/electron-utils'
import { createXmindDocument } from '@genoffice/xmind-engine'
import { createMindmapView } from '../src/main/mindmap-main'
import { MINDMAP_CHANNELS } from '../src/shared/ipc'
import type { OpenFileResult, SaveMindmapResult } from '../src/shared/ipc'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-mindmap-save-conflict-'))
  showMessageBox.mockReset()
  showSaveDialog.mockReset()
})

afterEach(() => {
  setOpenPathProbe(null)
  rmSync(dir, { recursive: true, force: true })
})

async function mapBytes(rootTitle: string): Promise<Uint8Array> {
  const document = await createXmindDocument({ sheetTitle: 'Sheet 1', rootTitle })
  return document.save()
}

const view = (openPath: string): FakeContents =>
  createMindmapView(openPath).webContents as unknown as FakeContents

const open = (contents: FakeContents, path: string) =>
  handlers.get(MINDMAP_CHANNELS.openFile)!({ sender: contents }, path) as Promise<OpenFileResult>

const save = (contents: FakeContents, request: unknown) =>
  handlers.get(MINDMAP_CHANNELS.save)!({ sender: contents }, request) as Promise<SaveMindmapResult>

const externalWrite = async (path: string): Promise<Buffer> => {
  const bytes = Buffer.from(await mapBytes('Changed by the other pane'))
  writeFileSync(path, bytes)
  return bytes
}

/** A view whose renderer opened the file, which records the disk state */
async function openedView(path: string): Promise<FakeContents> {
  const contents = view(path)
  expect((await open(contents, path)).status).toBe('ok')
  return contents
}

describe('a save with no copy pair is unchanged', () => {
  it('does not ask anything even when another program changed the disk', async () => {
    const path = join(dir, 'map.xmind')
    writeFileSync(path, await mapBytes('Original'))
    const contents = await openedView(path)
    await externalWrite(path)

    const edited = await mapBytes('Edited here')
    expect(await save(contents, { bytes: edited, mode: 'save' })).toEqual({ ok: true, path })
    expect(readFileSync(path).equals(Buffer.from(edited))).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('a copy pair holds this map (the path is open in another pane)', () => {
  it('defers an automatic save silently, keeping the sibling pane’s bytes', async () => {
    const path = join(dir, 'map.xmind')
    writeFileSync(path, await mapBytes('Original'))
    const contents = await openedView(path)
    const sibling = await externalWrite(path)
    setOpenPathProbe((each) => each === path)

    const edited = await mapBytes('Edited here')
    expect(await save(contents, { bytes: edited, mode: 'save', auto: true })).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(path).equals(sibling)).toBe(true)
  })

  it('asks before a manual save, and cancel keeps the disk copy', async () => {
    const path = join(dir, 'map.xmind')
    writeFileSync(path, await mapBytes('Original'))
    const contents = await openedView(path)
    const sibling = await externalWrite(path)
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })

    const edited = await mapBytes('Edited here')
    expect(await save(contents, { bytes: edited, mode: 'save' })).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(showMessageBox.mock.calls[0]![0]).toMatchObject({ type: 'warning' })
    expect(readFileSync(path).equals(sibling)).toBe(true)
  })

  it('writes byte for byte when the user overwrites, and the next save asks nothing', async () => {
    const path = join(dir, 'map.xmind')
    writeFileSync(path, await mapBytes('Original'))
    const contents = await openedView(path)
    await externalWrite(path)
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })

    const edited = await mapBytes('Edited here')
    expect(await save(contents, { bytes: edited, mode: 'save' })).toEqual({ ok: true, path })
    expect(readFileSync(path).equals(Buffer.from(edited))).toBe(true)

    // the record was refreshed on save: the disk still matches it, so no second question
    const again = await mapBytes('Edited again')
    expect(await save(contents, { bytes: again, mode: 'save' })).toEqual({ ok: true, path })
    expect(readFileSync(path).equals(Buffer.from(again))).toBe(true)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while the disk still matches this copy’s own record', async () => {
    const path = join(dir, 'map.xmind')
    writeFileSync(path, await mapBytes('Original'))
    const contents = await openedView(path)
    setOpenPathProbe((each) => each === path)

    const edited = await mapBytes('Edited here')
    expect(await save(contents, { bytes: edited, mode: 'save' })).toEqual({ ok: true, path })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
