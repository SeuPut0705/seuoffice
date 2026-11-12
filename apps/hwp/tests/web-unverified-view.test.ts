// @vitest-environment jsdom
/**
 * The web page in view mode shows a document and saves nothing. A file the app's own readers
 * refuse still opens there as the engine reads it; the page is told its structure could not
 * be checked, and that no copy can be saved from here, as in edit mode.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installBridges } from '../src/web/bridge'

/** The Hangul-written fixture; `refused` has its header count one FAT sector more than it lists. */
function memo(refused: boolean): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/memo.hwp')))
  if (refused) {
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    view.setUint32(44, view.getUint32(44, true) + 1, true)
  }
  return bytes
}

const docs = {
  '/web/refused/memo.hwp': memo(true),
  '/web/sound/memo.hwp': memo(false),
}

vi.mock('@seuoffice/web-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/web-platform')>()),
  editMode: () => false,
  documentByPath: (path: keyof typeof docs) => ({
    id: 'memo',
    fileName: 'memo.hwp',
    bytes: docs[path],
    virtualPath: path,
  }),
  reportOpened: () => {},
}))

describe('the web page in view mode', () => {
  beforeAll(() => installBridges())

  it('says no copy can be saved from this page', () => {
    expect(window.hwpApi.noSaveAs).toBe(true)
  })

  it('opens a file the gate refuses as it is, and reports it as unverified', async () => {
    const refused = docs['/web/refused/memo.hwp']
    const given = await window.hwpApi.readFile('/web/refused/memo.hwp')
    expect(Buffer.from(given).equals(Buffer.from(refused))).toBe(true)
    expect(await window.hwpApi.structureUnverified()).toBe(true)
  })

  it('does not report a sound file opened after it', async () => {
    await window.hwpApi.readFile('/web/sound/memo.hwp')
    expect(await window.hwpApi.structureUnverified()).toBe(false)
  })
})
