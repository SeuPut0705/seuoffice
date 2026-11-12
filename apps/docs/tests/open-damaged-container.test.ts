// @vitest-environment node
/**
 * Opening a .docx that is a compound file, through the Word editor's main-process open
 * handlers: a protected document comes back as a password request, which the password
 * answers; one whose container does not hold is damaged, which no password opens, so the
 * person is told the file cannot be read and no password is asked for.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
  messageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0 })),
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
  dialog: { showMessageBox: (...args: unknown[]) => h.messageBox(...args) },
  nativeImage: {},
  net: {},
  session: {},
  shell: {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
}))
// this workspace's test aliases do not reach the rest of these packages, and
// the handlers under test use none of them
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

import { getUiLang, setUiLang } from '@seuoffice/i18n'
import type { Lang } from '@seuoffice/i18n'
import { registerDocsIpc } from '../src/main/docs-main'
import type { DecryptOpenResult, OpenDocxResult } from '../src/shared/ipc'
import { fatCycleFile } from '../../../packages/compound-file/tests/helpers/raw-compound'

const fixture = (name: string): Buffer => readFileSync(join(__dirname, 'encrypted-fixtures', name))
/** the password of the vendored Office fixtures */
const PASSWORD = 'Password1234_'

let folder: string
let nextTabId = 500
let langBefore: Lang

/** A tab of its own: what a view remembers of a file does not reach the next test. */
function newTab() {
  return { id: nextTabId++, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() }
}

function invoke<T>(channel: string, tab: { id: number }, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: tab }, ...args)) as Promise<T>
}

/** The file `name` holding `bytes`, opened the way File > Open and a recent file open it. */
async function open(
  name: string,
  bytes: Uint8Array,
): Promise<{ tab: { id: number }; path: string; result: OpenDocxResult }> {
  const path = join(folder, name)
  writeFileSync(path, bytes)
  const tab = newTab()
  return { tab, path, result: await invoke<OpenDocxResult>('docs:open-path', tab, path) }
}

/** What the one dialog shown said. */
function shown(): { type: string; message: string; detail: string } {
  expect(h.messageBox).toHaveBeenCalledTimes(1)
  return h.messageBox.mock.calls[0]!.find(
    (arg) => typeof arg === 'object' && arg !== null && 'detail' in arg,
  ) as { type: string; message: string; detail: string }
}

/** A real protected docx whose header counts one FAT sector more than the file lists. */
function damagedProtected(): Buffer {
  const bytes = fixture('office-agile-password.docx')
  bytes.writeUInt32LE(bytes.readUInt32LE(44) + 1, 44)
  return bytes
}

beforeAll(() => {
  h.root = mkdtempSync(join(tmpdir(), 'docs-open-damaged-root-'))
  folder = mkdtempSync(join(tmpdir(), 'docs-open-damaged-user-'))
  langBefore = getUiLang()
  registerDocsIpc()
})

afterAll(() => {
  setUiLang(langBefore)
  rmSync(h.root, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
})

beforeEach(() => {
  setUiLang('en')
  h.messageBox.mockClear()
})

describe('a .docx whose container the compound-file gate refuses', () => {
  const cases: Array<[string, () => Uint8Array]> = [
    ['a protected document with one header field wrong', damagedProtected],
    [
      'a looping file that carries the EncryptedPackage name',
      () => fatCycleFile('EncryptedPackage'),
    ],
    ['a looping file without that name', () => fatCycleFile('WordDocument')],
  ]

  for (const [what, build] of cases) {
    it(`${what}: is not opened, the person is told it cannot be read, and no password is asked for`, async () => {
      const { result } = await open('damaged.docx', build())
      // neither a document nor the marker the renderer answers with its password prompt
      expect(result).toBeNull()
      const box = shown()
      expect(box.type).toBe('error')
      expect(box.detail.startsWith('damaged.docx: ')).toBe(true)
      expect(box.detail.length).toBeGreaterThan('damaged.docx: '.length)
    })
  }

  it('is told in the language of the interface', async () => {
    setUiLang('ko')
    await open('damaged.docx', damagedProtected())
    expect(shown().detail).toMatch(/[가-힣]/)
  })

  it('is not opened by a password either: a prompt left open gets no document', async () => {
    const path = join(folder, 'swapped.docx')
    writeFileSync(path, damagedProtected())
    const answer = await invoke<DecryptOpenResult>('docs:open-decrypt', newTab(), path, PASSWORD)
    expect(answer.ok).toBe(false)
    // the same refusal, said once
    expect(shown().type).toBe('error')
  })
})

describe('a .docx the gate lets through', () => {
  it('that is password-protected asks for the password, and opens with it', async () => {
    const { tab, path, result } = await open(
      'protected.docx',
      fixture('office-agile-password.docx'),
    )
    expect(result).toEqual({ needsPassword: true, path, name: 'protected.docx' })
    expect(h.messageBox).not.toHaveBeenCalled()

    const wrong = await invoke<DecryptOpenResult>('docs:open-decrypt', tab, path, 'not it')
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong-password' })

    const opened = await invoke<DecryptOpenResult>('docs:open-decrypt', tab, path, PASSWORD)
    expect(opened).toMatchObject({ ok: true, result: { path, encrypted: true } })
    expect(h.messageBox).not.toHaveBeenCalled()
  })

  it('that is a plain document opens', async () => {
    const { path, result } = await open('plain.docx', fixture('office-agile-plain.docx'))
    expect(result).toMatchObject({ path, name: 'plain.docx', encrypted: false })
    expect(h.messageBox).not.toHaveBeenCalled()
  })
})
