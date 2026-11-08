import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productName } from '@genoffice/i18n'
import { DOC_ATTACH_CHANNELS } from '@genoffice/electron-utils/doc-attach-channels'
import type { DocAttachResult } from '@genoffice/electron-utils/doc-attach-bridge'
import {
  DOC_PICKER_CHANNELS,
  type DocListItem,
  type DocListResult,
} from '../src/shared/doc-picker-api'
import { docPickerText } from '../src/renderer/src/i18n/strings-doc-picker'
import type { DocPickerDeps } from '../src/main/doc-picker/doc-picker-window'
import { resolveDocAsker, type DocAsker } from '../src/main/doc-picker/doc-asker'
import { createDocList, type OpenDocumentEntry } from '../src/main/doc-picker/doc-list'

/**
 * The shell end of the "Attach documents" window (src/main/doc-picker/):
 * one window over the editor that asked, ids validated against the list it
 * read, chosen paths handed back, closing/cancelling = cancelled, a second
 * asker gets "busy", and a request from a non-window sender is refused.
 */

type Handler = (event?: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const winOptions: Array<Record<string, unknown>> = []
const windows: FakeBrowserWindow[] = []
let nextWcId = 1

class FakeWebContents {
  readonly id: number
  constructor() {
    this.id = nextWcId++
  }
  setWindowOpenHandler(): void {}
  send(): void {}
}

interface WindowLike {
  isDestroyed(): boolean
}

class FakeBrowserWindow {
  static windowForWc = new Map<FakeWebContents, WindowLike>()
  webContents = new FakeWebContents()
  options: Record<string, unknown>
  shown = false
  focused = false
  destroyed = false
  private readyCb: (() => void) | null = null
  private closedCb: (() => void) | null = null

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
    winOptions.push(options)
    windows.push(this)
  }
  static fromWebContents(wc: FakeWebContents): WindowLike | null {
    return FakeBrowserWindow.windowForWc.get(wc) ?? null
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focused = true
  }
  removeMenu(): void {}
  once(event: string, cb: () => void): void {
    if (event === 'ready-to-show') this.readyCb = cb
  }
  on(event: string, cb: () => void): void {
    if (event === 'closed') this.closedCb = cb
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.closedCb?.()
  }
  fireReady(): void {
    this.readyCb?.()
  }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
  shell: { openExternal: vi.fn() },
}))

const ITEMS: DocListItem[] = [
  { id: 'C:/docs/a.docx', title: 'a.docx', dir: 'C:/docs', state: 'ok', group: 'open' },
  { id: 'C:/docs/b.pdf', title: 'b.pdf', dir: 'C:/docs', state: 'ok', group: 'recent' },
  { id: 'unsaved:tab-1', title: '제목 없는 문서', dir: '', state: 'unsaved', group: 'open' },
  { id: 'C:/docs/gone.pdf', title: 'gone.pdf', dir: 'C:/docs', state: 'missing', group: 'recent' },
  {
    id: 'C:/docs/editing.docx',
    title: 'editing.docx',
    dir: 'C:/docs',
    state: 'modified',
    group: 'pane',
  },
]

/** each webContents id names its own asker, so the test can see which one was used */
const askerOf = (webContentsId: number): DocAsker => ({ tabId: `tab-of-${webContentsId}` })

function makeDeps(): DocPickerDeps & { list: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async (_asker: DocAsker): Promise<DocListResult> => ({ ok: true, items: ITEMS })),
    askerFor: askerOf,
    lang: () => 'ko' as const,
    theme: () => 'light' as const,
  }
}

async function load(deps: DocPickerDeps = makeDeps()) {
  const mod = await import('../src/main/doc-picker/doc-picker-window')
  return { picker: mod.createDocPicker(deps), deps }
}

/** a window that can be the parent of the modal picker (a plain stand-in) */
function fakeParent(): { webContents: FakeWebContents; isDestroyed: () => boolean } {
  const webContents = new FakeWebContents()
  const parent = { webContents, isDestroyed: () => false }
  FakeBrowserWindow.windowForWc.set(webContents, parent)
  return parent
}

const pickerWindow = (): FakeBrowserWindow => windows.at(-1)!

function invoke(channel: string, event?: unknown, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler(event, ...args)
}

