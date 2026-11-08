/**
 * `open_documents` on a mind map tab, through the shell's control and the mind
 * map editor's real main-process module. Only Electron and the map renderer are
 * stand-ins: the renderer is a fake WebContents that answers the outline
 * question and runs the editor's save the way the real one does (bytes in, the
 * main module writes them).
 *
 * What is pinned here: a read is the renderer's current outline (unsaved edits
 * included), a close-save goes through the editor's own save path, an untitled
 * map lands in the default folder as `.xmind`, a discard writes nothing, and a
 * map whose file did not open is never written through MCP.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

interface FakeContents {
  id: number
  sent: Array<[string, ...unknown[]]>
  destroyed: boolean
  /** the fake renderer: what it does when the main process sends it something */
  onSend: (channel: string, ...args: unknown[]) => void
  isDestroyed(): boolean
  setWindowOpenHandler(): void
  loadURL(): Promise<void>
  getURL(): string
  send(channel: string, ...args: unknown[]): void
  on(): void
  once(): void
}

let nextId = 100
function fakeContents(): FakeContents {
  const contents: FakeContents = {
    id: nextId++,
    sent: [],
    destroyed: false,
    onSend: () => {},
    isDestroyed: () => contents.destroyed,
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    getURL: () => '',
    send: (channel, ...args) => {
      contents.sent.push([channel, ...args])
      contents.onSend(channel, ...args)
    },
    on: () => {},
    once: () => {},
  }
  return contents
}

const showSaveDialog = vi.fn()

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: () => new Promise(() => {}),
    getPath: (name: string) => join(tmpdir(), `shell-mindmap-mcp-test-${name}`),
    getLocale: () => 'en-US',
  },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
    showMessageBox: vi.fn(),
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

import type { WebContents } from 'electron'
import { createXmindDocument, openXmind } from '@genoffice/xmind-engine'
import {
  createMindmapView,
  mindmapIsDirty,
  mindmapSaveToPath,
} from '../../../mindmap/src/main/mindmap-main'
import { mindmapReadBytes, mindmapReadOutline } from '../../../mindmap/src/main/mcp-queries'
import { MINDMAP_CHANNELS } from '../../../mindmap/src/shared/ipc'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import { createOpenDocumentsControl } from '../../src/main/mcp/open-documents-bridge'
import { createOpenDocumentTools } from '../../src/main/mcp/tools/open-documents-tools'

let dir: string
let saveDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-mcp-mindmap-'))
  saveDir = mkdtempSync(join(tmpdir(), 'genoffice-mcp-mindmap-default-'))
  showSaveDialog.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(saveDir, { recursive: true, force: true })
})

async function mapBytes(rootTitle: string): Promise<Uint8Array> {
  const document = await createXmindDocument({ sheetTitle: 'Sheet 1', rootTitle })
  return document.save()
}

const call = <T>(channel: string, contents: FakeContents, ...args: unknown[]): T =>
  handlers.get(channel)!({ sender: contents }, ...args) as T

function view(openPath?: string | null): FakeContents {
  return createMindmapView(openPath).webContents as unknown as FakeContents
}

/** a map tab as the renderer leaves it after opening its file (or a new one) */
async function openedView(path?: string): Promise<FakeContents> {
  const contents = view(path ?? null)
  if (path) await call(MINDMAP_CHANNELS.openFile, contents, path)
  return contents
}

/** the renderer reports unsaved edits */
function markDirty(contents: FakeContents): void {
  call(MINDMAP_CHANNELS.dirtyChanged, contents, true)
}

/** the renderer answers a save request with these bytes, through the editor's save channel */
function savesWith(contents: FakeContents, bytes: Uint8Array): void {
  contents.onSend = (channel, mode) => {
    if (channel !== MINDMAP_CHANNELS.saveRequest) return
    void call(MINDMAP_CHANNELS.save, contents, { bytes, mode })
  }
}

