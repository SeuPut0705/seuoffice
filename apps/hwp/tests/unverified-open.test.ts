// @vitest-environment node
/**
 * An HWP file whose container the app's own readers refuse (the compound-file gate) can
 * still be one the editor engine opens. What the app reads from the original for a save
 * (tracked changes, section tails, field kinds) is then unknown, which is not the same as
 * "nothing there": the view is told so, and a save may not replace that file.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as CFB from 'cfb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { CompoundFileError, assertCompoundFile } from '@genoffice/compound-file'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const showSaveDialog = vi.fn(
  async (..._args: unknown[]): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true,
  }),
)

interface FakeContents {
  id: number
  isDestroyed(): boolean
  setWindowOpenHandler(handler: unknown): void
  loadURL(url: string): Promise<void>
  send(channel: string, ...args: unknown[]): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
}

let nextId = 1
function fakeContents(): FakeContents {
  return {
    id: nextId++,
    isDestroyed: () => false,
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    send: () => {},
    on: () => {},
    once: () => {},
  }
}

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: () => new Promise(() => {}),
    getPath: (name: string) => join(tmpdir(), `hwp-test-${name}`),
    getLocale: () => 'en-US',
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
  },
  shell: { openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  net: {},
  ipcRenderer: {},
  webUtils: {},
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

vi.mock('@genoffice/file-parse', () => ({
  hwpToText: vi.fn(async () => ''),
  parseFileToText: vi.fn(async () => ({ kind: 'text', text: '' })),
  ATTACHABLE_EXTS: new Set<string>(),
  ATTACHABLE_IMAGE_EXTS: new Set<string>(),
  ATTACHABLE_MAX_BYTES: 25 * 1024 * 1024,
  attachableMaxBytes: () => 25 * 1024 * 1024,
  ATTACHABLE_IMAGE_MAX_BYTES: 5 * 1024 * 1024,
}))

import { createHwpView } from '../src/main/hwp-main'
import { HWP_CHANNELS } from '../src/shared/ipc'
import type { BeginSaveResult, CommitSaveResult } from '../src/shared/ipc'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-hwp-unverified-'))
  showSaveDialog.mockReset()
  showSaveDialog.mockResolvedValue({ canceled: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A document the engine wrote. */
function exported(text = '본문'): Uint8Array {
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  doc.insertText(0, 0, 0, text)
  const bytes = doc.exportHwp()
  doc.free()
  return bytes
}

/** The first paragraph the engine reads from a file. */
function firstParagraph(file: Uint8Array): string {
  const doc = new HwpDocument(file)
  const length = doc.getParagraphLength(0, 0)
  const text = length > 0 ? doc.getTextRange(0, 0, 0, length) : ''
  doc.free()
  return text
}

/**
 * The file with tracked changes: the header property and the second copy of the body, which
 * says something else than the body. `distribution` makes it one the record cannot be left
 * out of.
 */
function tracked(options: { distribution?: boolean } = {}): Uint8Array {
  const cfb = CFB.read(Buffer.from(exported()), { type: 'buffer' })
  const header = Buffer.from(CFB.find(cfb, '/FileHeader')!.content as Uint8Array)
  header.writeUInt32LE(header.readUInt32LE(36) | 0x4000 | (options.distribution ? 0x4 : 0), 36)
  CFB.utils.cfb_add(cfb, '/FileHeader', header)
  const copy = CFB.read(Buffer.from(exported('본문 지운 글')), { type: 'buffer' })
  CFB.utils.cfb_add(
    cfb,
    '/ViewText/Section0',
    Buffer.from(CFB.find(copy, '/BodyText/Section0')!.content as Uint8Array),
  )
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer)
}

/** Where the header of a compound file counts its FAT sectors. */
const FAT_SECTOR_COUNT = 44

/**
 * The same file with one header field wrong: the number of FAT sectors. Readers that follow
 * the sector list never look at the count, the gate does.
 */
function gateRefused(file: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(file)
  const view = new DataView(bytes.buffer)
  view.setUint32(FAT_SECTOR_COUNT, view.getUint32(FAT_SECTOR_COUNT, true) + 1, true)
  return bytes
}

const call = <T>(channel: string, contents: FakeContents, ...args: unknown[]): T =>
  handlers.get(channel)!({ sender: contents }, ...args) as T

/** A view that opened the file at `name` holding `bytes`; what the editor was given. */
async function openView(
  name: string,
  bytes: Uint8Array,
): Promise<{ contents: FakeContents; path: string; given: Uint8Array }> {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  const contents = createHwpView(path).webContents as unknown as FakeContents
  const given = await call<Promise<Uint8Array>>(HWP_CHANNELS.readFile, contents, path)
  return { contents, path, given }
}