/** open through the real entry point and return the pending pick + the window */
async function openPicker() {
  const parent = fakeParent()
  const pending = invoke(DOC_ATTACH_CHANNELS.pick, {
    sender: parent.webContents,
  }) as Promise<DocAttachResult>
  const win = windows.at(-1)!
  return { parent, pending, win }
}

const atPicker = () => ({ sender: pickerWindow().webContents })

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  winOptions.length = 0
  windows.length = 0
  FakeBrowserWindow.windowForWc.clear()
  nextWcId = 1
})

describe('createDocPicker window', () => {
  it('registers its own channels and the editor attach channels', async () => {
    await load()
    for (const channel of Object.values(DOC_PICKER_CHANNELS))
      expect(handlers.has(channel)).toBe(true)
    for (const channel of Object.values(DOC_ATTACH_CHANNELS))
      expect(handlers.has(channel)).toBe(true)
  })

  it('answers the editor that the shell is available', async () => {
    await load()
    expect(invoke(DOC_ATTACH_CHANNELS.available)).toBe(true)
  })

  it('refuses a pick from a sender that is not a window', async () => {
    await load()
    const result = await invoke(DOC_ATTACH_CHANNELS.pick, { sender: new FakeWebContents() })
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(winOptions).toHaveLength(0)
  })

  it('opens one modal child of the requesting window, sized and titled like the Drive picker', async () => {
    await load()
    const { parent, pending } = await openPicker()
    const win = pickerWindow()
    expect(win.options.parent).toBe(parent)
    expect(win.options.modal).toBe(true)
    expect(win.options.width).toBe(720)
    expect(win.options.height).toBe(640)
    expect(win.options.minWidth).toBe(480)
    expect(win.options.minHeight).toBe(420)
    expect(win.options.show).toBe(false)
    expect(win.options.title).toBe(`${docPickerText('ko', 'docPickTitle')} - ${productName('ko')}`)
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
    // shown once the page is ready
    win.fireReady()
    expect(win.shown).toBe(true)
    void invoke(DOC_PICKER_CHANNELS.cancel, atPicker())
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('answers the picker window with its language and theme, and nothing to others', async () => {
    await load()
    await openPicker()
    expect(invoke(DOC_PICKER_CHANNELS.getInit, atPicker())).toEqual({ lang: 'ko', theme: 'light' })
    expect(invoke(DOC_PICKER_CHANNELS.getInit, { sender: new FakeWebContents() })).toBeNull()
  })

  it('hands the ticked paths back after validating the ids against the list just read', async () => {
    await load()
    const { pending } = await openPicker()
    const listed = await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    expect(listed).toEqual({ ok: true, items: ITEMS })
    // valid, unsaved, missing, unknown, non-string and too-long ids
    const chosen = invoke(DOC_PICKER_CHANNELS.choose, atPicker(), [
      'C:/docs/a.docx',
      'unsaved:tab-1',
      'C:/docs/gone.pdf',
      'C:/docs/never-listed.pdf',
      42,
      'x'.repeat(4097),
      'C:/docs/b.pdf',
    ])
    expect(chosen).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true, paths: ['C:/docs/a.docx', 'C:/docs/b.pdf'] })
    expect(pickerWindow().destroyed).toBe(true)
  })

  it('drops duplicate ids', async () => {
    await load()
    const { pending } = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    invoke(DOC_PICKER_CHANNELS.choose, atPicker(), ['C:/docs/a.docx', 'C:/docs/a.docx'])
    await expect(pending).resolves.toEqual({ ok: true, paths: ['C:/docs/a.docx'] })
  })

  it('cancels when nothing survives validation', async () => {
    await load()
    const { pending } = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    const chosen = invoke(DOC_PICKER_CHANNELS.choose, atPicker(), [
      'unsaved:tab-1',
      'C:/docs/gone.pdf',
    ])
    expect(chosen).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('cancels when the picker window never read a list', async () => {
    await load()
    const { pending } = await openPicker()
    invoke(DOC_PICKER_CHANNELS.choose, atPicker(), ['C:/docs/a.docx'])
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('resolves cancel as cancelled and closes the window', async () => {
    await load()
    const { pending, win } = await openPicker()
    invoke(DOC_PICKER_CHANNELS.cancel, atPicker())
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(win.destroyed).toBe(true)
  })

  it('resolves closing the window as cancelled, never ok', async () => {
    await load()
    const { pending, win } = await openPicker()
    win.close()
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('turns a second asker away as busy and brings the open window forward', async () => {
    await load()
    const { pending, win } = await openPicker()
    const other = fakeParent()
    const second = await invoke(DOC_ATTACH_CHANNELS.pick, { sender: other.webContents })
    expect(second).toEqual({ ok: false, reason: 'busy' })
    expect(win.shown).toBe(true)
    expect(win.focused).toBe(true)
    // still only one window, the first asker is still waiting
    expect(winOptions).toHaveLength(1)
    void invoke(DOC_PICKER_CHANNELS.cancel, atPicker())
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('refuses picker-channel calls when no window is open', async () => {
    await load()
    const stray = { sender: new FakeWebContents() }
    await expect(invoke(DOC_PICKER_CHANNELS.list, stray)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
    })
    expect(invoke(DOC_PICKER_CHANNELS.choose, stray, ['x'])).toEqual({
      ok: false,
      kind: 'unavailable',
    })
  })

  it('never accepts a document with unsaved changes', async () => {
    await load()
    const { pending } = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    invoke(DOC_PICKER_CHANNELS.choose, atPicker(), ['C:/docs/editing.docx', 'C:/docs/b.pdf'])
    await expect(pending).resolves.toEqual({ ok: true, paths: ['C:/docs/b.pdf'] })
  })

  it('cancels when the only pick is a document with unsaved changes', async () => {
    await load()
    const { pending } = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    invoke(DOC_PICKER_CHANNELS.choose, atPicker(), ['C:/docs/editing.docx'])
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('builds the window list for the editor that opened the picker', async () => {
    const { deps } = await load()
    const { parent } = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    expect(deps.list).toHaveBeenLastCalledWith(askerOf(parent.webContents.id))
  })

  it('keeps the first asker while the picker is open, and takes the next one after it closes', async () => {
    const { deps } = await load()
    const first = await openPicker()
    const other = fakeParent()
    await invoke(DOC_ATTACH_CHANNELS.pick, { sender: other.webContents })
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    expect(deps.list).toHaveBeenLastCalledWith(askerOf(first.parent.webContents.id))

    invoke(DOC_PICKER_CHANNELS.cancel, atPicker())
    await first.pending
    const second = await openPicker()
    await invoke(DOC_PICKER_CHANNELS.list, atPicker())
    expect(deps.list).toHaveBeenLastCalledWith(askerOf(second.parent.webContents.id))
  })
})

describe('doc:attach-list', () => {
  /**
   * The real list and asker rule over a fake shell: tab-1 (wc 1) and tab-2
   * (wc 2) are the two split panes, tab-2 shows the same file as tab-1, tab-3
   * is another tab with unsaved changes, tab-4 was never saved, and wc 9 is a
   * detached window.
   */
  const OPEN: OpenDocumentEntry[] = [
    { id: 'tab-1', path: 'C:/docs/plan.docx', title: 'plan.docx', dirty: false },
    { id: 'tab-2', path: 'C:/Docs/Plan.docx', title: 'Plan.docx', dirty: false },
    { id: 'tab-3', path: 'C:/docs/notes.docx', title: 'notes.docx', dirty: true },
    { id: 'tab-4', title: '제목 없는 문서', dirty: false },
    { id: 'tab-5', path: 'C:/docs/sheet.xlsx', title: 'sheet.xlsx', dirty: false },
    { id: 'detached:9', path: 'C:/docs/away.pdf', title: 'away.pdf', dirty: false },
  ]
  const TABS: Record<number, { id: string; filePath?: string }> = {
    1: { id: 'tab-1', filePath: 'C:/docs/plan.docx' },
    2: { id: 'tab-2', filePath: 'C:/Docs/Plan.docx' },
    5: { id: 'tab-5', filePath: 'C:/docs/sheet.xlsx' },
  }

  function realDeps(over: Partial<DocPickerDeps> = {}): DocPickerDeps {
    return {
      list: createDocList({
        openDocuments: async () => OPEN,
        recent: async () => [
          { path: 'C:/docs/plan.docx', title: 'plan.docx', missing: false },
          { path: 'C:/docs/lost.txt', title: 'lost.txt', missing: true },
          { path: 'C:/docs/old.txt', title: 'old.txt', missing: false },
        ],
        stat: async () => ({ sizeBytes: 1 }),
        attachable: {
          ATTACHABLE_EXTS: new Set(['docx', 'pdf', 'txt', 'xlsx']),
          ATTACHABLE_IMAGE_EXTS: new Set<string>(),
          ATTACHABLE_MAX_BYTES: 100,
          ATTACHABLE_IMAGE_MAX_BYTES: 10,
        },
      }),
      askerFor: (wcId) =>
        resolveDocAsker(wcId, {
          tabFor: (id) => TABS[id],
          split: () => ({ aTabId: 'tab-1', bTabId: 'tab-5' }),
          detachedFor: (id) =>
            id === 9 ? { id: 'detached:9', filePath: 'C:/docs/away.pdf' } : undefined,
        }),
      lang: () => 'ko',
      theme: () => 'light',
      ...over,
    }
  }

  const askFrom = (wcId: number) =>
    invoke(DOC_ATTACH_CHANNELS.list, { sender: { id: wcId } }) as Promise<unknown>

  it('answers a split-pane tab with its other pane first and its own file left out', async () => {
    await load(realDeps())
    await expect(askFrom(1)).resolves.toEqual({
      ok: true,
      items: [
        {
          path: 'C:/docs/sheet.xlsx',
          name: 'sheet.xlsx',
          dir: 'C:/docs',
          group: 'pane',
          state: 'ok',
        },
        {
          path: 'C:/docs/notes.docx',
          name: 'notes.docx',
          dir: 'C:/docs',
          group: 'open',
          state: 'modified',
        },
        { path: null, name: '제목 없는 문서', dir: '', group: 'open', state: 'unsaved' },
        { path: 'C:/docs/away.pdf', name: 'away.pdf', dir: 'C:/docs', group: 'open', state: 'ok' },
        { path: 'C:/docs/old.txt', name: 'old.txt', dir: 'C:/docs', group: 'recent', state: 'ok' },
      ],
    })
  })

  it('answers a detached window with no pane group and its own file left out', async () => {
    await load(realDeps())
    const result = (await askFrom(9)) as {
      ok: true
      items: Array<{ path: string | null; group: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.items.some((i) => i.group === 'pane')).toBe(false)
    expect(result.items.map((i) => i.path)).not.toContain('C:/docs/away.pdf')
    expect(result.items.map((i) => i.path)).toContain('C:/docs/plan.docx')
  })

  it('answers an unknown sender with every document and no pane group', async () => {
    await load(realDeps())
    const result = (await askFrom(77)) as {
      ok: true
      items: Array<{ path: string | null; group: string }>
    }
    expect(result.items.map((i) => [i.group, i.path])).toEqual([
      ['open', 'C:/docs/plan.docx'],
      ['open', 'C:/docs/notes.docx'],
      ['open', null],
      ['open', 'C:/docs/sheet.xlsx'],
      ['open', 'C:/docs/away.pdf'],
      ['recent', 'C:/docs/old.txt'],
    ])
  })

  it('hides missing files from the @ list', async () => {
    await load(realDeps())
    const result = (await askFrom(77)) as { ok: true; items: Array<{ name: string }> }
    expect(result.items.map((i) => i.name)).not.toContain('lost.txt')
  })

  it('answers unavailable when the list cannot be built', async () => {
    await load(
      realDeps({
        list: async () => {
          throw new Error('boom')
        },
      }),
    )
    await expect(askFrom(1)).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('answers unavailable when the list says so', async () => {
    await load(realDeps({ list: async () => ({ ok: false, kind: 'unavailable' }) }))
    await expect(askFrom(1)).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('shows the picker window the missing file greyed, unlike the @ list', async () => {
    await load(realDeps())
    const parent = fakeParent()
    void invoke(DOC_ATTACH_CHANNELS.pick, { sender: parent.webContents })
    const listed = (await invoke(DOC_PICKER_CHANNELS.list, atPicker())) as DocListResult
    expect(listed.ok && listed.items.find((i) => i.title === 'lost.txt')?.state).toBe('missing')
  })
})
