/**
 * An ODT tab holding content hidden from AI, across a restart: the tab's
 * docx recovery copy is written through the real main-process handler into a
 * real recovery store, a fresh main process (modules reloaded, a new store
 * over the same folder) hands it back, and the renderer restores it and saves.
 * The marks survive, the restored draft is a docx, and the original .odt on
 * disk is never overwritten unless the person chose "clear the marks".
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildBlankDocx, docxHoldsHiddenContent } from '@seuoffice/docx-engine'
import { docxToOdt } from '@seuoffice/odt-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { DocState } from '../src/renderer/doc-state'
import type { OpenFileResult } from '../src/shared/ipc'
import { setFormatChangeHost } from '../src/renderer/components/format-change-bus'
import { zipEntryNames } from '../src/main/doc-format'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  takeHandoff: null as null | ((url: string) => Uint8Array | null),
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? h.root : tmpdir()),
    getAppPath: () => tmpdir(),
    getName: () => 'docs-test',
    getVersion: () => '0',
    getSystemLocale: () => 'en-US',
    on: () => {},
    once: () => {},
    whenReady: () => new Promise(() => {}),
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => h.handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
    static getAllWindows() {
      return []
    }
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: {},
  net: {},
  session: {},
  shell: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))
vi.mock('@seuoffice/ai-search', async () => ({
  ...(await import('../../../packages/ai-search/src/media-call-abort')),
  documentMediaRoots: () => [],
}))
vi.mock('@seuoffice/ai-provider/subscription', () => ({
  ensureSubscriptionIpc: () => ({}),
  sharedSubscriptionStatuses: () => ({}),
}))
vi.mock('@seuoffice/ai-provider/codex-app-server', () => ({
  shutdownCodexAppServers: () => {},
}))
vi.mock('@seuoffice/ai-provider/custom-models', () => ({}))
vi.mock('../src/main/lazy-media', () => ({
  registerLazyMediaProtocol: () => {},
  materializeLazyDocx: async (bytes: Buffer) => ({ bytes, hashes: new Set<string>() }),
  adoptLazyMediaHashes: async () => {},
  forgetLazyMediaOwner: () => {},
  moveLazyMediaSource: () => {},
  openLazyDocx: async () => null,
  pointLazyMediaAt: () => {},
  readLazyMedia: async () => null,
}))
vi.mock('../src/main/lazy-media-inline', () => ({}))

// the renderer fetches what the main process handed off
vi.mock('../src/renderer/doc-bytes', () => ({
  fetchDocBytes: async (url: string) => {
    const bytes = h.takeHandoff?.(url)
    if (!bytes) throw new Error(`no bytes for ${url}`)
    return new Uint8Array(bytes)
  },
}))
vi.mock('../src/renderer/components/toast-bus', () => ({
  showToast: () => {},
  setToastEmitter: () => {},
}))

const { loadFile, save, writeRecoveryCopy } = await import('../src/renderer/file-actions')
type Ctx = Parameters<typeof loadFile>[0]

const editors: Editor[] = []

function makeCtx(): Ctx {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  const state: Record<string, unknown> = {
    editor,
    doc: null as DocState | null,
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    pendingMixedExportRef: { current: false },
    printAutoOpenedPreviewRef: { current: false },
    section: null,
    sectionDirty: false,
    sections: [],
    sectionsDirty: [],
    trailingStartType: null,
    pageColor: null,
    pageColorDirty: false,
    header: null,
    headerDirty: false,
    footer: null,
    footerDirty: false,
    hfVariants: {},
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    titlePg: false,
    titlePgDirty: false,
    evenOddHf: false,
    evenOddHfDirty: false,
    mirrorMargins: false,
    mirrorMarginsDirty: false,
    pgNumEdit: null,
    pgNumDirtySections: [],
    pendingNumbering: { newDefs: [], restartNums: [], levelEdits: [], picBullets: [] },
    numberingDirty: false,
    styleUpserts: {},
    comments: [],
    commentsDirty: false,
    watermark: null,
    watermarkDirty: false,
    watermarkStyle: null,
    watermarkPicture: null,
    inkAnnotations: [],
    inksDirty: false,
    footnotes: [],
    endnotes: [],
    notesDirty: false,
    sources: [],
    sourcesDirty: false,
    zoteroDocumentData: '',
    zoteroDocumentDataDirty: false,
    themeFonts: null,
    themeFontsDirty: false,
    themeColors: null,
    themeColorsDirty: false,
    protection: null,
    protectionDirty: false,
    writeProtection: null,
    writeProtectionDirty: false,
    removePersonalInfo: false,
    removePersonalInfoDirty: false,
    setDoc: (next: unknown) => {
      state.doc = typeof next === 'function' ? (next as (p: unknown) => unknown)(state.doc) : next
    },
  }
  // every other setter / callback is a no-op
  return new Proxy(state, {
    get(target, key) {
      // optional inputs (settleFontSettings, defaultFonts …) stay absent
      if (
        typeof key === 'string' &&
        !(key in target) &&
        key !== 'settleFontSettings' &&
        /^(set|on|prompt|bump)/.test(key)
      )
        return () => {}
      return target[key as string]
    },
  }) as unknown as Ctx
}

function docOf(ctx: Ctx): DocState {
  const doc = (ctx as unknown as { doc: DocState | null }).doc
  if (!doc) throw new Error('no document')
  return doc
}

function isOdtBytes(bytes: Uint8Array): boolean {
  const names = zipEntryNames(bytes) ?? []
  return names.includes('mimetype') && !names.includes('[Content_Types].xml')
}

const SECRET = '13800138000'
const LABEL = 'client phone'

function hideParagraph(editor: Editor): void {
  editor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'docParagraph',
        attrs: { docxIndex: null },
        content: [
          { type: 'text', text: 'Call ' },
          {
            type: 'text',
            text: SECRET,
            marks: [
              {
                type: 'redaction',
                attrs: {
                  label: LABEL,
                  rawRPr: `<w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/><go:redact w:label="${LABEL}"/></w:rPr>`,
                },
              },
            ],
          },
        ],
      },
    ],
  })
}

interface FakeTab {
  id: number
  isDestroyed: () => boolean
  isCrashed: () => boolean
  send: ReturnType<typeof vi.fn>
}
let nextTabId = 500
const newTab = (): FakeTab => ({
  id: nextTabId++,
  isDestroyed: () => false,
  isCrashed: () => false,
  send: vi.fn(),
})
const invoke = <T>(channel: string, tab: FakeTab, ...args: unknown[]): Promise<T> => {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: tab }, ...args)) as Promise<T>
}

type MainModules = {
  docsMain: typeof import('../src/main/docs-main')
  utils: typeof import('@seuoffice/electron-utils')
}
/** a fresh main process: every module reloaded, a new store over the same app data folder */
async function startMain(): Promise<MainModules> {
  vi.resetModules()
  h.handlers.clear()
  const docsMain = await import('../src/main/docs-main')
  const utils = await import('@seuoffice/electron-utils')
  const handoffModule = await import('../src/main/byte-handoff')
  h.takeHandoff = handoffModule.takeHandoff
  docsMain.registerDocsIpc()
  return { docsMain, utils }
}