const unverified = (contents: FakeContents): Promise<boolean> =>
  call<Promise<boolean>>(HWP_CHANNELS.structureUnverified, contents)

const begin = (contents: FakeContents, mode: 'save' | 'saveAs'): Promise<BeginSaveResult> =>
  call<Promise<BeginSaveResult>>(HWP_CHANNELS.beginSave, contents, mode)

const commit = (contents: FakeContents, bytes: Uint8Array): Promise<CommitSaveResult> =>
  call<Promise<CommitSaveResult>>(HWP_CHANNELS.commitSave, contents, bytes, [], {})

/** HWPX bytes enough for the container check (ZIP magic). */
const HWPX_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x21, 0x22, 0x23])

describe('an HWP file the compound-file gate refuses', () => {
  it('is refused by the gate and is still a document the engine opens', () => {
    const file = gateRefused(tracked())
    expect(() => assertCompoundFile(file)).toThrow(CompoundFileError)
    // the engine reads the copy kept for the tracked changes, deleted text included
    expect(firstParagraph(file)).toBe('본문 지운 글')
  })

  it('opens, as it is, and the view is told its structure could not be checked', async () => {
    const file = gateRefused(tracked())
    const { contents, given } = await openView('refused.hwp', file)
    expect(Buffer.from(given).equals(Buffer.from(file))).toBe(true)
    expect(await unverified(contents)).toBe(true)
  })

  it('is not saved over: the save is refused with the reason and the file stays as it was', async () => {
    const file = gateRefused(tracked())
    const { contents, path } = await openView('refused.hwp', file)
    const result = await begin(contents, 'save')
    expect(result).toMatchObject({ ok: false, reason: 'unverified' })
    // no save began, so nothing the renderer sends afterwards is written either
    expect((await commit(contents, exported('고친 글'))).ok).toBe(false)
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
  })

  it('is refused the same without tracked changes: what a save puts back was not read', async () => {
    const memo = new Uint8Array(readFileSync(join(__dirname, 'fixtures/memo.hwp')))
    const file = gateRefused(memo)
    const { contents, path } = await openView('memo.hwp', file)
    expect(await unverified(contents)).toBe(true)
    expect(await begin(contents, 'save')).toMatchObject({ ok: false, reason: 'unverified' })
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
  })

  it('is saved under another name by Save As, and the original stays as it was', async () => {
    const file = gateRefused(tracked())
    const { contents, path } = await openView('refused.hwp', file)
    const copyPath = join(dir, 'copy.hwpx')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: copyPath })
    expect(await begin(contents, 'saveAs')).toMatchObject({ ok: true, path: copyPath })
    expect(await commit(contents, HWPX_BYTES)).toMatchObject({ ok: true, path: copyPath })
    expect(readFileSync(copyPath).equals(Buffer.from(HWPX_BYTES))).toBe(true)
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
    // the document is the copy from now on: a plain save goes there, not to the original
    expect(await begin(contents, 'save')).toMatchObject({ ok: true, path: copyPath })
    expect(await commit(contents, HWPX_BYTES)).toMatchObject({ ok: true, path: copyPath })
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
  })

  it('is not saved over by a Save As that picks the file itself', async () => {
    const file = gateRefused(tracked())
    const { contents, path } = await openView('refused.hwp', file)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    expect(await begin(contents, 'saveAs')).toMatchObject({ ok: false, reason: 'unverified' })
    expect((await commit(contents, exported('고친 글'))).ok).toBe(false)
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
  })
})

describe('an HWP file the gate lets through', () => {
  it('with tracked changes that cannot be left out is still refused as tracked', async () => {
    const file = tracked({ distribution: true })
    const { contents, path } = await openView('tracked.hwp', file)
    expect(await unverified(contents)).toBe(false)
    expect(await begin(contents, 'save')).toMatchObject({ ok: false, reason: 'tracked' })
    expect(readFileSync(path).equals(Buffer.from(file))).toBe(true)
  })

  it('with tracked changes is opened without them, as before', async () => {
    const { contents, given } = await openView('tracked.hwp', tracked())
    expect(await unverified(contents)).toBe(false)
    expect(await call<Promise<boolean>>(HWP_CHANNELS.trackingDropped, contents)).toBe(true)
    expect(firstParagraph(given)).toBe('본문')
  })

  it('without them saves over itself as before', async () => {
    const { contents, path } = await openView('plain.hwp', exported())
    expect(await unverified(contents)).toBe(false)
    expect(await begin(contents, 'save')).toMatchObject({ ok: true, path, format: 'hwp' })
    const edited = exported('고친 글')
    expect(await commit(contents, edited)).toMatchObject({ ok: true, path })
    expect(firstParagraph(new Uint8Array(readFileSync(path)))).toBe('고친 글')
  })
})
