// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PRODUCT_NAME } from '@genoffice/i18n'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'

type IpcHandler = (...args: unknown[]) => unknown
const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, IpcHandler>(),
  pick: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    whenReady: () => new Promise<void>(() => {}),
    getPath: (name: string) => join(state.root, name),
    getAppPath: () => state.root,
    getVersion: () => '0.1',
    getName: () => 'GenOffice',
    on: vi.fn(),
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
    static fromWebContents() {
      return null
    }
    static getAllWindows() {
      return []
    }
  },
  WebContentsView: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: vi.fn() },
  dialog: { showSaveDialog: state.pick },
  ipcMain: {
    handle: (name: string, handler: IpcHandler) => state.handlers.set(name, handler),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: {},
  clipboard: {},
  nativeImage: {},
  net: {},
  session: {},
  webContents: {},
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))

// The first import compiles the whole main process, which takes seconds alone and passed a
// hook's time in full runs of the suite. It is compiled once here with room to spare; the
// fresh import each case makes after resetModules only evaluates what is already compiled.
beforeAll(async () => {
  await import('../src/main/docs-main')
}, 120_000)

beforeEach(async () => {
  vi.resetModules()
  state.root = mkdtempSync(join(tmpdir(), 'genoffice-save-as-'))
  for (const dir of ['userData', 'documents', 'picked']) mkdirSync(join(state.root, dir))
  // registerDocsIpc resolves the shipped template fonts under the packaged resources folder
  Object.defineProperty(process, 'resourcesPath', { value: state.root, configurable: true })
  state.handlers.clear()
  state.pick.mockReset()
  const { registerDocsIpc } = await import('../src/main/docs-main')
  registerDocsIpc()
})

afterEach(() => rmSync(state.root, { recursive: true, force: true }))

const blocker = () => join(state.root, 'documents', PRODUCT_NAME)
const selected = () => join(state.root, 'picked', 'saved.docx')
const documentBytes = () => buildDocx({ bodyXml: '<w:p><w:r><w:t>Save fixture</w:t></w:r></w:p>' })

async function saveAs(bytes: Uint8Array, source: string | null = null) {
  const sender = {
    id: 71,
    send: vi.fn(),
    isDestroyed: () => false,
    getOwnerBrowserWindow: () => null,
  }
  // the dialog and the write are two calls here: the pick authorizes the path the write lands in
  const picked = (await state.handlers.get('docs:save-as-pick')!(
    { sender },
    'Draft.docx',
    source,
  )) as { path: string } | null
  if (!picked) return { ok: false }
  return state.handlers.get('docs:save-as')!(
    { sender },
    picked.path,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    source,
  )
}

it('opens Save As despite a real blocking file at the default folder and writes only the chosen file', async () => {
  writeFileSync(blocker(), 'blocking file')
  const bytes = await documentBytes()
  state.pick.mockResolvedValue({ canceled: false, filePath: selected() })
  expect(await saveAs(bytes)).toMatchObject({ ok: true, path: selected() })
  // a blocked Documents folder falls through to the next default (home) instead of a bare name
  expect(state.pick).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: join(state.root, 'home', PRODUCT_NAME, 'Draft.docx') }),
  )
  expect(readFileSync(selected())).toEqual(Buffer.from(bytes))
  expect(readFileSync(blocker(), 'utf8')).toBe('blocking file')
})

it('preserves the opened document location without resolving an unusable default', async () => {
  writeFileSync(blocker(), 'blocking file')
  const bytes = await documentBytes()
  const source = join(state.root, 'picked', 'source.docx')
  writeFileSync(source, bytes)
  state.pick.mockResolvedValue({ canceled: false, filePath: selected() })
  expect(await saveAs(bytes, source)).toMatchObject({ ok: true, path: selected() })
  expect(state.pick).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: join(state.root, 'picked', 'Draft.docx') }),
  )
  expect(readFileSync(source)).toEqual(Buffer.from(bytes))
  expect(readFileSync(selected())).toEqual(Buffer.from(bytes))
})

it('allows cancellation when the default folder is blocked without writing a document', async () => {
  writeFileSync(blocker(), 'blocking file')
  state.pick.mockResolvedValue({ canceled: true, filePath: '' })
  expect(await saveAs(await documentBytes())).toEqual({ ok: false })
  expect(readFileSync(blocker(), 'utf8')).toBe('blocking file')
})

it('continues using a valid configured default as the initial suggestion', async () => {
  const custom = join(state.root, 'custom')
  writeFileSync(
    join(state.root, 'userData', 'app-settings.json'),
    JSON.stringify({ defaultSaveDir: custom }),
  )
  state.pick.mockResolvedValue({ canceled: false, filePath: selected() })
  expect(await saveAs(await documentBytes())).toMatchObject({ ok: true, path: selected() })
  expect(state.pick).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: join(custom, 'Draft.docx') }),
  )
})
