// @vitest-environment node
/**
 * Split-view copy pairs (decision 0036): while the same document is open in two
 * panes, a save from one copy must not silently clobber a write the sibling
 * pane made in the meantime. A manual save asks first and cancel keeps the
 * disk copy; an automatic save (the app's own autosave) defers silently.
 * Without a copy pair the save behaves exactly as before.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}

const handlers = new Map<string, IpcHandler>()
const showMessageBox = vi.fn()
const webContents: FakeWebContents[] = []
let nextWebContentsId = 1

function makeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const contents: FakeWebContents = {
    id: nextWebContentsId++,
    listeners,
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  webContents.push(contents)
  return contents
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showSaveDialog: vi.fn(() => ({ canceled: true })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

import { setOpenPathProbe } from '@genoffice/electron-utils'
import { createMarkdownView } from '../src/main/markdown-main'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import type { SaveMarkdownResult } from '../src/shared/ipc'

const temporaryDirectories: string[] = []

async function createDocument(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'markdown-save-conflict-'))
  temporaryDirectories.push(directory)
  const documentPath = join(directory, 'note.md')
  writeFileSync(documentPath, '# Original')
  return documentPath
}

afterEach(() => {
  setOpenPathProbe(null)
  vi.restoreAllMocks()
  showMessageBox.mockReset()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** The renderer's open read; records the disk state this copy last saw */
const read = (contents: FakeWebContents, path: string) =>
  handlers.get(MARKDOWN_CHANNELS.readFile)!({ sender: contents }, path) as Promise<string>

const save = (contents: FakeWebContents, request: unknown) =>
  handlers.get(MARKDOWN_CHANNELS.save)!({ sender: contents }, request) as Promise<SaveMarkdownResult>

async function openedView(path: string): Promise<FakeWebContents> {
  const view = createMarkdownView(path)
  const contents = view.webContents as unknown as FakeWebContents
  expect(await read(contents, path)).toBe('# Original')
  return contents
}

describe('a save with no copy pair is unchanged', () => {
  it('does not ask anything even when another program changed the disk', async () => {
    const path = await createDocument()
    const contents = await openedView(path)
    writeFileSync(path, '# Changed elsewhere')

    expect(await save(contents, { text: '# Mine', imageSources: [], mode: 'save' })).toMatchObject(
      { ok: true, path },
    )
    expect(readFileSync(path, 'utf8')).toBe('# Mine')
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('a copy pair holds this document (the path is open in another pane)', () => {
  it('defers an automatic save silently, keeping the sibling pane’s bytes', async () => {
    const path = await createDocument()
    const contents = await openedView(path)
    writeFileSync(path, '# Changed elsewhere')
    setOpenPathProbe((each) => each === path)

    expect(
      await save(contents, { text: '# Mine', imageSources: [], mode: 'save', auto: true }),
    ).toEqual({ ok: false, error: 'external-modified' })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('# Changed elsewhere')
  })

  it('asks before a manual save, and cancel keeps the disk copy', async () => {
    const path = await createDocument()
    const contents = await openedView(path)
    writeFileSync(path, '# Changed elsewhere')
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })

    expect(await save(contents, { text: '# Mine', imageSources: [], mode: 'save' })).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(showMessageBox.mock.calls[0]![0]).toMatchObject({ type: 'warning' })
    expect(readFileSync(path, 'utf8')).toBe('# Changed elsewhere')
  })

  it('writes when the user overwrites, and the next save asks nothing', async () => {
    const path = await createDocument()
    const contents = await openedView(path)
    writeFileSync(path, '# Changed elsewhere')
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })

    expect(await save(contents, { text: '# Mine', imageSources: [], mode: 'save' })).toMatchObject(
      { ok: true, path },
    )
    expect(readFileSync(path, 'utf8')).toBe('# Mine')

    // the record was refreshed on save: the disk still matches it, so no second question
    expect(
      await save(contents, { text: '# Mine again', imageSources: [], mode: 'save' }),
    ).toMatchObject({ ok: true, path })
    expect(readFileSync(path, 'utf8')).toBe('# Mine again')
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while the disk still matches this copy’s own record', async () => {
    const path = await createDocument()
    const contents = await openedView(path)
    setOpenPathProbe((each) => each === path)

    expect(await save(contents, { text: '# Mine', imageSources: [], mode: 'save' })).toMatchObject(
      { ok: true, path },
    )
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
