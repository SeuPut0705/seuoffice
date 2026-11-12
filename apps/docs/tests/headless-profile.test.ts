// @vitest-environment node
/**
 * A `--headless-export` run converts one file and goes: the file is not a
 * document the user opened. What the hidden window asks of the main process
 * while it opens the document (the open itself, its AI panel's chat, the AI
 * settings) must leave the user's profile as it was: no project membership,
 * no chat mapping, no recent entry, no archived copy of the document, no
 * settings rewrite. The same requests from a tab do leave their records.
 * Real stores over a temporary app data folder; Electron is a fake.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>(),
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
// this workspace's test aliases do not reach the rest of these packages, and
// the handlers under test use none of them
vi.mock('@seuoffice/ai-search', async () => ({
  ...(await import('../../../packages/ai-search/src/media-call-abort')),
  documentMediaRoots: () => [],
  createCodexImageCliGenerator: () => async () => ({ bytes: new Uint8Array(), mime: 'image/png' }),
  registerCodexImageGenerator: () => {},
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

import { setHeadlessMode } from '@seuoffice/electron-utils'
import { buildBlankDocx } from '@seuoffice/docx-engine'
import { registerAiIpc, registerDocsIpc, registerProjectIpc } from '../src/main/docs-main'

let nextTabId = 100
let userFolder: string

const newTab = () => ({
  id: nextTabId++,
  isDestroyed: () => false,
  isCrashed: () => false,
  send: vi.fn(),
})

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: newTab() }, ...args)) as Promise<T>
}

/** every file of the profile with its bytes, so "untouched" is one comparison */
function profile(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[relative(h.root, full)] = readFileSync(full).toString('base64')
    }
  }
  walk(h.root)
  return out
}

async function newDocument(name: string): Promise<string> {
  const path = join(userFolder, name)
  writeFileSync(path, await buildBlankDocx({}))
  return path
}

/** what a document's window asks for while it opens: the file, its chat, the AI settings */
async function openAsItsWindowDoes(path: string) {
  const tab = newTab()
  const opened = await Promise.resolve(h.handlers.get('docs:open-path')!({ sender: tab }, path))
  const chat = await invoke<{ projectId: string; chatId: string }>('project:resolveChat', {
    filePath: path,
  })
  await invoke('ai:get-settings')
  return { opened: opened as { path?: string } | null, chat }
}

const recents = (): string[] =>
  existsSync(join(h.root, 'recent.json'))
    ? (JSON.parse(readFileSync(join(h.root, 'recent.json'), 'utf8')) as string[])
    : []

beforeAll(() => {
  h.root = mkdtempSync(join(tmpdir(), 'docs-headless-profile-root-'))
  userFolder = mkdtempSync(join(tmpdir(), 'docs-headless-profile-user-'))
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')))
  registerAiIpc()
  registerProjectIpc()
  registerDocsIpc()
})

afterEach(() => setHeadlessMode(false))

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(h.root, { recursive: true, force: true })
  rmSync(userFolder, { recursive: true, force: true })
})

describe('the profile across a headless export', () => {
  it('stays empty when the run is the first thing this profile sees', async () => {
    const path = await newDocument('first.docx')
    setHeadlessMode(true)

    const { opened, chat } = await openAsItsWindowDoes(path)

    expect(opened?.path).toBe(path)
    expect(chat.projectId).toBe('default')
    expect(profile()).toEqual({})
  })

  it('keeps the records of a document opened in a tab', async () => {
    const path = await newDocument('in-a-tab.docx')

    const { chat } = await openAsItsWindowDoes(path)

    expect(recents()).toEqual([path])
    const index = JSON.parse(readFileSync(join(h.root, 'projects', 'index.json'), 'utf8')) as {
      fileMap: Record<string, string>
      chatIdByPath: Record<string, string>
    }
    expect(Object.values(index.fileMap)).toEqual(['default'])
    expect(Object.values(index.chatIdByPath)).toEqual([chat.chatId])
  })

  it('is byte for byte what it was, also for a settings file that waits for a migration', async () => {
    const known = join(userFolder, 'in-a-tab.docx')
    const fromTab = await invoke<{ chatId: string }>('project:resolveChat', { filePath: known })
    const path = await newDocument('converted.docx')
    // written before the subscription notice carried a version: the next read migrates it
    writeFileSync(
      join(h.root, 'ai-settings.json'),
      JSON.stringify({ subscriptionNoticeSeen: true }),
    )
    const before = profile()
    setHeadlessMode(true)

    const { opened } = await openAsItsWindowDoes(path)
    // a document the user does have open elsewhere reads as the same chat
    const again = await openAsItsWindowDoes(known)

    expect(opened?.path).toBe(path)
    expect(again.chat.chatId).toBe(fromTab.chatId)
    expect(profile()).toEqual(before)
    expect(recents()).toEqual([known])
  })
})
