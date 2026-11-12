// @vitest-environment node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => unknown
interface BoxOptions {
  type?: string
  detail?: string
}
const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, IpcHandler>(),
  pick: vi.fn(),
  // every message box is answered with its first button: "Convert and open" for the import question
  box: vi.fn(async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false })),
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
  dialog: { showSaveDialog: state.pick, showMessageBox: state.box },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => state.handlers.set(channel, handler),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: {},
  clipboard: {},
  nativeImage: {},
  net: {},
  session: {},
  webContents: { fromId: () => null },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))

// Compiled once with room to spare; see save-as-default-dir.test.ts.
beforeAll(async () => {
  await import('../src/main/docs-main')
}, 120_000)

beforeEach(async () => {
  vi.resetModules()
  state.root = mkdtempSync(join(tmpdir(), 'genoffice-doc-import-'))
  for (const dir of ['userData', 'documents', 'work']) mkdirSync(join(state.root, dir))
  // registerDocsIpc resolves the shipped template fonts under the packaged resources folder
  Object.defineProperty(process, 'resourcesPath', { value: state.root, configurable: true })
  state.handlers.clear()
  state.pick.mockReset()
  state.box.mockClear()
  copyFileSync(
    join(__dirname, '../../../packages/doc2docx/tests/fixtures/text-basic.doc'),
    source(),
  )
  const { registerDocsIpc } = await import('../src/main/docs-main')
  registerDocsIpc()
})

afterEach(() => rmSync(state.root, { recursive: true, force: true }))

const work = (name: string) => join(state.root, 'work', name)
const source = () => work('report.doc')
const sourceBytes = () =>
  readFileSync(join(__dirname, '../../../packages/doc2docx/tests/fixtures/text-basic.doc'))
const isZip = (path: string) => readFileSync(path).subarray(0, 2).toString('latin1') === 'PK'
const picks = (...paths: string[]) => {
  for (const filePath of paths) state.pick.mockResolvedValueOnce({ canceled: false, filePath })
  // a dialog asked once more than the case expects is cancelled, never answered again
  state.pick.mockResolvedValue({ canceled: true, filePath: '' })
}
const errorBoxes = () =>
  state.box.mock.calls
    .map((call) => call[call.length - 1] as BoxOptions)
    .filter((options) => options.type === 'error')

async function openLegacy() {
  const sender = {
    id: 72,
    send: vi.fn(),
    isDestroyed: () => false,
    getOwnerBrowserWindow: () => null,
  }
  return (await state.handlers.get('docs:open-path')!({ sender }, source())) as {
    path: string
    name: string
  } | null
}

it('converts into the picked .docx and opens that copy', async () => {
  picks(work('converted.docx'))
  expect(await openLegacy()).toMatchObject({
    path: work('converted.docx'),
    name: 'converted.docx',
  })
  expect(isZip(work('converted.docx'))).toBe(true)
  expect(readFileSync(source())).toEqual(sourceBytes())
  expect(errorBoxes()).toEqual([])
})

it('refuses the original as the destination, says so and asks for another name', async () => {
  picks(source())
  expect(await openLegacy()).toBeNull()
  expect(readFileSync(source())).toEqual(sourceBytes())
  expect(errorBoxes()).toHaveLength(1)
  expect(state.pick).toHaveBeenCalledTimes(2)
  expect(readdirSync(work(''))).toEqual(['report.doc'])
})

it('refuses the original under another spelling of its name', async () => {
  picks(work('REPORT.DOC'), work('converted.docx'))
  expect(await openLegacy()).toMatchObject({ path: work('converted.docx') })
  expect(errorBoxes()).toHaveLength(1)
  // no file named .doc holds the converted bytes, on a disk that folds case or one that does not
  for (const name of readdirSync(work(''))) {
    if (/\.doc$/i.test(name)) expect(readFileSync(work(name))).toEqual(sourceBytes())
  }
})

it.skipIf(process.platform === 'win32')(
  'refuses a .docx name that is a link to the original',
  async () => {
    symlinkSync(source(), work('alias.docx'))
    picks(work('alias.docx'))
    expect(await openLegacy()).toBeNull()
    expect(errorBoxes()).toHaveLength(1)
    expect(lstatSync(work('alias.docx')).isSymbolicLink()).toBe(true)
    expect(readFileSync(source())).toEqual(sourceBytes())
  },
)

it('writes a name typed with another extension as a .docx beside it', async () => {
  picks(work('draft.doc'))
  expect(await openLegacy()).toMatchObject({
    path: work('draft.doc.docx'),
    name: 'draft.doc.docx',
  })
  expect(existsSync(work('draft.doc'))).toBe(false)
  expect(isZip(work('draft.doc.docx'))).toBe(true)
  expect(readFileSync(source())).toEqual(sourceBytes())
})

it('asks again before the added .docx would replace a file nobody confirmed', async () => {
  writeFileSync(work('draft.doc.docx'), 'someone else')
  picks(work('draft.doc'))
  expect(await openLegacy()).toBeNull()
  expect(readFileSync(work('draft.doc.docx'), 'utf8')).toBe('someone else')
  expect(existsSync(work('draft.doc'))).toBe(false)
  // the second dialog offers the completed name, so replacing it is the user's own answer
  expect(state.pick).toHaveBeenCalledTimes(2)
  expect(state.pick.mock.calls[1].at(-1)).toMatchObject({ defaultPath: work('draft.doc.docx') })
})

it('replaces an existing .docx once the dialog returned that very name', async () => {
  writeFileSync(work('draft.doc.docx'), 'someone else')
  picks(work('draft.doc'), work('draft.doc.docx'))
  expect(await openLegacy()).toMatchObject({ path: work('draft.doc.docx') })
  expect(isZip(work('draft.doc.docx'))).toBe(true)
})
