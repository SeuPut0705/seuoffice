// @vitest-environment jsdom
/**
 * The web page in edit mode has one save target, the opened file itself: no Save As, no
 * export. A file the app's own readers refuse is opened as the engine reads it, the page is
 * told so and told that no copy can be made here, and no save reaches the host under either
 * save command or at the host's own request.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installBridges } from '../src/web/bridge'

/** The Hangul-written fixture with its header counting one FAT sector more than it lists. */
function gateRefused(): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures/memo.hwp')))
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  view.setUint32(44, view.getUint32(44, true) + 1, true)
  return bytes
}

const refused = gateRefused()
const doc = { id: 'memo', fileName: 'memo.hwp', bytes: refused, virtualPath: '/web/memo/memo.hwp' }

const host = vi.hoisted(() => ({
  saveRequest: undefined as (() => Promise<void>) | undefined,
  saveToHost: vi.fn<(fileName: string, bytes: Uint8Array) => Promise<void>>(),
}))

vi.mock('@seuoffice/web-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/web-platform')>()),
  editMode: () => true,
  documentByPath: () => doc,
  waitForDocument: async () => doc,
  reportOpened: () => {},
  reportDirty: () => {},
  saveToHost: host.saveToHost,
  onHostSaveRequest: (handler: () => Promise<void>) => (host.saveRequest = handler),
}))

describe('a file the compound-file gate refuses, on the web page', () => {
  let given: Uint8Array

  beforeAll(async () => {
    installBridges()
    given = await window.hwpApi.readFile(doc.virtualPath)
  })

  it('opens as it is and is reported as unverified', async () => {
    expect(Buffer.from(given).equals(Buffer.from(refused))).toBe(true)
    expect(await window.hwpApi.structureUnverified()).toBe(true)
  })

  it('is not saved: the save is refused with the reason and nothing goes to the host', async () => {
    expect(await window.hwpApi.beginSave('save')).toMatchObject({ ok: false, reason: 'unverified' })
    // no save began, so bytes sent afterwards are not stored either
    expect((await window.hwpApi.commitSave(refused, [])).ok).toBe(false)
    expect(host.saveToHost).not.toHaveBeenCalled()
  })

  it('is told no copy can be saved from this page, so its notices do not name Save As', () => {
    expect(window.hwpApi.noSaveAs).toBe(true)
  })

  it('is not saved by Save As either: on this page it writes the opened name', async () => {
    expect(await window.hwpApi.beginSave('saveAs')).toMatchObject({
      ok: false,
      reason: 'unverified',
    })
    expect((await window.hwpApi.commitSave(refused, [])).ok).toBe(false)
    expect(host.saveToHost).not.toHaveBeenCalled()
  })

  it('refuses a save the host asks for, with the reason, and stores nothing', async () => {
    // the renderer's save (save-flow.ts): begin, and commit only what began
    window.hwpApi.onSaveRequest(async (mode) => {
      const begin = await window.hwpApi.beginSave(mode)
      if (begin.ok && 'format' in begin) await window.hwpApi.commitSave(refused, [])
    })
    await expect(host.saveRequest!()).rejects.toThrow(/structure .* could not be checked/)
    expect(host.saveToHost).not.toHaveBeenCalled()
  })
})