let userFolder: string
let originalPath: string
let originalBytes: Uint8Array
let saveCalls: { channel: string; path: string | null; bytes: Uint8Array }[]
let pickedPath: string | null
let desktop: Record<string, ReturnType<typeof vi.fn>>
let writer: FakeTab | null = null

function installDesktop(): void {
  saveCalls = []
  const record = (channel: string) => async (path: string | null, data: ArrayBuffer) => {
    saveCalls.push({ channel, path, bytes: new Uint8Array(data) })
    return { ok: true, path }
  }
  desktop = {
    getRecentFiles: vi.fn(async () => []),
    getSystemLocale: vi.fn(async () => 'en-US'),
    docPasswordIntentRevision: vi.fn(async () => 0),
    discardDocPasswordIntents: vi.fn(async () => ({ ok: true })),
    saveDocx: vi.fn(record('save')),
    saveDocxTo: vi.fn(record('save-to')),
    saveDocxNew: vi.fn(record('save-new')),
    saveDocxAs: vi.fn(record('save-as')),
    // the real main-process handler, as the preload forwards it
    writeRecoveryCopy: vi.fn((path: string | null, data: ArrayBuffer, meta?: unknown) =>
      invoke('docs:write-recovery', writer!, path, data, meta),
    ),
    pickSaveAsPath: vi.fn(async () => (pickedPath ? { path: pickedPath } : null)),
    captureRect: vi.fn(async () => null),
    materializeDocx: vi.fn(async () => null),
    openDocxPath: vi.fn(async (path: string) => {
      const last = [...saveCalls].reverse().find((call) => call.path === path)
      if (!last) return null
      const { handOffBytes } = await import('../src/main/byte-handoff')
      return {
        path,
        name: path.split('/').pop() ?? path,
        dataUrl: handOffBytes(Buffer.from(last.bytes)),
        hash: 'h',
      }
    }),
    confirmMarkedOdt: vi.fn(async () => 'cancel'),
  }
  ;(window as unknown as { desktop: unknown }).desktop = desktop
}

beforeAll(async () => {
  userFolder = mkdtempSync(join(tmpdir(), 'docs-odt-restart-user-'))
  originalPath = join(userFolder, 'form.odt')
  originalBytes = (await docxToOdt(await buildBlankDocx({}))).odtBytes
  writeFileSync(originalPath, originalBytes)
})
/** an empty app data folder: nothing a former run left is offered */
function freshAppData(): void {
  if (h.root) rmSync(h.root, { recursive: true, force: true })
  h.root = mkdtempSync(join(tmpdir(), 'docs-odt-restart-root-'))
}
afterAll(() => {
  rmSync(h.root, { recursive: true, force: true })
  rmSync(userFolder, { recursive: true, force: true })
})
beforeEach(() => {
  freshAppData()
  ;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
  installDesktop()
  pickedPath = null
  setFormatChangeHost(null)
})
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  setFormatChangeHost(null)
})