function harness(
  contents: FakeContents,
  docTab: OpenDocumentTab,
): {
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  closed: string[]
} {
  const closed: string[] = []
  const control = createOpenDocumentsControl({
    list: async () => [docTab],
    webContentsFor: () => contents as unknown as WebContents,
    closeTab: (id) => {
      closed.push(id)
      return true
    },
    defaultSaveDir: () => saveDir,
    mindmap: { read: mindmapReadOutline, save: mindmapSaveToPath },
  })
  const [tool] = createOpenDocumentTools({ control, defaultSaveDir: () => saveDir })
  return { run: async (args) => (await tool!.handler(args)) as Record<string, unknown>, closed }
}

function mapTab(overrides: Partial<OpenDocumentTab> = {}): OpenDocumentTab {
  return { id: 't5', kind: 'mindmap', title: 'plan.xmind', active: true, dirty: true, ...overrides }
}

describe('open_documents on a mind map: list and read', () => {
  it('lists the tab with kind mindmap and the type "mind map"', async () => {
    const contents = await openedView()
    const { run } = harness(contents, mapTab({ title: 'Untitled Mind Map', dirty: false }))
    expect(await run({ action: 'list' })).toEqual({
      documents: [
        {
          id: 't5',
          type: 'mind map',
          kind: 'mindmap',
          format: 'xmind',
          title: 'Untitled Mind Map',
          path: null,
          saved: false,
          dirty: false,
          active: true,
        },
      ],
    })
  })

  it('reads the outline the renderer holds now, unsaved edits included', async () => {
    const path = join(dir, 'plan.xmind')
    const onDisk = await mapBytes('Saved center')
    writeFileSync(path, onDisk)
    const contents = await openedView(path)
    markDirty(contents)
    // the live map differs from the file: the renderer answers with its current outline
    const live = '# Sheet 1\n\n- Edited center\n  - topic not saved yet\n'
    contents.onSend = (channel) => {
      if (channel === MINDMAP_CHANNELS.outlineRequest) {
        call(MINDMAP_CHANNELS.outlineResult, contents, { text: live })
      }
    }
    const { run } = harness(contents, mapTab({ filePath: path }))
    const result = await run({ action: 'read', target: path })
    expect(result).toEqual({
      id: 't5',
      type: 'mind map',
      kind: 'mindmap',
      title: 'plan.xmind',
      path,
      dirty: true,
      content: live,
    })
    // reading writes nothing
    expect(readFileSync(path).equals(Buffer.from(onDisk))).toBe(true)
  })

  it('asks again while the map is still loading, then takes the answer', async () => {
    const contents = await openedView()
    let asked = 0
    contents.onSend = (channel) => {
      if (channel !== MINDMAP_CHANNELS.outlineRequest) return
      asked += 1
      // the first request lands while the renderer is loading: no answer
      if (asked >= 2) call(MINDMAP_CHANNELS.outlineResult, contents, { text: '# Map\n' })
    }
    const { run } = harness(contents, mapTab())
    expect((await run({ action: 'read', target: 't5' })).content).toBe('# Map\n')
    expect(asked).toBeGreaterThanOrEqual(2)
  })

  it('turns the renderer’s error into a failed read', async () => {
    const contents = await openedView()
    contents.onSend = (channel) => {
      if (channel === MINDMAP_CHANNELS.outlineRequest) {
        call(MINDMAP_CHANNELS.outlineResult, contents, {
          error: 'the file did not open, so there is no map to read',
        })
      }
    }
    const { run } = harness(contents, mapTab())
    await expect(run({ action: 'read', target: 't5' })).rejects.toThrow(/did not open/)
  })

  it('times out when the renderer never answers', async () => {
    vi.useFakeTimers()
    try {
      const contents = await openedView()
      const reading = mindmapReadOutline(contents as unknown as WebContents)
      const failed = expect(reading).rejects.toThrow(/timed out reading the map/)
      await vi.advanceTimersByTimeAsync(30_000)
      await failed
    } finally {
      vi.useRealTimers()
    }
  })

  it('concurrent reads of one map share a single question', async () => {
    const contents = await openedView()
    const reads = [
      mindmapReadOutline(contents as unknown as WebContents),
      mindmapReadOutline(contents as unknown as WebContents),
    ]
    call(MINDMAP_CHANNELS.outlineResult, contents, { text: 'one answer' })
    expect(await Promise.all(reads)).toEqual(['one answer', 'one answer'])
  })

  it('the bytes question returns what a save would write, and writes nothing', async () => {
    const contents = await openedView()
    const bytes = await mapBytes('Live')
    const reading = mindmapReadBytes(contents as unknown as WebContents)
    call(MINDMAP_CHANNELS.bytesResult, contents, { bytes })
    const got = await reading
    expect((await openXmind(got)).status).toBe('ok')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('open_documents on a mind map: close', () => {
  it('saves a dirty map to its own file through the editor’s save, then closes the tab', async () => {
    const path = join(dir, 'plan.xmind')
    writeFileSync(path, await mapBytes('Before'))
    const contents = await openedView(path)
    markDirty(contents)
    const edited = await mapBytes('After')
    savesWith(contents, edited)
    const { run, closed } = harness(contents, mapTab({ filePath: path }))

    const result = await run({ action: 'close', target: path })
    expect(result).toMatchObject({ closed: true, type: 'mind map', path, savedTo: path })
    expect(contents.sent[0]).toEqual([MINDMAP_CHANNELS.saveRequest, 'save'])
    expect(readFileSync(path).equals(Buffer.from(edited))).toBe(true)
    expect(mindmapIsDirty(contents.id)).toBe(false)
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(closed).toEqual(['t5'])
  })

  it('saves an untitled map into the default folder as .xmind, never over an existing file', async () => {
    writeFileSync(join(saveDir, 'Untitled Mind Map.xmind'), 'someone else’s file')
    const contents = await openedView()
    markDirty(contents)
    savesWith(contents, await mapBytes('New'))
    const { run, closed } = harness(contents, mapTab({ title: 'Untitled Mind Map' }))

    const result = await run({ action: 'close', target: 't5' })
    const savedTo = String(result.savedTo)
    expect(savedTo.startsWith(saveDir)).toBe(true)
    expect(savedTo.endsWith('.xmind')).toBe(true)
    expect(savedTo).not.toBe(join(saveDir, 'Untitled Mind Map.xmind'))
    expect((await openXmind(readFileSync(savedTo))).status).toBe('ok')
    expect(readFileSync(join(saveDir, 'Untitled Mind Map.xmind'), 'utf8')).toBe(
      'someone else’s file',
    )
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(closed).toEqual(['t5'])
  })

  it('discards: closes the tab and writes nothing', async () => {
    const path = join(dir, 'plan.xmind')
    const original = await mapBytes('Kept')
    writeFileSync(path, original)
    const contents = await openedView(path)
    markDirty(contents)
    savesWith(contents, await mapBytes('Dropped'))
    const { run, closed } = harness(contents, mapTab({ filePath: path }))

    const result = await run({ action: 'close', target: 't5', unsaved: 'discard' })
    expect(result).toMatchObject({ closed: true, discardedUnsavedChanges: true })
    expect(result).not.toHaveProperty('savedTo')
    expect(contents.sent).toEqual([])
    expect(readFileSync(path).equals(Buffer.from(original))).toBe(true)
    expect(closed).toEqual(['t5'])
  })

  it('never writes a map whose file did not open, even when told it is dirty', async () => {
    const path = join(dir, 'broken.xmind')
    const original = Buffer.from('this is not a zip archive')
    writeFileSync(path, original)
    const contents = await openedView(path)
    // the editor ignores a dirty report from a view whose file did not open
    markDirty(contents)
    expect(mindmapIsDirty(contents.id)).toBe(false)
    // and when the list still says dirty, the save is refused before the renderer is asked
    savesWith(contents, await mapBytes('Would overwrite'))
    const { run, closed } = harness(contents, mapTab({ title: 'broken.xmind', filePath: path }))

    await expect(run({ action: 'close', target: 't5' })).rejects.toThrow(/did not open/)
    expect(contents.sent).toEqual([])
    expect(readFileSync(path).equals(original)).toBe(true)
    expect(readdirSync(dir)).toEqual(['broken.xmind'])
    expect(readdirSync(saveDir)).toEqual([])
    expect(closed).toEqual([])
  })
})