describe('a marked ODT tab across a restart', () => {
  /** the first run: an unmarked tick, then the content gets marked and ticks again; then the process is gone */
  async function crashedRun(): Promise<void> {
    const first = await startMain()
    writer = newTab()
    first.docsMain.authorizeMcpDocWrite(writer.id, originalPath)
    const ctx = makeCtx()
    expect(
      await loadFile(ctx, {
        path: originalPath,
        name: 'form.odt',
        dataUrl: first.docsMain && (await handOff(first, originalBytes)),
        hash: 'h',
      } as OpenFileResult),
    ).toBe('ok')
    ;(ctx.editor as Editor).commands.insertContent('typed before marking')
    ctx.dirtyRef.current = true
    expect(await writeRecoveryCopy(ctx)).toBe('written')
    hideParagraph(ctx.editor as Editor)
    expect(await writeRecoveryCopy(ctx)).toBe('written')
  }

  async function handOff(_main: MainModules, bytes: Uint8Array): Promise<string> {
    const { handOffBytes } = await import('../src/main/byte-handoff')
    return handOffBytes(Buffer.from(bytes))
  }

  /** the shell's side of a restart: the store's listing, then the editor's openUntitledCopy */
  async function restoredDraft(): Promise<{ ctx: Ctx; opened: OpenFileResult }> {
    const second = await startMain()
    const store = second.utils.createRecoveryStore({ userDataDir: h.root })
    const copies = store.listCopies()
    // the docx copy is the only one offered: the stale ODT-era copy is gone
    expect(copies).toHaveLength(1)
    const copy = copies[0]
    expect(copy.filePath).toBeNull()
    expect(copy.originalPath).toBe(originalPath)
    const tab = newTab()
    const opening = second.utils.recoveryEditor('docs')!.openUntitledCopy(tab as never, {
      copy: copy.identity,
      title: copy.title,
      saveAsDefaultPath: copy.originalPath ?? undefined,
    })
    const opened = await invoke<OpenFileResult>('docs:consume-copy', tab)
    await opening
    const ctx = makeCtx()
    expect(await loadFile(ctx, opened)).toBe('ok')
    return { ctx, opened }
  }

  it('restores a docx draft that keeps its marks; saving to the .odt asks, and cancel writes nothing', async () => {
    await crashedRun()
    const { ctx, opened } = await restoredDraft()
    expect(opened.name).toBe('form.docx')
    expect(docOf(ctx).format).toBe('docx')
    expect(docOf(ctx).filePath).toBeNull()
    expect(JSON.stringify((ctx.editor as Editor).state.doc.toJSON())).toContain('redaction')
    expect(ctx.dirtyRef.current).toBe(true)

    pickedPath = originalPath
    desktop.confirmMarkedOdt.mockResolvedValue('cancel')
    expect(await save(ctx, false)).toBe(false)
    expect(desktop.confirmMarkedOdt).toHaveBeenCalledTimes(1)
    expect(saveCalls).toHaveLength(0)
    expect(Buffer.from(readFileSync(originalPath)).equals(Buffer.from(originalBytes))).toBe(true)
  })

  it('"save as .docx" never lands on the .odt path; "clear the marks" is the only way to an ODT', async () => {
    await crashedRun()
    const { ctx } = await restoredDraft()
    pickedPath = originalPath
    desktop.confirmMarkedOdt.mockResolvedValue('docx')
    desktop.pickSaveAsPath.mockImplementation(async (_n, _s, format) => ({
      path:
        format === 'docx' && desktop.pickSaveAsPath.mock.calls.length > 1
          ? join(userFolder, 'form2.docx')
          : originalPath,
    }))
    expect(await save(ctx, false)).toBe(true)
    expect(saveCalls.every((call) => call.path !== originalPath)).toBe(true)
    expect(await docxHoldsHiddenContent(saveCalls[saveCalls.length - 1].bytes)).toBe(true)
    expect(Buffer.from(readFileSync(originalPath)).equals(Buffer.from(originalBytes))).toBe(true)

    const again = await restoredDraftAgain()
    desktop.pickSaveAsPath.mockImplementation(async () => ({ path: originalPath }))
    desktop.confirmMarkedOdt.mockResolvedValue('clear')
    setFormatChangeHost((_request, confirm) => confirm(true))
    expect(await save(again, true)).toBe(true)
    const last = saveCalls[saveCalls.length - 1]
    expect(last.path).toBe(originalPath)
    expect(isOdtBytes(last.bytes)).toBe(true)
  })

  async function restoredDraftAgain(): Promise<Ctx> {
    // the saves here are stubs, so the first draft's copy stays: start over in an empty folder
    freshAppData()
    await crashedRun()
    return (await restoredDraft()).ctx
  }
})
